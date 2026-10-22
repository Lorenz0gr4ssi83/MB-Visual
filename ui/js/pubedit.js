// Editor di pubblicazioni con la stessa disposizione di Microsoft Publisher: barra multifunzione (Home, Inserisci,
// Progettazione pagina, Mailing, Revisione, Visualizza + schede contestuali Formato), pannello Pagine con le miniature a
// sinistra, righelli, guide di margine/layout/righello, pagine master, barra di stato con zoom.
//
// Il documento e' descritto in ui/js/pubmodel.js; il testo scorre fra le caselle collegate con ui/js/pubtext.js;
// il disegno (schermo, miniature, PDF) e' in ui/js/pubrender.js; barra multifunzione e finestre in ui/js/pubribbon.js;
// esportazioni in ui/js/pubexport.js. Coordinate del documento in punti; zoom = pixel CSS per punto.
import { t as tr } from "./i18n.js";
import { el, toast, loadCss } from "./core.js";
import { keymap, describeKeys } from "./shortcuts.js";
import { MM, CM, S, FIELD, color, newId, walk, allItems, cloneItems, makeStory, styleChars, charPart, paraPart, textBox, imageBox, shapeBox, wordArt, tableBox, newPage, storyText, copyStory } from "./pubmodel.js";
import { caretPos, hitText, offInLine, selectionRects, paraBounds, wordBounds, styleAt, paraAt, insertText, insertChars, deleteRange, sliceChars, setCharStyle, mapCharStyle, setParaStyle, LS } from "./pubtext.js";
import { computeLayouts, drawPage, CanvasPainter, objMatrix, apply, invert, aabb, isLine } from "./pubrender.js";
import { buildRibbon } from "./pubribbon.js";
import { installCommands } from "./pubcmds.js";

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const PX = 96 / 72; // zoom 100% = dimensione reale (1 pt = 1,333 px)
const RULER = 18;
const HANDLES = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]];
const ZOOMS = [10, 25, 33, 40, 50, 66, 75, 100, 150, 200, 300, 400, 600, 800];

