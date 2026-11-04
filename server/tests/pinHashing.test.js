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
});
