// MB Visual - guscio dell'applicazione: schede, apertura file, trascinamento, scelta del visualizzatore, pagina formati.
import {
  api, baseName, button, confirmBox, dirName, el, extOf, fmtSize, isDesktop, modal, pickFiles, pickFolder,
  pickSavePath, readRange, toast, waitJob, WEB,
} from "./core.js";
import { licenseGate, showAccount } from "./license.js";
import { t as tr, tn, has as trHas, LANG, LANGS, LOCALE, MANUAL, keyName, setLanguage } from "./i18n.js";

const $ = id => document.getElementById(id);
const VIEWER_NAMES = {
  pdf: "PDF", signed: tr("app.documento_firmato"), docx: "Word", sheet: tr("app.foglio_calcolo"), pptx: tr("app.presentazione"),
  office: tr("app.documento_office_libreoffice"), text: tr("app.testo_codice"), markdown: "Markdown", html: tr("app.pagina_web"),
  image: tr("app.immagine"), svg: "SVG", media: tr("app.audio_video"), cad2d: tr("app.disegno_cad_2d"), model3d: tr("app.modello_3d"),
  external: tr("app.programma_esterno"), archive: tr("app.archivio"), email: tr("app.email"), epub: "eBook", font: "Font",
  sqlite: tr("app.database_sqlite"), video: tr("app.montaggio_video"), publisher: tr("app.pubblicazione_publisher"), visio: tr("app.diagramma_visio"), gis: tr("app.mappa_gis"), bcf: tr("app.segnalazioni_bim_bcf"), hex: tr("app.esadecimale_byte_grezzi"), oo: tr("app.word_excel_powerpoint_onlyoffice"), compare: tr("app.confronto_revisioni"),
};
// documenti che sul PC si aprono nell'editor ONLYOFFICE integrato (modifica completa come nei programmi originali)
const OO_EXTS = new Set(["docx", "docm", "dotx", "dotm", "doc", "dot", "rtf", "odt", "ott", "fodt", "xlsx", "xlsm", "xltx", "xltm", "xls", "xlt", "ods", "fods", "csv",
  "pptx", "pptm", "potx", "potm", "ppsx", "ppsm", "ppt", "pps", "pot", "odp", "otp", "fodp"]);
