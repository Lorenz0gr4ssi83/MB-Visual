// Selettore colori professionale (editor PDF e altri editor): area saturazione/luminosita', tinta, opacita', valori
// esadecimali, RGB e CMYK (il CMYK resta tale nel PDF), contagocce (EyeDropper di Chromium/WebView2 su tutto lo schermo,
// oppure quello dell'editor sulla pagina), campioni del documento, colori recenti e di base, "Nessuno".
// Valori scambiati: "#rrggbb", "cmyk(c,m,y,k)" con percentuali, "" = nessun colore.
import { t } from "./i18n.js";
import { el } from "./core.js";
import { pdfIcon } from "./pdfedicons.js";

const BASE = ["#000000", "#404040", "#7f7f7f", "#bfbfbf", "#ffffff", "#c62828", "#ef6c00", "#f9a825", "#2e7d32", "#00838f",
  "#1565c0", "#283593", "#6a1b9a", "#ad1457", "#795548", "#ffeb3b", "#ffcdd2", "#c8e6c9", "#bbdefb", "#fff8e1"];
const RECENT_KEY = "mbv-colori-recenti";

// ---------------------------------------------------------------- conversioni
export function parseColor(v) {
  if (!v) return null;
  const m = /cmyk\(([^)]*)\)/i.exec(v);
  if (m) {
    const [c, mm, y, k] = m[1].split(",").map(x => Math.max(0, Math.min(100, parseFloat(x) || 0)) / 100);
    return { rgb: [255 * (1 - c) * (1 - k), 255 * (1 - mm) * (1 - k), 255 * (1 - y) * (1 - k)].map(Math.round), cmyk: [c, mm, y, k].map(x => Math.round(x * 100)) };
  }
  const h = String(v).replace("#", "").padEnd(6, "0").slice(0, 6);
  return { rgb: [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) || 0), cmyk: null };
}
export const toHex = rgb => "#" + rgb.map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("");
export function cssColor(v) { const p = parseColor(v); return p ? toHex(p.rgb) : "transparent"; }
function rgb2cmyk([r, g, b]) {
  const R = r / 255, G = g / 255, B = b / 255, k = 1 - Math.max(R, G, B);
  if (k >= 1) return [0, 0, 0, 100];
  return [(1 - R - k) / (1 - k), (1 - G - k) / (1 - k), (1 - B - k) / (1 - k), k].map(x => Math.round(x * 100));
}
function rgb2hsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx];
}
function hsv2rgb(h, s, v) {
  const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)].map(x => Math.round(x * 255));
}
function recent() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; } }
function remember(v) {
  if (!v) return;
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([v, ...recent().filter(x => x !== v)].slice(0, 12))); } catch { /* */ }
}

// ---------------------------------------------------------------- finestra
let open = null;
export function closeColorPicker() { open?.close(); }

