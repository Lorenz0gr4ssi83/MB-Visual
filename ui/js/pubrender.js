// Pubblicazioni: disegno delle pagine. Lo stesso codice disegna sullo schermo (canvas), nelle miniature del pannello
// Pagine e registra l'elenco delle operazioni per l'esportazione PDF (RecordPainter -> mbvisual/publisher.py),
// cosi' il PDF e' identico a cio' che si vede. Qui anche le forme (percorsi M/L/C/Z) e l'impaginazione di tutte le
// storie del documento (catene di caselle collegate, celle delle tabelle, adattamento automatico del testo).
import { t as tr } from "./i18n.js";
import { color, fontName, walk, FIELD } from "./pubmodel.js";
import { layoutStory, fontCss, textWidth } from "./pubtext.js";

// ------------------------------------------------------------------ forme
const K = 0.5523; // approssimazione del cerchio con curve di Bezier
function ellipseCmds(x, y, w, h) {
  const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry, ox = rx * K, oy = ry * K;
  return [["M", cx + rx, cy], ["C", cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry], ["C", cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy],
    ["C", cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry], ["C", cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy], ["Z"]];
}
function roundCmds(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  const o = r * (1 - K);
  return [["M", x + r, y], ["L", x + w - r, y], ["C", x + w - o, y, x + w, y + o, x + w, y + r], ["L", x + w, y + h - r], ["C", x + w, y + h - o, x + w - o, y + h, x + w - r, y + h],
    ["L", x + r, y + h], ["C", x + o, y + h, x, y + h - o, x, y + h - r], ["L", x, y + r], ["C", x, y + o, x + o, y, x + r, y], ["Z"]];
}
const poly = pts => [["M", ...pts[0]], ...pts.slice(1).map(p => ["L", ...p]), ["Z"]];
function star(w, h, n, inner) {
  const pts = [];
  for (let k = 0; k < n * 2; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / n, r = k % 2 ? inner : 1;
    pts.push([w / 2 + (Math.cos(a) * r * w) / 2, h / 2 + (Math.sin(a) * r * h) / 2]);
  }
  return poly(pts);
}
function regular(w, h, n, rot = -Math.PI / 2) {
  const pts = [];
  for (let k = 0; k < n; k++) { const a = rot + (k * 2 * Math.PI) / n; pts.push([w / 2 + (Math.cos(a) * w) / 2, h / 2 + (Math.sin(a) * h) / 2]); }
  return poly(pts);
}
// [id, nome, gruppo]
export const SHAPES = [
  ["line", tr("pubrender.linea"), tr("pubrender.linee")], ["arrow", tr("pubrender.freccia"), tr("pubrender.linee")], ["darrow", tr("pubrender.freccia_doppia"), tr("pubrender.linee")],
  ["rect", tr("pubrender.rettangolo"), tr("pubrender.rettangoli")], ["round", tr("pubrender.rettangolo_arrotondato"), tr("pubrender.rettangoli")], ["snip", tr("pubrender.rettangolo_angolo_tagliato"), tr("pubrender.rettangoli")],
  ["ellipse", tr("pubrender.ovale"), tr("pubrender.forme_base")], ["triangle", tr("pubrender.triangolo_isoscele"), tr("pubrender.forme_base")], ["rtriangle", tr("pubrender.triangolo_rettangolo"), tr("pubrender.forme_base")],
  ["diamond", tr("pubrender.rombo"), tr("pubrender.forme_base")], ["parallelogram", tr("pubrender.parallelogramma"), tr("pubrender.forme_base")], ["trapezoid", tr("pubrender.trapezio"), tr("pubrender.forme_base")],
  ["pentagon", tr("pubrender.pentagono"), tr("pubrender.forme_base")], ["hexagon", tr("pubrender.esagono"), tr("pubrender.forme_base")], ["octagon", tr("pubrender.ottagono"), tr("pubrender.forme_base")],
  ["cross", tr("pubrender.croce"), tr("pubrender.forme_base")], ["donut", tr("pubrender.anello"), tr("pubrender.forme_base")], ["heart", tr("pubrender.cuore"), tr("pubrender.forme_base")], ["moon", tr("pubrender.luna"), tr("pubrender.forme_base")],
  ["arrowR", tr("pubrender.freccia_destra"), tr("pubrender.frecce_blocchi")], ["arrowL", tr("pubrender.freccia_sinistra"), tr("pubrender.frecce_blocchi")], ["arrowU", tr("pubrender.freccia_2"), tr("pubrender.frecce_blocchi")],
  ["arrowD", tr("pubrender.freccia_giu"), tr("pubrender.frecce_blocchi")], ["chevron", tr("pubrender.gallone"), tr("pubrender.frecce_blocchi")], ["homeplate", tr("pubrender.pentagono_freccia"), tr("pubrender.frecce_blocchi")],
  ["star5", tr("pubrender.stella_5_punte"), tr("pubrender.stelle_decorazioni")], ["star8", tr("pubrender.stella_8_punte"), tr("pubrender.stelle_decorazioni")], ["star16", tr("pubrender.stella_16_punte"), tr("pubrender.stelle_decorazioni")],
  ["burst", tr("pubrender.esplosione"), tr("pubrender.stelle_decorazioni")], ["ribbon", tr("pubrender.nastro"), tr("pubrender.stelle_decorazioni")],
  ["callout", tr("pubrender.fumetto_rettangolare"), tr("pubrender.callout")], ["ocallout", tr("pubrender.fumetto_ovale"), tr("pubrender.callout")], ["cloud", tr("pubrender.nuvola"), tr("pubrender.callout")],
];
export function shapeCmds(shape, w, h, o = {}) {
  switch (shape) {
    case "rect": return poly([[0, 0], [w, 0], [w, h], [0, h]]);
    case "round": return roundCmds(0, 0, w, h, o.r ?? Math.min(w, h) * 0.15);
    case "snip": { const c = Math.min(w, h) * 0.2; return poly([[0, 0], [w - c, 0], [w, c], [w, h], [0, h]]); }
    case "ellipse": return ellipseCmds(0, 0, w, h);
    case "triangle": return poly([[w / 2, 0], [w, h], [0, h]]);
    case "rtriangle": return poly([[0, 0], [w, h], [0, h]]);
    case "diamond": return poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]);
    case "parallelogram": return poly([[w * 0.25, 0], [w, 0], [w * 0.75, h], [0, h]]);
    case "trapezoid": return poly([[w * 0.2, 0], [w * 0.8, 0], [w, h], [0, h]]);
    case "pentagon": return regular(w, h, 5);
    case "hexagon": return poly([[w * 0.25, 0], [w * 0.75, 0], [w, h / 2], [w * 0.75, h], [w * 0.25, h], [0, h / 2]]);
    case "octagon": { const a = 0.293; return poly([[w * a, 0], [w * (1 - a), 0], [w, h * a], [w, h * (1 - a)], [w * (1 - a), h], [w * a, h], [0, h * (1 - a)], [0, h * a]]); }
    case "cross": { const a = 0.3, b = 0.7; return poly([[w * a, 0], [w * b, 0], [w * b, h * a], [w, h * a], [w, h * b], [w * b, h * b], [w * b, h], [w * a, h], [w * a, h * b], [0, h * b], [0, h * a], [w * a, h * a]]); }
    case "donut": { const inner = ellipseCmds(w * 0.25, h * 0.25, w * 0.5, h * 0.5); const rev = [["M", w * 0.75, h * 0.5]]; // anello: cerchio interno al contrario
      rev.push(["C", w * 0.75, h * 0.5 - h * 0.25 * K, w * 0.5 + w * 0.25 * K, h * 0.25, w * 0.5, h * 0.25], ["C", w * 0.5 - w * 0.25 * K, h * 0.25, w * 0.25, h * 0.5 - h * 0.25 * K, w * 0.25, h * 0.5],
        ["C", w * 0.25, h * 0.5 + h * 0.25 * K, w * 0.5 - w * 0.25 * K, h * 0.75, w * 0.5, h * 0.75], ["C", w * 0.5 + w * 0.25 * K, h * 0.75, w * 0.75, h * 0.5 + h * 0.25 * K, w * 0.75, h * 0.5], ["Z"]);
      void inner; return [...ellipseCmds(0, 0, w, h), ...rev]; }
    case "heart": return [["M", w / 2, h * 0.28], ["C", w / 2, h * 0.05, w * 0.05, -h * 0.02, w * 0.03, h * 0.3], ["C", w * 0.02, h * 0.55, w * 0.35, h * 0.72, w / 2, h],
      ["C", w * 0.65, h * 0.72, w * 0.98, h * 0.55, w * 0.97, h * 0.3], ["C", w * 0.95, -h * 0.02, w / 2, h * 0.05, w / 2, h * 0.28], ["Z"]];
    case "moon": return [["M", w * 0.75, 0], ["C", w * 0.3, 0, 0, h * 0.25, 0, h / 2], ["C", 0, h * 0.75, w * 0.3, h, w * 0.75, h], ["C", w * 0.45, h * 0.8, w * 0.35, h * 0.65, w * 0.35, h / 2], ["C", w * 0.35, h * 0.35, w * 0.45, h * 0.2, w * 0.75, 0], ["Z"]];
    case "arrowR": return poly([[0, h * 0.25], [w * 0.6, h * 0.25], [w * 0.6, 0], [w, h / 2], [w * 0.6, h], [w * 0.6, h * 0.75], [0, h * 0.75]]);
    case "arrowL": return poly([[w, h * 0.25], [w * 0.4, h * 0.25], [w * 0.4, 0], [0, h / 2], [w * 0.4, h], [w * 0.4, h * 0.75], [w, h * 0.75]]);
    case "arrowU": return poly([[w * 0.25, h], [w * 0.25, h * 0.4], [0, h * 0.4], [w / 2, 0], [w, h * 0.4], [w * 0.75, h * 0.4], [w * 0.75, h]]);
    case "arrowD": return poly([[w * 0.25, 0], [w * 0.75, 0], [w * 0.75, h * 0.6], [w, h * 0.6], [w / 2, h], [0, h * 0.6], [w * 0.25, h * 0.6]]);
    case "chevron": return poly([[0, 0], [w * 0.7, 0], [w, h / 2], [w * 0.7, h], [0, h], [w * 0.3, h / 2]]);
    case "homeplate": return poly([[0, 0], [w * 0.75, 0], [w, h / 2], [w * 0.75, h], [0, h]]);
    case "star5": return star(w, h, 5, 0.4);
    case "star8": return star(w, h, 8, 0.6);
    case "star16": return star(w, h, 16, 0.75);
    case "burst": { const pts = []; const r = [1, 0.62, 0.95, 0.55, 0.88, 0.66, 1, 0.58, 0.92, 0.6, 0.97, 0.52, 0.9, 0.64, 0.98, 0.57, 0.93, 0.6, 1, 0.55, 0.9, 0.63, 0.96, 0.58];
      r.forEach((rr, k) => { const a = (k / r.length) * Math.PI * 2; pts.push([w / 2 + Math.cos(a) * rr * w / 2, h / 2 + Math.sin(a) * rr * h / 2]); }); return poly(pts); }
    case "ribbon": return poly([[0, h * 0.2], [w * 0.15, h * 0.2], [w * 0.15, 0], [w * 0.85, 0], [w * 0.85, h * 0.2], [w, h * 0.2], [w * 0.92, h * 0.5], [w, h * 0.8], [w * 0.85, h * 0.8], [w * 0.85, h * 0.6], [w * 0.15, h * 0.6], [w * 0.15, h * 0.8], [0, h * 0.8], [w * 0.08, h * 0.5]]);
    case "callout": return poly([[0, 0], [w, 0], [w, h * 0.75], [w * 0.45, h * 0.75], [w * 0.2, h], [w * 0.25, h * 0.75], [0, h * 0.75]]);
    case "ocallout": { const e = ellipseCmds(0, 0, w, h * 0.8); return [...e, ...poly([[w * 0.28, h * 0.62], [w * 0.15, h], [w * 0.45, h * 0.78]])]; }
    case "cloud": { const c = []; const bumps = [[0.25, 0.3, 0.22], [0.5, 0.2, 0.25], [0.75, 0.32, 0.22], [0.82, 0.6, 0.2], [0.6, 0.78, 0.22], [0.33, 0.76, 0.22], [0.15, 0.55, 0.18], [0.5, 0.5, 0.3]];
      for (const [cx, cy, r] of bumps) c.push(...ellipseCmds((cx - r) * w, (cy - r) * h, 2 * r * w, 2 * r * h)); return c; }
    case "line": case "arrow": case "darrow": return o.flipV ? [["M", 0, h], ["L", w, 0]] : [["M", 0, 0], ["L", w, h]];
    default: return poly([[0, 0], [w, 0], [w, h], [0, h]]);
  }
}
export const isLine = o => o.type === "shape" && /^(line|arrow|darrow)$/.test(o.shape);
function arrowHead(x1, y1, x2, y2, sw) {
  const a = Math.atan2(y2 - y1, x2 - x1), L = Math.max(6, sw * 4), W = Math.max(3, sw * 2.2);
  const bx = x2 - Math.cos(a) * L, by = y2 - Math.sin(a) * L;
  return poly([[x2, y2], [bx + Math.sin(a) * W, by - Math.cos(a) * W], [bx - Math.sin(a) * W, by + Math.cos(a) * W]]);
}
export const DASHES = { solid: null, dash: [4, 3], dot: [1, 2], dashdot: [5, 2, 1, 2], long: [8, 3] };

