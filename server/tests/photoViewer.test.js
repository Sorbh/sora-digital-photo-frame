const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The library photo viewer's list handling, run on the real admin.js methods
// with a minimal stand-in for the page.
const publicDir = path.join(__dirname, '..', 'public');

const element = () => ({
  hidden: false,
  open: false,
  textContent: '',
  src: '',
  alt: '',
  style: {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false }
});

function loadAdmin() {
  const elements = {};
  const get = id => (elements[id] = elements[id] || element());
  const context = {
    console,
    document: {
      getElementById: get,
      querySelector: selector => get(`query:${selector}`),
      addEventListener() {}
    },
    t: key => key,
    i18n: { error: (_, key) => key }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(`${fs.readFileSync(path.join(publicDir, 'admin.js'), 'utf8')}\n;this.PhotoFrameAdmin = PhotoFrameAdmin;`, context);
  const admin = Object.create(context.PhotoFrameAdmin.prototype);
  admin.availableImages = [];
  admin.currentImageUrl = null;
  admin.currentImageSlot = -1;
  return { admin, get };
}

const photos = names => names.map((name, index) => ({ name, url: `/photos/${name}`, index }));

describe('photo viewer', () => {
  test('a late folder response does not replace the folder (or photo) on screen', async () => {
    const { admin } = loadAdmin();
    const pending = {};
    admin.authenticatedFetch = url => new Promise(resolve => { pending[decodeURIComponent(url.split('path=')[1])] = resolve; });
    admin.clearSelection = () => {};
    admin.updateBreadcrumb = () => {};
    admin.updateBackButton = () => {};
    admin.showToast = () => {};
    const rendered = [];
    admin.renderFolderContents = data => rendered.push(data.folder);
    const answer = folder => ({ ok: true, json: async () => ({ folder }) });

    admin.currentPath = 'uploads/A';
    const loadA = admin.loadFolderContents();
    admin.currentPath = 'uploads/B';
    const loadB = admin.loadFolderContents();

    pending['uploads/B'](answer('B'));
    await loadB;
    pending['uploads/A'](answer('A'));
    await loadA;

    expect(rendered).toEqual(['B']);
  });

  test('a refresh of the same folder only draws the newest answer', async () => {
    const { admin } = loadAdmin();
    const pending = [];
    admin.authenticatedFetch = () => new Promise(resolve => pending.push(resolve));
    admin.clearSelection = () => {};
    admin.updateBreadcrumb = () => {};
    admin.updateBackButton = () => {};
    const rendered = [];
    admin.renderFolderContents = data => rendered.push(data.version);
    admin.currentPath = 'uploads/A';
    const first = admin.loadFolderContents();
    const second = admin.loadFolderContents();
    pending[1]({ ok: true, json: async () => ({ version: 2 }) });
    await second;
    pending[0]({ ok: true, json: async () => ({ version: 1 }) });
    await first;
    expect(rendered).toEqual([2]);
  });

  test('when the open photo is removed, the viewer shows the photo in its latest position', () => {
    const { admin, get } = loadAdmin();
    get('photoModal').open = true;
    admin.availableImages = photos(['A', 'B', 'C', 'D']);
    admin.currentImageUrl = '/photos/A';
    admin.currentImageSlot = 0;

    admin.availableImages = photos(['B', 'C', 'A', 'D']); // reordered: A is now third
    admin.updatePhotoModalNav();
    admin.availableImages = photos(['B', 'C', 'D']); // A deleted
    admin.updatePhotoModalNav();

    expect(admin.currentImageUrl).toBe('/photos/D');
    expect(get('modalPhotoName').textContent).toBe('D');
  });

  test('the viewer closes when the last photo goes, and hides the buttons for one photo', () => {
    const { admin, get } = loadAdmin();
    get('photoModal').open = true;
    let closed = false;
    admin.hidePhotoModal = () => { closed = true; };
    admin.availableImages = photos(['A', 'B']);
    admin.currentImageUrl = '/photos/A';
    admin.updatePhotoModalNav();
    expect(get('query:.photo-modal-nav').hidden).toBe(false);

    admin.availableImages = photos(['A']);
    admin.updatePhotoModalNav();
    expect(get('query:.photo-modal-nav').hidden).toBe(true);

    admin.availableImages = [];
    admin.updatePhotoModalNav();
    expect(closed).toBe(true);
  });

  test('in right-to-left pages the keyboard hint lists the arrows in the order they work', () => {
    const css = fs.readFileSync(path.join(publicDir, 'css', 'admin.css'), 'utf8');
    expect(css).toMatch(/html\[dir="rtl"\] \.photo-modal-hints \.keys \{\s*flex-direction: row-reverse;/);
  });
});
