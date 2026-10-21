// Editor di immagini: regolazioni (come Immagine > Regolazioni di Photoshop, usate anche dai livelli di regolazione)
// e filtri. Ogni regolazione ha parametri semplici (salvati nei livelli, in ORA e in PSD), una funzione che agisce sui
// pixel RGBA e un pannello di controlli; i filtri lavorano su canvas e restituiscono un canvas nuovo.
import { t as tr } from "./i18n.js";
import { el } from "./core.js";

const clamp = (v, a = 0, b = 255) => (v < a ? a : v > b ? b : v);
export const mkCanvas = (w, h) => { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
export const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

// ---------------------------------------------------------------- elenco (ordine e nomi del pannello Regolazioni)
export const ADJ = {
  brightness: { name: tr("imgadjust.luminosita_contrasto"), icon: "brightness", def: () => ({ b: 0, c: 0 }) },
  levels: { name: tr("imgadjust.livelli"), icon: "levels", keys: "Ctrl+L", def: () => ({ rgb: [0, 1, 255, 0, 255], r: [0, 1, 255, 0, 255], g: [0, 1, 255, 0, 255], b: [0, 1, 255, 0, 255] }) },
  curves: { name: tr("imgadjust.curve"), icon: "curves", keys: "Ctrl+M", def: () => ({ rgb: [[0, 0], [255, 255]], r: [[0, 0], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [255, 255]] }) },
  exposure: { name: tr("imgadjust.esposizione"), icon: "exposure", def: () => ({ e: 0, o: 0, g: 1 }) },
  vibrance: { name: tr("imgadjust.vividezza"), icon: "vibrance", def: () => ({ v: 0, s: 0 }) },
  hueSat: { name: tr("imgadjust.tonalita_saturazione"), icon: "hueSat", keys: "Ctrl+U", def: () => ({ h: 0, s: 0, l: 0, colorize: false }) },
  colorBalance: { name: tr("imgadjust.bilanciamento_colore"), icon: "colorBalance", keys: "Ctrl+B", def: () => ({ sh: [0, 0, 0], mid: [0, 0, 0], hi: [0, 0, 0], keep: true }) },
  bw: { name: tr("imgadjust.bianco_nero"), icon: "bw", keys: "Ctrl+Alt+Shift+B", def: () => ({ r: 40, y: 60, g: 40, c: 60, b: 20, m: 80, tint: false, th: 42, ts: 20 }) },
  invert: { name: tr("imgadjust.inverti"), icon: "invert", keys: "Ctrl+I", def: () => ({}) },
  posterize: { name: tr("imgadjust.posterizza"), icon: "posterize", def: () => ({ n: 4 }) },
  threshold: { name: tr("imgadjust.soglia"), icon: "threshold", def: () => ({ t: 128 }) },
};

// ---------------------------------------------------------------- tabelle di conversione (LUT)
const ident = () => { const l = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) l[i] = i; return l; };
function levelsLut([ib, gm, iw, ob, ow]) {
  const l = new Uint8ClampedArray(256), d = Math.max(1, iw - ib);
  for (let i = 0; i < 256; i++) { const x = clamp((i - ib) / d, 0, 1); l[i] = Math.round(ob + Math.pow(x, 1 / gm) * (ow - ob)); }
  return l;
}
// curva monotona passante per i punti (Fritsch-Carlson), come le curve di Photoshop
export function curveLut(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0]);
  const l = new Uint8ClampedArray(256);
  if (p.length < 2) return ident();
  const n = p.length, dx = [], m = [], s = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = Math.max(1e-6, p[i + 1][0] - p[i][0]); s[i] = (p[i + 1][1] - p[i][1]) / dx[i]; }
  m[0] = s[0]; m[n - 1] = s[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = s[i - 1] * s[i] <= 0 ? 0 : (s[i - 1] + s[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (s[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / s[i], b = m[i + 1] / s[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * s[i]; m[i + 1] = t * b * s[i]; }
  }
  for (let x = 0; x < 256; x++) {
    if (x <= p[0][0]) { l[x] = p[0][1]; continue; }
    if (x >= p[n - 1][0]) { l[x] = p[n - 1][1]; continue; }
    let i = 0; while (x > p[i + 1][0]) i++;
    const h = dx[i], t = (x - p[i][0]) / h, t2 = t * t, t3 = t2 * t;
    l[x] = Math.round((2 * t3 - 3 * t2 + 1) * p[i][1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * p[i + 1][1] + (t3 - t2) * h * m[i + 1]);
  }
  return l;
}
const chain = (a, b) => { const l = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) l[i] = b[a[i]]; return l; };
function applyLuts(d, lr, lg, lb) { for (let i = 0; i < d.length; i += 4) { d[i] = lr[d[i]]; d[i + 1] = lg[d[i + 1]]; d[i + 2] = lb[d[i + 2]]; } }

function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hue2(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; }
function hsl2rgb(h, s, l, out) {
  if (s <= 0) { out[0] = out[1] = out[2] = l * 255; return out; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q, hh = (((h % 360) + 360) % 360) / 360;
  out[0] = hue2(p, q, hh + 1 / 3) * 255; out[1] = hue2(p, q, hh) * 255; out[2] = hue2(p, q, hh - 1 / 3) * 255;
  return out;
}
export const hexToRgb = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
export const rgbToHex = (r, g, b) => "#" + [r, g, b].map(v => Math.round(clamp(v)).toString(16).padStart(2, "0")).join("");

// ---------------------------------------------------------------- funzione sui pixel di ogni regolazione
export function makeAdjust(type, p) {
  switch (type) {
    case "brightness": {
      const g = Math.pow(2, -p.b / 100), c = p.c * 1.275, f = (259 * (c + 255)) / (255 * (259 - c));
      const l = new Uint8ClampedArray(256);
      for (let i = 0; i < 256; i++) { let x = Math.pow(i / 255, g); x = f * (x - 0.5) + 0.5; l[i] = Math.round(clamp(x, 0, 1) * 255); }
      return d => applyLuts(d, l, l, l);
    }
    case "levels": {
      const m = levelsLut(p.rgb), lr = chain(levelsLut(p.r), m), lg = chain(levelsLut(p.g), m), lb = chain(levelsLut(p.b), m);
      return d => applyLuts(d, lr, lg, lb);
    }
    case "curves": {
      const m = curveLut(p.rgb), lr = chain(curveLut(p.r), m), lg = chain(curveLut(p.g), m), lb = chain(curveLut(p.b), m);
      return d => applyLuts(d, lr, lg, lb);
    }
    case "exposure": {
      const l = new Uint8ClampedArray(256), k = Math.pow(2, p.e);
      for (let i = 0; i < 256; i++) {
        const s = i / 255, lin = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        let v = clamp(lin * k + p.o, 0, 1);
        v = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
        l[i] = Math.round(Math.pow(clamp(v, 0, 1), 1 / Math.max(0.01, p.g)) * 255);
      }
      return d => applyLuts(d, l, l, l);
    }
    case "vibrance": return d => {
      const v = p.v / 100, s = p.s / 100;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx ? (mx - mn) / mx : 0;
        const k = 1 + s + v * (1 - sat), y = lum(r, g, b); // la vividezza agisce di piu' sui colori poco saturi
        d[i] = y + (r - y) * k; d[i + 1] = y + (g - y) * k; d[i + 2] = y + (b - y) * k;
      }
    };
    case "hueSat": return d => {
      const o = [0, 0, 0], hs = p.h, ss = p.s / 100, ls = p.l / 100;
      for (let i = 0; i < d.length; i += 4) {
        let [h, s, l] = rgb2hsl(d[i], d[i + 1], d[i + 2]);
        if (p.colorize) { h = (hs + 360) % 360; s = clamp(0.25 + ss * 0.75, 0, 1); } // Colora: saturazione 25% di partenza
        else { h += hs; s = ss < 0 ? s * (1 + ss) : clamp(s + (1 - s) * ss * s * 1.5 + s * ss * 0.5, 0, 1); }
        l = ls < 0 ? l * (1 + ls) : l + (1 - l) * ls;
        hsl2rgb(h, s, l, o); d[i] = o[0]; d[i + 1] = o[1]; d[i + 2] = o[2];
      }
    };
    case "colorBalance": return d => {
      // stessi intervalli di toni di GIMP/Photoshop: ombre, mezzitoni, luci con pesi che si sovrappongono
      const a = 0.25, b = 0.333, sc = 0.7, o = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) {
        const r0 = d[i], g0 = d[i + 1], b0 = d[i + 2];
        const L = (Math.max(r0, g0, b0) + Math.min(r0, g0, b0)) / 510;
        const ws = clamp((L - b) / -a + 0.5, 0, 1) * sc, wm = clamp((L - b) / a + 0.5, 0, 1) * clamp((L + b - 1) / -a + 0.5, 0, 1) * sc, wh = clamp((L + b - 1) / a + 0.5, 0, 1) * sc;
        let r = r0 / 255 + (p.sh[0] * ws + p.mid[0] * wm + p.hi[0] * wh) / 100;
        let g = g0 / 255 + (p.sh[1] * ws + p.mid[1] * wm + p.hi[1] * wh) / 100;
        let bb = b0 / 255 + (p.sh[2] * ws + p.mid[2] * wm + p.hi[2] * wh) / 100;
        r = clamp(r, 0, 1); g = clamp(g, 0, 1); bb = clamp(bb, 0, 1);
        if (p.keep) { const [h, s] = rgb2hsl(r * 255, g * 255, bb * 255); hsl2rgb(h, s, L, o); d[i] = o[0]; d[i + 1] = o[1]; d[i + 2] = o[2]; }
        else { d[i] = r * 255; d[i + 1] = g * 255; d[i + 2] = bb * 255; }
      }
    };
    case "bw": return d => {
      // grigio = minimo + (medio - minimo) * peso del colore secondario + (massimo - medio) * peso del primario
      const W = { r: p.r / 100, g: p.g / 100, b: p.b / 100, y: p.y / 100, c: p.c / 100, m: p.m / 100 }, o = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        let mx, md, mn, wp, ws;
        if (r >= g && r >= b) { mx = r; wp = W.r; if (g >= b) { md = g; mn = b; ws = W.y; } else { md = b; mn = g; ws = W.m; } }
        else if (g >= r && g >= b) { mx = g; wp = W.g; if (r >= b) { md = r; mn = b; ws = W.y; } else { md = b; mn = r; ws = W.c; } }
        else { mx = b; wp = W.b; if (r >= g) { md = r; mn = g; ws = W.m; } else { md = g; mn = r; ws = W.c; } }
        const y = clamp(mn + (md - mn) * ws + (mx - md) * wp);
        if (p.tint) { hsl2rgb(p.th, p.ts / 100, y / 255, o); d[i] = o[0]; d[i + 1] = o[1]; d[i + 2] = o[2]; }
        else d[i] = d[i + 1] = d[i + 2] = y;
      }
    };
    case "invert": return d => { for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; } };
    case "posterize": {
      const n = Math.max(2, p.n | 0), l = new Uint8ClampedArray(256);
      for (let i = 0; i < 256; i++) l[i] = Math.round(Math.round(i / 255 * (n - 1)) / (n - 1) * 255);
      return d => applyLuts(d, l, l, l);
    }
    case "threshold": return d => { for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = lum(d[i], d[i + 1], d[i + 2]) >= p.t ? 255 : 0; };
    case "desaturate": return d => { for (let i = 0; i < d.length; i += 4) { const v = (Math.max(d[i], d[i + 1], d[i + 2]) + Math.min(d[i], d[i + 1], d[i + 2])) / 2; d[i] = d[i + 1] = d[i + 2] = v; } };
    default: return () => {};
  }
}

