// Lettore U3D (Universal 3D, ECMA-363 4a edizione), scritto da zero sulla specifica pubblica: struttura a blocchi
// (cap. 9), lettore di bit con decodifica aritmetica (cap. 10 e implementazione informativa dell'Annex A),
// nodi (gruppo, modello) con trasformazioni, catene di modificatori, ombreggiatura -> shader -> materiale (colore)
// e mesh CLOD (dichiarazione, mesh di base, aggiornamenti progressivi della risoluzione: vedi u3dclod.js).
// Non letti: insiemi di linee e punti, texture, animazioni, luci e viste, superfici NURBS (estensione 4a ed.).
// Uscita come gli altri lettori neutri: { root, meshes, warnings, info }.

// ---------------------------------------------------------------- lettore di bit (Annex A, BitStreamRead)
const STATIC_FULL = 0x400, MAX_RANGE = STATIC_FULL + 0x3fff, ELEPHANT = 0x1fff, MAX_SYM = 0xffff;
const SWAP8 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
const READ_COUNT = [4, 3, 2, 2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0];
const FAST_NOT_MASK = [0xffff, 0x7fff, 0x3fff, 0x1fff, 0x0fff];
const TD8 = new TextDecoder("utf-8");

export class BitReader {
  constructor(u8, off = 0, len = u8.length - off) {
    const n = (len + 3) >> 2;
    this.data = new Uint32Array(n + 2);
    const dv = new DataView(u8.buffer, u8.byteOffset + off, len);
    for (let i = 0; i < n; i++) {
      let w = 0;
      for (let b = 0; b < 4; b++) { const k = i * 4 + b; if (k < len) w |= dv.getUint8(k) << (8 * b); }
      this.data[i] = w >>> 0;
    }
    this.pos = 0; this.bit = 0;
    this.low = 0; this.high = 0xffff; this.underflow = 0;
    this.sym = new Map(); this.cum = new Map(); // istogrammi dei contesti dinamici
  }
  // --- accesso ai bit (dal meno significativo di ogni parola)
  _local() { return this.data[this.pos] >>> 0; }
  _next() { return this.data[this.pos + 1] >>> 0; }
  _adv(n) { this.bit += n; while (this.bit >= 32) { this.bit -= 32; this.pos++; } }
  _readBit() { const v = (this._local() >>> this.bit) & 1; this._adv(1); return v; }
  _read15() {
    let v = this._local() >>> this.bit;
    if (this.bit > 17) v = (v | (this._next() << (32 - this.bit))) >>> 0;
    v = (v + v) >>> 0;
    v = SWAP8[(v >>> 12) & 0xf] | (SWAP8[(v >>> 8) & 0xf] << 4) | (SWAP8[(v >>> 4) & 0xf] << 8) | (SWAP8[v & 0xf] << 12);
    this._adv(15);
    return v;
  }
  // --- istogrammi (ContextManager)
  _dyn(ctx) { return ctx !== 0 && ctx < STATIC_FULL; }
  _total(ctx) { if (this._dyn(ctx)) { const c = this.cum.get(ctx); return c ? c[0] : 1; } return ctx === 0 ? 256 : ctx - STATIC_FULL; }
  _freq(ctx, s) {
    if (!this._dyn(ctx)) return 1;
    const a = this.sym.get(ctx);
    if (a && s < a.length) return a[s];
    return s === 0 ? 1 : 0;
  }
  _cumFreq(ctx, s) {
    if (!this._dyn(ctx)) return s - 1;
    const c = this.cum.get(ctx);
    if (!c) return 0;
    return s < c.length ? c[0] - c[s] : c[0];
  }
  _symFromFreq(ctx, f) {
    if (!this._dyn(ctx)) return f + 1;
    const c = this.cum.get(ctx);
    if (!c || f === 0 || c[0] < f) return 0;
    // ultimo simbolo con frequenza cumulata <= f (c e' decrescente: c[0]-c[i] cresce con i)
    let lo = 0, hi = c.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (c[0] - c[m] <= f) lo = m; else hi = m - 1; }
    return lo;
  }
  _add(ctx, s) {
    if (!this._dyn(ctx) || s >= MAX_SYM) return;
    let c = this.cum.get(ctx), a = this.sym.get(ctx);
    if (!c || c.length <= s) {
      const nc = new Uint16Array(s + 32), na = new Uint16Array(s + 32);
      if (c) { nc.set(c); na.set(a); } else { nc[0] = 1; na[0] = 1; }
      c = nc; a = na;
      this.cum.set(ctx, c); this.sym.set(ctx, a);
    }
    if (c[0] >= ELEPHANT) {
      let acc = 0;
      for (let i = c.length - 1; i >= 0; i--) { a[i] >>= 1; acc += a[i]; c[i] = acc; }
      a[0]++; c[0]++;
    }
    a[s]++;
    for (let i = 0; i <= s; i++) c[i]++;
  }
  // --- decodifica di un simbolo (ReadSymbol)
  _symbol(ctx) {
    const position = this.pos * 32 + this.bit;
    let code = this._readBit();
    this._adv(this.underflow);
    code = ((code << 15) | this._read15()) >>> 0;
    this.pos = position >>> 5; this.bit = position & 31;
    const total = this._total(ctx);
    const range = this.high + 1 - this.low;
    const codeCum = Math.floor((total * (1 + code - this.low) - 1) / range);
    const s = this._symFromFreq(ctx, codeCum);
    const vc = this._cumFreq(ctx, s), vf = this._freq(ctx, s);
    let low = this.low, high = this.low - 1 + Math.floor((range * (vc + vf)) / total);
    low = low + Math.floor((range * vc) / total);
    this._add(ctx, s);
    let bc = READ_COUNT[((low >>> 12) ^ (high >>> 12)) & 0xf];
    low &= FAST_NOT_MASK[bc]; high &= FAST_NOT_MASK[bc];
    high = ((high << bc) | ((1 << bc) - 1)) & 0xffffffff; low = (low << bc) & 0xffffffff;
    let ml = 0x8000 & low, mh = 0x8000 & high;
    while ((ml | mh) === 0 || (ml === 0x8000 && mh === 0x8000)) {
      low = (0x7fff & low) << 1; high = ((0x7fff & high) << 1) | 1;
      ml = 0x8000 & low; mh = 0x8000 & high; bc++;
    }
    const sl = ml, sh = mh;
    if (bc > 0) { bc += this.underflow; this.underflow = 0; }
    ml = 0x4000 & low; mh = 0x4000 & high;
    let uf = 0;
    while (ml === 0x4000 && mh === 0) {
      low &= 0x3fff; high &= 0x3fff;
      low += low; high += high; high |= 1;
      ml = 0x4000 & low; mh = 0x4000 & high; uf++;
    }
    this.underflow += uf;
    this.low = (low | sl) >>> 0; this.high = (high | sh) >>> 0;
    this._adv(bc);
    return s;
  }
  // --- valori
  u8() { let v = this._symbol(0) - 1; v = (SWAP8[v & 0xf] << 4) | SWAP8[(v >> 4) & 0xf]; return v & 0xff; }
  u16() { return this.u8() | (this.u8() << 8); }
  u32() { return (this.u16() | (this.u16() << 16)) >>> 0; }
  i32() { return this.u32() | 0; }
  f32() { _dv.setUint32(0, this.u32(), true); return _dv.getFloat32(0, true); }
  u64() { const lo = this.u32(), hi = this.u32(); return hi * 4294967296 + lo; }
  str() { const n = this.u16(); const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = this.u8(); return TD8.decode(b); }
  cu32(ctx) {
    if (this.nc) return this.u32(); // file senza compressione (profilo 0x4)
    if (ctx !== 0 && ctx < MAX_RANGE) {
      const s = this._symbol(ctx);
      if (s !== 0) return s - 1;
      const v = this.u32(); this._add(ctx, v + 1); return v;
    }
    return this.u32();
  }
  cu16(ctx) {
    if (this.nc) return this.u16(); // file senza compressione (profilo 0x4)
    if (ctx !== 0 && ctx < MAX_RANGE) {
      const s = this._symbol(ctx);
      if (s !== 0) return s - 1;
      const v = this.u16(); this._add(ctx, v + 1); return v;
    }
    return this.u16();
  }
  cu8(ctx) {
    if (this.nc) return this.u8(); // file senza compressione (profilo 0x4)
    if (ctx !== 0 && ctx < MAX_RANGE) {
      const s = this._symbol(ctx);
      if (s !== 0) return s - 1;
      const v = this.u8(); this._add(ctx, v + 1); return v;
    }
    return this.u8();
  }
  // contesto statico per un intervallo 0..r-1 ("rN" nella specifica); r = 0 -> contesto "cZero"
  static range(r) { return STATIC_FULL + r; }
}
const _dv = new DataView(new ArrayBuffer(8));

