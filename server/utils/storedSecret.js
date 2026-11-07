const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/paths');

const made = new Map();

/**
 * A secret the server makes up once and keeps in DATA_DIR/<name>, readable only
 * by the server, so it stays the same across restarts. Used when the admin
 * password or the session secret is missing or still the example value.
 */
function storedSecret(name, bytes) {
  if (made.has(name)) return made.get(name);
  const file = path.join(DATA_DIR, name);
  let value = null;
  try {
    value = fs.readFileSync(file, 'utf8').trim() || null;
  } catch { /* not made yet */ }
  if (!value) {
    value = crypto.randomBytes(bytes).toString('base64url');
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(file, value + '\n', { mode: 0o600 });
    } catch (error) {
      console.warn(`⚠️  Could not save ${file} (${error.message}); it changes on every restart.`);
    }
  }
  made.set(name, value);
  return value;
}

storedSecret.file = name => path.join(DATA_DIR, name);

module.exports = storedSecret;
