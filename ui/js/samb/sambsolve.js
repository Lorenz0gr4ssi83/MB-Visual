// SAMB - risolutore statico delle tubazioni. Puro, senza DOM (tests/test_samb.mjs). Unita': N, mm, MPa, radianti.
// Elementi trave di Timoshenko a 12 gradi di liberta'; curve = corde con I/k (fattore di flessibilita'), matrice a banda
// con nodi riordinati (Cuthill-McKee inverso), vincoli come molle lungo una direzione (rigidi = RIGID_T / RIGID_R), vincoli
// monodirezionali con iterazione sullo stato attivo.
//   model = { nodes: [{ id, p: [x,y,z] }], elems: [{ i, j, A, Iy, Iz, J, E, G, Asy, Asz, k, w, eps, vz }], point: [{ node, f: [6] }],
//             restraints: [{ node, dof: "t"|"r", d: [x,y,z], k, oneWay }] }
//   k = flessibilita' (divide I), w = peso per unita' di lunghezza (N/mm, verso -Y), eps = dilatazione libera, vz = normale locale.
export const RIGID_T = 1e12, RIGID_R = 1e15;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a); return a.map(v => v / l); };

// assi locali: x lungo l'elemento; z = vz se data (normale al piano della curva), altrimenti orizzontale
export function axes(e, nodes) {
  const a = nodes[e.i].p, b = nodes[e.j].p, d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(...d);
  if (!(L > 0)) throw new Error("zero_length");
  const x = d.map(v => v / L);
  let z = e.vz;
  if (!z) { z = cross(x, [0, 1, 0]); if (Math.hypot(...z) < 1e-6) z = cross(x, [1, 0, 0]); }
  z = norm(z);
  const y = norm(cross(z, x));
  z = cross(x, y);
  return { L, x, y, z };
}

// rigidezza locale di Timoshenko (ux uy uz rx ry rz, nodo i poi nodo j)
export function localK(e, L, shear = true) {
  const k = e.k || 1, Iy = e.Iy / k, Iz = e.Iz / k, E = e.E, G = e.G;
  const py = shear && e.Asy ? 12 * E * Iz / (G * e.Asy * L * L) : 0, pz = shear && e.Asz ? 12 * E * Iy / (G * e.Asz * L * L) : 0;
  const K = Array.from({ length: 12 }, () => new Float64Array(12));
  const set = (a, b, v) => { K[a][b] += v; if (a !== b) K[b][a] += v; };
  const ax = E * e.A / L, t = G * e.J / L;
  set(0, 0, ax); set(6, 6, ax); set(0, 6, -ax);
  set(3, 3, t); set(9, 9, t); set(3, 9, -t);
  // flessione nel piano x-y (attorno a z)
  let c = E * Iz / (L * L * L * (1 + py));
  set(1, 1, 12 * c); set(7, 7, 12 * c); set(1, 7, -12 * c);
  set(1, 5, 6 * L * c); set(1, 11, 6 * L * c); set(5, 7, -6 * L * c); set(7, 11, -6 * L * c);
  set(5, 5, (4 + py) * L * L * c); set(11, 11, (4 + py) * L * L * c); set(5, 11, (2 - py) * L * L * c);
  // flessione nel piano x-z (attorno a y)
  c = E * Iy / (L * L * L * (1 + pz));
  set(2, 2, 12 * c); set(8, 8, 12 * c); set(2, 8, -12 * c);
  set(2, 4, -6 * L * c); set(2, 10, -6 * L * c); set(4, 8, 6 * L * c); set(8, 10, 6 * L * c);
  set(4, 4, (4 + pz) * L * L * c); set(10, 10, (4 + pz) * L * L * c); set(4, 10, (2 - pz) * L * L * c);
  return K;
}

// azioni nodali equivalenti in assi locali: peso uniforme e dilatazione impedita
function localLoad(e, ax, { weight, thermal }) {
  const f = new Float64Array(12), L = ax.L;
  if (weight && e.w) {
    const g = [0, -e.w, 0], qx = dot(g, ax.x), qy = dot(g, ax.y), qz = dot(g, ax.z);
    f[0] = f[6] = qx * L / 2; f[1] = f[7] = qy * L / 2; f[2] = f[8] = qz * L / 2;
    f[4] = -qz * L * L / 12; f[10] = qz * L * L / 12;
    f[5] = qy * L * L / 12; f[11] = -qy * L * L / 12;
  }
  if (thermal && e.eps) { const N = e.E * e.A * e.eps; f[0] -= N; f[6] += N; }
  return f;
}

