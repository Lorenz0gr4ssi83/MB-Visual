// Navisworks (NWD/NWC) senza Navisworks: il lettore nwd2mbv (libreria open source nwd-reader) converte il file in
// gerarchia + proprieta' (json) e geometria (bin, coordinate di mondo in metri); qui si costruisce la scena three.js.
import * as THREE from "three";
import { api, fileUrl } from "./core.js";

export async function loadNavis(ctx, ld) {
  ld.set(0.15, "Lettura del file Navisworks (senza Navisworks)");
  const r = await api("nwd_convert", { path: ctx.path });
  ld.set(0.45, "Caricamento della geometria");
  const [meta, bin] = await Promise.all([
    fetch(fileUrl(r.json)).then(x => x.json()),
    fetch(fileUrl(r.bin)).then(x => x.arrayBuffer()),
  ]);
  ld.set(0.7, "Preparazione del modello");
  const root = new THREE.Group();
  root.name = ctx.name;
  // un gruppo per ogni nodo della gerarchia di Navisworks
  // i nodi senza nome (parti, solidi) prendono il nome del componente che li contiene, come in Navisworks
  const names = [];
  meta.nodes.forEach(([parent, name, cls], i) => { names[i] = name || (parent >= 0 && parent < i ? names[parent] : "") || (cls || "Elemento").replace(/^lcatfconsumer_|^LcOp|^LcDWG/, ""); });
  const groups = meta.nodes.map(([, name, cls], i) => {
    const g = new THREE.Group();
    g.name = names[i];
    g.userData.navisId = i;
    if (cls) g.userData.classe = cls.replace(/^lcatfconsumer_|^LcOp|^LcDWG/, "");
    const pr = meta.props[i];
    if (pr) g.userData.navisProps = pr;
    return g;
  });
  meta.nodes.forEach(([parent], i) => (parent >= 0 && groups[parent] ? groups[parent] : root).add(groups[i]));
  // mesh: materiali condivisi per colore
  const mats = new Map();
  const matFor = (kind, c, a) => {
    const key = kind + c.map(v => v.toFixed(3)).join() + a.toFixed(2);
    if (!mats.has(key)) {
      const color = new THREE.Color(c[0], c[1], c[2]);
      mats.set(key, kind === "t" ? new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.65, side: THREE.DoubleSide, transparent: a < 0.999, opacity: a, depthWrite: a >= 0.999 })
        : kind === "l" ? new THREE.LineBasicMaterial({ color }) : new THREE.PointsMaterial({ color, size: 3, sizeAttenuation: false }));
    }
    return mats.get(key);
  };
  let tri = 0;
  // Modelli grandi: la geometria si disegna unita per colore (poche chiamate di disegno, fluida anche con milioni di
  // triangoli). Ogni elemento resta un oggetto proprio con una copia invisibile della sua geometria: serve a
  // evidenziarlo, misurarlo e inquadrarlo. Il clic risale all'elemento dal triangolo colpito.
  const MERGE = meta.meshes.length > 3000;
  const batches = new Map(); // materiale -> { kind, parts: [{ m, pos, idx }] }
  for (const m of meta.meshes) {
    const pos = new Float32Array(bin, m.p[0], m.p[1] * 3);
    const idx = new Uint32Array(bin, m.i[0], m.i[1]);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const mat = matFor(m.k, m.c, m.k === "t" ? m.a : 1);
    let obj;
    if (m.k === "t") { if (!MERGE) g.computeVertexNormals(); obj = new THREE.Mesh(g, mat); tri += m.i[1] / 3; }
    else if (m.k === "l") obj = new THREE.LineSegments(g, mat);
    else obj = new THREE.Points(g, mat);
    const owner = groups[m.n] || root;
    obj.name = owner.name;
    obj.userData.navisId = m.n;
    if (MERGE) {
      obj.visible = false;
      obj.userData.proxy = true; // visibile solo quando l'elemento e' selezionato
      obj.raycast = () => {};
      if (!batches.has(mat)) batches.set(mat, { kind: m.k, parts: [] });
      batches.get(mat).parts.push({ m, pos, idx, owner });
    }
    owner.add(obj);
  }
  if (MERGE) buildBatches(root, batches);
  root.userData.triangles = tri;
  // albero: i nodi senza geometria in nessun discendente si omettono (riferimenti vuoti, materiali)
  const hasGeom = new Uint8Array(groups.length);
  for (const m of meta.meshes) for (let n = m.n; n >= 0 && !hasGeom[n]; n = meta.nodes[n][0]) hasGeom[n] = 1;
  const kids = groups.map(() => []);
  const tops = [];
  meta.nodes.forEach(([parent], i) => { if (!hasGeom[i]) return; (parent >= 0 ? kids[parent] : tops).push(i); });
  // voci create una volta sola (l'albero le collega agli oggetti del modello in entrambi i sensi)
  const items = new Array(groups.length);
  const item = i => (items[i] ??= { name: groups[i].name + (kids[i].length ? ` (${kids[i].length})` : ""), obj: groups[i], children: [] });
  for (let i = 0; i < groups.length; i++) if (hasGeom[i]) item(i).children = kids[i].map(item);
  const tree = tops.map(item);
  ctx.navisInfo = `Navisworks: ${meta.nodes.length.toLocaleString("it-IT")} nodi, ${Math.round(tri).toLocaleString("it-IT")} triangoli` + (meta.skipped ? ` · ${meta.skipped} elementi non disegnabili (testi, nuvole di punti esterne)` : "");
  return { root, tree };
}

