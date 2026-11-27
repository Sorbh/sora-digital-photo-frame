/**
 * A playing frame finds out by itself when its screen is removed (or its
 * account deleted), and goes back to its pairing code without anyone touching it.
 *
 * Two ways it hears:
 *   - any request it makes answers 401 (not signed in);
 *   - a light check of its session (GET /api/auth/session) every 15 seconds,
 *     so a frame between two photos notices too.
 *
 * "Not signed in" alone is not proof the screen is gone: a session can also run
 * out by itself (a TV asleep for a day). So with a device token the frame asks
 * once with it: signed in again, it plays on; only a 401 to that (the server's
 * "this frame is no longer paired") forgets the token and calls signedOut().
 * A network error, a 5xx, a 429 or a paused screen (403 SCREEN_PAUSED, which
 * js/screenPause.js shows) never wipes the pairing: it is asked again later.
 *
 *   new FrameSession({ fetch, signedOut, timers, storage, checkMs })
 *   session.fetch(url, options)   the page's fetch, watching each answer
 *   session.start() / stop()      while the frame is signed in and playing
 */
(function (root) {
  const TOKEN_KEY = 'photoframe_device_token';
  const CHECK_MS = 15 * 1000;
  // Answers about a sign-in being tried, not about the frame being signed in
  const SIGN_IN = /^\/api\/(auth\/(pin|device)|pair\/)/;

  const pathOf = (url) => {
    try {
      return new URL(String(url), 'http://frame.invalid').pathname;
    } catch (error) {
      return String(url);
    }
  };

  class FrameSession {
    constructor({ fetch, signedOut, timers, storage, checkMs = CHECK_MS } = {}) {
      this.request = fetch; // the fetch underneath, unwatched
      this.signedOut = signedOut; // the screen is gone: back to the pairing code
      this.timers = timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };
      this.storage = storage;
      this.checkMs = checkMs;
      this.active = false;
      this.checkTimer = null;
      this.confirming = null;
      this.fetch = this.fetch.bind(this);
    }

    // fetch() for the page: the same answer, looked at on the way past
    fetch(url, options) {
      return this.request(url, options).then((response) => {
        if (this.active && response && response.status === 401 && !SIGN_IN.test(pathOf(url))) this.confirm();
        return response;
      });
    }

    start() {
      this.active = true;
      this.schedule();
    }

    stop() {
      this.active = false;
      this.timers.clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }

    schedule() {
      this.timers.clearTimeout(this.checkTimer);
      this.checkTimer = this.active ? this.timers.setTimeout(() => this.check(), this.checkMs) : null;
    }

    // Is this browser still signed in? Cheap, and never answered from a cache
    async check() {
      this.checkTimer = null;
      if (!this.active || this.confirming) return;
      let response;
      try {
        response = await this.request('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
      } catch (error) {
        return this.schedule(); // offline for now
      }
      if (!this.active) return;
      if (response.status === 401) return this.confirm();
      if (!response.ok) return this.schedule(); // a 5xx, or paused (its card is up)
      let data = null;
      try { data = await response.json(); } catch (error) { /* not an answer */ }
      if (data && data.authenticated === false) return this.confirm();
      this.schedule();
    }

    token() {
      try { return this.storage && this.storage.getItem(TOKEN_KEY); } catch (error) { return null; }
    }

    // The server says this browser is not signed in: is the screen itself gone?
    confirm() {
      if (!this.active) return Promise.resolve(false);
      if (this.confirming) return this.confirming;
      this.timers.clearTimeout(this.checkTimer);
      this.checkTimer = null;
      this.confirming = this.isGone()
        .then((gone) => {
          if (gone && this.active) {
            try { this.storage && this.storage.removeItem(TOKEN_KEY); } catch (error) { /* storage off */ }
            this.stop();
            this.signedOut();
            return true;
          }
          return false;
        })
        .finally(() => {
          this.confirming = null;
          if (this.active) this.schedule();
        });
      return this.confirming;
    }

    async isGone() {
      const token = this.token();
      if (!token) return true; // signed in by its session only: that is over
      let response;
      try {
        response = await this.request('/api/auth/device', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
      } catch (error) {
        return false; // offline: keep the pairing, ask again later
      }
      // Only "this frame is no longer paired" forgets it. A good answer signed it
      // in again (its session had run out); anything else is asked again later.
      return response.status === 401;
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = FrameSession;
    return;
  }
  root.FrameSession = FrameSession;

  // The slideshow page: watch every request from here on (js/slideshow.js starts
  // and stops it, and says what signedOut does)
  if (!root.document || !root.document.getElementById('authOverlay')) return;
  const session = new FrameSession({
    fetch: root.fetch.bind(root),
    signedOut: () => root.authManager && root.authManager.screenRemoved(),
    storage: root.localStorage
  });
  root.fetch = session.fetch;
  root.frameSession = session;
})(typeof self !== 'undefined' ? self : this);
