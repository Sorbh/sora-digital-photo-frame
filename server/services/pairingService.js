const crypto = require('crypto');
const { getDataStore } = require('../store');
const { currentTenant, runWithTenant } = require('../context');
const { emit } = require('../events');
const quota = require('./quotaService');
const MemoryPairingStore = require('./memoryPairingStore');
const documentDeviceStore = require('./documentDeviceStore');
const { deviceInfo } = require('../utils/deviceInfo');
const PAIRING_TTL_MS = 10 * 60 * 1000;
// "Sora Frame nearby" (see nearby): codes made this recently, whose screen asked for
// their status this recently (it is still showing them), at most this many
const NEARBY_MAX_AGE_MS = 10 * 60 * 1000;
const NEARBY_SEEN_MS = 10 * 1000;
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
const DEVICE_SEEN_FLUSH_MS = 60 * 1000;
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
 * token it keeps for good. Pairings last ten minutes; paired
 * frames are kept in a device store with only a hash of their token.
 */
class PairingService {
  constructor(store = null, resolveTenant = null, deviceStore = documentDeviceStore) {
    this.store = store || new MemoryPairingStore();
    this.resolveTenant = resolveTenant;
    this.pairings = this.store.rows;
    this.deviceStore = deviceStore;
    this.seenAt = new Map(); // tenant -> device -> dirty timestamp in ms
    this.seenTimer = null;
    this.flushingSeen = null;
    this.retries = new Map(); // tenant id -> { timer, attempt }, for reportRemovals
    this.reporting = new Map(); // tenant id -> { running, again }
    this.retryDelays = RETRY_DELAYS_MS;
  }

