// Licenza dell'app per cellulari (solo nella versione servita dal server delle licenze: tools/build_web.py --mobile).
// All'apertura e ogni 6 ore rinnova l'attivazione (cookie HttpOnly gestito dal server). Se la licenza non vale piu'
// (chiave sostituita da un cambio dispositivo, revocata, cellulare liberato) cancella i file salvati e torna alla
// pagina di attivazione con il motivo. Offline l'app funziona fino a 30 giorni dall'ultimo rinnovo.
const EXP = "mbv-licenza-scade";

async function wipeAndLeave(reason) {
  try { for (const k of await caches.keys()) await caches.delete(k); } catch { /* */ }
  try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch { /* */ }
  localStorage.removeItem(EXP);
  try { await (await import("./phonestore.js")).wipe(); } catch { /* */ } // file recenti salvati nel telefono
  try { await (await import("./mmailcore.js")).wipe(); } catch { /* */ } // posta salvata nel telefono
  location.replace("/attiva?motivo=" + encodeURIComponent(reason));
}

export async function checkMobileLicense() {
  let r;
  try {
    r = await fetch("/v1/check", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" });
  } catch {
    // offline: vale l'ultimo rinnovo per 30 giorni
    const exp = +localStorage.getItem(EXP) || 0;
    if (exp && Date.now() > exp) wipeAndLeave("Sono passati piu' di 30 giorni senza internet: collegati per rinnovare la licenza.");
    return;
  }
  const d = await r.json().catch(() => ({}));
  if (r.ok && d.ok) { localStorage.setItem(EXP, String(Date.now() + 30 * 86400000)); return; }
  if ([401, 403, 410].includes(r.status)) wipeAndLeave(d.errore || "Licenza non piu' valida: inserisci la chiave.");
}

window.MBV_MOBILE = true;
checkMobileLicense();
setInterval(checkMobileLicense, 6 * 3600 * 1000);
let last = Date.now();
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Date.now() - last > 15 * 60000) { last = Date.now(); checkMobileLicense(); } });
