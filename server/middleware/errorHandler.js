// Global error handling middleware
const errorHandler = (err, req, res, next) => {
  console.error('Error:', err);

  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    const size = Math.round(require('./upload').MAX_FILE_SIZE / (1024 * 1024));
    return res.status(400).json({
      code: 'FILE_TOO_LARGE',
      size,
      message: `File size too large. Maximum size is ${size}MB.`
    });
  }

  if (err.code === 'UNSUPPORTED_TYPE') {
    return res.status(400).json({ code: err.code, message: err.message });
  }

  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({
      message: 'Too many files uploaded at once.'
    });
  }

  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({
      message: 'Unexpected file field.'
    });
  }

  // Custom multer file type error
  if (err.message && err.message.includes('Invalid file type')) {
    return res.status(400).json({
      message: err.message
    });
  }

  // File system errors
  if (err.code === 'ENOENT') {
    return res.status(404).json({
      message: 'File or directory not found.'
    });
  }

  if (err.code === 'EACCES') {
    return res.status(403).json({
      message: 'Permission denied.'
    });
  }

  // Default error response
  const status = err.status || 500;
  const message = err.message || 'Internal server error';

  res.status(status).json({
    message: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

module.exports = errorHandler;