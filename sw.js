// Computer and Robotics Education portal service worker.
// - Page (navigation): network first, falls back to the saved copy when offline or slow.
// - Own static files and CDN scripts/fonts: served from cache, refreshed in the background.
// - Supabase API calls and anything else: never touched, always go to the network.
const VERSION = "cre-portal-v2";
const SHELL = ["./", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];
const CDN = ["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];
const ROOT = new URL("./", self.location).href;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const offlinePage = () =>
  new Response(
    "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><title>Offline</title>" +
      "<body style='font-family:system-ui;background:#0b1020;color:#eef1fb;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center'>" +
      "<div><h2>You are offline</h2><p>Connect to the internet and reopen the portal.</p></div>",
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );

async function pageRequest(event) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(ROOT);
  const net = fetch(event.request).then((res) => {
    if (res.ok) { cache.put(ROOT, res.clone()); return res; }
    return cached || res;
  });
  event.waitUntil(net.catch(() => {}));
  if (!cached) return net.catch(() => offlinePage());
  // Slow network: after 4 seconds show the saved copy while the fresh one finishes loading.
  return Promise.race([net, new Promise((r) => setTimeout(() => r(cached), 4000))]).catch(() => cached);
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request);
  const fresh = fetch(request)
    .then((res) => {
      if (res && (res.ok || res.type === "opaque")) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await fresh) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.protocol !== "https:" && url.hostname !== "localhost") return;
  if (req.mode === "navigate") { event.respondWith(pageRequest(event)); return; }
  if (url.origin === self.location.origin || CDN.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req));
  }
});
