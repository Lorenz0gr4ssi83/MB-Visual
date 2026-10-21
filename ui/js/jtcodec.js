// JT (ISO 14306): decompressione dei segmenti e codec dei dati compressi.
// Scritto da zero sulla specifica pubblica "JT File Format Reference" (v8.1, v9.5, v10.5): sezioni 7.1.3 e 8,
// Appendice C (algoritmi di decodifica). Il decodificatore LZMA2/XZ (segmenti dei JT 10) segue il formato
// pubblico .xz / LZMA (Igor Pavlov, di pubblico dominio).

// ---------------------------------------------------------------- lettore di byte (little endian)
const TD16 = new TextDecoder("utf-16le");
export class Reader {
  constructor(u8, pos = 0, end = u8.length) {
    this.u8 = u8;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.p = pos;
    this.end = end;
  }
  need(n) { if (this.p + n > this.end) throw new Error("JT: dati terminati prima del previsto"); }
  u8_() { this.need(1); return this.u8[this.p++]; }
  i16() { this.need(2); const v = this.dv.getInt16(this.p, true); this.p += 2; return v; }
  u16() { this.need(2); const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
  i32() { this.need(4); const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  u32() { this.need(4); const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  u64() { this.need(8); const lo = this.dv.getUint32(this.p, true), hi = this.dv.getUint32(this.p + 4, true); this.p += 8; return { lo, hi }; }
  u64n() { const { lo, hi } = this.u64(); return hi * 4294967296 + lo; }
  f32() { this.need(4); const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  f64() { this.need(8); const v = this.dv.getFloat64(this.p, true); this.p += 8; return v; }
  guid() {
    this.need(16);
    const d = this.dv, o = this.p;
    const s = d.getUint32(o, true).toString(16).padStart(8, "0") + "-" + d.getUint16(o + 4, true).toString(16).padStart(4, "0") + "-" +
      d.getUint16(o + 6, true).toString(16).padStart(4, "0") + "-" + Array.from(this.u8.subarray(o + 8, o + 16), b => b.toString(16).padStart(2, "0")).join("");
    this.p += 16;
    return s;
  }
  mbstr() {
    const n = this.i32();
    if (n <= 0) return "";
    this.need(n * 2);
    const s = TD16.decode(this.u8.subarray(this.p, this.p + n * 2));
    this.p += n * 2;
    return s.replace(/\0+$/, "");
  }
  str8() { // String: I32 conteggio + byte (versioni con UChar)
    const n = this.i32();
    if (n <= 0) return "";
    this.need(n);
    const s = new TextDecoder("latin1").decode(this.u8.subarray(this.p, this.p + n));
    this.p += n;
    return s.replace(/\0+$/, "");
  }
  vecI32() { const n = this.i32(); this.need(n * 4); const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = this.dv.getInt32(this.p + i * 4, true); this.p += n * 4; return a; }
  vecU32() { const n = this.i32(); this.need(n * 4); const a = new Uint32Array(n); for (let i = 0; i < n; i++) a[i] = this.dv.getUint32(this.p + i * 4, true); this.p += n * 4; return a; }
  vecF32() { const n = this.i32(); this.need(n * 4); const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = this.dv.getFloat32(this.p + i * 4, true); this.p += n * 4; return a; }
  words(n) { this.need(n * 4); const a = new Uint32Array(n); for (let i = 0; i < n; i++) a[i] = this.dv.getUint32(this.p + i * 4, true); this.p += n * 4; return a; }
  skip(n) { this.need(n); this.p += n; }
}

// Bit letti dal flusso di byte, dal bit piu' significativo (tabelle dei contesti di probabilita')
class ByteBits {
  constructor(r) { this.r = r; this.cur = 0; this.left = 0; }
  bits(n) {
    let v = 0;
    while (n > 0) {
      if (this.left === 0) { this.cur = this.r.u8_(); this.left = 8; }
      const take = Math.min(n, this.left);
      v = v * (1 << take) + ((this.cur >>> (this.left - take)) & ((1 << take) - 1));
      this.left -= take;
      n -= take;
    }
    return v;
  }
  signed32() { return this.bits(32) | 0; }
  // il resto dell'ultimo byte letto si scarta da solo ("Alignment Bits")
}

// Bit letti da parole U32 (CodeText), dal bit piu' significativo di ogni parola
class WordBits {
  constructor(words, nbits) { this.w = words; this.n = nbits; this.i = 0; this.cur = 0; this.left = 0; this.read = 0; }
  bit() {
    if (this.left === 0) { this.cur = this.i < this.w.length ? this.w[this.i++] : 0; this.left = 32; }
    this.left--;
    this.read++;
    return (this.cur >>> this.left) & 1;
  }
  bits(n) { let v = 0; for (let k = 0; k < n; k++) v = v * 2 + this.bit(); return v; }
  signed(n) { if (n === 0) return 0; const v = this.bits(n); return n >= 32 ? v | 0 : (v << (32 - n)) >> (32 - n); }
}

// ---------------------------------------------------------------- predittori (Appendice C, CodecDriver)
export const PRED = { Lag1: 0, Lag2: 1, Stride1: 2, Stride2: 3, StripIndex: 4, Ramp: 5, Xor1: 6, Xor2: 7, NULL: 8 };
export function unpackResiduals(res, pred) {
  if (pred === PRED.NULL) return res;
  const n = res.length, v = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (i < 4) { v[i] = res[i]; continue; }
    let p;
    switch (pred) {
      case PRED.Lag2: case PRED.Xor2: p = v[i - 2]; break;
      case PRED.Stride1: p = v[i - 1] + (v[i - 1] - v[i - 2]); break;
      case PRED.Stride2: p = v[i - 2] + (v[i - 2] - v[i - 4]); break;
      case PRED.StripIndex: { const d = v[i - 2] - v[i - 4]; p = d < 8 && d > -8 ? v[i - 2] + d : v[i - 2] + 2; break; }
      case PRED.Ramp: p = i; break;
      default: p = v[i - 1];
    }
    v[i] = pred === PRED.Xor1 || pred === PRED.Xor2 ? res[i] ^ p : (res[i] + p) | 0;
  }
  return v;
}

// ---------------------------------------------------------------- codec di prima generazione (Int32CDP, JT 8)
function readContexts1(r) {
  const count = r.u8_();
  const bb = new ByteBits(r);
  const ctxs = [];
  let valueBits = 0, minValue = 0;
  for (let c = 0; c < count; c++) {
    const n = bb.bits(32), symBits = bb.bits(6), occBits = bb.bits(6);
    let vBits = 0;
    if (c === 0) { valueBits = bb.bits(6); vBits = valueBits; }
    const nextBits = bb.bits(6);
    if (c === 0) minValue = bb.signed32();
    const ents = [];
    let cum = 0;
    for (let i = 0; i < n; i++) {
      const sym = bb.bits(symBits) - 2, occ = bb.bits(occBits);
      const val = c === 0 ? bb.bits(vBits) + minValue : 0;
      const next = bb.bits(nextBits);
      ents.push({ sym, occ, val, next, cum });
      cum += occ;
    }
    ctxs.push({ ents, total: cum, bySym: new Map(ents.map(e => [e.sym, e])) });
  }
  // nelle tabelle successive il valore associato si prende dalla prima, a parita' di simbolo
  for (let c = 1; c < ctxs.length; c++) for (const e of ctxs[c].ents) { const f = ctxs[0].bySym.get(e.sym); if (f) e.val = f.val; }
  return ctxs;
}

function lookupCum(ctx, cnt) {
  const a = ctx.ents;
  let lo = 0, hi = a.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cnt < a[m].cum + a[m].occ) hi = m; else lo = m + 1; }
  return a[lo];
}

// Decodificatore aritmetico a 16 bit (Appendice C 3.1 / 3.2): entries -> callback per ogni simbolo
function arithmeticDecode(words, nSymbols, ctxOf, onEntry) {
  const wb = new WordBits(words, words.length * 32);
  let code = wb.bits(16), low = 0, high = 0xffff;
  for (let i = 0; i < nSymbols; i++) {
    const ctx = ctxOf();
    const total = ctx.total;
    const resc = Math.floor(((code - low + 1) * total - 1) / (high - low + 1));
    const e = lookupCum(ctx, resc);
    onEntry(e);
    const range = high - low + 1;
    high = (low + Math.floor((range * (e.cum + e.occ)) / total) - 1) & 0xffff;
    low = (low + Math.floor((range * e.cum) / total)) & 0xffff;
    for (;;) {
      if (((~(high ^ low)) & 0x8000) !== 0) { /* bit uguali: si scorre */ }
      else if ((low & 0x4000) && !(high & 0x4000)) { code ^= 0x4000; low &= 0x3fff; high |= 0x4000; }
      else break;
      low = (low << 1) & 0xffff;
      high = ((high << 1) | 1) & 0xffff;
      code = ((code << 1) | wb.bit()) & 0xffff;
    }
  }
}

function bitlength1(words, nbits) {
  // Appendice C 2.1: prefisso 0 = stessa ampiezza, 1 + incrementi/decrementi di 2 bit + terminatore
  const wb = new WordBits(words, nbits);
  const out = [];
  let width = 0;
  while (wb.read < nbits) {
    if (wb.bit() === 1) {
      let last = -1;
      while (wb.read < nbits) {
        const b = wb.bit();
        if (last !== -1 && b !== last) break;
        width += b ? 2 : -2;
        last = b;
      }
    }
    if (width === 0) { out.push(0); continue; }
    if (wb.read + width > nbits) break;
    out.push(wb.signed(width));
  }
  return out;
}

function huffmanTrees(ctxs) {
  // albero di Huffman da ogni tabella: i due nodi meno frequenti si uniscono (1 = ramo sinistro)
  return ctxs.map(ctx => {
    const heap = [];
    let seq = 0;
    const push = n => { n.seq = seq++; heap.push(n); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (less(heap[i], heap[p])) { [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } else break; } };
    const less = (a, b) => a.cnt < b.cnt;
    // estrazione del minimo: a parita' di frequenza l'ultimo elemento scende sotto il figlio (heap classico,
    // come nell'implementazione di riferimento): l'ordine dei pareggi decide la forma dell'albero
    const pop = () => {
      const top = heap[0], y = heap.pop();
      const size = heap.length;
      if (size) {
        let i = 0, c = 1;
        while (c < size) {
          if (c + 1 < size && heap[c].cnt > heap[c + 1].cnt) c++;
          if (y.cnt < heap[c].cnt) break;
          heap[i] = heap[c]; i = c; c = 2 * c + 1;
        }
        heap[i] = y;
      }
      return top;
    };
    for (const e of ctx.ents) push({ cnt: e.occ, e });
    if (!heap.length) return null;
    while (heap.length > 1) { const a = pop(), b = pop(); push({ cnt: a.cnt + b.cnt, l: a, r: b }); }
    return heap[0];
  });
}

export function readCDP1(r, pred = PRED.NULL) {
  const codec = r.u8_();
  let ctxs = null, oob = null;
  if (codec === 2 || codec === 3) {
    ctxs = readContexts1(r);
    const nOob = r.i32();
    if (nOob > 0) oob = readCDP1(r, PRED.NULL);
  }
  let nbits = 0, nValues = 0, nSyms = 0;
  if (codec !== 0) {
    nbits = r.i32();
    nValues = r.i32();
    nSyms = ctxs && ctxs.length > 1 ? r.i32() : nValues;
  }
  const words = r.vecU32();
  let vals;
  if (codec === 0) vals = Int32Array.from(words, w => w | 0);
  else if (codec === 1) vals = Int32Array.from(bitlength1(words, nbits).slice(0, nValues));
  else {
    vals = new Int32Array(nValues);
    let k = 0, oi = 0, cur = 0;
    const emit = e => {
      if (e.sym === -2) { if (cur === 0 && k < nValues) vals[k++] = oob ? oob[oi++] : 0; }
      else if (k < nValues) vals[k++] = e.val;
      cur = e.next || 0;
    };
    if (nbits === 0 && oob && oob.length >= nValues) vals.set(oob.subarray(0, nValues));
    else if (codec === 3) arithmeticDecode(words, nSyms, () => ctxs[cur], emit);
    else {
      const trees = huffmanTrees(ctxs);
      const wb = new WordBits(words, nbits);
      let node = trees[0];
      while (wb.read < nbits && k < nValues && node) {
        node = wb.bit() ? node.l || node : node.r || node;
        if (!node.l) { emit(node.e); node = trees[cur]; }
      }
    }
  }
  return unpackResiduals(vals, pred);
}

// ---------------------------------------------------------------- codec Mk. 2 (Int32CDP2, JT 9 e 10)
function bitlength2(words, nbits, nValues) {
  const wb = new WordBits(words, nbits);
  const out = new Int32Array(nValues);
  if (nValues === 0) return out;
  if (wb.bit() === 0) {
    // ampiezza fissa: minimo e massimo, poi ogni valore in (bit di max-min) bit
    const bMin = wb.bits(6), bMax = wb.bits(6);
    const mn = wb.signed(bMin), mx = wb.signed(bMax);
    let w = 0;
    for (let span = Math.abs(mx - mn), i = 1; i <= span && w < 31; i += i) w++;
    for (let i = 0; i < nValues; i++) out[i] = (wb.bits(w) + mn) | 0;
  } else {
    // ampiezza variabile a blocchi: media, poi variazioni dell'ampiezza e lunghezza di ogni blocco
    const mean = wb.signed(32), blkVal = wb.bits(3), blkLen = wb.bits(3);
    const maxDec = -(1 << (blkVal - 1)), maxInc = (1 << (blkVal - 1)) - 1;
    let width = 0;
    for (let i = 0; i < nValues;) {
      let d;
      do { d = wb.signed(blkVal); width += d; } while (d === maxDec || d === maxInc);
      const run = wb.bits(blkLen);
      if (run === 0 && wb.read >= nbits) break;
      for (let k = 0; k < run && i < nValues; k++) out[i++] = (wb.signed(width) + mean) | 0;
    }
  }
  return out;
}

// JT 10 (BitLengthCodec2 della specifica 10.5): minimo, massimo e media in "nibble" da 4 bit + bit di continuazione;
// blocchi a larghezza variabile con campi di 4 bit
function bitlength3(words, nbits, nValues) {
  const wb = new WordBits(words, nbits);
  const out = new Int32Array(nValues);
  if (nValues === 0) return out;
  const nibbler = () => {
    let v = 0, n = 0, more;
    do { v += wb.bits(4) * 2 ** (4 * n); more = wb.bit(); n++; } while (more && n < 8);
    const sw = n * 4;
    return sw < 32 ? ((v << (32 - sw)) >> (32 - sw)) : v | 0;
  };
  if (wb.bit() === 0) {
    const mn = nibbler(), mx = nibbler();
    const span = (mx - mn) >>> 0;
    const w = span === 0 ? 0 : 32 - Math.clz32(span);
    for (let i = 0; i < nValues; i++) out[i] = (wb.bits(w) + mn) | 0;
  } else {
    const mean = nibbler();
    const BV = 4, BL = 4, maxDec = -(1 << (BV - 1)), maxInc = (1 << (BV - 1)) - 1;
    let width = 0;
    for (let i = 0; i < nValues;) {
      let d;
      do { d = wb.signed(BV); width += d; } while (d === maxDec || d === maxInc);
      const run = wb.bits(BL);
      if (run === 0 && wb.read >= nbits) break;
      for (let k = 0; k < run && i < nValues; k++) out[i++] = (wb.signed(width) + mean) | 0;
    }
  }
  return out;
}

function readContexts2(r, v10) {
  const bb = new ByteBits(r);
  const n = bb.bits(16);
  const ents = [];
  let cum = 0, esc = false;
  if (v10) {
    const occBits = bb.bits(6), valBits = bb.bits(7), mn = bb.signed32();
    for (let i = 0; i < n; i++) {
      const isEsc = bb.bits(1), occ = bb.bits(occBits), val = bb.bits(valBits) + mn;
      if (isEsc) esc = true;
      ents.push({ sym: isEsc ? -2 : i, occ, val: val | 0, cum });
      cum += occ;
    }
  } else {
    const symBits = bb.bits(6), occBits = bb.bits(6), valBits = bb.bits(6), mn = bb.signed32();
    for (let i = 0; i < n; i++) {
      const sym = bb.bits(symBits) - 2, occ = bb.bits(occBits), val = bb.bits(valBits) + mn;
      if (sym === -2) esc = true;
      ents.push({ sym, occ, val: val | 0, cum });
      cum += occ;
    }
  }
  return { ents, total: cum, esc };
}

export function readCDP2(r, pred = PRED.NULL, v10 = false) {
  return unpackResiduals(cdp2(r, v10, 0), pred);
}

function cdp2(r, v10, depth) {
  if (depth > 12) throw new Error("JT: dati compressi non validi (troppi livelli)");
  const nValues = r.i32();
  if (nValues <= 0) return new Int32Array(0);
  const codec = r.u8_();
  if (codec === 4) { // Chopper: bit alti e bassi codificati a parte, piu' uno scostamento
    const chop = r.u8_();
    if (chop === 0) return cdp2(r, v10, depth + 1);
    const bias = r.i32(), span = r.u8_();
    const msb = cdp2(r, v10, depth + 1), lsb = cdp2(r, v10, depth + 1);
    const out = new Int32Array(nValues), sh = span - chop;
    for (let i = 0; i < nValues; i++) out[i] = ((lsb[i] | (msb[i] << sh)) + bias) | 0;
    return out;
  }
  if (codec === 5) { // Move-to-front (JT 10): finestra di valori recenti
    const win = Array.from(cdp2(r, v10, depth + 1)), offs = cdp2(r, v10, depth + 1);
    const out = new Int32Array(offs.length);
    let ctr = 0;
    for (let i = 0; i < offs.length; i++) {
      let o = offs[i];
      if (o < 0) o = o === -1 ? ctr++ : 8 + o;
      const v = win[o];
      out[i] = v;
      win.splice(o, 1);
      win.unshift(v);
    }
    return out;
  }
  const nbits = r.i32();
  if (codec === 0) {
    // Null: i valori sono scritti cosi' come sono
    const nw = v10 ? Math.ceil(nbits / 32) : nbits >> 2;
    const w = r.words(Math.max(nw, 0));
    const out = new Int32Array(nValues);
    for (let i = 0; i < nValues && i < w.length; i++) out[i] = w[i] | 0;
    return out;
  }
  const words = r.words(Math.ceil(nbits / 32));
  if (codec === 1) return v10 ? bitlength3(words, nbits, nValues) : bitlength2(words, nbits, nValues);
  if (codec !== 3) throw new Error("JT: codec di compressione sconosciuto (" + codec + ")");
  const ctx = readContexts2(r, v10);
  const oob = !v10 || ctx.esc ? cdp2(r, v10, depth + 1) : new Int32Array(0);
  if (nbits === 0 && oob.length >= nValues) return oob.subarray(0, nValues);
  const out = new Int32Array(nValues);
  let k = 0, oi = 0;
  arithmeticDecode(words, nValues, () => ctx, e => { out[k++] = e.sym === -2 ? oob[oi++] | 0 : e.val; });
  return out;
}

// ---------------------------------------------------------------- normali (codec di Deering, Appendice C 4)
const PSI_MAX = 0.615479709;
export function deeringNormal(sext, oct, theta, psi, nbits, out, o) {
  const range = 1 << nbits;
  theta += sext & 1;
  const th = Math.asin(Math.tan(PSI_MAX * (range - theta) / range)), ps = PSI_MAX * (psi / range);
  const ct = Math.cos(th), st = Math.sin(th), cp = Math.cos(ps), sp = Math.sin(ps);
  const xx = ct * cp, yy = sp, zz = st * cp;
  let x = xx, y = yy, z = zz;
  switch (sext) {
    case 1: z = xx; x = zz; break;
    case 2: z = xx; x = yy; y = zz; break;
    case 3: y = xx; x = yy; break;
    case 4: y = xx; z = yy; x = zz; break;
    case 5: z = yy; y = zz; break;
  }
  if (!(oct & 4)) x = -x;
  if (!(oct & 2)) y = -y;
  if (!(oct & 1)) z = -z;
  out[o] = x; out[o + 1] = y; out[o + 2] = z;
}

// ---------------------------------------------------------------- decompressione dei segmenti
export async function inflate(u8) {
  const ds = new DecompressionStream("deflate");
  const buf = await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}

// Contenitore .xz con filtro LZMA2 (segmenti compressi dei JT 10)
export function xzDecode(u8) {
  if (!(u8[0] === 0xfd && u8[1] === 0x37 && u8[2] === 0x7a && u8[3] === 0x58 && u8[4] === 0x5a)) {
    // senza contenitore: flusso LZMA2 diretto
    return lzma2(u8, 0, 1 << 26);
  }
  let q = 12;
  const hsize = (u8[q] + 1) * 4, start = q;
  q++;
  const flags = u8[q++];
  const varint = () => { let v = 0, s = 1, b; do { b = u8[q++]; v += (b & 0x7f) * s; s *= 128; } while (b & 0x80); return v; };
  if (flags & 0x40) varint();
  if (flags & 0x80) varint();
  let dict = 1 << 23;
  for (let i = 0, nf = (flags & 3) + 1; i < nf; i++) {
    const id = varint(), ps = varint();
    if (id === 0x21) { const b = u8[q] & 0x3f; dict = b === 40 ? 0xffffffff : (2 | (b & 1)) * 2 ** ((b >> 1) + 11); }
    else if (id !== 0x21) throw new Error("JT: filtro di compressione XZ non supportato");
    q += ps;
  }
  return lzma2(u8, start + hsize, dict);
}

function lzma2(src, p, dictSize) {
  let out = new Uint8Array(Math.max(1 << 16, src.length * 4)), op = 0;
  const grow = need => { if (op + need <= out.length) return; let n = out.length * 2; while (n < op + need) n *= 2; const o2 = new Uint8Array(n); o2.set(out.subarray(0, op)); out = o2; };
  const L = new LzmaState();
  let dictStart = 0;
  for (;;) {
    const c = src[p++];
    if (c === undefined || c === 0) break;
    if (c === 1 || c === 2) {
      const size = ((src[p] << 8) | src[p + 1]) + 1; p += 2;
      if (c === 1) dictStart = op;
      grow(size);
      out.set(src.subarray(p, p + size), op);
      op += size; p += size;
      continue;
    }
    if (c < 0x80) throw new Error("JT: dati LZMA2 non validi");
    const usize = ((c & 0x1f) << 16) + (src[p] << 8) + src[p + 1] + 1;
    const psize = (src[p + 2] << 8) + src[p + 3] + 1;
    p += 4;
    const mode = (c >> 5) & 3;
    if (mode === 3) dictStart = op;
    if (mode >= 2) { L.setProps(src[p++]); }
    if (mode >= 1) L.reset();
    grow(usize);
    L.decode(src, p, p + psize, out, op, op + usize, dictStart);
    op += usize;
    p += psize;
  }
  void dictSize;
  return out.subarray(0, op);
}

class LzmaState {
  setProps(b) { this.lc = b % 9; b = (b / 9) | 0; this.lp = b % 5; this.pb = (b / 5) | 0; this.probs = null; }
  reset() {
    const P = n => new Uint16Array(n).fill(1024);
    this.isMatch = P(192); this.isRep = P(12); this.isRepG0 = P(12); this.isRepG1 = P(12); this.isRepG2 = P(12); this.isRep0Long = P(192);
    this.posSlot = P(256); this.posDec = P(115); this.align = P(16);
    this.lenDec = this.newLen(P); this.repLenDec = this.newLen(P);
    this.lit = P(0x300 << (this.lc + this.lp));
    this.state = 0; this.reps = [0, 0, 0, 0];
  }
  newLen(P) { return { choice: P(2), low: P(16 * 8), mid: P(16 * 8), high: P(256) }; }
  decode(src, p, pend, out, op, oend, dictStart) {
    // decodificatore a intervalli (range coder) ricreato a ogni blocco LZMA2
    let range = 0xffffffff, code = 0;
    p++; // primo byte sempre 0
    for (let i = 0; i < 4; i++) code = ((code << 8) | src[p++]) >>> 0;
    const norm = () => { if (range < 0x1000000) { range = (range << 8) >>> 0; code = ((code << 8) | src[p++]) >>> 0; } };
    const bit = (pr, i) => {
      const v = pr[i], bound = (range >>> 11) * v;
      let b;
      if (code < bound) { range = bound; pr[i] = v + ((2048 - v) >> 5); b = 0; }
      else { range = (range - bound) >>> 0; code = (code - bound) >>> 0; pr[i] = v - (v >> 5); b = 1; }
      norm();
      return b;
    };
    const tree = (pr, base, nb) => { let m = 1; for (let i = 0; i < nb; i++) m = (m << 1) | bit(pr, base + m); return m - (1 << nb); };
    const rtree = (pr, base, nb) => { let m = 1, s = 0; for (let i = 0; i < nb; i++) { const b = bit(pr, base + m); m = (m << 1) | b; s |= b << i; } return s; };
    const direct = nb => { let s = 0; for (let i = 0; i < nb; i++) { range >>>= 1; let b = 0; if (code >= range) { code = (code - range) >>> 0; b = 1; } s = (s << 1) | b; norm(); } return s >>> 0; };
    const lenDecode = (ld, ps) => {
      if (!bit(ld.choice, 0)) return tree(ld.low, ps * 8, 3);
      if (!bit(ld.choice, 1)) return 8 + tree(ld.mid, ps * 8, 3);
      return 16 + tree(ld.high, 0, 8);
    };
    const pbMask = (1 << this.pb) - 1, lpMask = (1 << this.lp) - 1, lc = this.lc;
    let state = this.state;
    const reps = this.reps;
    while (op < oend) {
      const ps = op & pbMask;
      if (!bit(this.isMatch, (state << 4) + ps)) {
        const prev = op > dictStart ? out[op - 1] : 0;
        const base = 0x300 * (((op & lpMask) << lc) + (prev >> (8 - lc)));
        let sym = 1;
        if (state >= 7 && op - reps[0] - 1 >= dictStart) {
          let mb = out[op - reps[0] - 1];
          do {
            const mbit = (mb >> 7) & 1; mb <<= 1;
            const b = bit(this.lit, base + ((1 + mbit) << 8) + sym);
            sym = (sym << 1) | b;
            if (mbit !== b) break;
          } while (sym < 0x100);
        }
        while (sym < 0x100) sym = (sym << 1) | bit(this.lit, base + sym);
        out[op++] = sym & 0xff;
        state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        continue;
      }
      let len;
      if (bit(this.isRep, state)) {
        if (!bit(this.isRepG0, state)) {
          if (!bit(this.isRep0Long, (state << 4) + ps)) {
            state = state < 7 ? 9 : 11;
            out[op] = out[op - reps[0] - 1]; op++;
            continue;
          }
        } else {
          let d;
          if (!bit(this.isRepG1, state)) d = reps[1];
          else { if (!bit(this.isRepG2, state)) d = reps[2]; else { d = reps[3]; reps[3] = reps[2]; } reps[2] = reps[1]; }
          reps[1] = reps[0]; reps[0] = d;
        }
        len = lenDecode(this.repLenDec, ps);
        state = state < 7 ? 8 : 11;
      } else {
        reps[3] = reps[2]; reps[2] = reps[1]; reps[1] = reps[0];
        len = lenDecode(this.lenDec, ps);
        state = state < 7 ? 7 : 10;
        const lstate = Math.min(len, 3);
        const slot = tree(this.posSlot, lstate * 64, 6);
        let dist;
        if (slot < 4) dist = slot;
        else {
          const nd = (slot >> 1) - 1;
          dist = (2 | (slot & 1)) << nd;
          if (slot < 14) dist += rtree(this.posDec, dist - slot, nd);
          else dist = (dist + (direct(nd - 4) << 4) + rtree(this.align, 0, 4)) >>> 0;
        }
        if (dist === 0xffffffff) break; // marcatore di fine
        reps[0] = dist;
      }
      len += 2;
      const from = op - reps[0] - 1;
      if (from < dictStart - 0 && from < 0) throw new Error("JT: dati LZMA non validi");
      for (let i = 0; i < len && op < oend; i++) { out[op] = out[from + i]; op++; }
    }
    this.state = state;
  }
}
