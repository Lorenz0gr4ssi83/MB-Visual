// MB Visual - guscio dell'applicazione: schede, apertura file, trascinamento, scelta del visualizzatore, pagina formati.
import {
  api, baseName, button, confirmBox, dirName, el, extOf, fmtSize, isDesktop, modal, pickFiles, pickFolder,
  pickSavePath, toast, waitJob, WEB,
} from "./core.js";
import { licenseGate, showAccount } from "./license.js";

const $ = id => document.getElementById(id);
const VIEWER_NAMES = {
  pdf: "PDF", signed: "Documento firmato", docx: "Word", sheet: "Foglio di calcolo", pptx: "Presentazione",
  office: "Documento Office (LibreOffice)", text: "Testo / codice", markdown: "Markdown", html: "Pagina web",
  image: "Immagine", svg: "SVG", media: "Audio / video", cad2d: "Disegno CAD 2D", model3d: "Modello 3D",
  external: "Programma esterno", archive: "Archivio", email: "Email", epub: "eBook", font: "Font",
  sqlite: "Database SQLite", video: "Montaggio video", publisher: "Pubblicazione (Publisher)", hex: "Esadecimale (byte grezzi)", oo: "Word / Excel / PowerPoint (ONLYOFFICE)",
};
// documenti che sul PC si aprono nell'editor ONLYOFFICE integrato (modifica completa come nei programmi originali)
const OO_EXTS = new Set(["docx", "docm", "dotx", "dotm", "doc", "dot", "rtf", "odt", "ott", "fodt", "xlsx", "xlsm", "xltx", "xltm", "xls", "xlt", "ods", "fods", "csv",
  "pptx", "pptm", "potx", "potm", "ppsx", "ppsm", "ppt", "pps", "pot", "odp", "otp", "fodp"]);
const TEXT_VIEWERS = new Set(["text", "markdown", "html", "svg"]);
const SNIFF_FAMILY = {
  pdf: ["pdf"], signed: ["signed"], media: ["media", "audio"], archive: ["archive"], image: ["image", "image-raw"],
  zip: ["word", "sheet", "pptx", "publisher", "office-lo", "archive", "mesh3d", "ebook"], sqlite: ["database"],
  ole: ["publisher", "office-lo", "sheet", "email", "archive", "image"], cad2d: ["cad2d"], ifc: ["mesh3d"], cad3d: ["cad3d"],
  mesh3d: ["mesh3d"], font: ["font"], svg: ["svg"], html: ["html"], email: ["email"],
};
const NAME_AS_EXT = { makefile: "makefile", dockerfile: "dockerfile", containerfile: "containerfile", license: "txt", readme: "txt",
  ".gitignore": "gitignore", ".gitattributes": "gitattributes", ".editorconfig": "editorconfig", ".env": "env", ".htaccess": "htaccess" };

let REG = null;          // formats.json
let EXT = new Map();     // estensione -> [categorie]
let TOOLS = {};
const tabs = [];
const seen = [];         // schede in ordine di visualizzazione (per il tasto indietro)
let active = null;

// ------------------------------------------------------------------ registro formati
async function loadRegistry() {
  REG = await (await fetch("formats.json")).json();
  for (const c of REG.categories) for (const e of c.exts) {
    if (!EXT.has(e)) EXT.set(e, []);
    if (!EXT.get(e).includes(c)) EXT.get(e).push(c);
  }
  try { TOOLS = (await api("tools")).tools; } catch { TOOLS = {}; }
}

function extFor(name) {
  const low = name.toLowerCase();
  if (NAME_AS_EXT[low]) return NAME_AS_EXT[low];
  return extOf(name);
}

export function resolveCategory(name, sniff) {
  const ext = extFor(name);
  const cands = EXT.get(ext) || [];
  if (!cands.length) return { cat: null, ext };
  if (cands.length === 1) return { cat: cands[0], ext };
  const kind = sniff && sniff.kind;
  const fam = SNIFF_FAMILY[kind] || [];
  let best = cands[0], score = -1;
  for (const c of cands) {
    let s = 0;
    if (fam.includes(c.id)) s += 2;
    const texty = TEXT_VIEWERS.has(c.viewer);
    if (kind === "text" && texty) s += 1;
    if (kind && kind !== "text" && !texty) s += 1;
    if (s > score) { score = s; best = c; }
  }
  return { cat: best, ext };
}

// ------------------------------------------------------------------ badge per tipo di file
const BADGE_COLOR = { pdf: "pdf", signed: "sig", word: "doc", "office-lo": "doc", sheet: "xls", pptx: "ppt", publisher: "cad", cad2d: "cad",
  cad3d: "3d", mesh3d: "3d", navisworks: "3d", image: "img", "image-raw": "img", svg: "img", media: "av", audio: "av", videoproject: "av",
  archive: "zip", email: "mail", text: "code", markdown: "code", html: "code", ebook: "code", font: "code", database: "db" };
export function badgeFor(name, isDir = false) {
  if (isDir) return el("span", { class: "badge" }, "DIR");
  const { cat, ext } = resolveCategory(name, null);
  const label = (ext || "?").slice(0, 4).toUpperCase();
  const b = el("span", { class: "badge" }, label);
  b.style.background = `var(--t-${cat ? BADGE_COLOR[cat.id] || "bin" : "bin"})`;
  return b;
}

