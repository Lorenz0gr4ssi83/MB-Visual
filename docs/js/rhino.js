// Rhino (.3dm): solidi salvati senza mesh di visualizzazione (tipico dei file esportati da altri programmi, es. EsaPRO).
// Il lettore di three.js li salta; qui si ricostruisce la superficie dalla geometria esatta con rhino3dm:
// - estrusioni (tubi, profilati): profili esterno e interni estrusi lungo il percorso, con i tappi
// - Brep: superfici campionate a griglia; le facce piane si ricostruiscono dai bordi reali (fori compresi)
import * as THREE from "three";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";

let RHINO = null;
async function rhinoLib() {
  if (!RHINO) {
    const mod = await import(window.MBV_ROOT + "vendor/three/examples/jsm/libs/rhino3dm/rhino3dm.module.js");
    RHINO = mod.default({ locateFile: f => window.MBV_ROOT + "vendor/three/examples/jsm/libs/rhino3dm/" + f });
  }
  return RHINO;
}

const v3 = p => new THREE.Vector3(p[0], p[1], p[2]);

function sampleCurve(c, n) {
  const [a, b] = c.domain;
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(v3(c.pointAt(a + ((b - a) * i) / n)));
  return pts;
}
function segmentsFor(c) {
  try { if (c.isLinear()) return 1; } catch { /* */ }
  try { if (c.isCircle() || c.isArc()) return 48; } catch { /* */ }
  return Math.min(200, Math.max(24, (c.spanCount || 4) * 12));
}

// triangolazione di un insieme di anelli chiusi complanari (il piu' grande e' il contorno, gli altri fori)
function triangulateLoops(loops, normal, positions) {
  const n = normal.clone().normalize();
  const u = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0).cross(n).normalize() : new THREE.Vector3(0, 1, 0).cross(n).normalize();
  const w = n.clone().cross(u);
  const flat = loops.map(l => l.map(p => new THREE.Vector2(p.dot(u), p.dot(w))));
  const area = l => Math.abs(THREE.ShapeUtils.area(l));
  const order = flat.map((l, i) => i).sort((a, b) => area(flat[b]) - area(flat[a]));
  const outer = order[0];
  const contour = flat[outer], holes = order.slice(1).map(i => flat[i]);
  const all3d = [...loops[outer], ...order.slice(1).flatMap(i => loops[i])];
  let tris = [];
  try { tris = THREE.ShapeUtils.triangulateShape(contour, holes); } catch { return; }
  for (const t of tris) for (const k of t) positions.push(all3d[k].x, all3d[k].y, all3d[k].z);
}

function meshFromPositions(positions, color) {
  let g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  // superfici curve lisce, spigoli vivi oltre i 35 gradi (bordi delle flange, tappi dei tubi)
  try { g = toCreasedNormals(g, (35 * Math.PI) / 180); } catch { g.computeVertexNormals(); }
  return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide }));
}

function tessExtrusion(ext) {
  const positions = [];
  const n = ext.profileCount;
  const bottom = [], top = [];
  for (let i = 0; i < n; i++) {
    const c0 = ext.profile3d(i, 0), c1 = ext.profile3d(i, 1);
    if (!c0 || !c1) continue;
    const seg = segmentsFor(c0);
    const a = sampleCurve(c0, seg), b = sampleCurve(c1, seg);
    for (let k = 0; k < seg; k++) {
      positions.push(a[k].x, a[k].y, a[k].z, b[k].x, b[k].y, b[k].z, b[k + 1].x, b[k + 1].y, b[k + 1].z);
      positions.push(a[k].x, a[k].y, a[k].z, b[k + 1].x, b[k + 1].y, b[k + 1].z, a[k + 1].x, a[k + 1].y, a[k + 1].z);
    }
    bottom.push(a.slice(0, -1));
    top.push(b.slice(0, -1));
  }
  const dir = v3(ext.pathEnd).sub(v3(ext.pathStart));
  if (ext.isCappedAtBottom && bottom.length) triangulateLoops(bottom, dir, positions);
  if (ext.isCappedAtTop && top.length) triangulateLoops(top, dir, positions);
  return positions;
}

