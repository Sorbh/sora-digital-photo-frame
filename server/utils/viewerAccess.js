// Which photos a viewer may see. The admin, and PIN accounts or frames with no
// folders assigned, see everything. An account with assigned folders sees those
// folders and everything inside them; folders above them can be opened to get
// there, but show only what leads to the assigned ones.
const path = require('path');

// family\\x/../y -> family/y, so ".." can't step out of an assigned folder
const norm = (value) => path.posix.normalize('/' + String(value || '').replace(/\\/g, '/')).replace(/^\/+|\/+$/g, '');

// The assigned folders, or null for no limit
function assignedFolders(req) {
  const session = req.session;
  if (!session || session.authenticated) return null;
  const folders = session.accessAccount?.assignedFolders;
  return Array.isArray(folders) && folders.length ? folders.map(norm).filter(Boolean) : null;
}

// A photo or folder (relative to uploads) inside an assigned folder
function canSee(req, relativePath) {
  const folders = assignedFolders(req);
  if (!folders) return true;
  const target = norm(relativePath);
  return folders.some(folder => target === folder || target.startsWith(folder + '/'));
}

// The assigned folders below this one, when it's only a way to reach them
function foldersBelow(req, relativePath) {
  const folders = assignedFolders(req) || [];
  const target = norm(relativePath);
  // family and family/kids both assigned: family/kids is already inside family
  const outermost = folders.filter(folder => !folders.some(other => other !== folder && folder.startsWith(other + '/')));
  return [...new Set(outermost)].filter(folder => target === '' || folder.startsWith(target + '/'));
}

// A folder that can be opened: inside an assigned one, or on the way to one
function canOpen(req, relativePath) {
  return canSee(req, relativePath) || foldersBelow(req, relativePath).length > 0;
}

// For /uploads: photos outside the account's folders look like they don't exist
function requireVisiblePhoto(req, res, next) {
  let relativePath;
  try {
    relativePath = decodeURIComponent(req.path);
  } catch {
    return res.status(400).end();
  }
  if (canSee(req, relativePath)) return next();
  return res.status(404).json({ message: 'Not found', code: 'NOT_FOUND' });
}

module.exports = { assignedFolders, canSee, canOpen, foldersBelow, requireVisiblePhoto };
