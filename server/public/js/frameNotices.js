/**
 * The messages at the top of the frame when something the frame needs isn't
 * there. Two slots, so one never pushes the other away:
 *
 *   'wake'  keeping the screen on (see KeepAwake.status)
 *           needs-tap:    the message and a "Keep screen awake" button, shown
 *                         for as long as a tap is needed; after a minute only
 *                         the button stays, as a small pill
 *           unavailable:  said once, for 20 seconds
 *   'info'  fullscreen not available or refused, for a few seconds
 *
 * Nothing shows until the photos are up (start()), so the sign-in screen
 * stays clear. `render(slot, notice)` draws a slot: notice is null (hide) or
 * { key, icon, button, compact }.
 */
(function (root) {
  const WAKE = {
    'needs-tap': { key: 'slideshow.keepAwakeNeedsTap', icon: 'bedtime', button: true },
    unavailable: { key: 'slideshow.keepAwakeUnavailable', icon: 'bedtime', button: false }
  };
  const FULLSCREEN = {
    unavailable: { key: 'slideshow.fullscreenUnavailable', icon: 'fullscreen_exit', forMs: 12000 },
    refused: { key: 'slideshow.fullscreenRefused', icon: 'fullscreen_exit', forMs: 10000 }
  };

  class FrameNotices {
    constructor({ render, timers, wakeFullMs = 60000, unavailableMs = 20000 } = {}) {
      this.render = render;
      this.timers = timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };
      this.wakeFullMs = wakeFullMs;
      this.unavailableMs = unavailableMs;
      this.started = false;
      this.status = 'pending';
      this.toldUnavailable = false;
      this.shown = { wake: null, info: null };
      this.timer = { wake: null, info: null };
    }

    show(slot, notice, forMs) {
      this.timers.clearTimeout(this.timer[slot]);
      this.timer[slot] = forMs ? this.timers.setTimeout(() => this.show(slot, null), forMs) : null;
      this.shown[slot] = notice;
      this.render(slot, notice);
    }

    // The photos are up: say what's wrong, if anything
    start() {
      this.started = true;
      this.renderWake();
    }

    // Signed out: the sign-in screen gets no notices
    stop() {
      this.started = false;
      this.show('wake', null);
      this.show('info', null);
    }

    wakeStatus(status) {
      this.status = status;
      this.renderWake();
    }

    renderWake() {
      if (!this.started) return;
      if (this.status === 'needs-tap') {
        if (this.shown.wake && this.shown.wake.key === WAKE['needs-tap'].key) return; // already up
        this.show('wake', { ...WAKE['needs-tap'], compact: false });
        // Not the whole message for hours (burn-in), but the button stays while it's needed
        this.timers.clearTimeout(this.timer.wake);
        this.timer.wake = this.timers.setTimeout(() => {
          if (this.status === 'needs-tap') this.show('wake', { ...WAKE['needs-tap'], compact: true });
        }, this.wakeFullMs);
      } else if (this.status === 'unavailable') {
        if (this.toldUnavailable) return this.show('wake', null);
        this.toldUnavailable = true;
        this.show('wake', { ...WAKE.unavailable, compact: false }, this.unavailableMs);
      } else {
        this.show('wake', null); // active, or not known yet
      }
    }

    // 'unavailable' (no fullscreen in this browser) or 'refused'
    fullscreen(result) {
      const notice = FULLSCREEN[result];
      if (!notice) return;
      this.show('info', { key: notice.key, icon: notice.icon, button: false, compact: false }, notice.forMs);
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = FrameNotices;
  else root.FrameNotices = FrameNotices;
})(typeof self !== 'undefined' ? self : this);
