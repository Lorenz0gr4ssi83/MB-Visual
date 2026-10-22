// Decodifica Edgebreaker delle shell HSF (W3D), scritta da zero a partire dall'articolo pubblico di J. Rossignac
// ("Edgebreaker: connectivity compression for triangle meshes", 1999; versione su "corner table" 2001) e dalla
// descrizione pubblicata nella specifica HSF (sequenza CLERS, tabella M con vertici fittizi e "patch", punti predetti
// a parallelogramma e quantizzati sul riquadro di ingombro, campioni a cascata 2/6/10/14/18/22/26/31 bit).
// L'anello di bordo iniziale (k vertici gia' noti) e' rappresentato da un "tappo" virtuale a ventaglio attorno a un
// vertice fittizio: la rotazione attorno a un vertice lo attraversa come una qualsiasi altra regione gia' visitata.

export const CASE = { C: 0, L: 1, E: 2, R: 3, S: 4 };
const n3 = c => (c % 3 === 2 ? c - 2 : c + 1);
const p3 = c => (c % 3 === 0 ? c + 2 : c - 1);
const FREE = -1, ZIP = -2, GATE = -3;

/**
 * @param {Uint8Array} ops sequenza CLERS (0=C 1=L 2=E 3=R 4=S)
 * @param {number} k vertici dell'anello iniziale
 * @param {{ reverseLoop?: boolean, firstEdge?: number }} opts varianti di convenzione
 * Restituisce { tris (indici dei vertici in ordine di creazione), order: per ogni triangolo reale l'angolo, ... }
 */
export function decodeConnectivity(ops, k, opts = {}) {
  let cap3 = 3 * k;
  let V = new Int32Array(cap3 + 3 * ops.length + 3), O = new Int32Array(V.length).fill(FREE);
  const parent = [];
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const newVert = () => { parent.push(parent.length); return parent.length - 1; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const realIndex = new Map();
  let N = 0;
  // tappo: vertice fittizio "centro" e k triangoli (centro, v[i+1], v[i]) cosi' i lati dell'anello, visti dal tappo,
  // vanno da v[i+1] a v[i]
  const center = newVert();
  const ring = [];
  for (let i = 0; i < k; i++) { const v = newVert(); realIndex.set(v, N++); ring.push(v); }
  if (opts.reverseLoop) ring.reverse();
  for (let i = 0; i < k; i++) {
    const t = 3 * i;
    V[t] = center; V[t + 1] = ring[(i + 1) % k]; V[t + 2] = ring[i];
  }
  // lati interni del tappo: (centro, v[i+1]) del triangolo i con (v[i+1], centro) del triangolo i+1
  for (let i = 0; i < k; i++) {
    const t = 3 * i, u = 3 * ((i + 1) % k);
    // in t: lato opposto a t+2 = (t -> t+1) = (centro -> v[i+1]); in u: lato opposto a u+1 = (u+2 -> u) = (v[i+1] -> centro)
    O[t + 2] = u + 1; O[u + 1] = t + 2;
  }
  let T = k;
  let pending = [];
  const addTri = pc => {
    const a = 3 * T;
    T++;
    O[a] = pc; O[pc] = a;
    V[a + 1] = V[p3(pc)];
    V[a + 2] = V[n3(pc)];
    return a;
  };
  // incolla due lati (opposti agli angoli c1 e c2, percorsi in versi opposti): i loro estremi coincidono
  const glue = (c1, c2) => {
    O[c1] = c2; O[c2] = c1;
    union(V[n3(c1)], V[p3(c2)]);
    union(V[p3(c1)], V[n3(c2)]);
  };
  // cerca il lato libero adiacente al lato opposto a c1 ruotando (sempre nello stesso verso) attorno al suo vertice
  // finale attraverso i lati uscenti dei triangoli gia' costruiti; se trova un cancello o un lato in sospeso si riprova dopo
  const zip = c1 => {
    let x = p3(c1), x0 = x;
    for (let g = 0; g < 1e6; g++) {
      const e = p3(x), y = O[e];
      if (y === FREE) { if (e !== c1) { glue(c1, e); return true; } break; }
      if (y < 0) break;
      x = p3(y);
      if (x === x0) break;
    }
    return false;
  };
  const tryZip = c => (O[c] !== ZIP ? true : zip(c));
  const flush = () => {
    let progress = true;
    while (progress && pending.length) {
      progress = false;
      const next = [];
      for (const c of pending) { if (O[c] !== ZIP) continue; if (tryZip(c)) progress = true; else next.push(c); }
      pending = next;
    }
  };
  const mark = c => { O[c] = ZIP; pending.push(c); };

  let pos = 0, fails = 0;
  const first = ((opts.firstEdge || 0) % k + k) % k;
  const stack = [3 * first]; // angolo "centro" del triangolo del tappo: il lato opposto e' il primo cancello
  while (stack.length && pos < ops.length) {
    let pc = stack.pop();
    for (;;) {
      if (pos >= ops.length) break;
      const op = ops[pos++];
      const a = addTri(pc), b = a + 1, d = a + 2;
      if (op === 0) { const v = newVert(); realIndex.set(v, N++); V[a] = v; O[b] = GATE; pc = b; continue; }
      V[a] = newVert();
      if (op === 1) { O[b] = GATE; mark(d); flush(); pc = b; continue; }
      if (op === 3) { O[d] = GATE; mark(b); flush(); pc = d; continue; }
      if (op === 4) { O[b] = GATE; O[d] = GATE; stack.push(d); pc = b; continue; }
      if (op === 2) { mark(d); mark(b); flush(); break; }
      fails++; break;
    }
  }
  flush();
  const nt = T - k;
  const tris = new Int32Array(3 * nt);
  const rootReal = new Map();
  for (const [v, idx] of realIndex) rootReal.set(find(v), idx);
  let unresolved = 0, toCenter = 0;
  const cRoot = find(center);
  for (let i = 0; i < 3 * nt; i++) {
    const r = find(V[3 * k + i]);
    if (r === cRoot) toCenter++;
    const idx = rootReal.get(r);
    if (idx === undefined) { unresolved++; tris[i] = -1; } else tris[i] = idx;
  }
  let freeEdges = 0, zipLeftOver = pending.length;
  for (let c = 3 * k; c < 3 * T; c++) if (O[c] === FREE) freeEdges++;
  let capFree = 0;
  for (let i = 0; i < k; i++) if (O[3 * i] === FREE) capFree++;
  return { tris, ntri: nt, nverts: N, unresolved, toCenter, freeEdges, capFree, zipLeftOver, consumed: pos, fails,
    // per la predizione dei punti: triangolo genitore di ciascun nuovo vertice (C) nell'ordine di creazione
    V: V.subarray(0, 3 * T), O: O.subarray(0, 3 * T), k, realIndex, find };
}

/** divide la sequenza in componenti (la pila delle S si svuota a ogni E finale) */
export function splitComponents(ops) {
  const comps = [];
  let start = 0, depth = 1, c = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op === 0) c++;
    else if (op === 4) depth++;
    else if (op === 2) depth--;
    if (depth === 0) {
      const t = i + 1 - start;
      comps.push({ start, end: i + 1, k: t - 2 * c + 2, c });
      start = i + 1; depth = 1; c = 0;
    }
  }
  if (start < ops.length) { const t = ops.length - start; comps.push({ start, end: ops.length, k: Math.max(3, t - 2 * c + 2), c, incomplete: true }); }
  return comps;
}

