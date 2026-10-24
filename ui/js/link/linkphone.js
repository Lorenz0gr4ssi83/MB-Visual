// Collegamento con il PC, lato telefono (app per telefono): abbinamento leggendo il QR del pannello "Telefono" del PC,
// sezione "PC collegato" nella Home, invio di file/scansioni/biglietti al PC, file del PC (schede aperte, recenti,
// condivisi), appunti nei due versi, telecomando e documenti condivisi (salvati sul telefono = aggiornati sul PC e viceversa).
// Abbinamenti in localStorage "mbv-link" (stanza + chiave: solo in questo dispositivo). Nucleo e cifratura: linkcore.js.
import { el, loadScript, toast, fmtSize, extOf } from "../core.js";
import { t } from "../i18n.js";
import { Link, parsePair } from "./linkcore.js";

const V = p => (window.MBV_ROOT || "/") + "vendor/" + p;
let H = null;               // aiuti del guscio del telefono (phone.js): actionSheet, pushView, haptic, pick, store, UI, refreshHome
const links = new Map();    // stanza -> { p: abbinamento, link }
const docs = new Map();     // percorso web:// -> { room, doc, ver, name }
const clips = [];           // testi ricevuti dal PC [{ text, t, from }]
const I = d => `<svg viewBox="0 0 24 24">${d.startsWith("<") ? d : `<path d="${d}"/>`}</svg>`;
const IC = {
  pc: I('<rect x="3" y="4" width="18" height="12" rx="1.8"/><path d="M8 20h8M12 16v4"/>'),
  send: I("M12 19V5M6 11l6-6 6 6"), files: I("M3 6h6l2 2h10v11H3zM3 10h18"), clip: I('<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V2.5h6V4M9 10h6M9 14h6"/>'),
  remote: I('<circle cx="12" cy="12" r="8.5"/><path d="M12 7v3M12 14v3M7 12h3M14 12h3"/>'), qr: I("M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2"),
  x: I("M6 6l12 12M18 6L6 18"),
};
const load = () => { try { return JSON.parse(localStorage.getItem("mbv-link") || "[]"); } catch { return []; } };
const save = list => { try { localStorage.setItem("mbv-link", JSON.stringify(list)); } catch { /* */ } };
const pcOf = l => l.list("pc")[0] || null;
const anyOnline = () => [...links.values()].find(x => pcOf(x.link)) || null;

