# Hooks

`createApp()` in `server/app.js` builds the app. With no options it runs the normal self-hosted install. Each option below replaces one part, so another deployment can run this same code without changing it.

These options are a public contract. Treat a change to a name, an argument or a return value as a breaking change: note it in the pull request and the changelog.

| Option | Shape | Default | Defined in |
|---|---|---|---|
| `library` | `PhotoLibrary` subclass. Its `photoUrl(adminPath)` must return a URL with each path segment percent-encoded, since folder and file names can hold `#`, `?` and `%` (`PhotoLibrary.uploadsUrl(adminPath)` builds one for the `/uploads` route). May also offer `rawUrl(adminPath)`, which lets frames fetch encrypted photos from remote storage and decrypt them in the browser. Only `createFolder` makes folders: `addPhoto`, `movePhoto` and `writeItem` into a missing folder (deleted meanwhile, even mid-write) must throw `PhotoLibrary.folderNotFoundError()` (404 `FOLDER_NOT_FOUND`) and leave it missing. Storage with symlinks should offer `realPath(adminPath)`: the admin path a path really leads to, or `null` when it leads out of the library; frames' folder limits and `MAX_FOLDER_DEPTH` are checked there. Notes are `*.note.json` files in folders, stored like snaps (`*.snap.json`): `listItems`, `readItem`, `writeItem`, `movePhoto` and `deletePhoto` must handle them, and so must moving, renaming and deleting a folder. `listFolder` should give them type `'note'`, and `allPhotos` must never return them: a note is not a photo (see [Notes](#notes)) | Local uploads folder | `server/library/PhotoLibrary.js` |
| `dataStore` | `DataStore` subclass: `get`, `set`, `update`. `folder-settings:<folder>` documents (a folder's play order) belong to that photo folder: writing one must not create the folder, and throws 404 `FOLDER_NOT_FOUND` when it is gone. Notes are not kept here any more but in the library, as `*.note.json` files like `*.snap.json`; the old `notes` document is read once at start, then emptied, with a copy in `notes-before-folders` (see [Notes](#notes)) | Local data files | `server/store/DataStore.js` |
| `resolveTenant` | `async (req) => ({ id, plan })` or `null` | One `default` tenant | `server/context.js` |
| `auth` | `{ requireAuth, requireGuest, requireViewer }` middleware, `scope(req)` (see [Scope](#scope)) and `isScreenPaused(deviceId, { tenantId })` (see [Paused screens](#paused-screens)), all optional | Admin password session, which sees and changes everything | `server/middleware/auth.js` |
| `quota` | `{ canAdd({ items, bytes, screens }, context) => ({ ok, message }) }` for the current tenant. **Changed in 3.0.0** (it took `bytes` alone): see [Quota](#quota) | Unlimited | `server/services/quotaService.js` |
| `events` | `{ devicePaired, devicesRemoved, familyCodeSet }`, may be async; if one throws, the action fails, with one exception (see [Events](#events)) | None | `server/events.js` |
| `keys` | `{ currentKey(), getKey(id) }`, may return promises | `PHOTO_ENCRYPTION_KEY`, or no encryption | `server/crypto/keys.js` |
| `sessionStore` | `express-session` store | In memory | `server/app.js` |
| `pinSignIn` | `false` turns off PIN sign-in: frames connect only by their pairing code (see [Frames that connect by code](#frames-that-connect-by-code)) | On (`PIN_SIGN_IN=off` turns it off) | `server/app.js` |
| `trustProxy` | Express `trust proxy` setting | `TRUST_PROXY`, else `1` | `server/app.js` |
| `publicPhotos` | `true` serves photos, thumbnails, folders and notes without a viewer check (`requireViewer`) | Off (`PUBLIC_PHOTOS=true` turns it on) | `server/app.js` |
| `familyCode` | `true`: a PIN sign-in also sends the family's code (shown on the Access page), so `resolveTenant` can find the family from it. `familyCodeSet({ code, previous, tenantId })` keeps the host's index | Off | `server/services/familyCodeService.js` |
| `beforeRoutes` | `(app) => {}`, runs after core middleware and before core routes. Routes it adds under `/api` answer `Cache-Control: no-store` with no ETag, like the core's own, unless they set their own `Cache-Control` | None | `server/app.js` |
| `brand` | `{ name }`: the product's name in the header's wordmark, page titles and labels, on every page (see [Header](#header)) | `{ name: 'Sora Frame' }` | `server/views/pages.js` |
| `accountUrl` | A path on this site (`/account`) or an http(s) address: the host's page about the person's account. The header shows an Account icon linking to it, and Access leaves the header and phone tab bar (see [Header](#header)) | None: Access stays in the header for the owner | `server/views/pages.js` |

## Quota

The core asks `quota.canAdd(request, context)` before it adds anything to a library, and refuses when the answer isn't `{ ok: true }`. It runs for the current tenant (`currentTenant()` in `server/context.js`). The default allows everything, so a self-hosted install has no limits.

`request` always has all three fields, as numbers:

| Field | What it is |
|---|---|
| `items` | How many countable things are being added (see below) |
| `bytes` | How much the library grows, counted before encryption at rest, so turning on `PHOTO_ENCRYPTION_KEY` doesn't change what counts. May be 0, or negative when something shrinks |
| `screens` | `1` when a new screen joins the library, else `0` |

`context` is an optional second argument with facts the core already has, so the hook doesn't need to look them up:

| Field | Sent with | What it is |
|---|---|---|
| `screensInUse` | Screen requests only (`screens: 1`) | How many screens the library has now, without the new one. It is counted inside the same lock as the check, so it is always exact. An index the host keeps from `devicePaired` is only updated after the lock is released, so it can be one behind when two pairings run back to back |

Other requests get no `context` (`undefined`). New fields may be added later, so read only the ones you need.

What each action asks for:

| Action | `items` | `bytes` | `screens` |
|---|---|---|---|
| Upload a photo | 1 | its size | 0 |
| Upload an animated GIF (still animated after conversion to WebP) | 5 | its size | 0 |
| Import from Google Photos | 1 per photo, 5 per animated one | its size | 0 |
| Create a snap | 1 | its size | 0 |
| Create a note | 1 | its size | 0 |
| Save a snap or note again | 0 | how much it grew | 0 |
| Rotate a photo | 0 | how much it grew | 0 |
| Pair a new screen (QR code or a new PIN sign-in) | 0 | 0 | 1 |
| Rename, move or delete anything | not asked | | |

- **"Is there any room at all?"** Before converting an upload, and before downloading each photo of an import, the core asks `{ items: 1, bytes: 1, screens: 0 }`, so a full library is refused before the work starts.
- **Nothing added, nothing asked.** A save that adds no item, no bytes and no screen (a snap or rotated photo that got smaller, say) isn't asked about. Neither is a screen signing in again, by its token, by its PIN with its token, or by its session: it's the same screen.
- **One at a time.** Uploads, imports, snaps, notes and rotations ask and save in turn for each tenant, so two can't both take the last place. A new screen is asked inside the same lock as the `MAX_SCREENS` check, so two new screens can't both take the last one. Count what is really stored when you answer, not what you were asked before.
- **Refusals.** For photos, snaps and notes, `{ ok: false, message }` is answered 413 `QUOTA_EXCEEDED` with your `message`. For a screen, it's 403 `SCREEN_LIMIT` with your `message` (and no `limit`, which only `MAX_SCREENS` sends); the frame shows your `message` as it is, so send it in the person's language. To send your own status and code instead, throw an error with `status` (4xx), `code` and optional `vars`: they reach the browser as they are.
- **Notes** are files in folders like snaps (see [Notes](#notes)), and ask the same way: a new note `{ items: 1, bytes }`, saving one again only its growth. Moving a note, or the one-time move of old notes into the top folder, isn't asked about.

For example, a plan that counts photos and screens:

```js
createApp({
  quota: {
    async canAdd({ items, screens }, context) {
      const plan = await plans.forTenant(currentTenant().id); // { items: 100, screens: 1 }
      if (screens > 0 && context.screensInUse + screens > plan.screens) {
        return { ok: false, message: `Your plan has ${plan.screens} screen. Upgrade to add more.` };
      }
      if (items > 0 && (await countItems()) + items > plan.items) {
        return { ok: false, message: `You've reached ${plan.items} photos. Upgrade, or delete some.` };
      }
      return { ok: true };
    }
  }
});
```

### Upgrading from 2.x

`canAdd(bytes)` is now `canAdd({ items, bytes, screens })`. A 2.x hook that compares the argument with a number gets an object, and will refuse everything (or, worse, allow everything). Change it to read `bytes` from the object:

```js
// 2.x
async canAdd(bytes) { return { ok: used() + bytes <= LIMIT }; }

// 3.0
async canAdd({ bytes }) { return { ok: used() + bytes <= LIMIT }; }
```

If your hook only limits bytes, also return `{ ok: true }` when `bytes` is 0 or less: a new screen now asks with `bytes: 0`.

The core's own `ask(request, context)`, `assertCanAdd(request, context)` and `addWithinQuota(request, write, context)` take the same object, pass a `context` on to the hook unchanged, and throw a `TypeError` when given a number.

## Scope

`auth.scope(req)` says what the signed-in person may do, for a library shared with people who shouldn't see or change all of it. Without it, or when it returns `null`, nothing is limited: that's the self-hosted admin.

Otherwise it returns `{ folders, canEdit, isOwner }`:

| Field | Meaning |
|---|---|
| `folders` | The folders they can see, relative to the uploads folder, the same form as PIN accounts' `assignedFolders`: `"Family"` or `"Family/Beach"`. Each includes everything inside it. `null` means all folders; an empty list means none. |
| `canEdit` | `true` to upload, delete, rotate and move photos, make, delete and reorder folders, make and edit snaps and notes, and import from Google Photos. Otherwise every one of those answers 403 `VIEW_ONLY`. |
| `isOwner` | `true` for the library's owner. Otherwise these answer 403 `OWNER_ONLY`: access accounts, the family code, devices, approving a pairing (and the `/access-accounts` and `/pair` pages), and connecting or disconnecting Google Photos. |

- **It must answer at once,** not with a promise: it's asked many times per request. Read what your `requireAuth` already looked up, e.g. from `req` or the session. A promise, a thrown error or any other value locks everything (no folders, no changes, not the owner).
- **Only `true` grants** `canEdit` and `isOwner`, and only `null` means all folders; anything else that isn't a list of names means no folders.
- **Folders work as they do for PIN frames** (`server/utils/viewerAccess.js`). Folders above theirs can be opened to reach them, and show only what leads there. Symlinks are followed to where they really lead.
- **Reads** outside their folders answer 404, as if the photo or folder didn't exist. This covers folder lists, thumbnails, the next and random photo, `/uploads`, snaps and notes.
- **Changes** outside them answer 403 `OUTSIDE_FOLDERS`. A move checks where each photo comes from and where it goes. A snap or note checks its folder (both ends when a note moves) and its photos. A folder can be made, reordered or deleted only inside theirs, and one of their own folders can't be deleted.
- **Notes** are scoped like photos: only notes in their folders are listed or shown, with only the photos they can see. Notes in the top folder go to every frame, so someone limited to some folders can't see, make, change or delete them.
- **Photos they can't see are never lost.** A snap or note shows them only the photos they can see; when they save it, the others stay where they were, and their own list fills the other places.
- `GET /api/features` returns the scope as `scope`, so pages hide what the person can't use. The server refuses it either way.
- `server/tests/peopleScope.test.js` holds the decision for every API route, and fails when a route is added without one.

## Events

Each handler is awaited. If it throws, the action that sent it fails and is undone, so an index kept by the host never misses a change.

One removal can't be undone that way: a device made by an approval that ends after its code expired (including while its new account was being finished), or whose new account couldn't be finished, is removed even if `devicesRemoved` throws, since no frame can ever use it. Its id is first kept in the library's data store, in the `device-removals` document; then the device is removed and `devicesRemoved` is sent. Until the host takes it, it's sent again:

- after 30 seconds, 2 minutes, 10 minutes and 1 hour, while the server keeps running;
- after the library's next `devicePaired` or `devicesRemoved` that goes through, which also covers a restart. This runs in the background, so a slow host never holds up a pairing, a PIN sign-in or a removal;
- with the next discarded device, which sends every id still kept.

If the `device-removals` document can't be written, `devicesRemoved` is sent first and the device is removed only once the host has it; if that throws too, the device stays.

So `devicesRemoved` may arrive late, more than once for the same device, and with several devices from earlier removals at once. Treat it as "these ids are gone": removing an id the index doesn't have must succeed. A custom `dataStore` must accept the `device-removals` document.

## Notes

A note is a `<name>.note.json` file in a library folder, the same way a snap is a `<name>.snap.json` file. A custom `library` must store, list, move and delete these files as it does snaps, and moving, renaming or deleting a folder must take them along.

- **Notes in the top folder** (`uploads/`) show on every frame.
- **A note in another folder** shows only on frames that may see that folder (the helpers in `server/utils/viewerAccess.js`), and, when a frame plays one chosen folder, only if it is in that folder.
- **A note is never a photo:** it is not in `allPhotos`, the frame's rotation or a folder's photo count. The library grid shows it as its own tile (`type: 'note'`).

**Upgrading:** before 3.0, notes were one list in the `notes` data document, each with an `audience` (all frames, or some access accounts). At start, `initializeUploads()` moves that list into the top folder, one file per note, keeps a copy in the `notes-before-folders` document and empties `notes`, so it runs once; running it again does nothing, and a note already moved (same id) is never doubled. `audience` is dropped. A note that was shown only on some frames is logged with its title, so the admin can move it into a folder only those frames show. A host that doesn't call `initializeUploads()` can call `migrateNotes()` from `server/app.js` for each tenant, inside `runWithTenant` (`server/context.js`).

## Frames that connect by code

Many frames are TVs with only a remote, so a host may want nothing ever typed on a frame. `createApp({ pinSignIn: false })`, or `PIN_SIGN_IN=off`, does that:

- The frame shows only its pairing code and QR code, never a PIN pad. The server tells the page before anything loads (`<html data-pin-sign-in="off">`), and `GET /api/auth/session` says `pinSignIn: false` too.
- `POST /api/auth/pin` answers 404 with code `PIN_DISABLED`, and a `/slideshow#pin=` link is taken out of the address and not used.
- The Access page shows access accounts as **Screens**: a name and its folders, with no PIN field. `GET /api/access-accounts` and `GET /api/features` say `pinSignIn: false`. A screen made there or by pairing gets no PIN at all, and a PIN sent to `POST`/`PUT /api/access-accounts` is not kept.

Whether PIN sign-in is on or off, the owner adds a frame by scanning its QR code (`/pair`) or with **Add a screen** on the Access page: type the code the frame shows (any case, with or without the dash or spaces), name the screen, pick an existing screen or a new one and its folders. Both use `GET /api/admin/pair/:code` and `POST /api/admin/pair/:code/approve`.

### Paused screens

A host can refuse a frame whose screen it has paused (a plan with fewer screens, say). Answer any of the frame's requests (`/api/*`, `/uploads/*`, including `GET /api/auth/session` and `POST /api/auth/device`) with 403 and:

```json
{ "success": false, "code": "SCREEN_PAUSED", "message": "This screen is paused. Ask the owner to upgrade." }
```

The frame then shows a calm full-screen card with that message (`error` is used if there is no `message`, and a translated line if neither). It keeps its token, asks again every 3 minutes (`POST /api/auth/device` with its token, else `GET /api/folders`), and reloads by itself once the answer is anything else, so it starts playing again after an upgrade with nobody touching it. The slideshow page and its scripts themselves must still load.

To show the owner which screens are paused, give the auth provider `isScreenPaused(deviceId, { tenantId })`. It runs for the library's tenant, once per screen when the Access page lists them, and may return a promise:

- `true` means paused: `GET /api/admin/devices` gives that screen `paused: true`, and the Access page shows a "Paused" badge with "Paused: your plan allows fewer screens. Upgrade to turn it back on." in place of when it was last seen.
- Anything else, a thrown error or a rejected promise means not paused (an error is logged), so the list still loads.
- Without the hook no screen is ever `paused`, as self-hosted.

It only changes what Access shows. Refusing the paused frame itself is still the host's 403 `SCREEN_PAUSED` above.

## Header

Every page that looks after a library (`/admin`, `/access-accounts`, `/notes`, `/snap`, `/pair` and the "only for the owner" page) has the same top bar and phone tab bar. The page's HTML in `server/public` only marks where they go (`<!-- sora:header -->`, `<!-- sora:tabbar -->`); the server draws them when it sends the page (`server/views/pages.js`), so every page has the same brand, the same actions in the same order, and the page you're on marked (`aria-current="page"`). `js/appHeader.js` runs the theme and Log out buttons on every page.

The top bar, in order:

| Part | When |
|---|---|
| Brand (`.sora-wordmark[data-brand]`), linking to `/admin` | Always |
| Host slot: `<div class="topbar-slot" data-host-slot>` | Always. Holds the page's name (`.sora-eyebrow`) until the host replaces what's in it, e.g. with a library switcher |
| Library | Not on the library |
| Access (`data-owner-only`, hidden by `js/scope.js` for anyone but the owner) | Without `accountUrl` |
| Slideshow | Always |
| Settings (`#settingsBtn`) | The library |
| Theme (`#themeToggle`) | Always |
| Account (`[data-header-item="account"]`) | With `accountUrl` |
| Log out (`#logoutBtn`) | Always |

The phone tab bar has Library, Access (same rule), the page's own round button (the library's +, Access's Add a screen, Notes' New note), Slideshow and, on the library, Settings. Each item is marked `data-header-item` (top bar) or `data-tab` (tab bar), so a host's script can find it without depending on its place.

- **`brand: { name }`** goes in the wordmark, in `<html data-brand>`, and in the title as the page arrives. Translations that name the product say `{brand}`, which `js/i18n.js` fills in from `<html data-brand>`. The sign-in page and the frame's slideshow get the brand too. A `name` that isn't a non-empty string throws when `createApp` runs.
- **`accountUrl`** must be a path on this site (`/account`, not `//host`) or an `http(s)://` address; anything else throws when `createApp` runs. The `/access-accounts` page itself is still there, for the host to link to.
- **A host that changes a page** (adds its own scripts, say) must start from the rendered page, not the file: `require('<core>/server/views/pages').renderPage('admin.html')` returns it with the header, tab bar and brand, for the options `createApp` was given. Call it per request, after `createApp`. `renderHeader(pageId)` and `renderTabbar(pageId)` return the two parts alone. To put something beside the brand, replace the children of `[data-host-slot]`; to add a button, insert it into `.topbar-actions` (before `#logoutBtn` keeps Log out last).

## Adding a hook

Keep hooks generic. A hook should make sense to anyone running this code, and its default must leave a self-hosted install unchanged. Prefer `quota` over `freePlanLimit`: the core asks the question, and the deployment decides the answer.