// numerazione dei nodi con banda piccola
function ordering(n, elems) {
  const adj = Array.from({ length: n }, () => []);
  for (const e of elems) { adj[e.i].push(e.j); adj[e.j].push(e.i); }
  const seen = new Uint8Array(n), order = [];
  const starts = [...Array(n).keys()].sort((a, b) => adj[a].length - adj[b].length);
  for (const s of starts) {
    if (seen[s]) continue;
    seen[s] = 1;
    const q = [s];
    for (let h = 0; h < q.length; h++) {
      order.push(q[h]);
      for (const v of [...adj[q[h]]].sort((a, b) => adj[a].length - adj[b].length)) if (!seen[v]) { seen[v] = 1; q.push(v); }
    }
  }
  order.reverse();
  const pos = new Int32Array(n);
  order.forEach((v, i) => (pos[v] = i));
  let band = 0;
  for (const e of elems) band = Math.max(band, Math.abs(pos[e.i] - pos[e.j]));
  return { pos, half: 6 * (band + 1) - 1 };
}

// LDL^T a banda (parte inferiore per colonne)
function factor(A, n, b) {
  const w = b + 1;
  for (let j = 0; j < n; j++) {
    const lo = Math.max(0, j - b);
    let d = A[j * w];
    for (let k = lo; k < j; k++) { const l = A[k * w + j - k]; d -= l * l * A[k * w]; }
    if (!(d > 1e-9)) return j;
    A[j * w] = d;
    const hi = Math.min(n - 1, j + b);
    for (let i = j + 1; i <= hi; i++) {
      let v = A[j * w + i - j];
      for (let k = Math.max(0, i - b); k < j; k++) v -= A[k * w + i - k] * A[k * w + j - k] * A[k * w];
      A[j * w + i - j] = v / d;
    }
  }
  return -1;
}
function backsolve(A, n, b, r) {
  const w = b + 1;
  for (let j = 0; j < n; j++) { const v = r[j], hi = Math.min(n - 1, j + b); if (v) for (let i = j + 1; i <= hi; i++) r[i] -= A[j * w + i - j] * v; }
  for (let j = 0; j < n; j++) r[j] /= A[j * w];
  for (let j = n - 1; j >= 0; j--) { const hi = Math.min(n - 1, j + b); let v = r[j]; for (let i = j + 1; i <= hi; i++) v -= A[j * w + i - j] * r[i]; r[j] = v; }
  return r;
}

// Prepara i dati che non cambiano tra i casi di carico.
export function prepare(model, { shear = true } = {}) {
  const { nodes, elems } = model, n = nodes.length;
  const { pos, half } = ordering(n, elems);
  const data = elems.map(e => {
    const ax = axes(e, nodes), kl = localK(e, ax.L, shear);
    const R = [ax.x, ax.y, ax.z];
    return { e, ax, kl, R };
  });
  const N = 6 * n, w = half + 1, K0 = new Float64Array(N * w);
  const dofs = e => { const a = pos[e.i] * 6, b = pos[e.j] * 6; return [a, a + 1, a + 2, a + 3, a + 4, a + 5, b, b + 1, b + 2, b + 3, b + 4, b + 5]; };
  for (const d of data) {
    const T = transform(d.R), G = mulTKT(T, d.kl), id = dofs(d.e);
    for (let a = 0; a < 12; a++) for (let b = 0; b < 12; b++) {
      const i = id[a], j = id[b];
      if (i >= j) K0[j * w + i - j] += G[a][b];
    }
    d.T = T; d.dofs = id;
  }
  return { model, pos, half, K0, N, data };
}

function transform(R) {
  const T = Array.from({ length: 12 }, () => new Float64Array(12));
  for (let b = 0; b < 4; b++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) T[b * 3 + i][b * 3 + j] = R[i][j];
  return T;
}
function mulTKT(T, K) { // T^t K T
  const M = Array.from({ length: 12 }, () => new Float64Array(12)), G = Array.from({ length: 12 }, () => new Float64Array(12));
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) { let s = 0; for (let k = 0; k < 12; k++) s += K[i][k] * T[k][j]; M[i][j] = s; }
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) { let s = 0; for (let k = 0; k < 12; k++) s += T[k][i] * M[k][j]; G[i][j] = s; }
  return G;
}

