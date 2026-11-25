/**
 * Moves the clock and the photo caption a little every few minutes, so the
 * same bright pixels don't stay lit for hours on a TV or OLED screen kept
 * awake all day (burn-in). Offsets are fractions from 0 to 1; the CSS turns
 * them into a short distance (see --shift-x, --shift-y in slideshow.css).
 */
(function (root) {
  // A slow walk around a small square, one neighbour at a time, so nothing jumps
  const PATH = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]];
  const EVERY_MS = 3 * 60 * 1000;

  function shiftAt(step) {
    const [x, y] = PATH[((step % PATH.length) + PATH.length) % PATH.length];
    return { x, y };
  }

  class ScreenShift {
    constructor(target, everyMs = EVERY_MS) {
      this.target = target;
      this.everyMs = everyMs;
      this.step = 0;
      this.timer = null;
    }

    start() {
      if (this.timer) return;
      this.apply();
      this.timer = setInterval(() => {
        this.step += 1;
        this.apply();
      }, this.everyMs);
    }

    stop() {
      clearInterval(this.timer);
      this.timer = null;
    }

    apply() {
      const { x, y } = shiftAt(this.step);
      this.target.style.setProperty('--shift-x', x);
      this.target.style.setProperty('--shift-y', y);
    }
  }

  ScreenShift.shiftAt = shiftAt;
  ScreenShift.PATH = PATH;
  if (typeof module !== 'undefined' && module.exports) module.exports = ScreenShift;
  else root.ScreenShift = ScreenShift;
})(typeof self !== 'undefined' ? self : this);
