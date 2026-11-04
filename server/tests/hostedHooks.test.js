const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');
const sharp = require('sharp');

// Point the app at throwaway folders before it loads
const testUploadsDir = path.join(__dirname, 'hooks-uploads');
const testCacheDir = path.join(__dirname, 'hooks-cache');
const testDataDir = path.join(__dirname, 'hooks-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const { createApp } = require('../app');
const { currentTenant } = require('../context');

describe('Hosted hooks: tenant, auth provider, quota', () => {
  const seen = [];
  const app = createApp({
    resolveTenant: req => (req.get('x-tenant') ? { id: req.get('x-tenant'), plan: 'free' } : null),
    auth: {
      requireAuth: (req, res, next) => (req.get('x-tenant') ? next() : res.status(403).json({ message: 'nope' }))
    },
    quota: {
      async canAdd(bytes) {
        seen.push({ tenant: currentTenant().id, bytes });
        return currentTenant().id === 'full' ? { ok: false, message: 'Storage limit reached' } : { ok: true };
      }
    }
  });

  let png;

  beforeAll(async () => {
    await fs.ensureDir(path.join(testUploadsDir, 'family'));
    png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#c33' } }).png().toBuffer();
  });

  afterAll(async () => {
    await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
  });

  test('custom auth provider replaces the password session', async () => {
    await request(app).get('/api/admin/folders?path=uploads').expect(403);
    await request(app).get('/api/admin/folders?path=uploads').set('x-tenant', 'a').expect(200);
  });

  test('upload checks the quota for the tenant of the request, after multer', async () => {
    const res = await request(app)
      .post('/api/upload')
      .set('x-tenant', 'a')
      .field('path', 'uploads/family')
      .attach('images', png, 'red.png')
      .expect(200);

    expect(res.body.files).toHaveLength(1);
    expect(seen.at(-1).tenant).toBe('a');
    expect(seen.at(-1).bytes).toBeGreaterThan(0);
    expect(await fs.pathExists(path.join(testUploadsDir, 'family', path.basename(res.body.files[0].path)))).toBe(true);
  });

  test('upload over the limit is refused with 413', async () => {
    const res = await request(app)
      .post('/api/upload')
      .set('x-tenant', 'full')
      .field('path', 'uploads/family')
      .attach('images', png, 'red.png')
      .expect(413);

    expect(res.body.code).toBe('QUOTA_EXCEEDED');
    expect(res.body.files).toEqual([]);
    expect(seen.at(-1).tenant).toBe('full');
  });

  test('requests without a tenant use the default one', async () => {
    const tenants = [];
    const probe = createApp({ beforeRoutes: a => a.get('/probe', (req, res) => res.json(currentTenant())) });
    tenants.push((await request(probe).get('/probe').expect(200)).body);
    expect(tenants[0]).toEqual({ id: 'default', plan: 'self-hosted' });
  });
});

describe('Client errors from a hosted library keep their status', () => {
  const LocalPhotoLibrary = require('../library/LocalPhotoLibrary');

  // What a hosted library does for a request with no family signed in
  class SignedOutLibrary extends LocalPhotoLibrary {
    async listFolder() {
      throw Object.assign(new Error('Sign in first'), { status: 401, code: 'AUTH_REQUIRED' });
    }
    async allPhotos() { return this.listFolder(); }
    async exists() { return this.listFolder(); }
  }

  let app;
  // createApp sets the library for the whole process, so only after the suite above has run
  beforeAll(() => {
    app = createApp({ library: new SignedOutLibrary(testUploadsDir), auth: { requireAuth: (req, res, next) => next() } });
  });

  test.each(['/api/images/random', '/api/folders'])('%s answers 401, not 500', async (url) => {
    const res = await request(app).get(url).expect(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });
});
