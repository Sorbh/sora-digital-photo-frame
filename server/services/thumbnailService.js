const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const sharp = require('sharp');

const { UPLOADS_DIR, CACHE_DIR: CACHE_ROOT } = require('../config/paths');
const { toAdminPath } = require('../utils/safePath');
const { getLibrary } = require('../library');
const { jpegCopy, acceptsWebp } = require('../middleware/webpFallback');
const { currentTenant, DEFAULT_TENANT } = require('../context');

// v2: keys that always name the family (see cachePathFor). Files from before sit one
// folder up and are never looked at, so an old key that two families shared can't be served.
const CACHE_DIR = path.join(CACHE_ROOT, 'thumbs', 'v2');
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
    // Tenants share admin paths ("uploads/Family/..."), so their thumbnails must not
    // (the default one included: its "family/a.jpg" must never be tenant "family"'s "a.jpg")
    const { id } = currentTenant();
    const scope = id === DEFAULT_TENANT.id ? '__default__/' : `t/${encodeURIComponent(id)}/`;
    const key = crypto.createHash('sha1')
      .update(`${scope}${path.relative(UPLOADS_DIR, sourcePath)}:${THUMB_SIZE}`)
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