  normalize(code) {
    return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  newCode() {
    const bytes = crypto.randomBytes(6);
    return Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  }

  // Of a network's waiting codes (oldest first), the one to drop: one no screen
  // shows any more, else one nobody looked up, else the oldest
  leastInUse(codes, now = Date.now()) {
    const lookedUp = p => p.lookedUpAt && now - p.lookedUpAt <= LOOKED_UP_MS;
    const shown = p => now - p.lastSeen <= IN_USE_MS;
    return codes.find(p => !shown(p) && !lookedUp(p)) || codes.find(p => !lookedUp(p)) || codes[0];
  }

  // The queue is full: the address with the most waiting codes, if it has more
  // than the one asking would, loses its oldest.
  busiestCode(pairings, address) {
    const waiting = new Map(); // address -> its codes, oldest first
    for (const pairing of pairings) {
      if (pairing.approved || pairing.claimId) continue;
      if (!waiting.has(pairing.address)) waiting.set(pairing.address, []);
      waiting.get(pairing.address).push(pairing);
    }
    const asking = (waiting.get(address) || []).length + 1;
    let busiest = null;
    for (const codes of waiting.values()) if (!busiest || codes.length > busiest.length) busiest = codes;
    return busiest && busiest.length > asking ? busiest[0].code : null;
  }

  // A new pairing for a frame: the code goes in the QR, the secret stays on the frame.
  // address is a keyed hash of the network the request came from (see networkKey
  // in the controller), never the address itself;
  // browser is a key only the browser that asked has, so only it can collect.
  // device is what the screen said about itself (utils/deviceInfo), a hint only.
  async start(address = 'unknown', browser = null, device = deviceInfo()) {
    const secret = crypto.randomBytes(24).toString('hex');
    const pairing = await this.store.enqueue((rows, now) => {
      const mine = rows.filter(p => !p.approved && !p.claimId && p.address === address);
      // Screens still showing their code, and codes an owner has looked up, go last.
      const evict = mine.length >= MAX_PER_ADDRESS ? [this.leastInUse(mine, now).code] : [];
      if (rows.length - evict.length >= MAX_PENDING) {
        const busiest = this.busiestCode(rows.filter(p => !evict.includes(p.code)), address);
        if (!busiest) return { pairing: null, evict };
        evict.push(busiest);
      }
      const used = new Set(rows.map(row => row.code));
      let code;
      do { code = this.newCode(); } while (used.has(code));
      return {
        evict,
        pairing: {
          code,
          secretHash: hash(secret),
          browserHash: typeof browser === 'string' ? hash(browser) : null,
          createdAt: now,
          lastSeen: now,
          expiresAt: now + PAIRING_TTL_MS,
          address,
          device,
          claimId: null,
          approved: null
        }
      };
    });
    return pairing && { code: pairing.code, secret, expiresAt: pairing.expiresAt };
  }

  find(code) {
    return this.store.get(this.normalize(code), Date.now());
  }

  async lookUp(code) {
    const pairing = await this.find(code);
    if (pairing) await this.store.touch(pairing, 'lookedUpAt', Date.now());
    return pairing;
  }

  // Take the code before creating anything, so two approvals can't both go ahead.
  claim(code) {
    return this.store.claim(this.normalize(code), crypto.randomUUID(), Date.now());
  }

  release(pairing) {
    return this.store.release(pairing);
  }

  // The admin said yes: make the device and hold its token for the frame to collect.
  // The caller owns the release when it supplies a claim. Otherwise release it here.
  async approve(codeOrPairing, { name, accountId, beforeReady = null }) {
    const ownClaim = typeof codeOrPairing !== 'object';
    const pairing = ownClaim ? await this.claim(codeOrPairing) : codeOrPairing;
    if (!pairing?.claimId) return null;
    let published = false;
    try {
      if (pairing.expiresAt <= Date.now()) return null;
      const info = deviceInfo(pairing.device);
      const { device, token } = await this.addDevice({ name, accountId, via: 'qr', info });
      try {
        const live = await this.find(pairing.code);
        if (live?.claimId === pairing.claimId && !live.approved) {
          if (beforeReady) await beforeReady();
          const tenant = currentTenant();
          const approved = { token, device, tenantId: tenant.id };
          // In-memory hosts can still use the approving context directly.
          if (this.store instanceof MemoryPairingStore) approved.tenant = tenant;
          published = await this.store.approve(pairing, approved, Date.now());
          if (published) return device;
        }
      } catch (error) {
        await this.discardDevice(device.id);
        throw error;
      }
      await this.discardDevice(device.id);
      return null;
    } finally {
      if (ownClaim && !published) await this.release(pairing);
    }
  }

  // Every way a screen joins (QR code or PIN) ends here, so the same screen
  // limit applies to all of them. Returns the device and its token.
  async addDevice({ name, accountId, via, info }) {
    const id = `dev_${crypto.randomBytes(6).toString('hex')}`;
    const token = `${id}.${crypto.randomBytes(32).toString('base64url')}`;
    const device = {
      id,
      name,
      accountId,
      via,
      tokenHash: hash(token),
      pairedAt: new Date().toISOString(),
      lastSeen: null,
      ...(info && Object.values(info).some(Boolean) && { info })
    };
    // MAX_SCREENS caps screens per library (0, the default, means no cap)
    const limit = parseInt(process.env.MAX_SCREENS, 10) || 0;
    await this.deviceStore.add(currentTenant().id, device, async screensInUse => {
      if (limit && screensInUse >= limit) {
        throw Object.assign(new Error(`This family already has ${limit} screens. Remove one you no longer use to add this one.`),
          { status: 403, code: 'SCREEN_LIMIT', vars: { limit } });
      }
      // The quota hook's own limit, asked in the same turn so two new screens can't
      // both pass. Only here: a screen signing in again (by token or session) is
      // never a new one, so it is never asked about. The count is the exact one,
      // under this lock.
      const answer = await quota.ask({ screens: 1 }, { screensInUse });
      if (!answer || !answer.ok) {
        throw Object.assign(new Error((answer && answer.message) || 'This family has no room for another screen.'),
          { status: 403, code: 'SCREEN_LIMIT' });
      }
    });
    try {
      await emit('devicePaired', { deviceId: id, tenantId: currentTenant().id });
    } catch (error) {
      await this.deviceStore.remove(currentTenant().id, d => d.id === id);
      throw error;
    }
    // The host answered, so it can take any removals it missed. In the background:
    // a host slow with those must not hold up this sign-in.
    this.reportRemovals();
    return { device, token };
  }

  // The pairing for a code, when the secret is its own.
  async withSecret(code, secret) {
    if (typeof secret !== 'string') return null;
    const pairing = await this.find(code);
    return pairing && sameSecret(hash(secret), pairing.secretHash) ? pairing : null;
  }

  // Each poll notes that the frame is still showing its code (see nearby).
  async status(code, secret) {
    const pairing = await this.withSecret(code, secret);
    if (!pairing) return 'expired';
    await this.store.touch(pairing, 'lastSeen', Date.now());
    return pairing.approved ? 'ready' : 'waiting';
  }

  async cancel(code, secret) {
    const pairing = await this.withSecret(code, secret);
    if (pairing) await this.store.cancel(pairing, Date.now());
  }

  // Codes waiting on the same network, newest first.
  async nearby(address) {
    if (!address) return [];
    const now = Date.now();
    const rows = await this.store.list(now, address);
    return rows
      .filter(p => p.address === address && !p.approved && !p.claimId && p.expiresAt > now &&
        now - p.createdAt <= NEARBY_MAX_AGE_MS && now - p.lastSeen < NEARBY_SEEN_MS)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, NEARBY_MAX);
  }