const TEXT_VIEWERS = new Set(["text", "markdown", "html", "svg"]);
const SNIFF_FAMILY = {
  pdf: ["pdf"], signed: ["signed"], media: ["media", "audio"], archive: ["archive"], image: ["image", "image-raw"],
  zip: ["word", "sheet", "pptx", "publisher", "visio", "office-lo", "archive", "mesh3d", "ebook"], sqlite: ["database"],
  ole: ["publisher", "visio", "office-lo", "sheet", "email", "archive", "image"], cad2d: ["cad2d"], ifc: ["mesh3d"], cad3d: ["cad3d"],
  mesh3d: ["mesh3d"], pointcloud: ["pointcloud"], font: ["font"], svg: ["svg"], html: ["html"], email: ["email"], vis3d: ["vis3d"],
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
  // dati geografici: precedenza alla mappa GIS (TIFF e ZIP solo se georeferenziati / con shapefile: vedi gisViewer)
  const gis = cands.find(c => c.id === "gis");
  if (gis && !["tif", "tiff", "zip"].includes(ext)) return { cat: gis, ext };
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
const BADGE_COLOR = { pdf: "pdf", signed: "sig", word: "doc", "office-lo": "doc", sheet: "xls", pptx: "ppt", publisher: "cad", visio: "doc", cad2d: "cad",
  cad3d: "3d", mesh3d: "3d", pointcloud: "3d", navisworks: "3d", vis3d: "3d", sketchup: "3d", image: "img", "image-raw": "img", svg: "img", media: "av", audio: "av", videoproject: "av", bcf: "3d",
  archive: "zip", email: "mail", text: "code", markdown: "code", html: "code", ebook: "code", font: "code", database: "db", gis: "img" };
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
  box.append(el("div", { class: "tab home-tab" + (!active && $("formats").hidden ? " active" : ""), role: "tab", title: tr("app.home_trascina_qui_i_file"), onclick: () => activate(null) },
    el("span", { html: '<svg viewBox="0 0 24 24"><path d="M3 11l9-8 9 8M5 9v12h14V9"/></svg>' }), el("span", { class: "name" }, tr("app.home"))));
  for (const t of tabs) {
    const b = el("div", { class: "tab" + (t === active ? " active" : ""), role: "tab", title: t.path, onclick: () => activate(t) },
      badgeFor(t.info?.nome || t.name),
      el("span", { class: "name" }, t.name + (t.forced ? "  ·  " + VIEWER_NAMES[t.viewer] : "")),
      t.dirty ? el("span", { class: "dot", title: tr("app.modifiche_non_salvate") }) : null,
      el("button", { class: "x", title: tr("common.chiudi"), onclick: e => { e.stopPropagation(); closeTab(t); } }, "×"));
    b.addEventListener("auxclick", e => { if (e.button === 1) closeTab(t); });
    box.append(b);
  }
  box.append(el("button", { class: "tab-closeall", title: tr("app.chiudi_tutti_i_file_aperti"), disabled: !tabs.length || undefined, onclick: closeAll },
    el("span", { html: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>' }), tr("app.chiudi_tutto")));
  const has = !!active;
  for (const id of ["btn-as", "btn-folder", "btn-external", "btn-info"]) $(id).disabled = !has;
  $("home").hidden = has || !$("formats").hidden;
  $("views").hidden = !has || !$("formats").hidden;
  updateStatus();
  try { window.pywebview?.api?.set_dirty?.(tabs.filter(t => t.dirty).length); } catch { /* */ } // per la domanda alla chiusura
}

function updateStatus() {
  const t = active;
  $("st-path").textContent = t ? (t.path.startsWith("web://") ? t.info?.nome || t.name : t.path) : tr("app.pronto");
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
  const r = await modal(tr("app.vuoi_salvare"), el("p", {}, t.untitled ? tr("app.0_file_nuovo_non_ancora", t.name) : tr("app.vuoi_salvare_modifiche_0", t.name)),
    [{ label: tr("common.annulla"), value: null }, { label: tr("app.non_salvare"), value: "no" }, { label: tr("common.salva"), value: "si", primary: true }]);
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
  m.append(item(ICON_FILE, tr("app.apri_file"), "Ctrl+O", doOpen));
  if (!WEB) m.append(item(ICON_FOLDER, tr("app.cartella_progetto"), "", chooseExplorerFolder));
  if (WEB) m.append(item(ICON_SCAN, tr("scanner.menu"), "", doScan));
  m.append(el("hr"), el("div", { class: "sec label" }, tr("app.recenti")));
  // nella web app i file non restano disponibili dopo la chiusura: i recenti non si possono riaprire
  const list = WEB ? [] : recentList();
  if (!list.length) m.append(el("div", { class: "empty" }, WEB ? tr("app.web_app_i_file_restano") : tr("app.nessun_file_aperto_recente")));
  for (const r of list) {
    m.append(el("button", { class: "rec", title: r.path, onclick: () => { m.hidden = true; openPaths([r.path]); } },
      badgeFor(r.name), el("span", { class: "nm" }, r.name), el("span", { class: "pt" }, dirName(r.path))));
  }
  if (list.length) m.append(el("hr"), item("", tr("app.svuota_l_elenco_recenti"), "", () => { try { localStorage.removeItem("mbv-recent"); } catch { /* */ } }));
  placeMenu(m, anchor);
}

const ICON_SAVE = '<svg viewBox="0 0 24 24"><path d="M5 3h11l3 3v15H5zM8 3v6h8V3M8 21v-7h8v7"/></svg>';
const ICON_SAVEAS = '<svg viewBox="0 0 24 24"><path d="M5 3h11l3 3v6M5 3v18h7M8 3v6h8V3M17 15v6M14 18h6"/></svg>';
const ICON_UPD = '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>';
// menu File: nuovo, salva, salva con nome, aggiornamenti (le voci di apertura stanno nel menu Apri)
const ICON_ACCOUNT = '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/></svg>';
// stampa professionale (ui/js/print.js, mbvisual/stampa.py): solo app per PC
const ICON_PRINT = '<svg viewBox="0 0 24 24"><path d="M7 9V3h10v6M7 17H4v-8h16v8h-3M7 14h10v7H7z"/></svg>';
async function doPrint(batch = false) {
  if (WEB) return toast(tr("app.stampa_solo_pc"), true);
  const m = await import("./print.js");
  if (batch) m.openBatchPrint();
  else if (active) m.openPrint(active);
  else m.openBatchPrint();
}
function fileMenu(anchor) {
  const m = $("menu-file");
  if (!m.hidden) { m.hidden = true; return; }
  closeMenus();
  m.innerHTML = "";
  const item = (icon, text, hint, fn, disabled = false) => { const b = el("button", { disabled: disabled || undefined, onclick: () => { m.hidden = true; fn(); } }); b.insertAdjacentHTML("beforeend", icon); b.append(el("span", {}, text)); if (hint) b.append(el("span", { class: "hint" }, hint)); return b; };
  m.append(item(ICON_NEW, tr("app.crea_nuovo"), "Ctrl+N", doNew),
    item(ICON_SAVE, tr("common.salva"), "Ctrl+S", () => save(false), !active),
    item(ICON_SAVEAS, tr("app.salva_nome"), keysText("Ctrl+Shift+S"), () => save(true), !active),
    ...(window.MBCloud ? [item('<svg viewBox="0 0 24 24"><path d="M7 18h10a4 4 0 0 0 .6-8A6 6 0 0 0 6 9.5 4.3 4.3 0 0 0 7 18z"/></svg>', tr("cloud.salva_nel_cloud"), "", () => window.MBCloud.saveToCloud(), !active)] : []), // ui/js/cloud.js
    ...(WEB ? [] : [item(ICON_PRINT, tr("app.stampa"), "Ctrl+P", () => doPrint(), !active), item(ICON_PRINT, tr("app.stampa_lotti"), keysText("Ctrl+Shift+P"), () => doPrint(true))]),
    item('<svg viewBox="0 0 24 24"><path d="M3 6h18v12H3zM6 9h2M10 9h2M14 9h2M18 9h0M6 13h12"/></svg>', tr("app.scorciatoie_tastiera"), "F1", showShortcuts),
    item('<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></svg>', tr("lang.impostazioni") + " › " + tr("lang.titolo") + "...", LANG.toUpperCase(), showLanguage));
  if (!WEB) m.append(item('<svg viewBox="0 0 24 24"><path d="M3 17c3-1 4-7 6-7s1 6 3 6 3-4 5-4 2 3 4 3M3 21h18"/></svg>', tr("app.firma_digitale"), "", () => import("./firma.js").then(f => f.signDialog({ path: active.path, openFile })), !active?.path)); // ui/js/firma.js
  // confronto tra revisioni (PDF, DWG/DXF, IFC): ui/js/viewers/compare.js
  m.append(item('<svg viewBox="0 0 24 24"><path d="M4 4h7v16H4zM13 4h7v16h-7M8 9l-2 2 2 2M16 9l2 2-2 2"/></svg>', tr("app.confronta_con"), "", compareWith, !active || active.viewer === "compare" || !COMPARE_EXT.test(extOf(active.info?.nome || active.name))));
  if (WEB && window.MBV_MOBILE) m.append(el("hr"), item(ICON_ACCOUNT, tr("app.account_licenza"), "", showAccount)); // app per cellulari con licenza
  if (!WEB) {
    // conversione a lotti (ui/js/batch.js): cartella del pannello Esplora gia' proposta
    m.append(item('<svg viewBox="0 0 24 24"><path d="M4 4h10v10H4zM10 10h10v10H10M17 6l3 3-3 3"/></svg>', tr("app.conversione_lotti"), "",
      () => import("./batch.js").then(b => b.openBatch({ paths: exDir && !$("explorer").hidden ? [exDir] : [] }))));
    m.append(el("hr"), item(ICON_ACCOUNT, tr("app.account_licenza"), "", showAccount), item(ICON_UPD, tr("app.verifica_aggiornamenti"), "", () => checkUpdates(true)));
    m.append(item('<svg viewBox="0 0 24 24"><path d="M3 5h8v6H3zM13 5h8v6h-8zM3 13h8v6H3zM13 13h8v6h-8z"/></svg>', tr("app.integrazione_windows"), "", () => import("./shellint.js").then(x => x.showShellIntegration())));
    if (updInfo?.installabile && !updInfo.installata) m.append(item("", tr("app.installa_questo_pc"), "", askInstall));
  }
  placeMenu(m, anchor);
}

// ---- Impostazioni > Lingua: automatica (Windows) o scelta a mano; si applica ricaricando l'interfaccia
async function showLanguage() {
  const box = el("div", { style: { display: "grid", gap: "6px", minWidth: "320px" } });
  const opts = [["", tr("lang.automatica")], ...LANGS];
  for (const [code, name] of opts) {
    const r = el("input", { type: "radio", name: "mbv-lang", value: code });
    r.checked = MANUAL ? code === LANG : code === "";
    box.append(el("label", { style: { display: "flex", gap: "8px", alignItems: "center" } }, r, name));
  }
  box.append(el("p", { class: "note", style: { margin: "6px 0 0", color: "var(--muted)" } }, tr("lang.nota")));
  const ok = await modal(tr("lang.titolo"), box, [{ label: tr("common.annulla"), value: false }, { label: tr("common.ok"), value: true, primary: true }]);
  if (!ok) return;
  const code = box.querySelector("input:checked")?.value ?? "";
  if ((MANUAL ? code === LANG : code === "")) return;
  setLanguage(code);
  if (!tabs.length) return location.reload();
  const now = await modal(tr("lang.titolo"), el("p", {}, tr("lang.ricarica")), [{ label: tr("lang.dopo"), value: false }, { label: tr("lang.ricarica_ora"), value: true, primary: true }]);
  if (!now) return toast(tr("lang.al_prossimo_avvio"));
  for (const t of tabs.filter(x => x.dirty)) if (!(await settle(t))) return;
  for (const t of tabs) t.dirty = false;
  location.reload();
}

// ---- aggiornamento automatico dalla cartella "App per PC" su OneDrive (mbvisual/update.py)
let updInfo = null;
const fmtVer = v => v ? `${v.versione}${v.build && v.build !== "sviluppo" ? " del " + v.build.slice(0, 16).split(" ").map((x, i) => i ? x : x.split("-").reverse().join("/")).join(" ") : ""}` : "";
async function checkUpdates(manual = false) {
  let r;
  try { r = updInfo = await api("update_check"); } catch (e) { if (manual) toast(tr("app.controllo_non_riuscito") + e.message, true); return; }
  updInfo.installata = !r.da_onedrive && r.stato !== "sviluppo" && /\\Programs\\MB Visual\\?$/i.test(r.cartella || "");
  $("st-version").textContent = "v" + r.attuale.versione;
  $("st-version").title = "MB Visual " + fmtVer(r.attuale);
  if (r.stato === "nuova") {
    const ok = await modal(tr("app.aggiornamento_disponibile"), el("div", {},
      el("p", {}, tr("app.disponibile_mb_visual_0", fmtVer(r.disponibile))), el("p", { class: "note" }, tr("app.uso_0_l_app_si", fmtVer(r.attuale)))),
      [{ label: tr("app.piu_tardi"), value: false }, { label: tr("app.aggiorna_ora"), value: true, primary: true }]);
    if (!ok) return;
    if (tabs.some(t => t.dirty) && !(await confirmBox(tr("app.file_non_salvati"), tr("app.ci_sono_modifiche_non_salvate"), tr("app.aggiorna"), true))) return;
    await runUpdateJob("update_apply", tr("app.aggiornamento_mb_visual"), tr("app.aggiornamento_pronto_mb_visual_si"));
    return;
  }
  if (r.stato === "sincronizzazione") {
    if (manual || r.da_onedrive) toast(tr("app.onedrive_sta_ancora_scaricando_mb", r.disponibile?.versione || ""), true, 12000);
    return;
  }
  if (r.da_onedrive && !manual) {
    let asked = false;
    try { asked = localStorage.getItem("mbv-install-asked") === "1"; localStorage.setItem("mbv-install-asked", "1"); } catch { /* */ }
    if (!asked) askInstall();
    return;
  }
  if (!manual) return;
  if (r.stato === "sviluppo") return toast(tr("app.versione_sviluppo_aggiornamenti_valgono_solo"));
  if (r.stato === "nessuna_fonte") {
    const ok = await modal(tr("app.aggiornamenti"), el("p", {}, tr("app.non_trovo_questo_pc_cartella")),
      [{ label: tr("common.annulla"), value: false }, { label: tr("app.scegli_cartella"), value: true, primary: true }]);
    if (!ok) return;
    const folder = await pickFolder();
    if (!folder) return;
    try { await api("update_source", { folder }); return checkUpdates(true); } catch (e) { return toast(e.message, true, 8000); }
  }
  toast(tr("app.hai_gia_l_ultima_versione", fmtVer(r.attuale)));
}
async function askInstall() {
  const integ = el("input", { type: "checkbox", checked: true });
  const ok = await modal(tr("app.installa_mb_visual_questo_pc"), el("div", {},
    el("p", {}, tr("app.stai_usando_l_app_direttamente")),
    el("p", {}, tr("app.installandola_questo_pc_senza_diritti")),
    el("label", { style: { display: "flex", gap: "8px" } }, integ, tr("app.integra_esplora_installa"))),
    [{ label: tr("app.non_ora"), value: false }, { label: tr("app.installa"), value: true, primary: true }]);
  if (!ok) return;
  await runUpdateJob("update_install", tr("app.installazione_mb_visual"), tr("app.installata_mb_visual_si_riapre"), { integrazione: integ.checked ? 1 : 0 });
}
// installazione / aggiornamento con finestra di avanzamento (la copia scarica da OneDrive i file "solo online": puo' richiedere minuti)
async function runUpdateJob(route, title, doneText, params = {}) {
  const bar = el("div", { class: "progress" }, el("span"));
  const msg = el("p", {}, tr("app.avvio"));
  const back = $("modal"), body = $("modal-body");
  body.innerHTML = "";
  body.append(el("h3", {}, title), msg, bar, el("p", { class: "note" }, tr("app.non_chiudere_mb_visual_fine")));
  back.hidden = false;
  try {
    const { job } = await api(route, params);
    await waitJob(job, (p, m) => { bar.firstChild.style.width = Math.round(p * 100) + "%"; if (m) msg.textContent = m; });
    bar.firstChild.style.width = "100%";
    msg.textContent = doneText;
  } catch (e) {
    back.hidden = true;
    await modal(title + tr("app.non_riuscita"), el("div", {}, el("p", {}, e.message), el("p", { class: "note" }, tr("app.dettagli_file_mbvisual_aggiornamento_log"))));
  }
}

// nuovo file vuoto (Word, Excel, PowerPoint, PDF, DXF, testo, immagini, database), aperto subito nel suo editor
async function doNew() {
  const { createNew } = await import("./newfile.js");
  await createNew({ dir: exDir || "", openFile: (p, v, x) => openFile(p, v, x) });
}

// app per telefono: scansione di documenti con la fotocamera -> PDF (ui/js/scanner.js)
const ICON_SCAN = '<svg viewBox="0 0 24 24"><path d="M3 8V4h4M17 4h4v4M21 16v4h-4M7 20H3v-4M7 9h10M7 12h10M7 15h6"/></svg>';
async function doScan() {
  const { openScanner } = await import("./scanner.js");
  openScanner({ openPdf: f => openFile(window.MBV_API.register(f, f.name)) });
}

async function doOpen() { const ps = await pickFiles(); if (ps?.length) openPaths(ps); }

// ------------------------------------------------------------------ confronto tra due revisioni
const COMPARE_EXT = /^(pdf|dwg|dxf|ifc)$/;
const cmpFam = n => ({ pdf: "pdf", dwg: "cad", dxf: "cad", ifc: "ifc" })[extOf(n)];
async function compareWith() {
  const t = active;
  if (!t || t.viewer === "compare") return;
  const ps = await pickFiles();
  if (!ps?.length) return;
  if (cmpFam(ps[0]) !== cmpFam(t.info?.nome || t.name)) return toast(tr("app.confronto_stesso_tipo"), true, 6000);
  openCompare(t.path, ps[0]);
}
function openCompare(a, b) {
  return openFile(a, "compare", { compareWith: b, fresh: true, displayName: `${baseName(a)} ↔ ${baseName(b)}` });
}

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
  } catch (e) { toast(tr("app.cartella_non_accessibile") + e.message, true); }
}
function renderDir() {
  const q = $("ex-filter").value.trim().toLowerCase();
  const box = $("ex-list");
  box.innerHTML = "";
  const items = exItems.filter(i => !q || i.name.toLowerCase().includes(q));
  for (const i of items) {
    box.append(el("button", { class: "ex-item" + (i.dir ? " dir" : ""), title: i.name, "data-path": i.path, onclick: () => (i.dir ? loadDir(i.path) : openPaths([i.path])) },
      badgeFor(i.name, i.dir), el("span", { class: "nm" }, i.name),
      el("span", { class: "sz", title: i.nuvola ? tr("app.solo_onedrive_verra_scaricato_all") : "" }, (i.nuvola ? "☁ " : "") + (i.dir ? "" : fmtSize(i.size)))));
  }
  if (!items.length) box.append(el("div", { class: "note", style: { padding: "8px 12px", color: "var(--muted)" } }, q ? tr("app.nessun_file_corrisponde_filtro") : tr("app.cartella_vuota")));
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
  add(tr("common.nome"), i.nome);
  add(tr("app.cartella"), i.cartella);
  add(tr("app.dimensione"), `${fmtSize(i.size)} (${i.size.toLocaleString(LOCALE)} ${tr("units.byte")})`);
  add(tr("app.modificato"), new Date(i.modificato * 1000).toLocaleString(LOCALE));
  add(tr("app.creato"), new Date(i.creato * 1000).toLocaleString(LOCALE));
  add(tr("app.tipo_rilevato_contenuto"), i.sniff?.descr || "-");
  add(tr("app.aperto"), VIEWER_NAMES[t.viewer]);
  add(tr("app.scrivibile"), i.scrivibile ? tr("common.si") : tr("app.no_sola_lettura"));
  const hash = el("dd", { class: "mono" }, tr("app.calcolo_corso"));
  dl.append(el("dt", {}, tr("app.impronta_sha_256")), hash);
  const copy = el("button", { class: "btn", onclick: () => navigator.clipboard?.writeText(hash.textContent).then(() => toast(tr("app.impronta_copiata"))) }, tr("app.copia_impronta"));
  api("file_hash", { path: t.path }).then(r => (hash.textContent = r.sha256)).catch(e => (hash.textContent = tr("app.non_disponibile") + e.message));
  await modal(tr("app.proprieta_file"), el("div", { style: { display: "grid", gap: "12px" } }, dl,
    el("p", { class: "note", style: { margin: 0, color: "var(--muted)" } }, tr("app.l_impronta_sha_256_identifica")), copy));
}

// ------------------------------------------------------------------ apertura
async function openPaths(paths, fromDrop = false) {
  if (fromDrop) $("dragover").hidden = true;
  // un visualizzatore puo' accettare i file trascinati (es. aggiungerli a un archivio)
  if (fromDrop && active && $("formats").hidden && active.api?.acceptDrop && (await active.api.acceptDrop(paths))) return;
  // due revisioni dello stesso tipo trascinate insieme: si puo' aprire subito il confronto
  if (fromDrop && paths.length === 2 && cmpFam(paths[0]) && cmpFam(paths[0]) === cmpFam(paths[1])) {
    const r = await modal(tr("app.confronto_due_file"), el("p", {}, tr("app.confronto_domanda", baseName(paths[0]), baseName(paths[1]))),
      [{ label: tr("app.apri_separatamente"), value: "open" }, { label: tr("app.confronta"), value: "cmp", primary: true }]);
    if (r === "cmp") return openCompare(paths[0], paths[1]);
    if (!r) return;
  }
  for (const p of paths) await openFile(p);
}

async function openFile(path, forcedViewer = null, extraCtx = {}) {
  await READY; // il registro dei formati deve essere caricato prima di scegliere il visualizzatore
  const existing = tabs.find(t => t.path === path && (!forcedViewer || t.viewer === forcedViewer));
  if (existing && !extraCtx.fresh) return activate(existing);
  let info;
  try { info = await api("info", { path }); } catch (e) { return toast(tr("app.impossibile_aprire") + e.message, true); }
  if (info.nuvola) {
    // file solo su OneDrive: si scarica solo con conferma; se il download viene annullato l'apertura si ferma
    const ok = await confirmBox(tr("app.file_solo_onedrive"), tr("app.0_1_non_ancora_questo", info.nome, fmtSize(info.size)), tr("app.scarica_apri"));
    if (!ok) return;
    toast(tr("app.download_0_onedrive", info.nome), false, 60000);
    try { info = await api("info", { path, scarica: 1 }); } catch (e) { return toast(e.message, true, 6000); }
    toast(tr("app.file_scaricato"), false, 1500);
  }
  const name = extraCtx.displayName || info.nome;
  const { cat } = resolveCategory(extraCtx.displayName && !extOf(extraCtx.displayName) ? info.nome : name, info.sniff);
  const ext = extFor(info.nome);
  let viewer = forcedViewer || (cat ? cat.viewer : "hex");
  if (!forcedViewer && !WEB && TOOLS.onlyoffice && OO_EXTS.has(ext) && ["docx", "sheet", "pptx", "office"].includes(viewer)) viewer = "oo";
  // Navisworks senza Navisworks: NWD e NWC si aprono nel visualizzatore 3D (lettore nwd2mbv)
  if (!forcedViewer && !WEB && TOOLS.nwdreader && ["nwd", "nwc", "nwf"].includes(ext)) viewer = "model3d";
  if (!forcedViewer) viewer = await gisViewer(path, ext, viewer);
  const view = el("div", { class: "view" });
  const tb = el("div", { class: "tb" });
  const body = el("div", { class: "body" });
  view.append(tb, body);
  $("views").append(view);
  const tab = { path, name, viewer, forced: !!forcedViewer, info, view, dirty: false, extra: "", cat, compareWith: extraCtx.compareWith };
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

// GeoTIFF e zip con shapefile si aprono nella mappa GIS (ui/js/viewers/gis.js); gli altri TIFF e ZIP restano immagini e archivi
async function gisViewer(path, ext, viewer) {
  if (!["tif", "tiff", "zip"].includes(ext)) return viewer;
  try {
    const gis = await import("./gisio.js");
    if (ext === "zip") return gis.isGisZip((await api("archive_list", { path })).items) ? "gis" : viewer;
    return (await gis.isGeoTiff((a, b) => readRange(path, a, b))) ? "gis" : viewer;
  } catch { return viewer; }
}

export function showError(ctx, e) {
  ctx.el.innerHTML = "";
  ctx.el.append(el("div", { class: "center" }, el("div", { class: "panel", style: { maxWidth: "560px", textAlign: "left" } },
    el("h3", { style: { marginTop: 0 } }, tr("app.non_stato_possibile_mostrare_contenuto")),
    el("p", { class: "err" }, String(e?.message || e)),
    el("p", {}, tr("app.file_resta_comunque_apribile_come")),
    el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
      el("button", { class: "btn primary", onclick: () => ctx.openAs("hex") }, tr("app.apri_come_esadecimale")),
      el("button", { class: "btn", onclick: () => ctx.openAs("text") }, tr("app.apri_come_testo")),
      el("button", { class: "btn", onclick: () => api("open_external", { path: ctx.path }).catch(err => toast(err.message, true)) }, tr("app.apri_programma_windows"))))));
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
  if (!a.save) return toast(tr("app.questo_tipo_file_sola_lettura"), true);
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
    toast(tr("app.salvato") + baseName(target));
  } catch (e) {
    console.error(e);
    toast(tr("app.salvataggio_non_riuscito") + e.message, true, 6000);
  }
}

// formati in cui si puo' salvare il file aperto: scelta da un elenco
async function chooseFormat(t, a) {
  const src = extOf(t.path);
  const own = [...new Set([...(a.save && (!a.saveFormats || a.saveFormats.includes(src)) ? [src] : []), ...(a.saveFormats || [])])];
  let conv = [];
  if (!a.noConvert) try { const r = await api("convert_targets", { path: t.path }); conv = r.targets || []; conv.family = r.family; } catch { /* */ }
  const list = el("select", { size: 14, id: "fmt-choice", class: "field", style: { width: "100%", minWidth: "340px" } });
  if (own.length) {
    const g = el("optgroup", { label: tr("app.formati_dell_editor") });
    own.forEach(e => g.append(el("option", { value: e }, e.toUpperCase() + (a.saveLabels?.[e] ? " - " + a.saveLabels[e] : "") + (e === src ? tr("app.formato_attuale") : ""))));
    list.append(g);
  }
  const extra = conv.filter(c => !own.includes(c.ext));
  if (extra.length) {
    const g = el("optgroup", { label: tr("app.conversione_altri_formati") });
    extra.forEach(c => g.append(el("option", { value: c.ext }, `${c.ext.toUpperCase()} - ${c.label}`)));
    list.append(g);
  }
  if (!list.options.length) { toast(tr("app.questo_tipo_file_non_ci"), true); return null; }
  list.selectedIndex = 0;
  list.addEventListener("dblclick", () => document.querySelector("#modal .btn.primary")?.click());
  const ok = await modal(tr("app.salva_nome_scegli_formato"), el("div", { style: { display: "grid", gap: "8px" } }, list,
    el("p", { class: "note", style: { margin: 0, color: "var(--muted)" } }, a.saveNote || ((TOOLS.word || TOOLS.excel) && /^(word|sheet|slides)$/.test(conv.family || "") ? tr("app.i_documenti_office_vengono_convertiti") : ""))),
  [{ label: tr("common.annulla"), value: false }, { label: tr("common.avanti"), value: true, primary: true }]);
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
    toast(tr("app.conversione_0", extOf(target).toUpperCase()), false, 600000);
    const { job } = await api("convert", { path: src }, { json: { out: target } });
    const r = await waitJob(job, (p, m) => { if (active === t) $("st-extra").textContent = `${m || tr("app.conversione")} ${Math.round(p * 100)}%`; });
    toast(tr("app.salvato") + baseName(target) + (r?.files ? tr("app.0_file", r.files.length) : r?.cartella ? tr("app.cartella_0", baseName(r.cartella)) : ""));
    updateStatus();
  } catch (e) {
    console.error(e);
    toast(tr("app.conversione_non_riuscita") + e.message, true, 8000);
  }
}

