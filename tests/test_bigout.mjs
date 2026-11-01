// Collaudo delle uscite grandi senza limiti di stringa (ui/js/bigout.js, ui/js/export3dfmt.js).
//   node tests/test_bigout.mjs            prove veloci (JSON a pezzi, formati 3D piccoli confrontati con il testo atteso)
//   node tests/test_bigout.mjs --grande   in piu' un modello sintetico che produce uno STEP OLTRE 2 GB, scritto a pezzi su
//                                         disco (cartella temporanea, poi cancellato): controlla dimensione, numerazione,
//                                         chiusura del file e memoria usata; mostra che una stringa unica non ci starebbe
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const F = await import(pathToFileURL(path.join(ROOT, "ui/js/export3dfmt.js")).href);
// bigout.js importa core.js (pagina): qui serve solo jsonChunks, che e' autonomo -> si carica il testo del modulo senza import
const src = fs.readFileSync(path.join(ROOT, "ui/js/bigout.js"), "utf8").replace(/^import .*$/m, "const api = null;");
const B = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));

let ok = 0, ko = 0;
const check = (c, msg) => { if (c) ok++; else { ko++; console.log("ERRORE:", msg); } };

// ---------------------------------------------------------------- JSON a pezzi = JSON.stringify
const rep = (k, v) => (typeof v === "bigint" ? Number(v) : k === "xdata" || k === "acis" ? undefined : ArrayBuffer.isView(v) ? Array.from(v) : v);
const rep2 = (k, v) => (k === "xdata" || k === "acis" ? undefined : v);
const samples = [
  { a: 1, b: "x\"y\nè", c: [1, 2, { d: null, e: undefined, f: NaN }], g: true, xdata: [1, 2], h: new Float64Array([1.5, -2, 3e-9]), i: 12n },
  [undefined, () => 1, "s", [[]], {}],
  { entities: Array.from({ length: 5000 }, (_, i) => ({ type: "LINE", handle: i, start: { x: i, y: -i, z: 0 }, acis: "zzz", layer: "L" + (i % 7) })) },
  { date: new Date(0), nested: { deep: { deeper: [1, { x: "€" }] } } },
];
for (const [i, s] of samples.entries()) {
  const a = JSON.stringify(s, rep);
  const b = [...B.jsonChunks(s, rep2)].join("");
  check(a === b, `jsonChunks campione ${i}: ${b.slice(0, 120)} != ${a.slice(0, 120)}`);
}

