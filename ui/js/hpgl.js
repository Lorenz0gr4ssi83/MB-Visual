// Interprete HP-GL / HP-GL/2 (file .plt dei plotter): da comandi a primitive vettoriali in millimetri.
// Scritto da zero sulla documentazione pubblica dei comandi (HP-GL/2 Reference Guide); niente codice di terzi.
// Unita': 1 unita' plotter = 0,025 mm. Asse y verso l'alto.

const UNIT = 0.025; // mm per unita' plotter
export const DEFAULT_PENS = ["#ffffff", "#000000", "#e0201b", "#14a02a", "#d6b400", "#1c48d8", "#c020c0", "#00a8c0"];

export function parseHpgl(bytes) {
  let s = cleanup(bytes);
  const prims = [];   // {t:"l", pen, w, dash, pts:[x,y,...]} | {t:"f", pen, rings:[[...]]} | {t:"txt", ...}
  const st = {
    pen: 1, abs: true, down: false, x: 0, y: 0, w: {}, wRel: false, dash: null, pens: {}, crMin: [0, 0, 0], crMax: [255, 255, 255],
    sc: null, ip: null, rot: 0, size: null, slant: 0, dir: [1, 0], lo: 1, term: "\x03", poly: null, polys: null, ps: null, cur: null,
  };
  const pensUsed = new Set();
  let i = 0;
  const n = s.length;
  const isLetter = c => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

  const toPlot = (x, y) => {
    // coordinate utente (SC) -> unita' plotter
    if (st.sc && st.ip) {
      const [p1x, p1y, p2x, p2y] = st.ip, [xmin, xmax, ymin, ymax, type] = st.sc;
      if (type === 2) return [p1x + (x - xmin) * xmax, p1y + (y - ymin) * ymax]; // fattori di scala
      return [p1x + (x - xmin) * (p2x - p1x) / ((xmax - xmin) || 1), p1y + (y - ymin) * (p2y - p1y) / ((ymax - ymin) || 1)];
    }
    return [x, y];
  };
  const width = () => st.w[st.pen] ?? st.w.all ?? 0.35; // mm (WU1 = relativo: trattato come mm)
  const flushLine = () => {
    if (st.cur && st.cur.pts.length >= 4) prims.push(st.cur);
    st.cur = null;
  };
  const lineTo = (x, y) => {
    if (st.poly) { st.poly.cur.push(x, y); st.x = x; st.y = y; return; }
    if (st.pen > 0) {
      if (!st.cur || st.cur.pen !== st.pen) { flushLine(); st.cur = { t: "l", pen: st.pen, w: width(), dash: st.dash, pts: [st.x, st.y] }; }
      st.cur.pts.push(x, y);
      pensUsed.add(st.pen);
    }
    st.x = x; st.y = y;
  };
  const moveTo = (x, y) => {
    if (st.poly) { if (st.poly.cur.length > 2) st.poly.rings.push(st.poly.cur); st.poly.cur = [x, y]; st.x = x; st.y = y; return; }
    flushLine();
    st.x = x; st.y = y;
  };
  const go = (x, y) => (st.down ? lineTo(x, y) : moveTo(x, y));
  const arcPts = (cx, cy, r, a0, sweep, chord = 5) => {
    const steps = Math.max(8, Math.ceil(Math.abs(sweep) / Math.max(0.5, Math.min(chord, 10))));
    const out = [];
    for (let k = 1; k <= steps; k++) { const a = (a0 + sweep * k / steps) * Math.PI / 180; out.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
    return out;
  };

  const readNums = () => {
    const out = [];
    for (;;) {
      while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 44 || s.charCodeAt(i) === 10 || s.charCodeAt(i) === 13 || s.charCodeAt(i) === 9)) i++;
      const m = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i, i + 40));
      if (!m) break;
      out.push(parseFloat(m[0]));
      i += m[0].length;
    }
    return out;
  };
  const endCmd = () => { while (i < n && /[\s,]/.test(s[i])) i++; if (s[i] === ";") i++; };

  while (i < n) {
    const c = s.charCodeAt(i);
    if (!isLetter(c) || i + 1 >= n || !isLetter(s.charCodeAt(i + 1))) { i++; continue; }
    const cmd = s.substr(i, 2).toUpperCase();
    i += 2;
    if (cmd === "LB") { // testo fino al terminatore
      const j = s.indexOf(st.term, i);
      const text = s.slice(i, j < 0 ? n : j);
      i = j < 0 ? n : j + st.term.length;
      addLabel(text);
      continue;
    }
    if (cmd === "PE") { pe(); continue; }
    if (cmd === "DT") { const t = s[i]; if (t && t !== ";") { st.term = t; i++; } else st.term = "\x03"; endCmd(); continue; }
    if (cmd === "CO") { const j = s.indexOf('"', s.indexOf('"', i) + 1); i = j < 0 ? n : j + 1; endCmd(); continue; }
    if (cmd === "SD" || cmd === "AD" || cmd === "BP" || cmd === "MG" || cmd === "BR" || cmd === "TD") { const j = s.indexOf(";", i); i = j < 0 ? n : j + 1; continue; }
    const a = readNums();
    endCmd();
    switch (cmd) {
      case "IN": case "DF":
        flushLine();
        Object.assign(st, { abs: true, down: false, dash: null, sc: null, rot: 0, slant: 0, dir: [1, 0], lo: 1, term: "\x03", poly: null, size: null });
        if (cmd === "IN") { st.pen = 1; st.w = {}; st.pens = {}; }
        break;
      case "SP": flushLine(); st.pen = a.length ? Math.round(a[0]) : 0; break;
      case "PA": st.abs = true; plot(a); break;
      case "PR": st.abs = false; plot(a); break;
      case "PU": st.down = false; plot(a); break;
      case "PD": st.down = true; plot(a); break;
      case "PS": if (a.length) st.ps = [a[0], a[1] ?? a[0]]; break;
      case "IP": st.ip = a.length >= 4 ? a.slice(0, 4) : a.length === 2 ? [a[0], a[1], a[0] + 10000, a[1] + 7500] : null; break;
      case "SC": st.sc = a.length >= 4 ? [a[0], a[1], a[2], a[3], a[4] ?? 0] : null; if (st.sc && !st.ip) st.ip = [0, 0, 10000, 7500]; break;
      case "RO": st.rot = a[0] || 0; break;
      case "LT": st.dash = a.length && a[0] !== 0 ? [a[0], a[1] ?? 4] : a.length && a[0] === 0 ? [0, 0.5] : null; flushLine(); break;
      case "PW": { flushLine(); const w = a.length ? a[0] : 0.35; if (a.length > 1) st.w[Math.round(a[1])] = w; else { st.w = { all: w }; } break; }
      case "WU": st.wRel = a[0] === 1; break;
      case "NP": break;
      case "CR": if (a.length >= 6) { st.crMin = [a[0], a[2], a[4]]; st.crMax = [a[1], a[3], a[5]]; } break;
      case "PC": if (a.length >= 4) {
        const ch = k => Math.round(255 * Math.max(0, Math.min(1, (a[k + 1] - st.crMin[k]) / ((st.crMax[k] - st.crMin[k]) || 255))));
        st.pens[Math.round(a[0])] = "#" + [0, 1, 2].map(k => ch(k).toString(16).padStart(2, "0")).join("");
      } break;
      case "CI": {
        const [px, py] = [st.x, st.y], r = toPlotLen(a[0] || 0);
        const pts = [px + r, py, ...arcPts(px, py, r, 0, 360, a[1] || 5)];
        if (st.poly) { st.poly.rings.push(pts); break; }
        if (st.pen > 0) { flushLine(); prims.push({ t: "l", pen: st.pen, w: width(), dash: st.dash, pts }); pensUsed.add(st.pen); }
        break;
      }
      case "AA": case "AR": {
        if (a.length < 3) break;
        let [cx, cy] = cmd === "AA" ? toPlot(a[0], a[1]) : [st.x + a[0], st.y + a[1]];
        const r = Math.hypot(st.x - cx, st.y - cy), a0 = Math.atan2(st.y - cy, st.x - cx) * 180 / Math.PI;
        const pts = arcPts(cx, cy, r, a0, a[2], a[3] || 5);
        for (let k = 0; k < pts.length; k += 2) (st.down ? lineTo : moveTo)(pts[k], pts[k + 1]);
        break;
      }
      case "AT": case "RT": { // arco per tre punti: approssimato con due segmenti di cerchio passante
        if (a.length < 4) break;
        const p1 = [st.x, st.y], p2 = cmd === "AT" ? toPlot(a[0], a[1]) : [st.x + a[0], st.y + a[1]], p3 = cmd === "AT" ? toPlot(a[2], a[3]) : [st.x + a[2], st.y + a[3]];
        const pts = threePointArc(p1, p2, p3);
        for (let k = 0; k < pts.length; k += 2) (st.down ? lineTo : moveTo)(pts[k], pts[k + 1]);
        break;
      }
      case "EA": case "ER": case "RA": case "RR": {
        if (a.length < 2) break;
        const [x2, y2] = cmd === "EA" || cmd === "RA" ? toPlot(a[0], a[1]) : [st.x + a[0], st.y + a[1]];
        const ring = [st.x, st.y, x2, st.y, x2, y2, st.x, y2, st.x, st.y];
        if (st.pen > 0) {
          flushLine();
          if (cmd[0] === "R") prims.push({ t: "f", pen: st.pen, rings: [ring] });
          else prims.push({ t: "l", pen: st.pen, w: width(), dash: st.dash, pts: ring });
          pensUsed.add(st.pen);
        }
        break;
      }
      case "WG": case "EW": {
        if (a.length < 3) break;
        const r = toPlotLen(a[0]);
        const ring = [st.x, st.y, st.x + r * Math.cos(a[1] * Math.PI / 180), st.y + r * Math.sin(a[1] * Math.PI / 180), ...arcPts(st.x, st.y, r, a[1], a[2], a[3] || 5), st.x, st.y];
        if (st.pen > 0) { flushLine(); prims.push(cmd === "WG" ? { t: "f", pen: st.pen, rings: [ring] } : { t: "l", pen: st.pen, w: width(), dash: st.dash, pts: ring }); pensUsed.add(st.pen); }
        break;
      }
      case "PM": {
        const m = a[0] || 0;
        if (m === 0) { flushLine(); st.poly = { rings: [], cur: [st.x, st.y] }; }
        else if (st.poly) { if (st.poly.cur.length > 2) st.poly.rings.push(st.poly.cur); st.poly.cur = [st.x, st.y]; if (m === 2) { st.polys = st.poly.rings; st.poly = null; } }
        break;
      }
      case "FP": if (st.polys?.length && st.pen > 0) { prims.push({ t: "f", pen: st.pen, rings: st.polys }); pensUsed.add(st.pen); } break;
      case "EP": if (st.polys?.length && st.pen > 0) { for (const r of st.polys) prims.push({ t: "l", pen: st.pen, w: width(), dash: st.dash, pts: [...r, r[0], r[1]] }); pensUsed.add(st.pen); } break;
      case "SI": if (a.length >= 2) st.size = [a[0] * 400, a[1] * 400]; else st.size = null; break;   // cm -> unita'
      case "SR": st.size = a.length >= 2 ? [a[0] / 100 * psW() , a[1] / 100 * psH()] : null; break;
      case "SL": st.slant = a[0] || 0; break;
      case "DI": st.dir = a.length >= 2 ? [a[0], a[1]] : [1, 0]; break;
      case "DR": st.dir = a.length >= 2 ? [a[0] * psW(), a[1] * psH()] : [1, 0]; break;
      case "LO": st.lo = a[0] || 1; break;
      default: break;
    }
  }
  flushLine();

  function psW() { return st.ps ? st.ps[0] : (st.ip ? st.ip[2] - st.ip[0] : 10000); }
  function psH() { return st.ps ? st.ps[1] : (st.ip ? st.ip[3] - st.ip[1] : 7500); }
  function toPlotLen(r) {
    if (st.sc && st.ip) { const [p1x, , p2x] = st.ip, [xmin, xmax, , , type] = st.sc; return type === 2 ? r * xmax : r * (p2x - p1x) / ((xmax - xmin) || 1); }
    return r;
  }
  function plot(a) {
    for (let k = 0; k + 1 < a.length; k += 2) {
      const [x, y] = st.abs ? toPlot(a[k], a[k + 1]) : (st.sc && st.ip ? (() => { const [ox, oy] = toPlot(0, 0); const [ux, uy] = toPlot(a[k], a[k + 1]); return [st.x + ux - ox, st.y + uy - oy]; })() : [st.x + a[k], st.y + a[k + 1]]);
      go(x, y);
    }
  }
  function addLabel(text) {
    flushLine();
    const size = st.size || [0.19 * 400, 0.27 * 400];
    const lines = text.split(/\r?\n|\r/);
    const ang = Math.atan2(st.dir[1], st.dir[0]);
    for (let k = 0; k < lines.length; k++) {
      const t = lines[k].replace(/[\x00-\x1f]/g, "");
      if (t && st.pen > 0) { prims.push({ t: "txt", pen: st.pen, x: st.x + Math.sin(ang) * k * size[1] * 1.6, y: st.y - Math.cos(ang) * k * size[1] * 1.6, text: t, h: size[1], cw: size[0], ang, lo: st.lo, slant: st.slant }); pensUsed.add(st.pen); }
    }
    // la penna avanza alla fine del testo (come sul plotter)
    const last = lines[lines.length - 1] || "";
    st.x += Math.cos(ang) * last.length * size[0] * 1.5;
    st.y += Math.sin(ang) * last.length * size[0] * 1.5;
  }
  // PE: polilinea codificata (HP-GL/2), numeri in base 64 (8 bit) o base 32 (7 bit), relativi salvo "="
  function pe() {
    let base = 64, frac = 0, up = false, absNext = false;
    flushLine();
    const num = () => {
      let v = 0, mult = 1;
      while (i < n) {
        const ch = s.charCodeAt(i);
        if (base === 64) {
          if (ch >= 63 && ch <= 126) { v += (ch - 63) * mult; mult *= 64; i++; continue; }
          if (ch >= 191 && ch <= 254) { v += (ch - 191) * mult; i++; break; }
        } else {
          if (ch >= 63 && ch <= 94) { v += (ch - 63) * mult; mult *= 32; i++; continue; }
          if (ch >= 95 && ch <= 126) { v += (ch - 95) * mult; i++; break; }
        }
        return null;
      }
      return (v & 1 ? -(v - 1) / 2 : v / 2);
    };
    while (i < n && s[i] !== ";") {
      const ch = s[i];
      if (ch === "7") { base = 32; i++; continue; }
      if (ch === ":") { i++; const p = num(); if (p !== null) { st.pen = p; } continue; }
      if (ch === ">") { i++; frac = num() || 0; continue; }
      if (ch === "<") { i++; up = true; continue; }
      if (ch === "=") { i++; absNext = true; continue; }
      if (/\s/.test(ch)) { i++; continue; }
      const x = num();
      if (x === null) { i++; continue; }
      const y = num();
      if (y === null) break;
      const f = 2 ** frac;
      let px = x / f, py = y / f;
      if (absNext) { [px, py] = toPlot(px, py); } else { px += st.x; py += st.y; }
      if (up) moveTo(px, py); else lineTo(px, py);
      st.down = !up;
      up = false; absNext = false;
    }
    if (s[i] === ";") i++;
  }

  // rotazione RO (90/180/270): applicata a tutto il disegno attorno all'origine
  if (st.rot) rotateAll(prims, st.rot);
  return { prims, bbox: bboxOf(prims), pens: [...pensUsed].sort((a, b) => a - b), penColors: st.pens, unit: UNIT, raster: /\x1b\*r|\x1b\*b/.test(s) && !prims.length };
}

