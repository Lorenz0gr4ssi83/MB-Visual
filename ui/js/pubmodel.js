// Pubblicazioni (editor in stile Publisher): modello del documento, combinazioni di colori e caratteri, stili,
// modelli di partenza e formato .mbpub (zip con document.json + immagini + anteprima).
//
// Unita': punti tipografici (1/72 di pollice). Documento:
//   { v, w, h, margins {l,t,r,b}, grid {cols, rows, gap}, scheme {name, c[6]}, fonts {name, t, b}, styles {nome: stile},
//     masters [{ id, name, items }], pages [{ id, master, items, guides {v[], h[]}, bg }], stories {id: storia},
//     images {id: { mime, bytes, w, h, name }}, merge {fields, rows} | null }
// Oggetti (cornici): { id, type: text|image|shape|table|wordart|group, x, y, w, h, rot, fill, line {c, w, dash},
//     shadow, opacity, wrap: none|square|topbottom, ... } nell'ordine di sovrapposizione (l'ultimo sta sopra).
// Storie (testo che scorre nelle caselle collegate): { id, chars: [{ c, s, p?, f? }] }; ogni paragrafo termina con
// "\n" che porta le proprieta' del paragrafo (p). s = stile del carattere { f, z, b, i, u, c, k }, condiviso (intern).
// Colori: "#rrggbb", "sN" (colore N della combinazione), "sN:40" (tinta al 40%), "none".
// Caratteri: nome della famiglia, "+t" (titoli) o "+b" (corpo) della combinazione di caratteri.
import { loadScript } from "./core.js";

export const MM = 72 / 25.4;
export const CM = 72 / 2.54;
export const FIELD = "\uFFFC"; // carattere segnaposto dei campi (numero di pagina, data, campi unione)

export const PAGE_SIZES = [
  ["A4", 210, 297], ["A5", 148, 210], ["A3", 297, 420], ["A6", 105, 148], ["Lettera (US)", 215.9, 279.4],
  ["DL (busta)", 99, 210], ["Biglietto da visita", 85, 55], ["Cartolina", 148, 105], ["Segnalibro", 50, 180],
  ["Banner 1 m", 1000, 300], ["Poster 50x70", 500, 700], ["Quadrato 21 cm", 210, 210],
];

// combinazioni di colori: principale (testo) + 5 accenti, come in Publisher
export const COLOR_SCHEMES = [
  ["MB Engineering", "#1d2b36", "#2c6797", "#8a8c89", "#c8a24a", "#5d8aa8", "#eef2f5"],
  ["Acqua", "#003a4d", "#0083a8", "#3cb5d6", "#9fd8e8", "#f2a541", "#e8f6fa"],
  ["Mirtillo", "#2b1a3d", "#6a3d9a", "#a77fd0", "#e2b04a", "#d8cbe6", "#f6f1fa"],
  ["Ciliegia", "#3a0d12", "#b5172b", "#e05a5f", "#f4b6a8", "#5b5b5b", "#fbeeee"],
  ["Civico", "#1a1a1a", "#c0392b", "#2c3e50", "#7f8c8d", "#e8c547", "#f4f4f4"],
  ["Deserto", "#3b2a1a", "#c0712e", "#e3a857", "#7b8b4a", "#d9c7a7", "#faf3e8"],
  ["Foresta", "#1d2f1f", "#2e6b3a", "#6ea35a", "#c7a24b", "#a9c49b", "#f1f6ee"],
  ["Ghiacciaio", "#1b2a3a", "#4a7ab8", "#8fb8e0", "#c9dff2", "#7c8b99", "#f3f8fc"],
  ["Lavanda", "#2d2640", "#7864a8", "#b4a7d6", "#e7a5b5", "#9fb9c9", "#f7f4fb"],
  ["Mare aperto", "#0b2545", "#13315c", "#3e7cb1", "#8da9c4", "#eef4ed", "#f2f6fa"],
  ["Mandarino", "#2e1f14", "#ef7f1a", "#f6b26b", "#3d85c6", "#a3a3a3", "#fff4e8"],
  ["Muschio", "#2a2e1f", "#6b7d35", "#a7b56b", "#7d5a3c", "#d4d9b8", "#f6f7ef"],
  ["Orchidea", "#33142e", "#a2336f", "#d77fb0", "#5c8fc8", "#ead1e1", "#fbf2f7"],
  ["Papavero", "#2b0f0e", "#d64933", "#f2a65a", "#2d3047", "#93b7be", "#fdf1ec"],
  ["Ardesia", "#202529", "#4f5b66", "#8a98a5", "#c1c9d1", "#d08c3a", "#f3f5f7"],
  ["Tramonto", "#301c2a", "#e4572e", "#f3a712", "#a8c686", "#669bbc", "#fff6ea"],
  ["Uva", "#24132b", "#5b2a6e", "#8f4ca8", "#c7a2d6", "#9ab87a", "#f6f0f8"],
  ["Bianco e nero", "#000000", "#333333", "#666666", "#999999", "#cccccc", "#f2f2f2"],
].map(([name, ...c]) => ({ name, c }));

