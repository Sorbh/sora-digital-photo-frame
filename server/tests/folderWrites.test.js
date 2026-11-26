const request = require('supertest');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs-extra');
const sharp = require('sharp');

// Saving into a folder never makes it again once it's deleted (#89), and the
// slideshow's folder filter works whatever the separators
const testRoot = path.join(__dirname, 'folder-writes-data');
const testUploadsDir = path.join(testRoot, 'uploads');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = path.join(testRoot, 'cache');
process.env.DATA_DIR = path.join(testRoot, 'data');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'writes-admin-pass';
delete process.env.PHOTO_ENCRYPTION_KEY;
delete process.env.MAX_FOLDER_DEPTH;

// Google Photos downloads answered here, without the network
jest.mock('../utils/googleUrls', () => ({
  isGooglePhotoUrl: () => true,
  fetchGooglePhoto: jest.fn()
}));

const { fetchGooglePhoto } = require('../utils/googleUrls');
const LocalPhotoLibrary = require('../library/LocalPhotoLibrary');
const EncryptedPhotoLibrary = require('../library/EncryptedPhotoLibrary');
const LocalDataStore = require('../store/LocalDataStore');
const EncryptedDataStore = require('../store/EncryptedDataStore');
const { StaticKeyProvider } = require('../crypto/keys');
const { createApp } = require('../app');
const { getLibrary } = require('../library');
const playOrder = require('../services/playOrderService');
const jobManager = require('../utils/jobManager');
const { inFolder } = require('../utils/viewerAccess');

const jpeg = () => sharp({ create: { width: 16, height: 12, channels: 3, background: '#36c' } }).jpeg().toBuffer();
const keys = () => new StaticKeyProvider({ k1: crypto.randomBytes(32) }, 'k1');
const folder = (name) => path.join(testUploadsDir, name);

afterAll(() => fs.remove(testRoot));

describe('the library never makes a folder when saving into it', () => {
  for (const [name, make] of [
    ['LocalPhotoLibrary', root => new LocalPhotoLibrary(root)],
    ['EncryptedPhotoLibrary', root => new EncryptedPhotoLibrary(new LocalPhotoLibrary(root), keys())]
  ]) {
    describe(name, () => {
      let root;
      let library;
      beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-writes-'));
        library = make(root);
      });
      afterEach(async () => {
        jest.restoreAllMocks();
        await fs.remove(root);
      });

      const gone = { status: 404, code: 'FOLDER_NOT_FOUND' };
      const photo = { buffer: Buffer.from('picture'), originalName: 'a.jpg', contentType: 'image/jpeg' };

      test('addPhoto, writeItem and movePhoto into a missing folder: FOLDER_NOT_FOUND, still missing', async () => {
        await library.createFolder('uploads/Here');
        await library.addPhoto('uploads/Here', photo);

        await expect(library.addPhoto('uploads/Gone', photo)).rejects.toMatchObject(gone);
        await expect(library.addPhoto('uploads/Gone/Deeper', photo)).rejects.toMatchObject(gone);
        await expect(library.writeItem('uploads/Gone/x.snap.json', Buffer.from('{}'))).rejects.toMatchObject(gone);
        await expect(library.movePhoto('uploads/Here/a.jpg', 'uploads/Gone')).rejects.toMatchObject(gone);

        expect(await library.exists('uploads/Gone')).toBe(false);
        expect(await library.exists('uploads/Here/a.jpg')).toBe(true);
      });

      test('a folder deleted while a photo is being written stays deleted', async () => {
        await library.createFolder('uploads/Busy');
        const realWrite = fs.writeFile;
        jest.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
          await fs.remove(path.join(root, 'Busy')); // deleted by someone else, mid-save
          return realWrite(...args);
        });
        await expect(library.addPhoto('uploads/Busy', photo)).rejects.toMatchObject(gone);
        expect(await fs.pathExists(path.join(root, 'Busy'))).toBe(false);
      });

      test('a folder deleted between writing an item and putting it in place stays deleted', async () => {
        await library.createFolder('uploads/Busy');
        const realRename = fs.rename;
        jest.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
          await fs.remove(path.join(root, 'Busy'));
          return realRename(...args);
        });
        await expect(library.writeItem('uploads/Busy/page.snap.json', Buffer.from('{}'))).rejects.toMatchObject(gone);
        expect(await fs.pathExists(path.join(root, 'Busy'))).toBe(false);
      });

      test('a destination deleted while a photo is being moved stays deleted', async () => {
        await library.createFolder('uploads/From');
        await library.createFolder('uploads/To');
        await library.addPhoto('uploads/From', photo);
        const realRename = fs.rename;
        jest.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
          await fs.remove(path.join(root, 'To'));
          return realRename(...args);
        });
        await expect(library.movePhoto('uploads/From/a.jpg', 'uploads/To')).rejects.toMatchObject(gone);
        expect(await fs.pathExists(path.join(root, 'To'))).toBe(false);
        expect(await library.exists('uploads/From/a.jpg')).toBe(true);
      });

      test('createFolder still makes folders, parents too', async () => {
        await library.createFolder('uploads/New/Inner');
        await library.addPhoto('uploads/New/Inner', photo);
        expect(await library.exists('uploads/New/Inner/a.jpg')).toBe(true);
      });
    });
  }
});