// ------------------------------------------------------------------ matrici
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export function invert(m) {
  const d = m[0] * m[3] - m[1] * m[2] || 1e-12;
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
}
// matrice dell'oggetto: coordinate locali (origine in alto a sinistra della cornice) -> pagina
export function objMatrix(o) {
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2, a = ((o.rot || 0) * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a), fx = o.flipH ? -1 : 1, fy = o.flipV && !isLine(o) ? -1 : 1;
  let m = [c, s, -s, c, cx, cy];
  m = mul(m, [fx, 0, 0, fy, 0, 0]);
  return mul(m, [1, 0, 0, 1, -o.w / 2, -o.h / 2]);
}
// riquadro allineato agli assi (oggetti ruotati compresi)
export function aabb(o) {
  const m = objMatrix(o);
  const pts = [apply(m, 0, 0), apply(m, o.w, 0), apply(m, o.w, o.h), apply(m, 0, o.h)];
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

// ------------------------------------------------------------------ pittori
export class CanvasPainter {
  constructor(g, images) { this.g = g; this.images = images; try { g.fontKerning = "none"; } catch { /* */ } }
  save() { this.g.save(); }
  restore() { this.g.restore(); }
  transform(m) { this.g.transform(m[0], m[1], m[2], m[3], m[4], m[5]); }
  alpha(a) { this.g.globalAlpha *= a; }
  path(cmds, st) {
    const p = new Path2D();
    for (const c of cmds) {
      if (c[0] === "M") p.moveTo(c[1], c[2]);
      else if (c[0] === "L") p.lineTo(c[1], c[2]);
      else if (c[0] === "C") p.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
      else if (c[0] === "Z") p.closePath();
    }
    const g = this.g;
    if (st.fill) { g.fillStyle = st.fill; g.fill(p, st.evenodd ? "evenodd" : "nonzero"); }
    if (st.stroke && st.sw > 0) {
      g.strokeStyle = st.stroke; g.lineWidth = st.sw; g.lineJoin = st.join || "miter"; g.lineCap = st.cap || "butt";
      g.setLineDash(st.dash ? st.dash.map(d => d * st.sw) : []);
      g.stroke(p);
      g.setLineDash([]);
    }
  }
  text(str, x, y, st) {
    const g = this.g;
    g.font = st.css;
    if (st.fill) { g.fillStyle = st.fill; g.fillText(str, x, y); }
    if (st.stroke && st.sw > 0) { g.strokeStyle = st.stroke; g.lineWidth = st.sw; g.lineJoin = "round"; g.strokeText(str, x, y); }
  }
  image(id, sx, sy, sw, sh, dx, dy, dw, dh, st = {}) {
    const im = this.images.get(id);
    if (!im) return false;
    const g = this.g;
    const f = filterCss(st.fx);
    if (f) g.filter = f;
    try { g.drawImage(im, sx, sy, sw, sh, dx, dy, dw, dh); } catch { /* immagine non ancora pronta */ }
    if (f) g.filter = "none";
    return true;
  }
}
export function filterCss(fx) {
  if (!fx) return "";
  const f = [];
  if (fx.gray) f.push("grayscale(1)");
  if (fx.sepia) f.push("sepia(1)");
  if (fx.bright) f.push(`brightness(${1 + fx.bright / 100})`);
  if (fx.contrast) f.push(`contrast(${1 + fx.contrast / 100})`);
  if (fx.wash) f.push("contrast(0.45) brightness(1.55)");
  return f.join(" ");
}
// registra le operazioni in coordinate della pagina (per il PDF)
export class RecordPainter {
  constructor() { this.ops = []; this.m = [1, 0, 0, 1, 0, 0]; this.a = 1; this.stack = []; }
  save() { this.stack.push([this.m, this.a]); }
  restore() { [this.m, this.a] = this.stack.pop(); }
  transform(m) { this.m = mul(this.m, m); }
  alpha(a) { this.a *= a; }
  path(cmds, st) {
    const d = cmds.map(c => {
      if (c[0] === "Z") return ["Z"];
      const out = [c[0]];
      for (let k = 1; k < c.length; k += 2) out.push(...apply(this.m, c[k], c[k + 1]).map(v => +v.toFixed(3)));
      return out;
    });
    const sc = Math.sqrt(Math.abs(this.m[0] * this.m[3] - this.m[1] * this.m[2]));
    this.ops.push({ t: "path", d, fill: st.fill || null, stroke: st.stroke && st.sw > 0 ? st.stroke : null, sw: (st.sw || 0) * sc, dash: st.dash ? st.dash.map(v => v * (st.sw || 1) * sc) : null,
      op: this.a, evenodd: !!st.evenodd, join: st.join || "miter", cap: st.cap || "butt" });
  }
  text(str, x, y, st) {
    if (!str) return;
    const [px, py] = apply(this.m, x, y);
    this.ops.push({ t: "text", str, font: st.font, b: !!st.b, i: !!st.i, size: st.size, fill: st.fill || null, stroke: st.stroke && st.sw > 0 ? st.stroke : null, sw: st.sw || 0,
      p: [+px.toFixed(3), +py.toFixed(3)], m: this.m.slice(0, 4).map(v => +v.toFixed(6)), op: this.a });
  }
  link(x, y, w, h, uri) {
    const pts = [apply(this.m, x, y), apply(this.m, x + w, y), apply(this.m, x + w, y + h), apply(this.m, x, y + h)];
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    this.ops.push({ t: "link", r: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], uri });
  }
  image(id, sx, sy, sw, sh, dx, dy, dw, dh, st = {}) {
    const corners = [apply(this.m, dx, dy), apply(this.m, dx + dw, dy), apply(this.m, dx + dw, dy + dh), apply(this.m, dx, dy + dh)];
    this.ops.push({ t: "image", id, src: [sx, sy, sw, sh], q: corners.map(p => p.map(v => +v.toFixed(3))), fx: st.fx || null, op: this.a, outW: dw * Math.hypot(this.m[0], this.m[1]), outH: dh * Math.hypot(this.m[2], this.m[3]) });
    return true;
  }
}

