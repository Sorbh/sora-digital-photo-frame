const path = require('path');
const crypto = require('crypto');
const { UPLOADS_DIR } = require('../config/paths');
const thumbnails = require('./thumbnailService');
const { getLibrary } = require('../library');
const { getDataStore } = require('../store');
const { addWithinQuota, ITEMS } = require('./quotaService');
const { canSee, inFolder } = require('../utils/viewerAccess');
const { toAdminPath, uploadsUrl } = require('../utils/safePath');

const THEMES = ['paper', 'berry', 'ink'];
// Book layouts and the photos each needs (mirrors NotePage.templates in public/js/notePage.js)
const LAYOUTS = { auto: 0, cover: 1, quote: 2, remember: 3, stack: 3, collage: 4, spine: 4, gallery: 4 };
const LIMITS = {
  title: 60,
  message: 160,
  signoff: 40,
  eyebrow: 40,
  photos: 4
};
// A note about an event stays up this long after it starts, unless endsAt says otherwise
const EVENT_GRACE_MS = 2 * 60 * 60 * 1000;

const NOTE_EXT = '.note.json';
const NOTE_PATTERN = /\.note\.json$/i;

// Where notes were kept before they moved into folders (one document for the library)
const OLD_STORE = 'notes';
const OLD_STORE_BACKUP = 'notes-before-folders';

// The folder of a path relative to uploads, "/"-separated: '' for the top folder
const folderOf = (relativePath) => String(relativePath).split(/[\\/]/).filter(Boolean).slice(0, -1).join('/');

/**
 * Notes are short messages ("Priya is visiting on Monday") that the
 * slideshow shows as a memory-book page every few minutes, inside a date
 * window. Each is a "name.note.json" file in a library folder, like snaps,
 * so moving, renaming or deleting a folder takes its notes along.
 *
 * Notes in the top folder show on every frame. A note in a folder shows on
 * the frames that may see that folder. Notes are never photos: they are not
 * played, counted or listed with them.
 */
class NoteService {
  isNote(fileName) {
    return NOTE_PATTERN.test(fileName);
  }

  // A note's path relative to uploads, "/"-separated ("Family/visit.note.json")
  relative(fullPath) {
    return path.relative(UPLOADS_DIR, fullPath).split(path.sep).join('/');
  }

  async read(fullPath) {
    const data = JSON.parse((await getLibrary().readItem(toAdminPath(fullPath))).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Not a note');
    return data;
  }

  // A new note is 1 item, like a snap; saving one again only asks for its growth
  // (not when the server itself moves notes in, or keeps them in step with a moved photo)
  async write(fullPath, note, { checkQuota = true } = {}) {
    const buffer = Buffer.from(JSON.stringify(note, null, 2));
    const write = () => getLibrary().writeItem(toAdminPath(fullPath), buffer);
    if (!checkQuota) return write();
    // Measured in the family's turn, against the note as it is now
    const growth = async () => {
      const current = await getLibrary().readItem(toAdminPath(fullPath)).catch(() => null);
      return { items: current ? 0 : ITEMS.note, bytes: buffer.length - (current ? current.length : 0) };
    };
    await addWithinQuota(growth, write);
  }

  // Every note file in dir (absolute), and in the folders below it unless recursive is false
  async findAll(dir = UPLOADS_DIR, { recursive = true } = {}) {
    const found = [];
    const items = await getLibrary().listItems(toAdminPath(dir)).catch(() => []);
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      const fullPath = path.join(dir, item.name);
      if (item.isFolder) {
        if (recursive) found.push(...await this.findAll(fullPath));
      } else if (this.isNote(item.name)) {
        found.push(fullPath);
      }
    }
    return found;
  }

  // Every folder in the library (absolute), the top folder first
  async allFolders(dir = UPLOADS_DIR) {
    const folders = [dir];
    const items = await getLibrary().listItems(toAdminPath(dir)).catch(() => []);
    for (const item of items) {
      if (item.isFolder && !item.name.startsWith('.')) folders.push(...await this.allFolders(path.join(dir, item.name)));
    }
    return folders;
  }

