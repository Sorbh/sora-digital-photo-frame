const FrameNotices = require('../public/js/frameNotices');

function frame() {
  const slots = { wake: null, info: null };
  const notices = new FrameNotices({ render: (slot, notice) => { slots[slot] = notice; } });
  return { notices, slots };
}

describe('Notices at the top of the frame', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('nothing covers the sign-in screen; the photos coming up show what is wrong', () => {
    const { notices, slots } = frame();
    notices.wakeStatus('needs-tap');
    expect(slots.wake).toBeNull();
    notices.start();
    expect(slots.wake).toMatchObject({ key: 'slideshow.keepAwakeNeedsTap', button: true, compact: false });
  });

  test('the Keep screen awake button stays for as long as a tap is needed, smaller after a minute', () => {
    const { notices, slots } = frame();
    notices.start();
    notices.wakeStatus('needs-tap');
    jest.advanceTimersByTime(60000);
    expect(slots.wake).toMatchObject({ button: true, compact: true });
    jest.advanceTimersByTime(6 * 60 * 60 * 1000);
    expect(slots.wake).toMatchObject({ button: true, compact: true });

    notices.wakeStatus('needs-tap'); // the same answer again (tab shown again, say) keeps it as it is
    expect(slots.wake).toMatchObject({ button: true, compact: true });

    notices.wakeStatus('active'); // the tap worked
    expect(slots.wake).toBeNull();
  });

  test('a fullscreen message does not push the keep-awake button away', () => {
    const { notices, slots } = frame();
    notices.start();
    notices.wakeStatus('needs-tap');
    notices.fullscreen('refused');
    expect(slots.info).toMatchObject({ key: 'slideshow.fullscreenRefused' });
    expect(slots.wake).toMatchObject({ button: true });

    jest.advanceTimersByTime(10000);
    expect(slots.info).toBeNull();
    expect(slots.wake).toMatchObject({ button: true });
  });

  test('fullscreen not available here is said for a few seconds', () => {
    const { notices, slots } = frame();
    notices.start();
    notices.fullscreen('unavailable');
    expect(slots.info).toMatchObject({ key: 'slideshow.fullscreenUnavailable' });
    jest.advanceTimersByTime(12000);
    expect(slots.info).toBeNull();
  });

  test('keep-awake that a tap cannot fix is said once, then left alone', () => {
    const { notices, slots } = frame();
    notices.start();
    notices.wakeStatus('unavailable');
    expect(slots.wake).toMatchObject({ key: 'slideshow.keepAwakeUnavailable', button: false });
    jest.advanceTimersByTime(20000);
    expect(slots.wake).toBeNull();
    notices.wakeStatus('pending');
    notices.wakeStatus('unavailable');
    expect(slots.wake).toBeNull();
  });

  test('keep-awake failing again after it worked, or in a new session, is said again', () => {
    const { notices, slots } = frame();
    notices.start();
    notices.wakeStatus('unavailable');
    jest.advanceTimersByTime(20000);
    notices.wakeStatus('active');
    notices.wakeStatus('unavailable');
    expect(slots.wake).toMatchObject({ key: 'slideshow.keepAwakeUnavailable' });

    jest.advanceTimersByTime(20000);
    notices.wakeStatus('pending'); // signing out turns keep-awake off...
    notices.stop(); // ...and clears the notices
    notices.start();
    notices.wakeStatus('unavailable');
    expect(slots.wake).toMatchObject({ key: 'slideshow.keepAwakeUnavailable' });
  });

  test('the small keep-awake pill leaves room for the photo caption; full messages do not', () => {
    const { notices } = frame();
    notices.start();
    expect(notices.coversTop()).toBe(false);
    notices.wakeStatus('needs-tap');
    expect(notices.coversTop()).toBe(true);
    jest.advanceTimersByTime(60000);
    expect(notices.coversTop()).toBe(false); // only the pill now
    notices.fullscreen('refused');
    expect(notices.coversTop()).toBe(true);
    jest.advanceTimersByTime(10000);
    expect(notices.coversTop()).toBe(false);
  });

  test('signing out clears them, and signing in again shows them afresh', () => {
    const { notices, slots } = frame();
    notices.start();
    notices.wakeStatus('needs-tap');
    notices.fullscreen('refused');
    notices.stop();
    expect(slots).toEqual({ wake: null, info: null });

    notices.start();
    expect(slots.wake).toMatchObject({ button: true, compact: false });
  });
});