// ---------------------------------------------------------------- formati 3D piccoli
const cube = () => { // cubo 1 m: 8 vertici, 12 triangoli (metri, Z in alto)
  const p = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
  const t = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { name: "Cubo 'A' è", type: "IfcWall", color: [0.5, 0.25, 1], opacity: 1, pos: Float64Array.from(p), idx: Uint32Array.from(t) };
};
const join = g => [...g].join("");
const step = join(F.stepChunks([cube()], "prova"));
check(step.startsWith("ISO-10303-21;\nHEADER;") && step.endsWith("ENDSEC;\nEND-ISO-10303-21;\n"), "STEP: intestazione/chiusura");
check((step.match(/=FACE_SURFACE\(/g) || []).length === 6, "STEP: un cubo = 6 facce piane");
check(step.includes("PRODUCT('Cubo ''A'' \\X2\\00E8\\X0\\'"), "STEP: nome con apostrofo e lettera accentata");
const ids = [...step.matchAll(/^#(\d+)=/gm)].map(m => +m[1]);
check(ids.every((v, i) => v === i + 1), "STEP: numerazione continua");
const ifc = join(F.ifcChunks([cube()], "prova"));
check(ifc.includes("IFCTRIANGULATEDFACESET(") && ifc.endsWith("END-ISO-10303-21;\n") && ifc.includes("IFCWALL("), "IFC: insieme di triangoli e classe");
const dxf = join(F.dxfChunks([cube()]));
check((dxf.match(/\r\n3DFACE\r\n/g) || []).length === 12 && dxf.endsWith("EOF\r\n"), "DXF: 12 facce 3DFACE");
const obj = join(F.objChunks([cube(), cube()], 1000));
check((obj.match(/^v /gm) || []).length === 16 && obj.includes("\nf 9 11 10\n") && obj.includes("v 1000 1000 -1000"), "OBJ: vertici, indici del secondo oggetto, scala e assi");
const wrl = join(F.vrmlChunks([cube()]));
check(wrl.startsWith("#VRML V2.0 utf8") && (wrl.match(/-1/g) || []).length >= 12, "VRML");
const mf = join(F.mf3ModelChunks([cube()]));
check(mf.includes('<object id="2"') && (mf.match(/<triangle /g) || []).length === 12 && mf.endsWith("</model>\n"), "3MF: modello");
// un elemento con piu' di 200.000 triangoli nell'IFC si divide in piu' insiemi
const big = { name: "grande", type: "", color: [1, 1, 1], opacity: 1, pos: new Float64Array(3 * 3 * 250000), idx: new Uint32Array(3 * 250000) };
for (let i = 0; i < 250000; i++) { big.pos.set([i, 0, 0, i, 1, 0, i, 0, 1], i * 9); big.idx.set([i * 3, i * 3 + 1, i * 3 + 2], i * 3); }
const ifcBig = join(F.ifcChunks([big], "g"));
check((ifcBig.match(/IFCTRIANGULATEDFACESET\(/g) || []).length === 2, "IFC: elemento grande diviso in 2 insiemi");

// ---------------------------------------------------------------- STEP oltre 2 GB a pezzi
if (process.argv.includes("--grande")) {
  const N = Number(process.env.MBV_ELEMENTI || 2600), G = 36; // griglia 36x36 con quote casuali: ogni triangolo e' una faccia
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  function* elements() { for (let e = 0; e < N; e++) yield mk(e); }
  function mk(e) {
    const pos = new Float64Array((G + 1) * (G + 1) * 3), idx = [];
    for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) pos.set([e * 50 + i, j, rnd()], (j * (G + 1) + i) * 3);
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) { const a = j * (G + 1) + i, b = a + 1, c = a + G + 1, d = c + 1; idx.push(a, b, d, a, d, c); }
    return { name: "elemento " + e, type: "IfcSlab", color: [rnd(), rnd(), rnd()], opacity: 1, pos, idx: Uint32Array.from(idx) };
  }
  // lista "pigra": stepChunks percorre gli elementi una volta sola, come fa con quelli raccolti dalla scena
  const lazy = { [Symbol.iterator]: elements, get length() { return N; } };
  const out = path.join(os.tmpdir(), "mbv-bigout-prova.stp");
  const ws = fs.createWriteStream(out, { highWaterMark: 1 << 24 });
  const t0 = Date.now();
  let bytes = 0, peak = 0, single = "", singleErr = null, lastId = 0, idsOk = true, pieces = 0;
  for (const s of F.stepChunks(lazy, "grande")) {
    pieces++;
    bytes += Buffer.byteLength(s);
    // "prima": lo stesso file come stringa unica (cosi' facevano toSTEP & co.) -> fermo al limite di V8
    if (!singleErr) { try { single += s; } catch (e) { singleErr = e; single = ""; } }
    for (const m of s.matchAll(/^#(\d+)=/gm)) { const v = +m[1]; if (v !== lastId + 1) idsOk = false; lastId = v; }
    if (!ws.write(s)) await new Promise(r => ws.once("drain", r));
    peak = Math.max(peak, process.memoryUsage().rss);
  }
  await new Promise(r => ws.end(r));
  const size = fs.statSync(out).size;
  const fd = fs.openSync(out, "r"), tail = Buffer.alloc(40);
  fs.readSync(fd, tail, 0, 40, size - 40);
  fs.closeSync(fd);
  fs.unlinkSync(out);
  console.log(`STEP sintetico: ${(size / 2 ** 30).toFixed(2)} GB in ${pieces} pezzi, ${lastId} entita', ${((Date.now() - t0) / 1000).toFixed(0)} s, memoria massima ${(peak / 2 ** 20).toFixed(0)} MB`);
  console.log(`  stringa unica (vecchio metodo): ${singleErr ? singleErr.name + ": " + singleErr.message : "riuscita (?)"}`);
  check(size > 2 * 2 ** 30 && size === bytes, "STEP > 2 GB scritto per intero");
  check(tail.toString("latin1").endsWith("ENDSEC;\nEND-ISO-10303-21;\n"), "STEP grande: chiusura del file");
  check(idsOk, "STEP grande: numerazione continua");
  check(peak < 3 * 2 ** 30, "STEP grande: memoria sotto 3 GB");
  check(singleErr && /Invalid string length/.test(singleErr.message), "la stringa unica si sarebbe fermata (RangeError)");
}
console.log(`${ok} prove riuscite, ${ko} fallite`);
process.exit(ko ? 1 : 0);
