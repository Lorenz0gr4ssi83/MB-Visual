// Modelli 3D: CAD (STEP/IGES/BREP con OpenCascade), BIM (IFC con web-ifc), mesh (STL, OBJ, GLB, FBX...).
// Navigazione orbitale, albero parti, nascondi/isola, sezioni, misure, filo di ferro, proprieta' BIM, esportazione.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { api, button, dirName, el, fileUrl, loading, pickFiles, readBytes, saveBlobAs, toast, withExt } from "../core.js";
import { isDark } from "../monaco.js";

const LOADERS = {
  stl: ["STLLoader", "STLLoader"], obj: ["OBJLoader", "OBJLoader"], ply: ["PLYLoader", "PLYLoader"], gltf: ["GLTFLoader", "GLTFLoader"],
  glb: ["GLTFLoader", "GLTFLoader"], fbx: ["FBXLoader", "FBXLoader"], "3ds": ["TDSLoader", "TDSLoader"], dae: ["ColladaLoader", "ColladaLoader"],
  "3mf": ["3MFLoader", "ThreeMFLoader"], amf: ["AMFLoader", "AMFLoader"], wrl: ["VRMLLoader", "VRMLLoader"], vrml: ["VRMLLoader", "VRMLLoader"],
  vtk: ["VTKLoader", "VTKLoader"], vtp: ["VTKLoader", "VTKLoader"], pcd: ["PCDLoader", "PCDLoader"], xyz: ["XYZLoader", "XYZLoader"],
  usdz: ["USDZLoader", "USDZLoader"], lwo: ["LWOLoader", "LWOLoader"], md2: ["MD2Loader", "MD2Loader"], pdb: ["PDBLoader", "PDBLoader"],
  kmz: ["KMZLoader", "KMZLoader"], bvh: ["BVHLoader", "BVHLoader"], vox: ["VOXLoader", "VOXLoader"],
  "3dm": ["3DMLoader", "Rhino3dmLoader"],
};
const NAVIS = { nwd: 1, nwc: 1, nwf: 1 }; // Navisworks letto da nwd2mbv (senza Navisworks)
const OCCT = { step: "step", stp: "step", p21: "step", stpz: "step", iges: "iges", igs: "iges", brep: "brep", brp: "brep" };

