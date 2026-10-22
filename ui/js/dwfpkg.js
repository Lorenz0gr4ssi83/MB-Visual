// Apertura dei pacchetti Autodesk DWF / DWFx (e XPS): elenco dei fogli e dei modelli, costruzione dei fogli 2D in un
// modello unico (coordinate della carta, y verso l'alto), proprieta' degli oggetti, marcature, unita' di misura.
// Formati: DWF 6.x (zip dopo l'intestazione "(DWF V06.xx)"), DWF fino a 5.5 (un solo flusso W2D), DWFx (OPC/XPS),
// XPS semplici. Scritto da zero dalle specifiche pubbliche (DWF 6 / ePlot / eModel, WHIP!, XPS).
import { loadScript } from "./core.js";
import { parseW2D } from "./w2d.js";
import { parseFixedPage, resolveUri, deobfuscateFont, mul, apply } from "./xpspage.js";

const MM_PER = { mm: 1, in: 25.4, inch: 25.4, inches: 25.4 };
const xmlDoc = t => new DOMParser().parseFromString(t, "application/xml");
const kids = (e, n) => (e ? [...e.children].filter(c => c.localName === n) : []);
const kid = (e, n) => (e ? [...e.children].find(c => c.localName === n) : null);
const all = (e, n) => (e ? [...e.getElementsByTagName("*")].filter(c => c.localName === n) : []);
const at = (e, n) => (e?.getAttribute ? e.getAttribute(n) ?? [...e.attributes].find(a => a.localName === n)?.value ?? null : null);
const norm = p => decodeURIComponent(String(p || "").replace(/\\/g, "/").split("?")[0]).replace(/^\/+/, "");
const nums = s => (String(s || "").match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number);

/** matrice 4x4 DWF (vettori riga, traslazione nell'ultima riga) -> affine 2D [a,b,c,d,e,f] */
export function affineOf4x4(v) {
  if (!v || v.length < 16) return null;
  return [v[0], v[1], v[4], v[5], v[12], v[13]];
}
const det = M => M[0] * M[3] - M[1] * M[2];
const scaleOf = M => Math.sqrt(Math.abs(det(M))) || 1;
const invert = M => { const d = det(M) || 1; return [M[3] / d, -M[1] / d, -M[2] / d, M[0] / d, (M[2] * M[5] - M[3] * M[4]) / d, (M[1] * M[4] - M[0] * M[5]) / d]; };

// ---------------------------------------------------------------- proprieta'
function propsOf(el) {
  // proprieta' dirette di un elemento (anche dentro un <Properties> figlio) + riferimenti ad altri gruppi
  const out = [], refs = [];
  const take = p => out.push({ cat: at(p, "category") || "", name: at(p, "name") || "", value: at(p, "value") ?? "" });
  for (const c of el.children) {
    if (c.localName === "Property") take(c);
    else if (c.localName === "Properties") { for (const p of kids(c, "Property")) take(p); refs.push(...String(at(c, "refs") || "").split(/\s+/).filter(Boolean)); }
  }
  refs.push(...String(at(el, "refs") || "").split(/\s+/).filter(Boolean));
  return { props: out, refs };
}

/** ObjectDefinition (DWF 6.0, ePlot/eModel): nodo grafico -> { label, props } */
export function parseObjectDefinition(text) {
  const doc = xmlDoc(text);
  const sets = new Map(), objects = new Map(), byNode = new Map();
  // gruppi di proprieta' con id (al primo livello del documento)
  for (const p of kids(doc.documentElement, "Properties")) { const id = at(p, "id"); if (id) sets.set(id, propsOf({ children: [p] }).props); }
  for (const o of all(doc, "Object")) objects.set(at(o, "id"), { el: o, ...propsOf(o) });
  const resolve = (list, refs, seen = new Set()) => {
    const out = [...list];
    for (const r of refs) if (!seen.has(r) && sets.has(r)) { seen.add(r); out.push(...sets.get(r)); }
    return out;
  };
  for (const inst of all(doc, "Instance")) {
    const own = propsOf(inst);
    const obj = objects.get(at(inst, "object"));
    const props = resolve(own.props, own.refs);
    if (obj) props.push(...resolve(obj.props, obj.refs));
    const name = props.find(p => p.name === "_name")?.value || at(inst, "object") || "";
    for (const n of String(at(inst, "nodes") || "").split(/\s+/).filter(Boolean)) byNode.set(+n, { label: name, props, id: at(inst, "id") });
  }
  return byNode;
}

