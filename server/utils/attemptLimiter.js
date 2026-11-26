// Counts wrong tries per key (an address, a family...). maxAttempts wrong tries
// within attemptWindow lock the key; each lockout in a row lasts twice as long
// as the one before, up to maxLockout, so a secret can't be worked through a
// few tries at a time. Success clears the key.
//
// Tries can be counted before checking them (fail, then clear or forget), or,
// with begin/end, held as "being checked" and counted only once known to be
// wrong: then right tries never use anything up, and a burst still can't get
// more than the tries left checked at once.
class AttemptLimiter {
    constructor({
        maxAttempts = 5,
        attemptWindow = 5 * 60 * 1000,
        lockoutDuration = 15 * 60 * 1000,
        maxLockout = 24 * 60 * 60 * 1000,
        strikeMemory = 24 * 60 * 60 * 1000, // how long a past lockout makes the next one longer
        maxTracked = 10000, // keys remembered at once, so made-up addresses can't grow memory forever
        keep = () => false, // keys never dropped to make room
        maxWait = 10 * 1000, // how long begin() waits for tries being checked
        onLockout = () => {} // (key, { lockoutUntil, lockouts, lastLockout }) when a lockout starts; may return a promise
    } = {}) {
        Object.assign(this, { maxAttempts, attemptWindow, lockoutDuration, maxLockout, strikeMemory, maxTracked, keep, maxWait, onLockout });
        this.entries = new Map();
        this.pending = new Map(); // key -> tries being checked
        this.waiting = new Map(); // key -> callbacks for when one finishes
    }

    check(key) {
        const now = Date.now();
        const record = this.entries.get(key);

        if (!record) {
            return { allowed: true, attemptsRemaining: this.maxAttempts };
        }

        if (record.lockoutUntil != null && now < record.lockoutUntil) {
            return this.locked(record.lockoutUntil - now);
        }

        if (record.lockoutUntil != null) {
            // The lockout is over: a fresh set of tries, but the next lockout is longer
            record.attempts = 0;
            record.firstAttempt = null;
            record.lockoutUntil = null;
        }

        // Tries spread out over a long time don't add up
        if (record.firstAttempt != null && (now - record.firstAttempt) > this.attemptWindow) {
            record.attempts = 0;
            record.firstAttempt = null;
        }
        if (!record.attempts && (record.lastLockout == null || now - record.lastLockout > this.strikeMemory)) {
            this.entries.delete(key);
            return { allowed: true, attemptsRemaining: this.maxAttempts };
        }

        if (record.attempts >= this.maxAttempts) {
            const duration = Math.min(this.lockoutDuration * 2 ** (record.lockouts || 0), this.maxLockout);
            record.lockouts = (record.lockouts || 0) + 1;
            record.lockoutUntil = now + duration;
            record.lastLockout = now;
            // begin() answers only once this is done (saving the lockout, say)
            record.saving = new Promise(resolve => resolve(
                this.onLockout(key, { lockoutUntil: record.lockoutUntil, lockouts: record.lockouts, lastLockout: now })
            )).catch(() => {});
            return this.locked(duration);
        }

        return {
            allowed: true,
            attemptsRemaining: this.maxAttempts - record.attempts
        };
    }

    locked(ms) {
        const remainingTime = Math.ceil(ms / 1000 / 60); // minutes
        return {
            allowed: false,
            locked: true,
            remainingTime,
            message: `Too many failed attempts. Try again in ${remainingTime} minutes.`
        };
    }

    // Count a try before checking it, and clear it on success, so a burst of
    // requests sent at once can't all get in before the first answer.
    fail(key) {
        const now = Date.now();
        const record = this.entries.get(key);

        if (!record) {
            if (this.entries.size >= this.maxTracked) this.prune(now);
            this.entries.set(key, { attempts: 1, firstAttempt: now, lockoutUntil: null, lockouts: 0, lastLockout: null });
        } else {
            record.attempts += 1;
            if (record.firstAttempt == null) record.firstAttempt = now;
        }
    }

    // Take back a try that turned out not to count
    forget(key) {
        const record = this.entries.get(key);
        if (record && record.attempts > 0) record.attempts -= 1;
    }

    clear(key) {
        this.entries.delete(key);
    }

    // Starts checking a try. Allowed while the wrong tries so far plus those
    // being checked leave room; otherwise waits (up to maxWait) for one to finish.
    async begin(key) {
        const until = Date.now() + this.maxWait;
        for (;;) {
            const status = this.check(key);
            if (!status.allowed) {
                await this.entries.get(key)?.saving;
                return status;
            }
            const pending = this.pending.get(key) || 0;
            if (this.maxAttempts - status.attemptsRemaining + pending < this.maxAttempts) {
                this.pending.set(key, pending + 1);
                return status;
            }
            const left = until - Date.now();
            if (left <= 0) return this.locked(60 * 1000);
            await new Promise(resolve => {
                if (!this.waiting.has(key)) this.waiting.set(key, []);
                const queue = this.waiting.get(key);
                const wake = () => { clearTimeout(timer); resolve(); };
                // Gave up waiting: out of the queue, so stalled checks don't pile up callbacks
                const timer = setTimeout(() => {
                    const at = queue.indexOf(wake);
                    if (at !== -1) queue.splice(at, 1);
                    if (!queue.length && this.waiting.get(key) === queue) this.waiting.delete(key);
                    resolve();
                }, left);
                queue.push(wake);
            });
        }
    }

    // Finishes a try from begin(): counted only if it was wrong
    end(key, wrong) {
        if (wrong) this.fail(key);
        const pending = (this.pending.get(key) || 1) - 1;
        if (pending) this.pending.set(key, pending);
        else this.pending.delete(key);
        const waiting = this.waiting.get(key);
        this.waiting.delete(key);
        if (waiting) waiting.forEach(wake => wake());
    }

    // A lockout kept from before a restart
    restore(key, { lockoutUntil, lockouts, lastLockout }) {
        if (this.entries.has(key)) return;
        this.entries.set(key, { attempts: this.maxAttempts, firstAttempt: lastLockout, lockoutUntil, lockouts, lastLockout });
    }

    // Many made-up addresses must not grow memory without end
    prune(now) {
        for (const [key, record] of this.entries) {
            const lockedNow = record.lockoutUntil != null && now < record.lockoutUntil;
            const remembered = record.lastLockout != null && now - record.lastLockout <= this.strikeMemory;
            const recent = record.firstAttempt != null && now - record.firstAttempt <= this.attemptWindow;
            if (!lockedNow && !remembered && !recent) this.entries.delete(key);
        }
        // Still full of live entries: drop the oldest ones, except those marked to keep
        for (const key of this.entries.keys()) {
            if (this.entries.size < this.maxTracked) break;
            if (!this.keep(key)) this.entries.delete(key);
        }
    }
}

module.exports = AttemptLimiter;
