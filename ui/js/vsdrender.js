// Disegno delle pagine di Visio. Una sola descrizione per schermo, SVG, PNG e PDF: elenco di operazioni in punti
// tipografici con y verso il basso (stesso formato del PDF delle pubblicazioni, mbvisual/publisher.py):
//   { t: "path", d: [["M",x,y],["L",x,y],["C",x1,y1,x2,y2,x,y],["Z"]], fill, stroke, sw, dash, evenodd, cap, join, op, grad }
//   { t: "text", str, p: [x,y] (linea di base), size (pt), font, b, i, fill, m: [a,b,c,d], op }
//   { t: "image", key, m: [a,b,c,d,e,f] (riquadro w x h in pt), w, h, c: [cx,cy], a (gradi) }
// Coordinate di Visio: pollici, y verso l'alto; trasformazione di una forma = T(Pin) R(Angle) S(Flip) T(-LocPin).
import { cell, val, num0, section, rowsOf, rowNum, rowStr, geometry, textEl, color, is1D } from "./vsdmodel.js";

// ------------------------------------------------------------------ matrici [a,b,c,d,e,f]: (x,y) -> (a x + c y + e, b x + d y + f)
export const I = [1, 0, 0, 1, 0, 0];
export const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
export const ap = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export const inv = m => { const d = m[0] * m[3] - m[1] * m[2] || 1e-12; return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d]; };
const T = (x, y) => [1, 0, 0, 1, x, y];
const R = a => [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
const Sc = (x, y) => [x, 0, 0, y, 0, 0];

export function localXf(doc, S) {
  const pinX = num0(doc, S, "PinX"), pinY = num0(doc, S, "PinY"), lx = num0(doc, S, "LocPinX"), ly = num0(doc, S, "LocPinY");
  const a = num0(doc, S, "Angle"), fx = num0(doc, S, "FlipX") ? -1 : 1, fy = num0(doc, S, "FlipY") ? -1 : 1;
  return mul(mul(mul(T(pinX, pinY), R(a)), Sc(fx, fy)), T(-lx, -ly));
}
// pagina: pollici del disegno -> punti sulla carta (y verso il basso), con la scala del disegno
export function pageInfo(doc, page) {
  const ps = page.el.querySelector(":scope > PageSheet") || [...page.el.children].find(c => c.localName === "PageSheet");
  const g = n => { const c = ps && [...ps.children].find(x => x.localName === "Cell" && x.getAttribute("N") === n); return c ? parseFloat(c.getAttribute("V")) : NaN; };
  const W = g("PageWidth") || 8.5, H = g("PageHeight") || 11;
  const psc = g("PageScale"), dsc = g("DrawingScale");
  const r = psc > 0 && dsc > 0 ? psc / dsc : 1;
  const uOf = n => ps && [...ps.children].find(x => x.localName === "Cell" && x.getAttribute("N") === n)?.getAttribute("U");
  const units = uOf("PageWidth") || uOf("DrawingScale") || uOf("PageScale") || "IN";
  return { W, H, r, wPt: W * r * 72, hPt: H * r * 72, P: [72 * r, 0, 0, -72 * r, 0, 72 * r * H], units, ps };
}
export function layersOf(doc, page) {
  const ps = pageInfo(doc, page).ps;
  const out = [];
  if (!ps) return out;
  for (const se of [...ps.children].filter(c => c.localName === "Section" && c.getAttribute("N") === "Layer"))
    for (const r of [...se.children].filter(c => c.localName === "Row")) {
      const g = n => [...r.children].find(c => c.getAttribute("N") === n)?.getAttribute("V");
      out.push({ ix: r.getAttribute("IX"), name: g("Name") || g("NameUniv") || "Livello " + r.getAttribute("IX"), visible: g("Visible") !== "0", print: g("Print") !== "0", lock: g("Lock") === "1", color: g("Color"), row: r });
    }
  return out;
}
export function layerMembers(doc, S) {
  const v = cell(doc, S, "LayerMember")?.v;
  return v ? String(v).split(";").map(s => s.trim()).filter(Boolean) : [];
}

// ------------------------------------------------------------------ geometria -> tracciati (coordinate locali)
function circle3(p0, p1, p2) {
  const ax = p0[0], ay = p0[1], bx = p1[0], by = p1[1], cx = p2[0], cy = p2[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d, uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return [ux, uy, Math.hypot(ax - ux, ay - uy)];
}
// arco di circonferenza in curve di Bezier (spazio "cerchio"), poi mappato con m
function arcBeziers(cx, cy, r, a0, da, m, out) {
  const n = Math.max(1, Math.ceil(Math.abs(da) / (Math.PI / 2) - 1e-9));
  const step = da / n, k = 4 / 3 * Math.tan(step / 4);
  let a = a0;
  for (let i = 0; i < n; i++) {
    const c0 = Math.cos(a), s0 = Math.sin(a), c1 = Math.cos(a + step), s1 = Math.sin(a + step);
    const p1 = ap(m, cx + r * (c0 - k * s0), cy + r * (s0 + k * c0)), p2 = ap(m, cx + r * (c1 + k * s1), cy + r * (s1 - k * c1)), p3 = ap(m, cx + r * c1, cy + r * s1);
    out.push(["C", p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]]);
    a += step;
  }
}
// arco per tre punti (inizio, passaggio, fine) in uno spazio trasformato da m (m = spazio cerchio -> locale)
function arc3(p0, q, p1, m, out) {
  const im = inv(m);
  const a = ap(im, p0[0], p0[1]), b = ap(im, q[0], q[1]), c = ap(im, p1[0], p1[1]);
  const C = circle3(a, b, c);
  if (!C || C[2] > 1e6) { out.push(["L", p1[0], p1[1]]); return; }
  const [ux, uy, r] = C;
  const ang = p => Math.atan2(p[1] - uy, p[0] - ux);
  const a0 = ang(a), a2 = ang(c);
  const ccw = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0;
  const TWO = 2 * Math.PI;
  let da = ccw ? ((a2 - a0) % TWO + TWO) % TWO : -(((a0 - a2) % TWO + TWO) % TWO);
  if (Math.abs(da) < 1e-9) da = ccw ? TWO : -TWO;
  arcBeziers(ux, uy, r, a0, da, m, out);
}
const nums = s => (String(s).match(/-?\d+(\.\d+)?([eE][-+]?\d+)?/g) || []).map(Number);
function nurbs(ctrl, knots, p, steps = 48) {
  const n = ctrl.length;
  if (knots.length < n + p + 1) return ctrl.map(c => [c.x, c.y]);
  const lo = knots[p], hi = knots[n];
  const out = [];
  for (let s = 0; s <= steps; s++) {
    let u = lo + (hi - lo) * s / steps;
    if (s === steps) u = hi - 1e-9 * Math.max(1, Math.abs(hi));
    let k = p;
    while (k < n - 1 && u >= knots[k + 1]) k++;
    const d = [];
    for (let j = 0; j <= p; j++) { const c = ctrl[k - p + j] || ctrl[ctrl.length - 1]; d.push([c.x * c.w, c.y * c.w, c.w]); }
    for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
      const i = k - p + j, den = knots[i + p - r + 1] - knots[i];
      const al = den ? (u - knots[i]) / den : 0;
      for (let q = 0; q < 3; q++) d[j][q] = (1 - al) * d[j - 1][q] + al * d[j][q];
    }
    const w = d[p][2] || 1;
    out.push([d[p][0] / w, d[p][1] / w]);
  }
  return out;
}
// sottopercorsi in coordinate locali: [{ cmds:[["M",x,y],...], closed, noFill, noLine, start, startDir, end, endDir }]
export function shapePaths(doc, S) {
  const W = num0(doc, S, "Width"), H = num0(doc, S, "Height");
  const out = [];
  for (const G of geometry(doc, S)) {
    if (G.noShow) continue;
    let cur = null, start = null, sub = null;
    const flush = () => { if (sub && sub.cmds.length > 1) out.push(sub); sub = null; };
    const moveTo = (x, y) => { flush(); sub = { cmds: [["M", x, y]], noFill: G.noFill, noLine: G.noLine, pts: [[x, y]] }; cur = start = [x, y]; };
    const lineTo = (x, y) => { if (!sub) moveTo(cur?.[0] ?? 0, cur?.[1] ?? 0); sub.cmds.push(["L", x, y]); sub.pts.push([x, y]); cur = [x, y]; };
    for (const r of G.rows) {
      const g = n => rowNum(r, n), rel = r.T.startsWith("Rel");
      const X = rel ? g("X") * W : g("X"), Y = rel ? g("Y") * H : g("Y");
      switch (r.T) {
        case "MoveTo": case "RelMoveTo": moveTo(X, Y); break;
        case "LineTo": case "RelLineTo": lineTo(X, Y); break;
        case "ArcTo": {
          if (!cur) { moveTo(X, Y); break; }
          const A = g("A"), dx = X - cur[0], dy = Y - cur[1], L = Math.hypot(dx, dy);
          if (Math.abs(A) < 1e-9 || L < 1e-12) { lineTo(X, Y); break; }
          const q = [(cur[0] + X) / 2 + A * dy / L, (cur[1] + Y) / 2 - A * dx / L];
          arc3(cur, q, [X, Y], I, sub.cmds); sub.pts.push(q, [X, Y]); cur = [X, Y];
          break;
        }
        case "EllipticalArcTo": case "RelEllipticalArcTo": {
          if (!cur) { moveTo(X, Y); break; }
          const A = rel ? g("A") * W : g("A"), B = rel ? g("B") * H : g("B"), C = g("C"), D = g("D") || 1;
          arc3(cur, [A, B], [X, Y], mul(R(C), Sc(D, 1)), sub.cmds); sub.pts.push([A, B], [X, Y]); cur = [X, Y];
          break;
        }
        case "RelCubBezTo": case "CubBezTo": {
          if (!cur) moveTo(0, 0);
          const k = rel ? [W, H] : [1, 1];
          const a = [g("A") * k[0], g("B") * k[1]], b = [g("C") * k[0], g("D") * k[1]];
          sub.cmds.push(["C", a[0], a[1], b[0], b[1], X, Y]); sub.pts.push(a, b, [X, Y]); cur = [X, Y];
          break;
        }
        case "RelQuadBezTo": case "QuadBezTo": {
          if (!cur) moveTo(0, 0);
          const k = rel ? [W, H] : [1, 1];
          const q = [g("A") * k[0], g("B") * k[1]];
          const c1 = [cur[0] + 2 / 3 * (q[0] - cur[0]), cur[1] + 2 / 3 * (q[1] - cur[1])], c2 = [X + 2 / 3 * (q[0] - X), Y + 2 / 3 * (q[1] - Y)];
          sub.cmds.push(["C", c1[0], c1[1], c2[0], c2[1], X, Y]); sub.pts.push(q, [X, Y]); cur = [X, Y];
          break;
        }
        case "PolylineTo": {
          const a = nums(rowStr(r, "A"));
          const xt = a[0], yt = a[1];
          for (let i = 2; i + 1 < a.length; i += 2) lineTo(xt === 0 ? a[i] * W : a[i], yt === 0 ? a[i + 1] * H : a[i + 1]);
          lineTo(X, Y);
          break;
        }
        case "NURBSTo": {
          if (!cur) moveTo(0, 0);
          const e = nums(rowStr(r, "E"));
          if (e.length < 4) { lineTo(X, Y); break; }
          const [last, deg, xt, yt] = e;
          const ctrl = [{ x: cur[0], y: cur[1], w: g("D") || 1 }], knots = [g("C")];
          for (let i = 4; i + 3 < e.length; i += 4) { ctrl.push({ x: xt === 0 ? e[i] * W : e[i], y: yt === 0 ? e[i + 1] * H : e[i + 1], w: e[i + 3] || 1 }); knots.push(e[i + 2]); }
          ctrl.push({ x: X, y: Y, w: g("B") || 1 });
          knots.push(g("A"), last);
          const p = Math.max(1, Math.round(deg) || 3);
          const full = [...Array(p).fill(knots[0]), ...knots];
          const pts = nurbs(ctrl, full, Math.min(p, ctrl.length - 1));
          for (const q of pts.slice(1)) lineTo(q[0], q[1]);
          lineTo(X, Y);
          break;
        }
        case "SplineStart": lineTo(X, Y); break;
        case "SplineKnot": lineTo(X, Y); break;
        case "Ellipse": {
          flush();
          const cx = X, cy = Y, ux = g("A") - cx, uy = g("B") - cy, vx = g("C") - cx, vy = g("D") - cy;
          const m = [ux, uy, vx, vy, cx, cy];
          const cmds = [["M", ...ap(m, 1, 0)]];
          arcBeziers(0, 0, 1, 0, 2 * Math.PI, m, cmds);
          cmds.push(["Z"]);
          out.push({ cmds, closed: true, noFill: G.noFill, noLine: G.noLine, pts: [ap(m, 1, 0), ap(m, -1, 0), ap(m, 0, 1), ap(m, 0, -1)] });
          cur = null;
          break;
        }
        case "InfiniteLine": {
          flush();
          const B = rel ? g("B") * H : g("B"), A = rel ? g("A") * W : g("A");
          const dx = A - X, dy = B - Y, L = Math.hypot(dx, dy) || 1, k = 1000;
          out.push({ cmds: [["M", X - dx / L * k, Y - dy / L * k], ["L", X + dx / L * k, Y + dy / L * k]], noFill: true, noLine: G.noLine, infinite: true, pts: [] });
          break;
        }
        default: break;
      }
    }
    flush();
  }
  // arrotondamento degli angoli (cella Rounding): Visio lo applica ai vertici dei tratti rettilinei
  const rnd = num0(doc, S, "Rounding");
  if (rnd > 0) for (const s of out) if (s.cmds.every(c => c[0] === "M" || c[0] === "L")) s.cmds = roundCorners(s.cmds, rnd);
  for (const s of out) {
    if (s.closed == null) {
      const a = s.cmds[0], z = s.cmds[s.cmds.length - 1];
      const zx = z[z.length - 2], zy = z[z.length - 1];
      s.closed = Math.abs(a[1] - zx) < 1e-6 && Math.abs(a[2] - zy) < 1e-6;
    }
  }
  return out;
}

