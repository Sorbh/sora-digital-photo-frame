// People a library is shared with (the auth provider's scope(req)): every API
// route, walked as someone who can only view and as someone who can edit, both
// limited to "Family". Nothing in the sibling "Other" folder (or at the top) may
// be listed, served, written, moved in or out, or deleted. A route added to
// routes/api.js without a decision in ROUTES below fails the first test.
const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const sharp = require('sharp');

const testUploadsDir = path.join(__dirname, 'scope-uploads');
const testCacheDir = path.join(__dirname, 'scope-cache');
const testDataDir = path.join(__dirname, 'scope-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
// The Google Photos routes are only there when it's on: walk them too
process.env.ENABLE_GOOGLE_PHOTOS = 'true';

const { createApp } = require('../app');
const apiRouter = require('../routes/api');
const authRouter = require('../routes/auth');
const viewRouter = require('../routes/views');
const imageController = require('../controllers/imageController');

// Who is asking (x-person) and what the provider says they may do
const PEOPLE = {
  viewer: { folders: ['Family'], canEdit: false, isOwner: false },
  editor: { folders: ['Family'], canEdit: true, isOwner: false },
  owner: { folders: null, canEdit: true, isOwner: true },
  admin: null // a provider answering null: no limits, as self-hosted
};
const LIMITED = ['viewer', 'editor'];

const signedIn = (req, res, next) => (req.get('x-person') in PEOPLE ? next() : res.status(401).json({ code: 'AUTH_REQUIRED' }));
const app = createApp({
  auth: {
    requireAuth: signedIn,
    requireViewer: signedIn,
    scope: (req) => PEOPLE[req.get('x-person')] ?? null
  }
});

// Requests as one person
const as = (person) => {
  const agent = request(app);
  const wrap = (method) => (url) => agent[method](url).set('x-person', person);
  return { get: wrap('get'), post: wrap('post'), put: wrap('put'), delete: wrap('delete') };
};

// Anything that would show "Other" or the top folder's photo
const LEAK = /Other|secret|inner|top\.jpg|toplevel|Toplevel/;
const noLeak = (res) => expect(JSON.stringify(res.body) + (res.text || '')).not.toMatch(LEAK);

let jpeg;
const place = (relative, data) => fs.outputFile(path.join(testUploadsDir, relative), data);
const snap = (title, photos) => JSON.stringify({ version: 1, title, message: '', signoff: '', eyebrow: '', theme: 'paper', layout: 'auto', photos });
// A note showing now
const note = (id, title, photos = []) => JSON.stringify({
  version: 1, id, title, message: '', signoff: '', eyebrow: '', theme: 'paper', layout: 'auto', photos,
  eventAt: null, startsAt: '2020-01-01T00:00:00.000Z', endsAt: null, everyMinutes: 5, showForSeconds: 20, enabled: true
});

async function buildLibrary() {
  imageController.clearImageCache(); // photos are listed once a minute
  await fs.emptyDir(testUploadsDir);
  await place('Family/fam.jpg', jpeg);
  await place('Family/Sub/sub.jpg', jpeg);
  // A snap in Family that also uses a photo from Other
  await place('Family/fam.snap.json', snap('Family page', ['Family/fam.jpg', 'Other/secret.jpg']));
  await place('Other/secret.jpg', jpeg);
  await place('Other/Inner/inner.jpg', jpeg);
  await place('Other/other.snap.json', snap('Other page', ['Other/secret.jpg']));
  await place('top.jpg', jpeg);
  // Notes: one in Family (with a photo from Other too), one in Other, one at the top (every frame's)
  await place('Family/fam.note.json', note('nt_fam', 'Family note', ['Family/fam.jpg', 'Other/secret.jpg']));
  await place('Other/other.note.json', note('nt_other', 'Other note', ['Other/secret.jpg']));
  await place('toplevel.note.json', note('nt_top', 'Toplevel note'));
}

// Every file under uploads (dot files too, e.g. a folder's play order), with a hash
async function tree(filter = () => true) {
  const found = {};
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(testUploadsDir, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (filter(`${relative}/`)) found[`${relative}/`] = 'folder';
        await walk(full);
      } else if (filter(relative)) {
        found[relative] = crypto.createHash('sha256').update(await fs.readFile(full)).digest('hex');
      }
    }
  };
  await walk(testUploadsDir);
  return found;
}
// What isn't Family's: Other and the top folder
const outsideFamily = () => tree(relative => !relative.startsWith('Family/'));

