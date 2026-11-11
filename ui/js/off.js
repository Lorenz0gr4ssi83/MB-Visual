// .off (Object File Format) nel visualizzatore 3D: una mesh con i colori del file (per faccia o per vertice), spigoli isolati
// come linee. Lettura in offparse.js.
import * as THREE from "three";
import { fmtNum, t } from "./i18n.js";
import { parseOff } from "./offparse.js";

export function loadOff(ctx, bytes) {
  let P;
  try { P = parseOff(new TextDecoder().decode(bytes)); }
  catch (e) { throw new Error(t("off.errore_" + String(e.message).replace("off-", ""))); }
  const g = new THREE.BufferGeometry();
  let colored = false;
  if (P.faceColors) {
    // colore per faccia: vertici separati per triangolo (un vertice condiviso non puo' avere due colori)
    const n = P.tri.length, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = P.tri[i], c = P.faceColors[(i / 3) | 0] || (P.vcol ? [P.vcol[v * 3], P.vcol[v * 3 + 1], P.vcol[v * 3 + 2]] : [0.72, 0.74, 0.76]);
      pos.set(P.pos.subarray(v * 3, v * 3 + 3), i * 3); col.set(c, i * 3);
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    colored = true;
  } else {
    g.setAttribute("position", new THREE.BufferAttribute(P.pos, 3));
    if (P.vcol) { g.setAttribute("color", new THREE.BufferAttribute(P.vcol, 3)); colored = true; }
    g.setIndex(new THREE.BufferAttribute(P.tri, 1));
  }
  g.computeVertexNormals();
  const root = new THREE.Group();
  const obj = new THREE.Group();
  obj.name = ctx.name;
  root.add(obj);
  const tree = [];
  if (P.tri.length) {
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: colored ? 0xffffff : 0xb8bcc0, vertexColors: colored, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide }));
    mesh.name = t("off.superficie");
    obj.add(mesh);
    tree.push({ name: mesh.name, obj: mesh, children: [] });
  } else if (P.nv) { // solo vertici: nuvola di punti
    const pts = new THREE.Points(g, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: colored, color: colored ? 0xffffff : 0x6aa7d8 }));
    pts.name = t("off.vertici");
    obj.add(pts);
    tree.push({ name: pts.name, obj: pts, children: [] });
  }
  if (P.edges.length) {
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.BufferAttribute(P.pos, 3));
    lg.setIndex(P.edges);
    const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x333333 }));
    lines.name = t("off.spigoli");
    obj.add(lines);
    tree.push({ name: lines.name, obj: lines, children: [] });
  }
  ctx.offInfo = t("off.info", fmtNum(P.nv), fmtNum(P.nf));
  return { root, tree: [{ name: ctx.name, obj, children: tree }], animations: [] };
}
