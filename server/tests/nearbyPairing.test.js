const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');

// Point the app at throwaway folders before it loads
const testUploadsDir = path.join(__dirname, 'nearby-uploads');
const testCacheDir = path.join(__dirname, 'nearby-cache');
const testDataDir = path.join(__dirname, 'nearby-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = 'nearby-test-secret';
process.env.ADMIN_PASSWORD = 'nearby-admin-pass';
delete process.env.PHOTO_ENCRYPTION_KEY;
delete process.env.NEARBY_PAIRING;

const { createApp } = require('../app');
const pairing = require('../services/pairingService');
const controller = require('../controllers/pairingController');

const HOME = '203.0.113.10';
const NEIGHBOUR = '198.51.100.20';

// A screen on /slideshow (or an app) asking for a code from ip, saying what it is if given
const tvStarts = async (app, ip, about) => {
  const asking = request(app).post('/api/pair/start').set('X-Forwarded-For', ip);
  return (await (about === undefined ? asking : asking.send(about)).expect(200)).body;
};
const tvPolls = (app, tv, ip) => request(app).post('/api/pair/status').set('X-Forwarded-For', ip)
  .send({ code: tv.code, secret: tv.secret }).expect(200);
const signedIn = async (app) => {
  const admin = request.agent(app);
  await admin.post('/api/auth/login').send({ password: 'nearby-admin-pass' }).expect(200);
  return admin;
};
const nearby = (admin, ip) => admin.get('/api/admin/pair/nearby').set('X-Forwarded-For', ip);
const shown = code => `${code.slice(0, 3)}-${code.slice(3)}`;

// The clock is held still, and moved by hand. It starts at the real time: sessions
// signed in now would look expired to a clock far ahead.
let clock;
const at = ms => clock.mockReturnValue(ms);

beforeEach(() => {
  const now = Date.now();
  pairing.pairings.clear();
  controller.starts.clear();
  controller.nearbyLookups.clear();
  clock = jest.spyOn(Date, 'now');
  at(now);
});
afterEach(() => clock.mockRestore());
afterAll(async () => {
  await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
});

describe('Sora Frame nearby (behind one trusted proxy)', () => {
  let app, admin;
  beforeAll(async () => {
    app = createApp({ trustProxy: true });
    admin = await signedIn(app);
  });

  test('a screen on the same network is listed, as it shows its code, with nothing about the network', async () => {
    const tv = await tvStarts(app, HOME);
    const res = await nearby(admin, HOME).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const when = new Date(Date.now()).toISOString();
    expect(res.body).toEqual({
      nearby: [{ code: shown(tv.code), name: null, kind: null, platform: null, model: null, createdAt: when, lastSeen: when }]
    });
    expect(res.text).not.toContain('203.0.113');
  });

  test('a screen on another network is not listed', async () => {
    await tvStarts(app, NEIGHBOUR);
    expect((await nearby(admin, HOME).expect(200)).body).toEqual({ nearby: [] });
  });

  test('an IPv6 phone in the TV\'s /64 finds it; another /64 does not', async () => {
    const tv = await tvStarts(app, '2001:db8:5:6::1');
    expect((await nearby(admin, '2001:db8:5:6:ffff:1:2:9').expect(200)).body.nearby.map(n => n.code)).toEqual([shown(tv.code)]);
    expect((await nearby(admin, '2001:db8:5:7::1').expect(200)).body.nearby).toEqual([]);
    // An IPv4 TV and an IPv6 phone don't match (accepted, see HOOKS.md)
    expect((await nearby(admin, HOME).expect(200)).body.nearby).toEqual([]);
  });

  test('an expired code is not listed', async () => {
    const start = Date.now();
    const tv = await tvStarts(app, HOME);
    at(start + pairing.PAIRING_TTL_MS - 30 * 1000);
    await tvPolls(app, tv, HOME);
    expect((await nearby(admin, HOME)).body.nearby).toHaveLength(1);
    at(start + pairing.PAIRING_TTL_MS + 1);
    expect((await nearby(admin, HOME).expect(200)).body.nearby).toEqual([]);
  });

  test('a code is hidden after ten seconds without a poll and returns once it polls', async () => {
    const start = Date.now();
    const tv = await tvStarts(app, HOME);
    at(start + 9_999);
    expect((await nearby(admin, HOME)).body.nearby).toHaveLength(1);
    at(start + 10_000);
    expect((await nearby(admin, HOME).expect(200)).body.nearby).toEqual([]);
    await tvPolls(app, tv, HOME);
    const listed = (await nearby(admin, HOME).expect(200)).body.nearby;
    expect(listed.map(n => n.code)).toEqual([shown(tv.code)]);
    expect(listed[0].lastSeen).toBe(new Date(start + 10_000).toISOString());
    expect(listed[0].createdAt).toBe(new Date(start).toISOString());
  });

  test('an approved code is not listed', async () => {
    const tv = await tvStarts(app, HOME);
    await admin.post(`/api/admin/pair/${tv.code}/approve`).send({ name: 'Living room', newAccount: {} }).expect(200);
    expect((await nearby(admin, HOME).expect(200)).body.nearby).toEqual([]);
  });

  test('at most three, newest first', async () => {
    const start = Date.now();
    const codes = [];
    for (let i = 0; i < 5; i++) {
      at(start + i * 1000);
      codes.push(shown((await tvStarts(app, HOME)).code));
    }
    expect(pairing.NEARBY_MAX).toBe(3);
    expect((await nearby(admin, HOME).expect(200)).body.nearby.map(n => n.code)).toEqual(codes.slice(-3).reverse());
  });

  test('looking up is rate-limited gently', async () => {
    for (let i = 0; i < 30; i++) await nearby(admin, HOME).expect(200);
    expect((await nearby(admin, HOME).expect(429)).body.code).toBe('RATE_LIMITED');
    at(Date.now() + 61 * 1000);
    await nearby(admin, HOME).expect(200);
  });

  test('signed out, it answers 401', async () => {
    await request(app).get('/api/admin/pair/nearby').expect(401);
  });

  test('no raw address is kept with a code or answered', async () => {
    const tv = await tvStarts(app, HOME);
    await tvStarts(app, '2001:db8:5:6::1');
    await tvPolls(app, tv, HOME);
    const kept = JSON.stringify([...pairing.pairings.values()]) + JSON.stringify([...controller.starts.keys()]) +
      JSON.stringify([...controller.nearbyLookups.keys()]);
    for (const raw of ['203.0.113', '2001:db8', HOME]) expect(kept).not.toContain(raw);
    for (const p of pairing.pairings.values()) expect(p.address).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const answer = (await nearby(admin, HOME).expect(200)).text;
    expect(answer).not.toContain('203.0.113');
    expect(Object.keys(JSON.parse(answer).nearby[0]).sort()).toEqual(['code', 'createdAt', 'kind', 'lastSeen', 'model', 'name', 'platform']);
  });
});

describe('what a screen says about itself', () => {
  let app, admin;
  beforeAll(async () => {
    app = createApp({ trustProxy: true });
    admin = await signedIn(app);
  });

  test('is kept with its code, and shown by nearby and by the code lookup', async () => {
    const info = { name: 'Living room TV', kind: 'tv', platform: 'Android TV', app: 'sora-android/1.2.0', model: 'BRAVIA XR' };
    const tv = await tvStarts(app, HOME, info);
    expect((await nearby(admin, HOME).expect(200)).body.nearby).toEqual([expect.objectContaining({
      code: shown(tv.code), name: 'Living room TV', kind: 'tv', platform: 'Android TV', model: 'BRAVIA XR'
    })]);
    expect((await admin.get(`/api/admin/pair/${tv.code}`).expect(200)).body).toMatchObject({
      code: tv.code, approved: false, ...info
    });
    expect(pairing.find(tv.code).device).toEqual(info);
  });

  test('is cleaned up: plain text, cut short, a kind from the list or none', async () => {
    const tv = await tvStarts(app, HOME, {
      name: `  Kitchen\u0000\u202E<b>tab</b>\n${'x'.repeat(60)}`, kind: 'toaster', platform: 'P'.repeat(50), app: ['not', 'text']
    });
    const { device } = pairing.find(tv.code);
    expect(device.name).toBe(`Kitchen <b>tab</b> ${'x'.repeat(40 - 'Kitchen <b>tab</b> '.length)}`);
    expect(Array.from(device.name)).toHaveLength(40);
    expect(device).toMatchObject({ kind: null, platform: 'P'.repeat(30), app: null });
    // Text, never markup: the page shows it with textContent
    expect((await nearby(admin, HOME).expect(200)).body.nearby[0].name).toBe(device.name);
  });

  test('anything but an object, or nothing, still starts a code with no details', async () => {
    for (const body of [undefined, '"just text"', '[1,2]', 'null']) {
      const asking = request(app).post('/api/pair/start').set('X-Forwarded-For', HOME);
      const res = body === undefined ? await asking : await asking.set('Content-Type', 'application/json').send(body);
      if (res.status !== 200) { expect(res.status).toBe(400); continue; } // JSON the parser refuses outright
      expect(pairing.find(res.body.code).device).toEqual({ name: null, kind: null, platform: null, app: null, model: null });
    }
  });

  test('the sanitiser on its own', () => {
    const { deviceInfo } = require('../utils/deviceInfo');
    expect(deviceInfo()).toEqual({ name: null, kind: null, platform: null, app: null, model: null });
    expect(deviceInfo({ kind: ' Phone ', name: '   ', platform: 7 })).toEqual({ name: null, kind: 'phone', platform: null, app: null, model: null });
    for (const kind of ['tv', 'phone', 'tablet', 'browser', 'frame']) expect(deviceInfo({ kind }).kind).toBe(kind);
    expect(deviceInfo({ name: 'a\u200Bb\uFEFFc\u2066d' }).name).toBe('a b c d');
    expect(deviceInfo({ app: '😀'.repeat(50) }).app).toBe('😀'.repeat(40)); // characters, not UTF-16 units
  });
});

describe('with no trusted proxy', () => {
  test('a spoofed X-Forwarded-For is ignored: the real address is what counts', async () => {
    const app = createApp({ trustProxy: 'false' });
    const admin = await signedIn(app);
    // The TV and the phone both really come from this machine, whatever they claim
    const tv = await tvStarts(app, NEIGHBOUR);
    expect((await nearby(admin, HOME).expect(200)).body.nearby.map(n => n.code)).toEqual([shown(tv.code)]);

    // With the header believed, the same claims would be two networks
    pairing.pairings.clear();
    const trusting = createApp({ trustProxy: true });
    const other = await signedIn(trusting);
    await tvStarts(trusting, NEIGHBOUR);
    expect((await nearby(other, HOME).expect(200)).body.nearby).toEqual([]);
  });
});

describe('turned off', () => {
  afterEach(() => { delete process.env.NEARBY_PAIRING; });

  test('createApp({ nearbyPairing: false }) answers 404, signed in or not', async () => {
    const app = createApp({ trustProxy: true, nearbyPairing: false });
    const admin = await signedIn(app);
    await tvStarts(app, HOME);
    expect((await nearby(admin, HOME).expect(404)).body.code).toBe('NEARBY_OFF');
    await request(app).get('/api/admin/pair/nearby').expect(404);
    // A code still works the usual way
    await admin.get(`/api/admin/pair/${[...pairing.pairings.keys()][0]}`).expect(200);
  });

  test('NEARBY_PAIRING=off does the same; it is on by default', async () => {
    process.env.NEARBY_PAIRING = 'off';
    const off = createApp({ trustProxy: true });
    await nearby(await signedIn(off), HOME).expect(404);
    delete process.env.NEARBY_PAIRING;
    const on = createApp({ trustProxy: true });
    await nearby(await signedIn(on), HOME).expect(200);
  });
});
