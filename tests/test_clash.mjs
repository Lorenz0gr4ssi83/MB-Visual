// Collaudo delle funzioni di Navisworks Manage (interferenze, computo, stati, file .mbvnav) senza browser:
//   node tests/test_clash.mjs
// Legge gli IFC di tests/samples/interferenze (python tools/make_clash_samples.py) con web-ifc (ui/vendor) come fa il
// visualizzatore 3D, esegue le verifiche con ui/js/clashcore.js e il computo con ui/js/qtocore.js.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const C = await import(pathToFileURL(path.join(ROOT, "ui/js/clashcore.js")).href);
const Q = await import(pathToFileURL(path.join(ROOT, "ui/js/qtocore.js")).href);
const NAV = await import(pathToFileURL(path.join(ROOT, "ui/js/navdoc.js")).href);
const G = await import(pathToFileURL(path.join(ROOT, "tests/clash_geom.mjs")).href);

let fails = 0, passes = 0;
function check(name, ok, info = "") {
  if (ok) passes++; else fails++;
  console.log(`${ok ? "OK  " : "ERR "} ${name}${info ? "  (" + info + ")" : ""}`);
}
const near = (a, b, e) => Math.abs(a - b) <= e;

// ---------------------------------------------------------------- 1. solidi sintetici
{
  const mk = (id, g) => C.prepare({ id, ...g, inA: true, inB: true, model: 0 });
  const A = mk(1, G.box(0, 0, 0, 1, 1, 1));
  const r1 = C.hardClash(A, mk(2, G.box(0.9, 0.2, 0.2, 1.9, 0.8, 0.8)), 0);
  check("scatole compenetrate 0,1", r1 && near(r1.dist, 0.1, 1e-4), r1?.dist);
  check("scatole appoggiate: nessuna compenetrazione", !C.hardClash(A, mk(3, G.box(1, 0, 0, 2, 1, 1)), 0));
  check("scatole staccate: nessuna compenetrazione", !C.hardClash(A, mk(4, G.box(1.05, 0, 0, 2, 1, 1)), 0));
  const r2 = C.clearanceClash(A, mk(5, G.box(1.05, 0, 0, 2, 1, 1)), 0.1);
  check("distanza minima 0,05 < 0,1", r2 && near(r2.dist, 0.05, 1e-5), r2?.dist);
  check("distanza 0,05 non segnalata con 0,04", !C.clearanceClash(A, mk(6, G.box(1.05, 0, 0, 2, 1, 1)), 0.04));
  const r3 = C.hardClash(A, mk(7, G.box(0.3, 0.3, 0.3, 0.6, 0.6, 0.6)), 0);
  check("elemento tutto dentro l'altro", r3 && r3.inside && near(r3.dist, 0.4, 1e-4), r3?.dist);
  const r4 = C.hardClash(A, mk(8, G.cylinder(-1, 0.5, 0.5, "x", 0.1, 3)), 0.01);
  check("tubo che attraversa un blocco", r4 && r4.dist > 0.35, r4?.dist);
  check("duplicato esatto", !!C.duplicateClash(A, mk(9, G.box(0, 0, 0, 1, 1, 1)), 0.001));
  check("non duplicato", !C.duplicateClash(A, mk(10, G.box(0, 0, 0, 1, 1, 1.01)), 0.001));
  const g = C.groupClashes([[0, 0, 0], [0.5, 0, 0], [5, 5, 5], [0.9, 0, 0]], 0.6);
  check("raggruppamento per vicinanza", g[0] === g[1] && g[1] === g[3] && g[2] === -1, Array.from(g).join(","));
}

// ---------------------------------------------------------------- 2. stati tra esecuzioni
{
  const r1 = C.mergeRun([], [{ key: "a|b" }, { key: "c|d" }], "d1");
  check("prima esecuzione: tutte nuove", r1.every(c => c.status === "new") && r1.map(c => c.num).join() === "1,2");
  r1[1].status = "approved";
  const r2 = C.mergeRun(r1, [{ key: "a|b" }, { key: "c|d" }, { key: "e|f" }], "d2");
  const st = Object.fromEntries(r2.map(c => [c.key, c.status + c.num]));
  check("seconda esecuzione: attiva, approvata resta, nuova", st["a|b"] === "active1" && st["c|d"] === "approved2" && st["e|f"] === "new3", JSON.stringify(st));
  const r3 = C.mergeRun(r2, [{ key: "e|f" }], "d3");
  const s3 = Object.fromEntries(r3.map(c => [c.key, c.status]));
  check("terza esecuzione: scomparse = risolte", s3["a|b"] === "resolved" && s3["c|d"] === "resolved" && s3["e|f"] === "active", JSON.stringify(s3));
}

