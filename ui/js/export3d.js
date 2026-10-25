// Esportazione dei modelli 3D in formati tecnici: STEP (AP214, facce piane), IFC 4 (un elemento BIM per oggetto),
// 3MF (stampa 3D), DXF 3D (facce 3DFACE per layer), VRML. Funziona con qualsiasi modello aperto nel visualizzatore
// (IFC, STEP, Rhino, Navisworks, mesh...): si esporta cio' che e' visibile, con nomi e colori degli oggetti.
// Coordinate: la scena di three.js ha l'asse Y verso l'alto; i formati tecnici usano Z verso l'alto (x, -z, y).
import { t as tr } from "./i18n.js";
import * as THREE from "three";

// ---------------------------------------------------------------- raccolta degli oggetti
// elementi: [{ name, type, color:[r,g,b], opacity, pos: Float64Array (metri, Z in alto), idx: Uint32Array }]
export function collectElements(model, metersPerUnit = 1) {
  model.updateMatrixWorld(true);
  const visible = o => { for (let x = o; x; x = x.parent) if (!x.visible && !x.userData.proxy) return false; return true; };
  const owners = new Map(); // oggetto proprietario (elemento BIM / nodo Navisworks / mesh) -> parti
  model.traverse(m => {
    if (!m.isMesh || !m.geometry?.attributes?.position || m.userData.merged || !visible(m)) return;
    let owner = m;
    for (let x = m.parent; x && x !== model; x = x.parent) if (x.userData.expressID !== undefined || x.userData.navisId !== undefined) { owner = x; break; }
    if (owner === m && (m.userData.proxy || m.userData.pickParent) && m.parent) owner = m.parent; // SketchUp: un elemento per gruppo/componente
    if (!owners.has(owner)) owners.set(owner, []);
    owners.get(owner).push(m);
  });
  const v = new THREE.Vector3();
  const out = [];
  for (const [owner, meshes] of owners) {
    const pos = [], idx = [];
    let color = null, opacity = 1;
    for (const m of meshes) {
      const g = m.geometry, P = g.attributes.position;
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      if (!color && mat?.color) { color = [mat.color.r, mat.color.g, mat.color.b]; opacity = mat.opacity ?? 1; }
      const src = g.index ? g.index.array : null;
      const n = src ? src.length : P.count;
      const base = pos.length / 3;
      // vertici usati (le copie di selezione dei modelli uniti condividono un buffer enorme: si prendono solo i loro)
      const remap = new Map();
      for (let i = 0; i < n; i++) {
        const o = src ? src[i] : i;
        let k = remap.get(o);
        if (k === undefined) {
          k = base + remap.size;
          remap.set(o, k);
          v.fromBufferAttribute(P, o).applyMatrix4(m.matrixWorld);
          pos.push(v.x * metersPerUnit, -v.z * metersPerUnit, v.y * metersPerUnit);
        }
        idx.push(k);
      }
    }
    if (idx.length < 3) continue;
    out.push({ name: owner.name || meshes[0].name || tr("export3d.oggetto"), type: owner.userData.ifcType || owner.name || "", color: color || [0.75, 0.75, 0.75], opacity,
      pos: Float64Array.from(pos), idx: Uint32Array.from(idx) });
  }
  return out;
}

const tris = el => { const t = []; for (let i = 0; i + 2 < el.idx.length; i += 3) { const a = el.idx[i], b = el.idx[i + 1], c = el.idx[i + 2]; if (a !== b && b !== c && a !== c) t.push([a, b, c]); } return t; };
const num = x => { const s = (Math.abs(x) < 1e-9 ? 0 : x).toFixed(6).replace(/0+$/, "").replace(/\.$/, "."); return s.includes(".") ? s : s + "."; };
// stringa per i file STEP/IFC: apostrofi raddoppiati, caratteri non ASCII in \X2\....\X0\
function stepStr(s) {
  let out = "";
  for (const ch of String(s ?? "")) {
    const c = ch.codePointAt(0);
    if (ch === "'") out += "''";
    else if (ch === "\\") out += "\\\\";
    else if (c >= 32 && c < 127) out += ch;
    else if (c < 0x10000) out += "\\X2\\" + c.toString(16).toUpperCase().padStart(4, "0") + "\\X0\\";
  }
  return `'${out}'`;
}
const today = () => new Date().toISOString().slice(0, 19);
function stepWriter() {
  const lines = [];
  let n = 0;
  return { add(s) { lines.push(`#${++n}=${s};`); return n; }, lines };
}

