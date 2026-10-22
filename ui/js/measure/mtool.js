// Strumenti di misura 2D comuni a PDF e disegni CAD: clic dei punti con aggancio, ortogonale (Maiusc), fori nelle aree,
// conteggi con simboli, taratura della scala, scala di un riquadro, oggetti esistenti con un clic, modifica dei vertici.
// Non conosce il visualizzatore: lavora su "superfici" che il visualizzatore fornisce
//   surf = { page, px (pixel dello schermo per pixel CSS), toScreen([x,y]) -> [sx,sy], toWorld(sx,sy) -> [x,y],
//            snap(sx,sy) -> {x,y,k} | null, pick(sx,sy) -> Promise<forma | null>, similar?(sx,sy) -> Promise<[[x,y]...]>,
//            redraw() }
// e disegna le misure sulla stessa superficie (paint). M = sessione delle misure (ui/js/measure/mpanel.js).
import { drawSnapMarker } from "../cadgeom.js";
import { compute, dist, pointInPoly, row, uid, conv, scaleFor } from "./mcore.js";

export const SYMBOLS = ["circle", "square", "triangle", "diamond", "cross", "check", "star"];
const MULTI = new Set(["pline", "perim", "area", "vol", "hole"]);
const NPTS = { len: 2, ang: 3, rad: 3, elev: 1, calib: 2, vp: 2, refelev: 1 };

