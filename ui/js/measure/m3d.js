// Misure sui modelli 3D/BIM (ui/js/viewers/model3d.js): stessi strumenti del 2D con i punti presi sulla superficie
// (aggancio a vertici, punti medi degli spigoli, centri delle facce piane, punti delle nuvole), piu' area di una faccia,
// quantita' di un elemento (volume, superficie, ingombro) e area della sezione con un clic. Estrazioni: volumi, superfici,
// lunghezze e conteggi per elemento / classe / materiale / livello (IFC, mesh, STEP, IGES, Navisworks, SketchUp...),
// sezioni con area, nuvole di punti (punti, ingombro, impronta, volume sopra una quota). Misure nel file .mbmis accanto.
import { el, loadCss, WEB } from "../core.js";
import { t as tr } from "../i18n.js";
import * as C from "./mcore.js";
import { createSession } from "./mpanel.js";
import { createEngine2d } from "./mtool.js";
import { mbmisStore } from "./mcad.js";

const METERS = ["ifc", "nwd", "nwc", "nwf", "glb", "gltf", "usdz", "vrm", "skp", "las", "laz", "e57", "pts", "ptx", "xyz", "rcs", "rcp"];

export async function attach3d(h) {
  loadCss("css/measure.css");
  const { THREE, ctx, camera, renderer, model, info } = h;
  const src = (ctx.ext || "").toLowerCase();
  const unit = METERS.includes(src) || info.clouds ? "m" : "mm";
  const store = mbmisStore(ctx);
  const overlay = el("canvas", { class: "mm-3d-overlay" });
  h.box.append(overlay);
  const env = {
    space: "3d", host: h.box, ctx, base: { k: 1, unit, label: unit }, autosave: !WEB,
    unitNote: tr("mis.unita_3d", unit),
    tools: ["refelev", "len", "pline", "perim", "area", "vol", "ang", "rad", "elev", "count", "face", "element", "section"],
    redraw: () => kick(),
    focus: m => focusPts(m.pts),
    showRecs: recs => { const objs = recs.map(r => r.obj).filter(Boolean); if (objs.length) { h.select(objs, { scroll: false }); h.zoomTo(objs); } },
    onTool: () => kick(),
    onPanel: v => { h.measureActive = v; kick(); },
    persist: doc => store.persist(doc),
    extractors: extractors3d(h, () => M),
  };
  const M = createSession(env);
  M.doc.disp.unit = unit === "mm" ? "m" : unit;
  // IFC: quota di livello = Z del progetto (la scena e' spostata dalla matrice di coordinamento)
  if (src === "ifc" && info.coordMatrix) M.doc.ref = { y: info.coordMatrix[13] || 0, value: 0 };
  const E = (M.engine = createEngine2d(M));
  const d0 = await store.load();
  if (d0) M.loadDoc(d0);
  M.doc.space = "3d";

  // ---------------------------------------------------------------- superficie 3D (proiezione + raggio)
  const ray = new THREE.Raycaster(), v3 = new THREE.Vector3();
  let evHits = null, evPt = null;
  const rect = () => renderer.domElement.getBoundingClientRect();
  const toScreen = p => {
    v3.set(p[0], p[1], p[2] || 0).project(camera);
    if (v3.z > 1 || v3.z < -1) return [NaN, NaN];
    const r = rect();
    return [((v3.x + 1) / 2) * r.width, ((1 - v3.y) / 2) * r.height];
  };
  function hitsAt(sx, sy) {
    const r = rect();
    ray.setFromCamera(new THREE.Vector2((sx / r.width) * 2 - 1, -(sy / r.height) * 2 + 1), camera);
    const pxWorld = (2 * camera.position.distanceTo(h.controls.target) * Math.tan((camera.fov * Math.PI) / 360)) / r.height;
    ray.params.Line.threshold = ray.params.Points.threshold = pxWorld * 6;
    const clipped = p => renderer.clippingPlanes.some(pl => pl.distanceToPoint(p) < 0);
    return ray.intersectObject(model, true).filter(x => x.object.visible && h.isVisibleChain(x.object) && !clipped(x.point) && !x.object.userData.pcHelper);
  }
  const worldV = (obj, i, out = new THREE.Vector3()) => out.fromBufferAttribute(obj.geometry.attributes.position, i).applyMatrix4(obj.matrixWorld);
  const faceCache = new Map();
  function snap3(sx, sy, hits) {
    if (!hits?.length) return null;
    const hit = hits[0], o = hit.object, tol = 12;
    const cand = [];
    if (o.isPoints && hit.index != null) { const p = worldV(o, hit.index); return { x: p.x, y: p.y, z: p.z, k: "nod", p: [p.x, p.y, p.z] }; }
    if (o.isLine && hit.index != null) {
      const a = worldV(o, hit.index), b = worldV(o, hit.index + 1);
      cand.push([a, "end"], [b, "end"], [a.clone().add(b).multiplyScalar(0.5), "mid"]);
    } else if (hit.face) {
      const { a, b, c } = hit.face;
      const A = worldV(o, a), B = worldV(o, b), Cc = worldV(o, c);
      cand.push([A, "end"], [B, "end"], [Cc, "end"]);
      // punti medi solo sugli spigoli veri (non sulle diagonali interne delle facce piane): si accettano tutti, il piu' vicino vince
      cand.push([A.clone().add(B).multiplyScalar(0.5), "mid"], [B.clone().add(Cc).multiplyScalar(0.5), "mid"], [Cc.clone().add(A).multiplyScalar(0.5), "mid"]);
      const f = planarOf(o, hit.faceIndex, true);
      if (f) cand.push([new THREE.Vector3(...f.center), "cen"]);
    }
    let best = null, bd = tol;
    for (const [p, k] of cand) {
      const s = toScreen([p.x, p.y, p.z]);
      const d = Math.hypot(s[0] - sx, s[1] - sy) + (k === "cen" ? 2 : 0);
      if (d < bd) { bd = d; best = { x: p.x, y: p.y, z: p.z, k, p: [p.x, p.y, p.z] }; }
    }
    return best;
  }
  // faccia piana (triangoli complanari collegati) attorno al triangolo colpito; sulle mesh grandi solo al clic
  function planarOf(o, fi, hover) {
    if (fi == null || !o.geometry?.attributes?.position) return null;
    const key = o.uuid + ":" + fi;
    if (faceCache.has(key)) return faceCache.get(key);
    const g = o.geometry, n = (g.index ? g.index.count : g.attributes.position.count) / 3;
    if (hover && n > 20000) return null;
    const { pos, index } = flat(g);
    const f = C.planarFace(pos, index, o.matrixWorld.elements, fi);
    if (faceCache.size > 400) faceCache.clear();
    faceCache.set(key, f);
    return f;
  }
  const surf = {
    page: null, px: 1,
    toScreen,
    toWorld: () => (evPt ? [...evPt] : null),
    snap: (sx, sy) => { const s = snap3(sx, sy, evHits); return s ? { x: s.x, y: s.y, k: s.k, p: s.p } : null; },
    redraw: () => kick(),
  };

  // ---------------------------------------------------------------- eventi (il clic arriva da model3d.js: pickHook)
  const posOf = e => { const r = rect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const setEv = (hits) => { evHits = hits; const s = hits?.length ? snap3(...lastXY, hits) : null; evPt = s ? s.p : hits?.length ? pointOf(hits) : null; };
  let lastXY = [0, 0];
  function pointOf(hits) {
    const hit = hits[0];
    if (hit.object.isPoints && hit.index != null) { const p = worldV(hit.object, hit.index); return [p.x, p.y, p.z]; }
    return [hit.point.x, hit.point.y, hit.point.z];
  }
  h.pickHook = (e, hits) => {
    if (!M.panel.open || !M.tool) return false;
    lastXY = posOf(e);
    if (["face", "element", "section"].includes(M.tool)) { objectTool(M.tool, hits); return true; }
    if (M.tool === "select") { const m = E.hitItem(surf, ...lastXY); M.select(m ? m.id : null, e.ctrlKey); return true; }
    if (!hits.length) return true;
    setEv(hits);
    E.down(surf, ...lastXY, { button: 0, shiftKey: false, altKey: e.altKey, ctrlKey: e.ctrlKey });
    return true;
  };
  let mvT = 0;
  const onMove = e => {
    if (!M.panel.open || !M.tool || M.tool === "select" || e.buttons) return;
    const now = performance.now();
    if (now - mvT < 45) return;
    mvT = now;
    lastXY = posOf(e);
    const hits = hitsAt(...lastXY);
    if (!hits.length) { if (E.hover) { E.hover = null; kick(); } return; }
    setEv(hits);
    if (!["face", "element", "section"].includes(M.tool)) E.move(surf, ...lastXY, { altKey: e.altKey, shiftKey: false });
    kick();
  };
  renderer.domElement.addEventListener("pointermove", onMove);
  const onDbl = e => { if (M.panel.open && M.tool && E.dbl(surf, ...posOf(e), e)) e.preventDefault(); };
  renderer.domElement.addEventListener("dblclick", onDbl, true);
  const onCtx = e => { if (M.panel.open && E.context()) e.preventDefault(); };
  renderer.domElement.addEventListener("contextmenu", onCtx);
  const onKey = e => {
    if (ctx.tab.view.hidden || !M.panel.open || e.target.closest?.("input, textarea, select")) return;
    if (E.key(e)) { e.preventDefault(); e.stopPropagation(); }
  };
  window.addEventListener("keydown", onKey, true);

  // ---------------------------------------------------------------- strumenti sugli oggetti
  function targetOf(hit) {
    const pick = hit.object.userData.merged ? hit.object.parent?.userData.pick : null;
    const fi = hit.faceIndex ?? (hit.index != null ? Math.floor(hit.index / (hit.object.userData.merged?.per || 1)) : null);
    return pick ? pick(hit.object, fi) : h.unitOf(hit.object);
  }
  function objectTool(tool, hits) {
    const hit = hits[0];
    if (!hit && tool !== "section") return M.hint("nessun_oggetto");
    const opt = M.opt;
    const base = { id: C.uid(), type: "obj", page: null, color: opt.color, voce: opt.voce, layer: opt.layer, note: "", unit, created: new Date().toISOString() };
    if (tool === "face") {
      if (!hit.face) return M.hint("nessun_oggetto");
      const f = planarOf(hit.object, hit.faceIndex, false);
      if (!f) return;
      const tgt = targetOf(hit);
      M.add({ ...base, pts: [f.center], q: { area: f.area }, kind: "area", name: tr("mis.faccia") + (tgt?.name ? " · " + shortName(tgt) : "") });
      return;
    }
    if (tool === "element") {
      const tgt = targetOf(hit);
      if (!tgt) return;
      const q = elementQ(tgt);
      const c = [(q.min[0] + q.max[0]) / 2, (q.min[1] + q.max[1]) / 2, (q.min[2] + q.max[2]) / 2];
      M.add({ ...base, pts: [c], q: { vol: q.closed ? q.vol : null, area: q.area, len: q.len }, kind: q.closed ? "vol" : "area", name: shortName(tgt), layer: opt.layer || classOf(tgt), note: q.closed ? "" : tr("mis.mesh_aperta") });
      h.select([tgt], { scroll: false });
      return;
    }
    // sezione: piano di sezione attivo, altrimenti orizzontale nel punto cliccato
    const pl = renderer.clippingPlanes[0];
    const plane = pl ? { n: [pl.normal.x, pl.normal.y, pl.normal.z], d: pl.constant } : hit ? { n: [0, 1, 0], d: -hit.point.y } : null;
    if (!plane) return M.hint("sezione_serve_piano");
    const r = sectionQ(model, plane, o => h.isVisibleChain(o));
    const at = hit ? pointOf(hits) : [0, -plane.d, 0];
    M.add({ ...base, pts: [at], q: { area: r.area, len: r.perimeter }, kind: "area", name: tr("mis.sezione") + (plane.n[1] > 0.99 ? " " + tr("mis.a_quota", M.fmtNum(C.toDisp(C.elevOf([0, -plane.d], M.doc, M.doc.base), "len", unit, M.doc)) + " " + C.dispUnit("len", M.doc)) : "") });
  }
  const shortName = o => elName(h, o);
  const classOf = o => o.userData?.ifcType || (o.userData?.expressID !== undefined ? o.name : "") || o.userData?.classe || o.userData?.layerName || "";

  // ---------------------------------------------------------------- disegno sopra la scena
  let raf = 0;
  function kick() { if (!raf) raf = requestAnimationFrame(frame); }
  function frame() {
    raf = 0;
    const r = h.box.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    if (overlay.width !== Math.round(r.width * dpr) || overlay.height !== Math.round(r.height * dpr)) { overlay.width = Math.round(r.width * dpr); overlay.height = Math.round(r.height * dpr); }
    const g = overlay.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, overlay.width, overlay.height);
    if (!(M.doc.items.length || E.cur || (M.panel.open && M.tool))) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    E.paint(surf, g);
    if (M.doc.items.length || E.cur) raf = requestAnimationFrame(frame); // la camera si muove: si ridisegna sempre
  }
  function focusPts(P) {
    if (!P?.length) return;
    const b = new THREE.Box3();
    for (const p of P) b.expandByPoint(new THREE.Vector3(p[0], p[1], p[2] || 0));
    const c = b.getCenter(new THREE.Vector3()), size = Math.max(b.getSize(new THREE.Vector3()).length(), 1e-3);
    const dir = camera.position.clone().sub(h.controls.target).normalize();
    h.controls.target.copy(c);
    camera.position.copy(c).add(dir.multiplyScalar(size * 2.2 + 0.5 * (unit === "mm" ? 1000 : 1)));
    h.controls.update();
    kick();
  }
  kick();
  return {
    M, E,
    get open() { return M.panel.open; },
    toggle: () => { M.panel.toggle(); kick(); },
    dispose() {
      M.flushSave?.().catch(() => {});
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("dblclick", onDbl, true);
      renderer.domElement.removeEventListener("contextmenu", onCtx);
      window.removeEventListener("keydown", onKey, true);
      cancelAnimationFrame(raf);
    },
  };
}