// ---- The decision for every route ----------------------------------------
//
// none(why):      no library folders involved (frames, sign-in, Google's side)
// read(check):    check(person) asks for things outside Family and gets nothing
// write(outside, inside, insideStatus):
//                 outside: requests reaching outside Family. A viewer gets 403
//                 VIEW_ONLY, an editor 403 OUTSIDE_FOLDERS, and nothing changes.
//                 inside: one inside Family. A viewer gets 403 VIEW_ONLY, an
//                 editor insideStatus, and nothing outside Family changes.
// owner(request): 403 OWNER_ONLY to anyone but the owner
const none = (why) => ({ kind: 'none', why });
const read = (check) => ({ kind: 'read', check });
const write = (outside, inside, insideStatus) => ({ kind: 'write', outside, inside, insideStatus });
const owner = (send) => ({ kind: 'owner', send });

const enc = encodeURIComponent;

// Ask for the next or random photo many times: never one outside Family
const photosFrom = (url) => async (person) => {
  const seen = new Set();
  for (let i = 0; i < 25; i++) {
    const res = await as(person).get(url).expect(200);
    noLeak(res);
    seen.add(res.body.image.id);
  }
  expect(seen.size).toBeGreaterThan(1);
  await as(person).get(`${url}?folder=Other`).expect(404);
  await as(person).get(`${url}?folder=Other%2FInner`).expect(404);
};

const upload = (folder) => (person) => as(person).post('/api/upload').field('path', folder).attach('images', jpeg, 'new.jpg');

