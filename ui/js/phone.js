// Interfaccia per telefono (lato corto sotto i 600 px, verticale e orizzontale): un guscio da app mobile al posto della
// cornice del PC. Si carica solo sui telefoni (classe "phone" su <html>, decisa in index.html prima del primo disegno).
// - barra in basso con 5 schede: Home (recenti), File (dispositivo e cloud del sistema), Scansiona, Strumenti, Account
// - schermate con titolo grande che si riduce scorrendo; recenti salvati nel dispositivo (phonestore.js) con miniatura
// - visualizzatori a tutto schermo: barra in alto (indietro, nome, condividi, altro) che si nasconde con un tocco,
//   strumenti del visualizzatore (la sua barra .tb) in un foglio dal basso, pannelli (layer, albero BIM, livelli,
//   pagine e segnalibri dei PDF) come fogli trascinabili; doppio tocco = zoom; tasto/gesto indietro di sistema
// - menu come fogli di azioni in basso, finestre a tutta altezza con "Fine" (core.js modal), avvisi in basso
// I visualizzatori non cambiano: si adattano la loro barra e il loro pannello laterale (classi ph-*, ui/css/phone.css).
import { el, fmtSize, toast, WEB, extOf } from "./core.js";
import { t, LANG, LANGS, MANUAL, LOCALE, setLanguage } from "./i18n.js";
import * as store from "./phonestore.js";

const root = document.documentElement;
const $ = id => document.getElementById(id);
const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
let UI = null;        // funzioni dell'app (app.js): apertura, salvataggio, nuovo, scansione...
let screen = "home";  // scheda della barra in basso
const S = {};         // schermate { home, files, tools, account }

