// Disegni DWG/DXF e tavole PDF sulla mappa del visualizzatore GIS (ui/js/viewers/gis.js).
// Ogni disegno ha una proiezione OpenLayers propria ("MBVDRAW:n") = piano del disegno, collegata a tutti i sistemi
// noti con la trasformazione di georeferenziazione (georef.js) seguita da proj4: cosi' riproiezione sulla mappa,
// esportazioni GeoJSON/KML/shapefile e raster PDF riproiettato usano i meccanismi normali di OpenLayers.
// Georeferenziazione: .mbgeo accanto al file -> GEODATA del disegno -> coordinate riconosciute dall'estensione ->
// posizionamento provvisorio da correggere con i punti di controllo (punto sul disegno -> punto sulla mappa).
import { baseName, el, extOf, modal, readBytes, saveBlobAs, saveBytes, toast, WEB } from "./core.js";
import { buildModel, ACI, decodeDwg, normalize } from "./viewers/cad2d.js";
import { parseDxf } from "./dxf.js";
import { CRS, crsChoices, crsName } from "./giscrs.js";
import { LOCALE, t as tr } from "./i18n.js";
import * as G from "./georef.js";

export const DRAW_EXT = new Set(["dwg", "dxf", "pdf"]);
const PDF_LIB = "/vendor/pdfjs/build/pdf.mjs";
let pdfLib = null, projN = 0;
const nf = (v, d = 2) => (+v).toLocaleString(LOCALE, { minimumFractionDigits: 0, maximumFractionDigits: d });
const hex = c => "#" + c.map(v => v.toString(16).padStart(2, "0")).join("");
const isUtf8 = b => { try { new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(0, 300000)); return true; } catch { return false; } };
const METHODS = ["coord", "rigida", "similarita", "affine"];
const projected = () => crsChoices().filter(c => !CRS.get(c.code).geographic);

