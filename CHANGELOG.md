# Changelog

All notable changes to the Digital Photo Frame project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **License is now AGPL-3.0** (was ISC), with DCO sign-off and a contributor grant (see CONTRIBUTING).
- New uploads are saved as WebP, at most 2560px, with all metadata removed from the file.
- An upload request takes at most 10 files; the admin page sends larger selections in batches.
- Thumbnails are `Cache-Control: private`, and a photo's date and place only go to signed-in viewers.

### Added
- Browser localization with eleven locales, including per-frame language settings and Arabic right-to-left support.
- `createApp()` hooks for running this code as a hosted service, listed in [HOOKS.md](HOOKS.md).
- Optional encryption at rest (`PHOTO_ENCRYPTION_KEY`).
- macOS Finder-like admin panel interface
- Full-page file explorer design with navigation
- Click-to-navigate folder browsing system
- Drag-and-drop image upload directly into folders
- Breadcrumb navigation for folder hierarchy
- Dynamic folder creation functionality through web interface
- Nested folder creation support (create folders inside folders)
- Folder deletion functionality with safety checks
- Admin routes for folder management API
- Updated project structure to include admin panel components
- Material Design 3 styling system with proper color palette
- Context menu for file operations (right-click functionality)
- Toast notifications for user feedback
- Upload progress indicators with real-time updates
- Keyboard shortcuts and accessibility features
- Fixed grid layout with 150px x 150px items for professional appearance

### Changed
- Redesigned admin panel from multi-section to full-page Finder-like interface
- Removed category selection dropdown in favor of folder navigation
- Updated CLAUDE.md to include Finder-like UI specifications
- Enhanced backend structure with admin routes and public files
- Updated Phase 1 tasks to reflect new admin panel requirements
- Simplified navigation system (removed forward button, only back button in nested folders)
- Improved grid layout from flexible to fixed sizing (150px x 150px items)
- Reduced grid gaps from 24px to 16px for better visual density
- Enhanced file icons from 64px to 80px for better visibility

### Technical Details
- Added `/admin` route for web interface access
- Added `POST /admin/folders` endpoint for creating new categories (supports nested paths)
- Added `DELETE /admin/folders/:path` endpoint for folder deletion
- Added public directory structure for admin HTML, CSS, and JS files
- Updated project architecture to support web-based administration
- Implemented folder navigation system with breadcrumbs
- Added drag-and-drop upload functionality
- Enhanced categories route to dynamically read all folders instead of hardcoded list
- Implemented CSS Grid with `repeat(auto-fill, 150px)` for consistent item sizing
- Added Material Design 3 color tokens and typography system
- Implemented cubic-bezier easing for smooth animations
- Added focus indicators and accessibility improvements
- Fixed Express routing issues with wildcard paths by using query parameters

---

## [0.1.0] - 2024-01-XX

### Added
- Initial project setup with Node.js backend
- Express.js server with REST API endpoints
- Image upload functionality with Multer
- Image processing with Sharp (resize, optimize)
- Category-based folder organization system
- Flutter project structure for Android tablet app
- Basic API endpoints:
  - `POST /upload` - Upload images
  - `GET /images` - Retrieve images
  - `GET /categories` - List categories
  - `DELETE /images/:id` - Remove images

### Technical Implementation
- Backend: Node.js, Express.js, Multer, Sharp, CORS
- Frontend: Flutter framework targeting Android
- File system-based storage with organized folder structure
- Automatic image optimization for tablet display (1920x1080)
- Support for JPG, JPEG, PNG, GIF formats
- 10MB maximum file size limit

### Project Structure
```
/server
├── /uploads/{family,vacation,holidays,misc}
├── /routes/{upload.js,images.js,categories.js}
├── /middleware
└── server.js

/flutter_app
├── /lib/{models,services,screens,widgets}
└── /assets
```
