// Schizzi vincolati: geometria nel piano dello schizzo (millimetri) e risolutore dei vincoli geometrici e delle quote.
//
// Schizzo = { pts: {id: {x, y, fix?}}, ents: [...], cons: [...] }
//   ent: {id, t: "line", p1, p2, cons?}  |  {id, t: "circle", c, r, cons?}  |  {id, t: "arc", c, p1, p2, cons?}
//        l'arco va da p1 a p2 in senso antiorario attorno a c (raggio = |c-p1|, vincolo implicito |c-p2| = |c-p1|);
//        cons = geometria di costruzione (assi, riferimenti): non fa parte dei profili.
//   con: {id, t, ...}: hor/ver {e} o {a, b} (due punti), par/perp/equal {e1, e2}, tan {e1, e2, s}, conc {e1, e2},
//        pon {a, e} (punto su curva), mid {a, e}, sym {a, b, e}, coinc {a, b} (si preferisce unire i punti),
//        quote: dist {a, b, v}, hdist/vdist {a, b, v, s}, len {e, v}, rad/dia {e, v}, ang {e1, e2, v}, pdist {a, e, v, s};
//        v = numero o espressione (valutata prima: campo "val"); ref = quota di riferimento (non pilotante).
//
// Metodo: Newton-Gauss con passo di norma minima pesata dx = -W^-1 J^T (J W^-1 J^T + mu I)^-1 r: con pochi vincoli la
// geometria si sposta il meno possibile (trascinando un punto gli altri restano dove sono). Jacobiano numerico, solo sulle
// variabili di ogni vincolo. Gradi di liberta' = variabili - rango di J; un punto e' "definito" se nessuna direzione libera
// lo muove (nucleo di J).

const TOL = 1e-9;

export function newSketch() { return { pts: {}, ents: [], cons: [], seq: 1 }; }
export const uid = (sk, p) => p + (sk.seq++);

export const DIMS = new Set(["dist", "hdist", "vdist", "len", "rad", "dia", "ang", "pdist"]);
export const isDim = c => DIMS.has(c.t);

// ------------------------------------------------------------------------------------------------- variabili
function buildVars(sk, opts) {
  const idx = new Map(), x = [], w = [];
  const heavy = opts.heavy || new Set();
  for (const [id, p] of Object.entries(sk.pts)) {
    if (p.fix || (opts.fixed && opts.fixed.has(id))) continue;
    idx.set(id + ".x", x.length); x.push(p.x); w.push(heavy.has(id) ? 1e4 : 1);
    idx.set(id + ".y", x.length); x.push(p.y); w.push(heavy.has(id) ? 1e4 : 1);
  }
  for (const e of sk.ents) if (e.t === "circle") { idx.set(e.id + ".r", x.length); x.push(e.r); w.push(1); }
  return { idx, x, w };
}

// lettori dei valori (variabile o costante)
function getter(sk, V) {
  const P = id => {
    const p = sk.pts[id];
    if (!p) throw new Error("punto " + id);
    const ix = V.idx.get(id + ".x"), iy = V.idx.get(id + ".y");
    return { ix, iy, gx: ix === undefined ? () => p.x : X => X[ix], gy: iy === undefined ? () => p.y : X => X[iy] };
  };
  const E = new Map(sk.ents.map(e => [e.id, e]));
  return { P, E };
}

