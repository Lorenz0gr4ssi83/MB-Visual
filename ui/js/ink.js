// Annotazione a mano libera con la penna (Apple Pencil, S Pen, penne Windows), il dito o il mouse.
// Usata da PDF (annotazioni Ink nel file), disegni DWG/DXF (layer MARKUP) e immagini (livello "Annotazioni").
// - Pointer Events con pressione: lo spessore segue la pressione della penna (dito e mouse: spessore fisso)
// - rifiuto del palmo: appena si usa la penna il dito non disegna piu' (sposta e ingrandisce); contatti larghi ignorati
// - evidenziatore (tratto largo semitrasparente), gomma (toglie i tratti toccati), annulla/ripeti
// - doppio tocco con la punta della penna = passa allo strumento precedente (penna <-> gomma); il doppio tocco
//   sul corpo dell'Apple Pencil e lo "squeeze" non arrivano alle app web (Apple li da' solo alle app native):
//   la stessa funzione si ha con il doppio tocco della punta. Tasto laterale della S Pen o coda "gomma" = gomma.
// Coordinate dei tratti nelle unita' del documento (punti PDF, unita' del disegno, pixel dell'immagine), cosi'
// restano sul documento a ogni zoom. Superfici: una per pagina PDF, una sola per disegni e immagini.
import { el, loadCss, toast } from "./core.js";
import { t } from "./i18n.js";

const PEN_KEY = "mbv-ink-penna"; // la penna e' gia' stata usata su questo dispositivo: il dito non disegna
const OPT_KEY = "mbv-ink-opzioni";
export const COLORS = {
  pen: ["#14171a", "#d93025", "#1a73e8", "#188038", "#f07d2e"],
  hl: ["#ffe14d", "#7ee08a", "#ff8ad8", "#6ec8ff", "#ffb35c"],
};
const SIZES = { pen: [1.4, 2.6, 5], hl: [12, 20, 32] }; // pixel dello schermo al momento del tratto
export const HL_ALPHA = 0.38;

// spessore relativo dalla pressione (0..1): 0.5 = spessore nominale
export const pressureK = p => 0.3 + 1.4 * Math.min(1, Math.max(0, p));

const ICONS = {
  pen: '<svg viewBox="0 0 24 24"><path d="M4 20l1.2-4.6L15.8 4.8a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8z"/><path d="M14 6.6l3.4 3.4"/></svg>',
  hl: '<svg viewBox="0 0 24 24"><path d="M9 15l-3 3h5l1-1M9 15l7-10 4 3-7 10zM4 21h16"/></svg>',
  eraser: '<svg viewBox="0 0 24 24"><path d="M8.5 20H20M4.6 15.4l9.9-9.9a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 19H8.2z"/><path d="M9 11l5 5"/></svg>',
  finger: '<svg viewBox="0 0 24 24"><path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11m0-1.5a1.5 1.5 0 0 1 3 0V12m0-1a1.5 1.5 0 0 1 3 0v4a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L4 15.6a1.5 1.5 0 0 1 2.4-1.8L9 16"/></svg>',
  undo: '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3"/></svg>',
  redo: '<svg viewBox="0 0 24 24"><path d="M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  done: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
};
export const INK_ICON = ICONS.pen;

function loadOpts() {
  const d = { tool: "pen", color: { pen: COLORS.pen[1], hl: COLORS.hl[0] }, size: { pen: 1, hl: 1 }, finger: null };
  try { return { ...d, ...JSON.parse(localStorage.getItem(OPT_KEY) || "{}") }; } catch { return d; }
}

/**
 * opts:
 *  host        elemento (position: relative) dove compare la barra della penna
 *  surfaces()  [{ key, el, toDoc(lx, ly) -> [x, y], toLocal(x, y) -> [lx, ly] }] (lx, ly = pixel CSS relativi a el)
 *  nativeTouch true: le dita scorrono la pagina da sole; false (consigliato): le dita chiamano pan/zoom. Con lo scorrimento
 *              nativo Chrome annulla i tratti della penna (pointercancel) appena li prende per uno scorrimento.
 *  pan(dx, dy), zoom(f, cx, cy, clientX, clientY)  spostamento e zoom della vista (pixel CSS relativi alla superficie)
 *  onChange()  i tratti sono cambiati (documento modificato)
 *  onToggle(on)
 */
