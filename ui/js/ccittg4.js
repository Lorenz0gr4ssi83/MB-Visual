// Immagini bianco e nero CCITT Group 4 (ITU-T T.6, codici di Huffman di ITU-T T.4) in un file TIFF: usate dai DWF per le
// immagini raster monocromatiche (scansioni). Scritto da zero dagli standard pubblici.

const WT = "00110101 000111 0111 1000 1011 1100 1110 1111 10011 10100 00111 01000 001000 000011 110100 110101 101010 101011 0100111 0001100 0001000 0010111 0000011 0000100 0101000 0101011 0010011 0100100 0011000 00000010 00000011 00011010 00011011 00010010 00010011 00010100 00010101 00010110 00010111 00101000 00101001 00101010 00101011 00101100 00101101 00000100 00000101 00001010 00001011 01010010 01010011 01010100 01010101 00100100 00100101 01011000 01011001 01011010 01011011 01001010 01001011 00110010 00110011 00110100";
const WM = "11011 10010 010111 0110111 00110110 00110111 01100100 01100101 01101000 01100111 011001100 011001101 011010010 011010011 011010100 011010101 011010110 011010111 011011000 011011001 011011010 011011011 010011000 010011001 010011010 011000 010011011";
const BT = "0000110111 010 11 10 011 0011 0010 00011 000101 000100 0000100 0000101 0000111 00000100 00000111 000011000 0000010111 0000011000 0000001000 00001100111 00001101000 00001101100 00000110111 00000101000 00000010111 00000011000 000011001010 000011001011 000011001100 000011001101 000001101000 000001101001 000001101010 000001101011 000011010010 000011010011 000011010100 000011010101 000011010110 000011010111 000001101100 000001101101 000011011010 000011011011 000001010100 000001010101 000001010110 000001010111 000001100100 000001100101 000001010010 000001010011 000000100100 000000110111 000000111000 000000100111 000000101000 000001011000 000001011001 000000101011 000000101100 000001011010 000001100110 000001100111";
const BM = "0000001111 000011001000 000011001001 000001011011 000000110011 000000110100 000000110101 0000001101100 0000001101101 0000001001010 0000001001011 0000001001100 0000001001101 0000001110010 0000001110011 0000001110100 0000001110101 0000001110110 0000001110111 0000001010010 0000001010011 0000001010100 0000001010101 0000001011010 0000001011011 0000001100100 0000001100101";
const XM = "00000001000 00000001100 00000001101 000000010010 000000010011 000000010100 000000010101 000000010110 000000010111 000000011100 000000011101 000000011110 000000011111";

// albero binario: nodo = [figlio0, figlio1] oppure valore (numero)
function tree(entries) {
  const root = [null, null];
  for (const [code, val] of entries) {
    let n = root;
    for (let i = 0; i < code.length; i++) {
      const b = +code[i];
      if (i === code.length - 1) { if (n[b] !== null) throw new Error("tabella CCITT non valida"); n[b] = val; }
      else { if (n[b] === null) n[b] = [null, null]; else if (!Array.isArray(n[b])) throw new Error("tabella CCITT non valida"); n = n[b]; }
    }
  }
  return root;
}
const list = (s, f) => s.split(" ").map((c, i) => [c, f(i)]);
let WHITE, BLACK, MODES;
function tables() {
  if (WHITE) return;
  const ext = list(XM, i => 1792 + 64 * i);
  WHITE = tree([...list(WT, i => i), ...list(WM, i => 64 * (i + 1)), ...ext]);
  BLACK = tree([...list(BT, i => i), ...list(BM, i => 64 * (i + 1)), ...ext]);
  // modi: P passaggio, H orizzontale, V verticale (scostamento -3..3)
  MODES = tree([["0001", "P"], ["001", "H"], ["1", 0], ["011", 1], ["000011", 2], ["0000011", 3], ["010", -1], ["000010", -2], ["0000010", -3], ["000000000001", "EOL"]]);
}