// ------------------------------------------------------------------ schede
function renderTabs() {
  const box = $("tabs");
  box.innerHTML = "";
  // la linguetta Home (pagina per trascinare e aprire i file) all'estrema sinistra, "Chiudi tutto" all'estrema destra
  box.append(el("div", { class: "tab home-tab" + (!active && $("formats").hidden ? " active" : ""), role: "tab", title: "Home: trascina qui i file da aprire", onclick: () => activate(null) },
    el("span", { html: '<svg viewBox="0 0 24 24"><path d="M3 11l9-8 9 8M5 9v12h14V9"/></svg>' }), el("span", { class: "name" }, "Home")));
  for (const t of tabs) {
    const b = el("div", { class: "tab" + (t === active ? " active" : ""), role: "tab", title: t.path, onclick: () => activate(t) },
      badgeFor(t.info?.nome || t.name),
      el("span", { class: "name" }, t.name + (t.forced ? "  ·  " + VIEWER_NAMES[t.viewer] : "")),
      t.dirty ? el("span", { class: "dot", title: "Modifiche non salvate" }) : null,
      el("button", { class: "x", title: "Chiudi", onclick: e => { e.stopPropagation(); closeTab(t); } }, "×"));
    b.addEventListener("auxclick", e => { if (e.button === 1) closeTab(t); });
    box.append(b);
  }
  box.append(el("button", { class: "tab-closeall", title: "Chiudi tutti i file aperti", disabled: !tabs.length || undefined, onclick: closeAll },
    el("span", { html: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>' }), "Chiudi tutto"));
  const has = !!active;
  for (const id of ["btn-as", "btn-folder", "btn-external", "btn-info"]) $(id).disabled = !has;
  $("home").hidden = has || !$("formats").hidden;
  $("views").hidden = !has || !$("formats").hidden;
  updateStatus();
  try { window.pywebview?.api?.set_dirty?.(tabs.filter(t => t.dirty).length); } catch { /* */ } // per la domanda alla chiusura
}

function updateStatus() {
  const t = active;
  $("st-path").textContent = t ? (t.path.startsWith("web://") ? t.info?.nome || t.name : t.path) : "Pronto";
  $("st-type").textContent = t ? VIEWER_NAMES[t.viewer] + (t.info?.sniff?.descr ? " · " + t.info.sniff.descr : "") : "";
  $("st-size").textContent = t ? fmtSize(t.info?.size) : "";
  $("st-extra").textContent = t?.extra || "";
}

function activate(t) {
  if (!$("formats").hidden) { $("formats").hidden = true; $("btn-formats").classList.remove("on"); }
  active = t;
  if (t) { const i = seen.indexOf(t); if (i >= 0) seen.splice(i, 1); seen.push(t); }
  for (const x of tabs) x.view.hidden = x !== t;
  renderTabs();
  if (t?.api?.onShow) try { t.api.onShow(); } catch { /* */ }
  document.title = t ? t.name + " - MB Visual" : "MB Visual";
}

// "Vuoi salvare?" per un file modificato (o nuovo mai salvato): true = si puo' chiudere
async function settle(t) {
  if (!t.dirty) return true;
  activate(t);
  const r = await modal("Vuoi salvare?", el("p", {}, t.untitled ? `"${t.name}" e' un file nuovo non ancora salvato. Vuoi salvarlo?` : `Vuoi salvare le modifiche a "${t.name}"?`),
    [{ label: "Annulla", value: null }, { label: "Non salvare", value: "no" }, { label: "Salva", value: "si", primary: true }]);
  if (!r) return false;
  if (r === "no") return true;
  await save(false);
  return !t.dirty;
}
// chiusura della finestra dell'app (app.py la ferma se ci sono file non salvati e chiama questa funzione)
async function askQuit() {
  for (const t of tabs.filter(x => x.dirty)) if (!(await settle(t))) return;
  window.pywebview?.api?.quit?.();
}

async function closeAll() {
  for (const t of tabs.filter(x => x.dirty)) if (!(await settle(t))) return;
  for (const t of [...tabs]) { try { t.api?.dispose?.(); } catch { /* */ } t.view.remove(); }
  tabs.length = 0;
  seen.length = 0;
  activate(null);
}

async function closeTab(t) {
  if (!(await settle(t))) return;
  try { t.api?.dispose?.(); } catch { /* */ }
  t.view.remove();
  const i = tabs.indexOf(t);
  tabs.splice(i, 1);
  if (seen.includes(t)) seen.splice(seen.indexOf(t), 1);
  if (active === t) active = seen[seen.length - 1] || tabs[i] || tabs[i - 1] || null;
  activate(active);
}

// ------------------------------------------------------------------ recenti (nel menu Apri)
function recentList() {
  try { return JSON.parse(localStorage.getItem("mbv-recent") || "[]"); } catch { return []; }
}

function remember(path) {
  if (/[\\/]MBVisual[\\/](estratti|archivi|email|caricati|office|media|immagini)[\\/]/i.test(path)) return; // file temporanei
  try {
    const list = recentList().filter(r => r.path !== path);
    list.unshift({ path, name: baseName(path), t: Date.now() });
    localStorage.setItem("mbv-recent", JSON.stringify(list.slice(0, 20)));
  } catch { /* */ }
}

const ICON_FILE = '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v4h4"/></svg>';
const ICON_NEW = '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v4h4M12 11v6M9 14h6"/></svg>';
const ICON_FOLDER = '<svg viewBox="0 0 24 24"><path d="M3 4h7v16H3zM14 4h7v7h-7zM14 14h7v6h-7z"/></svg>';

function closeMenus() { for (const id of ["menu-open", "menu-as", "menu-file"]) $(id).hidden = true; }
function placeMenu(m, anchor) {
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, innerWidth - 470) + "px";
  m.style.top = r.bottom + 4 + "px";
  m.hidden = false;
}

function openMenu(anchor) {
  const m = $("menu-open");
  if (!m.hidden) { m.hidden = true; return; }
  closeMenus();
  m.innerHTML = "";
  const item = (icon, text, hint, fn) => { const b = el("button", { onclick: () => { m.hidden = true; fn(); } }); b.insertAdjacentHTML("beforeend", icon); b.append(el("span", {}, text)); if (hint) b.append(el("span", { class: "hint" }, hint)); return b; };
  m.append(item(ICON_FILE, "Apri file...", "Ctrl+O", doOpen));
  if (!WEB) m.append(item(ICON_FOLDER, "Cartella di progetto...", "", chooseExplorerFolder));
  m.append(el("hr"), el("div", { class: "sec label" }, "Recenti"));
  // nella web app i file non restano disponibili dopo la chiusura: i recenti non si possono riaprire
  const list = WEB ? [] : recentList();
  if (!list.length) m.append(el("div", { class: "empty" }, WEB ? "Nella web app i file restano solo sul dispositivo: riaprili con Apri file" : "Nessun file aperto di recente"));
  for (const r of list) {
    m.append(el("button", { class: "rec", title: r.path, onclick: () => { m.hidden = true; openPaths([r.path]); } },
      badgeFor(r.name), el("span", { class: "nm" }, r.name), el("span", { class: "pt" }, dirName(r.path))));
  }
  if (list.length) m.append(el("hr"), item("", "Svuota l'elenco dei recenti", "", () => { try { localStorage.removeItem("mbv-recent"); } catch { /* */ } }));
  placeMenu(m, anchor);
}

const ICON_SAVE = '<svg viewBox="0 0 24 24"><path d="M5 3h11l3 3v15H5zM8 3v6h8V3M8 21v-7h8v7"/></svg>';
const ICON_SAVEAS = '<svg viewBox="0 0 24 24"><path d="M5 3h11l3 3v6M5 3v18h7M8 3v6h8V3M17 15v6M14 18h6"/></svg>';
const ICON_UPD = '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>';
// menu File: nuovo, salva, salva con nome, aggiornamenti (le voci di apertura stanno nel menu Apri)
const ICON_ACCOUNT = '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/></svg>';
function fileMenu(anchor) {
  const m = $("menu-file");
  if (!m.hidden) { m.hidden = true; return; }
  closeMenus();
  m.innerHTML = "";
  const item = (icon, text, hint, fn, disabled = false) => { const b = el("button", { disabled: disabled || undefined, onclick: () => { m.hidden = true; fn(); } }); b.insertAdjacentHTML("beforeend", icon); b.append(el("span", {}, text)); if (hint) b.append(el("span", { class: "hint" }, hint)); return b; };
  m.append(item(ICON_NEW, "Crea nuovo...", "Ctrl+N", doNew),
    item(ICON_SAVE, "Salva", "Ctrl+S", () => save(false), !active),
    item(ICON_SAVEAS, "Salva con nome...", "Ctrl+Maiusc+S", () => save(true), !active),
    item('<svg viewBox="0 0 24 24"><path d="M3 6h18v12H3zM6 9h2M10 9h2M14 9h2M18 9h0M6 13h12"/></svg>', "Scorciatoie da tastiera", "F1", showShortcuts));
  if (!WEB) m.append(item('<svg viewBox="0 0 24 24"><path d="M3 17c3-1 4-7 6-7s1 6 3 6 3-4 5-4 2 3 4 3M3 21h18"/></svg>', "Firma digitale...", "", () => import("./firma.js").then(f => f.signDialog({ path: active.path, openFile })), !active?.path)); // ui/js/firma.js
  if (WEB && window.MBV_MOBILE) m.append(el("hr"), item(ICON_ACCOUNT, "Account e licenza...", "", showAccount)); // app per cellulari con licenza
  if (!WEB) {
    m.append(el("hr"), item(ICON_ACCOUNT, "Account e licenza...", "", showAccount), item(ICON_UPD, "Verifica aggiornamenti", "", () => checkUpdates(true)));
    if (updInfo?.installabile && !updInfo.installata) m.append(item("", "Installa su questo PC...", "", askInstall));
  }
  placeMenu(m, anchor);
}

// ---- aggiornamento automatico dalla cartella "App per PC" su OneDrive (mbvisual/update.py)
let updInfo = null;
const fmtVer = v => v ? `${v.versione}${v.build && v.build !== "sviluppo" ? " del " + v.build.slice(0, 16).split(" ").map((x, i) => i ? x : x.split("-").reverse().join("/")).join(" ") : ""}` : "";
async function checkUpdates(manual = false) {
  let r;
  try { r = updInfo = await api("update_check"); } catch (e) { if (manual) toast("Controllo non riuscito: " + e.message, true); return; }
  updInfo.installata = !r.da_onedrive && r.stato !== "sviluppo" && /\\Programs\\MB Visual\\?$/i.test(r.cartella || "");
  $("st-version").textContent = "v" + r.attuale.versione;
  $("st-version").title = "MB Visual " + fmtVer(r.attuale);
  if (r.stato === "nuova") {
    const ok = await modal("Aggiornamento disponibile", el("div", {},
      el("p", {}, `È disponibile MB Visual ${fmtVer(r.disponibile)}.`), el("p", { class: "note" }, `In uso: ${fmtVer(r.attuale)}. L'app si chiude, si aggiorna e si riapre da sola (circa un minuto). Salva prima i file aperti.`)),
      [{ label: "Più tardi", value: false }, { label: "Aggiorna ora", value: true, primary: true }]);
    if (!ok) return;
    if (tabs.some(t => t.dirty) && !(await confirmBox("File non salvati", "Ci sono modifiche non salvate che andranno perse. Aggiornare comunque?", "Aggiorna", true))) return;
    await runUpdateJob("update_apply", "Aggiornamento di MB Visual", "Aggiornamento pronto: MB Visual si chiude e si riapre da sola");
    return;
  }
  if (r.stato === "sincronizzazione") {
    if (manual || r.da_onedrive) toast(`OneDrive sta ancora scaricando MB Visual ${r.disponibile?.versione || ""}: chiudi e riapri l'app quando la sincronizzazione è finita`, true, 12000);
    return;
  }
  if (r.da_onedrive && !manual) {
    let asked = false;
    try { asked = localStorage.getItem("mbv-install-asked") === "1"; localStorage.setItem("mbv-install-asked", "1"); } catch { /* */ }
    if (!asked) askInstall();
    return;
  }
  if (!manual) return;
  if (r.stato === "sviluppo") return toast("Versione di sviluppo: gli aggiornamenti valgono solo per l'app per PC");
  if (r.stato === "nessuna_fonte") {
    const ok = await modal("Aggiornamenti", el("p", {}, "Non trovo su questo PC la cartella \"App per PC\" di MB Visual sincronizzata con OneDrive. Indicala tu: da lì arriveranno gli aggiornamenti."),
      [{ label: "Annulla", value: false }, { label: "Scegli cartella...", value: true, primary: true }]);
    if (!ok) return;
    const folder = await pickFolder();
    if (!folder) return;
    try { await api("update_source", { folder }); return checkUpdates(true); } catch (e) { return toast(e.message, true, 8000); }
  }
  toast(`Hai già l'ultima versione (${fmtVer(r.attuale)})`);
}
async function askInstall() {
  const ok = await modal("Installa MB Visual su questo PC", el("div", {},
    el("p", {}, "Stai usando l'app direttamente dalla cartella di OneDrive: quando arriva una versione nuova, OneDrive la scarica un file alla volta e l'app può partire a metà aggiornamento."),
    el("p", {}, "Installandola su questo PC (senza diritti di amministratore, nella cartella del tuo utente) avrai i collegamenti sul Desktop e nel menu Start, e ogni nuova versione ti verrà proposta all'avvio.")),
    [{ label: "Non ora", value: false }, { label: "Installa", value: true, primary: true }]);
  if (!ok) return;
  await runUpdateJob("update_install", "Installazione di MB Visual", "Installata: MB Visual si riapre dal Desktop / menu Start");
}
// installazione / aggiornamento con finestra di avanzamento (la copia scarica da OneDrive i file "solo online": puo' richiedere minuti)
async function runUpdateJob(route, title, doneText) {
  const bar = el("div", { class: "progress" }, el("span"));
  const msg = el("p", {}, "Avvio...");
  const back = $("modal"), body = $("modal-body");
  body.innerHTML = "";
  body.append(el("h3", {}, title), msg, bar, el("p", { class: "note" }, "Non chiudere MB Visual: alla fine si riavvia da sola."));
  back.hidden = false;
  try {
    const { job } = await api(route);
    await waitJob(job, (p, m) => { bar.firstChild.style.width = Math.round(p * 100) + "%"; if (m) msg.textContent = m; });
    bar.firstChild.style.width = "100%";
    msg.textContent = doneText;
  } catch (e) {
    back.hidden = true;
    await modal(title + " non riuscita", el("div", {}, el("p", {}, e.message), el("p", { class: "note" }, "Dettagli nel file MBVisual-aggiornamento.log nella cartella temporanea di Windows (%TEMP%).")));
  }
}

// nuovo file vuoto (Word, Excel, PowerPoint, PDF, DXF, testo, immagini, database), aperto subito nel suo editor
async function doNew() {
  const { createNew } = await import("./newfile.js");
  await createNew({ dir: exDir || "", openFile: (p, v, x) => openFile(p, v, x) });
}

async function doOpen() { const ps = await pickFiles(); if (ps?.length) openPaths(ps); }

// ------------------------------------------------------------------ esplora cartella di progetto
let exDir = null, exItems = [];
async function chooseExplorerFolder() {
  const d = await pickFolder();
  if (!d) return;
  $("explorer").hidden = false;
  $("btn-explorer").classList.add("on");
  await loadDir(d);
}
async function loadDir(d) {
  try {
    const r = await api("list_dir", { path: d });
    exDir = r.path;
    exItems = r.items;
    try { localStorage.setItem("mbv-exdir", exDir); } catch { /* */ }
    $("ex-path").textContent = exDir;
    $("ex-path").title = exDir;
    renderDir();
  } catch (e) { toast("Cartella non accessibile: " + e.message, true); }
}
function renderDir() {
  const q = $("ex-filter").value.trim().toLowerCase();
  const box = $("ex-list");
  box.innerHTML = "";
  const items = exItems.filter(i => !q || i.name.toLowerCase().includes(q));
  for (const i of items) {
    box.append(el("button", { class: "ex-item" + (i.dir ? " dir" : ""), title: i.name, onclick: () => (i.dir ? loadDir(i.path) : openPaths([i.path])) },
      badgeFor(i.name, i.dir), el("span", { class: "nm" }, i.name),
      el("span", { class: "sz", title: i.nuvola ? "Solo su OneDrive: verra' scaricato all'apertura" : "" }, (i.nuvola ? "☁ " : "") + (i.dir ? "" : fmtSize(i.size)))));
  }
  if (!items.length) box.append(el("div", { class: "note", style: { padding: "8px 12px", color: "var(--muted)" } }, q ? "Nessun file corrisponde al filtro" : "Cartella vuota"));
}
function toggleExplorer() {
  const ex = $("explorer");
  if (ex.hidden && !exDir) {
    let d = null;
    try { d = localStorage.getItem("mbv-exdir"); } catch { /* */ }
    if (d) { ex.hidden = false; $("btn-explorer").classList.add("on"); loadDir(d); } else chooseExplorerFolder();
    return;
  }
  ex.hidden = !ex.hidden;
  $("btn-explorer").classList.toggle("on", !ex.hidden);
  window.dispatchEvent(new Event("resize"));
}

// ------------------------------------------------------------------ proprieta' del file
async function showProperties() {
  const t = active;
  if (!t) return;
  const i = await api("info", { path: t.path });
  const dl = el("dl", { class: "kv" });
  const add = (k, v, mono) => dl.append(el("dt", {}, k), el("dd", { class: mono ? "mono" : "" }, v));
  add("Nome", i.nome);
  add("Cartella", i.cartella);
  add("Dimensione", `${fmtSize(i.size)} (${i.size.toLocaleString("it-IT")} byte)`);
  add("Modificato", new Date(i.modificato * 1000).toLocaleString("it-IT"));
  add("Creato", new Date(i.creato * 1000).toLocaleString("it-IT"));
  add("Tipo rilevato dal contenuto", i.sniff?.descr || "-");
  add("Aperto con", VIEWER_NAMES[t.viewer]);
  add("Scrivibile", i.scrivibile ? "Si" : "No (sola lettura)");
  const hash = el("dd", { class: "mono" }, "calcolo in corso...");
  dl.append(el("dt", {}, "Impronta SHA-256"), hash);
  const copy = el("button", { class: "btn", onclick: () => navigator.clipboard?.writeText(hash.textContent).then(() => toast("Impronta copiata")) }, "Copia impronta");
  api("file_hash", { path: t.path }).then(r => (hash.textContent = r.sha256)).catch(e => (hash.textContent = "non disponibile: " + e.message));
  await modal("Proprieta' del file", el("div", { style: { display: "grid", gap: "12px" } }, dl,
    el("p", { class: "note", style: { margin: 0, color: "var(--muted)" } }, "L'impronta SHA-256 identifica il file in modo univoco: utile per verificare che un elaborato consegnato non sia stato modificato."), copy));
}

// ------------------------------------------------------------------ apertura
async function openPaths(paths, fromDrop = false) {
  if (fromDrop) $("dragover").hidden = true;
  // un visualizzatore puo' accettare i file trascinati (es. aggiungerli a un archivio)
  if (fromDrop && active && $("formats").hidden && active.api?.acceptDrop && (await active.api.acceptDrop(paths))) return;
  for (const p of paths) await openFile(p);
}

async function openFile(path, forcedViewer = null, extraCtx = {}) {
  await READY; // il registro dei formati deve essere caricato prima di scegliere il visualizzatore
  const existing = tabs.find(t => t.path === path && (!forcedViewer || t.viewer === forcedViewer));
  if (existing && !extraCtx.fresh) return activate(existing);
  let info;
  try { info = await api("info", { path }); } catch (e) { return toast("Impossibile aprire: " + e.message, true); }
  if (info.nuvola) {
    // file solo su OneDrive: si scarica solo con conferma; se il download viene annullato l'apertura si ferma
    const ok = await confirmBox("File solo su OneDrive", `"${info.nome}" (${fmtSize(info.size)}) non e' ancora su questo PC: per aprirlo OneDrive deve scaricarlo. Procedere?`, "Scarica e apri");
    if (!ok) return;
    toast(`Download di "${info.nome}" da OneDrive...`, false, 60000);
    try { info = await api("info", { path, scarica: 1 }); } catch (e) { return toast(e.message, true, 6000); }
    toast("File scaricato", false, 1500);
  }
  const name = extraCtx.displayName || info.nome;
  const { cat } = resolveCategory(extraCtx.displayName && !extOf(extraCtx.displayName) ? info.nome : name, info.sniff);
  const ext = extFor(info.nome);
  let viewer = forcedViewer || (cat ? cat.viewer : "hex");
  if (!forcedViewer && !WEB && TOOLS.onlyoffice && OO_EXTS.has(ext) && ["docx", "sheet", "pptx", "office"].includes(viewer)) viewer = "oo";
  // Navisworks senza Navisworks: NWD e NWC si aprono nel visualizzatore 3D (lettore nwd2mbv)
  if (!forcedViewer && !WEB && TOOLS.nwdreader && ["nwd", "nwc", "nwf"].includes(ext)) viewer = "model3d";
  const view = el("div", { class: "view" });
  const tb = el("div", { class: "tb" });
  const body = el("div", { class: "body" });
  view.append(tb, body);
  $("views").append(view);
  const tab = { path, name, viewer, forced: !!forcedViewer, info, view, dirty: false, extra: "", cat };
  tabs.push(tab);
  activate(tab);
  if (!extraCtx.untitled) remember(path);
  const ctx = {
    path, name, ext, info, cat, el: body, tb, tab, tools: TOOLS, registry: REG,
    reason: !cat && !forcedViewer ? "unlisted" : null, ...extraCtx,
    setDirty(v) { if (tab.dirty !== v) { tab.dirty = v; renderTabs(); } },
    status(text) { tab.extra = text || ""; if (active === tab) updateStatus(); },
    openPaths, openAs: v => openFile(tab.path, v), openFile,
    fillBody(fill = true) { body.classList.toggle("fill", fill); },
  };
  try {
    const mod = await import(`./viewers/${viewer}.js`);
    tab.api = (await mod.mount(ctx)) || {};
    addOfficeButton(tab, tb);
    if (extraCtx.untitled) { tab.untitled = true; tab.dirty = true; renderTabs(); } // file nuovo: si salva quando e dove si vuole
  } catch (e) {
    console.error(e);
    showError(ctx, e);
  }
}

export function showError(ctx, e) {
  ctx.el.innerHTML = "";
  ctx.el.append(el("div", { class: "center" }, el("div", { class: "panel", style: { maxWidth: "560px", textAlign: "left" } },
    el("h3", { style: { marginTop: 0 } }, "Non e' stato possibile mostrare il contenuto"),
    el("p", { class: "err" }, String(e?.message || e)),
    el("p", {}, "Il file resta comunque apribile come byte grezzi o come testo."),
    el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
      el("button", { class: "btn primary", onclick: () => ctx.openAs("hex") }, "Apri come esadecimale"),
      el("button", { class: "btn", onclick: () => ctx.openAs("text") }, "Apri come testo"),
      el("button", { class: "btn", onclick: () => api("open_external", { path: ctx.path }).catch(err => toast(err.message, true)) }, "Apri con programma di Windows")))));
}

// ------------------------------------------------------------------ salvataggio
async function save(asNew) {
  const t = active;
  if (!t) return;
  const a = t.api || {};
  // file nuovo mai salvato: Salva chiede subito dove (nella cartella Documenti, non in quella temporanea)
  if (t.untitled && !asNew && !WEB) {
    const target = await pickSavePath(t.name, "");
    if (!target) return;
    const ext = extOf(target);
    if (a.save && ((ext === extOf(t.path) && !a.saveFormats) || (a.saveFormats || []).includes(ext))) return doSave(t, a, target);
    return convertTo(t, a, target);
  }
  // "Salva con nome" sul PC: prima il formato (quelli del visualizzatore piu' quelli del convertitore), poi il nome
  if (!WEB && !t.path.startsWith("web://") && (asNew || !a.save)) {
    const fmt = await chooseFormat(t, a);
    if (!fmt) return;
    const target = await pickSavePath(t.name.replace(/.[^.]+$/, "") + "." + fmt, t.untitled ? "" : dirName(t.path));
    if (!target) return;
    const ext = extOf(target);
    if (a.save && ((ext === extOf(t.path) && !a.saveFormats) || (a.saveFormats || []).includes(ext))) return doSave(t, a, target);
    return convertTo(t, a, target);
  }
  if (!a.save) return toast("Questo tipo di file e' in sola lettura: usa \"Apri come\" o \"Esterno\" per modificarlo.", true);
  let target = t.path;
  if (asNew || a.saveInPlace === false || !t.info.scrivibile) {
    const suggested = a.saveAsName ? a.saveAsName() : t.name;
    target = await pickSavePath(suggested, dirName(t.path));
    if (!target) return;
  }
  return doSave(t, a, target);
}

async function doSave(t, a, target) {
  try {
    const res = (await a.save(target)) || {};
    t.dirty = false;
    await syncStat(t); // il salvataggio fatto da MB Visual non deve sembrare una modifica esterna
    if (target !== t.path && res.switchTo !== false && extOf(target) === extOf(t.path) && !target.startsWith("download://")) {
      t.path = target;
      t.name = baseName(target);
      t.untitled = false;
      try { t.info = await api("info", { path: target }); } catch { /* */ }
      if (t.api.renamed) t.api.renamed(target);
    }
    renderTabs();
    toast("Salvato: " + baseName(target));
  } catch (e) {
    console.error(e);
    toast("Salvataggio non riuscito: " + e.message, true, 6000);
  }
}

// formati in cui si puo' salvare il file aperto: scelta da un elenco
async function chooseFormat(t, a) {
  const src = extOf(t.path);
  const own = [...new Set([...(a.save && (!a.saveFormats || a.saveFormats.includes(src)) ? [src] : []), ...(a.saveFormats || [])])];
  let conv = [];
  try { const r = await api("convert_targets", { path: t.path }); conv = r.targets || []; conv.family = r.family; } catch { /* */ }
  const list = el("select", { size: 14, id: "fmt-choice", class: "field", style: { width: "100%", minWidth: "340px" } });
  if (own.length) {
    const g = el("optgroup", { label: "Formati dell'editor" });
    own.forEach(e => g.append(el("option", { value: e }, e.toUpperCase() + (a.saveLabels?.[e] ? " - " + a.saveLabels[e] : "") + (e === src ? "  (formato attuale)" : ""))));
    list.append(g);
  }
  const extra = conv.filter(c => !own.includes(c.ext));
  if (extra.length) {
    const g = el("optgroup", { label: "Conversione in altri formati" });
    extra.forEach(c => g.append(el("option", { value: c.ext }, `${c.ext.toUpperCase()} - ${c.label}`)));
    list.append(g);
  }
  if (!list.options.length) { toast("Per questo tipo di file non ci sono altri formati di salvataggio", true); return null; }
  list.selectedIndex = 0;
  list.addEventListener("dblclick", () => document.querySelector("#modal .btn.primary")?.click());
  const ok = await modal("Salva con nome: scegli il formato", el("div", { style: { display: "grid", gap: "8px" } }, list,
    el("p", { class: "note", style: { margin: 0, color: "var(--muted)" } }, a.saveNote || ((TOOLS.word || TOOLS.excel) && /^(word|sheet|slides)$/.test(conv.family || "") ? "I documenti Office vengono convertiti con Word, Excel e PowerPoint installati su questo PC." : ""))),
  [{ label: "Annulla", value: false }, { label: "Avanti", value: true, primary: true }]);
  return ok ? list.value : null;
}

async function convertTo(t, a, target) {
  try {
    let src = t.path;
    // modifiche non ancora salvate: prima si salva una copia temporanea, poi si converte quella
    if (t.dirty && a.save) {
      const tmp = (await api("temp_path", { name: t.info?.nome || t.name })).path;
      await a.save(tmp);
      src = tmp;
    }
    toast(`Conversione in ${extOf(target).toUpperCase()}...`, false, 600000);
    const { job } = await api("convert", { path: src }, { json: { out: target } });
    const r = await waitJob(job, (p, m) => { if (active === t) $("st-extra").textContent = `${m || "Conversione"} ${Math.round(p * 100)}%`; });
    toast("Salvato: " + baseName(target) + (r?.files ? ` (${r.files.length} file)` : r?.cartella ? ` (cartella ${baseName(r.cartella)})` : ""));
    updateStatus();
  } catch (e) {
    console.error(e);
    toast("Conversione non riuscita: " + e.message, true, 8000);
  }
}

// ------------------------------------------------------------------ modifica nei programmi Office e ricarica automatica
const OFFICE_EXT = { excel: /^(xlsx|xlsm|xlsb|xls|xltx|xltm|csv|ods)$/, word: /^(docx|docm|doc|dotx|dotm|rtf|odt)$/, powerpoint: /^(pptx|pptm|ppt|ppsx|potx|odp)$/ };
const OFFICE_NAME = { excel: "Excel", word: "Word", powerpoint: "PowerPoint" };
function addOfficeButton(t, tb) {
  if (WEB || t.path.startsWith("web://")) return;
  const app = Object.keys(OFFICE_EXT).find(a => OFFICE_EXT[a].test(extOf(t.path)) && TOOLS[a]);
  if (!app) return;
  const b = button(`Modifica in ${OFFICE_NAME[app]}`, "open", () => api("open_external", { path: t.path, app })
    .then(() => toast(`Aperto in ${OFFICE_NAME[app]}: quando salvi, MB Visual si aggiorna da solo`, false, 5000)).catch(e => toast(e.message, true)),
  { title: `Apre il file in ${OFFICE_NAME[app]}; al salvataggio MB Visual ricarica il file` });
  tb.prepend(b, el("span", { class: "sep" }));
}

async function syncStat(t) {
  try { const s = await api("stat", { path: t.path }); t.info.modificato = s.modificato; t.info.size = s.size; } catch { /* */ }
}

// un file aperto e salvato da un altro programma (Excel, Word, AutoCAD...) si ricarica da solo
async function checkExternalChange(t) {
  if (!t || WEB || !t.info || t.reloading || t.checking || t.path.startsWith("web://") || t.path.startsWith("download://")) return;
  t.checking = true;
  try {
    let s;
    try { s = await api("stat", { path: t.path }); } catch { return; }
    if (s.modificato === t.info.modificato) return;
    t.info.modificato = s.modificato;
    t.info.size = s.size;
    if (t.dirty && !(await confirmBox("File modificato da un altro programma", `"${t.name}" e' stato salvato da un altro programma. Ricaricarlo? Le modifiche non salvate in MB Visual andranno perse.`, "Ricarica", true))) return;
    await reloadTab(t);
    toast(`"${t.name}" aggiornato con le modifiche salvate fuori da MB Visual`);
  } finally { t.checking = false; }
}

async function reloadTab(t) {
  t.reloading = true;
  const before = tabs.length;
  await openFile(t.path, t.forced ? t.viewer : null, { fresh: true });
  if (tabs.length === before) { t.reloading = false; return; }
  const nt = tabs[tabs.length - 1];
  tabs.splice(tabs.indexOf(nt), 1);
  tabs.splice(tabs.indexOf(t), 0, nt);
  try { t.api?.dispose?.(); } catch { /* */ }
  t.view.remove();
  tabs.splice(tabs.indexOf(t), 1);
  if (seen.includes(t)) seen.splice(seen.indexOf(t), 1);
  activate(nt);
}

// ------------------------------------------------------------------ menu "Apri come"
function openAsMenu(anchor) {
  const m = $("menu-as");
  if (!m.hidden) { m.hidden = true; return; }
  closeMenus();
  m.innerHTML = "";
  m.append(el("div", { class: "sec label" }, `Visualizzatori adatti a .${extFor(active.info?.nome || active.name) || "?"}`));
  for (const v of compatibleViewers(active)) {
    const cur = v === active.viewer;
    m.append(el("button", { class: cur ? "current" : "", onclick: () => { m.hidden = true; if (!cur) openFile(active.path, v, { fresh: true }); } },
      VIEWER_NAMES[v], cur ? el("span", { class: "hint" }, "in uso") : null));
  }
  const ext = extFor(active.info?.nome || active.name);
  if (!WEB && TOOLS.navisworks && ["nwd", "nwc", "nwf"].includes(ext)) m.append(el("button", { onclick: () => { m.hidden = true; api("open_external", { path: active.path, app: "navisworks" }); } }, "Navisworks Freedom", el("span", { class: "hint" }, "esterno")));
  if (!WEB && TOOLS.trueview && ["dwg", "dxf", "dwf"].includes(ext)) m.append(el("button", { onclick: () => { m.hidden = true; api("open_external", { path: active.path, app: "trueview" }); } }, "DWG TrueView", el("span", { class: "hint" }, "esterno")));
  placeMenu(m, anchor);
}

// visualizzatori che sanno davvero leggere il file aperto (per tipo e contenuto), nell'ordine in cui conviene proporli
const TEXT_LIKE = new Set(["ifc", "step", "stp", "iges", "igs", "dxf", "obj", "gltf", "dae", "x3d", "wrl", "vrml", "ply", "stl", "svg", "csv", "tsv", "eml", "html", "htm",
  "xml", "json", "md", "markdown", "txt", "log", "ini", "cfg", "yaml", "yml", "rtf", "fodt", "fods", "fodp", "kml", "gpx", "geojson", "sql"]);
const ZIP_BASED = new Set(["docx", "docm", "dotx", "xlsx", "xlsm", "xltx", "pptx", "pptm", "potx", "ppsx", "odt", "ott", "ods", "odp", "otp", "epub", "3mf", "kmz", "jar", "apk", "vsdx", "xps", "oxps", "idml", "sketch", "ifczip"]);
function compatibleViewers(t) {
  const ext = extFor(t.info?.nome || t.name);
  const kind = t.info?.sniff?.kind;
  const out = [];
  const add = v => { if (v && VIEWER_NAMES[v] && !out.includes(v)) out.push(v); };
  add(t.viewer);
  for (const c of EXT.get(ext) || []) add(c.viewer);
  if (!WEB && TOOLS.onlyoffice && OO_EXTS.has(ext)) add("oo");
  if (ext === "svg") { add("svg"); add("image"); }
  if (["html", "htm", "xhtml"].includes(ext)) add("html");
  if (["md", "markdown"].includes(ext)) add("markdown");
  if (ext === "pdf" || kind === "pdf") add("pdf");
  if (kind === "text" || TEXT_LIKE.has(ext)) add("text");
  if (kind === "zip" || ZIP_BASED.has(ext)) add("archive");
  add("hex"); // i byte grezzi si possono sempre vedere
  return out;
}

// ------------------------------------------------------------------ pagina formati
function renderFormats() {
  const outer = $("formats");
  outer.innerHTML = "";
  const box = el("div", { class: "wrap" });
  outer.append(box);
  const all = new Set(REG.categories.flatMap(c => c.exts));
  const search = el("input", { class: "search", type: "search", id: "fmt-search", placeholder: "Cerca un'estensione, es. dwg, p7m, nwd, step" });
  const answer = el("div", { class: "answer", id: "fmt-answer" });
  const list = el("div");
  box.append(
    el("h1", {}, WEB ? "Formati supportati dalla web app" : "Formati supportati da MB Visual"),
    ...(WEB ? [el("p", { class: "lead" }, "La versione per PC apre piu' formati (RAW, Navisworks, Office con LibreOffice, conversione di qualsiasi video): questo elenco vale per il telefono e il browser.")] : []),
    el("p", { class: "lead" }, `${all.size} estensioni in ${REG.categories.length} categorie si aprono con un visualizzatore dedicato. ` +
      "Questo elenco e' generato dallo stesso registro che l'app usa per decidere come aprire un file: se un'estensione non c'e', " +
      "il file si apre solo come byte grezzi nell'editor esadecimale."),
    search, answer, list);
  const draw = () => {
    const q = search.value.trim().toLowerCase().replace(/^\*?\./, "");
    list.innerHTML = "";
    answer.textContent = "";
    if (q) {
      const hits = EXT.get(q);
      if (hits) {
        answer.innerHTML = "";
        answer.append(el("span", { class: "chip ok" }, "Si"), " ." + q + " si apre come: " + hits.map(c => c.name).join(" oppure "));
        const req = hits.find(c => c.requires && !TOOLS[c.requires]);
        if (req) answer.append(el("div", { class: "err", style: { fontWeight: 400 } }, `Attenzione: richiede ${REG.requirements[req.requires].name}, non presente su questo PC.`));
      } else {
        answer.innerHTML = "";
        answer.append(el("span", { class: "chip bad" }, "No"), ` .${q} non e' nell'elenco: si apre solo come byte grezzi (esadecimale).`);
      }
    }
    for (const c of REG.categories) {
      const exts = q ? c.exts.filter(e => e.includes(q)) : c.exts;
      if (q && !exts.length && !c.name.toLowerCase().includes(q)) continue;
      const req = c.requires ? REG.requirements[c.requires] : null;
      const status = req ? (TOOLS[c.requires] ? el("span", { class: "chip ok" }, req.name + " presente") : el("span", { class: "chip warn" }, "Richiede " + req.name + " (gratuito)")) : null;
      list.append(el("section", { class: "fcat" },
        el("header", {}, el("h2", {}, c.name), el("span", { class: "n" }, `${c.exts.length} estensioni`), status),
        el("p", {}, el("b", {}, "Visualizza: "), c.view),
        el("p", {}, el("b", {}, "Modifica: "), c.edit),
        el("div", { class: "exts" }, [...new Set(c.exts)].sort().map(e => el("code", { class: q && e === q ? "hit" : "" }, "." + e)))));
    }
    const fb = REG.fallback;
    list.append(el("section", { class: "fcat" }, el("header", {}, el("h2", {}, fb.name)),
      el("p", {}, el("b", {}, "Visualizza: "), fb.view), el("p", {}, el("b", {}, "Modifica: "), fb.edit)));
  };
  search.addEventListener("input", draw);
  draw();
}

function toggleFormats() {
  const f = $("formats");
  if (f.hidden) {
    renderFormats();
    f.hidden = false;
    $("home").hidden = true;
    $("views").hidden = true;
    $("btn-formats").classList.add("on");
    $("fmt-search").focus();
  } else {
    f.hidden = true;
    $("btn-formats").classList.remove("on");
    activate(active);
  }
}

// ------------------------------------------------------------------ tasto indietro (telefono, browser, mouse)
// L'app tiene sempre una voce di cronologia in piu': il tasto indietro la consuma, l'app torna alla schermata
// precedente e la rimette. Nella schermata iniziale non succede nulla: l'app non si chiude mai.
function goBack() {
  if (!$("modal").hidden) return document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  if (!$("menu-open").hidden || !$("menu-as").hidden || !$("menu-file").hidden) return closeMenus();
  if (!$("dragover").hidden) { $("dragover").hidden = true; return; }
  if (document.fullscreenElement) return document.exitFullscreen?.();
  if (!$("formats").hidden) return toggleFormats();
  if (!$("explorer").hidden) return toggleExplorer();
  if (!active) return;
  try { if (active.api?.onBack?.()) return; } catch { /* */ }
  closeTab(active); // torna al file visto prima o alla schermata iniziale; chiede conferma se ci sono modifiche
}

function setupBack() {
  const arm = () => { if (history.state?.mbv !== "guard") history.pushState({ mbv: "guard" }, ""); };
  history.replaceState({ mbv: "base" }, "");
  arm();
  // Chrome salta le voci aggiunte senza un tocco dell'utente: la protezione si rimette anche al primo tocco
  document.addEventListener("pointerdown", arm, true);
  document.addEventListener("keydown", arm, true);
  window.addEventListener("popstate", () => { arm(); goBack(); });
}

// ------------------------------------------------------------------ scorciatoie da tastiera (F1)
// ogni editor dichiara i suoi tasti (ui/js/shortcuts.js), con gli stessi del programma originale
function showShortcuts() {
  const sc = active?.shortcuts;
  const table = rows => {
    const t = el("table", { class: "kv-table", style: { borderCollapse: "collapse", width: "100%", fontSize: "12.5px" } });
    let group = null;
    for (const r of rows) {
      if (r.group && r.group !== group) { group = r.group; t.append(el("tr", {}, el("td", { colspan: 2, style: { padding: "10px 0 4px", fontWeight: 600 } }, group))); }
      t.append(el("tr", {}, el("td", { style: { padding: "3px 14px 3px 0", whiteSpace: "nowrap" } }, ...r.keys.split(/\s+oppure\s+|\s*\/\s*/).flatMap((k, i) => [i ? " / " : "", el("kbd", { style: { fontFamily: "Consolas, monospace", border: "1px solid var(--line-strong)", borderBottomWidth: "2px", borderRadius: "4px", padding: "0 5px", background: "var(--panel)" } }, k)])),
        el("td", { style: { padding: "3px 0", color: "var(--fg)" } }, r.desc)));
    }
    return t;
  };
  const box = el("div", { style: { maxHeight: "65vh", overflow: "auto", minWidth: "min(560px, 80vw)" } });
  if (sc?.list?.length) box.append(el("p", { class: "note", style: { margin: "0 0 4px" } }, `Tasti come in ${sc.program}${active ? " · " + active.name : ""}`), table(sc.list));
  else box.append(el("p", { class: "note" }, active ? "Questo visualizzatore non ha scorciatoie proprie." : "Apri un file per vedere le scorciatoie del suo editor."));
  box.append(el("hr", { style: { border: 0, borderTop: "1px solid var(--line)", margin: "12px 0 0" } }), table([
    { group: "MB Visual", keys: "Ctrl+O", desc: "Apri file" }, { group: "MB Visual", keys: "Ctrl+N", desc: "Crea nuovo" },
    { group: "MB Visual", keys: "Ctrl+S", desc: "Salva" }, { group: "MB Visual", keys: "Ctrl+Maiusc+S", desc: "Salva con nome (anche in altri formati)" },
    { group: "MB Visual", keys: "Ctrl+W", desc: "Chiudi il file" }, { group: "MB Visual", keys: "Ctrl+Tab", desc: "File successivo" }, { group: "MB Visual", keys: "F1", desc: "Questo elenco" },
  ]));
  modal("Scorciatoie da tastiera", box);
}

// ------------------------------------------------------------------ trascinamento
function setupDrop() {
  // "Rilascia per aprire": acceso finche' arrivano gli eventi dragover (ogni ~50 ms mentre si trascina sopra la
  // finestra) e spento poco dopo l'ultimo. Il vecchio conteggio entra/esci si sballava passando sopra i documenti
  // aperti (iframe) o uscendo dalla finestra senza rilasciare, e l'avviso restava acceso.
  let timer = 0;
  const show = v => ($("dragover").hidden = !v);
  const isFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
  const keep = () => { show(true); clearTimeout(timer); timer = setTimeout(() => show(false), 250); };
  window.addEventListener("dragenter", e => { if (isFiles(e)) keep(); });
  window.addEventListener("dragover", e => { e.preventDefault(); if (isFiles(e)) keep(); });
  window.addEventListener("dragleave", e => { if (!e.relatedTarget) { clearTimeout(timer); timer = setTimeout(() => show(false), 80); } });
  window.addEventListener("dragend", () => { clearTimeout(timer); show(false); });
  window.addEventListener("drop", async e => {
    e.preventDefault();
    clearTimeout(timer);
    show(false);
    if (isDesktop()) return; // nell'app desktop i percorsi arrivano dal motore (on_drop)
    // modalita' browser: carica i file in una cartella temporanea
    const paths = [];
    for (const f of e.dataTransfer.files) paths.push((await api("upload", { name: f.name }, { body: f })).path);
    await openPaths(paths, true);
  });
}

// ------------------------------------------------------------------ tema
function setupTheme() {
  let t = null;
  try { t = localStorage.getItem("mbv-theme"); } catch { /* */ }
  if (t) document.documentElement.dataset.theme = t;
  $("btn-theme").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("mbv-theme", next); } catch { /* */ }
    window.dispatchEvent(new CustomEvent("mbv-theme"));
  });
}

