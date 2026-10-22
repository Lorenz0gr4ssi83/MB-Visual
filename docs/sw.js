// La web app si e' spostata sul server delle licenze: questo service worker sostituisce quello vecchio,
// cancella la copia salvata e porta le finestre aperte all'indirizzo nuovo.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: "window" })) c.navigate("https://mbvisual.mb-group.workers.dev/");
})()));
