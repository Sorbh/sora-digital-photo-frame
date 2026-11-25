// The frame tells the user when the screen may go to sleep; KeepAwake says when
const listeners = {};
global.document = {
  visibilityState: 'visible',
  addEventListener: (type, fn) => { listeners[type] = fn; },
  removeEventListener: () => {},
  createElement: () => ({ style: {}, setAttribute: () => {}, play: () => global.playVideo(), pause: () => {} }),
  body: { appendChild: () => {} }
};
global.window = { navigator: {} };
global.navigator = { userAgent: 'test' };

const KeepAwake = require('../public/js/keepAwake');

const flush = () => new Promise(resolve => setImmediate(resolve));
const refused = () => Promise.reject(Object.assign(new Error('needs a gesture'), { name: 'NotAllowedError' }));
const sentinel = () => ({ released: false, addEventListener: () => {}, release: () => Promise.resolve() });

describe('Keeping the screen awake', () => {
  afterEach(() => { delete global.navigator.wakeLock; });

  test('asks for a tap when the browser wants one, and is on after the tap', async () => {
    let allow = false;
    global.navigator.wakeLock = { request: () => (allow ? Promise.resolve(sentinel()) : refused()) };
    const awake = new KeepAwake();
    const seen = [];
    awake.onchange = status => seen.push(status);
    awake.enable();
    await flush();
    expect(awake.status).toBe('needs-tap');

    allow = true;
    listeners.click();
    await flush();
    expect(awake.status).toBe('active');
    expect(seen).toEqual(['needs-tap', 'active']);
  });

  test('says it is unavailable when even a tap does not help', async () => {
    global.navigator.wakeLock = { request: refused };
    global.playVideo = () => Promise.reject(new Error('autoplay blocked'));
    const awake = new KeepAwake();
    awake.enable();
    await flush();
    expect(awake.status).toBe('needs-tap');

    listeners.click();
    await flush();
    expect(awake.status).toBe('unavailable');
  });

  test('without the wake lock API, the looping video keeps the screen on', async () => {
    global.playVideo = () => Promise.resolve();
    const awake = new KeepAwake();
    awake.enable();
    await flush();
    expect(awake.status).toBe('active');
  });
});