// combinazioni di caratteri: titoli + corpo (caratteri presenti in Windows)
export const FONT_SCHEMES = [
  ["Office", "Calibri Light", "Calibri"], ["Aereo", "Segoe UI Light", "Segoe UI"], ["Archivio", "Georgia", "Verdana"],
  ["Classico", "Times New Roman", "Times New Roman"], ["Civico", "Franklin Gothic Medium", "Georgia"], ["Moderno", "Bahnschrift", "Segoe UI"],
  ["Elegante", "Constantia", "Candara"], ["Tecnico", "Bahnschrift SemiBold", "Bahnschrift Light"], ["Editoriale", "Cambria", "Calibri"],
  ["Impatto", "Impact", "Arial"], ["Lineare", "Arial Black", "Arial"], ["Amichevole", "Trebuchet MS", "Trebuchet MS"],
  ["Rotondo", "Corbel", "Corbel"], ["Mono", "Consolas", "Segoe UI"],
].map(([name, t, b]) => ({ name, t, b }));

export const FONTS = ["Arial", "Arial Black", "Arial Narrow", "Bahnschrift", "Bahnschrift Light", "Bahnschrift SemiBold", "Calibri", "Calibri Light", "Cambria", "Candara",
  "Comic Sans MS", "Consolas", "Constantia", "Corbel", "Courier New", "Franklin Gothic Medium", "Gabriola", "Georgia", "Impact", "Ink Free", "Lucida Console",
  "Palatino Linotype", "Segoe Print", "Segoe Script", "Segoe UI", "Segoe UI Light", "Segoe UI Semibold", "Segoe UI Black", "Sitka Text", "Sylfaen", "Tahoma",
  "Times New Roman", "Trebuchet MS", "Verdana"];

