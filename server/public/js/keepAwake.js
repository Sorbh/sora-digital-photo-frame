/**
 * KeepAwake - stops phones and tablets from dimming/locking while the frame runs.
 *
 * Uses the Screen Wake Lock API where it works, and falls back to a tiny muted
 * looping video (the NoSleep technique) on browsers without it, including older
 * iOS and iOS home-screen apps before 18.4 where the API exists but does nothing.
 *
 * Browsers only grant either one after a user gesture and only while the page is
 * visible, and they drop the lock on tab switch, battery saver, or fullscreen
 * changes, so we re-acquire on every one of those events.
 *
 * `status` says how it went, for the frame to tell the user, and `onchange`
 * is called whenever it changes:
 *   'pending'      not tried yet
 *   'active'       the screen is kept on
 *   'needs-tap'    the browser wants a tap (or a key press) on the device first
 *   'unavailable'  refused even after a tap: the device's own sleep setting decides
 */
class KeepAwake {
    constructor(videoSrc = '/media/keep-awake.mp4') {
        this.enabled = false;
        this.sentinel = null;
        this.video = null;
        this.videoSrc = videoSrc;
        this.useVideo = !('wakeLock' in navigator) || KeepAwake.isLegacyIosStandalone();

        this.hadGesture = false;
        this.status = 'pending';
        this.onchange = null;

        this.reacquire = this.reacquire.bind(this);
        this.onGesture = this.onGesture.bind(this);
        this.onVisibility = this.onVisibility.bind(this);
    }

    static isLegacyIosStandalone() {
        const standalone = window.navigator.standalone === true;
        const match = navigator.userAgent.match(/OS (\d+)_(\d+)/);
        if (!standalone || !match) return false;
        const [major, minor] = [Number(match[1]), Number(match[2])];
        return major < 18 || (major === 18 && minor < 4);
    }

    enable() {
        if (this.enabled) return;
        this.enabled = true;

        document.addEventListener('visibilitychange', this.onVisibility);
        document.addEventListener('fullscreenchange', this.reacquire);
        document.addEventListener('webkitfullscreenchange', this.reacquire);
        // Gestures are what unlock the lock on mobile; keep listening so we can recover
        ['click', 'touchend', 'keydown'].forEach(type =>
            document.addEventListener(type, this.onGesture, { passive: true }));

        this.reacquire();
    }

    disable() {
        this.enabled = false;

        document.removeEventListener('visibilitychange', this.onVisibility);
        document.removeEventListener('fullscreenchange', this.reacquire);
        document.removeEventListener('webkitfullscreenchange', this.reacquire);
        ['click', 'touchend', 'keydown'].forEach(type =>
            document.removeEventListener(type, this.onGesture));

        if (this.sentinel) {
            this.sentinel.release().catch(() => {});
            this.sentinel = null;
        }
        if (this.video) this.video.pause();
        this.setStatus('pending'); // enable() again tries afresh
    }

    get active() {
        return Boolean(this.sentinel && !this.sentinel.released) ||
            Boolean(this.video && !this.video.paused);
    }

    setStatus(status) {
        if (status === this.status) return;
        this.status = status;
        if (this.onchange) this.onchange(status);
    }

    onGesture() {
        this.hadGesture = true;
        this.reacquire();
    }

    onVisibility() {
        if (document.visibilityState === 'visible') this.reacquire();
    }

    async reacquire() {
        if (!this.enabled || document.visibilityState !== 'visible' || this.active) return;

        if (!this.useVideo) {
            try {
                this.sentinel = await navigator.wakeLock.request('screen');
                this.setStatus('active');
                this.sentinel.addEventListener('release', () => {
                    this.sentinel = null;
                    // The system released it (not us) - try again straight away
                    if (this.enabled) this.reacquire();
                });
                return;
            } catch (err) {
                // Before the first gesture a refusal is expected and the gesture listeners
                // retry. Refused after a gesture (permission policy, power saving), or any
                // other error, means the API won't help here - switch to the video.
                if (err.name === 'NotAllowedError' && !this.hadGesture) return this.setStatus('needs-tap');
                this.useVideo = true;
            }
        }

        this.playVideo();
    }

    playVideo() {
        if (!this.video) {
            const video = document.createElement('video');
            video.src = this.videoSrc;
            video.muted = true;
            video.loop = true;
            video.playsInline = true;
            video.setAttribute('playsinline', '');
            video.setAttribute('muted', '');
            video.setAttribute('aria-hidden', 'true');
            video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0.01;pointer-events:none;left:0;top:0;';
            // Playback is what keeps the screen on, so trust these over play()'s answer
            video.addEventListener('playing', () => { if (this.enabled) this.setStatus('active'); });
            video.addEventListener('error', () => this.setStatus('unavailable')); // can't decode it: a tap won't help
            document.body.appendChild(video);
            this.video = video;
        }
        // Rejected without a gesture; the gesture listeners will retry
        const playing = this.video.play();
        if (!playing || !playing.then) {
            // Older browsers return nothing: the 'playing' event says it worked, and
            // still paused a moment later means it didn't
            clearTimeout(this.playCheck);
            this.playCheck = setTimeout(() => {
                if (this.enabled && this.video.paused) this.setStatus(this.hadGesture ? 'unavailable' : 'needs-tap');
            }, 3000);
            return;
        }
        playing
            .then(() => this.setStatus('active'))
            .catch(err => {
                // NotSupportedError: this device can't play the video at all, so a tap won't help
                const hopeless = this.hadGesture || (err && err.name === 'NotSupportedError');
                this.setStatus(hopeless ? 'unavailable' : 'needs-tap');
            });
    }
}

if (typeof module !== 'undefined' && module.exports) module.exports = KeepAwake;
else window.KeepAwake = KeepAwake;