describe('folder settings (play order) never make their folder', () => {
  for (const [name, make] of [
    ['LocalDataStore', dir => new LocalDataStore(dir)],
    ['EncryptedDataStore', dir => new EncryptedDataStore(new LocalDataStore(dir), keys())]
  ]) {
    test(name, async () => {
      const store = make(path.join(testRoot, 'store-data'));
      await fs.ensureDir(folder('Kept'));
      await store.set('folder-settings:Kept', { order: 'newest' });
      expect(await store.get('folder-settings:Kept', {})).toEqual({ order: 'newest' });

      const gone = { status: 404, code: 'FOLDER_NOT_FOUND' };
      await expect(store.set('folder-settings:Gone', { order: 'oldest' })).rejects.toMatchObject(gone);
      await expect(store.update('folder-settings:Gone/Inner', {}, value => value)).rejects.toMatchObject(gone);
      expect(await fs.pathExists(folder('Gone'))).toBe(false);

      // Deleted while the update was working out the new value
      await expect(store.update('folder-settings:Kept', {}, async value => {
        await fs.remove(folder('Kept'));
        return { ...value, order: 'custom' };
      })).rejects.toMatchObject(gone);
      expect(await fs.pathExists(folder('Kept'))).toBe(false);

      // Other documents still get their folder made
      await store.set('notes', []);
      expect(await store.get('notes', null)).toEqual([]);
    });
  }
});

describe('the app answers 404 FOLDER_NOT_FOUND and leaves the folder deleted', () => {
  let app;
  let admin;
  beforeAll(async () => {
    app = createApp();
    admin = request.agent(app);
    await admin.post('/api/auth/login').send({ password: 'writes-admin-pass' }).expect(200);
  });
  beforeEach(async () => {
    await fs.remove(testUploadsDir);
    await fs.ensureDir(testUploadsDir);
  });
  afterEach(() => jest.restoreAllMocks());

  test('an upload into a folder that is gone', async () => {
    const res = await admin.post('/api/upload').field('path', 'uploads/Gone')
      .attach('images', await jpeg(), 'a.jpg').expect(404);
    expect(res.body).toMatchObject({ code: 'FOLDER_NOT_FOUND', files: [] });
    expect(await fs.pathExists(folder('Gone'))).toBe(false);
  });

  test('an upload whose folder is deleted while a photo is being saved', async () => {
    await fs.ensureDir(folder('Busy'));
    const library = getLibrary();
    const realAdd = library.addPhoto.bind(library);
    let calls = 0;
    jest.spyOn(library, 'addPhoto').mockImplementation(async (...args) => {
      if (++calls === 2) await fs.remove(folder('Busy')); // after the first photo was saved
      return realAdd(...args);
    });
    const res = await admin.post('/api/upload').field('path', 'uploads/Busy')
      .attach('images', await jpeg(), 'a.jpg')
      .attach('images', await jpeg(), 'b.jpg')
      .expect(404);
    expect(res.body.code).toBe('FOLDER_NOT_FOUND');
    expect(res.body.files).toHaveLength(1); // the one saved before, said so
    expect(await fs.pathExists(folder('Busy'))).toBe(false);
  });

  test('moving photos into a folder deleted after it was checked', async () => {
    await fs.ensureDir(folder('From'));
    await fs.ensureDir(folder('To'));
    await fs.writeFile(path.join(folder('From'), 'a.jpg'), await jpeg());
    await fs.writeFile(path.join(folder('From'), 'b.jpg'), await jpeg());
    const library = getLibrary();
    const realMove = library.movePhoto.bind(library);
    jest.spyOn(library, 'movePhoto').mockImplementation(async (...args) => {
      await fs.remove(folder('To'));
      return realMove(...args);
    });
    const res = await admin.post('/api/images/move')
      .send({ paths: ['uploads/From/a.jpg', 'uploads/From/b.jpg'], destination: 'uploads/To' }).expect(404);
    expect(res.body).toMatchObject({ code: 'FOLDER_NOT_FOUND', movedCount: 0, failedCount: 2 });
    expect(await fs.pathExists(folder('To'))).toBe(false);
    expect(await fs.pathExists(path.join(folder('From'), 'a.jpg'))).toBe(true);
    expect(await fs.pathExists(path.join(folder('From'), 'b.jpg'))).toBe(true);

    // Already gone before the move: the same answer
    const before = await admin.post('/api/images/move')
      .send({ paths: ['uploads/From/a.jpg'], destination: 'uploads/To' }).expect(404);
    expect(before.body.code).toBe('FOLDER_NOT_FOUND');
  });

  test('saving a play order for a folder deleted after it was checked', async () => {
    await fs.ensureDir(folder('Album'));
    const realWrite = playOrder.write.bind(playOrder);
    jest.spyOn(playOrder, 'write').mockImplementation(async (dir, settings) => {
      await fs.remove(dir);
      return realWrite(dir, settings);
    });
    const res = await admin.put(`/api/admin/folders/order?path=${encodeURIComponent('uploads/Album')}`)
      .send({ order: 'newest' }).expect(404);
    expect(res.body.code).toBe('FOLDER_NOT_FOUND');
    expect(await fs.pathExists(folder('Album'))).toBe(false);
  });

  test('a Google Photos import whose folder is deleted mid-way stops, and the folder stays deleted', async () => {
    const photo = await jpeg();
    let downloads = 0;
    fetchGooglePhoto.mockImplementation(async () => {
      if (++downloads === 2) await fs.remove(folder('Imported'));
      return new Response(photo, { headers: { 'content-type': 'image/jpeg' } });
    });
    const job = {
      id: 'import-1',
      data: { mediaItems: [1, 2, 3].map(id => ({ id: String(id), baseUrl: `https://lh3.googleusercontent.com/${id}` })), destinationPath: 'uploads/Imported', accessToken: 't' },
      progress: {}
    };
    // The import makes its destination itself, once, at the start
    await jobManager.executeGooglePhotosImport(job);
    const results = job.result.results;
    expect(results.map(r => r.success)).toEqual([true, false, false]);
    expect(results[1]).toMatchObject({ code: 'FOLDER_NOT_FOUND' });
    expect(results[2]).toMatchObject({ code: 'FOLDER_NOT_FOUND' });
    expect(downloads).toBe(2); // nothing more downloaded once it was gone
    expect(await fs.pathExists(folder('Imported'))).toBe(false);
  });
});

