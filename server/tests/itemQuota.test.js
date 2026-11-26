const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');
const vm = require('vm');
const sharp = require('sharp');

// The quota hook is asked about items and screens, not just bytes:
// canAdd({ items, bytes, screens })
const testRoot = path.join(__dirname, 'item-quota-data');
const testUploadsDir = path.join(testRoot, 'uploads');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = path.join(testRoot, 'cache');
process.env.DATA_DIR = path.join(testRoot, 'data');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
delete process.env.MAX_SCREENS;
delete process.env.PHOTO_ENCRYPTION_KEY;
delete process.env.MAX_FOLDER_DEPTH;

// Google Photos downloads answered here, without the network
jest.mock('../utils/googleUrls', () => ({
  isGooglePhotoUrl: () => true,
  fetchGooglePhoto: jest.fn()
}));

const { fetchGooglePhoto } = require('../utils/googleUrls');
const { createApp } = require('../app');
const { getDataStore } = require('../store');
const quotaService = require('../services/quotaService');
const jobManager = require('../utils/jobManager');

const png = (background = '#c33') => sharp({ create: { width: 8, height: 8, channels: 3, background } }).png().toBuffer();
// Frames that differ, so the GIF encoder keeps them all
const animatedGif = async () => sharp([await png('#c33'), await png('#33c'), await png('#3c3')], { join: { animated: true } }).gif().toBuffer();
const stillGif = async () => sharp(await png()).gif().toBuffer();

// Every request the hook was asked, and what it answers (swapped per test)
const asked = [];
const contexts = [];
let answer = async () => ({ ok: true });

const app = createApp({
  auth: { requireAuth: (req, res, next) => next() },
  quota: {
    async canAdd(request, context) {
      asked.push(request);
      contexts.push(context);
      return answer(request, context);
    }
  }
});

const upload = (file, name, folder = 'uploads/family') =>
  request(app).post('/api/upload').field('path', folder).attach('images', file, name);
// What the hook was asked when the photo was saved (the last call: the first only asks if there's any room)
const lastAsked = () => asked.at(-1);

beforeAll(async () => {
  await fs.ensureDir(path.join(testUploadsDir, 'family'));
  await fs.ensureDir(path.join(testUploadsDir, 'race'));
});

beforeEach(() => {
  asked.length = 0;
  contexts.length = 0;
  answer = async () => ({ ok: true });
  fetchGooglePhoto.mockReset();
});

afterAll(() => fs.remove(testRoot));

