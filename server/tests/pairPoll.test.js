const fs = require('fs');
const path = require('path');

// The slideshow's pairing poller, run without a browser: the page and its elements are stand-ins (#66)
const source = fs.readFileSync(path.join(__dirname, '../public/js/slideshow.js'), 'utf8');
const requests = [];
let answers = [];
const browser = {
  i18n: { error: () => '' },
  document: { dispatchEvent() {}, documentElement: { dataset: {} } },
  CustomEvent: class { constructor(type, init) { Object.assign(this, { type }, init); } },
  sessionStorage: { setItem() {}, removeItem() {} },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  window: {},
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
