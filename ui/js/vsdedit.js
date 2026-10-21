// Editor di diagrammi in stile Microsoft Visio: barra multifunzione (Home, Inserisci, Progettazione, Visualizza),
// pannello Forme a sinistra (stencil e "Forme del documento"), pagine in basso, riquadri Dati forma e Dimensioni e
// posizione a destra, zoom e ricerca. Modifica: seleziona/sposta/ridimensiona/ruota, testo sul posto, forme base e
// connettori dinamici che seguono le forme, gruppi, ordine, livelli, dati della forma; Annulla/Ripeti.
// Il disegno e' di ui/js/vsdrender.js, le modifiche di ui/js/vsdops.js; il puntatore resta sempre la freccia.
import { el, toast, modal, askText, confirmBox, api, pickFiles, readBytes, extOf, baseName, loadCss, WEB } from "./core.js";
import { keymap, describeKeys } from "./shortcuts.js";
import { vsIcon } from "./vsdicons.js";
import { buildShapes, num0, val, cell, plainText, shapeName, is1D, snapshot, restore, saveVsdx, addPage, deletePage, addImagePart, markDirty, setCell, VNS, color as vColor, textEl } from "./vsdmodel.js";
import { renderPage, opsSvg, pageSvg, pageInfo, layersOf, textMatrix, ap, inv, mul, localXf, opsBox } from "./vsdrender.js";
import * as O from "./vsdops.js";
import { STENCILS, shapeIcon } from "./vsdshapes.js";

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const STD = ["#ffffff", "#000000", "#e7e6e6", "#44546a", "#5b9bd5", "#ed7d31", "#a5a5a5", "#ffc000", "#4472c4", "#70ad47",
  "#c00000", "#ff0000", "#ffc000", "#ffff00", "#92d050", "#00b050", "#00b0f0", "#0070c0", "#002060", "#7030a0"];
const WEIGHTS = [0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6];
const PATTERNS = [[1, "Continua"], [2, "Tratteggiata"], [3, "Punteggiata"], [4, "Tratto punto"], [9, "Tratto lungo"], [10, "Tratto corto"]];
const ARROWS = [[0, "Nessuna"], [4, "Triangolo pieno"], [13, "Freccia piena"], [1, "Freccia aperta"], [10, "Cerchio"]];
const PAGE_SIZES = [["A4", 210, 297], ["A3", 297, 420], ["A5", 148, 210], ["A2", 420, 594], ["A1", 594, 841], ["Lettera", 215.9, 279.4], ["Legale", 215.9, 355.6], ["Tabloid", 279.4, 431.8]];
const MMIN = 1 / 25.4;

