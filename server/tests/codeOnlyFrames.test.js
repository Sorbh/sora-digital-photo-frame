// Frames that connect by their code only: PIN sign-in off (PIN_SIGN_IN=off or
// createApp({ pinSignIn: false })), "Add a screen" on the Access page, and the
// card a frame shows when its host pauses it (403 SCREEN_PAUSED).
const path = require('path');
const vm = require('vm');
const request = require('supertest');
const fs = require('fs-extra');

const testUploadsDir = path.join(__dirname, 'code-only-uploads');
const testCacheDir = path.join(__dirname, 'code-only-cache');
const testDataDir = path.join(__dirname, 'code-only-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'test-admin-pass';

const { createApp } = require('../app');
const ScreenPause = require('../public/js/screenPause');

const publicDir = path.join(__dirname, '..', 'public');
const read = file => fs.readFileSync(path.join(publicDir, file), 'utf8');
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
const waitFor = async (done) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(done()).toBe(true);
};

// ---------------------------------------------------------------------------
// A small stand-in for the browser's page: elements by id, with classes,
// listeners and the few methods the page scripts use

function fakeElement(id) {
  const listeners = {};
  const classes = new Set();
  const element = {
    id, value: '', textContent: '', innerHTML: '', checked: false, disabled: false, hidden: false, required: false,
    open: false, children: [], dataset: {}, style: {},
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle: (name, on) => ((on === undefined ? !classes.has(name) : on) ? classes.add(name) : classes.delete(name))
    },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter(listener => listener !== fn); },
    dispatchEvent: (event) => { (listeners[event.type] || []).forEach(fn => fn(event)); return true; },
    fire: type => (listeners[type] || []).forEach(fn => fn({ type, preventDefault() {}, currentTarget: element })),
    focus() {},
    showModal() { element.open = true; },
    close() { element.open = false; },
    appendChild(child) { element.children.push(child); },
    removeChild() {},
    setAttribute(name, value) { element[`attr:${name}`] = value; },
    getAttribute: name => element[`attr:${name}`],
    removeAttribute() {},
    querySelector: () => (element.innerHTML ? fakeElement() : null),
    querySelectorAll: () => [],
    get outerHTML() { return `<span>${element.textContent}</span>`; }
  };
  return element;
}

function fakePage({ checked = () => null } = {}) {
  const elements = {};
  const listeners = {};
  const document = {
    getElementById: id => (elements[id] ||= fakeElement(id)),
    createElement: () => fakeElement(),
    querySelector: selector => {
      const match = /^input\[name="(\w+)"\]:checked$/.exec(selector);
      const value = match && checked(match[1]);
      return value ? { value } : null;
    },
    querySelectorAll: () => [],
    addEventListener: (type, fn) => { listeners[type] = fn; },
    dispatchEvent() {},
    documentElement: { dataset: {} }
  };
  return { elements, document, el: document.getElementById, listeners };
}

// The Access page's script (with js/pairFlow.js before it, as the page loads them)
function openAccessPage({ fetch, checked, location = { href: '' } } = {}) {
  const page = fakePage({ checked });
  const requests = [];
  const sandbox = {
    document: page.document,
    window: { addEventListener() {} },
    location,
    console: { error() {}, log() {} },
    URLSearchParams,
    setTimeout: () => 0,
    confirm: () => true,
    t: (key, vars) => (vars && vars.name ? `${key}:${vars.name}` : key),
    i18n: { error: (data, key) => (data && data.error) || key },
    matchMedia: () => ({ matches: false }),
    FormData: class { constructor() { this.values = { name: page.el('accountName').value, pin: page.el('accountPin').value }; } get(name) { return this.values[name]; } },
    fetch: (url, options) => { requests.push({ url, options }); return fetch(url, options); }
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(read('js/pairFlow.js'), context);
  vm.runInContext(`${read('access-accounts.js')}\nthis.AddScreenDialog = AddScreenDialog; this.AccessAccountsManager = AccessAccountsManager;`, context);
  return { ...page, sandbox, requests, AddScreenDialog: sandbox.AddScreenDialog, AccessAccountsManager: sandbox.AccessAccountsManager };
}

// A reply as fetch gives it
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, clone() { return reply(status, body); } });

