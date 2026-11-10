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

const custom = () => { try { return JSON.parse(localStorage.getItem("mbv-impianti-misure") || "[]"); } catch { return []; } };
export function addCustom(item) {
  const l = custom().filter(x => x.id !== item.id);
  l.push(item);
  try { localStorage.setItem("mbv-impianti-misure", JSON.stringify(l)); } catch { /* */ }
}

// misure per tipo: {id, label, kind, od|w,h, t, r}
export function sizes(kind) {
  let out = [];
  if (kind === "pipe") out = PIPES.map(([dn, od, t]) => ({ id: "DN" + dn, label: `DN ${dn} · Ø${od} × ${t}`, kind, od, t, r: Math.round(dn * 1.5 * 10) / 10 || od * 1.5 }));
  else if (kind === "tray") out = TRAYS.map(([w, h]) => ({ id: `C${w}x${h}`, label: `${w} × ${h} · ${tr("mod.pl_lamiera")} 1,5`, kind, w, h, t: 1.5, r: w }));
  else if (kind === "ductr") out = DUCTS_R.map(([w, h]) => ({ id: `R${w}x${h}`, label: `${w} × ${h} · ${tr("mod.pl_lamiera")} 0,8`, kind, w, h, t: 0.8, r: Math.max(w, h) }));
  else if (kind === "duct") out = DUCTS_C.map(d => ({ id: "D" + d, label: `Ø ${d} · ${tr("mod.pl_lamiera")} 0,6`, kind, od: d, t: 0.6, r: d }));
  // curve dei tubi: raggio lungo 1,5 DN (EN 10253 tipo 3D); per DN piccoli non meno del diametro
  for (const s of out) if (kind === "pipe") s.r = Math.max(s.r, s.od);
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
      r.pezzi++;
      r.peso += (p.vol || 0) * 7.85e-6;
      r.corpi.push(b.name);
    } else if (m?.impianto) {
      const key = m.impianto + "|" + (m.misura || sizeLabel(m));
      if (!rows.has(key)) rows.set(key, { tipo: kindName(m.impianto), misura: m.misura || sizeLabel(m), pezzi: 0, dritti: 0, curve: 0, angoli: new Map(), lunghezza: 0, peso: 0, corpi: [] });
      const r = rows.get(key);
      r.pezzi++;
      r.dritti += m.dritti.reduce((s, d) => s + d, 0);
      r.curve += m.curve.length;
      for (const a of m.curve) r.angoli.set(a, (r.angoli.get(a) || 0) + 1);
      r.lunghezza += m.lunghezza;
      r.peso += (p.vol || 0) * (DENSITY[m.impianto] || 7.85e-6);
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
    r.comp ? "" : [...r.angoli.entries()].map(([a, n]) => `${n} × ${+a.toFixed(1)}°`).join(", ") || "0", r.comp ? "" : +(r.lunghezza / 1000).toFixed(3), +r.peso.toFixed(2)]);
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
