const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The library's photo and folder options menu with a keyboard, run on the real
// admin.js methods with a small stand-in for the page
const publicDir = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'admin.html'), 'utf8');

function loadMenu(page = {}) {
  const document = { activeElement: null, body: null, addEventListener() {} };
  const node = (attrs = {}) => {
    const attributes = new Map(Object.entries(attrs));
    const el = {
      style: {},
      dataset: {},
      isConnected: true,
      focus: () => { document.activeElement = el; },
      getAttribute: name => (attributes.has(name) ? attributes.get(name) : null),
      setAttribute: (name, value) => attributes.set(name, String(value)),
      removeAttribute: name => attributes.delete(name),
      hasAttribute: name => attributes.has(name),
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 40, bottom: 40 })
    };
    return el;
  };
  document.body = node();

  // The menu's items, as in admin.html: [action, data-for]
  const items = [
    ['rotate-right', 'image'], ['rotate-left', 'image'], ['create-snap', 'image'], ['edit-snap', 'snap'],
    ['move-earlier', 'image snap'], ['move-later', 'image snap'], ['delete', undefined]
  ].map(([action, forTypes]) => {
    const item = node();
    item.dataset.action = action;
    if (forTypes) item.dataset.for = forTypes;
    return item;
  });
  let open = false;
  const popover = node();
  Object.assign(popover, {
    offsetWidth: 200,
    offsetHeight: 300,
    contains: el => el === popover || items.includes(el),
    matches: selector => selector === ':popover-open' && open,
    showPopover: () => { open = true; },
    hidePopover: () => { open = false; },
    querySelectorAll: selector => (selector === '.menu-item' ? items : items.filter(item => item.dataset.for))
  });
  document.getElementById = id => (id === 'contextMenuPopover' ? popover : node());

  const context = {
    console: { log() {}, error() {}, warn() {} },
    document,
    Element: Object,
    SoraPlaceMenu: require('../public/js/placeMenu'),
    innerWidth: 1280,
    innerHeight: 800,
    t: key => key,
    ...page
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(`${fs.readFileSync(path.join(publicDir, 'admin.js'), 'utf8')}\n;this.PhotoFrameAdmin = PhotoFrameAdmin;`, context);
  const admin = Object.create(context.PhotoFrameAdmin.prototype);
  const action = item => item && item.dataset.action;
  const key = name => {
    const event = { key: name, defaultPrevented: false, preventDefault() { event.defaultPrevented = true; } };
    admin.contextMenuKey(event);
    return event;
  };
  return { admin, document, popover, items, node, isOpen: () => open, focused: () => action(document.activeElement), key };
}

