// Ponte tra le segnalazioni BCF e il visualizzatore 3D (ui/js/viewers/model3d.js): salva e ripristina il punto di vista
// (camera, elementi selezionati/visibili/colorati per GlobalId IFC, piani di sezione, linee) e crea l'istantanea.
// Coordinate BCF = metri nel sistema del progetto con Z in alto. Scena three.js = Y in alto:
//   IFC: scena = C * N * mondo (C = matrice di coordinamento di web-ifc, spostamento verso l'origine; N = Z in alto -> Y in alto)
//   altri modelli: scena = N * S(1/m) * mondo (m = metri per unita' del file; i CAD in mm, glTF/Navisworks in metri)
// Per i modelli non IFC gli elementi si riconoscono con AuthoringToolId = posizione nell'albero della scena ("0/3/1").
const ORIGIN = "MB Visual";

export function bridge(h) {
  const { THREE } = h;
  const N = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
  const isIfc = () => !!(h.info.ifc && h.info.modelIDs?.length);
  function w2s() {
    if (isIfc() && h.info.coordMatrix) return new THREE.Matrix4().fromArray(h.info.coordMatrix).multiply(N);
    const src = (h.ctx.ext || "").toLowerCase();
    const mpu = ["ifc", "nwd", "nwc", "nwf", "glb", "gltf", "usdz", "vrm"].includes(src) ? 1 : 0.001;
    return N.clone().multiply(new THREE.Matrix4().makeScale(1 / mpu, 1 / mpu, 1 / mpu));
  }
  const toScene = (v, m) => new THREE.Vector3(...v).applyMatrix4(m);
  const dirToScene = (v, m) => new THREE.Vector3(...v).transformDirection(m);
  const arr = v => [v.x, v.y, v.z];

  // ---- elementi: per IFC l'elemento (gruppo con expressID), altrimenti le parti visibili della scena
  let cache = null;
  function index() {
    if (cache) return cache;
    const units = [], byGuid = new Map(), guidOf = new Map();
    if (isIfc()) {
      const ifc = h.info.ifc;
      h.model.traverse(o => {
        const id = o.userData.expressID, mid = o.userData.modelID;
        if (id === undefined || mid === undefined || o.parent?.userData.expressID === id) return;
        let g = null;
        try { g = ifc.GetGuidFromExpressId(mid, id); } catch { /* */ }
        if (!g) { try { g = ifc.GetLine(mid, id, false)?.GlobalId?.value; } catch { /* */ } }
        units.push(o);
        if (g) { guidOf.set(o, g); if (!byGuid.has(g)) byGuid.set(g, []); byGuid.get(g).push(o); }
      });
    }
    cache = { units, byGuid, guidOf, aggr: null };
    return cache;
  }
  // elementi composti (facciate continue, scale, travi reticolari...): il GUID del padre vale per tutte le sue parti
  function partsOf(guid) {
    const c = index();
    if (c.byGuid.has(guid)) return c.byGuid.get(guid);
    if (!isIfc()) return [];
    const { ifc, WEBIFC: W } = h.info;
    const out = [];
    for (const mid of h.info.modelIDs) {
      let id;
      try { id = ifc.GetExpressIdFromGuid(mid, guid); } catch { /* */ }
      if (id === undefined) {
        // il GUID di un elemento non "IfcElement" (es. struttura spaziale) non e' nella mappa di web-ifc: si cerca a mano una volta
        if (!c.allGuids) {
          c.allGuids = new Map();
          for (const m of h.info.modelIDs) {
            try { const ids = ifc.GetLineIDsWithType(m, W.IFCOBJECTDEFINITION, true); for (let k = 0; k < ids.size(); k++) { const x = ids.get(k); try { const g = ifc.GetLine(m, x, false).GlobalId?.value; if (g) c.allGuids.set(g, [m, x]); } catch { /* */ } } } catch { /* */ }
          }
        }
        const hit = c.allGuids.get(guid);
        if (hit && hit[0] === mid) id = hit[1];
      }
      if (id === undefined) continue;
      if (!c.aggr) c.aggr = new Map();
      if (!c.aggr.has(mid)) {
        const map = new Map();
        try {
          const rels = ifc.GetLineIDsWithType(mid, W.IFCRELAGGREGATES);
          for (let k = 0; k < rels.size(); k++) {
            const r = ifc.GetLine(mid, rels.get(k), false);
            const p = r.RelatingObject?.value;
            map.set(p, [...(map.get(p) || []), ...(r.RelatedObjects || []).map(x => x.value)]);
          }
          const nest = ifc.GetLineIDsWithType(mid, W.IFCRELNESTS);
          for (let k = 0; k < nest.size(); k++) {
            const r = ifc.GetLine(mid, nest.get(k), false);
            const p = r.RelatingObject?.value;
            map.set(p, [...(map.get(p) || []), ...(r.RelatedObjects || []).map(x => x.value)]);
          }
        } catch { /* */ }
        c.aggr.set(mid, map);
      }
      const map = c.aggr.get(mid);
      const byId = new Map(c.units.filter(u => u.userData.modelID === mid).map(u => [u.userData.expressID, u]));
      const stack = [id], seen = new Set();
      while (stack.length) {
        const x = stack.pop();
        if (seen.has(x)) continue;
        seen.add(x);
        if (byId.has(x)) out.push(byId.get(x));
        for (const ch of map.get(x) || []) stack.push(ch);
      }
    }
    c.byGuid.set(guid, out);
    return out;
  }
  // parti dei modelli non IFC: percorso di indici dalla radice del modello
  const pathOf = o => { const p = []; for (let x = o; x && x !== h.model; x = x.parent) p.unshift(x.parent ? x.parent.children.indexOf(x) : 0); return p.join("/"); };
  const byPath = s => { let o = h.model; for (const i of String(s).split("/").map(Number)) { o = o?.children[i]; if (!o) return null; } return o; };
  const leaves = () => { const l = []; h.model.traverse(o => { if ((o.isMesh || o.isPoints || o.isLine) && !o.userData.merged && !o.userData.proxy) l.push(o); }); return l; };

  // elemento visibile: catena dei genitori accesa e (se ha mesh proprie) almeno una mesh accesa ("Isola" spegne le mesh, non i gruppi);
  // negli IFC uniti per colore le mesh dell'elemento sono copie sempre spente: conta solo la catena
  function shown(u) {
    if (!h.isVisibleChain(u)) return false;
    let own = 0, on = 0;
    u.traverse(m => { if ((m.isMesh || m.isPoints || m.isLine) && !m.userData.proxy) { own++; if (h.isVisibleChain(m)) on++; } });
    return !own || on > 0;
  }
  function setVisibility(vis) {
    const ex = objsFor(vis.exceptions);
    if (vis.default === false && !ex.length) { h.showAll(); return ex; } // GUID tutti sconosciuti (altro modello): meglio tutto che una scena vuota
    h.model.traverse(o => { if (!o.userData.proxy) o.visible = true; });
    const exSet = new Set(ex);
    if (isIfc()) {
      for (const u of index().units) u.visible = vis.default === false ? exSet.has(u) : !exSet.has(u);
    } else if (vis.default === false) {
      leaves().forEach(l => (l.visible = false));
      for (const o of ex) { o.traverse(x => (x.visible = true)); for (let p = o.parent; p; p = p.parent) p.visible = true; }
    } else ex.forEach(o => (o.visible = false));
    h.visibilityChanged();
    return ex;
  }

  function compsFor(objs) {
    const c = index(), out = [], seen = new Set();
    for (const o of objs) {
      let u = o;
      while (u && u !== h.model && !c.guidOf.has(u)) u = u.parent;
      if (u && c.guidOf.has(u)) { const g = c.guidOf.get(u); if (!seen.has(g)) { seen.add(g); out.push({ ifcGuid: g, system: ORIGIN, toolId: "" }); } }
      else if (!isIfc() || o.userData.expressID === undefined) out.push({ ifcGuid: "", system: ORIGIN, toolId: pathOf(o) });
    }
    return out;
  }
  function objsFor(comps) {
    const out = [];
    for (const c of comps || []) {
      if (c.ifcGuid) out.push(...partsOf(c.ifcGuid));
      else if (c.toolId && /^[\d/]+$/.test(c.toolId) && (!c.system || c.system === ORIGIN)) { const o = byPath(c.toolId); if (o) out.push(o); }
    }
    return [...new Set(out)];
  }

  // ---- salvataggio del punto di vista attuale
  function capture() {
    const { camera, controls } = h;
    const S = w2s().invert();
    const dirS = controls.target.clone().sub(camera.position).normalize();
    const upS = camera.up.clone().sub(dirS.clone().multiplyScalar(camera.up.dot(dirS))).normalize();
    const vi = {
      camera: { kind: "persp", pos: arr(camera.position.clone().applyMatrix4(S)), dir: arr(dirS.clone().transformDirection(S)), up: arr(upS.transformDirection(S)), fov: camera.fov, aspect: camera.aspect },
      selection: compsFor(h.selection), visibility: { default: true, exceptions: [] }, hints: { spaces: false, spaceBoundaries: false, openings: false },
      coloring: [], lines: [], planes: [],
    };
    // visibilita': si salva la lista piu' corta (nascosti con "tutto visibile", oppure visibili con "tutto nascosto")
    const units = isIfc() ? index().units : leaves();
    const vis = [], hid = [];
    for (const u of units) (shown(u) ? vis : hid).push(u);
    if (hid.length) {
      if (vis.length && vis.length < hid.length) vi.visibility = { default: false, exceptions: compsFor(vis) };
      else vi.visibility = { default: true, exceptions: compsFor(hid) };
    }
    // colori dati con "Colore della selezione" non si salvano; i colori ripristinati da un BCF si', per non perderli
    for (const [color, objs] of colored.groups) vi.coloring.push({ color, comps: compsFor(objs) });
    for (const p of h.renderer.clippingPlanes || []) {
      const loc = p.coplanarPoint(new THREE.Vector3()).applyMatrix4(S);
      vi.planes.push({ loc: arr(loc), dir: arr(p.normal.clone().negate().transformDirection(S)) }); // BCF: la direzione punta verso la parte tagliata
    }
    for (const l of lineData) vi.lines.push(l);
    return vi;
  }

  // ---- ripristino
  const colored = { mats: new Map(), groups: new Map() };
  let lineData = [];
  const lineGroup = new THREE.Group();
  lineGroup.renderOrder = 20;
  h.scene.add(lineGroup);
  function clearColors() {
    if (!colored.mats.size) return;
    const sel = h.selection;
    h.select([], { scroll: false });
    for (const [m, mat] of colored.mats) m.material = mat;
    colored.mats.clear();
    colored.groups.clear();
    if (sel.length) h.select(sel, { scroll: false });
  }
  function hexColor(s) {
    const x = String(s || "").replace(/^#/, "");
    const rgb = x.length >= 8 ? x.slice(2, 8) : x.slice(0, 6);
    const a = x.length >= 8 ? parseInt(x.slice(0, 2), 16) / 255 : 1;
    return { c: new THREE.Color("#" + (rgb.padEnd(6, "0"))), a };
  }
  function clearOverlay() {
    clearColors();
    lineGroup.clear();
    lineData = [];
  }

  async function apply(vi) {
    if (!vi) return;
    const { camera, controls } = h;
    const M = w2s();
    h.select([], { scroll: false });
    clearOverlay();
    // visibilita'
    const vis = vi.visibility || { default: true, exceptions: [] };
    const ex = setVisibility(vis);
    // colori (sui modelli uniti per colore le copie degli elementi restano invisibili: si colora solo cio' che ha mesh proprie)
    for (const col of vi.coloring || []) {
      const { c, a } = hexColor(col.color);
      const objs = objsFor(col.comps);
      colored.groups.set(col.color, objs);
      for (const o of objs) o.traverse(m => {
        if (!m.isMesh || m.userData.proxy || colored.mats.has(m)) return;
        colored.mats.set(m, m.material);
        const mk = () => new THREE.MeshStandardMaterial({ color: c, opacity: a, transparent: a < 0.999, metalness: 0.05, roughness: 0.6, side: THREE.DoubleSide });
        m.material = Array.isArray(m.material) ? m.material.map(mk) : mk();
      });
    }
    // sezioni
    h.setClip((vi.planes || []).filter(p => p.loc && p.dir).map(p => {
      const loc = toScene(p.loc, M), n = dirToScene(p.dir, M).negate();
      return new THREE.Plane().setFromNormalAndCoplanarPoint(n, loc);
    }));
    // linee di riferimento
    lineData = (vi.lines || []).filter(l => l.a && l.b);
    if (lineData.length) {
      const pts = lineData.flatMap(l => [toScene(l.a, M), toScene(l.b, M)]);
      const ls = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xe5322d, depthTest: false }));
      ls.renderOrder = 20;
      lineGroup.add(ls);
    }
    // camera: il punto di mira si mette sul modello lungo la direzione di vista (rotazione attorno a cio' che si guarda)
    const sel = objsFor(vi.selection);
    const cam = vi.camera;
    if (cam?.pos && cam?.dir) {
      const pos = toScene(cam.pos, M), dir = dirToScene(cam.dir, M);
      const box = new THREE.Box3().setFromObject(h.model);
      const size = box.getSize(new THREE.Vector3()).length() || 1;
      let dist = null;
      const ray = new THREE.Raycaster(pos, dir);
      const hit = ray.intersectObject(h.model, true).find(x => x.object.visible && h.isVisibleChain(x.object) && x.distance > 1e-6);
      if (hit) dist = hit.distance;
      if (!dist) { const c = box.getCenter(new THREE.Vector3()); dist = Math.max(c.clone().sub(pos).dot(dir), size * 0.05); }
      if (cam.kind === "persp") {
        camera.fov = Math.min(120, Math.max(10, cam.fov || 60));
        camera.position.copy(pos);
      } else {
        // camera ortogonale: stessa altezza inquadrata (ViewToWorldScale) vista in prospettiva dal punto adatto
        const target = pos.clone().add(dir.clone().multiplyScalar(dist));
        const hScene = (cam.scale || 1) * (Math.cbrt(Math.abs(M.determinant())) || 1); // altezza inquadrata, da metri a unita' della scena
        const D = (hScene / 2) / Math.tan((camera.fov * Math.PI) / 360);
        camera.position.copy(target.clone().sub(dir.clone().multiplyScalar(D)));
        dist = D;
      }
      camera.near = Math.max(size / 5000, 1e-4);
      camera.far = size * 200 + dist * 4;
      camera.up.set(0, 1, 0);
      controls.target.copy(camera.position.clone().add(dir.clone().multiplyScalar(dist)));
      camera.updateProjectionMatrix();
      camera.lookAt(controls.target);
      controls.update();
    } else if (sel.length) h.zoomTo(sel);
    if (sel.length) h.select(sel, { scroll: true });
    h.render();
    return { found: sel.length + ex.length, wanted: (vi.selection?.length || 0) + (vis.exceptions?.length || 0) };
  }

  // istantanea della vista 3D (PNG, lato lungo al massimo 1500 px come consiglia la specifica)
  async function snapshot() {
    h.render();
    const src = h.renderer.domElement;
    let cv = src;
    const k = Math.min(1, 1500 / Math.max(src.width, src.height));
    if (k < 1) {
      cv = document.createElement("canvas");
      cv.width = Math.round(src.width * k);
      cv.height = Math.round(src.height * k);
      cv.getContext("2d").drawImage(src, 0, 0, cv.width, cv.height);
    }
    return new Promise(r => cv.toBlob(r, "image/png"));
  }

  // file del modello per l'intestazione del markup (nome e GUID del progetto IFC)
  function modelFiles() {
    const files = [];
    const names = h.partNames?.() || [h.ctx.name];
    if (isIfc()) {
      const { ifc, WEBIFC: W } = h.info;
      h.info.modelIDs.forEach((mid, i) => {
        let pg = "";
        try { const ids = ifc.GetLineIDsWithType(mid, W.IFCPROJECT); if (ids.size()) pg = ifc.GetLine(mid, ids.get(0), false).GlobalId?.value || ""; } catch { /* */ }
        files.push({ ifcProject: pg, ifcSpatial: "", isExternal: true, filename: names[i] || h.ctx.name, date: "", reference: "" });
      });
    } else files.push({ ifcProject: "", ifcSpatial: "", isExternal: true, filename: h.ctx.name, date: "", reference: "" });
    return files;
  }

  // colore di sostituzione dato a mano (viste salvate, ui/js/navmanage.js): finisce nel punto di vista come i colori BCF
  function colorize(objs, hex) {
    const { c, a } = hexColor(hex);
    colored.groups.set(hex, [...new Set([...(colored.groups.get(hex) || []), ...objs])]);
    for (const o of objs) o.traverse(m => {
      if (!m.isMesh || m.userData.proxy) return;
      if (!colored.mats.has(m)) colored.mats.set(m, m.material);
      const mk = () => new THREE.MeshStandardMaterial({ color: c, opacity: a, transparent: a < 0.999, metalness: 0.05, roughness: 0.6, side: THREE.DoubleSide });
      m.material = Array.isArray(m.material) ? m.material.map(mk) : mk();
    });
  }

  return { capture, apply, snapshot, clearOverlay, colorize, modelFiles, objsFor, compsFor, isIfc, w2s, reset() { cache = null; } };
}
