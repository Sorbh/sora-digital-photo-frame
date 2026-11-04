const multer = require('multer');
// Multer configuration for file uploads. Files stay in memory (never in plain
// text on disk), so the number per request is capped; the admin page sends
// larger selections in batches.
const storage = multer.memoryStorage();

const upload = multer({
  storage: storage,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024, // Default 10MB
    files: parseInt(process.env.MAX_FILES_PER_UPLOAD) || 10
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.'));
    }
  }
});

module.exports = upload;
