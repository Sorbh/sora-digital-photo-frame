const path = require('path');
const { UPLOADS_DIR } = require('../config/paths');
const { getLibrary } = require('../library');
const { toAdminPath, resolveAdminPath } = require('./safePath');

// MAX_FOLDER_DEPTH: how many folder levels the library may have below its root.
// uploads = 0, uploads/Trips = 1, uploads/Trips/Italy = 2. Unset or 0: no limit.
// It only stops new folders: deeper folders that already exist keep working.
let maxDepth = null;

// A positive whole number, or null (no limit). Anything else is ignored with a warning.
function parseMaxFolderDepth(value) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (text === '') return null;
  if (/^\d+$/.test(text)) return Number(text) || null;
  console.warn(`⚠️  MAX_FOLDER_DEPTH=${JSON.stringify(value)} is not a positive whole number, so folders have no depth limit.`);
  return null;
}

// Read at start (createApp); tests can set it again
function setMaxFolderDepth(value = process.env.MAX_FOLDER_DEPTH) {
  maxDepth = parseMaxFolderDepth(value);
  return maxDepth;
}

const maxFolderDepth = () => maxDepth;

// Levels below the library root for an absolute path inside uploads (root = 0).
// "/" separates folders everywhere; on Windows "\\" does too (as in safePath.uploadsUrl).
function folderDepth(fullPath) {
  const relative = path.relative(UPLOADS_DIR, fullPath);
  if (!relative) return 0;
  const segments = path.sep === '/' ? relative.split('/') : relative.split(/[\\/]/);
  return segments.filter(Boolean).length;
}

// Whether a new folder may be made at this absolute path, counted as written
const allowsFolderAt = (fullPath) => maxDepth === null || folderDepth(fullPath) <= maxDepth;

// Whether a new folder may be made inside this one, counted as written
const allowsFolderIn = (parentFullPath) => maxDepth === null || folderDepth(parentFullPath) < maxDepth;

// The depth where a path really is: a symlinked folder (uploads/Italy pointing at
// uploads/Trips/Italy) counts where it points, as the library resolves it. As
// written when the library has no symlinks to follow, or the link leads out of it.
async function realFolderDepth(fullPath) {
  const library = getLibrary();
  if (typeof library.realPath === 'function') {
    const real = await library.realPath(toAdminPath(fullPath)).catch(() => null);
    const realFull = real && resolveAdminPath(real, { allowRoot: true });
    if (realFull) return folderDepth(realFull);
  }
  return folderDepth(fullPath);
}

// allowsFolderAt and allowsFolderIn, with symlinks followed: use these to make folders
const canMakeFolderAt = async (fullPath) => maxDepth === null || await realFolderDepth(fullPath) <= maxDepth;
const canMakeFolderIn = async (parentFullPath) => maxDepth === null || await realFolderDepth(parentFullPath) < maxDepth;

// The client error for a folder past the limit (answered by utils/httpError)
function folderTooDeepError() {
  const error = new Error(`Folders can be at most ${maxDepth} levels deep`);
  error.status = 400;
  error.code = 'FOLDER_TOO_DEEP';
  error.vars = { limit: maxDepth };
  return error;
}

// For an import into a folder it may have to make (Google Photos): throws
// FOLDER_TOO_DEEP when that folder would be past the limit. Folders that
// already exist, however deep, can still be added to.
async function assertFolderAllowed(fullPath) {
  if (await canMakeFolderAt(fullPath)) return;
  const stat = await getLibrary().stat(toAdminPath(fullPath)).catch(() => null);
  if (stat?.isFolder) return;
  throw folderTooDeepError();
}

module.exports = { parseMaxFolderDepth, setMaxFolderDepth, maxFolderDepth, folderDepth, allowsFolderAt, allowsFolderIn, realFolderDepth, canMakeFolderAt, canMakeFolderIn, folderTooDeepError, assertFolderAllowed };
