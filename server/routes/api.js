const express = require('express');
const router = express.Router();
const imageController = require('../controllers/imageController');
const folderController = require('../controllers/folderController');
const accessAccountController = require('../controllers/accessAccountController');
const googlePhotosController = require('../controllers/googlePhotosController');
const noteController = require('../controllers/noteController');
const snapController = require('../controllers/snapController');
const pairingController = require('../controllers/pairingController');
const frameKeyController = require('../controllers/frameKeyController');
const upload = require('../middleware/upload');
const { requireAuth, requireViewer, requirePhotoViewer, scopeFor } = require('../middleware/auth');
const { requireEditor, requireOwner, writeInFolders, readInFolders, photoRefs } = require('../middleware/scope');
const { keepTenant } = require('../context');

// Every route decides what a signed-in person's scope (auth provider scope(req))
// allows: reads outside their folders answer 404, changes there 403, "can view"
// people can't change anything (VIEW_ONLY), and Access, pairing and the Google
// Photos connection are the owner's (OWNER_ONLY). tests/peopleScope.test.js
// fails for a route added here without a decision.
const editor = requireEditor;
const owner = requireOwner;
const body = (field) => (req) => req.body?.[field];
const query = (field) => (req) => req.query?.[field];
const list = (field) => (req) => (Array.isArray(req.body?.[field]) ? req.body[field] : []);

// Health check endpoint
router.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Slideshow routes: signed-in viewers only (admin, PIN account or paired frame) unless PUBLIC_PHOTOS is on
router.get('/random-image', requirePhotoViewer, imageController.getRandomImage.bind(imageController));
router.get('/images/random', requirePhotoViewer, imageController.getRandomImage.bind(imageController)); // New endpoint for consistency
router.get('/images/next', requirePhotoViewer, imageController.getRandomImage.bind(imageController)); // follows the folder's play order
router.get('/images/:imageId/thumbnail', requirePhotoViewer, imageController.getImageThumbnail.bind(imageController));

// Folder routes for the slideshow
router.get('/folders', requirePhotoViewer, folderController.getFolderStructure.bind(folderController));
// Thumbnail route must come first: the (*) catch-all below would swallow it
router.get('/folders/:folderPath(*)/thumbnail', requirePhotoViewer, folderController.getFolderThumbnail.bind(folderController));
router.get('/folders/:folderPath(*)', requirePhotoViewer, folderController.getFolderStructure.bind(folderController));

// Protected routes (authentication required)
// (can-edit checked before the photos are read, their folder once the form is)
router.post('/upload', requireAuth, editor, upload.limitedArray('images'), keepTenant,
  writeInFolders(req => req.body?.path || 'uploads', { allowRoot: true }), imageController.uploadImages.bind(imageController));
router.delete('/images', requireAuth, editor, writeInFolders(query('path')), imageController.deleteImage.bind(imageController));
router.delete('/images/batch', requireAuth, editor, writeInFolders(list('paths')), imageController.batchDeleteImages.bind(imageController));
router.post('/images/rotate', requireAuth, editor, writeInFolders(body('path')), imageController.rotateImage.bind(imageController));
// A move needs both ends inside the person's folders
router.post('/images/move', requireAuth, editor,
  writeInFolders(req => [...list('paths')(req), req.body?.destination || 'uploads'], { allowRoot: true }),
  imageController.moveImages.bind(imageController));

// Folder management routes (protected)
router.get('/admin/folders', requireAuth, folderController.getFolderContents.bind(folderController));
router.post('/admin/folders', requireAuth, editor, writeInFolders(req => req.body?.path || 'uploads', { allowRoot: true }), folderController.createFolder.bind(folderController));
// Inside one of their folders, never one of those folders itself
router.delete('/admin/folders', requireAuth, editor, writeInFolders(query('path'), { below: true }), folderController.deleteFolder.bind(folderController));
router.put('/admin/folders/order', requireAuth, editor, writeInFolders(req => req.query?.path || 'uploads', { allowRoot: true }), folderController.setPlayOrder.bind(folderController));

// Access account management routes (admin only)
router.get('/access-accounts', requireAuth, owner, accessAccountController.getAllAccounts.bind(accessAccountController));
router.post('/access-accounts', requireAuth, owner, accessAccountController.createAccount.bind(accessAccountController));
router.put('/access-accounts/:id', requireAuth, owner, accessAccountController.updateAccount.bind(accessAccountController));
router.delete('/access-accounts/:id', requireAuth, owner, accessAccountController.deleteAccount.bind(accessAccountController));
router.get('/admin/family-code', requireAuth, owner, accessAccountController.getFamilyCode.bind(accessAccountController));
router.post('/admin/family-code', requireAuth, owner, accessAccountController.renewFamilyCode.bind(accessAccountController));

// Notes shown in the slideshow (admin manages, frames read their active ones).
// Notes are files in folders, so they're scoped like photos: reads see only
// notes in the person's folders, changes need "can edit" and the note's folder
// (both ends of a move), and a note's photos must be ones they can see.
router.get('/notes', requireAuth, readInFolders(query('folder')), noteController.list.bind(noteController));
router.post('/notes', requireAuth, editor,
  writeInFolders(req => [req.body?.folder || 'uploads', ...photoRefs(req.body?.photos)], { allowRoot: true }),
  noteController.create.bind(noteController));
