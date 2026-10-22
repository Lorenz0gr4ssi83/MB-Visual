// Computo delle quantita' (Quantification di Navisworks) dai modelli IFC: motore puro sopra web-ifc, senza DOM
// (lo usa ui/js/qtopanel.js e il collaudo tests/test_clash.mjs con Node).
// Per ogni elemento: classe IFC, tipo (IfcRelDefinesByType), livello (struttura spaziale), quantita' degli IfcElementQuantity
// (Qto_*) e misure dei Pset (IfcLengthMeasure, IfcAreaMeasure, IfcVolumeMeasure, IfcMassMeasure, IfcCountMeasure).
// I valori si convertono in unita' SI (m, m², m³, kg) secondo le unita' del progetto.

// quantita' principali: nomi preferiti, in ordine (la prima trovata vale per l'elemento)
export const MAIN = {
  length: ["Length", "NetLength", "GrossLength", "Perimeter", "Height", "Depth"],
  area: ["NetSideArea", "GrossSideArea", "NetArea", "GrossArea", "NetFootprintArea", "GrossFootprintArea", "OuterSurfaceArea", "NetSurfaceArea", "GrossSurfaceArea", "Area", "CrossSectionArea"],
  volume: ["NetVolume", "GrossVolume", "Volume"],
  weight: ["NetWeight", "GrossWeight", "Weight", "Mass"],
};
const KIND = { IFCQUANTITYLENGTH: "length", IFCQUANTITYAREA: "area", IFCQUANTITYVOLUME: "volume", IFCQUANTITYWEIGHT: "weight", IFCQUANTITYCOUNT: "count" };
const MEASURE = {
  IFCLENGTHMEASURE: "length", IFCPOSITIVELENGTHMEASURE: "length", IFCNONNEGATIVELENGTHMEASURE: "length", IFCAREAMEASURE: "area",
  IFCVOLUMEMEASURE: "volume", IFCMASSMEASURE: "weight", IFCCOUNTMEASURE: "count",
};
const UNIT_OF = { length: "LENGTHUNIT", area: "AREAUNIT", volume: "VOLUMEUNIT", weight: "MASSUNIT" };
const PREFIX = { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 10, DECI: 0.1, CENTI: 0.01, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12 };
const POW = { LENGTHUNIT: 1, AREAUNIT: 2, VOLUMEUNIT: 3 };

const dec = s => (typeof s !== "string" || !s.includes("\\") ? s : s
  .replace(/\\X2\\([0-9A-F]+)\\X0\\/gi, (_, h) => String.fromCharCode(...h.match(/.{4}/g).map(x => parseInt(x, 16))))
  .replace(/\\X\\([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))));
const val = v => (v && typeof v === "object" && "value" in v ? v.value : v);
const ref = v => (v && typeof v === "object" ? v.value ?? v.expressID : v);

// fattore verso SI di ogni tipo di unita' del progetto (1 se il file non la dichiara)
export function unitFactors(ifc, W, mid) {
  const f = { LENGTHUNIT: 1, AREAUNIT: 1, VOLUMEUNIT: 1, MASSUNIT: 1 };
  const factor = (u, type) => {
    if (!u) return 1;
    if (u.ConversionFactor) { // unita' convertite (piedi, pollici...): valore * unita' SI
      const c = u.ConversionFactor;
      return (+val(c.ValueComponent) || 1) * factor(c.UnitComponent, type);
    }
    let k = PREFIX[val(u.Prefix)] || 1;
    k = Math.pow(k, POW[type] || 1);
    if (val(u.Name) === "GRAM") k *= 1e-3; // kg
    return k;
  };
  try {
    const ids = ifc.GetLineIDsWithType(mid, W.IFCPROJECT);
    if (!ids.size()) return f;
    const p = ifc.GetLine(mid, ids.get(0), true);
    for (const u of p.UnitsInContext?.Units || []) {
      const t = val(u.UnitType);
      if (t in f) f[t] = factor(u, t);
    }
  } catch { /* unita' non dichiarate: SI */ }
  return f;
}

