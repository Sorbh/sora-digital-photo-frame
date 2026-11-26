// The /pair page itself (public/js/pair.js), run against a small stand-in for the browser
// and, at the end, against the real server from a typed code to a paired frame
const path = require('path');
const vm = require('vm');
const request = require('supertest');
const fs = require('fs-extra');

// The end-to-end test at the bottom runs the page against the real server, in throwaway folders
const testUploadsDir = path.join(__dirname, 'pair-page-uploads');
const testCacheDir = path.join(__dirname, 'pair-page-cache');
const testDataDir = path.join(__dirname, 'pair-page-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'test-admin-pass';

// The page's own script, after the shared flow it uses (js/pairFlow.js), as pair.html loads them
const source = ['pairFlow.js', 'pair.js'].map(file => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', file), 'utf8')).join('\n');
// Waits for the page to get somewhere that goes through the real server (not just promises)
const waitFor = async (done) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(done()).toBe(true);
};
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

function fakeElement() {
  const listeners = {};
  const classes = new Set();
  const element = {
    value: '', textContent: '', innerHTML: '', checked: false, disabled: false, children: [],
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name))
    },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    fire: (type) => listeners[type]?.({ preventDefault() {} }),
    focus() {},
    appendChild(child) { element.children.push(child); },
    querySelector: () => (element.innerHTML ? fakeElement() : null),
    querySelectorAll: () => [],
    get outerHTML() { return `<span>${element.textContent}</span>`; }
  };
  return element;
}

// The tab's sessionStorage, kept across reloads and sign-ins in the tests
function fakeStorage() {
  const items = new Map();
  return {
    getItem: key => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: key => items.delete(key),
    items
  };
}

// Opens /pair (with ?code= if given); `answer(url, options)` is the server.
// `fetch` replaces the stand-in server with a real one; `account` is the account
// ticked on the form.
function openPage(search, answer, { storage = fakeStorage(), fetch, account } = {}) {
  const elements = {};
  const requests = [];
  // The two "Type a code" links
  const links = [0, 1].map(() => {
    const listeners = {};
    const link = { href: '/pair', addEventListener: (type, fn) => { listeners[type] = fn; } };
    link.click = () => {
      const event = { defaultPrevented: false, preventDefault() { event.defaultPrevented = true; } };
      listeners.click?.(event);
      return event;
    };
    return link;
  });
  const location = { search, pathname: '/pair', href: '' };
  const sandbox = {
    document: {
      getElementById: id => (elements[id] = elements[id] || fakeElement()),
      createElement: () => fakeElement(),
      querySelector: selector => (account && selector === 'input[name="account"]:checked' ? { value: account } : null),
      querySelectorAll: selector => (selector === 'a[href="/pair"]' ? links : [])
    },
    sessionStorage: storage,
    window: { addEventListener() {} },
    location,
    history: { replaceState: (_, __, url) => { location.search = url.slice(url.indexOf('?')); } },
    matchMedia: () => ({ matches: false }),
    URLSearchParams,
    console: { error() {} },
    t: key => key,
    i18n: { error: (_, key) => key },
    fetch: fetch ? (url, options) => { requests.push(url); return fetch(url, options); } : async (url) => {
      requests.push(url);
      const reply = await answer(url);
      return { ok: reply.status < 400, status: reply.status, json: async () => (reply.body === undefined ? Promise.reject(new SyntaxError('not JSON')) : reply.body) };
    }
  };
  vm.runInNewContext(source, sandbox);
  const visible = () => ['stateLoading', 'stateEnter', 'stateExpired', 'stateUnreachable', 'pairForm', 'stateDone']
    .filter(id => elements[id] && !elements[id].classList.contains('hidden'));
  return { el: sandbox.document.getElementById, requests, location, visible, links, storage };
}

