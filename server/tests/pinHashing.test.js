const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');

// Point the app at throwaway folders before it loads
const testUploadsDir = path.join(__dirname, 'pins-uploads');
const testCacheDir = path.join(__dirname, 'pins-cache');
const testDataDir = path.join(__dirname, 'pins-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'pin-test-admin';

const { createApp } = require('../app');

const accountsFile = path.join(testDataDir, 'access-accounts.json');
const stored = () => fs.readJson(accountsFile);

describe('PINs are stored hashed', () => {
  const app = createApp();
  let admin;

  beforeAll(async () => {
    await fs.ensureDir(testUploadsDir);
    admin = request.agent(app);
    await admin.post('/api/auth/login').send({ password: 'pin-test-admin' }).expect(200);
  });

  afterAll(async () => {
    await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
  });

  test('a new account keeps only a hash, and the API never returns the PIN', async () => {
    const created = await admin.post('/api/access-accounts').send({ name: 'Grandma', pin: '482913' }).expect(201);
    expect(created.body.account).toMatchObject({ name: 'Grandma', hasPin: true });
    expect(created.body.account.pin).toBeUndefined();
    expect(created.body.account.pinHash).toBeUndefined();

    const [account] = await stored();
    expect(account.pin).toBeUndefined();
    expect(account.pinHash).toMatch(/^\$2[aby]\$/);
    expect(JSON.stringify(await stored())).not.toContain('482913');

    const listed = await admin.get('/api/access-accounts').expect(200);
    expect(JSON.stringify(listed.body)).not.toMatch(/482913|pinHash/);
  });

  test('signing in with the PIN works, a wrong PIN does not', async () => {
    const ok = await request(app).post('/api/auth/pin').send({ pin: '482913' }).expect(200);
    expect(ok.body.account.name).toBe('Grandma');
    await request(app).post('/api/auth/pin').send({ pin: '111111' }).expect(401);
  });

  test('a PIN already in use is refused', async () => {
    const res = await admin.post('/api/access-accounts').send({ name: 'Copy', pin: '482913' }).expect(400);
    expect(res.body.code).toBe('DUPLICATE_PIN');
  });

  test('editing with a blank PIN keeps it; a new PIN replaces it', async () => {
    const [{ id }] = await stored();
    await admin.put(`/api/access-accounts/${id}`).send({ name: 'Grandma B', pin: '' }).expect(200);
    await request(app).post('/api/auth/pin').send({ pin: '482913' }).expect(200);

    await admin.put(`/api/access-accounts/${id}`).send({ name: 'Grandma B', pin: '7351' }).expect(200);
    await request(app).post('/api/auth/pin').send({ pin: '7351' }).expect(200);
    await request(app).post('/api/auth/pin').send({ pin: '482913' }).expect(401);
  });

  test('PINs saved in plain text before this change are hashed on first read and still work', async () => {
    const accounts = await stored();
    await fs.writeJson(accountsFile, [...accounts, { id: 'acc_old', name: 'Old frame', pin: '9090', assignedFolders: [] }]);

    const res = await request(app).post('/api/auth/pin').send({ pin: '9090' }).expect(200);
    expect(res.body.account.id).toBe('acc_old');

    const old = (await stored()).find(a => a.id === 'acc_old');
    expect(old.pin).toBeUndefined();
    expect(old.pinHash).toMatch(/^\$2[aby]\$/);
  });

  test('PINs must be 4 to 6 digits', async () => {
    for (const pin of ['abcd', '123', '1234567', '12 34', '12a4', 482913, ['4829']]) {
      const res = await admin.post('/api/access-accounts').send({ name: 'Bad PIN', pin });
      expect({ pin, status: res.status, code: res.body.code }).toEqual({ pin, status: 400, code: 'INVALID_PIN_FORMAT' });
    }
    const [{ id }] = await stored();
    const res = await admin.put(`/api/access-accounts/${id}`).send({ name: 'Grandma B', pin: '12a4' }).expect(400);
    expect(res.body.code).toBe('INVALID_PIN_FORMAT');
    for (const pin of [0, false, null, 7351]) {
      const bad = await admin.put(`/api/access-accounts/${id}`).send({ name: 'Renamed anyway', pin });
      expect({ pin, status: bad.status, code: bad.body.code }).toEqual({ pin, status: 400, code: 'INVALID_PIN_FORMAT' });
    }
    expect((await stored()).find(a => a.id === id).name).toBe('Grandma B');
    await request(app).post('/api/auth/pin').send({ pin: '7351' }).expect(200);
    expect((await stored()).some(a => a.name === 'Bad PIN')).toBe(false);
  });
});

describe("the family's limit on wrong PINs", () => {
  const app = createApp();
  const accessAccounts = require('../controllers/accessAccountController');
  // Each try from a different address, so only the family's limit is in play
  let address = 0;
  const tryPin = (pin) => request(app).post('/api/auth/pin').set('X-Forwarded-For', `198.51.100.${++address}`).send({ pin });

  const admin = request.agent(app);
  // As if the server restarted: everything kept in memory is gone
  const restart = () => {
    accessAccounts.limiter.entries.clear();
    accessAccounts.restoredLockouts.clear();
  };

  beforeAll(async () => {
    await fs.ensureDir(testUploadsDir);
    await admin.post('/api/auth/login').send({ password: 'pin-test-admin' }).expect(200);
    await admin.post('/api/access-accounts').send({ name: 'Grandpa', pin: '7351' }).expect(201);
  });
  beforeEach(async () => {
    restart();
    await fs.remove(path.join(testDataDir, 'pin-lockout.json'));
  });
  afterAll(async () => {
    accessAccounts.limiter.entries.clear();
    await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
  });

  test('is not reset by someone signing in with a PIN they know', async () => {
    for (let i = 0; i < 4; i++) await tryPin('000000').expect(401);
    await tryPin('7351').expect(200);
    await tryPin('000000').expect(401);
    const res = await tryPin('7351').expect(429);
    expect(res.body.code).toBe('RATE_LIMITED');
  });

  test('is not used up by right PINs', async () => {
    for (let i = 0; i < 8; i++) await tryPin('7351').expect(200);
    for (let i = 0; i < 4; i++) await tryPin('000000').expect(401);
    await tryPin('7351').expect(200);
  });

  test("can't be reset by an address that looks like the family's key", async () => {
    for (let i = 0; i < 4; i++) await tryPin('000000').expect(401);
    await request(app).post('/api/auth/pin').set('X-Forwarded-For', 'family:default').send({ pin: '7351' }).expect(200);
    await tryPin('000000').expect(401);
    await tryPin('7351').expect(429);
  });

  test('is not locked by right PINs that arrive at the same time', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => tryPin('7351')));
    expect(results.map(r => r.status)).toEqual(Array(8).fill(200));
    await tryPin('7351').expect(200);
  });

  test('still stops wrong PINs sent all at once', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => tryPin('000000')));
    const statuses = results.map(r => r.status);
    expect(statuses.filter(s => s === 401)).toHaveLength(5);
    expect(statuses.filter(s => s === 429)).toHaveLength(7);
  });

  test('a lockout lasts through a restart', async () => {
    for (let i = 0; i < 5; i++) await tryPin('000000').expect(401);
    await tryPin('7351').expect(429);
    restart();
    await tryPin('7351').expect(429);
  });

  test('is not used up by right PINs refused for the screen limit', async () => {
    await tryPin('7351').expect(200); // at least one screen
    const { devices } = (await admin.get('/api/admin/devices').expect(200)).body;
    process.env.MAX_SCREENS = String(devices.length);
    try {
      for (let i = 0; i < 6; i++) {
        const res = await tryPin('7351');
        expect({ status: res.status, code: res.body.code }).toEqual({ status: 403, code: 'SCREEN_LIMIT' });
      }
    } finally {
      delete process.env.MAX_SCREENS;
    }
    await tryPin('7351').expect(200);
  });
});