// ------------------------------------------------------------------ modifica nei programmi Office e ricarica automatica
const OFFICE_EXT = { excel: /^(xlsx|xlsm|xlsb|xls|xltx|xltm|csv|ods)$/, word: /^(docx|docm|doc|dotx|dotm|rtf|odt)$/, powerpoint: /^(pptx|pptm|ppt|ppsx|potx|odp)$/ };
const OFFICE_NAME = { excel: "Excel", word: "Word", powerpoint: "PowerPoint" };
function addOfficeButton(t, tb) {
  if (WEB || t.path.startsWith("web://")) return;
  const app = Object.keys(OFFICE_EXT).find(a => OFFICE_EXT[a].test(extOf(t.path)) && TOOLS[a]);
  if (!app) return;
  const b = button(tr("app.modifica_0", OFFICE_NAME[app]), "open", () => api("open_external", { path: t.path, app })
    .then(() => toast(tr("app.aperto_0_quando_salvi_mb", OFFICE_NAME[app]), false, 5000)).catch(e => toast(e.message, true)),
  { title: tr("app.apre_file_0_salvataggio_mb", OFFICE_NAME[app]) });
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
    if (t.dirty && !(await confirmBox(tr("app.file_modificato_altro_programma"), tr("app.0_stato_salvato_altro_programma", t.name), tr("app.ricarica"), true))) return;
    await reloadTab(t);
    toast(tr("app.0_aggiornato_modifiche_salvate_fuori", t.name));
  } finally { t.checking = false; }
}