// ---------------------------------------------------------------- blocchi
const B = {
  HEADER: 0x00443355, FILEREF: 0xffffff12, CHAIN: 0xffffff14, PRIORITY: 0xffffff15, NEWTYPE: 0xffffff16,
  GROUP: 0xffffff21, MODEL: 0xffffff22, LIGHT: 0xffffff23, VIEW: 0xffffff24,
  CLOD_DECL: 0xffffff31, CLOD_BASE: 0xffffff3b, CLOD_PROG: 0xffffff3c, POINTS: 0xffffff36, POINTS_C: 0xffffff3e,
  LINES: 0xffffff37, LINES_C: 0xffffff3f, GLYPH: 0xffffff41, SUBDIV: 0xffffff42, ANIM: 0xffffff43, BONEW: 0xffffff44,
  SHADING: 0xffffff45, CLODMOD: 0xffffff46, LIGHT_R: 0xffffff51, VIEW_R: 0xffffff52, SHADER: 0xffffff53,
  MATERIAL: 0xffffff54, TEXTURE: 0xffffff55, TEXTURE_C: 0xffffff5c, MOTION: 0xffffff56,
};

function* blocks(u8, start, end) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = start;
  while (p + 12 <= end) {
    const type = dv.getUint32(p, true), size = dv.getUint32(p + 4, true), msize = dv.getUint32(p + 8, true);
    const data = p + 12;
    if (data + size > end) break;
    yield { type, data, size };
    p = data + ((size + 3) & ~3) + ((msize + 3) & ~3);
  }
}

