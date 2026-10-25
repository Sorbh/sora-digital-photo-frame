const crypto = require('crypto');

/**
 * Encrypted file format, version 1 (photos, snaps, JSON documents):
 *
 *   "PFE1" | version (1 byte) | key id length (1 byte) | key id (utf8) | IV (12 bytes) | ciphertext | GCM tag (16 bytes)
 *
 * AES-256-GCM. Everything before the ciphertext is passed as additional data,
 * so the key id and IV can't be swapped without decryption failing. The key
 * id says which key to use, so keys can be rotated and, later, held by users
 * (end-to-end). public/js/photoCipher.js reads the same format in browsers.
 */
const MAGIC = Buffer.from('PFE1');
const VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

function isEncrypted(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > MAGIC.length && buffer.subarray(0, MAGIC.length).equals(MAGIC);
}

function header(keyId, iv) {
  const id = Buffer.from(keyId, 'utf8');
  if (id.length === 0 || id.length > 255) throw new Error('Key id must be 1-255 bytes');
  return Buffer.concat([MAGIC, Buffer.from([VERSION, id.length]), id, iv]);
}

/**
 * Encrypt with { id, key } (key: 32-byte Buffer).
 */
function encrypt(plain, { id, key }) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) throw new Error('Key must be 32 bytes');
  const iv = crypto.randomBytes(IV_LENGTH);
  const head = header(id, iv);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(head);
  return Buffer.concat([head, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

/**
 * Read the header of an encrypted buffer: { version, keyId, iv, headerLength }.
 */
function parse(buffer) {
  if (!isEncrypted(buffer)) throw new Error('Not an encrypted file');
  const version = buffer[MAGIC.length];
  if (version !== VERSION) throw new Error(`Unsupported encrypted file version ${version}`);
  const idLength = buffer[MAGIC.length + 1];
  const idStart = MAGIC.length + 2;
  const headerLength = idStart + idLength + IV_LENGTH;
  if (buffer.length < headerLength + TAG_LENGTH) throw new Error('Encrypted file is truncated');
  return {
    version,
    keyId: buffer.subarray(idStart, idStart + idLength).toString('utf8'),
    iv: buffer.subarray(idStart + idLength, headerLength),
    headerLength
  };
}

/**
 * Decrypt with getKey(keyId) -> 32-byte Buffer (or a promise of one).
 * Throws when the key is unknown or the data was changed.
 */
async function decrypt(buffer, getKey) {
  const { keyId, iv, headerLength } = parse(buffer);
  const key = await getKey(keyId);
  if (!key) throw new Error(`Unknown encryption key: ${keyId}`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(buffer.subarray(0, headerLength));
  decipher.setAuthTag(buffer.subarray(buffer.length - TAG_LENGTH));
  return Buffer.concat([decipher.update(buffer.subarray(headerLength, buffer.length - TAG_LENGTH)), decipher.final()]);
}

module.exports = { encrypt, decrypt, parse, isEncrypted, KEY_LENGTH };
