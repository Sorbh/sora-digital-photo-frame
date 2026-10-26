const request = require('supertest');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');

// Point the app at throwaway folders before it loads
const testUploadsDir = path.join(__dirname, 'tenants-uploads');
const testCacheDir = path.join(__dirname, 'tenants-cache');
const testDataDir = path.join(__dirname, 'tenants-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const { createApp } = require('../app');
const { currentTenant, runWithTenant } = require('../context');
const DataStore = require('../store/DataStore');
const pairing = require('../services/pairingService');
const jobManager = require('../utils/jobManager');

// Keeps every tenant's documents apart, as a hosted store would
class MemoryStore extends DataStore {
  constructor() { super(); this.docs = new Map(); }
  key(name) { return `${currentTenant().id}:${name}`; }
  async get(name, fallback) { return this.docs.has(this.key(name)) ? structuredClone(this.docs.get(this.key(name))) : fallback; }
  async set(name, value) { this.docs.set(this.key(name), structuredClone(value)); }
  async update(name, fallback, fn) { const next = await fn(await this.get(name, fallback)); await this.set(name, next); return next; }
}

describe('Hosted, many tenants in one process', () => {
  const deviceTenants = new Map(); // what a host would keep: device id -> tenant id
  const removed = [];
  const store = new MemoryStore();

  const app = createApp({
    dataStore: store,
    pinSignIn: false,
    // Admins say who they are with a header here; frames come back with a session, or a device token
    resolveTenant: (req) => {
      if (req.get('x-tenant')) return { id: req.get('x-tenant'), plan: 'free' };
      if (req.session?.tenantId) return { id: req.session.tenantId, plan: 'free' };
      const deviceId = req.path === '/api/auth/device' && pairing.deviceIdFromToken(req.body?.token);
      if (deviceId && deviceTenants.has(deviceId)) return { id: deviceTenants.get(deviceId), plan: 'free' };
      return { id: 'nobody', plan: 'none' };
    },
    auth: { requireAuth: (req, res, next) => (req.get('x-tenant') ? next() : res.status(401).json({ message: 'nope' })) },
    events: {
      devicePaired: ({ deviceId, tenantId }) => { deviceTenants.set(deviceId, tenantId); },
      devicesRemoved: ({ deviceIds, tenantId }) => { removed.push({ deviceIds, tenantId }); deviceIds.forEach(id => deviceTenants.delete(id)); }
    },
    beforeRoutes: a => a.get('/whoami', (req, res) => res.json(currentTenant()))
  });

  afterAll(async () => {
    await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
  });

  async function pairFrame(tenantId) {
    const frame = request.agent(app);
    const { body: started } = await frame.post('/api/pair/start').expect(200);
    await request(app).post(`/api/admin/pair/${started.code}/approve`).set('x-tenant', tenantId)
      .send({ name: `Frame ${tenantId}`, newAccount: { assignedFolders: [] } }).expect(200);
    const { body: collected } = await frame.get('/api/pair/status').query({ code: started.code, secret: started.secret }).expect(200);
    return { frame, collected };
  }

  test('a frame paired by tenant A collects its token without a session and is signed in as A', async () => {
    const { frame, collected } = await pairFrame('a');

    expect(collected.status).toBe('approved');
    expect(collected.token).toMatch(/^dev_[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/);
    expect(pairing.deviceIdFromToken(collected.token)).toBe(collected.device.id);
    expect(deviceTenants.get(collected.device.id)).toBe('a');
    expect((await frame.get('/whoami').expect(200)).body.id).toBe('a');
  });

  test('device sign-in finds the tenant from the token', async () => {
    const { collected } = await pairFrame('b');

    const later = request.agent(app); // a restarted frame: no session, only its stored token
    const res = await later.post('/api/auth/device').send({ token: collected.token }).expect(200);
    expect(res.body.device.id).toBe(collected.device.id);
    expect((await later.get('/whoami').expect(200)).body.id).toBe('b');

    // The same token presented as another tenant is unknown there
    await request(app).post('/api/auth/device').set('x-tenant', 'a').send({ token: collected.token }).expect(401);
  });

  test('a changed token secret is refused', async () => {
    const { collected } = await pairFrame('a');
    const forged = `${collected.device.id}.${crypto.randomBytes(32).toString('base64url')}`;
    await request(app).post('/api/auth/device').send({ token: forged }).expect(401);
  });

  test('unpairing tells the host', async () => {
    const { collected } = await pairFrame('a');
    await request(app).delete(`/api/admin/devices/${collected.device.id}`).set('x-tenant', 'a').expect(200);
    expect(removed.at(-1)).toEqual({ deviceIds: [collected.device.id], tenantId: 'a' });
    expect(deviceTenants.has(collected.device.id)).toBe(false);
  });

  test('frames paired before this change keep signing in with their old token', async () => {
    const legacy = crypto.randomBytes(32).toString('base64url');
    await runWithTenant({ id: 'a' }, async () => {
      await store.update('devices', [], devices => [...devices, {
        id: 'dev_000000000001', name: 'Old frame', accountId: 'acc', tokenHash: crypto.createHash('sha256').update(legacy).digest('hex')
      }]);
      expect((await pairing.signIn(legacy)).id).toBe('dev_000000000001');
    });
  });

  test("a tenant can't see another tenant's import job", async () => {
    const jobId = await runWithTenant({ id: 'a' }, async () =>
      jobManager.createJob('google-photos-import', { mediaItems: [], destinationPath: 'uploads', accessToken: 'x' }));
    expect(await runWithTenant({ id: 'a' }, async () => jobManager.getJobStatus(jobId))).not.toBeNull();
    expect(await runWithTenant({ id: 'b' }, async () => jobManager.getJobStatus(jobId))).toBeNull();
  });

  test('PIN sign-in can be turned off', async () => {
    const res = await request(app).post('/api/auth/pin').send({ pin: '123456' }).expect(404);
    expect(res.body.code).toBe('PIN_DISABLED');
    expect((await request(app).get('/api/auth/session').expect(200)).body.pinSignIn).toBe(false);
  });
});
