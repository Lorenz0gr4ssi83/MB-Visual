// Statistiche d'uso anonime (solo app per PC/Mac e SOLO con il consenso esplicito). Motore: mbvisual/stats.py.
// Alla prima apertura "Si'" e' il pulsante principale (arancione, con il fuoco) ma vale solo se cliccato: Esc o nessuna scelta = niente.
// Finestra di consenso al primo avvio, impostazione in File > Impostazioni > Statistiche d'uso, informativa.
// track(tipo, chiave) conta in memoria; ogni 60 s i conteggi passano al motore (op=conta), che li tiene per giorno e manda i
// giorni conclusi al server una volta al giorno. Senza consenso track() non fa nulla e non parte nessuna richiesta di conteggio.
//   tipo "ext" = estensione di un file aperto (solo se e' nel registro dei formati, altrimenti "altro")
//   tipo "fn"  = funzione usata (chiave fissa, es. "stampa", "nav.clash", "v.cad2d" = visualizzatore)
//   tipo "err" = errore di un visualizzatore: "visualizzatore|TipoErrore|ext" (mai il messaggio, che puo' contenere testo del file)
import { api, el, modal, toast, WEB } from "./core.js";
import { t as tr, LANG } from "./i18n.js";

let ON = false, ready = false;
const buf = { exts: {}, funcs: {}, errors: {} };
let last = Date.now();

export function track(kind, key) {
  if (!ON || WEB) return;
  const k = String(key || "").toLowerCase();
  if (kind === "ext") { const e = /^[a-z0-9_]{1,12}$/.test(k) ? k : "altro"; buf.exts[e] = (buf.exts[e] || 0) + 1; }
  else if (kind === "fn" && /^[a-z0-9_.-]{1,48}$/.test(k)) buf.funcs[k] = (buf.funcs[k] || 0) + 1;
}
export function trackError(viewer, e, ext) {
  if (!ON || WEB) return;
  const v = String(viewer || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24) || "app";
  const name = /^[A-Za-z]{1,32}$/.test(e?.name || "") ? e.name : "Error";
  const x = /^[a-z0-9_]{1,12}$/.test(ext || "") ? ext : "";
  const key = `${v}|${name}|${x}`;
  buf.errors[key] = (buf.errors[key] || 0) + 1;
}
window.MBStat = { track, trackError }; // moduli caricati a parte (senza import): window.MBStat?.track("fn", "...")

function take() {
  const now = Date.now(), seconds = Math.min(600, Math.round((now - last) / 1000));
  last = now;
  const b = { lang: LANG, seconds, ...JSON.parse(JSON.stringify(buf)) };
  buf.exts = {}; buf.funcs = {}; buf.errors = {};
  return b;
}
function flush() {
  if (!ON) return;
  api("stats", { op: "conta" }, { json: take(), allowFail: true }).catch(() => { /* il motore e' in chiusura */ });
}

export async function initStats() {
  if (WEB || ready) return;
  ready = true;
  let st;
  try { st = await api("stats", { op: "stato" }, { allowFail: true }); } catch { return; }
  ON = st.consenso === true;
  last = Date.now();
  setInterval(flush, 60000);
  window.addEventListener("pagehide", () => {
    if (!ON) return;
    try { navigator.sendBeacon("/api/stats?op=conta", new Blob([JSON.stringify(take())], { type: "application/json" })); } catch { /* */ }
  });
  // prima volta (nessuna scelta, nemmeno nell'installazione): si chiede quando l'app e' libera (licenza, componenti, altre finestre)
  if (!st.chiesto) {
    const free = () => !document.getElementById("license-gate") && document.getElementById("modal")?.hidden !== false;
    const wait = () => (free() ? askConsent() : setTimeout(wait, 1500));
    setTimeout(wait, 2500);
  }
}

