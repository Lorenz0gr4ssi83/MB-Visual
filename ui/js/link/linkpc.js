// Collegamento con il telefono, lato PC (solo app per PC): pulsante "Telefono" nella barra laterale con il pannello.
// - abbinamento: QR con l'indirizzo dell'app per telefono + stanza e chiave nel frammento (#), letto dall'app del telefono
// - file dal telefono (scansioni, foto, documenti, biglietti da visita) salvati nella cartella scelta e aperti in MB Desk
// - "Invia al telefono": il file aperto (o scelto) va sul telefono come DOCUMENTO CONDIVISO: quando il telefono lo salva la
//   versione torna sul PC (sull'originale, o come copia se intanto e' cambiato qui) e quando lo salva il PC va al telefono
// - file del PC sfogliabili dal telefono (solo schede aperte, recenti e documenti condivisi: nient'altro del disco)
// - appunti nei due versi (anche automatici dal PC), contatti nella rubrica della Posta, telecomando (remote.js)
// Dati dell'abbinamento e impostazioni: mbvisual/link.py (cifrati). Nucleo e cifratura: linkcore.js.
import { api, el, fileUrl, loadCss, toast, fmtSize, baseName, pickFiles, pickFolder } from "../core.js";
import { t } from "../i18n.js";
import { Link, newPairing, pairUrl, newId } from "./linkcore.js";
import * as remote from "./remote.js";

let D = null;          // { pairing: {room, key, server}, settings: {dir, auto_open, clip_auto}, shared: {doc: {path, name, ver}} }
let link = null, panel = null, btn = null, lastClip = null;
const received = [];   // ricevuti in questa sessione [{name, path, size, t}]
const transfers = new Map(); // fid -> {name, done, total, dir}
const offered = new Set();   // percorsi che il telefono puo' chiedere (schede, recenti, condivisi)

const ICON_PHONE = '<svg viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/></svg>';
const persist = () => api("link", { op: "save" }, { json: { pairing: D.pairing, settings: D.settings, shared: D.shared } }).catch(() => {});
const phones = () => link?.list("mobile") || [];

// ---------------------------------------------------------------- avvio
export async function setupLinkPc() {
  loadCss("css/link.css");
  btn = el("button", { id: "btn-link", class: "desktop-only", title: t("link.titolo_pc"), onclick: () => togglePanel() });
  btn.insertAdjacentHTML("beforeend", ICON_PHONE);
  btn.append(el("span", {}, t("link.telefono")), el("i", { class: "lk-dot" }));
  (document.getElementById("btn-mail") || document.getElementById("btn-formats")).after(btn);
  window.MBLink = { sendTab, open: () => togglePanel(true), get online() { return phones().length > 0; } };
  try { D = await api("link", { op: "load" }); } catch { return; }
  D.shared ||= {};
  if (D.pairing) connect();
  setInterval(watchShared, 3000);
  setInterval(watchClip, 1500);
}

function connect() {
  link?.stop();
  const p = D.pairing;
  link = new Link({ server: p.server, room: p.room, key: p.key, role: "pc", name: p.name || "PC", caps: ["files", "clip", "remote", "docs"],
    ticket: async () => {
      const r = await api("link", { op: "ticket", room: p.room }, { allowFail: true });
      if (!r.ok) throw new Error(r.errore);
      if (r.server && r.server !== p.server) { p.server = r.server; link.opts.server = r.server; persist(); }
      return r.ticket;
    } });
  link.addEventListener("status", render);
  link.addEventListener("peers", e => {
    const before = render.count || 0;
    render.count = e.detail.filter(x => x.role === "mobile").length;
    if (render.count > before) toast(t("link.telefono_collegato", e.detail.filter(x => x.role === "mobile").map(x => x.name).join(", ")));
    render();
  });
  link.addEventListener("progress", onProgress);
  link.addEventListener("file", e => onFile(e.detail).catch(err => toast(err.message, true, 6000)));
  link.addEventListener("msg", e => onMsg(e.detail).catch(() => {}));
  link.onRequest("files", listFiles);
  link.onRequest("get", (h, _d, from) => sendPath(h.path, from));
  link.onRequest("rc-state", () => remote.state());
  link.onRequest("snap", () => remote.snapshot());
  link.start();
}

