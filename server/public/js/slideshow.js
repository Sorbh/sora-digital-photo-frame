const DEVICE_TOKEN_KEY = 'photoframe_device_token';
const FAMILY_CODE_KEY = 'photoframe_family_code';
const RENEW_MS = 6 * 60 * 60 * 1000; // sessions last a day; paired frames sign in again well before

class AuthenticationManager {
    constructor() {
        this.isAuthenticated = false;
        this.authOverlay = document.getElementById('authOverlay');
        this.pinForm = document.getElementById('pinForm');
        this.pinInput = document.getElementById('pinInput');
        this.familyField = document.getElementById('familyField');
        this.familyInput = document.getElementById('familyCodeInput');
        this.authSub = document.querySelector('.auth-sub');
        this.familyCodeRequired = false; // hosted: a PIN also needs the family code
        this.signInGeneration = 0; // a sign-in typed by hand outranks one still retrying from the address
        this.authButton = document.getElementById('authButton');
        this.authErrorAlert = document.getElementById('authErrorAlert');
        this.authErrorMessage = document.getElementById('authErrorMessage');
        this.authLoading = document.getElementById('authLoading');
        this.pairCard = document.getElementById('pairCard');
        this.pairQr = document.getElementById('pairQr');
        this.pairCode = document.getElementById('pairCode');
        this.pairHint = document.getElementById('pairHint') || document.querySelector('.pair-code-label');
        this.pairStatus = document.getElementById('pairStatus');
        this.pairUrlText = null; // host/pair once a code is shown
        // Off (the server says so on <html>): no PIN pad and no #pin= sign-in, only
        // the pairing code and QR, so a TV with only a remote needs nothing typed
        this.pinSignIn = document.documentElement.dataset.pinSignIn !== 'off';
        if (!this.pinSignIn) this.hidePinSignIn();

        this.init();
    }

    // Only the pairing code and QR on the sign-in screen
    hidePinSignIn() {
        this.pinSignIn = false;
        this.authOverlay.classList.add('pin-off');
        this.pinForm.hidden = true;
        if (this.authSub) {
            this.authSub.dataset.i18n = 'slideshow.connect_with_code';
            this.authSub.textContent = t('slideshow.connect_with_code');
        }
        const pairTitle = document.getElementById('pairTitle');
        if (pairTitle) {
            pairTitle.dataset.i18n = 'slideshow.connect_screen';
            pairTitle.textContent = t('slideshow.connect_screen');
        }
    }

    // "Or open example.com/pair and check the code" is one sentence with the address inside
    renderPairHint() {
        if (!this.pairHint) return;
        const url = document.createElement('span');
        url.id = 'pairUrl';
        url.dir = 'ltr'; // keeps "192.168.1.5:3000/pair" in order inside right-to-left text
        url.textContent = this.pairUrlText || t('slideshow.static_001');
        this.pairHint.innerHTML = t('slideshow.pairHint', { url: url.outerHTML });
    }

    // Re-draws the text this class sets itself, in the current language
    renderLanguage() {
        this.renderPairHint();
        if (this.pairStatusText) this.pairStatus.textContent = t(...this.pairStatusText);
        if (this.errorText) this.authErrorMessage.textContent = t(...this.errorText);
    }

    setPairStatus(key, vars) {
        this.pairStatusText = key ? [key, vars] : null;
        this.pairStatus.textContent = key ? t(key, vars) : '';
    }

