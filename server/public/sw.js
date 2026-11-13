// Service worker for the library page. It does one thing: when someone shares
// photos to Sora Frame from their phone's gallery (share_target in
// icons/library.webmanifest), it holds them until the library page opens and
// puts them in the upload dialog (js/photoUpload.js). Nothing else is
// intercepted or cached, so pages always come from the network.
const SHARE_CACHE = 'sora-shared-photos';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  if (event.request.method !== 'POST' || new URL(event.request.url).pathname !== '/share-target') return;
  event.respondWith((async () => {
    try {
      const form = await event.request.formData();
      await caches.delete(SHARE_CACHE); // an older share nobody picked up
      const cache = await caches.open(SHARE_CACHE);
      let n = 0;
      for (const file of form.getAll('images')) {
        if (!file || typeof file === 'string') continue;
        await cache.put(`/__shared/${Date.now()}-${n++}`, new Response(file, {
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'X-File-Name': encodeURIComponent(file.name || 'photo')
          }
        }));
      }
    } catch (error) {
      // Nothing to keep: the library opens anyway and the person can pick the photos there
    }
    return Response.redirect('/admin?shared=1', 303);
  })());
});
