// Collaudo delle misure ed estrazioni (ui/js/measure/) senza browser:
//   python tools/make_measure_samples.py   (file di prova in tests/samples/misure, valori attesi in attesi.json)
//   node tests/test_measure.mjs
// 1. nucleo (mcore.js): geometria, scale, taratura, quantita', raggruppamenti, CSV, .mbmis
// 2. DXF di prova letto con il lettore e il modello veri del visualizzatore (dxf.js + cad2d.js build) -> estrazioni (mextract.js)
// 3. IFC di prova letto con web-ifc come fa il visualizzatore 3D -> volumi/superfici per elemento, materiale e livello,
//    sezione orizzontale con area (mcore.js meshQuantities / sectionSegments / sectionArea)
// 4. tracciati vettoriali (DWF/PDF): lunghezze/aree per stile e simboli uguali (mextract.js)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLES = path.join(ROOT, "tests/samples/misure");
const EXP = JSON.parse(fs.readFileSync(path.join(SAMPLES, "attesi.json"), "utf8"));
// ambiente minimo del browser per i moduli dell'interfaccia
globalThis.window ??= globalThis;
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document ??= { documentElement: { lang: "it" }, addEventListener() {}, createElement: () => ({ style: {}, append() {}, addEventListener() {}, getContext: () => ({ font: "", measureText: s => ({ width: String(s).length * 55 }) }) }), querySelector: () => null, querySelectorAll: () => [], head: { append() {} }, body: { append() {} } };
globalThis.Path2D ??= class { moveTo() {} lineTo() {} closePath() {} };
globalThis.fetch = (orig => async (u, o) => (String(u).endsWith(".wasm") ? new Response(fs.readFileSync(String(u)), { headers: { "Content-Type": "application/wasm" } }) : String(u).startsWith("/") ? new Response("{}", { status: 404 }) : orig(u, o)))(globalThis.fetch);
const imp = p => import(pathToFileURL(path.join(ROOT, p)).href);
const C = await imp("ui/js/measure/mcore.js");
const X = await imp("ui/js/measure/mextract.js");

let fails = 0, passes = 0;
function check(name, ok, info = "") {
  if (ok) passes++; else fails++;
  console.log(`${ok ? "OK  " : "ERR "} ${name}${info !== "" ? "  (" + info + ")" : ""}`);
}
const near = (a, b, rel = 1e-6, abs = 1e-9) => a != null && Math.abs(a - b) <= Math.max(abs, Math.abs(b) * rel);