// ---------------------------------------------------------------- caricamento
function occtRead(format, buffer) {
  return new Promise((resolve, reject) => {
    const w = new Worker(window.MBV_ROOT + "vendor/occt/dist/occt-import-js-worker.js");
    w.onmessage = ev => { w.terminate(); ev.data && ev.data.success !== false ? resolve(ev.data) : reject(new Error("OpenCascade non e' riuscito a leggere il modello")); };
    w.onerror = e => { w.terminate(); reject(new Error(e.message || "Errore nel lettore CAD")); };
    w.postMessage({ format, buffer, params: { linearUnit: "millimeter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.001, angularDeflection: 0.5 } });
  });
}

async function loadOcct(ctx, bytes, ld) {
  let buf = bytes;
  if (ctx.ext === "stpz") buf = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  ld.set(0.2, "Lettura del modello CAD con OpenCascade (puo' richiedere qualche secondo)");
  const res = await occtRead(OCCT[ctx.ext], buf);
  const root = new THREE.Group();
  const meshes = res.meshes.map((m, i) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
    if (m.attributes.normal) g.setAttribute("normal", new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
    if (m.index) g.setIndex(m.index.array);
    if (!m.attributes.normal) g.computeVertexNormals();
    const c = m.color ? new THREE.Color(m.color[0], m.color[1], m.color[2]) : new THREE.Color(0.72, 0.74, 0.76);
    const mat = new THREE.MeshStandardMaterial({ color: c, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide });
    // colori per faccia (brep_faces)
    if (m.brep_faces && m.brep_faces.some(f => f.color) && m.index) {
      const groupsMats = [mat];
      for (const f of m.brep_faces) {
        let mi = 0;
        if (f.color) { groupsMats.push(new THREE.MeshStandardMaterial({ color: new THREE.Color(...f.color), metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide })); mi = groupsMats.length - 1; }
        g.addGroup(f.first * 3, (f.last - f.first + 1) * 3, mi);
      }
      const mesh = new THREE.Mesh(g, groupsMats);
      mesh.name = m.name || `Parte ${i + 1}`;
      return mesh;
    }
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = m.name || `Parte ${i + 1}`;
    return mesh;
  });
  const tree = [];
  function walk(node, parent, out) {
    const grp = new THREE.Group();
    grp.name = node.name || "Assieme";
    parent.add(grp);
    const item = { name: grp.name, obj: grp, children: [] };
    for (const mi of node.meshes || []) { const m = meshes[mi]; grp.add(m); item.children.push({ name: m.name, obj: m, children: [] }); }
    for (const ch of node.children || []) walk(ch, grp, item.children);
    out.push(item);
  }
  if (res.root) walk(res.root, root, tree);
  else meshes.forEach(m => { root.add(m); tree.push({ name: m.name, obj: m, children: [] }); });
  return { root, tree };
}

async function loadIfc(ctx, bytes, ld, info) {
  ld.set(0.15, "Apertura del modello BIM");
  let ifc = info.ifc;
  if (!ifc) {
    const WEBIFC = await import(window.MBV_ROOT + "vendor/web-ifc/web-ifc-api.js");
    info.WEBIFC = WEBIFC;
    ifc = new WEBIFC.IfcAPI();
    ifc.SetWasmPath(window.MBV_ROOT + "vendor/web-ifc/", true);
    // thread singolo: la pagina e' isolata (COOP/COEP per ONLYOFFICE) e web-ifc sceglierebbe la versione multi-thread,
    // i cui worker non partono dal pacchetto unico: Init() restava in attesa per sempre e nessun IFC si apriva
    await ifc.Init(undefined, true);
  }
  let modelID, shift = null;
  ld.set(0.2, `Lettura della struttura BIM (${(bytes.length / 1048576).toFixed(0)} MB)`);
  await new Promise(r => setTimeout(r, 30)); // lascia disegnare il messaggio prima del lavoro lungo
  if (info.coordMatrix) {
    // modelli federati: stesso spostamento verso l'origine del primo modello, cosi' restano allineati
    modelID = ifc.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });
    shift = new THREE.Matrix4().fromArray(info.coordMatrix);
  } else {
    modelID = ifc.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true });
  }
  const root = new THREE.Group();
  const byType = new Map();
  const mats = new Map();
  const matFor = c => {
    const k = [c.x, c.y, c.z, c.w].map(v => v.toFixed(3)).join();
    if (!mats.has(k)) mats.set(k, new THREE.MeshStandardMaterial({ color: new THREE.Color(c.x, c.y, c.z), opacity: c.w, transparent: c.w < 0.999, side: THREE.DoubleSide, metalness: 0.05, roughness: 0.7, depthWrite: c.w >= 0.999 }));
    return mats.get(k);
  };
  let count = 0;
  // modelli grandi: geometria disegnata unita per colore (poche chiamate di disegno, fluida con milioni di triangoli);
  // ogni elemento ha una copia invisibile che condivide i vertici del blocco (per evidenziarlo, inquadrarlo, misurarlo)
  const MERGE = bytes.length > 15 * 1048576;
  const batches = new Map();
  const tmpN = new THREE.Matrix3(), tmpM = new THREE.Matrix4();
  const onMesh = fm => {
    const id = fm.expressID;
    const grp = new THREE.Group();
    grp.userData.expressID = id;
    grp.userData.modelID = modelID;
    const pgs = fm.geometries;
    for (let k = 0; k < pgs.size(); k++) {
      const pg = pgs.get(k);
      const geom = ifc.GetGeometry(modelID, pg.geometryExpressID);
      const v = ifc.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const idx = ifc.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      const mat = matFor(pg.color);
      tmpM.fromArray(pg.flatTransformation);
      if (shift) tmpM.premultiply(shift);
      if (MERGE) {
        // dati gia' nella posizione finale, nel blocco del suo colore; la copia per la selezione li condivide
        const e = tmpM.elements, nm = tmpN.getNormalMatrix(tmpM).elements;
        const n = v.length / 6, pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
        const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (let q = 0, a = 0, b = 0; q < n; q++, a += 6, b += 3) {
          const x = v[a], y = v[a + 1], z = v[a + 2], nx = v[a + 3], ny = v[a + 4], nz = v[a + 5];
          const X = e[0] * x + e[4] * y + e[8] * z + e[12], Y = e[1] * x + e[5] * y + e[9] * z + e[13], Z = e[2] * x + e[6] * y + e[10] * z + e[14];
          pos[b] = X; pos[b + 1] = Y; pos[b + 2] = Z;
          if (X < box[0]) box[0] = X; if (Y < box[1]) box[1] = Y; if (Z < box[2]) box[2] = Z;
          if (X > box[3]) box[3] = X; if (Y > box[4]) box[4] = Y; if (Z > box[5]) box[5] = Z;
          nrm[b] = nm[0] * nx + nm[3] * ny + nm[6] * nz;
          nrm[b + 1] = nm[1] * nx + nm[4] * ny + nm[7] * nz;
          nrm[b + 2] = nm[2] * nx + nm[5] * ny + nm[8] * nz;
        }
        if (!batches.has(mat)) batches.set(mat, { kind: "t", parts: [] });
        batches.get(mat).parts.push({ pos, nrm, idx: new Uint32Array(idx), owner: grp, box, mat, shared: true });
      } else {
        const g = new THREE.BufferGeometry();
        const inter = new THREE.InterleavedBuffer(new Float32Array(v), 6);
        g.setAttribute("position", new THREE.InterleavedBufferAttribute(inter, 3, 0));
        g.setAttribute("normal", new THREE.InterleavedBufferAttribute(inter, 3, 3));
        g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
        const mesh = new THREE.Mesh(g, mat);
        mesh.matrix.copy(tmpM);
        mesh.matrixAutoUpdate = false;
        mesh.userData.expressID = id;
        grp.add(mesh);
      }
      geom.delete?.();
    }
    let tname = "Elemento";
    try { tname = ifc.GetNameFromTypeCode(ifc.GetLineType(modelID, id)); } catch { /* */ }
    grp.name = tname;
    if (!byType.has(tname)) byType.set(tname, []);
    byType.get(tname).push(grp);
    root.add(grp);
    count++;
  };
  // elementi letti a blocchi: avanzamento reale e interfaccia che resta viva anche con modelli da centinaia di MB
  let ids = null;
  try {
    const W = info.WEBIFC;
    const skip = new Set([W.IFCOPENINGELEMENT, W.IFCSPACE, W.IFCOPENINGSTANDARDCASE].filter(Boolean));
    const all = ifc.GetLineIDsWithType(modelID, W.IFCPRODUCT, true);
    ids = [];
    for (let k = 0; k < all.size(); k++) { const id = all.get(k); if (!skip.has(ifc.GetLineType(modelID, id))) ids.push(id); }
  } catch (e) { console.warn("IFC: elenco elementi non disponibile, lettura in un passo", e); ids = null; }
  if (ids && ids.length) {
    const STEP = 1500;
    for (let s = 0; s < ids.length; s += STEP) {
      ifc.StreamMeshes(modelID, ids.slice(s, s + STEP), onMesh);
      ld.set(0.3 + 0.55 * Math.min(1, (s + STEP) / ids.length), `Geometria: ${Math.min(ids.length, s + STEP).toLocaleString("it-IT")} di ${ids.length.toLocaleString("it-IT")} elementi`);
      await new Promise(r => setTimeout(r, 0));
    }
  } else ifc.StreamAllMeshes(modelID, onMesh);
  if (MERGE && batches.size) {
    ld.set(0.9, "Preparazione della vista");
    await new Promise(r => setTimeout(r, 0));
    const { buildBatches, sharedProxy } = await import("../navis.js");
    buildBatches(root, batches);
    for (const b of batches.values()) for (const p of b.parts) { const m = sharedProxy(p, p.mat); m.userData.expressID = p.owner.userData.expressID; p.owner.add(m); }
  }
  // la matrice di coordinamento e' nota solo dopo aver letto la geometria del primo modello
  if (!info.coordMatrix) { try { info.coordMatrix = Array.from(ifc.GetCoordinationMatrix(modelID)); } catch { /* */ } }
  // nomi leggibili degli elementi: letti solo quando la voce dell'albero viene mostrata
  const nameOf = id => { try { const l = ifc.GetLine(modelID, id, false); return (l.Name?.value || l.ObjectType?.value || "") + "  #" + id; } catch { return "#" + id; } };
  const leaf = g => { let n; return { get name() { return (n ??= nameOf(g.userData.expressID)); }, obj: g, children: [] }; };
  const tree = [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([t, list]) => ({
    name: `${t} (${list.length})`, obj: null, objs: list, children: list.map(leaf),
  }));
  info.ifc = ifc;
  if (info.modelID === undefined) info.modelID = modelID;
  (info.modelIDs = info.modelIDs || []).push(modelID);
  info.status = `${count} elementi BIM`;
  return { root, tree };
}