// ---------------------------------------------------------------- avvio
export function initLinkPhone(helpers) {
  H = helpers;
  loadCss();
  for (const p of load()) start(p);
  window.MBLinkPhone = { get online() { return !!anyOnline(); }, sendBlob, sendTab, homeSection, openPc: () => (anyOnline() ? pcView(anyOnline()) : scanQr()) };
  window.MBLinkSaved = onSaved;
  // QR letto con la fotocamera del sistema: l'app si apre con #mbvlink=...
  const fromUrl = parsePair(location.href);
  if (fromUrl) { history.replaceState(null, "", location.pathname + location.search); setTimeout(() => confirmPair(fromUrl), 600); }
}
function loadCss() {
  if (document.querySelector('link[href$="css/link.css"]')) return;
  document.head.append(el("link", { rel: "stylesheet", href: (window.MBV_ROOT || "") + "css/link.css" }));
}
function start(p) {
  if (links.has(p.room)) return links.get(p.room);
  const link = new Link({ server: p.server, room: p.room, key: p.key, role: "mobile", name: "", caps: ["files", "clip", "docs"],
    ticket: async () => {
      const body = { room: p.room, ...(window.MBV_LINK_TOKEN ? { token: window.MBV_LINK_TOKEN } : {}) }; // MBV_LINK_TOKEN: solo prove
      const r = await fetch(p.server + "/v1/link/ticket", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(x => x.json());
      if (!r.ok) throw new Error(r.errore || "ticket");
      return r.ticket;
    } });
  const x = { p, link };
  links.set(p.room, x);
  link.addEventListener("peers", () => { refresh(); });
  link.addEventListener("status", () => refresh());
  link.addEventListener("file", e => onFile(x, e.detail).catch(err => toast(err.message, true, 6000)));
  link.addEventListener("msg", e => onMsg(x, e.detail));
  link.addEventListener("progress", onProgress);
  link.start();
  return x;
}
let refreshT = 0, homeBox = null;
function refresh() { clearTimeout(refreshT); refreshT = setTimeout(() => { if (homeBox?.isConnected) fillHome(homeBox); document.dispatchEvent(new CustomEvent("mbv-link")); }, 120); }

// ---------------------------------------------------------------- abbinamento
async function confirmPair(p) {
  if (links.has(p.room)) { toast(t("link.gia_collegato", p.name)); return; }
  const ok = await H.actionSheet({ title: t("link.collegare_a", p.name || "PC"), sub: t("link.collegare_sub"), items: [{ label: t("link.collega"), icon: IC.pc, run: () => {} }] });
  if (!ok) return;
  if (p.server.replace(/\/+$/, "") !== location.origin) toast(t("link.server_diverso"), true, 7000);
  const list = load().filter(x => x.room !== p.room);
  list.push({ server: p.server, room: p.room, key: p.key, name: p.name || "PC" });
  save(list);
  start(list[list.length - 1]);
  H.haptic(20);
  toast(t("link.abbinato", p.name || "PC"));
  refresh();
}
function forget(x) {
  x.link.stop();
  links.delete(x.p.room);
  save(load().filter(p => p.room !== x.p.room));
  refresh();
}
// lettore del QR del PC (fotocamera posteriore + jsQR, ogni 200 ms)
async function scanQr() {
  const v = H.pushView({ title: t("link.inquadra_qr") });
  const video = el("video", { playsinline: "", muted: "", autoplay: "" });
  video.muted = true; video.playsInline = true;
  const hint = el("p", { class: "lk-note" }, t("link.inquadra_qr_sub"));
  const paste = el("button", { type: "button", class: "lk-btn" }, t("link.incolla_link"));
  v.body.append(el("div", { class: "lk-scan" }, video, el("div", { class: "lk-scanframe" })), hint, paste);
  let stream = null, done = false, timer = 0;
  const stop = () => { done = true; clearInterval(timer); stream?.getTracks().forEach(x => x.stop()); };
  v.onClose = stop;
  paste.addEventListener("click", async () => {
    let s = "";
    try { s = await navigator.clipboard.readText(); } catch { s = prompt(t("link.incolla_link")) || ""; }
    const p = parsePair(s);
    if (!p) return toast(t("link.qr_non_valido"), true);
    stop(); v.close(true); confirmPair(p);
  });
  try {
    await loadScript(V("jsqr/jsQR.js"));
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } } });
    if (done) return stop();
    video.srcObject = stream;
    await video.play().catch(() => {});
  } catch (e) { hint.textContent = t("link.fotocamera_non_disponibile") + " " + (e.message || ""); return; }
  const c = document.createElement("canvas"), g = c.getContext("2d", { willReadFrequently: true });
  timer = setInterval(() => {
    if (done || !video.videoWidth) return;
    const k = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
    c.width = Math.round(video.videoWidth * k); c.height = Math.round(video.videoHeight * k);
    g.drawImage(video, 0, 0, c.width, c.height);
    const r = window.jsQR(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: "dontInvert" });
    if (!r?.data) return;
    const p = parsePair(r.data);
    if (!p) { hint.textContent = t("link.qr_non_valido"); return; }
    stop(); H.haptic(30); v.close(true); confirmPair(p);
  }, 200);
}