async function reloadTab(t) {
  t.reloading = true;
  const before = tabs.length;
  await openFile(t.path, t.forced ? t.viewer : null, { fresh: true, ...(t.compareWith ? { compareWith: t.compareWith, displayName: t.name } : {}) });
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
  m.append(el("div", { class: "sec label" }, tr("app.visualizzatori_adatti_0", extFor(active.info?.nome || active.name) || "?")));
  for (const v of compatibleViewers(active)) {
    const cur = v === active.viewer;
    m.append(el("button", { class: cur ? "current" : "", onclick: () => { m.hidden = true; if (!cur) openFile(active.path, v, { fresh: true }); } },
      VIEWER_NAMES[v], cur ? el("span", { class: "hint" }, tr("app.uso")) : null));
  }
  const ext = extFor(active.info?.nome || active.name);
  if (!WEB && TOOLS.navisworks && ["nwd", "nwc", "nwf"].includes(ext)) m.append(el("button", { onclick: () => { m.hidden = true; api("open_external", { path: active.path, app: "navisworks" }); } }, "Navisworks Freedom", el("span", { class: "hint" }, tr("app.esterno"))));
  if (!WEB && TOOLS.trueview && ["dwg", "dxf", "dwf"].includes(ext)) m.append(el("button", { onclick: () => { m.hidden = true; api("open_external", { path: active.path, app: "trueview" }); } }, "DWG TrueView", el("span", { class: "hint" }, tr("app.esterno"))));
  placeMenu(m, anchor);
}

