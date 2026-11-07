const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');

const testUploadsDir = path.join(__dirname, 'flood-uploads');
const testCacheDir = path.join(__dirname, 'flood-cache');
const testDataDir = path.join(__dirname, 'flood-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = 'flood-test-secret';
process.env.ADMIN_PASSWORD = 'flood-admin-pass';
delete process.env.PHOTO_ENCRYPTION_KEY;

const { createApp } = require('../app');
const pairing = require('../services/pairingService');
const { addressGroup } = require('../controllers/pairingController');

afterAll(async () => {
  await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
});

describe('the pairing queue', () => {
  beforeEach(() => pairing.pairings.clear());

  test('one address keeps only its newest few waiting codes', () => {
    const codes = [];
    for (let i = 0; i < pairing.MAX_PER_ADDRESS + 3; i++) codes.push(pairing.start('203.0.113.7').code);
    const waiting = pairing.waitingFrom('203.0.113.7').map(p => p.code);
    expect(waiting).toEqual(codes.slice(-pairing.MAX_PER_ADDRESS));
    expect(pairing.find(codes[0])).toBeNull();
  });

  test('a full queue still lets a new frame in, at the cost of the busiest address', () => {
    // Many addresses fill every slot
    for (let i = 0; pairing.pairings.size < pairing.MAX_PENDING; i++) {
      pairing.start(`flood-${Math.floor(i / pairing.MAX_PER_ADDRESS)}`);
    }
    expect(pairing.pairings.size).toBe(pairing.MAX_PENDING);
    const frame = pairing.start('198.51.100.20');
    expect(frame).not.toBeNull();
    expect(pairing.pairings.size).toBe(pairing.MAX_PENDING);
    expect(pairing.find(frame.code)).not.toBeNull();
  });

  test('when everyone holds as few codes as the newcomer would, the queue says full', () => {
    for (let i = 0; i < pairing.MAX_PENDING; i++) pairing.start(`one-each-${i}`);
    expect(pairing.start('one-each-0')).toBeNull();
    expect(pairing.start('someone-new')).toBeNull();
  });

  test('codes an admin approved are never pushed out', () => {
    const approved = pairing.start('203.0.113.8');
    approved.approved = { token: 't', device: {}, tenant: {} };
    for (let i = 0; i < pairing.MAX_PER_ADDRESS + 2; i++) pairing.start('203.0.113.8');
    expect(pairing.find(approved.code)).not.toBeNull();
  });

  test('an IPv6 /64 counts as one address', () => {
    expect(addressGroup('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(addressGroup('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(addressGroup('2001:0db8:0001:0002::9%eth0')).toBe('2001:db8:1:2::/64');
    expect(addressGroup('2001:db8::5')).toBe('2001:db8:0:0::/64');
    expect(addressGroup('::ffff:192.0.2.4')).toBe('192.0.2.4');
    expect(addressGroup('192.0.2.4')).toBe('192.0.2.4');
  });

  test('rotating through one IPv6 /64 hits the start limit', async () => {
    const app = createApp({ trustProxy: true });
    const statuses = [];
    for (let i = 0; i < 22; i++) {
      statuses.push((await request(app).post('/api/pair/start').set('X-Forwarded-For', `2001:db8:77:1::${(i + 1).toString(16)}`)).status);
    }
    expect(statuses.slice(0, 20).every(s => s === 200)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
    expect(pairing.waitingFrom('2001:db8:77:1::/64')).toHaveLength(pairing.MAX_PER_ADDRESS);
  });
});

describe('the session secret', () => {
  test.each([undefined, 'your-secret-key-change-this', 'generate_random_secret_key_here_min_32_chars'])(
    'with SESSION_SECRET %s the server makes up one and keeps it', async (value) => {
      const dataDir = path.join(testDataDir, `secret-${value || 'unset'}`);
      const saved = { SESSION_SECRET: process.env.SESSION_SECRET, DATA_DIR: process.env.DATA_DIR };
      if (value === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = value;
      process.env.DATA_DIR = dataDir;
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        let app, used;
        jest.isolateModules(() => {
          app = require('../app').createApp();
          used = require('../utils/sessionSecret').sessionSecret();
        });
        const kept = (await fs.readFile(path.join(dataDir, 'session-secret'), 'utf8')).trim();
        expect(kept).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(used).toBe(kept);
        expect(warn.mock.calls.flat().join(' ')).toContain('session-secret');
        expect(warn.mock.calls.flat().join(' ')).not.toContain(kept); // the secret itself isn't logged

        // A restart reads the same one, so sessions survive it
        let again;
        jest.isolateModules(() => { again = require('../utils/sessionSecret').sessionSecret(); });
        expect(again).toBe(kept);

        await request(app).post('/api/auth/login').send({ password: 'flood-admin-pass' }).expect(200);
      } finally {
        warn.mockRestore();
        Object.assign(process.env, saved);
      }
    });

  test('a secret of your own is used as it is, and nothing is written', async () => {
    const dataDir = path.join(testDataDir, 'secret-own');
    const saved = { SESSION_SECRET: process.env.SESSION_SECRET, DATA_DIR: process.env.DATA_DIR };
    process.env.SESSION_SECRET = 'a-secret-of-my-own-that-is-long-enough';
    process.env.DATA_DIR = dataDir;
    try {
      let used;
      jest.isolateModules(() => { used = require('../utils/sessionSecret').sessionSecret(); });
      expect(used).toBe('a-secret-of-my-own-that-is-long-enough');
      expect(await fs.pathExists(path.join(dataDir, 'session-secret'))).toBe(false);
    } finally {
      Object.assign(process.env, saved);
    }
  });
});