// ---------------------------------------------------------------- facce piane da triangoli
// Saldatura dei vertici coincidenti, poi i triangoli complanari e adiacenti diventano un'unica faccia poligonale
// (con eventuali fori). Restituisce { P: posizioni saldate, faces: [{ n:[nx,ny,nz], loops: [[i,...], ...] }] }:
// il primo anello e' il contorno esterno, gli altri i fori (versi gia' coerenti con la normale).
export function planarFaces(el, weld = 1e-6) {
  const map = new Map(), P = [], remap = new Uint32Array(el.pos.length / 3);
  for (let i = 0; i < remap.length; i++) {
    const x = el.pos[i * 3], y = el.pos[i * 3 + 1], z = el.pos[i * 3 + 2];
    const key = `${Math.round(x / weld)},${Math.round(y / weld)},${Math.round(z / weld)}`;
    let k = map.get(key);
    if (k === undefined) { k = P.length / 3; map.set(key, k); P.push(x, y, z); }
    remap[i] = k;
  }
  const T = [];
  for (const [a0, b0, c0] of tris(el)) {
    const a = remap[a0], b = remap[b0], c = remap[c0];
    if (a === b || b === c || a === c) continue;
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-14) continue;
    nx /= nl; ny /= nl; nz /= nl;
    T.push({ v: [a, b, c], n: [nx, ny, nz], d: nx * P[a * 3] + ny * P[a * 3 + 1] + nz * P[a * 3 + 2] });
  }
  // gruppi di triangoli complanari che condividono un lato
  const parent = T.map((_, i) => i);
  const find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const edges = new Map();
  T.forEach((t, i) => { for (let k = 0; k < 3; k++) { const a = t.v[k], b = t.v[(k + 1) % 3]; const key = a < b ? a + "_" + b : b + "_" + a; if (!edges.has(key)) edges.set(key, []); edges.get(key).push(i); } });
  const same = (s, t) => s.n[0] * t.n[0] + s.n[1] * t.n[1] + s.n[2] * t.n[2] > 0.999999 && Math.abs(s.d - t.d) < weld * 10;
  for (const list of edges.values()) {
    if (list.length !== 2) continue;
    const [i, j] = list;
    if (same(T[i], T[j])) parent[find(i)] = find(j);
  }
  const groups = new Map();
  T.forEach((t, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(t); });
  const faces = [];
  for (const g of groups.values()) {
    if (g.length === 1) { faces.push({ n: g[0].n, loops: [g[0].v] }); continue; }
    // lati di contorno = lati usati una sola volta nel gruppo (con il verso del triangolo)
    const count = new Map();
    for (const t of g) for (let k = 0; k < 3; k++) { const a = t.v[k], b = t.v[(k + 1) % 3]; const key = a < b ? a + "_" + b : b + "_" + a; count.set(key, (count.get(key) || 0) + 1); }
    const next = new Map();
    let bad = false;
    for (const t of g) for (let k = 0; k < 3; k++) {
      const a = t.v[k], b = t.v[(k + 1) % 3], key = a < b ? a + "_" + b : b + "_" + a;
      if (count.get(key) === 1) { if (next.has(a)) bad = true; next.set(a, b); }
    }
    const loops = [];
    if (!bad) {
      const used = new Set();
      for (const start of next.keys()) {
        if (used.has(start)) continue;
        const loop = [];
        let v = start, guard = 0;
        while (!used.has(v) && guard++ < 1e6) { used.add(v); loop.push(v); v = next.get(v); if (v === undefined) { bad = true; break; } }
        if (bad || v !== start) { bad = true; break; }
        loops.push(loop);
      }
    }
    if (bad || !loops.length) { for (const t of g) faces.push({ n: t.n, loops: [t.v] }); continue; } // contorno ambiguo: triangoli
    // contorno esterno = anello di area maggiore; via i punti allineati
    const n = g[0].n;
    const area = lp => { let sx = 0, sy = 0, sz = 0; for (let i = 0; i < lp.length; i++) { const a = lp[i], b = lp[(i + 1) % lp.length]; sx += P[a * 3 + 1] * P[b * 3 + 2] - P[a * 3 + 2] * P[b * 3 + 1]; sy += P[a * 3 + 2] * P[b * 3] - P[a * 3] * P[b * 3 + 2]; sz += P[a * 3] * P[b * 3 + 1] - P[a * 3 + 1] * P[b * 3]; } return Math.abs(sx * n[0] + sy * n[1] + sz * n[2]) / 2; };
    const clean = lp => lp.filter((v, i) => {
      const a = lp[(i + lp.length - 1) % lp.length], c = lp[(i + 1) % lp.length];
      const ux = P[v * 3] - P[a * 3], uy = P[v * 3 + 1] - P[a * 3 + 1], uz = P[v * 3 + 2] - P[a * 3 + 2], wx = P[c * 3] - P[v * 3], wy = P[c * 3 + 1] - P[v * 3 + 1], wz = P[c * 3 + 2] - P[v * 3 + 2];
      return Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) > 1e-12 * Math.max(1, Math.hypot(ux, uy, uz) * Math.hypot(wx, wy, wz) * 1e6);
    });
    loops.sort((p, q) => area(q) - area(p));
    const cl = loops.map(clean).filter(lp => lp.length >= 3);
    if (!cl.length) { for (const t of g) faces.push({ n: t.n, loops: [t.v] }); continue; }
    faces.push({ n, loops: cl });
  }
  return { P, faces };
}

