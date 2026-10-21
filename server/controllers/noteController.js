const notes = require('../services/noteService');

class NoteController {
  // All notes for the admin Notes page, each with its current status
  async list(req, res) {
    try {
      res.json({ success: true, notes: await notes.list() });
    } catch (error) {
      console.error('Error listing notes:', error);
      res.status(500).json({ success: false, error: 'Failed to load notes' });
    }
  }

  async create(req, res) {
    try {
      const { note, errors } = await notes.create(req.body);
      if (errors) return res.status(400).json({ success: false, error: 'Please check the note', errors });
      res.status(201).json({ success: true, note });
    } catch (error) {
      console.error('Error creating note:', error);
      res.status(500).json({ success: false, error: 'Failed to save note' });
    }
  }

  async update(req, res) {
    try {
      const { note, errors, notFound } = await notes.update(req.params.id, req.body);
      if (notFound) return res.status(404).json({ success: false, error: 'Note not found' });
      if (errors) return res.status(400).json({ success: false, error: 'Please check the note', errors });
      res.json({ success: true, note });
    } catch (error) {
      console.error('Error updating note:', error);
      res.status(500).json({ success: false, error: 'Failed to save note' });
    }
  }

  async remove(req, res) {
    try {
      if (!await notes.remove(req.params.id)) {
        return res.status(404).json({ success: false, error: 'Note not found' });
      }
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting note:', error);
      res.status(500).json({ success: false, error: 'Failed to delete note' });
    }
  }

  // Notes this frame should show now (filtered by window, audience and folders)
  async active(req, res) {
    try {
      res.json({ success: true, notes: await notes.active(req.session) });
    } catch (error) {
      console.error('Error loading active notes:', error);
      res.status(500).json({ success: false, error: 'Failed to load notes' });
    }
  }
}

module.exports = new NoteController();
