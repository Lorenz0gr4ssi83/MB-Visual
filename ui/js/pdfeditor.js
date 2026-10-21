// Editor PDF completo sopra il visualizzatore pdf.js (motore PyMuPDF: mbvisual/pdfedit.py e pdfobjects.py).
// Strumenti: Oggetti (seleziona, sposta, ridimensiona, modifica ed elimina immagini, blocchi di testo, disegni, campi
// modulo e collegamenti), Testo riga, Macchina da scrivere, Immagine, Forme, Campi modulo (testo, menu a tendina,
// elenco, casella di spunta, opzione, firma), Collegamento, Oscura, Bianchetto, Ritaglia; menu Pagina e Documento.
// Le modifiche vanno su una copia di lavoro; l'originale cambia solo con Salva. Annulla / Ripeti per ogni passo.
import { api, askText, confirmBox, el, fileUrl, modal, pickFiles, toast } from "./core.js";

const CSS = `
.mbv-layer { position: absolute; inset: 0; z-index: 30; }
.mbv-obj { position: absolute; outline: 1px dashed rgba(42,120,214,.28); }
.mbv-obj:hover { outline: 1.5px solid rgba(42,120,214,.9); background: rgba(42,120,214,.06); }
.mbv-obj.k-image { outline-color: rgba(46,160,90,.45); }
.mbv-obj.k-field { outline-color: rgba(200,120,0,.6); background: rgba(255,170,0,.06); }
.mbv-obj.k-link { outline-color: rgba(140,60,200,.55); }
.mbv-obj.k-drawing { outline-color: rgba(120,120,120,.35); }
.mbv-obj.sel { outline: 2px solid #ff9f1a; background: rgba(255,159,26,.08); z-index: 3; }
.mbv-h { position: absolute; width: 9px; height: 9px; background: #fff; border: 1.5px solid #ff9f1a; z-index: 4; }
.mbv-line { position: absolute; outline: 1px dashed rgba(42,120,214,.35); white-space: pre; line-height: 1; }
.mbv-line:hover { outline: 1.5px solid rgba(42,120,214,.9); background: rgba(42,120,214,.07); }
.mbv-line.editing { outline: 2px solid #2a78d6; background: #fff; z-index: 2; min-width: 4px; }
.mbv-rect { position: absolute; border: 1.5px dashed #2a78d6; background: rgba(42,120,214,.10); pointer-events: none; }
.mbv-rect.red { border-color: #c62828; background: rgba(198,40,40,.18); }
.mbv-tw { position: absolute; z-index: 5; background: rgba(255,255,240,.95); border: 1.5px solid #2a78d6; outline: none; resize: both; padding: 0; margin: 0; white-space: pre; overflow: hidden; }
`;
const FONTS = ["Helvetica", "Arial", "Calibri", "Cambria", "Times New Roman", "Courier New", "Verdana", "Georgia", "Tahoma", "Segoe UI"];
const cssFont = f => (/times|serif|roman|cambria|georgia/i.test(f) ? `"${f}", "Times New Roman", serif` : /cour|mono/i.test(f) ? '"Courier New", monospace' : `"${f}", Arial, sans-serif`);
const FIELD_TYPES = [["text", "Campo di testo"], ["multiline", "Testo su piu' righe"], ["combo", "Menu a tendina"], ["list", "Elenco a scelta"], ["check", "Casella di spunta"], ["radio", "Pulsante di opzione"], ["signature", "Campo firma"]];
const SHAPES = [["rect", "Rettangolo"], ["rounded", "Rettangolo arrotondato"], ["ellipse", "Ellisse / cerchio"], ["line", "Linea"], ["arrow", "Freccia"]];

