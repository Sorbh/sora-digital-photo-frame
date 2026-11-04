/**
 * Storage contract. Paths are always admin paths such as uploads/Family/a.jpg.
 * listFolder returns { folders, photos }; entries have name and path, and
 * photos also have type ('image', 'snap', 'item'), size, mtime and mtimeMs.
 * allPhotos returns image and snap entries from the whole library.
 * stat returns { size, mtime, mtimeMs, isFolder } or null for missing paths.
 * The uploads root may be listed and receive photos, but cannot be deleted.
 */
class PhotoLibrary {
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

  // Snaps and folder settings live beside photos in the uploads tree.
  // readItem/writeItem transfer their raw bytes; listItems also marks folders.
  async readItem(adminPath) { throw new Error('not implemented'); }
  async writeItem(adminPath, buffer) { throw new Error('not implemented'); }
  async listItems(adminPath) { throw new Error('not implemented'); }
}

module.exports = PhotoLibrary;