// ---------------------------------------------------------------- Home: sezione "PC collegato"
export function homeSection() {
  homeBox = el("div", { class: "ph-group lk-home" });
  fillHome(homeBox);
  return homeBox;
}
function fillHome(box) {
  box.innerHTML = "";
  const list = [...links.values()];
  if (!list.length) {
    box.append(row(IC.qr, t("link.collega_al_pc"), t("link.collega_al_pc_sub"), scanQr));
    return box;
  }
  for (const x of list) {
    const pc = pcOf(x.link);
    const sub = pc ? t("link.collegato") : x.link.state === "connecting" ? t("link.connessione") : x.link.error === "replaced" ? t("link.aperto_altrove") : t("link.pc_spento");
    const r = row(IC.pc, x.p.name, sub, () => pcView(x));
    r.classList.add(pc ? "lk-on" : "lk-off");
    box.append(r);
  }
  if (list.length) box.append(row(IC.qr, t("link.collega_altro_pc"), null, scanQr));
}
function row(icon, label, sub, fn) {
  const r = el("button", { type: "button", class: "ph-row", onclick: () => { H.haptic(); fn(); } });
  r.append(el("span", { class: "ph-ri", html: icon }), el("span", { class: "ph-rl" }, el("b", {}, label), sub ? el("small", {}, sub) : null), el("i", { class: "lk-dot" }));
  return r;
}

// ---------------------------------------------------------------- vista del PC
function pcView(x) {
  const v = H.pushView({ title: x.p.name });
  const draw = () => {
    if (!v.el.isConnected) return document.removeEventListener("mbv-link", draw);
    const pc = pcOf(x.link);
    v.body.innerHTML = "";
    v.body.append(el("div", { class: "lk-state " + (pc ? "lk-on" : "lk-off") }, el("i"), el("span", {}, pc ? t("link.collegato_a", pc.name || x.p.name) : t("link.pc_non_raggiungibile"))));
    const tile = (icon, label, sub, fn) => { const b = el("button", { type: "button", class: "ph-tile lk-tile", disabled: !pc || undefined, onclick: () => { H.haptic(); fn(); } }); b.insertAdjacentHTML("beforeend", `<span class="ph-tyi">${icon}</span>`); b.append(el("b", {}, label), el("small", {}, sub)); return b; };
    v.body.append(el("div", { class: "ph-tiles" },
      tile(IC.send, t("link.invia_file"), t("link.invia_file_sub"), () => pickAndSend(x)),
      tile(IC.files, t("link.file_pc"), t("link.file_pc_sub"), () => pcFiles(x)),
      tile(IC.remote, t("link.telecomando"), t("link.telecomando_sub"), () => remoteView(x)),
      tile(IC.clip, t("link.appunti"), t("link.appunti_sub"), () => clipView(x))));
    v.body.append(el("p", { class: "lk-note" }, t("link.nota_telefono")));
    v.body.append(el("button", { type: "button", class: "lk-btn danger", onclick: async () => {
      if (await window.MB.modal(t("link.scollega"), el("p", {}, t("link.scollega_pc_testo", x.p.name)), [{ label: t("common.annulla"), value: false }, { label: t("link.scollega"), value: true, danger: true }])) { forget(x); v.close(true); }
    } }, t("link.scollega_pc")));
  };
  document.addEventListener("mbv-link", draw);
  draw();
}

// ---------------------------------------------------------------- invio al PC
const progressBars = new Map();
function onProgress(e) {
  const p = e.detail;
  let b = progressBars.get(p.fid);
  if (!b && !p.end && !p.failed && p.total > 300000) {
    b = el("div", { class: "lk-toastbar" }, el("span", {}, (p.dir === "in" ? t("link.ricezione_di", p.name) : t("link.invio_di", p.name))), el("div", { class: "progress" }, el("span")));
    document.body.append(b); progressBars.set(p.fid, b);
  }
  if (!b) return;
  b.querySelector(".progress > span").style.width = Math.round(100 * p.done / Math.max(1, p.total)) + "%";
  if (p.end || p.failed || p.done >= p.total) { setTimeout(() => b.remove(), 400); progressBars.delete(p.fid); }
}
async function sendBlob(blob, meta = {}, x = anyOnline()) {
  if (!x || !pcOf(x.link)) { toast(t("link.pc_non_raggiungibile"), true, 5000); return false; }
  try {
    await x.link.sendFile(blob instanceof File ? blob : new File([blob], meta.name || "file", { type: blob.type }), meta, pcOf(x.link).id);
    H?.haptic(20);
    toast(t("link.inviato_al_pc", meta.name || blob.name || "", x.p.name));
    return true;
  } catch (e) { toast(t("link.invio_non_riuscito") + " " + e.message, true, 6000); return false; }
}
async function sendTab(tab) {
  const blob = window.MBV_API.blobOf(tab.path), name = tab.info?.nome || tab.name;
  const d = docs.get(tab.path);
  if (d && links.get(d.room) && pcOf(links.get(d.room).link)) return pushDoc(tab.path, blob); // documento del PC: torna sull'originale
  return sendBlob(new File([blob], name, { type: blob.type }), { kind: "file", name });
}
async function pickAndSend(x) {
  const ps = await H.pick({ multiple: true });
  for (const p of ps) { const b = window.MBV_API.blobOf(p); await sendBlob(new File([b], p.split("/").pop(), { type: b.type }), { kind: "file" }, x); }
}

