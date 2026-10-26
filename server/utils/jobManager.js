const crypto = require('crypto');
const { currentTenant } = require('../context');

class JobManager {
  constructor() {
    this.jobs = new Map(); // Store active jobs
    this.jobHistory = new Map(); // Store completed jobs (last 100)
    this.maxHistory = 100;
  }

  // Create a new background job
  createJob(type, data, userId = 'anonymous') {
    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      type,
      status: 'pending', // pending, running, completed, failed
      data,
      userId,
      tenantId: currentTenant().id,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      progress: {
        total: 0,
        completed: 0,
        failed: 0
      },
      result: null,
      error: null
    };

    this.jobs.set(jobId, job);
    console.log('🔧 [DEBUG] Created job:', jobId, 'type:', type);
    
    // Start the job immediately
    this.startJob(jobId);
    
    return jobId;
  }

  // Start executing a job
  async startJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      console.error('❌ [DEBUG] Job not found:', jobId);
      return;
    }

    job.status = 'running';
    job.startedAt = new Date();
    
    console.log('🔧 [DEBUG] Starting job:', jobId, 'type:', job.type);

    try {
      if (job.type === 'google-photos-import') {
        await this.executeGooglePhotosImport(job);
      } else {
        throw new Error(`Unknown job type: ${job.type}`);
      }
    } catch (error) {
      console.error('❌ [DEBUG] Job failed:', jobId, error);
      job.status = 'failed';
      job.error = error.message;
      job.completedAt = new Date();
    }

    // Move completed job to history
    if (job.status === 'completed' || job.status === 'failed') {
      this.moveToHistory(jobId);
    }
  }

  // Execute Google Photos import job
  async executeGooglePhotosImport(job) {
    const { mediaItems, destinationPath, accessToken } = job.data;
    const { getLibrary } = require('../library');
    const { assertCanAdd } = require('../services/quotaService');

    console.log('🔧 [DEBUG] Executing Google Photos import job:', job.id);
    console.log('🔧 [DEBUG] Importing', mediaItems.length, 'photos to', destinationPath);

    // Set up progress tracking
    job.progress.total = mediaItems.length;

    // Ensure destination folder exists (the library refuses paths outside uploads/)
    await getLibrary().createFolder(destinationPath);
    let quotaReached = false;

    const importResults = [];

    for (let i = 0; i < mediaItems.length; i++) {
      const item = mediaItems[i];
      
      if (quotaReached) {
        job.progress.failed++;
        importResults.push({ id: item.id, success: false, error: 'Storage limit reached' });
        continue;
      }

      try {
        console.log('🔧 [DEBUG] Processing item', i + 1, 'of', mediaItems.length, ':', item.id);

        // Get download URL
        let downloadUrl = '';
        if (item.baseUrl) {
          downloadUrl = `${item.baseUrl}=d`;
        } else if (item.mediaFile && item.mediaFile.baseUrl) {
          downloadUrl = `${item.mediaFile.baseUrl}=d`;
        } else if (item.mediaFile && item.mediaFile.url) {
          downloadUrl = item.mediaFile.url;
        } else {
          console.warn('⚠️ [DEBUG] No download URL available for item:', item.id);
          job.progress.failed++;
          importResults.push({
            id: item.id,
            success: false,
            error: 'No download URL available'
          });
          continue;
        }

        // Fetch the image with authentication
        const response = await fetch(downloadUrl, {
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        });

        if (!response.ok) {
          console.error('❌ [DEBUG] Failed to download image:', response.status, response.statusText);
          job.progress.failed++;
          importResults.push({
            id: item.id,
            success: false,
            error: `HTTP ${response.status}: ${response.statusText}`
          });
          continue;
        }

        // Get filename from mediaFile or generate one
        let filename;
        if (item.mediaFile && item.mediaFile.filename) {
          filename = item.mediaFile.filename;
        } else if (item.filename) {
          filename = item.filename;
        } else {
          // Generate filename with timestamp to avoid conflicts
          const ext = response.headers.get('content-type')?.includes('jpeg') ? 'jpg' : 'png';
          filename = `google-photo-${Date.now()}-${i}.${ext}`;
        }

        // Ensure filename is safe
        filename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');

        // Save the file
        const imageBuffer = Buffer.from(await response.arrayBuffer());
        await assertCanAdd(imageBuffer.length);
        const added = await getLibrary().addPhoto(destinationPath, {
          buffer: imageBuffer,
          originalName: filename,
          contentType: response.headers.get('content-type')
        });

        console.log('✅ [DEBUG] Successfully imported:', filename);
        job.progress.completed++;
        importResults.push({
          id: item.id,
          success: true,
          filename: filename,
          path: added.path
        });

      } catch (error) {
        console.error('❌ [DEBUG] Error importing photo:', item.id, error);
        if (error.code === 'QUOTA_EXCEEDED') quotaReached = true;
        job.progress.failed++;
        importResults.push({
          id: item.id,
          success: false,
          error: error.message
        });
      }

      // Small delay to prevent overwhelming the server
      if (i < mediaItems.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // Job completed successfully
    job.status = 'completed';
    job.completedAt = new Date();
    job.result = {
      successCount: job.progress.completed,
      failCount: job.progress.failed,
      results: importResults,
      destinationPath
    };

    console.log('🔧 [DEBUG] Import job completed:', job.id);
    console.log('🔧 [DEBUG] Results:', job.progress.completed, 'success,', job.progress.failed, 'failed');
  }

  // Get job status
  getJob(jobId) {
    return this.jobs.get(jobId) || this.jobHistory.get(jobId);
  }

  // Get job status (public info only)
  getJobStatus(jobId) {
    const job = this.getJob(jobId);
    // Another tenant's job looks the same as no job
    if (!job || job.tenantId !== currentTenant().id) {
      return null;
    }

    return {
      id: job.id,
      type: job.type,
      status: job.status,
      progress: job.progress,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error,
      result: job.result
    };
  }

  // Move completed job to history
  moveToHistory(jobId) {
    const job = this.jobs.get(jobId);
    if (job) {
      this.jobs.delete(jobId);
      this.jobHistory.set(jobId, job);

      // Keep only last 100 jobs in history
      if (this.jobHistory.size > this.maxHistory) {
        const firstKey = this.jobHistory.keys().next().value;
        this.jobHistory.delete(firstKey);
      }
    }
  }

  // Get all user jobs
  getUserJobs(userId = 'anonymous') {
    const userJobs = [];
    
    // Active jobs
    for (const job of this.jobs.values()) {
      if (job.userId === userId) {
        userJobs.push(this.getJobStatus(job.id));
      }
    }
    
    // Recent history
    for (const job of this.jobHistory.values()) {
      if (job.userId === userId) {
        userJobs.push(this.getJobStatus(job.id));
      }
    }
    
    return userJobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
}

// Export singleton instance
module.exports = new JobManager();