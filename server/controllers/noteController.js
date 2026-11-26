const path = require('path');
const notes = require('../services/noteService');
const { getLibrary } = require('../library');
const { UPLOADS_DIR } = require('../config/paths');
const { resolveAdminPath, toAdminPath } = require('../utils/safePath');
const { passClientError } = require('../utils/httpError');
const { canSee, keepHiddenPhotos } = require('../utils/viewerAccess');

// Relative to uploads, "/"-separated, as the viewerAccess helpers take it
const relative = (fullPath) => path.relative(UPLOADS_DIR, fullPath).split(path.sep).join('/');

/**
 * Notes are files in library folders, addressed like snaps:
 * ?path=uploads/Family/visit.note.json. Which notes a person may read or
 * change goes through the viewerAccess helpers, like photos.
 */
class NoteController {
  // The photos (relative to uploads) this person may see on a note
  visible(req) {
    return (photo) => canSee(req, photo);
  }

  // A folder (absolute) the person may use, or null
  async folderFor(req, adminPath) {
    const folder = resolveAdminPath(adminPath || 'uploads', { allowRoot: true });
    if (!folder || !(await getLibrary().stat(toAdminPath(folder)))?.isFolder) return null;
    return canSee(req, relative(folder)) ? folder : null;
  }

  // A note file (absolute) the person may use, or null
  async notePath(req) {
    const fullPath = resolveAdminPath(typeof req.query.path === 'string' ? req.query.path : '');
    if (!fullPath || !notes.isNote(fullPath) || !canSee(req, relative(fullPath))) return null;
    return await getLibrary().exists(toAdminPath(fullPath)) ? fullPath : null;
  }

  // Notes for the Notes page, each with its status: in ?folder=, or all of them,
  // with the folders a note can be put in
  async list(req, res) {
    try {
      let folder = null;
      if (req.query.folder) {
        folder = await this.folderFor(req, String(req.query.folder));
        if (!folder) return res.status(404).json({ success: false, error: 'Folder not found', code: 'FOLDER_NOT_FOUND' });
      }
      const visible = (relativePath) => canSee(req, relativePath);
      const folders = (await notes.allFolders())
        .filter(full => canSee(req, relative(full)))
        .map(toAdminPath);
      res.json({ success: true, notes: await notes.list({ folder, visible }), folders });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error listing notes:', error);
      res.status(500).json({ success: false, error: 'Failed to load notes' });
    }
  }

  async get(req, res) {
    try {
      const fullPath = await this.notePath(req);
      if (!fullPath) return res.status(404).json({ success: false, error: 'Note not found' });
      res.json({ success: true, note: await notes.load(fullPath, undefined, this.visible(req)) });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error reading note:', error);
      res.status(500).json({ success: false, error: 'Failed to load note' });
    }
  }

  // A new note in body.folder (an admin path), the top folder by default
  async create(req, res) {
    try {
      const folder = await this.folderFor(req, req.body?.folder);
      if (!folder) return res.status(404).json({ success: false, error: 'Folder not found', code: 'FOLDER_NOT_FOUND' });

      const { note, errors, fullPath } = await notes.create(folder, req.body || {});
      if (errors) return res.status(400).json({ success: false, error: 'Please check the note', errors });
      res.status(201).json({ success: true, note: await notes.load(fullPath, undefined, this.visible(req)), path: toAdminPath(fullPath), id: note.id });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error creating note:', error);
      res.status(500).json({ success: false, error: 'Failed to save note' });
    }
  }

  // Change a note; body.folder (an admin path) moves it to another folder
  async update(req, res) {
    try {
      let fullPath = await this.notePath(req);
      if (!fullPath) return res.status(404).json({ success: false, error: 'Note not found' });

      const { folder: folderPath, ...input } = req.body || {};
      // Someone limited to some folders never drops the photos they can't see
      if (input.photos !== undefined) input.photos = keepHiddenPhotos(req, (await notes.read(fullPath))?.photos, input.photos);
      let target = null;
      if (folderPath !== undefined) {
        target = await this.folderFor(req, folderPath);
        if (!target) return res.status(404).json({ success: false, error: 'Folder not found', code: 'FOLDER_NOT_FOUND' });
      }

      const { errors } = await notes.update(fullPath, input);
      if (errors) return res.status(400).json({ success: false, error: 'Please check the note', errors });
      if (target) fullPath = await notes.move(fullPath, target);
      res.json({ success: true, note: await notes.load(fullPath, undefined, this.visible(req)), path: toAdminPath(fullPath) });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error updating note:', error);
      res.status(500).json({ success: false, error: 'Failed to save note' });
    }
  }

  async remove(req, res) {
    try {
      const fullPath = await this.notePath(req);
      if (!fullPath) return res.status(404).json({ success: false, error: 'Note not found' });
      await notes.remove(fullPath);
      res.json({ success: true });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error deleting note:', error);
      res.status(500).json({ success: false, error: 'Failed to delete note' });
    }
  }

  // Notes this frame should show now: in their window, in folders it may see and,
  // with ?folder=, in the folder it plays (top-folder notes show on every frame)
  async active(req, res) {
    try {
      const folder = typeof req.query.folder === 'string' ? req.query.folder : '';
      res.json({ success: true, notes: await notes.active(req, { folder }) });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error loading active notes:', error);
      res.status(500).json({ success: false, error: 'Failed to load notes' });
    }
  }
}

module.exports = new NoteController();
