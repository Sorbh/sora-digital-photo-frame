// Load environment variables
require('dotenv').config();

const { createApp, initializeUploads } = require('./app');

const PORT = process.env.PORT || 3000;

let app;
try {
  app = createApp();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

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
