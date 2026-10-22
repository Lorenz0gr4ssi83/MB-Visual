// Editor PDF in stile Acrobat Pro sopra il visualizzatore pdf.js (motore PyMuPDF: mbvisual/pdfobjects.py e pdfdoc.py).
// Una sola riga di comandi raggruppati per tipo (pdfedbar.js), pannello delle proprieta' a destra con sezioni
// richiudibili (pdfedpanel.js), organizzazione delle pagine (pdfpages.js), operazioni sul documento (pdfdocs.js),
// elenco dei commenti (pdfcomments.js), selettore colori (colorpick.js).
// Qui: stato, coda delle modifiche con Annulla/Ripeti, strati disegnati sopra le pagine di pdf.js, strumenti, selezione
// (maniglie, rotazione, guide di allineamento, selezione multipla e a riquadro), copia/incolla tra pagine, gruppi, tasti.
// Ogni modifica scrive un FILE NUOVO nella cartella di lavoro: l'originale cambia solo con Salva.
import { t as tr } from "./i18n.js";
import { api, el, fileUrl, toast } from "./core.js";
import { pdfIcon } from "./pdfedicons.js";

// i pulsanti di pdf.js per le annotazioni e la sua barra si nascondono: li sostituisce la riga di comandi dell'editor
export const PDFJS_HIDE = "#editorModeButtons, #editorModeSeparator { display: none !important; }";
export const PDFJS_CHROME = `#toolbarContainer, #secondaryToolbar, #findbar { display: none !important; }
  html:root { --toolbar-height: 0px !important; }
  #viewerContainer, #sidebarContainer { inset-block-start: 0 !important; top: 0 !important; }
  #toolbarSidebar { height: 34px !important; }
  #sidebarContent { inset-block-start: 34px !important; }`;

export const FONTS = ["Helvetica", "Arial", "Calibri", "Cambria", "Times New Roman", "Garamond", "Palatino Linotype", "Century Gothic", "Trebuchet MS", "Verdana", "Georgia", "Tahoma", "Segoe UI", "Courier New", "Consolas"];
export const cssFont = f => (/times|serif|roman|cambria|georgia|garamond|book/i.test(f) ? `"${f}", "Times New Roman", serif` : /cour|mono|consol/i.test(f) ? '"Courier New", monospace' : `"${f}", Arial, sans-serif`);
export const MM = 25.4 / 72;

// strumenti: id -> icona, nome (chiave), tasto (come Acrobat dove esiste), gruppo
export const TOOLS = {
  select: { icon: "select", key: "V", name: "pdfed.t_seleziona" },
  hand: { icon: "hand", key: "H", name: "pdfed.t_mano" },
  edittext: { icon: "editText", key: "T", name: "pdfed.t_modifica_testo" },
  addtext: { icon: "addText", key: "W", name: "pdfed.t_aggiungi_testo" },
  image: { icon: "image", key: "I", name: "pdfed.t_immagine" },
  shape: { icon: "shapes", key: "R", name: "pdfed.t_forme" },
  link: { icon: "link", key: "L", name: "pdfed.t_collegamento" },
  whiteout: { icon: "whiteout", name: "pdfed.t_bianchetto" },
  note: { icon: "note", key: "S", name: "pdfed.t_nota" },
  "pj-highlight": { icon: "highlight", key: "U", name: "pdfed.t_evidenzia", pj: 9 },
  underline: { icon: "underline", name: "pdfed.t_sottolinea" },
  strikeout: { icon: "strikeout", name: "pdfed.t_barra" },
  squiggly: { icon: "squiggly", name: "pdfed.t_ondulato" },
  freetext: { icon: "freetext", key: "X", name: "pdfed.t_casella_testo" },
  "pj-ink": { icon: "pen", key: "D", name: "pdfed.t_penna", pj: 15 },
  cshape: { icon: "cloud", key: "N", name: "pdfed.t_forme_commento" },
  stamp: { icon: "stamp", key: "K", name: "pdfed.t_timbro" },
  field: { icon: "form", key: "Q", name: "pdfed.t_campo" },
  crop: { icon: "crop", key: "C", name: "pdfed.t_ritaglia" },
  redact: { icon: "redact", key: "Y", name: "pdfed.t_oscura" },
};
export const SHAPES = { rect: "pdfed.f_rettangolo", rounded: "pdfed.f_arrotondato", ellipse: "pdfed.f_ellisse", line: "pdfed.f_linea", arrow: "pdfed.f_freccia" };
export const CSHAPES = { rect: "pdfed.f_rettangolo", ellipse: "pdfed.f_ellisse", line: "pdfed.f_linea", arrow: "pdfed.f_freccia", cloud: "pdfed.f_nuvola", polygon: "pdfed.f_poligono" };
export const FIELDS = { text: ["f-text", "pdfed.c_testo"], multiline: ["f-multiline", "pdfed.c_area_testo"], combo: ["f-combo", "pdfed.c_tendina"],
  list: ["f-list", "pdfed.c_elenco"], check: ["f-check", "pdfed.c_spunta"], radio: ["f-radio", "pdfed.c_opzione"], signature: ["f-signature", "pdfed.c_firma"] };
export const STAMPS = [["pdfed.s_approvato", "#2e7d32"], ["pdfed.s_non_approvato", "#c62828"], ["pdfed.s_bozza", "#1565c0"], ["pdfed.s_riservato", "#c62828"],
  ["pdfed.s_visto", "#2e7d32"], ["pdfed.s_ricevuto", "#1565c0"], ["pdfed.s_annullato", "#c62828"], ["pdfed.s_definitivo", "#2e7d32"], ["pdfed.s_per_informazione", "#6a1b9a"]];

const CSS = (acc, accSoft) => `
.mbv-layer { position: absolute; inset: 0; z-index: 30; }
.mbv-layer.ingroup { background: rgba(255,255,255,.4); }
.mbv-obj { position: absolute; outline: 1px solid transparent; outline-offset: 0; }
.mbv-obj:hover { outline: 1px solid ${acc}; background: ${accSoft}; }
.mbv-obj.k-text { outline: 1px dashed transparent; }
.mbv-layer.t-edittext .mbv-obj.k-text { outline: 1px dashed rgba(90,110,130,.45); }
.mbv-layer.t-edittext .mbv-obj.k-text:hover { outline: 1px solid ${acc}; background: ${accSoft}; }
.mbv-obj.k-field { outline: 1px dashed rgba(70,110,170,.55); background: rgba(70,110,170,.06); }
.mbv-obj.k-annot:hover { outline-color: #b0458f; }
.mbv-obj.sel { outline: 1.5px solid ${acc} !important; background: transparent !important; z-index: 3; }
.mbv-obj.grp { outline: 1px dashed ${acc} !important; }
.mbv-h { position: absolute; width: 8px; height: 8px; margin: -4px 0 0 -4px; background: #fff; border: 1.5px solid ${acc}; z-index: 6; border-radius: 1px; }
.mbv-rot { position: absolute; width: 10px; height: 10px; margin: -5px 0 0 -5px; background: #fff; border: 1.5px solid ${acc}; border-radius: 50%; z-index: 6; }
.mbv-rotl { position: absolute; width: 0; border-left: 1px solid ${acc}; z-index: 5; pointer-events: none; }
.mbv-ang { position: absolute; z-index: 8; background: #1b1e22; color: #fff; font: 600 11px/1 system-ui; padding: 3px 6px; border-radius: 4px; pointer-events: none; }
.mbv-guide { position: absolute; z-index: 7; pointer-events: none; background: #e0368c; }
.mbv-rect { position: absolute; border: 1px solid ${acc}; background: ${accSoft}; pointer-events: none; }
.mbv-rect.red { border-color: #c62828; background: rgba(198,40,40,.16); }
.mbv-ed { position: absolute; z-index: 9; background: rgba(255,255,255,.96); outline: 1.5px solid ${acc}; box-shadow: 0 6px 18px -6px rgba(0,0,0,.35);
  white-space: pre-wrap; overflow-wrap: break-word; margin: 0; padding: 0; border: 0; resize: none; overflow: hidden; }
.mbv-ed:focus { outline: 1.5px solid ${acc}; }
.mbv-prev { position: absolute; z-index: 6; pointer-events: none; outline: 1.5px solid ${acc};
  background: repeating-conic-gradient(#cfd4da 0% 25%, #fff 0% 50%) 50% / 12px 12px; }
.mbv-crop { position: absolute; z-index: 7; outline: 1.5px dashed ${acc}; box-shadow: 0 0 0 9999px rgba(10,12,16,.45); }
.mbv-flash { position: absolute; z-index: 8; pointer-events: none; outline: 2px solid ${acc}; background: ${accSoft}; animation: mbvflash 1.4s ease-out forwards; }
@keyframes mbvflash { 0%, 60% { opacity: 1; } 100% { opacity: 0; } }
.mbv-poly { position: absolute; inset: 0; pointer-events: none; z-index: 6; }
`;