// residui di un vincolo: { vars: [indici], f: X -> [residui] }
function residual(sk, V, G, c, L) {
  const { P, E } = G;
  const vars = [];
  const pt = id => { const q = P(id); if (q.ix !== undefined) vars.push(q.ix, q.iy); return q; };
  const radius = e => {
    if (e.t === "circle") {
      const ir = V.idx.get(e.id + ".r");
      if (ir !== undefined) vars.push(ir);
      return ir === undefined ? () => e.r : X => X[ir];
    }
    const C = pt(e.c), A = pt(e.p1);
    return X => Math.hypot(A.gx(X) - C.gx(X), A.gy(X) - C.gy(X));
  };
  const center = e => pt(e.c);
  const line = id => { const e = E.get(id); if (!e || e.t !== "line") throw new Error("linea " + id); return [pt(e.p1), pt(e.p2)]; };
  const ent = id => { const e = E.get(id); if (!e) throw new Error("entita' " + id); return e; };
  const v = c.val ?? (typeof c.v === "number" ? c.v : 0);
  const dirs = (a, b) => X => [b.gx(X) - a.gx(X), b.gy(X) - a.gy(X)];
  let f;
  switch (c.t) {
    case "coinc": { const a = pt(c.a), b = pt(c.b); f = X => [a.gx(X) - b.gx(X), a.gy(X) - b.gy(X)]; break; }
    case "hor": case "ver": {
      const [a, b] = c.e ? line(c.e) : [pt(c.a), pt(c.b)];
      f = c.t === "hor" ? X => [a.gy(X) - b.gy(X)] : X => [a.gx(X) - b.gx(X)];
      break;
    }
    case "par": case "perp": {
      const [a1, b1] = line(c.e1), [a2, b2] = line(c.e2);
      const d1 = dirs(a1, b1), d2 = dirs(a2, b2);
      f = X => {
        const u = d1(X), w = d2(X);
        const n = Math.hypot(...u) * Math.hypot(...w) || 1;
        return [(c.t === "par" ? u[0] * w[1] - u[1] * w[0] : u[0] * w[0] + u[1] * w[1]) / n * L];
      };
      break;
    }
    case "equal": {
      const e1 = ent(c.e1), e2 = ent(c.e2);
      const size = e => {
        if (e.t === "line") { const [a, b] = line(e.id); return X => Math.hypot(b.gx(X) - a.gx(X), b.gy(X) - a.gy(X)); }
        return radius(e);
      };
      const s1 = size(e1), s2 = size(e2);
      f = X => [s1(X) - s2(X)];
      break;
    }
    case "conc": {
      const a = center(ent(c.e1)), b = center(ent(c.e2));
      f = X => [a.gx(X) - b.gx(X), a.gy(X) - b.gy(X)];
      break;
    }
    case "tan": {
      const e1 = ent(c.e1), e2 = ent(c.e2);
      const s = c.s || 1;
      if (e1.t === "line" || e2.t === "line") {
        const ln = e1.t === "line" ? e1 : e2, cu = e1.t === "line" ? e2 : e1;
        const [a, b] = line(ln.id), C = center(cu), r = radius(cu);
        f = X => {
          const dx = b.gx(X) - a.gx(X), dy = b.gy(X) - a.gy(X), n = Math.hypot(dx, dy) || 1;
          const dist = (dx * (C.gy(X) - a.gy(X)) - dy * (C.gx(X) - a.gx(X))) / n;
          return [s * dist - r(X)];
        };
      } else {
        const C1 = center(e1), C2 = center(e2), r1 = radius(e1), r2 = radius(e2);
        f = X => {
          const d = Math.hypot(C1.gx(X) - C2.gx(X), C1.gy(X) - C2.gy(X));
          return [s > 0 ? d - (r1(X) + r2(X)) : d - Math.abs(r1(X) - r2(X))];
        };
      }
      break;
    }
    case "pon": {
      const a = pt(c.a), e = ent(c.e);
      if (e.t === "line") {
        const [p, q] = line(e.id);
        f = X => {
          const dx = q.gx(X) - p.gx(X), dy = q.gy(X) - p.gy(X), n = Math.hypot(dx, dy) || 1;
          return [(dx * (a.gy(X) - p.gy(X)) - dy * (a.gx(X) - p.gx(X))) / n];
        };
      } else {
        const C = center(e), r = radius(e);
        f = X => [Math.hypot(a.gx(X) - C.gx(X), a.gy(X) - C.gy(X)) - r(X)];
      }
      break;
    }
    case "mid": {
      const a = pt(c.a), [p, q] = line(c.e);
      f = X => [a.gx(X) - (p.gx(X) + q.gx(X)) / 2, a.gy(X) - (p.gy(X) + q.gy(X)) / 2];
      break;
    }
    case "sym": {
      const a = pt(c.a), b = pt(c.b), [p, q] = line(c.e);
      f = X => {
        const mx = (a.gx(X) + b.gx(X)) / 2, my = (a.gy(X) + b.gy(X)) / 2;
        const dx = q.gx(X) - p.gx(X), dy = q.gy(X) - p.gy(X), n = Math.hypot(dx, dy) || 1;
        const on = (dx * (my - p.gy(X)) - dy * (mx - p.gx(X))) / n;
        const perp = (dx * (b.gx(X) - a.gx(X)) + dy * (b.gy(X) - a.gy(X))) / n;
        return [on, perp];
      };
      break;
    }
    case "dist": { const a = pt(c.a), b = pt(c.b); f = X => [Math.hypot(b.gx(X) - a.gx(X), b.gy(X) - a.gy(X)) - v]; break; }
    case "hdist": { const a = pt(c.a), b = pt(c.b), s = c.s || 1; f = X => [s * (b.gx(X) - a.gx(X)) - v]; break; }
    case "vdist": { const a = pt(c.a), b = pt(c.b), s = c.s || 1; f = X => [s * (b.gy(X) - a.gy(X)) - v]; break; }
    case "len": { const [a, b] = line(c.e); f = X => [Math.hypot(b.gx(X) - a.gx(X), b.gy(X) - a.gy(X)) - v]; break; }
    case "rad": case "dia": { const r = radius(ent(c.e)), k = c.t === "dia" ? 2 : 1; f = X => [k * r(X) - v]; break; }
    case "ang": {
      const [a1, b1] = line(c.e1), [a2, b2] = line(c.e2);
      const d1 = dirs(a1, b1), d2 = dirs(a2, b2);
      const th = v * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
      f = X => {
        let u = d1(X), w = d2(X);
        if (c.r1) u = [-u[0], -u[1]];
        if (c.r2) w = [-w[0], -w[1]];
        const n = Math.hypot(...u) * Math.hypot(...w) || 1;
        const cr = (u[0] * w[1] - u[1] * w[0]) / n, dt = (u[0] * w[0] + u[1] * w[1]) / n;
        return [(cr * cs - dt * sn) * L]; // sin(angolo - v)
      };
      break;
    }
    case "pdist": {
      const a = pt(c.a), [p, q] = line(c.e), s = c.s || 1;
      f = X => {
        const dx = q.gx(X) - p.gx(X), dy = q.gy(X) - p.gy(X), n = Math.hypot(dx, dy) || 1;
        return [s * (dx * (a.gy(X) - p.gy(X)) - dy * (a.gx(X) - p.gx(X))) / n - v];
      };
      break;
    }
    default: return null;
  }
  return { c, vars: [...new Set(vars)], f };
}