// scheda delle proprieta' Navisworks: una sezione per categoria, con ricerca e copia
export function navisSheet(props, el, toast) {
  const byCat = new Map();
  for (const [cat, name, value] of props) {
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push([name, value]);
  }
  const root = el("div", { class: "bim" });
  for (const [cat, rows] of byCat) {
    const dl = el("dl", { class: "kv stack" });
    for (const [k, v] of rows) dl.append(el("dt", {}, k || "-"), el("dd", {}, v));
    root.append(el("details", { open: true }, el("summary", {}, cat || "Proprieta'"), dl));
  }
  const copy = el("button", { class: "btn", onclick: () => navigator.clipboard?.writeText(props.map(r => r.join("\t")).join("\n")).then(() => toast("Proprieta' copiate")) }, "Copia proprieta'");
  return el("div", {}, el("div", { style: { margin: "8px 0 4px" } }, copy), root);
}

// Copia invisibile di un elemento che usa gli stessi vertici del blocco unito (nessun dato duplicato): serve per
// evidenziare, inquadrare e misurare l'elemento selezionato. box = riquadro dell'elemento [minx,miny,minz,maxx,maxy,maxz].
export function sharedProxy(part, mat) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", part.geom.attributes.position);
  if (part.geom.attributes.normal) g.setAttribute("normal", part.geom.attributes.normal);
  g.setIndex(new THREE.BufferAttribute(part.all.subarray(part.start, part.start + part.count), 1));
  const b = part.box;
  g.boundingBox = new THREE.Box3(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5]));
  g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
  const m = new THREE.Mesh(g, mat);
  m.visible = false;
  m.userData.proxy = true;
  m.raycast = () => {};
  return m;
}

// Blocchi uniti per materiale. refresh() li ricostruisce saltando gli elementi nascosti (Nascondi, Isola, caselle
// dell'albero); pick(oggetto, triangolo) restituisce l'elemento colpito.
export function buildBatches(root, batches) {
  const merged = [];
  for (const [mat, b] of batches) {
    let nv = 0, ni = 0;
    for (const p of b.parts) { nv += p.pos.length; ni += p.idx.length; }
    const pos = new Float32Array(nv);
    const withNrm = b.parts.every(p => p.nrm); // normali gia' pronte (IFC): niente ricalcolo
    const nrm = withNrm ? new Float32Array(nv) : null;
    const all = new Uint32Array(ni);
    const ranges = []; // per ogni parte: inizio e numero di indici nel blocco completo
    let ov = 0, oi = 0;
    for (const p of b.parts) {
      pos.set(p.pos, ov);
      if (nrm) nrm.set(p.nrm, ov);
      const base = ov / 3;
      for (let k = 0; k < p.idx.length; k++) all[oi + k] = p.idx[k] + base;
      ranges.push([oi, p.idx.length, p.owner]);
      p.start = oi;
      p.count = p.idx.length;
      ov += p.pos.length;
      oi += p.idx.length;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(all, 1));
    if (nrm) g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    else if (b.kind === "t") g.computeVertexNormals();
    g.computeBoundingSphere();
    // le parti possono condividere i dati del blocco (proxy senza copia: vedi sharedProxy); i dati sorgente si liberano
    for (const p of b.parts) { p.geom = g; p.all = all; if (p.shared) { p.pos = p.nrm = p.idx = null; } }
    const obj = b.kind === "t" ? new THREE.Mesh(g, mat) : b.kind === "l" ? new THREE.LineSegments(g, mat) : new THREE.Points(g, mat);
    obj.userData.merged = { all, ranges, per: b.kind === "t" ? 3 : b.kind === "l" ? 2 : 1, owners: null };
    obj.name = "";
    merged.push(obj);
    root.add(obj);
  }
  const visibleChain = o => { while (o) { if (!o.visible) return false; o = o.parent; } return true; };
  root.userData.refresh = () => {
    for (const obj of merged) {
      const M = obj.userData.merged;
      const cache = new Map();
      const vis = owner => { if (!cache.has(owner)) cache.set(owner, visibleChain(owner)); return cache.get(owner); };
      let n = 0;
      for (const [s, c, owner] of M.ranges) if (vis(owner)) n += c;
      const idx = n === M.all.length ? M.all : new Uint32Array(n);
      const owners = [];
      let o = 0;
      for (const [s, c, owner] of M.ranges) {
        if (!vis(owner)) continue;
        if (idx !== M.all) idx.set(M.all.subarray(s, s + c), o);
        owners.push([o / M.per, owner]);
        o += c;
      }
      M.owners = owners;
      obj.geometry.setIndex(new THREE.BufferAttribute(idx, 1));
      obj.visible = n > 0;
    }
  };
  // elemento colpito: ricerca binaria del triangolo (o segmento, o punto) negli intervalli visibili
  root.userData.pick = (obj, faceIndex) => {
    const owners = obj.userData.merged?.owners;
    if (!owners?.length || faceIndex == null) return null;
    let lo = 0, hi = owners.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (owners[mid][0] <= faceIndex) lo = mid; else hi = mid - 1; }
    return owners[lo][1];
  };
  root.userData.refresh();
}
