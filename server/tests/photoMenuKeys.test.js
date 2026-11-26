const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The library's photo and folder options menu with a keyboard, run on the real
// admin.js methods with a small stand-in for the page
const publicDir = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'admin.html'), 'utf8');

function loadMenu() {
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
    t: key => key
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
    const menu = html.slice(html.indexOf('<div role="menu"'), html.indexOf('</div>', html.indexOf('<div role="menu"')));
    expect(menu).not.toMatch(/<div role="menuitem"/);
    expect(menu.match(/<button type="button" role="menuitem" tabindex="-1"/g)).toHaveLength(7);
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

  test('choosing an item closes it back on the options button too', async () => {
    const { admin, document, node, items } = loadMenu();
    const button = node({ 'aria-haspopup': 'menu' });
    admin.nudge = jest.fn();
    admin.showContextMenu({ type: 'click', currentTarget: button, preventDefault() {} }, { name: 'a.jpg', type: 'image' });
    items[5].focus();
    await admin.handleContextMenuAction('move-later');
    expect(admin.nudge).toHaveBeenCalledWith(expect.objectContaining({ name: 'a.jpg' }), 1);
    expect(document.activeElement).toBe(button);
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
