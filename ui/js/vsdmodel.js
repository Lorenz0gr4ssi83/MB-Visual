// Diagrammi di Microsoft Visio (.vsdx, .vsdm, .vstx, .vstm): lettura del pacchetto, ereditarieta' delle celle
// (forma -> forma master -> stili del documento -> tema), valutazione delle formule piu' comuni e modifiche.
// Scritto da zero sulla specifica pubblica [MS-VSDX] di Microsoft.
//
// Le modifiche lavorano direttamente sui DOM XML delle parti del pacchetto: tutto quello che l'editor non conosce
// (macro, dati, finestre, proprieta', master, temi) resta com'e' e il file salvato si riapre in Visio.
// Regole seguite nella scrittura (come fa Visio):
//   - V e' sempre in unita' interne (pollici, radianti); F="Inh" = formula ereditata dal master;
//     una cella senza F e' una costante locale.
//   - una cella cambiata mantiene la sua formula solo se la formula, valutata con i nuovi valori, da' lo stesso
//     risultato; altrimenti diventa costante (Visio non la ricalcola in modo diverso da quello che si vede).
//   - nell'elemento Shape: prima le Cell, poi Trigger, poi Section, poi Text / Data / ForeignData / Shapes.
import { loadScript } from "./core.js";

export const VNS = "http://schemas.microsoft.com/office/visio/2012/main";
export const RNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PRNS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CTNS = "http://schemas.openxmlformats.org/package/2006/content-types";
const REL_PAGE = "http://schemas.microsoft.com/visio/2010/relationships/page";
const REL_IMAGE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
const CT_PAGE = "application/vnd.ms-visio.page+xml";
export const PALETTE = ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff", "#800000", "#008000", "#000080",
  "#808000", "#800080", "#008080", "#c0c0c0", "#e6e6e6", "#cdcdcd", "#b3b3b3", "#9a9a9a", "#808080", "#666666", "#4d4d4d", "#333333", "#1a1a1a"];

const NOF = { createFolders: false };
async function jszip() { await loadScript("/vendor/jszip/dist/jszip.min.js"); return window.JSZip; }
const parser = () => new DOMParser();
export const xmlStr = d => "<?xml version='1.0' encoding='utf-8' ?>\n" + new XMLSerializer().serializeToString(d).replace(/^<\?xml[^>]*\?>\s*/, "");
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const kids = (el, name) => el ? [...el.children].filter(c => c.localName === name) : [];
const kid = (el, name) => el ? [...el.children].find(c => c.localName === name) || null : null;
function joinPath(base, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/");
  parts.pop();
  for (const p of target.split("/")) { if (p === "..") parts.pop(); else if (p !== ".") parts.push(p); }
  return parts.join("/");
}
const relsPath = p => { const i = p.lastIndexOf("/"); return p.slice(0, i + 1) + "_rels/" + p.slice(i + 1) + ".rels"; };

// ================================================================== pacchetto
export async function openVsdx(bytes) {
  const Z = await jszip();
  const zip = await Z.loadAsync(bytes);
  const doc = { zip, xml: new Map(), dirty: new Set(), media: new Map(), masters: new Map(), pages: [] };
  const read = async p => {
    if (doc.xml.has(p)) return doc.xml.get(p);
    const f = zip.file(p);
    if (!f) return null;
    const d = parser().parseFromString(await f.async("string"), "application/xml");
    if (d.getElementsByTagName("parsererror").length) throw new Error("XML non valido nella parte " + p);
    doc.xml.set(p, d);
    return d;
  };
  doc.read = read;
  doc.rels = async p => {
    const d = await read(relsPath(p));
    const m = new Map();
    if (d) for (const r of d.getElementsByTagNameNS(PRNS, "Relationship")) m.set(r.getAttribute("Id"), { type: r.getAttribute("Type"), target: r.getAttribute("TargetMode") === "External" ? r.getAttribute("Target") : joinPath(p, r.getAttribute("Target")), ext: r.getAttribute("TargetMode") === "External" });
    return m;
  };
  const root = await doc.rels("");
  let docPath = [...root.values()].find(r => /\/document$/.test(r.type))?.target || "visio/document.xml";
  doc.docPath = docPath;
  doc.docXml = await read(docPath);
  if (!doc.docXml) throw new Error("Il file non contiene un diagramma di Visio (manca visio/document.xml)");
  const drels = await doc.rels(docPath);
  const find = re => [...drels.values()].find(r => re.test(r.type))?.target;
  doc.pagesPath = find(/\/pages$/) || "visio/pages/pages.xml";
  doc.mastersPath = find(/\/masters$/);
  doc.themePath = find(/\/theme$/);
  readDocSettings(doc);
  if (doc.themePath) readTheme(doc, await read(doc.themePath));
  doc.hasTheme = !!doc.themePath;
  // master
  if (doc.mastersPath) {
    const mx = await read(doc.mastersPath);
    const mr = await doc.rels(doc.mastersPath);
    for (const m of mx ? kids(mx.documentElement, "Master") : []) {
      const rel = kid(m, "Rel");
      const path = rel && mr.get(rel.getAttributeNS(RNS, "id"))?.target;
      const M = { id: m.getAttribute("ID"), name: m.getAttribute("Name") || m.getAttribute("NameU") || "Master", nameU: m.getAttribute("NameU") || "", el: m, path, hidden: m.getAttribute("Hidden") === "1", shapes: new Map(), top: [], rels: new Map() };
      doc.masters.set(M.id, M);
    }
    await Promise.all([...doc.masters.values()].map(async M => {
      if (!M.path) return;
      const x = await read(M.path);
      if (!x) return;
      M.xml = x;
      M.rels = await doc.rels(M.path);
      const shapes = kid(x.documentElement, "Shapes");
      const walk = (els, parent) => els.map(el => {
        const S = { el, ms: null, parent, id: el.getAttribute("ID"), master: M, inMaster: true, children: [] };
        M.shapes.set(S.id, S);
        S.children = walk(kids(kid(el, "Shapes"), "Shape"), S);
        return S;
      });
      M.top = walk(kids(shapes, "Shape"), null);
    }));
  }
  await loadPages(doc);
  return doc;
}

async function loadPages(doc) {
  const px = await doc.read(doc.pagesPath);
  const pr = await doc.rels(doc.pagesPath);
  doc.pagesRels = pr;
  doc.pages = [];
  for (const el of kids(px.documentElement, "Page")) {
    const rel = kid(el, "Rel");
    const path = rel && pr.get(rel.getAttributeNS(RNS, "id"))?.target;
    doc.pages.push({ el, path, id: el.getAttribute("ID"), get name() { return el.getAttribute("Name") || el.getAttribute("NameU") || "Pagina"; }, background: el.getAttribute("Background") === "1", backPage: el.getAttribute("BackPage"), xml: null, rels: new Map(), doc });
  }
  await Promise.all(doc.pages.map(async P => {
    if (!P.path) return;
    P.xml = await doc.read(P.path);
    P.rels = await doc.rels(P.path);
  }));
}
export const pageById = (doc, id) => doc.pages.find(p => p.id === id);