export async function parseU3D(bytes, opts = {}) {
  const u8 = bytes;
  if (!(u8[0] === 0x55 && u8[1] === 0x33 && u8[2] === 0x44 && u8[3] === 0)) throw new Error("u3d.e_non_u3d");
  const S = {
    nodes: new Map(), // nome -> { kind, parents: [{ name, m }], resource }
    shading: new Map(), // nome del nodo -> [[nomi shader]...]
    shaders: new Map(), materials: new Map(),
    meshes: new Map(), // nome della risorsa -> stato CLOD
    warnings: new Set(), noCompress: false,
  };
  const progress = opts.progress || (() => {});
  const all = [...blocks(u8, 0, u8.length)];
  let done = 0;
  for (const blk of all) {
    readBlock(u8, blk, S, null);
    if (++done % 50 === 0) progress(0.2 + 0.6 * done / all.length, "u3d");
  }
  return assemble(S, opts.name || "U3D");
}

function readBlock(u8, blk, S, chain) {
  const r = new BitReader(u8, blk.data, blk.size);
  r.nc = S.noCompress;
  try {
    switch (blk.type) {
      case B.HEADER: {
        r.u16(); r.u16(); // versione
        const profile = r.u32();
        S.noCompress = !!(profile & 4);
        break;
      }
      case B.CHAIN: {
        const name = r.str(), type = r.u32(), attrs = r.u32();
        if (attrs & 1) for (let i = 0; i < 4; i++) r.f32();
        if (attrs & 2) for (let i = 0; i < 6; i++) r.f32();
        // allineamento a 4 byte (dall'inizio del blocco), poi i blocchi dei modificatori
        let off = blk.data + r.pos * 4 + ((r.bit + 7) >> 3);
        off = blk.data + ((off - blk.data + 3) & ~3);
        const count = new DataView(u8.buffer, u8.byteOffset).getUint32(off, true);
        let k = 0;
        for (const sub of blocks(u8, off + 4, blk.data + blk.size)) { if (k++ >= count) break; readBlock(u8, sub, S, { name, type }); }
        break;
      }
      case B.GROUP: case B.MODEL: case B.LIGHT: case B.VIEW: {
        const name = r.str();
        const np = r.u32(), parents = [];
        for (let i = 0; i < np; i++) { const pn = r.str(); const m = []; for (let k = 0; k < 16; k++) m.push(r.f32()); parents.push({ name: pn, m }); }
        const node = { kind: blk.type === B.GROUP ? "group" : blk.type === B.MODEL ? "model" : blk.type === B.LIGHT ? "light" : "view", parents };
        if (blk.type === B.MODEL) { node.resource = r.str(); node.visibility = r.u32(); }
        S.nodes.set(name, node);
        break;
      }
      case B.SHADING: {
        const name = r.str(); r.u32(); // indice nella catena
        const attrs = r.u32();
        const nl = r.u32(), lists = [];
        for (let i = 0; i < nl; i++) { const ns = r.u32(), l = []; for (let k = 0; k < ns; k++) l.push(r.str()); lists.push(l); }
        if (attrs & 1 || !attrs) S.shading.set(name, lists);
        break;
      }
      case B.SHADER: {
        const name = r.str(); const attrs = r.u32(); r.f32(); r.u32(); r.u32(); r.u32(); r.u32(); r.u32();
        S.shaders.set(name, { material: r.str(), vertexColor: !!(attrs & 4) });
        break;
      }
      case B.MATERIAL: {
        const name = r.str(); const attrs = r.u32();
        const rgb = () => [r.f32(), r.f32(), r.f32()];
        const amb = rgb(), dif = rgb(); rgb(); const emi = rgb(); r.f32(); const op = r.f32();
        let col = attrs & 2 ? dif : attrs & 1 ? amb : attrs & 8 ? emi : dif;
        if (col.every(v => v <= 0.001) && attrs & 8) col = emi; // solo emissivo (modelli "senza luci")
        S.materials.set(name, [...col, attrs & 0x20 ? op : 1]);
        break;
      }
      case B.CLOD_DECL: case B.CLOD_BASE: case B.CLOD_PROG:
        clod(r, blk.type, S);
        break;
      case B.POINTS: case B.LINES:
        S.warnings.add(JSON.stringify([blk.type === B.POINTS ? "u3d.w_punti" : "u3d.w_linee"]));
        break;
      case B.TEXTURE:
        S.warnings.add(JSON.stringify(["u3d.w_texture"]));
        break;
      case B.NEWTYPE: case B.FILEREF:
        S.warnings.add(JSON.stringify(["u3d.w_estensioni"]));
        break;
      default: break;
    }
  } catch (e) {
    S.warnings.add(JSON.stringify(["u3d.w_blocco", "0x" + (blk.type >>> 0).toString(16), e.message]));
  }
  void chain;
}

