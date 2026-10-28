// Computer and Robotics Education portal service worker.
// - Page (navigation): network first, falls back to the saved copy when offline or slow.
// - Own static files and CDN scripts/fonts: served from cache, refreshed in the background.
// - Supabase API calls and anything else: never touched, always go to the network.
const VERSION = "cre-portal-v10";
const SHELL = ["./", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/logo.svg"];
const CDN = ["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];
const ROOT = new URL("./", self.location).href;

// Saves the app files, plus the page's outside files (data library and fonts) so even the very first offline start works.
// Nothing in here is allowed to stop the service worker from installing.
async function precacheShell(cache) {
  await Promise.allSettled(SHELL.map((u) => cache.add(new Request(u, { cache: "reload" }))));
  try {
    const html = await (await fetch("./", { cache: "reload" })).text();
    const urls = [...new Set([...html.matchAll(/(?:src|href)="(https:\/\/(?:cdn\.jsdelivr\.net|fonts\.googleapis\.com)[^"]+)"/g)].map((m) => m[1]))];
    for (const u of urls) {
      try {
        if (u.includes("fonts.googleapis.com")) {
          const r = await fetch(u);
          if (!r.ok) continue;
          const css = await r.clone().text();
          await cache.put(u, r);
          const files = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com[^)]+)\)/g)].map((m) => m[1]))].slice(0, 16);
          await Promise.allSettled(files.map((f) => fetch(f).then((fr) => fr.ok && cache.put(f, fr))));
        } else {
          await cache.put(u, await fetch(new Request(u, { mode: "no-cors" })));
        }
      } catch (_e) { /* keep going */ }
    }
  } catch (_e) { /* the app files are already saved */ }
}

self.addEventListener("install", (e) => {
  // A missing file must never stop the service worker from installing, or the app stops being installable.
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => precacheShell(c))
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
