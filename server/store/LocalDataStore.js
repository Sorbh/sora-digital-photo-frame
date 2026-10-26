const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const DataStore = require('./DataStore');
const { DATA_DIR, CACHE_DIR, UPLOADS_DIR } = require('../config/paths');

const CACHE_NAMES = new Set(['photo-info', 'places']);

class LocalDataStore extends DataStore {
  constructor(root = DATA_DIR) {
    super();
    this.root = path.resolve(root);
    this.writes = new Map();
  }

  file(name) {
    if (typeof name !== 'string') throw new Error('Invalid document name');
    if (name.startsWith('folder-settings:')) {
      const relative = name.slice('folder-settings:'.length);
      if (!relative || relative.split('/').every(part => /^[^\\/\0]+$/.test(part) && part !== '.' && part !== '..')) {
        return path.join(UPLOADS_DIR, relative, '.sora-folder.json');
      }
      throw new Error('Invalid document name');
    }
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(name) || name.includes('..')) throw new Error('Invalid document name');
    return path.join(CACHE_NAMES.has(name) ? CACHE_DIR : this.root, `${name}.json`);
  }

  async get(name, fallback) {
    const file = this.file(name);
    try {
      return await fs.readJson(file);
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw error;
    }
  }

  queue(name, fn) {
    const previous = this.writes.get(name) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.writes.set(name, next);
    next.finally(() => { if (this.writes.get(name) === next) this.writes.delete(name); }).catch(() => {});
    return next;
  }

  async write(file, value) {
    await fs.ensureDir(path.dirname(file));
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(value, null, 2));
      await fs.rename(tmp, file);
    } catch (error) {
      await fs.remove(tmp).catch(() => {});
      throw error;
    }
  }

  async set(name, value) {
    const file = this.file(name);
    return this.queue(name, () => this.write(file, value));
  }

  async update(name, fallback, fn) {
    const file = this.file(name);
    return this.queue(name, async () => {
      const current = await this.get(name, fallback);
      const next = await fn(current);
      await this.write(file, next);
      return next;
    });
  }
}

module.exports = LocalDataStore;