const I = d => `<svg viewBox="0 0 24 24">${d.startsWith("<") ? d : `<path d="${d}"/>`}</svg>`;
const ICON = {
  home: I("M4 11l8-6 8 6v9H4zM10 20v-5h4v5"),
  files: I("M3 6h6l2 2h10v11H3zM3 10h18"),
  mail: I('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5l8.5 6.5 8.5-6.5"/>'),
  scan: I("M3 8V4h4M17 4h4v4M21 16v4h-4M7 20H3v-4M7 9h10M7 12h10M7 15h6"),
  tools: I('<rect x="4" y="4" width="7" height="7" rx="1.8"/><rect x="13" y="4" width="7" height="7" rx="1.8"/><rect x="4" y="13" width="7" height="7" rx="1.8"/><path d="M16.5 13.5v6M13.5 16.5h6"/>'),
  account: I('<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20.5c1-3.6 3.9-5.5 7.5-5.5s6.5 1.9 7.5 5.5"/>'),
  back: I("M15 5l-7 7 7 7"),
  share: I("M12 3.5v11M8 7.5l4-4 4 4M6 11.5H5v9h14v-9h-1"),
  more: I('<circle cx="5.5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor"/>'),
  sheet: I('<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M3.5 13h17M10 16.5h4"/>'),
  sliders: I('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  open: I("M3 7h6l2 2h10v10H3z"),
  plus: I("M12 5v14M5 12h14"),
  newdoc: I("M6 3h8l4 4v14H6zM14 3v4h4M12 11v6M9 14h6"),
  chev: I("M9 6l6 6-6 6"),
  search: I('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
  x: I("M6 6l12 12M18 6L6 18"),
  trash: I("M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"),
  camera: I('<path d="M3 7.5h4l2-3h6l2 3h4V19H3z"/><circle cx="12" cy="13" r="3.8"/>'),
  photo: I('<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="9.5" r="1.8"/><path d="M21 16l-5.5-5.5L5 20"/>'),
  compare: I("M4 4h7v16H4zM13 4h7v16h-7M8 9l-2 2 2 2M16 9l2 2-2 2"),
  merge: I("M5 3h7v7H5zM12 14h7v7h-7M8.5 10v4.5a2 2 0 0 0 2 2H12M15.5 14V9.5a2 2 0 0 0-2-2H12"),
  formats: I('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'),
  info: I('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
  save: I("M5 3h11l3 3v15H5zM8 3v6h8V3M8 21v-7h8v7"),
  saveas: I("M5 3h11l3 3v6M5 3v18h7M8 3v6h8V3M17 15v6M14 18h6"),
  viewas: I("M4 6h16M4 12h16M4 18h10"),
  download: I("M12 3v12M7 10l5 5 5-5M4 21h16"),
  key: I('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>'),
  devices: I('<rect x="2.5" y="5" width="13" height="10" rx="1.5"/><path d="M6 19h6M9 15v4"/><rect x="16.5" y="9" width="5" height="11" rx="1.2"/>'),
  flag: I("M5 21V4M5 4h11l-2 4 2 4H5"),
  swap: I("M7 7h12l-3-3M17 17H5l3 3"),
  theme: I("M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z"),
  globe: I('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>'),
  disk: I('<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>'),
  pdf: I("M6 3h8l4 4v14H6zM14 3v4h4M9 13h6M9 17h4"),
  cad: I("M4 4h16v16H4zM14 14h6M14 14v6M4 9h5V4"),
  cube: I("M12 2.5l8.5 4.7v9.6L12 21.5l-8.5-4.7V7.2zM12 12l8.5-4.8M12 12v9.5M12 12L3.5 7.2"),
  office: I('<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 10h16M4 15h16M10 4v16"/>'),
  map: I("M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14"),
  page: I('<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M9 8h6M9 12h6M9 16h3"/>'),
  highlight: I("M4 20h7M14.5 4.5l5 5-8 8H6.5v-5z"),
  text: I("M5 5h14M12 5v14M9 19h6"),
  ink: I("M4 20l4-1L19 8l-3-3L5 16zM14 7l3 3"),
  image: I('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9.5" r="1.6"/><path d="M21 15.5l-5-5L5 20"/>'),
  up: I("M6 15l6-6 6 6"),
  down: I("M6 9l6 6 6-6"),
};

export const haptic = (ms = 8) => { try { navigator.vibrate?.(ms); } catch { /* */ } };
const ap = (parent, ...kids) => { for (const k of kids.flat()) if (k) parent.append(k); return parent; };
const btn = (cls, icon, label, onclick, attrs = {}) => {
  const b = el("button", { type: "button", class: cls, onclick, ...attrs });
  if (icon) b.insertAdjacentHTML("beforeend", ICON[icon] || icon);
  if (label) b.append(el("span", {}, label));
  return b;
};

// ------------------------------------------------------------------ fogli di azioni (menu in basso)
let scrim = null;
const openSheets = [];
function ensureScrim() {
  if (scrim) return scrim;
  scrim = el("div", { class: "ph-scrim", hidden: true });
  scrim.addEventListener("click", () => closeTop());
  document.body.append(scrim);
  return scrim;
}
function showScrim(on) { ensureScrim(); scrim.hidden = !on && !openSheets.length; }
function closeTop() { const s = openSheets[openSheets.length - 1]; if (s) s.close(); return !!s; }

// items: [{ label, icon, run, danger, disabled, sub }] oppure "sep"; restituisce una Promise (true se scelto)
export function actionSheet({ title, sub, items, cancel = true }) {
  return new Promise(resolve => {
    const box = el("div", { class: "ph-asheet", role: "menu" });
    const grp = el("div", { class: "ph-agroup" });
    if (title) grp.append(el("div", { class: "ph-atitle" }, el("b", {}, title), sub ? el("span", {}, sub) : null));
    let done = false;
    const close = (v = false) => {
      if (done) return; done = true;
      openSheets.splice(openSheets.indexOf(entry), 1);
      box.classList.add("out");
      setTimeout(() => box.remove(), 200);
      showScrim(false);
      resolve(v);
    };
    for (const it of items) {
      if (!it) continue;
      if (it === "sep") { grp.append(el("hr")); continue; }
      const b = btn("ph-aitem" + (it.danger ? " danger" : ""), it.icon, null, () => { haptic(); close(true); setTimeout(() => it.run?.(), 30); }, { disabled: it.disabled || undefined, role: "menuitem" });
      b.append(el("span", { class: "ph-alab" }, it.label, it.sub ? el("small", {}, it.sub) : null));
      grp.append(b);
    }
    box.append(grp);
    if (cancel) box.append(el("button", { type: "button", class: "ph-acancel", onclick: () => close(false) }, t("common.annulla")));
    const entry = { close: () => close(false) };
    openSheets.push(entry);
    showScrim(true);
    document.body.append(box);
    haptic(6);
  });
}

// file da salvare (la web app scarica i file): sul telefono si sceglie tra condividere (iOS: "Salva in File") e scaricare
export function deliver(name, blob) {
  const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
  const canShare = !!navigator.canShare?.({ files: [file] });
  const down = () => { const a = el("a", { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); toast(t("ph.scaricato", name)); };
  actionSheet({ title: name, sub: fmtSize(blob.size), items: [
    canShare ? { label: t(IS_IOS ? "ph.salva_in_file" : "ph.condividi_salva"), icon: "share", run: () => navigator.share({ files: [file], title: name }).catch(() => {}) } : null,
    { label: t("ph.scarica"), icon: "download", run: down },
  ] });
  return true;
}

// ------------------------------------------------------------------ fogli trascinabili (pannelli dei visualizzatori)
// stati: "closed" | "half" | "full". In orizzontale il foglio diventa un pannello laterale a sinistra.
function sheetify(panel, { title, onState } = {}) {
  if (panel.dataset.phSheet) return panel._ph;
  panel.dataset.phSheet = "1";
  panel.classList.add("ph-psheet");
  if (title) panel.dataset.phTitle = title;
  let state = "closed";
  const H = () => (window.visualViewport?.height || innerHeight);
  // pieno = fino sotto la barra del documento (indietro resta raggiungibile)
  const heights = () => ({ half: Math.round(H() * 0.48), full: Math.round(H() - Math.max(document.querySelector(".ph-vbar")?.getBoundingClientRect().bottom || 0, parseFloat(getComputedStyle(root).getPropertyValue("--ph-st")) || 0) - 6) });
  const land = () => innerWidth > innerHeight;
  const apply = (s, anim = true) => {
    state = s;
    panel.classList.toggle("ph-anim", anim);
    panel.dataset.phState = s;
    if (!land()) panel.style.height = s === "closed" ? "" : heights()[s] + "px"; else panel.style.height = "";
    onState?.(s);
    root.classList.toggle("ph-panel-open", s !== "closed");
    window.dispatchEvent(new Event("resize")); // alberi e tabelle virtuali ricalcolano le righe visibili
  };
  // trascinamento dalla maniglia (fascia in alto del foglio)
  let drag = null;
  panel.addEventListener("pointerdown", e => {
    if (land() || state === "closed") return;
    const r = panel.getBoundingClientRect();
    if (e.clientY - r.top > 34) return;
    drag = { y: e.clientY, h: r.height, t: performance.now(), id: e.pointerId, moved: false };
    panel.setPointerCapture?.(e.pointerId);
    panel.classList.remove("ph-anim");
    e.preventDefault();
  });
  panel.addEventListener("pointermove", e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    if (Math.abs(dy) > 4) drag.moved = true;
    panel.style.height = Math.max(60, Math.min(heights().full, drag.h - dy)) + "px";
  });
  const end = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if (!d.moved) { apply(state === "half" ? "full" : "half"); return; } // tocco sulla maniglia: mezzo <-> pieno
    const h = panel.getBoundingClientRect().height, v = (e.clientY - d.y) / Math.max(1, performance.now() - d.t); // px/ms, positivo = verso il basso
    const { half, full } = heights();
    let s = v > 0.6 ? (h > half + 40 ? "half" : "closed") : v < -0.6 ? "full" : [["closed", 0], ["half", half], ["full", full]].sort((a, b) => Math.abs(a[1] - h) - Math.abs(b[1] - h))[0][0];
    haptic(6);
    apply(s);
  };
  panel.addEventListener("pointerup", end);
  panel.addEventListener("pointercancel", end);
  addEventListener("resize", () => { if (state !== "closed" && !drag) { if (!land()) panel.style.height = heights()[state] + "px"; else panel.style.height = ""; } });
  apply("closed", false);
  const api = { get state() { return state; }, open: (s = "half") => apply(s), close: () => apply("closed"), toggle: () => apply(state === "closed" ? "half" : "closed") };
  panel._ph = api;
  return api;
}

// ------------------------------------------------------------------ guscio: schermate, barra in basso, barra del documento
let nav, vbar, dock, vtitle, vsub, toolsBtn, panelBtn, pagePill, modeChip;
function buildShell() {
  const app = el("div", { id: "ph-app" });
  nav = el("nav", { class: "ph-nav", role: "tablist" });
  const tabs = [["home", "home", t("app.home")], ["files", "files", t("ph.file")], ["scan", "scan", t("ph.scansiona")], ["mail", "mail", t("mail.posta")], ["account", "account", t("ph.account")]];
  for (const [id, icon, label] of tabs) {
    const b = btn("ph-tab" + (id === "scan" ? " ph-tab-scan" : ""), null, null, () => go(id), { "data-tab": id, role: "tab", "aria-label": label });
    b.append(el("span", { class: "ph-ti", html: ICON[icon] }, id === "mail" ? el("i", { class: "ph-badge", hidden: true }) : null), el("span", { class: "ph-tl" }, label));
    nav.append(b);
  }
  S.home = makeScreen("home", "MB Visual", buildHome);
  S.files = makeScreen("files", t("ph.file"), buildFiles);
  S.mail = makeScreen("mail", t("mail.posta"), s => import("./mmail.js").then(m => m.buildMail(s, mailHelpers())));
  S.account = makeScreen("account", t("ph.account"), buildAccount);
  ap(app, S.home.el, S.files.el, S.mail.el, S.account.el);
  // barra del documento aperto
  vtitle = el("b", {}); vsub = el("span", {});
  vbar = el("header", { class: "ph-vbar" },
    btn("ph-vb ph-back", "back", null, () => UI.goBack(), { "aria-label": t("common.indietro") }),
    el("div", { class: "ph-vt" }, vtitle, vsub),
    btn("ph-vb", "share", null, () => shareActive(), { "aria-label": t("ph.condividi"), class: "ph-vb ph-share" }),
    btn("ph-vb", "more", null, () => moreMenu(), { "aria-label": t("ph.altro") }));
  toolsBtn = btn("ph-dk", "sliders", t("ph.strumenti"), () => openTools());
  panelBtn = btn("ph-dk", "sheet", t("ph.pannello"), () => togglePanel());
  pagePill = el("button", { type: "button", class: "ph-dk ph-pg", hidden: true });
  modeChip = el("button", { type: "button", class: "ph-dk ph-mode", hidden: true });
  dock = el("div", { class: "ph-dock" }, modeChip, pagePill, panelBtn, toolsBtn);
  document.body.append(app, nav, vbar, dock);
  ensureScrim();
}

function makeScreen(id, title, build) {
  const large = el("h1", { class: "ph-large" }, title);
  const headT = el("span", { class: "ph-head-t" }, title);
  const act = el("span", { class: "ph-head-act" });
  const scroll = el("div", { class: "ph-scroll" }, large);
  const sec = el("section", { class: "ph-screen", "data-s": id, hidden: id !== "home" }, el("header", { class: "ph-head" }, headT, act), scroll);
  scroll.addEventListener("scroll", () => sec.classList.toggle("ph-scrolled", scroll.scrollTop > large.offsetTop + large.offsetHeight - 50), { passive: true });
  const s = { el: sec, scroll, large, act, body: el("div", { class: "ph-body" }), refresh: () => build(s) };
  scroll.append(s.body);
  return s;
}

function go(id) {
  if (id === "scan") { haptic(); return UI.doScan(); }
  if (id === screen) { S[id].scroll.scrollTo({ top: 0, behavior: "smooth" }); return; }
  haptic();
  screen = id;
  for (const [k, s] of Object.entries(S)) s.el.hidden = k !== id;
  S[id].refresh();
  sync();
}

// stato dell'interfaccia: schermate, documento aperto o pagina Formati
let lastMode = "", lastTab = null;
export function sync() {
  const MB = window.MB;
  const fmt = !$("formats").hidden;
  const active = MB?.active;
  const mode = fmt ? "push" : active ? "viewer" : "screens";
  root.dataset.ph = mode;
  for (const b of nav.children) b.classList.toggle("on", b.dataset.tab === screen);
  if (mode !== lastMode || active !== lastTab) {
    if (mode !== "viewer") setImmersive(false);
    if (mode === "screens" && lastMode && lastMode !== "screens") S[screen].refresh();
    lastMode = mode; lastTab = active;
  }
  // colore della barra di stato del sistema: grafite sui documenti, colore della schermata altrove
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = mode === "screens" ? getComputedStyle(document.body).backgroundColor : "#0f1114";
  if (mode === "push") { vtitle.textContent = t("idx.formati"); vsub.textContent = ""; for (const x of [toolsBtn, panelBtn, pagePill, modeChip]) x.hidden = true; vbar.querySelector(".ph-share").hidden = true; vbar.lastChild.hidden = true; return; }
  vbar.lastChild.hidden = false;
  if (mode !== "viewer") return;
  vbar.querySelector(".ph-share").hidden = !WEB || !active.path.startsWith("web://");
  root.classList.toggle("ph-strip", !!active.view?.querySelector(".ps-root")); // editor di immagini: striscia di strumenti in basso
  vtitle.textContent = active.name;
  vsub.textContent = (active.dirty ? "● " : "") + (UI.viewerName(active.viewer) || "");
  updateDock(active);
}

function updateDock(tab) {
  const ph = tab.ph || {};
  const tb = tab.view?.querySelector(":scope > .tb");
  toolsBtn.hidden = !tb || !tb.children.length;
  panelBtn.hidden = !ph.panel;
  pagePill.hidden = !ph.page;
  if (ph.page) pagePill.textContent = ph.page;
  modeChip.hidden = !ph.mode;
  if (ph.mode) { modeChip.innerHTML = ""; modeChip.append(el("span", {}, ph.mode.label)); modeChip.insertAdjacentHTML("beforeend", ICON.x); modeChip.onclick = ph.mode.exit; }
  dock.hidden = toolsBtn.hidden && panelBtn.hidden && pagePill.hidden && modeChip.hidden;
}

// ------------------------------------------------------------------ barra che si nasconde (tocco sul documento, scorrimento)
function setImmersive(on) {
  if (root.classList.contains("ph-imm") === on) return;
  root.classList.toggle("ph-imm", on);
}

// tocco singolo = mostra/nasconde le barre; doppio tocco = zoom (rotella simulata sui disegni, pdf.js nei PDF)
const INTERACTIVE = "button, a, input, select, textarea, label, summary, [contenteditable=''], [contenteditable='true'], [role=button], [role=tab], .tree, .ph-psheet, .tb, .ol-control, .ol-overlay-container, .cmp-bar, .gis-left, .gis-table, .ps-options, .ps-tools, .ps-panels, .monaco-editor, .cad-cmdline";
function bindTaps(target, tab, { onDouble } = {}) {
  let last = null, timer = 0, start = null;
  target.addEventListener("touchstart", e => {
    start = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: performance.now(), multi: false } : (start && (start.multi = true), start);
  }, { passive: true, capture: true });
  target.addEventListener("touchend", e => {
    if (!start || e.touches.length) return;
    const p = e.changedTouches[0], s = start; start = null;
    if (s.multi || performance.now() - s.t > 280 || Math.hypot(p.clientX - s.x, p.clientY - s.y) > 10) return;
    const tgt = e.target;
    if (tgt.closest?.(INTERACTIVE) || tab.view.querySelector(".ps-root, .pb-root, .vs-root, .ve-root")) { last = null; return; }
    const now = performance.now();
    if (last && now - last.t < 320 && Math.hypot(p.clientX - last.x, p.clientY - last.y) < 36) {
      clearTimeout(timer); last = null;
      if (onDouble?.(p.clientX, p.clientY, tgt, e)) e.preventDefault(); // niente dblclick del visualizzatore (es. "adatta")
      return;
    }
    last = { t: now, x: p.clientX, y: p.clientY };
    clearTimeout(timer);
    timer = setTimeout(() => { last = null; if (window.MB?.active === tab && !openSheets.length) setImmersive(!root.classList.contains("ph-imm")); }, 330);
  }, { capture: true });
}
// zoom con la rotella simulata (CAD, DWF, HP-GL, confronto, immagini, 3D): +2 scatti dove si tocca
function wheelZoom(x, y, target) {
  const c = target.closest?.("canvas") || (target.tagName === "CANVAS" ? target : null);
  if (!c || c.closest(".ol-viewport")) return false; // le mappe hanno il loro doppio tocco
  for (let i = 0; i < 4; i++) c.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY: -100, deltaMode: 0, ctrlKey: true }));
  haptic(5);
  return true;
}