// ------------------------------------------------------------------ impaginazione di tutte le storie
// Ritorna { frames: Map(id -> { layout, cont }), cells: Map("tab:r:c" -> layout), masterFrames(pageNo) }
export function computeLayouts(doc, opts = {}) {
  const frames = new Map(), cells = new Map();
  const pageCount = doc.pages.length;
  const record = opts.record || null;
  const byId = new Map();
  const where = new Map(); // id -> { page index | -1 per i master, lista di livello superiore, indice }
  doc.pages.forEach((p, pi) => p.items.forEach((o, k) => { for (const x of walk([o])) { byId.set(x.id, x); where.set(x.id, { pi, list: p.items, top: o, k }); } }));
  doc.masters.forEach(m => m.items.forEach((o, k) => { for (const x of walk([o])) { byId.set(x.id, x); where.set(x.id, { pi: -1, master: m, list: m.items, top: o, k }); } }));
  // ostacoli: oggetti sopra la casella, nella stessa pagina, con il testo che gira attorno
  const obstaclesFor = f => {
    const w = where.get(f.id);
    if (!w || f.rot) return [];
    const out = [];
    const list = w.list;
    for (let k = w.k + 1; k < list.length; k++) {
      for (const o of walk([list[k]])) {
        if (o.type === "group" || !o.wrap || o.wrap === "none" || o === f) continue;
        const b = aabb(o), d = o.wrapDist ?? 6;
        out.push({ x0: b.x0 - d - f.x, y0: b.y0 - d - f.y, x1: b.x1 + d - f.x, y1: b.y1 + d - f.y, mode: o.wrap });
      }
    }
    return out;
  };
  const containerOf = (f, pageNo) => {
    const pad = f.pad || [4, 4, 4, 4];
    const cw = Math.max(1, f.w - pad[0] - pad[2]), chh = Math.max(1, f.h - pad[1] - pad[3]);
    const n = Math.max(1, f.cols || 1), gap = f.gap ?? 12;
    const colW = (cw - gap * (n - 1)) / n;
    const cols = [];
    for (let k = 0; k < n; k++) cols.push({ x: pad[0] + k * (colW + gap), y: pad[1], w: Math.max(1, colW), h: chh });
    return { id: f.id, cols, valign: f.valign || "t", obstacles: obstaclesFor(f), env: { pageNo, pageCount, record } };
  };
  // catene di caselle: dalla prima (quella a cui nessuno punta)
  const pointed = new Set();
  for (const o of byId.values()) if (o.type === "text" && o.next && byId.has(o.next)) pointed.add(o.next);
  const done = new Set();
  const layoutChain = (head, pageNoForMaster, target = frames) => {
    const chain = [];
    for (let f = head, guard = 0; f && guard < 500 && !chain.includes(f); f = f.next ? byId.get(f.next) : null, guard++) chain.push(f);
    const story = doc.stories[head.story];
    if (!story) return;
    const conts = chain.map(f => { const w = where.get(f.id); return containerOf(f, w && w.pi >= 0 ? w.pi : pageNoForMaster ?? 0); });
    let scale = 1;
    let lay = layoutStory(doc, story, conts, { scale });
    if (chain.length === 1 && (head.fit === "shrink" || head.fit === "best")) {
      let lo = 0.2, hi = head.fit === "best" ? 6 : 1;
      if (head.fit === "shrink" && !lay.overflow) hi = 1;
      else {
        for (let it = 0; it < 14; it++) {
          const mid = (lo + hi) / 2;
          const l2 = layoutStory(doc, story, conts, { scale: mid });
          const fits = !l2.overflow && (head.fit !== "best" || l2.lines.every(L => L.w <= L.avail + 0.5));
          if (fits) lo = mid; else hi = mid;
        }
        scale = lo;
        lay = layoutStory(doc, story, conts, { scale });
      }
    }
    lay.scale = scale;
    lay.chain = chain.map(f => f.id);
    chain.forEach((f, idx) => { target.set(f.id, { layout: lay, cont: idx, story: head.story }); if (target === frames) done.add(f.id); });
  };
  for (const o of byId.values()) {
    if (o.type !== "text" || pointed.has(o.id) || done.has(o.id)) continue;
    const w = where.get(o.id);
    if (w && w.pi < 0) continue; // caselle dei master: per ogni pagina (numeri di pagina), vedi masterLayout
    layoutChain(o);
  }
  // caselle in catene circolari o puntate da caselle sparite
  for (const o of byId.values()) if (o.type === "text" && !done.has(o.id) && where.get(o.id)?.pi >= 0) layoutChain(o);
  // tabelle: una storia per cella, righe che crescono con il testo
  for (const o of byId.values()) {
    if (o.type !== "table") continue;
    const w = where.get(o.id);
    layoutTable(doc, o, cells, { pageNo: w && w.pi >= 0 ? w.pi : 0, pageCount, record });
  }
  const masterCache = new Map();
  const masterLayout = (f, pageNo) => {
    const key = f.id + "@" + pageNo;
    if (!masterCache.has(key)) {
      // le caselle dei master si impaginano per ogni pagina (numeri di pagina, campi)
      const tmp = new Map();
      let head = f;
      for (let g = 0; g < 500; g++) { const prev = [...byId.values()].find(x => x.type === "text" && x.next === head.id); if (!prev) break; head = prev; }
      layoutChain(head, pageNo, tmp);
      for (const [k, v] of tmp) masterCache.set(k + "@" + pageNo, v);
    }
    return masterCache.get(key);
  };
  return { frames, cells, masterLayout, byId, where };
}
export function layoutTable(doc, o, cells, env) {
  const pad = o.pad ?? 3;
  let y = 0;
  const rowsH = [];
  for (let r = 0; r < o.rows; r++) {
    let need = o.rowH[r] || 18;
    const lays = [];
    let x = 0;
    for (let c = 0; c < o.cols; c++) {
      const cell = o.cells[r][c];
      const w = o.colW[c];
      const story = doc.stories[cell.story];
      const cont = { id: `${o.id}:${r}:${c}`, cols: [{ x: pad, y: pad, w: Math.max(1, w - 2 * pad), h: 100000 }], valign: "t", obstacles: [], env };
      const lay = story ? layoutStory(doc, story, [cont]) : { lines: [] };
      const last = lay.lines[lay.lines.length - 1];
      if (last) need = Math.max(need, last.top + last.h + pad);
      lays.push({ lay, x, w });
      x += w;
    }
    for (let c = 0; c < o.cols; c++) {
      const it = lays[c];
      const cell = o.cells[r][c];
      // allineamento verticale della cella
      const last = it.lay.lines[it.lay.lines.length - 1];
      if (last && cell.valign && cell.valign !== "t") {
        const used = last.top + last.h + pad, dy = cell.valign === "m" ? (need - used) / 2 : need - used;
        for (const L of it.lay.lines) { L.top += dy; L.base += dy; }
      }
      cells.set(`${o.id}:${r}:${c}`, { layout: it.lay, x: it.x, y, w: it.w, h: need, r, c });
    }
    rowsH.push(need);
    y += need;
  }
  o._rowsH = rowsH;
  o.colW.length = o.cols;
  const tw = o.colW.reduce((a, b) => a + b, 0);
  if (Math.abs(o.w - tw) > 0.01) o.w = tw;
  if (Math.abs(o.h - y) > 0.01) o.h = y;
}