function readDocSettings(doc) {
  const de = doc.docXml.documentElement;
  doc.colors = [...PALETTE];
  for (const c of kids(kid(de, "Colors"), "ColorEntry")) doc.colors[+c.getAttribute("IX")] = c.getAttribute("RGB")?.toLowerCase() || "#000000";
  doc.faces = new Map();
  for (const f of kids(kid(de, "FaceNames"), "FaceName")) doc.faces.set(f.getAttribute("ID"), f.getAttribute("Name") || f.getAttribute("NameU"));
  doc.styles = new Map();
  for (const s of kids(kid(de, "StyleSheets"), "StyleSheet")) doc.styles.set(s.getAttribute("ID"), { el: s, id: s.getAttribute("ID"), name: s.getAttribute("Name") || s.getAttribute("NameU") });
  doc.theme = { colors: { dk1: "#000000", lt1: "#ffffff", dk2: "#44546a", lt2: "#e7e6e6", accent1: "#5b9bd5", accent2: "#ed7d31", accent3: "#a5a5a5", accent4: "#ffc000", accent5: "#4472c4", accent6: "#70ad47" }, major: "Calibri Light", minor: "Calibri" };
}
function readTheme(doc, x) {
  if (!x) return;
  const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
  const cs = x.getElementsByTagNameNS(A, "clrScheme")[0];
  if (cs) for (const c of cs.children) {
    const v = c.firstElementChild;
    const hex = v?.getAttribute("val") && v.localName === "srgbClr" ? v.getAttribute("val") : v?.getAttribute("lastClr");
    if (hex) doc.theme.colors[c.localName] = "#" + hex.toLowerCase();
  }
  const VT = "http://schemas.microsoft.com/office/visio/2012/theme";
  doc.theme.variations = [...x.getElementsByTagNameNS(VT, "variationClrScheme")].map(v => [...v.children].map(k => { const e = k.firstElementChild; const h = e?.getAttribute("val") && e.localName === "srgbClr" ? e.getAttribute("val") : e?.getAttribute("lastClr"); return h ? "#" + h.toLowerCase() : null; }));
  const mj = x.getElementsByTagNameNS(A, "majorFont")[0], mn = x.getElementsByTagNameNS(A, "minorFont")[0];
  const lat = e => e && [...e.children].find(c => c.localName === "latin")?.getAttribute("typeface");
  doc.theme.major = lat(mj) || doc.theme.major;
  doc.theme.minor = lat(mn) || doc.theme.minor;
}

// ================================================================== albero delle forme di una pagina
// S = { el (Shape nel file, o null se la forma esiste solo nel master), ms (forma del master da cui eredita),
//       parent, children, id, page, master }
export function buildShapes(doc, page) {
  const all = new Map();
  const wrap = (el, parent, masterCtx) => {
    let M = masterCtx;
    const mid = el.getAttribute("Master");
    if (mid) M = doc.masters.get(mid) || null;
    let ms = null;
    const msid = el.getAttribute("MasterShape");
    if (M && msid) ms = M.shapes.get(msid) || null;
    else if (M && mid) ms = M.top.length === 1 ? M.top[0] : null;
    const S = { el, ms, parent, id: el.getAttribute("ID"), page, master: M, children: [] };
    all.set(S.id, S);
    // le forme del master cancellate nell'istanza (Del="1", ID 4294967295) non si disegnano
    const all0 = kids(kid(el, "Shapes"), "Shape"), local = all0.filter(c => c.getAttribute("Del") !== "1");
    if (all0.length) S.children = local.map(c => wrap(c, S, M));
    else if (ms?.children.length) S.children = ms.children.map(c => inherited(c, S));
    else if (M && mid && !ms && M.top.length > 1) S.children = M.top.map(c => inherited(c, S));
    return S;
  };
  // forme solo del master (l'istanza non le riscrive): si leggono tutte dal master
  const inherited = (m, parent) => {
    const S = { el: null, ms: m, parent, id: null, page, master: m.master, children: [] };
    S.children = m.children.map(c => inherited(c, S));
    return S;
  };
  const shapesEl = page.xml ? kid(page.xml.documentElement, "Shapes") : null;
  const top = kids(shapesEl, "Shape").filter(el => el.getAttribute("Del") !== "1").map(el => wrap(el, null, null));
  const connects = kids(kid(page.xml?.documentElement, "Connects"), "Connect").map(c => ({ el: c, from: c.getAttribute("FromSheet"), fromCell: c.getAttribute("FromCell"), to: c.getAttribute("ToSheet"), toCell: c.getAttribute("ToCell"), toPart: c.getAttribute("ToPart") }));
  return { top, all, connects };
}
export const topOf = S => { while (S.parent) S = S.parent; return S; };

// ------------------------------------------------------------------ celle
function cellMap(el) {
  if (!el) return null;
  if (el._cells) return el._cells;
  const m = new Map();
  for (const c of el.children) if (c.localName === "Cell") m.set(c.getAttribute("N"), c);
  el._cells = m;
  return m;
}
export const invalidate = el => { if (el) { el._cells = null; el._sect = null; } };
const rec = (c, from) => c ? { v: c.getAttribute("V"), f: c.getAttribute("F"), u: c.getAttribute("U"), el: c, from } : null;

const LINE_RE = /^(Line|BeginArrow|EndArrow|Rounding|Compound)/;
const FILL_RE = /^(Fill|Shdw|ShapeShdw)/;
const TEXT_RE = /^(LeftMargin|RightMargin|TopMargin|BottomMargin|VerticalAlign|TextBkgnd|DefaultTabStop|TextDirection)/;
const styleAttr = name => LINE_RE.test(name) ? "LineStyle" : FILL_RE.test(name) ? "FillStyle" : TEXT_RE.test(name) ? "TextStyle" : null;
function styleOf(S, attr) {
  for (let s = S; s; s = s.ms) { const v = s.el?.getAttribute(attr); if (v != null) return v; }
  return null;
}
function styleCell(doc, id, attr, name, depth = 0) {
  if (id == null || depth > 20) return null;
  const st = doc.styles.get(id);
  if (!st) return null;
  const c = cellMap(st.el).get(name);
  if (c) return rec(c, st);
  const tryAttrs = attr ? [attr] : ["LineStyle", "FillStyle", "TextStyle"];
  for (const a of tryAttrs) {
    const p = st.el.getAttribute(a);
    if (p != null && p !== id) { const r = styleCell(doc, p, attr, name, depth + 1); if (r) return r; }
  }
  return null;
}
// cella risolta: {v, f, u, el, from}
export function cell(doc, S, name) {
  for (let s = S; s; s = s.ms) { const c = cellMap(s.el)?.get(name); if (c) return rec(c, s); }
  const attr = styleAttr(name);
  if (attr) return styleCell(doc, styleOf(S, attr) ?? "0", attr, name);
  for (const a of ["LineStyle", "FillStyle", "TextStyle"]) { const r = styleCell(doc, styleOf(S, a), null, name); if (r) return r; }
  return null;
}
// valori "Themed" delle celle numeriche (stile del tema Office di Visio)
const THEMED = { LineWeight: 0.75 / 72, Rounding: 0, LinePattern: 1, FillPattern: 1, ShdwPattern: 0, LineCap: 0, BeginArrow: 0, EndArrow: 0, BeginArrowSize: 2, EndArrowSize: 2, FillForegndTrans: 0, FillBkgndTrans: 0, LineColorTrans: 0, ShdwForegndTrans: 0, FillGradientEnabled: 0, LineGradientEnabled: 0 };
export const val = (doc, S, name, def = 0) => { const r = cell(doc, S, name); if (!r || r.v == null || r.v === "") return def; if (r.v === "Themed") return THEMED[name] ?? (/(Color|Foregnd|Bkgnd)$/.test(name) ? "Themed" : def); const n = parseFloat(r.v); return Number.isFinite(n) ? n : r.v; };
export const num0 = (doc, S, name, def = 0) => { const v = val(doc, S, name, def); return typeof v === "number" ? v : def; };

