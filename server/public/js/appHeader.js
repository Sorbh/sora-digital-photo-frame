/* The shared header's buttons, on every page that has it (see the server's
   views/pages.js, which draws the header and the phone tab bar):
     - the theme button: light, then dark, then the system's, saved for every page;
     - Log out;
     - data-proxy="id": a button that clicks the page's own control with that id
       (the tab bar's round button, say, which does what the page's main button does). */
(function (global) {
  const ORDER = { light: 'dark', dark: 'system', system: 'light' };
  const ICONS = { light: 'light_mode', dark: 'dark_mode', system: 'brightness_auto' };
  // The title says what the next press does
  const TITLES = { light: 'admin.themeToDark', dark: 'admin.themeToSystem', system: 'admin.themeToLight' };
  const translate = (key, english) => (global.i18n && typeof global.i18n.t === 'function' ? global.i18n.t(key) : english);

  function savedMode() {
    try { return ORDER[localStorage.getItem('themeMode')] ? localStorage.getItem('themeMode') : 'system'; } catch (_) { return 'system'; }
  }

  function applyMode(mode) {
    const dark = mode === 'dark' || (mode === 'system' && global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', Boolean(dark));
  }

  function paintThemeButton(mode = savedMode()) {
    const button = document.getElementById('themeToggle');
    if (!button) return;
    const iconEl = document.getElementById('themeIcon');
    if (iconEl) iconEl.textContent = ICONS[mode];
    const english = { light: 'Switch to dark mode', dark: 'Use the system setting', system: 'Switch to light mode' }[mode];
    const title = translate(TITLES[mode], english);
    button.title = title;
    button.setAttribute('aria-label', title);
    // i18n.apply() would put the first title back on a language change
    button.removeAttribute('data-i18n-attr');
  }

  function nextTheme() {
    const mode = ORDER[savedMode()];
    try { localStorage.setItem('themeMode', mode); } catch (_) { /* this visit only */ }
    applyMode(mode);
    // Pages that listen for Basecoat's event (the library) follow along
    document.dispatchEvent(new CustomEvent('basecoat:theme', { detail: { mode } }));
    paintThemeButton(mode);
    return mode;
  }

  async function logOut() {
    const failed = () => {
      const message = translate('admin.logoutFailed', 'Could not log out. Please try again.');
      if (typeof global.showToast === 'function') global.showToast(message, 'error');
    };
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) return failed();
      global.location.href = '/login';
    } catch (_) {
      failed();
    }
  }

  function bind() {
    document.getElementById('themeToggle')?.addEventListener('click', nextTheme);
    document.getElementById('logoutBtn')?.addEventListener('click', logOut);
    document.querySelectorAll('[data-proxy]').forEach(button => {
      button.addEventListener('click', () => document.getElementById(button.dataset.proxy)?.click());
    });
    paintThemeButton();
    global.addEventListener('sora:languagechange', () => paintThemeButton());
    // "System": follow the device when it switches
    global.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
      if (savedMode() === 'system') applyMode('system');
    });
  }

  const api = { nextTheme, paintThemeButton, logOut, savedMode };
  global.SoraHeader = api;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})(window);
