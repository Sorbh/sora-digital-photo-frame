const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');

// Point the app at throwaway folders before it loads
const testUploadsDir = path.join(__dirname, 'logger-uploads');
const testCacheDir = path.join(__dirname, 'logger-cache');
const testDataDir = path.join(__dirname, 'logger-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'correct-horse-battery';

const { createApp } = require('../app');
const { redact, redactUrl } = require('../middleware/logger');

describe('Request logging keeps secrets out of the logs', () => {
  const app = createApp();
  let output;
  let spies;

  beforeEach(() => {
    output = [];
    const capture = (...args) => output.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    spies = ['log', 'info', 'warn', 'error'].map(method => jest.spyOn(console, method).mockImplementation(capture));
  });

  afterEach(() => spies.forEach(spy => spy.mockRestore()));

  afterAll(async () => {
    await Promise.all([testUploadsDir, testCacheDir, testDataDir].map(dir => fs.remove(dir)));
  });

  test('admin password is never logged, right or wrong', async () => {
    await request(app).post('/api/auth/login').send({ password: 'correct-horse-battery' }).expect(200);
    await request(app).post('/api/auth/login').send({ password: 'wrong-guess-123' }).expect(401);
    const logs = output.join('\n');
    expect(logs).toMatch(/POST \/api\/auth\/login/);
    expect(logs).not.toMatch(/correct-horse-battery/);
    expect(logs).not.toMatch(/wrong-guess-123/);
  });

  test('PIN in a JSON body is never logged', async () => {
    await request(app).post('/api/auth/pin').send({ pin: '864213' });
    expect(output.join('\n')).not.toMatch(/864213/);
  });

  test('session ids are neither logged nor returned', async () => {
    const agent = request.agent(app);
    const res = await agent.post('/api/auth/login').send({ password: 'correct-horse-battery' }).expect(200);
    const sid = /photoframe\.sid=([^;]+)/.exec(res.headers['set-cookie'].join(';'))[1];
    await agent.get('/api/admin/folders?path=uploads');
    const id = decodeURIComponent(sid).replace(/^s:/, '').split('.')[0];
    expect(output.join('\n')).not.toContain(id);
  });

  test('secrets in query strings and guest link paths are hidden', () => {
    expect(redactUrl('/slideshow?pin=4321&folder=family')).toBe('/slideshow?pin=[redacted]&folder=family');
    expect(redactUrl('/api/x?Token=abc')).toBe('/api/x?Token=[redacted]');
    expect(redactUrl('/g/AbCdEfGhIj.sometoken/upload')).toBe('/g/[redacted]/upload');
    expect(redactUrl('/api/folders')).toBe('/api/folders');
  });

  test('nested and differently-cased keys are redacted', () => {
    expect(redact({ user: { Password: 'x', name: 'Ann' }, items: [{ idToken: 'y' }], Authorization: 'Bearer z' }))
      .toEqual({ user: { Password: '[redacted]', name: 'Ann' }, items: [{ idToken: '[redacted]' }], Authorization: '[redacted]' });
  });
});