// stili di testo predefiniti (nomi come in Publisher): carattere + paragrafo
export const DEFAULT_STYLES = {
  "Normale": { f: "+b", z: 10, c: "s0", a: "l", lh: 1, sb: 0, sa: 6 },
  "Corpo del testo": { f: "+b", z: 11, c: "s0", a: "j", lh: 1.1, sb: 0, sa: 6 },
  "Titolo": { f: "+t", z: 36, b: true, c: "s1", a: "l", lh: 0.95, sb: 0, sa: 6 },
  "Sottotitolo": { f: "+t", z: 18, c: "s2", a: "l", lh: 1, sb: 0, sa: 6 },
  "Titolo 1": { f: "+t", z: 20, b: true, c: "s1", a: "l", lh: 1, sb: 12, sa: 4 },
  "Titolo 2": { f: "+t", z: 15, b: true, c: "s1", a: "l", lh: 1, sb: 9, sa: 3 },
  "Titolo 3": { f: "+t", z: 12, b: true, i: true, c: "s2", a: "l", lh: 1, sb: 6, sa: 2 },
  "Citazione": { f: "+t", z: 16, i: true, c: "s1", a: "c", lh: 1.1, sb: 6, sa: 6 },
  "Didascalia": { f: "+b", z: 8, i: true, c: "s0", a: "l", lh: 1, sb: 2, sa: 2 },
  "Elenco puntato": { f: "+b", z: 11, c: "s0", a: "l", lh: 1.05, sb: 0, sa: 3, bu: "•" },
  "Elenco numerato": { f: "+b", z: 11, c: "s0", a: "l", lh: 1.05, sb: 0, sa: 3, bu: "1." },
  "Indirizzo": { f: "+b", z: 9, c: "s0", a: "l", lh: 1.05, sb: 0, sa: 0 },
  "Testo in evidenza": { f: "+t", z: 13, b: true, c: "s5", a: "c", lh: 1, sb: 0, sa: 0 },
};
const CHAR_KEYS = ["f", "z", "b", "i", "u", "c", "k"];
const PARA_KEYS = ["a", "lh", "sb", "sa", "li", "ri", "fi", "bu"];
export const charPart = st => Object.fromEntries(CHAR_KEYS.filter(k => st[k] !== undefined).map(k => [k, st[k]]));
export const paraPart = (st, name) => ({ ...Object.fromEntries(PARA_KEYS.filter(k => st[k] !== undefined).map(k => [k, st[k]])), st: name });

// ------------------------------------------------------------------ stili condivisi (stessi valori = stesso oggetto)
const INTERN = new Map();
export function S(o) {
  const clean = {};
  for (const k of Object.keys(o).sort()) if (o[k] !== undefined && o[k] !== null && o[k] !== false && o[k] !== "") clean[k] = o[k];
  const key = JSON.stringify(clean);
  let v = INTERN.get(key);
  if (!v) { v = Object.freeze(clean); INTERN.set(key, v); }
  return v;
}

// ------------------------------------------------------------------ colori e caratteri della combinazione
export function hexToRgb(h) {
  h = (h || "#000").replace("#", "");
  if (h.length === 3) h = h.split("").map(x => x + x).join("");
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbToHex = (r, g, b) => "#" + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
export function tint(hex, pct) {
  const [r, g, b] = hexToRgb(hex), t = pct / 100;
  return rgbToHex(255 - (255 - r) * t, 255 - (255 - g) * t, 255 - (255 - b) * t);
}
export function shade(hex, pct) {
  const [r, g, b] = hexToRgb(hex), t = 1 - pct / 100;
  return rgbToHex(r * t, g * t, b * t);
}
export function color(doc, v) {
  if (!v || v === "none") return null;
  if (v[0] === "s") {
    const m = /^s(\d)(?::(-?\d+))?$/.exec(v);
    if (!m) return "#000000";
    const base = doc.scheme.c[+m[1]] || "#000000";
    if (!m[2]) return base;
    const p = +m[2];
    return p >= 0 ? tint(base, p) : shade(base, -p);
  }
  return v;
}
export const fontName = (doc, f) => (f === "+t" ? doc.fonts.t : f === "+b" || !f ? doc.fonts.b : f);

// ------------------------------------------------------------------ identificatori
export function newId(doc, prefix) {
  doc._uid = (doc._uid || 0) + 1;
  return prefix + doc._uid.toString(36) + Math.random().toString(36).slice(2, 5);
}

// ------------------------------------------------------------------ storie
export function styleChars(doc, name, over = {}) {
  const st = { ...(doc.styles[name] || doc.styles["Normale"] || DEFAULT_STYLES["Normale"]), ...over };
  return { s: S(charPart(st)), p: S(paraPart(st, name)) };
}
// paras: [[testo, nomeStile, {sostituzioni}] | testo]; nel testo "{pagina}" "{pagine}" "{data}" diventano campi
export function makeStory(doc, paras) {
  const id = newId(doc, "t");
  const chars = [];
  for (const item of paras) {
    const [text, styleName, over] = Array.isArray(item) ? item : [item, "Normale", {}];
    const { s, p } = styleChars(doc, styleName || "Normale", over || {});
    const parts = String(text).split(/(\{pagina\}|\{pagine\}|\{data\}|\{campo:[^}]+\})/);
    for (const part of parts) {
      if (!part) continue;
      const fm = /^\{(pagina|pagine|data|campo:([^}]+))\}$/.exec(part);
      if (fm) chars.push({ c: FIELD, s, f: fm[1] === "pagina" ? "page" : fm[1] === "pagine" ? "pages" : fm[1] === "data" ? "date" : "merge:" + fm[2] });
      else for (const ch of part) chars.push(ch === "\n" ? { c: "\u2028", s } : { c: ch, s });
    }
    chars.push({ c: "\n", s, p });
  }
  if (!chars.length) { const { s, p } = styleChars(doc, "Normale"); chars.push({ c: "\n", s, p }); }
  doc.stories[id] = { id, chars };
  return id;
}
export const storyText = st => st.chars.map(ch => (ch.c === "\u2028" ? "\n" : ch.c === FIELD ? "" : ch.c)).join("").replace(/\n$/, "");

