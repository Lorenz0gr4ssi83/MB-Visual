// Lettore JT (ISO 14306, Siemens "JT File Format Reference" v8.1 / v9.5 / v10.5), scritto da zero sulla specifica pubblica.
// Legge: struttura dell'assieme (LSG: nodi, istanze, parti, LOD, interruttori, partizioni in file esterni),
// attributi (materiale = colore, trasformazione geometrica), proprieta' e metadati (Property Table, Property Proxy),
// geometria tassellata Tri-Strip Set: JT 8 (strisce compresse con Int32CDP, anche senza perdita) e JT 9/10
// (mesh a compressione topologica, Appendice E della specifica). Livelli di dettaglio: sempre il primo figlio dei
// nodi LOD = il piu' fine. Non letti (dichiarati nei messaggi): B-rep XT / JT B-rep / ULP / LWPA (solo la mesh),
// PMI, linee (Polyline Set), punti, Primitive Set, texture.
// Uscita "piatta" e trasferibile da un Web Worker: { root, meshes, warnings, info }.
import { Reader, readCDP1, readCDP2, PRED, deeringNormal, inflate, xzDecode } from "./jtcodec.js";

// identificativi dei tipi (prima parte del GUID)
const T = {
  END: "ffffffff", BASE: "10dd1035", PARTITION: "10dd103e", GROUP: "10dd101b", INSTANCE: "10dd102a", PART: "ce357244",
  META: "ce357245", LOD: "10dd102c", RANGELOD: "10dd104c", SWITCH: "10dd10f3",
  TRISTRIP: "10dd1077", POLYLINE: "10dd1046", POINTSET: "98134716", POLYGON: "10dd1048", NULLSHAPE: "d239e7b6", PRIMSET: "e40373c1",
  VERTEXSHAPE: "10dd107f", BASESHAPE: "10dd1059",
  MATERIAL: "10dd1030", XFORM: "10dd1083",
  P_STRING: "10dd106e", P_INT: "10dd102b", P_FLOAT: "10dd1019", P_DATE: "ce357246", P_LATE: "e0b05be5", P_REF: "10dd1004", P_VEC4: "2e7db4be",
  LOD_TRISTRIP: "10dd10ab", LOD_POLYGON: "10dd109f", PROXY: "ce357247",
};
const SHAPES = new Set([T.TRISTRIP, T.POLYLINE, T.POINTSET, T.POLYGON, T.NULLSHAPE, T.PRIMSET, T.VERTEXSHAPE, T.BASESHAPE]);
const SEG_NAMES = { 2: "B-rep JT", 3: "PMI", 17: "B-rep Parasolid XT", 18: "Wireframe", 20: "ULP", 24: "LWPA", 33: "B-rep STEP" };

export async function parseJT(bytes, opts = {}) {
  const ctx = { warnings: new Set(), meshes: [], meshBySeg: new Map(), progress: opts.progress || (() => {}), readExternal: opts.readExternal, depth: opts.depth || 0 };
  const root = await parseFile(bytes, opts.name || "JT", ctx);
  const info = { versione: root.versione, triangoli: ctx.meshes.reduce((s, m) => s + m.i.length / 3, 0), mesh: ctx.meshes.length };
  return { root, meshes: ctx.meshes, warnings: [...ctx.warnings].map(w => JSON.parse(w)), info };
}

async function parseFile(bytes, name, ctx) {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 80));
  const m = /Version\s+(\d+)\.(\d+)/.exec(head);
  if (!m) throw new Error("jt.e_non_jt");
  const ver = +m[1] + +m[2] / 10;
  if (ver < 8) throw new Error(code("jt.e_versione", `${m[1]}.${m[2]}`));
  const F = { ver, v9: ver >= 9, v10: ver >= 10, bytes };
  const r = new Reader(bytes, 80);
  if (r.u8_() !== 0) throw new Error("jt.e_big_endian");
  r.i32(); // campo vuoto
  const toc = F.v10 ? r.u64n() : r.i32();
  const lsgId = r.guid();
  // indice dei segmenti
  r.p = toc;
  const n = r.i32();
  F.segs = new Map();
  for (let i = 0; i < n; i++) {
    const id = r.guid();
    const off = F.v10 ? r.u64n() : r.i32();
    const len = F.v10 ? r.u32() : r.i32();
    const attr = r.u32();
    F.segs.set(id, { off, len, type: attr >>> 24 });
  }
  const types = new Set([...F.segs.values()].map(s => s.type));
  for (const t of types) if (SEG_NAMES[t]) warn(ctx, "jt.w_segmento", SEG_NAMES[t]);
  const lsg = F.segs.get(lsgId);
  if (!lsg) throw new Error("jt.e_lsg");
  const els = await segmentReader(F, lsg);
  const g = readLSG(F, els, ctx);
  ctx.progress(0.25, "Struttura dell'assieme letta");
  const tree = await buildTree(F, g, name, ctx);
  tree.versione = `${m[1]}.${m[2]}`;
  return tree;
}

// Restituisce un Reader posizionato sui dati del segmento (decompressi se serve)
async function segmentReader(F, seg) {
  const r = new Reader(F.bytes, seg.off, seg.off + seg.len);
  r.guid(); r.i32(); r.i32(); // intestazione del segmento: id, tipo, lunghezza
  const zlibType = [1, 2, 3, 4, 17, 18, 20, 24].includes(seg.type) || seg.type > 24;
  if (zlibType) {
    const flag = r.i32(), clen = r.i32(), alg = r.u8_();
    const data = F.bytes.subarray(r.p, r.p + clen - 1);
    if (flag === 2 && alg === 2) return new Reader(await inflate(data));
    if (alg === 3 || flag === 3) return new Reader(xzDecode(data));
    if (alg === 1 || flag !== 2) return new Reader(F.bytes, r.p, seg.off + seg.len);
    throw new Error("JT: compressione dei segmenti non supportata (" + alg + ")");
  }
  return r;
}

