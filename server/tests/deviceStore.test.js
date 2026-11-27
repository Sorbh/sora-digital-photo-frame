const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

process.env.SESSION_SECRET = 'device-store-test-key';
process.env.ADMIN_PASSWORD = 'device-store-test-password';

const { createApp } = require('../app');
const { runWithTenant } = require('../context');
const { DEVICE_SEEN_FLUSH_MS } = require('../services/pairingService');
const LocalDataStore = require('../store/LocalDataStore');

let tmp;
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sora-device-store-')); });
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

function asyncDeviceStore() {
  const rows = new Map();
  const list = id => {
    if (!rows.has(id)) rows.set(id, []);
    return rows.get(id);
  };
  let writes = Promise.resolve();
  return {
    list: jest.fn(async id => structuredClone(list(id))),
    add: jest.fn((id, device, checkLimit) => {
      const adding = writes.then(async () => {
        await checkLimit(list(id).length);
        list(id).push(structuredClone(device));
      });
      writes = adding.catch(() => {});
      return adding;
    }),
    remove: jest.fn(async (id, match) => {
      const removed = list(id).filter(match);
      rows.set(id, list(id).filter(d => !removed.includes(d)));
      return structuredClone(removed);
    }),
    restore: jest.fn(async (id, devices) => { list(id).push(...structuredClone(devices)); }),
    update: jest.fn(async (id, deviceId, changes) => {
      const device = list(id).find(d => d.id === deviceId);
      return device ? structuredClone(Object.assign(device, changes)) : null;
    }),
    findById: jest.fn(async (id, deviceId) => structuredClone(list(id).find(d => d.id === deviceId) ?? null)),
    findByTokenHash: jest.fn(async (id, hash) => structuredClone(list(id).find(d => d.tokenHash === hash) ?? null)),
    touchMany: jest.fn(async touches => {
      for (const { tenantId, deviceId, at } of touches) {
        const device = list(tenantId).find(d => d.id === deviceId);
        if (device) device.lastSeen = new Date(at).toISOString();
      }
    })
  };
}

