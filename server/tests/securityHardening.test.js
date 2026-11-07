const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');

const testUploadsDir = path.join(__dirname, 'harden-uploads');
const testCacheDir = path.join(__dirname, 'harden-cache');
const testDataDir = path.join(__dirname, 'harden-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'harden-admin-pass';
delete process.env.PHOTO_ENCRYPTION_KEY;

const { createApp } = require('../app');
const accessAccounts = require('../controllers/accessAccountController');
const AttemptLimiter = require('../utils/attemptLimiter');
const { isGooglePhotoUrl } = require('../utils/googleUrls');

afterAll(async () => {
  await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
});

const signedInAdmin = async (app) => {
  const admin = request.agent(app);
  await admin.post('/api/auth/login').send({ password: 'harden-admin-pass' }).expect(200);
  return admin;
};

describe('PIN guessing', () => {
  const app = createApp();
  beforeEach(() => accessAccounts.limiter.entries.clear());

  test('a made-up X-Forwarded-For per try does not get around the limit', async () => {
    const admin = await signedInAdmin(app);
    await admin.post('/api/access-accounts').send({ name: 'Kitchen', pin: '736251' }).expect(201);

    const statuses = [];
    for (let i = 0; i < 8; i++) {
      const res = await request(app).post('/api/auth/pin').set('X-Forwarded-For', `10.0.0.${i}`).send({ pin: `11111${i}` });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429, 429]);
    // Even the right PIN waits until the lockout is over
    await request(app).post('/api/auth/pin').set('X-Forwarded-For', '10.0.1.1').send({ pin: '736251' }).expect(429);
  });

  test('a burst sent all at once gets no more than five tries', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      request(app).post('/api/auth/pin').set('X-Forwarded-For', `10.1.0.${i}`).send({ pin: `22222${i % 10}` })));
    expect(results.filter(r => r.status === 401).length).toBeLessThanOrEqual(5);
    expect(results.filter(r => r.status === 429).length).toBeGreaterThanOrEqual(7);
  });
});

describe('the attempt limiter', () => {
  test('each lockout in a row lasts twice as long, up to the cap', () => {
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const limiter = new AttemptLimiter({ maxAttempts: 1, lockoutDuration: 1000, maxLockout: 3000 });
      const durations = [];
      for (let i = 0; i < 4; i++) {
        expect(limiter.check('k').allowed).toBe(true);
        limiter.fail('k');
        expect(limiter.check('k').allowed).toBe(false);
        const { lockoutUntil } = limiter.entries.get('k');
        durations.push(lockoutUntil - now);
        now = lockoutUntil + 1;
      }
      expect(durations).toEqual([1000, 2000, 3000, 3000]);
      // A success clears it all
      limiter.clear('k');
      limiter.fail('k');
      limiter.check('k');
      expect(limiter.entries.get('k').lockoutUntil - now).toBe(1000);
    } finally {
      Date.now = realNow;
    }
  });

  test('made-up addresses cannot grow memory without end', () => {
    const limiter = new AttemptLimiter({ maxTracked: 100, keep: key => key.startsWith('family:') });
    limiter.fail('family:default');
    for (let i = 0; i < 1000; i++) limiter.fail(`10.0.${i >> 8}.${i & 255}`);
    expect(limiter.entries.size).toBeLessThanOrEqual(100);
    expect(limiter.entries.has('family:default')).toBe(true);
  });
});

describe('admin password', () => {
  test('wrong passwords from one address are locked out after five', async () => {
    const app = createApp();
    const statuses = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await request(app).post('/api/auth/login').set('X-Forwarded-For', '10.9.9.9').send({ password: `wrong-${i}` })).status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
    // Another address can still sign in
    await request(app).post('/api/auth/login').set('X-Forwarded-For', '10.9.9.10').send({ password: 'harden-admin-pass' }).expect(200);
  });

  test.each([undefined, 'admin123'])('with ADMIN_PASSWORD %s the server makes up one instead', async (value) => {
    const dataDir = path.join(testDataDir, `generated-${value || 'unset'}`);
    const saved = { ADMIN_PASSWORD: process.env.ADMIN_PASSWORD, DATA_DIR: process.env.DATA_DIR };
    if (value === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = value;
    process.env.DATA_DIR = dataDir;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let app;
      jest.isolateModules(() => { app = require('../app').createApp(); });
      const generated = (await fs.readFile(path.join(dataDir, 'admin-password'), 'utf8')).trim();
      expect(generated).toMatch(/^[A-Za-z0-9_-]{16}$/);
      expect(warn.mock.calls.flat().join(' ')).toContain(generated);
      await request(app).post('/api/auth/login').send({ password: 'admin123' }).expect(401);
      await request(app).post('/api/auth/login').send({ password: generated }).expect(200);
    } finally {
      warn.mockRestore();
      Object.assign(process.env, saved);
    }
  });
});

describe('changes only from this site', () => {
  const app = createApp();

  test('a form sent from another site on the same network is refused', async () => {
    const admin = await signedInAdmin(app);
    await admin.post('/api/access-accounts').set('Sec-Fetch-Site', 'same-site')
      .type('form').send('name=Evil&pin=999999').expect(403);
    await admin.post('/api/access-accounts').set('Origin', 'http://192.168.1.1:8080')
      .type('form').send('name=Evil&pin=999998').expect(403);
    const { body } = await admin.get('/api/access-accounts').expect(200);
    expect(JSON.stringify(body)).not.toContain('Evil');
  });

  test("the site's own pages, and scripts with no browser headers, still work", async () => {
    const admin = await signedInAdmin(app);
    await admin.post('/api/notes').set('Sec-Fetch-Site', 'same-origin').send({ text: 'Hi' }).expect(res => expect(res.status).not.toBe(403));
    await admin.post('/api/notes').set('Origin', 'http://frame.local').set('Host', 'frame.local').send({ text: 'Hi' }).expect(res => expect(res.status).not.toBe(403));
    await admin.post('/api/notes').send({ text: 'Hi' }).expect(res => expect(res.status).not.toBe(403));
    // A page can't vouch for itself with X-Forwarded-Host
    await admin.post('/api/notes').set('Origin', 'http://192.168.1.1:8080').set('X-Forwarded-Host', '192.168.1.1:8080')
      .send({ text: 'Hi' }).expect(403);
    // Reading is never blocked
    await admin.get('/api/notes').set('Sec-Fetch-Site', 'cross-site').expect(200);
  });
});

describe('Google Photos addresses', () => {
  test('only https addresses on googleusercontent.com get the token', () => {
    expect(isGooglePhotoUrl('https://lh3.googleusercontent.com/abc=w150-h150-c')).toBe(true);
    for (const url of [
      'http://lh3.googleusercontent.com/abc',
      'https://evil.example/x',
      'https://googleusercontent.com.evil.example/x',
      'https://evilgoogleusercontent.com/x',
      'https://user:pass@lh3.googleusercontent.com/x',
      'https://lh3.googleusercontent.com:8443/x',
      'http://169.254.169.254/latest/meta-data',
      'file:///etc/passwd',
      'not a url'
    ]) expect({ url, ok: isGooglePhotoUrl(url) }).toEqual({ url, ok: false });
  });
});
