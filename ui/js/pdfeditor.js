// Editor PDF sopra il visualizzatore pdf.js: modifica del testo esistente (clic sulla riga e si riscrive con lo stesso
// font, dimensione e colore), oscuramento definitivo e bianchetto di zone. Le modifiche si applicano a una copia di
// lavoro (motore PyMuPDF); l'originale cambia solo con Salva. Annulla torna indietro di una modifica alla volta.
import { api, fileUrl, toast } from "./core.js";

const CSS = `
.mbv-layer { position: absolute; inset: 0; z-index: 30; }
.mbv-line { position: absolute; cursor: text; outline: 1px dashed rgba(42,120,214,.35); border-radius: 1px; white-space: pre; line-height: 1; }
.mbv-line:hover { outline: 1.5px solid rgba(42,120,214,.9); background: rgba(42,120,214,.07); }
.mbv-line.editing { outline: 2px solid #2a78d6; background: #fff; z-index: 2; min-width: 4px; }
.mbv-line.changed { outline: 1.5px solid #3f9d5a; }
.mbv-draw { position: absolute; inset: 0; z-index: 30; cursor: crosshair; }
.mbv-rect { position: absolute; border: 1.5px dashed #c62828; background: rgba(198,40,40,.15); pointer-events: none; }
.mbv-rect.white { border-color: #2a78d6; background: rgba(255,255,255,.7); }
`;

