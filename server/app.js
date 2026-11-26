const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const session = require('express-session');

const logger = require('./middleware/logger');
const errorHandler = require('./middleware/errorHandler');
const webpFallback = require('./middleware/webpFallback');
const media = require('./middleware/media');
const sameOrigin = require('./middleware/sameOrigin');
const freshViewer = require('./middleware/freshViewer');
const noStore = require('./middleware/noStore');
const { requireVisiblePhoto, atPhotoPath } = require('./utils/viewerAccess');
const EncryptedPhotoLibrary = require('./library/EncryptedPhotoLibrary');
const EncryptedDataStore = require('./store/EncryptedDataStore');
const { keysFromEnv } = require('./crypto/keys');
const routes = require('./routes');
const { UPLOADS_DIR } = require('./config/paths');
const LocalPhotoLibrary = require('./library/LocalPhotoLibrary');
const { setLibrary } = require('./library');
const LocalDataStore = require('./store/LocalDataStore');
const { setDataStore } = require('./store');
const { tenantMiddleware } = require('./context');
const { setQuota } = require('./services/quotaService');
const { setAuthProvider, setPublicPhotos, requirePhotoViewer, announceAdminPassword } = require('./middleware/auth');
const { sessionSecret, announceSessionSecret } = require('./utils/sessionSecret');
const { setEvents } = require('./events');
const accessAccounts = require('./controllers/accessAccountController');
const { setMaxFolderDepth, canMakeFolderAt, maxFolderDepth } = require('./utils/folderDepth');

/**
 * Build the photo frame app. The self-hosted server calls this with no
 * options; a hosted deployment can pass its own pieces in.
 *
 * Options:
 *   sessionStore  express-session store (default: in-memory)
 *   library       photo storage implementation (default: local uploads folder)
 *   dataStore     JSON document storage (default: local data, cache and folder files)
 *   resolveTenant async function(req) -> { id, plan } or null (default: one 'default' tenant)
 *   auth          { requireAuth, requireGuest, requireViewer } middleware, all optional
 *                 (default: admin password session)
 *   quota         { canAdd({ items, bytes, screens }, context) -> { ok, message } } for the current
 *                 tenant (default: unlimited; see HOOKS.md, Quota)
 *   events        { devicePaired, devicesRemoved, familyCodeSet } handlers (see events.js)
 *   pinSignIn     false turns off PIN sign-in: frames connect only by their pairing code
 *                 (QR, or typed on Access), and accounts are "screens" with no PIN
 *                 (default: PIN_SIGN_IN=off turns it off, else on)
 *   trustProxy    Express 'trust proxy' setting (default: TRUST_PROXY, else 1 = one proxy in front)
 *   publicPhotos  true lets anyone who can reach the server load photos, thumbnails, folders
 *                 and notes without signing in, as before (default: PUBLIC_PHOTOS=true, else off)
 *   familyCode    true: a frame signing in with a PIN also gives its family code, so a
 *                 hosted resolveTenant can tell whose frame it is (see familyCodeService)
 *   keys          key provider ({ currentKey, getKey }, see crypto/keys.js) to encrypt photos
 *                 and data at rest (default: PHOTO_ENCRYPTION_KEY, or no encryption)
 *   beforeRoutes  function(app) run after core middleware, before core routes,
 *                 e.g. to mount extra sign-in routes
 */
