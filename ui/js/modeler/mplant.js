// Impiantistica nel modellatore: catalogo delle misure (tubi, canaline portacavi, condotte), distinta materiali e percorsi
// dalle linee degli schizzi o dagli spigoli. Il catalogo si allarga dall'interfaccia (misure dell'utente in localStorage).
import { t as tr } from "../i18n.js";

// tubi in acciaio: DN, diametro esterno (EN 10220 / ISO 4200) e spessore (serie 40)
const PIPES = [
  [15, 21.3, 2.77], [20, 26.9, 2.87], [25, 33.7, 3.38], [32, 42.4, 3.56], [40, 48.3, 3.68], [50, 60.3, 3.91], [65, 76.1, 5.16],
  [80, 88.9, 5.49], [100, 114.3, 6.02], [125, 139.7, 6.55], [150, 168.3, 7.11], [200, 219.1, 8.18], [250, 273.0, 9.27],
  [300, 323.9, 10.31], [350, 355.6, 11.13], [400, 406.4, 12.7], [450, 457.0, 14.27], [500, 508.0, 15.09], [600, 610.0, 17.48],
];
const TRAYS = [[50, 50], [75, 50], [100, 60], [150, 60], [200, 60], [300, 60], [300, 100], [400, 60], [400, 100], [500, 100], [600, 100]];
const DUCTS_R = [[200, 150], [300, 200], [400, 250], [500, 300], [600, 400], [800, 400], [1000, 500]];
const DUCTS_C = [100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000];

export const DENSITY = { pipe: 7.85e-6, tray: 7.85e-6, duct: 7.85e-6, ductr: 7.85e-6 }; // kg/mm3 (acciaio / lamiera zincata)

// classi di tubazione (specifiche di linea): materiale, pressione nominale, spessori per DN, raggio delle curve, densita'.
// Le classi del documento (doc.specs, stessa forma) si aggiungono a queste e le possono sostituire con lo stesso codice.
const SCH80 = { 15: 3.73, 20: 3.91, 25: 4.55, 32: 4.85, 40: 5.08, 50: 5.54, 65: 7.01, 80: 7.62, 100: 8.56, 125: 9.53, 150: 10.97, 200: 12.7, 250: 15.09, 300: 17.48, 350: 19.05, 400: 21.44, 450: 23.83, 500: 26.19, 600: 30.96 };
const SCH10S = { 15: 2.11, 20: 2.11, 25: 2.77, 32: 2.77, 40: 2.77, 50: 2.77, 65: 3.05, 80: 3.05, 100: 3.05, 125: 3.4, 150: 3.4, 200: 3.76, 250: 4.19, 300: 4.57, 350: 4.78, 400: 4.78, 450: 4.78, 500: 5.54, 600: 6.35 };
// PVC-U (EN ISO 1452) PN10: DN -> diametro esterno (SDR 21 circa)
const PVC = [[15, 20], [20, 25], [25, 32], [32, 40], [40, 50], [50, 63], [65, 75], [80, 90], [100, 110], [125, 140], [150, 160], [200, 225], [250, 280], [300, 315], [400, 400]];
// rame (EN 1057): diametro esterno x spessore
const CU = [[12, 1], [15, 1], [18, 1], [22, 1], [28, 1.2], [35, 1.5], [42, 1.5], [54, 2], [76.1, 2], [88.9, 2], [108, 2.5]];
export const SPECS = () => [
  { id: "A1", name: tr("mod.cl_a1"), mat: "P235GH (EN 10216-2)", pn: 16, dens: 7.85e-6, rf: 1.5, wall: dn => (PIPES.find(p => p[0] === dn) || [])[2] },
  { id: "A2", name: tr("mod.cl_a2"), mat: "P265GH (EN 10216-2)", pn: 40, dens: 7.85e-6, rf: 1.5, wall: dn => SCH80[dn] },
  { id: "B1", name: tr("mod.cl_b1"), mat: "X2CrNiMo17-12-2 (AISI 316L)", pn: 16, dens: 8.0e-6, rf: 1.5, wall: dn => SCH10S[dn] },
  { id: "C1", name: tr("mod.cl_c1"), mat: "PVC-U (EN ISO 1452)", pn: 10, dens: 1.4e-6, rf: 1.0, plastic: true },
  { id: "D1", name: tr("mod.cl_d1"), mat: "Cu-DHP (EN 1057)", pn: 16, dens: 8.94e-6, rf: 1.0, copper: true },
];
export const specOf = (id, doc = null) => [...(doc?.specs || []), ...SPECS()].find(s => s.id === id) || SPECS()[0];