function roundCorners(cmds, r) {
  const pts = cmds.map(c => [c[1], c[2]]);
  const closed = pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-9;
  const P = closed ? pts.slice(0, -1) : pts;
  const n = P.length;
  if (n < 3 && closed || n < 3) return cmds;
  const corner = i => {
    const a = P[(i - 1 + n) % n], b = P[i], c = P[(i + 1) % n];
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    if (rr < 1e-9 || !l1 || !l2) return null;
    const p1 = [b[0] + (a[0] - b[0]) / l1 * rr, b[1] + (a[1] - b[1]) / l1 * rr], p2 = [b[0] + (c[0] - b[0]) / l2 * rr, b[1] + (c[1] - b[1]) / l2 * rr];
    const k = 0.5523;
    return { p1, p2, c1: [p1[0] + (b[0] - p1[0]) * k, p1[1] + (b[1] - p1[1]) * k], c2: [p2[0] + (b[0] - p2[0]) * k, p2[1] + (b[1] - p2[1]) * k] };
  };
  const out = [];
  const idx = closed ? [...Array(n).keys()] : [...Array(n).keys()].slice(1, -1);
  const cs = new Map(idx.map(i => [i, corner(i)]));
  const start = closed ? (cs.get(0)?.p2 || P[0]) : P[0];
  out.push(["M", ...start]);
  for (let j = 1; j <= (closed ? n : n - 1); j++) {
    const i = j % n;
    const c = cs.get(i);
    if (c) { out.push(["L", ...c.p1], ["C", ...c.c1, ...c.c2, ...c.p2]); }
    else out.push(["L", ...P[i]]);
  }
  return out;
}

