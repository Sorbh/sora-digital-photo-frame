// "Add a screen": the owner types the code a frame shows (a TV has only a remote,
// so nothing is typed on it), names it and picks its photos. The lookup, the
// choices and the approval are js/pairFlow.js, the same as the /pair page.
class AddScreenDialog {
    constructor({ onAdded } = {}) {
        const $ = id => document.getElementById(id);
        this.$ = $;
        this.onAdded = onAdded;
        this.modal = $('addScreenModal');
        this.code = null; // the code found, as the server knows it
        this.codeError = null; // [key] shown under the code, kept to re-translate
        this.pairError = null; // [key] or [null, text from the server]
        this.doneName = null;
        this.choices = window.SoraPairFlow.choices({
            accountList: $('screenAccountList'),
            newAccount: $('screenNewAccount'),
            folderList: $('screenFolderList'),
            name: 'screenAccount'
        });

        $('screenCodeForm').addEventListener('submit', (event) => { event.preventDefault(); this.lookup(); });
        $('screenCodeInput').addEventListener('input', () => this.showCodeError(null));
        $('screenPairForm').addEventListener('submit', (event) => { event.preventDefault(); this.approve(); });
        $('screenBackBtn').addEventListener('click', () => this.startOver());
        $('screenDoneBtn').addEventListener('click', () => this.close());
        $('closeAddScreen').addEventListener('click', () => this.close());
        window.addEventListener('sora:languagechange', () => this.renderLanguage());
    }

    // Signed out meanwhile: back to Access after signing in
    getJson(url, options) {
        return window.SoraPairFlow.request(url, options, () => {
            location.href = `/login?next=${encodeURIComponent('/access-accounts')}`;
        });
    }

    step(name) {
        const steps = { code: 'screenCodeForm', pair: 'screenPairForm', done: 'screenDone' };
        Object.entries(steps).forEach(([step, id]) => this.$(id).classList.toggle('hidden', step !== name));
    }

    open() {
        this.startOver();
        if (!this.modal.open) this.modal.showModal();
        this.$('screenCodeInput').focus();
    }

    close() {
        if (this.modal.open) this.modal.close();
    }

    startOver(errorKey = null) {
        this.code = null;
        this.doneName = null;
        this.$('screenCodeInput').value = '';
        this.showPairError(null);
        this.showCodeError(errorKey);
        this.step('code');
    }

    showCodeError(key) {
        this.codeError = key;
        const element = this.$('screenCodeError');
        element.textContent = key ? t(key) : '';
        element.classList.toggle('hidden', !key);
    }

    // A translation key, or the server's own words (i18n.error) as text. It sits at
    // the top of the form and is brought into view: on a phone the list of folders
    // can push anything lower off the screen. focus: false leaves the focus where
    // it is (a field that needs filling in, or a language change).
    showPairError(key, text, { focus = true } = {}) {
        this.pairError = key || text ? [key, text] : null;
        const element = this.$('screenPairError');
        element.textContent = key ? t(key) : (text || '');
        element.classList.toggle('hidden', !(key || text));
        if (!(key || text)) return;
        if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'nearest' });
        if (focus) element.focus({ preventScroll: true });
    }

    renderDone() {
        const span = document.createElement('span');
        span.textContent = this.doneName || '';
        this.$('screenDoneTitle').innerHTML = t('accessAccounts.screenAdded', { name: span.outerHTML });
    }

    renderLanguage() {
        if (this.codeError) this.showCodeError(this.codeError);
        if (this.pairError?.[0]) this.showPairError(this.pairError[0], null, { focus: false });
        if (this.doneName) this.renderDone();
        this.choices.render();
    }

    // The code as typed: any case, with or without dashes and spaces
    async lookup() {
        const { normalize, CODE_LENGTH, pretty } = window.SoraPairFlow;
        const typed = normalize(this.$('screenCodeInput').value);
        if (typed.length !== CODE_LENGTH) {
            this.showCodeError('pair.codeInvalid');
            this.$('screenCodeInput').focus();
            return;
        }
        this.showCodeError(null);
        const button = this.$('screenCodeBtn');
        button.disabled = true;
        try {
            const found = await window.SoraPairFlow.lookup(typed, (url, options) => this.getJson(url, options));
            if (found.state === 'expired') return this.showCodeError('accessAccounts.screenCodeWrong');
            if (found.state !== 'ready') return this.showCodeError('pair.unreachableNote');
            this.code = found.code;
            this.$('screenCodeShown').textContent = pretty(found.code);
            this.$('screenName').value = found.name || ''; // the name the screen gave itself, if any
            this.showPairError(null);
            this.choices.show(found);
            this.step('pair');
            this.$('screenName').focus();
        } catch (error) {
            if (error.signedOut) return;
            console.error('Could not check the code:', error);
            this.showCodeError('pair.unreachableNote');
        } finally {
            button.disabled = false;
        }
    }

    async approve() {
        const name = this.$('screenName').value.trim();
        if (!name) {
            this.showPairError('accessAccounts.screenNameRequired', null, { focus: false });
            this.$('screenName').focus();
            return;
        }
        const chosen = this.choices.body(name);
        if (chosen.error) return this.showPairError(chosen.error);

        this.showPairError(null);
        const button = this.$('screenPairBtn');
        button.disabled = true;
        try {
            const result = await window.SoraPairFlow.approve(this.code, chosen.body, (url, options) => this.getJson(url, options));
            if (result.state === 'done') {
                this.doneName = result.device.name;
                this.renderDone();
                this.step('done');
                if (this.onAdded) this.onAdded(result);
            } else if (result.state === 'expired') {
                // Used or too old meanwhile: the TV shows a new code by now
                this.startOver('accessAccounts.screenCodeWrong');
            } else {
                this.showPairError(null, i18n.error(result.data, 'pair.failed'));
            }
        } catch (error) {
            if (error.signedOut) return;
            this.showPairError('errors.connection');
        } finally {
            button.disabled = false;
        }
    }
}

