// PCF di ISOGEN nel visualizzatore 3D: un oggetto per componente (tubi, curve ad arco vero, T e derivazioni, riduzioni, valvole,
// flange, supporti) con il diametro esterno dalla misura nominale, in millimetri e Z in alto (model3d.js ruota la scena).
// Gli attributi del file (SKEY, ITEM-CODE, descrizioni...) si leggono nelle proprieta' dell'oggetto selezionato. Lettura in pcfparse.js.
import * as THREE from "three";
import { fmtNum, t } from "./i18n.js";
import { parsePcf } from "./pcfparse.js";

const std = color => new THREE.MeshStandardMaterial({ color, metalness: 0.2, roughness: 0.55 });
const MAT = { pipe: std(0x5b8db8), fitting: std(0x4a7aa3), valve: std(0x8a5cc2), flange: std(0x6b7178), support: std(0xe0a020), other: std(0x1d9e75) };
const UP = new THREE.Vector3(0, 1, 0);
const V = p => new THREE.Vector3(p[0], p[1], p[2]);
function pick(m) { m.userData.pickParent = true; return m; }

function cyl(a, b, r1, r2, mat) {
  const L = a.distanceTo(b);
  if (!(L > 0) || !(r1 > 0)) return null;
  const m = pick(new THREE.Mesh(new THREE.CylinderGeometry(r2, r1, L, 32), mat));
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
  return m;
}

// curva: da A a B con il vertice C (punto d'incontro delle tangenti, come in ISOGEN); raggio dalla lunghezza della tangente
function arc(A, B, C, r, mat) {
  const u = C.clone().sub(A), v = B.clone().sub(C), T = u.length();
  if (!(T > 0) || !(v.length() > 0)) return null;
  u.normalize(); v.normalize();
  const th = Math.acos(Math.max(-1, Math.min(1, u.dot(v))));
  if (th < 1e-3) return cyl(A, B, r, r, mat);
  const R = T / Math.tan(th / 2), n = v.clone().addScaledVector(u, -u.dot(v)).normalize(), O = A.clone().addScaledVector(n, R);
  const a0 = A.clone().sub(O).normalize(), pts = [];
  const axis = new THREE.Vector3().crossVectors(a0, u).normalize();
  for (let i = 0; i <= 24; i++) pts.push(O.clone().add(a0.clone().applyAxisAngle(axis, (th * i) / 24).multiplyScalar(R)));
  const curve = new THREE.CatmullRomCurve3(pts);
  return pick(new THREE.Mesh(new THREE.TubeGeometry(curve, 48, r, 24, false), mat));
}

const KIND = type =>
  /^PIPE/.test(type) ? "pipe" : /^(ELBOW|BEND)/.test(type) ? "elbow" : /^(TEE|CROSS|OLET|Y-PIECE|LATERAL)/.test(type) ? "tee" :
  /^REDUCER/.test(type) ? "reducer" : /^(VALVE|INSTRUMENT|FILTER|TRAP|MISC)/.test(type) ? "valve" :
  /^(FLANGE|GASKET|CAP|COUPLING|UNION|BLIND)/.test(type) ? "flange" : /^SUPPORT/.test(type) ? "support" :
  /^(WELD|BOLT|MESSAGE|END-CONNECTION|END-POSITION)/.test(type) ? "skip" : "other";

