const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The phone's Back button in the library: it goes up the folders opened and
// closes the photo viewer, instead of leaving the library (for the sign-in
// page). Runs the real admin.js and login.js against a stand-in browser history.
const publicDir = path.join(__dirname, '..', 'public');

// A browser's session history: entries, a position, and popstate on Back
function fakeBrowser(start) {
  const entries = [{ url: start, state: null }];
  let index = 0;
  const listeners = {};
  const location = {
    get href() { return entries[index].url; },
    get search() { return new URL(entries[index].url).search; },
    get hash() { return new URL(entries[index].url).hash; },
    replace(url) { entries[index] = { url: new URL(url, entries[index].url).href, state: null }; },
    reload() { location.reloaded = (location.reloaded || 0) + 1; },
    toString() { return entries[index].url; }
  };
  const history = {
    get state() { return entries[index].state; },
    get length() { return entries.length; },
    pushState(state, _, url) {
      entries.splice(index + 1);
      entries.push({ url: new URL(url, entries[index].url).href, state });
      index++;
    },
    replaceState(state, _, url) { entries[index] = { url: new URL(url, entries[index].url).href, state }; },
    back() {
      if (index === 0) return;
      index--;
      (listeners.popstate || []).forEach(fn => fn({ state: entries[index].state }));
    }
  };
  const addEventListener = (type, fn) => (listeners[type] = listeners[type] || []).push(fn);
  return { entries, location, history, addEventListener, listeners, at: () => index };
}

function element() {
  const listeners = {};
  return {
    open: false, textContent: '', src: '', alt: '', style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener: (type, fn) => (listeners[type] = listeners[type] || []).push(fn),
    showModal() { this.open = true; },
    close() {
      if (!this.open) return;
      this.open = false;
      (listeners.close || []).forEach(fn => fn());
    }
  };
}