// ------------------------------------------------------------------ stile
const DASHES = { 2: [4, 3], 3: [1, 2], 4: [4, 2, 1, 2], 5: [4, 2, 1, 2, 1, 2], 6: [8, 3], 7: [1, 1], 8: [6, 3, 1, 3], 9: [4, 4], 10: [2, 2], 11: [1, 3], 12: [8, 2, 2, 2], 13: [8, 2, 2, 2, 2, 2], 14: [10, 4], 15: [10, 3, 3, 3], 16: [12, 6], 17: [2, 4], 18: [12, 3, 3, 3, 3, 3], 19: [16, 4], 20: [16, 3, 3, 3], 21: [16, 3, 3, 3, 3, 3], 22: [24, 6], 23: [1, 3] };
const ARROW_LEN = [0.045, 0.06, 0.085, 0.11, 0.15, 0.22, 0.32];
function lineStyle(doc, S) {
  const pat = num0(doc, S, "LinePattern", 1);
  if (!pat) return null;
  const sw = Math.max(0, num0(doc, S, "LineWeight", 0.01)) * 72;
  const c = color(doc, val(doc, S, "LineColor", 0), "line", S) || "#000000";
  const op = 1 - num0(doc, S, "LineColorTrans", 0);
  const capV = num0(doc, S, "LineCap", 0);
  const dash = DASHES[pat]?.map(x => x * Math.max(sw, 0.75));
  return { stroke: c, sw: Math.max(sw, 0.25), dash, op, cap: capV === 1 ? "square" : capV === 2 ? "butt" : "round", join: num0(doc, S, "Rounding", 0) > 0 ? "round" : "miter" };
}
function fillStyle(doc, S) {
  const pat = num0(doc, S, "FillPattern", 1);
  if (!pat) return null;
  const fg = color(doc, val(doc, S, "FillForegnd", 1), "fill", S) || "#ffffff";
  const bg = color(doc, val(doc, S, "FillBkgnd", 0), "fill", S) || "#ffffff";
  const op = 1 - num0(doc, S, "FillForegndTrans", 0);
  if (num0(doc, S, "FillGradientEnabled", 0) === 1) {
    const stops = rowsOf(doc, S, "FillGradient").map(r => [rowNum(r, "GradientStopPosition"), color(doc, rowStr(r, "GradientStopColor", "#ffffff")) || "#ffffff", 1 - rowNum(r, "GradientStopColorTrans")]).filter(s => s[1]);
    if (stops.length >= 2) return { fill: stops[0][1], op: 1, grad: { angle: num0(doc, S, "FillGradientAngle", Math.PI / 2), radial: num0(doc, S, "FillGradientDir", 0) > 0, stops } };
  }
  if (pat === 1) return { fill: fg, op };
  if (pat >= 25 && pat <= 40) return { fill: fg, op, grad: { angle: pat === 25 || pat === 26 ? 0 : Math.PI / 2, radial: pat >= 31, stops: [[0, fg, op], [1, bg, 1 - num0(doc, S, "FillBkgndTrans", 0)]] } };
  // retini (2-24): colore medio tra primo piano e sfondo
  const mix = (a, b) => "#" + [1, 3, 5].map(i => Math.round((parseInt(a.substr(i, 2), 16) + parseInt(b.substr(i, 2), 16)) / 2).toString(16).padStart(2, "0")).join("");
  return { fill: mix(fg, bg), op };
}