// legge l'intestazione di un elemento: lunghezza, tipo, tipo base; null alla fine della lista
function elementHeader(r) {
  if (r.p + 4 > r.end) return null;
  const len = r.i32();
  const start = r.p;
  const guid = r.guid();
  const t = guid.slice(0, 8);
  if (t === T.END) { r.p = start + len; return { end: true }; }
  const base = r.u8_();
  return { len, start, next: start + len, t, base };
}

// numeri di versione locali: assenti nei JT 8, I16 nei 9, U8 nei 10
const ver = (F, r) => (F.v10 ? r.u8_() : F.v9 ? r.i16() : 0);

function readLSG(F, r, ctx) {
  const nodes = new Map(), attrs = new Map(), atoms = new Map(), props = new Map();
  let rootId = null;
  // 1) elementi del grafo
  for (;;) {
    const h = elementHeader(r);
    if (!h || h.end) break;
    try {
      const id = r.i32();
      if (rootId === null) rootId = id;
      if (h.base === 3 || h.t === T.MATERIAL || h.t === T.XFORM) attrs.set(id, readAttribute(F, r, h));
      else nodes.set(id, readNode(F, r, h));
    } catch (e) { warn(ctx, "jt.w_elemento", e.message); }
    r.p = h.next;
  }
  // 2) proprieta' (atomi chiave/valore)
  for (;;) {
    const h = elementHeader(r);
    if (!h || h.end) break;
    try {
      const id = r.i32();
      atoms.set(id, readAtom(F, r, h));
    } catch { /* atomo illeggibile: si salta */ }
    r.p = h.next;
  }
  // 3) tabella delle proprieta': oggetto -> [chiave, valore]...
  try {
    r.i16(); // versione della tabella (I16 in tutte le versioni)
    const n = r.i32();
    for (let i = 0; i < n; i++) {
      const oid = r.i32();
      const list = [];
      for (;;) {
        const k = r.i32();
        if (k === 0) break;
        const v = r.i32();
        list.push([atoms.get(k), atoms.get(v)]);
      }
      props.set(oid, list);
    }
  } catch (e) { warn(ctx, "jt.w_proprieta", e.message); }
  return { nodes, attrs, atoms, props, rootId };
}

function readNode(F, r, h) {
  const node = { t: h.t, base: h.base, attrs: [], kids: [] };
  // Base Node Data
  ver(F, r);
  node.flags = r.u32();
  const na = r.i32();
  for (let i = 0; i < na; i++) node.attrs.push(r.i32());
  if (h.t === T.INSTANCE) { ver(F, r); node.kids.push(r.i32()); return node; }
  if (h.base === 1 || [T.PARTITION, T.GROUP, T.PART, T.META, T.LOD, T.RANGELOD, T.SWITCH].includes(h.t)) {
    ver(F, r);
    const nc = r.i32();
    for (let i = 0; i < nc; i++) node.kids.push(r.i32());
    if (h.t === T.PARTITION) { if (F.v10) r.u8_(); r.i32(); node.file = r.mbstr(); }
    else if (h.t === T.SWITCH) { ver(F, r); node.selected = r.i32(); }
  }
  return node;
}

function readAttribute(F, r, h) {
  // Base Attribute Data
  ver(F, r);
  const state = r.u8_();
  r.u32(); // campi esclusi dall'accumulo
  if (F.v10) r.u32(); // campi "finali"
  const a = { t: h.t, final: !!(state & 1), ignore: !!(state & 4) };
  if (h.t === T.MATERIAL) {
    const v = ver(F, r);
    const flags = r.u16();
    const pattern = (!F.v9 || v === 1) && (flags & 1);
    const col = () => [r.f32(), r.f32(), r.f32(), r.f32()];
    if (pattern && (flags & 2)) r.f32(); else col(); // ambiente
    a.color = col(); // diffuso + alfa
  } else if (h.t === T.XFORM) {
    ver(F, r);
    let mask = r.u16();
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    // valori F32 (specifica) oppure F64 (molti file 9.x e 10.x): si capisce dalla lunghezza dell'elemento
    const f64 = h.len - (r.p - h.start) >= 8 * popcount(mask);
    for (let i = 0; i < 16; i++, mask <<= 1) if (mask & 0x8000) m[i] = f64 ? r.f64() : r.f32();
    a.matrix = m; // riga per riga con la traslazione in fondo = ordine per colonne di three.js
  }
  return a;
}
function popcount(v) { let c = 0; for (; v; v &= v - 1) c++; return c; }

function readAtom(F, r, h) {
  if (F.v9) ver(F, r);
  r.u32(); // flag di stato
  switch (h.t) {
    case T.P_STRING: ver(F, r); return r.mbstr();
    case T.P_INT: ver(F, r); return r.i32();
    case T.P_FLOAT: ver(F, r); return +r.f32().toPrecision(7);
    case T.P_REF: ver(F, r); return { ref: r.i32() };
    case T.P_DATE: { ver(F, r); const y = r.i16(), mo = r.i16(), d = r.i16(), hh = r.i16(), mi = r.i16(), s = r.i16(); return dateStr(y, mo, d, hh, mi, s); }
    case T.P_LATE: { ver(F, r); const seg = r.guid(); const type = r.i32(); return { late: seg, type }; }
    case T.P_VEC4: { ver(F, r); return [r.f32(), r.f32(), r.f32(), r.f32()].map(v => +v.toPrecision(6)).join(" "); }
    default: return null;
  }
}

