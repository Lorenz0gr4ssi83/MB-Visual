// Estrazioni automatiche di quantita' (nessun DOM: le usa anche tests/test_measure.mjs).
// Ogni estrazione restituisce { records: [{ g: {chiavi di raggruppamento}, page, at, len, area, count, color }], groups: [{k, label}] }
// con le quantita' in unita' del disegno (il pannello applica la scala di pagina/riquadro) oppure { table: { head, rows } }.
// - disegni CAD (modello di ui/js/viewers/cad2d.js build): lunghezze per layer/colore/tipo linea/tipo di entita',
//   aree delle polilinee chiuse e dei retini (con i fori), blocchi con lo stesso nome (anche annidati), testi e quote;
// - tracciati vettoriali (DWF, e PDF quando i dati arrivano dal motore): lunghezze e aree per stile e layer, simboli uguali.
import { polyLen, polyArea, regionArea, signedArea } from "./mcore.js";

const hex = c => (Array.isArray(c) ? "#" + c.slice(0, 3).map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("") : c || "");
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- CAD
export function cadLengths(model, db, { skipDims = true, skipHidden = null } = {}) {
  const agg = new Map();
  const top = i => db?.entities?.[i]?.type || "";
  for (const it of model.items) {
    if (it.t === "Q" || it.t === "N" || it.t === "F" || it.hatch) continue;
    const type = top(it.o);
    if (skipDims && type === "DIMENSION") continue;
    if (skipHidden && skipHidden(it)) continue;
    let len = 0, at;
    if (it.t === "L") { len = Math.hypot(it.x2 - it.x1, it.y2 - it.y1); at = [(it.x1 + it.x2) / 2, (it.y1 + it.y2) / 2]; }
    else if (it.t === "A") { len = Math.abs(it.r * it.sw); at = [it.cx, it.cy]; }
    else if (it.t === "P") { len = polyLen(it.pts); at = it.pts[0]; }
    if (!(len > 0)) continue;
    const c = hex(it.c), lt = it.lt || "continuous";
    const key = it.l + "|" + c + "|" + lt + "|" + type;
    let a = agg.get(key);
    if (!a) agg.set(key, (a = { g: { layer: it.l, color: c, lt, type }, at, len: 0, count: 0, color: c, ents: new Set() }));
    a.len += len;
    a.ents.add(it.o + "|" + it.s);
  }
  const records = [...agg.values()].map(a => ({ g: a.g, at: a.at, page: null, len: a.len, ents: a.ents.size, color: a.color }));
  return { records, groups: [{ k: "layer", label: "layer" }, { k: "color", label: "color" }, { k: "lt", label: "lt" }, { k: "type", label: "type" }] };
}

export function cadAreas(model, { skipHidden = null } = {}) {
  const records = [];
  for (const s of model.closed || []) {
    if (skipHidden && skipHidden(s)) continue;
    const area = polyArea(s.pts);
    if (!(area > 0)) continue;
    records.push({ g: { layer: s.l, color: hex(s.c), kind: s.kind, pattern: "" }, at: s.pts[0], page: null, area, len: polyLen(s.pts, true), ents: 1, color: hex(s.c), shape: s });
  }
  for (const h of model.hatches || []) {
    if (skipHidden && skipHidden(h)) continue;
    const area = regionArea(h.loops);
    if (!(area > 0)) continue;
    records.push({ g: { layer: h.l, color: hex(h.c), kind: "HATCH", pattern: h.pattern || "" }, at: h.loops[0][0], page: null, area, len: h.loops.reduce((s, L) => s + polyLen(L, true), 0), ents: 1, color: hex(h.c), shape: h });
  }
  return { records, groups: [{ k: "layer", label: "layer" }, { k: "kind", label: "kind" }, { k: "pattern", label: "pattern" }, { k: "color", label: "color" }] };
}

