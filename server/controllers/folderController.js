const path = require('path');
const { UPLOADS_DIR } = require('../config/paths');
const { getLibrary } = require('../library');
const thumbnails = require('../services/thumbnailService');
const snaps = require('../services/snapService');
const notes = require('../services/noteService');
const playOrder = require('../services/playOrderService');
const imageController = require('./imageController');
const { resolveAdminPath, toAdminPath, uploadsUrl } = require('../utils/safePath');
const { passClientError } = require('../utils/httpError');
const { assignedFolders, canSee, canOpen, foldersBelow, realVisiblePath } = require('../utils/viewerAccess');
const { scopeFor } = require('../middleware/auth');
const { maxFolderDepth, canMakeFolderIn, folderTooDeepError } = require('../utils/folderDepth');

class FolderController {
  constructor() {
    this.uploadsDir = UPLOADS_DIR;
  }

  async entries(fullPath) {
    return (await getLibrary().listItems(toAdminPath(fullPath))).map(item => ({
      name: item.name, isDirectory: () => item.isFolder, isFile: () => !item.isFolder
    }));
  }

  // Cover URL for a folder (first image, searching subfolders), or null when empty.
  // The ?rev= token changes when the cover image changes. (It was ?v= when these were
  // cached for 7 days without asking; a new name means those old copies are never used.)
  async generateFolderThumbnail(folderPath) {
    try {
      const fullPath = thumbnails.resolveInUploads(folderPath);
      if (!fullPath) return null;

      const firstImage = await thumbnails.findFirstImage(fullPath);
      if (!firstImage) return null;

      const stat = await getLibrary().stat(toAdminPath(firstImage));
      const version = `${path.basename(firstImage)}:${Math.round(stat.mtimeMs)}`;
      const encoded = path.relative(this.uploadsDir, fullPath).split(path.sep).map(encodeURIComponent).join('/');
      return `/api/folders/${encoded}/thumbnail?rev=${encodeURIComponent(version)}`;
    } catch (error) {
      console.error('Error generating folder thumbnail:', error);
      return null;
    }
  }

  // Thumbnail URLs for the 2nd and 3rd photos, shown on the prints stacked behind the cover
  async generateFolderPrints(folderPath) {
    try {
      const fullPath = thumbnails.resolveInUploads(folderPath);
      if (!fullPath) return [];

      const images = (await thumbnails.findImages(fullPath, 3)).slice(1);
      return await Promise.all(images.map(async image => {
        const stat = await getLibrary().stat(toAdminPath(image));
        const relativePath = path.relative(this.uploadsDir, image);
        return `/api/images/${encodeURIComponent(relativePath)}/thumbnail?rev=${Math.round(stat.mtimeMs)}`;
      }));
    } catch (error) {
      console.error('Error generating folder prints:', error);
      return [];
    }
  }

