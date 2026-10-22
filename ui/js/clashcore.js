// Verifica delle interferenze (Clash Detective): motore geometrico puro, senza DOM e senza three.js.
// Gira nel Web Worker (ui/js/clashworker.js) e nel collaudo con Node (tests/test_clash.mjs).
//   elemento = { id, pos: Float32Array (x, y, z per vertice, coordinate della scena), idx: Uint32Array (3 indici per triangolo),
//                model (indice del modello federato), inA, inB (appartenenza agli insiemi) }
// Fase larga: ordinamento e scorrimento degli ingombri. Fase stretta: un BVH di triangoli per elemento, costruito solo
// quando l'elemento entra in una coppia candidata.
//   compenetrazione ("hard"): le superfici si tagliano (triangolo-triangolo) o un elemento sta dentro l'altro; profondita' =
//     massima distanza dalla superficie dell'altro dei punti che gli stanno dentro (vertici e tratti degli spigoli che lo
//     attraversano); interferenza se profondita' > tolleranza.
//   distanza minima ("clearance"): distanza tra le superfici < distanza richiesta (0 se si toccano o compenetrano).
//   duplicati ("duplicate"): stesso ingombro e superfici che coincidono entro la tolleranza.

const LEAF = 6;

// ---------------------------------------------------------------- preparazione e BVH
export function prepare(e) {
  const p = e.pos;
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y; if (z < box[2]) box[2] = z;
    if (x > box[3]) box[3] = x; if (y > box[4]) box[4] = y; if (z > box[5]) box[5] = z;
  }
  e.box = box;
  e.nTri = (e.idx.length / 3) | 0;
  e.bvh = null;
  return e;
}

export function buildBVH(e) {
  if (e.bvh) return e.bvh;
  const { pos, idx } = e, n = e.nTri;
  const tb = new Float64Array(n * 6), cen = new Float64Array(n * 3);
  for (let t = 0; t < n; t++) {
    const a = idx[3 * t] * 3, b = idx[3 * t + 1] * 3, c = idx[3 * t + 2] * 3;
    for (let k = 0; k < 3; k++) {
      const va = pos[a + k], vb = pos[b + k], vc = pos[c + k];
      tb[6 * t + k] = Math.min(va, vb, vc);
      tb[6 * t + 3 + k] = Math.max(va, vb, vc);
      cen[3 * t + k] = (va + vb + vc) / 3;
    }
  }
  const order = new Uint32Array(n);
  for (let t = 0; t < n; t++) order[t] = t;
  const cap = Math.max(1, 2 * Math.ceil(n / LEAF) + 1) * 2;
  let bb = new Float64Array(cap * 6), L = new Int32Array(cap), S = new Int32Array(cap), C = new Int32Array(cap);
  let count = 0;
  const alloc = () => {
    if (count >= L.length) {
      const grow = (A, k) => { const B = new A.constructor(A.length * 2); B.set(A); return B; };
      bb = grow(bb); L = grow(L); S = grow(S); C = grow(C);
    }
    return count++;
  };
  const stack = [alloc(), 0, n];
  while (stack.length) {
    const end = stack.pop(), start = stack.pop(), node = stack.pop();
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
    for (let i = start; i < end; i++) {
      const t = order[i], o = 6 * t;
      if (tb[o] < x0) x0 = tb[o]; if (tb[o + 1] < y0) y0 = tb[o + 1]; if (tb[o + 2] < z0) z0 = tb[o + 2];
      if (tb[o + 3] > x1) x1 = tb[o + 3]; if (tb[o + 4] > y1) y1 = tb[o + 4]; if (tb[o + 5] > z1) z1 = tb[o + 5];
      const c = 3 * t;
      if (cen[c] < cx0) cx0 = cen[c]; if (cen[c + 1] < cy0) cy0 = cen[c + 1]; if (cen[c + 2] < cz0) cz0 = cen[c + 2];
      if (cen[c] > cx1) cx1 = cen[c]; if (cen[c + 1] > cy1) cy1 = cen[c + 1]; if (cen[c + 2] > cz1) cz1 = cen[c + 2];
    }
    const o = node * 6;
    bb[o] = x0; bb[o + 1] = y0; bb[o + 2] = z0; bb[o + 3] = x1; bb[o + 4] = y1; bb[o + 5] = z1;
    const ex = cx1 - cx0, ey = cy1 - cy0, ez = cz1 - cz0;
    if (end - start <= LEAF || Math.max(ex, ey, ez) <= 0) { L[node] = -1; S[node] = start; C[node] = end - start; continue; }
    const ax = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    order.subarray(start, end).sort((a, b) => cen[3 * a + ax] - cen[3 * b + ax]);
    const mid = (start + end) >> 1;
    const left = alloc();
    alloc(); // il figlio destro e' sempre left + 1
    L[node] = left; C[node] = 0;
    stack.push(left, start, mid, left + 1, mid, end);
  }
  e.bvh = { bb, L, S, C, order };
  return e.bvh;
}

