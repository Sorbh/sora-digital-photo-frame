const path = require('path');
const { SERVER_DIR, UPLOADS_DIR } = require('../config/paths');

// The admin UI addresses folders as "uploads/Family/..." regardless of where
// the photos are actually stored, so "uploads" is a virtual root.
const ADMIN_ROOT = path.join(SERVER_DIR, 'uploads');

/**
 * Resolve an admin-supplied path such as "uploads/Family/x.jpg" and make sure
 * it stays inside the uploads folder.
 *
 * Returns the absolute path, or null when the input is missing or escapes
 * uploads/ (e.g. "../server.js"). The uploads root itself is only accepted
 * with allowRoot, so it can be listed or uploaded into but never deleted.
 */
function resolveAdminPath(relativePath, { allowRoot = false } = {}) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return null;

  const resolved = path.resolve(SERVER_DIR, relativePath);
  if (resolved === ADMIN_ROOT) return allowRoot ? UPLOADS_DIR : null;
  if (!resolved.startsWith(ADMIN_ROOT + path.sep)) return null;
  return path.join(UPLOADS_DIR, path.relative(ADMIN_ROOT, resolved));
}

/**
 * The admin-facing path ("uploads/...") for an absolute path inside uploads.
 */
function toAdminPath(fullPath) {
  return path.join('uploads', path.relative(UPLOADS_DIR, fullPath));
}

module.exports = { resolveAdminPath, toAdminPath, UPLOADS_DIR };
