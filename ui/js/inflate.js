// Decompressore DEFLATE (RFC 1951) con involucro zlib (RFC 1950) facoltativo, scritto da zero.
// A differenza di DecompressionStream dice quanti byte compressi ha consumato: nei flussi W2D (DWF) e HSF (W3D) i dati
// compressi sono seguiti da altri dati non compressi.

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORD = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// tabella di decodifica canonica: per ogni lunghezza il numero di codici e i simboli in ordine
function table(lengths) {
  const count = new Uint16Array(16), symbols = new Uint16Array(lengths.length), offs = new Uint16Array(16);
  for (const l of lengths) count[l]++;
  count[0] = 0;
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbols[offs[lengths[s]]++] = s;
  return { count, symbols };
}
let FIXED_L, FIXED_D;
function fixed() {
  if (!FIXED_L) {
    const l = new Uint8Array(288);
    l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
    FIXED_L = table(l);
    FIXED_D = table(new Uint8Array(30).fill(5));
  }
  return [FIXED_L, FIXED_D];
}

/** Decomprime a partire da `start`. zlib=true: salta l'intestazione di 2 byte e la somma Adler-32 finale.
 *  Restituisce { data: Uint8Array, end: indice del primo byte dopo i dati compressi }. */
export function inflate(src, start = 0, zlib = true, dict = null) {
  let pos = start, bit = 0, nbits = 0;
  let useDict = false;
  if (zlib) {
    const cmf = src[pos], flg = src[pos + 1];
    if ((cmf & 15) !== 8 || ((cmf << 8) | flg) % 31) throw new Error("Dati zlib non validi");
    pos += 2;
    if (flg & 32) { // dizionario preimpostato: la cronologia parte dai suoi byte
      if (!dict) throw new Error("Dati compressi con un dizionario sconosciuto");
      pos += 4;
      useDict = true;
    }
  } else useDict = !!dict;
  const d0 = useDict ? dict.length : 0;
  let out = new Uint8Array(Math.max(1024, (src.length - start) * 4 + d0));
  let n = 0;
  if (useDict) { out.set(dict); n = d0; }
  const grow = need => { if (n + need <= out.length) return; let s = out.length * 2; while (s < n + need) s *= 2; const o = new Uint8Array(s); o.set(out.subarray(0, n)); out = o; };
  const bits = k => {
    while (nbits < k) { if (pos >= src.length) throw new Error("Dati compressi troncati"); bit |= src[pos++] << nbits; nbits += 8; }
    const v = bit & ((1 << k) - 1);
    bit >>>= k; nbits -= k;
    return v;
  };
  const decode = h => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - c < first) return h.symbols[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error("Codice di Huffman non valido");
  };
  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bit = 0; nbits = 0; // allineamento al byte
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      grow(len);
      out.set(src.subarray(pos, pos + len), n);
      n += len; pos += len;
      continue;
    }
    let L, D;
    if (type === 1) [L, D] = fixed();
    else if (type === 2) {
      const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) cl[CLORD[i]] = bits(3);
      const ct = table(cl);
      const lens = new Uint8Array(hlit + hdist);
      for (let i = 0; i < hlit + hdist;) {
        const s = decode(ct);
        if (s < 16) lens[i++] = s;
        else {
          let rep, v = 0;
          if (s === 16) { if (!i) throw new Error("Dati compressi non validi"); v = lens[i - 1]; rep = 3 + bits(2); }
          else if (s === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          while (rep--) lens[i++] = v;
        }
      }
      L = table(lens.subarray(0, hlit));
      D = table(lens.subarray(hlit));
    } else throw new Error("Blocco compresso non valido");
    for (;;) {
      const s = decode(L);
      if (s < 256) { grow(1); out[n++] = s; continue; }
      if (s === 256) break;
      const li = s - 257, len = LBASE[li] + bits(LEXT[li]);
      const di = decode(D), dist = DBASE[di] + bits(DEXT[di]);
      if (dist > n) throw new Error("Distanza non valida nei dati compressi");
      grow(len);
      for (let k = 0; k < len; k++, n++) out[n] = out[n - dist];
    }
  }
  // i bit non usati dell'ultimo byte letto si scartano
  if (zlib) pos += 4;
  return { data: out.subarray(d0, n), end: pos };
}