export function createPdfEditor(ctx, frame, setBusy) {
  const E = {
    ctx, frame, mode: null, sel: [], inGroup: null, picker: null, busy: false,
    undo: [], redo: [], work: null, clip: [], groups: [], meta: { title: "", author: "", subject: "", keywords: "" }, toc: [],
    objCache: new Map(), editing: null, cropBox: null,
    opt: {
      font: "Helvetica", size: 11, color: "#000000", bold: false, italic: false, align: 0, lineheight: 1.2,
      shape: "rect", stroke: "#d32f2f", fill: "", width: 1.5, dash: "", opacity: 1,
      cshape: "cloud", cstroke: "#d32f2f", cfill: "", cwidth: 1.5,
      hlColor: "#fff066", hlThick: 12, inkColor: "#1e5bc6", inkThick: 2, inkOpacity: 1,
      annotColor: { underline: "#1565c0", strikeout: "#d32f2f", squiggly: "#d32f2f", note: "#ffcc00", freetext: "#1565c0" },
      ftSize: 11, ftFill: "#fffbe6", ftText: "#000000", noteIcon: "Comment",
      stamp: 0, stampCustom: "", stampColor: "#c62828", stampSub: true,
      field: "text", fieldNo: 1, fieldName: "", fieldOptions: "", fieldRequired: false, fieldFont: 0, radioGroup: "",
      cropAll: false,
      filter: { text: true, image: true, group: true, annot: true, field: true, link: true },
    },
    get author() { try { return localStorage.getItem("mbv-pdf-autore") || localStorage.getItem("mbv-bcf-autore") || ""; } catch { return ""; } },
    set author(v) { try { localStorage.setItem("mbv-pdf-autore", v); } catch { /* */ } },
  };
  const app = E.app = () => frame.contentWindow?.PDFViewerApplication;
  const doc = E.doc = () => frame.contentDocument;
  E.curPage = () => (app()?.page || 1) - 1;
  E.pages = () => app()?.pagesCount || 1;
  E.file = () => E.work || ctx.path;
  E.panel = el("aside", { class: "pe-panel", hidden: true });
  E.listeners = new Set(); // dopo ogni cambiamento di stato (strumento, selezione, pagina)
  E.reloaded = new Set(); // dopo ogni ricaricamento del documento (modifica, annulla, ripeti)
  E.changed = () => E.listeners.forEach(f => { try { f(); } catch (e) { console.error(e); } });

  // ---------------------------------------------------------------- copia di lavoro, coda delle modifiche, annulla/ripeti
  // ogni passo scrive un FILE NUOVO: il file mostrato da pdf.js puo' essere ancora aperto in lettura e su Windows
  // non si potrebbe sostituire (la modifica restava in un file temporaneo e sembrava non applicata)
  const nextCopy = async () => (await api("pdf_work", { path: E.work })).path;
  async function ensureWork() { if (!E.work) E.work = (await api("pdf_work", { path: ctx.path })).path; }
  async function flushAnnotations() {
    // annotazioni di pdf.js (evidenziazioni, penna, moduli compilati) scritte in una nuova copia
    const a = app();
    if (!a?.pdfDocument || !a.pdfDocument.annotationStorage.size) return;
    await ensureWork();
    const next = await nextCopy();
    await api("save", { path: next }, { body: await a.pdfDocument.saveDocument() });
    E.undo.push({ file: E.work, label: tr("pdfed.u_annotazioni") });
    E.work = next;
  }
  E.flush = flushAnnotations;
  async function reload(keep) {
    const a = app();
    const page = a.page, scale = a.pdfViewer.currentScaleValue, top = a.pdfViewer.container.scrollTop, left = a.pdfViewer.container.scrollLeft;
    E.objCache.clear();
    clearPreview();
    E.sel = [];
    E.pendingSel = keep || null;
    await a.open({ url: fileUrl(E.work) + "&v=" + Date.now() });
    await new Promise(res => a.eventBus.on("pagesinit", res, { once: true }));
    a.pdfViewer.currentScaleValue = scale;
    a.page = Math.min(page, a.pagesCount);
    a.pdfViewer.container.scrollTop = top;
    a.pdfViewer.container.scrollLeft = left;
    ctx.setDirty(true);
    if (TOOLS[E.mode]?.pj) pjMode(TOOLS[E.mode].pj);
    E.renderPanel();
    if (E.mode) setTimeout(decorateAll, 60);
    E.changed();
    E.reloaded.forEach(f => { try { f(); } catch (e) { console.error(e); } });
  }
  let queue = Promise.resolve();
  // route: API del motore; label: nome del passo per Annulla; keep: oggetti da riselezionare dopo il ricaricamento
  E.run = (route, payload, label, keep) => (queue = queue.then(async () => {
    E.busy = true;
    setBusy(true);
    ctx.status(tr("pdfed.applico_0", label || tr("pdfed.modifica")));
    try {
      await ensureWork();
      await flushAnnotations();
      const next = await nextCopy();
      const r = await api(route, { path: next }, { json: payload });
      E.undo.push({ file: E.work, label: label || tr("pdfed.modifica") });
      if (E.undo.length > 80) E.undo.shift();
      E.redo.length = 0;
      E.work = next;
      await reload(keep);
      ctx.status(tr("pdfed.fatto_0", label || tr("pdfed.modifica")));
      return r || true;
    } catch (e) {
      toast(tr("pdfed.modifica_non_riuscita") + e.message, true, 7000);
      ctx.status("");
      return false;
    } finally { E.busy = false; setBusy(false); }
  }));
  E.ops = (list, label, keep) => (list.length ? E.run("pdf_ops", { ops: list }, label, keep) : Promise.resolve(false));
  E.undoLast = () => (queue = queue.then(async () => {
    if (!E.undo.length) return toast(tr("pdfed.nessuna_modifica_annullare"));
    const u = E.undo.pop();
    E.redo.push({ file: E.work, label: u.label });
    E.work = u.file;
    await reload();
    ctx.status(tr("pdfed.annullato_0", u.label));
  }));
  E.redoLast = () => (queue = queue.then(async () => {
    if (!E.redo.length) return toast(tr("pdfed.niente_ripetere"));
    const r = E.redo.pop();
    E.undo.push({ file: E.work, label: r.label });
    E.work = r.file;
    await reload();
    ctx.status(tr("pdfed.ripetuto_0", r.label));
  }));
  E.currentFile = async () => { await flushAnnotations(); return E.file(); };

  // ---------------------------------------------------------------- strumenti di pdf.js (evidenzia, penna)
  function pjMode(m) {
    try { app()?.eventBus.dispatch("switchannotationeditormode", { source: null, mode: m }); } catch { /* */ }
    if (m === 9) { pjParam(32, E.opt.hlColor); pjParam(33, E.opt.hlThick); }
    if (m === 15) { pjParam(21, E.opt.inkColor); pjParam(22, E.opt.inkThick); pjParam(23, E.opt.inkOpacity); }
  }
  const pjParam = E.pjParam = (type, value) => { try { app()?.eventBus.dispatch("switchannotationeditorparams", { source: null, type, value }); } catch { /* */ } };

  // ---------------------------------------------------------------- coordinate e strati
  function injectCss() {
    const d = doc();
    if (!d || d.getElementById("mbv-edit-css")) return;
    const v = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    d.head.append(Object.assign(d.createElement("style"), { id: "mbv-edit-css", textContent: CSS(v("--accent") || "#f07d2e", "rgba(240,125,46,.10)") }));
  }
  const clearLayers = () => doc()?.querySelectorAll(".mbv-layer").forEach(n => n.remove());
  const rectToCss = E.rectToCss = (vp, box) => {
    const [x0, y0, x1, y1] = vp.convertToViewportRectangle(box);
    return { left: Math.min(x0, x1), top: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
  };
  const cssToPdf = E.cssToPdf = (vp, l, t, w, h) => {
    const [ax, ay] = vp.convertToPdfPoint(l, t), [bx, by] = vp.convertToPdfPoint(l + w, t + h);
    return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)].map(v => Math.round(v * 100) / 100);
  };
  const place = (node, r) => Object.assign(node.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
  const rectOf = d => ({ left: parseFloat(d.style.left), top: parseFloat(d.style.top), width: parseFloat(d.style.width), height: parseFloat(d.style.height) });
  E.pageView = pno => app()?.pdfViewer.getPageView(pno);
  // riquadro "come si vede" (punti, origine in alto a sinistra) <-> spazio PDF, indipendente dallo zoom
  E.visBox = (pno, box) => { const vp = E.pageView(pno).viewport.clone({ scale: 1 }); return rectToCss(vp, box); };
  E.fromVis = (pno, r) => cssToPdf(E.pageView(pno).viewport.clone({ scale: 1 }), r.left, r.top, r.width, r.height);
  function newLayer(pv) {
    pv.div.querySelectorAll(".mbv-layer").forEach(n => n.remove());
    const layer = doc().createElement("div");
    layer.className = "mbv-layer t-" + E.mode;
    pv.div.append(layer);
    return layer;
  }
  const local = (layer, e) => { const b = layer.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  // riquadro trascinato sulla pagina: onDone(boxPdf, p1Pdf, p2Pdf, rectCss); clickSize = riquadro (punti) per il clic singolo
  function dragLayer(pv, onDone, { red = false, clickSize = null } = {}) {
    const layer = newLayer(pv), vp = pv.viewport;
    let start = null, box = null;
    layer.addEventListener("pointerdown", e => {
      if (E.picker) return pickColor(pv, e);
      if (E.editing) return E.commitEditing();
      start = local(layer, e);
      box = doc().createElement("div");
      box.className = "mbv-rect" + (red ? " red" : "");
      layer.append(box);
      try { layer.setPointerCapture(e.pointerId); } catch { /* */ }
    });
    layer.addEventListener("pointermove", e => {
      if (!start) return;
      let [x, y] = local(layer, e);
      if (e.shiftKey) { const s = Math.max(Math.abs(x - start[0]), Math.abs(y - start[1])); x = start[0] + Math.sign(x - start[0] || 1) * s; y = start[1] + Math.sign(y - start[1] || 1) * s; }
      place(box, { left: Math.min(x, start[0]), top: Math.min(y, start[1]), width: Math.abs(x - start[0]), height: Math.abs(y - start[1]) });
    });
    layer.addEventListener("pointerup", async e => {
      if (!start) return;
      const [x, y] = local(layer, e);
      let r = rectOf(box);
      const s = start;
      start = null;
      if (!(r.width >= 4 || r.height >= 4)) {
        if (!clickSize) { box.remove(); return; }
        const k = vp.scale;
        r = { left: x, top: y, width: clickSize[0] * k, height: clickSize[1] * k };
        // dentro la pagina anche se si fa clic vicino al bordo
        r.left = Math.max(0, Math.min(layer.clientWidth - r.width, r.left));
        r.top = Math.max(0, Math.min(layer.clientHeight - r.height, r.top));
      }
      const p1 = vp.convertToPdfPoint(s[0], s[1]), p2 = vp.convertToPdfPoint(r.width >= 4 || r.height >= 4 ? x : s[0] + r.width, r.width >= 4 || r.height >= 4 ? y : s[1] + r.height);
      try { await onDone(cssToPdf(vp, r.left, r.top, r.width, r.height), p1, p2, r, layer); } finally { box?.remove(); }
    });
    return layer;
  }

  // ---------------------------------------------------------------- oggetti della pagina
  E.pageData = async pno => {
    let data = E.objCache.get(pno);
    if (!data) {
      data = api("pdf_objects", { path: E.file(), page: pno });
      E.objCache.set(pno, data);
      try { data = await data; } catch (e) { E.objCache.delete(pno); throw e; }
      E.objCache.set(pno, data);
      E.meta = data.metadata || E.meta;
      E.toc = data.toc || E.toc;
    }
    return data;
  };
  const describe = o => ({ image: tr("pdfed.o_immagine"), text: tr("pdfed.o_testo"), group: tr("pdfed.o_gruppo_0", o.n), drawing: tr("pdfed.o_tracciato"),
    field: tr("pdfed.o_campo_0", o.name || ""), link: tr("pdfed.o_collegamento"), annot: tr("pdfed.o_commento_0", o.type || "") }[o.kind] || o.kind);
  E.describe = describe;
  const sameObj = (a, b) => a === b || (a.kind === b.kind && (a.xref ? a.xref === b.xref && boxNear(a.box, b.box, 3) : a.seqno != null ? a.seqno === b.seqno : boxNear(a.box, b.box, 1.5)));
  const boxNear = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
  const center = b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  async function decorateObjects(pv, pno, vp) {
    let data;
    try { data = await E.pageData(pno); } catch (e) { return toast(e.message, true); }
    if (E.mode !== "select" && E.mode !== "edittext") return;
    if (!pv.div.isConnected) return;
    const layer = newLayer(pv);
    let list;
    if (E.mode === "edittext") list = data.oggetti.filter(o => o.kind === "text");
    else if (E.inGroup && E.inGroup.pno === pno) {
      // dentro un gruppo di disegni: i singoli tracciati (i piccoli sopra)
      layer.classList.add("ingroup");
      const [gx0, gy0, gx1, gy1] = E.inGroup.box;
      list = data.tracciati.filter(t => t.box[0] >= gx0 - 1 && t.box[1] >= gy0 - 1 && t.box[2] <= gx1 + 1 && t.box[3] <= gy1 + 1);
    } else {
      const order = { group: 0, image: 1, text: 2, annot: 3, link: 3, field: 4 };
      list = data.oggetti.filter(o => E.opt.filter[o.kind] !== false).sort((a, b) => (order[a.kind] ?? 0) - (order[b.kind] ?? 0));
    }
    // tra gli oggetti dello stesso tipo i grandi sotto, i piccoli sopra (si raggiungono anche se dentro uno grande)
    const area = o => (o.box[2] - o.box[0]) * (o.box[3] - o.box[1]);
    list = list.map((o, i) => [o, i]).sort((a, b) => (a[0].kind === b[0].kind ? area(b[0]) - area(a[0]) : a[1] - b[1])).map(x => x[0]);
    for (const o of list) layer.append(objNode(pv, pno, vp, o));
    restoreSel(pno, layer, vp);
    // tavole CAD con troppi tracciati per elencarli: si cercano a richiesta (clic su un tratto, riquadro di selezione)
    const heavy = data.troppi_disegni && E.mode === "select" && !E.inGroup && E.opt.filter.group !== false;
    // riquadro di selezione sullo sfondo; clic sul vuoto: deseleziona (o esce dal gruppo)
    let start = null, box = null;
    layer.addEventListener("pointerdown", e => {
      if (E.picker) return pickColor(pv, e);
      if (e.target !== layer) return;
      if (E.editing) { E.commitEditing(); return; }
      start = local(layer, e);
      box = doc().createElement("div");
      box.className = "mbv-rect";
      layer.append(box);
      try { layer.setPointerCapture(e.pointerId); } catch { /* */ }
    });
    layer.addEventListener("pointermove", e => {
      if (!start) return;
      const [x, y] = local(layer, e);
      place(box, { left: Math.min(x, start[0]), top: Math.min(y, start[1]), width: Math.abs(x - start[0]), height: Math.abs(y - start[1]) });
    });
    layer.addEventListener("pointerup", async e => {
      if (!start) return;
      const r = rectOf(box), s0 = start;
      box.remove();
      start = null;
      if (!(r.width >= 4 || r.height >= 4)) {
        if (E.inGroup) { E.exitGroup(); return; }
        if (heavy) { // tratto sotto il clic
          const res = await api("pdf_hit", { path: E.file() }, { json: { page: pno, point: vp.convertToPdfPoint(s0[0], s0[1]), tol: 3 / vp.scale + 1 } }).catch(() => null);
          const t = res?.tracciati?.[0];
          if (t) { const n = objNode(pv, pno, vp, t); layer.append(n); E.setSel([...(e.shiftKey ? E.sel : []), { pno, o: t, d: n, vp }]); return; }
        }
        if (!e.shiftKey) E.setSel([]);
        return;
      }
      // come Acrobat: entrano gli oggetti toccati dal riquadro (Alt = solo quelli contenuti per intero)
      const inside = [...layer.querySelectorAll(".mbv-obj")].filter(n => {
        const q = rectOf(n);
        return e.altKey ? q.left >= r.left && q.top >= r.top && q.left + q.width <= r.left + r.width && q.top + q.height <= r.top + r.height
          : q.left < r.left + r.width && q.left + q.width > r.left && q.top < r.top + r.height && q.top + q.height > r.top;
      });
      const list = inside.map(n => ({ pno, o: n._obj, d: n, vp }));
      if (heavy) { // i tracciati contenuti nel riquadro diventano un gruppo
        const res = await api("pdf_hit", { path: E.file() }, { json: { page: pno, box: cssToPdf(vp, r.left, r.top, r.width, r.height) } }).catch(() => null);
        if (res?.gruppo) { const n = objNode(pv, pno, vp, res.gruppo); layer.append(n); list.push({ pno, o: res.gruppo, d: n, vp }); }
      }
      E.setSel([...(e.shiftKey ? E.sel : []), ...list]);
    });
  }
  // riquadro di un oggetto sulla pagina (clic = seleziona e trascina, doppio clic = testo / entra nel gruppo)
  function objNode(pv, pno, vp, o) {
    const r = rectToCss(vp, o.box);
    if (r.width < 4) { r.left -= (4 - r.width) / 2; r.width = 4; }
    if (r.height < 4) { r.top -= (4 - r.height) / 2; r.height = 4; }
    const d = doc().createElement("div");
    d.className = "mbv-obj k-" + o.kind;
    d.title = describe(o);
    place(d, r);
    d._obj = o;
    d._pno = pno;
    d.addEventListener("pointerdown", e => {
      if (E.picker) return pickColor(pv, e);
      e.stopPropagation();
      if (E.editing) { if (E.editing.d === d) return; E.commitEditing(); }
      if (E.mode === "edittext") { E.setSel([{ pno, o, d, vp }]); editTextInline(d, o, pno, vp); return; }
      if (e.shiftKey || e.ctrlKey) { toggleSel(pno, o, d, vp); return; }
      if (!E.sel.some(s => s.o === o)) E.setSel(withGroup([{ pno, o, d, vp }]));
      startDrag(e, d, pno, vp, "move");
    });
    d.addEventListener("dblclick", e => {
      e.stopPropagation();
      if (o.kind === "text") editTextInline(d, o, pno, vp);
      else if (o.kind === "group") E.enterGroup(pno, o);
    });
    return d;
  }
  // dopo un ricaricamento la selezione si riaggancia ai nuovi riquadri (stesso tipo e centro vicino)
  function restoreSel(pno, layer, vp) {
    const nodes = [...layer.querySelectorAll(".mbv-obj")];
    if (E.pendingSel) {
      const want = E.pendingSel.filter(w => w.pno === pno);
      for (const w of want) {
        const [cx, cy] = center(w.box);
        const n = nodes.filter(x => x._obj.kind === w.kind).map(x => [x, Math.hypot(center(x._obj.box)[0] - cx, center(x._obj.box)[1] - cy)])
          .filter(x => x[1] < 4 + (w.tol || 0)).sort((a, b) => a[1] - b[1])[0]?.[0];
        if (n && !E.sel.some(s => s.d === n)) E.sel.push({ pno, o: n._obj, d: n, vp });
      }
      E.pendingSel = E.pendingSel.filter(w => w.pno !== pno);
      if (!E.pendingSel.length) E.pendingSel = null;
      if (want.length) E.renderPanel();
    }
    for (const s of E.sel) if (s.pno === pno) { const n = nodes.find(x => sameObj(x._obj, s.o)); if (n) { s.d = n; s.vp = vp; s.o = n._obj; } }
    paintSel();
  }
  E.setSel = list => { E.sel = list; clearPreview(); paintSel(); E.renderPanel(); E.changed(); };
  function toggleSel(pno, o, d, vp) {
    const i = E.sel.findIndex(s => s.o === o);
    if (i >= 0) E.sel.splice(i, 1); else E.sel.push(...withGroup([{ pno, o, d, vp }]).filter(x => !E.sel.some(s => s.o === x.o)));
    E.setSel([...E.sel]);
  }
  // gruppi creati con Ctrl+G: selezionando un membro si seleziona il gruppo intero
  function withGroup(list) {
    const out = [...list];
    for (const s of list) {
      const g = E.groups.find(g => g.pno === s.pno && g.members.some(m => m.kind === s.o.kind && boxNear(m.box, s.o.box, 2)));
      if (!g) continue;
      const nodes = [...(s.d?.parentNode?.querySelectorAll(".mbv-obj") || [])];
      for (const m of g.members) {
        const n = nodes.find(x => x._obj.kind === m.kind && boxNear(x._obj.box, m.box, 2));
        if (n && !out.some(x => x.d === n)) out.push({ pno: s.pno, o: n._obj, d: n, vp: s.vp });
      }
    }
    return out;
  }
  E.groupSel = () => {
    if (E.sel.length < 2) return toast(tr("pdfed.seleziona_almeno_due"));
    const pno = E.sel[0].pno;
    if (E.sel.some(s => s.pno !== pno)) return toast(tr("pdfed.gruppo_stessa_pagina"), true);
    E.groups = E.groups.filter(g => !(g.pno === pno && g.members.some(m => E.sel.some(s => s.o.kind === m.kind && boxNear(s.o.box, m.box, 2)))));
    E.groups.push({ pno, members: E.sel.map(s => ({ kind: s.o.kind, box: [...s.o.box] })) });
    paintSel();
    ctx.status(tr("pdfed.gruppo_creato_0", E.sel.length));
  };
  E.ungroupSel = () => {
    const before = E.groups.length;
    E.groups = E.groups.filter(g => !g.members.some(m => E.sel.some(s => s.pno === g.pno && s.o.kind === m.kind && boxNear(s.o.box, m.box, 2))));
    paintSel();
    if (before !== E.groups.length) ctx.status(tr("pdfed.gruppo_sciolto"));
  };
  // i gruppi seguono gli oggetti spostati
  function trackMoves(moves) {
    for (const { pno, kind, from, to } of moves) for (const g of E.groups) if (g.pno === pno) for (const m of g.members) if (m.kind === kind && boxNear(m.box, from, 2)) m.box = [...to];
  }
  E.inGroupOf = s => E.groups.some(g => g.pno === s.pno && g.members.some(m => m.kind === s.o.kind && boxNear(m.box, s.o.box, 2)));
  function paintSel() {
    const d0 = doc();
    if (!d0) return;
    d0.querySelectorAll(".mbv-obj.sel, .mbv-obj.grp").forEach(n => n.classList.remove("sel", "grp"));
    d0.querySelectorAll(".mbv-h, .mbv-rot, .mbv-rotl").forEach(n => n.remove());
    for (const s of E.sel) s.d?.classList.add("sel", ...(E.inGroupOf(s) ? ["grp"] : []));
    if (E.editing || E.mode !== "select") return;
    if (E.sel.length === 1 && E.sel[0].d?.parentNode && E.sel[0].o.kind !== "link") handles(E.sel[0]);
  }
  E.paintSel = paintSel;
  const ROTATABLE = new Set(["image", "group", "drawing", "text"]);
  function handles(s) {
    const { d, pno, vp, o } = s;
    const r = rectOf(d);
    const mk = (cls, x, y) => { const h = doc().createElement("div"); h.className = cls; Object.assign(h.style, { left: x + "px", top: y + "px" }); d.parentNode.append(h); return h; };
    const pos = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
    for (const [k, [fx, fy]] of Object.entries(pos)) {
      if (o.kind === "annot" && o.type === "Text" && k.length === 1) continue;
      const h = mk("mbv-h", r.left + r.width * fx, r.top + r.height * fy);
      h.addEventListener("pointerdown", e => { e.stopPropagation(); startDrag(e, d, pno, vp, k); });
    }
    if (ROTATABLE.has(o.kind)) {
      const line = mk("mbv-rotl", r.left + r.width / 2, r.top - 22);
      line.style.height = "22px";
      line.style.marginLeft = "0";
      const k = mk("mbv-rot", r.left + r.width / 2, r.top - 24);
      k.title = tr("pdfed.ruota_trascina");
      k.addEventListener("pointerdown", e => { e.stopPropagation(); startRotate(e, s); });
    }
  }
  // ---- guide di allineamento (bordi e centri degli altri oggetti e della pagina)
  function snapLines(layer, skip) {
    const xs = [], ys = [];
    const W = layer.clientWidth, H = layer.clientHeight;
    xs.push(0, W / 2, W); ys.push(0, H / 2, H);
    for (const n of layer.querySelectorAll(".mbv-obj")) {
      if (skip.has(n)) continue;
      const q = rectOf(n);
      if (q.width > W * 0.9 && q.height > H * 0.9) continue;
      xs.push(q.left, q.left + q.width / 2, q.left + q.width);
      ys.push(q.top, q.top + q.height / 2, q.top + q.height);
    }
    return { xs, ys };
  }
  function showGuides(layer, gx, gy) {
    layer.querySelectorAll(".mbv-guide").forEach(n => n.remove());
    const mk = (x, y, w, h) => { const g = doc().createElement("div"); g.className = "mbv-guide"; place(g, { left: x, top: y, width: w, height: h }); layer.append(g); };
    if (gx != null) mk(gx, 0, 1, layer.clientHeight);
    if (gy != null) mk(0, gy, layer.clientWidth, 1);
  }
  function startDrag(e, d, pno, vp, how) {
    const x0 = e.clientX, y0 = e.clientY;
    const moving = how === "move" ? E.sel.filter(s => s.d && s.pno === pno) : [{ d, pno, vp, o: d._obj }];
    const starts = moving.map(s => rectOf(s.d));
    const r0 = rectOf(d);
    const layer = d.parentNode;
    const lines = snapLines(layer, new Set(moving.map(s => s.d)));
    const bb = starts.reduce((a, q) => ({ l: Math.min(a.l, q.left), t: Math.min(a.t, q.top), r: Math.max(a.r, q.left + q.width), b: Math.max(a.b, q.top + q.height) }), { l: 1e9, t: 1e9, r: -1e9, b: -1e9 });
    let moved = false;
    const target = e.target;
    try { target.setPointerCapture(e.pointerId); } catch { /* */ }
    const keepRatio = d._obj.kind === "image";
    const mv = ev => {
      let dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      doc().querySelectorAll(".mbv-h, .mbv-rot, .mbv-rotl").forEach(n => n.remove());
      if (how === "move") {
        if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        let gx = null, gy = null;
        if (!ev.altKey) { // aggancio: 5 px
          const cand = [bb.l + dx, (bb.l + bb.r) / 2 + dx, bb.r + dx];
          let best = 6;
          for (const c of cand) for (const L of lines.xs) if (Math.abs(L - c) < best) { best = Math.abs(L - c); gx = L; dx += L - c; }
          const candY = [bb.t + dy, (bb.t + bb.b) / 2 + dy, bb.b + dy];
          best = 6;
          for (const c of candY) for (const L of lines.ys) if (Math.abs(L - c) < best) { best = Math.abs(L - c); gy = L; dy += L - c; }
        }
        showGuides(layer, gx, gy);
        moving.forEach((s, i) => place(s.d, { ...starts[i], left: starts[i].left + dx, top: starts[i].top + dy }));
      } else {
        const r = { ...r0 };
        if (how.includes("w")) { r.left += dx; r.width -= dx; }
        if (how.includes("e")) r.width += dx;
        if (how.includes("n")) { r.top += dy; r.height -= dy; }
        if (how.includes("s")) r.height += dy;
        if ((ev.shiftKey !== keepRatio) && how.length === 2 && r0.width && r0.height) { // proporzioni: immagini sempre (Maiusc le libera), altri con Maiusc
          const kw = r.width / r0.width, kh = r.height / r0.height, k = Math.abs(kw - 1) >= Math.abs(kh - 1) ? kw : kh;
          const nw = r0.width * k, nh = r0.height * k;
          if (how.includes("w")) r.left = r0.left + r0.width - nw;
          if (how.includes("n")) r.top = r0.top + r0.height - nh;
          r.width = nw; r.height = nh;
        }
        r.width = Math.max(3, r.width); r.height = Math.max(3, r.height);
        place(d, r);
      }
      showTip(ev, how === "move" ? null : rectOf(d));
    };
    const up = async () => {
      target.removeEventListener("pointermove", mv);
      target.removeEventListener("pointerup", up);
      layer.querySelectorAll(".mbv-guide").forEach(n => n.remove());
      hideTip();
      if (!moved) return paintSel();
      const list = [], keep = [], moves = [];
      for (const s of moving) {
        const q = rectOf(s.d);
        const to = cssToPdf(s.vp, q.left, q.top, q.width, q.height);
        list.push(...moveOps(s.pno, s.o, to));
        keep.push({ pno: s.pno, kind: s.o.kind, box: to });
        moves.push({ pno: s.pno, kind: s.o.kind, from: s.o.box, to });
      }
      trackMoves(moves);
      await E.ops(list, how === "move" ? tr("pdfed.u_sposta") : tr("pdfed.u_ridimensiona"), keep);
    };
    target.addEventListener("pointermove", mv);
    target.addEventListener("pointerup", up);
  }
  // misure durante il ridimensionamento (mm)
  let tip = null;
  function showTip(ev, r) {
    if (!r) return hideTip();
    if (!tip) { tip = doc().createElement("div"); tip.className = "mbv-ang"; doc().body.append(tip); }
    const k = E.pageView(E.curPage())?.viewport.scale || 1;
    tip.textContent = `${(r.width / k * MM).toFixed(1)} × ${(r.height / k * MM).toFixed(1)} mm`;
    Object.assign(tip.style, { position: "fixed", left: ev.clientX + 14 + "px", top: ev.clientY + 14 + "px" });
  }
  function hideTip() { tip?.remove(); tip = null; }
  function startRotate(e, s) {
    const r = rectOf(s.d), layer = s.d.parentNode;
    const lb = layer.getBoundingClientRect();
    const cx = lb.left + r.left + r.width / 2, cy = lb.top + r.top + r.height / 2;
    const a0 = Math.atan2(e.clientY - cy, e.clientX - cx);
    let ang = 0;
    const target = e.target;
    try { target.setPointerCapture(e.pointerId); } catch { /* */ }
    const label = doc().createElement("div");
    label.className = "mbv-ang";
    layer.append(label);
    const mv = ev => {
      ang = ((Math.atan2(ev.clientY - cy, ev.clientX - cx) - a0) * 180) / Math.PI;
      ang = ((ang + 540) % 360) - 180;
      if (ev.shiftKey) ang = Math.round(ang / 15) * 15; else if (Math.abs(ang - Math.round(ang / 90) * 90) < 3) ang = Math.round(ang / 90) * 90;
      s.d.style.transform = `rotate(${ang}deg)`;
      doc().querySelectorAll(".mbv-h").forEach(n => (n.style.display = "none"));
      label.textContent = `${Math.round(ang)}°`;
      Object.assign(label.style, { left: r.left + r.width / 2 + 12 + "px", top: r.top - 40 + "px" });
    };
    const up = async () => {
      target.removeEventListener("pointermove", mv);
      target.removeEventListener("pointerup", up);
      label.remove();
      s.d.style.transform = "";
      if (Math.abs(ang) < 0.5) return paintSel();
      await E.rotateSel(ang);
    };
    target.addEventListener("pointermove", mv);
    target.addEventListener("pointerup", up);
  }
  E.rotateSel = async ang => {
    const list = [], keep = [];
    for (const s of E.sel) {
      if (!ROTATABLE.has(s.o.kind)) continue;
      list.push(...moveOps(s.pno, s.o, null, ang));
      keep.push({ pno: s.pno, kind: s.o.kind, box: s.o.box, tol: Math.max(s.o.box[2] - s.o.box[0], s.o.box[3] - s.o.box[1]) / 2 });
    }
    return E.ops(list, tr("pdfed.u_ruota"), keep);
  };
  // operazioni per spostare / ridimensionare / ruotare un oggetto (to = nuovo riquadro o null, ang = gradi orari)
  function moveOps(pno, o, to, ang = 0) {
    const rot = ang ? { rotate_obj: ang } : {};
    const dest = to || o.box;
    if (o.kind === "image") return [{ kind: "image_move", page: pno, xref: o.xref, box: o.box, to: dest, ...rot }];
    if (o.kind === "group") return [{ kind: "draw_move", page: pno, box: o.box, to: dest, ...rot }];
    if (o.kind === "drawing") return [{ kind: "draw_edit", page: pno, box: E.inGroup?.box || o.box, targets: [o.seqno], to: dest === o.box ? null : shiftWithin(o, dest), ...rot }];
    if (o.kind === "field") return [{ kind: "field_update", page: pno, xref: o.xref, to: dest, props: {} }];
    if (o.kind === "annot") return [{ kind: "annot_update", page: pno, xref: o.xref, to: dest, props: {} }];
    if (o.kind === "link") return [{ kind: "link_delete", page: pno, box: o.box }, o.uri ? { kind: "link_add", page: pno, box: dest, uri: o.uri } : { kind: "link_add", page: pno, box: dest, target: (o.page ?? 0) + 1 }];
    if (o.kind === "text") return [{ kind: "text_block", page: pno, box: o.box, to: dest, text: o.text, font: o.font, size: scaleSize(o, dest), color: o.color, bold: o.bold, italic: o.italic, lineheight: o.lineheight, dir: o.dir, align: o.align || 0, fit: o.lines === 1, keep_font: true, ...rot }];
    return [];
  }
  E.moveOps = moveOps;
  // il singolo tracciato dentro un gruppo: il motore ridisegna il gruppo, il riquadro "to" e' quello del gruppo traslato
  function shiftWithin(o, dest) {
    const g = E.inGroup?.box || o.box;
    const sx = (dest[2] - dest[0]) / Math.max(0.01, o.box[2] - o.box[0]), sy = (dest[3] - dest[1]) / Math.max(0.01, o.box[3] - o.box[1]);
    const x0 = dest[0] - (o.box[0] - g[0]) * sx, y0 = dest[1] - (o.box[1] - g[1]) * sy;
    return [x0, y0, x0 + (g[2] - g[0]) * sx, y0 + (g[3] - g[1]) * sy];
  }
  // ridimensionando un blocco di testo in altezza si scala il carattere (come trascinando un angolo in Acrobat con Maiusc)
  const scaleSize = (o, dest) => {
    const h0 = o.box[3] - o.box[1], h1 = dest[3] - dest[1], w0 = o.box[2] - o.box[0], w1 = dest[2] - dest[0];
    return Math.abs(h1 / h0 - w1 / w0) < 0.02 && Math.abs(h1 / h0 - 1) > 0.02 ? Math.round(o.size * (h1 / h0) * 10) / 10 : o.size;
  };
  E.deleteOps = (pno, o) => ({
    image: [{ kind: "image_delete", page: pno, xref: o.xref, box: o.box }], group: [{ kind: "draw_delete", page: pno, box: o.box }],
    drawing: [{ kind: "draw_edit", page: pno, box: E.inGroup?.box || o.box, targets: [o.seqno], delete: true }], field: [{ kind: "field_delete", page: pno, xref: o.xref }],
    annot: [{ kind: "annot_delete", page: pno, xref: o.xref }], link: [{ kind: "link_delete", page: pno, box: o.box }],
    text: [{ kind: "text_block", page: pno, box: o.box, text: "", font: o.font, size: o.size }],
  }[o.kind] || []);
  E.deleteSel = () => { if (!E.sel.length) return; const list = E.sel.flatMap(s => E.deleteOps(s.pno, s.o)); E.sel = []; return E.ops(list, tr("pdfed.u_elimina")); };
  E.enterGroup = (pno, o) => { E.inGroup = { pno, box: o.box }; E.sel = []; decorateAll(); E.renderPanel(); };
  E.exitGroup = () => { E.inGroup = null; E.sel = []; decorateAll(); E.renderPanel(); };

  // ---- allinea, distribuisci, ordine
  E.align = how => {
    const list = E.sel.filter(s => s.o.kind !== "link");
    if (!list.length) return;
    const pno = list[0].pno;
    let ref;
    if (list.length === 1) { const pr = E.pageView(pno).viewport.clone({ scale: 1 }); ref = cssToPdf(pr, 0, 0, pr.width, pr.height); }
    else ref = [Math.min(...list.map(s => s.o.box[0])), Math.min(...list.map(s => s.o.box[1])), Math.max(...list.map(s => s.o.box[2])), Math.max(...list.map(s => s.o.box[3]))];
    const ops = [], keep = [], moves = [];
    for (const s of list) {
      const b = s.o.box, w = b[2] - b[0], h = b[3] - b[1];
      let x = b[0], y = b[1];
      if (how === "l") x = ref[0]; else if (how === "r") x = ref[2] - w; else if (how === "ch") x = (ref[0] + ref[2]) / 2 - w / 2;
      else if (how === "t") y = ref[3] - h; else if (how === "b") y = ref[1]; else if (how === "cv") y = (ref[1] + ref[3]) / 2 - h / 2;
      if (Math.abs(x - b[0]) < 0.05 && Math.abs(y - b[1]) < 0.05) { keep.push({ pno: s.pno, kind: s.o.kind, box: b }); continue; }
      const to = [x, y, x + w, y + h];
      ops.push(...moveOps(s.pno, s.o, to));
      keep.push({ pno: s.pno, kind: s.o.kind, box: to });
      moves.push({ pno: s.pno, kind: s.o.kind, from: b, to });
    }
    trackMoves(moves);
    return E.ops(ops, tr("pdfed.u_allinea"), keep);
  };
  E.distribute = axis => {
    const list = [...E.sel].filter(s => s.o.kind !== "link");
    if (list.length < 3) return toast(tr("pdfed.distribuisci_tre"));
    const i0 = axis === "h" ? 0 : 1, i1 = axis === "h" ? 2 : 3;
    list.sort((a, b) => a.o.box[i0] - b.o.box[i0]);
    const total = list.reduce((a, s) => a + (s.o.box[i1] - s.o.box[i0]), 0);
    const span = Math.max(...list.map(s => s.o.box[i1])) - list[0].o.box[i0];
    const gap = (span - total) / (list.length - 1);
    let pos = list[0].o.box[i0];
    const ops = [], keep = [], moves = [];
    for (const s of list) {
      const b = [...s.o.box], size = b[i1] - b[i0];
      if (Math.abs(b[i0] - pos) > 0.05) {
        b[i0] = pos; b[i1] = pos + size;
        ops.push(...moveOps(s.pno, s.o, b));
        keep.push({ pno: s.pno, kind: s.o.kind, box: b });
        moves.push({ pno: s.pno, kind: s.o.kind, from: s.o.box, to: b });
      } else keep.push({ pno: s.pno, kind: s.o.kind, box: b });
      pos += size + gap;
    }
    trackMoves(moves);
    return E.ops(ops, tr("pdfed.u_distribuisci"), keep);
  };
  E.order = where => {
    const ops = [];
    for (const s of E.sel) {
      const o = s.o;
      if (o.kind === "image") ops.push({ kind: "obj_order", page: s.pno, obj: "image", xref: o.xref, box: o.box, where });
      else if (o.kind === "group") ops.push({ kind: "obj_order", page: s.pno, obj: "group", box: o.box, where });
      else if (o.kind === "drawing") ops.push({ kind: "obj_order", page: s.pno, obj: "drawing", box: E.inGroup?.box || o.box, targets: [o.seqno], where });
      else if (o.kind === "text") ops.push({ kind: "obj_order", page: s.pno, obj: "text", box: o.box, where, text: o.text, font: o.font, size: o.size, color: o.color, bold: o.bold, italic: o.italic, lineheight: o.lineheight, dir: o.dir });
    }
    if (!ops.length) return toast(tr("pdfed.ordine_non_disponibile"));
    return E.ops(ops, where === "front" ? tr("pdfed.u_primo_piano") : tr("pdfed.u_in_fondo"), E.sel.map(s => ({ pno: s.pno, kind: s.o.kind, box: s.o.box })));
  };
  // ---- copia, taglia, incolla, duplica (anche su un'altra pagina: gli oggetti restano quelli originali)
  const COPYABLE = new Set(["image", "group", "drawing", "text", "annot"]);
  E.copySel = () => {
    const list = E.sel.filter(s => COPYABLE.has(s.o.kind));
    if (!list.length) return false;
    E.clip = list.map(s => ({ pno: s.pno, o: s.o, inGroup: E.inGroup?.box, file: E.file() }));
    ctx.status(tr("pdfed.copiati_0", list.length));
    return true;
  };
  E.cutSel = async () => { if (E.copySel()) { E.clipCut = true; ctx.status(tr("pdfed.tagliati_0", E.clip.length)); } };
  E.paste = async (dup = false) => {
    if (!E.clip.length) return;
    const to = E.curPage();
    const cut = E.clipCut && !dup;
    // gli oggetti tagliati vanno incollati prima di toglierli dall'origine; se la pagina e' la stessa restano nello stesso punto
    const ops = [], keep = [];
    for (const c of E.clip) {
      const o = c.o, same = c.pno === to && !cut;
      const off = same ? 10 : 0;
      const dest = [o.box[0] + off, o.box[1] - off, o.box[2] + off, o.box[3] - off];
      const base = { kind: "obj_copy", page: c.pno, obj: o.kind, box: o.kind === "drawing" ? o.box : o.box, xref: o.xref, to_page: to, to: dest };
      if (o.kind === "drawing") Object.assign(base, { box: c.inGroup || o.box, targets: [o.seqno], to: shiftCopy(o, dest, c.inGroup) });
      if (o.kind === "text") Object.assign(base, { text: o.text, font: o.font, size: o.size, color: o.color, bold: o.bold, italic: o.italic, lineheight: o.lineheight, dir: o.dir });
      ops.push(base);
      keep.push({ pno: to, kind: o.kind === "drawing" ? "group" : o.kind, box: dest, tol: 2 });
    }
    if (cut) for (const c of E.clip) ops.push(...E.deleteOps(c.pno, c.o));
    if (cut) { E.clip = []; E.clipCut = false; }
    return E.ops(ops, cut ? tr("pdfed.u_sposta") : tr("pdfed.u_incolla"), keep);
  };
  function shiftCopy(o, dest, g) {
    if (!g) return dest;
    const dx = dest[0] - o.box[0], dy = dest[1] - o.box[1];
    return [g[0] + dx, g[1] + dy, g[2] + dx, g[3] + dy];
  }
  E.duplicate = async () => { if (E.copySel()) await E.paste(true); };

  // ---- spostamento con le frecce: i riquadri si muovono subito, la modifica si applica quando si smette di premere
  let nudgeAcc = [0, 0], nudgeTimer = 0;
  E.nudge = (dx, dy) => {
    nudgeAcc = [nudgeAcc[0] + dx, nudgeAcc[1] + dy];
    for (const s of E.sel) if (s.d) { const k = s.vp.scale; s.d.style.left = parseFloat(s.d.style.left) + dx * k + "px"; s.d.style.top = parseFloat(s.d.style.top) - dy * k + "px"; }
    doc().querySelectorAll(".mbv-h, .mbv-rot, .mbv-rotl").forEach(n => n.remove());
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => {
      const [ax, ay] = nudgeAcc;
      nudgeAcc = [0, 0];
      const moves = E.sel.map(s => ({ pno: s.pno, kind: s.o.kind, from: s.o.box, to: [s.o.box[0] + ax, s.o.box[1] + ay, s.o.box[2] + ax, s.o.box[3] + ay] }));
      trackMoves(moves);
      E.ops(E.sel.flatMap((s, i) => moveOps(s.pno, s.o, moves[i].to)), tr("pdfed.u_sposta"), moves.map(m => ({ pno: m.pno, kind: m.kind, box: m.to })));
    }, 550);
  };

  // ---------------------------------------------------------------- testo esistente: modifica sul posto
  function editTextInline(d, o, pno, vp) {
    if (E.editing) E.commitEditing();
    const ta = doc().createElement("textarea");
    ta.className = "mbv-ed";
    ta.value = o.text;
    ta.spellcheck = false;
    const k = vp?.scale || 1;
    const st = { font: o.font, size: o.size, color: o.color || "#000000", bold: o.bold, italic: o.italic, align: o.align || 0, lineheight: o.lineheight || 1.15, keep_font: true };
    const vertical = o.dir && Math.abs(o.dir[1]) > 0.7 && !(E.pageView(pno).viewport.rotation % 180);
    const single = o.lines === 1; // riga singola (titolo): si allarga invece di andare a capo, come in Acrobat
    const style = () => Object.assign(ta.style, {
      fontFamily: cssFont(st.font), fontSize: st.size * k + "px", color: st.color, fontWeight: st.bold ? 700 : 400, fontStyle: st.italic ? "italic" : "normal",
      lineHeight: st.lineheight, textAlign: ["left", "center", "right", "justify"][st.align] || "left",
    });
    Object.assign(ta.style, { left: d.style.left, top: d.style.top, width: Math.max(parseFloat(d.style.width) + 6, 60) + "px", minHeight: Math.max(parseFloat(d.style.height), 18) + "px",
      whiteSpace: single ? "pre" : "pre-wrap", tabSize: 3 });
    style();
    if (vertical) ta.style.writingMode = "vertical-rl";
    const w0 = Math.max(parseFloat(d.style.width) + 6, 60), l0 = parseFloat(d.style.left);
    const grow = () => {
      if (single) { // si allarga dal lato giusto secondo l'allineamento
        ta.style.width = w0 + "px";
        const w = Math.max(w0, ta.scrollWidth + 4);
        ta.style.width = w + "px";
        ta.style.left = l0 - (st.align === 1 ? (w - w0) / 2 : st.align === 2 ? w - w0 : 0) + "px";
      }
      ta.style.height = "auto"; ta.style.height = Math.max(parseFloat(d.style.height), ta.scrollHeight) + "px";
    };
    d.parentNode.append(ta);
    grow();
    ta.focus();
    ta.addEventListener("input", grow);
    ta.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); E.cancelEditing(); }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); E.commitEditing(); }
    });
    E.editing = { d, o, pno, ta, st, restyle: style, commit: async () => {
      const changed = ta.value !== o.text || ["font", "size", "color", "bold", "italic", "align", "lineheight"].some(x => st[x] !== (x === "align" ? o.align || 0 : x === "lineheight" ? o.lineheight || 1.15 : o[x]));
      ta.remove();
      if (changed) await E.ops([{ kind: "text_block", page: pno, box: o.box, text: ta.value, ...st, dir: o.dir, fit: single && !ta.value.includes("\n") }], tr("pdfed.u_testo"), [{ pno, kind: "text", box: o.box, tol: 30 }]);
    } };
    paintSel();
    E.renderPanel();
  }
  E.editTextInline = editTextInline;
  E.commitEditing = async () => { const ed = E.editing; if (!ed) return; E.editing = null; await ed.commit(); E.renderPanel(); };
  E.cancelEditing = () => { const ed = E.editing; if (!ed) return; E.editing = null; ed.ta.remove(); paintSel(); E.renderPanel(); };

  // ---- casella di inserimento sulla pagina (macchina da scrivere, nota, casella di testo): risolve con il testo o null
  function inlineInput(layer, r, st) {
    return new Promise(res => {
      const ta = doc().createElement("textarea");
      ta.className = "mbv-ed";
      ta.spellcheck = false;
      Object.assign(ta.style, { left: r.left + "px", top: r.top + "px", width: Math.max(r.width, 40) + "px", height: Math.max(r.height, st.size * 1.4) + "px",
        fontFamily: cssFont(st.font || "Helvetica"), fontSize: st.size + "px", color: st.color || "#000", fontWeight: st.bold ? 700 : 400, fontStyle: st.italic ? "italic" : "normal",
        lineHeight: 1.2, background: st.bg || "rgba(255,255,255,.96)", whiteSpace: st.wrap ? "pre-wrap" : "pre" });
      layer.append(ta);
      setTimeout(() => ta.focus(), 0);
      ta.addEventListener("input", () => { if (!st.wrap) ta.style.width = Math.max(r.width, ta.scrollWidth + 6) + "px"; ta.style.height = Math.max(r.height, ta.scrollHeight) + "px"; });
      let done = false;
      const fin = v => { if (done) return; done = true; E.editing = null; ta.remove(); res(v); };
      ta.addEventListener("keydown", ev => { ev.stopPropagation(); if (ev.key === "Escape") fin(null); else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) fin(ta.value.replace(/\s+$/, "")); });
      E.editing = { ta, commit: async () => fin(ta.value.replace(/\s+$/, "")) };
    });
  }

  // ---------------------------------------------------------------- contagocce e anteprima della trasparenza
  const pageCanvas = pv => pv.canvas || pv.div.querySelector("canvas");
  function pickColor(pv, e) {
    e.preventDefault(); e.stopPropagation();
    const cv = pageCanvas(pv);
    if (!cv) return;
    const b = cv.getBoundingClientRect();
    const x = Math.floor((e.clientX - b.left) * cv.width / b.width), y = Math.floor((e.clientY - b.top) * cv.height / b.height);
    const fn = E.picker;
    E.picker = null;
    doc().body.classList.remove("mbv-picking");
    try {
      const [r, g, bl] = cv.getContext("2d").getImageData(x, y, 1, 1).data;
      fn("#" + [r, g, bl].map(v => v.toString(16).padStart(2, "0")).join(""));
    } catch (err) { toast(tr("pdfed.colore_non_leggibile") + err.message, true); fn(null); }
  }
  // contagocce sulla pagina (quando lo strumento corrente non ha strati, se ne crea uno temporaneo)
  E.pickFromPage = cb => {
    E.picker = cb;
    toast(tr("pdfed.clic_colore_pagina"));
    if (!doc().querySelector(".mbv-layer")) {
      const pv = E.pageView(E.curPage());
      const layer = newLayer(pv);
      layer.addEventListener("pointerdown", e => { pickColor(pv, e); layer.remove(); });
    }
  };
  let preview = null;
  function clearPreview() { preview?.remove(); preview = null; }
  E.clearPreview = clearPreview;
  // anteprima di trasparenze, opacita' e regolazioni sull'immagine selezionata (scacchi = parti trasparenti)
  E.showPreview = (s, st) => {
    clearPreview();
    const pv = E.pageView(s.pno);
    const cv = pv && pageCanvas(pv);
    if (!cv || !s.d?.parentNode) return;
    const r = rectOf(s.d), b = cv.getBoundingClientRect(), lb = s.d.parentNode.getBoundingClientRect();
    const kx = cv.width / b.width, ky = cv.height / b.height;
    const sx = Math.round((r.left + lb.left - b.left) * kx), sy = Math.round((r.top + lb.top - b.top) * ky);
    const w = Math.max(1, Math.round(r.width * kx)), h = Math.max(1, Math.round(r.height * ky));
    const c = doc().createElement("canvas");
    c.width = w; c.height = h;
    c.className = "mbv-prev";
    place(c, r);
    const g = c.getContext("2d");
    const [cl, ct, cr, cb] = st.crop || [0, 0, 0, 0];
    g.drawImage(cv, sx, sy, w, h, 0, 0, w, h);
    const img = g.getImageData(0, 0, w, h), px = img.data;
    const cols = (st.transparent || []).map(hx => [1, 3, 5].map(i => parseInt(hx.slice(i, i + 2), 16)));
    const tol = (st.tol ?? 12) * 2.55;
    const br = 1 + (st.brightness || 0) / 100, ctr = 1 + (st.contrast || 0) / 100, sat = 1 + (st.saturation || 0) / 100;
    for (let i = 0; i < px.length; i += 4) {
      let R = px[i], G = px[i + 1], B = px[i + 2];
      const transp = cols.some(([a, b2, c2]) => Math.max(Math.abs(R - a), Math.abs(G - b2), Math.abs(B - c2)) <= tol);
      R *= br; G *= br; B *= br;
      R = (R - 128) * ctr + 128; G = (G - 128) * ctr + 128; B = (B - 128) * ctr + 128;
      const L = 0.299 * R + 0.587 * G + 0.114 * B;
      if (sat !== 1) { R = L + (R - L) * sat; G = L + (G - L) * sat; B = L + (B - L) * sat; }
      if (st.gray) R = G = B = L;
      if (st.invert) { R = 255 - R; G = 255 - G; B = 255 - B; }
      px[i] = R; px[i + 1] = G; px[i + 2] = B;
      px[i + 3] = transp ? 0 : 255 * (st.opacity ?? 1);
    }
    const x = i => Math.floor(i / 4) % w, y = i => Math.floor(i / 4 / w);
    if (cl || ct || cr || cb) for (let i = 0; i < px.length; i += 4) if (x(i) < w * cl || x(i) >= w * (1 - cr) || y(i) < h * ct || y(i) >= h * (1 - cb)) px[i + 3] = 0;
    g.putImageData(img, 0, 0);
    c.style.transform = `${st.flip_h ? "scaleX(-1)" : ""} ${st.flip_v ? "scaleY(-1)" : ""} ${st.rotate ? `rotate(${st.rotate}deg)` : ""}`;
    s.d.parentNode.append(c);
    preview = c;
  };
  // ritaglio dell'immagine selezionata: riquadro con maniglie sopra l'immagine; risolve con [sx, alto, dx, basso] (frazioni)
  E.cropImage = s => new Promise(res => {
    const r = rectOf(s.d), layer = s.d.parentNode;
    const box = doc().createElement("div");
    box.className = "mbv-crop";
    place(box, r);
    layer.append(box);
    const hs = [];
    const update = () => { const q = rectOf(box); hs.forEach(h => Object.assign(h.style, { left: q.left + q.width * h._f[0] + "px", top: q.top + q.height * h._f[1] + "px" })); };
    for (const [k, f] of Object.entries({ nw: [0, 0], ne: [1, 0], se: [1, 1], sw: [0, 1], n: [0.5, 0], e: [1, 0.5], s: [0.5, 1], w: [0, 0.5] })) {
      const h = doc().createElement("div");
      h.className = "mbv-h";
      h._f = f;
      h.style.zIndex = 9;
      layer.append(h);
      hs.push(h);
      h.addEventListener("pointerdown", e => {
        e.stopPropagation();
        const x0 = e.clientX, y0 = e.clientY, q0 = rectOf(box);
        h.setPointerCapture(e.pointerId);
        const mv = ev => {
          const dx = ev.clientX - x0, dy = ev.clientY - y0, q = { ...q0 };
          if (k.includes("w")) { q.left = Math.min(Math.max(r.left, q0.left + dx), q0.left + q0.width - 4); q.width = q0.left + q0.width - q.left; }
          if (k.includes("e")) q.width = Math.max(4, Math.min(r.left + r.width - q0.left, q0.width + dx));
          if (k.includes("n")) { q.top = Math.min(Math.max(r.top, q0.top + dy), q0.top + q0.height - 4); q.height = q0.top + q0.height - q.top; }
          if (k.includes("s")) q.height = Math.max(4, Math.min(r.top + r.height - q0.top, q0.height + dy));
          place(box, q);
          update();
        };
        const up = () => { h.removeEventListener("pointermove", mv); h.removeEventListener("pointerup", up); };
        h.addEventListener("pointermove", mv);
        h.addEventListener("pointerup", up);
      });
    }
    update();
    const finish = ok => {
      const q = rectOf(box);
      box.remove(); hs.forEach(h => h.remove());
      E.cropping = null;
      res(ok ? [(q.left - r.left) / r.width, (q.top - r.top) / r.height, (r.left + r.width - q.left - q.width) / r.width, (r.top + r.height - q.top - q.height) / r.height] : null);
    };
    E.cropping = { finish };
  });

  // ---------------------------------------------------------------- strumenti per pagina
  async function decoratePage(pv) {
    if (!E.mode || TOOLS[E.mode]?.pj || E.mode === "hand" || !pv?.div || !pv.viewport) return;
    const pno = pv.id - 1, vp = pv.viewport, o = E.opt;
    if (E.mode === "select" || E.mode === "edittext") return decorateObjects(pv, pno, vp);
    if (E.mode === "addtext") {
      const layer = newLayer(pv);
      layer.addEventListener("pointerdown", async e => {
        if (e.target !== layer) return;
        if (E.editing) return E.commitEditing();
        const [x, y] = local(layer, e), k = vp.scale;
        const text = await inlineInput(layer, { left: x, top: y - o.size * k * 0.85, width: 200, height: o.size * k * 1.4 }, { ...o, size: o.size * k });
        if (text) await E.ops([{ kind: "typewriter", page: pno, at: vp.convertToPdfPoint(x, y), text, font: o.font, size: o.size, color: o.color, bold: o.bold, italic: o.italic }], tr("pdfed.u_aggiungi_testo"));
      });
      return;
    }
    if (E.mode === "note") return dragLayer(pv, async (box, p1, p2, r, layer) => {
      const text = await inlineInput(layer, { left: r.left, top: r.top, width: 220, height: 70 }, { size: 13, bg: "#fffbe0", wrap: true });
      if (text !== null) await E.ops([{ kind: "annot_add", page: pno, type: "note", box, text, color: o.annotColor.note, icon: o.noteIcon, author: E.author }], tr("pdfed.u_nota"));
    }, { clickSize: [20, 20] });
    if (["underline", "strikeout", "squiggly"].includes(E.mode)) return dragLayer(pv, box => E.ops([{ kind: "annot_add", page: pno, type: E.mode, box, color: o.annotColor[E.mode], author: E.author }], tr(TOOLS[E.mode].name)));
    if (E.mode === "freetext") return dragLayer(pv, async (box, p1, p2, r, layer) => {
      const text = await inlineInput(layer, r, { size: o.ftSize * vp.scale, color: o.ftText, bg: o.ftFill || "#fff", wrap: true });
      if (text) await E.ops([{ kind: "annot_add", page: pno, type: "freetext", box, text, size: o.ftSize, textcolor: o.ftText, fill: o.ftFill, color: o.annotColor.freetext, width: 1, author: E.author }], tr("pdfed.t_casella_testo"));
    }, { clickSize: [180, 40] });
    if (E.mode === "cshape") {
      if (o.cshape === "polygon") return polygonLayer(pv, pno, vp);
      return dragLayer(pv, (box, p1, p2) => E.ops([{ kind: "annot_add", page: pno, type: o.cshape, box, p1, p2, color: o.cstroke, fill: o.cfill, width: o.cwidth, author: E.author }], tr(CSHAPES[o.cshape])));
    }
    if (E.mode === "stamp") return dragLayer(pv, box => {
      const [key, col] = STAMPS[o.stamp] || [];
      const text = o.stamp === -1 ? o.stampCustom || tr("pdfed.s_approvato") : tr(key);
      const sub = o.stampSub ? [E.author, new Date().toLocaleDateString()].filter(Boolean).join(" · ") : "";
      return E.ops([{ kind: "annot_add", page: pno, type: "stamp", box, text, sub, color: o.stamp === -1 ? o.stampColor : col, author: E.author, image: o.stamp === -2 ? o.stampImage : undefined }], tr("pdfed.t_timbro"));
    }, { clickSize: [170, 56] });
    if (E.mode === "image") return dragLayer(pv, async box => { const data = await E.pickImage(); if (data) await E.ops([{ kind: "image_add", page: pno, box, data }], tr("pdfed.u_immagine")); }, { clickSize: [180, 130] });
    if (E.mode === "shape") return dragLayer(pv, (box, p1, p2) => E.ops([{ kind: "shape", page: pno, shape: o.shape, box, p1, p2, stroke: o.stroke, fill: o.fill, width: o.width, dash: o.dash, opacity: o.opacity }], tr(SHAPES[o.shape])));
    if (E.mode === "field") {
      const t = o.field;
      return dragLayer(pv, box => addField(pno, box, t), { clickSize: t === "check" || t === "radio" ? [14, 14] : [180, t === "multiline" || t === "list" ? 60 : 20] });
    }
    if (E.mode === "link") return dragLayer(pv, async box => {
      const v = await E.askLink();
      if (v) await E.ops([v.uri ? { kind: "link_add", page: pno, box, uri: v.uri } : { kind: "link_add", page: pno, box, target: v.page }], tr("pdfed.t_collegamento"));
    });
    if (E.mode === "redact") return dragLayer(pv, box => E.ops([{ kind: "redact_mark", page: pno, box, author: E.author }], tr("pdfed.u_segna_oscura")), { red: true });
    if (E.mode === "whiteout") return dragLayer(pv, box => E.ops([{ kind: "whiteout", page: pno, box }], tr("pdfed.t_bianchetto")));
    if (E.mode === "crop") return dragLayer(pv, box => {
      const pages = o.cropAll ? Array.from({ length: E.pages() }, (_, i) => i) : [pno];
      return E.ops([{ kind: "crop", pages, page: pno, box }], tr("pdfed.u_ritaglia"));
    });
  }
  // poligono di commento: clic sui vertici, doppio clic (o clic sul primo punto) per chiudere
  function polygonLayer(pv, pno, vp) {
    const layer = newLayer(pv);
    const svg = doc().createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "mbv-poly");
    layer.append(svg);
    let pts = [];
    const draw = (extra) => {
      const all = extra ? [...pts, extra] : pts;
      svg.innerHTML = all.length ? `<polyline points="${all.map(p => p.join(",")).join(" ")}" fill="rgba(240,125,46,.08)" stroke="${E.opt.cstroke || "#d32f2f"}" stroke-width="1.5"/>` : "";
    };
    layer.addEventListener("pointermove", e => { if (pts.length) draw(local(layer, e)); });
    layer.addEventListener("pointerdown", async e => {
      const p = local(layer, e);
      if (pts.length > 2 && Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) < 8) return finish();
      pts.push(p);
      draw();
    });
    layer.addEventListener("dblclick", () => finish());
    async function finish() {
      if (pts.length < 3) return;
      const pdf = pts.map(p => vp.convertToPdfPoint(p[0], p[1]));
      const xs = pdf.map(p => p[0]), ys = pdf.map(p => p[1]);
      pts = [];
      draw();
      await E.ops([{ kind: "annot_add", page: pno, type: "polygon", points: pdf, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], color: E.opt.cstroke, fill: E.opt.cfill, width: E.opt.cwidth, author: E.author }], tr("pdfed.f_poligono"));
    }
  }
  E.pickImage = (accept = "image/png,image/jpeg,image/gif,image/bmp,image/webp,image/tiff") => new Promise(res => {
    const inp = el("input", { type: "file", accept, style: { display: "none" } });
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
  const fieldBase = t => ({ text: "campo", multiline: "note", combo: "scelta", list: "elenco", check: "casella", radio: "opzione", signature: "firma" }[t] || "campo");
  E.nextFieldName = t => (E.opt.fieldName || "").trim() || `${fieldBase(t)}_${E.opt.fieldNo}`;
  async function addField(pno, box, t) {
    const o = E.opt;
    const name = E.nextFieldName(t);
    o.fieldNo++;
    o.fieldName = "";
    const options = t === "combo" || t === "list" ? (o.fieldOptions || tr("pdfed.opzioni_predefinite")).split(/\r?\n/).map(s => s.trim()).filter(Boolean) : undefined;
    await E.ops([{ kind: "field_add", page: pno, box, type: t === "multiline" ? "text" : t, multiline: t === "multiline", name, group: t === "radio" ? (o.radioGroup || "opzioni") : undefined,
      required: o.fieldRequired, fontsize: o.fieldFont, options }], tr("pdfed.u_campo_0", name), [{ pno, kind: "field", box }]);
  }

  // ---------------------------------------------------------------- modalita', strati, tasti
  function decorateAll() {
    const a = app();
    if (!a?.pdfViewer) return;
    clearLayers();
    if (!E.mode || TOOLS[E.mode]?.pj || E.mode === "hand") return;
    for (let i = 0; i < a.pagesCount; i++) { const pv = a.pdfViewer.getPageView(i); if (pv?.div && pv.viewport && pv.renderingState === 3) decoratePage(pv); }
  }
  E.decorateAll = decorateAll;
  let hooked = false;
  function hook() {
    if (hooked || !app()) return;
    hooked = true;
    app().eventBus.on("pagerendered", e => { if (E.mode && !TOOLS[E.mode]?.pj) decoratePage(app().pdfViewer.getPageView(e.pageNumber - 1)); });
    app().eventBus.on("pagechanging", () => E.changed());
    const keyTarget = doc();
    keyTarget.addEventListener("keydown", onKey, true);
    document.addEventListener("keydown", e => { if (ctx.tab.view?.isConnected && !ctx.tab.view.hidden && document.activeElement?.closest?.(".pe-row, .pe-panel") == null && !e.target.closest?.("input, textarea, select, [contenteditable]")) onKey(e, true); });
  }
  function onKey(e, outer) {
    if (e.target.closest?.("textarea, input, select, [contenteditable=true], [contenteditable=plaintext-only], .freeTextEditor, .annotationEditorLayer [contenteditable]")) return;
    const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && k === "f") { e.preventDefault(); E.openSearch?.(); return; }
    if (outer && !E.active) return;
    // tasti di Acrobat: strumenti a lettera singola
    if (!ctrl && !e.altKey) {
      if (k === "u") { e.preventDefault(); const cyc = ["pj-highlight", "underline", "strikeout", "squiggly"]; E.setMode(E.mode && cyc.includes(E.mode) && e.shiftKey ? cyc[(cyc.indexOf(E.mode) + 1) % cyc.length] : "pj-highlight"); return; }
      const hit = Object.entries(TOOLS).find(([, d]) => d.key && d.key.toLowerCase() === k);
      if (hit && !e.shiftKey) { e.preventDefault(); E.setMode(hit[0]); return; }
      const arrow = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, 1], arrowdown: [0, -1] }[k];
      if (arrow && E.mode === "select" && E.sel.length) { e.preventDefault(); E.nudge(arrow[0] * (e.shiftKey ? 10 : 1), arrow[1] * (e.shiftKey ? 10 : 1)); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && E.sel.length && E.mode === "select") { e.preventDefault(); E.deleteSel(); return; }
      if (e.key === "Enter" && E.cropping) { e.preventDefault(); E.cropping.finish(true); return; }
      if (e.key === "Escape") {
        if (E.cropping) { E.cropping.finish(false); return; }
        if (E.picker) { E.picker(null); E.picker = null; return; }
        if (E.sel.length) { E.setSel([]); return; }
        if (E.inGroup) { E.exitGroup(); return; }
        if (E.mode && E.mode !== "select") { E.setMode("select"); return; }
        if (E.mode) E.setMode(null);
        return;
      }
    }
    if (!ctrl) return;
    if (k === "z" && !e.shiftKey) { e.preventDefault(); E.undoLast(); return; }
    if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); E.redoLast(); return; }
    if (k === "a" && E.mode === "select") { e.preventDefault(); const p = E.curPage(); const layer = doc().querySelector(`.page[data-page-number="${p + 1}"] .mbv-layer`); if (layer) E.setSel([...layer.querySelectorAll(".mbv-obj")].map(n => ({ pno: p, o: n._obj, d: n, vp: E.pageView(p).viewport }))); return; }
    if (k === "c" && E.sel.length && E.mode === "select") { e.preventDefault(); E.copySel(); return; }
    if (k === "x" && E.sel.length && E.mode === "select") { e.preventDefault(); E.cutSel(); return; }
    if (k === "v" && E.clip.length && !e.shiftKey) { e.preventDefault(); if (E.mode !== "select") E.setMode("select"); E.paste(); return; }
    if (k === "g" && E.mode === "select") { e.preventDefault(); if (e.shiftKey) E.ungroupSel(); else E.groupSel(); return; }
    if ((e.code === "BracketRight" || e.code === "BracketLeft") && e.shiftKey && E.sel.length) { e.preventDefault(); E.order(e.code === "BracketRight" ? "front" : "back"); return; }
    if (e.shiftKey && k === "r") { e.preventDefault(); E.pageCmd?.("rotate"); return; }
    if (e.shiftKey && k === "d") { e.preventDefault(); E.pageCmd?.("delete"); return; }
    if (e.shiftKey && k === "i") { e.preventDefault(); E.pageCmd?.("insert"); return; }
    if (e.shiftKey && k === "e") { e.preventDefault(); E.pageCmd?.("extract"); return; }
    if (k === "d" && !e.shiftKey) { e.preventDefault(); E.docCmd?.("props"); return; }
  }
  E.setMode = (m, variant) => {
    hook();
    injectCss();
    if (E.editing) E.commitEditing();
    if (E.cropping) E.cropping.finish(false);
    if (variant !== undefined) {
      if (m === "shape") E.opt.shape = variant;
      else if (m === "cshape") E.opt.cshape = variant;
      else if (m === "field") E.opt.field = variant;
      else if (m === "stamp") E.opt.stamp = variant;
      else if (m === "pj-highlight" && variant !== "highlight") m = variant;
    }
    const wasPj = TOOLS[E.mode]?.pj;
    E.mode = m;
    E.active = !!m;
    E.sel = []; E.inGroup = null; E.picker = null;
    clearPreview();
    if (TOOLS[m]?.pj) pjMode(TOOLS[m].pj);
    else if (wasPj || m) pjMode(0);
    try { app()?.pdfCursorTools?.switchTool(m === "hand" ? 1 : 0); } catch { /* */ }
    decorateAll();
    E.renderPanel();
    E.changed();
    ctx.status(m ? tr("pdfed.strumento_0", tr(TOOLS[m]?.name || "pdfed.modifica")) : "");
    return m;
  };
  E.escape = () => { if (E.editing) { E.cancelEditing(); return true; } if (E.sel.length) { E.setSel([]); return true; } if (!E.mode) return false; E.setMode(null); return true; };
  E.attach = () => { hook(); injectCss(); };
  // evidenzia per un attimo un riquadro (commento scelto nell'elenco, risultato di ricerca)
  E.flash = async (pno, box) => {
    const a = app();
    a.page = pno + 1;
    await new Promise(r => setTimeout(r, 120));
    const pv = E.pageView(pno);
    if (!pv?.div) return;
    pv.div.scrollIntoView({ block: "nearest" });
    const r = rectToCss(pv.viewport, box);
    const f = doc().createElement("div");
    f.className = "mbv-flash";
    place(f, { left: r.left - 3, top: r.top - 3, width: r.width + 6, height: r.height + 6 });
    pv.div.append(f);
    const cont = a.pdfViewer.container, fb = f.getBoundingClientRect(), cb = cont.getBoundingClientRect();
    if (fb.top < cb.top + 40 || fb.bottom > cb.bottom - 40) cont.scrollTop += fb.top - cb.top - cb.height / 3;
    setTimeout(() => f.remove(), 1500);
  };
  E.renderPanel = () => {}; // sostituita da pdfedpanel.js
  return E;
}

export { pdfIcon };
