const path = require('path');
const sharp = require('sharp');
const { getLibrary } = require('../library');
const { acceptsWebp } = require('./webpFallback');

const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.json': 'application/json' };

/**
 * Serves /uploads/... through the photo library when files can't be served
 * straight from disk (encrypted, or stored elsewhere). Photos are decrypted
 * on the server, so this also covers frames that can't decrypt themselves;
 * old browsers without WebP get JPEG.
 */
function media() {
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    let adminPath;
    try {
      adminPath = path.posix.join('uploads', decodeURIComponent(req.path));
    } catch {
      return next();
    }
    if (!adminPath.startsWith('uploads/')) return next();

    try {
      const library = getLibrary();
      const stat = await library.stat(adminPath);
      if (!stat || stat.isFolder) return next();

      const ext = path.extname(adminPath).toLowerCase();
      const toJpeg = ext === '.webp' && !acceptsWebp(req);
      res.vary('Accept');
      res.set('Cache-Control', 'private, max-age=0');
      res.set('ETag', `W/"${stat.size}-${Math.round(stat.mtimeMs)}${toJpeg ? '-j' : ''}"`);
      if (req.fresh) return res.status(304).end();

      let body = await library.readPhoto(adminPath);
      if (toJpeg) body = await sharp(body).jpeg({ quality: 85 }).toBuffer();
      res.type(toJpeg ? 'image/jpeg' : (TYPES[ext] || 'application/octet-stream'));
      res.send(body);
    } catch (error) {
      if (error.message === 'Invalid library path') return next();
      next(error);
    }
  };
}

module.exports = media;
