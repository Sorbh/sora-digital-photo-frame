const accessAccounts = require('../controllers/accessAccountController');
const { forRequest: pairingFor } = require('../services/pairingService');

// How often to refresh the account's folder assignments.
const RECHECK_MS = 30 * 1000;

function refuseViewer(req, res, next) {
  const { session } = req;
  delete session.accessAccount;
  delete session.deviceId;
  delete session.viewerCheckedAt;
  if (!session.authenticated) delete session.tenantId;

  if (req.baseUrl === '/uploads') return res.sendStatus(401);
  // Token sign-in checks the supplied credential independently of the stale session.
  if (req.method === 'POST' && req.path === '/auth/device') return next();
  return res.status(401).json({ success: false, code: 'DEVICE_REMOVED', error: 'This frame is no longer paired' });
}

async function freshViewer(req, res, next) {
  const session = req.session;
  const signedIn = session?.accessAccount;
  if (!signedIn && !session?.deviceId) return next();
  const pairing = pairingFor(req);

  let account;
  try {
    // Device and account deletion both remove the device record. Check it even
    // when the session's cached account is still fresh.
    if (session.deviceId) {
      const screen = await pairing.findDevice(session.deviceId);
      if (!screen || !signedIn || screen.accountId !== signedIn.id) return refuseViewer(req, res, next);
      pairing.seen(session.deviceId);
    }
    const sessionCheck = req.method === 'GET' && req.path === '/auth/session';
    if (!sessionCheck && session.viewerCheckedAt && Date.now() - session.viewerCheckedAt < RECHECK_MS) return next();
    account = (await accessAccounts.loadAccounts()).find(a => a.id === signedIn.id);
  } catch (error) {
    // Storage is down: don't sign frames out over it, try again next time
    console.warn('Could not recheck a frame:', error.message);
    return next();
  }

  if (!account) return refuseViewer(req, res, next);

  session.accessAccount = { id: account.id, name: account.name, assignedFolders: account.assignedFolders || [] };
  session.viewerCheckedAt = Date.now();
  // A frame that stays signed in by its session still counts as used ("Last used"
  // on Access): at most about once an hour, and never in its way
  try {
    await pairing.noteUse({ account });
  } catch (error) {
    console.warn('Could not note when a frame was last used:', error.message);
  }
  next();
}

module.exports = freshViewer;
module.exports.RECHECK_MS = RECHECK_MS;
