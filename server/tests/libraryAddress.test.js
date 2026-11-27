// The library lives at /home. /admin, its old address, answers 301 to the same
// address under /home (query kept) so bookmarks, home-screen icons and old links
// keep working, and scripts cached under /admin/ still load.
const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');

const testUploadsDir = path.join(__dirname, 'home-uploads');
const testCacheDir = path.join(__dirname, 'home-cache');
const testDataDir = path.join(__dirname, 'home-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.ADMIN_PASSWORD = 'test-admin-pass';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const { createApp } = require('../app');

const manifest = () => JSON.parse(fs.readFileSync(path.join(__dirname, '../public/icons/library.webmanifest'), 'utf8'));
let app;
let admin;

beforeAll(async () => {
  await fs.ensureDir(testUploadsDir);
  app = createApp();
  admin = request.agent(app);
  await admin.post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200);
});

afterAll(async () => {
  await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
});

describe('the library is at /home', () => {
  test('signing in lands on /home', async () => {
    const res = await request(app).post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200);
    expect(res.body.redirect).toBe('/home');
    const form = await request(app).post('/api/auth/login').type('form').send({ password: 'test-admin-pass' }).expect(302);
    expect(form.headers.location).toBe('/home');
  });

  test.each(['/home', '/home/'])('%s serves the library', async (url) => {
    const res = await admin.get(url).expect(200).expect('Content-Type', /html/);
    expect(res.text).toMatch(/data-sora-header="library"/);
  });

  test('signed out, /home asks to sign in first and comes back', async () => {
    const res = await request(app).get('/home?path=uploads%2FFamily').expect(302);
    expect(res.headers.location).toBe('/login?next=%2Fhome%3Fpath%3Duploads%252FFamily');
  });

  test('the header and tab bar link to /home', async () => {
    const notes = (await admin.get('/notes').expect(200)).text;
    expect(notes).toMatch(/<a href="\/home" class="tb-btn tb-desktop" data-header-item="library"/);
    expect(notes).toMatch(/<a href="\/home" class="sora-wordmark" data-brand/);
    expect(notes).toMatch(/<a href="\/home"[^>]*data-tab="library">/);
    expect(notes).not.toMatch(/href="\/admin/);
  });

  test('every script and style of the page loads under /home/', async () => {
    const html = (await admin.get('/home/').expect(200)).text;
    const assets = [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="([^"]+)"/g)]
      .map(match => new URL(match[1], 'http://frame.test/home/'))
      .filter(url => url.host === 'frame.test');
    expect(assets.length).toBeGreaterThan(5);
    for (const url of assets) {
      const res = await admin.get(url.pathname + url.search);
      expect([url.pathname, res.status]).toEqual([url.pathname, 200]);
      expect([url.pathname, res.type]).not.toEqual([url.pathname, 'text/html']);
    }
  });

  test('the home-screen app opens /home, and stays the same installed app', () => {
    expect(manifest().start_url).toBe('/home');
    expect(manifest().id).toBe('/admin');
  });
});

describe('/admin, the old address, sends to /home', () => {
  test.each([
    ['/admin', '/home'],
    ['/admin/', '/home'],
    ['/admin?path=x', '/home?path=x'],
    ['/admin?path=uploads%2FFamily', '/home?path=uploads%2FFamily'],
    ['/admin/?path=uploads%2FFamily&shared=1', '/home?path=uploads%2FFamily&shared=1']
  ])('%s answers 301 to %s', async (from, to) => {
    for (const agent of [admin, request(app)]) {
      const res = await agent.get(from).expect(301);
      expect(res.headers.location).toBe(to);
    }
  });

  test('scripts cached under /admin/ still load', async () => {
    const res = await admin.get('/admin/admin.js').expect(200);
    expect(res.type).toMatch(/javascript/);
    await admin.get('/admin/js/settings.js').expect(200);
  });

  test('the API under /api/admin stays where it is', async () => {
    const res = await admin.get('/api/admin/folders').expect(200);
    expect(res.type).toMatch(/json/);
  });
});