/** content.xml (DWF 6.2+ / DWFx): oggetti ed entita' globali */
export function parseContent(text) {
  const doc = xmlDoc(text);
  const entities = new Map(), objects = new Map(), sets = new Map();
  for (const e of all(doc, "Entity")) entities.set(at(e, "id"), { label: at(e, "label") || "", ...propsOf(e) });
  for (const s of [...all(doc, "PropertySet"), ...all(doc, "SharedProperty")]) if (at(s, "id")) sets.set(at(s, "id"), propsOf(s).props);
  for (const o of all(doc, "Object")) {
    const parent = o.parentElement?.localName === "Object" ? at(o.parentElement, "id") : null;
    objects.set(at(o, "id"), { label: at(o, "label") || "", entityRef: at(o, "entityRef"), parent, ...propsOf(o) });
  }
  return { entities, objects, sets };
}
/** content definition di una sezione: nodo -> oggetto del content.xml */
export function parseSectionContent(text, content) {
  const doc = xmlDoc(text), byNode = new Map();
  for (const i of all(doc, "Instance")) {
    const ref = at(i, "renderableRef"), node = at(i, "node") ?? at(i, "nodes");
    if (node === null) continue;
    const o = content?.objects.get(ref);
    let props = [], label = ref;
    if (o) {
      label = o.label || label;
      props = [...o.props];
      for (const r of o.refs) if (content.sets.has(r)) props.push(...content.sets.get(r));
      const e = content.entities.get(o.entityRef);
      if (e) { props.push(...e.props); for (const r of e.refs) if (content.sets.has(r)) props.push(...content.sets.get(r)); }
    }
    for (const n of String(node).split(/\s+/).filter(Boolean)) byNode.set(+n, { label, props, id: ref });
  }
  return byNode;
}

// ---------------------------------------------------------------- pacchetto
async function jszip() { await loadScript("/vendor/jszip/dist/jszip.min.js"); return window.JSZip; }

/**
 * Apre un file DWF / DWFx / XPS / W2D.
 * Restituisce { kind, title, props, sheets: [{ id, title, kind:"2d"|"3d"|"data", thumb, load() }], read(path), text(path) }
 */
