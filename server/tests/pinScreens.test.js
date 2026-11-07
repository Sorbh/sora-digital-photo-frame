const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');

// Point the app at throwaway folders before it loads
const testUploadsDir = path.join(__dirname, 'pinscreens-uploads');
const testCacheDir = path.join(__dirname, 'pinscreens-cache');
const testDataDir = path.join(__dirname, 'pinscreens-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'test-admin-pass';

const app = require('../server');

describe('A frame signing in with a PIN is a screen, like one paired by QR code', () => {
  const admin = request.agent(app);
  const screens = async () => (await admin.get('/api/admin/devices').expect(200)).body.devices;
  const signIn = (frame, body) => frame.post('/api/auth/pin').send(body);

  beforeAll(async () => {
    await fs.ensureDir(testUploadsDir);
    await admin.post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200);
    await admin.post('/api/access-accounts').send({ name: 'Living room', pin: '482913' }).expect(201);
  });

  afterAll(async () => {
    delete process.env.MAX_SCREENS;
    await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
  });

  test('a PIN sign-in adds a screen and hands the browser a token to come back with', async () => {
    const frame = request.agent(app);
    const { body } = await signIn(frame, { pin: '482913' }).expect(200);

    expect(body.token).toMatch(/^dev_[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/);
    const listed = await screens();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: body.device.id, name: 'Living room', via: 'pin', accountName: 'Living room' });
    expect(listed[0].tokenHash).toBeUndefined();

    // Later the frame signs in with its token, and stays the same screen
    await frame.post('/api/auth/device').send({ token: body.token }).expect(200);
    expect(await screens()).toHaveLength(1);
  });

  test('typing the PIN again on a browser that already is a screen does not add another', async () => {
    const frame = request.agent(app);
    const first = (await signIn(frame, { pin: '482913' }).expect(200)).body;
    const count = (await screens()).length;

    const again = (await signIn(frame, { pin: '482913', token: first.token }).expect(200)).body;
    expect(again.device.id).toBe(first.device.id);
    expect(again.token).toBe(first.token);
    expect(await screens()).toHaveLength(count);
  });

  test('a page from before PIN screens, renewing with its PIN and no token, stays one screen', async () => {
    const frame = request.agent(app);
    const first = (await signIn(frame, { pin: '482913' }).expect(200)).body;
    const count = (await screens()).length;
    const renewed = (await signIn(frame, { pin: '482913' }).expect(200)).body;
    expect(renewed.device.id).toBe(first.device.id);
    expect(await screens()).toHaveLength(count);
  });

  test('a token from another account does not carry over to this one', async () => {
    await admin.post('/api/access-accounts').send({ name: 'Bedroom', pin: '730215' }).expect(201);
    const frame = request.agent(app);
    const bedroom = (await signIn(frame, { pin: '730215' }).expect(200)).body;
    const living = (await signIn(frame, { pin: '482913', token: bedroom.token }).expect(200)).body;
    expect(living.device.id).not.toBe(bedroom.device.id);
  });

  test('PIN sign-ins and QR pairings share one MAX_SCREENS limit', async () => {
    const existing = request.agent(app);
    const kept = (await signIn(existing, { pin: '482913' }).expect(200)).body;
    const count = (await screens()).length;
    process.env.MAX_SCREENS = String(count + 1);
    try {
      // One place left: a QR pairing takes it
      const frame = request.agent(app);
      const pairing = (await frame.post('/api/pair/start').expect(200)).body;
      await admin.post(`/api/admin/pair/${pairing.code}/approve`).send({ name: 'Hall', newAccount: {} }).expect(200);

      // Now a PIN sign-in on a new browser is refused, with the same message
      const refused = await signIn(request.agent(app), { pin: '482913' }).expect(403);
      expect(refused.body).toMatchObject({ code: 'SCREEN_LIMIT', limit: count + 1 });
      expect(await screens()).toHaveLength(count + 1);

      // A browser that already is a screen still gets in, by token or by PIN
      await existing.post('/api/auth/device').send({ token: kept.token }).expect(200);
      await signIn(existing, { pin: '482913', token: kept.token }).expect(200);
      expect(await screens()).toHaveLength(count + 1);
    } finally {
      delete process.env.MAX_SCREENS;
    }
  });

  test('a screen that signs out frees its place', async () => {
    const frame = request.agent(app);
    const { body } = await signIn(frame, { pin: '482913' }).expect(200);
    expect((await screens()).some(d => d.id === body.device.id)).toBe(true);

    await frame.delete('/api/auth/session').expect(200);
    expect((await screens()).some(d => d.id === body.device.id)).toBe(false);
    await frame.post('/api/auth/device').send({ token: body.token }).expect(401);
  });

  test('self-hosted installs need no family code', async () => {
    const { body } = await request(app).get('/api/auth/session').expect(200);
    expect(body).toMatchObject({ pinSignIn: true, familyCode: false });
    expect((await admin.get('/api/admin/family-code').expect(200)).body).toEqual({ success: true, required: false });
  });
});
