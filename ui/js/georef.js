// Georeferenziazione di disegni (DWG/DXF) e tavole PDF: solo calcolo, nessuna interfaccia (collaudo: tests/test_georef.mjs).
// Trasformazione dal piano del disegno al sistema di riferimento scelto (proiettato, metri) come affine
//   X = a*x + b*y + c,  Y = d*x + e*y + f
// stimata ai minimi quadrati dai punti di controllo: rigida (scala nota dalle unita' o dalla scala della tavola,
// 1+ punti), similarita' (4 parametri, 2+ punti), affine (6 parametri, 3+ punti). Scarti per punto e RMS in metri.
// GEODATA di AutoCAD (DXF e DWG): punto di progetto -> punto di riferimento, scala, direzione del nord.

// $INSUNITS -> metri per unita' del disegno (0 = senza unita')
export const INSUNITS = { 1: 0.0254, 2: 0.3048, 3: 1609.344, 4: 0.001, 5: 0.01, 6: 1, 7: 1000, 8: 2.54e-8, 9: 2.54e-5, 10: 0.9144,
  11: 1e-10, 12: 1e-9, 13: 1e-6, 14: 0.1, 15: 10, 16: 100, 17: 1e9, 18: 1.495978707e11, 19: 9.4607304725808e15, 20: 3.0856776e16,
  21: 0.3048006096, 22: 0.0254000508, 23: 0.9144018288, 24: 1609.3472187 };
export const UNIT_CHOICES = [["mm", 0.001], ["cm", 0.01], ["dm", 0.1], ["m", 1], ["km", 1000], ["in", 0.0254], ["ft", 0.3048]];
export const PT_MM = 25.4 / 72;   // un punto PDF in millimetri

export const IDENTITY = [1, 0, 0, 0, 1, 0];
export const apply = (T, x, y) => [T[0] * x + T[1] * y + T[2], T[3] * x + T[4] * y + T[5]];
export function invert(T) {
  const [a, b, c, d, e, f] = T, det = a * e - b * d;
  if (!det || !isFinite(det)) return null;
  return [e / det, -b / det, (b * f - e * c) / det, -d / det, a / det, (d * c - a * f) / det];
}
export const scaleOf = T => Math.sqrt(Math.abs(T[0] * T[4] - T[1] * T[3]));
// rotazione in gradi (antioraria, dall'asse x del disegno all'est della mappa)
export const rotationOf = T => Math.atan2(T[3], T[0]) * 180 / Math.PI;

// risolve un sistema lineare (eliminazione di Gauss con pivot parziale); null se singolare
function solve(A, B) {
  const n = B.length, M = A.map((r, i) => [...r, B[i]]);
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
    if (Math.abs(M[p][k]) < 1e-12) return null;
    [M[k], M[p]] = [M[p], M[k]];
    for (let i = k + 1; i < n; i++) { const r = M[i][k] / M[k][k]; for (let j = k; j <= n; j++) M[i][j] -= r * M[k][j]; }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = M[i][n]; for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j]; x[i] = s / M[i][i]; }
  return x;
}

export const MIN_POINTS = { rigida: 1, similarita: 2, affine: 3 };

