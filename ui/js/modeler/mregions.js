// Regioni chiuse di uno schizzo (come le facce di SketchUp o i profili di Fusion): le curve non di costruzione si
// dividono nei punti d'incrocio, si toglie cio' che resta aperto e si percorrono le facce del grafo planare.
// Ogni regione = contorno esterno + fori (componenti contenute), con area, baricentro e poligono per la vista e il clic.
// Il contorno si passa al motore come segmenti e archi esatti (loopSegs): stessi nodi per segmenti consecutivi.

const TAU = Math.PI * 2;
const normA = a => { a %= TAU; return a < 0 ? a + TAU : a; };

function curvesOf(sk) {
  const P = id => sk.pts[id];
  const out = [];
  for (const e of sk.ents) {
    if (e.cons) continue;
    if (e.t === "line") {
      const a = P(e.p1), b = P(e.p2);
      if (!a || !b || Math.hypot(b.x - a.x, b.y - a.y) < 1e-12) continue;
      out.push({ e: e.id, t: "l", a: [a.x, a.y], b: [b.x, b.y] });
    } else if (e.t === "circle") {
      const c = P(e.c);
      if (!c || !(e.r > 0)) continue;
      out.push({ e: e.id, t: "a", c: [c.x, c.y], r: e.r, a0: 0, sw: TAU, full: true });
    } else if (e.t === "arc") {
      const c = P(e.c), a = P(e.p1), b = P(e.p2);
      if (!c || !a || !b) continue;
      const r = Math.hypot(a.x - c.x, a.y - c.y);
      if (!(r > 0)) continue;
      const a0 = Math.atan2(a.y - c.y, a.x - c.x), a1 = Math.atan2(b.y - c.y, b.x - c.x);
      let sw = normA(a1 - a0);
      if (sw < 1e-12) sw = TAU;
      out.push({ e: e.id, t: "a", c: [c.x, c.y], r, a0, sw, pa: [a.x, a.y], pb: [b.x, b.y] });
    }
  }
  return out;
}

// punto di una curva al parametro u (0..1)
function at(cv, u) {
  if (cv.t === "l") return [cv.a[0] + (cv.b[0] - cv.a[0]) * u, cv.a[1] + (cv.b[1] - cv.a[1]) * u];
  const th = cv.a0 + cv.sw * u;
  return [cv.c[0] + cv.r * Math.cos(th), cv.c[1] + cv.r * Math.sin(th)];
}

// parametro (0..1) del punto p proiettato sulla curva; NaN se fuori dall'arco
function paramOf(cv, p) {
  if (cv.t === "l") {
    const dx = cv.b[0] - cv.a[0], dy = cv.b[1] - cv.a[1];
    return ((p[0] - cv.a[0]) * dx + (p[1] - cv.a[1]) * dy) / (dx * dx + dy * dy);
  }
  const th = normA(Math.atan2(p[1] - cv.c[1], p[0] - cv.c[0]) - cv.a0);
  if (cv.full) return th / TAU;
  if (th <= cv.sw + 1e-12) return th / cv.sw;
  if (th > TAU - 1e-9) return 0;
  return NaN;
}