export function cadBlocks(model, db) {
  // esclusi i blocchi delle quote (frecce _ARCHTICK, _OPEN...) e quelli anonimi (*D, *U)
  const records = (model.inserts || []).filter(b => db?.entities?.[b.o]?.type !== "DIMENSION" && !/^\*/.test(b.name || "")).map(b => ({ g: { name: b.name, layer: b.l, nested: b.depth > 0 ? "nested" : "top" }, at: [b.x, b.y], page: null, count: 1, color: hex(b.c), ins: b }));
  return { records, groups: [{ k: "name", label: "name" }, { k: "layer", label: "layer" }] };
}

const QUOTE = /^[ØøR∅hH=:]*\s*[±+-]?\d{1,6}(?:[.,]\d{1,3})?\s*(?:m|cm|mm|m²|mq|m2|°)?$/;
const LEVEL = /^(?:[±+-]\s*\d{1,4}(?:[.,]\d{1,3})?|q\.?\s*[±+-]?\d)/i;
export const textKind = s => (LEVEL.test(s) && QUOTE.test(s.replace(/\s/g, "")) ? "livello" : QUOTE.test(s) ? "quota" : "testo");

// testi (TEXT, MTEXT, attributi) e quote (DIMENSION: valore misurato o testo sostituito)
export function cadTexts(model, db) {
  const rows = [];
  for (const t of model.texts || []) {
    const s = (t.rows || []).map(r => r.s).join(" ").trim();
    if (!s) continue;
    const at = t.quad?.[0] || [0, 0];
    rows.push({ text: s, kind: textKind(s), layer: t.layer, x: at[0], y: at[1], h: t.h, at });
  }
  for (const e of db?.entities || []) {
    if (e.type !== "DIMENSION" || e._deleted) continue;
    let v = e.measurement || e.actualMeasurement || e.act_measurement || null;
    // valore non scritto nel file (codice 42 a zero): dai punti di definizione per le quote lineari e allineate
    const p1 = e.subDefinitionPoint1 || e.xline1Point, p2 = e.subDefinitionPoint2 || e.xline2Point, ty = (e.dimensionType ?? 0) & 7;
    if (!v && p1 && p2 && (ty === 0 || ty === 1)) {
      const a = ty === 0 ? e.rotationAngle || 0 : Math.atan2(p2.y - p1.y, p2.x - p1.x);
      v = Math.abs((p2.x - p1.x) * Math.cos(a) + (p2.y - p1.y) * Math.sin(a));
    }
    const p = e.textPoint || e.definitionPoint || { x: 0, y: 0 };
    const txt = e.text && e.text !== "<>" ? String(e.text).replace(/<>/g, v != null ? fmtV(v) : "") : v != null ? fmtV(v) : "";
    rows.push({ text: txt, kind: "quota_cad", layer: e.layer || "0", x: p.x, y: p.y, h: null, value: v, at: [p.x, p.y], dim: true });
  }
  return rows;
}
const fmtV = v => String(Math.round(v * 1e4) / 1e4);

