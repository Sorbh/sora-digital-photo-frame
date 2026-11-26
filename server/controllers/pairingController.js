const os = require('os');
const crypto = require('crypto');
const net = require('net');
const QRCode = require('qrcode');
const { currentTenant, runWithTenant } = require('../context');
const { rotateSession } = require('../utils/session');
const { getDataStore } = require('../store');

const pairing = require('../services/pairingService');
const accessAccounts = require('./accessAccountController');
const { passClientError } = require('../utils/httpError');

const START_LIMIT = 20; // new codes per IP in START_WINDOW_MS
const START_WINDOW_MS = 10 * 60 * 1000;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];
const MAX_TRACKED = 10000; // addresses remembered for the start limit
// Marks the browser that started a pairing, so only it can collect: one cookie
// per pairing (photoframe.pairing.<code>), so tabs starting at the same moment
// don't overwrite each other's. Not the session, so a pairing that's never
// finished leaves nothing behind on the server.
const BROWSER_COOKIE = 'photoframe.pairing.';
const BROWSER_KEY = /^[A-Za-z0-9_-]{32}$/;

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

/**
 * Pairing a frame by QR code, and signing paired frames back in.
 *
 *   frame   POST /api/pair/start         a code, a secret and the QR code
 *   frame   POST /api/pair/status        waiting | ready | expired, changes nothing
 *   frame   POST /api/pair/collect       a ready pairing: the device token, and signs in
 *   admin   GET  /api/admin/pair/:code   the code exists and is waiting
 *   admin   POST /api/admin/pair/:code/approve
 *   frame   POST /api/auth/device        sign in with the device token
 */
class PairingController {
  constructor() {
    this.starts = new Map(); // ip -> start times
  }

