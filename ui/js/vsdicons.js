// Icone dell'editor di diagrammi, sull'idea delle icone della barra multifunzione di Visio (stesse forme e colori di
// accento, nessun marchio). Quelle comuni agli altri programmi Office vengono da pubicons.js.
import { pubIcon } from "./pubicons.js";

const B = "#2f75c8", V = "#3955a3", O = "#e07a1f", G = "#3b8f3b", R = "#c4314b", GR = "#8a96a3", Y = "#e8b100";
const F = c => `fill="${c}" stroke="none"`;
const I = {
  pointer: `<path d="M6 3l12 9.5-5.2.6 3 6.3-2.6 1.2-3-6.4L6 18z" fill="#fff" stroke-linejoin="round"/>`,
  connector: `<rect x="2.5" y="3" width="7" height="5" rx="1" ${F(V)}/><rect x="14.5" y="16" width="7" height="5" rx="1" ${F(V)}/><path d="M9.5 5.5h4v13h1" stroke="${O}" stroke-width="1.6"/><path d="M12.6 16.5l2.2 2-2.2 2" stroke="${O}" stroke-width="1.6"/>`,
  textTool: `<path d="M5 6V4h14v2M12 4v16M9 20h6" stroke-width="1.8"/>`,
  rect: `<rect x="3.5" y="5.5" width="17" height="13" ${F("#dbe7f6")}/><rect x="3.5" y="5.5" width="17" height="13" stroke="${B}"/>`,
  ellipse: `<ellipse cx="12" cy="12" rx="9" ry="6.5" ${F("#dbe7f6")}/><ellipse cx="12" cy="12" rx="9" ry="6.5" stroke="${B}"/>`,
  line: `<path d="M4 19L20 5" stroke="${B}" stroke-width="1.8"/><circle cx="4" cy="19" r="1.6" ${F(B)}/><circle cx="20" cy="5" r="1.6" ${F(B)}/>`,
  pencil: `<path d="M4 20l1.2-4.6L16 4.6l3.4 3.4L8.6 18.8z" fill="#fff"/><path d="M14 7l3.4 3.4" /><path d="M4 20l1.2-4.6 3.4 3.4z" ${F(O)}/>`,
  arc: `<path d="M4 19A15 15 0 0 1 19 4" stroke="${B}" stroke-width="1.8"/>`,
  conpoint: `<rect x="4" y="6" width="16" height="12" rx="1"/><path d="M10 12h4M12 10v4" stroke="${B}" stroke-width="1.8"/><path d="M2.5 12h3M18.5 12h3" stroke="${B}" stroke-width="1.6"/>`,
  shapes: `<rect x="2.5" y="11" width="9" height="9" ${F(B)}/><circle cx="16.5" cy="7.5" r="5" ${F(O)}/><path d="M14 21l4-7 4 7z" ${F(G)}/>`,
  layers: `<path d="M12 3l9 4.5-9 4.5-9-4.5z" ${F(B)}/><path d="M3 12l9 4.5 9-4.5" stroke="${B}"/><path d="M3 16.5L12 21l9-4.5" />`,
  shapedata: `<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9h18M3 14h18M10 4v16" /><rect x="11" y="10" width="9" height="3" ${F("#cfe0f5")}/>`,
  sizepos: `<rect x="6" y="6" width="12" height="12" stroke="${B}"/><path d="M3 3v4M3 3h4M21 21v-4M21 21h-4M3 21h4M3 21v-4M21 3h-4M21 3v4"/>`,
  pageAdd: `<path d="M6 2.5h8l4 4V21H6z" fill="#fff"/><path d="M14 2.5v4h4"/><path d="M12 11v7M8.5 14.5h7" stroke="${G}" stroke-width="1.8"/>`,
  pageSize: `<path d="M5 2.5h10l4 4V21.5H5z" fill="#fff"/><path d="M8 18.5h8M8 18.5l2-1.5M8 18.5l2 1.5M16 18.5l-2-1.5M16 18.5l-2 1.5" stroke="${B}"/>`,
  fitDrawing: `<rect x="3" y="3" width="18" height="18" rx="1" fill="#fff"/><rect x="7" y="8" width="5" height="4" ${F(B)}/><circle cx="16" cy="15" r="2.4" ${F(O)}/><path d="M3 7V3h4M17 3h4v4M21 17v4h-4M7 21H3v-4" stroke="${G}" stroke-width="1.6"/>`,
  fullscreen: `<rect x="3" y="5" width="18" height="13" rx="1"/><path d="M9 21h6M12 18v3"/><path d="M7 9V8h2M17 9V8h-2M7 14v1h2M17 14v1h-2" stroke="${B}"/>`,
  panel: `<rect x="3" y="4" width="18" height="16" rx="1"/><rect x="3" y="4" width="6" height="16" ${F("#cfe0f5")}/><path d="M9 4v16"/>`,
  fillBucket: `<path d="M5 11l7-7 7 7-7 7z" fill="#fff"/><path d="M19 13c0 2 1.5 3 1.5 4.5a1.5 1.5 0 0 1-3 0c0-1.5 1.5-2.5 1.5-4.5z" ${F(B)}/><rect x="3" y="20" width="18" height="2.5" class="vs-swatch" ${F(Y)}/>`,
  lineColor: `<path d="M4 15L15 4l3 3L7 18H4z" fill="#fff"/><rect x="3" y="20" width="18" height="2.5" class="vs-swatch" ${F(B)}/>`,
  weight: `<path d="M3 5h18" stroke-width="1"/><path d="M3 10h18" stroke-width="2"/><path d="M3 16h18" stroke-width="3.5"/>`,
  dashes: `<path d="M3 6h18" stroke-dasharray="4 2"/><path d="M3 12h18" stroke-dasharray="1.5 2"/><path d="M3 18h18" stroke-dasharray="6 2 1.5 2"/>`,
  arrows: `<path d="M3 7h15M15 4l3 3-3 3" stroke-width="1.6"/><path d="M21 17H6M9 14l-3 3 3 3" stroke-width="1.6" stroke="${B}"/>`,
  shadowIco: `<rect x="7" y="7" width="13" height="12" ${F(GR)}/><rect x="4" y="4" width="13" height="12" fill="#fff"/>`,
  image: `<rect x="3" y="4.5" width="18" height="15" rx="1" fill="#fff"/><path d="M5 17.5l4.5-5.5 3.5 4 2.5-2.5 3.5 4" stroke="${G}" stroke-width="1.5"/><circle cx="15.5" cy="9" r="1.8" ${F(Y)}/>`,
  zoomIn: `<circle cx="10" cy="10" r="6.5"/><path d="M15 15l5.5 5.5M7 10h6M10 7v6" stroke-width="1.7"/>`,
  zoomOut: `<circle cx="10" cy="10" r="6.5"/><path d="M15 15l5.5 5.5M7 10h6" stroke-width="1.7"/>`,
  exportImg: `<path d="M5 2.5h9l4 4V21.5H5z" fill="#fff"/><path d="M7.5 18l3-3.5 2 2 1.5-1.5 2.5 3" stroke="${G}"/><path d="M17 13v8M14 18l3 3 3-3" stroke="${B}" stroke-width="1.6"/>`,
  trash: `<path d="M5 7h14M10 4h4M7 7l1 13h8l1-13" /><path d="M10 10v7M14 10v7" stroke="${R}"/>`,
  rename: `<rect x="3" y="7" width="18" height="10" rx="1" fill="#fff"/><path d="M7 10v4M15 5h4M17 5v14M15 19h4" stroke="${B}" stroke-width="1.6"/>`,
  duplicate: `<rect x="3" y="3" width="12" height="12" rx="1" fill="#fff"/><rect x="9" y="9" width="12" height="12" rx="1" fill="#fff"/><path d="M15 12v6M12 15h6" stroke="${G}" stroke-width="1.6"/>`,
  grid: `<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18" stroke="${GR}"/>`,
  ruler: `<rect x="2.5" y="8" width="19" height="8" rx="1" fill="#fff"/><path d="M6 8v3M9.5 8v4.5M13 8v3M16.5 8v4.5M20 8v3"/>`,
  data: `<ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v12c0 1.4 3 2.6 7 2.6s7-1.2 7-2.6V6"/><path d="M5 12c0 1.4 3 2.6 7 2.6s7-1.2 7-2.6" stroke="${B}"/>`,
  orientationP: `<path d="M7 2.5h7l3 3V21.5H7z" fill="#fff"/><path d="M14 2.5v3h3"/>`,
  orientationL: `<path d="M2.5 7h16l3 3v7.5H2.5z" fill="#fff"/><path d="M18.5 7v3h3"/>`,
};
export function vsIcon(name) {
  const body = I[name] ?? pubIcon(name).replace(/^<svg[^>]*>|<\/svg>$/g, "");
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}
