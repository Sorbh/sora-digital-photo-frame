// What an end-to-end run on phones found, against the real server:
// - API answers kept by the browser showed another library's folders after Back
// - "Last used: Never" for screens that were playing
// - a screen the host paused looked like any other on Access
// - "Add a screen" and /pair offered only top-level folders
const path = require('path');
const request = require('supertest');
const fs = require('fs-extra');

const testUploadsDir = path.join(__dirname, 'e2e-findings-uploads');
const testCacheDir = path.join(__dirname, 'e2e-findings-cache');
const testDataDir = path.join(__dirname, 'e2e-findings-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'test-admin-pass';
delete process.env.PHOTO_ENCRYPTION_KEY;

const { createApp } = require('../app');
const { getDataStore } = require('../store');
const { RECHECK_MS } = require('../middleware/freshViewer');
const { SoraPairFlow } = require('../public/js/pairFlow');

// Screens the host has paused, read by the optional auth hook
const pausedIds = new Set();
let pausedHook = id => pausedIds.has(id);
const app = createApp({
  auth: { isScreenPaused: (id, context) => pausedHook(id, context) },
  // A host's own API route, mounted before the core's (as the hosted library switcher is)
  beforeRoutes: (server) => server.get('/api/libraries', (req, res) => res.json({ libraries: ['own', 'shared'] }))
});

const HOUR = 60 * 60 * 1000;
const later = async (ms, call) => {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try { return await call(); } finally { Date.now = realNow; }
};

const admin = request.agent(app);

beforeAll(async () => {
  await fs.ensureDir(path.join(testUploadsDir, 'Family', 'Beach'));
  await fs.ensureDir(path.join(testUploadsDir, 'Family', 'Garden'));
  await fs.ensureDir(path.join(testUploadsDir, 'Trips'));
  await fs.writeFile(path.join(testUploadsDir, 'Family', 'pixel.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  await admin.post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200);
});

afterAll(async () => {
  await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
});

// Pairs a new frame by its code, as the QR page or "Add a screen" does.
// Answers the frame's own agent (signed in by its session), its token, device and account.
async function pairFrame(name, assignedFolders = []) {
  const frame = request.agent(app);
  const pairing = (await frame.post('/api/pair/start').expect(200)).body;
  await admin.post(`/api/admin/pair/${pairing.code}/approve`).send({ name, newAccount: { assignedFolders } }).expect(200);
  const collected = (await frame.post('/api/pair/collect').send({ code: pairing.code, secret: pairing.secret }).expect(200)).body;
  expect(collected.status).toBe('approved');
  return { frame, token: collected.token, deviceId: collected.device.id, accountId: collected.account.id };
}

const stored = async () => ({
  accounts: await getDataStore().get('access-accounts', []),
  devices: await getDataStore().get('devices', [])
});
// Makes a frame's "last used" and "last seen" look long ago
const ageUse = async ({ accountId, deviceId }, ms) => {
  const old = new Date(Date.now() - ms).toISOString();
  await getDataStore().update('access-accounts', [], list => list.map(a => (a.id === accountId ? { ...a, lastAccessed: old } : a)));
  await getDataStore().update('devices', [], list => list.map(d => (d.id === deviceId ? { ...d, lastSeen: old } : d)));
  return old;
};

describe('API answers are never kept by the browser', () => {
  test.each([
    ['the library listing', '/api/admin/folders?path=uploads'],
    ['the feature flags (with the scope)', '/api/features'],
    ['a host route mounted before the core', '/api/libraries'],
    ['the health check', '/api/health']
  ])('%s: no-store, no ETag', async (_, url) => {
    const res = await admin.get(url).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.etag).toBeUndefined();
  });

  test('a copy kept from before (with the ETag Express gave it) is never confirmed with a 304', async () => {
    const first = await admin.get('/api/admin/folders?path=uploads').expect(200);
    const kept = require('etag')(first.text, { weak: true });
    const res = await admin.get('/api/admin/folders?path=uploads').set('If-None-Match', kept).expect(200);
    expect(res.body.folders.map(f => f.name).sort()).toEqual(['Family', 'Trips']);
  });

  test('errors too', async () => {
    const res = await request(app).get('/api/admin/folders?path=uploads').expect(401);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.etag).toBeUndefined();
  });

  test('photos under /uploads keep their caching: an ETag, and a 304 when unchanged', async () => {
    const res = await admin.get('/uploads/Family/pixel.png').expect(200);
    expect(res.headers['cache-control']).not.toMatch(/no-store/);
    expect(res.headers.etag).toBeTruthy();
    await admin.get('/uploads/Family/pixel.png').set('If-None-Match', res.headers.etag).expect(304);
  });

  test('thumbnails keep theirs: revalidated with their own ETag', async () => {
    const res = await admin.get('/api/images/Family%2Fpixel.png/thumbnail').expect(200);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.headers.etag).toBeTruthy();
    await admin.get('/api/images/Family%2Fpixel.png/thumbnail').set('If-None-Match', res.headers.etag).expect(304);
  });
});

