// Forme base dell'editor di diagrammi, come gli stencil "Forme di base", "Diagramma di flusso di base" e "Connettori"
// di Visio. La geometria si scrive con le formule (Width, Height) come fa Visio: ridimensionando, Visio e MB Desk
// ricalcolano le stesse coordinate. Dimensioni predefinite in pollici (unita' interne di Visio).
import { t } from "./i18n.js";
const MM = 1 / 25.4;
const R = (x, y) => ({ X: `Width*${x}`, Y: `Height*${y}` });
const poly = pts => [["MoveTo", R(...pts[0])], ...pts.slice(1).map(p => ["LineTo", R(...p)]), ["LineTo", R(...pts[0])]];
const star = (n, inner) => {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = Math.PI / 2 + i * Math.PI / n, r = i % 2 ? inner : 0.5;
    pts.push([+(0.5 + r * Math.cos(a)).toFixed(5), +(0.5 + r * Math.sin(a)).toFixed(5)]);
  }
  return poly(pts);
};
const ngon = n => {
  const pts = [];
  for (let i = 0; i < n; i++) { const a = -Math.PI / 2 - Math.PI / n + i * 2 * Math.PI / n; pts.push([+(0.5 + 0.5 * Math.cos(a)).toFixed(5), +(0.5 + 0.5 * Math.sin(a)).toFixed(5)]); }
  return poly(pts);
};
const ellipse = [["Ellipse", { X: "Width*0.5", Y: "Height*0.5", A: "Width*1", B: "Height*0.5", C: "Width*0.5", D: "Height*1" }]];
const rounded = r => [
  ["MoveTo", { X: r, Y: "Height*0" }], ["LineTo", { X: `Width-${r}`, Y: "Height*0" }], ["ArcTo", { X: "Width*1", Y: r, A: `${r}*0.2929` }],
  ["LineTo", { X: "Width*1", Y: `Height-${r}` }], ["ArcTo", { X: `Width-${r}`, Y: "Height*1", A: `${r}*0.2929` }], ["LineTo", { X: r, Y: "Height*1" }],
  ["ArcTo", { X: "Width*0", Y: `Height-${r}`, A: `${r}*0.2929` }], ["LineTo", { X: "Width*0", Y: r }], ["ArcTo", { X: r, Y: "Height*0", A: `${r}*0.2929` }],
];
const pill = [
  ["MoveTo", { X: "MIN(Width,Height)*0.5", Y: "Height*0" }], ["LineTo", { X: "Width-MIN(Width,Height)*0.5", Y: "Height*0" }],
  ["ArcTo", { X: "Width-MIN(Width,Height)*0.5", Y: "Height*1", A: "MIN(Width,Height)*0.5" }], ["LineTo", { X: "MIN(Width,Height)*0.5", Y: "Height*1" }],
  ["ArcTo", { X: "MIN(Width,Height)*0.5", Y: "Height*0", A: "MIN(Width,Height)*0.5" }],
];
const cylD = "Width/(Height*0.2)";
const cylinder = [
  { rows: [["MoveTo", R(0, 0.9)], ["LineTo", R(0, 0.1)], ["EllipticalArcTo", { X: "Width*1", Y: "Height*0.1", A: "Width*0.5", B: "Height*0", C: "0", D: cylD }], ["LineTo", R(1, 0.9)], ["EllipticalArcTo", { X: "Width*0", Y: "Height*0.9", A: "Width*0.5", B: "Height*1", C: "0", D: cylD }]] },
  { noFill: true, rows: [["MoveTo", R(0, 0.9)], ["EllipticalArcTo", { X: "Width*1", Y: "Height*0.9", A: "Width*0.5", B: "Height*0.8", C: "0", D: cylD }]] },
];
const documentShape = [
  ["MoveTo", R(0, 1)], ["LineTo", R(0, 0.12)], ["CubBezTo", { X: "Width*0.5", Y: "Height*0.1", A: "Width*0.2", B: "Height*-0.06", C: "Width*0.3", D: "Height*-0.06" }],
  ["CubBezTo", { X: "Width*1", Y: "Height*0.08", A: "Width*0.7", B: "Height*0.26", C: "Width*0.85", D: "Height*0.24" }], ["LineTo", R(1, 1)], ["LineTo", R(0, 1)],
];