const custom = () => { try { return JSON.parse(localStorage.getItem("mbv-impianti-misure") || "[]"); } catch { return []; } };
export function addCustom(item) {
  const l = custom().filter(x => x.id !== item.id);
  l.push(item);
  try { localStorage.setItem("mbv-impianti-misure", JSON.stringify(l)); } catch { /* */ }
}

// misure per tipo (e per classe, per i tubi): {id, label, kind, od|w,h, t, r}
export function sizes(kind, specId = "A1", doc = null) {
  let out = [];
  if (kind === "pipe") {
    const sp = specOf(specId, doc);
    if (sp.plastic) out = PVC.map(([dn, d]) => ({ id: "DN" + dn, label: `DN ${dn} · Ø${d} × ${Math.max(1.5, Math.round(d / 21 * 10) / 10)}`, kind, od: d, t: Math.max(1.5, Math.round(d / 21 * 10) / 10), r: d * sp.rf }));
    else if (sp.copper) out = CU.map(([d, t]) => ({ id: "Cu" + d, label: `Ø${d} × ${t}`, kind, od: d, t, r: d * Math.max(sp.rf, 1) }));
    else out = PIPES.map(([dn, od, t]) => ({ id: "DN" + dn, label: `DN ${dn} · Ø${od} × ${sp.wall?.(dn) || t}`, kind, od, t: sp.wall?.(dn) || t, r: Math.max(Math.round(dn * sp.rf * 10) / 10, od) }));
    for (const s of out) { s.spec = sp.id; s.pn = sp.pn; s.mat = sp.mat; }
    return [...out, ...custom().filter(c => c.kind === kind)];
  }
  else if (kind === "tray") out = TRAYS.map(([w, h]) => ({ id: `C${w}x${h}`, label: `${w} × ${h} · ${tr("mod.pl_lamiera")} 1,5`, kind, w, h, t: 1.5, r: w }));
  else if (kind === "ductr") out = DUCTS_R.map(([w, h]) => ({ id: `R${w}x${h}`, label: `${w} × ${h} · ${tr("mod.pl_lamiera")} 0,8`, kind, w, h, t: 0.8, r: Math.max(w, h) }));
  else if (kind === "duct") out = DUCTS_C.map(d => ({ id: "D" + d, label: `Ø ${d} · ${tr("mod.pl_lamiera")} 0,6`, kind, od: d, t: 0.6, r: d }));
  return [...out, ...custom().filter(c => c.kind === kind)];
}
export const KINDS = () => [["pipe", tr("mod.pl_tubazione")], ["tray", tr("mod.pl_canalina")], ["ductr", tr("mod.pl_condotta_r")], ["duct", tr("mod.pl_condotta_c")]];
export const fittingName = k => tr("mod.pl_" + k);
export const kindName = k => (KINDS().find(x => x[0] === k) || [k, k])[1];

// distinta materiali: una riga per tipo e misura (tubazioni, canaline, condotte) + gli altri corpi
export function bom(app) {
  const rows = new Map();
  const others = [];
  for (const b of app.bodyList()) {
    const m = (app.res.bodies.find(q => q.id === b.id) || {}).meta;
    const p = b.data?.props || {};
    if (m?.componente) {
      const key = "c|" + m.componente + "|" + m.misura;
      if (!rows.has(key)) rows.set(key, { tipo: tr("mod.pl_" + m.componente), misura: m.misura, pezzi: 0, dritti: 0, curve: 0, angoli: new Map(), lunghezza: 0, peso: 0, corpi: [], comp: true });
      const r = rows.get(key);
      r.pezzi += m.quantita || 1;
      if (m.altezze) { r.lunghezza += m.altezze.reduce((a, b) => a + b, 0); r.comp = "staffe"; }
      r.peso += (p.vol || 0) * 7.85e-6;
      r.corpi.push(b.name);
    } else if (m?.impianto) {
      const sp = m.impianto === "pipe" && m.spec ? specOf(m.spec, app.doc) : null;
      const key = m.impianto + "|" + (m.spec || "") + "|" + (m.misura || sizeLabel(m));
      if (!rows.has(key)) rows.set(key, { tipo: kindName(m.impianto) + (sp ? " " + sp.id : ""), misura: (m.misura || sizeLabel(m)) + (sp ? " · " + sp.mat + " · PN" + sp.pn : ""), pezzi: 0, dritti: 0, curve: 0, angoli: new Map(), lunghezza: 0, peso: 0, corpi: [], dens: sp?.dens });
      const r = rows.get(key);
      r.pezzi++;
      r.dritti += m.dritti.reduce((s, d) => s + d, 0);
      r.curve += m.curve.length;
      for (const a of m.curve) r.angoli.set(a, (r.angoli.get(a) || 0) + 1);
      r.lunghezza += m.lunghezza;
      r.peso += (p.vol || 0) * (r.dens || DENSITY[m.impianto] || 7.85e-6);
      r.corpi.push(b.name);
    } else others.push({ nome: b.name, volume: p.vol || 0, peso: (p.vol || 0) * 7.85e-6 });
  }
  return { rows: [...rows.values()], others };
}
export const sizeLabel = m => (m.od ? "Ø" + m.od + (m.t ? " × " + m.t : "") : `${m.w} × ${m.h}` + (m.t ? " × " + m.t : ""));

