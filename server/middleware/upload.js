const path = require('path');
const multer = require('multer');
// Multer configuration for file uploads. Files stay in memory (never in plain
// text on disk), so the number per request is capped; the admin page sends
// larger selections in batches.
const storage = multer.memoryStorage();

// Originals are only read once: the stored copy is resized to the frame size,
// so a large limit costs no storage. 25 MB fits 48 MP phone photos.
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 25 * 1024 * 1024;

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif'];
// Some browsers send HEIC files without a type
const HEIC_NAME = /\.(heic|heif)$/i;
const UNTYPED = ['', 'application/octet-stream'];

const upload = multer({
  storage: storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 10 // uploadInBatches in public/admin.js sends this many at a time
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

module.exports = upload;
module.exports.MAX_FILE_SIZE = MAX_FILE_SIZE;
