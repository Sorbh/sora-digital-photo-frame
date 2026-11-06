class LoginManager {
    constructor() {
        this.form = document.getElementById('loginForm');
        this.passwordInput = document.getElementById('passwordInput');
        this.loginBtn = document.getElementById('loginBtn');
        this.spinner = document.getElementById('spinner');
        this.btnText = document.querySelector('.btn-text');
        this.errorMessage = document.getElementById('errorMessage');
        this.successMessage = document.getElementById('successMessage');

        this.setupEventListeners();
        this.checkUrlParams();
        // Messages shown before the catalogue loaded, or in the previous language
        window.addEventListener('sora:languagechange', () => {
            if (this.messageKey) document.getElementById(this.messageKey.target).textContent = t(this.messageKey.key);
        });
    }

    setupEventListeners() {
        this.form.addEventListener('submit', (e) => this.handleLogin(e));
        this.passwordInput.addEventListener('input', () => this.clearMessages());
    }

    checkUrlParams() {
        const urlParams = new URLSearchParams(window.location.search);
        const error = urlParams.get('error');
        const expired = urlParams.get('expired');

        if (error === 'invalid') {
            this.showError(t('login.invalid_password'), 'login.invalid_password');
        } else if (expired === 'true') {
            this.showError(t('login.session_expired'), 'login.session_expired');
        }
    }

    async handleLogin(e) {
        e.preventDefault();

        const password = this.passwordInput.value.trim();
        if (!password) {
            this.showError(t('login.enter_password'), 'login.enter_password');
            return;
        }

        this.setLoading(true);
        this.clearMessages();

        try {
            const response = await fetch('/api/auth/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ password })
            });

            const data = await response.json();

            if (response.ok) {
                this.showSuccess(t('login.success'), 'login.success');
                // Back to the page that asked for sign-in (e.g. pairing a frame), else the library
                const next = new URLSearchParams(window.location.search).get('next');
                const target = next && /^\/(?![\/\\])/.test(next) ? next : '/admin';
                setTimeout(() => {
                    window.location.href = target;
                }, 1000);
            } else {
                this.showError(i18n.error(data, 'login.failed'));
            }
        } catch (error) {
            console.error('Login error:', error);
            this.showError(t('errors.connection'), 'errors.connection');
        } finally {
            this.setLoading(false);
        }
    }

    setLoading(loading) {
        this.loginBtn.disabled = loading;
        if (loading) {
            this.btnText.textContent = t('login.signing_in');
            this.spinner.style.display = 'inline-block';
        } else {
            this.btnText.textContent = t('login.sign_in');
            this.spinner.style.display = 'none';
        }
    }

    showError(message, key = null) {
        this.messageKey = key && { target: 'errorText', key };
        const errorText = document.getElementById('errorText');
        if (errorText) {
            errorText.textContent = message;
        }
        this.errorMessage.style.display = 'grid';
        this.successMessage.style.display = 'none';
    }

    showSuccess(message, key = null) {
        this.messageKey = key && { target: 'successText', key };
        const successText = document.getElementById('successText');
        if (successText) {
            successText.textContent = message;
        }
        this.successMessage.style.display = 'grid';
        this.errorMessage.style.display = 'none';
    }

    clearMessages() {
        this.errorMessage.style.display = 'none';
        this.successMessage.style.display = 'none';
    }
}

// Initialize login manager when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new LoginManager();
});