// arco: |c-p2| = |c-p1| (vincolo implicito di ogni arco)
function arcRows(sk, V, G) {
  const out = [];
  for (const e of sk.ents) {
    if (e.t !== "arc") continue;
    const vars = [];
    const pt = id => { const q = G.P(id); if (q.ix !== undefined) vars.push(q.ix, q.iy); return q; };
    const C = pt(e.c), A = pt(e.p1), B = pt(e.p2);
    out.push({ c: { id: "_arc" + e.id, t: "arc" }, vars: [...new Set(vars)], f: X => [Math.hypot(B.gx(X) - C.gx(X), B.gy(X) - C.gy(X)) - Math.hypot(A.gx(X) - C.gx(X), A.gy(X) - C.gy(X))] });
  }
  return out;
}

export function sketchScale(sk) {
  let mn = [Infinity, Infinity], mx = [-Infinity, -Infinity];
  for (const p of Object.values(sk.pts)) { mn = [Math.min(mn[0], p.x), Math.min(mn[1], p.y)]; mx = [Math.max(mx[0], p.x), Math.max(mx[1], p.y)]; }
  for (const e of sk.ents) if (e.t === "circle") { const c = sk.pts[e.c]; if (c) { mn = [Math.min(mn[0], c.x - e.r), Math.min(mn[1], c.y - e.r)]; mx = [Math.max(mx[0], c.x + e.r), Math.max(mx[1], c.y + e.r)]; } }
  const s = Math.max(mx[0] - mn[0], mx[1] - mn[1]);
  return isFinite(s) && s > 0 ? s : 100;
}

