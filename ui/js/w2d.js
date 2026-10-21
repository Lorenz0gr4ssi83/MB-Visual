// Lettore dei flussi W2D (WHIP!, grafica 2D dei DWF), scritto da zero seguendo la specifica pubblicata da Autodesk
// ("WHIP! Data Format", DWF Toolkit 6). Produce primitive in coordinate logiche (interi a 31 bit, y verso l'alto):
//   { t: "p", rings: [[x,y,x,y...], ...], closed, fill, color:[r,g,b,a], lw, dash, layer, node, url, clip }
//   { t: "x", x, y, s, h, rot, ws, obl, font, bold, italic, color, layer, node, hidden, bounds }
//   { t: "i", x1, y1, x2, y2, mime, bytes | rgba:{w,h,data}, layer, node, clip }
// e le informazioni del disegno (unita', vista, layer, nodi, collegamenti).
import { inflate } from "./inflate.js";
import { preload, ZLIB_DICT_LEN } from "./w2dpreload.js";

// tavolozza predefinita (versioni >= 0.38): 10 colori di sistema, cubo 6x6x6, 20 grigi, 10 colori finali
const DEFAULT_MAP = (() => {
  const m = [[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192], [192, 220, 192], [166, 202, 240]];
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) m.push([r * 51, g * 51, b * 51]);
  for (let k = 0; k < 20; k++) { const v = Math.round(k * 255 / 19); m.push([v, v, v]); }
  m.push([255, 251, 240], [160, 160, 164], [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255]);
  return m.map(c => [...c, 255]);
})();

// motivi di linea predefiniti (in pixel dello schermo, come li disegnano i visualizzatori DWF)
const PATTERNS = {
  2: [12, 6], 3: [1.5, 4.5], 4: [12, 4, 1.5, 4], 5: [6, 4], 6: [12, 4], 7: [24, 6], 8: [6, 4, 6, 10], 9: [12, 4, 12, 10],
  10: [24, 6, 24, 12], 11: [18, 4, 12, 4], 12: [12, 4, 6, 4, 6, 4], 13: [24, 4, 6, 4], 14: [24, 4, 1.5, 4, 1.5, 4], 15: [24, 4, 1.5, 4],
  16: [12, 4, 1.5, 4, 6, 4, 1.5, 4], 17: [1.5, 12], 18: [12, 3], 19: [12, 9], 20: [24, 3, 1.5, 3], 21: [24, 3, 1.5, 3, 1.5, 3],
  22: [24, 3, 1.5, 3, 1.5, 3, 1.5, 3], 23: [1.5, 3], 24: [24, 3, 6, 3], 25: [24, 3, 6, 3, 6, 3], 26: [12, 3, 1.5, 3],
  27: [12, 3, 12, 3, 1.5, 3], 28: [12, 3, 1.5, 3, 1.5, 3], 29: [12, 3, 12, 3, 1.5, 3, 1.5, 3], 30: [12, 3, 1.5, 3, 1.5, 3, 1.5, 3],
  31: [12, 3, 12, 3, 1.5, 3, 1.5, 3, 1.5, 3],
};
const PATTERN_NAMES = ["", "solid", "dashed", "dotted", "dash_dot", "short_dash", "medium_dash", "long_dash", "short_dash_x2", "medium_dash_x2", "long_dash_x2",
  "medium_long_dash", "medium_dash_short_dash_short_dash", "long_dash_short_dash", "long_dash_dot_dot", "long_dash_dot", "medium_dash_dot_short_dash_dot",
  "sparse_dot", "iso_dash", "iso_dash_space", "iso_long_dash_dot", "iso_long_dash_double_dot", "iso_long_dash_triple_dot", "iso_dot", "iso_long_dash_short_dash",
  "iso_long_dash_double_short_dash", "iso_dash_dot", "iso_double_dash_dot", "iso_dash_double_dot", "iso_double_dash_double_dot", "iso_dash_triple_dot", "iso_double_dash_triple_dot"];
const FAMILY = { 1: "serif", 2: "sans-serif", 3: "monospace", 4: "cursive", 5: "fantasy" };
const ANG = Math.PI * 2 / 65536;
const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

