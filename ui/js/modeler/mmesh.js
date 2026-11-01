// Triangoli di una scena three.js (modelli letti dal visualizzatore 3D: STL, OBJ, glTF, PLY, 3MF, FBX, IFC...) per il
// motore di modellazione: coordinate del file con Z in alto, millimetri, un pezzo per oggetto (o per colore se troppi).
import * as THREE from "three";

// formati con le unita' in metri nella scena (come in viewers/model3d.js)
export const METERS = new Set(["ifc", "nwd", "nwc", "nwf", "glb", "gltf", "usdz", "vrm", "skp"]);

// root = gruppo restituito dal lettore (ruotato di -90 gradi attorno a X per i formati con Z in alto)
export function meshParts(root, ext, { max = 400, skip = null } = {}) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const yUp = Math.abs(root.rotation.x) < 1e-9;
  const toZ = yUp ? new THREE.Matrix4().makeRotationX(Math.PI / 2) : new THREE.Matrix4();
  const k = METERS.has(ext) ? 1000 : 1;
  const S = new THREE.Matrix4().makeScale(k, k, k);
  let merged = false;
  root.traverse(o => { if (o.userData?.merged) merged = true; });
  const visible = o => { for (let x = o; x && x !== root.parent; x = x.parent) if (!x.visible && !x.userData?.proxy) return false; return true; };
  const list = [];
  root.traverse(o => {
    if (!o.isMesh || !o.geometry?.attributes?.position || skip?.(o)) return;
    if (merged ? !o.userData.proxy : o.userData.proxy) return;
    if (!merged && !visible(o)) return;
    if (merged && !visible(o.parent)) return;
    list.push(o);
  });
  const M = new THREE.Matrix4(), v = new THREE.Vector3();
  const parts = [];
  for (const o of list) {
    M.multiplyMatrices(S, toZ).multiply(inv).multiply(o.matrixWorld);
    const g = o.geometry, pa = g.attributes.position;
    const pos = new Float32Array(pa.count * 3);
    for (let i = 0; i < pa.count; i++) { v.fromBufferAttribute(pa, i).applyMatrix4(M); pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z; }
    let idx;
    if (g.index) idx = Uint32Array.from(g.index.array.slice(g.drawRange?.start || 0, Math.min(g.index.count, (g.drawRange?.start || 0) + (isFinite(g.drawRange?.count) ? g.drawRange.count : Infinity))));
    else idx = Uint32Array.from({ length: pa.count - pa.count % 3 }, (_, i) => i);
    if (M.determinant() < 0) for (let i = 0; i + 2 < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    const name = (o.name || o.parent?.name || "").replace(/_/g, " ").trim();
    parts.push({ name, color: mat?.color ? "#" + mat.color.getHexString() : null, pos, idx });
  }
  if (parts.length <= max) return parts;
  // troppi oggetti: uniti per colore
  const by = new Map();
  for (const p of parts) { const key = p.color || ""; if (!by.has(key)) by.set(key, []); by.get(key).push(p); }
  return [...by.entries()].map(([color, ps]) => {
    let nv = 0, nt = 0;
    for (const p of ps) { nv += p.pos.length; nt += p.idx.length; }
    const pos = new Float32Array(nv), idx = new Uint32Array(nt);
    let ov = 0, ot = 0;
    for (const p of ps) { pos.set(p.pos, ov); for (let i = 0; i < p.idx.length; i++) idx[ot + i] = p.idx[i] + ov / 3; ov += p.pos.length; ot += p.idx.length; }
    return { name: ps[0].name, color: color || null, pos, idx };
  });
}
