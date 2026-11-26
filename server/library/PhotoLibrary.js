/**
 * Storage contract. Paths are always admin paths such as uploads/Family/a.jpg.
 * listFolder returns { folders, photos }; entries have name and path, and
 * photos also have type ('image', 'snap', 'note', 'item'), size, mtime and mtimeMs.
 * allPhotos returns image and snap entries from the whole library, never notes
 * (*.note.json): notes are not photos.
 * movePhoto also moves snaps and notes, keeping their .snap.json or .note.json
 * ending when it makes a name free (a-1.note.json, not a.note-1.json).
 * stat returns { size, mtime, mtimeMs, isFolder } or null for missing paths.
 * The uploads root may be listed and receive photos, but cannot be deleted.
 * photoUrl returns the address a browser loads the photo from, with each path
 * segment percent-encoded (folder and file names can hold # ? % and spaces):
 * PhotoLibrary.uploadsUrl(adminPath) builds that for the /uploads route.
 *
 * Only createFolder makes folders. addPhoto, movePhoto and writeItem save into
 * a folder that exists; when it doesn't (deleted meanwhile, even while saving)
 * they throw PhotoLibrary.folderNotFoundError() (404 FOLDER_NOT_FOUND) and
 * leave it deleted.
 *
 * realPath (optional) is for storage with symlinks: where a path really is, as
 * an admin path, or null when it leads out of the library. Without it, paths
 * are taken as they are.
 */
const { uploadsUrl } = require('../utils/safePath');
const { folderNotFoundError } = require('../utils/httpError');

class PhotoLibrary {
  static uploadsUrl(adminPath) { return uploadsUrl(adminPath); }
  static folderNotFoundError() { return folderNotFoundError(); }

  async listFolder(adminPath) { throw new Error('not implemented'); }
  async createFolder(adminPath) { throw new Error('not implemented'); }
  async renameFolder(adminPath, newName) { throw new Error('not implemented'); }
  async deleteFolder(adminPath) { throw new Error('not implemented'); }
  async addPhoto(folderAdminPath, { buffer, originalName, contentType }) { throw new Error('not implemented'); }
  async readPhoto(adminPath) { throw new Error('not implemented'); }
  photoUrl(adminPath) { throw new Error('not implemented'); }
  async movePhoto(adminPath, toFolderAdminPath) { throw new Error('not implemented'); }
  async deletePhoto(adminPath) { throw new Error('not implemented'); }
  async stat(adminPath) { throw new Error('not implemented'); }
  async exists(adminPath) { throw new Error('not implemented'); }
  async allPhotos() { throw new Error('not implemented'); }

  // Snaps, notes and folder settings live beside photos in the uploads tree.
  // readItem/writeItem transfer their raw bytes; listItems also marks folders.
  async readItem(adminPath) { throw new Error('not implemented'); }
  async writeItem(adminPath, buffer) { throw new Error('not implemented'); }
  async listItems(adminPath) { throw new Error('not implemented'); }
}

module.exports = PhotoLibrary;