const ROUTES = {
  'GET /health': none('a health check'),

  // Slideshow
  'GET /random-image': read(photosFrom('/api/random-image')),
  'GET /images/random': read(photosFrom('/api/images/random')),
  'GET /images/next': read(photosFrom('/api/images/next')),
  'GET /images/:imageId/thumbnail': read(async (person) => {
    for (const photo of ['Other/secret.jpg', 'Other/Inner/inner.jpg', 'top.jpg', 'Family/../Other/secret.jpg']) {
      await as(person).get(`/api/images/${enc(photo)}/thumbnail`).expect(404);
    }
    await as(person).get(`/api/images/${enc('Family/fam.jpg')}/thumbnail`).expect(200);
  }),
  'GET /folders': read(async (person) => {
    const res = await as(person).get('/api/folders').expect(200);
    noLeak(res);
    expect(res.body.folders.map(folder => folder.name)).toEqual(['Family']);
  }),
  'GET /folders/:folderPath(*)/thumbnail': read(async (person) => {
    for (const folder of ['Other', 'Other/Inner']) await as(person).get(`/api/folders/${folder}/thumbnail`).expect(404);
    await as(person).get('/api/folders/Family/thumbnail').expect(200);
  }),
  'GET /folders/:folderPath(*)': read(async (person) => {
    for (const folder of ['Other', 'Other/Inner', 'Family/../Other']) await as(person).get(`/api/folders/${folder}`).expect(404);
    noLeak(await as(person).get('/api/folders/Family').expect(200));
  }),

  // Photos
  'POST /upload': write(
    [upload('uploads/Other'), upload('uploads'), upload('uploads/Family/../Other')],
    upload('uploads/Family'), 200),
  'DELETE /images': write(
    [p => as(p).delete(`/api/images?path=${enc('uploads/Other/secret.jpg')}`), p => as(p).delete(`/api/images?path=${enc('uploads/top.jpg')}`),
      p => as(p).delete(`/api/images?path=${enc('uploads/Other/other.snap.json')}`)],
    p => as(p).delete(`/api/images?path=${enc('uploads/Family/fam.jpg')}`), 200),
  'DELETE /images/batch': write(
    // One outside photo refuses the whole batch
    [p => as(p).delete('/api/images/batch').send({ paths: ['uploads/Family/fam.jpg', 'uploads/Other/secret.jpg'] }),
      p => as(p).delete('/api/images/batch').send({ paths: ['uploads/top.jpg'] })],
    p => as(p).delete('/api/images/batch').send({ paths: ['uploads/Family/fam.jpg'] }), 200),
  'POST /images/rotate': write(
    [p => as(p).post('/api/images/rotate').send({ path: 'uploads/Other/secret.jpg', angle: 90 }),
      p => as(p).post('/api/images/rotate').send({ path: 'uploads/top.jpg', angle: 90 })],
    p => as(p).post('/api/images/rotate').send({ path: 'uploads/Family/fam.jpg', angle: 90 }), 200),
  'POST /images/move': write(
    [p => as(p).post('/api/images/move').send({ paths: ['uploads/Other/secret.jpg'], destination: 'uploads/Family' }), // out of Other
      p => as(p).post('/api/images/move').send({ paths: ['uploads/Family/fam.jpg'], destination: 'uploads/Other' }), // into Other
      p => as(p).post('/api/images/move').send({ paths: ['uploads/Family/fam.jpg'], destination: 'uploads' }), // to the top
      p => as(p).post('/api/images/move').send({ paths: ['uploads/Family/fam.jpg'] }), // the top, by default
      p => as(p).post('/api/images/move').send({ paths: ['uploads/Family/fam.jpg', 'uploads/top.jpg'], destination: 'uploads/Family/Sub' })],
    p => as(p).post('/api/images/move').send({ paths: ['uploads/Family/fam.jpg'], destination: 'uploads/Family/Sub' }), 200),

  // Folders
  'GET /admin/folders': read(async (person) => {
    for (const folder of ['uploads/Other', 'uploads/Other/Inner', 'uploads/Family/../Other']) {
      await as(person).get(`/api/admin/folders?path=${enc(folder)}`).expect(404);
    }
    // The top shows only the way to Family; Family's snap without Other's photo
    const top = await as(person).get('/api/admin/folders?path=uploads').expect(200);
    noLeak(top);
    expect(top.body.folders.map(folder => folder.name)).toEqual(['Family']);
    expect(top.body.files).toEqual([]);
    expect(top.body.canCreateFolder).toBe(false);
    expect(top.body.canChange).toBe(false);
    const family = await as(person).get('/api/admin/folders?path=uploads%2FFamily').expect(200);
    noLeak(family);
    expect(family.body.files.map(file => file.name).sort()).toEqual(['fam.jpg', 'fam.note.json', 'fam.snap.json']);
    expect(family.body.canCreateFolder).toBe(person === 'editor');
    expect(family.body.canChange).toBe(person === 'editor');
  }),
  'POST /admin/folders': write(
    [p => as(p).post('/api/admin/folders').send({ name: 'New', path: 'uploads' }),
      p => as(p).post('/api/admin/folders').send({ name: 'New' }),
      p => as(p).post('/api/admin/folders').send({ name: 'New', path: 'uploads/Other' })],
    p => as(p).post('/api/admin/folders').send({ name: 'New', path: 'uploads/Family' }), 200),
  'DELETE /admin/folders': write(
    [p => as(p).delete(`/api/admin/folders?path=${enc('uploads/Other')}`),
      p => as(p).delete(`/api/admin/folders?path=${enc('uploads/Other/Inner')}`),
      // Their own folder itself stays
      p => as(p).delete(`/api/admin/folders?path=${enc('uploads/Family')}`)],
    p => as(p).delete(`/api/admin/folders?path=${enc('uploads/Family/Sub')}`), 200),
  'PUT /admin/folders/order': write(
    [p => as(p).put(`/api/admin/folders/order?path=${enc('uploads/Other')}`).send({ order: 'newest' }),
      p => as(p).put('/api/admin/folders/order').send({ order: 'newest' })],
    p => as(p).put(`/api/admin/folders/order?path=${enc('uploads/Family')}`).send({ order: 'newest' }), 200),

  // Access: the owner's
  'GET /access-accounts': owner(p => as(p).get('/api/access-accounts')),
  'POST /access-accounts': owner(p => as(p).post('/api/access-accounts').send({})),
  'PUT /access-accounts/:id': owner(p => as(p).put('/api/access-accounts/missing').send({})),
  'DELETE /access-accounts/:id': owner(p => as(p).delete('/api/access-accounts/missing')),
  'GET /admin/family-code': owner(p => as(p).get('/api/admin/family-code')),
  'POST /admin/family-code': owner(p => as(p).post('/api/admin/family-code')),

  // Notes: files in folders, scoped like photos. Top-folder notes go to every
  // frame, so someone limited to Family can't see, make or change them.
  'GET /notes': read(async (person) => {
    for (const folder of ['uploads/Other', 'uploads', 'uploads/Family/../Other']) {
      await as(person).get(`/api/notes?folder=${enc(folder)}`).expect(404);
    }
    const all = await as(person).get('/api/notes').expect(200);
    noLeak(all);
    expect(all.body.notes.map(n => n.title)).toEqual(['Family note']);
    expect(all.body.notes[0].photos).toEqual(['Family/fam.jpg']);
    noLeak(await as(person).get(`/api/notes?folder=${enc('uploads/Family')}`).expect(200));
  }),
  'POST /notes': write(
    [p => as(p).post('/api/notes').send({ title: 'Hi', folder: 'uploads/Other' }),
      p => as(p).post('/api/notes').send({ title: 'Hi' }), // the top folder, by default
      p => as(p).post('/api/notes').send({ title: 'Hi', folder: 'uploads' }),
      p => as(p).post('/api/notes').send({ title: 'Hi', folder: 'uploads/Family', photos: ['Other/secret.jpg'] })],
    p => as(p).post('/api/notes').send({ title: 'Hi', folder: 'uploads/Family', photos: ['Family/fam.jpg'] }), 201),
  'GET /notes/active': read(async (person) => {
    for (const url of ['/api/notes/active', '/api/notes/active?folder=Family', '/api/notes/active?folder=Other']) {
      const res = await as(person).get(url).expect(200);
      noLeak(res);
      expect(res.body.notes.map(n => n.title)).toEqual(url.endsWith('Other') ? [] : ['Family note']);
    }
  }),
  'GET /notes/note': read(async (person) => {
    for (const file of ['uploads/Other/other.note.json', 'uploads/toplevel.note.json']) {
      await as(person).get(`/api/notes/note?path=${enc(file)}`).expect(404);
    }
    noLeak(await as(person).get(`/api/notes/note?path=${enc('uploads/Family/fam.note.json')}`).expect(200));
  }),
  'PUT /notes': write(
    [p => as(p).put(`/api/notes?path=${enc('uploads/Other/other.note.json')}`).send({ title: 'Changed' }),
      p => as(p).put(`/api/notes?path=${enc('uploads/toplevel.note.json')}`).send({ title: 'Changed' }),
      p => as(p).put(`/api/notes?path=${enc('uploads/Family/fam.note.json')}`).send({ folder: 'uploads/Other' }), // into Other
      p => as(p).put(`/api/notes?path=${enc('uploads/Family/fam.note.json')}`).send({ folder: 'uploads' }), // to the top
      p => as(p).put(`/api/notes?path=${enc('uploads/Other/other.note.json')}`).send({ folder: 'uploads/Family' }), // out of Other
      p => as(p).put(`/api/notes?path=${enc('uploads/Family/fam.note.json')}`).send({ photos: ['Other/Inner/inner.jpg'] })],
    p => as(p).put(`/api/notes?path=${enc('uploads/Family/fam.note.json')}`).send({ title: 'Changed', folder: 'uploads/Family/Sub' }), 200),
  'DELETE /notes': write(
    [p => as(p).delete(`/api/notes?path=${enc('uploads/Other/other.note.json')}`),
      p => as(p).delete(`/api/notes?path=${enc('uploads/toplevel.note.json')}`)],
    p => as(p).delete(`/api/notes?path=${enc('uploads/Family/fam.note.json')}`), 200),

  // Snaps: their folder, and the photos on them
  'GET /snaps': read(async (person) => {
    await as(person).get(`/api/snaps?path=${enc('uploads/Other/other.snap.json')}`).expect(404);
    const res = await as(person).get(`/api/snaps?path=${enc('uploads/Family/fam.snap.json')}`).expect(200);
    noLeak(res);
  }),
  'POST /snaps': write(
    [p => as(p).post('/api/snaps').send({ title: 'Hi', folder: 'uploads/Other' }),
      p => as(p).post('/api/snaps').send({ title: 'Hi' }),
      // Into Family, with a photo from Other on it
      p => as(p).post('/api/snaps').send({ title: 'Hi', folder: 'uploads/Family', photos: ['Other/secret.jpg'] }),
      p => as(p).post('/api/snaps').send({ title: 'Hi', folder: 'uploads/Family', photos: ['uploads/top.jpg'] })],
    p => as(p).post('/api/snaps').send({ title: 'Hi', folder: 'uploads/Family', photos: ['Family/fam.jpg'] }), 201),
  'PUT /snaps': write(
    [p => as(p).put(`/api/snaps?path=${enc('uploads/Other/other.snap.json')}`).send({ title: 'Changed' }),
      p => as(p).put(`/api/snaps?path=${enc('uploads/Family/fam.snap.json')}`).send({ photos: ['uploads/Other/Inner/inner.jpg'] })],
    p => as(p).put(`/api/snaps?path=${enc('uploads/Family/fam.snap.json')}`).send({ title: 'Changed' }), 200),

  'GET /features': read(async (person) => {
    const res = await as(person).get('/api/features').expect(200);
    expect(res.body.scope).toEqual(PEOPLE[person]);
  }),

  // Frames and their sign-in
  'POST /auth/pin': none('a frame signs in with a PIN; its folders are the PIN account\'s'),
  'GET /auth/session': none('a frame\'s own sign-in'),
  'DELETE /auth/session': none('a frame\'s own sign-in'),
  'GET /frame/keys': none('encryption keys belong to the whole library, not to folders'),
  'POST /pair/start': none('a frame asking to be paired'),
  'POST /pair/status': none('a frame asking to be paired'),
  'GET /pair/status': none('a frame from before #66 asking to be paired'),
  'POST /pair/collect': none('a frame asking to be paired'),
  'POST /auth/device': none('a paired frame signing in'),
  'PUT /device/language': none('a frame setting its own language'),

  // Pairing and devices: the owner's
  'GET /admin/pair/nearby': owner(p => as(p).get('/api/admin/pair/nearby')),
  'GET /admin/pair/:code': owner(p => as(p).get('/api/admin/pair/ABC-DEF')),
  'POST /admin/pair/:code/approve': owner(p => as(p).post('/api/admin/pair/ABC-DEF/approve').send({})),
  'GET /admin/devices': owner(p => as(p).get('/api/admin/devices')),
  'PUT /admin/devices/:id/language': owner(p => as(p).put('/api/admin/devices/missing/language').send({ language: 'en' })),
  'DELETE /admin/devices/:id': owner(p => as(p).delete('/api/admin/devices/missing')),

  // Google Photos: the connection is the owner's; an import is a change into a folder
  'GET /admin/google-photos/status': none('whether Google Photos is connected in this session'),
  'POST /admin/google-photos/auth': owner(p => as(p).post('/api/admin/google-photos/auth').send({ redirectUri: 'http://localhost/cb' })),
  'GET /admin/google-photos/callback': none('Google\'s answer to a connection only the owner can start'),
  'DELETE /admin/google-photos/auth': owner(p => as(p).delete('/api/admin/google-photos/auth')),
  'POST /admin/google-photos/picker-session': write(
    [p => as(p).post('/api/admin/google-photos/picker-session').send({ destinationPath: 'uploads/Other' }),
      p => as(p).post('/api/admin/google-photos/picker-session').send({ destinationPath: 'uploads' })],
    // Not connected to Google here: refused for that, not for the folder
    p => as(p).post('/api/admin/google-photos/picker-session').send({ destinationPath: 'uploads/Family' }), 401),
  'GET /admin/google-photos/session/:sessionId': none('Google\'s picker, no library folder'),
  'GET /admin/google-photos/session/:sessionId/media-items': none('Google\'s picker, no library folder'),
  'GET /admin/google-photos/thumbnail': none('a Google photo\'s preview, no library folder'),
  'POST /admin/google-photos/import': write(
    [p => as(p).post('/api/admin/google-photos/import').send({ mediaItems: [{ id: 'x' }], destinationPath: 'uploads/Other' }),
      p => as(p).post('/api/admin/google-photos/import').send({ mediaItems: [{ id: 'x' }], destinationPath: 'uploads/Other/New' }),
      p => as(p).post('/api/admin/google-photos/import').send({ mediaItems: [{ id: 'x' }], destinationPath: 'uploads' })],
    p => as(p).post('/api/admin/google-photos/import').send({ mediaItems: [{ id: 'x' }], destinationPath: 'uploads/Family' }), 401),
  'GET /admin/google-photos/job/:jobId': none('an import\'s progress'),

  // Sign-in (routes/auth.js, under /auth)
  'POST /auth/login': none('the admin password sign-in'),
  'POST /auth/logout': none('signing out'),
  'GET /auth/status': none('whether this session is signed in')
};