// ------------------------------------------------------------------ dopo il caricamento di un visualizzatore
export function afterMount(ctx) {
  const tab = ctx.tab;
  if (!tab || tab.preview) return;
  tab.ph = tab.ph || {};
  const tb = ctx.tb;
  tb.classList.add("ph-tools");
  tb.dataset.phTitle = t("ph.strumenti");
  // un comando scelto nel foglio degli strumenti chiude il foglio (se non ha aperto un menu o una finestra)
  tb.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b || b.disabled || !tb.classList.contains("ph-open")) return;
    setTimeout(() => { if (!menuOpen()) closeTools(); }, 90);
  });
  findPanel(ctx);
  bindTaps(ctx.el, tab, { onDouble: (x, y, tgt) => wheelZoom(x, y, tgt) });
  if (tab.viewer === "pdf") pdfAdapter(ctx).catch(e => console.warn(e));
  // scorrendo un documento verso il basso la barra si nasconde, verso l'alto ricompare
  let lastY = new WeakMap();
  ctx.el.addEventListener("scroll", e => {
    const s = e.target; if (!(s instanceof Element) || s.closest(".ph-psheet, .tb")) return;
    const y = s.scrollTop, py = lastY.get(s) ?? y; lastY.set(s, y);
    if (Math.abs(y - py) < 6) return;
    setImmersive(y > py && y > 40);
  }, { capture: true, passive: true });
  remember(tab).catch(() => {});
  sync();
}

function findPanel(ctx) {
  const SEL = ".side > :first-child, .gis > .gis-left, .cmp-root > .cmp-side";
  const tab = ctx.tab;
  const p = ctx.el.querySelector(SEL);
  if (!p) {
    const mo = new MutationObserver(() => { if (ctx.el.querySelector(SEL)) { mo.disconnect(); findPanel(ctx); } });
    mo.observe(ctx.el, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 20000);
    return;
  }
  if (ctx.el.querySelector(".ps-root, .pb-root, .vs-root, .ve-root")) return; // editor con i loro pannelli
  const title = { cad2d: t("ph.layer"), model3d: t("ph.modello"), gis: t("ph.livelli"), compare: t("ph.differenze"), dwf: t("ph.fogli") }[tab.viewer] || t("ph.pannello");
  tab.ph.panel = sheetify(p, { title, onState: s => panelBtn.classList.toggle("on", s !== "closed") });
  p.closest(".side, .gis, .cmp-root")?.classList.add("ph-has-sheet");
  if (window.MB?.active === tab) updateDock(tab);
}

function togglePanel() {
  const p = window.MB?.active?.ph?.panel;
  if (!p) return;
  haptic();
  p.toggle();
}