    init() {
        this.bindEvents();
        // Opening /slideshow#pin=... on this page again doesn't reload it: read it then too
        window.addEventListener('hashchange', () => {
            if (!/(?:^#|&)(?:pin|family)=/.test(location.hash)) return;
            const pin = this.takeSignInFromUrl();
            if (!pin || this.isAuthenticated) return;
            this.signInGeneration += 1;
            this.cancelUrlSignIn();
            this.signInFromUrl(pin);
        });
        // Frames with no keyboard can open /slideshow#pin=123456 (hosted: &family=ABCD-EFGH)
        // and sign in by themselves. A browser that already is a screen uses its token first.
        const urlPin = this.takeSignInFromUrl();
        const deviceToken = localStorage.getItem(DEVICE_TOKEN_KEY);
        if (deviceToken) {
            this.signInAsDevice(deviceToken, urlPin);
        } else if (urlPin) {
            this.signInFromUrl(urlPin);
        } else {
            this.checkExistingSession();
        }
    }

    // The PIN and family code from the address, kept in memory only. slideshow.html
    // takes them out of the address before anything loads; this also covers pages
    // that open the script without that.
    takeSignInFromUrl() {
        const early = window.soraUrlSignIn;
        window.soraUrlSignIn = null;
        if (early && this.pinSignIn) {
            this.urlFamilyCode = early.family || '';
            return early.pin || undefined;
        }
        // The head script didn't run (e.g. a policy that blocks inline scripts): same
        // thing here. Only #pin=&family= signs in; ?pin= and ?family= went to the
        // server already, so they are only taken out of the address, never used.
        const url = new URL(location.href);
        const query = url.searchParams;
        const fragment = new URLSearchParams(url.hash.slice(1));
        const inQuery = query.has('pin') || query.has('family');
        const inFragment = fragment.has('pin') || fragment.has('family');
        const pick = name => (fragment.get(name) || '').trim();
        const pin = pick('pin') || undefined;
        this.urlFamilyCode = pick('family');
        if (inQuery || inFragment) {
            ['pin', 'family'].forEach(name => { query.delete(name); fragment.delete(name); });
            const hash = inFragment ? (String(fragment) ? `#${fragment}` : '') : url.hash;
            history.replaceState(history.state, '', url.pathname + url.search + hash);
        }
        // PIN sign-in off: the address is cleaned, its PIN never used
        if (!this.pinSignIn) {
            this.urlFamilyCode = '';
            return undefined;
        }
        return pin;
    }

    // Keep a frame that is left running signed in to its account
    keepSignedIn(signIn) {
        clearInterval(this.renewTimer);
        this.renewTimer = setInterval(() => signIn().catch(() => {}), RENEW_MS);
    }

    // A screen (paired by QR code or signed in by PIN) signs in with the token it was given
    async signInAsDevice(token, fallbackPin) {
        try {
            const data = await this.requestDevice(token);
            if (data.success) {
                this.useScreenLanguage(data.device?.language);
                this.handleAuthSuccess(data.account);
                this.keepSignedIn(() => this.requestDevice(token));
                return;
            }
            if (data.code === 'DEVICE_UNKNOWN') localStorage.removeItem(DEVICE_TOKEN_KEY);
            // Paused by the host: the token is kept, and the paused card (js/screenPause.js)
            // checks again by itself, so no pairing code or PIN pad meanwhile
            if (data.code === 'SCREEN_PAUSED') return;
        } catch (error) {
            console.error('Signing in as a paired frame failed:', error);
        }
        if (fallbackPin) return this.signInFromUrl(fallbackPin);
        this.checkExistingSession();
    }

    // A PIN sign-in made this browser a screen: keep its token, as a QR pairing does
    keepScreen(data) {
        if (data.token) {
            localStorage.setItem(DEVICE_TOKEN_KEY, data.token);
            this.keepSignedIn(() => this.requestDevice(data.token));
        }
        const familyCode = this.familyCodeValue().toUpperCase();
        if (familyCode) localStorage.setItem(FAMILY_CODE_KEY, familyCode);
        this.useScreenLanguage(data.device?.language);
    }

    // The family code typed in, from the address, or remembered from last time
    familyCodeValue() {
        const typed = this.familyInput?.value.trim();
        return typed || this.urlFamilyCode || localStorage.getItem(FAMILY_CODE_KEY) || '';
    }

    // Hosted: show the family code field above the PIN
    showFamilyField() {
        this.familyCodeRequired = true;
        if (!this.familyField) return;
        this.familyField.classList.remove('hidden');
        if (!this.familyInput.value) this.familyInput.value = this.familyCodeValue();
        if (this.authSub) {
            this.authSub.dataset.i18n = 'slideshow.enter_code_pin';
            this.authSub.textContent = t('slideshow.enter_code_pin');
        }
    }

    async requestDevice(token) {
        const response = await fetch('/api/auth/device', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });
        return response.json();
    }

    // Show a QR code an admin can scan to sign this frame in, and wait for them
    async startPairing() {
        if (!this.pairCard || this.pairing) return;
        this.pairing = { starting: true };
        this.pairCard.classList.remove('is-approved', 'is-error');
        this.setPairStatus(null);
        try {
            const response = await fetch('/api/pair/start', { method: 'POST' });
            const data = await response.json();
            if (!this.pairing) return; // signed in meanwhile
            if (!data.success) throw new Error(data.error || 'Could not get a code');

            this.pairing = { code: data.code, secret: data.secret, expiresAt: data.expiresAt };
            this.pairQr.innerHTML = data.qr; // an SVG drawn by our server
            this.pairCode.textContent = `${data.code.slice(0, 3)}-${data.code.slice(3)}`;
            this.pairUrlText = `${new URL(data.url).host}/pair`;
            this.renderPairHint();
            this.pairTimer = setTimeout(() => this.checkPairing(), 2000);
        } catch (error) {
            console.error('Pairing could not start:', error);
            this.pairing = null;
            this.pairQr.innerHTML = '';
            this.pairCode.textContent = '······';
            this.pairCard.classList.add('is-error');
            this.setPairStatus('slideshow.noCode');
            this.pairTimer = setTimeout(() => this.startPairing(), 60 * 1000);
        }
    }

    async checkPairing() {
        const pairing = this.pairing;
        if (!pairing?.code) return;
        if (Date.now() > pairing.expiresAt) return this.restartPairing();

        let data;
        try {
            // The secret goes in the body, never the URL, which proxies may log
            const ask = path => fetch(path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: pairing.code, secret: pairing.secret })
            }).then(response => response.json());
            data = await ask('/api/pair/status');
            if (this.pairing !== pairing) return;
            // Approved: collect the token, which also signs this browser in. A
            // sign-in from the address still under way would replace it: stop it first.
            if (data?.status === 'ready') {
                this.outrankUrlSignIn();
                data = await ask('/api/pair/collect');
            }
        } catch (error) {
            data = null; // offline for a moment: keep waiting
        }
        if (this.pairing !== pairing) return;

        if (data?.status === 'approved') {
            // Signed in now, though the overlay stays a moment to say so: nothing
            // from the address may replace this sign-in meanwhile
            this.outrankUrlSignIn();
            localStorage.setItem(DEVICE_TOKEN_KEY, data.token);
            this.pairCard.classList.add('is-approved');
            this.useScreenLanguage(data.device?.language);
            this.setPairStatus('slideshow.paired_as', { name: data.device.name });
            this.keepSignedIn(() => this.requestDevice(data.token));
            setTimeout(() => this.handleAuthSuccess(data.account), 700);
        } else if (data?.status === 'expired') {
            this.restartPairing();
        } else {
            this.pairTimer = setTimeout(() => this.checkPairing(), data ? 2000 : 5000);
        }
    }

    useScreenLanguage(language) {
        if (!language || !window.i18n) return;
        document.documentElement.dataset.screenLanguage = language;
        // A URL or an explicit browser preference still wins; otherwise this is the frame's language.
        if (!new URLSearchParams(location.search).has('lang') && !localStorage.getItem('sora.lang')) {
            window.i18n.setLanguage(language, false);
        }
    }

    restartPairing() {
        this.stopPairing();
        this.startPairing();
    }

    stopPairing() {
        clearTimeout(this.pairTimer);
        this.pairing = null;
    }

    // The address is clean by now, so a frame with no keyboard keeps trying with the
    // PIN in memory until the network or server is back, or the PIN is refused
    async signInFromUrl(pin, attempt = 0) {
        clearTimeout(this.urlRetryTimer);
        if (this.isAuthenticated) return;
        const generation = this.signInGeneration;
        const outdated = () => generation !== this.signInGeneration || this.isAuthenticated;
        const retry = wait => { this.urlRetryTimer = setTimeout(() => this.signInFromUrl(pin, attempt + 1), wait); };
        const request = new AbortController();
        this.urlSignIn = request;
        try {
            const data = await this.requestPin(pin, request.signal);
            if (outdated()) return; // signed in, or a PIN was typed, meanwhile
            if (!data.success) {
                this.showAuthOverlay();
                // Too many tries just now: the form's own wait tries the same PIN again
                // once it is over, unless a PIN was typed or the frame signed in meanwhile
                this.handleAuthError(data.error, data.code, data, () => { if (!outdated()) this.signInFromUrl(pin, attempt + 1); });
                return;
            }
            this.keepScreen(data);
            this.handleAuthSuccess(data.account);
        } catch (error) {
            if (outdated()) return;
            console.error('Sign-in from the address failed:', error);
            this.showAuthOverlay();
            this.showErrorKey('errors.connection');
            retry(Math.min(5000 * 2 ** attempt, 60000));
        } finally {
            if (this.urlSignIn === request) this.urlSignIn = null;
        }
    }

    // Stops a sign-in from the address that is still waiting for its reply. Its
    // reply would set the session cookie as it arrives, before any script can
    // ignore it, and so replace a sign-in made meanwhile. Aborted, the browser
    // drops the reply, cookie included. A reply that came before this was already
    // in place when the newer sign-in was sent, so the newer one's cookie wins.
    cancelUrlSignIn() {
        clearTimeout(this.urlRetryTimer);
        if (this.urlSignIn) this.urlSignIn.abort();
        this.urlSignIn = null;
    }

    // A PIN being typed, or a pairing, outranks a sign-in from the address: stop
    // it, and have any reply or retry of it ignored
    outrankUrlSignIn() {
        this.signInGeneration += 1;
        this.cancelUrlSignIn();
    }

    async requestPin(pin, signal) {
        const response = await fetch('/api/auth/pin', {
            method: 'POST',
            signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pin,
                // Already a screen? Then this browser stays that screen instead of adding one
                token: localStorage.getItem(DEVICE_TOKEN_KEY) || undefined,
                familyCode: this.familyCodeValue() || undefined
            })
        });
        // A server error is not an answer about the PIN: try again later
        if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
        return response.json();
    }

    bindEvents() {
        this.pinForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.authenticate();
        });

        // Someone is typing a PIN (keyboard or keypad): the sign-in from the address
        // must not sign in and hide the form under them
        this.pinInput.addEventListener('input', () => {
            this.outrankUrlSignIn();
            this.clearError();
            this.clearErrorState();
        });

        // Enter in the family code moves on to the PIN instead of submitting a blank one
        this.familyInput?.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            this.pinInput.focus();
        });
        this.familyInput?.addEventListener('input', () => {
            this.outrankUrlSignIn();
            this.clearError();
            this.clearErrorState();
        });

        this.pinCells = document.querySelectorAll('.pin-cell');
        this.pinInput.addEventListener('input', () => {
            this.pinInput.value = this.pinInput.value.replace(/\D/g, '').slice(0, 6);
            this.renderPinCells();
        });

        document.querySelectorAll('.keypad [data-key]').forEach(key => {
            // Keep focus in the PIN field so a hardware keyboard keeps working
            key.addEventListener('mousedown', (e) => e.preventDefault());
            key.addEventListener('click', () => this.pressKey(key.dataset.key));
        });

        this.pinInput.addEventListener('keypress', (e) => {
            // Allow Enter key to submit form
            if (e.key === 'Enter') {
                return;
            }
            // Only allow numeric input
            if (!/[0-9]/.test(e.key) && e.key !== 'Backspace' && e.key !== 'Delete' && e.key !== 'Tab') {
                e.preventDefault();
            }
        });
    }

    pressKey(key) {
        if (this.pinInput.disabled) return;
        const value = this.pinInput.value;
        if (key === 'back') {
            this.pinInput.value = value.slice(0, -1);
        } else if (value.length < 6) {
            this.pinInput.value = value + key;
        }
        this.pinInput.dispatchEvent(new Event('input'));
    }

    renderPinCells() {
        const length = this.pinInput.value.length;
        this.pinCells.forEach((cell, i) => {
            cell.classList.toggle('filled', i < length);
            cell.classList.toggle('is-next', i === length);
        });
    }

    focusPin() {
        // Skip on touch screens so the on-screen keyboard doesn't cover the keypad
        if (this.pinSignIn && matchMedia('(pointer: fine)').matches) this.pinInput.focus();
    }

    async checkExistingSession() {
        try {
            const response = await fetch('/api/auth/session');
            const data = await response.json();
            // Paused by the host: its card is up (js/screenPause.js) and checks again
            // by itself, so no sign-in screen or pairing code underneath
            if (data.code === 'SCREEN_PAUSED') return;

            if (data.authenticated) {
                this.handleAuthSuccess(data.account);
            } else {
                if (data.pinSignIn === false) this.hidePinSignIn();
                else if (data.familyCode) this.showFamilyField();
                this.showAuthOverlay();
            }
        } catch (error) {
            console.error('Session check failed:', error);
            this.showAuthOverlay();
        }
    }

    async authenticate() {
        const pin = this.pinInput.value.trim();

        if (!pin) {
            this.showErrorKey('slideshow.pinRequired');
            return;
        }

        if (pin.length < 4) {
            this.showErrorKey('slideshow.pinTooShort');
            return;
        }

        if (this.familyCodeRequired && this.familyCodeValue().replace(/[^a-z0-9]/gi, '').length !== 8) {
            this.showErrorKey('slideshow.familyCodeRequired');
            this.familyInput?.focus();
            return;
        }

        this.setLoading(true);
        // Typed by hand: this outranks a sign-in from the address, still waiting
        // for its reply or to try again
        this.outrankUrlSignIn();

        try {
            const data = await this.requestPin(pin);

            if (data.success) {
                this.keepScreen(data);
                this.handleAuthSuccess(data.account);
            } else {
                this.handleAuthError(data.error, data.code, data);
            }
        } catch (error) {
            console.error('Authentication error:', error);
            this.showErrorKey('errors.connection');
        } finally {
            this.setLoading(false);
        }
    }

    // Signed in another way, or signed out: the wait after "too many tries" is over
    stopRateLimitWait() {
        clearTimeout(this.rateLimitTimer);
        this.rateLimitTimer = null;
    }

    handleAuthSuccess(account) {
        this.cancelUrlSignIn(); // signed in another way (paired, say): its reply must not replace this one
        this.stopRateLimitWait();
        this.isAuthenticated = true;
        this.userAccount = account;

        sessionStorage.setItem('authenticated', 'true');
        sessionStorage.setItem('accountName', account.name);

        this.hideAuthOverlay();

        document.dispatchEvent(new CustomEvent('authenticationComplete', {
            detail: { account }
        }));
    }

    handleAuthError(error, errorCode, data = {}, retry = null) {
        // Hosted, a wrong family code and a wrong PIN look the same on purpose
        if (errorCode === 'INVALID_PIN' && this.familyCodeRequired) this.showErrorKey('slideshow.familyOrPinWrong');
        else this.showError(i18n.error({ ...data, code: errorCode, message: error || data.message }, 'slideshow.invalidPin'));

        if (errorCode === 'RATE_LIMITED') {
            this.pinInput.disabled = true;
            this.pinInput.classList.add('border-destructive');
            this.authButton.disabled = true;
            // The form comes back when the wait is over (and a bookmarked PIN is tried again)
            this.stopRateLimitWait();
            this.rateLimitTimer = setTimeout(() => {
                this.rateLimitTimer = null;
                this.pinInput.disabled = false;
                this.authButton.disabled = false;
                this.pinInput.classList.remove('border-destructive');
                this.clearError();
                if (retry) retry();
            }, Math.max(1, Number(data.remainingTime) || 1) * 60 * 1000);
        } else {
            this.pinInput.classList.add('border-destructive');
            this.focusPin();
            setTimeout(() => {
                this.pinInput.value = '';
                this.renderPinCells();
            }, 450);
        }
    }

    async logout() {
        try {
            await fetch('/api/auth/session', { method: 'DELETE' });
        } catch (error) {
            console.error('Logout error:', error);
        } finally {
            this.isAuthenticated = false;
            this.userAccount = null;
            this.stopRateLimitWait();
            clearInterval(this.renewTimer);
            localStorage.removeItem(DEVICE_TOKEN_KEY); // signing out unpairs this browser
            sessionStorage.removeItem('authenticated');
            sessionStorage.removeItem('accountName');
            this.showAuthOverlay();
            this.clearForm();

            if (window.slideshow) {
                window.slideshow.cleanup();
            }
        }
    }

    showAuthOverlay() {
        this.authOverlay.classList.remove('hidden');
        setTimeout(() => this.focusPin(), 100);
        this.startPairing();
    }

    hideAuthOverlay() {
        this.authOverlay.classList.add('hidden');
        this.stopPairing();
    }

    setLoading(loading) {
        // Still waiting after "too many tries": the form stays off until then
        const off = loading || Boolean(this.rateLimitTimer);
        this.authButton.disabled = off;
        this.pinInput.disabled = off;

        if (loading) {
            this.authLoading.classList.remove('hidden');
            this.clearError();
        } else {
            this.authLoading.classList.add('hidden');
        }
    }

    showError(message) {
        this.errorText = null;
        this.authErrorMessage.textContent = message;
        this.authErrorAlert.classList.remove('hidden');
    }

    // Same, but kept as a key so it follows a language change
    showErrorKey(key, vars) {
        this.showError(t(key, vars));
        this.errorText = [key, vars];
    }

    clearError() {
        this.errorText = null;
        this.authErrorAlert.classList.add('hidden');
        this.authErrorMessage.textContent = '';
    }

    clearErrorState() {
        this.pinInput.classList.remove('border-destructive');
        this.pinInput.disabled = false;
        this.authButton.disabled = false;
    }

    clearForm() {
        this.pinInput.value = '';
        this.renderPinCells();
        this.clearError();
        this.clearErrorState();
        this.pinInput.disabled = false;
        this.authButton.disabled = false;
    }
}

