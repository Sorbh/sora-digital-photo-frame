// Which photos a viewer may see. The admin, and PIN accounts or frames with no
// folders assigned, see everything. An account with assigned folders sees those
// folders and everything inside them; folders above them can be opened to get
// there, but show only what leads to the assigned ones.
const path = require('path');

// Folders are split where the photo storage splits them: on Windows at a
// backslash too, elsewhere a backslash is just part of a name
const SEPARATORS = path.sep === '\\' ? /[\\/]/ : /\//;
const segments = (value) => String(value || '').split(SEPARATORS);

// family/x/../y -> family/y, so ".." can't step out of an assigned folder
const norm = (value) => path.posix.normalize('/' + segments(value).join('/')).replace(/^\/+|\/+$/g, '');

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

// The photo an /uploads request asks for (relative to uploads), or null when it
// can't be decoded or has "." or ".." segments
function photoPath(req) {
  let relativePath;
  try {
    relativePath = decodeURIComponent(req.path);
  } catch {
    return null;
  }
  const parts = segments(relativePath);
  if (parts.some(part => part === '.' || part === '..')) return null;
  return parts.filter(Boolean).join('/');
}

// For /uploads: photos outside the account's folders look like they don't exist.
// The request goes on with the path that was checked in req.photoPath, for
// whatever reads the file (see atPhotoPath).
function requireVisiblePhoto(req, res, next) {
  const relativePath = photoPath(req);
  if (relativePath === null || !canSee(req, relativePath)) {
    return res.status(404).json({ message: 'Not found', code: 'NOT_FOUND' });
  }
  req.photoPath = relativePath;
  return next();
}

// Runs a file reader that goes by the URL (express.static, webpFallback) on the
// path requireVisiblePhoto checked, so it reads that same photo. The URL is put
// back before anything after it runs, such as routes added with beforeRoutes.
function atPhotoPath(reader) {
  return (req, res, next) => {
    const original = req.url;
    const query = original.indexOf('?');
    const folder = req.photoPath && req.path.endsWith('/') ? '/' : ''; // a folder URL keeps its slash
    req.url = '/' + req.photoPath.split('/').map(encodeURIComponent).join('/') + folder
      + (query === -1 ? '' : original.slice(query));
    reader(req, res, (error) => {
      req.url = original;
      next(error);
    });
  };
}

module.exports = { assignedFolders, canSee, canOpen, foldersBelow, photoPath, requireVisiblePhoto, atPhotoPath };
