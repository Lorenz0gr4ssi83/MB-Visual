// Layout dei disegni (ui/js/viewers/cad2d.js, ui/js/dxf.js): fogli, limiti e finestre di un DXF scritto con ezdxf, matrice modello -> foglio
// confrontata con quella di ezdxf, finestra del foglio esclusa, layer congelati, viste 3D. Interfaccia provata a parte nell'app.
//   node tests/test_cad_layout.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PY = process.env.MBV_PYTHON || path.join(os.homedir(), ".mbvisual", "venv", "Scripts", "python.exe");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mbv-layout-"));
const dxf = path.join(dir, "fogli.dxf");
const expected = JSON.parse(execFileSync(PY, ["-c", `
import ezdxf, json, math, sys
d = ezdxf.new("R2018", setup=True)
d.layers.add("TAGLI"); d.layers.add("NOTE")
m = d.modelspace(); m.add_line((0, 0), (1000, 500), dxfattribs={"layer": "TAGLI"})
a = d.layouts.new("Pianta"); a.page_setup(size=(420, 297), margins=(10, 10, 10, 10), units="mm")
a.add_line((0, 0), (100, 0), dxfattribs={"layer": "NOTE"})
v1 = a.add_viewport(center=(100, 100), size=(180, 120), view_center_point=(500, 250), view_height=1200)
v1.frozen_layers = ["TAGLI"]
v2 = a.add_viewport(center=(300, 100), size=(100, 100), view_center_point=(50, 60), view_height=500)
v2.dxf.view_twist_angle = 30; v2.dxf.view_target_point = (5, 7, 0)
v3 = a.add_viewport(center=(300, 230), size=(100, 80), view_center_point=(0, 0), view_height=500)
v3.dxf.view_direction_vector = (1, -1, 1)
d.layouts.new("Vuoto")
d.saveas(sys.argv[1])
d = ezdxf.readfile(sys.argv[1])
out = {}
for n in d.layouts.names_in_taborder():
    if n == "Model": continue
    L = d.layouts.get(n)
    vps = sorted((e for e in L if e.dxftype() == "VIEWPORT"), key=lambda e: int(e.dxf.handle, 16))
    out[n] = {"limmin": list(L.dxf.limmin)[:2], "limmax": list(L.dxf.limmax)[:2], "vps": [[list(map(float, e.get_transformation_matrix().transform((x, y, 0))))[:2] for x, y in ((0, 0), (1000, 0), (0, 1000))] for e in vps[1:]]}
print(json.dumps(out))
`, dxf]).toString());

// il visualizzatore importa moduli dell'interfaccia: bastano i pochi oggetti del browser che leggono all'avvio
globalThis.document ??= { documentElement: { classList: { contains: () => false, add() {} }, dataset: {} }, createElement: () => ({ style: {} }), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
globalThis.window ??= globalThis;
globalThis.localStorage ??= { getItem: () => null, setItem() {} };
globalThis.addEventListener ??= () => {};
globalThis.Path2D ??= class { moveTo() {} lineTo() {} closePath() {} };
const { parseDxf } = await import(pathToFileURL(path.join(ROOT, "ui/js/dxf.js")).href);
const { normalize, sheetsOf, sheetViewports, buildModel } = await import(pathToFileURL(path.join(ROOT, "ui/js/viewers/cad2d.js")).href);

let bad = 0, good = 0;
const ok = (name, cond, info = "") => { if (cond) good++; else bad++; console.log((cond ? "ok   " : "FAIL ") + name + (info !== "" ? `  [${info}]` : "")); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

const db = normalize(parseDxf(fs.readFileSync(dxf, "utf8")), "dxf");
const sheets = sheetsOf(db);
const names = sheets.map(s => s.name);
ok("fogli nell'ordine delle schede", names.join() === Object.keys(expected).join(), names.join());
const P = sheets.find(s => s.name === "Pianta");
ok("limiti del foglio", near(P.layout.minLimit.x, expected.Pianta.limmin[0]) && near(P.layout.maxLimit.y, expected.Pianta.limmax[1]));
const vps = sheetViewports(P.ents, db);
ok("la finestra del foglio stesso non conta", vps.length === 3, String(vps.length));
vps.forEach((v, i) => {
  if (!v.plan) return;
  const pts = [[0, 0], [1000, 0], [0, 1000]].map(([x, y]) => [v.M[0] * x + v.M[2] * y + v.M[4], v.M[1] * x + v.M[3] * y + v.M[5]]);
  const exp = expected.Pianta.vps[i];
  ok(`finestra ${i + 1}: modello -> foglio uguale a ezdxf`, pts.every((p, k) => near(p[0], exp[k][0], 1e-6) && near(p[1], exp[k][1], 1e-6)), JSON.stringify(pts[1]));
});
ok("layer congelato nella finestra", vps[0].frozen.has("TAGLI") && !vps[1].frozen.has("TAGLI"));
ok("vista 3D riconosciuta", vps[2].plan === false && vps[0].plan === true);
const paper = buildModel({ ...db, entities: P.ents }, true);
ok("il modello del foglio contiene le sue entita'", paper.items.length > 0 && paper.layers.get("NOTE").count === 1);
const main = buildModel(db);
ok("il modello non contiene le entita' del foglio", main.layers.get("TAGLI").count === 1 && !main.layers.get("NOTE")?.count);
ok("foglio vuoto presente", sheets.some(s => s.name === "Vuoto"));
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${good} riuscite, ${bad} fallite`);
process.exit(bad ? 1 : 0);