// ------------------------------------------------------------------ foglio degli strumenti (la barra .tb del visualizzatore)
const MENU_SEL = ".menu:not([hidden]), .ps-menu, .pb-pop, .pb-menu, .vs-pop, .vs-menu, .cad-menu:not([hidden]), .cad-snapmenu:not([hidden]), .ps-fly, .ps-dlg, .modal-back:not([hidden]), .nf-back, .ph-asheet, .scn-root, .ar-overlay";
const menuOpen = () => [...document.querySelectorAll(MENU_SEL)].some(m => m.getClientRects().length);
let toolsEntry = null;
function openTools() {
  const tab = window.MB?.active;
  const tb = tab?.view?.querySelector(":scope > .tb");
  if (!tb || toolsEntry) return;
  haptic();
  // pulsanti con la sola icona (zoom, ruota...): nel foglio serve anche il nome, preso dal suggerimento
  for (const x of tb.querySelectorAll(":scope > button, :scope > .menu-wrap > button")) {
    if (x.textContent.trim() || x.querySelector(".ph-lab") || !x.title) continue;
    x.append(el("span", { class: "ph-lab" }, x.title.split(/\s+\(|\s+-\s+|[.:]\s/)[0]));
  }
  tb.classList.add("ph-open");
  tb.scrollTop = 0;
  toolsEntry = { close: () => closeTools() };
  openSheets.push(toolsEntry);
  showScrim(true);
  root.classList.add("ph-tools-open");
}
function closeTools() {
  if (!toolsEntry) return;
  openSheets.splice(openSheets.indexOf(toolsEntry), 1);
  toolsEntry = null;
  for (const tb of document.querySelectorAll(".tb.ph-open")) tb.classList.remove("ph-open");
  root.classList.remove("ph-tools-open");
  showScrim(false);
}

// ------------------------------------------------------------------ condividi, altro
function shareActive() {
  const tab = window.MB?.active;
  if (!tab || !tab.path.startsWith("web://")) return;
  let blob;
  try { blob = window.MBV_API.blobOf(tab.path); } catch (e) { return toast(e.message, true); }
  const name = tab.info?.nome || tab.name;
  const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
  if (navigator.canShare?.({ files: [file] })) navigator.share({ files: [file], title: name }).catch(() => {}); // nello stesso tocco: Safari lo richiede
  else deliver(name, blob);
}

function moreMenu() {
  const tab = window.MB?.active;
  if (!tab) return;
  const a = tab.api || {};
  const name = tab.info?.nome || tab.name;
  const cmp = /^(pdf|dwg|dxf|ifc)$/.test(extOf(name)) && tab.viewer !== "compare";
  actionSheet({ title: name, sub: UI.viewerName(tab.viewer), items: [
    a.save ? { label: t("common.salva"), icon: "save", run: () => UI.save(false) } : null,
    { label: t("app.salva_nome"), icon: "saveas", run: () => UI.save(true) },
    WEB && tab.path.startsWith("web://") ? { label: t("ph.condividi"), icon: "share", run: shareActive } : null,
    "sep",
    { label: t("idx.apri_come"), icon: "viewas", run: () => openAsSheet(tab) },
    cmp ? { label: t("app.confronta_con"), icon: "compare", run: () => UI.compareWith() } : null,
    { label: t("idx.proprieta"), icon: "info", run: () => UI.showProperties() },
    WEB && tab.path.startsWith("web://") ? { label: t("mm.invia_email"), icon: "mail", run: () => mailFile(tab) } : null,
    WEB && tab.path.startsWith("web://") && window.MBLinkPhone?.online ? { label: t("link.invia_al_pc"), icon: "share", run: () => window.MBLinkPhone.sendTab(tab) } : null,
    "sep",
    { label: t("ph.chiudi_file"), icon: "x", danger: true, run: () => window.MB.closeTab(tab) },
  ] });
}

function openAsSheet(tab) {
  const list = UI.compatibleViewers(tab);
  actionSheet({ title: t("idx.apri_come"), sub: tab.name, items: list.map(v => ({
    label: UI.viewerName(v), sub: v === tab.viewer ? t("app.uso").trim() : null, disabled: v === tab.viewer,
    run: () => window.MB.openFile(tab.path, v, { fresh: true }),
  })) });
}

// ------------------------------------------------------------------ PDF: pagina, ricerca, annotazioni, pagine e segnalibri
const PDF_HIDE = `#toolbarContainer, #secondaryToolbar, #findbar, #sidebarContainer { display: none !important; }
  html:root { --toolbar-height: 0px !important; }
  #viewerContainer { inset-block-start: 0 !important; top: 0 !important; inset-inline-start: 0 !important; left: 0 !important; }
  #outerContainer.sidebarOpen #viewerContainer { inset-inline-start: 0 !important; }
  .pdfViewer .page { margin: 10px auto !important; border: 0 !important; box-shadow: 0 1px 3px rgba(0,0,0,.25), 0 6px 18px -8px rgba(0,0,0,.35); }
  body { -webkit-tap-highlight-color: transparent; }`;
async function pdfAdapter(ctx) {
  const tab = ctx.tab;
  const frame = ctx.el.querySelector("iframe");
  if (!frame) return;
  let w = null;
  for (let i = 0; i < 100 && !(w = frame.contentWindow)?.PDFViewerApplication; i++) await new Promise(r => setTimeout(r, 100));
  const app = w?.PDFViewerApplication;
  if (!app) return;
  await app.initializedPromise;
  const doc = frame.contentDocument;
  doc.head.append(Object.assign(doc.createElement("style"), { textContent: PDF_HIDE }));
  bindTaps(doc, tab, { onDouble: () => { if (app.pdfViewer.currentScaleValue === "page-width") app.pdfViewer.increaseScale({ steps: 3 }); else app.pdfViewer.currentScaleValue = "page-width"; haptic(5); return true; } });
  let lastY = 0;
  doc.getElementById("viewerContainer")?.addEventListener("scroll", e => { const y = e.target.scrollTop; if (Math.abs(y - lastY) > 8) { setImmersive(y > lastY && y > 40); lastY = y; } }, { passive: true });
  const upd = () => { tab.ph.page = app.pagesCount ? `${app.page} / ${app.pagesCount}` : ""; if (window.MB.active === tab) updateDock(tab); };
  app.eventBus.on("pagechanging", upd);
  app.eventBus.on("pagesloaded", () => { upd(); if (app.pdfViewer.currentScaleValue !== "page-width" && innerWidth < innerHeight) app.pdfViewer.currentScaleValue = "page-width"; });
  upd();
  pagePill.onclick = null;
  // vai alla pagina
  const gotoPage = async () => {
    const inp = el("input", { type: "number", inputmode: "numeric", min: 1, max: app.pagesCount, value: app.page, class: "ph-num" });
    inp.addEventListener("keydown", e => { if (e.key === "Enter") document.querySelector("#modal .btn.primary")?.click(); });
    const n = await window.MB.modal(t("ph.vai_pagina"), el("label", { class: "ph-numwrap" }, inp, el("span", {}, t("ph.di_n", app.pagesCount))),
      [{ label: t("common.annulla"), value: null }, { label: t("ph.vai"), value: () => +inp.value, primary: true }]);
    if (n >= 1 && n <= app.pagesCount) app.page = Math.round(n);
  };
  tab.ph.onPage = gotoPage;
  // annotazioni di pdf.js (evidenzia, testo, disegno, immagine): modalita' con il pulsante "fine" nella barra in basso
  const MODES = [["highlight", 9, t("ph.evidenzia")], ["text", 3, t("ph.testo")], ["ink", 15, t("ph.disegno")], ["image", 13, t("ph.immagine")]];
  const setMode = (m, label) => {
    app.eventBus.dispatch("switchannotationeditormode", { source: null, mode: m });
    tab.ph.mode = m ? { label, exit: () => setMode(0) } : null;
    updateDock(tab);
  };
  const bar = [
    btnTb("search", t("ph.cerca"), () => pdfFind(app, tab)),
    btnTb("page", t("ph.pagine_segnalibri"), () => tab.ph.panel?.open("half")),
    ...MODES.map(([icon, m, label]) => btnTb(icon, label, () => setMode(m, label))),
    el("span", { class: "sep" }),
  ];
  ctx.tb.prepend(...bar);
  // foglio "Pagine e segnalibri"
  const panel = el("div", { class: "ph-pdfpanel" });
  ctx.el.append(panel);
  tab.ph.panel = sheetify(panel, { title: t("ph.pagine_segnalibri"), onState: s => { panelBtn.classList.toggle("on", s !== "closed"); if (s !== "closed") fillPdfPanel(app, panel, tab); } });
  if (window.MB.active === tab) updateDock(tab);
}
const btnTb = (icon, label, fn) => { const b = el("button", { type: "button", title: label, onclick: fn }); b.insertAdjacentHTML("beforeend", ICON[icon]); b.append(label); return b; };

async function fillPdfPanel(app, panel, tab) {
  if (panel.dataset.done) { panel.querySelectorAll(".ph-thumb").forEach(x => x.classList.toggle("on", +x.dataset.p === app.page)); return; }
  panel.dataset.done = "1";
  const seg = el("div", { class: "ph-seg" });
  const pages = el("div", { class: "ph-thumbs" }), outline = el("div", { class: "ph-outline", hidden: true });
  const tabs = [[t("ph.pagine"), pages], [t("ph.segnalibri"), outline]];
  for (const [label, box] of tabs) seg.append(el("button", { type: "button", class: box === pages ? "on" : "", onclick: e => { for (const b of seg.children) b.classList.toggle("on", b === e.currentTarget); pages.hidden = box !== pages; outline.hidden = box !== outline; } }, label));
  panel.append(seg, pages, outline);
  const pdf = app.pdfDocument;
  const io = new IntersectionObserver(async ents => {
    for (const en of ents) {
      if (!en.isIntersecting || en.target.dataset.r) continue;
      en.target.dataset.r = "1";
      io.unobserve(en.target);
      try {
        const pg = await pdf.getPage(+en.target.dataset.p);
        const vp0 = pg.getViewport({ scale: 1 }), sc = 220 / vp0.width, vp = pg.getViewport({ scale: sc });
        const c = el("canvas", { width: Math.round(vp.width), height: Math.round(vp.height) });
        await pg.render({ canvasContext: c.getContext("2d"), viewport: vp, intent: "print" }).promise;
        en.target.querySelector("i").replaceWith(c);
      } catch { /* */ }
    }
  }, { root: panel });
  for (let n = 1; n <= pdf.numPages; n++) {
    const b = el("button", { type: "button", class: "ph-thumb" + (n === app.page ? " on" : ""), "data-p": n, onclick: () => { app.page = n; haptic(); if (innerWidth < innerHeight) tab.ph.panel.close(); } }, el("i"), el("span", {}, String(n)));
    pages.append(b);
    io.observe(b);
  }
  try {
    const ol = await pdf.getOutline();
    if (!ol?.length) outline.append(el("p", { class: "ph-empty" }, t("ph.nessun_segnalibro")));
    const add = (items, depth) => { for (const it of items || []) { outline.append(el("button", { type: "button", class: "ph-ol", style: { paddingLeft: 16 + depth * 16 + "px" }, onclick: () => { app.pdfLinkService.goToDestination(it.dest); haptic(); if (innerWidth < innerHeight) tab.ph.panel.close(); } }, it.title)); add(it.items, depth + 1); } };
    add(ol, 0);
  } catch { /* */ }
}

// barra di ricerca nel PDF, sopra la tastiera
function pdfFind(app, tab) {
  document.querySelector(".ph-find")?.remove();
  const input = el("input", { type: "search", placeholder: t("ph.cerca_documento"), enterkeyhint: "search" });
  const count = el("span", { class: "ph-fcount" });
  const find = (type = "", prev = false) => app.eventBus.dispatch("find", { source: null, type, query: input.value, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: prev, matchDiacritics: false });
  const box = el("div", { class: "ph-find" }, input, count,
    btn("ph-fb", "up", null, () => find("again", true), { "aria-label": t("ph.precedente") }),
    btn("ph-fb", "down", null, () => find("again", false), { "aria-label": t("ph.successivo") }),
    btn("ph-fb", "x", null, () => close(), { "aria-label": t("common.chiudi") }));
  const onCount = e => { const m = e.matchesCount || {}; count.textContent = input.value ? (m.total ? `${m.current} / ${m.total}` : "0") : ""; };
  app.eventBus.on("updatefindmatchescount", onCount);
  app.eventBus.on("updatefindcontrolstate", onCount);
  const close = () => { box.remove(); app.eventBus.dispatch("findbarclose", { source: null }); const i = openSheets.indexOf(entry); if (i >= 0) openSheets.splice(i, 1); };
  const entry = { close };
  openSheets.push(entry);
  input.addEventListener("input", () => find(""));
  input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); find("again", e.shiftKey); } });
  document.body.append(box);
  input.focus();
  void tab;
}

