const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const session = require('express-session');

const logger = require('./middleware/logger');
const errorHandler = require('./middleware/errorHandler');
const routes = require('./routes');
const { UPLOADS_DIR } = require('./config/paths');
const LocalPhotoLibrary = require('./library/LocalPhotoLibrary');
const { setLibrary } = require('./library');
const LocalDataStore = require('./store/LocalDataStore');
const { setDataStore } = require('./store');
const { tenantMiddleware } = require('./context');
const { setQuota } = require('./services/quotaService');
const { setAuthProvider } = require('./middleware/auth');

/**
 * Build the photo frame app. The self-hosted server calls this with no
 * options; a hosted deployment can pass its own pieces in.
 *
 * Options:
 *   sessionStore  express-session store (default: in-memory)
 *   library       photo storage implementation (default: local uploads folder)
 *   dataStore     JSON document storage (default: local data, cache and folder files)
 *   resolveTenant async function(req) -> { id, plan } or null (default: one 'default' tenant)
 *   auth          { requireAuth, requireGuest } middleware (default: admin password session)
 *   quota         { canAdd(bytes) -> { ok, message } } for the current tenant (default: unlimited)
 *   beforeRoutes  function(app) run after core middleware, before core routes,
 *                 e.g. to mount extra sign-in routes
 */
function createApp({ sessionStore, beforeRoutes, library, dataStore, resolveTenant, auth, quota } = {}) {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error('SESSION_SECRET environment variable not set');
  }

  const app = express();
  const photoLibrary = library || new LocalPhotoLibrary();
  setLibrary(photoLibrary);
  setDataStore(dataStore || new LocalDataStore());
  setAuthProvider(auth);
  setQuota(quota);

  // Trust proxy if running behind reverse proxy
  app.set('trust proxy', 1);

  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use(session({
    secret: sessionSecret,
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
  app.use(tenantMiddleware(resolveTenant));

  // Static files
  if (photoLibrary.staticDir) app.use('/uploads', express.static(photoLibrary.staticDir));
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

// Create the uploads folder and the default photo folders
async function initializeUploads() {
  const defaultFolders = (process.env.DEFAULT_FOLDERS || 'family,vacation,holidays,misc').split(',');

  await fs.ensureDir(UPLOADS_DIR);

  for (const folder of defaultFolders) {
    await fs.ensureDir(path.join(UPLOADS_DIR, folder.trim()));
  }
}

module.exports = { createApp, initializeUploads };
