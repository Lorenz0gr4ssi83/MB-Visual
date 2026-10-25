// Editor di immagini: file a livelli. PSD di Photoshop con ag-psd (livelli, opacita', metodi di fusione, maschere,
// livelli di regolazione) e OpenRaster (.ora, letto anche da GIMP e Krita) con JSZip; nell'ORA restano anche
// i dati propri di MB Desk (testi, forme, regolazioni, maschere) in attributi mbv:* che gli altri programmi ignorano.
import { t as tr } from "./i18n.js";
import { loadScript } from "./core.js";
import { mkCanvas } from "./imgadjust.js";

// metodi di fusione: [canvas, nome di Photoshop in italiano, nome PSD, nome ORA]; "" = separatore del menu
export const BLENDS = [
  ["source-over", tr("imgfile.normale"), "normal", "svg:src-over"], "",
  ["darken", tr("imgfile.scurisci"), "darken", "svg:darken"], ["multiply", tr("imgfile.moltiplica"), "multiply", "svg:multiply"], ["color-burn", tr("imgfile.brucia_colore"), "color burn", "svg:color-burn"], "",
  ["lighten", tr("imgfile.schiarisci"), "lighten", "svg:lighten"], ["screen", tr("imgfile.scolora"), "screen", "svg:screen"], ["color-dodge", tr("imgfile.colore_scherma"), "color dodge", "svg:color-dodge"],
  ["lighter", tr("imgfile.scherma_lineare_aggiungi"), "linear dodge", "svg:plus"], "",
  ["overlay", tr("imgfile.sovrapponi"), "overlay", "svg:overlay"], ["soft-light", tr("imgfile.luce_soffusa"), "soft light", "svg:soft-light"], ["hard-light", tr("imgfile.luce_intensa"), "hard light", "svg:hard-light"], "",
  ["difference", tr("imgfile.differenza"), "difference", "svg:difference"], ["exclusion", tr("imgfile.esclusione"), "exclusion", "svg:exclusion"], "",
  ["hue", tr("imgfile.tonalita"), "hue", "svg:hue"], ["saturation", tr("imgfile.saturazione"), "saturation", "svg:saturation"], ["color", tr("common.colore"), "color", "svg:color"], ["luminosity", tr("imgfile.luminosita"), "luminosity", "svg:luminosity"],
];
const B = BLENDS.filter(Boolean);
const fromPsd = n => (B.find(b => b[2] === n) || B[0])[0];
const toPsd = n => (B.find(b => b[0] === n) || B[0])[2];
const fromOra = n => (B.find(b => b[3] === n) || B[0])[0];
const toOra = n => (B.find(b => b[0] === n) || B[0])[3];

// maschere: nell'editor l'alfa e' la visibilita'; nei file e' un'immagine in scala di grigi
function maskFromGray(src) {
  const c = mkCanvas(src.width, src.height), g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(src, 0, 0);
  const id = g.getImageData(0, 0, c.width, c.height), d = id.data;
  for (let i = 0; i < d.length; i += 4) { d[i + 3] = d[i]; d[i] = d[i + 1] = d[i + 2] = 255; }
  g.putImageData(id, 0, 0);
  return c;
}
export function maskToGray(m) {
  const c = mkCanvas(m.width, m.height), g = c.getContext("2d");
  g.fillStyle = "#000"; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(m, 0, 0);
  return c;
}

// ---------------------------------------------------------------- PSD
async function agPsd() { await loadScript("/vendor/ag-psd/dist/bundle.js"); return window.agPsd; }

