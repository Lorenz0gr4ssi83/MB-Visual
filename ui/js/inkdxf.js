// Tratti della penna (ui/js/ink.js) -> polilinee nel disegno, su layer di revisione:
//   MARKUP          penna: LWPOLYLINE con larghezza per vertice (la pressione della penna diventa spessore vero, in unita' del disegno)
//   MARKUP-EVID     evidenziatore: LWPOLYLINE a larghezza costante con trasparenza 62% (codice 440)
// Colore vero (codice 420) piu' l'indice ACI piu' vicino (62) per i programmi che non leggono il 420.
// DXF esistente: le entita' si aggiungono in fondo a ENTITIES, i layer nella tabella LAYER, maniglie da $HANDSEED:
// il resto del file resta byte per byte com'era. DWG (che il browser non sa scrivere): DXF a parte con le sole revisioni,
// nelle stesse coordinate, da sovrapporre al disegno (riferimento esterno o INSERISCI in AutoCAD/BricsCAD).
import { hexRgb, widthAt, HL_ALPHA } from "./ink.js";
import { t } from "./i18n.js";

export const LAYER_PEN = "MARKUP", LAYER_HL = "MARKUP-EVID";
const f = v => (Math.round(v * 1e6) / 1e6).toString();

// indice ACI piu' vicino tra i colori base (1-9) e qualche colore pieno
const ACI_BASE = { 1: [255, 0, 0], 2: [255, 255, 0], 3: [0, 255, 0], 4: [0, 255, 255], 5: [0, 0, 255], 6: [255, 0, 255], 7: [255, 255, 255], 8: [128, 128, 128], 9: [192, 192, 192], 30: [255, 127, 0], 250: [51, 51, 51] };
function nearestAci(rgb) {
  let best = 7, d = Infinity;
  for (const [i, c] of Object.entries(ACI_BASE)) { const e = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2; if (e < d) { d = e; best = +i; } }
  return best;
}

function pairsOf(text) {
  const lines = text.split(/\r?\n/);
  const P = [];
  for (let i = 0; i + 1 < lines.length; i += 2) P.push([lines[i].trim(), lines[i + 1], lines[i]]); // riga del codice originale (spazi compresi)
  return P;
}
const findSection = (P, name) => { for (let i = 0; i + 1 < P.length; i++) if (P[i][0] === "0" && P[i][1].trim() === "SECTION" && P[i + 1][0] === "2" && P[i + 1][1].trim() === name) return i; return -1; };
const findEnd = (P, from, what = "ENDSEC") => { for (let i = from; i < P.length; i++) if (P[i][0] === "0" && P[i][1].trim() === what) return i; return -1; };

