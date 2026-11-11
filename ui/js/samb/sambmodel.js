// SAMB - dal file .cii (ciiparse.js) al modello di calcolo in N, mm, MPa, gradi Celsius. Puro, senza DOM.
// Curve = 6 corde con il fattore di flessibilita', valvole = tratto rigido (10 volte la rigidezza) con il peso al centro,
// riduzioni = diametro medio, tratti divisi per trovare i massimi lungo la campata. Ogni dato deciso qui finisce in warnings.
import { supportKind } from "../ciiparse.js";
import { RIGID_R, RIGID_T } from "./sambsolve.js";

export const DEFAULTS = { tref: 20, alpha: 12e-6, fluid: 0, insul: 0, Sc: null, Sh: null, f: 1, bendR: 1.5 };
const PSI = 0.00689476, KG = 9.80665;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const len = Math.hypot;
const unit = a => { const l = len(...a); return a.map(v => v / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function section(od, wt) {
  const id = od - 2 * wt, A = Math.PI / 4 * (od * od - id * id), I = Math.PI / 64 * (od ** 4 - id ** 4);
  return { od, wt, id, A, I, J: 2 * I, Z: 2 * I / od, Ai: Math.PI / 4 * id * id };
}

export function bendFactors(od, wt, R) {
  const r2 = (od - wt) / 2, h = wt * R / (r2 * r2);
  return { h, k: Math.max(1, 1.65 / h), ii: Math.max(1, 0.9 / h ** (2 / 3)), io: Math.max(1, 0.75 / h ** (2 / 3)) };
}

export function buildModel(P, options = {}) {
  const o = { ...DEFAULTS, ...options }, warnings = [];
  const imperial = P.odK !== 1;
  const nodes = [], byId = new Map();
  const addNode = (id, p, named = true) => { const n = nodes.length; nodes.push({ id, p, named }); if (named) byId.set(id, n); return n; };
  const mat = P.materials[0];
  if (P.materials.length > 1) warnings.push(["materiale_primo", P.materials.length]);
  let E, nu, rho;
  if (mat) {
    E = Number(mat.e) * (imperial ? PSI : 1); nu = Number(mat.nu); rho = Number(mat.rho);
    if (imperial) {
      if (rho < 0.05) { rho *= 1e-3; warnings.push(["densita_kgcm3"]); } // 7,85E-3 e' acciaio in kg/cm3, non in lb/in3
      else rho *= 2.76799e-5;
    }
  } else { E = 203000; nu = 0.3; rho = 7.85e-6; warnings.push(["materiale_assente"]); }
  const G = E / (2 * (1 + nu));
  const T = t => (t === null ? o.tref : imperial ? (t - 32) / 1.8 : t);
  const Pr = p => (p === null ? 0 : imperial ? p * PSI : p / 10); // bar -> MPa
  const pos = id => P.nodes.get(id).map(v => v * P.lenK);
  for (const id of P.nodes.keys()) addNode(id, pos(id));

  // pezzi di linea: [nodo iniziale, nodo finale, tratto del file, tipo, dati]
  let lines = P.elements.filter(e => e.len > 0).map(e => ({ a: byId.get(e.from), b: byId.get(e.to), e, kind: "pipe" }));

  // curve: la linea si accorcia delle tangenti e l'arco si fa con corde
  for (const b of P.bends) {
    const n = byId.get(b.node);
    if (n === undefined) { warnings.push(["curva_nodo", b.node]); continue; }
    if (b.angle === null || b.angle < 1) { warnings.push(["curva_ignorata", b.node]); continue; }
    const li = lines.find(l => l.b === n), lo = lines.find(l => l.a === n);
    if (!li || !lo) continue;
    const od = Math.max(li.e.od2, lo.e.od1) * P.odK, wt = li.e.wt * P.odK;
    const k = /SHORT|SR/.test(b.type) ? 1 : o.bendR, R = k * od, th = b.angle * Math.PI / 180, tan = R * Math.tan(th / 2);
    const P0 = nodes[n].p, u1 = unit(sub(P0, nodes[li.a].p)), u2 = unit(sub(nodes[lo.b].p, P0));
    const L1 = len(...sub(P0, nodes[li.a].p)), L2 = len(...sub(nodes[lo.b].p, P0)), same = 1e-6 * R;
    if (tan > L1 + same || tan > L2 + same) { warnings.push(["curva_corta", b.node]); continue; }
    // tangente lunga quanto il tratto: la curva parte dal nodo gia' esistente
    const near = Math.abs(tan - L1) <= same ? li.a : addNode(`${b.node}A`, add(P0, u1, -tan)), far = Math.abs(tan - L2) <= same ? lo.b : addNode(`${b.node}B`, add(P0, u2, tan));
    const normal = unit(cross(u1, u2)), toC = cross(normal, u1), c = add(nodes[near].p, toC, R);
    li.b = near; lo.a = far;
    const NC = 6, ch = 2 * R * Math.sin(th / NC / 2), f = bendFactors(od, wt, R);
    let prev = near;
    for (let s = 1; s <= NC; s++) {
      const a = th * s / NC, pt = add(add(c, toC, -R * Math.cos(a)), u1, R * Math.sin(a));
      const next = s === NC ? far : addNode(`${b.node}.${s}`, pt, false);
      // la corda e' piu' corta dell'arco: la flessibilita' tiene conto della differenza
      lines.push({ a: prev, b: next, e: li.e, kind: "bend", od, wt, bend: { ...f, k: f.k * (th * R / NC) / ch, kNom: f.k, R, normal, node: b.node } });
      prev = next;
    }
  }

  // valvole: tratto rigido centrato sul nodo, peso concentrato al centro
  const point = [];
  for (const v of P.valves) {
    if (!v.pos) { warnings.push(["valvola_nodo", v.node]); continue; }
    const c = v.pos.map(x => x * P.lenK), L = (v.len > 0 ? v.len : v.od * 1.5) * P.odK;
    const line = lines.find(l => l.kind === "pipe" && onSegment(c, nodes[l.a].p, nodes[l.b].p, L));
    let at;
    if (line) {
      const d = unit(sub(nodes[line.b].p, nodes[line.a].p));
      const a = addNode(`${v.node}A`, add(c, d, -L / 2)), m = byId.get(v.node) ?? addNode(v.node, c), b = addNode(`${v.node}B`, add(c, d, L / 2));
      const end = line.b;
      line.b = a;
      lines.push({ a, b: m, e: line.e, kind: "rigid" }, { a: m, b, e: line.e, kind: "rigid" }, { a: b, b: end, e: line.e, kind: "pipe" });
      at = m;
    } else { at = byId.get(v.node); warnings.push(["valvola_concentrata", v.node]); }
    const W = Number(v.other);
    if (at !== undefined && W > 0) {
      const N = imperial ? W * 4.44822 : W * KG;
      point.push({ node: at, f: [0, -N, 0, 0, 0, 0] });
      warnings.push(["valvola_peso", v.node, W, imperial ? "lb" : "kg"]);
    }
  }

  // elementi di calcolo: i tratti normali si dividono per seguire il momento lungo la campata
  const elems = [];
  const sub2 = (ln, from, to) => {
    const e = ln.e, od = (ln.od ?? (e.reducer ? (e.od1 + e.od2) / 2 : e.od) * P.odK), wt = ln.wt ?? e.wt * P.odK, s = section(od, wt);
    if (!(s.id > 0)) throw new Error("bad_section");
    const massFluid = o.fluid * 1e-9 * s.Ai, w = (rho * s.A + massFluid) * KG + o.insul / 1000;
    const rigid = ln.kind === "rigid", mul = rigid ? 10 : 1;
    const out = { i: from, j: to, A: s.A * mul, Iy: s.I * mul, Iz: s.I * mul, J: s.J * mul, E, G, Asy: s.A / 2 * mul, Asz: s.A / 2 * mul, k: ln.bend?.k || 1, w: rigid ? 0 : w,
      eps: o.alpha * (T(e.temp) - o.tref), sec: s, P: Pr(e.press), kind: ln.kind, ii: 1, io: 1, source: `${e.from} - ${e.to}`, vz: ln.bend?.normal };
    if (ln.bend) { out.ii = ln.bend.ii; out.io = ln.bend.io; out.kNom = ln.bend.kNom; out.bendNode = ln.bend.node; }
    if (e.reducer && ln.kind === "pipe") {
      const D = Math.min(e.od1, e.od2) * P.odK, ang = Math.atan2(Math.abs(e.od1 - e.od2) * P.odK / 2, e.len * P.lenK) * 180 / Math.PI;
      out.ii = out.io = Math.max(1, Math.min(2, 0.5 + 0.01 * ang * Math.sqrt(D / wt)));
      out.kind = "reducer";
    }
    return out;
  };
  for (const ln of lines) {
    const pa = nodes[ln.a].p, pb = nodes[ln.b].p, L = len(...sub(pb, pa));
    if (!(L > 1e-6)) continue;
    if (ln.kind !== "pipe") { elems.push(sub2(ln, ln.a, ln.b)); continue; }
    const od = (ln.e.reducer ? (ln.e.od1 + ln.e.od2) / 2 : ln.e.od) * P.odK, N = Math.min(40, Math.max(1, Math.ceil(L / Math.max(500, 2 * od))));
    let prev = ln.a;
    for (let s = 1; s <= N; s++) {
      const next = s === N ? ln.b : addNode(`${nodes[ln.a].id}+${Math.round(L * s / N)}`, add(pa, sub(pb, pa), s / N), false);
      elems.push(sub2(ln, prev, next));
      prev = next;
    }
  }

  // vincoli (con le curve il nodo d'angolo non e' sulla linea: il vincolo va all'inizio della curva)
  const restraints = [];
  const connected = new Set(elems.flatMap(e => [e.i, e.j]));
  for (const s of P.supports) {
    let n = byId.get(s.node);
    if (n !== undefined && !connected.has(n)) { n = byId.get(`${s.node}A`); warnings.push(["vincolo_su_curva", s.node]); }
    if (n === undefined) { warnings.push(["vincolo_nodo", s.node]); continue; }
    const k = supportKind(s.type), raw = String(s.type).toUpperCase();
    const T3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    if (k.kind === "anchor") {
      for (const d of T3) { restraints.push({ node: n, dof: "t", d, k: RIGID_T }); restraints.push({ node: n, dof: "r", d, k: RIGID_R }); }
    } else if (k.kind === "axis") {
      const d = T3[k.axis].slice(), sign = raw[0] === "-" ? -1 : 1;
      restraints.push({ node: n, dof: "t", d: raw[0] === "+" || raw[0] === "-" ? d.map(v => v * sign) : d, k: RIGID_T, oneWay: raw[0] === "+" || raw[0] === "-" });
    } else if (k.kind === "guide") {
      // come nei programmi di calcolo: laterale e orizzontale rispetto al tubo; su un tubo verticale nei due sensi orizzontali
      const ax = P.axisAt(s.node), side = cross(ax, [0, 1, 0]);
      if (len(...side) < 1e-6) { restraints.push({ node: n, dof: "t", d: T3[0], k: RIGID_T }, { node: n, dof: "t", d: T3[2], k: RIGID_T }); }
      else restraints.push({ node: n, dof: "t", d: unit(side), k: RIGID_T });
      warnings.push(["guida_laterale", s.node]);
    } else warnings.push(["vincolo_sconosciuto", s.node, s.type]);
  }
  if (!restraints.length) warnings.push(["nessun_vincolo"]);
  if (!o.Sc || !o.Sh) warnings.push(["ammissibili_mancanti"]);
  if (!o.fluid) warnings.push(["fluido_zero"]);
  warnings.push(["alpha_ipotesi", `${+(o.alpha * 1e6).toFixed(3)}e-6`, o.tref]);
  warnings.push(["ec_freddo"]);
  // l'angolo di una curva non e' piu' sulla linea: i nodi senza elementi renderebbero singolare la matrice
  const map = new Map(), kept = [];
  nodes.forEach((nd, i) => { if (connected.has(i)) { map.set(i, kept.length); kept.push(nd); } });
  for (const e of elems) { e.i = map.get(e.i); e.j = map.get(e.j); }
  for (const r of restraints) r.node = map.get(r.node);
  return { nodes: kept, elems, point: point.filter(p => map.has(p.node)).map(p => ({ ...p, node: map.get(p.node) })), restraints, warnings, opts: o };
}

function onSegment(c, a, b, L) {
  const d = sub(b, a), l = len(...d), t = (d[0] * (c[0] - a[0]) + d[1] * (c[1] - a[1]) + d[2] * (c[2] - a[2])) / (l * l);
  if (t * l < L / 2 || (1 - t) * l < L / 2) return false;
  const q = add(a, d, t);
  return len(...sub(c, q)) < 1e-6 * Math.max(1, l);
}
