const fs = require('fs');
const path = require('path');

// The slideshow's pairing poller, run without a browser: the page and its elements are stand-ins (#66)
const source = fs.readFileSync(path.join(__dirname, '../public/js/slideshow.js'), 'utf8');
const requests = [];
const listeners = new Map();
const documentListeners = new Map();
const sendBeacon = jest.fn();
let answers = [];
const browser = {
  i18n: { error: () => '' },
  document: {
    addEventListener: (event, listener) => documentListeners.set(event, listener),
    dispatchEvent() {},
    documentElement: { dataset: {} }
  },
  CustomEvent: class { constructor(type, init) { Object.assign(this, { type }, init); } },
  sessionStorage: { setItem() {}, removeItem() {} },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  window: { addEventListener: (event, listener) => listeners.set(event, listener) },
  navigator: { sendBeacon },
  Blob,
  fetch: async (url, options = {}) => {
    requests.push({ url, ...options });
    const body = answers.shift() || { success: true, status: 'waiting' };
    return { json: async () => body };
  },
  DEVICE_TOKEN_KEY: 'photoframe_device_token',
  FAMILY_CODE_KEY: 'photoframe_family_code'
};
const AuthenticationManager = new Function(...Object.keys(browser),
  `${source.slice(source.indexOf('class AuthenticationManager'), source.indexOf('class PhotoFrameSlideshow'))}; return AuthenticationManager;`
)(...Object.values(browser));

const pairingPage = () => Object.assign(Object.create(AuthenticationManager.prototype), {
  pairing: { code: 'ABC234', secret: 'f00dfeed'.repeat(6), expiresAt: Date.now() + 60 * 1000 },
  pairCard: { classList: { add() {}, remove() {} } },
  setPairStatus() {},
  useScreenLanguage() {},
  keepSignedIn() {},
  handleAuthSuccess() {}
});

describe('the frame polling its pairing', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    requests.length = 0;
  });
  afterEach(() => jest.useRealTimers());

  test('sends the code and secret in a POST body, never in a URL', async () => {
    const page = pairingPage();
    const { secret } = page.pairing;
    answers = [
      { success: true, status: 'ready' },
      { success: true, status: 'approved', token: 'dev_0123456789ab.token', device: { name: 'Den' }, account: { name: 'Den' } }
    ];
    await page.checkPairing();

    expect(requests.map(r => r.url)).toEqual(['/api/pair/status', '/api/pair/collect']);
    for (const request of requests) {
      expect(request.method).toBe('POST');
      expect(request.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(request.body)).toEqual({ code: 'ABC234', secret });
      expect(request.url).not.toContain('?');
      expect(request.url).not.toContain(secret);
    }
  });

  test('keeps polling the same way while waiting', async () => {
    const page = pairingPage();
    answers = [];
    await page.checkPairing();
    await jest.advanceTimersByTimeAsync(2000);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).toMatchObject({ url: '/api/pair/status', method: 'POST' });
      expect(JSON.parse(request.body).secret).toBe(page.pairing.secret);
    }
  });
});

describe('leaving and restoring the pairing page', () => {
  function openPairingPage() {
    const page = Object.assign(pairingPage(), {
      bindEvents() {},
      takeSignInFromUrl() {},
      checkExistingSession() {}
    });
    page.init();
    return page;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    listeners.clear();
    documentListeners.clear();
    sendBeacon.mockClear();
    requests.length = 0;
    answers = [];
  });
  afterEach(() => jest.useRealTimers());

  test('sends a JSON cancel beacon on pagehide while waiting and stops polling', async () => {
    const page = openPairingPage();
    const { code, secret } = page.pairing;
    await page.checkPairing();

    browser.document.hidden = true;
    browser.document.visibilityState = 'hidden';
    const visibilityChange = { target: browser.document };
    documentListeners.get('visibilitychange')?.(visibilityChange);
    listeners.get('visibilitychange')?.(visibilityChange);
    browser.document.hidden = false;
    browser.document.visibilityState = 'visible';
    expect(sendBeacon).not.toHaveBeenCalled();
    listeners.get('pagehide')({ persisted: false });

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [[url, body]] = sendBeacon.mock.calls;
    expect(url).toBe('/api/pair/cancel');
    expect(body.type).toBe('application/json');
    expect(JSON.parse(await body.text())).toEqual({ code, secret });
    await jest.advanceTimersByTimeAsync(2000);
    expect(requests).toHaveLength(1);
  });

  test('starts with a fresh code when restored from the back-forward cache', async () => {
    const page = openPairingPage();
    const { code: oldCode } = page.pairing;
    page.pairQr = {};
    page.pairCode = {};
    answers = [{ success: true, code: 'NEW234', secret: 'new-secret', url: 'https://example.test/pair' }];

    listeners.get('pagehide')({ persisted: true });
    listeners.get('pageshow')({ persisted: false });
    expect(requests).toHaveLength(0);
    listeners.get('pageshow')({ persisted: true });
    await jest.advanceTimersByTimeAsync(0);

    expect(requests.map(r => r.url)).toEqual(['/api/pair/start']);
    expect(page.pairing.code).toBe('NEW234');
    expect(page.pairing.code).not.toBe(oldCode);
  });

  test('keeps an approval while collecting even if the page is hidden and restored', async () => {
    const page = openPairingPage();
    let finishCollect;
    answers = [
      { success: true, status: 'ready' },
      new Promise(resolve => { finishCollect = resolve; })
    ];
    const poll = page.checkPairing();
    await jest.advanceTimersByTimeAsync(0);
    expect(requests.map(r => r.url)).toEqual(['/api/pair/status', '/api/pair/collect']);

    listeners.get('pagehide')({ persisted: true });
    listeners.get('pageshow')({ persisted: true });
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(requests).toHaveLength(2);

    finishCollect({ success: true, status: 'approved', token: 'token', device: { name: 'Den' } });
    await poll;
    expect(page.pairing.ready).toBe(true);
  });
});
