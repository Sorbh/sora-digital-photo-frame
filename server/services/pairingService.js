const crypto = require('crypto');
const { getDataStore } = require('../store');
const { currentTenant } = require('../context');
const { emit } = require('../events');
const PAIRING_TTL_MS = 10 * 60 * 1000;
// Shared by every tenant on a hosted server. Each address keeps at most
// MAX_PER_ADDRESS waiting codes, and when the queue is full the address holding
// the most gives up its oldest, so floods from many addresses can't lock frames out.
const MAX_PENDING = 2000;
const MAX_PER_ADDRESS = 5;
const SEEN_WRITE_GAP_MS = 60 * 60 * 1000;
// No 0/O, 1/I/L: the code is read off a frame across the room
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const hash = token => crypto.createHash('sha256').update(token).digest('hex');
// Compares secrets in constant time; anything that isn't a string of the same bytes is different
const sameSecret = (given, real) => {
  if (typeof given !== 'string' || typeof real !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(real);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Device tokens are "<deviceId>.<secret>", so a hosted setup can tell which
// tenant a frame belongs to before looking it up. Older tokens are just the secret.
const TOKEN_PATTERN = /^(dev_[0-9a-f]{12})\.[A-Za-z0-9_-]{43}$/;
const deviceIdFromToken = token => (typeof token === 'string' && TOKEN_PATTERN.exec(token)?.[1]) || null;

/**
 * Screens of a library. A frame joins by QR code or by PIN (see addDevice).
 *
 * Pairing by QR code: the frame asks for a short code and shows it as
 * a QR code; an admin scans it, approves, and the frame collects a device
 * token it keeps for good. Pairings live in memory for ten minutes; paired
 * frames are kept in data/devices.json with only a hash of their token.
 */
class PairingService {
  constructor() {
    this.pairings = new Map(); // code -> { code, secret, expiresAt, address, claimed, approved }
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

  // Codes still waiting for an admin, oldest first (a Map keeps the order they were made in)
  waitingFrom(address) {
    return [...this.pairings.values()].filter(p => !p.approved && !p.claimed && p.address === address);
  }

  // The queue is full: the address with the most waiting codes, if it has more
  // than the one asking would, loses its oldest. False if nobody has more.
  makeRoom(address) {
    const waiting = new Map(); // address -> its codes, oldest first
    for (const pairing of this.pairings.values()) {
      if (pairing.approved || pairing.claimed) continue;
      if (!waiting.has(pairing.address)) waiting.set(pairing.address, []);
      waiting.get(pairing.address).push(pairing);
    }
    const asking = (waiting.get(address) || []).length + 1;
    let busiest = null;
    for (const codes of waiting.values()) if (!busiest || codes.length > busiest.length) busiest = codes;
    if (!busiest || busiest.length <= asking) return false;
    this.pairings.delete(busiest[0].code);
    return true;
  }

  // A new pairing for a frame: the code goes in the QR, the secret stays on the frame.
  // address is where the request came from (see addressGroup in the controller);
  // browser is a key only the browser that asked has, so only it can collect.
  start(address = 'unknown', browser = null) {
    this.dropExpired();
    const mine = this.waitingFrom(address);
    // A frame that keeps asking keeps only its newest few codes
    if (mine.length >= MAX_PER_ADDRESS) this.pairings.delete(mine[0].code);
    if (this.pairings.size >= MAX_PENDING && !this.makeRoom(address)) return null;
    let code = this.newCode();
    while (this.pairings.has(code)) code = this.newCode();
    const pairing = {
      code,
      secret: crypto.randomBytes(24).toString('hex'),
      expiresAt: Date.now() + PAIRING_TTL_MS,
      address,
      browser,
      claimed: false, // an admin is approving it (see claim)
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

  // Takes a waiting pairing for one approval, before anything is created, so two
  // approvals at the same time can't both go ahead. The pairing, or null when it's
  // gone or already taken. Give it back with release() if the approval fails.
  claim(code) {
    const pairing = this.find(code);
    if (!pairing || pairing.claimed) return null;
    pairing.claimed = true;
    return pairing;
  }

  release(pairing) {
    if (!pairing.approved) pairing.claimed = false;
  }

  // The admin said yes: make the device and hold its token for the frame to collect.
  // Pass a pairing from claim(), or a code to claim it here.
  async approve(codeOrPairing, { name, accountId }) {
    const pairing = typeof codeOrPairing === 'object' ? codeOrPairing : this.claim(codeOrPairing);
    if (!pairing || pairing.approved || this.pairings.get(pairing.code) !== pairing) return null;
    try {
      const { device, token } = await this.addDevice({ name, accountId, via: 'qr' });
      // The code ran out while the device was being made: the frame has moved on
      // to a new code and could never collect this one, so undo it
      if (pairing.expiresAt <= Date.now() || this.pairings.get(pairing.code) !== pairing) {
        await this.discardDevice(device.id);
        return null;
      }
      // The frame collects this without a session; it runs as the approving tenant
      pairing.approved = { token, device, tenant: currentTenant() };
      return device;
    } finally {
      this.release(pairing);
    }
  }

  // Every way a screen joins (QR code or PIN) ends here, so the same screen
  // limit applies to all of them. Returns the device and its token.
  async addDevice({ name, accountId, via }) {
    const id = `dev_${crypto.randomBytes(6).toString('hex')}`;
    const token = `${id}.${crypto.randomBytes(32).toString('base64url')}`;
    const device = {
      id,
      name,
      accountId,
      via,
      tokenHash: hash(token),
      pairedAt: new Date().toISOString(),
      lastSeen: null
    };
    // MAX_SCREENS caps screens per library (0, the default, means no cap)
    const limit = parseInt(process.env.MAX_SCREENS, 10) || 0;
    await getDataStore().update('devices', [], devices => {
      if (limit && devices.length >= limit) {
        throw Object.assign(new Error(`This family already has ${limit} screens. Remove one you no longer use to add this one.`),
          { status: 403, code: 'SCREEN_LIMIT', vars: { limit } });
      }
      return [...devices, device];
    });
    try {
      await emit('devicePaired', { deviceId: id, tenantId: currentTenant().id });
    } catch (error) {
      await getDataStore().update('devices', [], devices => devices.filter(d => d.id !== id));
      throw error;
    }
    return { device, token };
  }

  // The pairing for a code, when the secret is its own
  withSecret(code, secret) {
    const pairing = this.find(code);
    return pairing && sameSecret(secret, pairing.secret) ? pairing : null;
  }

  // What the waiting frame sees while it polls: waiting, ready (approved, to collect) or expired
  status(code, secret) {
    const pairing = this.withSecret(code, secret);
    if (!pairing) return 'expired';
    return pairing.approved ? 'ready' : 'waiting';
  }

  // The frame takes its approved pairing, from the browser that started it.
  // Handed over once, then gone.
  collect(code, secret, browser) {
    const pairing = this.withSecret(code, secret);
    if (!pairing || !sameSecret(browser, pairing.browser)) return { status: 'expired' };
    if (!pairing.approved) return { status: 'waiting' };
    this.pairings.delete(pairing.code);
    return {
      status: 'approved',
      ...pairing.approved,
      // If handing over fails, the frame can collect again on its next poll
      restore: () => this.pairings.set(pairing.code, pairing)
    };
  }

  // The frame just showed up, so Access can say when it was last seen
  async markSeen(id) {
    await getDataStore().update('devices', [], devices => devices.map(device =>
      device.id === id ? { ...device, lastSeen: new Date().toISOString() } : device));
  }

  async loadDevices() {
    // A client error means there's no tenant to look in, so no such device.
    // Anything else is an outage, and must not look like an unpaired frame.
    return getDataStore().get('devices', []).catch((error) => {
      if (error.status >= 400 && error.status < 500) return [];
      throw error;
    });
  }

  async saveDevices(devices) {
    await getDataStore().set('devices', devices);
  }

  // The paired device for a token, or null
  async signIn(token) {
    if (typeof token !== 'string' || !token) return null;
    const devices = await this.loadDevices();
    const id = deviceIdFromToken(token);
    const device = id
      ? devices.find(d => d.id === id && crypto.timingSafeEqual(Buffer.from(d.tokenHash), Buffer.from(hash(token))))
      : devices.find(d => d.tokenHash === hash(token));
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

  async setLanguage(id, language) {
    const allowed = ['en', 'es', 'fr', 'de', 'pt-BR', 'it', 'nl', 'hi', 'ja', 'zh-CN', 'ar'];
    if (!allowed.includes(language)) return null;
    let changed = null;
    await getDataStore().update('devices', [], devices => devices.map(device => {
      if (device.id !== id) return device;
      changed = { ...device, language };
      return changed;
    }));
    return changed;
  }

  // Removes a device nobody ever got the token for. It goes even if the host's
  // devicesRemoved hook fails, so it never counts toward the screen limit.
  async discardDevice(id) {
    await getDataStore().update('devices', [], devices => devices.filter(d => d.id !== id));
    try {
      await emit('devicesRemoved', { deviceIds: [id], tenantId: currentTenant().id });
    } catch (error) {
      console.error('Could not report a discarded device:', error);
    }
  }

  async removeDevices(match) {
    let removed = [];
    await getDataStore().update('devices', [], devices => {
      removed = devices.filter(d => match(d));
      return devices.filter(d => !match(d));
    });
    if (!removed.length) return 0;
    try {
      await emit('devicesRemoved', { deviceIds: removed.map(d => d.id), tenantId: currentTenant().id });
    } catch (error) {
      // As in approve(): the action fails as a whole, so the host's index never misses it
      await getDataStore().update('devices', [], devices => [...devices, ...removed]);
      throw error;
    }
    return removed.length;
  }
}

module.exports = new PairingService();
module.exports.deviceIdFromToken = deviceIdFromToken;
module.exports.PAIRING_TTL_MS = PAIRING_TTL_MS;
module.exports.MAX_PENDING = MAX_PENDING;
module.exports.MAX_PER_ADDRESS = MAX_PER_ADDRESS;