const LAST_SHOWN_KEY = 'photoframe_last_shown';
const REQUEST_TIMEOUT_MS = 30 * 1000; // a photo request that takes longer counts as failed
const KEY_TIMEOUT_MS = 12 * 1000; // decrypting in the browser: after this, the server copy is used

// Aborted after `ms`, so a request the server never answers can't stall the slideshow
function timeoutSignal(ms) {
    if (typeof AbortController !== 'function') return undefined;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
}

// The element shown fullscreen, whichever prefix this browser uses
function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement || null;
}

// "12 March 2019" in the frame's language. Camera times carry no zone and
// a date-time without one is read as local time, so the day never shifts.
function formatTakenAt(takenAt) {
    const date = takenAt ? new Date(takenAt) : null;
    if (!date || isNaN(date)) return '';
    return date.toLocaleDateString(window.i18n?.locale, { day: 'numeric', month: 'long', year: 'numeric' });
}

class PhotoFrameSlideshow {
    constructor() {
        this.currentSlide = 0;
        // Browser-side decryption (remote encrypted storage only): keys by id, and
        // each slide's object URL so it can be released when the slide is reused
        this.frameKeys = new Map();
        this.objectUrls = [null, null];
        this.isPlaying = true;
        this.interval = Number(document.documentElement.dataset.interval) || 15000; // DEFAULT_SLIDESHOW_INTERVAL
        this.timer = null;
        this.progressTimer = null;
        this.cursorHideTimer = null;
        this.controlsHideTimer = null;
        this.wakeLock = null;
        this.folderSelector = null;
        this.folderStorage = new FolderStorage();
        this.leavingTimers = [null, null];
        this.currentDuration = this.interval;
        // Notes from the top folder, and from the folder this frame plays
        this.noteScheduler = window.NoteScheduler ? new NoteScheduler(() => this.folderStorage.getCurrentFolderPath()) : null;
        this.noteHideTimer = null;
        this.fullscreenCheck = null;
        this.screenShift = window.ScreenShift ? new ScreenShift(document.documentElement) : null;
        // Until a photo shows, a failure leaves the error card up and tries again later
        this.hasShownPhoto = false;
        this.recovery = new PhotoRecovery({
            attempt: (signal, isCurrent) => this.showFirstPhoto(signal, isCurrent),
            failed: error => this.showFailure(error),
            // A photo the error card covers (an empty folder picked, say) is not on screen
            photoOnScreen: () => this.hasShownPhoto && this.errorState.classList.contains('hidden'),
            schedule: new RetrySchedule(),
            timeoutMs: REQUEST_TIMEOUT_MS
        });

        // Ken Burns drift spans the slide plus its crossfade
        document.documentElement.style.setProperty('--slide-duration', `${this.interval + 2000}ms`);

        this.initializeElements();
        this.setupEventListeners();
        this.setupCursorAutoHide();
        this.requestWakeLock();
    }

