// Realta' aumentata dal visualizzatore 3D ("Vedi in AR"), tutto nel telefono:
// - Android (Chrome): sessione WebXR "immersive-ar" con hit-test: cerchio sul pavimento, tocco = appoggia il modello,
//   un dito = ruota, due dita = scala (100% = scala reale), "Sposta" = riappoggia altrove.
//   Scene Viewer di Google non si usa: scarica il modello da un indirizzo pubblico, mentre qui il file resta sul telefono.
// - iPhone/iPad: AR Quick Look con un USDZ creato al momento (USDZExporter di three.js), ancorato a un piano orizzontale;
//   rotazione e scala con i gesti di Quick Look.
// Il modello si prepara in metri: unita' del file (mm per CAD e mesh, m per IFC/glTF/Navisworks, modificabile) e scala
// di riduzione (1:1 = grandezza reale, 1:50 per un edificio sul tavolo...); base del modello appoggiata a quota 0.
import * as THREE from "three";
import { el, loadCss, toast, withExt } from "./core.js";
import { t as tr, LOCALE } from "./i18n.js";

const UNITS = [["mm", 0.001, "ar.u_mm"], ["cm", 0.01, "ar.u_cm"], ["m", 1, "ar.u_m"], ["in", 0.0254, "ar.u_in"], ["ft", 0.3048, "ar.u_ft"]];
const SCALES = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
const METRIC = ["ifc", "nwd", "nwc", "nwf", "glb", "gltf", "usdz", "vrm"];

export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const quickLook = () => { const a = document.createElement("a"); return !!a.relList?.supports?.("ar"); };
async function webxrAR() {
  try { return !!(navigator.xr && await navigator.xr.isSessionSupported("immersive-ar")); } catch { return false; }
}