  // The note as the Notes page and the library show it
  describe(fullPath, note, now = new Date()) {
    return {
      ...note,
      path: toAdminPath(fullPath),
      folder: toAdminPath(path.dirname(fullPath)),
      status: this.status(note, now),
      photoUrls: this.photoUrls(note.photos)
    };
  }

  async load(fullPath, now = new Date()) {
    return this.describe(fullPath, await this.read(fullPath), now);
  }

  /**
   * Notes for the Notes page: in one folder (absolute), or in the whole
   * library. visible(relativePath) says which ones the person may see.
   */
  async list({ folder = null, visible = () => true, now = new Date() } = {}) {
    const files = folder ? await this.findAll(folder, { recursive: false }) : await this.findAll();
    const notes = await Promise.all(files.filter(file => visible(this.relative(file))).map(file =>
      this.load(file, now).catch(error => {
        console.error('Skipping unreadable note:', file, error.message);
        return null;
      })));
    return notes.filter(Boolean);
  }

  // A free file name for a note with this title in folderPath (absolute)
  async freePath(folderPath, title) {
    const base = this.slug(title);
    let target = path.join(folderPath, base + NOTE_EXT);
    for (let n = 2; await getLibrary().exists(toAdminPath(target)); n++) {
      target = path.join(folderPath, `${base}-${n}${NOTE_EXT}`);
    }
    return target;
  }

  /**
   * Save a new note in folderPath (absolute). The file is named after the
   * headline and never overwrites an existing file.
   */
  async create(folderPath, input) {
    const { note, errors } = await this.validate(input);
    if (errors) return { errors };

    const now = new Date().toISOString();
    const saved = { version: 1, id: `nt_${crypto.randomBytes(5).toString('hex')}`, ...note, createdAt: now, updatedAt: now };
    const target = await this.freePath(folderPath, saved.title);
    await this.write(target, saved);
    return { note: saved, fullPath: target };
  }

  // Partial updates (e.g. just { enabled: false }) keep the other fields
  async update(fullPath, input = {}) {
    const current = await this.read(fullPath);
    const { note, errors } = await this.validate({ ...current, ...input });
    if (errors) return { errors };

    const { audience, ...rest } = current;
    const saved = { ...rest, ...note, updatedAt: new Date().toISOString() };
    await this.write(fullPath, saved);
    return { note: saved, fullPath };
  }

  // Into another folder (absolute) that exists; returns the note's new full path
  async move(fullPath, folderPath) {
    if (path.dirname(fullPath) === folderPath) return fullPath;
    const moved = await getLibrary().movePhoto(toAdminPath(fullPath), toAdminPath(folderPath));
    return path.join(UPLOADS_DIR, path.relative('uploads', moved.path));
  }

  async remove(fullPath) {
    await getLibrary().deletePhoto(toAdminPath(fullPath));
  }

  // A photo moved (paths relative to uploads): notes that use it follow, as snaps do
  async photoMoved(from, to) {
    for (const fullPath of await this.findAll()) {
      try {
        const note = await this.read(fullPath);
        if (!note.photos?.includes(from)) continue;
        note.photos = note.photos.map(p => (p === from ? to : p));
        await this.write(fullPath, note, { checkQuota: false });
      } catch (error) {
        console.error('Could not update note after a move:', fullPath, error.message);
      }
    }
  }

  /**
   * May this frame show the note at relativePath? Notes in the top folder show
   * on every frame; a note in a folder shows on frames that may see that folder.
   * playing is the folder the frame chose to play (relative to uploads), if any.
   */
  isForFrame(req, relativePath, playing = '') {
    if (folderOf(relativePath) === '') return true;
    if (!canSee(req, relativePath)) return false;
    return !playing || inFolder(relativePath, playing, '/');
  }

