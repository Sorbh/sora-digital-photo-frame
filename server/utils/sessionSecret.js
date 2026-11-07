const storedSecret = require('./storedSecret');

// The example values from .env.example, docker-compose.yml and DOCKER.md. Anyone
// who has read them could sign session cookies, so they count as not set.
const EXAMPLE_SECRETS = new Set([
  'generate_random_secret_key_here_min_32_chars',
  'your-secret-key-change-this',
  'your-secure-session-secret-here',
  'your-secure-session-secret'
]);

const FILE = 'session-secret';

const chosen = () => {
  const set = process.env.SESSION_SECRET;
  return set && !EXAMPLE_SECRETS.has(set) ? set : null;
};

// Signs session cookies and encrypts the Google Photos tokens: SESSION_SECRET,
// unless it's missing or an example value. Then one made up and kept in DATA_DIR.
const sessionSecret = () => chosen() || storedSecret(FILE, 32);

// Called once at start
const announceSessionSecret = () => {
  if (chosen()) return;
  const why = process.env.SESSION_SECRET ? 'SESSION_SECRET is an example value, which anyone could look up' : 'SESSION_SECRET is not set';
  sessionSecret();
  console.warn(`⚠️  ${why}. Using a random one kept in ${storedSecret.file(FILE)}. Set SESSION_SECRET to choose your own.`);
};

module.exports = { sessionSecret, announceSessionSecret, EXAMPLE_SECRETS };
