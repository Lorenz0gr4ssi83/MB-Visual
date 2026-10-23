// Ricerca nel contenuto di tutti i file della cartella di progetto (Ctrl+Maiusc+F, pulsante "Cerca" di Esplora).
// Il motore e l'indice sono in mbvisual/search.py; qui il pannello, la lettura dei DWG (worker libredwg) e l'apertura
// del file al punto trovato (pagina del PDF, riga del testo, elemento IFC, entita' del disegno).
import { api, el, fmtSize, loadCss, pickFolder, readBytes, toast } from "./core.js";
import { badgeFor } from "./app.js";
import { fmtDate, fmtNum, LOCALE, t as tr } from "./i18n.js";

const $ = id => document.getElementById(id);
const KINDS = ["", "pdf", "word", "excel", "powerpoint", "email", "cad", "bim", "immagine", "testo", "archivio", "altro"]; // chiavi search.tipo_*
const DATES = [["", "qualsiasi"], ["1", "24h"], ["7", "7g"], ["30", "30g"], ["365", "12m"], ["custom", "intervallo"]]; // chiavi search.data_*
const STORE = "mbv-srchdir";

let P = null;              // elementi del pannello
let root = null;           // cartella cercata
let timer = null, statusTimer = null, seq = 0;
let dwgBusy = false;

function store(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* */ } }
function load(k) { try { return localStorage.getItem(k); } catch { return null; } }

export function toggle(force) {
  build();
  const show = force ?? P.box.hidden;
  if (show && P.box.hidden) window.MBStat?.track("fn", "ricerca_progetto"); // statistiche anonime (solo con consenso)
  P.box.hidden = !show;
  $("btn-explorer")?.classList.toggle("srch-on", show);
  window.dispatchEvent(new Event("resize"));
  if (!show) return;
  const want = window.MB?.exDir || load(STORE);
  if (!root && want) setRoot(want);
  else if (!root) chooseRoot();
  else refreshStatus(true);
  setTimeout(() => P.q.focus(), 0);
}
export function isOpen() { return !!P && !P.box.hidden; }

async function chooseRoot() {
  const d = await pickFolder();
  if (d) setRoot(d);
}

async function setRoot(d) {
  root = d;
  store(STORE, d);
  P.root.textContent = d;
  P.root.title = d;
  P.list.innerHTML = "";
  P.folder.innerHTML = "";
  P.folder.append(el("option", { value: "" }, tr("search.tutta_cartella")));
  try { await api("search_update", { path: d }); } catch (e) { return toast(tr("search.non_disponibile", e.message), true); }
  refreshStatus(true);
  loadFolders();
  if (P.q.value.trim()) run();
}

async function loadFolders() {
  try {
    const r = await api("search_folders", { path: root });
    const cur = P.folder.value;
    P.folder.innerHTML = "";
    P.folder.append(el("option", { value: "" }, tr("search.tutta_cartella")));
    for (const f of r.folders) P.folder.append(el("option", { value: f, selected: f === cur }, (f.includes("/") ? "    " : "") + f.split("/").pop()));
  } catch { /* */ }
}