// nome leggibile di un elemento: IFC = Name (o Tag) della riga, altrimenti il nome del nodo
function elName(h, o) {
  const id = o.userData?.expressID, ifc = h.info.ifc;
  if (id !== undefined && ifc) {
    try { const l = ifc.GetLine(o.userData.modelID ?? h.info.modelID, id, false); const n = l.Name?.value || l.Tag?.value; if (n) return n; } catch { /* */ }
  }
  return (o.name || o.userData?.name || "").replace(/\s+#\d+$/, "") || "#" + (id ?? o.id);
}

// ---------------------------------------------------------------- geometria delle mesh
export function flat(g) {
  const a = g.attributes.position;
  let pos;
  if (a.isInterleavedBufferAttribute || a.itemSize !== 3) { pos = new Float32Array(a.count * 3); for (let i = 0; i < a.count; i++) { pos[3 * i] = a.getX(i); pos[3 * i + 1] = a.getY(i); pos[3 * i + 2] = a.getZ(i); } }
  else pos = a.array;
  return { pos, index: g.index ? g.index.array : null };
}
// mesh chiusa: ogni spigolo (vertici confrontati per posizione) usato da un numero pari di triangoli
function isClosed(pos, index, limit = 600000) {
  const n = index ? index.length : pos.length / 3;
  if (n > limit) return true;
  const key = i => `${Math.round(pos[3 * i] * 1e4)},${Math.round(pos[3 * i + 1] * 1e4)},${Math.round(pos[3 * i + 2] * 1e4)}`;
  const vid = new Map(), id = i => { const k = key(i); let v = vid.get(k); if (v === undefined) vid.set(k, (v = vid.size)); return v; };
  const edges = new Map();
  for (let t = 0; t + 2 < n; t += 3) {
    const a = id(index ? index[t] : t), b = id(index ? index[t + 1] : t + 1), c = id(index ? index[t + 2] : t + 2);
    for (const [p, q] of [[a, b], [b, c], [c, a]]) { if (p === q) continue; const k = p < q ? p * 4294967296 + q : q * 4294967296 + p; edges.set(k, (edges.get(k) || 0) + 1); }
  }
  for (const v of edges.values()) if (v % 2) return false;
  return true;
}
export function elementQ(obj) {
  let vol = 0, area = 0, closed = true, any = false;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  obj.updateMatrixWorld?.(true);
  obj.traverse(m => {
    if (!m.isMesh || m.userData.merged || !m.geometry?.attributes?.position) return;
    const { pos, index } = flat(m.geometry);
    const q = C.meshQuantities(pos, index, m.matrixWorld.elements);
    if (!q.area) return;
    any = true;
    vol += Math.abs(q.signed);
    area += q.area;
    if (closed && !isClosed(pos, index)) closed = false;
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], q.min[k]); hi[k] = Math.max(hi[k], q.max[k]); }
  });
  if (!any) return { vol: 0, area: 0, len: 0, closed: false, min: [0, 0, 0], max: [0, 0, 0] };
  return { vol, area, len: Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]), dims: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], closed, min: lo, max: hi };
}
export function sectionQ(root, plane, visible = () => true, perObj = null) {
  let area = 0, perimeter = 0;
  root.updateMatrixWorld?.(true);
  const eps = (() => { const b = []; root.traverse(m => { if (m.isMesh && m.geometry?.boundingSphere) b.push(m.geometry.boundingSphere.radius); }); return Math.max(1e-7, (Math.max(...b, 1) || 1) * 2e-6); })();
  root.traverse(m => {
    if (!m.isMesh || m.userData.merged || !m.geometry?.attributes?.position || !visible(m.userData.proxy ? m.parent : m)) return;
    const { pos, index } = flat(m.geometry);
    const segs = C.sectionSegments(pos, index, m.matrixWorld.elements, plane);
    if (!segs.length) return;
    const r = C.sectionArea(segs, plane, eps);
    area += r.area;
    perimeter += r.perimeter;
    perObj?.(m, r);
  });
  return { area, perimeter };
}

