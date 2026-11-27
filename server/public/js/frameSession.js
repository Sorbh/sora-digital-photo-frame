/**
 * A playing frame finds out by itself when its screen is removed (or its
 * account deleted), and goes back to its pairing code without anyone touching it.
 *
 * Two ways it hears:
 *   - any request it makes answers 401 (not signed in);
 *   - a light check of its session (GET /api/auth/session) every 15 seconds,
 *     so a frame between two photos notices too.
 *
 * A coded sign-out from the API goes straight back to pairing. If the
 * session simply expires, the frame can still try to renew it with its token.
 * A network error, a 5xx, a 429 or a paused screen (403 SCREEN_PAUSED, which
 * js/screenPause.js shows) never wipes the pairing: it is asked again later.
 *
 *   new FrameSession({ fetch, signedOut, timers, storage, checkMs })
 *   session.fetch(url, options)   the page's fetch, watching each answer
 *   session.start({ viewer }) / stop() while the frame is signed in and playing
 */
(function (root) {
  const TOKEN_KEY = 'photoframe_device_token';
  const CHECK_MS = 15 * 1000;
  // Manual sign-in and pairing have their own error handling.
  const SIGN_IN = /^\/api\/(auth\/pin|pair\/)/;
  const SIGNED_OUT = new Set(['DEVICE_REMOVED', 'DEVICE_UNKNOWN', 'AUTH_REQUIRED']);

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
      this.checking = false;
      this.confirming = null;
      this.fetch = this.fetch.bind(this);
    }

    // fetch() for the page: the same answer, looked at on the way past
    fetch(url, options) {
      return this.request(url, options).then(async (response) => {
        if (this.active && response?.status === 401) {
          const path = pathOf(url);
          if (path.startsWith('/api/') && !SIGN_IN.test(path)) await this.handleUnauthorized(response);
        }
        return response;
      });
    }

    async handleUnauthorized(response) {
      let data;
      try { data = await response.clone().json(); } catch (error) { /* the reply has no readable code */ }
      if (!this.active) return;
      if (SIGNED_OUT.has(data?.code)) this.endSession();
      else this.confirm();
    }

    endSession() {
      if (!this.active) return;
      this.stop();
      try { this.storage && this.storage.removeItem(TOKEN_KEY); } catch (error) { /* storage off */ }
      this.signedOut();
    }

    start({ viewer = false } = {}) {
      this.viewer = viewer;
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
      this.timers.clearTimeout(this.checkTimer);
      this.checkTimer = null;
      if (!this.active || this.checking || this.confirming) return;
      this.checking = true;
      let response;
      try {
        response = await this.request('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
      } catch (error) {
        return this.schedule(); // offline for now
      } finally {
        this.checking = false;
      }
      if (!this.active) return;
      if (response.status === 401) return this.handleUnauthorized(response);
      if (!response.ok) return this.schedule(); // a 5xx, or paused (its card is up)
      let data = null;
      try { data = await response.json(); } catch (error) { /* not an answer */ }
      if (data && (data.authenticated === false || (this.viewer && data.viewer === false))) return this.confirm();
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
            this.endSession();
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
          body: JSON.stringify({ token, ...await root.SoraDevice?.advertise(root.navigator) })
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