/** opts: { value, alpha (0-1 o undefined = senza opacita'), allowNone, swatches, pickFromPage(cb), onChange(v, a), onCommit(v, a), title } */
export function openColorPicker(anchor, opts) {
  closeColorPicker();
  let cur = parseColor(opts.value);
  let none = !cur;
  let mode = cur?.cmyk ? "cmyk" : "hex";
  let cmyk = cur?.cmyk || (cur ? rgb2cmyk(cur.rgb) : [0, 0, 0, 100]);
  let [h, s, v] = rgb2hsv(cur?.rgb || [0, 0, 0]);
  let alpha = opts.alpha;
  const box = el("div", { class: "cp", role: "dialog", "aria-label": opts.title || t("colorpick.colore") });
  const sv = el("div", { class: "cp-sv" }, el("i", { class: "cp-svk" }));
  const hue = el("div", { class: "cp-hue" }, el("i"));
  const alp = el("div", { class: "cp-alpha" }, el("b"), el("i"));
  const prev = el("span", { class: "cp-prev" }, el("b"));
  const fields = el("div", { class: "cp-fields" });
  const tabs = el("div", { class: "cp-tabs" });
  const value = () => (none ? "" : mode === "cmyk" ? `cmyk(${cmyk.join(",")})` : toHex(hsv2rgb(h, s, v)));
  const emit = commit => { const val = value(); opts.onChange?.(val, alpha); if (commit) { remember(val); opts.onCommit?.(val, alpha); } };
  function paint(skipFields) {
    const rgb = none ? null : hsv2rgb(h, s, v);
    sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), hsl(${h} 100% 50%)`;
    sv.firstChild.style.left = s * 100 + "%";
    sv.firstChild.style.top = (1 - v) * 100 + "%";
    hue.firstChild.style.left = (h / 360) * 100 + "%";
    if (alpha !== undefined) {
      alp.firstChild.style.background = `linear-gradient(to right, transparent, ${rgb ? toHex(rgb) : "#000"})`;
      alp.lastChild.style.left = alpha * 100 + "%";
    }
    prev.classList.toggle("none", none);
    prev.firstChild.style.background = rgb ? toHex(rgb) : "transparent";
    prev.firstChild.style.opacity = alpha ?? 1;
    box.classList.toggle("is-none", none);
    if (!skipFields) renderFields();
  }
  function setRgb(rgb, fromCmyk) {
    none = false;
    [h, s, v] = rgb2hsv(rgb);
    if (!fromCmyk) cmyk = rgb2cmyk(rgb);
  }
  const num = (val, max, onset, label) => {
    const i = el("input", { type: "number", min: 0, max, value: val, "aria-label": label });
    i.addEventListener("input", () => { onset(Math.max(0, Math.min(max, +i.value || 0))); paint(true); emit(false); });
    i.addEventListener("change", () => emit(true));
    return el("label", {}, i, el("span", {}, label));
  };
  function renderFields() {
    fields.innerHTML = "";
    tabs.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.m === mode));
    const rgb = hsv2rgb(h, s, v);
    if (mode === "hex") {
      const i = el("input", { type: "text", value: none ? "" : toHex(rgb).toUpperCase(), maxlength: 7, spellcheck: "false", "aria-label": "HEX", class: "cp-hex" });
      i.addEventListener("change", () => { const x = i.value.trim().replace(/^#?/, "#"); if (/^#[0-9a-f]{6}$/i.test(x)) { setRgb(parseColor(x).rgb); paint(); emit(true); } });
      fields.append(el("label", { class: "wide" }, i, el("span", {}, "HEX")));
    } else if (mode === "rgb") {
      const c = [...rgb];
      ["R", "G", "B"].forEach((l, k) => fields.append(num(c[k], 255, x => { c[k] = x; setRgb(c); }, l)));
    } else {
      ["C", "M", "Y", "K"].forEach((l, k) => fields.append(num(cmyk[k], 100, x => {
        cmyk[k] = x;
        const [C, M, Y, K] = cmyk.map(q => q / 100);
        setRgb([255 * (1 - C) * (1 - K), 255 * (1 - M) * (1 - K), 255 * (1 - Y) * (1 - K)], true);
      }, l)));
    }
    if (alpha !== undefined) fields.append(num(Math.round(alpha * 100), 100, x => { alpha = x / 100; }, "%"));
  }
  for (const [m, l] of [["hex", "HEX"], ["rgb", "RGB"], ["cmyk", "CMYK"]]) {
    tabs.append(el("button", { type: "button", "data-m": m, title: m === "cmyk" ? t("colorpick.cmyk_stampa") : l, onclick: () => { if (mode === "cmyk" && m !== "cmyk") cmyk = rgb2cmyk(hsv2rgb(h, s, v)); mode = m; renderFields(); emit(true); } }, l));
  }
  const drag = (node, fn) => node.addEventListener("pointerdown", e => {
    e.preventDefault();
    node.setPointerCapture(e.pointerId);
    const go = ev => { const r = node.getBoundingClientRect(); fn(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height))); paint(); emit(false); };
    go(e);
    const up = () => { node.removeEventListener("pointermove", go); node.removeEventListener("pointerup", up); emit(true); };
    node.addEventListener("pointermove", go);
    node.addEventListener("pointerup", up);
  });
  drag(sv, (x, y) => { none = false; s = x; v = 1 - y; if (mode === "cmyk") cmyk = rgb2cmyk(hsv2rgb(h, s, v)); });
  drag(hue, x => { none = false; h = x * 360; if (mode === "cmyk") cmyk = rgb2cmyk(hsv2rgb(h, s, v)); });
  if (alpha !== undefined) drag(alp, x => { alpha = Math.round(x * 100) / 100; });
  // contagocce: tutto lo schermo se il motore lo consente, altrimenti la pagina dell'editor
  const pick = async () => {
    if (window.EyeDropper) {
      try { const r = await new window.EyeDropper().open(); setRgb(parseColor(r.sRGBHex).rgb); paint(); emit(true); return; } catch { return; }
    }
    if (opts.pickFromPage) { box.classList.add("picking"); opts.pickFromPage(hex => { box.classList.remove("picking"); if (hex) { setRgb(parseColor(hex).rgb); paint(); emit(true); } }); }
  };
  const swatch = (c, title) => el("button", { type: "button", class: "cp-sw", title: title || c, style: `--c: ${cssColor(c)}`, onclick: () => { const p = parseColor(c); if (p.cmyk) { mode = "cmyk"; cmyk = p.cmyk; } setRgb(p.rgb, !!p.cmyk); paint(); emit(true); } });
  const group = (label, list) => (list?.length ? el("div", { class: "cp-group" }, el("div", { class: "cp-lbl" }, label), el("div", { class: "cp-sws" }, ...list.map(c => swatch(c)))) : null);
  box.append(
    el("div", { class: "cp-head" }, el("span", {}, opts.title || t("colorpick.colore")),
      opts.allowNone ? el("button", { type: "button", class: "cp-none", title: t("colorpick.nessun_colore"), onclick: () => { none = true; paint(); emit(true); } }, t("colorpick.nessuno")) : null),
    sv,
    el("div", { class: "cp-row" }, el("button", { type: "button", class: "cp-eye", title: t("colorpick.contagocce"), html: pdfIcon("eyedrop", 16), onclick: pick }),
      el("div", { class: "cp-sliders" }, hue, alpha !== undefined ? alp : null), prev),
    tabs, fields,
    ...[group(t("colorpick.documento"), (opts.swatches || []).slice(0, 16)),
    group(t("colorpick.recenti"), recent()),
    group(t("colorpick.base"), BASE)].filter(Boolean));
  document.body.append(box);
  // posizione: sotto (o sopra) il pulsante, dentro la finestra
  const r = anchor.getBoundingClientRect(), bw = 252, bh = box.offsetHeight;
  box.style.left = Math.max(8, Math.min(innerWidth - bw - 8, r.left)) + "px";
  box.style.top = (r.bottom + bh + 8 < innerHeight ? r.bottom + 6 : Math.max(8, r.top - bh - 6)) + "px";
  paint();
  const onDoc = e => { if (!box.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(); };
  const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  setTimeout(() => { document.addEventListener("pointerdown", onDoc, true); document.addEventListener("keydown", onKey, true); });
  function close() {
    document.removeEventListener("pointerdown", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
    box.remove();
    if (open?.box === box) open = null;
  }
  open = { box, close };
  return open;
}

/** Pulsante campione: mostra il colore (scacchi = nessuno) e apre il selettore. */
export function colorButton(opts) {
  let val = opts.value || "", a = opts.alpha;
  const b = el("button", { type: "button", class: "cp-btn" + (opts.small ? " small" : ""), title: opts.title || t("colorpick.colore") }, el("b"), opts.label ? el("span", {}, opts.label) : null);
  const show = () => { b.classList.toggle("none", !val); b.firstChild.style.background = val ? cssColor(val) : ""; b.firstChild.style.opacity = a ?? 1; };
  b.addEventListener("click", () => openColorPicker(b, { ...opts, value: val, alpha: a,
    onChange: (v, al) => { val = v; a = al; show(); opts.onChange?.(v, al); },
    onCommit: (v, al) => { val = v; a = al; show(); opts.onCommit?.(v, al); } }));
  show();
  b.set = (v, al) => { val = v || ""; if (al !== undefined) a = al; show(); };
  b.get = () => val;
  return b;
}
