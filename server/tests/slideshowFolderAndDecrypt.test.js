const fs = require('fs');
const path = require('path');
const PhotoRecovery = require('../public/js/photoRecovery');

// The slideshow's photo fetching, run without a browser: the page, storage and
// network are stand-ins
const source = fs.readFileSync(path.join(__dirname, '../public/js/slideshow.js'), 'utf8');

const load = ({ fetch, URL = { revokeObjectURL() {} }, cipher } = {}) => {
  const store = new Map();
  const localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key)
  };
  const browser = {
    t: key => key,
    i18n: { error: (_, key) => key },
    localStorage,
    fetch,
    URL,
    PhotoRecovery,
    AbortSignal: { timeout: () => undefined },
    window: { SoraPhotoCipher: cipher }
  };
  const PhotoFrameSlideshow = new Function(...Object.keys(browser),
    `${source.slice(source.indexOf('const LAST_SHOWN_KEY'), source.indexOf('class WeatherWidget'))}; return PhotoFrameSlideshow;`
  )(...Object.values(browser));
  const slideshow = Object.create(PhotoFrameSlideshow.prototype);
  // Saved folders, as FolderStorage keeps them
  let saved = null;
  slideshow.folderStorage = {
    saveSelectedFolder: (folderPath, name) => { saved = { path: folderPath, name }; },
    getCurrentFolderPath: () => (saved ? saved.path : ''),
    getCurrentFolderName: () => (saved && saved.path ? saved.name : 'All folders')
  };
  slideshow.frameKeys = new Map();
  return { slideshow, save: (folderPath, name) => { saved = { path: folderPath, name }; }, saved: () => saved };
};

beforeEach(() => ['log', 'warn', 'error'].forEach(level => jest.spyOn(console, level).mockImplementation(() => {})));
afterEach(() => jest.restoreAllMocks());

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const photo = { success: true, image: { id: 'p1', url: '/photo/p1' } };

describe('a saved folder that was deleted', () => {
  test('falls back to all folders once the frame can tell it is gone', async () => {
    const asked = [];
    const { slideshow, save, saved } = load({
      fetch: async (url) => {
        asked.push(url);
        if (url.startsWith('/api/images/next?folder=')) return reply(404, { success: false, code: 'FOLDER_EMPTY' });
        if (url.startsWith('/api/folders/')) return reply(404, { success: false, code: 'FOLDER_NOT_FOUND' });
        return reply(200, photo);
      }
    });
    const selector = { updateCurrentSelection: jest.fn(), updateSelectedState: jest.fn() };
    slideshow.folderSelector = selector;
    save('Trips/Goa', 'Goa');

    const next = await slideshow.fetchRandomImage();
    expect(next).toEqual({ image: photo.image });
    expect(saved()).toEqual({ path: '', name: 'All Folders' });
    expect(asked).toEqual(['/api/images/next?folder=Trips%2FGoa', '/api/folders/Trips%2FGoa', '/api/images/next?']);
    expect(selector.updateCurrentSelection).toHaveBeenCalled();
  });

  test('works without the folder list (it failed to load at start)', async () => {
    const { slideshow, save, saved } = load({
      fetch: async (url) => {
        if (url.startsWith('/api/images/next?folder=')) return reply(404, { success: false, code: 'FOLDER_EMPTY' });
        if (url.startsWith('/api/folders/')) return reply(404, { success: false, code: 'FOLDER_NOT_FOUND' });
        return reply(200, photo);
      }
    });
    slideshow.folderSelector = null;
    save('Goa', 'Goa');
    expect(await slideshow.fetchRandomImage()).toEqual({ image: photo.image });
    expect(saved().path).toBe('');
  });

  test('an empty folder that still exists is kept, and checked again on the next try', async () => {
    let checks = 0;
    let gone = false;
    const { slideshow, save, saved } = load({
      fetch: async (url) => {
        if (url.startsWith('/api/images/next?folder=')) return reply(404, { success: false, code: 'FOLDER_EMPTY' });
        if (url.startsWith('/api/folders/')) {
          checks += 1;
          if (checks === 1) throw new TypeError('offline'); // the check itself failed
          return gone ? reply(404, { success: false, code: 'FOLDER_NOT_FOUND' }) : reply(200, { success: true, folders: [] });
        }
        return reply(200, photo);
      }
    });
    save('Goa', 'Goa');

    expect(await slideshow.fetchRandomImage()).toEqual({ error: { key: 'slideshow.noImagesInFolder', vars: { folder: 'Goa' } } });
    expect(await slideshow.fetchRandomImage()).toEqual({ error: { key: 'slideshow.noImagesInFolder', vars: { folder: 'Goa' } } });
    expect(saved().path).toBe('Goa');

    gone = true;
    expect(await slideshow.fetchRandomImage()).toEqual({ image: photo.image });
    expect(saved().path).toBe('');
    expect(checks).toBe(3);
  });

  test('a folder picked while the check ran is not replaced', async () => {
    let state;
    const { slideshow, save, saved } = load({
      fetch: async (url) => {
        if (url.startsWith('/api/images/next?folder=')) return reply(404, { success: false, code: 'FOLDER_EMPTY' });
        if (url.startsWith('/api/folders/')) {
          state.save('Home', 'Home');
          return reply(404, { success: false, code: 'FOLDER_NOT_FOUND' });
        }
        return reply(200, photo);
      }
    });
    state = { save };
    save('Goa', 'Goa');
    await slideshow.fetchRandomImage();
    expect(saved().path).toBe('Home');
  });
});

describe('decrypting in the browser', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('a download that finishes after the timeout has its blob URL revoked', async () => {
    let finish;
    const revoked = [];
    const { slideshow } = load({
      fetch: async () => reply(200, {}),
      URL: { revokeObjectURL: url => revoked.push(url) },
      cipher: { supported: () => true, loadImage: () => new Promise((resolve) => { finish = resolve; }) }
    });
    const source = slideshow.imageSource({ rawUrl: '/raw/p1', url: '/photo/p1' });
    await jest.advanceTimersByTimeAsync(12 * 1000);
    expect(await source).toBe('/photo/p1'); // the server copy is used instead

    finish('blob:late');
    await jest.advanceTimersByTimeAsync(0);
    expect(revoked).toEqual(['blob:late']);
  });

  test('a download in time is used and kept', async () => {
    const revoked = [];
    const { slideshow } = load({
      fetch: async () => reply(200, {}),
      URL: { revokeObjectURL: url => revoked.push(url) },
      cipher: { supported: () => true, loadImage: async () => 'blob:ok' }
    });
    expect(await slideshow.imageSource({ rawUrl: '/raw/p1', url: '/photo/p1' })).toBe('blob:ok');
    expect(revoked).toEqual([]);
  });
});
