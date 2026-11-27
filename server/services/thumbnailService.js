const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const sharp = require('sharp');

const { UPLOADS_DIR, CACHE_DIR: CACHE_ROOT } = require('../config/paths');
const { toAdminPath } = require('../utils/safePath');
const { getLibrary } = require('../library');
const { jpegCopy, acceptsWebp } = require('../middleware/webpFallback');
const { currentTenant, DEFAULT_TENANT } = require('../context');
const photoInfo = require('./photoInfoService');

// v2: keys that always name the family (see cachePathFor). Files from before sit one
// folder up and are never looked at, so an old key that two families shared can't be served.
const CACHE_DIR = path.join(CACHE_ROOT, 'thumbs', 'v2');
const IMAGE_PATTERN = /\.(jpg|jpeg|png|gif|webp)$/i;

// Square cover crop, big enough for a 2x-density grid tile (folder covers, pickers, snaps)
const THUMB_SIZE = 480;
// The library grid keeps each photo's shape: rows about 240px tall at 2x density,
// a panorama at most this wide
const SHAPED_HEIGHT = 540;
const SHAPED_MAX_WIDTH = 1280;
const FITS = ['cover', 'inside'];

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

  cachePathFor(sourcePath, fit = 'cover') {
    // Tenants share admin paths ("uploads/Family/..."), so their thumbnails must not
    // (the default one included: its "family/a.jpg" must never be tenant "family"'s "a.jpg")
    const { id } = currentTenant();
    const scope = id === DEFAULT_TENANT.id ? '__default__/' : `t/${encodeURIComponent(id)}/`;
    const key = crypto.createHash('sha1')
      .update(`${scope}${path.relative(UPLOADS_DIR, sourcePath)}:${fit === 'inside' ? `inside${SHAPED_HEIGHT}` : THUMB_SIZE}`)
      .digest('hex');
    return path.join(CACHE_DIR, `${key}.webp`);
  }

  /**
   * Absolute path of a ready thumbnail for an image inside uploads/.
   * fit: 'cover' (square) or 'inside' (the photo's own shape, for the library grid).
   */
  async getThumbnail(sourcePath, { fit = 'cover' } = {}) {
    if (!FITS.includes(fit)) fit = 'cover';
    const cachePath = this.cachePathFor(sourcePath, fit);

    const [source, cached] = await Promise.all([
      getLibrary().stat(toAdminPath(sourcePath)),
      fs.stat(cachePath).catch(() => null)
    ]);
    if (cached && cached.mtimeMs >= source.mtimeMs) {
      if (fit === 'inside') await this.measureCached(sourcePath, cachePath, source);
      return cachePath;
    }

    // Concurrent requests for the same image share one sharp job
    if (!this.inFlight.has(cachePath)) {
      const job = this.generate(sourcePath, cachePath, fit, source)
        .finally(() => this.inFlight.delete(cachePath));
      this.inFlight.set(cachePath, job);
    }
    return this.inFlight.get(cachePath);
  }

  async generate(sourcePath, cachePath, fit = 'cover', sourceStat = null) {
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    const image = sharp(await getLibrary().readPhoto(toAdminPath(sourcePath)))
      .rotate(); // honour EXIF orientation from phone cameras
    if (fit === 'inside') {
      image.resize(SHAPED_MAX_WIDTH, SHAPED_HEIGHT, { fit: 'inside', withoutEnlargement: true });
    } else {
      image.resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover' });
    }
    const made = await image.webp({ quality: 78 }).toFile(tmpPath);
    await fs.move(tmpPath, cachePath, { overwrite: true });
    // Its shape, so the next listing can lay the grid out before any thumbnail loads
    if (fit === 'inside' && sourceStat) {
      await photoInfo.rememberSize(path.relative(UPLOADS_DIR, sourcePath), sourceStat, made.width, made.height)
        .catch(() => {});
    }
    return cachePath;
  }

  // A shaped thumbnail made before its size was kept (or the size cache was cleared): measure it
  async measureCached(sourcePath, cachePath, sourceStat) {
    try {
      const relative = path.relative(UPLOADS_DIR, sourcePath);
      await photoInfo.loadCache();
      if (photoInfo.sizeOf(relative, sourceStat)) return;
      const { width, height } = await sharp(cachePath).metadata();
      await photoInfo.rememberSize(relative, sourceStat, width, height);
    } catch {
      // the grid measures it as it loads
    }
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
    await Promise.all(FITS.map(fit => fs.remove(this.cachePathFor(sourcePath, fit)).catch(() => {})));
  }

  /**
   * Send a thumbnail with an ETag of its own (see sendTagged).
   */
  send(res, thumbPath) {
    // private: tenants share these URLs, so a shared cache must never keep one.
    // no-cache: the browser keeps its copy but asks first (a cheap 304 via the ETag),
    // so it stops showing it after signing out or losing access to the folder.
    res.set('Cache-Control', 'private, no-cache');
    res.vary('Accept');
    // Old frames without WebP get a JPEG copy
    const file = acceptsWebp(res.req) ? Promise.resolve(thumbPath) : jpegCopy(thumbPath);
    return file
      .then(ready => this.sendTagged(res, ready, acceptsWebp(res.req) ? 'image/webp' : 'jpeg'))
      .catch(() => res.status(500).json({ message: 'Server error' }));
  }

  // sendFile's own ETag is only size and time, which two families' thumbnails can share.
  // The cache file's name is unique per family and photo, so it goes into the ETag too.
  async sendTagged(res, file, type) {
    const stat = await fs.stat(file);
    const tag = crypto.createHash('sha1').update(`${file}:${stat.size}:${stat.mtimeMs}`).digest('base64url');
    res.set('ETag', `"${tag}"`);
    // No Last-Modified: a date can match another family's thumbnail, the ETag can't
    res.type(type).sendFile(file, { lastModified: false });
  }
}

module.exports = new ThumbnailService();
module.exports.IMAGE_PATTERN = IMAGE_PATTERN;
module.exports.UPLOADS_DIR = UPLOADS_DIR;