// visualizzatori che sanno davvero leggere il file aperto (per tipo e contenuto), nell'ordine in cui conviene proporli
const TEXT_LIKE = new Set(["ifc", "step", "stp", "iges", "igs", "dxf", "obj", "gltf", "dae", "x3d", "wrl", "vrml", "ply", "stl", "svg", "csv", "tsv", "eml", "html", "htm",
  "xml", "json", "md", "markdown", "txt", "log", "ini", "cfg", "yaml", "yml", "rtf", "fodt", "fods", "fodp", "kml", "gpx", "geojson", "sql"]);
const ZIP_BASED = new Set(["docx", "docm", "dotx", "xlsx", "xlsm", "xltx", "pptx", "pptm", "potx", "ppsx", "odt", "ott", "ods", "odp", "otp", "epub", "3mf", "kmz", "jar", "apk", "vsdx", "vsdm", "vstx", "vstm", "xps", "oxps", "idml", "sketch", "ifczip"]);
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
// nome e descrizioni di una categoria del registro nella lingua scelta (chiavi fmt.<id>.name/view/edit; nella web app
// fmt.<id>.webview se esiste, perche' tools/build_web.py cambia alcune descrizioni); se manca la chiave, il testo di formats.json
function catText(c, field) {
  if (WEB && field === "view" && trHas(`fmt.${c.id}.webview`)) return tr(`fmt.${c.id}.webview`);
  const k = `fmt.${c.id}.${field}`;
  return trHas(k) ? tr(k) : c[field];
}

