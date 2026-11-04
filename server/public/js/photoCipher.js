/**
 * Decrypts photos in the browser (WebCrypto), for frames that load encrypted
 * files straight from storage. Same format as server/crypto/photoCipher.js:
 *
 *   "PFE1" | version | key id length | key id | IV (12 bytes) | ciphertext + GCM tag
 *
 * Written without newer syntax so it parses on old tablets; check
 * SoraPhotoCipher.supported() and fall back to the server's /uploads URLs.
 */
(function (root) {
  var MAGIC = [0x50, 0x46, 0x45, 0x31]; // "PFE1"
  var VERSION = 1;
  var IV_LENGTH = 12;

  function subtle() {
    var c = (typeof crypto !== 'undefined' && crypto) || root.crypto;
    return c && c.subtle;
  }

  function supported() {
    return !!subtle() && typeof Uint8Array !== 'undefined';
  }

  function isEncrypted(data) {
    var bytes = new Uint8Array(data);
    if (bytes.length <= MAGIC.length) return false;
    for (var i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false;
    return true;
  }

  function parse(data) {
    var bytes = new Uint8Array(data);
    if (!isEncrypted(bytes)) throw new Error('Not an encrypted file');
    if (bytes[4] !== VERSION) throw new Error('Unsupported encrypted file version ' + bytes[4]);
    var idLength = bytes[5];
    var headerLength = 6 + idLength + IV_LENGTH;
    var keyId = '';
    for (var i = 0; i < idLength; i++) keyId += String.fromCharCode(bytes[6 + i]);
    return {
      keyId: decodeURIComponent(escape(keyId)), // utf8
      iv: bytes.slice(6 + idLength, headerLength),
      header: bytes.slice(0, headerLength),
      body: bytes.slice(headerLength)
    };
  }

  /**
   * data: ArrayBuffer of the stored file. getKey(keyId) -> raw 32-byte key
   * (ArrayBuffer/Uint8Array, or a promise of one). Resolves to an ArrayBuffer.
   * Files that aren't encrypted are returned as they are.
   */
  function decrypt(data, getKey) {
    if (!isEncrypted(data)) return Promise.resolve(data);
    var parts;
    try {
      parts = parse(data);
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve(getKey(parts.keyId)).then(function (raw) {
      if (!raw) throw new Error('Unknown encryption key: ' + parts.keyId);
      return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
    }).then(function (key) {
      return subtle().decrypt({ name: 'AES-GCM', iv: parts.iv, additionalData: parts.header }, key, parts.body);
    });
  }

  /**
   * Fetch an encrypted photo and resolve to an object URL for an <img>.
   * Revoke it with URL.revokeObjectURL when the photo leaves the screen.
   */
  function loadImage(url, getKey, type) {
    return fetch(url).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.arrayBuffer();
    }).then(function (data) {
      return decrypt(data, getKey);
    }).then(function (plain) {
      return URL.createObjectURL(new Blob([plain], { type: type || 'image/webp' }));
    });
  }

  var api = { supported: supported, isEncrypted: isEncrypted, decrypt: decrypt, loadImage: loadImage };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SoraPhotoCipher = api;
})(typeof self !== 'undefined' ? self : this);