// Tono / contrasto / colore automatici (Ctrl+Maiusc+L, Ctrl+Alt+Maiusc+L, Ctrl+Maiusc+B)
export function autoAdjust(kind, d) {
  const H = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let n = 0;
  for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 8) continue; H[0][d[i]]++; H[1][d[i + 1]]++; H[2][d[i + 2]]++; n++; }
  if (!n) return;
  const clip = n * 0.001;
  const range = h => { let lo = 0, hi = 255, s = 0; while (lo < 255 && (s += h[lo]) <= clip) lo++; s = 0; while (hi > 0 && (s += h[hi]) <= clip) hi--; return [lo, Math.max(lo + 1, hi)]; };
  let rs = H.map(range);
  if (kind === "contrast") { const lo = Math.min(...rs.map(r => r[0])), hi = Math.max(...rs.map(r => r[1])); rs = [[lo, hi], [lo, hi], [lo, hi]]; }
  const luts = rs.map(([lo, hi]) => levelsLut([lo, 1, hi, 0, 255]));
  if (kind === "color") {
    // mezzitoni neutri: gamma per canale in modo che la media diventi grigia
    const mean = [0, 0, 0];
    for (let c = 0; c < 3; c++) { let s = 0; for (let v = 0; v < 256; v++) s += luts[c][v] * H[c][v]; mean[c] = s / n; }
    const target = (mean[0] + mean[1] + mean[2]) / 3;
    for (let c = 0; c < 3; c++) {
      const gm = Math.log(clamp(target, 1, 254) / 255) / Math.log(clamp(mean[c], 1, 254) / 255);
      const l = new Uint8ClampedArray(256); for (let v = 0; v < 256; v++) l[v] = Math.round(Math.pow(luts[c][v] / 255, gm) * 255);
      luts[c] = l;
    }
  }
  applyLuts(d, luts[0], luts[1], luts[2]);
}