// ------------------------------------------------------------------ testo
let mctx = null;
const fontCss = (st, px) => `${st.i ? "italic " : ""}${st.b ? "bold " : ""}${px}px "${st.font}", "Segoe UI", Arial, sans-serif`;
export function measure(str, st) {
  mctx ||= document.createElement("canvas").getContext("2d");
  mctx.font = fontCss(st, 100);
  return mctx.measureText(str).width / 100 * st.size * (st.scale || 1) + (st.ls || 0) * str.length;
}
function fontName(doc, v) {
  if (v == null || v === "") return doc.theme.minor;
  if (typeof v === "number" || /^\d+$/.test(v)) return doc.faces.get(String(v)) || "Calibri";
  if (/^Themed$/i.test(v)) return doc.theme.minor;
  return String(v);
}
function charStyle(doc, R, themedText) {
  const st = rowNum(R, "Style");
  const caseV = rowNum(R, "Case");
  return {
    font: fontName(doc, R?.cells.get("Font")?.v), size: Math.max(1, (rowNum(R, "Size", 0.1667) || 0.1667) * 72),
    fill: (/^Themed$/i.test(R?.cells.get("Color")?.v || "") && themedText) || color(doc, R?.cells.get("Color")?.v ?? 0, "text") || "#000000", op: 1 - rowNum(R, "ColorTrans"),
    b: !!(st & 1), i: !!(st & 2), u: !!(st & 4) || rowNum(R, "DblUnderline") > 0, sc: !!(st & 8), s: rowNum(R, "Strikethru") > 0,
    caps: caseV === 1, scale: rowNum(R, "FontScale", 1) || 1, ls: rowNum(R, "Letterspace") * 72, pos: rowNum(R, "Pos"),
  };
}
// testo della forma in paragrafi di frammenti { s, cp, pp }
export function textRuns(S) {
  const t = textEl(S);
  if (!t) return [];
  const runs = [];
  let cp = 0, pp = 0;
  for (const n of t.childNodes) {
    if (n.nodeType === 3 || n.nodeType === 4) { if (n.nodeValue) runs.push({ s: n.nodeValue, cp, pp }); }
    else if (n.localName === "cp") cp = +n.getAttribute("IX") || 0;
    else if (n.localName === "pp") pp = +n.getAttribute("IX") || 0;
    else if (n.localName === "tp") { /* tabulazioni */ }
    else if (n.localName === "fld") runs.push({ s: n.textContent, cp, pp, fld: +n.getAttribute("IX") || 0 });
  }
  let s = runs.map(r => r.s).join("");
  if (!s.trim()) return [];
  const paras = [[]];
  for (const r of runs) {
    const parts = r.s.replace(/\r\n?/g, "\n").split("\n");
    parts.forEach((p, i) => { if (i) paras.push([]); if (p) paras[paras.length - 1].push({ ...r, s: p.replace(/\t/g, "    ") }); });
  }
  if (paras.length > 1 && !paras[paras.length - 1].length) paras.pop();
  return paras;
}
export function textBlock(doc, S) {
  const W = num0(doc, S, "Width"), H = num0(doc, S, "Height");
  const has = n => cell(doc, S, n) != null;
  const tw = has("TxtWidth") ? num0(doc, S, "TxtWidth") : W, th = has("TxtHeight") ? num0(doc, S, "TxtHeight") : H;
  return {
    pinX: has("TxtPinX") ? num0(doc, S, "TxtPinX") : W / 2, pinY: has("TxtPinY") ? num0(doc, S, "TxtPinY") : H / 2,
    w: tw, h: th, locX: has("TxtLocPinX") ? num0(doc, S, "TxtLocPinX") : tw / 2, locY: has("TxtLocPinY") ? num0(doc, S, "TxtLocPinY") : th / 2, angle: num0(doc, S, "TxtAngle"),
  };
}
// matrice dal riquadro del testo (punti, y verso il basso, origine in alto a sinistra) alla pagina
export function textMatrix(doc, S, M, r) {
  const tb = textBlock(doc, S);
  const bm = mul(mul(mul(M, T(tb.pinX, tb.pinY)), R(tb.angle)), T(-tb.locX, -tb.locY));
  return { m: mul(bm, [1 / (72 * r), 0, 0, -1 / (72 * r), 0, tb.h]), wPt: Math.abs(tb.w) * 72 * r, hPt: Math.abs(tb.h) * 72 * r, tb };
}
export function layoutText(doc, S, M, r, ops, opts = {}) {
  if (num0(doc, S, "HideText") === 1 && !opts.force) return null;
  const paras = opts.paras || textRuns(S);
  if (!paras.length) return null;
  const chars = rowsOf(doc, S, "Character"), parasR = rowsOf(doc, S, "Paragraph");
  const cs = new Map(), ps = new Map();
  // testo "del tema": chiaro sulle forme riempite con i colori del tema (come lo stile predefinito di Visio)
  const themedText = /^Themed$/i.test(String(cell(doc, S, "FillForegnd")?.v || "")) && num0(doc, S, "FillPattern", 1) > 0 && doc.hasTheme ? doc.theme.colors.lt1 || "#ffffff" : null;
  const cStyle = ix => { if (!cs.has(ix)) cs.set(ix, charStyle(doc, chars.find(c => (c.ix ?? 0) === ix) || chars[0], themedText)); return cs.get(ix); };
  const pStyle = ix => {
    if (!ps.has(ix)) {
      const R0 = parasR.find(c => (c.ix ?? 0) === ix) || parasR[0];
      ps.set(ix, { align: rowNum(R0, "HorzAlign", 1), indF: rowNum(R0, "IndFirst") * 72, indL: rowNum(R0, "IndLeft") * 72, indR: rowNum(R0, "IndRight") * 72, sp: rowNum(R0, "SpLine", -1.2), before: rowNum(R0, "SpBefore") * 72, after: rowNum(R0, "SpAfter") * 72, bullet: rowNum(R0, "Bullet"), bstr: rowStr(R0, "BulletStr") });
    }
    return ps.get(ix);
  };
  const { m, wPt, hPt } = textMatrix(doc, S, M, r);
  const ml = num0(doc, S, "LeftMargin") * 72, mr = num0(doc, S, "RightMargin") * 72, mt = num0(doc, S, "TopMargin") * 72, mb = num0(doc, S, "BottomMargin") * 72;
  const avail = Math.max(1, wPt - ml - mr);
  const lines = [];
  for (const para of paras) {
    const P = pStyle(para[0]?.pp ?? 0);
    const width = Math.max(4, avail - P.indL - P.indR);
    // parole con i loro stili
    const toks = [];
    for (const run of para) {
      const st = cStyle(run.cp);
      const s = st.caps ? run.s.toUpperCase() : run.s;
      for (const w of s.split(/(\s+)/)) if (w) toks.push({ s: w, st, sp: /^\s+$/.test(w) });
    }
    if (!toks.length) { const st = cStyle(para[0]?.cp ?? 0); lines.push({ segs: [], P, size: st.size, first: true, w: 0 }); continue; }
    let line = { segs: [], P, w: 0, first: true }, x = P.indF;
    const push = () => { lines.push(line); line = { segs: [], P, w: 0, first: false }; x = 0; };
    for (const t of toks) {
      let tw = measure(t.s, t.st);
      if (!t.sp && x + tw > width - (line.first ? 0 : 0) + 0.01 && line.segs.some(s => !s.sp)) push();
      if (t.sp && !line.segs.length && !line.first) continue;
      if (!t.sp && tw > width && x === 0) {
        // parola piu' lunga della riga: si spezza
        let part = "";
        for (const ch of t.s) {
          const nw = measure(part + ch, t.st);
          if (nw > width && part) { line.segs.push({ s: part, st: t.st, x, w: measure(part, t.st) }); push(); part = ch; } else part += ch;
        }
        tw = measure(part, t.st);
        line.segs.push({ s: part, st: t.st, x, w: tw }); x += tw;
        continue;
      }
      line.segs.push({ s: t.s, st: t.st, x, w: tw, sp: t.sp });
      x += tw;
    }
    lines.push(line);
  }
  // altezza delle righe
  let total = 0;
  for (const L of lines) {
    const size = Math.max(L.size || 0, ...L.segs.map(s => s.st.size));
    L.size = size;
    const sp = L.P.sp;
    L.h = sp < 0 ? size * -sp : sp > 0 ? Math.max(sp * 72, size) : size * 1.2;
    L.top = (L.first ? L.P.before : 0);
    while (L.segs.length && L.segs[L.segs.length - 1].sp) L.segs.pop();
    const merged = [];
    for (const sg of L.segs) { const q = merged[merged.length - 1]; if (q && q.st === sg.st) { q.s += sg.s; q.w = sg.x + sg.w - q.x; q.sp = false; } else merged.push({ ...sg }); }
    L.segs = merged;
    L.w = L.segs.length ? L.segs[L.segs.length - 1].x + L.segs[L.segs.length - 1].w : 0;
    total += L.top + L.h;
  }
  for (let i = 0; i < lines.length; i++) if (i + 1 < lines.length && lines[i + 1].first) { lines[i].bottom = lines[i].P.after; total += lines[i].bottom; }
  const va = num0(doc, S, "VerticalAlign", 1);
  const boxH = hPt - mt - mb;
  let y = mt + (va === 0 ? 0 : va === 2 ? boxH - total : (boxH - total) / 2);
  const lin = [m[0], m[1], m[2], m[3]];
  const sc = Math.hypot(lin[0], lin[1]) || 1, sc2 = Math.hypot(lin[2], lin[3]) || 1;
  const gm = [lin[0] / sc, lin[1] / sc, lin[2] / sc2, lin[3] / sc2];
  const toPage = (u, v) => ap(m, u, v);
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  const textOps = [];
  // sfondo del testo
  const bk = val(doc, S, "TextBkgnd", 0);
  let bkc = null;
  if (typeof bk === "string" && bk[0] === "#") bkc = bk; else if (typeof bk === "number" && bk > 0) bkc = doc.colors[bk - 1] || null;
  for (const L of lines) {
    y += L.top;
    const P = L.P;
    const width = Math.max(4, avail - P.indL - P.indR);
    const lineX0 = L.first ? P.indF : 0;
    let x0 = ml + P.indL + (P.align === 1 ? (width - L.w + lineX0) / 2 - lineX0 / 2 : P.align === 2 ? width - L.w : 0);
    if (P.align === 1) x0 = ml + P.indL + (width - L.w) / 2;
    const base = y + (L.h - L.size) / 2 + L.size * 0.86;
    if (L.first && P.bullet > 0 && L.segs.length) {
      const st = L.segs[0].st;
      const p = toPage(x0 + L.segs[0].x - st.size * 0.9, base);
      textOps.push({ t: "text", str: P.bstr || "•", p, size: st.size, font: st.font, fill: st.fill, m: gm, op: st.op });
    }
    for (const sg of L.segs) {
      if (sg.sp && sg.s.trim() === "") continue;
      const st = sg.st;
      const px = x0 + sg.x, py = base - (st.pos === 1 ? -st.size * 0.33 : st.pos === 2 ? st.size * 0.33 : 0);
      const size = st.pos ? st.size * 0.66 : st.size;
      const p = toPage(px, py);
      textOps.push({ t: "text", str: sg.s, p, size, font: st.font, b: st.b, i: st.i, fill: st.fill, m: st.scale !== 1 ? [gm[0] * st.scale, gm[1] * st.scale, gm[2], gm[3]] : gm, op: st.op });
      if (st.u || st.s) {
        const yy = st.u ? py + size * 0.12 : py - size * 0.3;
        const a = toPage(px, yy), b = toPage(px + sg.w, yy);
        textOps.push({ t: "path", d: [["M", ...a], ["L", ...b]], stroke: st.fill, sw: Math.max(0.5, size / 16), op: st.op });
      }
      for (const [u, v] of [[px, py - size], [px + sg.w, py + size * 0.25]]) {
        const q = toPage(u, v);
        bbox[0] = Math.min(bbox[0], q[0]); bbox[1] = Math.min(bbox[1], q[1]); bbox[2] = Math.max(bbox[2], q[0]); bbox[3] = Math.max(bbox[3], q[1]);
      }
    }
    y += L.h + (L.bottom || 0);
  }
  if (bkc && isFinite(bbox[0])) {
    // riquadro di sfondo nel sistema del testo
    const yTop = mt + (va === 0 ? 0 : va === 2 ? boxH - total : (boxH - total) / 2);
    const minX = Math.min(...lines.map(L => ml + L.P.indL + (L.P.align === 1 ? (Math.max(4, avail - L.P.indL - L.P.indR) - L.w) / 2 : L.P.align === 2 ? Math.max(4, avail - L.P.indL - L.P.indR) - L.w : 0)));
    const maxW = Math.max(...lines.map(L => L.w));
    const c = [[minX - 2, yTop - 1], [minX + maxW + 2, yTop - 1], [minX + maxW + 2, yTop + total + 1], [minX - 2, yTop + total + 1]].map(([u, v]) => toPage(u, v));
    ops.push({ t: "path", d: [["M", ...c[0]], ["L", ...c[1]], ["L", ...c[2]], ["L", ...c[3]], ["Z"]], fill: bkc, op: 1 - num0(doc, S, "TextBkgndTrans", 0) });
  }
  ops.push(...textOps);
  return bbox;
}

