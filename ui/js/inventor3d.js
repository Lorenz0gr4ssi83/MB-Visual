// Autodesk Inventor (.ipt / .iam) senza Inventor: il motore Python (mbvisual/inventor.py) converte ogni parte in
// STEP (cache su disco) e descrive l'assieme (occorrenze, matrici, sottoassiemi); qui ogni parte si legge una volta
// con OpenCascade e si ripete in tutte le sue occorrenze (geometria condivisa).
import * as THREE from "three";
import { api, fileUrl, waitJob } from "./core.js";

const PARAMS = { linearUnit: "millimeter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.001, angularDeflection: 0.5 };

// lettori OpenCascade in parallelo (ognuno carica il motore una sola volta)
function makePool(n) {
  const workers = [], waiting = new Map();
  let seq = 0;
  for (let i = 0; i < n; i++) {
    const w = new Worker("/js/occtworker.js");
    w.onmessage = ev => { const p = waiting.get(ev.data.id); waiting.delete(ev.data.id); if (p) ev.data.error ? p.reject(new Error(ev.data.error)) : p.resolve(ev.data.result); };
    w.onerror = e => { for (const [id, p] of waiting) if (p.w === w) { waiting.delete(id); p.reject(new Error(e.message || "Errore nel lettore CAD")); } };
    workers.push({ w, busy: 0 });
  }
  return {
    read(buffer) {
      const slot = workers.reduce((a, b) => (b.busy < a.busy ? b : a));
      slot.busy++;
      const id = ++seq;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject, w: slot.w });
        slot.w.postMessage({ id, format: "step", buffer, params: PARAMS }, [buffer.buffer]);
      }).finally(() => slot.busy--);
    },
    close() { workers.forEach(s => s.w.terminate()); },
  };
}

// mesh di OpenCascade -> modello della parte (geometrie e materiali condivisi da tutte le occorrenze)
function partTemplate(res, fallbackColor) {
  const mats = new Map();
  const matFor = c => {
    const k = c.map(v => v.toFixed(3)).join();
    if (!mats.has(k)) mats.set(k, new THREE.MeshStandardMaterial({ color: new THREE.Color(c[0], c[1], c[2]), metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide }));
    return mats.get(k);
  };
  const base = fallbackColor || [0.74, 0.75, 0.77];
  return res.meshes.map((m, i) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
    if (m.attributes.normal) g.setAttribute("normal", new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
    if (m.index) g.setIndex(m.index.array);
    if (!m.attributes.normal) g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    let material = matFor(m.color || base);
    if (m.brep_faces && m.index && m.brep_faces.some(f => f.color)) {
      const list = [material];
      for (const f of m.brep_faces) {
        let mi = 0;
        if (f.color) { list.push(matFor(f.color)); mi = list.length - 1; }
        g.addGroup(f.first * 3, (f.last - f.first + 1) * 3, mi);
      }
      material = list;
    }
    return { geometry: g, material, name: m.name || `Corpo ${i + 1}` };
  });
}

// iProperties -> righe [categoria, nome, valore] (stesso formato della scheda Navisworks)
function propRows(part, extra) {
  const rows = [];
  for (const [k, v] of extra) if (v) rows.push(["Documento", k, v]);
  for (const g of part?.gruppi || []) for (const [k, v] of g.voci) rows.push([g.nome, k, v]);
  return rows;
}

function summary(rep, miss) {
  const tot = rep?.["facce totali"] || 0, ok = rep?.["facce convertite"] || 0;
  return { tot, ok, miss: Object.entries(miss || {}).map(([k, v]) => `${k}: ${v}`) };
}

