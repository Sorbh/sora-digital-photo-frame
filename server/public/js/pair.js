// Approving a frame that showed a QR code: /pair?code=K7P4QX, or /pair to type the code
(() => {
    const NEW = '__new__';
    const CODE_LENGTH = 6;
    const $ = id => document.getElementById(id);
    // As shown on the frame (K7P-4QX), any case, with or without the hyphen or spaces
    const normalize = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    let code = normalize(new URLSearchParams(location.search).get('code'));
    const states = ['stateLoading', 'stateEnter', 'stateExpired', 'pairForm', 'stateDone'];

    const show = id => states.forEach(s => $(s).classList.toggle('hidden', s !== id));
    const pretty = c => `${c.slice(0, 3)}-${c.slice(3)}`;

    const folderSummary = folders => (folders && folders.length ? folders.join(', ') : t('pair.all_folders'));

    function choice(value, title, detail, checked) {
        const label = document.createElement('label');
        label.className = 'choice';
        label.innerHTML = '<input type="radio" name="account"><span class="choice-text"><span class="choice-title"></span><span class="choice-detail"></span></span>';
        const input = label.querySelector('input');
        input.value = value;
        input.checked = checked;
        label.querySelector('.choice-title').textContent = title;
        label.querySelector('.choice-detail').textContent = detail;
        return label;
    }

    let loaded = null; // { accounts, folders } once fetched, to re-render on language change
    let doneName = null;

    function renderAccounts(accounts) {
        const list = $('accountList');
        const selected = selectedAccount();
        list.innerHTML = '';
        accounts.forEach((account, i) => {
            list.appendChild(choice(account.id, account.name, folderSummary(account.assignedFolders), selected ? selected === account.id : i === 0));
        });
        list.appendChild(choice(NEW, t('pair.new_account'), t('pair.choose_folders'), selected ? selected === NEW : accounts.length === 0));
        updateNewAccount();
    }

    function renderFolders(folders) {
        const list = $('folderList');
        if (list.querySelector('input')) return; // folder names need no translation, keep the ticks
        list.innerHTML = '';
        if (!folders.length) {
            list.innerHTML = `<p class="pair-note">${t('pair.no_folders')}</p>`;
            return;
        }
        folders.forEach(folder => {
            const label = document.createElement('label');
            label.className = 'folder';
            label.innerHTML = '<input type="checkbox"><span class="material-icons">folder</span><span class="folder-name"></span>';
            label.querySelector('input').value = folder.path;
            label.querySelector('.folder-name').textContent = folder.name;
            list.appendChild(label);
        });
    }

    function selectedAccount() {
        return document.querySelector('input[name="account"]:checked')?.value;
    }

    function updateNewAccount() {
        $('newAccount').classList.toggle('hidden', selectedAccount() !== NEW);
    }

    function showError(message) {
        $('pairError').textContent = message;
        $('pairError').classList.toggle('hidden', !message);
    }

    async function getJson(url, options) {
        const response = await fetch(url, options);
        if (response.status === 401) {
            location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
            throw new Error('Signed out');
        }
        return { ok: response.ok, status: response.status, data: await response.json() };
    }

    function showEnter() {
        show('stateEnter');
        if (matchMedia('(pointer: fine)').matches) $('codeInput').focus();
    }

    async function load() {
        if (!code) return showEnter();
        show('stateLoading');
        try {
            const pairing = await getJson(`/api/admin/pair/${encodeURIComponent(code)}`);
            if (!pairing.ok || pairing.data.approved) return show('stateExpired');

            const [accounts, folders] = await Promise.all([getJson('/api/access-accounts'), getJson('/api/folders')]);
            $('codeShown').textContent = pretty(pairing.data.code);
            loaded = { accounts: accounts.data.accounts || [], folders: folders.data.folders || [] };
            renderAccounts(loaded.accounts);
            renderFolders(loaded.folders);
            show('pairForm');
            if (matchMedia('(pointer: fine)').matches) $('frameName').focus();
        } catch (error) {
            console.error('Could not load the pairing:', error);
            show('stateExpired');
        }
    }

    $('stateEnter').addEventListener('submit', event => {
        event.preventDefault();
        const typed = normalize($('codeInput').value);
        if (typed.length !== CODE_LENGTH) {
            $('codeError').textContent = t('pair.codeInvalid');
            $('codeError').classList.remove('hidden');
            $('codeInput').focus();
            return;
        }
        $('codeError').classList.add('hidden');
        code = typed;
        // So a reload, or signing in again, comes back to this code
        history.replaceState(null, '', `/pair?code=${encodeURIComponent(code)}`);
        load();
    });

    $('codeInput').addEventListener('input', () => $('codeError').classList.add('hidden'));

    $('pairForm').addEventListener('submit', async event => {
        event.preventDefault();
        const name = $('frameName').value.trim();
        if (!name) {
            showError(t('pair.name_required'));
            $('frameName').focus();
            return;
        }
        const account = selectedAccount();
        const body = account === NEW
            ? { name, newAccount: { assignedFolders: [...document.querySelectorAll('#folderList input:checked')].map(i => i.value) } }
            : { name, accountId: account };

        showError('');
        $('pairButton').disabled = true;
        try {
            const result = await getJson(`/api/admin/pair/${encodeURIComponent(code)}/approve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (result.ok) {
                doneName = result.data.device.name;
                renderDone();
                show('stateDone');
            } else if (result.data.code === 'PAIRING_EXPIRED') {
                show('stateExpired');
            } else {
                showError(i18n.error(result.data, 'pair.failed'));
            }
        } catch (error) {
            showError(t('errors.connection'));
        } finally {
            $('pairButton').disabled = false;
        }
    });

    // "Kitchen frame is paired" is one sentence, so the name goes inside the translation
    function renderDone() {
        const name = doneName || t('pair.static_012');
        const span = document.createElement('span');
        span.id = 'doneName';
        span.textContent = name;
        $('doneTitle').innerHTML = t('pair.donePaired', { name: span.outerHTML });
    }

    $('accountList').addEventListener('change', updateNewAccount);
    window.addEventListener('sora:languagechange', () => {
        renderDone();
        if (!$('codeError').classList.contains('hidden')) $('codeError').textContent = t('pair.codeInvalid');
        if (loaded) {
            renderAccounts(loaded.accounts);
            renderFolders(loaded.folders);
        }
    });

    load();
})();