// ---------------------------------------------------------------- ricezione
async function onFile({ from, file, meta }) {
  const who = link.peers.get(from)?.name || t("link.telefono");
  if (meta.kind === "doc-save") return docSave(file, meta, from);
  const r = await api("link", { op: "put", name: file.name }, { body: file });
  received.unshift({ name: baseName(r.path), path: r.path, size: file.size, t: Date.now() });
  if (meta.kind === "contact" && meta.contact) await addContact(meta.contact).catch(() => {});
  toast(t("link.ricevuto_da", baseName(r.path), who));
  if (D.settings.auto_open && meta.kind !== "contact") window.MB.openFile(r.path);
  render();
}
async function addContact(c) {
  const { call } = await import("../mail/mailapp.js");
  const books = (await call("contacts", {})).rubriche || [];
  if (!books.length) return;
  await call("contact_save", { book: books[0].id, name: [c.given, c.family].filter(Boolean).join(" ") || c.org, org: c.org, title: c.title,
    emails: c.emails || [], phones: (c.phones || []).map(p => p.value), address: [c.adr?.street, [c.adr?.cap, c.adr?.city, c.adr?.prov && `(${c.adr.prov})`].filter(Boolean).join(" ")].filter(Boolean).join(", "), note: c.note || "" });
  toast(t("link.contatto_rubrica", [c.given, c.family].filter(Boolean).join(" ") || c.org));
}
async function onMsg({ from, h }) {
  if (h.t === "clip" && typeof h.text === "string") {
    await api("link", { op: "clip_set" }, { json: { text: h.text } });
    lastClip = h.text;
    toast(t("link.appunti_ricevuti", link.peers.get(from)?.name || t("link.telefono")));
  } else if (h.t === "rc") remote.apply(h);
}
function onProgress(e) {
  const p = e.detail;
  if (p.end || p.failed || p.done >= p.total) transfers.delete(p.fid); else transfers.set(p.fid, p);
  renderTransfers();
}

// ---------------------------------------------------------------- documenti condivisi
// versione = data di modifica del file sul PC quando e' stato mandato (o salvato) l'ultima volta
async function docSave(file, meta, from) {
  const doc = D.shared[meta.doc];
  if (!doc) { // documento non piu' condiviso: arriva come file normale
    const r = await api("link", { op: "put", name: file.name }, { body: file });
    toast(t("link.ricevuto_da", baseName(r.path), link.peers.get(from)?.name || "")); return;
  }
  let st = null;
  try { st = await api("stat", { path: doc.path }); } catch { /* file spostato o cancellato */ }
  const tab = (window.MB.tabs || []).find(x => x.path === doc.path);
  if (st && st.modificato === doc.ver && !tab?.dirty) {
    await api("save", { path: doc.path }, { body: file });
    const st2 = await api("stat", { path: doc.path });
    doc.ver = st2.modificato;
    persist();
    link.send({ t: "doc-ack", doc: meta.doc, ver: doc.ver }, null, from).catch(() => {});
    for (const p of phones()) if (p.id !== from) link.sendFile(file, { kind: "doc-update", doc: meta.doc, ver: doc.ver, name: doc.name }, p.id).catch(() => {});
    toast(t("link.aggiornato_dal_telefono", doc.name));
    return;
  }
  // il file del PC e' cambiato (o e' aperto con modifiche non salvate): la versione del telefono diventa una copia accanto
  const label = t("link.copia_telefono", new Date().toLocaleString().replace(/[/:]/g, "."));
  const r = st ? await api("link", { op: "conflict", path: doc.path, label }, { body: file }) : await api("link", { op: "put", name: file.name }, { body: file });
  link.send({ t: "doc-conflict", doc: meta.doc, copy: baseName(r.path) }, null, from).catch(() => {});
  toast(t("link.conflitto_pc", doc.name, baseName(r.path)), true, 9000);
  received.unshift({ name: baseName(r.path), path: r.path, size: file.size, t: Date.now() });
  render();
}
async function watchShared() {
  if (!link?.online || !phones().length) return;
  for (const [id, doc] of Object.entries(D.shared)) {
    let st;
    try { st = await api("stat", { path: doc.path }); } catch { continue; }
    if (st.modificato === doc.ver || doc.sending) continue;
    doc.sending = true;
    try {
      const blob = await (await fetch(fileUrl(doc.path))).blob();
      doc.ver = st.modificato;
      persist();
      await link.sendFile(new File([blob], doc.name), { kind: "doc-update", doc: id, ver: doc.ver, name: doc.name });
    } catch { /* riprova al giro dopo */ } finally { doc.sending = false; }
  }
}

