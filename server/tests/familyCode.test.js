const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');

// Point the app at throwaway folders before it loads
const testUploadsDir = path.join(__dirname, 'familycode-uploads');
const testCacheDir = path.join(__dirname, 'familycode-cache');
const testDataDir = path.join(__dirname, 'familycode-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const { createApp } = require('../app');
const { currentTenant } = require('../context');
const DataStore = require('../store/DataStore');
const { normalizeFamilyCode } = require('../services/familyCodeService');

// Keeps every tenant's documents apart, as a hosted store would
class MemoryStore extends DataStore {
  constructor() { super(); this.docs = new Map(); }
  key(name) { return `${currentTenant().id}:${name}`; }
  async get(name, fallback) { return this.docs.has(this.key(name)) ? structuredClone(this.docs.get(this.key(name))) : fallback; }
  async set(name, value) { this.docs.set(this.key(name), structuredClone(value)); }
  async update(name, fallback, fn) { const next = await fn(await this.get(name, fallback)); await this.set(name, next); return next; }
}

describe('Hosted PIN sign-in with a family code', () => {
  const codes = new Map(); // what a host would keep: family code -> tenant id
  const app = createApp({
    dataStore: new MemoryStore(),
    pinSignIn: true,
    familyCode: true,
    resolveTenant: (req) => {
      if (req.get('x-tenant')) return { id: req.get('x-tenant'), plan: 'free' };
      if (req.session?.tenantId) return { id: req.session.tenantId, plan: 'free' };
      if (req.path === '/api/auth/pin') {
        const id = codes.get(normalizeFamilyCode(req.body?.familyCode));
        if (id) return { id, plan: 'free' };
      }
      return { id: 'nobody', plan: 'none' };
    },
    auth: { requireAuth: (req, res, next) => (req.get('x-tenant') ? next() : res.status(401).json({ message: 'nope' })) },
    events: {
      familyCodeSet: ({ code, previous, tenantId }) => {
        if (previous) codes.delete(previous);
        codes.set(code, tenantId);
      }
    }
  });
  const asAdmin = (tenant, req) => req.set('x-tenant', tenant);

  afterAll(async () => {
    delete process.env.MAX_SCREENS;
    await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
  });

  test('each family gets its own code, and the host hears about it', async () => {
    const a = (await asAdmin('a', request(app).get('/api/admin/family-code')).expect(200)).body;
    const again = (await asAdmin('a', request(app).get('/api/admin/family-code')).expect(200)).body;
    const b = (await asAdmin('b', request(app).get('/api/admin/family-code')).expect(200)).body;

    expect(a).toMatchObject({ required: true });
    expect(a.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(again.code).toBe(a.code);
    expect(b.code).not.toBe(a.code);
    expect(codes.get(a.code)).toBe('a');
    expect(codes.get(b.code)).toBe('b');
    expect((await request(app).get('/api/auth/session').expect(200)).body).toMatchObject({ pinSignIn: true, familyCode: true });
  });

  test('a frame signs in with its family code and PIN, and becomes one of that family\'s screens', async () => {
    const { code } = (await asAdmin('a', request(app).get('/api/admin/family-code'))).body;
    await asAdmin('a', request(app).post('/api/access-accounts')).send({ name: 'Nani', pin: '615243' }).expect(201);
    // Family b has the same PIN: the code says which one is meant
    await asAdmin('b', request(app).post('/api/access-accounts')).send({ name: 'Dadi', pin: '615243' }).expect(201);

    const frame = request.agent(app);
    // Typed with a dash and in small letters, as people do
    const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
    const { body } = await frame.post('/api/auth/pin').send({ familyCode: typed, pin: '615243' }).expect(200);
    expect(body.account.name).toBe('Nani');

    const aScreens = (await asAdmin('a', request(app).get('/api/admin/devices'))).body.devices;
    const bScreens = (await asAdmin('b', request(app).get('/api/admin/devices'))).body.devices;
    expect(aScreens.map(d => d.id)).toContain(body.device.id);
    expect(bScreens).toHaveLength(0);
  });

  test('a PIN without the right family code finds nothing', async () => {
    await request(app).post('/api/auth/pin').send({ pin: '615243' }).expect(401);
    await request(app).post('/api/auth/pin').send({ familyCode: 'ABCDEFGH', pin: '615243' }).expect(401);
  });

  test('the screen limit applies to PIN screens, as it does to QR ones', async () => {
    const { code } = (await asAdmin('a', request(app).get('/api/admin/family-code'))).body;
    const count = (await asAdmin('a', request(app).get('/api/admin/devices'))).body.devices.length;
    process.env.MAX_SCREENS = String(count);
    try {
      const res = await request(app).post('/api/auth/pin').send({ familyCode: code, pin: '615243' }).expect(403);
      expect(res.body.code).toBe('SCREEN_LIMIT');
    } finally {
      delete process.env.MAX_SCREENS;
    }
  });

  test('a new code replaces the old one; frames already signed in keep working', async () => {
    const old = (await asAdmin('a', request(app).get('/api/admin/family-code'))).body.code;
    const frame = request.agent(app);
    const { body: signedIn } = await frame.post('/api/auth/pin').send({ familyCode: old, pin: '615243' }).expect(200);

    const renewed = (await asAdmin('a', request(app).post('/api/admin/family-code')).expect(200)).body.code;
    expect(renewed).not.toBe(old);
    expect(codes.has(old)).toBe(false);
    expect(codes.get(renewed)).toBe('a');

    await request(app).post('/api/auth/pin').send({ familyCode: old, pin: '615243' }).expect(401);
    await request(app).post('/api/auth/pin').send({ familyCode: renewed, pin: '615243' }).expect(200);
    await frame.post('/api/auth/device').send({ token: signedIn.token }).expect(200);
  });
});