export async function openPackage(bytes, fileName = "") {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 16));
  const zipAt = bytes[0] === 0x50 && bytes[1] === 0x4b ? 0 : head.startsWith("(DWF V") && bytes[12] === 0x50 && bytes[13] === 0x4b ? 12 : -1;
  if (zipAt < 0) {
    // DWF fino alla 5.5 o W2D isolato: un solo foglio
    if (!/^\((DWF|W2D) V/.test(head)) throw new Error("Il file non e' un DWF/DWFx riconoscibile");
    const title = fileName.replace(/\.[^.]+$/, "") || "Foglio";
    return { kind: "w2d", title, props: [], sheets: [{ id: "1", title, kind: "2d", load: () => buildW2DSheet(title, [{ bytes, role: "2d streaming graphics" }], null, {}) }] };
  }
  const JSZip = await jszip();
  // gli offset dello zip DWF contano anche l'intestazione "(DWF V06.00)": si passa il file intero (JSZip riconosce i
  // byte iniziali aggiunti); se non riesce si riprova senza intestazione
  let zip;
  try { zip = await JSZip.loadAsync(bytes); } catch (e) { if (!zipAt) throw e; zip = await JSZip.loadAsync(bytes.subarray(zipAt)); }
  const files = new Map();
  zip.forEach((p, f) => { if (!f.dir) files.set(norm(p).toLowerCase(), f); });
  const read = async p => { const f = files.get(norm(p).toLowerCase()); return f ? new Uint8Array(await f.async("uint8array")) : null; };
  const text = async p => { const b = await read(p); return b ? decodeXml(b) : null; };
  const pkg = { kind: "dwf6", title: fileName.replace(/\.[^.]+$/, ""), props: [], sheets: [], read, text, files };

  // DWFx: sequenza di documenti DWF (manifesti); XPS semplice: sequenza di FixedDocument
  let manifests = [];
  if (files.has("manifest.xml")) manifests = ["manifest.xml"];
  else if (files.has("dwfdocumentsequence.dwfseq")) {
    pkg.kind = "dwfx";
    const seq = xmlDoc(await text("DWFDocumentSequence.dwfseq"));
    manifests = all(seq, "ManifestReference").map(r => norm(at(r, "Source")));
  }
  if (!manifests.length) {
    // XPS (o DWFx senza manifesto): le pagine della FixedDocumentSequence
    pkg.kind = "xps";
    const rels = await text("_rels/.rels");
    let fdseq = "FixedDocumentSequence.fdseq";
    if (rels) { const r = all(xmlDoc(rels), "Relationship").find(x => /fixedrepresentation/i.test(at(x, "Type"))); if (r) fdseq = norm(at(r, "Target")); }
    const seq = await text(fdseq);
    if (!seq) throw new Error("Nel pacchetto non ci sono ne' fogli DWF ne' pagine XPS");
    let n = 0;
    for (const d of all(xmlDoc(seq), "DocumentReference")) {
      const fdoc = resolveUri("/" + norm(fdseq), at(d, "Source"));
      const fd = await text(fdoc);
      if (!fd) continue;
      for (const pc of all(xmlDoc(fd), "PageContent")) {
        const pageUri = resolveUri(fdoc, at(pc, "Source"));
        const k = ++n;
        pkg.sheets.push({ id: "p" + k, title: "Pagina " + k, kind: "2d", load: () => buildXpsSheet(pkg, "Pagina " + k, pageUri, null) });
      }
    }
    return pkg;
  }

  for (const man of manifests) {
    const mdoc = xmlDoc(await text(man));
    const root = mdoc.documentElement;
    for (const p of kids(kid(root, "Properties"), "Property")) pkg.props.push({ cat: "", name: at(p, "name"), value: at(p, "value") });
    // content.xml globale (6.2+)
    let content = null;
    const cRef = all(root, "Content")[0];
    const contentP = cRef ? (async () => { const t = await text(resolveRef(man, at(cRef, "href"))); return t ? parseContent(t) : null; })() : Promise.resolve(null);
    const getContent = async () => (content ??= await contentP);
    const sections = kids(kid(root, "Sections"), "Section");
    for (const s of sections) {
      const type = at(s, "type") || "", name = at(s, "name") || "", title = at(s, "title") || name;
      const res = kids(kid(s, "Toc"), "Resource").map(r => ({ role: at(r, "role") || "", mime: at(r, "mime") || "", href: resolveRef(man, at(r, "href")) }));
      const thumb = res.find(r => r.role === "thumbnail") || res.find(r => r.role === "icon");
      const sec = { name, type, title, res, man };
      if (/ePlot$/i.test(type)) pkg.sheets.push({ id: name, title, kind: "2d", thumb: thumb?.href, load: () => buildEPlotSheet(pkg, sec, getContent) });
      else if (/eModel$/i.test(type)) pkg.sheets.push({ id: name, title, kind: "3d", thumb: thumb?.href, section: sec, getContent });
      else if (/Data$/i.test(type) && res.some(r => /content presentation/i.test(r.role))) pkg.sheets.push({ id: name, title, kind: "data", thumb: thumb?.href, section: sec, getContent });
    }
  }
  // ordine di stampa dei fogli 2D (plotOrder del descrittore), se disponibile senza leggere tutto
  return pkg;
}
function resolveRef(manifest, href) {
  if (!href) return "";
  href = href.replace(/\\/g, "/");
  if (href.startsWith("/")) return norm(href) + (href.includes("?") ? "?" + href.split("?")[1] : "");
  const dir = manifest.includes("/") ? manifest.slice(0, manifest.lastIndexOf("/") + 1) : "";
  return dir + href;
}
function decodeXml(b) {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b);
  return new TextDecoder("utf-8").decode(b);
}

// ---------------------------------------------------------------- foglio: modello comune
function newSheet(title) {
  return {
    title, kind: "2d", paper: null, prims: [], clips: [], layers: new Map(), objects: new Map(), markups: [],
    units: [], fonts: new Map(), images: new Map(), meta: {}, props: [], bbox: null, warnings: [], urls: [],
  };
}
function addLayer(sheet, name) {
  if (!name) return "";
  let L = sheet.layers.get(name);
  if (!L) sheet.layers.set(name, (L = { name, on: true, count: 0 }));
  L.count++;
  return name;
}

