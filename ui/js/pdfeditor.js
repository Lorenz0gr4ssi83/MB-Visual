// Editor PDF sopra il visualizzatore pdf.js (motore PyMuPDF: mbvisual/pdfedit.py e pdfobjects.py).
// Una sola barra, sempre visibile: si sceglie lo strumento, il pulsante resta acceso finche' si e' in modifica
// (clic di nuovo o Esc per uscire); le opzioni stanno nel pannello a destra e non coprono mai la pagina.
// Strumenti: Seleziona (testi, immagini, gruppi di disegni e singoli tracciati, campi, annotazioni, collegamenti;
// selezione multipla e a riquadro), annotazioni (evidenzia, testo libero e penna di pdf.js pilotati da qui; sottolinea,
// barra, nota), Testo, Macchina da scrivere, Immagine, Forme, un pulsante per ogni tipo di campo modulo (campi standard
// AcroForm: restano compilabili in Acrobat e negli altri programmi), Collegamento, Bianchetto, Oscura; menu Pagina e
// Documento. Le modifiche vanno su una copia di lavoro; l'originale cambia solo con Salva. Annulla / Ripeti per ogni passo.
import { t as tr } from "./i18n.js";
import { api, askText, confirmBox, el, fileUrl, modal, pickFiles, toast } from "./core.js";

const CSS = `
.mbv-layer { position: absolute; inset: 0; z-index: 30; }
.mbv-obj { position: absolute; outline: 1px solid transparent; }
.mbv-obj:hover { outline: 1.5px solid rgba(42,120,214,.9); background: rgba(42,120,214,.07); }
.mbv-obj.k-field { outline: 1px dashed rgba(200,120,0,.6); background: rgba(255,170,0,.06); }
.mbv-obj.k-image:hover { outline-color: rgba(46,160,90,.9); background: rgba(46,160,90,.07); }
.mbv-obj.k-annot:hover { outline-color: rgba(200,60,160,.9); }
.mbv-obj.sel { outline: 2px solid #ff9f1a !important; background: rgba(255,159,26,.08); z-index: 3; }
.mbv-layer.ingroup { background: rgba(255,255,255,.35); }
.mbv-h { position: absolute; width: 9px; height: 9px; background: #fff; border: 1.5px solid #ff9f1a; z-index: 4; }
.mbv-line { position: absolute; outline: 1px dashed rgba(42,120,214,.35); white-space: pre; line-height: 1; }
.mbv-line:hover { outline: 1.5px solid rgba(42,120,214,.9); background: rgba(42,120,214,.07); }
.mbv-line.editing { outline: 2px solid #2a78d6; background: #fff; z-index: 2; min-width: 4px; }
.mbv-rect { position: absolute; border: 1.5px dashed #2a78d6; background: rgba(42,120,214,.10); pointer-events: none; }
.mbv-rect.red { border-color: #c62828; background: rgba(198,40,40,.18); }
.mbv-tw { position: absolute; z-index: 5; background: rgba(255,255,240,.95); border: 1.5px solid #2a78d6; outline: none; resize: both; padding: 0; margin: 0; white-space: pre; overflow: hidden; }
.mbv-prev { position: absolute; z-index: 6; pointer-events: none; outline: 2px solid #ff9f1a;
  background: repeating-conic-gradient(#cfd4da 0% 25%, #fff 0% 50%) 50% / 14px 14px; }
`;
// i pulsanti di pdf.js per le annotazioni si nascondono: li comanda la nostra barra (niente tendine sopra la pagina)
export const PDFJS_HIDE = "#editorModeButtons, #editorModeSeparator { display: none !important; }";