/** decodifica una striscia T.6: restituisce un Uint8Array (1 = nero) per righe */
export function decodeG4(data, width, rows) {
  tables();
  let pos = 0;
  const bit = () => { const v = pos >> 3 < data.length ? (data[pos >> 3] >> (7 - (pos & 7))) & 1 : 0; pos++; return v; };
  const read = t => { let n = t; for (let g = 0; g < 24; g++) { n = n[bit()]; if (n === null || n === undefined) return null; if (!Array.isArray(n)) return n; } return null; };
  const run = t => { let total = 0; for (;;) { const v = read(t); if (v === null) return -1; total += v; if (v < 64) return total; } };
  const out = new Uint8Array(width * rows);
  let ref = [width, width]; // posizioni di cambio colore della riga di riferimento (inizio bianco)
  for (let y = 0; y < rows; y++) {
    const cur = [];
    let a0 = -1, color = 0;
    const b1of = () => {
      // primo cambio sulla riga di riferimento a destra di a0 e di colore opposto (indice pari = verso il nero)
      let i = 0;
      while (i < ref.length && (ref[i] <= a0 || (i & 1) !== color)) i++;
      return i;
    };
    let guard = 0;
    while (a0 < width && guard++ < 4 * width + 16) {
      const mode = read(MODES);
      if (mode === null || mode === "EOL") { y = rows; break; }
      const start = Math.max(a0, 0);
      if (mode === "P") {
        const i = b1of();
        const b2 = ref[Math.min(i + 1, ref.length - 1)];
        if (color) out.fill(1, y * width + start, y * width + Math.min(b2, width));
        a0 = b2;
      } else if (mode === "H") {
        const r1 = run(color ? BLACK : WHITE), r2 = run(color ? WHITE : BLACK);
        if (r1 < 0 || r2 < 0) { y = rows; break; }
        const a1 = Math.min(start + r1, width), a2 = Math.min(a1 + r2, width);
        if (color) out.fill(1, y * width + start, y * width + a1); else out.fill(1, y * width + a1, y * width + a2);
        cur.push(a1, a2);
        a0 = a2;
      } else {
        const i = b1of();
        const a1 = Math.max(start, Math.min(width, ref[Math.min(i, ref.length - 1)] + mode));
        if (color) out.fill(1, y * width + start, y * width + a1);
        cur.push(a1);
        a0 = a1;
        color ^= 1;
      }
    }
    // riga successiva: la corrente diventa riferimento (cambi effettivi, con sentinelle)
    const changes = [];
    let c = 0;
    for (let x = 0; x < width; x++) { const v = out[y * width + x]; if (v !== c) { changes.push(x); c = v; } }
    changes.push(width, width);
    ref = changes;
    void cur;
  }
  return out;
}

/** TIFF con compressione 3 (non gestita) o 4 -> { width, height, rgba } ; cmap: [colore per 0 (bianco), colore per 1 (nero)] */
export function decodeTiffG4(bytes, cmap = null) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = bytes[0] === 0x49;
  const u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
  if (u16(2) !== 42) throw new Error("TIFF non valido");
  const ifd = u32(4), n = u16(ifd);
  const tags = {};
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + 12 * i, tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
    const size = { 1: 1, 3: 2, 4: 4 }[type] || 4;
    const at = cnt * size > 4 ? u32(e + 8) : e + 8;
    const vals = [];
    for (let k = 0; k < cnt && k < 65536; k++) vals.push(size === 2 ? u16(at + 2 * k) : size === 1 ? bytes[at + k] : u32(at + 4 * k));
    tags[tag] = vals;
  }
  const width = tags[256]?.[0], height = tags[257]?.[0], comp = tags[259]?.[0] ?? 1;
  if (!width || !height) throw new Error("TIFF senza dimensioni");
  if (comp !== 4) throw new Error("Compressione TIFF non gestita: " + comp);
  const offs = tags[273] || [], counts = tags[279] || [], rps = tags[278]?.[0] || height;
  const photo = tags[262]?.[0] ?? 0, fill = tags[266]?.[0] ?? 1;
  const bits = new Uint8Array(width * height);
  for (let s = 0; s < offs.length; s++) {
    let data = bytes.subarray(offs[s], offs[s] + (counts[s] || bytes.length - offs[s]));
    if (fill === 2) data = data.map(b => { let r = 0; for (let k = 0; k < 8; k++) r |= ((b >> k) & 1) << (7 - k); return r; });
    const rows = Math.min(rps, height - s * rps);
    bits.set(decodeG4(data, width, rows), s * rps * width);
  }
  const white = cmap?.[0] || [255, 255, 255, 255], black = cmap?.[1] || [0, 0, 0, 255];
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < bits.length; i++) {
    const isBlack = photo === 1 ? !bits[i] : !!bits[i];
    rgba.set(isBlack ? black : white, 4 * i);
  }
  return { width, height, rgba };
}