// ------------------------------------------------------------------ sezioni (righe ereditate cella per cella)
// ritorna Map chiave -> { key, ix, n, T, del, cells: Map(nome -> rec) }
function rowKey(r) { return r.getAttribute("N") ?? ("#" + (r.getAttribute("IX") ?? "")); }
function sectionEls(el, name, ix) {
  if (!el) return [];
  return kids(el, "Section").filter(s => s.getAttribute("N") === name && (ix == null || (s.getAttribute("IX") ?? "0") === String(ix)));
}
function mergeSection(rows, secEl, from) {
  for (const r of kids(secEl, "Row")) {
    const k = rowKey(r);
    if (r.getAttribute("Del") === "1") { rows.delete(k); continue; }
    let R = rows.get(k);
    if (!R) { R = { key: k, ix: r.getAttribute("IX") != null ? +r.getAttribute("IX") : null, n: r.getAttribute("N"), T: null, cells: new Map(), el: null }; rows.set(k, R); }
    if (r.getAttribute("T")) R.T = r.getAttribute("T");
    R.el = r;
    for (const c of kids(r, "Cell")) R.cells.set(c.getAttribute("N"), rec(c, from));
  }
}
const TEXT_SECTIONS = { Character: "TextStyle", Paragraph: "TextStyle", Tabs: "TextStyle" };
export function section(doc, S, name, ix = null) {
  const chain = [];
  for (let s = S; s; s = s.ms) chain.unshift(s);
  const rows = new Map();
  let base = null;
  if (TEXT_SECTIONS[name]) {
    // riga 0 dello stile di testo: valori predefiniti per le righe che non li hanno
    let id = styleOf(S, "TextStyle") ?? "0";
    for (let d = 0; id != null && d < 20; d++) {
      const st = doc.styles.get(id);
      if (!st) break;
      const se = sectionEls(st.el, name)[0];
      if (se) { const m = new Map(); mergeSection(m, se, st); base = m.values().next().value || null; if (base) break; }
      const p = st.el.getAttribute("TextStyle");
      id = p !== id ? p : null;
    }
  }
  let deleted = false;
  for (const s of chain) for (const se of sectionEls(s.el, name, ix)) {
    if (se.getAttribute("Del") === "1") { rows.clear(); deleted = true; continue; }
    mergeSection(rows, se, s);
  }
  if (base) {
    if (!rows.size && !deleted) rows.set("#0", { key: "#0", ix: 0, n: null, T: null, cells: new Map(base.cells), el: null });
    else for (const R of rows.values()) for (const [k, c] of base.cells) if (!R.cells.has(k)) R.cells.set(k, c);
  }
  return rows;
}
export const rowsOf = (doc, S, name) => [...section(doc, S, name).values()].sort((a, b) => (a.ix ?? 0) - (b.ix ?? 0));
export const rowNum = (R, n, def = 0) => { const c = R?.cells.get(n); if (!c || c.v == null || c.v === "") return def; const x = parseFloat(c.v); return Number.isFinite(x) ? x : def; };
export const rowStr = (R, n, def = "") => { const c = R?.cells.get(n); return c?.v ?? def; };

// sezioni di geometria unite per IX: [{ ix, noFill, noLine, noShow, rows: [...] }]
export function geometry(doc, S) {
  const chain = [];
  for (let s = S; s; s = s.ms) chain.unshift(s);
  const secs = new Map();
  for (const s of chain) for (const se of sectionEls(s.el, "Geometry")) {
    const ix = se.getAttribute("IX") ?? "0";
    if (se.getAttribute("Del") === "1") { secs.delete(ix); continue; }
    let G = secs.get(ix);
    if (!G) { G = { ix: +ix, cells: new Map(), rows: new Map() }; secs.set(ix, G); }
    for (const c of kids(se, "Cell")) G.cells.set(c.getAttribute("N"), rec(c, s));
    mergeSection(G.rows, se, s);
  }
  return [...secs.values()].sort((a, b) => a.ix - b.ix).map(G => ({
    ix: G.ix, cells: G.cells,
    noFill: num(G.cells.get("NoFill")?.v) === 1, noLine: num(G.cells.get("NoLine")?.v) === 1, noShow: num(G.cells.get("NoShow")?.v) === 1,
    rows: [...G.rows.values()].filter(r => r.T).sort((a, b) => (a.ix ?? 0) - (b.ix ?? 0)),
  }));
}

export function textEl(S) { for (let s = S; s; s = s.ms) { const t = kid(s.el, "Text"); if (t) return t; } return null; }
export function plainText(S) {
  const t = textEl(S);
  if (!t) return "";
  let s = "";
  for (const n of t.childNodes) {
    if (n.nodeType === 3) s += n.nodeValue;
    else if (n.localName === "fld") s += n.textContent;
  }
  return s.replace(/\r\n?/g, "\n").replace(/\n$/, "");
}
export const shapeName = S => S.el?.getAttribute("Name") || S.el?.getAttribute("NameU") || S.ms?.el?.getAttribute("Name") || S.master?.name || (S.id ? "Forma " + S.id : "Forma");
export const is1D = (doc, S) => !!cell(doc, S, "BeginX") && !!cell(doc, S, "EndX") && (S.el?.getAttribute("Type") !== "Group");

// ------------------------------------------------------------------ colori
export function color(doc, v, kind = "fill", S = null) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return doc.colors[v] ?? "#000000";
  const s = String(v).trim();
  if (s[0] === "#") return s.length === 4 ? "#" + [...s.slice(1)].map(c => c + c).join("") : s.toLowerCase().slice(0, 7);
  if (/^\d+$/.test(s)) return doc.colors[+s] ?? "#000000";
  const m = /RGB\((\d+),\s*(\d+),\s*(\d+)\)/i.exec(s);
  if (m) return "#" + [m[1], m[2], m[3]].map(x => (+x).toString(16).padStart(2, "0")).join("");
  if (/^Themed$/i.test(s)) return themedColor(doc, S, kind);
  return null;
}
// colori "Themed": tema del documento + stile rapido della forma (QuickStyle*Color: 0-7 = dk1, lt1, accent1-6;
// 100 = colore predefinito della variante; 200-206 = colori 1-7 della variante scelta con VariationColorIndex)
export function themedColor(doc, S, kind = "fill") {
  // senza tema nel file Visio usa bianco per i riempimenti e nero per linee e testo
  if (!doc.hasTheme) return kind === "fill" ? "#ffffff" : "#000000";
  const c = doc.theme.colors;
  const qn = kind === "line" ? "QuickStyleLineColor" : kind === "text" ? "QuickStyleFontColor" : kind === "shadow" ? "QuickStyleShadowColor" : "QuickStyleFillColor";
  const q = S ? num0(doc, S, qn, 100) : 100;
  // variante della pagina (lo stile "Nessuno stile" ha sempre 0: non conta)
  let vi = -1;
  if (S?.page?.el) {
    const ps = [...S.page.el.children].find(x => x.localName === "PageSheet");
    const ce = ps && [...ps.children].find(x => x.localName === "Cell" && x.getAttribute("N") === "VariationColorIndex");
    vi = ce ? parseFloat(ce.getAttribute("V")) || 0 : 0;
  }
  const vars = doc.theme.variations?.[Math.max(0, vi)] || doc.theme.variations?.[0] || [];
  const list = [c.dk1, c.lt1, c.accent1, c.accent2, c.accent3, c.accent4, c.accent5, c.accent6];
  const base = q >= 200 && q <= 206 ? vars[q - 200] || c.accent1 : q >= 0 && q <= 7 ? list[q] : vars[0] || c.accent1;
  if (kind === "line") return shade(base, -0.25);
  if (kind === "text") return q >= 0 && q <= 7 ? list[q] : c.dk1;
  if (kind === "shadow") return shade(base, -0.5);
  return base;
}
export function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const f = x => Math.round(k < 0 ? x * (1 + k) : x + (255 - x) * k);
  return "#" + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(f).map(x => Math.max(0, Math.min(255, x)).toString(16).padStart(2, "0")).join("");
}