const library = (code, accounts = []) => url => {
  if (url.startsWith('/api/admin/pair/')) {
    return decodeURIComponent(url.split('/').pop()) === code
      ? { status: 200, body: { success: true, code, approved: false } }
      : { status: 404, body: { success: false, code: 'PAIRING_EXPIRED' } };
  }
  if (url === '/api/access-accounts') return { status: 200, body: { accounts } };
  if (url === '/api/folders') return { status: 200, body: { folders: [] } };
  throw new Error(`unexpected ${url}`);
};

describe('The /pair page', () => {
  test('without a code, it asks for one instead of saying it expired', async () => {
    const page = openPage('', library('K7P4QX'));
    await flush();
    expect(page.visible()).toEqual(['stateEnter']);
    expect(page.requests).toEqual([]);
  });

  test.each([['K7P-4QX'], ['k7p4qx'], [' k7p - 4qx ']])('the code typed as %j reaches the pairing form', async (typed) => {
    const page = openPage('', library('K7P4QX'));
    page.el('codeInput').value = typed;
    page.el('stateEnter').fire('submit');
    await flush();
    expect(page.requests[0]).toBe('/api/admin/pair/K7P4QX');
    expect(page.location.search).toBe(''); // kept aside, not in the address
    expect(page.storage.items.get('sora_pair_code')).toBe('K7P4QX');
    expect(page.requests.slice(1).sort()).toEqual(['/api/access-accounts', '/api/folders']);
    expect(page.visible()).toEqual(['pairForm']);
    expect(page.el('codeShown').textContent).toBe('K7P-4QX');
  });

  test('a code that is too short is caught on the phone, with a message', async () => {
    const page = openPage('', library('K7P4QX'));
    page.el('codeInput').value = 'K7P';
    page.el('stateEnter').fire('submit');
    await flush();
    expect(page.requests).toEqual([]);
    expect(page.el('codeError').classList.contains('hidden')).toBe(false);
    expect(page.visible()).toEqual(['stateEnter']);
  });

  test('a code the server does not know shows the expired screen', async () => {
    const page = openPage('', library('K7P4QX'));
    page.el('codeInput').value = 'ZZZ-ZZZ';
    page.el('stateEnter').fire('submit');
    await flush();
    expect(page.visible()).toEqual(['stateExpired']);
  });

  test.each([
    ['a 503', () => ({ status: 503, body: { success: false } })],
    ['a proxy error page', () => ({ status: 502 })],
    ['no connection', () => { throw new TypeError('Failed to fetch'); }]
  ])('%s is not "expired": the phone can try the same code again', async (_, failure) => {
    let down = true;
    const working = library('K7P4QX');
    const page = openPage('?code=K7P4QX', url => (down ? failure(url) : working(url)));
    await flush();
    expect(page.visible()).toEqual(['stateUnreachable']);

    down = false;
    page.el('retryCheck').fire('click');
    await flush();
    expect(page.visible()).toEqual(['pairForm']);
  });

  test("a proxy's own 404 page is not the server saying the code expired", async () => {
    const page = openPage('?code=K7P4QX', () => ({ status: 404 }));
    await flush();
    expect(page.visible()).toEqual(['stateUnreachable']);
  });

  test('with no accounts yet, a folder list that is not JSON (a sign-in page, say) stops before the form', async () => {
    const working = library('K7P4QX');
    const page = openPage('?code=K7P4QX', url => (url === '/api/folders' ? { status: 200 } : working(url)));
    await flush();
    // Going on would offer a new account "every folder" by mistake
    expect(page.visible()).toEqual(['stateUnreachable']);
  });

  test('a failed folder list still lets the frame join an existing account, but not a new one', async () => {
    const working = library('K7P4QX', [{ id: 'acc_1', name: 'Kitchen', assignedFolders: ['Goa'] }]);
    const page = openPage('?code=K7P4QX', url => (url === '/api/folders' ? { status: 500, body: { success: false } } : working(url)));
    await flush();
    expect(page.visible()).toEqual(['pairForm']);
    // Where the folders would be, it says why a new account has to wait
    expect(page.el('folderList').innerHTML).toContain('pair.foldersFailed');
  });

  test('a refusal (the plan\'s screen limit, say) is brought into view and focused, not left under the button', async () => {
    const working = library('K7P4QX', [{ id: 'acc_1', name: 'Kitchen', assignedFolders: [] }]);
    const page = openPage('?code=K7P4QX', url => (url.endsWith('/approve')
      ? { status: 403, body: { success: false, code: 'SCREEN_LIMIT', message: 'Your plan allows 1 screen.' } }
      : working(url)), { account: 'acc_1' });
    await flush();
    const error = page.el('pairError');
    const seen = { focused: 0, scrolled: 0 };
    error.focus = () => { seen.focused += 1; };
    error.scrollIntoView = () => { seen.scrolled += 1; };
    page.el('frameName').value = 'Hall TV';
    page.el('pairForm').fire('submit');
    await flush();
    expect(error.classList.contains('hidden')).toBe(false);
    expect(seen).toEqual({ focused: 1, scrolled: 1 });
  });

  test('"Type a code" keeps the chosen language', async () => {
    const page = openPage('?lang=ar', library('K7P4QX'));
    await flush();
    expect(page.links.map(link => link.href)).toEqual(['/pair?lang=ar', '/pair?lang=ar']);
  });

  test('a reload comes back to the typed code', async () => {
    const page = openPage('?lang=ar', library('K7P4QX'));
    page.el('codeInput').value = 'k7p-4qx';
    page.el('stateEnter').fire('submit');
    await flush();
    expect(page.location.search).toBe('?lang=ar');

    const reloaded = openPage('?lang=ar', library('K7P4QX'), { storage: page.storage });
    await flush();
    expect(reloaded.requests[0]).toBe('/api/admin/pair/K7P4QX');
    expect(reloaded.visible()).toEqual(['pairForm']);
  });

  test('signed out while typing a code: the code stays out of the sign-in address, and comes back after', async () => {
    let signedIn = false;
    const working = library('K7P4QX');
    const server = url => (signedIn ? working(url) : { status: 401, body: { success: false } });
    const page = openPage('?lang=ar', server);
    page.el('codeInput').value = 'K7P-4QX';
    page.el('stateEnter').fire('submit');
    await flush();
    expect(page.location.href).toBe('/login?next=%2Fpair%3Flang%3Dar');
    expect(page.location.href).not.toContain('K7P');

    // Back from the sign-in page (/pair?lang=ar, the same tab)
    signedIn = true;
    const back = openPage('?lang=ar', server, { storage: page.storage });
    await flush();
    expect(back.requests[0]).toBe('/api/admin/pair/K7P4QX');
    expect(back.visible()).toEqual(['pairForm']);
  });

  test('a code from the QR address is kept out of the sign-in address too', async () => {
    const page = openPage('?code=K7P4QX', () => ({ status: 401, body: { success: false } }));
    await flush();
    expect(page.location.href).toBe('/login?next=%2Fpair');
    expect(page.storage.items.get('sora_pair_code')).toBe('K7P4QX');
  });

  test('"Type a code" after a failed check forgets that code and asks for another', async () => {
    let down = true;
    const working = library('K7P4QX');
    const server = url => (down ? { status: 503, body: { success: false } } : working(url));
    const page = openPage('', server);
    page.el('codeInput').value = 'ABC-234';
    page.el('stateEnter').fire('submit');
    await flush();
    expect(page.visible()).toEqual(['stateUnreachable']);

    expect(page.links[1].click().defaultPrevented).toBe(true); // no reload that would check it again
    expect(page.visible()).toEqual(['stateEnter']);
    expect(page.storage.items.has('sora_pair_code')).toBe(false);

    // A reload now asks for a code too, and the next one typed is the one checked
    const reloaded = openPage('', server, { storage: page.storage });
    await flush();
    expect(reloaded.visible()).toEqual(['stateEnter']);
    expect(reloaded.requests).toEqual([]);
    down = false;
    page.el('codeInput').value = 'K7P-4QX';
    page.el('stateEnter').fire('submit');
    await flush();
    expect(page.requests.at(-3)).toBe('/api/admin/pair/K7P4QX');
    expect(page.visible()).toEqual(['pairForm']);
  });

  test('"Type a code" from a QR address takes the code out of it', async () => {
    const page = openPage('?code=K7P4QX&lang=ar', () => ({ status: 503, body: { success: false } }));
    await flush();
    page.links[0].click();
    expect(page.location.search).toBe('?lang=ar');
    expect(page.visible()).toEqual(['stateEnter']);
  });

  test('an expired code is forgotten, so "Type a code" starts afresh', async () => {
    const page = openPage('', library('K7P4QX'));
    page.el('codeInput').value = 'ZZZ-ZZZ';
    page.el('stateEnter').fire('submit');
    await flush();
    expect(page.visible()).toEqual(['stateExpired']);
    expect(page.storage.items.has('sora_pair_code')).toBe(false);
  });

  test('losing the connection while loading the accounts is not "expired" either', async () => {
    const working = library('K7P4QX');
    const page = openPage('?code=K7P4QX', url => {
      if (url === '/api/folders') throw new TypeError('Failed to fetch');
      return working(url);
    });
    await flush();
    expect(page.visible()).toEqual(['stateUnreachable']);
  });
});