function tessBrep(brep, tol) {
  const positions = [];
  // bordi del Brep campionati (servono per le facce piane)
  const edges = [];
  const el = brep.edges();
  for (let i = 0; i < el.count; i++) {
    const e = el.get(i);
    try { edges.push(sampleCurve(e, segmentsFor(e))); } catch { /* */ }
  }
  const fl = brep.faces();
  for (let i = 0; i < fl.count; i++) {
    const s = fl.get(i).underlyingSurface();
    if (!s) continue;
    const [u0, u1] = s.domain(0), [v0, v1] = s.domain(1);
    let planar = false;
    try { planar = s.isPlanar(tol); } catch { /* */ }
    if (planar) {
      const p0 = v3(s.pointAt(u0, v0)), nrm = v3(s.normalAt((u0 + u1) / 2, (v0 + v1) / 2));
      const onPlane = pts => pts.every(p => Math.abs(p.clone().sub(p0).dot(nrm)) < tol * 10);
      const mine = edges.filter(onPlane);
      const loops = chainLoops(mine, tol * 10);
      if (loops.length) { triangulateLoops(loops, nrm, positions); continue; }
    }
    // superficie curva: griglia sul dominio della superficie
    const nu = s.isCylinder?.(tol) || s.isCone?.(tol) ? 48 : 24, nv = 24;
    const P = [];
    for (let a = 0; a <= nu; a++) { const row = []; for (let b = 0; b <= nv; b++) row.push(v3(s.pointAt(u0 + ((u1 - u0) * a) / nu, v0 + ((v1 - v0) * b) / nv))); P.push(row); }
    for (let a = 0; a < nu; a++) for (let b = 0; b < nv; b++) {
      const p = P[a][b], q = P[a + 1][b], r = P[a + 1][b + 1], t = P[a][b + 1];
      positions.push(p.x, p.y, p.z, q.x, q.y, q.z, r.x, r.y, r.z, p.x, p.y, p.z, r.x, r.y, r.z, t.x, t.y, t.z);
    }
  }
  return positions;
}

// unisce i bordi in anelli chiusi confrontando gli estremi
function chainLoops(curves, tol) {
  const left = curves.map(c => c.slice());
  const loops = [];
  while (left.length) {
    let loop = left.shift();
    let grown = true;
    while (grown && loop[0].distanceTo(loop[loop.length - 1]) > tol) {
      grown = false;
      const end = loop[loop.length - 1];
      for (let i = 0; i < left.length; i++) {
        const c = left[i];
        if (c[0].distanceTo(end) <= tol) { loop = loop.concat(c.slice(1)); left.splice(i, 1); grown = true; break; }
        if (c[c.length - 1].distanceTo(end) <= tol) { loop = loop.concat(c.slice(0, -1).reverse()); left.splice(i, 1); grown = true; break; }
      }
    }
    if (loop.length > 3 && loop[0].distanceTo(loop[loop.length - 1]) <= tol) loops.push(loop.slice(0, -1));
  }
  return loops;
}

// aggiunge a "group" i solidi del file che non hanno mesh; ritorna quanti ne ha ricostruiti
export async function addMissingSolids(bytes, group) {
  const rhino = await rhinoLib();
  const doc = rhino.File3dm.fromByteArray(bytes);
  if (!doc) return 0;
  const have = new Set();
  group.traverse(o => { const id = o.userData?.attributes?.id; if (id) have.add(id); });
  const objs = doc.objects();
  const layers = [];
  for (let i = 0; i < doc.layers().count; i++) { const L = doc.layers().get(i); layers.push({ name: L.name, fullPath: L.fullPath, color: L.color }); }
  let added = 0;
  const box = new THREE.Box3().setFromObject(group);
  const tol = Math.max(1e-6, (box.isEmpty() ? 1000 : box.getSize(new THREE.Vector3()).length()) * 1e-6);
  for (let i = 0; i < objs.count; i++) {
    const o = objs.get(i);
    const g = o.geometry(), at = o.attributes();
    if (have.has(at.id)) continue;
    let positions = null;
    try {
      if (g.objectType === rhino.ObjectType.Extrusion) positions = tessExtrusion(g);
      else if (g.objectType === rhino.ObjectType.Brep) positions = tessBrep(g, tol);
    } catch (e) { console.warn("3dm: solido non ricostruito", at.id, e); }
    if (!positions?.length) continue;
    const c = at.drawColor ? at.drawColor(doc) : null;
    const L = layers[at.layerIndex];
    const color = c ? new THREE.Color(c.r / 255, c.g / 255, c.b / 255) : L?.color ? new THREE.Color(L.color.r / 255, L.color.g / 255, L.color.b / 255) : new THREE.Color(0.72, 0.74, 0.76);
    const mesh = meshFromPositions(positions, color);
    mesh.name = at.name || (g.objectType === rhino.ObjectType.Extrusion ? "Estrusione" : "Solido");
    let userStrings = [];
    try { userStrings = at.getUserStrings(); } catch { /* */ }
    mesh.userData = { objectType: g.objectType === rhino.ObjectType.Extrusion ? "Extrusion" : "Brep", attributes: { name: at.name, id: at.id, layerIndex: at.layerIndex, userStrings, drawColor: c ? { r: c.r, g: c.g, b: c.b } : undefined } };
    group.add(mesh);
    added++;
  }
  doc.delete?.();
  return added;
}