// ------------------------------------------------------------------ disegno
// env: { doc, lay (computeLayouts), pageNo, painter, editing, scale, record, hideIds }
export function drawPage(env, page) {
  const { doc, painter: P } = env;
  const bg = page.bg?.c ? color(doc, page.bg.c) : "#ffffff";
  P.path([["M", 0, 0], ["L", doc.w, 0], ["L", doc.w, doc.h], ["L", 0, doc.h], ["Z"]], { fill: bg });
  if (page.bg?.img && env.images?.has(page.bg.img)) {
    const im = doc.images[page.bg.img];
    if (im) {
      // riempie la pagina mantenendo le proporzioni (ritaglio centrato)
      const s = Math.max(doc.w / im.w, doc.h / im.h), sw = doc.w / s, sh = doc.h / s;
      P.image(page.bg.img, (im.w - sw) / 2, (im.h - sh) / 2, sw, sh, 0, 0, doc.w, doc.h, {});
    }
  }
  const master = page.master ? doc.masters.find(m => m.id === page.master) : null;
  if (master && !env.masterOnly) for (const o of master.items) drawObj(env, o, true);
  if (env.masterOnly) { for (const o of env.masterOnly.items) drawObj(env, o, true); return; }
  for (const o of page.items) drawObj(env, o, false);
}
export function drawObj(env, o, fromMaster) {
  if (env.hideIds && env.hideIds.has(o.id)) return;
  const { doc, painter: P } = env;
  if (o.type === "group") { for (const c of o.items) drawObj(env, c, fromMaster); return; }
  P.save();
  P.transform(objMatrix(o));
  if (o.opacity !== undefined && o.opacity < 1) P.alpha(o.opacity);
  const line = o.line && o.line.w > 0 && o.line.c && o.line.c !== "none" ? { stroke: color(doc, o.line.c), sw: o.line.w, dash: DASHES[o.line.dash || "solid"] } : {};
  const fill = color(doc, o.fill);
  const shadow = () => o.shadow && !isLine(o) && o.type !== "wordart"; // WordArt: ombra del testo (drawWordArt)
  const boxCmds = () => (o.type === "shape" ? shapeCmds(o.shape, o.w, o.h, o) : o.radius ? shapeCmds("round", o.w, o.h, { r: o.radius }) : shapeCmds("rect", o.w, o.h));
  if (shadow() && (fill || o.type === "image" || o.type === "table")) {
    P.save(); P.transform([1, 0, 0, 1, 3, 3]); P.alpha(0.3); P.path(boxCmds(), { fill: "#000000" }); P.restore();
  }
  if (o.type === "shape") {
    const cmds = shapeCmds(o.shape, o.w, o.h, o);
    if (isLine(o)) {
      const st = { stroke: line.stroke || color(doc, "s0"), sw: o.line?.w || 1, dash: line.dash, cap: "round" };
      if (o.shadow) { P.save(); P.transform([1, 0, 0, 1, 2, 2]); P.alpha(0.3); P.path(cmds, { ...st, stroke: "#000000" }); P.restore(); }
      P.path(cmds, st);
      const [x1, y1] = [cmds[0][1], cmds[0][2]], [x2, y2] = [cmds[1][1], cmds[1][2]];
      if (o.shape === "arrow" || o.shape === "darrow") P.path(arrowHead(x1, y1, x2, y2, st.sw), { fill: st.stroke });
      if (o.shape === "darrow") P.path(arrowHead(x2, y2, x1, y1, st.sw), { fill: st.stroke });
    } else P.path(cmds, { fill, ...line, evenodd: o.shape === "donut" || o.shape === "moon" });
    if (o.story) drawFrameText(env, o, fromMaster);
  } else if (o.type === "text") {
    if (fill || line.stroke) P.path(boxCmds(), { fill, ...line });
    drawFrameText(env, o, fromMaster);
  } else if (o.type === "image") {
    if (fill) P.path(boxCmds(), { fill });
    const im = o.img && doc.images[o.img.id];
    let drawn = false;
    if (im) {
      const c = o.img;
      drawn = P.image(o.img.id, c.sx ?? 0, c.sy ?? 0, c.sw ?? im.w, c.sh ?? im.h, 0, 0, o.w, o.h, { fx: o.fx });
    }
    if (!im && env.editing) {
      // segnaposto immagine (come Publisher): non si stampa
      P.path(shapeCmds("rect", o.w, o.h), { fill: "#eef1f4", stroke: "#9aa4ae", sw: 0.75 / (env.scale || 1), dash: [4, 3] });
      const s = Math.min(o.w, o.h, 60) * 0.5, cx = o.w / 2, cy = o.h / 2;
      P.path([["M", cx - s / 2, cy - s / 3], ["L", cx + s / 2, cy - s / 3], ["L", cx + s / 2, cy + s / 3], ["L", cx - s / 2, cy + s / 3], ["Z"]], { stroke: "#7a8691", sw: Math.max(0.6, s / 30) });
      P.path([["M", cx - s / 2, cy + s / 3], ["L", cx - s / 8, cy - s / 12], ["L", cx + s / 8, cy + s / 6], ["L", cx + s / 4, cy + s / 24], ["L", cx + s / 2, cy + s / 3], ["Z"]], { fill: "#9aa4ae" });
    } else if (im && !drawn && env.editing) P.path(shapeCmds("rect", o.w, o.h), { fill: "#e6e9ec" });
    if (line.stroke) P.path(shapeCmds("rect", o.w, o.h), line);
  } else if (o.type === "table") drawTable(env, o);
  else if (o.type === "wordart") drawWordArt(env, o);
  P.restore();
}
function drawFrameText(env, o, fromMaster) {
  const ent = fromMaster ? env.lay.masterLayout(o, env.pageNo) : env.lay.frames.get(o.id);
  if (!ent) return;
  drawLines(env, ent.layout, ent.cont, ent.layout.scale || 1);
}
export function drawLines(env, layout, contIdx, scale = 1) {
  const { doc, painter: P } = env;
  for (const L of layout.lines) {
    if (L.cont !== contIdx) continue;
    if (L.bullet) {
      const s = L.bullet.s;
      P.text(L.bullet.str, L.bullet.x, L.base, { css: fontCss(doc, s, scale), font: fontName(doc, s.f), size: (s.z || 10) * scale, b: s.b, i: s.i, fill: color(doc, s.c || "s0") });
    }
    for (const g of L.segs) {
      const s = g.s, fill = color(doc, s.c || "s0") || "#000000";
      if (g.str) P.text(g.str, g.x, L.base, { css: fontCss(doc, s, scale), font: fontName(doc, s.f), size: (s.z || 10) * scale, b: s.b, i: s.i, fill });
      if (s.h && P.link) P.link(g.x, L.top, g.w, L.h, s.h);
      if (s.u) {
        const z = (s.z || 10) * scale, th = Math.max(0.4, z * 0.06), yy = L.base + z * 0.12;
        P.path([["M", g.x, yy], ["L", g.x + g.w, yy], ["L", g.x + g.w, yy + th], ["L", g.x, yy + th], ["Z"]], { fill });
      }
    }
  }
}
function drawTable(env, o) {
  const { doc, painter: P } = env;
  const rowsH = o._rowsH || o.rowH;
  let y = 0;
  for (let r = 0; r < o.rows; r++) {
    let x = 0;
    for (let c = 0; c < o.cols; c++) {
      const cell = o.cells[r][c], w = o.colW[c], h = rowsH[r];
      const f = color(doc, cell.fill);
      if (f) P.path(shapeCmds("rect", w, h).map(cm => (cm[0] === "Z" ? cm : [cm[0], cm[1] + x, cm[2] + y])), { fill: f });
      const ent = env.lay.cells.get(`${o.id}:${r}:${c}`);
      if (ent) { P.save(); P.transform([1, 0, 0, 1, x, y]); drawLines(env, ent.layout, 0); P.restore(); }
      x += w;
    }
    y += rowsH[r];
  }
  const b = o.border;
  if (b && b.w > 0 && b.c !== "none") {
    const st = { stroke: color(doc, b.c), sw: b.w, cap: "square" };
    const W = o.colW.reduce((a, v) => a + v, 0), H = rowsH.reduce((a, v) => a + v, 0);
    const d = [];
    let yy = 0;
    for (let r = 0; r <= o.rows; r++) { d.push(["M", 0, yy], ["L", W, yy]); yy += rowsH[r] || 0; }
    let xx = 0;
    for (let c = 0; c <= o.cols; c++) { d.push(["M", xx, 0], ["L", xx, H]); xx += o.colW[c] || 0; }
    P.path(d, st);
  }
}
// WordArt: testo deformato per riempire la cornice
export function drawWordArt(env, o) {
  const { doc, painter: P } = env;
  const text = o.text || " ";
  const s = { f: o.font, z: 100, b: o.b, i: o.i };
  const css = fontCss(doc, s);
  const font = fontName(doc, o.font);
  const fill = color(doc, o.fill), stroke = o.ow > 0 ? color(doc, o.outline) : null;
  const W0 = Math.max(1, textWidth(doc, s, text));
  const passes = o.shadow ? [[3, 3, "#000000", 0.35], [0, 0, null, 1]] : [[0, 0, null, 1]];
  for (const [dx, dy, col, a] of passes) {
    P.save();
    P.transform([1, 0, 0, 1, dx, dy]);
    if (a < 1) P.alpha(a);
    const st = sz => ({ css: fontCss(doc, { ...s, z: sz }), font, size: sz, b: o.b, i: o.i, fill: col || fill, stroke: col ? null : stroke, sw: o.ow });
    if (!o.form || o.form === "piatto") {
      // il testo si allunga sulla cornice (altezza delle maiuscole + discendenti)
      P.transform([o.w / W0, 0, 0, o.h / 100, 0, 0]);
      P.text(text, 0, 80, { ...st(100), sw: o.ow * 100 / Math.max(1, o.h) });
    } else {
      // testo lungo una curva: lettera per lettera
      const chars = Array.from(text);
      const size = o.form === "onda" ? o.h * 0.55 : o.h * 0.42;
      const k = size / 100;
      const widths = chars.map(ch => textWidth(doc, s, ch) * k);
      const total = widths.reduce((a2, b) => a2 + b, 0);
      // arco: freccia (sagitta) = altezza libera della cornice, corda = larghezza
      const up = o.form === "arco";
      const sg = Math.max(4, o.h - size * 1.15), R = (o.w * o.w / 4 + sg * sg) / (2 * sg), half = Math.asin(Math.min(1, o.w / 2 / R));
      const pathLen = o.form === "onda" ? o.w : 2 * half * R * 0.92;
      const fit = pathLen * 0.98 / Math.max(1, total);
      let acc = 0;
      chars.forEach((ch, idx) => {
        const cw = widths[idx] * fit, t = (acc + cw / 2) / (total * fit || 1);
        acc += cw;
        let x, y, ang;
        if (o.form === "onda") { x = t * o.w; y = o.h * 0.62 + Math.sin(t * Math.PI * 2) * o.h * 0.18; ang = Math.atan(Math.cos(t * Math.PI * 2) * o.h * 0.18 * Math.PI * 2 / o.w); }
        else {
          const th = (-half + t * 2 * half) * 0.92;
          const cx = o.w / 2;
          if (up) { const cy = size * 0.95 + R; x = cx + R * Math.sin(th); y = cy - R * Math.cos(th); ang = th; }
          else { const cy = o.h - size * 0.22 - R; x = cx + R * Math.sin(th); y = cy + R * Math.cos(th); ang = -th; }
        }
        P.save();
        const c = Math.cos(ang), sn = Math.sin(ang);
        P.transform([c * fit, sn * fit, -sn, c, x, y]);
        P.text(ch, -cw / 2 / fit, 0, st(size));
        P.restore();
      });
    }
    P.restore();
  }
}
