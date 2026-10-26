const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const LocalPhotoLibrary = require('../library/LocalPhotoLibrary');

// Pass another factory here when a second storage backend is available.
function photoLibraryContract(name, factory) {
  describe(name, () => {
    let root;
    let library;

    beforeEach(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-library-'));
      library = factory(root);
    });
    afterEach(async () => fs.remove(root));

    test('folders and photos keep admin paths through their lifecycle', async () => {
      await library.createFolder('uploads/Family');
      expect((await library.stat('uploads/Family')).isFolder).toBe(true);
      expect(await library.exists('uploads/Family')).toBe(true);

      const photo = await library.addPhoto('uploads/Family', {
        buffer: Buffer.from('picture'), originalName: 'a.jpg', contentType: 'image/jpeg'
      });
      expect(photo.path).toBe('uploads/Family/a.jpg');
      expect(await library.readPhoto(photo.path)).toEqual(Buffer.from('picture'));
      expect(library.photoUrl(photo.path)).toBe('/uploads/Family/a.jpg');
      expect((await library.stat(photo.path)).size).toBe(7);
      expect((await library.listFolder('uploads/Family')).photos.map(p => p.name)).toEqual(['a.jpg']);
      expect((await library.allPhotos()).map(p => p.path)).toEqual([photo.path]);

      const renamed = await library.renameFolder('uploads/Family', 'Trips');
      expect(renamed.path).toBe('uploads/Trips');
      await library.createFolder('uploads/Other');
      const moved = await library.movePhoto('uploads/Trips/a.jpg', 'uploads/Other');
      expect(moved.path).toBe('uploads/Other/a.jpg');
      expect(await library.exists('uploads/Trips/a.jpg')).toBe(false);
      await library.deletePhoto(moved.path);
      expect(await library.exists(moved.path)).toBe(false);
      await library.deleteFolder('uploads/Trips');
      expect(await library.exists('uploads/Trips')).toBe(false);
    });

    test('rejects escape paths and refuses to delete the root', async () => {
      await expect(library.readPhoto('uploads/../server.js')).rejects.toThrow();
      await expect(library.addPhoto('uploads/../outside', { buffer: Buffer.from('x'), originalName: 'a.jpg' })).rejects.toThrow();
      await expect(library.deleteFolder('uploads')).rejects.toThrow();
      expect(await library.exists('uploads/../server.js')).toBe(false);
    });
  });
}

photoLibraryContract('LocalPhotoLibrary', root => new LocalPhotoLibrary(root));
