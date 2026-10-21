const express = require('express');
const router = express.Router();
const viewController = require('../controllers/viewController');
const { requireAuth, requireGuest } = require('../middleware/auth');

// Public routes
router.get('/', viewController.redirectToSlideshow.bind(viewController));
router.get('/slideshow', viewController.serveSlideshow.bind(viewController));
router.get('/folder-selection', viewController.serveFolderSelection.bind(viewController));
router.get('/login', requireGuest, viewController.serveLogin.bind(viewController));

// Protected routes
router.get('/admin', requireAuth, viewController.serveAdmin.bind(viewController));
router.get('/access-accounts', requireAuth, viewController.serveAccessAccounts.bind(viewController));
router.get('/notes', requireAuth, viewController.serveNotes.bind(viewController));

module.exports = router;