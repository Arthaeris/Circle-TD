/* =============================================================================
 * Circle Tower Wars — sw.js  (Service Worker, Decision D2 / §10)
 * Offline play + fast loads. Cache-first for static assets (incl. .PNG, which
 * keep their UPPERCASE extension per D1). The cache name is VERSIONED so a new
 * release cleanly invalidates the old cache.
 *
 * Bump CACHE_VERSION on every release. Note: assets are cached lazily on first
 * fetch (the asset set is large and partly optional), and the core shell files
 * are pre-cached on install.
 * ===========================================================================*/
const CACHE_VERSION = "ctw-v2";
const CORE = [
  "./",
  "./index.html",
  "./style.css",
  "./mobile.css",
  "./database.js",
  "./database-ext.js",
  "./save.js",
  "./manifest.json",
  "./sim/fx.js", "./sim/rng.js", "./sim/hash.js", "./sim/balance.js",
  "./sim/pathfind.js", "./sim/waves.js", "./sim/core.js",
  "./net/commands.js", "./net/lockstep.js", "./net/firebase.js",
  "./app/loop.js", "./app/main.js",
  "./render/assets.js", "./render/draw.js",
  "./ui/shell.js"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then((c) => c.addAll(CORE).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Never cache Firebase / cross-origin realtime traffic.
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        // cache successful same-origin GETs (assets, modules) for offline use
        if (res && res.status === 200 && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match("./index.html"));
    })
  );
});