// ---------------------------------------------------------------- albero della scena
async function buildTree(F, g, fileName, ctx) {
  const propsOf = id => {
    const out = {};
    let late = null, meta = null;
    for (const [k, v] of g.props.get(id) || []) {
      if (typeof k !== "string") continue;
      if (v && typeof v === "object" && v.late) {
        if (k === "JT_LLPROP_SHAPEIMPL") late = v;
        else if (k === "JT_LLPROP_METADATA") meta = v;
        continue;
      }
      if (v === null || v === undefined || (typeof v === "object" && !Array.isArray(v))) continue;
      out[k] = v;
    }
    return { out, late, meta };
  };
  const shapeTotal = [...g.nodes.values()].filter(n => SHAPES.has(n.t)).length || 1;
  let shapeDone = 0;
  const visiting = new Set();

  async function visit(id, depth) {
    const n = g.nodes.get(id);
    if (!n || depth > 200 || visiting.has(id)) return null;
    if (n.flags & 1) return null; // nodo da ignorare
    visiting.add(id);
    const { out: props, late, meta } = propsOf(id);
    const item = { name: "", kind: kindOf(n.t), props, kids: [], mesh: [] };
    for (const aid of n.attrs) {
      const a = g.attrs.get(aid);
      if (!a || a.ignore) continue;
      if (a.color) item.c = a.color;
      if (a.matrix && !isIdentity(a.matrix)) item.m = a.matrix;
    }
    if (meta) {
      try { Object.assign(props, await readMetadata(F, meta.late)); } catch (e) { warn(ctx, "jt.w_metadati", e.message); }
    }
    item.name = cleanName(props.JT_PROP_NAME) || (n.t === T.PARTITION && n.file ? n.file.replace(/^.*[\\/]/, "") : "") || "";
    if (SHAPES.has(n.t)) {
      shapeDone++;
      if (late && (n.t === T.TRISTRIP || n.t === T.POLYGON)) {
        try {
          const mi = await loadShape(F, late.late, ctx);
          if (mi >= 0) item.mesh.push(mi);
        } catch (e) { warn(ctx, "jt.w_geometria", e.message); }
      } else if (n.t !== T.NULLSHAPE && n.t !== T.TRISTRIP) {
        warn(ctx, { [T.POLYLINE]: "jt.w_linee", [T.POINTSET]: "jt.w_punti", [T.PRIMSET]: "jt.w_primitive" }[n.t] || "jt.w_forme");
      }
      if (shapeDone % 20 === 0) ctx.progress(0.25 + 0.7 * shapeDone / shapeTotal, `Geometria: ${shapeDone} di ${shapeTotal} forme`);
    }
    let kids = n.kids;
    if (n.t === T.LOD || n.t === T.RANGELOD) kids = kids.slice(0, 1); // il livello di dettaglio piu' fine
    else if (n.t === T.SWITCH) kids = n.selected >= 0 && n.selected < kids.length ? [kids[n.selected]] : [];
    for (const k of kids) {
      const c = await visit(k, depth + 1);
      if (c) item.kids.push(c);
    }
    // partizione in un file esterno (assiemi "spezzati" in piu' JT)
    if (n.t === T.PARTITION && !item.kids.length && n.file && ctx.readExternal && ctx.depth < 8) {
      try {
        const ext = await ctx.readExternal(n.file);
        if (ext) {
          const sub = await parseFile(ext, n.file.replace(/^.*[\\/]/, ""), { ...ctx, depth: ctx.depth + 1 });
          item.kids.push(sub);
        } else warn(ctx, "jt.w_esterno_mancante", n.file);
      } catch (e) { warn(ctx, "jt.w_esterno_errore", n.file, e.message); }
    }
    visiting.delete(id);
    // gruppi intermedi senza nome, proprieta' ne' attributi: si sale di un livello
    return item;
  }
  const root = await visit(g.rootId, 0) || { name: fileName, kind: "assembly", props: {}, kids: [], mesh: [] };
  if (!root.name) root.name = fileName;
  return simplify(root);
}

// I nodi senza nome e senza trasformazione (forme, gruppi e livelli di dettaglio interni) si fondono nel genitore:
// l'albero mostra assiemi e parti come nel CAD; il colore proprio di ogni forma resta (mc = colore per mesh).
function simplify(it) {
  it.kids = it.kids.map(simplify).filter(k => k.kids.length || k.mesh.length);
  const kids = [];
  for (const k of it.kids) {
    if (k.name || k.m) { kids.push(k); continue; }
    k.mesh.forEach((mi, j) => { it.mesh.push(mi); (it.mc ??= []).length = it.mesh.length - 1; it.mc.push((k.mc && k.mc[j]) || k.c || null); });
    for (const g of k.kids) { if (!g.c && k.c) g.c = k.c; kids.push(g); }
  }
  it.kids = kids;
  return it;
}

