// Computer and Robotics Education portal service worker (offline support).
// - The portal page and its files are saved when the app is first opened, so it starts with no internet.
// - Page (navigation): network first, falls back to the saved copy when offline or slow (4 seconds).
// - Own static files, libraries and fonts: served from the saved copy and refreshed in the background.
// - Supabase calls are never touched here. The page saves the data it has already loaded (see offFetch in index.html).
const VERSION = "cre-portal-v5";
const SHELL = [
  "./", "manifest.webmanifest", "favicon.ico",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png", "icons/favicon-32.png", "icons/favicon-16.png", "icons/favicon.svg"
];
const EXTRA = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js",
  "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;600&display=swap",
  "https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&display=swap"
];
const CDN = ["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com", "unpkg.com", "cdnjs.cloudflare.com"];
const ROOT = new URL("./", self.location).href;

async function precache() {
  const cache = await caches.open(VERSION);
  await cache.add(new Request("./", { cache: "reload" }));                       // the page itself must be saved
  await Promise.allSettled(SHELL.slice(1).map((u) => cache.add(new Request(u, { cache: "reload" }))));
  await Promise.allSettled(EXTRA.map((u) => cache.add(new Request(u, { cache: "reload" }))));
  // Save the font files named inside the font stylesheets so text looks right offline from the first visit.
  for (const u of EXTRA.filter((x) => x.includes("fonts.googleapis.com"))) {
    try {
      const res = await cache.match(u);
      const css = res ? await res.clone().text() : "";
      const files = [...css.matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1]);
      await Promise.allSettled(files.map((f) => cache.add(f)));
    } catch (_e) { /* fonts are optional */ }
  }
}

self.addEventListener("install", (e) => { e.waitUntil(precache().then(() => self.skipWaiting())); });

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
      "<body style='font-family:system-ui;background:#0b3d27;color:#eef8f2;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px'>" +
      "<div><h2>You are offline</h2><p>This device has not saved the portal yet. Connect to the internet and open it once, then it will also open offline.</p></div>",
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );

async function pageRequest(event) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(ROOT, { ignoreSearch: true });
  const net = fetch(event.request).then((res) => {
    if (res.ok) { cache.put(ROOT, res.clone()); return res; }
    return cached || res;
  });
  event.waitUntil(net.catch(() => {}));
  if (!cached) return net.catch(() => offlinePage());
  // Slow or no network: after 4 seconds (or straight away when offline) show the saved copy.
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

// Try the network first for the manifest so a renamed app is never served from an old copy.
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