export function createDrawingSupport(env) {
  const { ol, map, view, VIEW } = env;
  const proj4 = window.proj4;

  // ---------------------------------------------------------------- proiezione del disegno
  function register(L) {
    const D = L.drawing, g = D.geo;
    if (!D.proj) {
      D.proj = new ol.proj.Projection({ code: "MBVDRAW:" + (++projN), units: "m", extent: D.extent,
        getPointResolution: r => r * G.scaleOf(D.geo.T) });
      ol.proj.addProjection(D.proj);
    }
    const Ti = G.invert(g.T) || G.IDENTITY;
    const targets = new Set([VIEW, "EPSG:4326", ...[...CRS.keys()].map(c => "EPSG:" + c), g.crs]);
    for (const t of targets) {
      let to, from;
      try { to = ol.proj.getTransform(g.crs, t); from = ol.proj.getTransform(t, g.crs); } catch { continue; }
      ol.proj.addCoordinateTransforms(D.proj, t,
        c => to(G.apply(g.T, c[0], c[1])),
        c => { const p = from([c[0], c[1]]); return G.apply(Ti, p[0], p[1]); });
    }
    L.code = D.proj.getCode();
  }
  // applica la georeferenziazione corrente (dopo ogni modifica)
  function apply(L) {
    register(L);
    const D = L.drawing;
    try { const c = ol.proj.toLonLat(ol.proj.transform(D.center, L.code, VIEW)); D.cosLat = Math.cos(c[1] * Math.PI / 180) || 1; } catch { D.cosLat = 1; }
    if (L.kind === "vector") env.reproject(L);
    else setPdfSource(L);
    L.ol?.changed();
    env.changed(L);
  }
  function setPdfSource(L) {
    if (!L.ol) return;
    L.ol.setSource(new ol.source.ImageStatic({ url: L.drawing.url, imageExtent: L.extent, projection: L.code, interpolate: true }));
  }

  // ---------------------------------------------------------------- lettura
  async function read(path, name) {
    const ext = extOf(name);
    const L = ext === "pdf" ? await readPdf(path, name) : await readCad(path, name, ext);
    L.path = path;
    L.fileStyles = L.kind === "vector";
    const D = L.drawing;
    D.center = [(D.bbox[0] + D.bbox[2]) / 2, (D.bbox[1] + D.bbox[3]) / 2];
    const w = Math.max(D.bbox[2] - D.bbox[0], D.bbox[3] - D.bbox[1]) || 1;
    D.extent = [D.bbox[0] - w, D.bbox[1] - w, D.bbox[2] + w, D.bbox[3] + w];
    D.geo = await initialGeo(L);
    register(L);
    try { const c = ol.proj.toLonLat(ol.proj.transform(D.center, L.code, VIEW)); D.cosLat = Math.cos(c[1] * Math.PI / 180) || 1; } catch { D.cosLat = 1; }
    return L;
  }

  async function readCad(path, name, ext) {
    const bytes = await readBytes(path);
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 6));
    const dxfText = ext === "dxf" && !head.startsWith("AutoCA");
    let db, geodata = null;
    if (dxfText) {
      const text = new TextDecoder(isUtf8(bytes) ? "utf-8" : "windows-1252").decode(bytes);
      db = parseDxf(text);
      try { geodata = G.geodataFromDxf(text); } catch { geodata = null; }
    } else {
      db = await decodeDwg(bytes, { ext, tools: {}, geodata: true }, { set() {} });
      geodata = db.geodata || null;
    }
    normalize(db, dxfText ? "dxf" : "dwg");
    const model = buildModel(db);
    const unitCode = +(db.header?.INSUNITS ?? 0);
    const D = { type: "cad", model, geodata, unitCode, unitFile: G.INSUNITS[unitCode] || 0, bbox: model.bbox };
    const cadLayers = new Map([...model.layers.values()].filter(l => l.count).sort((a, b) => a.name.localeCompare(b.name, "it", { numeric: true }))
      .map(l => [l.name, { name: l.name, off: !!l.off, color: ACI[Math.abs(l.aci ?? 7)] || ACI[7], count: l.count }]));
    D.cadLayers = cadLayers;
    // punti notevoli (entita' PUNTO): l'aggancio li preferisce alla crocetta con cui sono disegnati
    D.nodes = model.items.filter(it => it.t === "N" && it.k === "nod").map(it => [it.x, it.y, it.l]);
    const features = [];
    const lineStyles = new Map();
    const off = f => cadLayers.get(f.get("layer"))?.off;
    const strokeStyle = (color, lw, fill) => {
      const key = color + "|" + lw + "|" + (fill ? 1 : 0);
      let s = lineStyles.get(key);
      if (!s) lineStyles.set(key, (s = fill ? new ol.style.Style({ fill: new ol.style.Fill({ color }) })
        : new ol.style.Style({ stroke: new ol.style.Stroke({ color, width: lw > 25 ? Math.min(4, 1 + lw / 50) : 1.2, lineCap: "round", lineJoin: "round" }) })));
      return s;
    };
    // il bianco (colore 7) su una mappa chiara diventa scuro, come AutoCAD su sfondo bianco
    const mapColor = c => (c[0] > 230 && c[1] > 230 && c[2] > 230 ? "#1b1e1c" : hex(c));
    const CHUNK = 2000;
    for (const g of model.groups) {
      const color = mapColor(g.color);
      for (let i = 0; i < g.lines.length; i += CHUNK) {
        const coords = g.lines.slice(i, i + CHUNK).map(({ pts, closed }) => (closed ? [...pts, pts[0]] : pts));
        const f = new ol.Feature({ geometry: new ol.geom.MultiLineString(coords), layer: g.layer, tipo: tr("gisdraw.tipo_linee") });
        f.setStyle(ff => (off(ff) ? null : strokeStyle(color, g.lw, false)));
        features.push(f);
      }
      for (let i = 0; i < g.fills.length; i += CHUNK) {
        const coords = g.fills.slice(i, i + CHUNK).map(({ pts }) => [[...pts, pts[0]]]);
        const f = new ol.Feature({ geometry: new ol.geom.MultiPolygon(coords), layer: g.layer, tipo: tr("gisdraw.tipo_campiture") });
        f.setStyle(ff => (off(ff) ? null : strokeStyle(color, 0, true)));
        features.push(f);
      }
    }
    let Ldraw = null;
    for (const t of model.texts) {
      const q = t.quad, cx = (q[0][0] + q[2][0]) / 2, cy = (q[0][1] + q[2][1]) / 2;
      const s = t.rows.map(r => r.s).join("\n");
      if (!s.trim()) continue;
      const ang = Math.atan2(t.A[1], t.A[0]), color = mapColor(t.color), h = t.h;
      const f = new ol.Feature({ geometry: new ol.geom.Point([cx, cy]), layer: t.layer, tipo: tr("gisdraw.tipo_testo"), testo: s });
      f.setStyle((ff, res) => {
        if (off(ff) || !Ldraw || !Ldraw.showText) return null;
        const px = h * G.scaleOf(Ldraw.geo.T) / (res * Ldraw.cosLat);
        if (px < 3 || px > 400) return null;
        return new ol.style.Style({ text: new ol.style.Text({ text: s, font: `${Math.round(px * 10) / 10}px Arial, sans-serif`, fill: new ol.style.Fill({ color }),
          rotation: -(ang + G.rotationOf(Ldraw.geo.T) * Math.PI / 180), textAlign: "center", textBaseline: "middle", overflow: true, declutterMode: "none" }) });
      });
      features.push(f);
    }
    const L = { kind: "vector", name, features, drawing: D, fields: ["layer", "tipo", "testo"] };
    D.showText = true;
    Ldraw = D;
    return L;
  }

  async function readPdf(path, name) {
    pdfLib ||= import(PDF_LIB).then(m => { m.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/build/pdf.worker.mjs"; return m; });
    const lib = await pdfLib;
    const doc = await lib.getDocument({ data: await readBytes(path), cMapUrl: "/vendor/pdfjs/web/cmaps/", cMapPacked: true,
      standardFontDataUrl: "/vendor/pdfjs/web/standard_fonts/", isEvalSupported: false }).promise;
    const saved = await loadMbgeo(path);
    let pageNo = saved?.page || 1;
    if (!saved && doc.numPages > 1) {
      const s = el("select", { class: "field" }, Array.from({ length: doc.numPages }, (_, i) => el("option", { value: i + 1 }, tr("gisdraw.pagina_n", i + 1))));
      const v = await modal(tr("gisdraw.quale_pagina"), el("div", { class: "gis-dialog" }, el("p", {}, tr("gisdraw.pdf_piu_pagine", name, doc.numPages)), s),
        [{ label: tr("common.annulla"), value: null }, { label: "OK", primary: true, value: () => +s.value }]);
      if (!v) throw new Error(tr("gisdraw.apertura_annullata"));
      pageNo = v;
    }
    pageNo = Math.min(Math.max(1, pageNo), doc.numPages);
    const page = await doc.getPage(pageNo);
    const vp1 = page.getViewport({ scale: 1 });
    const W = vp1.width, H = vp1.height;
    const k = Math.min(8192 / Math.max(W, H), Math.sqrt(36e6 / (W * H)), 6);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(W * k); canvas.height = Math.round(H * k);
    const g2 = canvas.getContext("2d", { willReadFrequently: true });
    g2.fillStyle = "#fff"; g2.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: g2, viewport: page.getViewport({ scale: k }), intent: "print" }).promise;
    const D = { type: "pdf", page: pageNo, pages: doc.numPages, W, H, bbox: [0, 0, W, H], canvas, whiteClear: true, saved };
    await pdfImage(D);
    doc.destroy?.();
    return { kind: "raster", name: doc.numPages > 1 ? `${name} · ${tr("gisdraw.pagina_n", pageNo)}` : name, extent: [0, 0, W, H], drawing: D,
      srcWidth: canvas.width, srcHeight: canvas.height, bands: 3, canvas };
  }
  // immagine della tavola: il bianco diventa trasparente (si vede la mappa sotto)
  async function pdfImage(D) {
    let c = D.canvas;
    if (D.whiteClear) {
      c = document.createElement("canvas");
      c.width = D.canvas.width; c.height = D.canvas.height;
      const g = c.getContext("2d");
      g.drawImage(D.canvas, 0, 0);
      const img = g.getImageData(0, 0, c.width, c.height), p = img.data;
      for (let i = 0; i < p.length; i += 4) if (p[i] > 238 && p[i + 1] > 238 && p[i + 2] > 238) p[i + 3] = 0;
      g.putImageData(img, 0, 0);
    }
    const blob = await new Promise(r => c.toBlob(r, "image/png"));
    if (D.url) URL.revokeObjectURL(D.url);
    D.url = URL.createObjectURL(blob);
  }

  // ---------------------------------------------------------------- georeferenziazione iniziale
  const mbgeoPath = p => p + ".mbgeo";
  async function loadMbgeo(path) {
    if (!path || WEB) return null;
    try { return G.fromMbgeo(JSON.parse(new TextDecoder().decode(await readBytes(mbgeoPath(path))))); } catch { return null; }
  }
  const defaultCrs = () => {
    try { const lon = ol.proj.toLonLat(view.getCenter())[0]; return lon >= 12 ? "EPSG:7792" : "EPSG:7791"; } catch { return "EPSG:7791"; }
  };
  async function initialGeo(L) {
    const D = L.drawing;
    const saved = D.type === "pdf" ? D.saved : await loadMbgeo(L.path);
    if (saved && ol.proj.get(saved.crs)) return { ...saved, source: "mbgeo", res: G.residuals(saved.T, saved.points).res };
    if (D.type === "cad" && D.geodata) {
      const gd = D.geodata, epsg = G.epsgFromCsDef(gd.def);
      const code = epsg && CRS.has(epsg) && !CRS.get(epsg).geographic ? "EPSG:" + epsg : null;
      if (code) {
        let ref = gd.ref;
        if (gd.type === 3) ref = ol.proj.transform(gd.ref, "EPSG:4326", code);
        return { crs: code, method: "coord", unit: gd.scale || 1, T: G.geodataTransform(gd, ref), points: [], source: "geodata" };
      }
      D.geoNote = epsg ? tr("gisdraw.geodata_sistema_non_gestito", epsg) : tr("gisdraw.geodata_senza_sistema");
    }
    if (D.type === "cad") {
      const u = D.unitFile || 1;
      const epsg = G.guessFromExtent(D.bbox, u) || (D.unitFile ? null : G.guessFromExtent(D.bbox, 1));
      if (epsg) return { crs: "EPSG:" + epsg, method: "coord", unit: u, T: [u, 0, 0, 0, u, 0], points: [], source: "coord" };
    }
    // disegno in coordinate locali: posizione provvisoria al centro della mappa, da sistemare con i punti di controllo
    const crs = defaultCrs();
    const s0 = D.type === "pdf" ? 100 * G.PT_MM / 1000 : D.unitFile || 1;
    const c = ol.proj.transform(view.getCenter(), VIEW, crs);
    return { crs, method: D.type === "pdf" ? "rigida" : "similarita", unit: D.type === "pdf" ? 1 : s0, pdfScale: D.type === "pdf" ? 100 : null,
      T: G.placeAt(s0, 0, D.center[0], D.center[1], c[0], c[1]), points: [], source: "provvisoria", rot0: 0 };
  }

  // scala fissa (metri per unita') per la trasformazione rigida
  const scale0 = D => (D.type === "pdf" ? (D.geo.pdfScale || 100) * G.PT_MM / 1000 : D.geo.unit || 1);

  // ---------------------------------------------------------------- testo di stato del livello
  function sub(L) {
    const g = L.drawing.geo;
    const parts = [];
    if (g.source === "provvisoria" && !g.points.length) parts.push(el("span", { class: "warn" }, tr("gisdraw.da_georeferenziare")));
    else parts.push(crsName(g.crs));
    parts.push(" · ", tr("gisdraw.metodo_" + g.method) + (g.source === "geodata" ? " (GEODATA)" : ""));
    if (g.points?.length && g.method !== "coord") parts.push(" · ", tr("gisdraw.rms_0", nf(g.rms ?? 0, 3)));
    if (L.drawing.geoNote) parts.push(el("div", { class: "warn" }, L.drawing.geoNote));
    return parts;
  }
  const isProvisional = L => L.drawing?.geo.source === "provvisoria" && !L.drawing.geo.points.length;

  // ---------------------------------------------------------------- proprieta' del livello (pannello Livelli)
  function props(L) {
    const D = L.drawing;
    const box = el("div", { class: "gd-props" });
    const btns = el("div", { class: "gis-prop-btns" },
      el("button", { onclick: () => openPanel(L) }, tr("gisdraw.georeferenzia")),
      WEB ? null : el("button", { onclick: () => saveGeo(L) }, tr("gisdraw.salva_georef")));
    box.append(btns);
    if (D.type === "cad") {
      const tx = el("input", { type: "checkbox" }); tx.checked = D.showText;
      tx.addEventListener("change", () => { D.showText = tx.checked; L.ol.changed(); });
      box.append(el("label", { class: "gis-check" }, tx, tr("gisdraw.mostra_testi")));
      const list = el("div", { class: "gd-cadlayers" });
      const paint = () => {
        list.innerHTML = "";
        for (const c of D.cadLayers.values()) {
          const cb = el("input", { type: "checkbox" }); cb.checked = !c.off;
          cb.addEventListener("change", () => { c.off = !cb.checked; L.ol.changed(); });
          list.append(el("label", { title: c.name }, cb, el("span", { class: "gis-sw", style: { borderColor: hex(c.color), background: hex(c.color) } }), el("span", { class: "gd-ln" }, c.name), el("span", { class: "note" }, String(c.count))));
        }
      };
      paint();
      const all = v => { D.cadLayers.forEach(c => { c.off = !v; }); paint(); L.ol.changed(); };
      box.append(el("div", { class: "gd-cadhead" }, el("span", { class: "label" }, tr("gisdraw.layer_disegno", D.cadLayers.size)), el("span", { class: "grow" }),
        el("button", { class: "btn", onclick: () => all(true) }, tr("gisdraw.tutti")), el("button", { class: "btn", onclick: () => all(false) }, tr("gisdraw.nessuno"))), list);
    } else {
      const wc = el("input", { type: "checkbox" }); wc.checked = D.whiteClear;
      wc.addEventListener("change", async () => { D.whiteClear = wc.checked; await pdfImage(D); setPdfSource(L); });
      box.append(el("label", { class: "gis-check" }, wc, tr("gisdraw.bianco_trasparente")));
    }
    return box;
  }

  async function saveGeo(L) {
    const D = L.drawing, g = D.geo;
    const o = G.toMbgeo(baseName(L.path), { ...g, page: D.type === "pdf" ? D.page : null, pdfScale: D.type === "pdf" ? g.pdfScale : null });
    const bytes = new TextEncoder().encode(JSON.stringify(o, null, 1) + "\n");
    try {
      if (WEB) await saveBlobAs(baseName(L.path) + ".mbgeo", new Blob([bytes]), "");
      else await saveBytes(mbgeoPath(L.path), bytes);
      D.dirty = false;
      if (g.source === "provvisoria") g.source = "manuale";
      toast(tr("gisdraw.georef_salvata", baseName(L.path) + ".mbgeo"), false, 2500);
      env.changed(L);
    } catch (e) { toast(e.message, true, 6000); }
  }

  // ---------------------------------------------------------------- pannello di georeferenziazione
  let P = null; // { L, step, pending, quota, box, marks }
  const markSrc = new ol.source.Vector();
  const markLayer = new ol.layer.Vector({ source: markSrc, zIndex: 1001, style: markStyle });
  map.addLayer(markLayer);
  function markStyle(f) {
    const k = f.get("k"), n = String(f.get("n") ?? "");
    const off = f.get("off"), col = off ? "#8a8c89" : k === "d" ? "#F07D2E" : k === "q" ? "#2c6797" : "#d6336c";
    if (k === "r") return new ol.style.Style({ stroke: new ol.style.Stroke({ color: col, width: 1.5, lineDash: [4, 3] }) });
    return new ol.style.Style({
      image: k === "d" || k === "q" ? new ol.style.Circle({ radius: 6, stroke: new ol.style.Stroke({ color: col, width: 2.5 }), fill: new ol.style.Fill({ color: "rgba(255,255,255,.35)" }) })
        : new ol.style.RegularShape({ points: 4, radius: 9, radius2: 0, angle: Math.PI / 4, stroke: new ol.style.Stroke({ color: col, width: 2.5 }) }),
      text: n ? new ol.style.Text({ text: n, offsetX: 12, offsetY: -12, font: "bold 12px 'IBM Plex Sans', sans-serif", fill: new ol.style.Fill({ color: col }),
        stroke: new ol.style.Stroke({ color: "#fff", width: 3 }) }) : undefined,
    });
  }
  function drawMarks() {
    markSrc.clear();
    if (!P) return;
    const D = P.L.drawing, g = D.geo, code = P.L.code;
    const toMap = (x, y) => ol.proj.transform([x, y], code, VIEW);
    const toMapCrs = (X, Y) => ol.proj.transform([X, Y], g.crs, VIEW);
    g.points.forEach((p, i) => {
      if (![p.x, p.y].every(Number.isFinite)) return;
      const a = toMap(p.x, p.y);
      markSrc.addFeature(new ol.Feature({ geometry: new ol.geom.Point(a), k: "d", n: i + 1, off: p.off }));
      if ([p.X, p.Y].every(Number.isFinite)) {
        const b = toMapCrs(p.X, p.Y);
        markSrc.addFeature(new ol.Feature({ geometry: new ol.geom.Point(b), k: "m", off: p.off }));
        markSrc.addFeature(new ol.Feature({ geometry: new ol.geom.LineString([a, b]), k: "r", off: p.off }));
      }
    });
    if (P.pending) markSrc.addFeature(new ol.Feature({ geometry: new ol.geom.Point(toMap(P.pending[0], P.pending[1])), k: "d", n: g.points.length + 1 }));
    (P.quota || []).forEach(q => markSrc.addFeature(new ol.Feature({ geometry: new ol.geom.Point(toMap(q[0], q[1])), k: "q" })));
  }

  // vertice piu' vicino (entro 12 px) negli elementi dei livelli indicati (ricerca nell'indice spaziale delle sorgenti:
  // non dipende dal disegno a schermo)
  function snap(coord, list) {
    const tol = 12 * view.getResolution(), box = [coord[0] - tol, coord[1] - tol, coord[0] + tol, coord[1] + tol];
    let best = null, bd = tol * tol;
    // prima i punti notevoli dei disegni (entita' PUNTO)
    for (const Lx of list) {
      if (!Lx.visible || !Lx.drawing?.nodes?.length) continue;
      for (const [x, y, l] of Lx.drawing.nodes) {
        if (Lx.drawing.cadLayers.get(l)?.off) continue;
        const q = ol.proj.transform([x, y], Lx.code, VIEW), d = (q[0] - coord[0]) ** 2 + (q[1] - coord[1]) ** 2;
        if (d < bd) { bd = d; best = q; }
      }
    }
    if (best) return best;
    for (const Lx of list) {
      if (!Lx.visible || !Lx.source) continue;
      Lx.source.forEachFeatureIntersectingExtent(box, f => {
        const g = f.getGeometry();
        if (!g || g.getType() === "Point" && f.get("testo")) return;
        if (Lx.drawing?.cadLayers?.get(f.get("layer"))?.off) return;
        const fc = g.getFlatCoordinates(), st = g.getStride();
        for (let i = 0; i < fc.length; i += st) {
          const dx = fc[i] - coord[0], dy = fc[i + 1] - coord[1], d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = [fc[i], fc[i + 1]]; }
        }
      });
    }
    return best;
  }

  function openPanel(L) {
    if (P && P.L === L) return;
    closePanel();
    P = { L, step: 0, pending: null, quota: null, start: JSON.stringify(L.drawing.geo) };
    P.box = el("div", { class: "gd-panel" });
    env.mapBox.append(P.box);
    env.setTool("georef");
    renderPanel();
    drawMarks();
  }
  function closePanel() {
    if (!P) return;
    const L = P.L;
    if (JSON.stringify(L.drawing.geo) !== P.start && !WEB) { L.drawing.dirty = true; toast(tr("gisdraw.ricorda_salvare"), false, 4000); }
    P.box.remove();
    P = null;
    markSrc.clear();
    env.setTool("select");
    env.message("");
  }

  function setStep(step) {
    if (!P) return;
    P.step = step;
    if (step !== 2) P.pending = null;
    if (step < 3) P.quota = null;
    renderPanel(); drawMarks();
  }

  function refit() {
    const L = P.L, D = L.drawing, g = D.geo;
    if (g.method === "coord") {
      const u = g.unit || 1;
      if (g.source !== "geodata") g.T = [u, 0, 0, 0, u, 0];
      Object.assign(g, G.residuals(g.T, g.points));
    } else {
      const on = g.points.filter(p => !p.off && [p.x, p.y, p.X, p.Y].every(Number.isFinite));
      let r = G.fit(g.method, g.points, { scale0: scale0(D), rot0: g.rot0 || 0 });
      g.fitNote = "";
      if (r.error === "pochi" && on.length) {
        // non bastano ancora i punti: si sposta il disegno tenendo scala e rotazione attuali
        r = G.fit("rigida", g.points, { scale0: g.method === "rigida" ? scale0(D) : G.scaleOf(g.T), rot0: on.length === 1 ? (g.method === "rigida" ? g.rot0 || 0 : G.rotationOf(g.T)) : 0 });
        g.fitNote = tr("gisdraw.servono_punti", G.MIN_POINTS[g.method]);
      }
      if (r.error && r.error !== "pochi") g.fitNote = tr("gisdraw.punti_" + r.error);
      if (!r.error) { g.T = r.T; g.res = r.res; g.rms = r.rms; } else Object.assign(g, G.residuals(g.T, g.points));
    }
    if (g.points.length && g.source === "provvisoria") g.source = "manuale";
    apply(L);
    renderPanel(); drawMarks();
  }

  function onMapClick(e) {
    if (!P) return false;
    const L = P.L, D = L.drawing, g = D.geo;
    if (!P.step) return true;
    let c = e.coordinate;
    if (P.step === 1 || P.step >= 3) {
      let p = ol.proj.transform(c, VIEW, L.code);
      if (L.kind === "vector") {
        const tol = 12 * view.getResolution() * D.cosLat / (G.scaleOf(g.T) || 1);
        let node = null, bd = tol * tol;
        for (const [x, y, l] of D.nodes || []) { const d = (x - p[0]) ** 2 + (y - p[1]) ** 2; if (d < bd && !D.cadLayers.get(l)?.off) { bd = d; node = [x, y]; } }
        if (node) p = node;
        else { const s2 = snap(c, [L]); if (s2) p = ol.proj.transform(s2, VIEW, L.code); }
      }
      if (P.step === 1) { P.pending = p; P.step = 2; }
      else if (P.step === 3) { P.quota = [p]; P.step = 4; }
      else { P.quota.push(p); quotaAsk(); return true; }
    } else if (P.step === 2) {
      c = snap(c, env.layers.filter(x => x !== L && x.kind === "vector")) || c;
      const X = ol.proj.transform(c, VIEW, g.crs);
      g.points.push({ x: P.pending[0], y: P.pending[1], X: X[0], Y: X[1] });
      P.pending = null; P.step = 1;
      refit();
      return true;
    }
    renderPanel(); drawMarks();
    return true;
  }

  async function quotaAsk() {
    const D = P.L.drawing, [a, b] = P.quota, dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
    P.step = 0; renderPanel(); drawMarks();
    if (!(dist > 0)) { P.quota = null; return; }
    const inp = el("input", { type: "number", class: "field", step: "any", min: 0 });
    const v = await modal(tr("gisdraw.quota_nota"), el("div", { class: "gis-dialog" }, el("p", {}, tr("gisdraw.quota_spiega")),
      el("label", { class: "gis-form" }, tr("gisdraw.distanza_reale_m"), inp)), [{ label: tr("common.annulla"), value: null }, { label: common("applica"), primary: true, value: () => +inp.value }]);
    P.quota = null;
    if (!(v > 0)) { drawMarks(); return; }
    const g = D.geo, s = v / dist;
    if (D.type === "pdf") g.pdfScale = s * 1000 / G.PT_MM; else g.unit = s;
    if (g.method === "coord" || g.method === "similarita" && g.points.filter(p => !p.off).length < 2) g.method = "rigida";
    // senza punti: la scala nuova si applica attorno al centro della vista
    if (!g.points.length) { const c = ol.proj.transform(view.getCenter(), VIEW, g.crs); const o = G.apply(G.invert(g.T), c[0], c[1]); g.T = G.placeAt(s, G.rotationOf(g.T), o[0], o[1], c[0], c[1]); apply(P.L); }
    refit();
  }
  const common = k => tr("common." + k);

  function moveHere() {
    const L = P.L, D = L.drawing, g = D.geo;
    if (g.source === "provvisoria" && !g.points.length) g.crs = defaultCrs(); // fuso UTM del luogo scelto
    const c = ol.proj.transform(view.getCenter(), VIEW, g.crs);
    g.points = [];
    if (g.method === "coord") g.method = D.type === "pdf" ? "rigida" : "similarita";
    const s = g.method === "rigida" ? scale0(D) : G.scaleOf(g.T);
    g.T = G.placeAt(s, G.rotationOf(g.T), D.center[0], D.center[1], c[0], c[1]);
    g.res = []; g.rms = 0;
    if (g.source === "provvisoria") g.source = "manuale";
    apply(L);
    const ext = env.layerExtent(L);
    if (ext) env.fitExtent(ext, 21);
    renderPanel(); drawMarks();
  }

  function changeCrs(code) {
    const g = P.L.drawing.geo;
    if (code === g.crs) return;
    if (g.method !== "coord") {
      // i punti sulla mappa restano gli stessi luoghi: si convertono nel sistema nuovo
      const tf = ol.proj.getTransform(g.crs, code);
      g.points.forEach(p => { if ([p.X, p.Y].every(Number.isFinite)) [p.X, p.Y] = tf([p.X, p.Y]); });
      if (!g.points.length) { // posizione attuale conservata
        const c = tf(G.apply(g.T, P.L.drawing.center[0], P.L.drawing.center[1]));
        g.T = G.placeAt(G.scaleOf(g.T), G.rotationOf(g.T), P.L.drawing.center[0], P.L.drawing.center[1], c[0], c[1]);
      }
    }
    g.crs = code;
    refit();
  }

  function renderPanel() {
    if (!P) return;
    const L = P.L, D = L.drawing, g = D.geo, box = P.box;
    box.innerHTML = "";
    const row = (label, ...c) => el("label", { class: "gis-prop" }, el("span", {}, label), ...c);
    const crsSel = el("select", { class: "field" }, projected().map(c => el("option", { value: "EPSG:" + c.code }, `${c.name} · ${c.code}`)));
    if (![...crsSel.options].some(o => o.value === g.crs)) crsSel.prepend(el("option", { value: g.crs }, crsName(g.crs)));
    crsSel.value = g.crs;
    crsSel.addEventListener("change", () => changeCrs(crsSel.value));
    const mSel = el("select", { class: "field" }, METHODS.filter(m => D.type === "cad" || m !== "coord").map(m => el("option", { value: m }, tr("gisdraw.metodo_" + m) + (m === "coord" && g.source === "geodata" ? " (GEODATA)" : ""))));
    mSel.value = g.method;
    mSel.addEventListener("change", () => { g.method = mSel.value; refit(); });
    const head = el("div", { class: "gd-head" }, el("b", {}, tr("gisdraw.titolo")), el("span", { class: "gd-name", title: L.name }, L.name),
      el("button", { class: "btn", title: common("chiudi"), onclick: () => closePanel() }, "×"));
    box.append(head, row(tr("gisdraw.sistema"), crsSel), row(tr("gisdraw.metodo"), mSel));
    // scala: unita' del disegno o scala della tavola
    if (D.type === "cad") {
      const uSel = el("select", { class: "field" }, G.UNIT_CHOICES.map(([n, v]) => el("option", { value: v }, n)));
      const known = G.UNIT_CHOICES.find(([, v]) => Math.abs(v - g.unit) < 1e-12);
      if (!known) uSel.prepend(el("option", { value: g.unit }, `${nf(g.unit, 6)} m`));
      uSel.value = String(known ? known[1] : g.unit);
      uSel.addEventListener("change", () => { g.unit = +uSel.value; if (g.source === "geodata") g.source = "manuale"; refit(); });
      box.append(row(tr("gisdraw.unita"), uSel, D.unitFile ? el("span", { class: "note" }, tr("gisdraw.dal_file")) : el("span", { class: "note warn" }, tr("gisdraw.non_indicate"))));
    } else {
      const sc = el("input", { type: "number", class: "num", min: 1, step: "any", value: +(+g.pdfScale || 100).toPrecision(8) });
      sc.addEventListener("change", () => { if (+sc.value > 0) { g.pdfScale = +sc.value; refit(); } });
      box.append(row(tr("gisdraw.scala_tavola"), el("span", { class: "gd-scale" }, "1 : ", sc)));
    }
    if (g.method === "rigida") {
      const rot = el("input", { type: "number", class: "num", step: "any", value: +(g.rot0 || 0).toFixed(4) });
      rot.addEventListener("change", () => { g.rot0 = +rot.value || 0; refit(); });
      box.append(row(tr("gisdraw.rotazione"), rot, el("span", { class: "note" }, tr("gisdraw.rotazione_nota"))));
    }
    const on = (s, b) => { if (P.step === s) b.classList.add("on"); return b; };
    box.append(el("div", { class: "gis-prop-btns gd-actions" },
      on(1, el("button", { onclick: () => setStep(P.step === 1 || P.step === 2 ? 0 : 1), title: tr("gisdraw.aggiungi_punti_tip") }, tr("gisdraw.aggiungi_punti"))),
      on(3, el("button", { onclick: () => setStep(P.step >= 3 ? 0 : 3), title: tr("gisdraw.quota_nota_tip") }, tr("gisdraw.quota_nota"))),
      el("button", { onclick: () => moveHere(), title: tr("gisdraw.sposta_qui_tip") }, tr("gisdraw.sposta_qui"))));
    const hint = P.step === 1 ? tr("gisdraw.passo_disegno", g.points.length + 1) : P.step === 2 ? tr("gisdraw.passo_mappa", g.points.length + 1)
      : P.step === 3 ? tr("gisdraw.passo_quota1") : P.step === 4 ? tr("gisdraw.passo_quota2")
      : g.source === "provvisoria" && !g.points.length ? tr("gisdraw.istruzioni") : "";
    if (hint) box.append(el("p", { class: "gd-hint" }, hint));
    // punti di controllo
    if (g.points.length) {
      const tbl = el("table", { class: "gd-pts" }, el("tr", {}, el("th", {}, "#"), el("th", {}, tr("gisdraw.disegno_xy")), el("th", {}, tr("gisdraw.mappa_en")), el("th", {}, tr("gisdraw.scarto")), el("th", {}, "")));
      g.points.forEach((p, i) => {
        const use = el("input", { type: "checkbox", title: tr("gisdraw.usa_punto") }); use.checked = !p.off;
        use.addEventListener("change", () => { p.off = !use.checked; refit(); });
        const num = (k) => {
          const inp = el("input", { type: "number", step: "any", class: "num", value: Number.isFinite(p[k]) ? +p[k].toFixed(3) : "" });
          inp.addEventListener("change", () => { p[k] = inp.value === "" ? NaN : +inp.value; refit(); });
          return inp;
        };
        const r = g.res?.[i];
        tbl.append(el("tr", { class: p.off ? "off" : "" }, el("td", {}, use, String(i + 1)),
          el("td", { class: "gd-dxy" }, nf(p.x, 3), el("br"), nf(p.y, 3)),
          el("td", {}, num("X"), num("Y")),
          el("td", { class: "n" + (r && g.rms && r.r > 3 * g.rms && g.points.length > 3 ? " warn" : "") }, r ? nf(r.r, 3) + " m" : "—"),
          el("td", {}, el("button", { class: "btn", title: tr("gisdraw.elimina_punto"), onclick: () => { g.points.splice(i, 1); refit(); } }, "×"))));
      });
      box.append(el("div", { class: "gd-ptswrap" }, tbl));
    }
    const s = G.scaleOf(g.T), rot = G.rotationOf(g.T);
    const used = g.points.filter(p => !p.off).length;
    const sum = [D.type === "pdf" ? tr("gisdraw.scala_risultante", nf(s * 1000 / G.PT_MM, 1)) : tr("gisdraw.unita_risultante", nf(s, 6)),
      tr("gisdraw.rotazione_risultante", nf(rot, 4))];
    if (g.method === "affine") { const sx = Math.hypot(g.T[0], g.T[3]), sy = Math.hypot(g.T[1], g.T[4]); sum.push(tr("gisdraw.scale_xy", nf(sx, 6), nf(sy, 6))); }
    if (used && g.method !== "coord") sum.push(tr("gisdraw.rms_punti", nf(g.rms ?? 0, 3), used));
    box.append(el("div", { class: "gd-sum" }, sum.map(x => el("div", {}, x))));
    if (g.fitNote) box.append(el("p", { class: "gd-hint warn" }, g.fitNote));
    const op = el("input", { type: "range", min: 0, max: 1, step: 0.05, value: L.opacity ?? 1 });
    op.addEventListener("input", () => { L.opacity = +op.value; L.ol.setOpacity(L.opacity); });
    box.append(row(tr("gisdraw.opacita"), op));
    box.append(el("div", { class: "gis-prop-btns" },
      g.points.length ? el("button", { onclick: () => { g.points = []; refit(); } }, tr("gisdraw.togli_punti")) : null,
      el("span", { class: "grow" }),
      WEB ? null : el("button", { class: "primary", onclick: () => saveGeo(L) }, tr("gisdraw.salva_georef"))));
    env.message(P.step ? hint : "");
  }

  const onKey = e => {
    if (!P || e.key !== "Escape") return false;
    if (P.step) setStep(0); else closePanel();
    return true;
  };

  return {
    read, apply, props, sub, openPanel, closePanel, onMapClick, onKey, isProvisional, saveGeo,
    get panelLayer() { return P?.L || null; },
    layerRemoved(L) { if (P?.L === L) closePanel(); if (L.drawing?.url) URL.revokeObjectURL(L.drawing.url); },
    setSource: setPdfSource,
  };
}