  // Only the browser that started the pairing can take it, and only once.
  async collect(code, secret, browser) {
    const pairing = await this.withSecret(code, secret);
    if (!pairing || typeof browser !== 'string' || !sameSecret(hash(browser), pairing.browserHash)) {
      return { status: 'expired' };
    }
    if (!pairing.approved) return { status: 'waiting' };
    const approved = await this.store.take(pairing, Date.now());
    if (!approved) return { status: 'expired' };
    const { token, device, tenantId, tenant: approvingTenant } = approved;
    return {
      status: 'approved',
      token,
      device,
      tenant: async () => this.resolveTenant ? this.resolveTenant(tenantId) : approvingTenant || { id: tenantId },
      // A failed handover can be retried until the original deadline.
      restore: () => this.store.restore(pairing, Date.now())
    };
  }

  // A frame was just used. The account's "Last used" is saved about once an
  // hour. The screen's own "Last seen" joins the next batch.
  async noteUse({ account = null, device = null } = {}) {
    const now = Date.now();
    if (device) this.seen(device.id, now);
    if (account && !(now - Date.parse(account.lastAccessed) < SEEN_WRITE_GAP_MS)) {
      const at = new Date(now).toISOString();
      await getDataStore().update('access-accounts', [], accounts => accounts.map(a =>
        a.id === account.id ? { ...a, lastAccessed: at } : a));
    }
  }

  async loadDevices() {
    try {
      return await this.deviceStore.list(currentTenant().id);
    } catch (error) {
      if (error.status >= 400 && error.status < 500) return [];
      throw error;
    }
  }

  async findDevice(id) {
    try {
      return await this.deviceStore.findById(currentTenant().id, id);
    } catch (error) {
      if (error.status >= 400 && error.status < 500) return null;
      throw error;
    }
  }

  // The paired device for a token, or null. Old tokens have no embedded id.
  async signIn(token, advertisement) {
    if (typeof token !== 'string' || !token) return null;
    const id = deviceIdFromToken(token);
    const tokenHash = hash(token);
    const { id: tenantId } = currentTenant();
    let device;
    try {
      device = id
        ? await this.deviceStore.findById(tenantId, id)
        : await this.deviceStore.findByTokenHash(tenantId, tokenHash);
    } catch (error) {
      if (error.status >= 400 && error.status < 500) return null;
      throw error;
    }
    if (!device || !sameSecret(tokenHash, device.tokenHash)) return null;
    const info = deviceInfo(advertisement);
    if (Object.values(info).some(Boolean) &&
        Object.entries(info).some(([key, value]) => value !== (device.info?.[key] ?? null))) {
      device = await this.deviceStore.update(tenantId, device.id, { info });
      if (!device) return null;
    }
    this.seen(device.id);
    return device;
  }

  // Every request updates memory. Persist the most recent time per screen in
  // one batch, including requests that never recheck the screen's session.
  seen(deviceId, at = Date.now()) {
    if (!deviceId) return;
    const { id: tenantId } = currentTenant();
    if (!this.seenAt.has(tenantId)) this.seenAt.set(tenantId, new Map());
    const times = this.seenAt.get(tenantId);
    if (!(times.get(deviceId) >= at)) times.set(deviceId, at);
    this.scheduleSeenFlush();
  }