export function createPublisher(ctx, doc, opts = {}) {
  loadCss("css/publisher.css");
  ctx.el.innerHTML = "";
  ctx.fillBody(true);
  const canvas = el("canvas", { class: "pb-canvas" });
  const sink = el("textarea", { class: "pb-sink", spellcheck: "false", autocomplete: "off", "aria-label": tr("pubedit.testo_pubblicazione") });
  const stage = el("div", { class: "pb-stage" }, canvas, sink);
  const pagesEl = el("div", { class: "pb-pages" });
  const ribbonEl = el("div", { class: "pb-ribbon" });
  const statusEl = el("div", { class: "pb-status" });
  const main = el("div", { class: "pb-main" }, pagesEl, stage);
  const root = el("div", { class: "pb-root" }, ribbonEl, main, statusEl);
  ctx.el.append(root);

  // ------------------------------------------------------------ stato
  let cur = 0, masterId = null;
  let sel = [], inGroup = null;
  let edit = null; // { kind: "frame"|"cell", o, r, c, story, caret, anchor }
  let crop = null, tool = null, drag = null, hoverHandle = null;
  let zoom = 1, panX = 0, panY = 0, autoFit = true, spread = false, prevZoom = null;
  const show = { bounds: true, guides: true, rulers: true, pages: true, marks: false };
  const snapOpt = { guides: true, objects: true };
  let lay = null, layVer = -1, ver = 0, snapLines = [], caretOn = true, mergeIdx = 0, mergePreview = false;
  let fmtClip = null, objClip = null, textClip = null;
  const images = new Map(); // id -> immagine decodificata
  const E = {}; // interfaccia per la barra multifunzione e le esportazioni

  const items = () => (masterId ? doc.masters.find(m => m.id === masterId).items : doc.pages[cur].items);
  const page = () => doc.pages[cur];
  const record = () => (mergePreview && doc.merge?.rows?.length ? doc.merge.rows[clamp(mergeIdx, 0, doc.merge.rows.length - 1)] : null);

  // ------------------------------------------------------------ immagini
  function loadImage(id) {
    const im = doc.images[id];
    if (!im || images.has(id)) return;
    const url = URL.createObjectURL(new Blob([im.bytes], { type: im.mime }));
    const img = new Image();
    images.set(id, null);
    img.onload = () => { images.set(id, img); schedule(); thumbsLater(); };
    img.onerror = () => images.delete(id);
    img.src = url;
  }
  const imgMap = { get: id => { if (!images.has(id)) loadImage(id); return images.get(id) || null; }, has: id => !!doc.images[id] };

  // ------------------------------------------------------------ impaginazione
  function relayout() {
    if (layVer === ver && lay) return lay;
    lay = computeLayouts(doc, { record: record() });
    // caselle "aumenta per adattare il testo"
    let grew = false;
    for (const [id, ent] of lay.frames) {
      const o = lay.byId.get(id);
      if (!o || o.fit !== "grow" || ent.layout.chain.length !== 1) continue;
      const last = ent.layout.lines[ent.layout.lines.length - 1];
      const need = last ? last.top + last.h + (o.pad?.[3] ?? 4) : o.h;
      if (ent.layout.overflow || need > o.h + 0.5) { o.h = Math.max(o.h, ent.layout.overflow ? o.h * 1.5 : need); grew = true; }
    }
    if (grew) lay = computeLayouts(doc, { record: record() });
    layVer = ver;
    return lay;
  }
  const touch = () => { ver++; schedule(); };

  // ------------------------------------------------------------ cronologia
  let history = [], hi = -1, lastKey = null, lastTime = 0;
  function snap() {
    const { stories, images: _i, ...rest } = doc;
    return {
      json: JSON.stringify(rest, (k, v) => (k === "_rowsH" ? undefined : v)),
      stories: Object.fromEntries(Object.entries(stories).map(([k, v]) => [k, v.chars.slice()])),
      sel: sel.map(o => o.id), cur, masterId,
      edit: edit ? { id: edit.o.id, kind: edit.kind, r: edit.r, c: edit.c, caret: edit.caret, anchor: edit.anchor } : null,
    };
  }
  function restore(s) {
    const j = JSON.parse(s.json);
    for (const k of Object.keys(j)) doc[k] = j[k];
    doc.stories = {};
    for (const [k, v] of Object.entries(s.stories)) doc.stories[k] = { id: k, chars: v.slice() };
    cur = clamp(s.cur, 0, doc.pages.length - 1);
    masterId = s.masterId && doc.masters.find(m => m.id === s.masterId) ? s.masterId : null;
    const all = new Map(allItems(doc).map(o => [o.id, o]));
    sel = s.sel.map(id => all.get(id)).filter(Boolean);
    inGroup = null; crop = null;
    edit = null;
    if (s.edit && all.get(s.edit.id)) {
      const o = all.get(s.edit.id);
      const story = s.edit.kind === "cell" ? o.cells[s.edit.r]?.[s.edit.c]?.story : o.story;
      if (doc.stories[story]) edit = { kind: s.edit.kind, o, r: s.edit.r, c: s.edit.c, story, caret: Math.min(s.edit.caret, doc.stories[story].chars.length - 1), anchor: Math.min(s.edit.anchor, doc.stories[story].chars.length - 1) };
    }
    touch(); refreshAll();
  }
  function commit(label, key = null) {
    const now = Date.now();
    const s = snap();
    s.label = label;
    if (key && key === lastKey && now - lastTime < 1500 && hi === history.length - 1 && hi > 0) history[hi] = s;
    else { history.splice(hi + 1); history.push(s); if (history.length > 100) history.shift(); hi = history.length - 1; }
    lastKey = key; lastTime = now;
    ctx.setDirty(true);
    touch(); refreshAll(); thumbsLater();
  }
  const undo = () => { if (hi > 0) { hi--; lastKey = null; restore(history[hi]); thumbsLater(); } };
  const redo = () => { if (hi < history.length - 1) { hi++; lastKey = null; restore(history[hi]); thumbsLater(); } };

  // ------------------------------------------------------------ vista
  const spreadPages = () => (spread && !masterId ? [cur - (cur % 2), cur - (cur % 2) + 1].filter(i => i < doc.pages.length) : [cur]);
  const originX = pi => (spread && !masterId && pi % 2 === 1 ? doc.w : 0);
  const spreadW = () => (spread && !masterId && spreadPages().length > 1 ? doc.w * 2 : doc.w);
  const toPage = (sx, sy, pi = cur) => ({ x: (sx - panX) / zoom - originX(pi), y: (sy - panY) / zoom });
  const toScreen = (x, y, pi = cur) => [panX + (x + originX(pi)) * zoom, panY + y * zoom];
  const rul = () => (show.rulers ? RULER : 0);
  function fitPage() {
    const r = stage.getBoundingClientRect();
    if (!r.width) return;
    const aw = r.width - rul() - 40, ah = r.height - rul() - 40;
    zoom = Math.max(0.05, Math.min(aw / spreadW(), ah / doc.h));
    panX = rul() + (r.width - rul() - spreadW() * zoom) / 2;
    panY = rul() + (r.height - rul() - doc.h * zoom) / 2;
    autoFit = true; schedule(); status();
  }
  function fitWidth() {
    const r = stage.getBoundingClientRect();
    zoom = Math.max(0.05, (r.width - rul() - 40) / spreadW());
    panX = rul() + 20; panY = rul() + 20; autoFit = false; schedule(); status();
  }
  function setZoom(z, cx, cy) {
    const r = stage.getBoundingClientRect();
    if (cx === undefined) { cx = r.width / 2; cy = r.height / 2; }
    z = clamp(z, 0.05, 20);
    const px = (cx - panX) / zoom, py = (cy - panY) / zoom;
    zoom = z; panX = cx - px * z; panY = cy - py * z; autoFit = false;
    schedule(); status();
  }
  const zoomPct = () => Math.round((zoom / PX) * 100);
  const zoomStep = (d, cx, cy) => { const p = zoomPct(); const nz = d > 0 ? ZOOMS.find(v => v > p + 0.5) || 800 : [...ZOOMS].reverse().find(v => v < p - 0.5) || 10; setZoom((nz / 100) * PX, cx, cy); };
  function zoomToSel() {
    if (!sel.length) return fitPage();
    const b = selBox();
    const r = stage.getBoundingClientRect();
    zoom = clamp(Math.min((r.width - rul() - 80) / Math.max(10, b.x1 - b.x0), (r.height - rul() - 80) / Math.max(10, b.y1 - b.y0)), 0.05, 20);
    panX = rul() + (r.width - rul()) / 2 - ((b.x0 + b.x1) / 2 + originX(cur)) * zoom;
    panY = rul() + (r.height - rul()) / 2 - ((b.y0 + b.y1) / 2) * zoom;
    autoFit = false; schedule(); status();
  }

  // ------------------------------------------------------------ geometria della selezione
  function unionBox(list) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const o of list) { const b = aabb(o); x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); }
    return { x0, y0, x1, y1 };
  }
  const selBox = () => unionBox(sel);
  function fixGroup(g) {
    for (const c of g.items) if (c.type === "group") fixGroup(c);
    const b = unionBox(g.items);
    g.x = b.x0; g.y = b.y0; g.w = b.x1 - b.x0; g.h = b.y1 - b.y0; g.rot = 0;
  }
  function parentOf(o, list = items(), par = null) {
    for (const x of list) {
      if (x === o) return { list, group: par };
      if (x.type === "group") { const r = parentOf(o, x.items, x); if (r) return r; }
    }
    return null;
  }
  const fixParents = o => { let p = parentOf(o); while (p && p.group) { fixGroup(p.group); p = parentOf(p.group); } };
  function moveObj(o, dx, dy) {
    o.x += dx; o.y += dy;
    if (o.type === "group") for (const c of o.items) moveObj(c, dx, dy);
  }
  const copyGeom = o => ({ x: o.x, y: o.y, w: o.w, h: o.h, rot: o.rot || 0, flipV: o.flipV, colW: o.colW?.slice(), rowH: o.rowH?.slice(), items: o.type === "group" ? o.items.map(copyGeom) : null });
  function setGeom(o, g) {
    o.x = g.x; o.y = g.y; o.w = g.w; o.h = g.h; o.rot = g.rot; if (g.flipV !== undefined) o.flipV = g.flipV;
    if (g.colW) o.colW = g.colW.slice(); if (g.rowH) o.rowH = g.rowH.slice();
    if (g.items) o.items.forEach((c, k) => setGeom(c, g.items[k]));
  }
  // ridimensiona un gruppo (o una selezione multipla) dal riquadro b0 al riquadro b1
  function scaleInto(o, g0, b0, b1) {
    const sx = (b1.x1 - b1.x0) / Math.max(0.01, b0.x1 - b0.x0), sy = (b1.y1 - b1.y0) / Math.max(0.01, b0.y1 - b0.y0);
    const cx0 = g0.x + g0.w / 2, cy0 = g0.y + g0.h / 2;
    const ncx = b1.x0 + (cx0 - b0.x0) * sx, ncy = b1.y0 + (cy0 - b0.y0) * sy;
    const rotated = Math.abs(((g0.rot || 0) % 180)) > 45 && Math.abs(((g0.rot || 0) % 180)) < 135;
    const w = g0.w * (rotated ? sy : sx), h = g0.h * (rotated ? sx : sy);
    o.w = Math.max(1, w); o.h = isLine(o) ? Math.max(0, h) : Math.max(1, h); o.x = ncx - o.w / 2; o.y = ncy - o.h / 2;
    if (o.type === "table") { o.colW = g0.colW.map(v => v * (o.w / g0.w)); o.rowH = g0.rowH.map(v => v * (o.h / Math.max(1, g0.h))); }
    if (o.type === "group") o.items.forEach((c, k) => scaleInto(c, g0.items[k], b0, b1));
  }
  function rotateAround(o, g0, cx, cy, da) {
    const a = (da * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const ox = g0.x + g0.w / 2 - cx, oy = g0.y + g0.h / 2 - cy;
    const nx = cx + ox * c - oy * s, ny = cy + ox * s + oy * c;
    o.x = nx - g0.w / 2; o.y = ny - g0.h / 2;
    if (o.type === "group") o.items.forEach((ch, k) => rotateAround(ch, g0.items[k], cx, cy, da));
    else o.rot = (((g0.rot || 0) + da) % 360 + 360) % 360;
  }

  // ------------------------------------------------------------ ricerca degli oggetti sotto il puntatore
  function hitObj(o, x, y, tol) {
    if (o.type === "group") return o.items.some(c => hitObj(c, x, y, tol));
    const [lx, ly] = apply(invert(objMatrix(o)), x, y);
    if (isLine(o)) {
      const [x1, y1, x2, y2] = o.flipV ? [0, o.h, o.w, 0] : [0, 0, o.w, o.h];
      const L2 = (x2 - x1) ** 2 + (y2 - y1) ** 2 || 1;
      const t = clamp(((lx - x1) * (x2 - x1) + (ly - y1) * (y2 - y1)) / L2, 0, 1);
      return Math.hypot(lx - (x1 + t * (x2 - x1)), ly - (y1 + t * (y2 - y1))) <= tol + (o.line?.w || 1) / 2;
    }
    return lx >= -tol && ly >= -tol && lx <= o.w + tol && ly <= o.h + tol;
  }
  function topAt(x, y, list = items()) {
    const tol = 3 / zoom;
    for (let k = list.length - 1; k >= 0; k--) if (hitObj(list[k], x, y, tol)) return list[k];
    return null;
  }
  // vicino al bordo (per spostare le caselle di testo e le tabelle invece di scrivere)
  function nearBorder(o, x, y) {
    const [lx, ly] = apply(invert(objMatrix(o)), x, y);
    const t = 6 / zoom;
    return lx < t || ly < t || lx > o.w - t || ly > o.h - t;
  }
  function handleAt(sx, sy) {
    if (sel.length === 0 || edit && !drag) { if (!(sel.length === 1 && edit)) return null; }
    if (crop) {
      const o = crop, m = objMatrix(o);
      for (let k = 0; k < 8; k++) { const [px, py] = apply(m, HANDLES[k][0] * o.w, HANDLES[k][1] * o.h); const [hx, hy] = toScreen(px, py); if (Math.hypot(hx - sx, hy - sy) < 8) return { k }; }
      return null;
    }
    if (sel.length === 1) {
      const o = sel[0], m = objMatrix(o);
      if (isLine(o)) {
        const pts = o.flipV ? [[0, o.h], [o.w, 0]] : [[0, 0], [o.w, o.h]];
        for (let k = 0; k < 2; k++) { const [hx, hy] = toScreen(...apply(m, ...pts[k])); if (Math.hypot(hx - sx, hy - sy) < 8) return { end: k }; }
        return null;
      }
      const [rx, ry] = toScreen(...apply(m, o.w / 2, 0));
      const up = rotHandleOffset(o);
      if (Math.hypot(rx + up[0] - sx, ry + up[1] - sy) < 8) return { rot: true };
      for (let k = 0; k < 8; k++) { const [hx, hy] = toScreen(...apply(m, HANDLES[k][0] * o.w, HANDLES[k][1] * o.h)); if (Math.hypot(hx - sx, hy - sy) < 7) return { k }; }
      return null;
    }
    const b = selBox();
    for (let k = 0; k < 8; k++) { const [hx, hy] = toScreen(b.x0 + HANDLES[k][0] * (b.x1 - b.x0), b.y0 + HANDLES[k][1] * (b.y1 - b.y0)); if (Math.hypot(hx - sx, hy - sy) < 7) return { k, multi: true }; }
    const [rx, ry] = toScreen((b.x0 + b.x1) / 2, b.y0);
    if (Math.hypot(rx - sx, ry - 22 - sy) < 8) return { rot: true, multi: true };
    return null;
  }
  function rotHandleOffset(o) {
    const a = ((o.rot || 0) * Math.PI) / 180;
    return [Math.sin(a) * 22 * (o.flipV ? -1 : 1), -Math.cos(a) * 22 * (o.flipV ? -1 : 1)];
  }

  // ------------------------------------------------------------ aggancio (guide, margini, oggetti)
  function snapTargets(exclude) {
    const xs = [], ys = [];
    const add = (arr, v, kind) => arr.push({ v, kind });
    add(xs, 0, "page"); add(xs, doc.w, "page"); add(xs, doc.w / 2, "page"); add(ys, 0, "page"); add(ys, doc.h, "page"); add(ys, doc.h / 2, "page");
    if (snapOpt.guides) {
      const M = doc.margins;
      add(xs, M.l, "guide"); add(xs, doc.w - M.r, "guide"); add(ys, M.t, "guide"); add(ys, doc.h - M.b, "guide");
      for (const g of layoutGuides()) add(g.dir === "v" ? xs : ys, g.v, "guide");
      const pg = masterId ? null : page();
      for (const v of pg?.guides.v || []) add(xs, v, "guide");
      for (const v of pg?.guides.h || []) add(ys, v, "guide");
    }
    if (snapOpt.objects) {
      for (const o of items()) {
        if (exclude.has(o)) continue;
        const b = aabb(o);
        add(xs, b.x0, "obj"); add(xs, b.x1, "obj"); add(xs, (b.x0 + b.x1) / 2, "obj");
        add(ys, b.y0, "obj"); add(ys, b.y1, "obj"); add(ys, (b.y0 + b.y1) / 2, "obj");
      }
    }
    return { xs, ys };
  }
  function layoutGuides() {
    const out = [], M = doc.margins, G = doc.grid || { cols: 1, rows: 1, gap: 0 };
    const W = doc.w - M.l - M.r, H = doc.h - M.t - M.b;
    if (G.cols > 1) { const cw = (W - G.gap * (G.cols - 1)) / G.cols; for (let k = 1; k < G.cols; k++) { const x = M.l + k * cw + (k - 1) * G.gap; out.push({ dir: "v", v: x }); out.push({ dir: "v", v: x + G.gap }); } }
    if (G.rows > 1) { const rh = (H - G.gap * (G.rows - 1)) / G.rows; for (let k = 1; k < G.rows; k++) { const y = M.t + k * rh + (k - 1) * G.gap; out.push({ dir: "h", v: y }); out.push({ dir: "h", v: y + G.gap }); } }
    return out;
  }
  function snapDelta(edges, targets) {
    const th = 6 / zoom;
    let best = null;
    for (const e of edges) for (const t of targets) { const d = t.v - e; if (Math.abs(d) <= th && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, v: t.v, kind: t.kind }; }
    return best;
  }

  // ------------------------------------------------------------ disegno
  let raf = 0;
  function schedule() { if (!raf) raf = requestAnimationFrame(render); }
  function render() {
    raf = 0;
    const r = stage.getBoundingClientRect();
    if (!r.width) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const g = canvas.getContext("2d");
    relayout();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = getComputedStyle(root).getPropertyValue("--pb-paste").trim() || "#c9ccd1";
    g.fillRect(0, 0, W, H);
    const pages = spreadPages();
    for (const pi of pages) {
      const ox = originX(pi);
      // ombra della pagina
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = "rgba(0,0,0,.28)";
      g.fillRect(panX + ox * zoom + 3, panY + 3, doc.w * zoom, doc.h * zoom);
      g.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * (panX + ox * zoom), dpr * panY);
      g.save();
      g.beginPath(); g.rect(0, 0, doc.w, doc.h); g.clip();
      const P = new CanvasPainter(g, imgMap);
      const env = { doc, lay, pageNo: pi, painter: P, editing: true, scale: zoom, images: imgMap };
      if (masterId) env.masterOnly = doc.masters.find(m => m.id === masterId);
      drawPage(env, masterId ? { ...doc.pages[0], master: null, items: [], bg: doc.pages[0]?.bg } : doc.pages[pi]);
      g.restore();
      drawGuides(g, dpr, pi);
      if (pi === cur || masterId) drawOverlay(g, dpr, pi);
    }
    if (show.rulers) drawRulers(g, dpr, r.width, r.height);
  }
  function drawGuides(g, dpr, pi) {
    if (!show.guides) return;
    const ox = originX(pi);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.lineWidth = 1;
    const X = v => Math.round(panX + (v + ox) * zoom) + 0.5, Y = v => Math.round(panY + v * zoom) + 0.5;
    const x0 = panX + ox * zoom, y0 = panY, x1 = x0 + doc.w * zoom, y1 = y0 + doc.h * zoom;
    const M = doc.margins;
    g.setLineDash([4, 3]);
    g.strokeStyle = "rgba(60, 110, 220, .75)"; // margini (blu, come in Publisher)
    g.beginPath();
    for (const v of [M.l, doc.w - M.r]) { g.moveTo(X(v), y0); g.lineTo(X(v), y1); }
    for (const v of [M.t, doc.h - M.b]) { g.moveTo(x0, Y(v)); g.lineTo(x1, Y(v)); }
    g.stroke();
    g.strokeStyle = "rgba(60, 110, 220, .45)"; // guide del layout (colonne/righe)
    g.beginPath();
    for (const gd of layoutGuides()) { if (gd.dir === "v") { g.moveTo(X(gd.v), Y(M.t)); g.lineTo(X(gd.v), Y(doc.h - M.b)); } else { g.moveTo(X(M.l), Y(gd.v)); g.lineTo(X(doc.w - M.r), Y(gd.v)); } }
    g.stroke();
    g.setLineDash([]);
    const pg = masterId ? null : doc.pages[pi];
    if (pg) {
      g.strokeStyle = "rgba(0, 160, 70, .9)"; // guide del righello (verdi)
      g.beginPath();
      for (const v of pg.guides.v) { g.moveTo(X(v), y0); g.lineTo(X(v), y1); }
      for (const v of pg.guides.h) { g.moveTo(x0, Y(v)); g.lineTo(x1, Y(v)); }
      g.stroke();
    }
  }
  function objPath(g, o) {
    const m = objMatrix(o);
    const pts = [[0, 0], [o.w, 0], [o.w, o.h], [0, o.h]].map(p => toScreen(...apply(m, ...p)));
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) g.lineTo(p[0], p[1]);
    g.closePath();
  }
  function drawOverlay(g, dpr, pi) {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // limiti degli oggetti (Visualizza > Limiti)
    if (show.bounds) {
      g.setLineDash([3, 3]); g.lineWidth = 1; g.strokeStyle = "rgba(90, 100, 110, .55)";
      const list = masterId ? doc.masters.find(m => m.id === masterId).items : doc.pages[pi].items;
      for (const o of walk(list)) if (o.type === "text" || o.type === "image" && !o.img) { objPath(g, o); g.stroke(); }
      g.setLineDash([]);
    }
    // testo che non ci sta: indicatore rosso in basso a destra (come Publisher)
    if (lay) {
      const list = masterId ? doc.masters.find(m => m.id === masterId).items : doc.pages[pi].items;
      for (const o of walk(list)) {
        if (o.type !== "text") continue;
        const ent = lay.frames.get(o.id);
        if (ent && ent.layout.overflow && ent.layout.chain[ent.layout.chain.length - 1] === o.id) {
          const [hx, hy] = toScreen(...apply(objMatrix(o), o.w, o.h));
          g.fillStyle = "#c4314b"; g.fillRect(hx - 20, hy - 9, 22, 14);
          g.fillStyle = "#fff"; g.font = "bold 11px Segoe UI"; g.fillText("...", hx - 16, hy + 1);
        }
      }
    }
    // testo selezionato e cursore
    if (edit) drawTextSel(g);
    // selezione
    if (crop) drawCrop(g);
    else if (sel.length) {
      g.strokeStyle = "#2f75c8"; g.lineWidth = 1;
      if (sel.length === 1) {
        const o = sel[0];
        if (isLine(o)) {
          const m = objMatrix(o), pts = (o.flipV ? [[0, o.h], [o.w, 0]] : [[0, 0], [o.w, o.h]]).map(p => toScreen(...apply(m, ...p)));
          for (const [hx, hy] of pts) handleDot(g, hx, hy);
        } else {
          g.setLineDash(edit ? [4, 3] : []);
          objPath(g, o); g.stroke(); g.setLineDash([]);
          if (!edit || true) {
            const m = objMatrix(o);
            const [tx, ty] = toScreen(...apply(m, o.w / 2, 0));
            const up = rotHandleOffset(o);
            g.beginPath(); g.moveTo(tx, ty); g.lineTo(tx + up[0], ty + up[1]); g.stroke();
            g.fillStyle = "#3b8f3b"; g.beginPath(); g.arc(tx + up[0], ty + up[1], 5, 0, 7); g.fill(); g.strokeStyle = "#fff"; g.stroke(); g.strokeStyle = "#2f75c8";
            for (const [u, v] of HANDLES) handleDot(g, ...toScreen(...apply(m, u * o.w, v * o.h)));
          }
          if (o.type === "group" || inGroup) { /* */ }
        }
        // caselle collegate: frecce per andare alla precedente / successiva
        if (o.type === "text" && lay) {
          const ent = lay.frames.get(o.id);
          if (ent && ent.layout.chain.length > 1) {
            const k = ent.layout.chain.indexOf(o.id), m = objMatrix(o);
            if (k > 0) linkBtn(g, ...toScreen(...apply(m, o.w - 12, 0)), "prev");
            if (k < ent.layout.chain.length - 1) linkBtn(g, ...toScreen(...apply(m, o.w - 12, o.h)), "next");
          }
        }
      } else {
        const b = selBox();
        const [x0, y0] = toScreen(b.x0, b.y0), [x1, y1] = toScreen(b.x1, b.y1);
        for (const o of sel) { g.setLineDash([3, 2]); objPath(g, o); g.stroke(); }
        g.setLineDash([]);
        g.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
        for (const [u, v] of HANDLES) handleDot(g, x0 + u * (x1 - x0), y0 + v * (y1 - y0));
      }
    }
    if (inGroup && sel.length) { g.setLineDash([2, 3]); g.strokeStyle = "rgba(47,117,200,.6)"; objPath(g, inGroup); g.stroke(); g.setLineDash([]); }
    // linee di aggancio (rosa, come le guide di allineamento di Publisher)
    if (snapLines.length) {
      g.strokeStyle = "#e0338a"; g.lineWidth = 1;
      g.beginPath();
      for (const s of snapLines) {
        if (s.dir === "v") { const [x] = toScreen(s.v, 0); g.moveTo(Math.round(x) + 0.5, 0); g.lineTo(Math.round(x) + 0.5, canvas.height); }
        else { const [, y] = toScreen(0, s.v); g.moveTo(0, Math.round(y) + 0.5); g.lineTo(canvas.width, Math.round(y) + 0.5); }
      }
      g.stroke();
    }
    // riquadro di selezione / nuovo oggetto
    if (drag && (drag.kind === "band" || drag.kind === "create")) {
      const [x0, y0] = toScreen(Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1)), [x1, y1] = toScreen(Math.max(drag.x0, drag.x1), Math.max(drag.y0, drag.y1));
      g.setLineDash(drag.kind === "band" ? [3, 3] : []);
      g.strokeStyle = "#2f75c8"; g.fillStyle = "rgba(47,117,200,.08)";
      if (drag.kind === "create" && /shape:(line|arrow|darrow)/.test(tool)) { const [a, b] = toScreen(drag.x0, drag.y0), [c, d] = toScreen(drag.x1, drag.y1); g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.stroke(); }
      else { g.fillRect(x0, y0, x1 - x0, y1 - y0); g.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0); }
      g.setLineDash([]);
    }
    if (drag && drag.kind === "guide" && drag.preview !== undefined) {
      g.strokeStyle = "rgba(0,160,70,.9)"; g.beginPath();
      if (drag.dir === "v") { const [x] = toScreen(drag.preview, 0); g.moveTo(x, 0); g.lineTo(x, canvas.height); } else { const [, y] = toScreen(0, drag.preview); g.moveTo(0, y); g.lineTo(canvas.width, y); }
      g.stroke();
    }
  }
  function handleDot(g, x, y) {
    g.fillStyle = "#fff"; g.strokeStyle = "#2f75c8"; g.lineWidth = 1;
    g.beginPath(); g.arc(x, y, 4, 0, 7); g.fill(); g.stroke();
  }
  function linkBtn(g, x, y, dir) {
    g.fillStyle = "#2f75c8"; g.fillRect(x - 9, y - 8, 18, 16);
    g.strokeStyle = "#fff"; g.lineWidth = 1.6; g.beginPath();
    if (dir === "next") { g.moveTo(x - 4, y - 2); g.lineTo(x, y + 3); g.lineTo(x + 4, y - 2); } else { g.moveTo(x - 4, y + 2); g.lineTo(x, y - 3); g.lineTo(x + 4, y + 2); }
    g.stroke(); g.lineWidth = 1;
  }
  function linkBtnAt(sx, sy) {
    if (sel.length !== 1 || sel[0].type !== "text" || !lay) return null;
    const o = sel[0], ent = lay.frames.get(o.id);
    if (!ent || ent.layout.chain.length < 2) return null;
    const k = ent.layout.chain.indexOf(o.id), m = objMatrix(o);
    const [px, py] = toScreen(...apply(m, o.w - 12, 0)), [nx, ny] = toScreen(...apply(m, o.w - 12, o.h));
    if (k > 0 && Math.abs(sx - px) < 10 && Math.abs(sy - py) < 9) return "prev";
    if (k < ent.layout.chain.length - 1 && Math.abs(sx - nx) < 10 && Math.abs(sy - ny) < 9) return "next";
    return null;
  }
  function overflowAt(sx, sy) {
    if (!lay) return null;
    for (const o of walk(items())) {
      if (o.type !== "text") continue;
      const ent = lay.frames.get(o.id);
      if (!ent || !ent.layout.overflow || ent.layout.chain[ent.layout.chain.length - 1] !== o.id) continue;
      const [hx, hy] = toScreen(...apply(objMatrix(o), o.w, o.h));
      if (sx > hx - 22 && sx < hx + 4 && sy > hy - 11 && sy < hy + 7) return o;
    }
    return null;
  }
  function drawCrop(g) {
    const o = crop, m = objMatrix(o), im = doc.images[o.img.id];
    // immagine intera in trasparenza attorno alla cornice
    if (im) {
      const c = o.img, kx = o.w / c.sw, ky = o.h / c.sh;
      const full = { x: -c.sx * kx, y: -c.sy * ky, w: im.w * kx, h: im.h * ky };
      const dpr = window.devicePixelRatio || 1;
      g.save();
      g.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * (panX + originX(cur) * zoom), dpr * panY);
      g.transform(...m);
      g.globalAlpha = 0.35;
      const img = imgMap.get(o.img.id);
      if (img) g.drawImage(img, full.x, full.y, full.w, full.h);
      g.restore();
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const corners = [[full.x, full.y], [full.x + full.w, full.y], [full.x + full.w, full.y + full.h], [full.x, full.y + full.h]].map(p => toScreen(...apply(m, ...p)));
      g.strokeStyle = "rgba(0,0,0,.5)"; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(...corners[0]); corners.slice(1).forEach(p => g.lineTo(...p)); g.closePath(); g.stroke(); g.setLineDash([]);
    }
    // maniglie di ritaglio (barre nere)
    g.strokeStyle = "#000"; g.lineWidth = 1; objPath(g, o); g.stroke();
    g.fillStyle = "#111";
    for (const [u, v] of HANDLES) { const [x, y] = toScreen(...apply(m, u * o.w, v * o.h)); g.fillRect(x - 5, y - 5, 10, 10); g.fillStyle = "#fff"; g.fillRect(x - 3, y - 3, 6, 6); g.fillStyle = "#111"; }
  }
  // geometria del testo in modifica: per ogni contenitore la matrice locale -> pagina e la pagina
  function editInfo() {
    if (!edit || !lay) return null;
    if (edit.kind === "cell") {
      const ent = lay.cells.get(`${edit.o.id}:${edit.r}:${edit.c}`);
      if (!ent) return null;
      const m = objMatrix(edit.o);
      const mm = [m[0], m[1], m[2], m[3], m[4] + m[0] * ent.x + m[2] * ent.y, m[5] + m[1] * ent.x + m[3] * ent.y];
      const pi = pageOfObj(edit.o);
      return { layout: ent.layout, conts: [{ m: mm, pi, o: edit.o }] };
    }
    let ent = lay.frames.get(edit.o.id);
    if (!ent && masterId) ent = lay.masterLayout(edit.o, cur);
    if (!ent) return null;
    const conts = ent.layout.chain.map(id => { const o = lay.byId.get(id); return { m: objMatrix(o), pi: pageOfObj(o), o }; });
    return { layout: ent.layout, conts };
  }
  function pageOfObj(o) {
    const w = lay?.where.get(o.id);
    return w ? (w.pi >= 0 ? w.pi : masterId ? cur : -1) : cur;
  }
  function drawTextSel(g) {
    const info = editInfo();
    if (!info) return;
    const vis = new Set(spreadPages());
    const a = Math.min(edit.caret, edit.anchor), b = Math.max(edit.caret, edit.anchor);
    g.fillStyle = "rgba(47,117,200,.28)";
    for (const r of selectionRects(info.layout, a, b)) {
      const c = info.conts[r.cont];
      if (!c || !(vis.has(c.pi) || masterId)) continue;
      const pts = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(p => toScreen(...apply(c.m, ...p), c.pi));
      g.beginPath(); g.moveTo(...pts[0]); pts.slice(1).forEach(p => g.lineTo(...p)); g.closePath(); g.fill();
    }
    // segni di paragrafo (Visualizza > Caratteri speciali)
    if (show.marks) {
      g.fillStyle = "rgba(47,117,200,.8)"; g.font = "11px Segoe UI";
      const st = doc.stories[edit.story];
      for (const L of info.layout.lines) {
        const c = info.conts[L.cont];
        if (!c) continue;
        for (let q = L.start; q < L.end; q++) {
          const ch = st.chars[q].c;
          if (ch === "\n" || ch === LS || ch === " ") {
            const [x, y] = toScreen(...apply(c.m, L.x + L.xs[q - L.start] + (ch === " " ? (L.xs[q - L.start + 1] - L.xs[q - L.start]) / 2 - 1 : 0), L.base), c.pi);
            g.fillText(ch === "\n" ? "¶" : ch === LS ? "↵" : "·", x, y);
          }
        }
      }
    }
    if (a === b && caretOn) {
      const cp = caretPos(info.layout, edit.caret);
      if (!cp) return;
      const c = info.conts[cp.cont];
      if (!c || !(vis.has(c.pi) || masterId)) return;
      const p0 = toScreen(...apply(c.m, cp.x, cp.top), c.pi), p1 = toScreen(...apply(c.m, cp.x, cp.top + cp.h), c.pi);
      g.strokeStyle = "#000"; g.lineWidth = 1.5; g.beginPath(); g.moveTo(...p0); g.lineTo(...p1); g.stroke(); g.lineWidth = 1;
    }
  }
  function drawRulers(g, dpr, w, h) {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = getComputedStyle(root).getPropertyValue("--pb-ruler").trim() || "#f3f3f3";
    const fg = getComputedStyle(root).getPropertyValue("--pb-ruler-fg").trim() || "#555";
    g.fillStyle = bg; g.fillRect(0, 0, w, RULER); g.fillRect(0, 0, RULER, h);
    g.strokeStyle = "rgba(0,0,0,.25)"; g.beginPath(); g.moveTo(0, RULER + 0.5); g.lineTo(w, RULER + 0.5); g.moveTo(RULER + 0.5, 0); g.lineTo(RULER + 0.5, h); g.stroke();
    // area della pagina evidenziata
    const ox = originX(cur);
    g.fillStyle = "rgba(255,255,255,.9)";
    g.fillRect(panX + ox * zoom, 0, doc.w * zoom, RULER - 1); g.fillRect(0, panY, RULER - 1, doc.h * zoom);
    // tacche in centimetri
    const step = zoom * CM;
    const sub = step > 60 ? 10 : step > 25 ? 2 : 1;
    const every = step < 12 ? Math.ceil(12 / step) : 1;
    g.fillStyle = fg; g.strokeStyle = fg; g.font = "9px Segoe UI"; g.textBaseline = "top";
    g.beginPath();
    const x0 = panX + ox * zoom;
    for (let k = Math.floor((RULER - x0) / step) - 1; x0 + k * step < w; k++) {
      if (k % every) continue;
      const x = Math.round(x0 + k * step) + 0.5;
      g.moveTo(x, RULER); g.lineTo(x, RULER - 8);
      if (x > RULER) g.fillText(String(k), x + 2, 2);
      for (let s = 1; s < sub && every === 1; s++) { const xx = Math.round(x0 + (k + s / sub) * step) + 0.5; g.moveTo(xx, RULER); g.lineTo(xx, RULER - (s === sub / 2 ? 5 : 3)); }
    }
    for (let k = Math.floor((RULER - panY) / step) - 1; panY + k * step < h; k++) {
      if (k % every) continue;
      const y = Math.round(panY + k * step) + 0.5;
      g.moveTo(RULER, y); g.lineTo(RULER - 8, y);
      if (y > RULER) { g.save(); g.translate(2, y + 2); g.rotate(Math.PI / 2); g.fillText(String(k), 0, -9); g.restore(); }
      for (let s = 1; s < sub && every === 1; s++) { const yy = Math.round(panY + (k + s / sub) * step) + 0.5; g.moveTo(RULER, yy); g.lineTo(RULER - (s === sub / 2 ? 5 : 3), yy); }
    }
    g.stroke();
    // posizione dell'oggetto selezionato
    if (sel.length) {
      const b = selBox();
      g.fillStyle = "rgba(47,117,200,.25)";
      g.fillRect(panX + (b.x0 + ox) * zoom, 0, (b.x1 - b.x0) * zoom, RULER - 1);
      g.fillRect(0, panY + b.y0 * zoom, RULER - 1, (b.y1 - b.y0) * zoom);
    }
    g.fillStyle = bg; g.fillRect(0, 0, RULER, RULER);
    g.textBaseline = "alphabetic";
  }

  // ------------------------------------------------------------ barra di stato (come Publisher)
  const stPage = el("button", { class: "pb-st-btn", title: tr("pubedit.numero_pagina_pubblicazione_f5_vai"), onclick: () => E.gotoPageDlg() });
  const stPos = el("span", { class: "pb-st-pos", title: tr("pubedit.posizione_dell_oggetto_puntatore") });
  const stSize = el("span", { class: "pb-st-pos", title: tr("pubedit.dimensioni_dell_oggetto") });
  const stMsg = el("span", { class: "pb-st-msg" });
  const btnSingle = el("button", { class: "pb-st-icon", title: tr("pubedit.pagina_singola"), onclick: () => E.setSpread(false) });
  const btnSpread = el("button", { class: "pb-st-icon", title: tr("pubedit.pagine_affiancate"), onclick: () => E.setSpread(true) });
  const zOut = el("button", { class: "pb-st-icon", title: tr("pubedit.zoom_indietro"), onclick: () => zoomStep(-1) }, "−");
  const zIn = el("button", { class: "pb-st-icon", title: tr("pubedit.zoom_avanti"), onclick: () => zoomStep(1) }, "+");
  const zRange = el("input", { type: "range", min: "10", max: "400", class: "pb-zoom", title: tr("pubedit.zoom") });
  const zPct = el("button", { class: "pb-st-btn", title: tr("pubedit.zoom_pagina_intera_ctrl_maiusc"), onclick: () => fitPage() });
  const btnFit = el("button", { class: "pb-st-icon", title: tr("pubedit.pagina_intera_ctrl_maiusc_l"), onclick: () => fitPage() });
  zRange.addEventListener("input", () => setZoom((+zRange.value / 100) * PX));
  statusEl.append(stPage, stPos, stSize, stMsg, el("span", { class: "grow" }), btnSingle, btnSpread, el("span", { class: "pb-st-sep" }), zPct, zOut, zRange, zIn, btnFit);
  let msgTimer = 0, ptr = null;
  function status() {
    stPage.textContent = masterId ? tr("pubedit.pagina_master_0", masterId) : tr("pubedit.pagina_0_1", cur + 1, doc.pages.length);
    const cm = v => (v / CM).toFixed(2).replace(".", ",");
    if (sel.length) {
      const b = sel.length === 1 && !isLine(sel[0]) ? { x0: sel[0].x, y0: sel[0].y, x1: sel[0].x + sel[0].w, y1: sel[0].y + sel[0].h } : selBox();
      stPos.textContent = `${cm(b.x0)}; ${cm(b.y0)} cm`;
      stSize.textContent = `${cm(b.x1 - b.x0)} x ${cm(b.y1 - b.y0)} cm`;
    } else {
      stPos.textContent = ptr ? `${cm(ptr.x)}; ${cm(ptr.y)} cm` : "";
      stSize.textContent = "";
    }
    zPct.textContent = zoomPct() + "%";
    if (document.activeElement !== zRange) zRange.value = String(clamp(zoomPct(), 10, 400));
    btnSingle.classList.toggle("on", !spread); btnSpread.classList.toggle("on", spread);
    btnSingle.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 3h10v18H7z"/></svg>';
    btnSpread.innerHTML = '<svg viewBox="0 0 24 24"><path d="M2 4h9v16H2zM13 4h9v16h-9z"/></svg>';
    btnFit.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
    const words = edit ? countWords(storyText(doc.stories[edit.story])) : null;
    ctx.status(`${masterId ? tr("pubedit.pagina_master") : tr("pubedit.pagina_0_1_2", cur + 1, doc.pages.length)}${words !== null ? ` · ${words} parole` : ""} · ${zoomPct()}%`);
  }
  function message(t, ms = 4000) { stMsg.textContent = t || ""; clearTimeout(msgTimer); if (t && ms) msgTimer = setTimeout(() => (stMsg.textContent = ""), ms); }
  const countWords = t => (t.match(/[\p{L}\p{N}]+/gu) || []).length;

  // ------------------------------------------------------------ pannello Pagine
  let thumbTimer = 0;
  function thumbsLater() { clearTimeout(thumbTimer); thumbTimer = setTimeout(renderThumbs, 350); }
  function renderPageThumb(c, pi, maxW, maxH) {
    const s = Math.min(maxW / doc.w, maxH / doc.h);
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(doc.w * s * dpr)); c.height = Math.max(1, Math.round(doc.h * s * dpr));
    c.style.width = Math.round(doc.w * s) + "px"; c.style.height = Math.round(doc.h * s) + "px";
    const g = c.getContext("2d");
    g.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
    drawPage({ doc, lay: relayout(), pageNo: pi, painter: new CanvasPainter(g, imgMap), editing: false, scale: s, images: imgMap }, doc.pages[pi]);
  }
  function renderThumbs() {
    if (!show.pages) return;
    pagesEl.innerHTML = "";
    const head = el("div", { class: "pb-pages-head" }, el("span", {}, tr("pubedit.pagine")));
    pagesEl.append(head);
    const list = el("div", { class: "pb-pages-list" });
    if (masterId) {
      for (const m of doc.masters) {
        const c = el("canvas");
        const card = el("button", { class: "pb-thumb" + (m.id === masterId ? " on" : ""), title: m.name, onclick: () => { masterId = m.id; selectNone(); touch(); refreshAll(); } }, c, el("span", {}, m.id));
        list.append(card);
        const s = Math.min(96 / doc.w, 120 / doc.h), dpr = window.devicePixelRatio || 1;
        c.width = Math.round(doc.w * s * dpr); c.height = Math.round(doc.h * s * dpr); c.style.width = Math.round(doc.w * s) + "px"; c.style.height = Math.round(doc.h * s) + "px";
        const g = c.getContext("2d"); g.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
        drawPage({ doc, lay: relayout(), pageNo: 0, painter: new CanvasPainter(g, imgMap), editing: false, scale: s, images: imgMap, masterOnly: m }, { items: [], master: null });
      }
      pagesEl.append(list);
      return;
    }
    doc.pages.forEach((p, pi) => {
      const c = el("canvas");
      const card = el("button", { class: "pb-thumb" + (pi === cur ? " on" : "") + (spread && spreadPages().includes(pi) ? " sp" : ""), title: tr("pubedit.pagina_0_1_3", pi + 1, p.master ? " · master " + p.master : ""), draggable: "true",
        onclick: () => E.gotoPage(pi), oncontextmenu: ev => { ev.preventDefault(); E.gotoPage(pi); E.pageMenu(ev.clientX, ev.clientY, pi); } }, c, el("span", {}, String(pi + 1)));
      card.addEventListener("dragstart", ev => { ev.dataTransfer.setData("text/x-mbv-page", String(pi)); });
      card.addEventListener("dragover", ev => { if ([...ev.dataTransfer.types].includes("text/x-mbv-page")) { ev.preventDefault(); card.classList.add("drop"); } });
      card.addEventListener("dragleave", () => card.classList.remove("drop"));
      card.addEventListener("drop", ev => { ev.preventDefault(); card.classList.remove("drop"); const from = +ev.dataTransfer.getData("text/x-mbv-page"); if (from !== pi) E.movePage(from, pi); });
      list.append(card);
      renderPageThumb(c, pi, 96, 120);
    });
    pagesEl.append(list);
    list.querySelector(".pb-thumb.on")?.scrollIntoView({ block: "nearest" });
  }

  // ------------------------------------------------------------ selezione
  function selectNone() { endEdit(); sel = []; inGroup = null; crop = null; }
  function selectOnly(o) { if (edit && edit.o !== o) endEdit(); sel = o ? [o] : []; crop = null; }
  function endEdit() {
    if (!edit) return;
    const st = doc.stories[edit.story];
    edit = null;
    lastKey = null;
    void st;
  }
  function beginEdit(o, off, kind = "frame", r = 0, c = 0) {
    const story = kind === "cell" ? o.cells[r][c].story : o.story;
    const st = doc.stories[story];
    if (!st) return;
    const caret = off === undefined ? st.chars.length - 1 : clamp(off, 0, st.chars.length - 1);
    edit = { kind, o, r, c, story, caret, anchor: caret };
    if (!sel.includes(o)) sel = [o];
    caretOn = true;
    focusSink();
    refreshAll();
  }
  function focusSink() { if (document.activeElement !== sink) sink.focus({ preventScroll: true }); }

  // ------------------------------------------------------------ puntatore
  let clicks = 0, lastDown = { t: 0, x: 0, y: 0 };
  const local = e => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener("pointerdown", e => {
    if (e.button === 1) { drag = { kind: "pan", sx: e.clientX, sy: e.clientY, px: panX, py: panY }; canvas.setPointerCapture(e.pointerId); e.preventDefault(); return; }
    if (e.button !== 0) return;
    const [sx, sy] = local(e);
    canvas.setPointerCapture(e.pointerId);
    focusSink();
    // conteggio dei clic (doppio / triplo clic): PointerEvent.detail non e' affidabile
    const now = Date.now();
    clicks = now - lastDown.t < 450 && Math.hypot(sx - lastDown.x, sy - lastDown.y) < 6 ? clicks + 1 : 1;
    lastDown = { t: now, x: sx, y: sy };
    // righelli: trascinando si crea una guida
    if (show.rulers && (sy < RULER || sx < RULER) && !masterId) {
      if (sy < RULER && sx < RULER) return;
      drag = { kind: "guide", dir: sy < RULER ? "h" : "v", idx: -1 };
      return;
    }
    // nelle pagine affiancate un clic sull'altra pagina la rende corrente
    if (spread && !masterId) {
      for (const pi of spreadPages()) {
        const p = toPage(sx, sy, pi);
        if (pi !== cur && p.x >= 0 && p.x <= doc.w && p.y >= -50 && p.y <= doc.h + 50) { selectNone(); cur = pi; refreshAll(); thumbsLater(); break; }
      }
    }
    const p = toPage(sx, sy);
    const lb = linkBtnAt(sx, sy);
    if (lb) { E.gotoLinked(lb); return; }
    // strumenti di inserimento: si disegna il riquadro
    if (tool === "link") { linkClick(p); return; }
    if (tool) { drag = { kind: "create", x0: p.x, y0: p.y, x1: p.x, y1: p.y, shift: e.shiftKey }; return; }
    const ov = overflowAt(sx, sy);
    if (ov) { selectOnly(ov); E.linkStart(); return; }
    const h = handleAt(sx, sy);
    if (h) { startHandleDrag(h, p, e); return; }
    if (crop) {
      if (hitObj(crop, p.x, p.y, 2 / zoom)) { drag = { kind: "cropmove", p0: p, img0: { ...crop.img } }; return; }
      crop = null; refreshAll();
    }
    // modifica del testo in corso: clic nel testo
    if (edit) {
      const hitT = textHit(p);
      const border = edit.kind === "frame" && hitObj(edit.o, p.x, p.y, 0) && nearBorder(edit.o, p.x, p.y) && clicks === 1 && !e.shiftKey;
      if (hitT !== null && !border) {
        if (clicks === 2) { const [a, b] = wordBounds(doc.stories[edit.story], hitT); edit.anchor = a; edit.caret = b; }
        else if (clicks >= 3) { const [a, b] = paraBounds(doc.stories[edit.story], hitT); edit.anchor = a; edit.caret = b; }
        else { edit.caret = hitT; if (!e.shiftKey) edit.anchor = hitT; }
        drag = { kind: "textsel" };
        caretOn = true; refreshAll();
        return;
      }
      endEdit();
    }
    // guide del righello
    const gd = guideAt(sx, sy);
    const hit = topAt(p.x, p.y);
    if (gd && (!hit || !hitObj(hit, p.x, p.y, 0))) { drag = { kind: "guide", dir: gd.dir, idx: gd.idx }; return; }
    if (!hit) {
      if (!e.shiftKey && !e.ctrlKey) { selectNone(); }
      drag = { kind: "band", x0: p.x, y0: p.y, x1: p.x, y1: p.y, add: e.shiftKey || e.ctrlKey, prev: sel.slice() };
      refreshAll();
      return;
    }
    // gruppi: primo clic sul gruppo, secondo clic sull'oggetto interno (come Publisher)
    let target = hit;
    if (hit.type === "group" && (sel.length === 1 && (sel[0] === hit || inGroup === hit))) {
      const child = topAt(p.x, p.y, hit.items);
      if (child) { inGroup = hit; target = child; }
    } else if (inGroup && inGroup.items.includes(topAt(p.x, p.y, inGroup.items))) target = topAt(p.x, p.y, inGroup.items);
    else inGroup = null;
    if (e.shiftKey || e.ctrlKey) {
      sel = sel.includes(target) ? sel.filter(o => o !== target) : [...sel.filter(o => !inGroup || inGroup.items.includes(o) === inGroup.items.includes(target)), target];
      refreshAll();
      drag = { kind: "move", p0: p, geo: sel.map(copyGeom), moved: false };
      return;
    }
    const wasSel = sel.length === 1 && sel[0] === target;
    if (!sel.includes(target)) selectOnly(target);
    // segnaposto immagine: clic sull'icona centrale = inserisci immagine
    if (target.type === "image" && !target.img && clicks === 2) { E.changePicture(); return; }
    if (target.type === "image" && target.img && clicks === 2) { E.cropToggle(); return; }
    if (target.type === "wordart" && clicks === 2) { E.editWordArt(); return; }
    drag = { kind: "move", p0: p, geo: sel.map(copyGeom), moved: false, textOnClick: (target.type === "text" || target.type === "table") && (!nearBorder(target, p.x, p.y) || target.type === "text" && wasSel && !nearBorder(target, p.x, p.y)), target, wasSel };
    refreshAll();
  });
  // clic nel testo della casella (o delle caselle collegate, o della cella) in modifica
  function textHit(p) {
    const info = editInfo();
    if (!info) return null;
    for (let k = 0; k < info.conts.length; k++) {
      const c = info.conts[k];
      if (c.pi !== cur && !masterId) continue;
      if (edit.kind === "cell") {
        const ent = lay.cells.get(`${edit.o.id}:${edit.r}:${edit.c}`);
        const [lx, ly] = apply(invert(objMatrix(edit.o)), p.x, p.y);
        if (lx < ent.x - 1 || ly < ent.y - 1 || lx > ent.x + ent.w + 1 || ly > ent.y + ent.h + 1) return null;
        return hitText(info.layout, 0, lx - ent.x, ly - ent.y);
      }
      if (!hitObj(c.o, p.x, p.y, 2 / zoom)) continue;
      const [lx, ly] = apply(invert(c.m), p.x, p.y);
      return hitText(info.layout, k, lx, ly);
    }
    return null;
  }
  function cellAt(o, p) {
    const [lx, ly] = apply(invert(objMatrix(o)), p.x, p.y);
    const rows = o._rowsH || o.rowH;
    let y = 0, r = -1;
    for (let k = 0; k < o.rows; k++) { if (ly >= y && ly < y + rows[k]) { r = k; break; } y += rows[k]; }
    let x = 0, c = -1;
    for (let k = 0; k < o.cols; k++) { if (lx >= x && lx < x + o.colW[k]) { c = k; break; } x += o.colW[k]; }
    if (r < 0 || c < 0) return null;
    return { r, c, lx: lx - x, ly: ly - y };
  }
  function guideAt(sx, sy) {
    if (!show.guides || masterId) return null;
    const pg = page();
    for (let k = 0; k < pg.guides.v.length; k++) { const [x] = toScreen(pg.guides.v[k], 0); if (Math.abs(x - sx) < 4) return { dir: "v", idx: k }; }
    for (let k = 0; k < pg.guides.h.length; k++) { const [, y] = toScreen(0, pg.guides.h[k]); if (Math.abs(y - sy) < 4) return { dir: "h", idx: k }; }
    return null;
  }
  function startHandleDrag(h, p, e) {
    if (h.rot) {
      const b = selBox(), cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
      drag = { kind: "rotate", cx, cy, a0: Math.atan2(p.y - cy, p.x - cx), geo: sel.map(copyGeom) };
      return;
    }
    if (h.end !== undefined) { drag = { kind: "lineend", end: h.end, geo: copyGeom(sel[0]) }; return; }
    if (crop) { drag = { kind: "cropresize", k: h.k, geo: copyGeom(crop), img0: { ...crop.img } }; return; }
    if (h.multi || sel.length > 1 || sel[0].type === "group") {
      const b = selBox();
      drag = { kind: "resizemulti", k: h.k, b0: b, geo: sel.map(copyGeom) };
      return;
    }
    drag = { kind: "resize", k: h.k, geo: copyGeom(sel[0]), m0: objMatrix(sel[0]) };
    void e;
  }
  canvas.addEventListener("pointermove", e => {
    const [sx, sy] = local(e);
    const p = toPage(sx, sy);
    ptr = p;
    if (!drag) {
      const h = handleAt(sx, sy);
      if (h !== hoverHandle) hoverHandle = h;
      if (!sel.length) status();
      return;
    }
    snapLines = [];
    if (drag.kind === "pan") { panX = drag.px + e.clientX - drag.sx; panY = drag.py + e.clientY - drag.sy; autoFit = false; schedule(); return; }
    if (drag.kind === "textsel") {
      const t = textHit(p);
      if (t !== null) { edit.caret = t; schedule(); refreshRibbonSoon(); }
      return;
    }
    if (drag.kind === "guide") { drag.preview = drag.dir === "v" ? p.x : p.y; drag.out = drag.dir === "v" ? sx < RULER && show.rulers : sy < RULER && show.rulers; schedule(); return; }
    if (drag.kind === "band" || drag.kind === "create") {
      drag.x1 = p.x; drag.y1 = p.y;
      if (drag.kind === "create" && e.shiftKey) {
        const d = Math.max(Math.abs(p.x - drag.x0), Math.abs(p.y - drag.y0));
        if (/shape:(line|arrow|darrow)/.test(tool)) { const a = Math.round(Math.atan2(p.y - drag.y0, p.x - drag.x0) / (Math.PI / 4)) * (Math.PI / 4), L = Math.hypot(p.x - drag.x0, p.y - drag.y0); drag.x1 = drag.x0 + Math.cos(a) * L; drag.y1 = drag.y0 + Math.sin(a) * L; }
        else { drag.x1 = drag.x0 + Math.sign(p.x - drag.x0 || 1) * d; drag.y1 = drag.y0 + Math.sign(p.y - drag.y0 || 1) * d; }
      }
      if (drag.kind === "band") {
        const x0 = Math.min(drag.x0, drag.x1), x1 = Math.max(drag.x0, drag.x1), y0 = Math.min(drag.y0, drag.y1), y1 = Math.max(drag.y0, drag.y1);
        const inside = items().filter(o => { const b = aabb(o); return b.x0 >= x0 && b.x1 <= x1 && b.y0 >= y0 && b.y1 <= y1; });
        sel = drag.add ? [...new Set([...drag.prev, ...inside])] : inside;
        refreshRibbonSoon();
      }
      schedule(); return;
    }
    if (drag.kind === "move") {
      let dx = p.x - drag.p0.x, dy = p.y - drag.p0.y;
      if (!drag.moved && Math.hypot(dx * zoom, dy * zoom) < 4) return;
      drag.moved = true;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      sel.forEach((o, k) => setGeom(o, drag.geo[k]));
      // aggancio: bordi e centri del riquadro della selezione
      const b = selBox();
      if (!e.altKey) {
        const T = snapTargets(new Set(sel));
        const sxs = snapDelta([b.x0 + dx, (b.x0 + b.x1) / 2 + dx, b.x1 + dx], T.xs), sys = snapDelta([b.y0 + dy, (b.y0 + b.y1) / 2 + dy, b.y1 + dy], T.ys);
        if (sxs) { dx += sxs.d; snapLines.push({ dir: "v", v: sxs.v }); }
        if (sys) { dy += sys.d; snapLines.push({ dir: "h", v: sys.v }); }
      }
      sel.forEach(o => { moveObj(o, dx, dy); fixParents(o); });
      touch(); status(); return;
    }
    if (drag.kind === "resize") { doResize(drag, p, e); touch(); status(); return; }
    if (drag.kind === "resizemulti") {
      const b0 = drag.b0, [u, v] = HANDLES[drag.k];
      let x0 = b0.x0, y0 = b0.y0, x1 = b0.x1, y1 = b0.y1;
      let px = p.x, py = p.y;
      if (!e.altKey) { const T = snapTargets(new Set(sel)); const a = snapDelta([px], T.xs), c = snapDelta([py], T.ys); if (a && u !== 0.5) { px += a.d; snapLines.push({ dir: "v", v: a.v }); } if (c && v !== 0.5) { py += c.d; snapLines.push({ dir: "h", v: c.v }); } }
      if (u === 0) x0 = Math.min(px, x1 - 2); else if (u === 1) x1 = Math.max(px, x0 + 2);
      if (v === 0) y0 = Math.min(py, y1 - 2); else if (v === 1) y1 = Math.max(py, y0 + 2);
      if ((e.shiftKey || sel.some(o => o.type === "image" || o.type === "group")) && u !== 0.5 && v !== 0.5 && !(e.shiftKey && sel.some(o => o.type === "image"))) {
        const r0 = (b0.x1 - b0.x0) / (b0.y1 - b0.y0), w = x1 - x0, h = y1 - y0;
        if (w / h > r0) { const nw = h * r0; if (u === 0) x0 = x1 - nw; else x1 = x0 + nw; } else { const nh = w / r0; if (v === 0) y0 = y1 - nh; else y1 = y0 + nh; }
      }
      const b1 = { x0, y0, x1, y1 };
      sel.forEach((o, k) => { scaleInto(o, drag.geo[k], b0, b1); fixParents(o); });
      touch(); status(); return;
    }
    if (drag.kind === "rotate") {
      let da = ((Math.atan2(p.y - drag.cy, p.x - drag.cx) - drag.a0) * 180) / Math.PI;
      if (e.shiftKey) da = Math.round(da / 15) * 15;
      sel.forEach((o, k) => {
        if (sel.length === 1 && o.type !== "group") { o.rot = ((((drag.geo[k].rot || 0) + da) % 360) + 360) % 360; if (e.shiftKey) o.rot = Math.round(o.rot / 15) * 15 % 360; }
        else rotateAround(o, drag.geo[k], drag.cx, drag.cy, da);
        fixParents(o);
      });
      message(`Rotazione: ${Math.round(sel[0].rot || 0)}°`, 0);
      touch(); return;
    }
    if (drag.kind === "lineend") {
      const o = sel[0], g0 = drag.geo;
      const pts = g0.flipV ? [[g0.x, g0.y + g0.h], [g0.x + g0.w, g0.y]] : [[g0.x, g0.y], [g0.x + g0.w, g0.y + g0.h]];
      let px = p.x, py = p.y;
      if (e.shiftKey) { const [ax, ay] = pts[1 - drag.end]; const a = Math.round(Math.atan2(py - ay, px - ax) / (Math.PI / 4)) * (Math.PI / 4), L = Math.hypot(px - ax, py - ay); px = ax + Math.cos(a) * L; py = ay + Math.sin(a) * L; }
      else if (!e.altKey) { const T = snapTargets(new Set(sel)); const a = snapDelta([px], T.xs), c = snapDelta([py], T.ys); if (a) { px += a.d; snapLines.push({ dir: "v", v: a.v }); } if (c) { py += c.d; snapLines.push({ dir: "h", v: c.v }); } }
      pts[drag.end] = [px, py];
      setLineEnds(o, pts[0], pts[1]);
      touch(); status(); return;
    }
    if (drag.kind === "cropmove") {
      const o = crop, im = doc.images[o.img.id];
      const [l0x, l0y] = apply(invert(objMatrix(o)), drag.p0.x, drag.p0.y), [l1x, l1y] = apply(invert(objMatrix(o)), p.x, p.y);
      const kx = drag.img0.sw / o.w, ky = drag.img0.sh / o.h;
      o.img.sx = clamp(drag.img0.sx - (l1x - l0x) * kx, Math.min(0, im.w - drag.img0.sw), Math.max(0, im.w - drag.img0.sw));
      o.img.sy = clamp(drag.img0.sy - (l1y - l0y) * ky, Math.min(0, im.h - drag.img0.sh), Math.max(0, im.h - drag.img0.sh));
      touch(); return;
    }
    if (drag.kind === "cropresize") {
      const o = crop, g0 = drag.geo, c0 = drag.img0, im = doc.images[o.img.id];
      const m0 = objMatrix({ ...o, ...g0 });
      const [lx, ly] = apply(invert(m0), p.x, p.y);
      const [u, v] = HANDLES[drag.k];
      const kx = c0.sw / g0.w, ky = c0.sh / g0.h; // pixel dell'immagine per punto
      let x0 = 0, y0 = 0, x1 = g0.w, y1 = g0.h;
      // limiti: non oltre i bordi dell'immagine
      const minX = -c0.sx / kx, maxX = (im.w - c0.sx) / kx, minY = -c0.sy / ky, maxY = (im.h - c0.sy) / ky;
      if (u === 0) x0 = clamp(lx, minX, g0.w - 4); else if (u === 1) x1 = clamp(lx, 4, maxX);
      if (v === 0) y0 = clamp(ly, minY, g0.h - 4); else if (v === 1) y1 = clamp(ly, 4, maxY);
      const nw = x1 - x0, nh = y1 - y0;
      const [cx, cy] = apply(m0, (x0 + x1) / 2, (y0 + y1) / 2);
      o.w = nw; o.h = nh; o.x = cx - nw / 2; o.y = cy - nh / 2;
      o.img = { ...o.img, sx: c0.sx + x0 * kx, sy: c0.sy + y0 * ky, sw: nw * kx, sh: nh * ky };
      touch(); status(); return;
    }
  });
  function setLineEnds(o, a, b) {
    if (b[0] < a[0]) [a, b] = [b, a];
    o.x = a[0]; o.w = Math.max(0, b[0] - a[0]);
    o.y = Math.min(a[1], b[1]); o.h = Math.abs(b[1] - a[1]);
    o.flipV = b[1] < a[1];
    o.rot = 0;
  }
  function doResize(d, p, e) {
    const o = sel[0], g0 = d.geo, [u, v] = HANDLES[d.k];
    let [lx, ly] = apply(invert(d.m0), p.x, p.y);
    // aggancio del bordo che si muove (solo oggetti non ruotati)
    if (!g0.rot && !e.altKey) {
      const T = snapTargets(new Set(sel));
      const a = u !== 0.5 ? snapDelta([p.x], T.xs) : null, c = v !== 0.5 ? snapDelta([p.y], T.ys) : null;
      if (a) { lx += a.d * (o.flipH ? -1 : 1); snapLines.push({ dir: "v", v: a.v }); }
      if (c) { ly += c.d * (o.flipV ? -1 : 1); snapLines.push({ dir: "h", v: c.v }); }
    }
    let x0 = 0, y0 = 0, x1 = g0.w, y1 = g0.h;
    const sym = e.ctrlKey;
    if (u === 0) { x0 = Math.min(lx, g0.w - 2); if (sym) x1 = g0.w - x0; } else if (u === 1) { x1 = Math.max(lx, 2); if (sym) x0 = g0.w - x1; }
    if (v === 0) { y0 = Math.min(ly, g0.h - 2); if (sym) y1 = g0.h - y0; } else if (v === 1) { y1 = Math.max(ly, 2); if (sym) y0 = g0.h - y1; }
    // proporzioni: immagini e WordArt con le maniglie d'angolo (Maiusc le libera), le altre con Maiusc
    const keep = u !== 0.5 && v !== 0.5 && ((o.type === "image" || o.type === "group") !== e.shiftKey);
    if (keep && g0.w > 0 && g0.h > 0) {
      const r0 = g0.w / g0.h, w = x1 - x0, h = y1 - y0;
      if (w / h > r0) { const nw = h * r0; if (u === 0) x0 = x1 - nw; else x1 = x0 + nw; } else { const nh = w / r0; if (v === 0) y0 = y1 - nh; else y1 = y0 + nh; }
    }
    const nw = Math.max(2, x1 - x0), nh = Math.max(2, y1 - y0);
    const [cx, cy] = apply(d.m0, (x0 + x1) / 2, (y0 + y1) / 2);
    o.w = nw; o.h = nh; o.x = cx - nw / 2; o.y = cy - nh / 2;
    if (o.type === "table") { o.colW = g0.colW.map(c => c * nw / g0.w); o.rowH = g0.rowH.map(r => r * nh / g0.h); }
    if (o.type === "image" && o.img && !keep) {
      // senza proporzioni l'immagine si deforma come in Publisher (il ritaglio resta lo stesso)
    }
    fixParents(o);
  }
  canvas.addEventListener("pointerup", e => {
    if (!drag) return;
    const d = drag;
    drag = null;
    snapLines = [];
    const [sx, sy] = local(e);
    const p = toPage(sx, sy);
    if (d.kind === "pan") return;
    if (d.kind === "guide") {
      const pg = page(), arr = d.dir === "v" ? pg.guides.v : pg.guides.h;
      const v = d.dir === "v" ? p.x : p.y;
      const out = (d.dir === "v" ? sx < RULER : sy < RULER) || v < -20 || v > (d.dir === "v" ? doc.w : doc.h) + 20;
      if (d.idx >= 0) { if (out) arr.splice(d.idx, 1); else arr[d.idx] = Math.round(v * 100) / 100; commit(out ? tr("pubedit.elimina_guida") : tr("pubedit.sposta_guida")); }
      else if (!out) { arr.push(Math.round(v * 100) / 100); commit(tr("pubedit.aggiungi_guida")); }
      schedule();
      return;
    }
    if (d.kind === "textsel") { refreshAll(); return; }
    if (d.kind === "band") { refreshAll(); return; }
    if (d.kind === "create") { createFromTool(d); return; }
    if (d.kind === "move") {
      if (d.moved) { commit(sel.length > 1 ? tr("pubedit.sposta_oggetti") : tr("pubedit.sposta")); return; }
      // clic senza trascinare su una casella di testo / tabella: si scrive
      if (d.textOnClick && sel.length === 1 && sel[0] === d.target) {
        const o = d.target;
        if (o.type === "table") {
          const c = cellAt(o, p);
          if (c) { beginEdit(o, 0, "cell", c.r, c.c); const t = textHit(p); if (t !== null) { edit.caret = edit.anchor = t; } refreshAll(); }
        } else {
          beginEdit(o, 0);
          const t = textHit(p);
          if (t !== null) edit.caret = edit.anchor = t;
          if (clicks === 2 && t !== null) { const [a, b] = wordBounds(doc.stories[edit.story], t); edit.anchor = a; edit.caret = b; }
          refreshAll();
        }
      }
      return;
    }
    if (["resize", "resizemulti", "rotate", "lineend"].includes(d.kind)) { message(""); commit(d.kind === "rotate" ? tr("pubedit.ruota") : tr("pubedit.ridimensiona")); return; }
    if (d.kind === "cropmove" || d.kind === "cropresize") { commit(tr("pubedit.ritaglia")); return; }
  });
  canvas.addEventListener("dblclick", e => {
    const [sx, sy] = local(e);
    if (show.rulers && (sx < RULER || sy < RULER)) { E.guidesDlg?.(); return; }
  });
  stage.addEventListener("wheel", e => {
    e.preventDefault();
    const [sx, sy] = local(e);
    if (e.ctrlKey || e.altKey) { zoomStep(e.deltaY < 0 ? 1 : -1, sx, sy); return; }
    if (e.shiftKey) panX -= e.deltaY || e.deltaX; else { panY -= e.deltaY; panX -= e.deltaX; }
    autoFit = false;
    // scorrendo oltre il bordo della pagina si passa alla pagina successiva/precedente (come Publisher)
    const r = stage.getBoundingClientRect();
    if (!masterId && !spread) {
      if (panY + doc.h * zoom < r.height * 0.25 && cur < doc.pages.length - 1 && e.deltaY > 0) { E.gotoPage(cur + 1, true); panY = r.height * 0.6; }
      else if (panY > r.height * 0.75 && cur > 0 && e.deltaY < 0) { E.gotoPage(cur - 1, true); panY = r.height * 0.4 - doc.h * zoom; }
    }
    schedule();
  }, { passive: false });
  canvas.addEventListener("contextmenu", e => {
    e.preventDefault();
    const [sx, sy] = local(e);
    const p = toPage(sx, sy);
    const hit = topAt(p.x, p.y);
    if (hit && !sel.includes(hit)) { selectOnly(hit); refreshAll(); }
    E.contextMenu(e.clientX, e.clientY, hit);
  });

  // ------------------------------------------------------------ creazione di oggetti con gli strumenti
  function createFromTool(d) {
    let x0 = Math.min(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    const t = tool;
    const small = w * zoom < 5 && h * zoom < 5;
    let o;
    if (t === "text") {
      if (small) { w = 3 * CM * 2; h = 2 * CM; }
      o = textBox(doc, x0, y0, w, h, [["", "Normale"]]);
    } else if (t === "picture") {
      if (small) { w = 5 * CM; h = 4 * CM; }
      o = imageBox(doc, x0, y0, w, h);
    } else if (t === "wordart") {
      if (small) { w = 8 * CM; h = 2.5 * CM; }
      o = wordArt(doc, tr("pubedit.tuo_testo"), x0, y0, w, h);
    } else if (t && t.startsWith("shape:")) {
      const sh = t.slice(6);
      if (/^(line|arrow|darrow)$/.test(sh)) {
        let a = [d.x0, d.y0], b = [d.x1, d.y1];
        if (small) b = [d.x0 + 4 * CM, d.y0];
        o = shapeBox(doc, sh, 0, 0, 1, 1, "none", { c: "s0", w: 1.5 }, { wrap: "none" });
        setLineEnds(o, a, b);
      } else {
        if (small) { w = 3 * CM; h = 3 * CM; }
        o = shapeBox(doc, sh, x0, y0, w, h, "s1", { c: "s0:-25", w: 0.75 }, { wrap: "none" });
      }
    }
    tool = null;
    if (!o) { refreshAll(); return; }
    addObj(o);
    commit(tr("pubedit.inserisci") + ({ text: tr("pubedit.casella_testo"), picture: tr("pubedit.segnaposto_immagine"), wordart: "WordArt" }[t] || "forma"));
    if (o.type === "text") beginEdit(o, 0);
    if (o.type === "wordart") E.editWordArt();
  }
  function addObj(o, select = true) {
    items().push(o);
    if (select) { endEdit(); sel = [o]; inGroup = null; crop = null; }
    touch();
  }

  // ------------------------------------------------------------ collegamento delle caselle di testo
  function linkClick(p) {
    const src = drag?.src || E._linkSrc;
    tool = null;
    stage.classList.remove("pb-pour");
    if (!src) return;
    const hit = topAt(p.x, p.y);
    if (hit && hit.type === "text" && hit !== src) {
      const ent = lay.frames.get(hit.id);
      const st = doc.stories[hit.story];
      if (ent && ent.layout.chain.length > 1) { toast(tr("pubedit.casella_gia_collegata_ad_altre"), true); refreshAll(); return; }
      if (st && st.chars.length > 1) { toast(tr("pubedit.casella_destinazione_deve_essere_vuota"), true); refreshAll(); return; }
      linkFrames(src, hit);
      commit(tr("pubedit.crea_collegamento"));
      return;
    }
    if (!hit) {
      // clic su uno spazio vuoto: nuova casella delle stesse dimensioni, gia' collegata
      const o = textBox(doc, p.x, p.y, src.w, src.h, [["", "Normale"]], { cols: src.cols, gap: src.gap, pad: src.pad?.slice() });
      items().push(o);
      linkFrames(src, o);
      sel = [o];
      commit(tr("pubedit.crea_collegamento"));
      return;
    }
    refreshAll();
  }
  function linkFrames(src, dst) {
    delete doc.stories[dst.story];
    // la destinazione si inserisce dopo la sorgente nella catena
    dst.next = src.next || null;
    dst.story = src.story;
    src.next = dst.id;
    touch();
  }

  // ------------------------------------------------------------ testo: tastiera e appunti
  sink.addEventListener("keydown", e => {
    if (!edit) return;
    const st = doc.stories[edit.story];
    const k = e.key;
    const shift = e.shiftKey, ctrl = e.ctrlKey || e.metaKey;
    const info = editInfo();
    const move = (to, extend) => { edit.caret = clamp(to, 0, st.chars.length - 1); if (!extend) edit.anchor = edit.caret; caretOn = true; followCaret(); schedule(); refreshRibbonSoon(); };
    const hasSel = edit.caret !== edit.anchor;
    const a = Math.min(edit.caret, edit.anchor), b = Math.max(edit.caret, edit.anchor);
    if (k === "ArrowLeft" || k === "ArrowRight") {
      e.preventDefault();
      const d = k === "ArrowLeft" ? -1 : 1;
      if (!shift && hasSel) return move(d < 0 ? a : b, false);
      let to = edit.caret + d;
      if (ctrl) { to = d < 0 ? wordBounds(st, Math.max(0, edit.caret - 1))[0] : wordBounds(st, edit.caret)[1]; if (to === edit.caret) to += d; }
      return move(to, shift);
    }
    if (k === "ArrowUp" || k === "ArrowDown" || k === "PageUp" || k === "PageDown") {
      e.preventDefault();
      if (ctrl && (k === "ArrowUp" || k === "ArrowDown")) { // paragrafo precedente / successivo
        const [ps, pe] = paraBounds(st, edit.caret);
        return move(k === "ArrowUp" ? (edit.caret > ps ? ps : paraBounds(st, Math.max(0, ps - 1))[0]) : Math.min(pe + 1, st.chars.length - 1), shift);
      }
      if (!info) return;
      const cp = caretPos(info.layout, edit.caret);
      if (!cp) return;
      const steps = k.startsWith("Page") ? 15 : 1;
      let li = cp.line;
      for (let s = 0; s < steps; s++) li += k === "ArrowUp" || k === "PageUp" ? -1 : 1;
      li = clamp(li, 0, info.layout.lines.length - 1);
      if (li === cp.line) return move(k === "ArrowUp" || k === "PageUp" ? 0 : st.chars.length - 1, shift);
      const L = info.layout.lines[li];
      return move(offInLine(L, edit.goalX ?? cp.x), shift) || (edit.goalX = edit.goalX ?? cp.x);
    }
    edit.goalX = null;
    if (k === "Home" || k === "End") {
      e.preventDefault();
      if (ctrl) return move(k === "Home" ? 0 : st.chars.length - 1, shift);
      if (!info) return;
      const cp = caretPos(info.layout, edit.caret);
      if (!cp) return;
      const L = info.layout.lines[cp.line];
      let to = k === "Home" ? L.start : L.end - 1;
      if (k === "End" && !/[\n\u2028]/.test(st.chars[L.end - 1]?.c || "") && L.end - 1 < st.chars.length - 1) to = L.end;
      if (k === "End") while (to > L.start && st.chars[to - 1]?.c === " " && to === L.end) to--;
      return move(to, shift);
    }
    if (k === "Backspace" || k === "Delete") {
      e.preventDefault();
      if (hasSel) { edit.caret = edit.anchor = deleteRange(st, a, b); }
      else if (k === "Backspace" && edit.caret > 0) {
        const from = ctrl ? wordBounds(st, edit.caret - 1)[0] : edit.caret - 1;
        edit.caret = edit.anchor = deleteRange(st, from, edit.caret);
      } else if (k === "Delete" && edit.caret < st.chars.length - 1) {
        const to = ctrl ? wordBounds(st, edit.caret)[1] : edit.caret + 1;
        deleteRange(st, edit.caret, to);
      }
      commit(tr("pubedit.elimina_testo"), "type");
      return;
    }
    if (k === "Enter") {
      e.preventDefault();
      typeText(shift ? "\u000b" : "\n");
      return;
    }
    if (k === "Tab") {
      e.preventDefault();
      if (edit.kind === "cell") { nextCell(shift ? -1 : 1); return; }
      typeText("\t");
      return;
    }
    if (k === "Escape") { e.preventDefault(); const o = edit.o; endEdit(); sel = [o]; refreshAll(); return; }
    if (ctrl && !e.altKey && k.toLowerCase() === "a") { e.preventDefault(); edit.anchor = 0; edit.caret = st.chars.length - 1; refreshAll(); return; }
  });
  sink.addEventListener("beforeinput", e => {
    if (!edit) {
      // si scrive con una casella di testo selezionata: il testo va in fondo alla casella
      if (e.inputType === "insertText" && sel.length === 1 && sel[0].type === "text" && e.data) { beginEdit(sel[0]); }
      else if (e.inputType === "insertText" && sel.length === 1 && sel[0].type === "wordart") { e.preventDefault(); E.editWordArt(); return; }
      else { e.preventDefault(); return; }
    }
    if (e.inputType === "insertText" && e.data) { e.preventDefault(); typeText(e.data); }
    else if (e.inputType === "insertCompositionText") { /* IME: si inserisce alla fine (compositionend) */ }
    else if (e.inputType !== "insertFromPaste") e.preventDefault();
  });
  sink.addEventListener("compositionend", e => { if (edit && e.data) typeText(e.data); sink.value = ""; });
  function typeText(t) {
    const st = doc.stories[edit.story];
    const a = Math.min(edit.caret, edit.anchor), b = Math.max(edit.caret, edit.anchor);
    const s = edit.pending || styleAt(st, a);
    if (a !== b) deleteRange(st, a, b);
    edit.caret = edit.anchor = insertText(st, a, t, s);
    edit.pending = null;
    sink.value = "";
    caretOn = true;
    commit(tr("pubedit.digita"), "type");
    followCaret();
  }
  function nextCell(d) {
    const o = edit.o;
    let r = edit.r, c = edit.c + d;
    if (c >= o.cols) { c = 0; r++; } else if (c < 0) { c = o.cols - 1; r--; }
    if (r >= o.rows) { if (d > 0) { E.tableOp("rowBelow"); r = o.rows - 1; c = 0; } else return; }
    if (r < 0) return;
    beginEdit(o, 0, "cell", r, c);
    const st = doc.stories[edit.story];
    edit.anchor = 0; edit.caret = st.chars.length - 1;
    refreshAll();
  }
  // il cursore va su un'altra pagina (testo collegato): si segue
  function followCaret() {
    const info = editInfo();
    if (!info) return;
    const cp = caretPos(info.layout, edit.caret);
    if (!cp) return;
    const c = info.conts[cp.cont];
    if (c && c.pi >= 0 && c.pi !== cur && !masterId) { cur = c.pi; thumbsLater(); }
    if (c && c.o !== edit.o && edit.kind === "frame") { edit.o = c.o; sel = [c.o]; }
  }
  sink.addEventListener("copy", e => clipboardOut(e, false));
  sink.addEventListener("cut", e => clipboardOut(e, true));
  sink.addEventListener("paste", e => { e.preventDefault(); clipboardIn(e.clipboardData); });
  function clipboardOut(e, cut) {
    e.preventDefault();
    if (edit) {
      const st = doc.stories[edit.story];
      const a = Math.min(edit.caret, edit.anchor), b = Math.max(edit.caret, edit.anchor);
      if (a === b) return;
      const chars = sliceChars(st, a, b);
      const plain = chars.map(ch => (ch.c === "\n" ? "\r\n" : ch.c === LS ? "\n" : ch.c === FIELD ? "" : ch.c)).join("");
      textClip = { plain, chars };
      e.clipboardData.setData("text/plain", plain);
      if (cut) { edit.caret = edit.anchor = deleteRange(st, a, b); commit(tr("common.taglia")); }
      return;
    }
    if (!sel.length) return;
    const texts = sel.filter(o => o.type === "text").map(o => storyText(doc.stories[o.story]));
    objClip = { items: JSON.parse(JSON.stringify(sel)), stories: Object.fromEntries([...new Set([...walk(sel)].flatMap(o => [o.story, ...(o.cells || []).flat().map(c => c.story)]).filter(Boolean))].map(id => [id, { id, chars: doc.stories[id]?.chars.slice() || [] }])), mark: "[MBV-pub:" + Date.now() + "]", images: doc.images };
    e.clipboardData.setData("text/plain", texts.join("\r\n") || objClip.mark);
    objClip.plain = texts.join("\r\n") || objClip.mark;
    if (cut) { deleteSel(); }
  }
  async function clipboardIn(dt) {
    const plain = dt?.getData("text/plain") || "";
    const files = [...(dt?.files || [])].filter(f => f.type.startsWith("image/"));
    if (edit) {
      const st = doc.stories[edit.story];
      const a = Math.min(edit.caret, edit.anchor), b = Math.max(edit.caret, edit.anchor);
      if (a !== b) deleteRange(st, a, b);
      if (textClip && textClip.plain.replace(/\r/g, "") === plain.replace(/\r/g, "")) edit.caret = edit.anchor = insertChars(st, a, textClip.chars);
      else edit.caret = edit.anchor = insertText(st, a, plain, styleAt(st, a));
      commit(tr("common.incolla"));
      followCaret();
      return;
    }
    if (files.length) { for (const f of files) await E.placeImageBytes(new Uint8Array(await f.arrayBuffer()), f.type, f.name || tr("pubedit.immagine_incollata")); return; }
    if (objClip && (plain === objClip.plain || !plain)) { pasteObjects(); return; }
    if (plain) {
      const o = textBox(doc, doc.w / 2 - 120, doc.h / 2 - 60, 240, 120, plain.replace(/\r/g, "").split("\n").map(t => [t, "Normale"]));
      addObj(o);
      commit(tr("pubedit.incolla_testo"));
    }
  }
  function pasteObjects() {
    if (!objClip) return;
    const src = { stories: objClip.stories, images: objClip.images };
    const copies = cloneItems(doc, objClip.items, src);
    for (const o of copies) { moveObj(o, 12, 12); items().push(o); }
    objClip.items = JSON.parse(JSON.stringify(copies)); // incolla di nuovo = ancora piu' spostato
    objClip.stories = Object.fromEntries(copies.flatMap(o => [...walk([o])]).flatMap(o => [o.story, ...(o.cells || []).flat().map(c => c.story)]).filter(Boolean).map(id => [id, { id, chars: doc.stories[id].chars.slice() }]));
    endEdit(); sel = copies; inGroup = null;
    commit(tr("common.incolla"));
  }

  // ------------------------------------------------------------ operazioni sugli oggetti
  function deleteSel() {
    if (!sel.length) return;
    for (const o of sel) {
      // caselle collegate: la catena si richiude senza la casella eliminata
      for (const x of walk([o])) if (x.type === "text") {
        const prev = allItems(doc).find(y => y.type === "text" && y.next === x.id);
        if (prev) prev.next = x.next || null;
      }
      const par = parentOf(o);
      if (par) { par.list.splice(par.list.indexOf(o), 1); if (par.group) { if (!par.group.items.length) { const pp = parentOf(par.group); pp.list.splice(pp.list.indexOf(par.group), 1); } else fixParents(par.group.items[0]); } }
    }
    sel = []; inGroup = null; crop = null; endEdit();
    commit(tr("common.elimina"));
  }
  function group() {
    if (sel.length < 2) return;
    const list = items();
    const ord = sel.filter(o => list.includes(o)).sort((a, b) => list.indexOf(a) - list.indexOf(b));
    if (ord.length < 2) return;
    const at = list.indexOf(ord[ord.length - 1]);
    const g = { id: newId(doc, "o"), type: "group", items: ord, x: 0, y: 0, w: 0, h: 0, rot: 0, wrap: "none" };
    fixGroup(g);
    for (const o of ord) list.splice(list.indexOf(o), 1);
    list.splice(Math.min(at - ord.length + 1, list.length), 0, g);
    sel = [g]; inGroup = null;
    commit(tr("pubedit.raggruppa"));
  }
  function ungroup() {
    const list = items();
    const gs = sel.filter(o => o.type === "group" && list.includes(o));
    if (!gs.length) return;
    const out = [];
    for (const g of gs) { const k = list.indexOf(g); list.splice(k, 1, ...g.items); out.push(...g.items); }
    sel = out; inGroup = null;
    commit(tr("pubedit.separa"));
  }
  function order(kind) {
    const par = sel.length ? parentOf(sel[0]) : null;
    if (!par) return;
    const list = par.list;
    const mine = sel.filter(o => list.includes(o)).sort((a, b) => list.indexOf(a) - list.indexOf(b));
    if (kind === "front") { for (const o of mine) { list.splice(list.indexOf(o), 1); list.push(o); } }
    else if (kind === "backmost") { for (const o of [...mine].reverse()) { list.splice(list.indexOf(o), 1); list.unshift(o); } }
    else if (kind === "fwd") { for (const o of [...mine].reverse()) { const k = list.indexOf(o); if (k < list.length - 1 && !mine.includes(list[k + 1])) { list.splice(k, 1); list.splice(k + 1, 0, o); } } }
    else if (kind === "back") { for (const o of mine) { const k = list.indexOf(o); if (k > 0 && !mine.includes(list[k - 1])) { list.splice(k, 1); list.splice(k - 1, 0, o); } } }
    commit({ front: tr("pubedit.porta_primo_piano"), backmost: tr("pubedit.porta_secondo_piano"), fwd: tr("pubedit.porta_avanti"), back: tr("pubedit.porta_indietro") }[kind]);
  }
  function alignSel(kind, toMargins) {
    if (!sel.length) return;
    const single = sel.length === 1 || toMargins;
    const M = doc.margins;
    const ref = single ? (toMargins ? { x0: M.l, y0: M.t, x1: doc.w - M.r, y1: doc.h - M.b } : { x0: 0, y0: 0, x1: doc.w, y1: doc.h }) : selBox();
    for (const o of sel) {
      const b = aabb(o);
      let dx = 0, dy = 0;
      if (kind === "l") dx = ref.x0 - b.x0; else if (kind === "c") dx = (ref.x0 + ref.x1) / 2 - (b.x0 + b.x1) / 2; else if (kind === "r") dx = ref.x1 - b.x1;
      else if (kind === "t") dy = ref.y0 - b.y0; else if (kind === "m") dy = (ref.y0 + ref.y1) / 2 - (b.y0 + b.y1) / 2; else if (kind === "b") dy = ref.y1 - b.y1;
      moveObj(o, dx, dy); fixParents(o);
    }
    commit(tr("pubedit.allinea"));
  }
  function distribute(dir) {
    if (sel.length < 3) { toast(tr("pubedit.seleziona_almeno_tre_oggetti_distribuire"), true); return; }
    const bs = sel.map(o => ({ o, b: aabb(o) })).sort((p, q) => (dir === "h" ? p.b.x0 - q.b.x0 : p.b.y0 - q.b.y0));
    const first = bs[0].b, last = bs[bs.length - 1].b;
    const total = bs.reduce((s, x) => s + (dir === "h" ? x.b.x1 - x.b.x0 : x.b.y1 - x.b.y0), 0);
    const space = ((dir === "h" ? last.x1 - first.x0 : last.y1 - first.y0) - total) / (bs.length - 1);
    let pos = dir === "h" ? first.x0 : first.y0;
    for (const x of bs) {
      const d = pos - (dir === "h" ? x.b.x0 : x.b.y0);
      moveObj(x.o, dir === "h" ? d : 0, dir === "h" ? 0 : d); fixParents(x.o);
      pos += (dir === "h" ? x.b.x1 - x.b.x0 : x.b.y1 - x.b.y0) + space;
    }
    commit(tr("pubedit.distribuisci"));
  }
  function rotateSel(how) {
    if (!sel.length) return;
    const b = selBox(), cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    for (const o of sel) {
      if (how === "flipH" || how === "flipV") {
        if (isLine(o)) { o.flipV = !o.flipV; continue; }
        if (o.type === "text" || o.type === "table") { o.rot = ((o.rot || 0) + 180) % 360; continue; }
        if (how === "flipH") o.flipH = !o.flipH; else o.flipV = !o.flipV;
        continue;
      }
      if (o.type === "group" || sel.length > 1) rotateAround(o, copyGeom(o), cx, cy, how);
      else o.rot = ((((o.rot || 0) + how) % 360) + 360) % 360;
      fixParents(o);
    }
    commit(typeof how === "number" ? tr("pubedit.ruota") : tr("pubedit.capovolgi"));
  }
  function nudge(dx, dy) {
    if (!sel.length || edit) return false;
    for (const o of sel) { moveObj(o, dx, dy); fixParents(o); }
    commit(tr("pubedit.sposta"), "nudge");
    return true;
  }
  function dup() {
    if (!sel.length) return;
    const copies = cloneItems(doc, sel);
    for (const o of copies) { moveObj(o, 12, 12); items().push(o); }
    sel = copies; inGroup = null;
    commit(tr("pubedit.duplica"));
  }

  // ------------------------------------------------------------ formattazione del testo
  // destinazione: selezione nel testo, oppure tutte le storie delle caselle selezionate
  function textTargets() {
    if (edit) {
      const a = Math.min(edit.caret, edit.anchor), b = Math.max(edit.caret, edit.anchor);
      return [{ st: doc.stories[edit.story], a, b, caret: a === b }];
    }
    const out = [];
    for (const o of walk(sel)) {
      if (o.type === "text" || o.story) { const st = doc.stories[o.story]; if (st) out.push({ st, a: 0, b: st.chars.length, caret: false }); }
      if (o.type === "table") for (const row of o.cells) for (const c of row) { const st = doc.stories[c.story]; if (st) out.push({ st, a: 0, b: st.chars.length, caret: false }); }
    }
    // le storie collegate si contano una volta
    return out.filter((t, k) => out.findIndex(u => u.st === t.st) === k);
  }
  function charStyle() {
    if (edit) {
      const st = doc.stories[edit.story];
      if (edit.pending) return edit.pending;
      const a = Math.min(edit.caret, edit.anchor), b = Math.max(edit.caret, edit.anchor);
      return a === b ? styleAt(st, a) : st.chars[a].s;
    }
    const t = textTargets()[0];
    return t ? t.st.chars[0].s : null;
  }
  function paraStyle() {
    if (edit) return paraAt(doc.stories[edit.story], Math.min(edit.caret, edit.anchor));
    const t = textTargets()[0];
    return t ? paraAt(t.st, 0) : null;
  }
  function applyChar(patch, label = tr("pubedit.formato_carattere")) {
    const fn = typeof patch === "function" ? patch : s => ({ ...s, ...patch });
    if (sel.length && !edit && sel.every(o => o.type === "wordart")) {
      // WordArt: carattere, grassetto, corsivo
      for (const o of sel) { const s = fn({ f: o.font, b: o.b, i: o.i, c: o.fill }); o.font = s.f; o.b = !!s.b; o.i = !!s.i; if (s.c && typeof patch === "object" && "c" in patch) o.fill = s.c; }
      commit(label); return;
    }
    const ts = textTargets();
    if (!ts.length) return;
    for (const t of ts) {
      if (t.caret) { edit.pending = S(fn({ ...(edit.pending || styleAt(t.st, t.a)) })); refreshAll(); schedule(); return; }
      mapCharStyle(t.st, t.a, t.b, fn);
    }
    commit(label);
  }
  function toggleChar(k, label) { const v = !charStyle()?.[k]; applyChar(s => ({ ...s, [k]: v || undefined }), label); }
  function applyPara(patch, label = tr("pubedit.formato_paragrafo")) {
    const ts = textTargets();
    if (!ts.length) return;
    for (const t of ts) setParaStyle(t.st, t.a, Math.max(t.a, t.b - (t.b > t.a ? 1 : 0)), typeof patch === "function" ? patch(paraAt(t.st, t.a)) : patch);
    commit(label);
  }
  function applyStyle(name) {
    const def = doc.styles[name];
    if (!def) return;
    const ts = textTargets();
    for (const t of ts) {
      // lo stile vale per i paragrafi interi
      const [pa] = paraBounds(t.st, t.a);
      const [, pb] = paraBounds(t.st, Math.max(t.a, t.b - (t.b > t.a ? 1 : 0)));
      setCharStyle(t.st, pa, pb + 1, {});
      for (let k = pa; k <= pb; k++) t.st.chars[k] = { ...t.st.chars[k], s: S(charPart(def)) };
      setParaStyle(t.st, pa, pb, {});
      for (let k = pa; k <= pb; k++) if (t.st.chars[k].c === "\n") t.st.chars[k] = { ...t.st.chars[k], p: S(paraPart(def, name)) };
    }
    if (edit) edit.pending = null;
    commit(tr("pubedit.stile") + name);
  }
  function growFont(d) {
    const steps = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72, 96, 120, 144];
    applyChar(s => {
      const z = s.z || 10;
      const nz = d > 0 ? steps.find(v => v > z + 0.01) || Math.round(z * 1.1) : [...steps].reverse().find(v => v < z - 0.01) || Math.max(1, Math.round(z * 0.9));
      return { ...s, z: Math.abs(d) === 1 ? nz : clamp(z + Math.sign(d), 1, 999) };
    }, d > 0 ? tr("pubedit.aumenta_dimensione_carattere") : tr("pubedit.riduci_dimensione_carattere"));
  }

  // ------------------------------------------------------------ tasti (come Publisher)
  const otherField = () => { const a = document.activeElement; return a && a !== sink && a.matches?.("input, select, textarea, [contenteditable]"); };
  const noEdit = () => !edit && !otherField();
  const always = () => !otherField();
  const defs = [];
  const K = (keys, desc, run, group, when = noEdit) => defs.push({ keys, desc, run, group, when, inFields: true });
  K("Ctrl+Z", tr("common.annulla_op"), () => undo(), tr("pubedit.modifica"), always);
  K("Ctrl+Y|Ctrl+Shift+Z", tr("common.ripeti"), () => redo(), tr("pubedit.modifica"), always);
  K("Delete|Backspace", tr("pubedit.elimina_oggetti_selezionati"), () => deleteSel(), tr("pubedit.oggetti"));
  K("Ctrl+D", tr("pubedit.duplica_oggetti_selezionati"), () => dup(), tr("pubedit.oggetti"));
  K("Ctrl+G", tr("pubedit.raggruppa"), () => group(), tr("pubedit.oggetti"));
  K("Ctrl+Shift+G", tr("pubedit.separa_annulla_raggruppamento"), () => ungroup(), tr("pubedit.oggetti"));
  K("Ctrl+A", tr("pubedit.seleziona_tutti_oggetti_pagina"), () => { sel = items().slice(); inGroup = null; refreshAll(); }, tr("pubedit.oggetti"));
  K("Escape", tr("pubedit.deseleziona_esci_gruppo_annulla_strumento"), () => { if (tool) { tool = null; stage.classList.remove("pb-pour"); refreshAll(); return; } if (crop) { crop = null; refreshAll(); return; } if (inGroup) { sel = [inGroup]; inGroup = null; refreshAll(); return; } sel = []; refreshAll(); }, tr("pubedit.oggetti"));
  for (const [key, dx, dy] of [["ArrowLeft", -1, 0], ["ArrowRight", 1, 0], ["ArrowUp", 0, -1], ["ArrowDown", 0, 1]]) {
    K(key, tr("pubedit.sposta_l_oggetto_1_mm"), () => nudge(dx * MM, dy * MM), tr("pubedit.oggetti"));
    K("Ctrl+" + key + "|Alt+" + key, tr("pubedit.sposta_l_oggetto_poco_1"), () => nudge(dx / zoom, dy / zoom), tr("pubedit.oggetti"));
  }
  K("Ctrl+B", tr("pubedit.grassetto"), () => toggleChar("b", tr("pubedit.grassetto")), tr("pubedit.testo"), always);
  K("Ctrl+I", tr("pubedit.corsivo"), () => toggleChar("i", tr("pubedit.corsivo")), tr("pubedit.testo"), always);
  K("Ctrl+U", tr("pubedit.sottolineato"), () => toggleChar("u", tr("pubedit.sottolineato")), tr("pubedit.testo"), always);
  K("Ctrl+Shift+>|Ctrl+Shift+.", tr("pubedit.aumenta_dimensione_carattere"), () => growFont(1), tr("pubedit.testo"), always);
  K("Ctrl+<|Ctrl+Shift+<|Ctrl+Shift+,", tr("pubedit.riduci_dimensione_carattere"), () => growFont(-1), tr("pubedit.testo"), always);
  K("Ctrl+]", tr("pubedit.aumenta_carattere_1_punto"), () => growFont(2), tr("pubedit.testo"), always);
  K("Ctrl+[", tr("pubedit.riduci_carattere_1_punto"), () => growFont(-2), tr("pubedit.testo"), always);
  K("Ctrl+L", tr("pubedit.allinea_sinistra"), () => applyPara({ a: "l" }, tr("pubedit.allinea_sinistra")), tr("pubedit.paragrafo"), always);
  K("Ctrl+E", tr("pubedit.centra"), () => applyPara({ a: "c" }, tr("pubedit.centra")), tr("pubedit.paragrafo"), always);
  K("Ctrl+R", tr("pubedit.allinea_destra"), () => applyPara({ a: "r" }, tr("pubedit.allinea_destra")), tr("pubedit.paragrafo"), always);
  K("Ctrl+J", tr("pubedit.giustifica"), () => applyPara({ a: "j" }, tr("pubedit.giustifica")), tr("pubedit.paragrafo"), always);
  K("Ctrl+1", tr("pubedit.interlinea_singola"), () => applyPara({ lh: 1 }, tr("pubedit.interlinea")), tr("pubedit.paragrafo"), always);
  K("Ctrl+5", "Interlinea 1,5", () => applyPara({ lh: 1.5 }, tr("pubedit.interlinea")), tr("pubedit.paragrafo"), always);
  K("Ctrl+2", tr("pubedit.interlinea_doppia"), () => applyPara({ lh: 2 }, tr("pubedit.interlinea")), tr("pubedit.paragrafo"), always);
  K("Ctrl+Space", tr("pubedit.rimuovi_formattazione_caratteri"), () => E.clearFormat(), tr("pubedit.testo"), always);
  K("Ctrl+Shift+C", tr("pubedit.copia_formato"), () => E.copyFormat(), tr("pubedit.testo"), always);
  K("Ctrl+Shift+V", tr("pubedit.incolla_formato"), () => E.pasteFormat(), tr("pubedit.testo"), always);
  K("Shift+F3", tr("pubedit.maiuscole_minuscole"), () => E.changeCase(), tr("pubedit.testo"), always);
  K("Ctrl+Shift+N", tr("pubedit.inserisci_nuova_pagina"), () => E.addPage(false), tr("pubedit.pagine"), always);
  K("Ctrl+Shift+U", tr("pubedit.inserisci_pagina_duplicata"), () => E.addPage(true), tr("pubedit.pagine"), always);
  K("Ctrl+PageDown", tr("pubedit.pagina_successiva"), () => E.gotoPage(cur + 1), tr("pubedit.pagine"), always);
  K("Ctrl+PageUp", tr("pubedit.pagina_precedente"), () => E.gotoPage(cur - 1), tr("pubedit.pagine"), always);
  K("F5", tr("pubedit.vai_pagina"), () => E.gotoPageDlg(), tr("pubedit.pagine"), always);
  K("Ctrl+M", tr("pubedit.pagina_master_torna_pubblicazione"), () => E.toggleMaster(), tr("pubedit.pagine"), always);
  K("F9", tr("pubedit.zoom_100_zoom_precedente"), () => { if (Math.abs(zoomPct() - 100) < 1 && prevZoom) { zoom = prevZoom.z; panX = prevZoom.x; panY = prevZoom.y; schedule(); status(); } else { prevZoom = { z: zoom, x: panX, y: panY }; setZoom(PX); } }, tr("pubedit.visualizza"), always);
  K("Ctrl+Shift+L", tr("pubedit.zoom_pagina_intera"), () => fitPage(), tr("pubedit.visualizza"), always);
  K("Ctrl+Plus", tr("pubedit.zoom_avanti"), () => zoomStep(1), tr("pubedit.visualizza"), always);
  K("Ctrl+Minus", tr("pubedit.zoom_indietro"), () => zoomStep(-1), tr("pubedit.visualizza"), always);
  K("Ctrl+Shift+O", tr("pubedit.mostra_nascondi_i_limiti_oggetti"), () => E.toggleShow("bounds"), tr("pubedit.visualizza"), always);
  K("Ctrl+Shift+Y", tr("pubedit.mostra_nascondi_i_caratteri_speciali"), () => E.toggleShow("marks"), tr("pubedit.visualizza"), always);
  K("Ctrl+F", tr("pubedit.trova"), () => E.openFind(false), tr("pubedit.modifica"), always);
  K("Ctrl+H", tr("pubedit.sostituisci"), () => E.openFind(true), tr("pubedit.modifica"), always);
  K("F7", tr("pubedit.controllo_ortografia"), () => E.spell(), tr("pubedit.revisione"), always);
  K("Ctrl+K", tr("pubedit.collegamento_ipertestuale"), () => E.hyperlink(), tr("pubedit.inserisci_2"), always);
  K("Ctrl+Shift+D", tr("pubedit.inserisci_data"), () => E.insertField("date"), tr("pubedit.inserisci_2"), () => !!edit);
  K("Alt+Shift+P", tr("pubedit.inserisci_numero_pagina"), () => E.insertField("page"), tr("pubedit.inserisci_2"), () => !!edit);
  K("F4", tr("pubedit.ripeti_l_ultima_azione_formattazione"), () => E.repeatLast?.(), tr("pubedit.modifica"), always);
  keymap(ctx, "Publisher", defs, window);
  describeKeys(ctx, "Publisher", [
    ["Ctrl+C / Ctrl+X / Ctrl+V", tr("pubedit.copia_taglia_incolla_testo_oggetti"), tr("pubedit.modifica")],
    ["Invio / Maiusc+Invio", tr("pubedit.nuovo_paragrafo_capo_nello_stesso"), tr("pubedit.testo")],
    ["Tab", tr("pubedit.tabulazione_nelle_tabelle_cella_successiva"), tr("pubedit.testo")],
    ["Ctrl+← / Ctrl+→", tr("pubedit.parola_precedente_successiva"), tr("pubedit.testo")], ["Ctrl+↑ / Ctrl+↓", tr("pubedit.paragrafo_precedente_successivo"), tr("pubedit.testo")],
    ["Ctrl+Home / Ctrl+Fine", tr("pubedit.inizio_fine_storia_anche_nelle"), tr("pubedit.testo")],
    ["Ctrl+Backspace / Ctrl+Canc", tr("pubedit.cancella_parola"), tr("pubedit.testo")], ["Esc", tr("pubedit.esci_modifica_testo_seleziona_casella"), tr("pubedit.testo")],
    [tr("pubedit.ctrl_testo"), tr("pubedit.seleziona_tutto_testo_storia"), tr("pubedit.testo")],
    [tr("pubedit.doppio_clic_triplo_clic"), tr("pubedit.seleziona_parola_paragrafo"), tr("pubedit.testo")],
    [tr("pubedit.maiusc_durante_spostamento"), tr("pubedit.solo_orizzontale_verticale"), tr("pubedit.oggetti")], [tr("pubedit.maiusc_maniglia_d_angolo"), tr("pubedit.mantiene_proporzioni_sulle_immagini_libera"), tr("pubedit.oggetti")],
    [tr("pubedit.ctrl_maniglia"), tr("pubedit.ridimensiona_centro"), tr("pubedit.oggetti")], [tr("pubedit.maiusc_rotazione"), tr("pubedit.ruota_passi_15"), tr("pubedit.oggetti")], [tr("pubedit.alt_durante_spostamento"), tr("pubedit.disattiva_temporaneamente_l_aggancio"), tr("pubedit.oggetti")],
    [tr("pubedit.clic_gruppo_poi_clic_sull"), tr("pubedit.seleziona_oggetto_dentro_gruppo"), tr("pubedit.oggetti")],
    [tr("pubedit.trascina_righello"), tr("pubedit.crea_guida_trascinala_fuori_pagina"), tr("pubedit.guide")],
    [tr("pubedit.ctrl_rotella_alt_rotella"), tr("pubedit.zoom_punto_puntatore"), tr("pubedit.visualizza")], [tr("pubedit.rotella_maiusc_rotella"), tr("pubedit.scorri_verticale_orizzontale"), tr("pubedit.visualizza")],
  ]);

  // ------------------------------------------------------------ aggiornamento dell'interfaccia
  let ribbon = null, ribTimer = 0;
  function refreshRibbonSoon() { clearTimeout(ribTimer); ribTimer = setTimeout(() => ribbon?.refresh(), 60); }
  function refreshAll() { schedule(); status(); refreshRibbonSoon(); }
  setInterval(() => { if (edit && ctx.tab.view?.isConnected && !ctx.tab.view.hidden) { caretOn = !caretOn; schedule(); } }, 530);

  // ------------------------------------------------------------ interfaccia per la barra multifunzione
  Object.assign(E, {
    ctx, doc: () => doc, setDoc(d) { doc = d; images.clear(); cur = 0; masterId = null; sel = []; edit = null; crop = null; history = []; hi = -1; commit(tr("pubedit.nuovo_modello")); fitPage(); renderThumbs(); },
    sel: () => sel, edit: () => edit, cur: () => cur, masterId: () => masterId, tool: () => tool, show, snapOpt, zoomPct, spread: () => spread,
    commit, touch, refresh: refreshAll, focus: focusSink, schedule, message, items, page, selBox, relayout, layoutGuides,
    undo, redo, canUndo: () => hi > 0, canRedo: () => hi < history.length - 1, undoLabel: () => history[hi]?.label || "",
    charStyle, paraStyle, applyChar, toggleChar, applyPara, applyStyle, growFont, textTargets,
    deleteSel, dup, group, ungroup, order, align: alignSel, distribute, rotate: rotateSel, addObj, fixParents, moveObj, beginEdit, endEdit, selectNone,
    setSel(list) { endEdit(); sel = list; inGroup = null; crop = null; refreshAll(); },
    setTool(t) { endEdit(); tool = t; crop = null; if (t !== "link") sel = []; message(t === "text" ? tr("pubedit.trascina_pagina_disegnare_casella_testo") : t ? tr("pubedit.trascina_pagina_disegnare_l_oggetto") : ""); refreshAll(); },
    setZoomPct: p => setZoom((p / 100) * PX), fitPage, fitWidth, zoomSel: zoomToSel, zoom100: () => setZoom(PX), zoomStep,
    setSpread(b) { spread = b; selectNone(); fitPage(); renderThumbs(); refreshAll(); },
    toggleShow(k) { show[k] = !show[k]; if (k === "pages") { pagesEl.hidden = !show.pages; main.classList.toggle("nopages", !show.pages); setTimeout(() => (autoFit ? fitPage() : schedule())); renderThumbs(); } refreshAll(); },
    gotoPage(i, keepView) {
      if (masterId) { masterId = null; }
      i = clamp(i, 0, doc.pages.length - 1);
      if (i === cur && !keepView) return;
      selectNone(); cur = i;
      if (!keepView && autoFit) fitPage();
      refreshAll(); renderThumbs();
    },
    toggleMaster(id) {
      selectNone();
      if (masterId && !id) masterId = null;
      else masterId = id || page().master || doc.masters[0]?.id;
      if (masterId && !doc.masters.find(m => m.id === masterId)) masterId = doc.masters[0]?.id || null;
      message(masterId ? tr("pubedit.pagina_master_oggetti_qui_compaiono") : "");
      touch(); refreshAll(); renderThumbs();
    },
    renderThumbs, thumbsLater, renderPageThumb, imgMap, images,
    linkStart() {
      const o = sel[0];
      if (!o || o.type !== "text") { toast(tr("pubedit.seleziona_casella_testo"), true); return; }
      E._linkSrc = (() => { const ent = relayout().frames.get(o.id); return ent ? lay.byId.get(ent.layout.chain[ent.layout.chain.length - 1]) : o; })();
      endEdit(); tool = "link"; stage.classList.add("pb-pour");
      message(tr("pubedit.fai_clic_casella_testo_vuota"), 0);
      refreshAll();
    },
    unlink() {
      const o = sel[0];
      if (!o || o.type !== "text" || !o.next) return;
      const nx = lay.byId.get(o.next);
      o.next = null;
      if (nx) {
        const id = copyStory(doc, null);
        for (let f = nx, g = 0; f && g < 500; f = f.next ? lay.byId.get(f.next) : null, g++) f.story = id;
      }
      commit(tr("pubedit.interrompi_collegamento"));
    },
    gotoLinked(dir) {
      const o = sel[0];
      const ent = o && relayout().frames.get(o.id);
      if (!ent) return;
      const k = ent.layout.chain.indexOf(o.id) + (dir === "next" ? 1 : -1);
      const t = lay.byId.get(ent.layout.chain[k]);
      if (!t) return;
      const pi = pageOfObj(t);
      if (pi >= 0 && pi !== cur) { cur = pi; renderThumbs(); }
      endEdit(); sel = [t]; refreshAll();
    },
    cropToggle() {
      const o = sel[0];
      if (crop) { crop = null; refreshAll(); return; }
      if (!o || o.type !== "image" || !o.img) { toast(tr("pubedit.seleziona_immagine_ritagliare"), true); return; }
      if (o.rot) toast(tr("pubedit.ritaglio_immagine_ruotata_maniglie_seguono"), false);
      crop = o; message(tr("pubedit.trascina_maniglie_nere_ritagliare_trascina"), 0);
      refreshAll();
    },
    crop: () => crop,
    setCurPage(i) { cur = clamp(i, 0, doc.pages.length - 1); },
    mergeState: () => ({ idx: mergeIdx, preview: mergePreview }),
    setMerge(idx, preview) { mergeIdx = idx; mergePreview = preview; touch(); refreshAll(); thumbsLater(); },
    pageOfObj, editInfo, typeText: t => { if (edit) typeText(t); },
    insertChars(chars) { if (!edit) return; const st = doc.stories[edit.story]; const a = Math.min(edit.caret, edit.anchor), b = Math.max(edit.caret, edit.anchor); if (a !== b) deleteRange(st, a, b); edit.caret = edit.anchor = insertChars(st, a, chars); commit(tr("pubedit.inserisci_2")); },
    insertFieldChar(f) { if (!edit) return false; const st = doc.stories[edit.story]; const a = Math.min(edit.caret, edit.anchor), b = Math.max(edit.caret, edit.anchor); if (a !== b) deleteRange(st, a, b); edit.caret = edit.anchor = insertText(st, a, "", styleAt(st, a), f); commit(tr("pubedit.inserisci_campo")); return true; },
    selectText(story, a, b, o, kind = "frame", r = 0, c = 0) { endEdit(); const pi = pageOfObj(o); if (pi >= 0 && pi !== cur && !masterId) { cur = pi; renderThumbs(); } sel = [o]; beginEdit(o, b, kind, r, c); edit.anchor = a; edit.caret = b; followCaret(); refreshAll(); },
    get fmtClip() { return fmtClip; }, set fmtClip(v) { fmtClip = v; },
    deleteRangeInEdit() { if (!edit) return; const st = doc.stories[edit.story]; const a = Math.min(edit.caret, edit.anchor), b = Math.max(edit.caret, edit.anchor); edit.caret = edit.anchor = deleteRange(st, a, b); },
    pasteObjects, copySel() { const ev = { preventDefault() {}, clipboardData: { setData() {} } }; clipboardOut(ev, false); }, cutSel() { const ev = { preventDefault() {}, clipboardData: { setData() {} } }; clipboardOut(ev, true); },
    async pasteFromSystem() {
      try {
        const its = await navigator.clipboard.read();
        for (const it of its) {
          const imgType = it.types.find(t => t.startsWith("image/"));
          if (imgType && !edit) { const b = await it.getType(imgType); await E.placeImageBytes(new Uint8Array(await b.arrayBuffer()), imgType, tr("pubedit.immagine_incollata")); return; }
          if (it.types.includes("text/plain")) { const t = await (await it.getType("text/plain")).text(); await clipboardIn({ getData: () => t, files: [] }); return; }
        }
      } catch { if (objClip) pasteObjects(); else toast(tr("pubedit.usa_ctrl_v_incollare_dagli"), false); }
    },
  });

  installCommands(E, ctx);
  ribbon = buildRibbon(E, ctx, ribbonEl);

  // ------------------------------------------------------------ avvio
  history = [{ ...snap(), label: tr("pubedit.apri") }]; hi = 0;
  new ResizeObserver(() => { if (autoFit) fitPage(); else schedule(); }).observe(stage);
  renderThumbs();
  refreshAll();
  setTimeout(() => { fitPage(); focusSink(); }, 0);

  // per le prove dalla console (come tests/cad_harness.js)
  E._pb = { state: () => ({ cur, masterId, sel, edit, tool, zoom, panX, panY, history: history.map(h => h.label), hi, doc }), toPage, toScreen, canvas, stage, relayout };
  return E;
}
