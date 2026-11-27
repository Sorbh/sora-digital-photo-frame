const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sora-pairing-store-'));
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.SESSION_SECRET = 'pairing-store-test-key';
process.env.ADMIN_PASSWORD = 'pairing-store-test-password';

const { createApp } = require('../app');
const MemoryPairingStore = require('../services/memoryPairingStore');

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function asynchronousStore() {
  const memory = new MemoryPairingStore();
  const store = {};
  for (const method of ['enqueue', 'get', 'list', 'claim', 'release', 'approve', 'touch', 'take', 'restore']) {
    store[method] = jest.fn(async (...args) => {
      // An external store returns detached records and never exposes its Map.
      await Promise.resolve();
      if (method === 'enqueue') {
        const [choose] = args;
        return structuredClone(memory.enqueue((rows, now) => choose(structuredClone(rows), now)));
      }
      return structuredClone(memory[method](...structuredClone(args)));
    });
  }
  return store;
}

test.each(['in-memory', 'custom async'])('the whole pairing flow works with the %s store', async kind => {
  const store = kind === 'custom async' ? asynchronousStore() : undefined;
  const app = createApp({ pairingStore: store });
  const owner = request.agent(app);
  await owner.post('/api/auth/login').send({ password: process.env.ADMIN_PASSWORD }).expect(200);
  const frame = request.agent(app);
  const started = await frame.post('/api/pair/start').send({ name: 'Hall TV', kind: 'tv' }).expect(200);
  const { code, secret } = started.body;
  const payload = { code, secret };

  await frame.post('/api/pair/status').send(payload).expect(200, { success: true, status: 'waiting' });
  const nearby = await owner.get('/api/admin/pair/nearby').expect(200);
  expect(nearby.body.nearby).toContainEqual(expect.objectContaining({
    code: `${code.slice(0, 3)}-${code.slice(3)}`, name: 'Hall TV', kind: 'tv'
  }));
  await owner.get(`/api/admin/pair/${code}`).expect(200);
  const approval = await owner.post(`/api/admin/pair/${code}/approve`)
    .send({ name: 'Hall', newAccount: {} }).expect(200);
  await frame.post('/api/pair/status').send(payload).expect(200, { success: true, status: 'ready' });
  await request(app).post('/api/pair/collect').send(payload).expect(200, { success: true, status: 'expired' });
  const collected = await frame.post('/api/pair/collect').send(payload).expect(200);
  expect(collected.body).toMatchObject({ status: 'approved', device: approval.body.device });
  await request(app).post('/api/auth/device').send({ token: collected.body.token }).expect(200);
  await frame.post('/api/pair/status').send(payload).expect(200, { success: true, status: 'expired' });

  if (store) {
    expect(store.enqueue).toHaveBeenCalledTimes(1);
    expect(store.approve).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ tenantId: 'default' }), expect.any(Number));
    expect(store.take).toHaveBeenCalledTimes(1);
  }
});