// ---------------------------------------------------------------- file del PC
async function pcFiles(x) {
  const v = H.pushView({ title: t("link.file_pc") });
  v.body.append(el("div", { class: "ph-rlist" }, el("p", { class: "lk-note" }, t("link.caricamento"))));
  let r;
  try { r = (await x.link.request(pcOf(x.link).id, { t: "files" })).h; } catch (e) { v.body.innerHTML = ""; v.body.append(el("p", { class: "lk-note" }, e.message)); return; }
  v.body.innerHTML = "";
  const group = (title, items) => {
    if (!items?.length) return;
    v.body.append(el("div", { class: "ph-sec-h" }, el("h2", {}, title)));
    v.body.append(el("div", { class: "ph-group" }, ...items.map(f => {
      const b = row(IC.files, f.name, extOf(f.name).toUpperCase(), () => getFromPc(x, f));
      b.querySelector(".ph-ri").replaceWith(el("span", { class: "ph-lead" }, H.UI.badgeFor(f.name)));
      return b;
    })));
  };
  group(t("link.aperti_pc"), r.open);
  group(t("link.condivisi"), r.shared?.filter(s => !r.open?.some(o => o.path === s.path)));
  group(t("link.recenti_pc"), r.recent);
  if (!r.open?.length && !r.recent?.length && !r.shared?.length) v.body.append(el("p", { class: "lk-note" }, t("link.nessun_file_pc")));
  v.body.append(el("p", { class: "lk-note" }, t("link.file_pc_nota")));
}
async function getFromPc(x, f) {
  toast(t("link.richiesta_file", f.name), false, 4000);
  try { await x.link.request(pcOf(x.link).id, { t: "get", path: f.path }, null, 120000); } catch (e) { toast(e.message, true, 6000); }
}

// ---------------------------------------------------------------- ricezione dal PC
async function onFile(x, { file, meta }) {
  if (meta.kind === "doc-update") {
    const entry = [...docs.entries()].find(([, d]) => d.room === x.p.room && d.doc === meta.doc);
    const tab = entry && (window.MB?.tabs || []).find(tb => tb.path === entry[0]);
    if (entry) entry[1].ver = meta.ver;
    if (tab && !tab.dirty) {
      window.MBV_API.replace(tab.path, file);
      await window.MB.reloadTab?.(tab);
      toast(t("link.aggiornato_dal_pc", meta.name || file.name));
    } else if (tab) toast(t("link.versione_nuova_pc", meta.name || file.name), true, 8000);
    else { await H.store.put(file, file.name).catch(() => {}); toast(t("link.aggiornato_dal_pc", meta.name || file.name)); }
    return;
  }
  // documento (o file) dal PC: si apre e resta collegato all'originale
  const path = window.MBV_API.register(file, file.name);
  if (meta.doc) docs.set(path, { room: x.p.room, doc: meta.doc, ver: meta.ver, name: file.name });
  toast(t("link.ricevuto_dal_pc", file.name));
  H.haptic(20);
  await H.UI.openFile(path);
}
function onMsg(x, { h }) {
  if (h.t === "clip") { clips.unshift({ text: h.text, t: Date.now(), from: x.p.name }); clips.length = Math.min(clips.length, 20); clipBanner(h.text); document.dispatchEvent(new CustomEvent("mbv-link")); }
  else if (h.t === "doc-ack") { for (const d of docs.values()) if (d.room === x.p.room && d.doc === h.doc) d.ver = h.ver; toast(t("link.salvato_anche_pc", x.p.name)); }
  else if (h.t === "doc-conflict") toast(t("link.conflitto_telefono", h.copy), true, 9000);
  else if (h.t === "unpair") { toast(t("link.scollegato_dal_pc", x.p.name), true, 7000); forget(x); }
}
// salvataggio sul telefono di un documento arrivato dal PC: la versione va al PC (niente foglio Condividi/Scarica)
function onSaved(path, blob) {
  const d = docs.get(path);
  if (!d) return false;
  const x = links.get(d.room);
  if (!x || !pcOf(x.link)) { toast(t("link.pc_non_raggiungibile_salvataggio"), true, 6000); return false; }
  pushDoc(path, blob);
  return true;
}
function pushDoc(path, blob) {
  const d = docs.get(path), x = links.get(d.room);
  return x.link.sendFile(new File([blob], d.name, { type: blob.type }), { kind: "doc-save", doc: d.doc, base: d.ver, name: d.name }, pcOf(x.link).id)
    .catch(e => toast(t("link.invio_non_riuscito") + " " + e.message, true, 6000));
}