async function loadMesh(ctx, bytes, ld) {
  const [file, cls] = LOADERS[ctx.ext];
  ld.set(0.3, "Lettura del modello 3D");
  const mod = await import(`${window.MBV_ROOT}vendor/three/examples/jsm/loaders/${file}.js`);
  const manager = new THREE.LoadingManager();
  const dir = dirName(ctx.path);
  manager.setURLModifier(u => {
    if (/^(data:|blob:|\/api\/|\/vendor\/)/.test(u) || (window.MBV_ROOT && u.startsWith(window.MBV_ROOT))) return u;
    const rel = decodeURIComponent(u.replace(/^https?:\/\/[^/]+\//, "").replace(/^\.\//, "")).replace(/\//g, "\\");
    return fileUrl(dir + "\\" + rel);
  });
  const loader = new mod[cls](manager);
  if (ctx.ext === "gltf" || ctx.ext === "glb") {
    const { DRACOLoader } = await import(window.MBV_ROOT + "vendor/three/examples/jsm/loaders/DRACOLoader.js");
    const d = new DRACOLoader();
    d.setDecoderPath(window.MBV_ROOT + "vendor/three/examples/jsm/libs/draco/");
    loader.setDRACOLoader(d);
  }
  const textual = ["obj", "ply", "wrl", "vrml", "vtk", "xyz", "pdb", "dae", "amf"].includes(ctx.ext) && !(bytes[0] === 0x50 && bytes[1] === 0x4b);
  const input = textual && ctx.ext !== "ply" && ctx.ext !== "vtk" ? new TextDecoder().decode(bytes) : bytes.buffer;
  if (ctx.ext === "3dm") loader.setLibraryPath(window.MBV_ROOT + "vendor/three/examples/jsm/libs/rhino3dm/"); // Rhino (libreria ufficiale rhino3dm)
  let out = await new Promise((resolve, reject) => {
    try {
      if (ctx.ext === "gltf" || ctx.ext === "glb") loader.parse(bytes.buffer, "", resolve, reject);
      // copia: il lettore trasferisce il buffer al suo worker, e i byte servono ancora per ricostruire i solidi
      else if (ctx.ext === "3dm") loader.parse(bytes.slice().buffer, resolve, e => reject(new Error(e?.message || String(e))));
      else resolve(loader.parse(input, ""));
    } catch (e) { reject(e); }
  });
  if (out instanceof Promise) out = await out;
  let obj;
  const std = () => new THREE.MeshStandardMaterial({ color: 0xb8bcc0, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide, vertexColors: false });
  if (out.isBufferGeometry) {
    if (out.index === null && !out.attributes.normal) out.computeVertexNormals();
    if (["pcd", "xyz"].includes(ctx.ext)) obj = new THREE.Points(out, new THREE.PointsMaterial({ size: 0.01, vertexColors: !!out.attributes.color, color: out.attributes.color ? 0xffffff : 0x6aa7d8 }));
    else { if (!out.attributes.normal) out.computeVertexNormals(); const m = std(); if (out.attributes.color) m.vertexColors = true; obj = new THREE.Mesh(out, m); }
  } else if (out.scene) obj = out.scene;
  else if (out.isObject3D) obj = out;
  else if (out.skeleton) { obj = new THREE.Group(); const h = new THREE.SkeletonHelper(out.skeleton.bones[0]); obj.add(out.skeleton.bones[0], h); }
  else if (ctx.ext === "pdb") {
    obj = new THREE.Group();
    const g = out.geometryAtoms;
    obj.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 0.6, vertexColors: true })));
    obj.add(new THREE.LineSegments(out.geometryBonds, new THREE.LineBasicMaterial({ color: 0x999999 })));
  } else if (Array.isArray(out)) { obj = new THREE.Group(); out.forEach(c => obj.add(c.isMesh || c.isObject3D ? c : new THREE.Mesh(c, std()))); }
  else if (out.chunks || out.length) { obj = new THREE.Group(); }
  else throw new Error("Formato del modello non interpretabile");
  obj.name = obj.name || ctx.name;
  const root = new THREE.Group();
  root.add(obj);
  if (ctx.ext === "3dm") {
    // solidi senza mesh di visualizzazione: ricostruiti dalla geometria esatta (ui/js/rhino.js)
    ld.set(0.6, "Ricostruzione dei solidi Rhino");
    try {
      const { addMissingSolids } = await import("../rhino.js");
      const n = await addMissingSolids(bytes, obj);
      if (n) ctx.solidsRebuilt = n;
    } catch (e) { console.warn("3dm: ricostruzione dei solidi non riuscita", e); }
    return { root, tree: rhinoTree(obj), animations: [] };
  }
  const tree = [];
  const walk = (o, outList, depth) => {
    const item = { name: o.name || o.type, obj: o, children: [] };
    outList.push(item);
    if (depth < 6) o.children.forEach(c => { if (c.isMesh || c.isGroup || c.isObject3D && c.children.length) walk(c, item.children, depth + 1); });
  };
  walk(obj, tree, 0);
  return { root, tree, animations: out.animations };
}

// Rhino: albero per layer (come nel pannello Livelli di Rhino), con il nome del layer su ogni oggetto
function rhinoTree(obj) {
  const layers = obj.userData.layers || [];
  const byLayer = new Map();
  for (const c of obj.children) {
    const li = c.userData.attributes?.layerIndex;
    const L = layers[li];
    const lname = L?.fullPath || L?.name || "Senza layer";
    c.userData.layerName = lname;
    if (!byLayer.has(lname)) byLayer.set(lname, []);
    byLayer.get(lname).push(c);
  }
  const kind = { Curve: "Curva", Point: "Punto", Brep: "Solido", Extrusion: "Estrusione", Mesh: "Mesh", SubD: "SubD", InstanceReference: "Blocco", TextDot: "Etichetta", Annotation: "Quota" };
  return [...byLayer.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, list]) => ({
    name: `${name} (${list.length})`, obj: null, objs: list,
    children: list.map(c => ({ name: c.name || kind[c.userData.objectType] || c.userData.objectType || c.type, obj: c, children: [] })),
  }));
}

// ---------------------------------------------------------------- visualizzatore
async function loadAny(c, ld, info) {
  const bytes = NAVIS[c.ext] ? null : await readBytes(c.path); // Navisworks: lo legge il motore nativo
  let loaded;
  if (OCCT[c.ext]) loaded = await loadOcct(c, bytes, ld);
  else if (c.ext === "ifc") loaded = await loadIfc(c, bytes, ld, info);
  else if (NAVIS[c.ext]) { const { loadNavis } = await import("../navis.js"); loaded = await loadNavis(c, ld); if (c.navisInfo) info.status = c.navisInfo; }
  else if (LOADERS[c.ext]) loaded = await loadMesh(c, bytes, ld);
  else throw new Error(`Il formato .${c.ext} non e' un modello 3D`);
  // asse Z verso l'alto per CAD e mesh tecniche (convenzione ingegneristica)
  if (OCCT[c.ext] || ["stl", "3mf", "amf", "ply", "obj", "3ds", "3dm"].includes(c.ext) || NAVIS[c.ext]) loaded.root.rotation.x = -Math.PI / 2;
  loaded.root.name = c.name;
  return loaded;
}