// ------------------------------------------------------------------ oggetti
export function baseObj(doc, type, x, y, w, h, extra = {}) {
  return { id: newId(doc, "o"), type, x, y, w, h, rot: 0, fill: "none", line: null, shadow: false, opacity: 1, wrap: type === "text" ? "none" : "square", ...extra };
}
export function textBox(doc, x, y, w, h, paras, extra = {}) {
  return baseObj(doc, "text", x, y, w, h, { story: makeStory(doc, paras), next: null, pad: [4, 4, 4, 4], cols: 1, gap: 12, valign: "t", fit: "none", ...extra });
}
export function imageBox(doc, x, y, w, h, extra = {}) {
  return baseObj(doc, "image", x, y, w, h, { img: null, fx: {}, ...extra });
}
export function shapeBox(doc, shape, x, y, w, h, fill = "s1", line = null, extra = {}) {
  return baseObj(doc, "shape", x, y, w, h, { shape, fill, line, ...extra });
}
export function wordArt(doc, text, x, y, w, h, extra = {}) {
  return baseObj(doc, "wordart", x, y, w, h, { text, font: "+t", b: true, i: false, fill: "s1", outline: "s0", ow: 0, shadow: true, form: "piatto", wrap: "square", ...extra });
}
export function tableBox(doc, x, y, rows, cols, w, rowH = 22, extra = {}) {
  const colW = Array(cols).fill(w / cols);
  const cells = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) row.push({ story: makeStory(doc, [["", "Normale", r === 0 ? { b: true, c: "s5" } : {}]]), fill: r === 0 ? "s1" : r % 2 ? "s1:12" : "none" });
    cells.push(row);
  }
  return baseObj(doc, "table", x, y, w, rows * rowH, { rows, cols, colW, rowH: Array(rows).fill(rowH), cells, border: { c: "s1:60", w: 0.75 }, pad: 3, wrap: "square", ...extra });
}

// tutti gli oggetti di una lista, anche dentro i gruppi
export function* walk(items) {
  for (const o of items) { yield o; if (o.type === "group") yield* walk(o.items); }
}
export function allItems(doc) {
  const out = [];
  for (const m of doc.masters) for (const o of walk(m.items)) out.push(o);
  for (const p of doc.pages) for (const o of walk(p.items)) out.push(o);
  return out;
}

// ------------------------------------------------------------------ documento vuoto
export function newDoc(wmm = 210, hmm = 297, opts = {}) {
  const doc = {
    v: 1, w: wmm * MM, h: hmm * MM, margins: { l: 0.5 * 72, t: 0.5 * 72, r: 0.5 * 72, b: 0.5 * 72 }, grid: { cols: 1, rows: 1, gap: 0.2 * 72 },
    scheme: { ...COLOR_SCHEMES[0], c: [...COLOR_SCHEMES[0].c] }, fonts: { ...FONT_SCHEMES[0] }, styles: JSON.parse(JSON.stringify(DEFAULT_STYLES)),
    masters: [{ id: "A", name: "Pagina master A", items: [] }], pages: [], stories: {}, images: {}, merge: null, _uid: 0, ...opts,
  };
  doc.pages.push(newPage(doc));
  return doc;
}
export function newPage(doc, master = "A") {
  return { id: newId(doc, "p"), master, items: [], guides: { v: [], h: [] }, bg: null };
}