// ---------------------------------------------------------------- 3. IFC di prova (struttura + impianti federati)
const VENDOR = path.join(ROOT, "ui/vendor/web-ifc");
const origFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => (String(u).endsWith(".wasm") ? new Response(fs.readFileSync(String(u)), { headers: { "Content-Type": "application/wasm" } }) : origFetch(u, o));
const W = await import(pathToFileURL(path.join(VENDOR, "web-ifc-api.js")).href);
const ifc = new W.IfcAPI();
ifc.SetWasmPath(VENDOR.replace(/\\/g, "/") + "/", true);
await ifc.Init(undefined, true);
ifc.SetLogLevel?.(6);

const SAMPLES = path.join(ROOT, "tests/samples/interferenze");
const els = [], tagOf = new Map(), models = [];
let shift = null;
function loadIfc(file, model) {
  // come ui/js/viewers/model3d.js: il primo modello va all'origine, gli altri con lo stesso spostamento
  const mid = ifc.OpenModel(fs.readFileSync(path.join(SAMPLES, file)), { COORDINATE_TO_ORIGIN: !shift });
  const ids = [];
  ifc.StreamAllMeshes(mid, fm => {
    const pos = [], idx = [];
    for (let k = 0; k < fm.geometries.size(); k++) {
      const pg = fm.geometries.get(k);
      const geo = ifc.GetGeometry(mid, pg.geometryExpressID);
      const v = ifc.GetVertexArray(geo.GetVertexData(), geo.GetVertexDataSize());
      const ix = ifc.GetIndexArray(geo.GetIndexData(), geo.GetIndexDataSize());
      const m = pg.flatTransformation.slice();
      if (shift) { // m = shift * m
        const r = new Array(16).fill(0);
        for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k2 = 0; k2 < 4; k2++) r[j * 4 + i] += shift[k2 * 4 + i] * m[j * 4 + k2];
        m.splice(0, 16, ...r);
      }
      const base = pos.length / 3;
      for (let i = 0; i < v.length; i += 6) {
        const x = v[i], y = v[i + 1], z = v[i + 2];
        pos.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
      }
      for (const i of ix) idx.push(base + i);
    }
    const id = els.length + 1;
    els.push(C.prepare({ id, pos: new Float32Array(pos), idx: new Uint32Array(idx), model, inA: false, inB: false }));
    tagOf.set(id, ifc.GetLine(mid, fm.expressID).Tag?.value || "#" + fm.expressID);
    ids.push(fm.expressID);
  });
  if (!shift) shift = Array.from(ifc.GetCoordinationMatrix(mid));
  models.push({ mid, name: file, ids });
}
loadIfc("struttura.ifc", 0);
loadIfc("impianti.ifc", 1);
check("IFC letti", els.length === 15, els.length + " elementi");

const pairsOf = res => res.map(r => [tagOf.get(r.a), tagOf.get(r.b)].sort().join("-")).sort();
function run(setA, setB, opts) {
  for (const e of els) { e.inA = setA(e); e.inB = setB(e); }
  const t0 = performance.now();
  const r = C.runTest(els, opts);
  r.ms = performance.now() - t0;
  return r;
}
const STR = e => e.model === 0, IMP = e => e.model === 1, ALL = () => true;
{
  const r = run(STR, IMP, { type: "hard", tolerance: 0.01 });
  const p = pairsOf(r.results);
  check("compenetrazione struttura/impianti", p.join() === "B1-D1,B2-D1,P1-W3,P1-W4", p.join());
  const d = r.results.find(x => pairsOf([x])[0] === "P1-W3");
  check("profondita' tubo nel muro ~0,15 m", d && near(d.dist, 0.15, 0.01), d?.dist);
  const grp = C.groupClashes(r.results.map(x => x.point), 2.5);
  const gOf = tag => grp[r.results.findIndex(x => pairsOf([x])[0] === tag)];
  check("canale con le due travi nello stesso gruppo, tubi da soli", gOf("B1-D1") >= 0 && gOf("B1-D1") === gOf("B2-D1") && gOf("P1-W3") === -1 && gOf("P1-W4") === -1);
}
{
  const r = run(STR, STR, { type: "hard", tolerance: 0.01 });
  const p = pairsOf(r.results);
  check("compenetrazione dentro la struttura (trave nei muri)", p.join() === "B2-W3,B2-W4", p.join());
  check("profondita' trave nel muro 0,15 m", r.results.every(x => near(x.dist, 0.15, 0.005)), r.results.map(x => x.dist.toFixed(4)).join());
}
{
  const r = run(IMP, STR, { type: "clearance", tolerance: 0.05 });
  const p = pairsOf(r.results);
  check("distanza minima 5 cm", p.join() === "B1-D1,B2-D1,B2-P2,P1-W3,P1-W4", p.join());
  const c = r.results.find(x => pairsOf([x])[0] === "B2-P2");
  check("tubo P2 a 3 cm dalla trave", c && near(c.dist, 0.03, 0.002), c?.dist);
}
{
  const r = run(STR, STR, { type: "duplicate", tolerance: 0.001 });
  check("duplicati", pairsOf(r.results).join() === "C2-C3", pairsOf(r.results).join());
  const r2 = run(ALL, ALL, { type: "hard", tolerance: 0.01, skipSameModel: true });
  check("ignora coppie dello stesso modello", pairsOf(r2.results).join() === "B1-D1,B2-D1,P1-W3,P1-W4", pairsOf(r2.results).join());
}

