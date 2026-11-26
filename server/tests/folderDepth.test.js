const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');
const sharp = require('sharp');

// Point the app at throwaway folders before it loads (issue #88)
const testUploadsDir = path.join(__dirname, 'depth-uploads');
const testCacheDir = path.join(__dirname, 'depth-cache');
const testDataDir = path.join(__dirname, 'depth-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'test-admin-pass';
process.env.ENABLE_GOOGLE_PHOTOS = 'true';
delete process.env.MAX_FOLDER_DEPTH;

const { createApp } = require('../app');
const oauthManager = require('../utils/oauthManager');
const jobManager = require('../utils/jobManager');
const { parseMaxFolderDepth, folderDepth } = require('../utils/folderDepth');

const jpeg = () => sharp({ create: { width: 32, height: 24, channels: 3, background: '#c33' } }).jpeg().toBuffer();

// A signed-in admin on an app started with MAX_FOLDER_DEPTH as given (undefined: unset)
async function adminFor(depth) {
  if (depth === undefined) delete process.env.MAX_FOLDER_DEPTH;
  else process.env.MAX_FOLDER_DEPTH = depth;
  const admin = request.agent(createApp());
  await admin.post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200);
  return admin;
}

const mkdir = (admin, parent, name) => admin.post('/api/admin/folders').send({ path: parent, name });

