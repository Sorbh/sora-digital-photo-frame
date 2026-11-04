const path = require('path');
const { getLibrary } = require('../library');
const { toAdminPath } = require('../utils/safePath');

const { UPLOADS_DIR } = require('../config/paths');
const notes = require('./noteService');

const SNAP_EXT = '.snap.json';
const SNAP_PATTERN = /\.snap\.json$/i;

/**
 * Snaps are memory-book pages (the same layouts as notes) saved as a small
 * "name.snap.json" file inside a folder. They sit next to the photos and the
 * slideshow plays them like any other picture; the frame draws them live,
 * so they stay sharp on any screen and can be edited later.
 */
class SnapService {
  isSnap(fileName) {
    return SNAP_PATTERN.test(fileName);
  }

  // A full path inside uploads, or null if it escapes it or isn't a snap file
  resolve(relativePath) {
    if (typeof relativePath !== 'string' || !this.isSnap(relativePath)) return null;
    const resolved = path.resolve(UPLOADS_DIR, relativePath);
    return resolved.startsWith(UPLOADS_DIR + path.sep) ? resolved : null;
  }

  async read(fullPath) {
    const data = JSON.parse((await getLibrary().readItem(toAdminPath(fullPath))).toString('utf8'));
    return data && typeof data === 'object' ? data : null;
  }

  // Snap plus photo URLs, for the admin grid and editor
  async load(fullPath) {
    const snap = await this.read(fullPath);
    return { ...snap, photoUrls: notes.photoUrls(snap.photos || []) };
  }

  // The page a frame shows, with photos limited to what this frame may see
  async forFrame(fullPath, session = {}) {
    const snap = await this.read(fullPath);
    const photos = await notes.visiblePhotos(snap.photos || [], session);
    return {
      title: snap.title,
      message: snap.message,
      signoff: snap.signoff,
      eyebrow: snap.eyebrow,
      theme: snap.theme,
      layout: snap.layout || 'auto',
      photos: notes.photoUrls(photos)
    };
  }

  async validate(input = {}) {
    const errors = {};
    const snap = await notes.validatePage(input, errors);
    return Object.keys(errors).length ? { errors } : { snap };
  }

  /**
   * Save a new snap in folderPath (absolute). The file is named after the
   * headline and never overwrites an existing file.
   */
  async create(folderPath, input) {
    const { snap, errors } = await this.validate(input);
    if (errors) return { errors };

    const base = this.slug(snap.title);
    let target = path.join(folderPath, base + SNAP_EXT);
    for (let n = 2; await getLibrary().exists(toAdminPath(target)); n++) {
      target = path.join(folderPath, `${base}-${n}${SNAP_EXT}`);
    }

    const now = new Date().toISOString();
    const saved = { version: 1, ...snap, createdAt: now, updatedAt: now };
    await this.write(target, saved);
    return { snap: saved, fullPath: target };
  }

  async update(fullPath, input) {
    const current = await this.read(fullPath);
    const { snap, errors } = await this.validate({ ...current, ...input });
    if (errors) return { errors };

    const saved = { ...current, ...snap, updatedAt: new Date().toISOString() };
    await this.write(fullPath, saved);
    return { snap: saved, fullPath };
  }

  async write(fullPath, snap) {
    await getLibrary().writeItem(toAdminPath(fullPath), Buffer.from(JSON.stringify(snap, null, 2)));
  }

  slug(title) {
    const slug = title.toLowerCase()
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '');
    return slug || 'snap';
  }

  // Every snap file under dir
  async findAll(dir = UPLOADS_DIR) {
    const found = [];
    const items = (await getLibrary().listItems(toAdminPath(dir)).catch(() => []))
      .map(item => ({ name: item.name, isDirectory: () => item.isFolder, isFile: () => !item.isFolder }));
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) found.push(...await this.findAll(fullPath));
      else if (item.isFile() && this.isSnap(item.name)) found.push(fullPath);
    }
    return found;
  }

  /**
   * A photo moved (paths relative to uploads): point every snap that uses
   * it at the new place, so moving photos never breaks a snap.
   */
  async photoMoved(from, to) {
    for (const fullPath of await this.findAll()) {
      try {
        const snap = await this.read(fullPath);
        if (!snap.photos?.includes(from)) continue;
        snap.photos = snap.photos.map(p => (p === from ? to : p));
        await this.write(fullPath, snap);
      } catch (error) {
        console.error('Could not update snap after a move:', fullPath, error.message);
      }
    }
  }
}

module.exports = new SnapService();
module.exports.SNAP_EXT = SNAP_EXT;
module.exports.SNAP_PATTERN = SNAP_PATTERN;