  /**
   * Notes a frame should show right now: inside their window, in a folder the
   * frame may see, and with photos limited to the folders it may see.
   */
  async active(req = {}, { now = new Date(), folder = '' } = {}) {
    const session = req.session || {};
    const files = (await this.findAll()).filter(file => this.isForFrame(req, this.relative(file), folder));
    const notes = [];
    for (const file of files) {
      try {
        const note = await this.read(file);
        if (this.status(note, now) === 'active') notes.push({ file, note });
      } catch (error) {
        console.error('Skipping unreadable note:', file, error.message);
      }
    }

    return Promise.all(notes.map(async ({ file, note }) => {
      const photos = await this.visiblePhotos(note.photos, session);

      return {
        id: note.id || this.relative(file),
        title: note.title,
        message: note.message,
        signoff: note.signoff,
        eyebrow: note.eyebrow,
        theme: note.theme,
        layout: note.layout || 'auto',
        eventAt: note.eventAt,
        endsAt: this.effectiveEnd(note)?.toISOString() || null,
        everyMinutes: note.everyMinutes,
        showForSeconds: note.showForSeconds,
        photos: this.photoUrls(photos)
      };
    }));
  }

  status(note, now = new Date()) {
    if (!note.enabled) return 'paused';
    if (note.startsAt && new Date(note.startsAt) > now) return 'upcoming';
    const end = this.effectiveEnd(note);
    if (end && end <= now) return 'ended';
    return 'active';
  }

  effectiveEnd(note) {
    if (note.endsAt) return new Date(note.endsAt);
    if (note.eventAt) return new Date(new Date(note.eventAt).getTime() + EVENT_GRACE_MS);
    return null;
  }

  inFolders(photo, folders) {
    const folder = path.dirname(photo);
    return folders.some(allowed => folder === allowed || folder.startsWith(allowed + path.sep));
  }

  async photoExists(photo) {
    const fullPath = thumbnails.resolveInUploads(photo);
    return Boolean(fullPath && fullPath !== UPLOADS_DIR && thumbnails.IMAGE_PATTERN.test(fullPath) && await getLibrary().exists(toAdminPath(fullPath)));
  }

  photoUrls(photos = []) {
    return photos.map(photo => ({
      path: photo,
      url: uploadsUrl(path.join('uploads', photo)),
      // ?revalidate=1: not the address browsers cached for a day before thumbnails were always checked
      thumbnail: `/api/images/${encodeURIComponent(photo)}/thumbnail?revalidate=1`
    }));
  }

