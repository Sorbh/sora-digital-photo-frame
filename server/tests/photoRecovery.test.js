const PhotoRecovery = require('../public/js/photoRecovery');
const RetrySchedule = require('../public/js/retrySchedule');

// Each try of the frame, answered by the test when it likes
function frame({ photoOnScreen = false } = {}) {
  const tries = [];
  const failures = [];
  const state = { photoOnScreen };
  const recovery = new PhotoRecovery({
    attempt: (signal, isCurrent) => new Promise(resolve => tries.push({ signal, isCurrent, resolve })),
    failed: error => failures.push(error),
    photoOnScreen: () => state.photoOnScreen,
    schedule: new RetrySchedule(),
    timeoutMs: 30000
  });
  const window = new EventTarget();
  const retryButton = new EventTarget();
  recovery.listen(window, retryButton);
  return { recovery, tries, failures, state, window, retryButton };
}

const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const offline = { ok: false, error: { offline: true } };

describe('A frame that could not show its first photo', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('shows the error card and tries again on its own, waiting longer each time', async () => {
    const f = frame();
    f.recovery.start();
    f.tries[0].resolve(offline);
    await settle();
    expect(f.failures).toEqual([{ offline: true }]);

    jest.advanceTimersByTime(4999);
    expect(f.tries).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(f.tries).toHaveLength(2);

    f.tries[1].resolve(offline);
    await settle();
    jest.advanceTimersByTime(9999);
    expect(f.tries).toHaveLength(2);
    jest.advanceTimersByTime(1);
    expect(f.tries).toHaveLength(3);

    f.tries[2].resolve({ ok: true });
    await settle();
    jest.advanceTimersByTime(10 * 60 * 1000);
    expect(f.tries).toHaveLength(3);
    expect(f.recovery.recovering).toBe(false);
  });

  test('a request the server never answers is given up after the timeout, and tried again', async () => {
    const f = frame();
    f.recovery.start();
    jest.advanceTimersByTime(30000);
    await settle();
    expect(f.tries[0].signal.aborted).toBe(true);
    expect(f.failures).toEqual([{ timeout: true }]);
    jest.advanceTimersByTime(5000);
    expect(f.tries).toHaveLength(2);

    // The stalled request finally answering changes nothing
    f.tries[0].resolve({ ok: true });
    await settle();
    expect(f.recovery.recovering).toBe(true);
  });

  test('the Retry button tries now, even while a try is stuck, and the stuck one is dropped', async () => {
    const f = frame();
    f.recovery.start();
    f.tries[0].resolve(offline);
    await settle();

    f.retryButton.dispatchEvent(new Event('click'));
    expect(f.tries).toHaveLength(2); // no waiting out the 5 seconds

    f.retryButton.dispatchEvent(new Event('click')); // pressed again while that one hangs
    expect(f.tries).toHaveLength(3);
    expect(f.tries[1].signal.aborted).toBe(true);
    expect(f.tries[1].isCurrent()).toBe(false);

    f.tries[1].resolve(offline);
    f.tries[2].resolve({ ok: true });
    await settle();
    expect(f.failures).toHaveLength(1);
    expect(f.recovery.recovering).toBe(false);
    jest.advanceTimersByTime(10 * 60 * 1000);
    expect(f.tries).toHaveLength(3);
  });

  test('coming back online tries now, but only while there is something to recover', async () => {
    const f = frame();
    f.recovery.start();
    f.tries[0].resolve(offline);
    await settle();

    f.window.dispatchEvent(new Event('online'));
    expect(f.tries).toHaveLength(2);
    f.tries[1].resolve({ ok: true });
    await settle();

    f.window.dispatchEvent(new Event('online'));
    expect(f.tries).toHaveLength(2);
  });

  test('signing out drops a try still running, and signing in again starts straight away', async () => {
    const f = frame();
    f.recovery.start();
    f.recovery.stop();
    expect(f.tries[0].isCurrent()).toBe(false);
    expect(f.tries[0].signal.aborted).toBe(true);

    f.recovery.start(); // the next session is not held up by the old try
    expect(f.tries).toHaveLength(2);

    f.tries[0].resolve(offline); // the old session's failure
    await settle();
    expect(f.failures).toEqual([]);

    f.recovery.stop();
    f.tries[1].resolve(offline);
    await settle();
    jest.advanceTimersByTime(10 * 60 * 1000);
    expect(f.tries).toHaveLength(2); // nothing tries again after signing out
  });

  test("picking another folder drops the old folder's pending retry and its late failure", async () => {
    const f = frame({ photoOnScreen: true });
    f.recovery.start(); // folder A
    f.tries[0].resolve(offline);
    await settle(); // A's retry is waiting

    f.recovery.start(); // folder B
    expect(f.tries).toHaveLength(2);
    f.tries[1].resolve({ ok: true });
    await settle();

    jest.advanceTimersByTime(10 * 60 * 1000);
    expect(f.tries).toHaveLength(2); // A's retry never ran
    expect(f.recovery.recovering).toBe(false);
  });

  test('with a good photo on screen a network drop keeps it there quietly, and still tries again', async () => {
    const f = frame({ photoOnScreen: true });
    f.recovery.start();
    f.tries[0].resolve(offline);
    await settle();
    expect(f.failures).toEqual([]); // no error card over the photo
    jest.advanceTimersByTime(5000);
    expect(f.tries).toHaveLength(2);

    // A request that hangs, and a photo that fails to load, are the same
    jest.advanceTimersByTime(30000);
    await settle();
    expect(f.failures).toEqual([]);
    jest.advanceTimersByTime(10000);
    f.tries[2].resolve({ ok: false, error: { key: 'slideshow.loadFirstImageFailed', transient: true } });
    await settle();
    expect(f.failures).toEqual([]);
    expect(f.recovery.recovering).toBe(true);
  });

  test('an empty folder picked while a photo is on screen shows the card, and the frame recovers once it has photos', async () => {
    const empty = { ok: false, error: { key: 'slideshow.noImagesInFolder', vars: { folder: 'Goa' } } };
    const f = frame({ photoOnScreen: true });
    f.recovery.start(); // the empty folder picked
    f.tries[0].resolve(empty);
    await settle();
    expect(f.failures).toEqual([empty.error]);

    // Still empty on the next try: said again, and tried again
    jest.advanceTimersByTime(5000);
    f.tries[1].resolve(empty);
    await settle();
    expect(f.failures).toHaveLength(2);

    // Photos added: the next try shows one and the retrying ends
    jest.advanceTimersByTime(10000);
    f.tries[2].resolve({ ok: true });
    await settle();
    expect(f.recovery.recovering).toBe(false);
    jest.advanceTimersByTime(10 * 60 * 1000);
    expect(f.tries).toHaveLength(3);
  });

  test('an account without access shows the card over a photo; picking another folder recovers', async () => {
    const restricted = { ok: false, error: { key: 'errors.ACCESS_RESTRICTED' } };
    const f = frame({ photoOnScreen: true });
    f.recovery.start();
    f.tries[0].resolve(restricted);
    await settle();
    expect(f.failures).toEqual([restricted.error]);

    f.recovery.start(); // another folder
    f.tries[1].resolve({ ok: true });
    await settle();
    jest.advanceTimersByTime(10 * 60 * 1000);
    expect(f.tries).toHaveLength(2); // the first folder's retry never ran
    expect(f.recovery.recovering).toBe(false);
  });

  test('mustShow: what the user has to act on, not the network', () => {
    expect(PhotoRecovery.mustShow({ key: 'slideshow.noImagesInFolder' })).toBe(true);
    expect(PhotoRecovery.mustShow({ offline: true })).toBe(false);
    expect(PhotoRecovery.mustShow({ timeout: true })).toBe(false);
    expect(PhotoRecovery.mustShow({ key: 'slideshow.loadFirstImageFailed', transient: true })).toBe(false);
    expect(PhotoRecovery.mustShow(undefined)).toBe(false);
  });

  test('picking a folder or signing out makes earlier slideshow work too late to count; Retry does not', async () => {
    const f = frame();
    const before = f.recovery.generation;
    f.recovery.start(); // folder B picked while a Next for folder A is still loading
    expect(f.recovery.generation).not.toBe(before);
    const forB = f.recovery.generation;
    f.tries[0].resolve(offline);
    await settle();
    f.retryButton.dispatchEvent(new Event('click'));
    expect(f.recovery.generation).toBe(forB); // a Next pressed now still counts for B
    f.recovery.stop();
    expect(f.recovery.generation).not.toBe(forB);
  });

  test('withTimeout gives up on a promise that never settles', async () => {
    const never = new Promise(() => {});
    const result = PhotoRecovery.withTimeout(never, 12000).catch(error => error.name);
    jest.advanceTimersByTime(12000);
    await expect(result).resolves.toBe('TimeoutError');
    await expect(PhotoRecovery.withTimeout(Promise.resolve('key'), 12000)).resolves.toBe('key');
  });

  test('a photo shown another way (the Next button) ends the retrying', async () => {
    const f = frame();
    f.recovery.start();
    f.tries[0].resolve(offline);
    await settle();
    f.recovery.done();
    jest.advanceTimersByTime(10 * 60 * 1000);
    expect(f.tries).toHaveLength(1);
  });
});
