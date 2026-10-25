const path = require('path');
const fs = require('fs-extra');
const PhotoLibrary = require('./PhotoLibrary');
const { resolveAdminPath, toAdminPath, UPLOADS_DIR } = require('../utils/safePath');

const IMAGE_PATTERN = /\.(jpg|jpeg|png|gif|webp)$/i;
const SNAP_PATTERN = /\.snap\.json$/i;

class LocalPhotoLibrary extends PhotoLibrary {
  constructor(root = UPLOADS_DIR) {
    super();
    this.staticDir = path.resolve(root);
  }

  resolve(adminPath, allowRoot = false) {
    const safe = resolveAdminPath(adminPath, { allowRoot });
    if (!safe) throw new Error('Invalid library path');
    return path.join(this.staticDir, path.relative(UPLOADS_DIR, safe));
  }

  admin(fullPath) {
    return toAdminPath(path.join(UPLOADS_DIR, path.relative(this.staticDir, fullPath)));
  }

  async listFolder(adminPath) {
    const dir = this.resolve(adminPath, true);
    const items = await fs.readdir(dir, { withFileTypes: true });
    const folders = [];
    const photos = [];
    for (const item of items) {
      const full = path.join(dir, item.name);
      const entry = { name: item.name, path: this.admin(full) };
      if (item.isDirectory()) folders.push(entry);
      else if (item.isFile()) {
        const stat = await fs.stat(full);
        photos.push({ ...entry, size: stat.size, mtime: stat.mtime, mtimeMs: stat.mtimeMs,
          type: SNAP_PATTERN.test(item.name) ? 'snap' : IMAGE_PATTERN.test(item.name) ? 'image' : 'item' });
      }
    }
    return { folders, photos };
  }

  async createFolder(adminPath) {
    const full = this.resolve(adminPath, true);
    await fs.ensureDir(full);
    return { path: adminPath };
  }

  async renameFolder(adminPath, newName) {
    const full = this.resolve(adminPath);
    if (typeof newName !== 'string' || !newName.trim() || /[\\/]/.test(newName) || newName.trim().startsWith('.')) throw new Error('Invalid folder name');
    const target = path.join(path.dirname(full), newName.trim());
    await fs.move(full, target);
    return { path: this.admin(target) };
  }

  async deleteFolder(adminPath) { await fs.remove(this.resolve(adminPath)); }

  async addPhoto(folderAdminPath, { buffer, originalName, contentType }) {
    const dir = this.resolve(folderAdminPath, true);
    const name = path.basename(originalName);
    const target = this.resolve(path.join(folderAdminPath, name));
    await fs.ensureDir(dir);
    await fs.writeFile(target, buffer);
    return { name, path: this.admin(target), size: buffer.length, contentType };
  }

  async readPhoto(adminPath) { return fs.readFile(this.resolve(adminPath)); }
  photoUrl(adminPath) {
    this.resolve(adminPath);
    return `/${adminPath}`;
  }

  async movePhoto(adminPath, toFolderAdminPath) {
    const source = this.resolve(adminPath);
    const dest = this.resolve(toFolderAdminPath, true);
    const ext = SNAP_PATTERN.test(source) ? '.snap.json' : path.extname(source);
    const base = path.basename(source, ext);
    let target = path.join(dest, base + ext);
    for (let n = 1; await fs.pathExists(target); n++) target = path.join(dest, `${base}-${n}${ext}`);
    await fs.move(source, target);
    return { path: this.admin(target) };
  }

  async deletePhoto(adminPath) { await fs.remove(this.resolve(adminPath)); }
  async stat(adminPath) {
    let full;
    try { full = this.resolve(adminPath, true); } catch { return null; }
    const stat = await fs.stat(full).catch(() => null);
    return stat && { size: stat.size, mtime: stat.mtime, mtimeMs: stat.mtimeMs, isFolder: stat.isDirectory() };
  }
  async exists(adminPath) { return Boolean(await this.stat(adminPath)); }

  async allPhotos() {
    const found = [];
    const visit = async (dir) => {
      const { folders, photos } = await this.listFolder(dir);
      found.push(...photos.filter(p => p.type === 'image' || p.type === 'snap'));
      for (const folder of folders) if (!folder.name.startsWith('.')) await visit(folder.path);
    };
    await visit('uploads');
    return found;
  }

  async readItem(adminPath) { return fs.readFile(this.resolve(adminPath)); }
  async writeItem(adminPath, buffer) {
    const full = this.resolve(adminPath);
    const tmp = `${full}.${process.pid}.tmp`;
    await fs.writeFile(tmp, buffer);
    await fs.move(tmp, full, { overwrite: true });
  }
  async listItems(adminPath) {
    const { folders, photos } = await this.listFolder(adminPath);
    return [...folders.map(f => ({ ...f, isFolder: true })), ...photos.map(p => ({ ...p, isFolder: false }))];
  }
}

module.exports = LocalPhotoLibrary;