export function createInk(opts) {
  loadCss("css/ink.css");
  const O = loadOpts();
  let penSeen = (() => { try { return localStorage.getItem(PEN_KEY) === "1"; } catch { return false; } })();
  if (O.finger === null) O.finger = !penSeen;
  const strokes = [];
  const undoStack = [], redoStack = [];
  const layers = new Map(); // key -> { canvas, surf }
  let on = false, cur = null, prevTool = O.tool === "eraser" ? "pen" : "eraser", lastTap = null, tempEraser = false;
  const touches = new Map(); // dita in gesto (senza nativeTouch)
  let gesture = null;
  const saveOpts = () => { try { localStorage.setItem(OPT_KEY, JSON.stringify(O)); } catch { /* */ } };

  // ------------------------------------------------------------ barra
  const bar = el("div", { class: "ink-bar", hidden: true, role: "toolbar" });
  const tb = (key, title, fn) => { const b = el("button", { type: "button", class: "ink-b", title, "aria-label": title }); b.innerHTML = ICONS[key]; b.addEventListener("click", fn); return b; };
  const bPen = tb("pen", t("ink.penna"), () => setTool("pen"));
  const bHl = tb("hl", t("ink.evidenziatore"), () => setTool("hl"));
  const bEr = tb("eraser", t("ink.gomma"), () => setTool("eraser"));
  const swatches = el("div", { class: "ink-sw" });
  const sizes = el("div", { class: "ink-sz" });
  const bFinger = tb("finger", t("ink.dito"), () => { O.finger = !O.finger; saveOpts(); sync(); toast(O.finger ? t("ink.dito_on") : t("ink.dito_off"), false, 1800); });
  const bUndo = tb("undo", t("common.annulla_op"), () => undo());
  const bRedo = tb("redo", t("ink.ripeti"), () => redo());
  const bClear = tb("trash", t("ink.cancella_tutto"), () => clearAll());
  const bDone = el("button", { type: "button", class: "ink-done", title: t("ink.fine") });
  bDone.innerHTML = ICONS.done;
  bDone.append(el("span", {}, t("ink.fine")));
  bDone.addEventListener("click", () => toggle(false));
  bar.append(el("div", { class: "ink-g" }, bPen, bHl, bEr), el("i", { class: "ink-sep" }), swatches, el("i", { class: "ink-sep" }), sizes,
    el("i", { class: "ink-sep" }), el("div", { class: "ink-g" }, bFinger, bUndo, bRedo, bClear), bDone);
  opts.host.append(bar);

  function sync() {
    bPen.classList.toggle("on", O.tool === "pen");
    bHl.classList.toggle("on", O.tool === "hl");
    bEr.classList.toggle("on", O.tool === "eraser");
    bFinger.classList.toggle("on", !!O.finger);
    bUndo.disabled = !undoStack.length;
    bRedo.disabled = !redoStack.length;
    bClear.disabled = !strokes.length;
    const kind = O.tool === "hl" ? "hl" : "pen";
    swatches.innerHTML = "";
    for (const c of COLORS[kind]) {
      const b = el("button", { type: "button", class: "ink-c" + (O.color[kind] === c ? " on" : ""), title: c });
      b.style.setProperty("--c", c);
      b.addEventListener("click", () => { O.color[kind] = c; if (O.tool === "eraser") O.tool = kind; saveOpts(); sync(); });
      swatches.append(b);
    }
    sizes.innerHTML = "";
    SIZES[kind].forEach((s, i) => {
      const b = el("button", { type: "button", class: "ink-s" + (O.size[kind] === i ? " on" : ""), title: t("ink.spessore") + " " + (i + 1) },
        el("i", { style: { width: Math.min(22, 3 + s * (kind === "hl" ? 0.6 : 2.4)) + "px", height: Math.min(22, 3 + s * (kind === "hl" ? 0.6 : 2.4)) + "px", background: kind === "hl" ? O.color.hl : "currentColor" } }));
      b.addEventListener("click", () => { O.size[kind] = i; if (O.tool === "eraser") O.tool = kind; saveOpts(); sync(); });
      sizes.append(b);
    });
    swatches.classList.toggle("dim", O.tool === "eraser");
    sizes.classList.toggle("dim", O.tool === "eraser");
    for (const { canvas } of layers.values()) canvas.style.touchAction = touchAction();
  }
  function setTool(tool) { if (tool !== O.tool) prevTool = O.tool; O.tool = tool; saveOpts(); sync(); }
  const touchAction = () => (!on ? "auto" : opts.nativeTouch && !O.finger ? "pan-x pan-y pinch-zoom" : "none");

  // ------------------------------------------------------------ superfici e disegno
  function refresh() {
    const surfs = opts.surfaces() || [];
    const keep = new Set();
    for (const s of surfs) {
      keep.add(s.key);
      let L = layers.get(s.key);
      if (!L) { L = { canvas: makeCanvas(s.key), surf: s }; layers.set(s.key, L); }
      L.surf = s;
      if (L.canvas.parentNode !== s.el) s.el.append(L.canvas);
      draw(L);
    }
    for (const [k, L] of layers) if (!keep.has(k)) { L.canvas.remove(); layers.delete(k); }
  }
  function makeCanvas(key) {
    const c = document.createElement("canvas");
    c.className = "ink-layer";
    c.dataset.key = key;
    Object.assign(c.style, { position: "absolute", left: "0", top: "0", width: "100%", height: "100%", zIndex: "40", pointerEvents: on ? "auto" : "none", touchAction: touchAction() });
    c.addEventListener("pointerdown", e => down(e, key));
    c.addEventListener("pointermove", e => move(e, key));
    c.addEventListener("pointerup", e => up(e, key));
    c.addEventListener("pointercancel", e => up(e, key, true));
    c.addEventListener("contextmenu", e => e.preventDefault());
    // la penna non deve far scorrere la pagina (con touch-action "pan" Safari e Chrome la tratterebbero come un dito)
    c.addEventListener("touchstart", e => { if (on && (cur || [...e.touches].some(x => x.touchType === "stylus"))) e.preventDefault(); }, { passive: false });
    c.addEventListener("touchmove", e => { if (on && cur) e.preventDefault(); }, { passive: false });
    return c;
  }
  const local = (e, L) => { const r = L.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const unitPx = s => { const a = s.toLocal(0, 0), b = s.toLocal(1, 0); return Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; };

  function draw(L) {
    const c = L.canvas, s = L.surf, dpr = Math.min(devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const k = unitPx(s);
    for (const st of strokes) if (st.s === s.key) paint(g, st, s.toLocal, k);
    if (cur && cur.s === s.key) paint(g, cur, s.toLocal, k);
  }
  function repaint(key) { const L = layers.get(key); if (L) draw(L); }

  // ------------------------------------------------------------ puntatore
  function down(e, key) {
    if (!on) return;
    const L = layers.get(key);
    if (!L) return;
    if (e.pointerType === "pen" && !penSeen) {
      penSeen = true;
      try { localStorage.setItem(PEN_KEY, "1"); } catch { /* */ }
      if (O.finger) { O.finger = false; saveOpts(); sync(); toast(t("ink.penna_rilevata"), false, 3500); }
    }
    if (e.pointerType === "touch") {
      // palmo: contatto largo, oppure penna gia' sul foglio, oppure il dito non disegna
      const palm = (e.width > 40 && e.height > 40) || (cur && cur.pointerType === "pen");
      if (palm) { e.preventDefault(); return; }
      if (!O.finger || touches.size || (cur && cur.pointerType === "touch")) {
        if (cur && cur.pointerType === "touch") { cur = null; repaint(key); } // secondo dito: il tratto del primo diventa un gesto
        if (!opts.nativeTouch) startGesture(e, L);
        return;
      }
    } else if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    try { L.canvas.setPointerCapture(e.pointerId); } catch { /* */ }
    // tasto laterale della penna (S Pen) o coda gomma: gomma finche' e' premuto
    tempEraser = e.pointerType === "pen" && (e.button === 5 || e.button === 2 || (e.buttons & 32) || (e.buttons & 2));
    const tool = tempEraser ? "eraser" : O.tool;
    const [lx, ly] = local(e, L);
    const p = L.surf.toDoc(lx, ly);
    if (!p) return;
    const k = unitPx(L.surf);
    if (tool === "eraser") {
      cur = { eraser: true, s: key, pointerId: e.pointerType === "touch" ? e.pointerId : e.pointerId, pointerType: e.pointerType, removed: [] };
      eraseAt(key, p, 14 / k);
      return;
    }
    const kind = tool === "hl" ? "hl" : "pen";
    cur = { s: key, tool: kind, color: O.color[kind], o: kind === "hl" ? HL_ALPHA : 1, w: SIZES[kind][O.size[kind]] / k,
      pressure: e.pointerType === "pen", pts: [[p[0], p[1], pr(e)]], pointerId: e.pointerId, pointerType: e.pointerType, t0: performance.now(), sx: e.clientX, sy: e.clientY };
    repaint(key);
  }
  const pr = e => (e.pointerType === "pen" ? (e.pressure || 0.5) : 0.5);
  function move(e, key) {
    if (gesture && touches.has(e.pointerId)) return gestureMove(e);
    if (!cur || cur.pointerId !== e.pointerId) return;
    e.preventDefault();
    const L = layers.get(key);
    const evs = e.getCoalescedEvents?.() || [];
    const k = unitPx(L.surf);
    for (const ev of evs.length ? evs : [e]) {
      const [lx, ly] = local(ev, L);
      const p = L.surf.toDoc(lx, ly);
      if (!p) continue;
      if (cur.eraser) { eraseAt(key, p, 14 / k); continue; }
      const q = cur.pts[cur.pts.length - 1];
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) * k < 0.8) { q[2] = Math.max(q[2], pr(ev)); continue; }
      cur.pts.push([p[0], p[1], pr(ev)]);
    }
    if (!cur.eraser) repaint(key);
  }
  function up(e, key, cancel = false) {
    if (touches.has(e.pointerId)) return gestureEnd(e);
    if (!cur || cur.pointerId !== e.pointerId) return;
    const c = cur;
    cur = null;
    tempEraser = false;
    if (c.eraser) {
      if (c.removed.length) { undoStack.push({ remove: c.removed }); redoStack.length = 0; changed(); }
      return;
    }
    if (cancel) { repaint(key); return; }
    const isTap = c.pointerType === "pen" && performance.now() - c.t0 < 260 && Math.hypot(e.clientX - c.sx, e.clientY - c.sy) < 5;
    delete c.pointerId; delete c.t0; delete c.sx; delete c.sy;
    // doppio tocco della punta: niente puntini, si cambia strumento
    if (isTap && lastTap && performance.now() - lastTap.time < 380 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24) {
      const i = strokes.indexOf(lastTap.stroke);
      if (i >= 0) { strokes.splice(i, 1); const u = undoStack.findIndex(x => x.add === lastTap.stroke); if (u >= 0) undoStack.splice(u, 1); }
      lastTap = null;
      setTool(prevTool);
      toast(O.tool === "eraser" ? t("ink.gomma") : O.tool === "hl" ? t("ink.evidenziatore") : t("ink.penna"), false, 900);
      repaint(key); changed();
      return;
    }
    strokes.push(c);
    undoStack.push({ add: c });
    redoStack.length = 0;
    lastTap = isTap ? { time: performance.now(), x: e.clientX, y: e.clientY, stroke: c } : null;
    repaint(key); changed();
  }
  function eraseAt(key, p, r) {
    for (let i = strokes.length - 1; i >= 0; i--) {
      const st = strokes[i];
      if (st.s !== key || !hits(st, p, r)) continue;
      strokes.splice(i, 1);
      cur.removed.push({ stroke: st, index: i });
    }
    repaint(key);
  }

  // ------------------------------------------------------------ dita (disegni e immagini): sposta e zoom
  function startGesture(e, L) {
    e.preventDefault();
    try { L.canvas.setPointerCapture(e.pointerId); } catch { /* */ }
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    gesture = { L, last: gstate() };
  }
  const gstate = () => {
    const p = [...touches.values()];
    if (p.length === 1) return { c: p[0], d: 0 };
    return { c: [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2], d: Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) };
  };
  function gestureMove(e) {
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    const s = gstate(), l = gesture.last, r = gesture.L.canvas.getBoundingClientRect();
    if (touches.size >= 2 && l.d && s.d) opts.zoom?.(s.d / l.d, s.c[0] - r.left, s.c[1] - r.top, s.c[0], s.c[1]);
    opts.pan?.(s.c[0] - l.c[0], s.c[1] - l.c[1]);
    gesture.last = s;
  }
  function gestureEnd(e) {
    touches.delete(e.pointerId);
    if (!touches.size) gesture = null; else gesture.last = gstate();
  }

  // ------------------------------------------------------------ comandi
  function changed() { sync(); opts.onChange?.(); }
  function undo() {
    const op = undoStack.pop();
    if (!op) return;
    if (op.add) { const i = strokes.indexOf(op.add); if (i >= 0) strokes.splice(i, 1); }
    else if (op.remove) [...op.remove].reverse().forEach(r => strokes.splice(Math.min(r.index, strokes.length), 0, r.stroke));
    else if (op.clear) strokes.push(...op.clear);
    redoStack.push(op);
    refresh(); changed();
  }
  function redo() {
    const op = redoStack.pop();
    if (!op) return;
    if (op.add) strokes.push(op.add);
    else if (op.remove) op.remove.forEach(r => { const i = strokes.indexOf(r.stroke); if (i >= 0) strokes.splice(i, 1); });
    else if (op.clear) strokes.length = 0;
    undoStack.push(op);
    refresh(); changed();
  }
  function clearAll() {
    if (!strokes.length) return;
    undoStack.push({ clear: strokes.splice(0) });
    redoStack.length = 0;
    refresh(); changed();
  }
  function toggle(v = !on) {
    on = v;
    bar.hidden = !on;
    for (const { canvas } of layers.values()) canvas.style.pointerEvents = on ? "auto" : "none";
    if (on) { refresh(); sync(); if (!penSeen && matchMedia("(pointer: coarse)").matches) toast(t("ink.suggerimento"), false, 4200); }
    else { cur = null; touches.clear(); gesture = null; }
    opts.onToggle?.(on);
  }
  const onKey = e => {
    if (!on || e.target.closest?.("input, textarea, [contenteditable]")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
    else if (e.key === "Escape") { e.preventDefault(); toggle(false); }
  };
  addEventListener("keydown", onKey);
  sync();

  return {
    get active() { return on; },
    strokes,
    toggle, refresh, undo, redo,
    hasStrokes: () => strokes.length > 0,
    /** dopo il salvataggio: i tratti sono ormai nel file (si tolgono dalla vista, il documento ricaricato li mostra) */
    reset() { strokes.length = 0; undoStack.length = 0; redoStack.length = 0; refresh(); sync(); },
    dispose() { removeEventListener("keydown", onKey); bar.remove(); for (const { canvas } of layers.values()) canvas.remove(); layers.clear(); },
  };
}

