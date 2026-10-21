// Service worker di MB Visual: uso offline (cache) e ricezione dei file condivisi da altre app
const VERSION = "2026.10.21-14";
const CORE = ["./", "index.html", "css/app.css", "js/app.js", "js/core.js", "js/webapi.js", "formats.json", "img/logo.png", "img/icon-192.png", "manifest.webmanifest"];
self.addEventListener("install", e => { e.waitUntil(caches.open("mbv-" + VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("mbv-") && k !== "mbv-" + VERSION && k !== "mbv-condivisi").map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method === "POST" && url.pathname.endsWith("/condividi")) {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const cache = await caches.open("mbv-condivisi");
      let i = 0;
      for (const f of form.getAll("file")) {
        await cache.put(new Request("./condiviso/" + (i++) + "-" + Date.now()), new Response(f, { headers: { "X-Nome": encodeURIComponent(f.name || "file") } }));
      }
      return Response.redirect("./?condivisi=1", 303);
    })());
    return;
  }
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // prima la cache (le librerie pesanti vengono salvate al primo uso), poi la rete
  e.respondWith(caches.open("mbv-" + VERSION).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: url.pathname.endsWith(".html") || url.pathname.endsWith("/") });
    if (hit) return hit;
    const r = await fetch(e.request);
    if (r.ok && r.type === "basic") c.put(e.request, r.clone());
    return r;
  }).catch(() => caches.match("index.html")));
});