// ---------------------------------------------------------------- appunti
function clipBanner(text) {
  document.querySelector(".lk-banner")?.remove();
  const copy = el("button", { type: "button", class: "lk-btn primary" }, t("link.copia"));
  const b = el("div", { class: "lk-banner", role: "status" }, el("div", { class: "lk-bt" }, el("b", {}, t("link.testo_dal_pc")), el("span", {}, text.slice(0, 140))), copy,
    el("button", { type: "button", class: "lk-x", "aria-label": t("common.chiudi"), html: IC.x, onclick: () => b.remove() }));
  copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(text); toast(t("link.copiato")); } catch { toast(t("link.copia_non_riuscita"), true); } b.remove(); });
  document.body.append(b);
  setTimeout(() => b.remove(), 15000);
}
function clipView(x) {
  const v = H.pushView({ title: t("link.appunti") });
  const ta = el("textarea", { class: "lk-ta", placeholder: t("link.scrivi_incolla") });
  const draw = () => {
    if (!v.el.isConnected) return document.removeEventListener("mbv-link", draw);
    list.innerHTML = "";
    if (!clips.length) list.append(el("p", { class: "lk-note" }, t("link.nessun_testo_pc")));
    for (const c of clips) list.append(el("div", { class: "lk-clip" }, el("span", {}, c.text.slice(0, 400)),
      el("button", { type: "button", class: "lk-btn", onclick: async () => { try { await navigator.clipboard.writeText(c.text); toast(t("link.copiato")); } catch { toast(t("link.copia_non_riuscita"), true); } } }, t("link.copia"))));
  };
  const list = el("div", { class: "lk-clips" });
  v.body.append(el("div", { class: "lk-sec" },
    el("button", { type: "button", class: "lk-btn", onclick: async () => { try { ta.value = await navigator.clipboard.readText(); } catch { toast(t("link.incolla_a_mano"), true, 5000); ta.focus(); } } }, t("link.incolla_appunti")),
    ta,
    el("button", { type: "button", class: "lk-btn primary", onclick: async () => {
      if (!ta.value.trim()) return;
      try { await x.link.send({ t: "clip", text: ta.value }, null, pcOf(x.link)?.id); toast(t("link.inviato_appunti_pc")); ta.value = ""; } catch (e) { toast(e.message, true); }
    } }, t("link.invia_al_pc"))),
    el("div", { class: "ph-sec-h" }, el("h2", {}, t("link.dal_pc"))), list);
  document.addEventListener("mbv-link", draw);
  draw();
}