// ---------------------------------------------------------------- copia del modello per l'AR
// Solo le mesh visibili (niente copie di selezione dei modelli uniti), materiali MeshStandardMaterial (l'unico tipo che
// USDZ conosce), mesh con piu' materiali divise in parti, istanze espanse, trasformazioni specchiate applicate ai vertici.
function compact(g, start, count) {
  const src = g.index ? g.index.array : null;
  const remap = new Map(), idx = [];
  const end = Math.min(start + count, src ? src.length : g.attributes.position.count);
  for (let i = start; i < end; i++) {
    const o = src ? src[i] : i;
    let k = remap.get(o);
    if (k === undefined) { k = remap.size; remap.set(o, k); }
    idx.push(k);
  }
  const out = new THREE.BufferGeometry();
  const order = [...remap.keys()];
  for (const [name, a] of Object.entries(g.attributes)) {
    if (a.isInterleavedBufferAttribute) continue;
    const arr = new a.array.constructor(order.length * a.itemSize);
    for (let j = 0; j < order.length; j++) for (let c = 0; c < a.itemSize; c++) arr[j * a.itemSize + c] = a.array[order[j] * a.itemSize + c];
    out.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
  }
  out.setIndex(order.length > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  return out;
}

function standard(src, cache) {
  if (!src) src = { color: new THREE.Color(0.75, 0.75, 0.75) };
  if (cache.has(src)) return cache.get(src);
  const m = new THREE.MeshStandardMaterial({
    color: src.color ? src.color.clone() : new THREE.Color(0.75, 0.75, 0.75),
    map: src.map || null,
    vertexColors: !!src.vertexColors,
    opacity: src.opacity ?? 1,
    transparent: (src.opacity ?? 1) < 1,
    roughness: src.isMeshStandardMaterial ? src.roughness : 0.75,
    metalness: src.isMeshStandardMaterial ? src.metalness : 0,
    side: src.side ?? THREE.FrontSide,
  });
  m.name = src.name || "";
  cache.set(src, m);
  return m;
}

export function prepareModel(model, maxInstances = 20000) {
  model.updateMatrixWorld(true);
  const group = new THREE.Group();
  const cache = new Map();
  const visible = o => { for (let x = o; x; x = x.parent) { if (x === model) return true; if (!x.visible) return false; } return true; };
  const box = new THREE.Box3(), tmp = new THREE.Box3();
  let tris = 0, instances = 0;
  const add = (geometry, material, matrix) => {
    if (!geometry.attributes.position || !geometry.attributes.position.count) return;
    let g = geometry, mtx = matrix.clone();
    if (mtx.determinant() < 0) {
      // USDZ non accetta scale negative: si applica la trasformazione ai vertici e si inverte il verso dei triangoli
      g = (g.index ? g : compact(g, 0, g.attributes.position.count)).clone();
      g.applyMatrix4(mtx);
      const ix = g.index.array;
      for (let i = 0; i + 2 < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; }
      g.index.needsUpdate = true;
      mtx = new THREE.Matrix4();
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, standard(material, cache));
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(mtx);
    mesh.castShadow = true;
    group.add(mesh);
    if (!g.boundingBox) g.computeBoundingBox();
    box.union(tmp.copy(g.boundingBox).applyMatrix4(mtx));
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  };
  model.traverse(m => {
    if (!m.isMesh || !m.geometry || m.userData.proxy || !visible(m)) return;
    const mats = Array.isArray(m.material) ? m.material : null;
    const parts = mats && m.geometry.groups.length
      ? m.geometry.groups.map(gr => [compact(m.geometry, gr.start, gr.count), mats[gr.materialIndex]])
      : [[m.geometry, mats ? mats[0] : m.material]];
    if (m.isInstancedMesh) {
      const im = new THREE.Matrix4(), world = new THREE.Matrix4();
      for (let i = 0; i < m.count && instances < maxInstances; i++, instances++) {
        m.getMatrixAt(i, im);
        world.multiplyMatrices(m.matrixWorld, im);
        for (const [g, mat] of parts) add(g, mat, world);
      }
    } else for (const [g, mat] of parts) add(g, mat, m.matrixWorld);
  });
  return { group, box, tris: Math.round(tris), count: group.children.length };
}

// gruppo esterno in metri: base del modello a quota 0, centrato in pianta
function placed(prep, scale) {
  const c = prep.box.getCenter(new THREE.Vector3());
  const inner = new THREE.Group();
  inner.add(prep.group);
  inner.position.set(-c.x, -prep.box.min.y, -c.z);
  const outer = new THREE.Group();
  outer.add(inner);
  outer.scale.setScalar(scale);
  outer.updateMatrixWorld(true);
  return outer;
}

// ---------------------------------------------------------------- finestra "Vedi in AR"
export async function openAR({ model, ext, name }) {
  window.MBStat?.track("fn", "realta_aumentata"); // statistiche anonime (solo con consenso)
  loadCss("css/ar.css");
  const [xr, ql] = [await webxrAR(), quickLook()];
  const ios = isIOS();
  const prep = prepareModel(model);
  if (!prep.count) return toast(tr("ar.nessun_oggetto_visibile_mostrare_ar"), true);
  const size = prep.box.getSize(new THREE.Vector3());
  let unit = METRIC.includes((ext || "").toLowerCase()) ? 1 : 0.001;
  let denom = 1;
  // se in metri il modello risulta piu' grande di 30 m si propone gia' una scala ridotta (si cambia a mano)
  const longest = () => Math.max(size.x, size.y, size.z) * unit;
  if (longest() > 30) denom = SCALES.find(s => longest() / s <= 3) || 1000;

  const unitSel = el("select", { onchange: () => { unit = +unitSel.value; refresh(); } },
    ...UNITS.map(([k, f, label]) => el("option", { value: f, selected: Math.abs(f - unit) < 1e-9 }, `${tr(label)} (${k})`)));
  const scaleSel = el("select", { onchange: () => { denom = +scaleSel.value; refresh(); } },
    ...SCALES.map(s => el("option", { value: s, selected: s === denom }, s === 1 ? tr("ar.scala_reale") : "1:" + s)));
  const dims = el("div", { class: "ar-dims" });
  const status = el("div", { class: "note" });
  const fmt = v => v >= 1 ? v.toLocaleString(LOCALE, { maximumFractionDigits: 2 }) + " m" : (v * 100).toLocaleString(LOCALE, { maximumFractionDigits: 1 }) + " cm";
  function refresh() {
    const k = unit / denom;
    dims.textContent = tr("ar.ingombro_ar_0_1_pianta", fmt(size.x * k), fmt(size.z * k), fmt(size.y * k));
    usdzUrl = null;
    if (link) { link.remove(); link = null; }
  }
  let usdzUrl = null, link = null;

  const back = el("div", { class: "modal-back ar-dialog" });
  const close = () => {
    back.remove(); document.removeEventListener("keydown", onKey);
    if (window.MBV_BACK === close) window.MBV_BACK = null;
    if (usdzUrl) setTimeout(() => URL.revokeObjectURL(usdzUrl), 60000);
    return true;
  };
  const onKey = e => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  window.MBV_BACK = close; // tasto indietro del telefono: chiude la finestra

  const startBtn = el("button", { class: "btn primary", type: "button" }, tr("ar.avvia_realta_aumentata"));
  const actions = el("div", { class: "row" }, el("button", { class: "btn", type: "button", onclick: close }, tr("common.chiudi")));
  let help;
  if (xr) help = tr("ar.inquadra_pavimento_muovi_poco_telefono");
  else if (ql) help = tr("ar.si_apre_ar_quick_look");
  else if (ios) help = tr("ar.questo_iphone_ipad_non_apre");
  else help = tr("ar.questo_dispositivo_browser_non_supporta");
  if (xr || ql) actions.append(startBtn);
  actions.append(el("button", { class: "btn", type: "button", onclick: () => saveCopy("glb") }, tr("ar.salva_glb")),
    el("button", { class: "btn", type: "button", onclick: () => saveCopy("usdz") }, tr("ar.salva_usdz")));

  back.append(el("div", { class: "modal ar-box" },
    el("h3", {}, tr("ar.vedi_realta_aumentata")),
    el("div", { class: "ar-grid" },
      el("label", {}, tr("ar.unita_file"), unitSel),
      el("label", {}, tr("ar.scala"), scaleSel)),
    dims,
    el("p", { class: "note" }, tr("ar.0_parti_1_triangoli", prep.count.toLocaleString(LOCALE), prep.tris.toLocaleString(LOCALE)) +
      (prep.tris > 1500000 ? tr("ar.modello_molto_pesante_telefono_potrebbe") : "")),
    el("p", {}, help), status, actions));
  document.body.append(back);
  refresh();

  async function usdz() {
    const { USDZExporter } = await import("three/addons/exporters/USDZExporter.js");
    const scene = new THREE.Scene();
    scene.add(placed(prep, unit / denom));
    scene.updateMatrixWorld(true);
    const data = await new USDZExporter().parseAsync(scene, { quickLookCompatible: true, ar: { anchoring: { type: "plane" }, planeAnchoring: { alignment: "horizontal" } } });
    return new Blob([data], { type: "model/vnd.usdz+zip" });
  }
  async function glb() {
    const { GLTFExporter } = await import("three/addons/exporters/GLTFExporter.js");
    const scene = new THREE.Scene();
    scene.add(placed(prep, unit / denom));
    const data = await new GLTFExporter().parseAsync(scene, { binary: true });
    return new Blob([data], { type: "model/gltf-binary" });
  }
  async function saveCopy(kind) {
    status.textContent = tr("ar.preparazione_file");
    try {
      const blob = kind === "glb" ? await glb() : await usdz();
      const fname = withExt(name || "modello", kind);
      const file = new File([blob], fname, { type: blob.type });
      if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title: fname }); status.textContent = ""; return; } catch (e) { if (e.name === "AbortError") { status.textContent = ""; return; } }
      }
      const a = el("a", { href: URL.createObjectURL(blob), download: fname });
      document.body.append(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
      status.textContent = "";
    } catch (e) { status.textContent = tr("ar.non_riuscito") + e.message; }
  }

  startBtn.addEventListener("click", async () => {
    if (xr) {
      // la sessione WebXR va chiesta subito, durante il tocco dell'utente
      close();
      try { await runWebXR(placed(prep, unit / denom), unit / denom); } catch (e) { toast(tr("ar.realta_aumentata_non_avviata") + e.message, true, 7000); }
      return;
    }
    // iPhone: il file USDZ si crea al primo tocco; il collegamento rel="ar" (con un'immagine dentro, come vuole Apple) apre Quick Look
    startBtn.disabled = true;
    status.textContent = tr("ar.preparazione_modello_quick_look");
    try {
      if (!usdzUrl) usdzUrl = URL.createObjectURL(await usdz());
      status.textContent = "";
      link = el("a", { rel: "ar", href: usdzUrl, class: "btn primary ar-link" },
        el("img", { src: "img/logo.png", alt: "", width: 1, height: 1 }), tr("ar.apri_ar_quick_look"));
      startBtn.replaceWith(link);
      link.click(); // se il tempo del tocco e' scaduto resta il pulsante da toccare
    } catch (e) {
      status.textContent = tr("ar.preparazione_non_riuscita") + e.message;
      startBtn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------- sessione WebXR (Android)
async function runWebXR(object, realScale) {
  const overlay = el("div", { class: "ar-overlay" });
  const hint = el("div", { class: "ar-hint" }, tr("ar.muovi_lentamente_telefono_inquadrando_pavimento"));
  const scaleLabel = el("div", { class: "ar-scale" }, "100%");
  const bar = el("div", { class: "ar-bar" });
  overlay.append(hint, scaleLabel, bar);
  document.body.append(overlay);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 5000);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8d8d8d, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  scene.add(sun, sun.target);

  // contenitore: posizione sul pavimento, rotazione e scala dei gesti; ombra morbida sotto il modello
  const holder = new THREE.Group();
  holder.visible = false;
  holder.add(object);
  const box = new THREE.Box3().setFromObject(object);
  const radius = Math.max(0.05, box.getSize(new THREE.Vector3()).length() / 2);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(radius * 4, radius * 4), new THREE.ShadowMaterial({ opacity: 0.3 }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.receiveShadow = true;
  holder.add(shadow);
  scene.add(holder);
  const cam = sun.shadow.camera;
  Object.assign(cam, { left: -radius * 1.5, right: radius * 1.5, top: radius * 1.5, bottom: -radius * 1.5, near: 0.01, far: radius * 8 });
  cam.updateProjectionMatrix();

  const reticle = new THREE.Mesh(new THREE.RingGeometry(0.09, 0.11, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  const session = await navigator.xr.requestSession("immersive-ar", {
    requiredFeatures: ["hit-test"], optionalFeatures: ["dom-overlay"], domOverlay: { root: overlay },
  });
  renderer.xr.setReferenceSpaceType("local");
  await renderer.xr.setSession(session);
  const viewerSpace = await session.requestReferenceSpace("viewer");
  const hitSource = await session.requestHitTestSource({ space: viewerSpace });
  const hasOverlay = !!session.domOverlayState;

  let placing = true, scale = 1, everPlaced = false;
  const setScale = s => { scale = Math.min(50, Math.max(0.02, s)); holder.scale.setScalar(scale); scaleLabel.textContent = Math.round(scale * 100) + "%" + (realScale === 1 && Math.abs(scale - 1) < 0.005 ? tr("ar.grandezza_reale") : ""); };
  setScale(1);
  const place = () => {
    if (!reticle.visible) return;
    holder.position.setFromMatrixPosition(reticle.matrix);
    // il modello guarda verso chi lo appoggia
    const cp = new THREE.Vector3().setFromMatrixPosition(renderer.xr.getCamera().matrixWorld);
    if (!everPlaced) holder.rotation.y = Math.atan2(cp.x - holder.position.x, cp.z - holder.position.z);
    holder.visible = true;
    placing = false;
    everPlaced = true;
    sun.position.copy(holder.position).add(new THREE.Vector3(radius * 2, radius * 4, radius * 1.5).multiplyScalar(scale));
    sun.target.position.copy(holder.position);
    hint.textContent = hasOverlay ? tr("ar.dito_ruota_due_dita_scala") : tr("ar.tocca_spostarlo");
    moveBtn.hidden = false;
  };

  const btn = (label, fn, cls = "") => { const b = el("button", { type: "button", class: "ar-btn " + cls }, label); b.addEventListener("click", e => { e.stopPropagation(); fn(); }); return b; };
  const moveBtn = btn(tr("ar.sposta"), () => { placing = true; hint.textContent = tr("ar.inquadra_punto_tocca_schermo_appoggiare"); });
  moveBtn.hidden = true;
  bar.append(btn(tr("ar.esci"), () => session.end(), "exit"), moveBtn, btn(tr("ar.ruota_90"), () => (holder.rotation.y -= Math.PI / 2)), btn("100%", () => setScale(1)));
  // i tocchi sui pulsanti non devono diventare "select" della sessione
  bar.addEventListener("beforexrselect", e => e.preventDefault());

  // gesti sulla pellicola trasparente sopra la camera
  const touches = new Map();
  let start = null, moved = false;
  overlay.addEventListener("pointerdown", e => {
    if (e.target.closest(".ar-bar")) return;
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    moved = false;
    if (touches.size === 2) { const [a, b] = [...touches.values()]; start = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: scale }; }
  });
  overlay.addEventListener("pointermove", e => {
    const p = touches.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p[0];
    if (Math.abs(dx) + Math.abs(e.clientY - p[1]) > 3) moved = true;
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (touches.size === 1 && !placing && holder.visible) holder.rotation.y += dx * 0.012;
    else if (touches.size === 2 && start) { const [a, b] = [...touches.values()]; setScale(start.s * Math.hypot(a[0] - b[0], a[1] - b[1]) / start.d); }
  });
  const up = e => {
    if (!touches.has(e.pointerId)) return;
    touches.delete(e.pointerId);
    if (touches.size < 2) start = null;
    if (!moved && touches.size === 0 && placing) place();
  };
  overlay.addEventListener("pointerup", up);
  overlay.addEventListener("pointercancel", up);
  // senza dom-overlay restano solo i tocchi della sessione: appoggia / riappoggia
  if (!hasOverlay) session.addEventListener("select", () => { placing = true; place(); });

  renderer.setAnimationLoop((t, frame) => {
    if (frame) {
      const ref = renderer.xr.getReferenceSpace();
      const hit = frame.getHitTestResults(hitSource)[0];
      const pose = hit && hit.getPose(ref);
      reticle.visible = !!pose && placing;
      if (pose) {
        reticle.matrix.fromArray(pose.transform.matrix);
        if (placing && !everPlaced) hint.textContent = tr("ar.tocca_schermo_appoggiare_modello_cerchio");
      }
    }
    renderer.render(scene, camera);
  });

  window.MBV_BACK = () => { session.end().catch(() => {}); return true; };
  await new Promise(resolve => session.addEventListener("end", resolve, { once: true }));
  window.MBV_BACK = null;
  renderer.setAnimationLoop(null);
  hitSource.cancel?.();
  renderer.dispose();
  overlay.remove();
}