class AccessAccountsManager {
    constructor() {
        this.accounts = [];
        this.devices = []; // screens: paired by QR code or signed in by PIN
        this.folders = [];
        this.currentEditingAccount = null;
        // false: PIN sign-in is off, so accounts are screens (a name and folders, no PIN)
        this.pinSignIn = true;
        this.addScreen = new AddScreenDialog({ onAdded: () => this.loadAccounts() });
        this.init();
    }

    // With PIN sign-in off, the page talks about screens and has no PIN field
    get screens() {
        return this.pinSignIn === false;
    }

    // This page's words for an account, or for a screen
    term(accountKey, screenKey) {
        return this.screens ? screenKey : accountKey;
    }

    applyMode() {
        const screens = this.screens;
        const swap = (id, attribute, accountKey, screenKey) => {
            const element = document.getElementById(id);
            if (!element) return;
            const key = screens ? screenKey : accountKey;
            element.dataset[attribute] = key; // kept on a language change (i18n.apply)
            if (attribute === 'i18nHtml') element.innerHTML = t(key);
            else element.textContent = t(key);
        };
        swap('accessEyebrow', 'i18nHtml', 'accessAccounts.static_002', 'accessAccounts.screensEyebrow');
        swap('accessTitle', 'i18nHtml', 'accessAccounts.who_visit', 'accessAccounts.screensTitle');
        swap('emptyTitle', 'i18n', 'accessAccounts.static_005', 'accessAccounts.screensEmptyTitle');
        swap('emptyText', 'i18n', 'accessAccounts.static_006', 'accessAccounts.screensEmptyText');
        swap('detailsTitle', 'i18n', 'accessAccounts.static_008', 'accessAccounts.screenDetails');
        swap('accountNameLabel', 'i18n', 'accessAccounts.static_009', 'accessAccounts.screenNameLabel');
        swap('delete-title', 'i18n', 'accessAccounts.static_014', 'accessAccounts.deleteScreen');
        swap('confirmDeleteText', 'i18n', 'accessAccounts.static_014', 'accessAccounts.deleteScreen');
        swap('saveAccountText', 'i18n', 'accessAccounts.saveAccount', 'common.save');
        document.getElementById('emptyIcon').textContent = screens ? 'tv' : 'key';
        document.getElementById('pinField').classList.toggle('hidden', screens);
        document.getElementById('createAccountBtn').classList.toggle('hidden', screens);
    }