  // Count images in folder recursively
  async countImagesInFolder(dir) {
    try {
      let count = 0;
      const items = await this.entries(dir);
      
      for (const item of items) {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          if (item.name.startsWith('.')) continue;
          count += await this.countImagesInFolder(fullPath);
        } else if (item.isFile() && (thumbnails.IMAGE_PATTERN.test(item.name) || snaps.isSnap(item.name))) {
          count++;
        }
      }
      
      return count;
    } catch (error) {
      return 0;
    }
  }
  
  // A folder's photo count and cover, as this viewer may see them. A folder that
  // is only on the way to the viewer's assigned folders counts and shows only
  // what is inside those.
  async visibleSummary(req, relativePath, fullPath) {
    if (canSee(req, relativePath)) {
      const [imageCount, thumbnail] = await Promise.all([
        this.countImagesInFolder(fullPath),
        this.generateFolderThumbnail(relativePath)
      ]);
      return { imageCount, thumbnail };
    }
    const below = foldersBelow(req, relativePath)
      .map(folder => ({ folder, full: thumbnails.resolveInUploads(folder) }))
      .filter(({ full }) => full);
    const counts = await Promise.all(below.map(({ full }) => this.countImagesInFolder(full)));
    let thumbnail = null;
    for (const { folder } of below) {
      thumbnail = await this.generateFolderThumbnail(folder);
      if (thumbnail) break;
    }
    return { imageCount: counts.reduce((sum, n) => sum + n, 0), thumbnail };
  }

  // Get folder structure for slideshow selection
  async getFolderStructure(req, res) {
    try {
      const requestedPath = req.params.folderPath || '';
      const requested = thumbnails.resolveInUploads(requestedPath);
      // Folders a frame can't open look like they don't exist, also through a symlink.
      // A symlinked folder is listed where it really is, so what's inside is checked there.
      const visible = requested ? await realVisiblePath(req, path.relative(this.uploadsDir, requested), canOpen) : null;
      const fullPath = visible === null ? null : path.join(this.uploadsDir, visible);
      const folderPath = fullPath && requestedPath ? path.relative(this.uploadsDir, fullPath) : requestedPath;

      if (!fullPath || !await getLibrary().exists(toAdminPath(fullPath))) {
        return res.status(404).json({ 
          success: false,
          error: `Folder not found: ${requestedPath}`,
          code: 'FOLDER_NOT_FOUND'
        });
      }
      
      const items = await this.entries(fullPath);
      let folders = [];
      let images = [];
      
      // Folder details (counts, covers) are gathered in parallel after filtering
      const folderJobs = [];
      
      // Process folders
      for (const item of items) {
        if (item.isDirectory()) {
          if (item.name.startsWith('.')) continue;
          const itemPath = path.join(fullPath, item.name);
          const relativePath = folderPath ? path.join(folderPath, item.name) : item.name;
          
          // Only an assigned folder, one inside it, or one on the way to it
          // (whatever the separators: "/" from the frame, "\\" on Windows)
          if (!canOpen(req, relativePath)) continue;

          folderJobs.push((async () => {
            const [subItems, { imageCount, thumbnail }] = await Promise.all([
              this.entries(itemPath),
              this.visibleSummary(req, relativePath, itemPath)
            ]);

            return {
              name: item.name,
              path: relativePath,
              thumbnail: thumbnail,
              imageCount: imageCount,
              hasSubfolders: subItems.some(subItem => subItem.isDirectory() && !subItem.name.startsWith('.'))
            };
          })());
        } else if (item.isFile() && /\.(jpg|jpeg|png|gif|webp)$/i.test(item.name)) {
          const relativePath = folderPath ? path.join(folderPath, item.name) : item.name;

          // Only photos in an assigned folder or one inside it
          if (!canSee(req, relativePath)) continue;
          
          images.push({
            id: relativePath,
            filename: item.name,
            thumbnail: `/api/images/${encodeURIComponent(relativePath)}/thumbnail`
          });
        }
      }
      
      folders = await Promise.all(folderJobs);

      // Generate breadcrumb
      const breadcrumb = [];
      if (folderPath) {
        breadcrumb.push({ name: 'Root', path: '' });
        const pathParts = folderPath.split(path.sep);
        let currentPath = '';
        for (const part of pathParts) {
          currentPath = currentPath ? path.join(currentPath, part) : part;
          breadcrumb.push({ name: part, path: currentPath });
        }
      }
      
      const response = {
        success: true
      };
      
      if (folderPath) {
        // Specific folder request
        const { imageCount, thumbnail } = await this.visibleSummary(req, folderPath, fullPath);
        const parentPath = path.dirname(folderPath);
        
        response.folder = {
          name: path.basename(folderPath),
          path: folderPath,
          parentPath: parentPath === '.' ? '' : parentPath,
          thumbnail: thumbnail,
          imageCount: imageCount,
          breadcrumb: breadcrumb
        };
        response.subfolders = folders.sort((a, b) => a.name.localeCompare(b.name));
        response.images = images.sort((a, b) => a.filename.localeCompare(b.filename));
      } else {
        // Root folder request
        response.folders = folders.sort((a, b) => a.name.localeCompare(b.name));
      }
      
      res.json(response);
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error getting folder structure:', error);
      res.status(500).json({ 
        success: false,
        error: 'Server error',
        code: 'SERVER_ERROR'
      });
    }
  }
  
  // Get folder thumbnail endpoint
  async getFolderThumbnail(req, res) {
    try {
      const requested = thumbnails.resolveInUploads(req.params.folderPath);
      // Only a cover from inside the frame's own folders, also through a symlink:
      // found where the folder really is
      const visible = requested ? await realVisiblePath(req, path.relative(this.uploadsDir, requested)) : null;
      const fullPath = visible === null ? requested : path.join(this.uploadsDir, visible);
      if (fullPath && visible === null) {
        return res.status(404).json({
          success: false,
          error: 'No thumbnail available for folder',
          code: 'THUMBNAIL_NOT_FOUND'
        });
      }
      if (!fullPath) {
        return res.status(400).json({
          success: false,
          error: 'Invalid folder path',
          code: 'INVALID_PATH'
        });
      }

      const firstImage = await thumbnails.findFirstImage(fullPath);
      if (!firstImage) {
        return res.status(404).json({
          success: false,
          error: 'No thumbnail available for folder',
          code: 'THUMBNAIL_NOT_FOUND'
        });
      }

      thumbnails.send(res, await thumbnails.getThumbnail(firstImage));
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error serving folder thumbnail:', error);
      res.status(500).json({
        success: false,
        error: 'Server error',
        code: 'SERVER_ERROR'
      });
    }
  }

  // A folder tile's cover and prints. For a person limited to some folders, a
  // folder that only leads to theirs shows photos from theirs, never its own.
  async folderCover(req, folderRelative) {
    const sources = canSee(req, folderRelative) ? [folderRelative] : foldersBelow(req, folderRelative);
    for (const source of sources) {
      const thumbnail = await this.generateFolderThumbnail(source);
      if (thumbnail) return [thumbnail, await this.generateFolderPrints(source)];
    }
    return [null, []];
  }

  // Get folder contents for the admin library
  async getFolderContents(req, res) {
    try {
      const folderPath = req.query.path || 'uploads';
      const fullPath = resolveAdminPath(folderPath, { allowRoot: true });

      if (!fullPath || !await getLibrary().exists(toAdminPath(fullPath))) {
        return res.status(404).json({ message: 'Folder not found' });
      }

      // A person limited to some folders (their scope) opens those and the folders
      // on the way to them; anything else looks like it doesn't exist. Whatever is
      // listed is checked where it really is, in case of symlinks.
      const limited = Boolean(assignedFolders(req));
      const currentRelative = path.relative(this.uploadsDir, fullPath);
      if (limited && await realVisiblePath(req, currentRelative, canOpen) === null) {
        return res.status(404).json({ message: 'Folder not found' });
      }
      const shows = async (relativePath, check = canSee) => !limited || await realVisiblePath(req, relativePath, check) !== null;

      const items = await this.entries(fullPath);
      const folderJobs = [];
      const fileJobs = [];

      for (const item of items) {
        if (item.name.startsWith('.')) continue;

        if (item.isDirectory()) {
          const folderRelative = path.relative(this.uploadsDir, path.join(fullPath, item.name));
          folderJobs.push((async () => {
            if (!await shows(folderRelative, canOpen)) return null;
            const [thumbnail, prints] = limited ? await this.folderCover(req, folderRelative) : await Promise.all([
              this.generateFolderThumbnail(folderRelative),
              this.generateFolderPrints(folderRelative)
            ]);
            return {
              name: item.name,
              type: 'folder',
              path: path.join(folderPath, item.name),
              thumbnail, // null for empty folders, so the grid skips the request
              prints
            };
          })());
        } else if (item.isFile() && thumbnails.IMAGE_PATTERN.test(item.name)) {
          const imageFullPath = path.join(fullPath, item.name);
          const relativePath = path.relative(this.uploadsDir, imageFullPath);

          fileJobs.push(shows(relativePath).then(shown => shown && getLibrary().stat(toAdminPath(imageFullPath)).then(stat => ({
            name: item.name,
            type: 'image',
            path: path.join(folderPath, item.name),
            url: uploadsUrl(toAdminPath(imageFullPath)),
            // Grid tiles use the small cached version; ?rev= changes after a rotate
            thumbnail: `/api/images/${encodeURIComponent(relativePath)}/thumbnail?rev=${Math.round(stat.mtimeMs)}`
          }))));
        } else if (item.isFile() && snaps.isSnap(item.name)) {
          // Snaps carry their page, so the grid can draw them like the frame does
          // (with only the photos this person can see)
          const snapPath = path.join(fullPath, item.name);
          fileJobs.push(shows(path.relative(this.uploadsDir, snapPath)).then(shown => shown && snaps.load(snapPath, photo => canSee(req, photo)).then(snap => ({
            name: item.name,
            type: 'snap',
            path: path.join(folderPath, item.name),
            snap
          })).catch(error => {
            console.error('Skipping unreadable snap:', snapPath, error.message);
            return null;
          })));
        } else if (item.isFile() && notes.isNote(item.name)) {
          // A note gets its own tile, which opens the note editor. It is not a
          // photo: the frame shows it on its schedule, not in the rotation.
          const notePath = path.join(fullPath, item.name);
          fileJobs.push(shows(path.relative(this.uploadsDir, notePath)).then(shown => shown && notes.load(notePath, photo => canSee(req, photo)).then(note => ({
            name: item.name,
            type: 'note',
            path: path.join(folderPath, item.name),
            note
          })).catch(error => {
            console.error('Skipping unreadable note:', notePath, error.message);
            return null;
          })));
        }
      }

      const [folders, files, { order }] = await Promise.all([
        Promise.all(folderJobs), Promise.all(fileJobs), playOrder.read(fullPath)
      ]);

      // Photos are listed in the order the frame plays them (by name for shuffle)
      const entries = files.filter(Boolean).map(file => {
        const filePath = path.join(fullPath, file.name);
        return { file, path: filePath, relativePath: path.relative(this.uploadsDir, filePath) };
      });
      const sorted = await playOrder.sort(fullPath, entries, order);
      // Whether this person can change what's here: not in a folder that only
      // leads to theirs, and not if they can only view
      const canChange = (!limited || canSee(req, currentRelative)) && scopeFor(req)?.canEdit !== false;

      res.json({
        currentPath: folderPath,
        order,
        // MAX_FOLDER_DEPTH: the library hides "New folder" where one can't be made
        maxFolderDepth: maxFolderDepth(),
        canChange,
        canCreateFolder: canChange && await canMakeFolderIn(fullPath),
        folders: folders.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name)),
        files: sorted.map(entry => entry.file)
      });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error reading folder:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }

  // How a folder plays on the frame: { order, sequence? } where sequence is
  // the folder's file names in the order set by dragging
  async setPlayOrder(req, res) {
    try {
      const fullPath = resolveAdminPath(req.query.path || 'uploads', { allowRoot: true });
      if (!fullPath || !(await getLibrary().stat(toAdminPath(fullPath)).catch(() => null))?.isFolder) {
        return res.status(404).json({ success: false, error: 'Folder not found', code: 'FOLDER_NOT_FOUND' });
      }

      const { order, sequence } = req.body || {};
      if (!playOrder.ORDERS.includes(order)) {
        return res.status(400).json({ success: false, error: 'Unknown play order' });
      }

      const settings = { order };
      if (sequence !== undefined) {
        if (!Array.isArray(sequence) || sequence.some(name => typeof name !== 'string')) {
          return res.status(400).json({ success: false, error: 'Sequence must be a list of file names' });
        }
        // Only names of files in this folder, once each
        const present = new Set((await this.entries(fullPath).then(items => items.map(item => item.name))).filter(name => !name.startsWith('.')));
        settings.sequence = [...new Set(sequence)].filter(name => present.has(name));
      }

      const saved = await playOrder.write(fullPath, settings);
      res.json({ success: true, order: saved.order });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error saving play order:', error);
      res.status(500).json({ success: false, error: 'Failed to save play order' });
    }
  }

  // Create folder
  async createFolder(req, res) {
    try {
      const { name, path: parentPath } = req.body;

      // A single, visible folder name: no separators, no "." / ".." or hidden names
      if (typeof name !== 'string' || !name.trim() || /[\\/]/.test(name) || name.trim().startsWith('.')) {
        return res.status(400).json({ message: 'Invalid folder name' });
      }

      const parentDir = resolveAdminPath(parentPath || 'uploads', { allowRoot: true });
      if (!parentDir) {
        return res.status(400).json({ message: 'Invalid parent folder' });
      }

      // MAX_FOLDER_DEPTH: no new folder past the deepest level (where it really is, after symlinks)
      if (!await canMakeFolderIn(parentDir)) throw folderTooDeepError();

      const fullPath = path.join(parentDir, name.trim());
      if (await getLibrary().exists(toAdminPath(fullPath))) {
        return res.status(400).json({ message: 'Folder already exists' });
      }

      await getLibrary().createFolder(toAdminPath(fullPath));
      res.json({ message: 'Folder created successfully', path: toAdminPath(fullPath) });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error creating folder:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }

  // Delete folder
  async deleteFolder(req, res) {
    try {
      // Never the uploads root itself, only folders inside it
      const fullPath = resolveAdminPath(req.query.path);

      if (!fullPath || !await getLibrary().exists(toAdminPath(fullPath))) {
        return res.status(404).json({ message: 'Folder not found' });
      }

      await getLibrary().deleteFolder(toAdminPath(fullPath));

      // Clear image cache after folder deletion as it might contain images
      imageController.clearImageCache();

      res.json({ message: 'Folder deleted successfully' });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Error deleting folder:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
}

module.exports = new FolderController();