describe('the photo options menu with a keyboard', () => {
  test('its items are buttons the page can focus', () => {
    const start = html.indexOf('<div role="menu"', html.indexOf('id="contextMenuPopover"'));
    const menu = html.slice(start, html.indexOf('</div>', start));
    expect(menu).not.toMatch(/<div role="menuitem"/);
    expect(menu.match(/<button type="button" role="menuitem" tabindex="-1"/g)).toHaveLength(8);
  });

  test('the options button opens it on the first item, and arrows move round it', () => {
    const { admin, node, focused, key, isOpen } = loadMenu();
    const button = node({ 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
    button.focus();
    admin.showContextMenu({ type: 'click', currentTarget: button, preventDefault() {} }, { name: 'a.jpg', type: 'image' });

    expect(isOpen()).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(focused()).toBe('rotate-right');
    expect(key('ArrowDown').defaultPrevented).toBe(true);
    expect(focused()).toBe('rotate-left');
    key('ArrowUp');
    key('ArrowUp'); // round the top to the bottom
    expect(focused()).toBe('delete');
    key('ArrowDown');
    expect(focused()).toBe('rotate-right');
    key('End');
    expect(focused()).toBe('delete');
    key('Home');
    expect(focused()).toBe('rotate-right');
  });

  test('items hidden for this kind of item are skipped', () => {
    const { admin, node, focused, key } = loadMenu();
    const button = node({ 'aria-haspopup': 'menu' });
    admin.showContextMenu({ type: 'click', currentTarget: button, preventDefault() {} }, { name: 'page', type: 'snap' });
    expect(focused()).toBe('edit-snap');
    key('ArrowDown');
    expect(focused()).toBe('move-earlier');
    key('ArrowDown');
    key('ArrowDown');
    expect(focused()).toBe('delete');
    key('ArrowDown');
    expect(focused()).toBe('edit-snap');
  });

  test('Escape closes it and puts focus back on the options button', () => {
    const { admin, document, node, isOpen } = loadMenu();
    const button = node({ 'aria-haspopup': 'menu' });
    admin.showContextMenu({ type: 'click', currentTarget: button, preventDefault() {} }, { name: 'a.jpg', type: 'image' });
    admin.hideContextMenu(); // what Escape does (setupEventListeners)
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  test('Tab closes it, so focus goes on from the options button', () => {
    const { admin, document, node, key, isOpen } = loadMenu();
    const button = node({ 'aria-haspopup': 'menu' });
    admin.showContextMenu({ type: 'click', currentTarget: button, preventDefault() {} }, { name: 'a.jpg', type: 'image' });
    expect(key('Tab').defaultPrevented).toBe(false);
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  test('a click elsewhere closes it without pulling focus back', () => {
    const { admin, document, node, items } = loadMenu();
    const button = node({ 'aria-haspopup': 'menu' });
    admin.showContextMenu({ type: 'click', currentTarget: button, preventDefault() {} }, { name: 'a.jpg', type: 'image' });
    admin.hideContextMenu({ returnFocus: false });
    expect(document.activeElement).toBe(items[0]); // the browser moves it to the click
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  test('a right-click menu goes back to what had focus', () => {
    const { admin, document, node } = loadMenu();
    const cell = node();
    cell.focus();
    admin.showContextMenu({ type: 'contextmenu', currentTarget: node(), clientX: 10, clientY: 10, preventDefault() {} }, { name: 'a.jpg', type: 'image' });
    admin.hideContextMenu();
    expect(document.activeElement).toBe(cell);
    expect(cell.hasAttribute('aria-expanded')).toBe(false);
  });
});

// A tiny page: enough HTML parsing and selectors for admin.js to build the real grid
function miniPage() {
  const document = { activeElement: null, addEventListener() {} };
  const VOID = new Set(['img', 'input', 'hr', 'br']);
  const camel = name => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

  function element(tag) {
    const attributes = new Map();
    const listeners = {};
    const el = {
      tagName: tag.toUpperCase(), children: [], parentNode: null, dataset: {}, textContent: '', style: { setProperty() {} },
      get className() { return attributes.get('class') || ''; },
      set className(value) { attributes.set('class', value); },
      classList: {
        contains: name => el.className.split(/\s+/).includes(name),
        add: name => { if (!el.classList.contains(name)) el.className = `${el.className} ${name}`.trim(); },
        remove: name => { el.className = el.className.split(/\s+/).filter(c => c !== name).join(' '); },
        toggle: (name, on = !el.classList.contains(name)) => (on ? el.classList.add(name) : el.classList.remove(name))
      },
      getAttribute: name => (attributes.has(name) ? attributes.get(name) : null),
      setAttribute: (name, value) => {
        attributes.set(name, String(value));
        if (name.startsWith('data-')) el.dataset[camel(name.slice(5))] = String(value);
      },
      hasAttribute: name => attributes.has(name),
      removeAttribute: name => attributes.delete(name),
      get isConnected() { let n = el; while (n.parentNode) n = n.parentNode; return Boolean(n.root); },
      appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
      replaceChildren(...kids) { el.children.forEach(c => { c.parentNode = null; }); el.children = []; kids.forEach(k => el.appendChild(k)); },
      set innerHTML(html) { el.replaceChildren(); parse(html, el); },
      get innerHTML() { return ''; },
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      fire: (type, event = {}) => (listeners[type] || []).forEach(fn => fn({ type, currentTarget: el, target: el, preventDefault() {}, stopPropagation() {}, ...event })),
      focus: () => { document.activeElement = el; },
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 40, bottom: 40, width: 40, height: 40 }),
      matches: selector => selector.split(',').some(one => matchChain(el, one.trim().split(/\s+/))),
      closest: selector => { for (let n = el; n; n = n.parentNode) if (n.matches && n.matches(selector)) return n; return null; },
      contains: other => { for (let n = other; n; n = n.parentNode) if (n === el) return true; return false; },
      querySelectorAll: selector => {
        const found = [];
        const walk = n => n.children.forEach(c => { if (c.matches(selector)) found.push(c); walk(c); });
        walk(el);
        return found;
      },
      querySelector: selector => el.querySelectorAll(selector)[0] || null
    };
    return el;
  }

  // "A B": B inside an A
  function matchChain(el, parts) {
    if (!matchOne(el, parts[parts.length - 1])) return false;
    if (parts.length === 1) return true;
    for (let n = el.parentNode; n; n = n.parentNode) if (matchChain(n, parts.slice(0, -1))) return true;
    return false;
  }

  // tag.class.class[attr="value"]
  function matchOne(el, selector) {
    const m = selector.match(/^([a-z0-9]*)((?:\.[\w-]+)*)((?:\[[\w-]+(?:="[^"]*")?\])*)$/i);
    if (!m) throw new Error(`selector not supported here: ${selector}`);
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    if (m[2] && !m[2].slice(1).split('.').every(c => el.classList.contains(c))) return false;
    return [...m[3].matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].every(([, name, value]) =>
      (value === undefined ? el.hasAttribute(name) : el.getAttribute(name) === value));
  }

  function parse(html, parent) {
    let at = parent;
    for (const [, close, tag, attrs] of html.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>/gi)) {
      if (close) { at = at.parentNode || at; continue; }
      const child = element(tag.toLowerCase());
      for (const [, name, value = ''] of attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) child.setAttribute(name, value);
      at.appendChild(child);
      if (!VOID.has(tag.toLowerCase())) at = child;
    }
  }

  const elements = {};
  const root = element('body');
  root.root = true;
  document.body = root;
  document.createElement = tag => element(tag);
  document.getElementById = id => {
    if (!elements[id]) elements[id] = root.appendChild(element('div'));
    return elements[id];
  };
  document.querySelector = selector => root.querySelector(selector);
  document.querySelectorAll = () => [];
  return { document, root };
}

describe('a menu action that redraws the grid', () => {
  test('Rotate from the keyboard leaves focus on the same photo\'s options button in the new grid', async () => {
    const { document } = miniPage();
    // The menu, as admin.html has it
    const popover = document.getElementById('contextMenuPopover');
    popover.innerHTML = fs.readFileSync(path.join(publicDir, 'admin.html'), 'utf8')
      .match(/<div popover="manual" id="contextMenuPopover"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<!-- Modals -->/)[1];
    let open = false;
    Object.assign(popover, { matches: s => s === ':popover-open' && open, showPopover: () => { open = true; }, hidePopover: () => { open = false; } });

    const context = {
      console: { log() {}, error() {}, warn() {} },
      document,
      Element: Object,
      CSS: { escape: value => value },
      SoraPlaceMenu: require('../public/js/placeMenu'),
      SoraLongPress: { attach: () => ({ cancel() {} }) },
      navigator: {},
      innerWidth: 1280,
      innerHeight: 800,
      setTimeout: fn => fn(), // the grid reloads a moment after a rotation
      t: key => key,
      i18n: { error: (_, key) => key }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(`${fs.readFileSync(path.join(publicDir, 'admin.js'), 'utf8')}\n;this.PhotoFrameAdmin = PhotoFrameAdmin;`, context);
    const admin = Object.create(context.PhotoFrameAdmin.prototype);
    Object.assign(admin, {
      currentPath: 'uploads/Goa', selectedItems: new Set(), availableImages: [], longPressDelay: 500,
      clearSelection() {}, updateBreadcrumb() {}, updateBackButton() {}, showToast() {}, updatePhotoModalNav() {}
    });
    const listing = { folders: [], files: [
      { name: 'a.jpg', path: 'uploads/Goa/a.jpg', url: '/a', thumbnail: '/a.t', type: 'image' },
      { name: 'b.jpg', path: 'uploads/Goa/b.jpg', url: '/b', thumbnail: '/b.t', type: 'image' }
    ] };
    let reloaded;
    const listed = new Promise(resolve => { reloaded = resolve; });
    admin.authenticatedFetch = async (url) => {
      if (url.startsWith('/api/admin/folders')) { setImmediate(reloaded); return { ok: true, json: async () => listing }; }
      return { ok: true, json: async () => ({ success: true }) }; // the rotation
    };
    admin.renderFolderContents(listing);

    const grid = document.getElementById('fileGrid');
    const optionsFor = (p) => grid.querySelectorAll('.file-item').find(tile => tile.dataset.path === p).querySelector('.photo-more');
    const before = optionsFor('uploads/Goa/b.jpg');
    before.focus();
    before.fire('click'); // Enter on the options button
    expect(document.activeElement.dataset.action).toBe('rotate-right');

    await admin.handleContextMenuAction('rotate-right'); // Enter on Rotate Right
    await listed;
    await new Promise(resolve => setImmediate(resolve));

    const after = optionsFor('uploads/Goa/b.jpg');
    expect(after).not.toBe(before); // the grid was drawn again
    expect(before.isConnected).toBe(false);
    expect(document.activeElement).toBe(after);
    expect(after.isConnected).toBe(true);
  });
});

describe('for someone who can only view (js/scope.js)', () => {
  const viewOnly = { SoraScope: { canEdit: () => false } };

  test('the options menu does not open', () => {
    const { admin, node, isOpen } = loadMenu(viewOnly);
    admin.showContextMenu({ type: 'click', currentTarget: node(), preventDefault() {} }, { name: 'a.jpg', type: 'image' });
    expect(isOpen()).toBe(false);
  });

  test('photos are not selected, moved or uploaded', () => {
    const { admin } = loadMenu(viewOnly);
    admin.selectedItems = new Set();
    admin.toggleSelection({ path: 'uploads/Family/a.jpg' });
    expect(admin.selectedItems.size).toBe(0);

    const done = [];
    admin.movePhotos = () => done.push('move');
    admin.uploadFilesDirectly = () => done.push('upload');
    admin.moveDroppedPhotos({ dataTransfer: { getData: () => '["uploads/Family/a.jpg"]' } }, 'uploads/Family/Sub');
    admin.uploadDroppedFiles({ dataTransfer: { files: [{ type: 'image/jpeg', name: 'a.jpg' }] } }, 'uploads/Family');
    expect(done).toEqual([]);
  });

  test('someone who can edit still can', () => {
    const { admin } = loadMenu({ SoraScope: { canEdit: () => true } });
    const done = [];
    admin.movePhotos = () => done.push('move');
    admin.uploadFilesDirectly = () => done.push('upload');
    admin.moveDroppedPhotos({ dataTransfer: { getData: () => '["uploads/Family/a.jpg"]' } }, 'uploads/Family/Sub');
    admin.uploadDroppedFiles({ dataTransfer: { files: [{ type: 'image/jpeg', name: 'a.jpg' }] } }, 'uploads/Family');
    expect(done).toEqual(['move', 'upload']);
  });
});

describe('a folder that can\'t be opened', () => {
  test('goes back to the top of the library instead of an empty page', async () => {
    const { admin } = loadMenu({ i18n: { error: () => 'error' } });
    const asked = [];
    const toasts = [];
    admin.currentPath = 'uploads/Other';
    admin.clearSelection = () => {};
    admin.setCreateFolder = () => {};
    admin.knownCreateFolder = () => 'allowed';
    admin.updateURL = () => {};
    admin.updateBreadcrumb = () => {};
    admin.updateBackButton = () => {};
    admin.renderFolderContents = () => {};
    admin.showToast = (message) => toasts.push(message);
    admin.authenticatedFetch = async (url) => {
      asked.push(decodeURIComponent(url));
      const top = url.endsWith('=uploads');
      return { ok: top, status: top ? 200 : 404, json: async () => (top ? { folders: [], files: [] } : { message: 'Folder not found' }) };
    };
    await admin.loadFolderContents();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(asked).toEqual(['/api/admin/folders?path=uploads/Other', '/api/admin/folders?path=uploads']);
    expect(admin.currentPath).toBe('uploads');
    expect(toasts).toEqual(['errors.FOLDER_NOT_FOUND']);
  });
});
