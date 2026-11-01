// Vista 3D del modellatore: three.js con Z in alto e millimetri. Corpi con facce, spigoli e vertici numerati come nel
// motore; scelta (faccia, spigolo, vertice, corpo, regione di uno schizzo) e aggancio (vertice, punto medio, centro,
// spigolo, faccia) calcolati sullo schermo; evidenziazioni e disegni 2D (schizzi, quote, anteprime, misure) su una tela
// sopra la vista. Il puntatore resta sempre la freccia.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { isDark } from "../monaco.js";
import { inRegion } from "./mregions.js";

const DEF_COLOR = "#b8bcc0";
export const ACCENT = "#f07d2e";

export class View {
  constructor(host) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(devicePixelRatio || 1);
    this.renderer.localClippingEnabled = true;
    this.canvas = this.renderer.domElement;
    this.canvas.style.display = "block";
    this.overlay = document.createElement("canvas");
    this.overlay.className = "md-overlay";
    host.append(this.canvas, this.overlay);
    this.scene = new THREE.Scene();
    this.persp = new THREE.PerspectiveCamera(35, 1, 0.1, 1e7);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e7, 1e7);
    for (const c of [this.persp, this.ortho]) { c.up.set(0, 0, 1); c.position.set(300, -400, 260); }
    this.camera = this.persp;
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.14;
    this.controls.screenSpacePanning = true;
    this.controls.mouseButtons = { LEFT: -1, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
    this.controls.zoomToCursor = true;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x50555a, 1.7));
    this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    this.scene.add(this.sun);
    this.fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
    this.scene.add(this.fillLight);
    this.bodiesGroup = new THREE.Group();
    this.sketchGroup = new THREE.Group();
    this.helpers = new THREE.Group();
    this.scene.add(this.bodiesGroup, this.sketchGroup, this.helpers);
    this.bodies = new Map(); // id -> { id, uid, data, mesh, edges, color, ... }
    this.cache = new Map(); // uid -> geometria three (riusata se il corpo non cambia)
    this.sketches = []; // schizzi visibili (regioni selezionabili)
    this.overlays = new Set(); // funzioni (g, view) che disegnano sulla tela 2D
    this.hover = null;
    this.selection = [];
    this.wire = false;
    this.dirty = true;
    this.running = true;
    this.makeGrid();
    this.setBg();
    this.onTheme = () => { this.setBg(); this.dirty = true; };
    window.addEventListener("mbv-theme", this.onTheme);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.controls.addEventListener("change", () => { this.dirty = true; this.proj = null; });
    const loop = () => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      if (this.hidden?.()) return;
      if (this.controls.update()) { this.dirty = true; this.proj = null; }
      if (this.dirty) this.draw();
    };
    loop();
  }

  setBg() { this.scene.background = new THREE.Color(isDark() ? 0x232527 : 0xeef0ed); this.gridMat?.color.set(isDark() ? 0x3a3d40 : 0xc9cdd0); }

  dispose() {
    this.running = false;
    this.ro.disconnect();
    window.removeEventListener("mbv-theme", this.onTheme);
    this.controls.dispose();
    for (const g of this.cache.values()) { g.geom.dispose(); g.egeom.dispose(); }
    this.renderer.dispose();
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.w = r.width; this.h = r.height;
    this.renderer.setSize(r.width, r.height, false);
    this.canvas.style.width = r.width + "px";
    this.canvas.style.height = r.height + "px";
    const dpr = devicePixelRatio || 1;
    this.overlay.width = Math.round(r.width * dpr);
    this.overlay.height = Math.round(r.height * dpr);
    this.overlay.style.width = r.width + "px";
    this.overlay.style.height = r.height + "px";
    this.persp.aspect = r.width / r.height;
    this.persp.updateProjectionMatrix();
    this.updateOrtho();
    this.dirty = true;
    this.proj = null;
  }

  updateOrtho() {
    const d = this.persp.position.distanceTo(this.controls.target);
    const h = d * Math.tan(this.persp.fov * Math.PI / 360);
    const a = (this.w || 1) / (this.h || 1);
    Object.assign(this.ortho, { left: -h * a, right: h * a, top: h, bottom: -h });
    this.ortho.updateProjectionMatrix();
  }

  setOrtho(on) {
    const from = this.camera, to = on ? this.ortho : this.persp;
    if (from === to) return;
    if (on) { this.persp.position.copy(from.position); this.updateOrtho(); this.ortho.zoom = 1; }
    else {
      // stessa inquadratura: distanza dalla zoom dell'ortogonale
      const dir = from.position.clone().sub(this.controls.target).normalize();
      const d = this.persp.position.distanceTo(this.controls.target) / (from.zoom || 1);
      this.persp.position.copy(this.controls.target).addScaledVector(dir, d);
    }
    to.position.copy(on ? from.position : to.position);
    to.quaternion.copy(from.quaternion);
    to.up.copy(from.up);
    to.updateProjectionMatrix();
    this.camera = to;
    this.controls.object = to;
    this.controls.update();
    this.dirty = true;
    this.proj = null;
  }

  makeGrid() {
    this.gridMat = new THREE.LineBasicMaterial({ color: 0xc9cdd0, transparent: true, opacity: 0.8, depthWrite: false });
    this.grid = new THREE.LineSegments(new THREE.BufferGeometry(), this.gridMat);
    this.grid.renderOrder = -1;
    this.axes = new THREE.Group();
    const ax = (d, c) => { const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(...d)]); return new THREE.Line(g, new THREE.LineBasicMaterial({ color: c, depthWrite: false, transparent: true, opacity: 0.85 })); };
    this.axes.add(ax([1, 0, 0], 0xd9534f), ax([0, 1, 0], 0x4caf50), ax([0, 0, 1], 0x3d7fd9));
    this.helpers.add(this.grid, this.axes);
    this.setGrid(200);
  }

  // griglia sul piano XY (o sul piano dello schizzo), passo adatto alla dimensione
  setGrid(size, plane = null) {
    const step = Math.pow(10, Math.floor(Math.log10(Math.max(size, 1) / 10)));
    const half = Math.ceil(size / step) * step;
    const pts = [];
    for (let v = -half; v <= half + 1e-9; v += step) pts.push(-half, v, 0, half, v, 0, v, -half, 0, v, half, 0);
    this.grid.geometry.dispose();
    this.grid.geometry = new THREE.BufferGeometry();
    this.grid.geometry.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    this.grid.matrixAutoUpdate = false;
    this.grid.matrix.identity();
    if (plane) {
      const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...plane.x), new THREE.Vector3(...plane.y), new THREE.Vector3(...plane.n));
      m.setPosition(...plane.o);
      this.grid.matrix.copy(m);
    }
    this.grid.matrixWorldNeedsUpdate = true;
    for (const a of this.axes.children) a.scale.setScalar(half * 0.25);
    this.gridStep = step;
    this.dirty = true;
  }

  // ---------------------------------------------------------------------------------------------- corpi
  setBodies(list) {
    const keep = new Set();
    this.bodiesGroup.clear();
    this.bodies.clear();
    for (const b of list) {
      let g = this.cache.get(b.uid);
      if (!g && b.mesh) g = this.cache.get(b.uid) || this.buildGeom(b);
      if (!g) continue;
      keep.add(b.uid);
      if (b.hidden) continue;
      const color = b.color || DEF_COLOR;
      const mat = new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.6, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, wireframe: this.wire, transparent: b.ghost, opacity: b.ghost ? 0.25 : 1, depthWrite: !b.ghost });
      const mesh = new THREE.Mesh(g.geom, mat);
      mesh.userData.body = b.id;
      const edges = new THREE.LineSegments(g.egeom, new THREE.LineBasicMaterial({ color: isDark() ? 0x0e1012 : 0x2a2e33, transparent: true, opacity: b.ghost ? 0.3 : 0.9 }));
      edges.raycast = () => {};
      this.bodiesGroup.add(mesh, edges);
      this.bodies.set(b.id, { ...b, data: g.data, mesh, edgesObj: edges, g });
    }
    for (const [uid, g] of this.cache) if (!keep.has(uid)) { g.geom.dispose(); g.egeom.dispose(); this.cache.delete(uid); }
    this.proj = null;
    this.dirty = true;
  }

  buildGeom(b) {
    const m = b.mesh;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(m.pos, 3));
    geom.setAttribute("normal", new THREE.BufferAttribute(m.nrm, 3));
    geom.setIndex(new THREE.BufferAttribute(m.idx, 1));
    geom.computeBoundingSphere();
    geom.computeBoundingBox();
    // spigoli: tratti consecutivi di ogni polilinea
    const segs = [];
    for (let k = 0; k < m.er.length; k += 2) {
      const s = m.er[k], n = m.er[k + 1];
      for (let i = s; i + 1 < s + n; i++) segs.push(m.ep[i * 3], m.ep[i * 3 + 1], m.ep[i * 3 + 2], m.ep[i * 3 + 3], m.ep[i * 3 + 4], m.ep[i * 3 + 5]);
    }
    const egeom = new THREE.BufferGeometry();
    egeom.setAttribute("position", new THREE.Float32BufferAttribute(segs, 3));
    // triangolo -> faccia (ricerca binaria sugli intervalli)
    const fstart = [];
    for (let k = 0; k < m.fr.length; k += 2) fstart.push(m.fr[k]);
    const data = { faces: b.faces, edges: b.edges, bbox: b.bbox, props: b.props, mesh: m, fstart, kind: b.kind };
    const g = { geom, egeom, data };
    this.cache.set(b.uid, g);
    return g;
  }

  faceOfTri(data, tri) {
    const fs = data.fstart, fr = data.mesh.fr;
    let lo = 0, hi = fs.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fs[mid] <= tri) lo = mid; else hi = mid - 1; }
    // facce senza triangoli hanno lo stesso inizio: si prende quella che contiene davvero il triangolo
    while (lo < fs.length && !(tri >= fr[lo * 2] && tri < fr[lo * 2] + fr[lo * 2 + 1])) lo++;
    return lo;
  }

  bbox() {
    const b = new THREE.Box3();
    for (const v of this.bodies.values()) if (v.data.bbox) { b.expandByPoint(new THREE.Vector3(...v.data.bbox.slice(0, 3))); b.expandByPoint(new THREE.Vector3(...v.data.bbox.slice(3))); }
    for (const s of this.sketches) for (const p of s.bounds || []) b.expandByPoint(new THREE.Vector3(...p));
    return b;
  }

  fit(dir = null, box = null) {
    const b = box || this.bbox();
    if (b.isEmpty()) { b.set(new THREE.Vector3(-100, -100, 0), new THREE.Vector3(100, 100, 50)); }
    const c = b.getCenter(new THREE.Vector3()), size = b.getSize(new THREE.Vector3()).length() || 100;
    const d = dir ? new THREE.Vector3(...dir).normalize() : this.persp.position.clone().sub(this.controls.target).normalize();
    if (!isFinite(d.x) || d.lengthSq() < 0.5) d.set(0.6, -0.8, 0.55).normalize();
    const dist = size / (2 * Math.tan(this.persp.fov * Math.PI / 360)) * 1.1;
    this.controls.target.copy(c);
    this.persp.position.copy(c).addScaledVector(d, dist);
    this.persp.near = size / 1000;
    this.persp.far = size * 1000;
    this.persp.updateProjectionMatrix();
    if (this.camera === this.ortho) { this.ortho.position.copy(this.persp.position); this.ortho.zoom = 1; this.updateOrtho(); }
    if (Math.abs(d.z) > 0.999) this.camera.up.set(0, 1, 0); else this.camera.up.set(0, 0, 1);
    this.camera.lookAt(c);
    this.sun.position.copy(c).add(new THREE.Vector3(size, -size * 0.8, size * 1.6));
    this.fillLight.position.copy(c).add(new THREE.Vector3(-size, size, size * 0.3));
    this.setGrid(Math.max(size, 50));
    this.controls.update();
    this.dirty = true;
    this.proj = null;
  }

  // vista perpendicolare a un piano (schizzo), con l'asse y del piano in alto sullo schermo
  lookAtPlane(pl, size = null) {
    const t = this.controls.target.clone();
    const o = new THREE.Vector3(...pl.o), n = new THREE.Vector3(...pl.n);
    const onPlane = t.clone().sub(n.clone().multiplyScalar(t.clone().sub(o).dot(n)));
    const dist = size ? size / (2 * Math.tan(this.persp.fov * Math.PI / 360)) * 1.2 : this.camera.position.distanceTo(t);
    this.controls.target.copy(onPlane);
    this.camera.up.set(...pl.y);
    this.camera.position.copy(onPlane).addScaledVector(n, dist);
    if (this.camera === this.persp) this.persp.position.copy(this.camera.position);
    this.camera.lookAt(onPlane);
    this.controls.update();
    this.dirty = true;
    this.proj = null;
  }

  // ---------------------------------------------------------------------------------------------- coordinate
  toScreen(p) {
    const v = (p.isVector3 ? p.clone() : new THREE.Vector3(...p)).project(this.camera);
    return [(v.x + 1) / 2 * this.w, (1 - v.y) / 2 * this.h, v.z];
  }
  ndc(ev) {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  }
  local(ev) { const r = this.canvas.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; }
  ray(ev) { const rc = new THREE.Raycaster(); rc.setFromCamera(this.ndc(ev), this.camera); return rc; }
  // punto del mouse su un piano {o, n}
  onPlane(ev, pl) {
    const rc = this.ray(ev);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...pl.n), new THREE.Vector3(...pl.o));
    const p = new THREE.Vector3();
    return rc.ray.intersectPlane(plane, p) ? p : null;
  }
  // dimensione in mm di un pixel vicino al punto p
  pxSize(p) {
    const a = this.toScreen(p);
    const cam = this.camera;
    const dir = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const b = this.toScreen((p.isVector3 ? p : new THREE.Vector3(...p)).clone().add(dir));
    return 1 / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1);
  }

  // proiezione sullo schermo di spigoli e vertici (rifatta solo quando la vista cambia)
  projected() {
    if (this.proj) return this.proj;
    this.camera.updateMatrixWorld();
    const M = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).elements;
    const camPos = this.camera.position;
    const ortho = this.camera === this.ortho;
    const fwd = new THREE.Vector3(); this.camera.getWorldDirection(fwd);
    const W = this.w, H = this.h;
    const pr = (arr) => {
      const n = arr.length / 3, out = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2];
        const w = M[3] * x + M[7] * y + M[11] * z + M[15];
        out[i * 3] = ((M[0] * x + M[4] * y + M[8] * z + M[12]) / w + 1) / 2 * W;
        out[i * 3 + 1] = (1 - (M[1] * x + M[5] * y + M[9] * z + M[13]) / w) / 2 * H;
        out[i * 3 + 2] = ortho ? (x - camPos.x) * fwd.x + (y - camPos.y) * fwd.y + (z - camPos.z) * fwd.z : Math.hypot(x - camPos.x, y - camPos.y, z - camPos.z);
      }
      return out;
    };
    const res = new Map();
    for (const [id, b] of this.bodies) res.set(id, { ep: pr(b.data.mesh.ep), vp: pr(b.data.mesh.vp) });
    this.proj = res;
    return res;
  }

  // distanza dalla camera di un punto (stessa misura di projected)
  depthOf(p) {
    if (this.camera === this.ortho) { const f = new THREE.Vector3(); this.camera.getWorldDirection(f); return p.clone().sub(this.camera.position).dot(f); }
    return p.distanceTo(this.camera.position);
  }

  // faccia colpita dal raggio (la prima visibile)
  hitFace(ev, only = null) {
    const rc = this.ray(ev);
    const objs = [...this.bodies.values()].filter(b => !only || only.has(b.id)).map(b => b.mesh);
    const hits = rc.intersectObjects(objs, false).filter(h => !this.clippedOut(h.point));
    if (!hits.length) return null;
    const h = hits[0];
    const b = this.bodies.get(h.object.userData.body);
    const fi = this.faceOfTri(b.data, h.faceIndex);
    return { kind: "face", body: b.id, index: fi, info: b.data.faces[fi], point: h.point, dist: h.distance, depth: this.depthOf(h.point) };
  }

  clippedOut(p) { return (this.renderer.clippingPlanes || []).some(pl => pl.distanceToPoint(p) < 0); }

  // spigolo o vertice entro tol pixel, non coperto da una faccia piu' vicina
  hitEdgeVertex(ev, { edges = true, verts = true, tol = 7 } = {}) {
    const [mx, my] = this.local(ev);
    const face = this.hitFace(ev);
    const lim = face ? face.depth * 1.004 + 1e-6 : Infinity;
    const P = this.projected();
    let best = null;
    for (const [id, b] of this.bodies) {
      const pp = P.get(id);
      if (!pp) continue;
      if (verts) {
        const vp = pp.vp;
        for (let i = 0; i < vp.length / 3; i++) {
          const d = Math.hypot(vp[i * 3] - mx, vp[i * 3 + 1] - my);
          if (d <= tol + 2 && vp[i * 3 + 2] <= lim && (!best || d - 3 < best.d)) {
            const m = b.data.mesh.vp;
            best = { kind: "vertex", body: id, index: i, d: d - 3, point: new THREE.Vector3(m[i * 3], m[i * 3 + 1], m[i * 3 + 2]) };
          }
        }
      }
      if (!edges) continue;
      const er = b.data.mesh.er, ep = pp.ep;
      for (let k = 0; k < er.length / 2; k++) {
        const s = er[k * 2], n = er[k * 2 + 1];
        for (let i = s; i + 1 < s + n; i++) {
          const ax = ep[i * 3], ay = ep[i * 3 + 1], bx = ep[i * 3 + 3], by = ep[i * 3 + 4];
          const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
          let u = L ? ((mx - ax) * dx + (my - ay) * dy) / L : 0;
          u = Math.max(0, Math.min(1, u));
          const d = Math.hypot(ax + dx * u - mx, ay + dy * u - my);
          if (d > tol || (best && d >= best.d)) continue;
          // punto vero sullo spigolo (u sullo schermo -> parametro nello spazio, corretto per la prospettiva) e sua distanza
          const za = ep[i * 3 + 2], zb = ep[i * 3 + 5];
          const u3 = this.camera === this.ortho ? u : (u * za) / (u * za + (1 - u) * zb || 1);
          const m = b.data.mesh.ep;
          const pt = new THREE.Vector3(m[i * 3] + (m[i * 3 + 3] - m[i * 3]) * u3, m[i * 3 + 1] + (m[i * 3 + 4] - m[i * 3 + 1]) * u3, m[i * 3 + 2] + (m[i * 3 + 5] - m[i * 3 + 2]) * u3);
          if (this.depthOf(pt) > lim) continue;
          best = { kind: "edge", body: id, index: k, info: b.data.edges[k], d, point: pt };
        }
      }
    }
    return best;
  }

  // regione di uno schizzo visibile sotto il mouse
  hitRegion(ev) {
    let best = null;
    for (const s of this.sketches) {
      if (!s.regions?.length || !s.plane) continue;
      const p = this.onPlane(ev, s.plane);
      if (!p) continue;
      const rel = [p.x - s.plane.o[0], p.y - s.plane.o[1], p.z - s.plane.o[2]];
      const uv = [rel[0] * s.plane.x[0] + rel[1] * s.plane.x[1] + rel[2] * s.plane.x[2], rel[0] * s.plane.y[0] + rel[1] * s.plane.y[1] + rel[2] * s.plane.y[2]];
      const R = s.regions.filter(r => inRegion(uv, r)).sort((a, b) => a.area - b.area)[0];
      if (!R) continue;
      const depth = this.depthOf(p);
      if (!best || depth < best.depth) best = { kind: "region", sketch: s.id, region: R, point: p, uv, depth };
    }
    return best;
  }

  // scelta generale: cosa sta sotto il mouse secondo il filtro {faces, edges, verts, regions, bodies}
  pick(ev, f = { faces: true, edges: true, verts: false, regions: true }) {
    const ev2 = (f.edges || f.verts) ? this.hitEdgeVertex(ev, { edges: !!f.edges, verts: !!f.verts }) : null;
    if (ev2 && (ev2.kind === "vertex" || ev2.d <= 5)) return ev2;
    const face = (f.faces || f.bodies) ? this.hitFace(ev) : null;
    const reg = f.regions ? this.hitRegion(ev) : null;
    if (reg && (!face || reg.depth <= face.depth + Math.max(1e-6, face.depth * 0.003))) return reg;
    if (ev2) return ev2;
    if (face && f.bodies && !f.faces) return { kind: "body", body: face.body, point: face.point };
    return face;
  }

  // aggancio a un punto 3D: vertice > centro/punto medio > spigolo > faccia; tol in pixel
  snap(ev, { tol = 10, faces = true, extra = [] } = {}) {
    const [mx, my] = this.local(ev);
    const face = this.hitFace(ev);
    const lim = face ? face.depth * 1.004 + 1e-6 : Infinity;
    let best = null;
    const consider = (p, kind, pri, extraInfo) => {
      const s = this.toScreen(p);
      const d = Math.hypot(s[0] - mx, s[1] - my);
      if (d > tol) return;
      const v = p.isVector3 ? p : new THREE.Vector3(...p);
      if (this.depthOf(v) > lim) return;
      const score = d + pri * 4;
      if (!best || score < best.score) best = { p: v.clone(), kind, score, ...extraInfo };
    };
    const P = this.projected();
    for (const [id, b] of this.bodies) {
      const vp = P.get(id).vp, m = b.data.mesh.vp;
      for (let i = 0; i < vp.length / 3; i++) if (Math.hypot(vp[i * 3] - mx, vp[i * 3 + 1] - my) <= tol) consider(new THREE.Vector3(m[i * 3], m[i * 3 + 1], m[i * 3 + 2]), "vertex", 0, { body: id });
      for (const e of b.data.edges) {
        if (e.t === "circle") consider(e.o, "center", 0.5, { body: id });
        if (e.t === "line") consider(e.c, "mid", 1, { body: id });
      }
    }
    for (const x of extra) consider(x.p, x.kind || "point", x.pri ?? 0.2);
    if (best) return best;
    const e = this.hitEdgeVertex(ev, { edges: true, verts: false, tol: Math.min(tol, 7) });
    if (e) return { p: e.point, kind: "edge", body: e.body, edge: e };
    if (face && faces) return { p: face.point, kind: "face", body: face.body, face };
    return null;
  }

  // ---------------------------------------------------------------------------------------------- disegno
  draw() {
    this.dirty = false;
    if (this.camera === this.ortho) this.ortho.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    const g = this.overlay.getContext("2d");
    const dpr = devicePixelRatio || 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, this.w || 0, this.h || 0);
    this.drawHighlights(g);
    for (const fn of this.overlays) { try { fn(g, this); } catch (e) { console.error(e); } }
  }
  redraw() { this.dirty = true; }

  // facce e spigoli evidenziati: selezione (arancione pieno) e passaggio del mouse (tenue)
  drawHighlights(g) {
    const items = [...this.selection.map(s => [s, 1]), ...(this.hover ? [[this.hover, 0]] : [])];
    for (const [it, sel] of items) {
      const b = this.bodies.get(it.body);
      if (it.kind === "region") { this.drawRegion(g, it, sel); continue; }
      if (!b) continue;
      if (it.kind === "face") this.drawFace(g, b, it.index, sel);
      else if (it.kind === "edge") this.drawEdge(g, b, it.index, sel);
      else if (it.kind === "vertex") {
        const m = b.data.mesh.vp, s = this.toScreen([m[it.index * 3], m[it.index * 3 + 1], m[it.index * 3 + 2]]);
        g.fillStyle = ACCENT; g.beginPath(); g.arc(s[0], s[1], sel ? 5 : 4, 0, 7); g.fill();
      } else if (it.kind === "body") {
        for (let k = 0; k < b.data.edges.length; k++) this.drawEdge(g, b, k, sel, 2);
      }
    }
  }
  drawFace(g, b, fi, sel) {
    const m = b.data.mesh, s = m.fr[fi * 2], n = m.fr[fi * 2 + 1];
    if (!n) return;
    const pos = m.pos, idx = m.idx;
    g.fillStyle = sel ? "rgba(240,125,46,.45)" : "rgba(240,125,46,.22)";
    g.beginPath();
    const lim = Math.min(n, 60000);
    for (let t = s; t < s + lim; t++) {
      for (let k = 0; k < 3; k++) {
        const v = idx[t * 3 + k];
        const p = this.toScreen([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]);
        if (k === 0) g.moveTo(p[0], p[1]); else g.lineTo(p[0], p[1]);
      }
      g.closePath();
    }
    g.fill();
  }
  drawEdge(g, b, k, sel, w = null) {
    const m = b.data.mesh, s = m.er[k * 2], n = m.er[k * 2 + 1];
    if (n < 2) return;
    g.strokeStyle = ACCENT;
    g.globalAlpha = sel ? 1 : 0.7;
    g.lineWidth = w || (sel ? 3 : 2.5);
    g.beginPath();
    for (let i = s; i < s + n; i++) {
      const p = this.toScreen([m.ep[i * 3], m.ep[i * 3 + 1], m.ep[i * 3 + 2]]);
      if (i === s) g.moveTo(p[0], p[1]); else g.lineTo(p[0], p[1]);
    }
    g.stroke();
    g.globalAlpha = 1;
  }
  drawRegion(g, it, sel) {
    const s = this.sketches.find(q => q.id === it.sketch);
    if (!s) return;
    const R = it.region;
    g.fillStyle = sel ? "rgba(240,125,46,.45)" : "rgba(240,125,46,.25)";
    g.beginPath();
    for (const poly of [R.poly, ...R.holePolys]) {
      poly.forEach((uv, i) => { const p = this.toScreen(uvTo3(s.plane, uv)); if (i) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); });
      g.closePath();
    }
    g.fill("evenodd");
  }

  // schizzi finiti mostrati nella scena: curve (linee three) + regioni tenui selezionabili
  setSketches(list) {
    this.sketchGroup.clear();
    this.sketches = list;
    for (const s of list) {
      if (!s.plane) continue;
      const pts = [], cpts = [];
      for (const poly of s.curves || []) for (let i = 0; i + 1 < poly.pts.length; i++) (poly.cons ? cpts : pts).push(...uvTo3(s.plane, poly.pts[i]), ...uvTo3(s.plane, poly.pts[i + 1]));
      const mk = (arr, color, dash) => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
        const ls = new THREE.LineSegments(geo, dash ? new THREE.LineDashedMaterial({ color, dashSize: 3, gapSize: 2, depthTest: false, transparent: true, opacity: 0.6 }) : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }));
        if (dash) ls.computeLineDistances();
        ls.renderOrder = 5;
        ls.raycast = () => {};
        return ls;
      };
      if (pts.length) this.sketchGroup.add(mk(pts, 0x2d6fd6));
      if (cpts.length) this.sketchGroup.add(mk(cpts, 0x7a8691, true));
      // regioni piene tenui
      for (const R of s.regions || []) {
        const shape = new THREE.Shape(R.poly.map(p => new THREE.Vector2(p[0], p[1])));
        shape.holes = R.holePolys.map(h => new THREE.Path(h.map(p => new THREE.Vector2(p[0], p[1]))));
        const geo = new THREE.ShapeGeometry(shape);
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x5a8fe0, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
        m.matrixAutoUpdate = false;
        m.matrix.copy(planeMatrix(s.plane));
        m.raycast = () => {};
        this.sketchGroup.add(m);
      }
    }
    this.dirty = true;
  }

  setWire(on) {
    this.wire = on;
    for (const b of this.bodies.values()) b.mesh.material.wireframe = on;
    this.dirty = true;
  }

  // immagine della vista (miniatura del .mbmod)
  snapshot(w = 320) {
    this.draw();
    const c = document.createElement("canvas");
    const s = this.canvas;
    c.width = w; c.height = Math.round(w * s.height / s.width);
    c.getContext("2d").drawImage(s, 0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  }
}

export function uvTo3(pl, uv) {
  return [pl.o[0] + pl.x[0] * uv[0] + pl.y[0] * uv[1], pl.o[1] + pl.x[1] * uv[0] + pl.y[1] * uv[1], pl.o[2] + pl.x[2] * uv[0] + pl.y[2] * uv[1]];
}
export function to2(pl, p) {
  const r = [p[0] - pl.o[0], p[1] - pl.o[1], p[2] - pl.o[2]];
  return [r[0] * pl.x[0] + r[1] * pl.x[1] + r[2] * pl.x[2], r[0] * pl.y[0] + r[1] * pl.y[1] + r[2] * pl.y[2]];
}
export function planeMatrix(pl) {
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...pl.x), new THREE.Vector3(...pl.y), new THREE.Vector3(...pl.n));
  m.setPosition(...pl.o);
  return m;
}