// The slideshow page: slideshow.html's head script, js/screenPause.js and the
// sign-in class, at an address, with the server's data-pin-sign-in on <html>
function openSlideshow(href, { pinSignIn = 'on', answer = () => new Promise(() => {}), token = null, navigator } = {}) {
  const html = read('slideshow.html');
  const headScript = /<head>[\s\S]*?<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const page = fakePage();
  page.document.documentElement.dataset.pinSignIn = pinSignIn;
  page.el('pausedScreen').classList.add('hidden');
  const requests = [];
  const timers = [];
  const store = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
  const sandbox = {
    URL, URLSearchParams, AbortController, Event,
    console: { log() {}, error() {}, warn() {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    location: { href, search: new URL(href).search, hash: new URL(href).hash, reload() { sandbox.reloaded += 1; } },
    reloaded: 0,
    localStorage: store(),
    sessionStorage: store(),
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    i18n: { error: (data, key) => key },
    document: page.document,
    addEventListener() {},
    matchMedia: () => ({ matches: false }),
    fetch: (url, options) => {
      requests.push({ url, body: options?.body ? JSON.parse(options.body) : null });
      return Promise.resolve(answer(url, options));
    },
    t: key => key
  };
  if (token) sandbox.localStorage.setItem('photoframe_device_token', token);
  sandbox.window = sandbox;
  sandbox.history = {
    state: null,
    replaceState(state, title, url) {
      const next = new URL(url, sandbox.location.href);
      Object.assign(sandbox.location, { href: next.href, search: next.search, hash: next.hash });
    }
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(headScript, context);
  if (navigator) {
    sandbox.navigator = navigator;
    vm.runInContext(read('js/deviceKind.js'), context);
  }
  vm.runInContext(read('js/screenPause.js'), context);
  vm.runInContext(read('js/frameSession.js'), context);
  const source = read('js/slideshow.js');
  vm.runInContext(`${source.slice(0, source.indexOf('class WeatherWidget'))}
    this.manager = this.authManager = new AuthenticationManager();
    this.PhotoFrameSlideshow = PhotoFrameSlideshow;`, context);
  return { ...page, sandbox, requests, timers, manager: sandbox.manager };
}

test('the slideshow advertises its model and browser at pairing start and token sign-in', async () => {
  const navigator = {
    userAgent: 'Mozilla/5.0 (Linux; Android 10; K) Chrome/120.0 Mobile Safari/537.36',
    userAgentData: { getHighEntropyValues: async () => ({ model: 'Pixel 7', platformVersion: '14.0.0' }) }
  };
  const answer = url => {
    if (url === '/api/auth/device') return reply(200, { success: true, account: { id: 'acc_1' } });
    return reply(200, { authenticated: false });
  };
  const href = 'https://frame.example/frame';
  const pairing = openSlideshow(href, { pinSignIn: 'off', navigator, answer });
  const reconnect = openSlideshow(href, { pinSignIn: 'off', navigator, answer, token: 'dev_tok' });
  await flush();
  const info = { kind: 'phone', platform: 'Android · Chrome', model: 'Pixel 7' };
  expect(pairing.requests).toContainEqual({ url: '/api/pair/start', body: info });
  expect(reconnect.requests).toContainEqual({ url: '/api/auth/device', body: { token: 'dev_tok', ...info } });
});

// ---------------------------------------------------------------------------

describe('PIN sign-in off (PIN_SIGN_IN=off)', () => {
  let app;
  let admin;

  beforeAll(async () => {
    process.env.PIN_SIGN_IN = 'off';
    app = createApp();
    delete process.env.PIN_SIGN_IN;
    await fs.ensureDir(path.join(testUploadsDir, 'Goa'));
    await fs.ensureDir(path.join(testUploadsDir, 'Family'));
    admin = request.agent(app);
    await admin.post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200);
  });

  afterAll(async () => {
    await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
  });

  test('the PIN API refuses, and features and the session say so', async () => {
    const refused = await request(app).post('/api/auth/pin').send({ pin: '123456' }).expect(404);
    expect(refused.body.code).toBe('PIN_DISABLED');
    expect((await admin.get('/api/features').expect(200)).body.pinSignIn).toBe(false);
    expect((await request(app).get('/api/auth/session').expect(200)).body.pinSignIn).toBe(false);
    expect((await admin.get('/api/access-accounts').expect(200)).body.pinSignIn).toBe(false);
  });

  test('the slideshow page is told before anything loads', async () => {
    const res = await request(app).get('/frame').expect(200);
    expect(/<html[^>]*>/.exec(res.text)[0]).toContain('data-pin-sign-in="off"');
  });

  test('a screen is a name and its folders: no PIN needed, and none kept', async () => {
    const made = await admin.post('/api/access-accounts').send({ name: 'Hall', assignedFolders: ['Goa'] }).expect(201);
    expect(made.body.account).toMatchObject({ name: 'Hall', assignedFolders: ['Goa'], hasPin: false });
    const withPin = await admin.post('/api/access-accounts').send({ name: 'Den', pin: '482913' }).expect(201);
    expect(withPin.body.account.hasPin).toBe(false);
    const edited = await admin.put(`/api/access-accounts/${made.body.account.id}`).send({ name: 'Hallway', pin: '135790', assignedFolders: [] }).expect(200);
    expect(edited.body.account).toMatchObject({ name: 'Hallway', hasPin: false });
  });

  describe('"Add a screen" on the Access page, against the real server', () => {
    // The phone's browser: the admin's signed-in session
    const phone = async (url, { method = 'GET', headers = {}, body } = {}) => {
      let call = admin[method.toLowerCase()](url).set(headers);
      if (body !== undefined) call = call.send(body);
      const res = await call;
      return { ok: res.status < 400, status: res.status, json: async () => res.body };
    };
    const startFrame = async () => {
      const frame = request.agent(app);
      const pairing = (await frame.post('/api/pair/start').expect(200)).body;
      return { frame, pairing };
    };
    // A code as someone might type it off the TV: small letters, spaces, a dash
    const sloppy = code => ` ${code.slice(0, 2).toLowerCase()} ${code.slice(2, 3)}-${code.slice(3).toLowerCase()} `;

    test('a code typed in odd case and spacing finds the frame; a new screen is made and the frame signs in', async () => {
      const { frame, pairing } = await startFrame();
      const page = openAccessPage({ fetch: phone, checked: name => (name === 'screenAccount' ? '__new__' : null) });
      let added = 0;
      const dialog = new page.AddScreenDialog({ onAdded: () => { added += 1; } });
      dialog.open();
      expect(page.el('addScreenModal').open).toBe(true);

      page.el('screenCodeInput').value = sloppy(pairing.code);
      page.el('screenCodeForm').fire('submit');
      await waitFor(() => !page.el('screenPairForm').classList.contains('hidden'));
      expect(page.requests[0].url).toBe(`/api/admin/pair/${pairing.code}`);
      expect(page.el('screenCodeShown').textContent).toBe(`${pairing.code.slice(0, 3)}-${pairing.code.slice(3)}`);
      expect(page.el('screenCodeForm').classList.contains('hidden')).toBe(true);

      page.el('screenName').value = 'Living room TV';
      page.el('screenPairForm').fire('submit');
      await waitFor(() => !page.el('screenDone').classList.contains('hidden'));
      expect(page.el('screenDoneTitle').innerHTML).toBe('accessAccounts.screenAdded:<span>Living room TV</span>');
      expect(added).toBe(1);

      // The TV hears it was approved, collects its sign-in and is in
      const collected = await frame.post('/api/pair/collect').send({ code: pairing.code, secret: pairing.secret }).expect(200);
      expect(collected.body).toMatchObject({ status: 'approved', device: { name: 'Living room TV' }, account: { name: 'Living room TV' } });
      const accounts = (await admin.get('/api/access-accounts').expect(200)).body.accounts;
      // A new screen has no PIN, not even a hidden one
      expect(accounts.find(a => a.id === collected.body.account.id)).toMatchObject({ hasPin: false });
    });

    test('picking an existing screen puts the frame on it', async () => {
      const hall = (await admin.get('/api/access-accounts').expect(200)).body.accounts.find(a => a.name === 'Hallway');
      const { frame, pairing } = await startFrame();
      const page = openAccessPage({ fetch: phone, checked: name => (name === 'screenAccount' ? hall.id : null) });
      const dialog = new page.AddScreenDialog({});
      dialog.open();
      page.el('screenCodeInput').value = pairing.code.toLowerCase();
      page.el('screenCodeForm').fire('submit');
      await waitFor(() => !page.el('screenPairForm').classList.contains('hidden'));
      page.el('screenName').value = 'Hall TV';
      page.el('screenPairForm').fire('submit');
      await waitFor(() => !page.el('screenDone').classList.contains('hidden'));

      const collected = await frame.post('/api/pair/collect').send({ code: pairing.code, secret: pairing.secret }).expect(200);
      expect(collected.body).toMatchObject({ device: { name: 'Hall TV' }, account: { id: hall.id, name: 'Hallway' } });
    });

    test('a wrong code says so plainly and stays on the code', async () => {
      const page = openAccessPage({ fetch: phone });
      const dialog = new page.AddScreenDialog({});
      dialog.open();
      page.el('screenCodeInput').value = 'ZZZ-ZZZ';
      page.el('screenCodeForm').fire('submit');
      await waitFor(() => page.el('screenCodeError').textContent !== '');
      expect(page.el('screenCodeError').textContent).toBe('accessAccounts.screenCodeWrong');
      expect(page.el('screenCodeError').classList.contains('hidden')).toBe(false);
      expect(page.el('screenPairForm').classList.contains('hidden')).toBe(true);

      // Too short is caught on the phone, before asking
      page.el('screenCodeInput').value = 'K7P';
      const asked = page.requests.length;
      page.el('screenCodeForm').fire('submit');
      await flush();
      expect(page.requests.length).toBe(asked);
      expect(page.el('screenCodeError').textContent).toBe('pair.codeInvalid');
    });

    test('a code that expires before approval goes back to the code, with the same plain error', async () => {
      const { pairing } = await startFrame();
      const page = openAccessPage({ fetch: phone, checked: name => (name === 'screenAccount' ? '__new__' : null) });
      const dialog = new page.AddScreenDialog({});
      dialog.open();
      page.el('screenCodeInput').value = pairing.code;
      page.el('screenCodeForm').fire('submit');
      await waitFor(() => !page.el('screenPairForm').classList.contains('hidden'));

      // Used meanwhile (from the QR page, say)
      await admin.post(`/api/admin/pair/${pairing.code}/approve`).send({ name: 'Elsewhere', newAccount: { assignedFolders: [] } }).expect(200);
      page.el('screenName').value = 'Kitchen TV';
      page.el('screenPairForm').fire('submit');
      await waitFor(() => !page.el('screenCodeForm').classList.contains('hidden'));
      expect(page.el('screenCodeError').textContent).toBe('accessAccounts.screenCodeWrong');
      expect(page.el('screenCodeInput').value).toBe('');
    });

    test("can't reach the library: not called a wrong code", async () => {
      const page = openAccessPage({ fetch: async () => reply(503, { success: false }) });
      const dialog = new page.AddScreenDialog({});
      dialog.open();
      page.el('screenCodeInput').value = 'K7P-4QX';
      page.el('screenCodeForm').fire('submit');
      await waitFor(() => page.el('screenCodeError').textContent !== '');
      expect(page.el('screenCodeError').textContent).toBe('pair.unreachableNote');
    });
  });
});

describe('The Access page shows screens with PIN sign-in off, and PINs with it on', () => {
  const library = pinSignIn => async (url) => {
    if (url === '/api/access-accounts') return reply(200, { accounts: [{ id: 'acc_1', name: 'Kitchen', assignedFolders: ['Goa'] }], pinSignIn });
    if (url === '/api/admin/devices') return reply(200, { devices: [] });
    if (url === '/api/folders') return reply(200, { folders: [{ name: 'Goa', path: 'Goa' }] });
    if (url === '/api/admin/family-code') return reply(200, { required: false });
    return reply(200, { success: true });
  };

  test('off: no PIN field, no "New account", and the cards are screens', async () => {
    const page = openAccessPage({ fetch: library(false) });
    const manager = new page.AccessAccountsManager();
    await flush();
    expect(page.el('pinField').classList.contains('hidden')).toBe(true);
    expect(page.el('createAccountBtn').classList.contains('hidden')).toBe(true);
    expect(page.el('accessEyebrow').dataset.i18nHtml).toBe('accessAccounts.screensEyebrow');
    expect(page.el('accountsList').innerHTML).toContain('Kitchen');
    expect(page.el('accountsList').innerHTML).not.toContain('pin-reveal');
    expect(page.el('accountsMetaText').textContent).toBe('accessAccounts.screensCount');

    // Editing a screen saves its name and folders, never a PIN
    manager.editAccount('acc_1');
    page.el('accountName').value = 'Kitchen TV';
    page.el('accountPin').value = '';
    await manager.saveAccount();
    const saved = page.requests.find(r => r.url === '/api/access-accounts/acc_1');
    expect(JSON.parse(saved.options.body)).toEqual({ name: 'Kitchen TV', assignedFolders: [] });
  });

  test('on: unchanged, with the PIN field and "New account"', async () => {
    const page = openAccessPage({ fetch: library(true) });
    new page.AccessAccountsManager();
    await flush();
    expect(page.el('pinField').classList.contains('hidden')).toBe(false);
    expect(page.el('createAccountBtn').classList.contains('hidden')).toBe(false);
    expect(page.el('accountsList').innerHTML).toContain('pin-reveal');
    expect(page.el('accountsMetaText').textContent).toBe('accessAccounts.accounts');
  });
});

describe('PIN sign-in on (the self-hosted default) is unchanged', () => {
  let app;

  beforeAll(async () => {
    app = createApp();
    await fs.ensureDir(testUploadsDir);
  });

  afterAll(async () => {
    await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
  });

  test('the PIN API, features and the slideshow page all say on', async () => {
    const admin = request.agent(app);
    await admin.post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200);
    expect((await admin.get('/api/features').expect(200)).body.pinSignIn).toBe(true);
    expect(/<html[^>]*>/.exec((await request(app).get('/frame').expect(200)).text)[0]).toContain('data-pin-sign-in="on"');
    await admin.post('/api/access-accounts').send({ name: 'Den' }).expect(400);
    await admin.post('/api/access-accounts').send({ name: 'Den', pin: '482913' }).expect(201);
    const signedIn = await request(app).post('/api/auth/pin').send({ pin: '482913' }).expect(200);
    expect(signedIn.body.account.name).toBe('Den');
  });
});

describe('The frame with PIN sign-in off', () => {
  test('shows only the pairing code and QR: no PIN pad', () => {
    const { el, manager } = openSlideshow('https://frame.example/frame', { pinSignIn: 'off' });
    expect(manager.pinSignIn).toBe(false);
    expect(el('authOverlay').classList.contains('pin-off')).toBe(true);
    expect(el('pinForm').hidden).toBe(true);
  });

  test('ignores a #pin= link, and still takes it out of the address', () => {
    const { requests, sandbox } = openSlideshow('https://frame.example/frame?lang=de#pin=123456&family=ABCD-EFGH', { pinSignIn: 'off' });
    expect(requests.map(r => r.url)).not.toContain('/api/auth/pin');
    expect(sandbox.location.href).toBe('https://frame.example/frame?lang=de');
  });

  test('a server that only says so in the session check still hides the PIN pad', async () => {
    const { el, manager } = openSlideshow('https://frame.example/frame', {
      pinSignIn: 'on',
      answer: url => (url === '/api/auth/session' ? reply(200, { authenticated: false, pinSignIn: false }) : new Promise(() => {}))
    });
    await flush();
    expect(manager.pinSignIn).toBe(false);
    expect(el('authOverlay').classList.contains('pin-off')).toBe(true);
  });

  test('with it on, the PIN pad shows and a #pin= link signs in, as before', () => {
    const { el, requests, manager } = openSlideshow('https://frame.example/frame#pin=123456');
    expect(manager.pinSignIn).toBe(true);
    expect(el('authOverlay').classList.contains('pin-off')).toBe(false);
    expect(requests.find(r => r.url === '/api/auth/pin').body).toMatchObject({ pin: '123456' });
  });
});

describe('A paused screen (403 SCREEN_PAUSED)', () => {
  const paused = reply(403, { success: false, code: 'SCREEN_PAUSED', error: 'This screen is paused. Ask the owner to upgrade.' });

  test('any request that gets it shows the card with the host message, checks again every few minutes, and resumes by itself', async () => {
    const timers = [];
    const shown = [];
    let reloads = 0;
    let host = 'paused';
    const requests = [];
    const storage = { getItem: key => (key === 'photoframe_device_token' ? 'dev_tok' : null), removeItem: jest.fn() };
    const pause = new ScreenPause({
      fetch: async (url, options) => {
        requests.push({ url, body: options?.body });
        return host === 'paused' ? paused : reply(200, { success: true });
      },
      show: message => shown.push(message),
      reload: () => { reloads += 1; },
      timers: { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {} },
      storage
    });

    const res = await pause.fetch('/api/images/next');
    expect(res.status).toBe(403); // the caller still gets its answer
    await flush();
    expect(shown).toEqual(['This screen is paused. Ask the owner to upgrade.']);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBeGreaterThanOrEqual(60 * 1000);

    // Still paused: asks again with its token, which it keeps, and waits again
    await timers.shift().fn();
    expect(requests.at(-1)).toEqual({ url: '/api/auth/device', body: JSON.stringify({ token: 'dev_tok' }) });
    expect(timers).toHaveLength(1);
    expect(reloads).toBe(0);

    // Offline for a moment: waits again too
    host = 'paused';
    pause.request = async () => { throw new TypeError('Failed to fetch'); };
    await timers.shift().fn();
    expect(timers).toHaveLength(1);

    // Upgraded: starts again by itself
    pause.request = async () => reply(200, { success: true });
    await timers.shift().fn();
    expect(reloads).toBe(1);
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  test('other 403s are not a pause', async () => {
    const shown = [];
    const pause = new ScreenPause({ fetch: async () => reply(403, { code: 'OUTSIDE_FOLDERS' }), show: m => shown.push(m), reload() {}, timers: { setTimeout() {}, clearTimeout() {} } });
    await pause.fetch('/api/images/next');
    await flush();
    expect(shown).toEqual([]);
  });

  test('at start-up, the session check gets it: the card shows, the token is kept, and no sign-in screen or new code', async () => {
    const { el, requests, manager, sandbox, timers } = openSlideshow('https://frame.example/frame', {
      answer: () => paused
    });
    await flush();
    expect(el('pausedScreen').classList.contains('hidden')).toBe(false);
    expect(el('pausedMessage').textContent).toBe('This screen is paused. Ask the owner to upgrade.');
    expect(requests.map(r => r.url)).toEqual(['/api/auth/session']);
    expect(manager.isAuthenticated).toBe(false);
    // And it keeps checking quietly
    expect(timers.some(t => t.fn.toString().includes('check'))).toBe(true);
    expect(sandbox.reloaded).toBe(0);
  });

  test('at start-up with a token, the device sign-in gets it: the token is kept and nothing else is tried', async () => {
    const { el, requests, sandbox } = openSlideshow('https://frame.example/frame', { token: 'dev_tok', answer: () => paused });
    await flush();
    expect(el('pausedScreen').classList.contains('hidden')).toBe(false);
    expect(requests.map(r => r.url)).toEqual(['/api/auth/device']);
    expect(sandbox.localStorage.getItem('photoframe_device_token')).toBe('dev_tok');
  });
});

describe('A screen removed while it plays (js/frameSession.js)', () => {
  const fresh = { success: true, code: 'K7P4QX', secret: 'sec', expiresAt: Date.now() + 10 * 60 * 1000, qr: '<svg>new</svg>', url: 'https://frame.example/pair' };
  const welcome = reply(200, { success: true, account: { id: 'acc_1', name: 'Living room' }, device: { id: 'dev_1', name: 'TV' } });
  const unpaired = reply(401, { success: false, error: 'This frame is no longer paired', code: 'DEVICE_UNKNOWN' });
  const paused = reply(403, { success: false, code: 'SCREEN_PAUSED', error: 'This screen is paused.' });

  // A TV paired with a token and playing; `server.device`, `server.session` and
  // `server.other` answer from then on (a rejected promise is fetch offline)
  const playingFrame = async () => {
    const server = { device: () => welcome, session: () => reply(200, { authenticated: true }), other: () => reply(200, { success: true }) };
    const frame = openSlideshow('https://frame.example/frame', {
      token: 'dev_tok',
      answer: (url) => {
        if (url === '/api/auth/device') return server.device();
        if (url === '/api/auth/session') return server.session();
        if (url === '/api/pair/start') return reply(200, fresh);
        return server.other();
      }
    });
    frame.sandbox.slideshow = Object.assign(Object.create(frame.sandbox.PhotoFrameSlideshow.prototype), {
      folderStorage: { getCurrentFolderPath: () => '' },
      images: [frame.el('image1'), frame.el('image2')],
      currentSlide: 0,
      forgetScreen: jest.fn()
    });
    await flush();
    expect(frame.manager.isAuthenticated).toBe(true);
    expect(frame.el('authOverlay').classList.contains('hidden')).toBe(true);
    frame.el('pairCode').textContent = 'OLD-123'; // the code it was paired with
    // The session check, every 15 seconds (the newest one set)
    frame.nextCheck = () => frame.timers.filter(t => t.ms === 15 * 1000).at(-1);
    return { ...frame, server };
  };
  const token = frame => frame.sandbox.localStorage.getItem('photoframe_device_token');
  const expectPairingScreen = (frame) => {
    expect(frame.manager.isAuthenticated).toBe(false);
    expect(token(frame)).toBeNull();
    expect(frame.sandbox.slideshow.forgetScreen).toHaveBeenCalledTimes(1); // photo, notes and timers gone
    expect(frame.el('authOverlay').classList.contains('hidden')).toBe(false);
    expect(frame.requests.filter(r => r.url === '/api/pair/start')).toHaveLength(1);
    expect(frame.el('pairCode').textContent).toBe('K7P-4QX'); // a fresh code
    expect(frame.el('pairQr').innerHTML).toBe('<svg>new</svg>');
    expect(frame.el('pausedScreen').classList.contains('hidden')).toBe(true);
  };

  test.each(['DEVICE_REMOVED', 'DEVICE_UNKNOWN', 'AUTH_REQUIRED'])('a photo request with 401 %s goes straight back to pairing', async (code) => {
    const frame = await playingFrame();
    frame.server.other = () => reply(401, { code });
    // Concurrent requests from the same playing screen must only transition once.
    await Promise.all([
      frame.sandbox.slideshow.fetchRandomImage(),
      frame.sandbox.fetch('/api/notes/active')
    ]);
    await flush();
    expectPairingScreen(frame);
    expect(frame.requests.filter(r => r.url === '/api/auth/device')).toHaveLength(1); // startup only
    expect(frame.sandbox.reloaded).toBe(0);
  });

  test('a failed uploads image checks the session immediately and returns to pairing on revocation', async () => {
    const frame = await playingFrame();
    frame.server.session = () => reply(401, { code: 'DEVICE_REMOVED' });
    const loading = frame.sandbox.slideshow.loadImage({ url: 'https://frame.example/uploads/Goa/photo.png' });
    await flush();
    frame.el('image2').fire('error'); // an <img> error exposes no HTTP status
    expect(await loading).toBe(false);
    await flush();
    expect(frame.requests.filter(r => r.url === '/api/auth/session')).toHaveLength(1);
    expectPairingScreen(frame);
  });

  test('a token renewal refused during playback returns to pairing', async () => {
    const frame = await playingFrame();
    frame.server.device = () => unpaired;
    await frame.manager.requestDevice('dev_tok');
    await flush();
    expectPairingScreen(frame);
  });

  test('a note still loading during revocation cannot restart playback', async () => {
    const frame = await playingFrame();
    const slideshow = frame.sandbox.slideshow;
    slideshow.recovery = { generation: 1 };
    slideshow.forgetScreen.mockImplementation(() => { slideshow.recovery.generation += 1; });
    slideshow.resetProgress = jest.fn();
    slideshow.isPlaying = true;
    slideshow.noteScheduler = { nextDue: () => ({ showForSeconds: 10 }) };
    slideshow.scheduleNext = jest.fn();
    let finishNote;
    slideshow.showNote = () => new Promise(resolve => { finishNote = resolve; });
    const playing = slideshow.nextImage();
    frame.server.other = () => reply(401, { code: 'DEVICE_REMOVED' });
    await frame.sandbox.fetch('/api/notes/active');
    finishNote(true);
    await playing;
    await flush();
    expectPairingScreen(frame);
    expect(slideshow.scheduleNext).not.toHaveBeenCalled();
  });

  test('a 401 without a sign-out code checks the token once and pairs again if it was removed', async () => {
    const frame = await playingFrame();
    frame.server.other = () => reply(401, {});
    frame.server.device = () => unpaired;
    const res = await frame.sandbox.fetch('/api/images/next');
    expect(res.status).toBe(401); // the caller still gets its answer
    await flush();
    expect(frame.requests.filter(r => r.url === '/api/auth/device').at(-1).body).toEqual({ token: 'dev_tok' });
    expectPairingScreen(frame);
    // Then quiet: no more session checks for the screen that is gone
    const checks = frame.timers.filter(t => t.ms === 15 * 1000).length;
    await frame.sandbox.fetch('/api/images/next');
    await flush();
    expect(frame.timers.filter(t => t.ms === 15 * 1000)).toHaveLength(checks);
  });

  test('between photos, the session check every 15 seconds finds it too', async () => {
    const frame = await playingFrame();
    const check = frame.nextCheck();
    expect(check).toBeDefined();
    frame.server.session = () => reply(200, { authenticated: false });
    frame.server.device = () => unpaired;
    await check.fn();
    await flush();
    expect(frame.requests.some(r => r.url === '/api/auth/session')).toBe(true);
    expectPairingScreen(frame);
  });

  test('a session that only ran out signs in again with the token and plays on', async () => {
    const frame = await playingFrame();
    frame.server.session = () => reply(200, { authenticated: false });
    await frame.nextCheck().fn();
    await flush();
    expect(token(frame)).toBe('dev_tok');
    expect(frame.manager.isAuthenticated).toBe(true);
    expect(frame.sandbox.slideshow.forgetScreen).not.toHaveBeenCalled();
    expect(frame.nextCheck()).toBeDefined();
  });

  test.each([
    ['offline (fetch fails)', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a 503', () => reply(503, { error: 'Service unavailable' })]
  ])('%s keeps the token and keeps playing', async (name, trouble) => {
    const frame = await playingFrame();
    const checksBefore = frame.timers.filter(t => t.ms === 15 * 1000).length;
    // On the session check, on a photo request, and on the token check after a 401
    frame.server.session = trouble;
    await frame.nextCheck().fn();
    frame.server.other = trouble;
    await frame.sandbox.fetch('/api/images/next').catch(() => {});
    frame.server.other = () => reply(401, {});
    frame.server.device = trouble;
    await frame.sandbox.fetch('/api/images/next');
    await flush();
    expect(token(frame)).toBe('dev_tok');
    expect(frame.manager.isAuthenticated).toBe(true);
    expect(frame.el('authOverlay').classList.contains('hidden')).toBe(true);
    expect(frame.sandbox.slideshow.forgetScreen).not.toHaveBeenCalled();
    expect(frame.requests.some(r => r.url === '/api/pair/start')).toBe(false);
    // And it keeps checking
    expect(frame.timers.filter(t => t.ms === 15 * 1000).length).toBeGreaterThan(checksBefore);
  });

  test('SCREEN_PAUSED still shows the paused card, and is not unpaired', async () => {
    const frame = await playingFrame();
    frame.server.session = () => paused;
    frame.server.other = () => paused;
    await frame.nextCheck().fn();
    await frame.sandbox.fetch('/api/images/next');
    await flush();
    expect(frame.el('pausedScreen').classList.contains('hidden')).toBe(false);
    expect(frame.el('pausedMessage').textContent).toBe('This screen is paused.');
    expect(token(frame)).toBe('dev_tok');
    expect(frame.manager.isAuthenticated).toBe(true);
    expect(frame.sandbox.slideshow.forgetScreen).not.toHaveBeenCalled();
    expect(frame.requests.some(r => r.url === '/api/pair/start')).toBe(false);
  });

  test('signing out by hand stops the checks', async () => {
    const frame = await playingFrame();
    frame.sandbox.slideshow.cleanup = () => {};
    await frame.manager.logout();
    expect(frame.sandbox.frameSession.active).toBe(false);
  });
});

describe('A removed screen hears it from the server at once', () => {
  let app;
  let admin;

  beforeAll(async () => {
    app = createApp();
    await fs.ensureDir(path.join(testUploadsDir, 'Goa'));
    admin = request.agent(app);
    await admin.post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200);
  });

  afterAll(async () => {
    await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
  });

  test('the session check says the screen was removed right after account deletion, and the token is refused', async () => {
    const made = await admin.post('/api/access-accounts').send({ name: 'Porch', pin: '640219' }).expect(201);
    const frame = request.agent(app);
    const signedIn = await frame.post('/api/auth/pin').send({ pin: '640219' }).expect(200);
    expect(signedIn.body.token).toBeTruthy();
    // Playing: its account was just looked up, so the 30-second recheck is not due
    await frame.get('/api/folders').expect(200);
    expect((await frame.get('/api/auth/session').expect(200)).body.authenticated).toBe(true);

    await admin.delete(`/api/access-accounts/${made.body.account.id}`).expect(200);
    const session = await frame.get('/api/auth/session').expect(401);
    expect(session.body.code).toBe('DEVICE_REMOVED');
    expect(session.headers['cache-control']).toMatch(/no-store/);
    const device = await request(app).post('/api/auth/device').send({ token: signedIn.body.token }).expect(401);
    expect(device.body.code).toBe('DEVICE_UNKNOWN');
  });
});
