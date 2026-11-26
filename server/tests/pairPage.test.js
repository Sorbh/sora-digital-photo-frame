// The /pair page itself (public/js/pair.js), run against a small stand-in for the browser
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'pair.js'), 'utf8');
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
    get outerHTML() { return `<span>${element.textContent}</span>`; }
  };
  return element;
}

// Opens /pair (with ?code= if given); `answer(url)` is the server
function openPage(search, answer) {
  const elements = {};
  const requests = [];
  const location = { search, pathname: '/pair', href: '' };
  const sandbox = {
    document: {
      getElementById: id => (elements[id] = elements[id] || fakeElement()),
      createElement: () => fakeElement(),
      querySelector: () => null,
      querySelectorAll: () => []
    },
    window: { addEventListener() {} },
    location,
    history: { replaceState: (_, __, url) => { location.search = url.slice(url.indexOf('?')); } },
    matchMedia: () => ({ matches: false }),
    URLSearchParams,
    console: { error() {} },
    t: key => key,
    i18n: { error: (_, key) => key },
    fetch: async (url) => {
      requests.push(url);
      const reply = await answer(url);
      return { ok: reply.status < 400, status: reply.status, json: async () => (reply.body === undefined ? Promise.reject(new SyntaxError('not JSON')) : reply.body) };
    }
  };
  vm.runInNewContext(source, sandbox);
  const visible = () => ['stateLoading', 'stateEnter', 'stateExpired', 'stateUnreachable', 'pairForm', 'stateDone']
    .filter(id => elements[id] && !elements[id].classList.contains('hidden'));
  return { el: sandbox.document.getElementById, requests, location, visible };
}

const library = code => url => {
  if (url.startsWith('/api/admin/pair/')) {
    return decodeURIComponent(url.split('/').pop()) === code
      ? { status: 200, body: { success: true, code, approved: false } }
      : { status: 404, body: { success: false, code: 'PAIRING_EXPIRED' } };
  }
  if (url === '/api/access-accounts') return { status: 200, body: { accounts: [] } };
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
    expect(page.location.search).toBe('?code=K7P4QX');
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

  test('a folder list that is not JSON (a sign-in page, say) stops before the form', async () => {
    const working = library('K7P4QX');
    const page = openPage('?code=K7P4QX', url => (url === '/api/folders' ? { status: 200 } : working(url)));
    await flush();
    // Going on would offer a new account "every folder" by mistake
    expect(page.visible()).toEqual(['stateUnreachable']);
  });

  test('the chosen language stays in the address after typing a code', async () => {
    const page = openPage('?lang=ar', library('K7P4QX'));
    page.el('codeInput').value = 'k7p-4qx';
    page.el('stateEnter').fire('submit');
    await flush();
    expect(new URLSearchParams(page.location.search).get('lang')).toBe('ar');
    expect(new URLSearchParams(page.location.search).get('code')).toBe('K7P4QX');
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
