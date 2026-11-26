// What a signed-in person may do, from the auth provider's scope(req) (see
// middleware/auth). With no provider, or a scope of null, every check here lets
// the request through, so the self-hosted admin sees and changes everything.
const path = require('path');
const { scopeFor } = require('./auth');
const { renderPage } = require('../views/pages');
const { assignedFolders, realVisiblePath } = require('../utils/viewerAccess');
const { resolveAdminPath, UPLOADS_DIR } = require('../utils/safePath');

const MESSAGES = {
  VIEW_ONLY: 'You can look at these photos, but not change them.',
  OWNER_ONLY: 'Only the owner of this library can do this.',
  OUTSIDE_FOLDERS: 'You can only change the folders shared with you.'
};

const refuse = (res, code) => res.status(403).json({ message: MESSAGES[code], code });

// Changes: refused for people who can only view
function requireEditor(req, res, next) {
  const scope = scopeFor(req);
  if (scope && !scope.canEdit) return refuse(res, 'VIEW_ONLY');
  return next();
}

// Access (PINs, frames, family code), pairing and the Google Photos connection
function requireOwner(req, res, next) {
  const scope = scopeFor(req);
  if (scope && !scope.isOwner) return refuse(res, 'OWNER_ONLY');
  return next();
}

// The same for a page: a short page that says so, in the person's language
function requireOwnerPage(req, res, next) {
  const scope = scopeFor(req);
  if (scope && !scope.isOwner) {
    return res.status(403).type('html').send(renderPage('owner-only.html'));
  }
  return next();
}

// A path inside uploads/ as the admin pages send it ("uploads/Family/x.jpg"),
// relative to uploads ("Family/x.jpg"); null when it isn't one
function relativeToUploads(adminPath, allowRoot) {
  const fullPath = resolveAdminPath(adminPath, { allowRoot });
  return fullPath ? path.relative(UPLOADS_DIR, fullPath) : null;
}

// Inside one of the person's folders, also where a symlink really leads. below:
// strictly inside, so one of their own folders can't be deleted.
async function inside(req, adminPath, { allowRoot = false, below = false } = {}) {
  const relative = relativeToUploads(adminPath, allowRoot);
  if (relative === null) return false;
  if (await realVisiblePath(req, relative) === null) return false;
  if (!below) return true;
  const folders = assignedFolders(req) || [];
  const target = relative.split(path.sep).join('/');
  return !folders.includes(target);
}

/**
 * Writes into folders: every admin path pick(req) gives must be inside one of
 * the person's folders, else 403 OUTSIDE_FOLDERS. pick returns a path or a list;
 * an empty list leaves it to the route (which refuses a missing path itself).
 */
function writeInFolders(pick, options = {}) {
  return async (req, res, next) => {
    try {
      if (!assignedFolders(req)) return next();
      for (const adminPath of [].concat(pick(req) ?? [])) {
        if (!await inside(req, adminPath, options)) return refuse(res, 'OUTSIDE_FOLDERS');
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

/**
 * Reads: anything outside the person's folders looks like it doesn't exist (404),
 * as photos outside a PIN frame's folders do.
 */
function readInFolders(pick) {
  return async (req, res, next) => {
    try {
      if (!assignedFolders(req)) return next();
      for (const adminPath of [].concat(pick(req) ?? [])) {
        if (!await inside(req, adminPath)) return res.status(404).json({ message: 'Not found', code: 'NOT_FOUND' });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

// Photos a snap or note names, as admin paths ("uploads/" is optional in the request)
const photoRefs = (photos) => (Array.isArray(photos) ? photos : [])
  .map(photo => (typeof photo === 'string' ? `uploads/${photo.replace(/^\/?uploads\//, '')}` : ''));

module.exports = { requireEditor, requireOwner, requireOwnerPage, writeInFolders, readInFolders, photoRefs, MESSAGES };
