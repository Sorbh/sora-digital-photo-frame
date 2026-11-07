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
const frameFor = async (assignedFolders) => {
  const pin = String(700000 + (++pinCount));
  const { body } = await admin.post('/api/access-accounts').send({ name: `Frame ${pin}`, pin, assignedFolders }).expect(201);
  const frame = request.agent(app);
  await frame.post('/api/auth/pin').send({ pin }).expect(200);
  return { frame, accountId: (body.account || body.data || body).id };
};

describe('a frame limited to family/kids', () => {
  let frame;
  beforeAll(async () => { ({ frame } = await frameFor(['family/kids'])); });

  test('gets its own photos', async () => {
    await frame.get('/uploads/family/kids/park.png').expect(200);
    await frame.get('/api/images/family%2Fkids%2Fpark.png/thumbnail').expect(200);
    await frame.get('/api/folders/family/kids/thumbnail').expect(200);
    await frame.get('/api/folders/family/kids').expect(200);
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

describe('removing or changing a frame reaches it without waiting a day', () => {
  const later = (agentCall) => {
    const realNow = Date.now;
    Date.now = () => realNow() + RECHECK_MS + 1000;
    return Promise.resolve(agentCall()).finally(() => { Date.now = realNow; });
  };

  test('a deleted account is signed out', async () => {
    const { frame, accountId } = await frameFor([]);
    await frame.get('/api/images/random').expect(200);
    await admin.delete(`/api/access-accounts/${accountId}`).expect(200);
    await later(() => frame.get('/api/images/random').expect(401));
  });

  test('a removed screen is signed out', async () => {
    const { frame } = await frameFor([]);
    const { body } = await admin.get('/api/admin/devices').expect(200);
    const devices = body.devices || body;
    const screen = devices[devices.length - 1];
    await admin.delete(`/api/admin/devices/${screen.id}`).expect(200);
    await later(() => frame.get('/api/images/random').expect(401));
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