    init() {
        this.bindEvents();
        // Re-render what this page builds itself when the language changes
        window.addEventListener('sora:languagechange', () => {
            if (this.loaded) this.renderAccounts();
            this.renderDeleteDescription();
            if (document.getElementById('accountModal').open) this.renderModalText();
        });
        this.loadAccounts();
        this.loadFolders();
        this.loadFamilyCode();
    }

    // Hosted: show the family code frames type along with their PIN
    async loadFamilyCode() {
        try {
            const data = await (await fetch('/api/admin/family-code')).json();
            if (data.required) this.showFamilyCode(data.code);
        } catch (error) {
            console.error('Could not load the family code:', error);
        }
    }

    showFamilyCode(code) {
        document.getElementById('familyCodeValue').textContent = `${code.slice(0, 4)}-${code.slice(4)}`;
        document.getElementById('familyCodeCard').classList.remove('hidden');
    }

    async renewFamilyCode() {
        if (!confirm(t('accessAccounts.familyCodeRenewConfirm'))) return;
        try {
            const data = await (await fetch('/api/admin/family-code', { method: 'POST' })).json();
            if (!data.success) throw new Error(data.error);
            this.showFamilyCode(data.code);
            this.showToast(t('accessAccounts.familyCodeRenewed'), 'success');
        } catch (error) {
            console.error('Could not make a new family code:', error);
            this.showToast(t('accessAccounts.familyCodeRenewFailed'), 'error');
        }
    }

    bindEvents() {
        // Back button
        document.getElementById('backBtn').addEventListener('click', () => {
            window.location.href = '/home';
        });

        document.getElementById('renewFamilyCodeBtn').addEventListener('click', () => this.renewFamilyCode());

        document.getElementById('addScreenBtn').addEventListener('click', () => this.addScreen.open());

        // Create new account button
        document.getElementById('createAccountBtn').addEventListener('click', () => {
            this.openAccountModal();
        });

        // Modal events
        document.getElementById('cancelAccountBtn').addEventListener('click', () => {
            this.closeAccountModal();
        });

        document.getElementById('closeAccountModal').addEventListener('click', () => {
            this.closeAccountModal();
        });

        document.getElementById('accountForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveAccount();
        });

        // Delete modal events
        document.getElementById('cancelDeleteBtn').addEventListener('click', () => {
            this.closeDeleteModal();
        });

        document.getElementById('confirmDeleteBtn').addEventListener('click', () => {
            this.deleteAccount();
        });

        // Form validation
        document.getElementById('accountPin').addEventListener('input', (e) => {
            if (this.currentEditingAccount && !e.target.value) return this.clearErrors();
            this.validatePin(e.target.value);
        });