// livello (piano) di ogni elemento: contenimento nella struttura spaziale, risalendo le aggregazioni
export function levelMap(ifc, W, mid) {
  const parent = new Map(), contained = new Map(), storeys = new Map();
  const each = (type, fn) => { try { const ids = ifc.GetLineIDsWithType(mid, type); for (let k = 0; k < ids.size(); k++) fn(ifc.GetLine(mid, ids.get(k), false)); } catch { /* */ } };
  each(W.IFCBUILDINGSTOREY, s => storeys.set(s.expressID, { name: dec(val(s.Name)) || dec(val(s.LongName)) || "#" + s.expressID, elev: +val(s.Elevation) || 0 }));
  each(W.IFCRELCONTAINEDINSPATIALSTRUCTURE, r => { for (const e of r.RelatedElements || []) contained.set(ref(e), ref(r.RelatingStructure)); });
  each(W.IFCRELAGGREGATES, r => { for (const e of r.RelatedObjects || []) parent.set(ref(e), ref(r.RelatingObject)); });
  each(W.IFCRELNESTS, r => { for (const e of r.RelatedObjects || []) parent.set(ref(e), ref(r.RelatingObject)); });
  const memo = new Map();
  const levelOf = id => {
    if (memo.has(id)) return memo.get(id);
    let x = id, guard = 0, out = null;
    while (x !== undefined && guard++ < 30) {
      if (storeys.has(x)) { out = storeys.get(x); break; }
      x = contained.has(x) ? contained.get(x) : parent.get(x);
    }
    memo.set(id, out);
    return out;
  };
  return { levelOf, storeys };
}

// tipo di ogni elemento (nome del tipo IFC)
export function typeMap(ifc, W, mid) {
  const map = new Map();
  try {
    const ids = ifc.GetLineIDsWithType(mid, W.IFCRELDEFINESBYTYPE);
    for (let k = 0; k < ids.size(); k++) {
      const r = ifc.GetLine(mid, ids.get(k), false);
      let name = "";
      try { const t = ifc.GetLine(mid, ref(r.RelatingType), false); name = dec(val(t.Name)) || ifc.GetNameFromTypeCode(t.type); } catch { /* */ }
      for (const e of r.RelatedObjects || []) map.set(ref(e), name);
    }
  } catch { /* */ }
  return map;
}

// quantita' (e misure dei Pset) per elemento: Map id -> [{ set, name, kind, v (SI) }]
export function quantityMap(ifc, W, mid, units) {
  const out = new Map();
  const push = (id, q) => { if (!out.has(id)) out.set(id, []); out.get(id).push(q); };
  let ids;
  try { ids = ifc.GetLineIDsWithType(mid, W.IFCRELDEFINESBYPROPERTIES); } catch { return out; }
  const conv = (kind, v) => (kind === "count" ? v : v * (units[UNIT_OF[kind]] || 1));
  for (let k = 0; k < ids.size(); k++) {
    let r, def;
    try { r = ifc.GetLine(mid, ids.get(k), false); def = ifc.GetLine(mid, ref(r.RelatingPropertyDefinition), false); } catch { continue; }
    if (!def) continue;
    const setName = dec(val(def.Name)) || "";
    const items = [];
    const isQ = !!def.Quantities;
    for (const p of (isQ ? def.Quantities : def.HasProperties) || []) {
      let line;
      try { line = ifc.GetLine(mid, ref(p), false); } catch { continue; }
      if (!line) continue;
      const name = dec(val(line.Name)) || "";
      if (isQ) {
        let cls = "";
        try { cls = ifc.GetNameFromTypeCode(line.type); } catch { /* */ }
        const kind = KIND[cls.toUpperCase()];
        if (!kind) continue;
        const v = +val(line.LengthValue ?? line.AreaValue ?? line.VolumeValue ?? line.WeightValue ?? line.CountValue);
        if (Number.isFinite(v)) items.push({ set: setName, name, kind, v: conv(kind, v), qto: true });
      } else if (line.NominalValue) {
        // misure nei Pset (es. esportazioni Revit "Dimensions": Area, Volume, Length)
        const nv = line.NominalValue, kind = MEASURE[String(nv.label || nv.name || "").toUpperCase()];
        const v = +val(nv);
        if (kind && Number.isFinite(v)) items.push({ set: setName, name, kind, v: conv(kind, v), qto: false });
      }
    }
    if (!items.length) continue;
    for (const e of r.RelatedObjects || []) for (const q of items) push(ref(e), q);
  }
  return out;
}

