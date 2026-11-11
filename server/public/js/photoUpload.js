/**
 * PhotoUpload - gets photos from a phone to the server over a slow or shaky connection.
 *
 * - Shrinks camera photos in the browser to the size the server stores anyway
 *   (utils/displayCopy.js), so a 6 MB photo travels as a few hundred KB.
 * - Reads when and where each photo was taken first, because shrinking drops it.
 * - Sends one photo per request, two at a time, with real progress, and tries a
 *   photo again when the connection drops.
 * - Keeps the screen on while it works: phones pause uploads when they lock.
 * - Takes photos shared from the phone's gallery (sw.js) and offers to put the
 *   library on the home screen.
 */
(function () {
    const MAX_EDGE = 2560; // the server stores nothing larger
    const SMALL = 600 * 1024; // not worth shrinking
    const SHARE_CACHE = 'sora-shared-photos';
    const INSTALL_DISMISSED = 'sora-install-dismissed';
    const EXIF_FIELDS = ['DateTimeOriginal', 'CreateDate', 'GPSLatitude', 'GPSLongitude', 'GPSLatitudeRef', 'GPSLongitudeRef'];
    const RETRY_STATUS = [0, 408, 429, 500, 502, 503, 504];
    const RETRY_WAITS = [1000, 3000, 8000];

    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const kindOf = file => file.type || (/\.(heic|heif)$/i.test(file.name) ? 'image/heic' : '');

    let exifrLoading;
    function loadExifr() {
        exifrLoading = exifrLoading || new Promise(resolve => {
            if (window.exifr) return resolve(window.exifr);
            const script = document.createElement('script');
            script.src = '/js/vendor/exifr.js';
            script.onload = () => resolve(window.exifr || null);
            script.onerror = () => resolve(null);
            document.head.appendChild(script);
        });
        return exifrLoading;
    }

    // { takenAt, lat, lon } in the shape services/photoInfoService.js keeps, or null
    async function captureInfo(file) {
        try {
            const exifr = await loadExifr();
            const exif = exifr && await exifr.parse(file, { pick: EXIF_FIELDS });
            if (!exif) return null;
            const taken = exif.DateTimeOriginal || exif.CreateDate;
            const pad = n => String(n).padStart(2, '0');
            const takenAt = taken instanceof Date && !isNaN(taken)
                ? `${taken.getFullYear()}-${pad(taken.getMonth() + 1)}-${pad(taken.getDate())}T${pad(taken.getHours())}:${pad(taken.getMinutes())}:${pad(taken.getSeconds())}`
                : null;
            const hasGps = Number.isFinite(exif.latitude) && Number.isFinite(exif.longitude)
                && !(exif.latitude === 0 && exif.longitude === 0);
            if (!takenAt && !hasGps) return null;
            return { takenAt, lat: hasGps ? exif.latitude : null, lon: hasGps ? exif.longitude : null };
        } catch {
            return null;
        }
    }

    // An upright picture the canvas can draw. Browsers that can't read the format (HEIC on Android) fail here.
    async function decode(file) {
        if (window.createImageBitmap) {
            try {
                return await createImageBitmap(file, { imageOrientation: 'from-image' });
            } catch { /* older Safari rejects the option: an <img> turns the photo upright by itself */ }
        }
        const url = URL.createObjectURL(file);
        try {
            const img = new Image();
            img.decoding = 'async';
            img.src = url;
            await img.decode();
            return img;
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    // A smaller JPEG of a camera photo, or null to send the file as it is
    async function shrink(file) {
        if (!/^image\/(jpeg|heic|heif)$/.test(kindOf(file)) || file.size < SMALL) return null;
        let picture;
        try {
            picture = await decode(file);
        } catch {
            return null;
        }
        const width = picture.naturalWidth || picture.width;
        const height = picture.naturalHeight || picture.height;
        const scale = MAX_EDGE / Math.max(width, height);
        // Already frame-sized: encoding it again would only cost quality
        if (!width || !height || (scale >= 1 && kindOf(file) === 'image/jpeg')) {
            picture.close?.();
            return null;
        }
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * Math.min(1, scale));
        canvas.height = Math.round(height * Math.min(1, scale));
        canvas.getContext('2d').drawImage(picture, 0, 0, canvas.width, canvas.height);
        picture.close?.();
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
        canvas.width = canvas.height = 0; // iOS only gives canvas memory back when it shrinks
        if (!blob || blob.type !== 'image/jpeg' || blob.size >= file.size) return null;
        return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg', lastModified: file.lastModified });
    }

    // What to send for one chosen file: the photo (smaller when possible) and what its original said
    async function prepare(file) {
        const smaller = await shrink(file).catch(() => null);
        if (!smaller) return { file, info: null }; // the server reads the original itself
        return { file: smaller, info: await captureInfo(file) };
    }

    // One request for one photo. Answers { status, data }; status 0 is a lost connection.
    function send({ file, info }, targetPath, onProgress) {
        return new Promise(resolve => {
            // path goes first so multer sees it before the file arrives
            const form = new FormData();
            form.append('path', targetPath);
            if (info) form.append('info', JSON.stringify([info]));
            form.append('images', file, file.name);

            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/upload');
            xhr.responseType = 'text';
            xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
            const done = () => {
                let data = {};
                try { data = JSON.parse(xhr.responseText || '{}'); } catch { /* an error page, not JSON */ }
                resolve({ status: xhr.status, data });
            };
            xhr.onload = done;
            xhr.onerror = done;
            xhr.onabort = done;
            xhr.ontimeout = done;
            xhr.send(form);
        });
    }

    // Offline: wait for the connection instead of burning the retries
    function backOnline(limitMs = 60000) {
        if (navigator.onLine !== false) return Promise.resolve();
        return new Promise(resolve => {
            const finish = () => { window.removeEventListener('online', finish); resolve(); };
            window.addEventListener('online', finish);
            setTimeout(finish, limitMs);
        });
    }

    async function sendWithRetry(item, targetPath, onProgress) {
        let answer;
        for (let attempt = 0; ; attempt++) {
            await backOnline();
            answer = await send(item, targetPath, onProgress);
            if (!RETRY_STATUS.includes(answer.status) || attempt >= RETRY_WAITS.length) return answer;
            onProgress(0);
            await wait(RETRY_WAITS[attempt]);
        }
    }

    // Screen wake lock for the length of an upload. Browsers drop it when the page is hidden.
    function stayAwake() {
        if (!('wakeLock' in navigator)) return () => {};
        let lock = null;
        let stopped = false;
        const acquire = async () => {
            if (stopped || document.visibilityState !== 'visible') return;
            try { lock = await navigator.wakeLock.request('screen'); } catch { /* battery saver */ }
        };
        document.addEventListener('visibilitychange', acquire);
        acquire();
        return () => {
            stopped = true;
            document.removeEventListener('visibilitychange', acquire);
            lock?.release().catch(() => {});
        };
    }

    /**
     * Upload photos into a folder. onProgress gets { done, total, fraction }.
     * Answers { ok, files, status, data, sessionExpired }: files are the ones that were
     * saved, even when a later one failed (a full account stops the rest).
     */
    async function uploadAll(files, targetPath, { onProgress = () => {}, parallel = 2 } = {}) {
        const list = Array.from(files);
        const sent = new Array(list.length).fill(0);
        const saved = [];
        let done = 0;
        let next = 0;
        let failure = null;
        const report = () => onProgress({ done, total: list.length, fraction: list.length ? sent.reduce((a, b) => a + b, 0) / list.length : 1 });

        const release = stayAwake();
        report();
        const worker = async () => {
            while (next < list.length && !failure) {
                const i = next++;
                const item = await prepare(list[i]);
                if (failure) return;
                const answer = await sendWithRetry(item, targetPath, part => { sent[i] = part; report(); });
                if (answer.status >= 200 && answer.status < 300) {
                    saved.push(...(answer.data.files || []));
                    sent[i] = 1;
                    done++;
                    report();
                } else if (!failure) {
                    failure = answer;
                }
            }
        };
        try {
            await Promise.all(Array.from({ length: Math.min(parallel, list.length) }, worker));
        } finally {
            release();
        }
        if (!failure) return { ok: true, files: saved, status: 200, data: { files: saved } };
        return { ok: false, files: saved, status: failure.status, data: failure.data, sessionExpired: failure.status === 401 };
    }

    // Photos shared to the app from the phone's gallery, held by sw.js until the library opens
    async function takeShared() {
        if (!('caches' in window)) return [];
        try {
            if (!await caches.has(SHARE_CACHE)) return [];
            const cache = await caches.open(SHARE_CACHE);
            const files = [];
            for (const request of await cache.keys()) {
                const response = await cache.match(request);
                if (!response) continue;
                const name = decodeURIComponent(response.headers.get('X-File-Name') || 'photo');
                const type = response.headers.get('Content-Type') || '';
                files.push(new File([await response.blob()], name, { type: type === 'application/octet-stream' ? '' : type }));
            }
            await caches.delete(SHARE_CACHE);
            return files;
        } catch {
            return [];
        }
    }

    function registerShareWorker() {
        if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    // Android offers an install prompt we can show later; iOS has no such thing
    let installEvent = null;
    window.addEventListener('beforeinstallprompt', event => {
        event.preventDefault();
        installEvent = event;
    });
    window.addEventListener('appinstalled', () => { installEvent = null; hideInstall(); });

    const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    const isIosSafari = () => /iP(hone|ad|od)/.test(navigator.userAgent) && /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);

    function hideInstall() {
        document.getElementById('installOffer')?.remove();
    }

    // After a first upload: offer to put the library on the home screen. `t` translates a key.
    function offerInstall(t) {
        let dismissed = false;
        try { dismissed = localStorage.getItem(INSTALL_DISMISSED) === '1'; } catch { /* private mode */ }
        if (dismissed || isStandalone() || document.getElementById('installOffer')) return;
        const ios = !installEvent && isIosSafari();
        if (!installEvent && !ios) return;

        const box = document.createElement('div');
        box.id = 'installOffer';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-label', t('admin.installTitle'));
        box.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:60;max-width:440px;margin:0 auto;padding:16px;border-radius:14px;background:var(--color-card,#fff);color:var(--color-card-foreground,#222);border:1px solid var(--color-border,#ddd);box-shadow:0 12px 40px -12px rgb(0 0 0 / .35)';
        const title = document.createElement('p');
        title.style.cssText = 'font-weight:600;margin:0 0 4px';
        title.textContent = t('admin.installTitle');
        const text = document.createElement('p');
        text.style.cssText = 'margin:0 0 12px;font-size:.9rem;opacity:.8';
        text.textContent = t(ios ? 'admin.installIos' : 'admin.installText');
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
        const later = document.createElement('button');
        later.type = 'button';
        later.className = 'btn-outline';
        later.textContent = t(ios ? 'common.close' : 'admin.installLater');
        later.addEventListener('click', () => {
            try { localStorage.setItem(INSTALL_DISMISSED, '1'); } catch { /* private mode */ }
            hideInstall();
        });
        actions.appendChild(later);
        if (!ios) {
            const add = document.createElement('button');
            add.type = 'button';
            add.className = 'btn';
            add.textContent = t('admin.installButton');
            add.addEventListener('click', async () => {
                const event = installEvent;
                installEvent = null;
                hideInstall();
                if (event) {
                    event.prompt();
                    await event.userChoice.catch(() => {});
                }
            });
            actions.appendChild(add);
        }
        box.append(title, text, actions);
        document.body.appendChild(box);
    }

    window.PhotoUpload = { uploadAll, prepare, shrink, captureInfo, takeShared, registerShareWorker, offerInstall, MAX_EDGE };
})();
