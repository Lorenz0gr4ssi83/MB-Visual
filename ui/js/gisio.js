// Lettura e scrittura dei formati GIS per ui/js/viewers/gis.js.
// Shapefile (.shp/.shx/.dbf/.prj/.cpg, anche in zip) e DBF: lettore e scrittore propri (specifica ESRI 1998).
// GeoJSON/TopoJSON, KML/KMZ, GPX: formati di OpenLayers. GeoPackage: tabelle via api sqlite_query + WKB di OpenLayers.
// GeoTIFF: geotiff.js (anche file .tfw/.prj accanto). Ogni lettore restituisce livelli con geometrie nel sistema del file.
import { api, fileUrl, readBytes, WEB } from "./core.js";
import { codeFromGeoKeys, codeFromPrj } from "./giscrs.js";

const td = (enc = "utf-8") => { try { return new TextDecoder(enc); } catch { return new TextDecoder("windows-1252"); } };

// ---------------------------------------------------------------- DBF
function dbfEncoding(cpg, ldid) {
  const c = String(cpg || "").trim().toLowerCase().replace(/^ansi\s*/, "");
  if (c) {
    if (/utf-?8/.test(c)) return "utf-8";
    if (/^(cp|windows-?)?125\d$/.test(c)) return "windows-" + c.match(/125\d/)[0];
    if (/8859.?(\d+)/.test(c)) return "iso-8859-" + c.match(/8859.?(\d+)/)[1];
    if (/^(cp)?866$/.test(c)) return "ibm866";
    try { new TextDecoder(c); return c; } catch { /* */ }
  }
  const byLdid = { 0x57: "windows-1252", 0x03: "windows-1252", 0x58: "windows-1252", 0x59: "windows-1252", 0x64: "ibm866", 0x65: "ibm866",
    0xc8: "windows-1250", 0xc9: "windows-1251", 0xca: "windows-1254", 0xcb: "windows-1253", 0x01: "windows-1252", 0x02: "windows-1252" };
  return byLdid[ldid] || null;
}

export function readDbf(buf, cpg) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = dv.getUint32(4, true), hlen = dv.getUint16(8, true), rlen = dv.getUint16(10, true);
  let enc = dbfEncoding(cpg, buf[29]);
  if (!enc) { // nessuna indicazione: UTF-8 se valido, altrimenti Windows-1252 (il caso tipico dei file italiani)
    try { new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, Math.min(buf.length, hlen + rlen * 5000))); enc = "utf-8"; } catch { enc = "windows-1252"; }
  }
  const dec = td(enc);
  const fields = [];
  let pos = 1;
  for (let o = 32; o + 32 <= hlen && buf[o] !== 0x0d; o += 32) {
    let e = 0; while (e < 11 && buf[o + e]) e++;
    const f = { name: dec.decode(buf.subarray(o, o + e)).trim(), type: String.fromCharCode(buf[o + 11]), len: buf[o + 16], dec: buf[o + 17], pos };
    if (f.type === "C" && f.dec) f.len += f.dec * 256; // campi testo lunghi (estensione Clipper/Visual FoxPro)
    pos += f.len;
    fields.push(f);
  }
  const names = new Set();
  for (const f of fields) { let k = f.name || "campo", i = 1; while (names.has(k)) k = `${f.name}_${++i}`; names.add(k); f.key = k; }
  const rows = new Array(n);
  for (let r = 0; r < n; r++) {
    const off = hlen + r * rlen;
    if (off + rlen > buf.length) { rows.length = r; break; }
    const row = {};
    for (const f of fields) {
      const a = off + f.pos, b = a + f.len;
      let v;
      switch (f.type) {
        case "N": case "F": {
          let s = ""; for (let i = a; i < b; i++) s += String.fromCharCode(buf[i]);
          s = s.trim();
          v = s === "" || /^\*+$/.test(s) ? null : Number(s.replace(",", "."));
          if (Number.isNaN(v)) v = s;
          break;
        }
        case "D": { let s = ""; for (let i = a; i < b; i++) s += String.fromCharCode(buf[i]); s = s.trim(); v = /^\d{8}$/.test(s) && s !== "00000000" ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : null; break; }
        case "L": { const c = String.fromCharCode(buf[a]).toUpperCase(); v = "TY".includes(c) ? true : "FN".includes(c) ? false : null; break; }
        case "I": v = dv.getInt32(a, true); break;
        case "O": v = dv.getFloat64(a, true); break;
        default: v = dec.decode(buf.subarray(a, b)).replace(/[\s\0]+$/, "");
      }
      row[f.key] = v;
    }
    rows[r] = row;
  }
  return { rows, fields: fields.map(f => ({ name: f.key, type: f.type, len: f.len, dec: f.dec })), encoding: enc };
}

