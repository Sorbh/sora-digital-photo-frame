const accessAccounts = require('../controllers/accessAccountController');
const pairing = require('../services/pairingService');

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
  if (session.viewerCheckedAt && Date.now() - session.viewerCheckedAt < RECHECK_MS) return next();

  let account;
  let screenKept = true;
  try {
    account = (await accessAccounts.loadAccounts()).find(a => a.id === signedIn.id);
    if (account && session.deviceId) {
      screenKept = (await pairing.loadDevices()).some(d => d.id === session.deviceId && d.accountId === account.id);
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
  next();
}

module.exports = freshViewer;
module.exports.RECHECK_MS = RECHECK_MS;
