// One header for every page that looks after a library (views/pages.js): the same
// brand, the same actions in the same order, the page you're on marked, and the
// host's options: brand { name } and accountUrl (see HOOKS.md, Header). Also what
// left the header: "New note" in the library, and Google Photos in the Upload menu.
const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');
const vm = require('vm');

const testUploadsDir = path.join(__dirname, 'header-uploads');
const testCacheDir = path.join(__dirname, 'header-cache');
const testDataDir = path.join(__dirname, 'header-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const { createApp } = require('../app');
const pages = require('../views/pages');

const publicDir = path.join(__dirname, '..', 'public');
const read = file => fs.readFileSync(path.join(publicDir, file), 'utf8');

// Who is asking (x-person), as a host's auth provider would say
const PEOPLE = {
  owner: { folders: null, canEdit: true, isOwner: true },
  editor: { folders: ['Family'], canEdit: true, isOwner: false },
  admin: null // self-hosted: no limits
};
const signedIn = (req, res, next) => (req.get('x-person') in PEOPLE ? next() : res.status(401).json({ code: 'AUTH_REQUIRED' }));
const build = (options = {}) => createApp({
  auth: { requireAuth: signedIn, requireViewer: signedIn, scope: req => PEOPLE[req.get('x-person')] ?? null },
  ...options
});
const get = (app, url, person = 'admin') => request(app).get(url).set('x-person', person);

// The pages with the shared header, and which one each is
const HEADER_PAGES = { '/admin/': 'library', '/access-accounts': 'access', '/notes': 'notes', '/snap': 'snap', '/pair': 'pair' };

const headerOf = html => {
  const found = html.match(/<header class="topbar" data-sora-header="([\w-]+)">[\s\S]*?<\/header>/);
  if (!found) throw new Error('No shared header');
  return { page: found[1], html: found[0] };
};
const tabbarOf = html => {
  const found = html.match(/<nav class="tabbar"[\s\S]*?<\/nav>/);
  if (!found) throw new Error('No tab bar');
  return found[0];
};
const itemsOf = header => [...header.matchAll(/data-header-item="(\w+)"/g)].map(match => match[1]);
const tabsOf = tabbar => [...tabbar.matchAll(/data-tab="(\w+)"|class="tab-fab"/g)].map(match => match[1] || 'fab');

afterAll(async () => {
  pages.configure();
  await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
});

describe('every page shares one header', () => {
  let app;
  beforeAll(() => { app = build(); });

  test.each(Object.entries(HEADER_PAGES))('%s has it, marked as its page', async (url, id) => {
    const res = await get(app, url).expect(200);
    expect(res.text).not.toContain('<!-- sora:');
    expect(res.text.match(/<header class="topbar"/g)).toHaveLength(1);
    const header = headerOf(res.text);
    expect(header.page).toBe(id);
    // The brand, linking home, and the host's slot beside it
    expect(header.html).toMatch(/<a href="\/admin" class="sora-wordmark" data-brand [^>]*>Sora Frame<\/a>/);
    expect(header.html).toContain('<div class="topbar-slot" data-host-slot>');
    // The same actions in the same order: Library (when not on it), Access (self-hosted),
    // Slideshow, settings (the library's own), theme, log out
    const expected = id === 'library'
      ? ['access', 'slideshow', 'settings', 'theme', 'logout']
      : ['library', 'access', 'slideshow', 'theme', 'logout'];
    expect(itemsOf(header.html)).toEqual(expected);
    // No Notes or Google Photos in it any more
    expect(header.html).not.toMatch(/href="\/notes"|googlePhotosBtn|sticky_note_2/);
    // The script that runs its buttons
    expect(res.text).toContain('<script src="/js/appHeader.js"></script>');
    // The phone tab bar follows the same rule
    const tabs = tabsOf(tabbarOf(res.text));
    expect(tabs.filter(tab => tab !== 'fab')).toEqual(id === 'library' ? ['library', 'access', 'slideshow', 'settings'] : ['library', 'access', 'slideshow']);
  });

  test('the page you are on is marked', async () => {
    const access = headerOf((await get(app, '/access-accounts').expect(200)).text).html;
    expect(access).toMatch(/<a href="\/access-accounts" [^>]*data-header-item="access" data-owner-only aria-current="page"/);
    const library = (await get(app, '/admin/').expect(200)).text;
    expect(tabbarOf(library)).toMatch(/<a href="\/admin" class="tab active" aria-current="page" data-tab="library">/);
    expect(headerOf(library).html).not.toContain('aria-current');
    // The page's name sits in the host's slot until the host fills it
    expect(headerOf(library).html).toMatch(/data-host-slot><span class="sora-eyebrow" data-i18n="common.library">Library<\/span><\/div>/);
  });

  test('"only for the owner" has it too, without Access', async () => {
    const res = await get(app, '/access-accounts', 'editor').expect(403);
    const header = headerOf(res.text);
    expect(header.page).toBe('owner-only');
    // Hidden for them by js/scope.js, which the page loads
    expect(header.html).toMatch(/data-header-item="access" data-owner-only/);
    expect(res.text).toContain('<script src="/js/scope.js"></script>');
  });

  test('the brand is on the pages without the header too', async () => {
    for (const url of ['/login', '/slideshow', '/folder-selection']) {
      const html = (await request(app).get(url)).text;
      expect(html).toMatch(/<html [^>]*data-brand="Sora Frame"/);
      expect(html).not.toMatch(/class="sora-wordmark"[^>]*>Sora</);
      expect(html).toMatch(/data-brand>Sora Frame</);
    }
  });
});

describe('the brand option', () => {
  afterAll(() => pages.configure());

  test('names the product everywhere the pages say it', async () => {
    const app = build({ brand: { name: 'Nana <Frame> & Co' } });
    const escaped = 'Nana &lt;Frame&gt; &amp; Co';
    for (const url of [...Object.keys(HEADER_PAGES), '/login', '/slideshow']) {
      const html = (await get(app, url)).text;
      expect(html).toMatch(new RegExp(`<html [^>]*data-brand="${escaped}"`));
      expect(html).not.toContain('Nana <Frame>');
      expect(html).not.toMatch(/data-brand>Sora Frame</);
      expect(html).not.toMatch(/<title[^>]*>[^<]*Sora Frame/);
    }
    const header = headerOf((await get(app, '/admin/')).text).html;
    expect(header).toContain(`data-brand aria-label="${escaped} library home"`);
    expect(header).toContain(`>${escaped}</a>`);
    expect((await get(app, '/admin/')).text).toMatch(new RegExp(`<title data-i18n="admin.static_001">Library · ${escaped}</title>`));
  });

  test('defaults to Sora Frame, and must be a name', () => {
    expect(pages.configure().brand.name).toBe('Sora Frame');
    expect(pages.configure({ brand: { name: '  Oma  ' } }).brand.name).toBe('Oma');
    for (const brand of ['Oma', { name: '' }, { name: 3 }, {}]) {
      expect(() => build({ brand })).toThrow(TypeError);
    }
  });

  test('translations say {brand}, filled in from the page', () => {
    const localesDir = path.join(publicDir, 'locales');
    const flatten = (value, prefix = '') => Object.entries(value).flatMap(([key, child]) =>
      child && typeof child === 'object' ? flatten(child, `${prefix}${key}.`) : [[`${prefix}${key}`, child]]);
    for (const file of fs.readdirSync(localesDir)) {
      const strings = flatten(JSON.parse(fs.readFileSync(path.join(localesDir, file), 'utf8')));
      // The product's name is never written into a string
      expect(strings.filter(([, value]) => /Sora/.test(value))).toEqual([]);
      for (const key of ['admin.static_001', 'admin.static_032', 'slideshow.pageTitle', 'notes.sora_notes']) {
        expect(strings.find(([other]) => other === key)[1]).toContain('{brand}');
      }
    }

    // js/i18n.js puts <html data-brand> into {brand}
    const english = JSON.parse(fs.readFileSync(path.join(localesDir, 'en.json'), 'utf8'));
    const document = {
      documentElement: { dataset: { brand: 'Oma Frame' }, classList: { add() {}, remove() {} } },
      addEventListener() {}, querySelectorAll: () => [], querySelector: () => null
    };
    const window = {};
    vm.runInNewContext(read('js/i18n.js'), { window, document, setTimeout: () => {}, Intl });
    window.i18n.fallback = english;
    expect(window.i18n.t('admin.static_001')).toBe('Library · Oma Frame');
    expect(window.i18n.t('notes.sora_notes')).toBe('Oma Frame · Notes');
    // A value given by the caller still wins
    expect(window.i18n.t('admin.static_032', { brand: 'X' })).toBe('X library home');
  });
});

describe('accountUrl', () => {
  afterAll(() => pages.configure());

  test('off (self-hosted): Access stays in the header and tab bar, with no Account', async () => {
    const app = build();
    for (const url of Object.keys(HEADER_PAGES)) {
      const html = (await get(app, url)).text;
      expect(itemsOf(headerOf(html).html)).toContain('access');
      expect(itemsOf(headerOf(html).html)).not.toContain('account');
      expect(tabsOf(tabbarOf(html))).toContain('access');
    }
  });

  test('on: an Account link before Log out, and Access leaves the header and tab bar', async () => {
    const app = build({ accountUrl: '/account' });
    for (const url of Object.keys(HEADER_PAGES)) {
      const html = (await get(app, url)).text;
      const header = headerOf(html).html;
      expect(itemsOf(header).slice(-2)).toEqual(['account', 'logout']);
      expect(itemsOf(header)).not.toContain('access');
      expect(header).toMatch(/<a href="\/account" class="tb-btn icon" data-header-item="account" [^>]*data-i18n-attr="title:common.account; aria-label:common.account">/);
      expect(header).not.toContain('href="/access-accounts"');
      expect(tabsOf(tabbarOf(html))).not.toContain('access');
      expect(tabbarOf(html)).not.toContain('href="/access-accounts"');
    }
    // The page itself is still there for the host to link to
    await get(app, '/access-accounts').expect(200);
  });

  test('must be a path on this site or an http(s) address', () => {
    expect(pages.configure({ accountUrl: 'https://example.com/me' }).accountUrl).toBe('https://example.com/me');
    for (const accountUrl of ['javascript:alert(1)', '//evil.example', 'account', '', 42]) {
      expect(() => build({ accountUrl })).toThrow(TypeError);
    }
  });
});

describe('"New note" in the library', () => {
  test('sits with New folder and New snap, for people who can edit', () => {
    const html = pages.renderPage('admin.html');
    const actions = html.slice(html.indexOf('<div class="library-actions">'), html.indexOf('</section>', html.indexOf('<div class="library-actions">')));
    const ids = [...actions.matchAll(/<button id="(\w+)"/g)].map(match => match[1]);
    expect(ids).toEqual(['createFolderBtn', 'createSnapBtn', 'createNoteBtn', 'uploadBtn']);
    expect(actions).toMatch(/<button id="createNoteBtn" class="btn-outline" data-edit-only /);
  });

  test('opens the note editor for the folder that is open', () => {
    const context = { console, location: { href: '' }, document: { addEventListener() {} }, URLSearchParams };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(`${read('admin.js')}\n;this.PhotoFrameAdmin = PhotoFrameAdmin;`, context);
    const page = Object.create(context.PhotoFrameAdmin.prototype);
    page.currentPath = 'uploads/Family/Beach';
    page.createNote();
    expect(context.location.href).toBe('/notes?folder=uploads%2FFamily%2FBeach&new=1');
  });

  // A stand-in for any element: every property is another one, every call answers one
  function fakeElement(own = {}) {
    const listeners = {};
    const base = {
      style: {}, dataset: {}, value: '', textContent: '', hidden: false, disabled: false, open: false,
      options: [], children: [],
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      dispatch: type => (listeners[type] || []).forEach(fn => fn({ type, preventDefault() {} })),
      showModal() { this.open = true; },
      close() { this.open = false; this.dispatch('close'); },
      querySelectorAll: () => [],
      [Symbol.iterator]: function* () {},
      ...own
    };
    const handler = {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === 'symbol') return undefined;
        return (...args) => fakeElement(); // classList.toggle, appendChild, replaceChildren, …
      },
      set(target, prop, value) { target[prop] = value; return true; }
    };
    const proxy = new Proxy(base, handler);
    for (const name of ['classList', 'parentElement']) base[name] = new Proxy({}, { get: () => () => false });
    return proxy;
  }

  test('saving it writes the note into that folder, then goes back there', async () => {
    const app = build();
    await fs.ensureDir(path.join(testUploadsDir, 'Family', 'Beach'));

    // The notes page as the library's "New note" opens it, on the real js/notes.js,
    // js/pageEditor.js and js/notePage.js, its requests going to the app
    const elements = {};
    const element = id => (elements[id] = elements[id] || fakeElement({ id }));
    const fields = {};
    const form = fakeElement({
      elements: new Proxy(fields, { get: (target, name) => (target[name] = target[name] || (name === 'folder' ? element('noteFolder') : fakeElement({ name }))) }),
      reset() {},
      querySelector: () => fakeElement()
    });
    elements.noteForm = form;
    element('backLink');
    let ready;
    const context = {
      console, URLSearchParams, Intl, Date, Promise, JSON, Number, String, Set, Map,
      location: { search: '?folder=uploads%2FFamily%2FBeach&new=1', href: '/notes?folder=uploads%2FFamily%2FBeach&new=1' },
      setInterval: () => 0,
      setTimeout: (fn) => { fn(); return 0; },
      t: key => key,
      i18n: { error: (data, key) => (data && data.message) || key, t: key => key },
      document: {
        getElementById: element,
        createElement: () => fakeElement(),
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') ready = fn; }
      },
      fetch: async (url, options = {}) => {
        let call = request(app)[(options.method || 'GET').toLowerCase()](url).set('x-person', 'admin');
        if (options.body) call = call.set('Content-Type', 'application/json').send(options.body);
        const res = await call;
        return { ok: res.status < 400, status: res.status, json: async () => res.body };
      }
    };
    context.window = context;
    context.addEventListener = () => {};
    vm.createContext(context);
    vm.runInContext(read('js/notePage.js'), context);
    vm.runInContext(read('js/pageEditor.js'), context);
    vm.runInContext(read('js/notes.js'), context);
    ready();
    const manager = context.notesManager;

    // The editor opens by itself, on that folder
    for (let i = 0; i < 50 && !elements.noteModal?.open; i++) await new Promise(resolve => setImmediate(resolve));
    expect(elements.noteModal.open).toBe(true);
    expect(manager.editing).toBe(null);
    expect(fields.folder.value).toBe('uploads/Family/Beach');

    fields.title.value = 'Lunch on Sunday';
    fields.everyMinutes.value = '30';
    fields.showForSeconds.value = '20';
    await manager.saveNote();

    const written = (await fs.readdir(path.join(testUploadsDir, 'Family', 'Beach'))).filter(file => file.endsWith('.note.json'));
    expect(written).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(path.join(testUploadsDir, 'Family', 'Beach', written[0]), 'utf8')).title).toBe('Lunch on Sunday');
    // Saved and closed: back to the library folder it came from
    expect(context.location.href).toBe(elements.backLink.href);
    expect(elements.backLink.href).toBe('/admin?path=uploads%2FFamily%2FBeach');
  });
});

