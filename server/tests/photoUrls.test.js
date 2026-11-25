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

// Folder and file names that are also URL syntax
const FOLDER = '50% off #1?';
const FILE = 'a#b?c%d.png';

describe('Photo URLs for names with # ? and %', () => {
  const app = createApp();
  const admin = request.agent(app);
  let picture;

  beforeAll(async () => {
    picture = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#c42b6e' } }).png().toBuffer();
    await fs.ensureDir(path.join(testUploadsDir, FOLDER));
    await fs.writeFile(path.join(testUploadsDir, FOLDER, FILE), picture);
    await admin.post('/api/auth/login').send({ password: 'urls-admin-pass' }).expect(200);
  });

  afterAll(async () => {
    await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
  });

  test('the library encodes each path segment', () => {
    expect(new LocalPhotoLibrary().photoUrl(`uploads/${FOLDER}/${FILE}`))
      .toBe('/uploads/50%25%20off%20%231%3F/a%23b%3Fc%25d.png');
  });

  test('the slideshow gets a URL that loads the photo', async () => {
    const { body } = await admin.get('/api/images/next').query({ folder: FOLDER }).expect(200);
    const url = new URL(body.image.url);
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
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
