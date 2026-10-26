const path = require('path');
const { UPLOADS_DIR } = require('../config/paths');
const { getLibrary } = require('../library');
const { currentTenant } = require('../context');
const { assertCanAdd } = require('../services/quotaService');
const sharp = require('sharp');
const thumbnails = require('../services/thumbnailService');
const snaps = require('../services/snapService');
const playOrder = require('../services/playOrderService');
const photoInfo = require('../services/photoInfoService');
const { resolveAdminPath, toAdminPath } = require('../utils/safePath');
const { passClientError } = require('../utils/httpError');

class ImageController {
  constructor() {
    this.uploadsDir = UPLOADS_DIR;
    // Track recently shown images to prevent repeats
    // Per-tenant state (recently shown, image list cache); see the accessors below
    this.states = new Map();
    this.maxRecentCount = parseInt(process.env.MAX_RECENT_IMAGES) || 10; // Number of recent images to avoid
    this.cacheExpiry = parseInt(process.env.IMAGE_CACHE_EXPIRY) || 60000; // Cache for 1 minute
  }

  // Each tenant gets its own anti-repeat history and image list cache
  state() {
    const { id } = currentTenant();
    if (!this.states.has(id)) {
      this.states.set(id, { recentlyShown: new Set(), imageCache: null, cacheTimestamp: null });
    }
    return this.states.get(id);
  }

  get recentlyShown() { return this.state().recentlyShown; }
  set recentlyShown(value) { this.state().recentlyShown = value; }
  get imageCache() { return this.state().imageCache; }
  set imageCache(value) { this.state().imageCache = value; }
  get cacheTimestamp() { return this.state().cacheTimestamp; }
  set cacheTimestamp(value) { this.state().cacheTimestamp = value; }