function interLL(a, b, eps) {
  const r = [a.b[0] - a.a[0], a.b[1] - a.a[1]], s = [b.b[0] - b.a[0], b.b[1] - b.a[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  const q = [b.a[0] - a.a[0], b.a[1] - a.a[1]];
  const lr = Math.hypot(...r), ls = Math.hypot(...s);
  if (Math.abs(den) < 1e-12 * lr * ls) {
    // parallele: se allineate, gli estremi dell'una sull'altra
    if (Math.abs(q[0] * r[1] - q[1] * r[0]) / lr > eps) return [];
    const out = [];
    for (const p of [b.a, b.b]) { const u = paramOf(a, p); if (u > -1e-9 && u < 1 + 1e-9) out.push(p); }
    for (const p of [a.a, a.b]) { const u = paramOf(b, p); if (u > -1e-9 && u < 1 + 1e-9) out.push(p); }
    return out;
  }
  const t = (q[0] * s[1] - q[1] * s[0]) / den, u = (q[0] * r[1] - q[1] * r[0]) / den;
  const et = eps / lr, eu = eps / ls;
  if (t < -et || t > 1 + et || u < -eu || u > 1 + eu) return [];
  return [[a.a[0] + r[0] * t, a.a[1] + r[1] * t]];
}

function interLC(l, c) {
  const d = [l.b[0] - l.a[0], l.b[1] - l.a[1]], f = [l.a[0] - c.c[0], l.a[1] - c.c[1]];
  const A = d[0] * d[0] + d[1] * d[1], B = 2 * (f[0] * d[0] + f[1] * d[1]), C = f[0] * f[0] + f[1] * f[1] - c.r * c.r;
  let disc = B * B - 4 * A * C;
  const tolD = 1e-9 * B * B + 1e-14;
  if (disc < -tolD) return [];
  if (disc < 0) disc = 0;
  const sq = Math.sqrt(disc);
  const ts = disc === 0 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
  return ts.filter(t => t > -1e-9 && t < 1 + 1e-9).map(t => [l.a[0] + d[0] * t, l.a[1] + d[1] * t]);
}

function interCC(a, b) {
  const dx = b.c[0] - a.c[0], dy = b.c[1] - a.c[1], d = Math.hypot(dx, dy);
  if (d < 1e-12) return [];
  if (d > a.r + b.r + 1e-9 * (a.r + b.r) || d < Math.abs(a.r - b.r) - 1e-9 * (a.r + b.r)) return [];
  const x = (d * d + a.r * a.r - b.r * b.r) / (2 * d);
  const h = Math.sqrt(Math.max(0, a.r * a.r - x * x));
  const mx = a.c[0] + dx * x / d, my = a.c[1] + dy * x / d;
  if (h < 1e-9 * a.r) return [[mx, my]];
  return [[mx - dy * h / d, my + dx * h / d], [mx + dy * h / d, my - dx * h / d]];
}

// regioni dello schizzo: [{ outer, holes, area, c, ents, poly, holePolys, sig }]
export function findRegions(sk) {
  const cvs = curvesOf(sk);
  if (!cvs.length) return [];
  let mn = [Infinity, Infinity], mx = [-Infinity, -Infinity];
  for (const cv of cvs) for (let k = 0; k <= 8; k++) { const p = at(cv, k / 8); mn = [Math.min(mn[0], p[0]), Math.min(mn[1], p[1])]; mx = [Math.max(mx[0], p[0]), Math.max(mx[1], p[1])]; }
  const scale = Math.max(mx[0] - mn[0], mx[1] - mn[1], 1e-6);
  const eps = scale * 1e-7;
  // nodi uniti con una griglia
  const nodes = [], grid = new Map();
  const key = (x, y) => Math.round(x / (eps * 10)) + "," + Math.round(y / (eps * 10));
  const nodeOf = p => {
    const gx = Math.round(p[0] / (eps * 10)), gy = Math.round(p[1] / (eps * 10));
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const l = grid.get((gx + i) + "," + (gy + j));
      if (l) for (const n of l) if (Math.hypot(nodes[n][0] - p[0], nodes[n][1] - p[1]) <= eps * 10) return n;
    }
    nodes.push([p[0], p[1]]);
    const k = key(p[0], p[1]);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(nodes.length - 1);
    return nodes.length - 1;
  };
  // punti di divisione di ogni curva (estremi + incroci)
  const splits = cvs.map(cv => (cv.t === "l" ? [0, 1] : cv.full ? [] : [0, 1]));
  const addSplit = (i, p) => { const u = paramOf(cvs[i], p); if (isFinite(u)) splits[i].push(Math.min(1, Math.max(0, u))); };
  for (let i = 0; i < cvs.length; i++) for (let j = i + 1; j < cvs.length; j++) {
    const a = cvs[i], b = cvs[j];
    let pts;
    if (a.t === "l" && b.t === "l") pts = interLL(a, b, eps * 10);
    else if (a.t === "l") pts = interLC(a, b);
    else if (b.t === "l") pts = interLC(b, a);
    else pts = interCC(a, b);
    for (const p of pts) {
      if (a.t === "a" && !a.full && !isFinite(paramOf(a, p))) continue;
      if (b.t === "a" && !b.full && !isFinite(paramOf(b, p))) continue;
      addSplit(i, p); addSplit(j, p);
    }
    // estremi che toccano l'altra curva (incroci a "T" non trovati per arrotondamento)
    for (const [x, y] of [[i, j], [j, i]]) {
      const cx = cvs[x], cy = cvs[y];
      if (cx.full) continue;
      for (const p of [at(cx, 0), at(cx, 1)]) {
        const u = paramOf(cy, p);
        if (!isFinite(u) || u < -1e-9 || u > 1 + 1e-9) continue;
        const q = at(cy, Math.min(1, Math.max(0, u)));
        if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= eps * 10) addSplit(y, p);
      }
    }
  }
  // spigoli del grafo
  const edges = [];
  cvs.forEach((cv, i) => {
    let us = [...new Set(splits[i].map(u => Math.round(u * 1e12) / 1e12))].sort((a, b) => a - b);
    if (cv.full) {
      if (us.length < 2) us = us.length ? [us[0], (us[0] + 0.5) % 1] : [0, 0.5];
      us.sort((a, b) => a - b);
      us.push(us[0] + 1);
    }
    for (let k = 0; k + 1 < us.length; k++) {
      const u0 = us[k], u1 = us[k + 1];
      if (u1 - u0 < 1e-10) continue;
      const pa = at(cv, u0 % 1 === 0 && cv.full ? u0 : u0), pb = at(cv, cv.full ? u1 % 1 : u1);
      const na = nodeOf(pa), nb = nodeOf(pb);
      if (na === nb && cv.t === "l") continue;
      const ed = { cv, e: cv.e, u0, u1, a: na, b: nb };
      if (cv.t === "a") { ed.th0 = cv.a0 + cv.sw * u0; ed.sw = cv.sw * (u1 - u0); }
      edges.push(ed);
    }
  });
  // doppioni (curve sovrapposte)
  const seen = new Set();
  const uniq = [];
  for (const ed of edges) {
    const m = ptOn(ed, 0.5, nodes);
    const k = [Math.min(ed.a, ed.b), Math.max(ed.a, ed.b), Math.round(m[0] / (eps * 100)), Math.round(m[1] / (eps * 100))].join(",");
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(ed);
  }
  // via gli spigoli pendenti (grado 1), ripetutamente
  let live = uniq;
  for (;;) {
    const deg = new Map();
    for (const ed of live) { deg.set(ed.a, (deg.get(ed.a) || 0) + 1); deg.set(ed.b, (deg.get(ed.b) || 0) + 1); }
    const keep = live.filter(ed => deg.get(ed.a) > 1 && deg.get(ed.b) > 1);
    if (keep.length === live.length) break;
    live = keep;
  }
  if (!live.length) return [];
  // semispigoli: direzione di partenza presa poco dopo il nodo (distingue anche curve tangenti)
  const half = [];
  live.forEach((ed, i) => { half.push({ ed: i, fw: true, from: ed.a, to: ed.b }, { ed: i, fw: false, from: ed.b, to: ed.a }); });
  const out = new Map();
  half.forEach((h, i) => {
    const ed = live[h.ed];
    const p0 = nodes[h.from];
    const q = ptOn(ed, h.fw ? 0.02 : 0.98, nodes);
    h.ang = Math.atan2(q[1] - p0[1], q[0] - p0[0]);
    if (!out.has(h.from)) out.set(h.from, []);
    out.get(h.from).push(i);
  });
  for (const l of out.values()) l.sort((a, b) => half[a].ang - half[b].ang);
  const twin = i => (i % 2 === 0 ? i + 1 : i - 1);
  const used = new Uint8Array(half.length);
  const loops = [];
  for (let s = 0; s < half.length; s++) {
    if (used[s]) continue;
    const loop = [];
    let h = s, guard = 0;
    while (!used[h] && guard++ < half.length + 2) {
      used[h] = 1;
      loop.push(h);
      // al nodo d'arrivo: il primo semispigolo in senso orario dal ritorno (faccia a sinistra)
      const tw = twin(h);
      const lst = out.get(half[h].to);
      const k = lst.indexOf(tw);
      h = lst[(k - 1 + lst.length) % lst.length];
    }
    if (h !== s) continue; // percorso non chiuso (non dovrebbe succedere)
    loops.push(loop);
  }
  const loopInfo = loops.map(lp => {
    const poly = polyOf(lp, half, live, nodes);
    return { lp, poly, area: areaOf(lp, half, live, nodes), comp: -1 };
  });
  // componenti connesse (per i fori): unione dei nodi
  const parent = nodes.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const ed of live) parent[find(ed.a)] = find(ed.b);
  for (const L of loopInfo) L.comp = find(half[L.lp[0]].from);
  const faces = loopInfo.filter(L => L.area > eps * eps);
  const outers = loopInfo.filter(L => L.area < -eps * eps);
  const regions = faces.map(F => ({ F, holes: [] }));
  for (const O of outers) {
    // il contorno esterno di una componente e' un foro della faccia piu' piccola (di un'altra componente) che la contiene
    const p = O.poly[0];
    let best = null;
    for (const R of regions) {
      if (R.F.comp === O.comp) continue;
      if (R.F.area <= -O.area) continue;
      if (!inPoly(p, R.F.poly)) continue;
      if (!best || R.F.area < best.F.area) best = R;
    }
    if (best) best.holes.push(O);
  }
  return regions.map((R, i) => {
    const ents = [...new Set(R.F.lp.map(h => live[half[h].ed].e))].sort();
    const area = R.F.area + R.holes.reduce((s, H) => s + H.area, 0);
    const c = centroid(R.F.poly, R.holes.map(H => H.poly));
    return {
      i, area, c, ents, poly: R.F.poly, holePolys: R.holes.map(H => H.poly),
      outer: loopSegs(R.F.lp, half, live, nodes), holes: R.holes.map(H => loopSegs(H.lp, half, live, nodes)),
      sig: { ents, c, a: area, nh: R.holes.length },
    };
  });
}