    initializeElements() {
        this.slides = [
            document.getElementById('slide1'),
            document.getElementById('slide2')
        ];
        this.images = [
            document.getElementById('image1'),
            document.getElementById('image2')
        ];
        this.loadingState = document.getElementById('loadingState');
        this.errorState = document.getElementById('errorState');
        this.errorMessage = document.getElementById('errorMessage');
        this.errorTitle = document.getElementById('errorTitle');
        this.errorIcon = document.getElementById('errorIcon');
        this.progressBar = document.getElementById('progressBar');
        this.fullscreenBtn = document.getElementById('fullscreenBtn');
        this.infoBtn = document.getElementById('infoBtn');
        this.logoutBtn = document.getElementById('logoutBtn');
        this.infoOverlay = document.getElementById('infoOverlay');
        this.ambients = this.slides.map(slide => slide.querySelector('.slide-ambient'));
        this.playPauseBtn = document.getElementById('playPauseBtn');
        this.nextBtn = document.getElementById('nextBtn');
        this.filename = document.getElementById('filename');
        this.folder = document.getElementById('folder');
        this.caption = document.getElementById('photoCaption');
        this.captionPlace = document.getElementById('captionPlace');
        this.captionDate = document.getElementById('captionDate');
        this.noteLayer = document.getElementById('noteLayer');
        this.noticeSlots = { wake: document.getElementById('wakeNotice'), info: document.getElementById('infoNotice') };
        this.keepAwakeBtn = document.getElementById('keepAwakeBtn');
        this.notices = new FrameNotices({ render: (slot, notice) => this.renderNotice(slot, notice) });
        this.retryBtn = document.getElementById('retryBtn');

        this.errorState.classList.add('hidden');
        this.images.forEach(img => img.removeAttribute('src'));
    }

    setupEventListeners() {
        this.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
        this.infoBtn.addEventListener('click', () => this.toggleInfo());
        this.logoutBtn.addEventListener('click', () => this.logout());
        this.playPauseBtn.addEventListener('click', () => this.togglePlayPause());
        this.nextBtn.addEventListener('click', () => this.nextImage());
        // The tap itself is what lets the browser keep the screen on
        this.keepAwakeBtn.addEventListener('click', () => this.wakeLock?.onGesture());
        // Retry, and back online: try again now, without waiting out the delay
        this.recovery.listen(window, this.retryBtn);

        document.addEventListener('keydown', (e) => {
            // Typing in a field (the family code, say) is not a slideshow shortcut
            if (e.target.closest?.('input, textarea, select')) return;
            // Nor are keys in the open folder picker, which has its own (js/folderSelector.js)
            if (e.target.closest?.('#folderSelector.open')) return;
            // Space and Enter on a focused button or link (Retry, say) press it
            if ((e.key === ' ' || e.key === 'Enter') && e.target.closest?.('button, a[href]')) return;
            if (this.handleDockArrows(e)) return;
            switch (e.key) {
                case ' ': // Space
                case 'k':
                case 'K':
                    e.preventDefault();
                    this.togglePlayPause();
                    break;
                case 'ArrowRight':
                case 'n':
                case 'N':
                    e.preventDefault();
                    this.nextImage();
                    break;
                case 'f':
                case 'F':
                    e.preventDefault();
                    this.toggleFullscreen();
                    break;
                case 'i':
                case 'I':
                    e.preventDefault();
                    this.toggleInfo();
                    break;
                case 'Escape':
                    if (document.fullscreenElement) {
                        document.exitFullscreen();
                    }
                    break;
            }
        });

        // Mouse and touch events to show controls
        document.addEventListener('mousemove', () => {
            this.showControlsTemporarily();
        });

        document.addEventListener('touchstart', () => {
            this.showControlsTemporarily();
        });

        document.addEventListener('click', () => {
            this.showControlsTemporarily();
        });

        // Fullscreen came or went (the page's button, the browser's own, or Escape)
        // (any real change answers the prefixed request, so its later check is not needed)
        ['fullscreenchange', 'webkitfullscreenchange', 'MSFullscreenChange'].forEach(type =>
            document.addEventListener(type, () => {
                clearTimeout(this.fullscreenCheck);
                document.body.classList.toggle('fullscreen', Boolean(fullscreenElement()));
            }));
        // Older browsers say no with an event rather than a rejected promise
        ['webkitfullscreenerror', 'MSFullscreenError'].forEach(type =>
            document.addEventListener(type, () => {
                clearTimeout(this.fullscreenCheck);
                this.notices.fullscreen('refused');
            }));
    }

