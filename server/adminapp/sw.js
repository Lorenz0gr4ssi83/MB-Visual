// Service worker dell'app per telefono di MB Desk Admin: notifiche push e apertura dell'app dalla notifica.
// Niente copie offline: i dati delle licenze si leggono sempre dal server.
const SCOPE = self.registration.scope;
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "MB Desk Admin", {
    body: d.body || "", tag: d.tag, icon: SCOPE + "icon-192.png", badge: SCOPE + "icon-192.png", data: { url: d.url || SCOPE },
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || SCOPE, SCOPE).href;
  const vista = new URL(url).hash.slice(1);
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const c = list.find(w => w.url.startsWith(SCOPE));
    if (c) { c.postMessage({ vista }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