export function histogram(d) {
  const H = { rgb: new Uint32Array(256), r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256) };
  const step = d.length > 16e6 ? 16 : 4; // immagini grandi: un pixel ogni 4 basta per l'istogramma
  for (let i = 0; i < d.length; i += step) {
    if (d[i + 3] < 8) continue;
    H.r[d[i]]++; H.g[d[i + 1]]++; H.b[d[i + 2]]++; H.rgb[Math.round(lum(d[i], d[i + 1], d[i + 2]))]++;
  }
  return H;
}

// ---------------------------------------------------------------- controlli (pannello Proprieta' e finestre)
function slider(label, get, set, min, max, step, onChange, opts = {}) {
  const num = el("input", { type: "number", min, max, step, value: get(), class: "ps-num" });
  const rng = el("input", { type: "range", min, max, step, value: get(), class: "ps-range" + (opts.grad ? " ps-grad" : ""), style: opts.grad ? { background: opts.grad } : undefined });
  const upd = v => { v = clamp(+v, min, max); if (Number.isNaN(v)) return; set(v); num.value = v; rng.value = v; onChange(); };
  rng.addEventListener("input", () => upd(rng.value));
  num.addEventListener("change", () => upd(num.value));
  rng.addEventListener("dblclick", () => upd(opts.def ?? 0));
  return el("div", { class: "ps-slider" }, el("div", { class: "ps-slider-h" }, el("span", {}, label), num, opts.unit ? el("span", { class: "ps-unit" }, opts.unit) : null), rng);
}
function check(label, get, set, onChange) {
  const c = el("input", { type: "checkbox" });
  c.checked = !!get();
  c.addEventListener("change", () => { set(c.checked); onChange(); });
  return el("label", { class: "ps-check" }, c, label);
}
function chanSelect(get, set, onChange) {
  const s = el("select", { class: "field ps-sel" }, ...[["rgb", "RGB"], ["r", tr("imgadjust.rosso")], ["g", tr("imgadjust.verde")], ["b", tr("imgadjust.blu")]].map(([v, t]) => el("option", { value: v }, t)));
  s.value = get();
  s.addEventListener("change", () => { set(s.value); onChange(); });
  return s;
}
function drawHist(g, H, w, h, color) {
  if (!H) return;
  let mx = 1; for (let i = 0; i < 256; i++) mx = Math.max(mx, H[i]);
  // scala con radice per non schiacciare i picchi
  g.fillStyle = color;
  for (let i = 0; i < 256; i++) { const v = Math.sqrt(H[i] / mx) * h; g.fillRect(i * w / 256, h - v, Math.ceil(w / 256), v); }
}
const CH_COLOR = { rgb: "rgba(140,140,140,.75)", r: "rgba(220,60,60,.7)", g: "rgba(60,170,60,.7)", b: "rgba(60,100,230,.7)" };

