const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const LocalDataStore = require('../store/LocalDataStore');

function dataStoreContract(factory) {
  let dir;
  let store;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-frame-store-'));
    store = factory(dir);
  });

  afterEach(async () => { await fs.remove(dir); });

  test('missing document returns its fallback', async () => {
    expect(await store.get('notes', [])).toEqual([]);
  });

  test('set and get roundtrip at the existing filename', async () => {
    const value = [{ id: 'one' }];
    await store.set('notes', value);
    expect(await store.get('notes', [])).toEqual(value);
    expect(await fs.readJson(path.join(dir, 'notes.json'))).toEqual(value);
  });

  test('atomic write leaves no temporary files', async () => {
    await store.set('devices', [{ id: 'one' }]);
    await store.set('devices', [{ id: 'two' }]);
    expect(await fs.readdir(dir)).toEqual(['devices.json']);
  });

  test('update serialises concurrent increments', async () => {
    await Promise.all(Array.from({ length: 20 }, () =>
      store.update('counter', 0, async value => {
        await new Promise(resolve => setTimeout(resolve, 1));
        return value + 1;
      })));
    expect(await store.get('counter', 0)).toBe(20);
  });

  test('invalid names cannot escape the storage directory', async () => {
    for (const name of ['../escape', '/tmp/escape', 'a/b', 'folder-settings:../escape', 'folder-settings:/escape']) {
      await expect(store.get(name, null)).rejects.toThrow('Invalid document name');
      await expect(store.set(name, {})).rejects.toThrow('Invalid document name');
      await expect(store.update(name, {}, value => value)).rejects.toThrow('Invalid document name');
    }
  });
}

describe('LocalDataStore', () => dataStoreContract(dir => new LocalDataStore(dir)));
