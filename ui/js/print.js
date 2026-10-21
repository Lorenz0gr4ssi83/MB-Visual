// Stampa professionale (solo app per PC): finestra Stampa (Ctrl+P) per il file aperto e Stampa a lotti di piu' tavole.
// Il motore e' mbvisual/stampa.py: sorgenti -> PDF di stampa (pagine gia' alla dimensione del foglio) -> anteprima con lo
// stesso stile della stampa -> stampante di Windows (GDI) oppure PDF vettoriale. I DWG si leggono qui con libredwg
// (come nel visualizzatore) e passano al motore come DXF; i disegni aperti passano con le modifiche e i layer spenti.
import { api, baseName, dirName, el, extOf, loadCss, pickFiles, pickFolder, pickSavePath, toast, waitJob } from "./core.js";

const SCALES = ["1:1", "1:2", "1:5", "1:10", "1:20", "1:25", "1:50", "1:75", "1:100", "1:200", "1:250", "1:500", "1:1000", "1:2000", "1:5000", "2:1", "5:1", "10:1"];
const UNITS = { 1: "pollici", 2: "piedi", 4: "millimetri", 5: "centimetri", 6: "metri", 14: "decimetri" };
const CAD_EXT = new Set(["dwg", "dxf"]);
const BATCH_TYPES = { cad: ["dwg", "dxf"], pdf: ["pdf"], doc: ["docx", "doc", "xlsx", "xls", "pptx", "ppt", "odt", "ods", "odp", "rtf", "txt"], img: ["png", "jpg", "jpeg", "tif", "tiff", "bmp", "svg"] };
const PLAIN = new Set(["model3d"]); // visualizzatori che si stampano come immagine di cio' che si vede
const KEY = "mbv-stampa";
const SVG = {
  print: '<svg viewBox="0 0 24 24"><path d="M7 9V3h10v6M7 17H4v-8h16v8h-3M7 14h10v7H7z"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

function loadPrefs() { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } }
function savePrefs(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* */ } }
const plain = (k, v) => (typeof v === "bigint" ? Number(v) : k === "xdata" ? undefined : v);

// ---------------------------------------------------------------- sorgenti
// scheda aperta -> sorgente per il motore ({path, name, kind?, dxf?, view?, limits?})
async function tabSource(t, info) {
  const a = t.api || {};
  const ext = extOf(t.name);
  if (a.printSource) {
    const r = await a.printSource();
    if (r.edits) { // disegno: modifiche e layer come nel visualizzatore -> DXF temporaneo
      info.cad = r;
      const { path } = await api("temp_path", { name: t.name.replace(/\.[^.]+$/, "") + ".dxf" });
      await api("cad_save", { path: t.path }, { json: { out: path, edits: r.edits } });
      return { path: t.path, name: t.name, kind: "cad", dxf: path, view: r.view, limits: r.limits };
    }
    if (r.kind === "dxf" || r.kind === "dwg") { info.cad = r; return { path: t.path, name: t.name, kind: "cad", view: r.view, limits: r.limits }; }
    return r;
  }
  if (t.viewer === "publisher" && a._pb) { // pubblicazione: il PDF vero dell'editor (mbvisual/publisher.py)
    const { exportPdfFile } = await import("./pubexport.js");
    const { path } = await api("temp_path", { name: t.name.replace(/\.[^.]+$/, "") + ".pdf" });
    await exportPdfFile(a._pb, path);
    return { path, name: t.name };
  }
  if (PLAIN.has(t.viewer)) return snapshot(t);
  if (t.dirty) info.note = "Il file ha modifiche non salvate: si stampa l'ultima versione salvata.";
  if (CAD_EXT.has(ext)) return { path: t.path, name: t.name, kind: "cad" };
  return { path: t.path, name: t.name };
}

// immagine di cio' che si vede (modelli 3D...): il canvas piu' grande della scheda
async function snapshot(t) {
  const cv = [...t.view.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!cv) throw new Error("Questo file non ha un contenuto stampabile");
  const blob = await new Promise(r => cv.toBlob(r, "image/png"));
  const { path } = await api("temp_path", { name: t.name.replace(/\.[^.]+$/, "") + ".png" });
  await api("save", { path }, { body: new Uint8Array(await blob.arrayBuffer()) });
  return { path, name: t.name };
}

