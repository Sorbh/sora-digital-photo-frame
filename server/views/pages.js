/**
 * The pages people use to look after a library, with one shared header.
 *
 * Every signed-in page (library, Access, notes, snap, pairing, "only for the
 * owner") marks where its top bar and phone tab bar go:
 *
 *   <!-- sora:header -->   the top bar: brand, the host's slot, the actions
 *   <!-- sora:tabbar -->   the phone tab bar, under the page
 *
 * and renderPage() fills them in, so all of them have the same brand, the same
 * actions in the same order, and the page you're on marked. Pages without a top
 * bar (sign-in, the frame's slideshow) only get the brand.
 *
 * Two createApp() options change it (see HOOKS.md, Header):
 *   brand       { name }: the name in the wordmark, page titles and labels
 *               (default "Sora Frame")
 *   accountUrl  a page of the host's about the person's account. When set, the
 *               header links to it (a person icon), and Access leaves the header
 *               and the tab bar: the host shows it from its account page.
 */
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DEFAULT_BRAND = Object.freeze({ name: 'Sora Frame' });

let settings = { brand: DEFAULT_BRAND, accountUrl: null };

const escapeHtml = value => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// A link the page may show: a path on this site ("/account") or an http(s) address
function checkUrl(url) {
  if (typeof url !== 'string' || !url.trim()) throw new TypeError('accountUrl must be a non-empty string');
  const value = url.trim();
  if (/^\/(?!\/)/.test(value) || /^https?:\/\//i.test(value)) return value;
  throw new TypeError('accountUrl must be a path on this site ("/account") or an http(s) address');
}

/** Set from createApp(); called with no options it goes back to the defaults. */
function configure({ brand, accountUrl } = {}) {
  let name = DEFAULT_BRAND.name;
  if (brand !== undefined && brand !== null) {
    if (typeof brand !== 'object' || typeof brand.name !== 'string' || !brand.name.trim()) {
      throw new TypeError('brand must be { name: "Your name" }');
    }
    name = brand.name.trim();
  }
  settings = {
    brand: Object.freeze({ name }),
    accountUrl: accountUrl === undefined || accountUrl === null ? null : checkUrl(accountUrl)
  };
  return settings;
}

const current = () => settings;

// What each page puts in the shared header. eyebrow: the page's name beside the
// brand ([i18n key, English]). fab: the phone tab bar's round button, the page's
// main action. settings: the library's own settings button.
const PAGES = {
  'admin.html': {
    id: 'library',
    eyebrow: ['common.library', 'Library'],
    settings: true,
    fab: { icon: 'add', attrs: 'id="addTabBtn" data-add-menu data-edit-only aria-haspopup="menu"', label: ['admin.addButton', 'Add'] }
  },
  'access-accounts.html': {
    id: 'access',
    eyebrow: ['common.access', 'Access'],
    fab: { icon: 'add_to_queue', attrs: 'data-proxy="addScreenBtn"', label: ['accessAccounts.addScreen', 'Add a screen'] }
  },
  'notes.html': {
    id: 'notes',
    eyebrow: ['common.notes', 'Notes'],
    fab: { icon: 'edit_note', attrs: 'data-proxy="createNoteBtn" data-edit-only', label: ['notes.static_040', 'New note'] }
  },
  'snap.html': { id: 'snap', eyebrow: ['snap.eyebrow', 'Snap'] },
  'pair.html': { id: 'pair', eyebrow: ['pair.static_002', 'Pair a frame'] },
  'owner-only.html': { id: 'owner-only', eyebrow: null }
};

const icon = name => `<span class="material-symbols-outlined" aria-hidden="true">${name}</span>`;
const i18nText = ([key, text]) => `<span data-i18n="${key}">${escapeHtml(text)}</span>`;

/**
 * The top bar for a page ('library', 'access', 'notes', 'snap', 'pair' or
 * 'owner-only'). The host's slot ([data-host-slot]) holds the page's name until
 * the host puts something of its own there (a library switcher, say).
 */
function renderHeader(pageId, { eyebrow = null, settings: hasSettings = false } = {}, options = current()) {
  const { brand, accountUrl } = options;
  const here = id => (pageId === id ? ' aria-current="page"' : '');
  const actions = [];
  if (pageId !== 'library') {
    actions.push(`<a href="/admin" class="tb-btn tb-desktop" data-header-item="library" title="Back to the library" data-i18n-attr="title:accessAccounts.static_017">${icon('photo_library')}<span class="tb-label" data-i18n="common.library">Library</span></a>`);
  }
  if (!accountUrl) {
    actions.push(`<a href="/access-accounts" class="tb-btn tb-desktop" data-header-item="access" data-owner-only${here('access')} title="Manage access accounts" data-i18n-attr="title:admin.static_033">${icon('key')}<span class="tb-label" data-i18n="common.access">Access</span></a>`);
  }
  actions.push(`<a href="/slideshow" class="tb-btn tb-desktop" data-header-item="slideshow" title="Open the slideshow" data-i18n-attr="title:admin.static_036">${icon('slideshow')}<span class="tb-label" data-i18n="common.slideshow">Slideshow</span></a>`);
  actions.push('<span class="topbar-divider tb-desktop" aria-hidden="true"></span>');
  if (hasSettings) {
    actions.push(`<button type="button" id="settingsBtn" class="tb-btn icon tb-desktop" data-header-item="settings" title="Settings" aria-label="Settings" data-i18n-attr="title:admin.static_037; aria-label:admin.static_037">${icon('tune')}</button>`);
  }
  actions.push(`<button type="button" id="themeToggle" class="tb-btn icon" data-header-item="theme" title="Switch to dark mode" aria-label="Switch to dark mode" data-i18n-attr="title:admin.static_038; aria-label:admin.static_038"><span class="material-symbols-outlined" id="themeIcon" aria-hidden="true">brightness_auto</span></button>`);
  if (accountUrl) {
    actions.push(`<a href="${escapeHtml(accountUrl)}" class="tb-btn icon" data-header-item="account" title="Account" aria-label="Account" data-i18n-attr="title:common.account; aria-label:common.account">${icon('account_circle')}</a>`);
  }
  actions.push(`<button type="button" id="logoutBtn" class="tb-btn icon" data-header-item="logout" title="Log out" aria-label="Log out" data-i18n-attr="title:admin.static_039; aria-label:admin.static_039">${icon('logout')}</button>`);

  const slot = eyebrow ? `<span class="sora-eyebrow" data-i18n="${eyebrow[0]}">${escapeHtml(eyebrow[1])}</span>` : '';
  return `<header class="topbar" data-sora-header="${pageId}">
            <div class="topbar-brand">
                <a href="/admin" class="sora-wordmark" data-brand aria-label="${escapeHtml(brand.name)} library home" data-i18n-attr="aria-label:admin.static_032">${escapeHtml(brand.name)}</a>
                <span class="topbar-divider"></span>
                <div class="topbar-slot" data-host-slot>${slot}</div>
            </div>
            <div class="topbar-actions">
                ${actions.join('\n                ')}
            </div>
        </header>`;
}

/** The phone tab bar: Library, Access (owner, without accountUrl), the page's own button, Slideshow, Settings (library). */
function renderTabbar(pageId, { fab = null, settings: hasSettings = false } = {}, options = current()) {
  const here = id => (pageId === id ? ' class="tab active" aria-current="page"' : ' class="tab"');
  const tabs = [`<a href="/admin"${here('library')} data-tab="library">${icon('photo_library')}${i18nText(['common.library', 'Library'])}</a>`];
  if (!options.accountUrl) {
    tabs.push(`<a href="/access-accounts"${here('access')} data-tab="access" data-owner-only>${icon('key')}${i18nText(['common.access', 'Access'])}</a>`);
  }
  if (fab) {
    tabs.push(`<button type="button" class="tab-fab" ${fab.attrs} aria-label="${escapeHtml(fab.label[1])}" data-i18n-attr="aria-label:${fab.label[0]}">${icon(fab.icon)}</button>`);
  }
  tabs.push(`<a href="/slideshow" class="tab" data-tab="slideshow">${icon('slideshow')}${i18nText(['common.slideshow', 'Slideshow'])}</a>`);
  if (hasSettings) {
    tabs.push(`<button type="button" class="tab" data-tab="settings" data-proxy="settingsBtn">${icon('tune')}${i18nText(['common.settings', 'Settings'])}</button>`);
  }
  return `<nav class="tabbar" aria-label="Sections" data-i18n-attr="aria-label:admin.static_054">
        ${tabs.join('\n        ')}
    </nav>`;
}

// The brand on any page: <html data-brand> (i18n.js puts it in {brand}), the
// wordmarks (data-brand) and the title as it is before translations load
function applyBrand(html, { brand } = current()) {
  const name = escapeHtml(brand.name);
  return html
    .replace(/<html\b([^>]*)>/, (tag, attrs) => `<html${attrs.replace(/\sdata-brand="[^"]*"/, '')} data-brand="${name}">`)
    .replace(/(<(\w+)\b[^>]*\bdata-brand\b[^>]*>)[^<]*(<\/\2>)/g, (all, open, tagName, close) => `${open}${name}${close}`)
    .replace(/(<title\b[^>]*>)([^<]*)(<\/title>)/, (all, open, text, close) => `${open}${text.replace(/Sora Frame/g, name)}${close}`);
}

/** A page's HTML with its header, tab bar and brand, as the browser gets it. */
function renderHtml(file, html, options = current()) {
  const page = PAGES[file];
  let out = html;
  if (page) {
    out = out
      .replace('<!-- sora:header -->', () => renderHeader(page.id, page, options))
      .replace('<!-- sora:tabbar -->', () => renderTabbar(page.id, page, options));
  }
  return applyBrand(out, options);
}

/** Reads a page from server/public and renders it (see renderHtml). */
function renderPage(file, options = current()) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  return renderHtml(file, html, options);
}

/** Express handler that sends a rendered page (status 200 unless given). */
function sendPage(file, status = 200) {
  return (req, res, next) => {
    let html;
    try {
      html = renderPage(file);
    } catch (error) {
      return next(error);
    }
    res.status(status).type('html').send(html);
  };
}

module.exports = {
  DEFAULT_BRAND,
  PAGES,
  configure,
  current,
  renderHeader,
  renderTabbar,
  applyBrand,
  renderHtml,
  renderPage,
  sendPage,
  escapeHtml
};
