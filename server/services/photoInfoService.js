const path = require('path');
const fs = require('fs-extra');
const exifr = require('exifr');

const { CACHE_DIR } = require('../config/paths');
const { toAdminPath } = require('../utils/safePath');
const { getLibrary } = require('../library');

const INFO_FILE = path.join(CACHE_DIR, 'photo-info.json');
const PLACES_FILE = path.join(CACHE_DIR, 'places.json');
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
    this.info = null; // relative path -> { key, takenAt, lat, lon }
    this.places = null; // "lat,lon" -> name or ''
    this.pending = new Map();
    this.placeQueue = Promise.resolve();
    this.saveTimer = null;
  }

  async loadCache() {
    if (!this.info) {
      this.info = await fs.readJson(INFO_FILE).catch(() => ({}));
      this.places = await fs.readJson(PLACES_FILE).catch(() => ({}));
    }
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      fs.ensureDir(CACHE_DIR)
        .then(() => Promise.all([fs.writeJson(INFO_FILE, this.info), fs.writeJson(PLACES_FILE, this.places)]))
        .catch(error => console.error('Could not save photo info cache:', error.message));
    }, 2000);
    this.saveTimer.unref?.();
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

  async readExif(fullPath) {
    try {
      const exif = await exifr.parse(await getLibrary().readPhoto(toAdminPath(fullPath)), { pick: EXIF_FIELDS });
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