const isIdentity = m => m.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-12);
function cleanName(s) {
  if (typeof s !== "string" || !s) return "";
  return s.replace(/;[^;]*;[^;]*:?$/, "").replace(/;\d*$/, "").trim();
}
// tipo del nodo (codice: il nome leggibile lo traduce il visualizzatore, chiavi jt.k_*)
function kindOf(t) {
  return { [T.PARTITION]: "partition", [T.PART]: "part", [T.INSTANCE]: "instance", [T.META]: "assembly", [T.LOD]: "lod",
    [T.RANGELOD]: "lod", [T.SWITCH]: "switch", [T.GROUP]: "group" }[t] || (SHAPES.has(t) ? "shape" : "node");
}
// avvisi come [chiave, argomenti...] (tradotti nell'interfaccia), senza ripetizioni
function warn(ctx, key, ...args) { ctx.warnings.add(JSON.stringify([key, ...args])); }
const code = (key, ...args) => JSON.stringify([key, ...args]);
const dateStr = (y, mo, d, h, mi, s) => `${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")} ${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:${String(s).padStart(2, "0")}`;

async function readMetadata(F, segId) {
  const seg = F.segs.get(segId);
  if (!seg) return {};
  const r = await segmentReader(F, seg);
  const out = {};
  for (;;) {
    const h = elementHeader(r);
    if (!h || h.end) break;
    if (h.t === T.PROXY) {
      if (F.v9) { r.i32(); ver(F, r); } // id dell'oggetto e versione (assenti nei JT 8)
      for (let k = 0; k < 2000 && r.p < h.next; k++) {
        const key = r.mbstr();
        if (!key) break;
        const tp = r.u8_();
        let v = null;
        if (tp === 1) v = r.mbstr();
        else if (tp === 2) v = r.i32();
        else if (tp === 3) v = +r.f32().toPrecision(7);
        else if (tp === 4) { const y = r.i16(), mo = r.i16(), d = r.i16(), hh = r.i16(), mi = r.i16(), s = r.i16(); v = dateStr(y, mo, d, hh, mi, s); }
        if (v !== null && v !== "") out[key] = v;
      }
    }
    r.p = h.next;
  }
  return out;
}

// ---------------------------------------------------------------- geometria (Shape LOD)
async function loadShape(F, segId, ctx) {
  if (ctx.meshBySeg.has(F.bytes) && ctx.meshBySeg.get(F.bytes).has(segId)) return ctx.meshBySeg.get(F.bytes).get(segId);
  if (!ctx.meshBySeg.has(F.bytes)) ctx.meshBySeg.set(F.bytes, new Map());
  const cache = ctx.meshBySeg.get(F.bytes);
  const seg = F.segs.get(segId);
  let mi = -1;
  if (seg) {
    const r = await segmentReader(F, seg);
    const h = elementHeader(r);
    if (h && !h.end) {
      let mesh = null;
      if (h.t === T.LOD_TRISTRIP || h.t === T.LOD_POLYGON) mesh = F.v9 ? readTopoLOD(F, r, h, ctx) : readV8LOD(F, r, h, ctx);
      if (mesh && mesh.i.length) { mi = ctx.meshes.length; ctx.meshes.push(mesh); }
    }
  }
  cache.set(segId, mi);
  return mi;
}

// ---- JT 8: strisce di triangoli (Vertex Based Shape Compressed Rep Data)
function readV8LOD(F, r, h, ctx) {
  r.i16(); r.i32(); r.skip(4); // Vertex Shape LOD Data: versione, binding, quantizzazione
  r.i16(); // versione Tri-Strip
  r.i16();
  const nb = r.u8_(), tb = r.u8_(), cb = r.u8_();
  const q = { v: r.u8_(), n: r.u8_(), t: r.u8_(), c: r.u8_() };
  const prim = readCDP1(r, PRED.Stride1);
  let pos, nrm = null, nverts;
  if (q.v === 0) {
    // senza perdita: dati per vertice interlacciati, compressi con zlib
    const usize = r.i32(), csize = r.i32();
    let raw;
    if (csize > 0) raw = inflateSync(r.u8.subarray(r.p, r.p + csize));
    else raw = r.u8.subarray(r.p, r.p + Math.abs(csize));
    r.p += Math.abs(csize);
    void usize;
    const f = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + (raw.length & ~3)));
    const stride = (tb ? 2 : 0) + (cb ? 3 : 0) + (nb ? 3 : 0) + 3;
    nverts = Math.floor(f.length / stride);
    pos = new Float32Array(nverts * 3);
    if (nb === 1) nrm = new Float32Array(nverts * 3);
    const no = (tb ? 2 : 0) + (cb ? 3 : 0), po = no + (nb ? 3 : 0);
    for (let i = 0; i < nverts; i++) {
      pos.set(f.subarray(i * stride + po, i * stride + po + 3), i * 3);
      if (nrm) nrm.set(f.subarray(i * stride + no, i * stride + no + 3), i * 3);
    }
    return stripsToMesh(prim, null, pos, nrm);
  }
  // con perdita: vettori unici quantizzati + indici
  const uq = [];
  for (let k = 0; k < 3; k++) uq.push({ min: r.f32(), max: r.f32(), bits: r.u8_() });
  const nu = r.i32();
  const codes = [readCDP1(r, PRED.Lag1), readCDP1(r, PRED.Lag1), readCDP1(r, PRED.Lag1)];
  const upos = new Float32Array(nu * 3);
  for (let k = 0; k < 3; k++) dequant(codes[k], uq[k], upos, k, 3, nu);
  let unrm = null;
  if (nb) {
    const bits = r.u8_(), nn = r.i32();
    const s = readCDP1(r, PRED.Lag1), o = readCDP1(r, PRED.Lag1), th = readCDP1(r, PRED.Lag1), ps = readCDP1(r, PRED.Lag1);
    unrm = new Float32Array(nn * 3);
    for (let i = 0; i < nn; i++) deeringNormal(s[i], o[i], th[i], ps[i], bits, unrm, i * 3);
    if (nb !== 1) unrm = null;
  }
  if (tb) {
    r.u8_();
    const tq = [{ min: r.f32(), max: r.f32(), bits: r.u8_() }, { min: r.f32(), max: r.f32(), bits: r.u8_() }];
    void tq;
    readCDP1(r, PRED.Lag1); readCDP1(r, PRED.Lag1);
  }
  if (cb) {
    r.u8_(); r.u8_();
    const hsv = r.u8_();
    if (hsv) r.skip(4); else r.skip(4 * 9);
    const arrays = r.u8_();
    if (arrays) for (let k = 0; k < 4; k++) readCDP1(r, PRED.Lag1); else readCDP1(r, PRED.NULL);
  }
  const vidx = readCDP1(r, PRED.StripIndex);
  void ctx;
  return stripsToMesh(prim, vidx, upos, unrm);
}