// ---------------------------------------------------------------- STEP AP214 (millimetri)
// Assieme: una parte (PRODUCT) per oggetto, con nome e colore; ogni parte e' un solido a facce piane
// (FACETED_BREP con FACE_SURFACE + PLANE). Un unico corpo con decine di migliaia di facce non viene letto dai CAD.
export function toSTEP(elements, name = "modello") {
  const w = stepWriter(), A = s => w.add(s);
  const ctxApp = A("APPLICATION_CONTEXT('automotive design')");
  A(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${ctxApp})`);
  const pctx = A(`PRODUCT_CONTEXT('',#${ctxApp},'mechanical')`);
  const pdctx = A(`PRODUCT_DEFINITION_CONTEXT('part definition',#${ctxApp},'design')`);
  const uL = A("(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))");
  const uA = A("(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))");
  const uS = A("(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())");
  const unc = A(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-05),#${uL},'distance_accuracy_value','confusion accuracy')`);
  const gctx = A(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${uL},#${uA},#${uS}))REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY'))`);
  const o = A("CARTESIAN_POINT('',(0.,0.,0.))"), z = A("DIRECTION('',(0.,0.,1.))"), x = A("DIRECTION('',(1.,0.,0.))");
  const part = nm => { // prodotto + definizione + forma
    const prod = A(`PRODUCT(${stepStr(nm)},${stepStr(nm)},'',(#${pctx}))`);
    A(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#${prod}))`);
    const pdf = A(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`);
    const pd = A(`PRODUCT_DEFINITION('design','',#${pdf},#${pdctx})`);
    return { pd, pds: A(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`) };
  };
  const root = part(name);
  const rootAx = A(`AXIS2_PLACEMENT_3D('',#${o},#${z},#${x})`);
  const rootSr = A(`SHAPE_REPRESENTATION(${stepStr(name)},(#${rootAx}),#${gctx})`);
  A(`SHAPE_DEFINITION_REPRESENTATION(#${root.pds},#${rootSr})`);
  const styled = [];
  let k = 0;
  for (const el of elements) {
    const { P, faces: polys } = planarFaces(el);
    if (!polys.length) continue;
    const pts = new Map(); // punti creati solo se usati
    const pt = i => { let id = pts.get(i); if (!id) { id = A(`CARTESIAN_POINT('',(${num(P[i * 3] * 1000)},${num(P[i * 3 + 1] * 1000)},${num(P[i * 3 + 2] * 1000)}))`); pts.set(i, id); } return id; };
    const planes = new Map(); // facce complanari condividono il piano
    const faces = [];
    for (const f of polys) {
      const [nx, ny, nz] = f.n, o0 = f.loops[0];
      const a = o0[0], b = o0[1];
      const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2], ul = Math.hypot(ux, uy, uz);
      if (ul < 1e-12) continue;
      const key = `${nx.toFixed(6)},${ny.toFixed(6)},${nz.toFixed(6)},${(nx * P[a * 3] + ny * P[a * 3 + 1] + nz * P[a * 3 + 2]).toFixed(7)}`;
      let pl = planes.get(key);
      if (!pl) {
        const dz = A(`DIRECTION('',(${num(nx)},${num(ny)},${num(nz)}))`), dx = A(`DIRECTION('',(${num(ux / ul)},${num(uy / ul)},${num(uz / ul)}))`);
        pl = A(`PLANE('',#${A(`AXIS2_PLACEMENT_3D('',#${pt(a)},#${dz},#${dx})`)})`);
        planes.set(key, pl);
      }
      const bounds = f.loops.map((lp, i) => A(`${i ? "FACE_BOUND" : "FACE_OUTER_BOUND"}('',#${A(`POLY_LOOP('',(${lp.map(v => "#" + pt(v)).join(",")}))`)},.T.)`));
      faces.push(A(`FACE_SURFACE('',(${bounds.map(x => "#" + x).join(",")}),#${pl},.T.)`));
    }
    if (!faces.length) continue;
    const shell = A(`CLOSED_SHELL('',(${faces.map(f => "#" + f).join(",")}))`);
    const brep = A(`FACETED_BREP(${stepStr(el.name)},#${shell})`);
    const prt = part(el.name);
    const ax = A(`AXIS2_PLACEMENT_3D('',#${o},#${z},#${x})`);
    const sr = A(`FACETED_BREP_SHAPE_REPRESENTATION(${stepStr(el.name)},(#${brep},#${ax}),#${gctx})`);
    A(`SHAPE_DEFINITION_REPRESENTATION(#${prt.pds},#${sr})`);
    // la parte nell'assieme (posizione identica: le coordinate sono gia' quelle finali)
    const nauo = A(`NEXT_ASSEMBLY_USAGE_OCCURRENCE('${++k}',${stepStr(el.name)},'',#${root.pd},#${prt.pd},$)`);
    const idt = A(`ITEM_DEFINED_TRANSFORMATION('','',#${ax},#${rootAx})`);
    const rel = A(`(REPRESENTATION_RELATIONSHIP('','',#${sr},#${rootSr})REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#${idt})SHAPE_REPRESENTATION_RELATIONSHIP())`);
    A(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#${rel},#${A(`PRODUCT_DEFINITION_SHAPE('','',#${nauo})`)})`);
    const [r, g, b] = el.color;
    const col = A(`COLOUR_RGB('',${num(r)},${num(g)},${num(b)})`);
    const fas = A(`FILL_AREA_STYLE('',(#${A(`FILL_AREA_STYLE_COLOUR('',#${col})`)}))`);
    const sss = A(`SURFACE_SIDE_STYLE('',(#${A(`SURFACE_STYLE_FILL_AREA(#${fas})`)}))`);
    const psa = A(`PRESENTATION_STYLE_ASSIGNMENT((#${A(`SURFACE_STYLE_USAGE(.BOTH.,#${sss})`)}))`);
    styled.push(A(`STYLED_ITEM('color',(#${psa}),#${brep})`));
  }
  if (styled.length) A(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${styled.map(i => "#" + i).join(",")}),#${gctx})`);
  return ["ISO-10303-21;", "HEADER;", "FILE_DESCRIPTION(('MB Desk - assieme a facce piane'),'2;1');",
    `FILE_NAME(${stepStr(name + ".stp")},'${today()}',('MB Desk'),('MB Engineering'),'MB Desk','MB Desk','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));", "ENDSEC;", "DATA;", ...w.lines, "ENDSEC;", "END-ISO-10303-21;", ""].join("\n");
}

// ---------------------------------------------------------------- IFC 4 (metri)
const B64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
function guid() { // GlobalId IFC: 128 bit in 22 caratteri
  const b = crypto.getRandomValues(new Uint8Array(16));
  let bits = "";
  for (const x of b) bits += x.toString(2).padStart(8, "0");
  bits = "0000" + bits; // 132 bit = 22 x 6
  let s = "";
  for (let i = 0; i < 132; i += 6) s += B64[parseInt(bits.slice(i, i + 6), 2)];
  return s;
}
// classi IFC4 con 9 attributi (..., Tag, PredefinedType): si conservano; le altre diventano IfcBuildingElementProxy
const IFC_TYPES = new Set(["IFCWALL", "IFCWALLSTANDARDCASE", "IFCSLAB", "IFCBEAM", "IFCCOLUMN", "IFCROOF", "IFCSTAIR", "IFCRAILING", "IFCPLATE",
  "IFCMEMBER", "IFCPIPESEGMENT", "IFCPIPEFITTING", "IFCDUCTSEGMENT", "IFCDUCTFITTING", "IFCCOVERING", "IFCFOOTING", "IFCBUILDINGELEMENTPROXY"]);
export function toIFC(elements, name = "modello") {
  const w = stepWriter(), A = s => w.add(s);
  const org = A("IFCORGANIZATION($,'MB Engineering',$,$,$)");
  const app = A(`IFCAPPLICATION(#${org},'1','MB Desk','MBVisual')`);
  const per = A("IFCPERSON($,$,'MB Desk',$,$,$,$,$)");
  const pao = A(`IFCPERSONANDORGANIZATION(#${per},#${org},$)`);
  const own = A(`IFCOWNERHISTORY(#${pao},#${app},$,.ADDED.,$,$,$,${Math.floor(Date.now() / 1000)})`);
  const o = A("IFCCARTESIANPOINT((0.,0.,0.))"), z = A("IFCDIRECTION((0.,0.,1.))"), x = A("IFCDIRECTION((1.,0.,0.))");
  const wcs = A(`IFCAXIS2PLACEMENT3D(#${o},#${z},#${x})`);
  const ctx = A(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#${wcs},$)`);
  const body = A(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#${ctx},$,.MODEL_VIEW.,$)`);
  const uL = A("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)"), uA = A("IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)"), uV = A("IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)");
  const ua = A(`IFCUNITASSIGNMENT((#${uL},#${uA},#${uV}))`);
  const proj = A(`IFCPROJECT('${guid()}',#${own},${stepStr(name)},$,$,$,$,(#${ctx}),#${ua})`);
  const plc = A(`IFCLOCALPLACEMENT($,#${wcs})`);
  const site = A(`IFCSITE('${guid()}',#${own},'Sito',$,$,#${plc},$,$,.ELEMENT.,$,$,$,$,$)`);
  const bldg = A(`IFCBUILDING('${guid()}',#${own},'Edificio',$,$,#${plc},$,$,.ELEMENT.,$,$,$)`);
  const storey = A(`IFCBUILDINGSTOREY('${guid()}',#${own},'Livello 0',$,$,#${plc},$,$,.ELEMENT.,0.)`);
  A(`IFCRELAGGREGATES('${guid()}',#${own},$,$,#${proj},(#${site}))`);
  A(`IFCRELAGGREGATES('${guid()}',#${own},$,$,#${site},(#${bldg}))`);
  A(`IFCRELAGGREGATES('${guid()}',#${own},$,$,#${bldg},(#${storey}))`);
  const styles = new Map();
  const styleFor = (c, op) => {
    const k = c.map(v => v.toFixed(3)).join() + op.toFixed(2);
    if (!styles.has(k)) {
      const col = A(`IFCCOLOURRGB($,${num(c[0])},${num(c[1])},${num(c[2])})`);
      const sh = A(`IFCSURFACESTYLESHADING(#${col},${num(Math.max(0, Math.min(1, 1 - op)))})`);
      styles.set(k, A(`IFCSURFACESTYLE($,.BOTH.,(#${sh}))`));
    }
    return styles.get(k);
  };
  const items = [];
  for (const el of elements) {
    const t = tris(el);
    if (!t.length) continue;
    const pts = [];
    for (let i = 0; i < el.pos.length; i += 3) pts.push(`(${num(el.pos[i])},${num(el.pos[i + 1])},${num(el.pos[i + 2])})`);
    const pl = A(`IFCCARTESIANPOINTLIST3D((${pts.join(",")}),$)`);
    const fs = A(`IFCTRIANGULATEDFACESET(#${pl},$,$,(${t.map(([a, b, c]) => `(${a + 1},${b + 1},${c + 1})`).join(",")}),$)`);
    A(`IFCSTYLEDITEM(#${fs},(#${styleFor(el.color, el.opacity)}),$)`);
    const rep = A(`IFCSHAPEREPRESENTATION(#${body},'Body','Tessellation',(#${fs}))`);
    const pds = A(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`);
    const lp = A(`IFCLOCALPLACEMENT(#${plc},#${wcs})`);
    const t0 = String(el.type || "").toUpperCase();
    // elementi che arrivano da un IFC mantengono la loro classe; tutto il resto e' un IfcBuildingElementProxy
    const cls = IFC_TYPES.has(t0) ? t0 : "IFCBUILDINGELEMENTPROXY";
    items.push(A(`${cls}('${guid()}',#${own},${stepStr(el.name)},$,${stepStr(el.type || "")},#${lp},#${pds},$,${cls === "IFCBUILDINGELEMENTPROXY" ? ".NOTDEFINED." : "$"})`));
  }
  for (let i = 0; i < items.length; i += 5000)
    A(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid()}',#${own},$,$,(${items.slice(i, i + 5000).map(n => "#" + n).join(",")}),#${storey})`);
  return ["ISO-10303-21;", "HEADER;", "FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');",
    `FILE_NAME(${stepStr(name + ".ifc")},'${today()}',('MB Desk'),('MB Engineering'),'MB Desk','MB Desk','');`,
    "FILE_SCHEMA(('IFC4'));", "ENDSEC;", "DATA;", ...w.lines, "ENDSEC;", "END-ISO-10303-21;", ""].join("\n");
}

// ---------------------------------------------------------------- 3MF (stampa 3D, millimetri)
export async function to3MF(elements) {
  const { zipSync, strToU8 } = await import("three/addons/libs/fflate.module.js");
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const hex = c => "#" + c.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<model unit="millimeter" xml:lang="it-IT" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">', "<resources>"];
  parts.push('<basematerials id="1">' + elements.map(e => `<base name="${esc(e.name)}" displaycolor="${hex(e.color)}"/>`).join("") + "</basematerials>");
  const items = [];
  elements.forEach((el, i) => {
    const t = tris(el);
    if (!t.length) return;
    const id = i + 2;
    const vs = [];
    for (let k = 0; k < el.pos.length; k += 3) vs.push(`<vertex x="${(el.pos[k] * 1000).toFixed(4)}" y="${(el.pos[k + 1] * 1000).toFixed(4)}" z="${(el.pos[k + 2] * 1000).toFixed(4)}"/>`);
    parts.push(`<object id="${id}" type="model" name="${esc(el.name)}" pid="1" pindex="${i}"><mesh><vertices>${vs.join("")}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join("")}</triangles></mesh></object>`);
    items.push(`<item objectid="${id}"/>`);
  });
  parts.push("</resources>", `<build>${items.join("")}</build>`, "</model>");
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    "3D/3dmodel.model": strToU8(parts.join("\n")),
  }, { level: 6 });
}

// ---------------------------------------------------------------- DXF 3D (facce 3DFACE, un layer per tipo di oggetto, millimetri)
const ACI = [[0, 0, 0], [255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255], [255, 255, 255], [128, 128, 128], [192, 192, 192]];
function aci(c) { // colore AutoCAD (indice) piu' vicino
  let best = 7, d = Infinity;
  ACI.forEach((a, i) => { if (!i) return; const q = (a[0] - c[0] * 255) ** 2 + (a[1] - c[1] * 255) ** 2 + (a[2] - c[2] * 255) ** 2; if (q < d) { d = q; best = i; } });
  return best;
}
export function toDXF(elements) {
  const out = ["0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1009", "9", "$INSUNITS", "70", "4", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES"];
  const layer = s => (String(s || "0").replace(/[<>/\\":;?*|=',]/g, "_").slice(0, 60) || "0");
  for (const el of elements) {
    const L = layer(el.type || el.name), col = aci(el.color);
    for (const [a, b, c] of tris(el)) {
      out.push("0", "3DFACE", "8", L, "62", String(col));
      [a, b, c, c].forEach((p, k) => out.push(String(10 + k), num(el.pos[p * 3] * 1000), String(20 + k), num(el.pos[p * 3 + 1] * 1000), String(30 + k), num(el.pos[p * 3 + 2] * 1000)));
    }
  }
  out.push("0", "ENDSEC", "0", "EOF");
  return out.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------- VRML 2.0 (metri)
export function toVRML(elements) {
  const out = ["#VRML V2.0 utf8", "# MB Desk"];
  for (const el of elements) {
    const t = tris(el);
    if (!t.length) continue;
    const pts = [];
    const f = x => String(+x.toFixed(6)); // VRML non accetta i numeri con il punto finale ("0.") usati da STEP/IFC
    for (let i = 0; i < el.pos.length; i += 3) pts.push(`${f(el.pos[i])} ${f(el.pos[i + 2])} ${f(-el.pos[i + 1])}`); // VRML: Y in alto
    out.push(`DEF ${("O_" + el.name).replace(/[^A-Za-z0-9_]/g, "_").slice(0, 50)} Shape {`, ` appearance Appearance { material Material { diffuseColor ${el.color.map(f).join(" ")} transparency ${f(1 - el.opacity)} } }`,
      ` geometry IndexedFaceSet { solid FALSE coord Coordinate { point [ ${pts.join(", ")} ] } coordIndex [ ${t.map(([a, b, c]) => `${a}, ${b}, ${c}, -1`).join(", ")} ] } }`);
  }
  return out.join("\n") + "\n";
}