async function setConsent(v) {
  const st = await api("stats", { op: "consenso" }, { json: { consenso: !!v } });
  const was = ON;
  ON = st.consenso === true;
  last = Date.now();
  if (ON && !was) toast(tr("stat.attivato"));
  if (!ON && was) toast(tr("stat.revocato"));
  return st;
}

// finestra del primo avvio: Si / No (e informativa); chiudendola senza scegliere si richiede al prossimo avvio
async function askConsent() {
  for (;;) {
    const box = el("div", { style: { maxWidth: "520px", display: "grid", gap: "10px" } },
      el("p", { style: { margin: 0, fontWeight: 600 } }, tr("stat.domanda")),
      el("p", { style: { margin: 0, color: "var(--muted)" } }, tr("stat.domanda_dett")));
    const r = await modal(tr("stat.titolo"), box, [{ label: tr("stat.leggi_informativa"), value: "inf" }, { label: tr("stat.no"), value: "no" }, { label: tr("stat.si"), value: "si", primary: true }]);
    if (r === "inf") { await showPolicy(); continue; }
    if (r === "si" || r === "no") await setConsent(r === "si").catch(e => toast(e.message, true));
    return;
  }
}

// File > Impostazioni > Statistiche d'uso
export async function showStatsSettings() {
  let st;
  try { st = await api("stats", { op: "stato" }); } catch (e) { return toast(e.message, true); }
  const cb = el("input", { type: "checkbox" });
  cb.checked = st.consenso === true;
  const state = el("p", { class: "note", style: { margin: 0, color: "var(--muted)" } });
  const upd = () => { state.textContent = tr(cb.checked ? "stat.stato_on" : "stat.stato_off") + (st.consenso && !cb.checked ? " " + tr("stat.revoca_nota") : ""); };
  cb.addEventListener("change", upd);
  upd();
  const box = el("div", { style: { display: "grid", gap: "10px", maxWidth: "520px" } },
    el("label", { style: { display: "flex", gap: "8px", alignItems: "center" } }, cb, tr("stat.casella")),
    state, st.id ? el("p", { class: "note", style: { margin: 0, userSelect: "text" } }, tr("stat.identificativo", st.id)) : null,
    el("p", { style: { margin: 0, color: "var(--muted)" } }, tr("stat.domanda_dett")));
  const r = await modal(tr("stat.titolo"), box, [{ label: tr("stat.leggi_informativa"), value: "inf" }, { label: tr("common.annulla"), value: false }, { label: tr("common.ok"), value: true, primary: true }]);
  if (r === "inf") { await showPolicy(); return showStatsSettings(); }
  if (r === true && cb.checked !== (st.consenso === true)) await setConsent(cb.checked).catch(e => toast(e.message, true));
}

// informativa (testi stat.inf_*): dati raccolti, cosa non si raccoglie, finalita', base giuridica, conservazione, revoca
export async function showPolicy() {
  const sec = (k, items) => [el("h4", { style: { margin: "12px 0 4px" } }, tr(`stat.inf_${k}_t`)),
    items ? el("ul", { style: { margin: 0, paddingLeft: "20px" } }, ...items.map(i => el("li", {}, tr(`stat.inf_${k}_${i}`)))) : el("p", { style: { margin: 0 } }, tr(`stat.inf_${k}`))];
  const box = el("div", { style: { maxWidth: "620px", maxHeight: "65vh", overflow: "auto", lineHeight: 1.45 } },
    el("p", { style: { marginTop: 0 } }, tr("stat.inf_intro")),
    ...sec("titolare"),
    ...sec("dati", ["id", "sistema", "uso", "comp", "ext", "fn", "err"]),
    ...sec("mai", ["file", "contenuti", "posta", "account", "licenza", "ip"]),
    ...sec("fini"), ...sec("base"), ...sec("dove"), ...sec("revoca"));
  await modal(tr("stat.informativa"), box, [{ label: tr("common.chiudi"), value: true, primary: true }]);
}
