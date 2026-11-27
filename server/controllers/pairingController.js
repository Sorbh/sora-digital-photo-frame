const os = require('os');
const crypto = require('crypto');
const net = require('net');
const QRCode = require('qrcode');
const { currentTenant, runWithTenant } = require('../context');
const { rotateSession } = require('../utils/session');
const { getDataStore } = require('../store');

const defaultPairing = require('../services/pairingService');
const accessAccounts = require('./accessAccountController');
const { passClientError } = require('../utils/httpError');
const { screenPaused } = require('../middleware/auth');
const { deviceInfo } = require('../utils/deviceInfo');
const { errorSummary } = require('../utils/errorSummary');

const START_LIMIT = 20; // new codes per IP in START_WINDOW_MS
const START_WINDOW_MS = 10 * 60 * 1000;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];
const MAX_TRACKED = 10000; // addresses remembered for the start limit
const NEARBY_LIMIT = 30; // "Sora Frame nearby" lookups per network in NEARBY_WINDOW_MS
const NEARBY_WINDOW_MS = 60 * 1000;
// Marks the browser that started a pairing, so only it can collect: one cookie
// per pairing (photoframe.pairing.<code>), so tabs starting at the same moment
// don't overwrite each other's. Not the session, so a pairing that's never
// finished leaves nothing behind on the server.
const BROWSER_COOKIE = 'photoframe.pairing.';
const BROWSER_KEY = /^[A-Za-z0-9_-]{32}$/;
const pairingFor = req => req.app.locals.pairingService || defaultPairing;