const FONTS = ["Helvetica", "Arial", "Calibri", "Cambria", "Times New Roman", "Courier New", "Verdana", "Georgia", "Tahoma", "Segoe UI"];
const cssFont = f => (/times|serif|roman|cambria|georgia/i.test(f) ? `"${f}", "Times New Roman", serif` : /cour|mono/i.test(f) ? '"Courier New", monospace' : `"${f}", Arial, sans-serif`);
const SHAPES = [["rect", tr("pdfeditor.rettangolo")], ["rounded", tr("pdfeditor.rettangolo_arrotondato")], ["ellipse", tr("pdfeditor.ellisse_cerchio")], ["line", tr("pdfeditor.linea")], ["arrow", tr("pdfeditor.freccia")]];
const FIELDS = {
  "f-text": ["text", tr("pdfeditor.campo_testo"), tr("pdfeditor.riga_nome_cognome_data_codice")],
  "f-multiline": ["multiline", tr("pdfeditor.area_testo"), tr("pdfeditor.piu_righe_note_indirizzo_descrizione")],
  "f-combo": ["combo", tr("pdfeditor.menu_tendina"), tr("pdfeditor.scelta_elenco_discesa")],
  "f-list": ["list", tr("pdfeditor.elenco"), tr("pdfeditor.elenco_sempre_visibile_piu_voci")],
  "f-check": ["check", tr("pdfeditor.casella_spunta"), tr("pdfeditor.si_no")],
  "f-radio": ["radio", tr("pdfeditor.pulsante_opzione"), tr("pdfeditor.scelta_esclusiva_stesso_gruppo_sola")],
  "f-signature": ["signature", tr("pdfeditor.campo_firma"), tr("pdfeditor.spazio_firma_digitale")],
};
const PJ = { // strumenti di pdf.js: modalita' e parametri (AnnotationEditorType / AnnotationEditorParamsType)
  "pj-highlight": { mode: 9, label: tr("pdfeditor.evidenzia") },
  "pj-freetext": { mode: 3, label: tr("pdfeditor.testo_libero") },
  "pj-ink": { mode: 15, label: tr("pdfeditor.penna") },
};
const ANNOT_TOOLS = { underline: tr("pdfeditor.sottolinea"), strikeout: tr("pdfeditor.barra"), squiggly: tr("pdfeditor.ondulato"), note: tr("pdfeditor.nota") };
const KIND_NAMES = { text: tr("pdfeditor.testi"), image: tr("pdfeditor.immagini"), group: tr("pdfeditor.disegni"), annot: tr("pdfeditor.annotazioni"), field: tr("pdfeditor.campi"), link: tr("pdfeditor.collegamenti") };
const I = { // icone 24x24 a tratto
  select: '<path d="M5 3l14 8-6 2-2 6z"/>',
  highlight: '<path d="M4 20h16M7 16l3-9 7 7-9 3zM10 7l4-4 7 7-4 4"/>',
  freetext: '<path d="M4 4h16v4M12 4v16M9 20h6"/>',
  ink: '<path d="M3 17c3 0 4-6 7-6s2 6 5 6 4-4 6-5"/>',
  underline: '<path d="M7 4v7a5 5 0 0 0 10 0V4M5 20h14"/>',
  strikeout: '<path d="M4 12h16M16 6a4 3 0 0 0-8 1c0 4 8 3 8 7a4 3 0 0 1-8 1"/>',
  note: '<path d="M4 4h16v12h-6l-4 4v-4H4z"/>',
  line: '<path d="M4 7h16M4 12h10M4 17h13"/><path d="M18 14l3 3-3 3"/>',
  typewriter: '<path d="M4 10h16v8H4zM7 10V5h10v5M7 14h2M11 14h2M15 14h2"/>',
  image: '<path d="M3 5h18v14H3z"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 8"/>',
  shape: '<rect x="3" y="3" width="10" height="10"/><circle cx="16" cy="16" r="5"/>',
  "f-text": '<path d="M3 8h18v8H3zM6 11v2"/>',
  "f-multiline": '<path d="M3 5h18v14H3zM6 9h10M6 13h12M6 17h7"/>',
  "f-combo": '<path d="M3 8h18v8H3zM15 8v8M17 11l1.5 2 1.5-2"/>',
  "f-list": '<path d="M3 4h18v16H3zM6 8h12M6 12h12M6 16h12"/>',
  "f-check": '<path d="M4 4h16v16H4zM8 12l3 3 5-6"/>',
  "f-radio": '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  "f-signature": '<path d="M3 17c3-1 4-7 6-7s1 6 3 6 3-4 5-4 2 3 4 3M3 21h18"/>',
  link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  whiteout: '<path d="M4 15l8-8 6 6-8 8H4zM12 7l3-3 5 5-3 3"/>',
  redact: '<path d="M3 7h18v10H3z" fill="currentColor"/>',
  undo: '<path d="M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3"/>',
};
const svg = k => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${I[k] || ""}</svg>`;

export function createPdfEditor(ctx, frame, setBusy) {
  const app = () => frame.contentWindow?.PDFViewerApplication;
  const doc = () => frame.contentDocument;
  let work = null, mode = null;
  let sel = []; // [{ pno, o, d, vp }]
  let inGroup = null; // { pno, box } gruppo "aperto" con doppio clic: si selezionano i singoli tracciati
  let picker = null; // contagocce attivo: funzione(colore)
  const undo = [], redo = [];
  const objCache = new Map(), lineCache = new Map();
  const opt = {
    font: "Helvetica", size: 11, color: "#000000", bold: false, italic: false,
    shape: "rect", stroke: "#d32f2f", fill: "", width: 1.5, dashed: false,
    hlColor: "#fff066", hlThick: 12, ftColor: "#000000", ftSize: 12, inkColor: "#1e5bc6", inkThick: 2, inkOpacity: 1,
    annotColor: "", fieldNo: 1, fieldName: "", fieldOptions: tr("pdfeditor.opzione_1_opzione_2_opzione"), fieldRequired: false, fieldFont: 0,
    filter: { text: true, image: true, group: true, annot: true, field: true, link: true },
  };
  let meta = { title: "", author: "", subject: "", keywords: "" }, toc = [];

  // ---------------------------------------------------------------- copia di lavoro, operazioni, annulla/ripeti
  // ogni passo scrive un FILE NUOVO: il file mostrato da pdf.js puo' essere ancora aperto in lettura e su Windows
  // non si potrebbe sostituire (la modifica restava in un file temporaneo e sembrava non applicata)
  const nextCopy = async () => (await api("pdf_work", { path: work })).path;
  async function flushAnnotations() {
    // annotazioni di pdf.js (evidenziazioni, testi liberi, penna, moduli compilati) scritte in una nuova copia
    const a = app();
    if (!a?.pdfDocument || !a.pdfDocument.annotationStorage.size) return;
    const next = await nextCopy();
    await api("save", { path: next }, { body: await a.pdfDocument.saveDocument() });
    undo.push(work);
    work = next;
  }
  async function ensureWork() {
    if (work) return;
    work = (await api("pdf_work", { path: ctx.path })).path;
  }
  async function reload() {
    const a = app();
    const page = a.page, scale = a.pdfViewer.currentScaleValue, top = a.pdfViewer.container.scrollTop;
    objCache.clear(); lineCache.clear(); sel = []; clearPreview();
    await a.open({ url: fileUrl(work) + "&v=" + Date.now() });
    await new Promise(res => a.eventBus.on("pagesinit", res, { once: true }));
    a.pdfViewer.currentScaleValue = scale;
    a.page = Math.min(page, a.pagesCount);
    a.pdfViewer.container.scrollTop = top;
    ctx.setDirty(true);
    if (PJ[mode]) pjMode(PJ[mode].mode);
    renderPanel();
    if (mode) setTimeout(decorateAll, 60);
  }
  async function run(route, payload) {
    setBusy(true);
    try {
      await ensureWork();
      await flushAnnotations();
      const next = await nextCopy();
      await api(route, { path: next }, { json: payload });
      undo.push(work);
      redo.length = 0;
      work = next;
      await reload();
      return true;
    } catch (e) {
      toast(tr("pdfeditor.modifica_non_riuscita") + e.message, true, 7000);
      return false;
    } finally { setBusy(false); }
  }
  const ops = list => run("pdf_ops", { ops: list });
  async function undoLast() {
    if (!undo.length) return toast(tr("pdfeditor.nessuna_modifica_annullare"));
    redo.push(work);
    work = undo.pop();
    await reload();
  }
  async function redoLast() {
    if (!redo.length) return toast(tr("pdfeditor.niente_ripetere"));
    undo.push(work);
    work = redo.pop();
    await reload();
  }

  // ---------------------------------------------------------------- strumenti di pdf.js (evidenzia, testo libero, penna)
  function pjMode(m) {
    const a = app();
    if (!a?.eventBus) return;
    try { a.eventBus.dispatch("switchannotationeditormode", { source: null, mode: m }); } catch { /* */ }
    if (m === 9) { pjParam(32, opt.hlColor); pjParam(33, opt.hlThick); }
    if (m === 3) { pjParam(12, opt.ftColor); pjParam(11, opt.ftSize); }
    if (m === 15) { pjParam(21, opt.inkColor); pjParam(22, opt.inkThick); pjParam(23, opt.inkOpacity); }
  }
  function pjParam(type, value) {
    try { app()?.eventBus.dispatch("switchannotationeditorparams", { source: null, type, value }); } catch { /* */ }
  }

  // ---------------------------------------------------------------- coordinate e strati
  const curPage = () => (app()?.page || 1) - 1;
  function injectCss() {
    const d = doc();
    if (!d || d.getElementById("mbv-edit-css")) return;
    d.head.append(Object.assign(d.createElement("style"), { id: "mbv-edit-css", textContent: CSS }));
  }
  const clearLayers = () => doc()?.querySelectorAll(".mbv-layer").forEach(n => n.remove());
  function rectToCss(vp, box) {
    const [x0, y0, x1, y1] = vp.convertToViewportRectangle(box);
    return { left: Math.min(x0, x1), top: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
  }
  function cssToPdf(vp, l, t, w, h) {
    const [ax, ay] = vp.convertToPdfPoint(l, t), [bx, by] = vp.convertToPdfPoint(l + w, t + h);
    return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
  }
  const place = (node, r) => Object.assign(node.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
  const rectOf = d => ({ left: parseFloat(d.style.left), top: parseFloat(d.style.top), width: parseFloat(d.style.width), height: parseFloat(d.style.height) });
  function newLayer(pv) {
    pv.div.querySelectorAll(".mbv-layer").forEach(n => n.remove());
    const layer = doc().createElement("div");
    layer.className = "mbv-layer";
    pv.div.append(layer);
    return layer;
  }
  // riquadro trascinato sulla pagina: onDone(boxPdf, p1Pdf, p2Pdf, rectCss)
  function dragLayer(pv, onDone, red = false, clickSize = null) {
    const layer = newLayer(pv), vp = pv.viewport;
    let start = null, box = null;
    layer.addEventListener("pointerdown", e => {
      if (picker) return pickColor(pv, e);
      const b = layer.getBoundingClientRect();
      start = [e.clientX - b.left, e.clientY - b.top];
      box = doc().createElement("div");
      box.className = "mbv-rect" + (red ? " red" : "");
      layer.append(box);
      try { layer.setPointerCapture(e.pointerId); } catch { /* */ }
    });
    layer.addEventListener("pointermove", e => {
      if (!start) return;
      const b = layer.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
      place(box, { left: Math.min(x, start[0]), top: Math.min(y, start[1]), width: Math.abs(x - start[0]), height: Math.abs(y - start[1]) });
    });
    layer.addEventListener("pointerup", async e => {
      if (!start) return;
      const b = layer.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
      let r = { left: Math.min(x, start[0]), top: Math.min(y, start[1]), width: Math.abs(x - start[0]), height: Math.abs(y - start[1]) };
      const s = start;
      start = null;
      if (r.width < 4 && r.height < 4) {
        if (!clickSize) { box.remove(); return; }
        const k = vp.scale;
        r = { left: x, top: y, width: clickSize[0] * k, height: clickSize[1] * k }; // clic singolo: riquadro predefinito
      }
      const p1 = vp.convertToPdfPoint(s[0], s[1]), p2 = vp.convertToPdfPoint(x, y);
      await onDone(cssToPdf(vp, r.left, r.top, r.width, r.height), p1, p2, r);
      box?.remove();
    });
    return layer;
  }

  // ---------------------------------------------------------------- strumenti per pagina
  async function decoratePage(pv) {
    if (!mode || PJ[mode] || !pv?.div || !pv.viewport) return;
    const pno = pv.id - 1, vp = pv.viewport;
    if (mode === "select") return decorateObjects(pv, pno, vp);
    if (mode === "line") return decorateLines(pv, pno, vp);
    if (mode === "typewriter") {
      const layer = newLayer(pv);
      layer.addEventListener("pointerdown", e => { if (e.target === layer) typewriter(layer, pno, vp, e); });
      return;
    }
    if (ANNOT_TOOLS[mode]) {
      if (mode === "note") return dragLayer(pv, async box => {
        const t = await askText(tr("pdfeditor.nota"), tr("pdfeditor.testo_nota"), "");
        if (t !== null) await ops([{ kind: "annot_add", page: pno, type: "note", box, text: t, color: opt.annotColor || "#ffcc00" }]);
      }, false, [20, 20]);
      return dragLayer(pv, box => ops([{ kind: "annot_add", page: pno, type: mode, box, color: opt.annotColor || undefined }]));
    }
    if (mode === "image") return dragLayer(pv, async box => { const data = await pickImage(); if (data) await ops([{ kind: "image_add", page: pno, box, data }]); }, false, [160, 120]);
    if (mode === "shape") return dragLayer(pv, (box, p1, p2) => ops([{ kind: "shape", page: pno, shape: opt.shape, box, p1, p2, stroke: opt.stroke, fill: opt.fill, width: opt.width, dashed: opt.dashed }]));
    if (FIELDS[mode]) {
      const t = FIELDS[mode][0];
      return dragLayer(pv, box => addField(pno, box, t), false, t === "check" || t === "radio" ? [14, 14] : [180, t === "multiline" || t === "list" ? 60 : 20]);
    }
    if (mode === "link") return dragLayer(pv, async box => {
      const v = await askText(tr("pdfeditor.collegamento"), tr("pdfeditor.indirizzo_web_https_oppure_numero"), "https://");
      if (!v) return;
      const n = parseInt(v, 10);
      await ops([String(n) === v.trim() ? { kind: "link_add", page: pno, box, target: n } : { kind: "link_add", page: pno, box, uri: v.trim() }]);
    });
    if (mode === "redact") return dragLayer(pv, async box => { if (await confirmBox(tr("pdfeditor.oscura"), tr("pdfeditor.oscurare_definitivamente_zona_testo_immagini"), tr("pdfeditor.oscura"), true)) await ops([{ kind: "redact", page: pno, box }]); }, true);
    if (mode === "whiteout") return dragLayer(pv, box => ops([{ kind: "whiteout", page: pno, box }]));
    if (mode === "crop") return dragLayer(pv, async box => { if (await confirmBox(tr("pdfeditor.ritaglia"), tr("pdfeditor.ritagliare_pagina_riquadro_disegnato"))) await ops([{ kind: "crop", page: pno, box }]); });
  }

  // ---- Seleziona: oggetti, selezione multipla, riquadro, gruppi
  async function pageData(pno) {
    let data = objCache.get(pno);
    if (!data) {
      data = await api("pdf_objects", { path: work || ctx.path, page: pno });
      objCache.set(pno, data);
      meta = data.metadata || meta;
      toc = data.toc || toc;
    }
    return data;
  }
  async function decorateObjects(pv, pno, vp) {
    let data;
    try { data = await pageData(pno); } catch (e) { return toast(e.message, true); }
    if (mode !== "select") return;
    const layer = newLayer(pv);
    let list;
    if (inGroup && inGroup.pno === pno) {
      // dentro un gruppo: i singoli tracciati (gli altri oggetti restano fuori)
      layer.classList.add("ingroup");
      const [gx0, gy0, gx1, gy1] = inGroup.box;
      list = data.tracciati.filter(t => t.box[0] >= gx0 - 1 && t.box[1] >= gy0 - 1 && t.box[2] <= gx1 + 1 && t.box[3] <= gy1 + 1)
        .sort((a, b) => (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) - (a.box[2] - a.box[0]) * (a.box[3] - a.box[1])); // i piccoli sopra
    } else {
      const order = { group: 0, text: 1, image: 2, annot: 3, link: 3, field: 4 };
      list = data.oggetti.filter(o => opt.filter[o.kind] !== false).sort((a, b) => (order[a.kind] ?? 0) - (order[b.kind] ?? 0));
      // tra gli oggetti dello stesso tipo, i piu' piccoli sopra (si raggiungono anche se dentro uno grande)
    }
    for (const o of list) {
      const r = rectToCss(vp, o.box);
      if (r.width < 3) { r.left -= (3 - r.width) / 2; r.width = 3; }
      if (r.height < 3) { r.top -= (3 - r.height) / 2; r.height = 3; }
      const d = doc().createElement("div");
      d.className = "mbv-obj k-" + o.kind;
      d.title = describe(o);
      place(d, r);
      d._obj = o;
      d.addEventListener("pointerdown", e => {
        if (picker) return pickColor(pv, e);
        e.stopPropagation();
        const already = sel.some(s => s.o === o);
        if (e.shiftKey || e.ctrlKey) { toggleSel(pno, o, d, vp); return; }
        if (!already) setSel([{ pno, o, d, vp }]);
        startDrag(e, d, pno, vp, "move");
      });
      d.addEventListener("dblclick", e => {
        e.stopPropagation();
        if (o.kind === "text") editTextInline(d, o, pno, vp);
        else if (o.kind === "group") { inGroup = { pno, box: o.box }; sel = []; decorateAll(); renderPanel(); }
      });
      layer.append(d);
    }
    if (sel.length) restoreSel(pno, layer, vp);
    // riquadro di selezione sullo sfondo; clic sul vuoto: deseleziona (o esce dal gruppo)
    let start = null, box = null;
    layer.addEventListener("pointerdown", e => {
      if (picker) return pickColor(pv, e);
      if (e.target !== layer) return;
      const b = layer.getBoundingClientRect();
      start = [e.clientX - b.left, e.clientY - b.top];
      box = doc().createElement("div");
      box.className = "mbv-rect";
      layer.append(box);
      try { layer.setPointerCapture(e.pointerId); } catch { /* */ }
    });
    layer.addEventListener("pointermove", e => {
      if (!start) return;
      const b = layer.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
      place(box, { left: Math.min(x, start[0]), top: Math.min(y, start[1]), width: Math.abs(x - start[0]), height: Math.abs(y - start[1]) });
    });
    layer.addEventListener("pointerup", e => {
      if (!start) return;
      const r = rectOf(box);
      box.remove();
      start = null;
      if (r.width < 4 && r.height < 4) {
        if (inGroup) { inGroup = null; sel = []; decorateAll(); renderPanel(); return; }
        if (!e.shiftKey) setSel([]);
        return;
      }
      const inside = [...layer.querySelectorAll(".mbv-obj")].filter(n => { const q = rectOf(n); return q.left >= r.left && q.top >= r.top && q.left + q.width <= r.left + r.width && q.top + q.height <= r.top + r.height; });
      setSel([...(e.shiftKey ? sel : []), ...inside.map(n => ({ pno, o: n._obj, d: n, vp }))]);
    });
  }
  function describe(o) {
    return { image: tr("pdfeditor.immagine"), text: tr("pdfeditor.blocco_testo_doppio_clic_riscriverlo"), group: tr("pdfeditor.gruppo_disegni_0_tracciati_doppio", o.n), drawing: tr("pdfeditor.tracciato"),
      field: tr("pdfeditor.campo_modulo") + (o.name || ""), link: tr("pdfeditor.collegamento"), annot: tr("pdfeditor.annotazione") + (o.type || "") }[o.kind] || o.kind;
  }
  const sameObj = (a, b) => a === b || (a.kind === b.kind && (a.xref ? a.xref === b.xref : a.seqno != null ? a.seqno === b.seqno : a.box.join() === b.box.join()));
  function restoreSel(pno, layer, vp) {
    // dopo un ridisegno della pagina la selezione si riaggancia ai nuovi riquadri
    for (const s of sel) if (s.pno === pno) { const n = [...layer.querySelectorAll(".mbv-obj")].find(x => sameObj(x._obj, s.o)); if (n) { s.d = n; s.vp = vp; } }
    paintSel();
  }
  function setSel(list) { sel = list; clearPreview(); paintSel(); renderPanel(); }
  function toggleSel(pno, o, d, vp) {
    const i = sel.findIndex(s => s.o === o);
    if (i >= 0) sel.splice(i, 1); else sel.push({ pno, o, d, vp });
    setSel([...sel]);
  }
  function paintSel() {
    doc()?.querySelectorAll(".mbv-obj.sel").forEach(n => n.classList.remove("sel"));
    doc()?.querySelectorAll(".mbv-h").forEach(n => n.remove());
    for (const s of sel) s.d?.classList.add("sel");
    if (sel.length === 1 && sel[0].d?.parentNode && sel[0].o.kind !== "link") {
      const { d, pno, vp } = sel[0];
      const r = rectOf(d);
      for (const pos of ["nw", "ne", "sw", "se"]) {
        const h = doc().createElement("div");
        h.className = "mbv-h";
        Object.assign(h.style, { left: r.left + (pos.includes("e") ? r.width : 0) - 5 + "px", top: r.top + (pos.includes("s") ? r.height : 0) - 5 + "px" });
        h.addEventListener("pointerdown", e => { e.stopPropagation(); startDrag(e, d, pno, vp, pos); });
        d.parentNode.append(h);
      }
    }
  }
  function startDrag(e, d, pno, vp, how) {
    const x0 = e.clientX, y0 = e.clientY;
    const moving = how === "move" ? sel.filter(s => s.d) : [{ d, pno, vp, o: d._obj }];
    const starts = moving.map(s => rectOf(s.d));
    const r0 = rectOf(d);
    let moved = false;
    const target = e.target;
    try { target.setPointerCapture(e.pointerId); } catch { /* */ }
    const mv = ev => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      doc().querySelectorAll(".mbv-h").forEach(n => n.remove());
      if (how === "move") moving.forEach((s, i) => place(s.d, { ...starts[i], left: starts[i].left + dx, top: starts[i].top + dy }));
      else {
        const r = { ...r0 };
        if (how.includes("w")) { r.left += dx; r.width -= dx; }
        if (how.includes("e")) r.width += dx;
        if (how.includes("n")) { r.top += dy; r.height -= dy; }
        if (how.includes("s")) r.height += dy;
        if (ev.shiftKey && r0.width) r.height = r.width * (r0.height / r0.width); // Maiusc: proporzioni bloccate
        r.width = Math.max(4, r.width); r.height = Math.max(4, r.height);
        place(d, r);
      }
    };
    const up = async () => {
      target.removeEventListener("pointermove", mv);
      target.removeEventListener("pointerup", up);
      if (!moved) return;
      const list = [];
      for (const s of moving) {
        const q = rectOf(s.d);
        list.push(...moveOps(s.pno, s.o, cssToPdf(s.vp, q.left, q.top, q.width, q.height)));
      }
      if (list.length) await ops(list);
    };
    target.addEventListener("pointermove", mv);
    target.addEventListener("pointerup", up);
  }
  function moveOps(pno, o, to) {
    if (o.kind === "image") return [{ kind: "image_move", page: pno, xref: o.xref, box: o.box, to }];
    if (o.kind === "group") return [{ kind: "draw_move", page: pno, box: o.box, to }];
    if (o.kind === "drawing") return [{ kind: "draw_edit", page: pno, box: o.box, targets: [o.seqno], to }];
    if (o.kind === "field") return [{ kind: "field_update", page: pno, xref: o.xref, to, props: {} }];
    if (o.kind === "annot") return [{ kind: "annot_update", page: pno, xref: o.xref, to, props: {} }];
    if (o.kind === "link") return [{ kind: "link_delete", page: pno, box: o.box }, o.uri ? { kind: "link_add", page: pno, box: to, uri: o.uri } : { kind: "link_add", page: pno, box: to, target: (o.page ?? 0) + 1 }];
    if (o.kind === "text") return [{ kind: "text_block", page: pno, box: o.box, to, text: o.text, font: o.font, size: o.size, color: o.color, bold: o.bold, italic: o.italic }];
    return [];
  }
  function deleteOps(pno, o) {
    return {
      image: [{ kind: "image_delete", page: pno, xref: o.xref, box: o.box }], group: [{ kind: "draw_delete", page: pno, box: o.box }],
      drawing: [{ kind: "draw_edit", page: pno, box: o.box, targets: [o.seqno], delete: true }], field: [{ kind: "field_delete", page: pno, xref: o.xref }],
      annot: [{ kind: "annot_delete", page: pno, xref: o.xref }], link: [{ kind: "link_delete", page: pno, box: o.box }],
      text: [{ kind: "text_block", page: pno, box: o.box, text: "", font: o.font, size: o.size }],
    }[o.kind] || [];
  }
  const deleteSel = () => sel.length && ops(sel.flatMap(s => deleteOps(s.pno, s.o)));
  function editTextInline(d, o, pno, vp) {
    const ta = doc().createElement("textarea");
    ta.className = "mbv-tw";
    ta.value = o.text;
    const k = vp?.scale || 1;
    Object.assign(ta.style, { left: d.style.left, top: d.style.top, width: Math.max(parseFloat(d.style.width), 120) + "px", height: Math.max(parseFloat(d.style.height), 24) + "px",
      fontFamily: cssFont(o.font), fontSize: o.size * k + "px", color: o.color || "#000", fontWeight: o.bold ? 700 : 400, fontStyle: o.italic ? "italic" : "normal", whiteSpace: "pre-wrap", lineHeight: 1.15 });
    d.parentNode.append(ta);
    ta.focus();
    let done = false;
    const finish = async commit => {
      if (done) return;
      done = true;
      ta.remove();
      if (commit && ta.value !== o.text) await ops([{ kind: "text_block", page: pno, box: o.box, text: ta.value, font: o.font, size: o.size, color: o.color, bold: o.bold, italic: o.italic }]);
    };
    ta.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") finish(false); if (e.key === "Enter" && e.ctrlKey) finish(true); });
    ta.addEventListener("blur", () => finish(true), { once: true });
  }

  // ---- contagocce e anteprima della trasparenza delle immagini
  function pageCanvas(pv) { return pv.canvas || pv.div.querySelector("canvas"); }
  function pickColor(pv, e) {
    e.preventDefault(); e.stopPropagation();
    const cv = pageCanvas(pv);
    if (!cv) return;
    const b = cv.getBoundingClientRect();
    const x = Math.floor((e.clientX - b.left) * cv.width / b.width), y = Math.floor((e.clientY - b.top) * cv.height / b.height);
    try {
      const [r, g, bl] = cv.getContext("2d").getImageData(x, y, 1, 1).data;
      const hex = "#" + [r, g, bl].map(v => v.toString(16).padStart(2, "0")).join("");
      const fn = picker;
      picker = null;
      fn(hex);
    } catch (err) { picker = null; toast(tr("pdfeditor.colore_non_leggibile") + err.message, true); }
  }
  let preview = null;
  function clearPreview() { preview?.remove(); preview = null; }
  function showPreview(s, st) {
    clearPreview();
    const pv = app()?.pdfViewer.getPageView(s.pno);
    const cv = pv && pageCanvas(pv);
    if (!cv || !s.d) return;
    const r = rectOf(s.d), b = cv.getBoundingClientRect(), lb = s.d.parentNode.getBoundingClientRect();
    const kx = cv.width / b.width, ky = cv.height / b.height;
    const sx = Math.round((r.left + lb.left - b.left) * kx), sy = Math.round((r.top + lb.top - b.top) * ky);
    const w = Math.max(1, Math.round(r.width * kx)), h = Math.max(1, Math.round(r.height * ky));
    const c = doc().createElement("canvas");
    c.width = w; c.height = h;
    c.className = "mbv-prev";
    place(c, r);
    const g = c.getContext("2d");
    g.drawImage(cv, sx, sy, w, h, 0, 0, w, h);
    const img = g.getImageData(0, 0, w, h), px = img.data;
    const cols = st.transparent.map(hx => [1, 3, 5].map(i => parseInt(hx.slice(i, i + 2), 16)));
    const tol = st.tol * 2.55;
    for (let i = 0; i < px.length; i += 4) {
      for (const [cr, cg, cb] of cols) if (Math.max(Math.abs(px[i] - cr), Math.abs(px[i + 1] - cg), Math.abs(px[i + 2] - cb)) <= tol) { px[i + 3] = 0; break; }
      if (st.gray) { const v = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; px[i] = px[i + 1] = px[i + 2] = v; }
      px[i + 3] *= st.opacity;
    }
    g.putImageData(img, 0, 0);
    s.d.parentNode.append(c);
    preview = c;
  }

  // ---- Testo (riga per riga, stesso carattere)
  async function decorateLines(pv, pno, vp) {
    let lines = lineCache.get(pno);
    if (!lines) {
      try { lines = (await api("pdf_lines", { path: work || ctx.path, page: pno })).righe; } catch (e) { return toast(e.message, true); }
      lineCache.set(pno, lines);
    }
    if (mode !== "line") return;
    const layer = newLayer(pv);
    for (const ln of lines) {
      const r = rectToCss(vp, ln.box);
      const d = doc().createElement("div");
      d.className = "mbv-line";
      d.title = tr("pdfeditor.0_1_pt_clic_modificare", ln.font, ln.size);
      place(d, r);
      d.addEventListener("click", () => editLine(d, ln, pno, r));
      layer.append(d);
    }
  }
  function editLine(d, ln, pno, r) {
    if (d.classList.contains("editing")) return;
    d.classList.add("editing");
    d.contentEditable = "plaintext-only";
    d.textContent = ln.text;
    Object.assign(d.style, { fontSize: r.height * 0.82 + "px", color: ln.color, fontWeight: ln.bold ? "700" : "400", fontStyle: ln.italic ? "italic" : "normal",
      fontFamily: cssFont(ln.font), width: "auto", minWidth: r.width + "px", lineHeight: r.height + "px" });
    d.focus();
    const s = doc().getSelection();
    s.selectAllChildren(d);
    s.collapseToEnd();
    let done = false;
    const finish = async commit => {
      if (done) return;
      done = true;
      const text = d.textContent.replace(/\r/g, "");
      d.contentEditable = "false";
      d.classList.remove("editing");
      d.textContent = "";
      Object.assign(d.style, { width: r.width + "px", fontSize: "" });
      if (commit && text !== ln.text) await run("pdf_edit", { edits: [{ page: pno, kind: "replace", box: ln.box, origin: ln.origin, font: ln.font, size: ln.size, color: ln.color, bold: ln.bold, italic: ln.italic, text }] });
    };
    d.addEventListener("blur", () => finish(true), { once: true });
    d.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); finish(false); } else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true); } e.stopPropagation(); });
  }

  // ---- Macchina da scrivere
  function typewriter(layer, pno, vp, e) {
    const b = layer.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
    const ta = doc().createElement("textarea");
    ta.className = "mbv-tw";
    const px = opt.size * vp.scale;
    Object.assign(ta.style, { left: x + "px", top: y - px * 0.85 + "px", width: "260px", height: px * 1.4 + "px", fontFamily: cssFont(opt.font), fontSize: px + "px",
      color: opt.color, fontWeight: opt.bold ? 700 : 400, fontStyle: opt.italic ? "italic" : "normal", lineHeight: 1.2 });
    layer.append(ta);
    setTimeout(() => ta.focus(), 0);
    ta.addEventListener("input", () => { ta.style.height = Math.max(px * 1.4, ta.scrollHeight) + "px"; ta.style.width = Math.max(260, ta.scrollWidth + 8) + "px"; });
    let done = false;
    const finish = async commit => {
      if (done) return;
      done = true;
      const text = ta.value.replace(/\s+$/, "");
      ta.remove();
      if (commit && text) await ops([{ kind: "typewriter", page: pno, at: vp.convertToPdfPoint(x, y), text, font: opt.font, size: opt.size, color: opt.color, bold: opt.bold, italic: opt.italic }]);
    };
    ta.addEventListener("keydown", ev => { ev.stopPropagation(); if (ev.key === "Escape") finish(false); else if (ev.key === "Enter" && ev.ctrlKey) finish(true); });
    ta.addEventListener("blur", () => finish(true));
  }

  // ---- immagini e campi
  function pickImage() {
    return new Promise(res => {
      const inp = el("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/bmp,image/webp,image/tiff", style: { display: "none" } });
      inp.addEventListener("change", () => {
        const f = inp.files?.[0];
        inp.remove();
        if (!f) return res(null);
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result).split(",")[1]);
        fr.readAsDataURL(f);
      });
      inp.addEventListener("cancel", () => { inp.remove(); res(null); });
      document.body.append(inp);
      inp.click();
    });
  }
  const fieldBase = t => ({ text: "campo", multiline: "note", combo: "scelta", list: "elenco", check: "casella", radio: "opzione", signature: "firma" }[t] || "campo");
  async function addField(pno, box, t) {
    const name = (opt.fieldName || "").trim() || `${fieldBase(t)}_${opt.fieldNo}`;
    opt.fieldNo++;
    opt.fieldName = "";
    const options = t === "combo" || t === "list" ? opt.fieldOptions.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : undefined;
    await ops([{ kind: "field_add", page: pno, box, type: t === "multiline" ? "text" : t, multiline: t === "multiline", name, group: t === "radio" ? (opt.radioGroup || "opzioni") : undefined,
      required: opt.fieldRequired, fontsize: opt.fieldFont, options }]);
    toast(tr("pdfeditor.campo_0_creato", name));
  }

  // ---------------------------------------------------------------- pannello (a destra, non copre la pagina)
  const panel = el("div", { class: "pdf-panel", style: { display: "none", borderLeft: "1px solid var(--line)", background: "var(--panel)", overflow: "auto", padding: "10px 12px", fontSize: "12.5px" } });
  const row = (label, input) => el("label", { style: { display: "grid", gap: "3px", marginBottom: "8px" } }, el("span", { class: "note" }, label), input);
  const sel_ = (values, cur, onch) => { const s = el("select", { class: "field", style: { width: "100%" } }, ...values.map(v => (Array.isArray(v) ? el("option", { value: v[0], selected: String(v[0]) === String(cur) || undefined }, v[1]) : el("option", { value: v, selected: v === cur || undefined }, v)))); s.addEventListener("change", () => onch(s.value)); return s; };
  const inp_ = (type, val, onch, extra = {}) => { const i = el("input", { type, value: val ?? "", class: "field", style: { width: "100%" }, ...extra }); i.addEventListener(type === "range" ? "input" : "change", () => onch(i.value)); return i; };
  const chk = (label, val, onch) => { const i = el("input", { type: "checkbox", checked: !!val }); i.addEventListener("change", () => onch(i.checked)); return el("label", { style: { display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px" } }, i, label); };
  const btn = (label, fn, cls = "btn") => el("button", { class: cls, type: "button", style: { marginRight: "6px", marginBottom: "6px" }, onclick: fn }, label);
  const h = t => el("b", { style: { display: "block", marginBottom: "8px" } }, t);
  const note = t => el("p", { class: "note", style: { margin: "0 0 8px" } }, t);
  // colore con casella "nessuno"
  function colorRow(label, val, onch) {
    const c = inp_("color", val || "#000000", v => onch(v));
    c.style.width = "54px";
    const none = el("input", { type: "checkbox", checked: !val });
    c.disabled = !val;
    none.addEventListener("change", () => { c.disabled = none.checked; onch(none.checked ? "" : c.value); });
    return row(label, el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, c, el("label", { style: { display: "flex", gap: "4px", alignItems: "center" } }, none, "nessuno")));
  }
  function textStyleControls(o) {
    return [
      row(tr("pdfeditor.carattere"), sel_(FONTS, o.font, v => (o.font = v))),
      row(tr("pdfeditor.dimensione_pt"), inp_("number", o.size, v => (o.size = +v), { min: 4, max: 200, step: 0.5 })),
      row(tr("common.colore"), inp_("color", o.color, v => (o.color = v))),
      chk(tr("pdfeditor.grassetto"), o.bold, v => (o.bold = v)), chk(tr("pdfeditor.corsivo"), o.italic, v => (o.italic = v)),
    ];
  }
  function renderPanel() {
    panel.innerHTML = "";
    const show = !!mode;
    panel.style.display = show ? "" : "none";
    if (!show) return;
    if (PJ[mode]) return panelPdfjs();
    if (mode === "typewriter") panel.append(h(tr("pdfeditor.macchina_scrivere")), note(tr("pdfeditor.clic_pagina_scrivi_invio_va")), ...textStyleControls(opt));
    else if (mode === "shape") panel.append(h(tr("pdfeditor.forme")), row(tr("pdfeditor.forma"), sel_(SHAPES, opt.shape, v => (opt.shape = v))), colorRow(tr("pdfeditor.bordo"), opt.stroke, v => (opt.stroke = v)),
      colorRow(tr("pdfeditor.riempimento"), opt.fill, v => (opt.fill = v)), row(tr("pdfeditor.spessore_pt"), inp_("number", opt.width, v => (opt.width = +v), { min: 0.25, max: 20, step: 0.25 })),
      chk(tr("pdfeditor.tratteggiato"), opt.dashed, v => (opt.dashed = v)), note(tr("pdfeditor.trascina_pagina_disegnare")));
    else if (FIELDS[mode]) panelField();
    else if (ANNOT_TOOLS[mode]) panel.append(h(ANNOT_TOOLS[mode]), colorRow(tr("common.colore"), opt.annotColor || (mode === "note" ? "#ffcc00" : mode === "underline" ? "#1565c0" : "#d32f2f"), v => (opt.annotColor = v)),
      note(mode === "note" ? tr("pdfeditor.clic_dove_mettere_nota_poi") : tr("pdfeditor.trascina_riquadro_sopra_parole_segnare")));
    else if (mode === "image") panel.append(h(tr("pdfeditor.immagine")), note(tr("pdfeditor.trascina_riquadro_fai_clic_dove")));
    else if (mode === "line") panel.append(h(tr("pdfeditor.testo")), note(tr("pdfeditor.clic_riga_scrivi_premi_invio")));
    else if (["redact", "whiteout", "crop", "link"].includes(mode)) panel.append(h({ redact: tr("pdfeditor.oscura"), whiteout: tr("pdfeditor.bianchetto"), crop: tr("pdfeditor.ritaglia_pagina"), link: tr("pdfeditor.collegamento") }[mode]),
      note({ redact: tr("pdfeditor.trascina_zona_eliminare_definitivamente_riquadro"), whiteout: tr("pdfeditor.trascina_zona_coprire_bianco_contenuto"), crop: tr("pdfeditor.trascina_riquadro_parte_pagina_tenere"), link: tr("pdfeditor.trascina_riquadro_cliccabile_poi_indica") }[mode]));
    else if (mode === "select") panelSelect();
  }
  function panelPdfjs() {
    const m = PJ[mode].mode;
    panel.append(h(PJ[mode].label));
    if (m === 9) panel.append(row(tr("common.colore"), inp_("color", opt.hlColor, v => { opt.hlColor = v; pjParam(32, v); pjParam(31, v); })),
      row(tr("pdfeditor.spessore_mano_libera"), inp_("range", opt.hlThick, v => { opt.hlThick = +v; pjParam(33, +v); }, { min: 8, max: 24 })),
      note(tr("pdfeditor.seleziona_testo_evidenziare_oppure_trascina")));
    if (m === 3) panel.append(row(tr("common.colore"), inp_("color", opt.ftColor, v => { opt.ftColor = v; pjParam(12, v); })),
      row(tr("pdfeditor.dimensione"), inp_("number", opt.ftSize, v => { opt.ftSize = +v; pjParam(11, +v); }, { min: 5, max: 100 })), note(tr("pdfeditor.clic_pagina_scrivi_riquadro_si")));
    if (m === 15) panel.append(row(tr("common.colore"), inp_("color", opt.inkColor, v => { opt.inkColor = v; pjParam(21, v); })),
      row(tr("pdfeditor.spessore"), inp_("range", opt.inkThick, v => { opt.inkThick = +v; pjParam(22, +v); }, { min: 1, max: 20 })),
      row(tr("pdfeditor.opacita"), inp_("range", Math.round(opt.inkOpacity * 100), v => { opt.inkOpacity = v / 100; pjParam(23, v / 100); }, { min: 5, max: 100 })), note(tr("pdfeditor.disegna_mano_libera_pagina")));
    panel.append(note(tr("pdfeditor.annotazioni_si_salvano_salva_restano")));
  }
  function panelField() {
    const [t, label, hint] = FIELDS[mode];
    const name = inp_("text", opt.fieldName, v => (opt.fieldName = v), { placeholder: `${fieldBase(t)}_${opt.fieldNo} (automatico)` });
    panel.append(h(label), note(hint), row(tr("pdfeditor.nome_prossimo_campo"), name));
    if (t === "radio") panel.append(row("Gruppo (stesso gruppo = scelta esclusiva)", inp_("text", opt.radioGroup || "opzioni", v => (opt.radioGroup = v))));
    if (t === "combo" || t === "list") { const ta = el("textarea", { rows: 6, class: "field", style: { width: "100%" } }, opt.fieldOptions); ta.addEventListener("input", () => (opt.fieldOptions = ta.value)); panel.append(row(tr("pdfeditor.voci_riga"), ta)); }
    if (t === "text" || t === "multiline" || t === "combo") panel.append(row(tr("pdfeditor.dimensione_testo_0_automatica"), inp_("number", opt.fieldFont, v => (opt.fieldFont = +v), { min: 0, max: 72 })));
    if (t !== "signature") panel.append(chk(tr("pdfeditor.obbligatorio"), opt.fieldRequired, v => (opt.fieldRequired = v)));
    panel.append(note(tr("pdfeditor.trascina_riquadro_fai_clic_dove_2")),
      note(tr("pdfeditor.sono_campi_modulo_pdf_standard")));
  }
  function panelSelect() {
    if (inGroup) panel.append(el("div", { style: { background: "var(--accent-soft)", padding: "6px 8px", borderRadius: "5px", marginBottom: "10px" } }, tr("pdfeditor.dentro_gruppo_selezioni_i_singoli"), btn(tr("pdfeditor.esci_gruppo"), () => { inGroup = null; setSel([]); decorateAll(); })));
    if (!sel.length) {
      panel.append(h(tr("pdfeditor.seleziona")), note(tr("pdfeditor.clic_oggetto_selezionarlo_maiusc_ctrl")));
      if (!inGroup) {
        panel.append(el("span", { class: "note" }, tr("pdfeditor.oggetti_selezionabili")));
        for (const [k, l] of Object.entries(KIND_NAMES)) panel.append(chk(l, opt.filter[k], v => { opt.filter[k] = v; decorateAll(); }));
      }
      return;
    }
    if (sel.length > 1) {
      panel.append(h(tr("pdfeditor.0_oggetti_selezionati", sel.length)), note(tr("pdfeditor.trascina_essi_spostarli_tutti_insieme")), btn(tr("pdfeditor.elimina_tutti"), deleteSel, "btn danger"));
      const groups = sel.filter(s => s.o.kind === "group" || s.o.kind === "drawing");
      if (groups.length === sel.length) panel.append(...drawStyle(null));
      return;
    }
    const { o, pno } = sel[0];
    const del = btn(tr("common.elimina"), deleteSel, "btn danger");
    if (o.kind === "text") {
      const ta = el("textarea", { rows: 7, class: "field", style: { width: "100%", fontFamily: cssFont(o.font) } }, o.text);
      const st = { font: FONTS.find(f => o.font.toLowerCase().includes(f.split(" ")[0].toLowerCase())) || "Helvetica", size: o.size, color: o.color || "#000000", bold: o.bold, italic: o.italic, align: 0 };
      panel.append(h(tr("pdfeditor.blocco_testo")), row(tr("pdfeditor.testo"), ta), ...textStyleControls(st), row(tr("pdfeditor.allineamento"), sel_([[0, tr("pdfeditor.sinistra")], [1, tr("pdfeditor.centro")], [2, tr("pdfeditor.destra")], [3, tr("pdfeditor.giustificato")]], 0, v => (st.align = +v))),
        el("div", {}, btn(tr("common.applica"), () => ops([{ kind: "text_block", page: pno, box: o.box, text: ta.value, ...st }]), "btn primary"), del));
    } else if (o.kind === "image") panelImage(sel[0], del);
    else if (o.kind === "group" || o.kind === "drawing") {
      panel.append(h(o.kind === "group" ? tr("pdfeditor.gruppo_disegni_0_tracciati", o.n) : tr("pdfeditor.tracciato")), ...drawStyle(o), el("div", {}, del));
      if (o.kind === "group") panel.append(btn(tr("pdfeditor.entra_gruppo"), () => { inGroup = { pno, box: o.box }; setSel([]); decorateAll(); }));
    } else if (o.kind === "annot") {
      const p = {};
      const ta = el("textarea", { rows: 4, class: "field", style: { width: "100%" } }, o.contents || "");
      panel.append(h(tr("pdfeditor.annotazione_2") + o.type), colorRow(tr("common.colore"), o.stroke, v => (p.stroke = v)));
      if (["Square", "Circle", "FreeText", "Polygon"].includes(o.type)) panel.append(colorRow(tr("pdfeditor.riempimento"), o.fill, v => (p.fill = v)));
      panel.append(row(tr("pdfeditor.opacita"), inp_("range", Math.round((o.opacity ?? 1) * 100), v => (p.opacity = v / 100), { min: 5, max: 100 })),
        row(tr("pdfeditor.spessore"), inp_("number", o.width || 1, v => (p.width = +v), { min: 0, max: 20, step: 0.5 })), row(tr("pdfeditor.contenuto_commento"), ta),
        el("div", {}, btn(tr("common.applica"), () => { p.contents = ta.value; return ops([{ kind: "annot_update", page: pno, xref: o.xref, props: p }]); }, "btn primary"), del));
    } else if (o.kind === "field") {
      const p = { name: o.name, tooltip: o.tooltip, value: o.value, fontsize: o.fontsize, required: o.required, readonly: o.readonly, multiline: o.multiline };
      const optsTa = el("textarea", { rows: 6, class: "field", style: { width: "100%" } }, (o.options || []).join("\n"));
      const tname = Object.values(FIELDS).find(f => f[0] === o.type || (o.type === "text" && o.multiline && f[0] === "multiline"))?.[1] || o.label;
      panel.append(h(tr("pdfeditor.campo_modulo_2") + tname), row(tr("common.nome"), inp_("text", o.name, v => (p.name = v))), row(tr("pdfeditor.descrizione_aiuto"), inp_("text", o.tooltip, v => (p.tooltip = v))),
        o.type === "combo" || o.type === "list" ? row(tr("pdfeditor.voci_riga"), optsTa) : "",
        o.type !== "check" && o.type !== "radio" && o.type !== "signature" ? row(tr("pdfeditor.valore"), inp_("text", o.value, v => (p.value = v))) : "",
        o.type === "text" || o.type === "combo" ? row(tr("pdfeditor.dimensione_testo_0_automatica_2"), inp_("number", o.fontsize, v => (p.fontsize = +v), { min: 0, max: 72 })) : "",
        chk(tr("pdfeditor.obbligatorio"), o.required, v => (p.required = v)), chk(tr("pdfeditor.sola_lettura"), o.readonly, v => (p.readonly = v)), o.type === "text" ? chk(tr("pdfeditor.piu_righe"), o.multiline, v => (p.multiline = v)) : "",
        el("div", {}, btn(tr("common.applica"), () => { if (o.type === "combo" || o.type === "list") p.options = optsTa.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean); return ops([{ kind: "field_update", page: pno, xref: o.xref, props: p }]); }, "btn primary"), del));
    } else if (o.kind === "link") panel.append(h(tr("pdfeditor.collegamento")), el("p", {}, o.uri || tr("pdfeditor.pagina_0", (o.page ?? 0) + 1)), del);
  }
  // aspetto di gruppi e tracciati (o = null: tutti quelli selezionati)
  function drawStyle(o) {
    const st = {};
    const apply = () => {
      const list = sel.filter(s => s.o.kind === "group" || s.o.kind === "drawing").map(s => s.o.kind === "group"
        ? { kind: "draw_edit", page: s.pno, box: s.o.box, style: st } : { kind: "draw_edit", page: s.pno, box: s.o.box, targets: [s.o.seqno], style: st });
      return Object.keys(st).length ? ops(list) : toast(tr("pdfeditor.nessuna_modifica_impostata"));
    };
    return [
      colorRow(tr("pdfeditor.bordo") + (o?.kind === "group" ? tr("pdfeditor.tutto_gruppo") : ""), o?.stroke ?? "#000000", v => (st.stroke = v)),
      colorRow(tr("pdfeditor.riempimento"), o?.fill ?? "", v => (st.fill = v)),
      row(tr("pdfeditor.spessore_pt"), inp_("number", o?.width || 1, v => (st.width = +v), { min: 0, max: 30, step: 0.25 })),
      row(tr("pdfeditor.opacita"), inp_("range", Math.round((o?.opacity ?? 1) * 100), v => (st.opacity = v / 100), { min: 5, max: 100 })),
      chk(tr("pdfeditor.tratteggiato"), o?.dashed, v => (st.dashed = v)),
      el("div", {}, btn(tr("common.applica"), apply, "btn primary")),
    ];
  }
  // immagine: sostituisci, trasparenze (piu' colori, contagocce, anteprima), opacita', rotazione, specchio, b/n
  function panelImage(s, del) {
    const { o, pno } = s;
    const st = { transparent: [], tol: 12, opacity: 1, rotate: 0, flip_h: false, flip_v: false, gray: false };
    const chips = el("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "8px" } });
    const upd = () => {
      chips.innerHTML = "";
      st.transparent.forEach((c, i) => chips.append(el("span", { style: { display: "inline-flex", alignItems: "center", gap: "4px", border: "1px solid var(--line)", borderRadius: "12px", padding: "2px 6px 2px 2px" } },
        el("span", { style: { width: "16px", height: "16px", borderRadius: "50%", background: c, border: "1px solid #888" } }), c,
        el("button", { type: "button", class: "btn", style: { height: "18px", padding: "0 4px" }, title: tr("pdfeditor.togli"), onclick: () => { st.transparent.splice(i, 1); upd(); } }, "×"))));
      if (!st.transparent.length) chips.append(el("span", { class: "note" }, tr("pdfeditor.nessun_colore_trasparente")));
      if (st.transparent.length || st.opacity < 1 || st.gray) showPreview(s, st); else clearPreview();
    };
    const add = c => { if (c && !st.transparent.includes(c)) st.transparent.push(c); upd(); };
    const manual = inp_("color", "#ffffff", () => {});
    manual.style.width = "54px";
    panel.append(h(tr("pdfeditor.immagine")), note(`${o.px?.[0] || "?"} × ${o.px?.[1] || "?"} pixel`),
      el("div", {}, btn(tr("pdfeditor.sostituisci"), async () => { const data = await pickImage(); if (data) await ops([{ kind: "image_replace", page: pno, xref: o.xref, box: o.box, data }]); }), del),
      el("hr", { style: { border: 0, borderTop: "1px solid var(--line)", margin: "10px 0" } }),
      el("b", { style: { display: "block", marginBottom: "6px" } }, tr("pdfeditor.colori_trasparenti")), chips,
      el("div", { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginBottom: "8px" } },
        btn(tr("pdfeditor.preleva_dall_immagine"), () => { picker = add; toast(tr("pdfeditor.clic_colore_rendere_trasparente")); }),
        manual, btn(tr("common.aggiungi"), () => add(manual.value))),
      row(tr("pdfeditor.tolleranza_colori_simili"), inp_("range", st.tol, v => { st.tol = +v; upd(); }, { min: 0, max: 60 })),
      row(tr("pdfeditor.opacita_dell_immagine"), inp_("range", 100, v => { st.opacity = v / 100; upd(); }, { min: 5, max: 100 })),
      el("div", {}, btn(tr("pdfeditor.ruota_90"), () => { st.rotate = (st.rotate + 90) % 360; toast(tr("pdfeditor.rotazione_impostata_0", st.rotate)); }),
        btn("Specchia ↔", () => { st.flip_h = !st.flip_h; toast(st.flip_h ? tr("pdfeditor.specchio_orizzontale_attivo") : tr("pdfeditor.specchio_orizzontale_tolto")); }),
        btn("Specchia ↕", () => { st.flip_v = !st.flip_v; toast(st.flip_v ? tr("pdfeditor.specchio_verticale_attivo") : tr("pdfeditor.specchio_verticale_tolto")); })),
      chk(tr("pdfeditor.bianco_nero"), false, v => { st.gray = v; upd(); }),
      note(tr("pdfeditor.l_anteprima_scacchi_mostra_parti")),
      el("div", {}, btn(tr("common.applica"), () => ops([{ kind: "image_edit", page: pno, xref: o.xref, box: o.box, ...st }]), "btn primary")));
    upd();
  }

  // ---------------------------------------------------------------- barra degli strumenti (sempre visibile)
  const btns = {};
  const tool = (k, label, title) => {
    const b = el("button", { type: "button", title, onclick: () => setMode(mode === k ? null : k) });
    b.insertAdjacentHTML("beforeend", svg(FIELDS[k] ? k : { "pj-highlight": "highlight", "pj-freetext": "freetext", "pj-ink": "ink" }[k] || k));
    b.append(label);
    return (btns[k] = b);
  };
  const grp = (title, ...items) => el("span", { style: { display: "inline-flex", alignItems: "center", gap: "2px", flexWrap: "wrap" } },
    el("span", { class: "note", style: { padding: "0 4px 0 2px", fontSize: "10.5px", textTransform: "uppercase", letterSpacing: ".04em" } }, title), ...items);
  const pageMenu = el("select", { class: "field", title: tr("pdfeditor.operazioni_pagina_corrente"), onchange: async e => { const v = e.target.value; e.target.value = ""; if (v) await pageOp(v); } },
    el("option", { value: "" }, tr("pdfeditor.pagina")), el("option", { value: "rotate" }, tr("pdfeditor.ruota_90_2")), el("option", { value: "dup" }, tr("pdfeditor.duplica")), el("option", { value: "blank" }, tr("pdfeditor.inserisci_pagina_bianca_dopo")),
    el("option", { value: "insert" }, tr("pdfeditor.inserisci_pdf_dopo_questa_pagina")), el("option", { value: "move" }, tr("pdfeditor.sposta_altra_posizione")), el("option", { value: "crop" }, tr("pdfeditor.ritaglia_2")), el("option", { value: "delete" }, tr("pdfeditor.elimina_pagina")));
  const docMenu = el("select", { class: "field", title: tr("pdfeditor.operazioni_documento"), onchange: async e => { const v = e.target.value; e.target.value = ""; if (v) await docOp(v); } },
    el("option", { value: "" }, tr("pdfeditor.documento")), el("option", { value: "meta" }, tr("pdfeditor.proprieta_titolo_autore")), el("option", { value: "toc" }, tr("pdfeditor.segnalibri")), el("option", { value: "flatten" }, tr("pdfeditor.appiattisci_moduli_annotazioni")));
  const iconBtn = (k, title, fn) => { const b = el("button", { type: "button", title, onclick: fn }); b.insertAdjacentHTML("beforeend", svg(k)); b.classList.add("icon"); return b; };
  const sep = () => el("span", { class: "sep" });
  const bar = el("div", { class: "tb", style: { display: "flex", flexWrap: "wrap", gap: "2px 4px", borderTop: "1px solid var(--line)" } },
    tool("select", tr("pdfeditor.seleziona"), tr("pdfeditor.seleziona_sposta_ridimensiona_modifica_ed")), sep(),
    grp(tr("pdfeditor.annota"), tool("pj-highlight", tr("pdfeditor.evidenzia"), tr("pdfeditor.evidenzia_testo")), tool("pj-freetext", tr("pdfeditor.testo_libero"), tr("pdfeditor.casella_testo_sopra_pagina")), tool("pj-ink", tr("pdfeditor.penna"), tr("pdfeditor.disegno_mano_libera")),
      tool("underline", tr("pdfeditor.sottolinea"), tr("pdfeditor.sottolinea_parole_riquadro")), tool("strikeout", tr("pdfeditor.barra"), tr("pdfeditor.barra_parole_riquadro")), tool("note", tr("pdfeditor.nota"), tr("pdfeditor.nota_adesiva"))), sep(),
    grp(tr("pdfeditor.modifica"), tool("line", tr("pdfeditor.testo"), tr("pdfeditor.riscrive_riga_testo_stesso_carattere")), tool("typewriter", tr("pdfeditor.macchina_scrivere"), tr("pdfeditor.scrivi_qualsiasi_punto_pagina")),
      tool("image", tr("pdfeditor.immagine"), tr("pdfeditor.inserisci_immagine")), tool("shape", tr("pdfeditor.forme"), tr("pdfeditor.rettangoli_ellissi_linee_frecce"))), sep(),
    grp(tr("pdfeditor.moduli"), ...Object.entries(FIELDS).map(([k, [, label, hint]]) => tool(k, label, label + ": " + hint))), sep(),
    grp(tr("pdfeditor.altro"), tool("link", tr("pdfeditor.collegamento"), tr("pdfeditor.area_cliccabile_verso_sito_pagina")), tool("whiteout", tr("pdfeditor.bianchetto"), tr("pdfeditor.copre_bianco_zona")), tool("redact", tr("pdfeditor.oscura"), tr("pdfeditor.elimina_definitivamente_zona_riquadro_nero"))), sep(),
    iconBtn("undo", tr("pdfeditor.annulla_l_ultima_modifica_ctrl"), () => undoLast()), iconBtn("redo", tr("pdfeditor.ripeti_ctrl_y"), () => redoLast()), sep(), pageMenu, docMenu);

  async function pageOp(v) {
    const p = curPage(), n = app()?.pagesCount || 1;
    if (v === "rotate") return ops([{ kind: "page_rotate", page: p, angle: 90 }]);
    if (v === "dup") return ops([{ kind: "page_duplicate", page: p }]);
    if (v === "blank") return ops([{ kind: "page_blank", at: p + 1 }]);
    if (v === "delete") { if (n < 2) return toast(tr("pdfeditor.documento_ha_sola_pagina"), true); if (await confirmBox(tr("pdfeditor.elimina_pagina"), tr("pdfeditor.eliminare_pagina_0", p + 1), tr("common.elimina"), true)) return ops([{ kind: "page_delete", page: p }]); return; }
    if (v === "move") { const s = await askText(tr("pdfeditor.sposta_pagina"), tr("pdfeditor.nuova_posizione_pagina_0_1", p + 1, n), String(n)); const to = parseInt(s, 10); if (to >= 1 && to <= n) return ops([{ kind: "page_move", page: p, to_page: to > p + 1 ? to : to - 1 }]); return; }
    if (v === "insert") { const fs = await pickFiles(); const f = fs?.find(x => /\.pdf$/i.test(x)); if (f) return ops([{ kind: "page_insert_pdf", file: f, at: p + 1 }]); return; }
    if (v === "crop") return setMode("crop");
  }
  async function docOp(v) {
    try { await pageData(0); } catch { /* */ }
    if (v === "meta") {
      const f = {};
      const rows = ["title", "author", "subject", "keywords"].map(k => row({ title: tr("pdfeditor.titolo"), author: tr("pdfeditor.autore"), subject: tr("pdfeditor.oggetto"), keywords: tr("pdfeditor.parole_chiave") }[k], (f[k] = el("input", { type: "text", class: "field", value: meta[k] || "", style: { width: "100%" } }))));
      if (await modal(tr("pdfeditor.proprieta_documento"), el("div", { style: { minWidth: "360px" } }, ...rows), [{ label: tr("common.annulla"), value: false }, { label: tr("common.salva"), value: true, primary: true }]))
        return ops([{ kind: "metadata", ...Object.fromEntries(Object.entries(f).map(([k, i]) => [k, i.value])) }]);
      return;
    }
    if (v === "toc") {
      const ta = el("textarea", { rows: 14, class: "field", style: { width: "100%", fontFamily: "Consolas, monospace" } }, toc.map(([l, t, p]) => "  ".repeat(l - 1) + `${t} | ${p}`).join("\n"));
      if (!(await modal(tr("pdfeditor.segnalibri"), el("div", { style: { minWidth: "420px", display: "grid", gap: "6px" } }, el("p", { class: "note", style: { margin: 0 } }, tr("pdfeditor.riga_segnalibro_titolo_pagina_rientra")), ta),
        [{ label: tr("common.annulla"), value: false }, { label: tr("common.salva"), value: true, primary: true }]))) return;
      const items = ta.value.split(/\r?\n/).filter(s => s.trim()).map(s => { const lvl = Math.floor((s.match(/^ */)[0].length) / 2) + 1; const [t, p] = s.trim().split("|").map(x => x.trim()); return [lvl, t, parseInt(p, 10) || 1]; });
      return ops([{ kind: "toc", items }]);
    }
    if (v === "flatten" && await confirmBox(tr("pdfeditor.appiattisci"), tr("pdfeditor.appiattire_moduli_annotazioni_diventano_parte"))) return ops([{ kind: "flatten" }]);
  }

  function decorateAll() {
    const a = app();
    if (!a?.pdfViewer) return;
    clearLayers();
    if (!mode || PJ[mode]) return;
    for (let i = 0; i < a.pagesCount; i++) { const pv = a.pdfViewer.getPageView(i); if (pv?.div && pv.viewport) decoratePage(pv); }
  }
  let hooked = false;
  function hook() {
    if (hooked || !app()) return;
    hooked = true;
    app().eventBus.on("pagerendered", e => { if (mode && !PJ[mode]) decoratePage(app().pdfViewer.getPageView(e.pageNumber - 1)); });
    doc().addEventListener("keydown", e => {
      if (e.target.closest?.("textarea, input, [contenteditable=plaintext-only], .freeTextEditor, .annotationEditorLayer [contenteditable]")) return;
      const k = e.key.toLowerCase();
      // tasti di Acrobat (strumenti a lettera singola, frecce per spostare gli oggetti selezionati)
      if (!e.ctrlKey && !e.altKey && !e.metaKey) {
        const ACC = { v: "select", t: "line", w: "typewriter", i: "image", s: "note", d: "pj-ink", r: "shape", q: "f-text", h: null };
        if (k === "u") { e.preventDefault(); const cyc = ["pj-highlight", "underline", "strikeout"]; setMode(e.shiftKey ? cyc[(cyc.indexOf(mode) + 1) % 3] : "pj-highlight"); return; }
        if (k in ACC && !e.shiftKey) { e.preventDefault(); setMode(ACC[k]); return; }
        const arrow = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, 1], arrowdown: [0, -1] }[k];
        if (arrow && mode === "select" && sel.length) { e.preventDefault(); nudge(arrow[0] * (e.shiftKey ? 10 : 1), arrow[1] * (e.shiftKey ? 10 : 1)); return; }
      }
      if (e.ctrlKey && k === "a" && mode === "select") { e.preventDefault(); const layer = doc().querySelector(`.page[data-page-number="${curPage() + 1}"] .mbv-layer`); if (layer) setSel([...layer.querySelectorAll(".mbv-obj")].map(n => ({ pno: curPage(), o: n._obj, d: n, vp: app().pdfViewer.getPageView(curPage()).viewport }))); return; }
      if (e.ctrlKey && k === "z" && work) { e.preventDefault(); undoLast(); return; }
      if (e.ctrlKey && k === "y" && work) { e.preventDefault(); redoLast(); return; }
      if (mode === "select" && sel.length && e.key === "Delete") { e.preventDefault(); deleteSel(); return; }
      if (e.key === "Escape" && mode) {
        if (picker) { picker = null; return; }
        if (mode === "select" && sel.length) { setSel([]); return; }
        if (mode === "select" && inGroup) { inGroup = null; decorateAll(); renderPanel(); return; }
        setMode(null);
      }
    }, true);
  }
  // spostamento con le frecce: i riquadri si muovono subito, la modifica si applica quando si smette di premere
  let nudgeAcc = [0, 0], nudgeTimer = 0;
  function nudge(dx, dy) {
    nudgeAcc = [nudgeAcc[0] + dx, nudgeAcc[1] + dy];
    for (const s of sel) if (s.d) { const k = s.vp.scale; s.d.style.left = parseFloat(s.d.style.left) + dx * k + "px"; s.d.style.top = parseFloat(s.d.style.top) - dy * k + "px"; }
    doc().querySelectorAll(".mbv-h").forEach(n => n.remove());
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => {
      const [ax, ay] = nudgeAcc;
      nudgeAcc = [0, 0];
      const list = sel.flatMap(s => moveOps(s.pno, s.o, [s.o.box[0] + ax, s.o.box[1] + ay, s.o.box[2] + ax, s.o.box[3] + ay]));
      if (list.length) ops(list);
    }, 500);
  }
  function setMode(m) {
    hook();
    injectCss();
    const wasPj = PJ[mode];
    mode = m;
    sel = []; inGroup = null; picker = null; clearPreview();
    for (const [k, b] of Object.entries(btns)) b.classList.toggle("on", k === mode);
    if (PJ[mode]) pjMode(PJ[mode].mode);
    else if (wasPj || mode) pjMode(0);
    decorateAll();
    renderPanel();
    ctx.status(mode ? tr("pdfeditor.modifica_0_esc_clic_pulsante", btns[mode]?.textContent || mode) : "");
    return mode;
  }

  const KEYS = [["V", tr("pdfeditor.seleziona_oggetti"), tr("pdfeditor.strumenti")], ["T", tr("pdfeditor.modifica_testo_riga"), tr("pdfeditor.strumenti")], ["W", tr("pdfeditor.macchina_scrivere"), tr("pdfeditor.strumenti")], ["I", tr("pdfeditor.inserisci_immagine_2"), tr("pdfeditor.strumenti")],
    ["U", tr("pdfeditor.evidenzia_maiusc_u_evidenzia_sottolinea"), tr("pdfeditor.strumenti")], ["S", tr("pdfeditor.nota_adesiva"), tr("pdfeditor.strumenti")], ["D", tr("pdfeditor.penna_disegno"), tr("pdfeditor.strumenti")], ["R", tr("pdfeditor.forme"), tr("pdfeditor.strumenti")],
    ["Q", tr("pdfeditor.campo_testo_modulo"), tr("pdfeditor.strumenti")], ["H", tr("pdfeditor.nessuno_strumento_scorri_compila_i"), tr("pdfeditor.strumenti")], ["Esc", tr("pdfeditor.deseleziona_esci_dallo_strumento"), tr("pdfeditor.strumenti")],
    ["Frecce", tr("pdfeditor.sposta_oggetti_selezionati_1_pt"), tr("pdfeditor.oggetti")], ["Canc", tr("pdfeditor.elimina_oggetti_selezionati"), tr("pdfeditor.oggetti")],
    ["Ctrl+A", tr("pdfeditor.seleziona_tutti_oggetti_pagina"), tr("pdfeditor.oggetti")], ["Maiusc+clic / Ctrl+clic", tr("pdfeditor.aggiungi_togli_selezione"), tr("pdfeditor.oggetti")],
    ["Doppio clic", tr("pdfeditor.riscrivi_testo_entra_gruppo_disegni"), tr("pdfeditor.oggetti")], ["Ctrl+Z / Ctrl+Y", tr("pdfeditor.annulla_ripeti"), tr("pdfeditor.modifica")], ["Ctrl+S", tr("common.salva"), tr("pdfeditor.modifica")]];
  return {
    bar, panel,
    keys: KEYS,
    attach() { hook(); injectCss(); },
    get mode() { return mode; },
    setMode, undoLast,
    escape() { if (!mode) return false; setMode(null); return true; },
    hasUndo: () => undo.length > 0,
    async currentFile() { if (work) await flushAnnotations(); return work || ctx.path; },
  };
}
