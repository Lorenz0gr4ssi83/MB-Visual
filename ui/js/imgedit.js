// Editor di immagini con la stessa disposizione di Photoshop: menu (Modifica, Immagine, Livello, Seleziona, Filtro,
// Visualizza, Finestra), barra delle opzioni dello strumento in alto, barra strumenti verticale a sinistra con gli stessi
// gruppi, icone e lettere, colori di primo piano/sfondo, pannelli a destra (Proprieta', Regolazioni, Cronologia, Livelli).
//
// Modello: livelli dal basso verso l'alto { kind: pixel|text|shape|adjust, c: canvas, x, y, visible, opacity, blend,
// mask: { c, x, y, on } | null, props }. I canvas non si modificano mai sul posto: ogni modifica crea un canvas nuovo,
// cosi' la cronologia (annulla multiplo, pannello Cronologia) conserva solo riferimenti. Le maschere usano l'alfa
// (opaco = visibile). La selezione e' un canvas alfa grande quanto il documento con il suo contorno (formiche).
import { t as tr, tn } from "./i18n.js";
import { api, button, el, toast, modal, pickFiles, fileUrl, extOf, withExt, WEB } from "./core.js";
import { INK_ICON, paint as paintInk } from "./ink.js";
import { pinchPan } from "./touch.js";
import { keymap, describeKeys } from "./shortcuts.js";
import { psIcon } from "./psicons.js";
import { ADJ, FILTERS, makeAdjust, autoAdjust, histogram, adjustControls, filterControls, blurCanvas, mkCanvas, hexToRgb, rgbToHex, lum } from "./imgadjust.js";
import { BLENDS, readPsd, writePsd, readOra, writeOra } from "./imgfile.js";

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const g2 = c => c.getContext("2d");
const cloneC = c => { const d = mkCanvas(c.width, c.height); g2(d).drawImage(c, 0, 0); return d; };
const readData = c => c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);

// strumenti: stesso ordine, gruppi e lettere della barra di Photoshop
const TOOLS = {
  move: { name: tr("imgedit.strumento_sposta"), key: "V" },
  marqueeRect: { name: tr("imgedit.strumento_selezione_rettangolare"), key: "M" }, marqueeEllipse: { name: tr("imgedit.strumento_selezione_ellittica"), key: "M" },
  lasso: { name: tr("imgedit.strumento_lazo"), key: "L" }, lassoPoly: { name: tr("imgedit.strumento_lazo_poligonale"), key: "L" },
  wand: { name: tr("imgedit.strumento_bacchetta_magica"), key: "W" },
  crop: { name: tr("imgedit.strumento_taglierina"), key: "C" },
  eyedropper: { name: tr("imgedit.strumento_contagocce"), key: "I" },
  brush: { name: tr("imgedit.strumento_pennello"), key: "B" }, pencil: { name: tr("imgedit.strumento_matita"), key: "B" },
  stamp: { name: tr("imgedit.strumento_timbro_clone"), key: "S" },
  eraser: { name: tr("imgedit.strumento_gomma"), key: "E" },
  gradient: { name: tr("imgedit.strumento_sfumatura"), key: "G" }, bucket: { name: tr("imgedit.strumento_secchiello"), key: "G" },
  type: { name: tr("imgedit.strumento_testo_orizzontale"), key: "T" },
  shapeRect: { name: tr("imgedit.strumento_rettangolo"), key: "U" }, shapeRound: { name: tr("imgedit.strumento_rettangolo_arrotondato"), key: "U" },
  shapeEllipse: { name: tr("imgedit.strumento_ellisse"), key: "U" }, shapeLine: { name: tr("imgedit.strumento_linea"), key: "U" },
  hand: { name: tr("imgedit.strumento_mano"), key: "H" },
  zoom: { name: tr("imgedit.strumento_zoom"), key: "Z" },
};
const GROUPS = [["move"], ["marqueeRect", "marqueeEllipse"], ["lasso", "lassoPoly"], ["wand"], ["crop"], ["eyedropper"], ["brush", "pencil"], ["stamp"], ["eraser"],
  ["gradient", "bucket"], ["type"], ["shapeRect", "shapeRound", "shapeEllipse", "shapeLine"], ["hand"], ["zoom"]];