// vertici del triangolo t dell'elemento e in out (9 numeri)
function tri(e, t, out) {
  const { pos, idx } = e;
  const a = idx[3 * t] * 3, b = idx[3 * t + 1] * 3, c = idx[3 * t + 2] * 3;
  out[0] = pos[a]; out[1] = pos[a + 1]; out[2] = pos[a + 2];
  out[3] = pos[b]; out[4] = pos[b + 1]; out[5] = pos[b + 2];
  out[6] = pos[c]; out[7] = pos[c + 1]; out[8] = pos[c + 2];
  return out;
}

// ---------------------------------------------------------------- primitive geometriche
const boxOverlap = (a, i, b, j, m) => a[i] <= b[j + 3] + m && a[i + 3] >= b[j] - m && a[i + 1] <= b[j + 4] + m && a[i + 4] >= b[j + 1] - m && a[i + 2] <= b[j + 5] + m && a[i + 5] >= b[j + 2] - m;
function boxDist2(a, i, b, j) {
  let d = 0;
  for (let k = 0; k < 3; k++) {
    const g = Math.max(b[j + k] - a[i + 3 + k], a[i + k] - b[j + 3 + k], 0);
    d += g * g;
  }
  return d;
}
function pointBoxDist2(p, b, j) {
  let d = 0;
  for (let k = 0; k < 3; k++) { const g = Math.max(b[j + k] - p[k], p[k] - b[j + 3 + k], 0); d += g * g; }
  return d;
}

// segmento P->Q contro triangolo T (Moller-Trumbore): parametro t del punto di passaggio, -1 se non lo attraversa.
// Gli estremi del segmento non contano (elementi appoggiati non si compenetrano).
function segTri(px, py, pz, qx, qy, qz, T) {
  const dx = qx - px, dy = qy - py, dz = qz - pz;
  const e1x = T[3] - T[0], e1y = T[4] - T[1], e1z = T[5] - T[2];
  const e2x = T[6] - T[0], e2y = T[7] - T[1], e2z = T[8] - T[2];
  const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  const scale = Math.sqrt((dx * dx + dy * dy + dz * dz) * (e1x * e1x + e1y * e1y + e1z * e1z) * (e2x * e2x + e2y * e2y + e2z * e2z)) || 1;
  if (Math.abs(det) <= 1e-12 * scale) return -1; // parallelo al piano (anche complanare: contatto, non compenetrazione)
  const f = 1 / det;
  const sx = px - T[0], sy = py - T[1], sz = pz - T[2];
  const u = f * (sx * hx + sy * hy + sz * hz);
  if (u < -1e-9 || u > 1 + 1e-9) return -1;
  const qqx = sy * e1z - sz * e1y, qqy = sz * e1x - sx * e1z, qqz = sx * e1y - sy * e1x;
  const v = f * (dx * qqx + dy * qqy + dz * qqz);
  if (v < -1e-9 || u + v > 1 + 1e-9) return -1;
  const t = f * (e2x * qqx + e2y * qqy + e2z * qqz);
  return t > 1e-7 && t < 1 - 1e-7 ? t : -1;
}

