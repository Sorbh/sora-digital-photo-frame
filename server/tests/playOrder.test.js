const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');
const sharp = require('sharp');

// Point the app at throwaway folders before it loads
const testUploadsDir = path.join(__dirname, 'order-uploads');
const testCacheDir = path.join(__dirname, 'order-cache');
const testDataDir = path.join(__dirname, 'order-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'test-admin-pass';

const app = require('../server');

// A tiny JPEG with a camera date and, optionally, a GPS position
const photo = (taken, gps) => {
  const exif = { IFD0: { Make: 'Test' } };
  if (taken) exif.IFD2 = { DateTimeOriginal: taken };
  if (gps) exif.IFD3 = gps;
  return sharp({ create: { width: 8, height: 8, channels: 3, background: '#c42b6e' } })
    .jpeg().withMetadata({ exif }).toBuffer();
};
const GOA = { GPSLatitudeRef: 'N', GPSLatitude: '15/1 29/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '73/1 49/1 0/1' };

describe('Play order and photo details', () => {
  const agent = request.agent(app);
  const realFetch = global.fetch;
  const names = res => res.body.files.map(f => f.name);
  const next = async (after) => {
    const query = { folder: 'trip' };
    if (after) query.after = after;
    return (await agent.get('/api/images/next').query(query).expect(200)).body.image;
  };

  beforeAll(async () => {
    const trip = path.join(testUploadsDir, 'trip');
    await fs.ensureDir(path.join(trip, 'day2'));
    await fs.writeFile(path.join(trip, 'a.jpg'), await photo('2019:03:12 18:04:00', GOA));
    await fs.writeFile(path.join(trip, 'b.jpg'), await photo('2021:07:01 09:00:00'));
    await fs.writeFile(path.join(trip, 'c.jpg'), await photo(null)); // no camera date: file date
    await fs.utimes(path.join(trip, 'c.jpg'), new Date('2000-01-01'), new Date('2000-01-01'));
    await fs.writeFile(path.join(trip, 'day2', 'z.jpg'), await photo('2018:01:01 10:00:00'));

    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ address: { city: 'Panaji Municipal Corporation', state: 'Goa', country: 'India' } })
    }));
    await agent.post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200);
  });

  afterAll(async () => {
    global.fetch = realFetch;
    await fs.remove(testUploadsDir);
    await fs.remove(testCacheDir);
    await fs.remove(testDataDir);
  });

  test('folders shuffle by default and list photos by name', async () => {
    const res = await agent.get('/api/admin/folders').query({ path: 'uploads/trip' }).expect(200);
    expect(res.body.order).toBe('shuffle');
    expect(names(res)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
  });

  test('only a signed-in admin can change the order, to a known one', async () => {
    await request(app).put('/api/admin/folders/order').query({ path: 'uploads/trip' }).send({ order: 'newest' }).expect(401);
    await agent.put('/api/admin/folders/order').query({ path: 'uploads/trip' }).send({ order: 'sideways' }).expect(400);
    await agent.put('/api/admin/folders/order').query({ path: 'uploads/nowhere' }).send({ order: 'newest' }).expect(404);
    await agent.put('/api/admin/folders/order').query({ path: 'uploads/trip' }).send({ order: 'custom', sequence: 'a.jpg' }).expect(400);
  });

  test('newest and oldest go by when the photo was taken', async () => {
    await agent.put('/api/admin/folders/order').query({ path: 'uploads/trip' }).send({ order: 'newest' }).expect(200);
    const listed = await agent.get('/api/admin/folders').query({ path: 'uploads/trip' }).expect(200);
    expect(listed.body.order).toBe('newest');
    expect(names(listed)).toEqual(['b.jpg', 'a.jpg', 'c.jpg']);

    // The frame steps through the whole folder, subfolders included, then wraps round
    const seen = [];
    let image = await next();
    for (let i = 0; i < 5; i++) {
      seen.push(image.id);
      image = await next(image.id);
    }
    expect(seen).toEqual(['trip/b.jpg', 'trip/a.jpg', 'trip/day2/z.jpg', 'trip/c.jpg', 'trip/b.jpg']);

    await agent.put('/api/admin/folders/order').query({ path: 'uploads/trip' }).send({ order: 'oldest' }).expect(200);
    expect((await next()).id).toBe('trip/c.jpg');
  });

  test('a dragged order plays in that order, unknown names dropped, new photos last', async () => {
    const saved = await agent.put('/api/admin/folders/order').query({ path: 'uploads/trip' })
      .send({ order: 'custom', sequence: ['c.jpg', 'a.jpg', 'nope.jpg', 'c.jpg'] })
      .expect(200);
    expect(saved.body.order).toBe('custom');
    expect(await fs.readJson(path.join(testUploadsDir, 'trip/.sora-folder.json')))
      .toEqual({ order: 'custom', sequence: ['c.jpg', 'a.jpg'] });

    const listed = await agent.get('/api/admin/folders').query({ path: 'uploads/trip' }).expect(200);
    expect(names(listed)).toEqual(['c.jpg', 'a.jpg', 'b.jpg']);

    const first = await next();
    const second = await next(first.id);
    const third = await next(second.id);
    const fourth = await next(third.id);
    expect([first.id, second.id, third.id, fourth.id]).toEqual(['trip/c.jpg', 'trip/a.jpg', 'trip/b.jpg', 'trip/day2/z.jpg']);

    // The settings file stays out of the library and the slideshow
    expect(names(listed)).not.toContain('.sora-folder.json');
  });

  test('photos carry when and where they were taken', async () => {
    const image = await next();
    expect(image.id).toBe('trip/c.jpg');
    expect(image.info).toEqual({ takenAt: null, place: null });

    const goa = await next(image.id);
    expect(goa.id).toBe('trip/a.jpg');
    expect(goa.info).toEqual({ takenAt: '2019-03-12T18:04:00', place: 'Panaji, India' });

    // The place is looked up once, then cached
    const calls = global.fetch.mock.calls.length;
    await next(image.id);
    expect(global.fetch.mock.calls.length).toBe(calls);
    expect(calls).toBe(1);
  });
});
