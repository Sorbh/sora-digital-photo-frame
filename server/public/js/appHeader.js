/* The shared header's buttons, on every page that has it (see the server's
   views/pages.js, which draws the header and the phone tab bar):
     - the account menu (the round person button): Account, the theme and Log out,
       opened by click, Enter, Space or Down, walked with the arrow keys, Home and
       End, closed by Escape, Tab or a click elsewhere;
     - the theme item: light, then dark, then the system's, saved for every page;
     - Log out;
     - the bar's hairline and blur once the page scrolls under it;
     - data-proxy="id": a button that clicks the page's own control with that id
       (the tab bar's round button, say, which does what the page's main button does). */
(function (global) {
  const ORDER = { light: 'dark', dark: 'system', system: 'light' };
  const ICONS = { light: 'light_mode', dark: 'dark_mode', system: 'brightness_auto' };
  // The theme item says what the next press does, with the icon of the theme it switches to
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
    if (iconEl) iconEl.textContent = ICONS[ORDER[mode]];
    const english = { light: 'Switch to dark mode', dark: 'Use the system setting', system: 'Switch to light mode' }[mode];
    const title = translate(TITLES[mode], english);
    const label = document.getElementById('themeLabel');
    if (label) {
      label.textContent = title;
      // i18n.apply() would put the first text back on a language change
      label.removeAttribute('data-i18n');
    } else {
      button.title = title;
      button.setAttribute('aria-label', title);
      button.removeAttribute('data-i18n-attr');
    }
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

  // ---------- The account menu -------------------------------------------
  const menuParts = () => {
    const button = document.getElementById('accountMenuBtn');
    const list = document.getElementById('accountMenu');
    return button && list ? { button, list } : null;
  };
  const menuItems = list => Array.from(list.querySelectorAll('[role="menuitem"]'))
    .filter(item => !item.hidden && item.getClientRects().length);

  function openMenu(focus = 'first') {
    const parts = menuParts();
    if (!parts) return false;
    parts.list.hidden = false;
    parts.button.setAttribute('aria-expanded', 'true');
    const items = menuItems(parts.list);
    const target = focus === 'last' ? items[items.length - 1] : items[0];
    if (focus && target) target.focus();
    return true;
  }

  function closeMenu({ returnFocus = true } = {}) {
    const parts = menuParts();
    if (!parts || parts.list.hidden) return false;
    const hadFocus = parts.list.contains(document.activeElement);
    parts.list.hidden = true;
    parts.button.setAttribute('aria-expanded', 'false');
    if (returnFocus && hadFocus) parts.button.focus();
    return true;
  }

  const menuOpen = () => {
    const parts = menuParts();
    return Boolean(parts && !parts.list.hidden);
  };

  function menuKey(event) {
    const parts = menuParts();
    if (!parts) return;
    const items = menuItems(parts.list);
    const at = items.indexOf(document.activeElement);
    const to = {
      ArrowDown: (at + 1) % items.length,
      ArrowUp: (at <= 0 ? items.length : at) - 1,
      Home: 0,
      End: items.length - 1
    }[event.key];
    if (to !== undefined && items.length) {
      event.preventDefault();
      items[to].focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation(); // the page's own Escape (a selection, say) stays as it is
      closeMenu();
    } else if (event.key === 'Tab') {
      closeMenu({ returnFocus: false });
    }
  }

  function bindMenu() {
    const parts = menuParts();
    if (!parts) return;
    parts.button.addEventListener('click', () => (menuOpen() ? closeMenu() : openMenu(null)));
    parts.button.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openMenu(event.key === 'ArrowUp' ? 'last' : 'first');
      } else if ((event.key === 'Enter' || event.key === ' ') && !menuOpen()) {
        event.preventDefault();
        openMenu('first');
      } else if (event.key === 'Escape' && menuOpen()) {
        event.stopPropagation();
        closeMenu();
      }
    });
    parts.list.addEventListener('keydown', menuKey);
    // Account and Log out leave the page; the theme stays open to show what it did
    parts.list.addEventListener('click', event => {
      const item = event.target.closest('[role="menuitem"]');
      if (item && item.id !== 'themeToggle') closeMenu({ returnFocus: false });
    });
    document.addEventListener('pointerdown', event => {
      const now = menuParts();
      if (now && menuOpen() && !now.list.contains(event.target) && !now.button.contains(event.target)) closeMenu({ returnFocus: false });
    });
  }

  // The bar shows its hairline and blur once the page is scrolled under it
  function watchScroll() {
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    const paint = () => bar.classList.toggle('is-scrolled', (global.scrollY || 0) > 2);
    global.addEventListener('scroll', paint, { passive: true });
    paint();
  }

  function bind() {
    bindMenu();
    watchScroll();
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

  const api = { nextTheme, paintThemeButton, logOut, savedMode, openMenu, closeMenu, menuKey };
  global.SoraHeader = api;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})(window);