describe('Google Photos is in the Upload menu', () => {
  const { choices } = require('../public/js/addMenu');

  test('offered only to the owner, who can edit, when it is turned on', () => {
    const on = { googlePhotosEnabled: true };
    expect(choices({ features: on, canEdit: true, isOwner: true })).toEqual(['device', 'googlePhotos']);
    // Someone it's shared with who can edit uploads, but can't connect Google Photos
    expect(choices({ features: on, canEdit: true, isOwner: false })).toEqual(['device']);
    // Viewing only: nothing to add
    expect(choices({ features: on, canEdit: false, isOwner: false })).toEqual([]);
    // Turned off on the server, or the flags couldn't be read
    expect(choices({ features: { googlePhotosEnabled: false }, canEdit: true, isOwner: true })).toEqual(['device']);
    expect(choices({ features: null, canEdit: true, isOwner: true })).toEqual(['device']);
  });

  test('the menu item keeps the owner and editor marks, and Upload and + open the menu', () => {
    const html = pages.renderPage('admin.html');
    const menu = html.slice(html.indexOf('<div popover="manual" id="addMenu"'), html.indexOf('</div>\n            </div>', html.indexOf('id="addMenu"')));
    expect(menu).toMatch(/id="addFromDeviceBtn" data-add="device">/);
    expect(menu).toMatch(/id="googlePhotosBtn" data-add="googlePhotos" data-owner-only data-edit-only hidden>/);
    expect(html.match(/id="googlePhotosBtn"/g)).toHaveLength(1);
    expect(html).toMatch(/<button id="uploadBtn" [^>]*data-edit-only data-add-menu/);
    expect(html).toMatch(/<button type="button" class="tab-fab" id="addTabBtn" data-add-menu data-edit-only/);
    expect(html).toContain('<script src="/js/addMenu.js"></script>');
  });

  // js/addMenu.js on a small stand-in for the library page
  async function runMenu(features, scope) {
    const made = {};
    const node = (id) => {
      const listeners = {};
      const attrs = {};
      return made[id] = {
        id, hidden: id === 'googlePhotosBtn', style: {}, popoverOpen: false,
        addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
        click() { (listeners.click || []).forEach(fn => fn({ currentTarget: this, target: this })); },
        setAttribute: (name, value) => { attrs[name] = String(value); },
        attrs,
        contains: other => other === made[id],
        focus() {},
        matches() { return this.popoverOpen; },
        showPopover() { this.popoverOpen = true; },
        hidePopover() { this.popoverOpen = false; },
        querySelectorAll: () => [made.addFromDeviceBtn, made.googlePhotosBtn],
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 40, bottom: 40 }),
        offsetWidth: 200,
        offsetHeight: 90,
        isConnected: true
      };
    };
    ['addMenu', 'uploadBtn', 'addFromDeviceBtn', 'googlePhotosBtn'].forEach(node);
    const uploads = [];
    const context = {
      document: {
        readyState: 'complete',
        activeElement: null,
        getElementById: id => made[id] || null,
        querySelectorAll: selector => (selector === '[data-add-menu]' ? [made.uploadBtn] : []),
        addEventListener() {}
      },
      innerWidth: 1440,
      innerHeight: 900,
      addEventListener() {},
      SoraPlaceMenu: require('../public/js/placeMenu'),
      photoFrameAdmin: { showUploadModal: () => uploads.push('dialog') },
      SoraScope: {
        ready: Promise.resolve(features),
        canEdit: () => !scope || scope.canEdit !== false,
        isOwner: () => !scope || scope.isOwner !== false
      }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(read('js/addMenu.js'), context);
    await context.SoraScope.ready;
    await new Promise(resolve => setImmediate(resolve));
    return { made, uploads };
  }

  test('for the owner, Upload opens the menu with Google Photos in it', async () => {
    const { made, uploads } = await runMenu({ googlePhotosEnabled: true }, { canEdit: true, isOwner: true });
    expect(made.googlePhotosBtn.hidden).toBe(false);
    made.uploadBtn.click();
    expect(made.addMenu.popoverOpen).toBe(true);
    expect(made.uploadBtn.attrs['aria-expanded']).toBe('true');
    expect(uploads).toEqual([]);
    made.addFromDeviceBtn.click();
    expect(made.addMenu.popoverOpen).toBe(false);
    expect(uploads).toEqual(['dialog']);
  });

  test('for an editor who is not the owner, Upload goes straight to the device, no Google Photos', async () => {
    const { made, uploads } = await runMenu({ googlePhotosEnabled: true }, { canEdit: true, isOwner: false });
    expect(made.googlePhotosBtn.hidden).toBe(true);
    made.uploadBtn.click();
    expect(made.addMenu.popoverOpen).toBe(false);
    expect(uploads).toEqual(['dialog']);
  });

  test('self-hosted with Google Photos off: straight to the device too', async () => {
    const { made, uploads } = await runMenu({ googlePhotosEnabled: false, scope: null }, null);
    expect(made.googlePhotosBtn.hidden).toBe(true);
    made.uploadBtn.click();
    expect(uploads).toEqual(['dialog']);
  });
});
