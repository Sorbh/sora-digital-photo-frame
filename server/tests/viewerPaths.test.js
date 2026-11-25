const request = require('supertest');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const sharp = require('sharp');

// The photos folder is named "uploads", like a default install, and holds a
// folder that is also named "uploads"
const testRoot = path.join(__dirname, 'paths-data');
const testUploadsDir = path.join(testRoot, 'uploads');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = path.join(testRoot, 'cache');
process.env.DATA_DIR = path.join(testRoot, 'data');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'paths-admin-pass';
delete process.env.PHOTO_ENCRYPTION_KEY;

const { StaticKeyProvider } = require('../crypto/keys');
const { createApp } = require('../app');

const image = (color, format) => sharp({ create: { width: 8, height: 8, channels: 3, background: color } })[format]().toBuffer();

beforeAll(async () => {
  for (const [folder, name, color, format] of [
    ['uploads', 'mine.webp', '#3cc', 'webp'],
    ['private', 'secret.webp', '#c3c', 'webp'],
    ['private', 'secret.png', '#c33', 'png']
  ]) {
    await fs.ensureDir(path.join(testUploadsDir, folder));
    await fs.writeFile(path.join(testUploadsDir, folder, name), await image(color, format));
  }
});
afterAll(() => fs.remove(testRoot));

// A frame signed in with a PIN that only sees the folder named "uploads"
let pinCount = 0;
const frameLimitedToUploads = async (app) => {
  const pin = String(734500 + (++pinCount));
  const admin = request.agent(app);
  await admin.post('/api/auth/login').send({ password: 'paths-admin-pass' }).expect(200);
  await admin.post('/api/access-accounts').send({ name: `Frame ${pin}`, pin, assignedFolders: ['uploads'] }).expect(201);
  const frame = request.agent(app);
  await frame.post('/api/auth/pin').send({ pin }).expect(200);
  return frame;
};

const outsideUrls = [
  '/uploads/%2e%2e/uploads/private/secret.webp',
  '/uploads/%2e%2e/uploads/private/secret.png',
  '/uploads/uploads/%2e%2e/%2e%2e/uploads/private/secret.webp',
  '/uploads/uploads%2f%2e%2e%2f%2e%2e%2fuploads%2fprivate%2fsecret.png'
];

for (const [storage, options] of [
  ['photos on disk', () => ({})],
  ['encrypted photos', () => ({ keys: new StaticKeyProvider({ k1: crypto.randomBytes(32) }, 'k1') })]
]) {
  describe(`a frame limited to a folder named uploads, ${storage}`, () => {
    let frame;
    beforeAll(async () => { frame = await frameLimitedToUploads(createApp(options())); });

    test('gets its own photos', async () => {
      await frame.get('/uploads/uploads/mine.webp').set('Accept', 'image/webp').expect(200);
      await frame.get('/uploads/uploads/mine.webp').set('Accept', 'image/*').expect(200);
    });

    test("can't reach the rest of the library with .. segments", async () => {
      for (const url of outsideUrls) {
        for (const accept of ['image/webp', 'image/*']) {
          const res = await frame.get(url).set('Accept', accept);
          expect({ url, accept, status: res.status }).toEqual({ url, accept, status: 404 });
        }
      }
    });
  });
}
