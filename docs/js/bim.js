// Scheda BIM completa di un elemento IFC: attributi, posizione nella struttura del progetto, tipo, set di proprieta'
// e di quantita' (con le unita' del progetto), materiali, classificazioni, relazioni e dati IFC grezzi.
import { el, saveBlobAs, toast } from "./core.js";

const PREFIX = { EXA: "E", PETA: "P", TERA: "T", GIGA: "G", MEGA: "M", KILO: "k", HECTO: "h", DECA: "da", DECI: "d", CENTI: "c", MILLI: "m", MICRO: "µ", NANO: "n", PICO: "p" };
const SI = {
  METRE: "m", SQUARE_METRE: "m²", CUBIC_METRE: "m³", GRAM: "g", SECOND: "s", RADIAN: "rad", STERADIAN: "sr", NEWTON: "N", PASCAL: "Pa",
  JOULE: "J", WATT: "W", KELVIN: "K", DEGREE_CELSIUS: "°C", AMPERE: "A", VOLT: "V", OHM: "Ω", HERTZ: "Hz", LUMEN: "lm", LUX: "lx",
  CANDELA: "cd", MOLE: "mol", COULOMB: "C", FARAD: "F", HENRY: "H", TESLA: "T", WEBER: "Wb", SIEMENS: "S", BECQUEREL: "Bq", GRAY: "Gy", SIEVERT: "Sv",
};
const CONVERTED = { DEGREE: "°", INCH: "in", FOOT: "ft", YARD: "yd", MILE: "mi", "SQUARE FOOT": "ft²", "SQUARE INCH": "in²", "CUBIC FOOT": "ft³", "CUBIC INCH": "in³", POUND: "lb", MINUTE: "min", HOUR: "h", DAY: "d", LITRE: "l", GALLON: "gal" };
// tipo di misura IFC -> tipo di unita' definito nel progetto
const MEASURE_UNIT = {
  LENGTHMEASURE: "LENGTHUNIT", POSITIVELENGTHMEASURE: "LENGTHUNIT", NONNEGATIVELENGTHMEASURE: "LENGTHUNIT", AREAMEASURE: "AREAUNIT",
  VOLUMEMEASURE: "VOLUMEUNIT", MASSMEASURE: "MASSUNIT", PLANEANGLEMEASURE: "PLANEANGLEUNIT", POSITIVEPLANEANGLEMEASURE: "PLANEANGLEUNIT",
  TIMEMEASURE: "TIMEUNIT", THERMODYNAMICTEMPERATUREMEASURE: "THERMODYNAMICTEMPERATUREUNIT", ELECTRICCURRENTMEASURE: "ELECTRICCURRENTUNIT",
  ELECTRICVOLTAGEMEASURE: "ELECTRICVOLTAGEUNIT", POWERMEASURE: "POWERUNIT", FORCEMEASURE: "FORCEUNIT", PRESSUREMEASURE: "PRESSUREUNIT",
  ENERGYMEASURE: "ENERGYUNIT", FREQUENCYMEASURE: "FREQUENCYUNIT", LUMINOUSFLUXMEASURE: "LUMINOUSFLUXUNIT", ILLUMINANCEMEASURE: "ILLUMINANCEUNIT",
  THERMALTRANSMITTANCEMEASURE: "THERMALTRANSMITTANCEUNIT", MASSDENSITYMEASURE: "MASSDENSITYUNIT", VOLUMETRICFLOWRATEMEASURE: "VOLUMETRICFLOWRATEUNIT",
};
const QUANTITY_UNIT = { IFCQUANTITYLENGTH: "LENGTHUNIT", IFCQUANTITYAREA: "AREAUNIT", IFCQUANTITYVOLUME: "VOLUMEUNIT", IFCQUANTITYWEIGHT: "MASSUNIT", IFCQUANTITYTIME: "TIMEUNIT" };
// unita' derivate scritte come si usano in edilizia (quando il file le esprime in unita' SI di base)
const DERIVED_DEFAULT = {
  THERMALTRANSMITTANCEUNIT: "W/(m²·K)", THERMALRESISTANCEUNIT: "m²·K/W", THERMALCONDUCTANCEUNIT: "W/(m·K)", MASSDENSITYUNIT: "kg/m³",
  VOLUMETRICFLOWRATEUNIT: "m³/s", MASSFLOWRATEUNIT: "kg/s", LINEARVELOCITYUNIT: "m/s", ACCELERATIONUNIT: "m/s²", ANGULARVELOCITYUNIT: "rad/s",
  SPECIFICHEATCAPACITYUNIT: "J/(kg·K)", HEATFLUXDENSITYUNIT: "W/m²", HEATINGVALUEUNIT: "J/kg", LINEARFORCEUNIT: "N/m", PLANARFORCEUNIT: "N/m²",
  MODULUSOFELASTICITYUNIT: "Pa", MOMENTOFINERTIAUNIT: "m⁴", TORQUEUNIT: "N·m", LINEARMOMENTUNIT: "N·m/m", MASSPERLENGTHUNIT: "kg/m",
  DYNAMICVISCOSITYUNIT: "Pa·s", ROTATIONALFREQUENCYUNIT: "1/s", SOUNDPOWERUNIT: "W", SOUNDPRESSUREUNIT: "Pa", LINEARSTIFFNESSUNIT: "N/m",
  THERMALEXPANSIONCOEFFICIENTUNIT: "1/K", VAPORPERMEABILITYUNIT: "kg/(s·m·Pa)", MOISTUREDIFFUSIVITYUNIT: "m²/s", WARPINGCONSTANTUNIT: "m⁶",
};
const SUP = { "-": "⁻", 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹" };
const sup = n => String(n).split("").map(c => SUP[c] ?? c).join("");
const SKIP_ATTR = new Set(["expressID", "type"]);

// testo IFC: \X2\00E8\X0\ (UTF-16), \X\E8 (ISO 8859-1), \S\ (meta' superiore)
export function decodeIfc(s) {
  if (typeof s !== "string" || !s.includes("\\")) return s;
  return s
    .replace(/\\X2\\([0-9A-F]+)\\X0\\/gi, (_, h) => String.fromCharCode(...h.match(/.{4}/g).map(x => parseInt(x, 16))))
    .replace(/\\X\\([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\S\\(.)/g, (_, c) => String.fromCharCode(c.charCodeAt(0) + 128));
}

function projectUnits(info, modelID) {
  info.units = info.units || {};
  if (info.units[modelID]) return info.units[modelID];
  const map = {};
  try {
    const ids = info.ifc.GetLineIDsWithType(modelID, info.WEBIFC.IFCPROJECT);
    if (ids.size()) {
      const proj = info.ifc.GetLine(modelID, ids.get(0), true);
      for (const u of proj.UnitsInContext?.Units || []) {
        const t = u.UnitType?.value;
        if (!t) continue;
        // unita' derivata espressa solo in unita' SI di base (es. kg·K⁻¹·s⁻³): si usa la scrittura tecnica abituale
        const plainSI = u.Elements && u.Elements.every(e => !e.Unit?.Prefix || (e.Unit.Prefix.value === "KILO" && e.Unit.Name?.value === "GRAM"));
        map[t] = (plainSI && DERIVED_DEFAULT[t]) || unitSymbol(u) || map[t];
      }
    }
  } catch { /* progetto senza unita' esplicite */ }
  for (const [k, v] of Object.entries(DERIVED_DEFAULT)) map[k] = map[k] || v;
  return (info.units[modelID] = map);
}

function unitSymbol(u) {
  if (!u || typeof u !== "object") return "";
  const name = String(u.Name?.value ?? "").toUpperCase();
  if (SI[name]) return (PREFIX[u.Prefix?.value] || "") + SI[name];
  if (CONVERTED[name]) return CONVERTED[name];
  if (u.Elements) {
    // numeratore / denominatore con esponenti in apice: kg·m⁻³ -> kg/m³
    const part = sign => u.Elements.filter(e => Math.sign(e.Exponent?.value ?? e.Exponent) === sign)
      .map(e => { const s = unitSymbol(e.Unit), x = Math.abs(e.Exponent?.value ?? e.Exponent); return x === 1 ? s : s + sup(x); }).filter(Boolean);
    const num = part(1), den = part(-1);
    if (!den.length) return num.join("·");
    return (num.join("·") || "1") + "/" + (den.length > 1 ? "(" + den.join("·") + ")" : den[0]);
  }
  return decodeIfc(u.Name?.value) || "";
}

export async function bimSheet(info, modelID, id, fmt) {
  const ifc = info.ifc;
  const units = projectUnits(info, modelID);
  const typeName = line => { try { return ifc.GetNameFromTypeCode(line.type); } catch { return "IFC"; } };
  const getLine = (ref, flat = false, inv = false) => { try { return ifc.GetLine(modelID, ref, flat, inv); } catch { return null; } };
  const describe = ref => {
    const l = getLine(ref);
    if (!l) return "#" + ref;
    const n = decodeIfc(l.Name?.value ?? l.LongName?.value ?? l.Identification?.value ?? l.ItemReference?.value ?? "");
    return `${typeName(l)}${n ? " «" + n + "»" : ""} #${ref}`;
  };
  const yesNo = { T: "Si'", F: "No", U: "Sconosciuto", TRUE: "Si'", FALSE: "No" };
  // un valore IFC (semplice, enumerato, riferimento, lista) in testo leggibile
  const text = (v, unit = "") => {
    if (v === null || v === undefined) return "";
    if (Array.isArray(v)) return v.map(x => text(x, unit)).filter(x => x !== "").join("; ");
    if (typeof v === "boolean") return v ? "Si'" : "No";
    if (typeof v !== "object") return typeof v === "number" ? fmt(v) + (unit ? " " + unit : "") : decodeIfc(String(v));
    if (v.type === 5 && typeof v.value === "number") return describe(v.value);
    if ("value" in v) {
      const label = String(v.label || v.name || "").toUpperCase().replace(/^IFC/, "");
      if (/BOOLEAN|LOGICAL/.test(label) || (v.type === 3 && yesNo[v.value])) return typeof v.value === "boolean" ? text(v.value) : yesNo[v.value] ?? String(v.value);
      const base = label.replace(/^(POSITIVE|NONNEGATIVE)/, "");
      const u = unit || units[MEASURE_UNIT[label]] || units[base.replace(/MEASURE$/, "UNIT")] || "";
      return text(v.value, u);
    }
    if (v.expressID !== undefined) return describe(v.expressID); // oggetto gia' risolto
    return "";
  };

  const rows = []; // { sez, nome, valore } per ricerca, copia ed esportazione
  const root = el("div", { class: "bim" });
  const section = (title, open = true) => {
    const dl = el("dl", { class: "kv stack" });
    const d = el("details", { open: open || undefined }, el("summary", {}, title), dl);
    d.dataset.title = title;
    root.append(d);
    return (k, v) => {
      if (v === undefined || v === null || v === "") return;
      rows.push({ sez: title, nome: k, valore: String(v) });
      dl.append(el("dt", {}, k), el("dd", {}, String(v)));
    };
  };

  const line = getLine(id, false, true) || {};
  const direct = getLine(id, false, false) || {};

  // 1. attributi diretti, tutti
  let add = section("Attributi IFC · " + typeName(direct));
  add("Classe IFC", typeName(direct));
  add("ID interno", "#" + id);
  for (const [k, v] of Object.entries(direct)) if (!SKIP_ATTR.has(k)) add(k, text(v));

  // 2. posizione nella struttura spaziale (piano, edificio, sito, progetto)
  add = section("Posizione nel progetto");
  const refsOf = x => (Array.isArray(x) ? x : x ? [x] : []).map(r => (r && typeof r === "object" ? r.value ?? r.expressID : r)).filter(n => typeof n === "number");
  const parentOf = ref => {
    const l = getLine(ref, false, true);
    for (const rel of refsOf(l?.ContainedInStructure)) { const r = getLine(rel); if (r?.RelatingStructure) return { via: "contenuto in", ref: r.RelatingStructure.value }; }
    for (const rel of refsOf(l?.Decomposes)) { const r = getLine(rel); if (r?.RelatingObject) return { via: "parte di", ref: r.RelatingObject.value }; }
    for (const rel of refsOf(l?.VoidsElements)) { const r = getLine(rel); if (r?.RelatingBuildingElement) return { via: "apertura in", ref: r.RelatingBuildingElement.value }; }
    return null;
  };
  let cur = id, guard = 0;
  while (guard++ < 12) {
    const p = parentOf(cur);
    if (!p) break;
    const pl = getLine(p.ref);
    add(pl ? typeName(pl).replace(/^IFC/, "") : "Contenitore", `${describe(p.ref)}${pl?.Elevation ? " · quota " + text(pl.Elevation, units.LENGTHUNIT) : ""} (${p.via})`);
    cur = p.ref;
  }

  // 3. tipo dell'elemento e proprieta' del tipo
  let typeObjs = [];
  try { typeObjs = await ifc.properties.getTypeProperties(modelID, id, true); } catch { /* */ }
  for (const t of typeObjs || []) {
    add = section("Tipo · " + (decodeIfc(t.Name?.value) || typeName(t)));
    add("Classe del tipo", typeName(t));
    for (const [k, v] of Object.entries(t)) if (!SKIP_ATTR.has(k) && k !== "HasPropertySets" && k !== "RepresentationMaps") add(k, text(v));
    for (const ps of t.HasPropertySets || []) psetSection(ps, "Tipo · ");
  }

  // 4. set di proprieta' e di quantita' dell'elemento
  let psets = [];
  try { psets = await ifc.properties.getPropertySets(modelID, id, true); } catch (e) { section("Proprieta'")("Errore", e.message); }
  for (const ps of psets || []) psetSection(ps, "");

  function psetSection(ps, pre) {
    const isQ = !!ps.Quantities;
    const a = section(pre + (decodeIfc(ps.Name?.value) || (isQ ? "Quantita'" : "Proprieta'")));
    for (const p of ps.HasProperties || ps.Quantities || []) propRows(p, "", a);
  }
  function propRows(p, pre, a) {
    if (!p || typeof p !== "object") return;
    const name = pre + (decodeIfc(p.Name?.value) || typeName(p));
    const explicit = unitSymbol(p.Unit);
    const cls = typeName(p);
    if (p.HasProperties) return p.HasProperties.forEach(c => propRows(c, name + " › ", a));
    if (p.HasQuantities) return p.HasQuantities.forEach(c => propRows(c, name + " › ", a));
    if (QUANTITY_UNIT[cls] || /^IFCQUANTITY/.test(cls)) {
      const v = p.LengthValue ?? p.AreaValue ?? p.VolumeValue ?? p.CountValue ?? p.WeightValue ?? p.TimeValue ?? p.NumberValue;
      return a(name, text(v, explicit || units[QUANTITY_UNIT[cls]] || "") + (p.Formula?.value ? `  (formula: ${p.Formula.value})` : ""));
    }
    if (p.NominalValue !== undefined) return a(name, text(p.NominalValue, explicit));
    if (p.EnumerationValues) return a(name, text(p.EnumerationValues, explicit));
    if (p.ListValues) return a(name, text(p.ListValues, explicit));
    if (p.UpperBoundValue !== undefined || p.LowerBoundValue !== undefined || p.SetPointValue !== undefined) {
      const parts = [];
      if (p.LowerBoundValue) parts.push("min " + text(p.LowerBoundValue, explicit));
      if (p.UpperBoundValue) parts.push("max " + text(p.UpperBoundValue, explicit));
      if (p.SetPointValue) parts.push("valore " + text(p.SetPointValue, explicit));
      return a(name, parts.join(" · "));
    }
    if (p.DefiningValues) {
      const dv = p.DefiningValues || [], dd = p.DefinedValues || [];
      return a(name, dv.map((d, i) => `${text(d)} → ${text(dd[i])}`).join("; "));
    }
    if (p.PropertyReference !== undefined) return a(name, text(p.PropertyReference));
    a(name, text(p.Description) || "(senza valore)");
  }

  // 5. materiali (anche quelli del tipo), con strati e spessori
  let mats = [];
  try { mats = await ifc.properties.getMaterialsProperties(modelID, id, true, true); } catch { /* */ }
  if (mats?.length) {
    add = section("Materiali");
    const matName = m => decodeIfc(m?.Name?.value) || describe(m?.expressID);
    const walkMat = (m, pre = "") => {
      if (!m || typeof m !== "object") return;
      const cls = typeName(m);
      if (m.ForLayerSet) { add(pre + "Uso del pacchetto", `${text(m.LayerSetDirection)} ${text(m.DirectionSense)} · offset ${text(m.OffsetFromReferenceLine, units.LENGTHUNIT)}`); return walkMat(m.ForLayerSet, pre); }
      if (m.MaterialLayers) {
        let tot = 0;
        m.MaterialLayers.forEach((l, i) => { const t = l.LayerThickness?.value ?? 0; tot += t; add(`${pre}Strato ${i + 1}${l.Name?.value ? " · " + decodeIfc(l.Name.value) : ""}`, `${matName(l.Material)} · spessore ${text(l.LayerThickness, units.LENGTHUNIT)}${l.IsVentilated?.value === "T" ? " · ventilato" : ""}`); });
        return add(pre + (decodeIfc(m.LayerSetName?.value) || "Pacchetto") + " · spessore totale", text(tot, units.LENGTHUNIT));
      }
      if (m.ForProfileSet) return walkMat(m.ForProfileSet, pre);
      if (m.MaterialProfiles) return m.MaterialProfiles.forEach((p, i) => add(`${pre}Profilo ${i + 1}`, `${matName(p.Material)} · ${text(p.Profile)}`));
      if (m.MaterialConstituents) return m.MaterialConstituents.forEach(c => add(pre + (decodeIfc(c.Name?.value) || "Componente"), `${matName(c.Material)}${c.Fraction ? " · frazione " + text(c.Fraction) : ""}`));
      if (m.Materials) return m.Materials.forEach(x => walkMat(x, pre));
      add(pre + cls.replace(/^IFC/, ""), matName(m) + (m.Category?.value ? " · " + decodeIfc(m.Category.value) : "") + (m.Description?.value ? " · " + decodeIfc(m.Description.value) : ""));
    };
    mats.forEach(m => walkMat(m));
  }

  // 6. classificazioni e 7. tutte le altre relazioni (aperture, connessioni, gruppi, sistemi, documenti...)
  const cls = [], rels = [];
  for (const [k, v] of Object.entries(line)) {
    if (SKIP_ATTR.has(k) || k in direct) continue; // solo gli attributi inversi
    for (const rel of refsOf(v)) {
      const r = getLine(rel);
      if (!r) continue;
      const rt = typeName(r);
      if (rt === "IFCRELDEFINESBYPROPERTIES" || rt === "IFCRELDEFINESBYTYPE" || rt === "IFCRELASSOCIATESMATERIAL") continue; // gia' mostrati sopra
      if (rt === "IFCRELASSOCIATESCLASSIFICATION") {
        const c = getLine(r.RelatingClassification?.value, true);
        if (c) cls.push(c);
        continue;
      }
      const others = [];
      for (const [rk, rv] of Object.entries(r)) {
        if (SKIP_ATTR.has(rk) || rk === "OwnerHistory") continue;
        for (const o of refsOf(rv)) if (o !== id && rv?.type !== 1) others.push(`${rk}: ${describe(o)}`);
      }
      rels.push([`${k} · ${rt.replace(/^IFCREL/, "")}`, others.join("; ") || describe(rel)]);
    }
  }
  if (cls.length) {
    add = section("Classificazioni");
    for (const c of cls) {
      const code = c.Identification?.value ?? c.ItemReference?.value ?? "";
      const src = c.ReferencedSource?.Name?.value ?? c.ReferencedSource?.Source?.value ?? "";
      add(decodeIfc(src) || "Classificazione", [code, decodeIfc(c.Name?.value), c.Location?.value].filter(Boolean).join(" · "));
    }
  }
  if (rels.length) { add = section("Relazioni", false); rels.forEach(([k, v]) => add(k, v)); }

  // 8. dati IFC grezzi (tutto cio' che il file contiene per l'elemento)
  const rawPre = el("pre", { style: { whiteSpace: "pre-wrap", fontSize: "11px", margin: 0, userSelect: "text" } });
  const rawDet = el("details", {}, el("summary", {}, "Dati IFC grezzi"), rawPre);
  rawDet.addEventListener("toggle", () => { if (rawDet.open && !rawPre.textContent) rawPre.textContent = JSON.stringify(line, (k, v) => (typeof v === "string" ? decodeIfc(v) : v), 1); });
  root.append(rawDet);

  // ricerca, copia ed esportazione
  const filter = el("input", { type: "search", placeholder: "Cerca tra le proprieta'...", style: { flex: 1, minWidth: "120px" } });
  filter.addEventListener("input", () => {
    const q = filter.value.trim().toLowerCase();
    for (const d of root.querySelectorAll("details")) {
      let any = false;
      const dts = d.querySelectorAll("dt");
      for (const dt of dts) { const dd = dt.nextElementSibling; const ok = !q || (dt.textContent + " " + dd.textContent).toLowerCase().includes(q); dt.hidden = dd.hidden = !ok; any ||= ok; }
      d.hidden = !!q && !any && !d.dataset.title?.toLowerCase().includes(q);
      if (q && any) d.open = true;
    }
  });
  const tsv = () => rows.map(r => [r.sez, r.nome, r.valore].map(x => x.replace(/[\t\n]/g, " ")).join("\t")).join("\n");
  const bar = el("div", { style: { display: "flex", gap: "6px", margin: "8px 0 4px", flexWrap: "wrap" } }, filter,
    el("button", { class: "btn", title: "Copia tutte le proprieta' (si incollano in Excel)", onclick: () => navigator.clipboard?.writeText("Sezione\tProprieta'\tValore\n" + tsv()).then(() => toast("Proprieta' copiate")) }, "Copia"),
    el("button", { class: "btn", title: "Salva le proprieta' in un file CSV", onclick: () => {
      const csv = "﻿Sezione;Proprieta';Valore\n" + rows.map(r => [r.sez, r.nome, r.valore].map(x => '"' + x.replace(/"/g, '""') + '"').join(";")).join("\n");
      saveBlobAs(`elemento_${id}.csv`, new Blob([csv], { type: "text/csv" }));
    } }, "CSV"));
  const out = el("div", {}, bar, root);
  out.dataset.count = rows.length;
  return out;
}
