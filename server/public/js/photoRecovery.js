/**
 * Getting a frame to show its first photo (after starting, signing in, or
 * picking a folder), and trying again until it does.
 *
 *   start()    a new start: anything still running from before is dropped
 *   tryNow()   the Retry button, or the network coming back: stop waiting and
 *              stop any try that is still running, and try again now
 *   stop()     signed out: drop everything, show nothing
 *   done()     a photo showed some other way (the Next button)
 *
 * Each try gets an AbortSignal that is aborted when it takes longer than
 * `timeoutMs`, or when tryNow/start/stop replace it, so a request the server
 * never answers can't hold the frame on the error card. A try that was
 * replaced is ignored when it finishes.
 *
 * `attempt(signal, isCurrent)` shows a photo and resolves { ok: true }, or
 * resolves { ok: false, error } with what to tell the user; it checks
 * isCurrent() before putting anything on screen. On failure the next try is
 * scheduled by `schedule` (RetrySchedule), and `failed(error)` shows the error
 * card. With a good photo up (`photoOnScreen()`), the network or the server
 * being away for a while (offline, timeout, a load that failed: `transient`)
 * leaves that photo there quietly; an error the user has to act on (it has a
 * message `key` without `transient`: an empty folder, no access) still shows
 * the card, as a new folder that can't play must not look like the old one.
 */
(function (root) {
  class PhotoRecovery {
    constructor({ attempt, failed, photoOnScreen = () => false, schedule, timeoutMs = 30000, timers } = {}) {
      this.attempt = attempt;
      this.failed = failed;
      this.photoOnScreen = photoOnScreen;
      this.schedule = schedule;
      this.timeoutMs = timeoutMs;
      this.timers = timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };
      this.current = null; // the try running now: { controller }
      this.retryTimer = null;
      this.active = false; // between start() and a photo showing (or stop())
      // Goes up on every start() and stop(): slideshow work begun under an older
      // number (a Next for the previous folder, say) must not count any more
      this.generation = 0;
    }

    get recovering() {
      return this.active;
    }

    start() {
      this.generation += 1;
      this.schedule.reset();
      this.active = true;
      return this.run();
    }

    tryNow() {
      if (!this.active) return this.start();
      return this.run();
    }

    // Wire the Retry button and the browser's `online` event
    listen(target, retryButton) {
      target.addEventListener('online', () => {
        if (this.active) this.tryNow();
      });
      if (retryButton) retryButton.addEventListener('click', () => this.tryNow());
    }

    stop() {
      this.generation += 1;
      this.active = false;
      this.cancel();
    }

    done() {
      this.active = false;
      this.cancel();
      this.schedule.reset();
    }

    cancel() {
      this.timers.clearTimeout(this.retryTimer);
      this.retryTimer = null;
      if (this.current) this.current.controller.abort();
      this.current = null;
    }

    async run() {
      this.cancel();
      const controller = typeof AbortController === 'function' ? new AbortController() : { signal: undefined, abort() {} };
      const current = { controller };
      this.current = current;
      const isCurrent = () => this.current === current;
      // A try that takes too long counts as failed, even if the browser can't abort it
      const timeout = this.timers.setTimeout(() => {
        if (isCurrent()) this.finish(current, { ok: false, error: { timeout: true } });
      }, this.timeoutMs);

      let result;
      try {
        result = await this.attempt(controller.signal, isCurrent);
      } catch (error) {
        result = { ok: false, error };
      } finally {
        this.timers.clearTimeout(timeout);
      }
      if (!isCurrent()) return 'replaced'; // timed out, or tryNow, start or stop came first
      return this.finish(current, result);
    }

    finish(current, result) {
      this.current = null;
      if (result && result.ok) {
        this.active = false;
        this.schedule.reset();
        return 'shown';
      }
      current.controller.abort(); // a request still running is not needed any more
      const error = result && result.error;
      // A photo already on screen stays through a network blip; the card is for
      // an empty screen, or for something the user has to fix
      if (!this.photoOnScreen() || PhotoRecovery.mustShow(error)) this.failed(error);
      else console.warn('Keeping the last photo on screen:', error);
      this.retryTimer = this.timers.setTimeout(() => {
        this.retryTimer = null;
        this.run();
      }, this.schedule.next());
      return 'failed';
    }
  }

  // An error to show even over a photo: one that says what is wrong (an empty
  // folder, access restricted), not the network or server being away
  PhotoRecovery.mustShow = function (error) {
    return Boolean(error && error.key && !error.transient);
  };

  // `promise`, or a rejection after `ms` if it hasn't settled by then
  PhotoRecovery.withTimeout = function (promise, ms, timers) {
    const t = timers || { setTimeout: (fn, wait) => setTimeout(fn, wait), clearTimeout: id => clearTimeout(id) };
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = t.setTimeout(() => reject(Object.assign(new Error('Timed out'), { name: 'TimeoutError' })), ms);
    });
    return Promise.race([promise, timeout]).finally(() => t.clearTimeout(timer));
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PhotoRecovery;
  else root.PhotoRecovery = PhotoRecovery;
})(typeof self !== 'undefined' ? self : this);
