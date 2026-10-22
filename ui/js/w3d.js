// Modelli 3D dei DWF/DWFx (sezioni eModel, flussi W3D = HSF): scena three.js per il visualizzatore 3D di MB Visual.
// Albero dei segmenti con matrici, colori, inclusioni (istanze), shell (anche compresse edgebreaker), cilindri, sfere,
// spigoli pubblicati; proprieta' degli oggetti dal content.xml / ObjectDefinition collegate tramite i numeri di nodo
// (= indice di "tag" HSF del segmento).
import * as THREE from "three";
import { parseHsf } from "./hsf.js";
import { decodeEdgebreakerShell } from "./edgebreaker.js";
import { parseObjectDefinition, parseSectionContent, affineOf4x4 } from "./dwfpkg.js";

const nums = s => (String(s || "").match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number);

export async function loadW3dSection(pkg, sheet, ld) {
  const sec = sheet.section;
  const res = sec.res;
  const w3dRes = res.find(r => /x-w3d/i.test(r.mime) || /3d streaming graphics/i.test(r.role));
  if (!w3dRes) throw new Error("La sezione non contiene grafica 3D (W3D)");
  ld?.set(0.2, "Lettura del modello 3D (W3D)");
  const bytes = await pkg.read(w3dRes.href);
  if (!bytes) throw new Error("Flusso W3D non trovato nel pacchetto");
  // descrittore: unita' e trasformazione
  let units = "", T = null;
  const dres = res.find(r => r.role === "descriptor");
  if (dres) {
    const t = await pkg.text(dres.href);
    if (t) {
      const d = new DOMParser().parseFromString(t, "application/xml");
      const u = [...d.getElementsByTagName("*")].find(e => e.localName === "Units");
      units = u?.getAttribute("type") || "";
      const g = [...d.getElementsByTagName("*")].find(e => e.localName === "GraphicResource" && /3d/i.test(e.getAttribute("role") || ""));
      const v = nums(g?.getAttribute("transform"));
      if (v.length === 16) T = v;
    }
  }
  // proprieta': nodo -> { label, props }
  let byNode = new Map();
  try {
    const cd = res.find(r => /content definition/i.test(r.role));
    const od = res.find(r => /object definition/i.test(r.role));
    if (cd) { const content = await sheet.getContent?.(); const t = await pkg.text(cd.href); if (t) byNode = parseSectionContent(t, content); }
    else if (od) { const t = await pkg.text(od.href); if (t) byNode = parseObjectDefinition(t); }
  } catch (e) { console.warn("Proprieta' del modello non lette", e); }

  ld?.set(0.4, "Decodifica della geometria");
  await new Promise(r => setTimeout(r, 0));
  let ebFail = 0;
  const hsf = parseHsf(bytes, {
    edgebreaker: h => { try { const r = decodeEdgebreakerShell(h); if (r.bad || r.mismatch) ebFail++; return r; } catch (e) { ebFail++; return null; } },
  });

  ld?.set(0.7, "Costruzione della scena");
  // segmenti per nome (anche percorsi assoluti "?Include Library/26")
  const byName = new Map();
  const index = (s, path) => {
    const full = s.name ? (s.name.startsWith("?") || s.name.startsWith("/") ? s.name : path + "/" + s.name) : path;
    s.path = full;
    if (s.name) byName.set(full.toLowerCase(), s);
    for (const c of s.children) index(c, full);
  };
  index(hsf.root, "");
  const resolve = (name, from) => {
    const k = name.toLowerCase();
    if (byName.has(k)) return byName.get(k);
    const rel = (from.path + "/" + name).toLowerCase();
    if (byName.has(rel)) return byName.get(rel);
    for (const [n, s] of byName) if (n.endsWith("/" + k)) return s;
    return null;
  };
  const isLibrary = s => /^\?/.test(s.name || "");

  const mats = new Map();
  const material = (rgb, alpha = 1) => {
    const key = rgb.join(",") + "|" + alpha;
    if (!mats.has(key)) mats.set(key, new THREE.MeshStandardMaterial({ color: new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255), roughness: 0.6, metalness: 0.08, side: THREE.DoubleSide, transparent: alpha < 1, opacity: alpha }));
    return mats.get(key);
  };
  const lineMats = new Map();
  const lineMat = rgb => { const k = rgb.join(","); if (!lineMats.has(k)) lineMats.set(k, new THREE.LineBasicMaterial({ color: new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255) })); return lineMats.get(k); };
  const geoCache = new Map(); // shell -> BufferGeometry (le istanze la condividono)
  let triCount = 0, skipped = 0;

  function shellGeometry(g) {
    if (geoCache.has(g)) return geoCache.get(g);
    let geo = null;
    if (g.points && g.points.length >= 9 && g.faces && g.faces.length) {
      const idx = [];
      const f = g.faces, np = g.points.length / 3;
      const ok = i => i >= 0 && i < np;
      if (g.strips) {
        for (let i = 0; i < f.length;) {
          const n = Math.abs(f[i]), fan = f[i] < 0;
          const s = f.subarray(i + 1, i + 1 + n);
          for (let k = 2; k < n; k++) {
            const tri = fan ? [s[0], s[k - 1], s[k]] : k % 2 ? [s[k - 1], s[k - 2], s[k]] : [s[k - 2], s[k - 1], s[k]];
            if (tri.every(ok)) idx.push(...tri);
          }
          i += n + 1;
        }
      } else {
        for (let i = 0; i < f.length;) {
          const n = Math.abs(f[i]);
          if (f[i] > 0) for (let k = 2; k < n; k++) { const t = [f[i + 1], f[i + k], f[i + k + 1]]; if (t.every(ok)) idx.push(...t); } // poligoni: ventaglio (i fori si ignorano)
          i += n + 1;
        }
      }
      if (idx.length) {
        geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(g.points, 3));
        geo.setIndex(idx.length > 65535 * 3 || np > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
        geo = creaseNormals(geo, 35);
        triCount += idx.length / 3;
      }
    } else if (g.kind === "shell") skipped++;
    geoCache.set(g, geo);
    return geo;
  }

  const tree = [];
  function build(s, inh, depth, items) {
    if (depth > 40) return null;
    const grp = new THREE.Group();
    grp.name = s.name || "";
    const at = { ...inh };
    // stili (attributi della libreria degli stili) e attributi propri
    for (const st of s.style || []) { const ss = resolve(st, s); if (ss) Object.assign(at, pickAttr(ss.attr)); }
    Object.assign(at, pickAttr(s.attr));
    if (s.attr.matrix) {
      const m = s.attr.matrix;
      grp.matrixAutoUpdate = false;
      grp.matrix.set(m[0], m[3], m[6], m[9], m[1], m[4], m[7], m[10], m[2], m[5], m[8], m[11], 0, 0, 0, 1);
    }
    const info = s.tag !== undefined ? byNode.get(s.tag) : null;
    if (s.tag !== undefined && (info || /node/.test(s.attr.options || ""))) {
      grp.userData.navisId = s.tag;
      if (info) {
        grp.name = info.label || grp.name;
        grp.userData.navisProps = info.props.filter(p => p.cat !== "hidden" && !String(p.name).startsWith("_")).map(p => [p.cat || "Proprieta'", p.name, p.value]);
      }
    }
    const faceCol = at.face || [200, 200, 200];
    const alpha = at.transmission ? 1 - (at.transmission[0] + at.transmission[1] + at.transmission[2]) / 765 : 1;
    const lines = [];
    for (const g of s.geo) {
      if (g.kind === "shell" || g.kind === "mesh") {
        if (at.faceVis === false) continue;
        const geo = g.kind === "shell" ? shellGeometry(g) : meshGeometry(g);
        if (!geo) continue;
        const mesh = new THREE.Mesh(geo, material(g.color || faceCol, alpha));
        if (grp.userData.navisId !== undefined) mesh.userData.navisId = grp.userData.navisId;
        grp.add(mesh);
      } else if (g.kind === "cylinder") {
        const a = new THREE.Vector3(g.a[0], g.a[1], g.a[2]), b = new THREE.Vector3(g.a[3], g.a[4], g.a[5]);
        const len = a.distanceTo(b);
        if (!len || at.faceVis === false) continue;
        const geo = new THREE.CylinderGeometry(g.r, g.r, len, 32, 1, !(g.caps & 3));
        const m = new THREE.Mesh(geo, material(g.color || faceCol, alpha));
        m.position.copy(a).add(b).multiplyScalar(0.5);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
        if (grp.userData.navisId !== undefined) m.userData.navisId = grp.userData.navisId;
        grp.add(m);
      } else if (g.kind === "sphere") {
        if (at.faceVis === false) continue;
        const m = new THREE.Mesh(new THREE.SphereGeometry(g.r, 32, 16), material(g.color || faceCol, alpha));
        m.position.set(g.c[0], g.c[1], g.c[2]);
        if (grp.userData.navisId !== undefined) m.userData.navisId = grp.userData.navisId;
        grp.add(m);
      } else if (g.kind === "line" || g.kind === "arc") {
        if (at.lineVis === false || g.pts.length < 6) continue;
        const p = g.kind === "arc" ? arcPoints(g.pts) : g.pts;
        for (let i = 0; i + 5 < p.length; i += 3) lines.push(p[i], p[i + 1], p[i + 2], p[i + 3], p[i + 4], p[i + 5]);
      }
    }
    if (lines.length) {
      const lg = new THREE.BufferGeometry();
      lg.setAttribute("position", new THREE.Float32BufferAttribute(lines, 3));
      const ls = new THREE.LineSegments(lg, lineMat(at.line || [40, 40, 40]));
      ls.userData.edges = true;
      ls.raycast = () => {};
      grp.add(ls);
    }
    const myItems = [];
    // istanze incluse (librerie): copie che condividono geometrie e materiali
    for (const inc of s.includes || []) {
      const t = resolve(inc, s);
      if (!t) continue;
      const sub = build(t, at, depth + 1, myItems);
      if (sub) grp.add(sub);
    }
    for (const c of s.children) {
      if (isLibrary(c)) continue; // le librerie si disegnano solo dove sono incluse
      const sub = build(c, at, depth + 1, myItems);
      if (sub) grp.add(sub);
    }
    if (!grp.children.length) return null;
    if (grp.userData.navisId !== undefined) items.push({ name: grp.name || "Oggetto " + s.tag, obj: grp, children: myItems });
    else items.push(...myItems);
    return grp;
  }
  const root = build(hsf.root, {}, 0, tree) || new THREE.Group();
  // trasformazione del descrittore (spazio del modello -> mondo)
  if (T) {
    const M = new THREE.Matrix4().set(T[0], T[4], T[8], T[12], T[1], T[5], T[9], T[13], T[2], T[6], T[10], T[14], T[3], T[7], T[11], T[15]);
    if (!M.equals(new THREE.Matrix4())) { root.matrixAutoUpdate = false; root.matrix.premultiply(M); }
  }
  // orientamento: vista "default" con l'alto lungo Z -> si ruota come gli altri modelli CAD (Z verso l'alto)
  const outer = new THREE.Group();
  outer.add(root);
  const view = (hsf.views || []).find(v => /default/i.test(v.name)) || (hsf.views || [])[0];
  if (!view || Math.abs(view.up[2]) > Math.abs(view.up[1])) outer.rotation.x = -Math.PI / 2;
  outer.updateMatrixWorld(true);
  const warn = [...hsf.warnings];
  if (ebFail) warn.push(`${ebFail} superfici compresse non ricostruite`);
  if (skipped) warn.push(`${skipped} superfici senza geometria leggibile`);
  sheet.info3d = { units, triangles: triCount, warnings: warn };
  return { root: outer, tree: tree.length ? tree : [{ name: sheet.title, obj: outer, children: [] }] };
}