// DWG senza ODA File Converter: lettura con libredwg (come il visualizzatore) e DXF temporaneo con ezdxf
async function dwgToDxf(path) {
  const { normalize } = await import("./viewers/cad2d.js");
  const m = await import("/vendor/libredwg/dist/libredwg-web.js");
  const bytes = new Uint8Array(await (await fetch("/api/file?path=" + encodeURIComponent(path), { credentials: "same-origin" })).arrayBuffer());
  let lib = await m.LibreDwg.create("/vendor/libredwg/wasm");
  const data = lib.dwg_read_data(bytes.buffer, m.Dwg_File_Type.DWG);
  if (data === undefined || data === null) throw new Error("DWG non leggibile (versione non supportata o file danneggiato)");
  const db = lib.convert(data);
  try { lib.dwg_free(data); } catch { /* */ }
  lib = null;
  normalize(db, "dwg");
  const ltypes = (db.tables.LTYPE?.entries || []).map(t => ({ name: t.name, pattern: (t.pattern || []).map(p => +p.elementLength || 0), description: t.description || "" }));
  const edits = JSON.parse(JSON.stringify({ source: "dwg", layers: [], ltypes, db: { header: db.header, tables: { LAYER: db.tables.LAYER, DIMSTYLE: db.tables.DIMSTYLE, BLOCK_RECORD: db.tables.BLOCK_RECORD }, entities: db.entities } }, plain));
  const { path: out } = await api("temp_path", { name: baseName(path).replace(/\.[^.]+$/, "") + ".dxf" });
  await api("cad_save", { path }, { json: { out, edits } });
  const H = db.header || {}, pt = v => (v ? (Array.isArray(v) ? v : [v.x, v.y]) : null);
  const lo = pt(H.LIMMIN), hi = pt(H.LIMMAX);
  return { dxf: out, limits: lo && hi && hi[0] > lo[0] && hi[1] > lo[1] ? [...lo, ...hi] : null };
}

// ---------------------------------------------------------------- finestra
export async function openPrint(tab) {
  const info = {};
  let src;
  try { src = await tabSource(tab, info); } catch (e) { return toast("Stampa: " + e.message, true, 6000); }
  return dialog({ title: "Stampa", subtitle: tab.name, sources: [src], cad: info.cad, note: info.note, tab });
}

export async function openBatchPrint() {
  return dialog({ title: "Stampa a lotti", batch: true, sources: [] });
}