// il raggio p + s*d (s > 0) attraversa il triangolo T?
function rayTri(p, d, T) {
  const e1x = T[3] - T[0], e1y = T[4] - T[1], e1z = T[5] - T[2], e2x = T[6] - T[0], e2y = T[7] - T[1], e2z = T[8] - T[2];
  const hx = d[1] * e2z - d[2] * e2y, hy = d[2] * e2x - d[0] * e2z, hz = d[0] * e2y - d[1] * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(det) <= 1e-14 * Math.sqrt((e1x * e1x + e1y * e1y + e1z * e1z) * (e2x * e2x + e2y * e2y + e2z * e2z))) return false;
  const f = 1 / det, sx = p[0] - T[0], sy = p[1] - T[1], sz = p[2] - T[2];
  const u = f * (sx * hx + sy * hy + sz * hz);
  if (u < 0 || u > 1) return false;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = f * (d[0] * qx + d[1] * qy + d[2] * qz);
  if (v < 0 || u + v > 1) return false;
  return f * (e2x * qx + e2y * qy + e2z * qz) > 1e-12;
}

// tutti i vertici di B dallo stesso lato del piano di A (o sul piano): nessun taglio
function sideReject(A, B) {
  const e1x = A[3] - A[0], e1y = A[4] - A[1], e1z = A[5] - A[2], e2x = A[6] - A[0], e2y = A[7] - A[1], e2z = A[8] - A[2];
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const nl = Math.hypot(nx, ny, nz);
  if (nl === 0) return true; // triangolo degenere
  const d = nx * A[0] + ny * A[1] + nz * A[2];
  const eps = 1e-9 * nl * (1 + Math.abs(A[0]) + Math.abs(A[1]) + Math.abs(A[2]));
  let pos = 0, neg = 0;
  for (let k = 0; k < 9; k += 3) {
    const s = nx * B[k] + ny * B[k + 1] + nz * B[k + 2] - d;
    if (s > eps) pos++; else if (s < -eps) neg++;
  }
  return !(pos && neg);
}

// punti in cui gli spigoli di un triangolo attraversano l'altro; cb(lato, i, j, t, x, y, z) per ogni passaggio
function triTri(A, B, cb) {
  if (sideReject(A, B) || sideReject(B, A)) return 0;
  let n = 0;
  for (let s = 0; s < 2; s++) {
    const P = s ? B : A, T = s ? A : B;
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3, a = 3 * i, b = 3 * j;
      const t = segTri(P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], T);
      if (t < 0) continue;
      n++;
      cb?.(s, i, j, t, P[a] + (P[b] - P[a]) * t, P[a + 1] + (P[b + 1] - P[a + 1]) * t, P[a + 2] + (P[b + 2] - P[a + 2]) * t);
    }
  }
  return n;
}