// ---------------------------------------------------------------- pannello
function build() {
  if (P) return;
  loadCss("css/search.css");
  const q = el("input", { type: "search", class: "srch-q", id: "srch-q", placeholder: tr("search.segnaposto"), autocomplete: "off", spellcheck: "false" });
  const kind = el("select", { class: "field", id: "srch-kind", title: tr("search.tipo_file") }, KINDS.map(v => el("option", { value: v }, tr("search.tipo_" + (v || "tutti")))));
  const date = el("select", { class: "field", id: "srch-date", title: tr("search.data_modifica") }, DATES.map(([v, k]) => el("option", { value: v }, tr("search.data_" + k))));
  const folder = el("select", { class: "field", id: "srch-folder", title: tr("search.solo_sottocartella") }, el("option", { value: "" }, tr("search.tutta_cartella")));
  const dfrom = el("input", { type: "date", class: "field", id: "srch-from", title: tr("search.modificati_dal") });
  const dto = el("input", { type: "date", class: "field", id: "srch-to", title: tr("search.modificati_al") });
  const range = el("div", { class: "srch-range", hidden: true }, el("span", {}, tr("search.dal")), dfrom, el("span", {}, tr("search.al")), dto);
  const bar = el("div", { class: "srch-bar" }, el("i"));
  const stText = el("div", { class: "srch-st-text" }, "");
  const stLinks = el("div", { class: "srch-st-links" });
  const list = el("div", { class: "srch-list", id: "srch-list" });
  const count = el("div", { class: "srch-count" });
  const rootEl = el("div", { class: "ex-path srch-root" }, tr("search.nessuna_cartella"));
  const foot = el("div", { class: "srch-foot" });
  const box = el("aside", { class: "srch", id: "srch-panel", hidden: true },
    el("div", { class: "ex-head" }, el("span", { class: "label" }, tr("search.titolo")),
      el("button", { class: "mini", title: tr("search.scegli_cartella"), onclick: chooseRoot }, tr("search.cartella")),
      el("button", { class: "mini", title: tr("search.chiudi_titolo"), onclick: () => toggle(false) }, tr("common.chiudi"))),
    rootEl,
    el("div", { class: "srch-in" }, q),
    el("div", { class: "srch-help" }, ...["sint_frase", "sint_prefisso", "sint_parole", "sint_or", "sint_escludi"].map(k => el("code", { title: tr("search." + k + "_titolo") }, tr("search." + k)))),
    el("div", { class: "srch-filters" }, kind, date, folder), range,
    el("div", { class: "srch-st" }, bar, stText, stLinks),
    count, list, foot);
  const ws = $("workspace");
  ws.insertBefore(box, ws.querySelector(".main"));
  P = { box, q, kind, date, folder, dfrom, dto, range, bar, stText, stLinks, list, count, root: rootEl, foot };
  const later = () => { clearTimeout(timer); timer = setTimeout(run, 220); };
  q.addEventListener("input", later);
  q.addEventListener("keydown", e => {
    if (e.key === "Enter") { clearTimeout(timer); run(); }
    else if (e.key === "Escape") { if (q.value) { q.value = ""; run(); } else toggle(false); }
    else if (e.key === "ArrowDown") { e.preventDefault(); list.querySelector(".srch-hit, .srch-file")?.focus(); }
  });
  list.addEventListener("keydown", e => {
    const items = [...list.querySelectorAll(".srch-hit, .srch-file")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" && i >= 0) { e.preventDefault(); items[i + 1]?.focus(); }
    else if (e.key === "ArrowUp" && i >= 0) { e.preventDefault(); (items[i - 1] || q).focus(); }
  });
  for (const s of [kind, folder, dfrom, dto]) s.addEventListener("change", run);
  date.addEventListener("change", () => { range.hidden = date.value !== "custom"; run(); });
}

function dateRange() {
  const v = P.date.value;
  if (!v) return {};
  if (v === "custom") {
    const f = P.dfrom.value ? new Date(P.dfrom.value + "T00:00:00").getTime() / 1000 : null;
    const t = P.dto.value ? new Date(P.dto.value + "T00:00:00").getTime() / 1000 + 86400 : null;
    return { from: f, to: t };
  }
  return { from: Date.now() / 1000 - +v * 86400 };
}

async function run() {
  if (!root) return;
  const my = ++seq;
  const q = P.q.value.trim();
  const body = { q, kind: P.kind.value, sub: P.folder.value, ...dateRange() };
  if (!q && !body.kind && !body.sub && !body.from && !body.to) { P.list.innerHTML = ""; P.count.textContent = ""; return; }
  let r;
  try { r = await api("search_query", { path: root }, { json: body }); } catch (e) {
    if (my !== seq) return;
    P.count.textContent = e.message;
    P.list.innerHTML = "";
    return;
  }
  if (my !== seq) return;
  render(r, q);
}

function snippet(s) {
  // il motore segna le parole trovate con \x02 ... \x03: testo sicuro + <mark>
  const frag = document.createDocumentFragment();
  const parts = String(s || "").replace(/\s+/g, " ").split(/([\x02\x03])/);
  let on = false;
  for (const p of parts) {
    if (p === "\x02") { on = true; continue; }
    if (p === "\x03") { on = false; continue; }
    if (p) frag.append(on ? el("mark", {}, p) : document.createTextNode(p));
  }
  return frag;
}

const STATE_NOTE = { nuvola: "stato_nuvola", dwg: "stato_dwg", errore: "stato_errore", nome: "stato_nome" }; // chiavi search.*

function render(r, q) {
  P.list.innerHTML = "";
  const n = r.totale;
  P.count.textContent = !n ? tr(q ? "search.nessun_file" : "search.nessun_file_filtri")
    : tr("search.conteggio", fmtNum(n)) + (n > r.files.length ? " " + tr("search.mostrati", r.files.length) : "") + ` · ${r.ms} ms`;
  for (const f of r.files) {
    const dir = f.rel.includes("/") ? f.rel.slice(0, f.rel.lastIndexOf("/")) : "";
    const head = el("button", { class: "srch-file", title: f.path, onclick: () => openHit(f, null) },
      badgeFor(f.name),
      el("span", { class: "nm" }, f.name),
      el("span", { class: "dt" }, fmtDate(new Date(f.mtime * 1000))),
      el("span", { class: "dir" }, dir || tr("search.cartella_principale"), f.state !== "ok" && STATE_NOTE[f.state] ? el("span", { class: "chip " + (f.state === "errore" ? "bad" : "warn") }, tr("search." + STATE_NOTE[f.state])) : null));
    const box = el("div", { class: "srch-res" }, head);
    for (const h of f.hits) {
      box.append(el("button", { class: "srch-hit", onclick: () => openHit(f, h) },
        el("span", { class: "lb" }, h.label || ""), el("span", { class: "sn" }, snippet(h.snippet))));
    }
    if (f.n > f.hits.length) box.append(el("div", { class: "srch-more" }, tr("search.altri_punti", f.n - f.hits.length)));
    if (f.note) box.append(el("div", { class: "srch-note" }, f.note));
    P.list.append(box);
  }
}

// ---------------------------------------------------------------- stato dell'indice
async function refreshStatus(loop = false) {
  clearTimeout(statusTimer);
  if (!root || !P || P.box.hidden) return;
  let s;
  try { s = await api("search_status", { path: root }); } catch { return; }
  const busy = s.fase === "scansione" || s.fase === "indicizzazione";
  const st = s.stati || {};
  P.bar.hidden = !busy;
  if (s.fase === "scansione") P.bar.firstChild.style.width = "8%";
  else if (busy) P.bar.firstChild.style.width = Math.max(3, Math.round((100 * s.fatti) / Math.max(1, s.da_fare))) + "%";
  P.stText.textContent = s.fase === "scansione" ? tr("search.st_scansione", fmtNum(s.trovati || 0))
    : busy ? tr("search.st_indicizzazione", fmtNum(s.fatti), fmtNum(s.da_fare)) + ` · ${s.corrente || ""}`
      : s.fase === "errore" ? tr("search.st_errore", s.errore)
        : tr("search.st_pronto", fmtNum(s.file || 0)) + (s.ultimo ? " · " + tr("search.st_aggiornato", new Date(s.ultimo * 1000).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" })) : "");
  P.stText.title = s.corrente || "";
  P.stLinks.innerHTML = "";
  if (st.nuvola) P.stLinks.append(el("button", { class: "link", title: tr("search.nuvola_titolo"), onclick: () => listState("nuvola", tr("search.nuvola_elenco")) }, "☁ " + tr("search.nuvola_link", st.nuvola)));
  if (st.dwg) P.stLinks.append(el("span", { class: "srch-chip" }, tr("search.dwg_in_lettura", st.dwg)));
  if (st.errore) P.stLinks.append(el("button", { class: "link", onclick: () => listState("errore", tr("search.errori_elenco")) }, tr("search.errori_link", st.errore)));
  P.foot.innerHTML = "";
  P.foot.append(
    el("span", {}, s.dimensione ? tr("search.dimensione_indice", fmtSize(s.dimensione)) : ""),
    el("span", { class: "grow" }),
    el("button", { class: "mini", title: tr("search.aggiorna_titolo"), onclick: async () => { await api("search_update", { path: root }); refreshStatus(true); } }, tr("search.aggiorna")),
    el("button", { class: "mini", title: tr("search.ricostruisci_titolo"), onclick: rebuild }, tr("search.ricostruisci")));
  if (st.dwg && !dwgBusy) readDwgs();
  if (!busy && P._wasBusy) { loadFolders(); if (P.q.value.trim()) run(); }
  if (busy && P.q.value.trim() && Date.now() - (P._lastRun || 0) > 4000) { P._lastRun = Date.now(); run(); } // risultati che crescono mentre l'indice si riempie
  P._wasBusy = busy || !!st.dwg;
  if (loop) statusTimer = setTimeout(() => refreshStatus(true), busy || st.dwg ? 800 : 10000);
}

async function rebuild() {
  try { await api("search_rebuild", { path: root }); toast(tr("search.ricostruzione_avviata")); } catch (e) { return toast(e.message, true); }
  P.list.innerHTML = "";
  refreshStatus(true);
}

async function listState(state, title) {
  const r = await api("search_files", { path: root, state });
  const box = el("div", { class: "srch-statelist" });
  for (const f of r.items) box.append(el("button", { class: "ex-item", title: f.note || "", onclick: () => window.MB.openFile(f.path) }, badgeFor(f.rel), el("span", { class: "nm" }, f.rel), el("span", { class: "sz" }, fmtSize(f.size))));
  if (!r.items.length) box.append(el("p", { class: "note" }, tr("search.nessun_file_elenco")));
  const note = tr(state === "nuvola" ? "search.nuvola_spiegazione" : "search.errori_spiegazione");
  window.MB.modal(title, el("div", { style: { display: "grid", gap: "10px", maxWidth: "640px" } }, el("p", { class: "note", style: { margin: 0 } }, note), box));
}

// ---------------------------------------------------------------- DWG: testo letto con libredwg in un worker
async function readDwgs() {
  dwgBusy = true;
  try {
    for (;;) {
      if (!root) break;
      const r = await api("search_dwg_pending", { path: root });
      if (!r.items.length) break;
      for (const it of r.items) {
        let res;
        try {
          const bytes = await readBytes(it.path);
          res = await dwgText(bytes);
        } catch (e) { res = { error: e.message || String(e) }; }
        await api("search_dwg_put", { path: root }, { json: { path: it.path, size: it.size, mtime: it.mtime, ...res, errore: res.error } }).catch(() => {});
      }
    }
  } finally { dwgBusy = false; }
}

function dwgText(bytes) {
  return new Promise(resolve => {
    const w = new Worker(new URL("./searchdwg.worker.js", import.meta.url), { type: "module" });
    const done = r => { clearTimeout(t); w.terminate(); resolve(r); };
    const t = setTimeout(() => done({ error: tr("search.dwg_troppo_lungo") }), 120000);
    w.onmessage = e => done(e.data);
    w.onerror = e => done({ error: e.message || tr("search.dwg_errore") });
    w.postMessage({ bytes: bytes.buffer }, [bytes.buffer]);
  });
}

// ---------------------------------------------------------------- apertura al punto trovato
async function openHit(f, h) {
  const loc = h?.loc || {};
  if (f.state === "nuvola") toast(tr("search.apertura_nuvola"), false, 3000);
  await window.MB.openFile(f.path);
  const tab = window.MB.tabs.find(t => t.path === f.path);
  if (!tab || !h) return;
  const term = h.term || (P.q.value.match(/"([^"]+)"/)?.[1]) || P.q.value.replace(/[*"]/g, "").split(/\s+/).find(w => w && !w.startsWith("-") && w !== "OR") || "";
  try { if (await goTo(tab, loc, term)) return; } catch (e) { console.warn("ricerca: posizione non raggiunta", e); }
  const where = h.label && !loc.meta ? h.label : "";
  if (where) toast(tr("search.trovato_in", where) + (term ? " · " + tr("search.cerca_con_ctrl_f", term) : ""), false, 6000);
  if (term) navigator.clipboard?.writeText(term).catch(() => {});
}

const wait = async (fn, ms = 30000) => {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise(r => setTimeout(r, 150));
  }
};

