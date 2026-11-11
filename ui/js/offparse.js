// Object File Format (.off) di Geomview / Princeton Shape Benchmark / MeshLab: testo "OFF" (anche ST/C/N/4 davanti, come COFF,
// NOFF, STCNOFF), poi numero di vertici, facce e spigoli, i vertici (x y z [nx ny nz] [r g b [a]] [u v]) e le facce
// (n i1 ... in [r g b [a]]). Commenti con "#". Puro: nessun DOM, provato in Node (tests/test_off.mjs).
// Colori: interi 0-255 o reali 0-1 (come Geomview). Il binario "OFF BINARY" e le dimensioni diverse da 3 (nOFF, 4OFF) si rifiutano.

export function isOff(text) {
  return /^\s*(ST)?C?N?(4)?OFF\b/.test(text.replace(/^(\s*#[^\n]*\n)+/, ""));
}

export function parseOff(text) {
  const lines = text.split(/\r?\n/).map(l => l.replace(/#.*/, "").trim()).filter(Boolean);
  if (!lines.length) throw new Error("off-vuoto");
  const head = lines[0].match(/^(ST)?(C)?(N)?(4)?OFF(.*)$/);
  if (!head) throw new Error("off-intestazione");
  if (head[4]) throw new Error("off-dimensione");
  let rest = head[5].trim();
  if (/^BINARY/i.test(rest)) throw new Error("off-binario");
  const hasT = !!head[1], hasC = !!head[2], hasN = !!head[3];
  // i numeri possono stare sulla stessa riga di OFF o su quella dopo; poi un flusso unico di righe
  let li = 1;
  let counts = rest ? rest.split(/\s+/).map(Number) : null;
  if (!counts || counts.length < 2) counts = lines[li++].split(/\s+/).map(Number);
  const [nv, nf] = counts;
  if (!(nv >= 0) || !(nf >= 0) || lines.length - li < nv) throw new Error("off-conteggi");
  const pos = new Float32Array(nv * 3);
  let vcol = null;
  for (let i = 0; i < nv; i++) {
    const v = lines[li++].split(/\s+/).map(Number);
    pos[i * 3] = v[0]; pos[i * 3 + 1] = v[1]; pos[i * 3 + 2] = v[2];
    let k = 3 + (hasN ? 3 : 0);
    if (hasC && v.length >= k + 3) {
      if (!vcol) vcol = new Float32Array(nv * 3).fill(0.75);
      const sc = v.slice(k, k + 3).some(x => x > 1) ? 1 / 255 : 1;
      vcol[i * 3] = v[k] * sc; vcol[i * 3 + 1] = v[k + 1] * sc; vcol[i * 3 + 2] = v[k + 2] * sc;
      k += v.length - k >= 4 + (hasT ? 2 : 0) ? 4 : 3;
    }
  }
  const tri = [], fcol = [];
  let anyFaceColor = false, polys = 0, edges = [];
  for (let f = 0; f < nf && li < lines.length; f++) {
    const v = lines[li++].split(/\s+/).map(Number);
    const n = v[0];
    if (!(n >= 1) || v.length < n + 1) continue;
    const ids = v.slice(1, n + 1);
    if (ids.some(x => !(x >= 0 && x < nv))) continue;
    let c = null;
    const extra = v.slice(n + 1);
    if (extra.length >= 3) {
      const sc = extra.slice(0, 3).some(x => x > 1) ? 1 / 255 : 1;
      c = [extra[0] * sc, extra[1] * sc, extra[2] * sc];
      anyFaceColor = true;
    }
    if (n === 2) { edges.push(ids[0], ids[1]); continue; }
    if (n < 3) continue;
    polys++;
    for (let k = 1; k + 1 < n; k++) { tri.push(ids[0], ids[k], ids[k + 1]); fcol.push(c); } // ventaglio: le facce OFF sono convesse
  }
  return { pos, vcol, tri: Uint32Array.from(tri), faceColors: anyFaceColor ? fcol : null, edges, nv, nf: polys, hasT };
}