// ================================================================== formule
// Valutatore delle formule piu' usate nei master e nelle geometrie (aritmetica, unita', MIN/MAX/IF/..., riferimenti
// a celle della forma, di altre forme e della pagina). Quando una formula non si puo' valutare si lancia un errore e
// chi chiama sceglie un ripiego (es. scalare in proporzione).
const UNITS = { DL: 1, IN: 1, "IN.": 1, INCH: 1, DP: 1 / 72, PT: 1 / 72, P: 1 / 72, MM: 1 / 25.4, CM: 1 / 2.54, M: 39.37007874, FT: 12, "FT.": 12, YD: 36, KM: 39370.07874, MI: 63360,
  DEG: Math.PI / 180, DA: Math.PI / 180, RAD: 1, AD: Math.PI / 180, MIN: Math.PI / 10800, SEC: Math.PI / 648000, PC: 1 / 6, CI: 1 / 6, DD: 1 / 72, EM: 1 / 6, EW: 1, ED: 1, ES: 1, U: 1, "%": 0.01 };
class FErr extends Error {}
function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    let m;
    const rest = s.slice(i);
    if ((m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest))) {
      i += m[0].length;
      let n = parseFloat(m[0]);
      const u = /^\s*([A-Za-z]+\.?|%)/.exec(s.slice(i));
      if (u && UNITS[u[1].toUpperCase()] != null && !/^\s*[A-Za-z]+\s*[(!.]/.test(s.slice(i)) ) { n *= UNITS[u[1].toUpperCase()]; i += u[0].length; }
      out.push({ t: "n", v: n });
      continue;
    }
    if (ch === '"') { let j = i + 1, str = ""; while (j < s.length) { if (s[j] === '"') { if (s[j + 1] === '"') { str += '"'; j += 2; continue; } break; } str += s[j++]; } out.push({ t: "s", v: str }); i = j + 1; continue; }
    if ((m = /^[A-Za-z_][\w.]*(\[\d+\])?(!([A-Za-z_][\w.]*(\[\d+\])?))?/.exec(rest))) { out.push({ t: "id", v: m[0] }); i += m[0].length; continue; }
    if ((m = /^(<=|>=|<>|[-+*/^&=<>(),%])/.exec(rest))) { out.push({ t: "op", v: m[0] }); i += m[0].length; continue; }
    throw new FErr("carattere inatteso " + ch);
  }
  return out;
}
const FUN = {
  GUARD: a => a[0], MIN: a => Math.min(...a), MAX: a => Math.max(...a), ABS: a => Math.abs(a[0]), SQRT: a => Math.sqrt(a[0]), INT: a => Math.floor(a[0]), TRUNC: a => Math.trunc(a[0]),
  ROUND: a => { const k = 10 ** (a[1] || 0); return Math.round(a[0] * k) / k; }, FLOOR: a => Math.floor(a[0]), CEILING: a => Math.ceil(a[0]), INTUP: a => Math.ceil(a[0]),
  SIN: a => Math.sin(a[0]), COS: a => Math.cos(a[0]), TAN: a => Math.tan(a[0]), ATAN: a => Math.atan(a[0]), ATAN2: a => Math.atan2(a[0], a[1]), ACOS: a => Math.acos(a[0]), ASIN: a => Math.asin(a[0]),
  PI: () => Math.PI, SIGN: a => Math.sign(a[0]), MODULUS: a => ((a[0] % a[1]) + a[1]) % a[1], POW: a => a[0] ** a[1], LN: a => Math.log(a[0]), LOG10: a => Math.log10(a[0]), EXP: a => Math.exp(a[0]),
  AND: a => a.every(Boolean) ? 1 : 0, OR: a => a.some(Boolean) ? 1 : 0, NOT: a => a[0] ? 0 : 1, TRUE: () => 1, FALSE: () => 0, BOUND: a => Math.min(Math.max(a[0], a[2]), a[3] ?? Infinity),
  DEG: a => a[0] * 180 / Math.PI, RAD: a => a[0], ANG360: a => ((a[0] % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), MAGNITUDE: a => a.length >= 4 ? Math.hypot(a[1], a[3]) : Math.hypot(a[0], a[1]),
  SETATREF: a => a[0], SETATREFEXPR: a => a[0], SETATREFEVAL: a => a[0], NA: () => { throw new FErr("NA"); }, IFERROR: a => a[0], STRSAME: a => String(a[0]).toLowerCase() === String(a[1]).toLowerCase() ? 1 : 0,
  LEN: a => String(a[0]).length, CHOOSE: a => a[Math.floor(a[0])] ?? 0, RGB: a => "#" + a.slice(0, 3).map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join(""),
  FORMAT: a => String(a[0]), FORMATEX: a => String(a[0]),
};
// ctx: { doc, S, all (Map id->S), page, over: Map("id|Cell"->valore), memo, depth }
const AST = new Map();
function parseF(f) {
  if (AST.has(f)) return AST.get(f);
  const toks = tokenize(f);
  let i = 0;
  const peek = () => toks[i], next = () => toks[i++];
  const isOp = v => peek()?.t === "op" && peek().v === v;
  const expect = v => { if (!isOp(v)) throw new FErr("atteso " + v); i++; };
  const bin = (sub, ops) => () => { let a = sub(); while (peek()?.t === "op" && ops.includes(peek().v)) { const o = next().v; a = { k: "b", o, a, b: sub() }; } return a; };
  const prim = () => {
    const t = next();
    if (!t) throw new FErr("formula incompleta");
    if (t.t === "n" || t.t === "s") return { k: "c", v: t.v };
    if (t.t === "op" && t.v === "(") { const v = cmp(); expect(")"); return v; }
    if (t.t === "id") {
      if (isOp("(")) {
        i++;
        const args = [];
        if (!isOp(")")) { args.push(cmp()); while (isOp(",")) { i++; args.push(cmp()); } }
        expect(")");
        return { k: "f", n: t.v.toUpperCase(), args };
      }
      return { k: "r", n: t.v };
    }
    throw new FErr("simbolo inatteso");
  };
  const un = () => { if (isOp("-")) { i++; return { k: "u", a: un() }; } if (isOp("+")) { i++; return un(); } let v = prim(); if (isOp("%")) { i++; v = { k: "b", o: "/", a: v, b: { k: "c", v: 100 } }; } return v; };
  const pw = bin(un, ["^"]), mul = bin(pw, ["*", "/"]), add = bin(mul, ["+", "-"]), cat = bin(add, ["&"]);
  const cmp = bin(cat, ["=", "<>", "<", ">", "<=", ">="]);
  const ast = cmp();
  if (i < toks.length) throw new FErr("formula non riconosciuta");
  if (AST.size > 5000) AST.clear();
  AST.set(f, ast);
  return ast;
}
function ev(n, ctx) {
  switch (n.k) {
    case "c": return n.v;
    case "r": return ref(n.n, ctx);
    case "u": return -ev(n.a, ctx);
    case "b": {
      const a = ev(n.a, ctx), b = ev(n.b, ctx);
      switch (n.o) {
        case "+": return a + b; case "-": return a - b; case "*": return a * b; case "/": return a / b; case "^": return a ** b; case "&": return String(a) + String(b);
        case "=": return +(a === b || Math.abs(a - b) < 1e-9); case "<>": return +(a !== b); case "<": return +(a < b); case ">": return +(a > b); case "<=": return +(a <= b); default: return +(a >= b);
      }
    }
    case "f": {
      if (n.n === "IF") return ev(n.args[0], ctx) ? ev(n.args[1], ctx) : n.args[2] ? ev(n.args[2], ctx) : 0;
      if (n.n === "IFERROR") { try { return ev(n.args[0], ctx); } catch { return n.args[1] ? ev(n.args[1], ctx) : 0; } }
      const fn = FUN[n.n];
      if (!fn) throw new FErr("funzione non gestita " + n.n);
      return fn(n.args.map(a => ev(a, ctx)));
    }
  }
  throw new FErr("nodo");
}
export function evalFormula(f, ctx) {
  const v = ev(parseF(f), ctx);
  if (typeof v === "number" && !Number.isFinite(v)) throw new FErr("valore non finito");
  return v;
}
// riferimento a una cella: "Width", "Geometry1.X2", "User.Nome", "Controls.Row_1.Y", "Sheet.5!PinX", "ThePage!PageWidth"
function ref(name, ctx) {
  let S = ctx.S, cellName = name;
  const bang = name.indexOf("!");
  if (bang >= 0) {
    const sheet = name.slice(0, bang);
    cellName = name.slice(bang + 1);
    if (/^ThePage$/i.test(sheet)) return pageCell(ctx, cellName);
    const m = /^Sheet\.(\d+)$/i.exec(sheet);
    S = m ? ctx.all?.get(m[1]) : [...(ctx.all?.values() || [])].find(x => x.el?.getAttribute("NameU") === sheet || x.el?.getAttribute("Name") === sheet);
    if (!S) throw new FErr("forma non trovata " + sheet);
  }
  return cellValue({ ...ctx, S }, cellName);
}
function pageCell(ctx, name) {
  const ps = ctx.page ? kid(ctx.page.el, "PageSheet") : null;
  const c = cellMap(ps)?.get(name);
  if (!c) throw new FErr("cella di pagina " + name);
  return num(c.getAttribute("V"));
}
// "Geometry1.X2" -> sezione Geometry IX 0, riga IX 2, cella X
function locate(doc, S, name) {
  let m;
  if ((m = /^Geometry(\d+)\.([A-Za-z]+?)(\d+)$/.exec(name))) {
    const g = geometry(doc, S).find(G => G.ix === +m[1] - 1);
    const R = g?.rows.find(r => r.ix === +m[3]);
    return { rec: R?.cells.get(m[2]) ?? null, key: `G${+m[1] - 1}.${m[3]}.${m[2]}`, T: R?.T };
  }
  if ((m = /^Geometry(\d+)\.(NoFill|NoLine|NoShow|NoSnap|NoQuickDrag)$/.exec(name))) {
    const g = geometry(doc, S).find(G => G.ix === +m[1] - 1);
    return { rec: g?.cells.get(m[2]) ?? null, key: `G${+m[1] - 1}.${m[2]}` };
  }
  const secMap = { User: ["User", "Value"], Prop: ["Property", "Value"], Controls: ["Control", "X"], Scratch: ["Scratch", null], Connections: ["Connection", null], Char: ["Character", null], Para: ["Paragraph", null], Actions: ["Action", "Action"] };
  if ((m = /^(User|Prop|Controls|Scratch|Connections|Char|Para|Actions)\.(.+)$/.exec(name))) {
    const [sec, def] = secMap[m[1]];
    const rows = section(doc, S, sec);
    let rest = m[2], R = null, c = def;
    let mm;
    if ((mm = /^([A-Za-z]+?)(\d+)$/.exec(rest)) && (m[1] === "Scratch" || m[1] === "Connections" || m[1] === "Controls")) { R = [...rows.values()].find(r => r.ix === +mm[2] - 1); c = mm[1]; }
    else if ((mm = /^([A-Za-z]+)(\[(\d+)\])?$/.exec(rest)) && (m[1] === "Char" || m[1] === "Para")) { R = [...rows.values()].find(r => (r.ix ?? 0) === (mm[3] ? +mm[3] - 1 : 0)); c = mm[1]; }
    else {
      const parts = rest.split(".");
      R = rows.get(parts[0]);
      if (parts[1]) c = parts[1];
    }
    if (m[1] === "Controls" && c === "X" && R && !R.cells.has("X")) c = "X";
    return { rec: R?.cells.get(c) ?? null, key: `${sec}.${R?.key}.${c}` };
  }
  return { rec: cell(doc, S, name), key: name };
}
function inheritedFormula(doc, S, rec) {
  if (!rec) return null;
  if (rec.f == null) return null;
  if (rec.f !== "Inh") return rec.f;
  // F="Inh": la formula e' quella del master (valutata nel contesto della forma)
  const from = rec.from;
  let s = from?.ms;
  const n = rec.el.getAttribute("N");
  const row = rec.el.parentElement?.localName === "Row" ? rec.el.parentElement : null;
  for (; s; s = s.ms) {
    let c = null;
    if (!row) c = cellMap(s.el)?.get(n);
    else {
      const sec = row.parentElement, key = rowKey(row);
      const se = sectionEls(s.el, sec.getAttribute("N"), sec.getAttribute("N") === "Geometry" ? (sec.getAttribute("IX") ?? "0") : null)[0];
      const r = se && kids(se, "Row").find(x => rowKey(x) === key);
      c = r && kids(r, "Cell").find(x => x.getAttribute("N") === n);
    }
    if (c) { const f = c.getAttribute("F"); if (f && f !== "Inh") return f; if (!f) return null; }
  }
  return null;
}
export function cellValue(ctx, name) {
  const { doc, S } = ctx;
  const key = (S.id || "") + "|" + name;
  if (ctx.over?.has(key)) return ctx.over.get(key);
  ctx.memo ||= new Map();
  if (ctx.memo.has(key)) return ctx.memo.get(key);
  if ((ctx.depth || 0) > 40) throw new FErr("riferimenti troppo profondi");
  const { rec: r } = locate(doc, S, name);
  if (!r) {
    if (/^(Width|Height|PinX|PinY|LocPinX|LocPinY|Angle|FlipX|FlipY)$/.test(name)) return 0;
    throw new FErr("cella non trovata " + name);
  }
  const f = inheritedFormula(doc, S, r);
  let v;
  if (f && f !== "No Formula" && !/^(THEMEVAL|THEMEGUARD|_|NURBS|POLYLINE|USE\(|SETF|RUNADDON|CALLTHIS|GOTOPAGE|DOCMD|OPENTEXTWIN|EVALTEXT|SHAPETEXT|FIELDPICTURE|DATA|LOOKUP|INDEX|DEPENDSON)/i.test(f)) {
    v = evalFormula(f, { ...ctx, depth: (ctx.depth || 0) + 1 });
  } else {
    const n = parseFloat(r.v);
    v = Number.isFinite(n) ? n : r.v ?? 0;
  }
  ctx.memo.set(key, v);
  return v;
}

// ================================================================== scrittura
const NS = (d, name) => d.createElementNS(VNS, name);
const ORDER = { Cell: 0, Trigger: 1, Section: 2, Text: 3, Data1: 4, Data2: 5, Data3: 6, ForeignData: 7, Shapes: 8 };
function insertOrdered(parent, el) {
  const o = ORDER[el.localName] ?? 9;
  const after = [...parent.children].find(c => (ORDER[c.localName] ?? -1) > o);
  parent.insertBefore(el, after || null);
  return el;
}
export const fmt = v => typeof v === "number" ? String(+v.toPrecision(15)) : String(v);
// scrive una cella diretta (V, e F solo se indicata: f === undefined lascia la formula com'e', null la toglie)
export function setCell(el, name, v, f, u) {
  let c = cellMap(el).get(name);
  if (!c) { c = NS(el.ownerDocument, "Cell"); c.setAttribute("N", name); insertOrdered(el, c); invalidate(el); }
  c.setAttribute("V", fmt(v));
  if (f === null) c.removeAttribute("F"); else if (f !== undefined) c.setAttribute("F", f);
  if (u) c.setAttribute("U", u);
  return c;
}
function ensureSection(el, name, ix) {
  let se = sectionEls(el, name, ix)[0];
  if (!se) { se = NS(el.ownerDocument, "Section"); se.setAttribute("N", name); if (ix != null) se.setAttribute("IX", String(ix)); insertOrdered(el, se); }
  return se;
}
function ensureRow(se, key, T) {
  let r = kids(se, "Row").find(x => rowKey(x) === key);
  if (!r) {
    r = NS(se.ownerDocument, "Row");
    if (T) r.setAttribute("T", T);
    if (key.startsWith("#")) r.setAttribute("IX", key.slice(1)); else r.setAttribute("N", key);
    const ix = key.startsWith("#") ? +key.slice(1) : null;
    const after = ix != null ? kids(se, "Row").find(x => x.getAttribute("IX") != null && +x.getAttribute("IX") > ix) : null;
    se.insertBefore(r, after || null);
  } else if (T && !r.getAttribute("T")) r.setAttribute("T", T);
  return r;
}
export function setRowCell(el, secName, secIx, key, T, name, v, f, u) {
  const r = ensureRow(ensureSection(el, secName, secIx), key, T);
  let c = kids(r, "Cell").find(x => x.getAttribute("N") === name);
  if (!c) { c = NS(el.ownerDocument, "Cell"); c.setAttribute("N", name); r.append(c); }
  c.setAttribute("V", fmt(v));
  if (f === null) c.removeAttribute("F"); else if (f !== undefined) c.setAttribute("F", f);
  if (u) c.setAttribute("U", u);
  invalidate(el);
  return c;
}

// scrittura "intelligente": tiene la formula solo se, valutata con i valori nuovi, da' il valore scritto
function keepFormula(doc, S, r, v, ctx) {
  if (!r?.f) return null;
  const f = inheritedFormula(doc, S, r);
  if (!f || f === "No Formula") return null;
  if (/^(_WALKGLUE|_XFTRIGGER|GUARD\(_)/i.test(f)) return r.f; // formule di incollaggio: Visio le ricalcola
  try {
    const x = evalFormula(f, { ...ctx, depth: 1, memo: new Map() });
    if (typeof x === "number" && typeof v === "number" && Math.abs(x - v) < 1e-7 * Math.max(1, Math.abs(v))) return r.f;
  } catch { /* non valutabile */ }
  return null;
}
export function setSmart(doc, S, name, v, ctx) {
  const r = cell(doc, S, name);
  const cur = r ? parseFloat(r.v) : NaN;
  if (Number.isFinite(cur) && typeof v === "number" && Math.abs(cur - v) < 1e-12 && r.from === S) return;
  const keep = keepFormula(doc, S, r, v, ctx);
  setCell(S.el, name, v, keep ?? null, r?.u || undefined);
}

export function markDirty(doc, path) { doc.dirty.add(path); }

export async function saveVsdx(doc) {
  for (const p of doc.dirty) { const d = doc.xml.get(p); if (d) doc.zip.file(p, xmlStr(d), NOF); }
  doc.dirty.clear();
  return await doc.zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 }, mimeType: "application/vnd.ms-visio.drawing" });
}

