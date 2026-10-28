// Riconoscimento dei disegni DWG/DXF con contenuto 3D (senza three.js: si usa a ogni apertura di un disegno).
export const ACIS_TYPES = new Set(["3DSOLID", "REGION", "BODY", "SURFACE", "PLANESURFACE", "EXTRUDEDSURFACE", "LOFTEDSURFACE", "REVOLVEDSURFACE", "SWEPTSURFACE", "NURBSURFACE"]);
const MESH_TYPES = new Set(["MESH", "PFACE", "PMESH", "3DFACE"]);
const THICK_TYPES = new Set(["LINE", "ARC", "CIRCLE", "LWPOLYLINE", "POLYLINE2D", "SOLID", "TRACE"]);
const SKIP2D = new Set(["TEXT", "MTEXT", "ATTRIB", "ATTDEF", "DIMENSION", "LEADER", "MULTILEADER", "HATCH", "VIEWPORT", "POINT", "XLINE", "RAY", "TOLERANCE", "IMAGE", "WIPEOUT"]);

// ---------------------------------------------------------------- riconoscimento
// Conteggio delle entita' dello spazio modello (dentro i blocchi una volta per inserimento, con un limite).
export function analyze3d(db) {
  const blocks = new Map((db.tables.BLOCK_RECORD?.entries || []).map(b => [b.name, b]));
  const c = { solids: 0, regions: 0, meshes: 0, thick: 0, z: 0, flat: 0, total: 0 };
  let budget = 200000;
  const walk = (list, depth) => {
    for (const e of list) {
      if (budget-- <= 0 || depth > 8) return;
      if (e._deleted || e.isInPaperSpace || e.isVisible === false) continue;
      const t = e.type;
      if (t === "INSERT") { const b = blocks.get(e.name); if (b) walk(b.entities || [], depth + 1); continue; }
      if (SKIP2D.has(t)) continue;
      c.total++;
      if (t === "REGION") c.regions++;
      else if (ACIS_TYPES.has(t)) c.solids++;
      else if (MESH_TYPES.has(t)) c.meshes++;
      else if (THICK_TYPES.has(t) && Math.abs(e.thickness || 0) > 1e-9) c.thick++;
      else if (is3dCurve(e)) c.z++;
      else c.flat++;
    }
  };
  walk(db.entities || [], 0);
  const solidish = c.solids + c.meshes + c.thick;
  c.any = solidish + c.regions > 0 || c.z > 0;
  // "prevalentemente 3D": almeno un terzo delle entita' disegnabili sono solidi, mesh, facce o oggetti con spessore
  c.mostly = solidish > 0 && solidish >= 0.33 * Math.max(1, c.total - c.regions);
  return c;
}
function is3dCurve(e) {
  const n = e.extrusionDirection;
  if (n && (Math.abs(n.x || 0) > 1e-6 || Math.abs(n.y || 0) > 1e-6)) return true;
  if (e.type === "LINE") return Math.abs((e.startPoint?.z || 0) - (e.endPoint?.z || 0)) > 1e-9;
  if (e.type === "POLYLINE3D") { const v = e.vertices || []; return v.some(p => Math.abs((p.z || 0) - (v[0].z || 0)) > 1e-9); }
  if (e.type === "SPLINE") { const v = e.controlPoints || []; return v.some(p => Math.abs((p.z || 0) - (v[0]?.z || 0)) > 1e-9); }
  return false;
}

