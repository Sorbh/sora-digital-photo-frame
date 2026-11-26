const request = require('supertest');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const sharp = require('sharp');

// A symlink in the library can't take a frame past its folders, or anyone out of
// the library (#59): what a link leads to is checked where it really is
const testRoot = path.join(__dirname, 'symlinks-data');
const testUploadsDir = path.join(testRoot, 'uploads');
const outsideDir = path.join(testRoot, 'outside');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = path.join(testRoot, 'cache');
process.env.DATA_DIR = path.join(testRoot, 'data');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'links-admin-pass';
delete process.env.PHOTO_ENCRYPTION_KEY;
delete process.env.MAX_FOLDER_DEPTH;

const { StaticKeyProvider } = require('../crypto/keys');
const { createApp } = require('../app');
const LocalPhotoLibrary = require('../library/LocalPhotoLibrary');

const image = (color, format) => sharp({ create: { width: 8, height: 8, channels: 3, background: color } })[format]().toBuffer();
const at = (...parts) => path.join(testUploadsDir, ...parts);

let canLink = true;
beforeAll(async () => {
  for (const [dir, name, color, format] of [
    [at('Kids'), 'kid.jpg', '#3c3', 'jpeg'],
    [at('Kids', 'sub'), 'ok.jpg', '#33c', 'jpeg'],
    [at('Private'), 'secret.jpg', '#c33', 'jpeg'],
    [at('Private'), 'secret.webp', '#c3c', 'webp'],
    [outsideDir, 'out.jpg', '#cc3', 'jpeg']
  ]) {
    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, name), await image(color, format));
  }
  try {
    await fs.symlink(at('Private'), at('Kids', 'link'), 'dir'); // to a sibling folder
    await fs.symlink(at('Private', 'secret.jpg'), at('Kids', 'alias.jpg'), 'file'); // to a photo in it
    await fs.symlink(testUploadsDir, at('Kids', 'up'), 'dir'); // to the library root
    await fs.symlink(at('Kids', 'sub'), at('Kids', 'inner'), 'dir'); // inside the frame's own folder
    await fs.symlink(outsideDir, at('Kids', 'out'), 'dir'); // out of the library
  } catch {
    canLink = false; // e.g. Windows without the right to make symlinks
  }
});
afterAll(() => fs.remove(testRoot));

const linkTest = (name, fn) => test(name, async () => {
  if (!canLink) return console.warn(`Skipped (symlinks can't be made here): ${name}`);
  await fn();
});

test('the library resolves where a path really is, and null out of it', async () => {
  if (!canLink) return;
  const library = new LocalPhotoLibrary(testUploadsDir);
  expect(await library.realPath('uploads/Kids/kid.jpg')).toBe(path.join('uploads', 'Kids', 'kid.jpg'));
  expect(await library.realPath('uploads/Kids/link/secret.jpg')).toBe(path.join('uploads', 'Private', 'secret.jpg'));
  expect(await library.realPath('uploads/Kids/alias.jpg')).toBe(path.join('uploads', 'Private', 'secret.jpg'));
  expect(await library.realPath('uploads/Kids/up')).toBe('uploads');
  // Parts that don't exist yet stay, below where the rest really is
  expect(await library.realPath('uploads/Kids/link/New/Deeper')).toBe(path.join('uploads', 'Private', 'New', 'Deeper'));
  expect(await library.realPath('uploads/Kids/out/out.jpg')).toBeNull();
  expect(await library.realPath('uploads/Kids/out/missing')).toBeNull();
});

for (const [storage, options] of [
  ['photos on disk', () => ({})],
  ['encrypted photos', () => ({ keys: new StaticKeyProvider({ k1: crypto.randomBytes(32) }, 'k1') })]
]) {
  describe(`symlinks, ${storage}`, () => {
    let admin, frame;
    beforeAll(async () => {
      const app = createApp(options());
      admin = request.agent(app);
      await admin.post('/api/auth/login').send({ password: 'links-admin-pass' }).expect(200);
      const pin = String(810000 + Math.floor(Math.random() * 90000));
      await admin.post('/api/access-accounts').send({ name: `Kids ${pin}`, pin, assignedFolders: ['Kids'] }).expect(201);
      frame = request.agent(app);
      await frame.post('/api/auth/pin').send({ pin }).expect(200);
    });

    linkTest('a frame gets its own photos, also through a link that stays inside its folder', async () => {
      await frame.get('/uploads/Kids/kid.jpg').expect(200);
      await frame.get('/uploads/Kids/inner/ok.jpg').expect(200);
      await frame.get(`/api/images/${encodeURIComponent('Kids/inner/ok.jpg')}/thumbnail`).expect(200);
    });

    linkTest('a frame can\'t read another folder through a link in its own', async () => {
      for (const url of [
        '/uploads/Kids/link/secret.jpg',
        '/uploads/Kids/alias.jpg',
        '/uploads/Kids/up/Private/secret.jpg',
        '/uploads/Kids%2Flink%2Fsecret.jpg'
      ]) {
        const res = await frame.get(url);
        expect([url, res.status]).toEqual([url, 404]);
      }
      // Nor the JPEG copy of a WebP made for older frames
      await frame.get('/uploads/Kids/link/secret.webp').set('Accept', 'image/jpeg').expect(404);
      await frame.get('/uploads/Kids/link/secret.webp').set('Accept', 'image/webp').expect(404);
    });

    linkTest('nor its thumbnails, folder listing or folder cover', async () => {
      for (const photo of ['Kids/link/secret.jpg', 'Kids/alias.jpg', 'Kids/up/Private/secret.jpg']) {
        await frame.get(`/api/images/${encodeURIComponent(photo)}/thumbnail`).expect(404);
      }
      await frame.get('/api/folders/Kids/link').expect(404);
      await frame.get('/api/folders/Kids/link/thumbnail').expect(404);
      await frame.get('/api/folders/Kids/up/Private').expect(404);
      // A link back to the library root opens as the root, listing only the way to Kids
      const root = await frame.get('/api/folders/Kids/up').expect(200);
      expect(root.body.folders.map(f => f.name)).toEqual(['Kids']);
    });

    linkTest('nobody, the admin included, reads out of the library through a link', async () => {
      await admin.get('/uploads/Kids/out/out.jpg').expect(404);
      await admin.get(`/api/images/${encodeURIComponent('Kids/out/out.jpg')}/thumbnail`).expect(404);
      await admin.get('/api/folders/Kids/out').expect(404);
      await admin.get('/api/folders/Kids/out/thumbnail').expect(404);
      // Inside the library the admin sees everything, links too
      await admin.get('/uploads/Kids/link/secret.jpg').expect(200);
    });
  });
}