// pts: [{ x, y, X, Y, off? }] (x,y disegno; X,Y sistema di arrivo). scale0 = metri per unita' (per "rigida").
// rot0 = rotazione in gradi per la rigida con un solo punto. Ritorna { T, res: [scarti], rms, n } oppure { error }.
export function fit(method, pts, { scale0 = 1, rot0 = 0 } = {}) {
  const P = pts.filter(p => !p.off && [p.x, p.y, p.X, p.Y].every(Number.isFinite));
  const need = MIN_POINTS[method];
  if (!need) return { error: "metodo" };
  if (P.length < need) return { error: "pochi", need, n: P.length };
  // coordinate ridotte ai baricentri: numeri piccoli (coordinate UTM ~ 5e6) e soluzione meglio condizionata
  const n = P.length;
  const mx = P.reduce((s, p) => s + p.x, 0) / n, my = P.reduce((s, p) => s + p.y, 0) / n;
  const mX = P.reduce((s, p) => s + p.X, 0) / n, mY = P.reduce((s, p) => s + p.Y, 0) / n;
  const q = P.map(p => [p.x - mx, p.y - my, p.X - mX, p.Y - mY]);
  let a, b, d, e;
  if (method === "rigida") {
    let th = rot0 * Math.PI / 180;
    if (n >= 2) { // rotazione ai minimi quadrati (Procruste senza scala)
      let sxx = 0, sxy = 0;
      for (const [x, y, X, Y] of q) { sxx += x * X + y * Y; sxy += x * Y - y * X; }
      if (Math.hypot(sxx, sxy) > 0) th = Math.atan2(sxy, sxx);
    }
    a = scale0 * Math.cos(th); b = -scale0 * Math.sin(th); d = -b; e = a;
  } else if (method === "similarita") {
    let sxx = 0, sxy = 0, ss = 0;
    for (const [x, y, X, Y] of q) { sxx += x * X + y * Y; sxy += x * Y - y * X; ss += x * x + y * y; }
    if (!ss) return { error: "coincidenti" };
    a = sxx / ss; d = sxy / ss; b = -d; e = a;
  } else {
    let sxx = 0, sxy = 0, syy = 0, sxX = 0, syX = 0, sxY = 0, syY = 0;
    for (const [x, y, X, Y] of q) { sxx += x * x; sxy += x * y; syy += y * y; sxX += x * X; syX += y * X; sxY += x * Y; syY += y * Y; }
    const r1 = solve([[sxx, sxy], [sxy, syy]], [sxX, syX]), r2 = solve([[sxx, sxy], [sxy, syy]], [sxY, syY]);
    if (!r1 || !r2) return { error: "allineati" };
    [a, b] = r1; [d, e] = r2;
  }
  const T = [a, b, mX - a * mx - b * my, d, e, mY - d * mx - e * my];
  if (!T.every(Number.isFinite) || !(a * e - b * d)) return { error: "allineati" };
  return { T, ...residuals(T, pts), n };
}

// scarti (metri) di tutti i punti, anche di quelli esclusi dal calcolo; rms solo dei punti usati
export function residuals(T, pts) {
  let s = 0, k = 0;
  const res = pts.map(p => {
    if (![p.x, p.y, p.X, p.Y].every(Number.isFinite)) return null;
    const [X, Y] = apply(T, p.x, p.y), dx = X - p.X, dy = Y - p.Y, r = Math.hypot(dx, dy);
    if (!p.off) { s += r * r; k++; }
    return { dx, dy, r };
  });
  return { res, rms: k ? Math.sqrt(s / k) : 0 };
}

// trasformazione "rigida" che porta il punto (x,y) del disegno nel punto (X,Y): per il primo posizionamento
export const placeAt = (scale, rotDeg, x, y, X, Y) => {
  const th = rotDeg * Math.PI / 180, a = scale * Math.cos(th), d = scale * Math.sin(th);
  return [a, -d, X - a * x + d * y, d, a, Y - d * x - a * y];
};

// ---------------------------------------------------------------- disegni gia' in coordinate
// riconoscimento dalle estensioni (coordinate in metri): stessi intervalli del visualizzatore GIS
export function guessFromExtent(bb, unit = 1) {
  if (!bb || !bb.every(Number.isFinite)) return null;
  const [x0, y0, x1, y1] = bb.map(v => v * unit);
  if (x0 > 1.1e6 && x1 < 2.0e6 && y0 > 3.9e6 && y1 < 5.4e6) return 3003;   // Gauss-Boaga Ovest
  if (x0 > 2.1e6 && x1 < 3.0e6 && y0 > 3.9e6 && y1 < 5.4e6) return 3004;   // Gauss-Boaga Est
  if (x0 > 6.0e6 && x1 < 8.0e6 && y0 > 3.9e6 && y1 < 5.4e6) return 7794;   // RDN2008 fuso Italia
  if (x0 > 1.5e5 && x1 < 8.5e5 && y0 > 3.9e6 && y1 < 5.4e6) return 7791;   // UTM (fuso 32 il piu' frequente: si cambia a mano)
  return null;
}

// ---------------------------------------------------------------- GEODATA
// codice EPSG dalla definizione del sistema (XML di AutoCAD / Map 3D o WKT)
const ADSK_NAMES = { "UTM84-32N": 32632, "UTM84-33N": 32633, "UTM84-34N": 32634, "ETRS89.UTM-32N": 25832, "ETRS89.UTM-33N": 25833,
  "ETRS89.UTM-34N": 25834, "RDN2008.UTM-32N": 7791, "RDN2008.UTM-33N": 7792, "RDN2008.UTM-34N": 7793, "ITALY1": 3003, "ITALY2": 3004,
  "MonteMario.Italy-1": 3003, "MonteMario.Italy-2": 3004, "UTM-32N": 23032, "UTM-33N": 23033, "LL84": 4326, "WGS84.PseudoMercator": 3857 };