describe('what each action asks the quota hook', () => {
  test('every request has all three fields, as numbers', async () => {
    await upload(await png(), 'p.png').expect(200);
    for (const request of asked) {
      expect(Object.keys(request).sort()).toEqual(['bytes', 'items', 'screens']);
      expect(Object.values(request).every(Number.isFinite)).toBe(true);
    }
  });

  test('uploading a photo asks for 1 item and its bytes', async () => {
    const res = await upload(await png(), 'p.png').expect(200);
    expect(lastAsked()).toEqual({ items: 1, bytes: res.body.files[0].size, screens: 0 });
    // Before converting it: is there room for anything at all?
    expect(asked[0]).toEqual({ items: 1, bytes: 1, screens: 0 });
  });

  test('uploading an animated GIF asks for 5 items', async () => {
    const res = await upload(await animatedGif(), 'moving.gif').expect(200);
    expect(lastAsked()).toEqual({ items: 5, bytes: res.body.files[0].size, screens: 0 });
  });

  test('a GIF with one frame is a photo: 1 item', async () => {
    await upload(await stillGif(), 'still.gif').expect(200);
    expect(lastAsked().items).toBe(1);
  });

  test('an animated GIF is refused when only a still photo would fit', async () => {
    answer = async ({ items }) => ({ ok: items <= 4, message: 'You have reached 100 photos.' });
    const res = await upload(await animatedGif(), 'moving.gif').expect(413);
    expect(res.body).toMatchObject({ code: 'QUOTA_EXCEEDED', message: 'You have reached 100 photos.', files: [] });
    await upload(await png(), 'p.png').expect(200);
  });

  test('a new snap asks for 1 item; saving it again asks for none', async () => {
    const created = await request(app).post('/api/snaps').send({ folder: 'uploads/family', title: 'Beach day' }).expect(201);
    expect(lastAsked()).toMatchObject({ items: 1, screens: 0 });
    expect(lastAsked().bytes).toBeGreaterThan(0);

    asked.length = 0;
    await request(app).put('/api/snaps').query({ path: created.body.path })
      .send({ title: 'Beach day with everyone, a longer title' }).expect(200);
    expect(asked).toHaveLength(1);
    expect(lastAsked()).toMatchObject({ items: 0, screens: 0 });
    expect(lastAsked().bytes).toBeGreaterThan(0);

    // At the item limit, a snap can still be edited, but no new one made
    answer = async ({ items }) => ({ ok: items === 0, message: 'You have reached 100 photos.' });
    await request(app).put('/api/snaps').query({ path: created.body.path })
      .send({ title: 'Beach day with everyone, and an even longer title' }).expect(200);
    await request(app).post('/api/snaps').send({ folder: 'uploads/family', title: 'Another' }).expect(413);
  });

  test('rotating asks for no items, only the growth', async () => {
    const noisy = await sharp(Buffer.from(Array.from({ length: 64 * 32 * 3 }, (_, i) => (i * 7919) % 251)), { raw: { width: 64, height: 32, channels: 3 } }).png().toBuffer();
    const uploaded = (await upload(noisy, 'n.png').expect(200)).body.files[0];
    asked.length = 0;
    // Refuses any new item: a rotation must not need one
    answer = async ({ items }) => ({ ok: items === 0 });
    // Kept at a higher quality than it was uploaded at, so the turned copy grows
    process.env.IMAGE_QUALITY = '100';
    try {
      await request(app).post('/api/images/rotate').send({ path: uploaded.path, angle: 90 }).expect(200);
    } finally {
      delete process.env.IMAGE_QUALITY;
    }
    expect(asked).toHaveLength(1);
    expect(lastAsked().items).toBe(0);
    expect(lastAsked().bytes).toBeGreaterThan(0);
  });

  test('a Google Photos import asks for 1 item per photo, 5 per animated one', async () => {
    const photo = await png();
    const gif = await animatedGif();
    const files = { 1: [photo, 'image/png'], 2: [gif, 'image/gif'], 3: [photo, 'image/png'] };
    fetchGooglePhoto.mockImplementation(async url => {
      const [body, type] = files[url.split('/').pop().replace('=d', '')];
      return new Response(body, { headers: { 'content-type': type } });
    });
    const job = {
      id: 'import-items',
      data: { mediaItems: [1, 2, 3].map(id => ({ id: String(id), baseUrl: `https://lh3.googleusercontent.com/${id}` })), destinationPath: 'uploads/Imported', accessToken: 't' },
      progress: {}
    };
    await jobManager.executeGooglePhotosImport(job);
    expect(job.result.results.map(r => r.success)).toEqual([true, true, true]);
    // The saves (the checks before each download ask for 1 item and 1 byte)
    const saves = asked.filter(r => r.bytes > 1);
    expect(saves.map(r => r.items)).toEqual([1, 5, 1]);
  });

  test('an import stops at the item limit', async () => {
    let room = 5; // a photo, then an animation that doesn't fit
    answer = async ({ items, bytes }) => {
      if (items > room) return { ok: false, message: 'You have reached 100 photos.' };
      if (bytes > 1) room -= items;
      return { ok: true };
    };
    const photo = await png();
    const gif = await animatedGif();
    fetchGooglePhoto.mockImplementation(async url => (url.includes('/2')
      ? new Response(gif, { headers: { 'content-type': 'image/gif' } })
      : new Response(photo, { headers: { 'content-type': 'image/png' } })));
    const job = {
      id: 'import-limit',
      data: { mediaItems: [1, 2, 3].map(id => ({ id: String(id), baseUrl: `https://lh3.googleusercontent.com/${id}` })), destinationPath: 'uploads/Imported2', accessToken: 't' },
      progress: {}
    };
    await jobManager.executeGooglePhotosImport(job);
    // 5 - 1 leaves 4: the animation (5) doesn't fit, and the import stops there
    expect(job.result.results.map(r => r.success)).toEqual([true, false, false]);
    expect(job.result.results[1].error).toBe('You have reached 100 photos.');
  });
});

describe('two uploads at the item limit', () => {
  test('only one gets the last place', async () => {
    const stored = async () => (await fs.readdir(path.join(testUploadsDir, 'race'))).filter(name => name.endsWith('.webp')).length;
    const limit = (await stored()) + 1;
    // Counts what is really stored, as a hosted quota does
    answer = async ({ items }) => ({ ok: (await stored()) + items <= limit, message: 'You have reached 1 photo.' });
    const [a, b] = await Promise.all([upload(await png('#111'), 'a.png', 'uploads/race'), upload(await png('#222'), 'b.png', 'uploads/race')]);
    expect([a.status, b.status].sort()).toEqual([200, 413]);
    expect(await stored()).toBe(limit);
  });
});