let _zlibSync = null;
function inflateSync(u8) {
  // zlib sincrono minimale (inflate RFC 1950/1951) per i vertici senza perdita dei JT 8
  if (!_zlibSync) _zlibSync = makeInflate();
  return _zlibSync(u8);
}

function dequant(codes, q, out, comp, stride, n) {
  const maxCode = q.bits < 32 ? (2 ** q.bits) - 1 : 0xffffffff;
  const scale = maxCode ? (q.max - q.min) / maxCode : 0;
  for (let i = 0; i < n && i < codes.length; i++) out[i * stride + comp] = q.min + (codes[i] >>> 0) * scale;
}

// strisce (OpenGL) -> triangoli indicizzati; vidx = indice del vertice unico per ogni vertice grezzo
function stripsToMesh(prim, vidx, pos, nrm) {
  const tris = [];
  for (let s = 0; s + 1 < prim.length; s++) {
    const a = prim[s], b = prim[s + 1];
    for (let k = a; k + 2 < b; k++) {
      const i0 = vidx ? vidx[k] : k, i1 = vidx ? vidx[k + 1] : k + 1, i2 = vidx ? vidx[k + 2] : k + 2;
      if (i0 === i1 || i1 === i2 || i0 === i2) continue;
      if ((k - a) & 1) tris.push(i1, i0, i2); else tris.push(i0, i1, i2);
    }
  }
  return { p: pos, n: nrm && nrm.length === pos.length ? nrm : null, i: Uint32Array.from(tris) };
}

// ---- JT 9 e 10: mesh a compressione topologica (Topologically Compressed Rep Data + Appendice E)
function readTopoLOD(F, r, h, ctx) {
  const V = () => (F.v10 ? r.u8_() : r.i16());
  r.i32(); // id dell'oggetto
  V(); V(); // Base Shape LOD Data, Vertex Shape LOD Data
  r.u64(); // binding dei vertici
  if (F.v10) {
    // intestazione di elemento incorporata (lunghezza + GUID + tipo base + id)
    const save = r.p;
    const len = r.i32(), g = r.guid();
    if (!(len > 0 && /^[0-9a-f]{8}-/.test(g) && g.slice(0, 8) !== "00000000")) r.p = save; else { r.u8_(); r.i32(); }
    r.u8_(); r.u8_(); r.u32(); // versioni + id dei record dei vertici
  } else {
    r.i16(); r.i32(); r.i16(); // TopoMesh LOD Data (versione, id) + versione
  }
  const v10 = F.v10, C = p => readCDP2(r, p, v10);
  const deg = []; for (let i = 0; i < 8; i++) deg.push(C(PRED.NULL));
  const val = C(PRED.NULL), grp = C(PRED.NULL), vflags = C(PRED.Lag1);
  const masks = [];
  for (let i = 0; i < 8; i++) masks.push(C(PRED.NULL));
  let m8hi, m8top = null;
  if (v10) m8hi = C(PRED.NULL);
  else { m8hi = C(PRED.NULL); m8top = C(PRED.NULL); }
  const big = r.vecU32();
  const splitFace = C(PRED.Lag1), splitPos = C(PRED.NULL);
  r.u32(); // hash
  const vr = readVertexRecords(F, r, ctx);
  const dual = decodeDualMesh({ deg, val, grp, vflags, masks, m8hi, m8top, v10, big, splitFace, splitPos });
  return dualToMesh(dual, vr);
}

function readVertexRecords(F, r) {
  const bind = r.u64();
  const lo = bind.lo;
  r.skip(4); // parametri di quantizzazione
  const nTopo = r.i32();
  const out = { nTopo, pos: null, nrm: null, nAttr: 0 };
  if (nTopo <= 0) return out;
  out.nAttr = r.i32();
  const C = p => readCDP2(r, p, F.v10);
  if (lo & 0x7) out.pos = readCoordArray(r, C, F.v10);
  if (lo & 0x8) out.nrm = readNormalArray(r, C, F.v10);
  if (lo & 0x30) readColorArray(r, C);
  for (let t = 0; t < 8; t++) {
    const tb = t < 6 ? (lo >>> (8 + t * 4)) & 0xf : (bind.hi >>> ((t - 6) * 4)) & 0xf;
    if (tb) readTexArray(r, C);
  }
  if (lo & 0x40) { r.i32(); C(PRED.NULL); }
  return out;
}