    // The next picture for the chosen folder. Ordered folders continue from
    // the last one shown, even after the frame restarts.
    // Resolves { image }, or { error } to show on the error card
    async fetchRandomImage(signal) {
        try {
            const selectedFolderPath = this.folderStorage.getCurrentFolderPath();
            const params = new URLSearchParams();
            if (selectedFolderPath) params.set('folder', selectedFolderPath);
            const last = this.lastShown();
            if (last && last.folder === (selectedFolderPath || '')) params.set('after', last.id);

            const response = await fetch(`/api/images/next?${params}`, { signal });
            // The server or a proxy in trouble is not an empty folder
            if (response.status >= 500) return { error: { offline: true } };
            // Nothing to show from the saved folder (404), or nothing this frame may see (403:
            // its only folder was deleted, say): if the folder is gone, play all folders
            // instead, which the server still limits to the frame's own folders
            if ((response.status === 404 || response.status === 403) && selectedFolderPath && await this.dropMissingFolder(selectedFolderPath, signal)) {
                return this.fetchRandomImage(signal);
            }
            if (!response.ok) throw new Error(t('slideshow.fetchImageFailed'));
            const data = await response.json();

            if (!data.success) {
                throw new Error(i18n.error(data, 'slideshow.fetchImageFailed'));
            }

            localStorage.setItem(LAST_SHOWN_KEY, JSON.stringify({ folder: selectedFolderPath || '', id: data.image.id }));
            return { image: data.image };
        } catch (error) {
            console.error('Error fetching random image:', error);
            // fetch() itself failed (no network, no server) or took too long
            if (error instanceof TypeError || error.name === 'AbortError') return { error: { offline: true } };
            const folder = this.folderStorage.getCurrentFolderPath() && this.folderStorage.getCurrentFolderName();
            return { error: folder ? { key: 'slideshow.noImagesInFolder', vars: { folder } } : { key: 'slideshow.noImages' } };
        }
    }

    // True when `folder`, the saved folder, no longer exists (or this frame can't
    // open it any more) and was replaced by all folders. Asked on every 404 for it,
    // so a check that can't be made now (offline, the folder list failed to load
    // at start) is made again on the next try.
    async dropMissingFolder(folder, signal) {
        try {
            const response = await fetch(`/api/folders/${encodeURIComponent(folder)}`, { credentials: 'same-origin', signal });
            if (response.status !== 404) return false;
            const data = await response.json().catch(() => ({}));
            if (data.code !== 'FOLDER_NOT_FOUND') return false;
        } catch {
            return false;
        }
        if (this.folderStorage.getCurrentFolderPath() !== folder) return false; // another folder was picked meanwhile
        console.log('The saved folder is gone; playing all folders');
        this.folderStorage.saveSelectedFolder('', 'All Folders');
        this.folderSelector?.updateCurrentSelection();
        this.folderSelector?.updateSelectedState();
        return true;
    }

    lastShown() {
        try {
            return JSON.parse(localStorage.getItem(LAST_SHOWN_KEY));
        } catch {
            return null;
        }
    }

