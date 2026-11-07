const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');
const sharp = require('sharp');

// Point the app at throwaway folders before it loads
const testUploadsDir = path.join(__dirname, 'signin-uploads');
const testCacheDir = path.join(__dirname, 'signin-cache');
const testDataDir = path.join(__dirname, 'signin-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'test-admin-pass';
delete process.env.PHOTO_ENCRYPTION_KEY; // a plain uploads folder, served as static files

const { createApp } = require('../app');

// Everything that hands out a photo, a thumbnail, a folder listing or a note
const PHOTO_ROUTES = [
  '/api/random-image',
  '/api/images/random',
  '/api/images/next',
  '/api/images/family%2Fbeach.png/thumbnail',
  '/api/folders',
  '/api/folders/family',
  '/api/folders/family/thumbnail',
  '/api/notes/active',
  '/uploads/family/beach.png'
];

describe('Photos, thumbnails, folders and notes need a signed-in viewer (issue #30)', () => {
  const app = createApp();

  beforeAll(async () => {
    await fs.ensureDir(path.join(testUploadsDir, 'family'));
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#c33' } }).png().toBuffer();
    await fs.writeFile(path.join(testUploadsDir, 'family', 'beach.png'), png);
  });

  afterAll(async () => {
    await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
  });

  test('someone who has not signed in gets none of them', async () => {
    for (const url of PHOTO_ROUTES) {
      const res = await request(app).get(url);
      expect({ url, status: res.status }).toEqual({ url, status: 401 });
      expect(res.body.code).toBe('AUTH_REQUIRED');
    }
  });

  test('the admin still sees everything', async () => {
    const admin = request.agent(app);
    await admin.post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200);
    for (const url of PHOTO_ROUTES) {
      const res = await admin.get(url);
      expect({ url, status: res.status }).toEqual({ url, status: 200 });
    }
  });

  test('a frame signed in with a PIN still shows photos', async () => {
    const admin = request.agent(app);
    await admin.post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200);
    await admin.post('/api/access-accounts').send({ name: 'Kitchen', pin: '736251' }).expect(201);

    const frame = request.agent(app);
    await frame.post('/api/auth/pin').send({ pin: '736251' }).expect(200);
    const { body } = await frame.get('/api/images/random').expect(200);
    expect(body.image.url).toMatch(/\/uploads\/family\/beach\.png$/);
    await frame.get(new URL(body.image.url).pathname).expect(200);
    await frame.get('/api/notes/active').expect(200);

    // Signing out locks the frame again
    await frame.delete('/api/auth/session').expect(200);
    await frame.get('/api/images/random').expect(401);
  });

  test('the health check stays open', async () => {
    await request(app).get('/api/health').expect(200);
  });
});

describe('PUBLIC_PHOTOS keeps the old open behaviour for setups that rely on it', () => {
  test('with publicPhotos on, photos load without signing in', async () => {
    const open = createApp({ publicPhotos: true });
    await fs.ensureDir(path.join(testUploadsDir, 'family'));
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#3c3' } }).png().toBuffer();
    await fs.writeFile(path.join(testUploadsDir, 'family', 'garden.png'), png);
    try {
      await request(open).get('/api/images/random').expect(200);
      await request(open).get('/uploads/family/garden.png').expect(200);
    } finally {
      createApp(); // back to the default for anything that runs after
      await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
    }
  });
});