// ---------------------------------------------------------------- 1. nucleo
{
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  check("area quadrato", near(C.polyArea(sq), 100));
  check("perimetro chiuso", near(C.polyLen(sq, true), 40));
  check("regione con foro (dispari = foro)", near(C.regionArea([sq, [[2, 2], [4, 2], [4, 4], [2, 4]]]), 96));
  check("regione con isola dentro il foro", near(C.regionArea([sq, [[1, 1], [9, 1], [9, 9], [1, 9]], [[4, 4], [6, 4], [6, 6], [4, 6]]]), 36 + 4));
  check("area poligono 3D inclinato", near(C.polyArea([[0, 0, 0], [3, 0, 0], [3, 4, 4], [0, 4, 4]]), 3 * Math.hypot(4, 4)));
  check("angolo 90", near(C.angleAt([1, 0], [0, 0], [0, 1]), 90));
  check("angolo 3D 60", near(C.angleAt([1, 0, 0], [0, 0, 0], [0.5, Math.sqrt(3) / 2, 0]), 60, 1e-9));
  const c = C.circle3([5, 0], [0, 5], [-5, 0]);
  check("cerchio per 3 punti", near(c.r, 5) && near(c.cx, 0, 0, 1e-9));
  check("cerchio 3D per 3 punti", near(C.circle3d([0, 0, 7], [0, 7, 0], [0, -7, 0]).r, 7));
  const s = C.ratioScale(100, "m");
  check("scala 1:100 in metri per punto", near(s.k, 100 * 0.0254 / 72) && s.label === "1:100");
  const cal = C.calibrate([0, 0], [283.4646, 0], 10, "m");
  check("taratura 10 m su 283,46 pt = 1:100", near(cal.k * 283.4646, 10) && cal.label === "1:100", cal.label);
  check("scale lette dai testi", JSON.stringify(C.parseScales("TAV. 3 - SCALA 1:50").map(x => x.N)) === "[50]");
  check("rapporti non di scala ignorati senza parola", C.parseScales("Data 12/10/2026").every(x => !x.strong));
  // documento con scala per pagina e riquadro
  const doc = C.newDoc("prova.pdf", { k: C.PT / 0.001, unit: "mm" });
  doc.scales.push({ id: "a", page: 0, k: s.k, unit: "m", label: "1:100" }, { id: "b", page: 0, box: [0, 0, 100, 100], k: C.ratioScale(20, "m").k, unit: "m", label: "1:20" });
  doc.disp = { unit: "m", digits: 2 };
  const L = 283.4646; // 10 m a 1:100
  const r1 = C.row({ type: "len", page: 0, pts: [[200, 200], [200 + L, 200]] }, doc);
  check("lunghezza con la scala della pagina", near(r1.qty, 10, 1e-6) && r1.unit === "m", r1.qty);
  const r2 = C.row({ type: "len", page: 0, pts: [[10, 10], [10 + L, 10]] }, doc);
  check("lunghezza con la scala del riquadro (1:20)", near(r2.qty, 2, 1e-6), r2.qty);
  const k = 28.3464567; // 1 m a 1:100
  const ar = C.row({ type: "area", page: 0, pts: [[200, 200], [200 + 5 * k, 200], [200 + 5 * k, 200 + 4 * k], [200, 200 + 4 * k]], holes: [[[300, 300], [300 + k, 300], [300 + k, 300 + k], [300, 300 + k]]], price: 25 }, doc);
  check("area 5 x 4 m con foro 1 x 1 = 19 m2", near(ar.qty, 19, 1e-5), ar.qty);
  check("perimetro dell'area = 18 m", near(ar.len, 18, 1e-5), ar.len);
  check("importo = 19 x 25", near(ar.amount, 475, 1e-5), ar.amount);
  const vo = C.row({ type: "vol", page: 0, pts: [[200, 200], [200 + 5 * k, 200], [200 + 5 * k, 200 + 4 * k], [200, 200 + 4 * k]], h: 3 }, doc);
  check("volume 20 m2 x 3 m = 60 m3", near(vo.qty, 60, 1e-5), vo.qty);
  doc.disp.unit = "cm";
  check("unita' mostrate in cm (area in cm2)", near(C.row({ type: "area", page: 0, pts: [[200, 200], [200 + k, 200], [200 + k, 200 + k], [200, 200 + k]] }, doc).qty, 10000, 1e-5));
  doc.disp.unit = "m";
  doc.ref = { y: 200, value: 3.2 };
  check("quota di livello dal riferimento", near(C.row({ type: "elev", page: 0, pts: [[300, 200 + k]] }, doc).qty, 4.2, 1e-5));
  check("raggio da 3 punti (scala 1:100)", near(C.row({ type: "rad", page: 0, pts: [[400, 300], [300, 400], [200, 300]] }, doc).qty, 100 * s.k, 1e-6));
  check("conteggio", C.row({ type: "count", page: 0, pts: [[1, 1], [2, 2], [3, 3]], price: 10 }, doc).amount === 30);
  // raggruppamento e totali: si sommano solo le quantita' principali
  const rows = [r1, ar, vo, C.row({ type: "count", page: 0, pts: [[1, 1], [2, 2]], voce: "Prese" }, doc)];
  rows.forEach((r, i) => (r.m.voce ||= i < 2 ? "A" : "B"));
  const T = C.groupRows(rows, ["voce", "type"]);
  check("totali: lunghezza solo delle misure lineari", near(T.len, 10 + 0, 1e-5), T.len);
  check("totali: area e volume", near(T.area, 19, 1e-5) && near(T.vol, 60, 1e-5));
  check("totali: importo", near(T.amount, 475, 1e-5));
  check("gruppi per voce", T.children.map(c => c.label).sort().join() === "A,B,Prese", T.children.map(c => c.label).join());
  const csv = C.toCsv([[1.5, "a;b", null]], ["x", "y", "z"], "it-IT");
  check("CSV con BOM, virgola decimale e campi tra virgolette", csv === "﻿x;y;z\r\n1,5;\"a;b\";");
  const back = C.parse(C.serialize({ ...doc, items: rows.map(r => r.m) }), "prova.pdf");
  check(".mbmis: salva e rilegge", back.items.length === 4 && back.scales.length === 2 && near(C.row(back.items[1], back).qty, 19, 1e-5), `${back.items.length} ${back.scales.length} ${C.row(back.items[1], back).qty}`);
  // mesh: cubo 2x2x2 (12 triangoli)
  const V = [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0, 0, 0, 2, 2, 0, 2, 2, 2, 2, 0, 2, 2];
  const F = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  const q = C.meshQuantities(V, F, null);
  check("cubo: volume 8, superficie 24", near(q.vol, 8) && near(q.area, 24), `${q.vol} ${q.area}`);
  const M = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1];
  check("cubo spostato: stesso volume", near(C.meshQuantities(V, F, M).vol, 8));
  const pf = C.planarFace(V, F, null, 0);
  check("faccia piana del cubo = 4 (due triangoli)", near(pf.area, 4) && pf.tris.length === 2, pf.area);
  const sec = C.sectionArea(C.sectionSegments(V, F, null, { n: [0, 0, 1], d: -1 }), { n: [0, 0, 1], d: -1 }, 1e-6);
  check("sezione del cubo a z=1: 4", near(sec.area, 4, 1e-9) && near(sec.perimeter, 8, 1e-9), sec.area);
  const pts = new Float32Array([0, 0, 0, 1, 2, 0, 0, 1, 1, 1, 1, 1]);
  check("volume della nuvola sopra la base (griglia: 0 + 2 + 1 + 1)", near(C.gridVolume(pts, 1, 0).vol, 4, 1e-6));
}