export function createEngine2d(M) {
  const E = { cur: null, hover: null, hoverSurf: null, drag: null };
  const tool = () => M.tool;
  const ortho = (p, prev) => {
    if (!prev || p.length > 2) return p;
    const dx = p[0] - prev[0], dy = p[1] - prev[1], a = Math.atan2(dy, dx), L = Math.hypot(dx, dy);
    const s = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
    return [prev[0] + L * Math.cos(s), prev[1] + L * Math.sin(s)];
  };
  function pointAt(surf, sx, sy, e) {
    const s = !e.altKey ? surf.snap(sx, sy) : null;
    let p = s ? s.p || [s.x, s.y] : surf.toWorld(sx, sy); // nel 3D il punto agganciato ha anche z (s.p)
    if (!p) return { p: null, snap: null };
    const prev = E.cur?.pts[E.cur.pts.length - 1];
    if (e.shiftKey && !s && prev) p = ortho(p, prev);
    return { p, snap: s };
  }
  const reset = () => { E.cur = null; E.hover = null; M.redraw(); };
  E.cancel = reset;
  E.busy = () => !!E.cur;

  // ---------------------------------------------------------------- fine di una misura
  async function finish() {
    const c = E.cur;
    if (!c) return;
    E.cur = null;
    const t = c.type, P = c.pts;
    if (t === "hole") {
      const host = M.doc.items.find(m => m.id === c.host);
      if (host && P.length >= 3) { (host.holes ||= []).push(P); M.changed(host); }
      return M.redraw();
    }
    if (t === "calib") { if (P.length === 2) await M.askCalibration(c.page, P[0], P[1]); return M.redraw(); }
    if (t === "vp") { if (P.length === 2) await M.askViewport(c.page, [Math.min(P[0][0], P[1][0]), Math.min(P[0][1], P[1][1]), Math.max(P[0][0], P[1][0]), Math.max(P[0][1], P[1][1])]); return M.redraw(); }
    if (t === "refelev") { if (P.length) await M.askRefElev(P[0]); return M.redraw(); }
    if (t === "count") { M.redraw(); return; }
    const need = { pline: 2, perim: 3, area: 3, vol: 3 }[t] || NPTS[t] || 1;
    if (P.length < need) return M.redraw();
    const m = M.newItem(t, c.page, P);
    if (t === "vol") {
      const s = scaleFor(M.doc, c.page, P[0]);
      m.h = conv(+M.opt.h || 0, M.doc.disp?.unit || s.unit, s.unit);
    }
    M.add(m);
  }

  // ---------------------------------------------------------------- eventi (coordinate della superficie)
  E.down = (surf, sx, sy, e) => {
    const t = tool();
    if (!t || e.button !== 0) return false;
    if (t === "select") return selectDown(surf, sx, sy, e);
    if (t === "objlen" || t === "objarea") { pickObject(surf, sx, sy, t); return true; }
    if (t === "similar") { pickSimilar(surf, sx, sy); return true; }
    const { p } = pointAt(surf, sx, sy, e);
    if (!p) return false;
    if (E.cur && E.cur.page !== surf.page) E.cur = null; // un'altra pagina: si ricomincia
    if (t === "hole" && !E.cur) {
      const host = hitItem(surf, sx, sy, m => ["area", "perim", "vol"].includes(m.type));
      if (!host) { M.hint("hole_dentro"); return true; }
      E.cur = { type: "hole", page: surf.page, pts: [p], host: host.id };
      M.select(host.id, false);
      M.redraw();
      return true;
    }
    if (t === "count") {
      let m = E.cur?.type === "count" ? M.doc.items.find(x => x.id === E.cur.id) : null;
      if (!m || m.page !== surf.page) { m = M.newItem("count", surf.page, []); M.add(m, true); E.cur = { type: "count", page: surf.page, pts: m.pts, id: m.id }; }
      m.pts.push(p);
      M.changed(m);
      return true;
    }
    E.cur ||= { type: t, page: surf.page, pts: [] };
    E.cur.pts.push(p);
    const n = NPTS[t];
    if (n && E.cur.pts.length >= n) finish();
    else M.redraw();
    return true;
  };
  E.move = (surf, sx, sy, e) => {
    const t = tool();
    if (!t) return false;
    if (E.drag) { dragMove(surf, sx, sy, e); return true; }
    if (t === "select" || t === "objlen" || t === "objarea" || t === "similar") { E.hover = null; return false; }
    const { p, snap } = pointAt(surf, sx, sy, e);
    E.hover = p ? { p, snap, page: surf.page } : null;
    E.hoverSurf = surf;
    surf.redraw();
    return true;
  };
  E.up = (surf, sx, sy, e) => { if (E.drag) { const d = E.drag; E.drag = null; if (d.moved) M.changed(d.m); return true; } return false; };
  E.dbl = (surf, sx, sy, e) => {
    if (!tool() || tool() === "select") return false;
    if (E.cur && MULTI.has(E.cur.type)) { // il doppio clic aggiunge un punto doppio: si toglie
      const P = E.cur.pts;
      if (P.length >= 2 && dist(P[P.length - 1], P[P.length - 2]) < 1e-9) P.pop();
      finish();
      return true;
    }
    return false;
  };
  E.context = () => { if (E.cur) { if (MULTI.has(E.cur.type) || E.cur.type === "count") finish(); else reset(); return true; } return false; };
  E.key = e => {
    const k = e.key;
    if (k === "Escape") { if (E.cur) { if (E.cur.type === "count") finish(); else reset(); return true; } return false; }
    if (k === "Enter" && E.cur) { finish(); return true; }
    if (k === "Backspace" && E.cur?.pts.length && E.cur.type !== "count") { E.cur.pts.pop(); if (!E.cur.pts.length) E.cur = null; M.redraw(); return true; }
    if ((k === "Delete" || k === "Backspace") && !E.cur && M.sel.size) { M.removeSelected(); return true; }
    return false;
  };

  // ---------------------------------------------------------------- selezione e vertici
  function hitItem(surf, sx, sy, filter = () => true) {
    const tol = 7 * surf.px;
    let best = null, bd = Infinity;
    for (const m of M.visibleItems(surf.page)) {
      if (!filter(m) || !m.pts?.length) continue;
      const S = m.pts.map(p => surf.toScreen(p));
      let d = Infinity;
      for (let i = 0; i < S.length; i++) {
        d = Math.min(d, Math.hypot(S[i][0] - sx, S[i][1] - sy) - (m.type === "count" ? 6 * surf.px : 0));
        const closed = ["perim", "area", "vol"].includes(m.type);
        if (m.type !== "count" && (i + 1 < S.length || closed) && S.length > 1) d = Math.min(d, segDist(sx, sy, S[i], S[(i + 1) % S.length]));
      }
      if (["perim", "area", "vol"].includes(m.type) && pointInPoly(sx, sy, S)) d = Math.min(d, tol * 0.9);
      if (d < bd) { bd = d; best = m; }
    }
    return bd <= tol ? best : null;
  }
  E.hitItem = hitItem;
  function selectDown(surf, sx, sy, e) {
    // vertice della misura selezionata: si trascina
    for (const id of M.sel) {
      const m = M.doc.items.find(x => x.id === id);
      if (!m || m.page !== surf.page || m.q) continue;
      const rings = [m.pts, ...(m.holes || [])];
      for (const ring of rings) for (let i = 0; i < ring.length; i++) {
        const s = surf.toScreen(ring[i]);
        if (Math.hypot(s[0] - sx, s[1] - sy) <= 6 * surf.px) { E.drag = { m, ring, i, moved: false }; return true; }
      }
    }
    const m = hitItem(surf, sx, sy);
    if (m) { M.select(m.id, e.ctrlKey || e.shiftKey); return true; }
    if (M.sel.size && !e.ctrlKey) M.select(null);
    return false; // il clic sul vuoto resta al visualizzatore (sposta la vista)
  }
  function dragMove(surf, sx, sy, e) {
    const d = E.drag;
    const s = !e.altKey ? surf.snap(sx, sy) : null;
    const p = s ? s.p || [s.x, s.y] : surf.toWorld(sx, sy);
    if (!p) return;
    d.ring[d.i] = p;
    d.moved = true;
    E.hover = s ? { p, snap: s, page: surf.page } : null;
    M.redraw();
    M.liveUpdate?.(d.m);
  }

  // ---------------------------------------------------------------- oggetti esistenti
  async function pickObject(surf, sx, sy, t) {
    const f = await surf.pick?.(sx, sy, t === "objarea");
    if (!f) return M.hint("nessun_oggetto");
    const closed = f.closed || t === "objarea";
    if (t === "objarea" && !(f.closed && f.pts.length >= 3)) return M.hint("oggetto_aperto");
    const m = M.newItem(closed && t === "objarea" ? "area" : "pline", surf.page, f.pts);
    if (t === "objlen" && f.closed) { m.type = "perim"; }
    if (f.holes?.length && m.type === "area") m.holes = f.holes;
    if (f.layer) m.layer = f.layer;
    if (f.label) m.name = f.label;
    m.obj = true;
    M.add(m);
  }
  async function pickSimilar(surf, sx, sy) {
    const pts = await surf.similar?.(sx, sy);
    if (!pts?.length) return M.hint("nessun_simbolo");
    const m = M.newItem("count", surf.page, pts);
    m.obj = true;
    M.add(m);
  }

  // ---------------------------------------------------------------- disegno
  E.paint = (surf, g) => {
    const px = surf.px;
    g.save();
    g.lineJoin = "round";
    g.lineCap = "round";
    for (const m of M.visibleItems(surf.page)) drawItem(surf, g, m, M.sel.has(m.id));
    // scale dei riquadri: rettangolo tratteggiato con l'etichetta
    for (const s of M.doc.scales || []) if (s.box && (s.page ?? null) === (surf.page ?? null) && M.showScales) {
      const a = surf.toScreen([s.box[0], s.box[1]]), b = surf.toScreen([s.box[2], s.box[3]]);
      g.setLineDash([6 * px, 4 * px]); g.strokeStyle = "#0c8599"; g.lineWidth = 1.2 * px;
      g.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      g.setLineDash([]);
      pill(g, s.label, Math.min(a[0], b[0]) + 4 * px, Math.min(a[1], b[1]) + 12 * px, px, "#0c8599", "left");
    }
    // misura in corso + punto sotto il mouse
    const c = E.cur, h = E.hover && E.hover.page === surf.page ? E.hover : null;
    if (c && c.page === surf.page && c.type !== "count") {
      const P = [...c.pts, ...(h ? [h.p] : [])];
      const fake = { type: c.type === "hole" ? "area" : c.type === "calib" ? "len" : c.type, page: c.page, pts: P, color: M.opt.color, h: 0 };
      if (c.type === "vp" && P.length === 2) {
        const a = surf.toScreen(P[0]), b = surf.toScreen(P[1]);
        g.setLineDash([6 * px, 4 * px]); g.strokeStyle = "#0c8599"; g.lineWidth = 1.5 * px;
        g.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
        g.setLineDash([]);
      } else if (c.type !== "refelev") drawItem(surf, g, fake, false, true);
    }
    if (h?.snap) { const s = surf.toScreen(h.p); drawSnapMarker(g, s[0], s[1], h.snap.k, px); }
    else if (h && tool() && tool() !== "select") { const s = surf.toScreen(h.p); cross(g, s[0], s[1], px); }
    g.restore();
  };

  function drawItem(surf, g, m, sel, live = false) {
    const px = surf.px, col = m.color || "#e8590c";
    const S = (m.pts || []).map(p => surf.toScreen(p));
    if (!S.length) return;
    g.strokeStyle = col;
    g.fillStyle = col;
    g.lineWidth = (sel ? 3 : 2) * px;
    g.setLineDash(live ? [5 * px, 3 * px] : []);
    const closed = ["perim", "area", "vol"].includes(m.type);
    let r = null;
    try { r = row(m, M.doc); } catch { /* */ }
    if (m.type === "count") {
      S.forEach((s, i) => symbol(g, m.symbol || "circle", s[0], s[1], 7 * px, col, sel));
      if (S.length) pill(g, `${M.label(m)} ${S.length}`, S[S.length - 1][0] + 10 * px, S[S.length - 1][1] - 10 * px, px, col, "left");
      return;
    }
    if (m.type === "elev") {
      const [x, y] = S[0];
      g.beginPath(); g.moveTo(x - 7 * px, y - 10 * px); g.lineTo(x + 7 * px, y - 10 * px); g.lineTo(x, y); g.closePath(); g.stroke();
      g.beginPath(); g.moveTo(x - 14 * px, y); g.lineTo(x + 30 * px, y); g.stroke();
      pill(g, fmtRow(r, m), x + 12 * px, y - 14 * px, px, col, "left");
      return;
    }
    g.beginPath();
    S.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    if (closed) g.closePath();
    for (const H of m.holes || []) { const Q = H.map(p => surf.toScreen(p)); Q.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); }
    if (closed && S.length > 2) { g.globalAlpha = sel ? 0.28 : 0.16; g.fill("evenodd"); g.globalAlpha = 1; }
    g.stroke();
    // vertici
    const dot = sel ? 4 : 2.5;
    for (const [x, y] of S) { g.beginPath(); g.arc(x, y, dot * px, 0, 7); g.fill(); }
    if (sel) for (const H of m.holes || []) for (const p of H) { const [x, y] = surf.toScreen(p); g.beginPath(); g.arc(x, y, dot * px, 0, 7); g.fill(); }
    if (m.type === "ang" && S.length >= 3) arcMark(g, S[1], S[0], S[2], px);
    if (m.type === "rad" && S.length >= 3) {
      const c = circlePx(S);
      if (c) { g.setLineDash([4 * px, 3 * px]); g.beginPath(); g.arc(c.cx, c.cy, c.r, 0, 7); g.moveTo(c.cx, c.cy); g.lineTo(S[0][0], S[0][1]); g.stroke(); g.setLineDash([]); }
    }
    // etichetta: al centro dell'area, a meta' della linea, al vertice dell'angolo
    const text = fmtRow(r, m);
    if (!text) return;
    let at;
    if (closed && S.length > 2) at = centroid(S);
    else if (m.type === "ang") at = [S[1][0] + 14 * px, S[1][1] - 10 * px];
    else if (S.length >= 2) { const i = Math.floor((S.length - 1) / 2); at = [(S[i][0] + S[i + 1][0]) / 2, (S[i][1] + S[i + 1][1]) / 2 - 10 * px]; }
    else at = S[0];
    pill(g, text, at[0], at[1], px, col, "center", sel);
  }
  const fmtRow = (r, m) => (r ? M.fmtShort(r, m) : "");
  return E;
}

