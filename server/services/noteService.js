const path = require('path');
const crypto = require('crypto');
const { UPLOADS_DIR } = require('../config/paths');
const thumbnails = require('./thumbnailService');
const { getLibrary } = require('../library');
const { getDataStore } = require('../store');
const LocalDataStore = require('../store/LocalDataStore');
const { toAdminPath } = require('../utils/safePath');

const THEMES = ['paper', 'berry', 'ink'];
// Book layouts and the photos each needs (mirrors NotePage.templates in public/js/notePage.js)
const LAYOUTS = { auto: 0, cover: 1, quote: 2, remember: 3, stack: 3, collage: 4, spine: 4, gallery: 4 };
const LIMITS = {
  title: 60,
  message: 160,
  signoff: 40,
  eyebrow: 40,
  photos: 4,
  accountIds: 50
};
// A note about an event stays up this long after it starts, unless endsAt says otherwise
const EVENT_GRACE_MS = 2 * 60 * 60 * 1000;

/**
 * Notes are short messages ("Priya is visiting on Monday") that the
 * slideshow shows as a memory-book page every few minutes, inside a date
 * window. Stored as one JSON file, like access accounts.
 */
class NoteService {
  constructor(file) {
    // A file argument keeps isolated service tests on their own document.
    this.store = file ? new LocalDataStore(path.dirname(file)) : null;
    this.name = file ? path.basename(file, '.json') : 'notes';
  }

  dataStore() {
    return this.store || getDataStore();
  }

  async load() {
    try {
      const notes = await this.dataStore().get(this.name, []);
      return Array.isArray(notes) ? notes : [];
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Could not read notes, treating as empty:', error.message);
      return [];
    }
  }

  async save(notes) {
    await this.dataStore().set(this.name, notes);
  }

  async list(now = new Date()) {
    const notes = await this.load();
    return notes.map(note => ({ ...note, status: this.status(note, now), photoUrls: this.photoUrls(note.photos) }));
  }

  async create(input) {
    const { note, errors } = await this.validate(input);
    if (errors) return { errors };

    const now = new Date().toISOString();
    const created = { id: `nt_${crypto.randomBytes(5).toString('hex')}`, ...note, createdAt: now, updatedAt: now };
    await this.dataStore().update(this.name, [], notes => [...notes, created]);
    return { note: created };
  }

  async update(id, input) {
    let result;
    await this.dataStore().update(this.name, [], async notes => {
      const index = notes.findIndex(n => n.id === id);
      if (index === -1) { result = { notFound: true }; return notes; }

      // Partial updates (e.g. just { enabled: false }) keep the other fields
      const { note, errors } = await this.validate({ ...notes[index], ...input });
      if (errors) { result = { errors }; return notes; }

      const next = [...notes];
      next[index] = { ...notes[index], ...note, updatedAt: new Date().toISOString() };
      result = { note: next[index] };
      return next;
    });
    return result;
  }

  async remove(id) {
    let removed = false;
    await this.dataStore().update(this.name, [], notes => {
      const remaining = notes.filter(n => n.id !== id);
      removed = remaining.length !== notes.length;
      return remaining;
    });
    return removed;
  }

  /**
   * Notes a frame should show right now: inside their window, meant for this
   * frame, and with photos limited to the folders its PIN may see.
   */
  async active(session = {}, now = new Date()) {
    const notes = (await this.load()).filter(note =>
      this.status(note, now) === 'active' && this.isForAccount(note, session.accessAccount));

    return Promise.all(notes.map(async note => {
      const photos = await this.visiblePhotos(note.photos, session);

      return {
        id: note.id,
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

  isForAccount(note, account) {
    if (note.audience?.all) return true;
    return Boolean(account && note.audience?.accountIds?.includes(account.id));
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
      url: `/uploads/${photo.split(path.sep).map(encodeURIComponent).join('/')}`,
      thumbnail: `/api/images/${encodeURIComponent(photo)}/thumbnail`
    }));
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

    const audience = input.audience || {};
    const accountIds = Array.isArray(audience.accountIds)
      ? [...new Set(audience.accountIds.filter(id => typeof id === 'string'))].slice(0, LIMITS.accountIds)
      : [];
    note.audience = { all: audience.all !== false, accountIds };
    if (!note.audience.all && accountIds.length === 0) errors.audience = 'Pick at least one frame';

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
}

module.exports = new NoteService();
module.exports.NoteService = NoteService;
module.exports.LAYOUTS = LAYOUTS;
module.exports.LIMITS = LIMITS;