const LEV = c => (c ? [c.shadowInput, c.midtoneInput || 1, c.highlightInput, c.shadowOutput, c.highlightOutput] : [0, 1, 255, 0, 255]);
const CUR = c => (c && c.length ? c.map(n => [n.input, n.output]) : [[0, 0], [255, 255]]);
const CB = c => [c?.cyanRed || 0, c?.magentaGreen || 0, c?.yellowBlue || 0];
function adjFromPsd(a) {
  switch (a.type) {
    case "brightness/contrast": return ["brightness", { b: a.brightness || 0, c: a.contrast || 0 }];
    case "levels": return ["levels", { rgb: LEV(a.rgb), r: LEV(a.red), g: LEV(a.green), b: LEV(a.blue) }];
    case "curves": return ["curves", { rgb: CUR(a.rgb), r: CUR(a.red), g: CUR(a.green), b: CUR(a.blue) }];
    case "exposure": return ["exposure", { e: a.exposure || 0, o: a.offset || 0, g: a.gamma || 1 }];
    case "vibrance": return ["vibrance", { v: a.vibrance || 0, s: a.saturation || 0 }];
    case "hue/saturation": return ["hueSat", { h: a.master?.hue || 0, s: a.master?.saturation || 0, l: a.master?.lightness || 0, colorize: false }];
    case "color balance": return ["colorBalance", { sh: CB(a.shadows), mid: CB(a.midtones), hi: CB(a.highlights), keep: !!a.preserveLuminosity }];
    case "black & white": return ["bw", { r: a.reds ?? 40, y: a.yellows ?? 60, g: a.greens ?? 40, c: a.cyans ?? 60, b: a.blues ?? 20, m: a.magentas ?? 80, tint: !!a.useTint, th: 42, ts: 20 }];
    case "invert": return ["invert", {}];
    case "posterize": return ["posterize", { n: a.levels || 4 }];
    case "threshold": return ["threshold", { t: a.level || 128 }];
    default: return null;
  }
}
const LEVo = v => ({ shadowInput: v[0], midtoneInput: v[1], highlightInput: v[2], shadowOutput: v[3], highlightOutput: v[4] });
const CURo = v => v.map(([input, output]) => ({ input, output }));
const CBo = v => ({ cyanRed: v[0], magentaGreen: v[1], yellowBlue: v[2] });
function adjToPsd(t, p) {
  switch (t) {
    case "brightness": return { type: "brightness/contrast", brightness: p.b, contrast: p.c, meanValue: 127, useLegacy: false };
    case "levels": return { type: "levels", rgb: LEVo(p.rgb), red: LEVo(p.r), green: LEVo(p.g), blue: LEVo(p.b) };
    case "curves": return { type: "curves", rgb: CURo(p.rgb), red: CURo(p.r), green: CURo(p.g), blue: CURo(p.b) };
    case "exposure": return { type: "exposure", exposure: p.e, offset: p.o, gamma: p.g };
    case "vibrance": return { type: "vibrance", vibrance: p.v, saturation: p.s };
    case "hueSat": { const z = { a: 0, b: 0, c: 0, d: 0, hue: 0, saturation: 0, lightness: 0 }; return { type: "hue/saturation", master: { ...z, hue: p.h, saturation: p.s, lightness: p.l }, reds: z, yellows: z, greens: z, cyans: z, blues: z, magentas: z }; }
    case "colorBalance": return { type: "color balance", shadows: CBo(p.sh), midtones: CBo(p.mid), highlights: CBo(p.hi), preserveLuminosity: p.keep };
    case "bw": return { type: "black & white", reds: p.r, yellows: p.y, greens: p.g, cyans: p.c, blues: p.b, magentas: p.m, useTint: p.tint, tintColor: { r: 225, g: 211, b: 179 } };
    case "invert": return { type: "invert" };
    case "posterize": return { type: "posterize", levels: p.n };
    case "threshold": return { type: "threshold", level: p.t };
    default: return null;
  }
}

