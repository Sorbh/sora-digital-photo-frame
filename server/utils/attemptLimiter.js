// Counts wrong tries per key (an address, a family...). maxAttempts wrong tries
// within attemptWindow lock the key; each lockout in a row lasts twice as long
// as the one before, up to maxLockout, so a secret can't be worked through a
// few tries at a time. Success clears the key.
class AttemptLimiter {
    constructor({
        maxAttempts = 5,
        attemptWindow = 5 * 60 * 1000,
        lockoutDuration = 15 * 60 * 1000,
        maxLockout = 24 * 60 * 60 * 1000,
        strikeMemory = 24 * 60 * 60 * 1000, // how long a past lockout makes the next one longer
        maxTracked = 10000, // keys remembered at once, so made-up addresses can't grow memory forever
        keep = () => false // keys never dropped to make room
    } = {}) {
        Object.assign(this, { maxAttempts, attemptWindow, lockoutDuration, maxLockout, strikeMemory, maxTracked, keep });
        this.entries = new Map();
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
