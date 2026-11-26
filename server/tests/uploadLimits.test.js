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
const { sharpInput, libheif } = require('../utils/heic');
const quotaService = require('../services/quotaService');
const slots = require('../utils/workSlots');
const { getLibrary } = require('../library');
const { readLimited } = require('../utils/jobManager');

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

  test('photos saved before one that is refused are listed', async () => {
    const res = await request(app)
      .post('/api/upload')
      .field('path', 'uploads/family')
      .attach('images', await png(10, 10), 'small.png')
      .attach('images', await png(1200, 1000), 'wide.png')
      .expect(400);
    expect(res.body.code).toBe('IMAGE_TOO_LARGE');
    expect(res.body.files).toHaveLength(1);
    expect(await fs.pathExists(path.join(testUploadsDir, 'family', path.basename(res.body.files[0].path)))).toBe(true);
  });

  test('a full library cannot add a snap', async () => {
    const res = await request(app).post('/api/snaps').set('x-tenant', 'full')
      .send({ folder: 'uploads/family', title: 'Hello' });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('QUOTA_EXCEEDED');
  });

  test('libheif is given its memory back when a HEIC file cannot be read', async () => {
    const realAlloc = libheif.heif_context_alloc;
    const freed = [];
    libheif.heif_context_alloc = (...args) => {
      const context = realAlloc(...args);
      const remove = context.delete.bind(context);
      context.delete = () => { freed.push(true); remove(); };
      return context;
    };
    try {
      const heic = await fs.readFile(path.join(__dirname, 'fixtures', 'tiny.heic'));
      // A real HEIC header with the picture cut off
      const broken = Buffer.concat([heic.subarray(0, 40), Buffer.alloc(64)]);
      await expect(sharpInput(broken)).rejects.toThrow();
      expect(freed).toHaveLength(1);
    } finally {
      libheif.heif_context_alloc = realAlloc;
    }
  });

  test("a hook's error details reach the browser with the saved photos", async () => {
    const spy = jest.spyOn(getLibrary(), 'addPhoto')
      .mockRejectedValueOnce(Object.assign(new Error('Limit {limit}'), { status: 403, code: 'PLAN_LIMIT', vars: { limit: 3 } }));
    try {
      const res = await request(app).post('/api/upload').field('path', 'uploads/family')
        .attach('images', await png(8, 8), 'p.png').expect(403);
      expect(res.body).toMatchObject({ code: 'PLAN_LIMIT', limit: 3, files: [] });
    } finally {
      spy.mockRestore();
    }
  });

  test('a snap that grows needs room; one that shrinks does not', async () => {
    const created = await request(app).post('/api/snaps').send({ folder: 'uploads/family', title: 'A title for now' }).expect(201);
    const snapPath = created.body.path || created.body.snap?.path || created.body.fullPath;
    expect(snapPath).toBeTruthy();
    await request(app).put('/api/snaps').query({ path: snapPath }).set('x-tenant', 'full')
      .send({ title: 'A much, much longer title than before, which needs more room' }).expect(413);
    await request(app).put('/api/snaps').query({ path: snapPath }).set('x-tenant', 'full').send({ title: 'Short' }).expect(200);
  });

  test('growth is measured in the family\'s turn, after the writes before it', async () => {
    let size = 300;
    const measured = [];
    const appQuota = quotaService.getQuota();
    quotaService.setQuota({ canAdd: async () => ({ ok: true }) });
    try {
      await Promise.all([
        quotaService.addWithinQuota(async () => 200 - size, async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          size = 200;
        }),
        quotaService.addWithinQuota(async () => { measured.push(300 - size); return 300 - size; }, async () => { size = 300; })
      ]);
      expect(measured).toEqual([100]);
    } finally {
      quotaService.setQuota(appQuota);
    }
  });

  test('rotating a photo with too many pixels is refused', async () => {
    await fs.writeFile(path.join(testUploadsDir, 'family', 'huge.png'), await png(1200, 1000));
    const res = await request(app).post('/api/images/rotate').send({ path: 'uploads/family/huge.png', angle: 90 }).expect(400);
    expect(res.body.code).toBe('IMAGE_TOO_LARGE');
  });

  test('rotation reads the photo only once it has its turn', async () => {
    await fs.writeFile(path.join(testUploadsDir, 'family', 'order.png'), await png(20, 10));
    const photoInfo = require('../services/photoInfoService');
    const seen = [];
    const spy = jest.spyOn(photoInfo, 'get').mockImplementation(async () => { seen.push(slots.running.total); return {}; });
    try {
      await request(app).post('/api/images/rotate').send({ path: 'uploads/family/order.png', angle: 90 }).expect(200);
      expect(seen).toEqual([1]);
    } finally {
      spy.mockRestore();
    }
  });

  test('a photo changed or removed while rotating is not overwritten', async () => {
    await fs.writeFile(path.join(testUploadsDir, 'family', 'moved.png'), await png(20, 10));
    const library = getLibrary();
    const realStat = library.stat.bind(library);
    let calls = 0;
    const statSpy = jest.spyOn(library, 'stat').mockImplementation(async adminPath => {
      calls += 1;
      return calls === 1 ? realStat(adminPath) : null; // gone by the time it is written
    });
    const writeSpy = jest.spyOn(library, 'writeItem');
    try {
      const res = await request(app).post('/api/images/rotate').send({ path: 'uploads/family/moved.png', angle: 90 }).expect(409);
      expect(res.body.code).toBe('PHOTO_CHANGED');
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      statSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  test('a photo removed while the quota hook answers is not written', async () => {
    await fs.writeFile(path.join(testUploadsDir, 'family', 'late.png'), await png(20, 10));
    const library = getLibrary();
    const realStat = library.stat.bind(library);
    let calls = 0;
    // Still there when measured, gone by the moment of writing
    const statSpy = jest.spyOn(library, 'stat').mockImplementation(async adminPath => {
      calls += 1;
      return calls <= 4 ? realStat(adminPath) : null; // exists, photo info, before, measured: then gone
    });
    const writeSpy = jest.spyOn(library, 'writeItem');
    try {
      const res = await request(app).post('/api/images/rotate').send({ path: 'uploads/family/late.png', angle: 90 }).expect(409);
      expect(res.body.code).toBe('PHOTO_CHANGED');
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      statSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  test('rotation waits its turn among the photos being converted', async () => {
    await fs.writeFile(path.join(testUploadsDir, 'family', 'turn.png'), await png(20, 10));
    const held = [slots.tryAcquire('default'), slots.tryAcquire('default')];
    let done = false;
    const rotating = request(app).post('/api/images/rotate').send({ path: 'uploads/family/turn.png', angle: 90 })
      .then(res => { done = true; return res; });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(done).toBe(false);
    held.forEach(release => release());
    expect((await rotating).status).toBe(200);
    expect(slots.running.total).toBe(0);
  });

  test('imports read a download only up to the size limit', async () => {
    const response = (chunks, length) => ({
      headers: { get: name => (name === 'content-length' ? length : null) },
      body: (async function* () { for (const chunk of chunks) yield chunk; })()
    });
    const max = 10;
    expect(await readLimited(response([Buffer.alloc(4)], '11'), max)).toBeNull();
    expect(await readLimited(response([Buffer.alloc(6), Buffer.alloc(6)], null), max)).toBeNull();
    expect((await readLimited(response([Buffer.alloc(4), Buffer.alloc(6)], '10'), max)).length).toBe(10);
  });

  test('a chunked upload is stopped at the size cap', async () => {
    const http = require('http');
    const server = app.listen(4821);
    try {
      const boundary = 'x-boundary';
      const result = await new Promise((resolve, reject) => {
        const req = http.request({ port: 4821, method: 'POST', path: '/api/upload', headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Transfer-Encoding': 'chunked'
        } }, (res) => {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, body: JSON.parse(body || '{}'), sent }); });
        });
        req.on('error', () => {}); // the server closes the connection after answering
        let sent = 0;
        req.write(`--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="big.png"\r\nContent-Type: image/png\r\n\r\n`);
        const chunk = Buffer.alloc(64 * 1024);
        const pump = () => {
          while (sent < 3 * 1024 * 1024) {
            sent += chunk.length;
            if (!req.write(chunk)) return req.once('drain', pump);
          }
          req.end();
        };
        pump();
        const timer = setTimeout(() => reject(new Error('no answer')), 4000);
      });
      expect(result.status).toBe(413);
      expect(result.body.code).toBe('UPLOAD_TOO_LARGE');
      expect(slots.running.total).toBe(0);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('an unexpected quota hook error gets a generic answer', async () => {
    const appQuota = quotaService.getQuota();
    quotaService.setQuota({ canAdd: async () => { throw new Error('database down at db-SECRET-host'); } });
    try {
      const res = await request(app).post('/api/upload').field('path', 'uploads/family')
        .attach('images', await png(8, 8), 'p.png').expect(500);
      expect(JSON.stringify(res.body)).not.toMatch(/SECRET/);
    } finally {
      quotaService.setQuota(appQuota);
    }
  });

  test('two uploads at once cannot both use the last free space', async () => {
    let used = 0;
    const limit = 100;
    const writes = [];
    const appQuota = quotaService.getQuota();
    quotaService.setQuota({ canAdd: async bytes => ({ ok: used + bytes <= limit, message: 'Storage limit reached' }) });
    try {
      const add = () => quotaService.addWithinQuota(80, async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        used += 80;
        writes.push(80);
      });
      const results = await Promise.allSettled([add(), add()]);
      expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(writes).toEqual([80]);
      expect(used).toBe(80);
    } finally {
      quotaService.setQuota(appQuota);
    }
  });

  describe('before the body is read', () => {
    const call = async (headers, tenant = { id: 'a' }) => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.status = code => { res.statusCode = code; return res; };
      res.set = () => res;
      res.json = body => { res.body = body; return res; };
      const next = jest.fn();
      const req = Object.assign(new EventEmitter(), { headers, tenant, unpipe() {}, destroy() {} });
      await uploadLimits(req, res, next);
      return { req, res, next };
    };
    const ok = { 'content-length': '100' };

    test('a request over the total size is refused', async () => {
      const { res, next } = await call({ 'content-length': String(1024 * 1024 + 1) });
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(413);
      expect(res.body.code).toBe('UPLOAD_TOO_LARGE');
    });

    test('a chunked request without a length goes on to the per-file limits', async () => {
      const { res, next } = await call({ 'transfer-encoding': 'chunked' });
      expect(next).toHaveBeenCalled();
      res.emit('close');
      expect(slots.running.total).toBe(0);
    });

    test("a quota hook's own error keeps its status, code and details", async () => {
      const appQuota = quotaService.getQuota();
      quotaService.setQuota({ canAdd: async () => { throw Object.assign(new Error('Upgrade to add more'), { status: 402, code: 'PLAN_LIMIT', vars: { plan: 'free' } }); } });
      try {
        const { res, next } = await call(ok, { id: 'g' });
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(402);
        expect(res.body).toEqual({ message: 'Upgrade to add more', code: 'PLAN_LIMIT', plan: 'free', files: [] });
        expect(slots.running.total).toBe(0);
      } finally {
        quotaService.setQuota(appQuota);
      }
    });

    test('a full library is refused before its photos are read', async () => {
      const { res, next } = await call(ok, { id: 'full', plan: 'free' });
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(413);
      expect(res.body.code).toBe('QUOTA_EXCEEDED');
    });

    test('only a few uploads run at once, per family and overall', async () => {
      const a1 = await call(ok, { id: 'a' });
      const a2 = await call(ok, { id: 'a' });
      const a3 = await call(ok, { id: 'a' });
      expect([a1, a2].every(c => c.next.mock.calls.length === 1)).toBe(true);
      expect(a3.res.statusCode).toBe(503);

      const b1 = await call(ok, { id: 'b' });
      const b2 = await call(ok, { id: 'b' });
      const c1 = await call(ok, { id: 'c' });
      expect(b1.next).toHaveBeenCalled();
      expect(b2.next).toHaveBeenCalled();
      expect(c1.res.statusCode).toBe(503); // four running in all

      // A request that ends before it is processed frees its place
      a1.res.emit('close');
      const c2 = await call(ok, { id: 'c' });
      expect(c2.next).toHaveBeenCalled();
      [a2, b1, b2, c2].forEach(c => c.res.emit('close'));
      expect(slots.running.total).toBe(0);
    });

    test('a browser that leaves while the quota is checked takes no place', async () => {
      const appQuota = quotaService.getQuota();
      quotaService.setQuota({ canAdd: () => new Promise(resolve => setTimeout(() => resolve({ ok: true }), 20)) });
      try {
        const res = new EventEmitter();
        res.status = () => res; res.set = () => res; res.json = () => res;
        const next = jest.fn();
        const pending = uploadLimits({ headers: ok, tenant: { id: 'f' } }, res, next);
        res.emit('close');
        await pending;
        expect(next).not.toHaveBeenCalled();
        expect(slots.running.total).toBe(0);
      } finally {
        quotaService.setQuota(appQuota);
      }
    });

    test('a browser that leaves during processing keeps the place taken until the work is done', async () => {
      const { req, res, next } = await call(ok, { id: 'd' });
      expect(next).toHaveBeenCalled();
      req.uploadSlot.started = true; // the upload handler is converting the photos
      res.emit('close');
      expect(slots.running.total).toBe(1);
      req.uploadSlot.finish();
      expect(slots.running.total).toBe(0);
    });

    test('imports wait for a free place', async () => {
      const held = [await call(ok, { id: 'e' }), await call(ok, { id: 'e' })];
      let started = false;
      const waiting = slots.acquire('e').then(release => { started = true; return release; });
      await new Promise(resolve => setImmediate(resolve));
      expect(started).toBe(false);
      held[0].res.emit('close');
      const release = await waiting;
      expect(started).toBe(true);
      release();
      held[1].res.emit('close');
      expect(slots.running.total).toBe(0);
    });
  });
});