// ------------------------------------------------------------------ recenti nel dispositivo
const thumbs = new Map(); // id -> object URL
async function remember(tab) {
  if (!WEB || !tab.path.startsWith("web://") || tab.untitled) return;
  const blob = window.MBV_API.blobOf(tab.path);
  const name = tab.info?.nome || tab.name;
  const id = await store.put(blob, name);
  tab.ph.recId = id;
  const rec = await store.get(id);
  if (rec?.thumb) return;
  // miniatura: le immagini dal file, gli altri dal disegno del visualizzatore appena pronto
  let th = null;
  if (/^image\//.test(blob.type) || /^(png|jpe?g|gif|webp|bmp|avif)$/.test(extOf(name))) th = await thumbFromBlob(blob);
  for (const wait of [1500, 3500, 7000]) {
    if (th) break;
    await new Promise(r => setTimeout(r, wait));
    if (!tab.view.isConnected) return;
    th = await thumbFromView(tab);
  }
  if (th) { await store.setThumb(id, th); thumbs.delete(id); }
}
async function thumbFromBlob(blob) {
  try { const bm = await createImageBitmap(blob); const r = toThumb(bm, bm.width, bm.height); bm.close?.(); return r; } catch { return null; }
}
function canvasesOf(tab) {
  const out = [...tab.view.querySelectorAll("canvas")];
  for (const f of tab.view.querySelectorAll("iframe")) try { out.push(...f.contentDocument.querySelectorAll(".page canvas, canvas")); } catch { /* */ }
  return out;
}
async function thumbFromView(tab) {
  const th = tab.three;
  if (th?.renderer) try { th.renderer.render(th.scene, th.camera); } catch { /* */ }
  const cs = canvasesOf(tab).filter(c => c.width > 60 && c.height > 60).sort((a, b) => b.width * b.height - a.width * a.height);
  for (const c of cs.slice(0, 3)) {
    try { const r = await toThumb(c, c.width, c.height, true); if (r) return r; } catch { /* tela "sporcata" o WebGL vuoto */ }
  }
  return null;
}
async function toThumb(src, w, h, checkBlank = false) {
  const W = 240, H = Math.round(W * 4 / 3);
  const c = el("canvas", { width: W, height: H });
  const g = c.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);

  const s = Math.min(W / w, H / h), dw = w * s, dh = h * s; // pagina intera (contain)
  g.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
  if (checkBlank) {
    const d = g.getImageData(0, 0, W, H).data;
    let min = 255, max = 0;
    for (let i = 0; i < d.length; i += 4 * 97) { const v = d[i] + d[i + 1] + d[i + 2]; if (v < min) min = v; if (v > max) max = v; }
    if (max - min < 24) return null;
  }
  return new Promise(r => c.toBlob(r, "image/jpeg", 0.78));
}
const thumbUrl = rec => { if (!rec.thumb) return null; if (!thumbs.has(rec.id)) thumbs.set(rec.id, URL.createObjectURL(rec.thumb)); return thumbs.get(rec.id); };

async function openRecent(rec) {
  haptic();
  const r = await store.get(rec.id);
  if (!r?.blob) return toast(t("ph.non_salvato_nel_dispositivo"), true, 5000);
  await window.MB.openFile(window.MBV_API.register(r.blob, r.name));
}

function relDate(ms) {
  const d = new Date(ms), now = new Date();
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  const time = d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
  if (diff === 0) return t("ph.oggi_ore", time);
  if (diff === 1) return t("ph.ieri_ore", time);
  return d.toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}
const typeOf = name => (extOf(name) || "?").toUpperCase();

function recentCard(rec, { onChange } = {}) {
  const url = thumbUrl(rec);
  const pic = el("span", { class: "ph-rthumb" + (url ? "" : " ph-rthumb-none") });
  if (url) pic.append(el("img", { src: url, alt: "", loading: "lazy" }));
  else pic.append(UI.badgeFor(rec.name));
  const more = btn("ph-rmore", "more", null, e => { e.stopPropagation(); recentMenu(rec, onChange); }, { "aria-label": t("ph.altro") });
  const card = el("div", { class: "ph-rcard", role: "button", tabindex: 0, onclick: () => openRecent(rec) }, pic,
    el("span", { class: "ph-rtext" }, el("b", {}, rec.name), el("small", {}, [typeOf(rec.name), fmtSize(rec.size), relDate(rec.t)].join(" · "), rec.blob ? null : el("em", {}, " · " + t("ph.solo_nome")))),
    more);
  card.addEventListener("contextmenu", e => { e.preventDefault(); recentMenu(rec, onChange); });
  return card;
}
function recentMenu(rec, onChange) {
  actionSheet({ title: rec.name, sub: `${fmtSize(rec.size)} · ${relDate(rec.t)}`, items: [
    { label: t("ph.apri"), icon: "open", run: () => openRecent(rec), disabled: !rec.blob },
    rec.blob ? { label: t("ph.condividi"), icon: "share", run: () => store.get(rec.id).then(r => r?.blob && deliver(r.name, r.blob)) } : null,
    { label: t("ph.rimuovi_recenti"), icon: "trash", danger: true, run: async () => { await store.remove(rec.id); thumbs.delete(rec.id); onChange?.(); } },
  ] });
}

