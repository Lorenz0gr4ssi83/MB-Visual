// Icone dei comandi dell'editor CAD, disegnate sull'idea grafica delle icone AutoCAD (stesse forme, per ritrovarle
// subito): geometria nel colore del testo, punti di costruzione in blu, risultato del comando in giallo, parti tolte
// in rosso tratteggiato. SVG in linea, viewBox 24x24.
const B = "#4a9eff", Y = "#f2b200", R = "#e5534b", G = "#3fb950";
const pt = (x, y, c = B) => `<rect x="${x - 1.8}" y="${y - 1.8}" width="3.6" height="3.6" fill="${c}" stroke="none"/>`;
const dot = (x, y, c = B, r = 1.6) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" stroke="none"/>`;
const arrowHead = (x, y, a, c = "currentColor", s = 3.2) => { const r = a * Math.PI / 180, l = r + 2.7, q = r - 2.7; return `<path d="M${x} ${y}L${(x + s * Math.cos(l)).toFixed(2)} ${(y + s * Math.sin(l)).toFixed(2)}L${(x + s * Math.cos(q)).toFixed(2)} ${(y + s * Math.sin(q)).toFixed(2)}Z" fill="${c}" stroke="none"/>`; };
const dimH = (y, x1, x2, txt = "") => `<path d="M${x1} ${y}H${x2}"/>${arrowHead(x1, y, 0)}${arrowHead(x2, y, 180)}${txt}`;