function ptOn(ed, u, nodes) {
  if (ed.cv.t === "l") {
    const a = nodes[ed.a], b = nodes[ed.b];
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  }
  const th = ed.th0 + ed.sw * u;
  return [ed.cv.c[0] + ed.cv.r * Math.cos(th), ed.cv.c[1] + ed.cv.r * Math.sin(th)];
}

function polyOf(lp, half, live, nodes) {
  const out = [];
  for (const h of lp) {
    const H = half[h], ed = live[H.ed];
    if (ed.cv.t === "l") { out.push(nodes[H.from]); continue; }
    const n = Math.max(2, Math.ceil(ed.sw / (Math.PI / 24)));
    for (let k = 0; k < n; k++) out.push(ptOn(ed, H.fw ? k / n : 1 - k / n, nodes));
  }
  return out;
}

function areaOf(lp, half, live, nodes) {
  let A = 0;
  for (const h of lp) {
    const H = half[h], ed = live[H.ed];
    const a = nodes[H.from], b = nodes[H.to];
    A += (a[0] * b[1] - b[0] * a[1]) / 2;
    if (ed.cv.t === "a") {
      const seg = ed.cv.r * ed.cv.r / 2 * (ed.sw - Math.sin(ed.sw));
      A += H.fw ? seg : -seg;
    }
  }
  return A;
}

