class AuthenticationManager {
    constructor() {
        this.isAuthenticated = false;
        this.authOverlay = document.getElementById('authOverlay');
        this.pinForm = document.getElementById('pinForm');
        this.pinInput = document.getElementById('pinInput');
        this.authButton = document.getElementById('authButton');
        this.authErrorAlert = document.getElementById('authErrorAlert');
        this.authErrorMessage = document.getElementById('authErrorMessage');
        this.authLoading = document.getElementById('authLoading');

        this.init();
    }

    init() {
        this.bindEvents();
        this.checkExistingSession();
    }

    bindEvents() {
        this.pinForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.authenticate();
        });

        this.pinInput.addEventListener('input', () => {
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
        if (matchMedia('(pointer: fine)').matches) this.pinInput.focus();
    }

    async checkExistingSession() {
        try {
            const response = await fetch('/api/auth/session');
            const data = await response.json();

            if (data.authenticated) {
                this.handleAuthSuccess(data.account);
            } else {
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
            this.showError('Please enter your PIN');
            return;
        }

        if (pin.length < 4) {
            this.showError('PIN must be at least 4 digits');
            return;
        }

        this.setLoading(true);

        try {
            const response = await fetch('/api/auth/pin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pin })
            });

            const data = await response.json();

            if (data.success) {
                this.handleAuthSuccess(data.account);
            } else {
                this.handleAuthError(data.error, data.code);
            }
        } catch (error) {
            console.error('Authentication error:', error);
            this.showError('Connection error. Please try again.');
        } finally {
            this.setLoading(false);
        }
    }

    handleAuthSuccess(account) {
        this.isAuthenticated = true;
        this.userAccount = account;

        sessionStorage.setItem('authenticated', 'true');
        sessionStorage.setItem('accountName', account.name);

        this.hideAuthOverlay();

        document.dispatchEvent(new CustomEvent('authenticationComplete', {
            detail: { account }
        }));
    }

    handleAuthError(error, errorCode) {
        this.showError(error || 'Invalid PIN');

        if (errorCode === 'RATE_LIMITED') {
            this.pinInput.disabled = true;
            this.pinInput.classList.add('border-destructive');
            this.authButton.disabled = true;
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
    }

    hideAuthOverlay() {
        this.authOverlay.classList.add('hidden');
    }

    setLoading(loading) {
        this.authButton.disabled = loading;
        this.pinInput.disabled = loading;

        if (loading) {
            this.authLoading.classList.remove('hidden');
            this.clearError();
        } else {
            this.authLoading.classList.add('hidden');
        }
    }

    showError(message) {
        this.authErrorMessage.textContent = message;
        this.authErrorAlert.classList.remove('hidden');
    }

    clearError() {
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

class PhotoFrameSlideshow {
    constructor() {
        this.currentSlide = 0;
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
        this.noteScheduler = window.NoteScheduler ? new NoteScheduler() : null;
        this.noteHideTimer = null;

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
        this.noteLayer = document.getElementById('noteLayer');

        this.errorState.classList.add('hidden');
        this.images.forEach(img => img.removeAttribute('src'));
    }

    setupEventListeners() {
        this.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
        this.infoBtn.addEventListener('click', () => this.toggleInfo());
        this.logoutBtn.addEventListener('click', () => this.logout());
        this.playPauseBtn.addEventListener('click', () => this.togglePlayPause());
        this.nextBtn.addEventListener('click', () => this.nextImage());

        document.addEventListener('keydown', (e) => {
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

        // Handle fullscreen change events
        document.addEventListener('fullscreenchange', () => {
            if (!document.fullscreenElement) {
                document.body.classList.remove('fullscreen');
            }
        });

        document.addEventListener('webkitfullscreenchange', () => {
            if (!document.webkitFullscreenElement) {
                document.body.classList.remove('fullscreen');
            }
        });

        this.images.forEach(img => {
            img.addEventListener('error', () => {
                if (this.errorState.classList.contains('hidden')) {
                    this.showError('Failed to load image');
                }
            });
        });
    }

    async fetchRandomImage() {
        try {
            const selectedFolderPath = this.folderStorage.getCurrentFolderPath();
            const url = selectedFolderPath
                ? `/api/images/random?folder=${encodeURIComponent(selectedFolderPath)}`
                : '/api/images/random';

            const response = await fetch(url);
            if (!response.ok) throw new Error('Failed to fetch image');
            const data = await response.json();

            if (!data.success) {
                throw new Error(data.error || 'Failed to fetch image');
            }

            return data.image;
        } catch (error) {
            console.error('Error fetching random image:', error);
            this.showError(`Failed to load image: ${error.message}`);
            return null;
        }
    }

    async loadImage(imageData) {
        if (!imageData) return false;

        return new Promise((resolve) => {
            const nextSlide = (this.currentSlide + 1) % 2;
            const img = this.images[nextSlide];

            const onLoad = () => {
                img.removeEventListener('load', onLoad);
                img.removeEventListener('error', onError);
                this.hideError();
                this.ambients[nextSlide].style.backgroundImage = `url(${JSON.stringify(imageData.url)})`;
                this.currentImageData = imageData;
                resolve(true);
            };

            const onError = (event) => {
                img.removeEventListener('load', onLoad);
                img.removeEventListener('error', onError);
                console.error('Failed to load image:', imageData.url);
                if (this.errorState.classList.contains('hidden')) {
                    this.showError(`Failed to load image: ${imageData.filename}`);
                }
                resolve(false);
            };

            img.addEventListener('load', onLoad);
            img.addEventListener('error', onError);
            img.src = imageData.url;
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
        this.hideNote();
        this.noteScheduler?.photoShown();
        this.updateInfo();
        this.loadingState.classList.add('hidden');
        this.hideError();
    }

    updateInfo() {
        if (this.currentImageData) {
            this.filename.textContent = this.currentImageData.filename;
            this.folder.textContent = this.currentImageData.folder || 'Library';

            // Auto-hide info after 3 seconds if visible
            if (!this.infoOverlay.classList.contains('hidden')) {
                setTimeout(() => {
                    this.infoOverlay.classList.add('hidden');
                }, 3000);
            }
        }
    }

    async nextImage() {
        this.resetProgress();

        // Every few minutes a note takes the place of the next photo
        const note = this.noteScheduler?.nextDue();
        if (note && await this.showNote(note)) {
            if (this.isPlaying) this.scheduleNext(note.showForSeconds * 1000);
            return;
        }

        const imageData = await this.fetchRandomImage();
        if (imageData) await this.present(imageData);

        if (this.isPlaying) {
            this.scheduleNext();
        }
    }

    // Show the next picture: a photo, or a snap (a saved page) drawn on the note layer
    async present(imageData) {
        if (imageData.type !== 'snap') {
            if (!await this.loadImage(imageData)) return false;
            this.showImage();
            return true;
        }
        if (!await this.showNote(imageData.snap, { scheduled: false })) return false;
        this.currentImageData = imageData;
        this.noteScheduler?.photoShown();
        this.updateInfo();
        this.loadingState.classList.add('hidden');
        this.hideError();
        return true;
    }

    async showNote(note, { scheduled = true } = {}) {
        if (!this.noteLayer || !window.NotePage) return false;
        try {
            const page = NotePage.render(note);
            clearTimeout(this.noteHideTimer);
            this.noteLayer.classList.remove('is-visible');
            this.noteLayer.replaceChildren(page);
            await NotePage.whenLoaded(page);

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
        if (!document.fullscreenElement) {
            // Enter fullscreen
            const element = document.documentElement;

            if (element.requestFullscreen) {
                element.requestFullscreen().then(() => {
                    document.body.classList.add('fullscreen');
                    this.showControlsTemporarily();
                }).catch((err) => {
                    console.error('Error attempting to enable fullscreen:', err);
                });
            } else if (element.webkitRequestFullscreen) {
                element.webkitRequestFullscreen();
                document.body.classList.add('fullscreen');
                this.showControlsTemporarily();
            } else if (element.msRequestFullscreen) {
                element.msRequestFullscreen();
                document.body.classList.add('fullscreen');
                this.showControlsTemporarily();
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
        this.playPauseBtn.querySelector('.material-icons').textContent = this.isPlaying ? 'pause' : 'play_arrow';
        this.playPauseBtn.setAttribute('aria-label', this.isPlaying ? 'Pause slideshow' : 'Resume slideshow');
        this.playPauseBtn.title = this.isPlaying ? 'Pause (Space)' : 'Play (Space)';

        if (this.isPlaying) {
            // Resume slideshow (a note keeps its own, longer duration)
            this.scheduleNext(this.currentDuration);
        } else {
            // Pause slideshow
            this.clearTimers();
            this.resetProgress();
        }
    }

    logout() {
        if (window.authManager) {
            window.authManager.logout();
        }
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

    showError(message) {
        this.errorMessage.textContent = message;
        this.errorState.classList.remove('hidden');
        this.loadingState.classList.add('hidden');
    }

    hideError() {
        this.errorState.classList.add('hidden');
    }

    requestWakeLock() {
        // Keep phones and tablets awake for as long as the frame is open
        if (!this.wakeLock) this.wakeLock = new KeepAwake();
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

    async onFolderChanged(folderPath, folderName) {
        this.clearTimers();
        this.resetProgress();

        const imageData = await this.fetchRandomImage();
        if (imageData) {
            const loaded = await this.present(imageData);
            if (loaded) {
                this.scheduleNext();
            } else {
                this.showError('Failed to load image from selected folder');
            }
        } else {
            this.showError(`No images found in folder: ${folderName || 'All Folders'}`);
        }
    }

    cleanup() {
        this.clearTimers();

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

        this.noteScheduler?.stop();
    }

    async startSlideshow() {
        this.hideError();
        this.noteScheduler?.start();

        const imageData = await this.fetchRandomImage();
        if (imageData) {
            const loaded = await this.present(imageData);
            if (loaded) {
                this.scheduleNext();
            } else {
                this.showError('Failed to load first image');
            }
        } else {
            this.showError('No images available');
        }
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
            const ampm = hours >= 12 ? 'PM' : 'AM';
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
        const dateStr = now.toLocaleDateString('en-US', options);
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

    document.addEventListener('authenticationComplete', async (e) => {
        console.log('Authentication complete, starting slideshow for:', e.detail.account.name);

        window.slideshow.hideError();
        window.slideshow.initializeFolderSelector();

        // Wait for folder selector to load folders before starting slideshow
        if (window.slideshow && window.slideshow.folderSelector) {
            try {
                await window.slideshow.folderSelector.refresh();
                // Start slideshow only after folders are loaded
                await window.slideshow.startSlideshow();
            } catch (error) {
                console.error('Failed to initialize slideshow:', error);
                window.slideshow.showError('Failed to load folders');
            }
        } else {
            window.slideshow.startSlideshow();
        }
    });

    window.addEventListener('beforeunload', () => {
        window.slideshow.cleanup();
    });
});
