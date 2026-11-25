const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');
const sharp = require('sharp');
const { EventEmitter } = require('events');

// Point the app at throwaway folders, with small limits, before it loads
const testUploadsDir = path.join(__dirname, 'limits2-uploads');
const testCacheDir = path.join(__dirname, 'limits2-cache');
const testDataDir = path.join(__dirname, 'limits2-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.MAX_IMAGE_PIXELS = String(1000 * 1000);
process.env.MAX_UPLOAD_SIZE = String(1024 * 1024);

const { createApp } = require('../app');
const { currentTenant } = require('../context');
const { uploadLimits } = require('../middleware/upload');
const { displayCopy, MAX_FRAMES } = require('../utils/displayCopy');
const { sharpInput } = require('../utils/heic');

const png = (width, height) => sharp({ create: { width, height, channels: 3, background: '#c33' } }).png().toBuffer();

describe('Upload limits', () => {
  const seen = [];
  const app = createApp({
    resolveTenant: req => (req.get('x-tenant') ? { id: req.get('x-tenant'), plan: 'free' } : null),
    auth: { requireAuth: (req, res, next) => next() },
    quota: {
      async canAdd(bytes) {
        if (currentTenant().id !== 'full') return { ok: true };
        seen.push(bytes);
        return { ok: false, message: 'Storage limit reached' };
      }
    }
  });

  beforeAll(async () => {
    await fs.ensureDir(path.join(testUploadsDir, 'family'));
  });

  afterAll(async () => {
    delete process.env.MAX_IMAGE_PIXELS;
    delete process.env.MAX_UPLOAD_SIZE;
    await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
  });

  test('a full library is refused before the photo is converted', async () => {
    seen.length = 0;
    // Not a real image: converting it would fail with a server error
    const res = await request(app)
      .post('/api/upload')
      .set('x-tenant', 'full')
      .field('path', 'uploads/family')
      .attach('images', Buffer.from('not really a png'), { filename: 'x.png', contentType: 'image/png' })
      .expect(413);
    expect(res.body.code).toBe('QUOTA_EXCEEDED');
    expect(seen).toEqual([1]);
  });

  test('photos with too many pixels are refused with a code', async () => {
    const res = await request(app)
      .post('/api/upload')
      .field('path', 'uploads/family')
      .attach('images', await png(1200, 1000), 'wide.png')
      .expect(400);
    expect(res.body.code).toBe('IMAGE_TOO_LARGE');
    await request(app)
      .post('/api/upload')
      .field('path', 'uploads/family')
      .attach('images', await png(1000, 1000), 'fits.png')
      .expect(200);
  });

  test('animations with too many frames are refused', async () => {
    // Frames that differ, so the GIF encoder keeps them all
    const frames = [await png(2, 2), await sharp({ create: { width: 2, height: 2, channels: 3, background: '#33c' } }).png().toBuffer()];
    const animation = count => sharp(Array.from({ length: count }, (_, i) => frames[i % 2]), { join: { animated: true } }).gif().toBuffer();
    const gif = await animation(MAX_FRAMES + 1);
    await expect(displayCopy(gif, { animated: true })).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE', status: 400 });
    const short = await animation(3);
    await expect(displayCopy(short, { animated: true })).resolves.toBeInstanceOf(Buffer);
  });

  test('HEIC photos are measured before their pixels are decoded', async () => {
    const heic = await fs.readFile(path.join(__dirname, 'fixtures', 'tiny.heic'));
    const tooLarge = () => Object.assign(new Error('too large'), { code: 'IMAGE_TOO_LARGE' });
    await expect(sharpInput(heic, {}, { maxPixels: 0, tooLarge })).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' });
    const [, options] = await sharpInput(heic, {}, { maxPixels: 1, tooLarge });
    expect(options.raw).toMatchObject({ width: 1, height: 1 });
  });

  test('too many form fields are refused', async () => {
    const req = request(app).post('/api/upload').field('path', 'uploads/family');
    for (let i = 0; i < 12; i += 1) req.field(`extra${i}`, 'x');
    const res = await req.attach('images', await png(8, 8), 'p.png').expect(400);
    expect(res.body.code).toBe('LIMIT_FIELD_COUNT');
  });

  describe('before the body is read', () => {
    const call = (headers, tenant = { id: 'a' }) => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.status = code => { res.statusCode = code; return res; };
      res.set = () => res;
      res.json = body => { res.body = body; return res; };
      const next = jest.fn();
      uploadLimits({ headers, tenant }, res, next);
      return { res, next };
    };

    test('a request over the total size is refused', () => {
      const { res, next } = call({ 'content-length': String(1024 * 1024 + 1) });
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(413);
      expect(res.body.code).toBe('UPLOAD_TOO_LARGE');
    });

    test('a request without a length is refused', () => {
      const { res, next } = call({});
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(411);
    });

    test('only a few uploads run at once, per family and overall', () => {
      const a1 = call({ 'content-length': '100' }, { id: 'a' });
      const a2 = call({ 'content-length': '100' }, { id: 'a' });
      const a3 = call({ 'content-length': '100' }, { id: 'a' });
      expect([a1, a2].every(c => c.next.mock.calls.length === 1)).toBe(true);
      expect(a3.res.statusCode).toBe(503);

      const b1 = call({ 'content-length': '100' }, { id: 'b' });
      const b2 = call({ 'content-length': '100' }, { id: 'b' });
      const c1 = call({ 'content-length': '100' }, { id: 'c' });
      expect(b1.next).toHaveBeenCalled();
      expect(b2.next).toHaveBeenCalled();
      expect(c1.res.statusCode).toBe(503); // four running in all

      // A finished (or dropped) upload frees its place
      a1.res.emit('finish');
      a1.res.emit('close');
      const c2 = call({ 'content-length': '100' }, { id: 'c' });
      expect(c2.next).toHaveBeenCalled();
      [a2, b1, b2, c2].forEach(c => c.res.emit('close'));
      expect(call({ 'content-length': '100' }, { id: 'a' }).next).toHaveBeenCalled();
    });
  });
});