// ---------------------------------------------------------------- 2. DXF di prova con il modello del visualizzatore CAD
{
  const { parseDxf } = await imp("ui/js/dxf.js");
  const cad = await imp("ui/js/viewers/cad2d.js");
  const db = cad.normalize(parseDxf(fs.readFileSync(path.join(SAMPLES, "pianta_mm.dxf"), "utf8")), "dxf");
  const model = cad.buildModel(db);
  const E = EXP.dxf;
  check("DXF: unita' da $INSUNITS = mm", C.INSUNITS[model.header.INSUNITS] === "mm", model.header.INSUNITS);
  const L = X.cadLengths(model, db);
  const byLayer = {};
  for (const r of L.records) byLayer[r.g.layer] = (byLayer[r.g.layer] || 0) + r.len;
  check("DXF: lunghezza layer MURI (rettangolo + cerchio + arco)", near(byLayer.MURI, E.MURI_len_mm, 2e-4), byLayer.MURI?.toFixed(2) + " / " + E.MURI_len_mm.toFixed(2));
  check("DXF: lunghezza layer TUBI = 10000", near(byLayer.TUBI, E.TUBI_len_mm, 1e-9), byLayer.TUBI);
  check("DXF: tipo linea dei TUBI = dashed", L.records.find(r => r.g.layer === "TUBI")?.g.lt === "dashed", L.records.find(r => r.g.layer === "TUBI")?.g.lt);
  check("DXF: quote escluse dalle lunghezze", !L.records.some(r => r.g.type === "DIMENSION"));
  const A = X.cadAreas(model);
  const hatch = A.records.find(r => r.g.kind === "HATCH");
  check("DXF: area del retino con foro = 23 m2", near(hatch?.area, E.PAVIMENTO_area_mm2, 1e-9), hatch?.area);
  const rect = A.records.find(r => r.g.layer === "MURI" && r.g.kind === "LWPOLYLINE");
  check("DXF: area polilinea chiusa = 20 m2", near(rect?.area, E.chiuse_area_mm2.rett, 1e-9), rect?.area);
  const circ = A.records.find(r => r.g.kind === "CIRCLE");
  check("DXF: area cerchio r 500", near(circ?.area, E.chiuse_area_mm2.cerchio, 1e-3), circ?.area?.toFixed(1));
  const B = X.cadBlocks(model, db);
  const cnt = {};
  for (const r of B.records) cnt[r.g.name] = (cnt[r.g.name] || 0) + r.count;
  check("DXF: 16 SEDIA (12 + 2 per ognuno dei 2 GRUPPO)", cnt.SEDIA === E.SEDIA, cnt.SEDIA);
  check("DXF: 3 TAVOLO e 2 GRUPPO", cnt.TAVOLO === E.TAVOLO && cnt.GRUPPO === E.GRUPPO, `${cnt.TAVOLO} ${cnt.GRUPPO}`);
  const T = X.cadTexts(model, db);
  check("DXF: testi e quote", T.some(r => r.text === "SOGGIORNO" && r.kind === "testo") && T.some(r => r.text === "+0.00" && r.kind === "livello") && T.some(r => r.dim && Math.abs(r.value - 5000) < 1e-6), T.map(r => r.text).join("|"));
  // scala del documento CAD = unita' del file: 20 m2 in m2 nelle unita' mostrate
  const doc = C.newDoc("pianta_mm.dxf", { k: 1, unit: "mm" });
  doc.disp = { unit: "m", digits: 2 };
  check("DXF: area convertita in m2 nel pannello", near(C.row({ type: "area", page: null, pts: rect.shape.pts.slice(0, -1) }, doc).qty, 20, 1e-9));
}

