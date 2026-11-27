const express = require('express');
const router = express.Router();
const viewController = require('../controllers/viewController');
const { requireAuth, requireGuest } = require('../middleware/auth');
const { requireOwnerPage } = require('../middleware/scope');

// Public routes
router.get('/', viewController.redirectToSlideshow.bind(viewController));
router.get('/slideshow', viewController.serveSlideshow.bind(viewController));
router.get('/folder-selection', viewController.serveFolderSelection.bind(viewController));
router.get('/login', requireGuest, viewController.serveLogin.bind(viewController));

// Protected routes
router.get('/home', requireAuth, viewController.serveAdmin.bind(viewController));
// Access and pairing are the library owner's (see middleware/scope)
router.get('/access-accounts', requireAuth, requireOwnerPage, viewController.serveAccessAccounts.bind(viewController));
router.get('/notes', requireAuth, viewController.serveNotes.bind(viewController));
router.get('/snap', requireAuth, viewController.serveSnap.bind(viewController));
router.get('/pair', requireAuth, requireOwnerPage, viewController.servePair.bind(viewController));

module.exports = router;