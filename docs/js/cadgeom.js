// Geometria dei disegni CAD 2D condivisa da visualizzatore (viewers/cad2d.js) ed editor (cadedit.js):
// matrici affini, archi e bulge, spline, impaginazione dei testi (stessa per disegno e selezione), curve analitiche
// (distanze, punti piu' vicini, intersezioni), retini a tratteggio e geometria delle quote nuove.
export const TAU = Math.PI * 2;
export const R2D = 180 / Math.PI;
export const EPS = 1e-9;

// ---------------------------------------------------------------- matrici affini [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f
export const I = [1, 0, 0, 1, 0, 0];
export const mul = (A, B) => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
  A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
export const ap = (A, x, y) => [A[0] * x + A[2] * y + A[4], A[1] * x + A[3] * y + A[5]];
export const apv = (A, x, y) => [A[0] * x + A[2] * y, A[1] * x + A[3] * y];
export const det = A => A[0] * A[3] - A[1] * A[2];
export function inv(A) {
  const d = det(A) || 1e-30;
  const a = A[3] / d, b = -A[1] / d, c = -A[2] / d, e = A[0] / d;
  return [a, b, c, e, -(a * A[4] + c * A[5]), -(b * A[4] + e * A[5])];
}
export const trn = (x, y) => [1, 0, 0, 1, x, y];
export const rot = (a, cx = 0, cy = 0) => { const c = Math.cos(a), s = Math.sin(a); return [c, s, -s, c, cx - cx * c + cy * s, cy - cx * s - cy * c]; };
export const scl = (k, cx = 0, cy = 0, ky = k) => [k, 0, 0, ky, cx - k * cx, cy - ky * cy];
export function mirror(x1, y1, x2, y2) { // simmetria rispetto alla retta per due punti
  const t = Math.atan2(y2 - y1, x2 - x1), c = Math.cos(2 * t), s = Math.sin(2 * t);
  return mul(trn(x1, y1), mul([c, s, s, -c, 0, 0], trn(-x1, -y1)));
}
// matrice "simile" (rotazione + scala uniforme, anche specchiata): gli archi restano archi
export function similar(A) { const p = Math.hypot(A[0], A[1]), q = Math.hypot(A[2], A[3]); return Math.abs(p - q) <= 1e-7 * Math.max(p, q, 1e-12) && Math.abs(A[0] * A[2] + A[1] * A[3]) <= 1e-7 * p * q; }
export const normA = a => { a %= TAU; return a < 0 ? a + TAU : a; };

// ---------------------------------------------------------------- archi, bulge, spline
export function arcPts(cx, cy, rx, ry, rotA, a0, a1, ccw = true) {
  let sweep = a1 - a0;
  if (ccw) { while (sweep <= 0) sweep += TAU; } else { while (sweep >= 0) sweep -= TAU; }
  if (Math.abs(a1 - a0) >= TAU - 1e-9) sweep = TAU;
  return sweepPts(cx, cy, rx, ry, rotA, a0, sweep);
}
export function sweepPts(cx, cy, rx, ry, rotA, a0, sweep) {
  const n = Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI / 48)));
  const cr = Math.cos(rotA), sr = Math.sin(rotA), out = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 + sweep * k / n, x = rx * Math.cos(a), y = ry * Math.sin(a);
    out.push([cx + x * cr - y * sr, cy + x * sr + y * cr]);
  }
  return out;
}
// arco di un lato di polilinea con bulge: centro, raggio, angolo iniziale e ampiezza con segno (positiva = antioraria)
export function bulgeArc(x1, y1, x2, y2, b) {
  const th = 4 * Math.atan(b), dx = x2 - x1, dy = y2 - y1, d = Math.hypot(dx, dy);
  if (d < 1e-12 || !b) return null;
  const r = d / (2 * Math.sin(th / 2)), mx = (x1 + x2) / 2, my = (y1 + y2) / 2, h = r * Math.cos(th / 2);
  const cx = mx - dy / d * h, cy = my + dx / d * h;
  return { cx, cy, r: Math.abs(r), a0: Math.atan2(y1 - cy, x1 - cx), sw: th };
}
export function bulgePts(p1, p2, b, out) {
  const A = b ? bulgeArc(p1.x, p1.y, p2.x, p2.y, b) : null;
  if (!A) { out.push([p2.x, p2.y]); return; }
  const pts = sweepPts(A.cx, A.cy, A.r, A.r, 0, A.a0, A.sw);
  pts[pts.length - 1] = [p2.x, p2.y];
  for (let k = 1; k < pts.length; k++) out.push(pts[k]);
}
export const bulgeOf = sw => Math.tan(sw / 4);

