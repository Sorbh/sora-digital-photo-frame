const os = require('os');
const QRCode = require('qrcode');
const { currentTenant, runWithTenant } = require('../context');
const { rotateSession } = require('../utils/session');

const pairing = require('../services/pairingService');
const accessAccounts = require('./accessAccountController');

const START_LIMIT = 20; // new codes per IP in START_WINDOW_MS
const START_WINDOW_MS = 10 * 60 * 1000;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

/**
 * Pairing a frame by QR code, and signing paired frames back in.
 *
 *   frame   POST /api/pair/start         a code, a secret and the QR code
 *   frame   GET  /api/pair/status        waiting | approved (+ device token) | expired
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

  tooManyStarts(ip) {
    const now = Date.now();
    const recent = (this.starts.get(ip) || []).filter(t => now - t < START_WINDOW_MS);
    // Refused tries don't count, so a frame retrying every minute gets back in
    const refused = recent.length >= START_LIMIT;
    if (!refused) recent.push(now);
    this.starts.set(ip, recent);
    return refused;
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

  sessionAccount(account) {
    return { id: account.id, name: account.name, assignedFolders: account.assignedFolders || [] };
  }

  async start(req, res) {
    try {
      if (this.tooManyStarts(this.clientIp(req))) {
        return res.status(429).json({ success: false, error: 'Too many codes. Try again in a few minutes.' });
      }
      const created = pairing.start();
      if (!created) return res.status(503).json({ success: false, error: 'Too many frames are pairing. Try again shortly.' });

      const url = `${this.publicAddress(req)}/pair?code=${created.code}`;
      const qr = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#2a1020', light: '#ffffff' } });
      res.json({ success: true, code: created.code, secret: created.secret, expiresAt: created.expiresAt, url, qr });
    } catch (error) {
      console.error('Error starting pairing:', error);
      res.status(500).json({ success: false, error: 'Could not start pairing' });
    }
  }

  async status(req, res) {
    try {
      const result = pairing.collect(req.query.code, req.query.secret);
      if (result.status !== 'approved') return res.json({ success: true, status: result.status });

      // The frame has no session yet; having the pairing secret lets it act as the approving tenant
      const account = await runWithTenant(result.tenant, async () => {
        const found = (await accessAccounts.loadAccounts()).find(a => a.id === result.device.accountId);
        if (found) await pairing.markSeen(result.device.id);
        return found;
      });
      if (!account) return res.json({ success: true, status: 'expired' });
      await rotateSession(req);
      req.session.accessAccount = this.sessionAccount(account);
      req.session.tenantId = result.tenant.id;
      res.json({
        success: true,
        status: 'approved',
        token: result.token,
        device: { id: result.device.id, name: result.device.name },
        account: req.session.accessAccount
      });
    } catch (error) {
      console.error('Error checking pairing:', error);
      res.status(500).json({ success: false, error: 'Could not check pairing' });
    }
  }

  async show(req, res) {
    const found = pairing.find(req.params.code);
    if (!found) return res.status(404).json({ success: false, error: 'This code has expired', code: 'PAIRING_EXPIRED' });
    res.json({ success: true, code: found.code, expiresAt: found.expiresAt, approved: !!found.approved });
  }

  async approve(req, res) {
    try {
      const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
      if (!name || name.length > 60) {
        return res.status(400).json({ success: false, error: 'Give the frame a name (up to 60 characters)' });
      }
      const found = pairing.find(req.params.code);
      if (!found || found.approved) {
        return res.status(404).json({ success: false, error: 'This code has expired', code: 'PAIRING_EXPIRED' });
      }

      let account;
      if (req.body.accountId) {
        account = (await accessAccounts.loadAccounts()).find(a => a.id === req.body.accountId);
        if (!account) return res.status(400).json({ success: false, error: 'That account no longer exists' });
      } else if (req.body.newAccount) {
        const folders = req.body.newAccount.assignedFolders || [];
        if (!Array.isArray(folders) || folders.some(f => typeof f !== 'string')) {
          return res.status(400).json({ success: false, error: 'Folders must be a list of folder names' });
        }
        account = await accessAccounts.addAccountWithRandomPin({ name, assignedFolders: [...new Set(folders)] });
      } else {
        return res.status(400).json({ success: false, error: 'Choose an account for the frame' });
      }

      const device = await pairing.approve(found.code, { name, accountId: account.id });
      if (!device) return res.status(404).json({ success: false, error: 'This code has expired', code: 'PAIRING_EXPIRED' });
      res.json({ success: true, device: { id: device.id, name: device.name }, account: this.sessionAccount(account) });
    } catch (error) {
      console.error('Error approving pairing:', error);
      res.status(500).json({ success: false, error: 'Could not pair the frame' });
    }
  }

  async signIn(req, res) {
    try {
      const ip = this.clientIp(req);
      const limit = accessAccounts.checkRateLimit(ip);
      if (!limit.allowed) return res.status(429).json({ success: false, error: limit.message, code: 'RATE_LIMITED' });

      const device = await pairing.signIn(req.body?.token);
      const account = device && (await accessAccounts.loadAccounts()).find(a => a.id === device.accountId);
      if (!account) {
        accessAccounts.recordFailedAttempt(ip);
        return res.status(401).json({ success: false, error: 'This frame is no longer paired', code: 'DEVICE_UNKNOWN' });
      }
      accessAccounts.recordSuccessfulAttempt(ip);
      await rotateSession(req);
      req.session.accessAccount = this.sessionAccount(account);
      // Hosted setups resolve later requests from this (see createApp resolveTenant)
      req.session.tenantId = currentTenant().id;
      res.json({ success: true, account: req.session.accessAccount, device: { id: device.id, name: device.name } });
    } catch (error) {
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
      console.error('Error removing device:', error);
      res.status(500).json({ success: false, error: 'Could not remove the frame' });
    }
  }
}

module.exports = new PairingController();
