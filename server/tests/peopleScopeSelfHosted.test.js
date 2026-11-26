// Without a scope hook (self-hosted, or a provider without scope) nothing is
// limited: the admin sees and changes every folder. And a scope hook that
// answers wrongly locks everything rather than opening it.
const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');
const sharp = require('sharp');

const testUploadsDir = path.join(__dirname, 'scope-self-uploads');
const testCacheDir = path.join(__dirname, 'scope-self-cache');
const testDataDir = path.join(__dirname, 'scope-self-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'scope-self-pass';

const { createApp } = require('../app');
const { setAuthProvider, scopeFor } = require('../middleware/auth');
const { canSee, canOpen } = require('../utils/viewerAccess');

let jpeg;
async function buildLibrary() {
  require('../controllers/imageController').clearImageCache();
  await fs.emptyDir(testUploadsDir);
  for (const photo of ['Family/fam.jpg', 'Other/secret.jpg', 'top.jpg']) await fs.outputFile(path.join(testUploadsDir, photo), jpeg);
}

beforeAll(async () => {
  jpeg = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#3a7' } }).jpeg().toBuffer();
});
beforeEach(buildLibrary);
afterAll(async () => {
  setAuthProvider(undefined);
  await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
});

// The same checks for each way of running without a scope
async function seesAndChangesEverything(agent) {
  const features = await agent.get('/api/features').expect(200);
  expect(features.body.scope).toBeNull();

  const top = await agent.get('/api/admin/folders?path=uploads').expect(200);
  expect(top.body.folders.map(folder => folder.name)).toEqual(['Family', 'Other']);
  expect(top.body.files.map(file => file.name)).toEqual(['top.jpg']);
  expect(top.body.canCreateFolder).toBe(true);
  expect(top.body.canChange).toBe(true);
  await agent.get('/api/admin/folders?path=uploads%2FOther').expect(200);
  await agent.get('/uploads/Other/secret.jpg').expect(200);
  await agent.get(`/api/images/${encodeURIComponent('Other/secret.jpg')}/thumbnail`).expect(200);

  await agent.post('/api/admin/folders').send({ name: 'New', path: 'uploads' }).expect(200);
  await agent.put('/api/admin/folders/order?path=uploads').send({ order: 'newest' }).expect(200);
  await agent.post('/api/images/move').send({ paths: ['uploads/Other/secret.jpg'], destination: 'uploads' }).expect(200);
  await agent.delete(`/api/images?path=${encodeURIComponent('uploads/top.jpg')}`).expect(200);
  await agent.delete(`/api/admin/folders?path=${encodeURIComponent('uploads/Family')}`).expect(200);
  expect(await fs.pathExists(path.join(testUploadsDir, 'secret.jpg'))).toBe(true);

  await agent.get('/api/access-accounts').expect(200);
  await agent.get('/api/admin/devices').expect(200);
  await agent.get('/access-accounts').expect(200);
}

describe('No scope', () => {
  test('the self-hosted admin sees and changes everything', async () => {
    const app = createApp();
    const admin = request.agent(app);
    await admin.post('/api/auth/login').send({ password: 'scope-self-pass' }).expect(200);
    await seesAndChangesEverything(admin);
  });

  test('a provider without scope(req) limits nothing', async () => {
    const app = createApp({ auth: { requireAuth: (req, res, next) => next(), requireViewer: (req, res, next) => next() } });
    await seesAndChangesEverything(request(app));
  });
});

describe('scopeFor(req)', () => {
  afterEach(() => setAuthProvider(undefined));
  const req = { session: {} };
  const LOCKED = { folders: [], canEdit: false, isOwner: false };

  test('no provider, or no hook, or null: no limits', () => {
    expect(scopeFor(req)).toBeNull();
    setAuthProvider({ requireAuth: () => {} });
    expect(scopeFor(req)).toBeNull();
    setAuthProvider({ scope: () => null });
    expect(scopeFor(req)).toBeNull();
    expect(canSee(req, 'Other/secret.jpg')).toBe(true);
  });

  test('a scope is passed on as given', () => {
    setAuthProvider({ scope: () => ({ folders: ['Family'], canEdit: true, isOwner: false }) });
    expect(scopeFor(req)).toEqual({ folders: ['Family'], canEdit: true, isOwner: false });
    expect(canSee(req, 'Family/Beach/a.jpg')).toBe(true);
    expect(canSee(req, 'Other/secret.jpg')).toBe(false);
    expect(canSee(req, 'Familyish/a.jpg')).toBe(false);
    expect(canOpen(req, '')).toBe(true);
  });

  test('it limits a signed-in admin session too, unlike a PIN account\'s folders', () => {
    const admin = { session: { authenticated: true } };
    setAuthProvider({ scope: () => ({ folders: ['Family'], canEdit: true, isOwner: true }) });
    expect(canSee(admin, 'Other/secret.jpg')).toBe(false);
  });

  test('only true grants, and only null means all folders', () => {
    setAuthProvider({ scope: () => ({ canEdit: 'yes', isOwner: 1 }) });
    expect(scopeFor(req)).toEqual(LOCKED);
    setAuthProvider({ scope: () => ({ folders: 'Family', canEdit: true, isOwner: true }) });
    expect(scopeFor(req).folders).toEqual([]);
    setAuthProvider({ scope: () => ({ folders: ['Family', 7, '..', ''], canEdit: false, isOwner: false }) });
    expect(canSee(req, 'Family/a.jpg')).toBe(true);
    expect(canSee(req, 'a.jpg')).toBe(false);
  });

  test('a hook that throws, answers later or answers nonsense locks everything', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const answer of [() => { throw new Error('down'); }, async () => null, () => 'all', () => 42]) {
        setAuthProvider({ scope: answer });
        expect(scopeFor(req)).toEqual(LOCKED);
        expect(canSee(req, 'Family/a.jpg')).toBe(false);
      }
    } finally {
      console.error.mockRestore();
    }
  });
});
