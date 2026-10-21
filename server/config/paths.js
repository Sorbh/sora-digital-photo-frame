const path = require('path');

const SERVER_DIR = path.join(__dirname, '..');

// Where photos live. UPLOAD_DIR (relative to server/ or absolute) lets tests and
// deployments point the app at another folder; defaults to server/uploads.
const UPLOADS_DIR = path.resolve(SERVER_DIR, process.env.UPLOAD_DIR || 'uploads');

// Generated, disposable files (thumbnails). Safe to delete at any time.
const CACHE_DIR = path.resolve(SERVER_DIR, process.env.CACHE_DIR || 'cache');

module.exports = { SERVER_DIR, UPLOADS_DIR, CACHE_DIR };