// trasformazione delle primitive W2D (coordinate logiche) nel foglio
function addW2D(sheet, parsed, T, opts) {
  const { prims, info } = parsed;
  const k = scaleOf(T);
  const clipMap = new Map();
  const clipIdx = vp => {
    if (!vp) return null;
    if (!clipMap.has(vp)) { sheet.clips.push({ rings: vp.rings.map(r => xfRing(r, T)), rule: "evenodd", parent: null }); clipMap.set(vp, sheet.clips.length - 1); }
    return clipMap.get(vp);
  };
  for (const p of prims) {
    const layer = addLayer(sheet, p.layer ? info.layers.get(p.layer) || "Layer " + p.layer : opts.layer || "");
    const obj = p.node ? opts.objKey(p.node) : null;
    const base = { layer, obj, mk: opts.markup ? (obj || opts.markup) : null, clip: clipIdx(p.clip), url: p.url || null };
    if (p.t === "p") {
      sheet.prims.push({
        t: "p", rings: p.rings.map(r => xfRing(r, T)), closed: p.closed, fill: p.fill, rule: p.nonzero ? "nonzero" : "evenodd", color: p.color,
        lw: (p.lw || 0) * k, dash: p.dash ? { px: p.dash.map(v => v * (p.dashScale || 1)) } : null, cap: p.cap, join: p.join, ...base,
      });
    } else if (p.t === "x") {
      const h = p.h || 0;
      if (!p.s.trim() && !p.bounds) continue;
      // da spazio testo (em, y in su, origine sulla linea di base) a coordinate logiche
      const c = Math.cos(p.rot), s = Math.sin(p.rot), ws = p.ws || 1, sh = Math.tan(p.obl || 0);
      let L = [c * h * ws, s * h * ws, -s * h + c * h * sh, c * h + s * h * sh, p.x, p.y];
      if (p.flags & 2) L = mul(L, [-1, 0, 0, 1, 0, 0]);
      if (p.flags & 4) L = mul(L, [1, 0, 0, -1, 0, 0]);
      const fam = p.font || "Arial";
      if (p.flags & 1) L = [c * h, s * h, -s * h, c * h, p.x, p.y]; // testo verticale: lettere impilate, senza fattore di larghezza
      else if (p.bounds && p.bounds.length >= 8 && !p.s.includes("\n")) {
        // riquadro del testo (P0->P1 linea di base, P0->P3 verso l'alto): orientamento e larghezza reali
        const b = p.bounds, bx = b[2] - b[0], by = b[3] - b[1], ux = b[6] - b[0], uy = b[7] - b[1];
        const Lb = Math.hypot(bx, by), Hu = Math.hypot(ux, uy), em = h || Hu;
        const W = measureEm(p.s, p.font, p.bold, p.italic);
        if (Lb > 0 && Hu > 0 && W > 0) { const sx = Lb / W; L = [bx / Lb * sx, by / Lb * sx, ux / Hu * em, uy / Hu * em, p.x, p.y]; }
      }
      sheet.prims.push({ t: "x", m: mul(T, L), s: p.s, font: fam, bold: p.bold, italic: p.italic, color: p.color, hidden: p.hidden || !h, bounds: p.bounds ? xfRing(p.bounds, T) : null, sp: p.sp, vertical: !!(p.flags & 1), ...base });
    } else if (p.t === "m") {
      const [x, y] = apply(T, p.x, p.y);
      sheet.prims.push({ t: "m", x, y, color: p.color, ...base });
    } else if (p.t === "i") {
      const key = "w2d:" + sheet.images.size;
      if (p.bytes) sheet.images.set(key, { bytes: p.bytes, mime: p.mime });
      else if (p.rgba) sheet.images.set(key, { rgba: p.rgba });
      sheet.prims.push({ t: "i", m: mul(T, [p.x2 - p.x1, 0, 0, -(p.y2 - p.y1), p.x1, p.y2]), src: key, placeholder: p.mime === "image/tiff", ...base });
    }
  }
}
// larghezza di una stringa in em con il carattere indicato (misura del browser)
let MEAS = null;
function measureEm(s, font, bold, italic) {
  try {
    MEAS ||= document.createElement("canvas").getContext("2d");
    const f = String(font || "Arial").replace(/^@/, "");
    MEAS.font = `${italic ? "italic " : ""}${bold ? "bold " : ""}100px ${/^[\w-]+$/.test(f) ? f : `"${f}"`}, Arial, sans-serif`;
    return MEAS.measureText(s).width / 100;
  } catch { return s.length * 0.6; }
}
function xfRing(r, T) {
  const out = new Float64Array(r.length);
  for (let i = 0; i < r.length; i += 2) { out[i] = T[0] * r[i] + T[2] * r[i + 1] + T[4]; out[i + 1] = T[1] * r[i] + T[3] * r[i + 1] + T[5]; }
  return out;
}