function threePointArc(p1, p2, p3) {
  const ax = p1[0], ay = p1[1], bx = p2[0], by = p2[1], cx = p3[0], cy = p3[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return [bx, by, cx, cy];
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const a1 = Math.atan2(ay - uy, ax - ux), a2 = Math.atan2(by - uy, bx - ux), a3 = Math.atan2(cy - uy, cx - ux);
  const norm = a => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let sweep = norm(a3 - a1);
  if (norm(a2 - a1) > sweep) sweep -= 2 * Math.PI; // il punto intermedio decide il verso
  const steps = Math.max(8, Math.ceil(Math.abs(sweep) * 180 / Math.PI / 5));
  const out = [];
  for (let k = 1; k <= steps; k++) { const a = a1 + sweep * k / steps; out.push(ux + r * Math.cos(a), uy + r * Math.sin(a)); }
  return out;
}

function rotateAll(prims, deg) {
  const r = deg * Math.PI / 180, c = Math.round(Math.cos(r)), s = Math.round(Math.sin(r));
  const f = (x, y) => [x * c - y * s, x * s + y * c];
  for (const p of prims) {
    if (p.t === "l") for (let k = 0; k < p.pts.length; k += 2) [p.pts[k], p.pts[k + 1]] = f(p.pts[k], p.pts[k + 1]);
    else if (p.t === "f") for (const ring of p.rings) for (let k = 0; k < ring.length; k += 2) [ring[k], ring[k + 1]] = f(ring[k], ring[k + 1]);
    else { [p.x, p.y] = f(p.x, p.y); p.ang += r; }
  }
}

export function bboxOf(prims) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const ext = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  for (const p of prims) {
    if (p.t === "l") for (let k = 0; k < p.pts.length; k += 2) ext(p.pts[k], p.pts[k + 1]);
    else if (p.t === "f") for (const r of p.rings) for (let k = 0; k < r.length; k += 2) ext(r[k], r[k + 1]);
    else { ext(p.x, p.y); ext(p.x + Math.cos(p.ang) * p.text.length * p.cw * 1.5 - Math.sin(p.ang) * p.h, p.y + Math.sin(p.ang) * p.text.length * p.cw * 1.5 + Math.cos(p.ang) * p.h); }
  }
  return isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 1, 1];
}

