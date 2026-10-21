// Sistemi di riferimento per il visualizzatore GIS: quelli piu' usati in Italia, con definizione proj4 e WKT
// (per i .prj scritti) generate dagli stessi parametri; riconoscimento da .prj, codici EPSG, GeoTIFF, GeoJSON, GeoPackage.
// Parametri di trasformazione verso WGS84: quelli pubblicati da EPSG (epsg.io) per l'Italia.

const DATUMS = {
  WGS84: { geog: "WGS 84", datum: "WGS_1984", sph: ["WGS 84", 6378137, 298.257223563], p4: "+datum=WGS84" },
  ETRS89: { geog: "ETRS89", datum: "European_Terrestrial_Reference_System_1989", sph: ["GRS 1980", 6378137, 298.257222101], tw: [0, 0, 0, 0, 0, 0, 0] },
  RDN2008: { geog: "RDN2008", datum: "Rete_Dinamica_Nazionale_2008", sph: ["GRS 1980", 6378137, 298.257222101], tw: [0, 0, 0, 0, 0, 0, 0] },
  IGM95: { geog: "IGM95", datum: "Istituto_Geografico_Militaire_1995", sph: ["GRS 1980", 6378137, 298.257222101], tw: [0, 0, 0, 0, 0, 0, 0] },
  MM: { geog: "Monte Mario", datum: "Monte_Mario", sph: ["International 1924", 6378388, 297], tw: [-104.1, -49.1, -9.9, 0.971, -2.917, 0.714, -11.68] },
  ED50: { geog: "ED50", datum: "European_Datum_1950", sph: ["International 1924", 6378388, 297], tw: [-87, -98, -121, 0, 0, 0, 0] },
};
const ELL = { "WGS 84": "WGS84", "GRS 1980": "GRS80", "International 1924": "intl" };
const GEOG_CODE = { WGS84: 4326, ETRS89: 4258, RDN2008: 6706, IGM95: 4670, MM: 4265, ED50: 4230 };

// [codice, nome mostrato, nome EPSG, datum, meridiano centrale, fattore di scala, falsa origine est]
// RDN2008: i codici "(N-E)" (6707-6709, 6875, 6876) hanno per EPSG l'ordine Nord-Est, ma shapefile, GeoPackage e GeoTIFF
// tengono comunque Est-Nord (come GDAL e QGIS): stessa definizione proj4, e nei .prj si scrive il codice E-N corrispondente.
const TM = [
  [3003, "Monte Mario / Italy zone 1 (Gauss-Boaga fuso Ovest)", "Monte Mario / Italy zone 1", "MM", 9, 0.9996, 1500000],
  [3004, "Monte Mario / Italy zone 2 (Gauss-Boaga fuso Est)", "Monte Mario / Italy zone 2", "MM", 15, 0.9996, 2520000],
  [7791, "RDN2008 / UTM zone 32N", "RDN2008 / UTM zone 32N", "RDN2008", 9, 0.9996, 500000],
  [7792, "RDN2008 / UTM zone 33N", "RDN2008 / UTM zone 33N", "RDN2008", 15, 0.9996, 500000],
  [7793, "RDN2008 / UTM zone 34N", "RDN2008 / UTM zone 34N", "RDN2008", 21, 0.9996, 500000],
  [7794, "RDN2008 / Italy zone (fuso Italia)", "RDN2008 / Italy zone (E-N)", "RDN2008", 12, 0.9985, 7000000],
  [7795, "RDN2008 / Zone 12 (fuso 12)", "RDN2008 / Zone 12 (E-N)", "RDN2008", 12, 1, 3000000],
  [6707, "RDN2008 / UTM zone 32N (N-E)", 7791, "RDN2008", 9, 0.9996, 500000],
  [6708, "RDN2008 / UTM zone 33N (N-E)", 7792, "RDN2008", 15, 0.9996, 500000],
  [6709, "RDN2008 / UTM zone 34N (N-E)", 7793, "RDN2008", 21, 0.9996, 500000],
  [6875, "RDN2008 / Italy zone (N-E)", 7794, "RDN2008", 12, 0.9985, 7000000],
  [6876, "RDN2008 / Zone 12 (N-E)", 7795, "RDN2008", 12, 1, 3000000],
  [25832, "ETRS89 / UTM zone 32N", "ETRS89 / UTM zone 32N", "ETRS89", 9, 0.9996, 500000],
  [25833, "ETRS89 / UTM zone 33N", "ETRS89 / UTM zone 33N", "ETRS89", 15, 0.9996, 500000],
  [25834, "ETRS89 / UTM zone 34N", "ETRS89 / UTM zone 34N", "ETRS89", 21, 0.9996, 500000],
  [32632, "WGS 84 / UTM zone 32N", "WGS 84 / UTM zone 32N", "WGS84", 9, 0.9996, 500000],
  [32633, "WGS 84 / UTM zone 33N", "WGS 84 / UTM zone 33N", "WGS84", 15, 0.9996, 500000],
  [32634, "WGS 84 / UTM zone 34N", "WGS 84 / UTM zone 34N", "WGS84", 21, 0.9996, 500000],
  [3064, "IGM95 / UTM zone 32N", "IGM95 / UTM zone 32N", "IGM95", 9, 0.9996, 500000],
  [3065, "IGM95 / UTM zone 33N", "IGM95 / UTM zone 33N", "IGM95", 15, 0.9996, 500000],
  [23032, "ED50 / UTM zone 32N", "ED50 / UTM zone 32N", "ED50", 9, 0.9996, 500000],
  [23033, "ED50 / UTM zone 33N", "ED50 / UTM zone 33N", "ED50", 15, 0.9996, 500000],
  [23034, "ED50 / UTM zone 34N", "ED50 / UTM zone 34N", "ED50", 21, 0.9996, 500000],
];
const GEOG_NAMES = { 4326: "WGS 84 (gradi)", 4258: "ETRS89 (gradi)", 6706: "RDN2008 (gradi)", 4670: "IGM95 (gradi)", 4265: "Monte Mario (gradi)", 4230: "ED50 (gradi)" };