export function createPdfEditor(ctx, frame, setBusy) {
  const app = () => frame.contentWindow?.PDFViewerApplication;
  const doc = () => frame.contentDocument;
  let work = null, mode = null, sel = null;
  const undo = [], redo = [];
  const objCache = new Map(), lineCache = new Map();
  const opt = { font: "Helvetica", size: 11, color: "#000000", bold: false, italic: false, shape: "rect", stroke: "#d32f2f", fill: "", width: 1.5, field: "text" };
  let meta = { title: "", author: "", subject: "", keywords: "" }, toc = [];

  // ---------------------------------------------------------------- copia di lavoro, operazioni, annulla/ripeti
  async function flushAnnotations() {
    const a = app();
    if (!a?.pdfDocument || !a.pdfDocument.annotationStorage.size) return;
    await api("save", { path: work }, { body: await a.pdfDocument.saveDocument() });
  }
  async function ensureWork() {
    if (work) return;
    work = (await api("pdf_work", { path: ctx.path })).path;
    await flushAnnotations();
  }
  async function reload() {
    const a = app();
    const page = a.page, scale = a.pdfViewer.currentScaleValue, top = a.pdfViewer.container.scrollTop;
    objCache.clear(); lineCache.clear(); sel = null;
    await a.open({ url: fileUrl(work) + "&v=" + Date.now() });
    await new Promise(res => a.eventBus.on("pagesinit", res, { once: true }));
    a.pdfViewer.currentScaleValue = scale;
    a.page = Math.min(page, a.pagesCount);
    a.pdfViewer.container.scrollTop = top;
    ctx.setDirty(true);
    renderPanel();
    if (mode) setTimeout(decorateAll, 60);
  }
  async function run(route, payload) {
    setBusy(true);
    try {
      await ensureWork();
      await flushAnnotations();
      undo.push((await api("pdf_work", { path: work })).path);
      redo.length = 0;
      await api(route, { path: work }, { json: payload });
      await reload();
      return true;
    } catch (e) {
      toast("Modifica non riuscita: " + e.message, true, 7000);
      return false;
    } finally { setBusy(false); }
  }
  const ops = list => run("pdf_ops", { ops: list });
  async function undoLast() {
    if (!undo.length) return toast("Nessuna modifica da annullare");
    redo.push(work);
    work = undo.pop();
    await reload();
  }
  async function redoLast() {
    if (!redo.length) return toast("Niente da ripetere");
    undo.push(work);
    work = redo.pop();
    await reload();
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
      box.dataset.end = `${x},${y}`;
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
    if (!mode || !pv?.div || !pv.viewport) return;
    const pno = pv.id - 1, vp = pv.viewport;
    if (mode === "select") return decorateObjects(pv, pno, vp);
    if (mode === "line") return decorateLines(pv, pno, vp);
    if (mode === "typewriter") {
      const layer = newLayer(pv);
      layer.addEventListener("pointerdown", e => { if (e.target === layer) typewriter(layer, pno, vp, e); });
      return;
    }
    if (mode === "image") return dragLayer(pv, async box => { const data = await pickImage(); if (data) await ops([{ kind: "image_add", page: pno, box, data }]); }, false, [160, 120]);
    if (mode === "shape") return dragLayer(pv, (box, p1, p2) => ops([{ kind: "shape", page: pno, shape: opt.shape, box, p1, p2, stroke: opt.stroke, fill: opt.fill, width: opt.width }]));
    if (mode === "field") return dragLayer(pv, box => addField(pno, box), false, opt.field === "check" || opt.field === "radio" ? [14, 14] : [180, opt.field === "multiline" || opt.field === "list" ? 60 : 20]);
    if (mode === "link") return dragLayer(pv, async box => {
      const v = await askText("Collegamento", "Indirizzo web (https://...) oppure numero di pagina", "https://");
      if (!v) return;
      const n = parseInt(v, 10);
      await ops([String(n) === v.trim() ? { kind: "link_add", page: pno, box, target: n } : { kind: "link_add", page: pno, box, uri: v.trim() }]);
    });
    if (mode === "redact") return dragLayer(pv, async box => { if (await confirmBox("Oscura", "Oscurare definitivamente la zona? Testo, immagini e disegni sotto il riquadro vengono eliminati dal file.")) await ops([{ kind: "redact", page: pno, box }]); }, true);
    if (mode === "whiteout") return dragLayer(pv, box => ops([{ kind: "whiteout", page: pno, box }]));
    if (mode === "crop") return dragLayer(pv, async box => { if (await confirmBox("Ritaglia", "Ritagliare la pagina al riquadro disegnato?")) await ops([{ kind: "crop", page: pno, box }]); });
  }

  // ---- Oggetti: selezione, spostamento, ridimensionamento
  async function decorateObjects(pv, pno, vp) {
    let data = objCache.get(pno);
    if (!data) {
      try { data = await api("pdf_objects", { path: work || ctx.path, page: pno }); } catch (e) { return toast(e.message, true); }
      objCache.set(pno, data);
      meta = data.metadata || meta;
      toc = data.toc || toc;
    }
    if (mode !== "select") return;
    const layer = newLayer(pv);
    // disegni sotto, poi testi, immagini, collegamenti e campi sopra (si selezionano per primi)
    const order = { group: 0, drawing: 0, text: 1, image: 2, annot: 3, link: 3, field: 4 };
    const list = [...data.oggetti].sort((a, b) => order[a.kind] - order[b.kind]);
    for (const o of list) {
      const r = rectToCss(vp, o.box);
      if (r.width < 2 && r.height < 2) continue;
      const d = doc().createElement("div");
      d.className = "mbv-obj k-" + o.kind;
      d.title = { image: "Immagine", text: "Blocco di testo", drawing: "Disegno vettoriale", group: "Gruppo di disegni", annot: "Annotazione", field: "Campo modulo: " + (o.name || ""), link: "Collegamento" }[o.kind];
      place(d, r);
      d.addEventListener("pointerdown", e => { e.stopPropagation(); selectObj(pno, o, d, vp); startDrag(e, d, o, pno, vp, "move"); });
      d.addEventListener("dblclick", e => { e.stopPropagation(); if (o.kind === "text") editTextInline(d, o, pno); });
      layer.append(d);
    }
    layer.addEventListener("pointerdown", e => { if (e.target === layer) { sel = null; doc().querySelectorAll(".mbv-obj.sel").forEach(n => n.classList.remove("sel")); doc().querySelectorAll(".mbv-h").forEach(n => n.remove()); renderPanel(); } });
  }
  function selectObj(pno, o, d, vp) {
    doc().querySelectorAll(".mbv-obj.sel").forEach(n => n.classList.remove("sel"));
    doc().querySelectorAll(".mbv-h").forEach(n => n.remove());
    d.classList.add("sel");
    sel = { pno, o, d, vp };
    if (["image", "drawing", "group", "annot", "field", "link", "text"].includes(o.kind)) {
      for (const pos of ["nw", "ne", "sw", "se"]) {
        const h = doc().createElement("div");
        h.className = "mbv-h";
        const r = { left: parseFloat(d.style.left), top: parseFloat(d.style.top), width: parseFloat(d.style.width), height: parseFloat(d.style.height) };
        Object.assign(h.style, { left: r.left + (pos.includes("e") ? r.width : 0) - 5 + "px", top: r.top + (pos.includes("s") ? r.height : 0) - 5 + "px" });
        h.addEventListener("pointerdown", e => { e.stopPropagation(); startDrag(e, d, o, pno, vp, pos); });
        d.parentNode.append(h);
      }
    }
    renderPanel();
  }
  function startDrag(e, d, o, pno, vp, how) {
    const x0 = e.clientX, y0 = e.clientY;
    const r0 = { left: parseFloat(d.style.left), top: parseFloat(d.style.top), width: parseFloat(d.style.width), height: parseFloat(d.style.height) };
    let moved = false;
    const target = e.target;
    try { target.setPointerCapture(e.pointerId); } catch { /* */ }
    const mv = ev => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      const r = { ...r0 };
      if (how === "move") { r.left += dx; r.top += dy; }
      else {
        if (how.includes("w")) { r.left += dx; r.width -= dx; }
        if (how.includes("e")) r.width += dx;
        if (how.includes("n")) { r.top += dy; r.height -= dy; }
        if (how.includes("s")) r.height += dy;
        if (ev.shiftKey && o.kind === "image") r.height = r.width * (r0.height / r0.width); // Maiusc: proporzioni bloccate
        r.width = Math.max(4, r.width); r.height = Math.max(4, r.height);
      }
      place(d, r);
    };
    const up = async () => {
      target.removeEventListener("pointermove", mv);
      target.removeEventListener("pointerup", up);
      if (!moved) return;
      const to = cssToPdf(vp, parseFloat(d.style.left), parseFloat(d.style.top), parseFloat(d.style.width), parseFloat(d.style.height));
      await moveObj(pno, o, to);
    };
    target.addEventListener("pointermove", mv);
    target.addEventListener("pointerup", up);
  }
  function moveObj(pno, o, to) {
    if (o.kind === "image") return o.movable ? ops([{ kind: "image_move", page: pno, xref: o.xref, box: o.box, to }]) : toast("Questa immagine e' incorporata nel testo della pagina e non si puo' spostare: usa Bianchetto e reinseriscila", true, 6000);
    if (o.kind === "drawing" || o.kind === "group") return ops([{ kind: "draw_move", page: pno, box: o.box, to }]);
    if (o.kind === "annot") return ops([{ kind: "annot_update", page: pno, xref: o.xref, to, props: {} }]);
    if (o.kind === "field") return ops([{ kind: "field_update", page: pno, xref: o.xref, to, props: {} }]);
    if (o.kind === "link") return ops([{ kind: "link_delete", page: pno, box: o.box }, o.uri ? { kind: "link_add", page: pno, box: to, uri: o.uri } : { kind: "link_add", page: pno, box: to, target: (o.page ?? 0) + 1 }]);
    if (o.kind === "text") return ops([{ kind: "text_block", page: pno, box: o.box, to, text: o.text, font: o.font, size: o.size, color: o.color, bold: o.bold, italic: o.italic }]);
  }
  function deleteObj(s = sel) {
    if (!s) return;
    const { pno, o } = s;
    const op = { image: { kind: "image_delete", page: pno, xref: o.xref, box: o.box }, drawing: { kind: "draw_delete", page: pno, box: o.box }, group: { kind: "draw_delete", page: pno, box: o.box },
      annot: { kind: "annot_delete", page: pno, xref: o.xref }, field: { kind: "field_delete", page: pno, xref: o.xref },
      link: { kind: "link_delete", page: pno, box: o.box }, text: { kind: "text_block", page: pno, box: o.box, text: "", font: o.font, size: o.size } }[o.kind];
    return ops([op]);
  }
  function editTextInline(d, o, pno) {
    const ta = doc().createElement("textarea");
    ta.className = "mbv-tw";
    ta.value = o.text;
    const k = sel?.vp?.scale || 1;
    Object.assign(ta.style, { left: d.style.left, top: d.style.top, width: Math.max(parseFloat(d.style.width), 120) + "px", height: Math.max(parseFloat(d.style.height), 24) + "px",
      fontFamily: cssFont(o.font), fontSize: o.size * k + "px", color: o.color || "#000", fontWeight: o.bold ? 700 : 400, fontStyle: o.italic ? "italic" : "normal", whiteSpace: "pre-wrap", lineHeight: 1.15 });
    d.parentNode.append(ta);
    ta.focus();
    const done = async commit => {
      ta.remove();
      if (commit && ta.value !== o.text) await ops([{ kind: "text_block", page: pno, box: o.box, text: ta.value, font: o.font, size: o.size, color: o.color, bold: o.bold, italic: o.italic }]);
    };
    ta.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") done(false); if (e.key === "Enter" && e.ctrlKey) done(true); });
    ta.addEventListener("blur", () => done(true), { once: true });
  }

  // ---- Testo riga (modifica rapida della singola riga, stesso carattere)
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
      d.title = `${ln.font} · ${ln.size} pt — clic per modificare`;
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

  // ---- Macchina da scrivere: si clicca e si scrive direttamente sulla pagina
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
      if (commit && text) {
        const at = vp.convertToPdfPoint(x, y); // linea di base della prima riga
        await ops([{ kind: "typewriter", page: pno, at, text, font: opt.font, size: opt.size, color: opt.color, bold: opt.bold, italic: opt.italic }]);
      }
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
  async function addField(pno, box) {
    const t = opt.field;
    const name = el("input", { type: "text", class: "field", id: "pdf-fname", value: { check: "casella", radio: "opzioni", signature: "firma", combo: "scelta", list: "elenco" }[t] || "campo" });
    const rows = [el("label", { style: { display: "grid", gap: "4px" } }, t === "radio" ? "Gruppo (stesso nome = scelta esclusiva)" : "Nome del campo", name)];
    const tip = el("input", { type: "text", class: "field", id: "pdf-ftip", placeholder: "Testo d'aiuto (facoltativo)" });
    rows.push(el("label", { style: { display: "grid", gap: "4px" } }, "Descrizione", tip));
    let optsBox = null;
    if (t === "combo" || t === "list") {
      optsBox = el("textarea", { rows: 6, class: "field", id: "pdf-fopts", style: { width: "100%" } }, "Opzione 1\nOpzione 2\nOpzione 3");
      rows.push(el("label", { style: { display: "grid", gap: "4px" } }, "Voci (una per riga)", optsBox));
    }
    const req = el("input", { type: "checkbox", id: "pdf-freq" });
    rows.push(el("label", {}, req, " Obbligatorio"));
    const ok = await modal("Nuovo campo: " + FIELD_TYPES.find(f => f[0] === t)[1], el("div", { style: { display: "grid", gap: "10px", minWidth: "320px" } }, ...rows), [{ label: "Annulla", value: false }, { label: "Crea campo", value: true, primary: true }]);
    if (!ok) return;
    await ops([{ kind: "field_add", page: pno, box, type: t === "multiline" ? "text" : t, multiline: t === "multiline", name: name.value.trim(), tooltip: tip.value, required: req.checked,
      options: optsBox ? optsBox.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : undefined }]);
  }

  // ---------------------------------------------------------------- pannello delle proprieta' (a destra)
  const panel = el("div", { class: "pdf-panel", style: { display: "none", borderLeft: "1px solid var(--line)", background: "var(--panel)", overflow: "auto", padding: "10px 12px", fontSize: "12.5px" } });
  const row = (label, input) => el("label", { style: { display: "grid", gap: "3px", marginBottom: "8px" } }, el("span", { class: "note" }, label), input);
  const sel_ = (values, cur, onch) => { const s = el("select", { class: "field", style: { width: "100%" } }, ...values.map(v => (Array.isArray(v) ? el("option", { value: v[0], selected: v[0] === cur || undefined }, v[1]) : el("option", { value: v, selected: v === cur || undefined }, v)))); s.addEventListener("change", () => onch(s.value)); return s; };
  const inp_ = (type, val, onch, extra = {}) => { const i = el("input", { type, value: val ?? "", class: "field", style: { width: "100%" }, ...extra }); i.addEventListener("change", () => onch(type === "checkbox" ? i.checked : i.value)); return i; };
  const chk = (label, val, onch) => { const i = el("input", { type: "checkbox", checked: !!val }); i.addEventListener("change", () => onch(i.checked)); return el("label", { style: { display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px" } }, i, label); };
  function textStyleControls(o) {
    return [
      row("Carattere", sel_(FONTS, o.font, v => (o.font = v))),
      row("Dimensione (pt)", inp_("number", o.size, v => (o.size = +v), { min: 4, max: 200, step: 0.5 })),
      row("Colore", inp_("color", o.color, v => (o.color = v))),
      chk("Grassetto", o.bold, v => (o.bold = v)), chk("Corsivo", o.italic, v => (o.italic = v)),
    ];
  }
  function renderPanel() {
    panel.innerHTML = "";
    if (!mode) { panel.style.display = "none"; return; }
    panel.style.display = "";
    const h = t => el("b", { style: { display: "block", marginBottom: "8px" } }, t);
    if (mode === "typewriter") panel.append(h("Macchina da scrivere"), el("p", { class: "note" }, "Clic sulla pagina e scrivi. Invio va a capo; Ctrl+Invio o clic fuori conferma; Esc annulla."), ...textStyleControls(opt));
    else if (mode === "shape") panel.append(h("Forme"), row("Forma", sel_(SHAPES, opt.shape, v => (opt.shape = v))), row("Colore del bordo", inp_("color", opt.stroke, v => (opt.stroke = v))),
      chk("Riempimento", !!opt.fill, v => { opt.fill = v ? opt.fill || "#ffe0b2" : ""; renderPanel(); }), opt.fill ? row("Colore del riempimento", inp_("color", opt.fill, v => (opt.fill = v))) : "",
      row("Spessore (pt)", inp_("number", opt.width, v => (opt.width = +v), { min: 0.25, max: 20, step: 0.25 })), el("p", { class: "note" }, "Trascina sulla pagina per disegnare."));
    else if (mode === "field") panel.append(h("Campi modulo"), row("Tipo di campo", sel_(FIELD_TYPES, opt.field, v => { opt.field = v; decorateAll(); })),
      el("p", { class: "note" }, "Trascina un riquadro (o fai clic) dove deve stare il campo. Per compilare il modulo chiudi la modifica: i campi diventano compilabili e si salvano con il documento."));
    else if (mode === "image") panel.append(h("Immagine"), el("p", { class: "note" }, "Trascina un riquadro (o fai clic) dove inserire l'immagine, poi scegli il file. Per spostare, ridimensionare o sostituire immagini esistenti usa Oggetti."));
    else if (mode === "line") panel.append(h("Testo riga"), el("p", { class: "note" }, "Clic su una riga, scrivi e premi Invio: la riga si riscrive con lo stesso carattere, dimensione e colore. Per paragrafi interi usa Oggetti (doppio clic sul blocco)."));
    else if (["redact", "whiteout", "crop", "link"].includes(mode)) panel.append(h({ redact: "Oscura", whiteout: "Bianchetto", crop: "Ritaglia pagina", link: "Collegamento" }[mode]),
      el("p", { class: "note" }, { redact: "Trascina sulla zona da eliminare definitivamente (riquadro nero).", whiteout: "Trascina sulla zona da coprire di bianco (il contenuto sotto viene eliminato).", crop: "Trascina il riquadro della parte di pagina da tenere.", link: "Trascina il riquadro cliccabile, poi indica l'indirizzo web o il numero di pagina." }[mode]));
    else if (mode === "select") {
      if (!sel) { panel.append(h("Oggetti"), el("p", { class: "note" }, "Clic su un oggetto per selezionarlo; trascinalo per spostarlo, usa gli angoli per ridimensionarlo (Maiusc: proporzioni bloccate). Doppio clic su un testo per riscriverlo. Canc elimina.")); return; }
      const { o, pno } = sel;
      const apply = (label, fn) => el("button", { class: "btn primary", style: { marginRight: "6px" }, onclick: fn }, label);
      const del = el("button", { class: "btn danger", onclick: () => deleteObj() }, "Elimina");
      if (o.kind === "text") {
        const ta = el("textarea", { rows: 7, class: "field", style: { width: "100%", fontFamily: cssFont(o.font) } }, o.text);
        const st = { font: FONTS.find(f => o.font.toLowerCase().includes(f.split(" ")[0].toLowerCase())) || "Helvetica", size: o.size, color: o.color || "#000000", bold: o.bold, italic: o.italic, align: 0 };
        panel.append(h("Blocco di testo"), row("Testo", ta), ...textStyleControls(st), row("Allineamento", sel_([[0, "Sinistra"], [1, "Centro"], [2, "Destra"], [3, "Giustificato"]], 0, v => (st.align = +v))),
          el("div", {}, apply("Applica", () => ops([{ kind: "text_block", page: pno, box: o.box, text: ta.value, ...st }])), del));
      } else if (o.kind === "image") {
        panel.append(h("Immagine"), el("p", { class: "note" }, `${o.px?.[0] || "?"} × ${o.px?.[1] || "?"} pixel`),
          el("div", {}, apply("Sostituisci...", async () => { const data = await pickImage(); if (data) await ops([{ kind: "image_replace", page: pno, xref: o.xref, box: o.box, data }]); }), del));
      } else if (o.kind === "field") {
        const p = { name: o.name, tooltip: o.tooltip, value: o.value, fontsize: o.fontsize, required: o.required, readonly: o.readonly, multiline: o.multiline, options: o.options };
        const optsTa = el("textarea", { rows: 6, class: "field", style: { width: "100%" } }, (o.options || []).join("\n"));
        panel.append(h("Campo modulo · " + (FIELD_TYPES.find(f => f[0] === o.type)?.[1] || o.label)), row("Nome", inp_("text", o.name, v => (p.name = v))), row("Descrizione", inp_("text", o.tooltip, v => (p.tooltip = v))),
          o.type === "combo" || o.type === "list" ? row("Voci (una per riga)", optsTa) : "",
          o.type !== "check" && o.type !== "radio" && o.type !== "signature" ? row("Valore", inp_("text", o.value, v => (p.value = v))) : "",
          o.type === "text" || o.type === "combo" ? row("Dimensione testo (0 = automatica)", inp_("number", o.fontsize, v => (p.fontsize = +v), { min: 0, max: 72 })) : "",
          chk("Obbligatorio", o.required, v => (p.required = v)), chk("Sola lettura", o.readonly, v => (p.readonly = v)), o.type === "text" ? chk("Piu' righe", o.multiline, v => (p.multiline = v)) : "",
          el("div", {}, apply("Applica", () => { if (o.type === "combo" || o.type === "list") p.options = optsTa.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean); return ops([{ kind: "field_update", page: pno, xref: o.xref, props: p }]); }), del));
      } else if (o.kind === "link") panel.append(h("Collegamento"), el("p", {}, o.uri || `Pagina ${(o.page ?? 0) + 1}`), del);
      else if (o.kind === "group") panel.append(h("Gruppo di disegni"), el("p", { class: "note" }, `${o.n} tracciati · bordo ${o.stroke || "nessuno"} · riempimento ${o.fill || "nessuno"}`), del);
      else if (o.kind === "annot") panel.append(h("Annotazione · " + o.type), o.contents ? el("p", {}, o.contents) : "", del);
      else if (o.kind === "drawing") panel.append(h("Disegno vettoriale"), el("p", { class: "note" }, `Bordo ${o.stroke || "nessuno"} · riempimento ${o.fill || "nessuno"} · spessore ${o.width}`), del);
    }
  }

  // ---------------------------------------------------------------- barra degli strumenti
  const btns = {};
  const tool = (k, label, title) => (btns[k] = el("button", { type: "button", title, onclick: () => setMode(k) }, label));
  const pageMenu = el("select", { class: "field", title: "Operazioni sulla pagina corrente", onchange: async e => { const v = e.target.value; e.target.value = ""; if (v) await pageOp(v); } },
    el("option", { value: "" }, "Pagina..."), el("option", { value: "rotate" }, "Ruota di 90°"), el("option", { value: "dup" }, "Duplica"), el("option", { value: "blank" }, "Inserisci pagina bianca dopo"),
    el("option", { value: "insert" }, "Inserisci un PDF dopo questa pagina"), el("option", { value: "move" }, "Sposta in un'altra posizione"), el("option", { value: "crop" }, "Ritaglia..."), el("option", { value: "delete" }, "Elimina pagina"));
  const docMenu = el("select", { class: "field", title: "Operazioni sul documento", onchange: async e => { const v = e.target.value; e.target.value = ""; if (v) await docOp(v); } },
    el("option", { value: "" }, "Documento..."), el("option", { value: "meta" }, "Proprieta' (titolo, autore...)"), el("option", { value: "toc" }, "Segnalibri"), el("option", { value: "flatten" }, "Appiattisci moduli e annotazioni"));
  const bar = el("div", { class: "tb", style: { display: "none", flexWrap: "wrap", gap: "4px", borderTop: "1px solid var(--line)" } },
    tool("select", "Oggetti", "Seleziona, sposta, ridimensiona, modifica ed elimina testi, immagini, disegni, campi e collegamenti"),
    tool("line", "Testo riga", "Riscrive una riga di testo con lo stesso carattere"), tool("typewriter", "Macchina da scrivere", "Scrivi in qualsiasi punto della pagina"),
    tool("image", "Immagine", "Inserisci un'immagine"), tool("shape", "Forme", "Rettangoli, ellissi, linee, frecce"), tool("field", "Campi modulo", "Campi di testo, menu a tendina, caselle di spunta..."),
    tool("link", "Collegamento", "Area cliccabile verso un sito o una pagina"), el("span", { class: "sep" }), tool("whiteout", "Bianchetto", "Copre di bianco una zona"), tool("redact", "Oscura", "Elimina definitivamente una zona (riquadro nero)"),
    el("span", { class: "sep" }), el("button", { type: "button", title: "Annulla l'ultima modifica", onclick: () => undoLast() }, "Annulla"), el("button", { type: "button", title: "Ripeti", onclick: () => redoLast() }, "Ripeti"),
    el("span", { class: "sep" }), pageMenu, docMenu);

  async function pageOp(v) {
    const p = curPage(), n = app()?.pagesCount || 1;
    if (v === "rotate") return ops([{ kind: "page_rotate", page: p, angle: 90 }]);
    if (v === "dup") return ops([{ kind: "page_duplicate", page: p }]);
    if (v === "blank") return ops([{ kind: "page_blank", at: p + 1 }]);
    if (v === "delete") { if (n < 2) return toast("Il documento ha una sola pagina", true); if (await confirmBox("Elimina pagina", `Eliminare la pagina ${p + 1}?`, "Elimina", true)) return ops([{ kind: "page_delete", page: p }]); return; }
    if (v === "move") { const s = await askText("Sposta pagina", `Nuova posizione della pagina ${p + 1} (1-${n})`, String(n)); const to = parseInt(s, 10); if (to >= 1 && to <= n) return ops([{ kind: "page_move", page: p, to_page: to > p + 1 ? to : to - 1 }]); return; }
    if (v === "insert") { const fs = await pickFiles(); const f = fs?.find(x => /\.pdf$/i.test(x)); if (f) return ops([{ kind: "page_insert_pdf", file: f, at: p + 1 }]); return; }
    if (v === "crop") return setMode("crop");
  }
  async function docOp(v) {
    if (!objCache.size) { try { const d = await api("pdf_objects", { path: work || ctx.path, page: 0 }); meta = d.metadata; toc = d.toc; } catch { /* */ } }
    if (v === "meta") {
      const f = {};
      const rows = ["title", "author", "subject", "keywords"].map(k => row({ title: "Titolo", author: "Autore", subject: "Oggetto", keywords: "Parole chiave" }[k], (f[k] = el("input", { type: "text", class: "field", value: meta[k] || "", style: { width: "100%" } }))));
      if (await modal("Proprieta' del documento", el("div", { style: { minWidth: "360px" } }, ...rows), [{ label: "Annulla", value: false }, { label: "Salva", value: true, primary: true }]))
        return ops([{ kind: "metadata", ...Object.fromEntries(Object.entries(f).map(([k, i]) => [k, i.value])) }]);
      return;
    }
    if (v === "toc") {
      const ta = el("textarea", { rows: 14, class: "field", style: { width: "100%", fontFamily: "Consolas, monospace" } }, toc.map(([l, t, p]) => "  ".repeat(l - 1) + `${t} | ${p}`).join("\n"));
      if (!(await modal("Segnalibri", el("div", { style: { minWidth: "420px", display: "grid", gap: "6px" } }, el("p", { class: "note", style: { margin: 0 } }, "Una riga per segnalibro: Titolo | pagina. Rientra di due spazi per i sottolivelli."), ta),
        [{ label: "Annulla", value: false }, { label: "Salva", value: true, primary: true }]))) return;
      const items = ta.value.split(/\r?\n/).filter(s => s.trim()).map(s => { const lvl = Math.floor((s.match(/^ */)[0].length) / 2) + 1; const [t, p] = s.trim().split("|").map(x => x.trim()); return [lvl, t, parseInt(p, 10) || 1]; });
      return ops([{ kind: "toc", items }]);
    }
    if (v === "flatten" && await confirmBox("Appiattisci", "Appiattire moduli e annotazioni? Diventano parte fissa della pagina e non saranno piu' modificabili.")) return ops([{ kind: "flatten" }]);
  }

  function decorateAll() {
    const a = app();
    if (!a?.pdfViewer) return;
    clearLayers();
    if (!mode) return;
    for (let i = 0; i < a.pagesCount; i++) { const pv = a.pdfViewer.getPageView(i); if (pv?.div && pv.viewport) decoratePage(pv); }
  }
  let hooked = false;
  function hook() {
    if (hooked || !app()) return;
    hooked = true;
    app().eventBus.on("pagerendered", e => { if (mode) decoratePage(app().pdfViewer.getPageView(e.pageNumber - 1)); });
    doc().addEventListener("keydown", e => {
      if (mode !== "select" || !sel || e.target.closest?.("textarea, input, [contenteditable=plaintext-only]")) return;
      if (e.key === "Delete") { e.preventDefault(); deleteObj(); }
      if (e.key === "Escape") { sel = null; decorateAll(); renderPanel(); }
    }, true);
  }
  function setMode(m) {
    hook();
    injectCss();
    mode = m;
    sel = null;
    for (const [k, b] of Object.entries(btns)) b.classList.toggle("on", k === mode);
    try { if (mode) app().pdfViewer.annotationEditorMode = { mode: 0 }; } catch { /* */ }
    decorateAll();
    renderPanel();
    return mode;
  }

  return {
    bar, panel,
    get mode() { return mode; },
    get on() { return bar.style.display !== "none"; },
    toggle() {
      const show = bar.style.display === "none";
      bar.style.display = show ? "flex" : "none";
      setMode(show ? "select" : null);
      return show;
    },
    setMode, undoLast,
    hasUndo: () => undo.length > 0,
    async currentFile() { if (work) await flushAnnotations(); return work || ctx.path; },
  };
}
