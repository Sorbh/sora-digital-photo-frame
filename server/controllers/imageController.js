const path = require('path');
const { UPLOADS_DIR } = require('../config/paths');
const fs = require('fs-extra');
const sharp = require('sharp');
const thumbnails = require('../services/thumbnailService');
const snaps = require('../services/snapService');
const { resolveAdminPath, toAdminPath } = require('../utils/safePath');

class ImageController {
  constructor() {
    this.uploadsDir = UPLOADS_DIR;
    // Track recently shown images to prevent repeats
    this.recentlyShown = new Set();
    this.maxRecentCount = parseInt(process.env.MAX_RECENT_IMAGES) || 10; // Number of recent images to avoid
    this.imageCache = null;
    this.cacheTimestamp = null;
    this.cacheExpiry = parseInt(process.env.IMAGE_CACHE_EXPIRY) || 60000; // Cache for 1 minute
  }

  // Get all images recursively with caching
  async getAllImages(dir = this.uploadsDir, useCache = true) {
    // Check if cache is valid
    if (useCache && this.imageCache && this.cacheTimestamp && 
        (Date.now() - this.cacheTimestamp) < this.cacheExpiry) {
      return this.imageCache;
    }

    const images = [];
    const items = await fs.readdir(dir, { withFileTypes: true });
    
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (item.name.startsWith('.')) continue;
        const subImages = await this.getAllImages(fullPath, false); // Don't use cache for recursion
        images.push(...subImages);
      } else if (item.isFile() && (thumbnails.IMAGE_PATTERN.test(item.name) || snaps.isSnap(item.name))) {
        const imageData = {
          type: snaps.isSnap(item.name) ? 'snap' : 'image',
          path: fullPath,
          relativePath: path.relative(this.uploadsDir, fullPath),
          folder: path.basename(path.dirname(fullPath)),
          id: path.relative(this.uploadsDir, fullPath) // Use relative path as unique ID
        };
        images.push(imageData);
      }
    }
    
    // Update cache only for root call
    if (useCache) {
      this.imageCache = images;
      this.cacheTimestamp = Date.now();
    }
    
    return images;
  }

  // Get random image endpoint with anti-repeat logic and folder filtering
  async getRandomImage(req, res) {
    try {
      const folderFilter = req.query.folder;
      const allImages = await this.getAllImages();
      
      if (allImages.length === 0) {
        return res.status(404).json({ 
          success: false,
          error: 'No images found',
          code: 'NO_IMAGES_FOUND'
        });
      }
      
      let availableImages = allImages;
      
      // Apply access account folder restrictions if user is PIN authenticated (not admin)
      if (req.session && req.session.accessAccount && req.session.accessAccount.assignedFolders && req.session.accessAccount.assignedFolders.length > 0 && !req.session.authenticated) {
        const assignedFolders = req.session.accessAccount.assignedFolders;

        availableImages = allImages.filter(img => {
          const imgFolder = path.dirname(img.relativePath);
          // Allowed if the image is in an assigned folder or one of its subfolders
          return assignedFolders.some(allowedFolder =>
            imgFolder === allowedFolder || imgFolder.startsWith(allowedFolder + path.sep));
        });

        if (availableImages.length === 0) {
          console.log('❌ Access Control - No accessible images found for assigned folders:', assignedFolders);
          return res.status(403).json({ 
            success: false,
            error: 'No images accessible with your account permissions',
            code: 'ACCESS_RESTRICTED'
          });
        }
      }
      
      // Apply folder filter if specified
      if (folderFilter) {
        const decodedFolder = decodeURIComponent(folderFilter);

        availableImages = availableImages.filter(img => {
          const imgFolder = path.dirname(img.relativePath);
          return imgFolder === decodedFolder || imgFolder.startsWith(decodedFolder + path.sep);
        });

        if (availableImages.length === 0) {
          console.log('❌ API Filter - No images found in folder:', decodedFolder);
          return res.status(404).json({ 
            success: false,
            error: `No images found in folder: ${decodedFolder}`,
            code: 'FOLDER_EMPTY'
          });
        }
      }
      
      // If we have enough images, filter out recently shown ones
      if (availableImages.length > this.maxRecentCount) {
        const filteredByRecent = availableImages.filter(img => !this.recentlyShown.has(img.id));
        
        // If all images have been shown recently, reset the recently shown list
        if (filteredByRecent.length === 0) {
          console.log('All images in folder shown recently, resetting recent list');
          this.recentlyShown.clear();
          // Keep availableImages as is (with folder filter applied)
        } else {
          availableImages = filteredByRecent;
        }
      }
      
      // Select random image from available pool
      const randomIndex = Math.floor(Math.random() * availableImages.length);
      const randomImage = availableImages[randomIndex];
      
      // Add to recently shown list
      this.recentlyShown.add(randomImage.id);
      
      // Limit the size of recently shown set
      if (this.recentlyShown.size > this.maxRecentCount) {
        // Convert to array, remove oldest entries, convert back to Set
        const recentArray = Array.from(this.recentlyShown);
        this.recentlyShown = new Set(recentArray.slice(-this.maxRecentCount));
      }
      
      // A snap is drawn by the frame itself, from its page data
      if (randomImage.type === 'snap') {
        const snap = await snaps.forFrame(randomImage.path, req.session);
        return res.json({
          success: true,
          image: {
            id: randomImage.id,
            type: 'snap',
            filename: snap.title || path.basename(randomImage.path),
            folder: path.dirname(randomImage.relativePath),
            snap
          }
        });
      }

      const relativePath = `/uploads/${randomImage.relativePath}`;
      const fullUrl = `${req.protocol}://${req.get('host')}${relativePath}`;
      
      res.json({
        success: true,
        image: {
          id: randomImage.id,
          type: 'image',
          filename: path.basename(randomImage.path),
          path: relativePath,
          folder: path.dirname(randomImage.relativePath),
          url: fullUrl,
          thumbnail: `${req.protocol}://${req.get('host')}/api/images/${encodeURIComponent(randomImage.id)}/thumbnail`,
          metadata: {
            size: null, // Would need fs.stat to get actual size
            dimensions: {
              width: null,
              height: null
            },
            createdAt: null
          }
        }
      });
    } catch (error) {
      console.error('Error getting random image:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }

  // Get image thumbnail (generated once, then served from the disk cache)
  async getImageThumbnail(req, res) {
    try {
      // Express already decoded the param; a second decode would mangle names containing '%'
      const imagePath = thumbnails.resolveInUploads(req.params.imageId);

      if (!imagePath || !thumbnails.IMAGE_PATTERN.test(imagePath) || !await fs.pathExists(imagePath)) {
        return res.status(404).json({
          success: false,
          error: 'Image not found',
          code: 'IMAGE_NOT_FOUND'
        });
      }

      thumbnails.send(res, await thumbnails.getThumbnail(imagePath), { versioned: Boolean(req.query.v) });
    } catch (error) {
      console.error('Error generating image thumbnail:', error);
      res.status(500).json({
        success: false,
        error: 'Server error',
        code: 'SERVER_ERROR'
      });
    }
  }

  // Clear image cache to force refresh
  clearImageCache() {
    this.imageCache = null;
    this.cacheTimestamp = null;
    console.log('Image cache cleared');
  }

  // Upload images
  async uploadImages(req, res) {
    try {
      const uploadedFiles = req.files;
      const targetDir = resolveAdminPath(req.body.path || 'uploads', { allowRoot: true });
      const processedFiles = [];

      if (!targetDir) {
        await Promise.all(uploadedFiles.map(file => fs.remove(file.path)));
        return res.status(400).json({ message: 'Invalid upload folder' });
      }

      for (const file of uploadedFiles) {
        // If the target path is different from where multer uploaded it, move the file
        const targetFilePath = path.join(targetDir, file.filename);
        
        // Ensure target directory exists
        await fs.ensureDir(targetDir);
        
        // Process image with Sharp for optimization
        const processedPath = path.join(path.dirname(file.path), `processed_${file.filename}`);
        
        await sharp(file.path)
          .rotate() // Auto-rotate based on EXIF orientation
          .resize(
            parseInt(process.env.MAX_RESOLUTION_WIDTH) || 1920, 
            parseInt(process.env.MAX_RESOLUTION_HEIGHT) || 1080, 
            { fit: 'inside', withoutEnlargement: true }
          )
          .jpeg({ quality: parseInt(process.env.IMAGE_QUALITY) || 85 })
          .toFile(processedPath);
        
        // Remove original and move processed to target location
        await fs.remove(file.path);
        await fs.move(processedPath, targetFilePath);
        
        processedFiles.push({
          filename: file.filename,
          originalname: file.originalname,
          path: toAdminPath(targetFilePath),
          size: file.size
        });
      }
      
      // Clear cache after upload to include new images
      this.clearImageCache();
      
      res.json({
        message: 'Images uploaded successfully',
        files: processedFiles
      });
    } catch (error) {
      console.error('Error uploading images:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }

  // Delete image
  async deleteImage(req, res) {
    try {
      const fullPath = resolveAdminPath(req.query.path);

      if (!fullPath || !await fs.pathExists(fullPath)) {
        return res.status(404).json({ message: 'Image not found' });
      }

      await fs.remove(fullPath);
      await thumbnails.remove(fullPath);
      
      // Clear cache after deletion to update available images
      this.clearImageCache();
      
      res.json({ message: 'Image deleted successfully' });
    } catch (error) {
      console.error('Error deleting image:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }

  // Move images into another folder (drag a photo onto a folder in the admin grid)
  async moveImages(req, res) {
    try {
      const { paths, destination } = req.body;

      if (!Array.isArray(paths) || paths.length === 0) {
        return res.status(400).json({ message: 'Invalid paths provided' });
      }

      const destDir = resolveAdminPath(destination || 'uploads', { allowRoot: true });
      if (!destDir || !(await fs.stat(destDir).catch(() => null))?.isDirectory()) {
        return res.status(404).json({ message: 'Destination folder not found' });
      }

      const results = { movedCount: 0, failedCount: 0, errors: [] };

      for (const imagePath of paths) {
        const fullPath = resolveAdminPath(imagePath);

        const isSnap = Boolean(fullPath) && snaps.isSnap(fullPath);
        if (!fullPath || !(isSnap || thumbnails.IMAGE_PATTERN.test(fullPath)) || !await fs.pathExists(fullPath)) {
          results.failedCount++;
          results.errors.push(`Image not found: ${imagePath}`);
          continue;
        }
        if (path.dirname(fullPath) === destDir) continue; // already there

        try {
          // Never overwrite a photo that already has this name in the destination
          const ext = isSnap ? snaps.SNAP_EXT : path.extname(fullPath);
          const base = path.basename(fullPath, ext);
          let target = path.join(destDir, base + ext);
          for (let n = 1; await fs.pathExists(target); n++) {
            target = path.join(destDir, `${base}-${n}${ext}`);
          }

          await fs.move(fullPath, target);
          await thumbnails.remove(fullPath);
          if (!isSnap) {
            await snaps.photoMoved(path.relative(this.uploadsDir, fullPath), path.relative(this.uploadsDir, target));
          }
          results.movedCount++;
        } catch (error) {
          console.error(`Error moving image ${imagePath}:`, error);
          results.failedCount++;
          results.errors.push(`Failed to move: ${imagePath}`);
        }
      }

      this.clearImageCache();

      res.status(results.failedCount > 0 ? 207 : 200).json({
        message: `Moved ${results.movedCount} image(s)`,
        ...results
      });
    } catch (error) {
      console.error('Error moving images:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }

  // Batch delete images
  async batchDeleteImages(req, res) {
    try {
      const { paths } = req.body;
      
      if (!Array.isArray(paths) || paths.length === 0) {
        return res.status(400).json({ message: 'Invalid paths provided' });
      }
      
      const results = {
        deletedCount: 0,
        failedCount: 0,
        errors: []
      };
      
      for (const imagePath of paths) {
        try {
          const fullPath = resolveAdminPath(imagePath);

          if (fullPath && await fs.pathExists(fullPath)) {
            await fs.remove(fullPath);
            await thumbnails.remove(fullPath);
            results.deletedCount++;
          } else {
            results.failedCount++;
            results.errors.push(`Image not found: ${imagePath}`);
          }
        } catch (error) {
          console.error(`Error deleting image ${imagePath}:`, error);
          results.failedCount++;
          results.errors.push(`Failed to delete: ${imagePath}`);
        }
      }
      
      // Clear cache after deletion to update available images
      this.clearImageCache();
      
      if (results.failedCount > 0) {
        res.status(207).json({
          message: `Deleted ${results.deletedCount} images, failed to delete ${results.failedCount}`,
          ...results
        });
      } else {
        res.json({
          message: `Successfully deleted ${results.deletedCount} images`,
          ...results
        });
      }
    } catch (error) {
      console.error('Error in batch delete:', error);
      res.status(500).json({ message: 'Server error during batch deletion' });
    }
  }

  // Rotate image
  async rotateImage(req, res) {
    try {
      const { path: imagePath, angle = 90 } = req.body;
      const fullPath = resolveAdminPath(imagePath);

      if (!fullPath || !await fs.pathExists(fullPath)) {
        return res.status(404).json({ message: 'Image not found' });
      }
      
      // Validate angle (should be multiple of 90)
      if (angle % 90 !== 0) {
        return res.status(400).json({ message: 'Angle must be a multiple of 90 degrees' });
      }
      
      // Create a temporary file for the rotated image
      const tempPath = path.join(path.dirname(fullPath), `rotated_temp_${Date.now()}_${path.basename(fullPath)}`);
      
      // Rotate image by specified angle
      await sharp(fullPath)
        .rotate(angle)
        .jpeg({ quality: parseInt(process.env.IMAGE_QUALITY) || 85 })
        .toFile(tempPath);
      
      // Replace original with rotated image
      await fs.remove(fullPath);
      await fs.move(tempPath, fullPath);
      
      // Clear cache after rotation to update available images
      this.clearImageCache();
      
      const direction = angle > 0 ? 'clockwise' : 'counter-clockwise';
      res.json({ message: `Image rotated ${Math.abs(angle)}° ${direction} successfully` });
    } catch (error) {
      console.error('Error rotating image:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
}

module.exports = new ImageController();