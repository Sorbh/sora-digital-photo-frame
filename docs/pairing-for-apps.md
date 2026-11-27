# Pairing for apps

How a native app (Android, Android TV, iOS, tvOS) acts as a Sora Frame screen: it asks for a pairing code, the owner approves it from their phone, and the app plays the library's photos from then on. Everything here is the same HTTP API the web slideshow (`/frame`) uses, so it works the same against the hosted service and a self-hosted server.

An app that does this is also found by **Sora Frame nearby**: when the owner opens `/pair` (or the hosted screens page) on the same home internet connection, your screen's code is offered as one tap, with the name and kind you sent.

## Basics

- **Base URL:** `https://soraframe.online` for the hosted service, or the self-hosted server's address (for example `http://192.168.1.20:3000`). Use HTTPS whenever the server has it; the hosted service is HTTPS only.
- **Keep cookies.** Use one cookie jar for the server, and keep it across requests (Android: OkHttp `CookieJar` or `java.net.CookieManager`; iOS: `HTTPCookieStorage.shared`, which `URLSession` uses by default). Pairing sets a cookie that collecting needs, and signing in sets the session cookie every later request needs.
- **JSON** in and out: send `Content-Type: application/json`.
- **The same-origin check:** the server refuses changes (`POST`, `PUT`, `DELETE`) a web page on another site sends, by their `Sec-Fetch-Site` or `Origin` header, with 403 `CROSS_SITE`. Native HTTP clients send neither, so they pass. Don't add an `Origin` header yourself. (A WebView page loaded from your own origin does send one, and is refused: call the API natively.)
- **Errors** are JSON with an `error` or `message` and usually a `code`. Behind a proxy, a 5xx may not be JSON at all: treat it as "try again later".

## 1. Ask for a code

```
POST /api/pair/start
Content-Type: application/json

{ "name": "Living room TV", "kind": "tv", "platform": "Android TV", "app": "sora-android/1.2.0", "model": "BRAVIA XR" }
```

The body and all its fields are optional. Send the OS device name and hardware model at pairing and again at sign-in. The owner sees these details as a hint and can choose a separate screen name when approving the pairing.

| Field | What to send | Kept as |
|---|---|---|
| `name` | The OS device name, with the model as a fallback | Plain text, at most 40 characters (control and invisible characters removed, longer text cut) |
| `kind` | `tv`, `phone`, `tablet`, `browser` or `frame` | Anything else becomes `null` |
| `platform` | A short label: `Android TV`, `Android`, `iOS`, `tvOS`, `Fire TV` | Plain text, at most 30 characters |
| `app` | Your app and version, `sora-android/1.2.0` | Plain text, at most 40 characters |
| `model` | The hardware model, for example `BRAVIA XR` or `Pixel 7` | Plain text, at most 40 characters |