export function loadPcf(ctx, bytes, ld) {
  ld.set(0.4, t("pcf.lettura"));
  const P = parsePcf(new TextDecoder("latin1").decode(bytes));
  if (!P.comps.some(c => c.ends.length || c.at)) throw new Error(t("pcf.non_pcf"));
  const root = new THREE.Group(), groups = new Map(), tree = new Map();
  const groupOf = type => {
    if (!groups.has(type)) { const g = new THREE.Group(); g.name = type; root.add(g); groups.set(type, g); tree.set(type, []); }
    return groups.get(type);
  };
  let drawn = 0, n = 0;
  for (const c of P.comps) {
    const kind = KIND(c.type);
    if (kind === "skip") continue;
    n++;
    const g = new THREE.Group();
    g.name = `${c.type}${c.attrs["ITEM-CODE"] ? " " + c.attrs["ITEM-CODE"] : ""}`;
    const ud = { [t("pcf.p_tipo")]: c.type };
    if (c.od) ud[t("pcf.p_diametro")] = `${fmtNum(c.od)} mm`;
    const bores = [...c.ends, c.branch].filter(q => q?.bore).map(q => fmtNum(q.bore));
    if (bores.length) ud[t("pcf.p_nominale")] = [...new Set(bores)].join(" / ") + (/INCH/i.test(P.boreUnit) ? '"' : " mm");
    c.ends.forEach((e, i) => { ud[t("pcf.p_estremo", i + 1)] = e.p.map(v => fmtNum(v)).join(" ; "); });
    if (c.centre) ud[t("pcf.p_centro")] = c.centre.p.map(v => fmtNum(v)).join(" ; ");
    if (c.branch) ud[t("pcf.p_derivazione")] = c.branch.p.map(v => fmtNum(v)).join(" ; ");
    for (const [k, v] of Object.entries(c.attrs)) ud[k] = v;
    g.userData = ud;
    const r = (c.od || 50) / 2, E = c.ends.map(e => V(e.p)), C = c.centre && V(c.centre.p), B = c.branch && V(c.branch.p);
    const add = m => { if (m) g.add(m); };
    if (kind === "pipe" && E.length >= 2) add(cyl(E[0], E[1], r, r, MAT.pipe));
    else if (kind === "elbow" && E.length >= 2) add((C && arc(E[0], E[1], C, r, MAT.fitting)) || cyl(E[0], E[1], r, r, MAT.fitting)); // vertice mancante o sovrapposto: tratto dritto
    else if (kind === "tee") {
      const M = C || (E.length >= 2 ? E[0].clone().add(E[1]).multiplyScalar(0.5) : E[0] || null); // OLET: solo il punto di attacco sul tubo
      if (M) {
        for (const e of E) add(cyl(M, e, r, r, MAT.fitting));
        for (const q of [c.branch, c.branch2]) if (q) add(cyl(M, V(q.p), (q.od || c.od || 50) / 2, (q.od || c.od || 50) / 2, MAT.fitting));
      }
    } else if (kind === "reducer" && E.length >= 2) add(cyl(E[0], E[1], (c.ends[0].od || c.od) / 2, (c.ends[1].od || c.od) / 2, MAT.fitting));
    else if (kind === "valve" && E.length >= 2) {
      const M = C || E[0].clone().add(E[1]).multiplyScalar(0.5);
      add(cyl(E[0], M, r * 1.15, r * 0.35, MAT.valve)); add(cyl(M, E[1], r * 0.35, r * 1.15, MAT.valve));
      const dir = E[1].clone().sub(E[0]).normalize(), side = Math.abs(dir.z) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
      add(cyl(M, M.clone().addScaledVector(side, r * 2.6), r * 0.12, r * 0.12, MAT.valve));
      const wheel = pick(new THREE.Mesh(new THREE.TorusGeometry(r * 0.8, r * 0.09, 12, 40), MAT.valve));
      wheel.position.copy(M).addScaledVector(side, r * 2.6); wheel.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), side); g.add(wheel);
    } else if (kind === "flange" && E.length >= 2) add(cyl(E[0], E[1], r * 1.6, r * 1.6, MAT.flange));
    else if ((kind === "flange" || kind === "other") && E.length === 1) {
      const s = pick(new THREE.Mesh(new THREE.SphereGeometry(r * 1.3, 24, 16), kind === "flange" ? MAT.flange : MAT.other));
      s.position.copy(E[0]); g.add(s);
    } else if (kind === "support" || (c.at && !E.length)) {
      const at = c.at ? V(c.at.p) : E[0];
      if (at) {
        const h = r * 2.2, cone = pick(new THREE.Mesh(new THREE.ConeGeometry(r * 0.9, h, 20), MAT.support));
        cone.position.copy(at).add(new THREE.Vector3(0, 0, -r - h / 2)); cone.quaternion.setFromUnitVectors(UP, new THREE.Vector3(0, 0, 1)); g.add(cone);
      }
    } else if (E.length >= 2) add(cyl(E[0], E[1], r, r, MAT.other));
    if (g.children.length) drawn++;
    groupOf(c.type).add(g);
    tree.get(c.type).push({ name: g.name, obj: g, children: [] });
  }
  const outTree = [...groups.entries()].map(([type, g]) => ({ name: `${type} (${tree.get(type).length})`, obj: g, children: tree.get(type) }));
  const note = [t("pcf.info", fmtNum(n), fmtNum(drawn)), t("pcf.diametri")];
  if (P.header["PIPELINE-REFERENCE"]) note.unshift(P.header["PIPELINE-REFERENCE"]);
  ctx.pcfInfo = note.join(" · ");
  return { root, tree: outTree, animations: [] };
}
