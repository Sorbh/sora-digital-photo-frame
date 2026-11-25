// The frame tells the user when the screen may go to sleep; KeepAwake says when
const listeners = {};
global.document = {
  visibilityState: 'visible',
  addEventListener: (type, fn) => { listeners[type] = fn; },
  removeEventListener: () => {},
  createElement: () => {
    const handlers = {};
    const video = {
      style: {}, paused: true, setAttribute: () => {}, pause() { video.paused = true; },
      addEventListener: (type, fn) => { handlers[type] = fn; },
      emit: type => handlers[type](),
      play: () => global.playVideo(video)
    };
    global.lastVideo = video;
    return video;
  },
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

  test('a video this device cannot play is unavailable, not a reason to ask for a tap', async () => {
    global.playVideo = () => Promise.reject(Object.assign(new Error('no decoder'), { name: 'NotSupportedError' }));
    const awake = new KeepAwake();
    awake.enable();
    await flush();
    expect(awake.status).toBe('unavailable');
  });

  test('on browsers where play() answers nothing, only real playback counts as on', async () => {
    jest.useFakeTimers();
    try {
      global.playVideo = () => undefined;
      const awake = new KeepAwake();
      awake.enable();
      expect(awake.status).toBe('pending');
      global.lastVideo.paused = false;
      global.lastVideo.emit('playing');
      expect(awake.status).toBe('active');

      const broken = new KeepAwake();
      broken.enable();
      global.lastVideo.emit('error'); // the file can't be decoded
      expect(broken.status).toBe('unavailable');

      const blocked = new KeepAwake();
      blocked.enable();
      jest.advanceTimersByTime(3000); // still paused: autoplay needs a tap
      expect(blocked.status).toBe('needs-tap');
    } finally {
      jest.useRealTimers();
    }
  });

  test('turned off on sign-out and on again on sign-in, it takes the lock again', async () => {
    const requests = [];
    global.navigator.wakeLock = { request: () => { requests.push(1); return Promise.resolve(sentinel()); } };
    const awake = new KeepAwake();
    awake.enable();
    await flush();
    expect(awake.status).toBe('active');
    awake.disable();
    expect(awake.status).toBe('pending');
    awake.enable();
    await flush();
    expect(requests).toHaveLength(2);
    expect(awake.status).toBe('active');
  });

  test('without the wake lock API, the looping video keeps the screen on', async () => {
    global.playVideo = () => Promise.resolve();
    const awake = new KeepAwake();
    awake.enable();
    await flush();
    expect(awake.status).toBe('active');
  });
});
