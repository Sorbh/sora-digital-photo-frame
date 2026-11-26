const fs = require('fs');
const path = require('path');
const vm = require('vm');
const request = require('supertest');

const html = fs.readFileSync(path.join(__dirname, '../public/slideshow.html'), 'utf8');
const headScript = /<head>[\s\S]*?<script>([\s\S]*?)<\/script>/.exec(html)[1];

// Runs slideshow.html's first script, then the slideshow's sign-in class, in a bare
// sandbox opened at the given address. fetchPin answers each PIN request.
function openSlideshow(href, { fetchPin = () => new Promise(() => {}), headScriptRuns = true } = {}) {
  const element = () => new Proxy({}, {
    get: (target, prop) => {
      if (prop in target) return target[prop];
      if (prop === 'classList') return { add() {}, remove() {}, contains: () => true };
      if (prop === 'dataset' || prop === 'style') return {};
      if (prop === 'value' || prop === 'textContent' || prop === 'innerHTML') return '';
      return () => {};
    },
    set: (target, prop, value) => { target[prop] = value; return true; }
  });
  const requests = [];
  const timers = [];
  const listeners = {};
  const history = [];
  const store = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
  const sandbox = {
    URL,
    URLSearchParams,
    console: { log() {}, error: (...a) => process.env.DEBUG_VM && process.stderr.write(a.map(String).join(' ') + '\n'), warn() {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    location: { href, search: new URL(href).search, hash: new URL(href).hash },
    localStorage: store(),
    sessionStorage: store(),
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    i18n: { error: (data, key) => key },
    document: {
      getElementById: element,
      querySelector: element,
      querySelectorAll: () => [],
      addEventListener() {},
      dispatchEvent() {},
      documentElement: { dataset: {} }
    },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    fetch: (url, options) => {
      if (url !== '/api/auth/pin') return new Promise(() => {}); // pairing etc.: never answers
      const body = options?.body ? JSON.parse(options.body) : null;
      requests.push({ url, body });
      return fetchPin(body);
    },
    t: key => key
  };
  sandbox.window = sandbox;
  sandbox.history = {
    state: null,
    replaceState(state, title, url) {
      const next = new URL(url, sandbox.location.href);
      history.push(next.href);
      sandbox.location.href = next.href;
      sandbox.location.search = next.search;
      sandbox.location.hash = next.hash;
    }
  };
  const context = vm.createContext(sandbox);
  if (headScriptRuns) vm.runInContext(headScript, context);
  const addressAfterHead = sandbox.location.href;
  const source = fs.readFileSync(path.join(__dirname, '../public/js/slideshow.js'), 'utf8');
  const auth = source.slice(0, source.indexOf('class PhotoFrameSlideshow'));
  vm.runInContext(`${auth}\nthis.manager = new AuthenticationManager();`, context);
  const navigate = (next) => {
    sandbox.location.href = next;
    sandbox.location.search = new URL(next).search;
    sandbox.location.hash = new URL(next).hash;
    listeners.hashchange?.();
  };
  return { location: sandbox.location, addressAfterHead, requests, timers, manager: sandbox.manager, localStorage: sandbox.localStorage, navigate };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const answer = (status, body) => Promise.resolve({ status, json: async () => body });

describe('Slideshow sign-in from the address', () => {
  test('the address is cleaned before any stylesheet or script loads', () => {
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
    const cleanup = head.indexOf('<script>');
    expect(cleanup).toBeGreaterThan(-1);
    expect(cleanup).toBeLessThan(head.indexOf('<link'));
    expect(head.indexOf('<meta name="referrer" content="no-referrer">')).toBeGreaterThan(-1);
    expect(head.indexOf('<meta name="referrer"')).toBeLessThan(head.indexOf('<link'));

    const { addressAfterHead } = openSlideshow('https://frame.example/slideshow?pin=123456&family=ABCD-EFGH&lang=de#x');
    expect(addressAfterHead).toBe('https://frame.example/slideshow?lang=de#x');
  });

  test('signs in with the PIN and family code kept in memory', () => {
    const { location, requests } = openSlideshow('https://frame.example/slideshow?pin=123456&family=ABCD-EFGH&lang=de#x');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/api/auth/pin');
    expect(requests[0].body).toMatchObject({ pin: '123456', familyCode: 'ABCD-EFGH' });
    expect(location.href).toBe('https://frame.example/slideshow?lang=de#x');
  });

  test('keeps the family code for a later typed PIN', () => {
    const { manager } = openSlideshow('https://frame.example/slideshow?family=ABCD-EFGH');
    expect(manager.familyCodeValue()).toBe('ABCD-EFGH');
  });

  test('leaves an address without sign-in details as it is', () => {
    const { location } = openSlideshow('https://frame.example/slideshow?lang=de');
    expect(location.href).toBe('https://frame.example/slideshow?lang=de');
  });

  test('tries again after a network or server failure, with the PIN from memory', async () => {
    const answers = [
      () => Promise.reject(new Error('offline')),
      () => answer(502, {}),
      () => answer(200, { success: true, account: { name: 'Grandma' } })
    ];
    const { requests, timers, manager } = openSlideshow('https://frame.example/slideshow?pin=123456', { fetchPin: () => answers.shift()() });
    for (let i = 0; i < 2; i += 1) {
      await flush();
      const retry = timers.filter(t => t.fn.toString().includes('signInFromUrl')).pop();
      expect(retry).toBeTruthy();
      timers.length = 0;
      retry.fn();
    }
    await flush();
    expect(requests.map(r => r.body.pin)).toEqual(['123456', '123456', '123456']);
    expect(manager.isAuthenticated).toBe(true);
  });

  test('takes the PIN from the #fragment, which never reaches the server', () => {
    const { addressAfterHead, requests } = openSlideshow('https://frame.example/slideshow?lang=de#pin=246810&family=QWER-TYUI');
    expect(addressAfterHead).toBe('https://frame.example/slideshow?lang=de');
    expect(requests[0].body).toMatchObject({ pin: '246810', familyCode: 'QWER-TYUI' });
  });

  test('reads #pin= itself when the head script was blocked', () => {
    const { location, requests } = openSlideshow('https://frame.example/slideshow?lang=de#pin=246810&family=QWER-TYUI', { headScriptRuns: false });
    expect(requests[0].body).toMatchObject({ pin: '246810', familyCode: 'QWER-TYUI' });
    expect(location.href).toBe('https://frame.example/slideshow?lang=de');
  });

  test('a #pin= opened on the page already showing reads it and clears it', async () => {
    const { location, requests, navigate } = openSlideshow('https://frame.example/slideshow');
    expect(requests).toHaveLength(0);
    navigate('https://frame.example/slideshow#pin=135791');
    expect(requests.map(r => r.body.pin)).toEqual(['135791']);
    expect(location.href).toBe('https://frame.example/slideshow');
  });

  test('a PIN typed by hand wins over a sign-in from the address still under way', async () => {
    let answerUrl;
    const answers = [
      () => new Promise(resolve => { answerUrl = resolve; }),
      () => answer(200, { success: true, token: 'typed-token', account: { name: 'Typed' } })
    ];
    const { manager, localStorage } = openSlideshow('https://frame.example/slideshow?pin=123456', { fetchPin: () => answers.shift()() });
    manager.pinInput.value = '654321';
    await manager.authenticate();
    expect(manager.userAccount.name).toBe('Typed');
    answerUrl({ status: 200, json: async () => ({ success: true, token: 'url-token', account: { name: 'From address' } }) });
    await flush();
    expect(manager.userAccount.name).toBe('Typed');
    expect(localStorage.getItem('photoframe_device_token')).toBe('typed-token');
  });

  test('keeps trying after a lockout, once it lifts', async () => {
    const answers = [
      () => answer(429, { success: false, code: 'RATE_LIMITED', error: 'Too many', remainingTime: 15 }),
      () => answer(200, { success: true, account: { name: 'Grandma' } })
    ];
    const { timers, manager } = openSlideshow('https://frame.example/slideshow?pin=123456', { fetchPin: () => answers.shift()() });
    await flush();
    const retry = timers.filter(t => t.fn.toString().includes('signInFromUrl')).pop();
    expect(retry.ms).toBeGreaterThanOrEqual(15 * 60000);
    retry.fn();
    await flush();
    expect(manager.isAuthenticated).toBe(true);
  });

  test('does not try again when the PIN is refused', async () => {
    const { requests, timers } = openSlideshow('https://frame.example/slideshow?pin=123456', {
      fetchPin: () => answer(401, { success: false, code: 'INVALID_PIN', error: 'Invalid PIN' })
    });
    await flush();
    expect(timers.filter(t => t.fn.toString().includes('signInFromUrl'))).toHaveLength(0);
    expect(requests).toHaveLength(1);
  });
});

describe('The slideshow page', () => {
  test('tells the browser never to send its address on', async () => {
    process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
    const { createApp } = require('../app');
    const res = await request(createApp()).get('/slideshow?pin=123456').expect(200);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });
});
