// Documento del modello 3D (.mbmod): cronologia delle lavorazioni, parametri, aspetto dei corpi; compilazione per il
// motore (mbvisual/modkernel.py): espressioni valutate, schizzi risolti, profili scritti come contorni espliciti.
//
// doc = { format, units: "mm", seq, params: [{name, expr}], features: [...], looks: {corpo: {name, color, hidden}}, end }
// lavorazioni (campi numerici = numero o espressione con i parametri):
//   sketch    {plane: {std: XY|XZ|YZ, off} | {face: rif, off}, sk: {pts, ents, cons, seq}, hidden}
//   extrude   {sketch, profiles: [firma], d, mode: one|sym|two, d2, through, op: new|join|cut|common, targets}
//   revolve   {sketch, profiles, axis: {e: linea} | {std: x|y}, ang, op}
//   primitive {shape: box|cyl|sphere|cone|torus, p, dx, dy, dz, r, r2, h, op}
//   hole      {face: rif, pts: [[x,y,z]], dia, depth, through, kind: simple|cbore|csink, cbd, cbh, csd, csa}
//   fillet {edges, r} · chamfer {edges, d} · shell {body, faces, t} · pushpull {face, d} · delface {faces}
//   boolean {op: join|cut|common, a, b: [], keep} · transform {bodies, tf: {k: move|rotate|scale|mirror, ...}, copy}
//   pattern {bodies, kind: linear|circular, d, n, s, d2, n2, s2, o, ax, ang, fuse} · delbody {bodies} · split {bodies, o, n}
//   mate {move, a: rif, b: rif, kind: coinc|conc, off, flip} · import {items: [{blob, name, color, kind}], src}
// rif (faccia/spigolo) = {b: corpo, k: f|e, t, c, cn, n|d, a|l, r}: firma geometrica, ritrovata dal motore dopo ogni ricalcolo.
import { evalExpr, evalParams } from "./mexpr.js";
import { solve } from "./msolver.js";
import { findRegions, matchRegion } from "./mregions.js";
import { chainFromSketch, fittingName, kindName } from "./mplant.js";

export const FORMAT = "mbmod-1";
export function newDoc() { return { format: FORMAT, units: "mm", seq: 1, params: [], features: [], looks: {}, end: null }; }
export const nextId = (doc, p = "f") => p + (doc.seq++);

// campi numerici delle lavorazioni (anche dentro tf)
const NUM = new Set(["d", "d2", "ang", "dia", "depth", "r", "r2", "t", "cbd", "cbh", "csd", "csa", "off", "dx", "dy", "dz", "h", "n", "s", "n2", "s2", "f", "fx", "fy", "fz"]);

export const STD = {
  XY: { o: [0, 0, 0], x: [1, 0, 0], n: [0, 0, 1] },
  XZ: { o: [0, 0, 0], x: [1, 0, 0], n: [0, -1, 0] },
  YZ: { o: [0, 0, 0], x: [0, 1, 0], n: [1, 0, 0] },
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = a => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };
export const vec = { cross, dot, unit, add: (a, b) => a.map((v, i) => v + b[i]), sub: (a, b) => a.map((v, i) => v - b[i]), mul: (a, k) => a.map(v => v * k) };

// piano di uno schizzo su una faccia: stessa regola del motore (modkernel.plane_from_normal)
export function facePlane(n, p0) {
  n = unit(n);
  const o = vec.mul(n, dot(n, p0));
  const x = Math.abs(n[2]) > 0.999 ? [1, 0, 0] : unit(cross([0, 0, 1], n));
  return { o, x, y: cross(n, x), n };
}
export function stdPlane(name, off = 0) {
  const P = STD[name] || STD.XY;
  return { o: vec.add(P.o, vec.mul(P.n, off)), x: P.x, y: cross(P.n, P.x), n: P.n };
}

// riferimento da una faccia o uno spigolo (dati dell'ultimo ricalcolo)
export function makeRef(bodyId, kind, info) {
  const r = { b: bodyId, k: kind, t: info.t, c: info.c, cn: info.cn };
  if (info.n) r.n = info.n;
  if (info.d) r.d = info.d;
  if (kind === "f") r.a = info.a; else r.l = info.l;
  if (info.r) r.r = info.r;
  return r;
}

// valuta i campi numerici (anche in vettori e nella trasformazione)
function numFields(f, num) {
  const out = {};
  for (const [k, v] of Object.entries(f)) {
    if (k === "sk" || k === "profiles" || k === "items" || k === "name") { out[k] = v; continue; }
    if (k === "tf" && v && typeof v === "object") { out.tf = numFields(v, num); continue; }
    if (typeof v === "string" && NUM.has(k)) out[k] = num(v);
    else if (Array.isArray(v) && v.length && v.length <= 4 && v.every(x => typeof x === "number" || typeof x === "string") && !["bodies", "b", "targets"].includes(k)) out[k] = v.map(x => (typeof x === "string" ? num(x) : x));
    else out[k] = v;
  }
  return out;
}