// { id, name, w, h (pollici), geom: righe | [{ rows, noFill, noLine }], keys (ricerca), text }
export const STENCILS = [
  { id: "base", name: t("vsdshapes.forme_base"), shapes: [
    { id: "rect", name: t("vsdshapes.rettangolo"), w: 30 * MM, h: 20 * MM, geom: poly([[0, 0], [1, 0], [1, 1], [0, 1]]) },
    { id: "square", name: t("vsdshapes.quadrato"), w: 20 * MM, h: 20 * MM, geom: poly([[0, 0], [1, 0], [1, 1], [0, 1]]) },
    { id: "rrect", name: t("vsdshapes.rettangolo_arrotondato"), w: 30 * MM, h: 20 * MM, geom: rounded("MIN(Width,Height)*0.15") },
    { id: "ellipse", name: t("vsdshapes.ellisse"), w: 30 * MM, h: 20 * MM, geom: ellipse },
    { id: "circle", name: t("vsdshapes.cerchio"), w: 20 * MM, h: 20 * MM, geom: ellipse },
    { id: "triangle", name: t("vsdshapes.triangolo"), w: 25 * MM, h: 20 * MM, geom: poly([[0, 0], [1, 0], [0.5, 1]]) },
    { id: "rtriangle", name: t("vsdshapes.triangolo_rettangolo"), w: 25 * MM, h: 20 * MM, geom: poly([[0, 0], [1, 0], [0, 1]]) },
    { id: "diamond", name: t("vsdshapes.rombo"), w: 25 * MM, h: 20 * MM, geom: poly([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]) },
    { id: "pentagon", name: t("vsdshapes.pentagono"), w: 22 * MM, h: 21 * MM, geom: poly([[0.19, 0], [0.81, 0], [1, 0.62], [0.5, 1], [0, 0.62]]) },
    { id: "hexagon", name: t("vsdshapes.esagono"), w: 25 * MM, h: 21 * MM, geom: poly([[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]]) },
    { id: "octagon", name: t("vsdshapes.ottagono"), w: 22 * MM, h: 22 * MM, geom: ngon(8) },
    { id: "star5", name: t("vsdshapes.stella_5_punte"), w: 22 * MM, h: 22 * MM, geom: star(5, 0.2) },
    { id: "star8", name: t("vsdshapes.stella_8_punte"), w: 22 * MM, h: 22 * MM, geom: star(8, 0.32) },
    { id: "parallelogram", name: t("vsdshapes.parallelogramma"), w: 30 * MM, h: 18 * MM, geom: poly([[0, 0], [0.8, 0], [1, 1], [0.2, 1]]) },
    { id: "trapezoid", name: t("vsdshapes.trapezio"), w: 30 * MM, h: 18 * MM, geom: poly([[0, 0], [1, 0], [0.8, 1], [0.2, 1]]) },
    { id: "cross", name: t("vsdshapes.croce"), w: 20 * MM, h: 20 * MM, geom: poly([[0.33, 0], [0.67, 0], [0.67, 0.33], [1, 0.33], [1, 0.67], [0.67, 0.67], [0.67, 1], [0.33, 1], [0.33, 0.67], [0, 0.67], [0, 0.33], [0.33, 0.33]]) },
    { id: "arrowR", name: t("vsdshapes.freccia_destra"), w: 30 * MM, h: 15 * MM, geom: poly([[0, 0.3], [0.65, 0.3], [0.65, 0], [1, 0.5], [0.65, 1], [0.65, 0.7], [0, 0.7]]) },
    { id: "arrowLR", name: t("vsdshapes.freccia_doppia"), w: 30 * MM, h: 15 * MM, geom: poly([[0, 0.5], [0.25, 0], [0.25, 0.3], [0.75, 0.3], [0.75, 0], [1, 0.5], [0.75, 1], [0.75, 0.7], [0.25, 0.7], [0.25, 1]]) },
    { id: "arrowU", name: t("vsdshapes.freccia"), w: 15 * MM, h: 30 * MM, geom: poly([[0.3, 0], [0.7, 0], [0.7, 0.65], [1, 0.65], [0.5, 1], [0, 0.65], [0.3, 0.65]]) },
    { id: "cylinder", name: t("vsdshapes.cilindro"), w: 20 * MM, h: 28 * MM, geom: cylinder },
    { id: "text", name: t("vsdshapes.casella_testo"), w: 30 * MM, h: 8 * MM, geom: [], text: t("vsdshapes.testo"), textOnly: true },
  ] },
  { id: "flow", name: t("vsdshapes.diagramma_flusso_base"), shapes: [
    { id: "process", name: t("vsdshapes.processo"), w: 30 * MM, h: 20 * MM, geom: poly([[0, 0], [1, 0], [1, 1], [0, 1]]), keys: t("vsdshapes.processo_attivita_passo") },
    { id: "decision", name: t("vsdshapes.decisione"), w: 30 * MM, h: 20 * MM, geom: poly([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]), keys: t("vsdshapes.decisione_rombo_se_condizione") },
    { id: "terminator", name: "Inizio/Fine", w: 30 * MM, h: 12 * MM, geom: pill, keys: t("vsdshapes.terminatore_inizio_fine_start_end") },
    { id: "data", name: t("vsdshapes.dati"), w: 30 * MM, h: 18 * MM, geom: poly([[0, 0], [0.8, 0], [1, 1], [0.2, 1]]), keys: t("vsdshapes.dati_input_output") },
    { id: "document", name: t("vsdshapes.documento"), w: 30 * MM, h: 20 * MM, geom: documentShape, keys: "documento" },
    { id: "subprocess", name: t("vsdshapes.sottoprocesso"), w: 30 * MM, h: 20 * MM, geom: [{ rows: poly([[0, 0], [1, 0], [1, 1], [0, 1]]) }, { noFill: true, rows: [["MoveTo", R(0.1, 0)], ["LineTo", R(0.1, 1)], ["MoveTo", R(0.9, 0)], ["LineTo", R(0.9, 1)]] }], keys: t("vsdshapes.processo_predefinito_sottoprocesso") },
    { id: "database", name: t("vsdshapes.database"), w: 20 * MM, h: 25 * MM, geom: cylinder, keys: t("vsdshapes.database_archivio_cilindro") },
    { id: "preparation", name: t("vsdshapes.preparazione"), w: 30 * MM, h: 18 * MM, geom: poly([[0.2, 0], [0.8, 0], [1, 0.5], [0.8, 1], [0.2, 1], [0, 0.5]]), keys: t("vsdshapes.preparazione_esagono") },
    { id: "manual", name: t("vsdshapes.operazione_manuale"), w: 30 * MM, h: 18 * MM, geom: poly([[0.2, 0], [0.8, 0], [1, 1], [0, 1]]), keys: "manuale" },
    { id: "onpage", name: t("vsdshapes.riferimento_pagina"), w: 10 * MM, h: 10 * MM, geom: ellipse, keys: t("vsdshapes.connettore_cerchio_riferimento") },
    { id: "offpage", name: t("vsdshapes.riferimento_altra_pagina"), w: 12 * MM, h: 14 * MM, geom: poly([[0.5, 0], [1, 0.3], [1, 1], [0, 1], [0, 0.3]]), keys: t("vsdshapes.riferimento_pagina_2") },
  ] },
  { id: "conn", name: t("vsdshapes.connettori"), shapes: [
    { id: "dynconn", name: t("vsdshapes.connettore_dinamico"), connector: "dynamic", keys: t("vsdshapes.connettore_freccia_collegamento") },
    { id: "line", name: t("vsdshapes.linea"), connector: "line", keys: t("vsdshapes.linea_retta") },
    { id: "arrow", name: t("vsdshapes.freccia_2"), connector: "arrow", keys: t("vsdshapes.freccia_linea") },
  ] },
];
export const shapeDef = id => { for (const st of STENCILS) for (const s of st.shapes) if (s.id === id) return s; return null; };

