// Uscite grandi senza limiti di stringa. Una stringa JavaScript non supera ~0,5-1 GB ("RangeError: Invalid string length")
// e anche sotto quel limite un file intero in memoria puo' esaurirla: qui i file si producono a PEZZI (generatori che
// restituiscono stringhe o byte) e non esistono mai come stringa unica.
// - saveChunks(percorso, pezzi): nell'app per PC i pezzi vanno al motore a blocchi di ~32 MB (api/save con part=n: il motore
//   li accoda in un file temporaneo e lo mette al suo posto con l'ultimo); nella web app diventano un Blob.
// - chunkBlob(pezzi): Blob composto dai blocchi (download, finestra Salva con nome, corpo di una richiesta).
// - jsonChunks(valore, replacer): JSON.stringify a pezzi (stesse regole: toJSON, replacer, undefined, NaN -> null).
import { api } from "./core.js";

const PART = 32 << 20; // byte per blocco inviato al motore
const STR = 4 << 20; // caratteri accumulati prima di codificare in UTF-8

// pezzi (stringhe, Uint8Array, ArrayBuffer, Blob) -> blocchi Uint8Array/Blob di circa PART byte
async function* blocks(gen) {
  const enc = new TextEncoder();
  let strs = [], slen = 0, parts = [], size = 0;
  const takeStr = () => { if (!slen) return; const b = enc.encode(strs.join("")); strs = []; slen = 0; parts.push(b); size += b.length; };
  for await (const p of gen) {
    if (p == null) continue;
    if (typeof p === "string") {
      if (!p.length) continue;
      strs.push(p);
      slen += p.length;
      if (slen >= STR) takeStr();
    } else {
      takeStr();
      const b = p instanceof Blob ? p : p instanceof ArrayBuffer ? new Uint8Array(p) : ArrayBuffer.isView(p) ? new Uint8Array(p.buffer, p.byteOffset, p.byteLength) : p;
      parts.push(b);
      size += b.size ?? b.length;
    }
    if (size >= PART) { yield new Blob(parts); parts = []; size = 0; }
  }
  takeStr();
  if (parts.length) yield new Blob(parts);
}

export async function chunkBlob(gen, type = "application/octet-stream") {
  const all = [];
  for await (const b of blocks(gen)) all.push(b);
  return new Blob(all, { type });
}

// scrive i pezzi nel file `target`; restituisce i byte scritti
export async function saveChunks(target, gen, onProgress) {
  if (window.MBV_WEB) {
    const blob = await chunkBlob(gen);
    await api("save", { path: target }, { body: blob });
    return blob.size;
  }
  let n = 0, total = 0, pending = null;
  for await (const b of blocks(gen)) {
    if (pending) { await api("save", { path: target, part: n++, last: 0 }, { body: pending }); total += pending.size; onProgress?.(total); }
    pending = b;
  }
  await api("save", { path: target, part: n, last: 1 }, { body: pending || new Blob([]) });
  total += pending ? pending.size : 0;
  onProgress?.(total);
  return total;
}

// JSON a pezzi: oggetti e array si percorrono, i valori semplici si scrivono con JSON.stringify; i typed array diventano
// array (come Array.from), i BigInt numeri (come nel replacer usato dal lotto)
export function* jsonChunks(value, replacer) {
  let buf = [], len = 0;
  const out = s => { buf.push(s); len += s.length; };
  function* flushIfBig() { if (len >= 1 << 20) { yield buf.join(""); buf = []; len = 0; } }
  function* walk(holder, key, v, done) {
    if (!done) {
      if (v && typeof v.toJSON === "function") v = v.toJSON(key);
      if (replacer) v = replacer.call(holder, key, v);
    }
    if (typeof v === "bigint") v = Number(v);
    if (v === null || typeof v === "number" || typeof v === "boolean") { out(v === null || !Number.isFinite(v) ? (typeof v === "boolean" ? String(v) : "null") : String(v)); return; }
    if (typeof v === "string") { out(JSON.stringify(v)); return; }
    if (v === undefined || typeof v === "function" || typeof v === "symbol") { out("null"); return; }
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      out("[");
      for (let i = 0; i < v.length; i++) {
        if (i) out(",");
        const x = typeof v[i] === "bigint" ? Number(v[i]) : v[i];
        out(Number.isFinite(x) ? String(x) : "null");
        if ((i & 0xffff) === 0) yield* flushIfBig();
      }
      out("]");
      return;
    }
    if (Array.isArray(v)) {
      out("[");
      for (let i = 0; i < v.length; i++) {
        if (i) out(",");
        yield* walk(v, String(i), v[i]);
        yield* flushIfBig();
      }
      out("]");
      return;
    }
    out("{");
    let first = true;
    for (const k of Object.keys(v)) {
      let x = v[k];
      if (x && typeof x.toJSON === "function") x = x.toJSON(k);
      const y = replacer ? replacer.call(v, k, x) : x;
      if (y === undefined || typeof y === "function" || typeof y === "symbol") continue;
      if (!first) out(",");
      first = false;
      out(JSON.stringify(k) + ":");
      yield* walk(v, k, y, true);
      yield* flushIfBig();
    }
    out("}");
  }
  yield* walk({ "": value }, "", value);
  if (buf.length) yield buf.join("");
}
