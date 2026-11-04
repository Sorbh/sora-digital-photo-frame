const { getLibrary } = require('../library');
const { passClientError } = require('../utils/httpError');

const MAX_IDS = 10;

/**
 * Hands decryption keys to signed-in frames that load encrypted photos
 * straight from remote storage (see rawUrl). Local disk installs never use
 * this: their photos are decrypted on the server and the key stays there.
 */
class FrameKeyController {
  async get(req, res) {
    try {
      const library = getLibrary();
      if (!library.browserDecryption) {
        return res.status(404).json({ message: 'Photos are decrypted on the server here' });
      }

      const ids = String(req.query.ids || '').split(',').map(id => id.trim()).filter(Boolean).slice(0, MAX_IDS);
      const keys = {};
      for (const id of ids) {
        const key = await library.getKey(id);
        if (key) keys[id] = Buffer.from(key).toString('base64');
      }

      res.set('Cache-Control', 'no-store');
      res.json({ keys });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error getting frame keys:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
}

module.exports = new FrameKeyController();
