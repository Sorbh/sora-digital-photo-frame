const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');
const sharp = require('sharp');

const testUploadsDir = path.join(__dirname, 'thumbcache-uploads');
const testCacheDir = path.join(__dirname, 'thumbcache-cache');
const testDataDir = path.join(__dirname, 'thumbcache-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'thumbcache-admin-pass';
delete process.env.PHOTO_ENCRYPTION_KEY;

const { createApp } = require('../app');
const { runWithTenant } = require('../context');
const thumbnails = require('../services/thumbnailService');
const accessAccounts = require('../controllers/accessAccountController');
const { RECHECK_MS } = require('../middleware/freshViewer');

// Admins may pick a family with a header, as a hosted setup would
const app = createApp({ resolveTenant: req => (req.get('x-tenant') ? { id: req.get('x-tenant'), plan: 'free' } : null) });
const png = color => sharp({ create: { width: 8, height: 8, channels: 3, background: color } }).png().toBuffer();
const ENDPOINTS = ['/api/images/private%2Fsecret.png/thumbnail', '/api/folders/private/thumbnail'];

// Past the time a signed-in frame's access is checked again
const later = (call) => {
  const realNow = Date.now;
  Date.now = () => realNow() + RECHECK_MS + 1000;
  return Promise.resolve(call()).finally(() => { Date.now = realNow; });
};

let admin;
beforeAll(async () => {
  await fs.ensureDir(path.join(testUploadsDir, 'private'));
  await fs.ensureDir(path.join(testUploadsDir, 'family'));
  await fs.writeFile(path.join(testUploadsDir, 'private', 'secret.png'), await png('#c33'));
  await fs.writeFile(path.join(testUploadsDir, 'family', 'beach.png'), await png('#3c3'));
  admin = request.agent(app);
  await admin.post('/api/auth/login').send({ password: 'thumbcache-admin-pass' }).expect(200);
});
beforeEach(() => accessAccounts.limiter.entries.clear());
afterAll(async () => {
  await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
});

describe('Protected thumbnails', () => {
  test.each(ENDPOINTS)('%s is revalidated, not kept fresh', async (url) => {
    for (const address of [url, `${url}?rev=1`]) {
      const res = await admin.get(address).expect(200);
      expect(res.headers['cache-control']).toBe('private, no-cache');
      expect(res.headers.etag).toBeTruthy();
      await admin.get(address).set('If-None-Match', res.headers.etag).expect(304);
    }
  });

  test('the library hands out new versioned addresses, not the old 7-day ?v= ones', async () => {
    const { body } = await admin.get('/api/admin/folders').query({ path: 'uploads/private' }).expect(200);
    expect(body.files[0].thumbnail).toMatch(/\/thumbnail\?rev=\d+$/);
    const { body: root } = await admin.get('/api/admin/folders').query({ path: 'uploads' }).expect(200);
    const folder = root.folders.find(item => item.name === 'private');
    expect(folder.thumbnail).toMatch(/\/thumbnail\?rev=/);
  });

  test.each(ENDPOINTS)('%s is confirmed only by its ETag, never by a date', async (url) => {
    const res = await admin.get(url).expect(200);
    expect(res.headers['last-modified']).toBeUndefined();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toUTCString();
    await admin.get(url).set('If-Modified-Since', future).expect(200);
  });

  test('note and snap photos use addresses not cached before thumbnails were always checked', async () => {
    const notes = require('../services/noteService');
    const [photo] = notes.photoUrls(['private/secret.png']);
    expect(photo.thumbnail).toBe('/api/images/private%2Fsecret.png/thumbnail?revalidate=1');
    const snapPage = await fs.readFile(path.join(__dirname, '../public/js/snap.js'), 'utf8');
    expect(snapPage).toContain('/thumbnail?revalidate=1`');
  });

  test('after signing out, a kept copy is not confirmed', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'thumbcache-admin-pass' }).expect(200);
    const tags = [];
    for (const url of ENDPOINTS) tags.push((await agent.get(url).expect(200)).headers.etag);
    await agent.post('/api/auth/logout');
    await agent.get('/api/auth/status').expect(res => expect(res.body.authenticated).toBeFalsy());
    for (const [i, url] of ENDPOINTS.entries()) {
      await agent.get(url).set('If-None-Match', tags[i]).expect(401);
    }
  });

  test('after losing access to the folder, a kept copy is not confirmed', async () => {
    const pin = '734519';
    const { body } = await admin.post('/api/access-accounts').send({ name: 'Frame', pin, assignedFolders: [] }).expect(201);
    const accountId = (body.account || body.data || body).id;
    const frame = request.agent(app);
    await frame.post('/api/auth/pin').send({ pin }).expect(200);
    const tags = [];
    for (const url of ENDPOINTS) tags.push((await frame.get(url).expect(200)).headers.etag);

    await admin.put(`/api/access-accounts/${accountId}`).send({ name: 'Frame', assignedFolders: ['family'] }).expect(200);
    for (const [i, url] of ENDPOINTS.entries()) {
      await later(() => frame.get(url).set('If-None-Match', tags[i]).expect(404));
    }
  });

  test("one family's copy is never confirmed for another family", async () => {
    const url = ENDPOINTS[0];
    const a = await admin.get(url).set('x-tenant', 'fam-a').expect(200);
    await admin.get(url).set('x-tenant', 'fam-b').expect(200);
    // Same size and time on disk, as two families' thumbnails can have
    const source = path.join(testUploadsDir, 'private', 'secret.png');
    const when = new Date(Date.now() + 60 * 1000);
    for (const id of ['fam-a', 'fam-b']) {
      await fs.utimes(runWithTenant({ id }, () => thumbnails.cachePathFor(source)), when, when);
    }
    const again = await admin.get(url).set('x-tenant', 'fam-a').expect(200);
    const res = await admin.get(url).set('x-tenant', 'fam-b').set('If-None-Match', again.headers.etag);
    expect(res.status).toBe(200);
    expect(a.headers.etag).toBeTruthy();
  });
});