describe('"Last used" on Access for frames paired by code', () => {
  test('pairing counts as a use: the screen is seen and its account used', async () => {
    const before = Date.now();
    const { accountId, deviceId } = await pairFrame('Kitchen TV');
    const { accounts, devices } = await stored();
    expect(Date.parse(accounts.find(a => a.id === accountId).lastAccessed)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(devices.find(d => d.id === deviceId).lastSeen)).toBeGreaterThanOrEqual(before - 1000);
  });

  test('a frame signing in again with its token updates both', async () => {
    const paired = await pairFrame('Hall TV');
    const old = await ageUse(paired, 3 * HOUR);
    await request(app).post('/api/auth/device').send({ token: paired.token }).expect(200);
    const { accounts, devices } = await stored();
    expect(accounts.find(a => a.id === paired.accountId).lastAccessed).not.toBe(old);
    expect(Date.parse(accounts.find(a => a.id === paired.accountId).lastAccessed)).toBeGreaterThan(Date.parse(old));
    expect(Date.parse(devices.find(d => d.id === paired.deviceId).lastSeen)).toBeGreaterThan(Date.parse(old));
  });

  test('a frame playing on its session for days still counts as used, about once an hour', async () => {
    const paired = await pairFrame('Bedroom TV');
    await paired.frame.get('/api/folders').expect(200); // its first look, just after pairing
    const used = id => stored().then(({ accounts }) => accounts.find(a => a.id === id).lastAccessed);
    const seen = id => stored().then(({ devices }) => devices.find(d => d.id === id).lastSeen);

    // Within the recheck time nothing is looked up or written
    const old = await ageUse(paired, 3 * HOUR);
    await paired.frame.get('/api/folders').expect(200);
    expect(await used(paired.accountId)).toBe(old);

    // At the next recheck, both are noted
    await later(RECHECK_MS + 1000, () => paired.frame.get('/api/folders').expect(200));
    expect(Date.parse(await used(paired.accountId))).toBeGreaterThan(Date.parse(old));
    expect(Date.parse(await seen(paired.deviceId))).toBeGreaterThan(Date.parse(old));

    // Used half an hour ago: the next recheck leaves "last used" alone, but the
    // screen's own "last seen" is written every few minutes
    const recent = await ageUse(paired, HOUR / 2);
    await later(2 * (RECHECK_MS + 1000), () => paired.frame.get('/api/folders').expect(200));
    expect(await used(paired.accountId)).toBe(recent);
    expect(Date.parse(await seen(paired.deviceId))).toBeGreaterThan(Date.parse(recent));

    // Seen a minute ago: nothing written
    const justNow = await ageUse(paired, 60 * 1000);
    await later(3 * (RECHECK_MS + 1000), () => paired.frame.get('/api/folders').expect(200));
    expect(await seen(paired.deviceId)).toBe(justNow);
  });

  test("every request a screen makes, like its next photo, shows on Screens at once, without a write each time", async () => {
    const paired = await pairFrame('Study TV');
    await paired.frame.get('/api/folders').expect(200);
    const written = await ageUse(paired, 60 * 1000); // stored a minute ago, so no write is due
    const before = Date.now();
    await paired.frame.get('/api/images/next').expect(res => expect(res.status).toBeLessThan(500));
    const listed = (await admin.get('/api/admin/devices').expect(200)).body.devices.find(d => d.id === paired.deviceId);
    expect(Date.parse(listed.lastSeen)).toBeGreaterThanOrEqual(before - 5);
    expect((await stored()).devices.find(d => d.id === paired.deviceId).lastSeen).toBe(written);
  });

  test('Access shows the newest of the account and its screens', () => {
    const { AccessAccountsManager } = loadAccessPage();
    const manager = Object.assign(Object.create(AccessAccountsManager.prototype), {
      devices: [
        { id: 'd1', accountId: 'a1', lastSeen: '2026-11-20T10:00:00.000Z' },
        { id: 'd2', accountId: 'a1', lastSeen: null },
        { id: 'd3', accountId: 'other', lastSeen: '2026-11-25T10:00:00.000Z' }
      ]
    });
    expect(manager.lastUsed({ id: 'a1', lastAccessed: null })).toBe('2026-11-20T10:00:00.000Z');
    expect(manager.lastUsed({ id: 'a1', lastAccessed: '2026-11-22T10:00:00.000Z' })).toBe('2026-11-22T10:00:00.000Z');
    expect(manager.lastUsed({ id: 'a2', lastAccessed: null })).toBeNull();
  });
});