    // Key for browser-side decryption, fetched once per key id
    frameKey(id) {
        if (!this.frameKeys.has(id)) {
            // A key request that hangs is given up and forgotten, so the next try asks again
            const request = fetch(`/api/frame/keys?ids=${encodeURIComponent(id)}`, { credentials: 'same-origin', signal: timeoutSignal(KEY_TIMEOUT_MS) })
                .then(response => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
                .then(({ keys }) => {
                    if (!keys || !keys[id]) throw new Error('Key not available');
                    return Uint8Array.from(atob(keys[id]), c => c.charCodeAt(0));
                })
                .catch((error) => {
                    this.frameKeys.delete(id); // try again with a later photo
                    throw error;
                });
            this.frameKeys.set(id, request);
        }
        return this.frameKeys.get(id);
    }

    // What to put in the <img>: a decrypted object URL when the photo comes
    // encrypted from remote storage and this browser can decrypt, else the
    // server URL (local installs always use the server URL)
    async imageSource(imageData) {
        const cipher = window.SoraPhotoCipher;
        if (imageData.rawUrl && cipher && cipher.supported()) {
            let decrypting = Promise.resolve();
            try {
                decrypting = cipher.loadImage(imageData.rawUrl, id => this.frameKey(id), imageData.mimeType);
                // Slower than the server copy would be: use that instead
                return await PhotoRecovery.withTimeout(decrypting, KEY_TIMEOUT_MS);
            } catch (error) {
                // A download that finishes after that is not used: free its decrypted copy
                decrypting.then(url => url && URL.revokeObjectURL(url), () => {});
                console.warn('Decrypting in the browser failed, using the server copy:', error.message);
            }
        }
        return imageData.url;
    }

    // Loads the photo into the hidden slide; false if it failed or `signal` gave up on it
    // Only the newest load owns the hidden slide: a Retry and a Next loading at
    // once must not both finish on one load event, and a load overtaken by a
    // newer one gives up without touching the newer one's picture.
    async loadImage(imageData, signal) {
        if (!imageData) return false;

        const token = {};
        this.currentLoad = token;
        if (this.cancelLoad) this.cancelLoad(); // the older load, if it was already waiting

        const src = await this.imageSource(imageData);
        const isObjectUrl = src.startsWith('blob:');
        if (this.currentLoad !== token) { // overtaken while fetching or decrypting
            if (isObjectUrl) URL.revokeObjectURL(src);
            return false;
        }

        return new Promise((resolve) => {
            const nextSlide = (this.currentSlide + 1) % 2;
            const img = this.images[nextSlide];

            const stop = () => {
                img.removeEventListener('load', onLoad);
                img.removeEventListener('error', onError);
                signal?.removeEventListener('abort', onAbort);
                if (this.cancelLoad === cancel) this.cancelLoad = null;
            };

            // A newer load took the slide: leave its src alone
            const cancel = () => {
                stop();
                if (isObjectUrl) URL.revokeObjectURL(src);
                resolve(false);
            };

            const onLoad = () => {
                stop();
                this.ambients[nextSlide].style.backgroundImage = `url(${JSON.stringify(src)})`;
                // The slide's previous photo is gone from screen; free its decrypted copy
                if (this.objectUrls[nextSlide]) URL.revokeObjectURL(this.objectUrls[nextSlide]);
                this.objectUrls[nextSlide] = isObjectUrl ? src : null;
                resolve(true);
            };

            const onError = () => {
                stop();
                if (isObjectUrl) URL.revokeObjectURL(src);
                console.error('Failed to load image:', imageData.url);
                resolve(false);
            };

            // Taking too long, or replaced by a newer try: stop downloading it
            const onAbort = () => {
                stop();
                if (this.currentLoad === token) img.removeAttribute('src');
                if (isObjectUrl) URL.revokeObjectURL(src);
                resolve(false);
            };

            if (signal?.aborted) return onAbort();
            this.cancelLoad = cancel;
            img.addEventListener('load', onLoad);
            img.addEventListener('error', onError);
            signal?.addEventListener('abort', onAbort);
            img.src = src;
        });
    }

    showImage() {
        const currentSlideEl = this.slides[this.currentSlide];
        const nextSlideEl = this.slides[(this.currentSlide + 1) % 2];

        const leavingIndex = this.currentSlide;
        currentSlideEl.classList.remove('active');
        currentSlideEl.classList.add('leaving');
        clearTimeout(this.leavingTimers[leavingIndex]);
        this.leavingTimers[leavingIndex] = setTimeout(() => {
            currentSlideEl.classList.remove('leaving');
        }, 2000);

        // Restart the drift animation even if this slide was still leaving
        clearTimeout(this.leavingTimers[(leavingIndex + 1) % 2]);
        nextSlideEl.classList.remove('leaving');
        void nextSlideEl.offsetWidth;
        nextSlideEl.classList.add('active');

        this.currentSlide = (this.currentSlide + 1) % 2;
        this.photoShown();
        this.hideNote();
        this.noteScheduler?.photoShown();
        this.updateInfo();
        this.loadingState.classList.add('hidden');
        this.hideError();
    }

    updateInfo() {
        this.updateCaption();
        if (this.currentImageData) {
            this.filename.textContent = this.currentImageData.filename;
            this.folder.textContent = this.currentImageData.folder || t('common.library');

            // Auto-hide info after 3 seconds if visible
            if (!this.infoOverlay.classList.contains('hidden')) {
                setTimeout(() => {
                    this.infoOverlay.classList.add('hidden');
                }, 3000);
            }
        }
    }

    // Where and when the photo was taken, under the photo (Settings can hide it)
    updateCaption() {
        if (!this.caption) return;
        const data = this.currentImageData;
        const info = data?.type === 'image' ? data.info : null;
        const date = formatTakenAt(info?.takenAt);
        const place = info?.place || '';
        const enabled = localStorage.getItem('photoDetailsEnabled') !== 'false';

        this.caption.classList.remove('is-visible');
        clearTimeout(this.captionTimer);
        if (!enabled || !(date || place)) return;

        // Fade the old words out before the new ones come in
        this.captionTimer = setTimeout(() => {
            this.captionPlace.textContent = place || date;
            this.captionDate.textContent = place ? date : '';
            this.captionDate.hidden = !place || !date;
            this.caption.classList.add('is-visible');
        }, 600);
    }

    async nextImage() {
        this.resetProgress();

        // Every few minutes a note takes the place of the next photo
        const note = this.noteScheduler?.nextDue();
        if (note && await this.showNote(note)) {
            if (this.isPlaying) this.scheduleNext(note.showForSeconds * 1000);
            return;
        }

        // A photo that fails to come is skipped: the last good one stays on screen.
        // Picking a folder (or signing out) meanwhile makes this one too late to show.
        const generation = this.recovery.generation;
        const isCurrent = () => this.recovery.generation === generation;
        const signal = timeoutSignal(REQUEST_TIMEOUT_MS);
        const next = await this.fetchRandomImage(signal);
        if (!isCurrent()) return;
        if (next.image) await this.present(next.image, { signal, isCurrent });
        if (!isCurrent()) return;

        if (this.isPlaying) {
            this.scheduleNext();
        }
    }

    // Show the next picture: a photo, or a snap (a saved page) drawn on the note layer.
    // `isCurrent` says whether whoever asked still wants it (see PhotoRecovery).
    async present(imageData, { signal, isCurrent = () => true } = {}) {
        if (imageData.type !== 'snap') {
            if (!await this.loadImage(imageData, signal) || !isCurrent()) return false;
            this.currentImageData = imageData;
            this.showImage();
            return true;
        }
        if (!isCurrent() || !await this.showNote(imageData.snap, { scheduled: false, isCurrent })) return false;
        this.currentImageData = imageData;
        this.photoShown();
        this.noteScheduler?.photoShown();
        this.updateInfo();
        this.loadingState.classList.add('hidden');
        this.hideError();
        return true;
    }

    async showNote(note, { scheduled = true, isCurrent = () => true } = {}) {
        if (!this.noteLayer || !window.NotePage) return false;
        try {
            const page = NotePage.render(note);
            clearTimeout(this.noteHideTimer);
            this.noteLayer.classList.remove('is-visible');
            this.noteLayer.replaceChildren(page);
            await NotePage.whenLoaded(page);
            if (!isCurrent()) return false; // replaced while its pictures loaded

            void this.noteLayer.offsetWidth; // restart the entrance animation
            this.noteLayer.classList.add('is-visible');
            document.body.classList.add('note-showing');
            if (scheduled) this.noteScheduler.markShown(note);
            return true;
        } catch (error) {
            console.error('Could not show note:', error);
            return false;
        }
    }

    hideNote() {
        if (!this.noteLayer?.classList.contains('is-visible')) return;
        this.noteLayer.classList.remove('is-visible');
        document.body.classList.remove('note-showing');
        clearTimeout(this.noteHideTimer);
        this.noteHideTimer = setTimeout(() => this.noteLayer.replaceChildren(), 1500);
    }

    scheduleNext(duration = this.interval) {
        this.clearTimers();
        this.currentDuration = duration;
        this.timer = setTimeout(() => this.nextImage(), duration);
        this.startProgress(duration);
    }

    startProgress(duration = this.currentDuration) {
        this.progressBar.style.width = '0%';
        let progress = 0;
        const increment = 100 / (duration / 100);

        this.progressTimer = setInterval(() => {
            progress += increment;
            if (progress >= 100) {
                progress = 100;
                clearInterval(this.progressTimer);
            }
            this.progressBar.style.width = progress + '%';
        }, 100);
    }

    resetProgress() {
        this.progressBar.style.width = '0%';
        if (this.progressTimer) {
            clearInterval(this.progressTimer);
            this.progressTimer = null;
        }
    }

    clearTimers() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.progressTimer) {
            clearInterval(this.progressTimer);
            this.progressTimer = null;
        }
    }

    toggleFullscreen() {
        if (!fullscreenElement()) {
            // Enter fullscreen
            const element = document.documentElement;

            if (element.requestFullscreen) {
                element.requestFullscreen().then(() => {
                    document.body.classList.add('fullscreen');
                    this.showControlsTemporarily();
                }).catch((err) => {
                    console.error('Error attempting to enable fullscreen:', err);
                    this.notices.fullscreen('refused');
                });
            } else if (element.webkitRequestFullscreen || element.msRequestFullscreen) {
                // These answer with an event, or not at all: check a moment later
                (element.webkitRequestFullscreen || element.msRequestFullscreen).call(element);
                clearTimeout(this.fullscreenCheck);
                this.fullscreenCheck = setTimeout(() => {
                    if (fullscreenElement()) this.showControlsTemporarily();
                    else this.notices.fullscreen('refused');
                }, 1500);
            } else {
                // iPhone Safari, some TV browsers: only the browser's own menu can do it
                this.notices.fullscreen('unavailable');
            }
        } else {
            // Exit fullscreen
            if (document.exitFullscreen) {
                document.exitFullscreen().then(() => {
                    document.body.classList.remove('fullscreen');
                }).catch((err) => {
                    console.error('Error attempting to exit fullscreen:', err);
                });
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
                document.body.classList.remove('fullscreen');
            } else if (document.msExitFullscreen) {
                document.msExitFullscreen();
                document.body.classList.remove('fullscreen');
            }
        }
    }

    toggleInfo() {
        this.infoOverlay.classList.toggle('hidden');
    }

    togglePlayPause() {
        this.isPlaying = !this.isPlaying;
        document.body.classList.toggle('is-paused', !this.isPlaying);
        this.renderPlayPause();

        if (this.isPlaying) {
            // Resume slideshow (a note keeps its own, longer duration)
            this.scheduleNext(this.currentDuration);
        } else {
            // Pause slideshow
            this.clearTimers();
            this.resetProgress();
        }
    }

    // Icon, label and tooltip follow the play state (and the language)
    renderPlayPause() {
        this.playPauseBtn.querySelector('.material-icons').textContent = this.isPlaying ? 'pause' : 'play_arrow';
        this.playPauseBtn.setAttribute('aria-label', this.isPlaying ? t('slideshow.static_009') : t('slideshow.resume'));
        this.playPauseBtn.title = this.isPlaying ? t('slideshow.static_010') : t('slideshow.playTitle');
    }

    // Re-draws the text this class sets itself, in the current language
    renderLanguage() {
        this.renderPlayPause();
        if (this.currentImageData) this.folder.textContent = this.currentImageData.folder || t('common.library');
        if (this.errorText && !this.errorState.classList.contains('hidden')) this.errorMessage.textContent = t(...this.errorText);
        if (this.errorTitleKey && !this.errorState.classList.contains('hidden')) this.errorTitle.textContent = t(this.errorTitleKey);
        Object.keys(this.noticeSlots).forEach(slot => this.renderNotice(slot, this.notices.shown[slot]));
    }

    // Draws one of the notices at the top (FrameNotices decides what and when)
    renderNotice(slot, notice) {
        const element = this.noticeSlots[slot];
        element.classList.toggle('hidden', !notice);
        if (notice) {
            element.querySelector('.material-icons').textContent = notice.icon;
            element.querySelector('.frame-notice-text').textContent = t(notice.key);
            element.classList.toggle('is-compact', Boolean(notice.compact));
            if (slot === 'wake') this.keepAwakeBtn.classList.toggle('hidden', !notice.button);
        }
        // Narrow screens hide the caption under a message (not under the small pill)
        document.body.classList.toggle('notice-showing', this.notices.coversTop());
        document.body.classList.toggle('notice-pill', Boolean(this.notices.shown.wake?.compact) && !this.notices.coversTop());
    }

    logout() {
        if (window.authManager) {
            window.authManager.logout();
        }
    }

    /**
     * Arrow keys for TV remotes without Tab: Up or Down from the photo steps
     * into the dock, Left and Right move along it (js/arrowFocus.js), and Down
     * steps back out so Right is "next photo" again. True when the key was used.
     */
    handleDockArrows(e) {
        const controls = document.getElementById('controls');
        if (!controls || !window.SoraArrowFocus || !SoraArrowFocus.DIRECTIONS[e.key]) return false;
        const inDock = controls.contains(e.target);
        if (!inDock) {
            const onPhoto = e.target === document.body || e.target === document.documentElement;
            if (!onPhoto || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return false;
            e.preventDefault();
            this.showControlsTemporarily();
            this.playPauseBtn.focus();
            return true;
        }
        e.preventDefault();
        if (e.key === 'ArrowDown') {
            e.target.blur();
        } else if (e.key !== 'ArrowUp') {
            const buttons = [...controls.querySelectorAll('button')].filter(button => !button.closest('.folder-dropdown'));
            SoraArrowFocus.next(buttons, e.target, e.key)?.focus();
        }
        this.showControlsTemporarily();
        return true;
    }

    showControlsTemporarily() {
        // Clear any existing hide timer
        if (this.controlsHideTimer) {
            clearTimeout(this.controlsHideTimer);
        }

        document.body.classList.add('chrome-visible');

        // Hide controls after 3 seconds of inactivity
        this.controlsHideTimer = setTimeout(() => {
            document.body.classList.remove('chrome-visible');
        }, 3000);
    }

    showError(message, titleKey = 'slideshow.nothing') {
        this.errorText = null;
        this.errorTitleKey = titleKey;
        this.errorTitle.removeAttribute('data-i18n'); // the heading and message are set here from now on
        this.errorTitle.textContent = t(titleKey);
        this.errorIcon.textContent = titleKey === 'slideshow.connectionTitle' ? 'wifi_off' : 'photo_library';
        this.errorMessage.removeAttribute('data-i18n');
        this.errorMessage.textContent = message;
        this.errorState.classList.remove('hidden');
        this.loadingState.classList.add('hidden');
    }

    // Same, but kept as a key so it follows a language change
    showErrorKey(key, vars, titleKey) {
        this.showError(t(key, vars), titleKey);
        this.errorText = [key, vars];
    }

    hideError() {
        this.errorState.classList.add('hidden');
    }

    photoShown() {
        this.hasShownPhoto = true;
        this.recovery.done(); // a photo is up (the Next button can get there first)
    }

    // The first photo after starting or picking a folder, and every retry
    // (see PhotoRecovery for when it runs, and when its result is dropped)
    async showFirstPhoto(signal, isCurrent) {
        this.clearTimers();
        this.resetProgress();
        const next = await this.fetchRandomImage(signal);
        if (!isCurrent()) return { ok: false };
        if (next.error) return { ok: false, error: next.error };
        if (!await this.present(next.image, { signal, isCurrent })) {
            return { ok: false, error: signal?.aborted ? { offline: true } : { key: 'slideshow.loadFirstImageFailed', transient: true } };
        }
        if (this.isPlaying) this.scheduleNext();
        return { ok: true };
    }

    // The error card: for an empty screen, or over a photo when the folder can't
    // play (PhotoRecovery keeps a photo up through network trouble)
    showFailure(error) {
        if (!error || error.offline || error.timeout) {
            this.showErrorKey('slideshow.unable_images', undefined, 'slideshow.connectionTitle');
        } else {
            this.showErrorKey(error.key, error.vars);
        }
    }

    requestWakeLock() {
        // Keep phones and tablets awake for as long as the frame is open
        if (!this.wakeLock) {
            this.wakeLock = new KeepAwake();
            this.wakeLock.onchange = status => this.notices.wakeStatus(status);
        }
        this.wakeLock.enable();
    }

    setupCursorAutoHide() {
        const hideCursor = () => {
            document.body.classList.add('hide-cursor');
        };

        const showCursor = () => {
            document.body.classList.remove('hide-cursor');
            clearTimeout(this.cursorHideTimer);
            this.cursorHideTimer = setTimeout(hideCursor, 3000);
        };

        document.addEventListener('mousemove', showCursor);
        document.addEventListener('mousedown', showCursor);
        document.addEventListener('keydown', showCursor);

        this.cursorHideTimer = setTimeout(hideCursor, 3000);
    }

    initializeFolderSelector() {
        const container = document.getElementById('folderSelector');
        if (container && window.FolderSelector) {
            this.folderSelector = new FolderSelector(container, {
                onFolderChanged: (folderPath, folderName) => {
                    this.onFolderChanged(folderPath, folderName);
                },
                showFolderCount: true,
                autoClose: true
            });

            this.folderSelector.folders = [];
            this.folderSelector.renderFolders();
        }
    }

    // The new folder's first photo, tried again until it shows. A retry still
    // pending for the old folder is dropped; a photo on screen stays up meanwhile.
    onFolderChanged() {
        return this.recovery.start();
    }

    cleanup() {
        this.clearTimers();
        this.recovery.stop(); // a try still running for this session is dropped

        if (this.cursorHideTimer) {
            clearTimeout(this.cursorHideTimer);
            this.cursorHideTimer = null;
        }

        if (this.controlsHideTimer) {
            clearTimeout(this.controlsHideTimer);
            this.controlsHideTimer = null;
        }

        if (this.wakeLock) {
            this.wakeLock.disable();
        }

        this.screenShift?.stop();
        this.notices.stop();
        clearTimeout(this.fullscreenCheck);

        this.noteScheduler?.stop();
    }

    async startSlideshow() {
        this.hideError();
        this.noteScheduler?.start();
        this.screenShift?.start();
        this.requestWakeLock(); // again after signing out and back in (cleanup turned it off)
        this.notices.start();

        this.hasShownPhoto = false; // a new session: until its photo shows, say what's wrong
        await this.recovery.start();
    }
}