async function dialog(o) {
  loadCss("css/print.css");
  const prefs = loadPrefs();
  const isCad = !o.batch && o.sources[0]?.kind === "cad";
  const S = { // impostazioni (quelle che contano per l'impaginazione vanno al motore)
    printer: prefs.printer || "", paper: "", custom: { w: 841, h: 1189 }, orientation: "auto", copies: 1, collate: true, pages: "",
    scale: o.batch ? { mode: "actual", value: 100 } : { mode: "fit", value: 100 }, center: true, margin: prefs.margin ?? 5,
    style: prefs.style || "color", dpi: prefs.dpi || 0, paper_fallback: prefs.paper_fallback || "A3",
    cad: { area: o.batch ? "auto" : "extents", window: null, layout: "*", units: "", ctb: prefs.ctb || "", lw: prefs.lw || "",
      scale: { mode: o.batch ? "auto" : "fit", cad: prefs.cadScale || "1:100" } },
  };
  let P = null;            // informazioni sulla stampante scelta
  let printers = [], oda = false, devmodes = {};
  let sid = null, items = [], comp = null, cur = 0, busy = 0, closed = false;
  const files = o.batch ? [] : null; // stampa a lotti: [{path, name}]

  // ---- struttura
  const side = el("aside", { class: "pr-side" });
  const img = el("img", { alt: "" });
  const marg = el("div", { class: "pr-marg" });
  const paper = el("div", { class: "pr-paper" }, img, marg);
  const busyEl = el("div", { class: "pr-busy", hidden: true }, el("span", { class: "pr-spin" }), el("span", {}, "Aggiornamento anteprima"));
  const stage = el("div", { class: "pr-stage" }, paper, busyEl);
  const pageInfo = el("span", { class: "pr-pinfo" });
  const prevB = iconBtn(SVG.prev, "Pagina precedente", () => show(cur - 1));
  const nextB = iconBtn(SVG.next, "Pagina successiva", () => show(cur + 1));
  const chips = el("div", { class: "pr-chips" });
  const info = el("div", { class: "pr-info" });
  const prev = el("section", { class: "pr-prev" }, stage, el("div", { class: "pr-nav" }, prevB, pageInfo, nextB), chips, info);
  const msg = el("span", { class: "pr-msg" });
  const bar = el("progress", { max: 1, value: 0, hidden: true });
  const printBtn = el("button", { class: "btn primary", onclick: () => doPrint() }, "Stampa");
  const dlg = el("div", { class: "pr-dlg", role: "dialog" },
    el("header", { class: "pr-head" }, el("span", { class: "pr-ico", html: SVG.print }), el("b", {}, o.title), el("span", { class: "pr-sub" }, o.subtitle || ""),
      el("span", { style: { flex: 1 } }), iconBtn(SVG.close, "Chiudi (Esc)", () => close())),
    el("div", { class: "pr-main" }, side, prev),
    el("footer", { class: "pr-foot" }, msg, bar, el("button", { class: "btn", onclick: () => close() }, "Annulla"), printBtn));
  const back = el("div", { class: "pr-back" }, dlg);
  document.body.append(back);
  back.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  back.tabIndex = -1;
  back.focus();
  function close() { closed = true; back.remove(); }
  function iconBtn(svg, title, fn) { const b = el("button", { class: "btn pr-icon", title, onclick: fn }); b.innerHTML = svg; return b; }

  // ---- campi
  const sec = (title, ...kids) => el("div", { class: "pr-sec" }, el("h4", {}, title), ...kids);
  const row = (label, ...ctrl) => el("label", { class: "pr-row" }, el("span", {}, label), ...ctrl);
  const select = (opts, value, fn) => {
    const s = el("select", { onchange: () => fn(s.value) });
    for (const op of opts) {
      if (op.group) { const g = el("optgroup", { label: op.group }); for (const x of op.items) g.append(el("option", { value: x.v }, x.t)); s.append(g); }
      else s.append(el("option", { value: op.v }, op.t));
    }
    s.value = value;
    return s;
  };
  const seg = (opts, value, fn) => {
    const w = el("div", { class: "seg" });
    for (const [v, t] of opts) w.append(el("button", { type: "button", class: v === value ? "on" : "", onclick: e => { [...w.children].forEach(b => b.classList.toggle("on", b === e.currentTarget)); fn(v); } }, t));
    return w;
  };
  const num = (value, fn, attrs = {}) => { const i = el("input", { type: "number", value, ...attrs }); i.addEventListener("change", () => fn(+i.value)); return i; };
  const txt = (value, fn, attrs = {}) => { const i = el("input", { type: "text", value, ...attrs }); i.addEventListener("change", () => fn(i.value)); return i; };
  const check = (label, value, fn) => { const c = el("input", { type: "checkbox", checked: value }); c.addEventListener("change", () => fn(c.checked)); return el("label", { class: "pr-check" }, c, label); };

  // ---- pannello impostazioni (ricostruito quando cambia la stampante o le sorgenti)
  function renderSide() {
    side.innerHTML = "";
    if (o.batch) side.append(filesSection());
    if (o.note) side.append(el("p", { class: "pr-note warn" }, o.note));
    // stampante
    const opts = [{ group: "Stampanti virtuali", items: printers.filter(p => p.virtual || /pdf|xps|onenote/i.test(p.name)).map(p => ({ v: p.name, t: p.label })) },
      { group: "Stampanti e plotter", items: printers.filter(p => !p.virtual && !/pdf|xps|onenote/i.test(p.name)).map(p => ({ v: p.name, t: p.label + (p.default ? " (predefinita)" : "") })) }];
    const props = el("button", { class: "btn", disabled: P?.virtual || undefined, title: "Impostazioni del driver: qualita', rotolo, taglierina, cassetto...", onclick: driverProps }, "Proprieta'...");
    side.append(sec("Stampante", el("div", { class: "pr-line" }, select(opts, S.printer, v => { S.printer = v; S.paper = ""; loadPrinter(); }), props),
      P?.virtual ? el("p", { class: "pr-note" }, "Salva un PDF vettoriale con le dimensioni esatte dei fogli (le linee restano linee: scala misurabile).") : null,
      P?.plotter && P.rolls?.length ? el("p", { class: "pr-note" }, "Plotter: puoi stampare sul rotolo (lunghezza = quella della tavola).") : null));
    if (!P) return;
    // carta
    const fo = f => ({ v: f.name, t: `${f.name}  (${fmtMm(Math.min(f.w, f.h))} x ${fmtMm(Math.max(f.w, f.h))} mm)` });
    const popts = [{ v: "auto", t: "Automatico (dalla dimensione della tavola)" }, { group: "Formati da disegno", items: P.forms.filter(f => f.std).map(fo) }];
    if (P.forms.some(f => !f.std)) popts.push({ group: "Altri formati", items: P.forms.filter(f => !f.std).map(fo) });
    if (P.rolls?.length) popts.push({ group: "Rotolo (lunghezza automatica)", items: P.rolls.map(r => ({ v: "roll:" + r, t: `Rotolo ${r} mm` })) });
    if (P.custom) popts.push({ v: "custom", t: "Formato personalizzato..." });
    const customRow = el("div", { class: "pr-line", hidden: S.paper !== "custom" },
      num(S.custom.w, v => { S.custom.w = v; refresh(); }, { min: 10, step: 1 }), el("span", {}, "x"), num(S.custom.h, v => { S.custom.h = v; refresh(); }, { min: 10, step: 1 }), el("span", {}, "mm"));
    side.append(sec("Carta",
      row("Formato", select(popts, S.paper, v => { S.paper = v; customRow.hidden = v !== "custom"; rememberPaper(); refresh(); })), customRow,
      row("Orientamento", seg([["auto", "Automatico"], ["portrait", "Verticale"], ["landscape", "Orizzontale"]], S.orientation, v => { S.orientation = v; refresh(); })),
      S.paper === "auto" && (isCad || o.batch) ? row("Disegni da adattare su", select(P.forms.filter(f => /^(ISO\s*)?A[0-5]\b/i.test(f.name)).map(f => ({ v: f.name, t: f.name })), S.paper_fallback, v => { S.paper_fallback = v; refresh(); })) : null));
    // pagine e copie
    const multi = !o.batch && items[0]?.kind === "pdf" && items[0].pages > 1;
    side.append(sec("Copie", el("div", { class: "pr-line" }, num(S.copies, v => (S.copies = Math.max(1, v | 0)), { min: 1, max: 999, style: { width: "72px" } }), check("Fascicola", S.collate, v => (S.collate = v))),
      multi ? row("Pagine", txt(S.pages, v => { S.pages = v; refresh(); }, { placeholder: `tutte (1-${items[0].pages}), es. 1-3, 5` })) : null));
    // scala
    const hasCad = items.some(i => i.kind === "cad"), hasDoc = items.some(i => i.kind === "pdf");
    if (hasCad) side.append(cadSection());
    if (hasDoc || !items.length) {
      const pv = num(S.scale.value, v => { S.scale.value = v; refresh(); }, { min: 1, max: 1000, style: { width: "72px" }, disabled: S.scale.mode !== "percent" || undefined });
      side.append(sec(o.batch ? "Scala dei documenti (PDF, Office...)" : "Scala",
        seg([["fit", "Adatta al foglio"], ["actual", "Dimensione reale"], ["percent", "Percentuale"]], S.scale.mode, v => { S.scale.mode = v; pv.disabled = v !== "percent"; refresh(); }),
        el("div", { class: "pr-line" }, pv, el("span", {}, "%"), el("span", { style: { flex: 1 } }), check("Centra", S.center, v => { S.center = v; refresh(); })),
        row("Margine minimo (mm)", num(S.margin, v => { S.margin = Math.max(0, v); refresh(); }, { min: 0, max: 50, style: { width: "72px" } })),
        el("p", { class: "pr-note" }, "Dimensione reale: le tavole PDF escono al 100% sul foglio dello stesso formato (A1 su A1, A3 su A3).")));
    }
    // stile
    side.append(sec("Stile di stampa",
      seg([["color", "Colori"], ["gray", "Scala di grigi"], ["bw", "Bianco e nero"]], S.style, v => { S.style = v; refresh(); }),
      el("p", { class: "pr-note" }, S.style === "bw" ? "Tutto cio' che non e' bianco esce nero (come monochrome.ctb): linee chiare e colorate ben leggibili." : S.style === "gray" ? "Colori convertiti in toni di grigio." : "Colori del documento."),
      row("Qualita'", select([{ v: "0", t: "Automatica (risoluzione della stampante)" }, { v: "150", t: "Bozza (150 dpi)" }, { v: "300", t: "Normale (300 dpi)" }, { v: "600", t: "Alta (600 dpi)" }, { v: "1200", t: "Massima (1200 dpi)" }],
        String(S.dpi), v => (S.dpi = +v)))));
  }

  function cadSection() {
    const cadItems = items.filter(i => i.kind === "cad");
    const one = cadItems.length === 1 ? cadItems[0] : null;
    const sc = S.cad.scale;
    const scaleIn = el("input", { type: "text", value: sc.cad, list: "pr-scales", style: { width: "96px" }, disabled: sc.mode !== "cad" || undefined });
    scaleIn.addEventListener("change", () => { sc.cad = scaleIn.value.trim() || "1:100"; refresh(); });
    const dl = el("datalist", { id: "pr-scales" }, ...SCALES.map(s => el("option", { value: s })));
    const areas = [["extents", "Estensioni"], ["limits", "Limiti"]];
    if (o.cad) areas.push(["view", "Vista attuale"], ["window", "Finestra"]);
    if (cadItems.some(i => i.layouts?.length)) areas.push(["layout", "Layout"]);
    if (o.batch) areas.unshift(["auto", "Layout o estensioni"]);
    const winInfo = el("span", { class: "pr-note" }, S.cad.window ? `${fmtC(S.cad.window[0])}, ${fmtC(S.cad.window[1])} - ${fmtC(S.cad.window[2])}, ${fmtC(S.cad.window[3])}` : "nessuna finestra scelta");
    const winRow = el("div", { class: "pr-line", hidden: S.cad.area !== "window" }, el("button", { class: "btn", onclick: pickWindow }, "Scegli nel disegno..."), winInfo);
    const lays = one?.layouts || [];
    const layRow = lays.length ? row("Layout", select([{ v: "*", t: "Tutti i layout" }, ...lays.map(L => ({ v: L.name, t: `${L.name}${L.w ? `  (${fmtMm(L.w)} x ${fmtMm(L.h)} mm)` : ""}` }))], S.cad.layout, v => { S.cad.layout = v; refresh(); })) : null;
    if (layRow) layRow.hidden = S.cad.area !== "layout";
    const units = one ? UNITS[one.insunits] || `codice ${one.insunits}` : "dal file";
    const ctbOpts = [{ v: "", t: "Nessuna (usa lo stile qui sopra)" }, ...ctbs.map(c => ({ v: c.path, t: c.name }))];
    if (S.cad.ctb && !ctbs.some(c => c.path === S.cad.ctb)) ctbOpts.push({ v: S.cad.ctb, t: baseName(S.cad.ctb) });
    ctbOpts.push({ v: "?", t: "Sfoglia..." });
    return sec(o.batch ? "Disegni CAD (DWG, DXF)" : "Disegno",
      row("Area di stampa", seg(areas, S.cad.area, v => { S.cad.area = v; winRow.hidden = v !== "window"; if (layRow) layRow.hidden = v !== "layout"; if (v === "window" && !S.cad.window) pickWindow(); else refresh(); })),
      winRow, layRow,
      row("Scala", seg([...(o.batch ? [["auto", "Automatica"]] : []), ["fit", "Adatta al foglio"], ["cad", "In scala"]], sc.mode, v => { sc.mode = v; scaleIn.disabled = v !== "cad"; refresh(); }), scaleIn, dl),
      row("Unita' del disegno", select([{ v: "", t: `Automatiche (${units})` }, { v: "mm", t: "Millimetri" }, { v: "cm", t: "Centimetri" }, { v: "m", t: "Metri" }, { v: "in", t: "Pollici" }], S.cad.units, v => { S.cad.units = v; refresh(); })),
      row("Tabella stili (CTB)", select(ctbOpts, S.cad.ctb, async v => {
        if (v === "?") { const f = await pickFiles(); v = (f || []).find(p => /\.ctb$/i.test(p)) || ""; if (!v && f?.length) toast("Scegli un file .ctb", true); }
        S.cad.ctb = v; renderSide(); refresh();
      })),
      row("Spessori di linea", select([{ v: "", t: "Dal disegno" }, { v: "thin", t: "Tutte sottili" }, { v: "half", t: "Ridotti a meta'" }, { v: "double", t: "Raddoppiati" }], S.cad.lw, v => { S.cad.lw = v; refresh(); })),
      o.batch ? el("p", { class: "pr-note" }, "Automatica: le tavole disegnate 1:1 (cartiglio in mm) escono al 100% sul loro formato; i disegni al vero si adattano al foglio scelto sopra.") : null,
      el("p", { class: "pr-note" }, "In scala: 1 unita' del disegno = la misura reale; es. 1:100 con disegno in millimetri, 10 m diventano 10 cm sul foglio. I layout si stampano 1:1 sul loro foglio."));
  }

  // ---- stampa a lotti: elenco dei file
  const types = { cad: true, pdf: true, doc: false, img: false };
  let sub = false;
  function filesSection() {
    const list = el("div", { class: "pr-files" });
    if (!files.length) list.append(el("div", { class: "pr-empty" }, "Aggiungi le tavole da stampare: file singoli o una cartella intera."));
    files.forEach((f, i) => {
      const it = items.find(x => x.path === f.path);
      const bad = it?.kind === "error";
      list.append(el("div", { class: "pr-file" + (bad ? " bad" : ""), title: bad ? it.errore : f.path },
        el("span", { class: "pr-ext" }, extOf(f.name).toUpperCase()), el("span", { class: "pr-fn" }, f.name),
        iconBtn('<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>', "Su", () => { if (i) { files.splice(i - 1, 0, ...files.splice(i, 1)); sources(); } }),
        iconBtn(SVG.close, "Togli dall'elenco", () => { files.splice(i, 1); sources(); })));
    });
    const typeChecks = el("div", { class: "pr-line pr-wrap" }, el("span", { class: "pr-note" }, "Dalla cartella:"),
      check("DWG/DXF", types.cad, v => (types.cad = v)), check("PDF", types.pdf, v => (types.pdf = v)), check("Office", types.doc, v => (types.doc = v)),
      check("Immagini", types.img, v => (types.img = v)), check("Sottocartelle", sub, v => (sub = v)));
    return sec(`File da stampare (${files.length})`, list,
      el("div", { class: "pr-line pr-wrap" }, el("button", { class: "btn", onclick: addFiles }, "Aggiungi file..."), el("button", { class: "btn", onclick: addFolder }, "Aggiungi cartella..."),
        el("button", { class: "btn", onclick: addOpen }, "File aperti"), files.length ? el("button", { class: "btn", onclick: () => { files.length = 0; sources(); } }, "Svuota") : null),
      typeChecks);
  }
  const addList = paths => { for (const p of paths) if (!files.some(f => f.path === p)) files.push({ path: p, name: baseName(p) }); sources(); };
  async function addFiles() { const p = await pickFiles(); if (p?.length) addList(p); }
  async function addFolder() {
    const d = await pickFolder();
    if (!d) return;
    const exts = Object.entries(types).filter(([, v]) => v).flatMap(([k]) => BATCH_TYPES[k]);
    const r = await api("print_scan", {}, { json: { folder: d, exts, sub } });
    if (!r.files.length) return toast("Nessun file dei tipi scelti in questa cartella", true);
    addList(r.files.map(f => f.path));
  }
  back.__pr = { S, addList, refresh, get comp() { return comp; }, get items() { return items; } }; // per i collaudi dalla console
  function addOpen() { addList((window.MB?.tabs || []).filter(t => !t.untitled).map(t => t.path)); }

  // ---- motore: stampanti, sorgenti, impaginazione, anteprima
  let ctbs = [];
  async function loadPrinter() {
    try {
      P = await api("print_printer", { name: S.printer });
      const pp = prefs.papers?.[S.printer];
      if (!S.paper) S.paper = o.batch ? (pp?.batch || "auto") : (pp?.single || (P.forms.some(f => f.name === P.default.paper) ? P.default.paper : "auto"));
      if (S.paper !== "auto" && S.paper !== "custom" && !S.paper.startsWith("roll:") && !P.forms.some(f => f.name === S.paper)) S.paper = "auto";
      if (!P.forms.some(f => f.name === S.paper_fallback)) S.paper_fallback = (P.forms.find(f => /^(ISO\s*)?A3\b/i.test(f.name)) || P.forms[0] || {}).name || "A3";
    } catch (e) { P = null; msg.textContent = e.message; }
    renderSide();
    refresh();
  }
  function rememberPaper() {
    prefs.papers = prefs.papers || {};
    prefs.papers[S.printer] = { ...(prefs.papers[S.printer] || {}), [o.batch ? "batch" : "single"]: S.paper };
  }
  async function driverProps() {
    try {
      const r = await api("print_dialog", {}, { json: { name: S.printer, devmode: devmodes[S.printer] || null } });
      if (!r.annullato) { devmodes[S.printer] = r.devmode; refresh(); }
    } catch (e) { toast(e.message, true); }
  }

  // sorgenti -> motore (conversioni Office, DWG -> DXF...)
  let srcGen = 0;
  async function sources() {
    const gen = ++srcGen;
    let list = o.batch ? files.map(f => ({ path: f.path, name: f.name })) : o.sources;
    if (!list.length) { items = []; sid = null; comp = null; renderSide(); drawPreview(); return; }
    setBusy(1, "Preparazione dei file");
    if (o.batch) renderSide();
    try {
      if (o.batch && !oda) {
        const out = [];
        for (const [i, s] of list.entries()) {
          if (extOf(s.name) === "dwg") {
            msg.textContent = `Lettura DWG ${i + 1} di ${list.length}: ${s.name}`;
            try { out.push({ ...s, kind: "cad", ...(await dwgToDxf(s.path)) }); } catch (e) { out.push({ ...s, kind: "cad", dxf: "?", errore: e.message }); }
          } else out.push(s);
          if (gen !== srcGen || closed) return;
        }
        list = out;
      }
      const r = await waitJob((await api("print_prepare", {}, { json: { sources: list.map(s => (s.errore ? { ...s, path: s.path, kind: "pdf", pdf: "?" } : s)) } })).job, (p, m) => (msg.textContent = m));
      if (gen !== srcGen || closed) return;
      sid = r.sid;
      items = r.items.map((it, i) => (list[i].errore ? { ...it, kind: "error", errore: list[i].errore } : it));
      const bad = items.filter(i => i.kind === "error");
      if (!o.batch && bad.length) throw new Error(bad[0].errore);
      msg.textContent = bad.length ? `${bad.length} file non stampabili (in rosso nell'elenco)` : "";
    } catch (e) {
      msg.textContent = e.message;
      items = [];
    } finally { setBusy(-1); }
    renderSide();
    refresh();
  }

  function settings() {
    const st = JSON.parse(JSON.stringify(S));
    if (S.paper === "custom") st.paper = { w: S.custom.w, h: S.custom.h, name: `${S.custom.w} x ${S.custom.h} mm` };
    else if (S.paper.startsWith("roll:")) { st.paper = "auto"; st.roll = +S.paper.slice(5); }
    st.devmode = devmodes[S.printer] || null;
    return st;
  }

  let compGen = 0, timer = 0;
  function refresh() { clearTimeout(timer); timer = setTimeout(compose, 250); }
  async function compose() {
    if (!sid || !P || closed) { drawPreview(); return; }
    const gen = ++compGen;
    setBusy(1, "Impaginazione");
    try {
      const r = await waitJob((await api("print_compose", {}, { json: { sid, settings: settings() } })).job);
      if (gen !== compGen || closed) return;
      comp = r;
      cur = Math.min(cur, r.pages.length - 1);
      if (r.errori?.length) msg.textContent = r.errori.map(e => `${e.name}: ${e.errore}`).join(" · ");
      else if (!busyMsg()) msg.textContent = "";
    } catch (e) {
      if (gen !== compGen) return;
      comp = null;
      msg.textContent = e.message;
    } finally { setBusy(-1); }
    drawPreview();
  }
  const busyMsg = () => /Lettura|Preparazione/.test(msg.textContent);

  function setBusy(d, text) {
    busy = Math.max(0, busy + d);
    busyEl.hidden = !busy;
    if (text) busyEl.lastChild.textContent = text;
    printBtn.disabled = !!busy || !comp;
  }

  function drawPreview() {
    printBtn.disabled = !!busy || !comp;
    chips.innerHTML = "";
    if (!comp) { paper.hidden = true; pageInfo.textContent = ""; info.textContent = o.batch && !files.length ? "Aggiungi i file da stampare" : ""; prevB.disabled = nextB.disabled = true; return; }
    const n = comp.pages.length;
    comp.pages.forEach((p, i) => chips.append(el("button", { class: "pr-chip" + (i === cur ? " on" : "") + (p.warn ? " warn" : ""), title: p.label + (p.warn ? " - " + p.warn : ""), onclick: () => show(i) },
      el("b", {}, shortPaper(p)), el("span", {}, p.scale))));
    show(cur);
    const sheets = {};
    for (const p of comp.pages) sheets[shortPaper(p)] = (sheets[shortPaper(p)] || 0) + 1;
    printBtn.textContent = P?.virtual ? "Salva PDF..." : `Stampa ${n * Math.max(1, S.copies)} ${n * S.copies === 1 ? "foglio" : "fogli"}`;
    if (!msg.textContent || /^Fogli:/.test(msg.textContent)) msg.textContent = "Fogli: " + Object.entries(sheets).map(([k, v]) => `${v} x ${k}`).join(", ");
  }

  function show(i) {
    if (!comp) return;
    cur = Math.max(0, Math.min(comp.pages.length - 1, i));
    const p = comp.pages[cur];
    [...chips.children].forEach((c, k) => c.classList.toggle("on", k === cur));
    chips.children[cur]?.scrollIntoView({ block: "nearest", inline: "nearest" });
    prevB.disabled = cur === 0;
    nextB.disabled = cur >= comp.pages.length - 1;
    pageInfo.textContent = `Foglio ${cur + 1} di ${comp.pages.length}`;
    // foglio adattato allo spazio dell'anteprima, con i margini non stampabili tratteggiati
    const r = stage.getBoundingClientRect();
    const k = Math.max(0.05, Math.min((r.width - 40) / p.w, (r.height - 40) / p.h));
    paper.hidden = false;
    paper.style.width = p.w * k + "px";
    paper.style.height = p.h * k + "px";
    const [ml, mt, mr, mb] = p.margins || [0, 0, 0, 0];
    marg.hidden = !(ml || mt || mr || mb);
    Object.assign(marg.style, { left: ml * k + "px", top: mt * k + "px", right: mr * k + "px", bottom: mb * k + "px" });
    const dpi = Math.min(200, Math.max(30, (k * 25.4) * (devicePixelRatio || 1)));
    img.src = `/api/print_preview?cid=${comp.cid}&page=${cur}&dpi=${dpi.toFixed(1)}`;
    info.innerHTML = "";
    info.append(el("div", {}, el("b", {}, p.label)), el("div", {}, `Foglio ${p.paper?.name || ""} - ${fmtMm(p.w)} x ${fmtMm(p.h)} mm, ${p.landscape ? "orizzontale" : "verticale"} - scala ${p.scale}`));
    if (p.warn) info.append(el("div", { class: "pr-warn" }, p.warn));
  }
  let lastSize = "";
  new ResizeObserver(() => { const r = stage.getBoundingClientRect(), k = `${Math.round(r.width)}x${Math.round(r.height)}`; if (k !== lastSize) { lastSize = k; if (comp) show(cur); } }).observe(stage);

  // ---- finestra di stampa nel disegno: due clic sul visualizzatore CAD
  async function pickWindow() {
    const c = o.cad;
    if (!c?.canvas) return toast("Apri il disegno per scegliere la finestra", true);
    back.hidden = true;
    const cv = c.canvas, host = cv.parentElement;
    const ov = el("div", { class: "pr-pick" }), box = el("div", { class: "pr-pickbox", hidden: true });
    const tip = el("div", { class: "pr-picktip" }, "Finestra di stampa: clic sul primo angolo (Esc annulla)");
    ov.append(box, tip);
    host.append(ov);
    const dpr = devicePixelRatio || 1;
    let a = null;
    const done = w => { ov.remove(); window.removeEventListener("keydown", onKey, true); back.hidden = false; back.focus(); if (w) { S.cad.window = w; S.cad.area = "window"; } else if (!S.cad.window) S.cad.area = "extents"; renderSide(); refresh(); };
    const onKey = e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(null); } };
    window.addEventListener("keydown", onKey, true);
    const local = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    ov.addEventListener("pointermove", e => {
      if (!a) return;
      const [x, y] = local(e);
      Object.assign(box.style, { left: Math.min(a[0], x) + "px", top: Math.min(a[1], y) + "px", width: Math.abs(x - a[0]) + "px", height: Math.abs(y - a[1]) + "px" });
    });
    ov.addEventListener("pointerdown", e => {
      e.preventDefault();
      const p = local(e);
      if (!a) { a = p; box.hidden = false; tip.textContent = "Clic sull'angolo opposto"; return; }
      const w1 = c.toWorld(a[0] * dpr, a[1] * dpr), w2 = c.toWorld(p[0] * dpr, p[1] * dpr);
      if (Math.abs(p[0] - a[0]) < 4 || Math.abs(p[1] - a[1]) < 4) return;
      done([Math.min(w1[0], w2[0]), Math.min(w1[1], w2[1]), Math.max(w1[0], w2[0]), Math.max(w1[1], w2[1])]);
    });
  }

  // ---- stampa
  async function doPrint() {
    if (!comp) return;
    const extra = { copies: S.copies, collate: S.collate, dpi: S.dpi, title: o.subtitle || "MB Visual - stampa a lotti", devmode: devmodes[S.printer] || null };
    if (P.virtual) {
      const first = o.batch ? (files[0]?.name || "Stampa") : o.subtitle;
      const out = await pickSavePath((o.batch ? "Stampa a lotti" : first.replace(/\.[^.]+$/, "")) + " - stampa.pdf", o.batch ? dirName(files[0]?.path || "") : dirName(o.tab?.path || ""));
      if (!out) return;
      extra.output = out;
    }
    prefs.printer = S.printer; prefs.style = S.style; prefs.dpi = S.dpi; prefs.margin = S.margin; prefs.ctb = S.cad.ctb; prefs.lw = S.cad.lw;
    prefs.cadScale = S.cad.scale.cad; prefs.paper_fallback = S.paper_fallback;
    rememberPaper();
    savePrefs(prefs);
    printBtn.disabled = true;
    bar.hidden = false;
    try {
      const r = await waitJob((await api("print_run", {}, { json: { cid: comp.cid, extra } })).job, (p, m) => { bar.value = p; msg.textContent = m; });
      if (r.avvisi?.length) toast(r.avvisi[0], true, 8000);
      toast(P.virtual ? `PDF salvato: ${baseName(r.output)} (${r.pagine} fogli)` : `Inviato a ${S.printer}: ${r.pagine} ${r.pagine === 1 ? "foglio" : "fogli"}`);
      close();
    } catch (e) {
      msg.textContent = e.message;
      printBtn.disabled = false;
    } finally { bar.hidden = true; }
  }

  // ---- avvio
  try {
    const r = await api("print_printers");
    printers = r.printers;
    oda = r.oda;
    if (!printers.some(p => p.name === S.printer)) S.printer = r.default || printers[0].name;
    api("print_ctb").then(x => { ctbs = x.ctb || []; if (items.some(i => i.kind === "cad")) renderSide(); }).catch(() => {});
  } catch (e) { msg.textContent = e.message; }
  renderSide();
  loadPrinter();
  sources();
}

function shortPaper(p) {
  const n = p.paper?.name || "";
  const m = n.match(/(?:ISO\s*)?(2A0|A\d)(?!\d)|(Rotolo \d+)/i);
  return m ? (m[1] || m[2]).toUpperCase().replace("ROTOLO", "Rotolo") : `${fmtMm(p.w)}x${fmtMm(p.h)}`;
}
const fmtMm = v => (Math.round(v * 10) / 10).toLocaleString("it-IT");
const fmtC = v => (Math.round(v * 100) / 100).toLocaleString("it-IT");