function readCoordArray(r, C, v10) {
  const n = r.i32(), nc = r.u8_();
  const q = [];
  for (let k = 0; k < 3; k++) q.push({ min: r.f32(), max: r.f32(), bits: r.u8_() });
  const out = new Float32Array(n * 3);
  if (q[0].bits === 0 && v10) {
    // JT 10: i bit IEEE-754 di ogni componente, trattati come interi (predittore Lag1)
    for (let k = 0; k < nc; k++) { const b = C(PRED.Lag1); if (k < 3) bitsToF32(b, out, k, 3, n); }
  } else if (q[0].bits === 0) {
    for (let k = 0; k < nc; k++) {
      const ex = C(PRED.Lag1), ma = C(PRED.Lag1);
      if (k < 3) assembleF32(ex, ma, out, k, 3, n);
    }
  } else {
    for (let k = 0; k < nc; k++) { const c = C(PRED.Lag1); if (k < 3) dequant(c, q[k], out, k, 3, n); }
  }
  r.i32(); // hash
  return out;
}
const _fi = new DataView(new ArrayBuffer(4));
function assembleF32(ex, ma, out, comp, stride, n) {
  for (let i = 0; i < n && i < ex.length; i++) { _fi.setUint32(0, ((ex[i] << 23) | ma[i]) >>> 0); out[i * stride + comp] = _fi.getFloat32(0); }
}
function bitsToF32(b, out, comp, stride, n) {
  for (let i = 0; i < n && i < b.length; i++) { _fi.setInt32(0, b[i]); out[i * stride + comp] = _fi.getFloat32(0); }
}
function readNormalArray(r, C, v10) {
  const n = r.i32(), nc = r.u8_(), qb = r.u8_();
  const out = new Float32Array(n * 3);
  if (v10) {
    // JT 10: bit IEEE delle componenti, oppure un solo codice di Deering per normale [sestante|ottante|theta|psi]
    if (qb === 0) for (let k = 0; k < nc; k++) { const b = C(PRED.Lag1); if (k < 3) bitsToF32(b, out, k, 3, n); }
    else {
      const codes = C(PRED.NULL), mask = (1 << qb) - 1;
      for (let i = 0; i < n && i < codes.length; i++) {
        const c = codes[i] >>> 0;
        deeringNormal((c >>> (2 * qb + 3)) & 7, (c >>> (2 * qb)) & 7, (c >>> qb) & mask, c & mask, qb, out, i * 3);
      }
    }
    r.i32();
    return out;
  }
  if (qb === 0) {
    for (let k = 0; k < nc; k++) { const ex = C(PRED.NULL), ma = C(PRED.NULL); if (k < 3) assembleF32(ex, ma, out, k, 3, n); }
  } else {
    const s = C(PRED.NULL), o = C(PRED.NULL), th = C(PRED.NULL), ps = C(PRED.NULL);
    const bits = qb > 13 ? (qb - 6) >> 1 : qb;
    for (let i = 0; i < n; i++) deeringNormal(s[i], o[i], th[i], ps[i], bits, out, i * 3);
  }
  r.i32();
  return out;
}
function readColorArray(r, C) {
  r.i32(); const nc = r.u8_(), qb = r.u8_();
  if (qb === 0) for (let k = 0; k < nc; k++) { C(PRED.NULL); C(PRED.NULL); }
  else {
    const hsv = r.u8_();
    if (hsv) r.skip(4); else r.skip(4 * 9);
    for (let k = 0; k < nc; k++) C(PRED.Lag1);
  }
  r.i32();
}
function readTexArray(r, C) {
  r.i32(); const nc = r.u8_(), qb = r.u8_();
  if (qb === 0) for (let k = 0; k < nc; k++) { C(PRED.NULL); C(PRED.NULL); }
  else { r.skip(9 * nc); for (let k = 0; k < nc; k++) C(PRED.Lag1); }
  r.i32();
}

