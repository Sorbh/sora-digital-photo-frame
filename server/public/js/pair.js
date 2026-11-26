// Approving a frame that showed a QR code: /pair?code=K7P4QX, or /pair to type the code.
// The lookup, the "Which photos" choice and the approval are js/pairFlow.js, shared
// with "Add a screen" on the Access page.
(() => {
    const { CODE_LENGTH, normalize, pretty } = window.SoraPairFlow;
    const $ = id => document.getElementById(id);
    // A typed code is kept for this tab only, not in the address: a reload, or
    // signing in again, comes back to it without the code going into ?next=
    const CODE_KEY = 'sora_pair_code';
    const remember = value => {
        try {
            if (value) sessionStorage.setItem(CODE_KEY, value);
            else sessionStorage.removeItem(CODE_KEY);
        } catch (_) { /* storage off: the code is typed again */ }
    };
    const remembered = () => {
        try { return sessionStorage.getItem(CODE_KEY); } catch (_) { return null; }
    };
    let code = normalize(new URLSearchParams(location.search).get('code') || remembered());
    const states = ['stateLoading', 'stateEnter', 'stateExpired', 'stateUnreachable', 'pairForm', 'stateDone'];

    const show = id => states.forEach(s => $(s).classList.toggle('hidden', s !== id));
    const choices = window.SoraPairFlow.choices({ accountList: $('accountList'), newAccount: $('newAccount'), folderList: $('folderList') });
    let doneName = null;

    function showError(message) {
        $('pairError').textContent = message;
        $('pairError').classList.toggle('hidden', !message);
    }

    // Signed out: back here after signing in, with the code kept aside rather than in the sign-in address
    function signedOut() {
        remember(code);
        const query = new URLSearchParams(location.search); // keeps ?lang= and the like
        query.delete('code');
        const back = query.toString() ? `${location.pathname}?${query}` : location.pathname;
        location.href = `/login?next=${encodeURIComponent(back)}`;
    }
    const getJson = (url, options) => window.SoraPairFlow.request(url, options, signedOut);

    // A code that is used up or too old is not offered again
    function expired() {
        remember(null);
        show('stateExpired');
    }

    function showEnter() {
        show('stateEnter');
        if (matchMedia('(pointer: fine)').matches) $('codeInput').focus();
    }

    async function load() {
        if (!code) return showEnter();
        show('stateLoading');
        try {
            const found = await window.SoraPairFlow.lookup(code, getJson);
            if (found.state === 'expired') return expired();
            if (found.state !== 'ready') return show('stateUnreachable');
            $('codeShown').textContent = pretty(found.code);
            choices.show(found);
            show('pairForm');
            if (matchMedia('(pointer: fine)').matches) $('frameName').focus();
        } catch (error) {
            if (error.signedOut) return; // on the way to the sign-in page
            console.error('Could not load the pairing:', error);
            show('stateUnreachable');
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
        remember(code);
        load();
    });

    $('codeInput').addEventListener('input', () => $('codeError').classList.add('hidden'));

    // "Type a code" is for another code: forget this one (a reload would check it again)
    document.querySelectorAll('a[href="/pair"]').forEach(link => link.addEventListener('click', event => {
        event.preventDefault();
        remember(null);
        code = '';
        $('codeInput').value = '';
        $('codeError').classList.add('hidden');
        const query = new URLSearchParams(location.search);
        if (query.has('code')) {
            query.delete('code');
            history.replaceState(null, '', query.toString() ? `/pair?${query}` : '/pair');
        }
        showEnter();
    }));

    // "Type a code" keeps the chosen language
    const lang = new URLSearchParams(location.search).get('lang');
    if (lang) document.querySelectorAll('a[href="/pair"]').forEach(link => { link.href = `/pair?lang=${encodeURIComponent(lang)}`; });
    $('retryCheck').addEventListener('click', () => load());

    $('pairForm').addEventListener('submit', async event => {
        event.preventDefault();
        const name = $('frameName').value.trim();
        if (!name) {
            showError(t('pair.name_required'));
            $('frameName').focus();
            return;
        }
        const chosen = choices.body(name);
        if (chosen.error) {
            showError(t(chosen.error));
            return;
        }

        showError('');
        $('pairButton').disabled = true;
        try {
            const result = await window.SoraPairFlow.approve(code, chosen.body, getJson);
            if (result.state === 'done') {
                remember(null); // paired: a later /pair starts afresh
                doneName = result.device.name;
                renderDone();
                show('stateDone');
            } else if (result.state === 'expired') {
                expired();
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

    window.addEventListener('sora:languagechange', () => {
        renderDone();
        if (!$('codeError').classList.contains('hidden')) $('codeError').textContent = t('pair.codeInvalid');
        choices.render();
    });

    load();
})();