// pannello controlli di una regolazione; hist() restituisce l'istogramma dell'immagine sotto la regolazione
export function adjustControls(type, p, onChange, hist) {
  const box = el("div", { class: "ps-adjui" });
  const S = (label, key, min, max, step = 1, o = {}) => slider(label, () => p[key], v => (p[key] = v), min, max, step, onChange, { def: ADJ[type].def()[key], ...o });
  switch (type) {
    case "brightness": box.append(S(tr("imgadjust.luminosita"), "b", -150, 150), S(tr("imgadjust.contrasto"), "c", -50, 100)); break;
    case "exposure": box.append(S(tr("imgadjust.esposizione"), "e", -5, 5, 0.01), S(tr("imgadjust.spostamento"), "o", -0.5, 0.5, 0.0001), S(tr("imgadjust.correzione_gamma"), "g", 0.01, 9.99, 0.01, { def: 1 })); break;
    case "vibrance": box.append(S(tr("imgadjust.vividezza"), "v", -100, 100), S(tr("imgadjust.saturazione"), "s", -100, 100)); break;
    case "hueSat": {
      const hueGrad = "linear-gradient(90deg,#0ff,#00f,#f0f,#f00,#ff0,#0f0,#0ff)";
      box.append(S(tr("imgadjust.tonalita"), "h", -180, 180, 1, { grad: hueGrad }), S(tr("imgadjust.saturazione"), "s", -100, 100), S(tr("imgadjust.luminosita"), "l", -100, 100),
        check(tr("imgadjust.colora"), () => p.colorize, v => (p.colorize = v), onChange));
      break;
    }
    case "colorBalance": {
      let tone = "mid";
      const tsel = el("select", { class: "field ps-sel" }, el("option", { value: "sh" }, tr("imgadjust.ombre")), el("option", { value: "mid" }, tr("imgadjust.mezzitoni")), el("option", { value: "hi" }, tr("imgadjust.luci")));
      tsel.value = tone;
      const sl = el("div");
      const build = () => {
        sl.innerHTML = "";
        [[tr("imgadjust.ciano"), tr("imgadjust.rosso"), "linear-gradient(90deg,#0cc,#e33)"], [tr("imgadjust.magenta"), tr("imgadjust.verde"), "linear-gradient(90deg,#c3c,#3b3)"], [tr("imgadjust.giallo"), tr("imgadjust.blu"), "linear-gradient(90deg,#dd3,#36e)"]].forEach(([a, b, gr], i) =>
          sl.append(slider(`${a} / ${b}`, () => p[tone][i], v => (p[tone][i] = v), -100, 100, 1, onChange, { grad: gr })));
      };
      tsel.addEventListener("change", () => { tone = tsel.value; build(); });
      build();
      box.append(el("label", { class: "ps-row" }, tr("imgadjust.tono"), tsel), sl, check(tr("imgadjust.mantieni_luminosita"), () => p.keep, v => (p.keep = v), onChange));
      break;
    }
    case "bw":
      box.append(S(tr("imgadjust.rossi"), "r", -200, 300, 1, { unit: "%", grad: "linear-gradient(90deg,#000,#e33)" }), S(tr("imgadjust.gialli"), "y", -200, 300, 1, { unit: "%", grad: "linear-gradient(90deg,#000,#ee3)" }),
        S(tr("imgadjust.verdi"), "g", -200, 300, 1, { unit: "%", grad: "linear-gradient(90deg,#000,#3c3)" }), S(tr("imgadjust.ciani"), "c", -200, 300, 1, { unit: "%", grad: "linear-gradient(90deg,#000,#3ee)" }),
        S(tr("imgadjust.blu"), "b", -200, 300, 1, { unit: "%", grad: "linear-gradient(90deg,#000,#36e)" }), S(tr("imgadjust.magenta"), "m", -200, 300, 1, { unit: "%", grad: "linear-gradient(90deg,#000,#e3e)" }),
        check(tr("imgadjust.tinta"), () => p.tint, v => (p.tint = v), onChange), S(tr("imgadjust.tonalita_tinta"), "th", 0, 360), S(tr("imgadjust.saturazione_tinta"), "ts", 0, 100, 1, { unit: "%" }));
      break;
    case "invert": box.append(el("p", { class: "ps-note" }, tr("imgadjust.nessuna_opzione_i_colori_vengono"))); break;
    case "posterize": box.append(S(tr("imgadjust.livelli"), "n", 2, 255)); break;
    case "threshold": {
      const cv = el("canvas", { width: 256, height: 70, class: "ps-hist" });
      const g = cv.getContext("2d");
      const draw = () => { g.clearRect(0, 0, 256, 70); drawHist(g, hist?.()?.rgb, 256, 70, CH_COLOR.rgb); g.fillStyle = "#e33"; g.fillRect(p.t, 0, 1, 70); };
      const o = onChange; onChange = () => { draw(); o(); };
      box.append(cv, S(tr("imgadjust.livello_soglia"), "t", 1, 255));
      draw();
      break;
    }
    case "levels": box.append(levelsUI(p, onChange, hist)); break;
    case "curves": box.append(curvesUI(p, onChange, hist)); break;
  }
  return box;
}