const skeletonRows = n => Array.from({ length: n }, () => el("div", { class: "ph-rcard ph-skel" }, el("span", { class: "ph-rthumb" }), el("span", { class: "ph-rtext" }, el("i"), el("i"))));

// ------------------------------------------------------------------ apertura dal selettore del sistema
export function pick({ accept = "", multiple = true, capture = null } = {}) {
  return new Promise(resolve => {
    const inp = el("input", { type: "file", style: { display: "none" } });
    if (multiple) inp.multiple = true;
    if (accept && !(IS_IOS && /\.(dwg|dxf|ifc|step|stp|dwf|gpkg|kmz)/.test(accept))) inp.accept = accept; // iOS spegne i tipi che non conosce
    if (capture) inp.setAttribute("capture", capture);
    inp.addEventListener("change", () => { resolve([...inp.files].map(f => window.MBV_API.register(f, f.name))); inp.remove(); });
    inp.addEventListener("cancel", () => { resolve([]); inp.remove(); });
    document.body.append(inp);
    inp.click();
  });
}
async function openPicked(opts) { const ps = await pick(opts); if (ps.length) window.MB.openPaths(ps); }

const BY_TYPE = [
  ["pdf", "pdf", "ph.tipo_pdf", ".pdf,application/pdf", "--t-pdf"],
  ["cad", "cad", "ph.tipo_cad", ".dwg,.dxf,.dwf,.dwfx,.plt,.hpgl", "--t-cad"],
  ["cube", "3d", "ph.tipo_3d", ".ifc,.step,.stp,.stl,.obj,.glb,.gltf,.3dm,.fbx,.las,.jt", "--t-3d"],
  ["photo", "img", "ph.tipo_immagini", "image/*,.psd,.heic,.tif,.tiff", "--t-img"],
  ["office", "doc", "ph.tipo_office", ".docx,.doc,.xlsx,.xls,.csv,.pptx,.ppt,.odt,.ods,.odp,.rtf,.txt,.md", "--t-doc"],
  ["map", "gis", "ph.tipo_mappe", ".geojson,.json,.kml,.kmz,.gpx,.zip,.gpkg,.shp", "--t-xls"],
];

// ------------------------------------------------------------------ Home
function sectionHead(title, action) {
  return el("div", { class: "ph-sec-h" }, el("h2", {}, title), action || null);
}
function buildHome(s) {
  const b = s.body;
  b.innerHTML = "";
  s.large.classList.add("ph-brand");
  if (!s.large.querySelector("img")) { s.large.textContent = ""; s.large.append(el("img", { src: "img/logo-512.png", alt: "MB Visual" })); }
  // azioni principali
  b.append(el("div", { class: "ph-actions" },
    ap(el("button", { type: "button", class: "ph-open", onclick: () => { haptic(); UI.doOpen(); } }), el("span", { class: "ph-oi", html: ICON.open }),
      el("span", { class: "ph-ot" }, el("b", {}, t("idx.apri_file")), el("small", {}, t("ph.apri_sub")))),
    el("div", { class: "ph-actions2" },
      btn("ph-act", "scan", t("scanner.home"), () => { haptic(); UI.doScan(); }),
      btn("ph-act", "newdoc", t("idx.crea_nuovo"), () => { haptic(); UI.doNew(); }))));
  // PC collegato (ui/js/link/linkphone.js)
  if (window.MBLinkPhone) b.append(sectionHead(t("link.pc")), window.MBLinkPhone.homeSection());
  // documenti aperti in questo momento
  const open = (window.MB?.tabs || []).filter(x => !x.path.startsWith("mail://"));
  if (open.length) {
    b.append(sectionHead(t("ph.aperti_ora")));
    b.append(el("div", { class: "ph-openrow" }, ...open.map(x => el("button", { type: "button", class: "ph-ochip", onclick: () => { haptic(); window.MB.activate(x); } }, UI.badgeFor(x.info?.nome || x.name), el("span", {}, x.name)))));
  }
  // recenti
  const list = el("div", { class: "ph-rlist" }, ...skeletonRows(3));
  b.append(sectionHead(t("app.recenti"), el("button", { type: "button", class: "ph-link", onclick: () => go("files") }, t("ph.mostra_tutti"))), list);
  // strumenti (prima avevano una scheda: ora la barra in basso ha la Posta)
  b.append(sectionHead(t("ph.strumenti")), toolTiles());
  // apri per tipo
  b.append(sectionHead(t("ph.apri_per_tipo")), el("div", { class: "ph-types" }, ...BY_TYPE.map(([icon, , key, accept, c]) =>
    el("button", { type: "button", class: "ph-type", style: { "--c": `var(${c})` }, onclick: () => { haptic(); openPicked({ accept }); }, html: `<span class="ph-tyi">${ICON[icon]}</span>` }, t(key)))));
  if (window.MBV_MOBILE) b.append(el("p", { class: "ph-powered" }, "Powered by MB Group")); // dicitura chiesta dall'utente sotto il logo
  store.list().then(recs => {
    list.innerHTML = "";
    if (!recs.length) {
      list.append(el("div", { class: "ph-emptybox" }, el("span", { class: "ph-ei", html: ICON.files }), el("b", {}, t("ph.nessun_recente")), el("span", {}, t("app.i_file_restano_tuo_dispositivo"))));
      return;
    }
    list.append(...recs.slice(0, 6).map(r => recentCard(r, { onChange: () => buildHome(s) })));
  });
}

// ------------------------------------------------------------------ File
let filesSort = "t", filesQuery = "";
function buildFiles(s) {
  const b = s.body;
  b.innerHTML = "";
  const q = el("input", { type: "search", class: "ph-search", placeholder: t("ph.cerca_file"), value: filesQuery, enterkeyhint: "search" });
  const listBox = el("div", { class: "ph-rlist" }, ...skeletonRows(4));
  const usage = el("div", { class: "ph-usage" });
  b.append(el("div", { class: "ph-searchwrap" }, el("span", { class: "ph-si", html: ICON.search }), q));
  b.append(el("div", { class: "ph-group" },
    row("files", t("ph.sfoglia_dispositivo"), t("ph.sfoglia_sub"), () => openPicked({})),
    row("photo", t("ph.foto_immagini"), null, () => openPicked({ accept: "image/*" })),
    row("camera", t("ph.scatta_foto"), null, () => openPicked({ accept: "image/*", capture: "environment", multiple: false }))));
  b.append(el("p", { class: "ph-note" }, t("ph.cloud_nota")));
  const open = (window.MB?.tabs || []).filter(x => !x.path.startsWith("mail://"));
  if (open.length) b.append(sectionHead(t("ph.aperti_ora")), el("div", { class: "ph-group" }, ...open.map(x => row(null, x.name, UI.viewerName(x.viewer), () => window.MB.activate(x), UI.badgeFor(x.info?.nome || x.name)))));
  const seg = el("div", { class: "ph-seg ph-seg-sm" }, ...[["t", t("ph.ordina_recenti")], ["n", t("common.nome")], ["s", t("ph.ordina_dimensione")]].map(([k, l]) =>
    el("button", { type: "button", class: filesSort === k ? "on" : "", onclick: () => { filesSort = k; haptic(); buildFiles(s); } }, l)));
  b.append(sectionHead(t("ph.su_dispositivo"), seg), listBox, usage);
  const draw = recs => {
    const f = filesQuery.trim().toLowerCase();
    const items = recs.filter(r => !f || r.name.toLowerCase().includes(f));
    if (filesSort === "n") items.sort((a, c) => a.name.localeCompare(c.name, LOCALE, { numeric: true }));
    if (filesSort === "s") items.sort((a, c) => c.size - a.size);
    listBox.innerHTML = "";
    if (!items.length) listBox.append(el("div", { class: "ph-emptybox" }, el("span", { class: "ph-ei", html: ICON.files }), el("b", {}, f ? t("ph.nessun_risultato") : t("ph.nessun_recente"))));
    listBox.append(...items.map(r => recentCard(r, { onChange: () => buildFiles(s) })));
  };
  let recs = [];
  q.addEventListener("input", () => { filesQuery = q.value; draw(recs); });
  store.list().then(r => { recs = r; draw(recs); });
  store.usage().then(u => {
    usage.innerHTML = "";
    usage.append(el("span", {}, t("ph.spazio_usato", u.count, fmtSize(u.bytes))));
    if (u.count) usage.append(el("button", { type: "button", class: "ph-link danger", onclick: () => clearStored(() => buildFiles(s)) }, t("ph.svuota")));
  });
}
function row(icon, label, sub, onclick, lead = null) {
  const r = el("button", { type: "button", class: "ph-row", onclick: () => { haptic(); onclick(); } });
  if (lead) r.append(el("span", { class: "ph-lead" }, lead));
  else if (icon) r.append(el("span", { class: "ph-ri", html: ICON[icon] || icon }));
  r.append(el("span", { class: "ph-rl" }, el("b", {}, label), sub ? el("small", {}, sub) : null), el("span", { class: "ph-chev", html: ICON.chev }));
  return r;
}
async function clearStored(after) {
  const ok = await window.MB.modal(t("ph.svuota_titolo"), el("p", {}, t("ph.svuota_testo")), [{ label: t("common.annulla"), value: false }, { label: t("ph.svuota"), value: true, danger: true }]);
  if (!ok) return;
  await store.clear();
  thumbs.clear();
  toast(t("ph.svuotato"));
  after?.();
}