const restraintDofs = (r, pos) => { const b = pos[r.node] * 6 + (r.dof === "r" ? 3 : 0); return [b, b + 1, b + 2]; };

// Un caso di carico: { weight, thermal }. Restituisce spostamenti per nodo, azioni locali per elemento, reazioni per nodo.
export function solveCase(S, loads) {
  const { model, pos, half, K0, N, data } = S, w = half + 1;
  const F = new Float64Array(N);
  const eq = data.map(d => {
    const fl = localLoad(d.e, d.ax, loads);
    for (let a = 0; a < 12; a++) { let v = 0; for (let k = 0; k < 12; k++) v += d.T[k][a] * fl[k]; F[d.dofs[a]] += v; }
    return fl;
  });
  if (loads.weight) for (const pt of model.point || []) { const b = pos[pt.node] * 6; for (let i = 0; i < 6; i++) F[b + i] += pt.f[i]; }
  const active = model.restraints.map(() => true);
  let u, iter = 0;
  for (; iter < 40; iter++) {
    const A = K0.slice();
    model.restraints.forEach((r, i) => {
      if (!active[i]) return;
      const id = restraintDofs(r, pos);
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) if (id[a] >= id[b]) A[id[b] * w + id[a] - id[b]] += r.k * r.d[a] * r.d[b];
    });
    const bad = factor(A, N, half);
    if (bad >= 0) { const err = new Error("unstable"); err.node = model.nodes[pos.indexOf(Math.floor(bad / 6))]?.id; throw err; }
    u = backsolve(A, N, half, F.slice());
    let changed = false;
    model.restraints.forEach((r, i) => {
      if (!r.oneWay) return;
      const id = restraintDofs(r, pos), v = r.d[0] * u[id[0]] + r.d[1] * u[id[1]] + r.d[2] * u[id[2]];
      if (active[i] && r.k * v > 1e-3) { active[i] = false; changed = true; } // il tubo tira sul vincolo: si stacca
      else if (!active[i] && v < -1e-7) { active[i] = true; changed = true; }
    });
    if (!changed) break;
  }
  const disp = model.nodes.map((_, i) => Array.from(u.subarray(pos[i] * 6, pos[i] * 6 + 6)));
  const forces = data.map((d, k) => {
    const ul = new Float64Array(12), f = new Float64Array(12);
    for (let a = 0; a < 12; a++) { let v = 0; for (let b = 0; b < 12; b++) v += d.T[a][b] * u[d.dofs[b]]; ul[a] = v; }
    for (let a = 0; a < 12; a++) { let v = -eq[k][a]; for (let b = 0; b < 12; b++) v += d.kl[a][b] * ul[b]; f[a] = v; }
    return f;
  });
  const reactions = new Map();
  model.restraints.forEach((r, i) => {
    if (!active[i]) return;
    const id = restraintDofs(r, pos), v = r.d[0] * u[id[0]] + r.d[1] * u[id[1]] + r.d[2] * u[id[2]];
    if (!reactions.has(r.node)) reactions.set(r.node, new Float64Array(6));
    const R = reactions.get(r.node), o = r.dof === "r" ? 3 : 0;
    for (let a = 0; a < 3; a++) R[o + a] -= r.k * v * r.d[a];
  });
  return { disp, forces, reactions, iterations: iter + 1, active };
}

// differenza algebrica di due casi (es. dilatazione = esercizio - sostenuto)
export function subtract(A, B) {
  const reactions = new Map();
  for (const [n, r] of A.reactions) reactions.set(n, Float64Array.from(r));
  for (const [n, r] of B.reactions) { const x = reactions.get(n) || new Float64Array(6); r.forEach((v, i) => (x[i] -= v)); reactions.set(n, x); }
  return { disp: A.disp.map((d, i) => d.map((v, k) => v - B.disp[i][k])), forces: A.forces.map((f, i) => f.map((v, k) => v - B.forces[i][k])), reactions };
}