function levelsUI(p, onChange, hist) {
  let ch = "rgb";
  const H = hist?.();
  const wrap = el("div");
  const cv = el("canvas", { width: 256, height: 100, class: "ps-hist" });
  const g = cv.getContext("2d");
  const inRow = el("div", { class: "ps-levnums" }), outRow = el("div", { class: "ps-levnums" });
  const nums = [0, 1, 2].map(i => el("input", { type: "number", class: "ps-num", step: i === 1 ? 0.01 : 1, min: i === 1 ? 0.1 : 0, max: i === 1 ? 9.99 : 255 }));
  const onums = [3, 4].map(() => el("input", { type: "number", class: "ps-num", min: 0, max: 255 }));
  const out = el("canvas", { width: 256, height: 14, class: "ps-hist" });
  const draw = () => {
    const v = p[ch];
    g.clearRect(0, 0, 256, 100);
    drawHist(g, H?.[ch], 256, 86, CH_COLOR[ch]);
    const mid = v[0] + (v[2] - v[0]) * Math.pow(0.5, v[1]);
    [[v[0], "#000"], [mid, "#888"], [v[2], "#fff"]].forEach(([x, c]) => { g.fillStyle = c; g.strokeStyle = "#555"; g.beginPath(); g.moveTo(x, 88); g.lineTo(x - 6, 99); g.lineTo(x + 6, 99); g.closePath(); g.fill(); g.stroke(); });
    const og = out.getContext("2d"), gr = og.createLinearGradient(0, 0, 256, 0); gr.addColorStop(0, "#000"); gr.addColorStop(1, "#fff");
    og.fillStyle = gr; og.fillRect(0, 0, 256, 8);
    og.clearRect(0, 8, 256, 6);
    [[v[3], "#000"], [v[4], "#fff"]].forEach(([x, c]) => { og.fillStyle = c; og.strokeStyle = "#555"; og.beginPath(); og.moveTo(x, 8); og.lineTo(x - 5, 14); og.lineTo(x + 5, 14); og.closePath(); og.fill(); og.stroke(); });
    nums.forEach((n, i) => (n.value = i === 1 ? v[1].toFixed(2) : v[i]));
    onums.forEach((n, i) => (n.value = v[3 + i]));
  };
  const set = (i, val) => {
    const v = p[ch];
    if (i === 0) v[0] = clamp(Math.round(val), 0, v[2] - 2);
    if (i === 2) v[2] = clamp(Math.round(val), v[0] + 2, 255);
    if (i === 1) v[1] = clamp(+val, 0.1, 9.99);
    if (i === 3) v[3] = clamp(Math.round(val), 0, 255);
    if (i === 4) v[4] = clamp(Math.round(val), 0, 255);
    draw(); onChange();
  };
  nums.forEach((n, i) => n.addEventListener("change", () => set(i, n.value)));
  onums.forEach((n, i) => n.addEventListener("change", () => set(3 + i, n.value)));
  // trascinamento dei cursori triangolari come in Photoshop
  let drag = -1;
  cv.addEventListener("pointerdown", e => {
    const x = e.offsetX * 256 / cv.clientWidth, v = p[ch], mid = v[0] + (v[2] - v[0]) * Math.pow(0.5, v[1]);
    const ds = [Math.abs(x - v[0]), Math.abs(x - mid), Math.abs(x - v[2])];
    drag = ds.indexOf(Math.min(...ds)); cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener("pointermove", e => {
    if (drag < 0) return;
    const x = clamp(e.offsetX * 256 / cv.clientWidth), v = p[ch];
    if (drag === 1) { const t = clamp((x - v[0]) / Math.max(1, v[2] - v[0]), 0.01, 0.99); set(1, Math.log(t) / Math.log(0.5)); }
    else set(drag, x);
  });
  cv.addEventListener("pointerup", () => (drag = -1));
  let odrag = -1;
  out.addEventListener("pointerdown", e => { const x = e.offsetX * 256 / out.clientWidth, v = p[ch]; odrag = Math.abs(x - v[3]) < Math.abs(x - v[4]) ? 3 : 4; out.setPointerCapture(e.pointerId); });
  out.addEventListener("pointermove", e => { if (odrag >= 0) set(odrag, e.offsetX * 256 / out.clientWidth); });
  out.addEventListener("pointerup", () => (odrag = -1));
  inRow.append(...nums); outRow.append(...onums);
  const auto = el("button", { class: "btn", type: "button", onclick: () => {
    if (!H) return;
    const h = H[ch]; let n = 0; for (let i = 0; i < 256; i++) n += h[i];
    let lo = 0, hi = 255, s = 0; while (lo < 254 && (s += h[lo]) < n * 0.001) lo++; s = 0; while (hi > lo + 1 && (s += h[hi]) < n * 0.001) hi--;
    p[ch][0] = lo; p[ch][2] = hi; draw(); onChange();
  } }, tr("imgadjust.auto"));
  wrap.append(el("div", { class: "ps-row" }, chanSelect(() => ch, v => (ch = v), draw), auto), el("div", { class: "ps-lab" }, tr("imgadjust.livelli_input")), cv, inRow, el("div", { class: "ps-lab" }, tr("imgadjust.livelli_output")), out, outRow);
  draw();
  return wrap;
}

function curvesUI(p, onChange, hist) {
  let ch = "rgb", selI = -1;
  const H = hist?.();
  const S = 256;
  const cv = el("canvas", { width: S, height: S, class: "ps-curve" });
  const g = cv.getContext("2d");
  const inN = el("input", { type: "number", class: "ps-num", min: 0, max: 255 }), outN = el("input", { type: "number", class: "ps-num", min: 0, max: 255 });
  const draw = () => {
    const pts = p[ch];
    g.clearRect(0, 0, S, S);
    drawHist(g, H?.[ch], S, S, "rgba(128,128,128,.35)");
    g.strokeStyle = "rgba(128,128,128,.5)"; g.lineWidth = 1;
    for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(i * S / 4 + 0.5, 0); g.lineTo(i * S / 4 + 0.5, S); g.moveTo(0, i * S / 4 + 0.5); g.lineTo(S, i * S / 4 + 0.5); g.stroke(); }
    g.beginPath(); g.moveTo(0, S); g.lineTo(S, 0); g.strokeStyle = "rgba(128,128,128,.6)"; g.stroke();
    const l = curveLut(pts);
    g.beginPath(); for (let x = 0; x < 256; x++) { const y = S - l[x] * S / 255; x ? g.lineTo(x * S / 255, y) : g.moveTo(0, y); }
    g.strokeStyle = { rgb: "#ddd", r: "#e44", g: "#4c4", b: "#48f" }[ch]; g.lineWidth = 2; g.stroke();
    if (ch === "rgb") { g.strokeStyle = "#222"; g.lineWidth = 1; g.stroke(); }
    pts.forEach(([x, y], i) => { g.fillStyle = i === selI ? "#000" : "#fff"; g.strokeStyle = "#000"; g.lineWidth = 1; g.fillRect(x * S / 255 - 3.5, S - y * S / 255 - 3.5, 7, 7); g.strokeRect(x * S / 255 - 3.5, S - y * S / 255 - 3.5, 7, 7); });
    const sp = pts[selI];
    inN.value = sp ? sp[0] : ""; outN.value = sp ? sp[1] : "";
  };
  const pos = e => [clamp(Math.round(e.offsetX * 255 / cv.clientWidth)), clamp(Math.round(255 - e.offsetY * 255 / cv.clientHeight))];
  let drag = false;
  cv.addEventListener("pointerdown", e => {
    const [x, y] = pos(e), pts = p[ch];
    selI = pts.findIndex(([px, py]) => Math.abs(px - x) < 8 && Math.abs(py - y) < 8);
    if (selI < 0) { const l = curveLut(pts); pts.push([x, Math.abs(l[x] - y) < 12 ? l[x] : y]); pts.sort((a, b) => a[0] - b[0]); selI = pts.findIndex(q => q[0] === x); }
    drag = true; cv.setPointerCapture(e.pointerId); draw(); onChange();
  });
  cv.addEventListener("pointermove", e => {
    if (!drag || selI < 0) return;
    const [x, y] = pos(e), pts = p[ch];
    const out = (e.offsetY < -20 || e.offsetY > cv.clientHeight + 20 || e.offsetX < -20 || e.offsetX > cv.clientWidth + 20) && pts.length > 2;
    if (out) { pts.splice(selI, 1); selI = -1; drag = false; draw(); onChange(); return; } // trascinata fuori: punto eliminato
    const lo = selI > 0 ? pts[selI - 1][0] + 1 : 0, hi = selI < pts.length - 1 ? pts[selI + 1][0] - 1 : 255;
    pts[selI] = [clamp(x, lo, hi), y]; draw(); onChange();
  });
  cv.addEventListener("pointerup", () => (drag = false));
  const setNum = () => { const pts = p[ch]; if (selI < 0) return; pts[selI] = [clamp(+inN.value), clamp(+outN.value)]; pts.sort((a, b) => a[0] - b[0]); draw(); onChange(); };
  inN.addEventListener("change", setNum); outN.addEventListener("change", setNum);
  const reset = el("button", { class: "btn", type: "button", onclick: () => { p[ch] = [[0, 0], [255, 255]]; selI = -1; draw(); onChange(); } }, tr("imgadjust.ripristina_canale"));
  draw();
  return el("div", {}, el("div", { class: "ps-row" }, chanSelect(() => ch, v => { ch = v; selI = -1; }, draw), reset), cv,
    el("div", { class: "ps-row" }, el("label", {}, tr("imgadjust.input"), inN), el("label", {}, tr("imgadjust.output"), outN)),
    el("p", { class: "ps-note" }, tr("imgadjust.clic_curva_nuovo_punto_trascina")));
}

// ---------------------------------------------------------------- filtri
// sfocatura del canvas con i bordi estesi (senza aloni scuri ai margini)
export function blurCanvas(src, radius) {
  const w = src.width, h = src.height, pad = Math.ceil(radius * 3) + 2;
  if (radius <= 0) { const c = mkCanvas(w, h); c.getContext("2d").drawImage(src, 0, 0); return c; }
  const big = mkCanvas(w + pad * 2, h + pad * 2), g = big.getContext("2d");
  g.drawImage(src, pad, pad);
  g.drawImage(src, 0, 0, w, 1, pad, 0, w, pad); g.drawImage(src, 0, h - 1, w, 1, pad, h + pad, w, pad);
  g.drawImage(big, pad, 0, 1, h + pad * 2, 0, 0, pad, h + pad * 2); g.drawImage(big, pad + w - 1, 0, 1, h + pad * 2, pad + w, 0, pad, h + pad * 2);
  const out = mkCanvas(w, h), o = out.getContext("2d");
  o.filter = `blur(${radius}px)`;
  o.drawImage(big, -pad, -pad);
  o.filter = "none";
  return out;
}
function pixels(c) { return c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, c.width, c.height); }
function fromPixels(id) { const c = mkCanvas(id.width, id.height); c.getContext("2d").putImageData(id, 0, 0); return c; }

