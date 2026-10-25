const DataStore = require('./DataStore');
const cipher = require('../crypto/photoCipher');

/**
 * Wraps any DataStore so JSON documents (notes, devices, photo dates and
 * places...) are stored encrypted, as { "encrypted": "<base64>" }.
 * Documents saved before encryption was turned on are read as they are and
 * encrypted the next time they're written.
 */
class EncryptedDataStore extends DataStore {
  constructor(inner, keys) {
    super();
    this.inner = inner;
    this.keys = keys;
  }

  async seal(value) {
    const sealed = cipher.encrypt(Buffer.from(JSON.stringify(value)), await this.keys.currentKey());
    return { encrypted: sealed.toString('base64') };
  }

  async open(stored) {
    if (!stored || typeof stored.encrypted !== 'string' || Object.keys(stored).length !== 1) return stored;
    const plain = await cipher.decrypt(Buffer.from(stored.encrypted, 'base64'), id => this.keys.getKey(id));
    return JSON.parse(plain.toString('utf8'));
  }

  async get(name, fallback) {
    const stored = await this.inner.get(name, undefined);
    return stored === undefined ? fallback : this.open(stored);
  }

  async set(name, value) {
    return this.inner.set(name, await this.seal(value));
  }

  async update(name, fallback, fn) {
    let next;
    await this.inner.update(name, undefined, async (stored) => {
      const current = stored === undefined ? fallback : await this.open(stored);
      next = await fn(current);
      return this.seal(next);
    });
    return next;
  }
}

module.exports = EncryptedDataStore;