// ------------------------------------------------------------------ parti nuove (pagine, immagini)
async function contentTypes(doc) { const d = await doc.read("[Content_Types].xml"); return d; }
export async function ensureDefaultType(doc, ext, mime) {
  const d = await contentTypes(doc);
  const root = d.documentElement;
  if ([...root.children].some(c => c.localName === "Default" && c.getAttribute("Extension")?.toLowerCase() === ext)) return;
  const e = d.createElementNS(CTNS, "Default");
  e.setAttribute("Extension", ext); e.setAttribute("ContentType", mime);
  root.insertBefore(e, root.firstElementChild);
  markDirty(doc, "[Content_Types].xml");
}
async function addOverride(doc, part, mime) {
  const d = await contentTypes(doc);
  const e = d.createElementNS(CTNS, "Override");
  e.setAttribute("PartName", "/" + part); e.setAttribute("ContentType", mime);
  d.documentElement.append(e);
  markDirty(doc, "[Content_Types].xml");
}
async function removeOverride(doc, part) {
  const d = await contentTypes(doc);
  for (const e of [...d.documentElement.children]) if (e.getAttribute("PartName") === "/" + part) e.remove();
  markDirty(doc, "[Content_Types].xml");
}
async function addRel(doc, source, type, targetAbs) {
  const rp = relsPath(source);
  let d = await doc.read(rp);
  if (!d) {
    d = parser().parseFromString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PRNS}"></Relationships>`, "application/xml");
    doc.xml.set(rp, d);
  }
  const ids = new Set([...d.documentElement.children].map(r => r.getAttribute("Id")));
  let n = ids.size + 1;
  while (ids.has("rId" + n)) n++;
  const r = d.createElementNS(PRNS, "Relationship");
  // destinazione relativa alla cartella della parte
  const from = source.split("/").slice(0, -1), to = targetAbs.split("/");
  let k = 0;
  while (k < from.length && k < to.length - 1 && from[k] === to[k]) k++;
  const rel = [...Array(from.length - k).fill(".."), ...to.slice(k)].join("/");
  r.setAttribute("Id", "rId" + n); r.setAttribute("Type", type); r.setAttribute("Target", rel);
  d.documentElement.append(r);
  markDirty(doc, rp);
  return "rId" + n;
}
export async function addImagePart(doc, page, bytes, ext) {
  ext = ext.toLowerCase() === "jpeg" ? "jpg" : ext.toLowerCase();
  let n = 1;
  while (doc.zip.file(`visio/media/image${n}.${ext}`)) n++;
  const path = `visio/media/image${n}.${ext}`;
  doc.zip.file(path, bytes, NOF);
  await ensureDefaultType(doc, ext, ext === "jpg" ? "image/jpeg" : "image/" + ext);
  const rid = await addRel(doc, page.path, REL_IMAGE, path);
  page.rels = await doc.rels(page.path);
  doc.media.delete(path);
  return { rid, path };
}

