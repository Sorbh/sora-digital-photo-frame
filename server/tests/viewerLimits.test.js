const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');
const sharp = require('sharp');

const testUploadsDir = path.join(__dirname, 'limits-uploads');
const testCacheDir = path.join(__dirname, 'limits-cache');
const testDataDir = path.join(__dirname, 'limits-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'limits-admin-pass';
process.env.ENABLE_GOOGLE_PHOTOS = 'true';
delete process.env.PHOTO_ENCRYPTION_KEY;

const { createApp } = require('../app');
const accessAccounts = require('../controllers/accessAccountController');
const { RECHECK_MS } = require('../middleware/freshViewer');

const app = createApp();
const png = (color) => sharp({ create: { width: 8, height: 8, channels: 3, background: color } }).png().toBuffer();

let admin;
beforeAll(async () => {
  for (const [folder, name, color] of [['family/kids', 'park.png', '#c33'], ['private', 'secret.png', '#33c'], ['family', 'beach.png', '#3c3']]) {
    await fs.ensureDir(path.join(testUploadsDir, folder));
    await fs.writeFile(path.join(testUploadsDir, folder, name), await png(color));
  }
  admin = request.agent(app);
  await admin.post('/api/auth/login').send({ password: 'limits-admin-pass' }).expect(200);
});
beforeEach(() => accessAccounts.limiter.entries.clear());
afterAll(async () => {
  delete process.env.ENABLE_GOOGLE_PHOTOS;
  await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
});

let pinCount = 0;
const frameFor = async (assignedFolders, frame = request.agent(app)) => {
  const pin = String(700000 + (++pinCount));
  const { body } = await admin.post('/api/access-accounts').send({ name: `Frame ${pin}`, pin, assignedFolders }).expect(201);
  const { body: signedIn } = await frame.post('/api/auth/pin').send({ pin }).expect(200);
  return { frame, accountId: (body.account || body.data || body).id, token: signedIn.token };
};

test('the owner browser can open the frame with its own session and choose a folder', async () => {
  const { body } = await admin.get('/api/auth/session').expect(200);
  expect(body).toMatchObject({ authenticated: true, viewer: false });
  const next = await admin.get('/api/images/next').query({ folder: 'private' }).expect(200);
  expect(next.body.image.filename).toBe('secret.png');
});

describe('a frame limited to family/kids', () => {
  let frame;
  beforeAll(async () => { ({ frame } = await frameFor(['family/kids'])); });

  test('gets its own photos', async () => {
    await frame.get('/uploads/family/kids/park.png').expect(200);
    await frame.get('/api/images/family%2Fkids%2Fpark.png/thumbnail').expect(200);
    await frame.get('/api/folders/family/kids/thumbnail').expect(200);
    await frame.get('/api/folders/family/kids').expect(200);
  });

  test('a folder parameter cannot change what the access account plays', async () => {
    for (const query of [{}, { folder: 'private' }, { 'folder[]': 'private' }, { folder: 'family/kids/absent' }]) {
      const { body } = await frame.get('/api/images/next').query(query).expect(200);
      expect(body.image.filename).toBe('park.png');
    }
  });

  test('an access account plays only its folders even when an admin is signed in in that browser', async () => {
    const browser = request.agent(app);
    await browser.post('/api/auth/login').send({ password: 'limits-admin-pass' }).expect(200);
    await frameFor(['family/kids'], browser);
    const { body } = await browser.get('/api/auth/session').expect(200);
    expect(body).toMatchObject({ authenticated: true, viewer: true });
    const random = jest.spyOn(Math, 'random');
    try {
      for (const value of [0, 0.5, 0.99]) {
        random.mockReturnValue(value);
        const next = await browser.get('/api/images/next').expect(200);
        expect(next.body.image.filename).toBe('park.png');
      }
    } finally {
      random.mockRestore();
    }
  });

  test('gets nothing from other folders, by any route', async () => {
    for (const url of [
      '/uploads/private/secret.png',
      '/uploads/family/beach.png',
      '/uploads/family/kids/../../private/secret.png',
      '/uploads/family/kids/%2e%2e/%2e%2e/private/secret.png',
      '/api/images/private%2Fsecret.png/thumbnail',
      '/api/images/family%2Fkids%2F..%2F..%2Fprivate%2Fsecret.png/thumbnail',
      '/api/images/family%2Fbeach.png/thumbnail',
      '/api/folders/private/thumbnail',
      '/api/folders/private'
    ]) {
      const res = await frame.get(url);
      expect({ url, status: res.status }).toEqual({ url, status: 404 });
    }
  });

  test("the folder above shows only what leads to its own, with its own cover and count", async () => {
    const { body } = await frame.get('/api/folders/family').expect(200);
    expect(body.images).toEqual([]); // beach.png is in family itself, not family/kids
    expect(body.subfolders.map(f => f.path)).toEqual(['family/kids']);
    expect(body.folder.imageCount).toBe(1);
    expect(body.folder.thumbnail).toMatch(/^\/api\/folders\/family\/kids\/thumbnail/);
    const root = await frame.get('/api/folders').expect(200);
    expect(root.body.folders.map(f => f.path)).toEqual(['family']);
    expect(root.body.folders[0].imageCount).toBe(1);
    expect(root.body.folders[0].thumbnail).toMatch(/kids/);
  });
});

describe('a frame given a folder and one inside it', () => {
  test('counts each photo once', async () => {
    await fs.ensureDir(path.join(testUploadsDir, 'family/kids/school'));
    await fs.writeFile(path.join(testUploadsDir, 'family/kids/school', 'play.png'), await png('#cc3'));
    try {
      const { frame } = await frameFor(['family/kids', 'family/kids/school']);
      // family itself isn't given, so its count is what's inside family/kids: park and play
      const { body } = await frame.get('/api/folders/family').expect(200);
      expect(body.folder.imageCount).toBe(2);
    } finally {
      await fs.remove(path.join(testUploadsDir, 'family/kids/school'));
    }
  });
});

describe('removing or changing a frame reaches it without waiting a day', () => {
  const later = (agentCall) => {
    const realNow = Date.now;
    Date.now = () => realNow() + RECHECK_MS + 1000;
    return Promise.resolve(agentCall()).finally(() => { Date.now = realNow; });
  };

  test('deleting an account refuses the very next request from its screen', async () => {
    const { frame, accountId } = await frameFor([]);
    await frame.get('/api/images/next').expect(200);
    await admin.delete(`/api/access-accounts/${accountId}`).expect(200);
    const { body } = await frame.get('/api/images/next').expect(401);
    expect(body.code).toBe('DEVICE_REMOVED');
  });

  test.each([
    ['/api/images/next', 'DEVICE_REMOVED'],
    ['/uploads/family/beach.png', null],
    ['/api/auth/device', 'DEVICE_UNKNOWN']
  ])('disconnecting a device refuses its next %s request', async (url, code) => {
    const { frame, token } = await frameFor([]);
    const { body: { device } } = await frame.post('/api/auth/device').send({ token }).expect(200);
    await frame.get('/api/images/next').expect(200);
    await admin.delete(`/api/admin/devices/${device.id}`).expect(200);

    const refused = url === '/api/auth/device' ? frame.post(url).send({ token }) : frame.get(url);
    const { body } = await refused.expect(401);
    if (code) expect(body.code).toBe(code);
    const { body: next } = await frame.get('/api/images/next').expect(401);
    expect(next.code).toBe('AUTH_REQUIRED');
    expect((await frame.get('/api/auth/session').expect(200)).body.authenticated).toBe(false);
  });

  test.each([503, 404])('a device-store read error (%i) keeps the screen session', async (status) => {
    const { frame } = await frameFor([]);
    await frame.get('/api/images/next').expect(200);
    const store = app.locals.pairingService.deviceStore;
    const unavailable = jest.spyOn(store, 'findById').mockRejectedValue(Object.assign(new Error('Device store unavailable'), { status }));
    try {
      await frame.get('/api/images/next').expect(200);
      await frame.get('/uploads/family/beach.png').expect(200);
      expect(unavailable).toHaveBeenCalledTimes(2);
    } finally {
      unavailable.mockRestore();
    }
    expect((await frame.get('/api/auth/session').expect(200)).body.authenticated).toBe(true);
  });

  test('new folder limits apply to a frame already signed in', async () => {
    const { frame, accountId } = await frameFor([]);
    await frame.get('/uploads/private/secret.png').expect(200);
    await admin.put(`/api/access-accounts/${accountId}`).send({ name: 'Limited now', assignedFolders: ['family'] }).expect(200);
    await later(() => frame.get('/uploads/private/secret.png').expect(404));
  });
});

describe('Google Photos sign-in', () => {
  test('a callback this browser did not start is refused', async () => {
    const res = await admin.get('/api/admin/google-photos/callback?code=attacker-code&state=made-up');
    expect(res.status).toBe(403);
    expect(res.text).toContain('not started here');
  });
});
