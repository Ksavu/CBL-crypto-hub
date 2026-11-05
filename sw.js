// CBL Sniper Bot service worker: makes the app installable and opens instantly.
// The app shell is cached; API calls and prices always go to the network (never cached).
const CACHE = "cbl-sniper-v1", SHELL = ["/sniper", "/manifest.webmanifest", "/icons/cbl-192.png", "/icons/cbl-512.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/")) return;
  if (u.pathname === "/sniper" || u.pathname === "/sniper.html") { // network first, cached copy when offline
    e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(CACHE).then((x) => x.put("/sniper", c)); return r; }).catch(() => caches.match("/sniper")));
    return;
  }
  if (SHELL.includes(u.pathname)) e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