// ------------------------------------------------------------------ avvio
async function boot() {
  await loadRegistry();
  const caps = $("home-caps");
  const CAPS = WEB ? [
    ["doc.pdf", "Documenti", "PDF, Word, Excel, PowerPoint"],
    ["firma.p7m", "Firme digitali", "p7m, p7s, tsd, m7m, PDF firmati PAdES"],
    ["pianta.dwg", "Disegni CAD 2D", "DWG, DXF con layer, quote e misure"],
    ["modello.step", "Modelli CAD 3D", "STEP, IGES, BREP con albero delle parti"],
    ["edificio.ifc", "BIM e 3D", "IFC, STL, OBJ, GLB, FBX"],
    ["foto.jpg", "Immagini", "JPG, PNG, WEBP, TIFF, HEIC dell'iPhone"],
    ["video.mp4", "Audio e video", "MP4, MOV, WEBM, MP3, WAV, M4A e altri"],
    ["archivio.zip", "Archivi ed email", "ZIP, RAR, 7Z, TAR, ISO, EML"],
    ["codice.py", "Testo, codice e dati", "Editor professionale, SQLite, esadecimale"],
  ] : [
    ["doc.pdf", "Documenti", "PDF, Word, Excel, PowerPoint, OpenDocument"],
    ["firma.p7m", "Firme digitali", "p7m, p7s, tsd, m7m, PDF firmati PAdES"],
    ["pianta.dwg", "Disegni CAD 2D", "DWG, DXF con layer, quote e misure"],
    ["modello.step", "Modelli CAD 3D", "STEP, IGES, BREP con albero delle parti"],
    ["edificio.ifc", "BIM e 3D", "IFC, Navisworks, STL, OBJ, GLB, FBX"],
    ["foto.cr2", "Immagini", "JPG, PNG, TIFF, HEIC, PSD e RAW fotocamere"],
    ["video.mp4", "Audio e video", "Qualsiasi formato, con taglio e conversione"],
    ["archivio.zip", "Archivi ed email", "ZIP, RAR, 7Z, ISO, EML, MSG"],
    ["codice.py", "Testo, codice e dati", "Editor professionale, SQLite, esadecimale"],
  ];
  if (WEB) {
    document.documentElement.classList.add("web");
    $("drop").querySelector("h1").textContent = "Apri i file da visualizzare";
    $("drop").querySelector("p").textContent = "I file restano sul tuo dispositivo: nessun invio a server. Puoi anche condividerli da altre app verso MB Visual.";
  }
  for (const [f, t, d] of CAPS) caps.append(el("div", { class: "cap" }, badgeFor(f), el("b", {}, t), el("span", { class: "d" }, d)));
  const total = new Set(REG.categories.flatMap(c => c.exts)).size;
  $("home-formats").textContent = `${total} estensioni supportate · vedi l'elenco completo`;
  $("home-formats").addEventListener("click", toggleFormats);
  setupDrop();
  setupTheme();
  setupBack();
  if (!WEB) licenseGate(); // licenza dell'app per PC: senza attivazione copre l'app con la schermata della chiave
  if (!WEB) setTimeout(() => checkUpdates(false), 3000);
  setInterval(() => { if (!document.hidden) checkExternalChange(active); }, 2000);
  window.addEventListener("focus", () => tabs.forEach(checkExternalChange));
  $("btn-open").addEventListener("click", e => openMenu(e.currentTarget));
  $("home-open").addEventListener("click", doOpen);
  $("home-new").addEventListener("click", doNew);
  $("home-folder").addEventListener("click", chooseExplorerFolder);
  $("btn-explorer").addEventListener("click", toggleExplorer);
  $("btn-info").addEventListener("click", showProperties);
  $("ex-pick").addEventListener("click", chooseExplorerFolder);
  $("ex-up").addEventListener("click", () => exDir && dirName(exDir) && loadDir(dirName(exDir)));
  $("ex-filter").addEventListener("input", renderDir);
  $("btn-file").addEventListener("click", e => fileMenu(e.currentTarget));
  $("btn-as").addEventListener("click", e => openAsMenu(e.currentTarget));
  $("btn-folder").addEventListener("click", () => active && api("reveal", { path: active.path }));
  $("btn-external").addEventListener("click", () => active && api("open_external", { path: active.path }).catch(e => toast(e.message, true)));
  $("btn-formats").addEventListener("click", toggleFormats);
  document.addEventListener("click", e => { if (!e.target.closest(".menu-wrap")) closeMenus(); });
  document.addEventListener("keydown", e => {
    const k = e.key.toLowerCase();
    if (e.ctrlKey && k === "o") { e.preventDefault(); doOpen(); }
    else if (e.ctrlKey && k === "n") { e.preventDefault(); doNew(); }
    else if (e.ctrlKey && k === "s") { e.preventDefault(); save(e.shiftKey); }
    else if (e.ctrlKey && k === "w") { e.preventDefault(); if (active) closeTab(active); }
    else if (e.ctrlKey && k === "tab" && tabs.length) { e.preventDefault(); activate(tabs[(tabs.indexOf(active) + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length]); }
    else if (e.key === "F1") { e.preventDefault(); showShortcuts(); }
  });
  window.addEventListener("beforeunload", e => { if (tabs.some(t => t.dirty)) { e.preventDefault(); e.returnValue = ""; } });
  renderTabs();
}

window.MB = { openPaths, openFile, resolveCategory, get tabs() { return tabs; }, get active() { return active; }, activate, modal, askQuit };
const READY = boot();