export async function loadInventor(ctx, ld, info) {
  ld.set(0.05, "Lettura del file Inventor (senza Inventor)");
  const { job } = await api("inventor", { path: ctx.path });
  const res = await waitJob(job, (p, m) => ld.set(0.05 + 0.35 * p, m || "Conversione della geometria"));
  const keys = Object.keys(res.parti).filter(k => res.parti[k].step);
  const pool = makePool(Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1, keys.length)));
  const templates = new Map(), errors = [];
  let done = 0;
  try {
    await Promise.all(keys.map(async k => {
      const p = res.parti[k];
      try {
        const buf = new Uint8Array(await (await fetch(fileUrl(p.step))).arrayBuffer());
        const r = await pool.read(buf);
        if (!r || r.success === false) throw new Error("STEP non leggibile");
        templates.set(k, partTemplate(r, p.colore));
      } catch (e) { errors.push(`${p.nome}: ${e.message}`); }
      done++;
      ld.set(0.4 + 0.5 * done / keys.length, `Tassellazione delle parti (${done} di ${keys.length})`);
    }));
  } finally { pool.close(); }

  // scena: un gruppo per occorrenza con la sua matrice; le mesh delle parti sono figlie dirette dell'occorrenza
  // (il clic seleziona il componente intero, come in Inventor)
  const root = new THREE.Group();
  root.name = ctx.name;
  let nid = 0, nOcc = 0, faces = 0, facesOk = 0;
  const problems = new Map();
  const tmp = new THREE.Matrix4();
  const build = (nodes, parent, out) => {
    for (const n of nodes) {
      const g = new THREE.Group();
      g.name = n.nome;
      const m = n.matrice;
      tmp.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], m[12], m[13], m[14], m[15]);
      tmp.decompose(g.position, g.quaternion, g.scale);
      parent.add(g);
      const item = { name: n.nome, obj: g, children: [] };
      out.push(item);
      if (n.figli) {
        build(n.figli, g, item.children);
        g.userData.navisProps = [["Documento", "File", n.file || ""], ["Documento", "Tipo", "Sottoassieme"]];
        continue;
      }
      const id = nid++;
      g.userData.navisId = id;
      if (n.mancante) {
        g.name = item.name = `${n.nome} (file non trovato)`;
        g.userData.navisProps = [["Documento", "File non trovato", n.mancante]];
        continue;
      }
      nOcc++;
      const p = res.parti[n.parte];
      const s = summary(p?.rapporto, p?.mancanti);
      faces += s.tot;
      facesOk += s.ok;
      if (s.tot > s.ok || !p?.step) problems.set(p?.nome || n.nome, s);
      g.userData.navisProps = propRows(p, [["File", p?.file], ["Facce convertite", s.tot ? `${s.ok} di ${s.tot}` : ""],
        ...(s.miss.length ? [["Elementi non convertiti", s.miss.join("; ")]] : []), ...(p?.errore ? [["Errore", p.errore]] : [])]);
      g.userData.classe = res.tipo === "parte" ? "Parte" : "Componente";
      for (const t of templates.get(n.parte) || []) {
        const mesh = new THREE.Mesh(t.geometry, t.material);
        mesh.name = t.name;
        mesh.userData.navisId = id;
        g.add(mesh);
      }
    }
  };
  build(res.albero || [], root, []);
  const tree = [];
  // albero: per una parte singola i corpi, per un assieme i componenti
  for (const g of root.children) tree.push(treeOf(g));
  const parts = [];
  if (res.tipo === "assieme") parts.push(`${nOcc} componenti, ${Object.keys(res.parti).length} parti diverse`);
  if (faces) parts.push(faces === facesOk ? `${faces} facce convertite` : `${facesOk} di ${faces} facce convertite`);
  if (res.mancanti?.length) parts.push(`${res.mancanti.length} file non trovati`);
  info.status = "Inventor senza Inventor: " + parts.join(", ");
  info.inventor = { res, problems: [...problems.entries()], errors, root };
  if (res.gruppi?.length) root.userData.navisProps = propRows({ gruppi: res.gruppi }, []);
  return { root, tree };
}

function treeOf(g) {
  const kids = g.children.filter(c => c.isGroup).map(treeOf);
  return { name: g.name, obj: g, children: kids };
}

// avvisi da mostrare una volta aperto il modello (file mancanti, facce non convertite)
export function inventorWarnings(inv) {
  if (!inv) return [];
  const out = [];
  const { res, problems, errors } = inv;
  if (res.mancanti?.length) out.push(`File non trovati (${res.mancanti.length}): ` + res.mancanti.slice(0, 6).map(p => p.split(/[\\/]/).pop()).join(", ") + (res.mancanti.length > 6 ? "..." : "") + ". Mettili nella cartella dell'assieme o in una sua sottocartella.");
  for (const [name, s] of problems.slice(0, 5)) out.push(s.tot ? `${name}: convertite ${s.ok} facce su ${s.tot}` + (s.miss.length ? ` (${s.miss.join("; ")})` : "") : `${name}: geometria non leggibile`);
  for (const e of errors.slice(0, 3)) out.push(e);
  for (const n of res.note || []) out.push(n);
  return out;
}