export async function addPage(doc, name, after = null, like = null) {
  const px = await doc.read(doc.pagesPath);
  let n = 1;
  while (doc.zip.file(`visio/pages/page${n}.xml`) || doc.xml.has(`visio/pages/page${n}.xml`)) n++;
  const path = `visio/pages/page${n}.xml`;
  const pd = parser().parseFromString(`<?xml version='1.0' encoding='utf-8' ?><PageContents xmlns='${VNS}' xmlns:r='${RNS}' xml:space='preserve'/>`, "application/xml");
  doc.xml.set(path, pd);
  markDirty(doc, path);
  await addOverride(doc, path, CT_PAGE);
  const rid = await addRel(doc, doc.pagesPath, REL_PAGE, path);
  const ids = doc.pages.map(p => +p.id || 0);
  const id = String(Math.max(-1, ...ids) + 1);
  const pe = px.createElementNS(VNS, "Page");
  pe.setAttribute("ID", id); pe.setAttribute("NameU", name); pe.setAttribute("Name", name);
  const src = like ? kid(like.el, "PageSheet") : null;
  const ps = src ? src.cloneNode(true) : px.createElementNS(VNS, "PageSheet");
  if (!src) {
    ps.setAttribute("LineStyle", "0"); ps.setAttribute("FillStyle", "0"); ps.setAttribute("TextStyle", "0");
    for (const [k, v, u] of [["PageWidth", 8.26771653543307, "MM"], ["PageHeight", 11.69291338582677, "MM"], ["PageScale", 0.03937007874015748, "MM"], ["DrawingScale", 0.03937007874015748, "MM"], ["DrawingSizeType", 0], ["DrawingScaleType", 0], ["PageShapeSplit", 1]]) {
      const c = px.createElementNS(VNS, "Cell"); c.setAttribute("N", k); c.setAttribute("V", fmt(v)); if (u) c.setAttribute("U", u); ps.append(c);
    }
  } else for (const se of kids(ps, "Section")) if (se.getAttribute("N") === "Layer") se.remove();
  invalidate(ps);
  pe.append(ps);
  const rel = px.createElementNS(VNS, "Rel");
  rel.setAttributeNS(RNS, "r:id", rid);
  pe.append(rel);
  const before = after ? after.el.nextElementSibling : null;
  px.documentElement.insertBefore(pe, before);
  markDirty(doc, doc.pagesPath);
  await loadPages(doc);
  return doc.pages.find(p => p.id === id);
}
export async function deletePage(doc, page) {
  const pr = await doc.read(relsPath(doc.pagesPath));
  const rid = kid(page.el, "Rel")?.getAttributeNS(RNS, "id");
  for (const r of [...pr.documentElement.children]) if (r.getAttribute("Id") === rid) r.remove();
  markDirty(doc, relsPath(doc.pagesPath));
  // le pagine che lo usavano come sfondo non ne hanno piu'
  for (const p of doc.pages) if (p.el.getAttribute("BackPage") === page.id) p.el.removeAttribute("BackPage");
  page.el.remove();
  markDirty(doc, doc.pagesPath);
  if (page.path) { doc.zip.remove(page.path); doc.zip.remove(relsPath(page.path)); doc.xml.delete(page.path); doc.dirty.delete(page.path); await removeOverride(doc, page.path); }
  await loadPages(doc);
}

