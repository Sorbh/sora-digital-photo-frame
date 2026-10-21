const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');

// Point the app at throwaway folders before it loads
const testUploadsDir = path.join(__dirname, 'snaps-uploads');
const testCacheDir = path.join(__dirname, 'snaps-cache');
const testDataDir = path.join(__dirname, 'snaps-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'test-admin-pass';

const app = require('../server');
const snaps = require('../services/snapService');

describe('Snaps', () => {
  const agent = request.agent(app);
  const readSnap = file => fs.readJson(path.join(testUploadsDir, file));

  beforeAll(async () => {
    await fs.ensureDir(path.join(testUploadsDir, 'goa'));
    await fs.ensureDir(path.join(testUploadsDir, 'beach'));
    await fs.writeFile(path.join(testUploadsDir, 'goa/sand.jpg'), 'jpg');
    await fs.writeFile(path.join(testUploadsDir, 'goa/sea.jpg'), 'jpg');
    await agent.post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200);
  });

  afterAll(async () => {
    await fs.remove(testUploadsDir);
    await fs.remove(testCacheDir);
    await fs.remove(testDataDir);
  });

  test('slug keeps file names short and safe', () => {
    expect(snaps.slug('Our week in Goa!')).toBe('our-week-in-goa');
    expect(snaps.slug('Café ☀️')).toBe('cafe');
    expect(snaps.slug('!!!')).toBe('snap');
  });

  test('needs a signed-in admin', async () => {
    await request(app).post('/api/snaps').send({ folder: 'uploads/goa', title: 'Hi' }).expect(401);
  });

  test('creates, reads and updates a snap in a folder', async () => {
    const created = await agent.post('/api/snaps')
      .send({ folder: 'uploads/goa', title: 'Our week in Goa', message: 'Sun and sand', photos: ['uploads/goa/sand.jpg'], layout: 'cover' })
      .expect(201);
    expect(created.body.path).toBe('uploads/goa/our-week-in-goa.snap.json');
    expect(await readSnap('goa/our-week-in-goa.snap.json')).toMatchObject({ version: 1, title: 'Our week in Goa', photos: ['goa/sand.jpg'], layout: 'cover' });

    // The same headline never overwrites the first snap
    const second = await agent.post('/api/snaps').send({ folder: 'uploads/goa', title: 'Our week in Goa' }).expect(201);
    expect(second.body.path).toBe('uploads/goa/our-week-in-goa-2.snap.json');

    const loaded = await agent.get('/api/snaps').query({ path: created.body.path }).expect(200);
    expect(loaded.body.snap.photoUrls[0]).toMatchObject({ path: 'goa/sand.jpg', url: '/uploads/goa/sand.jpg' });

    await agent.put('/api/snaps').query({ path: created.body.path }).send({ theme: 'ink' }).expect(200);
    expect(await readSnap('goa/our-week-in-goa.snap.json')).toMatchObject({ title: 'Our week in Goa', theme: 'ink' });

    await agent.get('/api/snaps').query({ path: 'uploads/goa/sand.jpg' }).expect(404);
  });

  test('rejects a snap without a headline or with missing photos', async () => {
    const response = await agent.post('/api/snaps')
      .send({ folder: 'uploads/goa', title: '', photos: ['goa/nope.jpg'] })
      .expect(400);
    expect(response.body.errors).toHaveProperty('title');
    expect(response.body.errors).toHaveProperty('photos');
    await agent.post('/api/snaps').send({ folder: 'uploads/nowhere', title: 'Hi' }).expect(404);
  });

  test('lists snaps with the photos and plays them in the slideshow', async () => {
    const listed = await agent.get('/api/admin/folders').query({ path: 'uploads/goa' }).expect(200);
    const snap = listed.body.files.find(f => f.type === 'snap' && f.name === 'our-week-in-goa.snap.json');
    expect(snap.snap.title).toBe('Our week in Goa');
    expect(listed.body.files.filter(f => f.type === 'image')).toHaveLength(2);

    const seen = new Set();
    for (let i = 0; i < 40 && !seen.has('snap'); i++) {
      const { body } = await agent.get('/api/images/random').query({ folder: 'goa' }).expect(200);
      seen.add(body.image.type);
      if (body.image.type === 'snap') {
        expect(body.image.snap).toMatchObject({ title: expect.any(String), layout: expect.any(String) });
        expect(body.image.url).toBeUndefined();
      }
    }
    expect(seen.has('snap')).toBe(true);
  });

  test('moving a photo keeps its snaps pointing at it, and snaps move as files', async () => {
    await agent.post('/api/images/move')
      .send({ paths: ['uploads/goa/sand.jpg'], destination: 'uploads/beach' })
      .expect(200);
    expect((await readSnap('goa/our-week-in-goa.snap.json')).photos).toEqual(['beach/sand.jpg']);

    await agent.post('/api/images/move')
      .send({ paths: ['uploads/goa/our-week-in-goa-2.snap.json'], destination: 'uploads/beach' })
      .expect(200);
    expect(await fs.pathExists(path.join(testUploadsDir, 'beach/our-week-in-goa-2.snap.json'))).toBe(true);
  });
});
