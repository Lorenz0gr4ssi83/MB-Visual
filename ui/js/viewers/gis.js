// Visualizzatore GIS: shapefile (anche in zip), GeoJSON/TopoJSON, KML/KMZ, GPX, GeoPackage, GeoTIFF.
// Mappa OpenLayers (BSD-2) in EPSG:3857 con sfondo cartografico opzionale, riproiezione con proj4js (MIT) dei sistemi
// italiani (giscrs.js), livelli con stile, tabella attributi collegata alla mappa, misure, coordinate del cursore,
// esportazione in GeoJSON / KML / KMZ / GPX / shapefile zip e della vista in PNG / JPG / PDF.
import { api, baseName, button, dirName, el, extOf, loadCss, loadScript, loading, modal, pickFiles, readBytes, saveBytes, toast, WEB } from "../core.js";
import * as io from "../gisio.js";
import { CRS, codeFromPrj, crsChoices, crsName, registerAll, useCrs, wktFor } from "../giscrs.js";

const VIEW = "EPSG:3857";
const OL_JS = "/vendor/ol/dist/ol.js";
const VECTOR_EXT = new Set(["shp", "geojson", "topojson", "kml", "kmz", "gpx", "gpkg", "zip"]);
const RASTER_EXT = new Set(["tif", "tiff", "gtiff", "geotiff"]);
export const GIS_EXT = new Set([...VECTOR_EXT, ...RASTER_EXT]);
const PALETTE = ["#2c6797", "#c0392b", "#2d7a46", "#946400", "#6b4fa0", "#0e7c86", "#b03a74", "#5b6470", "#d35400", "#1f8a70",
  "#8e44ad", "#7f8c8d", "#e67e22", "#16a085", "#c2185b", "#3949ab", "#689f38", "#795548", "#00838f", "#ad1457"];
let olReady = null;

async function libs() {
  if (!olReady) olReady = (async () => {
    // ol.js dichiara "var ol": si esegue in un ambito senza define (Monaco) e si riporta su window
    const r = await fetch(OL_JS);
    if (!r.ok) throw new Error("Libreria OpenLayers mancante (tools/fetch_vendor.py ol)");
    const code = await r.text();
    new Function("define", "module", "exports", code + "\n;window.ol=ol;\n//# sourceURL=ol.js").call(window);
    await Promise.all([loadScript("/vendor/proj4/dist/proj4.js"), loadScript("/vendor/geotiff/dist-browser/geotiff.js"), loadScript("/vendor/jszip/dist/jszip.min.js")]);
    registerAll(window.ol, window.proj4);
  })();
  olReady.catch(() => { olReady = null; });
  loadCss("/vendor/ol/ol.css");
  loadCss("css/gis.css");
  return olReady;
}

// ---------------------------------------------------------------- sfondi cartografici
// Condizioni d'uso: OSM = solo consultazione interattiva con attribuzione visibile (policy dei tile server OSMF);
// le ortofoto commerciali richiedono la chiave del fornitore. Nessuna ortofoto "libera" e' inclusa: quelle del
// Geoportale Nazionale hanno limiti d'uso; per le ortofoto regionali con licenza aperta si usa il WMS personalizzato.
const BASES = [
  { id: "osm", name: "OpenStreetMap", max: 19, tpl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attr: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">Collaboratori di OpenStreetMap</a>' },
  { id: "esri", name: "Ortofoto Esri World Imagery (chiave)", key: true, max: 19, jpg: true,
    tpl: "https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token={key}",
    attr: "Powered by Esri · Fonti: Esri, Maxar, Earthstar Geographics e la comunita' degli utenti GIS",
    help: "Chiave API di ArcGIS Location Platform (developers.arcgis.com), con il servizio basemap abilitato." },
  { id: "maptiler", name: "Ortofoto MapTiler Satellite (chiave)", key: true, max: 20, jpg: true,
    tpl: "https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key={key}",
    attr: '© <a href="https://www.maptiler.com/copyright/" target="_blank">MapTiler</a> · © Collaboratori di OpenStreetMap',
    help: "Chiave di cloud.maptiler.com. Il piano gratuito di MapTiler non consente l'uso commerciale." },
  { id: "xyz", name: "Servizio a tessere personalizzato (XYZ)", custom: true, max: 20 },
  { id: "wms", name: "Servizio WMS personalizzato (es. ortofoto regionali)", custom: true, max: 21 },
  { id: "none", name: "Nessuno sfondo" },
];
const SETTINGS_KEY = "mbv-gis-sfondo";
function loadSettings() {
  try { return { id: "osm", keys: {}, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; } catch { return { id: "osm", keys: {} }; }
}
function saveSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* */ } }
const escHtml = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function baseSource(ol, s) {
  const b = BASES.find(x => x.id === s.id) || BASES[0];
  if (b.id === "none") return null;
  const key = (s.keys || {})[b.id] || "";
  if (b.key && !key) return { error: `Per "${b.name}" serve la chiave del fornitore: impostala con il pulsante accanto allo sfondo.` };
  if (b.id === "wms") {
    const c = s.wms || {};
    if (!c.url || !c.layers) return { error: "Indica indirizzo e livello del servizio WMS nelle impostazioni dello sfondo." };
    return new ol.source.TileWMS({
      url: WEB ? c.url : "/api/gis_tile?p=wms&base=" + encodeURIComponent(c.url),
      params: { LAYERS: c.layers, TILED: true, FORMAT: c.format || "image/png", VERSION: c.version || "1.3.0", STYLES: "" },
      crossOrigin: "anonymous", attributions: escHtml(c.attr || "Servizio WMS"), transition: 0,
    });
  }
  let tpl = b.tpl, attr = b.attr;
  if (b.id === "xyz") {
    const c = s.xyz || {};
    if (!c.url) return { error: "Indica l'indirizzo del servizio a tessere nelle impostazioni dello sfondo." };
    tpl = c.url; attr = escHtml(c.attr || "Servizio personalizzato");
  }
  const url = WEB ? tpl.replace("{key}", encodeURIComponent(key))
    : `/api/gis_tile?p=${b.id === "xyz" ? "xyz&tpl=" + encodeURIComponent(tpl) : b.id}&z={z}&x={x}&y={y}` + (key ? "&key=" + encodeURIComponent(key) : "");
  return new ol.source.XYZ({ url, maxZoom: b.max, crossOrigin: "anonymous", attributions: attr, attributionsCollapsible: false });
}

async function baseSettingsDialog(s) {
  const sel = el("select", { class: "field" }, BASES.map(b => el("option", { value: b.id, selected: b.id === s.id ? "" : null }, b.name)));
  const keyIn = el("input", { type: "password", class: "field", placeholder: "chiave del fornitore", autocomplete: "off" });
  const help = el("p", { class: "note" });
  const xyzUrl = el("input", { type: "text", class: "field", placeholder: "https://server/{z}/{x}/{y}.png", value: s.xyz?.url || "" });
  const xyzAttr = el("input", { type: "text", class: "field", placeholder: "Attribuzione richiesta dal fornitore", value: s.xyz?.attr || "" });
  const wmsUrl = el("input", { type: "text", class: "field", placeholder: "https://server/wms?", value: s.wms?.url || "" });
  const wmsLayers = el("input", { type: "text", class: "field", placeholder: "nome del livello (LAYERS)", value: s.wms?.layers || "" });
  const wmsFmt = el("select", { class: "field" }, ["image/png", "image/jpeg"].map(f => el("option", { value: f, selected: (s.wms?.format || "image/png") === f ? "" : null }, f)));
  const wmsAttr = el("input", { type: "text", class: "field", placeholder: "Attribuzione / licenza (es. Regione ... - CC BY 4.0)", value: s.wms?.attr || "" });
  const rowKey = el("label", { class: "gis-form" }, "Chiave", keyIn);
  const boxXyz = el("div", { class: "gis-form-grid" }, el("label", {}, "Indirizzo", xyzUrl), el("label", {}, "Attribuzione", xyzAttr));
  const boxWms = el("div", { class: "gis-form-grid" }, el("label", {}, "Indirizzo", wmsUrl), el("label", {}, "Livello", wmsLayers), el("label", {}, "Formato", wmsFmt), el("label", {}, "Attribuzione", wmsAttr));
  const keys = { ...(s.keys || {}) };
  let cur = s.id;
  const upd = () => {
    keys[cur] = keyIn.value.trim() || keys[cur] || "";
    cur = sel.value;
    const b = BASES.find(x => x.id === cur);
    rowKey.hidden = !b.key; keyIn.value = keys[cur] || "";
    boxXyz.hidden = cur !== "xyz"; boxWms.hidden = cur !== "wms";
    help.textContent = b.help || (cur === "osm" ? "Solo consultazione interattiva, con attribuzione sempre visibile (policy dei server di tessere di OpenStreetMap); nessuno scaricamento massivo."
      : cur === "none" ? "La mappa mostra solo i livelli aperti: nessuna connessione a Internet." : b.custom ? "Usa solo servizi di cui hai verificato le condizioni d'uso e scrivi l'attribuzione richiesta. Le ortofoto del Geoportale Nazionale hanno limiti d'uso; molte Regioni pubblicano ortofoto WMS con licenza aperta." : "");
  };
  sel.addEventListener("change", upd);
  upd();
  const ok = await modal("Sfondo cartografico", el("div", { class: "gis-dialog" }, el("label", { class: "gis-form" }, "Sfondo", sel), rowKey, boxXyz, boxWms, help,
    el("p", { class: "note" }, "Le chiavi restano solo su questo PC. Le tessere vengono chieste solo per la zona che stai guardando e tenute in cache per 7 giorni.")),
  [{ label: "Annulla", value: false }, { label: "Applica", value: true, primary: true }]);
  if (!ok) return null;
  keys[sel.value] = keyIn.value.trim();
  return { id: sel.value, keys, xyz: { url: xyzUrl.value.trim(), attr: xyzAttr.value.trim() },
    wms: { url: wmsUrl.value.trim(), layers: wmsLayers.value.trim(), format: wmsFmt.value, attr: wmsAttr.value.trim() } };
}