// ------------------------------------------------------------------ frecce
function arrowOps(type, size, tip, from, ls, ops) {
  const dx = tip[0] - from[0], dy = tip[1] - from[1], L = Math.hypot(dx, dy);
  if (!type || L < 1e-9) return;
  const ux = dx / L, uy = dy / L, len = (ARROW_LEN[Math.max(0, Math.min(6, size))] || 0.085) * 72 + ls.sw * 1.5, wid = len * 0.42;
  const base = [tip[0] - ux * len, tip[1] - uy * len];
  const l = [base[0] - uy * wid, base[1] + ux * wid], r = [base[0] + uy * wid, base[1] - ux * wid];
  const open = [1, 2, 3, 6, 9, 15, 16, 17].includes(type);
  if ([10, 20, 21, 22, 23, 24, 25, 26, 27].includes(type)) {
    const c = [tip[0] - ux * len / 2, tip[1] - uy * len / 2], k = 0.5523 * len / 2, rr = len / 2;
    ops.push({ t: "path", d: [["M", c[0] + rr, c[1]], ["C", c[0] + rr, c[1] + k, c[0] + k, c[1] + rr, c[0], c[1] + rr], ["C", c[0] - k, c[1] + rr, c[0] - rr, c[1] + k, c[0] - rr, c[1]], ["C", c[0] - rr, c[1] - k, c[0] - k, c[1] - rr, c[0], c[1] - rr], ["C", c[0] + k, c[1] - rr, c[0] + rr, c[1] - k, c[0] + rr, c[1]], ["Z"]], fill: type === 22 || type === 23 ? "#ffffff" : ls.stroke, stroke: ls.stroke, sw: ls.sw, op: ls.op });
    return;
  }
  if (open) ops.push({ t: "path", d: [["M", ...l], ["L", ...tip], ["L", ...r]], stroke: ls.stroke, sw: ls.sw, op: ls.op, cap: "round", join: "round" });
  else ops.push({ t: "path", d: [["M", ...l], ["L", ...tip], ["L", ...r], ["Z"]], fill: [7, 8, 11, 12].includes(type) ? "#ffffff" : ls.stroke, stroke: ls.stroke, sw: Math.min(ls.sw, 1), op: ls.op, join: "miter" });
}

