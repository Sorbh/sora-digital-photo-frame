const request = require('supertest');
const path = require('path');
const fs = require('fs-extra');
const sharp = require('sharp');

// Point the app at throwaway folders before it loads
const testUploadsDir = path.join(__dirname, 'test-uploads');
const testCacheDir = path.join(__dirname, 'test-cache');
process.env.UPLOAD_DIR = testUploadsDir;
process.env.CACHE_DIR = testCacheDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = 'test-admin-pass';

const app = require('../server');

describe('Folder Controller API', () => {
  let server;
  
  beforeAll(async () => {
    // Create test folder structure
    await fs.ensureDir(path.join(testUploadsDir, 'vacation'));
    await fs.ensureDir(path.join(testUploadsDir, 'vacation/2023'));
    await fs.ensureDir(path.join(testUploadsDir, 'family'));
    
    // Small real JPEGs, so thumbnails can be generated from them
    const jpeg = await sharp({
      create: { width: 32, height: 24, channels: 3, background: '#c2185b' }
    }).jpeg().toBuffer();

    await fs.writeFile(path.join(testUploadsDir, 'vacation/beach.jpg'), jpeg);
    await fs.writeFile(path.join(testUploadsDir, 'vacation/2023/sunset.jpg'), jpeg);
    await fs.writeFile(path.join(testUploadsDir, 'family/portrait.jpg'), jpeg);
    await fs.writeFile(path.join(testUploadsDir, 'family/beach.jpg'), jpeg);
  });
  
  afterAll(async () => {
    // Clean up test files
    await fs.remove(testUploadsDir);
    await fs.remove(testCacheDir);
    if (server) {
      server.close();
    }
  });

  describe('GET /api/folders', () => {
    test('should return folder structure', async () => {
      const response = await request(app)
        .get('/api/folders')
        .expect(200);
      
      expect(response.body.success).toBe(true);
      expect(response.body.folders).toBeInstanceOf(Array);
      expect(response.body.folders.length).toBeGreaterThan(0);
      
      const folder = response.body.folders[0];
      expect(folder).toHaveProperty('name');
      expect(folder).toHaveProperty('path');
      expect(folder).toHaveProperty('imageCount');
      expect(folder).toHaveProperty('hasSubfolders');
    });
  });

  describe('GET /api/folders/:folderPath', () => {
    test('should return specific folder contents', async () => {
      const response = await request(app)
        .get('/api/folders/vacation')
        .expect(200);
      
      expect(response.body.success).toBe(true);
      expect(response.body.folder).toHaveProperty('name', 'vacation');
      expect(response.body.folder).toHaveProperty('path', 'vacation');
      expect(response.body.folder).toHaveProperty('imageCount');
      expect(response.body.folder).toHaveProperty('breadcrumb');
      expect(response.body.subfolders).toBeInstanceOf(Array);
      expect(response.body.images).toBeInstanceOf(Array);
    });
    
    test('should return 404 for non-existent folder', async () => {
      const response = await request(app)
        .get('/api/folders/nonexistent')
        .expect(404);
      
      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe('FOLDER_NOT_FOUND');
    });
  });

  describe('GET /api/images/random', () => {
    test('should return random image without folder filter', async () => {
      const response = await request(app)
        .get('/api/images/random')
        .expect(200);
      
      expect(response.body.success).toBe(true);
      expect(response.body.image).toHaveProperty('id');
      expect(response.body.image).toHaveProperty('filename');
      expect(response.body.image).toHaveProperty('path');
      expect(response.body.image).toHaveProperty('folder');
      expect(response.body.image).toHaveProperty('url');
    });
    
    test('should return random image with folder filter', async () => {
      const response = await request(app)
        .get('/api/images/random?folder=vacation')
        .expect(200);
      
      expect(response.body.success).toBe(true);
      expect(response.body.image.folder).toMatch(/vacation/);
    });
    
    test('should return 404 for empty folder', async () => {
      const response = await request(app)
        .get('/api/images/random?folder=nonexistent')
        .expect(404);
      
      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe('FOLDER_EMPTY');
    });
  });

  describe('GET /api/folders/:folderPath/thumbnail', () => {
    test('should return folder thumbnail', async () => {
      const response = await request(app)
        .get('/api/folders/vacation/thumbnail')
        .expect(200);
      
      expect(response.headers['content-type']).toBe('image/webp');
      expect(response.body).toBeInstanceOf(Buffer);
    });
    
    test('should return 404 for folder without images', async () => {
      // Create empty folder for test
      const emptyFolderPath = path.join(testUploadsDir, 'empty');
      await fs.ensureDir(emptyFolderPath);
      
      const response = await request(app)
        .get('/api/folders/empty/thumbnail')
        .expect(404);
      
      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe('THUMBNAIL_NOT_FOUND');
      
      // Clean up
      await fs.remove(emptyFolderPath);
    });
  });

  describe('GET /api/images/:imageId/thumbnail', () => {
    test('should return image thumbnail', async () => {
      const response = await request(app)
        .get('/api/images/vacation%2Fbeach.jpg/thumbnail')
        .expect(200);
      
      expect(response.headers['content-type']).toBe('image/webp');
      expect(response.body).toBeInstanceOf(Buffer);
    });
    
    test('should return 404 for non-existent image', async () => {
      const response = await request(app)
        .get('/api/images/nonexistent.jpg/thumbnail')
        .expect(404);
      
      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe('IMAGE_NOT_FOUND');
    });
  });

  describe('POST /api/images/move', () => {
    const agent = request.agent(app);

    beforeAll(async () => {
      await agent.post('/api/auth/login').send({ password: 'test-admin-pass' }).expect(200);
    });

    test('should require authentication', async () => {
      await request(app)
        .post('/api/images/move')
        .send({ paths: ['uploads/family/portrait.jpg'], destination: 'uploads/vacation' })
        .expect(401);
    });

    test('should move a photo into another folder', async () => {
      const response = await agent
        .post('/api/images/move')
        .send({ paths: ['uploads/family/portrait.jpg'], destination: 'uploads/vacation' })
        .expect(200);

      expect(response.body.movedCount).toBe(1);
      expect(await fs.pathExists(path.join(testUploadsDir, 'vacation/portrait.jpg'))).toBe(true);
      expect(await fs.pathExists(path.join(testUploadsDir, 'family/portrait.jpg'))).toBe(false);
    });

    test('should not overwrite a photo with the same name', async () => {
      await agent
        .post('/api/images/move')
        .send({ paths: ['uploads/family/beach.jpg'], destination: 'uploads/vacation' })
        .expect(200);

      expect(await fs.pathExists(path.join(testUploadsDir, 'vacation/beach.jpg'))).toBe(true);
      expect(await fs.pathExists(path.join(testUploadsDir, 'vacation/beach-1.jpg'))).toBe(true);
    });

    test('should reject destinations outside uploads', async () => {
      await agent
        .post('/api/images/move')
        .send({ paths: ['uploads/vacation/beach.jpg'], destination: 'uploads/../../' })
        .expect(404);

      expect(await fs.pathExists(path.join(testUploadsDir, 'vacation/beach.jpg'))).toBe(true);
    });
  });
});