/**
 * Connettivita' di una shell (piu' componenti). Numerazione dei vertici: per ogni componente prima l'anello iniziale,
 * poi i vertici creati dalle C. Restituisce anche l'ordine di comparsa nella visita (per l'ordine dei punti).
 */
export function decodeShellConnectivity(ops, opts = {}) {
  const comps = splitComponents(ops);
  const tris = [];
  let base = 0, bad = 0;
  for (const cp of comps) {
    const r = decodeConnectivity(ops.subarray(cp.start, cp.end), cp.k, opts);
    if (r.unresolved || r.zipLeftOver) bad++;
    for (let i = 0; i < r.tris.length; i++) tris.push(r.tris[i] < 0 ? -1 : r.tris[i] + base);
    base += r.nverts;
  }
  return { tris: Int32Array.from(tris), nverts: base, comps: comps.length, bad };
}

/** tabella M: indicatori, vertici fittizi (differenze progressive), patch (vecchio relativo, nuovo nella numerazione finale) */
export function readMTable(mt) {
  const md = new DataView(mt.buffer, mt.byteOffset, mt.byteLength);
  if (mt.length < 4) return { flags: 0, dummies: [], patches: [] };
  const flags = md.getInt32(0, true);
  let q = 4;
  const cnt = {};
  for (const [bit, name] of [[1, "ml"], [2, "m2s"], [4, "m2g"], [8, "dum"], [16, "pat"]]) if (flags & bit) { cnt[name] = md.getInt32(q, true); q += 4; }
  const arr = n => { const a = []; for (let i = 0; i < n && q + 4 <= mt.length; i++) { a.push(md.getInt32(q, true)); q += 4; } return a; };
  arr(cnt.ml || 0); arr(cnt.m2s || 0); arr(cnt.m2g || 0);
  const dum = arr(cnt.dum || 0), pat = arr(cnt.pat || 0);
  const dummies = []; let acc = 0;
  for (const d of dum) { acc += d; dummies.push(acc); }
  const patches = []; acc = 0;
  for (let i = 0; i + 1 < pat.length; i += 2) { acc += pat[i]; patches.push([acc, pat[i + 1]]); }
  return { flags, dummies, patches };
}

/**
 * Shell HSF compressa con edgebreaker -> elenco delle facce (formato HOOPS: 3, a, b, c, ...) negli indici dei punti.
 * h: intestazione letta da hsf.js ({ ops, mt, pcount })
 */
export function decodeEdgebreakerShell(h) {
  const conn = decodeShellConnectivity(h.ops);
  const m = readMTable(h.mt);
  const dead = new Uint8Array(conn.nverts);
  for (const d of m.dummies) if (d >= 0 && d < conn.nverts) dead[d] = 1;
  const repl = new Map();
  for (const [o, n] of m.patches) if (o >= 0 && o < conn.nverts) { repl.set(o, n); dead[o] = 2; }
  const map = new Int32Array(conn.nverts);
  let n = 0;
  for (let v = 0; v < conn.nverts; v++) map[v] = dead[v] ? -1 : n++;
  for (const [o, nw] of repl) map[o] = nw;
  const out = [];
  const t = conn.tris;
  for (let i = 0; i + 2 < t.length; i += 3) {
    if (t[i] < 0 || t[i + 1] < 0 || t[i + 2] < 0) continue;
    if (dead[t[i]] === 1 || dead[t[i + 1]] === 1 || dead[t[i + 2]] === 1) continue; // triangoli dei vertici fittizi
    const a = map[t[i]], b = map[t[i + 1]], c = map[t[i + 2]];
    if (a < 0 || b < 0 || c < 0 || a === b || b === c || a === c) continue;
    out.push(3, a, b, c);
  }
  return { faces: Int32Array.from(out), strips: false, pcount: n, bad: conn.bad, mismatch: n !== h.pcount };
}
