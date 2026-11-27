const fs = require('fs');
const path = require('path');
const vm = require('vm');
const request = require('supertest');

const html = fs.readFileSync(path.join(__dirname, '../public/slideshow.html'), 'utf8');
const headScript = /<head>[\s\S]*?<script>([\s\S]*?)<\/script>/.exec(html)[1];

// Runs slideshow.html's first script, then the slideshow's sign-in class, in a bare
// sandbox opened at the given address. fetchPin answers each PIN request; an
// answer with a cookie sets it as it arrives, unless the request was aborted
// first, as a browser does with Set-Cookie.
// fetchOther answers the rest (pairing...), by default never. Elements keep
// their event listeners, so the page's own handlers can be driven.
function openSlideshow(href, { fetchPin = () => new Promise(() => {}), fetchOther = () => new Promise(() => {}), headScriptRuns = true } = {}) {
  const element = (extra = {}) => {
    const listeners = {};
    return new Proxy({ ...extra }, {
      get: (target, prop) => {
        if (prop in target) return target[prop];
        if (prop === 'classList') return { add() {}, remove() {}, toggle() {}, contains: () => true };
        if (prop === 'dataset' || prop === 'style') return {};
        if (prop === 'value' || prop === 'textContent' || prop === 'innerHTML') return '';
        if (prop === 'disabled') return false;
        if (prop === 'addEventListener') return (type, fn) => { (listeners[type] ||= []).push(fn); };
        if (prop === 'dispatchEvent') return (event) => { (listeners[event.type] || []).forEach(fn => fn(event)); return true; };
        return () => {};
      },
      set: (target, prop, value) => { target[prop] = value; return true; }
    });
  };
  const keypad = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'back'].map(key => element({ dataset: { key } }));
  const requests = [];
  const timers = [];
  const listeners = {};
  const history = [];
  const cookies = { session: null };
  const store = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
  const sandbox = {
    URL,
    URLSearchParams,
    AbortController,
    Event,
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
      getElementById: () => element(),
      querySelector: () => element(),
      querySelectorAll: selector => (selector === '.keypad [data-key]' ? keypad : []),
      addEventListener() {},
      dispatchEvent() {},
      documentElement: { dataset: {} }
    },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    fetch: (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : null;
      const signal = options?.signal;
      if (url === '/api/auth/pin') requests.push({ url, body, signal });
      return new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
        const reply = url === '/api/auth/pin' ? fetchPin(body) : fetchOther(url, body);
        Promise.resolve(reply).then((reply) => {
          if (signal?.aborted) return; // dropped by the browser, its cookie too
          if (reply?.cookie) cookies.session = reply.cookie;
          resolve(reply);
        }, reject);
      });
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
  return { location: sandbox.location, addressAfterHead, requests, timers, manager: sandbox.manager, localStorage: sandbox.localStorage, navigate, cookies, keypad };
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

    const { addressAfterHead } = openSlideshow('https://frame.example/frame?lang=de#pin=123456&family=ABCD-EFGH&view=1');
    expect(addressAfterHead).toBe('https://frame.example/frame?lang=de#view=1');
  });

  test('signs in with the PIN and family code kept in memory', () => {
    const { location, requests } = openSlideshow('https://frame.example/frame?lang=de#pin=123456&family=ABCD-EFGH&view=1');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/api/auth/pin');
    expect(requests[0].body).toMatchObject({ pin: '123456', familyCode: 'ABCD-EFGH' });
    expect(location.href).toBe('https://frame.example/frame?lang=de#view=1');
  });

  test('keeps the family code for a later typed PIN', () => {
    const { manager } = openSlideshow('https://frame.example/frame#family=ABCD-EFGH');
    expect(manager.familyCodeValue()).toBe('ABCD-EFGH');
  });

  test.each([true, false])('a ?pin= or ?family= in the query is taken out of the address and not used (head script runs: %s)', (headScriptRuns) => {
    const { location, requests, manager, localStorage } = openSlideshow(
      'https://frame.example/frame?pin=123456&family=ABCD-EFGH&lang=de#x', { headScriptRuns });
    expect(location.href).toBe('https://frame.example/frame?lang=de#x');
    expect(requests).toHaveLength(0);
    expect(manager.familyCodeValue()).toBe('');
    expect(localStorage.getItem('photoframe_family_code')).toBeNull();
  });

  test('leaves an address without sign-in details as it is', () => {
    const { location } = openSlideshow('https://frame.example/frame?lang=de');
    expect(location.href).toBe('https://frame.example/frame?lang=de');
  });

  test('tries again after a network or server failure, with the PIN from memory', async () => {
    const answers = [
      () => Promise.reject(new Error('offline')),
      () => answer(502, {}),
      () => answer(200, { success: true, account: { name: 'Grandma' } })
    ];
    const { requests, timers, manager } = openSlideshow('https://frame.example/frame#pin=123456', { fetchPin: () => answers.shift()() });
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
    const { addressAfterHead, requests } = openSlideshow('https://frame.example/frame?lang=de#pin=246810&family=QWER-TYUI');
    expect(addressAfterHead).toBe('https://frame.example/frame?lang=de');
    expect(requests[0].body).toMatchObject({ pin: '246810', familyCode: 'QWER-TYUI' });
  });

  test('reads #pin= itself when the head script was blocked', () => {
    const { location, requests } = openSlideshow('https://frame.example/frame?lang=de#pin=246810&family=QWER-TYUI', { headScriptRuns: false });
    expect(requests[0].body).toMatchObject({ pin: '246810', familyCode: 'QWER-TYUI' });
    expect(location.href).toBe('https://frame.example/frame?lang=de');
  });

  test('a #pin= opened on the page already showing reads it and clears it', async () => {
    const { location, requests, navigate } = openSlideshow('https://frame.example/frame');
    expect(requests).toHaveLength(0);
    navigate('https://frame.example/frame#pin=135791');
    expect(requests.map(r => r.body.pin)).toEqual(['135791']);
    expect(location.href).toBe('https://frame.example/frame');
  });

  test('a PIN typed by hand wins over a sign-in from the address still under way', async () => {
    let answerUrl;
    const answers = [
      () => new Promise(resolve => { answerUrl = resolve; }),
      () => answer(200, { success: true, token: 'typed-token', account: { name: 'Typed' } })
    ];
    const { manager, localStorage } = openSlideshow('https://frame.example/frame#pin=123456', { fetchPin: () => answers.shift()() });
    manager.pinInput.value = '654321';
    await manager.authenticate();
    expect(manager.userAccount.name).toBe('Typed');
    answerUrl({ status: 200, json: async () => ({ success: true, token: 'url-token', account: { name: 'From address' } }) });
    await flush();
    expect(manager.userAccount.name).toBe('Typed');
    expect(localStorage.getItem('photoframe_device_token')).toBe('typed-token');
  });

  test("a late reply to the sign-in from the address can't replace the session of a PIN typed meanwhile", async () => {
    let answerUrl;
    const answers = [
      () => new Promise(resolve => { answerUrl = resolve; }),
      () => answer(200, { success: true, token: 'typed-token', account: { name: 'Typed' } }).then(r => ({ ...r, cookie: 'typed-session' }))
    ];
    const { manager, requests, cookies } = openSlideshow('https://frame.example/frame#pin=123456', { fetchPin: () => answers.shift()() });
    manager.pinInput.value = '654321';
    await manager.authenticate();
    // Typing the PIN stopped the request from the address before its reply came
    expect(requests[0].signal.aborted).toBe(true);
    expect(requests[1].signal).toBeUndefined();
    expect(cookies.session).toBe('typed-session');
    answerUrl({ status: 200, cookie: 'url-session', json: async () => ({ success: true, token: 'url-token', account: { name: 'From address' } }) });
    await flush();
    expect(cookies.session).toBe('typed-session');
    expect(manager.userAccount.name).toBe('Typed');
  });

  const lateUrlReply = () => ({ status: 200, cookie: 'url-session', json: async () => ({ success: true, token: 'url-token', account: { name: 'From address' } }) });

  test.each([
    ['the keypad', ({ keypad }) => keypad[4].dispatchEvent({ type: 'click' })],
    ['the keyboard', ({ manager }) => { manager.pinInput.value = '5'; manager.pinInput.dispatchEvent(new Event('input')); }],
    ['the family code field', ({ manager }) => { manager.familyInput.value = 'A'; manager.familyInput.dispatchEvent(new Event('input')); }]
  ])('starting to type on %s stops the sign-in from the address, so it cannot hide the form', async (_, type) => {
    let answerUrl;
    const page = openSlideshow('https://frame.example/frame#pin=123456', { fetchPin: () => new Promise(resolve => { answerUrl = resolve; }) });
    type(page);
    expect(page.requests[0].signal.aborted).toBe(true);
    answerUrl(lateUrlReply());
    await flush();
    expect(page.cookies.session).toBeNull();
    expect(page.manager.isAuthenticated).toBe(false);
    expect(page.localStorage.getItem('photoframe_device_token')).toBeNull();
  });

  test('a frame paired by QR code keeps its sign-in while it shows "paired" before the slideshow', async () => {
    let answerUrl;
    const fetchOther = (url) => {
      if (url.startsWith('/api/pair/status')) return answer(200, { status: 'ready' });
      if (url === '/api/pair/collect') {
        return answer(200, { status: 'approved', token: 'pair-token', device: { name: 'Kitchen' }, account: { name: 'Paired' } })
          .then(reply => ({ ...reply, cookie: 'pair-session' }));
      }
      return new Promise(() => {});
    };
    const { manager, requests, cookies, timers, localStorage } = openSlideshow('https://frame.example/frame#pin=123456', {
      fetchPin: () => new Promise(resolve => { answerUrl = resolve; }),
      fetchOther
    });
    manager.pairing = { code: 'ABC123', secret: 's', expiresAt: Date.now() + 60000 };
    await manager.checkPairing();
    expect(cookies.session).toBe('pair-session');
    expect(requests[0].signal.aborted).toBe(true);
    // The address's reply lands while "paired" shows, before the 700 ms are up
    answerUrl(lateUrlReply());
    await flush();
    expect(cookies.session).toBe('pair-session');
    expect(localStorage.getItem('photoframe_device_token')).toBe('pair-token');
    expect(manager.isAuthenticated).toBe(false);
    const show = timers.find(t => t.ms === 700);
    expect(show).toBeDefined();
    show.fn();
    expect(manager.userAccount.name).toBe('Paired');
  });

  test('signing in another way meanwhile stops the request from the address too', async () => {
    const { manager, requests, timers } = openSlideshow('https://frame.example/frame#pin=123456');
    manager.handleAuthSuccess({ name: 'Paired' });
    expect(requests[0].signal.aborted).toBe(true);
    await flush();
    // An aborted request is not a failure to try again after
    expect(timers.filter(t => t.fn.toString().includes('signInFromUrl'))).toHaveLength(0);
    expect(manager.userAccount.name).toBe('Paired');
  });

  test('a new #pin= opened on the page replaces one still waiting for its reply', async () => {
    const { requests, navigate } = openSlideshow('https://frame.example/frame#pin=111111');
    navigate('https://frame.example/frame#pin=222222');
    expect(requests.map(r => r.body.pin)).toEqual(['111111', '222222']);
    expect(requests[0].signal.aborted).toBe(true);
    expect(requests[1].signal.aborted).toBe(false);
  });

  test('keeps trying after a lockout, once it lifts', async () => {
    const answers = [
      () => answer(429, { success: false, code: 'RATE_LIMITED', error: 'Too many', remainingTime: 15 }),
      () => answer(200, { success: true, account: { name: 'Grandma' } })
    ];
    const { timers, manager } = openSlideshow('https://frame.example/frame#pin=123456', { fetchPin: () => answers.shift()() });
    await flush();
    // The form's own lockout wait tries the same PIN again when it ends
    const retry = timers.filter(t => t.ms >= 15 * 60000).pop();
    expect(retry).toBeDefined();
    retry.fn();
    await flush();
    expect(manager.isAuthenticated).toBe(true);
  });

  test('does not try again when the PIN is refused', async () => {
    const { requests, timers } = openSlideshow('https://frame.example/frame#pin=123456', {
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
    const res = await request(createApp()).get('/frame').expect(200);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });
});
