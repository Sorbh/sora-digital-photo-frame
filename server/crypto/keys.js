const { KEY_LENGTH } = require('./photoCipher');

/**
 * Where encryption keys come from. A key provider has:
 *   currentKey() -> { id, key }  key to encrypt new data with, for the current tenant
 *   getKey(id)   -> key or null  key to decrypt data that names `id` (null if unknown
 *                                or not the current tenant's)
 * Either may return a promise. A hosted setup passes its own (per-tenant keys
 * wrapped by a master key); self-hosted installs can set PHOTO_ENCRYPTION_KEY.
 */
class StaticKeyProvider {
  /**
   * keys: { [id]: 32-byte Buffer }, currentId: the one to encrypt with
   */
  constructor(keys, currentId) {
    this.keys = keys;
    this.currentId = currentId;
    for (const [id, key] of Object.entries(keys)) {
      if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) throw new Error(`Encryption key "${id}" must be 32 bytes`);
    }
    if (!keys[currentId]) throw new Error(`No encryption key "${currentId}"`);
  }

  currentKey() {
    return { id: this.currentId, key: this.keys[this.currentId] };
  }

  getKey(id) {
    return this.keys[id] || null;
  }
}

/**
 * Keys from the environment, or null when encryption is off:
 *   PHOTO_ENCRYPTION_KEY      base64 of 32 random bytes (openssl rand -base64 32)
 *   PHOTO_ENCRYPTION_KEY_ID   its id (default "local-1"); change both to rotate
 *   PHOTO_ENCRYPTION_OLD_KEYS earlier keys still needed to read old files, "id:base64,id:base64"
 */
function keysFromEnv(env = process.env) {
  if (!env.PHOTO_ENCRYPTION_KEY) return null;
  const currentId = env.PHOTO_ENCRYPTION_KEY_ID || 'local-1';
  const keys = { [currentId]: Buffer.from(env.PHOTO_ENCRYPTION_KEY, 'base64') };
  for (const entry of (env.PHOTO_ENCRYPTION_OLD_KEYS || '').split(',').filter(Boolean)) {
    const [id, value] = entry.split(':');
    if (id && value) keys[id.trim()] = Buffer.from(value.trim(), 'base64');
  }
  return new StaticKeyProvider(keys, currentId);
}

module.exports = { StaticKeyProvider, keysFromEnv };