  scheduleSeenFlush() {
    if (this.seenTimer || this.flushingSeen || !this.seenAt.size) return;
    this.seenTimer = setTimeout(() => {
      this.flushSeen().catch(error => console.error('Could not save when screens were last seen:', error.message));
    }, DEVICE_SEEN_FLUSH_MS);
    this.seenTimer.unref?.();
  }

  async flushSeen() {
    clearTimeout(this.seenTimer);
    this.seenTimer = null;
    if (this.flushingSeen) return this.flushingSeen;
    const touches = [];
    for (const [tenantId, times] of this.seenAt) {
      for (const [deviceId, at] of times) touches.push({ tenantId, deviceId, at });
    }
    if (!touches.length) return;
    this.flushingSeen = Promise.resolve().then(() => this.deviceStore.touchMany(touches)).then(() => {
      for (const { tenantId, deviceId, at } of touches) {
        const times = this.seenAt.get(tenantId);
        if (times.get(deviceId) === at) times.delete(deviceId);
        if (!times.size) this.seenAt.delete(tenantId);
      }
    }).finally(() => {
      this.flushingSeen = null;
      this.scheduleSeenFlush();
    });
    return this.flushingSeen;
  }

  // After HTTP drains, include any activity that came in during a previous batch.
  async drainSeen() {
    if (this.flushingSeen) await this.flushingSeen.catch(() => {});
    try {
      await this.flushSeen();
    } finally {
      clearTimeout(this.seenTimer);
      this.seenTimer = null;
    }
  }

  lastSeenOf(device) {
    const remembered = this.seenAt.get(currentTenant().id)?.get(device.id);
    const stored = Date.parse(device.lastSeen);
    return remembered !== undefined && !(stored >= remembered) ? new Date(remembered).toISOString() : device.lastSeen;
  }

  async listDevices() {
    const devices = await this.loadDevices();
    return devices.map(({ tokenHash, pausedAt, ...device }) => ({ ...device, lastSeen: this.lastSeenOf(device) }));
  }

  async setLanguage(id, language) {
    const allowed = ['en', 'es', 'fr', 'de', 'pt-BR', 'it', 'nl', 'hi', 'ja', 'zh-CN', 'ar'];
    if (!allowed.includes(language)) return null;
    return this.deviceStore.update(currentTenant().id, id, { language });
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
      await this.deviceStore.remove(currentTenant().id, d => d.id === id);
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
      const ids = new Set(pending);
      await this.deviceStore.remove(tenant.id, d => ids.has(d.id));
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
    const tenantId = currentTenant().id;
    const removed = await this.deviceStore.remove(tenantId, match);
    if (!removed.length) return 0;
    try {
      await emit('devicesRemoved', { deviceIds: removed.map(d => d.id), tenantId: currentTenant().id });
    } catch (error) {
      // As in approve(): the action fails as a whole, so the host's index never misses it
      await this.deviceStore.restore(tenantId, removed);
      throw error;
    }
    this.reportRemovals(); // in the background, as in addDevice
    return removed.length;
  }
}

module.exports = new PairingService();
module.exports.withStore = (store, resolveTenant, deviceStore) => new PairingService(store, resolveTenant, deviceStore);
module.exports.forRequest = req => req?.app?.locals.pairingService || module.exports;
module.exports.deviceIdFromToken = deviceIdFromToken;
module.exports.PAIRING_TTL_MS = PAIRING_TTL_MS;
module.exports.MAX_PENDING = MAX_PENDING;
module.exports.MAX_PER_ADDRESS = MAX_PER_ADDRESS;
module.exports.DEVICE_SEEN_FLUSH_MS = DEVICE_SEEN_FLUSH_MS;
module.exports.IN_USE_MS = IN_USE_MS;
module.exports.NEARBY_MAX = NEARBY_MAX;
module.exports.NEARBY_SEEN_MS = NEARBY_SEEN_MS;
