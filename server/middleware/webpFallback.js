const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const sharp = require('sharp');
const { CACHE_DIR } = require('../config/paths');

const JPEG_DIR = path.join(CACHE_DIR, 'jpeg');

const inFlight = new Map();

// Browsers that can show WebP say so; clients sending no Accept header (scripts) get WebP as before
const acceptsWebp = (req) => {
  const accept = req.get('accept');
  return !accept || accept.includes('image/webp');
};

/**
 * Path of a cached JPEG copy of a WebP file, made on first use.
 */
async function jpegCopy(source, stat) {
  stat = stat || await fs.stat(source);
  const key = crypto.createHash('sha1').update(`${source}:${Math.round(stat.mtimeMs)}`).digest('hex');
  const target = path.join(JPEG_DIR, `${key}.jpg`);
  if (await fs.pathExists(target)) return target;

  if (!inFlight.has(target)) {
    const job = (async () => {
      await fs.ensureDir(JPEG_DIR);
      const tmp = `${target}.${process.pid}.tmp`;
      await sharp(source).jpeg({ quality: 85 }).toFile(tmp);
      await fs.move(tmp, target, { overwrite: true });
      return target;
    })().finally(() => inFlight.delete(target));
    inFlight.set(target, job);
  }
  return inFlight.get(target);
}

/**
 * Old frames (Safari before iOS 14) cannot show WebP. When a browser doesn't
 * list image/webp in its Accept header, send a JPEG copy instead, converted
 * once and kept in the cache folder.
 */
function webpFallback(rootDir) {
  const root = path.resolve(rootDir);

  return async (req, res, next) => {
    if (!/\.webp$/i.test(req.path)) return next();
    res.vary('Accept');
    if (acceptsWebp(req)) return next();

    try {
      const source = path.resolve(root, '.' + decodeURIComponent(req.path));
      if (!source.startsWith(root + path.sep)) return next();
      const stat = await fs.stat(source).catch(() => null);
      if (!stat || !stat.isFile()) return next();

      res.type('jpeg');
      res.sendFile(await jpegCopy(source, stat));
    } catch (error) {
      next(error);
    }
  };
}

module.exports = webpFallback;
module.exports.jpegCopy = jpegCopy;
module.exports.acceptsWebp = acceptsWebp;