// ------------------------------------------------------------------ immagini
export function imageKey(doc, S) {
  for (let s = S; s; s = s.ms) {
    const fd = s.el && [...s.el.children].find(c => c.localName === "ForeignData");
    if (!fd) continue;
    const rel = [...fd.children].find(c => c.localName === "Rel");
    const id = rel?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    const rels = s.inMaster || s.el.ownerDocument !== S.page?.xml ? s.master?.rels : S.page?.rels;
    const tgt = id && (rels?.get(id) || S.page?.rels.get(id))?.target;
    if (tgt) return { key: tgt, type: fd.getAttribute("ForeignType") };
  }
  return null;
}

// ------------------------------------------------------------------ pagina
// risultato: { info, items: [{ S, ops, box }], back: [ops] }
export function renderPage(doc, page, model, opts = {}) {
  const info = pageInfo(doc, page);
  const layers = layersOf(doc, page);
  const hidden = new Set(layers.filter(l => !(opts.print ? l.print : l.visible)).map(l => l.ix));
  const items = [];
  const drawShape = (S, PM, ops, depth = 0) => {
    if (depth > 30) return;
    const lm = layerMembers(doc, S);
    if (lm.length && lm.every(l => hidden.has(l))) return;
    const M = mul(PM, localXf(doc, S));
    const isGroup = S.el?.getAttribute("Type") === "Group" || (!S.el && S.ms?.el?.getAttribute("Type") === "Group");
    const subs = shapePaths(doc, S);
    if (subs.length) {
      const fs = fillStyle(doc, S), ls = lineStyle(doc, S);
      const tr = c => c[0] === "Z" ? c : c[0] === "C" ? ["C", ...ap(M, c[1], c[2]), ...ap(M, c[3], c[4]), ...ap(M, c[5], c[6])] : [c[0], ...ap(M, c[1], c[2])];
      // ombra (stile classico: ShdwPattern) sotto la forma
      if (fs && num0(doc, S, "ShdwPattern") > 0) {
        const dx = num0(doc, S, "ShapeShdwOffsetX", 0) || 0.0417, dy = num0(doc, S, "ShapeShdwOffsetY", 0) || -0.0417;
        const sd = [];
        for (const s of subs) if (s.closed && !s.noFill) for (const c of s.cmds) sd.push(c[0] === "Z" ? c : c[0] === "C" ? ["C", ...ap(M, c[1] + 0, c[2]), ...ap(M, c[3], c[4]), ...ap(M, c[5], c[6])] : [c[0], ...ap(M, c[1], c[2])]);
        const off = [dx * 72 * info.r, -dy * 72 * info.r];
        if (sd.length) ops.push({ t: "path", d: sd.map(c => c[0] === "Z" ? c : c[0] === "C" ? ["C", c[1] + off[0], c[2] + off[1], c[3] + off[0], c[4] + off[1], c[5] + off[0], c[6] + off[1]] : [c[0], c[1] + off[0], c[2] + off[1]]), fill: color(doc, val(doc, S, "ShdwForegnd", 19), "shadow", S) || "#808080", op: 1 - num0(doc, S, "ShdwForegndTrans", 0) * 1 });
      }
      if (fs) {
        const d = [];
        for (const s of subs) if (s.closed && !s.noFill) { d.push(...s.cmds.map(tr)); if (d[d.length - 1][0] !== "Z") d.push(["Z"]); }
        if (d.length) ops.push({ t: "path", d, fill: fs.fill, op: fs.op, grad: fs.grad, evenodd: true });
      }
      if (ls) {
        const d = [];
        for (const s of subs) if (!s.noLine) { d.push(...s.cmds.map(tr)); if (s.closed && d[d.length - 1][0] !== "Z") d.push(["Z"]); }
        if (d.length) ops.push({ t: "path", ...ls, d });
        // frecce: solo sui tracciati aperti
        const open = subs.filter(s => !s.closed && !s.noLine && !s.infinite);
        if (open.length) {
          const ba = num0(doc, S, "BeginArrow"), ea = num0(doc, S, "EndArrow");
          if (ba) { const s = open[0], p = s.pts; arrowOps(ba, num0(doc, S, "BeginArrowSize", 2), ap(M, ...p[0]), ap(M, ...(p[1] || p[0])), ls, ops); }
          if (ea) { const s = open[open.length - 1], p = s.pts; arrowOps(ea, num0(doc, S, "EndArrowSize", 2), ap(M, ...p[p.length - 1]), ap(M, ...(p[p.length - 2] || p[0])), ls, ops); }
        }
      }
    }
    const type = S.el?.getAttribute("Type") || S.ms?.el?.getAttribute("Type");
    if (type === "Foreign") {
      const ik = imageKey(doc, S);
      const W = num0(doc, S, "Width"), H = num0(doc, S, "Height");
      const ox = cell(doc, S, "ImgOffsetX") ? num0(doc, S, "ImgOffsetX") : 0, oy = cell(doc, S, "ImgOffsetY") ? num0(doc, S, "ImgOffsetY") : 0;
      const iw = cell(doc, S, "ImgWidth") ? num0(doc, S, "ImgWidth") : W, ih = cell(doc, S, "ImgHeight") ? num0(doc, S, "ImgHeight") : H;
      const o = ap(M, ox, oy + ih), xa = [M[0] * iw, M[1] * iw], ya = [-M[2] * ih, -M[3] * ih];
      const w = Math.hypot(...xa), h = Math.hypot(...ya);
      if (ik && w > 0 && h > 0) {
        const m = [xa[0] / w, xa[1] / w, ya[0] / h, ya[1] / h, o[0], o[1]];
        ops.push({ t: "image", key: ik.key, ftype: ik.type, m, w, h, c: ap(m, w / 2, h / 2), a: Math.atan2(m[1], m[0]) * 180 / Math.PI });
      }
    }
    if (isGroup) for (const C of S.children) drawShape(C, M, ops, depth + 1);
    layoutText(doc, S, M, info.r, ops);
  };
  // pagina di sfondo (anche a catena)
  const back = [];
  const seen = new Set([page.id]);
  for (let bp = page.backPage && doc.pages.find(p => p.id === page.backPage); bp && !seen.has(bp.id); bp = bp.backPage && doc.pages.find(p => p.id === bp.backPage)) {
    seen.add(bp.id);
    const bmodel = opts.models?.(bp);
    if (!bmodel) break;
    const ops = [];
    for (const S of bmodel.top) drawShape(S, pageInfo(doc, bp).P, ops);
    back.unshift(...ops);
  }
  for (const S of model.top) {
    const ops = [];
    try { drawShape(S, info.P, ops); } catch (e) { console.warn("Visio: forma non disegnata", S.id, e); }
    items.push({ S, ops, box: opsBox(ops) });
  }
  return { info, items, back };
}
export function opsBox(ops) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (x, y) => { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; };
  for (const o of ops) {
    if (o.t === "path") for (const c of o.d) { for (let i = 1; i + 1 < c.length; i += 2) add(c[i], c[i + 1]); }
    else if (o.t === "text") { add(o.p[0], o.p[1] - o.size); add(o.p[0] + o.size * o.str.length * 0.5 * o.m[0], o.p[1] + o.size * 0.3 + o.size * o.str.length * 0.5 * o.m[1]); }
    else if (o.t === "image") { const m = o.m; for (const [u, v] of [[0, 0], [o.w, 0], [o.w, o.h], [0, o.h]]) add(m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]); }
  }
  return b;
}

