const PhotoLibrary = require('./PhotoLibrary');
const cipher = require('../crypto/photoCipher');

/**
 * Wraps any PhotoLibrary so files are encrypted before they are stored and
 * decrypted when the server reads them. Files stored before encryption was
 * turned on are read as they are, and encrypted the next time they're written.
 *
 * Browsers get photos through the app's /uploads handler (decrypted on the
 * server), or fetch the stored bytes from rawUrl() and decrypt them
 * themselves with public/js/photoCipher.js.
 */
class EncryptedPhotoLibrary extends PhotoLibrary {
  constructor(inner, keys) {
    super();
    this.inner = inner;
    this.keys = keys;
    this.encrypted = true;
  }

  async seal(buffer) {
    return cipher.encrypt(buffer, await this.keys.currentKey());
  }

  async open(buffer) {
    return cipher.isEncrypted(buffer) ? cipher.decrypt(buffer, id => this.keys.getKey(id)) : buffer;
  }

  listFolder(adminPath) { return this.inner.listFolder(adminPath); }
  createFolder(adminPath) { return this.inner.createFolder(adminPath); }
  renameFolder(adminPath, newName) { return this.inner.renameFolder(adminPath, newName); }
  deleteFolder(adminPath) { return this.inner.deleteFolder(adminPath); }

  async addPhoto(folderAdminPath, photo) {
    return this.inner.addPhoto(folderAdminPath, { ...photo, buffer: await this.seal(photo.buffer) });
  }

  async readPhoto(adminPath) { return this.open(await this.inner.readPhoto(adminPath)); }

  // The app serves decrypted photos at the same /uploads URLs
  photoUrl(adminPath) { return this.inner.photoUrl(adminPath); }

  // Where the stored (encrypted) bytes can be fetched, for browser-side decryption.
  // Only remote storage offers this; local disk is always decrypted on the server,
  // so its key never leaves the server.
  rawUrl(adminPath) { return this.browserDecryption ? this.inner.rawUrl(adminPath) : null; }

  get browserDecryption() { return typeof this.inner.rawUrl === 'function'; }

  // Key for a frame decrypting rawUrl files (the provider limits it to the current tenant)
  getKey(id) { return this.keys.getKey(id); }

  movePhoto(adminPath, toFolderAdminPath) { return this.inner.movePhoto(adminPath, toFolderAdminPath); }
  deletePhoto(adminPath) { return this.inner.deletePhoto(adminPath); }
  stat(adminPath) { return this.inner.stat(adminPath); }
  exists(adminPath) { return this.inner.exists(adminPath); }
  allPhotos() { return this.inner.allPhotos(); }

  async readItem(adminPath) { return this.open(await this.inner.readItem(adminPath)); }
  async writeItem(adminPath, buffer) { return this.inner.writeItem(adminPath, await this.seal(buffer)); }
  listItems(adminPath) { return this.inner.listItems(adminPath); }
}

module.exports = EncryptedPhotoLibrary;