function unsharp(src, amount, radius, threshold) {
  const a = pixels(src), b = pixels(blurCanvas(src, radius)), d = a.data, e = b.data, k = amount / 100;
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) { const diff = d[i + c] - e[i + c]; if (Math.abs(diff) * 2 >= threshold) d[i + c] = clamp(d[i + c] + diff * k); }
  return fromPixels(a);
}
function motionBlur(src, angle, dist) {
  const w = src.width, h = src.height, out = mkCanvas(w, h), g = out.getContext("2d");
  const n = Math.max(2, Math.min(64, Math.round(dist))), r = angle * Math.PI / 180;
  g.globalCompositeOperation = "lighter";
  g.globalAlpha = 1 / n;
  for (let i = 0; i < n; i++) { const t = (i / (n - 1) - 0.5) * dist; g.drawImage(src, Math.cos(r) * t, -Math.sin(r) * t); }
  // ai bordi la somma e' incompleta: si completa con l'immagine originale sotto
  const fin = mkCanvas(w, h), f = fin.getContext("2d");
  f.drawImage(src, 0, 0); f.globalCompositeOperation = "source-atop"; f.drawImage(out, 0, 0);
  return fin;
}
function addNoise(src, amount, gauss, mono) {
  const id = pixels(src), d = id.data, a = amount / 100 * 255;
  const rnd = gauss ? () => { let s = 0; for (let i = 0; i < 4; i++) s += Math.random(); return (s - 2) * 1.2; } : () => Math.random() * 2 - 1;
  for (let i = 0; i < d.length; i += 4) {
    if (mono) { const n = rnd() * a; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    else { d[i] += rnd() * a; d[i + 1] += rnd() * a; d[i + 2] += rnd() * a; }
  }
  return fromPixels(id);
}
// mediana con istogrammi scorrevoli (algoritmo di Huang): toglie il disturbo mantenendo i bordi
function median(src, r) {
  const id = pixels(src), w = id.width, h = id.height, s = id.data, out = new Uint8ClampedArray(s);
  for (let c = 0; c < 3; c++) {
    const hist = new Uint32Array(256);
    for (let y = 0; y < h; y++) {
      hist.fill(0);
      let cnt = 0;
      const add = (x, sign) => { for (let dy = -r; dy <= r; dy++) { const yy = clamp(y + dy, 0, h - 1), xx = clamp(x, 0, w - 1); hist[s[(yy * w + xx) * 4 + c]] += sign; cnt += sign; } };
      for (let dx = -r; dx <= r; dx++) add(dx, 1);
      for (let x = 0; x < w; x++) {
        let acc = 0, v = 0; const lim = cnt >> 1;
        for (; v < 255; v++) { acc += hist[v]; if (acc > lim) break; }
        out[(y * w + x) * 4 + c] = v;
        add(x - r, -1); add(x + r + 1, 1);
      }
    }
  }
  return fromPixels(new ImageData(out, w, h));
}
function mosaic(src, cell) {
  const w = src.width, h = src.height, sw = Math.max(1, Math.round(w / cell)), sh = Math.max(1, Math.round(h / cell));
  const small = mkCanvas(sw, sh), sg = small.getContext("2d");
  sg.imageSmoothingQuality = "high"; sg.drawImage(src, 0, 0, sw, sh);
  const out = mkCanvas(w, h), g = out.getContext("2d");
  g.imageSmoothingEnabled = false; g.drawImage(small, 0, 0, sw, sh, 0, 0, sw * cell, sh * cell);
  return out;
}
function highPass(src, radius) {
  const a = pixels(src), b = pixels(blurCanvas(src, radius)), d = a.data, e = b.data;
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = clamp(d[i + c] - e[i + c] + 128);
  return fromPixels(a);
}

// menu Filtro: [gruppo, id, nome, parametri predefiniti, controlli]
export const FILTERS = {
  gauss: { group: tr("imgadjust.sfocatura"), name: tr("imgadjust.sfocatura_gaussiana"), def: { r: 2 }, ui: [["r", tr("imgadjust.raggio"), 0.1, 250, 0.1, "pixel"]], run: (c, p) => blurCanvas(c, p.r) },
  motion: { group: tr("imgadjust.sfocatura"), name: tr("imgadjust.sfocatura_movimento"), def: { a: 0, d: 10 }, ui: [["a", tr("imgadjust.angolo"), -90, 90, 1, "°"], ["d", tr("imgadjust.distanza"), 1, 500, 1, "pixel"]], run: (c, p) => motionBlur(c, p.a, p.d) },
  blur: { group: tr("imgadjust.sfocatura"), name: tr("imgadjust.sfoca"), run: c => blurCanvas(c, 1) },
  sharpen: { group: tr("imgadjust.contrasta"), name: tr("imgadjust.contrasta"), run: c => unsharp(c, 60, 0.7, 0) },
  unsharp: { group: tr("imgadjust.contrasta"), name: tr("imgadjust.maschera_contrasto"), def: { a: 100, r: 1.5, t: 0 }, ui: [["a", tr("imgadjust.fattore"), 1, 500, 1, "%"], ["r", tr("imgadjust.raggio"), 0.1, 100, 0.1, "pixel"], ["t", tr("imgadjust.soglia"), 0, 255, 1, "livelli"]], run: (c, p) => unsharp(c, p.a, p.r, p.t) },
  noise: { group: tr("imgadjust.disturbo"), name: tr("imgadjust.aggiungi_disturbo"), def: { a: 10, gauss: true, mono: false }, ui: [["a", tr("imgadjust.fattore"), 0.1, 400, 0.1, "%"], ["gauss", tr("imgadjust.gaussiana_altrimenti_uniforme")], ["mono", tr("imgadjust.monocromatico")]], run: (c, p) => addNoise(c, p.a, p.gauss, p.mono) },
  median: { group: tr("imgadjust.disturbo"), name: tr("imgadjust.mediana"), def: { r: 1 }, ui: [["r", tr("imgadjust.raggio"), 1, 20, 1, "pixel"]], run: (c, p) => median(c, Math.round(p.r)) },
  mosaic: { group: tr("imgadjust.effetto_pixel"), name: tr("imgadjust.mosaico"), def: { s: 10 }, ui: [["s", tr("imgadjust.dimensione_cella"), 2, 200, 1, "quadrato"]], run: (c, p) => mosaic(c, Math.round(p.s)) },
  highpass: { group: tr("imgadjust.altro"), name: tr("imgadjust.accentua_passaggio"), def: { r: 10 }, ui: [["r", tr("imgadjust.raggio"), 0.1, 1000, 0.1, "pixel"]], run: (c, p) => highPass(c, p.r) },
};
export function filterControls(f, p, onChange) {
  return el("div", { class: "ps-adjui" }, ...f.ui.map(([k, label, min, max, step, unit]) => (min === undefined
    ? check(label, () => p[k], v => (p[k] = v), onChange)
    : slider(label, () => p[k], v => (p[k] = v), min, max, step, onChange, { unit, def: f.def[k] }))));
}

// pixel RGBA -> regolazione applicata, su canvas
export function adjustCanvas(src, fn) {
  const id = pixels(src); fn(id.data);
  return fromPixels(id);
}
