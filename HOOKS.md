# Hooks

`createApp()` in `server/app.js` builds the app. With no options it runs the normal self-hosted install. Each option below replaces one part, so another deployment can run this same code without changing it.

These options are a public contract. Treat a change to a name, an argument or a return value as a breaking change: note it in the pull request and the changelog.

| Option | Shape | Default | Defined in |
|---|---|---|---|
| `library` | `PhotoLibrary` subclass. Its `photoUrl(adminPath)` must return a URL with each path segment percent-encoded, since folder and file names can hold `#`, `?` and `%` (`PhotoLibrary.uploadsUrl(adminPath)` builds one for the `/uploads` route). May also offer `rawUrl(adminPath)`, which lets frames fetch encrypted photos from remote storage and decrypt them in the browser | Local uploads folder | `server/library/PhotoLibrary.js` |
| `dataStore` | `DataStore` subclass: `get`, `set`, `update` | Local data files | `server/store/DataStore.js` |
| `resolveTenant` | `async (req) => ({ id, plan })` or `null` | One `default` tenant | `server/context.js` |
| `auth` | `{ requireAuth, requireGuest, requireViewer }` middleware, all optional | Admin password session | `server/middleware/auth.js` |
| `quota` | `{ canAdd(bytes) => ({ ok, message }) }` for the current tenant | Unlimited | `server/services/quotaService.js` |
| `events` | `{ devicePaired, devicesRemoved, familyCodeSet }`, may be async; if one throws, the action fails, with one exception (see [Events](#events)) | None | `server/events.js` |
| `keys` | `{ currentKey(), getKey(id) }`, may return promises | `PHOTO_ENCRYPTION_KEY`, or no encryption | `server/crypto/keys.js` |
| `sessionStore` | `express-session` store | In memory | `server/app.js` |
| `pinSignIn` | `false` turns off PIN sign-in for frames | On | `server/app.js` |
| `trustProxy` | Express `trust proxy` setting | `TRUST_PROXY`, else `1` | `server/app.js` |
| `publicPhotos` | `true` serves photos, thumbnails, folders and notes without a viewer check (`requireViewer`) | Off (`PUBLIC_PHOTOS=true` turns it on) | `server/app.js` |
| `familyCode` | `true`: a PIN sign-in also sends the family's code (shown on the Access page), so `resolveTenant` can find the family from it. `familyCodeSet({ code, previous, tenantId })` keeps the host's index | Off | `server/services/familyCodeService.js` |
| `beforeRoutes` | `(app) => {}`, runs after core middleware and before core routes | None | `server/app.js` |

## Events

Each handler is awaited. If it throws, the action that sent it fails and is undone, so an index kept by the host never misses a change.

One removal can't be undone that way: a device made by an approval that ends after its code expired (including while its new account was being finished), or whose new account couldn't be finished, is removed even if `devicesRemoved` throws, since no frame can ever use it. Its id is first kept in the library's data store, in the `device-removals` document; then the device is removed and `devicesRemoved` is sent. Until the host takes it, it's sent again:

- after 30 seconds, 2 minutes, 10 minutes and 1 hour, while the server keeps running;
- after the library's next `devicePaired` or `devicesRemoved` that goes through, which also covers a restart. This runs in the background, so a slow host never holds up a pairing, a PIN sign-in or a removal;
- with the next discarded device, which sends every id still kept.

If the `device-removals` document can't be written, `devicesRemoved` is sent first and the device is removed only once the host has it; if that throws too, the device stays.

So `devicesRemoved` may arrive late, more than once for the same device, and with several devices from earlier removals at once. Treat it as "these ids are gone": removing an id the index doesn't have must succeed. A custom `dataStore` must accept the `device-removals` document.

## Adding a hook

Keep hooks generic. A hook should make sense to anyone running this code, and its default must leave a self-hosted install unchanged. Prefer `quota` over `freePlanLimit`: the core asks the question, and the deployment decides the answer.