// ---------------------------------------------------------------- estrazioni 3D
function extractors3d(h, getM) {
  const { info } = h;
  const units = () => {
    const out = new Map();
    h.model.traverse(m => {
      if (!m.isMesh || m.userData.merged || !m.geometry?.attributes?.position) return;
      const u = h.unitOf(m);
      if (!out.has(u)) out.set(u, true);
    });
    return [...out.keys()];
  };
  const ifcMeta = (() => {
    let cache = null;
    return async () => {
      if (cache) return cache;
      const lv = new Map();
      cache = { level: { get: key => { const [mid, id] = key.split(":"); return lv.get(+mid)?.(+id)?.name || ""; } }, mat: new Map() };
      if (!info.ifc) return cache;
      const Q = await import("../qtocore.js");
      const W = info.WEBIFC;
      for (const mid of info.modelIDs || [info.modelID]) {
        try { lv.set(mid, Q.levelMap(info.ifc, W, mid).levelOf); } catch { /* */ }
        try { for (const [id, name] of ifcMaterials(info.ifc, W, mid)) cache.mat.set(mid + ":" + id, name); } catch { /* */ }
      }
      return cache;
    };
  })();
  const matName = o => { let n = ""; o.traverse(m => { if (!n && m.isMesh) { const mt = Array.isArray(m.material) ? m.material[0] : m.material; n = mt?.name || ""; } }); return n; };
  const cls = o => o.userData?.ifcType || (o.userData?.expressID !== undefined ? o.name : "") || o.userData?.classe || o.userData?.layerName || o.parent?.name || "";
  const nameOf = o => elName(h, o);
  return [
    { id: "elements", label: tr("mis.x_elementi"), title: tr("mis.x_elementi_titolo"), run: async () => {
      const meta = await ifcMeta();
      const recs = [];
      let open = 0;
      for (const u of units()) {
        if (!h.isVisibleChain(u)) continue;
        const q = elementQ(u);
        if (!q.area) continue;
        if (!q.closed) open++;
        const key = u.userData.modelID + ":" + u.userData.expressID;
        const lv = meta.level.get(key);
        recs.push({ g: { cls: cls(u) || "—", mat: meta.mat.get(key) || matName(u) || "—", level: lv || "—", name: nameOf(u) }, page: null, at: null, len: q.len, area: q.area, vol: q.closed ? q.vol : undefined, ents: 1, obj: u });
      }
      return { records: recs, real: true, unit: getM().doc.base.unit, groups: [{ k: "cls", label: tr("mis.classe") }, { k: "mat", label: tr("mis.materiale") }, { k: "level", label: tr("mis.livello") }, { k: "name", label: tr("mis.elemento") }],
        note: tr("mis.x_elementi_nota"), warn: open ? tr("mis.mesh_aperte_n", open) : "" };
    } },
    { id: "section", label: tr("mis.x_sezione"), title: tr("mis.x_sezione_titolo"), run: async () => {
      const pl = h.renderer.clippingPlanes[0];
      let plane;
      if (pl) plane = { n: [pl.normal.x, pl.normal.y, pl.normal.z], d: pl.constant };
      else {
        const b = new h.THREE.Box3().setFromObject(h.model);
        plane = { n: [0, 1, 0], d: -(b.min.y + (b.max.y - b.min.y) * 0.5) };
      }
      const meta = await ifcMeta();
      const recs = [];
      sectionQ(h.model, plane, o => h.isVisibleChain(o), (m, r) => {
        const u = h.unitOf(m);
        const key = u.userData.modelID + ":" + u.userData.expressID;
        recs.push({ g: { cls: cls(u) || "—", mat: meta.mat.get(key) || matName(u) || "—", level: meta.level.get(key) || "—", name: nameOf(u) }, page: null, at: null, area: r.area, len: r.perimeter, ents: 1, obj: u });
      });
      return { records: recs, real: true, unit: getM().doc.base.unit, groups: [{ k: "cls", label: tr("mis.classe") }, { k: "mat", label: tr("mis.materiale") }, { k: "level", label: tr("mis.livello") }, { k: "name", label: tr("mis.elemento") }], note: pl ? tr("mis.sezione_piano_attivo") : tr("mis.sezione_meta_altezza") };
    } },
    ...(info.clouds ? [{ id: "cloud", label: tr("mis.x_nuvola"), title: tr("mis.x_nuvola_titolo"), run: async () => cloudStats(h, getM()) }] : []),
  ];
}
// materiale di ogni elemento IFC (IfcRelAssociatesMaterial: materiale, insieme di strati, elenco, profili)
function ifcMaterials(ifc, W, mid) {
  const out = new Map();
  const ids = ifc.GetLineIDsWithType(mid, W.IFCRELASSOCIATESMATERIAL);
  const val = v => (v && typeof v === "object" && "value" in v ? v.value : v);
  const name = ref => {
    try {
      const m = ifc.GetLine(mid, val(ref), true);
      if (m.Name) return val(m.Name);
      if (m.ForLayerSet) return name(m.ForLayerSet);
      if (m.MaterialLayers) return (m.LayerSetName && val(m.LayerSetName)) || m.MaterialLayers.map(l => val(l.Material?.Name)).filter(Boolean).join(" + ");
      if (m.Materials) return m.Materials.map(x => val(x.Name)).filter(Boolean).join(" + ");
      if (m.MaterialConstituents) return m.MaterialConstituents.map(x => val(x.Material?.Name)).filter(Boolean).join(" + ");
    } catch { /* */ }
    return "";
  };
  for (let k = 0; k < ids.size(); k++) {
    const r = ifc.GetLine(mid, ids.get(k), false);
    const n = name(r.RelatingMaterial);
    for (const e of r.RelatedObjects || []) out.set(val(e), n);
  }
  return out;
}
// nuvole di punti: punti caricati (nodi visibili), ingombro, impronta, volume sopra la quota piu' bassa (o di riferimento)
function cloudStats(h, M) {
  const recs = [];
  for (const cl of h.info.clouds || []) {
    const parts = [];
    let n = 0;
    cl.root?.traverse?.(o => { if (o.isPoints && o.visible && o.geometry?.attributes?.position) { o.updateMatrixWorld(); parts.push(o); n += o.geometry.attributes.position.count; } });
    if (!n) continue;
    const P = new Float32Array(n * 3);
    let k = 0;
    const v = new h.THREE.Vector3();
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const o of parts) {
      const a = o.geometry.attributes.position;
      for (let i = 0; i < a.count; i++) {
        v.fromBufferAttribute(a, i).applyMatrix4(o.matrixWorld);
        P[k++] = v.x; P[k++] = v.y; P[k++] = v.z;
        lo = [Math.min(lo[0], v.x), Math.min(lo[1], v.y), Math.min(lo[2], v.z)];
        hi = [Math.max(hi[0], v.x), Math.max(hi[1], v.y), Math.max(hi[2], v.z)];
      }
    }
    const ext = Math.max(hi[0] - lo[0], hi[2] - lo[2]);
    const cell = Math.max(ext / 300, 1e-3);
    const baseY = M.doc.ref?.set ? M.doc.ref.y : lo[1];
    const gv = C.gridVolume(P, cell, baseY);
    const step = Math.max(1, Math.floor(n / 50000));
    const pts2 = [];
    for (let i = 0; i < n; i += step) pts2.push([P[3 * i], P[3 * i + 2]]);
    const hull = C.hull2(pts2);
    recs.push({ g: { cloud: cl.name || "—", q: tr("mis.nuvola_punti") }, page: null, at: null, count: n, area: C.polyArea(hull), vol: gv.vol, len: hi[1] - lo[1] });
  }
  return { records: recs, real: true, unit: M.doc.base.unit, groups: [{ k: "cloud", label: tr("mis.nuvola") }], note: tr("mis.x_nuvola_nota") };
}
