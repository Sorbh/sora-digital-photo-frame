const fs = require('fs-extra');
const snaps = require('../services/snapService');
const imageController = require('./imageController');
const { resolveAdminPath, toAdminPath } = require('../utils/safePath');

// Snaps are addressed like photos: ?path=uploads/Family/visit.snap.json
class SnapController {
  snapPath(req) {
    const fullPath = resolveAdminPath(req.query.path);
    return fullPath && snaps.isSnap(fullPath) ? fullPath : null;
  }

  async get(req, res) {
    try {
      const fullPath = this.snapPath(req);
      if (!fullPath || !await fs.pathExists(fullPath)) {
        return res.status(404).json({ success: false, error: 'Snap not found' });
      }
      res.json({ success: true, path: toAdminPath(fullPath), snap: await snaps.load(fullPath) });
    } catch (error) {
      console.error('Error reading snap:', error);
      res.status(500).json({ success: false, error: 'Failed to load snap' });
    }
  }

  async create(req, res) {
    try {
      const folder = resolveAdminPath(req.body.folder || 'uploads', { allowRoot: true });
      if (!folder || !(await fs.stat(folder).catch(() => null))?.isDirectory()) {
        return res.status(404).json({ success: false, error: 'Folder not found' });
      }

      const { snap, errors, fullPath } = await snaps.create(folder, req.body);
      if (errors) return res.status(400).json({ success: false, error: 'Please check the snap', errors });

      imageController.clearImageCache();
      res.status(201).json({ success: true, path: toAdminPath(fullPath), snap });
    } catch (error) {
      console.error('Error creating snap:', error);
      res.status(500).json({ success: false, error: 'Failed to save snap' });
    }
  }

  async update(req, res) {
    try {
      const fullPath = this.snapPath(req);
      if (!fullPath || !await fs.pathExists(fullPath)) {
        return res.status(404).json({ success: false, error: 'Snap not found' });
      }

      const { snap, errors } = await snaps.update(fullPath, req.body);
      if (errors) return res.status(400).json({ success: false, error: 'Please check the snap', errors });
      res.json({ success: true, path: toAdminPath(fullPath), snap });
    } catch (error) {
      console.error('Error updating snap:', error);
      res.status(500).json({ success: false, error: 'Failed to save snap' });
    }
  }
}

module.exports = new SnapController();