// ---------------------------------------------------------------- mesh CLOD
// contesti dinamici (identificativi distinti, come nell'implementazione di riferimento)
const C = {
  shading: 1, diffuseCount: 2, diffuseColorSign: 3, colorDiffR: 4, colorDiffG: 5, colorDiffB: 6, colorDiffA: 7,
  specularCount: 8, specularColorSign: 9, texCoordCount: 10, texCoordSign: 11, texCDiffU: 12, texCDiffV: 13, texCDiffS: 14, texCDiffT: 15,
  faceCnt: 16, faceOrnt: 17, thrdPosType: 18, localThrdPos: 19, normalCnt: 20, diffNormalSign: 21, diffNormalX: 22, diffNormalY: 23,
  diffNormalZ: 24, normalLocalIdx: 25, diffuseKeepChange: 26, diffuseChangeType: 27, diffuseChangeIndexNew: 28, diffuseChangeIndexLocal: 29,
  diffuseChangeIndexGlobal: 30, specularKeepChange: 31, specularChangeType: 32, specularChangeIndexNew: 33, specularChangeIndexLocal: 34,
  specularChangeIndexGlobal: 35, texCoordKeepChange: 36, texCoordChangeType: 37, texCoordChangeIndexNew: 38, texCoordChangeIndexLocal: 39,
  texCoordChangeIndexGlobal: 40, posDiffSign: 41, posDiffX: 42, posDiffY: 43, posDiffZ: 44, colorDup: 45, colorIndexType: 46,
  texCDup: 47, texCIndexType: 48,
};
export { C as U3D_CONTEXTS };

