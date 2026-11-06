// Tubazioni .cii nel visualizzatore 3D: un cilindro o tronco di cono per tratto con il diametro vero (millimetri, Y in alto),
// nodi numerati, vincoli, valvole e curve disegnati; i dati del file si leggono nelle proprieta' dell'elemento selezionato.
// Lettura del testo in ciiparse.js (e dei .C2 di CAESAR II in c2parse.js, che passa i dati gia' letti). Le curve sono un anello
// sul nodo: il raccordo vero non e' costruito.
import * as THREE from "three";
import { fmtNum, t } from "./i18n.js";
import { parseCii, supportKind } from "./ciiparse.js";

const std = color => new THREE.MeshStandardMaterial({ color, metalness: 0.2, roughness: 0.55 });
function pick(mesh) { mesh.userData.pickParent = true; return mesh; } // il clic seleziona il tratto, il nodo o il vincolo
const UP = new THREE.Vector3(0, 1, 0), FRONT = new THREE.Vector3(0, 0, 1);

// numero del nodo: sempre leggibile e della stessa grandezza a schermo, non si seleziona
function nodeLabel(text) {
  const c = document.createElement("canvas"), g = c.getContext("2d");
  const font = "600 40px 'IBM Plex Sans', sans-serif";
  g.font = font;
  c.width = Math.ceil(g.measureText(text).width) + 32; c.height = 60;
  g.font = font;
  g.fillStyle = "rgba(30,32,34,.88)"; g.beginPath(); g.roundRect(0, 0, c.width, c.height, 10); g.fill();
  g.fillStyle = "#fff"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(text, c.width / 2, c.height / 2 + 2);
  const tx = new THREE.CanvasTexture(c); tx.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tx, depthTest: false, sizeAttenuation: false, transparent: true }));
  s.scale.set(0.03 * c.width / c.height, 0.03, 1);
  s.center.set(0.5, -0.5);
  s.renderOrder = 10;
  s.raycast = () => {};
  return s;
}

function ring(at, dir, radius, tube, mat) {
  const m = pick(new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 14, 48), mat));
  m.position.copy(at);
  m.quaternion.setFromUnitVectors(FRONT, dir);
  return m;
}

export function ciiHasGeometry(text) { return parseCii(text).elements.length > 0; }

