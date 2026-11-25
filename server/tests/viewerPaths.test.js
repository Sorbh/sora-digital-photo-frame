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
    ['private', 'secret.png', '#c33', 'png'],
    // On Linux a backslash is just part of a name: "a\\b" is one folder, beside "a"
    ['a\\b', 'own.png', '#3c3', 'png'],
    ['a/b', 'nested.png', '#33c', 'png'],
    ['', 'a\\b\\loose.png', '#cc3', 'png']
  ]) {
    await fs.ensureDir(path.join(testUploadsDir, folder));
    await fs.writeFile(path.join(testUploadsDir, folder, name), await image(color, format));
  }
});
afterAll(() => fs.remove(testRoot));

const signedInAdmin = async (app) => {
  const admin = request.agent(app);
  await admin.post('/api/auth/login').send({ password: 'paths-admin-pass' }).expect(200);
  return admin;
};

// A frame signed in with a PIN that only sees these folders
let pinCount = 0;
const frameLimitedTo = async (app, admin, assignedFolders) => {
  const pin = String(734500 + (++pinCount));
  await admin.post('/api/access-accounts').send({ name: `Frame ${pin}`, pin, assignedFolders }).expect(201);
  const frame = request.agent(app);
  await frame.post('/api/auth/pin').send({ pin }).expect(200);
  return frame;
};
const posixOnly = path.sep === '/' ? test : test.skip;

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
    let app, admin, frame;
    beforeAll(async () => {
      app = createApp(options());
      admin = await signedInAdmin(app);
      frame = await frameLimitedTo(app, admin, ['uploads']);
    });

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

    test('an encoded dot still gets an old browser a JPEG', async () => {
      const res = await frame.get('/uploads/uploads/mine%2ewebp').set('Accept', 'image/*').expect(200);
      expect(res.headers['content-type']).toMatch(/^image\/jpeg/);
    });

    posixOnly('a backslash is part of a name, for the check as for the file', async () => {
      const own = await frameLimitedTo(app, admin, ['a\\b']);
      await own.get('/uploads/a%5Cb/own.png').expect(200);
      await own.get('/api/images/a%5Cb%2Fown.png/thumbnail').expect(200);
      await own.get('/api/folders/a%5Cb/thumbnail').expect(200);
      await own.get('/uploads/a/b/nested.png').expect(404);
      await own.get('/api/images/a%2Fb%2Fnested.png/thumbnail').expect(404);

      const outer = await frameLimitedTo(app, admin, ['a']);
      await outer.get('/uploads/a/b/nested.png').expect(200);
      await outer.get('/uploads/a%5Cb%5Cloose.png').expect(404);
      await outer.get('/api/images/a%5Cb%5Cloose.png/thumbnail').expect(404);
      await outer.get('/uploads/a%5Cb/own.png').expect(404);
      await outer.get('/api/images/a%5Cb%2Fown.png/thumbnail').expect(404);
    });

    posixOnly('the admin can still open photos with a backslash in their name', async () => {
      await admin.get('/uploads/a%5Cb%5Cloose.png').expect(200);
      await admin.get('/uploads/a%5Cb/own.png').expect(200);
    });
  });
}