// punto del triangolo T piu' vicino a p (Ericson, Real-Time Collision Detection 5.1.5); scrive in out, restituisce d^2
function closestOnTri(p, T, out) {
  const ax = T[0], ay = T[1], az = T[2];
  const abx = T[3] - ax, aby = T[4] - ay, abz = T[5] - az, acx = T[6] - ax, acy = T[7] - ay, acz = T[8] - az;
  const apx = p[0] - ax, apy = p[1] - ay, apz = p[2] - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const set = (x, y, z) => { out[0] = x; out[1] = y; out[2] = z; const dx = p[0] - x, dy = p[1] - y, dz = p[2] - z; return dx * dx + dy * dy + dz * dz; };
  if (d1 <= 0 && d2 <= 0) return set(ax, ay, az);
  const bpx = p[0] - T[3], bpy = p[1] - T[4], bpz = p[2] - T[5];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set(T[3], T[4], T[5]);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return set(ax + abx * v, ay + aby * v, az + abz * v); }
  const cpx = p[0] - T[6], cpy = p[1] - T[7], cpz = p[2] - T[8];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set(T[6], T[7], T[8]);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return set(ax + acx * w, ay + acy * w, az + acz * w); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return set(T[3] + (T[6] - T[3]) * w, T[4] + (T[7] - T[4]) * w, T[5] + (T[8] - T[5]) * w);
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return set(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

// punti piu' vicini tra i segmenti P1Q1 e P2Q2 (Ericson 5.1.9); restituisce d^2, punti in c1 e c2
function segSeg(p1, q1, p2, q2, c1, c2) {
  const d1 = [q1[0] - p1[0], q1[1] - p1[1], q1[2] - p1[2]], d2 = [q2[0] - p2[0], q2[1] - p2[1], q2[2] - p2[2]];
  const r = [p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s, t;
  if (a <= 1e-18 && e <= 1e-18) { s = t = 0; }
  else if (a <= 1e-18) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = dot(d1, r);
    if (e <= 1e-18) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den > 1e-18 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  for (let k = 0; k < 3; k++) { c1[k] = p1[k] + d1[k] * s; c2[k] = p2[k] + d2[k] * t; }
  return (c1[0] - c2[0]) ** 2 + (c1[1] - c2[1]) ** 2 + (c1[2] - c2[2]) ** 2;
}

// distanza tra due triangoli (0 se si tagliano); punti piu' vicini in pa e pb
const _v = [0, 0, 0], _w = [0, 0, 0], _c1 = [0, 0, 0], _c2 = [0, 0, 0], _o = [0, 0, 0];
function triTriDist2(A, B, pa, pb) {
  let hit = null;
  if (triTri(A, B, (s, i, j, t, x, y, z) => { hit ??= [x, y, z]; })) { pa[0] = pb[0] = hit[0]; pa[1] = pb[1] = hit[1]; pa[2] = pb[2] = hit[2]; return 0; }
  let best = Infinity;
  for (let s = 0; s < 2; s++) {
    const P = s ? B : A, T = s ? A : B;
    for (let k = 0; k < 9; k += 3) {
      _v[0] = P[k]; _v[1] = P[k + 1]; _v[2] = P[k + 2];
      const d = closestOnTri(_v, T, _o);
      if (d < best) { best = d; const [qa, qb] = s ? [_o, _v] : [_v, _o]; pa[0] = qa[0]; pa[1] = qa[1]; pa[2] = qa[2]; pb[0] = qb[0]; pb[1] = qb[1]; pb[2] = qb[2]; }
    }
  }
  const pA = [[A[0], A[1], A[2]], [A[3], A[4], A[5]], [A[6], A[7], A[8]]], pB = [[B[0], B[1], B[2]], [B[3], B[4], B[5]], [B[6], B[7], B[8]]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const d = segSeg(pA[i], pA[(i + 1) % 3], pB[j], pB[(j + 1) % 3], _c1, _c2);
    if (d < best) { best = d; pa[0] = _c1[0]; pa[1] = _c1[1]; pa[2] = _c1[2]; pb[0] = _c2[0]; pb[1] = _c2[1]; pb[2] = _c2[2]; }
  }
  return best;
}

// ---------------------------------------------------------------- interrogazioni del BVH
// coppie di triangoli con gli ingombri sovrapposti (entro il margine m)
function pairs(A, B, m, cb) {
  const a = buildBVH(A), b = buildBVH(B);
  const st = [0, 0];
  while (st.length) {
    const j = st.pop(), i = st.pop();
    if (!boxOverlap(a.bb, 6 * i, b.bb, 6 * j, m)) continue;
    const la = a.L[i] < 0, lb = b.L[j] < 0;
    if (la && lb) {
      for (let x = 0; x < a.C[i]; x++) for (let y = 0; y < b.C[j]; y++) if (cb(a.order[a.S[i] + x], b.order[b.S[j] + y]) === false) return;
    } else if (lb || (!la && a.C[i] === 0 && volume(a.bb, i) >= volume(b.bb, j))) st.push(a.L[i], j, a.L[i] + 1, j);
    else st.push(i, b.L[j], i, b.L[j] + 1);
  }
}
const volume = (bb, i) => (bb[6 * i + 3] - bb[6 * i]) + (bb[6 * i + 4] - bb[6 * i + 1]) + (bb[6 * i + 5] - bb[6 * i + 2]);

// numero di triangoli attraversati da un raggio (per sapere se un punto sta dentro un solido chiuso)
const _T = new Float64Array(9), _T2 = new Float64Array(9);
function rayCount(E, p, d) {
  const b = buildBVH(E);
  const inv = [1 / d[0], 1 / d[1], 1 / d[2]];
  let n = 0;
  const st = [0];
  while (st.length) {
    const i = st.pop(), o = 6 * i;
    let t0 = 0, t1 = Infinity;
    for (let k = 0; k < 3; k++) {
      let ta = (b.bb[o + k] - p[k]) * inv[k], tb = (b.bb[o + 3 + k] - p[k]) * inv[k];
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    }
    if (t0 > t1) continue;
    if (b.L[i] >= 0) { st.push(b.L[i], b.L[i] + 1); continue; }
    for (let x = 0; x < b.C[i]; x++) {
      tri(E, b.order[b.S[i] + x], _T);
      if (rayTri(p, d, _T)) n++;
    }
  }
  return n;
}
// tre raggi in direzioni "storte" (mai parallele alle facce tipiche) e voto a maggioranza: regge anche le mesh non perfette
const RAYS = [[0.5773, 0.5821, 0.5727], [-0.6211, 0.4402, -0.6484], [0.3311, -0.8547, 0.3998]];
export function inside(E, p) {
  if (p[0] < E.box[0] || p[1] < E.box[1] || p[2] < E.box[2] || p[0] > E.box[3] || p[1] > E.box[4] || p[2] > E.box[5]) return false;
  let odd = 0;
  for (const d of RAYS) if (rayCount(E, p, d) & 1) odd++;
  return odd >= 2;
}

// distanza di p dalla superficie di E (entro maxD; Infinity se piu' lontana); punto piu' vicino in out
export function surfaceDist(E, p, maxD = Infinity, out = [0, 0, 0]) {
  const b = buildBVH(E);
  let best = maxD * maxD;
  let found = false;
  const st = [0];
  while (st.length) {
    const i = st.pop();
    if (pointBoxDist2(p, b.bb, 6 * i) >= best) continue;
    if (b.L[i] >= 0) {
      const l = b.L[i], r = l + 1;
      // prima il figlio piu' vicino (finisce in cima alla pila)
      if (pointBoxDist2(p, b.bb, 6 * l) < pointBoxDist2(p, b.bb, 6 * r)) st.push(r, l); else st.push(l, r);
      continue;
    }
    for (let x = 0; x < b.C[i]; x++) {
      const d = closestOnTri(p, tri(E, b.order[b.S[i] + x], _T), _o);
      if (d < best) { best = d; found = true; out[0] = _o[0]; out[1] = _o[1]; out[2] = _o[2]; }
    }
  }
  return found ? Math.sqrt(best) : Infinity;
}

// distanza minima tra le superfici di A e B (se minore di maxD); punti in pa e pb
export function minDistance(A, B, maxD) {
  const a = buildBVH(A), b = buildBVH(B);
  let best = maxD * maxD, found = false;
  const pa = [0, 0, 0], pb = [0, 0, 0], ra = [0, 0, 0], rb = [0, 0, 0];
  const st = [0, 0];
  while (st.length) {
    const j = st.pop(), i = st.pop();
    const bd = boxDist2(a.bb, 6 * i, b.bb, 6 * j);
    if (found ? bd >= best : bd > best) continue;
    const la = a.L[i] < 0, lb = b.L[j] < 0;
    if (la && lb) {
      for (let x = 0; x < a.C[i]; x++) {
        tri(A, a.order[a.S[i] + x], _T);
        for (let y = 0; y < b.C[j]; y++) {
          const d = triTriDist2(_T, tri(B, b.order[b.S[j] + y], _T2), pa, pb);
          if (d < best || (!found && d <= best)) { best = d; found = true; ra.splice(0, 3, ...pa); rb.splice(0, 3, ...pb); if (d === 0) return { d: 0, pa: ra, pb: rb }; }
        }
      }
    } else {
      const kids = [];
      if (lb || (!la && volume(a.bb, i) >= volume(b.bb, j))) kids.push([a.L[i], j], [a.L[i] + 1, j]);
      else kids.push([i, b.L[j]], [i, b.L[j] + 1]);
      // la coppia piu' vicina esce per prima dalla pila: la distanza migliore scende presto e taglia il resto
      kids.sort((u, v) => boxDist2(a.bb, 6 * v[0], b.bb, 6 * v[1]) - boxDist2(a.bb, 6 * u[0], b.bb, 6 * u[1]));
      for (const [x, y] of kids) st.push(x, y);
    }
  }
  return found ? { d: Math.sqrt(best), pa: ra, pb: rb } : null;
}

// ---------------------------------------------------------------- i tre tipi di verifica su una coppia
const boxInside = (a, b, m = 0) => a[0] >= b[0] - m && a[1] >= b[1] - m && a[2] >= b[2] - m && a[3] <= b[3] + m && a[4] <= b[4] + m && a[5] <= b[5] + m;
const firstVertex = E => [E.pos[0], E.pos[1], E.pos[2]];

// punti di X da controllare (vertici dentro l'ingombro di Y, al massimo cap, distribuiti su tutto l'elemento)
function vertexSamples(X, box, cap) {
  const out = [], p = X.pos, n = p.length / 3;
  const inBox = i => p[i] >= box[0] && p[i] <= box[3] && p[i + 1] >= box[1] && p[i + 1] <= box[4] && p[i + 2] >= box[2] && p[i + 2] <= box[5];
  let cnt = 0;
  for (let v = 0; v < n; v++) if (inBox(3 * v)) cnt++;
  const step = Math.max(1, Math.ceil(cnt / cap));
  let k = 0;
  for (let v = 0; v < n; v++) if (inBox(3 * v) && k++ % step === 0) out.push([p[3 * v], p[3 * v + 1], p[3 * v + 2]]);
  return out;
}

// massima profondita' dentro Y dei punti campione (0 se nessuno sta dentro)
function depthOf(Y, samples) {
  let best = 0;
  for (const s of samples) {
    if (!inside(Y, s)) continue;
    const d = surfaceDist(Y, s);
    if (d < Infinity && d > best) best = d;
  }
  return best;
}

export function hardClash(A, B, tol) {
  // passaggi degli spigoli: per ogni spigolo i parametri t in cui attraversa l'altro elemento
  const cross = [new Map(), new Map()];
  let sx = 0, sy = 0, sz = 0, np = 0;
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  pairs(A, B, 0, (ta, tb) => {
    tri(A, ta, _T); tri(B, tb, _T2);
    triTri(_T, _T2, (s, i, j, t, x, y, z) => {
      const E = s ? B : A, tt = s ? tb : ta;
      const vi = E.idx[3 * tt + i], vj = E.idx[3 * tt + j];
      const key = vi < vj ? vi * 4294967296 + vj : vj * 4294967296 + vi;
      const m = cross[s];
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(vi < vj ? t : 1 - t);
      sx += x; sy += y; sz += z; np++;
      if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y; if (z < box[2]) box[2] = z;
      if (x > box[3]) box[3] = x; if (y > box[4]) box[4] = y; if (z > box[5]) box[5] = z;
    });
  });
  if (np) {
    // campioni: centro di ogni tratto di spigolo tra due passaggi, estremi degli spigoli attraversati, vertici dentro l'ingombro
    let depth = 0;
    for (let s = 0; s < 2; s++) {
      const X = s ? B : A, Y = s ? A : B;
      const samples = [];
      let edges = 0;
      for (const [key, ts] of cross[s]) {
        if (edges++ > 4000) break;
        const vi = Math.floor(key / 4294967296), vj = key % 4294967296;
        const p = X.pos, P = [p[3 * vi], p[3 * vi + 1], p[3 * vi + 2]], Q = [p[3 * vj], p[3 * vj + 1], p[3 * vj + 2]];
        const all = [0, ...ts.sort((u, v) => u - v), 1];
        for (let k = 0; k + 1 < all.length; k++) {
          if (all[k + 1] - all[k] < 1e-9) continue;
          const t = (all[k] + all[k + 1]) / 2;
          samples.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t, P[2] + (Q[2] - P[2]) * t]);
        }
        samples.push(P, Q);
      }
      samples.push(...vertexSamples(X, Y.box, 600));
      depth = Math.max(depth, depthOf(Y, samples));
    }
    if (depth <= tol) return null;
    return { dist: depth, point: [sx / np, sy / np, sz / np], box };
  }
  // nessun taglio delle superfici: un elemento tutto dentro l'altro?
  for (const [X, Y] of [[A, B], [B, A]]) {
    if (!boxInside(X.box, Y.box) || !inside(Y, firstVertex(X))) continue;
    const depth = depthOf(Y, vertexSamples(X, Y.box, 600));
    if (depth <= tol) return null;
    const b = X.box;
    return { dist: depth, point: [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2], box: b.slice(), inside: true };
  }
  return null;
}

