const request = require('supertest');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const sharp = require('sharp');

// Point the app at throwaway folders before it loads
const testUploadsDir = path.join(__dirname, 'crypto-uploads');
const testCacheDir = path.join(__dirname, 'crypto-cache');
const testDataDir = path.join(__dirname, 'crypto-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'test-admin-pass';

const cipher = require('../crypto/photoCipher');
const browserCipher = require('../public/js/photoCipher');
const { StaticKeyProvider, keysFromEnv } = require('../crypto/keys');
const { createApp } = require('../app');

const key1 = crypto.randomBytes(32);
const key2 = crypto.randomBytes(32);
const keys = new StaticKeyProvider({ k1: key1, k2: key2 }, 'k2');
const getKey = id => keys.getKey(id);

describe('Photo cipher', () => {
  const plain = Buffer.from('a family photo');

  test('round trip, and a fresh IV every time', async () => {
    const a = cipher.encrypt(plain, keys.currentKey());
    const b = cipher.encrypt(plain, keys.currentKey());
    expect(cipher.isEncrypted(a)).toBe(true);
    expect(a.equals(b)).toBe(false);
    expect((await cipher.decrypt(a, getKey)).equals(plain)).toBe(true);
    expect(cipher.parse(a).keyId).toBe('k2');
  });

  test('older keys still decrypt (rotation)', async () => {
    const old = cipher.encrypt(plain, { id: 'k1', key: key1 });
    expect((await cipher.decrypt(old, getKey)).equals(plain)).toBe(true);
  });

  test('changed data, a swapped key id or an unknown key fail', async () => {
    const sealed = cipher.encrypt(plain, keys.currentKey());

    const flipped = Buffer.from(sealed);
    flipped[flipped.length - 20] ^= 1;
    await expect(cipher.decrypt(flipped, getKey)).rejects.toThrow();

    // Same length id pointing at the other key: the header is authenticated
    const swapped = Buffer.from(sealed);
    swapped.write('k1', 6);
    await expect(cipher.decrypt(swapped, getKey)).rejects.toThrow();

    await expect(cipher.decrypt(sealed, () => null)).rejects.toThrow(/Unknown encryption key/);
  });

  test('plain images are not mistaken for encrypted files', () => {
    expect(cipher.isEncrypted(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]))).toBe(false);
  });

  test('the browser module decrypts what the server encrypted', async () => {
    const sealed = cipher.encrypt(plain, keys.currentKey());
    const data = sealed.buffer.slice(sealed.byteOffset, sealed.byteOffset + sealed.length);
    const out = await browserCipher.decrypt(data, id => keys.getKey(id));
    expect(Buffer.from(out).equals(plain)).toBe(true);
    expect(browserCipher.supported()).toBe(true);
  });

  test('keys from the environment', () => {
    expect(keysFromEnv({})).toBeNull();
    const provider = keysFromEnv({ PHOTO_ENCRYPTION_KEY: key1.toString('base64'), PHOTO_ENCRYPTION_OLD_KEYS: `old:${key2.toString('base64')}` });
    expect(provider.currentKey().id).toBe('local-1');
    expect(provider.getKey('old').equals(key2)).toBe(true);
    expect(() => keysFromEnv({ PHOTO_ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(/32 bytes/);
  });
});

describe('Encrypted storage in the app', () => {
  const app = createApp({ keys });
  const agent = request.agent(app);
  let stored;

  beforeAll(async () => {
    await fs.ensureDir(path.join(testUploadsDir, 'family'));
    // A photo from before encryption was turned on
    await sharp({ create: { width: 20, height: 20, channels: 3, background: '#393' } }).jpeg()
      .toFile(path.join(testUploadsDir, 'family', 'old.jpg'));
    await agent.post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200);

    const photo = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#c33' } }).jpeg().toBuffer();
    const res = await agent.post('/api/upload').field('path', 'uploads/family').attach('images', photo, 'red.jpg').expect(200);
    stored = res.body.files[0].path;
  });

  afterAll(async () => {
    await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
  });

  const onDisk = adminPath => fs.readFile(path.join(testUploadsDir, path.relative('uploads', adminPath)));

  test('uploads are encrypted on disk', async () => {
    const bytes = await onDisk(stored);
    expect(cipher.isEncrypted(bytes)).toBe(true);
    expect(bytes.includes(Buffer.from('WEBP'))).toBe(false);
  });

  test('/uploads serves the decrypted photo', async () => {
    const res = await request(app).get('/' + stored).set('Accept', 'image/webp').buffer(true).expect(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect((await sharp(res.body).metadata()).width).toBe(300);
  });

  test('old browsers get a decrypted JPEG', async () => {
    const res = await request(app).get('/' + stored).set('Accept', 'image/*').buffer(true).expect(200);
    expect(res.headers['content-type']).toMatch(/^image\/jpeg/);
    expect((await sharp(res.body).metadata()).format).toBe('jpeg');
  });

  test('photos from before encryption still show', async () => {
    const res = await request(app).get('/uploads/family/old.jpg').buffer(true).expect(200);
    expect((await sharp(res.body).metadata()).format).toBe('jpeg');
  });

  test('thumbnails are made from the decrypted photo', async () => {
    const id = encodeURIComponent(path.relative('uploads', stored));
    const res = await agent.get(`/api/images/${id}/thumbnail`).expect(200);
    expect((await sharp(res.body).metadata()).format).toBe('webp');
  });

  test('paths outside uploads are refused', async () => {
    await request(app).get('/uploads/..%2f..%2fserver.js').expect(404);
  });

  test('notes are stored encrypted and read back', async () => {
    await agent.post('/api/notes').send({ title: 'Lake trip', message: 'Tuesday' }).expect(201);
    const raw = await fs.readJson(path.join(testDataDir, 'notes.json'));
    expect(Object.keys(raw)).toEqual(['encrypted']);
    expect(JSON.stringify(raw)).not.toMatch(/Lake trip/);

    const list = await agent.get('/api/notes').expect(200);
    expect(JSON.stringify(list.body)).toMatch(/Lake trip/);
  });
});
