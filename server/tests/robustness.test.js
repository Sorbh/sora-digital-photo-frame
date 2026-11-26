const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');
const sharp = require('sharp');

// Point the app at throwaway folders before it loads
const testUploadsDir = path.join(__dirname, 'robust-uploads');
const testCacheDir = path.join(__dirname, 'robust-cache');
const testDataDir = path.join(__dirname, 'robust-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'test-admin-pass';

const LocalDataStore = require('../store/LocalDataStore');
const LocalPhotoLibrary = require('../library/LocalPhotoLibrary');
const { createApp } = require('../app');
const pairing = require('../services/pairingService');
const photoInfo = require('../services/photoInfoService');

// A store that can break on demand, like a database going away
let storeDown = false;
let noTenant = false;
const failingWrites = { name: null, skip: 0, fail: 0 }; // writes of one file to let through, then to fail
class FlakyStore extends LocalDataStore {
  async get(name, fallback) {
    if (storeDown) throw new Error('store is down');
    if (noTenant) throw Object.assign(new Error('Authentication required'), { status: 401, code: 'AUTH_REQUIRED' });
    return super.get(name, fallback);
  }
  async update(name, fallback, updater) {
    if (name === failingWrites.name) {
      if (failingWrites.skip > 0) failingWrites.skip -= 1;
      else if (failingWrites.fail > 0) {
        failingWrites.fail -= 1;
        throw new Error('store is down');
      }
    }
    return super.update(name, fallback, updater);
  }
}

// A session store that can fail to swap a session id, like a database going away
const session = require('express-session');
let sessionsDown = false;
let sessionWritesToFail = 0;
class FlakySessions extends session.MemoryStore {
  destroy(sid, callback) {
    if (sessionsDown) return callback(new Error('sessions are down'));
    return super.destroy(sid, callback);
  }
  set(sid, data, callback) {
    if (sessionWritesToFail > 0) {
      sessionWritesToFail -= 1;
      return callback(new Error('sessions are down'));
    }
    return super.set(sid, data, callback);
  }
}

let failEvents = false;
const app = createApp({
  dataStore: new FlakyStore(),
  sessionStore: new FlakySessions(),
  events: {
    devicesRemoved() {
      if (failEvents) throw new Error('host index is down');
    }
  }
});

const sessionCookie = res => /photoframe\.sid=([^;]+)/.exec((res.headers['set-cookie'] || []).join(';'))?.[1];

describe('Robustness', () => {
  const admin = request.agent(app);
  const dataStore = new LocalDataStore();
  let png;
  let stored;

  beforeAll(async () => {
    await fs.ensureDir(path.join(testUploadsDir, 'family'));
    await admin.post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200);
    png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#c33' } }).png().toBuffer();

    const photo = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#36c' } })
      .jpeg()
      .withMetadata({ exif: { IFD2: { DateTimeOriginal: '2019:03:12 18:04:00' } } })
      .toBuffer();
    const res = await admin.post('/api/upload')
      .field('path', 'uploads/family')
      .attach('images', photo, 'IMG_0001.jpg')
      .expect(200);
    stored = res.body.files[0];
  });

  afterEach(() => {
    storeDown = false;
    noTenant = false;
    failEvents = false;
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await photoInfo.flush(); // a save still waiting would bring the folders back
    await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
  });

  describe('the slideshow script', () => {
    test('sets up its decryption state in the class that uses it', async () => {
      const source = await fs.readFile(path.join(__dirname, '../public/js/slideshow.js'), 'utf8');
      const slideshow = source.slice(source.indexOf('class PhotoFrameSlideshow'), source.indexOf('class WeatherWidget'));
      expect(slideshow).toContain('this.objectUrls = [null, null]');
      expect(slideshow).toContain('this.frameKeys = new Map()');
    });
  });

  describe('thumbnails', () => {
    test('are never stored by shared caches', async () => {
      const res = await admin.get('/api/folders/family/thumbnail').expect(200);
      expect(res.headers['cache-control']).toMatch(/^private/);
    });

    test('are checked with the server again before the browser reuses them', async () => {
      for (const url of ['/api/folders/family/thumbnail?v=1', '/api/folders/family/thumbnail']) {
        const res = await admin.get(url).expect(200);
        expect(res.headers['cache-control']).toBe('private, no-cache');
        expect(res.headers.etag).toBeTruthy();
        // Still signed in and allowed: the browser can keep its copy
        await admin.get(url).set('If-None-Match', res.headers.etag).expect(304);
      }
    });
  });

  describe('uploads', () => {
    const upload = count => {
      const req = admin.post('/api/upload').field('path', 'uploads/family');
      for (let i = 0; i < count; i += 1) req.attach('images', png, `p${i}.png`);
      return req;
    };

    test('accept 10 files in one request', async () => {
      const res = await upload(10).expect(200);
      expect(res.body.files).toHaveLength(10);
    });

    test('refuse more than 10 files in one request', async () => {
      const res = await upload(11).expect(400);
      expect(res.body.message).toMatch(/too many files/i);
    });
  });

  describe('when the store fails', () => {
    test('a frame is not told it was unpaired', async () => {
      storeDown = true;
      const res = await request(app).post('/api/auth/device').send({ token: 'dev_abc.secret' });
      expect(res.status).toBe(500);
      expect(res.body.code).not.toBe('DEVICE_UNKNOWN');
    });

    test('a frame with no tenant to look in is told it was unpaired', async () => {
      noTenant = true;
      const res = await request(app).post('/api/auth/device').send({ token: 'dev_abc.secret' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('DEVICE_UNKNOWN');
    });

    test('a frame can still collect its pairing on the next poll', async () => {
      await dataStore.set('access-accounts', [{ id: 'acc_pair', name: 'Grandma', pinHash: 'x', assignedFolders: [] }]);
      const frame = request.agent(app);
      const { body: started } = await frame.post('/api/pair/start').expect(200);
      await pairing.approve(started.code, { name: 'Tablet', accountId: 'acc_pair' });
      const poll = () => frame.post('/api/pair/collect').send({ code: started.code, secret: started.secret });

      storeDown = true;
      await poll().expect(500);
      storeDown = false;
      const { body } = await poll().expect(200);
      expect(body.status).toBe('approved');
      expect(body.token).toBeTruthy();
    });

    test('a frame can still collect its pairing after the session store failed', async () => {
      await dataStore.set('access-accounts', [{ id: 'acc_pair', name: 'Grandma', pinHash: 'x', assignedFolders: [] }]);
      const frame = request.agent(app);
      const { body: started } = await frame.post('/api/pair/start').expect(200);
      await frame.get('/api/auth/session'); // the frame has a session whose id is swapped at sign-in
      await pairing.approve(started.code, { name: 'Tablet', accountId: 'acc_pair' });
      const poll = () => frame.post('/api/pair/collect').send({ code: started.code, secret: started.secret });

      sessionsDown = true;
      try {
        await poll().expect(500);
      } finally {
        sessionsDown = false;
      }
      const { body } = await poll().expect(200);
      expect(body.status).toBe('approved');
      expect(body.token).toBeTruthy();
    });

    test('a frame can still collect its pairing after the signed-in session failed to save', async () => {
      await dataStore.set('access-accounts', [{ id: 'acc_pair', name: 'Grandma', pinHash: 'x', assignedFolders: [] }]);
      const frame = request.agent(app);
      const { body: started } = await frame.post('/api/pair/start').expect(200);
      await pairing.approve(started.code, { name: 'Tablet', accountId: 'acc_pair' });
      const poll = () => frame.post('/api/pair/collect').send({ code: started.code, secret: started.secret });

      // Exactly one write fails: the one saving the signed-in session
      sessionWritesToFail = 1;
      let failed;
      try {
        failed = await poll();
      } finally {
        sessionWritesToFail = 0;
      }
      expect(failed.status).toBe(500);
      // The failed try left this browser signed out, whatever cookie came back
      expect((await frame.get('/api/auth/session').expect(200)).body.authenticated).toBe(false);
      const { body } = await poll().expect(200);
      expect(body.status).toBe('approved');
      expect((await frame.get('/api/auth/session').expect(200)).body.authenticated).toBe(true);
    });

    test('an approval whose new account could not be finished fails and is undone', async () => {
      const devicesBefore = (await admin.get('/api/admin/devices').expect(200)).body.devices.length;
      const frame = request.agent(app);
      const { body: started } = await frame.post('/api/pair/start').expect(200);
      // The account is made, then the write that finishes it fails once
      Object.assign(failingWrites, { name: 'access-accounts', skip: 1, fail: 1 });
      let res;
      try {
        res = await admin.post(`/api/admin/pair/${started.code}/approve`).send({ name: 'Unfinished', newAccount: {} });
      } finally {
        Object.assign(failingWrites, { name: null, skip: 0, fail: 0 });
      }
      expect(res.status).toBe(500);
      expect((await admin.get('/api/admin/devices').expect(200)).body.devices).toHaveLength(devicesBefore);
      const accounts = (await admin.get('/api/access-accounts').expect(200)).body.accounts;
      expect(accounts.some(a => a.name === 'Unfinished')).toBe(false);
      const collected = await frame.post('/api/pair/collect').send({ code: started.code, secret: started.secret }).expect(200);
      expect(collected.body.status).not.toBe('approved');
    });

    test('saved photo info is not replaced after a failed read', async () => {
      await dataStore.set('photo-info', { 'family/old.webp': { key: 'k', takenAt: '2001-01-01T00:00:00' } });
      const state = photoInfo.state();
      const kept = state.info;
      state.info = null;
      try {
        storeDown = true;
        await expect(photoInfo.loadCache()).rejects.toThrow('store is down');
        expect(state.info).toBeNull();
        storeDown = false;
        await photoInfo.loadCache();
        expect(state.info['family/old.webp'].takenAt).toBe('2001-01-01T00:00:00');
      } finally {
        state.info = kept; // other tests rely on what's been remembered so far
      }
    });

    test('a PIN is not counted as wrong', async () => {
      storeDown = true;
      const res = await request(app).post('/api/auth/pin').send({ pin: '482913' });
      // The family's saved tries can't be read either: sign-in is refused for now
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('SIGN_IN_UNAVAILABLE');
    });
  });

  describe('when the host cannot hear about removed frames', () => {
    const device = { id: 'dev_keep', name: 'Tablet', accountId: 'acc_keep', tokenHash: 'x', pairedAt: '2026-01-01', lastSeen: null };

    beforeEach(async () => {
      await dataStore.set('devices', [device]);
      await dataStore.set('access-accounts', [{ id: 'acc_keep', name: 'Grandma', pinHash: 'x', assignedFolders: [] }]);
    });

    test('unpairing fails as a whole, so it can be retried', async () => {
      failEvents = true;
      await expect(pairing.removeDevices(d => d.id === device.id)).rejects.toThrow('host index is down');
      expect((await dataStore.get('devices', [])).map(d => d.id)).toEqual([device.id]);

      failEvents = false;
      await expect(pairing.removeDevices(d => d.id === device.id)).resolves.toBe(1);
      expect(await dataStore.get('devices', [])).toEqual([]);
    });

    test('deleting an account fails as a whole, too', async () => {
      failEvents = true;
      await admin.delete('/api/access-accounts/acc_keep').expect(500);
      expect((await dataStore.get('access-accounts', [])).map(a => a.id)).toEqual(['acc_keep']);
      expect((await dataStore.get('devices', [])).map(d => d.id)).toEqual([device.id]);
    });

    test('deleting an unknown account still answers 404', async () => {
      await admin.delete('/api/access-accounts/acc_nobody').expect(404);
      expect((await dataStore.get('devices', [])).map(d => d.id)).toEqual([device.id]);
    });
  });

  describe('PIN sign-in', () => {
    test('gives the session a new id', async () => {
      await dataStore.set('access-accounts', [{ id: 'acc_pin', name: 'Grandpa', pin: '482913', assignedFolders: [] }]);
      const agent = request.agent(app);
      const before = sessionCookie(await agent.post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200));
      const after = sessionCookie(await agent.post('/api/auth/pin').send({ pin: '482913' }).expect(200));
      expect(before).toBeTruthy();
      expect(after).toBeTruthy();
      expect(after).not.toBe(before);
      const session = await agent.get('/api/auth/session').expect(200);
      expect(session.body.authenticated).toBe(true);
    });
  });

  describe('captions', () => {
    const known = { takenAt: '2019-03-12T18:04:00', lat: 15.5, lon: 73.8 };

    beforeEach(() => {
      jest.spyOn(photoInfo, 'get').mockResolvedValue(known);
      jest.spyOn(photoInfo, 'placeName').mockResolvedValue('Panaji, India');
    });

    test('stay private from anyone who is not signed in, along with the photo itself', async () => {
      const res = await request(app).get('/api/images/random').expect(401);
      expect(res.body.image).toBeUndefined();
    });

    test('reach a signed-in viewer', async () => {
      const { body } = await admin.get('/api/images/random').expect(200);
      expect(body.image.info).toEqual({ takenAt: known.takenAt, place: 'Panaji, India' });
    });
  });

  describe('rotating a photo', () => {
    test('keeps its capture date (the stored copy has no EXIF)', async () => {
      await admin.post('/api/images/rotate').send({ path: stored.path, angle: 90 }).expect(200);
      const fullPath = path.join(testUploadsDir, 'family', path.basename(stored.path));
      const info = await photoInfo.get(fullPath, path.relative(testUploadsDir, fullPath));
      expect(info.takenAt).toBe('2019-03-12T18:04:00');
    });
  });

  describe('photo info', () => {
    test('is kept with durable data, not in the cache folder', async () => {
      await dataStore.set('photo-info', {});
      expect(await fs.pathExists(path.join(testDataDir, 'photo-info.json'))).toBe(true);
    });

    test('survives rotating a photo that was never viewed', async () => {
      const name = 'never-viewed.jpg';
      await sharp({ create: { width: 40, height: 30, channels: 3, background: '#3a6' } })
        .jpeg()
        .withMetadata({ exif: { IFD2: { DateTimeOriginal: '2015:06:01 09:30:00' } } })
        .toFile(path.join(testUploadsDir, 'family', name));
      await admin.post('/api/images/rotate').send({ path: `uploads/family/${name}`, angle: 90 }).expect(200);
      const fullPath = path.join(testUploadsDir, 'family', name);
      const info = await photoInfo.get(fullPath, path.relative(testUploadsDir, fullPath));
      expect(info.takenAt).toBe('2015-06-01T09:30:00');
    });
  });

  describe('listing a folder', () => {
    test('skips a file that disappears mid-listing', async () => {
      const folder = path.join(testUploadsDir, 'listing');
      await fs.ensureDir(folder);
      await fs.writeFile(path.join(folder, 'keep.jpg'), png);
      await fs.writeFile(path.join(folder, 'gone.tmp'), png);

      const realStat = fs.stat;
      jest.spyOn(fs, 'stat').mockImplementation((file, ...rest) => {
        if (String(file).endsWith('gone.tmp')) {
          return Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }));
        }
        return realStat(file, ...rest);
      });

      const { photos } = await new LocalPhotoLibrary().listFolder('uploads/listing');
      expect(photos.map(p => p.name)).toEqual(['keep.jpg']);
    });
  });
});