export function clearanceClash(A, B, clear) {
  const r = minDistance(A, B, clear);
  if (r && r.d < clear) {
    const point = [(r.pa[0] + r.pb[0]) / 2, (r.pa[1] + r.pb[1]) / 2, (r.pa[2] + r.pb[2]) / 2];
    return { dist: r.d, point, pa: r.pa, pb: r.pb };
  }
  for (const [X, Y] of [[A, B], [B, A]]) {
    if (boxInside(X.box, Y.box) && inside(Y, firstVertex(X))) { const b = X.box; return { dist: 0, point: [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2], inside: true }; }
  }
  return null;
}

export function duplicateClash(A, B, tol) {
  for (let k = 0; k < 6; k++) if (Math.abs(A.box[k] - B.box[k]) > tol) return null;
  let dev = 0;
  for (const [X, Y] of [[A, B], [B, A]]) {
    for (const s of vertexSamples(X, [-Infinity, -Infinity, -Infinity, Infinity, Infinity, Infinity], 300)) {
      const d = surfaceDist(Y, s, tol * 1.0001 + 1e-12);
      if (d === Infinity) return null;
      dev = Math.max(dev, d);
    }
  }
  const b = A.box;
  return { dist: dev, point: [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2] };
}

// ---------------------------------------------------------------- verifica completa
// opts = { type: "hard"|"clearance"|"duplicate", tolerance, skipSameModel, maxResults }
// onProgress(frazione, coppieControllate, interferenzeTrovate) viene chiamato al massimo ogni ~150 ms
export function runTest(elements, opts, onProgress) {
  const type = opts.type || "hard";
  const tol = Math.max(0, +opts.tolerance || 0);
  const margin = type === "clearance" ? tol : type === "duplicate" ? tol : 0;
  const maxResults = opts.maxResults || 20000;
  const els = elements.filter(e => e.nTri > 0 && (e.inA || e.inB) && isFinite(e.box[0]));
  els.sort((a, b) => a.box[0] - b.box[0]);
  // fase larga: ordinamento lungo X e scorrimento
  const cand = [];
  const active = [];
  for (const e of els) {
    const x0 = e.box[0] - margin;
    for (let k = active.length - 1; k >= 0; k--) if (active[k].box[3] < x0) active.splice(k, 1);
    for (const f of active) {
      if (!((e.inA && f.inB) || (e.inB && f.inA))) continue;
      if (opts.skipSameModel && e.model === f.model) continue;
      if (!boxOverlap(e.box, 0, f.box, 0, margin)) continue;
      cand.push(f.inA && e.inB ? [f, e] : [e, f]);
    }
    active.push(e);
  }
  const out = [];
  let last = 0;
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  for (let i = 0; i < cand.length; i++) {
    const [a, b] = cand[i];
    if (onProgress && now() - last > 150) { last = now(); onProgress(i / cand.length, i, out.length); }
    let r = null;
    if (type === "hard") r = hardClash(a, b, tol);
    else if (type === "clearance") r = clearanceClash(a, b, tol);
    else r = duplicateClash(a, b, tol);
    if (r) { out.push({ a: a.id, b: b.id, ...r }); if (out.length >= maxResults) break; }
  }
  onProgress?.(1, cand.length, out.length);
  return { results: out, candidates: cand.length, elements: els.length };
}