// Ricostruzione della mesh duale (Appendice E: MeshCodec / MeshDecoder), scritta in forma compatta
function decodeDualMesh(S) {
  const vVal = [], vFaces = [], vFlag = [], vGrp = [];
  const fDeg = [], fVerts = [], fEmpty = [], fAttrStart = [], fMask = [];
  let attrCtr = 0;
  const degPos = new Int32Array(8), maskPos = new Int32Array(8);
  let valPos = 0, bigPos = 0, sfPos = 0, spPos = 0;
  const active = [], removed = new Set();

  const newVtx = () => {
    if (valPos >= S.val.length) return -1;
    const v = vVal.length, val = S.val[valPos];
    vVal.push(val); vFaces.push(new Int32Array(val).fill(-1));
    vGrp.push(S.grp[valPos] ?? 0); vFlag.push(S.vflags[valPos] ?? 0);
    valPos++;
    return v;
  };
  const maskOf = (ctx, deg) => {
    if (deg > 64) {
      const nw = (deg + 31) >> 5, words = S.big.subarray(bigPos, bigPos + nw); bigPos += nw;
      return { big: words };
    }
    const i = maskPos[ctx]++;
    let lo = S.masks[ctx][i] >>> 0, hi = 0;
    if (ctx === 7) {
      if (S.v10) hi = (S.m8hi[i] ?? 0) >>> 0;
      else {
        const mid = (S.m8hi[i] ?? 0) >>> 0, top = (S.m8top?.[i] ?? 0) >>> 0;
        // 30 bit bassi + 30 successivi + 4 piu' alti
        const lo30 = lo & 0x3fffffff;
        lo = (lo30 | ((mid & 0x3) << 30)) >>> 0;
        hi = ((mid >>> 2) | ((top & 0xf) << 28)) >>> 0;
      }
    }
    return { lo, hi };
  };
  const bitOf = (mk, i) => (mk.big ? (mk.big[i >> 5] >>> (i & 31)) & 1 : i < 32 ? (mk.lo >>> i) & 1 : (mk.hi >>> (i - 32)) & 1);
  const faceCtx = v => {
    const val = vVal[v], fs = vFaces[v];
    let known = 0, tot = 0;
    for (let i = 0; i < val; i++) { const f = fs[i]; if (f >= 0) { known++; tot += fDeg[f]; } }
    if (val === 3) return tot < known * 6 ? 0 : tot === known * 6 ? 1 : 2;
    if (val === 4) return tot < known * 4 ? 3 : tot === known * 4 ? 4 : 5;
    return val === 5 ? 6 : 7;
  };
  const newFace = v => {
    const ctx = faceCtx(v);
    const sym = S.deg[ctx][degPos[ctx]++];
    if (sym === undefined) return -2;
    if (sym === 0) return -1;
    const f = fDeg.length, deg = sym;
    const mk = maskOf(Math.min(7, Math.max(0, deg - 2)), deg);
    let na = 0;
    for (let i = 0; i < deg; i++) na += bitOf(mk, i);
    fDeg.push(deg); fVerts.push(new Int32Array(deg).fill(-1)); fEmpty.push(deg); fMask.push(mk);
    fAttrStart.push(attrCtr); attrCtr += Math.min(na, deg);
    return f;
  };
  const setFaceVtx = (f, slot, v) => { const a = fVerts[f]; if (a[slot] !== v) { if (a[slot] === -1) fEmpty[f]--; a[slot] = v; } };
  const findVtxSlot = (f, v) => fVerts[f].indexOf(v);
  const findFaceSlot = (v, f) => vFaces[v].indexOf(f);
  const inc = (x, n) => (x + 1 === n ? 0 : x + 1), dec = (x, n) => (x === 0 ? n - 1 : x - 1);

  const addVtxToFace = (v, vs, f, fs) => {
    const d = fDeg[f];
    const cw = dec(fs, d), ccw = inc(fs, d);
    setFaceVtx(f, fs, v);
    const fp = fVerts[f][cw];
    if (fp !== -1) {
      let ip = findFaceSlot(fp, f);
      const s = inc(vs, vVal[v]);
      if (vFaces[v][s] === -1 && ip >= 0) { ip = dec(ip, vVal[fp]); vFaces[v][s] = vFaces[fp][ip]; }
    }
    const fn = fVerts[f][ccw];
    if (fn !== -1) {
      let ip = findFaceSlot(fn, f);
      const s = dec(vs, vVal[v]);
      if (vFaces[v][s] === -1 && ip >= 0) { ip = inc(ip, vVal[fn]); vFaces[v][s] = vFaces[fn][ip]; }
    }
  };
  const activateF = (v, vs) => {
    const f = newFace(v);
    if (f >= 0) { vFaces[v][vs] = f; setFaceVtx(f, 0, v); active.push(f); return f; }
    if (f === -1) {
      const off = S.splitFace[sfPos++], pos = S.splitPos[spPos++];
      const sf = active[active.length - off];
      if (sf === undefined || pos === undefined) throw new Error("dati topologici incoerenti");
      vFaces[v][vs] = sf;
      addVtxToFace(v, vs, sf, pos);
      return sf;
    }
    throw new Error("dati topologici terminati");
  };
  const activateV = (f, fs) => {
    const v = newVtx();
    if (v < 0) throw new Error("dati topologici terminati");
    vFaces[v][0] = f;
    addVtxToFace(v, 0, f, fs);
    return v;
  };
  const completeV = (v, vs) => {
    const val = vVal[v];
    let vp = vFaces[v][0], jp = vs, i = 1, vn;
    while ((vn = vFaces[v][i]) !== -1) {
      jp = dec(jp, fDeg[vp]);
      const v2 = fVerts[vp][jp];
      if (v2 === -1) break;
      let jn = findVtxSlot(vn, v2);
      if (jn < 0) break;
      jn = dec(jn, fDeg[vn]);
      addVtxToFace(v, i, vn, jn);
      vp = vn; jp = jn; i++;
      if (i >= val) return;
    }
    const ilast = i;
    vp = vFaces[v][0]; jp = vs; i = val - 1;
    while ((vn = vFaces[v][i]) !== -1) {
      jp = inc(jp, fDeg[vp]);
      const v2 = fVerts[vp][jp];
      if (v2 === -1) break;
      let jn = findVtxSlot(vn, v2);
      if (jn < 0) break;
      jn = inc(jn, fDeg[vn]);
      addVtxToFace(v, i, vn, jn);
      vp = vn; jp = jn; i--;
      if (i < ilast) return;
    }
    for (let k = ilast; k <= i; k++) activateF(v, k);
  };
  const completeF = f => {
    let slot;
    while ((slot = fVerts[f].indexOf(-1)) !== -1) {
      const v = activateV(f, slot);
      completeV(v, slot);
    }
  };
  const nextActive = () => {
    while (active.length && removed.has(active[active.length - 1])) active.pop();
    let best = -1, low = Infinity;
    for (let i = active.length - 1; i >= Math.max(0, active.length - 16); i--) {
      const f = active[i];
      if (removed.has(f)) { active.splice(i, 1); continue; }
      if (fEmpty[f] < low) { low = fEmpty[f]; best = f; }
    }
    return best;
  };
  for (let guard = 0; guard < 1e7; guard++) {
    const v = newVtx();
    if (v < 0) break;
    for (let i = 0; i < vVal[v]; i++) activateF(v, i);
    let f;
    while ((f = nextActive()) !== -1) { completeF(f); removed.add(f); }
  }
  return { vVal, vFaces, vFlag, vGrp, fDeg, fVerts, fAttrStart, fMask, bitOf, nAttr: attrCtr };
}

