const path = require('path');
const fs = require('fs');

class ViewController {
  // Serve admin panel
  serveAdmin(req, res) {
    res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
  }

  // Serve access accounts page
  serveAccessAccounts(req, res) {
    res.sendFile(path.join(__dirname, '..', 'public', 'access-accounts.html'));
  }

  // Serve slideshow page
  serveSlideshow(req, res) {
    const slideshowPath = path.join(__dirname, '..', 'public', 'slideshow.html');
    const defaultInterval = parseInt(process.env.DEFAULT_SLIDESHOW_INTERVAL, 10) || 15000;
    
    // Read the HTML file
    fs.readFile(slideshowPath, 'utf8', (err, data) => {
      if (err) {
        console.error('Error reading slideshow.html:', err);
        return res.status(500).send('Error loading slideshow');
      }
      
      // Hand the configured interval to slideshow.js via <html data-interval>
      const modifiedData = data.replace('data-interval="15000"', `data-interval="${defaultInterval}"`);
      
      res.setHeader('Content-Type', 'text/html');
      res.send(modifiedData);
    });
  }

  // Serve folder selection page
  serveFolderSelection(req, res) {
    res.sendFile(path.join(__dirname, '..', 'public', 'folder-selection.html'));
  }

  // Serve login page
  serveLogin(req, res) {
    res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
  }

  // Redirect root to slideshow
  redirectToSlideshow(req, res) {
    res.redirect('/slideshow');
  }
}

module.exports = new ViewController();