// Nuvole di punti da rilievo (LAS, LAZ, E57, PTS, PTX, XYZ, PLY a soli punti) nel visualizzatore 3D.
// Il motore (mbvisual/pointcloud.py) legge il file a blocchi e lo riordina in un ottree con livelli di dettaglio salvato
// in cache: qui si caricano solo i nodi che servono alla vista attuale (entro un "budget" di punti), dal piu' grossolano
// al piu' fine, e si scaricano quelli non piu' visibili. Colori: RGB, intensita', quota (scala di colori), classificazione.
// Coordinate: asse Z verso l'alto come nel file; nella scena (Y in alto) la nuvola usa la stessa matrice di coordinamento
// dei modelli IFC (info.coordMatrix), cosi' nuvola e modello BIM nello stesso sistema di riferimento restano allineati.
import * as THREE from "three";
import { api, el, extOf, readBytes, waitJob, WEB } from "./core.js";
import { fmtNum, t } from "./i18n.js";

export const PC_EXTS = new Set(["las", "laz", "e57", "pts", "ptx", "xyz", "txt", "asc", "csv"]);

// classi ASPRS (LAS 1.4): colore (nome nelle traduzioni pc.cls_<n>)
const CLASSES = {
  0: [null, 0xa0a0a0], 1: [null, 0xc8c8c8], 2: [null, 0xa0703c], 3: [null, 0x9ad46a],
  4: [null, 0x4caf50], 5: [null, 0x1f7a2e], 6: [null, 0xe0603a], 7: [null, 0xff00ff],
  8: [null, 0xffd000], 9: [null, 0x2f7fe0], 10: [null, 0x7a5230], 11: [null, 0x606060],
  12: [null, 0xffe08a], 13: [null, 0xd0d0ff], 14: [null, 0xffff60], 15: [null, 0xb0b0ff],
  16: [null, 0x80ffff], 17: [null, 0x9c7ad8], 18: [null, 0xff40a0],
};
const className = c => (CLASSES[c] ? t("pc.cls_" + c) : t("pc.classe_n", c));
const RAMP = [[0, 0x2c3cc8], [0.25, 0x1fa6e0], [0.5, 0x3cc85a], [0.75, 0xf0dc32], [1, 0xe0322c]].map(([t, c]) => [t, (c >> 16) & 255, (c >> 8) & 255, c & 255]);
function ramp(t, out, o) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  let i = 1;
  while (i < RAMP.length - 1 && RAMP[i][0] < t) i++;
  const a = RAMP[i - 1], b = RAMP[i], u = (t - a[0]) / (b[0] - a[0] || 1);
  out[o] = a[1] + (b[1] - a[1]) * u; out[o + 1] = a[2] + (b[2] - a[2]) * u; out[o + 2] = a[3] + (b[3] - a[3]) * u;
}

// impostazioni comuni a tutte le nuvole della scheda
export function defaultSettings() {
  return { mode: "auto", size: 2, budget: 3_000_000, uniform: "#6aa7d8" };
}

const align4 = n => (n + 3) & ~3;