export function splinePts(e) {
  const cps = e.controlPoints || [];
  if (cps.length < 2) return (e.fitPoints || []).map(p => [p.x, p.y]);
  const p = e.degree || 3, kn = e.knots && e.knots.length === cps.length + p + 1 ? e.knots : null;
  if (!kn) return cps.map(c => [c.x, c.y]);
  const w = e.weights && e.weights.length === cps.length ? e.weights : cps.map(c => c.weight || 1);
  const out = [], t0 = kn[p], t1 = kn[cps.length], N = Math.max(20, cps.length * 8);
  for (let s = 0; s <= N; s++) {
    let t = t0 + (t1 - t0) * s / N;
    if (s === N) t = t1 - 1e-10;
    let k = p;
    while (k < cps.length - 1 && t >= kn[k + 1]) k++;
    const d = [];
    for (let j = 0; j <= p; j++) { const c = cps[k - p + j], ww = w[k - p + j]; d.push([c.x * ww, c.y * ww, ww]); }
    for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
      const i = k - p + j, a = (t - kn[i]) / ((kn[i + p - r + 1] - kn[i]) || 1);
      d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
    }
    out.push([d[p][0] / d[p][2], d[p][1] / d[p][2]]);
  }
  return out;
}

// ---------------------------------------------------------------- testi
export function cleanMText(s) {
  return (s || "").replace(/\\P/g, "\n").replace(/\\[ACcFfHhQqTtWw][^;\\]*;/g, "").replace(/\\[LlOoKk]/g, "")
    .replace(/\\S([^;]*)[\^#/]([^;]*);/g, "$1/$2").replace(/[{}]/g, "").replace(/\\~/g, " ").replace(/%%[cC]/g, "Ø").replace(/%%[dD]/g, "°").replace(/%%[pP]/g, "±")
    .replace(/%%[uUoO]/g, "").replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\\/g, "\\");
}
// l'altezza dei testi CAD e' quella delle maiuscole: il carattere Arial va ingrandito di questo fattore
export const CAP = 1.4;
const DESC = 0.3; // discendenti, in altezze di testo
let mctx = null;
const wcache = new Map();
export function textWidth(s) { // larghezza con carattere di corpo 1
  let w = wcache.get(s);
  if (w !== undefined) return w;
  if (!mctx) { mctx = document.createElement("canvas").getContext("2d"); mctx.font = "100px Arial, sans-serif"; }
  w = mctx.measureText(s).width / 100;
  if (wcache.size > 20000) wcache.clear();
  wcache.set(s, w);
  return w;
}
function wrap(line, maxW, F) {
  if (!(maxW > 0) || textWidth(line) * F <= maxW * 1.001) return [line];
  const words = line.split(/(\s+)/), out = [];
  let cur = "";
  for (const w of words) {
    const t = cur + w;
    if (cur && textWidth(t.trimEnd()) * F > maxW * 1.001) { out.push(cur.trimEnd()); cur = w.trimStart(); } else cur = t;
  }
  if (cur || !out.length) out.push(cur);
  return out;
}
// Impaginazione di TEXT / ATTRIB / MTEXT: matrice A (testo locale -> disegno), righe con posizione, riquadro esatto (4 vertici).
// Le coordinate locali sono in unita' del disegno dell'entita': x lungo il testo, y in alto, origine nel punto di inserimento.
export function textLayout(e, M) {
  const isM = e.type === "MTEXT";
  const h = e.textHeight > 0 ? e.textHeight : 1, F = h * CAP;
  let lines, origin, rotA = e.rotation || 0, xs = 1;
  const rows = [];
  if (isM) {
    origin = e.insertionPoint;
    if (e.direction && (e.direction.x || e.direction.y)) rotA = Math.atan2(e.direction.y, e.direction.x);
    lines = cleanMText(e.text).split("\n").flatMap(l => wrap(l, e.rectWidth, F));
    const ls = h * 5 / 3 * (e.lineSpacing > 0 ? e.lineSpacing : 1), H = h + (lines.length - 1) * ls;
    const ap0 = (e.attachmentPoint || 1) - 1, col = ap0 % 3, row = Math.floor(ap0 / 3);
    const top = row === 0 ? 0 : row === 1 ? H / 2 : H;
    lines.forEach((s, k) => { const w = textWidth(s) * F; rows.push({ s, x: col === 0 ? 0 : col === 1 ? -w / 2 : -w, y: top - h - k * ls, w }); });
  } else {
    const s = cleanMText(e.text).replace(/\n/g, " ");
    const hal = e.halign || 0, val = e.valign || 0, w = textWidth(s) * F;
    xs = e.xScale > 0 ? e.xScale : 1;
    const st = e.startPoint || { x: 0, y: 0 }, al = e.endPoint;
    const fit = (hal === 3 || hal === 5) && al && Math.hypot(al.x - st.x, al.y - st.y) > 1e-9;
    if (fit) {
      origin = st;
      rotA = Math.atan2(al.y - st.y, al.x - st.x);
      xs = w > 0 ? Math.hypot(al.x - st.x, al.y - st.y) / w : 1;
      rows.push({ s, x: 0, y: 0, w });
    } else {
      origin = (hal || val) && al ? al : st;
      const x = hal === 1 || hal === 4 ? -w / 2 : hal === 2 ? -w : 0;
      const y = hal === 4 ? -h / 2 : val === 1 ? h * DESC : val === 2 ? -h / 2 : val === 3 ? -h : 0;
      rows.push({ s, x, y, w });
    }
  }
  if (!origin) return null;
  const c = Math.cos(rotA), sn = Math.sin(rotA);
  const A = mul(M, [c * xs, sn * xs, -sn, c, origin.x, origin.y]);
  let x0 = Infinity, x1 = -Infinity;
  for (const r of rows) { x0 = Math.min(x0, r.x); x1 = Math.max(x1, r.x + r.w); }
  if (!(x1 > x0)) { x0 = 0; x1 = h * 0.5; }
  const y0 = rows[rows.length - 1].y - h * DESC, y1 = rows[0].y + h;
  const quad = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => ap(A, x, y));
  return { A, F, rows, quad, ins: ap(M, origin.x, origin.y), h: h * Math.sqrt(Math.abs(det(M))) };
}

