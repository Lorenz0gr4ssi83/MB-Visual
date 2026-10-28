// Vista 3D dei disegni DWG/DXF: riconosce i disegni con contenuto 3D e trasforma le entita' in mesh three.js
// (layer, colori ACI/true color, blocchi con le loro trasformazioni, sistema di coordinate dell'oggetto OCS).
// Entita': 3DFACE, polyface e polygon mesh, MESH (gabbia di controllo, senza levigatura), SOLID/TRACE, linee, archi,
// cerchi, polilinee, ellissi, spline (anche con spessore = superfici estruse); solidi, regioni, corpi e superfici ACIS
// convertiti in STEP dal motore (mbvisual/cad3d.py, solo app per PC) e triangolati da OpenCascade.
import * as THREE from "three";
import { api, waitJob, WEB } from "./core.js";
import { t as tr } from "./i18n.js";
import { bulgeArc, sweepPts, TAU } from "./cadgeom.js";

import { ACIS_TYPES } from "./cad3dscan.js";

// ---------------------------------------------------------------- geometria
// sistema di coordinate dell'oggetto (algoritmo dell'asse arbitrario di AutoCAD)
function ocs(n) {
  if (!n) return null;
  const N = new THREE.Vector3(n.x || 0, n.y || 0, n.z ?? 1);
  if (N.lengthSq() < 1e-20) return null;
  N.normalize();
  if (Math.abs(N.x) < 1e-12 && Math.abs(N.y) < 1e-12 && N.z > 0) return null;
  const Ax = Math.abs(N.x) < 1 / 64 && Math.abs(N.y) < 1 / 64 ? new THREE.Vector3(0, 1, 0).cross(N) : new THREE.Vector3(0, 0, 1).cross(N);
  Ax.normalize();
  const Ay = N.clone().cross(Ax).normalize();
  return new THREE.Matrix4().makeBasis(Ax, Ay, N);
}
function spline3(e) {
  const cps = e.controlPoints || [];
  if (cps.length < 2) return (e.fitPoints || []).map(p => [p.x, p.y, p.z || 0]);
  const p = e.degree || 3, kn = e.knots && e.knots.length === cps.length + p + 1 ? e.knots : null;
  if (!kn) return cps.map(c => [c.x, c.y, c.z || 0]);
  const w = e.weights && e.weights.length === cps.length ? e.weights : cps.map(c => c.weight || 1);
  const out = [], t0 = kn[p], t1 = kn[cps.length], N = Math.max(20, cps.length * 8);
  for (let s = 0; s <= N; s++) {
    let t = t0 + (t1 - t0) * s / N;
    if (s === N) t = t1 - 1e-10;
    let k = p;
    while (k < cps.length - 1 && t >= kn[k + 1]) k++;
    const d = [];
    for (let j = 0; j <= p; j++) { const c = cps[k - p + j], ww = w[k - p + j]; d.push([c.x * ww, c.y * ww, (c.z || 0) * ww, ww]); }
    for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
      const i = k - p + j, a = (t - kn[i]) / ((kn[i + p - r + 1] - kn[i]) || 1);
      d[j] = d[j].map((v, q) => (1 - a) * d[j - 1][q] + a * v);
    }
    out.push([d[p][0] / d[p][3], d[p][1] / d[p][3], d[p][2] / d[p][3]]);
  }
  return out;
}