describe('Paused screens on Access (auth isScreenPaused)', () => {
  afterEach(() => {
    pausedIds.clear();
    pausedHook = id => pausedIds.has(id);
  });

  test('the device list says paused: true for the screens the host paused, and nothing for the rest', async () => {
    const one = await pairFrame('Paused TV');
    const two = await pairFrame('Playing TV');
    const seen = [];
    pausedHook = async (id, context) => {
      seen.push(context);
      return pausedIds.has(id);
    };
    pausedIds.add(one.deviceId);
    const { devices } = (await admin.get('/api/admin/devices').expect(200)).body;
    expect(devices.find(d => d.id === one.deviceId).paused).toBe(true);
    expect(devices.find(d => d.id === two.deviceId)).not.toHaveProperty('paused');
    expect(seen[0]).toEqual({ tenantId: 'default' });
  });

  test('a hook that fails, or answers anything but true, pauses nothing', async () => {
    const paired = await pairFrame('Another TV');
    pausedHook = id => id === paired.deviceId;
    expect((await admin.get('/api/admin/devices').expect(200)).body.devices.find(d => d.id === paired.deviceId).paused).toBe(true);

    pausedHook = () => { throw new Error('directory down'); };
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    let { devices } = (await admin.get('/api/admin/devices').expect(200)).body;
    errors.mockRestore();
    expect(devices.some(d => 'paused' in d)).toBe(false);

    pausedHook = () => 'yes';
    ({ devices } = (await admin.get('/api/admin/devices').expect(200)).body);
    expect(devices.some(d => 'paused' in d)).toBe(false);
  });

  test('Access shows a "Paused" badge and why, in place of when it was seen', () => {
    const { AccessAccountsManager } = loadAccessPage();
    const manager = Object.assign(Object.create(AccessAccountsManager.prototype), {
      devices: [
        { id: 'd1', name: 'Kitchen TV', accountId: 'a1', via: 'qr', lastSeen: '2026-11-20T10:00:00.000Z', paused: true },
        { id: 'd2', name: 'Hall TV', accountId: 'a1', via: 'qr', lastSeen: '2026-11-20T10:00:00.000Z' }
      ]
    });
    const html = manager.renderDevices({ id: 'a1' });
    const [kitchen, hall] = html.split(/class="paired-frame(?!s)/).slice(1);
    expect(kitchen).toContain('is-paused');
    expect(kitchen).toContain('<span class="paused-badge">accessAccounts.screenPaused</span>');
    expect(kitchen).toContain('accessAccounts.screenPausedNote');
    expect(kitchen).not.toContain('accessAccounts.frameSeen');
    expect(hall).not.toContain('paused');
    expect(hall).toContain('accessAccounts.frameSeen');
  });
});

describe('"Add a screen" and /pair offer folders and their subfolders', () => {
  const getJson = (url, options = {}) => {
    const call = options.method === 'POST' ? admin.post(url).send(JSON.parse(options.body)) : admin.get(url);
    return call.then(res => ({ ok: res.status < 400, status: res.status, json: Boolean(res.body) && typeof res.body === 'object', data: res.body || {} }));
  };

  test('the lookup brings the top two levels, as sharing does', async () => {
    const pairing = (await request.agent(app).post('/api/pair/start').expect(200)).body;
    const found = await SoraPairFlow.lookup(pairing.code, getJson);
    expect(found.state).toBe('ready');
    const byName = Object.fromEntries(found.folders.map(f => [f.name, f]));
    expect(byName.Family.children.map(c => c.path).sort()).toEqual(['Family/Beach', 'Family/Garden']);
    expect(byName.Trips.children).toEqual([]);
  });

  test('a subfolder chosen in the picker is what the new screen gets, and plays only that', async () => {
    const frame = request.agent(app);
    const pairing = (await frame.post('/api/pair/start').expect(200)).body;
    const found = await SoraPairFlow.lookup(pairing.code, getJson);
    const page = fakeChoices();
    const choices = SoraPairFlow.choices({ ...page.lists, name: 'screen' });
    choices.show(found);
    page.chosen = SoraPairFlow.NEW;
    page.tick('Family/Beach');
    const { body } = choices.body('Porch TV');
    expect(body).toEqual({ name: 'Porch TV', newAccount: { assignedFolders: ['Family/Beach'] } });

    const approved = await SoraPairFlow.approve(pairing.code, body, getJson);
    expect(approved.state).toBe('done');
    await frame.post('/api/pair/collect').send({ code: pairing.code, secret: pairing.secret }).expect(200);
    const top = (await frame.get('/api/folders').expect(200)).body.folders.map(f => f.name);
    expect(top).toEqual(['Family']); // only the way to Beach
    await frame.get('/api/folders/Trips').expect(404);
  });

  test('ticking a folder covers its subfolders: they show ticked, can\'t be unticked alone, and aren\'t sent too', () => {
    const page = fakeChoices();
    const choices = SoraPairFlow.choices({ ...page.lists, name: 'screen' });
    choices.show({
      accounts: [],
      pinSignIn: false,
      folders: [
        { name: 'Family', path: 'Family', children: [{ name: 'Beach', path: 'Family/Beach' }, { name: 'Garden', path: 'Family/Garden' }] },
        { name: 'Trips', path: 'Trips', children: [] }
      ]
    });
    page.chosen = SoraPairFlow.NEW;
    expect(page.rows().map(r => [r.path, r.sub])).toEqual([
      ['Family', false], ['Family/Beach', true], ['Family/Garden', true], ['Trips', false]
    ]);

    page.tick('Family/Beach');
    page.tick('Family');
    const family = page.row('Family');
    expect(family.checked).toBe(true);
    expect(page.row('Family/Beach')).toMatchObject({ checked: true, disabled: true });
    expect(page.row('Family/Garden')).toMatchObject({ checked: true, disabled: true });
    expect(choices.body('TV').body.newAccount.assignedFolders).toEqual(['Family']);

    // Unticked again: its subfolders are free, and unticked
    page.untick('Family');
    expect(page.row('Family/Beach')).toMatchObject({ checked: false, disabled: false });
    expect(choices.body('TV').body.newAccount.assignedFolders).toEqual([]);

    // A language change keeps the ticks
    page.tick('Trips');
    choices.render();
    expect(page.row('Trips').checked).toBe(true);
    expect(choices.body('TV').body.newAccount.assignedFolders).toEqual(['Trips']);
  });
});

// ---------------------------------------------------------------------------

// The Access page's script, with only what its classes need to load
function loadAccessPage() {
  const vm = require('vm');
  const read = file => fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
  const sandbox = {
    document: { addEventListener() {}, getElementById: () => null },
    window: { addEventListener() {}, i18n: { locale: 'en', supported: ['en'], names: { en: 'English' } } },
    t: key => key,
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(`${read('access-accounts.js')}\nthis.AccessAccountsManager = AccessAccountsManager;`, sandbox);
  return { AccessAccountsManager: sandbox.AccessAccountsManager };
}

// Just enough of the page for SoraPairFlow.choices: the lists, the rows it draws
// and their checkboxes, and the chosen account
function fakeChoices() {
  const element = () => {
    const parts = {};
    const listeners = {};
    const el = {
      className: '', value: '', checked: false, disabled: false, textContent: '', children: [], innerHTML: '',
      classList: { toggle() {}, add() {}, remove() {} },
      addEventListener: (type, fn) => { listeners[type] = fn; },
      fire: type => listeners[type] && listeners[type]({ type }),
      focus() {},
      appendChild(child) { el.children.push(child); },
      querySelector: selector => (parts[selector] ||= element()),
      querySelectorAll: () => el.children.map(child => child.querySelector('input'))
    };
    Object.defineProperty(el, 'innerHTML', {
      get: () => el.html || '',
      set: value => { el.html = value; if (value === '') el.children = []; }
    });
    return el;
  };
  const lists = { accountList: element(), newAccount: element(), folderList: element() };
  const page = {
    lists,
    chosen: null,
    rows: () => lists.folderList.children.map(label => {
      const input = label.querySelector('input');
      return { path: input.value, sub: label.className.includes('folder-sub'), checked: input.checked, disabled: input.disabled, input };
    }),
    row: folderPath => page.rows().find(r => r.path === folderPath),
    tick: folderPath => { const { input } = page.row(folderPath); input.checked = true; input.fire('change'); },
    untick: folderPath => { const { input } = page.row(folderPath); input.checked = false; input.fire('change'); }
  };
  global.document = {
    createElement: element,
    querySelector: selector => (/:checked$/.test(selector) && page.chosen ? { value: page.chosen } : null)
  };
  global.t = key => key;
  return page;
}