// ------------------------------------------------------------------ Strumenti
function toolTiles() {
  const tile = (icon, label, sub, fn, c = "--accent") => ap(el("button", { type: "button", class: "ph-tile", style: { "--c": `var(${c})` }, onclick: () => { haptic(); fn(); } }),
    el("span", { class: "ph-tyi", html: ICON[icon] }), el("b", {}, label), sub ? el("small", {}, sub) : null);
  return el("div", { class: "ph-tiles" },
    tile("scan", t("scanner.home"), t("ph.scansiona_sub"), () => UI.doScan(), "--t-img"),
    tile("compare", t("ph.confronta"), t("ph.confronta_sub"), compareTwo, "--t-cad"),
    tile("merge", t("ph.unisci_pdf"), t("ph.unisci_pdf_sub"), mergePdf, "--t-pdf"),
    tile("formats", t("idx.formati"), t("ph.formati_sub"), () => UI.toggleFormats(), "--t-code"),
    window.MBLinkPhone ? tile("open", t("link.pc"), t("link.tile_sub"), () => window.MBLinkPhone.openPc(), "--t-doc") : null);
}
async function compareTwo() {
  const ps = await pick({ multiple: true });
  if (!ps.length) return;
  if (ps.length !== 2) return toast(t("ph.scegli_due_file"), true, 5000);
  const fam = n => ({ pdf: "pdf", dwg: "cad", dxf: "cad", ifc: "ifc" })[extOf(n)];
  if (!fam(ps[0]) || fam(ps[0]) !== fam(ps[1])) return toast(t("app.confronto_stesso_tipo"), true, 6000);
  UI.openCompare(ps[0], ps[1]);
}
async function mergePdf() {
  const ps = await pick({ multiple: true, accept: ".pdf,application/pdf" });
  if (ps.length < 2) { if (ps.length) toast(t("ph.scegli_almeno_due"), true, 5000); return; }
  try {
    toast(t("ph.unione_corso"), false, 60000);
    await window.MBV_API.handle("pdf_tool", { path: ps[0], op: "merge" }, { body: { others: ps.slice(1), out: "download://" + t("ph.nome_uniti") + ".pdf" } });
  } catch (e) { toast(e.message, true, 6000); }
}

// ------------------------------------------------------------------ Account
function buildAccount(s) {
  const b = s.body;
  b.innerHTML = "";
  const lic = el("div", { class: "ph-group" }, ...skeletonRows(2));
  b.append(sectionHead(t("ph.licenza")), lic);
  loadLicense(lic);
  // aspetto
  let cur = null;
  try { cur = localStorage.getItem("mbv-theme"); } catch { /* */ }
  const themeSeg = el("div", { class: "ph-seg" }, ...[["", t("ph.tema_auto")], ["light", t("ph.tema_chiaro")], ["dark", t("ph.tema_scuro")]].map(([k, l]) =>
    el("button", { type: "button", class: (cur || "") === k ? "on" : "", onclick: () => { setTheme(k); haptic(); buildAccount(s); } }, l)));
  const langSel = el("select", { class: "ph-select", "aria-label": t("lang.titolo") }, el("option", { value: "" }, t("lang.automatica_sistema")), ...LANGS.map(([c, n]) => el("option", { value: c }, n)));
  langSel.value = MANUAL ? LANG : "";
  langSel.addEventListener("change", async () => {
    setLanguage(langSel.value);
    const ok = await window.MB.modal(t("lang.titolo"), el("p", {}, t("lang.ricarica")), [{ label: t("lang.dopo"), value: false }, { label: t("lang.ricarica_ora"), value: true, primary: true }]);
    if (ok) location.reload();
  });
  b.append(sectionHead(t("ph.aspetto")), el("div", { class: "ph-group ph-pad" }, el("div", { class: "ph-field" }, el("span", { class: "ph-ri", html: ICON.theme }), el("b", {}, t("ph.tema")), themeSeg),
    el("div", { class: "ph-field" }, el("span", { class: "ph-ri", html: ICON.globe }), el("b", {}, t("lang.titolo")), langSel)));
  // spazio nel dispositivo
  const usage = el("div", { class: "ph-group" });
  b.append(sectionHead(t("ph.spazio")), usage);
  store.usage().then(u => {
    usage.append(el("div", { class: "ph-field" }, el("span", { class: "ph-ri", html: ICON.disk }), el("span", { class: "ph-rl" }, el("b", {}, t("ph.file_salvati")), el("small", {}, t("ph.spazio_usato", u.count, fmtSize(u.bytes)))),
      u.count ? el("button", { type: "button", class: "ph-link danger", onclick: () => clearStored(() => buildAccount(s)) }, t("ph.svuota")) : null));
  });
  // informazioni
  b.append(sectionHead(t("ph.informazioni")), el("div", { class: "ph-group" },
    row("formats", t("idx.elenco_completo_formati_supportati"), null, () => UI.toggleFormats()),
    el("div", { class: "ph-field" }, el("span", { class: "ph-ri", html: ICON.info }), el("span", { class: "ph-rl" }, el("b", {}, t("ph.versione")), el("small", { class: "mono" }, window.MBV_VERSION ? `${window.MBV_VERSION} · ${(window.MBV_BUILD || "").split("-").slice(1).join("-")}` : window.MBV_BUILD || "-")))));
  if (window.MBV_MOBILE) b.append(el("p", { class: "ph-powered" }, "Powered by MB Group"));
}
async function loadLicense(box) {
  let a;
  try {
    if (!window.MBV_MOBILE) throw new Error(t("ph.licenza_solo_app"));
    a = await UI.accountInfo();
  } catch (e) {
    box.innerHTML = "";
    box.append(el("div", { class: "ph-field" }, el("span", { class: "ph-ri", html: ICON.key }), el("span", { class: "ph-rl" }, el("b", {}, t("license.account_non_disponibile").replace(/[:\s]+$/, "")), el("small", {}, e.message)),
      el("button", { type: "button", class: "ph-link", onclick: () => { box.innerHTML = ""; box.append(...skeletonRows(2)); loadLicense(box); } }, t("ph.riprova"))));
    return;
  }
  const fmtD = v => (v ? new Date(v.replace(" ", "T") + "Z").toLocaleDateString(LOCALE, { dateStyle: "medium" }) : "");
  const pcs = a.dispositivi.filter(d => d.kind === "pc").length, tels = a.dispositivi.filter(d => d.kind === "mobile").length;
  const kv = (k, v, mono) => el("div", { class: "ph-kv" }, el("span", {}, k), el("b", { class: mono ? "mono" : "" }, v));
  box.innerHTML = "";
  box.append(el("div", { class: "ph-lic" },
    kv(t("license.intestatario"), a.cliente || "-"),
    el("div", { class: "ph-kv", role: "button", onclick: () => navigator.clipboard?.writeText(a.chiave).then(() => { haptic(); toast(t("ph.chiave_copiata")); }) }, el("span", {}, t("license.chiave")), el("b", { class: "mono" }, a.chiave)),
    kv(t("license.dispositivi"), t("license.pc_0_1_cellulari_2", pcs, a.pc, tels, a.cellulari)),
    a.scadenza ? kv(t("license.scadenza"), fmtD(a.scadenza)) : null),
  row("devices", t("ph.dispositivi_attivi"), null, () => showDevices(a)),
  row("flag", t("license.segnalazione"), null, () => UI.licenseReport()),
  row("swap", t("license.cambio_pc_cellulare"), null, () => UI.licenseChange()),
  row("key", t("license.inserisci_nuova_chiave"), null, () => UI.licenseNewKey()));
}
function showDevices(a) {
  const fmtD = v => (v ? new Date(v.replace(" ", "T") + "Z").toLocaleString(LOCALE, { dateStyle: "short", timeStyle: "short" }) : "-");
  const list = el("div", { class: "ph-group" }, ...a.dispositivi.map(d => el("div", { class: "ph-field" },
    el("span", { class: "ph-ri", html: ICON[d.kind === "pc" ? "devices" : "account"] }),
    el("span", { class: "ph-rl" }, el("b", {}, (d.name || "-") + (d.questo ? " · " + t("license.questo").trim() : "")),
      el("small", {}, `${d.kind === "pc" ? "PC" : t("license.cellulare")} · ${t("license.ultimo_uso")}: ${fmtD(d.last_seen)}`)))));
  window.MB.modal(t("ph.dispositivi_attivi"), list, [{ label: t("ph.fine"), value: true, primary: true }]);
}
function setTheme(k) {
  try { if (k) localStorage.setItem("mbv-theme", k); else localStorage.removeItem("mbv-theme"); } catch { /* */ }
  if (k) root.dataset.theme = k; else delete root.dataset.theme;
  window.dispatchEvent(new CustomEvent("mbv-theme"));
  sync();
}