function finish(sheet) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  for (const p of sheet.prims) {
    if (p.t === "p") for (const r of p.rings) for (let i = 0; i < r.length; i += 2) add(r[i], r[i + 1]);
    else if (p.t === "x" && !p.hidden) add(p.m[4], p.m[5]);
    else if (p.t === "m") add(p.x, p.y);
    else if (p.t === "i") { add(p.m[4], p.m[5]); add(p.m[0] + p.m[2] + p.m[4], p.m[1] + p.m[3] + p.m[5]); }
  }
  const ink = isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 100, 100];
  sheet.ink = ink;
  sheet.bbox = sheet.paper ? [0, 0, sheet.paper.w, sheet.paper.h] : ink;
  // oggetti: indice delle primitive di ciascuno
  sheet.prims.forEach((p, i) => {
    if (p.obj) { const o = sheet.objects.get(p.obj); if (o) (o.prims ||= []).push(i); }
  });
  // marcature senza definizione (flussi di marcatura privi di nodi): una voce per flusso
  const known = new Set(sheet.markups.map(m => m.key));
  for (const p of sheet.prims) if (p.mk && !known.has(p.mk)) { known.add(p.mk); sheet.markups.push({ key: p.mk, label: "Marcatura " + (sheet.markups.length + 1), props: [] }); }
  for (const m of sheet.markups) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    sheet.prims.forEach((p, i) => {
      if (p.mk !== m.key) return;
      (m.prims ||= []).push(i);
      if (p.t === "p") for (const r of p.rings) for (let k = 0; k < r.length; k += 2) { a = Math.min(a, r[k]); c = Math.max(c, r[k]); b = Math.min(b, r[k + 1]); d = Math.max(d, r[k + 1]); }
      else if (p.t === "x") { a = Math.min(a, p.m[4]); c = Math.max(c, p.m[4]); b = Math.min(b, p.m[5]); d = Math.max(d, p.m[5]); }
    });
    m.bbox = isFinite(a) ? [a, b, c, d] : null;
  }
  return sheet;
}

// unita' del disegno: matrice Units (applicazione -> logico) e trasformazione logico -> carta
function unitsEntry(name, m4, T, region, label) {
  const U = affineOf4x4(m4);
  if (!U || !det(U)) return null;
  const toDrawing = invert(mul(T, U)); // carta -> disegno
  return { name: unitName(name), raw: name || "", toDrawing, perPaper: 1 / (scaleOf(U) * scaleOf(T)), region, label: label || "" };
}
function unitName(n) {
  const s = String(n || "").toLowerCase().trim();
  if (!s || s === "undefined" || s === "''") return "";
  if (/^feet and inches/.test(s)) return "ftin"; // unita' architettoniche di AutoCAD: valori in pollici, mostrati come 12'-6"
  if (/^ft/.test(s)) return "ft";
  if (/^(inch|inches|in)$/.test(s)) return "in";
  if (/^(millimet|mm)/.test(s)) return "mm";
  if (/^(centimet|cm)/.test(s)) return "cm";
  if (/^(meter|metre|m)$/.test(s) || /^(meters|metres)$/.test(s)) return "m";
  if (/^(feet|foot)$/.test(s)) return "ft";
  return n;
}

// ---------------------------------------------------------------- DWF fino alla 5.5 / W2D isolato
async function buildW2DSheet(title, streams, descriptor, extra) {
  const sheet = newSheet(title);
  for (const s of streams) {
    const parsed = parseW2D(s.bytes);
    sheet.warnings.push(...parsed.info.warnings);
    const pi = parsed.info.plotInfo;
    let T = s.T;
    if (!T) {
      if (pi && pi.m && pi.m.length >= 9 && pi.w) {
        // PlotInfo: matrice 3x3 logico -> carta
        T = [pi.m[0], pi.m[1], pi.m[3], pi.m[4], pi.m[6], pi.m[7]];
        const u = String(pi.units).toLowerCase() === "mm" ? "mm" : "in";
        sheet.paper = { w: pi.rot % 180 ? pi.h : pi.w, h: pi.rot % 180 ? pi.w : pi.h, units: u, color: [255, 255, 255], show: pi.show !== "hide" };
      } else T = [1, 0, 0, 1, 0, 0];
    }
    if (s.role === "2d streaming graphics") {
      Object.assign(sheet.meta, parsed.info.meta);
      if (parsed.info.units?.m) { const u = unitsEntry(parsed.info.units.name, parsed.info.units.m, T, null, ""); if (u) sheet.units.push(u); }
      for (const vp of parsed.info.viewports) if (vp.units?.m) { const u = unitsEntry(vp.units.name, vp.units.m, T, vp.rings.map(r => xfRing(r, T)), vp.name); if (u) sheet.units.push(u); }
      if (parsed.info.background && !sheet.paper) sheet.bg = parsed.info.background;
    }
    const markup = /markup/i.test(s.role) ? "mk:" + streams.indexOf(s) : null;
    const nodeInfo = s.objects || new Map();
    const resKey = streams.indexOf(s);
    const objKey = node => {
      const key = resKey + ":" + node;
      if (!sheet.objects.has(key)) {
        const inf = nodeInfo.get(node);
        const nm = parsed.info.nodes.get(node);
        if (!inf && !nm && !markup) return null;
        sheet.objects.set(key, { key, label: (markup && inf?.props.find(p => p.name === "Label")?.value) || inf?.label || nm || "Oggetto " + node, props: inf?.props || [], markup: !!markup });
        if (markup) sheet.markups.push({ key, label: inf?.props.find(p => p.name === "Label")?.value || inf?.label || "Marcatura", props: inf?.props || [] });
      }
      return key;
    };
    addW2D(sheet, parsed, T, { objKey, markup, layer: markup ? "Marcature" : "" });
  }
  Object.assign(sheet, extra || {});
  return finish(sheet);
}