// One key per household: an IPv4 address, or the /64 an IPv6 address is in,
// since one connection usually gets a whole /64 and could rotate through it.
function addressGroup(ip) {
  const address = String(ip || 'unknown').split('%')[0];
  const v4 = address.replace(/^::ffff:/i, '');
  if (net.isIPv4(v4)) return v4;
  if (!net.isIPv6(address)) return address;
  const [head, tail] = address.split('::');
  const front = head ? head.split(':') : [];
  const back = tail ? tail.split(':') : [];
  const groups = tail === undefined ? front : [...front, ...Array(8 - front.length - back.length).fill('0'), ...back];
  return `${groups.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

// A pairing keeps only this keyed hash of its network (addressGroup), never the
// address: enough to tell two requests came from the same one. Apps with a shared
// store derive a stable key from their session secret (see createApp).
const NETWORK_KEY = crypto.randomBytes(32);
function networkKey(ip, key = NETWORK_KEY) {
  return crypto.createHmac('sha256', key).update(addressGroup(ip)).digest('base64url');
}

// NEARBY_PAIRING=off (or false, 0, no) turns "Sora Frame nearby" off; anything else leaves it on
function nearbyPairingFromEnv(value = process.env.NEARBY_PAIRING) {
  return !['off', 'false', '0', 'no'].includes(String(value || '').trim().toLowerCase());
}

/**
 * Pairing a frame by QR code, and signing paired frames back in.
 *
 *   frame   POST /api/pair/start         a code, a secret and the QR code (body: what the screen is, optional)
 *   frame   POST /api/pair/status        waiting | ready | expired, changes nothing
 *   frame   POST /api/pair/collect       a ready pairing: the device token, and signs in
 *   admin   GET  /api/admin/pair/nearby  codes waiting on the admin's own network ("Sora Frame nearby")
 *   admin   GET  /api/admin/pair/:code   the code exists and is waiting
 *   admin   POST /api/admin/pair/:code/approve
 *   frame   POST /api/auth/device        sign in with the device token
 */
class PairingController {
  constructor() {
    this.starts = new Map(); // network key -> start times
    this.nearbyLookups = new Map(); // network key -> lookup times
    this.nearbyPairing = nearbyPairingFromEnv(); // createApp({ nearbyPairing }) sets it
  }

  clientIp(req) {
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  tooManyStarts(address) {
    return this.tooMany(this.starts, address, START_LIMIT, START_WINDOW_MS);
  }

  // A sliding-window limit: true when address already had limit tries in windowMs.
  // Refused tries don't count, so a frame retrying every minute gets back in.
  tooMany(times, address, limit, windowMs) {
    const now = Date.now();
    const recent = (times.get(address) || []).filter(t => now - t < windowMs);
    const refused = recent.length >= limit;
    if (!refused) recent.push(now);
    times.delete(address); // re-added at the end, so the Map stays oldest first
    times.set(address, recent);
    if (times.size > MAX_TRACKED) this.forgetOld(times, now, windowMs);
    return refused;
  }

  // Keeps a limit's memory bounded: drop addresses with no recent tries, then
  // the longest quiet ones
  forgetOld(times, now, windowMs) {
    for (const [address, list] of times) {
      if (!list.some(t => now - t < windowMs)) times.delete(address);
    }
    for (const address of times.keys()) {
      if (times.size <= MAX_TRACKED) break;
      times.delete(address);
    }
  }

  // The address a phone can open. A frame on the server itself uses
  // localhost, which means nothing to a phone, so use the server's network
  // address instead. PUBLIC_URL overrides both.
  publicAddress(req) {
    if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
    const host = req.get('host') || 'localhost';
    const match = host.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
    const hostname = match ? match[1] : host;
    const port = match && match[2] ? `:${match[2]}` : '';
    if (!LOCAL_HOSTS.includes(hostname) && !hostname.startsWith('127.')) return `${req.protocol}://${host}`;
    return `${req.protocol}://${this.networkAddress() || hostname}${port}`;
  }

  networkAddress() {
    const addresses = Object.values(os.networkInterfaces()).flat()
      .filter(a => a && a.family === 'IPv4' && !a.internal)
      .map(a => a.address);
    const home = addresses.find(a => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a));
    return home || addresses[0] || null;
  }

  // This browser's key for a pairing, if it has one
  browserKey(req, code) {
    const cookie = BROWSER_COOKIE + defaultPairing.normalize(code);
    for (const part of String(req.headers.cookie || '').split(';')) {
      const [name, ...value] = part.trim().split('=');
      if (name === cookie && BROWSER_KEY.test(value.join('='))) return value.join('=');
    }
    return null;
  }

  browserCookieOptions(req) {
    return { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/api/pair' };
  }

  sessionAccount(account) {
    return { id: account.id, name: account.name, assignedFolders: account.assignedFolders || [] };
  }

  async start(req, res) {
    try {
      const address = networkKey(this.clientIp(req), req.app.locals.pairingNetworkKey);
      if (this.tooManyStarts(address)) {
        return res.status(429).json({ success: false, error: 'Too many codes. Try again in a few minutes.' });
      }
      const browser = crypto.randomBytes(24).toString('base64url');
      // { name, kind, platform, app }, cleaned up: a hint for the owner, nothing more
      const created = await pairingFor(req).start(address, browser, deviceInfo(req.body));
      if (!created) return res.status(503).json({ success: false, error: 'Too many frames are pairing. Try again shortly.' });

      res.cookie(BROWSER_COOKIE + created.code, browser, { ...this.browserCookieOptions(req), maxAge: defaultPairing.PAIRING_TTL_MS });
      const url = `${this.publicAddress(req)}/pair?code=${created.code}`;
      const qr = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#2a1020', light: '#ffffff' } });
      res.json({ success: true, code: created.code, secret: created.secret, expiresAt: created.expiresAt, url, qr });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error starting pairing:', errorSummary(error));
      res.status(500).json({ success: false, error: 'Could not start pairing' });
    }
  }

  // A POST with the secret in the body, so it never shows in a URL a proxy might log
  async status(req, res) {
    try {
      // Frames still running a slideshow from before #66 ask with a GET and the code
      // in the URL: answer them the same way, so a lapsed code ("expired") makes them
      // start a new one rather than show a dead code until someone reloads the page
      const { code, secret } = (req.method === 'GET' ? req.query : req.body) || {};
      res.json({ success: true, status: await pairingFor(req).status(typeof code === 'string' ? code : '', typeof secret === 'string' ? secret : '') });
    } catch (error) {
      console.error('Error checking pairing:', errorSummary(error));
      res.status(500).json({ success: false, error: 'Could not check pairing' });
    }
  }

  // A POST, so only this site's own pages can send it (middleware/sameOrigin), and
  // only from the browser that started the pairing, since it signs that browser in
  async collect(req, res) {
    try {
      const { code, secret } = req.body || {};
      const pairing = pairingFor(req);
      const result = await pairing.collect(code, secret, this.browserKey(req, code));
      if (result.status !== 'approved') return res.json({ success: true, status: result.status });

      // The frame has no session yet; having the pairing secret lets it act as the approving tenant
      let account;
      let signedOut = null; // the session's sign-in fields from before this, once they're replaced
      try {
        const tenant = await result.tenant();
        if (!tenant) return res.json({ success: true, status: 'expired' });
        account = await runWithTenant(tenant, async () => {
          const found = (await accessAccounts.loadAccounts()).find(a => a.id === result.device.accountId);
          if (found) await pairing.noteUse({ account: found, device: result.device });
          return found;
        });
        if (!account) return res.json({ success: true, status: 'expired' });
        await rotateSession(req);
        const { accessAccount, deviceId, tenantId } = req.session;
        signedOut = { accessAccount, deviceId, tenantId };
        req.session.accessAccount = this.sessionAccount(account);
        req.session.deviceId = result.device.id;
        req.session.tenantId = tenant.id;
        // Saved before answering, so a failure here still lets the frame try again
        await new Promise((resolve, reject) => req.session.save(error => (error ? reject(error) : resolve())));
      } catch (error) {
        // Not handed over: the frame can collect again on its next poll, and this
        // browser isn't signed in by the session saved as the reply goes out
        if (signedOut) {
          for (const [field, value] of Object.entries(signedOut)) {
            if (value === undefined) delete req.session[field];
            else req.session[field] = value;
          }
        }
        await result.restore();
        throw error;
      }
      res.clearCookie(BROWSER_COOKIE + defaultPairing.normalize(code), this.browserCookieOptions(req));
      res.json({
        success: true,
        status: 'approved',
        token: result.token,
        device: { id: result.device.id, name: result.device.name, language: result.device.language || null },
        account: req.session.accessAccount
      });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error collecting pairing:', errorSummary(error));
      res.status(500).json({ success: false, error: 'Could not finish pairing' });
    }
  }

  // "Sora Frame nearby": codes a screen on the owner's own network is showing right now
  // (see pairingService.nearby), so the owner can pick one instead of typing it.
  // The code as the screen shows it, what the screen said it is, and when: nothing
  // about the network.
  // Turned off (createApp({ nearbyPairing: false })): the route isn't there, for anyone
  nearbyOn(req, res, next) {
    if (!this.nearbyPairing) return res.status(404).json({ success: false, error: 'Not found', code: 'NEARBY_OFF' });
    next();
  }

  async nearby(req, res, next) {
    res.set('Cache-Control', 'no-store');
    const address = networkKey(this.clientIp(req), req.app.locals.pairingNetworkKey);
    if (this.tooMany(this.nearbyLookups, address, NEARBY_LIMIT, NEARBY_WINDOW_MS)) {
      return res.status(429).json({ success: false, error: 'Too many lookups. Try again in a minute.', code: 'RATE_LIMITED' });
    }
    try {
      const nearby = await pairingFor(req).nearby(address);
      res.json({
        nearby: nearby.map(p => ({
          code: `${p.code.slice(0, 3)}-${p.code.slice(3)}`,
          name: p.device.name,
          kind: p.device.kind,
          platform: p.device.platform,
          createdAt: new Date(p.createdAt).toISOString(),
          lastSeen: new Date(p.lastSeen).toISOString()
        }))
      });
    } catch (error) {
      next(error);
    }
  }

  async show(req, res, next) {
    try {
      const found = await pairingFor(req).lookUp(req.params.code);
      if (!found) return res.status(404).json({ success: false, error: 'This code has expired', code: 'PAIRING_EXPIRED' });
      // These hints can prefill the frame's name.
      const { name, kind, platform, app } = found.device;
      res.json({ success: true, code: found.code, expiresAt: found.expiresAt, approved: !!found.approved, name, kind, platform, app });
    } catch (error) {
      next(error);
    }
  }

  async approve(req, res) {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 60) {
      return res.status(400).json({ success: false, error: 'Give the frame a name (up to 60 characters)' });
    }
    const pairing = pairingFor(req);
    let claimed;
    let account;
    let madeAccount = false;
    // No frame was paired: the account made for it goes too, before answering
    const undoAccount = async () => {
      if (!madeAccount) return;
      await getDataStore().update('access-accounts', [], accounts => accounts.filter(a => a.id !== account.id))
        .catch(error => console.error('Could not remove the account made for a failed pairing:', error));
    };
    const finish = async () => {
      if (req.body.accountId) {
        // Not one still being made for another frame's approval: that one may yet be undone
        account = (await accessAccounts.loadAccounts()).find(a => a.id === req.body.accountId && !a.pendingPairing);
        if (!account) return { status: 400, error: 'That account no longer exists' };
      } else if (req.body.newAccount) {
        const folders = req.body.newAccount.assignedFolders || [];
        if (!Array.isArray(folders) || folders.some(f => typeof f !== 'string')) {
          return { status: 400, error: 'Folders must be a list of folder names' };
        }
        account = await accessAccounts.addAccountForFrame({ name, assignedFolders: [...new Set(folders)], pendingPairing: true });
        madeAccount = true;
      } else {
        return { status: 400, error: 'Choose an account for the frame' };
      }

      // Once the device is made, and before the frame can collect it, a new account
      // becomes one others can choose. If that fails, the approval fails as a whole.
      const finishAccount = () => getDataStore().update('access-accounts', [], accounts => accounts.map((a) => {
        if (a.id !== account.id) return a;
        const { pendingPairing, ...paired } = a;
        return paired;
      }));
      const device = await pairing.approve(claimed, { name, accountId: account.id, beforeReady: madeAccount ? finishAccount : null });
      if (!device) await undoAccount();
      return { device };
    };
    const expired = () => res.status(404).json({ success: false, error: 'This code has expired', code: 'PAIRING_EXPIRED' });
    try {
      // Take the code before creating an account or device.
      claimed = await pairing.claim(req.params.code);
      if (!claimed) return expired();
      let result;
      try {
        result = await finish();
      } catch (error) {
        await undoAccount();
        throw error;
      } finally {
        // An approved row can't be released. Keep a successful approval even if
        // the store becomes unavailable just as the owner gets their reply.
        if (!result?.device) await pairing.release(claimed);
      }
      if (result.error) return res.status(result.status).json({ success: false, error: result.error });
      if (!result.device) return expired();
      const { device } = result;
      res.json({ success: true, device: { id: device.id, name: device.name }, account: this.sessionAccount(account) });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error approving pairing:', errorSummary(error));
      res.status(500).json({ success: false, error: 'Could not pair the frame' });
    }
  }

  async signIn(req, res) {
    try {
      const ip = accessAccounts.addressKey(this.clientIp(req));
      const limit = accessAccounts.checkRateLimit(ip);
      if (!limit.allowed) return res.status(429).json({ success: false, error: limit.message, code: 'RATE_LIMITED' });

      accessAccounts.recordFailedAttempt(ip); // counted before checking, cleared on success
      const device = await defaultPairing.signIn(req.body?.token);
      const account = device && (await accessAccounts.loadAccounts()).find(a => a.id === device.accountId);
      if (!account) {
        return res.status(401).json({ success: false, error: 'This frame is no longer paired', code: 'DEVICE_UNKNOWN' });
      }
      accessAccounts.recordSuccessfulAttempt(ip);
      // "Last used" on Access (the screen's own lastSeen was noted by signIn)
      await defaultPairing.noteUse({ account });
      await rotateSession(req);
      req.session.accessAccount = this.sessionAccount(account);
      req.session.deviceId = device.id;
      // Hosted setups resolve later requests from this (see createApp resolveTenant)
      req.session.tenantId = currentTenant().id;
      res.json({ success: true, account: req.session.accessAccount, device: { id: device.id, name: device.name, language: device.language || null } });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error signing in a device:', error);
      res.status(500).json({ success: false, error: 'Could not sign in' });
    }
  }

  async listDevices(req, res) {
    try {
      const [devices, accounts] = await Promise.all([defaultPairing.listDevices(), accessAccounts.loadAccounts()]);
      const names = new Map(accounts.map(a => [a.id, a.name]));
      // paused: true for a screen the host has paused (auth isScreenPaused), shown on Access
      const paused = await Promise.all(devices.map(d => screenPaused(d.id)));
      res.json({
        success: true,
        devices: devices.map((d, i) => ({ ...d, accountName: names.get(d.accountId) || null, ...(paused[i] ? { paused: true } : {}) }))
      });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error listing devices:', error);
      res.status(500).json({ success: false, error: 'Could not list frames' });
    }
  }

  async removeDevice(req, res) {
    try {
      const removed = await defaultPairing.removeDevices(d => d.id === req.params.id);
      if (!removed) return res.status(404).json({ success: false, error: 'Frame not found' });
      res.json({ success: true });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error removing device:', error);
      res.status(500).json({ success: false, error: 'Could not remove the frame' });
    }
  }

  async setDeviceLanguage(req, res) {
    const device = await defaultPairing.setLanguage(req.params.id, req.body?.language);
    if (!device) return res.status(400).json({ success: false, error: 'Choose a supported language', code: 'INVALID_LANGUAGE' });
    res.json({ success: true, device: { id: device.id, language: device.language } });
  }

  async setOwnLanguage(req, res) {
    if (!req.session?.deviceId) return res.status(403).json({ success: false, error: 'Only a paired frame can save this setting', code: 'DEVICE_REQUIRED' });
    return this.setDeviceLanguage({ ...req, params: { id: req.session.deviceId } }, res);
  }
}

module.exports = new PairingController();
module.exports.addressGroup = addressGroup;
module.exports.networkKey = networkKey;
module.exports.nearbyPairingFromEnv = nearbyPairingFromEnv;