// ---------------------------------------------------------------- disegno: simboli ed etichette
export function symbol(g, kind, x, y, s, col, sel) {
  g.save();
  g.lineWidth = Math.max(1.5, s / 4);
  g.strokeStyle = col;
  g.fillStyle = col + (sel ? "aa" : "55");
  g.setLineDash([]);
  g.beginPath();
  if (kind === "square") g.rect(x - s, y - s, 2 * s, 2 * s);
  else if (kind === "triangle") { g.moveTo(x, y - s * 1.1); g.lineTo(x + s, y + s * 0.8); g.lineTo(x - s, y + s * 0.8); g.closePath(); }
  else if (kind === "diamond") { g.moveTo(x, y - s * 1.2); g.lineTo(x + s, y); g.lineTo(x, y + s * 1.2); g.lineTo(x - s, y); g.closePath(); }
  else if (kind === "cross") { g.moveTo(x - s, y - s); g.lineTo(x + s, y + s); g.moveTo(x + s, y - s); g.lineTo(x - s, y + s); g.stroke(); g.restore(); return; }
  else if (kind === "check") { g.moveTo(x - s, y); g.lineTo(x - s * 0.3, y + s * 0.8); g.lineTo(x + s, y - s * 0.8); g.lineWidth = Math.max(2, s / 3); g.stroke(); g.restore(); return; }
  else if (kind === "star") { for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? s * 0.45 : s * 1.15; g.lineTo(x + r * Math.cos(a), y + r * Math.sin(a)); } g.closePath(); }
  else g.arc(x, y, s, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.restore();
}
export function pill(g, text, x, y, px, col, align = "center", strong = false) {
  g.save();
  g.setLineDash([]);
  g.font = `${strong ? 600 : 500} ${11.5 * px}px "IBM Plex Sans", "Segoe UI", sans-serif`;
  const w = g.measureText(text).width + 10 * px, h = 17 * px;
  const x0 = align === "left" ? x : x - w / 2, y0 = y - h / 2;
  g.fillStyle = "rgba(24,26,28,.86)";
  g.beginPath();
  g.roundRect ? g.roundRect(x0, y0, w, h, 4 * px) : g.rect(x0, y0, w, h);
  g.fill();
  g.fillStyle = col;
  g.fillRect(x0, y0, 3 * px, h);
  g.fillStyle = "#fff";
  g.textBaseline = "middle";
  g.fillText(text, x0 + 6 * px, y0 + h / 2 + 0.5 * px);
  g.restore();
}
function cross(g, x, y, px) {
  g.save(); g.strokeStyle = "#ffd400"; g.lineWidth = 1.2 * px; g.setLineDash([]);
  g.beginPath(); g.moveTo(x - 8 * px, y); g.lineTo(x + 8 * px, y); g.moveTo(x, y - 8 * px); g.lineTo(x, y + 8 * px); g.stroke(); g.restore();
}
function arcMark(g, B, A, C, px) {
  const a0 = Math.atan2(A[1] - B[1], A[0] - B[0]), a1 = Math.atan2(C[1] - B[1], C[0] - B[0]);
  let d = a1 - a0;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  g.beginPath(); g.arc(B[0], B[1], 18 * px, a0, a0 + d, d < 0); g.stroke();
}
function circlePx(S) {
  const [A, B, C] = S, d = 2 * (A[0] * (B[1] - C[1]) + B[0] * (C[1] - A[1]) + C[0] * (A[1] - B[1]));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = A[0] ** 2 + A[1] ** 2, b2 = B[0] ** 2 + B[1] ** 2, c2 = C[0] ** 2 + C[1] ** 2;
  const cx = (a2 * (B[1] - C[1]) + b2 * (C[1] - A[1]) + c2 * (A[1] - B[1])) / d, cy = (a2 * (C[0] - B[0]) + b2 * (A[0] - C[0]) + c2 * (B[0] - A[0])) / d;
  return { cx, cy, r: Math.hypot(A[0] - cx, A[1] - cy) };
}
function centroid(S) {
  let a = 0, x = 0, y = 0;
  for (let i = 0; i < S.length; i++) { const p = S[i], q = S[(i + 1) % S.length], c = p[0] * q[1] - q[0] * p[1]; a += c; x += (p[0] + q[0]) * c; y += (p[1] + q[1]) * c; }
  if (Math.abs(a) < 1e-9) return S.reduce((s, p) => [s[0] + p[0] / S.length, s[1] + p[1] / S.length], [0, 0]);
  return [x / (3 * a), y / (3 * a)];
}
export function segDist(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const u = L ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L)) : 0;
  return Math.hypot(a[0] + u * dx - x, a[1] + u * dy - y);
}

