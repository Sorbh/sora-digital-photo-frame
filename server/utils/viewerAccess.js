// Which photos a viewer may see. The admin, and PIN accounts or frames with no
// folders assigned, see everything. An account with assigned folders sees those
// folders and everything inside them; folders above them can be opened to get
// there, but show only what leads to the assigned ones.
const path = require('path');
const { getLibrary } = require('../library');

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

// A photo (relative to uploads) in this folder or one inside it. Either may use
// "/"; on Windows (sep "\\") either may use "\\" too, as path.relative writes it.
// An empty folder name is in no photo's path, so it matches none.
function inFolder(relativePath, folder, sep = path.sep) {
  const split = (value) => String(value || '').split(sep === '\\' ? /[\\/]/ : /\//).filter(Boolean);
  const want = split(folder);
  const have = split(relativePath).slice(0, -1);
  return want.length > 0 && have.length >= want.length && want.every((part, i) => part === have[i]);
}

// What a path (relative to uploads) really reads once symlinks are followed,
// "/"-separated, when the viewer may see it there as well as where it was asked
// for; null when it can't be seen, or leads out of the library. check is canSee,
// or canOpen for a folder. Libraries without realPath are taken as they are.
async function realVisiblePath(req, relativePath, check = canSee) {
  if (!check(req, relativePath)) return null;
  const library = getLibrary();
  if (typeof library.realPath !== 'function') return relativePath;
  let real;
  try {
    real = await library.realPath(relativePath ? `uploads/${relativePath}` : 'uploads');
  } catch {
    return null;
  }
  if (typeof real !== 'string') return null;
  const realRelative = segments(real).filter(Boolean).slice(1).join('/');
  return check(req, realRelative) ? realRelative : null;
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

// The request ends in a slash, plain or encoded (%2F): a folder, never a photo
function isFolderUrl(req) {
  try {
    return SEPARATORS.test(decodeURIComponent(req.path).slice(-1));
  } catch {
    return false;
  }
}

// For /uploads: photos outside the account's folders look like they don't exist,
// also when a symlink leads there (or out of the library). The request goes on
// with the real path that was checked in req.photoPath, for whatever reads the
// file (see atPhotoPath).
async function requireVisiblePhoto(req, res, next) {
  try {
    const relativePath = photoPath(req);
    const real = relativePath === null ? null : await realVisiblePath(req, relativePath);
    if (real === null) {
      return res.status(404).json({ message: 'Not found', code: 'NOT_FOUND' });
    }
    req.photoPath = real;
    return next();
  } catch (error) {
    return next(error);
  }
}

// Runs a file reader that goes by the URL (express.static, webpFallback) on the
// path requireVisiblePhoto checked, so it reads that same photo. The URL is put
// back before anything after it runs, such as routes added with beforeRoutes.
function atPhotoPath(reader) {
  return (req, res, next) => {
    const original = req.url;
    const query = original.indexOf('?');
    // A folder URL keeps its slash, so express.static passes it on as before
    const folder = req.photoPath && isFolderUrl(req) ? '/' : '';
    req.url = '/' + req.photoPath.split('/').map(encodeURIComponent).join('/') + folder
      + (query === -1 ? '' : original.slice(query));
    reader(req, res, (error) => {
      req.url = original;
      next(error);
    });
  };
}

module.exports = { assignedFolders, canSee, canOpen, foldersBelow, inFolder, realVisiblePath, photoPath, isFolderUrl, requireVisiblePhoto, atPhotoPath };