const p4tw = d => d.p4 || `+ellps=${ELL[d.sph[0]]} +towgs84=${d.tw.join(",")}`;
// WKT dei .prj scritti come fa GDAL: senza TOWGS84 (con TOWGS84 PROJ/QGIS non riconoscono piu' il codice EPSG)
const wktGeog = d => `GEOGCS["${d.geog}",DATUM["${d.datum}",SPHEROID["${d.sph[0]}",${d.sph[1]},${d.sph[2]}]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]`;

export const CRS = new Map();   // codice -> { code, name, proj4, wkt, geographic }
for (const [k, code] of Object.entries(GEOG_CODE)) {
  const d = DATUMS[k];
  CRS.set(code, { code, name: GEOG_NAMES[code], geographic: true, proj4: `+proj=longlat ${p4tw(d)} +no_defs`, wkt: wktGeog(d) + `,AUTHORITY["EPSG","${code}"]]` });
}
const tmWkt = (code, wname, d, lon0, k, x0) => `PROJCS["${wname}",${wktGeog(d)}],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",${lon0}],PARAMETER["scale_factor",${k}],PARAMETER["false_easting",${x0}],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","${code}"]]`;
for (const [code, name, wname, dk, lon0, k, x0] of TM) {
  const d = DATUMS[dk];
  CRS.set(code, {
    code, name, geographic: false,
    proj4: `+proj=tmerc +lat_0=0 +lon_0=${lon0} +k=${k} +x_0=${x0} +y_0=0 ${p4tw(d)} +units=m +no_defs`,
    wkt: typeof wname === "number" ? null : tmWkt(code, wname, d, lon0, k, x0),
    en: typeof wname === "number" ? wname : null,
  });
}
for (const c of CRS.values()) if (c.en) c.wkt = CRS.get(c.en).wkt;
CRS.set(3857, {
  code: 3857, name: "WGS 84 / Pseudo-Mercator (web)", geographic: false,
  proj4: "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs",
  wkt: `PROJCS["WGS 84 / Pseudo-Mercator",${wktGeog(DATUMS.WGS84)}],PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1],EXTENSION["PROJ4","+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs"],AUTHORITY["EPSG","3857"]]`,
});
CRS.set(3035, {
  code: 3035, name: "ETRS89-extended / LAEA Europe", geographic: false,
  proj4: "+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
  wkt: `PROJCS["ETRS89-extended / LAEA Europe",${wktGeog(DATUMS.ETRS89)}],PROJECTION["Lambert_Azimuthal_Equal_Area"],PARAMETER["latitude_of_center",52],PARAMETER["longitude_of_center",10],PARAMETER["false_easting",4321000],PARAMETER["false_northing",3210000],UNIT["metre",1],AUTHORITY["EPSG","3035"]]`,
});
// sinonimi usati da alcuni programmi
const ALIAS = { 900913: 3857, 3785: 3857, 102100: 3857, 102113: 3857, 4019: 4326 };

let registered = false;
let custom = 0;
// registra le definizioni in proj4 e in OpenLayers (una volta)
export function registerAll(ol, proj4) {
  if (registered) return;
  for (const c of CRS.values()) proj4.defs("EPSG:" + c.code, c.proj4);
  ol.proj.proj4.register(proj4);
  registered = true;
}

// nome OpenLayers del sistema ("EPSG:3003"), definendolo al volo se e' un WKT/proj4 non in elenco
export function useCrs(ol, proj4, def) {
  if (def == null) return null;
  if (typeof def === "number" || /^\d+$/.test(def)) {
    const code = ALIAS[+def] || +def;
    if (CRS.has(code)) return "EPSG:" + code;
    if (proj4.defs("EPSG:" + code)) return "EPSG:" + code;
    return null;
  }
  const s = String(def).trim();
  const m = s.match(/^(?:EPSG|epsg):+(\d+)$/) || s.match(/EPSG:{1,2}(?:[\d.]*:)?(\d+)$/i);
  if (m) return useCrs(ol, proj4, +m[1]);
  // WKT o proj4 non in elenco
  try {
    const name = "MBV:" + (++custom);
    proj4.defs(name, s);
    if (!proj4.defs(name)) return null;
    ol.proj.proj4.register(proj4);
    return name;
  } catch { return null; }
}