export class Cloud {
  constructor(meta, info, settings, name) {
    this.meta = meta;
    this.settings = settings;
    this.name = name;
    this.material = new THREE.PointsMaterial({ size: settings.size, sizeAttenuation: false, vertexColors: true, alphaTest: 0.5 });
    this.hidden = new Set(); // classi nascoste
    this.loaded = 0;          // punti in memoria
    this.active = 0;
    this.frame = 0;
    this.want = [];
    this.disposed = false;
    this.local = null;        // web app: dati gia' in memoria
    const off = meta.offset;
    // root: dal sistema del file (Z in alto) alla scena (Y in alto) + traslazione comune dei modelli federati
    this.root = new THREE.Group();
    this.root.name = name;
    this.root.matrixAutoUpdate = false;
    const bb = meta.bbox;
    if (!info.coordMatrix) {
      // primo modello della scena: la nuvola si porta vicino all'origine e la traslazione diventa quella comune
      const c = [off[0] + (bb[0] + bb[3]) / 2, off[1] + (bb[1] + bb[4]) / 2, off[2] + bb[2]];
      info.coordMatrix = new THREE.Matrix4().makeTranslation(-c[0], -c[2], c[1]).toArray();
      info.coordFromCloud = true;
    }
    const fed = new THREE.Matrix4().fromArray(info.coordMatrix);
    const rx = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    this.toScene = fed.clone().multiply(rx);            // coordinate del file -> scena
    this.root.matrix.copy(this.toScene).multiply(new THREE.Matrix4().makeTranslation(off[0], off[1], off[2]));
    // gruppo dei punti (voce dell'albero) e ingombro completo anche prima che i nodi fini siano caricati
    this.group = new THREE.Group();
    this.group.name = t("pc.nuvola");
    this.root.add(this.group);
    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.Float32BufferAttribute([bb[0], bb[1], bb[2], bb[3], bb[4], bb[5]], 3));
    const helper = new THREE.Points(bg, new THREE.PointsMaterial({ visible: false }));
    helper.raycast = () => {};
    helper.userData.pcHelper = true;
    this.group.add(helper);
    // nodi dell'ottree
    const cube = meta.cube;
    this.nodes = meta.nodes.map(([L, ix, iy, iz, start, count, ...box]) => {
      const size = cube[3] / 2 ** L;
      const b = box.length === 6 ? box : [cube[0] + ix * size, cube[1] + iy * size, cube[2] + iz * size, cube[0] + (ix + 1) * size, cube[1] + (iy + 1) * size, cube[2] + (iz + 1) * size];
      return { L, ix, iy, iz, start, count, size, spacing: size / 2 ** meta.S, box: new THREE.Box3(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5])), children: [], obj: null, used: 0 };
    });
    const byKey = new Map(this.nodes.map(n => [`${n.L}/${n.ix}/${n.iy}/${n.iz}`, n]));
    for (const n of this.nodes) if (n.L) byKey.get(`${n.L - 1}/${n.ix >> 1}/${n.iy >> 1}/${n.iz >> 1}`)?.children.push(n);
    this.top = this.nodes.filter(n => n.L === 0);
    this.zRange = [bb[2], bb[5]];
    this.wm = null;
  }

  // voce dell'albero: la nuvola e, se classificata, una riga per classe (la casella nasconde quella classe)
  tree() {
    const kids = [];
    for (const [c, k] of this.meta.classes || []) {
      const proxy = new THREE.Object3D();
      let vis = true;
      Object.defineProperty(proxy, "visible", { get: () => vis, set: v => { vis = v; if (v) this.hidden.delete(c); else this.hidden.add(c); this.recolor(); } });
      proxy.name = className(c);
      proxy.userData.pcClass = c;
      this.group.add(proxy);
      kids.push({ name: `${c} · ${className(c)} (${fmtNum(k)})`, obj: null, objs: [proxy], children: [] });
    }
    return [{ name: t("pc.nuvola_n", fmtNum(this.meta.n)), obj: this.group, children: kids }];
  }

  colorMode() {
    const m = this.settings.mode;
    if (m === "auto") return this.meta.rgb ? "rgb" : "z";
    if (m === "rgb" && !this.meta.rgb) return this.meta.i ? "int" : "z";
    if (m === "int" && !this.meta.i) return "z";
    if (m === "class" && !this.meta.c) return "z";
    return m;
  }

  colors(d) {
    const n = d.count, out = new Uint8Array(n * 4), mode = this.colorMode(), tmp = [0, 0, 0];
    const [z0, z1] = this.zRange, dz = z1 - z0 || 1;
    const uni = new THREE.Color(this.settings.uniform);
    const ur = uni.r * 255, ug = uni.g * 255, ub = uni.b * 255;
    const hid = this.hidden.size ? this.hidden : null;
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      if (mode === "rgb") { out[o] = d.rgb[i * 3]; out[o + 1] = d.rgb[i * 3 + 1]; out[o + 2] = d.rgb[i * 3 + 2]; }
      else if (mode === "int") { const g = Math.pow(d.int[i] / 65535, 0.75) * 255; out[o] = out[o + 1] = out[o + 2] = g; }
      else if (mode === "class") { const c = CLASSES[d.cls[i] & 31]?.[1] ?? 0xffffff; out[o] = c >> 16; out[o + 1] = (c >> 8) & 255; out[o + 2] = c & 255; }
      else if (mode === "z") { ramp((d.pos[i * 3 + 2] - z0) / dz, tmp, 0); out[o] = tmp[0]; out[o + 1] = tmp[1]; out[o + 2] = tmp[2]; }
      else { out[o] = ur; out[o + 1] = ug; out[o + 2] = ub; }
      out[o + 3] = hid && d.cls && hid.has(d.cls[i]) ? 0 : 255;
    }
    return out;
  }

  recolor() {
    for (const n of this.nodes) if (n.obj) {
      const a = n.obj.geometry.getAttribute("color");
      a.array.set(this.colors(n.obj.userData.pcData));
      a.needsUpdate = true;
    }
  }

  setSize(px) { this.material.size = px; this.material.needsUpdate = true; }

  async fetchNode(n) {
    if (this.local) return this.local;
    const r = await fetch(`/api/pc_data?key=${this.meta.key}&start=${n.start}&count=${n.count}`, { credentials: "same-origin" });
    if (!r.ok) throw new Error(t("pc.lettura_non_riuscita"));
    const buf = await r.arrayBuffer(), c = n.count;
    let o = 0;
    const take = (T, k) => { const a = new T(buf, o, c * k); o = align4(o + c * k * T.BYTES_PER_ELEMENT); return a; };
    const d = { count: c, pos: take(Float32Array, 3) };
    if (this.meta.rgb) d.rgb = take(Uint8Array, 3);
    if (this.meta.i) d.int = take(Uint16Array, 1);
    if (this.meta.c) d.cls = take(Uint8Array, 1);
    return d;
  }

  async load(n) {
    n.loading = true;
    this.active++;
    try {
      const d = await this.fetchNode(n);
      if (this.disposed) return;
      if (n.L === 0 && this.top.length === 1 && !this.zFixed) {
        // scala delle quote sui percentili del nodo radice: pochi punti anomali (uccelli, rumore) non la schiacciano
        const zs = new Float32Array(d.count);
        for (let i = 0; i < d.count; i++) zs[i] = d.pos[i * 3 + 2];
        zs.sort();
        const q = p => zs[Math.min(d.count - 1, Math.floor(p * d.count))];
        if (d.count > 100) this.zRange = [q(0.01), q(0.99)];
        this.zFixed = true;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(d.pos, 3));
      g.setAttribute("color", new THREE.BufferAttribute(this.colors(d), 4, true));
      g.boundingBox = n.box.clone();
      g.boundingSphere = n.box.getBoundingSphere(new THREE.Sphere());
      const p = new THREE.Points(g, this.material);
      p.name = t("pc.livello_n", n.L);
      p.userData.pcData = d;
      p.userData.pcNode = n;
      p.userData.pcCloud = this;
      p.matrixAutoUpdate = false;
      p.visible = false;
      // il raggio di three.js prova anche gli oggetti nascosti: qui solo i nodi mostrati (piu' veloce, niente punti fantasma)
      p.raycast = function (r, out) { if (this.visible) THREE.Points.prototype.raycast.call(this, r, out); };
      n.obj = p;
      n.used = this.frame;
      this.group.add(p);
      this.loaded += n.count;
      if (n.L === 0 && this.zFixed && this.colorMode() === "z") this.recolor();
    } catch (e) { console.warn("Nuvola: nodo non caricato", e); n.failed = (n.failed || 0) + 1; }
    finally { n.loading = false; this.active--; this.pump(); }
  }

  pump() {
    while (this.active < 4 && this.want.length) {
      const n = this.want.shift();
      if (!n.obj && !n.loading && (n.failed || 0) < 3) this.load(n);
    }
  }

  // a ogni fotogramma: nodi da mostrare per la vista attuale, dal piu' importante, entro il budget di punti
  update(camera, height, clipPlanes) {
    if (this.disposed) return 0;
    let o = this.group;
    while (o) { if (!o.visible) { for (const n of this.nodes) if (n.obj) n.obj.visible = false; return 0; } o = o.parent; }
    this.frame++;
    const mw = this.root.matrixWorld;
    if (!this.wm || !this.wm.equals(mw)) {
      this.wm = mw.clone();
      for (const n of this.nodes) { n.wbox = n.box.clone().applyMatrix4(mw); n.wcenter = n.wbox.getCenter(new THREE.Vector3()); n.wradius = n.wbox.getSize(new THREE.Vector3()).length() / 2; }
    }
    const frustum = this.frustum || (this.frustum = new THREE.Frustum());
    frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const k = height / 2 / Math.tan((camera.fov * Math.PI) / 360);
    const cam = camera.getWorldPosition(new THREE.Vector3());
    const limit = Math.max(0.5, this.settings.size * 0.4);
    const clipped = n => clipPlanes && clipPlanes.some(pl => {
      // nodo tutto dal lato tagliato del piano
      const b = n.wbox, nx = pl.normal.x, ny = pl.normal.y, nz = pl.normal.z;
      return nx * (nx > 0 ? b.max.x : b.min.x) + ny * (ny > 0 ? b.max.y : b.min.y) + nz * (nz > 0 ? b.max.z : b.min.z) + pl.constant < 0;
    });
    const shown = new Set(), queue = [];
    const consider = n => {
      if (!frustum.intersectsBox(n.wbox) || clipped(n)) return;
      const d = cam.distanceTo(n.wcenter);
      n.pri = d <= n.wradius ? Infinity : (n.wradius / d) * k;
      queue.push(n);
    };
    this.top.forEach(consider);
    let total = 0;
    while (queue.length) {
      let bi = 0;
      for (let i = 1; i < queue.length; i++) if (queue[i].pri > queue[bi].pri) bi = i;
      const n = queue[bi];
      queue[bi] = queue[queue.length - 1];
      queue.pop();
      if (total + n.count > this.settings.budget && total) continue;
      total += n.count;
      shown.add(n);
      // figli solo se i punti di questo nodo, sullo schermo, sono piu' radi della dimensione dei punti
      const d = Math.max(cam.distanceTo(n.wcenter) - n.wradius, 1e-9);
      if ((n.spacing * k) / d > limit) n.children.forEach(consider);
    }
    const missing = [];
    let drawn = 0;
    for (const n of this.nodes) {
      if (!n.obj) { if (shown.has(n) && !n.loading) missing.push(n); continue; }
      n.obj.visible = shown.has(n);
      if (n.obj.visible) { n.used = this.frame; drawn += n.count; }
    }
    missing.sort((a, b) => b.pri - a.pri);
    this.want = missing;
    this.pump();
    // memoria: si tolgono i nodi non visti da piu' tempo oltre 1,5 volte il budget
    if (this.loaded > this.settings.budget * 1.5) {
      const old = this.nodes.filter(n => n.obj && !n.obj.visible && n.L > 0).sort((a, b) => a.used - b.used);
      for (const n of old) {
        if (this.loaded <= this.settings.budget * 1.2) break;
        this.group.remove(n.obj);
        n.obj.geometry.dispose();
        n.obj = null;
        this.loaded -= n.count;
      }
    }
    this.drawn = drawn;
    return drawn;
  }

  // posizione di un punto (coordinate del file, Z in alto) e suoi attributi, per la scheda delle proprieta'
  pointInfo(obj, i) {
    const d = obj.userData.pcData, off = this.meta.offset, rows = [];
    const f = v => fmtNum(Number(v), 3);
    rows.push(["X", f(d.pos[i * 3] + off[0])], ["Y", f(d.pos[i * 3 + 1] + off[1])], [t("pc.z_quota"), f(d.pos[i * 3 + 2] + off[2])]);
    if (d.rgb) rows.push([t("common.colore"), `RGB ${d.rgb[i * 3]}, ${d.rgb[i * 3 + 1]}, ${d.rgb[i * 3 + 2]}`]);
    if (d.int && this.meta.i_range) { const [lo, hi] = this.meta.i_range; const v = lo + (d.int[i] / 65535) * (hi - lo); rows.push([t("pc.intensita"), fmtNum(hi - lo > 50 ? Math.round(v) : v)]); }
    if (d.cls) rows.push([t("pc.classe"), `${d.cls[i]} · ${className(d.cls[i])}`]);
    rows.push([t("pc.livello_dettaglio"), String(obj.userData.pcNode.L)]);
    return rows;
  }

  // piano della scena -> piano nelle coordinate del file [nx, ny, nz, d] (per salvare solo la parte sezionata)
  planeToFile(pl) {
    const p = pl.clone().applyMatrix4(this.toScene.clone().invert());
    return [p.normal.x, p.normal.y, p.normal.z, p.constant];
  }

  summary() {
    const m = this.meta, attrs = [m.rgb && "RGB", m.i && t("pc.attr_intensita"), m.c && t("pc.attr_classificazione")].filter(Boolean);
    return t("pc.n_punti", fmtNum(m.n)) + (attrs.length ? " (" + attrs.join(", ") + ")" : "");
  }

  dispose() {
    this.disposed = true;
    for (const n of this.nodes) if (n.obj) n.obj.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------- apertura
export async function loadPointCloud(c, ld, info) {
  if (WEB) return loadInBrowser(c, ld, info);
  const { job } = await api("pc_open", { path: c.path });
  const meta = await waitJob(job, (p, m) => ld.set(0.05 + p * 0.85, m || t("pc.lettura")));
  if (meta.mesh) return null; // PLY con facce: lo apre il lettore delle mesh
  info.settings = info.settings || defaultSettings();
  const cloud = new Cloud(meta, info, info.settings, c.name);
  (info.clouds = info.clouds || []).push(cloud);
  info.status = t("pc.status", cloud.summary()) + (meta.cached ? "" : " · " + t("pc.preparata", fmtNum(meta.secs, 1)));
  return { root: cloud.root, tree: cloud.tree(), cloud };
}

// controlli nella barra del visualizzatore (validi per tutte le nuvole della scheda)
export function cloudControls(info, onChange) {
  const s = info.settings;
  const each = f => (info.clouds || []).forEach(f);
  const mode = el("select", { title: t("pc.colore_punti"), onchange: e => { s.mode = e.target.value; each(c => c.recolor()); onChange(); } },
    ...[["auto", t("pc.col_auto")], ["rgb", t("pc.col_rgb")], ["int", t("pc.col_int")], ["z", t("pc.col_z")], ["class", t("pc.col_class")], ["uni", t("pc.col_uni")]]
      .map(([v, t]) => el("option", { value: v, selected: s.mode === v }, t)));
  const size = el("input", { type: "range", min: "1", max: "10", step: "0.5", value: String(s.size), title: t("pc.dimensione"), style: { width: "80px" } });
  size.addEventListener("input", () => { s.size = Number(size.value); each(c => c.setSize(s.size)); onChange(); });
  const budget = el("select", { title: t("pc.dettaglio_title"), onchange: e => { s.budget = Number(e.target.value); onChange(); } },
    ...[1, 3, 6, 10, 20].map(m => [m * 1e6, t("pc.dettaglio", m)])
      .map(([v, t]) => el("option", { value: String(v), selected: s.budget === v }, t)));
  return el("span", { style: { display: "inline-flex", gap: "6px", alignItems: "center" } }, mode, el("span", { class: "note" }, t("pc.punti")), size, budget);
}

// ---------------------------------------------------------------------------- web app (senza motore Python)
// LAS non compresso, testo (XYZ/PTS/TXT) e PLY a soli punti letti nel browser; un solo nodo, al massimo 5 milioni di punti
async function loadInBrowser(c, ld, info) {
  const ext = c.ext || extOf(c.name);
  if (ext === "laz" || ext === "e57" || ext === "ptx") throw new Error(t("pc.solo_pc", ext));
  ld.set(0.2, t("pc.lettura"));
  const bytes = await readBytes(c.path);
  let d;
  if (bytes[0] === 0x4c && bytes[1] === 0x41 && bytes[2] === 0x53 && bytes[3] === 0x46) d = parseLas(bytes);
  else if (ext === "ply") {
    const { PLYLoader } = await import("three/addons/loaders/PLYLoader.js");
    const g = new PLYLoader().parse(bytes.buffer);
    if (g.index) return null;
    const p = g.attributes.position.array, col = g.attributes.color?.array;
    d = { count: p.length / 3, xyz: Float64Array.from(p), rgb: col ? Uint8Array.from(col, v => v * 255) : null };
  } else d = parseText(new TextDecoder("latin1").decode(bytes), ext);
  const MAX = 5e6, step = Math.max(1, Math.ceil(d.count / MAX)), n = Math.floor((d.count - 1) / step) + 1;
  const off = [d.xyz[0], d.xyz[1], d.xyz[2]].map(Math.round);
  const pos = new Float32Array(n * 3), rgb = d.rgb ? new Uint8Array(n * 3) : null, it = d.int ? new Uint16Array(n) : null, cls = d.cls ? new Uint8Array(n) : null;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  let ilo = Infinity, ihi = -Infinity;
  if (d.int) for (let i = 0; i < d.count; i += step) { ilo = Math.min(ilo, d.int[i]); ihi = Math.max(ihi, d.int[i]); }
  for (let i = 0, j = 0; j < n; i += step, j++) {
    for (let a = 0; a < 3; a++) { const v = d.xyz[i * 3 + a] - off[a]; pos[j * 3 + a] = v; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v; }
    if (rgb) { rgb[j * 3] = d.rgb[i * 3]; rgb[j * 3 + 1] = d.rgb[i * 3 + 1]; rgb[j * 3 + 2] = d.rgb[i * 3 + 2]; }
    if (it) it[j] = ((d.int[i] - ilo) / (ihi - ilo || 1)) * 65535;
    if (cls) cls[j] = d.cls[i];
  }
  const counts = new Map();
  if (cls) for (const v of cls) counts.set(v, (counts.get(v) || 0) + 1);
  const size = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
  const meta = { n, offset: off, bbox: [...mn, ...mx], cube: [...mn, size], S: 30, rgb: !!rgb, i: !!it, c: !!cls, i_range: it ? [ilo, ihi] : null,
    classes: [...counts].sort((a, b) => a[0] - b[0]), nodes: [[0, 0, 0, 0, 0, n, ...mn, ...mx]] };
  info.settings = info.settings || defaultSettings();
  const cloud = new Cloud(meta, info, info.settings, c.name);
  cloud.local = { count: n, pos, rgb, int: it, cls };
  (info.clouds = info.clouds || []).push(cloud);
  info.status = t("pc.status", cloud.summary()) + (step > 1 ? " (" + t("pc.campionato", step, fmtNum(d.count)) + ")" : "");
  return { root: cloud.root, tree: cloud.tree(), cloud };
}

function parseLas(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const fmt = dv.getUint8(104), id = fmt & 0x3f;
  if (fmt & 0x80 || fmt & 0x40) throw new Error(t("pc.laz_solo_pc"));
  const start = dv.getUint32(96, true), len = dv.getUint16(105, true), minor = dv.getUint8(25);
  let count = dv.getUint32(107, true);
  if (!count && minor >= 4) count = Number(dv.getBigUint64(247, true));
  const sc = [0, 1, 2].map(k => dv.getFloat64(131 + k * 8, true)), of = [0, 1, 2].map(k => dv.getFloat64(155 + k * 8, true));
  const rgbAt = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 }[id];
  const xyz = new Float64Array(count * 3), int = new Uint16Array(count), cls = new Uint8Array(count), rgb = rgbAt ? new Uint8Array(count * 3) : null;
  let sixteen = false;
  if (rgb) for (let i = 0; i < Math.min(count, 1000); i++) if (dv.getUint16(start + i * len + rgbAt, true) > 255) { sixteen = true; break; }
  for (let i = 0; i < count; i++) {
    const p = start + i * len;
    for (let a = 0; a < 3; a++) xyz[i * 3 + a] = dv.getInt32(p + a * 4, true) * sc[a] + of[a];
    int[i] = dv.getUint16(p + 12, true);
    cls[i] = id >= 6 ? dv.getUint8(p + 16) : dv.getUint8(p + 15) & 31;
    if (rgb) for (let a = 0; a < 3; a++) { const v = dv.getUint16(p + rgbAt + a * 2, true); rgb[i * 3 + a] = sixteen ? v >> 8 : v; }
  }
  return { count, xyz, int, cls, rgb };
}