const I = {
  line: `<path d="M4 19L20 5"/>${pt(4, 19)}${pt(20, 5)}`,
  pline: `<path d="M3 18L8 8L14 15Q17 4 21 6"/>${pt(3, 18)}${pt(8, 8)}${pt(14, 15)}${pt(21, 6)}`,
  circle: `<circle cx="12" cy="12" r="8"/>${dot(12, 12)}<path d="M12 12L19.5 9" stroke="${B}" stroke-dasharray="2 1.5"/>`,
  circled: `<circle cx="12" cy="12" r="8"/>${dot(12, 12)}<path d="M5 15L19 9" stroke="${B}" stroke-dasharray="2 1.5"/>`,
  circle3p: `<circle cx="12" cy="12" r="8"/>${pt(4.6, 15)}${pt(15, 4.6)}${pt(18.5, 16.5)}`,
  arc: `<path d="M4 18A9.5 9.5 0 0 1 20 18"/>${pt(4, 18)}${pt(12, 8.6)}${pt(20, 18)}`,
  arccse: `<path d="M4 17A8 8 0 0 1 20 17"/>${dot(12, 17)}${pt(4, 17)}${pt(20, 17)}<path d="M12 17L5 17" stroke="${B}" stroke-dasharray="2 1.5"/>`,
  rect: `<rect x="4" y="6" width="16" height="12"/>${pt(4, 18)}${pt(20, 6)}`,
  ellipse: `<ellipse cx="12" cy="12" rx="9" ry="5.5"/>${dot(12, 12)}${pt(21, 12)}${pt(12, 6.5)}`,
  hatch: `<rect x="4" y="4" width="16" height="16"/><path d="M4 10L10 4M4 16L16 4M4 20L20 4M8 20L20 8M14 20L20 14" stroke="${Y}" stroke-width="1.2"/>`,
  mtext: `<path d="M4 5H14M4 9H20M4 13H18M4 17H12" stroke-width="1.4"/><text x="15" y="21" font-size="9" font-weight="700" fill="${B}" stroke="none" font-family="Arial">A</text>`,
  text: `<text x="5" y="18" font-size="15" font-weight="700" fill="currentColor" stroke="none" font-family="Arial">A</text><path d="M3 20H21" stroke="${B}"/>`,
  move: `<path d="M12 3V21M3 12H21"/>${arrowHead(12, 3, 90)}${arrowHead(12, 21, -90)}${arrowHead(3, 12, 0)}${arrowHead(21, 12, 180)}`,
  copy: `<rect x="3" y="11" width="9" height="9"/><rect x="12" y="4" width="9" height="9" stroke="${Y}"/><path d="M8 9L13 5" stroke="${B}"/>${arrowHead(13, 5, 145, B)}`,
  rotate: `<path d="M18.5 9A7.5 7.5 0 1 0 19 15"/>${arrowHead(19, 15, -65)}<rect x="9" y="9" width="6" height="6" stroke="${Y}"/>${dot(12, 12)}`,
  scale: `<rect x="3" y="11" width="10" height="10"/><rect x="3" y="3" width="18" height="18" stroke="${Y}" stroke-dasharray="3 1.5"/><path d="M9 15L19 5" stroke="${B}"/>${arrowHead(19, 5, 135, B)}`,
  mirror: `<path d="M12 2V22" stroke="${B}" stroke-dasharray="3 2"/><path d="M10 6L3 18H10Z"/><path d="M14 6L21 18H14Z" stroke="${Y}"/>`,
  stretch: `<path d="M3 5H11L15 19H3Z"/><path d="M11 5H19L15 19" stroke="${Y}" stroke-dasharray="3 1.5"/><path d="M12 12H21" stroke="${B}"/>${arrowHead(21, 12, 180, B)}`,
  array: `<rect x="3" y="3" width="5" height="5"/><rect x="10" y="3" width="5" height="5" stroke="${Y}"/><rect x="17" y="3" width="4" height="5" stroke="${Y}"/><rect x="3" y="10" width="5" height="5" stroke="${Y}"/><rect x="10" y="10" width="5" height="5" stroke="${Y}"/><rect x="17" y="10" width="4" height="5" stroke="${Y}"/><rect x="3" y="17" width="5" height="4" stroke="${Y}"/><rect x="10" y="17" width="5" height="4" stroke="${Y}"/><rect x="17" y="17" width="4" height="4" stroke="${Y}"/>`,
  arraypolar: `<circle cx="12" cy="12" r="7" stroke="${B}" stroke-dasharray="2 1.5"/><rect x="10" y="3" width="4" height="4"/><rect x="17" y="10" width="4" height="4" stroke="${Y}"/><rect x="10" y="17" width="4" height="4" stroke="${Y}"/><rect x="3" y="10" width="4" height="4" stroke="${Y}"/>${dot(12, 12)}`,
  offset: `<path d="M3 20Q5 6 20 4"/><path d="M8 21Q9 11 21 9" stroke="${Y}"/><path d="M8 9L11 13" stroke="${B}"/>${arrowHead(11, 13, -125, B, 2.6)}`,
  trim: `<path d="M3 12H12"/><path d="M12 12H21" stroke="${R}" stroke-dasharray="2.5 1.5"/><path d="M12 3V21" stroke="${B}"/><path d="M15 16L19 20M19 16L15 20" stroke="${R}"/>`,
  extend: `<path d="M3 12H12"/><path d="M12 12H19" stroke="${Y}" stroke-dasharray="2.5 1.5"/><path d="M19 3V21" stroke="${B}"/>${arrowHead(19, 12, 180, Y)}`,
  fillet: `<path d="M4 20V12A8 8 0 0 1 12 4H20"/><path d="M4 12V4H12" stroke="${R}" stroke-dasharray="2 1.5"/>${pt(4, 20)}${pt(20, 4)}`,
  chamfer: `<path d="M4 20V11L11 4H20"/><path d="M4 11V4H11" stroke="${R}" stroke-dasharray="2 1.5"/>${pt(4, 20)}${pt(20, 4)}`,
  explode: `<path d="M9 9H15V15H9Z"/><path d="M5 5L8 8M19 5L16 8M5 19L8 16M19 19L16 16" stroke="${Y}"/><path d="M12 2V6M12 18V22M2 12H6M18 12H22" stroke="${Y}"/>`,
  erase: `<path d="M8 20L3 15L13 5L21 13L14 20Z"/><path d="M8 10L16 18" /><path d="M8 20H21" stroke="${R}"/><path d="M3 15L8 10L13 15L8 20Z" fill="${R}" fill-opacity=".35" stroke="none"/>`,
  dimlin: `<path d="M5 20V8M19 20V8" stroke="${B}"/>${dimH(10, 5, 19)}<text x="8.2" y="7.5" font-size="6.5" fill="currentColor" stroke="none" font-family="Arial">25</text>`,
  dimali: `<path d="M3 15L15 3" stroke="${B}"/><path d="M8 20L20 8"/>${arrowHead(8, 20, -45)}${arrowHead(20, 8, 135)}<path d="M3 15L8 20M15 3L20 8" stroke="${B}"/>`,
  dimang: `<path d="M4 20L20 20M4 20L16 6" stroke="${B}"/><path d="M15 20A11 11 0 0 0 11.2 11.6"/>${arrowHead(15, 20, -90)}${arrowHead(11.2, 11.6, 40)}<text x="16" y="15" font-size="6" fill="currentColor" stroke="none" font-family="Arial">°</text>`,
  dimrad: `<circle cx="10" cy="14" r="7" stroke="${B}"/>${dot(10, 14)}<path d="M10 14L15 9L21 9"/>${arrowHead(15, 9, 135)}<text x="15" y="7" font-size="6" fill="currentColor" stroke="none" font-family="Arial">R</text>`,
  dimdia: `<circle cx="11" cy="13" r="7" stroke="${B}"/><path d="M6 18L16 8L21 8"/>${arrowHead(6, 18, -45)}${arrowHead(16, 8, 135)}<text x="15" y="6.5" font-size="6" fill="currentColor" stroke="none" font-family="Arial">Ø</text>`,
  dimord: `<path d="M5 21V5M3 19H21" stroke="${B}"/><path d="M11 19V11L14 8V4M17 19V14L20 11V4"/><text x="9" y="4" font-size="5" fill="currentColor" stroke="none" font-family="Arial">X</text>`,
  dimcont: `<path d="M3 20V9M12 20V9M21 20V9" stroke="${B}"/>${dimH(11, 3, 12)}${dimH(11, 12, 21).replace(/currentColor/g, Y).replace('<path d="M12 11H21"/>', `<path d="M12 11H21" stroke="${Y}"/>`)}`,
  dimbase: `<path d="M3 21V5M11 21V11M20 21V5" stroke="${B}"/>${dimH(13, 3, 11)}<path d="M3 7H20" stroke="${Y}"/>${arrowHead(3, 7, 0, Y)}${arrowHead(20, 7, 180, Y)}`,
  dimstyle: `${dimH(8, 4, 20)}<path d="M4 4V12M20 4V12" stroke="${B}"/><path d="M14 22L14 17L20 14L22 16L16 19Z" fill="${Y}" stroke="none"/>`,
  dist: `<path d="M3 17L21 7"/>${pt(3, 17)}${pt(21, 7)}<path d="M5 20L23 10" stroke="${B}" stroke-dasharray="2 1.5"/>`,
  area: `<path d="M4 18L7 5L19 7L20 19Z" fill="${B}" fill-opacity=".25"/>${pt(4, 18)}${pt(7, 5)}${pt(19, 7)}${pt(20, 19)}`,
  selectall: `<rect x="3" y="3" width="18" height="18" stroke="${B}" stroke-dasharray="3 2"/><path d="M7 15L11 8L16 14Z"/><circle cx="16" cy="8" r="2"/>`,
  matchprop: `<path d="M4 20L12 12" stroke-width="2.6" stroke="${Y}"/><path d="M11 5H19V9H11Z" fill="${B}" stroke="none"/><path d="M14 9V12H12"/><path d="M15 3V5"/>`,
  copyclip: `<rect x="8" y="3" width="12" height="14"/><rect x="4" y="7" width="12" height="14" fill="var(--panel, #fff)"/>`,
  paste: `<rect x="4" y="5" width="13" height="16"/><rect x="8" y="3" width="5" height="4" fill="${B}" stroke="none"/><rect x="11" y="11" width="10" height="11" fill="var(--panel, #fff)" stroke="${Y}"/>`,
  layer: `<path d="M12 4L21 9L12 14L3 9Z" fill="${Y}" fill-opacity=".35"/><path d="M3 13L12 18L21 13" /><path d="M3 17L12 22L21 17"/>`,
  layernew: `<path d="M11 5L19 9L11 13L3 9Z" fill="${Y}" fill-opacity=".35"/><path d="M3 13L11 17L15 15"/><path d="M19 14V22M15 18H23" stroke="${G}" stroke-width="2"/>`,
  layercur: `<path d="M12 4L21 9L12 14L3 9Z" fill="${Y}" fill-opacity=".35"/><path d="M3 13L12 18L21 13"/><path d="M8 21L11 18L16 22" stroke="${G}" stroke-width="2"/>`,
  zoomext: `<rect x="3" y="3" width="18" height="18" stroke="${B}" stroke-dasharray="3 2"/><circle cx="11" cy="11" r="5"/><path d="M15 15L20 20" stroke-width="2.2"/>`,
  zoomwin: `<rect x="2" y="2" width="12" height="9" stroke="${B}"/><circle cx="13" cy="13" r="5"/><path d="M17 17L22 22" stroke-width="2.2"/>`,
  undo: `<path d="M8 8H15A5 5 0 0 1 15 18H7"/>${arrowHead(5, 8, 0, "currentColor", 4)}`,
  redo: `<path d="M16 8H9A5 5 0 0 0 9 18H17"/>${arrowHead(19, 8, 180, "currentColor", 4)}`,
  props: `<rect x="3" y="3" width="18" height="18"/><path d="M7 8H17M7 12H17M7 16H13"/>`,
};

export function cadIcon(name, size = 16) {
  const body = I[name] || I.props;
  const span = document.createElement("span");
  span.className = "cad-ico";
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  return span;
}
export const hasIcon = n => n in I;