export async function mount(ctx) {
  const ld = loading(ctx.el, "Lettura del modello");
  const info = {};
  const first = await loadAny(ctx, ld, info);
  const parts = [{ name: ctx.info?.nome || ctx.name, loaded: first }];
  for (const p of ctx.extraPaths || []) {
    const name = p.split(/[\\/]/).pop();
    ld.set(0.5, "Lettura di " + name);
    try { parts.push({ name, loaded: await loadAny({ path: p, name, ext: name.split(".").pop().toLowerCase() }, ld, info) }); }
    catch (e) { toast(`${name}: ${e.message}`, true, 6000); }
  }
  const loaded = { root: new THREE.Group(), tree: [], animations: first.animations };
  const addPart = pt => {
    loaded.root.add(pt.loaded.root);
    loaded.tree.push({ name: pt.name, obj: pt.loaded.root, children: pt.loaded.tree });
  };
  if (parts.length === 1) { loaded.root.add(first.root); loaded.tree = first.tree; }
  else parts.forEach(addPart);
  if (parts.length > 1) info.status = `Modello federato: ${parts.length} file`;
  ld.set(0.9, "Preparazione della scena");
  ctx.el.innerHTML = "";

  // ---- scena
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(devicePixelRatio || 1);
  renderer.localClippingEnabled = true;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e7);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.screenSpacePanning = true;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  scene.add(fill);
  const model = loaded.root;
  scene.add(model);
  model.updateMatrixWorld(true);
  ctx.tab.three = { THREE, scene, model, camera }; // per diagnostica

  const setBg = () => { scene.background = new THREE.Color(isDark() ? 0x1e2021 : 0xeef0ed); };
  setBg();
  window.addEventListener("mbv-theme", setBg);

  let mixer = null;
  if (loaded.animations?.length) { mixer = new THREE.AnimationMixer(model); loaded.animations.forEach(a => mixer.clipAction(a).play()); }

  // ---- interfaccia
  const treeBox = el("div", { class: "tree" });
  const props = el("div", { style: { padding: "8px 10px", borderTop: "1px solid var(--line)", fontSize: "12.5px", maxHeight: "48vh", overflow: "auto" } });
  const side = el("div", { style: { display: "grid", gridTemplateRows: "minmax(0, 1fr) auto", minHeight: 0, overflow: "hidden" } }, el("div", { style: { overflow: "auto", minHeight: 0 } }, treeBox), props);
  const host = el("div", { style: { position: "relative", overflow: "hidden" } }, renderer.domElement);
  ctx.el.append(el("div", { class: "side", style: { gridTemplateColumns: "300px 1fr" } }, side, host));
  ctx.fillBody(true);
  renderer.domElement.style.display = "block";

  // ---- inquadratura
  const box = new THREE.Box3();
  function bounds(objs) { box.makeEmpty(); for (const o of objs) box.expandByObject(o); return box; }
  function fit(dir = new THREE.Vector3(1, 0.8, 1)) {
    const b = bounds([model]);
    if (b.isEmpty()) return;
    const c = b.getCenter(new THREE.Vector3()), size = b.getSize(new THREE.Vector3()).length() || 1;
    const dist = size / (2 * Math.tan((camera.fov * Math.PI) / 360)) * 1.05;
    camera.position.copy(c).add(dir.normalize().multiplyScalar(dist));
    camera.near = size / 2000;
    camera.far = size * 200;
    camera.updateProjectionMatrix();
    controls.target.copy(c);
    sun.position.copy(c).add(new THREE.Vector3(size, size * 1.5, size * 0.8));
    fill.position.copy(c).add(new THREE.Vector3(-size, size * 0.4, -size));
    controls.update();
    sectionRange = [b.min.clone(), b.max.clone()];
  }
  let sectionRange = null;

  function resize() {
    const r = host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    renderer.setSize(r.width, r.height, false);
    renderer.domElement.style.width = r.width + "px";
    renderer.domElement.style.height = r.height + "px";
    camera.aspect = r.width / r.height;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(host);

  let running = true;
  const clock = new THREE.Clock();
  (function loop() {
    if (!running) return;
    requestAnimationFrame(loop);
    if (ctx.tab.view.hidden) return;
    controls.update();
    if (mixer) mixer.update(clock.getDelta());
    renderer.render(scene, camera);
  })();

  // ---- selezione (una o piu' parti), collegata all'albero nei due sensi
  const selColor = new THREE.Color(0xff9f1a);
  let selection = [];
  const saved = new Map();
  let propsToken = 0;
  function select(list, { scroll = true } = {}) {
    for (const [m, mat] of saved) { m.material = mat; if (m.userData.proxy) m.visible = false; }
    saved.clear();
    selection = [...new Set(list.filter(Boolean))];
    for (const obj of selection) obj.traverse(m => {
      if (!m.isMesh || saved.has(m)) return;
      saved.set(m, m.material);
      // modelli uniti (Navisworks grandi): la copia dell'elemento si mostra sopra il blocco unito
      if (m.userData.proxy) { m.visible = true; if (!m.geometry.attributes.normal) m.geometry.computeVertexNormals(); }
      const mk = mt => { const c = mt.clone(); c.emissive = selColor; c.emissiveIntensity = 0.55; if (m.userData.proxy) { c.polygonOffset = true; c.polygonOffsetFactor = -2; c.polygonOffsetUnits = -2; } return c; };
      m.material = Array.isArray(m.material) ? m.material.map(mk) : mk(m.material);
    });
    markTree(scroll);
    showProps();
  }
  const toggleIn = (list, objs) => (objs.every(o => list.includes(o)) ? list.filter(o => !objs.includes(o)) : [...list, ...objs]);

  async function showProps() {
    const token = ++propsToken;
    props.innerHTML = "";
    const objs = selection;
    if (!objs.length) return;
    const one = objs.length === 1 ? objs[0] : null;
    const b = bounds(objs), s = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
    const dl = el("dl", { class: "kv stack" });
    const add = (k, v) => v !== undefined && v !== null && v !== "" && dl.append(el("dt", {}, k), el("dd", {}, String(v)));
    if (one) add("Nome", one.name);
    else add("Elementi selezionati", objs.length.toLocaleString("it-IT"));
    add("Ingombro (X × Y × Z)", `${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)}`);
    add("Centro", `${fmt(c.x)} ; ${fmt(c.y)} ; ${fmt(c.z)}`);
    let tri = 0;
    for (const o of objs) o.traverse(m => { if (m.isMesh && m.geometry) tri += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3; });
    add("Triangoli", Math.round(tri).toLocaleString("it-IT"));
    if (one) {
      const path = [];
      for (let p = one.parent; p && p !== model; p = p.parent) if (p.name) path.unshift(p.name);
      add("Percorso nell'assieme", path.join(" › "));
      const at = one.userData.attributes;
      if (one.userData.navisProps || one.userData.navisId !== undefined) {
        if (one.userData.classe) add("Tipo", one.userData.classe);
      } else if (at) {
        // oggetto Rhino: layer, tipo, identificativo e testi utente (chiave = valore)
        add("Layer", one.userData.layerName);
        add("Tipo Rhino", one.userData.objectType);
        add("Nome Rhino", at.name);
        add("ID", at.id);
        const col = at.drawColor || at.objectColor;
        if (col) add("Colore", `RGB ${col.r}, ${col.g}, ${col.b}`);
        for (const [k, v] of at.userStrings || []) add(k, v);
        const g = one.geometry;
        if (one.isLine && g?.attributes?.position) {
          const p = g.attributes.position;
          let len = 0;
          for (let i = 1; i < p.count; i++) len += Math.hypot(p.getX(i) - p.getX(i - 1), p.getY(i) - p.getY(i - 1), p.getZ(i) - p.getZ(i - 1));
          add("Lunghezza", fmt(len));
        }
        if (one.isPoints && g?.attributes?.position) add("Coordinate", `${fmt(g.attributes.position.getX(0))} ; ${fmt(g.attributes.position.getY(0))} ; ${fmt(g.attributes.position.getZ(0))}`);
      } else {
        for (const [k, v] of Object.entries(one.userData || {})) if (!["expressID", "modelID"].includes(k) && (typeof v !== "object" || v === null)) add(k, v);
        if (one.userData && typeof one.userData === "object") for (const [k, v] of Object.entries(one.userData)) if (v && typeof v === "object" && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) if (typeof v2 !== "object") add(`${k} · ${k2}`, v2);
      }
    }
    const cpick = el("input", { type: "color", value: "#b8bcc0", title: "Colore della selezione" });
    cpick.addEventListener("input", () => {
      for (const [m] of saved) { const mk = () => new THREE.MeshStandardMaterial({ color: cpick.value, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide }); saved.set(m, Array.isArray(m.material) ? m.material.map(mk) : mk()); }
      ctx.setDirty(true);
    });
    props.append(el("div", { style: { display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px", flexWrap: "wrap" } },
      el("b", {}, "Selezione"), el("span", { style: { flex: 1 } }), cpick,
      el("button", { class: "btn", onclick: () => { objs.forEach(o => (o.visible = false)); select([]); visibilityChanged(); } }, "Nascondi"),
      el("button", { class: "btn", onclick: () => isolate(objs) }, "Isola"),
      el("button", { class: "btn", onclick: () => zoomTo(objs) }, "Inquadra"),
      el("button", { class: "btn", onclick: () => select([]) }, "Deseleziona")), dl);
    if (one?.userData.navisProps) {
      const { navisSheet } = await import("../navis.js");
      if (token === propsToken) props.append(navisSheet(one.userData.navisProps, el, toast));
    }
    const id = one?.userData.expressID;
    if (one && info.ifc && id !== undefined) {
      const wait = el("p", { class: "note" }, "Lettura delle informazioni BIM...");
      props.append(wait);
      try {
        const { bimSheet } = await import("../bim.js");
        const sheet = await bimSheet(info, one.userData.modelID ?? info.modelID, id, fmt);
        if (token === propsToken) wait.replaceWith(sheet);
      } catch (e) { if (token === propsToken) wait.textContent = "Proprieta' BIM non disponibili: " + e.message; }
    }
  }

  function isolate(objs) {
    model.traverse(o => { if (o.isMesh || o.isPoints || o.isLine || o.userData.navisId !== undefined) o.visible = false; });
    for (const obj of objs) {
      obj.traverse(o => { o.visible = true; });
      for (let p = obj.parent; p; p = p.parent) p.visible = true;
    }
    visibilityChanged();
  }
  function showAll() { model.traverse(o => (o.visible = true)); visibilityChanged(); }
  // dopo ogni cambio di visibilita': le copie degli elementi tornano invisibili (tranne i selezionati) e i blocchi
  // uniti si ricostruiscono senza gli elementi nascosti
  function visibilityChanged() {
    const roots = [];
    model.traverse(o => { if (o.userData.proxy) o.visible = saved.has(o); if (o.userData.refresh) roots.push(o); });
    roots.forEach(r => r.userData.refresh());
    refreshTree();
  }

  // ---- albero: le righe si creano quando un ramo viene aperto (anche decine di migliaia di elementi BIM)
  const rows = [];
  const itemOf = new Map(); // oggetto 3D -> voce dell'albero
  function indexTree(items, parent) {
    for (const it of items) { it.parent = parent; if (it.obj) itemOf.set(it.obj, it); indexTree(it.children, it); }
  }
  function drawItems(items, depth, box) {
    for (const it of items) {
      const cb = el("input", { type: "checkbox", checked: true });
      const node = el("div", { class: "node", style: { paddingLeft: 8 + depth * 14 + "px" } });
      const kids = el("div", { hidden: true });
      const twist = el("span", { style: { width: "12px", display: "inline-block", cursor: "pointer", color: "var(--muted)" } }, it.children.length ? "▸" : "");
      Object.assign(it, { depth, node, kids, twist, drawn: false });
      twist.addEventListener("click", e => { e.stopPropagation(); expand(it, kids.hidden); });
      node.append(twist, cb, el("span", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, it.name));
      const objs = it.obj ? [it.obj] : it.objs || [];
      cb.addEventListener("change", () => { objs.forEach(o => (o.visible = cb.checked)); visibilityChanged(); });
      node.addEventListener("click", e => {
        if (e.target === cb || e.target === twist) return;
        if (objs.length > 5000) return toast("Troppi elementi da selezionare insieme: apri il gruppo e scegli gli elementi", true);
        const multi = e.ctrlKey || e.metaKey;
        select(multi ? toggleIn(selection, objs) : objs, { scroll: false });
        if (!it.obj && objs.length) node.classList.add("sel"); // classe BIM: selezionati tutti i suoi elementi
      });
      node.addEventListener("dblclick", () => { if (objs.length) zoomTo(objs); });
      rows.push({ node, cb, objs });
      box.append(node, kids);
      if (depth === 0 && it.children.length && it.children.length <= 12) expand(it, true);
    }
  }
  function expand(it, open) {
    if (!it.children.length || !it.kids) return;
    if (open && !it.drawn) { it.drawn = true; drawItems(it.children, it.depth + 1, it.kids); refreshTree(); markTree(false); }
    it.kids.hidden = !open;
    it.twist.textContent = open ? "▾" : "▸";
  }
  function itemFor(obj) { let o = obj, it; while (o && !(it = itemOf.get(o))) o = o.parent; return it; }
  // evidenzia nell'albero gli elementi selezionati sul modello, aprendo i rami che li contengono
  function markTree(scroll) {
    for (const r of rows) r.node.classList.remove("sel");
    let last = null;
    for (const obj of selection) {
      const it = itemFor(obj);
      if (!it) continue;
      if (scroll && selection.length <= 50) { const chain = []; for (let p = it.parent; p; p = p.parent) chain.unshift(p); chain.forEach(p => expand(p, true)); }
      if (it.node) { it.node.classList.add("sel"); last = it.node; }
    }
    if (scroll && last) last.scrollIntoView({ block: "nearest" });
  }
  function refreshTree() { for (const r of rows) r.cb.checked = r.objs.some(o => o.visible); }
  function addToTree(items) { indexTree(items, null); drawItems(items, 0, treeBox); }
  treeBox.append(el("div", { style: { padding: "4px 10px 6px", display: "flex", gap: "6px" } }, el("b", {}, OCCT[ctx.ext] ? "Parti" : ctx.ext === "ifc" ? "Classi BIM" : "Oggetti"), el("span", { style: { flex: 1 } }), el("button", { class: "btn", onclick: showAll }, "Mostra tutto")));
  addToTree(loaded.tree);

  function zoomTo(objs) {
    const b = bounds(Array.isArray(objs) ? objs : [objs]);
    if (b.isEmpty()) return;
    const c = b.getCenter(new THREE.Vector3()), size = b.getSize(new THREE.Vector3()).length() || 1;
    const dir = camera.position.clone().sub(controls.target).normalize();
    controls.target.copy(c);
    camera.position.copy(c).add(dir.multiplyScalar(size * 1.4));
  }

  // ---- selezione e misura con il mouse
  const ray = new THREE.Raycaster();
  let measure = false, mpts = [];
  const mGroup = new THREE.Group();
  scene.add(mGroup);
  // elemento selezionabile: per i modelli BIM l'intero elemento IFC, altrimenti la parte colpita
  const unitOf = o => {
    while (o.parent && o.parent !== model && o.userData.expressID !== undefined && o.userData.expressID === o.parent.userData.expressID) o = o.parent;
    if (o.userData.navisId !== undefined && o.parent?.userData.navisId === o.userData.navisId) o = o.parent; // Navisworks: il nodo, non la singola mesh
    return o;
  };
  const band = el("div", { hidden: true, style: { position: "absolute", border: "1px dashed #ff9f1a", background: "rgba(255,159,26,.12)", pointerEvents: "none" } });
  host.append(band);
  let down = null;
  renderer.domElement.addEventListener("pointerdown", e => (down = [e.clientX, e.clientY, e.button === 0 && effectiveNav() === "select" && !measure]));
  renderer.domElement.addEventListener("pointermove", e => {
    if (!down || !down[2] || !(e.buttons & 1)) return;
    const r = host.getBoundingClientRect();
    if (Math.hypot(e.clientX - down[0], e.clientY - down[1]) <= 4) return;
    Object.assign(band.style, { left: Math.min(down[0], e.clientX) - r.left + "px", top: Math.min(down[1], e.clientY) - r.top + "px", width: Math.abs(e.clientX - down[0]) + "px", height: Math.abs(e.clientY - down[1]) + "px" });
    band.hidden = false;
  });
  renderer.domElement.addEventListener("pointerup", e => {
    if (!down) return;
    const [x0, y0, boxing] = down;
    down = null;
    band.hidden = true;
    const moved = Math.hypot(e.clientX - x0, e.clientY - y0) > 4;
    const multi = e.ctrlKey || e.metaKey;
    if (boxing && moved) return boxSelect(x0, y0, e.clientX, e.clientY, multi);
    if (moved || e.button !== 0) return;
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    // linee e punti (modelli analitici, assi): il clic li prende entro circa 8 pixel sullo schermo
    const pxWorld = 2 * camera.position.distanceTo(controls.target) * Math.tan((camera.fov * Math.PI) / 360) / r.height;
    ray.params.Line.threshold = ray.params.Points.threshold = pxWorld * 8;
    const hits = ray.intersectObject(model, true).filter(h => h.object.visible && isVisibleChain(h.object) && (!clipPlane || clipPlane.distanceToPoint(h.point) >= 0));
    const hit = hits[0];
    if (measure) {
      if (!hit) return;
      if (mpts.length === 2) { mpts = []; mGroup.clear(); }
      mpts.push(hit.point.clone());
      const size = bounds([model]).getSize(new THREE.Vector3()).length() / 250;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(size, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff9f1a, depthTest: false }));
      dot.position.copy(hit.point);
      dot.renderOrder = 10;
      mGroup.add(dot);
      if (mpts.length === 2) {
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(mpts), new THREE.LineBasicMaterial({ color: 0xff9f1a, depthTest: false }));
        line.renderOrder = 10;
        mGroup.add(line);
        const d = mpts[0].distanceTo(mpts[1]);
        ctx.status(`Distanza: ${fmt(d)} (unita' del modello${OCCT[ctx.ext] ? ": mm" : ""})`);
        distLabel.textContent = "Distanza: " + fmt(d) + (OCCT[ctx.ext] ? " mm" : "");
        distLabel.hidden = false;
      }
      return;
    }
    const pick = hit?.object.userData.merged ? hit.object.parent?.userData.pick : null;
    const fi = hit ? (hit.faceIndex ?? (hit.index != null ? Math.floor(hit.index / (hit.object.userData.merged?.per || 1)) : null)) : null;
    const target = pick ? pick(hit.object, fi) : hit ? unitOf(hit.object) : null;
    if (multi) { if (target) select(toggleIn(selection, [target])); }
    else select(target ? [target] : []);
  });
  // selezione a riquadro: gli elementi visibili con il centro dentro il riquadro
  function boxSelect(x0, y0, x1, y1, multi) {
    const r = renderer.domElement.getBoundingClientRect();
    const nx = x => ((x - r.left) / r.width) * 2 - 1, ny = y => -((y - r.top) / r.height) * 2 + 1;
    const [ax, bx] = [nx(Math.min(x0, x1)), nx(Math.max(x0, x1))], [by, ay] = [ny(Math.max(y0, y1)), ny(Math.min(y0, y1))];
    const found = new Set(), v = new THREE.Vector3(), bb = new THREE.Box3();
    model.traverse(m => {
      if (!(m.isMesh || m.isPoints) || m.userData.merged || !isVisibleChain(m.userData.proxy ? m.parent : m)) return;
      bb.setFromObject(m).getCenter(v);
      if (clipPlane && clipPlane.distanceToPoint(v) < 0) return;
      v.project(camera);
      if (v.z < 1 && v.x >= ax && v.x <= bx && v.y >= by && v.y <= ay) found.add(unitOf(m));
    });
    const list = [...found];
    select(multi ? [...selection, ...list] : list);
    ctx.status(`${selection.length.toLocaleString("it-IT")} elementi selezionati`);
  }
  const isVisibleChain = o => { while (o) { if (!o.visible) return false; o = o.parent; } return true; };
  const distLabel = el("div", { hidden: true, style: { position: "absolute", left: "12px", bottom: "12px", padding: "6px 12px", background: "rgba(0,0,0,.75)", color: "#fff", borderRadius: "6px", fontWeight: 600 } });
  host.append(distLabel);

  // ---- sezione
  let clipPlane = null;
  const axisSel = el("select", { id: "sec-axis-" + ctx.tab.name, title: "Asse della sezione" }, el("option", { value: "" }, "Sezione: no"), el("option", { value: "x" }, "Sezione X"), el("option", { value: "y" }, "Sezione Y (alto)"), el("option", { value: "z" }, "Sezione Z"));
  const slider = el("input", { type: "range", min: "0", max: "1000", value: "500", id: "sec-pos-" + ctx.tab.name, title: "Posizione della sezione" });
  const flipBtn = button("", "flipH", () => { flip = -flip; updateClip(); }, { iconOnly: true, title: "Inverti il lato della sezione" });
  let flip = 1;
  function updateClip() {
    const a = axisSel.value;
    if (!a || !sectionRange) { clipPlane = null; renderer.clippingPlanes = []; return; }
    const t = slider.value / 1000;
    const pos = sectionRange[0][a] + (sectionRange[1][a] - sectionRange[0][a]) * t;
    const n = new THREE.Vector3(a === "x" ? -1 : 0, a === "y" ? -1 : 0, a === "z" ? -1 : 0).multiplyScalar(flip);
    clipPlane = new THREE.Plane(n, -n.dot(new THREE.Vector3(a === "x" ? pos : 0, a === "y" ? pos : 0, a === "z" ? pos : 0)));
    renderer.clippingPlanes = [clipPlane];
  }
  axisSel.addEventListener("change", updateClip);
  slider.addEventListener("input", updateClip);

  // ---- filo di ferro, viste, esportazione
  let wire = false;
  const wireBtn = button("Filo di ferro", "wire", () => {
    wire = !wire;
    wireBtn.classList.toggle("on", wire);
    model.traverse(m => { if (m.isMesh) (Array.isArray(m.material) ? m.material : [m.material]).forEach(mt => (mt.wireframe = wire)); });
  });
  const mBtn = button("Misura", "ruler", () => { measure = !measure; mBtn.classList.toggle("on", measure); mpts = []; mGroup.clear(); distLabel.hidden = true; });
  const views = el("select", { id: "view-" + ctx.tab.name, title: "Vista", onchange: e => { const v = { iso: [1, 0.8, 1], top: [0, 1, 0.0001], front: [0, 0, 1], right: [1, 0, 0], back: [0, 0, -1], left: [-1, 0, 0] }[e.target.value]; if (v) fit(new THREE.Vector3(...v)); e.target.value = ""; } },
    el("option", { value: "" }, "Vista..."), el("option", { value: "iso" }, "Isometrica"), el("option", { value: "top" }, "Dall'alto"), el("option", { value: "front" }, "Frontale"),
    el("option", { value: "right" }, "Destra"), el("option", { value: "left" }, "Sinistra"), el("option", { value: "back" }, "Posteriore"));
  const exp = el("select", { id: "exp-" + ctx.tab.name, title: "Esporta", onchange: e => { const v = e.target.value; e.target.value = ""; if (v) doExport(v); } },
    el("option", { value: "" }, "Esporta..."), el("option", { value: "glb" }, "GLB (glTF binario)"), el("option", { value: "stl" }, "STL"), el("option", { value: "obj" }, "OBJ"), el("option", { value: "png" }, "Immagine PNG"));
  // ---- modalita' del tasto sinistro: Ruota / Sposta / Seleziona (Maiusc tenuto premuto: Ruota e Sposta si scambiano,
  // in Seleziona si ruota; Ctrl non cambia la navigazione ma aggiunge o toglie elementi dalla selezione)
  let navMode = "rotate";
  const rotBtn = el("button", { type: "button", title: "Tasto sinistro ruota il modello" }, "Ruota");
  const panBtn = el("button", { type: "button", title: "Tasto sinistro sposta il modello" }, "Sposta");
  const selBtn = el("button", { type: "button", title: "Tasto sinistro seleziona: clic su un elemento o trascina un riquadro (Ctrl aggiunge o toglie)" }, "Seleziona");
  const seg = el("span", { class: "seg", title: "Tieni premuto Maiusc per passare temporaneamente a un'altra modalita'" }, rotBtn, panBtn, selBtn);
  let shiftDown = false;
  function effectiveNav() { return shiftDown ? (navMode === "rotate" ? "pan" : "rotate") : navMode; }
  const applyNav = () => {
    const eff = effectiveNav();
    rotBtn.classList.toggle("on", eff === "rotate");
    panBtn.classList.toggle("on", eff === "pan");
    selBtn.classList.toggle("on", eff === "select");
    // OrbitControls con Maiusc premuto scambia da se' Ruota e Sposta: il pulsante si imposta perche' il risultato sia quello mostrato
    controls.mouseButtons.LEFT = navMode === "rotate" ? THREE.MOUSE.ROTATE : navMode === "pan" || shiftDown ? THREE.MOUSE.PAN : -1;
    renderer.domElement.style.cursor = eff === "select" ? "crosshair" : eff === "pan" ? "move" : "grab";
  };
  const setNav = m => { navMode = m; applyNav(); };
  rotBtn.addEventListener("click", () => setNav("rotate"));
  panBtn.addEventListener("click", () => setNav("pan"));
  selBtn.addEventListener("click", () => setNav("select"));
  setNav("rotate");
  // OrbitControls inverte la modalita' con Ctrl, Meta o Maiusc: lasciamo solo Maiusc
  host.addEventListener("pointerdown", e => {
    if (e.ctrlKey) Object.defineProperty(e, "ctrlKey", { value: false });
    if (e.metaKey) Object.defineProperty(e, "metaKey", { value: false });
  }, true);
  const onKey = e => {
    if (e.key === "Shift" && shiftDown !== (e.type === "keydown")) { shiftDown = e.type === "keydown"; applyNav(); }
    if (e.type === "keydown" && e.key === "Escape" && !ctx.tab.view.hidden && selection.length) select([]);
  };
  const onBlur = () => { shiftDown = false; applyNav(); };
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);
  window.addEventListener("blur", onBlur);

  // ---- modello federato: aggiunta di altri file nella stessa scena (stesse coordinate per i file IFC)
  const addBtn = button("Aggiungi modello", "plus", async () => {
    const ps = await pickFiles();
    for (const p of ps || []) {
      const name = p.split(/[\\/]/).pop();
      toast("Caricamento di " + name + "...");
      try {
        const part = await loadAny({ path: p, name, ext: name.split(".").pop().toLowerCase() }, { set() {} }, info);
        model.add(part.root);
        model.updateMatrixWorld(true);
        addToTree([{ name, obj: part.root, children: part.tree }]);
        fit();
        ctx.status(`Modello federato · aggiunto ${name}`);
      } catch (e) { toast(`${name}: ${e.message}`, true, 6000); }
    }
  }, { title: "Carica un altro modello (IFC, STEP, STL...) nella stessa scena" });

  ctx.tb.append(seg, el("span", { class: "sep" }), addBtn, button("Adatta", "fit", () => fit()), views, el("span", { class: "sep" }), wireBtn, mBtn, axisSel, slider, flipBtn,
    el("span", { class: "sep" }), exp, el("span", { class: "grow" }), el("span", { class: "note" }, "Maiusc: cambia modalita' · destro: sposta · rotella: zoom · clic: seleziona · Ctrl+clic: aggiungi · Esc: deseleziona"));

  async function doExport(kind) {
    const base = dirName(ctx.path);
    if (kind === "png") {
      renderer.render(scene, camera);
      const blob = await new Promise(r => renderer.domElement.toBlob(r, "image/png"));
      return saveBlobAs(withExt(ctx.name, "png"), blob, base);
    }
    const visibleCopy = model.clone(true);
    visibleCopy.traverse(o => { if (!isVisibleChain(o)) o.visible = false; });
    if (kind === "stl") {
      const { STLExporter } = await import("three/addons/exporters/STLExporter.js");
      const data = new STLExporter().parse(visibleCopy, { binary: true });
      return saveBlobAs(withExt(ctx.name, "stl"), new Blob([data]), base);
    }
    if (kind === "obj") {
      const { OBJExporter } = await import("three/addons/exporters/OBJExporter.js");
      return saveBlobAs(withExt(ctx.name, "obj"), new Blob([new OBJExporter().parse(visibleCopy)]), base);
    }
    const { GLTFExporter } = await import("three/addons/exporters/GLTFExporter.js");
    const glb = await new GLTFExporter().parseAsync(visibleCopy, { binary: true, onlyVisible: true });
    return saveBlobAs(withExt(ctx.name, "glb"), new Blob([glb]), base);
  }

  requestAnimationFrame(() => { resize(); fit(); });
  let tri = 0;
  model.traverse(m => { if (m.isMesh && m.geometry && !m.userData.merged) tri += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3; });
  ctx.status((info.status ? info.status + " · " : "") + Math.round(tri).toLocaleString("it-IT") + " triangoli");

  return {
    onShow() { resize(); },
    saveInPlace: false,
    // formati tecnici (ui/js/export3d.js) + formati mesh di three.js
    saveFormats: ["stp", "step", "ifc", "glb", "gltf", "stl", "obj", "3mf", "dxf", "ply", "wrl", "usdz"],
    saveLabels: { stp: "STEP per CAD (SolidWorks, Inventor, Creo, Rhino...)", step: "STEP per CAD", ifc: "IFC 4 per BIM (Revit, Archicad, Navisworks...)", glb: "glTF binario (web, realta' aumentata)",
      gltf: "glTF testo", stl: "STL per stampa 3D", obj: "OBJ mesh universale", "3mf": "3MF per stampa 3D (con colori)", dxf: "DXF 3D (facce su layer, AutoCAD)", ply: "PLY nuvola/mesh",
      wrl: "VRML", usdz: "USDZ (Apple, realta' aumentata)" },
    saveNote: "STEP e IFC contengono superfici a facce piane ricavate dal modello visualizzato: geometria e nomi degli oggetti si conservano, le superfici curve esatte e i parametri del modello originale no.",
    saveAsName: () => withExt(ctx.name, "glb"),
    async save(target) {
      const ext = target.split(".").pop().toLowerCase();
      if (!this.saveFormats.includes(ext)) throw new Error("Formati del modello 3D: " + this.saveFormats.join(", ").toUpperCase());
      if (["stp", "step", "ifc", "3mf", "dxf", "wrl"].includes(ext)) {
        // unita' della scena secondo il formato d'origine: IFC, Navisworks e glTF in metri, CAD e mesh in millimetri
        const src = (ctx.ext || "").toLowerCase();
        const mpu = ["ifc", "nwd", "nwc", "nwf", "glb", "gltf", "usdz", "vrm"].includes(src) ? 1 : 0.001;
        const X = await import("../export3d.js");
        const els = X.collectElements(model, mpu);
        if (!els.length) throw new Error("Nessun oggetto visibile da salvare");
        const stem = ctx.name.replace(/\.[^.]+$/, "");
        let out;
        if (ext === "stp" || ext === "step") out = X.toSTEP(els, stem);
        else if (ext === "ifc") out = X.toIFC(els, stem);
        else if (ext === "3mf") out = await X.to3MF(els);
        else if (ext === "dxf") out = X.toDXF(els);
        else out = X.toVRML(els);
        await api("save", { path: target }, { body: typeof out === "string" ? new TextEncoder().encode(out) : out });
        return { switchTo: false };
      }
      // si esporta solo cio' che e' visibile (niente elementi nascosti, niente copie di servizio dei modelli uniti)
      const copy = model.clone(true);
      const drop = [];
      copy.traverse(o => { if (!o.visible) drop.push(o); });
      drop.forEach(o => o.parent?.remove(o));
      let data;
      if (ext === "stl") { const { STLExporter } = await import("three/addons/exporters/STLExporter.js"); data = new STLExporter().parse(copy, { binary: true }); }
      else if (ext === "obj") { const { OBJExporter } = await import("three/addons/exporters/OBJExporter.js"); data = new TextEncoder().encode(new OBJExporter().parse(copy)); }
      else if (ext === "ply") { const { PLYExporter } = await import("three/addons/exporters/PLYExporter.js"); data = await new Promise(r => new PLYExporter().parse(copy, r, { binary: true })); }
      else if (ext === "usdz") { const { USDZExporter } = await import("three/addons/exporters/USDZExporter.js"); data = await new USDZExporter().parseAsync(copy); }
      else { const { GLTFExporter } = await import("three/addons/exporters/GLTFExporter.js"); const out = await new GLTFExporter().parseAsync(copy, { binary: ext === "glb", onlyVisible: true, embedImages: true }); data = ext === "glb" ? out : new TextEncoder().encode(JSON.stringify(out)); }
      await api("save", { path: target }, { body: new Uint8Array(data.buffer ? data.buffer : data) });
      return { switchTo: false };
    },
    dispose() { running = false; window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onKey); window.removeEventListener("blur", onBlur); renderer.dispose(); (info.modelIDs || []).forEach(m => info.ifc?.CloseModel?.(m)); },
  };
}

const fmt = v => Number(v).toLocaleString("it-IT", { maximumFractionDigits: 3 });