function clod(r, type, S) {
  const name = r.str();
  r.u32(); // indice nella catena
  if (type === B.CLOD_DECL) {
    const attrs = r.u32(), faceCount = r.u32(), posCount = r.u32(), nrmCount = r.u32(), difCount = r.u32(), specCount = r.u32(), texCount = r.u32();
    const ns = r.u32(), shadings = [];
    for (let i = 0; i < ns; i++) {
      const sa = r.u32(), nl = r.u32(), dims = [];
      for (let k = 0; k < nl; k++) dims.push(r.u32());
      r.u32(); // id originale
      shadings.push({ diffuse: !!(sa & 1), specular: !!(sa & 2), layers: nl, dims });
    }
    const minRes = r.u32(), maxRes = r.u32();
    r.u32(); r.u32(); r.u32(); // fattori di qualita'
    const iq = { pos: r.f32(), nrm: r.f32(), tex: r.f32(), dif: r.f32(), spec: r.f32() };
    const crease = r.f32(); r.f32(); r.f32();
    S.meshes.set(name, {
      noNormals: !!(attrs & 1), faceCount, posCount, nrmCount, difCount, specCount, texCount, shadings, minRes, maxRes, iq, crease,
      pos: [], nrm: [], dif: [], spec: [], tex: [], faces: [], resolution: 0, progressiveMissing: maxRes > minRes,
    });
    return;
  }
  const M = S.meshes.get(name);
  if (!M) return;
  if (type === B.CLOD_BASE) {
    const nf = r.u32(), np = r.u32(), nn = r.u32(), nd = r.u32(), nsp = r.u32(), nt = r.u32();
    for (let i = 0; i < np; i++) M.pos.push([r.f32(), r.f32(), r.f32()]);
    for (let i = 0; i < nn; i++) M.nrm.push([r.f32(), r.f32(), r.f32()]);
    for (let i = 0; i < nd; i++) M.dif.push([r.f32(), r.f32(), r.f32(), r.f32()]);
    for (let i = 0; i < nsp; i++) M.spec.push([r.f32(), r.f32(), r.f32(), r.f32()]);
    for (let i = 0; i < nt; i++) M.tex.push([r.f32(), r.f32(), r.f32(), r.f32()]);
    const R = n => BitReader.range(n);
    for (let f = 0; f < nf; f++) {
      const sh = r.cu32(C.shading);
      const sd = M.shadings[sh] || M.shadings[0] || { diffuse: false, specular: false, layers: 0 };
      const corners = [];
      for (let k = 0; k < 3; k++) {
        const c = { p: r.cu32(R(np)) };
        if (!M.noNormals) c.n = r.cu32(R(nn));
        if (sd.diffuse) c.d = r.cu32(R(nd));
        if (sd.specular) c.s = r.cu32(R(nsp));
        for (let l = 0; l < sd.layers; l++) r.cu32(R(nt));
        corners.push(c);
      }
      M.faces.push({ sh, c: corners });
    }
    M.resolution = np;
    M.progressiveMissing = M.maxRes > np;
    return;
  }
  // aggiornamenti progressivi della risoluzione (CLOD Progressive Mesh Continuation)
  if (type === B.CLOD_PROG) {
    if (!M.progressive) M.progressive = 0;
    try {
      // lettore separato (u3dclod.js): ricostruisce le nuove posizioni e facce
      progressiveDecoder(r, M);
      M.progressiveMissing = M.pos.length < M.maxRes;
    } catch (e) {
      S.warnings.add(JSON.stringify(["u3d.w_progressivo", e.message]));
    }
  }
}

// segnaposto sostituito da u3dclod.js al primo uso (import statico per il worker)
let progressiveDecoder = () => { throw new Error("progressivo non disponibile"); };
export function setProgressiveDecoder(fn) { progressiveDecoder = fn; }