// toglie PJL, PCL (ESC ...) e i caratteri non stampabili che non servono
function cleanup(bytes) {
  let s = "";
  const CH = 0x8000;
  for (let k = 0; k < bytes.length; k += CH) s += String.fromCharCode.apply(null, bytes.subarray(k, k + CH));
  s = s.replace(/@PJL[^\n]*\n/g, "");
  s = s.replace(/\x1b%-12345X/g, "");
  s = s.replace(/\x1b[%&(*)][\d.+-]*[A-Za-z@]/g, "");
  s = s.replace(/\x1b[A-Za-z=]/g, "");
  return s;
}

// ---------------------------------------------------------------- SVG
export function toSvg(model, colors, visible, opts = {}) {
  const [x0, y0, x1, y1] = model.bbox;
  const m = 5 / UNIT; // margine di 5 mm
  const W = (x1 - x0 + 2 * m) * UNIT, H = (y1 - y0 + 2 * m) * UNIT;
  const X = x => ((x - x0 + m) * UNIT).toFixed(3), Y = y => ((y1 - y + m) * UNIT).toFixed(3);
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(2)}mm" height="${H.toFixed(2)}mm" viewBox="0 0 ${W.toFixed(3)} ${H.toFixed(3)}">`];
  if (opts.background) out.push(`<rect x="0" y="0" width="${W.toFixed(3)}" height="${H.toFixed(3)}" fill="${opts.background}"/>`);
  for (const p of model.prims) {
    if (!visible(p.pen)) continue;
    const col = colors(p.pen);
    if (p.t === "l") {
      let d = "";
      for (let k = 0; k < p.pts.length; k += 2) d += (k ? "L" : "M") + X(p.pts[k]) + " " + Y(p.pts[k + 1]);
      const dash = p.dash && p.dash[0] ? ` stroke-dasharray="${(p.dash[1] * 0.6).toFixed(2)} ${(p.dash[1] * 0.4).toFixed(2)}"` : "";
      out.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="${Math.max(0.05, p.w).toFixed(3)}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`);
    } else if (p.t === "f") {
      let d = "";
      for (const r of p.rings) { for (let k = 0; k < r.length; k += 2) d += (k ? "L" : "M") + X(r[k]) + " " + Y(r[k + 1]); d += "Z"; }
      out.push(`<path d="${d}" fill="${col}" fill-rule="evenodd" stroke="none"/>`);
    } else {
      const deg = -p.ang * 180 / Math.PI;
      const fs = (p.h * UNIT * 1.35).toFixed(3);
      const anchor = [1, 2, 3, 11, 12, 13].includes(p.lo) ? "start" : [4, 5, 6, 14, 15, 16].includes(p.lo) ? "middle" : "end";
      out.push(`<text x="${X(p.x)}" y="${Y(p.y)}" font-family="Arial, Helvetica, sans-serif" font-size="${fs}" fill="${col}" text-anchor="${anchor}"${deg ? ` transform="rotate(${deg.toFixed(2)} ${X(p.x)} ${Y(p.y)})"` : ""}>${p.text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>`);
    }
  }
  out.push("</svg>");
  return out.join("\n");
}