// raccolta di triangoli e segmenti per colore (una mesh e una LineSegments per colore e per gruppo)
class Batch {
  constructor() { this.f = new Map(); this.l = new Map(); }
  _arr(map, col) { const k = col.join(","); let a = map.get(k); if (!a) map.set(k, (a = { col, v: [] })); return a.v; }
  tri(col, M, a, b, c) {
    const v = this._arr(this.f, col);
    for (const p of [a, b, c]) { const q = new THREE.Vector3(p[0], p[1], p[2] || 0).applyMatrix4(M); v.push(q.x, q.y, q.z); }
  }
  poly(col, M, P) { for (let i = 1; i + 1 < P.length; i++) this.tri(col, M, P[0], P[i], P[i + 1]); }
  lines(col, M, P, closed = false) {
    if (P.length < 2) return;
    const v = this._arr(this.l, col);
    const W = P.map(p => new THREE.Vector3(p[0], p[1], p[2] || 0).applyMatrix4(M));
    for (let i = 1; i < W.length; i++) v.push(W[i - 1].x, W[i - 1].y, W[i - 1].z, W[i].x, W[i].y, W[i].z);
    if (closed && W.length > 2) { const a = W[W.length - 1], b = W[0]; v.push(a.x, a.y, a.z, b.x, b.y, b.z); }
  }
  // tratto estruso dello spessore (h lungo la normale dell'entita', gia' nella matrice)
  wall(col, M, P, h, closed = false) {
    const Q = closed ? [...P, P[0]] : P;
    for (let i = 1; i < Q.length; i++) {
      const a = Q[i - 1], b = Q[i], z0 = a[2] || 0, z1 = b[2] || 0;
      this.poly(col, M, [[a[0], a[1], z0], [b[0], b[1], z1], [b[0], b[1], z1 + h], [a[0], a[1], z0 + h]]);
    }
  }
  empty() { return !this.f.size && !this.l.size; }
  flush(group, mats) {
    for (const { col, v } of this.f.values()) {
      if (!v.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, mats.face(col));
      m.name = tr("cad3d.facce");
      m.userData.cad3dBatch = true;
      group.add(m);
    }
    for (const { col, v } of this.l.values()) {
      if (!v.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
      const m = new THREE.LineSegments(g, mats.line(col));
      m.name = tr("cad3d.linee");
      m.userData.cad3dBatch = true;
      group.add(m);
    }
  }
}

// il visualizzatore usa il depth buffer logaritmico (polygonOffset non ha effetto): linee e spigoli si avvicinano alla
// camera dello 0,05% della distanza nello shader, cosi' restano sopra le facce (come in ui/js/sketchup.js)
function onTop(m) {
  m.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace("#include <logdepthbuf_vertex>", "#include <logdepthbuf_vertex>\n#ifdef USE_LOGDEPTHBUF\n  vFragDepth = 1.0 + gl_Position.w * 0.9995;\n#endif");
  };
  return m;
}
function materials(dark) {
  const F = new Map(), L = new Map(), E = new Map();
  const hex = c => (c[0] << 16) | (c[1] << 8) | c[2];
  const white = c => c[0] > 245 && c[1] > 245 && c[2] > 245;
  return {
    // il bianco/nero di AutoCAD (ACI 7) su sfondo chiaro diventa grigio scuro per le linee e grigio chiaro per le facce
    face: c => { const k = hex(c); if (!F.has(k)) F.set(k, new THREE.MeshStandardMaterial({ color: white(c) ? 0xd6d8da : k, metalness: 0.05, roughness: 0.75, side: THREE.DoubleSide })); return F.get(k); },
    line: c => { const k = hex(c); if (!L.has(k)) L.set(k, onTop(new THREE.LineBasicMaterial({ color: white(c) && !dark ? 0x2a2c2e : k }))); return L.get(k); },
    edge: c => { const k = hex(c); if (!E.has(k)) { const col = new THREE.Color(white(c) ? 0x55585b : k).multiplyScalar(0.45); E.set(k, onTop(new THREE.LineBasicMaterial({ color: col }))); } return E.get(k); },
  };
}