// ------------------------------------------------------------------ istantanee per Annulla / Ripeti
export async function snapshot(doc, extra = []) {
  const parts = new Set([doc.pagesPath, relsPath(doc.pagesPath), "[Content_Types].xml", ...doc.pages.map(p => p.path).filter(Boolean), ...extra]);
  const snap = {};
  for (const p of parts) { const d = doc.xml.get(p) || await doc.read(p); snap[p] = d ? new XMLSerializer().serializeToString(d) : null; }
  return snap;
}
export async function restore(doc, snap) {
  for (const [p, s] of Object.entries(snap)) {
    if (s == null) { doc.xml.delete(p); continue; }
    doc.xml.set(p, parser().parseFromString(s, "application/xml"));
    doc.dirty.add(p);
  }
  // pagine create dopo l'istantanea: la parte resta nel pacchetto solo se ancora collegata
  await loadPages(doc);
  for (const p of [...doc.xml.keys()]) if (/^visio\/pages\/page\d+\.xml$/.test(p) && !doc.pages.some(P => P.path === p)) { doc.xml.delete(p); doc.dirty.delete(p); doc.zip.remove(p); }
}

// ================================================================== diagramma vuoto (Crea nuovo)
// Pacchetto minimo con le parti richieste da Visio: tipi di contenuto, relazioni, proprieta', documento con gli stili
// di base (Nessuno stile, Normale, Connettore, Testo), una pagina A4 verticale in millimetri, finestre.
export async function blankVsdx() {
  const Z = await jszip();
  const z = new Z();
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  z.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${CTNS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/visio/document.xml" ContentType="application/vnd.ms-visio.drawing.main+xml"/><Override PartName="/visio/pages/pages.xml" ContentType="application/vnd.ms-visio.pages+xml"/><Override PartName="/visio/pages/page1.xml" ContentType="application/vnd.ms-visio.page+xml"/><Override PartName="/visio/windows.xml" ContentType="application/vnd.ms-visio.windows+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`, NOF);
  z.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PRNS}"><Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/document" Target="visio/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`, NOF);
  z.file("docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title></dc:title><dc:creator></dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified><dc:language>it-IT</dc:language></cp:coreProperties>`, NOF);
  z.file("docProps/app.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Template></Template><Application>MB Visual</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Pagine</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>Pagina-1</vt:lpstr></vt:vector></TitlesOfParts><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion></Properties>`, NOF);
  const C = (n, v, f, u) => `<Cell N='${n}' V='${v}'${u ? ` U='${u}'` : ""}${f ? ` F='${f}'` : ""}/>`;
  const noStyle = [C("EnableLineProps", 1), C("EnableFillProps", 1), C("EnableTextProps", 1), C("HideForApply", 0), C("LineWeight", 0.01041666666666667), C("LineColor", 0), C("LinePattern", 1), C("Rounding", 0),
    C("EndArrowSize", 2), C("BeginArrow", 0), C("EndArrow", 0), C("LineCap", 0), C("BeginArrowSize", 2), C("LineColorTrans", 0), C("CompoundType", 0), C("FillForegnd", 1), C("FillBkgnd", 0), C("FillPattern", 1),
    C("ShdwForegnd", 0), C("ShdwPattern", 0), C("FillForegndTrans", 0), C("FillBkgndTrans", 0), C("ShdwForegndTrans", 0), C("ShapeShdwType", 0), C("ShapeShdwOffsetX", 0), C("ShapeShdwOffsetY", 0),
    C("ShapeShdwObliqueAngle", 0), C("ShapeShdwScaleFactor", 1), C("ShapeShdwBlur", 0), C("ShapeShdwShow", 0), C("LeftMargin", 0), C("RightMargin", 0), C("TopMargin", 0), C("BottomMargin", 0), C("VerticalAlign", 1),
    C("TextBkgnd", 0), C("DefaultTabStop", 0.5), C("TextDirection", 0), C("TextBkgndTrans", 0), C("LockTextEdit", 0), C("LockDelete", 0), C("ObjType", 0), C("LangID", "it-IT"), C("LayerMember", ""),
    C("QuickStyleLineColor", 100), C("QuickStyleFillColor", 100), C("QuickStyleShadowColor", 100), C("QuickStyleFontColor", 100), C("QuickStyleLineMatrix", 100), C("QuickStyleFillMatrix", 100),
    C("QuickStyleEffectsMatrix", 100), C("QuickStyleFontMatrix", 100), C("QuickStyleType", 0), C("QuickStyleVariation", 0), C("LineGradientEnabled", 0), C("FillGradientEnabled", 0)].join("")
    + `<Section N='Character'><Row IX='0'>${C("Font", "Calibri")}${C("Color", 0)}${C("Style", 0)}${C("Case", 0)}${C("Pos", 0)}${C("FontScale", 1)}${C("Size", 0.1666666666666667)}${C("DblUnderline", 0)}${C("Overline", 0)}${C("Strikethru", 0)}${C("DoubleStrikethrough", 0)}${C("Letterspace", 0)}${C("ColorTrans", 0)}${C("LangID", "it-IT")}</Row></Section>`
    + `<Section N='Paragraph'><Row IX='0'>${C("IndFirst", 0)}${C("IndLeft", 0)}${C("IndRight", 0)}${C("SpLine", -1.2)}${C("SpBefore", 0)}${C("SpAfter", 0)}${C("HorzAlign", 1)}${C("Bullet", 0)}${C("BulletStr", "")}${C("BulletFont", 0)}${C("TextPosAfterBullet", 0)}${C("BulletSize", 0)}${C("BulletFontSize", -1)}${C("Flags", 0)}</Row></Section>`;
  z.file("visio/document.xml", `<?xml version='1.0' encoding='utf-8' ?>
<VisioDocument xmlns='${VNS}' xmlns:r='${RNS}' xml:space='preserve'><DocumentSettings TopPage='0' DefaultTextStyle='3' DefaultLineStyle='3' DefaultFillStyle='3' DefaultGuideStyle='4'><GlueSettings>9</GlueSettings><SnapSettings>65847</SnapSettings><SnapExtensions>34</SnapExtensions><SnapAngles/><DynamicGridEnabled>1</DynamicGridEnabled><ProtectStyles>0</ProtectStyles><ProtectShapes>0</ProtectShapes><ProtectMasters>0</ProtectMasters><ProtectBkgnds>0</ProtectBkgnds></DocumentSettings>`
    + `<Colors>${PALETTE.map((c, i) => `<ColorEntry IX='${i}' RGB='${c.toUpperCase()}'/>`).join("")}</Colors><FaceNames><FaceName NameU='Calibri' UnicodeRanges='-536859905 -1073732485 9 0' CharSets='536871423 0' Panose='2 15 5 2 2 2 4 3 2 4' Flags='325'/></FaceNames>`
    + `<StyleSheets><StyleSheet ID='0' NameU='No Style' IsCustomNameU='1' Name='Nessuno stile' IsCustomName='1'>${noStyle}</StyleSheet>`
    + `<StyleSheet ID='1' NameU='None' IsCustomNameU='1' Name='Nessuno' IsCustomName='1' LineStyle='0' FillStyle='0' TextStyle='0'>${C("LinePattern", 0)}${C("FillPattern", 0)}</StyleSheet>`
    + `<StyleSheet ID='3' NameU='Normal' IsCustomNameU='1' Name='Normale' IsCustomName='1' LineStyle='6' FillStyle='6' TextStyle='6'>${C("LeftMargin", 0.05555555555555555, "", "PT")}${C("RightMargin", 0.05555555555555555, "", "PT")}${C("TopMargin", 0.05555555555555555, "", "PT")}${C("BottomMargin", 0.05555555555555555, "", "PT")}</StyleSheet>`
    + `<StyleSheet ID='4' NameU='Guide' IsCustomNameU='1' Name='Guida' IsCustomName='1' LineStyle='0' FillStyle='0' TextStyle='0'>${C("LineWeight", 0, "", "PT")}${C("LineColor", "#7f7f7f")}${C("LinePattern", 23)}${C("FillPattern", 0)}</StyleSheet>`
    + `<StyleSheet ID='6' NameU='Theme' IsCustomNameU='1' Name='Tema' IsCustomName='1' LineStyle='0' FillStyle='0' TextStyle='0'>${C("LineColor", "#41719c")}${C("FillForegnd", "#5b9bd5")}${C("LineWeight", 0.01041666666666667, "", "PT")}<Section N='Character'><Row IX='0'>${C("Color", "#ffffff")}</Row></Section></StyleSheet>`
    + `<StyleSheet ID='7' NameU='Connector' IsCustomNameU='1' Name='Connettore' IsCustomName='1' LineStyle='3' FillStyle='3' TextStyle='3'>${C("LineColor", "#5b9bd5")}${C("EndArrow", 13)}${C("FillPattern", 0)}<Section N='Character'><Row IX='0'>${C("Color", "#000000")}${C("Size", 0.1111111111111111, "", "PT")}</Row></Section></StyleSheet>`
    + `<StyleSheet ID='8' NameU='Text Only' IsCustomNameU='1' Name='Solo testo' IsCustomName='1' LineStyle='3' FillStyle='3' TextStyle='3'>${C("LinePattern", 0)}${C("FillPattern", 0)}<Section N='Character'><Row IX='0'>${C("Color", "#000000")}</Row></Section></StyleSheet></StyleSheets>`
    + `<DocumentSheet NameU='TheDoc' IsCustomNameU='1' Name='TheDoc' IsCustomName='1' LineStyle='0' FillStyle='0' TextStyle='0'>${C("OutputFormat", 0)}${C("LockPreview", 0)}${C("AddMarkup", 0)}${C("ViewMarkup", 0)}${C("DocLockReplace", 0, "", "BOOL")}${C("NoCoauth", 0, "", "BOOL")}${C("DocLockDuplicatePage", 0, "", "BOOL")}${C("PreviewQuality", 0)}${C("PreviewScope", 0)}${C("DocLangID", "it-IT")}</DocumentSheet></VisioDocument>`, NOF);
  z.file("visio/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PRNS}"><Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/pages" Target="pages/pages.xml"/><Relationship Id="rId2" Type="http://schemas.microsoft.com/visio/2010/relationships/windows" Target="windows.xml"/></Relationships>`, NOF);
  z.file("visio/pages/pages.xml", `<?xml version='1.0' encoding='utf-8' ?>
<Pages xmlns='${VNS}' xmlns:r='${RNS}' xml:space='preserve'><Page ID='0' NameU='Page-1' IsCustomNameU='1' Name='Pagina-1' IsCustomName='1' ViewScale='-1' ViewCenterX='4.1338582677165' ViewCenterY='5.8464566929134'><PageSheet LineStyle='0' FillStyle='0' TextStyle='0'>${C("PageWidth", 8.26771653543307, "", "MM")}${C("PageHeight", 11.69291338582677, "", "MM")}${C("ShdwOffsetX", 0.1181102362204724, "", "MM")}${C("ShdwOffsetY", -0.1181102362204724, "", "MM")}${C("PageScale", 0.03937007874015748, "", "MM")}${C("DrawingScale", 0.03937007874015748, "", "MM")}${C("DrawingSizeType", 0)}${C("DrawingScaleType", 0)}${C("InhibitSnap", 0)}${C("PageLockReplace", 0, "", "BOOL")}${C("PageLockDuplicate", 0, "", "BOOL")}${C("UIVisibility", 0)}${C("ShdwType", 0)}${C("ShdwObliqueAngle", 0)}${C("ShdwScaleFactor", 1)}${C("DrawingResizeType", 1)}${C("PageShapeSplit", 1)}${C("PrintPageOrientation", 1)}${C("PaperKind", 9)}</PageSheet><Rel r:id='rId1'/></Page></Pages>`, NOF);
  z.file("visio/pages/_rels/pages.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PRNS}"><Relationship Id="rId1" Type="${REL_PAGE}" Target="page1.xml"/></Relationships>`, NOF);
  z.file("visio/pages/page1.xml", `<?xml version='1.0' encoding='utf-8' ?>
<PageContents xmlns='${VNS}' xmlns:r='${RNS}' xml:space='preserve'/>`, NOF);
  z.file("visio/windows.xml", `<?xml version='1.0' encoding='utf-8' ?>
<Windows ClientWidth='1600' ClientHeight='900' xmlns='${VNS}' xmlns:r='${RNS}' xml:space='preserve'><Window ID='0' WindowType='Drawing' WindowState='1073741824' WindowLeft='-8' WindowTop='-31' WindowWidth='1616' WindowHeight='939' ContainerType='Page' Page='0' ViewScale='-1' ViewCenterX='4.1338582677165' ViewCenterY='5.8464566929134'><ShowRulers>1</ShowRulers><ShowGrid>1</ShowGrid><ShowPageBreaks>0</ShowPageBreaks><ShowGuides>1</ShowGuides><ShowConnectionPoints>1</ShowConnectionPoints><GlueSettings>9</GlueSettings><SnapSettings>65847</SnapSettings><SnapExtensions>34</SnapExtensions><SnapAngles/><DynamicGridEnabled>1</DynamicGridEnabled><TabSplitterPos>0.5</TabSplitterPos></Window></Windows>`, NOF);
  return await z.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