export function crsName(code) {
  if (!code) return "Sconosciuto";
  const m = String(code).match(/^EPSG:(\d+)$/);
  if (m && CRS.has(+m[1])) return `${CRS.get(+m[1]).name} · EPSG:${m[1]}`;
  return m ? `EPSG:${m[1]}` : "Definito dal file (WKT)";
}

export function wktFor(code) {
  const m = String(code || "").match(/^EPSG:(\d+)$/);
  return m && CRS.has(+m[1]) ? CRS.get(+m[1]).wkt : null;
}

// ---------------------------------------------------------------- riconoscimento di un .prj (WKT ESRI o OGC)
const DATUM_RX = [
  [/rdn.?2008|rete.?dinamica/, "RDN2008"], [/igm.?95|istituto.?geografico/, "IGM95"], [/monte.?mario/, "MM"],
  [/etrs.?(19)?89|european.?terrestrial/, "ETRS89"], [/ed.?(19)?50|european.?datum.?1950/, "ED50"], [/wgs.?(19)?84/, "WGS84"],
];
export function codeFromPrj(wkt) {
  if (!wkt) return null;
  const s = String(wkt).trim();
  // autorita' dell'intero sistema = l'ultima AUTHORITY del WKT (OGC) o ID[...] (WKT2)
  const auth = [...s.matchAll(/(?:AUTHORITY|ID)\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]/gi)];
  if (auth.length) {
    const top = +auth[auth.length - 1][1];
    const code = ALIAS[top] || top;
    if (CRS.has(code)) return code;
  }
  const low = s.toLowerCase();
  const projName = (low.match(/^(?:projcs|projcrs)\[\s*"([^"]*)"/) || [])[1] || "";
  const datum = (DATUM_RX.find(([rx]) => rx.test(low)) || [])[1];
  if (/web.?mercator|pseudo.?mercator|popular.?visualisation/.test(low)) return 3857;
  if (/^(geogcs|geogcrs|geodcrs)\[/.test(low)) return datum ? GEOG_CODE[datum] : null;
  if (/italy.?(zone)?.?_?1\b|gauss.?boaga.*ovest|fuso.?ovest|italy_1/.test(projName)) return 3003;
  if (/italy.?(zone)?.?_?2\b|gauss.?boaga.*est|fuso.?est|italy_2/.test(projName)) return 3004;
  if (/italy.?zone|fuso.?italia/.test(projName) && datum === "RDN2008") return /n-e/.test(projName) ? 6875 : 7794;
  if (/zone.?12/.test(projName) && datum === "RDN2008") return /n-e/.test(projName) ? 6876 : 7795;
  const z = projName.match(/utm.?zone.?(\d{2})\s*n?/);
  if (z) {
    const zone = +z[1];
    const pick = { RDN2008: (/n-e/.test(projName) ? 6675 : 7759) + zone, ETRS89: 25800 + zone, ED50: 23000 + zone, IGM95: 3032 + zone, WGS84: 32600 + zone }[datum || "WGS84"];
    if (CRS.has(pick)) return pick;
  }
  // Gauss-Boaga scritto solo con i parametri (meridiano centrale e falsa origine)
  if (datum === "MM" && /transverse_mercator/.test(low)) {
    const cm = +((low.match(/central_meridian"\s*,\s*([-\d.]+)/) || [])[1]);
    if (cm === 9) return 3003;
    if (cm === 15) return 3004;
  }
  return null;
}

// GeoTIFF: chiavi GeoKey -> codice EPSG
export function codeFromGeoKeys(k) {
  if (!k) return null;
  const pc = k.ProjectedCSTypeGeoKey, gc = k.GeographicTypeGeoKey;
  if (pc && pc !== 32767) return ALIAS[pc] || pc;
  if (k.GTModelTypeGeoKey === 2 && gc && gc !== 32767) return ALIAS[gc] || gc;
  if (gc && gc !== 32767 && !pc) return gc;
  const cit = String(k.PCSCitationGeoKey || k.GTCitationGeoKey || "");
  return cit ? codeFromPrj(`PROJCS["${cit}"]`) : null;
}

// elenco per le scelte nell'interfaccia (sistemi di visualizzazione delle coordinate)
export function crsChoices() {
  const order = [4326, 3857, 6706, 7791, 7792, 7794, 25832, 25833, 32632, 32633, 3003, 3004, 4258, 4265, 3064, 3065, 23032, 23033, 7793, 25834, 32634, 23034, 7795, 6707, 6708, 6709, 6875, 6876, 4670, 4230, 3035];
  return order.filter(c => CRS.has(c)).map(c => ({ code: c, name: CRS.get(c).name }));
}