/** aggiunge i tratti a un DXF in testo; restituisce il testo nuovo */
export function addMarkupToDxf(text, strokes) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const P = pairsOf(text);
  const hdr = findSection(P, "HEADER");
  let ver = "AC1009", seedAt = -1, seed = 0;
  if (hdr >= 0) {
    const end = findEnd(P, hdr);
    for (let i = hdr; i < end; i++) {
      if (P[i][0] !== "9") continue;
      const v = P[i][1].trim();
      if (v === "$ACADVER") ver = P[i + 1][1].trim();
      if (v === "$HANDSEED") { seedAt = i + 1; seed = parseInt(P[i + 1][1].trim(), 16) || 0; }
    }
  }
  const modern = ver > "AC1009"; // R2000 e successivi: LWPOLYLINE, marcatori di sottoclasse, colore vero, trasparenza
  const handles = seedAt >= 0;
  // maniglie gia' usate (per sicurezza oltre a $HANDSEED)
  let next = seed;
  if (handles) for (const [c, v] of P) if (c === "5" || c === "105") { const h = parseInt(v.trim(), 16); if (h >= next) next = h + 1; }
  const H = () => (next++).toString(16).toUpperCase();
  // proprietario delle entita' dello spazio modello e della tabella dei layer
  let msOwner = null, layerTable = null;
  const tables = findSection(P, "TABLES");
  const existing = new Set();
  let layerEnd = -1;
  if (tables >= 0) {
    const tEnd = findEnd(P, tables);
    for (let i = tables; i < tEnd; i++) {
      if (P[i][0] === "0" && P[i][1].trim() === "TABLE" && P[i + 1]?.[0] === "2") {
        const name = P[i + 1][1].trim();
        if (name === "LAYER") {
          for (let j = i + 2; j < i + 8 && j < tEnd; j++) if (P[j][0] === "5") layerTable = P[j][1].trim();
          layerEnd = findEnd(P, i + 1, "ENDTAB");
          for (let j = i; j < layerEnd; j++) if (P[j][0] === "0" && P[j][1].trim() === "LAYER") { for (let q = j + 1; q < layerEnd && P[q][0] !== "0"; q++) if (P[q][0] === "2") existing.add(P[q][1].trim().toUpperCase()); }
        }
        if (name === "BLOCK_RECORD") {
          const e = findEnd(P, i + 1, "ENDTAB");
          for (let j = i; j < e; j++) if (P[j][0] === "0" && P[j][1].trim() === "BLOCK_RECORD") {
            let h = null, nm = null;
            for (let q = j + 1; q < e && P[q][0] !== "0"; q++) { if (P[q][0] === "5") h = P[q][1].trim(); if (P[q][0] === "2") nm = P[q][1].trim(); }
            if (nm && nm.toUpperCase() === "*MODEL_SPACE") msOwner = h;
          }
        }
      }
    }
  }
  const out = [];
  const add = (c, v) => out.push([String(c), String(v)]);
  // layer nuovi
  const newLayers = [];
  for (const [name, aci] of [[LAYER_PEN, 1], [LAYER_HL, 2]]) {
    if (existing.has(name) || !strokes.some(s => (s.tool === "hl") === (name === LAYER_HL))) continue;
    const L = [];
    const a = (c, v) => L.push([String(c), String(v)]);
    a(0, "LAYER");
    if (handles) a(5, H());
    if (modern) { if (layerTable) a(330, layerTable); a(100, "AcDbSymbolTableRecord"); a(100, "AcDbLayerTableRecord"); }
    a(2, name); a(70, 0); a(62, aci); a(6, "CONTINUOUS");
    if (modern) a(370, -3);
    newLayers.push(...L);
  }
  // entita'
  for (const st of strokes) {
    const hl = st.tool === "hl", rgb = hexRgb(st.color), pts = st.pts.length === 1 ? [st.pts[0], [st.pts[0][0] + st.w * 0.01, st.pts[0][1], st.pts[0][2]]] : st.pts;
    const ws = pts.map((_, i) => (hl ? st.w : widthAt(st, Math.min(i, st.pts.length - 1))));
    if (modern) {
      add(0, "LWPOLYLINE");
      if (handles) add(5, H());
      if (msOwner) add(330, msOwner);
      add(100, "AcDbEntity"); add(8, hl ? LAYER_HL : LAYER_PEN); add(62, nearestAci(rgb)); add(420, (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]);
      if (hl) add(440, 0x02000000 | Math.round(HL_ALPHA * 255));
      add(100, "AcDbPolyline"); add(90, pts.length); add(70, 0);
      if (hl) add(43, f(st.w));
      pts.forEach((p, i) => { add(10, f(p[0])); add(20, f(p[1])); if (!hl) { add(40, f(ws[i])); add(41, f(ws[Math.min(i + 1, pts.length - 1)])); } });
    } else {
      // R12: POLYLINE con VERTEX (larghezza iniziale e finale per vertice)
      add(0, "POLYLINE"); if (handles) add(5, H()); add(8, hl ? LAYER_HL : LAYER_PEN); add(62, nearestAci(rgb)); add(66, 1); add(10, 0); add(20, 0); add(30, 0); add(70, 0);
      if (hl) { add(40, f(st.w)); add(41, f(st.w)); }
      pts.forEach((p, i) => { add(0, "VERTEX"); if (handles) add(5, H()); add(8, hl ? LAYER_HL : LAYER_PEN); add(10, f(p[0])); add(20, f(p[1])); add(30, 0);
        if (!hl) { add(40, f(ws[i])); add(41, f(ws[Math.min(i + 1, pts.length - 1)])); } });
      add(0, "SEQEND"); if (handles) add(5, H()); add(8, hl ? LAYER_HL : LAYER_PEN);
    }
  }
  // inserimento: dal fondo verso l'inizio per non spostare gli indici
  const ins = [];
  const ent = findSection(P, "ENTITIES");
  if (ent < 0) throw new Error(t("ink.dxf_senza_entita"));
  ins.push([findEnd(P, ent), out]);
  if (newLayers.length && layerEnd >= 0) ins.push([layerEnd, newLayers]);
  ins.sort((a, b) => b[0] - a[0]);
  for (const [at, items] of ins) P.splice(at, 0, ...items);
  if (seedAt >= 0) P[seedAt] = [P[seedAt][0], next.toString(16).toUpperCase(), P[seedAt][2]];
  // la tabella LAYER dichiara quanti record contiene (70): si aggiorna se presente
  if (newLayers.length && layerEnd >= 0) {
    for (let i = 0; i < P.length; i++) if (P[i][0] === "0" && P[i][1].trim() === "TABLE" && P[i + 1]?.[1].trim() === "LAYER") {
      for (let j = i + 2; j < i + 10; j++) if (P[j][0] === "70") { P[j] = [P[j][0], String((parseInt(P[j][1]) || 0) + newLayers.filter(p => p[0] === "0").length), P[j][2]]; break; }
      break;
    }
  }
  return P.map(([c, v, raw]) => (raw ?? c.padStart(3, " ")) + eol + v).join(eol) + eol;
}

/** DXF (R12) con le sole revisioni, per i DWG che il browser non puo' riscrivere */
export function markupOnlyDxf(strokes) {
  const base = ["0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1009", "0", "ENDSEC",
    "0", "SECTION", "2", "TABLES", "0", "TABLE", "2", "LAYER", "70", "0", "0", "ENDTAB", "0", "ENDSEC",
    "0", "SECTION", "2", "ENTITIES", "0", "ENDSEC", "0", "EOF"];
  return addMarkupToDxf(base.join("\r\n") + "\r\n", strokes);
}
