// Apre uno o piu' IFC con web-ifc (ui/vendor, come il visualizzatore 3D) e stampa in JSON, per ciascuno: schema, numero di
// righe lette, tipi ed elementi con i loro property set. Usato da tests/test_revit_ifc.py.
//   node tests/check_ifc_webifc.mjs file1.ifc [file2.ifc ...]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = process.env.MBV_VENDOR || path.join(ROOT, "ui/vendor/web-ifc");
const origFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => (String(u).endsWith(".wasm") ? new Response(fs.readFileSync(String(u)), { headers: { "Content-Type": "application/wasm" } }) : origFetch(u, o));
const W = await import(pathToFileURL(path.join(VENDOR, "web-ifc-api.js")).href);
const api = new W.IfcAPI();
api.SetWasmPath(VENDOR.replace(/\\/g, "/") + "/", true);
await api.Init(undefined, true);
api.SetLogLevel?.(6);

const val = v => (v && typeof v === "object" && "value" in v ? v.value : v);
const out = [];
for (const file of process.argv.slice(2)) {
  const mid = api.OpenModel(fs.readFileSync(file));
  const res = { file: path.basename(file), schema: api.GetModelSchema(mid), lines: 0, errors: [], types: [], elements: [] };
  const all = api.GetAllLines(mid);
  for (let i = 0; i < all.size(); i++) {
    try { api.GetLine(mid, all.get(i)); res.lines++; } catch (e) { res.errors.push(all.get(i) + ": " + e.message); }
  }
  const psets = (ids) => (ids || []).map(r => {
    const ps = api.GetLine(mid, val(r), true);
    return { name: val(ps.Name), props: Object.fromEntries((ps.HasProperties || []).map(p => [val(p.Name), val(p.NominalValue)])) };
  });
  for (const id of api.GetLineIDsWithType(mid, W.IFCPROJECT)) res.project = val(api.GetLine(mid, id).Name);
  const rels = api.GetLineIDsWithType(mid, W.IFCRELDEFINESBYTYPE);
  for (let i = 0; i < rels.size(); i++) {
    const rel = api.GetLine(mid, rels.get(i));
    const ty = api.GetLine(mid, val(rel.RelatingType));
    res.types.push({ cls: api.GetNameFromTypeCode(ty.type), name: val(ty.Name), elementType: val(ty.ElementType), psets: psets(ty.HasPropertySets) });
    for (const o of rel.RelatedObjects) {
      const el = api.GetLine(mid, val(o));
      res.elements.push({ cls: api.GetNameFromTypeCode(el.type), name: val(el.Name) });
    }
  }
  const cls = api.GetLineIDsWithType(mid, W.IFCCLASSIFICATIONREFERENCE);
  res.classification = [];
  for (let i = 0; i < cls.size(); i++) res.classification.push(val(api.GetLine(mid, cls.get(i)).Identification));
  let meshes = 0;
  api.StreamAllMeshes(mid, () => meshes++);
  res.meshes = meshes;
  api.CloseModel(mid);
  out.push(res);
}
console.log(JSON.stringify(out));
