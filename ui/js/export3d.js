// Esportazione dei modelli 3D in formati tecnici: STEP (AP214, facce piane), IFC 4 (un elemento BIM per oggetto),
// 3MF (stampa 3D), DXF 3D (facce 3DFACE per layer), VRML. Funziona con qualsiasi modello aperto nel visualizzatore
// (IFC, STEP, Rhino, Navisworks, mesh...): si esporta cio' che e' visibile, con nomi e colori degli oggetti.
// Coordinate: la scena di three.js ha l'asse Y verso l'alto; i formati tecnici usano Z verso l'alto (x, -z, y).
import { t as tr } from "./i18n.js";
import * as THREE from "three";

// ---------------------------------------------------------------- raccolta degli oggetti
// elementi: [{ name, type, color:[r,g,b], opacity, pos: Float64Array (metri, Z in alto), idx: Uint32Array }]
export function collectElements(model, metersPerUnit = 1) {
  model.updateMatrixWorld(true);
  const visible = o => { for (let x = o; x; x = x.parent) if (!x.visible && !x.userData.proxy) return false; return true; };
  const owners = new Map(); // oggetto proprietario (elemento BIM / nodo Navisworks / mesh) -> parti
  model.traverse(m => {
    if (!m.isMesh || !m.geometry?.attributes?.position || m.userData.merged || !visible(m)) return;
    let owner = m;
    for (let x = m.parent; x && x !== model; x = x.parent) if (x.userData.expressID !== undefined || x.userData.navisId !== undefined) { owner = x; break; }
    if (owner === m && (m.userData.proxy || m.userData.pickParent) && m.parent) owner = m.parent; // SketchUp: un elemento per gruppo/componente
    if (!owners.has(owner)) owners.set(owner, []);
    owners.get(owner).push(m);
  });
  const v = new THREE.Vector3();
  const out = [];
  for (const [owner, meshes] of owners) {
    const pos = [], idx = [];
    let color = null, opacity = 1;
    for (const m of meshes) {
      const g = m.geometry, P = g.attributes.position;
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      if (!color && mat?.color) { color = [mat.color.r, mat.color.g, mat.color.b]; opacity = mat.opacity ?? 1; }
      const src = g.index ? g.index.array : null;
      const n = src ? src.length : P.count;
      const base = pos.length / 3;
      // vertici usati (le copie di selezione dei modelli uniti condividono un buffer enorme: si prendono solo i loro)
      const remap = new Map();
      for (let i = 0; i < n; i++) {
        const o = src ? src[i] : i;
        let k = remap.get(o);
        if (k === undefined) {
          k = base + remap.size;
          remap.set(o, k);
          v.fromBufferAttribute(P, o).applyMatrix4(m.matrixWorld);
          pos.push(v.x * metersPerUnit, -v.z * metersPerUnit, v.y * metersPerUnit);
        }
        idx.push(k);
      }
    }
    if (idx.length < 3) continue;
    out.push({ name: owner.name || meshes[0].name || tr("export3d.oggetto"), type: owner.userData.ifcType || owner.name || "", color: color || [0.75, 0.75, 0.75], opacity,
      pos: Float64Array.from(pos), idx: Uint32Array.from(idx) });
  }
  return out;
}


// ---------------------------------------------------------------- scrittori a pezzi (ui/js/export3dfmt.js)
export { planarFaces, stepChunks, ifcChunks, dxfChunks, vrmlChunks, objChunks, mf3ModelChunks } from "./export3dfmt.js";
import { stepChunks, ifcChunks, dxfChunks, vrmlChunks, objChunks, mf3ModelChunks, MF3_CONTENT_TYPES, MF3_RELS } from "./export3dfmt.js";

// pezzi del file nel formato `ext` (stringhe o byte); scale = unita' della scena per metro (solo OBJ)
export function exportChunks(ext, elements, name, scale = 1) {
  if (ext === "stp" || ext === "step") return stepChunks(elements, name);
  if (ext === "ifc") return ifcChunks(elements, name);
  if (ext === "dxf") return dxfChunks(elements);
  if (ext === "obj") return objChunks(elements, scale);
  if (ext === "3mf") return zip3mf(elements);
  return vrmlChunks(elements);
}

// 3MF = zip compresso a flusso: il testo del modello non esiste mai per intero
async function* zip3mf(elements) {
  const { Zip, ZipDeflate, strToU8 } = await import("three/addons/libs/fflate.module.js");
  const out = [];
  let err = null;
  const zip = new Zip((e, data) => { if (e) err = e; else out.push(data); });
  const add = (name, text) => { const f = new ZipDeflate(name, { level: 6 }); zip.add(f); if (text !== undefined) f.push(strToU8(text), true); return f; };
  add("[Content_Types].xml", MF3_CONTENT_TYPES);
  add("_rels/.rels", MF3_RELS);
  const m = add("3D/3dmodel.model");
  const enc = new TextEncoder();
  let acc = [], len = 0;
  for (const s of mf3ModelChunks(elements)) {
    acc.push(s);
    len += s.length;
    if (len >= 4 << 20) {
      m.push(enc.encode(acc.join("")));
      acc = []; len = 0;
      if (err) throw err;
      while (out.length) yield out.shift();
    }
  }
  m.push(enc.encode(acc.join("")), true);
  zip.end();
  if (err) throw err;
  while (out.length) yield out.shift();
}
