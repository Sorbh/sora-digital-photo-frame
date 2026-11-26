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
const express = require('express');
const { safePath } = require('../middleware/logger');
const errorHandler = require('../middleware/errorHandler');

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

  test('family code in a PIN sign-in is never logged', async () => {
    await request(app).post('/api/auth/pin').send({ pin: '864213', familyCode: 'QWER-TYUI' });
    expect(output.join('\n')).not.toMatch(/QWER-TYUI/);
  });

  test('a body that is not valid JSON is neither logged nor echoed back', async () => {
    const res = await request(app).post('/api/auth/pin')
      .set('Content-Type', 'application/json')
      .send('{"pin": "975310", "familyCode": "ZXCV-BNMA"');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/975310|ZXCV-BNMA/);
    const logs = output.join('\n');
    expect(logs).toMatch(/entity\.parse\.failed/);
    expect(logs).not.toMatch(/975310/);
    expect(logs).not.toMatch(/ZXCV-BNMA/);
  });

  test('query strings and bodies never reach the logs', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'correct-horse-battery' }).expect(200);
    await agent.get('/api/admin/folders?path=uploads/private-folder-name');
    await agent.post('/api/notes').send({ title: 'Secret note title', message: 'A very private message' });
    const logs = output.join('\n');
    expect(logs).toMatch(/GET \/api\/admin\/folders \d{3} \d+ms/);
    expect(logs).toMatch(/POST \/api\/notes \d{3} \d+ms/);
    expect(logs).not.toMatch(/private-folder-name|Secret note title|very private message/);
  });

  test('paths are logged without their query, and guest link tokens are hidden', () => {
    expect(safePath('/slideshow?pin=4321&family=ABCD-EFGH')).toBe('/slideshow');
    expect(safePath('/g/AbCdEfGhIj.sometoken/upload')).toBe('/g/[redacted]/upload');
    expect(safePath('/api/folders')).toBe('/api/folders');
  });

  test('photo, thumbnail and folder paths are logged as their route only', () => {
    expect(safePath('/uploads/Grandmas%20Birthday/IMG_1234.jpg')).toBe('/uploads/[photo]');
    expect(safePath('/UPLOADS/Album/photo.jpg?w=300')).toBe('/uploads/[photo]');
    expect(safePath('/api/images/Album%2FIMG_1234.jpg/thumbnail')).toBe('/api/images/[photo]/thumbnail');
    expect(safePath('/api/folders/Trips/Italy/thumbnail')).toBe('/api/folders/[folder]/thumbnail');
    expect(safePath('/api/folders/Trips/Italy')).toBe('/api/folders/[folder]');
    expect(safePath('/g/AbCdEfGhIj.sometoken/uploads/Album/photo.jpg')).toBe('/g/[redacted]/uploads/[photo]');
    // A request that names the whole address
    expect(safePath('http://frame.example/uploads/Album/photo.jpg?w=1')).toBe('/uploads/[photo]');
    expect(safePath('HTTPS://frame.example/api/folders/Trips/Italy')).toBe('/api/folders/[folder]');
    expect(safePath('http://frame.example/g/sometoken/uploads/Album/photo.jpg')).toBe('/g/[redacted]/uploads/[photo]');
    // Other paths stay as they are
    expect(safePath('/uploads')).toBe('/uploads');
    expect(safePath('/api/images/next')).toBe('/api/images/next');
    expect(safePath('/api/notes/active')).toBe('/api/notes/active');
  });

  test('requests for photos and folders keep album and file names out of the log', async () => {
    await request(app).get('/uploads/Grandmas%20Birthday/IMG_1234.jpg');
    await request(app).get('/api/images/Grandmas%20Birthday%2FIMG_1234.jpg/thumbnail');
    await request(app).get('/api/folders/Grandmas%20Birthday/thumbnail');
    await request(app).get('/api/folders/Grandmas%20Birthday');
    const logs = output.join('\n');
    expect(logs).toMatch(/GET \/uploads\/\[photo\] \d{3} \d+ms/);
    expect(logs).toMatch(/GET \/api\/images\/\[photo\]\/thumbnail \d{3} \d+ms/);
    expect(logs).toMatch(/GET \/api\/folders\/\[folder\]\/thumbnail \d{3} \d+ms/);
    expect(logs).toMatch(/GET \/api\/folders\/\[folder\] \d{3} \d+ms/);
    expect(logs).not.toMatch(/Grandma|IMG_1234/);
  });

  test('a request naming the whole address keeps album and file names out of the log too', async () => {
    const http = require('http');
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
      const status = await new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: server.address().port,
          method: 'GET',
          path: 'http://frame.example/uploads/Grandmas%20Birthday/IMG_1234.jpg',
          headers: { Host: 'frame.example' }
        }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject);
        req.end();
      });
      // Routed as a photo, so it needs a signed-in viewer
      expect(status).toBe(401);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
    const logs = output.join('\n');
    expect(logs).toMatch(/GET \/uploads\/\[photo\] 401 \d+ms/);
    expect(logs).not.toMatch(/Grandma|IMG_1234|frame\.example/);
  });
});

