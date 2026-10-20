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
};
const OCCT = { step: "step", stp: "step", p21: "step", stpz: "step", iges: "iges", igs: "iges", brep: "brep", brp: "brep" };

// ---------------------------------------------------------------- caricamento
function occtRead(format, buffer) {
  return new Promise((resolve, reject) => {
    const w = new Worker("/vendor/occt/dist/occt-import-js-worker.js");
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
    const WEBIFC = await import("/vendor/web-ifc/web-ifc-api.js");
    ifc = new WEBIFC.IfcAPI();
    ifc.SetWasmPath("/vendor/web-ifc/", true);
    await ifc.Init();
  }
  let modelID, shift = null;
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
  ifc.StreamAllMeshes(modelID, fm => {
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
      const g = new THREE.BufferGeometry();
      const inter = new THREE.InterleavedBuffer(new Float32Array(v), 6);
      g.setAttribute("position", new THREE.InterleavedBufferAttribute(inter, 3, 0));
      g.setAttribute("normal", new THREE.InterleavedBufferAttribute(inter, 3, 3));
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
      const mesh = new THREE.Mesh(g, matFor(pg.color));
      mesh.matrix.fromArray(pg.flatTransformation);
      if (shift) mesh.matrix.premultiply(shift);
      mesh.matrixAutoUpdate = false;
      mesh.userData.expressID = id;
      grp.add(mesh);
      geom.delete?.();
    }
    let tname = "Elemento";
    try { tname = ifc.GetNameFromTypeCode(ifc.GetLineType(modelID, id)); } catch { /* */ }
    grp.name = tname;
    if (!byType.has(tname)) byType.set(tname, []);
    byType.get(tname).push(grp);
    root.add(grp);
    count++;
  });
  // la matrice di coordinamento e' nota solo dopo aver letto la geometria del primo modello
  if (!info.coordMatrix) { try { info.coordMatrix = Array.from(ifc.GetCoordinationMatrix(modelID)); } catch { /* */ } }
  // nomi leggibili degli elementi (per modelli non enormi)
  const nameOf = id => { if (count > 5000) return "#" + id; try { const l = ifc.GetLine(modelID, id, false); return (l.Name?.value || l.ObjectType?.value || "") + "  #" + id; } catch { return "#" + id; } };
  const tree = [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([t, list]) => ({
    name: `${t} (${list.length})`, obj: null, objs: list, children: list.length <= 600 ? list.map(g => ({ name: nameOf(g.userData.expressID), obj: g, children: [] })) : [],
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
  const mod = await import(`/vendor/three/examples/jsm/loaders/${file}.js`);
  const manager = new THREE.LoadingManager();
  const dir = dirName(ctx.path);
  manager.setURLModifier(u => {
    if (/^(data:|blob:|\/api\/|\/vendor\/)/.test(u) || (window.MBV_ROOT && u.startsWith(window.MBV_ROOT))) return u;
    const rel = decodeURIComponent(u.replace(/^https?:\/\/[^/]+\//, "").replace(/^\.\//, "")).replace(/\//g, "\\");
    return fileUrl(dir + "\\" + rel);
  });
  const loader = new mod[cls](manager);
  if (ctx.ext === "gltf" || ctx.ext === "glb") {
    const { DRACOLoader } = await import("/vendor/three/examples/jsm/loaders/DRACOLoader.js");
    const d = new DRACOLoader();
    d.setDecoderPath("/vendor/three/examples/jsm/libs/draco/");
    loader.setDRACOLoader(d);
  }
  const textual = ["obj", "ply", "wrl", "vrml", "vtk", "xyz", "pdb", "dae", "amf"].includes(ctx.ext) && !(bytes[0] === 0x50 && bytes[1] === 0x4b);
  const input = textual && ctx.ext !== "ply" && ctx.ext !== "vtk" ? new TextDecoder().decode(bytes) : bytes.buffer;
  let out = await new Promise((resolve, reject) => {
    try {
      if (ctx.ext === "gltf" || ctx.ext === "glb") loader.parse(bytes.buffer, "", resolve, reject);
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
  const tree = [];
  const walk = (o, outList, depth) => {
    const item = { name: o.name || o.type, obj: o, children: [] };
    outList.push(item);
    if (depth < 6) o.children.forEach(c => { if (c.isMesh || c.isGroup || c.isObject3D && c.children.length) walk(c, item.children, depth + 1); });
  };
  walk(obj, tree, 0);
  return { root, tree, animations: out.animations };
}

// ---------------------------------------------------------------- visualizzatore
async function loadAny(c, ld, info) {
  const bytes = await readBytes(c.path);
  let loaded;
  if (OCCT[c.ext]) loaded = await loadOcct(c, bytes, ld);
  else if (c.ext === "ifc") loaded = await loadIfc(c, bytes, ld, info);
  else if (LOADERS[c.ext]) loaded = await loadMesh(c, bytes, ld);
  else throw new Error(`Il formato .${c.ext} non e' un modello 3D`);
  // asse Z verso l'alto per CAD e mesh tecniche (convenzione ingegneristica)
  if (OCCT[c.ext] || ["stl", "3mf", "amf", "ply", "obj", "3ds"].includes(c.ext)) loaded.root.rotation.x = -Math.PI / 2;
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

  // ---- albero
  const selColor = new THREE.Color(0xff9f1a);
  let selected = null;
  const saved = new Map();
  function highlight(obj) {
    for (const [m, mat] of saved) m.material = mat;
    saved.clear();
    selected = obj;
    if (!obj) { props.innerHTML = ""; return; }
    obj.traverse(m => {
      if (!m.isMesh) return;
      saved.set(m, m.material);
      const mk = mt => { const c = mt.clone(); c.emissive = selColor; c.emissiveIntensity = 0.55; return c; };
      m.material = Array.isArray(m.material) ? m.material.map(mk) : mk(m.material);
    });
    showProps(obj);
  }

  async function showProps(obj) {
    props.innerHTML = "";
    const b = bounds([obj]), s = b.getSize(new THREE.Vector3());
    const dl = el("dl", { class: "kv stack" });
    const add = (k, v) => v !== undefined && v !== null && v !== "" && dl.append(el("dt", {}, k), el("dd", {}, String(v)));
    add("Nome", obj.name);
    add("Dimensioni", `${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)}`);
    let tri = 0;
    obj.traverse(m => { if (m.isMesh && m.geometry) tri += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3; });
    add("Triangoli", Math.round(tri).toLocaleString("it-IT"));
    const cpick = el("input", { type: "color", value: "#b8bcc0", title: "Colore della parte" });
    cpick.addEventListener("input", () => {
      for (const [m] of saved) { const mk = () => new THREE.MeshStandardMaterial({ color: cpick.value, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide }); saved.set(m, Array.isArray(m.material) ? m.material.map(mk) : mk()); }
      ctx.setDirty(true);
    });
    props.append(el("div", { style: { display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px", flexWrap: "wrap" } },
      el("b", {}, "Selezione"), el("span", { style: { flex: 1 } }), cpick,
      el("button", { class: "btn", onclick: () => { obj.visible = false; highlight(null); refreshTree(); } }, "Nascondi"),
      el("button", { class: "btn", onclick: () => isolate(obj) }, "Isola")), dl);
    const id = obj.userData.expressID;
    if (info.ifc && id !== undefined) {
      try {
        const line = info.ifc.GetLine(obj.userData.modelID ?? info.modelID, id, false);
        add("Classe IFC", obj.name);
        add("Nome IFC", line.Name?.value);
        add("GlobalId", line.GlobalId?.value);
        add("Descrizione", line.Description?.value);
        add("Tag", line.Tag?.value);
        const psets = await info.ifc.properties.getPropertySets(obj.userData.modelID ?? info.modelID, id, true);
        for (const ps of psets) {
          const name = ps.Name?.value || "Proprieta'";
          const items = ps.HasProperties || ps.Quantities || [];
          for (const p of items) {
            const v = p.NominalValue?.value ?? p.LengthValue?.value ?? p.AreaValue?.value ?? p.VolumeValue?.value ?? p.CountValue?.value ?? p.WeightValue?.value;
            if (v !== undefined) add(`${name} · ${p.Name?.value}`, typeof v === "number" ? fmt(v) : v);
          }
        }
      } catch (e) { add("Proprieta'", "non disponibili: " + e.message); }
    }
  }

  function isolate(obj) {
    model.traverse(o => { if (o.isMesh || o.isPoints || o.isLine) o.visible = false; });
    obj.traverse(o => { o.visible = true; });
    let p = obj.parent;
    while (p) { p.visible = true; p = p.parent; }
    refreshTree();
  }
  function showAll() { model.traverse(o => (o.visible = true)); refreshTree(); }

  const rows = [];
  function renderTree(items, depth, parentBox) {
    for (const it of items) {
      const cb = el("input", { type: "checkbox", checked: true });
      const node = el("div", { class: "node", style: { paddingLeft: 8 + depth * 14 + "px" } });
      const kids = el("div", { hidden: (depth > 0 || it.children.length > 12) && it.children.length > 0 ? true : undefined });
      const twist = el("span", { style: { width: "12px", display: "inline-block", cursor: "pointer", color: "var(--muted)" } }, it.children.length ? (kids.hidden ? "▸" : "▾") : "");
      twist.addEventListener("click", e => { e.stopPropagation(); kids.hidden = !kids.hidden; twist.textContent = kids.hidden ? "▸" : "▾"; });
      const label = el("span", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, it.name);
      node.append(twist, cb, label);
      const objs = it.obj ? [it.obj] : it.objs || [];
      cb.addEventListener("change", () => { objs.forEach(o => (o.visible = cb.checked)); });
      node.addEventListener("click", e => { if (e.target === cb) return; rows.forEach(r => r.node.classList.remove("sel")); node.classList.add("sel"); if (it.obj) highlight(it.obj); });
      node.addEventListener("dblclick", () => { if (it.obj) zoomTo(it.obj); });
      rows.push({ node, cb, objs });
      parentBox.append(node, kids);
      if (it.children.length) renderTree(it.children, depth + 1, kids);
    }
  }
  function refreshTree() { for (const r of rows) r.cb.checked = r.objs.some(o => o.visible); }
  treeBox.append(el("div", { style: { padding: "4px 10px 6px", display: "flex", gap: "6px" } }, el("b", {}, OCCT[ctx.ext] ? "Parti" : ctx.ext === "ifc" ? "Classi BIM" : "Oggetti"), el("span", { style: { flex: 1 } }), el("button", { class: "btn", onclick: showAll }, "Mostra tutto")));
  renderTree(loaded.tree, 0, treeBox);

  function zoomTo(obj) {
    const b = bounds([obj]);
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
  let down = null;
  renderer.domElement.addEventListener("pointerdown", e => (down = [e.clientX, e.clientY]));
  renderer.domElement.addEventListener("pointerup", e => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
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
    let target = hit ? hit.object : null;
    if (target && info.ifc) while (target.parent && target.parent !== model && target.userData.expressID === target.parent.userData.expressID) target = target.parent;
    highlight(target);
  });
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
  // ---- modalita' del tasto sinistro: Ruota / Sposta (Maiusc tenuto premuto inverte; Ctrl non ha effetto)
  let navMode = "rotate";
  const rotBtn = el("button", { type: "button", title: "Tasto sinistro ruota il modello" }, "Ruota");
  const panBtn = el("button", { type: "button", title: "Tasto sinistro sposta il modello" }, "Sposta");
  const seg = el("span", { class: "seg", title: "Tieni premuto Maiusc per passare temporaneamente all'altra modalita'" }, rotBtn, panBtn);
  let shiftDown = false;
  const paintSeg = () => {
    const eff = shiftDown ? (navMode === "rotate" ? "pan" : "rotate") : navMode;
    rotBtn.classList.toggle("on", eff === "rotate");
    panBtn.classList.toggle("on", eff === "pan");
  };
  const setNav = m => { navMode = m; controls.mouseButtons.LEFT = m === "rotate" ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN; paintSeg(); };
  rotBtn.addEventListener("click", () => setNav("rotate"));
  panBtn.addEventListener("click", () => setNav("pan"));
  setNav("rotate");
  // OrbitControls inverte la modalita' con Ctrl, Meta o Maiusc: lasciamo solo Maiusc
  host.addEventListener("pointerdown", e => {
    if (e.ctrlKey) Object.defineProperty(e, "ctrlKey", { value: false });
    if (e.metaKey) Object.defineProperty(e, "metaKey", { value: false });
  }, true);
  const onKey = e => { if (e.key === "Shift" && shiftDown !== (e.type === "keydown")) { shiftDown = e.type === "keydown"; paintSeg(); } };
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);
  window.addEventListener("blur", () => { shiftDown = false; paintSeg(); });

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
        renderTree([{ name, obj: part.root, children: part.tree }], 0, treeBox);
        fit();
        ctx.status(`Modello federato · aggiunto ${name}`);
      } catch (e) { toast(`${name}: ${e.message}`, true, 6000); }
    }
  }, { title: "Carica un altro modello (IFC, STEP, STL...) nella stessa scena" });

  ctx.tb.append(seg, el("span", { class: "sep" }), addBtn, button("Adatta", "fit", () => fit()), views, el("span", { class: "sep" }), wireBtn, mBtn, axisSel, slider, flipBtn,
    el("span", { class: "sep" }), exp, el("span", { class: "grow" }), el("span", { class: "note" }, "Maiusc: alterna Ruota/Sposta · destro: sposta · rotella: zoom · clic: seleziona"));

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
  model.traverse(m => { if (m.isMesh && m.geometry) tri += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3; });
  ctx.status((info.status ? info.status + " · " : "") + Math.round(tri).toLocaleString("it-IT") + " triangoli");

  return {
    onShow() { resize(); },
    saveInPlace: false,
    saveAsName: () => withExt(ctx.name, "glb"),
    async save(target) {
      const ext = target.split(".").pop().toLowerCase();
      if (!["glb", "stl", "obj"].includes(ext)) throw new Error("Salva il modello come .glb, .stl o .obj");
      const visibleCopy = model.clone(true);
      let data;
      if (ext === "stl") { const { STLExporter } = await import("three/addons/exporters/STLExporter.js"); data = new STLExporter().parse(visibleCopy, { binary: true }); }
      else if (ext === "obj") { const { OBJExporter } = await import("three/addons/exporters/OBJExporter.js"); data = new TextEncoder().encode(new OBJExporter().parse(visibleCopy)); }
      else { const { GLTFExporter } = await import("three/addons/exporters/GLTFExporter.js"); data = await new GLTFExporter().parseAsync(visibleCopy, { binary: true, onlyVisible: true }); }
      await api("save", { path: target }, { body: new Uint8Array(data.buffer ? data.buffer : data) });
      return { switchTo: false };
    },
    dispose() { running = false; window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onKey); renderer.dispose(); (info.modelIDs || []).forEach(m => info.ifc?.CloseModel?.(m)); },
  };
}

const fmt = v => Number(v).toLocaleString("it-IT", { maximumFractionDigits: 3 });