// Pages (routes/views.js): the data on them comes from the routes above
const PAGES = {
  'GET /': none('a redirect to the frame'),
  'GET /frame': none('a page; its photos come from the API'),
  'GET /slideshow': none('the old address of /frame: a redirect'),
  'GET /folder-selection': none('a page; its folders come from the API'),
  'GET /login': none('the sign-in page'),
  'GET /home': none('a page; its folders come from the API'),
  'GET /access-accounts': owner(p => as(p).get('/access-accounts')),
  'GET /notes': none('a page; its notes come from the API'),
  'GET /snap': none('a page; its snap comes from the API'),
  'GET /pair': owner(p => as(p).get('/pair'))
};

// "METHOD /path" for each route in a router, and its sub-routers' (mounted at prefix)
function routesOf(router, mounts = {}) {
  const found = [];
  for (const layer of router.stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) found.push(`${method.toUpperCase()} ${layer.route.path}`);
    } else if (layer.handle && layer.handle.stack) {
      const prefix = Object.keys(mounts).find(mount => mounts[mount] === layer.handle);
      if (prefix === undefined) found.push(`USE ${layer.regexp}`); // a sub-router nobody looked at
      else found.push(...routesOf(layer.handle).map(route => route.replace(' ', ` ${prefix}`)));
    } else {
      found.push(`USE ${layer.regexp}`); // middleware for many routes: needs a decision too
    }
  }
  return found;
}

