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
            this.showError('Invalid password. Please try again.');
        } else if (expired === 'true') {
            this.showError('Your session has expired. Please login again.');
        }
    }

    async handleLogin(e) {
        e.preventDefault();

        const password = this.passwordInput.value.trim();
        if (!password) {
            this.showError('Please enter a password');
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
                this.showSuccess('Login successful! Redirecting...');
                setTimeout(() => {
                    window.location.href = '/admin';
                }, 1000);
            } else {
                this.showError(data.message || 'Login failed');
            }
        } catch (error) {
            console.error('Login error:', error);
            this.showError('Connection error. Please try again.');
        } finally {
            this.setLoading(false);
        }
    }

    setLoading(loading) {
        this.loginBtn.disabled = loading;
        if (loading) {
            this.btnText.textContent = 'Signing in';
            this.spinner.style.display = 'inline-block';
        } else {
            this.btnText.textContent = 'Sign in';
            this.spinner.style.display = 'none';
        }
    }

    showError(message) {
        const errorText = document.getElementById('errorText');
        if (errorText) {
            errorText.textContent = message;
        }
        this.errorMessage.style.display = 'grid';
        this.successMessage.style.display = 'none';
    }

    showSuccess(message) {
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
