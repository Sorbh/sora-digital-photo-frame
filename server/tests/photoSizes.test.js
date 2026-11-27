// The library listing gives each photo its shape (width and height, learnt once
// and kept), a shaped thumbnail for the justified grid, and each folder a count.
const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');
const sharp = require('sharp');

const testUploadsDir = path.join(__dirname, 'sizes-uploads');
const testCacheDir = path.join(__dirname, 'sizes-cache');
const testDataDir = path.join(__dirname, 'sizes-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'sizes-admin-pass';
delete process.env.PHOTO_ENCRYPTION_KEY;

const { createApp } = require('../app');
const app = createApp();
const jpeg = (width, height) => sharp({ create: { width, height, channels: 3, background: '#c63' } }).jpeg().toBuffer();
let admin;

beforeAll(async () => {
  await fs.ensureDir(path.join(testUploadsDir, 'Trip', 'Day one'));
  await fs.writeFile(path.join(testUploadsDir, 'Trip', 'wide.jpg'), await jpeg(1200, 600));
  await fs.writeFile(path.join(testUploadsDir, 'Trip', 'Day one', 'a.jpg'), await jpeg(40, 30));
  await fs.writeFile(path.join(testUploadsDir, 'Trip', 'Day one', 'b.jpg'), await jpeg(40, 30));
  admin = request.agent(app);
  await admin.post('/api/auth/login').send({ password: 'sizes-admin-pass' }).expect(200);
});
afterAll(async () => {
  await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
});

const list = async folder => (await admin.get('/api/admin/folders').query({ path: folder }).expect(200)).body;

test('a photo not yet seen has no size; its shaped thumbnail learns it', async () => {
  const before = await list('uploads/Trip');
  const wide = before.files.find(file => file.name === 'wide.jpg');
  expect(wide.width).toBeNull();
  expect(wide.preview).toBe(`${wide.thumbnail}&fit=inside`);

  const thumb = await admin.get(wide.preview).buffer(true).parse((res, done) => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  }).expect(200);
  const meta = await sharp(thumb.body).metadata();
  expect(meta.width / meta.height).toBeCloseTo(2, 1); // its own shape, not a square

  const after = await list('uploads/Trip');
  const known = after.files.find(file => file.name === 'wide.jpg');
  expect(known.width / known.height).toBeCloseTo(2, 2); // the shape is what the grid needs
});

test('the square thumbnail is still there for covers and the viewer strip', async () => {
  const { files } = await list('uploads/Trip');
  const res = await admin.get(files[0].thumbnail).buffer(true).parse((r, done) => {
    const chunks = [];
    r.on('data', chunk => chunks.push(chunk));
    r.on('end', () => done(null, Buffer.concat(chunks)));
  }).expect(200);
  const meta = await sharp(res.body).metadata();
  expect(meta.width).toBe(meta.height);
});

test('an upload knows its size at once', async () => {
  await admin.post('/api/upload').field('path', 'uploads/Trip').attach('images', await jpeg(300, 400), 'tall.jpg').expect(res => {
    if (res.status >= 300) throw new Error(`upload ${res.status}: ${JSON.stringify(res.body)}`);
  });
  const { files } = await list('uploads/Trip');
  const tall = files.find(file => file.name !== 'wide.jpg');
  expect(tall).toBeDefined();
  expect([tall.width, tall.height]).toEqual([300, 400]);
});

test('folders carry what is directly inside them', async () => {
  const { folders } = await list('uploads/Trip');
  expect(folders.find(folder => folder.name === 'Day one').counts).toEqual({ photos: 2, folders: 0 });
  const top = await list('uploads');
  expect(top.folders.find(folder => folder.name === 'Trip').counts.folders).toBe(1);
});
