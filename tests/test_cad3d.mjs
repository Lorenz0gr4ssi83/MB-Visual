// Collaudo della vista 3D dei DXF (senza browser): lettura delle entita' 3D con ui/js/dxf.js, riconoscimento con
// ui/js/cad3dscan.js, solidi ACIS -> STEP con il motore (mbvisual/cad3d.py) e triangolazione con occt-import-js.
//   python tools/make_cad3d_samples.py   (una volta)
//   node tests/test_cad3d.mjs [cartella con ui/vendor]   (per la triangolazione serve ui/vendor/occt)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(process.argv[2] || ROOT, "ui", "vendor");
const DIR = path.join(ROOT, "tests", "samples", "cad3d");
const { parseDxf } = await import(pathToFileURL(path.join(ROOT, "ui/js/dxf.js")).href);
const { analyze3d, ACIS_TYPES } = await import(pathToFileURL(path.join(ROOT, "ui/js/cad3dscan.js")).href);
const attesi = JSON.parse(fs.readFileSync(path.join(DIR, "attesi.json"), "utf8"));

let ok = 0, ko = 0;
const check = (cond, msg) => { if (cond) ok++; else { ko++; console.log("  NO:", msg); } };
const PY = process.env.MBV_PYTHON || "python";
let occt = null;
try { occt = await createRequire(import.meta.url)(path.join(VENDOR, "occt/dist/occt-import-js.js"))(); } catch { console.log("(occt-import-js non trovato: niente triangolazione)"); }

for (const [name, exp] of Object.entries(attesi)) {
  console.log(name);
  const db = parseDxf(fs.readFileSync(path.join(DIR, name), "utf8"));
  const sc = analyze3d(db);
  check(sc.mostly === exp.mostly, `prevalentemente 3D = ${sc.mostly}, atteso ${exp.mostly}`);
  if (exp.any === false) { check(!sc.any, "nessun contenuto 3D"); continue; }
  const all = [...db.entities, ...db.tables.BLOCK_RECORD.entries.flatMap(b => b.entities || [])];
  const n = t => all.filter(e => e.type === t).length;
  check(n("3DSOLID") === exp.solidi, `solidi ${n("3DSOLID")}`);
  check(n("MESH") === exp.mesh, `mesh ${n("MESH")}`);
  check(n("PFACE") === exp.polyface, `polyface ${n("PFACE")}`);
  check(n("PMESH") === exp.polymesh, `polygon mesh ${n("PMESH")}`);
  check(n("3DFACE") === exp.facce3d, `3dface ${n("3DFACE")}`);
  const pm = all.find(e => e.type === "PMESH");
  check(pm && pm.m === 4 && pm.n === 5 && pm.vertices.length === 20, "polygon mesh 4 x 5");
  const pf = all.find(e => e.type === "PFACE");
  check(pf && pf.faces.length >= 6 && pf.faces.every(f => f.length >= 3), "facce della polyface");
  const ms = all.find(e => e.type === "MESH");
  check(ms && ms.vertices.length === 5 && ms.faces.length === 5, "facce della MESH");
  check(all.some(e => e.type === "CIRCLE" && e.thickness === 1200), "spessore del cerchio");
  check(all.some(e => e.type === "LWPOLYLINE" && e.thickness === 2700 && e.elevation === 100), "spessore ed elevazione della polilinea");
  const solids = all.filter(e => ACIS_TYPES.has(e.type));
  check(solids.every(e => e.acis && (e.acis.sat ? /^\d+ \d+ \d+ \d+/.test(e.acis.sat) : new TextDecoder("latin1").decode(e.acis.sab.subarray(0, 14)) .startsWith("BinaryFile", 4) || new TextDecoder("latin1").decode(e.acis.sab.subarray(0, 15)) === "ACIS BinaryFile")), "dati ACIS di tutti i solidi (" + solids.map(e => e.acis ? (e.acis.sat ? "sat" : "sab") : "-").join(",") + ")");
  // motore Python: STEP per entita'
  const items = solids.map(e => ({ h: e.handle, ...(e.acis.sat ? { sat: e.acis.sat } : { sab: Buffer.from(e.acis.sab).toString("base64") }) }));
  const tmp = path.join(ROOT, "tests", "samples", "cad3d", ".items.json");
  fs.writeFileSync(tmp, JSON.stringify(items));
  let res;
  try {
    res = JSON.parse(execFileSync(PY, ["-c", "import json,sys; sys.path.insert(0, sys.argv[2]); from mbvisual import cad3d; print(json.dumps(cad3d.convert('', json.load(open(sys.argv[1])))))", tmp, ROOT], { maxBuffer: 1 << 28 }).toString());
  } finally { fs.unlinkSync(tmp); }
  const S = res.solids;
  check(Object.values(S).every(s => s.ok), "tutti i solidi convertiti in STEP");
  if (!occt) continue;
  const box = Object.values(S).map(s => {
    const r = occt.ReadStepFile(new TextEncoder().encode(s.step), { linearUnit: "millimeter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.001, angularDeflection: 0.5 });
    const a = [Infinity, Infinity, Infinity], b = [-Infinity, -Infinity, -Infinity];
    for (const m of r.meshes || []) { const p = m.attributes.position.array; for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { a[k] = Math.min(a[k], p[i + k]); b[k] = Math.max(b[k], p[i + k]); } }
    return { a, b, n: (r.meshes || []).length };
  });
  check(box.every(x => x.n > 0), "tutti i solidi triangolati");
  if (process.env.MBV_DEBUG) console.log(JSON.stringify(box));
  const main = exp.solido_principale;
  check(box.some(x => x.a.every((v, k) => Math.abs(v - main.min[k]) < 1e-3) && x.b.every((v, k) => Math.abs(v - main.max[k]) < 1e-3)), "ingombro del parallelepipedo 2000 x 1000 x 500 nelle unita' del disegno");
}
console.log(`\n${ok} prove riuscite, ${ko} fallite`);
process.exit(ko ? 1 : 0);