// ---------------------------------------------------------------- formattazione
const nf = (v, d = 2, min = d) => v.toLocaleString("it-IT", { minimumFractionDigits: min, maximumFractionDigits: d });
const fmtLen = m => (m < 1000 ? nf(m, 2, 0) + " m" : nf(m / 1000, 3, 0) + " km");
const fmtArea = a => (a < 10000 ? nf(a) + " m²" : a < 1e6 ? nf(a / 10000, 4) + " ha" : nf(a / 1e6, 4) + " km²");
function dms(v, pos, neg) {
  const s = v < 0 ? neg : pos; v = Math.abs(v);
  const d = Math.floor(v), m = Math.floor((v - d) * 60), sec = (v - d - m / 60) * 3600;
  return `${d}°${String(m).padStart(2, "0")}'${nf(sec, 2).padStart(5, "0")}" ${s}`;
}
function fmtCoord(c, code, mode) {
  if (CRS.get(+String(code).split(":")[1])?.geographic) {
    if (mode === "gms") return `${dms(c[1], "N", "S")}  ${dms(c[0], "E", "O")}`;
    return `Lat ${nf(c[1], 6)}°  Lon ${nf(c[0], 6)}°`;
  }
  return `E ${nf(c[0], 2)}  N ${nf(c[1], 2)}`;
}
const hexToRgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