describe('Thumbnail cache keys', () => {
  test("the default family's family/beach.png is never family \"family\"'s beach.png", () => {
    const fromDefault = runWithTenant({ id: 'default' }, () => thumbnails.cachePathFor(path.join(testUploadsDir, 'family', 'beach.png')));
    const fromFamily = runWithTenant({ id: 'family' }, () => thumbnails.cachePathFor(path.join(testUploadsDir, 'beach.png')));
    expect(fromDefault).not.toBe(fromFamily);
    const nested = runWithTenant({ id: 'a/b' }, () => thumbnails.cachePathFor(path.join(testUploadsDir, 'c.png')));
    const flat = runWithTenant({ id: 'a' }, () => thumbnails.cachePathFor(path.join(testUploadsDir, 'b', 'c.png')));
    expect(nested).not.toBe(flat);
  });
});

describe('Google Photos picker thumbnails', () => {
  test('are checked again before the browser reuses them', async () => {
    const google = require('../controllers/googlePhotosController');
    const oauth = require('../utils/oauthManager');
    const realFetch = global.fetch;
    const spies = [
      jest.spyOn(oauth, 'getStoredTokens').mockReturnValue({ access_token: 'token' }),
      jest.spyOn(oauth, 'isTokenExpired').mockReturnValue(false)
    ];
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Map([['content-type', 'image/jpeg']]), arrayBuffer: async () => new ArrayBuffer(3)
    });
    const headers = {};
    let answered;
    const done = new Promise(resolve => { answered = resolve; });
    const res = { set: h => Object.assign(headers, h), send: () => answered(), status: () => res, json: body => answered(body) };
    try {
      google.proxyThumbnail({ query: { url: 'https://lh3.googleusercontent.com/abc' }, session: {} }, res, answered);
      await done;
      expect(headers['Cache-Control']).toBe('private, no-cache');
    } finally {
      global.fetch = realFetch;
      spies.forEach(spy => spy.mockRestore());
    }
  });
});
