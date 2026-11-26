const path = require('path');
const fs = require('fs-extra');
const PhotoLibrary = require('./PhotoLibrary');
const { resolveAdminPath, toAdminPath, uploadsUrl, UPLOADS_DIR } = require('../utils/safePath');
const { folderNotFoundError } = require('../utils/httpError');

const IMAGE_PATTERN = /\.(jpg|jpeg|png|gif|webp)$/i;
const SNAP_PATTERN = /\.snap\.json$/i;
const NOTE_PATTERN = /\.note\.json$/i;
// Snaps and notes keep their double extension when a name is made free
const PAGE_EXT = /\.(snap|note)\.json$/i;
const typeOf = (name) => SNAP_PATTERN.test(name) ? 'snap' : NOTE_PATTERN.test(name) ? 'note' : IMAGE_PATTERN.test(name) ? 'image' : 'item';

const isFolder = (dir) => fs.stat(dir).then(stat => stat.isDirectory(), () => false);

// A write into dir failed: FOLDER_NOT_FOUND when that's because the folder is
// gone, so the caller can say so; any other error as it was
async function folderGoneOr(dir, error) {
  if (['ENOENT', 'ENOTDIR'].includes(error.code) && !await isFolder(dir)) throw folderNotFoundError();
  throw error;
}

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
        // A temp file can be renamed away between readdir and stat; skip it
        const stat = await fs.stat(full).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!stat) continue;
        photos.push({ ...entry, size: stat.size, mtime: stat.mtime, mtimeMs: stat.mtimeMs,
          type: typeOf(item.name) });
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

  // Saves into a folder that exists: a missing one (deleted meanwhile, even while
  // this was writing) is FOLDER_NOT_FOUND, never made again. Writing a file never
  // creates the folders above it.
  async addPhoto(folderAdminPath, { buffer, originalName, contentType }) {
    const dir = this.resolve(folderAdminPath, true);
    const name = path.basename(originalName);
    const target = this.resolve(path.join(folderAdminPath, name));
    await fs.writeFile(target, buffer).catch(error => folderGoneOr(dir, error));
    return { name, path: this.admin(target), size: buffer.length, contentType };
  }

  async readPhoto(adminPath) { return fs.readFile(this.resolve(adminPath)); }
  // Each folder and file name percent-encoded, so a name with a backslash
  // (allowed on Linux) isn't read by the browser as a separator
  photoUrl(adminPath) {
    this.resolve(adminPath);
    return uploadsUrl(adminPath);
  }

  // Into a folder that exists (fs-extra's move would make a missing one again)
  async movePhoto(adminPath, toFolderAdminPath) {
    const source = this.resolve(adminPath);
    const dest = this.resolve(toFolderAdminPath, true);
    if (!await isFolder(dest)) throw folderNotFoundError();
    const ext = source.match(PAGE_EXT)?.[0] || path.extname(source);
    const base = path.basename(source, ext);
    let target = path.join(dest, base + ext);
    for (let n = 1; await fs.pathExists(target); n++) target = path.join(dest, `${base}-${n}${ext}`);
    try {
      await fs.rename(source, target);
    } catch (error) {
      if (error.code !== 'EXDEV') return folderGoneOr(dest, error);
      // Another disk (a mounted folder): copy, then remove the original
      await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL).catch(copyError => folderGoneOr(dest, copyError));
      await fs.remove(source);
    }
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

  // Where a path really is, following symlinks: its admin path, or null when it
  // leads out of the library. Parts that don't exist yet are kept as given,
  // below the real place of the part that does.
  async realPath(adminPath) {
    const full = this.resolve(adminPath, true);
    const root = await fs.realpath(this.staticDir);
    const missing = [];
    let existing = full;
    let real;
    for (;;) {
      try {
        real = await fs.realpath(existing);
        break;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code) || existing === this.staticDir) throw error;
        missing.unshift(path.basename(existing));
        existing = path.dirname(existing);
      }
    }
    const resolved = path.join(real, ...missing);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    return this.admin(path.join(this.staticDir, path.relative(root, resolved)));
  }

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
  // Like addPhoto, only into a folder that exists
  async writeItem(adminPath, buffer) {
    const full = this.resolve(adminPath);
    const tmp = `${full}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tmp, buffer);
      await fs.rename(tmp, full);
    } catch (error) {
      await fs.remove(tmp).catch(() => {});
      await folderGoneOr(path.dirname(full), error);
    }
  }
  async listItems(adminPath) {
    const { folders, photos } = await this.listFolder(adminPath);
    return [...folders.map(f => ({ ...f, isFolder: true })), ...photos.map(p => ({ ...p, isFolder: false }))];
  }
}

module.exports = LocalPhotoLibrary;