// ---------------------------------------------------------------- DWF 6: foglio ePlot
async function buildEPlotSheet(pkg, sec, getContent) {
  const dres = sec.res.find(r => r.role === "descriptor");
  const dtext = dres ? await pkg.text(dres.href) : null;
  const ddoc = dtext ? xmlDoc(dtext) : null;
  const page = ddoc?.documentElement;
  const paperEl = page ? all(page, "Paper")[0] : null;
  const paper = paperEl ? { w: +at(paperEl, "width"), h: +at(paperEl, "height"), units: /mm/i.test(at(paperEl, "units") || "") ? "mm" : "in", color: nums(at(paperEl, "color") || "255 255 255"), show: at(paperEl, "show") !== "false" } : null;
  const props = page ? all(kid(page, "Properties") || page, "Property").filter(p => at(p, "category") !== "hidden").map(p => ({ cat: at(p, "category") || "", name: at(p, "name"), value: at(p, "value") || "" })) : [];
  // risorse dal descrittore (hanno trasformazione e ritaglio); se manca il descrittore, quelle del manifesto
  const dres2 = page ? all(page, "GraphicResource").concat(all(page, "ImageResource"), all(page, "Resource"), all(page, "FontResource"))
    .map(r => ({ el: r, kind: r.localName, role: at(r, "role") || "", mime: at(r, "mime") || "", href: resolveRef(sec.man, at(r, "href")), T: affineOf4x4(nums(at(r, "transform"))), id: at(r, "objectId"), parent: at(r, "parentObjectId"), internalId: at(r, "internalId") }))
    : sec.res.map(r => ({ ...r, T: null }));
  const content = await getContent();
  const objDefs = new Map(); // id della risorsa grafica -> mappa dei nodi
  let defaultDef = null, markupDef = null;
  for (const r of dres2) {
    if (/object definition/i.test(r.role) || /content definition/i.test(r.role)) {
      const t = await pkg.text(r.href);
      if (!t) continue;
      const m = /content definition/i.test(r.role) ? parseSectionContent(t, content) : parseObjectDefinition(t);
      if (/markup/i.test(r.role)) { markupDef = markupDef || new Map(); for (const [k, v] of m) markupDef.set(k, v); }
      else if (r.parent) objDefs.set(r.parent, m); else defaultDef = defaultDef ? new Map([...defaultDef, ...m]) : m;
    }
  }
  const fp = dres2.find(r => /fixedpage/i.test(r.mime));
  if (fp) return buildXpsSheet(pkg, sec.title, "/" + norm(fp.href), { page, paper, props, dres: dres2, objDefs, defaultDef, markupDef });
  const streams = [];
  for (const r of dres2) {
    if (!/x-w2d/i.test(r.mime)) continue;
    const bytes = await pkg.read(r.href);
    if (!bytes) continue;
    streams.push({ bytes, role: r.role, T: r.T, objects: /markup/i.test(r.role) ? markupDef : objDefs.get(r.id) || defaultDef });
  }
  if (!streams.length) throw new Error("Il foglio non contiene grafica 2D leggibile");
  // le grafiche principali prima delle marcature
  streams.sort((a, b) => (/markup/i.test(a.role) ? 1 : 0) - (/markup/i.test(b.role) ? 1 : 0));
  const sheet = await buildW2DSheet(sec.title, streams, page, { paper: paper || undefined, props });
  // immagini raster sovrapposte (non le miniature)
  for (const r of dres2) {
    if (r.kind !== "ImageResource" || /thumbnail|preview|icon/i.test(r.role)) continue;
    const bytes = await pkg.read(r.href);
    if (!bytes || !r.T) continue;
    const ex = nums(at(r.el, "extents"));
    const key = "res:" + r.href;
    sheet.images.set(key, { bytes, mime: r.mime });
    const w = ex.length >= 4 ? ex[2] - ex[0] : 1, h = ex.length >= 4 ? ex[3] - ex[1] : 1;
    const M = mul(r.T, [w, 0, 0, -h, ex[0] || 0, (ex[1] || 0) + h]);
    sheet.prims.unshift({ t: "i", m: M, src: key, layer: "", obj: null });
  }
  return finish(sheet);
}