export async function readPsd(bytes, ADJ) {
  const ag = await agPsd();
  const psd = ag.readPsd(bytes, { skipThumbnail: true });
  const W = psd.width, H = psd.height, layers = [], skipped = [];
  const walk = (list, vis, op) => {
    for (const n of list || []) {
      if (n.children) { walk(n.children, vis && !n.hidden, op * (n.opacity ?? 1)); continue; }
      const L = { name: n.name || tr("imgfile.livello"), visible: vis && !n.hidden, opacity: Math.round((n.opacity ?? 1) * op * 100), blend: fromPsd(n.blendMode), x: n.left || 0, y: n.top || 0, mask: null, props: null };
      if (n.adjustment) {
        const a = adjFromPsd(n.adjustment);
        if (!a || !ADJ[a[0]]) { skipped.push(n.name); continue; }
        Object.assign(L, { kind: "adjust", c: null, props: { type: a[0], p: a[1] } });
      } else if (n.canvas) {
        Object.assign(L, { kind: "pixel", c: n.canvas });
      } else continue;
      if (n.mask?.canvas) {
        const m = n.mask, x0 = Math.min(0, L.x, m.left), y0 = Math.min(0, L.y, m.top);
        const x1 = Math.max(W, L.c ? L.x + L.c.width : W, m.right), y1 = Math.max(H, L.c ? L.y + L.c.height : H, m.bottom);
        const c = mkCanvas(x1 - x0, y1 - y0), g = c.getContext("2d");
        if (m.defaultColor) { g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.clearRect(m.left - x0, m.top - y0, m.canvas.width, m.canvas.height); }
        g.drawImage(maskFromGray(m.canvas), m.left - x0, m.top - y0);
        L.mask = { c, x: x0, y: y0, on: !m.disabled };
      }
      layers.push(L);
    }
  };
  walk(psd.children, true, 1);
  if (!layers.length && psd.canvas) layers.push({ name: tr("imgfile.sfondo"), kind: "pixel", c: psd.canvas, x: 0, y: 0, visible: true, opacity: 100, blend: "source-over", mask: null, props: null });
  return { W, H, layers, skipped };
}

export async function writePsd(doc) {
  const ag = await agPsd();
  const children = doc.layers.map(L => {
    const o = { name: L.name, opacity: L.opacity / 100, blendMode: toPsd(L.blend), hidden: !L.visible };
    if (L.kind === "adjust") o.adjustment = adjToPsd(L.props.type, L.props.p);
    else { o.canvas = L.c; o.left = L.x; o.top = L.y; }
    if (L.mask) o.mask = { canvas: maskToGray(L.mask.c), left: L.mask.x, top: L.mask.y, right: L.mask.x + L.mask.c.width, bottom: L.mask.y + L.mask.c.height, defaultColor: 0, disabled: !L.mask.on };
    return o;
  });
  return ag.writePsdUint8Array({ width: doc.W, height: doc.H, children, canvas: doc.composite }, { generateThumbnail: true, trimImageData: false });
}

// ---------------------------------------------------------------- OpenRaster
async function jszip() { await loadScript("/vendor/jszip/dist/jszip.min.js"); return window.JSZip; }
const pngBytes = c => new Promise(r => c.toBlob(async b => r(new Uint8Array(await b.arrayBuffer())), "image/png"));
async function canvasFrom(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const c = mkCanvas(bmp.width, bmp.height); c.getContext("2d").drawImage(bmp, 0, 0); bmp.close?.();
  return c;
}

