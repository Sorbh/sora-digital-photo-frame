// Load environment variables
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const session = require('express-session');

// Import middleware
const logger = require('./middleware/logger');
const errorHandler = require('./middleware/errorHandler');

// Import routes
const routes = require('./routes');
const { UPLOADS_DIR } = require('./config/paths');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy if running behind reverse proxy
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session configuration
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  console.error('SESSION_SECRET environment variable not set');
  process.exit(1);
}

app.use(session({
  secret: sessionSecret,
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

// Static files
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/js', express.static(path.join(__dirname, 'public/js')));
app.use('/admin', express.static(path.join(__dirname, 'public')));
// Serve CSS and JS files from root for access-accounts page
app.use(express.static(path.join(__dirname, 'public'), {
  index: false // Prevent serving index.html from root
}));

// Browsers ask for /favicon.ico on their own
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'public/icons/favicon.ico')));

// Routes
app.use('/', routes);

// Error handling middleware (must be last)
app.use(errorHandler);

// Initialize uploads directory
const initializeUploads = async () => {
  const defaultFolders = (process.env.DEFAULT_FOLDERS || 'family,vacation,holidays,misc').split(',');
  
  await fs.ensureDir(UPLOADS_DIR);
  
  for (const folder of defaultFolders) {
    await fs.ensureDir(path.join(UPLOADS_DIR, folder.trim()));
  }
};

// Start server (only when run directly, so tests can import the app)
if (require.main === module) {
  app.listen(PORT, async () => {
    await initializeUploads();
    console.log(`Digital Photo Frame Server running on port ${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin`);
    console.log(`Slideshow: http://localhost:${PORT}/slideshow`);
    console.log(`API endpoint: http://localhost:${PORT}/api/random-image`);
  });
}

module.exports = app;