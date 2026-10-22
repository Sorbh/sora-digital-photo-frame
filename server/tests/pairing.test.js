const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');

// Point the app at throwaway folders before it loads
const testUploadsDir = path.join(__dirname, 'pairing-uploads');
const testCacheDir = path.join(__dirname, 'pairing-cache');
const testDataDir = path.join(__dirname, 'pairing-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'test-admin-pass';

const app = require('../server');

describe('Pairing a frame by QR code', () => {
  const admin = request.agent(app);
  const start = async (frame) => (await frame.post('/api/pair/start').expect(200)).body;
  const status = (frame, pairing, secret = pairing.secret) =>
    frame.get('/api/pair/status').query({ code: pairing.code, secret }).expect(200).then(r => r.body);

  beforeAll(async () => {
    await fs.ensureDir(path.join(testUploadsDir, 'Goa'));
    await admin.post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200);
  });

  afterAll(async () => {
    delete process.env.PUBLIC_URL;
    await fs.remove(testUploadsDir);
    await fs.remove(testCacheDir);
    await fs.remove(testDataDir);
  });

  test('a frame gets a short code, a secret and a QR code for the phone', async () => {
    process.env.PUBLIC_URL = 'http://photos.home:3000/';
    const pairing = await start(request.agent(app));
    delete process.env.PUBLIC_URL;

    expect(pairing.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(pairing.secret).toHaveLength(48);
    expect(pairing.url).toBe(`http://photos.home:3000/pair?code=${pairing.code}`);
    expect(pairing.qr).toContain('<svg');
  });

  test('a frame on the server itself gets an address a phone can open', async () => {
    const pairing = (await request(app).post('/api/pair/start').set('Host', 'localhost:3000').expect(200)).body;
    expect(pairing.url).toMatch(/:3000\/pair\?code=/);
    if (require('../controllers/pairingController').networkAddress()) {
      expect(pairing.url).not.toContain('localhost');
    }
  });

  test('the frame waits until an admin approves, and only it can collect', async () => {
    const frame = request.agent(app);
    const pairing = await start(frame);
    expect((await status(frame, pairing)).status).toBe('waiting');
    expect((await status(frame, pairing, 'x'.repeat(48))).status).toBe('expired');

    await request(app).post(`/api/admin/pair/${pairing.code}/approve`).send({ name: 'Kitchen', newAccount: {} }).expect(401);
    await admin.post(`/api/admin/pair/${pairing.code}/approve`).send({ name: '  ', newAccount: {} }).expect(400);
    await admin.post(`/api/admin/pair/${pairing.code}/approve`).send({ name: 'Kitchen' }).expect(400);
    await admin.post('/api/admin/pair/ZZZZZZ/approve').send({ name: 'Kitchen', newAccount: {} }).expect(404);

    // The phone sees the code (dashes and case don't matter)
    const shown = await admin.get(`/api/admin/pair/${pairing.code.slice(0, 3).toLowerCase()}-${pairing.code.slice(3)}`).expect(200);
    expect(shown.body).toMatchObject({ code: pairing.code, approved: false });
  });

  test('approving with a new account signs the frame in for good', async () => {
    const frame = request.agent(app);
    const pairing = await start(frame);

    const approved = await admin.post(`/api/admin/pair/${pairing.code}/approve`)
      .send({ name: 'Kitchen frame', newAccount: { assignedFolders: ['Goa', 'Goa'] } })
      .expect(200);
    expect(approved.body.account).toMatchObject({ name: 'Kitchen frame', assignedFolders: ['Goa'] });
    await admin.post(`/api/admin/pair/${pairing.code}/approve`).send({ name: 'Again', newAccount: {} }).expect(404);

    const accounts = await fs.readJson(path.join(testDataDir, 'access-accounts.json'));
    expect(accounts.find(a => a.name === 'Kitchen frame').pin).toMatch(/^\d{6}$/);

    const collected = await status(frame, pairing);
    expect(collected).toMatchObject({ status: 'approved', device: { name: 'Kitchen frame' }, account: { name: 'Kitchen frame' } });
    expect(collected.token.length).toBeGreaterThan(30);
    expect((await frame.get('/api/auth/session').expect(200)).body.authenticated).toBe(true);

    // Handed over once only
    expect((await status(frame, pairing)).status).toBe('expired');

    // After a restart or a day, the token signs the frame back in
    const later = request.agent(app);
    const signedIn = await later.post('/api/auth/device').send({ token: collected.token }).expect(200);
    expect(signedIn.body.account.assignedFolders).toEqual(['Goa']);
    expect((await later.get('/api/auth/session').expect(200)).body.account.name).toBe('Kitchen frame');
    await request(app).post('/api/auth/device').send({ token: 'not-a-token' }).expect(401);

    // Only a hash of the token is stored
    const stored = await fs.readJson(path.join(testDataDir, 'devices.json'));
    expect(JSON.stringify(stored)).not.toContain(collected.token);
  });

  test('frames can share an existing account, and removing one unpairs it', async () => {
    const accounts = (await admin.get('/api/access-accounts').expect(200)).body.accounts;
    const kitchen = accounts.find(a => a.name === 'Kitchen frame');

    const frame = request.agent(app);
    const pairing = await start(frame);
    await admin.post(`/api/admin/pair/${pairing.code}/approve`).send({ name: 'Hall frame', accountId: 'acc_nope' }).expect(400);
    await admin.post(`/api/admin/pair/${pairing.code}/approve`).send({ name: 'Hall frame', accountId: kitchen.id }).expect(200);
    const { token } = await status(frame, pairing);

    await request(app).get('/api/admin/devices').expect(401);
    const listed = (await admin.get('/api/admin/devices').expect(200)).body.devices;
    const hall = listed.find(d => d.name === 'Hall frame');
    expect(hall).toMatchObject({ accountId: kitchen.id, accountName: 'Kitchen frame' });
    expect(hall).not.toHaveProperty('tokenHash');
    expect(Date.parse(hall.lastSeen)).toBeGreaterThan(Date.parse(hall.pairedAt) - 1000);

    await admin.delete(`/api/admin/devices/${hall.id}`).expect(200);
    const refused = await request(app).post('/api/auth/device').send({ token }).expect(401);
    expect(refused.body.code).toBe('DEVICE_UNKNOWN');
  });

  test('deleting an account unpairs its frames', async () => {
    const kitchen = (await admin.get('/api/access-accounts').expect(200)).body.accounts.find(a => a.name === 'Kitchen frame');
    await admin.delete(`/api/access-accounts/${kitchen.id}`).expect(200);
    const left = (await admin.get('/api/admin/devices').expect(200)).body.devices;
    expect(left.filter(d => d.accountId === kitchen.id)).toEqual([]);
  });

  test('a frame that hit the code limit gets back in once old codes age out', () => {
    const controller = require('../controllers/pairingController');
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      for (let i = 0; i < 20; i++) expect(controller.tooManyStarts('10.0.0.9')).toBe(false);
      // Retrying every minute while refused doesn't push the wait out
      for (let i = 0; i < 9; i++) {
        now += 60 * 1000;
        expect(controller.tooManyStarts('10.0.0.9')).toBe(true);
      }
      now += 61 * 1000;
      expect(controller.tooManyStarts('10.0.0.9')).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  test('the phone comes back to the pairing page after signing in', async () => {
    const res = await request(app).get('/pair?code=ABC234').expect(302);
    expect(res.headers.location).toBe('/login?next=%2Fpair%3Fcode%3DABC234');

    const signedIn = await admin.get('/login').query({ next: '/pair?code=ABC234' }).expect(302);
    expect(signedIn.headers.location).toBe('/pair?code=ABC234');
    const offsite = await admin.get('/login').query({ next: '//evil.example' }).expect(302);
    expect(offsite.headers.location).toBe('/admin');
  });
});