// ---------------------------------------------------------------- DWFx / XPS: foglio da FixedPage
async function buildXpsSheet(pkg, title, pageUri, d) {
  const xml = await pkg.text(pageUri);
  if (!xml) throw new Error("Pagina non trovata nel pacchetto: " + pageUri);
  const getText = async u => pkg.text(u);
  const fp = await parseFixedPage(xml, pageUri, getText);
  const sheet = newSheet(title);
  const paper = d?.paper || { w: fp.width * 25.4 / 96, h: fp.height * 25.4 / 96, units: "mm", color: [255, 255, 255], show: true };
  const k = (paper.units === "mm" ? 25.4 : 1) / 96;
  // se il descrittore indica un formato diverso dalla pagina XPS, si scala sulla pagina
  const W = fp.width * k, H = fp.height * k;
  sheet.paper = { ...paper, w: W, h: H };
  sheet.props = d?.props || [];
  const P = [k, 0, 0, -k, 0, H]; // pagina (1/96", y in giu') -> carta (y in su)

  // W2X: attributi (layer, nodi, unita') associati ai nomi degli elementi
  const ext = new Map(); // refName -> [elementi RenditionSync/altro]
  let unitsList = [];
  const resInfo = new Map(); // internalId -> risorsa del descrittore
  for (const r of d?.dres || []) if (r.internalId) resInfo.set(r.internalId, r);
  for (const r of d?.dres || []) {
    if (!/graphics extension/i.test(r.role)) continue;
    const t = await pkg.text(r.href);
    if (!t) continue;
    const w = xmlDoc(t).documentElement;
    for (const e of w.children) {
      const rn = at(e, "refName");
      if (!rn) continue;
      if (!ext.has(rn)) ext.set(rn, []);
      ext.get(rn).push(e);
    }
  }
  // stato degli attributi lungo la pagina
  let layer = "", node = 0, url = null, res = null, resRole = "", vp = null;
  const nodeNames = new Map();
  const viewports = [];
  const objKey = n => {
    if (!n) return null;
    const def = resRole && /markup/i.test(resRole) ? d?.markupDef : (d?.objDefs.get(resInfo.get(res)?.id) || d?.defaultDef);
    const key = (res || "") + ":" + n;
    if (!sheet.objects.has(key)) {
      const inf = def?.get(n);
      const nm = nodeNames.get(n);
      const markup = /markup/i.test(resRole);
      if (!inf && !nm && !markup) return null;
      sheet.objects.set(key, { key, label: (markup && inf?.props.find(p => p.name === "Label")?.value) || inf?.label || nm || "Oggetto " + n, props: inf?.props || [], markup });
      if (markup) sheet.markups.push({ key, label: inf?.props.find(p => p.name === "Label")?.value || inf?.label || "Marcatura", props: inf?.props || [] });
    }
    return key;
  };
  const applyExt = name => {
    for (const e of ext.get(name) || []) {
      if (e.localName === "Units") unitsList.push({ name: at(e, "Label"), m: nums(at(e, "Transform")), label: "" });
      if (e.localName !== "RenditionSync") continue;
      for (const a of e.children) {
        switch (a.localName) {
          case "Layer": layer = at(a, "Name") || ""; break;
          case "Object_Node": node = +at(a, "Number") || 0; if (at(a, "Name")) nodeNames.set(node, at(a, "Name")); break;
          case "URL": { const items = kids(a, "Item").map(i => ({ href: at(i, "Address"), name: at(i, "Friendly_Name") || at(i, "Address") })); url = items.length ? items : null; break; }
          case "Viewport":
            if (at(a, "Transform")) { viewports.push({ name: at(a, "Name") || "", m: nums(at(a, "Transform")), label: at(a, "Label") }); vp = viewports.length - 1; }
            else vp = null;
            break;
          case "Visibility": break;
          default: break;
        }
      }
    }
  };
  const clipMap = new Map();
  const clipIdx = c => {
    if (c === null || c === undefined) return null;
    if (!clipMap.has(c)) {
      const src = fp.clips[c];
      sheet.clips.push({ rings: src.rings.map(r => xfRing(r, P)), rule: src.rule, parent: src.parent === null || src.parent === undefined ? null : clipIdx(src.parent) });
      clipMap.set(c, sheet.clips.length - 1);
    }
    return clipMap.get(c);
  };
  const usedFonts = new Map();
  for (const p of fp.prims) {
    if (p.t === "r") { res = p.name; resRole = resInfo.get(p.name)?.role || ""; layer = ""; node = 0; url = null; vp = null; if (ext.has(p.name)) applyExt(p.name); continue; }
    if (p.name) applyExt(p.name);
    if (p.t === "g") continue;
    const markup = /markup/i.test(resRole);
    const base = { layer: addLayer(sheet, markup ? "Marcature" : layer), obj: objKey(node), clip: clipIdx(p.clip), url, vp };
    base.mk = markup ? base.obj || "mk:" + res : null;
    if (p.t === "p") {
      sheet.prims.push({ t: "p", rings: p.rings.map(r => xfRing(r, P)), closed: p.closed, fill: p.fill, rule: p.fillRule === "nonzero" ? "nonzero" : "evenodd", color: p.color, grad: p.gradient ? xfGrad(p.gradient, P) : null, lw: (p.lw || 0) * k, dash: p.dash ? { world: p.dash.world.map(v => v * k), offset: (p.dash.offset || 0) * k } : null, cap: p.cap, join: p.join, ...base });
    } else if (p.t === "x") {
      const fam = await fontFamily(pkg, p.fontUri, usedFonts);
      sheet.prims.push({ t: "x", m: mul(P, p.m), s: p.s, adv: p.adv, rtl: p.rtl, font: fam, bold: p.bold, italic: p.italic, color: p.color, ...base });
    } else if (p.t === "i") {
      const key = "xps:" + p.uri;
      if (!sheet.images.has(key)) { const b = await pkg.read(p.uri); if (b) sheet.images.set(key, { bytes: b, mime: mimeOf(p.uri) }); }
      sheet.prims.push({ t: "i", m: mul(P, p.m), src: key, viewbox: p.viewbox, opacity: p.opacity, ...base });
    }
  }
  sheet.fonts = usedFonts;
  // unita' del disegno: trasformazione logico -> carta dal descrittore della grafica principale
  const main = (d?.dres || []).find(r => r.role === "2d streaming graphics");
  let T = main?.T;
  if (!T && main?.internalId && fp.resources[main.internalId]) T = mul(P, fp.resources[main.internalId]);
  if (T) {
    for (const u of unitsList) { const e = unitsEntry(u.name, u.m, T, null, ""); if (e) sheet.units.push(e); }
    // riquadri (viewport): ogni elemento ricorda il suo (p.vp -> indice in sheet.vpUnits) per misurare con la scala giusta
    sheet.vpUnits = viewports.map(v => unitsEntry(v.label, v.m, T, null, v.name));
    if (viewports.length === 1 && sheet.vpUnits[0]) sheet.units.unshift(sheet.vpUnits[0]);
  }
  return finish(sheet);
}
function xfGrad(g, P) {
  const o = { ...g };
  if (g.p0) { o.p0 = apply(P, ...g.p0); o.p1 = apply(P, ...g.p1); }
  if (g.c) { o.c = apply(P, ...g.c); o.o = apply(P, ...g.o); o.r = g.r * Math.abs(P[0]); }
  return o;
}
const mimeOf = u => (/\.png$/i.test(u) ? "image/png" : /\.jpe?g$/i.test(u) ? "image/jpeg" : /\.tiff?$/i.test(u) ? "image/tiff" : /\.wdp|\.jxr$/i.test(u) ? "image/vnd.ms-photo" : "application/octet-stream");

// caratteri incorporati (TTF / ODTTF offuscati): si registrano nel documento con un nome proprio
const loadedFonts = new Map();
async function fontFamily(pkg, uri, used) {
  if (!uri) return "Arial";
  if (used.has(uri)) return used.get(uri);
  let fam = "Arial";
  try {
    if (!loadedFonts.has(uri + "@" + pkg.title)) {
      let b = await pkg.read(uri);
      if (b) {
        if (/\.odttf$/i.test(uri)) b = deobfuscateFont(b, uri);
        const name = "mbvdwf_" + Math.random().toString(36).slice(2, 10);
        const face = new FontFace(name, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
        await face.load();
        document.fonts.add(face);
        loadedFonts.set(uri + "@" + pkg.title, name);
      } else loadedFonts.set(uri + "@" + pkg.title, "Arial");
    }
    fam = loadedFonts.get(uri + "@" + pkg.title);
  } catch { fam = "Arial"; }
  used.set(uri, fam);
  return fam;
}