function dualToMesh(D, vr) {
  const nTopo = D.fDeg.length;
  const pos = vr.pos, nrm = vr.nrm;
  const useAttr = !!(nrm && nrm.length / 3 >= D.nAttr && D.nAttr > 0);
  // vertice in uscita: (vertice topologico, record degli attributi)
  const key = new Map();
  const P = [], N = [], I = [];
  const outIndex = (f, v) => {
    let a = -1;
    if (useAttr) {
      const slot = D.fVerts[f].indexOf(v), deg = D.fDeg[f], mk = D.fMask[f];
      // record valido per lo spicchio: il primo bit acceso andando all'indietro (con giro)
      let rank = -1, k = slot;
      for (let s = 0; s < deg; s++) {
        if (D.bitOf(mk, k)) break;
        k = k === 0 ? deg - 1 : k - 1;
      }
      for (let s = 0; s <= k; s++) rank += D.bitOf(mk, s);
      if (rank >= 0) a = D.fAttrStart[f] + rank;
    }
    const kk = f * 4294967296 + (a + 1);
    let o = key.get(kk);
    if (o === undefined) {
      o = P.length / 3;
      key.set(kk, o);
      if (pos && f < nTopo && f * 3 + 2 < pos.length) P.push(pos[f * 3], pos[f * 3 + 1], pos[f * 3 + 2]); else P.push(0, 0, 0);
      if (useAttr && a >= 0) N.push(nrm[a * 3], nrm[a * 3 + 1], nrm[a * 3 + 2]); else if (useAttr) N.push(0, 0, 1);
    }
    return o;
  };
  for (let v = 0; v < D.vVal.length; v++) {
    if (D.vFlag[v] & 1) continue; // faccia di chiusura aggiunta dal codificatore
    const fs = D.vFaces[v], val = D.vVal[v];
    if (val < 3) continue;
    const c0 = outIndex(fs[0], v);
    for (let k = 1; k + 1 < val; k++) {
      if (fs[k] < 0 || fs[k + 1] < 0) continue;
      I.push(c0, outIndex(fs[k], v), outIndex(fs[k + 1], v));
    }
  }
  return { p: Float32Array.from(P), n: useAttr ? Float32Array.from(N) : null, i: Uint32Array.from(I) };
}

// ---------------------------------------------------------------- inflate sincrono (RFC 1950/1951)
function makeInflate() {
  const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const build = lens => {
    const count = new Uint16Array(16), offs = new Uint16Array(16), sym = new Uint16Array(lens.length);
    for (const l of lens) count[l]++;
    count[0] = 0;
    for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
    for (let i = 0; i < lens.length; i++) if (lens[i]) sym[offs[lens[i]]++] = i;
    return { count, sym };
  };
  return src => {
    let p = 2, bitbuf = 0, bitcnt = 0;
    let out = new Uint8Array(src.length * 4 + 1024), op = 0;
    const need = n => { if (op + n > out.length) { const o = new Uint8Array(Math.max(out.length * 2, op + n)); o.set(out); out = o; } };
    const bits = n => { while (bitcnt < n) { bitbuf |= (src[p++] ?? 0) << bitcnt; bitcnt += 8; } const v = bitbuf & ((1 << n) - 1); bitbuf >>>= n; bitcnt -= n; return v; };
    const decode = h => {
      let code = 0, first = 0, index = 0;
      for (let len = 1; len < 16; len++) {
        code |= bits(1);
        const c = h.count[len];
        if (code - c < first) return h.sym[index + (code - first)];
        index += c; first += c; first <<= 1; code <<= 1;
      }
      throw new Error("zlib: codice non valido");
    };
    let fixedL = null, fixedD = null;
    for (;;) {
      const last = bits(1), type = bits(2);
      if (type === 0) {
        bitbuf = 0; bitcnt = 0;
        const len = src[p] | (src[p + 1] << 8); p += 4;
        need(len); out.set(src.subarray(p, p + len), op); op += len; p += len;
      } else {
        let L, Dt;
        if (type === 1) {
          if (!fixedL) { const l = new Array(288); for (let i = 0; i < 288; i++) l[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8; fixedL = build(l); fixedD = build(new Array(30).fill(5)); }
          L = fixedL; Dt = fixedD;
        } else {
          const nl = bits(5) + 257, nd = bits(5) + 1, nc = bits(4) + 4;
          const ord = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
          const cl = new Array(19).fill(0);
          for (let i = 0; i < nc; i++) cl[ord[i]] = bits(3);
          const ch = build(cl);
          const lens = [];
          while (lens.length < nl + nd) {
            const s = decode(ch);
            if (s < 16) lens.push(s);
            else if (s === 16) { const pr = lens[lens.length - 1]; for (let k = bits(2) + 3; k > 0; k--) lens.push(pr); }
            else if (s === 17) for (let k = bits(3) + 3; k > 0; k--) lens.push(0);
            else for (let k = bits(7) + 11; k > 0; k--) lens.push(0);
          }
          L = build(lens.slice(0, nl)); Dt = build(lens.slice(nl));
        }
        for (;;) {
          const s = decode(L);
          if (s < 256) { need(1); out[op++] = s; }
          else if (s === 256) break;
          else {
            const li = s - 257, len = LBASE[li] + bits(LEXT[li]);
            const di = decode(Dt), dist = DBASE[di] + bits(DEXT[di]);
            need(len);
            for (let k = 0; k < len; k++, op++) out[op] = out[op - dist];
          }
        }
      }
      if (last) break;
    }
    return out.subarray(0, op);
  };
}