describe('screens', () => {
  const admin = request.agent(app);
  const devices = async () => (await getDataStore().get('devices', [])).length;
  const signIn = (frame, body) => frame.post('/api/auth/pin').send(body);
  const screenAsks = () => asked.filter(r => r.screens > 0);
  let limit = Infinity;

  beforeAll(async () => {
    await admin.post('/api/access-accounts').send({ name: 'Living room', pin: '482913' }).expect(201);
  });

  beforeEach(() => {
    // A hosted plan's screens, counted from the library's own devices
    answer = async ({ screens }) => ({
      ok: (await devices()) + screens <= limit,
      message: 'Your plan has 1 screen. Upgrade to add more.'
    });
  });

  test('a new screen past the hook\'s limit is refused; one signing in again is not', async () => {
    limit = Infinity;
    const existing = request.agent(app);
    const kept = (await signIn(existing, { pin: '482913' }).expect(200)).body;
    expect(screenAsks()).toEqual([{ items: 0, bytes: 0, screens: 1 }]);
    limit = await devices();
    asked.length = 0;

    // A new browser with the PIN: refused with the hook's words and the usual code
    const refused = await signIn(request.agent(app), { pin: '482913' }).expect(403);
    expect(refused.body).toMatchObject({ code: 'SCREEN_LIMIT', message: 'Your plan has 1 screen. Upgrade to add more.' });
    expect(refused.body.limit).toBeUndefined();
    expect(await devices()).toBe(limit);

    // A QR pairing too
    const frame = request.agent(app);
    const pairing = (await frame.post('/api/pair/start').expect(200)).body;
    const approved = await admin.post(`/api/admin/pair/${pairing.code}/approve`).send({ name: 'Hall', newAccount: {} }).expect(403);
    expect(approved.body).toMatchObject({ code: 'SCREEN_LIMIT', message: 'Your plan has 1 screen. Upgrade to add more.' });
    expect(await devices()).toBe(limit);

    // The screen already there signs in again: by token, by PIN with its token, and by
    // its session (a page from before PIN screens), and is never asked about again
    asked.length = 0;
    await existing.post('/api/auth/device').send({ token: kept.token }).expect(200);
    const again = (await signIn(existing, { pin: '482913', token: kept.token }).expect(200)).body;
    expect(again.device.id).toBe(kept.device.id);
    const renewed = (await signIn(existing, { pin: '482913' }).expect(200)).body;
    expect(renewed.device.id).toBe(kept.device.id);
    expect(screenAsks()).toEqual([]);
    expect(await devices()).toBe(limit);

    // MAX_SCREENS is still checked first, with its own number
    limit = Infinity;
    process.env.MAX_SCREENS = String(await devices());
    try {
      const capped = await signIn(request.agent(app), { pin: '482913' }).expect(403);
      expect(capped.body).toMatchObject({ code: 'SCREEN_LIMIT', limit: Number(process.env.MAX_SCREENS) });
    } finally {
      delete process.env.MAX_SCREENS;
    }
  });

  test('the hook is told how many screens there are now, and can limit by that alone', async () => {
    await getDataStore().set('devices', []);
    // At most 2 screens, from the count the core passes (no index of its own)
    answer = async ({ screens }, context) => ({
      ok: context.screensInUse + screens <= 2,
      message: 'Your plan has 2 screens. Upgrade to add more.'
    });
    await signIn(request.agent(app), { pin: '482913' }).expect(200);
    await signIn(request.agent(app), { pin: '482913' }).expect(200);
    const third = await signIn(request.agent(app), { pin: '482913' }).expect(403);
    expect(third.body).toMatchObject({ code: 'SCREEN_LIMIT', message: 'Your plan has 2 screens. Upgrade to add more.' });
    expect(contexts.filter(Boolean)).toEqual([{ screensInUse: 0 }, { screensInUse: 1 }, { screensInUse: 2 }]);
    expect(await devices()).toBe(2);

    // The same when they all come at once
    await getDataStore().set('devices', []);
    const results = await Promise.all([1, 2, 3].map(() => signIn(request.agent(app), { pin: '482913' })));
    expect(results.map(r => r.status).sort()).toEqual([200, 200, 403]);
    expect(await devices()).toBe(2);
  });

  test('two new screens at once cannot both take the last place', async () => {
    limit = (await devices()) + 1;
    const results = await Promise.all([signIn(request.agent(app), { pin: '482913' }), signIn(request.agent(app), { pin: '482913' })]);
    expect(results.map(r => r.status).sort()).toEqual([200, 403]);
    expect(await devices()).toBe(limit);
  });

  test('a hook error with its own code reaches the frame as it is', async () => {
    answer = async () => { throw Object.assign(new Error('Upgrade to add more'), { status: 402, code: 'PLAN_LIMIT', vars: { plan: 'free' } }); };
    const res = await signIn(request.agent(app), { pin: '482913' }).expect(402);
    expect(res.body).toMatchObject({ code: 'PLAN_LIMIT', plan: 'free', message: 'Upgrade to add more' });
  });
});

