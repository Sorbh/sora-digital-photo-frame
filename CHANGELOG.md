# Changelog

All notable changes to the Digital Photo Frame project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `MAX_SCREENS` caps how many screens a library can have (off by default); adding one past it explains how to free a spot.
- A browser that signs in with a PIN becomes one of the library's screens, as a QR-paired frame does: it's listed under its account in Access, keeps a token to come back with, and counts toward `MAX_SCREENS`. Signing out of the slideshow frees its place.
- `createApp({ familyCode: true })`: hosted setups ask frames for a family code along with the PIN (see HOOKS.md).
- HEIC uploads (iPhone photos), decoded with libheif in WebAssembly and stored as WebP like other photos.

### Security
- Photos, thumbnails, folder listings and the frame's notes now need a signed-in viewer: the admin, a PIN account or a paired frame. Before, anyone who could reach the server could load them from `/uploads/…`, `/api/images/random` and the thumbnail and folder routes, even when frames used a PIN ([#30](https://github.com/Sorbh/sora-digital-photo-frame/issues/30)). Frames that sign in keep working. If something loads photos without signing in, such as a home dashboard, set `PUBLIC_PHOTOS=true` to keep the old behaviour.
- **No default admin password.** Without `ADMIN_PASSWORD`, or with the old default `admin123`, the server makes up a password, keeps it in `data/admin-password` and prints it at start. If you signed in with `admin123`, look in the logs for the new one or set your own. `docker-compose.yml` no longer fills in `admin123`.
- Wrong admin passwords are locked out (5 per address, 20 from everyone, for 15 minutes, doubling each time). Passwords are compared in constant time.
- PIN guesses also count against the whole family, so faking `X-Forwarded-For` or spreading guesses over many addresses no longer gets around the limit. Each lockout in a row lasts twice as long (up to a day). A burst of PIN tries sent at once no longer slips past the limit. `TRUST_PROXY` sets which proxy headers to believe; set it to `false` if nothing sits in front of the server.
- Changes (POST, PUT, PATCH, DELETE) are refused unless they come from the frame's own pages, so another site on the same network, such as a router page, can't send a form as the signed-in admin.
- Google Photos: thumbnails and imports are only fetched from Google's photo addresses, so the admin's Google token can't be sent elsewhere; the thumbnail route only sends images. Imported photos are stored like uploads (WebP, a name of our own, no metadata), so a file named `x.html` can't end up on the site.
- Dependencies: express 4.22, sharp 0.35 (libvips fixes), multer 2. The Docker image runs Node 22 (sharp needs 20+).
- A PIN account or frame with assigned folders gets only those folders by every route: `/uploads/…`, photo and folder thumbnails, and folder listings. Before, it could open any photo by its address, and see covers and counts of other folders. A folder above its own shows only what leads there.
- Removing a screen or a PIN account signs that frame out within 30 seconds, and changing an account's folders reaches frames already signed in. Before, both waited for the 24-hour session to end.
- Google Photos sign-in checks a one-time `state`, so nobody can attach their own Google account to the admin's session, and each sign-in uses its own Google client. The Google profile is no longer written to the log.
- The access-accounts page escapes quotes, so a folder name can't add HTML attributes.

### Changed
- Uploads can be up to 25 MB each (was 10 MB), so 48 MP phone photos fit. Only the resized copy is stored.
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