// ---------------------------------------------------------------- tracciati vettoriali (DWF / PDF)
// path = { rings: [[x,y,x,y...]], closed: [bool] | bool, stroke "#rrggbb", fill "#rrggbb"|"", w, dash, layer, page }
export function vecRecords(paths, regions = []) {
  const agg = new Map();
  for (const p of paths) {
    const rings = p.rings.map(r => { const P = []; for (let i = 0; i + 1 < r.length; i += 2) P.push([r[i], r[i + 1]]); return P; }).filter(P => P.length);
    if (!rings.length) continue;
    const cl = k => (Array.isArray(p.closed) ? p.closed[k] : p.closed);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const P of rings) for (const [x, y] of P) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    const at = [(x0 + x1) / 2, (y0 + y1) / 2];
    const reg = regions.find(r => (r.page ?? null) === (p.page ?? null) && at[0] >= r.box[0] && at[0] <= r.box[2] && at[1] >= r.box[1] && at[1] <= r.box[3]);
    const len = p.stroke ? rings.reduce((s, P, k) => s + polyLen(P, cl(k)), 0) : 0;
    const closedRings = rings.filter((P, k) => cl(k) || p.fill);
    const area = closedRings.length && (p.fill || rings.every((_, k) => cl(k))) ? regionArea(closedRings) : null;
    const key = [p.page ?? "", reg?.id ?? "", p.stroke || "", p.fill || "", p.w ?? "", p.dash || "", p.layer || ""].join("|");
    let a = agg.get(key);
    if (!a) agg.set(key, (a = { page: p.page ?? null, at: reg ? [(reg.box[0] + reg.box[2]) / 2, (reg.box[1] + reg.box[3]) / 2] : at, g: { stroke: p.stroke || "", fill: p.fill || "", width: p.w ?? "", dash: p.dash || "", layer: p.layer || "", style: `${p.stroke || p.fill || "-"} · ${p.w ?? 0}${p.dash ? " · " + p.dash : ""}` }, len: 0, area: null, ents: 0, color: p.stroke || p.fill }));
    a.len += len;
    if (area != null) a.area = (a.area || 0) + area;
    a.ents++;
  }
  return [...agg.values()];
}
// simboli uguali (stesso disegno, anche ruotato di 90 gradi): gruppi di tracciati vicini con la stessa firma
export function vecClusters(paths, sheetBox) {
  const W = sheetBox[2] - sheetBox[0], H = sheetBox[3] - sheetBox[1];
  const boxes = [];
  paths.forEach((p, i) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of p.rings) for (let k = 0; k + 1 < r.length; k += 2) { if (r[k] < x0) x0 = r[k]; if (r[k + 1] < y0) y0 = r[k + 1]; if (r[k] > x1) x1 = r[k]; if (r[k + 1] > y1) y1 = r[k + 1]; }
    if (!isFinite(x0) || x1 - x0 > W * 0.12 || y1 - y0 > H * 0.12) return;
    boxes.push({ b: [x0, y0, x1, y1], i });
  });
  if (boxes.length > 60000) return [];
  boxes.sort((a, b) => a.b[0] - b.b[0]);
  const parent = boxes.map((_, i) => i);
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const tol = Math.max(W, H) * 0.0012;
  let active = [];
  boxes.forEach((B, j) => {
    active = active.filter(k => boxes[k].b[2] + tol >= B.b[0]);
    for (const k of active) { const c = boxes[k].b; if (c[1] - tol <= B.b[3] && B.b[1] - tol <= c[3]) parent[find(j)] = find(k); }
    active.push(j);
  });
  const groups = new Map();
  boxes.forEach((B, j) => { const r = find(j); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(B); });
  const out = [];
  for (const members of groups.values()) {
    const b = [Math.min(...members.map(m => m.b[0])), Math.min(...members.map(m => m.b[1])), Math.max(...members.map(m => m.b[2])), Math.max(...members.map(m => m.b[3]))];
    const size = Math.max(b[2] - b[0], b[3] - b[1]);
    if (b[2] - b[0] > W * 0.15 || b[3] - b[1] > H * 0.15 || size <= 0) continue;
    const sig = signature(members.map(m => paths[m.i]), b, size);
    if (!sig) continue;
    out.push({ box: b, sig, color: paths[members[0].i].stroke || paths[members[0].i].fill, layer: paths[members[0].i].layer, page: paths[members[0].i].page ?? null });
  }
  return out;
}
function signature(list, b, size) {
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, q = Math.max(size / 160, 1e-9);
  const segs = [];
  for (const p of list) p.rings.forEach((r, k) => {
    const closed = Array.isArray(p.closed) ? p.closed[k] : p.closed;
    const n = r.length / 2;
    for (let i = 1; i < n + (closed ? 1 : 0); i++) { const a = (i - 1) % n, c = i % n; segs.push([[r[2 * a] - cx, r[2 * a + 1] - cy], [r[2 * c] - cx, r[2 * c + 1] - cy]]); }
  });
  if (segs.length < 2) return null;
  let best = null;
  for (let rot = 0; rot < 4; rot++) {
    const out = segs.map(([a, c]) => {
      let A = a, B = c;
      for (let k = 0; k < rot; k++) { A = [-A[1], A[0]]; B = [-B[1], B[0]]; }
      const ta = Math.round(A[0] / q) + "," + Math.round(A[1] / q), tb = Math.round(B[0] / q) + "," + Math.round(B[1] / q);
      return ta < tb ? ta + ";" + tb : tb + ";" + ta;
    }).sort().join("|");
    if (best === null || out < best) best = out;
  }
  return Math.round(size / q) + "#" + best;
}
// forma (contorno con i fori) del tracciato sotto il punto: { pts, closed, holes, layer }
export function vecPick(paths, x, y, tol, wantClosed) {
  let best = null, bd = Infinity;
  for (const p of paths) {
    p.rings.forEach((r, k) => {
      const closed = (Array.isArray(p.closed) ? p.closed[k] : p.closed) || !!p.fill;
      const n = r.length / 2;
      let d = Infinity;
      for (let i = 1; i < n + (closed ? 1 : 0); i++) { const a = (i - 1) % n, c = i % n; d = Math.min(d, segD(x, y, r[2 * a], r[2 * a + 1], r[2 * c], r[2 * c + 1])); }
      // dentro un contorno chiuso: vince il piu' piccolo che contiene il punto (un foro prima del contorno esterno)
      if (wantClosed && closed && n > 2 && inRing(x, y, r)) { let a2 = 0; for (let i = 0, j = n - 1; i < n; j = i++) a2 += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1]; d = Math.min(d, tol * 0.8 - 1 / (1 + Math.abs(a2) / 2)); }
      if (wantClosed && !closed) return;
      if (d < bd) { bd = d; best = { p, k }; }
    });
  }
  if (!best || bd > tol) return null;
  const ring = best.p.rings[best.k], P = [];
  for (let i = 0; i + 1 < ring.length; i += 2) P.push([ring[i], ring[i + 1]]);
  const closed = (Array.isArray(best.p.closed) ? best.p.closed[best.k] : best.p.closed) || !!best.p.fill;
  // fori: gli altri contorni chiusi dello stesso tracciato che stanno dentro quello scelto
  const holes = [];
  if (closed) best.p.rings.forEach((r, k) => {
    if (k === best.k || !((Array.isArray(best.p.closed) ? best.p.closed[k] : best.p.closed) || best.p.fill)) return;
    const Q = [];
    for (let i = 0; i + 1 < r.length; i += 2) Q.push([r[i], r[i + 1]]);
    if (Q.length > 2 && inRing(Q[0][0], Q[0][1], ring) && Math.abs(signedArea(Q)) < Math.abs(signedArea(P))) holes.push(Q);
  });
  return { pts: P, closed, holes, layer: best.p.layer || "", color: best.p.stroke || best.p.fill };
}
export function vecSnapItems(paths) {
  const items = [];
  for (const p of paths) {
    p.rings.forEach((r, k) => {
      const closed = (Array.isArray(p.closed) ? p.closed[k] : p.closed) || !!p.fill;
      const n = r.length / 2;
      for (let i = 1; i < n + (closed && n > 2 ? 1 : 0); i++) { const a = (i - 1) % n, c = i % n; if (r[2 * a] !== r[2 * c] || r[2 * a + 1] !== r[2 * c + 1]) items.push({ t: "L", x1: r[2 * a], y1: r[2 * a + 1], x2: r[2 * c], y2: r[2 * c + 1], o: items.length, s: "" }); }
    });
    for (const c of p.circ || []) items.push({ t: "A", cx: c[0], cy: c[1], r: c[2], a0: 0, sw: TAU, pts: Array.from({ length: 33 }, (_, i) => [c[0] + c[2] * Math.cos((i / 32) * TAU), c[1] + c[2] * Math.sin((i / 32) * TAU)]), o: -1, s: "" });
  }
  return items;
}
function segD(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const u = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0;
  return Math.hypot(ax + u * dx - x, ay + u * dy - y);
}
function inRing(x, y, r) {
  let c = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) if ((r[i + 1] > y) !== (r[j + 1] > y) && x < ((r[j] - r[i]) * (y - r[i + 1])) / (r[j + 1] - r[i + 1]) + r[i]) c = !c;
  return c;
}