function rowsOf(sk, V, opts) {
  const G = getter(sk, V);
  const L = sketchScale(sk);
  const rows = [];
  for (const c of sk.cons) {
    if (c.ref || c.off) continue; // quote di riferimento e vincoli sospesi
    try { const r = residual(sk, V, G, c, L); if (r) rows.push(r); } catch { /* vincolo verso un'entita' tolta: ignorato */ }
  }
  rows.push(...arcRows(sk, V, G));
  if (opts.extra) for (const r of opts.extra(V, G)) rows.push(r);
  return { rows, L };
}

function evalRows(rows, X) {
  const r = [];
  for (const row of rows) r.push(...row.f(X));
  return r;
}

function jacobian(rows, X, n) {
  const J = [];
  for (const row of rows) {
    const base = row.f(X);
    const cols = base.map(() => new Float64Array(n));
    for (const i of row.vars) {
      const h = 1e-7 * Math.max(1, Math.abs(X[i]));
      const xi = X[i];
      X[i] = xi + h; const fp = row.f(X);
      X[i] = xi - h; const fm = row.f(X);
      X[i] = xi;
      for (let k = 0; k < base.length; k++) cols[k][i] = (fp[k] - fm[k]) / (2 * h);
    }
    J.push(...cols);
  }
  return J;
}

// risolve A y = b (A m x m simmetrica definita positiva o quasi): eliminazione di Gauss con pivot
function solveLin(A, b) {
  const m = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let k = 0; k < m; k++) {
    let p = k;
    for (let i = k + 1; i < m; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
    if (Math.abs(M[p][k]) < 1e-300) continue;
    [M[k], M[p]] = [M[p], M[k]];
    for (let i = k + 1; i < m; i++) {
      const f = M[i][k] / M[k][k];
      if (!f) continue;
      for (let j = k; j <= m; j++) M[i][j] -= f * M[k][j];
    }
  }
  const y = new Float64Array(m);
  for (let k = m - 1; k >= 0; k--) {
    let s = M[k][m];
    for (let j = k + 1; j < m; j++) s -= M[k][j] * y[j];
    y[k] = Math.abs(M[k][k]) < 1e-300 ? 0 : s / M[k][k];
  }
  return y;
}

const norm = r => Math.sqrt(r.reduce((s, v) => s + v * v, 0));

