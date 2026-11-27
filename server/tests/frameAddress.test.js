// The screen's address is /frame. /slideshow, its address until 2026-11, moved
// there for good (301) and takes its query string along, so old bookmarks, TVs
// and links keep working.
const path = require('path');
const request = require('supertest');
const fs = require('fs-extra');

const testUploadsDir = path.join(__dirname, 'frame-address-uploads');
const testCacheDir = path.join(__dirname, 'frame-address-cache');
const testDataDir = path.join(__dirname, 'frame-address-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'test-admin-pass';

const { createApp } = require('../app');
const pages = require('../views/pages');

const publicDir = path.join(__dirname, '..', 'public');
const read = file => fs.readFileSync(path.join(publicDir, file), 'utf8');

describe('/frame, the screen\'s address', () => {
  let app;
  let admin;

  beforeAll(async () => {
    await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.ensureDir(dir)));
    app = createApp();
    admin = request.agent(app);
    await admin.post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200);
  });

  afterAll(async () => {
    await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
  });

  test('serves the screen page, signed out', async () => {
    const res = await request(app).get('/frame').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('/js/slideshow.js');
    expect(res.text).toContain('id="authOverlay"');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  test('/ goes to /frame', async () => {
    const res = await request(app).get('/').expect(302);
    expect(res.headers.location).toBe('/frame');
  });

  test('/slideshow moved to /frame for good', async () => {
    const res = await request(app).get('/slideshow').expect(301);
    expect(res.headers.location).toBe('/frame');
  });

  test('/slideshow keeps its query string', async () => {
    expect((await request(app).get('/slideshow?lang=es').expect(301)).headers.location).toBe('/frame?lang=es');
    expect((await request(app).get('/slideshow?pin=123456&lang=de').expect(301)).headers.location).toBe('/frame?pin=123456&lang=de');
    expect((await request(app).get('/slideshow?').expect(301)).headers.location).toBe('/frame?');
  });

  test('the redirect never leaves the site', async () => {
    for (const url of ['/slideshow?next=//evil.example', '/slideshow/?x=1', '/slideshow?//evil.example']) {
      expect((await request(app).get(url).expect(301)).headers.location).toMatch(/^\/frame(\?|$)/);
    }
  });

  test('signed in, the sign-in page sends next=/frame there', async () => {
    const res = await admin.get('/login?next=%2Fframe%3Flang%3Des').expect(302);
    expect(res.headers.location).toBe('/frame?lang=es');
    await admin.get(res.headers.location).expect(200);
  });

  test('signed in, next=/slideshow still lands on /frame', async () => {
    const first = await admin.get('/login?next=%2Fslideshow%3Flang%3Des').expect(302);
    const moved = await admin.get(first.headers.location).expect(301);
    expect(moved.headers.location).toBe('/frame?lang=es');
    await admin.get(moved.headers.location).expect(200);
  });

  test('the pages link to /frame, not /slideshow', async () => {
    const header = pages.renderHeader('library', {});
    const tabbar = pages.renderTabbar('library', {});
    for (const html of [header, tabbar, read('login.html'), read('folder-selection.html')]) {
      expect(html).toContain('href="/frame"');
      expect(html).not.toMatch(/['"]\/slideshow/);
    }
  });
});
