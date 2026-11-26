/**
 * Approving a frame by its code: shared by the /pair page (js/pair.js) and
 * "Add a screen" on the Access page (access-accounts.js).
 *
 *   SoraPairFlow.normalize(' k7p - 4qx ')  'K7P4QX' (any case, dashes and spaces dropped)
 *   SoraPairFlow.lookup(code, getJson)     { state: 'ready', code, accounts, folders, pinSignIn }
 *                                          | { state: 'expired' } | { state: 'unreachable' }
 *   SoraPairFlow.approve(code, body, getJson)
 *                                          { state: 'done', device } | { state: 'expired' }
 *                                          | { state: 'failed', data }
 *   SoraPairFlow.choices({ accountList, newAccount, folderList, name })
 *                                          the "Which photos" list: an existing account
 *                                          (a screen, with PIN sign-in off) or a new one
 *                                          and its folders
 *
 * getJson(url, options) answers { ok, status, json, data } (see request()).
 */
(function (root) {
    const NEW = '__new__';
    const CODE_LENGTH = 6;
    // As shown on the frame (K7P-4QX), any case, with or without the hyphen or spaces
    const normalize = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const pretty = code => `${code.slice(0, 3)}-${code.slice(3)}`;

    // fetch, then the reply as { ok, status, json, data }. A proxy's error page (or
    // a sign-in page) is not JSON: `json` is false then. A 401 calls signedOut()
    // and throws { signedOut: true }.
    async function request(url, options, signedOut) {
        const response = await fetch(url, options);
        if (response.status === 401 && signedOut) {
            signedOut();
            throw Object.assign(new Error('Signed out'), { signedOut: true });
        }
        let data = null;
        try {
            data = await response.json();
        } catch (_) { /* not JSON */ }
        const json = Boolean(data) && typeof data === 'object';
        return { ok: response.ok, status: response.status, json, data: json ? data : {} };
    }

    // The code, and what a frame can be given: the accounts, and the folders for a new one
    async function lookup(code, getJson) {
        const pairing = await getJson(`/api/admin/pair/${encodeURIComponent(code)}`);
        // Only the server's own "no such code" means expired; anything else (a 503,
        // a proxy's 404 page, a restarting server) is worth another try
        if (pairing.json && (pairing.data.code === 'PAIRING_EXPIRED' || (pairing.ok && pairing.data.approved))) return { state: 'expired' };
        if (!pairing.ok || !pairing.json || typeof pairing.data.code !== 'string') return { state: 'unreachable' };

        // The folder list only matters for a new account: without it, "no ticks"
        // would mean every folder. Existing accounts can still be chosen.
        const [accounts, folders] = await Promise.all([getJson('/api/access-accounts'), getJson('/api/folders')]);
        const listed = (reply, key) => reply.ok && reply.json && Array.isArray(reply.data[key]);
        const folderList = listed(folders, 'folders') ? folders.data.folders : null;
        if (!listed(accounts, 'accounts')) return { state: 'unreachable' };
        if (!folderList && !accounts.data.accounts.length) return { state: 'unreachable' }; // nothing to choose
        return {
            state: 'ready',
            code: pairing.data.code,
            accounts: accounts.data.accounts,
            folders: folderList,
            pinSignIn: accounts.data.pinSignIn !== false
        };
    }

    async function approve(code, body, getJson) {
        const result = await getJson(`/api/admin/pair/${encodeURIComponent(code)}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (result.ok) return { state: 'done', device: result.data.device, account: result.data.account };
        if (result.data.code === 'PAIRING_EXPIRED') return { state: 'expired' };
        return { state: 'failed', data: result.data };
    }

    // The "Which photos" choice. `name` is the radio group's name (one per page).
    function choices({ accountList, newAccount, folderList, name = 'account' }) {
        let loaded = null; // { accounts, folders, screens }
        const selected = () => document.querySelector(`input[name="${name}"]:checked`)?.value;
        const folderSummary = folders => (folders && folders.length ? folders.join(', ') : t('pair.all_folders'));

        function choice(value, title, detail, checked) {
            const label = document.createElement('label');
            label.className = 'choice';
            label.innerHTML = '<input type="radio"><span class="choice-text"><span class="choice-title"></span><span class="choice-detail"></span></span>';
            const input = label.querySelector('input');
            input.name = name;
            input.value = value;
            input.checked = checked;
            label.querySelector('.choice-title').textContent = title;
            label.querySelector('.choice-detail').textContent = detail;
            return label;
        }

        function update() {
            newAccount.classList.toggle('hidden', selected() !== NEW);
        }

        function renderAccounts() {
            const { accounts, screens } = loaded;
            const current = selected();
            accountList.innerHTML = '';
            accounts.forEach((account, i) => {
                accountList.appendChild(choice(account.id, account.name, folderSummary(account.assignedFolders), current ? current === account.id : i === 0));
            });
            accountList.appendChild(choice(NEW, t(screens ? 'pair.new_screen' : 'pair.new_account'), t('pair.choose_folders'), current ? current === NEW : accounts.length === 0));
            update();
        }

        function renderFolders(keepTicks) {
            const { folders } = loaded;
            if (keepTicks && folderList.querySelector('input')) return; // folder names need no translation, keep the ticks
            folderList.innerHTML = '';
            if (!folders) {
                // Without the list, "no ticks" would mean every folder: a new account waits for it
                folderList.innerHTML = `<p class="pair-error">${t('pair.foldersFailed')}</p>`;
                return;
            }
            if (!folders.length) {
                folderList.innerHTML = `<p class="pair-note">${t('pair.no_folders')}</p>`;
                return;
            }
            folders.forEach(folder => {
                const label = document.createElement('label');
                label.className = 'folder';
                label.innerHTML = '<input type="checkbox"><span class="material-icons">folder</span><span class="folder-name"></span>';
                label.querySelector('input').value = folder.path;
                label.querySelector('.folder-name').textContent = folder.name;
                folderList.appendChild(label);
            });
        }

        accountList.addEventListener('change', update);

        return {
            // A new lookup: fresh lists (and folder ticks)
            show(found) {
                loaded = { accounts: found.accounts, folders: found.folders, screens: found.pinSignIn === false };
                accountList.innerHTML = '';
                renderAccounts();
                renderFolders(false);
            },
            // The language changed: same choices, ticks kept
            render() {
                if (!loaded) return;
                renderAccounts();
                renderFolders(true);
            },
            // What to approve with, or { error } (a translation key)
            body(frameName) {
                const account = selected();
                if (account === NEW && !loaded?.folders) return { error: 'pair.foldersFailed' };
                return {
                    body: account === NEW
                        ? { name: frameName, newAccount: { assignedFolders: [...folderList.querySelectorAll('input:checked')].map(i => i.value) } }
                        : { name: frameName, accountId: account }
                };
            }
        };
    }

    root.SoraPairFlow = { NEW, CODE_LENGTH, normalize, pretty, request, lookup, approve, choices };
})(typeof window !== 'undefined' ? window : this);
