const { place, MARGIN } = require('../public/js/placeMenu');

const viewport = { width: 360, height: 640 };
const menu = { width: 200, height: 240 };
const button = (top, right = 340) => ({ left: right - 44, top, right, bottom: top + 44 });

describe('pop-up menu placement', () => {
  test('opens under the options button, lined up with its end', () => {
    expect(place({ ...menu, viewport, anchor: button(100) })).toEqual({ left: 140, top: 148, maxHeight: null });
  });

  test('opens above the button when there is no room below', () => {
    const spot = place({ ...menu, viewport, anchor: button(500) });
    expect(spot.top).toBe(500 - 4 - 240);
    expect(spot.maxHeight).toBe(null);
  });

  test('fitting neither below nor above (landscape phone), it is pinned to the top, all on screen', () => {
    // 360px high, button at y=120, a 240px menu: below runs off, above would start at -124
    const spot = place({ ...menu, viewport: { width: 740, height: 360 }, anchor: button(120, 700) });
    expect(spot.top).toBe(MARGIN);
    expect(spot.top + menu.height).toBeLessThanOrEqual(360);
  });

  test('a menu taller than the screen scrolls', () => {
    const spot = place({ width: 200, height: 500, viewport: { width: 740, height: 360 }, anchor: button(120, 700) });
    expect(spot).toEqual({ left: 500, top: MARGIN, maxHeight: 360 - 2 * MARGIN });
  });

  test('never runs off the left or right edge', () => {
    expect(place({ ...menu, viewport, anchor: button(100, 60) }).left).toBe(MARGIN);
    expect(place({ ...menu, viewport, point: { x: 300, y: 100 } }).left).toBe(100);
    expect(place({ width: 400, height: 100, viewport, point: { x: 10, y: 10 } }).left).toBe(MARGIN);
  });

  test('a right-click menu flips up near the bottom and is clamped when it cannot', () => {
    expect(place({ ...menu, viewport, point: { x: 20, y: 600 } }).top).toBe(360);
    expect(place({ ...menu, viewport: { width: 360, height: 300 }, point: { x: 20, y: 200 } }).top).toBe(300 - MARGIN - 240);
  });
});
