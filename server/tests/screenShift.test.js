const ScreenShift = require('../public/js/screenShift');

// A stand-in for document.documentElement
const element = () => {
  const values = {};
  return { values, style: { setProperty: (name, value) => { values[name] = value; } } };
};

describe('The clock and caption move a little against burn-in', () => {
  test('they start where the layout puts them', () => {
    expect(ScreenShift.shiftAt(0)).toEqual({ x: 0, y: 0 });
  });

  test('each move is a small step to a neighbouring spot, never a jump across', () => {
    const steps = ScreenShift.PATH.length;
    for (let step = 0; step < steps * 2; step++) {
      const from = ScreenShift.shiftAt(step);
      const to = ScreenShift.shiftAt(step + 1);
      expect(Math.abs(to.x - from.x) + Math.abs(to.y - from.y)).toBeLessThanOrEqual(0.5);
      expect([to.x, to.y].every(v => v >= 0 && v <= 1)).toBe(true);
    }
  });

  test('they visit every corner of the small square, then go round again', () => {
    const spots = ScreenShift.PATH.map((_, step) => ScreenShift.shiftAt(step));
    for (const corner of [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]) expect(spots).toContainEqual(corner);
    expect(ScreenShift.shiftAt(ScreenShift.PATH.length)).toEqual(ScreenShift.shiftAt(0));
  });

  test('moves every few minutes once started, and stops when asked', () => {
    jest.useFakeTimers();
    try {
      const target = element();
      const shift = new ScreenShift(target, 1000);
      shift.start();
      expect(target.values).toEqual({ '--shift-x': 0, '--shift-y': 0 });
      jest.advanceTimersByTime(1000);
      expect(target.values).toEqual({ '--shift-x': 0.5, '--shift-y': 0 });
      shift.stop();
      jest.advanceTimersByTime(5000);
      expect(target.values).toEqual({ '--shift-x': 0.5, '--shift-y': 0 });
    } finally {
      jest.useRealTimers();
    }
  });
});