// risolve lo schizzo sul posto (posizioni e raggi aggiornati). opts: fixed (punti fermi in piu'), heavy (punti da muovere
// il meno possibile: quello trascinato), extra (residui in piu'). Restituisce { ok, res, iters, bad: [id vincoli] }
export function solve(sk, opts = {}) {
  const V = buildVars(sk, opts);
  const { rows, L } = rowsOf(sk, V, opts);
  const n = V.x.length;
  const X = Float64Array.from(V.x);
  const tol = TOL * Math.max(1, L);
  let r = evalRows(rows, X), rn = norm(r), it = 0;
  if (n && rows.length) {
    for (it = 0; it < 60 && rn > tol; it++) {
      const J = jacobian(rows, X, n);
      const m = J.length;
      // (J W^-1 J^T + mu I) y = r
      const A = Array.from({ length: m }, () => new Float64Array(m));
      for (let i = 0; i < m; i++) for (let j = i; j < m; j++) {
        let s = 0;
        const a = J[i], b = J[j];
        for (let k = 0; k < n; k++) if (a[k] && b[k]) s += a[k] * b[k] / V.w[k];
        A[i][j] = A[j][i] = s;
      }
      let mu = 1e-10;
      for (let i = 0; i < m; i++) mu = Math.max(mu, A[i][i] * 1e-10);
      for (let i = 0; i < m; i++) A[i][i] += mu;
      const y = solveLin(A, r);
      const dx = new Float64Array(n);
      for (let i = 0; i < m; i++) if (y[i]) { const a = J[i]; for (let k = 0; k < n; k++) if (a[k]) dx[k] += a[k] * y[i] / V.w[k]; }
      // passo con ricerca lineare: il residuo deve calare
      let step = 1, ok = false;
      const X0 = Float64Array.from(X);
      for (let ls = 0; ls < 12; ls++) {
        for (let k = 0; k < n; k++) X[k] = X0[k] - step * dx[k];
        const r2 = evalRows(rows, X), n2 = norm(r2);
        if (n2 < rn || n2 <= tol) { r = r2; rn = n2; ok = true; break; }
        step /= 2;
      }
      if (!ok) { X.set(X0); break; }
    }
  }
  // risultato scritto nello schizzo
  for (const [key, i] of V.idx) {
    const [id, k] = [key.slice(0, key.lastIndexOf(".")), key.slice(key.lastIndexOf(".") + 1)];
    if (k === "r") { const e = sk.ents.find(q => q.id === id); if (e) e.r = Math.abs(X[i]); }
    else sk.pts[id][k] = X[i];
  }
  const bad = [];
  if (rn > tol * 10) {
    const rr = evalRows(rows, X);
    let q = 0;
    for (const row of rows) { const k = row.f(X).length; if (rr.slice(q, q + k).some(v => Math.abs(v) > tol * 10)) bad.push(row.c.id); q += k; }
  }
  return { ok: rn <= tol * 10, res: rn, iters: it, bad };
}

// gradi di liberta' e punti/entita' completamente definiti (nucleo dello jacobiano alla soluzione)
export function analyze(sk) {
  const V = buildVars(sk, {});
  const { rows } = rowsOf(sk, V, {});
  const n = V.x.length;
  if (!n) return { dof: 0, free: new Set() };
  const X = Float64Array.from(V.x);
  const J = rows.length ? jacobian(rows, X, n) : [];
  // forma a scalini di J (righe) -> colonne pivot; base del nucleo dalle colonne libere
  const M = J.map(r => Float64Array.from(r));
  const scale = M.reduce((s, r) => Math.max(s, ...r.map(Math.abs)), 1e-12);
  const eps = 1e-8 * scale;
  const pivots = [];
  let row = 0;
  for (let col = 0; col < n && row < M.length; col++) {
    let p = row;
    for (let i = row + 1; i < M.length; i++) if (Math.abs(M[i][col]) > Math.abs(M[p][col])) p = i;
    if (Math.abs(M[p][col]) <= eps) continue;
    [M[row], M[p]] = [M[p], M[row]];
    const pv = M[row][col];
    for (let j = col; j < n; j++) M[row][j] /= pv;
    for (let i = 0; i < M.length; i++) {
      if (i === row || !M[i][col]) continue;
      const f = M[i][col];
      for (let j = col; j < n; j++) M[i][j] -= f * M[row][j];
    }
    pivots.push(col);
    row++;
  }
  const isPivot = new Set(pivots);
  const freeCols = [];
  for (let c = 0; c < n; c++) if (!isPivot.has(c)) freeCols.push(c);
  // ogni colonna libera da' un vettore del nucleo: x_free = 1, x_pivot = -M[riga][free]
  const moving = new Float64Array(n);
  for (const fc of freeCols) {
    moving[fc] = 1;
    pivots.forEach((pc, r) => { if (Math.abs(M[r][fc]) > 1e-9) moving[pc] = 1; });
  }
  const free = new Set();
  for (const [key, i] of V.idx) if (moving[i]) free.add(key.slice(0, key.lastIndexOf(".")));
  return { dof: freeCols.length, free };
}