// Weather and Clock Widget
class WeatherWidget {
    constructor() {
        this.timeDisplay = document.getElementById('timeDisplay');
        this.dateDisplay = document.getElementById('dateDisplay');
        this.weatherIcon = document.getElementById('weatherIcon');
        this.tempDisplay = document.getElementById('tempDisplay');
        this.widget = document.getElementById('weatherWidget');

        this.lat = null;
        this.lon = null;
        this.weatherData = null;
        this.updateInterval = null;
        this.weatherInterval = null;

        this.checkAndInit();
    }

    checkAndInit() {
        // Check if weather widget is enabled (default: true)
        const enabled = localStorage.getItem('weatherWidgetEnabled') !== 'false';

        if (enabled) {
            this.show();
            this.init();
        } else {
            this.hide();
        }

        // Update date display visibility
        this.updateDateVisibility();

        // Update widget opacity
        this.updateOpacity();

        // Listen for changes in localStorage
        window.addEventListener('storage', (e) => {
            if (e.key === 'weatherWidgetEnabled') {
                const isEnabled = e.newValue !== 'false';
                if (isEnabled) {
                    this.show();
                    if (!this.updateInterval) this.init();
                } else {
                    this.hide();
                }
            }
            // Update temperature display when unit changes
            if (e.key === 'temperatureUnit' && this.weatherData) {
                this.updateTemperatureDisplay();
            }
            // Update date display when toggled
            if (e.key === 'dateDisplayEnabled') {
                this.updateDateVisibility();
            }
            // Update time display when format changes
            if (e.key === 'timeFormat') {
                this.updateTime();
            }
            // Update widget opacity when changed
            if (e.key === 'widgetOpacity') {
                this.updateOpacity();
            }
        });
    }

