const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');

// Point the app at throwaway folders before it loads
const testUploadsDir = path.join(__dirname, 'notes-uploads');
const testCacheDir = path.join(__dirname, 'notes-cache');
const testDataDir = path.join(__dirname, 'notes-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'test-admin-pass';

const app = require('../server');
const { initializeUploads } = require('../app');
const notes = require('../services/noteService');
const { getLibrary } = require('../library');
const { getDataStore } = require('../store');

const HOUR = 60 * 60 * 1000;
const readNote = file => fs.readJson(path.join(testUploadsDir, file));
const noteFiles = async (dir = testUploadsDir) => {
  const found = [];
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) found.push(...await noteFiles(full));
    else if (item.name.endsWith('.note.json')) found.push(path.relative(testUploadsDir, full).split(path.sep).join('/'));
  }
  return found.sort();
};

describe('Notes', () => {
  const admin = request.agent(app);

  beforeAll(async () => {
    for (const folder of ['family', 'family/beach', 'trips', 'quiet']) await fs.ensureDir(path.join(testUploadsDir, folder));
    await fs.writeFile(path.join(testUploadsDir, 'family/priya.jpg'), 'jpg');
    await fs.writeFile(path.join(testUploadsDir, 'trips/lake.jpg'), 'jpg');
    await admin.post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200);
  });

  afterAll(async () => {
    await fs.remove(testUploadsDir);
    await fs.remove(testCacheDir);
    await fs.remove(testDataDir);
  });

  // Each test starts with no notes anywhere
  beforeEach(async () => {
    for (const file of await noteFiles()) await fs.remove(path.join(testUploadsDir, file));
  });

  describe('service', () => {
    const now = new Date('2026-10-21T12:00:00Z');
    const note = (overrides = {}) => ({
      title: 'Priya is visiting you',
      startsAt: '2026-10-20T00:00:00Z',
      enabled: true,
      photos: [],
      ...overrides
    });

    test('status follows the date window', () => {
      expect(notes.status(note(), now)).toBe('active');
      expect(notes.status(note({ enabled: false }), now)).toBe('paused');
      expect(notes.status(note({ startsAt: '2026-10-22T00:00:00Z' }), now)).toBe('upcoming');
      expect(notes.status(note({ endsAt: '2026-10-21T11:00:00Z' }), now)).toBe('ended');
    });

    test('a note with an event ends two hours after it', () => {
      const event = note({ eventAt: '2026-10-21T10:30:00Z' });
      expect(notes.status(event, now)).toBe('active');
      expect(notes.status(event, new Date(now.getTime() + 0.5 * HOUR))).toBe('ended');
    });

    test('validate fills defaults and rejects bad input, with no audience any more', async () => {
      const { note: valid } = await notes.validate({ title: '  Hello  ', audience: { all: false, accountIds: ['grandma'] } });
      expect(valid).toMatchObject({ title: 'Hello', theme: 'paper', everyMinutes: 5, showForSeconds: 20, enabled: true });
      expect(valid).not.toHaveProperty('audience');

      const { errors } = await notes.validate({
        title: '',
        message: 'x'.repeat(161),
        everyMinutes: 0,
        photos: ['../server.js'],
        audience: { all: false, accountIds: [] }
      });
      expect(Object.keys(errors).sort()).toEqual(['everyMinutes', 'message', 'photos', 'title']);
    });

    test('validate accepts admin-style photo paths and rejects too many', async () => {
      const { note: valid } = await notes.validate({ title: 'Hi', photos: ['uploads/family/priya.jpg'] });
      expect(valid.photos).toEqual([path.join('family', 'priya.jpg')]);

      const { errors } = await notes.validate({ title: 'Hi', photos: Array(5).fill('family/priya.jpg') });
      expect(errors.photos).toBeDefined();
    });

    test('validate checks the book layout has enough photos', async () => {
      const { note: auto } = await notes.validate({ title: 'Hi', layout: 'nonsense' });
      expect(auto.layout).toBe('auto');

      const { note: cover } = await notes.validate({ title: 'Hi', layout: 'cover', photos: ['family/priya.jpg'] });
      expect(cover.layout).toBe('cover');

      const { errors } = await notes.validate({ title: 'Hi', layout: 'quote', photos: ['family/priya.jpg'] });
      expect(errors.layout).toBe('This layout needs 2 photos');
    });
  });

  describe('stored as files in folders', () => {
    test('managing notes requires the admin', async () => {
      await request(app).get('/api/notes').expect(401);
      await request(app).post('/api/notes').send({ title: 'Hi' }).expect(401);
      await request(app).put('/api/notes?path=uploads/a.note.json').send({ title: 'Hi' }).expect(401);
      await request(app).delete('/api/notes?path=uploads/a.note.json').expect(401);
    });

    test('a note is a <name>.note.json file in its folder, the top folder by default', async () => {
      const top = await admin.post('/api/notes').send({ title: 'Call Ravi on Sunday' }).expect(201);
      expect(top.body.path).toBe('uploads/call-ravi-on-sunday.note.json');
      expect(top.body.note).toMatchObject({ folder: 'uploads', status: 'active' });

      const family = await admin.post('/api/notes')
        .send({ folder: 'uploads/family', title: 'Priya is visiting', photos: ['uploads/family/priya.jpg'] })
        .expect(201);
      expect(family.body.path).toBe('uploads/family/priya-is-visiting.note.json');
      const again = await admin.post('/api/notes').send({ folder: 'uploads/family', title: 'Priya is visiting' }).expect(201);
      expect(again.body.path).toBe('uploads/family/priya-is-visiting-2.note.json');

      const stored = await readNote('family/priya-is-visiting.note.json');
      expect(stored).toMatchObject({ version: 1, title: 'Priya is visiting', photos: ['family/priya.jpg'], enabled: true });
      expect(stored.id).toMatch(/^nt_/);
      expect(await notes.findAll()).toHaveLength(3);
      // Nothing is kept in the old library-wide list
      expect(await getDataStore().get('notes', [])).toEqual([]);
    });

    test('notes are listed per folder, and all together with their folders', async () => {
      await admin.post('/api/notes').send({ title: 'Top note' }).expect(201);
      await admin.post('/api/notes').send({ folder: 'uploads/family', title: 'Family note' }).expect(201);
      await admin.post('/api/notes').send({ folder: 'uploads/family/beach', title: 'Beach note' }).expect(201);

      const family = await admin.get('/api/notes').query({ folder: 'uploads/family' }).expect(200);
      expect(family.body.notes.map(n => n.title)).toEqual(['Family note']);
      const top = await admin.get('/api/notes').query({ folder: 'uploads' }).expect(200);
      expect(top.body.notes.map(n => n.title)).toEqual(['Top note']);

      const all = await admin.get('/api/notes').expect(200);
      expect(all.body.notes.map(n => [n.folder, n.title]).sort()).toEqual([
        ['uploads', 'Top note'], ['uploads/family', 'Family note'], ['uploads/family/beach', 'Beach note']
      ]);
      expect(all.body.folders).toEqual(expect.arrayContaining(['uploads', 'uploads/family', 'uploads/family/beach', 'uploads/trips']));

      await admin.get('/api/notes').query({ folder: 'uploads/nowhere' }).expect(404);
      await admin.post('/api/notes').send({ folder: 'uploads/nowhere', title: 'Lost' }).expect(404);
      await admin.post('/api/notes').send({ folder: '../outside', title: 'Out' }).expect(404);
    });

    test('update, move to another folder and delete, by path', async () => {
      const { body } = await admin.post('/api/notes').send({ folder: 'uploads/family', title: 'Outing to the lake' }).expect(201);
      await admin.put('/api/notes').query({ path: body.path }).send({ enabled: false }).expect(200);
      expect(await readNote('family/outing-to-the-lake.note.json')).toMatchObject({ enabled: false, title: 'Outing to the lake' });

      // A note of the same name already there: the moved one gets a free name, still a note
      await admin.post('/api/notes').send({ folder: 'uploads/trips', title: 'Outing to the lake' }).expect(201);
      const moved = await admin.put('/api/notes').query({ path: body.path }).send({ folder: 'uploads/trips' }).expect(200);
      expect(moved.body.path).toBe('uploads/trips/outing-to-the-lake-1.note.json');
      expect(moved.body.note.folder).toBe('uploads/trips');
      expect(await noteFiles()).toEqual(['trips/outing-to-the-lake-1.note.json', 'trips/outing-to-the-lake.note.json']);

      await admin.put('/api/notes').query({ path: moved.body.path }).send({ folder: 'uploads/nowhere' }).expect(404);
      await admin.put('/api/notes').query({ path: 'uploads/trips/lake.jpg' }).send({ title: 'x' }).expect(404);
      await admin.delete('/api/notes').query({ path: moved.body.path }).expect(200);
      await admin.delete('/api/notes').query({ path: moved.body.path }).expect(404);
      expect(await noteFiles()).toEqual(['trips/outing-to-the-lake.note.json']);
    });

    test('the audience field is gone: ignored when sent, dropped from old notes', async () => {
      const { body } = await admin.post('/api/notes')
        .send({ title: 'Only for grandma', audience: { all: false, accountIds: ['grandma'] } })
        .expect(201);
      expect(body.note).not.toHaveProperty('audience');
      expect(await readNote('only-for-grandma.note.json')).not.toHaveProperty('audience');

      // A note file written with the old field loses it on the next save
      await fs.writeJson(path.join(testUploadsDir, 'old.note.json'), {
        id: 'nt_old', title: 'Old', startsAt: '2026-01-01T00:00:00Z', enabled: true, photos: [],
        audience: { all: false, accountIds: ['grandma'] }
      });
      await admin.put('/api/notes').query({ path: 'uploads/old.note.json' }).send({ message: 'Still here' }).expect(200);
      expect(await readNote('old.note.json')).not.toHaveProperty('audience');

      const frame = await pinFrame('Hall', '592847', []);
      const active = await frame.get('/api/notes/active').expect(200);
      expect(active.body.notes.map(n => n.title)).toEqual(expect.arrayContaining(['Only for grandma', 'Old']));
    });
  });

  describe('quota', () => {
    const { setQuota } = require('../services/quotaService');
    afterEach(() => setQuota(null));

    test('a new note counts as 1 item, an edit or a move as none, and a full library refuses new notes', async () => {
      const asked = [];
      let full = false;
      setQuota({
        async canAdd(request) {
          asked.push(request);
          return full && request.items > 0 ? { ok: false, message: 'Your library is full' } : { ok: true };
        }
      });

      const { body } = await admin.post('/api/notes').send({ folder: 'uploads/family', title: 'Counted' }).expect(201);
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({ items: 1, screens: 0 });
      expect(asked[0].bytes).toBeGreaterThan(0);

      asked.length = 0;
      await admin.put('/api/notes').query({ path: body.path }).send({ message: 'A longer message than before' }).expect(200);
      expect(asked).toHaveLength(1);
      expect(asked[0].items).toBe(0);
      expect(asked[0].bytes).toBeGreaterThan(0);

      asked.length = 0;
      full = true;
      // Editing and moving still work when the library is full: they add no item
      const moved = await admin.put('/api/notes').query({ path: body.path }).send({ message: 'More words still, a bit longer', folder: 'uploads/trips' }).expect(200);
      expect(moved.body.path).toBe('uploads/trips/counted.note.json');
      expect(asked.every(r => r.items === 0)).toBe(true);

      const refused = await admin.post('/api/notes').send({ title: 'One too many' }).expect(413);
      expect(refused.body.code).toBe('QUOTA_EXCEEDED');
      expect(await noteFiles()).toEqual(['trips/counted.note.json']);
    });
  });

  describe('folders carry their notes along', () => {
    test('deleting a folder deletes its notes', async () => {
      await fs.ensureDir(path.join(testUploadsDir, 'gone'));
      await admin.post('/api/notes').send({ folder: 'uploads/gone', title: 'Goes with the folder' }).expect(201);
      expect((await admin.get('/api/notes/active').expect(200)).body.notes.map(n => n.title)).toContain('Goes with the folder');

      await admin.delete('/api/admin/folders').query({ path: 'uploads/gone' }).expect(200);
      expect((await admin.get('/api/notes').expect(200)).body.notes).toEqual([]);
      expect((await admin.get('/api/notes/active').expect(200)).body.notes).toEqual([]);
    });

    test('renaming or moving a folder takes its notes with it', async () => {
      await fs.ensureDir(path.join(testUploadsDir, 'holiday'));
      await admin.post('/api/notes').send({ folder: 'uploads/holiday', title: 'Packing list' }).expect(201);

      await getLibrary().renameFolder('uploads/holiday', 'summer');
      let listed = (await admin.get('/api/notes').expect(200)).body.notes;
      expect(listed.map(n => n.path)).toEqual(['uploads/summer/packing-list.note.json']);

      await fs.move(path.join(testUploadsDir, 'summer'), path.join(testUploadsDir, 'trips/summer'));
      listed = (await admin.get('/api/notes').query({ folder: 'uploads/trips/summer' }).expect(200)).body.notes;
      expect(listed.map(n => n.title)).toEqual(['Packing list']);
      // It now shows on frames that show trips, and not on others
      const trips = await pinFrame('Trips only', '846193', ['trips']);
      expect((await trips.get('/api/notes/active').expect(200)).body.notes.map(n => n.title)).toEqual(['Packing list']);
      const family = await pinFrame('Family only', '736251', ['family']);
      expect((await family.get('/api/notes/active').expect(200)).body.notes).toEqual([]);
      await fs.remove(path.join(testUploadsDir, 'trips/summer'));
    });
  });

  describe('which frames show a note', () => {
    test('top folder: every frame; a folder: frames that may see it', async () => {
      await admin.post('/api/notes').send({ title: 'Everyone' }).expect(201);
      await admin.post('/api/notes').send({ folder: 'uploads/family', title: 'Family' }).expect(201);
      await admin.post('/api/notes').send({ folder: 'uploads/family/beach', title: 'Beach' }).expect(201);
      await admin.post('/api/notes').send({ folder: 'uploads/trips', title: 'Trips', photos: ['uploads/trips/lake.jpg'] }).expect(201);

      const titles = async (agent, query = {}) =>
        (await agent.get('/api/notes/active').query(query).expect(200)).body.notes.map(n => n.title).sort();

      // A frame with no folders assigned sees every folder, so every note
      const all = await pinFrame('Living room', '592847', []);
      expect(await titles(all)).toEqual(['Beach', 'Everyone', 'Family', 'Trips']);

      // Assigned folders: the top folder's notes, and those inside its folders
      const family = await pinFrame('Family only', '736251', ['family']);
      expect(await titles(family)).toEqual(['Beach', 'Everyone', 'Family']);
      const beach = await pinFrame('Beach only', '381946', ['family/beach']);
      expect(await titles(beach)).toEqual(['Beach', 'Everyone']);
      const trips = await pinFrame('Trips only', '846193', ['trips']);
      const tripNotes = (await trips.get('/api/notes/active').expect(200)).body.notes;
      expect(tripNotes.map(n => n.title).sort()).toEqual(['Everyone', 'Trips']);
      expect(tripNotes.find(n => n.title === 'Trips').photos.map(p => p.path)).toEqual(['trips/lake.jpg']);

      // A frame playing one folder shows the top folder's notes and that folder's
      expect(await titles(all, { folder: 'family' })).toEqual(['Beach', 'Everyone', 'Family']);
      expect(await titles(all, { folder: 'quiet' })).toEqual(['Everyone']);
      expect(await titles(family, { folder: 'trips' })).toEqual(['Everyone']);
    });

    test('the schedule and event dates still decide when a note shows', async () => {
      const soon = new Date(Date.now() + 24 * HOUR).toISOString();
      const past = new Date(Date.now() - 5 * HOUR).toISOString();
      await admin.post('/api/notes').send({ folder: 'uploads/family', title: 'Tomorrow', startsAt: soon }).expect(201);
      await admin.post('/api/notes').send({ folder: 'uploads/family', title: 'Paused', enabled: false }).expect(201);
      await admin.post('/api/notes').send({ folder: 'uploads/family', title: 'Done', startsAt: new Date(Date.now() - 10 * HOUR).toISOString(), eventAt: past }).expect(201);
      await admin.post('/api/notes').send({ folder: 'uploads/family', title: 'Now', everyMinutes: 10, showForSeconds: 30 }).expect(201);

      const active = (await admin.get('/api/notes/active').expect(200)).body.notes;
      expect(active.map(n => n.title)).toEqual(['Now']);
      expect(active[0]).toMatchObject({ everyMinutes: 10, showForSeconds: 30 });
      expect(active[0].id).toMatch(/^nt_/);

      const listed = (await admin.get('/api/notes').expect(200)).body.notes;
      expect(Object.fromEntries(listed.map(n => [n.title, n.status]))).toEqual({ Tomorrow: 'upcoming', Paused: 'paused', Done: 'ended', Now: 'active' });
    });
  });

  describe('notes are not photos', () => {
    test('never played, counted or listed as photos, but shown as their own tile', async () => {
      await admin.post('/api/notes').send({ folder: 'uploads/quiet', title: 'Only a note here' }).expect(201);
      await admin.post('/api/notes').send({ folder: 'uploads/family', title: 'Beside a photo' }).expect(201);

      // Not in the rotation
      const random = await admin.get('/api/images/random').query({ folder: 'quiet' }).expect(404);
      expect(random.body.code).toBe('FOLDER_EMPTY');
      for (let i = 0; i < 5; i++) {
        const { body } = await admin.get('/api/images/random').query({ folder: 'family' }).expect(200);
        expect(body.image.id).not.toMatch(/\.note\.json$/);
      }

      // Not counted, nor listed with a folder's photos
      const { body: root } = await admin.get('/api/folders').expect(200);
      expect(root.folders.find(f => f.name === 'quiet').imageCount).toBe(0);
      expect(root.folders.find(f => f.name === 'family').imageCount).toBe(1);
      const { body: quiet } = await admin.get('/api/folders/quiet').expect(200);
      expect(quiet.images).toEqual([]);
      expect((await getLibrary().allPhotos()).map(p => p.name)).not.toContain('only-a-note-here.note.json');
      expect((await getLibrary().listFolder('uploads/quiet')).photos.map(p => p.type)).toEqual(['note']);

      // The library grid shows it as a note tile, which the page opens in the note editor
      const { body: grid } = await admin.get('/api/admin/folders').query({ path: 'uploads/quiet' }).expect(200);
      expect(grid.files).toHaveLength(1);
      expect(grid.files[0]).toMatchObject({ type: 'note', name: 'only-a-note-here.note.json', path: 'uploads/quiet/only-a-note-here.note.json' });
      expect(grid.files[0].note).toMatchObject({ title: 'Only a note here', status: 'active' });
    });

    test('a note dragged onto a folder moves there, and notes follow moved photos', async () => {
      const { body } = await admin.post('/api/notes').send({ folder: 'uploads/quiet', title: 'Dragged', photos: ['uploads/family/priya.jpg'] }).expect(201);
      await admin.post('/api/images/move').send({ paths: [body.path], destination: 'uploads/trips' }).expect(200);
      expect(await noteFiles()).toEqual(['trips/dragged.note.json']);

      await admin.post('/api/images/move').send({ paths: ['uploads/family/priya.jpg'], destination: 'uploads/quiet' }).expect(200);
      expect((await readNote('trips/dragged.note.json')).photos).toEqual(['quiet/priya.jpg']);
      await admin.post('/api/images/move').send({ paths: ['uploads/quiet/priya.jpg'], destination: 'uploads/family' }).expect(200);
    });
  });

  describe('the library page', () => {
    // The real admin.js, with stand-ins for the page around it
    function libraryPage() {
      const vm = require('vm');
      const elements = { folderTitle: {}, folderMeta: {}, notesLink: { href: '/notes' } };
      const context = {
        console,
        document: { getElementById: id => elements[id] || null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
        t: (key, vars) => (vars ? `${key}:${vars.count}` : key),
        i18n: { error: (_, key) => key },
        location: { href: '' }
      };
      context.window = context;
      vm.createContext(context);
      vm.runInContext(`${fs.readFileSync(path.join(__dirname, '../public/admin.js'), 'utf8')}\n;this.PhotoFrameAdmin = PhotoFrameAdmin;`, context);
      const page = Object.create(context.PhotoFrameAdmin.prototype);
      page.currentPath = 'uploads/family';
      return { page, elements, context };
    }

    test('a note is not counted as a photo, and its tile opens the note editor', () => {
      const { page, elements, context } = libraryPage();
      page.updateLibraryHeading({
        folders: [],
        files: [{ type: 'image', name: 'a.jpg' }, { type: 'snap', name: 'b.snap.json' }, { type: 'note', name: 'c.note.json' }]
      });
      expect(elements.folderMeta.textContent).toBe('admin.countPhotos:1 · admin.countSnaps:1 · admin.countNotes:1');
      // Notes opened from the library start in its folder
      expect(elements.notesLink.href).toBe('/notes?folder=uploads%2Ffamily');

      page.openTile({ type: 'note', path: 'uploads/family/c.note.json' });
      expect(context.location.href).toBe('/notes?folder=uploads%2Ffamily&edit=uploads%2Ffamily%2Fc.note.json');
    });
  });

  describe('moving the old notes list into the top folder', () => {
    const oldNotes = [
      { id: 'nt_aaa', title: 'Lunch with Meera', startsAt: '2026-01-01T00:00:00Z', enabled: true, photos: [], audience: { all: true, accountIds: [] } },
      { id: 'nt_bbb', title: 'Doctor on Friday', startsAt: '2026-01-01T00:00:00Z', enabled: true, photos: [], audience: { all: false, accountIds: ['acc_grandma'] } },
      { id: 'nt_ccc', title: 'Lunch with Meera', startsAt: '2026-01-01T00:00:00Z', enabled: false, photos: [] }
    ];
    const quietLog = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() });

    beforeEach(async () => {
      await getDataStore().set('notes', oldNotes);
      await getDataStore().update('access-accounts', [], accounts => [
        ...accounts.filter(a => a.id !== 'acc_grandma'), { id: 'acc_grandma', name: "Grandma's frame", assignedFolders: [] }
      ]);
    });

    test('each note becomes a file in the top folder; frame-only notes are logged by name', async () => {
      const log = quietLog();
      expect(await notes.migrateFromStore({ log })).toEqual({ moved: 3, skipped: 0 });

      expect(await noteFiles()).toEqual(['doctor-on-friday.note.json', 'lunch-with-meera-2.note.json', 'lunch-with-meera.note.json']);
      const doctor = await readNote('doctor-on-friday.note.json');
      expect(doctor).toMatchObject({ id: 'nt_bbb', title: 'Doctor on Friday', enabled: true });
      expect(doctor).not.toHaveProperty('audience');

      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn.mock.calls[0][0]).toContain('"Doctor on Friday"');
      expect(log.warn.mock.calls[0][0]).toContain("Grandma's frame");
      expect(log.warn.mock.calls[0][0]).toContain('uploads/doctor-on-friday.note.json');

      // The old list is emptied, a copy kept, and the notes show on frames
      expect(await getDataStore().get('notes', null)).toEqual([]);
      expect(await getDataStore().get('notes-before-folders', null)).toEqual(oldNotes);
      const active = (await admin.get('/api/notes/active').expect(200)).body.notes;
      expect(active.map(n => n.id).sort()).toEqual(['nt_aaa', 'nt_bbb']);
    });

    test('running it twice is safe, also after stopping half way', async () => {
      await notes.migrateFromStore({ log: quietLog() });
      const log = quietLog();
      expect(await notes.migrateFromStore({ log })).toEqual({ moved: 0, skipped: 0 });
      expect(log.warn).not.toHaveBeenCalled();

      // Stopped before the old list was emptied: the notes already moved are not doubled
      await getDataStore().set('notes', oldNotes);
      expect(await notes.migrateFromStore({ log })).toEqual({ moved: 0, skipped: 3 });
      expect(await noteFiles()).toHaveLength(3);
    });

    test('runs when the server starts', async () => {
      const before = process.env.DEFAULT_FOLDERS;
      process.env.DEFAULT_FOLDERS = 'family';
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await initializeUploads();
        await initializeUploads();
      } finally {
        warn.mockRestore();
        log.mockRestore();
        if (before === undefined) delete process.env.DEFAULT_FOLDERS; else process.env.DEFAULT_FOLDERS = before;
      }
      expect(await noteFiles()).toHaveLength(3);
      expect(await getDataStore().get('notes', null)).toEqual([]);
    });
  });
});

// A frame signed in with its own PIN, limited to these folders ([] for all)
const frames = new Map();
async function pinFrame(name, pin, assignedFolders) {
  if (frames.has(pin)) return frames.get(pin);
  const admin = request.agent(app);
  await admin.post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200);
  await admin.post('/api/access-accounts').send({ name, pin, assignedFolders }).expect(201);
  const frame = request.agent(app);
  await frame.post('/api/auth/pin').send({ pin }).expect(200);
  frames.set(pin, frame);
  return frame;
}