describe('The /pair page against the real server', () => {
  let app;
  let admin;

  beforeAll(async () => {
    await fs.ensureDir(path.join(testUploadsDir, 'Goa'));
    app = require('../server');
    admin = request.agent(app);
    await admin.post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200);
  });

  afterAll(async () => {
    await fs.remove(testUploadsDir);
    await fs.remove(testCacheDir);
    await fs.remove(testDataDir);
  });

  // The phone's browser: the admin's signed-in session
  const phone = async (url, { method = 'GET', headers = {}, body } = {}) => {
    let call = admin[method.toLowerCase()](url).set(headers);
    if (body !== undefined) call = call.send(body);
    const res = await call;
    return { ok: res.status < 400, status: res.status, json: async () => res.body };
  };

  test('a code typed off the frame pairs it, and the frame signs in', async () => {
    const frame = request.agent(app);
    const pairing = (await frame.post('/api/pair/start').expect(200)).body;

    // Typed by hand, as the frame shows it
    const page = openPage('', null, { fetch: phone, account: '__new__' });
    page.el('codeInput').value = `${pairing.code.slice(0, 3).toLowerCase()}-${pairing.code.slice(3)}`;
    page.el('stateEnter').fire('submit');
    await flush();
    await waitFor(() => page.visible()[0] === 'pairForm');
    expect(page.el('codeShown').textContent).toBe(`${pairing.code.slice(0, 3)}-${pairing.code.slice(3)}`);

    page.el('frameName').value = 'Hall frame';
    page.el('pairForm').fire('submit');
    await waitFor(() => page.visible()[0] === 'stateDone');
    expect(page.el('doneTitle').innerHTML).toBe('pair.donePaired');
    expect(page.storage.items.has('sora_pair_code')).toBe(false);

    // The frame hears it was approved, collects its sign-in and is in
    const polled = await frame.post('/api/pair/status').send({ code: pairing.code, secret: pairing.secret }).expect(200);
    expect(polled.body.status).toBe('ready');
    const collected = await frame.post('/api/pair/collect').send({ code: pairing.code, secret: pairing.secret }).expect(200);
    expect(collected.body).toMatchObject({ status: 'approved', device: { name: 'Hall frame' }, account: { name: 'Hall frame' } });
    const session = await frame.get('/api/auth/session').expect(200);
    expect(session.body).toMatchObject({ authenticated: true, account: { name: 'Hall frame' } });
  });
});