describe('People limited by scope(req)', () => {
  beforeAll(async () => {
    jpeg = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#3a7' } }).jpeg().toBuffer();
  });

  beforeEach(buildLibrary);

  afterAll(async () => {
    await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
  });

  test('every API route and page has a scope decision', () => {
    expect(routesOf(apiRouter, { '/auth': authRouter }).sort()).toEqual(Object.keys(ROUTES).sort());
    expect(routesOf(viewRouter).sort()).toEqual(Object.keys(PAGES).sort());
    for (const decision of [...Object.values(ROUTES), ...Object.values(PAGES)]) {
      if (decision.kind === 'none') expect(decision.why).toMatch(/\w/);
    }
  });

  const cases = (table, kind) => Object.entries(table).filter(([, decision]) => decision.kind === kind);

  describe.each(LIMITED)('as someone who %s', (person) => {
    test.each(cases(ROUTES, 'read'))('%s shows nothing outside their folders', async (route, { check }) => {
      await check(person);
    });

    test.each(cases(ROUTES, 'write'))('%s changes nothing outside their folders', async (route, { outside, inside, insideStatus }) => {
      const before = await tree();
      for (const send of outside) {
        const res = await send(person);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe(person === 'viewer' ? 'VIEW_ONLY' : 'OUTSIDE_FOLDERS');
        expect(await tree()).toEqual(before);
      }

      const others = await outsideFamily();
      const res = await inside(person);
      if (person === 'viewer') {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('VIEW_ONLY');
        expect(await tree()).toEqual(before);
      } else {
        expect(res.status).toBe(insideStatus);
      }
      expect(await outsideFamily()).toEqual(others);
    });

    test.each(cases(ROUTES, 'owner'))('%s is for the owner only', async (route, { send }) => {
      const res = await send(person);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OWNER_ONLY');
    });

    test.each(cases(PAGES, 'owner'))('the page %s is for the owner only', async (route, { send }) => {
      const res = await send(person);
      expect(res.status).toBe(403);
      expect(res.text).toContain('ownerOnly.heading');
    });

    test('photos outside their folders are not served from /uploads', async () => {
      for (const photo of ['Other/secret.jpg', 'Other/Inner/inner.jpg', 'top.jpg', 'Other/other.snap.json', 'Family/..%2FOther/secret.jpg']) {
        await as(person).get(`/uploads/${photo}`).expect(404);
      }
      await as(person).get('/uploads/Family/fam.jpg').expect(200);
    });

    test('a snap played on the frame shows only photos from their folders', async () => {
      await place('Other/secret.jpg', jpeg);
      await fs.remove(path.join(testUploadsDir, 'Family/fam.jpg'));
      await fs.remove(path.join(testUploadsDir, 'Family/Sub'));
      // Only the snap is left in Family
      const res = await as(person).get('/api/images/next?folder=Family').expect(200);
      expect(res.body.image.type).toBe('snap');
      expect(res.body.image.snap.photos).toEqual([]);
      noLeak(res);
    });
  });

  test('the owner, and a scope of null, reach the owner\'s routes', async () => {
    for (const [route, { send }] of [...cases(ROUTES, 'owner'), ...cases(PAGES, 'owner')]) {
      for (const person of ['owner', 'admin']) {
        const res = await send(person);
        expect([route, person, res.status]).not.toEqual([route, person, 403]);
      }
    }
  });

  test('the owner, and a scope of null, see and change every folder', async () => {
    for (const person of ['owner', 'admin']) {
      await buildLibrary();
      const top = await as(person).get('/api/admin/folders?path=uploads').expect(200);
      expect(top.body.folders.map(folder => folder.name)).toEqual(['Family', 'Other']);
      expect(top.body.files.map(file => file.name).sort()).toEqual(['top.jpg', 'toplevel.note.json']);
      const active = await as(person).get('/api/notes/active').expect(200);
      expect(active.body.notes.map(n => n.title).sort()).toEqual(['Family note', 'Other note', 'Toplevel note']);
      expect(active.body.notes.find(n => n.title === 'Family note').photos).toHaveLength(2);
      const family = await as(person).get('/api/snaps?path=uploads%2FFamily%2Ffam.snap.json').expect(200);
      expect(family.body.snap.photos).toEqual(['Family/fam.jpg', 'Other/secret.jpg']);
      await as(person).get('/uploads/Other/secret.jpg').expect(200);
      await as(person).post('/api/images/move').send({ paths: ['uploads/Other/secret.jpg'], destination: 'uploads' }).expect(200);
      await as(person).delete(`/api/admin/folders?path=${enc('uploads/Other')}`).expect(200);
      expect(await fs.pathExists(path.join(testUploadsDir, 'secret.jpg'))).toBe(true);
    }
  });

  test('a folder that only leads to theirs shows a cover from theirs', async () => {
    PEOPLE.sub = { folders: ['Family/Sub'], canEdit: true, isOwner: false };
    await place('Family/Sub/more.jpg', jpeg);
    try {
      const top = await as('sub').get('/api/admin/folders?path=uploads').expect(200);
      const [family] = top.body.folders;
      expect(family.name).toBe('Family');
      expect(family.thumbnail).toMatch(/^\/api\/folders\/Family\/Sub\/thumbnail/);
      expect(family.prints).toHaveLength(1);
      // Nothing from Family itself, which they can't see
      expect(JSON.stringify(top.body)).not.toMatch(/fam\.(jpg|snap)/);
    } finally {
      delete PEOPLE.sub;
    }
  });

  // The editor only ever gets the photos they can see; saving keeps the others
  describe.each([
    ['snap', 'uploads/Family/fam.snap.json', '/api/snaps', '/api/snaps', 'snap'],
    ['note', 'uploads/Family/fam.note.json', '/api/notes', '/api/notes/note', 'note']
  ])('a %s with photos they can\'t see', (kind, file, save, load, field) => {
    const photosOnDisk = async () => JSON.parse(await fs.readFile(path.join(testUploadsDir, file.replace(/^uploads\//, '')), 'utf8')).photos;

    test('keeps them when only the title changes', async () => {
      const shown = await as('editor').get(`${load}?path=${enc(file)}`).expect(200);
      expect(shown.body[field].photos).toEqual(['Family/fam.jpg']);
      // As the editor page sends it: everything it was shown, with a new title
      const res = await as('editor').put(`${save}?path=${enc(file)}`)
        .send({ ...shown.body[field], title: 'New title' }).expect(200);
      noLeak(res);
      expect(await photosOnDisk()).toEqual(['Family/fam.jpg', 'Other/secret.jpg']);
      const saved = JSON.parse(await fs.readFile(path.join(testUploadsDir, file.replace(/^uploads\//, '')), 'utf8'));
      expect(saved.title).toBe('New title');
    });

    test('keeps them in their places when the editor changes their own', async () => {
      await place('Family/two.jpg', jpeg);
      await place('Family/three.jpg', jpeg);
      // Other's photo first: it stays first, the editor's two fill the rest
      const name = file.replace(/^uploads\//, '');
      const data = JSON.parse(await fs.readFile(path.join(testUploadsDir, name), 'utf8'));
      data.photos = ['Other/secret.jpg', 'Family/fam.jpg'];
      await place(name, JSON.stringify(data));
      await as('editor').put(`${save}?path=${enc(file)}`).send({ photos: ['Family/two.jpg', 'Family/three.jpg'] }).expect(200);
      expect(await photosOnDisk()).toEqual(['Other/secret.jpg', 'Family/two.jpg', 'Family/three.jpg']);
      // Removing their own keeps Other's
      await as('editor').put(`${save}?path=${enc(file)}`).send({ photos: [] }).expect(200);
      expect(await photosOnDisk()).toEqual(['Other/secret.jpg']);
    });

    test('the owner\'s own save is taken as it is', async () => {
      await as('owner').put(`${save}?path=${enc(file)}`).send({ photos: ['Family/fam.jpg'] }).expect(200);
      expect(await photosOnDisk()).toEqual(['Family/fam.jpg']);
    });
  });

  test('a symlink in their folder doesn\'t lead them into another', async () => {
    try {
      await fs.symlink(path.join(testUploadsDir, 'Other'), path.join(testUploadsDir, 'Family', 'link'), 'dir');
    } catch {
      return console.warn('Skipped: symlinks can\'t be made here');
    }
    for (const person of LIMITED) {
      await as(person).get(`/api/notes?folder=${enc('uploads/Family/link')}`).expect(404);
      await as(person).get(`/api/notes/note?path=${enc('uploads/Family/link/other.note.json')}`).expect(404);
      await as(person).get(`/api/snaps?path=${enc('uploads/Family/link/other.snap.json')}`).expect(404);
      await as(person).get('/uploads/Family/link/secret.jpg').expect(404);
      const change = await as(person).put(`/api/notes?path=${enc('uploads/Family/link/other.note.json')}`).send({ title: 'Changed' });
      expect([change.status, change.body.code]).toEqual([403, person === 'viewer' ? 'VIEW_ONLY' : 'OUTSIDE_FOLDERS']);
    }
    expect(JSON.parse(await fs.readFile(path.join(testUploadsDir, 'Other/other.note.json'), 'utf8')).title).toBe('Other note');
  });

  test('a scope with no folders sees nothing', async () => {
    PEOPLE.nobody = { folders: [], canEdit: true, isOwner: false };
    try {
      const top = await as('nobody').get('/api/admin/folders?path=uploads').expect(200);
      expect(top.body.folders).toEqual([]);
      expect(top.body.files).toEqual([]);
      await as('nobody').get('/api/folders/Family').expect(404);
      await as('nobody').get('/uploads/Family/fam.jpg').expect(404);
      expect((await as('nobody').get('/api/images/random')).status).toBe(403);
    } finally {
      delete PEOPLE.nobody;
    }
  });
});