// ---------------------------------------------------------------- scena
function assemble(S, fileName) {
  const meshes = [];
  const meshIndex = new Map(); // risorsa -> [{ mesh, shading }]
  const build = (rname, nodeName) => {
    const M = S.meshes.get(rname);
    if (!M || !M.faces.length) return [];
    const key = rname + "\u0000" + nodeName;
    if (meshIndex.has(key)) return meshIndex.get(key);
    // una mesh per elenco di shader (colore), vertici distinti per (posizione, normale, colore)
    const lists = S.shading.get(nodeName) || [];
    const groups = new Map();
    for (const f of M.faces) {
      if (!groups.has(f.sh)) groups.set(f.sh, []);
      groups.get(f.sh).push(f);
    }
    const out = [];
    for (const [sh, faces] of groups) {
      const map = new Map(), P = [], N = [], Cc = [], I = [];
      const useN = !M.noNormals && M.nrm.length;
      const useC = M.shadings[sh]?.diffuse && M.dif.length;
      for (const f of faces) for (const c of f.c) {
        const k = c.p + "|" + (useN ? c.n : "") + "|" + (useC ? c.d : "");
        let o = map.get(k);
        if (o === undefined) {
          o = P.length / 3; map.set(k, o);
          const p = M.pos[c.p] || [0, 0, 0];
          P.push(p[0], p[1], p[2]);
          if (useN) { const n = M.nrm[c.n] || [0, 0, 1]; N.push(n[0], n[1], n[2]); }
          if (useC) { const d = M.dif[c.d] || [1, 1, 1, 1]; Cc.push(d[0], d[1], d[2], d[3]); }
        }
        I.push(o);
      }
      const shader = S.shaders.get((lists[sh] || lists[0] || [])[0]);
      const color = shader ? S.materials.get(shader.material) : null;
      const mi = meshes.length;
      meshes.push({ p: Float32Array.from(P), n: useN ? Float32Array.from(N) : null, c: useC ? Float32Array.from(Cc) : null, i: Uint32Array.from(I) });
      out.push({ mi, color });
    }
    meshIndex.set(key, out);
    return out;
  };
  // albero: i nodi con genitore "" (o assente) stanno sotto la radice; un nodo con piu' genitori compare piu' volte
  const children = new Map();
  for (const [name, n] of S.nodes) {
    const ps = n.parents.length ? n.parents : [{ name: "", m: null }];
    for (const p of ps) {
      const pk = S.nodes.has(p.name) ? p.name : "";
      if (!children.has(pk)) children.set(pk, []);
      children.get(pk).push({ name, m: p.m });
    }
  }
  const visiting = new Set();
  const walk = (name, m, depth) => {
    const n = S.nodes.get(name);
    if (!n || depth > 64 || visiting.has(name)) return null;
    visiting.add(name);
    const item = { name, kind: n.kind === "model" ? "part" : "group", props: {}, kids: [], mesh: [] };
    if (m && !isIdentity(m)) item.m = m;
    if (n.kind === "model" && n.resource) {
      item.props["@risorsa"] = n.resource; // chiave tradotta nel visualizzatore (n3d.p_risorsa)
      const parts = build(n.resource, name);
      if (parts.length === 1) { item.mesh.push(parts[0].mi); if (parts[0].color) item.c = parts[0].color; }
      else for (const p of parts) item.kids.push({ name: name, kind: "shape", props: {}, kids: [], mesh: [p.mi], c: p.color || undefined });
    }
    for (const c of children.get(name) || []) { const k = walk(c.name, c.m, depth + 1); if (k) item.kids.push(k); }
    visiting.delete(name);
    if (n.kind === "light" || n.kind === "view") return item.kids.length ? item : null;
    return item;
  };
  const root = { name: fileName, kind: "assembly", props: {}, kids: [], mesh: [] };
  for (const c of children.get("") || []) { const k = walk(c.name, c.m, 1); if (k) root.kids.push(k); }
  // risorse non usate da nessun nodo (file con sola geometria): mostrate comunque
  const used = new Set([...S.nodes.values()].map(n => n.resource).filter(Boolean));
  for (const rname of S.meshes.keys()) if (!used.has(rname)) for (const p of build(rname, "")) root.kids.push({ name: rname, kind: "part", props: {}, kids: [], mesh: [p.mi], c: p.color || undefined });
  for (const M of S.meshes.values()) if (M.progressiveMissing && M.maxRes > 0) { S.warnings.add(JSON.stringify(["u3d.w_risoluzione"])); break; }
  const tri = meshes.reduce((s, m) => s + m.i.length / 3, 0);
  return { root: prune(root), meshes, warnings: [...S.warnings].map(w => JSON.parse(w)), info: { versione: "ECMA-363", triangoli: tri } };
}

function prune(it) {
  it.kids = it.kids.map(prune).filter(k => k.kids.length || k.mesh.length);
  return it;
}
const isIdentity = m => m.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-9);