// ------------------------------------------------------------------ copia profonda di oggetti (con storie nuove)
export function cloneItems(doc, items, srcDoc = doc) {
  const map = new Map();
  const cl = o => {
    const n = JSON.parse(JSON.stringify(o, (k, v) => (k === "_cache" ? undefined : v)));
    const fix = x => {
      const old = x.id;
      x.id = newId(doc, "o");
      map.set(old, x.id);
      if (x.story && srcDoc.stories[x.story]) x.story = copyStory(doc, srcDoc.stories[x.story]);
      if (x.type === "table") for (const row of x.cells) for (const c of row) c.story = copyStory(doc, srcDoc.stories[c.story]);
      if (x.type === "group") x.items.forEach(fix);
      if (x.img && srcDoc !== doc && srcDoc.images[x.img.id]) doc.images[x.img.id] = srcDoc.images[x.img.id];
    };
    fix(n);
    return n;
  };
  const out = items.map(cl);
  // i collegamenti fra caselle copiate insieme restano (con la stessa storia); gli altri si tolgono
  for (const o of walk(out)) if (o.type === "text") {
    if (o.next && map.has(o.next)) {
      const nx = [...walk(out)].find(x => x.id === map.get(o.next));
      if (nx) { delete doc.stories[nx.story]; nx.story = o.story; o.next = nx.id; }
    } else o.next = null;
  }
  return out;
}
export function copyStory(doc, st) {
  const id = newId(doc, "t");
  doc.stories[id] = { id, chars: st ? st.chars.map(ch => ({ ...ch })) : [] };
  if (!doc.stories[id].chars.length) doc.stories[id].chars.push({ c: "\n", ...styleChars(doc, "Normale") });
  return id;
}

// ------------------------------------------------------------------ salvataggio .mbpub
async function jszip() { await loadScript("/vendor/jszip/dist/jszip.min.js"); return window.JSZip; }

function packStory(st, cs, ps, csIdx, psIdx) {
  const idx = (tab, map, o) => { const k = JSON.stringify(o); if (!map.has(k)) { map.set(k, tab.length); tab.push(o); } return map.get(k); };
  let txt = "";
  const runs = [], paras = [], fld = {};
  st.chars.forEach((ch, i) => {
    txt += ch.c;
    const si = idx(cs, csIdx, ch.s);
    if (runs.length && runs[runs.length - 1][1] === si) runs[runs.length - 1][0]++;
    else runs.push([1, si]);
    if (ch.c === "\n") paras.push(idx(ps, psIdx, ch.p || {}));
    if (ch.f) fld[i] = ch.f;
  });
  return { txt, runs, paras, fld };
}
function unpackStory(id, o, cs, ps) {
  const chars = [];
  let r = 0, left = o.runs[0]?.[0] || 0, pi = 0;
  const arr = Array.from(o.txt);
  arr.forEach((c, i) => {
    while (left <= 0 && r < o.runs.length - 1) { r++; left = o.runs[r][0]; }
    left--;
    const ch = { c, s: S(cs[o.runs[r]?.[1]] || {}) };
    if (c === "\n") ch.p = S(ps[o.paras[pi++]] || {});
    if (o.fld && o.fld[i]) ch.f = o.fld[i];
    chars.push(ch);
  });
  if (!chars.length || chars[chars.length - 1].c !== "\n") chars.push({ c: "\n", s: S(cs[0] || {}), p: S({}) });
  return { id, chars };
}