// ---------------------------------------------------------------- visualizzatore
export async function mount(ctx) {
  const prog = loading(ctx.el, "Apertura dei dati geografici");
  await libs();
  const ol = window.ol, proj4 = window.proj4;
  ctx.el.innerHTML = "";
  ctx.fillBody(true);

  let settings = loadSettings();
  const layers = [];          // livelli dell'utente, dal basso verso l'alto
  let active = null;          // livello mostrato nella tabella
  const sel = new Set();      // elementi selezionati (di qualunque livello)
  let tool = "select";
  let dispCode = "EPSG:4326", dispMode = "dec";
  let uid = 0;

  // ---------- struttura
  const mapEl = el("div", { class: "gis-map" });
  const coordEl = el("div", { class: "gis-coord" }, "—");
  const msgEl = el("div", { class: "gis-msg", hidden: true });
  const popup = el("div", { class: "gis-popup", hidden: true });
  const layerList = el("div", { class: "gis-layers" });
  const tableWrap = el("div", { class: "gis-table", hidden: true });
  const splitter = el("div", { class: "gis-split", hidden: true });
  const mapBox = el("div", { class: "gis-mapbox" }, mapEl, coordEl, msgEl);
  const right = el("div", { class: "gis-right" }, mapBox, splitter, tableWrap);
  const left = el("div", { class: "gis-left" }, el("div", { class: "gis-left-head" }, el("span", { class: "label" }, "Livelli"),
    button("", "plus", () => addFromPicker(), { iconOnly: true, title: "Aggiungi livelli (anche trascinando i file sulla mappa)" })), layerList);
  ctx.el.append(el("div", { class: "gis" }, left, right));

  // ---------- mappa
  const baseLayer = new ol.layer.Tile({ zIndex: 0, preload: 0 })  // zIndex negativo: OpenLayers non lo disegna;
  const measureSrc = new ol.source.Vector();
  const measureLayer = new ol.layer.Vector({ source: measureSrc, zIndex: 1000, style: new ol.style.Style({
    stroke: new ol.style.Stroke({ color: "#e4572e", width: 2.5, lineDash: [8, 5] }), fill: new ol.style.Fill({ color: "rgba(228,87,46,.15)" }),
    image: new ol.style.Circle({ radius: 4, fill: new ol.style.Fill({ color: "#e4572e" }) }) }) });
  const view = new ol.View({ center: ol.proj.fromLonLat([12.5, 42.2]), zoom: 6, maxZoom: 24, constrainResolution: false });
  const scale = new ol.control.ScaleLine({ units: "metric", bar: true, steps: 4, text: true, minWidth: 120 });
  const map = new ol.Map({
    target: mapEl, view, layers: [baseLayer, measureLayer],
    controls: ol.control.defaults.defaults({ attributionOptions: { collapsible: false } }).extend([scale]),
    interactions: ol.interaction.defaults.defaults({ doubleClickZoom: true }),
  });
  const popupOv = new ol.Overlay({ element: popup, positioning: "bottom-left", offset: [8, -8], autoPan: { animation: { duration: 150 } } });
  map.addOverlay(popupOv);
  const ro = new ResizeObserver(() => map.updateSize());
  ro.observe(mapEl);

  function message(text, bad = false) { msgEl.hidden = !text; msgEl.textContent = text || ""; msgEl.classList.toggle("bad", bad); }
  function applyBase() {
    const s = baseSource(ol, settings);
    baseLayer.setSource(s && !s.error ? s : null);
    message(s?.error || "", true);
    baseSel.value = settings.id;
  }

  // ---------- barra strumenti
  const baseSel = el("select", { title: "Sfondo cartografico" }, BASES.map(b => el("option", { value: b.id }, b.name)));
  baseSel.addEventListener("change", () => { settings = { ...settings, id: baseSel.value }; saveSettings(settings); applyBase(); });
  const tools = {};
  const toolBtn = (id, label, icon, title) => (tools[id] = button(label, icon, () => setTool(id), { title }));
  const dispSel = el("select", { title: "Sistema delle coordinate del cursore" },
    el("option", { value: "EPSG:4326|dec" }, "WGS84 gradi decimali"), el("option", { value: "EPSG:4326|gms" }, "WGS84 gradi, primi, secondi"),
    crsChoices().filter(c => c.code !== 4326).map(c => el("option", { value: "EPSG:" + c.code + "|dec" }, `${c.name} (EPSG:${c.code})`)));
  dispSel.addEventListener("change", () => { [dispCode, dispMode] = dispSel.value.split("|"); });
  const tableBtn = button("Tabella attributi", "table", () => showTable(tableWrap.hidden), { title: "Mostra o nasconde la tabella degli attributi del livello attivo" });
  ctx.tb.append(
    button("Aggiungi livello", "plus", () => addFromPicker()),
    el("span", { class: "sep" }),
    el("label", {}, "Sfondo", baseSel),
    button("", '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
      async () => { const s = await baseSettingsDialog(settings); if (s) { settings = s; saveSettings(s); applyBase(); } }, { iconOnly: true, title: "Impostazioni dello sfondo (chiavi, servizi personalizzati)" }),
    el("span", { class: "sep" }),
    button("", "fit", () => fitAll(), { iconOnly: true, title: "Adatta la vista a tutti i livelli" }),
    toolBtn("select", "Seleziona", '<svg viewBox="0 0 24 24"><path d="M5 3l14 8-6 2-2 6z"/></svg>', "Clic = seleziona (Ctrl aggiunge o toglie) · Ctrl+trascina = selezione a riquadro"),
    toolBtn("length", "Distanza", "ruler", "Misura una distanza: clic sui vertici, doppio clic per finire"),
    toolBtn("area", "Area", '<svg viewBox="0 0 24 24"><path d="M4 18L8 5l11 3-2 11z"/></svg>', "Misura un'area: clic sui vertici, doppio clic per chiudere"),
    button("", "trash", () => clearMeasures(), { iconOnly: true, title: "Cancella le misure" }),
    el("span", { class: "sep" }),
    tableBtn,
    el("span", { class: "sep" }),
    el("label", {}, "Coordinate", dispSel),
    el("span", { class: "grow" }),
    button("PNG", "camera", () => exportView("png"), { title: "Salva la vista come immagine PNG" }),
    button("PDF", "download", () => exportView("pdf"), { title: "Salva la vista come PDF" }),
  );
  applyBase();

  // ---------- strumenti di misura
  let draw = null, sketchTip = null;
  const tips = [];
  function setTool(id) {
    tool = id;
    Object.entries(tools).forEach(([k, b]) => b.classList.toggle("on", k === id));
    if (draw) { map.removeInteraction(draw); draw = null; }
    if (id === "length" || id === "area") {
      draw = new ol.interaction.Draw({ source: measureSrc, type: id === "length" ? "LineString" : "Polygon", stopClick: true,
        style: new ol.style.Style({ stroke: new ol.style.Stroke({ color: "#e4572e", width: 2, lineDash: [6, 4] }), fill: new ol.style.Fill({ color: "rgba(228,87,46,.12)" }),
          image: new ol.style.Circle({ radius: 4, stroke: new ol.style.Stroke({ color: "#e4572e", width: 2 }), fill: new ol.style.Fill({ color: "#fff" }) }) }) });
      draw.on("drawstart", e => {
        const tipEl = el("div", { class: "gis-tip" });
        sketchTip = new ol.Overlay({ element: tipEl, offset: [10, 0], positioning: "center-left" });
        map.addOverlay(sketchTip);
        e.feature.getGeometry().on("change", ev => { const g = ev.target; tipEl.innerHTML = measureText(g); sketchTip.setPosition(g.getType() === "Polygon" ? g.getInteriorPoint().getCoordinates() : g.getLastCoordinate()); });
      });
      draw.on("drawend", () => { if (sketchTip) { sketchTip.getElement().classList.add("done"); tips.push(sketchTip); sketchTip = null; } });
      map.addInteraction(draw);
    }
    popup.hidden = true;
  }
  function measureText(g) {
    const planarCode = CRS.get(+dispCode.split(":")[1])?.geographic ? null : dispCode;
    if (g.getType() === "Polygon") {
      const a = ol.sphere.getArea(g, { projection: VIEW });
      const ring = new ol.geom.LineString(g.getCoordinates()[0]);
      let s = `<b>${fmtArea(a)}</b><br>perimetro ${fmtLen(ol.sphere.getLength(ring, { projection: VIEW }))}`;
      if (planarCode) s += `<br><span>piana ${planarCode}: ${fmtArea(g.clone().transform(VIEW, planarCode).getArea())}</span>`;
      return s;
    }
    let s = `<b>${fmtLen(ol.sphere.getLength(g, { projection: VIEW }))}</b>`;
    if (planarCode) s += `<br><span>piana ${planarCode}: ${fmtLen(g.clone().transform(VIEW, planarCode).getLength())}</span>`;
    return s;
  }
  function clearMeasures() { measureSrc.clear(); tips.forEach(t => map.removeOverlay(t)); tips.length = 0; if (draw) draw.abortDrawing(); }
  setTool("select");

  // ---------- stili
  const selStyleCache = {};
  function styleOf(L, color, f) {
    const s = L.style, key = color + "|" + (s.label ? f.get(s.label) ?? "" : "");
    let st = L.cache.get(key);
    if (st) return st;
    const stroke = new ol.style.Stroke({ color, width: s.width });
    const fill = new ol.style.Fill({ color: hexToRgba(s.fill === "auto" ? color : s.fill, s.fillOpacity) });
    const txt = s.label ? String(f.get(s.label) ?? "") : "";
    st = new ol.style.Style({
      stroke, fill,
      image: new ol.style.Circle({ radius: s.radius, fill: new ol.style.Fill({ color }), stroke: new ol.style.Stroke({ color: "#fff", width: 1.2 }), declutterMode: "none" }),
      text: txt ? new ol.style.Text({ text: txt, font: "12px 'Segoe UI', sans-serif", fill: new ol.style.Fill({ color: "#1b1e1c" }),
        stroke: new ol.style.Stroke({ color: "rgba(255,255,255,.9)", width: 3 }), offsetY: -s.radius - 8, overflow: false }) : undefined,
    });
    if (L.cache.size > 5000) L.cache.clear();
    L.cache.set(key, st);
    return st;
  }
  function selStyle(geomType) {
    return selStyleCache[geomType] ||= new ol.style.Style({
      stroke: new ol.style.Stroke({ color: "#ffcc00", width: 4 }), fill: new ol.style.Fill({ color: "rgba(255,204,0,.35)" }),
      image: new ol.style.Circle({ radius: 8, fill: new ol.style.Fill({ color: "#ffcc00" }), stroke: new ol.style.Stroke({ color: "#1b1e1c", width: 1.5 }), declutterMode: "none" }),
      zIndex: 10,
    });
  }
  function plainStyle(L, f, res) {
    if (L.style.fileStyles && f.__fs) return f.__fs(f, res);
    let color = L.style.color;
    if (L.style.byField) color = L.cats.get(String(f.get(L.style.byField) ?? "")) || "#9aa0a6";
    return styleOf(L, color, f);
  }
  function styleFn(L) {
    return (f, res) => (sel.has(f) ? [].concat(plainStyle(L, f, res) || [], selStyle()) : plainStyle(L, f, res));
  }
  function restyle(L) {
    L.cache.clear();
    if (L.style.byField) {
      const vals = [...new Set(L.features.map(f => String(f.get(L.style.byField) ?? "")))].sort((a, b) => a.localeCompare(b, "it", { numeric: true }));
      L.cats = new Map(vals.slice(0, 200).map((v, i) => [v, PALETTE[i % PALETTE.length]]));
    }
    L.ol.changed();
  }

  // ---------- livelli
  function guessCrs(L) {
    const ext = ol.extent.createEmpty();
    L.features.slice(0, 2000).forEach(f => { const g = f.getGeometry(); if (g) ol.extent.extend(ext, g.getExtent()); });
    if (ol.extent.isEmpty(ext)) return 4326;
    const [x0, y0, x1, y1] = ext;
    if (x0 >= -180 && x1 <= 360 && y0 >= -90 && y1 <= 90) return 4326;
    if (x0 > 1.1e6 && x1 < 2.0e6 && y0 > 3.9e6 && y1 < 5.4e6) return 3003;
    if (x0 > 2.1e6 && x1 < 3.0e6 && y0 > 3.9e6 && y1 < 5.4e6) return 3004;
    if (x0 > -1e5 && x1 < 1.2e6 && y0 > 3.9e6 && y1 < 5.4e6) return 7791; // UTM: fuso 32 (il piu' frequente); se serve si cambia nelle proprieta' del livello
    if (Math.abs(x0) < 2.1e7 && Math.abs(y0) < 2.1e7) return 3857;
    return null;
  }

  function addLayer(L) {
    L.id = ++uid;
    L.visible = true;
    L.opacity = 1;
    L.cache = new Map();
    L.cats = new Map();
    let code = useCrs(ol, proj4, L.crs);
    L.guessed = false;
    if (!code && L.kind === "vector") { const g = guessCrs(L); code = g ? "EPSG:" + g : null; L.guessed = true; }
    if (!code && L.kind === "raster") { const [x0, y0, x1, y1] = L.extent; if (x0 >= -180 && x1 <= 360 && y0 >= -90 && y1 <= 90) code = "EPSG:4326"; L.guessed = true; }
    L.code = code || "EPSG:4326";
    if (!code) L.note = [L.note, "sistema di riferimento sconosciuto: sceglilo nelle proprieta' del livello"].filter(Boolean).join(" · ");
    if (L.kind === "vector") {
      L.features.forEach((f, i) => {
        f.__L = L; f.__i = i;
        if (L.fileStyles) { const st = f.getStyleFunction?.(); if (st) f.__fs = st; f.setStyle(null); }
      });
      L.src = L.features.map(f => f.getGeometry()?.clone() || null);
      L.fields ||= [...new Set(L.features.slice(0, 5000).flatMap(f => Object.keys(io.props(f))))];
      const color = PALETTE[(layers.length) % PALETTE.length];
      const kinds = new Set(L.features.slice(0, 500).map(f => f.getGeometry()?.getType()));
      const pointsOnly = [...kinds].every(t => /Point/.test(t || "Point"));
      L.style = { color, fill: "auto", fillOpacity: 0.25, width: pointsOnly ? 1 : 1.6, radius: 5, label: "", byField: "", fileStyles: !!L.fileStyles };
      L.source = new ol.source.Vector({ features: L.features, wrapX: false });
      L.ol = new ol.layer.Vector({ source: L.source, style: styleFn(L), declutter: true, updateWhileInteracting: false });
      reproject(L);
    } else {
      L.ol = new ol.layer.Image({});
      setRasterSource(L);
    }
    layers.push(L);
    map.getLayers().insertAt(map.getLayers().getLength() - 1, L.ol); // sotto il livello delle misure
    reorder();
    if (L.kind === "vector" && (!active || !active.features?.length)) setActive(L);
    renderLayers();
    updateStatus();
    return L;
  }

  function reproject(L) {
    L.features.forEach((f, i) => { const g = L.src[i]; f.setGeometry(g ? g.clone().transform(L.code, VIEW) : undefined); });
    L.cache.clear();
  }
  function setRasterSource(L) {
    if (L.band) L.canvas = io.paintBand(L);
    L.ol.setSource(new ol.source.ImageStatic({ url: L.canvas.toDataURL("image/png"), imageExtent: L.extent, projection: L.code, interpolate: !L.band }));
  }
  function reorder() { layers.forEach((L, i) => L.ol.setZIndex(i + 1)); }
  function layerExtent(L) {
    if (L.kind === "raster") return ol.proj.transformExtent(L.extent, L.code, VIEW);
    return L.source.getFeatures().length ? L.source.getExtent() : null;
  }
  function fitExtent(ext, maxZoom = 18) {
    if (!ext || !ext.every(Number.isFinite) || ol.extent.isEmpty(ext)) return;
    view.fit(ol.extent.buffer(ext, Math.max(ol.extent.getWidth(ext), ol.extent.getHeight(ext)) * 0.04 || 50), { padding: [20, 20, 20, 20], maxZoom, duration: 200 });
  }
  function fitAll() {
    const ext = ol.extent.createEmpty();
    layers.filter(L => L.visible).forEach(L => { const e = layerExtent(L); if (e) ol.extent.extend(ext, e); });
    fitExtent(ext);
  }
  function removeLayer(L) {
    map.removeLayer(L.ol);
    layers.splice(layers.indexOf(L), 1);
    L.features?.forEach(f => sel.delete(f));
    L.dispose?.();
    if (active === L) setActive(layers.filter(x => x.kind === "vector").pop() || null);
    reorder(); renderLayers(); updateStatus();
  }

  function swatch(L) {
    if (L.kind === "raster") return el("span", { class: "gis-sw raster" });
    const s = L.style;
    return el("span", { class: "gis-sw", style: { borderColor: s.color, background: s.byField ? `conic-gradient(${PALETTE.slice(0, 6).join(",")})` : hexToRgba(s.fill === "auto" ? s.color : s.fill, Math.max(0.35, s.fillOpacity)) } });
  }
  const openStyle = new Set();
  function renderLayers() {
    layerList.innerHTML = "";
    if (!layers.length) layerList.append(el("p", { class: "note gis-empty" }, "Nessun livello. Trascina qui shapefile, GeoJSON, KML/KMZ, GPX, GeoPackage o GeoTIFF."));
    [...layers].reverse().forEach(L => {
      const vis = el("input", { type: "checkbox", title: "Visibile" });
      vis.checked = L.visible;
      vis.addEventListener("change", () => { L.visible = vis.checked; L.ol.setVisible(L.visible); });
      const idx = layers.indexOf(L);
      const count = L.kind === "vector" ? `${L.features.length.toLocaleString("it-IT")} elementi` : `${L.srcWidth}×${L.srcHeight} px · ${L.bands} band${L.bands > 1 ? "e" : "a"}`;
      const card = el("div", { class: "gis-layer" + (L === active ? " active" : "") },
        el("div", { class: "gis-layer-row" }, vis, swatch(L),
          el("span", { class: "gis-layer-name", title: L.name, onclick: () => { if (L.kind === "vector") setActive(L); } }, L.name),
          button("", "search", () => fitExtent(layerExtent(L)), { iconOnly: true, title: "Zoom sul livello" }),
          button("", '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h6"/><circle cx="18" cy="16" r="3"/></svg>', () => { openStyle.has(L) ? openStyle.delete(L) : openStyle.add(L); renderLayers(); }, { iconOnly: true, title: "Stile e proprieta' del livello", class: openStyle.has(L) ? "on" : "" })),
        el("div", { class: "gis-layer-sub" }, el("span", { class: L.guessed ? "warn" : "" }, (L.guessed ? "ipotizzato: " : "") + crsName(L.code)), " · ", count),
        L.note ? el("div", { class: "gis-layer-sub note" }, L.note) : null,
        openStyle.has(L) ? styleEditor(L, idx) : null);
      layerList.append(card);
    });
  }

  function crsSelect(L) {
    const s = el("select", { class: "field" }, crsChoices().map(c => el("option", { value: "EPSG:" + c.code }, `${c.name} · ${c.code}`)), el("option", { value: "?" }, "Altro: codice EPSG o WKT/proj4..."));
    if (![...s.options].some(o => o.value === L.code)) s.prepend(el("option", { value: L.code }, crsName(L.code)));
    s.value = L.code;
    s.addEventListener("change", async () => {
      let code = s.value;
      if (code === "?") {
        const ta = el("textarea", { class: "field", rows: 5, style: { width: "100%", fontFamily: "var(--mono)" }, placeholder: "Es. 3003, EPSG:6707, il contenuto di un file .prj o una stringa +proj=..." });
        const v = await modal("Sistema di riferimento", el("div", { style: { display: "grid", gap: "6px", minWidth: "420px" } }, ta,
          el("p", { class: "note" }, "I codici non in elenco si definiscono incollando il WKT (.prj) o la stringa proj4 (da epsg.io).")), [{ label: "Annulla", value: null }, { label: "Applica", primary: true, value: () => ta.value.trim() }]);
        if (!v) { s.value = L.code; return; }
        const known = /^\d+$/.test(v) || /^epsg:\d+$/i.test(v) ? null : codeFromPrj(v);
        code = useCrs(ol, proj4, known || v);
        if (!code) { toast("Sistema non riconosciuto: incolla il WKT o la stringa proj4", true, 5000); s.value = L.code; return; }
      }
      L.code = code; L.guessed = false;
      L.note = (L.note || "").replace(/ ?·? ?sistema di riferimento sconosciuto[^·]*/, "");
      if (L.kind === "vector") reproject(L); else setRasterSource(L);
      renderLayers();
      fitExtent(layerExtent(L));
    });
    return s;
  }

  function styleEditor(L, idx) {
    const row = (label, ...c) => el("label", { class: "gis-prop" }, el("span", {}, label), ...c);
    const box = el("div", { class: "gis-style" });
    const op = el("input", { type: "range", min: 0, max: 1, step: 0.05, value: L.opacity });
    op.addEventListener("input", () => { L.opacity = +op.value; L.ol.setOpacity(L.opacity); });
    box.append(row("Sistema", crsSelect(L)), row("Opacita'", op));
    if (L.kind === "vector") {
      const s = L.style;
      const inp = (type, key, attrs = {}) => {
        const i = el("input", { type, value: s[key], ...attrs });
        i.addEventListener(type === "color" ? "input" : "change", () => { s[key] = type === "number" || type === "range" ? +i.value : i.value; restyle(L); if (type === "color") renderLayersSoon(); });
        return i;
      };
      const fillC = el("input", { type: "color", value: s.fill === "auto" ? s.color : s.fill });
      fillC.addEventListener("input", () => { s.fill = fillC.value; restyle(L); renderLayersSoon(); });
      const fieldSel = (key, none) => {
        const x = el("select", { class: "field" }, el("option", { value: "" }, none), (L.fields || []).map(f => el("option", { value: f }, f)));
        x.value = s[key];
        x.addEventListener("change", () => { s[key] = x.value; restyle(L); renderLayers(); });
        return x;
      };
      if (L.fileStyles) {
        const fs = el("input", { type: "checkbox" }); fs.checked = s.fileStyles;
        fs.addEventListener("change", () => { s.fileStyles = fs.checked; restyle(L); renderLayers(); });
        box.append(row("Stili del file", fs));
      }
      if (!s.fileStyles) {
        box.append(row("Linea", inp("color", "color"), inp("number", "width", { min: 0, max: 20, step: 0.5, class: "num" })),
          row("Riempimento", fillC, inp("range", "fillOpacity", { min: 0, max: 1, step: 0.05 })),
          row("Punti", inp("number", "radius", { min: 1, max: 30, step: 1, class: "num" })),
          row("Colora per", fieldSel("byField", "(un colore)")));
        if (s.byField) {
          const leg = el("div", { class: "gis-legend" });
          [...L.cats.entries()].slice(0, 40).forEach(([v, c]) => leg.append(el("div", {}, el("span", { class: "gis-sw", style: { background: c, borderColor: c } }), v || "(vuoto)")));
          if (L.cats.size > 40) leg.append(el("div", { class: "note" }, `... altre ${L.cats.size - 40} categorie`));
          box.append(leg);
        }
      }
      box.append(row("Etichette", fieldSel("label", "(nessuna)")));
    } else if (L.band) {
      const cm = el("select", { class: "field" }, Object.keys(io.COLORMAPS).map(k => el("option", { value: k }, k)));
      cm.value = L.colormap;
      const mn = el("input", { type: "number", class: "num", value: +L.min.toPrecision(6), step: "any" });
      const mx = el("input", { type: "number", class: "num", value: +L.max.toPrecision(6), step: "any" });
      const apply = () => { L.colormap = cm.value; L.min = +mn.value; L.max = +mx.value; setRasterSource(L); };
      [cm, mn, mx].forEach(x => x.addEventListener("change", apply));
      box.append(row("Colori", cm), row("Intervallo", mn, mx),
        el("div", { class: "gis-prop-btns" },
          el("button", { class: "btn", onclick: () => { mn.value = +L.stat.p2.toPrecision(6); mx.value = +L.stat.p98.toPrecision(6); apply(); } }, "2-98%"),
          el("button", { class: "btn", onclick: () => { mn.value = +L.stat.min.toPrecision(6); mx.value = +L.stat.max.toPrecision(6); apply(); } }, "Min-max")),
        el("div", { class: "note" }, `Valori: ${nf(L.stat.min, 2)} ÷ ${nf(L.stat.max, 2)}${L.nodata !== null ? ` · nessun dato = ${L.nodata}` : ""}`));
    }
    box.append(el("div", { class: "gis-prop-btns" },
      button("", '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>', () => { if (idx < layers.length - 1) { layers.splice(idx, 1); layers.splice(idx + 1, 0, L); reorder(); renderLayers(); } }, { iconOnly: true, title: "Porta sopra" }),
      button("", '<svg viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6"/></svg>', () => { if (idx > 0) { layers.splice(idx, 1); layers.splice(idx - 1, 0, L); reorder(); renderLayers(); } }, { iconOnly: true, title: "Porta sotto" }),
      el("span", { class: "grow" }),
      button("Rimuovi", "trash", () => removeLayer(L), { title: "Toglie il livello dalla mappa (il file non cambia)" })));
    return box;
  }
  let rlTimer = 0;
  function renderLayersSoon() { clearTimeout(rlTimer); rlTimer = setTimeout(renderLayers, 250); }

  // ---------- selezione
  function selectionChanged(scroll = true) {
    layers.forEach(L => L.kind === "vector" && L.ol.changed());
    renderTableSoon(scroll);
    updateStatus();
  }
  function selectOnly(list, add = false) {
    if (!add) sel.clear();
    list.forEach(f => (add && sel.has(f) && list.length === 1 ? sel.delete(f) : sel.add(f)));
    selectionChanged();
  }
  function zoomTo(feats) {
    const ext = ol.extent.createEmpty();
    feats.forEach(f => { const g = f.getGeometry(); if (g) ol.extent.extend(ext, g.getExtent()); });
    if (!ol.extent.isEmpty(ext)) fitExtent(ext, 19);
  }

  map.on("singleclick", e => {
    if (tool !== "select") return;
    let hit = null;
    map.forEachFeatureAtPixel(e.pixel, (f, lyr) => { if (f.__L && lyr === f.__L.ol) { hit = f; return true; } return false; }, { hitTolerance: 4 });
    const add = e.originalEvent.ctrlKey || e.originalEvent.metaKey;
    if (!hit) { if (!add) { sel.clear(); selectionChanged(false); } popup.hidden = true; return; }
    if (hit.__L !== active) setActive(hit.__L);
    selectOnly([hit], add);
    showPopup(hit, e.coordinate);
    scrollToFeature(hit);
  });
  const dragBox = new ol.interaction.DragBox({ condition: ol.events.condition.platformModifierKeyOnly, className: "gis-dragbox" });
  dragBox.on("boxend", () => {
    if (tool !== "select") return;
    const ext = dragBox.getGeometry().getExtent();
    const targets = active ? [active] : layers.filter(L => L.kind === "vector" && L.visible);
    const found = [];
    targets.forEach(L => L.source.forEachFeatureIntersectingExtent(ext, f => { found.push(f); }));
    found.forEach(f => sel.add(f));
    selectionChanged();
    toast(`${found.length} elementi aggiunti alla selezione`, false, 1500);
  });
  map.addInteraction(dragBox);

  function showPopup(f, coord) {
    const p = io.props(f);
    const keys = Object.keys(p).filter(k => p[k] !== null && p[k] !== "" && p[k] !== undefined);
    popup.innerHTML = "";
    popup.append(...[el("div", { class: "gis-popup-head" }, el("b", {}, f.__L.name), el("button", { class: "btn", title: "Chiudi", onclick: () => { popup.hidden = true; } }, "×")),
      el("table", {}, keys.slice(0, 16).map(k => el("tr", {}, el("th", {}, k), el("td", {}, typeof p[k] === "number" ? p[k].toLocaleString("it-IT", { maximumFractionDigits: 6 }) : String(p[k]))))),
      keys.length > 16 ? el("div", { class: "note" }, `... altri ${keys.length - 16} campi nella tabella attributi`) : null,
      keys.length ? null : el("div", { class: "note" }, "Nessun attributo")].filter(Boolean));
    popup.hidden = false;
    popupOv.setPosition(coord);
  }

  // ---------- coordinate del cursore
  map.on("pointermove", e => {
    if (e.dragging) return;
    let txt;
    try { txt = fmtCoord(ol.proj.transform(e.coordinate, VIEW, dispCode), dispCode, dispMode); } catch { txt = "—"; }
    const vals = [];
    for (const L of layers) {
      if (L.kind !== "raster" || !L.band || !L.visible) continue;
      try { const c = ol.proj.transform(e.coordinate, VIEW, L.code); const v = io.rasterValue(L, c[0], c[1]); if (v !== null) vals.push(`${L.name}: ${nf(v, Number.isInteger(v) ? 0 : 2)}`); } catch { /* */ }
    }
    coordEl.textContent = txt + (vals.length ? "   ·   " + vals.join("   ") : "") + "   ·   " + dispCode;
  });

  // ---------- tabella attributi
  const ROW_H = 24;
  const tSearch = el("input", { type: "search", class: "field", placeholder: "Cerca negli attributi..." });
  const tOnlySel = el("input", { type: "checkbox" });
  const tCount = el("span", { class: "note" });
  const tTitle = el("b", {});
  const tScroll = el("div", { class: "gis-tscroll" });
  const tHead = el("div", { class: "gis-thead" });
  const tBody = el("div", { class: "gis-tbody" });
  tScroll.append(tHead, tBody);
  tableWrap.append(el("div", { class: "gis-ttools" }, tTitle, tSearch, el("label", { class: "note" }, tOnlySel, "solo selezionati"),
    el("button", { class: "btn", onclick: () => { rowsView.forEach(i => sel.add(active.features[i])); selectionChanged(); } }, "Seleziona risultati"),
    el("button", { class: "btn", onclick: () => zoomTo([...sel].filter(f => f.__L === active)) }, "Zoom selezione"),
    el("button", { class: "btn", onclick: () => { sel.clear(); selectionChanged(); } }, "Deseleziona"),
    el("button", { class: "btn", onclick: () => exportCsv() }, "CSV"),
    el("span", { class: "grow" }), tCount,
    el("button", { class: "btn", title: "Chiudi la tabella", onclick: () => showTable(false) }, "×")), tScroll);
  let rowsView = [], sortKey = null, sortDir = 1, cols = [], colW = [], lastClick = -1;
  tSearch.addEventListener("input", () => renderTableSoon(false));
  tOnlySel.addEventListener("change", () => renderTable(false));
  tScroll.addEventListener("scroll", () => paintRows());

  function showTable(on) {
    tableWrap.hidden = !on; splitter.hidden = !on;
    tableBtn.classList.toggle("on", on);
    if (on) renderTable(false);
    requestAnimationFrame(() => map.updateSize());
  }
  function setActive(L) {
    active = L;
    sortKey = null;
    renderLayers();
    if (!tableWrap.hidden) renderTable(false);
  }
  function filteredRows() {
    if (!active) return [];
    const q = tSearch.value.trim().toLowerCase();
    let idx = active.features.map((_, i) => i);
    if (tOnlySel.checked) idx = idx.filter(i => sel.has(active.features[i]));
    if (q) idx = idx.filter(i => { const p = active.features[i].getProperties(); return cols.some(c => p[c] !== null && p[c] !== undefined && String(p[c]).toLowerCase().includes(q)); });
    if (sortKey) {
      const v = i => active.features[i].get(sortKey);
      idx.sort((a, b) => { const x = v(a), y = v(b); if (x === y) return 0; if (x === null || x === undefined) return 1; if (y === null || y === undefined) return -1; return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "it", { numeric: true })) * sortDir; });
    }
    return idx;
  }
  let rtTimer = 0;
  function renderTableSoon(scroll) { clearTimeout(rtTimer); rtTimer = setTimeout(() => renderTable(scroll), 60); }
  function renderTable(scroll) {
    if (tableWrap.hidden) return;
    tTitle.textContent = active ? active.name : "Nessun livello vettoriale";
    cols = active ? active.fields.slice() : [];
    colW = cols.map(c => {
      let n = c.length;
      for (let i = 0; i < Math.min(200, active.features.length); i++) { const v = active.features[i].get(c); if (v !== null && v !== undefined) n = Math.max(n, String(v).length); }
      return Math.min(320, Math.max(60, n * 7.5 + 18));
    });
    tHead.innerHTML = "";
    tHead.append(el("div", { class: "gis-cell num" }, "#"), ...cols.map((c, k) => el("div", { class: "gis-cell", style: { width: colW[k] + "px" }, title: "Ordina per " + c,
      onclick: () => { if (sortKey === c) sortDir = -sortDir; else { sortKey = c; sortDir = 1; } renderTable(false); } }, c + (sortKey === c ? (sortDir > 0 ? " ▲" : " ▼") : ""))));
    rowsView = filteredRows();
    tBody.style.height = rowsView.length * ROW_H + "px";
    const nSel = active ? active.features.filter(f => sel.has(f)).length : 0;
    tCount.textContent = active ? `${rowsView.length.toLocaleString("it-IT")} di ${active.features.length.toLocaleString("it-IT")} · ${nSel} selezionati` : "";
    if (scroll && active) { const f = [...sel].reverse().find(x => x.__L === active); if (f) return scrollToFeature(f); }
    paintRows();
  }
  function paintRows() {
    if (tableWrap.hidden || !active) { tBody.innerHTML = ""; return; }
    const top = Math.max(0, Math.floor((tScroll.scrollTop - tHead.offsetHeight) / ROW_H) - 5);
    const n = Math.ceil(tScroll.clientHeight / ROW_H) + 10;
    tBody.innerHTML = "";
    for (let r = top; r < Math.min(rowsView.length, top + n); r++) {
      const i = rowsView[r], f = active.features[i];
      const row = el("div", { class: "gis-row" + (sel.has(f) ? " sel" : ""), style: { top: r * ROW_H + "px" } },
        el("div", { class: "gis-cell num" }, String(i + 1)),
        ...cols.map((c, k) => { const v = f.get(c); return el("div", { class: "gis-cell" + (typeof v === "number" ? " n" : ""), style: { width: colW[k] + "px" }, title: v === null || v === undefined ? "" : String(v) }, v === null || v === undefined ? "" : typeof v === "number" ? v.toLocaleString("it-IT", { maximumFractionDigits: 6 }) : String(v)); }));
      row.addEventListener("click", e => {
        if (e.shiftKey && lastClick >= 0) { const a = Math.min(lastClick, r), b = Math.max(lastClick, r); for (let k = a; k <= b; k++) sel.add(active.features[rowsView[k]]); selectionChanged(false); return; }
        lastClick = r;
        selectOnly([f], e.ctrlKey || e.metaKey);
        if (!(e.ctrlKey || e.metaKey) && f.getGeometry()) { const g = f.getGeometry(); if (!ol.extent.containsExtent(view.calculateExtent(), g.getExtent())) zoomTo([f]); }
      });
      row.addEventListener("dblclick", () => zoomTo([f]));
      tBody.append(row);
    }
  }
  function scrollToFeature(f) {
    if (tableWrap.hidden || f.__L !== active) return;
    let r = rowsView.indexOf(f.__i);
    if (r < 0) { tSearch.value = ""; tOnlySel.checked = false; rowsView = filteredRows(); tBody.style.height = rowsView.length * ROW_H + "px"; r = rowsView.indexOf(f.__i); }
    const y = tHead.offsetHeight + r * ROW_H;
    if (y < tScroll.scrollTop + tHead.offsetHeight || y > tScroll.scrollTop + tScroll.clientHeight - ROW_H) tScroll.scrollTop = y - tScroll.clientHeight / 2;
    paintRows();
  }
  async function exportCsv() {
    if (!active) return;
    const q = v => { const s = v === null || v === undefined ? "" : typeof v === "number" ? String(v).replace(".", ",") : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [cols.map(q).join(";"), ...rowsView.map(i => cols.map(c => q(active.features[i].get(c))).join(";"))];
    const { saveBlobAs } = await import("../core.js");
    await saveBlobAs(active.name + ".csv", new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv" }), dirName(ctx.path));
  }
  // divisore trascinabile tra mappa e tabella
  splitter.addEventListener("pointerdown", e => {
    const y0 = e.clientY, h0 = tableWrap.offsetHeight;
    splitter.setPointerCapture(e.pointerId);
    const mv = ev => { tableWrap.style.height = Math.max(90, Math.min(right.offsetHeight - 120, h0 - (ev.clientY - y0))) + "px"; map.updateSize(); paintRows(); };
    const up = () => { splitter.removeEventListener("pointermove", mv); splitter.removeEventListener("pointerup", up); };
    splitter.addEventListener("pointermove", mv); splitter.addEventListener("pointerup", up);
  });

  function updateStatus() {
    const nv = layers.filter(L => L.kind === "vector").reduce((s, L) => s + L.features.length, 0);
    ctx.status(`${layers.length} livell${layers.length === 1 ? "o" : "i"} · ${nv.toLocaleString("it-IT")} elementi${sel.size ? ` · ${sel.size} selezionati` : ""}`);
  }

  // ---------- apertura dei file
  const remoteIcon = href => (!href || /^(data|blob):/.test(href) ? href : WEB ? href : "/api/gis_tile?p=url&u=" + encodeURIComponent(href));
  async function readAny(path, name) {
    const ext = extOf(name);
    const plain = name.replace(/\.[^.]+$/, "");
    if (RASTER_EXT.has(ext)) return [await io.readGeoTiff(path, plain)];
    if (ext === "shp") return [await io.readShapefileFromDisk(ol, path, name)];
    if (ext === "gpkg") return io.readGpkg(ol, path);
    const bytes = await readBytes(path);
    if (ext === "zip") return io.readZip(ol, bytes, remoteIcon);
    if (ext === "kmz") return [await io.readKmz(ol, bytes, plain, remoteIcon)];
    const text = io.decodeText(bytes);
    if (ext === "kml") return [io.readKml(ol, text, plain, remoteIcon)];
    if (ext === "gpx") return [io.readGpx(ol, text, plain)];
    return [io.readGeoJson(ol, text, plain)];
  }
  async function addPaths(paths, fit = true) {
    const added = [];
    for (const p of paths) {
      try {
        for (const L of await readAny(p, baseName(p))) { L.path = p; added.push(addLayer(L)); }
      } catch (e) { console.error(e); toast(`${baseName(p)}: ${e.message}`, true, 6000); }
    }
    if (fit && added.length) {
      const ext = ol.extent.createEmpty();
      added.forEach(L => { const x = layerExtent(L); if (x) ol.extent.extend(ext, x); });
      fitExtent(ext);
    }
    return added;
  }
  async function addFromPicker() {
    const paths = await pickFiles();
    if (paths?.length) await addPaths(paths.filter(p => GIS_EXT.has(extOf(p)) || extOf(p) === "json"));
  }

  prog.set?.(0.3, "Lettura del file");
  const first = await addPaths([ctx.path], false);
  if (!first.length) throw new Error("Nessun dato geografico leggibile in questo file");
  if (first.some(L => L.kind === "vector")) showTable(first.reduce((s, L) => s + (L.features?.length || 0), 0) <= 50000);
  requestAnimationFrame(() => requestAnimationFrame(() => { map.updateSize(); fitAll(); }));

  // ---------- esportazione della vista (PNG / JPG / PDF)
  async function viewCanvas() {
    await new Promise(res => { map.once("rendercomplete", res); map.renderSync(); setTimeout(res, 4000); });
    const size = map.getSize(), dpr = window.devicePixelRatio || 1;
    const c = document.createElement("canvas");
    c.width = Math.round(size[0] * dpr); c.height = Math.round(size[1] * dpr);
    const g = c.getContext("2d");
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height);
    mapEl.querySelectorAll(".ol-layer canvas, canvas.ol-layer").forEach(cv => {
      if (!cv.width) return;
      const op = cv.parentNode.style.opacity || cv.style.opacity;
      g.globalAlpha = op === "" ? 1 : +op;
      const m = cv.style.transform.match(/^matrix\(([^)]*)\)$/);
      const t = m ? m[1].split(",").map(Number) : [1, 0, 0, 1, 0, 0];
      // la trasformazione CSS del canvas di OpenLayers e' in pixel CSS: qui si lavora in pixel reali (x dpr)
      g.setTransform(t[0] * dpr, t[1] * dpr, t[2] * dpr, t[3] * dpr, t[4] * dpr, t[5] * dpr);
      g.drawImage(cv, 0, 0);
    });
    g.globalAlpha = 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // attribuzioni (obbligatorie) e barra di scala
    const attrs = [...mapEl.querySelectorAll(".ol-attribution li")].map(li => li.textContent.trim()).filter(Boolean).join(" · ");
    g.font = "11px 'Segoe UI', sans-serif";
    if (attrs) { const w = g.measureText(attrs).width + 12; g.fillStyle = "rgba(255,255,255,.85)"; g.fillRect(size[0] - w, size[1] - 18, w, 18); g.fillStyle = "#333"; g.fillText(attrs, size[0] - w + 6, size[1] - 5); }
    const res = ol.proj.getPointResolution(VIEW, view.getResolution(), view.getCenter(), "m");
    let len = Math.pow(10, Math.floor(Math.log10(res * 150)));
    if (len / res < 60) len *= 5; else if (len / res < 100) len *= 2;
    const px = len / res;
    g.fillStyle = "rgba(255,255,255,.85)"; g.fillRect(8, size[1] - 34, px + 70, 26);
    g.fillStyle = "#222"; g.fillRect(14, size[1] - 16, px, 4);
    g.fillText(fmtLen(len), 20 + px, size[1] - 12);
    return c;
  }
  async function viewBytes(fmt) {
    let c;
    try { c = await viewCanvas(); } catch (e) { throw new Error("Vista non esportabile: " + e.message); }
    const type = fmt === "png" ? "image/png" : "image/jpeg";
    let blob;
    try { blob = await new Promise((r, j) => c.toBlob(b => (b ? r(b) : j(new Error("immagine vuota"))), type, 0.92)); } catch {
      throw new Error("Lo sfondo cartografico non consente l'esportazione: scegli 'Nessuno sfondo' o un servizio con CORS");
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return fmt === "pdf" ? jpegToPdf(bytes, c.width, c.height, ctx.name) : bytes;
  }
  async function exportView(fmt) {
    const { saveBlobAs } = await import("../core.js");
    try {
      const b = await viewBytes(fmt);
      await saveBlobAs(ctx.name.replace(/\.[^.]+$/, "") + "_mappa." + fmt, new Blob([b]), WEB ? "" : dirName(ctx.path));
    } catch (e) { toast(e.message, true, 6000); }
  }

  // ---------- salvataggio nei formati vettoriali
  async function exportOptions(ext) {
    const vec = layers.filter(L => L.kind === "vector");
    if (!vec.length) throw new Error("Non ci sono livelli vettoriali da salvare");
    const checks = vec.map(L => { const c = el("input", { type: "checkbox" }); c.checked = L.visible; return [L, c]; });
    const onlySel = el("input", { type: "checkbox", disabled: sel.size ? null : "" });
    const needCrs = ext === "zip";
    const crsSel = el("select", { class: "field" }, el("option", { value: "" }, "Sistema di ogni livello (come nel file)"), crsChoices().map(c => el("option", { value: "EPSG:" + c.code }, `${c.name} · ${c.code}`)));
    if (vec.length === 1 && vec[0].guessed) crsSel.value = "EPSG:4326";
    const body = el("div", { class: "gis-dialog" }, el("div", { class: "label" }, "Livelli da salvare"),
      ...checks.map(([L, c]) => el("label", { class: "gis-check" }, c, `${L.name} (${L.features.length.toLocaleString("it-IT")} elementi)`)),
      el("label", { class: "gis-check" }, onlySel, `solo gli elementi selezionati (${sel.size})`),
      needCrs ? el("label", { class: "gis-form" }, "Sistema di riferimento", crsSel) : el("p", { class: "note" }, ext === "gpx" ? "GPX: coordinate WGS84; si salvano solo punti e linee." : "Coordinate in WGS84 (gradi), come richiesto dal formato."));
    if (vec.length === 1 && !sel.size && !needCrs) return { layers: vec, onlySel: false, crs: null };
    const ok = await modal(`Salva in ${ext === "zip" ? "shapefile (ZIP)" : ext.toUpperCase()}`, body, [{ label: "Annulla", value: false }, { label: "Salva", value: true, primary: true }]);
    if (!ok) return null;
    const chosen = checks.filter(([, c]) => c.checked).map(([L]) => L);
    if (!chosen.length) throw new Error("Nessun livello scelto");
    return { layers: chosen, onlySel: onlySel.checked, crs: crsSel.value || null };
  }
  // elementi da scrivere: geometrie ricavate da quelle originali del file (nessuna perdita di precisione)
  function exportFeatures(L, target, onlySel, withStyle) {
    const out = [];
    L.features.forEach((f, i) => {
      if (onlySel && !sel.has(f)) return;
      const nf2 = new ol.Feature(io.props(f));
      const g = L.src[i];
      if (g) nf2.setGeometry(L.code === target ? g.clone() : g.clone().transform(L.code, target));
      if (withStyle) {
        const st = plainStyle(L, f, 1);
        if (st) nf2.setStyle(st);
        if (L.style.label && !nf2.get("name")) nf2.set("name", String(f.get(L.style.label) ?? ""));
      }
      out.push(nf2);
    });
    return out;
  }
  async function saveVector(target, ext) {
    const opt = await exportOptions(ext);
    if (!opt) return null;
    const enc = new TextEncoder();
    if (ext === "geojson" || ext === "json") {
      const feats = opt.layers.flatMap(L => exportFeatures(L, "EPSG:4326", opt.onlySel));
      const txt = new ol.format.GeoJSON().writeFeatures(feats, { dataProjection: "EPSG:4326", featureProjection: "EPSG:4326", decimals: 9 });
      const obj = JSON.parse(txt);
      obj.name = opt.layers.length === 1 ? opt.layers[0].name : baseName(target).replace(/\.[^.]+$/, "");
      return enc.encode(JSON.stringify(obj));
    }
    if (ext === "kml" || ext === "kmz") {
      const feats = opt.layers.flatMap(L => exportFeatures(L, "EPSG:4326", opt.onlySel, true));
      let xml = new ol.format.KML({ writeStyles: true }).writeFeatures(feats, { dataProjection: "EPSG:4326", featureProjection: "EPSG:4326", decimals: 9 });
      // icone: quelle passate dal server locale tornano all'indirizzo originale; quelle interne a un KMZ
      // (indirizzi blob) vanno nel nuovo KMZ, mentre in un KML semplice resta il segnaposto predefinito
      const zip = ext === "kmz" ? new window.JSZip() : null;
      const icons = new Map();
      for (const m of [...xml.matchAll(/<href>([^<]+)<\/href>/g)]) {
        const href = m[1].replace(/&amp;/g, "&");
        if (icons.has(href)) continue;
        const prox = href.match(/\/api\/gis_tile\?p=url&u=([^&]+)/);
        if (prox) icons.set(href, decodeURIComponent(prox[1]));
        else if (href.startsWith("blob:") && zip) {
          const name = `files/icona${icons.size + 1}.png`;
          zip.file(name, new Uint8Array(await (await fetch(href)).arrayBuffer()));
          icons.set(href, name);
        } else if (href.startsWith("blob:")) icons.set(href, null);
      }
      xml = xml.replace(/<IconStyle>[\s\S]*?<\/IconStyle>/g, blk => {
        const h = (blk.match(/<href>([^<]+)<\/href>/) || [])[1]?.replace(/&amp;/g, "&");
        if (!h || !icons.has(h)) return blk;
        const to = icons.get(h);
        return to ? blk.replace(/<href>[^<]+<\/href>/, `<href>${to.replace(/&/g, "&amp;")}</href>`) : "";
      });
      const bytes = enc.encode('<?xml version="1.0" encoding="UTF-8"?>\n' + xml);
      if (!zip) return bytes;
      zip.file("doc.kml", bytes);
      return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    }
    if (ext === "gpx") {
      const feats = opt.layers.flatMap(L => exportFeatures(L, "EPSG:4326", opt.onlySel)).filter(f => /Point|LineString/.test(f.getGeometry()?.getType() || ""));
      if (!feats.length) throw new Error("GPX contiene solo punti e linee: nessun elemento adatto");
      return enc.encode(new ol.format.GPX().writeFeatures(feats, { dataProjection: "EPSG:4326", featureProjection: "EPSG:4326" }));
    }
    if (ext === "zip") {
      const zip = new window.JSZip();
      for (const L of opt.layers) {
        const code = opt.crs || L.code;
        const wkt = wktFor(code) || (code === L.code && L.prj) || null;
        const files = io.writeShapefiles([{ name: L.name, features: exportFeatures(L, code, opt.onlySel) }], wkt);
        if (!wkt) toast(`${L.name}: sistema ${code} senza .prj standard (scrivi il .prj a mano o scegli un sistema in elenco)`, true, 6000);
        for (const [n, b] of Object.entries(files)) zip.file(n, b);
      }
      return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    }
    throw new Error("Formato non supportato");
  }

  const onKey = e => {
    if (!ctx.el.isConnected || ctx.el.offsetParent === null) return;
    if (e.key === "Escape") { if (draw) draw.abortDrawing(); if (tool !== "select") setTool("select"); else if (sel.size) { sel.clear(); selectionChanged(false); } popup.hidden = true; }
  };
  window.addEventListener("keydown", onKey);

  const SAVE = ["geojson", "kml", "kmz", "gpx", "zip", "png", "jpg", "pdf"];
  return {
    _gis: { map, layers, sel, addPaths, setTool, io, ol, viewCanvas, saveVector, active: () => active },
    onShow() { requestAnimationFrame(() => map.updateSize()); },
    saveInPlace: false,
    saveFormats: SAVE,
    saveLabels: { geojson: "GeoJSON (WGS84)", kml: "KML per Google Earth (WGS84)", kmz: "KMZ (KML compresso)", gpx: "GPX (punti e tracce)",
      zip: "Shapefile in archivio ZIP (.shp .shx .dbf .prj .cpg)", png: "Immagine PNG della vista", jpg: "Immagine JPG della vista", pdf: "PDF della vista" },
    saveNote: "I formati vettoriali salvano i livelli della mappa con i loro attributi; PNG, JPG e PDF salvano la vista come la vedi, con le attribuzioni dello sfondo.",
    saveAsName: () => ctx.name.replace(/\.[^.]+$/, "") + (["geojson", "kml", "kmz", "gpx"].includes(ctx.ext) ? "_copia." + ctx.ext : ".geojson"),
    async save(target) {
      const ext = extOf(target);
      let bytes;
      if (["png", "jpg", "jpeg", "pdf"].includes(ext)) bytes = await viewBytes(ext === "jpeg" ? "jpg" : ext);
      else if (["geojson", "json", "kml", "kmz", "gpx", "zip"].includes(ext)) bytes = await saveVector(target, ext);
      else throw new Error("Formati disponibili: " + SAVE.join(", ").toUpperCase());
      if (!bytes) throw new Error("Salvataggio annullato");
      await saveBytes(target, bytes);
      return { switchTo: false };
    },
    async acceptDrop(paths) {
      const ok = paths.filter(p => GIS_EXT.has(extOf(p)) || extOf(p) === "json");
      if (!ok.length || ok.length !== paths.length) return false;
      await addPaths(ok);
      return true;
    },
    dispose() {
      window.removeEventListener("keydown", onKey);
      ro.disconnect();
      layers.forEach(L => L.dispose?.());
      map.setTarget(null);
    },
  };
}