// ---------------------------------------------------------------- SHP
const ringArea = r => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return s / 2; }; // > 0 = orario
function inRing(p, r) {
  let ins = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
// anelli di un poligono shapefile: esterni in senso orario, buchi antiorari; ogni buco va nell'esterno che lo contiene
function assemblePolygons(rings) {
  const outers = [], holes = [];
  for (const r of rings) { if (r.length < 4) continue; (ringArea(r) >= 0 ? outers : holes).push(r); }
  if (!outers.length) return holes.map(h => [h]);
  const polys = outers.map(o => [o]);
  for (const h of holes) {
    const p = polys.find(pl => inRing(h[0], pl[0])) || (polys.length === 1 ? polys[0] : null);
    if (p) p.push(h); else polys.push([h.slice().reverse()]);
  }
  return polys;
}

export function readShp(ol, buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getInt32(0, false) !== 9994) throw new Error("Il file .shp non e' uno shapefile valido");
  const end = Math.min(buf.length, dv.getInt32(24, false) * 2);
  const geoms = [];
  let o = 100;
  while (o + 8 <= end) {
    const clen = dv.getInt32(o + 4, false) * 2;
    const c = o + 8;
    o = c + clen;
    if (clen < 4 || o > buf.length) { if (clen >= 4) break; geoms.push(null); continue; }
    const t = dv.getInt32(c, true);
    const hasZ = [11, 13, 15, 18, 31].includes(t);
    const pt = i => [dv.getFloat64(i, true), dv.getFloat64(i + 8, true)];
    if (t === 0) { geoms.push(null); continue; }
    if (t === 1 || t === 11 || t === 21) {
      const p = pt(c + 4);
      if (t === 11) p.push(dv.getFloat64(c + 20, true));
      geoms.push(Number.isFinite(p[0]) ? new ol.geom.Point(p, hasZ ? "XYZ" : "XY") : null);
      continue;
    }
    if (t === 8 || t === 18 || t === 28) {
      const np = dv.getInt32(c + 36, true);
      const pts = []; for (let i = 0; i < np; i++) pts.push(pt(c + 40 + i * 16));
      if (hasZ) { const zo = c + 40 + np * 16 + 16; for (let i = 0; i < np; i++) pts[i].push(dv.getFloat64(zo + i * 8, true)); }
      geoms.push(new ol.geom.MultiPoint(pts, hasZ ? "XYZ" : "XY"));
      continue;
    }
    if ([3, 13, 23, 5, 15, 25, 31].includes(t)) {
      const nParts = dv.getInt32(c + 36, true), np = dv.getInt32(c + 40, true);
      let po = c + 44;
      const parts = []; for (let i = 0; i < nParts; i++) parts.push(dv.getInt32(po + i * 4, true));
      po += nParts * 4;
      if (t === 31) po += nParts * 4; // MultiPatch: tipi delle parti
      const pts = []; for (let i = 0; i < np; i++) pts.push(pt(po + i * 16));
      if (hasZ) { const zo = po + np * 16 + 16; if (zo + np * 8 <= o) for (let i = 0; i < np; i++) pts[i].push(dv.getFloat64(zo + i * 8, true)); else pts.forEach(p => p.push(0)); }
      const lines = parts.map((s, i) => pts.slice(s, i + 1 < parts.length ? parts[i + 1] : np));
      const L = hasZ ? "XYZ" : "XY";
      if (t === 3 || t === 13 || t === 23) geoms.push(lines.length === 1 ? new ol.geom.LineString(lines[0], L) : new ol.geom.MultiLineString(lines, L));
      else { const polys = assemblePolygons(lines); geoms.push(polys.length === 1 ? new ol.geom.Polygon(polys[0], L) : new ol.geom.MultiPolygon(polys, L)); }
      continue;
    }
    geoms.push(null);
  }
  return geoms;
}

// un gruppo .shp + .dbf + .prj + .cpg (byte gia' letti) -> livello
export function shapefileLayer(ol, name, f) {
  const geoms = readShp(ol, f.shp);
  const dbf = f.dbf ? readDbf(f.dbf, f.cpg && td().decode(f.cpg)) : { rows: [], fields: [] };
  const features = geoms.map((g, i) => { const ft = new ol.Feature(dbf.rows[i] || {}); if (g) ft.setGeometry(g); return ft; });
  const prj = f.prj ? td().decode(f.prj) : null;
  return {
    name, kind: "vector", features, fields: dbf.fields.map(x => x.name), prj,
    crs: prj ? codeFromPrj(prj) || prj : null,
    note: [!f.dbf ? "senza .dbf (nessun attributo)" : null, dbf.encoding && dbf.encoding !== "utf-8" ? `attributi in ${dbf.encoding}` : null].filter(Boolean).join(" · "),
  };
}