export function createVisio(ctx, doc, opts = {}) {
  const readOnly = !!opts.readOnly;
  let pageIdx = Math.max(0, doc.pages.findIndex(p => !p.background));
  let model = null, R = null, scale = 1, sel = [], tool = "pointer", editing = null, showGrid = true;
  const undo = [], redo = [];
  const models = new Map();
  const page = () => doc.pages[pageIdx];
  const getModel = p => { if (!models.has(p)) models.set(p, p.xml ? buildShapes(doc, p) : { top: [], all: new Map(), connects: [] }); return models.get(p); };
  const info = () => R?.info || pageInfo(doc, page());
  const isMM = () => /MM|CM|M$/i.test(info().units || "");
  const toUnit = v => isMM() ? v * 25.4 : v;
  const fromUnit = v => isMM() ? v / 25.4 : v;
  const uName = () => isMM() ? "mm" : "in";
  const fmtU = v => (Math.round(toUnit(v) * 100) / 100).toLocaleString("it-IT") + " " + uName();

  // ------------------------------------------------------------------ struttura
  loadCss("css/visio.css");
  ctx.el.innerHTML = "";
  ctx.fillBody(true);
  const root = el("div", { class: "vs-root" });
  const ribbon = el("div", { class: "vs-ribbon" });
  const left = el("aside", { class: "vs-left" });
  const right = el("aside", { class: "vs-right" });
  const canvas = el("div", { class: "vs-canvas", tabindex: "0" });
  const stage = el("div", { class: "vs-stage" });
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "vs-page");
  stage.append(svg);
  canvas.append(stage);
  const pagebar = el("div", { class: "vs-pagebar" });
  const status = el("div", { class: "vs-status" });
  const main = el("div", { class: "vs-main" }, left, canvas, right);
  root.append(ribbon, main, pagebar, status);
  ctx.el.append(root);
  const textBox = el("textarea", { class: "vs-textedit", spellcheck: "false", hidden: true });
  stage.append(textBox);

  // ------------------------------------------------------------------ immagini (EMF/WMF convertite in PNG dal motore)
  const media = new Map(); // percorso -> { url, bytes, mime }
  async function loadMedia() {
    const keys = new Set();
    for (const p of doc.pages) for (const r of p.rels.values()) if (/\/image$/.test(r.type)) keys.add(r.target);
    for (const M of doc.masters.values()) for (const r of M.rels.values()) if (/\/image$/.test(r.type)) keys.add(r.target);
    await Promise.all([...keys].filter(k => !media.has(k)).map(async k => {
      const f = doc.zip.file(k);
      if (!f) return;
      let bytes = await f.async("uint8array"), mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", svg: "image/svg+xml", tif: "image/tiff", tiff: "image/tiff" }[extOf(k)];
      if (/^(emf|wmf|emz|wmz)$/.test(extOf(k))) {
        if (WEB) return;
        try { const r = await api("visio_metafile", {}, { body: bytes, raw: true }); if (!r.ok) return; bytes = new Uint8Array(await r.arrayBuffer()); mime = "image/png"; } catch { return; }
      }
      if (!mime) return;
      media.set(k, { bytes, mime, url: URL.createObjectURL(new Blob([bytes], { type: mime })) });
    }));
  }
  const imgUrl = k => media.get(k)?.url;
  const dataUrl = k => { const m = media.get(k); if (!m) return null; let s = ""; for (let i = 0; i < m.bytes.length; i += 0x8000) s += String.fromCharCode(...m.bytes.subarray(i, i + 0x8000)); return `data:${m.mime};base64,${btoa(s)}`; };

  // ------------------------------------------------------------------ disegno della pagina
  function render() {
    const P = page();
    model = getModel(P);
    R = renderPage(doc, P, model, { models: getModel });
    const { wPt, hPt } = R.info;
    svg.setAttribute("viewBox", `0 0 ${wPt} ${hPt}`);
    const defs = [];
    let body = `<rect class="vs-paper" x="0" y="0" width="${wPt}" height="${hPt}" fill="#ffffff"/>`;
    if (showGrid) body += gridSvg(R.info);
    body += `<g class="vs-back">${opsSvg(R.back, imgUrl, defs)}</g><g class="vs-shapes">`;
    R.items.forEach((it, i) => { body += `<g data-i="${i}">${opsSvg(it.ops, imgUrl, defs)}${hitSvg(it.S)}</g>`; });
    body += `</g><g class="vs-ui"></g>`;
    svg.innerHTML = (defs.length ? `<defs>${defs.join("")}</defs>` : "") + body;
    sizeStage();
    sel = sel.map(S => model.all.get(S.id)).filter(Boolean);
    overlay();
    renderPages();
    updatePanels();
  }
  function gridSvg(inf) {
    const stepIn = isMM() ? 10 * MMIN : 0.5;
    const step = stepIn * 72 * inf.r;
    if (step * scale < 6) return "";
    let d = "";
    for (let x = step; x < inf.wPt; x += step) d += `M${x.toFixed(2)} 0V${inf.hPt.toFixed(2)}`;
    for (let y = inf.hPt - step; y > 0; y -= step) d += `M0 ${y.toFixed(2)}H${inf.wPt.toFixed(2)}`;
    return `<path class="vs-grid" d="${d}" fill="none" stroke="#c9d4e0" stroke-width="${(0.6 / scale).toFixed(3)}"/>`;
  }
  // elemento invisibile per il clic: riquadro della forma o percorso del connettore
  function hitSvg(S) {
    try {
      if (is1D(doc, S)) {
        const it = R?.items?.find(x => x.S === S);
        const d = it?.ops.find(o => o.t === "path" && o.stroke)?.d;
        if (d) return `<path class="vs-hit" d="${d.map(c => c[0] === "Z" ? "Z" : c[0] + c.slice(1).map(v => v.toFixed(2)).join(" ")).join("")}" fill="none" stroke="transparent" stroke-width="${(8 / scale).toFixed(2)}"/>`;
      }
      const pts = O.boxCorners(doc, S).map(p => toPt(p));
      return `<polygon class="vs-hit" points="${pts.map(p => p.map(v => v.toFixed(2)).join(",")).join(" ")}" fill="transparent"/>`;
    } catch { return ""; }
  }
  // pollici del disegno <-> punti della pagina
  const toPt = p => { const i = info(); return [p[0] * 72 * i.r, (i.H - p[1]) * 72 * i.r]; };
  const fromPt = p => { const i = info(); return [p[0] / (72 * i.r), i.H - p[1] / (72 * i.r)]; };
  function evPt(e) {
    const m = svg.getScreenCTM();
    if (!m) return [0, 0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [p.x, p.y];
  }
  function sizeStage() {
    const { wPt, hPt } = info();
    const w = wPt * scale, h = hPt * scale;
    svg.style.width = w + "px"; svg.style.height = h + "px";
    const pad = 80;
    stage.style.width = Math.max(canvas.clientWidth, w + pad * 2) + "px";
    stage.style.height = Math.max(canvas.clientHeight, h + pad * 2) + "px";
    svg.style.left = Math.max(pad, (stage.clientWidth - w) / 2) + "px";
    svg.style.top = Math.max(pad, (stage.clientHeight - h) / 2) + "px";
    zoomLab.textContent = Math.round(scale * 100 / (96 / 72)) + "%";
    zoomRange.value = String(Math.round(Math.log2(scale / (96 / 72)) * 100));
  }
  function setZoom(s, anchor) {
    const old = scale;
    s = clamp(s, 0.05, 40);
    let keep = null;
    if (anchor) { const r = canvas.getBoundingClientRect(); keep = { pt: evPt(anchor), cx: anchor.clientX - r.left, cy: anchor.clientY - r.top }; }
    scale = s;
    sizeStage();
    if (keep) {
      const sx = parseFloat(svg.style.left) + keep.pt[0] * scale, sy = parseFloat(svg.style.top) + keep.pt[1] * scale;
      canvas.scrollLeft = sx - keep.cx; canvas.scrollTop = sy - keep.cy;
    }
    if (Math.abs(old - s) > 1e-9) { if (showGrid) render(); else overlay(); }
  }
  function fitPage() {
    const { wPt, hPt } = info();
    const s = Math.min((canvas.clientWidth - 40) / wPt, (canvas.clientHeight - 40) / hPt);
    scale = clamp(s > 0 ? s : 1, 0.05, 40);
    render();
    canvas.scrollLeft = (stage.clientWidth - canvas.clientWidth) / 2;
    canvas.scrollTop = (stage.clientHeight - canvas.clientHeight) / 2;
  }
  function fitWidth() { scale = clamp((canvas.clientWidth - 40) / info().wPt, 0.05, 40); render(); canvas.scrollLeft = (stage.clientWidth - canvas.clientWidth) / 2; }
  function showShape(S) {
    const b = O.bounds(doc, [S]);
    const a = toPt([b[0], b[3]]), c = toPt([b[2], b[1]]);
    const x = parseFloat(svg.style.left) + (a[0] + c[0]) / 2 * scale, y = parseFloat(svg.style.top) + (a[1] + c[1]) / 2 * scale;
    canvas.scrollLeft = x - canvas.clientWidth / 2; canvas.scrollTop = y - canvas.clientHeight / 2;
  }

  // ------------------------------------------------------------------ selezione e maniglie
  const uiG = () => svg.querySelector(".vs-ui");
  const hs = () => 7 / scale;
  function overlay(preview) {
    const g = uiG();
    if (!g) return;
    let s = "";
    const k = 1 / scale;
    for (const S of sel) {
      if (is1D(doc, S)) {
        const b = toPt(endPage(S, "begin")), e = toPt(endPage(S, "end"));
        s += `<path d="M${b[0]} ${b[1]}L${e[0]} ${e[1]}" stroke="#1f6fc5" stroke-width="${k}" stroke-dasharray="${3 * k} ${2 * k}" fill="none"/>`;
        if (sel.length === 1 && !readOnly) for (const [p, h] of [[b, "begin"], [e, "end"]]) s += `<rect data-h="${h}" x="${p[0] - hs() / 2}" y="${p[1] - hs() / 2}" width="${hs()}" height="${hs()}" fill="${glued(S, h) ? "#3ba55c" : "#ffffff"}" stroke="#1f6fc5" stroke-width="${k}"/>`;
        continue;
      }
      const c = O.boxCorners(doc, S).map(toPt);
      s += `<polygon points="${c.map(p => p.join(",")).join(" ")}" fill="none" stroke="#1f6fc5" stroke-width="${k}" ${sel.length > 1 ? `stroke-dasharray="${3 * k} ${2 * k}"` : ""}/>`;
      if (sel.length === 1 && !readOnly) {
        const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const H = [["sw", c[0]], ["s", mid(c[0], c[1])], ["se", c[1]], ["e", mid(c[1], c[2])], ["ne", c[2]], ["n", mid(c[2], c[3])], ["nw", c[3]], ["w", mid(c[3], c[0])]];
        for (const [h, p] of H) s += `<rect data-h="${h}" x="${p[0] - hs() / 2}" y="${p[1] - hs() / 2}" width="${hs()}" height="${hs()}" fill="#ffffff" stroke="#1f6fc5" stroke-width="${k}"/>`;
        // maniglia di rotazione sopra il lato superiore
        const top = mid(c[2], c[3]), ctr = mid(c[0], c[2]);
        const dx = top[0] - ctr[0], dy = top[1] - ctr[1], L = Math.hypot(dx, dy) || 1;
        const rp = [top[0] + dx / L * 18 * k, top[1] + dy / L * 18 * k];
        s += `<path d="M${top[0]} ${top[1]}L${rp[0]} ${rp[1]}" stroke="#1f6fc5" stroke-width="${k}"/><circle data-h="rot" cx="${rp[0]}" cy="${rp[1]}" r="${hs() / 1.6}" fill="#ffffff" stroke="#1f6fc5" stroke-width="${k}"/>`;
      }
    }
    if (preview) s += preview;
    g.innerHTML = s;
  }
  function endPage(S, which) {
    const p = which === "begin" ? [num0(doc, S, "BeginX"), num0(doc, S, "BeginY")] : [num0(doc, S, "EndX"), num0(doc, S, "EndY")];
    return S.parent ? ap(O.toPageM(doc, S.parent), ...p) : p;
  }
  const glued = (S, which) => model.connects.some(c => c.from === S.id && c.fromCell === (which === "begin" ? "BeginX" : "EndX"));
  function setSel(list) { sel = list.filter(Boolean); overlay(); updatePanels(); updateRibbon(); }
  function selectById(ids) { setSel(ids.map(id => model.all.get(id)).filter(S => S && !S.parent)); }

  // ------------------------------------------------------------------ comandi con Annulla
  let busy = false;
  async function run(fn, keepSel = true) {
    if (readOnly) { toast("Il diagramma e' in sola lettura", true); return; }
    if (busy) return;
    busy = true;
    try {
      const snap = await snapshot(doc);
      const ids = sel.map(S => S.id);
      const r = await fn();
      undo.push({ snap, page: pageIdx, ids });
      if (undo.length > 60) undo.shift();
      redo.length = 0;
      models.clear();
      render();
      if (Array.isArray(r)) selectById(r);
      else if (keepSel) selectById(ids);
      ctx.setDirty(true);
      return r;
    } catch (e) { console.error(e); toast("Operazione non riuscita: " + e.message, true); }
    finally { busy = false; }
  }
  async function doUndo(from, to) {
    const st = from.pop();
    if (!st) return;
    to.push({ snap: await snapshot(doc), page: pageIdx, ids: sel.map(S => S.id) });
    await restore(doc, st.snap);
    models.clear();
    pageIdx = clamp(st.page, 0, doc.pages.length - 1);
    render();
    selectById(st.ids);
    ctx.setDirty(true);
  }

  // ------------------------------------------------------------------ mouse
  let drag = null, spaceDown = false;
  const hitShape = e => {
    const g = e.target.closest?.("g[data-i]");
    if (!g || !svg.contains(g)) return null;
    return R.items[+g.dataset.i]?.S || null;
  };
  function shapeAt(pt, exclude) {
    // la forma piu' in alto sotto il punto (per incollare i connettori)
    const els = document.elementsFromPoint(pt.clientX, pt.clientY);
    for (const n of els) { const g = n.closest?.("g[data-i]"); if (g && svg.contains(g)) { const S = R.items[+g.dataset.i]?.S; if (S && S !== exclude && !is1D(doc, S)) return S; } }
    return null;
  }
  const snapStep = () => isMM() ? MMIN : 1 / 16;
  const snap = (v, e) => e?.altKey ? v : Math.round(v / snapStep()) * snapStep();
  canvas.addEventListener("pointerdown", e => {
    canvas.focus({ preventScroll: true });
    if (editing && e.target !== textBox) endEdit();
    if (e.button === 1 || (e.button === 0 && spaceDown)) { drag = { kind: "pan", x: e.clientX, y: e.clientY, sl: canvas.scrollLeft, st: canvas.scrollTop }; canvas.setPointerCapture(e.pointerId); e.preventDefault(); return; }
    if (e.button !== 0 || e.target === textBox) return;
    const p = evPt(e), pin = fromPt(p);
    const h = e.target.getAttribute?.("data-h");
    if (h && sel.length === 1) {
      const S = sel[0];
      drag = { kind: h === "rot" ? "rot" : h === "begin" || h === "end" ? "end" : "size", h, S, p0: p, m: localXf(doc, S), pm: O.toPageM(doc, S), W: num0(doc, S, "Width"), H: num0(doc, S, "Height") };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    const S = hitShape(e);
    if (tool !== "pointer" && !readOnly) {
      drag = { kind: "tool", tool, p0: p, start: S, e0: e };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (S) {
      if (e.shiftKey || e.ctrlKey) { setSel(sel.includes(S) ? sel.filter(x => x !== S) : [...sel, S]); if (!sel.includes(S)) return; }
      else if (!sel.includes(S)) setSel([S]);
      if (!readOnly) { drag = { kind: "move", p0: p, d: [0, 0], moved: false }; canvas.setPointerCapture(e.pointerId); }
    } else {
      if (!e.shiftKey) setSel([]);
      drag = { kind: "band", p0: p, add: e.shiftKey };
      canvas.setPointerCapture(e.pointerId);
    }
    void pin;
  });
  canvas.addEventListener("pointermove", e => {
    if (!drag) return;
    if (drag.kind === "pan") { canvas.scrollLeft = drag.sl - (e.clientX - drag.x); canvas.scrollTop = drag.st - (e.clientY - drag.y); return; }
    const p = evPt(e);
    const k = 1 / scale;
    if (drag.kind === "move") {
      let dx = p[0] - drag.p0[0], dy = p[1] - drag.p0[1];
      if (!drag.moved && Math.hypot(dx, dy) * scale < 3) return;
      drag.moved = true;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      const i = info();
      const din = [snap(dx / (72 * i.r), e), snap(-dy / (72 * i.r), e)];
      drag.d = din;
      const tx = din[0] * 72 * i.r, ty = -din[1] * 72 * i.r;
      for (const S of sel) { const idx = R.items.findIndex(it => it.S === S); svg.querySelector(`g[data-i="${idx}"]`)?.setAttribute("transform", `translate(${tx} ${ty})`); }
      uiG().setAttribute("transform", `translate(${tx} ${ty})`);
      statusText(`Sposta: X ${fmtU(din[0])}, Y ${fmtU(din[1])}`);
    } else if (drag.kind === "band") {
      const a = drag.p0;
      overlay(`<rect x="${Math.min(a[0], p[0])}" y="${Math.min(a[1], p[1])}" width="${Math.abs(p[0] - a[0])}" height="${Math.abs(p[1] - a[1])}" fill="rgba(31,111,197,.08)" stroke="#1f6fc5" stroke-width="${k}" stroke-dasharray="${3 * k} ${2 * k}"/>`);
      drag.p1 = p;
    } else if (drag.kind === "size") {
      const box = sizeBox(drag, p, e);
      drag.box = box;
      const pts = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]].map(q => toPt(ap(parentM(drag.S), ...ap(drag.m, ...q))));
      overlay(`<polygon points="${pts.map(q => q.join(",")).join(" ")}" fill="none" stroke="#1f6fc5" stroke-width="${k}" stroke-dasharray="${3 * k} ${2 * k}"/>`);
      statusText(`Larghezza: ${fmtU(box[2] - box[0])}  Altezza: ${fmtU(box[3] - box[1])}`);
    } else if (drag.kind === "rot") {
      const c = toPt(ap(drag.pm, num0(doc, drag.S, "LocPinX"), num0(doc, drag.S, "LocPinY")));
      let a = Math.atan2(-(p[1] - c[1]), p[0] - c[0]) - Math.PI / 2;
      const step = e.shiftKey ? Math.PI / 12 : Math.PI / 180;
      a = Math.round(a / step) * step;
      drag.angle = a;
      const S = drag.S, W = drag.W, H = drag.H;
      const m = mul(mul([1, 0, 0, 1, ...fromPt(c)], [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]), [1, 0, 0, 1, -num0(doc, S, "LocPinX"), -num0(doc, S, "LocPinY")]);
      const pts = [[0, 0], [W, 0], [W, H], [0, H]].map(q => toPt(ap(m, ...q)));
      overlay(`<polygon points="${pts.map(q => q.join(",")).join(" ")}" fill="none" stroke="#1f6fc5" stroke-width="${k}" stroke-dasharray="${3 * k} ${2 * k}"/>`);
      statusText(`Angolo: ${Math.round(((a * 180 / Math.PI) % 360 + 360) % 360)}°`);
    } else if (drag.kind === "end") {
      const other = toPt(endPage(drag.S, drag.h === "begin" ? "end" : "begin"));
      const T = shapeAt(e, drag.S);
      drag.target = T;
      let s = `<path d="M${other[0]} ${other[1]}L${p[0]} ${p[1]}" stroke="#1f6fc5" stroke-width="${k}" stroke-dasharray="${3 * k} ${2 * k}"/>`;
      if (T) s += `<polygon points="${O.boxCorners(doc, T).map(toPt).map(q => q.join(",")).join(" ")}" fill="none" stroke="#3ba55c" stroke-width="${2 * k}"/>`;
      overlay(s);
      drag.p1 = p;
    } else if (drag.kind === "tool") {
      const a = drag.p0;
      drag.p1 = p;
      if (drag.tool === "connector" || drag.tool === "line") {
        const T = drag.tool === "connector" ? shapeAt(e, drag.start) : null;
        drag.target = T;
        let s = `<path d="M${a[0]} ${a[1]}L${p[0]} ${p[1]}" stroke="#1f6fc5" stroke-width="${k}"/>`;
        for (const X of [drag.tool === "connector" ? drag.start : null, T]) if (X && !is1D(doc, X)) s += `<polygon points="${O.boxCorners(doc, X).map(toPt).map(q => q.join(",")).join(" ")}" fill="none" stroke="#3ba55c" stroke-width="${2 * k}"/>`;
        overlay(s);
      } else {
        let w = p[0] - a[0], h = p[1] - a[1];
        if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
        const x = Math.min(a[0], a[0] + w), y = Math.min(a[1], a[1] + h);
        overlay(drag.tool === "ellipse" ? `<ellipse cx="${x + Math.abs(w) / 2}" cy="${y + Math.abs(h) / 2}" rx="${Math.abs(w) / 2}" ry="${Math.abs(h) / 2}" fill="none" stroke="#1f6fc5" stroke-width="${k}"/>` : `<rect x="${x}" y="${y}" width="${Math.abs(w)}" height="${Math.abs(h)}" fill="none" stroke="#1f6fc5" stroke-width="${k}" ${drag.tool === "text" ? `stroke-dasharray="${3 * k} ${2 * k}"` : ""}/>`);
      }
    }
  });
  const parentM = S => S.parent ? O.toPageM(doc, S.parent) : [1, 0, 0, 1, 0, 0];
  function sizeBox(d, p, e) {
    // punto nel sistema locale della forma (prima della modifica)
    const q = ap(inv(mul(parentM(d.S), d.m)), ...fromPt(p));
    let [x0, y0, x1, y1] = [0, 0, d.W, d.H];
    if (d.h.includes("w")) x0 = Math.min(q[0], x1 - 1e-3); if (d.h.includes("e")) x1 = Math.max(q[0], x0 + 1e-3);
    if (d.h.includes("s")) y0 = Math.min(q[1], y1 - 1e-3); if (d.h.includes("n")) y1 = Math.max(q[1], y0 + 1e-3);
    const keepRatio = (d.h.length === 2) !== e.shiftKey && (S2 => S2.el?.getAttribute("Type") === "Foreign" || num0(doc, S2, "LockAspect"))(d.S) || (d.h.length === 2 && e.shiftKey);
    if (keepRatio && d.W && d.H) {
      const k = Math.max((x1 - x0) / d.W, (y1 - y0) / d.H);
      if (d.h.includes("w")) x0 = x1 - d.W * k; else x1 = x0 + d.W * k;
      if (d.h.includes("s")) y0 = y1 - d.H * k; else y1 = y0 + d.H * k;
    }
    const st = snapStep();
    if (!e.altKey) { const r = v => Math.round(v / st) * st; if (d.h.includes("w")) x0 = x1 - r(x1 - x0); if (d.h.includes("e")) x1 = x0 + r(x1 - x0); if (d.h.includes("s")) y0 = y1 - r(y1 - y0); if (d.h.includes("n")) y1 = y0 + r(y1 - y0); }
    return [x0, y0, x1, y1];
  }
  canvas.addEventListener("pointerup", async e => {
    const d = drag;
    drag = null;
    if (!d) return;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* */ }
    if (d.kind === "pan") return;
    if (d.kind === "move") {
      for (const g of svg.querySelectorAll("g[data-i][transform]")) g.removeAttribute("transform");
      uiG()?.removeAttribute("transform");
      if (!d.moved || (!d.d[0] && !d.d[1])) { overlay(); return; }
      const list = [...sel];
      await run(() => { O.moveShapes(doc, page(), model, list, d.d[0], d.d[1]); O.rerouteFor(doc, page(), model, new Set(list.map(S => S.id)), new Set(list.map(S => S.id))); });
      return;
    }
    if (d.kind === "band") {
      overlay();
      if (!d.p1) return;
      const a = fromPt(d.p0), b = fromPt(d.p1);
      const box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      if (box[2] - box[0] < 1e-4) return;
      const hits = model.top.filter(S => { try { const bb = O.bounds(doc, [S]); return bb[0] >= box[0] && bb[1] >= box[1] && bb[2] <= box[2] && bb[3] <= box[3] && R.items.find(it => it.S === S)?.ops.length; } catch { return false; } });
      setSel(d.add ? [...new Set([...sel, ...hits])] : hits);
      return;
    }
    if (d.kind === "size" && d.box) {
      const S = d.S;
      await run(() => { O.resizeShape(doc, page(), model, S, d.box); O.rerouteFor(doc, page(), getFresh(), new Set([S.id])); });
      return;
    }
    if (d.kind === "rot" && d.angle != null) {
      const S = d.S;
      // la rotazione avviene attorno al pin
      await run(() => { O.rotateShape(doc, page(), S, d.angle); O.rerouteFor(doc, page(), getFresh(), new Set([S.id])); });
      return;
    }
    if (d.kind === "end" && d.p1) {
      const S = d.S, T = d.target, which = d.h;
      const pt = fromPt(d.p1);
      await run(() => {
        const other = endPage(S, which === "begin" ? "end" : "begin");
        const b = which === "begin" ? pt : other, en = which === "begin" ? other : pt;
        O.setEndpoints(doc, page(), model, S, b, en);
        O.glue(doc, page(), S, which, T || null);
        if (T) { const m2 = getFresh(); O.reroute(doc, page(), m2, m2.all.get(S.id)); }
      });
      return;
    }
    if (d.kind === "tool") { await finishTool(d, e); return; }
  });
  const getFresh = () => { models.delete(page()); model = getModel(page()); return model; };
  canvas.addEventListener("dblclick", e => {
    const S = hitShape(e);
    if (S && !readOnly) beginEdit(S);
  });
  canvas.addEventListener("wheel", e => {
    if (e.ctrlKey) { e.preventDefault(); setZoom(scale * Math.exp(-e.deltaY * 0.0015), e); }
  }, { passive: false });
  canvas.addEventListener("contextmenu", e => {
    e.preventDefault();
    const S = hitShape(e);
    if (S && !sel.includes(S)) setSel([S]);
    openMenu({ x: e.clientX, y: e.clientY }, sel.length ? [
      { label: "Taglia", icon: "cut", keys: "Ctrl+X", run: cut }, { label: "Copia", icon: "copy", keys: "Ctrl+C", run: copy }, { label: "Incolla", icon: "paste", keys: "Ctrl+V", run: paste, dis: () => !clip },
      "-", { label: "Modifica testo", icon: "textTool", keys: "F2", run: () => beginEdit(sel[0]), dis: () => sel.length !== 1 },
      { label: "Porta in primo piano", icon: "bringFront", keys: "Ctrl+Maiusc+F", run: () => cmdZ("front") }, { label: "Porta sullo sfondo", icon: "sendBackmost", keys: "Ctrl+Maiusc+B", run: () => cmdZ("back") },
      { label: "Raggruppa", icon: "group", keys: "Ctrl+G", run: cmdGroup, dis: () => sel.length < 2 }, { label: "Separa", icon: "ungroup", keys: "Ctrl+Maiusc+U", run: cmdUngroup, dis: () => !sel.some(S2 => S2.el?.getAttribute("Type") === "Group") },
      "-", { label: "Dati forma...", icon: "shapedata", run: () => { panels.data = true; updatePanels(); } }, { label: "Elimina", icon: "trash", keys: "Canc", run: cmdDelete },
    ] : [{ label: "Incolla", icon: "paste", keys: "Ctrl+V", run: paste, dis: () => !clip }, { label: "Seleziona tutto", icon: "select", keys: "Ctrl+A", run: () => setSel(model.top) }, "-", { label: "Adatta alla finestra", icon: "zoomPage", keys: "Ctrl+Maiusc+W", run: fitPage }]);
  });
  window.addEventListener("keydown", e => { if (e.key === " " && !e.target.closest?.("input, textarea, select")) spaceDown = true; });
  window.addEventListener("keyup", e => { if (e.key === " ") spaceDown = false; });

  async function finishTool(d, e) {
    overlay();
    const a = fromPt(d.p0), b = fromPt(d.p1 || d.p0);
    const P = page();
    const dragged = d.p1 && Math.hypot(d.p1[0] - d.p0[0], d.p1[1] - d.p0[1]) * scale > 4;
    if (d.tool === "text") {
      if (!dragged && d.start && !is1D(doc, d.start)) { beginEdit(d.start); return; }
      const w = dragged ? Math.abs(b[0] - a[0]) : 30 * MMIN, h = dragged ? Math.abs(b[1] - a[1]) : 8 * MMIN;
      const cx = dragged ? (a[0] + b[0]) / 2 : a[0] + w / 2, cy = dragged ? (a[1] + b[1]) / 2 : a[1] - h / 2;
      const ids = await run(() => [O.createShape(doc, P, model, { name: "Testo", nameU: "Text", w, h, geom: [], textOnly: true }, cx, cy, { textValue: "" }).id]);
      if (ids) setTimeout(() => beginEdit(model.all.get(ids[0])), 0);
      return;
    }
    if (d.tool === "connector" || d.tool === "line") {
      if (!dragged) return;
      const T = d.target;
      const ids = await run(() => {
        const S = O.createConnector(doc, P, model, d.tool === "connector" ? "dynamic" : "line", a, b, d.tool === "connector" && d.start && !is1D(doc, d.start) ? d.start : null, T);
        if (d.tool === "connector" && (d.start || T)) { const m2 = getFresh(); O.reroute(doc, P, m2, m2.all.get(S.id)); }
        return [S.id];
      }, false);
      void ids;
      return;
    }
    if (d.tool === "rect" || d.tool === "ellipse") {
      if (!dragged) return;
      let w = b[0] - a[0], h = b[1] - a[1];
      if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
      const def = STENCILS[0].shapes.find(s => s.id === (d.tool === "rect" ? "rect" : "ellipse"));
      await run(() => [O.createShape(doc, P, model, def, a[0] + w / 2, a[1] + h / 2, { w: Math.abs(w), h: Math.abs(h) }).id], false);
    }
  }
  function setTool(t) {
    tool = t;
    canvas.dataset.tool = t;
    updateRibbon();
    statusText(t === "pointer" ? "" : { text: "Strumento Testo: clic su una forma per scriverci, oppure clic o trascinamento sulla pagina per una casella di testo", connector: "Connettore: trascina da una forma all'altra (i connettori dinamici seguono le forme)", line: "Linea: trascina per disegnare", rect: "Rettangolo: trascina (Maiusc = quadrato)", ellipse: "Ellisse: trascina (Maiusc = cerchio)" }[t]);
  }

  // ------------------------------------------------------------------ testo sul posto
  function beginEdit(S, replaceWith = null) {
    if (!S || readOnly) return;
    endEdit();
    editing = { S, before: plainText(S) };
    const m0 = O.toPageM(doc, S);
    const inf = info();
    const P = mul(inf.P, m0);
    const tm = textMatrix(doc, S, P, inf.r);
    const ch = O.firstChar(doc, S);
    const al = O.firstAlign(doc, S);
    const minW = 60 / scale;
    const w = Math.max(tm.wPt, minW), h = Math.max(tm.hPt, ch.size * 1.6);
    const off = [parseFloat(svg.style.left), parseFloat(svg.style.top)];
    const m = tm.m, k = 1;
    // assi del riquadro di testo nella pagina, in punti
    const ax = [m[0] * k, m[1] * k], ay = [m[2] * k, m[3] * k], La = Math.hypot(...ax) || 1, Lb = Math.hypot(...ay) || 1;
    let o = ap(m, 0, 0);
    if (w > tm.wPt) o = [o[0] - ax[0] / La * (w - tm.wPt) / 2, o[1] - ax[1] / La * (w - tm.wPt) / 2];
    if (h > tm.hPt) o = [o[0] - ay[0] / Lb * (h - tm.hPt) / 2, o[1] - ay[1] / Lb * (h - tm.hPt) / 2];
    Object.assign(textBox.style, {
      left: "0px", top: "0px", width: w + "px", height: h + "px", fontFamily: `"${ch.font}", "Segoe UI", sans-serif`, fontSize: ch.size + "px",
      fontWeight: ch.b ? "bold" : "normal", fontStyle: ch.i ? "italic" : "normal", textAlign: ["left", "center", "right", "justify"][al] || "center", color: ch.color === "#ffffff" ? "#000000" : ch.color || "#000",
      transform: `matrix(${ax[0] / La * scale},${ax[1] / La * scale},${ay[0] / Lb * scale},${ay[1] / Lb * scale},${off[0] + o[0] * scale},${off[1] + o[1] * scale})`,
      padding: `${num0(doc, S, "TopMargin") * 72}px ${num0(doc, S, "RightMargin") * 72}px ${num0(doc, S, "BottomMargin") * 72}px ${num0(doc, S, "LeftMargin") * 72}px`,
    });
    textBox.value = replaceWith ?? editing.before;
    textBox.hidden = false;
    const idx = R.items.findIndex(it => it.S === S);
    svg.querySelector(`g[data-i="${idx}"]`)?.classList.add("vs-editing");
    setTimeout(() => { textBox.focus(); if (replaceWith == null) textBox.select(); else textBox.setSelectionRange(textBox.value.length, textBox.value.length); }, 0);
    statusText("Modifica del testo: Esc o clic fuori per terminare");
  }
  async function endEdit(cancel = false) {
    if (!editing) return;
    const { S, before } = editing;
    editing = null;
    const v = textBox.value;
    textBox.hidden = true;
    svg.querySelector(".vs-editing")?.classList.remove("vs-editing");
    statusText("");
    if (cancel || v === before) return;
    await run(() => { O.setText(doc, page(), S, v); });
  }
  textBox.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); endEdit(); canvas.focus(); }
    else if (e.key === "Tab") { e.preventDefault(); const s = textBox.selectionStart; textBox.setRangeText("\t", s, textBox.selectionEnd, "end"); }
    e.stopPropagation();
  });
  textBox.addEventListener("blur", () => setTimeout(() => { if (editing && document.activeElement !== textBox) endEdit(); }, 0));

  // ------------------------------------------------------------------ comandi
  let clip = null;
  const sel0 = () => sel.filter(S => S.el);
  async function cmdDelete() { if (!sel.length) return; const list = sel0(); await run(() => { O.deleteShapes(doc, page(), model, list); return []; }); }
  function copy() { if (!sel.length) return; clip = O.copyShapes(doc, page(), model, sel0()); toast(`Copiat${sel.length > 1 ? "e " + sel.length + " forme" : "a 1 forma"}`); }
  async function cut() { if (!sel.length) return; copy(); await cmdDelete(); }
  async function paste() {
    if (!clip) return;
    const off = 0.25 * (isMM() ? 25.4 / 25.4 : 1) * (clip.page === page() ? 1 : 0);
    const P = page();
    clip.page = P;
    await run(() => O.pasteShapes(doc, P, clip, off, -off), false);
  }
  async function duplicate() { if (!sel.length) return; const c = O.copyShapes(doc, page(), model, sel0()); await run(() => O.pasteShapes(doc, page(), c, 0.25, -0.25), false); }
  async function cmdZ(how) { if (!sel.length) return; const list = sel0(); await run(() => O.zorder(doc, page(), list, how)); }
  async function cmdGroup() { if (sel.length < 2) return; const list = sel0(); await run(() => [O.groupShapes(doc, page(), model, list)], false); }
  async function cmdUngroup() { const gs = sel0().filter(S => S.el.getAttribute("Type") === "Group"); if (!gs.length) return; await run(() => gs.flatMap(G => O.ungroupShapes(doc, page(), model, G)), false); }
  async function cmdRotate(deg) { if (!sel.length) return; const list = sel0(); await run(() => { O.rotateAround(doc, page(), list, deg * Math.PI / 180); O.rerouteFor(doc, page(), getFresh(), new Set(list.map(S => S.id)), new Set(list.map(S => S.id))); }); }
  async function cmdFlip(axis) { if (!sel.length) return; const list = sel0().filter(S => !is1D(doc, S)); await run(() => O.flipShapes(doc, page(), list, axis)); }
  async function nudge(dx, dy) {
    if (!sel.length) return;
    const st = snapStep(), list = sel0();
    await run(() => { O.moveShapes(doc, page(), model, list, dx * st, dy * st); O.rerouteFor(doc, page(), getFresh(), new Set(list.map(S => S.id)), new Set(list.map(S => S.id))); });
  }
  async function align(how) {
    const list = sel0().filter(S => !is1D(doc, S));
    if (list.length < 2) { toast("Seleziona almeno due forme: si allineano alla prima selezionata", true); return; }
    const ref = O.bounds(doc, [list[0]]);
    await run(() => {
      for (const S of list.slice(1)) {
        const b = O.bounds(doc, [S]);
        const dx = how === "l" ? ref[0] - b[0] : how === "r" ? ref[2] - b[2] : how === "c" ? (ref[0] + ref[2]) / 2 - (b[0] + b[2]) / 2 : 0;
        const dy = how === "b" ? ref[1] - b[1] : how === "t" ? ref[3] - b[3] : how === "m" ? (ref[1] + ref[3]) / 2 - (b[1] + b[3]) / 2 : 0;
        O.moveShapes(doc, page(), model, [S], dx, dy);
      }
      O.rerouteFor(doc, page(), getFresh(), new Set(list.map(S => S.id)));
    });
  }
  async function distribute(axis) {
    const list = sel0().filter(S => !is1D(doc, S));
    if (list.length < 3) { toast("Seleziona almeno tre forme", true); return; }
    const bs = list.map(S => ({ S, b: O.bounds(doc, [S]) })).sort((p, q) => axis === "h" ? p.b[0] - q.b[0] : p.b[1] - q.b[1]);
    const i0 = axis === "h" ? 0 : 1, i1 = axis === "h" ? 2 : 3;
    const total = bs.reduce((s, x) => s + x.b[i1] - x.b[i0], 0), span = bs[bs.length - 1].b[i1] - bs[0].b[i0];
    const gap = (span - total) / (bs.length - 1);
    await run(() => {
      let pos = bs[0].b[i1] + gap;
      for (const x of bs.slice(1, -1)) { const d = pos - x.b[i0]; O.moveShapes(doc, page(), model, [x.S], axis === "h" ? d : 0, axis === "h" ? 0 : d); pos += x.b[i1] - x.b[i0] + gap; }
      O.rerouteFor(doc, page(), getFresh(), new Set(list.map(S => S.id)));
    });
  }
  const fmtCmd = fn => async (...a) => { const list = sel0(); if (!list.length) { toast("Seleziona prima una forma", true); return; } await run(() => fn(list, ...a)); };
  const setFill = fmtCmd((list, c) => O.setFill(doc, page(), list, c));
  const setLine = fmtCmd((list, o) => O.setLine(doc, page(), list, o));
  const setChar = fmtCmd((list, o) => O.setChar(doc, page(), list, o));
  const setPara = fmtCmd((list, a) => O.setPara(doc, page(), list, a));
  const setVAlign = fmtCmd((list, v) => O.setCells(doc, page(), list, { VerticalAlign: v }));
  const setShadow = fmtCmd((list, on) => O.setCells(doc, page(), list, on ? { ShdwPattern: 1, ShdwForegnd: "#808080", ShapeShdwOffsetX: 0.03, ShapeShdwOffsetY: -0.03, ShdwForegndTrans: 0.4 } : { ShdwPattern: 0, ShapeShdwShow: 0 }));
  async function addShapeAt(def, x, y) {
    const P = page();
    if (def.connector) {
      const L = 25 * MMIN;
      await run(() => [O.createConnector(doc, P, model, def.connector === "dynamic" ? "dynamic" : def.connector, [x - L / 2, y], [x + L / 2, y]).id], false);
      return;
    }
    if (def.master) { await run(() => [O.createInstance(doc, P, model, def.master, x, y)], false); return; }
    const ids = await run(() => [O.createShape(doc, P, model, def, x, y, def.textOnly ? { textValue: "Testo" } : {}).id], false);
    if (ids && def.textOnly) setTimeout(() => beginEdit(model.all.get(ids[0])), 0);
  }
  function viewCenter() {
    const r = canvas.getBoundingClientRect();
    const m = svg.getScreenCTM();
    const p = new DOMPoint(r.left + r.width / 2, r.top + r.height / 2).matrixTransform(m.inverse());
    const i = info();
    return fromPt([clamp(p.x, 0, i.wPt), clamp(p.y, 0, i.hPt)]);
  }
  async function insertPicture() {
    let files;
    if (WEB) files = await pickFiles(); else files = await pickFiles();
    const f = (files || []).find(p => /\.(png|jpe?g|gif|bmp)$/i.test(p));
    if (!f) { if (files?.length) toast("Scegli un'immagine PNG, JPG, GIF o BMP", true); return; }
    const bytes = await readBytes(f);
    const bmp = await createImageBitmap(new Blob([bytes]));
    const P = page();
    const maxW = info().W * 0.5, w0 = bmp.width / 96, h0 = bmp.height / 96, k = Math.min(1, maxW / w0);
    const c = viewCenter();
    await run(async () => {
      const rid = await addImagePart(doc, P, bytes, extOf(f) === "jpeg" ? "jpg" : extOf(f));
      const id = O.createImage(doc, P, model, rid, c[0], c[1], w0 * k, h0 * k);
      await loadMedia();
      return [id];
    }, false);
  }
  async function newPage() {
    const n = doc.pages.filter(p => !p.background).length + 1;
    await run(async () => { const P = await addPage(doc, `Pagina-${n}`, page(), page()); pageIdx = doc.pages.indexOf(P); return []; }, false);
    fitPage();
  }
  async function renamePage(P) {
    const name = await askText("Rinomina pagina", "Nome della pagina", P.name);
    if (!name || name === P.name) return;
    await run(() => { P.el.setAttribute("Name", name); if (!P.el.getAttribute("NameU") || P.el.getAttribute("IsCustomNameU") !== "1") P.el.setAttribute("NameU", name); markDirty(doc, doc.pagesPath); });
  }
  async function removePage(P) {
    if (doc.pages.filter(p => !p.background).length <= 1 && !P.background) { toast("Il diagramma deve avere almeno una pagina", true); return; }
    if (!(await confirmBox("Elimina pagina", `Eliminare la pagina "${P.name}" e tutte le sue forme?`, "Elimina", true))) return;
    await run(async () => { await deletePage(doc, P); pageIdx = clamp(pageIdx, 0, doc.pages.length - 1); if (doc.pages[pageIdx]?.background) pageIdx = Math.max(0, doc.pages.findIndex(p => !p.background)); return []; }, false);
  }
  function goPage(i) {
    if (i < 0 || i >= doc.pages.length || i === pageIdx) return;
    endEdit();
    pageIdx = i;
    sel = [];
    fitPage();
  }

  // ------------------------------------------------------------------ menu a comparsa
  let pop = null;
  function closePop() { pop?.remove(); pop = null; document.removeEventListener("pointerdown", popOut, true); }
  function popOut(e) { if (pop && !pop.contains(e.target)) closePop(); }
  function popup(anchor, content) {
    closePop();
    pop = el("div", { class: "vs-pop" });
    pop.append(content);
    document.body.append(pop);
    const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y, top: anchor.y };
    const pr = pop.getBoundingClientRect();
    pop.style.left = clamp(r.left, 4, innerWidth - pr.width - 4) + "px";
    pop.style.top = (r.bottom + pr.height > innerHeight - 4 ? Math.max(4, r.top - pr.height - 2) : r.bottom + 2) + "px";
    setTimeout(() => document.addEventListener("pointerdown", popOut, true));
    return pop;
  }
  function openMenu(anchor, items) {
    const box = el("div", { class: "vs-menu" });
    for (const it of items) {
      if (!it) continue;
      if (it === "-") { box.append(el("div", { class: "vs-msep" })); continue; }
      if (it.title) { box.append(el("div", { class: "vs-mtitle" }, it.title)); continue; }
      const dis = typeof it.dis === "function" ? it.dis() : it.dis;
      const on = typeof it.on === "function" ? it.on() : it.on;
      const b = el("button", { type: "button", class: "vs-mit" + (on ? " on" : ""), disabled: !!dis || undefined });
      b.innerHTML = `<span class="vs-mico">${it.icon ? vsIcon(it.icon) : on ? "✓" : ""}</span>`;
      const lab = el("span", { class: "vs-mlab" }, it.label);
      if (it.swatch) lab.prepend(el("i", { class: "vs-msw", style: { background: it.swatch } }));
      if (it.dash) lab.prepend(el("i", { class: "vs-mdash", html: `<svg width="46" height="8"><path d="M2 4H44" stroke="currentColor" stroke-width="${it.w || 1.5}" ${it.dash ? `stroke-dasharray="${it.dash}"` : ""}/></svg>` }));
      b.append(lab, el("span", { class: "vs-mkey" }, it.keys || ""));
      b.addEventListener("click", ev => { ev.stopPropagation(); closePop(); it.run?.(); });
      box.append(b);
    }
    popup(anchor, box);
  }
  function colorPop(anchor, title, cur, onPick, noneLabel) {
    const box = el("div", { class: "vs-colors" });
    box.append(el("div", { class: "vs-mtitle" }, title));
    const th = doc.theme.colors;
    const theme = [th.lt1, th.dk1, th.lt2, th.dk2, th.accent1, th.accent2, th.accent3, th.accent4, th.accent5, th.accent6].filter(Boolean);
    const grid = (list, lab) => {
      box.append(el("div", { class: "vs-csub" }, lab));
      const g = el("div", { class: "vs-cgrid" });
      for (const c of list) g.append(el("button", { type: "button", class: "vs-cbtn" + (cur === c ? " on" : ""), title: c, style: { background: c }, onclick: () => { closePop(); onPick(c); } }));
      box.append(g);
    };
    grid(theme, "Colori del tema");
    grid(STD.slice(10), "Colori standard");
    const inp = el("input", { type: "color", value: /^#[0-9a-f]{6}$/i.test(cur || "") ? cur : "#5b9bd5" });
    box.append(el("div", { class: "vs-crow" },
      noneLabel ? el("button", { type: "button", class: "vs-sm", onclick: () => { closePop(); onPick(null); } }, noneLabel) : null,
      el("label", { class: "vs-sm" }, "Altri colori... ", inp)));
    inp.addEventListener("change", () => { closePop(); onPick(inp.value); });
    popup(anchor, box);
  }

  // ------------------------------------------------------------------ barra multifunzione
  const tabs = [["home", "Home"], ["insert", "Inserisci"], ["design", "Progettazione"], ["view", "Visualizza"]];
  let tab = "home";
  const updaters = [];
  const big = (label, icon, run, o = {}) => {
    const b = el("button", { type: "button", class: "vs-big", title: o.title || label + (o.keys ? ` (${o.keys})` : ""), onclick: e => run(e, b) });
    b.innerHTML = vsIcon(icon) + `<span>${label}</span>` + (o.caret ? `<span class="vs-caret">▾</span>` : "");
    if (o.on || o.dis) updaters.push(() => { if (o.on) b.classList.toggle("on", !!o.on()); if (o.dis) b.disabled = !!o.dis(); });
    return b;
  };
  const sm = (label, icon, run, o = {}) => {
    const b = el("button", { type: "button", class: "vs-sm" + (label ? "" : " io"), title: o.title || label + (o.keys ? ` (${o.keys})` : ""), onclick: e => run(e, b) });
    b.innerHTML = (icon ? vsIcon(icon) : "") + (label && !o.iconOnly ? `<span>${label}</span>` : "") + (o.caret ? `<span class="vs-caret">▾</span>` : "");
    if (o.on || o.dis) updaters.push(() => { if (o.on) b.classList.toggle("on", !!o.on()); if (o.dis) b.disabled = !!o.dis(); });
    return b;
  };
  const group = (label, ...items) => el("div", { class: "vs-group" }, el("div", { class: "vs-gbody" }, ...items), el("div", { class: "vs-glabel" }, label));
  const col = (...items) => el("div", { class: "vs-col" }, ...items);
  const row = (...items) => el("div", { class: "vs-row" }, ...items);
  const noSel = () => !sel.length || readOnly;
  const one = () => sel.length === 1 ? sel[0] : null;
  const fontSel = el("select", { class: "vs-sel", title: "Tipo di carattere", style: { width: "140px" } });
  for (const f of ["Calibri", "Calibri Light", "Arial", "Segoe UI", "Times New Roman", "Cambria", "Verdana", "Tahoma", "Georgia", "Trebuchet MS", "Courier New", "Consolas", "Century Gothic", "Garamond"]) fontSel.append(el("option", { value: f }, f));
  fontSel.addEventListener("change", () => setChar({ font: fontSel.value }));
  const sizeSel = el("select", { class: "vs-sel", title: "Dimensione carattere", style: { width: "58px" } });
  for (const s of [6, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72]) sizeSel.append(el("option", { value: s }, String(s)));
  sizeSel.addEventListener("change", () => setChar({ size: +sizeSel.value }));
  updaters.push(() => {
    const S = one() || sel[0];
    for (const x of [fontSel, sizeSel]) x.disabled = noSel();
    if (!S) return;
    const c = O.firstChar(doc, S);
    if (![...fontSel.options].some(o => o.value === c.font)) fontSel.append(el("option", { value: c.font }, c.font));
    fontSel.value = c.font;
    if (![...sizeSel.options].some(o => +o.value === c.size)) sizeSel.append(el("option", { value: c.size }, String(c.size)));
    sizeSel.value = String(c.size);
  });
  const charOn = k => () => { const S = sel[0]; return S && O.firstChar(doc, S)[k]; };
  const toolBtn = (label, icon, t, keys) => sm(label, icon, () => setTool(tool === t && t !== "pointer" ? "pointer" : t), { keys, on: () => tool === t });
  const panels = { shapes: true, data: true, size: true };
  const P = {
    home: () => [
      group("Appunti", big("Incolla", "paste", paste, { keys: "Ctrl+V", dis: () => !clip || readOnly }), col(sm("Taglia", "cut", cut, { keys: "Ctrl+X", dis: noSel }), sm("Copia", "copy", copy, { keys: "Ctrl+C", dis: () => !sel.length }), sm("Duplica", "duplicate", duplicate, { keys: "Ctrl+D", dis: noSel }))),
      group("Carattere", col(row(fontSel, sizeSel, sm("", "grow", () => setChar({ dsize: 2 }), { title: "Aumenta dimensione carattere (Ctrl+Maiusc+>)", dis: noSel }), sm("", "shrink", () => setChar({ dsize: -2 }), { title: "Riduci dimensione carattere (Ctrl+Maiusc+<)", dis: noSel })),
        row(sm("", "bold", () => setChar({ b: !charOn("b")() }), { title: "Grassetto (Ctrl+B)", on: charOn("b"), dis: noSel }), sm("", "italic", () => setChar({ i: !charOn("i")() }), { title: "Corsivo (Ctrl+I)", on: charOn("i"), dis: noSel }),
          sm("", "underline", () => setChar({ u: !charOn("u")() }), { title: "Sottolineato (Ctrl+U)", on: charOn("u"), dis: noSel }),
          sm("", "fontColor", (e, b) => colorPop(b, "Colore carattere", sel[0] && O.firstChar(doc, sel[0]).color, c => c && setChar({ color: c })), { title: "Colore carattere", dis: noSel, caret: true })))),
      group("Paragrafo", col(row(sm("", "valignT", () => setVAlign(0), { title: "Allinea in alto", dis: noSel, on: () => sel[0] && num0(doc, sel[0], "VerticalAlign", 1) === 0 }), sm("", "valignM", () => setVAlign(1), { title: "Allinea al centro", dis: noSel, on: () => sel[0] && num0(doc, sel[0], "VerticalAlign", 1) === 1 }), sm("", "valignB", () => setVAlign(2), { title: "Allinea in basso", dis: noSel, on: () => sel[0] && num0(doc, sel[0], "VerticalAlign", 1) === 2 })),
        row(sm("", "alignL", () => setPara(0), { title: "Allinea testo a sinistra (Ctrl+Maiusc+L)", dis: noSel, on: () => sel[0] && O.firstAlign(doc, sel[0]) === 0 }), sm("", "alignC", () => setPara(1), { title: "Centra (Ctrl+Maiusc+C)", dis: noSel, on: () => sel[0] && O.firstAlign(doc, sel[0]) === 1 }), sm("", "alignR", () => setPara(2), { title: "Allinea testo a destra (Ctrl+Maiusc+R)", dis: noSel, on: () => sel[0] && O.firstAlign(doc, sel[0]) === 2 }), sm("", "alignJ", () => setPara(3), { title: "Giustifica", dis: noSel, on: () => sel[0] && O.firstAlign(doc, sel[0]) === 3 })))),
      group("Strumenti", col(toolBtn("Puntatore", "pointer", "pointer", "Ctrl+1"), toolBtn("Connettore", "connector", "connector", "Ctrl+3"), toolBtn("Testo", "textTool", "text", "Ctrl+2")),
        col(toolBtn("Rettangolo", "rect", "rect", "Ctrl+8"), toolBtn("Ellisse", "ellipse", "ellipse", "Ctrl+9"), toolBtn("Linea", "line", "line", "Ctrl+6"))),
      group("Stili forma", col(sm("Riempimento", "fillBucket", (e, b) => colorPop(b, "Riempimento", sel[0] && vColor(doc, val(doc, sel[0], "FillForegnd", 1)), c => setFill(c), "Nessun riempimento"), { dis: noSel, caret: true }),
        sm("Linea", "lineColor", (e, b) => lineMenu(b), { dis: noSel, caret: true }), sm("Ombreggiatura", "shadowIco", (e, b) => openMenu(b, [{ label: "Nessuna ombreggiatura", run: () => setShadow(false) }, { label: "Ombreggiatura esterna", run: () => setShadow(true) }]), { dis: noSel, caret: true }))),
      group("Disponi", col(sm("Allinea", "align", (e, b) => openMenu(b, [{ title: "Allinea alla prima forma selezionata" }, { label: "A sinistra", icon: "alignObjL", run: () => align("l") }, { label: "Al centro", icon: "alignObjC", run: () => align("c") }, { label: "A destra", icon: "alignObjR", run: () => align("r") }, "-", { label: "In alto", icon: "alignObjT", run: () => align("t") }, { label: "Al centro (verticale)", icon: "alignObjM", run: () => align("m") }, { label: "In basso", icon: "alignObjB", run: () => align("b") }]), { dis: () => sel.length < 2 || readOnly, caret: true }),
        sm("Posizione", "distH", (e, b) => openMenu(b, [{ label: "Distribuisci orizzontalmente", icon: "distH", run: () => distribute("h") }, { label: "Distribuisci verticalmente", icon: "distV", run: () => distribute("v") }, "-", { label: "Ruota a destra di 90°", icon: "rotateR", keys: "Ctrl+R", run: () => cmdRotate(-90) }, { label: "Ruota a sinistra di 90°", icon: "rotateL", keys: "Ctrl+L", run: () => cmdRotate(90) }, { label: "Capovolgi orizzontalmente", icon: "flipH", keys: "Ctrl+H", run: () => cmdFlip("x") }, { label: "Capovolgi verticalmente", icon: "flipV", keys: "Ctrl+J", run: () => cmdFlip("y") }]), { dis: noSel, caret: true }),
        sm("Raggruppa", "group", (e, b) => openMenu(b, [{ label: "Raggruppa", icon: "group", keys: "Ctrl+G", run: cmdGroup, dis: () => sel.length < 2 }, { label: "Separa", icon: "ungroup", keys: "Ctrl+Maiusc+U", run: cmdUngroup, dis: () => !sel.some(S => S.el?.getAttribute("Type") === "Group") }]), { dis: noSel, caret: true })),
        col(sm("Porta avanti", "bringFwd", (e, b) => openMenu(b, [{ label: "Porta in primo piano", icon: "bringFront", keys: "Ctrl+Maiusc+F", run: () => cmdZ("front") }, { label: "Porta avanti", icon: "bringFwd", run: () => cmdZ("forward") }]), { dis: noSel, caret: true }),
          sm("Porta indietro", "sendBack", (e, b) => openMenu(b, [{ label: "Porta sullo sfondo", icon: "sendBackmost", keys: "Ctrl+Maiusc+B", run: () => cmdZ("back") }, { label: "Porta indietro", icon: "sendBack", run: () => cmdZ("backward") }]), { dis: noSel, caret: true }))),
      group("Modifica", col(sm("Trova", "find", () => findPanel(), { keys: "Ctrl+F" }), sm("Livelli", "layers", (e, b) => layersMenu(b)), sm("Seleziona", "select", (e, b) => openMenu(b, [{ label: "Seleziona tutto", keys: "Ctrl+A", run: () => setSel(model.top) }, { label: "Seleziona i connettori", run: () => setSel(model.top.filter(S => is1D(doc, S))) }, { label: "Seleziona le forme 2D", run: () => setSel(model.top.filter(S => !is1D(doc, S))) }]), { caret: true }))),
    ],
    insert: () => [
      group("Pagine", big("Pagina vuota", "pageAdd", newPage, { dis: () => readOnly })),
      group("Illustrazioni", big("Immagini", "image", insertPicture, { dis: () => readOnly })),
      group("Testo", big("Casella di testo", "textbox", () => setTool("text"), { on: () => tool === "text", dis: () => readOnly })),
      group("Parti di diagramma", big("Connettore", "connector", () => setTool("connector"), { on: () => tool === "connector", dis: () => readOnly }), big("Forme", "shapes", () => { panels.shapes = true; layoutPanels(); })),
    ],
    design: () => [
      group("Imposta pagina", big("Orientamento", info().W > info().H ? "orientationL" : "orientationP", (e, b) => openMenu(b, [{ label: "Verticale", icon: "orientationP", on: () => info().H >= info().W, run: () => setOrient(false) }, { label: "Orizzontale", icon: "orientationL", on: () => info().W > info().H, run: () => setOrient(true) }]), { caret: true, dis: () => readOnly }),
        big("Dimensioni", "pageSize", (e, b) => openMenu(b, [...PAGE_SIZES.map(([n, w, h]) => ({ label: `${n}  (${w} × ${h} mm)`, run: () => setPageMM(w, h) })), "-", { label: "Adatta al disegno", icon: "fitDrawing", run: fitToDrawing }, { label: "Altre dimensioni...", run: customSize }]), { caret: true, dis: () => readOnly }),
        big("Adatta al disegno", "fitDrawing", fitToDrawing, { dis: () => readOnly })),
    ],
    view: () => [
      group("Visualizzazioni", big("Schermo intero", "fullscreen", fullScreen, { keys: "F5" })),
      group("Mostra", col(sm("Griglia", "grid", () => { showGrid = !showGrid; render(); }, { on: () => showGrid }), sm("Riquadro Forme", "panel", () => { panels.shapes = !panels.shapes; layoutPanels(); }, { on: () => panels.shapes })),
        col(sm("Dati forma", "shapedata", () => { panels.data = !panels.data; layoutPanels(); }, { on: () => panels.data }), sm("Dimensioni e posizione", "sizepos", () => { panels.size = !panels.size; layoutPanels(); }, { on: () => panels.size }))),
      group("Zoom", big("Zoom", "zoomIn", (e, b) => openMenu(b, [400, 200, 150, 100, 75, 50, 25].map(z => ({ label: z + "%", run: () => setZoom(z / 100 * 96 / 72) }))), { caret: true }), col(sm("Adatta alla finestra", "zoomPage", fitPage, { keys: "Ctrl+Maiusc+W" }), sm("Larghezza pagina", "zoomWidth", fitWidth), sm("100%", "zoom100", () => setZoom(96 / 72)))),
    ],
  };
  const tabStrip = el("div", { class: "vs-tabs" });
  const qUndo = el("button", { type: "button", class: "vs-q", title: "Annulla (Ctrl+Z)", onclick: () => doUndo(undo, redo), html: vsIcon("undo") });
  const qRedo = el("button", { type: "button", class: "vs-q", title: "Ripeti (Ctrl+Y)", onclick: () => doUndo(redo, undo), html: vsIcon("redo") });
  ctx.tb.classList.add("vs-tb");
  ctx.tb.append(qUndo, qRedo, el("span", { class: "sep" }), tabStrip);
  function buildRibbon() {
    updaters.length = 0;
    tabStrip.innerHTML = "";
    for (const [id, label] of tabs) tabStrip.append(el("button", { type: "button", class: "vs-tab" + (tab === id ? " on" : ""), onclick: () => { tab = id; buildRibbon(); } }, label));
    ribbon.innerHTML = "";
    const panel = el("div", { class: "vs-panel" }, ...P[tab]());
    ribbon.append(panel);
    updaters.push(() => { qUndo.disabled = !undo.length || readOnly; qRedo.disabled = !redo.length || readOnly; });
    updateRibbon();
  }
  function updateRibbon() { for (const u of updaters) try { u(); } catch { /* */ } }
  function lineMenu(b) {
    const S = sel[0];
    openMenu(b, [
      { label: "Colore linea...", icon: "lineColor", run: () => colorPop(b, "Colore linea", S && vColor(doc, val(doc, S, "LineColor", 0), "line"), c => c ? setLine({ color: c }) : setLine({ none: true }), "Nessuna linea") },
      { title: "Spessore" }, ...WEIGHTS.map(w => ({ label: `${w.toLocaleString("it-IT")} pt`, dash: "", w: Math.min(6, w), run: () => setLine({ weight: w / 72 }), on: () => S && Math.abs(num0(doc, S, "LineWeight") * 72 - w) < 0.01 })),
      { title: "Tratteggio" }, ...PATTERNS.map(([p, n]) => ({ label: n, dash: { 1: "", 2: "6 4", 3: "1.5 3", 4: "6 3 1.5 3", 9: "10 4", 10: "3 3" }[p] || " ", run: () => setLine({ pattern: p }), on: () => S && num0(doc, S, "LinePattern", 1) === p })),
      { title: "Frecce (inizio / fine)" }, ...ARROWS.map(([a, n]) => ({ label: `Fine: ${n}`, run: () => setLine({ endArrow: a }), on: () => S && num0(doc, S, "EndArrow") === a })), ...ARROWS.slice(0, 3).map(([a, n]) => ({ label: `Inizio: ${n}`, run: () => setLine({ beginArrow: a }) })),
    ]);
  }
  function layersMenu(b) {
    const L = layersOf(doc, page());
    openMenu(b, [
      { title: L.length ? "Livelli della pagina (clic = mostra/nascondi)" : "Nessun livello in questa pagina" },
      ...L.map(l => ({ label: `${l.name}${l.print ? "" : "  (non stampato)"}`, on: () => l.visible, run: () => run(() => O.setLayer(doc, page(), l.ix, "Visible", !l.visible)) })),
      "-", { label: "Proprieta' livello...", icon: "layers", run: layersDialog }, { label: "Assegna al livello...", run: assignLayer, dis: () => !sel.length || readOnly },
    ]);
  }
  async function layersDialog() {
    const L = layersOf(doc, page());
    const tbl = el("table", { class: "vs-ltable" }, el("tr", {}, el("th", {}, "Nome"), el("th", {}, "Forme"), el("th", {}, "Visibile"), el("th", {}, "Stampa")));
    const count = ix => model.top.filter(S => String(cell(doc, S, "LayerMember")?.v || "").split(";").includes(ix)).length;
    const state = L.map(l => ({ ...l }));
    for (const l of state) {
      const v = el("input", { type: "checkbox", checked: l.visible || undefined, onchange: e => { l.visible = e.target.checked; } });
      const p = el("input", { type: "checkbox", checked: l.print || undefined, onchange: e => { l.print = e.target.checked; } });
      tbl.append(el("tr", {}, el("td", {}, l.name), el("td", {}, String(count(l.ix))), el("td", {}, v), el("td", {}, p)));
    }
    const nn = el("input", { class: "field", placeholder: "Nome del nuovo livello" });
    const ok = await modal("Proprieta' livello", el("div", { style: { display: "grid", gap: "10px", minWidth: "380px" } }, L.length ? tbl : el("p", {}, "Questa pagina non ha livelli."), el("div", { style: { display: "flex", gap: "6px" } }, nn)), [{ label: "Annulla", value: false }, { label: "OK", value: true, primary: true }]);
    if (!ok) return;
    await run(() => {
      for (const l of state) { const o = L.find(x => x.ix === l.ix); if (o.visible !== l.visible) O.setLayer(doc, page(), l.ix, "Visible", l.visible); if (o.print !== l.print) O.setLayer(doc, page(), l.ix, "Print", l.print); }
      if (nn.value.trim()) { const ix = O.addLayer(doc, page(), nn.value.trim()); if (sel.length) O.setMembership(doc, page(), sel0(), ix, true); }
    });
  }
  async function assignLayer() {
    const L = layersOf(doc, page());
    const list = sel0();
    const cur = new Set(String(cell(doc, list[0], "LayerMember")?.v || "").split(";"));
    const checks = L.map(l => ({ l, c: el("input", { type: "checkbox", checked: cur.has(l.ix) || undefined }) }));
    const nn = el("input", { class: "field", placeholder: "Nuovo livello" });
    const ok = await modal("Livello", el("div", { style: { display: "grid", gap: "6px", minWidth: "300px" } }, ...checks.map(({ l, c }) => el("label", { style: { display: "flex", gap: "8px" } }, c, l.name)), nn), [{ label: "Annulla", value: false }, { label: "OK", value: true, primary: true }]);
    if (!ok) return;
    await run(() => {
      for (const { l, c } of checks) O.setMembership(doc, page(), list, l.ix, c.checked);
      if (nn.value.trim()) O.setMembership(doc, page(), list, O.addLayer(doc, page(), nn.value.trim()), true);
    });
  }
  async function setPageMM(w, h) { const land = info().W > info().H; await run(() => O.setPageSize(doc, page(), (land ? Math.max(w, h) : Math.min(w, h)) * MMIN / info().r, (land ? Math.min(w, h) : Math.max(w, h)) * MMIN / info().r)); fitPage(); }
  async function setOrient(land) { const i = info(); if ((i.W > i.H) === land) return; await run(() => O.setPageSize(doc, page(), i.H, i.W)); fitPage(); }
  async function customSize() {
    const i = info();
    const w = el("input", { class: "field", type: "number", step: "any", value: (Math.round(toUnit(i.W * i.r) * 10) / 10).toString() }), h = el("input", { class: "field", type: "number", step: "any", value: (Math.round(toUnit(i.H * i.r) * 10) / 10).toString() });
    const ok = await modal("Dimensioni pagina", el("div", { style: { display: "grid", gridTemplateColumns: "auto 1fr", gap: "8px", alignItems: "center" } }, `Larghezza (${uName()})`, w, `Altezza (${uName()})`, h), [{ label: "Annulla", value: false }, { label: "OK", value: true, primary: true }]);
    if (!ok) return;
    await run(() => O.setPageSize(doc, page(), fromUnit(+w.value) / i.r, fromUnit(+h.value) / i.r));
    fitPage();
  }
  async function fitToDrawing() {
    if (!model.top.length) return;
    const b = O.bounds(doc, model.top), m = 0.25;
    await run(() => {
      const dx = m - b[0], dy = m - b[1];
      O.moveShapes(doc, page(), model, [...model.top], dx, dy);
      O.setPageSize(doc, page(), b[2] - b[0] + 2 * m, b[3] - b[1] + 2 * m);
    });
    fitPage();
  }
  function fullScreen() { if (document.fullscreenElement) document.exitFullscreen(); else root.requestFullscreen?.().then(() => setTimeout(fitPage, 200)).catch(() => {}); }

  // ------------------------------------------------------------------ pannello Forme
  const search = el("input", { type: "search", class: "vs-search", placeholder: "Cerca forme" });
  const stencils = el("div", { class: "vs-stencils" });
  left.append(el("div", { class: "vs-ptitle" }, "Forme"), search, stencils);
  const openSt = new Set(["base", "flow", "conn", "doc"]);
  search.addEventListener("input", renderStencils);
  const preview = new Map();
  function defPreview(def) {
    if (preview.has(def)) return preview.get(def);
    let svgS = "";
    try {
      if (def.connector || def.textOnly) svgS = shapeIcon(def, 34);
      else if (def.master) svgS = masterPreview(def.master);
      else {
        const x = new DOMParser().parseFromString(`<PageContents xmlns="${VNS}"/>`, "application/xml");
        const pg = new DOMParser().parseFromString(`<Page xmlns="${VNS}"><PageSheet><Cell N="PageWidth" V="${def.w + 0.2}"/><Cell N="PageHeight" V="${def.h + 0.2}"/></PageSheet></Page>`, "application/xml").documentElement;
        const fake = { xml: x, el: pg, path: null, id: "_", rels: new Map() };
        const fm = { top: [], all: new Map(), connects: [] };
        const S = O.createShape(doc, fake, fm, def, def.w / 2 + 0.1, def.h / 2 + 0.1);
        fm.top = [S];
        doc.dirty.delete(null);
        const RR = renderPage(doc, fake, fm);
        svgS = `<svg viewBox="0 0 ${RR.info.wPt} ${RR.info.hPt}" width="34" height="34">${opsSvg(RR.items[0].ops, null, [])}</svg>`;
      }
    } catch (e) { console.warn(e); svgS = shapeIcon(def, 34); }
    preview.set(def, svgS);
    return svgS;
  }
  function masterPreview(M) {
    const fm = { top: M.top, all: M.shapes, connects: [] };
    const fake = { el: M.el, xml: M.xml, rels: M.rels, id: "_m", path: M.path };
    const RR = renderPage(doc, fake, fm);
    const ops = RR.items.flatMap(it => it.ops);
    const b = opsBox(ops);
    if (!isFinite(b[0])) return shapeIcon({ w: 1, h: 1, geom: [] }, 34);
    const w = b[2] - b[0], h = b[3] - b[1], m = Math.max(w, h) * 0.06 + 0.5;
    return `<svg viewBox="${b[0] - m} ${b[1] - m} ${w + 2 * m} ${h + 2 * m}" width="34" height="34">${opsSvg(ops, imgUrl, [])}</svg>`;
  }
  function renderStencils() {
    stencils.innerHTML = "";
    const q = search.value.trim().toLowerCase();
    const groups = [...STENCILS];
    const docMasters = [...doc.masters.values()].filter(M => !M.hidden && M.top.length);
    if (docMasters.length) groups.unshift({ id: "doc", name: "Forme del documento", shapes: docMasters.map(M => ({ id: "m" + M.id, name: M.name, master: M })) });
    for (const st of groups) {
      const items = st.shapes.filter(s => !q || (s.name + " " + (s.keys || "")).toLowerCase().includes(q));
      if (!items.length) continue;
      const open = q || openSt.has(st.id);
      const head = el("button", { type: "button", class: "vs-sthead" + (open ? " open" : ""), onclick: () => { if (openSt.has(st.id)) openSt.delete(st.id); else openSt.add(st.id); renderStencils(); } }, el("span", { class: "vs-starrow" }, open ? "▾" : "▸"), st.name);
      stencils.append(head);
      if (!open) continue;
      const grid = el("div", { class: "vs-stgrid" });
      for (const def of items) {
        const it = el("div", { class: "vs-stitem", title: def.name + (readOnly ? "" : " - trascina sulla pagina") });
        it.innerHTML = `<span class="vs-stico">${defPreview(def)}</span>`;
        it.append(el("span", { class: "vs-stname" }, def.name));
        it.addEventListener("pointerdown", e => startStencilDrag(e, def, it));
        grid.append(it);
      }
      stencils.append(grid);
    }
  }
  function startStencilDrag(e, def, item) {
    if (readOnly || e.button !== 0) return;
    e.preventDefault();
    const ghost = el("div", { class: "vs-ghost", html: item.querySelector(".vs-stico").innerHTML });
    let moved = false;
    const mv = ev => {
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
      if (!moved) { document.body.append(ghost); moved = true; }
      ghost.style.left = ev.clientX - 17 + "px"; ghost.style.top = ev.clientY - 17 + "px";
    };
    const up = async ev => {
      window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
      ghost.remove();
      if (!moved) { const c = viewCenter(); await addShapeAt(def, c[0], c[1]); return; }
      const r = canvas.getBoundingClientRect();
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
      const p = fromPt(evPt(ev));
      await addShapeAt(def, snap(p[0], ev), snap(p[1], ev));
    };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  }

  // ------------------------------------------------------------------ riquadri a destra: Dati forma, Dimensioni e posizione
  function layoutPanels() {
    left.hidden = !panels.shapes;
    right.hidden = !panels.data && !panels.size;
    main.style.gridTemplateColumns = `${panels.shapes ? "212px" : "0"} minmax(0,1fr) ${right.hidden ? "0" : "250px"}`;
    updatePanels();
    updateRibbon();
    requestAnimationFrame(sizeStage);
  }
  function updatePanels() {
    right.innerHTML = "";
    const S = one();
    if (panels.size) {
      const box = el("section", { class: "vs-pane" }, el("div", { class: "vs-ptitle" }, "Dimensioni e posizione"));
      if (!S) box.append(el("p", { class: "vs-empty" }, sel.length ? `${sel.length} forme selezionate` : "Nessuna forma selezionata"));
      else if (is1D(doc, S)) {
        const fld = (lab, name) => numField(lab, num0(doc, S, name), v => run(() => { const b = [num0(doc, S, "BeginX"), num0(doc, S, "BeginY")], e = [num0(doc, S, "EndX"), num0(doc, S, "EndY")]; const i = { BeginX: [b, 0], BeginY: [b, 1], EndX: [e, 0], EndY: [e, 1] }[name]; i[0][i[1]] = v; O.setEndpoints(doc, page(), model, S, b, e); }));
        box.append(fld("X iniziale", "BeginX"), fld("Y iniziale", "BeginY"), fld("X finale", "EndX"), fld("Y finale", "EndY"), roField("Lunghezza", fmtU(Math.hypot(num0(doc, S, "EndX") - num0(doc, S, "BeginX"), num0(doc, S, "EndY") - num0(doc, S, "BeginY")))));
      } else {
        const W = num0(doc, S, "Width"), H = num0(doc, S, "Height");
        box.append(
          numField("X", num0(doc, S, "PinX"), v => run(() => { O.moveShapes(doc, page(), model, [S], v - num0(doc, S, "PinX"), 0); O.rerouteFor(doc, page(), getFresh(), new Set([S.id])); })),
          numField("Y", num0(doc, S, "PinY"), v => run(() => { O.moveShapes(doc, page(), model, [S], 0, v - num0(doc, S, "PinY")); O.rerouteFor(doc, page(), getFresh(), new Set([S.id])); })),
          numField("Larghezza", W, v => v > 0 && run(() => { O.resizeShape(doc, page(), model, S, [(W - v) * num0(doc, S, "LocPinX") / (W || 1), 0, (W - v) * num0(doc, S, "LocPinX") / (W || 1) + v, H]); O.rerouteFor(doc, page(), getFresh(), new Set([S.id])); })),
          numField("Altezza", H, v => v > 0 && run(() => { O.resizeShape(doc, page(), model, S, [0, (H - v) * num0(doc, S, "LocPinY") / (H || 1), W, (H - v) * num0(doc, S, "LocPinY") / (H || 1) + v]); O.rerouteFor(doc, page(), getFresh(), new Set([S.id])); })),
          numField("Angolo", num0(doc, S, "Angle") * 180 / Math.PI, v => run(() => { O.rotateShape(doc, page(), S, v * Math.PI / 180); O.rerouteFor(doc, page(), getFresh(), new Set([S.id])); }), "°"));
      }
      right.append(box);
    }
    if (panels.data) {
      const box = el("section", { class: "vs-pane" }, el("div", { class: "vs-ptitle" }, "Dati forma"));
      if (!S) box.append(el("p", { class: "vs-empty" }, "Seleziona una forma per vederne i dati"));
      else {
        box.append(el("div", { class: "vs-sname" }, `${shapeName(S)}  ·  ID ${S.id}${S.master ? "  ·  master: " + S.master.name : ""}`));
        const data = O.shapeData(doc, S);
        if (!data.length) box.append(el("p", { class: "vs-empty" }, "Questa forma non ha dati"));
        const tbl = el("div", { class: "vs-data" });
        for (const d of data) {
          let inp;
          if (d.type === 1 || d.type === 4) { inp = el("select", { class: "vs-in" }); const opts = String(d.format || "").split(";").filter(Boolean); if (!opts.includes(d.value)) opts.unshift(d.value); for (const o of opts) inp.append(el("option", { value: o, selected: o === d.value || undefined }, o)); }
          else if (d.type === 3) inp = el("input", { type: "checkbox", checked: (d.value === "1" || /^true$/i.test(d.value)) || undefined });
          else inp = el("input", { class: "vs-in", value: d.value });
          inp.disabled = readOnly;
          inp.addEventListener("change", () => run(() => O.setData(doc, page(), S, d.key, d.type === 3 ? inp.checked : inp.value, d.type)));
          if (d.prompt) inp.title = d.prompt;
          tbl.append(el("label", { class: "vs-dl", title: d.prompt || d.label }, d.label), inp);
        }
        box.append(tbl);
        if (!readOnly) box.append(el("button", { type: "button", class: "vs-sm vs-add", onclick: async () => { const lab = await askText("Definisci dati forma", "Etichetta del nuovo dato"); if (!lab) return; const v = await askText("Definisci dati forma", `Valore di "${lab}"`); await run(() => O.addData(doc, page(), S, lab, v || "")); } }, "+ Aggiungi dato"));
      }
      right.append(box);
    }
    statusText();
  }
  function numField(label, v, onSet, unit) {
    const inp = el("input", { class: "vs-in", value: unit === "°" ? String(Math.round(v * 100) / 100).replace(".", ",") : String(Math.round(toUnit(v) * 100) / 100).replace(".", ","), disabled: readOnly || undefined });
    inp.addEventListener("change", () => { const n = parseFloat(inp.value.replace(",", ".")); if (Number.isFinite(n)) onSet(unit === "°" ? n : fromUnit(n)); });
    inp.addEventListener("keydown", e => { if (e.key === "Enter") inp.blur(); });
    return el("label", { class: "vs-field" }, el("span", {}, label), inp, el("small", {}, unit || uName()));
  }
  const roField = (label, text) => el("label", { class: "vs-field" }, el("span", {}, label), el("b", {}, text));

  // ------------------------------------------------------------------ pagine in basso
  function renderPages() {
    pagebar.innerHTML = "";
    const nav = el("div", { class: "vs-pnav" },
      el("button", { type: "button", title: "Pagina precedente (Ctrl+Pag su)", onclick: () => goPage(pageIdx - 1) }, "◀"),
      el("button", { type: "button", title: "Pagina successiva (Ctrl+Pag giu')", onclick: () => goPage(pageIdx + 1) }, "▶"),
      el("button", { type: "button", title: "Tutte le pagine", onclick: e => openMenu(e.currentTarget, doc.pages.map((p, i) => ({ label: p.name + (p.background ? " (sfondo)" : ""), on: i === pageIdx, run: () => goPage(i) }))) }, "☰"));
    const list = el("div", { class: "vs-ptabs" });
    doc.pages.forEach((p, i) => {
      const t = el("button", { type: "button", class: "vs-ptab" + (i === pageIdx ? " on" : "") + (p.background ? " bg" : ""), title: p.name + (p.background ? " (pagina di sfondo)" : ""), onclick: () => goPage(i), ondblclick: () => !readOnly && renamePage(p) }, p.name);
      t.addEventListener("contextmenu", e => { e.preventDefault(); openMenu({ x: e.clientX, y: e.clientY }, [{ label: "Inserisci pagina", icon: "pageAdd", run: newPage, dis: readOnly }, { label: "Elimina", icon: "trash", run: () => removePage(p), dis: readOnly }, { label: "Rinomina", icon: "rename", run: () => renamePage(p), dis: readOnly }]); });
      list.append(t);
    });
    if (!readOnly) list.append(el("button", { type: "button", class: "vs-padd", title: "Inserisci pagina", onclick: newPage }, "+"));
    pagebar.append(nav, list);
    requestAnimationFrame(() => list.querySelector(".on")?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  }
  const zoomRange = el("input", { type: "range", min: "-400", max: "500", step: "1", title: "Zoom" });
  zoomRange.addEventListener("input", () => setZoom((96 / 72) * 2 ** (+zoomRange.value / 100)));
  const zoomLab = el("span", { class: "vs-zl" }, "100%");
  const stText = el("span", { class: "vs-st" });
  status.append(stText, el("span", { class: "grow" }),
    el("button", { type: "button", class: "vs-zb", title: "Riduci (Alt+Maiusc+F6)", onclick: () => setZoom(scale / 1.25) }, "−"), zoomRange,
    el("button", { type: "button", class: "vs-zb", title: "Ingrandisci (Alt+F6)", onclick: () => setZoom(scale * 1.25) }, "+"), zoomLab,
    el("button", { type: "button", class: "vs-zb fit", title: "Adatta pagina alla finestra (Ctrl+Maiusc+W)", onclick: fitPage, html: vsIcon("zoomPage") }));
  function statusText(extra) {
    const S = one();
    let s = `Pagina ${pageIdx + 1} di ${doc.pages.length}`;
    if (S && !is1D(doc, S)) s += `   Larghezza: ${fmtU(num0(doc, S, "Width"))}   Altezza: ${fmtU(num0(doc, S, "Height"))}   Angolo: ${Math.round(num0(doc, S, "Angle") * 1800 / Math.PI) / 10}°`;
    else if (S) s += `   Lunghezza: ${fmtU(Math.hypot(num0(doc, S, "EndX") - num0(doc, S, "BeginX"), num0(doc, S, "EndY") - num0(doc, S, "BeginY")))}`;
    else if (sel.length) s += `   ${sel.length} forme selezionate`;
    if (readOnly) s += "   ·   sola lettura";
    stText.textContent = extra ? s + "   ·   " + extra : s;
    ctx.status(`Pagina ${pageIdx + 1}/${doc.pages.length} · ${zoomLab.textContent}`);
  }

  // ------------------------------------------------------------------ Trova
  let findBox = null;
  function findPanel() {
    if (findBox) { findBox.querySelector("input").focus(); return; }
    const q = el("input", { type: "search", class: "vs-in", placeholder: "Testo da cercare" });
    const rep = el("input", { type: "text", class: "vs-in", placeholder: "Sostituisci con" });
    const inData = el("input", { type: "checkbox", checked: true }), inNames = el("input", { type: "checkbox" }), allPages = el("input", { type: "checkbox", checked: true }), mcase = el("input", { type: "checkbox" });
    const res = el("div", { class: "vs-fres" });
    let hits = [], cur = -1;
    const norm = s => mcase.checked ? s : s.toLowerCase();
    const doFind = () => {
      hits = []; cur = -1; res.innerHTML = "";
      const t = q.value;
      if (!t) return;
      const pages = allPages.checked ? doc.pages : [page()];
      for (const P of pages) {
        const m = getModel(P);
        const walk = (S, top) => {
          const txt = plainText(S);
          let where = null;
          if (txt && norm(txt).includes(norm(t))) where = "testo";
          else if (inData.checked && O.shapeData(doc, S).some(d => norm(String(d.value)).includes(norm(t)) || norm(d.label).includes(norm(t)))) where = "dati";
          else if (inNames.checked && norm(shapeName(S)).includes(norm(t))) where = "nome";
          if (where && top) hits.push({ P, id: top.id, S, where, txt: txt || shapeName(S) });
          for (const C of S.children) walk(C, top);
        };
        for (const S of m.top) walk(S, S);
      }
      res.append(el("div", { class: "vs-fcount" }, hits.length ? `${hits.length} risultat${hits.length === 1 ? "o" : "i"}` : "Nessun risultato"));
      hits.forEach((h, i) => res.append(el("button", { type: "button", class: "vs-fhit", onclick: () => go(i) }, el("b", {}, h.P.name), " · ", h.where, ": ", h.txt.slice(0, 70))));
      if (hits.length) go(0);
    };
    const go = i => {
      if (!hits.length) return;
      cur = (i + hits.length) % hits.length;
      const h = hits[cur];
      const pi = doc.pages.indexOf(h.P);
      if (pi !== pageIdx) { pageIdx = pi; sel = []; render(); }
      selectById([h.id]);
      if (sel[0]) showShape(sel[0]);
      res.querySelectorAll(".vs-fhit").forEach((b, k) => b.classList.toggle("on", k === cur));
    };
    const replaceAll = async () => {
      if (!q.value || readOnly) return;
      const t = q.value, r = rep.value;
      const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), mcase.checked ? "g" : "gi");
      let n = 0;
      await run(() => {
        for (const P of allPages.checked ? doc.pages : [page()]) {
          const m = getModel(P);
          const walk = S => { const txt = plainText(S); if (S.el && txt && re.test(txt)) { re.lastIndex = 0; O.setText(doc, P, S, txt.replace(re, r)); n++; } re.lastIndex = 0; S.children.forEach(walk); };
          m.top.forEach(walk);
        }
      });
      toast(n ? `Sostituito il testo in ${n} form${n === 1 ? "a" : "e"}` : "Nessuna sostituzione");
      doFind();
    };
    q.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); if (hits.length && q.value === q._last) go(cur + (e.shiftKey ? -1 : 1)); else { q._last = q.value; doFind(); } } if (e.key === "Escape") close(); e.stopPropagation(); });
    const close = () => { findBox.remove(); findBox = null; };
    findBox = el("div", { class: "vs-find" },
      el("div", { class: "vs-fhead" }, el("b", {}, "Trova"), el("span", { class: "grow" }), el("button", { type: "button", class: "vs-x", title: "Chiudi (Esc)", onclick: close }, "×")),
      q, el("div", { class: "vs-frow" }, el("button", { type: "button", class: "vs-sm", onclick: () => { q._last = q.value; doFind(); } }, "Trova"), el("button", { type: "button", class: "vs-sm", onclick: () => go(cur - 1) }, "◀ Precedente"), el("button", { type: "button", class: "vs-sm", onclick: () => go(cur + 1) }, "Successivo ▶")),
      el("div", { class: "vs-frow" }, el("label", {}, inData, "Dati forma"), el("label", {}, inNames, "Nomi"), el("label", {}, allPages, "Tutte le pagine"), el("label", {}, mcase, "Maiuscole/minuscole")),
      readOnly ? null : el("div", { class: "vs-frow" }, rep, el("button", { type: "button", class: "vs-sm", onclick: replaceAll }, "Sostituisci tutto")),
      res);
    root.append(findBox);
    q.focus();
  }

  // ------------------------------------------------------------------ esportazioni
  const fgPages = () => doc.pages.filter(p => !p.background);
  function renderFor(P) { return renderPage(doc, P, getModel(P), { models: getModel, print: true }); }
  const outPath = (path, i, n, ext) => n > 1 ? path.replace(/(\.[^.\\/]+)?$/, `_${i + 1}.${ext}`) : path;
  async function exportSvg(path) {
    const pages = fgPages();
    for (let i = 0; i < pages.length; i++) await api("save", { path: outPath(path, i, pages.length, "svg") }, { body: new TextEncoder().encode(pageSvg(renderFor(pages[i]), dataUrl, { title: pages[i].name })) });
    return pages.length;
  }
  async function pagePng(P, dpi = 150) {
    const RR = renderFor(P);
    const s = pageSvg(RR, dataUrl);
    const img = new Image();
    const url = URL.createObjectURL(new Blob([s], { type: "image/svg+xml" }));
    try {
      await new Promise((ok, ko) => { img.onload = ok; img.onerror = () => ko(new Error("Immagine della pagina non disegnabile")); img.src = url; });
      const k = dpi / 72, c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(RR.info.wPt * k)); c.height = Math.max(1, Math.round(RR.info.hPt * k));
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      return new Uint8Array(await (await new Promise(r => c.toBlob(r, "image/png"))).arrayBuffer());
    } finally { URL.revokeObjectURL(url); }
  }
  async function exportPng(path) {
    const pages = fgPages();
    for (let i = 0; i < pages.length; i++) await api("save", { path: outPath(path, i, pages.length, "png") }, { body: await pagePng(pages[i]) });
    return pages.length;
  }
  async function exportPdf(path) {
    const pages = [], blobs = {}, parts = [];
    let off = 0;
    for (const P of fgPages()) {
      const RR = renderFor(P);
      const ops = [];
      for (const o of [...RR.back, ...RR.items.flatMap(it => it.ops)]) {
        if (o.t === "image") {
          const m = media.get(o.key);
          if (!m || !/png|jpeg/.test(m.mime)) continue;
          if (!blobs[o.key]) { blobs[o.key] = [off, m.bytes.length]; parts.push(m.bytes); off += m.bytes.length; }
          ops.push({ t: "image", key: o.key, c: o.c, w: o.w, h: o.h, a: o.a });
        } else if (o.t === "path" && o.grad) ops.push({ ...o, grad: undefined, fill: o.grad.stops[Math.floor(o.grad.stops.length / 2)]?.[1] || o.fill });
        else ops.push(o);
      }
      pages.push({ w: RR.info.wPt, h: RR.info.hPt, ops });
    }
    const json = new TextEncoder().encode(JSON.stringify({ title: baseName(ctx.tab.name).replace(/\.[^.]+$/, ""), pages, blobs }));
    const body = new Uint8Array(10 + json.length + off);
    body.set(new TextEncoder().encode("MBPUB1"), 0);
    new DataView(body.buffer).setUint32(6, json.length, true);
    body.set(json, 10);
    let p = 10 + json.length;
    for (const b of parts) { body.set(b, p); p += b.length; }
    await api("visio_pdf", { path }, { body });
  }

  // ------------------------------------------------------------------ tasti (come Visio)
  const ed = () => !readOnly;
  const defs = [
    { keys: "Ctrl+Z", desc: "Annulla", group: "Modifica", run: () => doUndo(undo, redo), when: ed },
    { keys: "Ctrl+Y|Ctrl+Shift+Z", desc: "Ripeti", group: "Modifica", run: () => doUndo(redo, undo), when: ed },
    { keys: "Ctrl+C", desc: "Copia", group: "Modifica", run: copy }, { keys: "Ctrl+X", desc: "Taglia", group: "Modifica", run: cut, when: ed },
    { keys: "Ctrl+V", desc: "Incolla", group: "Modifica", run: paste, when: ed }, { keys: "Ctrl+D", desc: "Duplica", group: "Modifica", run: duplicate, when: ed },
    { keys: "Delete|Backspace", desc: "Elimina le forme selezionate (anche i connettori incollati)", group: "Modifica", run: cmdDelete, when: () => ed() && sel.length > 0 },
    { keys: "Ctrl+A", desc: "Seleziona tutto", group: "Modifica", run: () => setSel(model.top) },
    { keys: "Escape", desc: "Deseleziona / torna al Puntatore", group: "Modifica", run: () => { if (tool !== "pointer") setTool("pointer"); else setSel([]); } },
    { keys: "Ctrl+F", desc: "Trova (anche nei dati delle forme e in tutte le pagine)", group: "Modifica", run: findPanel },
    { keys: "F2", desc: "Modifica il testo della forma (oppure inizia a scrivere)", group: "Testo", run: () => sel[0] && beginEdit(sel[0]), when: ed },
    { keys: "Ctrl+1", desc: "Strumento Puntatore", group: "Strumenti", run: () => setTool("pointer") },
    { keys: "Ctrl+2", desc: "Strumento Testo", group: "Strumenti", run: () => setTool("text"), when: ed },
    { keys: "Ctrl+3", desc: "Strumento Connettore", group: "Strumenti", run: () => setTool("connector"), when: ed },
    { keys: "Ctrl+6", desc: "Strumento Linea", group: "Strumenti", run: () => setTool("line"), when: ed },
    { keys: "Ctrl+8", desc: "Strumento Rettangolo", group: "Strumenti", run: () => setTool("rect"), when: ed },
    { keys: "Ctrl+9", desc: "Strumento Ellisse", group: "Strumenti", run: () => setTool("ellipse"), when: ed },
    { keys: "Ctrl+G", desc: "Raggruppa", group: "Disponi", run: cmdGroup, when: ed },
    { keys: "Ctrl+Shift+U", desc: "Separa (scomponi il gruppo)", group: "Disponi", run: cmdUngroup, when: ed },
    { keys: "Ctrl+Shift+F", desc: "Porta in primo piano", group: "Disponi", run: () => cmdZ("front"), when: ed },
    { keys: "Ctrl+Shift+B", desc: "Porta sullo sfondo", group: "Disponi", run: () => cmdZ("back"), when: ed },
    { keys: "Ctrl+L", desc: "Ruota a sinistra di 90°", group: "Disponi", run: () => cmdRotate(90), when: ed },
    { keys: "Ctrl+R", desc: "Ruota a destra di 90°", group: "Disponi", run: () => cmdRotate(-90), when: ed },
    { keys: "Ctrl+H", desc: "Capovolgi orizzontalmente", group: "Disponi", run: () => cmdFlip("x"), when: ed },
    { keys: "Ctrl+J", desc: "Capovolgi verticalmente", group: "Disponi", run: () => cmdFlip("y"), when: ed },
    { keys: "ArrowLeft", desc: "Sposta la selezione (Maiusc: passo fine)", group: "Disponi", run: e => nudge(e.shiftKey ? -0.25 : -1, 0), when: () => ed() && sel.length > 0 },
    { keys: "ArrowRight", desc: "Sposta la selezione", group: "Disponi", run: e => nudge(e.shiftKey ? 0.25 : 1, 0), when: () => ed() && sel.length > 0 },
    { keys: "ArrowUp", desc: "Sposta la selezione", group: "Disponi", run: e => nudge(0, e.shiftKey ? 0.25 : 1), when: () => ed() && sel.length > 0 },
    { keys: "ArrowDown", desc: "Sposta la selezione", group: "Disponi", run: e => nudge(0, e.shiftKey ? -0.25 : -1), when: () => ed() && sel.length > 0 },
    { keys: "Shift+ArrowLeft", desc: "Sposta di un passo fine", group: "Disponi", run: () => nudge(-0.25, 0), when: () => ed() && sel.length > 0 },
    { keys: "Shift+ArrowRight", desc: "Sposta di un passo fine", group: "Disponi", run: () => nudge(0.25, 0), when: () => ed() && sel.length > 0 },
    { keys: "Shift+ArrowUp", desc: "Sposta di un passo fine", group: "Disponi", run: () => nudge(0, 0.25), when: () => ed() && sel.length > 0 },
    { keys: "Shift+ArrowDown", desc: "Sposta di un passo fine", group: "Disponi", run: () => nudge(0, -0.25), when: () => ed() && sel.length > 0 },
    { keys: "Ctrl+B", desc: "Grassetto", group: "Testo", run: () => setChar({ b: !charOn("b")() }), when: () => ed() && sel.length > 0 },
    { keys: "Ctrl+I", desc: "Corsivo", group: "Testo", run: () => setChar({ i: !charOn("i")() }), when: () => ed() && sel.length > 0 },
    { keys: "Ctrl+U", desc: "Sottolineato", group: "Testo", run: () => setChar({ u: !charOn("u")() }), when: () => ed() && sel.length > 0 },
    { keys: "Ctrl+Shift+>|Ctrl+Shift+.", desc: "Aumenta la dimensione del carattere", group: "Testo", run: () => setChar({ dsize: 2 }), when: () => ed() && sel.length > 0 },
    { keys: "Ctrl+Shift+<|Ctrl+Shift+,", desc: "Riduci la dimensione del carattere", group: "Testo", run: () => setChar({ dsize: -2 }), when: () => ed() && sel.length > 0 },
    { keys: "Ctrl+Shift+L", desc: "Allinea il testo a sinistra", group: "Testo", run: () => setPara(0), when: () => ed() && sel.length > 0 },
    { keys: "Ctrl+Shift+C", desc: "Centra il testo", group: "Testo", run: () => setPara(1), when: () => ed() && sel.length > 0 },
    { keys: "Ctrl+Shift+R", desc: "Allinea il testo a destra", group: "Testo", run: () => setPara(2), when: () => ed() && sel.length > 0 },
    { keys: "Ctrl+Shift+W", desc: "Adatta pagina alla finestra", group: "Visualizza", run: fitPage },
    { keys: "Alt+F6|Ctrl+Plus", desc: "Ingrandisci", group: "Visualizza", run: () => setZoom(scale * 1.25) },
    { keys: "Alt+Shift+F6|Ctrl+Minus", desc: "Riduci", group: "Visualizza", run: () => setZoom(scale / 1.25) },
    { keys: "F5", desc: "Schermo intero", group: "Visualizza", run: fullScreen },
    { keys: "Ctrl+PageDown", desc: "Pagina successiva", group: "Pagine", run: () => goPage(pageIdx + 1) },
    { keys: "Ctrl+PageUp", desc: "Pagina precedente", group: "Pagine", run: () => goPage(pageIdx - 1) },
  ];
  keymap(ctx, "Visio", defs, window);
  describeKeys(ctx, "Visio", [
    ["Rotellina + Ctrl", "Zoom attorno al puntatore", "Visualizza"], ["Pulsante centrale o Spazio + trascinamento", "Sposta la vista", "Visualizza"],
    ["Maiusc durante lo spostamento", "Solo in orizzontale o in verticale", "Forme"], ["Alt durante lo spostamento", "Senza aggancio alla griglia", "Forme"],
    ["Maiusc + maniglia d'angolo", "Ridimensiona senza mantenere le proporzioni (immagini) / mantenendole (forme)", "Forme"], ["Maiusc + rotazione", "Ruota a passi di 15°", "Forme"],
    ["Doppio clic", "Modifica il testo della forma", "Testo"], ["Esc (nel testo)", "Termina la modifica del testo", "Testo"],
    ["Trascina un estremo del connettore su una forma", "Incolla il connettore alla forma (segue gli spostamenti)", "Connettori"],
    ["Doppio clic sulla linguetta della pagina", "Rinomina la pagina", "Pagine"],
  ]);
  // scrivere con una forma selezionata ne sostituisce il testo (come Visio)
  window.addEventListener("keydown", e => {
    if (!ctx.tab?.view?.isConnected || ctx.tab.view.hidden || editing || readOnly || e.defaultPrevented) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || sel.length !== 1 || e.target.closest?.("input, textarea, select")) return;
    if (document.getElementById("modal") && !document.getElementById("modal").hidden) return;
    e.preventDefault();
    beginEdit(sel[0], e.key);
  });
  canvas.addEventListener("keydown", e => { if (e.key === " ") e.preventDefault(); });

  // ------------------------------------------------------------------ avvio
  const ro = new ResizeObserver(() => sizeStage());
  ro.observe(canvas);
  buildRibbon();
  layoutPanels();
  renderStencils();
  const ready = loadMedia().then(() => { models.clear(); render(); renderStencils(); preview.clear(); });
  render();
  requestAnimationFrame(fitPage);

  return {
    ready, doc: () => doc, page, model: () => model, sel: () => sel, setSel, selectById, render, fitPage, setZoom, goPage, run, beginEdit, endEdit, setTool,
    exportSvg, exportPng, exportPdf, pagePng, onShow() { requestAnimationFrame(() => { sizeStage(); overlay(); }); canvas.focus({ preventScroll: true }); },
    onBack() { if (editing) { endEdit(); return true; } if (findBox) { findBox.remove(); findBox = null; return true; } if (tool !== "pointer") { setTool("pointer"); return true; } if (sel.length) { setSel([]); return true; } return false; },
    async save() { if (editing) await endEdit(); return await saveVsdx(doc); },
    evPt, toPt, fromPt, svg, canvas, scale: () => scale, undoLen: () => undo.length,
    async dropImages(paths) {
      for (const f of paths) {
        const bytes = await readBytes(f);
        const bmp = await createImageBitmap(new Blob([bytes]));
        const P = page(), c = viewCenter(), w0 = bmp.width / 96, h0 = bmp.height / 96, k = Math.min(1, info().W * 0.5 / w0);
        await run(async () => { const rid = await addImagePart(doc, P, bytes, extOf(f) === "jpeg" ? "jpg" : extOf(f)); const id = O.createImage(doc, P, model, rid, c[0], c[1], w0 * k, h0 * k); await loadMedia(); return [id]; }, false);
      }
    },
    setMainType(ext) { return setMainType(doc, ext); },
  };
}