// ------------------------------------------------------------------------------------------------- utilita'
export function entPoints(e) { return e.t === "line" || e.t === "arc" ? (e.t === "arc" ? [e.c, e.p1, e.p2] : [e.p1, e.p2]) : [e.c]; }

// valore attuale di una quota (per mostrarla e per le quote di riferimento)
export function measureDim(sk, c) {
  const P = id => sk.pts[id];
  const E = id => sk.ents.find(e => e.id === id);
  const rad = e => (e.t === "circle" ? e.r : Math.hypot(P(e.p1).x - P(e.c).x, P(e.p1).y - P(e.c).y));
  try {
    switch (c.t) {
      case "dist": return Math.hypot(P(c.b).x - P(c.a).x, P(c.b).y - P(c.a).y);
      case "hdist": return (c.s || 1) * (P(c.b).x - P(c.a).x);
      case "vdist": return (c.s || 1) * (P(c.b).y - P(c.a).y);
      case "len": { const e = E(c.e); return Math.hypot(P(e.p2).x - P(e.p1).x, P(e.p2).y - P(e.p1).y); }
      case "rad": return rad(E(c.e));
      case "dia": return 2 * rad(E(c.e));
      case "ang": {
        const a = E(c.e1), b = E(c.e2);
        let u = [P(a.p2).x - P(a.p1).x, P(a.p2).y - P(a.p1).y], w = [P(b.p2).x - P(b.p1).x, P(b.p2).y - P(b.p1).y];
        if (c.r1) u = [-u[0], -u[1]];
        if (c.r2) w = [-w[0], -w[1]];
        return Math.atan2(u[0] * w[1] - u[1] * w[0], u[0] * w[0] + u[1] * w[1]) * 180 / Math.PI;
      }
      case "pdist": {
        const e = E(c.e), p = P(e.p1), q = P(e.p2), a = P(c.a);
        const dx = q.x - p.x, dy = q.y - p.y, n = Math.hypot(dx, dy) || 1;
        return (c.s || 1) * (dx * (a.y - p.y) - dy * (a.x - p.x)) / n;
      }
    }
  } catch { /* */ }
  return NaN;
}

// unisce il punto b nel punto a (coincidenza): tutti i riferimenti a b passano ad a
export function mergePoints(sk, a, b) {
  if (a === b || !sk.pts[a] || !sk.pts[b]) return;
  const rep = id => (id === b ? a : id);
  for (const e of sk.ents) for (const k of ["p1", "p2", "c"]) if (e[k]) e[k] = rep(e[k]);
  for (const c of sk.cons) for (const k of ["a", "b"]) if (c[k]) c[k] = rep(c[k]);
  if (sk.pts[b].fix) sk.pts[a].fix = true;
  delete sk.pts[b];
  // vincoli diventati inutili (punto con se stesso)
  sk.cons = sk.cons.filter(c => !(c.a && c.b && c.a === c.b && ["coinc", "dist", "hdist", "vdist"].includes(c.t)));
  // linee degeneri (stessi estremi)
  const gone = new Set(sk.ents.filter(e => e.t === "line" && e.p1 === e.p2).map(e => e.id));
  if (gone.size) removeEnts(sk, gone);
}

// toglie entita' (e i vincoli che le citano, e i punti rimasti soli)
export function removeEnts(sk, ids) {
  sk.ents = sk.ents.filter(e => !ids.has(e.id));
  sk.cons = sk.cons.filter(c => ![c.e, c.e1, c.e2].some(x => x && ids.has(x)));
  const used = new Set();
  for (const e of sk.ents) for (const p of entPoints(e)) used.add(p);
  for (const id of Object.keys(sk.pts)) if (!used.has(id)) { delete sk.pts[id]; }
  sk.cons = sk.cons.filter(c => ![c.a, c.b].some(x => x && !sk.pts[x]));
}