/** Testo MTEXT di AutoCAD ({\L...\P...}) -> testo semplice; \P = a capo */
export function plainMtext(s) {
  if (!/[\\{}]/.test(s)) return s;
  return s.replace(/\\[Pp]/g, "\n").replace(/\\[fFcCHhTtQqWwAa][^;\\]*;/g, "").replace(/\\S([^;]*);/g, (m, a) => a.replace(/[#^]/, "/"))
    .replace(/\\[LlOoKkNn]/g, "").replace(/\\~/g, " ").replace(/\\([\\{}])/g, "$1").replace(/[{}]/g, "").replace(/%%[cC]/g, "Ø").replace(/%%[dD]/g, "°").replace(/%%[pP]/g, "±");
}

/** Legge un flusso W2D. bytes: Uint8Array (con l'intestazione "(W2D V06.00)" o "(DWF V0x.yy)") */
export function parseW2D(bytes, opts = {}) {
  let buf = bytes, p = 0, view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const prims = [];
  const info = { version: "", units: null, view: null, plotInfo: null, layers: new Map(), nodes: new Map(), urls: new Map(), meta: {}, viewports: [], unknown: new Map(), warnings: [] };
  const head = String.fromCharCode(...buf.subarray(0, 12));
  const mh = /^\((W2D|DWF) V(\d\d)\.(\d\d)\)/.exec(head);
  if (!mh) throw new Error("Il flusso non e' un W2D/DWF valido");
  info.version = mh[2] + "." + mh[3];
  const verNum = +mh[2] * 100 + +mh[3];
  p = 12;

  // ---- stato degli attributi
  const st = {
    color: [255, 255, 255, 255], map: DEFAULT_MAP, fill: false, visible: true, lw: 0, layer: 0, node: 0, url: null, dash: null, patScale: 1,
    font: { name: "Arial", h: 0, rot: 0, ws: 1, sp: 1, obl: 0, flags: 0, bold: false, italic: false, family: 0 },
    cap: "round", join: "round", clip: null, fillPat: 0,
  };
  let cx = 0, cy = 0; // punto corrente per le coordinate relative

  // ---- lettura dei tipi elementari
  const need = n => { if (p + n > buf.length) throw new RangeError("fine dei dati"); };
  const B = () => { need(1); return buf[p++]; };
  const S = () => { need(2); const v = view.getInt16(p, true); p += 2; return v; };
  const US = () => { need(2); const v = view.getUint16(p, true); p += 2; return v; };
  const L = () => { need(4); const v = view.getInt32(p, true); p += 4; return v; };
  const UL = () => { need(4); const v = view.getUint32(p, true); p += 4; return v; };
  const count = () => { const c = B(); return c === 0 ? 256 + US() : c; };
  // somme a 32 bit senza segno: i programmi di pubblicazione usano coordinate attorno a 2^31 e passi che "girano"
  const rel16 = () => { cx = (cx + S()) >>> 0; cy = (cy + S()) >>> 0; return [cx, cy]; };
  const rel32 = () => { cx = (cx + L()) >>> 0; cy = (cy + L()) >>> 0; return [cx, cy]; };
  const pts = (n, rd) => { const a = new Array(n * 2); for (let i = 0; i < n; i++) { const [x, y] = rd(); a[2 * i] = x; a[2 * i + 1] = y; } return a; };
  const skipWs = () => { while (p < buf.length && WS.has(buf[p])) p++; };
  // intero ASCII
  const I = () => {
    skipWs();
    let s = p;
    if (buf[p] === 0x2d || buf[p] === 0x2b) p++;
    while (p < buf.length && buf[p] >= 0x30 && buf[p] <= 0x39) p++;
    return parseInt(String.fromCharCode(...buf.subarray(s, p)), 10) || 0;
  };
  const Ipt = () => { const x = I(); if (buf[p] === 0x2c) p++; const y = I(); return [x, y]; };
  // stringa <T>: 'ascii' con \ di escape, "unicode esadecimale" oppure parola senza spazi
  const T = () => {
    skipWs();
    const c = buf[p];
    if (c === 0x27) {
      p++;
      const out = [];
      while (p < buf.length && buf[p] !== 0x27) { if (buf[p] === 0x5c && p + 1 < buf.length) p++; out.push(buf[p++]); }
      p++;
      return decodeAnsi(out);
    }
    if (c === 0x22) {
      p++;
      // forma binaria: conteggio a 16 bit seguito da caratteri UTF-16; forma testuale: cifre esadecimali
      const hexEnd = scanHex(buf, p);
      if (hexEnd >= 0) { const s = hexToUtf16(buf.subarray(p, hexEnd)); p = hexEnd + 1; return s; }
      const n = US();
      let s = "";
      for (let i = 0; i < n; i++) s += String.fromCharCode(US());
      if (buf[p] === 0x22) p++;
      return s;
    }
    const s = p;
    while (p < buf.length && !WS.has(buf[p]) && buf[p] !== 0x28 && buf[p] !== 0x29) p++;
    return decodeAnsi(buf.subarray(s, p));
  };

  // ---- emissione delle primitive
  const base = () => ({ layer: st.layer, node: st.node, url: st.url, clip: st.clip });
  const lineProps = () => ({ color: st.color, lw: st.lw, dash: st.dash, dashScale: st.patScale, cap: st.cap, join: st.join });
  function path(rings, closed, fill) {
    if (!st.visible) return;
    prims.push({ t: "p", rings, closed: !!closed || !!fill, fill: !!fill, fillPat: fill ? st.fillPat : 0, ...lineProps(), ...base() });
  }
  function polyline(a) {
    if (st.fill && a.length >= 6) path([a], true, true);
    else if (a.length === 2) path([[a[0], a[1], a[0], a[1]]], false, false);
    else path([a], false, false);
  }
  function arcPts(x, y, rx, ry, a0, a1, tilt) {
    // a0..a1 in radianti, antiorario; ellisse ruotata di tilt
    let sw = a1 - a0;
    if (sw <= 0) sw += Math.PI * 2;
    const n = Math.max(8, Math.min(720, Math.ceil(sw / (Math.PI * 2) * 128 * Math.max(1, Math.log2(Math.max(rx, ry) / 256 + 1)))));
    const ct = Math.cos(tilt), sn = Math.sin(tilt), out = new Array((n + 1) * 2);
    for (let i = 0; i <= n; i++) {
      const a = a0 + sw * i / n, ex = rx * Math.cos(a), ey = ry * Math.sin(a);
      out[2 * i] = x + ex * ct - ey * sn;
      out[2 * i + 1] = y + ex * sn + ey * ct;
    }
    return out;
  }
  function ellipse(x, y, rx, ry, s, e, tilt) {
    const full = s === e || (s === 0 && e >= 65535);
    const a = full ? arcPts(x, y, rx, ry, 0, Math.PI * 2, tilt * ANG) : arcPts(x, y, rx, ry, s * ANG, e * ANG, tilt * ANG);
    if (st.fill) { if (!full) a.push(x, y); path([a], true, true); }
    else path([a], full, false);
  }
  function triStrip(a) {
    if (!st.visible || a.length < 6) return;
    const rings = [];
    for (let i = 0; i + 5 < a.length; i += 2) rings.push([a[i], a[i + 1], a[i + 2], a[i + 3], a[i + 4], a[i + 5]]);
    prims.push({ t: "p", rings, closed: true, fill: true, nonzero: true, color: st.color, lw: 0, ...base() });
  }
  function gouraudTris(v) { // v: [x,y,color][]
    if (!st.visible) return;
    for (let i = 0; i + 2 < v.length; i++) {
      const c = [0, 1, 2, 3].map(k => Math.round((v[i][2][k] + v[i + 1][2][k] + v[i + 2][2][k]) / 3));
      prims.push({ t: "p", rings: [[v[i][0], v[i][1], v[i + 1][0], v[i + 1][1], v[i + 2][0], v[i + 2][1]]], closed: true, fill: true, color: c, lw: 0, ...base() });
    }
  }
  function gouraudLine(v) {
    if (!st.visible) return;
    for (let i = 0; i + 1 < v.length; i++) prims.push({ t: "p", rings: [[v[i][0], v[i][1], v[i + 1][0], v[i + 1][1]]], closed: false, fill: false, ...lineProps(), color: v[i][2], ...base() });
  }
  function bezier(x0, y0, segs) { // segs: [c1x,c1y,c2x,c2y,ex,ey]...
    const a = [x0, y0];
    let px = x0, py = y0;
    for (const [c1x, c1y, c2x, c2y, ex, ey] of segs) {
      const n = 16;
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t;
        a.push(u * u * u * px + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex, u * u * u * py + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey);
      }
      px = ex; py = ey;
    }
    if (st.fill) path([a], true, true); else path([a], false, false);
  }
  function contour(counts, a) {
    const rings = [];
    let k = 0;
    for (const n of counts) { rings.push(a.slice(k, k + n * 2)); k += n * 2; }
    if (st.visible) prims.push({ t: "p", rings, closed: true, fill: true, fillPat: st.fillPat, color: st.color, lw: 0, ...base() });
  }
  function markers(a) {
    if (!st.visible) return;
    for (let i = 0; i < a.length; i += 2) prims.push({ t: "m", x: a[i], y: a[i + 1], color: st.color, ...base() });
  }
  function text(x, y, s, bounds) {
    const f = st.font;
    prims.push({
      t: "x", x, y, s: plainMtext(s), raw: s, h: f.h, rot: f.rot * ANG, ws: f.ws, sp: f.sp, obl: f.obl * ANG, font: f.name, family: f.family,
      bold: f.bold, italic: f.italic, flags: f.flags, color: st.color, hidden: !st.visible, bounds, ...base(),
    });
  }
  function image(kind, col, row, x1, y1, x2, y2, data, cmap) {
    const pr = { t: "i", x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2), w: col, h: row, ...base() };
    if (kind === "png") pr.mime = "image/png";
    else if (kind === "jpeg") pr.mime = "image/jpeg";
    else if (kind === "tiff") pr.mime = "image/tiff"; // Group 4: non decodificato (riquadro segnaposto)
    if (pr.mime) pr.bytes = data;
    else {
      const px = new Uint8ClampedArray(col * row * 4);
      if (kind === "rgb" || kind === "rgba") {
        const k = kind === "rgb" ? 3 : 4;
        for (let i = 0, n = Math.min(col * row, Math.floor(data.length / k)); i < n; i++) {
          px[4 * i] = data[k * i]; px[4 * i + 1] = data[k * i + 1]; px[4 * i + 2] = data[k * i + 2]; px[4 * i + 3] = k === 4 ? data[k * i + 3] : 255;
        }
      } else if (kind === "mapped" || kind === "indexed") {
        const m = kind === "indexed" ? st.map : cmap;
        for (let i = 0, n = Math.min(col * row, data.length); i < n; i++) { const c = m[data[i]] || [0, 0, 0, 255]; px.set(c, 4 * i); }
      } else if (kind === "bitonal") {
        const stride = Math.ceil(col / 8);
        for (let r = 0; r < row; r++) for (let c = 0; c < col; c++) {
          const v = (data[r * stride + (c >> 3)] >> (7 - (c & 7))) & 1;
          px.set(cmap[v] || [v * 255, v * 255, v * 255, 255], 4 * (r * col + c));
        }
      } else return;
      pr.rgba = { w: col, h: row, data: px };
    }
    prims.push(pr);
  }

  // ---- opcode ASCII estesi: albero di elementi (nome, argomenti), le stringhe restano stringhe
  function readExtAscii() {
    // p e' subito dopo "("
    let s = p;
    while (p < buf.length && !WS.has(buf[p]) && buf[p] !== 0x28 && buf[p] !== 0x29) p++;
    const name = String.fromCharCode(...buf.subarray(s, p));
    return { name, args: readArgs() };
  }
  function readArgs() {
    const args = [];
    for (;;) {
      while (p < buf.length && (WS.has(buf[p]) || buf[p] === 0x2c)) p++;
      if (p >= buf.length) return args;
      const c = buf[p];
      if (c === 0x29) { p++; return args; }
      if (c === 0x28) { p++; const s = p; while (p < buf.length && !WS.has(buf[p]) && buf[p] !== 0x28 && buf[p] !== 0x29) p++; const name = String.fromCharCode(...buf.subarray(s, p)); args.push({ name, args: readArgs() }); continue; }
      if (c === 0x27 || c === 0x22) { args.push(T()); continue; }
      if (c === 0x7b) { // dati binari annidati: si saltano con la loro lunghezza
        const len = view.getUint32(p + 1, true);
        args.push({ name: "{}", bytes: buf.subarray(p + 5, p + 5 + Math.max(0, len - 1)) });
        p += 5 + len;
        continue;
      }
      const s = p;
      while (p < buf.length && !WS.has(buf[p]) && buf[p] !== 0x28 && buf[p] !== 0x29 && buf[p] !== 0x2c) p++;
      args.push(decodeAnsi(buf.subarray(s, p)));
    }
  }
  const num = v => (typeof v === "string" ? parseFloat(v) : NaN);
  const nums = args => args.filter(a => typeof a === "string").map(Number);
  const sub = (args, n) => args.find(a => typeof a === "object" && a.name && a.name.toLowerCase() === n.toLowerCase());
  const matrix = args => { // ((a b c d)(...)...)
    const m = args.find(a => typeof a === "object" && !a.name?.match(/[a-z]/i)) || args.find(a => typeof a === "object");
    if (!m) return null;
    const rows = [m.name ? { args: [m.name, ...m.args] } : m, ...(m.args || []).filter(a => typeof a === "object")];
    // forma ((r0)(r1)(r2)(r3)): il primo gruppo contiene gli altri
    const flat = [];
    const walk = node => { if (typeof node === "string") { if (node !== "") flat.push(+node); } else { if (node.name && node.name !== "{}") flat.push(+node.name); for (const a of node.args || []) walk(a); } };
    walk(m);
    return flat.filter(v => !isNaN(v));
  };

  function doExtAscii(op) {
    const n = op.name, a = op.args;
    switch (n) {
      case "Color": { const v = nums(a); if (v.length >= 3) st.color = [v[0], v[1], v[2], v[3] ?? 255]; else if (v.length === 1) st.color = st.map[v[0]] || st.color; break; }
      case "ColorMap": { const v = nums(a); const k = v[0], m = []; for (let i = 0; i < k; i++) m.push(v.slice(1 + 4 * i, 5 + 4 * i)); if (m.length) st.map = m; break; }
      case "Background": { const v = nums(a); info.background = v.length >= 3 ? v.slice(0, 4) : st.map[v[0]] || null; break; }
      case "LineWeight": st.lw = Math.abs(num(a[0]) || 0); break;
      case "LinePattern": { const i = PATTERN_NAMES.indexOf(String(a[0] || "").toLowerCase()); st.dash = PATTERNS[i] || null; break; }
      case "DashPattern": { const v = nums(a); st.dash = v[0] === -1 || v.length < 3 ? null : v.slice(1); break; }
      case "LineStyle": {
        for (const o of a) {
          if (typeof o !== "object") continue;
          const v = String(o.args[0] || "").toLowerCase();
          if (o.name === "LineJoin") st.join = v === "miter" ? "miter" : v === "bevel" ? "bevel" : "round";
          else if (o.name === "LineStartCap" || o.name === "LineEndCap") st.cap = v === "butt" ? "butt" : v === "square" ? "square" : "round";
          else if (o.name === "LinePatternScale") st.patScale = +v || 1;
        }
        break;
      }
      case "Layer": {
        const num0 = parseInt(a[0], 10);
        if (!isNaN(num0)) { st.layer = num0; if (a.length > 1) info.layers.set(num0, String(a.slice(1).filter(x => typeof x === "string").join(" "))); else if (!info.layers.has(num0) && num0) info.layers.set(num0, "Layer " + num0); }
        break;
      }
      case "Node": { const v = parseInt(a[0], 10); if (!isNaN(v)) { st.node = v; if (a.length > 1 && typeof a[1] === "string") info.nodes.set(v, a[1]); } break; }
      case "URL": {
        if (!a.length) { st.url = null; break; }
        const list = [];
        for (const o of a) {
          if (typeof o === "object") { const idx = parseInt(o.name, 10); const addr = o.args[0], label = o.args[1]; if (!isNaN(idx) && addr !== undefined) info.urls.set(idx, { href: addr, name: label || addr }); if (info.urls.has(idx)) list.push(info.urls.get(idx)); }
          else { const idx = parseInt(o, 10); if (info.urls.has(idx)) list.push(info.urls.get(idx)); }
        }
        st.url = list.length ? list : null;
        break;
      }
      case "Font": {
        const f = st.font = { ...st.font };
        for (const o of a) {
          if (typeof o !== "object") continue;
          const v = o.args.filter(x => typeof x === "string");
          switch (o.name) {
            case "Name": f.name = v.join(" ") || f.name; break;
            case "Height": f.h = +v[0] || f.h; break;
            case "Rotation": f.rot = +v[0] || 0; break;
            case "Widthscale": f.ws = (+v[0] || 1024) / 1024; break;
            case "Spacing": f.sp = (+v[0] || 1024) / 1024; break;
            case "Oblique": f.obl = +v[0] || 0; break;
            case "Flags": f.flags = +v[0] || 0; break;
            case "Style": f.bold = v.some(s => /bold/i.test(s)); f.italic = v.some(s => /italic/i.test(s)); break;
            case "Family": f.family = { roman: 1, swiss: 2, modern: 3, script: 4, decorative: 5 }[String(v[0]).toLowerCase()] || 0; break;
            default: break;
          }
        }
        break;
      }
      case "Text": {
        const [x, y] = [num(a[0]), num(a[1])];
        const s = typeof a[2] === "string" ? a[2] : "";
        const bo = sub(a, "Bounds");
        text(x, y, s, bo ? nums(bo.args) : null);
        break;
      }
      case "Line": { const v = nums(a); if (v.length >= 4) path([v.slice(0, 4)], false, false); break; }
      case "Circle": { const v = nums(a); if (v.length >= 3) ellipse(v[0], v[1], v[2], v[2], v[3] ?? 0, v[4] ?? 0, 0); break; }
      case "Ellipse": { const v = nums(a); if (v.length >= 4) ellipse(v[0], v[1], v[2], v[3], v[4] ?? 0, v[5] ?? 0, v[6] ?? 0); break; }
      case "Contour": {
        const v = nums(a), nc = v[0], counts = v.slice(1, 1 + nc);
        contour(counts, v.slice(1 + nc));
        break;
      }
      case "Bezier": {
        const v = nums(a), segs = [];
        for (let i = 3; i + 5 < v.length; i += 6) segs.push(v.slice(i, i + 6));
        bezier(v[1], v[2], segs);
        break;
      }
      case "Gouraud": {
        const v = nums(a), list = [];
        for (let i = 1; i + 5 < v.length; i += 6) list.push([v[i], v[i + 1], v.slice(i + 2, i + 6)]);
        gouraudTris(list);
        break;
      }
      case "GouraudPolyline": {
        const v = nums(a), list = [];
        for (let i = 1; i + 5 < v.length; i += 6) list.push([v[i], v[i + 1], v.slice(i + 2, i + 6)]);
        gouraudLine(list);
        break;
      }
      case "Image": case "Group4PNGImage": {
        const fmt = String(a[0] || "").toLowerCase();
        const v = nums(a.slice(1));
        const dataNode = a.find(o => typeof o === "object" && /^\d+$/.test(o.name));
        let data = new Uint8Array(0);
        if (dataNode) data = hexBytes(dataNode.args.join(""));
        const cm = sub(a, "Colormap");
        const cmap = cm ? (() => { const w = nums(cm.args), m = []; for (let i = 0; i < w[0]; i++) m.push(w.slice(1 + 4 * i, 5 + 4 * i)); return m; })() : [];
        const kind = fmt.includes("png") ? "png" : fmt.includes("jpeg") ? "jpeg" : fmt.includes("group4") ? "tiff" : fmt.includes("rgba") ? "rgba" : fmt.includes("rgb") ? "rgb" : fmt.includes("mapped") ? "mapped" : fmt.includes("indexed") ? "indexed" : fmt.includes("bitonal") ? "bitonal" : fmt;
        if (v.length >= 7) image(kind, v[1], v[2], v[3], v[4], v[5], v[6], data, cmap);
        break;
      }
      case "Units": { const m = matrix(a); info.units = { name: typeof a[0] === "string" ? a[0] : "", m }; break; }
      case "View": { const v = nums(a); if (v.length >= 4) info.view = v.slice(0, 4); break; }
      case "NamedView": { const v = nums(a); (info.namedViews ||= []).push({ box: v.slice(0, 4), name: a.filter(x => typeof x === "string").slice(4).join(" ") }); break; }
      case "PlotInfo": {
        const v = a.filter(x => typeof x === "string");
        info.plotInfo = { show: v[0], rot: +v[1], units: v[2], w: +v[3], h: +v[4], clip: v.slice(5, 9).map(Number), m: matrix(a) };
        break;
      }
      case "InkedArea": info.inked = nums(a); break;
      case "Viewport": {
        if (!a.length) { st.clip = null; break; }
        const name = typeof a[0] === "string" ? a[0] : "";
        const ct = sub(a, "Contour");
        if (ct) {
          const v = nums(ct.args), nc = v[0], counts = v.slice(1, 1 + nc), pp = v.slice(1 + nc), rings = [];
          let k = 0;
          for (const c of counts) { rings.push(pp.slice(k, k + c * 2)); k += c * 2; }
          const un = sub(a, "Units");
          const vp = { name, rings, units: un ? { name: typeof un.args[0] === "string" ? un.args[0] : "", m: matrix(un.args) } : null };
          info.viewports.push(vp);
          st.clip = vp;
        } else {
          const old = info.viewports.find(v => v.name === name);
          st.clip = old || null;
        }
        break;
      }
      case "FillPattern": { const v = parseInt(a[0], 10); st.fillPat = v > 1 ? v : 0; break; }
      case "Creator": case "Author": case "Title": case "Subject": case "Description": case "Comments": case "Keywords": case "Copyright":
      case "SourceFilename": case "Created": case "Modified": case "SourceCreated": case "SourceModified":
        info.meta[n] = a.filter(x => typeof x === "string").slice(n.endsWith("Created") || n.endsWith("Modified") ? 1 : 0, n.endsWith("Created") || n.endsWith("Modified") ? 2 : undefined).join(" ");
        break;
      case "EndOfDWF": return "end";
      default: info.unknown.set(n, (info.unknown.get(n) || 0) + 1); break;
    }
    return null;
  }

  // ---- opcode binari estesi
  function doExtBinary() {
    const len = UL(), start = p, op = US();
    const end = len ? start + len : -1;
    const done = () => { if (end >= 0) p = end; };
    switch (op) {
      case 0x0010: case 0x0123: { // compressione LZ propria del formato: il resto del flusso si sostituisce con i dati espansi
        const { data, end: e } = lzDecode(buf, p, verNum >= 23 ? preload() : null);
        let rest = e;
        if (buf[rest] === 0x7d) rest++;
        swap(data, rest);
        return;
      }
      case 0x0011: { // compressione zlib
        const { data, end: e } = inflate(buf, p, true, preload().subarray(0, ZLIB_DICT_LEN));
        let rest = e;
        while (rest < buf.length && buf[rest] !== 0x7d && rest < e + 4) rest++;
        if (buf[rest] === 0x7d) rest++;
        swap(data, rest);
        return;
      }
      case 0x0001: { const k = B() || 256, m = []; for (let i = 0; i < k; i++) { m.push([B(), B(), B(), B()]); } st.map = m; break; }
      case 0x0002: case 0x0003: case 0x0004: case 0x0005: case 0x0006: case 0x0007: case 0x0008: case 0x0009: case 0x000c: case 0x000d: {
        const col = US(), row = US();
        const [x1, y1] = rel32(), [x2, y2] = rel32(); // angoli in coordinate relative (aggiornano il punto corrente)
        L(); // identificativo
        let cmap = [];
        if (op === 0x0002 || op === 0x0003 || op === 0x0005) { const k = B() || 256; for (let i = 0; i < k; i++) cmap.push([B(), B(), B(), B()]); }
        if (op === 0x0009 || op === 0x000c) L(); // dimensione tavolozza (di solito 0)
        if (op === 0x000d) { const k = L(); for (let i = 0; i < k; i++) cmap.push([B(), B(), B(), B()]); }
        const ds = L();
        const data = buf.slice(p, p + ds);
        p += ds;
        const kind = { 2: "bitonal", 3: "group3", 4: "indexed", 5: "mapped", 6: "rgb", 7: "rgba", 8: "jpeg", 9: "tiff", 12: "png", 13: "tiff" }[op];
        if (kind !== "group3") image(kind, col, row, x1, y1, x2, y2, data, cmap);
        break;
      }
      default: info.unknown.set("{" + op.toString(16) + "}", (info.unknown.get("{" + op.toString(16) + "}") || 0) + 1); break;
    }
    if (end < 0) throw new Error("Opcode binario di lunghezza sconosciuta (" + op.toString(16) + ")");
    done();
  }
  function swap(data, rest) {
    const nb = new Uint8Array(data.length + (buf.length - rest));
    nb.set(data, 0);
    nb.set(buf.subarray(rest), data.length);
    buf = nb; p = 0; view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  // ---- ciclo principale
  let guard = 0;
  const trace = opts.trace ? [] : null;
  try {
    while (p < buf.length) {
      const op = buf[p++];
      if (WS.has(op)) continue;
      if (trace) { trace.push([op, p - 1]); if (trace.length > 16) trace.shift(); }
      switch (op) {
        case 0x28: { // (
          const o = readExtAscii();
          if (doExtAscii(o) === "end") p = buf.length;
          break;
        }
        case 0x7b: doExtBinary(); break; // {
        case 0x29: case 0x7d: break; // parentesi sciolte: si ignorano
        // ---- colore
        case 0x03: st.color = [B(), B(), B(), B()]; break;
        case 0x43: st.color = st.map[I()] || st.color; break; // C
        case 0x63: st.color = st.map[B()] || st.color; break; // c
        // ---- attributi
        case 0x46: st.fill = true; break; // F
        case 0x66: st.fill = false; break; // f
        case 0x56: st.visible = true; break; // V
        case 0x76: st.visible = false; break; // v
        case 0x17: st.lw = Math.abs(L()); break; // Ctrl-W
        case 0xac: { const v = B(); st.layer = v === 0 ? 256 + US() : v; if (!info.layers.has(st.layer)) info.layers.set(st.layer, "Layer " + st.layer); break; }
        case 0xcc: { const v = B(); const n = v === 0 ? 256 + US() : v; st.dash = PATTERNS[n] || null; break; }
        case 0x0e: st.node = st.node + 1; break; // Ctrl-N
        case 0x4e: st.node = UL(); break; // N
        case 0x6e: st.node = st.node + S(); break; // n
        case 0x4f: cx = UL(); cy = UL(); break; // O
        case 0x47: I(); break; // G (simbolo)
        case 0x87: US(); break;
        case 0x53: I(); break; // S (dimensione simbolo)
        case 0x73: UL(); break; // s
        case 0x06: { // Ctrl-F: carattere
          const fields = US(), f = st.font = { ...st.font };
          if (fields & 0x0001) f.name = T() || f.name;
          if (fields & 0x0002) B();
          if (fields & 0x0004) B();
          if (fields & 0x0008) { const v = B(); f.family = v >= 16 ? v >> 4 : v; }
          if (fields & 0x0010) { const s = B(); f.bold = !!(s & 1); f.italic = !!(s & 2); }
          if (fields & 0x0020) f.h = UL();
          if (fields & 0x0040) f.rot = US();
          if (fields & 0x0080) f.ws = US() / 1024;
          if (fields & 0x0100) f.sp = US() / 1024;
          if (fields & 0x0200) f.obl = US();
          if (fields & 0x0400) f.flags = UL();
          break;
        }
        // ---- linee e polilinee
        case 0x4c: { const a = Ipt(), b = Ipt(); path([[...a, ...b]], false, false); break; } // L
        case 0x6c: { const a = rel32(), b = rel32(); path([[...a, ...b]], false, false); break; } // l
        case 0x0c: { const a = rel16(), b = rel16(); path([[...a, ...b]], false, false); break; } // Ctrl-L
        case 0x8c: { const n = B(); const rings = []; for (let i = 0; i < n; i++) { const a = rel16(), b = rel16(); rings.push([...a, ...b]); } if (st.visible) prims.push({ t: "p", rings, closed: false, fill: false, ...lineProps(), ...base() }); break; }
        case 0x50: { const n = I(); const a = []; for (let i = 0; i < n; i++) a.push(...Ipt()); polyline(a); break; } // P
        case 0x70: { const n = count(); polyline(pts(n, rel32)); break; } // p
        case 0x10: { const n = count(); polyline(pts(n, rel16)); break; } // Ctrl-P
        // ---- triangoli
        case 0x54: { const n = I(); const a = []; for (let i = 0; i < n; i++) a.push(...Ipt()); triStrip(a); break; } // T
        case 0x74: { const n = count(); triStrip(pts(n, rel32)); break; } // t
        case 0x14: { const n = count(); triStrip(pts(n, rel16)); break; } // Ctrl-T
        case 0x67: case 0x07: { const n = count(); const v = []; for (let i = 0; i < n; i++) { const [x, y] = op === 0x67 ? rel32() : rel16(); const c = [B(), B(), B(), B()]; v.push([x, y, c]); } gouraudTris(v); break; }
        case 0x71: case 0x11: { const n = count(); const v = []; for (let i = 0; i < n; i++) { const [x, y] = op === 0x71 ? rel32() : rel16(); const c = [B(), B(), B(), B()]; v.push([x, y, c]); } gouraudLine(v); break; }
        // ---- curve
        case 0x52: { const [x, y] = Ipt(); const r = I(); ellipse(x, y, r, r, 0, 0, 0); break; } // R
        case 0x72: { const [x, y] = rel32(); const r = UL(); ellipse(x, y, r, r, 0, 0, 0); break; } // r
        case 0x12: { const [x, y] = rel16(); const r = US(); ellipse(x, y, r, r, 0, 0, 0); break; } // Ctrl-R
        case 0x92: { const [x, y] = rel32(); const r = UL(), s = US(), e = US(); ellipse(x, y, r, r, s, e, 0); break; }
        case 0x45: { const [x, y] = Ipt(); const [rx, ry] = Ipt(); ellipse(x, y, rx, ry, 0, 0, 0); break; } // E
        case 0x65: { const [x, y] = rel32(); const rx = UL(), ry = UL(), s = US(), e = US(), t = US(); ellipse(x, y, rx, ry, s, e, t); break; } // e
        case 0x62: case 0x02: case 0x42: { // b, Ctrl-B, B
          if (op === 0x42) { const n = I(); const [x0, y0] = Ipt(); const segs = []; for (let i = 0; i < n; i++) segs.push([...Ipt(), ...Ipt(), ...Ipt()]); bezier(x0, y0, segs); break; }
          const rd = op === 0x62 ? rel32 : rel16;
          const n = count(); const [x0, y0] = rd(); const segs = [];
          for (let i = 0; i < n; i++) segs.push([...rd(), ...rd(), ...rd()]);
          bezier(x0, y0, segs);
          break;
        }
        // ---- aree con fori
        case 0x6b: case 0x0b: { // k, Ctrl-K
          const nc = count(), counts = [];
          for (let i = 0; i < nc; i++) counts.push(count());
          const tot = counts.reduce((s, v) => s + v, 0);
          contour(counts, pts(tot, op === 0x6b ? rel32 : rel16));
          break;
        }
        // ---- simboli
        case 0x4d: { const n = I(); const a = []; for (let i = 0; i < n; i++) a.push(...Ipt()); markers(a); break; } // M
        case 0x6d: { const n = count(); markers(pts(n, rel32)); break; } // m
        case 0x8d: { const n = count(); markers(pts(n, rel16)); break; }
        // ---- testo
        case 0x78: { const [x, y] = rel32(); text(x, y, T(), null); break; } // x
        case 0x18: { // Ctrl-X: testo con sopralineato, sottolineato e riquadro
          // nei file reali l'ordine e': sopralineato, sottolineato, riquadro (4 punti relativi in catena), valori riservati
          const [x, y] = rel32();
          const s = T();
          const skipList = () => { const n = count() - 1; for (let i = 0; i < n; i++) { const v = B(); if (!v) US(); } };
          skipList(); skipList();
          // il riquadro: 4 punti relativi in catena (aggiornano il punto corrente, come le altre coordinate relative)
          const bounds = [];
          for (let i = 0; i < 4; i++) { const [bx, by] = rel32(); bounds.push(bx, by); }
          skipList();
          text(x, y, s, bounds);
          break;
        }
        // ---- polilinee con texture (rare): si salta il contenuto
        case 0x77: { const n = count(); L(); for (let i = 0; i < n; i++) { L(); L(); L(); L(); UL(); } break; }
        default:
          // opcode sconosciuto: il resto non e' leggibile
          info.warnings.push(`Opcode W2D non riconosciuto 0x${op.toString(16)} alla posizione ${p - 1}`);
          if (trace) info.trace = { ops: trace.map(([o, q]) => o.toString(16) + "@" + q), bytes: buf.slice(Math.max(0, p - 120), p + 20) };
          p = buf.length;
          break;
      }
      if (++guard > 50_000_000) break;
    }
  } catch (e) {
    if (!(e instanceof RangeError)) info.warnings.push(e.message);
    else info.warnings.push("Flusso W2D troncato");
  }
  if (opts.debug) info.prims = prims.length;
  return { prims, info, verNum };
}

// decompressione LZ del formato WHIP! (cronologia di 64 KB, codice: 4 bit letterali + 4 bit ripetuti)
function lzDecode(src, start, history) {
  const h0 = history ? history.length : 0;
  let p = start, out = new Uint8Array(Math.max(4096, (src.length - start) * 3 + h0)), n = 0;
  if (history) { out.set(history); n = h0; }
  const put = b => { if (n >= out.length) { const o = new Uint8Array(out.length * 2); o.set(out); out = o; } out[n++] = b; };
  for (;;) {
    if (p >= src.length) break;
    const code = src[p++];
    if (code === 0) break;
    let lit = code & 15, cmp = code >> 4;
    if (lit === 15) lit = 15 + src[p++];
    for (let i = 0; i < lit; i++) put(src[p++]);
    if (cmp) {
      let len = cmp === 15 ? 18 + src[p++] : cmp + 3;
      const off = src[p] | (src[p + 1] << 8);
      p += 2;
      let from = n - 1 - off;
      for (let i = 0; i < len; i++) put(from + i >= 0 ? out[from + i] : 0);
    }
  }
  return { data: out.subarray(h0, n), end: p };
}

function scanHex(b, p) {
  let i = p;
  while (i < b.length && i - p < 400000) {
    const c = b[i];
    if (c === 0x22) return i - p >= 4 && (i - p) % 4 === 0 ? i : -1;
    if (!((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66))) return -1;
    i++;
  }
  return -1;
}
function hexToUtf16(h) {
  let s = "";
  for (let i = 0; i + 3 < h.length; i += 4) s += String.fromCharCode(parseInt(String.fromCharCode(h[i], h[i + 1], h[i + 2], h[i + 3]), 16));
  return s;
}
function hexBytes(s) {
  s = s.replace(/[^0-9a-f]/gi, "");
  const out = new Uint8Array(s.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}
const DEC = new TextDecoder("windows-1252");
function decodeAnsi(arr) { return DEC.decode(arr instanceof Uint8Array ? arr : Uint8Array.from(arr)); }