// ---------------------------------------------------------------- 4. computo delle quantita'
{
  const rows = Q.takeoff(ifc, W, models.map(m => ({ mid: m.mid, name: m.name })), mid => models.find(m => m.mid === mid).ids);
  const walls = rows.filter(r => r.cls.toUpperCase() === "IFCWALL");
  const vol = walls.reduce((s, r) => s + r.volume, 0);
  check("computo: 4 muri, volume 46,56 m³", walls.length === 4 && near(vol, 46.56, 1e-6), `${walls.length} muri, ${vol}`);
  check("computo: area laterale dei muri dalla Qto", near(walls.reduce((s, r) => s + r.area, 0), (12 + 12 + 7.4 + 7.4) * 4, 1e-6));
  check("computo: tipi e livelli", walls.every(r => r.type === "Muro c.a. 30 cm" && r.level === "Piano terra") && rows.find(r => r.tag === "S1")?.level === "Piano primo");
  const tree = Q.groupRows(rows, ["level", "cls", "type"]);
  check("raggruppamento per livello (ordinato per quota)", tree.children.map(c => c.label).join() === "Piano terra,Piano primo", tree.children.map(c => c.label).join());
  const pipes = rows.filter(r => r.cls.toUpperCase() === "IFCPIPESEGMENT");
  check("computo impianti: lunghezza tubi 33 m", near(pipes.reduce((s, r) => s + r.length, 0), 33, 1e-6));
  check("conteggio totale elementi", tree.count === 15, tree.count);
}

// ---------------------------------------------------------------- 5. file .mbvnav
{
  const doc = NAV.newDoc(["struttura.ifc", "impianti.ifc"]);
  doc.views.push({ guid: "v1", name: "Vista 1", vi: { camera: { kind: "persp", pos: [1, 2, 3], dir: [0, 0, -1], up: [0, 1, 0], fov: 45 }, selection: [], visibility: { default: true, exceptions: [] }, coloring: [], planes: [], lines: [] }, dist: 5 });
  doc.clashTests.push({ ...NAV.newTest("Test 1"), clashes: [{ key: "a|b", num: 1, status: "reviewed", dist: 0.1, point: [0, 0, 0], a: { key: "g:x", name: "A" }, b: { key: "g:y", name: "B" } }] });
  const back = NAV.parseDoc(NAV.serializeDoc(doc));
  check("file .mbvnav: andata e ritorno", back.views[0].name === "Vista 1" && back.clashTests[0].clashes[0].status === "reviewed" && back.models.length === 2);
  let bad = false;
  try { NAV.parseDoc('{"format":"altro"}'); } catch { bad = true; }
  check("file .mbvnav: rifiuta altri JSON", bad);
}

// ---------------------------------------------------------------- 6. prestazioni: 20.000 elementi
{
  const big = [];
  let id = 0;
  // griglia di pilastri e travi (si toccano), con 200 tubi che attraversano le travi
  for (let i = 0; i < 100; i++) for (let j = 0; j < 100; j++) {
    big.push(C.prepare({ id: ++id, ...G.box(i * 5, j * 5, 0, i * 5 + 0.4, j * 5 + 0.4, 3), model: 0, inA: true, inB: true }));
    big.push(C.prepare({ id: ++id, ...G.box(i * 5 + 0.4, j * 5, 2.4, i * 5 + 5, j * 5 + 0.4, 3), model: 0, inA: true, inB: true }));
  }
  for (let k = 0; k < 200; k++) big.push(C.prepare({ id: ++id, ...G.cylinder(k * 2.5 + 0.3, -1, 2.7, "y", 0.08, 502, 16), model: 1, inA: false, inB: true }));
  const t0 = performance.now();
  const r = C.runTest(big, { type: "hard", tolerance: 0.001, maxResults: 100000 });
  const ms = performance.now() - t0;
  check("20.200 elementi: tempo ragionevole", ms < 60000, `${(ms / 1000).toFixed(1)} s, ${r.candidates} coppie, ${r.results.length} interferenze`);
  check("20.200 elementi: solo i 20.000 passaggi dei tubi (pilastri e travi si toccano)", r.results.length === 20000, r.results.length);
}

console.log(`\n${passes} riuscite, ${fails} non riuscite`);
process.exit(fails ? 1 : 0);