// PDF con la vista come immagine JPEG (pagina A4 orizzontale o verticale secondo le proporzioni)
function jpegToPdf(jpg, w, h, title) {
  const land = w >= h;
  const pw = land ? 842 : 595, ph = land ? 595 : 842, m = 28;
  const k = Math.min((pw - 2 * m) / w, (ph - 2 * m - 18) / h);
  const iw = w * k, ih = h * k, ix = (pw - iw) / 2, iy = (ph - ih) / 2 - 9;
  const enc = s => new TextEncoder().encode(s);
  const chunks = [], offsets = [];
  let len = 0;
  const push = b => { chunks.push(b); len += b.length; };
  const obj = (n, body, stream) => {
    offsets[n] = len;
    push(enc(`${n} 0 obj\n${body}\n`));
    if (stream) { push(enc("stream\n")); push(stream); push(enc("\nendstream\n")); }
    push(enc("endobj\n"));
  };
  const safe = String(title || "").replace(/[^\x20-\x7e]/g, "?").replace(/([()\\])/g, "\\$1");
  push(enc("%PDF-1.4\n"));
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> /Font << /F1 6 0 R >> >> /Contents 5 0 R >>`);
  obj(4, `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>`, jpg);
  const content = enc(`q ${iw.toFixed(2)} 0 0 ${ih.toFixed(2)} ${ix.toFixed(2)} ${iy.toFixed(2)} cm /Im0 Do Q BT /F1 11 Tf ${m} ${ph - m + 6} Td (${safe}) Tj ET`);
  obj(5, `<< /Length ${content.length} >>`, content);
  obj(6, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const xref = len;
  let x = "xref\n0 7\n0000000000 65535 f \n";
  for (let n = 1; n <= 6; n++) x += String(offsets[n]).padStart(10, "0") + " 00000 n \n";
  push(enc(x + `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`));
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