// ---------------------------------------------------------------- costruzione della scena
export async function loadCad3d(ctx, db, ld, info, { ACI, dark }) {
  ld.set(0.1, tr("cad3d.costruzione"));
  const trueColor = n => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const layers = new Map();
  for (const l of db.tables.LAYER?.entries || []) layers.set(l.name, { name: l.name, aci: l.colorIndex, color: l.color, off: !!l.off || !!l.frozen });
  const layerOf = n => { if (!layers.has(n)) layers.set(n, { name: n, aci: 7, off: false }); return layers.get(n); };
  const colorOf = (e, L, inherited) => {
    if (e.colorIndex === undefined && typeof e.color === "number") return trueColor(e.color);
    if (typeof e.color === "number" && e.color > 0 && e.colorIndex !== 0 && e.colorIndex !== 256) return trueColor(e.color);
    const ci = e.colorIndex ?? 256;
    if (ci === 0) return inherited || [255, 255, 255];
    if (ci === 256 || ci < 0) return L.color !== undefined && L.color > 0 && !L.aci ? trueColor(L.color) : ACI[Math.abs(L.aci ?? 7)] || ACI[7];
    return ACI[ci] || ACI[7];
  };
  const blocks = new Map((db.tables.BLOCK_RECORD?.entries || []).map(b => [b.name, b]));
  const mats = materials(dark);
  const acis = new Map(); // handle -> { e, n }: dati da convertire
  const stats = { solids: 0, meshes: 0, faces: 0, curves: 0, inserts: 0 };
  const label = e => tr("cad3d.t_" + e.type.toLowerCase()) + (e.handle ? " " + e.handle : "");

  // origine: con coordinate molto grandi (UTM, Gauss-Boaga) la geometria si sposta vicino all'origine (precisione Float32)
  const O = ctx.origin && Math.hypot(ctx.origin[0], ctx.origin[1]) > 1e5 ? ctx.origin : [0, 0];
  const M0 = new THREE.Matrix4().makeTranslation(-O[0], -O[1], 0);

  const templates = new Map();
  // contenuto di un blocco (coordinate del blocco), riusato da tutti gli inserimenti con la stessa eredita' di layer e colore
  function template(name, inh, depth) {
    const key = name + "|" + (inh.layer || "") + "|" + (inh.color || []).join(",");
    if (templates.has(key)) return templates.get(key);
    const b = blocks.get(name);
    let g = null;
    templates.set(key, null); // blocchi che contengono se stessi
    if (b && depth < 12) {
      g = new THREE.Group();
      const bp = b.basePoint || { x: 0, y: 0, z: 0 };
      const batch = new Batch();
      walk(b.entities || [], new THREE.Matrix4().makeTranslation(-(bp.x || 0), -(bp.y || 0), -(bp.z || 0)), inh, depth, () => g, batch);
      batch.flush(g, mats);
      if (!g.children.length) g = null;
    }
    templates.set(key, g);
    return g;
  }
  function insertMatrix(e, r, c) {
    const sx = e.xScale || 1, sy = e.yScale || 1, sz = e.zScale || 1, a = e.rotation || 0;
    const ip = e.insertionPoint || { x: 0, y: 0, z: 0 };
    const ox = c * (e.columnSpacing || 0), oy = r * (e.rowSpacing || 0);
    const m = new THREE.Matrix4().makeTranslation(ip.x || 0, ip.y || 0, ip.z || 0)
      .multiply(new THREE.Matrix4().makeRotationZ(a))
      .multiply(new THREE.Matrix4().makeTranslation(ox, oy, 0))
      .multiply(new THREE.Matrix4().makeScale(sx, sy, sz));
    const R = ocs(e.extrusionDirection);
    return R ? R.multiply(m) : m;
  }

  // dove: funzione che restituisce il gruppo in cui mettere gli oggetti di quel layer
  function walk(list, M, inh, depth, where, batch) {
    for (const e of list) {
      if (e._deleted || e.isVisible === false || (depth === 0 && e.isInPaperSpace)) continue;
      const lname = e.layer === "0" && inh.layer ? inh.layer : e.layer || "0";
      const L = layerOf(lname);
      if (depth > 0 && L.off) continue;
      const col = colorOf(e, L, inh.color);
      const B = depth === 0 ? batchOf(lname) : batch;
      const t = e.type;
      const R = ocs(e.extrusionDirection);
      const Mo = R ? M.clone().multiply(R) : M; // coordinate dell'oggetto (OCS)
      const h = +e.thickness || 0;
      try {
        switch (t) {
          case "LINE": {
            const a = e.startPoint, b = e.endPoint;
            const P = [[a.x, a.y, a.z || 0], [b.x, b.y, b.z || 0]];
            if (h) { // spessore lungo la normale: la linea e' in coordinate del mondo, lo spostamento in OCS
              const n = new THREE.Vector3(0, 0, h).applyMatrix4(R || new THREE.Matrix4());
              B.poly(col, M, [P[0], P[1], [P[1][0] + n.x, P[1][1] + n.y, P[1][2] + n.z], [P[0][0] + n.x, P[0][1] + n.y, P[0][2] + n.z]]);
            } else B.lines(col, M, P);
            stats.curves++;
            break;
          }
          case "CIRCLE": case "ARC": {
            const cz = e.center.z || 0;
            let a0 = 0, sw = TAU;
            if (t === "ARC") { a0 = e.startAngle; sw = e.endAngle - e.startAngle; while (sw <= 0) sw += TAU; }
            const P = sweepPts(e.center.x, e.center.y, e.radius, e.radius, 0, a0, sw).map(([x, y]) => [x, y, cz]);
            if (h) {
              B.wall(col, Mo, P, h);
              if (t === "CIRCLE") { const c0 = [e.center.x, e.center.y, cz], c1 = [e.center.x, e.center.y, cz + h]; for (let i = 1; i < P.length; i++) { B.tri(col, Mo, c0, P[i - 1], P[i]); B.tri(col, Mo, c1, [P[i - 1][0], P[i - 1][1], cz + h], [P[i][0], P[i][1], cz + h]); } }
            } else B.lines(col, Mo, P);
            stats.curves++;
            break;
          }
          case "ELLIPSE": {
            const c = new THREE.Vector3(e.center.x, e.center.y, e.center.z || 0), mj = new THREE.Vector3(e.majorAxisEndPoint.x, e.majorAxisEndPoint.y, e.majorAxisEndPoint.z || 0);
            const n = new THREE.Vector3(e.extrusionDirection?.x || 0, e.extrusionDirection?.y || 0, e.extrusionDirection?.z ?? 1).normalize();
            const mn = n.clone().cross(mj).multiplyScalar(e.axisRatio || 1);
            let a0 = e.startAngle || 0, a1 = e.endAngle ?? TAU;
            while (a1 <= a0) a1 += TAU;
            const N = Math.max(16, Math.ceil((a1 - a0) / TAU * 96)), P = [];
            for (let i = 0; i <= N; i++) { const a = a0 + (a1 - a0) * i / N, p = c.clone().addScaledVector(mj, Math.cos(a)).addScaledVector(mn, Math.sin(a)); P.push([p.x, p.y, p.z]); }
            B.lines(col, M, P);
            stats.curves++;
            break;
          }
          case "LWPOLYLINE": case "POLYLINE2D": {
            const V = (e.vertices || []).filter(p => !(p.flag & 16));
            if (!V.length) break;
            const z = t === "LWPOLYLINE" ? +e.elevation || 0 : +(e.elevation?.z ?? e.elevation ?? V[0].z ?? 0) || 0;
            const closed = !!(e.flag & 1) || e.closed;
            const P = [[V[0].x, V[0].y]];
            const seg = (a, b) => { const A = a.bulge ? bulgeArc(a.x, a.y, b.x, b.y, a.bulge) : null; if (!A) P.push([b.x, b.y]); else { const s = sweepPts(A.cx, A.cy, A.r, A.r, 0, A.a0, A.sw); s[s.length - 1] = [b.x, b.y]; P.push(...s.slice(1)); } };
            for (let i = 1; i < V.length; i++) seg(V[i - 1], V[i]);
            if (closed) seg(V[V.length - 1], V[0]);
            const P3 = P.map(([x, y]) => [x, y, z]);
            if (h) B.wall(col, Mo, P3, h); else B.lines(col, Mo, P3);
            stats.curves++;
            break;
          }
          case "POLYLINE3D": {
            const V = (e.vertices || []).filter(p => !(p.flag & 16)).map(p => [p.x, p.y, p.z || 0]);
            B.lines(col, M, V, !!(e.flag & 1));
            stats.curves++;
            break;
          }
          case "SPLINE": B.lines(col, M, spline3(e), !!(e.flag & 1)); stats.curves++; break;
          case "3DFACE": {
            const c = [e.corner1, e.corner2, e.corner3, e.corner4 || e.corner3].map(p => [p.x, p.y, p.z || 0]);
            B.tri(col, M, c[0], c[1], c[2]);
            if (Math.hypot(c[3][0] - c[2][0], c[3][1] - c[2][1], c[3][2] - c[2][2]) > 1e-12) B.tri(col, M, c[0], c[2], c[3]);
            stats.faces++;
            break;
          }
          case "SOLID": case "TRACE": {
            const z = +e.elevation || e.corner1.z || 0;
            const c = [e.corner1, e.corner2, e.corner4 || e.corner3, e.corner3].map(p => [p.x, p.y, z]); // ordine 1-2-4-3 di AutoCAD
            B.poly(col, Mo, c);
            if (h) { B.poly(col, Mo, c.map(p => [p[0], p[1], z + h])); B.wall(col, Mo, c, h, true); }
            stats.faces++;
            break;
          }
          case "PFACE": case "PMESH": case "MESH": {
            const obj = meshObject(e, col);
            if (!obj) break;
            obj.applyMatrix4(M);
            where(lname).add(obj);
            stats.meshes++;
            break;
          }
          case "INSERT": {
            const g = template(e.name, { layer: lname, color: col }, depth + 1);
            if (!g) break;
            const rows = Math.max(1, e.rowCount || 1), cols = Math.max(1, e.columnCount || 1);
            for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
              const inst = g.clone();
              inst.name = e.name;
              inst.matrixAutoUpdate = false;
              inst.matrix.copy(M.clone().multiply(insertMatrix(e, r, c)));
              inst.userData = { [tr("cad3d.p_tipo")]: tr("cad3d.t_insert"), [tr("cad3d.p_blocco")]: e.name, [tr("cad3d.p_layer")]: lname, ...(e.handle ? { Handle: e.handle } : {}) };
              where(lname).add(inst);
            }
            stats.inserts++;
            break;
          }
          default:
            if (ACIS_TYPES.has(t)) {
              const key = e.handle || "_" + acis.size;
              if (!acis.has(key)) acis.set(key, { e, n: 0 });
              acis.get(key).n++;
              const g = new THREE.Group();
              g.name = label(e);
              g.matrixAutoUpdate = false;
              g.matrix.copy(M);
              g.userData = { cad3dAcis: key, cad3dColor: col, [tr("cad3d.p_tipo")]: tr("cad3d.t_" + t.toLowerCase()), [tr("cad3d.p_layer")]: lname, ...(e.handle ? { Handle: e.handle } : {}) };
              where(lname).add(g);
              stats.solids++;
            }
        }
      } catch { /* entita' con dati incompleti: si salta */ }
    }
  }
  // mesh di una singola entita' (polyface, polygon mesh, MESH), con spigoli
  function meshObject(e, col) {
    const tris = [], V = e.vertices || [];
    const P = i => V[i];
    if (e.type === "PFACE" || e.type === "MESH") {
      for (const f of e.faces || []) {
        const idx = f.map(i => Math.abs(i) - (e.type === "PFACE" ? 1 : 0)).filter(i => i >= 0 && i < V.length);
        for (let k = 1; k + 1 < idx.length; k++) tris.push(idx[0], idx[k], idx[k + 1]);
      }
    } else {
      const m = e.m | 0, n = e.n | 0;
      if (m < 2 || n < 2 || V.length < m * n) return null;
      const cm = !!(e.flag & 1), cn = !!(e.flag & 32);
      for (let i = 0; i < (cm ? m : m - 1); i++) for (let j = 0; j < (cn ? n : n - 1); j++) {
        const a = i * n + j, b = ((i + 1) % m) * n + j, c = ((i + 1) % m) * n + (j + 1) % n, d = i * n + (j + 1) % n;
        tris.push(a, b, c, a, c, d);
      }
    }
    if (!tris.length) return null;
    const pos = [];
    for (const i of tris) { const p = P(i); pos.push(p[0], p[1], p[2] || 0); }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    const grp = new THREE.Group();
    grp.name = label(e);
    grp.userData = { [tr("cad3d.p_tipo")]: tr("cad3d.t_" + e.type.toLowerCase()), [tr("cad3d.p_layer")]: e.layer || "0", [tr("cad3d.p_facce")]: tris.length / 3, ...(e.handle ? { Handle: e.handle } : {}) };
    const mesh = new THREE.Mesh(g, mats.face(col));
    mesh.userData.pickParent = true;
    grp.add(mesh);
    if (tris.length < 600000) { const ed = new THREE.LineSegments(new THREE.EdgesGeometry(g, 25), mats.edge(col)); ed.userData.pickParent = true; grp.add(ed); }
    return grp;
  }

  // gruppi dei layer dello spazio modello
  const root = new THREE.Group();
  root.name = ctx.name;
  const layerGroups = new Map(), batches = new Map();
  const groupOf = n => {
    if (!layerGroups.has(n)) { const g = new THREE.Group(); g.name = n; g.userData = { [tr("cad3d.p_layer")]: n }; g.visible = !layerOf(n).off; layerGroups.set(n, g); root.add(g); }
    return layerGroups.get(n);
  };
  const batchOf = n => { if (!batches.has(n)) batches.set(n, new Batch()); return batches.get(n); };
  walk(db.entities || [], M0, {}, 0, groupOf, null);
  for (const [n, b] of batches) if (!b.empty()) b.flush(groupOf(n), mats);

  // ---- solidi ACIS: motore Python -> STEP -> OpenCascade
  let acisOk = 0, acisFail = 0, facesTot = 0, facesOk = 0;
  const miss = new Map();
  if (acis.size && !WEB) {
    ld.set(0.25, tr("cad3d.conversione_solidi", acis.size));
    const items = [...acis.entries()].map(([h, { e }]) => {
      const it = { h };
      if (e.acis?.sat) it.sat = e.acis.sat;
      else if (e.acis?.sab) it.sab = b64(e.acis.sab);
      return it;
    });
    let res = null;
    try {
      const { job } = await api("cad3d", { path: ctx.path }, { json: { items } });
      res = await waitJob(job, p => ld.set(0.25 + 0.3 * p, tr("cad3d.conversione_solidi", acis.size)));
    } catch (e) { console.error(e); info.cad3dError = e.message; }
    const solids = res?.solids || {};
    const { makePool, missLabel } = await import("./inventor3d.js");
    const keys = Object.keys(solids).filter(k => solids[k].step);
    const pool = keys.length ? makePool(Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1, keys.length))) : null;
    const geoms = new Map();
    let done = 0;
    for (const s of Object.values(solids)) {
      facesTot += s.report?.["facce totali"] || 0; facesOk += s.report?.["facce convertite"] || 0;
      for (const [k, v] of Object.entries(s.missing || {})) miss.set(missLabel(k), (miss.get(missLabel(k)) || 0) + v);
    }
    try {
      await Promise.all(keys.map(async k => {
        try {
          const r = await pool.read(new TextEncoder().encode(solids[k].step));
          if (r && r.success !== false && r.meshes?.length) geoms.set(k, r.meshes.map(m => {
            const g = new THREE.BufferGeometry();
            g.setAttribute("position", new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
            if (m.attributes.normal) g.setAttribute("normal", new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
            if (m.index) g.setIndex(m.index.array);
            if (!m.attributes.normal) g.computeVertexNormals();
            return g;
          }));
        } catch { /* solido non triangolato: resta nel rapporto */ }
        done++;
        ld.set(0.55 + 0.35 * done / keys.length, tr("cad3d.triangolazione", done, keys.length));
      }));
    } finally { pool?.close(); }
    const edgesOf = new Map();
    root.traverse(o => {
      const k = o.userData?.cad3dAcis;
      if (k === undefined) return;
      const gs = geoms.get(k), col = o.userData.cad3dColor;
      if (!gs) { o.userData[tr("cad3d.p_stato")] = tr("cad3d.solido_non_convertito"); return; }
      for (const g of gs) {
        const m = new THREE.Mesh(g, mats.face(col));
        m.userData.pickParent = true;
        o.add(m);
        if (!edgesOf.has(g)) edgesOf.set(g, (g.index ? g.index.count : g.attributes.position.count) < 900000 ? new THREE.EdgesGeometry(g, 25) : null);
        const eg = edgesOf.get(g);
        if (eg) { const l = new THREE.LineSegments(eg, mats.edge(col)); l.userData.pickParent = true; o.add(l); }
      }
    });
    acisOk = [...acis.keys()].filter(k => geoms.has(k)).length;
    acisFail = acis.size - acisOk;
  } else if (acis.size) acisFail = acis.size;

  // asse Z verso l'alto (come i CAD); albero per layer
  root.rotation.x = -Math.PI / 2;
  const tree = [];
  for (const [n, g] of [...layerGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!g.children.length) { root.remove(g); continue; }
    const kids = g.children.filter(c => !c.userData.cad3dBatch).slice(0, 3000).map(c => ({ name: c.name || c.type, obj: c, children: [] }));
    const loose = g.children.filter(c => c.userData.cad3dBatch);
    if (loose.length) kids.unshift({ name: tr("cad3d.linee_e_facce"), obj: null, objs: loose, children: [] });
    tree.push({ name: `${n} (${g.children.length})`, obj: g, children: kids });
  }
  const parts = [];
  if (acis.size) parts.push(tr("cad3d.s_solidi", acisOk, acis.size));
  if (stats.meshes) parts.push(tr("cad3d.s_mesh", stats.meshes));
  if (stats.faces) parts.push(tr("cad3d.s_facce", stats.faces));
  if (stats.inserts) parts.push(tr("cad3d.s_blocchi", stats.inserts));
  info.status = tr("cad3d.vista_3d") + parts.join(", ");
  info.cad3d = { stats, acisOk, acisFail, facesTot, facesOk, miss: [...miss.entries()], web: WEB && acis.size > 0 };
  return { root, tree };
}

function b64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

// avvisi dopo l'apertura (solidi non convertiti, app per telefono senza motore)
export function cad3dWarnings(c) {
  if (!c) return [];
  const out = [];
  if (c.web) out.push(tr("cad3d.solidi_solo_pc", c.acisFail));
  else if (c.acisFail) out.push(tr("cad3d.solidi_non_convertiti", c.acisFail));
  if (c.facesTot > c.facesOk) out.push(tr("cad3d.facce_non_convertite", c.facesOk, c.facesTot) + (c.miss.length ? " (" + c.miss.slice(0, 4).map(([k, v]) => `${k}: ${v}`).join("; ") + ")" : ""));
  return out;
}