describe('Error handler', () => {
  let output;
  let spy;
  beforeEach(() => {
    output = [];
    spy = jest.spyOn(console, 'error').mockImplementation((...args) => output.push(args.map(String).join(' ')));
  });
  afterEach(() => spy.mockRestore());

  const appThrowing = (err) => {
    const app = express();
    app.get('/x', (req, res, next) => next(err));
    app.use(errorHandler);
    return app;
  };

  test("never logs an error's own fields, such as a body a library attached", async () => {
    const err = Object.assign(new Error('Tenant lookup failed'), { code: 'LOOKUP', requestBody: { pin: '246813', familyCode: 'PLMK-OIJN' } });
    await request(appThrowing(err)).get('/x').expect(500);
    const logs = output.join('\n');
    expect(logs).toMatch(/request failed: Error LOOKUP/);
    expect(logs).toMatch(/^\s+at /m); // where it was thrown
    expect(logs).not.toMatch(/246813|PLMK-OIJN/);
  });

  test('a message spread over lines that look like stack frames is not logged', async () => {
    const err = new Error('Lookup failed for request:\n    at /api/auth/pin (/secret/PLMK-OIJN.js:1:1)\n    at 246813 (/x.js:2:2)');
    await request(appThrowing(err)).get('/x').expect(500);
    const logs = output.join('\n');
    expect(logs).not.toMatch(/PLMK-OIJN|246813/);
    expect(logs).toMatch(/logger\.test\.js:\d+:\d+/); // the real frames are still there
  });

  test('a code that does not look like one is not logged', async () => {
    const err = Object.assign(new Error('x'), { code: 'PLMK-OIJN' });
    await request(appThrowing(err)).get('/x').expect(500);
    const logs = output.join('\n');
    expect(logs).not.toMatch(/PLMK-OIJN/);
    expect(logs).toMatch(/Error \[redacted\]/);
    output.length = 0;
    await request(appThrowing(Object.assign(new Error('y'), { code: 'ERR_STREAM_DESTROYED' }))).get('/x').expect(500);
    expect(output.join('\n')).toMatch(/ERR_STREAM_DESTROYED/);
  });

  test('a server error message is neither logged nor returned', async () => {
    const err = new Error('No family for code PLMK-OIJN');
    const res = await request(appThrowing(err)).get('/x').expect(500);
    expect(res.body.message).toBe('Internal server error');
    expect(JSON.stringify(res.body)).not.toMatch(/PLMK-OIJN/);
    expect(output.join('\n')).not.toMatch(/PLMK-OIJN/);
  });

  test('a hosted tenant lookup that fails during PIN sign-in leaks nothing', async () => {
    const hosted = createApp({
      resolveTenant: req => { if (req.body && req.body.familyCode) throw new Error(`Unknown family ${req.body.familyCode}`); return null; }
    });
    const res = await request(hosted).post('/api/auth/pin').send({ pin: '135790', familyCode: 'QAZW-SXED' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/QAZW-SXED|135790/);
    expect(output.join('\n')).not.toMatch(/QAZW-SXED|135790/);
  });

  test('keeps the answer of other errors that carry a type and a body', async () => {
    const err = Object.assign(new Error('Name is required'), { status: 422, type: 'validation.failed', body: { name: '' } });
    const res = await request(appThrowing(err)).get('/x').expect(422);
    expect(res.body.message).toBe('Name is required');
  });
});

describe('Google Photos token check', () => {
  test('a failed check does not log the token from its address', async () => {
    const oauth = require('../utils/oauthManager');
    const realFetch = global.fetch;
    const warnings = [];
    const spies = ['log', 'warn', 'error'].map(m => jest.spyOn(console, m).mockImplementation((...args) => warnings.push(args.map(String).join(' '))));
    global.fetch = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('request to https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=ya29.SECRETTOKEN failed'), { name: 'FetchError', code: 'ECONNRESET' }))
      .mockResolvedValue({ ok: false, status: 500, statusText: 'Error', text: async () => '{}' });
    try {
      await oauth.createPickerSession('ya29.SECRETTOKEN', 'uploads').catch(() => {});
      expect(warnings.join('\n')).not.toMatch(/SECRETTOKEN/);
    } finally {
      global.fetch = realFetch;
      spies.forEach(spy => spy.mockRestore());
    }
  });
});

