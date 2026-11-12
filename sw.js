// Service worker: lets Android install the site as a real app (own icon, full screen).
// It caches nothing, so the app always loads the latest data and code from the site.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