describe('the frame shows the hook\'s words for a screen limit', () => {
  function browserI18n(locale) {
    const window = {};
    const document = { documentElement: { classList: { add() {}, remove() {} }, dataset: {} }, addEventListener() {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/i18n.js'), 'utf8'), { window, document, setTimeout: () => {} });
    const load = code => JSON.parse(fs.readFileSync(path.join(__dirname, `../public/locales/${code}.json`), 'utf8'));
    Object.assign(window.i18n, { locale, messages: load(locale), fallback: load('en') });
    return window.i18n;
  }

  test('without a number, the server\'s message; with one, the translation', () => {
    const i18n = browserI18n('de');
    expect(i18n.error({ code: 'SCREEN_LIMIT', message: 'Your plan has 1 screen. Upgrade to add more.' }))
      .toBe('Your plan has 1 screen. Upgrade to add more.');
    expect(i18n.error({ code: 'SCREEN_LIMIT', message: 'x', limit: 3 })).toBe(i18n.t('errors.SCREEN_LIMIT', { limit: 3 }));
    expect(i18n.t('errors.SCREEN_LIMIT', { limit: 3 })).toContain('3');
  });

  test('the slideshow passes the sign-in\'s message on', () => {
    const source = fs.readFileSync(path.join(__dirname, '../public/js/slideshow.js'), 'utf8');
    expect(source).toContain("message: error || data.message");
  });
});

describe('the hook contract', () => {
  test('old callers passing a number are caught, not read as no limit', async () => {
    await expect(quotaService.assertCanAdd(5)).rejects.toThrow(TypeError);
    await expect(quotaService.addWithinQuota(5, async () => {})).rejects.toThrow(TypeError);
  });

  test('a context is passed through to the hook unchanged; photos send none', async () => {
    const context = { screensInUse: 3 };
    await quotaService.ask({ screens: 1 }, context);
    await quotaService.assertCanAdd({ screens: 1 }, context);
    await quotaService.addWithinQuota({ items: 1 }, async () => {}, context);
    expect(contexts).toEqual([context, context, context]);
    expect(contexts.every(c => c === context)).toBe(true);
    contexts.length = 0;
    await upload(await png(), 'p.png').expect(200);
    expect(contexts.every(c => c === undefined)).toBe(true);
  });

  test('a note asks for 1 item with assertCanAddItems', async () => {
    answer = async ({ items }) => ({ ok: items <= 0, message: 'You have reached 100 photos.' });
    await expect(quotaService.assertCanAddItems(quotaService.ITEMS.note)).rejects.toMatchObject({ status: 413, code: 'QUOTA_EXCEEDED', message: 'You have reached 100 photos.' });
    expect(lastAsked()).toEqual({ items: 1, bytes: 0, screens: 0 });
  });
});

describe('self-hosted: the default quota is unlimited', () => {
  test('anything may be added, by the hook and by a whole app', async () => {
    const appQuota = quotaService.getQuota();
    quotaService.setQuota(null);
    try {
      await expect(quotaService.assertCanAdd({ items: 1e9, bytes: 1e15, screens: 1e6 })).resolves.toBeUndefined();
      await expect(quotaService.assertCanAddItems(1e9)).resolves.toBeUndefined();
      await expect(quotaService.addWithinQuota({ items: 5, bytes: 1e12 }, async () => 'saved')).resolves.toBe('saved');
      expect(await quotaService.ask({ screens: 1 })).toEqual({ ok: true });
    } finally {
      quotaService.setQuota(appQuota);
    }

    // And a whole self-hosted app with no quota: an animation, a snap, and screens
    process.env.ADMIN_PASSWORD = 'self-hosted-pass';
    const selfHostedApp = createApp();
    const selfHosted = request.agent(selfHostedApp);
    try {
      expect(quotaService.getQuota()).not.toBe(appQuota);
      await selfHosted.post('/api/auth/login').send({ password: 'self-hosted-pass' }).expect(200);
      await selfHosted.post('/api/upload').field('path', 'uploads/family').attach('images', await animatedGif(), 'm.gif').expect(200);
      await selfHosted.post('/api/snaps').send({ folder: 'uploads/family', title: 'Hello' }).expect(201);
      await selfHosted.post('/api/access-accounts').send({ name: 'Kitchen', pin: '615204' }).expect(201);
      for (let i = 0; i < 3; i++) await request.agent(selfHostedApp).post('/api/auth/pin').send({ pin: '615204' }).expect(200);
    } finally {
      delete process.env.ADMIN_PASSWORD;
      quotaService.setQuota(appQuota);
    }
  });
});
