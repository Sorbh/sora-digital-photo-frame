// The slideshow's guess at what kind of screen it runs on (public/js/deviceKind.js)
const { describe: describeDevice, advertise } = require('../public/js/deviceKind');

const cases = [
  ['Mozilla/5.0 (Linux; Android 9; BRAVIA 4K GB ATV3 Build/PTT1.190515.001.S52) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0 Safari/537.36', 'tv', 'Android TV · Chrome'],
  ['Mozilla/5.0 (Linux; Android 11; Android TV) AppleWebKit/537.36 Chrome/96.0 Safari/537.36', 'tv', 'Android TV · Chrome'],
  ['Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36', 'tv', 'Tizen'],
  ['Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0 Safari/537.36 WebAppManager', 'tv', 'webOS · Chrome'],
  ['Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0 Safari/537.36 CrKey/1.54.248666', 'tv', 'Chromecast · Chrome'],
  ['Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7233) AppleWebKit/537.36 (KHTML, like Gecko) Silk/98.6 like Chrome/98.0 Safari/537.36', 'tv', 'Fire TV · Silk'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1', 'phone', 'iOS · Safari'],
  ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36', 'phone', 'Android · Chrome'],
  ['Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1', 'tablet', 'iPadOS · Safari'],
  ['Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', 'tablet', 'Android · Chrome'],
  ['Mozilla/5.0 (Linux; Android 11; KFTRWI) AppleWebKit/537.36 (KHTML, like Gecko) Silk/120.0 like Chrome/120.0 Mobile Safari/537.36', 'tablet', 'Android · Silk'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', 'browser', 'Windows · Chrome'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15', 'browser', 'Mac · Safari'],
  ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', 'browser', 'ChromeOS · Chrome'],
  ['Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0', 'browser', 'Linux · Firefox'],
  ['', 'browser', 'Web'],
  [undefined, 'browser', 'Web']
];

describe('the kind of screen, from the user agent', () => {
  test.each(cases)('%s', (ua, kind, platform) => {
    expect(describeDevice(ua)).toEqual({ kind, platform });
  });

  test('an iPad asking for the desktop site (a Mac with touch) is a tablet', () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15';
    expect(describeDevice(mac, { touchPoints: 5 })).toEqual({ kind: 'tablet', platform: 'iPadOS · Safari' });
    expect(describeDevice(mac, { touchPoints: 0 }).kind).toBe('browser');
  });

  test('the slideshow loads the helper before all of its sign-in scripts', () => {
    const page = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/slideshow.html'), 'utf8');
    const helper = page.indexOf('/js/deviceKind.js');
    expect(helper).toBeGreaterThan(-1);
    for (const script of ['screenPause', 'frameSession', 'slideshow']) {
      expect(page.indexOf(`/js/${script}.js`)).toBeGreaterThan(helper);
    }
    const { deviceInfo } = require('../utils/deviceInfo');
    for (const [ua] of cases) {
      const said = describeDevice(ua);
      expect(deviceInfo(said)).toEqual({ name: null, app: null, model: null, ...said });
    }
  });

  test('uses the browser brand instead of the embedded Chrome or Safari token', () => {
    expect(describeDevice('Windows Chrome/120.0 Safari/537.36 Edg/120.0').platform).toBe('Windows · Edge');
    expect(describeDevice('Android Chrome/120.0 Mobile Safari/537.36 SamsungBrowser/25.0').platform).toBe('Android · Samsung Internet');
    expect(describeDevice('iPhone FxiOS/120.0 Safari/604.1').platform).toBe('iOS · Firefox');
  });

  test('uses the client hint for the model and keeps platformVersion out of the label', async () => {
    const getHighEntropyValues = jest.fn().mockResolvedValue({ model: ' Pixel 7 ', platformVersion: '14.0.0' });
    const navigator = {
      userAgent: 'Mozilla/5.0 (Linux; Android 10; K) Chrome/120.0 Mobile Safari/537.36',
      userAgentData: { getHighEntropyValues }
    };
    await expect(advertise(navigator)).resolves.toEqual({ kind: 'phone', platform: 'Android · Chrome', model: 'Pixel 7' });
    expect(getHighEntropyValues).toHaveBeenCalledWith(['model', 'platformVersion']);
    getHighEntropyValues.mockRejectedValueOnce(new Error('Denied')).mockResolvedValueOnce({ model: '' });
    await expect(advertise(navigator)).resolves.toEqual({ kind: 'phone', platform: 'Android · Chrome' });
    await expect(advertise(navigator)).resolves.toEqual({ kind: 'phone', platform: 'Android · Chrome' });
  });

  test.each([
    ['Macintosh Version/17.1 Safari/605.1.15', 'Mac · Safari'],
    ['Linux Firefox/120.0', 'Linux · Firefox']
  ])('does not invent a model without a client hint (%s)', async (userAgent, platform) => {
    await expect(advertise({ userAgent })).resolves.toEqual({ kind: 'browser', platform });
  });
});
