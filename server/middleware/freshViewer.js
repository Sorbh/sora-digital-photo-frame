const accessAccounts = require('../controllers/accessAccountController');
const { forRequest: pairingFor } = require('../services/pairingService');

// How often a signed-in frame's account and screen are looked up again
const RECHECK_MS = 30 * 1000;

/**
 * A frame's session keeps a copy of its account. Look it up again now and
 * then, so removing a screen or account signs that frame out within
 * RECHECK_MS, and a change to its folders reaches it, instead of both
 * waiting for the session to run out.
 */
async function freshViewer(req, res, next) {
  const session = req.session;
  const signedIn = session?.accessAccount;
  if (!signedIn) return next();
  // Every request a screen makes (its next photo, the photo itself, its session
  // check) says it's on: "Last seen" on Screens. In memory, so free per request
  const pairing = pairingFor(req);
  if (session.deviceId) pairing.seen(session.deviceId);
  // The frame's own "am I still signed in?" (js/frameSession.js, every 15 seconds)
  // always looks again, so a removed screen hears it within that time
  const sessionCheck = req.method === 'GET' && req.originalUrl.split('?')[0] === '/api/auth/session';
  if (!sessionCheck && session.viewerCheckedAt && Date.now() - session.viewerCheckedAt < RECHECK_MS) return next();

  let account;
  let screenKept = true;
  try {
    account = (await accessAccounts.loadAccounts()).find(a => a.id === signedIn.id);
    if (account && session.deviceId) {
      const screen = await pairing.findDevice(session.deviceId);
      screenKept = screen?.accountId === account.id;
    }
  } catch (error) {
    // Storage is down: don't sign frames out over it, try again next time
    console.warn('Could not recheck a frame:', error.message);
    return next();
  }

  if (!account || !screenKept) {
    delete session.accessAccount;
    delete session.deviceId;
    delete session.viewerCheckedAt;
    if (!session.authenticated) delete session.tenantId;
    return next();
  }

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
