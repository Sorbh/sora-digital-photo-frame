const crypto = require('crypto');
const { getDataStore } = require('../store');
const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 50;
const SEEN_WRITE_GAP_MS = 60 * 60 * 1000;
// No 0/O, 1/I/L: the code is read off a frame across the room
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const hash = token => crypto.createHash('sha256').update(token).digest('hex');

/**
 * Pairing a frame by QR code. The frame asks for a short code and shows it as
 * a QR code; an admin scans it, approves, and the frame collects a device
 * token it keeps for good. Pairings live in memory for ten minutes; paired
 * frames are kept in data/devices.json with only a hash of their token.
 */
class PairingService {
  constructor() {
    this.pairings = new Map(); // code -> { code, secret, expiresAt, approved }
  }

  normalize(code) {
    return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  newCode() {
    const bytes = crypto.randomBytes(6);
    return Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  }

  dropExpired() {
    const now = Date.now();
    for (const [code, pairing] of this.pairings) {
      if (pairing.expiresAt <= now) this.pairings.delete(code);
    }
  }

  // A new pairing for a frame: the code goes in the QR, the secret stays on the frame
  start() {
    this.dropExpired();
    if (this.pairings.size >= MAX_PENDING) return null;
    let code = this.newCode();
    while (this.pairings.has(code)) code = this.newCode();
    const pairing = {
      code,
      secret: crypto.randomBytes(24).toString('hex'),
      expiresAt: Date.now() + PAIRING_TTL_MS,
      approved: null
    };
    this.pairings.set(code, pairing);
    return pairing;
  }

  find(code) {
    const pairing = this.pairings.get(this.normalize(code));
    if (!pairing) return null;
    if (pairing.expiresAt <= Date.now()) {
      this.pairings.delete(pairing.code);
      return null;
    }
    return pairing;
  }

  // The admin said yes: make the device and hold its token for the frame to collect
  async approve(code, { name, accountId }) {
    const pairing = this.find(code);
    if (!pairing || pairing.approved) return null;
    const token = crypto.randomBytes(32).toString('base64url');
    const device = {
      id: `dev_${crypto.randomBytes(6).toString('hex')}`,
      name,
      accountId,
      tokenHash: hash(token),
      pairedAt: new Date().toISOString(),
      lastSeen: null
    };
    await getDataStore().update('devices', [], devices => [...devices, device]);
    pairing.approved = { token, device };
    return device;
  }

  // What the waiting frame sees. An approved pairing is handed over once, then gone.
  collect(code, secret) {
    const pairing = this.find(code);
    if (!pairing || typeof secret !== 'string' || secret.length !== pairing.secret.length
      || !crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(pairing.secret))) {
      return { status: 'expired' };
    }
    if (!pairing.approved) return { status: 'waiting' };
    this.pairings.delete(pairing.code);
    return { status: 'approved', ...pairing.approved };
  }

  // The frame just showed up, so Access can say when it was last seen
  async markSeen(id) {
    await getDataStore().update('devices', [], devices => devices.map(device =>
      device.id === id ? { ...device, lastSeen: new Date().toISOString() } : device));
  }

  async loadDevices() {
    return getDataStore().get('devices', []).catch(() => []);
  }

  async saveDevices(devices) {
    await getDataStore().set('devices', devices);
  }

  // The paired device for a token, or null
  async signIn(token) {
    if (typeof token !== 'string' || !token) return null;
    const devices = await this.loadDevices();
    const device = devices.find(d => d.tokenHash === hash(token));
    if (!device) return null;
    if (!device.lastSeen || Date.now() - Date.parse(device.lastSeen) > SEEN_WRITE_GAP_MS) {
      await getDataStore().update('devices', [], current => current.map(d =>
        d.id === device.id ? { ...d, lastSeen: new Date().toISOString() } : d));
    }
    return device;
  }

  async listDevices() {
    const devices = await this.loadDevices();
    return devices.map(({ tokenHash, ...device }) => device);
  }

  async removeDevices(match) {
    let removed = 0;
    await getDataStore().update('devices', [], devices => {
      const kept = devices.filter(d => !match(d));
      removed = devices.length - kept.length;
      return kept;
    });
    return removed;
  }
}

module.exports = new PairingService();
module.exports.PAIRING_TTL_MS = PAIRING_TTL_MS;
