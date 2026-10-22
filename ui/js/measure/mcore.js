// Misure ed estrazioni di quantita': nucleo comune a PDF, disegni CAD e modelli 3D (nessun DOM: lo usa anche il collaudo
// tests/test_measure.mjs con Node).
//
// Documento delle misure (file .mbmis accanto ai CAD e ai modelli 3D; nei PDF allegato "misure.mbmis" + annotazioni):
//   { format: "mbmis", version: 1, file, disp: { unit, digits }, scales: [scala], items: [misura], voci: { nome: { color, price } },
//     ref: { y, value } quota di riferimento per le quote di livello (unita' reali) }
// Scala = { id, page (null = tutto il documento), box [x0,y0,x1,y1] in unita' del disegno (null = intera pagina),
//   k = unita' reali per unita' del disegno, unit = unita' reale ("m", "mm"...), label ("1:100", "Tarata") }
//   PDF: unita' del disegno = punto tipografico (1/72"); CAD e 3D: unita' del file (k = 1, unit dal file).
// Misura = { id, type, page, pts [[x,y(,z)]...] in unita' del disegno, holes [[...]], h altezza (unita' reali), name, voce,
//   layer, color "#rrggbb", note, price (per unita' di quantita' nelle unita' mostrate), symbol (conteggi), q quantita' fisse
//   gia' in unita' reali { len, area, vol, count } (oggetti 3D, righe estratte), kind = quantita' principale delle righe fisse }
//
// Tipi: len lunghezza, pline polilinea, perim perimetro, area, vol volume (area x altezza), ang angolo, rad raggio,
// elev quota di livello, count conteggio, obj oggetto (quantita' fisse), ext riga estratta.

export const TYPES = ["len", "pline", "perim", "area", "vol", "ang", "rad", "elev", "count", "obj", "ext"];
export const MAIN = { len: "len", pline: "len", perim: "len", area: "area", vol: "vol", ang: "ang", rad: "len", elev: "elev", count: "count" };
export const PALETTE = ["#e8590c", "#1971c2", "#2f9e44", "#c2255c", "#7048e8", "#0c8599", "#e67700", "#5f3dc4", "#d6336c", "#495057"];

// metri per unita'
export const UNITS = { mm: 0.001, cm: 0.01, dm: 0.1, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344 };
export const PT = 0.0254 / 72; // metri per punto tipografico
// $INSUNITS di AutoCAD -> unita'
export const INSUNITS = { 1: "in", 2: "ft", 3: "mi", 4: "mm", 5: "cm", 6: "m", 7: "km", 10: "yd", 14: "dm" };

