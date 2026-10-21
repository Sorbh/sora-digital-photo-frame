const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');

// Point the app at throwaway folders before it loads
const testUploadsDir = path.join(__dirname, 'notes-uploads');
const testCacheDir = path.join(__dirname, 'notes-cache');
const testDataDir = path.join(__dirname, 'notes-data');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'test-admin-pass';

const app = require('../server');
const { NoteService } = require('../services/noteService');

const HOUR = 60 * 60 * 1000;

describe('Notes', () => {
  beforeAll(async () => {
    await fs.ensureDir(path.join(testUploadsDir, 'family'));
    await fs.ensureDir(path.join(testUploadsDir, 'trips'));
    await fs.writeFile(path.join(testUploadsDir, 'family/priya.jpg'), 'jpg');
    await fs.writeFile(path.join(testUploadsDir, 'trips/lake.jpg'), 'jpg');
  });

  afterAll(async () => {
    await fs.remove(testUploadsDir);
    await fs.remove(testCacheDir);
    await fs.remove(testDataDir);
  });

  describe('service', () => {
    let service;
    const now = new Date('2026-10-21T12:00:00Z');

    beforeEach(async () => {
      service = new NoteService(path.join(testDataDir, `unit-${Date.now()}-${Math.random()}.json`));
    });

    const note = (overrides = {}) => ({
      title: 'Priya is visiting you',
      startsAt: '2026-10-20T00:00:00Z',
      enabled: true,
      audience: { all: true, accountIds: [] },
      photos: [],
      ...overrides
    });

    test('status follows the date window', () => {
      expect(service.status(note(), now)).toBe('active');
      expect(service.status(note({ enabled: false }), now)).toBe('paused');
      expect(service.status(note({ startsAt: '2026-10-22T00:00:00Z' }), now)).toBe('upcoming');
      expect(service.status(note({ endsAt: '2026-10-21T11:00:00Z' }), now)).toBe('ended');
    });

    test('a note with an event ends two hours after it', () => {
      const event = note({ eventAt: '2026-10-21T10:30:00Z' });
      expect(service.status(event, now)).toBe('active');
      expect(service.status(event, new Date(now.getTime() + 0.5 * HOUR))).toBe('ended');
    });

    test('validate fills defaults and rejects bad input', async () => {
      const { note: valid } = await service.validate({ title: '  Hello  ' });
      expect(valid).toMatchObject({ title: 'Hello', theme: 'paper', everyMinutes: 5, showForSeconds: 20, enabled: true });
      expect(valid.audience).toEqual({ all: true, accountIds: [] });

      const { errors } = await service.validate({
        title: '',
        message: 'x'.repeat(161),
        everyMinutes: 0,
        photos: ['../server.js'],
        audience: { all: false, accountIds: [] }
      });
      expect(Object.keys(errors).sort()).toEqual(['audience', 'everyMinutes', 'message', 'photos', 'title']);
    });

    test('validate accepts admin-style photo paths and rejects too many', async () => {
      const { note: valid } = await service.validate({ title: 'Hi', photos: ['uploads/family/priya.jpg'] });
      expect(valid.photos).toEqual([path.join('family', 'priya.jpg')]);

      const { errors } = await service.validate({ title: 'Hi', photos: Array(5).fill('family/priya.jpg') });
      expect(errors.photos).toBeDefined();
    });

    test('validate checks the book layout has enough photos', async () => {
      const { note: auto } = await service.validate({ title: 'Hi', layout: 'nonsense' });
      expect(auto.layout).toBe('auto');

      const { note: cover } = await service.validate({ title: 'Hi', layout: 'cover', photos: ['family/priya.jpg'] });
      expect(cover.layout).toBe('cover');

      const { errors } = await service.validate({ title: 'Hi', layout: 'quote', photos: ['family/priya.jpg'] });
      expect(errors.layout).toBe('This layout needs 2 photos');
    });

    test('active filters by audience and folder access', async () => {
      await service.save([
        { id: 'a', ...note({ photos: ['family/priya.jpg', 'trips/lake.jpg'] }) },
        { id: 'b', ...note({ audience: { all: false, accountIds: ['grandma'] } }) },
        { id: 'c', ...note({ enabled: false }) }
      ]);

      const open = await service.active({}, now);
      expect(open.map(n => n.id)).toEqual(['a']);
      expect(open[0].photos).toHaveLength(2);

      const grandma = await service.active({ accessAccount: { id: 'grandma', assignedFolders: ['family'] } }, now);
      expect(grandma.map(n => n.id)).toEqual(['a', 'b']);
      expect(grandma[0].photos.map(p => p.path)).toEqual(['family/priya.jpg']);
      expect(grandma[0].photos[0].url).toBe('/uploads/family/priya.jpg');
    });
  });

  describe('API', () => {
    const agent = request.agent(app);

    beforeAll(async () => {
      await agent.post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200);
    });

    test('managing notes requires the admin', async () => {
      await request(app).get('/api/notes').expect(401);
      await request(app).post('/api/notes').send({ title: 'Hi' }).expect(401);
    });

    test('create, list, update, show on the frame and delete', async () => {
      const created = await agent.post('/api/notes')
        .send({ title: 'Outing to the lake', message: 'Next Tuesday', photos: ['uploads/trips/lake.jpg'] })
        .expect(201);
      const id = created.body.note.id;

      const listed = await agent.get('/api/notes').expect(200);
      expect(listed.body.notes.find(n => n.id === id)).toMatchObject({ status: 'active' });

      const active = await request(app).get('/api/notes/active').expect(200);
      expect(active.body.notes.map(n => n.id)).toContain(id);

      await agent.put(`/api/notes/${id}`).send({ enabled: false }).expect(200);
      const afterPause = await request(app).get('/api/notes/active').expect(200);
      expect(afterPause.body.notes.map(n => n.id)).not.toContain(id);

      await agent.delete(`/api/notes/${id}`).expect(200);
      await agent.delete(`/api/notes/${id}`).expect(404);
    });

    test('invalid notes are rejected with field errors', async () => {
      const response = await agent.post('/api/notes').send({ title: '' }).expect(400);
      expect(response.body.errors.title).toBeDefined();
    });
  });
});