test.each(['default document', 'custom async'])('pairing, sign-in, language and removal use the %s store', async kind => {
  const deviceStore = kind === 'custom async' ? asyncDeviceStore() : undefined;
  const dataStore = new LocalDataStore(tmp);
  const app = createApp({ dataStore, deviceStore, pinSignIn: false });
  const owner = request.agent(app);
  const frame = request.agent(app);
  await owner.post('/api/auth/login').send({ password: process.env.ADMIN_PASSWORD }).expect(200);

  const { body: { code, secret } } = await frame.post('/api/pair/start').expect(200);
  await owner.post(`/api/admin/pair/${code}/approve`).send({ name: 'Hall TV', newAccount: {} }).expect(200);
  const { body: { device, token } } = await frame.post('/api/pair/collect').send({ code, secret }).expect(200);
  const id = device.id;
  const rows = deviceStore ? await deviceStore.list('default') : await dataStore.get('devices', []);
  expect(rows).toEqual([expect.objectContaining({ id, name: 'Hall TV', tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
  expect(JSON.stringify(rows)).not.toContain(token);
  if (deviceStore) expect(await dataStore.get('devices', [])).toEqual([]);

  await owner.put(`/api/admin/devices/${id}/language`).send({ language: 'de' }).expect(200);
  await frame.put('/api/device/language').send({ language: 'fr' }).expect(200);
  const signedIn = await request(app).post('/api/auth/device').send({ token }).expect(200);
  expect(signedIn.body.device.language).toBe('fr');

  const listed = await owner.get('/api/admin/devices').expect(200);
  expect(listed.body.devices).toEqual([expect.objectContaining({ id, language: 'fr', lastSeen: expect.any(String) })]);
  expect(listed.body.devices[0]).not.toHaveProperty('tokenHash');
  await app.locals.pairingService.flushSeen();
  await owner.delete(`/api/admin/devices/${id}`).expect(200);
  await frame.get('/api/auth/session').expect(200).expect(res => expect(res.body.authenticated).toBe(false));
  await request(app).post('/api/auth/device').send({ token }).expect(401);

  if (deviceStore) {
    expect(deviceStore.update).toHaveBeenCalledTimes(2);
    expect(deviceStore.remove).toHaveBeenCalledTimes(1);
    expect(deviceStore.touchMany).toHaveBeenCalledTimes(1);
    expect(await deviceStore.list('default')).toEqual([]);
  } else {
    expect(JSON.parse(await fs.readFile(path.join(tmp, 'devices.json'), 'utf8'))).toEqual([]);
  }
  await app.locals.pairingService.drainSeen();
});

test('the timer batches the latest timestamp for every changed screen in one call and stays idle afterward', async () => {
  const deviceStore = asyncDeviceStore();
  const service = createApp({ deviceStore }).locals.pairingService;
  jest.useFakeTimers();
  try {
    service.seen('one', 100);
    service.seen('one', 200);
    service.seen('one', 150);
    service.seen('two', 250);
    runWithTenant({ id: 'alpha' }, () => service.seen('three', 300));
    await jest.advanceTimersByTimeAsync(DEVICE_SEEN_FLUSH_MS - 1);
    expect(deviceStore.touchMany).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(deviceStore.touchMany).toHaveBeenCalledWith([
      { tenantId: 'default', deviceId: 'one', at: 200 },
      { tenantId: 'default', deviceId: 'two', at: 250 },
      { tenantId: 'alpha', deviceId: 'three', at: 300 }
    ]);
    await jest.advanceTimersByTimeAsync(2 * DEVICE_SEEN_FLUSH_MS);
    await service.flushSeen();
    expect(deviceStore.touchMany).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

test('shutdown retries a failed write and includes newer activity from during the write', async () => {
  const deviceStore = asyncDeviceStore();
  const service = createApp({ deviceStore }).locals.pairingService;
  let fail;
  deviceStore.touchMany.mockImplementationOnce(() => new Promise((resolve, reject) => { fail = reject; }));
  service.seen('one', 100);
  const first = service.flushSeen();
  const rejected = expect(first).rejects.toThrow('unavailable');
  await Promise.resolve();
  service.seen('one', 200);
  service.seen('two', 250);
  const stopped = service.drainSeen();
  fail(new Error('unavailable'));
  await rejected;
  await stopped;
  expect(deviceStore.touchMany).toHaveBeenLastCalledWith([
    { tenantId: 'default', deviceId: 'one', at: 200 },
    { tenantId: 'default', deviceId: 'two', at: 250 }
  ]);
  expect(deviceStore.touchMany).toHaveBeenCalledTimes(2);
});

test('SIGTERM flushes pending timestamps before the server closes its store', async () => {
  const output = path.join(tmp, 'shutdown.json');
  const script = `
    const fs = require('node:fs/promises');
    const http = require('node:http');
    const { withStore } = require('./services/pairingService');
    const onShutdown = require('./utils/drainScreensOnShutdown');
    const output = process.argv[1];
    let closed = false;
    const pairingService = withStore(null, null, {
      async touchMany(touches) {
        if (closed) throw new Error('Storage already closed');
        await fs.writeFile(output, JSON.stringify(touches));
      }
    });
    const server = http.createServer();
    server.listen(0, () => {
      pairingService.seen('screen', 1234);
      process.kill(process.pid, 'SIGTERM');
    });
    onShutdown(server, { locals: { pairingService } }, async () => {
      closed = true;
      await fs.access(output);
    });
  `;
  await promisify(execFile)(process.execPath, ['-e', script, output], { cwd: path.join(__dirname, '..'), timeout: 5000 });
  expect(JSON.parse(await fs.readFile(output, 'utf8'))).toEqual([
    { tenantId: 'default', deviceId: 'screen', at: 1234 }
  ]);
});

test.each(['MAX_SCREENS', 'quota hook'])('concurrent approvals share the %s limit', async mode => {
  const previous = process.env.MAX_SCREENS;
  process.env.MAX_SCREENS = mode === 'MAX_SCREENS' ? '1' : '0';
  const deviceStore = asyncDeviceStore();
  const canAdd = jest.fn(async (request, { screensInUse }) => ({ ok: screensInUse === 0 }));
  const app = createApp({ deviceStore, dataStore: new LocalDataStore(tmp), quota: { canAdd } });
  const service = app.locals.pairingService;
  try {
    const [one, two] = await Promise.all([service.start(), service.start()]);
    const results = await Promise.allSettled([one, two].map(({ code }) =>
      service.approve(code, { name: 'TV', accountId: 'account' })));
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(results.find(result => result.status === 'rejected').reason).toMatchObject({ code: 'SCREEN_LIMIT' });
    expect(await deviceStore.list('default')).toHaveLength(1);
    expect(canAdd.mock.calls.map(([, context]) => context.screensInUse)).toEqual(mode === 'MAX_SCREENS' ? [0] : [0, 1]);
    await Promise.all([...service.reporting.values()].map(state => state.running));
  } finally {
    if (previous === undefined) delete process.env.MAX_SCREENS;
    else process.env.MAX_SCREENS = previous;
  }
});
