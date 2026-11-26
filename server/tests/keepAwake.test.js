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

  test('a tap from long ago is no proof: blocked later, it asks for a fresh tap again', async () => {
    let now = 1000000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      let allow = true;
      global.playVideo = video => (allow ? (video.paused = false, Promise.resolve()) : Promise.reject(new Error('blocked')));
      const awake = new KeepAwake();
      awake.enable();
      listeners.click(); // the user tapped once
      await flush();
      expect(awake.status).toBe('active');

      // An hour later the browser paused the video, and won't play it without a new tap
      now += 60 * 60 * 1000;
      allow = false;
      global.lastVideo.paused = true;
      global.lastVideo.emit('pause');
      await flush();
      expect(awake.status).toBe('needs-tap'); // the button is offered, not "unavailable"

      allow = true;
      listeners.click(); // that fresh tap is what it needed
      await flush();
      expect(awake.status).toBe('active');
    } finally {
      clock.mockRestore();
    }
  });

  test('the video paused by the browser is played again when it can be', async () => {
    let now = 1000000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const plays = [];
      global.playVideo = video => { plays.push(1); video.paused = false; return Promise.resolve(); };
      const awake = new KeepAwake();
      awake.enable();
      await flush();
      now += 60000;
      global.lastVideo.paused = true;
      global.lastVideo.emit('pause');
      await flush();
      expect(plays).toHaveLength(2);
      expect(awake.status).toBe('active');

      // Paused again straight away: stop fighting the browser and ask for a tap
      global.lastVideo.paused = true;
      global.lastVideo.emit('pause');
      expect(awake.status).toBe('needs-tap');
    } finally {
      clock.mockRestore();
    }
  });

  test('a screen lock granted after the frame was locked is given straight back', async () => {
    let grant;
    const released = [];
    global.navigator.wakeLock = { request: () => new Promise(resolve => { grant = resolve; }) };
    const awake = new KeepAwake();
    awake.enable();
    awake.disable(); // locked while the request was still pending
    grant({ released: false, addEventListener: () => {}, release: () => { released.push(1); return Promise.resolve(); } });
    await flush();
    expect(released).toHaveLength(1);
    expect(awake.status).toBe('pending');
    expect(awake.active).toBe(false);
  });

  test('without the wake lock API, the looping video keeps the screen on', async () => {
    global.playVideo = () => Promise.resolve();
    const awake = new KeepAwake();
    awake.enable();
    await flush();
    expect(awake.status).toBe('active');
  });
});