// ---------------------------------------------------------------- 3. IFC di prova (web-ifc come il visualizzatore 3D)
{
  const W = await imp("ui/vendor/web-ifc/web-ifc-api.js");
  const Q = await imp("ui/js/qtocore.js");
  const ifc = new W.IfcAPI();
  ifc.SetWasmPath(path.join(ROOT, "ui/vendor/web-ifc") + path.sep, true);
  await ifc.Init(undefined, true);
  const mid = ifc.OpenModel(new Uint8Array(fs.readFileSync(path.join(SAMPLES, "edificio.ifc"))), { COORDINATE_TO_ORIGIN: false });
  const per = new Map();
  ifc.StreamAllMeshes(mid, fm => {
    for (let i = 0; i < fm.geometries.size(); i++) {
      const pg = fm.geometries.get(i);
      const g = ifc.GetGeometry(mid, pg.geometryExpressID);
      const v = ifc.GetVertexArray(g.GetVertexData(), g.GetVertexDataSize()), idx = ifc.GetIndexArray(g.GetIndexData(), g.GetIndexDataSize());
      const pos = new Float32Array(v.length / 2);
      for (let k = 0; k < v.length / 6; k++) { pos[3 * k] = v[6 * k]; pos[3 * k + 1] = v[6 * k + 1]; pos[3 * k + 2] = v[6 * k + 2]; }
      const q = C.meshQuantities(pos, idx, pg.flatTransformation);
      const r = per.get(fm.expressID) || { vol: 0, area: 0, segs: [] };
      r.vol += Math.abs(q.signed); r.area += q.area;
      C.sectionSegments(pos, idx, pg.flatTransformation, { n: [0, 1, 0], d: -1.5 }, r.segs); // web-ifc: Y verso l'alto
      per.set(fm.expressID, r);
      g.delete?.();
    }
  });
  const name = id => { try { return ifc.GetLine(mid, id, false).Name?.value; } catch { return ""; } };
  // materiali e livelli come nel pannello (m3d.js ifcMaterials, qtocore.levelMap)
  const mats = new Map();
  const rels = ifc.GetLineIDsWithType(mid, W.IFCRELASSOCIATESMATERIAL);
  for (let k = 0; k < rels.size(); k++) { const r = ifc.GetLine(mid, rels.get(k), false); const m = ifc.GetLine(mid, r.RelatingMaterial.value, false); for (const e of r.RelatedObjects) mats.set(e.value, m.Name.value); }
  const levels = Q.levelMap(ifc, W, mid).levelOf;
  const byMat = {}, byLev = {};
  let w1 = null;
  for (const [id, r] of per) {
    const m = mats.get(id) || "—", ln = levels(id)?.name || "—";
    byMat[m] = (byMat[m] || 0) + r.vol;
    byLev[ln] = (byLev[ln] || 0) + r.vol;
    if (name(id) === "Muro W1") w1 = r;
  }
  const E = EXP.ifc;
  check("IFC: volume per materiale Calcestruzzo", near(byMat.Calcestruzzo, E.volume.Calcestruzzo, 1e-6), byMat.Calcestruzzo?.toFixed(4));
  check("IFC: volume per materiale Laterizio", near(byMat.Laterizio, E.volume.Laterizio, 1e-6), byMat.Laterizio?.toFixed(4));
  check("IFC: volume per livello Piano terra", near(byLev["Piano terra"], E.livello["Piano terra"], 1e-6), byLev["Piano terra"]?.toFixed(4));
  check("IFC: volume per livello Piano primo", near(byLev["Piano primo"], E.livello["Piano primo"], 1e-6), byLev["Piano primo"]?.toFixed(4));
  check("IFC: superficie del muro W1", near(w1?.area, E.W1_area, 1e-6), w1?.area?.toFixed(4));
  const secW1 = C.sectionArea(w1.segs, { n: [0, 1, 0], d: -1.5 }, 1e-6);
  check("IFC: sezione orizzontale del muro W1 a 1,5 m = 10 x 0,3 = 3 m2", near(secW1.area, 3, 1e-6), secW1.area.toFixed(5));
  ifc.CloseModel(mid);
}

