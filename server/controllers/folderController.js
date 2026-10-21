const path = require('path');
const { UPLOADS_DIR } = require('../config/paths');
const fs = require('fs-extra');
const thumbnails = require('../services/thumbnailService');
const imageController = require('./imageController');
const { resolveAdminPath, toAdminPath } = require('../utils/safePath');

class FolderController {
  constructor() {
    this.uploadsDir = UPLOADS_DIR;
  }

  // Cover URL for a folder (first image, searching subfolders), or null when empty.
  // The ?v= token changes when the cover image changes, so browsers can cache it.
  async generateFolderThumbnail(folderPath) {
    try {
      const fullPath = thumbnails.resolveInUploads(folderPath);
      if (!fullPath) return null;

      const firstImage = await thumbnails.findFirstImage(fullPath);
      if (!firstImage) return null;

      const stat = await fs.stat(firstImage);
      const version = `${path.basename(firstImage)}:${Math.round(stat.mtimeMs)}`;
      const encoded = path.relative(this.uploadsDir, fullPath).split(path.sep).map(encodeURIComponent).join('/');
      return `/api/folders/${encoded}/thumbnail?v=${encodeURIComponent(version)}`;
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
        const stat = await fs.stat(image);
        const relativePath = path.relative(this.uploadsDir, image);
        return `/api/images/${encodeURIComponent(relativePath)}/thumbnail?v=${Math.round(stat.mtimeMs)}`;
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
      const items = await fs.readdir(dir, { withFileTypes: true });
      
      for (const item of items) {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          if (item.name.startsWith('.')) continue;
          count += await this.countImagesInFolder(fullPath);
        } else if (item.isFile() && /\.(jpg|jpeg|png|gif|webp)$/i.test(item.name)) {
          count++;
        }
      }
      
      return count;
    } catch (error) {
      return 0;
    }
  }
  
  // Get folder structure for slideshow selection
  async getFolderStructure(req, res) {
    try {
      const folderPath = req.params.folderPath || '';
      const fullPath = thumbnails.resolveInUploads(folderPath);

      if (!fullPath || !await fs.pathExists(fullPath)) {
        return res.status(404).json({ 
          success: false,
          error: `Folder not found: ${folderPath}`,
          code: 'FOLDER_NOT_FOUND'
        });
      }
      
      const items = await fs.readdir(fullPath, { withFileTypes: true });
      let folders = [];
      let images = [];
      
      // Check if user has access restrictions (PIN authenticated users, not admin)
      const hasAccessRestrictions = req.session && req.session.accessAccount && req.session.accessAccount.assignedFolders && req.session.accessAccount.assignedFolders.length > 0 && !req.session.authenticated;
      let allowedFolders = null;
      
      if (hasAccessRestrictions) {
        allowedFolders = req.session.accessAccount.assignedFolders;
      }

      // Folder details (counts, covers) are gathered in parallel after filtering
      const folderJobs = [];
      
      // Process folders
      for (const item of items) {
        if (item.isDirectory()) {
          if (item.name.startsWith('.')) continue;
          const itemPath = path.join(fullPath, item.name);
          const relativePath = folderPath ? path.join(folderPath, item.name) : item.name;
          
          // Apply access control filtering
          if (hasAccessRestrictions) {
            // Check if this folder or any parent folder is in allowed folders
            const folderAllowed = allowedFolders.some(allowedFolder => {
              // Check if current folder matches allowed folder exactly
              if (relativePath === allowedFolder) return true;
              // Check if current folder is a parent of an allowed folder
              if (allowedFolder.startsWith(relativePath + path.sep)) return true;
              // Check if current folder is a child of an allowed folder
              if (relativePath.startsWith(allowedFolder + path.sep)) return true;
              return false;
            });
            
            if (!folderAllowed) {
              continue; // Skip this folder
            }
          }

          folderJobs.push((async () => {
            const [subItems, imageCount, thumbnail] = await Promise.all([
              fs.readdir(itemPath, { withFileTypes: true }),
              this.countImagesInFolder(itemPath),
              this.generateFolderThumbnail(relativePath)
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
          const imageFolder = path.dirname(relativePath);
          
          // Apply access control filtering for images
          if (hasAccessRestrictions) {
            const imageAllowed = allowedFolders.some(allowedFolder => {
              // Check if image folder matches allowed folder exactly
              if (imageFolder === allowedFolder) return true;
              // Check if image folder is a child of an allowed folder
              if (imageFolder.startsWith(allowedFolder + path.sep)) return true;
              return false;
            });
            if (!imageAllowed) {
              continue; // Skip this image
            }
          }
          
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
        const imageCount = await this.countImagesInFolder(fullPath);
        const thumbnail = await this.generateFolderThumbnail(folderPath);
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
      const fullPath = thumbnails.resolveInUploads(req.params.folderPath);
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

      thumbnails.send(res, await thumbnails.getThumbnail(firstImage), { versioned: Boolean(req.query.v) });
    } catch (error) {
      console.error('Error serving folder thumbnail:', error);
      res.status(500).json({
        success: false,
        error: 'Server error',
        code: 'SERVER_ERROR'
      });
    }
  }

  // Get folder contents for the admin library
  async getFolderContents(req, res) {
    try {
      const folderPath = req.query.path || 'uploads';
      const fullPath = resolveAdminPath(folderPath, { allowRoot: true });

      if (!fullPath || !await fs.pathExists(fullPath)) {
        return res.status(404).json({ message: 'Folder not found' });
      }

      const items = await fs.readdir(fullPath, { withFileTypes: true });
      const folderJobs = [];
      const fileJobs = [];

      for (const item of items) {
        if (item.name.startsWith('.')) continue;

        if (item.isDirectory()) {
          const folderRelative = path.relative(this.uploadsDir, path.join(fullPath, item.name));
          folderJobs.push(Promise.all([
            this.generateFolderThumbnail(folderRelative),
            this.generateFolderPrints(folderRelative)
          ]).then(([thumbnail, prints]) => ({
            name: item.name,
            type: 'folder',
            path: path.join(folderPath, item.name),
            thumbnail, // null for empty folders, so the grid skips the request
            prints
          })));
        } else if (item.isFile() && thumbnails.IMAGE_PATTERN.test(item.name)) {
          const imageFullPath = path.join(fullPath, item.name);
          const relativePath = path.relative(this.uploadsDir, imageFullPath);
          const urlPath = relativePath.split(path.sep).map(encodeURIComponent).join('/');

          fileJobs.push(fs.stat(imageFullPath).then(stat => ({
            name: item.name,
            type: 'image',
            path: path.join(folderPath, item.name),
            url: `/uploads/${urlPath}`,
            // Grid tiles use the small cached version; ?v= busts it after a rotate
            thumbnail: `/api/images/${encodeURIComponent(relativePath)}/thumbnail?v=${Math.round(stat.mtimeMs)}`
          })));
        }
      }

      const [folders, files] = await Promise.all([Promise.all(folderJobs), Promise.all(fileJobs)]);

      res.json({
        currentPath: folderPath,
        folders: folders.sort((a, b) => a.name.localeCompare(b.name)),
        files: files.sort((a, b) => a.name.localeCompare(b.name))
      });
    } catch (error) {
      console.error('Error reading folder:', error);
      res.status(500).json({ message: 'Server error' });
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

      const fullPath = path.join(parentDir, name.trim());
      if (await fs.pathExists(fullPath)) {
        return res.status(400).json({ message: 'Folder already exists' });
      }

      await fs.ensureDir(fullPath);
      res.json({ message: 'Folder created successfully', path: toAdminPath(fullPath) });
    } catch (error) {
      console.error('Error creating folder:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }

  // Delete folder
  async deleteFolder(req, res) {
    try {
      // Never the uploads root itself, only folders inside it
      const fullPath = resolveAdminPath(req.query.path);

      if (!fullPath || !await fs.pathExists(fullPath)) {
        return res.status(404).json({ message: 'Folder not found' });
      }

      await fs.remove(fullPath);

      // Clear image cache after folder deletion as it might contain images
      imageController.clearImageCache();

      res.json({ message: 'Folder deleted successfully' });
    } catch (error) {
      console.error('Error deleting folder:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
}

module.exports = new FolderController();