function parseText(txt, ext) {
  const lines = txt.split(/\r?\n/);
  let first = 0;
  while (first < lines.length && (!lines[first].trim() || /^\s*(#|\/\/)/.test(lines[first]))) first++;
  if (ext === "pts" && lines[first] && lines[first].trim().split(/\s+/).length === 1) first++;
  const sample = lines[first] || "";
  const sep = /[;\t]/.test(sample) ? /[;\t]/ : sample.includes(",") ? /,/ : /\s+/;
  const commaDec = sep.source !== "," && sample.includes(",") && !sample.includes(".");
  const vals = [];
  for (let i = first; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s || s[0] === "#") continue;
    const p = (commaDec ? s.replace(/,/g, ".") : s).split(sep).map(Number);
    if (p.length >= 3 && !isNaN(p[0]) && !isNaN(p[1]) && !isNaN(p[2])) vals.push(p);
  }
  const count = vals.length, nc = vals[0]?.length || 3;
  const isRgb = c => c + 3 <= nc && vals.slice(0, 200).every(p => [p[c], p[c + 1], p[c + 2]].every(v => v >= 0 && v <= 255 && Number.isInteger(v)));
  let ic = null, rc = null;
  if (nc >= 7 && isRgb(4)) { ic = 3; rc = 4; } else if (nc >= 6 && isRgb(3)) rc = 3; else if (nc >= 4) ic = 3;
  const xyz = new Float64Array(count * 3), rgb = rc !== null ? new Uint8Array(count * 3) : null, int = ic !== null ? new Float64Array(count) : null;
  vals.forEach((p, i) => {
    xyz[i * 3] = p[0]; xyz[i * 3 + 1] = p[1]; xyz[i * 3 + 2] = p[2];
    if (rgb) { rgb[i * 3] = p[rc]; rgb[i * 3 + 1] = p[rc + 1]; rgb[i * 3 + 2] = p[rc + 2]; }
    if (int) int[i] = p[ic];
  });
  return { count, xyz, rgb, int };
}

// prove dalla console (web app)
export const _web = { parseLas, parseText };