export function inPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function inRegion(p, R) { return inPoly(p, R.poly) && !R.holePolys.some(h => inPoly(p, h)); }

function polyArea(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += f; cx += (poly[j][0] + poly[i][0]) * f; cy += (poly[j][1] + poly[i][1]) * f;
  }
  return { a: a / 2, cx, cy };
}

function centroid(poly, holes) {
  let A = 0, X = 0, Y = 0;
  for (const [pl, s] of [[poly, 1], ...holes.map(h => [h, 1])]) {
    const r = polyArea(pl);
    A += r.a * s; X += r.cx * s; Y += r.cy * s;
  }
  return Math.abs(A) > 1e-18 ? [X / (6 * A), Y / (6 * A)] : poly[0];
}

// contorno -> segmenti esatti per il motore (stessi numeri per i nodi condivisi)
function loopSegs(lp, half, live, nodes) {
  return lp.map(h => {
    const H = half[h], ed = live[H.ed];
    const a = nodes[H.from], b = nodes[H.to];
    if (ed.cv.t === "l") return { t: "l", a: [...a], b: [...b] };
    if (Math.abs(ed.sw - TAU) < 1e-9) return { t: "c", c: [...ed.cv.c], r: ed.cv.r };
    return { t: "a", c: [...ed.cv.c], r: ed.cv.r, a: [...a], b: [...b], ccw: H.fw };
  });
}

// regione che corrisponde a una firma salvata (stesse entita' al contorno, poi la piu' vicina che contiene il baricentro)
export function matchRegion(regions, sig) {
  if (!sig) return null;
  const k = (sig.ents || []).join("|");
  const same = regions.filter(R => R.ents.join("|") === k && R.holes.length === (sig.nh ?? R.holes.length));
  const near = (list) => list.slice().sort((a, b) => Math.hypot(a.c[0] - sig.c[0], a.c[1] - sig.c[1]) - Math.hypot(b.c[0] - sig.c[0], b.c[1] - sig.c[1]))[0];
  if (same.length) return near(same);
  const sameEnts = regions.filter(R => R.ents.join("|") === k);
  if (sameEnts.length) return near(sameEnts);
  const inside = regions.filter(R => inRegion(sig.c, R));
  if (inside.length) return inside.sort((a, b) => a.area - b.area)[0];
  return null;
}
