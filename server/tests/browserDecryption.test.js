const request = require('supertest');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const express = require('express');
const sharp = require('sharp');

// Point the app at throwaway folders before it loads
const testUploadsDir = path.join(__dirname, 'browser-uploads');
const testCacheDir = path.join(__dirname, 'browser-cache');
const testDataDir = path.join(__dirname, 'browser-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'test-admin-pass';

const { createApp } = require('../app');
const { StaticKeyProvider } = require('../crypto/keys');
const LocalPhotoLibrary = require('../library/LocalPhotoLibrary');
const browserCipher = require('../public/js/photoCipher');

const keys = new StaticKeyProvider({ k1: crypto.randomBytes(32) }, 'k1');

// Stands in for remote storage (R2): files can be fetched as stored, at /raw/...
class RemoteLikeLibrary extends LocalPhotoLibrary {
  rawUrl(adminPath) {
    this.resolve(adminPath);
    return `/raw/${adminPath.replace(/^uploads\//, '')}`;
  }
}

const photoBuffer = () => sharp({ create: { width: 120, height: 80, channels: 3, background: '#36c' } }).jpeg().toBuffer();

async function setUp(app) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200);
  await agent.post('/api/upload').field('path', 'uploads/family').attach('images', await photoBuffer(), 'a.jpg').expect(200);
  return agent;
}

describe('Browser-side decryption', () => {
  beforeEach(async () => {
    await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
    await fs.ensureDir(path.join(testUploadsDir, 'family'));
  });

  afterAll(async () => {
    await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
  });

  test('local disk: no rawUrl, and the key never leaves the server', async () => {
    const app = createApp({ keys });
    const agent = await setUp(app);

    const { body } = await agent.get('/api/images/random').expect(200);
    expect(body.image.rawUrl).toBeUndefined();
    await agent.get('/api/frame/keys?ids=k1').expect(404);
  });

  test('remote storage: frames get rawUrl, keys only when signed in, and can decrypt', async () => {
    const library = new RemoteLikeLibrary(testUploadsDir);
    const app = createApp({ keys, library, beforeRoutes: a => a.use('/raw', express.static(testUploadsDir)) });
    const agent = await setUp(app);

    const { body } = await agent.get('/api/images/random').expect(200);
    expect(body.image.rawUrl).toMatch(/^\/raw\/family\/.+\.webp$/);
    expect(body.image.mimeType).toBe('image/webp');

    // Not signed in: no keys
    await request(app).get('/api/frame/keys?ids=k1').expect(401);

    const keyRes = await agent.get('/api/frame/keys?ids=k1,unknown').expect(200);
    expect(keyRes.headers['cache-control']).toBe('no-store');
    expect(Object.keys(keyRes.body.keys)).toEqual(['k1']);

    // What the slideshow does: fetch the stored bytes and decrypt them
    const raw = await request(app).get(body.image.rawUrl).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(browserCipher.isEncrypted(raw.body)).toBe(true);

    const keyBytes = Buffer.from(keyRes.body.keys.k1, 'base64');
    const plain = await browserCipher.decrypt(raw.body, () => keyBytes);
    expect((await sharp(Buffer.from(plain)).metadata()).format).toBe('webp');

    // The server URL still works as the fallback
    const viaServer = await request(app).get(new URL(body.image.url).pathname).set('Accept', 'image/webp').expect(200);
    expect(viaServer.headers['content-type']).toBe('image/webp');
  });
});
