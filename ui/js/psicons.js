// Icone dell'editor di immagini, disegnate sull'idea grafica delle icone di Photoshop (stesse forme e stessa
// posizione nella barra strumenti, per ritrovarle subito). SVG in linea, viewBox 24x24, colore del testo.
const F = 'fill="currentColor" stroke="none"';
const I = {
  // barra strumenti
  move: `<path d="M8 3L8 17L11.2 13.8L13.6 19L15.8 18L13.4 12.9L18 12.9Z" ${F}/><path d="M17 4H21M19 2V6" stroke-width="1.4"/>`,
  marqueeRect: `<rect x="4" y="5" width="16" height="14" stroke-dasharray="2.6 2"/>`,
  marqueeEllipse: `<ellipse cx="12" cy="12" rx="8.5" ry="6.5" stroke-dasharray="2.6 2"/>`,
  lasso: `<path d="M8 15C3 13 3 6 11 5C19 4 22 10 16 13C13 14.5 10 14.5 8 15Z"/><path d="M8 15C7 17 8 19 10 19C11.5 19 11 21 9.5 21.5"/>`,
  lassoPoly: `<path d="M5 14L7 5L19 7L16 14Z"/><path d="M5 14L7 19L10 20"/>`,
  wand: `<path d="M4 20L14 10" stroke-width="2.4"/><path d="M17 3V7M15 5H19M20 9V11M19 10H21M13 3V4" stroke-width="1.3"/><path d="M16 8L18 6" stroke-width="1.3"/>`,
  crop: `<path d="M7 2V17H22"/><path d="M2 7H17V22"/>`,
  eyedropper: `<path d="M14 6L18 10L9 19L5 20L4 19L5 15Z"/><path d="M13 5L16 2.5C17 1.7 18.5 1.8 19.6 2.9L21 4.3C22.1 5.4 22.2 6.9 21.4 7.9L19 11" ${F}/>`,
  brush: `<path d="M20.5 3.5C18 5 13 10.5 11 13L12.8 14.8C15.4 12.8 20.6 7.6 21.6 4.6Z" ${F}/><path d="M10 14.2C7.5 14 5.8 15.5 5.5 17.6C5.3 19 4.5 19.8 3 20.2C6 21.4 10.4 21 11.7 17.6C12 16.6 11.4 15.2 10 14.2Z" ${F}/>`,
  pencil: `<path d="M4 20L5.2 15.4L16 4.6L19.4 8L8.6 18.8Z"/><path d="M14 6.6L17.4 10M4 20L7 19.2" />`,
  stamp: `<path d="M9 3H15V7C15 8.5 13.5 9 13.5 10.5V12H10.5V10.5C10.5 9 9 8.5 9 7Z" ${F}/><path d="M5 13H19V16H5Z" ${F}/><path d="M6 18H18" stroke-width="2"/>`,
  eraser: `<path d="M3.5 15.5L13 6L19.5 12.5L12 20H7.5Z"/><path d="M8.3 10.7L14.8 17.2"/><path d="M3.5 15.5L8.3 10.7L14.8 17.2L12 20H7.5Z" ${F} fill-opacity=".85"/><path d="M12 20H21" />`,
  gradient: `<defs><linearGradient id="psg" x1="0" x2="1"><stop offset="0" stop-color="currentColor"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><rect x="3" y="6" width="18" height="12" fill="url(#psg)" stroke="currentColor"/>`,
  bucket: `<path d="M4.5 11.5L11 5L18 12L11.5 18.5Z" /><path d="M4.5 11.5H18L11.5 18.5Z" ${F}/><path d="M9 7L6.5 4.5"/><path d="M19.5 14C19.5 14 21.5 16.5 21.5 17.8A2 2 0 0 1 17.5 17.8C17.5 16.5 19.5 14 19.5 14Z" ${F}/>`,
  type: `<path d="M5 4H19V7.5M5 4V7.5M12 4V20M9 20H15" stroke-width="2"/>`,
  shapeRect: `<rect x="4" y="6" width="16" height="12" ${F}/>`,
  shapeRound: `<rect x="4" y="6" width="16" height="12" rx="3.5" ${F}/>`,
  shapeEllipse: `<ellipse cx="12" cy="12" rx="8.5" ry="6.5" ${F}/>`,
  shapeLine: `<path d="M4 20L20 4" stroke-width="2"/>`,
  hand: `<path d="M8 12V5.5A1.5 1.5 0 0 1 11 5.5V11M11 10V3.8A1.5 1.5 0 0 1 14 3.8V11M14 10.5V5A1.5 1.5 0 0 1 17 5V12.5M17 9.5A1.5 1.5 0 0 1 20 9.5V15C20 19 17.5 21.5 13.5 21.5C10 21.5 8.5 20 6.5 17L3.8 12.6A1.4 1.4 0 0 1 6.2 11.2L8 13.5"/>`,
  zoom: `<circle cx="10" cy="10" r="6.5"/><path d="M15 15L21 21" stroke-width="2.6"/>`,
  // pannello Livelli
  eye: `<path d="M2 12S5.5 6 12 6S22 12 22 12S18.5 18 12 18S2 12 2 12Z"/><circle cx="12" cy="12" r="2.8" ${F}/>`,
  link: `<path d="M10 14L14 10"/><path d="M9.5 9.5L7.6 7.6A3 3 0 0 0 3.4 11.8L6.5 14.9A3 3 0 0 0 10.7 14.9"/><path d="M14.5 14.5L16.4 16.4A3 3 0 0 0 20.6 12.2L17.5 9.1A3 3 0 0 0 13.3 9.1"/>`,
  fx: `<text x="4" y="17" font-size="13" font-style="italic" font-weight="700" font-family="Georgia, serif" ${F}>fx</text>`,
  mask: `<rect x="3" y="5" width="18" height="14" rx="1"/><circle cx="12" cy="12" r="4.2" ${F}/>`,
  adjust: `<circle cx="12" cy="12" r="8"/><path d="M12 4A8 8 0 0 1 12 20Z" ${F}/>`,
  folder: `<path d="M3 6H9L11 8H21V19H3Z"/>`,
  newLayer: `<rect x="5" y="5" width="14" height="14" rx="1.5"/><path d="M12 9V15M9 12H15"/>`,
  trash: `<path d="M5 7H19M10 7V4.5H14V7M7 7L8 20H16L17 7"/><path d="M10.5 10.5V16.5M13.5 10.5V16.5"/>`,
  lock: `<rect x="6" y="11" width="12" height="9" rx="1"/><path d="M8.5 11V8A3.5 3.5 0 0 1 15.5 8V11"/>`,
  text: `<path d="M6 6H18M12 6V19" stroke-width="2.2"/>`,
  // pannello Regolazioni (stesse figure dei pulsanti di Photoshop)
  brightness: `<circle cx="12" cy="12" r="4.5"/><path d="M12 7.5A4.5 4.5 0 0 1 12 16.5Z" ${F}/><path d="M12 2V4.5M12 19.5V22M2 12H4.5M19.5 12H22M4.9 4.9L6.6 6.6M17.4 17.4L19.1 19.1M4.9 19.1L6.6 17.4M17.4 6.6L19.1 4.9"/>`,
  levels: `<path d="M3 20L5 14L7 16L9 9L11 12L13 6L15 11L17 13L19 15L21 20Z" ${F}/><path d="M3 21.5H21"/>`,
  curves: `<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 21C9 19 10 7 21 3"/>${'<circle cx="9.3" cy="14.5" r="1.6" fill="currentColor" stroke="none"/>'}`,
  exposure: `<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M21 3L3 21" /><path d="M6 8H11M8.5 5.5V10.5M13 17H18"/>`,
  vibrance: `<path d="M12 3L21 19H3Z"/><path d="M12 10V14M12 16.5V17"/>`,
  hueSat: `<path d="M3 17L12 4L21 17Z" fill="none"/><path d="M3 17L7.5 10.5L12 17Z" ${F}/><path d="M3 20H21" stroke-width="2.2"/>`,
  colorBalance: `<path d="M12 3V21M5 21H19"/><path d="M4 8H20"/><path d="M4 8L2 14H6Z M20 8L18 14H22Z" ${F}/>`,
  bw: `<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 4H12V20H3Z" ${F}/>`,
  photoFilter: `<circle cx="12" cy="12" r="8"/><path d="M8 7A6 6 0 0 1 16.5 7.6" />`,
  invert: `<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 20L21 4V20Z" ${F}/>`,
  posterize: `<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9H8V20H3Z" ${F} fill-opacity=".35"/><path d="M8 13H13V20H8Z" ${F} fill-opacity=".65"/><path d="M13 16H21V20H13Z" ${F}/>`,
  threshold: `<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 4H9L13 10L11 15L15 20H3Z" ${F}/>`,
  gradientMap: `<rect x="3" y="7" width="18" height="10" fill="url(#psg2)"/><defs><linearGradient id="psg2" x1="0" x2="1"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs><rect x="3" y="7" width="18" height="10" />`,
  // varie
  swap: `<path d="M7 6H15A3 3 0 0 1 18 9V16"/><path d="M15.5 13.5L18 16.5L20.5 13.5" /><path d="M8.5 3.5L5.5 6L8.5 8.5"/>`,
  defaultColors: `<rect x="3" y="3" width="10" height="10" ${F}/><rect x="9" y="9" width="10" height="10" fill="#fff"/>`,
  rotate: `<path d="M19 12A7 7 0 1 1 16.5 6.6"/><path d="M17 3V7H13"/>`,
  flipH: `<path d="M12 3V21" stroke-dasharray="2 2"/><path d="M9 7L3 17H9Z"/><path d="M15 7L21 17H15Z" ${F}/>`,
  flipV: `<path d="M3 12H21" stroke-dasharray="2 2"/><path d="M7 9L17 3V9Z"/><path d="M7 15L17 21V15Z" ${F}/>`,
  check: `<path d="M5 12.5L10 17.5L19.5 7" stroke-width="2.2"/>`,
  cancel: `<circle cx="12" cy="12" r="8"/><path d="M6.4 6.4L17.6 17.6" />`,
  selNew: `<rect x="5" y="5" width="14" height="14" ${F}/>`,
  selAdd: `<rect x="3" y="3" width="11" height="11" ${F}/><rect x="10" y="10" width="11" height="11" ${F}/>`,
  selSub: `<rect x="3" y="3" width="13" height="13" ${F}/><rect x="10" y="10" width="11" height="11" fill="var(--panel, #fff)" stroke="currentColor"/>`,
  selInt: `<rect x="3" y="3" width="13" height="13"/><rect x="8" y="8" width="13" height="13"/><rect x="8" y="8" width="8" height="8" ${F}/>`,
  more: `<path d="M8 10L12 14L16 10" stroke-width="2"/>`,
};

export function psIcon(name, size = 18) {
  const span = document.createElement("span");
  span.className = "ps-ico";
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[name] || ""}</svg>`;
  return span;
}
