// Computer and Robotics Education portal service worker.
// - Page (navigation): opens instantly from the saved copy and refreshes it in the background.
// - Own static files and CDN scripts/fonts: served from cache, refreshed in the background.
// - Supabase API calls and anything else: never touched, always go to the network.
const VERSION = "cre-portal-v13";
const SHELL = ["./", "manifest.webmanifest", "icons/icon-192.png", "icons/logo.svg"];
const CDN = ["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];
const ROOT = new URL("./", self.location).href;

self.addEventListener("install", (e) => {
  // Cache each file separately so one missing file can never stop the service worker from installing.
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
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
    if (res.ok) cache.put(ROOT, res.clone());
    return res;
  });
  event.waitUntil(net.catch(() => {}));
  // Saved copy exists: open instantly (no waiting on the network) and refresh it for next time.
  if (cached) return cached;
  return net.catch(() => offlinePage());
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

// Always try the network first for the manifest so a renamed app is never served from an old cache.
async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(request, { cache: "no-cache" });
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (_e) {
    return (await cache.match(request)) || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.protocol !== "https:" && url.hostname !== "localhost") return;
  if (req.mode === "navigate") { event.respondWith(pageRequest(event)); return; }
  if (url.origin === self.location.origin && url.pathname.endsWith("manifest.webmanifest")) {
    event.respondWith(networkFirst(req));
    return;
  }
  if (url.origin === self.location.origin || CDN.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req));
  }
});

// Tapping a phone notification opens (or returns to) the portal.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if ("focus" in c) return c.focus();
      return self.clients.openWindow("./");
    })
  );
});