export async function writeMbpub(doc, thumbPng) {
  const Z = await jszip();
  const zip = new Z();
  const cs = [], ps = [], csIdx = new Map(), psIdx = new Map();
  const stories = {};
  const used = new Set();
  for (const o of allItems(doc)) {
    if (o.story) used.add(o.story);
    if (o.type === "table") for (const row of o.cells) for (const c of row) used.add(c.story);
  }
  for (const [id, st] of Object.entries(doc.stories)) if (used.has(id)) stories[id] = packStory(st, cs, ps, csIdx, psIdx);
  const images = {};
  const usedImg = new Set();
  for (const o of allItems(doc)) if (o.img?.id) usedImg.add(o.img.id);
  for (const p of doc.pages) if (p.bg?.img) usedImg.add(p.bg.img);
  for (const [id, im] of Object.entries(doc.images)) {
    if (!usedImg.has(id)) continue;
    const ext = im.mime === "image/jpeg" ? "jpg" : im.mime === "image/png" ? "png" : im.mime === "image/gif" ? "gif" : im.mime === "image/webp" ? "webp" : "bin";
    const file = `immagini/${id}.${ext}`;
    zip.file(file, im.bytes);
    images[id] = { file, mime: im.mime, w: im.w, h: im.h, name: im.name || "" };
  }
  const json = { ...doc, stories, images, cs, ps, app: "MB Visual", format: "mbpub", v: 1 };
  zip.file("mimetype", "application/x-mbvisual-publication", { compression: "STORE" });
  zip.file("document.json", JSON.stringify(json));
  if (thumbPng) zip.file("anteprima.png", thumbPng);
  return await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

export async function readMbpub(bytes) {
  const Z = await jszip();
  const zip = await Z.loadAsync(bytes);
  const f = zip.file("document.json");
  if (!f) throw new Error("Il file non contiene una pubblicazione (document.json mancante)");
  const j = JSON.parse(await f.async("string"));
  const doc = { ...j };
  delete doc.cs; delete doc.ps; delete doc.app; delete doc.format;
  doc.stories = {};
  for (const [id, o] of Object.entries(j.stories || {})) doc.stories[id] = unpackStory(id, o, j.cs || [], j.ps || []);
  doc.images = {};
  for (const [id, im] of Object.entries(j.images || {})) {
    const zf = zip.file(im.file);
    if (zf) doc.images[id] = { mime: im.mime, w: im.w, h: im.h, name: im.name, bytes: await zf.async("uint8array") };
  }
  return normalizeDoc(doc);
}

// valori mancanti (file vecchi o creati da altri programmi)
export function normalizeDoc(doc) {
  doc.styles = { ...JSON.parse(JSON.stringify(DEFAULT_STYLES)), ...(doc.styles || {}) };
  doc.masters = doc.masters?.length ? doc.masters : [{ id: "A", name: "Pagina master A", items: [] }];
  doc.pages = doc.pages?.length ? doc.pages : [newPage(doc)];
  for (const p of doc.pages) { p.guides = p.guides || { v: [], h: [] }; if (p.master === undefined) p.master = "A"; p.items = p.items || []; }
  doc.margins = doc.margins || { l: 36, t: 36, r: 36, b: 36 };
  doc.grid = doc.grid || { cols: 1, rows: 1, gap: 14.4 };
  doc.scheme = doc.scheme || { ...COLOR_SCHEMES[0] };
  doc.fonts = doc.fonts || { ...FONT_SCHEMES[0] };
  doc.stories = doc.stories || {};
  doc.images = doc.images || {};
  for (const o of allItems(doc)) {
    if ((o.type === "text") && !doc.stories[o.story]) o.story = makeStory(doc, [""]);
    if (o.type === "table") for (const row of o.cells) for (const c of row) if (!doc.stories[c.story]) c.story = makeStory(doc, [""]);
  }
  return doc;
}

// file vuoto per "Crea nuovo" (ui/js/newfile.js)
export async function blankMbpub() {
  return writeMbpub(newDoc(), null);
}