// ---------------------------------------------------------------- 4. tracciati vettoriali (DWF / PDF)
{
  const sym = (x, y, rot) => { // quadrato con diagonale, ruotato di 90 gradi o no
    const d = rot ? [x + 1, y, x, y + 1] : [x, y, x + 1, y + 1];
    return [{ rings: [[x, y, x + 1, y, x + 1, y + 1, x, y + 1]], closed: [true], stroke: "#000000", w: 0.5, layer: "S" }, { rings: [d], closed: [false], stroke: "#000000", w: 0.5, layer: "S" }];
  };
  const paths = [...sym(0, 0), ...sym(10, 0), ...sym(20, 0, true), { rings: [[0, 50, 100, 50]], closed: [false], stroke: "#ff0000", w: 1, layer: "T" }, { rings: [[0, 60, 40, 60, 40, 90, 0, 90], [10, 70, 20, 70, 20, 80, 10, 80]], closed: [true, true], fill: "#cccccc", layer: "P" }];
  const recs = X.vecRecords(paths);
  check("vettoriale: lunghezza della linea rossa = 100", near(recs.find(r => r.g.stroke === "#ff0000")?.len, 100));
  check("vettoriale: area riempita con foro = 1100", near(recs.find(r => r.g.fill === "#cccccc")?.area, 1100), recs.find(r => r.g.fill === "#cccccc")?.area);
  const cl = X.vecClusters(paths, [0, 0, 200, 200]);
  const sigs = new Map();
  for (const c of cl) sigs.set(c.sig, (sigs.get(c.sig) || 0) + 1);
  check("vettoriale: 3 simboli uguali (uno ruotato)", [...sigs.values()].includes(3), [...sigs.values()].join(","));
  const pk = X.vecPick(paths, 15, 75, 2, true);
  check("vettoriale: un clic dentro il foro prende il foro", pk && near(C.polyArea(pk.pts), 100));
  const pk2 = X.vecPick(paths, 5, 65, 2, true);
  check("vettoriale: un clic nel riempimento prende contorno e foro", pk2 && near(C.polyArea(pk2.pts) - pk2.holes.reduce((a, H) => a + C.polyArea(H), 0), 1100));
}

console.log(`\n${passes} riuscite, ${fails} fallite`);
process.exit(fails ? 1 : 0);