// righe della distinta per CSV / Excel
export function bomTable(B) {
  const head = [tr("mod.pl_tipo"), tr("mod.pl_misura"), tr("mod.pl_tratti"), tr("mod.pl_lung_dritti_m"), tr("mod.pl_curve"), tr("mod.pl_lung_totale_m"), tr("mod.pl_peso_kg")];
  const rows = B.rows.map(r => [r.tipo, r.misura, r.pezzi, r.comp ? "" : +(r.dritti / 1000).toFixed(3),
    r.comp ? "" : [...r.angoli.entries()].map(([a, n]) => `${n} × ${+a.toFixed(1)}°`).join(", ") || "0",
    r.comp === true ? "" : +(r.lunghezza / 1000).toFixed(3), +r.peso.toFixed(2)]);
  const head2 = [tr("mod.corpo"), tr("mod.volume") + " (mm³)", tr("mod.pl_peso_kg")];
  const rows2 = B.others.map(o => [o.nome, +o.volume.toFixed(1), +o.peso.toFixed(3)]);
  return { head, rows, head2, rows2 };
}

// percorso dalle linee di uno schizzo: la catena di linee non di costruzione piu' lunga, in ordine
export function chainFromSketch(sk) {
  const lines = sk.ents.filter(e => e.t === "line" && !e.cons);
  if (!lines.length) return null;
  const adj = new Map();
  for (const l of lines) for (const [a, b] of [[l.p1, l.p2], [l.p2, l.p1]]) { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); }
  // si parte da un estremo libero (grado 1) se c'e'
  const starts = [...adj.keys()].filter(k => adj.get(k).length === 1);
  let best = null;
  for (const s of starts.length ? starts : [...adj.keys()]) {
    const seen = new Set([s]);
    const path = [s];
    let cur = s;
    for (;;) {
      const nx = (adj.get(cur) || []).find(q => !seen.has(q));
      if (!nx) break;
      seen.add(nx); path.push(nx); cur = nx;
    }
    let L = 0;
    for (let i = 1; i < path.length; i++) L += Math.hypot(sk.pts[path[i]].x - sk.pts[path[i - 1]].x, sk.pts[path[i]].y - sk.pts[path[i - 1]].y);
    if (!best || L > best.L) best = { path, L };
  }
  return best && best.path.length >= 2 ? best.path.map(id => [sk.pts[id].x, sk.pts[id].y]) : null;
}

// percorso dagli spigoli dritti scelti: catena ordinata dai loro estremi
export function chainFromEdges(edges) {
  const segs = edges.filter(e => e.t === "line" && e.a0 && e.a1).map(e => [e.a0, e.a1]);
  if (!segs.length) return null;
  const k = p => p.map(v => Math.round(v * 1000)).join(",");
  const adj = new Map();
  for (const [a, b] of segs) for (const [p, q] of [[a, b], [b, a]]) { if (!adj.has(k(p))) adj.set(k(p), { p, n: [] }); adj.get(k(p)).n.push(q); }
  const start = [...adj.values()].find(v => v.n.length === 1) || [...adj.values()][0];
  const out = [start.p];
  const seen = new Set([k(start.p)]);
  let cur = start;
  for (;;) {
    const nx = cur.n.find(q => !seen.has(k(q)));
    if (!nx) break;
    seen.add(k(nx)); out.push(nx); cur = adj.get(k(nx));
  }
  return out.length >= 2 ? out : null;
}
