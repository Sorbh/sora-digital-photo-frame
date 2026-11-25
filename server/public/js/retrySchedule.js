/**
 * How long a frame waits before trying again after it could not show a photo:
 * 5 seconds, then twice as long each time, up to 5 minutes. A frame nobody is
 * watching gets going again by itself once the Wi-Fi or the server is back,
 * without hammering either while they are down.
 */
(function (root) {
  class RetrySchedule {
    constructor({ first = 5000, max = 5 * 60 * 1000 } = {}) {
      this.first = first;
      this.max = max;
      this.tries = 0;
    }

    // The wait before the next try; each call counts as one more failed try
    next() {
      const delay = Math.min(this.first * 2 ** this.tries, this.max);
      if (delay < this.max) this.tries += 1;
      return delay;
    }

    // A photo showed: the next failure starts again from the first wait
    reset() {
      this.tries = 0;
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = RetrySchedule;
  else root.RetrySchedule = RetrySchedule;
})(typeof self !== 'undefined' ? self : this);