// anteprima SVG della forma (pannello Forme)
export function shapeIcon(def, size = 38) {
  const pad = 3, k = size - pad * 2;
  if (def.connector) {
    const arrow = def.connector !== "line" ? `<path d="M${size - pad - 7} ${pad + 3}L${size - pad} ${pad}L${size - pad - 3} ${pad + 7}Z" fill="currentColor"/>` : "";
    const d = def.connector === "dynamic" ? `M${pad} ${size - pad}H${size / 2}V${pad}H${size - pad}` : `M${pad} ${size - pad}L${size - pad} ${pad}`;
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5"/>${arrow}</svg>`;
  }
  if (def.textOnly) return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><text x="${size / 2}" y="${size / 2 + 6}" text-anchor="middle" font-family="Calibri, Segoe UI" font-size="18" fill="currentColor">A</text><rect x="${pad + 2}" y="${pad + 6}" width="${k - 4}" height="${k - 12}" fill="none" stroke="currentColor" stroke-dasharray="2 2" stroke-width="0.8"/></svg>`;
  const ar = def.w / def.h;
  const w = ar >= 1 ? k : k * ar, h = ar >= 1 ? k / ar : k, x0 = (size - w) / 2, y0 = (size - h) / 2;
  const ev = f => { const s = String(f).replace(/Width/g, w).replace(/Height/g, h).replace(/MIN\(/g, "Math.min("); try { return Function(`return (${s})`)(); } catch { return 0; } };
  const secs = Array.isArray(def.geom[0]) ? [{ rows: def.geom }] : def.geom;
  let out = "";
  for (const sec of secs) {
    let d = "", cur = [0, 0];
    for (const [T, c] of sec.rows) {
      const X = ev(c.X), Y = ev(c.Y);
      const px = x => x0 + x, py = y => y0 + h - y;
      if (T === "MoveTo") d += `M${px(X)} ${py(Y)}`;
      else if (T === "LineTo") d += `L${px(X)} ${py(Y)}`;
      else if (T === "Ellipse") d += `M${px(X - ev(c.A) + X)} ${py(Y)}A${w / 2} ${h / 2} 0 1 0 ${px(ev(c.A))} ${py(Y)}A${w / 2} ${h / 2} 0 1 0 ${px(X - ev(c.A) + X)} ${py(Y)}Z`;
      else if (T === "ArcTo") { const r = Math.abs(ev(c.A)) / 0.2929 > Math.max(w, h) ? Math.abs(ev(c.A)) : Math.abs(ev(c.A)) / (Math.abs(ev(c.A)) > Math.min(w, h) * 0.4 ? 1 : 0.2929); d += `A${r} ${r} 0 0 0 ${px(X)} ${py(Y)}`; }
      else if (T === "EllipticalArcTo") d += `A${w / 2} ${h * 0.1} 0 0 ${ev(c.B) > Y ? 0 : 1} ${px(X)} ${py(Y)}`;
      else if (T === "CubBezTo") d += `C${px(ev(c.A))} ${py(ev(c.B))} ${px(ev(c.C))} ${py(ev(c.D))} ${px(X)} ${py(Y)}`;
      cur = [X, Y];
    }
    out += `<path d="${d}" fill="${sec.noFill ? "none" : "var(--vs-icofill)"}" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>`;
  }
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${out}</svg>`;
}
