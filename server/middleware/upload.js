const path = require('path');
const multer = require('multer');
const slots = require('../utils/workSlots');
const { runWithTenant } = require('../context');
const { assertCanAdd } = require('../services/quotaService');
// Multer configuration for file uploads. Files stay in memory (never in plain
// text on disk), so the number per request is capped; the admin page sends
// larger selections in batches.
const storage = multer.memoryStorage();

// Originals are only read once: the stored copy is resized to the frame size,
// so a large limit costs no storage. 25 MB fits 48 MP phone photos.
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 25 * 1024 * 1024;
// Whole request: the admin page sends one photo per request (js/photoUpload.js)
const MAX_UPLOAD_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE) || 4 * MAX_FILE_SIZE;

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
 * MAX_UPLOAD_SIZE, one from a family whose library is already full, and one
 * that would go over the uploads held and converted at once (503, which the
 * admin page retries). The slot is kept until the upload is processed:
 * the route's handler calls req.uploadSlot.finish() when it is done.
 */
async function uploadLimits(req, res, next) {
  const length = Number(req.headers['content-length']);
  if (!req.headers['content-length'] || !Number.isFinite(length)) {
    return res.status(411).json({ code: 'LENGTH_REQUIRED', message: 'Uploads need a Content-Length.' });
  }
  if (length > MAX_UPLOAD_SIZE) {
    const size = Math.round(MAX_UPLOAD_SIZE / (1024 * 1024));
    return res.status(413).set('Connection', 'close')
      .json({ code: 'UPLOAD_TOO_LARGE', size, message: `Upload too large. Maximum is ${size}MB per request.` });
  }

  // Listen first: the browser may leave while the quota hook is still answering
  let closed = false;
  let release = null;
  const slot = { started: false, finish: () => { if (release) release(); } };
  res.once('close', () => {
    closed = true;
    if (!slot.started) slot.finish();
  });

  // No room left at all? Then don't even read the photos
  try {
    await runWithTenant(req.tenant, () => assertCanAdd(1));
  } catch (error) {
    if (error.code !== 'QUOTA_EXCEEDED') return next(error);
    return res.status(413).set('Connection', 'close').json({ code: error.code, message: error.message, files: [] });
  }

  if (closed) return; // gone already: nothing to read or answer
  release = slots.tryAcquire((req.tenant && req.tenant.id) || 'default');
  if (!release) {
    return res.status(503).set({ 'Retry-After': '2', Connection: 'close' })
      .json({ code: 'BUSY', message: 'Too many uploads at once. Try again in a moment.' });
  }

  // Given back when the handler finishes, or when the request ends before it starts
  req.uploadSlot = slot;
  next();
}

module.exports = upload;
module.exports.MAX_FILE_SIZE = MAX_FILE_SIZE;
module.exports.MAX_UPLOAD_SIZE = MAX_UPLOAD_SIZE;
module.exports.uploadLimits = uploadLimits;