describe('Controller logs', () => {
  afterAll(() => fs.remove(testUploadsDir)); // the folder-name test below writes a photo

  let output;
  let spies;
  beforeEach(() => {
    output = [];
    const capture = (...args) => output.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    spies = ['log', 'info', 'warn', 'error'].map(method => jest.spyOn(console, method).mockImplementation(capture));
  });
  afterEach(() => spies.forEach(spy => spy.mockRestore()));

  test('a failing family code hook does not get the new code logged', async () => {
    const familyCodes = require('../services/familyCodeService');
    const accessAccounts = require('../controllers/accessAccountController');
    const spy = jest.spyOn(familyCodes, 'renew').mockRejectedValue(new Error('Index update failed for ZXCV-QWER'));
    const was = accessAccounts.familyCode;
    accessAccounts.familyCode = true;
    try {
      const res = { status: () => res, json: () => res };
      await accessAccounts.renewFamilyCode({}, res);
      expect(output.join('\n')).not.toMatch(/ZXCV-QWER/);
      expect(output.join('\n')).toMatch(/Error renewing the family code/);
    } finally {
      accessAccounts.familyCode = was;
      spy.mockRestore();
    }
  });

  test('a folder name from the address is not logged', async () => {
    const app = createApp();
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'correct-horse-battery' }).expect(200);
    await fs.ensureDir(path.join(testUploadsDir, 'family'));
    await fs.writeFile(path.join(testUploadsDir, 'family', 'a.png'), Buffer.from('x'));
    await agent.get('/api/images/next').query({ folder: 'Private-Folder-Name' });
    expect(output.join('\n')).not.toMatch(/Private-Folder-Name/);
  });

  test('a Google sign-in error from the address is not logged', async () => {
    const google = require('../controllers/googlePhotosController');
    const res = { send: () => res, status: () => res, json: () => res, redirect: () => res };
    await google.handleCallback({ query: { error: 'odd-value-XYZ123' }, session: {} }, res, () => {});
    expect(output.join('\n')).not.toMatch(/odd-value-XYZ123/);
  });
});

describe('Google sign-in start', () => {
  test('does not log the address to come back to', () => {
    const oauth = require('../utils/oauthManager');
    const lines = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...args) => lines.push(args.map(String).join(' ')));
    try {
      oauth.getAuthUrl('https://frame.example/back?private=1', 'state-SECRET');
      expect(lines.join('\n')).not.toMatch(/private=1|state-SECRET/);
    } finally {
      spy.mockRestore();
    }
  });
});