// ---------------------------------------------------------------- scrittura shapefile
const enc8 = new TextEncoder();
function bboxOf(pts) {
  const b = [Infinity, Infinity, -Infinity, -Infinity, Infinity, -Infinity];
  for (const p of pts) { if (p[0] < b[0]) b[0] = p[0]; if (p[1] < b[1]) b[1] = p[1]; if (p[0] > b[2]) b[2] = p[0]; if (p[1] > b[3]) b[3] = p[1]; const z = p[2] || 0; if (z < b[4]) b[4] = z; if (z > b[5]) b[5] = z; }
  return b;
}
// geometria OpenLayers -> { tipo base, parti, punti }
function shpParts(g) {
  const t = g.getType();
  const c = g.getCoordinates();
  if (t === "Point") return { base: 1, pts: [c] };
  if (t === "MultiPoint") return { base: 8, pts: c };
  if (t === "LineString") return { base: 3, parts: [c] };
  if (t === "MultiLineString") return { base: 3, parts: c };
  const orient = (r, outer) => (outer === ringArea(r) >= 0 ? r : r.slice().reverse()); // esterni orari, buchi antiorari
  const polys = t === "Polygon" ? [c] : t === "MultiPolygon" ? c : null;
  if (polys) return { base: 5, parts: polys.flatMap(p => p.map((r, i) => orient(r, i === 0))) };
  return null;
}
const GEOM_GROUP = { Point: "punti", MultiPoint: "punti", LineString: "linee", MultiLineString: "linee", Polygon: "poligoni", MultiPolygon: "poligoni" };

function writeShpShx(items, base, hasZ) {
  const type = hasZ ? base + 10 : base;
  const recs = items.map(it => {
    if (!it) return new Uint8Array(4);
    const pts = it.pts || it.parts.flat();
    const n = pts.length, np = it.parts ? it.parts.length : 0;
    let size;
    if (base === 1) size = 20 + (hasZ ? 16 : 0);
    else if (base === 8) size = 40 + n * 16 + (hasZ ? 32 + n * 16 : 0);
    else size = 44 + np * 4 + n * 16 + (hasZ ? 32 + n * 16 : 0);
    const b = new Uint8Array(size), dv = new DataView(b.buffer);
    dv.setInt32(0, type, true);
    if (base === 1) { const p = pts[0]; dv.setFloat64(4, p[0], true); dv.setFloat64(12, p[1], true); if (hasZ) { dv.setFloat64(20, p[2] || 0, true); dv.setFloat64(28, 0, true); } return b; }
    const bb = bboxOf(pts);
    [bb[0], bb[1], bb[2], bb[3]].forEach((v, i) => dv.setFloat64(4 + i * 8, v, true));
    let o;
    if (base === 8) { dv.setInt32(36, n, true); o = 40; }
    else { dv.setInt32(36, np, true); dv.setInt32(40, n, true); let s = 0; it.parts.forEach((p, i) => { dv.setInt32(44 + i * 4, s, true); s += p.length; }); o = 44 + np * 4; }
    for (const p of pts) { dv.setFloat64(o, p[0], true); dv.setFloat64(o + 8, p[1], true); o += 16; }
    if (hasZ) {
      dv.setFloat64(o, bb[4], true); dv.setFloat64(o + 8, bb[5], true); o += 16;
      for (const p of pts) { dv.setFloat64(o, p[2] || 0, true); o += 8; }
      dv.setFloat64(o, 0, true); dv.setFloat64(o + 8, 0, true); o += 16; // misure M: tutte 0
      o += n * 8;
    }
    return b;
  });
  const all = items.filter(Boolean).flatMap(it => it.pts || it.parts.flat());
  const bb = all.length ? bboxOf(all) : [0, 0, 0, 0, 0, 0];
  const header = len => {
    const h = new Uint8Array(100), dv = new DataView(h.buffer);
    dv.setInt32(0, 9994, false); dv.setInt32(24, len / 2, false); dv.setInt32(28, 1000, true); dv.setInt32(32, type, true);
    [bb[0], bb[1], bb[2], bb[3], hasZ ? bb[4] : 0, hasZ ? bb[5] : 0, 0, 0].forEach((v, i) => dv.setFloat64(36 + i * 8, v, true));
    return h;
  };
  const shpLen = 100 + recs.reduce((s, r) => s + 8 + r.length, 0);
  const shp = new Uint8Array(shpLen), shx = new Uint8Array(100 + recs.length * 8);
  shp.set(header(shpLen)); shx.set(header(shx.length));
  const sdv = new DataView(shp.buffer), xdv = new DataView(shx.buffer);
  let o = 100;
  recs.forEach((r, i) => {
    xdv.setInt32(100 + i * 8, o / 2, false); xdv.setInt32(104 + i * 8, r.length / 2, false);
    sdv.setInt32(o, i + 1, false); sdv.setInt32(o + 4, r.length / 2, false);
    shp.set(r, o + 8);
    o += 8 + r.length;
  });
  return { shp, shx };
}