// ------------------------------------------------------------------ SVG
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const f2 = v => (Math.round(v * 100) / 100).toString();
export const pathD = d => d.map(c => c[0] === "Z" ? "Z" : c[0] + c.slice(1).map(f2).join(" ")).join("");
let gid = 0;
export function opsSvg(ops, imageUrl, defs) {
  let s = "";
  for (const o of ops) {
    if (o.t === "path") {
      let fill = "none";
      if (o.fill) {
        fill = o.fill;
        if (o.grad && defs) {
          const id = "vg" + (++gid);
          const st = o.grad.stops.map(([p, c, op]) => `<stop offset="${f2(p * (p > 1 ? 1 : 100))}%" stop-color="${c}" stop-opacity="${f2(op ?? 1)}"/>`).join("");
          if (o.grad.radial) defs.push(`<radialGradient id="${id}">${st}</radialGradient>`);
          else { const a = o.grad.angle, x = Math.cos(a) / 2, y = Math.sin(a) / 2; defs.push(`<linearGradient id="${id}" x1="${f2(0.5 - x)}" y1="${f2(0.5 + y)}" x2="${f2(0.5 + x)}" y2="${f2(0.5 - y)}">${st}</linearGradient>`); }
          fill = `url(#${id})`;
        }
      }
      const at = [`d="${pathD(o.d)}"`, `fill="${fill}"`];
      if (o.fill && o.evenodd) at.push(`fill-rule="evenodd"`);
      if (o.stroke) {
        at.push(`stroke="${o.stroke}"`, `stroke-width="${f2(o.sw)}"`, `stroke-linecap="${o.cap || "round"}"`, `stroke-linejoin="${o.join || "miter"}"`, `stroke-miterlimit="4"`);
        if (o.dash) at.push(`stroke-dasharray="${o.dash.map(f2).join(" ")}"`);
      }
      if (o.op != null && o.op < 1) at.push(`opacity="${f2(o.op)}"`);
      s += `<path ${at.join(" ")}/>`;
    } else if (o.t === "text") {
      const m = o.m;
      s += `<text transform="matrix(${[m[0], m[1], m[2], m[3], o.p[0], o.p[1]].map(v => (Math.round(v * 1000) / 1000)).join(" ")})" font-family="${esc(o.font)}, Segoe UI, Arial, sans-serif" font-size="${f2(o.size)}"${o.b ? ' font-weight="bold"' : ""}${o.i ? ' font-style="italic"' : ""} fill="${o.fill}"${o.op != null && o.op < 1 ? ` opacity="${f2(o.op)}"` : ""} xml:space="preserve">${esc(o.str)}</text>`;
    } else if (o.t === "image") {
      const url = imageUrl?.(o.key);
      const m = o.m;
      if (url) s += `<image href="${esc(url)}" x="0" y="0" width="${f2(o.w)}" height="${f2(o.h)}" preserveAspectRatio="none" transform="matrix(${m.map(v => Math.round(v * 1000) / 1000).join(" ")})"/>`;
      else s += `<g transform="matrix(${m.map(v => Math.round(v * 1000) / 1000).join(" ")})"><rect width="${f2(o.w)}" height="${f2(o.h)}" fill="#eef1f4" stroke="#b5bcc4" stroke-width="0.5"/><path d="M0 0L${f2(o.w)} ${f2(o.h)}M${f2(o.w)} 0L0 ${f2(o.h)}" stroke="#c8ced5" stroke-width="0.5"/></g>`;
    }
  }
  return s;
}
// SVG completo di una pagina (esportazione)
export function pageSvg(R, imageUrl, opts = {}) {
  const defs = [];
  let body = opsSvg(R.back, imageUrl, defs);
  for (const it of R.items) body += `<g>${opsSvg(it.ops, imageUrl, defs)}</g>`;
  const { wPt, hPt } = R.info;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${f2(wPt)}pt" height="${f2(hPt)}pt" viewBox="0 0 ${f2(wPt)} ${f2(hPt)}">${opts.title ? `<title>${esc(opts.title)}</title>` : ""}${defs.length ? `<defs>${defs.join("")}</defs>` : ""}${opts.white !== false ? `<rect width="100%" height="100%" fill="#ffffff"/>` : ""}${body}</svg>`;
}