  // Get all images recursively with caching
  async getAllImages(useCache = true) {
    // Check if cache is valid
    if (useCache && this.imageCache && this.cacheTimestamp && 
        (Date.now() - this.cacheTimestamp) < this.cacheExpiry) {
      return this.imageCache;
    }

    const photos = await getLibrary().allPhotos();
    const images = photos.map(photo => {
      const fullPath = resolveAdminPath(photo.path);
      const relativePath = path.relative(this.uploadsDir, fullPath);
      return {
        type: photo.type,
        path: fullPath,
        relativePath,
        folder: path.basename(path.dirname(fullPath)),
        id: relativePath
      };
    });
    
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
      
      // The folder being played decides the order: shuffle, by date, or the
      // order set in the library. Ordered play is stateless: the frame sends
      // the last photo it showed (?after=) and gets the one after it.
      const baseDir = folderFilter ? resolveAdminPath(path.join('uploads', decodeURIComponent(folderFilter))) : this.uploadsDir;
      const { order } = baseDir ? await playOrder.read(baseDir) : { order: 'shuffle' };
      const randomImage = order === 'shuffle'
        ? this.pickShuffled(availableImages)
        : this.pickNext(await playOrder.sort(baseDir, availableImages, order), req.query.after);

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
            order,
            snap
          }
        });
      }

      const relativePath = getLibrary().photoUrl(toAdminPath(randomImage.path));
      const info = await this.describe(randomImage);
      const fullUrl = `${req.protocol}://${req.get('host')}${relativePath}`;
      // Remote encrypted storage: the frame may fetch the stored bytes and decrypt them itself
      const rawUrl = getLibrary().rawUrl?.(toAdminPath(randomImage.path)) || null;
      
      res.json({
        success: true,
        image: {
          id: randomImage.id,
          type: 'image',
          filename: path.basename(randomImage.path),
          path: relativePath,
          folder: path.dirname(randomImage.relativePath),
          url: fullUrl,
          ...(rawUrl && { rawUrl, mimeType: `image/${this.formatFor(randomImage.path)}` }),
          thumbnail: `${req.protocol}://${req.get('host')}/api/images/${encodeURIComponent(randomImage.id)}/thumbnail`,
          order,
          info,
          metadata: {
            size: null,
            dimensions: {
              width: null,
              height: null
            },
            createdAt: null
          }
        }
      });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error getting random image:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }

  // Random, never repeating the last few photos (until the folder runs out)
  pickShuffled(images) {
    let pool = images;
    if (images.length > this.maxRecentCount) {
      pool = images.filter(img => !this.recentlyShown.has(img.id));
      if (pool.length === 0) {
        this.recentlyShown.clear();
        pool = images;
      }
    }

    const picked = pool[Math.floor(Math.random() * pool.length)];
    this.recentlyShown.add(picked.id);
    if (this.recentlyShown.size > this.maxRecentCount) {
      this.recentlyShown = new Set(Array.from(this.recentlyShown).slice(-this.maxRecentCount));
    }
    return picked;
  }

  // The photo after `afterId` in an ordered list, wrapping round; the first if unknown
  pickNext(ordered, afterId) {
    const index = afterId ? ordered.findIndex(img => img.id === afterId) : -1;
    return ordered[(index + 1) % ordered.length];
  }

  // When and where the photo was taken, for the frame's caption
  async describe(image) {
    try {
      const { takenAt, lat, lon } = await photoInfo.get(image.path, image.relativePath);
      return { takenAt, place: await photoInfo.placeName(lat, lon) };
    } catch {
      return { takenAt: null, place: null };
    }
  }

  // Get image thumbnail (generated once, then served from the disk cache)
  async getImageThumbnail(req, res) {
    try {
      // Express already decoded the param; a second decode would mangle names containing '%'
      const imagePath = thumbnails.resolveInUploads(req.params.imageId);

      if (!imagePath || !thumbnails.IMAGE_PATTERN.test(imagePath) || !await getLibrary().exists(toAdminPath(imagePath))) {
        return res.status(404).json({
          success: false,
          error: 'Image not found',
          code: 'IMAGE_NOT_FOUND'
        });
      }

      thumbnails.send(res, await thumbnails.getThumbnail(imagePath), { versioned: Boolean(req.query.v) });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error generating image thumbnail:', error);
      res.status(500).json({
        success: false,
        error: 'Server error',
        code: 'SERVER_ERROR'
      });
    }
  }

  // Keep a photo's own format when rewriting it (uploads are WebP, older ones JPEG)
  formatFor(fullPath) {
    const ext = path.extname(fullPath).toLowerCase().slice(1);
    return { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp', gif: 'gif' }[ext] || 'jpeg';
  }

  // Clear image cache to force refresh
  clearImageCache() {
    this.imageCache = null;
    this.cacheTimestamp = null;
    console.log('Image cache cleared');
  }

  // Upload images
  async uploadImages(req, res) {
    const processedFiles = [];
    try {
      const uploadedFiles = req.files;
      const targetDir = resolveAdminPath(req.body.path || 'uploads', { allowRoot: true });

      if (!targetDir) {
        return res.status(400).json({ message: 'Invalid upload folder' });
      }

      for (const file of uploadedFiles) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const filename = `${file.fieldname}-${uniqueSuffix}.webp`;
        // A display copy sized for frames: upright, WebP, no metadata (GPS stays private)
        const buffer = await sharp(file.buffer, { animated: file.mimetype === 'image/gif' })
          .rotate()
          .resize(
            parseInt(process.env.MAX_RESOLUTION_WIDTH) || 2560,
            parseInt(process.env.MAX_RESOLUTION_HEIGHT) || 2560,
            { fit: 'inside', withoutEnlargement: true }
          )
          .webp({ quality: parseInt(process.env.IMAGE_QUALITY) || 82 })
          .toBuffer();
        await assertCanAdd(buffer.length);
        const added = await getLibrary().addPhoto(toAdminPath(targetDir), {
          buffer, originalName: filename, contentType: 'image/webp'
        });
        // Keep when and where it was taken, read from the original before it is dropped
        const storedPath = resolveAdminPath(added.path);
        await photoInfo.rememberUpload(storedPath, path.relative(this.uploadsDir, storedPath), file.buffer)
          .catch(error => console.warn('Could not read photo info:', error.message));
        processedFiles.push({ filename, originalname: file.originalname, path: added.path, size: buffer.length });
      }

      // Clear cache after upload to include new images
      this.clearImageCache();
      
      res.json({
        message: 'Images uploaded successfully',
        files: processedFiles
      });
    } catch (error) {
      if (error.code === 'QUOTA_EXCEEDED') {
        // Photos before the one that hit the limit are kept
        this.clearImageCache();
        return res.status(413).json({ message: error.message, code: error.code, files: processedFiles });
      }
      if (passClientError(res, error)) return;
      console.error('Error uploading images:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }

  // Delete image
  async deleteImage(req, res) {
    try {
      const fullPath = resolveAdminPath(req.query.path);

      if (!fullPath || !await getLibrary().exists(toAdminPath(fullPath))) {
        return res.status(404).json({ message: 'Image not found' });
      }

      await getLibrary().deletePhoto(toAdminPath(fullPath));
      await thumbnails.remove(fullPath);
      
      // Clear cache after deletion to update available images
      this.clearImageCache();
      
      res.json({ message: 'Image deleted successfully' });
    } catch (error) {
      if (passClientError(res, error)) return;
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
      if (!destDir || !(await getLibrary().stat(toAdminPath(destDir)))?.isFolder) {
        return res.status(404).json({ message: 'Destination folder not found' });
      }

      const results = { movedCount: 0, failedCount: 0, errors: [] };

      for (const imagePath of paths) {
        const fullPath = resolveAdminPath(imagePath);

        const isSnap = Boolean(fullPath) && snaps.isSnap(fullPath);
        if (!fullPath || !(isSnap || thumbnails.IMAGE_PATTERN.test(fullPath)) || !await getLibrary().exists(toAdminPath(fullPath))) {
          results.failedCount++;
          results.errors.push(`Image not found: ${imagePath}`);
          continue;
        }
        if (path.dirname(fullPath) === destDir) continue; // already there

        try {
          const moved = await getLibrary().movePhoto(toAdminPath(fullPath), toAdminPath(destDir));
          await thumbnails.remove(fullPath);
          await photoInfo.moveUpload(fullPath, resolveAdminPath(moved.path))
            .catch(error => console.warn('Could not move photo info:', error.message));
          if (!isSnap) {
            await snaps.photoMoved(path.relative(this.uploadsDir, fullPath), path.relative('uploads', moved.path));
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
      if (passClientError(res, error)) return;
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

          if (fullPath && await getLibrary().exists(toAdminPath(fullPath))) {
            await getLibrary().deletePhoto(toAdminPath(fullPath));
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
      if (passClientError(res, error)) return;
      console.error('Error in batch delete:', error);
      res.status(500).json({ message: 'Server error during batch deletion' });
    }
  }

  // Rotate image
  async rotateImage(req, res) {
    try {
      const { path: imagePath, angle = 90 } = req.body;
      const fullPath = resolveAdminPath(imagePath);

      if (!fullPath || !await getLibrary().exists(toAdminPath(fullPath))) {
        return res.status(404).json({ message: 'Image not found' });
      }
      
      // Validate angle (should be multiple of 90)
      if (angle % 90 !== 0) {
        return res.status(400).json({ message: 'Angle must be a multiple of 90 degrees' });
      }
      
      const buffer = await sharp(await getLibrary().readPhoto(toAdminPath(fullPath)))
        .rotate(angle)
        .toFormat(this.formatFor(fullPath), { quality: parseInt(process.env.IMAGE_QUALITY) || 85 })
        .toBuffer();
      await getLibrary().writeItem(toAdminPath(fullPath), buffer);

      // Clear cache after rotation to update available images
      this.clearImageCache();
      
      const direction = angle > 0 ? 'clockwise' : 'counter-clockwise';
      res.json({ message: `Image rotated ${Math.abs(angle)}° ${direction} successfully` });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error rotating image:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
}

module.exports = new ImageController();