  clientIp(req) {
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  tooManyStarts(address) {
    const now = Date.now();
    const recent = (this.starts.get(address) || []).filter(t => now - t < START_WINDOW_MS);
    // Refused tries don't count, so a frame retrying every minute gets back in
    const refused = recent.length >= START_LIMIT;
    if (!refused) recent.push(now);
    this.starts.delete(address); // re-added at the end, so the Map stays oldest first
    this.starts.set(address, recent);
    if (this.starts.size > MAX_TRACKED) this.forgetOldStarts(now);
    return refused;
  }

  // Keeps the start limit's memory bounded: drop addresses with no recent
  // starts, then the longest quiet ones
  forgetOldStarts(now) {
    for (const [address, times] of this.starts) {
      if (!times.some(t => now - t < START_WINDOW_MS)) this.starts.delete(address);
    }
    for (const address of this.starts.keys()) {
      if (this.starts.size <= MAX_TRACKED) break;
      this.starts.delete(address);
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
    const cookie = BROWSER_COOKIE + pairing.normalize(code);
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
      const address = addressGroup(this.clientIp(req));
      if (this.tooManyStarts(address)) {
        return res.status(429).json({ success: false, error: 'Too many codes. Try again in a few minutes.' });
      }
      const browser = crypto.randomBytes(24).toString('base64url');
      const created = pairing.start(address, browser);
      if (!created) return res.status(503).json({ success: false, error: 'Too many frames are pairing. Try again shortly.' });

      res.cookie(BROWSER_COOKIE + created.code, browser, { ...this.browserCookieOptions(req), maxAge: pairing.PAIRING_TTL_MS });
      const url = `${this.publicAddress(req)}/pair?code=${created.code}`;
      const qr = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#2a1020', light: '#ffffff' } });
      res.json({ success: true, code: created.code, secret: created.secret, expiresAt: created.expiresAt, url, qr });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error starting pairing:', error);
      res.status(500).json({ success: false, error: 'Could not start pairing' });
    }
  }

  // A POST with the secret in the body, so it never shows in a URL a proxy might log
  async status(req, res) {
    try {
      const { code, secret } = req.body || {};
      res.json({ success: true, status: pairing.status(code, secret) });
    } catch (error) {
      console.error('Error checking pairing:', error);
      res.status(500).json({ success: false, error: 'Could not check pairing' });
    }
  }

  // A POST, so only this site's own pages can send it (middleware/sameOrigin), and
  // only from the browser that started the pairing, since it signs that browser in
  async collect(req, res) {
    try {
      const { code, secret } = req.body || {};
      const result = pairing.collect(code, secret, this.browserKey(req, code));
      if (result.status !== 'approved') return res.json({ success: true, status: result.status });

      // The frame has no session yet; having the pairing secret lets it act as the approving tenant
      let account;
      let signedOut = null; // the session's sign-in fields from before this, once they're replaced
      try {
        account = await runWithTenant(result.tenant, async () => {
          const found = (await accessAccounts.loadAccounts()).find(a => a.id === result.device.accountId);
          if (found) await pairing.markSeen(result.device.id);
          return found;
        });
        if (!account) return res.json({ success: true, status: 'expired' });
        await rotateSession(req);
        const { accessAccount, deviceId, tenantId } = req.session;
        signedOut = { accessAccount, deviceId, tenantId };
        req.session.accessAccount = this.sessionAccount(account);
        req.session.deviceId = result.device.id;
        req.session.tenantId = result.tenant.id;
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
        result.restore();
        throw error;
      }
      res.clearCookie(BROWSER_COOKIE + pairing.normalize(code), this.browserCookieOptions(req));
      res.json({
        success: true,
        status: 'approved',
        token: result.token,
        device: { id: result.device.id, name: result.device.name, language: result.device.language || null },
        account: req.session.accessAccount
      });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error collecting pairing:', error);
      res.status(500).json({ success: false, error: 'Could not finish pairing' });
    }
  }

  async show(req, res) {
    const found = pairing.find(req.params.code);
    if (!found) return res.status(404).json({ success: false, error: 'This code has expired', code: 'PAIRING_EXPIRED' });
    res.json({ success: true, code: found.code, expiresAt: found.expiresAt, approved: !!found.approved });
  }

  async approve(req, res) {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 60) {
      return res.status(400).json({ success: false, error: 'Give the frame a name (up to 60 characters)' });
    }
    // Taken before the account or device is made, so a second approval at the same time stops here
    const claimed = pairing.claim(req.params.code);
    if (!claimed) {
      return res.status(404).json({ success: false, error: 'This code has expired', code: 'PAIRING_EXPIRED' });
    }
    let account;
    let madeAccount = false;
    // No frame was paired: the account made for it goes too, before answering
    const undoAccount = async () => {
      if (!madeAccount) return;
      await getDataStore().update('access-accounts', [], accounts => accounts.filter(a => a.id !== account.id))
        .catch(error => console.error('Could not remove the account made for a failed pairing:', error));
    };
    try {
      if (req.body.accountId) {
        // Not one still being made for another frame's approval: that one may yet be undone
        account = (await accessAccounts.loadAccounts()).find(a => a.id === req.body.accountId && !a.pendingPairing);
        if (!account) return res.status(400).json({ success: false, error: 'That account no longer exists' });
      } else if (req.body.newAccount) {
        const folders = req.body.newAccount.assignedFolders || [];
        if (!Array.isArray(folders) || folders.some(f => typeof f !== 'string')) {
          return res.status(400).json({ success: false, error: 'Folders must be a list of folder names' });
        }
        account = await accessAccounts.addAccountWithRandomPin({ name, assignedFolders: [...new Set(folders)], pendingPairing: true });
        madeAccount = true;
      } else {
        return res.status(400).json({ success: false, error: 'Choose an account for the frame' });
      }

      // Once the device is made, and before the frame can collect it, a new account
      // becomes one others can choose. If that fails, the approval fails as a whole.
      const finishAccount = () => getDataStore().update('access-accounts', [], accounts => accounts.map((a) => {
        if (a.id !== account.id) return a;
        const { pendingPairing, ...paired } = a;
        return paired;
      }));
      const device = await pairing.approve(claimed, { name, accountId: account.id, beforeReady: madeAccount ? finishAccount : null });
      if (!device) {
        await undoAccount();
        return res.status(404).json({ success: false, error: 'This code has expired', code: 'PAIRING_EXPIRED' });
      }
      res.json({ success: true, device: { id: device.id, name: device.name }, account: this.sessionAccount(account) });
    } catch (error) {
      await undoAccount();
      if (passClientError(res, error)) return;
      console.error('Error approving pairing:', error);
      res.status(500).json({ success: false, error: 'Could not pair the frame' });
    } finally {
      pairing.release(claimed);
    }
  }

  async signIn(req, res) {
    try {
      const ip = accessAccounts.addressKey(this.clientIp(req));
      const limit = accessAccounts.checkRateLimit(ip);
      if (!limit.allowed) return res.status(429).json({ success: false, error: limit.message, code: 'RATE_LIMITED' });

      accessAccounts.recordFailedAttempt(ip); // counted before checking, cleared on success
      const device = await pairing.signIn(req.body?.token);
      const account = device && (await accessAccounts.loadAccounts()).find(a => a.id === device.accountId);
      if (!account) {
        return res.status(401).json({ success: false, error: 'This frame is no longer paired', code: 'DEVICE_UNKNOWN' });
      }
      accessAccounts.recordSuccessfulAttempt(ip);
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
      const [devices, accounts] = await Promise.all([pairing.listDevices(), accessAccounts.loadAccounts()]);
      const names = new Map(accounts.map(a => [a.id, a.name]));
      res.json({ success: true, devices: devices.map(d => ({ ...d, accountName: names.get(d.accountId) || null })) });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error listing devices:', error);
      res.status(500).json({ success: false, error: 'Could not list frames' });
    }
  }

  async removeDevice(req, res) {
    try {
      const removed = await pairing.removeDevices(d => d.id === req.params.id);
      if (!removed) return res.status(404).json({ success: false, error: 'Frame not found' });
      res.json({ success: true });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error removing device:', error);
      res.status(500).json({ success: false, error: 'Could not remove the frame' });
    }
  }

  async setDeviceLanguage(req, res) {
    const device = await pairing.setLanguage(req.params.id, req.body?.language);
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