function pickAttr(a) {
  const o = {};
  for (const k of ["face", "edge", "line", "transmission", "faceVis", "edgeVis", "lineVis"]) if (a[k] !== undefined) o[k] = a[k];
  return o;
}

function meshGeometry(g) {
  const { rows, cols, points } = g;
  if (!points || rows < 2 || cols < 2) return null;
  const idx = [];
  for (let r = 0; r + 1 < rows; r++) for (let c = 0; c + 1 < cols; c++) { const a = r * cols + c; idx.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(points, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// arco per tre punti -> polilinea
function arcPoints(p) {
  const A = new THREE.Vector3(p[0], p[1], p[2]), B = new THREE.Vector3(p[3], p[4], p[5]), C = new THREE.Vector3(p[6], p[7], p[8]);
  const ab = B.clone().sub(A), ac = C.clone().sub(A);
  const n = ab.clone().cross(ac);
  const n2 = n.lengthSq();
  if (n2 < 1e-20) return [...p.slice(0, 3), ...p.slice(6, 9)];
  const center = A.clone().add(ac.clone().cross(n).multiplyScalar(ab.lengthSq()).add(n.clone().cross(ab).multiplyScalar(ac.lengthSq())).multiplyScalar(1 / (2 * n2)));
  const u = A.clone().sub(center), r = u.length(); u.normalize();
  const v = n.clone().normalize().cross(u);
  const ang = P => { const d = P.clone().sub(center); return Math.atan2(d.dot(v), d.dot(u)); };
  let a1 = ang(B), a2 = ang(C);
  if (a1 < 0) a1 += 2 * Math.PI;
  if (a2 < 0) a2 += 2 * Math.PI;
  const end = a1 <= a2 ? a2 : a2 - 2 * Math.PI; // da A (angolo 0) a C passando per B
  const out = [], N = 24;
  for (let i = 0; i <= N; i++) { const t = end * i / N; const q = center.clone().add(u.clone().multiplyScalar(r * Math.cos(t))).add(v.clone().multiplyScalar(r * Math.sin(t))); out.push(q.x, q.y, q.z); }
  return out;
}

// normali "con spigolo": si separano i vertici dove l'angolo tra facce supera la soglia (aspetto da CAD)
function creaseNormals(geo, deg) {
  const pos = geo.attributes.position.array, idx = geo.index.array;
  const nt = idx.length / 3;
  const fn = new Float32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const a = 3 * idx[3 * t], b = 3 * idx[3 * t + 1], c = 3 * idx[3 * t + 2];
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    fn[3 * t] = nx / L; fn[3 * t + 1] = ny / L; fn[3 * t + 2] = nz / L;
  }
  // triangoli attorno a ogni vertice
  const nv = pos.length / 3;
  const cnt = new Uint32Array(nv + 1);
  for (let i = 0; i < idx.length; i++) cnt[idx[i] + 1]++;
  for (let i = 0; i < nv; i++) cnt[i + 1] += cnt[i];
  const fill = cnt.slice(), around = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) around[fill[idx[i]]++] = (i / 3) | 0;
  const cosT = Math.cos(deg * Math.PI / 180);
  const outPos = new Float32Array(idx.length * 3), outNrm = new Float32Array(idx.length * 3);
  for (let i = 0; i < idx.length; i++) {
    const v = idx[i], t = (i / 3) | 0;
    let nx = 0, ny = 0, nz = 0;
    for (let k = cnt[v]; k < cnt[v + 1]; k++) {
      const u = around[k];
      if (fn[3 * u] * fn[3 * t] + fn[3 * u + 1] * fn[3 * t + 1] + fn[3 * u + 2] * fn[3 * t + 2] >= cosT) { nx += fn[3 * u]; ny += fn[3 * u + 1]; nz += fn[3 * u + 2]; }
    }
    const L = Math.hypot(nx, ny, nz) || 1;
    outNrm[3 * i] = nx / L; outNrm[3 * i + 1] = ny / L; outNrm[3 * i + 2] = nz / L;
    outPos[3 * i] = pos[3 * v]; outPos[3 * i + 1] = pos[3 * v + 1]; outPos[3 * i + 2] = pos[3 * v + 2];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(outPos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(outNrm, 3));
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}
