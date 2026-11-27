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

  // The menu's items, as in admin.html: [action, data-for, data-order]
  const items = [...html.slice(html.indexOf('id="contextMenuPopover"'), html.indexOf('<!-- Modals -->'))
    .matchAll(/<button type="button" role="menuitem"[^>]*data-action="([\w-]+)"(?: data-for="([\w ]+)")?(?: data-order="(\w+)")?/g)]
    .map(([, action, forTypes, order]) => {
      const item = node();
      item.dataset.action = action;
      if (forTypes) item.dataset.for = forTypes;
      if (order) item.dataset.order = order;
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
    expect(menu.match(/<button type="button" role="menuitem" tabindex="-1"/g)).toHaveLength(10);
  });

  test('a photo\'s menu: View, Rotate, Create snap, Move to… and Delete; Move earlier and later only in My order', () => {
    const { admin, node, items } = loadMenu();
    const shown = () => items.filter(item => item.style.display !== 'none').map(item => item.dataset.action);
    admin.playOrder = 'newest';
    admin.showContextMenu({ type: 'click', currentTarget: node({ 'aria-haspopup': 'menu' }), preventDefault() {} }, { name: 'a.jpg', type: 'image' });
    expect(shown()).toEqual(['view', 'rotate-right', 'rotate-left', 'create-snap', 'move', 'delete']);
    admin.playOrder = 'custom';
    admin.showContextMenu({ type: 'click', currentTarget: node({ 'aria-haspopup': 'menu' }), preventDefault() {} }, { name: 'a.jpg', type: 'image' });
    expect(shown()).toEqual(['view', 'rotate-right', 'rotate-left', 'create-snap', 'move', 'move-earlier', 'move-later', 'delete']);
    // A folder's: Delete (a host adds Share… to it)
    admin.showContextMenu({ type: 'click', currentTarget: node({ 'aria-haspopup': 'menu' }), preventDefault() {} }, { name: 'Family', type: 'folder' });
    expect(shown()).toEqual(['delete']);
  });

  test('the options button opens it on the first item, and arrows move round it', () => {
    const { admin, node, focused, key, isOpen } = loadMenu();
    const button = node({ 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
    button.focus();
    admin.showContextMenu({ type: 'click', currentTarget: button, preventDefault() {} }, { name: 'a.jpg', type: 'image' });

    expect(isOpen()).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(focused()).toBe('view');
    expect(key('ArrowDown').defaultPrevented).toBe(true);
    expect(focused()).toBe('rotate-right');
    key('ArrowUp');
    key('ArrowUp'); // round the top to the bottom
    expect(focused()).toBe('delete');
    key('ArrowDown');
    expect(focused()).toBe('view');
    key('End');
    expect(focused()).toBe('delete');
    key('Home');
    expect(focused()).toBe('view');
  });

  test('items hidden for this kind of item are skipped', () => {
    const { admin, node, focused, key } = loadMenu();
    const button = node({ 'aria-haspopup': 'menu' });
    admin.showContextMenu({ type: 'click', currentTarget: button, preventDefault() {} }, { name: 'page', type: 'snap' });
    expect(focused()).toBe('edit-snap');
    key('ArrowDown');
    expect(focused()).toBe('move');
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
      SoraJustified: require('../public/js/justifiedLayout'),
      requestAnimationFrame: fn => fn(),
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
      currentPath: 'uploads/Goa', availableImages: [], longPressDelay: 500, measured: new Map(),
      selection: require('../public/js/selectionMode').create({}),
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
    expect(document.activeElement.dataset.action).toBe('view');

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

describe('the photo grid', () => {
  // The real admin.js drawing a listing on the small page above
  function drawGrid(listing, { width = 1000, order = 'shuffle' } = {}) {
    const { document } = miniPage();
    const context = {
      console: { log() {}, error() {}, warn() {} },
      document, Element: Object, CSS: { escape: value => value },
      SoraPlaceMenu: require('../public/js/placeMenu'),
      SoraLongPress: { attach: () => ({ cancel() {} }) },
      SoraJustified: require('../public/js/justifiedLayout'),
      requestAnimationFrame: fn => fn(),
      navigator: {}, t: (key, vars) => (vars && 'count' in vars ? `${key}:${vars.count}` : key), i18n: { error: (_, key) => key, locale: 'en' }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(`${fs.readFileSync(path.join(publicDir, 'admin.js'), 'utf8')}\n;this.PhotoFrameAdmin = PhotoFrameAdmin;`, context);
    const admin = Object.create(context.PhotoFrameAdmin.prototype);
    Object.assign(admin, {
      currentPath: 'uploads/Goa', availableImages: [], longPressDelay: 500, measured: new Map(),
      selection: require('../public/js/selectionMode').create({ onChange: () => admin.updateSelectionUI() }),
      updateBreadcrumb() {}, updateBackButton() {}, showToast() {}, updatePhotoModalNav() {}
    });
    const grid = document.getElementById('fileGrid');
    grid.getBoundingClientRect = () => ({ width });
    admin.renderFolderContents({ order, folders: [], files: listing });
    admin.photoArea.getBoundingClientRect = () => ({ width });
    admin.layoutPhotos();
    const all = [];
    const walk = n => n.children.forEach(c => { all.push(c); walk(c); });
    walk(grid);
    return { admin, grid, all, tiles: grid.querySelectorAll('.file-item') };
  }
  const photo = (name, width, height, date) => ({
    name, type: 'image', path: `uploads/Goa/${name}`, url: `/u/${name}`, thumbnail: `/t/${name}`, preview: `/t/${name}&fit=inside`, width, height, date
  });

  test('shows no file names: not as text, not in any attribute', () => {
    const listing = [photo('images-1790007919.jpg', 1600, 1200), photo('IMG_2041.jpg', 1200, 1600)];
    const { all } = drawGrid(listing);
    for (const el of all) {
      expect(el.textContent).not.toMatch(/images-1790007919|IMG_2041/);
      for (const name of ['alt', 'title', 'aria-label', 'data-tooltip']) {
        expect(String(el.getAttribute(name) || '')).not.toMatch(/images-1790007919|IMG_2041/);
      }
    }
    expect(all.some(el => el.classList.contains('photo-grid-name'))).toBe(false);
    // Each tile shows the photo in its own shape: the shaped thumbnail
    expect(all.filter(el => el.tagName === 'IMG').map(img => img.src)).toEqual(['/t/images-1790007919.jpg&fit=inside', '/t/IMG_2041.jpg&fit=inside']);
  });

  test('lays photos in rows that keep their shape', () => {
    const listing = [photo('a.jpg', 1600, 1200), photo('b.jpg', 1200, 1600), photo('c.jpg', 1400, 1400), photo('d.jpg', 3000, 1000)];
    const { tiles } = drawGrid(listing, { width: 1000 });
    const size = tile => [parseFloat(tile.style.width), parseFloat(tile.style.height)];
    const [a, b, c] = tiles.map(size);
    expect(a[1]).toBe(b[1]); // one height per row
    expect(a[0] / a[1]).toBeCloseTo(4 / 3, 1);
    expect(b[0] / b[1]).toBeCloseTo(3 / 4, 1);
    expect(c[0] / c[1]).toBeCloseTo(1, 1);
  });

  test('newest first: grouped by month under quiet headings; shuffle keeps one list', () => {
    const listing = [photo('a.jpg', 4, 3, '2026-10-05T10:00:00'), photo('b.jpg', 4, 3, '2026-10-01T10:00:00'), photo('c.jpg', 4, 3, '2026-08-12T10:00:00')];
    const newest = drawGrid(listing, { order: 'newest' });
    const headings = newest.all.filter(el => el.classList.contains('photo-group-title'));
    expect(headings).toHaveLength(2);
    expect(newest.all.filter(el => el.classList.contains('photo-group')).map(group => group.querySelectorAll('.file-item').length)).toEqual([2, 1]);
    const shuffle = drawGrid(listing, { order: 'shuffle' });
    expect(shuffle.all.filter(el => el.classList.contains('photo-group-title'))).toHaveLength(0);
    expect(shuffle.tiles.map(tile => tile.dataset.path)).toEqual(listing.map(file => file.path));
  });

  test('ticking one starts selection: every tile shows its check, a click ticks instead of opening', () => {
    const listing = [photo('a.jpg', 4, 3), photo('b.jpg', 4, 3), photo('c.jpg', 4, 3)];
    const { admin, grid, tiles } = drawGrid(listing);
    const opened = [];
    admin.openTile = file => opened.push(file.name);
    tiles[0].fire('click');
    expect(opened).toEqual(['a.jpg']);

    tiles[1].querySelector('input').fire('change');
    expect(grid.classList.contains('selecting')).toBe(true);
    tiles[2].fire('click');
    expect(opened).toEqual(['a.jpg']);
    expect(admin.selection.keys()).toEqual(['uploads/Goa/b.jpg', 'uploads/Goa/c.jpg']);
    expect(tiles[2].classList.contains('selected')).toBe(true);

    admin.selectAll();
    expect(admin.selection.size).toBe(3);
    admin.clearSelection();
    expect(grid.classList.contains('selecting')).toBe(false);
    expect(tiles.some(tile => tile.classList.contains('selected'))).toBe(false);
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
    admin.selection = require('../public/js/selectionMode').create({});
    admin.toggleSelection({ path: 'uploads/Family/a.jpg' });
    admin.selectAll();
    expect(admin.selection.size).toBe(0);
    admin.openMoveDialog(['uploads/Family/a.jpg']);
    expect(admin.moving).toBeUndefined();

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