// ---------------------------------------------------------------- curve analitiche
// L: {t:"L", x1, y1, x2, y2}   A: {t:"A", cx, cy, r, a0, sw}   P: {t:"P", pts}   (punti tessellati)
export function arcPoint(c, u) { const a = c.a0 + c.sw * u; return [c.cx + c.r * Math.cos(a), c.cy + c.r * Math.sin(a)]; }
// parametro (0..1) dell'angolo a sull'arco; puo' uscire da 0..1 se l'angolo e' fuori dall'arco
export function arcParam(c, a) {
  const d = normA((a - c.a0) * Math.sign(c.sw || 1));
  const s = Math.abs(c.sw);
  if (s >= TAU - 1e-9) return d / TAU;
  // fuori dall'arco: si sceglie l'estremo piu' vicino come riferimento (valore negativo o > 1)
  if (d > s) { const over = d - s, under = TAU - d; return over < under ? 1 + over / s : -under / s; }
  return d / s;
}
export function closest(c, x, y) { // [px, py, u, distanza]
  if (c.t === "L") {
    const dx = c.x2 - c.x1, dy = c.y2 - c.y1, L = dx * dx + dy * dy;
    let u = L ? ((x - c.x1) * dx + (y - c.y1) * dy) / L : 0;
    u = Math.max(0, Math.min(1, u));
    const px = c.x1 + u * dx, py = c.y1 + u * dy;
    return [px, py, u, Math.hypot(x - px, y - py)];
  }
  if (c.t === "A") {
    let u = arcParam(c, Math.atan2(y - c.cy, x - c.cx));
    u = Math.max(0, Math.min(1, u));
    const [px, py] = arcPoint(c, u);
    return [px, py, u, Math.hypot(x - px, y - py)];
  }
  const P = c.pts;
  let best = [P[0][0], P[0][1], 0, Infinity];
  for (let k = 1; k < P.length; k++) {
    const r = closest({ t: "L", x1: P[k - 1][0], y1: P[k - 1][1], x2: P[k][0], y2: P[k][1] }, x, y);
    if (r[3] < best[3]) best = [r[0], r[1], (k - 1 + r[2]) / (P.length - 1), r[3]];
  }
  return best;
}
export function curvePts(c) {
  if (c.t === "L") return [[c.x1, c.y1], [c.x2, c.y2]];
  if (c.t === "A") return c.pts || (c.pts = sweepPts(c.cx, c.cy, c.r, c.r, 0, c.a0, c.sw));
  return c.pts;
}
export function curveEnds(c) {
  if (c.t === "L") return [[c.x1, c.y1], [c.x2, c.y2]];
  if (c.t === "A") return Math.abs(c.sw) >= TAU - 1e-9 ? [] : [arcPoint(c, 0), arcPoint(c, 1)];
  return c.closed ? [] : [c.pts[0], c.pts[c.pts.length - 1]];
}
export const curveLen = c => c.t === "L" ? Math.hypot(c.x2 - c.x1, c.y2 - c.y1) : c.t === "A" ? Math.abs(c.sw) * c.r : c.pts.reduce((s, p, k) => k ? s + Math.hypot(p[0] - c.pts[k - 1][0], p[1] - c.pts[k - 1][1]) : 0, 0);
// intersezioni di due curve: [{x, y, u1, u2}]; ext1/ext2 = considera la curva prolungata (retta / cerchio intero)
export function intersect(c1, c2, ext1 = false, ext2 = false) {
  if (c1.t === "P" || c2.t === "P") {
    const out = [];
    const segs = c => c.t === "P" ? c.pts.slice(1).map((p, k) => ({ t: "L", x1: c.pts[k][0], y1: c.pts[k][1], x2: p[0], y2: p[1], _k: k, _n: c.pts.length - 1 })) : [c];
    const S1 = segs(c1), S2 = segs(c2);
    if (S1.length * S2.length > 40000) return out;
    for (const a of S1) for (const b of S2) for (const r of intersect(a, b, ext1 && c1.t !== "P", ext2 && c2.t !== "P")) {
      out.push({ x: r.x, y: r.y, u1: a._n ? (a._k + r.u1) / a._n : r.u1, u2: b._n ? (b._k + r.u2) / b._n : r.u2 });
    }
    return out;
  }
  if (c1.t === "A" && c2.t === "L") return intersect(c2, c1, ext2, ext1).map(r => ({ x: r.x, y: r.y, u1: r.u2, u2: r.u1 }));
  const ok = (c, u, ext) => ext || (u >= -1e-9 && u <= 1 + 1e-9);
  const res = [];
  if (c1.t === "L" && c2.t === "L") {
    const dx1 = c1.x2 - c1.x1, dy1 = c1.y2 - c1.y1, dx2 = c2.x2 - c2.x1, dy2 = c2.y2 - c2.y1;
    const den = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(den) < 1e-12 * (Math.hypot(dx1, dy1) * Math.hypot(dx2, dy2) || 1)) return res;
    const u1 = ((c2.x1 - c1.x1) * dy2 - (c2.y1 - c1.y1) * dx2) / den, u2 = ((c2.x1 - c1.x1) * dy1 - (c2.y1 - c1.y1) * dx1) / den;
    if (ok(c1, u1, ext1) && ok(c2, u2, ext2)) res.push({ x: c1.x1 + u1 * dx1, y: c1.y1 + u1 * dy1, u1, u2 });
    return res;
  }
  if (c1.t === "L" && c2.t === "A") {
    const dx = c1.x2 - c1.x1, dy = c1.y2 - c1.y1, fx = c1.x1 - c2.cx, fy = c1.y1 - c2.cy;
    const a = dx * dx + dy * dy, b = 2 * (fx * dx + fy * dy), c = fx * fx + fy * fy - c2.r * c2.r;
    let D = b * b - 4 * a * c;
    if (a < 1e-24 || D < -1e-9 * a * c2.r * c2.r) return res;
    D = Math.sqrt(Math.max(0, D));
    const us = D < 1e-12 ? [-b / (2 * a)] : [(-b - D) / (2 * a), (-b + D) / (2 * a)];
    for (const u1 of us) {
      const x = c1.x1 + u1 * dx, y = c1.y1 + u1 * dy, u2 = ext2 ? arcParamFull(c2, x, y) : arcParam(c2, Math.atan2(y - c2.cy, x - c2.cx));
      if (ok(c1, u1, ext1) && ok(c2, u2, ext2)) res.push({ x, y, u1, u2 });
    }
    return res;
  }
  // arco - arco
  const dx = c2.cx - c1.cx, dy = c2.cy - c1.cy, d = Math.hypot(dx, dy);
  if (d < 1e-12 || d > c1.r + c2.r + 1e-9 || d < Math.abs(c1.r - c2.r) - 1e-9) return res;
  const a = (c1.r * c1.r - c2.r * c2.r + d * d) / (2 * d), h = Math.sqrt(Math.max(0, c1.r * c1.r - a * a));
  const mx = c1.cx + a * dx / d, my = c1.cy + a * dy / d;
  const pts = h < 1e-12 ? [[mx, my]] : [[mx + h * dy / d, my - h * dx / d], [mx - h * dy / d, my + h * dx / d]];
  for (const [x, y] of pts) {
    const u1 = ext1 ? arcParamFull(c1, x, y) : arcParam(c1, Math.atan2(y - c1.cy, x - c1.cx)), u2 = ext2 ? arcParamFull(c2, x, y) : arcParam(c2, Math.atan2(y - c2.cy, x - c2.cx));
    if (ok(c1, u1, ext1) && ok(c2, u2, ext2)) res.push({ x, y, u1, u2 });
  }
  return res;
}
// parametro sull'intero cerchio (0..2pi/|sw|): per prolungare gli archi
function arcParamFull(c, x, y) { return normA((Math.atan2(y - c.cy, x - c.cx) - c.a0) * Math.sign(c.sw || 1)) / Math.abs(c.sw || TAU); }