router.get('/notes/active', requirePhotoViewer, noteController.active.bind(noteController));
// One note, by its file: ?path=uploads/Family/visit.note.json
router.get('/notes/note', requireAuth, readInFolders(query('path')), noteController.get.bind(noteController));
router.put('/notes', requireAuth, editor,
  writeInFolders(req => [req.query?.path, ...(req.body?.folder !== undefined ? [req.body.folder] : []), ...photoRefs(req.body?.photos)], { allowRoot: true }),
  noteController.update.bind(noteController));
router.delete('/notes', requireAuth, editor, writeInFolders(query('path')), noteController.remove.bind(noteController));

// Snaps: memory-book pages saved in a folder and played like photos
// (moved and deleted with the photo endpoints)
// (a snap's photos must be ones the person can see too)
router.get('/snaps', requireAuth, readInFolders(query('path')), snapController.get.bind(snapController));
router.post('/snaps', requireAuth, editor,
  writeInFolders(req => [req.body?.folder || 'uploads', ...photoRefs(req.body?.photos)], { allowRoot: true }),
  snapController.create.bind(snapController));
router.put('/snaps', requireAuth, editor,
  writeInFolders(req => [req.query?.path, ...photoRefs(req.body?.photos)]),
  snapController.update.bind(snapController));

// Feature flags, and what this person may do (null: everything), so pages hide the rest
router.get('/features', requireAuth, (req, res) => {
    res.json({
        googlePhotosEnabled: process.env.ENABLE_GOOGLE_PHOTOS === 'true',
        // false: frames connect only by their code, and Access shows screens with no PIN
        pinSignIn: accessAccountController.pinSignIn,
        scope: scopeFor(req)
    });
});

// PIN authentication routes (public)
router.post('/auth/pin', accessAccountController.authenticateWithPin.bind(accessAccountController));
router.get('/auth/session', accessAccountController.getSession.bind(accessAccountController));
router.delete('/auth/session', accessAccountController.clearSession.bind(accessAccountController));

// Keys for frames that decrypt photos themselves (remote encrypted storage only)
router.get('/frame/keys', requireViewer, frameKeyController.get.bind(frameKeyController));

// Pairing a frame by QR code: the frame starts and waits, an admin approves
router.post('/pair/start', pairingController.start.bind(pairingController));
router.post('/pair/status', pairingController.status.bind(pairingController));
router.get('/pair/status', pairingController.status.bind(pairingController)); // older frames, see status()
router.post('/pair/collect', pairingController.collect.bind(pairingController));
router.post('/auth/device', pairingController.signIn.bind(pairingController));
// Before /admin/pair/:code, which would take "nearby" for a code
router.get('/admin/pair/nearby', pairingController.nearbyOn.bind(pairingController), requireAuth, owner, pairingController.nearby.bind(pairingController));
router.get('/admin/pair/:code', requireAuth, owner, pairingController.show.bind(pairingController));
router.post('/admin/pair/:code/approve', requireAuth, owner, pairingController.approve.bind(pairingController));
router.get('/admin/devices', requireAuth, owner, pairingController.listDevices.bind(pairingController));
router.put('/admin/devices/:id/language', requireAuth, owner, pairingController.setDeviceLanguage.bind(pairingController));
router.put('/device/language', requireViewer, pairingController.setOwnLanguage.bind(pairingController));
router.delete('/admin/devices/:id', requireAuth, owner, pairingController.removeDevice.bind(pairingController));

// Google Photos routes (admin only) - conditionally enabled
if (process.env.ENABLE_GOOGLE_PHOTOS === 'true') {
    router.get('/admin/google-photos/status', requireAuth, googlePhotosController.getAuthStatus);
    // Connecting and disconnecting Google Photos is the owner's
    router.post('/admin/google-photos/auth', requireAuth, owner, googlePhotosController.initiateAuth);
    router.get('/admin/google-photos/callback', googlePhotosController.handleCallback);
    router.delete('/admin/google-photos/auth', requireAuth, owner, googlePhotosController.revokeAccess);
    // Importing is a change: into one of the person's folders
    router.post('/admin/google-photos/picker-session', requireAuth, editor, writeInFolders(body('destinationPath'), { allowRoot: true }), googlePhotosController.createPickerSession);
    router.get('/admin/google-photos/session/:sessionId', requireAuth, googlePhotosController.getPickerSession);
    router.get('/admin/google-photos/session/:sessionId/media-items', requireAuth, googlePhotosController.getSessionMediaItems);
    router.get('/admin/google-photos/thumbnail', requireAuth, googlePhotosController.proxyThumbnail);
    router.post('/admin/google-photos/import', requireAuth, editor, writeInFolders(body('destinationPath'), { allowRoot: true }), googlePhotosController.importPhotos);
    router.get('/admin/google-photos/job/:jobId', requireAuth, googlePhotosController.getJobStatus);
} else {
    // Return 404 for all Google Photos routes when disabled
    router.use('/admin/google-photos/*', (req, res) => {
        res.status(404).json({ message: 'Google Photos integration is disabled' });
    });
}

// Authentication routes
const authRoutes = require('./auth');
router.use('/auth', authRoutes);

module.exports = router;
