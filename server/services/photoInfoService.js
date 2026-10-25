const exifr = require('exifr');

const { toAdminPath } = require('../utils/safePath');
const { getLibrary } = require('../library');
const { getDataStore } = require('../store');
const { currentTenant } = require('../context');

const EXIF_FIELDS = ['DateTimeOriginal', 'CreateDate', 'GPSLatitude', 'GPSLongitude', 'GPSLatitudeRef', 'GPSLongitudeRef'];

// Nominatim asks for at most one request a second and a real user agent
const PLACE_URL = 'https://nominatim.openstreetmap.org/reverse';
const PLACE_GAP_MS = 1100;
const PLACE_WAIT_MS = 2500;
// "Jaipur Municipal Corporation" reads better as "Jaipur"
const ADMIN_SUFFIX = /\s+(municipal corporation|municipal council|municipality|metropolitan (city|region)|city council|nagar nigam|tehsil|district)$/i;

/**
 * When and where a photo was taken, read from its EXIF data once and kept in
 * the cache folder (keyed by size and modified time, so an edited file is
 * read again). Place names come from OpenStreetMap, looked up only for photos
 * the frame actually shows and cached by rounded position; PHOTO_PLACES=off
 * turns the lookup off.
 */
class PhotoInfoService {
  constructor() {
    this.states = new Map(); // tenant id -> { info, places, saveTimer }
    this.pending = new Map();
    this.placeQueue = Promise.resolve(); // shared: the rate limit is per server, not per tenant
  }

  // Each tenant has its own cache of photo info and place names
  state() {
    const { id } = currentTenant();
    if (!this.states.has(id)) this.states.set(id, { info: null, places: null, saveTimer: null });
    return this.states.get(id);
  }

  get info() { return this.state().info; } // relative path -> { key, takenAt, lat, lon }
  get places() { return this.state().places; } // "lat,lon" -> name or ''

  async loadCache() {
    const state = this.state();
    if (!state.info) {
      state.info = await getDataStore().get('photo-info', {}).catch(() => ({}));
      state.places = await getDataStore().get('places', {}).catch(() => ({}));
    }
  }

  scheduleSave() {
    const state = this.state();
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      Promise.all([getDataStore().set('photo-info', state.info), getDataStore().set('places', state.places)])
        .catch(error => console.error('Could not save photo info cache:', error.message));
    }, 2000);
    state.saveTimer.unref?.();
  }

  // { takenAt, lat, lon, modifiedAt } for a photo (or a snap: its creation date)
  async get(fullPath, relativePath) {
    await this.loadCache();
    const stat = await getLibrary().stat(toAdminPath(fullPath));
    const key = `${stat.size}:${Math.round(stat.mtimeMs)}`;
    const modifiedAt = stat.mtime.toISOString();

    const cached = this.info[relativePath];
    if (cached && cached.key === key) return { ...cached, modifiedAt };

    const read = /\.snap\.json$/i.test(fullPath) ? await this.readSnap(fullPath) : await this.readExif(fullPath);
    this.info[relativePath] = { key, ...read };
    this.scheduleSave();
    return { ...this.info[relativePath], modifiedAt };
  }

  // Info for many photos, a few files at a time
  async getMany(items) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await this.get(items[i].path, items[i].relativePath).catch(() => ({ takenAt: null }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, items.length) }, worker));
    return out;
  }

  /**
   * Remember when and where a photo was taken from the original upload,
   * before re-encoding drops its EXIF data. Keyed to the stored file, so
   * get() uses it instead of reading the (metadata-free) stored copy.
   */
  async rememberUpload(fullPath, relativePath, originalBuffer) {
    await this.loadCache();
    const stat = await getLibrary().stat(toAdminPath(fullPath));
    this.info[relativePath] = { key: `${stat.size}:${Math.round(stat.mtimeMs)}`, ...await this.readExifBuffer(originalBuffer) };
    this.scheduleSave();
  }

  async readExif(fullPath) {
    return this.readExifBuffer(await getLibrary().readPhoto(toAdminPath(fullPath)).catch(() => null));
  }

  async readExifBuffer(buffer) {
    try {
      const exif = await exifr.parse(buffer, { pick: EXIF_FIELDS });
      const taken = exif?.DateTimeOriginal || exif?.CreateDate;
      const hasGps = Number.isFinite(exif?.latitude) && Number.isFinite(exif?.longitude)
        && !(exif.latitude === 0 && exif.longitude === 0);
      return {
        takenAt: taken instanceof Date && !isNaN(taken) ? this.localStamp(taken) : null,
        lat: hasGps ? exif.latitude : null,
        lon: hasGps ? exif.longitude : null
      };
    } catch {
      return { takenAt: null, lat: null, lon: null };
    }
  }

  async readSnap(fullPath) {
    const snap = await getLibrary().readItem(toAdminPath(fullPath))
      .then(buffer => JSON.parse(buffer.toString('utf8'))).catch(() => ({}));
    return { takenAt: snap.createdAt || null, lat: null, lon: null };
  }

  // Cameras store wall-clock time with no zone; keep it that way ("2019-03-12T18:04:00")
  localStamp(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  // The date used to sort: when it was taken, else when the file last changed
  sortDate(info) {
    return Date.parse(info?.takenAt || info?.modifiedAt || 0) || 0;
  }

  // "Goa, India" for a position, or null. Waits briefly; a slow lookup still
  // lands in the cache for the next time the photo comes round.
  async placeName(lat, lon) {
    if (process.env.PHOTO_PLACES === 'off' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    await this.loadCache();
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    if (key in this.places) return this.places[key] || null;

    if (!this.pending.has(key)) {
      const job = this.placeQueue.then(() => this.lookUp(key, lat, lon));
      this.placeQueue = job.then(() => new Promise(r => setTimeout(r, PLACE_GAP_MS).unref?.()));
      this.pending.set(key, job.finally(() => this.pending.delete(key)));
    }
    const timeout = new Promise(resolve => setTimeout(() => resolve(null), PLACE_WAIT_MS).unref?.());
    return Promise.race([this.pending.get(key), timeout]);
  }

  async lookUp(key, lat, lon) {
    try {
      const url = `${PLACE_URL}?format=jsonv2&zoom=10&lat=${lat}&lon=${lon}`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'SoraPhotoFrame/1.0 (self-hosted digital photo frame)', 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) return null; // try again another time
      const { address = {} } = await response.json();
      const local = address.city || address.town || address.village || address.suburb || address.municipality || address.county || address.state;
      const name = [local?.replace(ADMIN_SUFFIX, ''), address.country].filter(Boolean).join(', ');
      this.places[key] = name;
      this.scheduleSave();
      return name || null;
    } catch {
      return null;
    }
  }
}

module.exports = new PhotoInfoService();
