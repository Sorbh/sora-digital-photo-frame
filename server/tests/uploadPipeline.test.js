const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');
const sharp = require('sharp');
const exifr = require('exifr');

// Point the app at throwaway folders before it loads
const testUploadsDir = path.join(__dirname, 'pipeline-uploads');
const testCacheDir = path.join(__dirname, 'pipeline-cache');
const testDataDir = path.join(__dirname, 'pipeline-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'test-admin-pass';
// The defaults are under test, not a local .env
delete process.env.MAX_RESOLUTION_WIDTH;
delete process.env.MAX_RESOLUTION_HEIGHT;
delete process.env.IMAGE_QUALITY;

// createApp, not ../server, so dotenv doesn't load a local .env over the defaults
const app = require('../app').createApp();
const photoInfo = require('../services/photoInfoService');

describe('Upload pipeline', () => {
  const agent = request.agent(app);
  let stored;

  beforeAll(async () => {
    await fs.ensureDir(path.join(testUploadsDir, 'family'));
    await fs.ensureDir(path.join(testUploadsDir, 'trips'));
    await agent.post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200);

    // A 4000px-wide camera photo with a capture date and camera make in EXIF
    const photo = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#36c' } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Make: 'TestCam' }, IFD2: { DateTimeOriginal: '2019:03:12 18:04:00' } } })
      .toBuffer();

    const res = await agent.post('/api/upload')
      .field('path', 'uploads/family')
      .attach('images', photo, 'IMG_0001.jpg')
      .expect(200);
    stored = res.body.files[0];
  });

  afterAll(async () => {
    await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
  });

  test('stores a 2560px WebP display copy', async () => {
    expect(stored.path).toMatch(/^uploads\/family\/images-.+\.webp$/);
    const meta = await sharp(path.join(testUploadsDir, 'family', path.basename(stored.path))).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width, meta.height)).toBe(2560);
  });

  test('strips all metadata from the stored file', async () => {
    const buffer = await fs.readFile(path.join(testUploadsDir, 'family', path.basename(stored.path)));
    expect(await exifr.parse(buffer).catch(() => undefined)).toBeUndefined();
  });

  test('browsers that accept WebP get the WebP file', async () => {
    const res = await request(app).get('/' + stored.path).set('Accept', 'image/webp,*/*').expect(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers.vary).toMatch(/Accept/);
  });

  test('old browsers without WebP get a JPEG copy', async () => {
    const res = await request(app).get('/' + stored.path).set('Accept', 'image/png,image/*;q=0.8').expect(200);
    expect(res.headers['content-type']).toMatch(/^image\/jpeg/);
    expect((await sharp(res.body).metadata()).format).toBe('jpeg');
  });

  test('thumbnails fall back to JPEG for old browsers too', async () => {
    const id = encodeURIComponent(path.relative('uploads', stored.path));
    const webp = await agent.get(`/api/images/${id}/thumbnail`).set('Accept', 'image/webp').expect(200);
    expect(webp.headers['content-type']).toBe('image/webp');
    const jpeg = await agent.get(`/api/images/${id}/thumbnail`).set('Accept', 'image/*').expect(200);
    expect(jpeg.headers['content-type']).toMatch(/^image\/jpeg/);
  });

  test('keeps the capture date read from the original', async () => {
    const fullPath = path.join(testUploadsDir, 'family', path.basename(stored.path));
    const info = await photoInfo.get(fullPath, path.relative(testUploadsDir, fullPath));
    expect(info.takenAt).toBe('2019-03-12T18:04:00');
  });

  // Runs last: it moves the stored photo
  test('moving a photo keeps its capture date (the stored copy has no EXIF)', async () => {
    await agent.post('/api/images/move').send({ paths: [stored.path], destination: 'uploads/trips' }).expect(200);
    const movedPath = path.join(testUploadsDir, 'trips', path.basename(stored.path));
    expect(await fs.pathExists(movedPath)).toBe(true);
    const info = await photoInfo.get(movedPath, path.relative(testUploadsDir, movedPath));
    expect(info.takenAt).toBe('2019-03-12T18:04:00');
  });
});