// ---------------------------------------------------------------- geometria condivisa (schermo, PDF, DXF, immagini)
/** disegna un tratto su un contesto 2D; toLocal: coordinate del documento -> pixel; k: pixel per unita' del documento */
export function paint(g, st, toLocal, k) {
  const P = st.pts.map(p => toLocal(p[0], p[1]));
  g.save();
  g.lineCap = "round";
  g.lineJoin = "round";
  g.strokeStyle = g.fillStyle = st.color;
  if (st.tool === "hl") {
    g.globalAlpha = st.o;
    g.lineWidth = st.w * k;
    g.beginPath();
    P.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    if (P.length === 1) g.lineTo(P[0][0] + 0.01, P[0][1]);
    g.stroke();
  } else if (P.length === 1) {
    g.beginPath();
    g.arc(P[0][0], P[0][1], Math.max(0.6, st.w * k * (st.pressure ? pressureK(st.pts[0][2]) : 1) / 2), 0, 7);
    g.fill();
  } else if (!st.pressure) {
    g.lineWidth = st.w * k;
    g.beginPath();
    P.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.stroke();
  } else {
    // spessore variabile: un segmento per coppia di punti con la pressione media
    for (let i = 1; i < P.length; i++) {
      g.lineWidth = Math.max(0.5, st.w * k * pressureK((st.pts[i - 1][2] + st.pts[i][2]) / 2));
      g.beginPath();
      g.moveTo(P[i - 1][0], P[i - 1][1]);
      g.lineTo(P[i][0], P[i][1]);
      g.stroke();
    }
  }
  g.restore();
}

/** spessore (unita' del documento) nel punto i */
export const widthAt = (st, i) => st.w * (st.pressure ? pressureK(st.pts[i][2]) : 1);

/** riquadro del tratto in unita' del documento, spessore compreso */
export function strokeBox(st) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, wmax = 0;
  st.pts.forEach((p, i) => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); wmax = Math.max(wmax, widthAt(st, i)); });
  return [x0 - wmax, y0 - wmax, x1 + wmax, y1 + wmax];
}

function hits(st, p, r) {
  const pts = st.pts;
  const rr = r + (st.tool === "hl" ? st.w / 2 : st.w);
  if (pts.length === 1) return Math.hypot(pts[0][0] - p[0], pts[0][1] - p[1]) < rr;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const u = L ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L)) : 0;
    if (Math.hypot(ax + dx * u - p[0], ay + dy * u - p[1]) < rr) return true;
  }
  return false;
}

export const hexRgb = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