function loadAdmin(start = 'https://frame.example/admin') {
  const browser = fakeBrowser(start);
  const elements = {};
  const get = id => (elements[id] = elements[id] || element());
  const context = {
    console, URL, URLSearchParams,
    location: browser.location,
    history: browser.history,
    addEventListener: browser.addEventListener,
    document: { getElementById: get, querySelector: selector => get(`query:${selector}`), addEventListener() {} },
    t: key => key,
    i18n: { error: (_, key) => key }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(`${fs.readFileSync(path.join(publicDir, 'admin.js'), 'utf8')}\n;this.PhotoFrameAdmin = PhotoFrameAdmin;`, context);
  const admin = Object.create(context.PhotoFrameAdmin.prototype);
  admin.currentPath = admin.getInitialPath();
  admin.loaded = [];
  admin.loadFolderContents = () => admin.loaded.push(admin.currentPath);
  admin.setupPhotoModalInteractions = () => {};
  admin.updatePhotoModalNav = () => {};
  admin.currentImagePosition = () => 0;
  // Selection mode (js/selectionMode.js), on the same history
  admin.selection = require('../public/js/selectionMode').create({ history: browser.history, onChange: () => {} });
  // The two listeners initializeEventListeners adds for this
  browser.addEventListener('popstate', () => admin.handleHistory());
  get('photoModal').addEventListener('close', () => { if (browser.history.state?.photo) browser.history.back(); });
  return { admin, browser, modal: get('photoModal') };
}

const folderOf = browser => new URL(browser.location.href).searchParams.get('path') || 'uploads';

describe('Back in the library', () => {
  test('goes up the folders opened, one at a time, and only then leaves', () => {
    const { admin, browser } = loadAdmin();
    admin.navigateTo('uploads/Family');
    admin.navigateTo('uploads/Family/Beach');
    expect(folderOf(browser)).toBe('uploads/Family/Beach');

    browser.history.back();
    expect(admin.currentPath).toBe('uploads/Family');
    expect(folderOf(browser)).toBe('uploads/Family');
    browser.history.back();
    expect(admin.currentPath).toBe('uploads');
    expect(admin.loaded).toEqual(['uploads/Family', 'uploads/Family/Beach', 'uploads/Family', 'uploads']);
    expect(browser.at()).toBe(0); // the next Back leaves the library
  });

  test('opening the folder already shown adds no entry', () => {
    const { admin, browser } = loadAdmin('https://frame.example/admin?path=uploads%2FFamily');
    expect(admin.currentPath).toBe('uploads/Family');
    admin.navigateTo('uploads/Family');
    expect(browser.history.length).toBe(1);
  });

  test("the library's own back arrow is a step like any other", () => {
    const { admin, browser } = loadAdmin();
    admin.navigateTo('uploads/Family');
    admin.navigateBack();
    expect(admin.currentPath).toBe('uploads');
    expect(folderOf(browser)).toBe('uploads');
  });

  test('closes the photo viewer before anything else, and leaves the folder as it was', () => {
    const { admin, browser, modal } = loadAdmin();
    admin.navigateTo('uploads/Family');
    admin.showPhotoModal('/uploads/Family/a.jpg', 'a.jpg');
    admin.showPhotoModal('/uploads/Family/b.jpg', 'b.jpg'); // next photo: no new entry
    expect(modal.open).toBe(true);
    expect(browser.history.length).toBe(3);

    browser.history.back();
    expect(modal.open).toBe(false);
    expect(admin.currentPath).toBe('uploads/Family');
    expect(admin.loaded).toEqual(['uploads/Family']); // not loaded again
  });

  test('closing the viewer with its X (or Escape) takes its entry away too', () => {
    const { admin, browser, modal } = loadAdmin();
    admin.navigateTo('uploads/Family');
    admin.showPhotoModal('/uploads/Family/a.jpg', 'a.jpg');
    admin.hidePhotoModal();
    expect(modal.open).toBe(false);
    expect(browser.history.state?.photo).toBeFalsy();
    expect(browser.at()).toBe(1);

    browser.history.back(); // the next Back goes up a folder, not to a closed viewer
    expect(admin.currentPath).toBe('uploads');
  });
});

describe('Back and selection', () => {
  test('selecting adds an entry; Back ends selection and stays in the folder', () => {
    const { admin, browser } = loadAdmin();
    admin.navigateTo('uploads/Family');
    admin.selection.toggle('uploads/Family/a.jpg');
    admin.selection.toggle('uploads/Family/b.jpg');
    expect(browser.history.length).toBe(3); // one entry for the selection, not one per photo
    expect(browser.history.state.selecting).toBe(true);

    browser.history.back();
    expect(admin.selection.active).toBe(false);
    expect(admin.currentPath).toBe('uploads/Family');
    expect(admin.loaded).toEqual(['uploads/Family']); // not loaded again
    browser.history.back(); // then up a folder, as before
    expect(admin.currentPath).toBe('uploads');
  });

  test('Cancel (or unticking the last photo) takes its entry away', () => {
    const { admin, browser } = loadAdmin();
    admin.navigateTo('uploads/Family');
    admin.selection.toggle('uploads/Family/a.jpg');
    admin.clearSelection();
    expect(browser.at()).toBe(1);
    expect(browser.history.state?.selecting).toBeFalsy();

    admin.selection.toggle('uploads/Family/a.jpg');
    admin.selection.toggle('uploads/Family/a.jpg');
    expect(browser.at()).toBe(1);
  });

  test('a folder opened while selecting takes the selection\'s entry, so Back returns to the folder before', () => {
    const { admin, browser } = loadAdmin();
    admin.navigateTo('uploads/Family');
    admin.selection.toggle('uploads/Family/a.jpg');
    admin.navigateTo('uploads/Family/Beach');
    expect(admin.selection.active).toBe(false);
    expect(browser.history.length).toBe(3);
    expect(browser.history.state?.selecting).toBeFalsy();
    browser.history.back();
    expect(admin.currentPath).toBe('uploads/Family');
  });
});

describe('signing in', () => {
  const loginPage = () => {
    const browser = fakeBrowser('https://frame.example/login?next=%2Fpair');
    const elements = {};
    const get = id => (elements[id] = elements[id] || { addEventListener() {}, classList: { add() {}, remove() {} }, style: {} });
    const timers = [];
    const context = {
      console, URLSearchParams,
      location: browser.location,
      addEventListener: browser.addEventListener,
      document: { getElementById: get, querySelector: get, addEventListener() {}, readyState: 'loading' },
      setTimeout: fn => timers.push(fn),
      fetch: async () => ({ ok: true, json: async () => ({ success: true }) }),
      t: key => key,
      i18n: { error: (_, key) => key }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(`${fs.readFileSync(path.join(publicDir, 'js/login.js'), 'utf8')}\n;this.LoginManager = LoginManager;`, context);
    return { browser, timers, manager: new context.LoginManager(), get };
  };

  test('takes the sign-in page out of the history, so Back from the library never shows it', async () => {
    const { browser, timers, manager, get } = loginPage();
    get('passwordInput').value = 'secret';
    await manager.handleLogin({ preventDefault() {} });
    timers.forEach(fn => fn());
    expect(browser.entries.map(entry => entry.url)).toEqual(['https://frame.example/pair']);
  });

  test('a copy of the sign-in page the browser kept is asked for again', () => {
    const { browser } = loginPage();
    browser.listeners.pageshow.forEach(fn => fn({ persisted: true }));
    expect(browser.location.reloaded).toBe(1);
  });
});