export const conv = (v, from, to, pow = 1) => (v == null ? v : v * Math.pow((UNITS[from] || 1) / (UNITS[to] || 1), pow));
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// ---------------------------------------------------------------- geometria piana
export const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], (b[2] || 0) - (a[2] || 0));
export function polyLen(P, closed = false) {
  let s = 0;
  for (let i = 1; i < P.length; i++) s += dist(P[i - 1], P[i]);
  if (closed && P.length > 2) s += dist(P[P.length - 1], P[0]);
  return s;
}
// area con segno (formula di Gauss), punti 2D
export function signedArea(P) {
  let s = 0;
  for (let i = 0, n = P.length; i < n; i++) { const a = P[i], b = P[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
}
// area di un poligono 3D (normale di Newell); per punti 2D coincide con |signedArea|
export function polyArea(P) {
  if (P.length < 3) return 0;
  if (P.every(p => p.length < 3 || !p[2])) return Math.abs(signedArea(P));
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0, n = P.length; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n];
    nx += (a[1] - b[1]) * ((a[2] || 0) + (b[2] || 0));
    ny += ((a[2] || 0) - (b[2] || 0)) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return Math.hypot(nx, ny, nz) / 2;
}
export function pointInPoly(x, y, P) {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, yi] = P[i], [xj, yj] = P[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-300) + xi) inside = !inside;
  }
  return inside;
}
// area di una regione fatta di piu' contorni (retini, sezioni): un contorno dentro un numero dispari di altri e' un foro
export function regionArea(loops) {
  const L = loops.filter(P => P.length >= 3);
  let s = 0;
  for (let i = 0; i < L.length; i++) {
    const [x, y] = L[i][0];
    let depth = 0;
    for (let j = 0; j < L.length; j++) if (j !== i && Math.abs(signedArea(L[j])) > Math.abs(signedArea(L[i])) * 0.999999 && pointInPoly(x, y, L[j])) depth++;
    s += (depth % 2 ? -1 : 1) * Math.abs(signedArea(L[i]));
  }
  return Math.max(0, s);
}
// angolo in gradi in B tra BA e BC (0-180)
export function angleAt(A, B, C) {
  const u = [A[0] - B[0], A[1] - B[1], (A[2] || 0) - (B[2] || 0)], v = [C[0] - B[0], C[1] - B[1], (C[2] || 0) - (B[2] || 0)];
  const d = Math.hypot(...u) * Math.hypot(...v);
  if (!d) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / d))) * 180) / Math.PI;
}
// cerchio per tre punti (piano XY)
export function circle3(A, B, C) {
  const ax = A[0], ay = A[1], bx = B[0], by = B[1], cx = C[0], cy = C[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d, uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { cx: ux, cy: uy, r: Math.hypot(ax - ux, ay - uy) };
}
// cerchio per tre punti nello spazio: centro = C + (|a|^2 b - |b|^2 a) x (a x b) / (2 |a x b|^2), con a = A-C, b = B-C
export function circle3d(A, B, C) {
  const sub = (p, q) => [p[0] - q[0], p[1] - q[1], (p[2] || 0) - (q[2] || 0)];
  const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const a = sub(A, C), b = sub(B, C), axb = cross(a, b), n2 = dot(axb, axb);
  if (n2 < 1e-24) return null;
  const w = [0, 1, 2].map(i => dot(a, a) * b[i] - dot(b, b) * a[i]);
  const m = cross(w, axb);
  const ctr = [C[0] + m[0] / (2 * n2), C[1] + m[1] / (2 * n2), (C[2] || 0) + m[2] / (2 * n2)];
  return { c: ctr, r: dist(ctr, A) };
}

// ---------------------------------------------------------------- scale
// scala di una pagina dichiarata come 1:N (PDF in punti, risultato nell'unita' scelta)
// paperM = metri per unita' del disegno sulla carta (PDF: punto tipografico; DWF: unita' della carta; CAD: unita' del file)
export const ratioScale = (N, unit = "m", paperM = PT) => ({ k: (N * paperM) / (UNITS[unit] || 1), unit, label: "1:" + fmtRatio(N) });
const fmtRatio = N => (Math.abs(N - Math.round(N)) < 1e-6 ? String(Math.round(N)) : String(+N.toFixed(3)));
// taratura: due punti (unita' del disegno) e la lunghezza vera (unita' reali)
export function calibrate(a, b, real, unit, paperM = PT) {
  const d = dist(a, b);
  if (!(d > 0) || !(real > 0)) return null;
  const k = real / d;
  // rapporto di scala equivalente sulla carta (solo PDF): 1:N
  const N = (k * (UNITS[unit] || 1)) / paperM;
  return { k, unit, label: "1:" + fmtRatio(Math.round(N * 100) / 100), calibrated: true };
}
// scala da usare per una misura: riquadro (viewport) che contiene il primo punto, poi la pagina, poi il documento
export function scaleFor(doc, page, pt) {
  const S = doc.scales || [];
  if (pt) for (const s of S) if (s.box && (s.page ?? null) === (page ?? null) && pt[0] >= s.box[0] && pt[0] <= s.box[2] && pt[1] >= s.box[1] && pt[1] <= s.box[3]) return s;
  return S.find(s => !s.box && s.page != null && s.page === page) || S.find(s => !s.box && s.page == null) || doc.base || { k: 1, unit: "m", label: "", none: true };
}

// lettura della scala dai testi (cartiglio): "Scala 1:100", "SCALE 1/50", "Maßstab 1:200", "Échelle 1:20"...
const SCALE_WORDS = /(scala|scale|ma(?:ß|ss)stab|[ée]chelle|escala|sc\.)/i;
export function parseScales(text) {
  const out = [];
  const re = /(?:^|[^\d.,])1\s*[:/]\s*(\d{1,6}(?:[.,]\d+)?)(?![\d])/g;
  let m;
  while ((m = re.exec(text))) {
    const N = parseFloat(m[1].replace(",", "."));
    if (!(N >= 1 && N <= 100000)) continue;
    const before = text.slice(Math.max(0, m.index - 24), m.index + 1);
    out.push({ N, strong: SCALE_WORDS.test(before) });
  }
  return out;
}

// ---------------------------------------------------------------- quantita'
// quantita' di una misura nelle unita' reali della sua scala: { len, area, vol, count, ang, rad, elev, unit, main, value }
export function compute(m, doc) {
  if (m.q) {
    const u = m.unit || doc.base?.unit || "m";
    const main = m.kind || (m.q.vol != null ? "vol" : m.q.area != null ? "area" : m.q.len != null ? "len" : "count");
    return { ...m.q, unit: u, main, value: m.q[main] };
  }
  const s = scaleFor(doc, m.page ?? null, m.pts?.[0]);
  const k = s.k, P = m.pts || [];
  const r = { unit: s.unit, scale: s, main: MAIN[m.type] };
  const holesA = () => (m.holes || []).reduce((a, H) => a + polyArea(H), 0) * k * k;
  switch (m.type) {
    case "len": case "pline": r.len = polyLen(P) * k; break;
    case "perim": r.len = polyLen(P, true) * k; r.area = Math.max(0, polyArea(P) * k * k - holesA()); break;
    case "area": r.area = Math.max(0, polyArea(P) * k * k - holesA()); r.len = polyLen(P, true) * k; break;
    case "vol": r.area = Math.max(0, polyArea(P) * k * k - holesA()); r.len = polyLen(P, true) * k; r.vol = r.area * (m.h || 0); break;
    case "ang": if (P.length >= 3) r.ang = angleAt(P[0], P[1], P[2]); break;
    case "rad": {
      const c = P.length >= 3 ? (P.some(p => p[2]) ? circle3d(P[0], P[1], P[2]) : circle3(P[0], P[1], P[2])) : null;
      if (c) { r.len = c.r * k; r.rad = r.len; r.diam = 2 * r.len; }
      break;
    }
    case "elev": if (P.length) r.elev = elevOf(P[0], doc, s); break;
    case "count": r.count = P.length; break;
    default: break;
  }
  r.value = r[r.main];
  return r;
}
// quota di livello: nel 2D la Y del disegno, nel 3D la Y della scena (verso l'alto), riferita a doc.ref
export function elevOf(p, doc, s) {
  const k = s?.k ?? 1;
  const y = doc.space === "3d" ? p[1] : p[1];
  const ref = doc.ref || { y: 0, value: 0 };
  return (y - (ref.y || 0)) * k + (ref.value || 0);
}

// unita' mostrata di ogni quantita'
export function dispUnit(kind, doc) {
  const u = doc.disp?.unit || doc.base?.unit || "m";
  return { len: u, rad: u, elev: u, area: u + "²", vol: u + "³", count: "", ang: "°" }[kind] ?? "";
}
// valore nelle unita' mostrate
export function toDisp(v, kind, fromUnit, doc) {
  if (v == null) return null;
  const u = doc.disp?.unit || fromUnit;
  if (kind === "area") return conv(v, fromUnit, u, 2);
  if (kind === "vol") return conv(v, fromUnit, u, 3);
  if (kind === "len" || kind === "rad" || kind === "elev") return conv(v, fromUnit, u, 1);
  return v;
}
// riga completa (unita' mostrate) per elenco, totali ed esportazioni
export function row(m, doc) {
  const c = compute(m, doc);
  const d = k => toDisp(c[k], k === "rad" ? "len" : k, c.unit, doc);
  const qty = c.main ? d(c.main) : null;
  const price = m.price ?? doc.voci?.[m.voce]?.price ?? null;
  const priced = price != null && price !== "" && qty != null && ["len", "area", "vol", "count"].includes(c.main);
  return { m, main: c.main, qty, len: d("len"), area: d("area"), vol: d("vol"), count: c.count ?? null, ang: c.ang ?? null, rad: d("rad"), diam: c.diam != null ? toDisp(c.diam, "len", c.unit, doc) : null,
    elev: d("elev"), unit: dispUnit(c.main, doc), price: price === "" ? null : price, amount: priced ? qty * +price : null, scale: c.scale };
}

// ---------------------------------------------------------------- raggruppamento e totali
const KEYS = { type: m => m.type, voce: m => m.voce || "", layer: m => m.layer || "", page: m => (m.page == null ? "" : String(m.page + 1)), color: m => m.color || "" };
export const sumKinds = ["len", "area", "vol", "count", "amount"];
export function groupRows(rows, keys) {
  const root = { label: "", rows: [], children: [] };
  // ogni quantita' si somma solo dalle misure che la hanno come principale (i perimetri delle aree non sono lunghezze)
  const add = (node, r) => {
    node.rows.push(r);
    node.n ||= {};
    for (const k of sumKinds) {
      const v = k === "amount" ? r.amount : r.main === k ? r.qty : null;
      if (v == null) continue;
      node[k] = (node[k] || 0) + v;
      node.n[k] = true;
    }
  };
  for (const r of rows) {
    add(root, r);
    let node = root;
    for (const k of keys) {
      const v = KEYS[k](r.m);
      let c = node.children.find(x => x.label === v && x.key === k);
      if (!c) node.children.push((c = { key: k, label: v, rows: [], children: [] }));
      add(c, r);
      node = c;
    }
  }
  return root;
}

// ---------------------------------------------------------------- documento .mbmis
export function newDoc(file, base) {
  return { format: "mbmis", version: 1, file: file || "", disp: { unit: base?.unit || "m", digits: 2 }, base: base || null, scales: [], items: [], voci: {}, ref: { y: 0, value: 0 } };
}
export function serialize(doc) {
  const out = { ...doc, saved: new Date().toISOString() };
  return JSON.stringify(out, (k, v) => (typeof v === "number" && isFinite(v) ? +v.toPrecision(12) : v), 1);
}
export function parse(text, file, base) {
  const d = typeof text === "string" ? JSON.parse(text) : text;
  if (!d || d.format !== "mbmis") throw new Error("not mbmis");
  const doc = { ...newDoc(file, base), ...d };
  if (base) doc.base = base;
  doc.items = (doc.items || []).filter(m => m && TYPES.includes(m.type));
  return doc;
}

// ---------------------------------------------------------------- esportazione CSV (";" e BOM, decimali con la virgola dove serve)
export function toCsv(rows, head, locale = "it-IT") {
  const dec = (1.5).toLocaleString(locale).includes(",") ? "," : ".";
  const cell = v => {
    if (v == null) return "";
    if (typeof v === "number") return String(Math.round(v * 1e6) / 1e6).replace(".", dec);
    const s = String(v);
    return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return "﻿" + [head, ...rows].map(r => r.map(cell).join(";")).join("\r\n");
}

// ---------------------------------------------------------------- mesh (3D)
// volume (teorema della divergenza, mesh chiuse) e superficie di una geometria indicizzata, con matrice 4x4 (colonne)
export function meshQuantities(pos, index, M) {
  const n = index ? index.length : pos.length / 3;
  const P = i => {
    const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
    if (!M) return [x, y, z];
    return [M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]];
  };
  let vol = 0, area = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t + 2 < n; t += 3) {
    const a = P(index ? index[t] : t), b = P(index ? index[t + 1] : t + 1), c = P(index ? index[t + 2] : t + 2);
    vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    for (const p of [a, b, c]) for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
  }
  return { vol: Math.abs(vol), signed: vol, area, min: lo, max: hi };
}
// faccia piana attorno a un triangolo: triangoli adiacenti (vertici condivisi entro eps) con la stessa normale
export function planarFace(pos, index, M, tri, angTol = 0.5) {
  const n = (index ? index.length : pos.length / 3) / 3;
  const P = i => { const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2]; return M ? [M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]] : [x, y, z]; };
  const V = t => [0, 1, 2].map(k => P(index ? index[3 * t + k] : 3 * t + k));
  const nrm = T => { const [a, b, c] = T, u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]; const x = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; const l = Math.hypot(...x) || 1; return [x[0] / l, x[1] / l, x[2] / l, l / 2]; };
  const t0 = V(tri), n0 = nrm(t0), d0 = n0[0] * t0[0][0] + n0[1] * t0[0][1] + n0[2] * t0[0][2];
  const cos = Math.cos((angTol * Math.PI) / 180);
  let ext = 0;
  for (const p of t0) ext = Math.max(ext, Math.abs(p[0]) + Math.abs(p[1]) + Math.abs(p[2]));
  const eps = Math.max(1e-9, ext * 1e-7);
  const key = p => `${Math.round(p[0] / eps / 100)},${Math.round(p[1] / eps / 100)},${Math.round(p[2] / eps / 100)}`;
  // candidati: triangoli complanari; poi si tengono quelli collegati al primo attraverso i vertici
  const cand = [];
  for (let t = 0; t < n; t++) {
    const T = V(t), nn = nrm(T);
    if (nn[3] <= 0) continue;
    if (nn[0] * n0[0] + nn[1] * n0[1] + nn[2] * n0[2] < cos) continue;
    if (Math.abs(nn[0] * T[0][0] + nn[1] * T[0][1] + nn[2] * T[0][2] - d0) > eps * 1000 + ext * 1e-5) continue;
    cand.push([t, T, nn[3]]);
  }
  const byV = new Map();
  cand.forEach((c, i) => c[1].forEach(p => { const k = key(p); if (!byV.has(k)) byV.set(k, []); byV.get(k).push(i); }));
  const start = cand.findIndex(c => c[0] === tri);
  if (start < 0) return { area: n0[3], tris: [tri], normal: n0.slice(0, 3), center: t0.reduce((a, p) => [a[0] + p[0] / 3, a[1] + p[1] / 3, a[2] + p[2] / 3], [0, 0, 0]) };
  const seen = new Set([start]), stack = [start];
  while (stack.length) { const i = stack.pop(); for (const p of cand[i][1]) for (const j of byV.get(key(p)) || []) if (!seen.has(j)) { seen.add(j); stack.push(j); } }
  let area = 0;
  const ctr = [0, 0, 0];
  for (const i of seen) { const [, T, a] = cand[i]; area += a; for (const p of T) for (let k = 0; k < 3; k++) ctr[k] += (p[k] * a) / 3; }
  return { area, tris: [...seen].map(i => cand[i][0]), normal: n0.slice(0, 3), center: ctr.map(v => v / (area || 1)) };
}
// sezione di una mesh con un piano (n, d: n.p + d = 0): segmenti nello spazio
export function sectionSegments(pos, index, M, plane, out = []) {
  const n = index ? index.length : pos.length / 3;
  const [nx, ny, nz] = plane.n, d = plane.d;
  const P = i => { const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2]; return M ? [M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]] : [x, y, z]; };
  for (let t = 0; t + 2 < n; t += 3) {
    const T = [P(index ? index[t] : t), P(index ? index[t + 1] : t + 1), P(index ? index[t + 2] : t + 2)];
    const s = T.map(p => nx * p[0] + ny * p[1] + nz * p[2] + d);
    const pts = [];
    for (let k = 0; k < 3; k++) {
      const a = T[k], b = T[(k + 1) % 3], sa = s[k], sb = s[(k + 1) % 3];
      if ((sa > 0) !== (sb > 0)) { const u = sa / (sa - sb); pts.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]); }
    }
    if (pts.length === 2) out.push(pts);
  }
  return out;
}
// segmenti 2D -> contorni chiusi (estremi uniti entro eps)
export function chainLoops(segs, eps) {
  const key = p => `${Math.round(p[0] / eps)},${Math.round(p[1] / eps)}`;
  const adj = new Map();
  segs.forEach((s, i) => s.forEach((p, e) => { const k = key(p); if (!adj.has(k)) adj.set(k, []); adj.get(k).push([i, e]); }));
  const used = new Uint8Array(segs.length), loops = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const loop = [segs[i][0], segs[i][1]];
    let cur = segs[i][1];
    for (let guard = 0; guard < segs.length; guard++) {
      const next = (adj.get(key(cur)) || []).find(([j]) => !used[j]);
      if (!next) break;
      const [j, e] = next;
      used[j] = 1;
      cur = segs[j][1 - e];
      loop.push(cur);
    }
    if (loop.length > 3 && dist(loop[0], loop[loop.length - 1]) <= eps * 2) { loop.pop(); loops.push(loop); }
  }
  return loops;
}
// area della sezione: segmenti 3D sul piano -> coordinate del piano -> contorni -> regione
export function sectionArea(segs3d, plane, eps) {
  const [nx, ny, nz] = plane.n;
  const ref = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let u = [ny * ref[2] - nz * ref[1], nz * ref[0] - nx * ref[2], nx * ref[1] - ny * ref[0]];
  const lu = Math.hypot(...u); u = u.map(v => v / lu);
  const v = [ny * u[2] - nz * u[1], nz * u[0] - nx * u[2], nx * u[1] - ny * u[0]];
  const to2 = p => [p[0] * u[0] + p[1] * u[1] + p[2] * u[2], p[0] * v[0] + p[1] * v[1] + p[2] * v[2]];
  const loops = chainLoops(segs3d.map(s => s.map(to2)), eps);
  return { area: regionArea(loops), loops, perimeter: loops.reduce((a, L) => a + polyLen(L, true), 0) };
}
// volume di una nuvola di punti sopra una quota di base (cumuli, scavi): griglia con la quota massima di ogni cella
// pts = Float32Array x,y,z (Y verso l'alto); restituisce { vol, area (impronta), cells }
export function gridVolume(pts, cell, baseY) {
  const top = new Map();
  for (let i = 0; i + 2 < pts.length; i += 3) {
    const k = Math.floor(pts[i] / cell) * 1048576 + Math.floor(pts[i + 2] / cell);
    const y = pts[i + 1];
    const v = top.get(k);
    if (v === undefined || y > v) top.set(k, y);
  }
  let vol = 0;
  for (const y of top.values()) vol += Math.max(0, y - baseY) * cell * cell;
  return { vol, area: top.size * cell * cell, cells: top.size };
}
// impronta (inviluppo convesso 2D, catena monotona)
export function hull2(points) {
  const P = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (P.length < 3) return P;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
