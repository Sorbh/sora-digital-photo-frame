const path = require('path');
const multer = require('multer');
const slots = require('../utils/workSlots');
const { runWithTenant } = require('../context');
const { assertCanAdd } = require('../services/quotaService');
const { clientErrorResponse } = require('../utils/httpError');
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
 * MAX_UPLOAD_SIZE and one from a family whose library is already full, then
 * waits for one of the slots for photos held and converted at once
 * (utils/workSlots.js). Only an upload that waited settings.waitMs, or found the
 * queue full, is answered 503 BUSY (which the admin page retries). The slot is
 * kept until the upload is processed: the route's handler calls
 * req.uploadSlot.finish() when it is done.
 */
async function uploadLimits(req, res, next) {
  const size = Math.round(MAX_UPLOAD_SIZE / (1024 * 1024));
  const tooLarge = () => res.status(413).set('Connection', 'close')
    .json({ code: 'UPLOAD_TOO_LARGE', size, message: `Upload too large. Maximum is ${size}MB per request.` });
  const length = Number(req.headers['content-length']);
  const hasLength = req.headers['content-length'] !== undefined && Number.isFinite(length);
  if (hasLength && length > MAX_UPLOAD_SIZE) return tooLarge();

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
    // Answered like the upload handler answers a hook's error: code, vars, and no photos saved
    if (closed) return;
    if (clientErrorResponse(res, error, { files: [] })) return;
    // Anything else from the hook could say anything: a generic answer
    console.error('Upload quota check failed:', error && error.name);
    res.status(500).json({ message: 'Server error', files: [] });
    return;
  }

  if (closed) return; // gone already: nothing to read or answer
  // Wait in turn for a slot, before the body is read. Only a long wait or a full
  // queue is answered "busy"; a browser that leaves gives up its place.
  const gone = new AbortController();
  const onGone = () => gone.abort();
  res.once('close', onGone);
  const granted = await slots.acquire((req.tenant && req.tenant.id) || 'default', {
    timeoutMs: slots.settings.waitMs, signal: gone.signal, bounded: true
  });
  res.off('close', onGone);
  if (closed) {
    if (granted) granted(); // given a slot just as the browser left
    return;
  }
  if (!granted) {
    return res.status(503).set({ 'Retry-After': '5', Connection: 'close' })
      .json({ code: 'BUSY', message: 'Too many uploads at once. Try again in a moment.' });
  }
  release = granted;

  // Given back when the handler finishes, or when the request ends before it starts
  req.uploadSlot = slot;

  // A browser that stops sending keeps no slot: dropped after settings.idleMs of silence
  let idle = null;
  const quiet = () => { clearTimeout(idle); idle = null; };
  const awake = () => {
    quiet();
    idle = setTimeout(() => { if (!slot.started) req.destroy(); }, slots.settings.idleMs);
    idle.unref();
  };
  req.on('data', awake);
  req.once('end', () => { req.off('data', awake); quiet(); });
  res.once('close', () => { req.off('data', awake); quiet(); });
  awake();

  // Sent without a length (chunked): count the bytes as they come, and stop at the cap.
  // Added right before multer pipes the request, so both see every chunk.
  if (!hasLength) {
    let received = 0;
    const count = (chunk) => {
      received += chunk.length;
      if (received <= MAX_UPLOAD_SIZE || req.uploadRejected) return;
      req.uploadRejected = true; // multer's own error for this request is not answered (see limitedArray)
      req.off('data', count);
      req.unpipe();
      req.resume(); // read and drop the rest for a moment, so the answer isn't lost to a reset
      tooLarge();
      res.once('finish', () => setTimeout(() => req.destroy(), 1000).unref());
    };
    req.on('data', count);
  }
  next();
}

/**
 * uploadLimits, then multer's array(field), as one middleware: a request the
 * limits already answered (too large while streaming) gets no second answer.
 */
function limitedArray(field) {
  const parse = upload.array(field);
  return (req, res, next) => uploadLimits(req, res, (error) => {
    if (error) return next(error);
    parse(req, res, (parseError) => {
      if (req.uploadRejected) return;
      next(parseError);
    });
  });
}

module.exports = upload;
module.exports.MAX_FILE_SIZE = MAX_FILE_SIZE;
module.exports.MAX_UPLOAD_SIZE = MAX_UPLOAD_SIZE;
module.exports.uploadLimits = uploadLimits;
module.exports.limitedArray = limitedArray;