        document.getElementById('accountName').addEventListener('input', (e) => {
            this.validateName(e.target.value);
        });
    }

    async loadAccounts() {
        try {
            this.showLoading();
            const [response, devices] = await Promise.all([
                fetch('/api/access-accounts'),
                fetch('/api/admin/devices').then(r => r.json()).catch(() => ({}))
            ]);
            const data = await response.json();
            
            if (response.ok) {
                this.accounts = data.accounts || [];
                this.devices = devices.devices || [];
                this.pinSignIn = data.pinSignIn !== false;
                this.applyMode();
                this.renderAccounts();
            } else {
                this.showToast(t('accessAccounts.loadFailed'), 'error');
                this.showEmptyState();
            }
        } catch (error) {
            console.error('Error loading accounts:', error);
            this.showToast(t('accessAccounts.loadFailed'), 'error');
            this.showEmptyState();
        }
    }

    async loadFolders() {
        try {
            const response = await fetch('/api/folders');
            const data = await response.json();
            
            if (response.ok && data.folders) {
                this.folders = data.folders.map(folder => ({
                    name: folder.name,
                    path: folder.path || folder.name,
                    imageCount: folder.imageCount || 0
                }));
            } else {
                this.folders = [];
            }
        } catch (error) {
            console.error('Error loading folders:', error);
            this.folders = [];
        }
    }

    showLoading() {
        document.getElementById('loadingState').classList.remove('hidden');
        document.getElementById('accountsList').classList.add('hidden');
        document.getElementById('emptyState').classList.add('hidden');
    }

    showEmptyState() {
        document.getElementById('loadingState').classList.add('hidden');
        document.getElementById('accountsList').classList.add('hidden');
        document.getElementById('emptyState').classList.remove('hidden');
    }

    renderAccounts() {
        document.getElementById('loadingState').classList.add('hidden');
        this.loaded = true;

        const meta = document.getElementById('accountsMetaText');
        if (meta) {
            const count = this.accounts.length;
            meta.textContent = count === 0
                ? t(this.term('accessAccounts.no_accounts', 'accessAccounts.noScreens'))
                : t(this.term('accessAccounts.accounts', 'accessAccounts.screensCount'), { count });
        }
        
        if (this.accounts.length === 0) {
            this.showEmptyState();
            return;
        }

        document.getElementById('emptyState').classList.add('hidden');
        const accountsList = document.getElementById('accountsList');
        accountsList.classList.remove('hidden');
        
        accountsList.innerHTML = this.accounts.map(account => this.renderAccountCard(account)).join('');
        
        // Bind account action events
        this.bindAccountActions();
    }

    escapeHtml(value) {
        // Quotes too, so the result is also safe inside an attribute (data-folder="...")
        return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }

    renderAccountCard(account) {
        const esc = (value) => this.escapeHtml(value);
        const folderTags = account.assignedFolders.length > 0
            ? account.assignedFolders.map(folder =>
                `<span class="folder-tag">
                    <span class="material-symbols-outlined">folder</span>
                    ${esc(folder)}
                </span>`).join('')
            : `<span class="folder-tag no-folders-tag">${esc(t('accessAccounts.noFoldersAssigned'))}</span>`;

        const lastUsed = this.lastUsed(account);
        const lastAccessed = lastUsed
            ? new Date(lastUsed).toLocaleDateString(window.i18n?.locale, { month: 'short', day: 'numeric', year: 'numeric' })
            : t('accessAccounts.lastUsedNever');
        const folderCount = account.assignedFolders.length;

        return `
            <article class="account-card" data-account-id="${esc(account.id)}">
                <div class="account-top">
                    <div class="account-avatar" aria-hidden="true">${esc(account.name.trim().charAt(0).toUpperCase() || '?')}</div>
                    <div class="account-heading">
                        <h3 class="account-name">${esc(account.name)}</h3>
                        ${this.screens ? '' : `<span class="pin-reveal" title="${esc(t('accessAccounts.pinHidden'))}">
                            <span class="material-symbols-outlined">key</span>
                            <span class="pin-value">••••••</span>
                        </span>`}
                    </div>
                    <div class="account-actions">
                        <button class="tb-btn icon edit-account" title="${esc(t(this.term('accessAccounts.editAccount', 'accessAccounts.editScreen')))}" data-account-id="${esc(account.id)}">
                            <span class="material-symbols-outlined">edit</span>
                        </button>
                        <button class="tb-btn icon delete-account" data-danger title="${esc(t(this.term('accessAccounts.deleteAccount', 'accessAccounts.deleteScreen')))}" data-account-id="${esc(account.id)}">
                            <span class="material-symbols-outlined">delete</span>
                        </button>
                    </div>
                </div>
                <dl class="account-stats">
                    <div><dt>${esc(t('accessAccounts.statFolders'))}</dt><dd>${folderCount === 0 ? esc(t('accessAccounts.statFoldersNone')) : folderCount}</dd></div>
                    <div><dt>${esc(t('accessAccounts.statLastUsed'))}</dt><dd>${esc(lastAccessed)}</dd></div>
                </dl>
                <div class="folder-tags">
                    ${folderTags}
                </div>
                ${this.renderDevices(account)}
            </article>
        `;
    }

    // When the account was last used: its own sign-in, or any of its screens seen since
    lastUsed(account) {
        const times = [account.lastAccessed, ...this.devices.filter(device => device.accountId === account.id).map(device => device.lastSeen)]
            .map(time => (time ? Date.parse(time) : NaN))
            .filter(Number.isFinite);
        return times.length ? new Date(Math.max(...times)).toISOString() : null;
    }

    // Screens of this account, paired by QR code or signed in with its PIN.
    // A screen the host paused (paused: true) says so, and why.
    renderDevices(account) {
        const esc = (value) => this.escapeHtml(value);
        const devices = this.devices.filter(device => device.accountId === account.id);
        if (devices.length === 0) return '';
        const seen = (device) => device.lastSeen
            ? t('accessAccounts.frameSeen', { date: new Date(device.lastSeen).toLocaleDateString(window.i18n?.locale, { month: 'short', day: 'numeric' }) })
            : t('accessAccounts.frameNotSeen');
        const languages = window.i18n?.supported || ['en', 'es', 'fr', 'de', 'pt-BR', 'it', 'nl', 'hi', 'ja', 'zh-CN', 'ar'];
        return `
            <div class="paired-frames">
                <span class="paired-label">${esc(t('accessAccounts.pairedFrames'))}</span>
                ${devices.map(device => `
                    <div class="paired-frame${device.paused ? ' is-paused' : ''}">
                        <span class="material-symbols-outlined" title="${esc(t(device.via === 'pin' ? 'accessAccounts.viaPin' : 'accessAccounts.viaQr'))}">${device.via === 'pin' ? 'dialpad' : 'tv'}</span>
                        <span class="paired-text">
                            <span class="paired-name">${esc(device.name)}</span>
                            ${device.paused ? `<span class="paused-badge">${esc(t('accessAccounts.screenPaused'))}</span>` : ''}
                            <span class="paired-seen">${esc(device.paused ? t('accessAccounts.screenPausedNote') : seen(device))}</span>
                        </span>
                        <label class="sr-only" for="language-${esc(device.id)}">${esc(t('accessAccounts.screen_language'))}</label>
                        <select class="device-language input" id="language-${esc(device.id)}" data-device-id="${esc(device.id)}">
                            ${languages.map(code => `<option value="${code}" ${device.language === code ? 'selected' : ''}>${window.i18n?.names?.[code] || code}</option>`).join('')}
                        </select>
                        <button class="tb-btn icon remove-device" data-danger title="${esc(t('accessAccounts.removeFrame', { name: device.name }))}" aria-label="${esc(t('accessAccounts.removeFrame', { name: device.name }))}" data-device-id="${esc(device.id)}" data-device-name="${esc(device.name)}">
                            <span class="material-symbols-outlined">link_off</span>
                        </button>
                    </div>`).join('')}
            </div>
        `;
    }

    async removeDevice(id, name) {
        if (!confirm(t('accessAccounts.remove_frame', { name }))) return;
        try {
            const response = await fetch(`/api/admin/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
            if (!response.ok) throw new Error('Remove failed');
            this.devices = this.devices.filter(device => device.id !== id);
            this.renderAccounts();
            this.showToast(t('accessAccounts.frameRemoved', { name }), 'success');
        } catch (error) {
            console.error('Error removing frame:', error);
            this.showToast(t('accessAccounts.removeFrameFailed'), 'error');
        }
    }

    bindAccountActions() {
        document.querySelectorAll('.remove-device').forEach(btn => {
            btn.addEventListener('click', () => this.removeDevice(btn.dataset.deviceId, btn.dataset.deviceName));
        });
        document.querySelectorAll('.device-language').forEach(select => {
            select.addEventListener('change', () => this.setDeviceLanguage(select.dataset.deviceId, select.value));
        });


        // Edit account buttons
        document.querySelectorAll('.edit-account').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const accountId = e.currentTarget.getAttribute('data-account-id');
                this.editAccount(accountId);
            });
        });

        // Delete account buttons
        document.querySelectorAll('.delete-account').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const accountId = e.currentTarget.getAttribute('data-account-id');
                this.confirmDeleteAccount(accountId);
            });
        });
    }

    async setDeviceLanguage(id, language) {
        try {
            const response = await fetch(`/api/admin/devices/${encodeURIComponent(id)}/language`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language })
            });
            if (!response.ok) throw new Error('Could not save language');
            const device = this.devices.find(item => item.id === id);
            if (device) device.language = language;
            this.showToast(t('accessAccounts.frameLanguageSaved', { language: window.i18n?.names?.[language] || language }), 'success');
        } catch (error) {
            console.error('Error saving frame language:', error);
            this.showToast(t('accessAccounts.frameLanguageFailed'), 'error');
        }
    }

    openAccountModal(account = null) {
        this.currentEditingAccount = account;
        const modal = document.getElementById('accountModal');
        const form = document.getElementById('accountForm');
        
        if (account) {
            document.getElementById('accountName').value = account.name;
            // PINs are stored hashed: leave it blank to keep the current one
            const pinInput = document.getElementById('accountPin');
            pinInput.value = '';
            pinInput.required = false;
        } else {
            form.reset();
            const pinInput = document.getElementById('accountPin');
            pinInput.required = !this.screens; // screens have no PIN
        }
        this.renderModalText();

        this.clearErrors();
        this.renderFolderGrid(account ? account.assignedFolders : []);
        modal.showModal();
        document.getElementById('accountName').focus();
    }

    // Title and PIN placeholder depend on whether an account is being edited
    renderModalText() {
        const editing = Boolean(this.currentEditingAccount);
        document.getElementById('modalTitle').textContent = t(editing
            ? this.term('accessAccounts.editAccountTitle', 'accessAccounts.editScreenTitle')
            : 'accessAccounts.static_007');
        const pinInput = document.getElementById('accountPin');
        pinInput.placeholder = t(editing ? 'accessAccounts.pinKeepPlaceholder' : 'accessAccounts.static_024');
        // The placeholder is set here, not by i18n.apply()
        pinInput.removeAttribute('data-i18n-attr');
    }

    closeAccountModal() {
        document.getElementById('accountModal').close();
        this.currentEditingAccount = null;
    }

    renderFolderGrid(selectedFolders = []) {
        const loadingElement = document.getElementById('loadingFolders');
        const gridElement = document.getElementById('folderGrid');
        
        if (this.folders.length === 0) {
            loadingElement.classList.remove('hidden');
            gridElement.classList.add('hidden');
            return;
        }

        loadingElement.classList.add('hidden');
        gridElement.classList.remove('hidden');
        
        const esc = (value) => this.escapeHtml(value);
        gridElement.innerHTML = this.folders.map(folder => {
            const isSelected = selectedFolders.includes(folder.name);
            return `
                <div class="folder-item ${isSelected ? 'selected' : ''}" data-folder="${esc(folder.name)}">
                    <label class="label flex items-center gap-3 cursor-pointer">
                        <input type="checkbox" 
                               class="input"
                               id="folder-${esc(folder.name)}" 
                               value="${esc(folder.name)}" 
                               ${isSelected ? 'checked' : ''}>
                        <div class="flex items-center gap-2 flex-1">
                            <span class="material-symbols-outlined">folder</span>
                            <span class="font-medium">${esc(folder.name)}</span>
                            <span class="text-sm text-muted-foreground ml-auto">${folder.imageCount}</span>
                        </div>
                    </label>
                </div>
            `;
        }).join('');

        // Bind folder checkbox events
        gridElement.querySelectorAll('.folder-item').forEach(folderItem => {
            const checkbox = folderItem.querySelector('input[type="checkbox"]');
            checkbox.addEventListener('change', (e) => {
                if (e.target.checked) {
                    folderItem.classList.add('selected');
                } else {
                    folderItem.classList.remove('selected');
                }
            });
        });
    }

    async saveAccount() {
        if (!this.validateForm()) {
            return;
        }

        const formData = new FormData(document.getElementById('accountForm'));
        const selectedFolders = Array.from(document.querySelectorAll('#folderGrid input[type="checkbox"]:checked'))
            .map(input => input.value);

        const accountData = {
            name: formData.get('name'),
            // Screens (PIN sign-in off) have no PIN
            ...(!this.screens && { pin: formData.get('pin') }),
            assignedFolders: selectedFolders
        };

        try {
            const url = this.currentEditingAccount 
                ? `/api/access-accounts/${this.currentEditingAccount.id}`
                : '/api/access-accounts';
            
            const method = this.currentEditingAccount ? 'PUT' : 'POST';
            
            const response = await fetch(url, {
                method,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(accountData)
            });

            const data = await response.json();

            if (response.ok) {
                this.showToast(
                    t(this.currentEditingAccount
                        ? this.term('accessAccounts.accountUpdated', 'accessAccounts.screenUpdated')
                        : 'accessAccounts.accountCreated'),
                    'success'
                );
                this.closeAccountModal();
                this.loadAccounts();
            } else {
                if (data.code === 'DUPLICATE_PIN') {
                    this.showError('pinError', t('accessAccounts.pinInUse'));
                } else {
                    this.showToast(i18n.error(data, 'accessAccounts.saveFailed'), 'error');
                }
            }
        } catch (error) {
            console.error('Error saving account:', error);
            this.showToast(t('accessAccounts.saveFailed'), 'error');
        }
    }

    editAccount(accountId) {
        const account = this.accounts.find(acc => acc.id === accountId);
        if (account) {
            this.openAccountModal(account);
        }
    }

    confirmDeleteAccount(accountId) {
        const account = this.accounts.find(acc => acc.id === accountId);
        if (account) {
            this.deletingName = account.name;
            this.renderDeleteDescription();
            document.getElementById('confirmDeleteBtn').setAttribute('data-account-id', accountId);
            document.getElementById('deleteModal').showModal();
        }
    }

    // One whole sentence with the account name inside it
    renderDeleteDescription() {
        if (this.deletingName == null) return;
        document.getElementById('delete-description').innerHTML =
            t('accessAccounts.deleteConfirm', { name: this.escapeHtml(this.deletingName) });
    }

    async deleteAccount() {
        const accountId = document.getElementById('confirmDeleteBtn').getAttribute('data-account-id');
        
        try {
            const response = await fetch(`/api/access-accounts/${accountId}`, {
                method: 'DELETE'
            });

            if (response.ok) {
                this.showToast(t(this.term('accessAccounts.accountDeleted', 'accessAccounts.screenDeleted')), 'success');
                this.closeDeleteModal();
                this.loadAccounts();
            } else {
                const data = await response.json();
                this.showToast(i18n.error(data, 'accessAccounts.deleteFailed'), 'error');
            }
        } catch (error) {
            console.error('Error deleting account:', error);
            this.showToast(t('accessAccounts.deleteFailed'), 'error');
        }
    }

    closeDeleteModal() {
        document.getElementById('deleteModal').close();
    }

    validateForm() {
        const name = document.getElementById('accountName').value.trim();
        const pin = document.getElementById('accountPin').value.trim();
        
        let isValid = true;

        if (!this.validateName(name)) {
            isValid = false;
        }

        // Editing with a blank PIN keeps the current one; screens have none
        if (!this.screens && !(this.currentEditingAccount && !pin) && !this.validatePin(pin)) {
            isValid = false;
        }

        return isValid;
    }

    validateName(name) {
        const nameInput = document.getElementById('accountName');
        const errorElement = document.getElementById('nameError');
        
        if (!name) {
            this.showError('nameError', t('accessAccounts.nameRequired'));
            nameInput.classList.add('error');
            return false;
        }
        
        if (name.length > 50) {
            this.showError('nameError', t('accessAccounts.nameTooLong'));
            nameInput.classList.add('error');
            return false;
        }

        this.clearError('nameError');
        nameInput.classList.remove('error');
        return true;
    }

    validatePin(pin) {
        const pinInput = document.getElementById('accountPin');
        const errorElement = document.getElementById('pinError');
        
        if (!pin) {
            this.showError('pinError', t('accessAccounts.pinRequired'));
            pinInput.classList.add('error');
            return false;
        }
        
        if (!/^[0-9]{4,6}$/.test(pin)) {
            this.showError('pinError', t('accessAccounts.pinInvalid'));
            pinInput.classList.add('error');
            return false;
        }

        this.clearError('pinError');
        pinInput.classList.remove('error');
        return true;
    }

    showError(elementId, message) {
        document.getElementById(elementId).textContent = message;
    }

    clearError(elementId) {
        document.getElementById(elementId).textContent = '';
    }

    clearErrors() {
        this.clearError('nameError');
        this.clearError('pinError');
        document.getElementById('accountName').classList.remove('error');
        document.getElementById('accountPin').classList.remove('error');
    }

    showToast(message, type = 'info') {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `
            <span class="material-icons">
                ${type === 'error' ? 'error' : type === 'success' ? 'check_circle' : 'info'}
            </span>
            <span class="toast-message"></span>
        `;
        // Messages can include server text, so never parse them as HTML
        toast.querySelector('.toast-message').textContent = message;
        
        // In front of an open dialog's backdrop (js/toastLayer.js)
        if (window.SoraToastLayer) {
            if (!container.dataset.followed) {
                container.dataset.followed = 'true';
                window.SoraToastLayer.follow(container);
            }
            window.SoraToastLayer.raise(container);
        }
        container.appendChild(toast);
        
        setTimeout(() => {
            toast.classList.add('show');
        }, 100);
        
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => {
                toast.remove();
            }, 300);
        }, 3000);
    }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new AccessAccountsManager();
});
