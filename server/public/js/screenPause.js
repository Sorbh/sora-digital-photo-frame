/**
 * A screen the host has paused. Any of the frame's requests can answer 403 with
 * code SCREEN_PAUSED and the host's message (a plan with fewer screens, say).
 * The frame then shows a calm full-screen card with that message, keeps its
 * token, and checks again every few minutes. Once it is let in again, it
 * reloads, signs in with the same token and plays on: nobody has to touch it.
 *
 * Self-hosted servers never pause a screen, so this only ever waits.
 *
 *   new ScreenPause({ fetch, show, hide, reload, timers, storage, checkMs })
 *   pause.fetch(url, options)   the page's fetch, watching each answer
 */
(function (root) {
  const TOKEN_KEY = 'photoframe_device_token';
  const CHECK_MS = 3 * 60 * 1000;

  class ScreenPause {
    constructor({ fetch, show, reload, timers, storage, checkMs = CHECK_MS } = {}) {
      this.request = fetch; // the browser's own fetch, unwatched
      this.show = show; // show(message): the card, with the host's message (or null)
      this.reload = reload;
      this.timers = timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };
      this.storage = storage;
      this.checkMs = checkMs;
      this.paused = false;
      this.checkTimer = null;
      this.fetch = this.fetch.bind(this);
    }

    // fetch() for the page: the same answer, looked at on the way past
    fetch(url, options) {
      return this.request(url, options).then((response) => {
        this.inspect(response);
        return response;
      });
    }

    // True (resolves) when the answer says this screen is paused
    async isPaused(response) {
      if (!response || response.status !== 403 || typeof response.clone !== 'function') return null;
      try {
        const data = await response.clone().json();
        return data && data.code === 'SCREEN_PAUSED' ? data : null;
      } catch (error) {
        return null; // not JSON: not ours
      }
    }

    async inspect(response) {
      const data = await this.isPaused(response);
      if (data) this.pause(data.message || data.error || null);
    }

    pause(message) {
      this.paused = true;
      this.show(message);
      if (!this.checkTimer) this.scheduleCheck();
    }

    scheduleCheck() {
      this.timers.clearTimeout(this.checkTimer);
      this.checkTimer = this.timers.setTimeout(() => this.check(), this.checkMs);
    }

    // Asks again as the frame: with its token if it has one (the token is never
    // dropped here), else with its session
    async check() {
      this.checkTimer = null;
      let token = null;
      try { token = this.storage && this.storage.getItem(TOKEN_KEY); } catch (error) { /* storage off */ }
      let response;
      try {
        response = token
          ? await this.request('/api/auth/device', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, ...await root.SoraDevice?.advertise(root.navigator) })
          })
          : await this.request('/api/folders', { credentials: 'same-origin' });
      } catch (error) {
        return this.scheduleCheck(); // offline for now: ask again later
      }
      const data = await this.isPaused(response);
      if (data) {
        this.show(data.message || data.error || null); // the host may say something new
        return this.scheduleCheck();
      }
      if (response.status >= 500) return this.scheduleCheck();
      // Let in (or no longer paired, which the sign-in screen shows): start afresh
      this.paused = false;
      this.reload();
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ScreenPause;
    return;
  }
  root.ScreenPause = ScreenPause;

  // The slideshow page: watch every request from here on
  const card = root.document && root.document.getElementById('pausedScreen');
  if (!card) return;
  const text = root.document.getElementById('pausedMessage');
  let hostMessage = null;
  const render = () => {
    text.textContent = hostMessage || (root.t ? root.t('slideshow.screenPausedMessage') : '');
  };
  const pause = new ScreenPause({
    fetch: root.fetch.bind(root),
    show: (message) => {
      hostMessage = message;
      render();
      card.classList.remove('hidden');
    },
    reload: () => root.location.reload(),
    storage: root.localStorage
  });
  root.fetch = pause.fetch;
  root.screenPause = pause;
  root.addEventListener('sora:languagechange', render);
})(typeof self !== 'undefined' ? self : this);