On Android, read the name with `Settings.Global.getString(contentResolver, Settings.Global.DEVICE_NAME)` and get the model from `Build.MODEL`. [Android Settings.Global documentation](https://developer.android.com/reference/android/provider/Settings.Global#DEVICE_NAME)

On iOS, use `UIDevice.current.name` when the user-assigned name is available. iOS 16 and later require Apple's user-assigned device name entitlement to access it. Fall back to the model when the app lacks the entitlement. [Apple UIDevice.name documentation](https://developer.apple.com/documentation/uikit/uidevice/name)

**200:**

```json
{
  "success": true,
  "code": "K7P4QX",
  "secret": "9f2c…48 hex characters",
  "expiresAt": 1795780800000,
  "url": "https://soraframe.online/pair?code=K7P4QX",
  "qr": "<svg …>…</svg>"
}
```

- Show the **code** as `K7P-4QX` (the first three characters, a dash, the last three), large. Codes use only `A–Z` and `2–9` without `0`, `O`, `1`, `I` and `L`, so they read well across a room.
- Show a **QR code of `url`** beside it. `qr` is the same QR as an SVG, if you can draw one; most apps encode `url` with their own QR library.
- Keep `code` and `secret` in memory. The `secret` stays on the device: never show it, log it or put it in a URL.
- `expiresAt` is in milliseconds since 1970. A code lasts **10 minutes**.
- The answer also sets a cookie, `photoframe.pairing.K7P4QX` (`HttpOnly`, `Path=/api/pair`, 10 minutes). Only the cookie jar that has it can collect the pairing in step 3.

**Refusals:**

| Status | Why | What to do |
|---|---|---|
| 429 | More than 20 codes from one network in 10 minutes | Wait a minute or two, then ask again |
| 503 | Too many screens are pairing on the server at once | Try again in a minute |
| 500 | The server failed | Try again in a minute |

Ask for a new code only when the old one has expired. Each network keeps at most 5 waiting codes: a sixth pushes out its oldest, whose screen then sees `expired`.

## 2. Wait for the owner

Poll every **2 seconds** (back off to 5 seconds after a network error):

```
POST /api/pair/status
{ "code": "K7P4QX", "secret": "9f2c…" }
```

**200:** `{ "success": true, "status": "waiting" }`, where `status` is:

- `waiting`: the owner hasn't approved it yet. Keep polling.
- `ready`: approved. Go to step 3.
- `expired`: the code ran out, was cancelled or pushed out, or the secret is wrong. Go back to step 1 for a new code.

Also start again by yourself once `expiresAt` has passed.

Polling is also how **Sora Frame nearby** knows your screen is still showing its code. A code drops out of nearby after 10 seconds without a poll.

When the app closes while waiting for approval, send a best-effort cancellation so the code disappears immediately. Keep polling if the display merely dims or the tab becomes hidden.

```
POST /api/pair/cancel
{ "code": "K7P4QX", "secret": "9f2c…" }
```

**200:** `{ "success": true }` for all pairing states and credentials. The server removes an active waiting code only when its secret matches and approval has yet to start. An approval underway or ready for collection is preserved. In a browser, send the JSON body as an `application/json` blob using `navigator.sendBeacon` on `pagehide`. If a waiting page returns from the back-forward cache, start with a fresh code.

## 3. Collect the pairing

```
POST /api/pair/collect
{ "code": "K7P4QX", "secret": "9f2c…" }
```

With the pairing cookie from step 1 in the jar. **200**, once approved:

```json
{
  "success": true,
  "status": "approved",
  "token": "dev_3fa94c0b12de.Jc0…43 characters",
  "device": { "id": "dev_3fa94c0b12de", "name": "Living room TV", "language": null },
  "account": { "id": "acc_…", "name": "Living room TV", "assignedFolders": [] }
}
```

- Store `token` **securely and for good**: Android Keystore (or `EncryptedSharedPreferences`), iOS Keychain. It is the screen's only credential; the server keeps just a hash of it.
- The answer also sets the session cookie (`photoframe.sid`), so the app is signed in now. It clears the pairing cookie.
- `device.name` is the name the owner gave the screen. `device.language`, when not `null`, is the language they chose for it (`en`, `es`, `fr`, `de`, `pt-BR`, `it`, `nl`, `hi`, `ja`, `zh-CN`, `ar`).
- A pairing is handed over **once**. If the server fails while handing it over, it keeps it: poll status again, and while it says `ready`, collect again. If the answer went out but never reached you (a dropped connection), status says `expired`: start again at step 1, and the owner approves the new code (the screen paired the first time shows up in their list and can be removed).
- `{ "success": true, "status": "waiting" }` or `"expired"` here mean what they mean in step 2. `expired` also answers when the pairing cookie is missing: check your cookie jar.

## 4. Later launches: sign in with the token

```
POST /api/auth/device
{ "token": "dev_3fa94c0b12de.Jc0…", "name": "Living room TV", "kind": "tv", "platform": "Android TV", "app": "sora-android/1.2.0", "model": "BRAVIA XR" }
```

Include the current advertisement fields alongside the token so a new name or app version reaches the owner. A sign-in with at least one valid field replaces the previous advertisement if it changed. A token-only request keeps the existing details.

| Status | Answer | What to do |
|---|---|---|
| 200 | `{ "success": true, "account": { "id", "name", "assignedFolders" }, "device": { "id", "name", "language" } }`, and the session cookie | Play (step 5) |
| 401 | `{ "code": "DEVICE_UNKNOWN" }` | The owner removed this screen. Delete the token and go back to step 1 |
| 403 | `{ "code": "SCREEN_PAUSED", "message": "…" }` (hosted service) | The owner's plan has fewer screens than they have. Show `message` calmly, full screen; keep the token; try again every few minutes |
| 429 | `{ "code": "RATE_LIMITED" }` | Too many failed sign-ins from this network. Wait, then try again; keep the token |
| 5xx, no connection | | Keep the token, and try again shortly |

## 5. Playing

Sessions last 24 hours, so a screen left on is signed out now and then. Every request below needs the session cookie.

- **Disconnection:** A removed screen gets 401 `DEVICE_REMOVED` on its next API request, or HTTP 401 when it requests a photo under `/uploads`. On a 401 from any call, stop playback, delete the stored device token and return to pairing (step 1).
- **The session check:** `GET /api/auth/session` every **15 seconds**, as the web frame does. `{ "authenticated": true, "account": {…} }` means play on. On a 200 with `"authenticated": false`, try signing in again with the token (step 4). A 403 `SCREEN_PAUSED` can come from any request: show its message as in step 4.
- **The next photo:** `GET /api/images/next?folder=<folder>&after=<last id>` (both optional: no `folder` plays every folder the screen may see; `after` continues a folder's play order from the last photo shown). **200:** `{ "success": true, "image": { "id", "type", "url", "thumbnail", "folder", … } }`. `type` is `image` (load `url`, with the session cookie) or `snap` (a collage, described in `image.snap`). On a remote encrypted library the image also has `rawUrl` and `mimeType`, and the keys come from `GET /api/frame/keys?ids=<id>`; most apps can ignore that and load `url`. A 404 or 403 for a chosen folder means it is gone or no longer this screen's: drop the folder and play all.
- **Folders** to choose from: `GET /api/folders` (the top level) and `GET /api/folders/<path>`, already limited to the screen's own folders.
- **Notes** to show between photos: `GET /api/notes/active?folder=<folder>`.
- **Language:** `PUT /api/device/language { "language": "de" }` saves the screen's own choice.
- Show each photo for the library's interval (15 seconds by default).

## Same network

"Sora Frame nearby" matches the screen and the owner's phone when they reach the server from **the same public IPv4 address**, or from **the same IPv6 /64**. That is what a home internet connection gives every device on it, so nothing more is needed:

- No LAN broadcast, mDNS or local network permission: the app only talks to the server.
- An app on IPv4 and a phone on IPv6 (or the other way round) don't match. The owner then scans the QR code or types the code, as always.
- On a phone's mobile data, or behind a VPN, the app has another address and isn't found nearby.
- Neighbours behind one shared address could see each other's codes; the windows above, the cap of three, the code check on the owner's phone and the owner-only rule limit that.

The server never keeps or answers anyone's address: only a keyed hash of it, with the waiting code.

**Not implemented:** native discovery on the local network (DNS-SD / Bonjour, service type `_soraframe._tcp`), for an owner's app to find screens with no server in the middle. If it comes, it will be in addition to the above, not instead.

## Time limits, in short

| | |
|---|---|
| A pairing code | 10 minutes |
| Offered by Sora Frame nearby | made in the last 10 minutes and polled in the last 60 seconds; at most 3 per network |
| Status polling | every 2 seconds |
| The session check | every 15 seconds |
| A session | 24 hours; sign in again with the token |
| The device token | until the owner removes the screen |
