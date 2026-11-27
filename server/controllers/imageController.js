const path = require('path');
const { UPLOADS_DIR } = require('../config/paths');
const { getLibrary } = require('../library');
const { currentTenant } = require('../context');
const { assertCanAdd, addWithinQuota, photoItems } = require('../services/quotaService');
const sharp = require('sharp');
const thumbnails = require('../services/thumbnailService');
const { sharpInput } = require('../utils/heic');
const { displayCopy, assertImageSize, MAX_PIXELS } = require('../utils/displayCopy');
const slots = require('../utils/workSlots');
const { assignedFolders, canSee, inFolder, realVisiblePath } = require('../utils/viewerAccess');
const snaps = require('../services/snapService');
const notes = require('../services/noteService');
const playOrder = require('../services/playOrderService');
const photoInfo = require('../services/photoInfoService');
const { resolveAdminPath, toAdminPath } = require('../utils/safePath');
const { passClientError, folderNotFoundError } = require('../utils/httpError');

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

    // Notes are never photos, even from a library that lists them with photos
    const photos = (await getLibrary().allPhotos()).filter(photo => !notes.isNote(photo.path || photo.name || ''));
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
      // Already decoded by Express: decoding again breaks folder names with %.
      // ?folder[]=x still works as before (an array reads as its joined text, and
      // an empty ?folder[]= is still a filter that matches nothing).
      const hasFolderFilter = Boolean(req.query.folder);
      const folderFilter = hasFolderFilter ? String(req.query.folder) : '';
      const allImages = await this.getAllImages();
      
      if (allImages.length === 0) {
        return res.status(404).json({ 
          success: false,
          error: 'No images found',
          code: 'NO_IMAGES_FOUND'
        });
      }
      
      let availableImages = allImages;
      
      // A PIN account with assigned folders, or a signed-in person limited to some
      // (their scope): only photos in those folders or their subfolders
      const limitedTo = assignedFolders(req);
      if (limitedTo) {
        // In an assigned folder or one of its subfolders, whatever the separators
        availableImages = allImages.filter(img => canSee(req, img.relativePath));

        if (availableImages.length === 0) {
          console.log('❌ Access Control - No accessible images found for assigned folders:', limitedTo);
          return res.status(403).json({ 
            success: false,
            error: 'No images accessible with your account permissions',
            code: 'ACCESS_RESTRICTED'
          });
        }
      }
      
      // Apply folder filter if specified
      if (hasFolderFilter) {
        const decodedFolder = folderFilter;

        // The frame sends "/"; photo paths use the system's separator ("\\" on Windows)
        availableImages = availableImages.filter(img => inFolder(img.relativePath, decodedFolder));

        if (availableImages.length === 0) {
          console.log('❌ API Filter - No images found in the chosen folder');
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
      const baseDir = hasFolderFilter ? resolveAdminPath(path.join('uploads', folderFilter)) : this.uploadsDir;
      const { order } = baseDir ? await playOrder.read(baseDir) : { order: 'shuffle' };
      const randomImage = order === 'shuffle'
        ? this.pickShuffled(availableImages)
        : this.pickNext(await playOrder.sort(baseDir, availableImages, order), req.query.after);

      // A snap is drawn by the frame itself, from its page data
      if (randomImage.type === 'snap') {
        const snap = await snaps.forFrame(randomImage.path, req);
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
      // When and where a photo was taken is private: only signed-in viewers get it
      const signedIn = req.session && (req.session.authenticated || req.session.accessAccount);
      const info = signedIn ? await this.describe(randomImage) : { takenAt: null, place: null };
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
      const requested = thumbnails.resolveInUploads(req.params.imageId);
      // Photos outside a frame's folders look like they don't exist, also through a
      // symlink; the thumbnail is made from where the photo really is
      const visible = requested && thumbnails.IMAGE_PATTERN.test(requested)
        ? await realVisiblePath(req, path.relative(UPLOADS_DIR, requested)) : null;
      const imagePath = visible === null ? null : path.join(UPLOADS_DIR, visible);

      if (!imagePath || !thumbnails.IMAGE_PATTERN.test(imagePath) || !await getLibrary().exists(toAdminPath(imagePath))) {
        return res.status(404).json({
          success: false,
          error: 'Image not found',
          code: 'IMAGE_NOT_FOUND'
        });
      }

      // ?fit=inside: the photo's own shape, for the library grid; otherwise a square
      const fit = req.query.fit === 'inside' ? 'inside' : 'cover';
      thumbnails.send(res, await thumbnails.getThumbnail(imagePath, { fit }));
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

  // The library grid lays photos out by their shape before the thumbnails load
  async rememberSize(fullPath, buffer) {
    try {
      const { width, height, pageHeight } = await sharp(buffer, { limitInputPixels: false }).metadata();
      const stat = await getLibrary().stat(toAdminPath(fullPath));
      // An animation's frames are stacked: one frame is pageHeight tall
      await photoInfo.rememberSize(path.relative(this.uploadsDir, fullPath), stat, width, pageHeight || height);
    } catch (error) {
      console.warn('Could not read photo size:', error.message);
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
    // Hold the upload slot (middleware/upload.js) until the work is done, even if the browser leaves
    if (req.uploadSlot) req.uploadSlot.started = true;
    try {
      const uploadedFiles = req.files;
      const targetDir = resolveAdminPath(req.body.path || 'uploads', { allowRoot: true });

      if (!targetDir) {
        return res.status(400).json({ message: 'Invalid upload folder' });
      }
      // Into a folder that exists: an upload never makes one, nor brings back a deleted one
      if (!(await getLibrary().stat(toAdminPath(targetDir)))?.isFolder) throw folderNotFoundError();

      // A phone that shrank a photo before sending it says what the original knew (js/photoUpload.js)
      let sentInfo = [];
      try { sentInfo = [].concat(JSON.parse(req.body.info || '[]')); } catch { /* not ours: ignore */ }

      for (const [index, file] of uploadedFiles.entries()) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const filename = `${file.fieldname}-${uniqueSuffix}.webp`;
        // No room left at all (the library filled up during this batch)? Then don't convert it
        await assertCanAdd({ items: 1, bytes: 1 });
        // A display copy sized for frames: upright, WebP, no metadata (GPS stays private)
        const buffer = await displayCopy(file.buffer, { animated: file.mimetype === 'image/gif' });
        // A photo is 1 item, one that stayed animated 5
        const items = await photoItems(buffer);
        const added = await addWithinQuota({ items, bytes: buffer.length }, () => getLibrary().addPhoto(toAdminPath(targetDir), {
          buffer, originalName: filename, contentType: 'image/webp'
        }));
        // Keep when and where it was taken, read from the original before it is dropped
        const storedPath = resolveAdminPath(added.path);
        await photoInfo.rememberUpload(storedPath, path.relative(this.uploadsDir, storedPath), file.buffer, sentInfo[index])
          .catch(error => console.warn('Could not read photo info:', error.message));
        // Its shape, for the library grid (the display copy is already upright)
        await this.rememberSize(storedPath, buffer);
        processedFiles.push({ filename, originalname: file.originalname, path: added.path, size: buffer.length });
      }

      // Clear cache after upload to include new images
      this.clearImageCache();
      
      res.json({
        message: 'Images uploaded successfully',
        files: processedFiles
      });
    } catch (error) {
      // Photos before the one that failed are kept: say which, and show them on frames
      if (processedFiles.length) this.clearImageCache();
      if (error.code === 'QUOTA_EXCEEDED') {
        return res.status(413).json({ message: error.message, code: error.code, files: processedFiles });
      }
      const status = error && error.status;
      if (Number.isInteger(status) && status >= 400 && status < 500) {
        return res.status(status).json({
          message: error.expose === false ? 'Request failed' : error.message,
          ...(error.code && { code: error.code }),
          ...(error.vars && { ...error.vars }),
          files: processedFiles
        });
      }
      console.error('Error uploading images:', error);
      res.status(500).json({ message: 'Server error', files: processedFiles });
    } finally {
      if (req.uploadSlot) req.uploadSlot.finish();
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
        return res.status(404).json({ message: 'Destination folder not found', code: 'FOLDER_NOT_FOUND' });
      }

      const results = { movedCount: 0, failedCount: 0, errors: [] };
      let destinationGone = false;

      for (const imagePath of paths) {
        // Deleted while these were moving: it isn't made again, the rest stay put
        if (destinationGone) {
          results.failedCount++;
          results.errors.push(`Failed to move: ${imagePath}`);
          continue;
        }
        const fullPath = resolveAdminPath(imagePath);

        const isSnap = Boolean(fullPath) && snaps.isSnap(fullPath);
        // A note dragged onto a folder moves there too (and then shows on that folder's frames)
        const isNote = Boolean(fullPath) && notes.isNote(fullPath);
        if (!fullPath || !(isSnap || isNote || thumbnails.IMAGE_PATTERN.test(fullPath)) || !await getLibrary().exists(toAdminPath(fullPath))) {
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
          if (!isSnap && !isNote) {
            const from = path.relative(this.uploadsDir, fullPath);
            const to = path.relative('uploads', moved.path);
            await snaps.photoMoved(from, to);
            await notes.photoMoved(from, to);
          }
          results.movedCount++;
        } catch (error) {
          if (error.code === 'FOLDER_NOT_FOUND') destinationGone = true;
          else console.error(`Error moving image ${imagePath}:`, error);
          results.failedCount++;
          results.errors.push(`Failed to move: ${imagePath}`);
        }
      }

      this.clearImageCache();

      if (destinationGone && results.movedCount === 0) {
        return res.status(404).json({ message: 'Destination folder not found', code: 'FOLDER_NOT_FOUND', ...results });
      }
      res.status(results.failedCount > 0 ? 207 : 200).json({
        message: `Moved ${results.movedCount} image(s)`,
        ...(destinationGone && { code: 'FOLDER_NOT_FOUND' }),
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
      
      // Converted like an upload: in turn with the others, and only if not too large
      const release = await slots.acquire(currentTenant().id);
      let rotated = null;
      try {
        // Rotating drops EXIF, so make sure it's been read before the file changes
        await photoInfo.get(fullPath, path.relative(this.uploadsDir, fullPath))
          .catch(error => console.warn('Could not read photo info:', error.message));
        const before = await getLibrary().stat(toAdminPath(fullPath));
        const original = await getLibrary().readPhoto(toAdminPath(fullPath));
        await assertImageSize(original);
        const buffer = await sharp(original, { limitInputPixels: MAX_PIXELS })
          .rotate(angle)
          .toFormat(this.formatFor(fullPath), { quality: parseInt(process.env.IMAGE_QUALITY) || 85 })
          .toBuffer();
        // A re-encoded photo can come out bigger: that growth needs room too. Checked in
        // the family's turn, against the photo as it is now: gone or changed meanwhile, it stays so.
        const sameFile = async () => {
          const now = await getLibrary().stat(toAdminPath(fullPath));
          if (!now || now.size !== before.size || now.mtimeMs !== before.mtimeMs) {
            throw Object.assign(new Error('The photo changed while it was being rotated'), { status: 409, code: 'PHOTO_CHANGED' });
          }
        };
        // Still the same photo: no new items, only its growth
        const growth = async () => { await sameFile(); return { items: 0, bytes: buffer.length - original.length }; };
        // Checked once more after the quota hook answered, right before writing
        await addWithinQuota(growth, async () => {
          await sameFile();
          await getLibrary().writeItem(toAdminPath(fullPath), buffer);
        });
        rotated = buffer;
      } finally {
        release();
      }
      await photoInfo.moveUpload(fullPath, fullPath)
        .catch(error => console.warn('Could not keep photo info:', error.message));
      // Its new shape (a quarter turn swaps width and height)
      if (rotated) await this.rememberSize(fullPath, rotated);

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
