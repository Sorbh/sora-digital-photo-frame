const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');

// Point the app at throwaway folders before it loads
const testUploadsDir = path.join(__dirname, 'pairing-uploads');
const testCacheDir = path.join(__dirname, 'pairing-cache');
const testDataDir = path.join(__dirname, 'pairing-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'test-admin-pass';

const app = require('../server');

describe('Pairing a frame by QR code', () => {
  const admin = request.agent(app);
  const start = async (frame) => (await frame.post('/api/pair/start').expect(200)).body;
  const status = (frame, pairing, secret = pairing.secret) =>
    frame.post('/api/pair/status').send({ code: pairing.code, secret }).expect(200).then(r => r.body);
  const collect = (frame, pairing, secret = pairing.secret) =>
    frame.post('/api/pair/collect').send({ code: pairing.code, secret }).expect(200).then(r => r.body);

  beforeAll(async () => {
    await fs.ensureDir(path.join(testUploadsDir, 'Goa'));
    await admin.post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200);
  });

  afterAll(async () => {
    delete process.env.PUBLIC_URL;
    await fs.remove(testUploadsDir);
    await fs.remove(testCacheDir);
    await fs.remove(testDataDir);
  });

  test('a frame gets a short code, a secret and a QR code for the phone', async () => {
    process.env.PUBLIC_URL = 'http://photos.home:3000/';
    const pairing = await start(request.agent(app));
    delete process.env.PUBLIC_URL;

    expect(pairing.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(pairing.secret).toHaveLength(48);
    expect(pairing.url).toBe(`http://photos.home:3000/pair?code=${pairing.code}`);
    expect(pairing.qr).toContain('<svg');
  });

  test('a frame on the server itself gets an address a phone can open', async () => {
    const pairing = (await request(app).post('/api/pair/start').set('Host', 'localhost:3000').expect(200)).body;
    expect(pairing.url).toMatch(/:3000\/pair\?code=/);
    if (require('../controllers/pairingController').networkAddress()) {
      expect(pairing.url).not.toContain('localhost');
    }
  });

  test('the frame waits until an admin approves, and only it can collect', async () => {
    const frame = request.agent(app);
    const pairing = await start(frame);
    expect((await status(frame, pairing)).status).toBe('waiting');
    expect((await status(frame, pairing, 'x'.repeat(48))).status).toBe('expired');

    await request(app).post(`/api/admin/pair/${pairing.code}/approve`).send({ name: 'Kitchen', newAccount: {} }).expect(401);
    await admin.post(`/api/admin/pair/${pairing.code}/approve`).send({ name: '  ', newAccount: {} }).expect(400);
    await admin.post(`/api/admin/pair/${pairing.code}/approve`).send({ name: 'Kitchen' }).expect(400);
    await admin.post('/api/admin/pair/ZZZZZZ/approve').send({ name: 'Kitchen', newAccount: {} }).expect(404);

    // The phone sees the code (dashes and case don't matter)
    const shown = await admin.get(`/api/admin/pair/${pairing.code.slice(0, 3).toLowerCase()}-${pairing.code.slice(3)}`).expect(200);
    expect(shown.body).toMatchObject({ code: pairing.code, approved: false });
  });

  test('opening /pair by hand, as the frame suggests, offers a box to type the code', async () => {
    const page = await admin.get('/pair').expect(200);
    expect(page.text).toContain('id="stateEnter"');
    expect(page.text).toContain('id="codeInput"');

    // However it was typed off the screen, the code is found
    const pairing = await start(request.agent(app));
    const typed = ` ${pairing.code.slice(0, 3).toLowerCase()} ${pairing.code.slice(3).toLowerCase()} `;
    const shown = await admin.get(`/api/admin/pair/${encodeURIComponent(typed)}`).expect(200);
    expect(shown.body.code).toBe(pairing.code);
  });

  test('approving with a new account signs the frame in for good', async () => {
    const frame = request.agent(app);
    const pairing = await start(frame);

    const approved = await admin.post(`/api/admin/pair/${pairing.code}/approve`)
      .send({ name: 'Kitchen frame', newAccount: { assignedFolders: ['Goa', 'Goa'] } })
      .expect(200);
    expect(approved.body.account).toMatchObject({ name: 'Kitchen frame', assignedFolders: ['Goa'] });
    await admin.post(`/api/admin/pair/${pairing.code}/approve`).send({ name: 'Again', newAccount: {} }).expect(404);

    const accounts = await fs.readJson(path.join(testDataDir, 'access-accounts.json'));
    const kitchen = accounts.find(a => a.name === 'Kitchen frame');
    expect(kitchen.pin).toBeUndefined();
    expect(kitchen.pinHash).toMatch(/^\$2[aby]\$/);

    // Polling only says it's ready: no token, and the frame isn't signed in yet
    const polled = await status(frame, pairing);
    expect(polled).toEqual({ success: true, status: 'ready' });
    expect((await frame.get('/api/auth/session').expect(200)).body.authenticated).toBe(false);

    const collected = await collect(frame, pairing);
    expect(collected).toMatchObject({ status: 'approved', device: { name: 'Kitchen frame' }, account: { name: 'Kitchen frame' } });
    expect(collected.token.length).toBeGreaterThan(30);
    expect((await frame.get('/api/auth/session').expect(200)).body.authenticated).toBe(true);

    // Handed over once only
    expect((await status(frame, pairing)).status).toBe('expired');
    expect((await collect(frame, pairing)).status).toBe('expired');

    // After a restart or a day, the token signs the frame back in
    const later = request.agent(app);
    const signedIn = await later.post('/api/auth/device').send({ token: collected.token }).expect(200);
    expect(signedIn.body.account.assignedFolders).toEqual(['Goa']);
    expect((await later.get('/api/auth/session').expect(200)).body.account.name).toBe('Kitchen frame');
    await request(app).post('/api/auth/device').send({ token: 'not-a-token' }).expect(401);

    // Only a hash of the token is stored
    const stored = await fs.readJson(path.join(testDataDir, 'devices.json'));
    expect(JSON.stringify(stored)).not.toContain(collected.token);
  });

  test('only a same-origin POST from the browser that started the pairing can collect it', async () => {
    const frame = request.agent(app);
    const pairing = await start(frame);
    await admin.post(`/api/admin/pair/${pairing.code}/approve`).send({ name: 'Den frame', newAccount: {} }).expect(200);

    // Another site can't make the frame's browser collect it
    const crossSite = await frame.post('/api/pair/collect').set('Sec-Fetch-Site', 'cross-site')
      .send({ code: pairing.code, secret: pairing.secret }).expect(403);
    expect(crossSite.body.code).toBe('CROSS_SITE');
    await frame.post('/api/pair/collect').set('Origin', 'http://evil.example')
      .send({ code: pairing.code, secret: pairing.secret }).expect(403);

    // Nor can another browser that knows the code and secret
    const other = request.agent(app);
    expect((await collect(other, pairing)).status).toBe('expired');
    expect((await other.get('/api/auth/session').expect(200)).body.authenticated).toBe(false);
    expect((await collect(frame, pairing, 'x'.repeat(48))).status).toBe('expired');

    // The frame itself still can
    const collected = await frame.post('/api/pair/collect').set('Sec-Fetch-Site', 'same-origin')
      .send({ code: pairing.code, secret: pairing.secret }).expect(200);
    expect(collected.body).toMatchObject({ status: 'approved', device: { name: 'Den frame' } });
  });

  test('a malformed secret is just a wrong one', async () => {
    const frame = request.agent(app);
    const pairing = await start(frame);
    // As many characters as the real secret, but more bytes
    const odd = 'é'.repeat(pairing.secret.length);
    expect((await status(frame, pairing, odd)).status).toBe('expired');
    expect((await collect(frame, pairing, odd)).status).toBe('expired');
    expect((await status(frame, pairing)).status).toBe('waiting');
  });

  test('starting a pairing keeps no session on the server', async () => {
    const res = await request(app).post('/api/pair/start').expect(200);
    const cookies = (res.headers['set-cookie'] || []).join(';');
    expect(cookies).not.toContain('photoframe.sid');
  });

  test('each tab of a browser can collect its own pairing', async () => {
    const browser = request.agent(app);
    const first = await start(browser);
    const second = await start(browser);
    await admin.post(`/api/admin/pair/${first.code}/approve`).send({ name: 'First tab', newAccount: {} }).expect(200);
    expect((await collect(browser, first)).status).toBe('approved');
    await admin.post(`/api/admin/pair/${second.code}/approve`).send({ name: 'Second tab', newAccount: {} }).expect(200);
    expect((await collect(browser, second)).status).toBe('approved');
  });

  test('two tabs starting at the same moment can each collect their own pairing', async () => {
    const browser = request.agent(app);
    const [first, second] = await Promise.all([start(browser), start(browser)]);
    for (const [tab, name] of [[first, 'Left tab'], [second, 'Right tab']]) {
      await admin.post(`/api/admin/pair/${tab.code}/approve`).send({ name, newAccount: {} }).expect(200);
      expect((await collect(browser, tab)).status).toBe('approved');
    }
  });

  test('polling never hands the pairing over, even from the browser that started it', async () => {
    const frame = request.agent(app);
    const pairing = await start(frame);
    await admin.post(`/api/admin/pair/${pairing.code}/approve`).send({ name: 'Polling page', newAccount: {} }).expect(200);
    const polled = await frame.post('/api/pair/status').set('Sec-Fetch-Site', 'same-origin')
      .send({ code: pairing.code, secret: pairing.secret }).expect(200);
    expect(polled.body).toEqual({ success: true, status: 'ready' });
    expect(polled.headers['set-cookie'] || []).toEqual([]);
    expect((await frame.get('/api/auth/session').expect(200)).body.authenticated).toBe(false);
    expect((await collect(frame, pairing)).status).toBe('approved');
  });

  test('the secret is never sent in a URL, where a proxy could log it (#66)', async () => {
    const frame = request.agent(app);
    // From its own address, so this file stays under the per-address start limit
    const pairing = (await frame.post('/api/pair/start').set('X-Forwarded-For', '10.66.0.1').expect(200)).body;
    // Status is a POST with the secret in the body; there's no GET to put it in a query
    const asGet = await frame.get('/api/pair/status').query({ code: pairing.code, secret: pairing.secret });
    expect(asGet.body.status).toBeUndefined();
    // Another site can't poll it either
    await frame.post('/api/pair/status').set('Sec-Fetch-Site', 'cross-site')
      .send({ code: pairing.code, secret: pairing.secret }).expect(403);
    // The slideshow's side: tests/pairPoll.test.js
  });

  test("an account made for an approval can't be picked by another until that frame is paired", async () => {
    const service = require('../services/pairingService');
    const slowFrame = request.agent(app);
    const slow = await start(slowFrame);
    const addDevice = service.addDevice;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    service.addDevice = async function (options) {
      if (options.name === 'Slow frame') {
        await gate;
        const made = await addDevice.call(this, options);
        service.pairings.get(slow.code).expiresAt = Date.now() - 1; // and it ran out meanwhile
        return made;
      }
      return addDevice.call(this, options);
    };
    try {
      const slowApproval = admin.post(`/api/admin/pair/${slow.code}/approve`).send({ name: 'Slow frame', newAccount: {} }).then(r => r);
      // Wait until the slow approval's account shows up, then pair a second frame to it
      let made;
      for (let i = 0; i < 100 && !made; i++) {
        made = (await admin.get('/api/access-accounts').expect(200)).body.accounts.find(a => a.name === 'Slow frame');
        if (!made) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(made).toBeTruthy();
      const otherFrame = request.agent(app);
      const other = await start(otherFrame);
      const otherApproval = await admin.post(`/api/admin/pair/${other.code}/approve`).send({ name: 'Other frame', accountId: made.id });

      release();
      expect((await slowApproval).status).toBe(404);
      // Either the second approval was refused, or the frame it paired works
      if (otherApproval.status === 200) {
        expect((await collect(otherFrame, other)).status).toBe('approved');
      } else {
        expect(otherApproval.status).toBe(400);
      }
    } finally {
      service.addDevice = addDevice;
      release();
    }
  });

  test('an approval that finishes after the code expired is undone', async () => {
    const before = (await admin.get('/api/admin/devices').expect(200)).body.devices.length;
    const accountsBefore = (await admin.get('/api/access-accounts').expect(200)).body.accounts.length;
    const frame = request.agent(app);
    const started = await start(frame);
    const service = require('../services/pairingService');
    const { setEvents } = require('../events');
    const addDevice = service.addDevice;
    service.addDevice = async function (...args) {
      const made = await addDevice.apply(this, args);
      service.pairings.get(started.code).expiresAt = Date.now() - 1; // took past the deadline
      return made;
    };
    // A host's index that is down while the device is undone
    setEvents({ devicesRemoved() { throw new Error('host index is down'); } });
    try {
      const res = await admin.post(`/api/admin/pair/${started.code}/approve`).send({ name: 'Too late', newAccount: {} });
      expect(res.body.code).toBe('PAIRING_EXPIRED');
      expect(res.status).toBe(404);
    } finally {
      service.addDevice = addDevice;
      setEvents({});
    }
    expect((await admin.get('/api/admin/devices').expect(200)).body.devices).toHaveLength(before);
    // Kept to tell the host once it's back
    expect(await fs.readJson(path.join(testDataDir, 'device-removals.json'))).toHaveLength(1);
    // The account made for it is gone too
    expect((await admin.get('/api/access-accounts').expect(200)).body.accounts).toHaveLength(accountsBefore);
  });

  describe("a removal the host's index missed (#66)", () => {
    const service = require('../services/pairingService');
    const { setEvents } = require('../events');
    const { getDataStore } = require('../store');
    const outbox = () => fs.readJson(path.join(testDataDir, 'device-removals.json')).catch(() => []);
    const until = async (check) => {
      for (let i = 0; i < 100 && !(await check()); i++) await new Promise(r => setTimeout(r, 10));
    };
    const idle = () => until(() => !service.reporting.size);
    const deviceIds = async () => (await service.listDevices()).map(d => d.id);
    const newDevice = async (name) => (await service.addDevice({ name, accountId: 'acc_none', via: 'qr' })).device;
    let host; // what devicesRemoved does: 'up', 'down', or a promise it waits on
    let reported;
    let delays;
    let quiet;

    beforeEach(async () => {
      setEvents({});
      await service.reportRemovals(); // anything left by earlier tests, reported to no one
      await idle();
      expect(await outbox()).toEqual([]);
      host = 'up';
      reported = [];
      setEvents({
        async devicesRemoved({ deviceIds: ids }) {
          if (host === 'down') throw new Error('host index is down');
          if (host !== 'up') await host;
          reported.push(...ids);
        }
      });
      delays = service.retryDelays;
      quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(async () => {
      host = 'up';
      await idle();
      for (const retry of service.retries.values()) clearTimeout(retry.timer);
      service.retries.clear();
      service.retryDelays = delays;
      setEvents({});
      jest.restoreAllMocks();
    });

    test('is reported again until the host takes it, and after the last retry by the next change', async () => {
      service.retryDelays = [20, 20];
      // Discarded while the host is down: gone here, kept to report
      host = 'down';
      const first = await newDevice('Late one');
      await service.discardDevice(first.id);
      expect(await deviceIds()).not.toContain(first.id);
      expect(await outbox()).toEqual([first.id]);

      // Tried again a little later, and once the host is back, it hears about it
      host = 'up';
      await until(async () => reported.includes(first.id) && !(await outbox()).length);
      expect(reported).toEqual([first.id]);
      expect(await outbox()).toEqual([]);

      // The host stays down past the last retry: the library's next change reports it
      host = 'down';
      const second = await newDevice('Late two');
      await service.discardDevice(second.id);
      await until(() => !service.retries.size && !service.reporting.size);
      expect(service.retries.size).toBe(0);
      expect(await outbox()).toEqual([second.id]);
      host = 'up';
      const third = await newDevice('Back');
      await until(() => reported.includes(second.id));
      expect(reported).toEqual([first.id, second.id]);
      await idle();
      expect(await outbox()).toEqual([]);
      await service.removeDevices(d => d.id === third.id);
    });

    test('is kept before the device goes, so a crash or a failed write in between loses nothing', async () => {
      const store = getDataStore();
      const update = store.update;
      const writes = [];
      jest.spyOn(store, 'update').mockImplementation(function (name, ...rest) {
        writes.push(name);
        return update.call(this, name, ...rest);
      });
      host = 'down';
      const device = await newDevice('Kept first');
      writes.length = 0;
      await service.discardDevice(device.id);
      expect(writes.indexOf('device-removals')).toBeGreaterThanOrEqual(0);
      expect(writes.indexOf('device-removals')).toBeLessThan(writes.indexOf('devices'));

      // The outbox can't be written and the host is down: the device stays, so
      // the two indexes still agree
      const stays = await newDevice('Nowhere to keep');
      store.update.mockImplementation(function (name, ...rest) {
        if (name === 'device-removals') return Promise.reject(new Error('disk full'));
        return update.call(this, name, ...rest);
      });
      await expect(service.discardDevice(stays.id)).rejects.toThrow('host index is down');
      expect(await deviceIds()).toContain(stays.id);
      // With the host up, it hears first and the device goes
      host = 'up';
      await service.discardDevice(stays.id);
      expect(reported).toContain(stays.id);
      expect(await deviceIds()).not.toContain(stays.id);
      store.update.mockRestore();
      await service.reportRemovals(); // the one kept while the host was down
    });

    test('a discard that reaches the host also sends the ones it missed before', async () => {
      service.retryDelays = [60 * 60 * 1000]; // no timer gets there first
      host = 'down';
      const missed = await newDevice('Missed');
      await service.discardDevice(missed.id);
      const next = await newDevice('Next');
      await idle();
      host = 'up';
      await service.discardDevice(next.id);
      expect(reported.sort()).toEqual([missed.id, next.id].sort());
      expect(await outbox()).toEqual([]);
    });

    test('an approval whose code runs out while its account is finished is undone', async () => {
      const pairing = service.start('10.66.0.2', 'browser-key');
      const before = await deviceIds();
      const device = await service.approve(pairing.code, {
        name: 'Slow account',
        accountId: 'acc_none',
        beforeReady: async () => { pairing.expiresAt = Date.now() - 1; } // the account write took past the deadline
      });
      expect(device).toBeNull();
      expect(pairing.approved).toBeNull();
      expect(await deviceIds()).toEqual(before);
      expect(reported).toHaveLength(1);
      expect(before).not.toContain(reported[0]);
    });

    test('a host slow with old removals holds up no sign-in or removal', async () => {
      host = 'down';
      const old = await newDevice('Old');
      await service.discardDevice(old.id);
      // The host hangs on the old removal, and answers anything else
      let answer;
      const hang = new Promise((resolve) => { answer = resolve; });
      setEvents({
        async devicesRemoved({ deviceIds: ids }) {
          if (ids.includes(old.id)) await hang;
          reported.push(...ids);
        }
      });
      try {
        const stalled = new Promise(resolve => setTimeout(() => resolve('stalled'), 500));
        const joined = await Promise.race([newDevice('PIN screen'), stalled]);
        expect(joined).not.toBe('stalled');
        const removed = await Promise.race([service.removeDevices(d => d.id === joined.id), stalled]);
        expect(removed).toBe(1);
      } finally {
        answer(); // so a failure here doesn't leave later tests waiting on the host
      }
      await until(() => reported.includes(old.id));
      expect(reported).toContain(old.id);
    });
  });

  test('two approvals at the same time pair the frame once', async () => {
    const devicesBefore = (await admin.get('/api/admin/devices').expect(200)).body.devices.length;
    const accountsBefore = (await admin.get('/api/access-accounts').expect(200)).body.accounts.length;
    const frame = request.agent(app);
    const pairing = await start(frame);

    const results = await Promise.all(['Twin one', 'Twin two'].map(name =>
      admin.post(`/api/admin/pair/${pairing.code}/approve`).send({ name, newAccount: {} })));
    expect(results.map(r => r.status).sort()).toEqual([200, 404]);
    expect((await admin.get('/api/admin/devices').expect(200)).body.devices).toHaveLength(devicesBefore + 1);
    expect((await admin.get('/api/access-accounts').expect(200)).body.accounts).toHaveLength(accountsBefore + 1);

    // The one device made is the one whose token the frame collects
    const { token, device } = await collect(frame, pairing);
    expect(device.name).toBe(results.find(r => r.status === 200).body.device.name);
    await request(app).post('/api/auth/device').send({ token }).expect(200);
  });

  test('frames can share an existing account, and removing one unpairs it', async () => {
    const accounts = (await admin.get('/api/access-accounts').expect(200)).body.accounts;
    const kitchen = accounts.find(a => a.name === 'Kitchen frame');

    const frame = request.agent(app);
    const pairing = await start(frame);
    await admin.post(`/api/admin/pair/${pairing.code}/approve`).send({ name: 'Hall frame', accountId: 'acc_nope' }).expect(400);
    await admin.post(`/api/admin/pair/${pairing.code}/approve`).send({ name: 'Hall frame', accountId: kitchen.id }).expect(200);
    const { token } = await collect(frame, pairing);

    await request(app).get('/api/admin/devices').expect(401);
    const listed = (await admin.get('/api/admin/devices').expect(200)).body.devices;
    const hall = listed.find(d => d.name === 'Hall frame');
    expect(hall).toMatchObject({ accountId: kitchen.id, accountName: 'Kitchen frame' });
    expect(hall).not.toHaveProperty('tokenHash');
    expect(Date.parse(hall.lastSeen)).toBeGreaterThan(Date.parse(hall.pairedAt) - 1000);

    await admin.delete(`/api/admin/devices/${hall.id}`).expect(200);
    const refused = await request(app).post('/api/auth/device').send({ token }).expect(401);
    expect(refused.body.code).toBe('DEVICE_UNKNOWN');
  });

  test('deleting an account unpairs its frames', async () => {
    const kitchen = (await admin.get('/api/access-accounts').expect(200)).body.accounts.find(a => a.name === 'Kitchen frame');
    await admin.delete(`/api/access-accounts/${kitchen.id}`).expect(200);
    const left = (await admin.get('/api/admin/devices').expect(200)).body.devices;
    expect(left.filter(d => d.accountId === kitchen.id)).toEqual([]);
  });

  test('a frame that hit the code limit gets back in once old codes age out', () => {
    const controller = require('../controllers/pairingController');
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      for (let i = 0; i < 20; i++) expect(controller.tooManyStarts('10.0.0.9')).toBe(false);
      // Retrying every minute while refused doesn't push the wait out
      for (let i = 0; i < 9; i++) {
        now += 60 * 1000;
        expect(controller.tooManyStarts('10.0.0.9')).toBe(true);
      }
      now += 61 * 1000;
      expect(controller.tooManyStarts('10.0.0.9')).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  test('the phone comes back to the pairing page after signing in', async () => {
    const res = await request(app).get('/pair?code=ABC234').expect(302);
    expect(res.headers.location).toBe('/login?next=%2Fpair%3Fcode%3DABC234');

    const signedIn = await admin.get('/login').query({ next: '/pair?code=ABC234' }).expect(302);
    expect(signedIn.headers.location).toBe('/pair?code=ABC234');
    const offsite = await admin.get('/login').query({ next: '//evil.example' }).expect(302);
    expect(offsite.headers.location).toBe('/admin');
  });

  test('MAX_SCREENS caps how many frames a library can pair', async () => {
    const before = (await admin.get('/api/admin/devices').expect(200)).body.devices.length;
    const devices = before + 1;
    process.env.MAX_SCREENS = String(devices);
    try {
      const first = await start(request.agent(app));
      await admin.post(`/api/admin/pair/${first.code}/approve`).send({ name: 'Fits', newAccount: {} }).expect(200);
      const pairing = await start(request.agent(app));
      const res = await admin.post(`/api/admin/pair/${pairing.code}/approve`).send({ name: 'One too many', newAccount: {} }).expect(403);
      expect(res.body).toMatchObject({ code: 'SCREEN_LIMIT', limit: devices });
      expect((await admin.get('/api/admin/devices').expect(200)).body.devices).toHaveLength(devices);

      process.env.MAX_SCREENS = String(devices + 1);
      await admin.post(`/api/admin/pair/${pairing.code}/approve`).send({ name: 'Fits now', newAccount: {} }).expect(200);
    } finally {
      delete process.env.MAX_SCREENS;
    }
  });
});