export function pointInPoly(x, y, P) {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, yi] = P[i], [xj, yj] = P[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function polyArea(P) { let a = 0; for (let i = 0, j = P.length - 1; i < P.length; j = i++) a += (P[j][0] + P[i][0]) * (P[j][1] - P[i][1]); return a / 2; }
export function circle3(p1, p2, p3) { // cerchio per tre punti
  const ax = p1[0], ay = p1[1], bx = p2[0], by = p2[1], cx = p3[0], cy = p3[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  return { cx: ux, cy: uy, r: Math.hypot(ax - ux, ay - uy) };
}
// arco per tre punti (inizio, passaggio, fine): {cx, cy, r, a0, sw}
export function arc3(p1, p2, p3) {
  const c = circle3(p1, p2, p3);
  if (!c) return null;
  const a1 = Math.atan2(p1[1] - c.cy, p1[0] - c.cx), a2 = Math.atan2(p2[1] - c.cy, p2[0] - c.cx), a3 = Math.atan2(p3[1] - c.cy, p3[0] - c.cx);
  const ccw = normA(a2 - a1) < normA(a3 - a1);
  return { ...c, a0: a1, sw: ccw ? normA(a3 - a1) : -normA(a1 - a3) };
}

// ---------------------------------------------------------------- retini
// Motivi (come acadiso.pat): [angolo, base x, base y, offset x, offset y (nel riferimento della riga), trattini...]
export const PATTERNS = {
  ANSI31: [[45, 0, 0, 0, 3.175]],
  ANSI32: [[45, 0, 0, 0, 9.525], [45, 4.49013, 0, 0, 9.525]],
  ANSI37: [[45, 0, 0, 0, 3.175], [135, 0, 0, 0, 3.175]],
  LINE: [[0, 0, 0, 0, 3.175]],
  NET: [[0, 0, 0, 0, 3.175], [90, 0, 0, 0, 3.175]],
  DASH: [[0, 0, 0, 3.175, 3.175, 3.175, -3.175]],
  BRICK: [[0, 0, 0, 0, 6.35], [90, 0, 0, 6.35, 6.35, 6.35, -6.35]],
  DOTS: [[0, 0, 0, 0.79375, 1.5875, 0, -1.5875]],
  CROSS: [[0, 0, 0, 6.35, 6.35, 3.175, -9.525], [90, 1.5875, -1.5875, 6.35, 6.35, 3.175, -9.525]],
};
export const PATTERN_IT = { SOLID: "Pieno", ANSI31: "ANSI31 (45°)", ANSI32: "ANSI32 (acciaio)", ANSI37: "ANSI37 (rete 45°)", LINE: "Linee", NET: "Griglia", DASH: "Tratteggi", BRICK: "Mattoni", DOTS: "Punti", CROSS: "Croci" };
// righe di definizione nel formato del lettore DWG/DXF: {angle, base, offset, dashLengths} gia' ruotate e scalate
export function patternDefLines(name, scale = 1, angle = 0) {
  const P = PATTERNS[String(name || "").toUpperCase()];
  if (!P) return null;
  const D = Math.PI / 180, ca = Math.cos(angle), sa = Math.sin(angle);
  return P.map(([a, bx, by, ox, oy, ...dash]) => {
    const t = a * D, ct = Math.cos(t), st = Math.sin(t);
    const wx = ox * ct - oy * st, wy = ox * st + oy * ct; // offset nel riferimento del disegno
    return { angle: t + angle, base: { x: (bx * ca - by * sa) * scale, y: (bx * sa + by * ca) * scale }, offset: { x: (wx * ca - wy * sa) * scale, y: (wx * sa + wy * ca) * scale }, dashLengths: dash.map(v => v * scale) };
  });
}
// segmenti del tratteggio dentro i contorni (regola pari/dispari); null se troppo fitto
export function hatchSegments(loops, defs, limit = 30000) {
  const out = [];
  for (const L of defs || []) {
    const dx = Math.cos(L.angle), dy = Math.sin(L.angle), nx = -dy, ny = dx;
    const ox = L.offset?.x || 0, oy = L.offset?.y || 0, bx = L.base?.x || 0, by = L.base?.y || 0;
    const sp = ox * nx + oy * ny, sh = ox * dx + oy * dy;
    if (Math.abs(sp) < 1e-9) continue;
    let nmin = Infinity, nmax = -Infinity;
    for (const P of loops) for (const [x, y] of P) { const v = (x - bx) * nx + (y - by) * ny; nmin = Math.min(nmin, v); nmax = Math.max(nmax, v); }
    let k0 = Math.ceil(nmin / sp), k1 = Math.floor(nmax / sp);
    if (k0 > k1) [k0, k1] = [k1, k0];
    if (k1 - k0 > limit / 2) return null;
    const dash = (L.dashLengths || []).filter(v => isFinite(v)), plen = dash.reduce((s, v) => s + Math.abs(v), 0);
    for (let k = k0; k <= k1; k++) {
      const px = bx + k * ox, py = by + k * oy; // origine della riga k (la fase dei trattini parte da qui)
      const ts = [];
      for (const P of loops) for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
        const an = (P[j][0] - px) * nx + (P[j][1] - py) * ny, bn = (P[i][0] - px) * nx + (P[i][1] - py) * ny;
        if ((an > 0) === (bn > 0)) continue;
        const at = (P[j][0] - px) * dx + (P[j][1] - py) * dy, bt = (P[i][0] - px) * dx + (P[i][1] - py) * dy;
        ts.push(at + (bt - at) * an / (an - bn));
      }
      ts.sort((a, b) => a - b);
      for (let i = 0; i + 1 < ts.length; i += 2) {
        const t0 = ts[i], t1 = ts[i + 1];
        if (!dash.length || plen < 1e-9) { out.push([[px + dx * t0, py + dy * t0], [px + dx * t1, py + dy * t1]]); }
        else {
          let t = Math.floor(t0 / plen) * plen, n = 0;
          while (t < t1 && n++ < 4000) {
            for (const v of dash) {
              const a = t, b = t + Math.abs(v);
              if (v >= 0) {
                const s0 = Math.max(a, t0), s1 = Math.min(v === 0 ? a + plen * 0.002 : b, t1);
                if (s1 > s0) out.push([[px + dx * s0, py + dy * s0], [px + dx * s1, py + dy * s1]]);
              }
              t = b;
              if (t >= t1) break;
            }
          }
        }
        if (out.length > limit) return null;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- quote nuove (anteprima fino al salvataggio: poi le disegna ezdxf)
export const DIM_KIND_IT = { linear: "Quota lineare", aligned: "Quota allineata", angular: "Quota angolare", radius: "Quota raggio", diameter: "Quota diametro", ordinate: "Quota coordinata" };
export function fmtNum(v, dec = 2, sep = ",") {
  let s = (Math.round(v * 10 ** dec) / 10 ** dec).toFixed(dec);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  if (s === "-0") s = "0";
  return s.replace(".", sep);
}
export function dimMeasure(e) {
  const p1 = e.p1, p2 = e.p2;
  switch (e.dimKind) {
    case "linear": { const a = e.angle || 0; return Math.abs((p2.x - p1.x) * Math.cos(a) + (p2.y - p1.y) * Math.sin(a)); }
    case "aligned": return Math.hypot(p2.x - p1.x, p2.y - p1.y);
    case "angular": { const s = angSweep(e); return Math.abs(s.sw) * R2D; }
    case "radius": return e.r;
    case "diameter": return e.r * 2;
    case "ordinate": { const o = e.origin || { x: 0, y: 0 }; return e.axis === "x" ? e.feat.x - o.x : e.feat.y - o.y; }
    default: return 0;
  }
}
export function dimText(e) {
  const st = e.style || {};
  const v = dimMeasure(e);
  const s = e.dimKind === "angular" ? fmtNum(v, st.adec ?? 0, st.sep || ",") + "°" : fmtNum(v, st.dec ?? 2, st.sep || ",");
  const pre = e.dimKind === "radius" ? "R" : e.dimKind === "diameter" ? "Ø" : "";
  if (e.text && e.text !== "<>") return e.text.replace("<>", pre + s);
  return pre + s;
}
function angSweep(e) {
  const c = e.c, a1 = Math.atan2(e.p1.y - c.y, e.p1.x - c.x), a2 = Math.atan2(e.p2.y - c.y, e.p2.x - c.x);
  const al = Math.atan2(e.loc.y - c.y, e.loc.x - c.x);
  const sw = normA(a2 - a1);
  if (normA(al - a1) <= sw) return { a0: a1, sw };
  return { a0: a2, sw: normA(a1 - a2) };
}
const readable = a => { a = normA(a); return a > Math.PI / 2 + 1e-6 && a <= Math.PI * 1.5 + 1e-6 ? a - Math.PI : a; };
// geometria della quota: linee, frecce piene, testo {x, y, rot, h, s, hal}
export function dimGeom(e) {
  const st = e.style || {}, k = st.scale || 1, txt = (st.txt || 2.5) * k, asz = (st.asz || 2.5) * k, exo = (st.exo ?? 0.625) * k, exe = (st.exe ?? 1.25) * k, gap = (st.gap ?? 0.625) * k;
  const lines = [], fills = [];
  const P = p => [p.x, p.y];
  const arrow = (tip, ux, uy) => {
    if (st.tick) { const s = asz / 2; lines.push([[tip[0] - (ux - uy) * s * 0.7071, tip[1] - (uy + ux) * s * 0.7071], [tip[0] + (ux - uy) * s * 0.7071, tip[1] + (uy + ux) * s * 0.7071]]); return; }
    const bx = tip[0] - ux * asz, by = tip[1] - uy * asz, w = asz / 6;
    fills.push([tip, [bx - uy * w, by + ux * w], [bx + uy * w, by - ux * w]]);
  };
  const ext = (from, to) => { const dx = to[0] - from[0], dy = to[1] - from[1], L = Math.hypot(dx, dy); if (L < 1e-9) return; const ux = dx / L, uy = dy / L; lines.push([[from[0] + ux * exo, from[1] + uy * exo], [to[0] + ux * exe, to[1] + uy * exe]]); };
  let text = null;
  const s = dimText(e);
  if (e.dimKind === "linear" || e.dimKind === "aligned") {
    let ux, uy;
    if (e.dimKind === "linear") { ux = Math.cos(e.angle || 0); uy = Math.sin(e.angle || 0); }
    else { const L = Math.hypot(e.p2.x - e.p1.x, e.p2.y - e.p1.y) || 1; ux = (e.p2.x - e.p1.x) / L; uy = (e.p2.y - e.p1.y) / L; }
    const nx = -uy, ny = ux;
    const off = e.dimKind === "linear" ? null : (e.loc.x - e.p1.x) * nx + (e.loc.y - e.p1.y) * ny;
    const proj = p => e.dimKind === "linear" ? (() => { const t = (p.x - e.loc.x) * ux + (p.y - e.loc.y) * uy; return [e.loc.x + ux * t, e.loc.y + uy * t]; })() : [p.x + nx * off, p.y + ny * off];
    const q1 = proj(e.p1), q2 = proj(e.p2);
    ext(P(e.p1), q1); ext(P(e.p2), q2);
    const L = Math.hypot(q2[0] - q1[0], q2[1] - q1[1]);
    if (L > 1e-9) {
      const vx = (q2[0] - q1[0]) / L, vy = (q2[1] - q1[1]) / L;
      lines.push([q1, q2]);
      arrow(q1, -vx, -vy); arrow(q2, vx, vy);
    }
    const r = readable(Math.atan2(uy, ux)), tn = [-Math.sin(r), Math.cos(r)];
    const m = [(q1[0] + q2[0]) / 2, (q1[1] + q2[1]) / 2];
    text = { x: m[0] + tn[0] * gap, y: m[1] + tn[1] * gap, rot: r, h: txt, s, hal: "center", base: "bottom" };
  } else if (e.dimKind === "angular") {
    const c = e.c, R = Math.hypot(e.loc.x - c.x, e.loc.y - c.y), A = angSweep(e);
    for (const p of [e.p1, e.p2]) {
      const d = Math.hypot(p.x - c.x, p.y - c.y), a = Math.atan2(p.y - c.y, p.x - c.x);
      if (R > d + 1e-9) ext([c.x + Math.cos(a) * d, c.y + Math.sin(a) * d], [c.x + Math.cos(a) * R, c.y + Math.sin(a) * R]);
    }
    lines.push(sweepPts(c.x, c.y, R, R, 0, A.a0, A.sw));
    const t0 = A.a0, t1 = A.a0 + A.sw;
    arrow([c.x + R * Math.cos(t0), c.y + R * Math.sin(t0)], Math.sin(t0), -Math.cos(t0));
    arrow([c.x + R * Math.cos(t1), c.y + R * Math.sin(t1)], -Math.sin(t1), Math.cos(t1));
    const am = A.a0 + A.sw / 2, rr = readable(am - Math.PI / 2);
    text = { x: c.x + (R + gap) * Math.cos(am), y: c.y + (R + gap) * Math.sin(am), rot: rr, h: txt, s, hal: "center", base: "bottom" };
  } else if (e.dimKind === "radius" || e.dimKind === "diameter") {
    const c = e.c, a = Math.atan2(e.loc.y - c.y, e.loc.x - c.x), ux = Math.cos(a), uy = Math.sin(a), d = Math.hypot(e.loc.x - c.x, e.loc.y - c.y);
    const tip = [c.x + ux * e.r, c.y + uy * e.r];
    const start = e.dimKind === "diameter" ? [c.x - ux * e.r, c.y - uy * e.r] : [c.x, c.y];
    const end = d > e.r ? [e.loc.x, e.loc.y] : tip;
    lines.push([start, end]);
    arrow(tip, ux, uy);
    if (e.dimKind === "diameter") arrow(start, -ux, -uy);
    const r = readable(a);
    const out = Math.cos(r) * ux + Math.sin(r) * uy >= 0; // il testo segue la linea verso l'esterno
    const tx = d > e.r ? e.loc : { x: c.x + ux * e.r * 0.5, y: c.y + uy * e.r * 0.5 };
    text = { x: tx.x - Math.sin(r) * gap, y: tx.y + Math.cos(r) * gap, rot: r, h: txt, s, hal: d > e.r ? (out ? "right" : "left") : "center", base: "bottom" };
  } else if (e.dimKind === "ordinate") {
    const f = e.feat, l = e.leader, isX = e.axis === "x";
    const sgn = isX ? Math.sign(l.y - f.y) || 1 : Math.sign(l.x - f.x) || 1;
    const p0 = isX ? [f.x, f.y + sgn * exo] : [f.x + sgn * exo, f.y];
    const span = isX ? l.y - f.y : l.x - f.x;
    const p1 = isX ? [f.x, f.y + span * 0.6] : [f.x + span * 0.6, f.y];
    const p2 = isX ? [l.x, f.y + span * 0.8] : [f.x + span * 0.8, l.y];
    lines.push([p0, p1, p2, [l.x, l.y]]);
    const r = isX ? (sgn > 0 ? Math.PI / 2 : -Math.PI / 2) : (sgn > 0 ? 0 : Math.PI);
    const rr = readable(r), flip = Math.abs(rr - r) > 1e-6;
    text = { x: l.x + Math.cos(r) * gap, y: l.y + Math.sin(r) * gap, rot: rr, h: txt, s, hal: flip ? "right" : "left", base: "middle" };
  }
  return { lines, fills, text };
}
// testo della quota come entita' di testo (per disegno e selezione)
export function dimTextEntity(t) {
  const halign = t.hal === "center" ? 1 : t.hal === "right" ? 2 : 0, valign = t.base === "middle" ? 2 : 1;
  return { type: "TEXT", text: t.s, textHeight: t.h, rotation: t.rot, startPoint: { x: t.x, y: t.y }, endPoint: { x: t.x, y: t.y }, halign, valign: halign || valign ? valign : 0 };
}

// ---------------------------------------------------------------- aggancio ai punti notevoli (osnap)
export const SNAP_IT = { end: "Fine", mid: "Medio", cen: "Centro", int: "Intersezione", per: "Perpendicolare", nea: "Vicino", qua: "Quadrante", ins: "Inserimento", nod: "Nodo" };
// model: risultato di build (items, query); modes: {end, mid, ...}; from: ultimo punto (per Perpendicolare); skip(item) -> true se da ignorare
export function osnap(model, x, y, tol, modes, from = null, skip = null) {
  const ids = model.query(x - tol, y - tol, x + tol, y + tol);
  let best = null, bd = tol;
  const cand = (px, py, k, bonus = 0) => { const d = Math.hypot(px - x, py - y) - bonus; if (d <= bd) { bd = d; best = { x: px, y: py, k }; } };
  const near = [];
  for (const i of ids) {
    const it = model.items[i];
    if (skip && skip(it)) continue;
    if (it.t === "N") { const k = it.k === "nod" ? "nod" : it.k === "cen" ? "cen" : it.k === "end" ? "end" : "ins"; if (modes[k]) cand(it.x, it.y, k); continue; }
    if (it.t === "Q") { if (modes.ins) cand(it.ins[0], it.ins[1], "ins"); continue; }
    if (it.hatch) continue;
    const c = closest(it, x, y);
    const isNear = c[3] <= tol;
    if (it.t === "A" && modes.cen && (isNear || Math.hypot(it.cx - x, it.cy - y) <= tol)) cand(it.cx, it.cy, "cen");
    if (!isNear) continue;
    near.push({ it, c });
    if (modes.end) {
      for (const p of curveEnds(it)) cand(p[0], p[1], "end", tol * 0.05);
      if (it.t === "F" && it.pts.length <= 6) for (const p of it.pts) cand(p[0], p[1], "end");
    }
    if (modes.mid) {
      if (it.t === "L") cand((it.x1 + it.x2) / 2, (it.y1 + it.y2) / 2, "mid");
      else if (it.t === "A" && Math.abs(it.sw) < TAU - 1e-9) { const m = arcPoint(it, 0.5); cand(m[0], m[1], "mid"); }
    }
    if (modes.qua && it.t === "A") for (let q = 0; q < 4; q++) { const a = q * Math.PI / 2, u = arcParam(it, a); if (u >= -1e-9 && u <= 1 + 1e-9) cand(it.cx + it.r * Math.cos(a), it.cy + it.r * Math.sin(a), "qua"); }
  }
  if (modes.int && near.length > 1) {
    const L = near.slice(0, 40);
    for (let a = 0; a < L.length; a++) for (let b = a + 1; b < L.length; b++) {
      if (L[a].it.o === L[b].it.o && L[a].it.s === L[b].it.s && L[a].it.t !== "L" && L[b].it.t !== "L") continue;
      for (const r of intersect(L[a].it, L[b].it)) cand(r.x, r.y, "int", tol * 0.04);
    }
  }
  if (modes.per && from) for (const { it } of near) {
    let p = null;
    if (it.t === "L") { const dx = it.x2 - it.x1, dy = it.y2 - it.y1, L2 = dx * dx + dy * dy; if (L2) { const u = ((from[0] - it.x1) * dx + (from[1] - it.y1) * dy) / L2; p = [it.x1 + u * dx, it.y1 + u * dy]; } }
    else if (it.t === "A") { const d = Math.hypot(from[0] - it.cx, from[1] - it.cy); if (d > 1e-12) p = [it.cx + (from[0] - it.cx) / d * it.r, it.cy + (from[1] - it.cy) / d * it.r]; }
    if (p && Math.hypot(p[0] - from[0], p[1] - from[1]) > 1e-9) cand(p[0], p[1], "per");
  }
  if (!best && modes.nea && near.length) { near.sort((a, b) => a.c[3] - b.c[3]); best = { x: near[0].c[0], y: near[0].c[1], k: "nea" }; }
  return best;
}
// simbolo dell'aggancio (in pixel dello schermo)
export function drawSnapMarker(g, x, y, k, dpr = 1) {
  const s = 6 * dpr;
  g.save();
  g.setLineDash([]);
  g.strokeStyle = "#ffd400";
  g.lineWidth = 2 * dpr;
  g.beginPath();
  if (k === "end") g.rect(x - s, y - s, 2 * s, 2 * s);
  else if (k === "mid") { g.moveTo(x, y - s); g.lineTo(x + s, y + s * 0.8); g.lineTo(x - s, y + s * 0.8); g.closePath(); }
  else if (k === "cen") g.arc(x, y, s, 0, TAU);
  else if (k === "int") { g.moveTo(x - s, y - s); g.lineTo(x + s, y + s); g.moveTo(x + s, y - s); g.lineTo(x - s, y + s); }
  else if (k === "per") { g.moveTo(x - s, y - s); g.lineTo(x - s, y + s); g.lineTo(x + s, y + s); g.moveTo(x - s, y); g.lineTo(x, y); g.lineTo(x, y + s); }
  else if (k === "qua") { g.moveTo(x, y - s); g.lineTo(x + s, y); g.lineTo(x, y + s); g.lineTo(x - s, y); g.closePath(); }
  else if (k === "nea") { g.moveTo(x - s, y - s); g.lineTo(x + s, y - s); g.lineTo(x - s, y + s); g.lineTo(x + s, y + s); g.closePath(); }
  else if (k === "ins") { g.rect(x - s, y - s, s, s); g.rect(x, y, s, s); }
  else { g.arc(x, y, s * 0.7, 0, TAU); g.moveTo(x - s, y); g.lineTo(x + s, y); g.moveTo(x, y - s); g.lineTo(x, y + s); }
  g.stroke();
  g.font = `${11 * dpr}px Segoe UI, sans-serif`;
  g.fillStyle = "rgba(0,0,0,.75)";
  const label = SNAP_IT[k] || "";
  const w = g.measureText(label).width + 8 * dpr;
  g.fillRect(x + 10 * dpr, y + 8 * dpr, w, 17 * dpr);
  g.fillStyle = "#ffd400";
  g.fillText(label, x + 14 * dpr, y + 21 * dpr);
  g.restore();
}