function renderFormats() {
  const outer = $("formats");
  outer.innerHTML = "";
  const box = el("div", { class: "wrap" });
  outer.append(box);
  const all = new Set(REG.categories.flatMap(c => c.exts));
  const search = el("input", { class: "search", type: "search", id: "fmt-search", placeholder: tr("app.cerca_estensione_es_dwg_p7m") });
  const answer = el("div", { class: "answer", id: "fmt-answer" });
  const list = el("div");
  box.append(
    el("h1", {}, WEB ? tr("app.formati_supportati_web_app") : tr("app.formati_supportati_mb_visual")),
    ...(WEB ? [el("p", { class: "lead" }, tr("app.versione_pc_apre_piu_formati"))] : []),
    el("p", { class: "lead" }, tr("app.0_estensioni_1_categorie_si", all.size, REG.categories.length) +
      tr("app.questo_elenco_generato_dallo_stesso") +
      tr("app.file_si_apre_solo_come")),
    search, answer, list);
  const draw = () => {
    const q = search.value.trim().toLowerCase().replace(/^\*?\./, "");
    list.innerHTML = "";
    answer.textContent = "";
    if (q) {
      const hits = EXT.get(q);
      if (hits) {
        answer.innerHTML = "";
        answer.append(el("span", { class: "chip ok" }, tr("common.si")), " ." + q + tr("app.si_apre_come") + hits.map(c => catText(c, "name")).join(tr("app.oppure")));
        const req = hits.find(c => c.requires && !TOOLS[c.requires]);
        if (req) answer.append(el("div", { class: "err", style: { fontWeight: 400 } }, tr("app.attenzione_richiede_0_non_presente", REG.requirements[req.requires].name)));
      } else {
        answer.innerHTML = "";
        answer.append(el("span", { class: "chip bad" }, tr("common.no")), tr("app.0_non_nell_elenco_si", q));
      }
    }
    for (const c of REG.categories) {
      const exts = q ? c.exts.filter(e => e.includes(q)) : c.exts;
      if (q && !exts.length && !catText(c, "name").toLowerCase().includes(q)) continue;
      const req = c.requires ? REG.requirements[c.requires] : null;
      const status = req ? (TOOLS[c.requires] ? el("span", { class: "chip ok" }, tr("app.0_presente", req.name)) : el("span", { class: "chip warn" }, tr("app.richiede_0_gratuito", req.name))) : null;
      list.append(el("section", { class: "fcat" },
        el("header", {}, el("h2", {}, catText(c, "name")), el("span", { class: "n" }, tn("app.n_estensioni", c.exts.length)), status),
        el("p", {}, el("b", {}, tr("app.visualizza")), catText(c, "view")),
        el("p", {}, el("b", {}, tr("app.modifica")), catText(c, "edit")),
        el("div", { class: "exts" }, [...new Set(c.exts)].sort().map(e => el("code", { class: q && e === q ? "hit" : "" }, "." + e)))));
    }
    const fb = REG.fallback;
    list.append(el("section", { class: "fcat" }, el("header", {}, el("h2", {}, catText(fb, "name"))),
      el("p", {}, el("b", {}, tr("app.visualizza")), catText(fb, "view")), el("p", {}, el("b", {}, tr("app.modifica")), catText(fb, "edit"))));
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
  if (window.MBV_BACK?.()) return; // schermate a tutto schermo (scanner, realta' aumentata) gestiscono da sole il tasto indietro
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
// ogni editor dichiara i suoi tasti (ui/js/shortcuts.js), con gli stessi del programma originale.
// Le combinazioni arrivano con i nomi inglesi o italiani dei tasti ("Ctrl+Shift+S", "Maiusc+Invio"; piu' combinazioni
// separate da "|", " / " o " oppure ") e si mostrano con i nomi della lingua scelta (keys.* in ui/i18n).
const keyCombos = keys => String(keys).split(/\s*\|\s*|\s+oppure\s+|\s*\/\s*(?=\S)/).filter(Boolean).map(c => c === "+" ? c : c.split(/\+(?!$)/).map(keyName).join("+"));
const keysText = keys => keyCombos(keys).join(" / ");
function showShortcuts() {
  const sc = active?.shortcuts;
  const table = rows => {
    const t = el("table", { class: "kv-table", style: { borderCollapse: "collapse", width: "100%", fontSize: "12.5px" } });
    let group = null;
    for (const r of rows) {
      if (r.group && r.group !== group) { group = r.group; t.append(el("tr", {}, el("td", { colspan: 2, style: { padding: "10px 0 4px", fontWeight: 600 } }, group))); }
      t.append(el("tr", {}, el("td", { style: { padding: "3px 14px 3px 0", whiteSpace: "nowrap" } }, ...keyCombos(r.keys).flatMap((k, i) => [i ? " / " : "", el("kbd", { style: { fontFamily: "Consolas, monospace", border: "1px solid var(--line-strong)", borderBottomWidth: "2px", borderRadius: "4px", padding: "0 5px", background: "var(--panel)" } }, k)])),
        el("td", { style: { padding: "3px 0", color: "var(--fg)" } }, r.desc)));
    }
    return t;
  };
  const box = el("div", { style: { maxHeight: "65vh", overflow: "auto", minWidth: "min(560px, 80vw)" } });
  if (sc?.list?.length) box.append(el("p", { class: "note", style: { margin: "0 0 4px" } }, tr("app.tasti_come_0_1", sc.program, active ? " · " + active.name : "")), table(sc.list));
  else box.append(el("p", { class: "note" }, active ? tr("app.questo_visualizzatore_non_ha_scorciatoie") : tr("app.apri_file_vedere_scorciatoie_suo")));
  box.append(el("hr", { style: { border: 0, borderTop: "1px solid var(--line)", margin: "12px 0 0" } }), table([
    { group: "MB Visual", keys: "Ctrl+O", desc: tr("app.apri_file_2") }, { group: "MB Visual", keys: "Ctrl+N", desc: tr("app.crea_nuovo_2") },
    { group: "MB Visual", keys: "Ctrl+S", desc: tr("common.salva") }, { group: "MB Visual", keys: "Ctrl+Shift+S", desc: tr("app.salva_nome_anche_altri_formati") },
    { group: "MB Visual", keys: "Ctrl+P", desc: tr("app.stampa_desc") }, { group: "MB Visual", keys: "Ctrl+Shift+P", desc: tr("app.stampa_lotti_desc") },
    { group: "MB Visual", keys: "Ctrl+W", desc: tr("app.chiudi_file") }, { group: "MB Visual", keys: "Ctrl+Shift+F", desc: tr("search.scorciatoia") }, { group: "MB Visual", keys: "Ctrl+Tab", desc: tr("app.file_successivo") }, { group: "MB Visual", keys: "F1", desc: tr("app.questo_elenco") },
  ]));
  modal(tr("app.scorciatoie_tastiera"), box);
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
    ["doc.pdf", tr("app.documenti"), "PDF, Word, Excel, PowerPoint"],
    ["firma.p7m", tr("app.firme_digitali"), tr("app.p7m_p7s_pdf_firmati")],
    ["pianta.dwg", tr("app.disegni_cad_2d"), tr("app.dwg_dxf_layer_quote_misure")],
    ["modello.step", tr("app.modelli_cad_3d"), tr("app.step_iges_brep_albero_parti")],
    ["edificio.ifc", tr("app.bim_3d"), "IFC, STL, OBJ, GLB, FBX"],
    ["foto.jpg", tr("app.immagini"), tr("app.jpg_png_webp_tiff_heic")],
    ["video.mp4", tr("app.audio_video_2"), tr("app.mp4_mov_webm_mp3_altri")],
    ["archivio.zip", tr("app.archivi_ed_email"), "ZIP, RAR, 7Z, TAR, ISO, EML"],
    ["codice.py", tr("app.testo_codice_dati"), tr("app.editor_professionale_sqlite_esadecimale")],
  ] : [
    ["doc.pdf", tr("app.documenti"), "PDF, Word, Excel, PowerPoint, OpenDocument"],
    ["firma.p7m", tr("app.firme_digitali"), tr("app.p7m_p7s_pdf_firmati")],
    ["pianta.dwg", tr("app.disegni_cad_2d"), tr("app.dwg_dxf_layer_quote_misure")],
    ["modello.step", tr("app.modelli_cad_3d"), tr("app.step_iges_brep_albero_parti")],
    ["edificio.ifc", tr("app.bim_3d"), "IFC, Navisworks, STL, OBJ, GLB, FBX"],
    ["foto.cr2", tr("app.immagini"), tr("app.jpg_png_psd_raw")],
    ["video.mp4", tr("app.audio_video_2"), tr("app.qualsiasi_formato_taglio_conversione")],
    ["archivio.zip", tr("app.archivi_ed_email"), "ZIP, RAR, 7Z, ISO, EML, MSG"],
    ["codice.py", tr("app.testo_codice_dati"), tr("app.editor_professionale_sqlite_esadecimale")],
  ];
  if (WEB) {
    document.documentElement.classList.add("web");
    $("drop").querySelector("h1").textContent = tr("app.apri_i_file_visualizzare");
    $("drop").querySelector("p").textContent = tr("app.i_file_restano_tuo_dispositivo");
  }
  for (const [f, t, d] of CAPS) caps.append(el("div", { class: "cap" }, badgeFor(f), el("b", {}, t), el("span", { class: "d" }, d)));
  const total = new Set(REG.categories.flatMap(c => c.exts)).size;
  $("home-formats").textContent = tr("app.0_estensioni_supportate_vedi_l", total);
  $("home-formats").addEventListener("click", toggleFormats);
  setupDrop();
  setupTheme();
  setupBack();
  if (!WEB) import("./cloud.js").then(m => m.setupCloud()).catch(e => console.error(e)); // archivi cloud (SharePoint, Drive, Dropbox, Autodesk)
  if (!WEB) licenseGate(); // licenza dell'app per PC: senza attivazione copre l'app con la schermata della chiave
  if (!WEB) setTimeout(() => checkUpdates(false), 3000);
  setInterval(() => { if (!document.hidden) checkExternalChange(active); }, 2000);
  window.addEventListener("focus", () => tabs.forEach(checkExternalChange));
  $("btn-open").addEventListener("click", e => openMenu(e.currentTarget));
  $("home-open").addEventListener("click", doOpen);
  $("home-new").addEventListener("click", doNew);
  if (WEB) $("home-new").after(el("button", { class: "btn", id: "home-scan", html: ICON_SCAN + tr("scanner.home"), onclick: doScan }));
  $("home-folder").addEventListener("click", chooseExplorerFolder);
  $("btn-explorer").addEventListener("click", toggleExplorer);
  $("btn-info").addEventListener("click", showProperties);
  $("ex-pick").addEventListener("click", chooseExplorerFolder);
  $("ex-up").addEventListener("click", () => exDir && dirName(exDir) && loadDir(dirName(exDir)));
  $("ex-filter").addEventListener("input", renderDir);
  $("ex-search").addEventListener("click", () => import("./search.js").then(m => m.toggle(true)));
  // clic destro nel pannello Esplora: conversione a lotti della cartella (o a partire dal file)
  $("ex-list").addEventListener("contextmenu", e => {
    if (WEB || !exDir) return;
    e.preventDefault();
    const b = e.target.closest(".ex-item");
    import("./batch.js").then(m => m.explorerMenu(e, b ? b.dataset.path : exDir, b ? b.classList.contains("dir") : true, p => openPaths([p])));
  });
  $("btn-file").addEventListener("click", e => fileMenu(e.currentTarget));
  $("btn-as").addEventListener("click", e => openAsMenu(e.currentTarget));
  $("btn-folder").addEventListener("click", () => active && api("reveal", { path: active.path }));
  $("btn-external").addEventListener("click", () => active && api("open_external", { path: active.path }).catch(e => toast(e.message, true)));
  $("btn-formats").addEventListener("click", toggleFormats);
  document.addEventListener("click", e => { if (!e.target.closest(".menu-wrap")) closeMenus(); });
  document.addEventListener("keydown", e => {
    const k = e.key.toLowerCase();
    if (e.ctrlKey && e.shiftKey && k === "f" && !WEB) { e.preventDefault(); import("./search.js").then(m => m.toggle()); } // ricerca nel progetto
    else if (e.ctrlKey && k === "o") { e.preventDefault(); doOpen(); }
    else if (e.ctrlKey && k === "n") { e.preventDefault(); doNew(); }
    else if (e.ctrlKey && k === "s") { e.preventDefault(); save(e.shiftKey); }
    else if (e.ctrlKey && k === "p" && !WEB) { e.preventDefault(); doPrint(e.shiftKey); }
    else if (e.ctrlKey && k === "w") { e.preventDefault(); if (active) closeTab(active); }
    else if (e.ctrlKey && k === "tab" && tabs.length) { e.preventDefault(); activate(tabs[(tabs.indexOf(active) + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length]); }
    else if (e.key === "F1") { e.preventDefault(); showShortcuts(); }
  });
  window.addEventListener("beforeunload", e => { if (tabs.some(t => t.dirty)) { e.preventDefault(); e.returnValue = ""; } });
  renderTabs();
}

window.MB = { openPaths, openFile, resolveCategory, get tabs() { return tabs; }, get active() { return active; }, get exDir() { return exDir; }, activate, modal, askQuit, print: doPrint };
const READY = boot();