// raggruppamento delle interferenze vicine: stesso gruppo se i punti distano meno di radius (catena di vicinanza)
export function groupClashes(points, radius) {
  const n = points.length, parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  if (radius > 0) {
    const cell = new Map(), key = (x, y, z) => x + "," + y + "," + z;
    points.forEach((p, i) => {
      const cx = Math.floor(p[0] / radius), cy = Math.floor(p[1] / radius), cz = Math.floor(p[2] / radius);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        for (const j of cell.get(key(cx + dx, cy + dy, cz + dz)) || []) {
          const q = points[j];
          if ((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2 <= radius * radius) parent[find(i)] = find(j);
        }
      }
      const k = key(cx, cy, cz);
      if (!cell.has(k)) cell.set(k, []);
      cell.get(k).push(i);
    });
  }
  // numeri di gruppo nell'ordine di comparsa; -1 = interferenza da sola
  const size = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); size.set(r, (size.get(r) || 0) + 1); }
  const num = new Map();
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (size.get(r) < 2) { out[i] = -1; continue; }
    if (!num.has(r)) num.set(r, num.size);
    out[i] = num.get(r);
  }
  return out;
}

// ---------------------------------------------------------------- stati tra un'esecuzione e l'altra (come Navisworks)
// nuova = trovata ora per la prima volta; attiva = trovata di nuovo; rivista e approvata = decise dall'utente, restano;
// risolta = non c'e' piu' (resta nell'elenco finche' non si compatta il test)
export const STATUSES = ["new", "active", "reviewed", "approved", "resolved"];
// prev = interferenze del test, found = risultati nuovi con { key, ... }; restituisce l'elenco aggiornato (numeri stabili)
export function mergeRun(prev, found, date) {
  const old = new Map(prev.map(c => [c.key, c]));
  let next = prev.reduce((m, c) => Math.max(m, c.num || 0), 0) + 1;
  const out = [];
  for (const f of found) {
    const o = old.get(f.key);
    if (o) {
      old.delete(f.key);
      out.push({ ...o, ...f, num: o.num, found: o.found, status: o.status === "new" || o.status === "resolved" ? "active" : o.status, resolvedAt: undefined });
    } else out.push({ ...f, num: next++, found: date, status: "new" });
  }
  for (const o of old.values()) out.push({ ...o, status: "resolved", resolvedAt: o.status === "resolved" && o.resolvedAt ? o.resolvedAt : date });
  return out.sort((a, b) => a.num - b.num);
}