// ---------------------------------------------------------------- telecomando
function remoteView(x) {
  const v = H.pushView({ title: t("link.telecomando") });
  const pcId = () => pcOf(x.link)?.id;
  const send = h => { const id = pcId(); if (id) x.link.send({ t: "rc", ...h }, null, id).catch(() => {}); };
  const img = el("img", { class: "lk-shot", alt: "" });
  const pad = el("div", { class: "lk-pad" }, img, el("span", { class: "lk-padhint" }, t("link.pad_hint")));
  const tabs = el("div", { class: "lk-tabs" });
  const info = el("div", { class: "lk-rinfo" });
  let mode = "rotate", snapping = false, again = false, url = null;
  const snap = async () => {
    if (snapping) { again = true; return; }
    snapping = true;
    try {
      const st = (await x.link.request(pcId(), { t: "rc-state" })).h;
      tabs.innerHTML = "";
      for (const tb of st.tabs || []) tabs.append(el("button", { type: "button", class: "lk-chip" + (tb.active ? " on" : ""), onclick: () => { send({ a: "tab", i: tb.i }); setTimeout(snap, 350); } }, tb.name));
      info.textContent = st.pages ? t("link.pagina_di", st.page, st.pages) : st.name || t("link.nessun_documento_pc");
      seg.hidden = st.kind !== "3d";
      const r = await x.link.request(pcId(), { t: "snap" });
      if (r.data?.length) { if (url) URL.revokeObjectURL(url); url = URL.createObjectURL(new Blob([r.data], { type: "image/jpeg" })); img.src = url; }
    } catch { /* PC occupato o scollegato */ }
    snapping = false;
    if (again) { again = false; setTimeout(snap, 50); }
  };
  // gesti: un dito = ruota (3D) o sposta, due dita = zoom
  const pts = new Map();
  let last = null, pinch0 = 0, moved = false, tick = 0;
  pad.addEventListener("pointerdown", e => {
    pad.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 1) { last = [e.clientX, e.clientY]; moved = false; send({ a: "drag", phase: "start", btn: mode === "pan" ? "pan" : "rotate" }); }
    if (pts.size === 2) { send({ a: "drag", phase: "end" }); const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a[0] - b[0], a[1] - b[1]); }
  });
  pad.addEventListener("pointermove", e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 1 && last) {
      const dx = e.clientX - last[0], dy = e.clientY - last[1];
      if (Math.abs(dx) + Math.abs(dy) < 2) return;
      last = [e.clientX, e.clientY]; moved = true;
      send({ a: "drag", phase: "move", dx, dy });
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch0 && Math.abs(d / pinch0 - 1) > 0.08) { send({ a: "zoom", f: d / pinch0 }); pinch0 = d; moved = true; }
    }
    if (moved && Date.now() - tick > 450) { tick = Date.now(); snap(); }
  });
  const up = e => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size === 0) { if (last) send({ a: "drag", phase: "end" }); last = null; setTimeout(snap, 120); }
  };
  pad.addEventListener("pointerup", up); pad.addEventListener("pointercancel", up);
  const seg = el("div", { class: "ph-seg ph-seg-sm lk-seg" }, ...[["rotate", t("link.ruota")], ["pan", t("link.sposta")]].map(([k, l]) =>
    el("button", { type: "button", class: k === mode ? "on" : "", onclick: e => { mode = k; seg.querySelectorAll("button").forEach(b => b.classList.toggle("on", b === e.currentTarget)); } }, l)));
  const b = (label, h) => el("button", { type: "button", class: "lk-btn", onclick: () => { H.haptic(); send(h); setTimeout(snap, 250); } }, label);
  v.body.append(tabs, info, pad, seg, el("div", { class: "lk-rbtns" },
    b(t("link.pagina_prec"), { a: "page", d: -1 }), b(t("link.pagina_succ"), { a: "page", d: 1 }),
    b("−", { a: "zoom", f: 0.8 }), b("+", { a: "zoom", f: 1.25 }), b(t("link.adatta"), { a: "fit" }),
    el("button", { type: "button", class: "lk-btn", onclick: snap }, t("link.aggiorna"))));
  const iv = setInterval(() => { if (!v.el.isConnected) return clearInterval(iv); if (document.visibilityState === "visible" && !pts.size) snap(); }, 3000);
  snap();
}