// ---------------------------------------------------------------- indice spaziale per l'aggancio (stesso formato di cad2d)
// items: { t: "L", x1,y1,x2,y2 } | { t: "A", cx,cy,r,a0,sw,pts } | { t: "P", pts, closed } | { t: "N", x, y, k }
export function snapModel(items) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  const bbOf = it => {
    if (it.t === "L") return [Math.min(it.x1, it.x2), Math.min(it.y1, it.y2), Math.max(it.x1, it.x2), Math.max(it.y1, it.y2)];
    if (it.t === "N") return [it.x, it.y, it.x, it.y];
    if (it.t === "A" && Math.abs(it.sw) >= Math.PI * 2 - 1e-9) return [it.cx - it.r, it.cy - it.r, it.cx + it.r, it.cy + it.r];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of it.pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    return [x0, y0, x1, y1];
  };
  for (const it of items) { it.bb = bbOf(it); if (it.bb[0] < a) a = it.bb[0]; if (it.bb[1] < b) b = it.bb[1]; if (it.bb[2] > c) c = it.bb[2]; if (it.bb[3] > d) d = it.bb[3]; }
  if (!items.length) { a = b = 0; c = d = 1; }
  const W = Math.max(c - a, d - b) || 1, cs = W / 200, grid = new Map(), big = [];
  const cell = v => Math.floor(v / cs);
  items.forEach((it, i) => {
    const bb = it.bb, ix0 = cell(bb[0] - a), iy0 = cell(bb[1] - b), ix1 = cell(bb[2] - a), iy1 = cell(bb[3] - b);
    if ((ix1 - ix0 + 1) * (iy1 - iy0 + 1) > 300) { big.push(i); return; }
    for (let x = ix0; x <= ix1; x++) for (let y = iy0; y <= iy1; y++) { const k = x * 1048576 + y; let L = grid.get(k); if (!L) grid.set(k, (L = [])); L.push(i); }
  });
  const query = (x0, y0, x1, y1) => {
    const ix0 = cell(x0 - a), iy0 = cell(y0 - b), ix1 = cell(x1 - a), iy1 = cell(y1 - b);
    const seen = new Set(big);
    if ((ix1 - ix0 + 1) * (iy1 - iy0 + 1) > 40000) items.forEach((_, i) => seen.add(i));
    else for (let x = ix0; x <= ix1; x++) for (let y = iy0; y <= iy1; y++) { const L = grid.get(x * 1048576 + y); if (L) for (const i of L) seen.add(i); }
    return [...seen].filter(i => { const q = items[i].bb; return q[0] <= x1 && q[2] >= x0 && q[1] <= y1 && q[3] >= y0; });
  };
  return { items, query, bbox: [a, b, c, d] };
}
export { compute, uid };