function createApp({ sessionStore, beforeRoutes, library, dataStore, resolveTenant, auth, quota, events, pinSignIn = pinSignInFromEnv(), trustProxy = process.env.TRUST_PROXY, publicPhotos = process.env.PUBLIC_PHOTOS === 'true', familyCode = false, keys = keysFromEnv() } = {}) {
  announceSessionSecret();
  const secret = sessionSecret();

  const app = express();
  let photoLibrary = library || new LocalPhotoLibrary();
  let store = dataStore || new LocalDataStore();
  if (keys) {
    photoLibrary = new EncryptedPhotoLibrary(photoLibrary, keys);
    store = new EncryptedDataStore(store, keys);
  }
  setLibrary(photoLibrary);
  setDataStore(store);
  setAuthProvider(auth);
  if (!auth?.requireAuth) announceAdminPassword();
  setPublicPhotos(publicPhotos);
  if (publicPhotos) console.warn('⚠️  PUBLIC_PHOTOS is on: anyone who can reach this server can see your photos and notes without signing in.');
  setQuota(quota);
  setEvents(events);
  accessAccounts.pinSignIn = pinSignIn !== false;
  accessAccounts.familyCode = familyCode === true;
  // MAX_FOLDER_DEPTH (.env): how deep new folders may go; unset or 0 = no limit
  setMaxFolderDepth(process.env.MAX_FOLDER_DEPTH);

  // Which X-Forwarded-* headers to believe (client address, https). The default, 1,
  // fits one reverse proxy in front. With nothing in front, set TRUST_PROXY=false,
  // so nobody can pick their own address by sending the header.
  app.set('trust proxy', trustProxySetting(trustProxy));

  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use(session({
    secret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    name: 'photoframe.sid', // Custom session cookie name
    cookie: {
      secure: false, // Set to false for development, even in production for HTTP
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      sameSite: 'lax' // Add SameSite attribute for better compatibility
    }
  }));

  app.use(logger);
  // API answers are never kept by the browser (see middleware/noStore); photos
  // and thumbnails keep their own caching
  app.use('/api', noStore);
  // Changes only from this site's own pages (see middleware/sameOrigin)
  app.use(sameOrigin);
  app.use(tenantMiddleware(resolveTenant));
  // Removed screens and accounts stop working, and folder changes arrive, within 30 seconds
  app.use(['/api', '/uploads'], freshViewer);

  // Static files
  if (photoLibrary.staticDir) {
    app.use('/uploads', requirePhotoViewer, requireVisiblePhoto,
      atPhotoPath(webpFallback(photoLibrary.staticDir)), atPhotoPath(express.static(photoLibrary.staticDir)));
  } else {
    // Encrypted or remote storage: serve through the library (decrypts on the server)
    app.use('/uploads', requirePhotoViewer, requireVisiblePhoto, media());
  }
  app.use('/js', express.static(path.join(__dirname, 'public/js')));
  app.use('/admin', express.static(path.join(__dirname, 'public')));
  // Serve CSS and JS files from root for access-accounts page
  app.use(express.static(path.join(__dirname, 'public'), {
    index: false // Prevent serving index.html from root
  }));

  // Browsers ask for /favicon.ico on their own
  app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'public/icons/favicon.ico')));

  if (beforeRoutes) beforeRoutes(app);

  app.use('/', routes);

  // Error handling middleware (must be last)
  app.use(errorHandler);

  return app;
}

// PIN_SIGN_IN=off (or false, 0, no) turns PIN sign-in off; anything else leaves it on
function pinSignInFromEnv(value = process.env.PIN_SIGN_IN) {
  return !['off', 'false', '0', 'no'].includes(String(value || '').trim().toLowerCase());
}

// TRUST_PROXY: "false"/"true", a number of proxies, or addresses Express understands
function trustProxySetting(value) {
  if (value === undefined || value === null || value === '') return 1;
  if (typeof value !== 'string') return value;
  if (value === 'false') return false;
  if (value === 'true') return true;
  return /^\d+$/.test(value) ? Number(value) : value;
}

// Create the uploads folder and the default photo folders
async function initializeUploads() {
  const defaultFolders = (process.env.DEFAULT_FOLDERS || 'family,vacation,holidays,misc').split(',');

  await fs.ensureDir(UPLOADS_DIR);

  for (const folder of defaultFolders) {
    const fullPath = path.join(UPLOADS_DIR, folder.trim());
    // Not past MAX_FOLDER_DEPTH (read by createApp, which runs first), symlinks followed
    if (!await canMakeFolderAt(fullPath)) {
      console.warn(`⚠️  DEFAULT_FOLDERS: skipping "${folder.trim()}", deeper than MAX_FOLDER_DEPTH=${maxFolderDepth()}.`);
      continue;
    }
    await fs.ensureDir(fullPath);
  }

  await migrateNotes();
}

// Notes used to be one list for the whole library; they are files in folders now.
// Moves an old list into the top folder once. A failure is logged and tried
// again at the next start, never stopping the server.
async function migrateNotes() {
  try {
    await require('./services/noteService').migrateFromStore();
  } catch (error) {
    console.error('Could not move notes into the library folders:', error.message);
  }
}

module.exports = { createApp, initializeUploads, migrateNotes };