export function createPdfEditor(ctx, frame, setBusy) {
  const app = () => frame.contentWindow?.PDFViewerApplication;
  let work = null;            // copia di lavoro modificabile
  const undo = [];            // copie precedenti, per Annulla
  let mode = null;            // "text" | "redact" | "whiteout" | null
  const cache = new Map();    // pagina -> righe di testo (della versione corrente della copia di lavoro)

  // salva nella copia di lavoro le annotazioni fatte con pdf.js (cosi' non si perdono ricaricando)
  async function flushAnnotations() {
    const a = app();
    if (!a?.pdfDocument) return;
    if (!a.pdfDocument.annotationStorage.size) return;
    const data = await a.pdfDocument.saveDocument();
    await api("save", { path: work }, { body: data });
  }

  async function ensureWork() {
    if (work) return;
    work = (await api("pdf_work", { path: ctx.path })).path;
    await flushAnnotations();
  }

  async function reload() {
    const a = app();
    const page = a.page, scale = a.pdfViewer.currentScaleValue, top = a.pdfViewer.container.scrollTop;
    cache.clear();
    await a.open({ url: fileUrl(work) + "&v=" + Date.now() });
    await new Promise(res => a.eventBus.on("pagesinit", res, { once: true }));
    a.pdfViewer.currentScaleValue = scale;
    a.page = page;
    a.pdfViewer.container.scrollTop = top;
    ctx.setDirty(true);
    if (mode) setTimeout(decorateAll, 50); // le caselle modificabili si rimettono anche sulle pagine non ancora ridisegnate
  }

  async function applyEdits(edits) {
    setBusy(true);
    try {
      await ensureWork();
      await flushAnnotations();
      undo.push((await api("pdf_work", { path: work })).path); // istantanea per Annulla
      await api("pdf_edit", { path: work }, { json: { edits } });
      await reload();
      return true;
    } catch (e) {
      toast("Modifica non riuscita: " + e.message, true, 6000);
      return false;
    } finally { setBusy(false); }
  }

  async function undoLast() {
    if (!undo.length) return toast("Nessuna modifica da annullare");
    const prev = undo.pop();
    work = prev;
    await reload();
    if (!undo.length) toast("Tornato al documento iniziale (resta da salvare se avevi altre annotazioni)");
  }

  // ---- strati sopra le pagine
  function doc() { return frame.contentDocument; }
  function injectCss() {
    if (doc().getElementById("mbv-edit-css")) return;
    const s = doc().createElement("style");
    s.id = "mbv-edit-css";
    s.textContent = CSS;
    doc().head.append(s);
  }
  function clearLayers() { doc()?.querySelectorAll(".mbv-layer, .mbv-draw").forEach(n => n.remove()); }

  function rectToCss(viewport, box) {
    const [x0, y0, x1, y1] = viewport.convertToViewportRectangle(box);
    return { left: Math.min(x0, x1), top: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
  }
  function cssToPdf(viewport, l, t, w, h) {
    const [ax, ay] = viewport.convertToPdfPoint(l, t), [bx, by] = viewport.convertToPdfPoint(l + w, t + h);
    return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
  }

  async function decoratePage(pv) {
    if (!mode || !pv?.div || !pv.viewport) return;
    pv.div.querySelectorAll(".mbv-layer, .mbv-draw").forEach(n => n.remove());
    const pno = pv.id - 1, vp = pv.viewport;
    if (mode === "text") {
      let lines = cache.get(pno);
      if (!lines) {
        try { lines = (await api("pdf_lines", { path: work || ctx.path, page: pno })).righe; } catch (e) { return toast(e.message, true); }
        cache.set(pno, lines);
      }
      if (!mode || mode !== "text") return;
      const layer = doc().createElement("div");
      layer.className = "mbv-layer";
      for (const ln of lines) {
        const r = rectToCss(vp, ln.box);
        const d = doc().createElement("div");
        d.className = "mbv-line";
        d.title = `${ln.font} · ${ln.size} pt — clic per modificare`;
        Object.assign(d.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
        d.addEventListener("click", () => editLine(d, ln, pno, vp, r));
        layer.append(d);
      }
      pv.div.append(layer);
    } else {
      // oscura / bianchetto: si disegna un riquadro trascinando
      const layer = doc().createElement("div");
      layer.className = "mbv-draw";
      let start = null, box = null;
      layer.addEventListener("pointerdown", e => {
        const b = layer.getBoundingClientRect();
        start = [e.clientX - b.left, e.clientY - b.top];
        box = doc().createElement("div");
        box.className = "mbv-rect" + (mode === "whiteout" ? " white" : "");
        layer.append(box);
        layer.setPointerCapture(e.pointerId);
      });
      layer.addEventListener("pointermove", e => {
        if (!start) return;
        const b = layer.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
        Object.assign(box.style, { left: Math.min(x, start[0]) + "px", top: Math.min(y, start[1]) + "px", width: Math.abs(x - start[0]) + "px", height: Math.abs(y - start[1]) + "px" });
      });
      layer.addEventListener("pointerup", async () => {
        if (!start) return;
        start = null;
        const l = parseFloat(box.style.left), t = parseFloat(box.style.top), w = parseFloat(box.style.width), h = parseFloat(box.style.height);
        if (!(w > 3 && h > 3)) { box.remove(); return; }
        const pdfBox = cssToPdf(vp, l, t, w, h);
        const kind = mode;
        if (kind === "redact" && !confirm("Oscurare definitivamente la zona? Testo e immagini sotto il riquadro vengono eliminati dal file (non solo coperti).")) { box.remove(); return; }
        await applyEdits([{ page: pno, kind, box: pdfBox }]);
      });
      pv.div.append(layer);
    }
  }

  function editLine(d, ln, pno, vp, r) {
    if (d.classList.contains("editing")) return;
    d.classList.add("editing");
    d.contentEditable = "plaintext-only";
    d.textContent = ln.text;
    const px = r.height * 0.82;
    Object.assign(d.style, { fontSize: px + "px", color: ln.color, fontWeight: ln.bold ? "700" : "400", fontStyle: ln.italic ? "italic" : "normal",
      fontFamily: /times|serif|roman/i.test(ln.font) ? "Times New Roman, serif" : /cour|mono/i.test(ln.font) ? "Courier New, monospace" : "Arial, Helvetica, sans-serif",
      width: "auto", minWidth: r.width + "px", lineHeight: r.height + "px" });
    d.focus();
    const sel = doc().getSelection();
    sel.selectAllChildren(d);
    sel.collapseToEnd();
    let done = false;
    const finish = async commit => {
      if (done) return;
      done = true;
      d.removeEventListener("blur", onBlur);
      d.removeEventListener("keydown", onKey);
      const text = d.textContent.replace(/\r/g, "");
      d.contentEditable = "false";
      d.classList.remove("editing");
      d.textContent = "";
      Object.assign(d.style, { width: r.width + "px", fontSize: "" });
      if (!commit || text === ln.text) return;
      d.classList.add("changed");
      await applyEdits([{ page: pno, kind: "replace", box: ln.box, origin: ln.origin, font: ln.font, size: ln.size, color: ln.color, bold: ln.bold, italic: ln.italic, text }]);
    };
    const onBlur = () => finish(true);
    const onKey = e => {
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
      else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true); }
      e.stopPropagation(); // le scorciatoie di pdf.js non devono intercettare i tasti mentre si scrive
    };
    d.addEventListener("blur", onBlur);
    d.addEventListener("keydown", onKey);
  }

  function decorateAll() {
    const a = app();
    if (!a?.pdfViewer) return;
    for (let i = 0; i < a.pagesCount; i++) {
      const pv = a.pdfViewer.getPageView(i);
      if (pv?.div && pv.viewport) decoratePage(pv);
    }
  }

  let hooked = false;
  function hook() {
    if (hooked || !app()) return;
    hooked = true;
    app().eventBus.on("pagerendered", e => { if (mode) decoratePage(app().pdfViewer.getPageView(e.pageNumber - 1)); });
  }

  return {
    get mode() { return mode; },
    get work() { return work; },
    async setMode(m) {
      hook();
      mode = mode === m ? null : m;
      injectCss();
      clearLayers();
      if (mode) {
        // l'editor di annotazioni di pdf.js va spento, altrimenti cattura i clic
        try { app().pdfViewer.annotationEditorMode = { mode: 0 }; } catch { /* */ }
        decorateAll();
      }
      return mode;
    },
    undoLast,
    hasUndo: () => undo.length > 0,
    // percorso del file da usare per le operazioni sull'intero documento (la copia di lavoro, se esiste, aggiornata)
    async currentFile() { if (work) await flushAnnotations(); return work || ctx.path; },
  };
}
