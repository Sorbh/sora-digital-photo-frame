const path = require('path');
const multer = require('multer');
// Multer configuration for file uploads. Files stay in memory (never in plain
// text on disk), so the number per request is capped; the admin page sends
// larger selections in batches.
const storage = multer.memoryStorage();

// Originals are only read once: the stored copy is resized to the frame size,
// so a large limit costs no storage. 25 MB fits 48 MP phone photos.
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 25 * 1024 * 1024;
// Whole request: the admin page sends one photo per request (js/photoUpload.js)
const MAX_UPLOAD_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE) || 4 * MAX_FILE_SIZE;
// Uploads held in memory and converted at the same time: all families, and one family
const UPLOADS_AT_ONCE = parseInt(process.env.UPLOADS_AT_ONCE) || 4;
const UPLOADS_AT_ONCE_PER_FAMILY = 2;

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif'];
// Some browsers send HEIC files without a type
const HEIC_NAME = /\.(heic|heif)$/i;
const UNTYPED = ['', 'application/octet-stream'];

const upload = multer({
  storage: storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 10, // most photos in one request
    fields: 10, // path and info
    fieldSize: 64 * 1024,
    parts: 20
  },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype) || (UNTYPED.includes(file.mimetype || '') && HEIC_NAME.test(path.basename(file.originalname || '')))) {
      cb(null, true);
    } else {
      const error = new Error('Invalid file type. Only JPEG, PNG, GIF, WebP and HEIC are allowed.');
      error.code = 'UNSUPPORTED_TYPE';
      cb(error);
    }
  }
});

/**
 * Runs before multer reads anything: refuses a request bigger than
 * MAX_UPLOAD_SIZE, and one that would go over the number of uploads
 * buffered and converted at once (503, which the admin page retries).
 */
const running = { total: 0, byFamily: new Map() };

function uploadLimits(req, res, next) {
  const length = Number(req.headers['content-length']);
  if (!req.headers['content-length'] || !Number.isFinite(length)) {
    return res.status(411).json({ code: 'LENGTH_REQUIRED', message: 'Uploads need a Content-Length.' });
  }
  if (length > MAX_UPLOAD_SIZE) {
    const size = Math.round(MAX_UPLOAD_SIZE / (1024 * 1024));
    return res.status(413).set('Connection', 'close')
      .json({ code: 'UPLOAD_TOO_LARGE', size, message: `Upload too large. Maximum is ${size}MB per request.` });
  }

  const family = (req.tenant && req.tenant.id) || 'default';
  const forFamily = running.byFamily.get(family) || 0;
  if (running.total >= UPLOADS_AT_ONCE || forFamily >= UPLOADS_AT_ONCE_PER_FAMILY) {
    return res.status(503).set({ 'Retry-After': '2', Connection: 'close' })
      .json({ code: 'BUSY', message: 'Too many uploads at once. Try again in a moment.' });
  }

  running.total += 1;
  running.byFamily.set(family, forFamily + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    running.total -= 1;
    const left = running.byFamily.get(family) - 1;
    if (left > 0) running.byFamily.set(family, left);
    else running.byFamily.delete(family);
  };
  res.once('finish', release);
  res.once('close', release);
  next();
}

module.exports = upload;
module.exports.MAX_FILE_SIZE = MAX_FILE_SIZE;
module.exports.MAX_UPLOAD_SIZE = MAX_UPLOAD_SIZE;
module.exports.uploadLimits = uploadLimits;
