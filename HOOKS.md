# Hooks

`createApp()` in `server/app.js` builds the app. With no options it runs the normal self-hosted install. Each option below replaces one part, so another deployment can run this same code without changing it.

These options are a public contract. Treat a change to a name, an argument or a return value as a breaking change: note it in the pull request and the changelog.

| Option | Shape | Default | Defined in |
|---|---|---|---|
| `library` | `PhotoLibrary` subclass. May also offer `rawUrl(adminPath)`, which lets frames fetch encrypted photos from remote storage and decrypt them in the browser | Local uploads folder | `server/library/PhotoLibrary.js` |
| `dataStore` | `DataStore` subclass: `get`, `set`, `update` | Local data files | `server/store/DataStore.js` |
| `resolveTenant` | `async (req) => ({ id, plan })` or `null` | One `default` tenant | `server/context.js` |
| `auth` | `{ requireAuth, requireGuest, requireViewer }` middleware, all optional | Admin password session | `server/middleware/auth.js` |
| `quota` | `{ canAdd(bytes) => ({ ok, message }) }` for the current tenant | Unlimited | `server/services/quotaService.js` |
| `events` | `{ devicePaired, devicesRemoved, familyCodeSet }`, may be async; if one throws, the action fails | None | `server/events.js` |
| `keys` | `{ currentKey(), getKey(id) }`, may return promises | `PHOTO_ENCRYPTION_KEY`, or no encryption | `server/crypto/keys.js` |
| `sessionStore` | `express-session` store | In memory | `server/app.js` |
| `pinSignIn` | `false` turns off PIN sign-in for frames | On | `server/app.js` |
| `publicPhotos` | `true` serves photos, thumbnails, folders and notes without a viewer check (`requireViewer`) | Off (`PUBLIC_PHOTOS=true` turns it on) | `server/app.js` |
| `familyCode` | `true`: a PIN sign-in also sends the family's code (shown on the Access page), so `resolveTenant` can find the family from it. `familyCodeSet({ code, previous, tenantId })` keeps the host's index | Off | `server/services/familyCodeService.js` |
| `beforeRoutes` | `(app) => {}`, runs after core middleware and before core routes | None | `server/app.js` |

## Adding a hook

Keep hooks generic. A hook should make sense to anyone running this code, and its default must leave a self-hosted install unchanged. Prefer `quota` over `freePlanLimit`: the core asks the question, and the deployment decides the answer.
