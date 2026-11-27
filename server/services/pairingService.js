const crypto = require('crypto');
const { getDataStore } = require('../store');
const { currentTenant, runWithTenant } = require('../context');
const { emit } = require('../events');
const quota = require('./quotaService');
const { deviceInfo } = require('../utils/deviceInfo');
const PAIRING_TTL_MS = 10 * 60 * 1000;
// "Sora Frame nearby" (see nearby): codes made this recently, whose screen asked for
// their status this recently (it is still showing them), at most this many
const NEARBY_MAX_AGE_MS = 10 * 60 * 1000;
const NEARBY_SEEN_MS = 60 * 1000;
const NEARBY_MAX = 3;
// Shared by every tenant on a hosted server. Each address keeps at most
// MAX_PER_ADDRESS waiting codes, and when the queue is full the address holding
// the most gives up its oldest, so floods from many addresses can't lock frames out.
const MAX_PENDING = 2000;
const MAX_PER_ADDRESS = 10;
// A code still on a screen (polled this recently), or one an owner just looked up
// (and may be approving), is the last one a new code pushes out (see start)
const IN_USE_MS = 20 * 1000;
const LOOKED_UP_MS = 5 * 60 * 1000;
const SEEN_WRITE_GAP_MS = 60 * 60 * 1000;
// Removals the host's devicesRemoved hook missed, kept per library until it takes them
const REMOVALS_OUTBOX = 'device-removals';
// How long to wait before each try again; after the last, the next device change tries
const RETRY_DELAYS_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000, 60 * 60 * 1000];
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
    this.pairings = new Map(); // code -> { code, secret, createdAt, lastSeen, expiresAt, address, device, claimed, approved }
    this.retries = new Map(); // tenant id -> { timer, attempt }, for reportRemovals
    this.reporting = new Map(); // tenant id -> { running, again }, so reports don't pile up
    this.retryDelays = RETRY_DELAYS_MS;
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

  // Of a network's waiting codes (oldest first), the one to drop: one no screen
  // shows any more, else one nobody looked up, else the oldest
  leastInUse(codes, now = Date.now()) {
    const lookedUp = p => p.lookedUpAt && now - p.lookedUpAt <= LOOKED_UP_MS;
    const shown = p => now - p.lastSeen <= IN_USE_MS;
    return codes.find(p => !shown(p) && !lookedUp(p)) || codes.find(p => !lookedUp(p)) || codes[0];
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
  // address is a keyed hash of the network the request came from (see networkKey
  // in the controller), never the address itself;
  // browser is a key only the browser that asked has, so only it can collect.
  // device is what the screen said about itself (utils/deviceInfo), a hint only.
  start(address = 'unknown', browser = null, device = deviceInfo()) {
    this.dropExpired();
    const mine = this.waitingFrom(address);
    // One network keeps only its newest few codes. A home shares one: its other
    // screens, and the code its owner is typing in, go last, so a screen asking for
    // a code never takes the one another screen is showing (oldest first otherwise)
    if (mine.length >= MAX_PER_ADDRESS) this.pairings.delete(this.leastInUse(mine).code);
    if (this.pairings.size >= MAX_PENDING && !this.makeRoom(address)) return null;
    let code = this.newCode();
    while (this.pairings.has(code)) code = this.newCode();
    const now = Date.now();
    const pairing = {
      code,
      secret: crypto.randomBytes(24).toString('hex'),
      createdAt: now,
      lastSeen: now, // the frame's last status poll (see status)
      expiresAt: now + PAIRING_TTL_MS,
      address,
      browser,
      device,
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
  // beforeReady, if given, runs once the device exists and before the frame can
  // collect it; if it fails, the device is removed and the approval fails.
  async approve(codeOrPairing, { name, accountId, beforeReady = null }) {
    const pairing = typeof codeOrPairing === 'object' ? codeOrPairing : this.claim(codeOrPairing);
    if (!pairing || pairing.approved || this.pairings.get(pairing.code) !== pairing) return null;
    // The code ran out, or was replaced, while waiting: the frame has moved on to
    // a new code and could never collect this one
    const lapsed = () => pairing.expiresAt <= Date.now() || this.pairings.get(pairing.code) !== pairing;
    try {
      const { device, token } = await this.addDevice({ name, accountId, via: 'qr' });
      if (lapsed()) {
        await this.discardDevice(device.id);
        return null;
      }
      if (beforeReady) {
        try {
          await beforeReady();
        } catch (error) {
          await this.discardDevice(device.id);
          throw error;
        }
        // Checked again: finishing the account may have taken past the deadline
        if (lapsed()) {
          await this.discardDevice(device.id);
          return null;
        }
      }
      // Nothing is awaited from here on, so the frame can collect what this returns.
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
    await getDataStore().update('devices', [], async devices => {
      if (limit && devices.length >= limit) {
        throw Object.assign(new Error(`This family already has ${limit} screens. Remove one you no longer use to add this one.`),
          { status: 403, code: 'SCREEN_LIMIT', vars: { limit } });
      }
      // The quota hook's own limit, asked in the same turn so two new screens can't
      // both pass. Only here: a screen signing in again (by token or session) is
      // never a new one, so it is never asked about. The count is the exact one,
      // under this lock: a host's own index only hears of a screen after it.
      const answer = await quota.ask({ screens: 1 }, { screensInUse: devices.length });
      if (!answer || !answer.ok) {
        throw Object.assign(new Error((answer && answer.message) || 'This family has no room for another screen.'),
          { status: 403, code: 'SCREEN_LIMIT' });
      }
      return [...devices, device];
    });
    try {
      await emit('devicePaired', { deviceId: id, tenantId: currentTenant().id });
    } catch (error) {
      await getDataStore().update('devices', [], devices => devices.filter(d => d.id !== id));
      throw error;
    }
    // The host answered, so it can take any removals it missed. In the background:
    // a host slow with those must not hold up this sign-in.
    this.reportRemovals();
    return { device, token };
  }

  // The pairing for a code, when the secret is its own
  withSecret(code, secret) {
    const pairing = this.find(code);
    return pairing && sameSecret(secret, pairing.secret) ? pairing : null;
  }

  // What the waiting frame sees while it polls: waiting, ready (approved, to collect) or expired.
  // Each poll notes the frame is still there, showing its code (see nearby).
  status(code, secret) {
    const pairing = this.withSecret(code, secret);
    if (!pairing) return 'expired';
    pairing.lastSeen = Date.now();
    return pairing.approved ? 'ready' : 'waiting';
  }

  // "Sora Frame nearby": codes still waiting on the same network as the one asking
  // (address is the same keyed hash start() was given), made in the last ten
  // minutes and polled in the last minute, newest first, at most NEARBY_MAX
  nearby(address) {
    if (!address) return [];
    const now = Date.now();
    return [...this.pairings.values()]
      .filter(p => p.address === address && !p.approved && !p.claimed && p.expiresAt > now &&
        now - p.createdAt <= NEARBY_MAX_AGE_MS && now - p.lastSeen <= NEARBY_SEEN_MS)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, NEARBY_MAX);
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

  // A frame was just used, so Access can say when: its screen's lastSeen and its
  // account's lastAccessed ("Last used"). Pass what was already read; each is
  // written only when it is missing or older than SEEN_WRITE_GAP_MS, so a frame
  // playing all day writes about once an hour.
  async noteUse({ account = null, device = null } = {}) {
    const now = Date.now();
    const at = new Date(now).toISOString();
    const stale = when => !when || !(now - Date.parse(when) < SEEN_WRITE_GAP_MS);
    const writes = [];
    if (device && stale(device.lastSeen)) {
      writes.push(getDataStore().update('devices', [], devices => devices.map(d =>
        d.id === device.id ? { ...d, lastSeen: at } : d)));
    }
    if (account && stale(account.lastAccessed)) {
      writes.push(getDataStore().update('access-accounts', [], accounts => accounts.map(a =>
        a.id === account.id ? { ...a, lastAccessed: at } : a)));
    }
    await Promise.all(writes);
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
    await this.noteUse({ device });
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
  // devicesRemoved hook fails, so it never counts toward the screen limit; the
  // host then hears about it later. Kept to report before it's removed, so the
  // removal can't be lost between the two (see reportRemovals).
  async discardDevice(id) {
    try {
      await getDataStore().update(REMOVALS_OUTBOX, [], pending => [...new Set([...pending, id])]);
    } catch (saveError) {
      // Nowhere to keep it: tell the host first and only then remove it here, so
      // the two never disagree. If the host can't hear it either, the device stays.
      console.error('Could not keep a discarded device to report:', saveError);
      await emit('devicesRemoved', { deviceIds: [id], tenantId: currentTenant().id });
      await getDataStore().update('devices', [], devices => devices.filter(d => d.id !== id));
      return;
    }
    await this.reportRemovals();
  }

  // Removes the devices kept in the outbox and sends devicesRemoved for them,
  // along with any earlier ones the host missed. Never throws: what's still
  // unreported stays kept and is tried again later. One report at a time per
  // library; calls during one share a single follow-up.
  reportRemovals() {
    const tenant = currentTenant();
    let state = this.reporting.get(tenant.id);
    if (!state) {
      state = { running: null, again: null };
      this.reporting.set(tenant.id, state);
    }
    if (!state.running) {
      state.running = this.sendRemovals(tenant).finally(() => {
        state.running = null;
        if (!state.again) this.reporting.delete(tenant.id);
      });
      return state.running;
    }
    if (!state.again) {
      state.again = state.running.then(() => {
        state.again = null;
        return runWithTenant(tenant, () => this.reportRemovals());
      });
    }
    return state.again;
  }

  async sendRemovals(tenant) {
    let left;
    try {
      const pending = await getDataStore().get(REMOVALS_OUTBOX, []);
      if (!Array.isArray(pending) || !pending.length) return;
      // Gone here first (again, after a restart in between), so they never
      // count toward the screen limit while the host is away
      await getDataStore().update('devices', [], devices => devices.filter(d => !pending.includes(d.id)));
      await emit('devicesRemoved', { deviceIds: pending, tenantId: tenant.id });
      await getDataStore().update(REMOVALS_OUTBOX, [], current => {
        left = current.filter(id => !pending.includes(id));
        return left;
      });
    } catch (error) {
      console.error('Could not report removed devices yet:', error);
      this.retryLater();
      return;
    }
    const retry = this.retries.get(tenant.id);
    if (retry) clearTimeout(retry.timer);
    this.retries.delete(tenant.id);
    if (left.length) this.retryLater();
  }

  // Tries reportRemovals again for this library after the next delay, unless one
  // is already waiting. After the last delay, the library's next device change does.
  retryLater() {
    const tenant = currentTenant();
    const retry = this.retries.get(tenant.id) || { timer: null, attempt: 0 };
    if (retry.timer) return;
    const delay = this.retryDelays[retry.attempt];
    if (delay === undefined) {
      this.retries.delete(tenant.id);
      return;
    }
    retry.timer = setTimeout(() => {
      retry.timer = null;
      retry.attempt += 1;
      runWithTenant(tenant, () => this.reportRemovals());
    }, delay);
    retry.timer.unref?.();
    this.retries.set(tenant.id, retry);
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
    this.reportRemovals(); // in the background, as in addDevice
    return removed.length;
  }
}

module.exports = new PairingService();
module.exports.deviceIdFromToken = deviceIdFromToken;
module.exports.PAIRING_TTL_MS = PAIRING_TTL_MS;
module.exports.MAX_PENDING = MAX_PENDING;
module.exports.MAX_PER_ADDRESS = MAX_PER_ADDRESS;
module.exports.IN_USE_MS = IN_USE_MS;
module.exports.NEARBY_MAX = NEARBY_MAX;
module.exports.NEARBY_SEEN_MS = NEARBY_SEEN_MS;