// ---------------------------------------------------------------- invio al telefono
async function sendPath(path, to = null) {
  if (!offered.has(path) && !Object.values(D.shared).some(d => d.path === path) && !(window.MB.tabs || []).some(x => x.path === path)) throw new Error(t("link.file_non_offerto"));
  const st = await api("stat", { path });
  const blob = await (await fetch(fileUrl(path))).blob();
  const name = baseName(path);
  let id = Object.keys(D.shared).find(k => D.shared[k].path === path);
  if (!id) id = newId();
  D.shared[id] = { path, name, ver: st.modificato };
  persist();
  await link.sendFile(new File([blob], name), { kind: "doc", doc: id, ver: st.modificato, name }, to);
  render();
  return { ok: true, doc: id };
}
export async function sendTab(tab = window.MB.active) {
  if (!tab || /^(mail|web|download):\/\//.test(tab.path)) return toast(t("link.nessun_file"), true);
  if (!phones().length) { togglePanel(true); return toast(t("link.nessun_telefono"), true, 5000); }
  if (tab.dirty) toast(t("link.invio_versione_salvata"), false, 5000);
  try { await sendPath(tab.path); toast(t("link.inviato", tab.name)); } catch (e) { toast(e.message, true, 6000); }
}
async function sendPicked() {
  const ps = await pickFiles();
  for (const p of ps || []) { offered.add(p); try { await sendPath(p); } catch (e) { toast(e.message, true, 6000); } }
}
function listFiles() {
  const recent = (() => { try { return JSON.parse(localStorage.getItem("mbv-recent") || "[]"); } catch { return []; } })();
  const tabs = (window.MB.tabs || []).filter(x => !/^(mail|web|download):\/\//.test(x.path));
  const out = { open: tabs.map(x => ({ path: x.path, name: x.name })), recent: recent.filter(r => !tabs.some(x => x.path === r.path)).slice(0, 20).map(r => ({ path: r.path, name: r.name || baseName(r.path), t: r.t })),
    shared: Object.values(D.shared).map(d => ({ path: d.path, name: d.name })) };
  for (const l of [out.open, out.recent, out.shared]) for (const f of l) offered.add(f.path);
  return out;
}

// ---------------------------------------------------------------- appunti
async function sendClip() {
  const r = await api("link", { op: "clip_get" }, { allowFail: true });
  if (!r.ok || !r.text) return toast(t("link.appunti_vuoti"), true);
  lastClip = r.text;
  await link.send({ t: "clip", text: r.text.slice(0, 100000) });
  toast(t("link.appunti_inviati"));
}
async function watchClip() {
  if (!D?.settings.clip_auto || !link?.online || !phones().length) return;
  const r = await api("link", { op: "clip_get" }, { allowFail: true }).catch(() => null);
  if (!r?.ok || !r.text) return;
  if (lastClip === null) { lastClip = r.text; return; } // all'avvio non si manda quello che c'era gia'
  if (r.text === lastClip) return;
  lastClip = r.text;
  link.send({ t: "clip", text: r.text.slice(0, 100000), auto: true }).catch(() => {});
}

// ---------------------------------------------------------------- abbinamento
async function pair() {
  const p = newPairing();
  const r = await api("link", { op: "ticket", room: p.room }, { allowFail: true });
  if (!r.ok) { toast(r.errore, true, 7000); return; }
  if (D.pairing && link) { await link.send({ t: "unpair" }).catch(() => {}); } // i telefoni del vecchio abbinamento lo dimenticano
  D.pairing = { ...p, server: r.server, name: r.nome };
  await persist();
  connect();
  render();
}
async function unpairAll() {
  const { confirmBox } = await import("../core.js");
  if (!(await confirmBox(t("link.scollega_tutti"), t("link.scollega_tutti_testo"), t("link.scollega"), true))) return;
  await link?.send({ t: "unpair" }).catch(() => {});
  link?.stop(); link = null;
  D.pairing = null; D.shared = {};
  await persist();
  render();
}

let qrcode = null;
async function qrSvg(text, px) {
  qrcode ??= (await import("../../vendor/qrcode-generator/dist/qrcode.mjs")).default;
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount(), m = 3;
  let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${x + m} ${y + m}h1v1h-1z`;
  const s = n + 2 * m;
  return `<svg viewBox="0 0 ${s} ${s}" width="${px}" height="${px}" shape-rendering="crispEdges" aria-hidden="true"><rect width="${s}" height="${s}" fill="#fff"/><path d="${d}" fill="#111" stroke="none"/></svg>`;
}

// ---------------------------------------------------------------- pannello
function togglePanel(force) {
  const show = force ?? !panel?.isConnected;
  if (!show) { panel?.remove(); return; }
  if (!panel) {
    panel = el("aside", { class: "lk-panel", role: "dialog", "aria-label": t("link.titolo_pc") });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && panel?.isConnected) panel.remove(); });
  }
  document.body.append(panel);
  render();
}
const ago = ts => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const sw = (label, on, fn) => { const i = el("input", { type: "checkbox", checked: on }); i.addEventListener("change", () => fn(i.checked)); return el("label", { class: "lk-chk" }, i, el("span", {}, label)); };
function render() {
  const n = phones().length;
  btn?.classList.toggle("lk-on", n > 0);
  btn?.classList.toggle("lk-paired", !!D?.pairing);
  if (!panel?.isConnected || !D) return;
  panel.innerHTML = "";
  const head = el("div", { class: "lk-head" }, el("b", {}, t("link.titolo_pc")), el("button", { class: "mini", onclick: () => panel.remove(), title: t("common.chiudi") }, "×"));
  panel.append(head);
  const st = !D.pairing ? "none" : n ? "on" : link?.state === "online" ? "wait" : link?.error && link.state !== "connecting" ? "err" : "conn";
  panel.append(el("div", { class: "lk-state lk-" + st }, el("i"), el("span", {}, {
    none: t("link.stato_nessuno"), on: t("link.stato_collegati", phones().map(p => p.name).join(", ")), wait: t("link.stato_attesa"),
    conn: t("link.stato_connessione"), err: t("link.stato_errore", link?.error || ""),
  }[st])));
  // QR
  const qr = el("div", { class: "lk-qr" });
  if (D.pairing) qrSvg(pairUrl(D.pairing.server, D.pairing, D.pairing.name), 210).then(s => { qr.innerHTML = s; });
  panel.append(el("section", { class: "lk-sec" },
    el("h4", {}, n ? t("link.collega_altro") : t("link.collega_telefono")),
    D.pairing ? el("div", { class: "lk-qrbox" }, qr, el("ol", {}, el("li", {}, t("link.passo1")), el("li", {}, t("link.passo2")), el("li", {}, t("link.passo3")))) :
      el("div", {}, el("p", { class: "lk-note" }, t("link.spiega")), el("button", { class: "btn primary", onclick: pair }, t("link.crea_qr"))),
    D.pairing ? el("p", { class: "lk-note" }, t("link.nota_sicurezza")) : null));
  if (D.pairing) {
    // azioni
    const a = window.MB.active;
    panel.append(el("section", { class: "lk-sec" }, el("h4", {}, t("link.invia")),
      el("div", { class: "lk-row" },
        el("button", { class: "btn", disabled: !n || !a || /^(mail|web):/.test(a?.path || ""), onclick: () => sendTab() }, t("link.invia_aperto")),
        el("button", { class: "btn", disabled: !n, onclick: sendPicked }, t("link.invia_file")),
        el("button", { class: "btn", disabled: !n, onclick: () => sendClip().catch(e => toast(e.message, true)) }, t("link.invia_appunti"))),
      sw(t("link.appunti_auto"), D.settings.clip_auto, v => { D.settings.clip_auto = v; lastClip = null; persist(); }),
      el("div", { class: "lk-transfers" })));
    // ricezione
    panel.append(el("section", { class: "lk-sec" }, el("h4", {}, t("link.ricezione")),
      el("div", { class: "lk-dir" }, el("span", { title: D.settings.dir }, D.settings.dir),
        el("button", { class: "mini", onclick: async () => { const f = await pickFolder(); if (f) { D.settings.dir = f; persist(); render(); } } }, t("link.cambia")),
        el("button", { class: "mini", onclick: () => api("reveal", { path: D.settings.dir }, { allowFail: true }) }, t("link.apri_cartella"))),
      sw(t("link.apri_subito"), D.settings.auto_open, v => { D.settings.auto_open = v; persist(); }),
      received.length ? el("div", { class: "lk-list" }, ...received.slice(0, 8).map(r => el("button", { class: "lk-item", onclick: () => window.MB.openFile(r.path) },
        el("span", {}, r.name), el("small", {}, fmtSize(r.size) + " · " + ago(r.t))))) : el("p", { class: "lk-note" }, t("link.nessun_ricevuto"))));
    // documenti condivisi
    const docs = Object.entries(D.shared);
    panel.append(el("section", { class: "lk-sec" }, el("h4", {}, t("link.condivisi")), el("p", { class: "lk-note" }, t("link.condivisi_spiega")),
      docs.length ? el("div", { class: "lk-list" }, ...docs.map(([id, d]) => el("div", { class: "lk-item" },
        el("span", { title: d.path }, d.name),
        el("button", { class: "mini", onclick: () => { delete D.shared[id]; persist(); render(); } }, t("link.smetti"))))) : null));
    panel.append(el("section", { class: "lk-sec" }, el("button", { class: "btn danger", onclick: unpairAll }, t("link.scollega_tutti"))));
  }
  renderTransfers();
}
function renderTransfers() {
  const box = panel?.querySelector(".lk-transfers");
  if (!box) return;
  box.innerHTML = "";
  for (const p of transfers.values()) box.append(el("div", { class: "lk-tr" }, el("span", {}, (p.dir === "in" ? "↓ " : "↑ ") + p.name),
    el("div", { class: "progress" }, el("span", { style: { width: Math.round(100 * p.done / Math.max(1, p.total)) + "%" } }))));
}
