const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');
const sharp = require('sharp');

const testUploadsDir = path.join(__dirname, 'urls-uploads');
const testCacheDir = path.join(__dirname, 'urls-cache');
const testDataDir = path.join(__dirname, 'urls-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'urls-admin-pass';
delete process.env.PHOTO_ENCRYPTION_KEY;

const { createApp } = require('../app');
const LocalPhotoLibrary = require('../library/LocalPhotoLibrary');

// Folder and file names that are also URL syntax (and still valid on Windows)
const FOLDER = '50% off #1';
const FILE = 'a#b%c.png';
const onWindows = process.platform === 'win32';
const Q_FOLDER = 'Trip?';
const Q_FILE = 'a?b.png';
const png = color => sharp({ create: { width: 8, height: 8, channels: 3, background: color } }).png().toBuffer();

describe('Photo URLs for names with # and %', () => {
  const app = createApp();
  const admin = request.agent(app);
  let picture;

  beforeAll(async () => {
    picture = await png('#c42b6e');
    await fs.ensureDir(path.join(testUploadsDir, FOLDER));
    await fs.writeFile(path.join(testUploadsDir, FOLDER, FILE), picture);
    // Photos elsewhere, so a slideshow that ignored the folder would show them
    await fs.ensureDir(path.join(testUploadsDir, 'other'));
    for (let i = 0; i < 5; i += 1) await fs.writeFile(path.join(testUploadsDir, 'other', `o${i}.png`), await png('#2b6ec4'));
    // ? is not allowed in Windows file names
    if (!onWindows) {
      await fs.ensureDir(path.join(testUploadsDir, Q_FOLDER));
      await fs.writeFile(path.join(testUploadsDir, Q_FOLDER, Q_FILE), picture);
    }
    await admin.post('/api/auth/login').send({ password: 'urls-admin-pass' }).expect(200);
  });

  afterAll(async () => {
    await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
  });

  test('the library encodes each path segment', () => {
    expect(new LocalPhotoLibrary().photoUrl(`uploads/${FOLDER}/${FILE}`))
      .toBe('/uploads/50%25%20off%20%231/a%23b%25c.png');
  });

  test('custom libraries get the same URL builder', () => {
    const PhotoLibrary = require('../library/PhotoLibrary');
    expect(PhotoLibrary.uploadsUrl(`uploads/${FOLDER}/${FILE}`)).toBe('/uploads/50%25%20off%20%231/a%23b%25c.png');
    expect(LocalPhotoLibrary.uploadsUrl).toBe(PhotoLibrary.uploadsUrl);
  });

  test('the URL builder splits on / on every platform', () => {
    jest.isolateModules(() => {
      jest.doMock('path', () => jest.requireActual('path').win32);
      const { uploadsUrl } = require('../utils/safePath');
      expect(uploadsUrl('uploads/Family/a#1.jpg')).toBe('/uploads/Family/a%231.jpg');
      expect(uploadsUrl('uploads\\Family\\a#1.jpg')).toBe('/uploads/Family/a%231.jpg');
    });
    jest.dontMock('path');
  });

  test('the slideshow plays only that folder, with URLs that load', async () => {
    for (let i = 0; i < 6; i += 1) {
      const { body } = await admin.get('/api/images/next').query({ folder: FOLDER }).expect(200);
      expect(body.image.filename).toBe(FILE);
      const url = new URL(body.image.url);
      expect(url.search).toBe('');
      expect(url.hash).toBe('');
      const res = await admin.get(url.pathname).expect(200);
      expect(Buffer.compare(res.body, picture)).toBe(0);
    }
  });

  test('?folder[]= still picks the folder', async () => {
    for (let i = 0; i < 6; i += 1) {
      const { body } = await admin.get(`/api/images/next?folder%5B%5D=${encodeURIComponent(FOLDER)}`).expect(200);
      expect(body.image.filename).toBe(FILE);
    }
  });

  test('an empty ?folder[]= still finds no photos, as before', async () => {
    const res = await admin.get('/api/images/next?folder%5B%5D=').expect(404);
    expect(res.body.code).toBe('FOLDER_EMPTY');
  });

  (onWindows ? test.skip : test)('a ? in folder and file names stays part of the path', async () => {
    const { body } = await admin.get('/api/images/next').query({ folder: Q_FOLDER }).expect(200);
    expect(body.image.filename).toBe(Q_FILE);
    const url = new URL(body.image.url);
    expect(url.pathname).toBe('/uploads/Trip%3F/a%3Fb.png');
    expect(url.search).toBe('');
    const res = await admin.get(url.pathname).expect(200);
    expect(Buffer.compare(res.body, picture)).toBe(0);
  });

  test('the admin grid gets the same URL', async () => {
    const { body: next } = await admin.get('/api/images/next').query({ folder: FOLDER }).expect(200);
    const { body } = await admin.get('/api/admin/folders').query({ path: `uploads/${FOLDER}` }).expect(200);
    const files = body.files || body.items || body.contents || [];
    const image = files.find(item => item.name === FILE);
    expect(image).toBeTruthy();
    expect(image.url).toBe(new URL(next.image.url).pathname);
  });
});