function writeDbf(rows, keys) {
  // nomi dei campi: massimo 10 caratteri, unici
  const used = new Set();
  const fields = keys.map(k => {
    let n = k.normalize("NFD").replace(/[^\w]/g, "_").slice(0, 10) || "CAMPO";
    for (let i = 1; used.has(n.toUpperCase()); i++) n = n.slice(0, 10 - String(i).length) + i;
    used.add(n.toUpperCase());
    const vals = rows.map(r => r[k]).filter(v => v !== null && v !== undefined && v !== "");
    if (vals.length && vals.every(v => typeof v === "boolean")) return { key: k, name: n, type: "L", len: 1, dec: 0 };
    if (vals.length && vals.every(v => typeof v === "number" && Number.isFinite(v))) {
      const dec = Math.min(8, Math.max(0, ...vals.map(v => (String(v).split(".")[1] || "").length)));
      const int = Math.max(1, ...vals.map(v => String(Math.trunc(Math.abs(v))).length + (v < 0 ? 1 : 0)));
      return { key: k, name: n, type: "N", len: Math.min(20, int + (dec ? dec + 1 : 0)), dec };
    }
    const len = Math.min(254, Math.max(1, ...vals.map(v => enc8.encode(typeof v === "object" ? JSON.stringify(v) : String(v)).length)));
    return { key: k, name: n, type: "C", len, dec: 0 };
  });
  const hlen = 32 + fields.length * 32 + 1, rlen = 1 + fields.reduce((s, f) => s + f.len, 0);
  const b = new Uint8Array(hlen + rows.length * rlen + 1), dv = new DataView(b.buffer);
  const now = new Date();
  b[0] = 3; b[1] = now.getFullYear() - 1900; b[2] = now.getMonth() + 1; b[3] = now.getDate();
  dv.setUint32(4, rows.length, true); dv.setUint16(8, hlen, true); dv.setUint16(10, rlen, true);
  fields.forEach((f, i) => {
    const o = 32 + i * 32;
    for (let j = 0; j < f.name.length; j++) b[o + j] = f.name.charCodeAt(j);
    b[o + 11] = f.type.charCodeAt(0); b[o + 16] = f.len; b[o + 17] = f.dec;
  });
  b[hlen - 1] = 0x0d;
  b.fill(0x20, hlen, hlen + rows.length * rlen);
  rows.forEach((r, i) => {
    let o = hlen + i * rlen + 1;
    for (const f of fields) {
      const v = r[f.key];
      let bytes = null;
      if (v !== null && v !== undefined && v !== "") {
        if (f.type === "N") { const s = Number(v).toFixed(f.dec); bytes = enc8.encode(s.length > f.len ? Number(v).toExponential(Math.max(0, f.len - 7)) : s.padStart(f.len)); }
        else if (f.type === "L") bytes = enc8.encode(v ? "T" : "F");
        else {
          bytes = enc8.encode(typeof v === "object" ? JSON.stringify(v) : String(v));
          if (bytes.length > f.len) { let cut = f.len; while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--; bytes = bytes.subarray(0, cut); }
        }
      }
      if (bytes) b.set(bytes.subarray(0, f.len), o);
      o += f.len;
    }
  });
  b[b.length - 1] = 0x1a;
  return b;
}