async function goTo(tab, loc, term) {
  if (loc.attach) return false; // allegato di un'email: si apre l'email, l'allegato e' nell'elenco
  const v = tab.viewer;
  if (v === "pdf" || v === "signed") {
    const frame = await wait(() => tab.view.querySelector("iframe"));
    const app = await wait(() => { const a = frame.contentWindow?.PDFViewerApplication; return a?.pdfDocument && a.pdfViewer?.pagesCount ? a : null; });
    if (!app) return false;
    if (loc.page) app.page = loc.page;
    if (term) {
      app.eventBus.dispatch("find", { source: null, type: "", query: term, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: false, matchDiacritics: false });
    }
    return !!loc.page;
  }
  const ed = await wait(() => tab.api?.editor, 15000);
  if (ed && ed.getModel) {
    const model = ed.getModel();
    let line = loc.line || 1;
    let range = null;
    if (term) {
      const ms = model.findMatches(term, false, false, false, null, false);
      if (ms.length) {
        range = ms.reduce((a, b) => (Math.abs(b.range.startLineNumber - line) < Math.abs(a.range.startLineNumber - line) ? b : a)).range;
        line = range.startLineNumber;
      }
    }
    ed.revealLineInCenter(line);
    if (range) ed.setSelection(range); else ed.setPosition({ lineNumber: line, column: 1 });
    ed.focus();
    return !!(loc.line || range);
  }
  if (v === "model3d" && loc.ifc) {
    const ok = await wait(() => tab.api?.selectExpressId, 60000);
    return ok ? tab.api.selectExpressId(+loc.ifc) : false;
  }
  if (v === "cad2d" && (loc.handle || loc.block)) {
    const cad = await wait(() => tab.view.querySelector(".body")?.__cad, 60000);
    if (!cad) return false;
    const ents = cad.db.entities || [];
    const H = String(loc.handle || "").toUpperCase();
    let i = loc.block ? -1 : ents.findIndex(e => String(e.handle ?? "").toUpperCase() === H || (e.attribs || []).some(a => String(a.handle ?? "").toUpperCase() === H));
    if (i < 0 && loc.block) i = ents.findIndex(e => e.type === "INSERT" && e.name === loc.block);
    const its = i >= 0 ? cad.model.ents[i] : null;
    if (!its?.length) return false;
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    const add = (x, y) => { if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (x > bb[2]) bb[2] = x; if (y > bb[3]) bb[3] = y; };
    for (const k of its) {
      const it = cad.model.items[k];
      if (it.bb) { add(it.bb[0], it.bb[1]); add(it.bb[2], it.bb[3]); continue; }
      if (it.pts) for (const [x, y] of it.pts) add(x, y);
      if (it.x1 !== undefined) { add(it.x1, it.y1); add(it.x2, it.y2); }
      if (it.cx !== undefined && it.r !== undefined) { add(it.cx - it.r, it.cy - it.r); add(it.cx + it.r, it.cy + it.r); }
      if (it.x !== undefined && it.y !== undefined) add(it.x, it.y);
    }
    if (!isFinite(bb[0])) return false;
    // un po' di contesto attorno all'oggetto: almeno 1/40 del disegno
    const m = cad.model.bbox, span = Math.max(m[2] - m[0], m[3] - m[1]) / 40;
    const w = Math.max(bb[2] - bb[0], span), h = Math.max(bb[3] - bb[1], span);
    const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
    const box = [cx - w * 1.2, cy - h * 1.2, cx + w * 1.2, cy + h * 1.2];
    cad.zoom(box);
    setTimeout(() => cad.zoom(box), 500); // dopo l'adattamento iniziale del visualizzatore appena aperto
    return true;
  }
  return false;
}