export function loadCii(ctx, bytes, ld, parsed = null) {
  ld.set(0.4, t("cii.lettura"));
  const P = parsed || parseCii(new TextDecoder().decode(bytes));
  if (!P.elements.length) throw new Error(t("cii.nessun_tratto"));
  const pos = n => { const p = P.nodes.get(n); return p && new THREE.Vector3(p[0] * P.lenK, p[1] * P.lenK, p[2] * P.lenK); };
  const LEN = P.lengthUnit, DIA = P.odK === 1 ? "mm" : "in";
  const hot = P.odK === 1 ? " °C" : " °F", press = P.odK === 1 ? " bar" : " psi";
  const root = new THREE.Group();
  const group = key => { const g = new THREE.Group(); g.name = t(key); root.add(g); return g; };
  const gT = group("cii.tratti"), gN = group("cii.nodi"), gV = group("cii.vincoli"), gA = group("cii.valvole"), gB = group("cii.curve");
  const tree = { T: [], N: [], V: [], A: [], B: [] };
  const item = (list, parent, g) => { parent.add(g); list.push({ name: g.name, obj: g, children: [] }); };
  const mat = std(0x5b8db8), mAnchor = std(0xd85a30), mRestr = std(0xe0a020), mValve = std(0x8a5cc2), mBend = std(0x1d9e75), mRigid = std(0x8a5cc2);

  for (const e of P.elements) {
    const a = pos(e.from), b = pos(e.to), L = a.distanceTo(b), r1 = e.od1 * P.odK / 2, r2 = e.od2 * P.odK / 2;
    const g = new THREE.Group();
    g.name = `${e.from} - ${e.to}`;
    const ud = { [t("cii.p_da")]: e.from, [t("cii.p_a")]: e.to, [t("cii.p_lunghezza")]: `${fmtNum(e.len)} ${LEN} (${fmtNum(L / 1000)} m)`,
      DX: fmtNum(e.d[0]), DY: fmtNum(e.d[1]), DZ: fmtNum(e.d[2]), [t("cii.p_diametro")]: `${fmtNum(e.od)} ${DIA}`, [t("cii.p_spessore")]: `${fmtNum(e.wt)} ${DIA}` };
    if (e.reducer) ud[t("cii.p_riduzione")] = `${fmtNum(e.od1)} → ${fmtNum(e.od2)} ${DIA}`;
    if (e.temp !== null) ud[t("cii.p_temperatura")] = fmtNum(e.temp) + hot;
    if (e.press !== null) ud[t("cii.p_pressione")] = fmtNum(e.press) + press;
    if (e.extra !== null) ud[t("cii.p_colonna", 8)] = fmtNum(e.extra);
    if (e.rigid) ud[t("cii.p_rigido")] = e.weight ? `${fmtNum(e.weight)} kg` : "-";
    if (P.materials.length === 1) {
      const m = P.materials[0];
      ud[t("cii.p_materiale")] = m.id; ud[t("cii.p_modulo")] = m.e; ud[t("cii.p_poisson")] = m.nu; ud[t("cii.p_densita")] = m.rho;
    }
    g.userData = ud;
    if (L > 0 && r1 > 0) {
      // CylinderGeometry: raggio in alto e in basso, altezza lungo Y (qui da a verso b)
      const m = pick(new THREE.Mesh(new THREE.CylinderGeometry(e.rigid ? r2 * 1.25 : r2, e.rigid ? r1 * 1.25 : r1, L, 40), e.rigid ? mRigid : mat));
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
      g.add(m);
    }
    item(tree.T, gT, g);
  }

  for (const [n] of P.nodes) {
    const g = new THREE.Group(), p = pos(n), od = P.odOf(n) * P.odK || 1;
    g.name = t("cii.nodo", n);
    g.userData = { [t("cii.p_nodo")]: n, [t("cii.p_posizione")]: `${P.nodes.get(n).map(v => fmtNum(v)).join(" ; ")} ${LEN}` };
    const ball = pick(new THREE.Mesh(new THREE.SphereGeometry(od / 2 * 1.002, 32, 20), mat)); // raccordo tra i tratti
    ball.position.copy(p);
    const lab = nodeLabel(String(n));
    lab.position.copy(p);
    g.add(ball, lab);
    item(tree.N, gN, g);
  }

  let orphanS = 0;
  for (const s of P.supports) {
    const p = pos(s.node);
    if (!p) { orphanS++; continue; }
    const od = P.odOf(s.node) * P.odK || 1, k = supportKind(s.type), g = new THREE.Group();
    g.name = `${s.type} (${t("cii.nodo", s.node)})`;
    g.userData = { [t("cii.p_nodo")]: s.node, [t("cii.p_tipo")]: k.kind === "anchor" ? t("cii.ancoraggio") : k.kind === "guide" ? t("cii.guida") : k.kind === "axis" ? t("cii.vincolo_asse", s.type.replace(/^[^+-]*/, "") + "XYZ"[k.axis]) : s.type };
    if (s.mu) g.userData[t("cii.p_attrito")] = fmtNum(s.mu);
    if (k.kind === "anchor") {
      const m = pick(new THREE.Mesh(new THREE.BoxGeometry(od * 1.7, od * 1.7, od * 1.7), mAnchor));
      m.position.copy(p);
      g.add(m);
    } else if (k.kind === "guide") {
      g.add(ring(p, new THREE.Vector3(...P.axisAt(s.node)), od * 0.78, od * 0.11, mRestr));
    } else {
      // freccia verso il tubo dal lato negativo dell'asse: appoggio sotto il tubo per Y
      const dir = new THREE.Vector3().setComponent(k.kind === "axis" ? k.axis : 1, 1);
      const h = od * 1.2, gap = od / 2;
      const cone = pick(new THREE.Mesh(new THREE.ConeGeometry(od * 0.55, h, 24), mRestr));
      cone.position.copy(p).addScaledVector(dir, -gap - h / 2);
      cone.quaternion.setFromUnitVectors(UP, dir);
      const base = pick(new THREE.Mesh(new THREE.CylinderGeometry(od * 0.9, od * 0.9, od * 0.12, 32), mRestr));
      base.position.copy(p).addScaledVector(dir, -gap - h - od * 0.06);
      base.quaternion.setFromUnitVectors(UP, dir);
      g.add(cone, base);
    }
    item(tree.V, gV, g);
  }

  let orphanA = 0, deducedA = 0;
  for (const v of P.valves) {
    if (!v.pos) { orphanA++; continue; }
    if (v.deduced) deducedA++;
    const p = new THREE.Vector3(...v.pos).multiplyScalar(P.lenK), dir = new THREE.Vector3(...v.axis), od = (v.od || 1) * P.odK;
    const L = v.len > 0 ? v.len * P.odK : od * 1.5, g = new THREE.Group();
    g.name = `${t("cii.valvola")} ${v.node}`;
    g.userData = { [t("cii.p_nodo")]: v.node, [t("cii.p_tipo")]: v.type || "-" };
    if (v.len !== null) g.userData[t("cii.p_lunghezza_ded")] = `${fmtNum(v.len)} ${DIA}`;
    if (v.other !== null) g.userData[t("cii.p_colonna", 4)] = v.other;
    if (v.deduced) g.userData[t("cii.p_posizione")] = t("cii.pos_dedotta");
    // corpo piu' largo del tubo, stelo con volantino verso l'alto (di lato se la linea e' verticale), flange alle estremita' per FLG
    const body = pick(new THREE.Mesh(new THREE.SphereGeometry(od * 0.72, 32, 20), mValve));
    body.position.copy(p);
    g.add(body);
    const side = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP.clone();
    const stem = pick(new THREE.Mesh(new THREE.CylinderGeometry(od * 0.07, od * 0.07, od * 1.4, 16), mValve));
    stem.position.copy(p).addScaledVector(side, od * 0.7);
    stem.quaternion.setFromUnitVectors(UP, side);
    g.add(stem, ring(p.clone().addScaledVector(side, od * 1.4), side, od * 0.42, od * 0.05, mValve));
    if (/FL/.test(v.type)) for (const s of [-1, 1]) {
      const f = pick(new THREE.Mesh(new THREE.CylinderGeometry(od * 0.85, od * 0.85, od * 0.12, 40), mValve));
      f.position.copy(p).addScaledVector(dir, s * L / 2);
      f.quaternion.setFromUnitVectors(UP, dir);
      g.add(f);
    }
    const lab = nodeLabel(String(v.node));
    lab.position.copy(p);
    g.add(lab);
    item(tree.A, gA, g);
  }

  let orphanB = 0, straightB = 0;
  for (const b of P.bends) {
    const p = pos(b.node);
    if (!p) { orphanB++; continue; }
    if (b.angle !== null && b.angle < 1) straightB++;
    const od = P.odOf(b.node) * P.odK || 1, g = new THREE.Group();
    g.name = `${t("cii.curva")} ${b.node}`;
    g.userData = { [t("cii.p_nodo")]: b.node, [t("cii.p_tipo")]: b.type || "-" };
    if (b.angle !== null) g.userData[t("cii.p_angolo")] = `${fmtNum(b.angle)}°`;
    if (b.radius) g.userData[t("cii.p_raggio")] = `${fmtNum(b.radius)} ${DIA}`;
    g.add(ring(p, new THREE.Vector3(...P.axisAt(b.node)), od * 0.6, od * 0.07, mBend));
    item(tree.B, gB, g);
  }

  const entry = (g, list) => (list.length ? [{ name: `${g.name} (${list.length})`, obj: g, children: list }] : []);
  const outTree = [...entry(gT, tree.T), ...entry(gN, tree.N), ...entry(gV, tree.V), ...entry(gA, tree.A), ...entry(gB, tree.B)];

  // cio' che il file non dice e l'app ha dedotto resta sempre scritto, cosi' come cio' che non torna
  const note = [t("cii.info", fmtNum(tree.T.length), fmtNum(tree.N.length), fmtNum(tree.V.length)), P.caesar ? t("cii.c2_note") : t(`cii.unita_${P.lengthUnit}`)];
  if (P.rigids?.length) note.push(t("cii.rigidi", P.rigids.length));
  if (deducedA) note.push(t("cii.valvole_dedotte", deducedA));
  if (straightB) note.push(t("cii.curve_dritte", straightB));
  if (P.pieces > 1) note.push(t("cii.pezzi", P.pieces));
  if (P.mismatches) note.push(t("cii.chiusure", P.mismatches));
  const orphans = orphanS + orphanA + orphanB + P.orphanReducers;
  if (orphans) note.push(t("cii.orfani", orphans));
  if (P.materials.length > 1) note.push(t("cii.materiali_piu", P.materials.length));
  if (P.ignored.length) note.push(t("cii.sezioni_ignorate", P.ignored.join(", ")));
  ctx.ciiInfo = note.join(" · ");
  return { root, tree: outTree, animations: [] };
}