// ------------------------------------------------------------------ viste sovrapposte (posta: messaggio, scrittura, account)
// { title, actions: [{icon, label, run, primary}], beforeClose: async () => bool } -> { el, body, close(force), onClose }
const views = [];
export function pushView({ title = "", actions = [], beforeClose = null } = {}) {
  const head = el("header", { class: "ph-pvhead" }, btn("ph-vb ph-back", "back", null, () => v.close(), { "aria-label": t("common.indietro") }), el("b", {}, title));
  const tools = el("span", { class: "ph-pvact" });
  for (const a of actions) {
    const b = el("button", { type: "button", class: "ph-vb" + (a.primary ? " ph-pvprim" : ""), "aria-label": a.label, title: a.label, onclick: () => a.run() });
    b.insertAdjacentHTML("beforeend", a.icon.startsWith("<") ? a.icon : ICON[a.icon]);
    if (a.primary) b.append(el("span", {}, a.label));
    tools.append(b);
  }
  head.append(tools);
  const body = el("div", { class: "ph-pvbody" });
  const sec = el("section", { class: "ph-pview" }, head, body);
  const v = {
    el: sec, body, onClose: null,
    async close(force = false) {
      if (!force && beforeClose && !(await beforeClose())) return;
      const i = views.indexOf(v); if (i >= 0) views.splice(i, 1);
      sec.classList.add("out"); setTimeout(() => sec.remove(), 220);
      root.classList.toggle("ph-pv-open", views.length > 0);
      v.onClose?.();
    },
  };
  views.push(v);
  document.body.append(sec);
  root.classList.add("ph-pv-open");
  return v;
}
function setBadge(n) {
  const b = nav?.querySelector(".ph-badge");
  if (!b) return;
  b.hidden = !n;
  b.textContent = n > 99 ? "99+" : String(n || "");
}
const mailHelpers = () => ({ actionSheet, pushView, haptic, deliver, pick, setBadge });
async function mailFile(tab) {
  const blob = window.MBV_API.blobOf(tab.path);
  const name = tab.info?.nome || tab.name;
  const m = await import("./mmail.js");
  await m.badgeOnly(mailHelpers());
  m.compose({ subject: name, attachments: [{ name, type: blob.type, data: new Uint8Array(await blob.arrayBuffer()) }] });
}

// ------------------------------------------------------------------ tasto indietro di sistema
export function back() {
  if (document.querySelector(".ph-find") || openSheets.length) { closeTop(); return true; }
  if (views.length) { views[views.length - 1].close(); return true; }
  // menu aperti da un visualizzatore o da un editor: si chiudono come con Esc o un tocco fuori
  if ([...document.querySelectorAll(".ps-menu, .pb-pop, .pb-menu, .vs-pop, .vs-menu, .cad-menu:not([hidden]), .cad-snapmenu:not([hidden]), .ps-fly")].some(m => m.getClientRects().length)) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    for (const type of ["pointerdown", "mousedown", "click"]) document.body.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    return true;
  }
  const p = window.MB?.active?.ph?.panel;
  if (p && p.state !== "closed") { p.close(); return true; }
  if (root.classList.contains("ph-imm")) { setImmersive(false); return true; }
  if (!window.MB?.active && $("formats").hidden && screen !== "home") { go("home"); return true; }
  return false;
}

// ------------------------------------------------------------------ avvio
export function initPhone(ui) {
  UI = ui;
  window.MBPhoneDeliver = deliver;
  window.MBPhoneSaved = (path, blob) => {
    const tab = (window.MB?.tabs || []).find(x => x.path === path);
    if (tab?.ph?.recId) store.update(tab.ph.recId, blob).then(id => { tab.ph.recId = id; });
  };
  buildShell();
  // pulsanti della barra in basso del documento: pagina dei PDF
  pagePill.addEventListener("click", () => window.MB?.active?.ph?.onPage?.());
  addEventListener("mbv-tabs", () => sync());
  addEventListener("mbv-theme", () => sync());
  try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => sync()); } catch { /* */ }
  // altezza della barra di stato del sistema (per i fogli a tutta altezza)
  const probe = el("div", { style: { position: "fixed", top: "0", height: "env(safe-area-inset-top, 0px)", visibility: "hidden", pointerEvents: "none" } });
  document.body.append(probe);
  root.style.setProperty("--ph-st", probe.offsetHeight + "px");
  probe.remove();
  S.home.refresh();
  sync();
  requestAnimationFrame(() => root.classList.add("ph-ready"));
  // collegamento con il PC (QR del pannello "Telefono" dell'app per PC)
  if (window.MBV_MOBILE || window.MBV_LINK_TOKEN) import("./link/linkphone.js").then(m => { m.initLinkPhone({ actionSheet, pushView, haptic, pick, store, UI }); S.home.refresh(); }).catch(e => console.error(e));
  updates();
  if (window.MBV_MOBILE || window.MBV_MAIL) {
    const poll = () => import("./mmail.js").then(m => { m.badgeOnly(mailHelpers()); return m.background(); }).catch(() => {});
    setTimeout(poll, 4000);
    setInterval(() => { if (document.visibilityState === "visible") poll(); }, 180000);
  }
}

// aggiornamento automatico (service worker di tools/build_web.py): avviso della versione nuova e, se ci sono file
// modificati non salvati, richiesta di ricaricare quando l'utente e' pronto
function updates() {
  const v = window.MBV_VERSION;
  let prev = null;
  try { prev = localStorage.getItem("mbv-versione"); if (v) localStorage.setItem("mbv-versione", v); } catch { /* */ }
  if (v && prev && prev !== v) setTimeout(() => toast(t("ph.aggiornata", v), false, 5000), 900);
  const ask = () => actionSheet({ title: t("ph.agg_pronto"), sub: t("ph.agg_testo"), items: [
    { label: t("ph.ricarica"), icon: "download", run: async () => {
      for (const tab of (window.MB?.tabs || []).filter(x => x.dirty)) { window.MB.activate(tab); if (!(await window.MB.modal(t("ph.agg_pronto"), el("p", {}, t("ph.agg_perdi", tab.name)), [{ label: t("common.annulla"), value: false }, { label: t("ph.ricarica"), value: true, danger: true }]))) return; }
      window.__mbvReload = true; location.reload();
    } }] });
  addEventListener("mbv-update", ask);
  if (window.MBV_UPDATE_READY) ask();
}