  slug(title) {
    const slug = String(title || '').toLowerCase()
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '');
    return slug || 'note';
  }

  /**
   * Check and normalise a note. Returns { note } or { errors: { field: message } }.
   */
  async validate(input = {}) {
    const errors = {};
    const date = (field) => {
      if (input[field] === null || input[field] === undefined || input[field] === '') return null;
      const value = new Date(input[field]);
      if (Number.isNaN(value.getTime())) {
        errors[field] = 'Not a valid date';
        return null;
      }
      return value.toISOString();
    };
    const whole = (field, min, max, fallback) => {
      if (input[field] === undefined || input[field] === null || input[field] === '') return fallback;
      const value = Number(input[field]);
      if (!Number.isInteger(value) || value < min || value > max) {
        errors[field] = `Between ${min} and ${max}`;
        return fallback;
      }
      return value;
    };

    const note = {
      ...await this.validatePage(input, errors),
      eventAt: date('eventAt'),
      startsAt: date('startsAt') || new Date().toISOString(),
      endsAt: date('endsAt'),
      everyMinutes: whole('everyMinutes', 1, 120, 5),
      showForSeconds: whole('showForSeconds', 5, 120, 20),
      enabled: input.enabled !== false
    };

    if (note.endsAt && note.endsAt <= note.startsAt) errors.endsAt = 'Must be after the start';

    return Object.keys(errors).length ? { errors } : { note };
  }

  /**
   * The page itself: words, theme, layout and photos. Shared with snaps,
   * which use the same pages without a schedule. Adds to errors in place.
   */
  async validatePage(input, errors) {
    const text = (field, { required = false } = {}) => {
      const value = typeof input[field] === 'string' ? input[field].trim() : '';
      if (required && !value) errors[field] = 'Required';
      else if (value.length > LIMITS[field]) errors[field] = `At most ${LIMITS[field]} characters`;
      return value;
    };

    const page = {
      title: text('title', { required: true }),
      message: text('message'),
      signoff: text('signoff'),
      eyebrow: text('eyebrow'),
      theme: THEMES.includes(input.theme) ? input.theme : 'paper',
      layout: Object.hasOwn(LAYOUTS, input.layout) ? input.layout : 'auto',
      photos: []
    };

    // Photos: up to 4 existing images inside uploads/ ("uploads/" prefix optional)
    const photos = Array.isArray(input.photos) ? input.photos : [];
    if (photos.length > LIMITS.photos) errors.photos = `At most ${LIMITS.photos} photos`;
    for (const raw of photos.slice(0, LIMITS.photos)) {
      const photo = typeof raw === 'string' ? path.normalize(raw.replace(/^\/?uploads\//, '')) : '';
      if (!await this.photoExists(photo)) {
        errors.photos = 'One of the photos could not be found';
        continue;
      }
      if (!page.photos.includes(photo)) page.photos.push(photo);
    }

    const needed = LAYOUTS[page.layout];
    if (needed > page.photos.length && !errors.photos) {
      errors.layout = `This layout needs ${needed} photo${needed === 1 ? '' : 's'}`;
    }
    return page;
  }

  /**
   * The photos a frame may show: the ones that still exist and, for a PIN
   * limited to some folders, sit inside them.
   */
  async visiblePhotos(photos = [], session = {}) {
    const account = session.accessAccount;
    const restrictFolders = account && !session.authenticated && account.assignedFolders?.length > 0
      ? account.assignedFolders
      : null;
    const visible = [];
    for (const photo of photos) {
      if (restrictFolders && !this.inFolders(photo, restrictFolders)) continue;
      if (await this.photoExists(photo)) visible.push(photo);
    }
    return visible;
  }

  /**
   * One-time move from the old library-wide notes list (the "notes" data
   * document) into the top folder, one file per note. A note that was shown
   * only on some frames is logged, so the admin can file it in a folder.
   * Safe to run again: notes already moved (same id) are skipped, and the
   * old list is emptied once every note is in place (a copy is kept in
   * "notes-before-folders").
   */
  async migrateFromStore({ store = getDataStore(), log = console } = {}) {
    const old = await store.get(OLD_STORE, []);
    if (!Array.isArray(old) || old.length === 0) return { moved: 0, skipped: 0 };

    const existing = new Set();
    for (const file of await this.findAll()) {
      const note = await this.read(file).catch(() => null);
      if (note?.id) existing.add(note.id);
    }

    // Names for the log: "Grandma's frame" says more than an id
    const accounts = await store.get('access-accounts', []).catch(() => []);
    const accountName = id => (Array.isArray(accounts) && accounts.find(a => a && a.id === id)?.name) || id;

    let moved = 0;
    let skipped = 0;
    for (const entry of old) {
      if (!entry || typeof entry !== 'object' || typeof entry.title !== 'string' || !entry.title.trim()) {
        skipped++;
        continue;
      }
      const { audience, ...note } = entry;
      if (note.id && existing.has(note.id)) {
        skipped++;
        continue;
      }
      const saved = { version: 1, ...note };
      if (!saved.id) saved.id = `nt_${crypto.randomBytes(5).toString('hex')}`;
      const target = await this.freePath(UPLOADS_DIR, saved.title);
      // Notes already in the library are not new: they never need room
      await this.write(target, saved, { checkQuota: false });
      existing.add(saved.id);
      moved++;

      const ids = audience && audience.all === false && Array.isArray(audience.accountIds) ? audience.accountIds : [];
      if (ids.length) {
        log.warn(`⚠️  Note "${saved.title}" was shown only on some frames (${ids.map(accountName).join(', ')}). ` +
          `It is now in the top folder (${toAdminPath(target)}), so every frame shows it. ` +
          'Move it into a folder that only those frames show.');
      }
    }

    // Keep a copy, then empty the old list so this never runs again
    await store.set(OLD_STORE_BACKUP, old);
    await store.set(OLD_STORE, []);
    if (moved) log.log(`Moved ${moved} note(s) into the top folder of the library.`);
    return { moved, skipped };
  }
}

module.exports = new NoteService();
module.exports.NoteService = NoteService;
module.exports.LAYOUTS = LAYOUTS;
module.exports.LIMITS = LIMITS;
module.exports.NOTE_EXT = NOTE_EXT;
module.exports.NOTE_PATTERN = NOTE_PATTERN;
