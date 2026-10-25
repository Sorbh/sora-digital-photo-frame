const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const sharp = require('sharp');

const { UPLOADS_DIR, CACHE_DIR: CACHE_ROOT } = require('../config/paths');
const { toAdminPath } = require('../utils/safePath');
const { getLibrary } = require('../library');

const CACHE_DIR = path.join(CACHE_ROOT, 'thumbs');
const IMAGE_PATTERN = /\.(jpg|jpeg|png|gif|webp)$/i;

// Square cover crop, big enough for a 2x-density grid tile
const THUMB_SIZE = 480;

/**
 * Generates thumbnails once and keeps them on disk, so the admin grid,
 * folder covers and pickers never resize the same original twice.
 * A thumbnail is rebuilt only when its source file is newer (e.g. rotated).
 */
class ThumbnailService {
  constructor() {
    this.inFlight = new Map();
    fs.ensureDirSync(CACHE_DIR);
  }

  /**
   * Resolve a path relative to uploads/, refusing anything that escapes it.
   * Returns null for invalid paths.
   */
  resolveInUploads(relativePath = '') {
    const resolved = path.resolve(UPLOADS_DIR, relativePath);
    if (resolved !== UPLOADS_DIR && !resolved.startsWith(UPLOADS_DIR + path.sep)) {
      return null;
    }
    return resolved;
  }

  cachePathFor(sourcePath) {
    const key = crypto.createHash('sha1')
      .update(`${path.relative(UPLOADS_DIR, sourcePath)}:${THUMB_SIZE}`)
      .digest('hex');
    return path.join(CACHE_DIR, `${key}.webp`);
  }

  /**
   * Absolute path of a ready thumbnail for an image inside uploads/.
   */
  async getThumbnail(sourcePath) {
    const cachePath = this.cachePathFor(sourcePath);

    const [source, cached] = await Promise.all([
      getLibrary().stat(toAdminPath(sourcePath)),
      fs.stat(cachePath).catch(() => null)
    ]);
    if (cached && cached.mtimeMs >= source.mtimeMs) {
      return cachePath;
    }

    // Concurrent requests for the same image share one sharp job
    if (!this.inFlight.has(cachePath)) {
      const job = this.generate(sourcePath, cachePath)
        .finally(() => this.inFlight.delete(cachePath));
      this.inFlight.set(cachePath, job);
    }
    return this.inFlight.get(cachePath);
  }

  async generate(sourcePath, cachePath) {
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    await sharp(await getLibrary().readPhoto(toAdminPath(sourcePath)))
      .rotate() // honour EXIF orientation from phone cameras
      .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover' })
      .webp({ quality: 78 })
      .toFile(tmpPath);
    await fs.move(tmpPath, cachePath, { overwrite: true });
    return cachePath;
  }

  /**
   * First image in a folder, searching subfolders breadth-first.
   */
  async findFirstImage(dir) {
    const [first] = await this.findImages(dir, 1);
    return first || null;
  }

  /**
   * Up to `limit` images in a folder, in the same breadth-first order.
   */
  async findImages(dir, limit) {
    const found = [];
    const queue = [dir];
    while (queue.length && found.length < limit) {
      const current = queue.shift();
      let items;
      try {
        items = (await getLibrary().listItems(toAdminPath(current))).map(item => ({
          name: item.name, isFile: () => !item.isFolder, isDirectory: () => item.isFolder
        }));
      } catch {
        continue;
      }
      items.sort((a, b) => a.name.localeCompare(b.name));

      for (const item of items) {
        if (found.length >= limit) break;
        if (item.isFile() && IMAGE_PATTERN.test(item.name)) found.push(path.join(current, item.name));
      }

      items
        .filter(item => item.isDirectory() && !item.name.startsWith('.'))
        .forEach(item => queue.push(path.join(current, item.name)));
    }
    return found;
  }

  async remove(sourcePath) {
    await fs.remove(this.cachePathFor(sourcePath)).catch(() => {});
  }

  /**
   * Send a thumbnail; ETag/Last-Modified come from sendFile.
   */
  send(res, thumbPath, { versioned = true } = {}) {
    // Versioned URLs (?v=...) change with the source, so they can be cached for long
    res.set('Cache-Control', versioned
      ? 'public, max-age=604800, immutable'
      : 'public, max-age=300, stale-while-revalidate=86400');
    res.type('image/webp');
    res.sendFile(thumbPath);
  }
}

module.exports = new ThumbnailService();
module.exports.IMAGE_PATTERN = IMAGE_PATTERN;
module.exports.UPLOADS_DIR = UPLOADS_DIR;
