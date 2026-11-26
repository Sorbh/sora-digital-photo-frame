const { errorSummary } = require('../utils/errorSummary');

// Errors from express.json()/urlencoded() (body-parser). A parse or verify failure
// holds the raw body, and its message can quote it.
const BODY_PARSER_ERRORS = new Set([
  'entity.parse.failed', 'entity.verify.failed', 'entity.too.large', 'encoding.unsupported',
  'charset.unsupported', 'parameters.too.many', 'request.aborted', 'request.size.invalid',
  'stream.encoding.set', 'stream.not.readable'
]);
const UNREADABLE_BODY = new Set(['entity.parse.failed', 'entity.verify.failed']);

const isBodyParserError = err => typeof err.type === 'string' && BODY_PARSER_ERRORS.has(err.type) &&
  Number.isInteger(err.status) && err.status >= 400 && err.status < 500;

// Only what helps find the bug without private data (see utils/errorSummary)
function logError(err) {
  if (err && typeof err === 'object' && isBodyParserError(err)) {
    return console.error(`Error: request body could not be read (${err.type}, ${err.status})`);
  }
  console.error(`Error: request failed: ${errorSummary(err)}`);
}

// Global error handling middleware
const errorHandler = (err, req, res, next) => {
  logError(err);

  // A body that could not be read: answer without echoing it back
  if (isBodyParserError(err) && UNREADABLE_BODY.has(err.type)) {
    return res.status(err.status).json({ message: 'Invalid request body.' });
  }

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

  // Default error response. A client error's message is meant for the user;
  // a server error's could say anything, so it gets a generic one.
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  const message = status < 500 && err.expose !== false && err.message ? err.message : 'Internal server error';

  res.status(status).json({
    message: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

module.exports = errorHandler;
module.exports.isBodyParserError = isBodyParserError;