describe('MAX_FOLDER_DEPTH', () => {
  beforeEach(async () => {
    await fs.remove(testUploadsDir);
    await fs.ensureDir(testUploadsDir);
  });

  afterAll(async () => {
    delete process.env.MAX_FOLDER_DEPTH;
    await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
  });

  test('reads a positive whole number; unset, 0 or anything else means no limit', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseMaxFolderDepth(undefined)).toBeNull();
    expect(parseMaxFolderDepth('')).toBeNull();
    expect(parseMaxFolderDepth('0')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(parseMaxFolderDepth(' 2 ')).toBe(2);
    for (const bad of ['-1', '1.5', 'two', '2x']) expect(parseMaxFolderDepth(bad)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });

  test('counts levels below the library root', () => {
    expect(folderDepth(testUploadsDir)).toBe(0);
    expect(folderDepth(path.join(testUploadsDir, 'Trips'))).toBe(1);
    expect(folderDepth(path.join(testUploadsDir, 'Trips', 'Italy'))).toBe(2);
  });

  test('is off by default: folders can go as deep as you like', async () => {
    const admin = await adminFor(undefined);
    let parent = 'uploads';
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      await mkdir(admin, parent, name).expect(200);
      parent = `${parent}/${name}`;
    }
    expect(await fs.pathExists(path.join(testUploadsDir, 'a/b/c/d/e'))).toBe(true);
    const { body } = await admin.get(`/api/admin/folders?path=${encodeURIComponent(parent)}`).expect(200);
    expect(body).toMatchObject({ maxFolderDepth: null, canCreateFolder: true });
  });

  test('with 2, allows levels 1 and 2 and refuses level 3 with FOLDER_TOO_DEEP', async () => {
    const admin = await adminFor('2');
    await mkdir(admin, 'uploads', 'Trips').expect(200);
    await mkdir(admin, 'uploads/Trips', 'Italy').expect(200);
    const res = await mkdir(admin, 'uploads/Trips/Italy', 'Rome').expect(400);
    expect(res.body).toMatchObject({ code: 'FOLDER_TOO_DEEP', limit: 2 });
    expect(res.body.message).toEqual(expect.any(String));
    expect(await fs.pathExists(path.join(testUploadsDir, 'Trips/Italy/Rome'))).toBe(false);
  });

  test('the env var is read when the app starts', async () => {
    const one = await adminFor('1');
    await mkdir(one, 'uploads', 'Trips').expect(200);
    expect((await mkdir(one, 'uploads/Trips', 'Italy').expect(400)).body).toMatchObject({ code: 'FOLDER_TOO_DEEP', limit: 1 });

    const unlimited = await adminFor('0');
    await mkdir(unlimited, 'uploads/Trips', 'Italy').expect(200);
  });

  test('the folder listing tells the library page where "New folder" is offered', async () => {
    const admin = await adminFor('2');
    await fs.ensureDir(path.join(testUploadsDir, 'Trips/Italy/Rome'));
    const listing = async adminPath => (await admin.get(`/api/admin/folders?path=${encodeURIComponent(adminPath)}`).expect(200)).body;
    expect(await listing('uploads')).toMatchObject({ maxFolderDepth: 2, canCreateFolder: true });
    expect(await listing('uploads/Trips')).toMatchObject({ maxFolderDepth: 2, canCreateFolder: true });
    expect(await listing('uploads/Trips/Italy')).toMatchObject({ maxFolderDepth: 2, canCreateFolder: false });
    // A folder made deeper before the limit is still listed
    expect(await listing('uploads/Trips/Italy/Rome')).toMatchObject({ canCreateFolder: false });

    const adminJs = await fs.readFile(path.join(__dirname, '../public/admin.js'), 'utf8');
    expect(adminJs).toMatch(/createFolderBtn'\)\.classList\.toggle\('hidden', data\.canCreateFolder === false\)/);
  });

  test('folders already deeper stay readable, playable, uploadable and deletable', async () => {
    const admin = await adminFor('2');
    const deep = path.join(testUploadsDir, 'Trips/Italy/Rome/Old');
    await fs.ensureDir(deep);
    await fs.writeFile(path.join(deep, 'photo.jpg'), await jpeg());

    const listed = await admin.get(`/api/admin/folders?path=${encodeURIComponent('uploads/Trips/Italy/Rome/Old')}`).expect(200);
    expect(listed.body.files.map(file => file.name)).toEqual(['photo.jpg']);
    const random = await admin.get(`/api/images/random?folder=${encodeURIComponent('Trips/Italy/Rome/Old')}`).expect(200);
    expect(random.body.success).toBe(true);
    await admin.post('/api/upload').field('path', 'uploads/Trips/Italy/Rome/Old')
      .attach('images', await jpeg(), 'more.jpg').expect(200);
    await admin.delete(`/api/admin/folders?path=${encodeURIComponent('uploads/Trips/Italy/Rome')}`).expect(200);
    expect(await fs.pathExists(path.join(testUploadsDir, 'Trips/Italy/Rome'))).toBe(false);
  });

  test('an upload can\'t make a missing folder past the limit', async () => {
    const admin = await adminFor('2');
    const res = await admin.post('/api/upload').field('path', 'uploads/Trips/Italy/Rome')
      .attach('images', await jpeg(), 'x.jpg').expect(400);
    expect(res.body).toMatchObject({ code: 'FOLDER_TOO_DEEP', limit: 2 });
    expect(await fs.pathExists(path.join(testUploadsDir, 'Trips/Italy/Rome'))).toBe(false);
    // Up to the limit a missing folder is still made, as before
    await admin.post('/api/upload').field('path', 'uploads/Trips/Italy')
      .attach('images', await jpeg(), 'x.jpg').expect(200);
  });

  describe('Google Photos import', () => {
    beforeEach(() => {
      jest.spyOn(oauthManager, 'getStoredTokens').mockReturnValue({ access_token: 'token' });
      jest.spyOn(oauthManager, 'isTokenExpired').mockReturnValue(false);
    });
    afterEach(() => jest.restoreAllMocks());

    test('refuses a destination past the limit up front, before a job starts', async () => {
      const admin = await adminFor('2');
      const createJob = jest.spyOn(jobManager, 'createJob').mockReturnValue('job-1');
      const picker = jest.spyOn(oauthManager, 'createPickerSession').mockResolvedValue({ sessionId: 's', pickerUri: 'https://photos.google.com/x' });

      const session = await admin.post('/api/admin/google-photos/picker-session')
        .send({ destinationPath: 'uploads/Trips/Italy/Rome' }).expect(400);
      expect(session.body).toMatchObject({ success: false, code: 'FOLDER_TOO_DEEP', limit: 2, error: { code: 'FOLDER_TOO_DEEP' } });
      expect(picker).not.toHaveBeenCalled();

      const imported = await admin.post('/api/admin/google-photos/import')
        .send({ mediaItems: [{ id: '1' }], destinationPath: 'uploads/Trips/Italy/Rome' }).expect(400);
      expect(imported.body).toMatchObject({ success: false, code: 'FOLDER_TOO_DEEP', limit: 2 });
      expect(createJob).not.toHaveBeenCalled();

      // Within the limit, or into a deeper folder that already exists, it starts
      await admin.post('/api/admin/google-photos/import')
        .send({ mediaItems: [{ id: '1' }], destinationPath: 'uploads/Trips/Italy' }).expect(200);
      await fs.ensureDir(path.join(testUploadsDir, 'Old/Deep/Folder'));
      await admin.post('/api/admin/google-photos/import')
        .send({ mediaItems: [{ id: '1' }], destinationPath: 'uploads/Old/Deep/Folder' }).expect(200);
      expect(createJob).toHaveBeenCalledTimes(2);
    });

    test('the import job itself won\'t make a folder past the limit', async () => {
      await adminFor('2');
      const job = { id: 'j', data: { mediaItems: [], destinationPath: 'uploads/Trips/Italy/Rome', accessToken: 'x' }, progress: {} };
      await expect(jobManager.executeGooglePhotosImport(job)).rejects.toMatchObject({ code: 'FOLDER_TOO_DEEP' });
      expect(await fs.pathExists(path.join(testUploadsDir, 'Trips/Italy/Rome'))).toBe(false);
    });
  });
});