export function epsgFromCsDef(s) {
  s = String(s || "");
  if (!s) return null;
  const al = s.match(/<Alias\s+id="(\d{4,5})"[^>]*>[\s\S]{0,200}?EPSG/i) || s.match(/<Alias[^>]*>\s*<ObjectId>(\d{4,5})<\/ObjectId>\s*<Namespace>EPSG/i);
  if (al) return +al[1];
  const auth = [...s.matchAll(/(?:AUTHORITY|ID)\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]/gi)];
  if (auth.length) return +auth[auth.length - 1][1];
  const id = (s.match(/<(?:ProjectedCoordinateSystem|GeographicCoordinateSystem)\s+id="([^"]+)"/) || [])[1];
  if (id && ADSK_NAMES[id]) return ADSK_NAMES[id];
  const m = s.match(/EPSG[^0-9]{0,12}(\d{4,5})/i);
  return m ? +m[1] : null;
}

// dati GEODATA letti dal DXF di testo (sezione OBJECTS): null se assenti
export function geodataFromDxf(text) {
  const at = text.search(/\r?\n\s*0\r?\nGEODATA\r?\n/);
  if (at < 0) return null;
  const lines = text.slice(at).split(/\r?\n/).slice(3, 4000);
  const g = { design: [0, 0], ref: [0, 0], scale: 1, north: [0, 1], type: 2, def: "", units: 0 };
  let def = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = +lines[i].trim(), v = lines[i + 1];
    if (c === 0) break;
    const n = parseFloat(v);
    switch (c) {
      case 70: g.type = n; break;
      case 10: g.design[0] = n; break; case 20: g.design[1] = n; break;
      case 11: g.ref[0] = n; break; case 21: g.ref[1] = n; break;
      case 40: g.scale = n || 1; break;
      case 91: g.units = n; break;
      case 12: g.north[0] = n; break; case 22: g.north[1] = n; break;
      case 303: def.push(v); break;
      case 301: def.push(v); break;
      default: break;
    }
  }
  g.def = def.join("");
  return g;
}

// GEODATA -> { T, epsg, geographicRef }: per i sistemi geografici (tipo 3) il punto di riferimento e' lon/lat e va
// proiettato dal chiamante (refToCrs) nel sistema scelto
export function geodataTransform(g, refXY) {
  const [X, Y] = refXY || g.ref;
  const s = g.scale > 0 ? g.scale : 1;
  // angolo tra la direzione del nord nel disegno e l'asse y: la mappa ha il nord in alto
  const th = Math.PI / 2 - Math.atan2(g.north[1] || 0, g.north[0] || 0) ;
  return placeAt(s, th * 180 / Math.PI, g.design[0], g.design[1], X, Y);
}

// ---------------------------------------------------------------- file .mbgeo (JSON accanto al disegno)
export const MBGEO_VERSION = 1;
export function toMbgeo(file, g) {
  return {
    format: "MB Desk georef", version: MBGEO_VERSION, file,
    crs: g.crs, method: g.method, unit: g.unit, transform: g.T.map(v => +v.toPrecision(15)),
    points: (g.points || []).map(p => ({ x: p.x, y: p.y, X: p.X, Y: p.Y, ...(p.off ? { off: true } : {}) })),
    rms: g.rms ?? null, page: g.page ?? null, pdfScale: g.pdfScale ?? null, rot0: g.rot0 || 0,
    saved: new Date().toISOString(),
  };
}
export function fromMbgeo(o) {
  if (!o || typeof o !== "object" || !Array.isArray(o.transform) || o.transform.length !== 6 || !o.transform.every(Number.isFinite)) return null;
  return { crs: String(o.crs || ""), method: o.method || "affine", unit: +o.unit || 1, T: o.transform.slice(), points: Array.isArray(o.points) ? o.points.map(p => ({ ...p })) : [],
    rms: o.rms ?? null, page: o.page ?? null, pdfScale: o.pdfScale ?? null, rot0: +o.rot0 || 0 };
}