export async function readOra(bytes) {
  const Z = await jszip();
  const zip = await Z.loadAsync(bytes);
  const xml = new DOMParser().parseFromString(await zip.file("stack.xml").async("string"), "application/xml");
  const img = xml.querySelector("image");
  const W = +img.getAttribute("w"), H = +img.getAttribute("h"), layers = [];
  const file = async p => (p && zip.file(p) ? canvasFrom(await zip.file(p).async("uint8array")) : null);
  const walk = async (stack, vis, op, ox, oy) => {
    for (const n of [...stack.children].reverse()) { // in stack.xml il primo e' quello in alto
      const v = vis && n.getAttribute("visibility") !== "hidden", o = op * +(n.getAttribute("opacity") ?? 1);
      const x = ox + +(n.getAttribute("x") || 0), y = oy + +(n.getAttribute("y") || 0);
      if (n.tagName === "stack") { await walk(n, v, o, x, y); continue; }
      if (n.tagName !== "layer") continue;
      const kind = n.getAttribute("mbv:kind") || "pixel";
      const L = { name: n.getAttribute("name") || tr("imgfile.livello"), kind, visible: v, opacity: Math.round(o * 100), blend: fromOra(n.getAttribute("composite-op")), x, y, mask: null, props: null };
      const props = n.getAttribute("mbv:props");
      if (props) try { L.props = JSON.parse(props); } catch { /* */ }
      L.c = kind === "adjust" ? null : await file(n.getAttribute("mbv:pixels") || n.getAttribute("src"));
      if (kind !== "adjust" && !L.c) continue;
      const m = n.getAttribute("mbv:mask");
      if (m) L.mask = { c: await file(m), x: +n.getAttribute("mbv:mask-x"), y: +n.getAttribute("mbv:mask-y"), on: n.getAttribute("mbv:mask-on") !== "0" };
      if (L.mask && !L.mask.c) L.mask = null;
      layers.push(L);
    }
  };
  await walk(xml.querySelector("image > stack"), true, 1, 0, 0);
  return { W, H, layers };
}

export async function writeOra(doc) {
  const Z = await jszip();
  const zip = new Z();
  zip.file("mimetype", "image/openraster", { compression: "STORE" });
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const rows = [];
  let i = 0;
  for (const L of [...doc.layers].reverse()) {
    i++;
    const a = { name: L.name, visibility: L.visible ? "visible" : "hidden", opacity: (L.opacity / 100).toFixed(3), "composite-op": toOra(L.blend), "mbv:kind": L.kind };
    if (L.props) a["mbv:props"] = JSON.stringify(L.props);
    if (L.kind === "adjust") {
      const p = `data/layer${i}.png`; zip.file(p, await pngBytes(mkCanvas(1, 1))); Object.assign(a, { src: p, x: 0, y: 0 });
    } else if (L.mask) {
      // per gli altri programmi il livello con la maschera gia' applicata, per MB Desk anche i pixel originali
      const r = mkCanvas(L.c.width, L.c.height), g = r.getContext("2d"), p = `data/layer${i}.png`, q = `data/layer${i}-pixels.png`;
      g.drawImage(L.c, 0, 0);
      if (L.mask.on) { g.globalCompositeOperation = "destination-in"; g.drawImage(L.mask.c, L.mask.x - L.x, L.mask.y - L.y); }
      zip.file(p, await pngBytes(r)); zip.file(q, await pngBytes(L.c));
      Object.assign(a, { src: p, x: L.x, y: L.y, "mbv:pixels": q });
    } else {
      const p = `data/layer${i}.png`; zip.file(p, await pngBytes(L.c)); Object.assign(a, { src: p, x: L.x, y: L.y });
    }
    if (L.mask) {
      const m = `data/mask${i}.png`; zip.file(m, await pngBytes(L.mask.c));
      Object.assign(a, { "mbv:mask": m, "mbv:mask-x": L.mask.x, "mbv:mask-y": L.mask.y, "mbv:mask-on": L.mask.on ? 1 : 0 });
    }
    rows.push("  <layer " + Object.entries(a).map(([k, v]) => `${k}="${esc(v)}"`).join(" ") + "/>");
  }
  zip.file("stack.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<image version="0.0.5" w="${doc.W}" h="${doc.H}" xmlns:mbv="https://mbengineering.it/mbvisual">\n <stack>\n${rows.join("\n")}\n </stack>\n</image>\n`);
  zip.file("mergedimage.png", await pngBytes(doc.composite));
  const s = Math.min(1, 256 / Math.max(doc.W, doc.H)), th = mkCanvas(doc.W * s, doc.H * s);
  th.getContext("2d").drawImage(doc.composite, 0, 0, th.width, th.height);
  zip.file("Thumbnails/thumbnail.png", await pngBytes(th));
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 }, mimeType: "image/openraster" });
}