// tipo della parte principale secondo l'estensione (disegno, modello, con macro)
const MAIN_TYPES = { vsdx: "application/vnd.ms-visio.drawing.main+xml", vsdm: "application/vnd.ms-visio.drawing.macroEnabled.main+xml", vstx: "application/vnd.ms-visio.template.main+xml", vstm: "application/vnd.ms-visio.template.macroEnabled.main+xml", vssx: "application/vnd.ms-visio.stencil.main+xml", vssm: "application/vnd.ms-visio.stencil.macroEnabled.main+xml" };
export async function setMainType(doc, ext) {
  const t = MAIN_TYPES[ext];
  if (!t) return;
  const ct = await doc.read("[Content_Types].xml");
  for (const o of ct.documentElement.children) if (o.getAttribute("PartName") === "/" + doc.docPath) { if (o.getAttribute("ContentType") !== t) { o.setAttribute("ContentType", t); markDirty(doc, "[Content_Types].xml"); } }
  if (!/m$/.test(ext)) {
    // senza macro: via il progetto VBA (Visio non apre un .vsdx che lo contiene)
    const rels = await doc.read(doc.docPath.replace(/[^/]+$/, "_rels/") + doc.docPath.split("/").pop() + ".rels");
    if (rels) for (const r of [...rels.documentElement.children]) if (/vbaProject/i.test(r.getAttribute("Type") || "")) { const tgt = r.getAttribute("Target"); r.remove(); markDirty(doc, doc.docPath.replace(/[^/]+$/, "_rels/") + doc.docPath.split("/").pop() + ".rels"); doc.zip.remove(doc.docPath.replace(/[^/]+$/, "") + tgt); for (const o of [...ct.documentElement.children]) if (/vbaProject/i.test(o.getAttribute("PartName") || "")) { o.remove(); markDirty(doc, "[Content_Types].xml"); } }
  }
}
void setCell; void textEl; void cell;
