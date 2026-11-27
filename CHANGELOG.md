# Changelog

All notable changes to the Digital Photo Frame project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

These changes are for **3.0.0**: the quota hook changed (see below).

### Added
- **Pluggable device store.** Hosts can pass `createApp({ deviceStore })` to store paired screens outside the library's DataStore. Self-hosted installations keep their existing `devices.json`. See HOOKS.md.
- **Pluggable pairing store.** Hosts can keep QR pairing codes and pending approvals through a restart or share them between servers with `createApp({ pairingStore, resolvePairingTenant })`. Self-hosted installations keep the in-memory queue. See HOOKS.md.
- **Sora Frame nearby.** `GET /api/admin/pair/nearby` (owner only) lists up to 3 pairing codes, newest first, that a screen on the same home internet connection is showing now: made in the last 10 minutes and polled in the last 10 seconds with approval yet to start. A closing slideshow sends `POST /api/pair/cancel` to remove its waiting code immediately, and a waiting page restored from the back-forward cache starts a fresh pairing. It answers `{ nearby: [{ code, name, kind, platform, model, createdAt, lastSeen }] }` with the code as the screen shows it and nothing about the network, `Cache-Control: no-store`, 30 lookups a minute per network. Networks match by IPv4 address or IPv6 /64, compared as keyed hashes: a pairing no longer keeps the address it came from. `/pair` offers these codes as one tap above the code box. `createApp({ nearbyPairing: false })` or `NEARBY_PAIRING=off` turns it off (404). See HOOKS.md, Sora Frame nearby, for the shared-network caveat.
- **Screens say what they are.** `POST /api/pair/start` and `POST /api/auth/device` accept optional `name`, `kind`, `platform`, `app` and `model` fields. Approval saves the sanitized advertisement as `info`, and sign-in refreshes it when it changes. Owners can read it through `GET /api/admin/devices`. The web slideshow includes the browser in its platform label and sends its hardware model when Chromium provides it. See [Pairing for apps](docs/pairing-for-apps.md).
- **People can be limited to some folders, and to viewing.** A new optional auth hook, `scope(req)`, returns `{ folders, canEdit, isOwner }` for the signed-in person (see HOOKS.md, Scope). Every route checks it: reads outside their folders answer 404, changes there 403 `OUTSIDE_FOLDERS`, "can view" people get 403 `VIEW_ONLY` for every change, and Access, pairing and the Google Photos connection answer 403 `OWNER_ONLY` for anyone but the owner. The library, notes and snap pages hide what the person can't use. With no hook, as self-hosted, nothing changes.
- `MAX_FOLDER_DEPTH` limits how many folder levels the library can have (off by default). With `2`, `Trips` and `Trips/Italy` can be made but nothing inside `Italy`: the library hides "New folder" there, and creating or importing from Google Photos to a folder past the limit is refused with `FOLDER_TOO_DEEP`. Deeper folders that already exist keep working ([#88](https://github.com/Sorbh/sora-digital-photo-frame/issues/88)). A symlinked folder counts where it really is ([#59](https://github.com/Sorbh/sora-digital-photo-frame/issues/59)).

- **Add a screen on the Access page.** Type the code a frame shows (any case, with or without the dash or spaces), name it, and pick an existing screen or a new one and its folders: the same approval as scanning its QR code (`/pair`), which now shares its code with it. A wrong or expired code says so plainly.
- **Frames that connect by code only.** `createApp({ pinSignIn: false })` now has an env var, `PIN_SIGN_IN=off`, and goes all the way: the frame shows only its pairing code and QR code (no PIN pad, told before the page loads), a `#pin=` link is ignored, the Access page lists **Screens** (a name and folders, no PIN field), screens get no PIN at all, and `/api/features` and `/api/access-accounts` report `pinSignIn`. The PIN API still answers 404 `PIN_DISABLED`. Self-hosted installs keep PINs (see HOOKS.md, Frames that connect by code).
- **Paused screens.** A host can answer a frame's requests with 403 `SCREEN_PAUSED` and a message; the frame shows a calm full-screen card with it, keeps its token, checks again every few minutes and starts again by itself (see HOOKS.md, Paused screens).
- **Paused screens on Access.** A new optional auth hook, `isScreenPaused(deviceId, { tenantId })`, marks screens the host paused: `GET /api/admin/devices` gives them `paused: true`, and the Access page shows a "Paused" badge with why ("your plan allows fewer screens") (see HOOKS.md, Paused screens).
- **Two header options.** `createApp({ brand: { name } })` names the product in the header's wordmark, page titles and labels, and `createApp({ accountUrl })` adds an Account (person) icon to the header linking to the host's account page; with it, Access leaves the header and phone tab bar (the host shows it from its account page). Without it, as self-hosted, Access stays for the owner (see HOOKS.md, Header).
- **New note in the library**, beside New folder and New snap: it opens the note editor for the folder that is open and comes back there once the note is saved or closed. The library shows an **All notes** link beside the counts when the folder has notes.
- **Upload offers "From this device" and "From Google Photos"** (the Upload button and the phone's + button). Google Photos keeps its rules: the owner connects it, people who can edit import, and only when the server has it on. When it isn't offered, Upload goes straight to the upload dialog.
- "Add a screen" and `/pair` offer subfolders too (a folder, then its subfolders), as sharing does. Ticking a folder covers what's inside it.

### Changed
- **Screen activity is saved in batches.** Screens still shows activity from the current process immediately. Last-seen timestamps are written about once a minute and again at graceful shutdown. The account's "Last used" follows its existing schedule.
- **The frame moved to `/frame`.** `GET /slideshow` (and `/slideshow/`) answers 301 to `/frame` with its query string (`?lang=`, a legacy `?pin=`), and browsers keep a `#pin=` hash across the redirect, so bookmarks, TVs already showing it and old links keep working. `/` now goes to `/frame`, and the header, tab bar, sign-in and folder pages link there. Only the address changed: the page (`slideshow.html`, `js/slideshow.js`), its translations and the API it calls are the same. Use `/frame#pin=123456` for keyboard-less sign-in.
- **The library moved to `/home`.** `GET /admin` (and `/admin/`, with any query such as `?path=uploads%2FFamily`) answers 301 to the same address under `/home`, so bookmarks, home-screen icons and old links keep working. Sign-in, the header, the tab bar and every "back to the library" link go to `/home`; the home-screen app starts there (its manifest `id` stays `/admin`, so installed apps stay the same app). Scripts cached under `/admin/` still load. The page file is still `admin.html`, and the `/api/admin/...` routes don't change. **A host that serves the library page itself** must answer `/home` now (the core's redirect runs before `beforeRoutes`).
- **One header for every page.** The library, Access, Notes, Snap, pairing and "only for the owner" pages share one top bar and phone tab bar, drawn by the server (`server/views/pages.js`): the brand, a slot for the host (`[data-host-slot]`), then Library (when you're not on it), Access (owner, self-hosted), Slideshow, Settings (library), theme, Account (with `accountUrl`) and Log out, with the page you're on marked. Theme and Log out work on every page. **Notes and Google Photos left the header:** notes are made from the library (New note) and the Notes page stays at `/notes` for bookmarks; Google Photos is in the Upload menu. Pages are now sent rendered, so **a host that reads `server/public/*.html` from disk** must use `renderPage()` from `server/views/pages.js` instead (see HOOKS.md, Header).
- **The product is called Sora Frame everywhere.** The wordmark said "Sora"; it now says "Sora Frame" by default on every page (sign-in and the frame's slideshow too), and page titles, the home link's label and the note footer use the same name (`{brand}` in the translations, filled in from `<html data-brand>`). Pass `brand: { name }` to use another name.
- **Breaking: the quota hook counts items and screens, not just bytes.** `quota.canAdd(bytes)` is now `canAdd({ items, bytes, screens })`. A photo asks for 1 item, an animated GIF for 5 (also from Google Photos), a new snap or note for 1; saving a snap or note again or rotating a photo asks for none, only its growth. Pairing a new screen, by QR code or a new PIN sign-in, asks `{ screens: 1 }` in the same lock as `MAX_SCREENS`, with a second argument `{ screensInUse }` (the exact count under that lock), and a refusal is `SCREEN_LIMIT` with the hook's message; a screen signing in again is not asked about. Self-hosted installs keep no limits. **Hosted setups must update their hook:** see "Quota" in HOOKS.md.
- **Notes live in folders, like snaps.** Each note is a `<name>.note.json` file in a library folder, so moving, renaming or deleting a folder takes its notes along. Notes in the top folder show on every frame; a note in another folder shows only on frames that may see that folder (and, on a frame playing one folder, only that folder's notes and the top folder's). The Notes page lists notes by folder and has a folder picker; "Notes" in the library opens it in that folder, and notes show in the library grid as their own tiles. Notes are never photos: not played, counted or listed with them. **API:** `POST /api/notes` takes `folder` (the top folder by default); `GET /api/notes?folder=` lists one folder; one note is addressed by its file, `PUT`/`DELETE /api/notes?path=uploads/…/x.note.json` (`PUT` with `folder` moves it); `GET /api/notes/active?folder=` limits to the folder a frame plays. **Custom photo libraries and data stores** must handle `*.note.json` as they do `*.snap.json` (see HOOKS.md, Notes).
- **Saving never makes a folder.** Uploading, moving photos, saving snaps or a play order into a folder that isn't there answers 404 `FOLDER_NOT_FOUND`, so a folder deleted while photos were still being saved stays deleted; a Google Photos import stops at that point. Only "New folder", an import's destination and `DEFAULT_FOLDERS` make folders. **Custom photo libraries** (`createApp({ library })`) and data stores must do the same (see HOOKS.md) ([#89](https://github.com/Sorbh/sora-digital-photo-frame/issues/89)).

### Fixed
- **API answers are never kept by the browser** (`Cache-Control: no-store`, no ETag), host routes under `/api` included, and the library page loads afresh when Back brings it from the back/forward cache. Switching to another library and pressing Back no longer shows the other library's folders and controls. Photos under `/uploads` and thumbnails keep their caching.
- An upload refused (a full library, say) is said once, in front of the upload dialog and above the phone's tab bar, and the dialog says what happened ("Not added: …"). The upload button can't send the same photos again while they're on their way. Toasts on the library and Access pages show above open dialogs, and their text is never read as HTML.
- Errors in "Add a screen" and on `/pair` (a plan's screen limit, say) show at the top of the form and are brought into view, not left under the button kept at the bottom of a phone's screen.
- "Last used" on Access is no longer "Never" for frames paired by code: pairing, a frame signing in with its token and a frame playing on its session (about once an hour) all count.
- On Windows, a nested folder picked for the slideshow plays instead of answering `FOLDER_EMPTY` ([#89](https://github.com/Sorbh/sora-digital-photo-frame/issues/89)).
- A symlink in the library can't take a frame past its folders, or anyone out of the library: photos, thumbnails and folders are checked where they really are ([#59](https://github.com/Sorbh/sora-digital-photo-frame/issues/59)).

### Removed
- **A note's `audience`** (all frames, or chosen access accounts) and the frame picker on the Notes page: put a note in a folder only those frames show instead. On upgrade, the old notes list moves into the top folder once, and each note that was shown only on some frames is logged by name so it can be filed (see HOOKS.md, Notes).
- Signing in from the slideshow address with `?pin=` and `?family=`: they reach the server and its proxies' logs before the page can hide them. Use `/frame#pin=123456` (hosted: `#pin=123456&family=ABCD-EFGH`). A `?pin=` or `?family=` still in a link is taken out of the address and not used ([#68](https://github.com/Sorbh/sora-digital-photo-frame/issues/68)).

### Fixed
- A sign-in from the slideshow address whose reply comes after a PIN was typed no longer replaces that sign-in: typing a PIN, or signing in another way, stops it ([#68](https://github.com/Sorbh/sora-digital-photo-frame/issues/68)).
- The request log shows photo, thumbnail and folder paths as `/uploads/[photo]`, `/api/images/[photo]/thumbnail` and `/api/folders/[folder]`, without album or file names ([#68](https://github.com/Sorbh/sora-digital-photo-frame/issues/68)).
- A storage error during a PIN sign-in no longer counts as a wrong try for the address or the family ([#67](https://github.com/Sorbh/sora-digital-photo-frame/issues/67)).

### Fixed
- Pairing follow-ups ([#66](https://github.com/Sorbh/sora-digital-photo-frame/issues/66)): a frame polls `POST /api/pair/status` with the secret in the body, so it never sits in a URL a proxy logs (the `GET` is gone); changes are refused from an `http://` page to an `https://` site, as the whole origin is compared; and a device discarded after a late approval is reported to `devicesRemoved` again until the host takes it (see HOOKS.md, Events).

## [2.0.0] - 2026-11-26

### Upgrading from 1.x
- **Photos need a signed-in viewer.** Frames that sign in keep working. If something loads photos without signing in (a home dashboard, say), set `PUBLIC_PHOTOS=true`.
- **No default admin password.** Without `ADMIN_PASSWORD` (or with the old `admin123`), the server makes one up, keeps it in `data/admin-password` and prints it at start.
- **No example session secret.** An example value is replaced with a secret of the server's own, so everyone signs in again once and Google Photos needs connecting again.
- **License is now AGPL-3.0** (was ISC).
- **Custom photo libraries** (`createApp({ library })`): `photoUrl()` must return percent-encoded path segments (see Changed).
- Slideshow links: use `/slideshow#pin=123456`, which never reaches the server or its logs.

### Fixed
- A frame limited to a folder checks and reads the same photo path, so `..` and encoded tricks can't reach other folders ([#42](https://github.com/Sorbh/sora-digital-photo-frame/issues/42)).
- Collecting a pairing is a POST from the browser that started it, and each code is approved once ([#43](https://github.com/Sorbh/sora-digital-photo-frame/issues/43)).
- The family's PIN attempt limit survives correct PINs, restarts and bursts of tries; account PINs must be 4–6 digits ([#44](https://github.com/Sorbh/sora-digital-photo-frame/issues/44)).
- PINs, family codes and tokens no longer reach the server log; server errors answer "Internal server error" ([#45](https://github.com/Sorbh/sora-digital-photo-frame/issues/45)).
- Upload size, uploads at once and the storage quota hold: uploads wait their turn for a slot, Google Photos imports have their own, and a stalled upload is dropped ([#46](https://github.com/Sorbh/sora-digital-photo-frame/issues/46)). `UPLOAD_WAIT_MS` sets how long an upload waits.
- Thumbnails are checked again for each family, and the thumbnail cache can't mix families ([#47](https://github.com/Sorbh/sora-digital-photo-frame/issues/47)).
- Photos in folders with `#`, `?` or `%` in their names load on frames ([#48](https://github.com/Sorbh/sora-digital-photo-frame/issues/48)).
- The frame recovers by itself after Wi-Fi drops, keeping the last photo up, with a Retry button ([#49](https://github.com/Sorbh/sora-digital-photo-frame/issues/49)).
- Typing the pairing code at `/pair` works, and only a real expiry says expired ([#50](https://github.com/Sorbh/sora-digital-photo-frame/issues/50)).
- Library on phones: taps open photos again, hold to select, and a photo options button ([#51](https://github.com/Sorbh/sora-digital-photo-frame/issues/51)).
- The slideshow folder picker fits on phones ([#52](https://github.com/Sorbh/sora-digital-photo-frame/issues/52)), and folders can be chosen with a keyboard or TV remote ([#53](https://github.com/Sorbh/sora-digital-photo-frame/issues/53)).
- Phones: 44px tap targets, notch safe areas, and a dock that fits 320px screens ([#54](https://github.com/Sorbh/sora-digital-photo-frame/issues/54)).
- Muted text reaches 4.5:1 contrast in light and dark mode ([#55](https://github.com/Sorbh/sora-digital-photo-frame/issues/55)).
- Arabic (right to left): folder indent, note spine, and codes that keep their order ([#56](https://github.com/Sorbh/sora-digital-photo-frame/issues/56)).
- TV frames: readable date and captions, slow screen shift against burn-in, and a notice when fullscreen or keep-awake can't work ([#57](https://github.com/Sorbh/sora-digital-photo-frame/issues/57)).
- Accessibility: number keypad for PINs, photo viewer title and buttons, empty-state headings ([#58](https://github.com/Sorbh/sora-digital-photo-frame/issues/58)).

### Added
- Uploads from a phone: camera photos are shrunk in the browser to the 2560px the server stores, so they travel far smaller; when and where a photo was taken is read first and sent along. Photos go one per request with real progress, are tried again when the connection drops, and the screen stays on while they upload. Formats the browser can't read (HEIC on Android) are sent as before.
- The library can be added to a phone's home screen (offered after an upload), and on Android it then appears in the gallery's Share menu, so photos can be sent to it from there.
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
- **No example session secret.** Without `SESSION_SECRET`, or with one of the example values from `.env.example`, `docker-compose.yml` or DOCKER.md, the server makes up a secret and keeps it in `data/session-secret`. Before, `docker compose up` without one signed cookies with `your-secret-key-change-this`, so anyone could forge an admin session. If you used an example value, everyone signs in again once and Google Photos needs connecting again.
- Pairing codes: each address keeps at most 5 waiting codes (an IPv6 /64 counts as one address), and when the queue is full the address holding the most gives up its oldest. Before, codes from a few hundred addresses could fill the queue so no frame could pair.

### Changed
- Uploads can be up to 25 MB each (was 10 MB), so 48 MP phone photos fit. Only the resized copy is stored.
- **License is now AGPL-3.0** (was ISC), with DCO sign-off and a contributor grant (see CONTRIBUTING).
- New uploads are saved as WebP, at most 2560px, with all metadata removed from the file.
- An upload request takes at most 10 files; the admin page sends larger selections in batches.
- Thumbnails are `Cache-Control: private`, and a photo's date and place only go to signed-in viewers.
- Slideshow photo URLs now percent-encode each folder and file name, so folders with `#`, `?` or `%` load ([#48](https://github.com/Sorbh/sora-digital-photo-frame/issues/48)). **Custom libraries** (`createApp({ library })`): `photoUrl()` must return each path segment percent-encoded. A library that already encoded its segments keeps doing that and needs no change, but a `LocalPhotoLibrary` subclass that encoded the result of `super.photoUrl()` must stop, since that value is now encoded already; one that returned raw names should now encode them, for example with `PhotoLibrary.uploadsUrl(adminPath)`. The slideshow's `?folder=` is no longer decoded a second time, so a caller that encoded it twice must now encode it once.

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