// quantita' principale di un tipo: prima le Qto con i nomi preferiti, poi le misure dei Pset con gli stessi nomi
export function mainQuantity(qs, kind) {
  const list = (qs || []).filter(q => q.kind === kind);
  if (!list.length) return null;
  for (const qto of [true, false]) {
    for (const n of MAIN[kind] || []) {
      const q = list.find(x => x.qto === qto && x.name.toLowerCase() === n.toLowerCase());
      if (q) return q;
    }
  }
  return list.find(x => x.qto) || null;
}

// computo di uno o piu' modelli: elementi con classe, tipo, livello e quantita'
// models = [{ mid, name }]; ids(mid) = elenco degli expressID da computare (gli elementi con geometria)
export function takeoff(ifc, W, models, ids) {
  const rows = [];
  for (const { mid, name: modelName } of models) {
    const units = unitFactors(ifc, W, mid);
    const { levelOf } = levelMap(ifc, W, mid);
    const types = typeMap(ifc, W, mid);
    const qmap = quantityMap(ifc, W, mid, units);
    for (const id of ids(mid)) {
      let line = null, cls = "";
      try { line = ifc.GetLine(mid, id, false); cls = ifc.GetNameFromTypeCode(line.type); } catch { continue; }
      const qs = qmap.get(id) || [];
      const lv = levelOf(id);
      const row = { mid, id, model: modelName, guid: val(line.GlobalId) || "", name: dec(val(line.Name)) || "", tag: dec(val(line.Tag)) || "",
        cls, type: types.get(id) || "", level: lv?.name || "", elev: lv ? lv.elev : null, qs };
      for (const k of ["length", "area", "volume", "weight"]) { const q = mainQuantity(qs, k); row[k] = q ? q.v : null; }
      const c = qs.find(q => q.kind === "count");
      row.count = c ? c.v : 1;
      rows.push(row);
    }
  }
  return rows;
}

// raggruppamento: keys = ["cls", "type", "level"] in ordine; nodi { key, label, rows, count, length, area, volume, weight, children }
export function groupRows(rows, keys) {
  const sum = list => {
    const s = { count: 0, length: 0, area: 0, volume: 0, weight: 0, n: { length: 0, area: 0, volume: 0, weight: 0 } };
    for (const r of list) {
      s.count += r.count;
      for (const k of ["length", "area", "volume", "weight"]) if (r[k] != null) { s[k] += r[k]; s.n[k]++; }
    }
    return s;
  };
  const build = (list, depth) => {
    if (depth >= keys.length) return [];
    const k = keys[depth], m = new Map();
    for (const r of list) { const v = r[k] || ""; if (!m.has(v)) m.set(v, []); m.get(v).push(r); }
    const order = [...m.keys()].sort((a, b) => {
      if (k === "level") { const ea = m.get(a)[0].elev, eb = m.get(b)[0].elev; if (ea !== eb) return (ea ?? Infinity) - (eb ?? Infinity); }
      return String(a).localeCompare(String(b), undefined, { numeric: true });
    });
    return order.map(v => ({ key: k, label: v, rows: m.get(v), ...sum(m.get(v)), children: build(m.get(v), depth + 1) }));
  };
  return { ...sum(rows), rows, children: build(rows, 0) };
}
