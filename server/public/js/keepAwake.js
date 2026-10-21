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
 */
class KeepAwake {
    constructor(videoSrc = '/media/keep-awake.mp4') {
        this.enabled = false;
        this.sentinel = null;
        this.video = null;
        this.videoSrc = videoSrc;
        this.useVideo = !('wakeLock' in navigator) || KeepAwake.isLegacyIosStandalone();

        this.hadGesture = false;

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
    }

    get active() {
        return Boolean(this.sentinel && !this.sentinel.released) ||
            Boolean(this.video && !this.video.paused);
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
                if (err.name === 'NotAllowedError' && !this.hadGesture) return;
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
            document.body.appendChild(video);
            this.video = video;
        }
        // Rejected without a gesture; the gesture listeners will retry
        this.video.play().catch(() => {});
    }
}

window.KeepAwake = KeepAwake;
