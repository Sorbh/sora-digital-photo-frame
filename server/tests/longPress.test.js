const SoraLongPress = require('../public/js/longPress');

// A tile stand-in: real event dispatch (capture, stopImmediatePropagation) without a DOM
function pointer(type, props = {}) {
  const event = new Event(type, { cancelable: true });
  return Object.assign(event, { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: 50, clientY: 50, ...props });
}

function setup(options = {}) {
  const tile = new EventTarget();
  const onLongPress = jest.fn();
  const onClick = jest.fn();
  const onMenu = jest.fn();
  const press = SoraLongPress.attach(tile, { onLongPress, ...options });
  tile.addEventListener('click', onClick);
  tile.addEventListener('contextmenu', onMenu);
  // detail is 1 for a click from a tap or a mouse, 0 for Enter or Space
  const click = (detail = 1) => {
    const event = Object.assign(new Event('click', { cancelable: true }), { detail });
    tile.dispatchEvent(event);
    return event;
  };
  return { tile, press, onLongPress, onClick, onMenu, click };
}

describe('library long press', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('a tap is not cancelled and its click goes through', () => {
    const { tile, onLongPress, onClick, click } = setup();
    const down = pointer('pointerdown');
    tile.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
    jest.advanceTimersByTime(150);
    tile.dispatchEvent(pointer('pointerup'));
    expect(click().defaultPrevented).toBe(false);
    jest.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('holding still selects, and only the click that follows is swallowed', () => {
    const { tile, onLongPress, onClick, click } = setup();
    tile.dispatchEvent(pointer('pointerdown'));
    jest.advanceTimersByTime(SoraLongPress.DELAY);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    tile.dispatchEvent(pointer('pointerup'));
    expect(click().defaultPrevented).toBe(true);
    expect(onClick).not.toHaveBeenCalled();

    // The next tap opens the photo again
    tile.dispatchEvent(pointer('pointerdown'));
    tile.dispatchEvent(pointer('pointerup'));
    click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('a new press after a held one without a click is not swallowed', () => {
    const { tile, onClick, click } = setup();
    tile.dispatchEvent(pointer('pointerdown'));
    jest.advanceTimersByTime(SoraLongPress.DELAY);
    tile.dispatchEvent(pointer('pointerup')); // some browsers send no click after a hold
    tile.dispatchEvent(pointer('pointerdown'));
    tile.dispatchEvent(pointer('pointerup'));
    click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('a keyboard click after a hold is never swallowed', () => {
    const { tile, onClick, click } = setup();
    tile.dispatchEvent(pointer('pointerdown'));
    jest.advanceTimersByTime(SoraLongPress.DELAY);
    tile.dispatchEvent(pointer('pointerup'));
    expect(click(0).defaultPrevented).toBe(false); // Enter on the tile's View button
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('a hold the browser cancels (a scroll) leaves no click to swallow', () => {
    const { tile, onLongPress, onClick, click } = setup();
    tile.dispatchEvent(pointer('pointerdown'));
    jest.advanceTimersByTime(SoraLongPress.DELAY);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    tile.dispatchEvent(pointer('pointercancel'));
    click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('a click long after the hold ended goes through', () => {
    const { tile, onClick, click } = setup();
    tile.dispatchEvent(pointer('pointerdown'));
    jest.advanceTimersByTime(SoraLongPress.DELAY);
    tile.dispatchEvent(pointer('pointerup')); // and the browser sends no click
    jest.advanceTimersByTime(SoraLongPress.CLICK_WINDOW + 1);
    click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('moving the finger (scrolling) cancels the press', () => {
    const onEnd = jest.fn();
    const { tile, onLongPress } = setup({ onEnd });
    tile.dispatchEvent(pointer('pointerdown'));
    tile.dispatchEvent(pointer('pointermove', { clientX: 53, clientY: 54 })); // within the slop
    tile.dispatchEvent(pointer('pointermove', { clientY: 50 + SoraLongPress.SLOP + 5 }));
    expect(onEnd).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  test('pointercancel cancels the press', () => {
    const { tile, onLongPress } = setup();
    tile.dispatchEvent(pointer('pointerdown'));
    tile.dispatchEvent(pointer('pointercancel'));
    jest.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  test('presses on the tile buttons are left to the buttons', () => {
    const onStart = jest.fn();
    const { tile, onLongPress } = setup({ ignore: '.btn-icon', onStart });
    const down = pointer('pointerdown');
    // EventTarget has no closest(); stand in for a press that started on a button
    tile.closest = selector => selector === '.btn-icon';
    tile.dispatchEvent(down);
    jest.advanceTimersByTime(1000);
    expect(onStart).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
  });

  test('right and secondary presses do not start a long press', () => {
    const { tile, onLongPress } = setup();
    tile.dispatchEvent(pointer('pointerdown', { pointerType: 'mouse', button: 2 }));
    tile.dispatchEvent(pointer('pointerdown', { isPrimary: false }));
    jest.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  test('a finger hold does not open the menu, a right-click does', () => {
    const { tile, onMenu } = setup();
    tile.dispatchEvent(pointer('pointerdown'));
    const touchMenu = new Event('contextmenu', { cancelable: true });
    tile.dispatchEvent(touchMenu);
    expect(touchMenu.defaultPrevented).toBe(true);
    expect(onMenu).not.toHaveBeenCalled();

    tile.dispatchEvent(pointer('pointerdown', { pointerType: 'mouse', button: 2 }));
    tile.dispatchEvent(new Event('contextmenu', { cancelable: true }));
    expect(onMenu).toHaveBeenCalledTimes(1);
  });

  test('cancel() stops a pending press', () => {
    const { tile, press, onLongPress } = setup();
    tile.dispatchEvent(pointer('pointerdown', { pointerType: 'mouse' }));
    press.cancel();
    jest.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