describe('slideshow folder filter (#89)', () => {
  test('matches a folder and the ones inside it, by whole names', () => {
    expect(inFolder('Trips/Italy/a.jpg', 'Trips', '/')).toBe(true);
    expect(inFolder('Trips/Italy/a.jpg', 'Trips/Italy', '/')).toBe(true);
    expect(inFolder('Trips/Italy/Rome/a.jpg', 'Trips/Italy', '/')).toBe(true);
    expect(inFolder('Trips/a.jpg', 'Trips/Italy', '/')).toBe(false);
    expect(inFolder('Tripsy/a.jpg', 'Trips', '/')).toBe(false);
    expect(inFolder('a.jpg', '', '/')).toBe(false);
  });

  test('on Windows the frame\'s "/" matches the "\\\\" paths the server writes', () => {
    const relative = require('path').win32.join('Trips', 'Italy', 'Rome', 'a.jpg');
    expect(relative).toBe('Trips\\Italy\\Rome\\a.jpg');
    expect(inFolder(relative, 'Trips/Italy', '\\')).toBe(true);
    expect(inFolder(relative, 'Trips\\Italy', '\\')).toBe(true);
    expect(inFolder(relative, 'Trips/Italy/Rome', '\\')).toBe(true);
    expect(inFolder(relative, 'Trips/Ita', '\\')).toBe(false);
    // Elsewhere a backslash is part of a name, so it isn't a separator
    expect(inFolder('Trips\\Italy/a.jpg', 'Trips', '/')).toBe(false);
    expect(inFolder('Trips\\Italy/a.jpg', 'Trips\\Italy', '/')).toBe(true);
  });

  test('a nested folder plays on the frame when asked for with "/"', async () => {
    const app = createApp();
    const admin = request.agent(app);
    await admin.post('/api/auth/login').send({ password: 'writes-admin-pass' }).expect(200);
    await fs.ensureDir(folder('Trips/Italy'));
    await fs.writeFile(path.join(folder('Trips/Italy'), 'a.jpg'), await jpeg());
    const res = await admin.get('/api/images/random').query({ folder: 'Trips/Italy' }).expect(200);
    expect(res.body.image.filename).toBe('a.jpg');
    await admin.get('/api/images/random').query({ folder: 'Trips/Ita' }).expect(404);
  });
});
