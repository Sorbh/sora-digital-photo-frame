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
  for (const method of ['enqueue', 'get', 'list', 'claim', 'release', 'approve', 'touch', 'cancel', 'take', 'restore']) {
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

test('cancelling with the frame secret removes the waiting code from nearby and status', async () => {
  const app = createApp({ pairingStore: asynchronousStore() });
  const owner = request.agent(app);
  await owner.post('/api/auth/login').send({ password: process.env.ADMIN_PASSWORD }).expect(200);
  const frame = request(app);
  const { body: { code, secret } } = await frame.post('/api/pair/start').expect(200);
  const payload = { code, secret };

  const { body } = await owner.get('/api/admin/pair/nearby').expect(200);
  expect(body.nearby).toHaveLength(1);
  await frame.post('/api/pair/cancel').set('Sec-Fetch-Site', 'cross-site').send(payload).expect(403);
  await frame.post('/api/pair/status').send(payload).expect(200, { success: true, status: 'waiting' });

  await frame.post('/api/pair/cancel').set('Sec-Fetch-Site', 'same-origin').send(payload).expect(200, { success: true });
  await owner.get('/api/admin/pair/nearby').expect(200, { nearby: [] });
  await frame.post('/api/pair/status').send(payload).expect(200, { success: true, status: 'expired' });
  await frame.post('/api/pair/cancel').send(payload).expect(200, { success: true });
});

test('cancelling with a wrong secret leaves the code waiting', async () => {
  const frame = request(createApp());
  const { body: { code, secret } } = await frame.post('/api/pair/start').expect(200);

  await frame.post('/api/pair/cancel').send({ code, secret: 'wrong' }).expect(200, { success: true });
  await frame.post('/api/pair/status').send({ code, secret }).expect(200, { success: true, status: 'waiting' });
});

test('cancelling a claimed code leaves it available for approval', async () => {
  const store = new MemoryPairingStore();
  const frame = request(createApp({ pairingStore: store }));
  const { body: { code, secret } } = await frame.post('/api/pair/start').expect(200);
  const claim = store.claim(code, 'in-progress', Date.now());
  expect(claim).not.toBeNull();

  await frame.post('/api/pair/cancel').send({ code, secret }).expect(200, { success: true });
  expect(store.get(code, Date.now())).toMatchObject({ claimId: claim.claimId });
});

test('cancelling an approved code leaves it ready to collect', async () => {
  const store = new MemoryPairingStore();
  const app = createApp({ pairingStore: store });
  const owner = request.agent(app);
  await owner.post('/api/auth/login').send({ password: process.env.ADMIN_PASSWORD }).expect(200);
  const frame = request.agent(app);
  const { body: { code, secret } } = await frame.post('/api/pair/start').expect(200);
  await owner.post(`/api/admin/pair/${code}/approve`).send({ name: 'TV', newAccount: {} }).expect(200);
  // Exercise approval protection independently of the claim check.
  store.get(code, Date.now()).claimId = null;

  await frame.post('/api/pair/cancel').send({ code, secret }).expect(200, { success: true });
  await frame.post('/api/pair/status').send({ code, secret }).expect(200, { success: true, status: 'ready' });
  const { body } = await frame.post('/api/pair/collect').send({ code, secret }).expect(200);
  expect(body.status).toBe('approved');
});