    show() {
        if (this.widget) this.widget.style.display = '';
    }

    hide() {
        if (this.widget) this.widget.style.display = 'none';
        this.cleanup();
    }

    updateDateVisibility() {
        const enabled = localStorage.getItem('dateDisplayEnabled') !== 'false';
        if (this.dateDisplay) {
            this.dateDisplay.style.display = enabled ? 'block' : 'none';
        }
    }

    updateOpacity() {
        const opacity = parseInt(localStorage.getItem('widgetOpacity') || '100');
        const root = document.documentElement.style;
        // Opacity drives the legibility scrim behind the clock...
        root.setProperty('--widget-alpha', opacity / 100);
        // ...and the text sits 20% more opaque than it (capped at 100%)
        root.setProperty('--widget-text', Math.min(opacity + 20, 100) / 100);
    }

    cleanup() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
        if (this.weatherInterval) {
            clearInterval(this.weatherInterval);
            this.weatherInterval = null;
        }
    }

    async init() {
        this.updateTime();
        this.updateInterval = setInterval(() => this.updateTime(), 1000);

        await this.getLocation();
        await this.updateWeather();

        // Update weather every 10 minutes
        this.weatherInterval = setInterval(() => this.updateWeather(), 10 * 60 * 1000);
    }

    updateTime() {
        const now = new Date();
        const format = localStorage.getItem('timeFormat') || '24';

        let timeStr;
        if (format === '12') {
            let hours = now.getHours();
            // AM/PM in the page language ("PM" in English)
            const ampm = new Intl.DateTimeFormat(window.i18n?.locale, { hour: 'numeric', hour12: true })
                .formatToParts(now).find(part => part.type === 'dayPeriod')?.value || (hours >= 12 ? 'PM' : 'AM');
            hours = hours % 12;
            hours = hours ? hours : 12; // 0 should be 12
            const minutes = now.getMinutes().toString().padStart(2, '0');
            timeStr = `${hours}:${minutes}<span class="ampm">${ampm}</span>`;
        } else {
            const hours = now.getHours().toString().padStart(2, '0');
            const minutes = now.getMinutes().toString().padStart(2, '0');
            timeStr = `${hours}:${minutes}`;
        }

        this.timeDisplay.innerHTML = timeStr;

        // Update date (e.g., "Mon, Jan 1")
        const options = { weekday: 'short', month: 'short', day: 'numeric' };
        const dateStr = now.toLocaleDateString(window.i18n?.locale, options);
        this.dateDisplay.textContent = dateStr;
    }

    async getLocation() {
        try {
            // Use ipapi.co for simple IP geolocation (no API key needed)
            const response = await fetch('https://ipapi.co/json/');
            const data = await response.json();

            if (data.latitude && data.longitude) {
                this.lat = data.latitude;
                this.lon = data.longitude;
            }
        } catch (error) {
            console.error('Failed to get location:', error);
        }
    }

    async updateWeather() {
        if (!this.lat || !this.lon) return;

        try {
            this.widget.classList.add('loading');

            // Use Open-Meteo API (free, no API key required)
            const response = await fetch(
                `https://api.open-meteo.com/v1/forecast?latitude=${this.lat}&longitude=${this.lon}&current=temperature_2m,weather_code&timezone=auto`
            );
            const data = await response.json();

            if (data.current) {
                this.weatherData = data.current;
                const weatherCode = data.current.weather_code;

                this.updateTemperatureDisplay();
                this.weatherIcon.textContent = this.getWeatherEmoji(weatherCode);
            }
        } catch (error) {
            console.error('Failed to fetch weather:', error);
        } finally {
            this.widget.classList.remove('loading');
        }
    }

    updateTemperatureDisplay() {
        if (!this.weatherData) return;

        const tempC = Math.round(this.weatherData.temperature_2m);
        const unit = localStorage.getItem('temperatureUnit') || 'C';

        if (unit === 'F') {
            const tempF = Math.round((tempC * 9/5) + 32);
            this.tempDisplay.textContent = `${tempF}°F`;
        } else {
            this.tempDisplay.textContent = `${tempC}°C`;
        }
    }

    getWeatherEmoji(code) {
        // WMO Weather interpretation codes - using Material Icons
        if (code === 0) return 'wb_sunny'; // Clear sky
        if (code <= 3) return 'partly_cloudy_day'; // Partly cloudy
        if (code <= 48) return 'foggy'; // Fog
        if (code <= 57) return 'water_drop'; // Drizzle
        if (code <= 67) return 'rainy'; // Rain
        if (code <= 77) return 'ac_unit'; // Snow
        if (code <= 82) return 'rainy'; // Rain showers
        if (code <= 86) return 'weather_snowy'; // Snow showers
        if (code <= 99) return 'thunderstorm'; // Thunderstorm
        return 'cloud'; // Default
    }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.authManager = new AuthenticationManager();
    window.slideshow = new PhotoFrameSlideshow();
    window.weatherWidget = new WeatherWidget();
    window.addEventListener('sora:languagechange', () => {
        window.weatherWidget.updateTime();
        window.authManager.renderLanguage();
        window.slideshow.renderLanguage();
    });

    document.addEventListener('authenticationComplete', async (e) => {
        console.log('Authentication complete, starting slideshow for:', e.detail.account.name);

        window.slideshow.hideError();
        window.slideshow.initializeFolderSelector();

        // Load the folder list first (it checks the saved folder still exists), but
        // don't wait on it for ever: the photos come without it, and only the
        // slideshow's own start can show the error card and keep retrying
        // Locked (signed out) while waiting: that sign-in is over, don't start
        const generation = window.slideshow.recovery.generation;
        if (window.slideshow.folderSelector) {
            try {
                await PhotoRecovery.withTimeout(window.slideshow.folderSelector.refresh(), REQUEST_TIMEOUT_MS);
            } catch (error) {
                console.error('Folders did not load; starting the slideshow anyway:', error);
            }
        }
        if (window.slideshow.recovery.generation !== generation || !window.authManager.isAuthenticated) return;
        window.slideshow.startSlideshow();
    });

    window.addEventListener('beforeunload', () => {
        window.slideshow.cleanup();
    });
});