const SEP_AFTER = new Set([0, 4, 5, 9, 11]); // linee di separazione come nella barra di Photoshop
const PAINT = new Set(["brush", "pencil", "eraser", "stamp"]);
const ZOOMS = [0.01, 0.02, 0.03, 0.04, 0.05, 0.0625, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 32, 64];
const FONTS = ["Arial", "Arial Black", "Bahnschrift", "Calibri", "Cambria", "Candara", "Comic Sans MS", "Consolas", "Constantia", "Corbel", "Courier New", "Georgia", "Impact",
  "Segoe Print", "Segoe Script", "Segoe UI", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana"];

export function createEditor(ctx, init) {
  let W = init.W, H = init.H, uid = 1;
  const mkLayer = o => ({ id: uid++, name: tr("imgedit.livello"), kind: "pixel", c: null, x: 0, y: 0, visible: true, opacity: 100, blend: "source-over", mask: null, props: null, ...o });
  let layers = init.layers.map(mkLayer);
  let act = layers.length - 1, target = "pixels", sel = null, lastSel = null;
  let fg = "#000000", bg = "#ffffff", tool = "brush", showExtras = true, maskView = false, curExt = ctx.ext;
  const groupCur = GROUPS.map(g => g[0]);
  const opt = {
    brush: { size: 30, hard: 0, opacity: 100, flow: 100 }, pencil: { size: 4, hard: 1, opacity: 100, flow: 100 }, eraser: { size: 40, hard: 0, opacity: 100, flow: 100 },
    stamp: { size: 60, hard: 0, opacity: 100, flow: 100, aligned: true, all: false },
    sel: { mode: "new", feather: 0 }, wand: { tol: 32, contig: true, all: false }, bucket: { tol: 32, contig: true, all: false, opacity: 100 },
    gradient: { type: "linear", kind: "fgbg", reverse: false, opacity: 100 }, type: { font: "Arial", size: 48, bold: false, italic: false, align: "left" },
    shape: { fill: true, stroke: false, sw: 4, r: 24, color2: "#000000" }, move: { auto: false, ctrls: false }, crop: { ratio: "free", del: true }, eyedropper: { size: 1, all: true },
  };
  for (const k of ["brush", "pencil", "eraser", "stamp"]) opt[k].size = Math.max(opt[k].size, Math.round(Math.max(W, H) / 60));
  opt.type.size = Math.max(opt.type.size, Math.round(Math.min(W, H) / 25)); opt.shape.sw = Math.max(opt.shape.sw, Math.round(Math.min(W, H) / 300));

  // ------------------------------------------------------------ composizione dei livelli
  let comp = mkCanvas(W, H), ver = 0, below = null, belowKey = "", preview = null, needComp = true, raf = 0, scr = null;
  const scratch = (w, h) => {
    if (!scr || scr.width !== w || scr.height !== h) scr = mkCanvas(w, h);
    const g = g2(scr); g.globalCompositeOperation = "source-over"; g.globalAlpha = 1; g.clearRect(0, 0, w, h);
    return scr;
  };
  // disegna un livello su g (canvas che parte dal punto ox,oy del documento); ov = anteprima di pixel o maschera
  function renderLayer(g, L, ox = 0, oy = 0, ov = null) {
    if (!L.visible || L.editing) return;
    const cw = g.canvas.width, ch = g.canvas.height, mask = ov && "mask" in ov ? ov.mask : L.mask;
    if (L.kind === "adjust") {
      const id = g.getImageData(0, 0, cw, ch);
      makeAdjust(L.props.type, L.props.p)(id.data);
      if (!mask?.on && L.opacity === 100 && L.blend === "source-over") { g.putImageData(id, 0, 0); return; }
      const s = scratch(cw, ch), sg = g2(s);
      sg.putImageData(id, 0, 0);
      if (mask?.on) { sg.globalCompositeOperation = "destination-in"; sg.drawImage(mask.c, mask.x - ox, mask.y - oy); }
      g.globalAlpha = L.opacity / 100; g.globalCompositeOperation = L.blend; g.drawImage(s, 0, 0);
      g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
      return;
    }
    const c = ov?.c || L.c, x = (ov?.c ? ov.x : L.x) - ox, y = (ov?.c ? ov.y : L.y) - oy;
    if (!c) return;
    let src = c, sx = x, sy = y;
    if (mask?.on) {
      const s = scratch(cw, ch), sg = g2(s);
      sg.drawImage(c, x, y); sg.globalCompositeOperation = "destination-in"; sg.drawImage(mask.c, mask.x - ox, mask.y - oy);
      src = s; sx = sy = 0;
    }
    g.globalAlpha = L.opacity / 100; g.globalCompositeOperation = L.blend; g.drawImage(src, sx, sy);
    g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
  }
  function composite() {
    const g = g2(comp);
    g.clearRect(0, 0, W, H);
    let start = 0;
    if (preview && !(preview.i >= 0 && preview.i < layers.length)) preview = null;
    if (preview) {
      const key = ver + ":" + preview.i;
      if (belowKey !== key) {
        if (!below || below.width !== W || below.height !== H) below = mkCanvas(W, H);
        const bg_ = g2(below); bg_.clearRect(0, 0, W, H);
        for (let i = 0; i < preview.i; i++) renderLayer(bg_, layers[i]);
        belowKey = key;
      }
      g.drawImage(below, 0, 0); start = preview.i;
    }
    for (let i = start; i < layers.length; i++) renderLayer(g, layers[i], 0, 0, preview && i === preview.i ? preview : null);
  }
  const invalidate = () => { ver++; needComp = true; schedule(); thumbsLater(); };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(frame); };
  function frame() {
    raf = 0;
    if (stroke?.dirty) { strokePreview(stroke); stroke.dirty = false; }
    if (needComp) { composite(); needComp = false; }
    paint();
    measHook?.(); // strato delle misure (ui/js/measure/mimg.js)
  }
  let measHook = null;
  function setPreview(p) { preview = p; needComp = true; schedule(); }
  // documento appiattito (per il salvataggio, Copia unione, campionamento "tutti i livelli")
  function flatten(bgColor = null) {
    if (needComp) { composite(); needComp = false; }
    if (!bgColor) return cloneC(comp);
    const c = mkCanvas(W, H), g = g2(c);
    g.fillStyle = bgColor; g.fillRect(0, 0, W, H); g.drawImage(comp, 0, 0);
    return c;
  }

  // ------------------------------------------------------------ cronologia (annulla multiplo)
  let history = [], hi = -1, toggleFrom = -1;
  const copyLayer = L => ({ ...L, editing: false, props: L.props ? structuredClone(L.props) : null, mask: L.mask ? { ...L.mask } : null });
  const snap = () => ({ W, H, act, target, sel, layers: layers.map(copyLayer) });
  function restore(s) {
    const resized = s.W !== W || s.H !== H;
    W = s.W; H = s.H; act = s.act; target = s.target; sel = s.sel;
    layers = s.layers.map(copyLayer);
    if (resized) { comp = mkCanvas(W, H); fit(); }
    endText(false); tf = null; crop = null;
    invalidate(); refreshPanels();
  }
  function commit(name) {
    history = history.slice(0, hi + 1);
    history.push({ name, s: snap() });
    if (history.length > 50) history.shift(); // come Photoshop: 50 stati
    hi = history.length - 1; toggleFrom = -1;
    if (history.length > 1) ctx.setDirty(true);
    renderHistory(); renderLayers(); renderProps();
  }
  const undo = () => { if (busyCancel()) return; if (hi > 0) { hi--; restore(history[hi].s); renderHistory(); } };
  const redo = () => { if (hi < history.length - 1) { hi++; restore(history[hi].s); renderHistory(); } };
  const toggleLast = () => { if (toggleFrom >= 0 && hi === toggleFrom - 1) { hi = toggleFrom; toggleFrom = -1; } else if (hi > 0) { toggleFrom = hi; hi--; } else return; restore(history[hi].s); renderHistory(); };
  function busyCancel() { if (tf) { cancelTransform(); return true; } if (textEd) { endText(false); return true; } return false; }

  // ------------------------------------------------------------ interfaccia: struttura
  ctx.el.innerHTML = "";
  ctx.fillBody(true);
  const view = el("canvas", { class: "ps-view" });
  const textBox = el("textarea", { class: "ps-textedit", spellcheck: "false", hidden: true });
  const stage = el("div", { class: "ps-stage" }, view, textBox);
  const optBar = el("div", { class: "ps-options" });
  const toolBar = el("div", { class: "ps-tools" });
  const panels = el("div", { class: "ps-panels" });
  const root = el("div", { class: "ps-root" }, optBar, toolBar, stage, panels);
  ctx.el.append(root);
  const fgIn = el("input", { type: "color", class: "ps-hidden-color", id: "ps-fg-" + ctx.tab.name });
  const bgIn = el("input", { type: "color", class: "ps-hidden-color", id: "ps-bg-" + ctx.tab.name });
  root.append(fgIn, bgIn);
  // telefono: i pannelli coprirebbero tutta l'immagine -> partono chiusi e si aprono come foglio in basso (pulsante Livelli)
  if (matchMedia("(max-width: 760px)").matches) { panels.hidden = true; root.classList.add("ps-nopanels"); }
  root.append(el("button", { type: "button", class: "ps-mpanels", onclick: () => togglePanels() }, tr("imgedit.livelli")));

  // ------------------------------------------------------------ vista: zoom e spostamento
  let zoom = 1, panX = 0, panY = 0, autoFit = true, hover = null, antPhase = 0, cssW = 0, cssH = 0;
  const checker = (() => { const c = mkCanvas(16, 16), g = g2(c); g.fillStyle = "#fff"; g.fillRect(0, 0, 16, 16); g.fillStyle = "#cdcdcd"; g.fillRect(0, 0, 8, 8); g.fillRect(8, 8, 8, 8); return c; })();
  let checkerPat = null;
  function fit(allowUp = false) {
    const r = stage.getBoundingClientRect();
    if (!r.width) return;
    zoom = Math.min(allowUp ? 64 : 1, (r.width - 40) / W, (r.height - 40) / H);
    panX = (r.width - W * zoom) / 2; panY = (r.height - H * zoom) / 2;
    schedule(); status();
  }
  function setZoom(z, cx, cy) {
    const r = stage.getBoundingClientRect();
    if (cx === undefined) { cx = r.width / 2; cy = r.height / 2; }
    z = clamp(z, 0.01, 64); autoFit = false;
    const dx = (cx - panX) / zoom, dy = (cy - panY) / zoom;
    zoom = z; panX = cx - dx * z; panY = cy - dy * z;
    schedule(); status(); placeText();
  }
  const zoomStep = (dir, cx, cy) => setZoom(dir > 0 ? ZOOMS.find(z => z > zoom * 1.001) || 64 : [...ZOOMS].reverse().find(z => z < zoom / 1.001) || 0.01, cx, cy);
  // pr = pressione della penna (Apple Pencil, S Pen): il pennello si assottiglia premendo meno, come in Photoshop
  const docPt = e => { const r = view.getBoundingClientRect(); return { x: (e.clientX - r.left - panX) / zoom, y: (e.clientY - r.top - panY) / zoom, sx: e.clientX - r.left, sy: e.clientY - r.top, pr: e.pointerType === "pen" && e.pressure > 0 ? e.pressure : undefined }; };
  function status() {
    const L = layers[act];
    ctx.status(`${Math.round(zoom * 1000) / 10}% · ${W} × ${H} px` + (L ? ` · ${L.name}${target === "mask" && L.mask ? " (maschera)" : ""}` : "") + (init.meta?.formato ? " · " + init.meta.formato : ""));
  }

  function paint() {
    const dpr = window.devicePixelRatio || 1, r = stage.getBoundingClientRect();
    if (!r.width) return;
    if (r.width !== cssW || r.height !== cssH) { cssW = r.width; cssH = r.height; view.width = Math.round(cssW * dpr); view.height = Math.round(cssH * dpr); }
    const g = g2(view);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = getComputedStyle(root).getPropertyValue("--ps-board").trim() || "#3a3a3a";
    g.fillRect(0, 0, cssW, cssH);
    const dw = W * zoom, dh = H * zoom;
    g.fillStyle = "rgba(0,0,0,.35)"; g.fillRect(panX + 2, panY + 2, dw + 1, dh + 1);
    checkerPat ||= g.createPattern(checker, "repeat");
    g.fillStyle = checkerPat; g.fillRect(panX, panY, dw, dh);
    g.imageSmoothingEnabled = zoom < 1;
    g.imageSmoothingQuality = "medium";
    if (maskView && layers[act]?.mask) {
      const m = layers[act].mask;
      g.fillStyle = "#000"; g.fillRect(panX, panY, dw, dh);
      g.save(); g.beginPath(); g.rect(panX, panY, dw, dh); g.clip();
      g.drawImage(m.c, panX + m.x * zoom, panY + m.y * zoom, m.c.width * zoom, m.c.height * zoom); g.restore();
    } else g.drawImage(comp, panX, panY, dw, dh);
    // sovrapposizioni in coordinate del documento
    g.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * panX, dpr * panY);
    const px = 1 / zoom;
    g.lineWidth = px;
    const ants = path => {
      g.setLineDash([4 * px, 4 * px]);
      g.strokeStyle = "#fff"; g.lineDashOffset = -antPhase * px; g.stroke(path);
      g.strokeStyle = "#000"; g.lineDashOffset = -(antPhase + 4) * px; g.stroke(path);
      g.setLineDash([]);
    };
    if (sel && showExtras && !(tf && tf.float)) ants(sel.path);
    if (tool === "move" && opt.move.ctrls && !tf && layers[act]?.c) { const L = layers[act]; g.strokeStyle = "#2c8ef8"; g.strokeRect(L.x, L.y, L.c.width, L.c.height); }
    if (drag?.overlay) drag.overlay(g, px, ants);
    if (lassoPts.length) {
      const p = new Path2D(); lassoPts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
      if (hover && tool === "lassoPoly") p.lineTo(hover.x, hover.y);
      ants(p);
      g.fillStyle = "#fff"; g.strokeStyle = "#000"; g.fillRect(lassoPts[0][0] - 3 * px, lassoPts[0][1] - 3 * px, 6 * px, 6 * px); g.strokeRect(lassoPts[0][0] - 3 * px, lassoPts[0][1] - 3 * px, 6 * px, 6 * px);
    }
    if (tf) drawTransform(g, px);
    if (crop) drawCrop(g, px);
    // contorno del pennello (il puntatore resta la freccia)
    if (hover && PAINT.has(curTool()) && !drag?.noCursor) {
      const o = opt[curTool()], rr = Math.max(o.size / 2, 2 * px);
      g.beginPath(); g.arc(hover.x, hover.y, rr, 0, Math.PI * 2);
      g.strokeStyle = "rgba(0,0,0,.8)"; g.lineWidth = px * 1.5; g.stroke(); g.strokeStyle = "rgba(255,255,255,.9)"; g.lineWidth = px * 0.7; g.stroke();
      if (curTool() === "stamp" && cloneSrc) {
        const sx = stroke && cloneOff ? hover.x + cloneOff[0] : cloneSrc.x, sy = stroke && cloneOff ? hover.y + cloneOff[1] : cloneSrc.y;
        g.beginPath(); g.moveTo(sx - 8 * px, sy); g.lineTo(sx + 8 * px, sy); g.moveTo(sx, sy - 8 * px); g.lineTo(sx, sy + 8 * px);
        g.strokeStyle = "#000"; g.lineWidth = px * 2; g.stroke(); g.strokeStyle = "#fff"; g.lineWidth = px; g.stroke();
      }
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
  // formiche in marcia
  const antTimer = setInterval(() => { if (!view.isConnected) return clearInterval(antTimer); if ((sel || lassoPts.length) && !ctx.tab.view.hidden && showExtras) { antPhase = (antPhase + 1) % 8; schedule(); } }, 140);

  // ------------------------------------------------------------ selezione
  function outline(mask) {
    const id = readData(mask), d = id.data, w = mask.width, h = mask.height, ins = new Uint8Array(w * h);
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) if (d[i * 4 + 3] >= 128) { ins[i] = 1; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return null;
    const P = new Path2D(), at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? ins[y * w + x] : 0);
    for (let y = y0; y <= y1 + 1; y++) {
      let run = -1;
      for (let x = x0; x <= x1 + 1; x++) {
        const e = x <= x1 && at(x, y - 1) !== at(x, y);
        if (e && run < 0) run = x; else if (!e && run >= 0) { P.moveTo(run, y); P.lineTo(x, y); run = -1; }
      }
    }
    for (let x = x0; x <= x1 + 1; x++) {
      let run = -1;
      for (let y = y0; y <= y1 + 1; y++) {
        const e = y <= y1 && at(x - 1, y) !== at(x, y);
        if (e && run < 0) run = y; else if (!e && run >= 0) { P.moveTo(x, run); P.lineTo(x, y); run = -1; }
      }
    }
    return { path: P, bounds: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
  }
  function makeSel(c, vec) {
    const o = outline(c);
    if (!o) return null;
    return { c, path: vec || o.path, bounds: o.bounds };
  }
  // nuova selezione combinata con quella esistente (nuova, aggiungi, sottrai, interseca) e sfumata
  function applySelection(shape, mode, name, vecPath = null) {
    let res;
    if (mode === "new" || !sel) {
      if (mode === "sub" || mode === "int") res = mode === "int" ? mkCanvas(W, H) : mkCanvas(W, H);
      if (mode === "sub" && !sel) res = mkCanvas(W, H);
      if (mode === "new" || mode === "add" || !res) res = shape;
      if (mode === "int" && !sel) res = mkCanvas(W, H);
    } else {
      res = cloneC(sel.c);
      const g = g2(res);
      g.globalCompositeOperation = mode === "add" ? "source-over" : mode === "sub" ? "destination-out" : "destination-in";
      g.drawImage(shape, 0, 0);
    }
    const f = opt.sel.feather;
    if (f > 0) res = blurCanvas(res, f / 2);
    const simple = (mode === "new" || !sel) && !f && vecPath;
    sel = makeSel(res, simple ? vecPath : null);
    if (sel) lastSel = sel;
    invalidate(); commit(name);
  }
  const selMode = e => (e.shiftKey && e.altKey ? "int" : e.shiftKey ? "add" : e.altKey ? "sub" : opt.sel.mode);
  function shapeMask(fn) { const c = mkCanvas(W, H), g = g2(c); g.fillStyle = "#fff"; fn(g); return c; }
  function selectAll() { const p = new Path2D(); p.rect(0, 0, W, H); sel = makeSel(shapeMask(g => g.fillRect(0, 0, W, H)), p); lastSel = sel; invalidate(); commit(tr("imgedit.seleziona_tutto")); }
  function deselect() { if (!sel) return; sel = null; invalidate(); commit(tr("imgedit.deseleziona")); }
  function reselect() { if (lastSel) { sel = lastSel; invalidate(); commit(tr("imgedit.riseleziona")); } }
  function invertSel() {
    const c = shapeMask(g => g.fillRect(0, 0, W, H));
    if (sel) { const g = g2(c); g.globalCompositeOperation = "destination-out"; g.drawImage(sel.c, 0, 0); }
    sel = makeSel(c); invalidate(); commit(tr("imgedit.inversa"));
  }
  function modifySel(kind, r) {
    if (!sel || !(r > 0)) return;
    let c;
    if (kind === "feather") c = blurCanvas(sel.c, r / 2);
    else {
      // espandi/contrai: unione della selezione spostata lungo un cerchio (contrai = espandi l'inverso)
      const inv = kind === "contract";
      const base = inv ? shapeMask(g => { g.fillRect(-2, -2, W + 4, H + 4); g.globalCompositeOperation = "destination-out"; g.drawImage(sel.c, 0, 0); }) : sel.c;
      c = mkCanvas(W, H); const g = g2(c);
      const n = Math.max(8, Math.min(72, Math.round(r * 4)));
      g.drawImage(base, 0, 0);
      for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; for (const k of [1, 0.5]) g.drawImage(base, Math.cos(a) * r * k, Math.sin(a) * r * k); }
      if (inv) c = shapeMask(gg => { gg.fillRect(0, 0, W, H); gg.globalCompositeOperation = "destination-out"; gg.drawImage(c, 0, 0); });
    }
    sel = makeSel(c); if (sel) lastSel = sel;
    invalidate(); commit({ feather: tr("imgedit.sfuma"), expand: tr("imgedit.espandi"), contract: tr("imgedit.contrai") }[kind]);
  }
  function selFromLayer(L) {
    if (!L?.c) return;
    const c = mkCanvas(W, H); g2(c).drawImage(L.c, L.x, L.y);
    sel = makeSel(c); if (sel) lastSel = sel;
    invalidate(); commit(tr("imgedit.carica_selezione"));
  }
  // risultato di un filtro/regolazione limitato alla selezione (anche sfumata)
  function mergeSel(orig, res, lx, ly) {
    if (!sel) return res;
    const out = cloneC(orig), g = g2(out), r = cloneC(res), rg = g2(r);
    g.globalCompositeOperation = "destination-out"; g.drawImage(sel.c, -lx, -ly);
    rg.globalCompositeOperation = "destination-in"; rg.drawImage(sel.c, -lx, -ly);
    g.globalCompositeOperation = "lighter"; g.drawImage(r, 0, 0);
    return out;
  }

  // ------------------------------------------------------------ livelli: operazioni
  const cur = () => layers[act];
  function expanded(c, x, y) {
    const x0 = Math.min(x, 0), y0 = Math.min(y, 0), x1 = Math.max(x + c.width, W), y1 = Math.max(y + c.height, H);
    const n = mkCanvas(x1 - x0, y1 - y0); g2(n).drawImage(c, x - x0, y - y0);
    return { c: n, x: x0, y: y0 };
  }
  function renderText(L) {
    const p = L.props, font = `${p.italic ? "italic " : ""}${p.bold ? "bold " : ""}${p.size}px "${p.font}"`;
    const lines = (p.text || "").split("\n"), m = g2(mkCanvas(1, 1)); m.font = font;
    const lh = p.size * (p.lead || 1.2), pad = Math.ceil(p.size * 0.3) + 2;
    const tw = Math.max(1, ...lines.map(t => m.measureText(t).width));
    const c = mkCanvas(tw + pad * 2, lines.length * lh + pad * 2), g = g2(c);
    g.font = font; g.fillStyle = p.color; g.textBaseline = "top";
    g.textAlign = p.align; const ax = p.align === "center" ? tw / 2 : p.align === "right" ? tw : 0;
    lines.forEach((t, i) => g.fillText(t, pad + ax, pad + i * lh + (lh - p.size) / 2));
    L.c = c; L.x = Math.round(p.x - pad); L.y = Math.round(p.y - pad);
  }
  function renderShape(L) {
    const p = L.props, sw = p.stroke ? p.sw : 0, pad = Math.ceil(sw / 2) + 2;
    if (p.type === "line") {
      const x0 = Math.min(p.x1, p.x2) - p.sw - 2, y0 = Math.min(p.y1, p.y2) - p.sw - 2;
      const c = mkCanvas(Math.abs(p.x2 - p.x1) + p.sw * 2 + 4, Math.abs(p.y2 - p.y1) + p.sw * 2 + 4), g = g2(c);
      g.strokeStyle = p.color2 || p.fill || "#000"; g.lineWidth = p.sw; g.lineCap = "round";
      g.beginPath(); g.moveTo(p.x1 - x0, p.y1 - y0); g.lineTo(p.x2 - x0, p.y2 - y0); g.stroke();
      L.c = c; L.x = Math.floor(x0); L.y = Math.floor(y0); return;
    }
    const c = mkCanvas(Math.abs(p.w) + pad * 2, Math.abs(p.h) + pad * 2), g = g2(c), w = Math.abs(p.w), h = Math.abs(p.h);
    const path = new Path2D();
    if (p.type === "ellipse") path.ellipse(pad + w / 2, pad + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    else if (p.type === "round") path.roundRect(pad, pad, w, h, Math.min(p.r, w / 2, h / 2));
    else path.rect(pad, pad, w, h);
    if (p.fill) { g.fillStyle = p.fill; g.fill(path); }
    if (p.stroke) { g.strokeStyle = p.stroke; g.lineWidth = p.sw; g.stroke(path); }
    L.c = c; L.x = Math.round(Math.min(p.x, p.x + p.w) - pad); L.y = Math.round(Math.min(p.y, p.y + p.h) - pad);
  }
  const rerender = L => (L.kind === "text" ? renderText(L) : L.kind === "shape" ? renderShape(L) : null);
  function rasterize(L, quiet) { if (L.kind !== "text" && L.kind !== "shape") return; L.kind = "pixel"; L.props = null; if (!quiet) { invalidate(); commit(tr("imgedit.rasterizza_livello")); } }
  function selectLayer(i, tgt) {
    if (i < 0 || i >= layers.length) return;
    endText(true);
    act = i;
    target = tgt || (layers[i].kind === "adjust" && layers[i].mask ? "mask" : "pixels");
    if (target === "mask" && !layers[i].mask) target = "pixels";
    maskView = false;
    renderLayers(); renderProps(); status(); schedule();
  }
  function nameNew(base) { let n = 1; while (layers.some(l => l.name === `${base} ${n}`)) n++; return `${base} ${n}`; }
  function addLayer(o = {}, at = act + 1, name = tr("imgedit.nuovo_livello")) {
    const L = mkLayer({ name: nameNew(tr("imgedit.livello")), c: mkCanvas(W, H), ...o });
    layers.splice(at, 0, L); act = at; target = L.kind === "adjust" ? "mask" : "pixels";
    invalidate(); commit(name);
    return L;
  }
  function duplicateLayer() {
    const L = cur(); if (!L) return;
    const n = copyLayer(L); n.id = uid++; n.name = L.name + " copia";
    layers.splice(act + 1, 0, n); act++; invalidate(); commit(tr("imgedit.duplica_livello"));
  }
  function deleteLayer() {
    if (layers.length < 2) return toast(tr("imgedit.immagine_deve_avere_almeno_livello"), true);
    layers.splice(act, 1); act = Math.min(act, layers.length - 1); target = "pixels"; invalidate(); commit(tr("imgedit.elimina_livello"));
  }
  function moveLayer(to) {
    to = clamp(to, 0, layers.length - 1);
    if (to === act) return;
    const [L] = layers.splice(act, 1); layers.splice(to, 0, L); act = to; invalidate(); commit(tr("imgedit.disponi"));
  }
  // livello tramite copia/taglio (Ctrl+J / Ctrl+Maiusc+J)
  function layerVia(cut) {
    const L = cur(); if (!L || !L.c) return;
    if (!sel) { if (!cut) duplicateLayer(); return; }
    const piece = cloneC(L.c), g = g2(piece);
    g.globalCompositeOperation = "destination-in"; g.drawImage(sel.c, -L.x, -L.y);
    if (cut) { const h = cloneC(L.c), hg = g2(h); hg.globalCompositeOperation = "destination-out"; hg.drawImage(sel.c, -L.x, -L.y); L.c = h; rasterize(L, true); }
    const n = mkLayer({ name: nameNew(tr("imgedit.livello")), c: piece, x: L.x, y: L.y });
    layers.splice(act + 1, 0, n); act++; target = "pixels";
    invalidate(); commit(cut ? tr("imgedit.livello_tramite_taglio") : tr("imgedit.livello_tramite_copia"));
  }
  // unisci sotto: il livello di sopra (con maschera, opacita' e fusione) finisce nei pixel di quello sotto
  function mergeDown() {
    if (act < 1) return;
    const up = layers[act], lo = layers[act - 1];
    if (lo.kind === "adjust") return toast(tr("imgedit.non_si_puo_unire_livello"), true);
    const rects = [[lo.x, lo.y, lo.c.width, lo.c.height], [0, 0, W, H]];
    if (up.c) rects.push([up.x, up.y, up.c.width, up.c.height]);
    const x0 = Math.min(...rects.map(r => r[0])), y0 = Math.min(...rects.map(r => r[1])), x1 = Math.max(...rects.map(r => r[0] + r[2])), y1 = Math.max(...rects.map(r => r[1] + r[3]));
    const c = mkCanvas(x1 - x0, y1 - y0), g = g2(c);
    renderLayer(g, { ...lo, visible: true, opacity: 100, blend: "source-over" }, x0, y0);
    renderLayer(g, { ...up, visible: up.visible }, x0, y0);
    Object.assign(lo, { c, x: x0, y: y0, mask: null, kind: "pixel", props: null });
    layers.splice(act, 1); act--; target = "pixels";
    invalidate(); commit(tr("imgedit.unisci_sotto"));
  }
  function mergeVisible(flat) {
    const vis = layers.filter(l => l.visible);
    if (!vis.length) return;
    const c = flatten(flat ? bg : null);
    const L = mkLayer({ name: flat ? tr("imgedit.sfondo") : vis[vis.length - 1].name, c });
    if (flat) layers = [L]; else { const idx = layers.indexOf(vis[0]); layers = layers.filter(l => !l.visible); layers.splice(idx, 0, L); }
    act = layers.indexOf(L); target = "pixels";
    invalidate(); commit(flat ? tr("imgedit.unico_livello") : tr("imgedit.unisci_visibili"));
  }
  function addMask(kind) {
    const L = cur(); if (!L) return;
    if (L.mask) return toast(tr("imgedit.livello_ha_gia_maschera"), true);
    const r = L.c ? expanded(L.c, L.x, L.y) : { x: 0, y: 0, c: mkCanvas(W, H) };
    const c = mkCanvas(r.c.width, r.c.height), g = g2(c);
    g.fillStyle = "#fff";
    if (kind === "reveal" || kind === "hideSel") g.fillRect(0, 0, c.width, c.height);
    if (kind === "revealSel" && sel) g.drawImage(sel.c, -r.x, -r.y);
    if (kind === "hideSel" && sel) { g.globalCompositeOperation = "destination-out"; g.drawImage(sel.c, -r.x, -r.y); }
    L.mask = { c, x: r.x, y: r.y, on: true };
    target = "mask";
    if (kind === "revealSel" || kind === "hideSel") sel = null;
    invalidate(); commit(tr("imgedit.aggiungi_maschera"));
  }
  function maskOp(op) {
    const L = cur(); if (!L?.mask) return;
    if (op === "delete") { L.mask = null; target = "pixels"; }
    else if (op === "toggle") L.mask.on = !L.mask.on;
    else if (op === "invert") { const c = mkCanvas(L.mask.c.width, L.mask.c.height), g = g2(c); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.globalCompositeOperation = "destination-out"; g.drawImage(L.mask.c, 0, 0); L.mask = { ...L.mask, c }; }
    else if (op === "apply" && L.c) {
      const c = cloneC(L.c), g = g2(c); g.globalCompositeOperation = "destination-in"; g.drawImage(L.mask.c, L.mask.x - L.x, L.mask.y - L.y);
      rasterize(L, true); L.c = c; L.mask = null; target = "pixels";
    }
    invalidate(); commit({ delete: tr("imgedit.elimina_maschera"), toggle: tr("imgedit.disattiva_attiva_maschera"), invert: tr("imgedit.inverti_maschera"), apply: tr("imgedit.applica_maschera") }[op]);
  }
  function addAdjustLayer(type) {
    endText(true);
    const c = mkCanvas(W, H), g = g2(c); g.fillStyle = "#fff";
    if (sel) g.drawImage(sel.c, 0, 0); else g.fillRect(0, 0, W, H);
    const L = mkLayer({ name: nameNew(ADJ[type].name), kind: "adjust", c: null, mask: { c, x: 0, y: 0, on: true }, props: { type, p: ADJ[type].def() } });
    layers.splice(act + 1, 0, L); act++; target = "mask"; sel = null;
    invalidate(); commit(tr("imgedit.nuovo_livello_regolazione"));
    dock1Show("props");
  }
  async function placeImage(path) {
    try {
      const ext = extOf(path);
      let src = fileUrl(path);
      if (!/^(png|apng|jpe?g|jpe|jfif|gif|webp|bmp|ico|avif)$/.test(ext)) src = fileUrl((await api("image", { path })).path);
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(tr("imgedit.immagine_non_leggibile"))); i.src = src; });
      const c = mkCanvas(img.naturalWidth, img.naturalHeight); g2(c).drawImage(img, 0, 0);
      const L = mkLayer({ name: path.split(/[\\/]/).pop().replace(/\.[^.]+$/, ""), c, x: Math.round((W - c.width) / 2), y: Math.round((H - c.height) / 2) });
      layers.splice(act + 1, 0, L); act++; target = "pixels";
      invalidate(); commit(tr("imgedit.inserisci"));
    } catch (e) { toast(e.message, true); }
  }

  // ------------------------------------------------------------ trasformazioni di documento e livelli
  // ridisegna un canvas con una matrice (a,b,c,d,e,f) e restituisce il risultato con la sua posizione
  function xform(c, x, y, m, smooth = true) {
    const pts = [[x, y], [x + c.width, y], [x, y + c.height], [x + c.width, y + c.height]].map(([u, v]) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]]);
    const x0 = Math.floor(Math.min(...pts.map(p => p[0])) + 1e-6), y0 = Math.floor(Math.min(...pts.map(p => p[1])) + 1e-6);
    const x1 = Math.ceil(Math.max(...pts.map(p => p[0])) - 1e-6), y1 = Math.ceil(Math.max(...pts.map(p => p[1])) - 1e-6);
    const n = mkCanvas(x1 - x0, y1 - y0), g = g2(n);
    g.imageSmoothingEnabled = smooth; g.imageSmoothingQuality = "high";
    g.setTransform(m[0], m[1], m[2], m[3], m[4] - x0, m[5] - y0);
    g.drawImage(c, x, y);
    return { c: n, x: x0, y: y0 };
  }
  function xformLayer(L, m, smooth) {
    if (L.kind === "text" || L.kind === "shape") rasterize(L, true);
    if (L.c) Object.assign(L, xform(L.c, L.x, L.y, m, smooth));
    if (L.mask) L.mask = { ...L.mask, ...xform(L.mask.c, L.mask.x, L.mask.y, m, smooth) };
  }
  // rotazione/riflessione dell'intera immagine (menu Immagine > Rotazione immagine)
  function rotateDoc(kind, deg) {
    endText(true);
    let m, nw = W, nh = H, smooth = false;
    if (kind === "cw") { m = [0, 1, -1, 0, H, 0]; nw = H; nh = W; }
    else if (kind === "ccw") { m = [0, -1, 1, 0, 0, W]; nw = H; nh = W; }
    else if (kind === "180") m = [-1, 0, 0, -1, W, H];
    else if (kind === "fh") m = [-1, 0, 0, 1, W, 0];
    else if (kind === "fv") m = [1, 0, 0, -1, 0, H];
    else {
      const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      nw = Math.ceil(Math.abs(W * c) + Math.abs(H * s)); nh = Math.ceil(Math.abs(W * s) + Math.abs(H * c));
      m = [c, s, -s, c, nw / 2 - (c * W / 2 - s * H / 2), nh / 2 - (s * W / 2 + c * H / 2)]; smooth = true;
    }
    layers.forEach(L => xformLayer(L, m, smooth));
    W = nw; H = nh; comp = mkCanvas(W, H); sel = null; lastSel = null;
    fit(); invalidate();
    commit({ cw: tr("imgedit.ruota_90_orario"), ccw: tr("imgedit.ruota_90_antiorario"), "180": tr("imgedit.ruota_180"), fh: tr("imgedit.rifletti_quadro_orizzontale"), fv: tr("imgedit.rifletti_quadro_verticale") }[kind] || tr("imgedit.ruota_immagine"));
  }
  function layerXform(kind) {
    const L = cur(); if (!L?.c) return;
    const b = { x: L.x, y: L.y, w: L.c.width, h: L.c.height }, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const M = { cw: [0, 1, -1, 0, cx + cy, cy - cx], ccw: [0, -1, 1, 0, cx - cy, cy + cx], "180": [-1, 0, 0, -1, 2 * cx, 2 * cy], fh: [-1, 0, 0, 1, 2 * cx, 0], fv: [1, 0, 0, -1, 0, 2 * cy] }[kind];
    xformLayer(L, M, false);
    invalidate(); commit({ cw: tr("imgedit.ruota_90_orario"), ccw: tr("imgedit.ruota_90_antiorario"), "180": tr("imgedit.ruota_180"), fh: tr("imgedit.rifletti_orizzontale"), fv: tr("imgedit.rifletti_verticale") }[kind]);
  }
  function scaleCanvas(c, w, h, smooth = true) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    let src = c;
    // riduzioni forti a meta' per volta (niente scalettature)
    while (smooth && (src.width / 2 >= w * 1.0001 && src.height / 2 >= h * 1.0001)) { const t = mkCanvas(src.width / 2, src.height / 2), tg = g2(t); tg.imageSmoothingQuality = "high"; tg.drawImage(src, 0, 0, t.width, t.height); src = t; }
    const n = mkCanvas(w, h), g = g2(n);
    g.imageSmoothingEnabled = smooth; g.imageSmoothingQuality = "high"; g.drawImage(src, 0, 0, w, h);
    return n;
  }
  function resizeDoc(nw, nh, smooth) {
    endText(true);
    const kx = nw / W, ky = nh / H;
    for (const L of layers) {
      if (L.kind === "text") { const p = L.props; p.size *= Math.min(kx, ky); p.x *= kx; p.y *= ky; renderText(L); }
      else if (L.kind === "shape") { const p = L.props; if (p.type === "line") { p.x1 *= kx; p.x2 *= kx; p.y1 *= ky; p.y2 *= ky; } else { p.x *= kx; p.y *= ky; p.w *= kx; p.h *= ky; } p.sw *= Math.min(kx, ky); renderShape(L); }
      else if (L.c) { L.c = scaleCanvas(L.c, L.c.width * kx, L.c.height * ky, smooth); L.x = Math.round(L.x * kx); L.y = Math.round(L.y * ky); }
      if (L.mask) L.mask = { ...L.mask, c: scaleCanvas(L.mask.c, L.mask.c.width * kx, L.mask.c.height * ky, smooth), x: Math.round(L.mask.x * kx), y: Math.round(L.mask.y * ky) };
    }
    W = nw; H = nh; comp = mkCanvas(W, H); sel = null; lastSel = null;
    fit(); invalidate(); commit(tr("imgedit.dimensione_immagine"));
  }
  function canvasSize(nw, nh, ax, ay, fillColor) {
    endText(true);
    const dx = Math.round((nw - W) * ax), dy = Math.round((nh - H) * ay);
    for (const L of layers) {
      L.x += dx; L.y += dy;
      if (L.props && L.kind === "text") { L.props.x += dx; L.props.y += dy; }
      if (L.props && L.kind === "shape") { const p = L.props; if (p.type === "line") { p.x1 += dx; p.x2 += dx; p.y1 += dy; p.y2 += dy; } else { p.x += dx; p.y += dy; } }
      if (L.mask) L.mask = { ...L.mask, x: L.mask.x + dx, y: L.mask.y + dy };
    }
    const bot = layers[0];
    // come lo Sfondo di Photoshop: il livello in fondo si estende con il colore scelto
    if (fillColor && bot.kind === "pixel" && bot.c) {
      const x0 = Math.min(0, bot.x), y0 = Math.min(0, bot.y), x1 = Math.max(nw, bot.x + bot.c.width), y1 = Math.max(nh, bot.y + bot.c.height);
      const c = mkCanvas(x1 - x0, y1 - y0), g = g2(c);
      g.fillStyle = fillColor; g.fillRect(-x0, -y0, nw, nh); g.drawImage(bot.c, bot.x - x0, bot.y - y0);
      Object.assign(bot, { c, x: x0, y: y0 });
    }
    W = nw; H = nh; comp = mkCanvas(W, H); sel = null; lastSel = null;
    fit(); invalidate(); commit(tr("imgedit.dimensione_quadro"));
  }
  function cropDoc(r, del = true, name = tr("imgedit.ritaglia")) {
    endText(true);
    r = { x: Math.round(r.x), y: Math.round(r.y), w: Math.max(1, Math.round(r.w)), h: Math.max(1, Math.round(r.h)) };
    for (const L of layers) {
      L.x -= r.x; L.y -= r.y;
      if (L.kind === "text") { L.props.x -= r.x; L.props.y -= r.y; }
      if (L.kind === "shape") { const p = L.props; if (p.type === "line") { p.x1 -= r.x; p.x2 -= r.x; p.y1 -= r.y; p.y2 -= r.y; } else { p.x -= r.x; p.y -= r.y; } }
      if (L.mask) L.mask = { ...L.mask, x: L.mask.x - r.x, y: L.mask.y - r.y };
      if (del && L.kind === "pixel" && L.c) {
        const x0 = Math.max(0, L.x), y0 = Math.max(0, L.y), x1 = Math.min(r.w, L.x + L.c.width), y1 = Math.min(r.h, L.y + L.c.height);
        if (x1 > x0 && y1 > y0 && (x0 !== L.x || y0 !== L.y || x1 - x0 !== L.c.width || y1 - y0 !== L.c.height)) {
          const c = mkCanvas(x1 - x0, y1 - y0); g2(c).drawImage(L.c, L.x - x0, L.y - y0); Object.assign(L, { c, x: x0, y: y0 });
        }
      }
    }
    W = r.w; H = r.h; comp = mkCanvas(W, H); sel = null; lastSel = null;
    fit(); invalidate(); commit(name);
  }
  function trimTransparent() {
    const d = readData(flatten()).data;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return toast(tr("imgedit.l_immagine_completamente_trasparente"), true);
    cropDoc({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, true, tr("imgedit.rifila"));
  }

  // ------------------------------------------------------------ pittura (pennello, matita, gomma, timbro)
  let stroke = null, lastPaint = null, cloneSrc = null, cloneOff = null;
  const tipCache = new Map();
  function tip(size, hard, color, aliased) {
    const key = [size, hard, color, aliased].join("|");
    if (tipCache.has(key)) return tipCache.get(key);
    if (tipCache.size > 40) tipCache.clear();
    const d = Math.max(1, Math.ceil(size)), c = mkCanvas(d + 2, d + 2), g = g2(c), r = size / 2, cx = (d + 2) / 2;
    if (aliased) {
      const [R, G, B] = hexToRgb(color), id = g.createImageData(c.width, c.height);
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cx) ** 2 <= Math.max(0.25, r * r)) { const i = (y * c.width + x) * 4; id.data[i] = R; id.data[i + 1] = G; id.data[i + 2] = B; id.data[i + 3] = 255; }
      g.putImageData(id, 0, 0);
    } else {
      const gr = g.createRadialGradient(cx, cx, 0, cx, cx, Math.max(0.5, r)), [R, G, B] = hexToRgb(color), h = clamp(hard, 0, 0.99);
      gr.addColorStop(0, `rgba(${R},${G},${B},1)`); gr.addColorStop(h, `rgba(${R},${G},${B},1)`);
      gr.addColorStop(h + (1 - h) * 0.5, `rgba(${R},${G},${B},.45)`); gr.addColorStop(1, `rgba(${R},${G},${B},0)`);
      g.fillStyle = gr; g.beginPath(); g.arc(cx, cx, Math.max(0.5, r), 0, Math.PI * 2); g.fill();
    }
    tipCache.set(key, c);
    return c;
  }
  // destinazione della pittura: pixel del livello o la sua maschera
  function paintTarget(kind) {
    const L = cur();
    if (!L) return null;
    if (!L.visible) { toast(tr("imgedit.livello_attivo_nascosto_rendilo_visibile"), true); return null; }
    if (target === "mask" && L.mask) return { L, mask: true };
    if (L.kind === "adjust") { toast(tr("imgedit.livello_regolazione_si_dipinge_solo"), true); return null; }
    if (L.kind === "text" || L.kind === "shape") { rasterize(L, true); toast(tr("imgedit.livello_rasterizzato_poterlo_modificare"), false, 2000); }
    void kind;
    return { L, mask: false };
  }
  function beginStroke(p, e, kind) {
    const T = paintTarget(kind);
    if (!T) return null;
    if (kind === "stamp" && T.mask) { toast(tr("imgedit.timbro_clone_lavora_sui_pixel"), true); return null; }
    if (kind === "stamp" && !cloneSrc) { toast(tr("imgedit.timbro_clone_prima_alt_clic"), true); return null; }
    const o = opt[kind], src = T.mask ? T.L.mask : T.L;
    const base = expanded(src.c, src.x, src.y);
    const white = T.mask || kind === "eraser" || kind === "stamp";
    const S = { T, kind, o, base, buf: mkCanvas(base.c.width, base.c.height), pv: mkCanvas(base.c.width, base.c.height), last: null, since: 0,
      tip: tip(o.size, o.hard, white ? "#ffffff" : fg, kind === "pencil"), gray: lum(...hexToRgb(kind === "eraser" ? bg : fg)) / 255 };
    if (kind === "stamp") {
      S.src = o.all ? { img: flatten(), x: 0, y: 0 } : { img: T.L.c, x: T.L.x, y: T.L.y };
      if (!o.aligned || !cloneOff) cloneOff = [cloneSrc.x - p.x, cloneSrc.y - p.y];
      S.dab = mkCanvas(S.tip.width, S.tip.height);
    }
    if (e.shiftKey && lastPaint) { strokeTo(S, lastPaint); }
    strokeTo(S, p);
    S.dirty = true; schedule();
    return S;
  }
  function dab(S, x, y, k = 1) {
    const t = S.tip, r = t.width / 2 * k, ix = x - r, iy = y - r, g = g2(S.buf);
    g.globalAlpha = S.o.flow / 100;
    if (S.kind === "stamp") {
      const d = g2(S.dab);
      d.globalCompositeOperation = "copy"; d.drawImage(t, 0, 0);
      d.globalCompositeOperation = "source-in";
      d.drawImage(S.src.img, S.src.x - (ix + S.base.x + cloneOff[0]), S.src.y - (iy + S.base.y + cloneOff[1]));
      g.drawImage(S.dab, ix, iy);
    } else if (k !== 1) g.drawImage(t, ix, iy, t.width * k, t.height * k);
    else g.drawImage(t, ix, iy);
    g.globalAlpha = 1;
    if (sel) {
      g.save(); g.beginPath(); g.rect(Math.floor(ix), Math.floor(iy), t.width + 1, t.height + 1); g.clip();
      g.globalCompositeOperation = "destination-in"; g.drawImage(sel.c, -S.base.x, -S.base.y); g.restore();
    }
  }
  const prK = pr => (pr === undefined ? 1 : Math.min(1, 0.15 + pr * 1.1));
  function strokeTo(S, p) {
    const x = p.x - S.base.x, y = p.y - S.base.y, k = S.kind === "stamp" ? 1 : prK(p.pr);
    if (!S.last) { dab(S, x, y, k); S.last = [x, y]; S.k = k; return; }
    const [lx, ly] = S.last, k0 = S.k ?? k, dx = x - lx, dy = y - ly, dist = Math.hypot(dx, dy), sp = Math.max(1, S.o.size * Math.min(k0, k) * (S.kind === "pencil" ? 0.08 : 0.12));
    let d = sp - S.since;
    if (d > dist) { S.since += dist; S.last = [x, y]; return; }
    for (; d <= dist; d += sp) dab(S, lx + dx * d / dist, ly + dy * d / dist, k0 + (k - k0) * d / dist);
    S.since = dist - (d - sp); S.last = [x, y]; S.k = k;
  }
  function strokePreview(S) {
    const g = g2(S.pv), a = S.o.opacity / 100;
    g.globalCompositeOperation = "copy"; g.globalAlpha = 1; g.drawImage(S.base.c, 0, 0);
    if (S.T.mask) {
      g.globalCompositeOperation = "destination-out"; g.globalAlpha = a; g.drawImage(S.buf, 0, 0);
      if (S.gray > 0) { g.globalCompositeOperation = "lighter"; g.globalAlpha = a * S.gray; g.drawImage(S.buf, 0, 0); }
    } else {
      g.globalCompositeOperation = S.kind === "eraser" ? "destination-out" : "source-over"; g.globalAlpha = a; g.drawImage(S.buf, 0, 0);
    }
    g.globalCompositeOperation = "source-over"; g.globalAlpha = 1;
    preview = S.T.mask ? { i: act, mask: { ...S.T.L.mask, c: S.pv, x: S.base.x, y: S.base.y } } : { i: act, c: S.pv, x: S.base.x, y: S.base.y };
    needComp = true;
  }
  function endStroke(S, p) {
    strokePreview(S);
    if (S.T.mask) S.T.L.mask = { ...S.T.L.mask, c: S.pv, x: S.base.x, y: S.base.y };
    else Object.assign(S.T.L, { c: S.pv, x: S.base.x, y: S.base.y });
    preview = null; stroke = null; lastPaint = p;
    invalidate(); commit({ brush: tr("imgedit.pennello"), pencil: tr("imgedit.matita"), eraser: tr("imgedit.gomma"), stamp: tr("imgedit.timbro_clone") }[S.kind]);
  }
  // applica un canvas grande quanto il documento (riempimento, sfumatura, secchiello, traccia) al livello attivo
  function applyDocBuffer(buf, opacity, name) {
    const T = paintTarget();
    if (!T) return;
    if (sel) { const g = g2(buf); g.globalCompositeOperation = "destination-in"; g.drawImage(sel.c, 0, 0); }
    const L = T.L;
    if (T.mask) {
      const base = expanded(L.mask.c, L.mask.x, L.mask.y), md = readData(base.c);
      const t = mkCanvas(base.c.width, base.c.height); g2(t).drawImage(buf, -base.x, -base.y);
      const bd = readData(t).data, m = md.data, a0 = opacity / 100;
      for (let i = 0; i < m.length; i += 4) { const a = bd[i + 3] / 255 * a0; if (!a) continue; m[i + 3] = m[i + 3] * (1 - a) + lum(bd[i], bd[i + 1], bd[i + 2]) * a; m[i] = m[i + 1] = m[i + 2] = 255; }
      g2(base.c).putImageData(md, 0, 0);
      L.mask = { ...L.mask, c: base.c, x: base.x, y: base.y };
    } else {
      const base = expanded(L.c, L.x, L.y), g = g2(base.c);
      g.globalAlpha = opacity / 100; g.drawImage(buf, -base.x, -base.y);
      Object.assign(L, base);
    }
    invalidate(); commit(name);
  }
  function fillWith(color, opacity = 100, name = tr("imgedit.riempi")) { const c = mkCanvas(W, H), g = g2(c); g.fillStyle = color; g.fillRect(0, 0, W, H); applyDocBuffer(c, opacity, name); }
  function clearSel() {
    const L = cur(); if (!L) return;
    if (!sel) return toast(tr("imgedit.nessuna_selezione_canc_si_cancella"), true);
    const T = paintTarget(); if (!T) return;
    if (T.mask) return fillWith("#000", 100, tr("imgedit.cancella"));
    const c = cloneC(L.c), g = g2(c); g.globalCompositeOperation = "destination-out"; g.drawImage(sel.c, -L.x, -L.y);
    L.c = c; invalidate(); commit(tr("imgedit.cancella"));
  }
  // riempimento a macchia (secchiello e bacchetta magica): tolleranza sul canale con la differenza maggiore
  function flood(d, w, h, x0, y0, tol, contig) {
    const out = new Uint8Array(w * h), i0 = (y0 * w + x0) * 4, r = d[i0], g = d[i0 + 1], b = d[i0 + 2], a = d[i0 + 3];
    const ok = i => { const j = i * 4; return Math.abs(d[j] - r) <= tol && Math.abs(d[j + 1] - g) <= tol && Math.abs(d[j + 2] - b) <= tol && Math.abs(d[j + 3] - a) <= tol; };
    if (!contig) { for (let i = 0; i < w * h; i++) if (ok(i)) out[i] = 1; return out; }
    const st = [x0, y0];
    while (st.length) {
      const y = st.pop(); let x = st.pop();
      while (x >= 0 && !out[y * w + x] && ok(y * w + x)) x--;
      x++;
      let up = false, dn = false;
      while (x < w && !out[y * w + x] && ok(y * w + x)) {
        out[y * w + x] = 1;
        if (y > 0) { const k = ok((y - 1) * w + x) && !out[(y - 1) * w + x]; if (k && !up) { st.push(x, y - 1); up = true; } else if (!k) up = false; }
        if (y < h - 1) { const k = ok((y + 1) * w + x) && !out[(y + 1) * w + x]; if (k && !dn) { st.push(x, y + 1); dn = true; } else if (!k) dn = false; }
        x++;
      }
    }
    return out;
  }
  function sampleCanvas(all) {
    const L = cur();
    if (all || !L?.c) return flatten();
    const c = mkCanvas(W, H); renderLayer(g2(c), { ...L, visible: true, opacity: 100, blend: "source-over", mask: null });
    return c;
  }
  function floodCanvas(p, tol, contig, all, color) {
    const x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= W || y >= H) return null;
    const m = flood(readData(sampleCanvas(all)).data, W, H, x, y, tol, contig);
    const c = mkCanvas(W, H), g = g2(c), id = g.createImageData(W, H), [R, G, B] = hexToRgb(color);
    for (let i = 0; i < m.length; i++) if (m[i]) { id.data[i * 4] = R; id.data[i * 4 + 1] = G; id.data[i * 4 + 2] = B; id.data[i * 4 + 3] = 255; }
    g.putImageData(id, 0, 0);
    return c;
  }
  function pickColor(p, toBg) {
    const x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const s = opt.eyedropper.size, h = (s - 1) / 2, src = sampleCanvas(opt.eyedropper.all), g = src.getContext("2d", { willReadFrequently: true });
    const x0 = clamp(x - h, 0, W - 1), y0 = clamp(y - h, 0, H - 1), d = g.getImageData(x0, y0, Math.min(s, W - x0), Math.min(s, H - y0)).data;
    let r = 0, gg = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { if (!d[i + 3]) continue; r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
    if (!n) return;
    setColor(toBg ? "bg" : "fg", rgbToHex(r / n, gg / n, b / n));
  }

  // ------------------------------------------------------------ trasformazione libera (Ctrl+T) e spostamento della selezione
  let tf = null;
  function beginTransform(silent) {
    endText(true);
    const L = cur();
    if (!L || L.kind === "adjust") { toast(tr("imgedit.seleziona_livello_pixel_trasformare"), true); return false; }
    if (!L.visible) { toast(tr("imgedit.livello_attivo_nascosto"), true); return false; }
    if (L.kind === "text" || L.kind === "shape") { rasterize(L, true); if (!silent) toast(tr("imgedit.livello_rasterizzato_trasformazione"), false, 2000); }
    let src, ox, oy, hole = null, selPiece = null;
    if (sel) {
      const b = sel.bounds;
      src = mkCanvas(b.w, b.h); const g = g2(src);
      g.drawImage(L.c, L.x - b.x, L.y - b.y); g.globalCompositeOperation = "destination-in"; g.drawImage(sel.c, -b.x, -b.y);
      hole = cloneC(L.c); const hg = g2(hole); hg.globalCompositeOperation = "destination-out"; hg.drawImage(sel.c, -L.x, -L.y);
      selPiece = mkCanvas(b.w, b.h); g2(selPiece).drawImage(sel.c, -b.x, -b.y);
      ox = b.x; oy = b.y;
    } else {
      // area con pixel non trasparenti
      const d = readData(L.c).data, w = L.c.width, h = L.c.height;
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x1 < 0) { toast(tr("imgedit.livello_vuoto"), true); return false; }
      src = mkCanvas(x1 - x0 + 1, y1 - y0 + 1); g2(src).drawImage(L.c, -x0, -y0);
      ox = L.x + x0; oy = L.y + y0;
    }
    tf = { L, src, w: src.width, h: src.height, cx: ox + src.width / 2, cy: oy + src.height / 2, sx: 1, sy: 1, rot: 0, hole, float: !!sel, selPiece, silent };
    updateTfPreview();
    renderOptions();
    return true;
  }
  const tfWorld = (t, u, v) => { const c = Math.cos(t.rot), s = Math.sin(t.rot), lx = u * t.w / 2 * t.sx, ly = v * t.h / 2 * t.sy; return [t.cx + lx * c - ly * s, t.cy + lx * s + ly * c]; };
  const tfMatrix = t => { const c = Math.cos(t.rot), s = Math.sin(t.rot); return [c * t.sx, s * t.sx, -s * t.sy, c * t.sy, t.cx - (c * t.sx * t.w / 2 - s * t.sy * t.h / 2), t.cy - (s * t.sx * t.w / 2 + c * t.sy * t.h / 2)]; };
  const HANDLES = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
  function updateTfPreview() {
    const t = tf, c = mkCanvas(W, H), g = g2(c);
    if (t.hole) g.drawImage(t.hole, t.L.x, t.L.y);
    const m = tfMatrix(t);
    g.imageSmoothingQuality = "high"; g.setTransform(...m); g.drawImage(t.src, 0, 0);
    setPreview({ i: act, c, x: 0, y: 0, mask: null });
  }
  function drawTransform(g, px) {
    const t = tf, pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => tfWorld(t, u, v));
    g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
    g.strokeStyle = "#2c8ef8"; g.lineWidth = px; g.stroke();
    for (const [u, v] of HANDLES) {
      const [x, y] = tfWorld(t, u, v), s = 4 * px, hot = hover?.tfHit?.u === u && hover?.tfHit?.v === v;
      g.fillStyle = hot ? "#2c8ef8" : "#fff"; g.strokeStyle = "#2c8ef8"; g.fillRect(x - s, y - s, s * 2, s * 2); g.strokeRect(x - s, y - s, s * 2, s * 2);
    }
    g.beginPath(); g.arc(t.cx, t.cy, 3.5 * px, 0, Math.PI * 2); g.strokeStyle = "#2c8ef8"; g.stroke();
  }
  function tfHit(p) {
    const t = tf;
    for (const [u, v] of HANDLES) { const [x, y] = tfWorld(t, u, v); if (Math.hypot((x - p.x) * zoom, (y - p.y) * zoom) < 8) return { type: "scale", u, v }; }
    const c = Math.cos(t.rot), s = Math.sin(t.rot), dx = p.x - t.cx, dy = p.y - t.cy;
    const lu = (dx * c + dy * s) / (t.w / 2 * t.sx), lv = (-dx * s + dy * c) / (t.h / 2 * t.sy);
    return Math.abs(lu) <= 1 && Math.abs(lv) <= 1 ? { type: "move" } : { type: "rotate" };
  }
  function tfDrag(p0, hit, e0) {
    const st = { ...tf };
    if (hit.type === "move") return (p, e) => {
      let dx = p.x - p0.x, dy = p.y - p0.y;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      tf.cx = st.cx + dx; tf.cy = st.cy + dy;
    };
    if (hit.type === "rotate") { const a0 = Math.atan2(p0.y - st.cy, p0.x - st.cx); return (p, e) => { let a = st.rot + Math.atan2(p.y - st.cy, p.x - st.cx) - a0; if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * Math.PI / 12; tf.rot = a; }; }
    const { u, v } = hit;
    return (p, e) => {
      const alt = e.altKey || e0.altKey, au = alt ? 0 : -u, av = alt ? 0 : -v;
      const [axw, ayw] = tfWorld(st, au, av), c = Math.cos(st.rot), s = Math.sin(st.rot), dx = p.x - axw, dy = p.y - ayw;
      const lx = dx * c + dy * s, ly = -dx * s + dy * c;
      let nsx = u ? lx / ((u - au) * st.w / 2) : st.sx, nsy = v ? ly / ((v - av) * st.h / 2) : st.sy;
      const corner = u && v, prop = corner ? !e.shiftKey : e.shiftKey; // come Photoshop 2019+: angoli proporzionali, Maiusc libera
      if (prop) {
        const k = corner ? (Math.abs(nsx / st.sx) > Math.abs(nsy / st.sy) ? nsx / st.sx : nsy / st.sy) : u ? nsx / st.sx : nsy / st.sy;
        nsx = st.sx * k; nsy = st.sy * k;
      }
      if (Math.abs(nsx) < 1e-3) nsx = 1e-3; if (Math.abs(nsy) < 1e-3) nsy = 1e-3;
      const clx = -au * st.w / 2 * nsx, cly = -av * st.h / 2 * nsy;
      Object.assign(tf, { sx: nsx, sy: nsy, cx: axw + clx * c - cly * s, cy: ayw + clx * s + cly * c });
    };
  }
  function commitTransform(name) {
    const t = tf; if (!t) return;
    const m = tfMatrix(t), L = t.L, moved = xform(t.src, 0, 0, m, true);
    const parts = [moved]; if (t.hole) parts.push({ c: t.hole, x: L.x, y: L.y });
    const x0 = Math.min(...parts.map(q => q.x)), y0 = Math.min(...parts.map(q => q.y)), x1 = Math.max(...parts.map(q => q.x + q.c.width)), y1 = Math.max(...parts.map(q => q.y + q.c.height));
    const c = mkCanvas(x1 - x0, y1 - y0), g = g2(c);
    if (t.hole) g.drawImage(t.hole, L.x - x0, L.y - y0);
    g.drawImage(moved.c, moved.x - x0, moved.y - y0);
    // la maschera collegata segue il livello quando si sposta soltanto
    if (L.mask && !t.float && t.rot === 0 && t.sx === 1 && t.sy === 1) { const dx = Math.round(t.cx - (L.x + t.w / 2)), dy = 0; void dx; void dy; }
    Object.assign(L, { c, x: x0, y: y0 });
    if (t.float && t.selPiece) { const s = xform(t.selPiece, 0, 0, m, true), sc = mkCanvas(W, H); g2(sc).drawImage(s.c, s.x, s.y); sel = makeSel(sc); if (sel) lastSel = sel; }
    tf = null; preview = null;
    invalidate(); commit(name || tr("imgedit.trasformazione_libera")); renderOptions();
  }
  function cancelTransform() { tf = null; setPreview(null); invalidate(); renderOptions(); }

  // ------------------------------------------------------------ ritaglio (taglierina)
  let crop = null;
  const RATIOS = { free: null, "1:1": 1, "4:3": 4 / 3, "3:2": 3 / 2, "16:9": 16 / 9, "3:4": 3 / 4, "2:3": 2 / 3, "9:16": 9 / 16, orig: "orig" };
  function startCrop() { crop = { x: 0, y: 0, w: W, h: H }; schedule(); }
  function drawCrop(g, px) {
    const { x, y, w, h } = crop;
    g.fillStyle = "rgba(0,0,0,.5)";
    g.beginPath(); g.rect(-1e5, -1e5, 2e5, 2e5); g.rect(x, y, w, h); g.fill("evenodd");
    g.strokeStyle = "rgba(255,255,255,.55)"; g.lineWidth = px;
    g.beginPath(); for (const k of [1, 2]) { g.moveTo(x + w * k / 3, y); g.lineTo(x + w * k / 3, y + h); g.moveTo(x, y + h * k / 3); g.lineTo(x + w, y + h * k / 3); } g.stroke();
    g.strokeStyle = "#fff"; g.lineWidth = 1.5 * px; g.strokeRect(x, y, w, h);
    g.fillStyle = "#fff";
    for (const [u, v] of HANDLES) { const hx = x + (u + 1) / 2 * w, hy = y + (v + 1) / 2 * h; g.fillRect(hx - 4 * px, hy - 4 * px, 8 * px, 8 * px); }
  }
  function cropHit(p) {
    const { x, y, w, h } = crop;
    for (const [u, v] of HANDLES) { const hx = x + (u + 1) / 2 * w, hy = y + (v + 1) / 2 * h; if (Math.hypot((hx - p.x) * zoom, (hy - p.y) * zoom) < 9) return { u, v }; }
    return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h ? "move" : "new";
  }
  function ratioVal() { const r = RATIOS[opt.crop.ratio]; return r === "orig" ? W / H : r; }
  function cropDrag(p0, hit) {
    const st = { ...crop }, R = ratioVal();
    if (hit === "move") return p => { crop.x = st.x + p.x - p0.x; crop.y = st.y + p.y - p0.y; };
    if (hit === "new") return (p, e) => {
      let w = p.x - p0.x, h = p.y - p0.y;
      const r = R || (e.shiftKey ? 1 : null);
      if (r) { if (Math.abs(w) / r > Math.abs(h)) h = Math.sign(h || 1) * Math.abs(w) / r; else w = Math.sign(w || 1) * Math.abs(h) * r; }
      crop = { x: Math.min(p0.x, p0.x + w), y: Math.min(p0.y, p0.y + h), w: Math.abs(w), h: Math.abs(h) };
    };
    const { u, v } = hit;
    return p => {
      let x0 = st.x, y0 = st.y, x1 = st.x + st.w, y1 = st.y + st.h;
      if (u < 0) x0 = Math.min(p.x, x1 - 1); if (u > 0) x1 = Math.max(p.x, x0 + 1);
      if (v < 0) y0 = Math.min(p.y, y1 - 1); if (v > 0) y1 = Math.max(p.y, y0 + 1);
      if (R) {
        let w = x1 - x0, h = y1 - y0;
        if (u && v) { if (w / R > h) h = w / R; else w = h * R; } else if (u) h = w / R; else w = h * R;
        if (u < 0) x0 = x1 - w; else x1 = x0 + w;
        if (v < 0) y0 = y1 - h; else if (v > 0) y1 = y0 + h; else { const cy = (st.y * 2 + st.h) / 2; y0 = cy - h / 2; y1 = cy + h / 2; }
        if (!u) { const cx = (st.x * 2 + st.w) / 2; x0 = cx - w / 2; x1 = cx + w / 2; }
      }
      crop = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    };
  }
  function applyCrop() { if (!crop) return; const r = crop; crop = null; if (r.w < 1 || r.h < 1) return schedule(); cropDoc(r, opt.crop.del); if (tool === "crop") startCrop(); }
  function cancelCrop() { if (tool === "crop") startCrop(); else crop = null; schedule(); }

  // ------------------------------------------------------------ testo
  let textEd = null;
  function startText(L, isNew) {
    endText(true);
    textEd = { L, isNew, before: L.props.text };
    L.editing = true; invalidate();
    const p = L.props;
    textBox.value = p.text;
    textBox.hidden = false;
    placeText();
    textBox.focus();
    if (!isNew) textBox.select();
    renderOptions();
  }
  function placeText() {
    if (!textEd) return;
    const p = textEd.L.props, lines = textBox.value.split("\n");
    Object.assign(textBox.style, {
      left: panX + p.x * zoom + "px", top: panY + p.y * zoom + "px", fontFamily: `"${p.font}"`, fontSize: p.size * zoom + "px",
      fontWeight: p.bold ? "700" : "400", fontStyle: p.italic ? "italic" : "normal", color: p.color, lineHeight: p.size * (p.lead || 1.2) * zoom + "px",
      textAlign: p.align, height: lines.length * p.size * (p.lead || 1.2) * zoom + 8 + "px",
      width: Math.max(40, ...lines.map(t => (t.length + 1) * p.size * 0.62)) * zoom + 16 + "px",
    });
  }
  textBox.addEventListener("input", () => { if (textEd) { textEd.L.props.text = textBox.value; placeText(); } });
  textBox.addEventListener("keydown", e => {
    if ((e.key === "Enter" && e.ctrlKey) || (e.key === "Enter" && e.target.value === "" && false)) { e.preventDefault(); endText(true); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); endText(true); }
  });
  function endText(keep) {
    if (!textEd) return;
    const { L, isNew, before } = textEd;
    textEd = null; L.editing = false; textBox.hidden = true;
    if (!keep) L.props.text = before;
    const idx = layers.indexOf(L);
    if (!L.props.text.trim()) {
      if (idx >= 0 && isNew) { layers.splice(idx, 1); act = Math.min(act, layers.length - 1); }
      invalidate(); refreshPanels(); renderOptions();
      return;
    }
    renderText(L);
    if (idx >= 0 && L.props.text.slice(0, 30)) L.name = L.props.text.split("\n")[0].slice(0, 30);
    invalidate();
    if (isNew || L.props.text !== before) commit(isNew ? tr("imgedit.livello_testo") : tr("imgedit.modifica_testo")); else refreshPanels();
    renderOptions();
  }
  function textAt(p) {
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i];
      if (L.kind === "text" && L.visible && L.c && p.x >= L.x && p.y >= L.y && p.x <= L.x + L.c.width && p.y <= L.y + L.c.height) return i;
    }
    return -1;
  }

  // ------------------------------------------------------------ strumenti: gestione del mouse
  let drag = null, lassoPts = [], spaceDown = false, altDown = false, panDrag = null;
  const curTool = () => (spaceDown ? "hand" : altDown && ["brush", "pencil", "gradient", "bucket", "shapeRect", "shapeRound", "shapeEllipse", "shapeLine", "type"].includes(tool) ? "eyedropper" : tool);
  function layerAt(p) {
    if (needComp) { composite(); needComp = false; }
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i];
      if (!L.visible || !L.c || p.x < L.x || p.y < L.y || p.x >= L.x + L.c.width || p.y >= L.y + L.c.height) continue;
      if (L.c.getContext("2d", { willReadFrequently: true }).getImageData(Math.floor(p.x - L.x), Math.floor(p.y - L.y), 1, 1).data[3] > 10) return i;
    }
    return -1;
  }
  const capture = e => { try { view.setPointerCapture(e.pointerId); } catch { /* eventi simulati */ } };
  let penSeen = false;
  function down(e) {
    if (e.pointerType === "pen") penSeen = true;
    // rifiuto del palmo: dopo aver usato la penna il dito non dipinge, sposta la vista (pizzico = zoom)
    if (e.pointerType === "touch" && (penSeen || (e.width > 40 && e.height > 40))) {
      panDrag = { x: e.clientX, y: e.clientY, px: panX, py: panY }; capture(e); e.preventDefault(); return;
    }
    if (e.button === 1 || (e.button === 0 && curTool() === "hand")) {
      panDrag = { x: e.clientX, y: e.clientY, px: panX, py: panY }; capture(e); e.preventDefault(); return;
    }
    if (e.button !== 0) return;
    capture(e);
    root.focus({ preventScroll: true });
    const p = docPt(e), t = curTool();
    if (textEd && t !== "type") endText(true);
    if (tf) {
      const hit = tfHit(p);
      drag = { move: tfDrag(p, hit, e), up: () => updateTfPreview(), noCursor: true };
      return;
    }
    switch (t) {
      case "move": {
        if (e.ctrlKey || opt.move.auto) { const i = layerAt(p); if (i >= 0 && i !== act) selectLayer(i); }
        const L = cur(); if (!L) return;
        if (sel && L.c) { if (!beginTransform(true)) return; const h = tfDrag(p, { type: "move" }, e); drag = { move: h, up: () => commitTransform(tr("imgedit.sposta")) }; return; }
        if (L.kind === "adjust" && !L.mask) return;
        const sx = L.x, sy = L.y, mx = L.mask?.x, my = L.mask?.y, props = L.props ? structuredClone(L.props) : null;
        let moved = false;
        drag = {
          move: (q, ev) => {
            let dx = Math.round(q.x - p.x), dy = Math.round(q.y - p.y);
            if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
            moved = moved || dx || dy;
            L.x = sx + dx; L.y = sy + dy;
            if (L.mask) L.mask = { ...L.mask, x: mx + dx, y: my + dy };
            if (L.kind === "text") { L.props.x = props.x + dx; L.props.y = props.y + dy; }
            if (L.kind === "shape") { const P = L.props; if (P.type === "line") { P.x1 = props.x1 + dx; P.x2 = props.x2 + dx; P.y1 = props.y1 + dy; P.y2 = props.y2 + dy; } else { P.x = props.x + dx; P.y = props.y + dy; } }
            invalidate();
          },
          up: () => { if (moved) commit(tr("imgedit.sposta")); },
        };
        return;
      }
      case "marqueeRect": case "marqueeEllipse": {
        const mode = selMode(e), sh0 = e.shiftKey, alt0 = e.altKey;
        let r = null;
        drag = {
          move: (q, ev) => {
            let w = q.x - p.x, h = q.y - p.y;
            if (ev.shiftKey && !sh0) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
            const c = ev.altKey && !alt0;
            r = c ? { x: p.x - Math.abs(w), y: p.y - Math.abs(h), w: Math.abs(w) * 2, h: Math.abs(h) * 2 } : { x: Math.min(p.x, p.x + w), y: Math.min(p.y, p.y + h), w: Math.abs(w), h: Math.abs(h) };
            if (t === "marqueeRect") { r.x = Math.round(r.x); r.y = Math.round(r.y); r.w = Math.round(r.w); r.h = Math.round(r.h); }
          },
          overlay: (g, px, ants) => { if (!r) return; const pa = new Path2D(); if (t === "marqueeRect") pa.rect(r.x, r.y, r.w, r.h); else pa.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2); ants(pa); },
          up: () => {
            if (!r || r.w < 1 || r.h < 1) { if (mode === "new" && sel) deselect(); return; }
            const pa = new Path2D();
            if (t === "marqueeRect") pa.rect(r.x, r.y, r.w, r.h); else pa.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
            applySelection(shapeMask(g => g.fill(pa)), mode, t === "marqueeRect" ? tr("imgedit.selezione_rettangolare") : tr("imgedit.selezione_ellittica"), pa);
          },
        };
        return;
      }
      case "lasso": {
        const mode = selMode(e);
        lassoPts = [[p.x, p.y]];
        drag = {
          move: q => { lassoPts.push([q.x, q.y]); },
          up: () => {
            const pts = lassoPts; lassoPts = [];
            if (pts.length < 3) { if (mode === "new" && sel) deselect(); schedule(); return; }
            const pa = new Path2D(); pts.forEach(([x, y], i) => (i ? pa.lineTo(x, y) : pa.moveTo(x, y))); pa.closePath();
            applySelection(shapeMask(g => g.fill(pa)), mode, tr("imgedit.lazo"), pa);
          },
        };
        return;
      }
      case "lassoPoly": {
        if (!lassoPts.length) { lassoPts = [[p.x, p.y]]; lassoPts.mode = selMode(e); schedule(); return; }
        const [fx, fy] = lassoPts[0];
        if (Math.hypot((fx - p.x) * zoom, (fy - p.y) * zoom) < 8) return closePoly();
        lassoPts.push([p.x, p.y]); schedule();
        return;
      }
      case "wand": {
        const mode = selMode(e), c = floodCanvas(p, opt.wand.tol, opt.wand.contig, opt.wand.all, "#ffffff");
        if (c) applySelection(c, mode, tr("imgedit.bacchetta_magica"));
        return;
      }
      case "crop": {
        if (!crop) startCrop();
        const hit = cropHit(p);
        drag = { move: cropDrag(p, hit), noCursor: true };
        return;
      }
      case "eyedropper": {
        const toBg = e.altKey && tool === "eyedropper";
        pickColor(p, toBg);
        drag = { move: q => pickColor(q, toBg) };
        return;
      }
      case "brush": case "pencil": case "eraser": case "stamp": {
        if (t === "stamp" && e.altKey) { cloneSrc = { x: p.x, y: p.y }; cloneOff = null; toast(tr("imgedit.origine_timbro_clone_impostata"), false, 1500); schedule(); return; }
        stroke = beginStroke(p, e, t);
        if (!stroke) return;
        drag = {
          move: (q, ev) => { const co = ev.getCoalescedEvents?.(); for (const ce of co?.length ? co : [ev]) strokeTo(stroke, docPt(ce)); stroke.dirty = true; },
          up: q => endStroke(stroke, q),
        };
        return;
      }
      case "gradient": {
        let q0 = null;
        drag = {
          move: (q, ev) => { q0 = q; if (ev.shiftKey) { const a = Math.round(Math.atan2(q.y - p.y, q.x - p.x) / (Math.PI / 4)) * Math.PI / 4, d = Math.hypot(q.x - p.x, q.y - p.y); q0 = { x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d }; } },
          overlay: (g, px) => { if (!q0) return; g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q0.x, q0.y); g.strokeStyle = "#000"; g.lineWidth = 2.5 * px; g.stroke(); g.strokeStyle = "#fff"; g.lineWidth = px; g.stroke(); },
          up: () => { if (q0 && Math.hypot(q0.x - p.x, q0.y - p.y) > 1) drawGradient(p, q0); },
        };
        return;
      }
      case "bucket": {
        const T = paintTarget(); if (!T) return;
        const c = floodCanvas(p, opt.bucket.tol, opt.bucket.contig, opt.bucket.all, fg);
        if (c) applyDocBuffer(c, opt.bucket.opacity, tr("imgedit.secchiello"));
        return;
      }
      case "type": {
        const i = textAt(p);
        if (i >= 0) { selectLayer(i); startText(layers[i], false); return; }
        if (textEd) { endText(true); return; }
        const o = opt.type, L = mkLayer({ name: tr("imgedit.testo"), kind: "text", props: { text: "", font: o.font, size: o.size, bold: o.bold, italic: o.italic, align: o.align, color: fg, lead: 1.2, x: Math.round(p.x), y: Math.round(p.y - o.size * 0.6) } });
        renderText(L);
        layers.splice(act + 1, 0, L); act++; target = "pixels";
        startText(L, true); refreshPanels();
        e.preventDefault();
        return;
      }
      case "shapeRect": case "shapeRound": case "shapeEllipse": case "shapeLine": {
        const type = { shapeRect: "rect", shapeRound: "round", shapeEllipse: "ellipse", shapeLine: "line" }[t], o = opt.shape;
        let L = null;
        drag = {
          move: (q, ev) => {
            if (!L) {
              L = mkLayer({ name: nameNew({ rect: tr("imgedit.rettangolo"), round: tr("imgedit.rettangolo_arrotondato"), ellipse: tr("imgedit.ellisse"), line: tr("imgedit.linea") }[type]), kind: "shape",
                props: type === "line" ? { type, x1: p.x, y1: p.y, x2: q.x, y2: q.y, sw: o.sw, color2: fg } : { type, x: p.x, y: p.y, w: 0, h: 0, fill: o.fill ? fg : null, stroke: o.stroke ? o.color2 : null, sw: o.sw, r: o.r } });
              layers.splice(act + 1, 0, L); act++; target = "pixels";
            }
            const P = L.props;
            if (type === "line") {
              let x2 = q.x, y2 = q.y;
              if (ev.shiftKey) { const a = Math.round(Math.atan2(q.y - p.y, q.x - p.x) / (Math.PI / 4)) * Math.PI / 4, d = Math.hypot(q.x - p.x, q.y - p.y); x2 = p.x + Math.cos(a) * d; y2 = p.y + Math.sin(a) * d; }
              P.x2 = x2; P.y2 = y2;
            } else {
              let w = q.x - p.x, h = q.y - p.y;
              if (ev.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
              if (ev.altKey) { P.x = p.x - w; P.y = p.y - h; P.w = w * 2; P.h = h * 2; } else { P.x = p.x; P.y = p.y; P.w = w; P.h = h; }
            }
            renderShape(L); invalidate();
          },
          up: () => {
            if (!L) return;
            const P = L.props;
            if (P.type !== "line") { P.x = Math.min(P.x, P.x + P.w); P.y = Math.min(P.y, P.y + P.h); P.w = Math.abs(P.w); P.h = Math.abs(P.h); }
            renderShape(L); invalidate(); commit(L.name.replace(/ \d+$/, ""));
          },
        };
        return;
      }
      case "zoom": {
        let r = null;
        drag = {
          move: q => { r = { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) }; },
          overlay: (g, px) => { if (r) { g.strokeStyle = "#2c8ef8"; g.lineWidth = px; g.strokeRect(r.x, r.y, r.w, r.h); } },
          up: () => {
            if (r && r.w * zoom > 6 && r.h * zoom > 6) {
              const rr = stage.getBoundingClientRect(), z = clamp(Math.min(rr.width / r.w, rr.height / r.h) * 0.95, 0.01, 64);
              zoom = z; panX = rr.width / 2 - (r.x + r.w / 2) * z; panY = rr.height / 2 - (r.y + r.h / 2) * z; schedule(); status();
            } else zoomStep(e.altKey ? -1 : 1, p.sx, p.sy);
          },
        };
        return;
      }
    }
  }
  function closePoly() {
    const pts = lassoPts, mode = lassoPts.mode || "new"; lassoPts = [];
    if (pts.length < 3) return schedule();
    const pa = new Path2D(); pts.forEach(([x, y], i) => (i ? pa.lineTo(x, y) : pa.moveTo(x, y))); pa.closePath();
    applySelection(shapeMask(g => g.fill(pa)), mode, tr("imgedit.lazo_poligonale"), pa);
  }
  function drawGradient(p0, p1) {
    const c = mkCanvas(W, H), g = g2(c), o = opt.gradient;
    const gr = o.type === "radial" ? g.createRadialGradient(p0.x, p0.y, 0, p0.x, p0.y, Math.hypot(p1.x - p0.x, p1.y - p0.y)) : g.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
    const [R, G, B] = hexToRgb(fg);
    let a = fg, b = o.kind === "fgbg" ? bg : `rgba(${R},${G},${B},0)`;
    if (o.reverse) [a, b] = [b, a];
    gr.addColorStop(0, a); gr.addColorStop(1, b);
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    applyDocBuffer(c, o.opacity, tr("imgedit.sfumatura"));
  }
  function move(e) {
    const p = docPt(e);
    if (panDrag) { autoFit = false; panX = panDrag.px + e.clientX - panDrag.x; panY = panDrag.py + e.clientY - panDrag.y; placeText(); schedule(); return; }
    hover = p;
    if (tf && !drag) hover.tfHit = tfHit(p);
    if (drag?.move) drag.move(p, e);
    schedule();
    if (p.x >= 0 && p.y >= 0 && p.x < W && p.y < H) ctx.status(`${Math.round(zoom * 1000) / 10}% · ${W} × ${H} px · X ${Math.floor(p.x)}  Y ${Math.floor(p.y)}`);
  }
  function up(e) {
    if (panDrag) { panDrag = null; return; }
    const d = drag; drag = null;
    if (d?.up) d.up(docPt(e), e);
    schedule();
  }
  // tablet: pizzico = zoom, due dita = sposta; il secondo dito annulla il tratto iniziato dal primo
  pinchPan(view, {
    onStart: () => { if (stroke) { stroke = null; preview = null; needComp = true; } drag = null; panDrag = null; schedule(); },
    onPan: (dx, dy) => { autoFit = false; panX += dx; panY += dy; placeText(); schedule(); },
    onZoom: (f, cx, cy) => setZoom(zoom * f, cx, cy),
  });
  view.addEventListener("pointerdown", down);
  view.addEventListener("pointermove", move);
  view.addEventListener("pointerup", up);
  view.addEventListener("pointercancel", up);
  view.addEventListener("pointerleave", () => { hover = null; schedule(); });
  view.addEventListener("dblclick", e => { if (tool === "lassoPoly" && lassoPts.length) { lassoPts.pop(); closePoly(); } else if (tf) commitTransform(); else if (crop && tool === "crop") applyCrop(); void e; });
  view.addEventListener("contextmenu", e => e.preventDefault());
  stage.addEventListener("wheel", e => {
    e.preventDefault();
    const r = stage.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top;
    if (e.ctrlKey || e.altKey) setZoom(zoom * Math.pow(1.0018, -e.deltaY), cx, cy); // Alt+rotella come Photoshop, Ctrl anche dal touchpad
    else if (e.shiftKey) { autoFit = false; panX -= e.deltaY; placeText(); schedule(); }
    else { autoFit = false; panX -= e.deltaX; panY -= e.deltaY; placeText(); schedule(); }
  }, { passive: false });
  // Barra spaziatrice = Mano temporanea, Alt = Contagocce temporaneo (come Photoshop)
  const isTyping = t => t?.closest?.("input, textarea, select, [contenteditable]");
  const onKeyDown = e => {
    if (!root.isConnected) return cleanupKeys();
    if (ctx.tab.view.hidden || isTyping(e.target) || dlgOpen) return;
    if (e.key === " " && !spaceDown) { spaceDown = true; e.preventDefault(); schedule(); }
    if (e.key === "Alt") { altDown = true; e.preventDefault(); schedule(); }
  };
  const onKeyUp = e => {
    if (e.key === " ") { spaceDown = false; schedule(); }
    if (e.key === "Alt") { altDown = false; e.preventDefault(); schedule(); }
  };
  const onBlur = () => { spaceDown = altDown = false; };
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onBlur);
  const cleanupKeys = () => { window.removeEventListener("keydown", onKeyDown, true); window.removeEventListener("keyup", onKeyUp, true); window.removeEventListener("blur", onBlur); window.removeEventListener("paste", onPaste); };

  // ------------------------------------------------------------ appunti
  let clip = null;
  function copy(merged, cut) {
    const L = cur();
    let src, x, y;
    if (merged) { src = flatten(); x = 0; y = 0; }
    else { if (!L?.c) return; src = L.c; x = L.x; y = L.y; }
    let c;
    if (sel) {
      const b = sel.bounds; c = mkCanvas(b.w, b.h); const g = g2(c);
      g.drawImage(src, x - b.x, y - b.y); g.globalCompositeOperation = "destination-in"; g.drawImage(sel.c, -b.x, -b.y);
      x = b.x; y = b.y;
    } else c = cloneC(src);
    clip = { c, x, y };
    c.toBlob(b => { try { navigator.clipboard?.write?.([new ClipboardItem({ "image/png": b })]).catch(() => {}); } catch { /* */ } }, "image/png");
    if (cut && !merged) clearSel(); else toast(merged ? tr("imgedit.copia_unione_eseguita") : tr("imgedit.copiato"), false, 1200);
  }
  function pasteCanvas(c, x, y) {
    if (x === undefined || x + c.width < 0 || y + c.height < 0 || x > W || y > H) { x = Math.round((W - c.width) / 2); y = Math.round((H - c.height) / 2); }
    endText(true);
    const L = mkLayer({ name: nameNew(tr("imgedit.livello")), c, x, y });
    layers.splice(act + 1, 0, L); act++; target = "pixels"; sel = null;
    invalidate(); commit(tr("common.incolla"));
  }
  const onPaste = async e => {
    if (!root.isConnected || ctx.tab.view.hidden || isTyping(e.target) || dlgOpen) return;
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith("image/"));
    e.preventDefault();
    if (item) {
      const bmp = await createImageBitmap(item.getAsFile());
      // stessa immagine copiata qui: si incolla nella posizione d'origine
      if (clip && clip.c.width === bmp.width && clip.c.height === bmp.height) return pasteCanvas(cloneC(clip.c), clip.x, clip.y);
      const c = mkCanvas(bmp.width, bmp.height); g2(c).drawImage(bmp, 0, 0);
      return pasteCanvas(c);
    }
    if (clip) pasteCanvas(cloneC(clip.c), clip.x, clip.y);
  };
  window.addEventListener("paste", onPaste);

  // ------------------------------------------------------------ finestre di dialogo (non bloccano l'anteprima sul documento)
  let dlgOpen = false;
  function dialog(title, body, { okLabel = "OK", preview: hasPreview = false, onPreview } = {}) {
    return new Promise(resolve => {
      dlgOpen = true;
      const prevChk = el("input", { type: "checkbox", checked: true });
      prevChk.checked = true;
      const box = el("div", { class: "ps-dlg", role: "dialog" },
        el("div", { class: "ps-dlg-h" }, title),
        el("div", { class: "ps-dlg-b" }, body),
        el("div", { class: "ps-dlg-f" },
          hasPreview ? el("label", { class: "ps-check" }, prevChk, tr("imgedit.anteprima")) : null, el("span", { class: "grow" }),
          el("button", { class: "btn", type: "button", onclick: () => close(false) }, tr("common.annulla")),
          el("button", { class: "btn primary", type: "button", onclick: () => close(true) }, okLabel)));
      if (hasPreview) prevChk.addEventListener("change", () => onPreview?.(prevChk.checked));
      const close = v => { dlgOpen = false; box.remove(); resolve(v); };
      box.addEventListener("keydown", e => {
        if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "BUTTON") { e.preventDefault(); e.stopPropagation(); close(true); }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(false); }
      });
      // trascinabile dal titolo
      const h = box.firstChild;
      h.addEventListener("pointerdown", e => {
        const r = box.getBoundingClientRect(), rr = root.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
        h.setPointerCapture(e.pointerId);
        const mv = ev => { box.style.left = ev.clientX - rr.left - ox + "px"; box.style.top = ev.clientY - rr.top - oy + "px"; box.style.transform = "none"; };
        h.addEventListener("pointermove", mv);
        h.addEventListener("pointerup", () => h.removeEventListener("pointermove", mv), { once: true });
      });
      root.append(box);
      (box.querySelector(".ps-dlg-b input, .ps-dlg-b select") || box.querySelector(".btn.primary")).focus();
    });
  }
  const numField = (label, value, attrs = {}) => { const i = el("input", { type: "number", class: "ps-num", value, ...attrs }); return [i, el("label", { class: "ps-row" }, el("span", { class: "ps-lab2" }, label), i, attrs.unit ? el("span", { class: "ps-unit" }, attrs.unit) : null)]; };

  // regolazione distruttiva (Immagine > Regolazioni) o filtro con anteprima dal vivo
  function livePreview(L, compute) {
    let pending = false, last = null, on = true, done = false;
    const run = () => {
      pending = false;
      if (done) return; // finestra gia' chiusa: niente anteprima tardiva
      if (!on) return setPreview(null);
      last = mergeSel(L.c, compute(L.c), L.x, L.y);
      setPreview({ i: layers.indexOf(L), c: last, x: L.x, y: L.y });
    };
    return {
      update() { if (!pending) { pending = true; requestAnimationFrame(run); } },
      toggle(v) { on = v; this.update(); },
      result() { done = true; return !pending && on && last ? last : mergeSel(L.c, compute(L.c), L.x, L.y); },
      stop() { done = true; setPreview(null); },
    };
  }
  function destTarget() {
    const L = cur();
    if (!L) return null;
    if (L.kind === "adjust") { toast(tr("imgedit.livello_attivo_regolazione_seleziona_livello"), true); return null; }
    if (L.kind === "text" || L.kind === "shape") rasterize(L, true);
    if (!L.visible) { toast(tr("imgedit.livello_attivo_nascosto"), true); return null; }
    return L;
  }
  async function runAdjust(type) {
    endText(true);
    const L0 = cur();
    if (L0?.mask && target === "mask" && type === "invert") return maskOp("invert");
    const L = destTarget(); if (!L) return;
    const p = ADJ[type].def();
    let H_ = null;
    const hist = () => (H_ ||= histogram(readData(L.c).data));
    const lp = livePreview(L, c => { const id = readData(c); makeAdjust(type, p)(id.data); const o = mkCanvas(c.width, c.height); g2(o).putImageData(id, 0, 0); return o; });
    if (type === "invert") { L.c = lp.result(); invalidate(); return commit(tr("imgedit.inverti")); }
    lp.update();
    const ok = await dialog(ADJ[type].name, adjustControls(type, p, () => lp.update(), hist), { preview: true, onPreview: v => lp.toggle(v) });
    if (ok) { L.c = lp.result(); preview = null; invalidate(); commit(ADJ[type].name); }
    else lp.stop();
  }
  function quickAdjust(kind) {
    const L = destTarget(); if (!L) return;
    const id = readData(L.c);
    if (kind === "desaturate") makeAdjust("desaturate", {})(id.data); else autoAdjust(kind, id.data);
    const o = mkCanvas(L.c.width, L.c.height); g2(o).putImageData(id, 0, 0);
    L.c = mergeSel(L.c, o, L.x, L.y); invalidate();
    commit({ desaturate: tr("imgedit.togli_saturazione"), tone: tr("imgedit.tono_automatico"), contrast: tr("imgedit.contrasto_automatico"), color: tr("imgedit.colore_automatico") }[kind]);
  }
  let lastFilter = null;
  async function runFilter(id, again) {
    endText(true);
    const f = FILTERS[id], L = destTarget(); if (!L) return;
    const p = again && lastFilter?.id === id ? { ...lastFilter.p } : { ...(f.def || {}) };
    const lp = livePreview(L, c => f.run(c, p));
    if (f.ui && !again) {
      lp.update();
      const ok = await dialog(f.name.replace("...", ""), filterControls(f, p, () => lp.update()), { preview: true, onPreview: v => lp.toggle(v) });
      if (!ok) return lp.stop();
    }
    ctx.status(tr("imgedit.filtro_corso"));
    await new Promise(r => setTimeout(r, 20));
    L.c = lp.result(); preview = null; invalidate();
    lastFilter = { id, p };
    commit(f.name.replace("...", "")); status();
  }

  async function dlgImageSize() {
    let keep = true;
    const [wI, wRow] = numField(tr("imgedit.larghezza"), W, { min: 1, max: 30000, unit: "pixel" }), [hI, hRow] = numField(tr("imgedit.altezza"), H, { min: 1, max: 30000, unit: "pixel" });
    const [pI, pRow] = numField(tr("imgedit.percentuale"), 100, { min: 1, max: 1000, step: 1, unit: "%" });
    const chk = el("input", { type: "checkbox" }); chk.checked = true;
    const res = el("select", { class: "field ps-sel" }, el("option", { value: "1" }, tr("imgedit.automatico_bicubica")), el("option", { value: "0" }, tr("imgedit.vicino_piu_prossimo_bordi_netti")));
    wI.addEventListener("input", () => { if (keep) hI.value = Math.max(1, Math.round(+wI.value * H / W)); pI.value = Math.round(+wI.value / W * 100); });
    hI.addEventListener("input", () => { if (keep) wI.value = Math.max(1, Math.round(+hI.value * W / H)); });
    pI.addEventListener("input", () => { wI.value = Math.max(1, Math.round(W * +pI.value / 100)); hI.value = Math.max(1, Math.round(H * +pI.value / 100)); });
    chk.addEventListener("change", () => (keep = chk.checked));
    const ok = await dialog(tr("imgedit.dimensione_immagine"), el("div", { class: "ps-form" }, el("p", { class: "ps-note" }, `Attuale: ${W} × ${H} pixel`), wRow, hRow, pRow,
      el("label", { class: "ps-check" }, chk, tr("imgedit.vincola_proporzioni")), el("label", { class: "ps-row" }, el("span", { class: "ps-lab2" }, tr("imgedit.ricampiona")), res)));
    if (ok && +wI.value > 0 && +hI.value > 0 && (+wI.value !== W || +hI.value !== H)) resizeDoc(Math.round(+wI.value), Math.round(+hI.value), res.value === "1");
  }
  async function dlgCanvasSize() {
    const [wI, wRow] = numField(tr("imgedit.larghezza"), W, { min: 1, max: 30000, unit: "pixel" }), [hI, hRow] = numField(tr("imgedit.altezza"), H, { min: 1, max: 30000, unit: "pixel" });
    const rel = el("input", { type: "checkbox" });
    rel.addEventListener("change", () => { wI.value = rel.checked ? 0 : W; hI.value = rel.checked ? 0 : H; });
    let anchor = [0.5, 0.5];
    const grid = el("div", { class: "ps-anchor" });
    const drawGrid = () => { grid.innerHTML = ""; for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) grid.append(el("button", { type: "button", class: anchor[0] === c / 2 && anchor[1] === r / 2 ? "on" : "", onclick: () => { anchor = [c / 2, r / 2]; drawGrid(); } })); };
    drawGrid();
    const col = el("select", { class: "field ps-sel" }, ...[["", tr("imgedit.trasparente")], ["fg", tr("imgedit.primo_piano")], ["bg", tr("imgedit.sfondo")], ["#ffffff", tr("imgedit.bianco")], ["#000000", tr("imgedit.nero")], ["#808080", tr("imgedit.grigio")]].map(([v, t]) => el("option", { value: v }, t)));
    col.value = layers[0]?.name === "Sfondo" ? "bg" : "";
    const ok = await dialog(tr("imgedit.dimensione_quadro"), el("div", { class: "ps-form" }, el("p", { class: "ps-note" }, `Attuale: ${W} × ${H} pixel`), wRow, hRow,
      el("label", { class: "ps-check" }, rel, tr("imgedit.relativa")), el("div", { class: "ps-row" }, el("span", { class: "ps-lab2" }, tr("imgedit.ancoraggio")), grid),
      el("label", { class: "ps-row" }, el("span", { class: "ps-lab2" }, tr("imgedit.colore_estensione")), col)));
    if (!ok) return;
    const nw = Math.round(rel.checked ? W + +wI.value : +wI.value), nh = Math.round(rel.checked ? H + +hI.value : +hI.value);
    if (nw < 1 || nh < 1 || (nw === W && nh === H)) return;
    canvasSize(nw, nh, anchor[0], anchor[1], col.value === "fg" ? fg : col.value === "bg" ? bg : col.value || null);
  }
  async function dlgRotate() {
    const [aI, row] = numField(tr("imgedit.angolo"), 15, { min: -359.99, max: 359.99, step: 0.01, unit: "° (positivo = orario)" });
    if (await dialog(tr("imgedit.ruota_quadro"), el("div", { class: "ps-form" }, row)) && +aI.value) rotateDoc("free", +aI.value);
  }
  async function dlgFill() {
    const what = el("select", { class: "field ps-sel" }, ...[["fg", tr("imgedit.colore_primo_piano")], ["bg", tr("imgedit.colore_sfondo")], ["#000000", tr("imgedit.nero")], ["#808080", "Grigio 50%"], ["#ffffff", tr("imgedit.bianco")]].map(([v, t]) => el("option", { value: v }, t)));
    const [oI, oRow] = numField(tr("imgedit.opacita"), 100, { min: 1, max: 100, unit: "%" });
    if (!(await dialog(tr("imgedit.riempi"), el("div", { class: "ps-form" }, el("label", { class: "ps-row" }, el("span", { class: "ps-lab2" }, tr("imgedit.contenuto")), what), oRow)))) return;
    fillWith(what.value === "fg" ? fg : what.value === "bg" ? bg : what.value, clamp(+oI.value, 1, 100));
  }
  async function dlgStroke() {
    if (!sel) return toast(tr("imgedit.traccia_serve_selezione"), true);
    const [wI, wRow] = numField(tr("imgedit.larghezza"), 3, { min: 1, max: 250, unit: "pixel" });
    const pos = el("select", { class: "field ps-sel" }, el("option", { value: "center" }, tr("imgedit.centro")), el("option", { value: "inside" }, tr("imgedit.interna")), el("option", { value: "outside" }, tr("imgedit.esterna")));
    if (!(await dialog(tr("imgedit.traccia"), el("div", { class: "ps-form" }, wRow, el("label", { class: "ps-row" }, el("span", { class: "ps-lab2" }, tr("imgedit.posizione")), pos), el("p", { class: "ps-note" }, tr("imgedit.colore_primo_piano_2")))))) return;
    const w = +wI.value, c = mkCanvas(W, H), g = g2(c);
    g.strokeStyle = fg; g.lineWidth = pos.value === "center" ? w : w * 2; g.lineJoin = "round"; g.stroke(sel.path);
    if (pos.value !== "center") { g.globalCompositeOperation = pos.value === "inside" ? "destination-in" : "destination-out"; g.drawImage(sel.c, 0, 0); }
    const keep = sel; sel = null; applyDocBuffer(c, 100, tr("imgedit.traccia")); sel = keep; schedule();
  }
  async function dlgModifySel(kind) {
    if (!sel) return toast(tr("imgedit.nessuna_selezione"), true);
    const [rI, row] = numField({ feather: tr("imgedit.raggio_sfumatura"), expand: tr("imgedit.espandi_2"), contract: tr("imgedit.contrai_2") }[kind], kind === "feather" ? 5 : 2, { min: 0.1, max: 500, step: 0.1, unit: "pixel" });
    if (await dialog({ feather: tr("imgedit.sfuma_selezione"), expand: tr("imgedit.espandi_selezione"), contract: tr("imgedit.contrai_selezione") }[kind], el("div", { class: "ps-form" }, row))) modifySel(kind, +rI.value);
  }
  async function dlgNewLayer() {
    const n = el("input", { type: "text", class: "field", value: nameNew(tr("imgedit.livello")) });
    const bl = blendSelect("source-over");
    const [oI, oRow] = numField(tr("imgedit.opacita"), 100, { min: 0, max: 100, unit: "%" });
    if (!(await dialog(tr("imgedit.nuovo_livello"), el("div", { class: "ps-form" }, el("label", { class: "ps-row" }, el("span", { class: "ps-lab2" }, tr("imgedit.nome")), n), el("label", { class: "ps-row" }, el("span", { class: "ps-lab2" }, tr("imgedit.metodo")), bl), oRow)))) return;
    addLayer({ name: n.value || nameNew(tr("imgedit.livello")), blend: bl.value, opacity: clamp(+oI.value, 0, 100) });
  }
  async function renameLayer(L) {
    const n = el("input", { type: "text", class: "field", value: L.name });
    if (await dialog(tr("imgedit.proprieta_livello"), el("div", { class: "ps-form" }, el("label", { class: "ps-row" }, el("span", { class: "ps-lab2" }, tr("imgedit.nome")), n))) && n.value.trim()) { L.name = n.value.trim(); commit(tr("imgedit.rinomina_livello")); }
  }
  async function showInfo() {
    const dl = el("dl", { class: "kv" });
    const add = (k, v) => v !== undefined && v !== null && dl.append(el("dt", {}, k), el("dd", {}, String(v)));
    add(tr("imgedit.dimensioni"), `${W} × ${H} px`); add(tr("imgedit.livelli"), layers.length);
    add(tr("imgedit.formato"), init.meta?.formato || ctx.ext.toUpperCase()); add(tr("imgedit.modalita_colore"), init.meta?.modalita); add("Pagine/fotogrammi", init.meta?.pagine);
    for (const [k, v] of Object.entries(init.meta?.exif || {})) add(k, v);
    await modal(tr("imgedit.informazioni_immagine"), dl);
  }

  // ------------------------------------------------------------ colori primo piano / sfondo
  function setColor(which, v) { if (which === "fg") fg = v; else bg = v; tipCache.clear(); renderSwatches(); if (textEd && which === "fg") { textEd.L.props.color = fg; placeText(); } }
  fgIn.addEventListener("input", () => setColor("fg", fgIn.value));
  bgIn.addEventListener("input", () => setColor("bg", bgIn.value));
  const swFg = el("button", { class: "ps-sw ps-sw-fg", type: "button", title: tr("imgedit.imposta_colore_primo_piano"), onclick: () => { fgIn.value = fg; fgIn.click(); } });
  const swBg = el("button", { class: "ps-sw ps-sw-bg", type: "button", title: tr("imgedit.imposta_colore_sfondo"), onclick: () => { bgIn.value = bg; bgIn.click(); } });
  const swapColors = () => { [fg, bg] = [bg, fg]; tipCache.clear(); renderSwatches(); };
  const defaultColors = () => { fg = "#000000"; bg = "#ffffff"; tipCache.clear(); renderSwatches(); };
  function renderSwatches() { swFg.style.background = fg; swBg.style.background = bg; }

  // ------------------------------------------------------------ barra strumenti
  const toolBtns = [];
  let flyout = null;
  function buildToolbar() {
    GROUPS.forEach((grp, gi) => {
      const b = el("button", { class: "ps-tool", type: "button" });
      const upd = () => { const t = groupCur[gi]; b.innerHTML = ""; b.append(psIcon(t, 20)); if (grp.length > 1) b.append(el("span", { class: "ps-tri" })); b.title = `${TOOLS[t].name} (${TOOLS[t].key})`; b.classList.toggle("on", grp.includes(tool)); };
      b.addEventListener("click", () => selectTool(groupCur[gi]));
      b.addEventListener("dblclick", () => { if (groupCur[gi] === "hand") fit(true); if (groupCur[gi] === "zoom") setZoom(1); });
      const openFly = () => {
        closeFly();
        flyout = el("div", { class: "ps-fly" }, ...grp.map(t => el("button", { type: "button", class: "ps-fly-it" + (t === tool ? " on" : ""), onclick: () => { closeFly(); selectTool(t); } }, psIcon(t, 18), el("span", {}, TOOLS[t].name.replace(tr("imgedit.strumento"), "")), el("span", { class: "ps-k" }, TOOLS[t].key))));
        const r = b.getBoundingClientRect(), rr = root.getBoundingClientRect();
        flyout.style.left = r.right - rr.left + 2 + "px"; flyout.style.top = r.top - rr.top + "px";
        root.append(flyout);
      };
      if (grp.length > 1) {
        b.addEventListener("contextmenu", e => { e.preventDefault(); openFly(); });
        let lt = 0;
        b.addEventListener("pointerdown", () => { lt = setTimeout(openFly, 450); });
        b.addEventListener("pointerup", () => clearTimeout(lt));
        b.addEventListener("pointerleave", () => clearTimeout(lt));
      }
      toolBtns.push(upd);
      toolBar.append(b);
      if (SEP_AFTER.has(gi)) toolBar.append(el("div", { class: "ps-tsep" }));
    });
    toolBar.append(el("div", { class: "ps-tsep" }), el("div", { class: "ps-colors" }, swBg, swFg,
      el("button", { class: "ps-mini ps-mini-def", type: "button", title: tr("imgedit.colori_predefiniti_primo_piano_sfondo"), onclick: defaultColors }, psIcon("defaultColors", 11)),
      el("button", { class: "ps-mini ps-mini-swap", type: "button", title: tr("imgedit.inverti_colori_primo_piano_sfondo"), onclick: swapColors }, psIcon("swap", 12))));
    renderSwatches();
  }
  const closeFly = () => { flyout?.remove(); flyout = null; };
  root.addEventListener("pointerdown", e => { if (flyout && !flyout.contains(e.target)) closeFly(); }, true);
  function selectTool(t) {
    if (tf && t !== tool) commitTransform();
    if (lassoPts.length) { lassoPts = []; }
    if (textEd && t !== "type") endText(true);
    if (crop && t !== "crop") crop = null;
    tool = t;
    const gi = GROUPS.findIndex(g => g.includes(t)); groupCur[gi] = t;
    if (t === "crop") startCrop();
    toolBtns.forEach(f => f());
    renderOptions(); schedule();
  }
  // lettera: strumento del gruppo; Maiusc+lettera: strumento successivo del gruppo
  function toolKey(letter, cycle) {
    const gi = GROUPS.findIndex(g => TOOLS[g[0]].key === letter);
    if (gi < 0) return;
    const g = GROUPS[gi];
    selectTool(cycle && g.includes(tool) ? g[(g.indexOf(tool) + 1) % g.length] : groupCur[gi]);
  }

  // ------------------------------------------------------------ barra delle opzioni
  const oLabel = t => el("span", { class: "ps-olab" }, t);
  function oNum(obj, key, min, max, label, unit, step = 1, after) {
    const i = el("input", { type: "number", class: "ps-num", min, max, step, value: obj[key] });
    i.addEventListener("change", () => { obj[key] = clamp(+i.value || min, min, max); i.value = obj[key]; tipCache.clear(); after?.(); schedule(); });
    return el("label", { class: "ps-ofield" }, label ? oLabel(label) : null, i, unit ? el("span", { class: "ps-unit" }, unit) : null);
  }
  function oCheck(obj, key, label, after) { const c = el("input", { type: "checkbox" }); c.checked = !!obj[key]; c.addEventListener("change", () => { obj[key] = c.checked; after?.(); }); return el("label", { class: "ps-ofield ps-check" }, c, label); }
  function oSelect(obj, key, items, label, after) {
    const s = el("select", { class: "field ps-sel" }, ...items.map(([v, t]) => el("option", { value: v }, t)));
    s.value = obj[key]; s.addEventListener("change", () => { obj[key] = s.value; after?.(); });
    return el("label", { class: "ps-ofield" }, label ? oLabel(label) : null, s);
  }
  const oBtn = (icon, title, fn, on) => el("button", { class: "ps-obtn" + (on ? " on" : ""), type: "button", title, onclick: fn }, psIcon(icon, 18));
  const oSep = () => el("span", { class: "ps-osep" });
  function selModeBtns() {
    return [["new", "selNew", tr("imgedit.nuova_selezione")], ["add", "selAdd", tr("imgedit.aggiungi_selezione_maiusc")], ["sub", "selSub", tr("imgedit.sottrai_selezione_alt")], ["int", "selInt", tr("imgedit.interseca_selezione_maiusc_alt")]]
      .map(([m, ic, t]) => oBtn(ic, t, () => { opt.sel.mode = m; renderOptions(); }, opt.sel.mode === m));
  }
  function renderOptions() {
    optBar.innerHTML = "";
    const t = tool;
    optBar.append(el("span", { class: "ps-otool", title: TOOLS[t].name }, psIcon(t, 20)), oSep());
    if (tf) {
      const fld = (label, get, set, unit, step = 1) => { const i = el("input", { type: "number", class: "ps-num", step, value: Math.round(get() * 100) / 100 }); i.addEventListener("change", () => { set(+i.value); updateTfPreview(); }); return el("label", { class: "ps-ofield" }, oLabel(label), i, unit ? el("span", { class: "ps-unit" }, unit) : null); };
      optBar.append(oLabel(tr("imgedit.trasformazione_libera")), oSep(),
        fld("X:", () => tf.cx, v => (tf.cx = v), "px"), fld("Y:", () => tf.cy, v => (tf.cy = v), "px"), oSep(),
        fld("L:", () => tf.sx * 100, v => (tf.sx = v / 100 || 0.01), "%", 0.1), fld("A:", () => tf.sy * 100, v => (tf.sy = v / 100 || 0.01), "%", 0.1), oSep(),
        fld(tr("imgedit.ruota"), () => tf.rot * 180 / Math.PI, v => (tf.rot = v * Math.PI / 180), "°", 0.1),
        el("span", { class: "grow" }), oBtn("cancel", tr("imgedit.annulla_trasformazione_esc"), cancelTransform), oBtn("check", tr("imgedit.conferma_trasformazione_invio"), () => commitTransform()));
      return;
    }
    switch (t) {
      case "move":
        optBar.append(oCheck(opt.move, "auto", tr("imgedit.selezione_automatica_livello_ctrl_clic")), oCheck(opt.move, "ctrls", tr("imgedit.mostra_controlli_trasformazione"), schedule), oSep(),
          el("button", { class: "btn", type: "button", onclick: () => beginTransform() }, tr("imgedit.trasformazione_libera_ctrl_t")));
        break;
      case "marqueeRect": case "marqueeEllipse": case "lasso": case "lassoPoly":
        optBar.append(...selModeBtns(), oSep(), oNum(opt.sel, "feather", 0, 250, tr("imgedit.sfuma_2"), "px"));
        if (t === "lassoPoly") optBar.append(oSep(), el("span", { class: "ps-note" }, tr("imgedit.clic_i_vertici_doppio_clic")));
        break;
      case "wand":
        optBar.append(...selModeBtns(), oSep(), oNum(opt.wand, "tol", 0, 255, tr("imgedit.tolleranza")), oCheck(opt.wand, "contig", tr("imgedit.contigui")), oCheck(opt.wand, "all", tr("imgedit.campiona_tutti_i_livelli")));
        break;
      case "crop":
        optBar.append(oSelect(opt.crop, "ratio", [["free", tr("imgedit.proporzioni_libere")], ["orig", tr("imgedit.proporzioni_originali")], ["1:1", tr("imgedit.1_1_quadrato")], ["4:3", "4 : 3"], ["3:2", "3 : 2"], ["16:9", "16 : 9"], ["3:4", "3 : 4"], ["2:3", "2 : 3"], ["9:16", "9 : 16"]], "", () => { startCrop(); }),
          oSep(), oCheck(opt.crop, "del", tr("imgedit.elimina_pixel_ritagliati")), el("span", { class: "grow" }),
          oBtn("cancel", tr("imgedit.annulla_ritaglio_esc"), cancelCrop), oBtn("check", tr("imgedit.conferma_ritaglio_invio"), applyCrop));
        break;
      case "eyedropper":
        optBar.append(oSelect(opt.eyedropper, "size", [[1, tr("imgedit.campione_puntiforme")], [3, tr("imgedit.media_3_x_3")], [5, tr("imgedit.media_5_x_5")], [11, tr("imgedit.media_11_x_11")]], tr("imgedit.dimensione_campione"), () => (opt.eyedropper.size = +opt.eyedropper.size)),
          oSelect({ v: opt.eyedropper.all ? "all" : "cur" }, "v", [["all", tr("imgedit.tutti_i_livelli")], ["cur", tr("imgedit.livello_corrente")]], tr("imgedit.campione"), function () { opt.eyedropper.all = this?.v !== "cur"; }));
        optBar.lastChild.querySelector("select").addEventListener("change", e => (opt.eyedropper.all = e.target.value === "all"));
        optBar.append(oSep(), el("span", { class: "ps-note" }, tr("imgedit.clic_primo_piano_alt_clic")));
        break;
      case "brush": case "pencil": case "eraser": case "stamp": {
        const o = opt[t];
        optBar.append(oNum(o, "size", 1, 5000, tr("imgedit.dim"), "px"));
        if (t !== "pencil") { const hs = { v: Math.round(o.hard * 100) }; optBar.append(oNum(hs, "v", 0, 100, tr("imgedit.durezza"), "%", 1, () => (o.hard = hs.v / 100))); }
        optBar.append(oSep(), oNum(o, "opacity", 1, 100, tr("imgedit.opacita"), "%"));
        if (t !== "pencil") optBar.append(oNum(o, "flow", 1, 100, tr("imgedit.flusso"), "%"));
        if (t === "stamp") optBar.append(oSep(), oCheck(o, "aligned", tr("imgedit.allineato"), () => (cloneOff = null)), oSelect({ v: o.all ? "all" : "cur" }, "v", [["cur", tr("imgedit.livello_corrente")], ["all", tr("imgedit.tutti_i_livelli")]], tr("imgedit.campione")),
          el("span", { class: "ps-note" }, tr("imgedit.alt_clic_origine")));
        if (t === "stamp") optBar.querySelectorAll("select")[0].addEventListener("change", e => (o.all = e.target.value === "all"));
        break;
      }
      case "gradient": {
        const o = opt.gradient;
        optBar.append(oSelect(o, "kind", [["fgbg", tr("imgedit.primo_piano_sfondo")], ["fgtr", tr("imgedit.primo_piano_trasparente")]], ""),
          oBtn("gradient", tr("imgedit.sfumatura_lineare"), () => { o.type = "linear"; renderOptions(); }, o.type === "linear"),
          oBtn("marqueeEllipse", tr("imgedit.sfumatura_radiale"), () => { o.type = "radial"; renderOptions(); }, o.type === "radial"), oSep(),
          oCheck(o, "reverse", tr("imgedit.inverti")), oNum(o, "opacity", 1, 100, tr("imgedit.opacita"), "%"), el("span", { class: "ps-note" }, tr("imgedit.trascina_documento_maiusc_vincola_45")));
        break;
      }
      case "bucket":
        optBar.append(oNum(opt.bucket, "opacity", 1, 100, tr("imgedit.opacita"), "%"), oNum(opt.bucket, "tol", 0, 255, tr("imgedit.tolleranza")), oCheck(opt.bucket, "contig", tr("imgedit.contigui")), oCheck(opt.bucket, "all", tr("imgedit.tutti_i_livelli")));
        break;
      case "type": {
        const o = opt.type, apply = () => { if (textEd) { Object.assign(textEd.L.props, { font: o.font, size: o.size, bold: o.bold, italic: o.italic, align: o.align }); placeText(); } };
        if (textEd) Object.assign(o, { font: textEd.L.props.font, size: textEd.L.props.size, bold: textEd.L.props.bold, italic: textEd.L.props.italic, align: textEd.L.props.align });
        const style = { v: (o.bold ? "b" : "") + (o.italic ? "i" : "") || "n" };
        optBar.append(oSelect(o, "font", FONTS.map(f => [f, f]), "", apply),
          oSelect(style, "v", [["n", tr("imgedit.normale")], ["b", tr("imgedit.grassetto")], ["i", tr("imgedit.corsivo")], ["bi", tr("imgedit.grassetto_corsivo")]], "", () => { o.bold = style.v.includes("b"); o.italic = style.v.includes("i"); apply(); }),
          oNum(o, "size", 1, 2000, "", "px", 1, apply), oSep(),
          ...[["left", tr("imgedit.allinea_testo_sinistra")], ["center", tr("imgedit.testo_centro")], ["right", tr("imgedit.allinea_testo_destra")]].map(([a, ti]) => el("button", { class: "ps-obtn" + (o.align === a ? " on" : ""), type: "button", title: ti, onclick: () => { o.align = a; apply(); renderOptions(); } },
            el("span", { class: "ps-align ps-align-" + a }, el("i"), el("i"), el("i")))),
          oSep(), el("span", { class: "ps-note" }, textEd ? tr("imgedit.ctrl_invio_esc_confermare") : tr("imgedit.clic_documento_scrivere_clic_testo")));
        if (textEd) optBar.append(el("span", { class: "grow" }), oBtn("cancel", tr("imgedit.annulla_modifiche_esc"), () => endText(false)), oBtn("check", tr("imgedit.conferma_ctrl_invio"), () => endText(true)));
        break;
      }
      case "shapeRect": case "shapeRound": case "shapeEllipse": case "shapeLine": {
        const o = opt.shape;
        if (t === "shapeLine") optBar.append(oNum(o, "sw", 1, 500, tr("imgedit.spessore"), "px"), el("span", { class: "ps-note" }, tr("imgedit.colore_primo_piano_maiusc_vincola")));
        else {
          const sc = el("input", { type: "color", value: o.color2, class: "ps-ocolor", title: tr("imgedit.colore_traccia") }); sc.addEventListener("input", () => (o.color2 = sc.value));
          optBar.append(oCheck(o, "fill", tr("imgedit.riempimento_primo_piano")), oSep(), oCheck(o, "stroke", tr("imgedit.traccia_2")), sc, oNum(o, "sw", 1, 500, "", "px"));
          if (t === "shapeRound") optBar.append(oSep(), oNum(o, "r", 0, 2000, tr("imgedit.raggio"), "px"));
          optBar.append(oSep(), el("span", { class: "ps-note" }, tr("imgedit.maiusc_proporzioni_bloccate_alt_centro")));
        }
        break;
      }
      case "hand": optBar.append(el("button", { class: "btn", type: "button", onclick: () => setZoom(1) }, "100%"), el("button", { class: "btn", type: "button", onclick: () => fit(true) }, tr("imgedit.adatta_allo_schermo"))); break;
      case "zoom":
        optBar.append(oBtn("zoom", tr("imgedit.zoom_avanti"), () => zoomStep(1)), el("button", { class: "btn", type: "button", onclick: () => zoomStep(-1) }, tr("imgedit.zoom_indietro")), oSep(),
          el("button", { class: "btn", type: "button", onclick: () => setZoom(1) }, "100%"), el("button", { class: "btn", type: "button", onclick: () => fit(true) }, tr("imgedit.adatta_allo_schermo")),
          el("span", { class: "ps-note" }, tr("imgedit.clic_ingrandisci_alt_clic_riduci")));
        break;
    }
  }

  // ------------------------------------------------------------ pannelli a destra
  const dock = (tabs) => {
    const head = el("div", { class: "ps-dock-h" }), body = el("div", { class: "ps-dock-b" }), d = el("div", { class: "ps-dock" }, head, body);
    const pages = {};
    let curTab = tabs[0][0];
    tabs.forEach(([id, label]) => {
      const b = el("button", { type: "button", class: "ps-dtab", onclick: () => show(id) }, label);
      head.append(b);
      pages[id] = { b, page: el("div", { class: "ps-page" }) };
      body.append(pages[id].page);
    });
    const show = id => { curTab = id; Object.entries(pages).forEach(([k, v]) => { v.page.hidden = k !== id; v.b.classList.toggle("on", k === id); }); };
    show(curTab);
    return { d, pages: Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, v.page])), show, head };
  };
  const d1 = dock([["props", tr("imgedit.proprieta")], ["adjust", tr("imgedit.regolazioni")], ["hist", tr("imgedit.cronologia")]]);
  const d2 = dock([["layers", tr("imgedit.livelli")]]);
  panels.append(d1.d, d2.d);
  const dock1Show = id => { panels.hidden = false; root.classList.remove("ps-nopanels"); d1.show(id); };

  // --- Livelli
  const blendSelect = v => {
    const s = el("select", { class: "field ps-sel" });
    for (const b of BLENDS) s.append(b ? el("option", { value: b[0] }, b[1]) : el("option", { disabled: true }, "──────────"));
    s.value = v;
    return s;
  };
  const lyBlend = blendSelect("source-over");
  const lyOpacity = el("input", { type: "number", class: "ps-num", min: 0, max: 100 });
  const lyList = el("div", { class: "ps-lylist" });
  lyBlend.addEventListener("change", () => { const L = cur(); if (L) { L.blend = lyBlend.value; invalidate(); commit(tr("imgedit.metodo_fusione")); } });
  lyOpacity.addEventListener("change", () => { const L = cur(); if (L) { L.opacity = clamp(Math.round(+lyOpacity.value), 0, 100); lyOpacity.value = L.opacity; invalidate(); commit(tr("imgedit.opacita_livello")); } });
  const lyBottom = el("div", { class: "ps-lybar" },
    el("button", { type: "button", class: "ps-lyb", title: tr("imgedit.aggiungi_maschera_livello_alt_nascondi"), onclick: e => addMask(sel ? (e.altKey ? "hideSel" : "revealSel") : e.altKey ? "hide" : "reveal") }, psIcon("mask", 16)),
    el("button", { type: "button", class: "ps-lyb", title: tr("imgedit.crea_nuovo_livello_riempimento_regolazione"), onclick: e => openMenu(e.currentTarget, Object.entries(ADJ).map(([k, a]) => ({ label: a.name + "...", run: () => addAdjustLayer(k) })), "up") }, psIcon("adjust", 16)),
    el("button", { type: "button", class: "ps-lyb", title: tr("imgedit.crea_nuovo_livello_ctrl_maiusc"), onclick: () => addLayer() }, psIcon("newLayer", 16)),
    el("button", { type: "button", class: "ps-lyb", title: tr("imgedit.elimina_livello"), onclick: () => deleteLayer() }, psIcon("trash", 16)));
  d2.pages.layers.append(el("div", { class: "ps-lyhead" }, lyBlend, el("label", { class: "ps-ofield" }, oLabel(tr("imgedit.opacita")), lyOpacity, el("span", { class: "ps-unit" }, "%"))), lyList, lyBottom);
  const thumbs = new Map();
  function drawThumb(cv, L, mask) {
    const g = g2(cv), tw = cv.width, th = cv.height, s = Math.min(tw / W, th / H), ox = (tw - W * s) / 2, oy = (th - H * s) / 2;
    g.clearRect(0, 0, tw, th);
    if (mask) { g.fillStyle = "#000"; g.fillRect(ox, oy, W * s, H * s); g.drawImage(L.mask.c, ox + L.mask.x * s, oy + L.mask.y * s, L.mask.c.width * s, L.mask.c.height * s); return; }
    g.fillStyle = g.createPattern(checker, "repeat"); g.fillRect(ox, oy, W * s, H * s);
    if (L.c) { g.save(); g.beginPath(); g.rect(ox, oy, W * s, H * s); g.clip(); g.drawImage(L.c, ox + L.x * s, oy + L.y * s, L.c.width * s, L.c.height * s); g.restore(); }
  }
  let thumbT = 0;
  const thumbsLater = () => { clearTimeout(thumbT); thumbT = setTimeout(() => thumbs.forEach((f) => f()), 180); };
  let dragRow = -1;
  function renderLayers() {
    lyList.innerHTML = ""; thumbs.clear();
    const L0 = cur();
    if (L0) { lyBlend.value = L0.blend; lyOpacity.value = L0.opacity; }
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i], on = i === act;
      const eye = el("button", { type: "button", class: "ps-eye" + (L.visible ? "" : " off"), title: tr("imgedit.mostra_nascondi_alt_clic_solo") }, L.visible ? psIcon("eye", 15) : "");
      eye.addEventListener("click", e => {
        e.stopPropagation();
        if (e.altKey) { const solo = layers.every((l, j) => j === i || !l.visible); layers.forEach((l, j) => (l.visible = solo || j === i)); }
        else L.visible = !L.visible;
        invalidate(); commit(L.visible ? tr("imgedit.mostra_livello") : tr("imgedit.nascondi_livello"));
      });
      let th;
      if (L.kind === "adjust") th = el("span", { class: "ps-thumb ps-thumb-adj", title: ADJ[L.props.type]?.name }, psIcon(ADJ[L.props.type]?.icon || "adjust", 18));
      else if (L.kind === "text") th = el("span", { class: "ps-thumb ps-thumb-adj", title: tr("imgedit.livello_testo") }, el("b", {}, "T"));
      else { th = el("canvas", { class: "ps-thumb", width: 40, height: 30 }); const cv = th; thumbs.set(L.id, () => drawThumb(cv, L, false)); drawThumb(cv, L, false); }
      th.classList.toggle("tgt", on && target === "pixels");
      th.addEventListener("click", e => {
        e.stopPropagation();
        if (e.ctrlKey) return selFromLayer(L); // Ctrl+clic sulla miniatura: carica la trasparenza come selezione
        selectLayer(i, L.kind === "adjust" && L.mask ? "mask" : "pixels");
      });
      const row = el("div", { class: "ps-ly" + (on ? " on" : "") + (L.visible ? "" : " hid"), draggable: "true" }, eye, th);
      if (L.mask) {
        const mc = el("canvas", { class: "ps-thumb ps-mthumb" + (on && target === "mask" ? " tgt" : "") + (L.mask.on ? "" : " off"), width: 40, height: 30, title: tr("imgedit.maschera_maiusc_clic_disattiva_alt") });
        drawThumb(mc, L, true); const id = L.id; thumbs.set(id + ":m", () => drawThumb(mc, L, true));
        mc.addEventListener("click", e => {
          e.stopPropagation();
          if (e.shiftKey) { selectLayer(i, "mask"); return maskOp("toggle"); }
          if (e.altKey) { selectLayer(i, "mask"); maskView = !maskView; schedule(); return; }
          if (e.ctrlKey) { const c = mkCanvas(W, H); g2(c).drawImage(L.mask.c, L.mask.x, L.mask.y); sel = makeSel(c); invalidate(); return commit(tr("imgedit.carica_selezione")); }
          selectLayer(i, "mask");
        });
        row.append(el("span", { class: "ps-chain" }, psIcon("link", 11)), mc);
      }
      const nm = el("span", { class: "ps-lyname", title: L.name }, L.name);
      nm.addEventListener("dblclick", e => { e.stopPropagation(); renameLayer(L); });
      row.append(nm);
      if (L.kind === "text" || L.kind === "shape") row.append(el("span", { class: "ps-lytag" }, L.kind === "text" ? "T" : "◆"));
      row.addEventListener("click", () => selectLayer(i));
      row.addEventListener("dblclick", () => { if (L.kind === "adjust") dock1Show("props"); else if (L.kind === "text") { selectTool("type"); startText(L, false); } });
      row.addEventListener("dragstart", e => { dragRow = i; e.dataTransfer.effectAllowed = "move"; });
      row.addEventListener("dragover", e => { if (dragRow >= 0) { e.preventDefault(); row.classList.add("drop"); } });
      row.addEventListener("dragleave", () => row.classList.remove("drop"));
      row.addEventListener("drop", e => { e.preventDefault(); row.classList.remove("drop"); if (dragRow >= 0 && dragRow !== i) { act = dragRow; moveLayer(i); } dragRow = -1; });
      row.addEventListener("dragend", () => (dragRow = -1));
      lyList.append(row);
    }
  }

  // --- Proprieta'
  function renderProps() {
    const P = d1.pages.props;
    P.innerHTML = "";
    const L = cur();
    const sec = (title, ...kids) => el("div", { class: "ps-sec" }, el("div", { class: "ps-sec-h" }, title), ...kids);
    const btn = (label, fn, title) => el("button", { class: "btn", type: "button", onclick: fn, title }, label);
    if (L?.kind === "adjust") {
      let t = 0;
      const H_ = () => { const i = layers.indexOf(L), c = mkCanvas(W, H), g = g2(c); for (let j = 0; j < i; j++) renderLayer(g, layers[j]); return histogram(readData(c).data); };
      let hc = null;
      P.append(sec(ADJ[L.props.type].name, adjustControls(L.props.type, L.props.p, () => { invalidate(); clearTimeout(t); t = setTimeout(() => commit(tr("imgedit.modifica") + ADJ[L.props.type].name), 500); }, () => (hc ||= H_())),
        el("div", { class: "ps-row" }, btn(tr("imgedit.ripristina_predefiniti"), () => { L.props.p = ADJ[L.props.type].def(); invalidate(); commit(tr("imgedit.ripristina")); renderProps(); }))));
    } else if (L?.kind === "text") {
      const p = L.props, upd = () => { renderText(L); invalidate(); clearTimeout(upd.t); upd.t = setTimeout(() => commit(tr("imgedit.modifica_testo")), 400); };
      const ta = el("textarea", { class: "field ps-ta", rows: 3 }); ta.value = p.text; ta.addEventListener("input", () => { p.text = ta.value; L.name = p.text.split("\n")[0].slice(0, 30) || tr("imgedit.testo"); upd(); });
      const font = el("select", { class: "field ps-sel" }, ...FONTS.map(f => el("option", { value: f }, f))); font.value = p.font; font.addEventListener("change", () => { p.font = font.value; upd(); });
      const col = el("input", { type: "color", class: "ps-ocolor", value: p.color }); col.addEventListener("input", () => { p.color = col.value; upd(); });
      const n = (label, key, min, max, step = 1) => { const i = el("input", { type: "number", class: "ps-num", min, max, step, value: p[key] }); i.addEventListener("change", () => { p[key] = clamp(+i.value, min, max); upd(); }); return el("label", { class: "ps-row" }, el("span", { class: "ps-lab2" }, label), i); };
      const ck = (label, key) => { const c = el("input", { type: "checkbox" }); c.checked = !!p[key]; c.addEventListener("change", () => { p[key] = c.checked; upd(); }); return el("label", { class: "ps-check" }, c, label); };
      const al = el("select", { class: "field ps-sel" }, el("option", { value: "left" }, tr("imgedit.sinistra")), el("option", { value: "center" }, tr("imgedit.centro_2")), el("option", { value: "right" }, tr("imgedit.destra"))); al.value = p.align; al.addEventListener("change", () => { p.align = al.value; upd(); });
      P.append(sec(tr("imgedit.testo"), ta, el("label", { class: "ps-row" }, el("span", { class: "ps-lab2" }, tr("imgedit.carattere")), font), n(tr("imgedit.dimensione_px"), "size", 1, 2000), n(tr("imgedit.interlinea"), "lead", 0.5, 4, 0.05),
        el("div", { class: "ps-row" }, ck(tr("imgedit.grassetto"), "bold"), ck(tr("imgedit.corsivo"), "italic")), el("label", { class: "ps-row" }, el("span", { class: "ps-lab2" }, tr("imgedit.allineamento")), al),
        el("label", { class: "ps-row" }, el("span", { class: "ps-lab2" }, tr("imgedit.colore")), col), el("div", { class: "ps-row" }, btn(tr("imgedit.rasterizza_testo"), () => rasterize(L)))));
    } else if (L?.kind === "shape") {
      const p = L.props, upd = () => { renderShape(L); invalidate(); clearTimeout(upd.t); upd.t = setTimeout(() => commit(tr("imgedit.modifica_forma")), 400); };
      const n = (label, key, min = -1e5, max = 1e5) => { const i = el("input", { type: "number", class: "ps-num", value: Math.round(p[key]) }); i.addEventListener("change", () => { p[key] = clamp(+i.value, min, max); upd(); }); return el("label", { class: "ps-row" }, el("span", { class: "ps-lab2" }, label), i, el("span", { class: "ps-unit" }, "px")); };
      const colRow = (label, key, def) => {
        const c = el("input", { type: "checkbox" }); c.checked = !!p[key];
        const col = el("input", { type: "color", class: "ps-ocolor", value: p[key] || def });
        c.addEventListener("change", () => { p[key] = c.checked ? col.value : null; upd(); }); col.addEventListener("input", () => { if (c.checked) { p[key] = col.value; upd(); } });
        return el("label", { class: "ps-row" }, c, el("span", { class: "ps-lab2" }, label), col);
      };
      if (p.type === "line") {
        const col = el("input", { type: "color", class: "ps-ocolor", value: p.color2 || "#000000" }); col.addEventListener("input", () => { p.color2 = col.value; upd(); });
        P.append(sec(tr("imgedit.linea"), n("X1:", "x1"), n("Y1:", "y1"), n("X2:", "x2"), n("Y2:", "y2"), n(tr("imgedit.spessore"), "sw", 1, 500), el("label", { class: "ps-row" }, el("span", { class: "ps-lab2" }, tr("imgedit.colore")), col), el("div", { class: "ps-row" }, btn(tr("imgedit.rasterizza_forma"), () => rasterize(L)))));
      } else {
        P.append(sec(tr("imgedit.forma"), n("X:", "x"), n("Y:", "y"), n("L:", "w", 1), n("A:", "h", 1), p.type === "round" ? n(tr("imgedit.raggio"), "r", 0) : null,
          colRow(tr("imgedit.riempimento"), "fill", fg), colRow(tr("imgedit.traccia"), "stroke", "#000000"), n(tr("imgedit.spessore_traccia"), "sw", 1, 500), el("div", { class: "ps-row" }, btn(tr("imgedit.rasterizza_forma"), () => rasterize(L)))));
      }
    } else if (L) {
      const pos = (label, get, set) => { const i = el("input", { type: "number", class: "ps-num", value: get() }); i.addEventListener("change", () => { set(Math.round(+i.value)); invalidate(); commit(tr("imgedit.sposta")); }); return el("label", { class: "ps-row" }, el("span", { class: "ps-lab2" }, label), i, el("span", { class: "ps-unit" }, "px")); };
      P.append(sec(tr("imgedit.livello_pixel"),
        el("div", { class: "ps-grid2" },
          pos("X:", () => L.x, v => { const d = v - L.x; L.x = v; if (L.mask) L.mask = { ...L.mask, x: L.mask.x + d }; }),
          pos("Y:", () => L.y, v => { const d = v - L.y; L.y = v; if (L.mask) L.mask = { ...L.mask, y: L.mask.y + d }; }),
          el("label", { class: "ps-row" }, el("span", { class: "ps-lab2" }, "L:"), el("span", {}, (L.c?.width || 0) + " px")), el("label", { class: "ps-row" }, el("span", { class: "ps-lab2" }, "A:"), el("span", {}, (L.c?.height || 0) + " px"))),
        el("div", { class: "ps-row ps-icons" },
          oBtn("rotate", tr("imgedit.ruota_90_senso_orario"), () => layerXform("cw")), el("button", { class: "ps-obtn", type: "button", title: tr("imgedit.ruota_90_senso_antiorario"), onclick: () => layerXform("ccw") }, el("span", { class: "ps-flipx" }, psIcon("rotate", 18))),
          oBtn("flipH", tr("imgedit.rifletti_orizzontale"), () => layerXform("fh")), oBtn("flipV", tr("imgedit.rifletti_verticale"), () => layerXform("fv")),
          el("button", { class: "btn", type: "button", onclick: () => beginTransform() }, tr("imgedit.trasforma_ctrl_t")))));
    }
    if (L?.mask) {
      P.append(sec(tr("imgedit.maschera_livello"), el("p", { class: "ps-note" }, target === "mask" ? tr("imgedit.stai_modificando_maschera_nero_nasconde") : tr("imgedit.clic_miniatura_maschera_dipingerla")),
        el("div", { class: "ps-row ps-wrap" }, btn(tr("imgedit.inverti"), () => maskOp("invert")), btn(L.mask.on ? tr("imgedit.disattiva") : tr("imgedit.attiva"), () => maskOp("toggle")),
          L.kind !== "adjust" ? btn(tr("common.applica"), () => maskOp("apply")) : null, btn(tr("common.elimina"), () => maskOp("delete")), btn(tr("imgedit.seleziona"), () => { const c = mkCanvas(W, H); g2(c).drawImage(L.mask.c, L.mask.x, L.mask.y); sel = makeSel(c); invalidate(); commit(tr("imgedit.carica_selezione")); }))));
    } else if (L) P.append(sec(tr("imgedit.maschera_livello"), el("div", { class: "ps-row ps-wrap" }, btn(tr("imgedit.aggiungi_maschera"), () => addMask(sel ? "revealSel" : "reveal")), btn(tr("imgedit.maschera_nera"), () => addMask(sel ? "hideSel" : "hide")))));
    P.append(sec(tr("imgedit.documento"), el("p", { class: "ps-note" }, tr("imgedit.0_1_pixel", W, H) + " · " + tn("imgedit.n_livelli", layers.length)),
      el("div", { class: "ps-row ps-wrap" }, btn(tr("imgedit.dimensione_immagine_2"), dlgImageSize), btn(tr("imgedit.dimensione_quadro_2"), dlgCanvasSize), btn(tr("imgedit.rifila"), trimTransparent, tr("imgedit.taglia_i_bordi_trasparenti")))));
  }

  // --- Regolazioni
  function renderAdjustPanel() {
    const P = d1.pages.adjust;
    P.innerHTML = "";
    P.append(el("div", { class: "ps-sec-h" }, tr("imgedit.aggiungi_regolazione")));
    const g = el("div", { class: "ps-adjgrid" });
    for (const [k, a] of Object.entries(ADJ)) g.append(el("button", { type: "button", class: "ps-adjbtn", title: a.name, onclick: () => addAdjustLayer(k) }, psIcon(a.icon, 22)));
    P.append(g, el("p", { class: "ps-note" }, tr("imgedit.crea_livello_regolazione_non_distruttivo")));
  }
  // --- Cronologia
  function renderHistory() {
    const P = d1.pages.hist;
    P.innerHTML = "";
    history.forEach((h, i) => P.append(el("button", { type: "button", class: "ps-hrow" + (i === hi ? " on" : "") + (i > hi ? " future" : ""), onclick: () => { if (i !== hi) { hi = i; restore(h.s); renderHistory(); } } }, h.name)));
    P.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }
  function refreshPanels() { renderLayers(); renderProps(); renderHistory(); status(); }

  // ------------------------------------------------------------ menu (come la barra dei menu di Photoshop)
  let menuEl = null;
  function closeMenu() { menuEl?.remove(); menuEl = null; document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", menuKey, true); }
  const menuKey = e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); } };
  const outside = e => { if (menuEl && !menuEl.contains(e.target) && !e.target.closest?.(".ps-mbtn")) closeMenu(); };
  function buildMenu(items, sub) {
    const m = el("div", { class: "ps-menu" + (sub ? " sub" : "") });
    for (const it of items) {
      if (it === "-") { m.append(el("div", { class: "ps-msep" })); continue; }
      const dis = it.disabled?.();
      const b = el("button", { type: "button", class: "ps-mit" + (it.sub ? " has-sub" : ""), disabled: dis }, el("span", { class: "ps-mchk" }, it.checked?.() ? "✓" : ""), el("span", { class: "ps-mlab" }, it.label), el("span", { class: "ps-mkey" }, it.sub ? "▸" : prettyKeys(it.keys)));
      if (it.sub) {
        let sm = null;
        b.addEventListener("pointerenter", () => {
          m.querySelectorAll(".ps-menu.sub").forEach(x => x.remove());
          sm = buildMenu(it.sub(), true); m.append(sm);
          sm.style.top = b.offsetTop - 4 + "px";
        });
      } else {
        b.addEventListener("pointerenter", () => m.querySelectorAll(":scope > .ps-menu.sub").forEach(x => x.remove()));
        b.addEventListener("click", () => { closeMenu(); it.run(); });
      }
      m.append(b);
    }
    return m;
  }
  function openMenu(anchor, items, dir) {
    closeMenu();
    menuEl = buildMenu(items);
    document.body.append(menuEl);
    const r = anchor.getBoundingClientRect();
    menuEl.style.left = Math.min(r.left, innerWidth - 260) + "px";
    if (dir === "up") menuEl.style.bottom = innerHeight - r.top + 2 + "px"; else menuEl.style.top = r.bottom + 2 + "px";
    setTimeout(() => document.addEventListener("pointerdown", outside, true));
    document.addEventListener("keydown", menuKey, true);
  }
  const prettyKeys = k => (k ? k.split("|")[0].replace(/Shift/g, "Maiusc").replace(/Escape/g, "Esc").replace(/Delete/g, "Canc").replace(/Plus/g, "+").replace(/Minus/g, "-") : "");
  const noSel = () => !sel, noLayer = () => !cur(), noMask = () => !cur()?.mask;
  const adjItems = () => [...Object.entries(ADJ).map(([k, a]) => ({ label: a.name + (k === "invert" ? "" : "..."), keys: a.keys, run: () => runAdjust(k) })),
    "-", { label: tr("imgedit.togli_saturazione"), keys: "Ctrl+Shift+U", run: () => quickAdjust("desaturate") }];
  const MENUS = {
    Modifica: () => [
      { label: tr("common.annulla_op") + (hi > 0 ? " " + history[hi].name : ""), keys: "Ctrl+Z", run: undo, disabled: () => hi <= 0 },
      { label: tr("common.ripeti"), keys: "Ctrl+Shift+Z", run: redo, disabled: () => hi >= history.length - 1 },
      { label: tr("imgedit.alterna_ultimo_stato"), keys: "Ctrl+Alt+Z", run: toggleLast }, "-",
      { label: tr("common.taglia"), keys: "Ctrl+X", run: () => copy(false, true) }, { label: tr("common.copia"), keys: "Ctrl+C", run: () => copy(false) },
      { label: tr("imgedit.copia_unione"), keys: "Ctrl+Shift+C", run: () => copy(true) }, { label: tr("common.incolla"), keys: "Ctrl+V", run: () => (clip ? pasteCanvas(cloneC(clip.c), clip.x, clip.y) : toast(tr("imgedit.usa_ctrl_v_incollare_dagli"), false)) },
      { label: tr("imgedit.cancella"), keys: "Delete", run: clearSel, disabled: noSel }, "-",
      { label: tr("imgedit.riempi_2"), keys: "Shift+F5", run: dlgFill }, { label: tr("imgedit.traccia_3"), run: dlgStroke, disabled: noSel }, "-",
      { label: tr("imgedit.trasformazione_libera"), keys: "Ctrl+T", run: () => beginTransform() },
      { label: tr("imgedit.trasforma"), sub: () => [{ label: tr("imgedit.ruota_180_2"), run: () => layerXform("180") }, { label: tr("imgedit.ruota_90_senso_orario_2"), run: () => layerXform("cw") }, { label: tr("imgedit.ruota_90_senso_antiorario_2"), run: () => layerXform("ccw") }, "-",
        { label: tr("imgedit.rifletti_orizzontale"), run: () => layerXform("fh") }, { label: tr("imgedit.rifletti_verticale"), run: () => layerXform("fv") }] },
    ],
    Immagine: () => [
      { label: tr("imgedit.regolazioni"), sub: adjItems }, "-",
      { label: tr("imgedit.tono_automatico"), keys: "Ctrl+Shift+L", run: () => quickAdjust("tone") }, { label: tr("imgedit.contrasto_automatico"), keys: "Ctrl+Alt+Shift+L", run: () => quickAdjust("contrast") },
      { label: tr("imgedit.colore_automatico"), keys: "Ctrl+Shift+B", run: () => quickAdjust("color") }, "-",
      { label: tr("imgedit.dimensione_immagine_2"), keys: "Ctrl+Alt+I", run: dlgImageSize }, { label: tr("imgedit.dimensione_quadro_2"), keys: "Ctrl+Alt+C", run: dlgCanvasSize },
      { label: tr("imgedit.rotazione_immagine"), sub: () => [{ label: "180°", run: () => rotateDoc("180") }, { label: tr("imgedit.90_senso_orario"), run: () => rotateDoc("cw") }, { label: tr("imgedit.90_senso_antiorario"), run: () => rotateDoc("ccw") },
        { label: tr("imgedit.arbitraria"), run: dlgRotate }, "-", { label: tr("imgedit.rifletti_quadro_orizzontale"), run: () => rotateDoc("fh") }, { label: tr("imgedit.rifletti_quadro_verticale"), run: () => rotateDoc("fv") }] },
      { label: tr("imgedit.ritaglia"), run: () => cropDoc(sel.bounds), disabled: noSel }, { label: tr("imgedit.rifila_bordi_trasparenti"), run: trimTransparent }, "-",
      { label: tr("imgedit.informazioni_immagine_2"), run: showInfo },
    ],
    Livello: () => [
      { label: tr("imgedit.nuovo"), sub: () => [{ label: tr("imgedit.livello_2"), keys: "Ctrl+Shift+N", run: dlgNewLayer }, { label: tr("imgedit.livello_tramite_copia"), keys: "Ctrl+J", run: () => layerVia(false) }, { label: tr("imgedit.livello_tramite_taglio"), keys: "Ctrl+Shift+J", run: () => layerVia(true) }] },
      { label: tr("imgedit.duplica_livello"), run: duplicateLayer, disabled: noLayer }, { label: tr("imgedit.elimina_livello"), run: deleteLayer, disabled: () => layers.length < 2 },
      { label: tr("imgedit.rinomina_livello_2"), run: () => renameLayer(cur()), disabled: noLayer }, "-",
      { label: tr("imgedit.nuovo_livello_regolazione"), sub: () => Object.entries(ADJ).map(([k, a]) => ({ label: a.name + "...", run: () => addAdjustLayer(k) })) },
      { label: tr("imgedit.inserisci_immagine_come_livello"), run: async () => { const ps = await pickFiles(); for (const p of ps || []) await placeImage(p); } }, "-",
      { label: tr("imgedit.maschera_livello"), sub: () => [{ label: tr("imgedit.mostra_tutto"), run: () => addMask("reveal"), disabled: () => !!cur()?.mask }, { label: tr("imgedit.nascondi_tutto"), run: () => addMask("hide"), disabled: () => !!cur()?.mask },
        { label: tr("imgedit.mostra_selezione"), run: () => addMask("revealSel"), disabled: () => !sel || !!cur()?.mask }, { label: tr("imgedit.nascondi_selezione"), run: () => addMask("hideSel"), disabled: () => !sel || !!cur()?.mask }, "-",
        { label: tr("common.elimina"), run: () => maskOp("delete"), disabled: noMask }, { label: tr("common.applica"), run: () => maskOp("apply"), disabled: noMask },
        { label: cur()?.mask?.on === false ? tr("imgedit.attiva") : tr("imgedit.disattiva"), run: () => maskOp("toggle"), disabled: noMask }, { label: tr("imgedit.inverti"), run: () => maskOp("invert"), disabled: noMask }] },
      { label: tr("imgedit.rasterizza"), run: () => rasterize(cur()), disabled: () => !["text", "shape"].includes(cur()?.kind) }, "-",
      { label: tr("imgedit.disponi"), sub: () => [{ label: tr("imgedit.porta_primo_piano"), keys: "Ctrl+Shift+]", run: () => moveLayer(layers.length - 1) }, { label: tr("imgedit.porta_avanti"), keys: "Ctrl+]", run: () => moveLayer(act + 1) },
        { label: tr("imgedit.porta_indietro"), keys: "Ctrl+[", run: () => moveLayer(act - 1) }, { label: tr("imgedit.porta_sotto"), keys: "Ctrl+Shift+[", run: () => moveLayer(0) }] }, "-",
      { label: tr("imgedit.unisci_sotto"), keys: "Ctrl+E", run: mergeDown, disabled: () => act < 1 }, { label: tr("imgedit.unisci_visibili"), keys: "Ctrl+Shift+E", run: () => mergeVisible(false) },
      { label: tr("imgedit.unico_livello"), run: () => mergeVisible(true) },
    ],
    Seleziona: () => [
      { label: tr("imgedit.tutto"), keys: "Ctrl+A", run: selectAll }, { label: tr("imgedit.deseleziona"), keys: "Ctrl+D", run: deselect, disabled: noSel },
      { label: tr("imgedit.riseleziona"), keys: "Ctrl+Shift+D", run: reselect, disabled: () => !lastSel }, { label: tr("imgedit.inversa"), keys: "Ctrl+Shift+I", run: invertSel }, "-",
      { label: tr("imgedit.carica_selezione_livello"), run: () => selFromLayer(cur()), disabled: () => !cur()?.c },
      { label: tr("imgedit.modifica_2"), sub: () => [{ label: tr("imgedit.espandi_3"), run: () => dlgModifySel("expand") }, { label: tr("imgedit.contrai_3"), run: () => dlgModifySel("contract") }, { label: tr("imgedit.sfuma_3"), keys: "Shift+F6", run: () => dlgModifySel("feather") }], disabled: noSel },
    ],
    Filtro: () => {
      const groups = {};
      for (const [id, f] of Object.entries(FILTERS)) (groups[f.group] ||= []).push({ label: f.name, run: () => runFilter(id) });
      return [{ label: lastFilter ? tr("imgedit.ultimo_filtro") + FILTERS[lastFilter.id].name.replace("...", "") : tr("imgedit.ultimo_filtro_2"), keys: "Ctrl+Alt+F", run: () => lastFilter && runFilter(lastFilter.id, true), disabled: () => !lastFilter }, "-",
        ...Object.entries(groups).map(([g, items]) => ({ label: g, sub: () => items }))];
    },
    Visualizza: () => [
      { label: tr("imgedit.zoom_avanti"), keys: "Ctrl+Plus", run: () => zoomStep(1) }, { label: tr("imgedit.zoom_indietro"), keys: "Ctrl+Minus", run: () => zoomStep(-1) },
      { label: tr("imgedit.adatta_allo_schermo"), keys: "Ctrl+0", run: () => fit(true) }, { label: "100%", keys: "Ctrl+1", run: () => setZoom(1) }, "-",
      { label: tr("imgedit.extra_bordi_selezione"), keys: "Ctrl+H", run: () => { showExtras = !showExtras; schedule(); }, checked: () => showExtras },
    ],
    Finestra: () => [
      { label: tr("imgedit.livelli"), keys: "F7", run: togglePanels, checked: () => !panels.hidden },
      { label: tr("imgedit.proprieta"), run: () => dock1Show("props") }, { label: tr("imgedit.regolazioni"), run: () => dock1Show("adjust") }, { label: tr("imgedit.cronologia"), run: () => dock1Show("hist") }, "-",
      { label: tr("imgedit.mostra_nascondi_pannelli_strumenti"), keys: "Tab", run: toggleAll },
    ],
  };
  function togglePanels() { panels.hidden = !panels.hidden; root.classList.toggle("ps-nopanels", panels.hidden); schedule(); }
  function toggleAll() { root.classList.toggle("ps-full"); setTimeout(() => schedule(), 0); }
  for (const name of Object.keys(MENUS)) {
    const b = el("button", { class: "ps-mbtn", type: "button" }, tr("imgedit.menu_" + name.toLowerCase()));
    b.addEventListener("click", () => (menuEl && menuEl.dataset.m === name ? closeMenu() : (openMenu(b, MENUS[name]()), (menuEl.dataset.m = name))));
    b.addEventListener("pointerenter", () => { if (menuEl && menuEl.dataset.m && menuEl.dataset.m !== name) { openMenu(b, MENUS[name]()); menuEl.dataset.m = name; } });
    ctx.tb.append(b);
  }
  // annotazione a mano libera (penna, evidenziatore, gomma: ui/js/ink.js); "Fine" mette i tratti in un livello "Annotazioni"
  let ink = null;
  const inkBtn = button(tr("ink.penna"), INK_ICON, async () => {
    if (!ink) {
      const { createInk } = await import("./ink.js");
      ink = createInk({
        host: stage, nativeTouch: false,
        surfaces: () => [{ key: 0, el: stage, toDoc: (x, y) => [(x - panX) / zoom, (y - panY) / zoom], toLocal: (x, y) => [x * zoom + panX, y * zoom + panY] }],
        pan: (dx, dy) => { autoFit = false; panX += dx; panY += dy; placeText(); schedule(); },
        zoom: (f, cx, cy) => setZoom(zoom * f, cx, cy),
        onToggle: on => { inkBtn.classList.toggle("on", on); if (!on) inkToLayer(); },
      });
    }
    ink.toggle();
  }, { class: "ink-toggle ps-mbtn", title: tr("ink.annota_img") });
  ctx.tb.append(inkBtn);
  function inkToLayer() {
    if (!ink?.hasStrokes()) return;
    const c = mkCanvas(W, H), g = g2(c);
    for (const st of ink.strokes) paintInk(g, st, (x, y) => [x, y], 1);
    const L = mkLayer({ name: nameNew(tr("ink.livello_annotazioni")), c, x: 0, y: 0 });
    layers.splice(layers.length, 0, L); act = layers.length - 1; target = "pixels";
    ink.reset();
    invalidate(); commit(tr("ink.livello_annotazioni"));
  }

  // ------------------------------------------------------------ scorciatoie da tastiera di Photoshop
  const free = () => !dlgOpen && !textEd;
  const nudge = (dx, dy) => {
    if (tool !== "move" && !tf) return false;
    if (tf) { tf.cx += dx; tf.cy += dy; updateTfPreview(); return true; }
    const L = cur(); if (!L) return false;
    if (sel && L.c) { if (beginTransform(true)) { tf.cx += dx; tf.cy += dy; commitTransform(tr("imgedit.sposta")); } return true; }
    L.x += dx; L.y += dy; if (L.mask) L.mask = { ...L.mask, x: L.mask.x + dx, y: L.mask.y + dy };
    if (L.kind === "text") { L.props.x += dx; L.props.y += dy; }
    if (L.kind === "shape") { const P = L.props; if (P.type === "line") { P.x1 += dx; P.x2 += dx; P.y1 += dy; P.y2 += dy; } else { P.x += dx; P.y += dy; } }
    invalidate(); commit(tr("imgedit.sposta")); return true;
  };
  const setOpacityKey = n => {
    const v = n === 0 ? 100 : n * 10;
    if (PAINT.has(tool)) { opt[tool].opacity = v; renderOptions(); ctx.status(tr("imgedit.opacita_0", v)); }
    else if (tool === "gradient" || tool === "bucket") { opt[tool].opacity = v; renderOptions(); }
    else { const L = cur(); if (L) { L.opacity = v; invalidate(); commit(tr("imgedit.opacita_livello")); } }
  };
  const brushSize = f => { if (!PAINT.has(tool)) return; const o = opt[tool]; o.size = clamp(Math.round(f(o.size)), 1, 5000); tipCache.clear(); renderOptions(); schedule(); ctx.status(tr("imgedit.dimensione_pennello_0_px", o.size)); };
  const brushHard = d => { if (!PAINT.has(tool) || tool === "pencil") return; const o = opt[tool]; o.hard = clamp(Math.round((o.hard + d) * 4) / 4, 0, 1); tipCache.clear(); renderOptions(); ctx.status(`Durezza ${Math.round(o.hard * 100)}%`); };
  const defs = [];
  const K = (keys, desc, run, group, when = free) => defs.push({ keys, desc, run, group, when });
  for (const [letter, label] of [["V", tr("imgedit.sposta")], ["M", tr("imgedit.selezione_rettangolare_ellittica")], ["L", tr("imgedit.lazo_lazo_poligonale")], ["W", tr("imgedit.bacchetta_magica")], ["C", tr("imgedit.taglierina")], ["I", tr("imgedit.contagocce")],
    ["B", tr("imgedit.pennello_matita")], ["S", tr("imgedit.timbro_clone")], ["E", tr("imgedit.gomma")], ["G", tr("imgedit.sfumatura_secchiello")], ["T", tr("imgedit.testo")], ["U", tr("imgedit.rettangolo_ellisse_linea")], ["H", tr("imgedit.mano")], ["Z", tr("imgedit.zoom")]]) {
    K(letter, tr("imgedit.strumento") + label, () => toolKey(letter, false), tr("imgedit.strumenti"));
    if (GROUPS.find(g => TOOLS[g[0]].key === letter).length > 1) K("Shift+" + letter, tr("imgedit.strumento_successivo_gruppo") + letter, () => toolKey(letter, true), tr("imgedit.strumenti"));
  }
  K("Space", tr("imgedit.mano_temporanea_tieni_premuto"), () => {}, tr("imgedit.strumenti"), () => false);
  describeKeys(ctx, "Photoshop", [[tr("imgedit.spazio_tieni_premuto"), tr("imgedit.strumento_mano_temporaneo"), tr("imgedit.strumenti")], [tr("imgedit.alt_tieni_premuto"), tr("imgedit.contagocce_temporaneo_pennello_matita_sfumatura"), tr("imgedit.strumenti")],
    ["Alt+clic", tr("imgedit.timbro_clone_imposta_l_origine"), tr("imgedit.strumenti")], ["Maiusc+clic", tr("imgedit.pennello_gomma_linea_retta_dall"), tr("imgedit.strumenti")], ["Ctrl+clic", tr("imgedit.strumento_sposta_seleziona_livello_sotto"), tr("imgedit.strumenti")],
    [tr("imgedit.ctrl_clic_miniatura"), tr("imgedit.carica_trasparenza_livello_come_selezione"), tr("imgedit.livelli")], [tr("imgedit.alt_clic_sull_occhio"), tr("imgedit.mostra_solo_questo_livello"), tr("imgedit.livelli")],
    [tr("imgedit.alt_rotella_ctrl_rotella"), tr("imgedit.zoom_punto_puntatore"), tr("imgedit.vista")], ["Ctrl+V", tr("imgedit.incolla_come_nuovo_livello_anche"), tr("imgedit.modifica_2")]]);
  K("D", tr("imgedit.colori_predefiniti_nero_bianco"), defaultColors, tr("imgedit.colori"));
  K("X", tr("imgedit.inverti_primo_piano_sfondo"), swapColors, tr("imgedit.colori"));
  K("[|Ctrl+Alt+[", tr("imgedit.pennello_piu_piccolo"), () => brushSize(s => (s > 100 ? s * 0.9 : s - (s > 10 ? 5 : 1))), tr("imgedit.pennello"));
  K("]|Ctrl+Alt+]", tr("imgedit.pennello_piu_grande"), () => brushSize(s => (s >= 100 ? s * 1.1 : s + (s >= 10 ? 5 : 1))), tr("imgedit.pennello"));
  K("Shift+[", tr("imgedit.pennello_piu_morbido"), () => brushHard(-0.25), tr("imgedit.pennello"));
  K("Shift+]", tr("imgedit.pennello_piu_duro"), () => brushHard(0.25), tr("imgedit.pennello"));
  for (let n = 0; n <= 9; n++) K(String(n), n ? tr("imgedit.opacita_0", n * 10) : tr("imgedit.opacita_100"), () => setOpacityKey(n), tr("imgedit.pennello"));
  K("Enter", tr("imgedit.conferma_trasformazione_ritaglio_lazo_poligonale"), () => { if (tf) commitTransform(); else if (crop && tool === "crop") applyCrop(); else if (lassoPts.length) closePoly(); }, tr("imgedit.modifica_2"));
  K("Escape", tr("imgedit.annulla_trasformazione_ritaglio_lazo"), () => { if (menuEl) closeMenu(); else if (tf) cancelTransform(); else if (crop && tool === "crop") cancelCrop(); else if (lassoPts.length) { lassoPts = []; schedule(); } else if (maskView) { maskView = false; schedule(); } }, tr("imgedit.modifica_2"));
  K("Ctrl+Z", tr("common.annulla_op"), undo, tr("imgedit.modifica_2"));
  K("Ctrl+Shift+Z", tr("common.ripeti"), redo, tr("imgedit.modifica_2"));
  K("Ctrl+Alt+Z", tr("imgedit.alterna_ultimo_stato"), toggleLast, tr("imgedit.modifica_2"));
  K("Ctrl+X", tr("common.taglia"), () => copy(false, true), tr("imgedit.modifica_2"));
  K("Ctrl+C", tr("common.copia"), () => copy(false), tr("imgedit.modifica_2"));
  K("Ctrl+Shift+C", tr("imgedit.copia_unione"), () => copy(true), tr("imgedit.modifica_2"));
  K("Delete|Backspace", tr("imgedit.cancella_selezione"), () => { if (lassoPts.length > 1) { lassoPts.pop(); schedule(); } else clearSel(); }, tr("imgedit.modifica_2"));
  K("Alt+Backspace|Alt+Delete", tr("imgedit.riempi_colore_primo_piano"), () => fillWith(fg, 100, tr("imgedit.riempi")), tr("imgedit.modifica_2"));
  K("Ctrl+Backspace|Ctrl+Delete", tr("imgedit.riempi_colore_sfondo"), () => fillWith(bg, 100, tr("imgedit.riempi")), tr("imgedit.modifica_2"));
  K("Shift+F5", tr("imgedit.riempi_2"), dlgFill, tr("imgedit.modifica_2"));
  K("Ctrl+T", tr("imgedit.trasformazione_libera"), () => (tf ? commitTransform() : beginTransform()), tr("imgedit.modifica_2"));
  K("ArrowLeft", tr("imgedit.sposta_1_px_maiusc_10"), () => nudge(-1, 0), tr("imgedit.modifica_2")); K("ArrowRight", tr("imgedit.sposta_destra"), () => nudge(1, 0), tr("imgedit.modifica_2"));
  K("ArrowUp", tr("imgedit.sposta_alto"), () => nudge(0, -1), tr("imgedit.modifica_2")); K("ArrowDown", tr("imgedit.sposta_basso"), () => nudge(0, 1), tr("imgedit.modifica_2"));
  K("Shift+ArrowLeft", tr("imgedit.sposta_10_px"), () => nudge(-10, 0), tr("imgedit.modifica_2")); K("Shift+ArrowRight", tr("imgedit.sposta_10_px"), () => nudge(10, 0), tr("imgedit.modifica_2"));
  K("Shift+ArrowUp", tr("imgedit.sposta_10_px"), () => nudge(0, -10), tr("imgedit.modifica_2")); K("Shift+ArrowDown", tr("imgedit.sposta_10_px"), () => nudge(0, 10), tr("imgedit.modifica_2"));
  for (const [k, a] of Object.entries(ADJ)) if (a.keys) K(a.keys, a.name, () => runAdjust(k), tr("imgedit.immagine"));
  K("Ctrl+Shift+U", tr("imgedit.togli_saturazione"), () => quickAdjust("desaturate"), tr("imgedit.immagine"));
  K("Ctrl+Shift+L", tr("imgedit.tono_automatico"), () => quickAdjust("tone"), tr("imgedit.immagine"));
  K("Ctrl+Alt+Shift+L", tr("imgedit.contrasto_automatico"), () => quickAdjust("contrast"), tr("imgedit.immagine"));
  K("Ctrl+Shift+B", tr("imgedit.colore_automatico"), () => quickAdjust("color"), tr("imgedit.immagine"));
  K("Ctrl+Alt+I", tr("imgedit.dimensione_immagine"), dlgImageSize, tr("imgedit.immagine"));
  K("Ctrl+Alt+C", tr("imgedit.dimensione_quadro"), dlgCanvasSize, tr("imgedit.immagine"));
  K("Ctrl+Shift+N", tr("imgedit.nuovo_livello_2"), dlgNewLayer, tr("imgedit.livello"));
  K("Ctrl+Alt+Shift+N", tr("imgedit.nuovo_livello_senza_finestra"), () => addLayer(), tr("imgedit.livello"));
  K("Ctrl+J", tr("imgedit.livello_tramite_copia"), () => layerVia(false), tr("imgedit.livello"));
  K("Ctrl+Shift+J", tr("imgedit.livello_tramite_taglio"), () => layerVia(true), tr("imgedit.livello"));
  K("Ctrl+E", tr("imgedit.unisci_sotto"), mergeDown, tr("imgedit.livello"));
  K("Ctrl+Shift+E", tr("imgedit.unisci_visibili"), () => mergeVisible(false), tr("imgedit.livello"));
  K("Ctrl+]", tr("imgedit.porta_avanti"), () => moveLayer(act + 1), tr("imgedit.livello"));
  K("Ctrl+[", tr("imgedit.porta_indietro"), () => moveLayer(act - 1), tr("imgedit.livello"));
  K("Ctrl+Shift+]", tr("imgedit.porta_primo_piano"), () => moveLayer(layers.length - 1), tr("imgedit.livello"));
  K("Ctrl+Shift+[", tr("imgedit.porta_sotto"), () => moveLayer(0), tr("imgedit.livello"));
  K("Alt+]", tr("imgedit.seleziona_livello_sopra"), () => selectLayer(Math.min(layers.length - 1, act + 1)), tr("imgedit.livello"));
  K("Alt+[", tr("imgedit.seleziona_livello_sotto"), () => selectLayer(Math.max(0, act - 1)), tr("imgedit.livello"));
  K("Ctrl+A", tr("imgedit.seleziona_tutto"), selectAll, tr("imgedit.seleziona"));
  K("Ctrl+D", tr("imgedit.deseleziona"), deselect, tr("imgedit.seleziona"));
  K("Ctrl+Shift+D", tr("imgedit.riseleziona"), reselect, tr("imgedit.seleziona"));
  K("Ctrl+Shift+I", tr("imgedit.inverti_selezione"), invertSel, tr("imgedit.seleziona"));
  K("Shift+F6", tr("imgedit.sfuma_selezione"), () => dlgModifySel("feather"), tr("imgedit.seleziona"));
  K("Ctrl+Alt+F", tr("imgedit.ripeti_l_ultimo_filtro"), () => lastFilter && runFilter(lastFilter.id, true), tr("imgedit.filtro"));
  K("Ctrl+Plus", tr("imgedit.zoom_avanti"), () => zoomStep(1), tr("imgedit.vista"));
  K("Ctrl+Minus", tr("imgedit.zoom_indietro"), () => zoomStep(-1), tr("imgedit.vista"));
  K("Ctrl+0", tr("imgedit.adatta_allo_schermo"), () => fit(true), tr("imgedit.vista"));
  K("Ctrl+1", tr("imgedit.100_pixel_reali"), () => setZoom(1), tr("imgedit.vista"));
  K("Ctrl+H", tr("imgedit.mostra_nascondi_extra_bordi_selezione"), () => { showExtras = !showExtras; schedule(); }, tr("imgedit.vista"));
  K("Tab", tr("imgedit.mostra_nascondi_pannelli_strumenti"), toggleAll, tr("imgedit.finestra"));
  K("F7", tr("imgedit.mostra_nascondi_pannelli"), togglePanels, tr("imgedit.finestra"));
  keymap(ctx, "Photoshop", defs, window);

  // ------------------------------------------------------------ avvio
  buildToolbar();
  history = [{ name: tr("imgedit.apri"), s: snap() }]; hi = 0;
  selectTool("move");
  refreshPanels(); renderAdjustPanel();
  // finche' l'utente non cambia zoom o posizione, l'immagine resta adattata alla finestra
  new ResizeObserver(() => { if (autoFit && stage.clientWidth) fit(); schedule(); placeText(); }).observe(stage);
  if (init.skipped?.length) toast(tr("imgedit.livelli_non_supportati_ignorati_0", init.skipped.slice(0, 3).join(", "), init.skipped.length > 3 ? "..." : ""), true, 6000);

  // ------------------------------------------------------------ salvataggio
  const RAW = init.raw;
  const layered = () => layers.length > 1 || layers.some(l => l.kind !== "pixel" || l.mask || l.opacity < 100 || l.blend !== "source-over" || !l.visible);
  const LAYERED_EXT = new Set(["psd", "ora"]);
  const CLIENT = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg", jfif: "image/jpeg", webp: "image/webp" };
  return {
    get saveInPlace() { return !RAW && (LAYERED_EXT.has(curExt) || !layered()); },
    saveAsName: () => (layered() && !LAYERED_EXT.has(curExt) ? withExt(ctx.tab.name, "psd") : RAW ? withExt(ctx.tab.name, "jpg") : ctx.tab.name),
    saveFormats: ["psd", "ora", "png", "jpg", "webp", "tif", "bmp", "gif"],
    saveLabels: { psd: tr("imgedit.photoshop_livelli"), ora: tr("imgedit.openraster_livelli_gimp_krita"), png: "PNG", jpg: "JPEG", webp: "WebP", tif: "TIFF", bmp: tr("imgedit.bitmap"), gif: "GIF" },
    saveNote: tr("imgedit.psd_ora_conservano_livelli_maschere"),
    async save(path) {
      if (ink?.active) ink.toggle(false); // i tratti ancora aperti diventano il livello "Annotazioni"
      endText(true);
      if (tf) commitTransform();
      const ext = extOf(path);
      let bytes;
      if (ext === "psd") bytes = await writePsd({ W, H, layers: layers.map(l => (l.kind === "text" || l.kind === "shape" ? { ...l, kind: "pixel" } : l)), composite: flatten() });
      else if (ext === "ora") bytes = await writeOra({ W, H, layers, composite: flatten() });
      else {
        const opaque = /^(jpe?g|jpe|jfif|bmp)$/.test(ext);
        const c = flatten(opaque ? "#ffffff" : null);
        const type = CLIENT[ext];
        const blob = await new Promise(r => c.toBlob(r, type || "image/png", 0.92));
        bytes = new Uint8Array(await blob.arrayBuffer());
        if (!type) { await api("image_save", { path }, { body: bytes }); bytes = null; }
        if (layered()) toast(tr("imgedit.salvata_l_immagine_unita_conservare"), false, 5000);
      }
      if (bytes) await api("save", { path }, { body: bytes });
      if (path === ctx.tab.path || extOf(path) === curExt) ctx.setDirty(false);
    },
    renamed(p) { curExt = extOf(p); },
    onShow() { schedule(); },
    onBack() { if (tf) { cancelTransform(); return true; } if (textEd) { endText(true); return true; } if (crop && tool === "crop") { cancelCrop(); return true; } return false; },
    async acceptDrop(paths) {
      const imgs = paths.filter(p => ctx.registry?.categories?.find?.(c => c.id === "image")?.exts?.includes(extOf(p)) ?? /\.(png|jpe?g|gif|webp|bmp|tiff?|psd)$/i.test(p));
      if (!imgs.length) return false;
      for (const p of imgs) await placeImage(p);
      return true;
    },
    // pannello Misure (ui/js/measure/mimg.js): vista, zoom e spostamento in sola lettura + ridisegno
    measureHost: { stage, view, get W() { return W; }, get H() { return H; }, get zoom() { return zoom; }, get panX() { return panX; }, get panY() { return panY; }, meta: init.meta || {},
      set onPaint(f) { measHook = f; }, redraw: () => schedule() },
    // per le prove dalla console (come tests/cad_harness.js): stato interno in sola lettura e comandi
    _ps: { state: () => ({ W, H, act, target, tool, zoom, panX, panY, sel: sel && sel.bounds, layers, history: history.map(h => h.name), hi }), selectTool, opt, setColor, runFilter, runAdjust, addAdjustLayer, addMask, flatten, menus: MENUS },
  };
}

// apertura: PSD e ORA con i livelli, il resto come immagine unica (livello "Sfondo")
export async function openImageDoc(bytesOrImg, ext) {
  if (ext === "psd") return readPsd(bytesOrImg, ADJ);
  if (ext === "ora") return readOra(bytesOrImg);
  const img = bytesOrImg, c = mkCanvas(img.naturalWidth || img.width, img.naturalHeight || img.height);
  g2(c).drawImage(img, 0, 0);
  return { W: c.width, H: c.height, layers: [{ name: tr("imgedit.sfondo"), kind: "pixel", c, x: 0, y: 0 }] };
}
