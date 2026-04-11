// Vinario — service worker minimale per installabilità PWA + offline shell
const CACHE = "vinario-v1";
const SHELL = ["/", "/index.html", "/icon.svg", "/manifest.json", "/vinario-logo.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Lascia passare le funzioni Netlify (sync cloud, enrichment AI, scan)
  if (url.pathname.startsWith("/.netlify/")) return;
  // Origini esterne: non intercettare
  if (url.origin !== self.location.origin) return;

  // HTML: network-first, fallback cache (sempre ultima versione quando online)
  if (req.mode === "navigate" || url.pathname === "/" || url.pathname.endsWith(".html")) {
    e.respondWith(
      fetch(req)
        .then((r) => {
          const clone = r.clone();
          caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
          return r;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match("/")))
    );
    return;
  }

  // Asset statici: cache-first con update in background
  e.respondWith(
    caches.match(req).then((cached) => {
      const fresh = fetch(req)
        .then((r) => {
          if (r && r.ok) {
            const clone = r.clone();
            caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
          }
          return r;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