// compilazione: { cdoc (per il motore), errs: {id: [chiave, ...arg]}, regions: {schizzo: [regioni]}, vals (parametri) }
export function compile(doc, { upto = null } = {}) {
  const { vals, errs: perr } = evalParams(doc.params);
  const num = v => (typeof v === "number" ? v : evalExpr(v, vals));
  const end = upto ?? (doc.end ?? doc.features.length);
  const errs = {}, regions = {}, solved = {};
  const out = [];
  doc.features.slice(0, end).forEach(f => {
    let cf;
    try {
      if (f.type === "sketch") {
        const sk = f.sk;
        for (const c of sk.cons) if ("v" in c) c.val = num(c.v);
        const r = solve(sk);
        solved[f.id] = r;
        if (!r.ok) errs[f.id] = ["mod.schizzo_non_risolto"];
        regions[f.id] = findRegions(sk);
        cf = { id: f.id, type: "sketch", plane: { ...f.plane, off: f.plane?.off !== undefined ? num(f.plane.off) : 0 } };
      } else {
        cf = numFields(f, num);
        if (f.type === "extrude" || f.type === "revolve") {
          const R = regions[f.sketch] || [];
          const loops = [];
          for (const sig of f.profiles || []) {
            const m = matchRegion(R, sig);
            if (m) loops.push({ outer: m.outer, holes: m.holes });
          }
          if (!loops.length || loops.length < (f.profiles || []).length) errs[f.id] = ["mod.profilo_perso"];
          cf.loops = loops;
          delete cf.profiles;
          if (f.type === "revolve") cf.axis = axisOf(doc, f);
        }
        // tubazione/canalina dalle linee di uno schizzo: i punti seguono lo schizzo (piano calcolato dal motore)
        if (f.type === "route" && f.sketch) {
          const sk = doc.features.find(s => s.id === f.sketch)?.sk;
          const ch = sk && chainFromSketch(sk);
          if (!ch) errs[f.id] = ["mod.pl_schizzo_senza_linee"];
          cf.pts2 = ch || [];
          delete cf.pts;
        }
      }
    } catch (e) {
      errs[f.id] = ["mod.espressione_non_valida", e.message || ""];
      cf = { id: f.id, type: f.type, off: true };
    }
    if (f.off) cf.off = true;
    out.push(cf);
  });
  return { cdoc: { features: out }, errs, perr, regions, vals, solved };
}

function axisOf(doc, f) {
  const ax = f.axis || {};
  if (ax.std === "x") return [[0, 0], [1, 0]];
  if (ax.std === "y") return [[0, 0], [0, 1]];
  const sk = doc.features.find(s => s.id === f.sketch)?.sk;
  const e = sk?.ents.find(q => q.id === ax.e);
  if (!e || e.t !== "line") return null;
  const a = sk.pts[e.p1], b = sk.pts[e.p2];
  return [[a.x, a.y], [b.x, b.y]];
}

// ------------------------------------------------------------------------------------------------- cronologia
export class History {
  constructor(doc, max = 100) { this.stack = [JSON.stringify(doc)]; this.pos = 0; this.max = max; this.labels = [""]; }
  push(doc, label = "") {
    const s = JSON.stringify(doc);
    if (s === this.stack[this.pos]) return false;
    this.stack.length = this.pos + 1;
    this.labels.length = this.pos + 1;
    this.stack.push(s);
    this.labels.push(label);
    if (this.stack.length > this.max) { this.stack.shift(); this.labels.shift(); }
    this.pos = this.stack.length - 1;
    return true;
  }
  get canUndo() { return this.pos > 0; }
  get canRedo() { return this.pos < this.stack.length - 1; }
  get undoLabel() { return this.labels[this.pos] || ""; }
  get redoLabel() { return this.labels[this.pos + 1] || ""; }
  undo() { if (!this.canUndo) return null; this.pos--; return JSON.parse(this.stack[this.pos]); }
  redo() { if (!this.canRedo) return null; this.pos++; return JSON.parse(this.stack[this.pos]); }
}

// lavorazioni che usano un corpo o uno schizzo (per avvisare prima di eliminare)
export function dependents(doc, id) {
  const out = [];
  const uses = (f, x) => JSON.stringify(f).includes(`"${x}"`);
  for (const f of doc.features) if (f.id !== id && (f.sketch === id || uses(f, id))) out.push(f.id);
  return out;
}

// nome visibile dei corpi: dall'aspetto, poi dalla lavorazione che li ha creati
export function bodyName(doc, bid, fallbackN) {
  const lk = doc.looks?.[bid];
  if (lk?.name) return lk.name;
  const f = doc.features.find(q => q.id === bid.split(":")[0]);
  if (f?.type === "fitting") { const r = doc.features.find(q => q.id === f.route); return fittingName(f.kind) + (r?.size ? " " + r.size : ""); }
  if (f?.type === "route") return kindName(f.kind) + " " + (f.size || "") + (bid.includes(":") ? " (" + bid.split(":").pop() + ")" : "");
  if (f?.type === "import") {
    const k = bid.includes(":") ? +bid.split(":").pop() : 0;
    const it = f.items?.[k];
    if (it?.name) return it.name;
  }
  return fallbackN;
}