// livelli [{ name, features (geometrie gia' nel sistema di uscita) }] -> file dello zip
export function writeShapefiles(layers, wkt) {
  const files = {};
  for (const L of layers) {
    const groups = {};
    for (const f of L.features) {
      const g = f.getGeometry();
      if (!g) continue;
      const list = g.getType() === "GeometryCollection" ? g.getGeometries() : [g];
      for (const gg of list) { const k = GEOM_GROUP[gg.getType()]; if (k) (groups[k] ||= []).push([f, gg]); }
    }
    const kinds = Object.keys(groups);
    for (const k of kinds) {
      const base = (L.name || "livello").replace(/[\\/:*?"<>|]+/g, "_") + (kinds.length > 1 ? "_" + k : "");
      const items = groups[k].map(([, g]) => shpParts(g));
      const hasZ = groups[k].some(([, g]) => g.getLayout().includes("Z"));
      const shpBase = items.find(Boolean)?.base || 1;
      // punti e multipunti nello stesso file: si scrive tutto come multipunto se serve
      const sameBase = items.every(it => !it || it.base === shpBase) ? shpBase : 8;
      const norm = items.map(it => (it && sameBase === 8 && it.base === 1 ? { base: 8, pts: it.pts } : it));
      const { shp, shx } = writeShpShx(norm, sameBase, hasZ);
      const rows = groups[k].map(([f]) => props(f));
      const keys = [...new Set(rows.flatMap(r => Object.keys(r)))];
      files[base + ".shp"] = shp;
      files[base + ".shx"] = shx;
      files[base + ".dbf"] = writeDbf(rows, keys);
      files[base + ".cpg"] = enc8.encode("UTF-8");
      if (wkt) files[base + ".prj"] = enc8.encode(wkt);
    }
  }
  return files;
}

// attributi di un elemento (senza geometria e campi interni)
export function props(f) {
  const p = { ...f.getProperties() };
  delete p[f.getGeometryName()];
  for (const k of Object.keys(p)) {
    const v = p[k];
    if (k.startsWith("__") || (v && typeof v === "object" && (typeof v.getType === "function" || typeof Node !== "undefined" && v instanceof Node))) delete p[k];
  }
  return p;
}

// ---------------------------------------------------------------- testo XML / JSON
export function decodeText(bytes) {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
  const m = head.match(/encoding=["']([\w-]+)["']/i);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return td().decode(bytes.subarray(3));
  return td(m ? m[1].toLowerCase() : "utf-8").decode(bytes);
}

export function readGeoJson(ol, text, name) {
  const obj = JSON.parse(text);
  if (obj.type === "Topology") {
    const fmt = new ol.format.TopoJSON();
    return { name, kind: "vector", features: fmt.readFeatures(obj), crs: 4326 };
  }
  const crsName = obj.crs?.properties?.name || obj.crs?.properties?.code;
  const fmt = new ol.format.GeoJSON();
  const features = fmt.readFeatures(obj, { dataProjection: "EPSG:4326", featureProjection: "EPSG:4326" });
  return { name, kind: "vector", features, crs: crsName ? (/\d+$/.test(crsName) ? +crsName.match(/(\d+)$/)[1] : crsName) : 4326, crsFromFile: !!crsName };
}

export function readGpx(ol, text, name) {
  const features = new ol.format.GPX().readFeatures(text);
  for (const f of features) for (const k of ["extensions", "extensionsNode_"]) if (f.get(k) !== undefined) f.unset(k, true); // nodi XML grezzi
  return { name, kind: "vector", features, crs: 4326 };
}

export function readKml(ol, text, name, iconUrl) {
  const fmt = new ol.format.KML({ extractStyles: true, showPointNames: true, iconUrlFunction: iconUrl });
  const features = fmt.readFeatures(text);
  for (const f of features) {
    if (f.get("description") && typeof f.get("description") === "string") f.set("description", f.get("description").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    // campi interni del KML (gli stili sono gia' risolti): styleUrl conterrebbe l'indirizzo della pagina
    for (const k of ["styleUrl", "visibility", "open"]) f.unset(k, true);
  }
  return { name, kind: "vector", features, crs: 4326, fileStyles: true };
}

// KMZ: il KML principale + immagini interne (le icone diventano indirizzi blob)
export async function readKmz(ol, bytes, name, remoteIcon) {
  const zip = await window.JSZip.loadAsync(bytes);
  const files = Object.values(zip.files).filter(f => !f.dir);
  const kml = files.find(f => /(^|\/)doc\.kml$/i.test(f.name)) || files.find(f => /\.kml$/i.test(f.name));
  if (!kml) throw new Error("Il KMZ non contiene un file KML");
  const urls = new Map();
  for (const f of files) if (/\.(png|jpe?g|gif|bmp|svg)$/i.test(f.name)) urls.set(f.name.toLowerCase(), URL.createObjectURL(new Blob([await f.async("uint8array")], { type: /\.svg$/i.test(f.name) ? "image/svg+xml" : "image/" + f.name.split(".").pop().toLowerCase().replace("jpg", "jpeg") })));
  const iconUrl = href => {
    const k = decodeURIComponent(String(href || "")).replace(/^\.\//, "").toLowerCase();
    return urls.get(k) || [...urls.entries()].find(([p]) => p.endsWith("/" + k) || k.endsWith("/" + p))?.[1] || remoteIcon(href);
  };
  const L = readKml(ol, decodeText(await kml.async("uint8array")), name, iconUrl);
  L.dispose = () => urls.forEach(u => URL.revokeObjectURL(u));
  return L;
}

// zip con shapefile (uno o piu' livelli); kmz e kml dentro lo zip vengono letti anch'essi
export async function readZip(ol, bytes, remoteIcon) {
  const zip = await window.JSZip.loadAsync(bytes);
  const files = Object.values(zip.files).filter(f => !f.dir && !/(^|\/)__MACOSX\//.test(f.name));
  const byBase = new Map();
  for (const f of files) {
    const m = f.name.match(/^(.*)\.(shp|dbf|prj|cpg|shx)$/i);
    if (!m) continue;
    const k = m[1].toLowerCase();
    if (!byBase.has(k)) byBase.set(k, { name: m[1].split("/").pop() });
    byBase.get(k)[m[2].toLowerCase()] = f;
  }
  const layers = [];
  for (const g of byBase.values()) {
    if (!g.shp) continue;
    const parts = {};
    for (const k of ["shp", "dbf", "prj", "cpg"]) if (g[k]) parts[k] = await g[k].async("uint8array");
    layers.push(shapefileLayer(ol, g.name, parts));
  }
  for (const f of files) {
    const nm = f.name.split("/").pop().replace(/\.[^.]+$/, "");
    if (/\.(geo)?json$/i.test(f.name)) layers.push(readGeoJson(ol, decodeText(await f.async("uint8array")), nm));
    else if (/\.kml$/i.test(f.name)) layers.push(readKml(ol, decodeText(await f.async("uint8array")), nm, remoteIcon));
    else if (/\.gpx$/i.test(f.name)) layers.push(readGpx(ol, decodeText(await f.async("uint8array")), nm));
  }
  if (!layers.length) throw new Error("Lo zip non contiene shapefile (.shp) o altri dati GIS");
  return layers;
}

// .shp aperto dal disco: i file accanto (.dbf, .prj, .cpg) con lo stesso nome
export async function readShapefileFromDisk(ol, path, name) {
  const base = path.replace(/\.[^.\\/]+$/, "");
  const tryRead = async ext => {
    for (const e of [ext, ext.toUpperCase()]) { try { const b = await readBytes(base + "." + e); if (b && b.length) return b; } catch { /* */ } }
    return null;
  };
  const shp = await readBytes(path);
  const parts = { shp, dbf: await tryRead("dbf"), prj: await tryRead("prj"), cpg: await tryRead("cpg") };
  const L = shapefileLayer(ol, name.replace(/\.[^.]+$/, ""), parts);
  if (!parts.dbf && WEB) L.note = "nella web app i file accanto (.dbf, .prj) non sono leggibili: apri lo zip dello shapefile";
  return L;
}

// ---------------------------------------------------------------- GeoPackage
export async function readGpkg(ol, path) {
  const q = async sql => (await api("sqlite_query", { path }, { json: { sql, limit: 10000000 } }));
  let cols;
  try {
    cols = await q("SELECT c.table_name, c.column_name, c.srs_id, s.organization, s.organization_coordsys_id, s.definition, t.identifier FROM gpkg_geometry_columns c LEFT JOIN gpkg_spatial_ref_sys s ON s.srs_id = c.srs_id LEFT JOIN gpkg_contents t ON t.table_name = c.table_name");
  } catch { throw new Error("Il file non e' un GeoPackage (manca la tabella gpkg_geometry_columns)"); }
  const wkb = new ol.format.WKB();
  const layers = [];
  for (const [table, gcol, srsId, org, orgId, def, ident] of cols.righe) {
    const info = await q(`PRAGMA table_info("${table.replace(/"/g, '""')}")`);
    const names = info.righe.map(r => r[1]).filter(n => n !== gcol);
    const sel = names.map(n => `"${n.replace(/"/g, '""')}"`).concat([`hex("${gcol.replace(/"/g, '""')}")`]).join(", ");
    const r = await q(`SELECT ${sel} FROM "${table.replace(/"/g, '""')}"`);
    const features = r.righe.map(row => {
      const p = {};
      names.forEach((n, i) => { const v = row[i]; p[n] = v && typeof v === "object" ? `[BLOB ${v.blob} byte]` : v; });
      const f = new ol.Feature(p);
      const hex = row[names.length];
      if (hex && hex.startsWith("4750")) {
        const flags = parseInt(hex.substr(6, 2), 16);
        const env = [0, 32, 48, 48, 64][(flags >> 1) & 7] || 0;
        if (!(flags & 16)) { try { f.setGeometry(wkb.readGeometry(hex.slice((8 + env) * 2))); } catch { /* geometria non leggibile */ } }
      }
      return f;
    });
    let crs = null;
    if (srsId === 0 || srsId === -1) crs = srsId === 0 ? 4326 : null;
    else if (String(org || "").toLowerCase() === "epsg" && orgId) crs = codeFromPrj(def) || orgId;
    else crs = codeFromPrj(def) || def;
    layers.push({ name: ident || table, kind: "vector", features, fields: names, crs });
  }
  let tiles = 0;
  try { tiles = (await q("SELECT COUNT(*) FROM gpkg_contents WHERE data_type IN ('tiles','2d-gridded-coverage')")).righe[0][0]; } catch { /* */ }
  if (tiles && layers[0]) layers[0].note = `${tiles} livelli raster del GeoPackage non mostrati`;
  if (!layers.length) throw new Error(tiles ? "Il GeoPackage contiene solo livelli raster (tessere), non ancora supportati" : "Il GeoPackage non contiene livelli vettoriali");
  return layers;
}

// ---------------------------------------------------------------- GeoTIFF
export const COLORMAPS = {
  grigi: [[0, [0, 0, 0]], [1, [255, 255, 255]]],
  terreno: [[0, [38, 115, 77]], [0.2, [104, 166, 92]], [0.4, [231, 218, 130]], [0.6, [190, 140, 85]], [0.8, [140, 110, 95]], [1, [250, 250, 250]]],
  spettro: [[0, [43, 131, 186]], [0.25, [171, 221, 164]], [0.5, [255, 255, 191]], [0.75, [253, 174, 97]], [1, [215, 25, 28]]],
  calore: [[0, [0, 0, 4]], [0.35, [120, 28, 109]], [0.65, [237, 105, 37]], [1, [252, 255, 164]]],
};
function ramp(name) {
  const stops = COLORMAPS[name] || COLORMAPS.grigi, lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0; while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, c0] = stops[k], [t1, c1] = stops[k + 1], u = (t - t0) / (t1 - t0 || 1);
    for (let j = 0; j < 3; j++) lut[i * 3 + j] = Math.round(c0[j] + (c1[j] - c0[j]) * Math.max(0, Math.min(1, u)));
  }
  return lut;
}

// banda singola -> canvas con scala colori e trasparenza dei "nessun dato"
export function paintBand(R) {
  const { width: w, height: h, band, nodata } = R;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d"), img = ctx.createImageData(w, h), d = img.data;
  const lut = ramp(R.colormap), lo = R.min, k = 255 / ((R.max - R.min) || 1);
  for (let i = 0; i < band.length; i++) {
    const v = band[i];
    if (!(v === v) || v === nodata) { d[i * 4 + 3] = 0; continue; }
    const t = Math.max(0, Math.min(255, Math.round((v - lo) * k))) * 3;
    d[i * 4] = lut[t]; d[i * 4 + 1] = lut[t + 1]; d[i * 4 + 2] = lut[t + 2]; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function stats(band, nodata) {
  const s = [];
  const step = Math.max(1, Math.floor(band.length / 200000));
  for (let i = 0; i < band.length; i += step) { const v = band[i]; if (v === v && v !== nodata && Number.isFinite(v)) s.push(v); }
  if (!s.length) return { min: 0, max: 1, p2: 0, p98: 1 };
  s.sort((a, b) => a - b);
  return { min: s[0], max: s[s.length - 1], p2: s[Math.floor(s.length * 0.02)], p98: s[Math.floor(s.length * 0.98)] };
}

async function worldFile(path) {
  const base = path.replace(/\.[^.\\/]+$/, ""), ext = path.split(".").pop().toLowerCase();
  for (const e of [ext[0] + ext[ext.length - 1] + "w", ext + "w", "wld", "tfw"]) {
    try {
      const t = td().decode(await readBytes(base + "." + e)).trim().split(/\s+/).map(Number);
      if (t.length >= 6 && t.every(Number.isFinite)) return t;
    } catch { /* */ }
  }
  return null;
}

export async function readGeoTiff(path, name, maxDim = 2048) {
  const G = window.GeoTIFF;
  const tiff = WEB ? await G.fromArrayBuffer((await readBytes(path)).buffer) : await G.fromUrl(fileUrl(path), { allowFullFile: true, maxRanges: 0 });
  const main = await tiff.getImage(0);
  const W = main.getWidth(), H = main.getHeight();
  let extent = null;
  try { extent = main.getBoundingBox(); } catch { /* senza georeferenziazione interna */ }
  let crs = null;
  try { crs = codeFromGeoKeys(main.getGeoKeys()); } catch { /* */ }
  let note = "";
  if (!WEB && !extent) {
    const wf = await worldFile(path);
    if (wf) {
      const [a, , , e, c, f] = wf; // C, F = centro della cella in alto a sinistra; E negativo
      const x0 = c - a / 2, y0 = f - e / 2, x1 = x0 + a * W, y1 = y0 + e * H;
      extent = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
      note = "georeferenziato dal file world (.tfw)";
    }
  }
  if (!WEB && !crs) {
    try { crs = codeFromPrj(td().decode(await readBytes(path.replace(/\.[^.\\/]+$/, ".prj")))); } catch { /* */ }
  }
  if (!extent) throw new Error("Il TIFF non e' georeferenziato (nessuna coordinata interna ne' file .tfw accanto): aprilo come immagine");
  const k = Math.min(1, maxDim / Math.max(W, H));
  const w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
  // immagine piu' piccola (panoramica dei COG) che basta per la risoluzione voluta
  let img = main;
  const n = await tiff.getImageCount();
  for (let i = 1; i < n; i++) {
    const im = await tiff.getImage(i);
    if (im.fileDirectory.NewSubfileType & 4) continue; // maschere
    if (im.getWidth() >= w && im.getWidth() < img.getWidth()) img = im;
  }
  const fd = main.fileDirectory;
  const spp = main.getSamplesPerPixel(), bps = fd.BitsPerSample?.[0] || 8, photo = fd.PhotometricInterpretation;
  const nodata = main.getGDALNoData();
  const R = { name, kind: "raster", crs, extent, width: w, height: h, srcWidth: W, srcHeight: H, bands: spp, note,
    info: { bit: bps, formato: fd.SampleFormat?.[0] === 3 ? "virgola mobile" : "intero", compressione: fd.Compression } };
  if ((photo === 2 || photo === 6 || photo === 3) && bps <= 8) {
    const rgb = await img.readRGB({ width: w, height: h, enableAlpha: true, interleave: true });
    const ch = rgb.length / (w * h);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d"), id = ctx.createImageData(w, h);
    for (let i = 0, j = 0; i < w * h; i++, j += ch) { id.data[i * 4] = rgb[j]; id.data[i * 4 + 1] = rgb[j + 1]; id.data[i * 4 + 2] = rgb[j + 2]; id.data[i * 4 + 3] = ch === 4 ? rgb[j + 3] : 255; }
    if (nodata !== null && ch === 3) for (let i = 0; i < w * h; i++) if (id.data[i * 4] === nodata && id.data[i * 4 + 1] === nodata && id.data[i * 4 + 2] === nodata) id.data[i * 4 + 3] = 0;
    ctx.putImageData(id, 0, 0);
    R.canvas = c; R.rgb = true;
    return R;
  }
  const rasters = await img.readRasters({ width: w, height: h, samples: spp >= 3 ? [0, 1, 2] : [0] });
  if (spp >= 3) {
    // multibanda non RGB a 8 bit (es. 16 bit RGBN): bande 1-2-3 con stiramento 2-98%
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d"), id = ctx.createImageData(w, h);
    for (let b = 0; b < 3; b++) {
      const s = stats(rasters[b], nodata), k2 = 255 / ((s.p98 - s.p2) || 1);
      for (let i = 0; i < w * h; i++) id.data[i * 4 + b] = Math.max(0, Math.min(255, (rasters[b][i] - s.p2) * k2));
    }
    for (let i = 0; i < w * h; i++) id.data[i * 4 + 3] = nodata !== null && rasters[0][i] === nodata ? 0 : 255;
    ctx.putImageData(id, 0, 0);
    R.canvas = c; R.rgb = true;
    return R;
  }
  const band = rasters[0];
  const s = stats(band, nodata);
  Object.assign(R, { band, nodata, stat: s, min: s.p2, max: s.p98, colormap: "grigi" });
  R.canvas = paintBand(R);
  return R;
}

// valore del raster (banda singola) in una coordinata del suo sistema
export function rasterValue(R, x, y) {
  if (!R.band) return null;
  const [x0, y0, x1, y1] = R.extent;
  const i = Math.floor((x - x0) / (x1 - x0) * R.width), j = Math.floor((y1 - y) / (y1 - y0) * R.height);
  if (i < 0 || j < 0 || i >= R.width || j >= R.height) return null;
  const v = R.band[j * R.width + i];
  return v === R.nodata || !(v === v) ? null : v;
}

// ---------------------------------------------------------------- riconoscimento (usato da app.js per scegliere il visualizzatore)
// TIFF con chiavi GeoTIFF (ModelPixelScale, ModelTiepoint, ModelTransformation, GeoKeyDirectory) nella prima IFD
export async function isGeoTiff(readRange) {
  const h = await readRange(0, 65535);
  if (h.length < 16) return false;
  const le = h[0] === 0x49 && h[1] === 0x49;
  if (!le && !(h[0] === 0x4d && h[1] === 0x4d)) return false;
  const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
  const ver = dv.getUint16(2, le), big = ver === 43;
  if (ver !== 42 && !big) return false;
  const off = big ? Number(dv.getBigUint64(8, le)) : dv.getUint32(4, le);
  let ifd = h, base = off;
  if (off + 4096 > h.length) { ifd = await readRange(off, off + 65535); base = 0; } else base = off;
  const d2 = new DataView(ifd.buffer, ifd.byteOffset, ifd.byteLength);
  const n = big ? Number(d2.getBigUint64(base, le)) : d2.getUint16(base, le);
  const size = big ? 20 : 12, start = base + (big ? 8 : 2);
  for (let i = 0; i < Math.min(n, 400); i++) {
    const o = start + i * size;
    if (o + 2 > ifd.length) break;
    const tag = d2.getUint16(o, le);
    if (tag === 33550 || tag === 33922 || tag === 34264 || tag === 34735) return true;
  }
  return false;
}

// elenco di un archivio zip: contiene shapefile (e quasi solo dati GIS)?
const SHP_PARTS = /\.(shp|shx|dbf|prj|cpg|qpj|sbn|sbx|xml|qmd|qml|sld|txt|pdf|html?|kml|geojson|gpx)$/i;
export function isGisZip(items) {
  const files = (items || []).filter(i => !i.dir && !/(^|\/)__MACOSX\//.test(i.path));
  return files.some(i => /\.shp$/i.test(i.path)) && files.filter(i => SHP_PARTS.test(i.path)).length >= files.length * 0.7;
}
