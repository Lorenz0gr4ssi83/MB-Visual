// Esportazioni dei fogli DWF/DWFx: SVG (vettoriale, un foglio), PDF (vettoriale, piu' pagine), PNG (immagine).
import { prepareSheet, drawSheet, cssFont } from "./dwfdraw.js";

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const f = v => (Math.abs(v) < 1e-9 ? "0" : +v.toFixed(5) + "");
const visibleFn = (opts) => p => !(p.layer && opts.hiddenLayers?.has(p.layer)) && !(p.mk && opts.showMarkups === false);
const area = s => s.paper ? [0, 0, s.paper.w, s.paper.h] : s.ink;

// ---------------------------------------------------------------- PNG
export async function sheetToPng(sheet, opts = {}) {
  const prep = await prepareSheet(sheet);
  const [x0, y0, x1, y1] = area(sheet);
  const mm = sheet.paper ? (sheet.paper.units === "mm" ? 1 : 25.4) : 0;
  // 200 dpi sulla carta, al massimo 8000 pixel per lato
  let k = mm ? 200 / 25.4 * mm : 4000 / Math.max(x1 - x0, y1 - y0);
  k = Math.min(k, 8000 / Math.max(x1 - x0, y1 - y0));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round((x1 - x0) * k));
  c.height = Math.max(1, Math.round((y1 - y0) * k));
  drawSheet(c.getContext("2d"), c.width, c.height, sheet, prep, { s: k, tx: -x0 * k, ty: y1 * k }, { ...opts, export: true, dpr: Math.max(1, k / 8) });
  return await new Promise(r => c.toBlob(r, "image/png"));
}

// ---------------------------------------------------------------- SVG
export async function sheetToSvg(sheet, opts = {}) {
  const prep = await prepareSheet(sheet);
  const vis = visibleFn(opts);
  const [x0, y0, x1, y1] = area(sheet);
  const W = x1 - x0, H = y1 - y0, u = sheet.paper?.units || "";
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${f(W)}${u}" height="${f(H)}${u}" viewBox="0 0 ${f(W)} ${f(H)}">`];
  out.push(`<title>${esc(sheet.title)}</title>`);
  if (sheet.paper) out.push(`<rect x="0" y="0" width="${f(W)}" height="${f(H)}" fill="rgb(${(sheet.paper.color || [255, 255, 255]).slice(0, 3).join(",")})"/>`);
  // coordinate della carta (y in su) -> SVG (y in giu')
  out.push(`<g transform="matrix(1 0 0 -1 ${f(-x0)} ${f(y1)})">`);
  const defs = [];
  sheet.clips.forEach((c, i) => {
    defs.push(`<clipPath id="c${i}"${c.parent !== null && c.parent !== undefined ? ` clip-path="url(#c${c.parent})"` : ""}><path clip-rule="${c.rule === "nonzero" ? "nonzero" : "evenodd"}" d="${ringsD(c.rings, true)}"/></clipPath>`);
  });
  const imgId = new Map();
  for (const [key, bmp] of prep.bitmaps) {
    const url = await bitmapUrl(bmp);
    imgId.set(key, "i" + imgId.size);
    defs.push(`<image id="${imgId.get(key)}" width="1" height="1" preserveAspectRatio="none" xlink:href="${url}" href="${url}"/>`);
  }
  out.push(`<defs>${defs.join("")}</defs>`);
  let layerOpen = null;
  const openLayer = l => { if (l === layerOpen) return; if (layerOpen !== null) out.push("</g>"); out.push(`<g data-layer="${esc(l || "")}">`); layerOpen = l; };
  for (const p of sheet.prims) {
    if (!vis(p)) continue;
    openLayer(p.layer || "");
    const clip = p.clip !== null && p.clip !== undefined ? ` clip-path="url(#c${p.clip})"` : "";
    const a = (p.color?.[3] ?? 255) / 255;
    const rgb = p.color ? `rgb(${p.color[0]},${p.color[1]},${p.color[2]})` : "#000";
    if (p.t === "p") {
      const d = p.rings.map((r, k) => ringD(r, p.fill || (Array.isArray(p.closed) ? p.closed[k] : p.closed))).join("");
      if (p.fill) out.push(`<path d="${d}" fill="${rgb}"${a < 1 ? ` fill-opacity="${f(a)}"` : ""} fill-rule="${p.rule === "nonzero" ? "nonzero" : "evenodd"}"${clip}/>`);
      else {
        const lw = p.lw || 0;
        const dash = p.dash?.world ? ` stroke-dasharray="${p.dash.world.map(f).join(" ")}"` : p.dash?.px ? ` stroke-dasharray="${p.dash.px.map(v => f(v * 0.25 * (sheet.paper?.units === "in" ? 1 / 25.4 : 1))).join(" ")}"` : "";
        out.push(`<path d="${d}" fill="none" stroke="${rgb}"${a < 1 ? ` stroke-opacity="${f(a)}"` : ""} stroke-width="${lw > 0 ? f(lw) : "1"}"${lw > 0 ? "" : ' vector-effect="non-scaling-stroke"'} stroke-linecap="${p.cap || "round"}" stroke-linejoin="${p.join || "round"}"${dash}${clip}/>`);
      }
    } else if (p.t === "x" && !p.hidden && opts.showText !== false) {
      const m = p.m;
      const fam = esc(String(p.font || "Arial").replace(/^@/, ""));
      const style = `${p.bold ? ' font-weight="bold"' : ""}${p.italic ? ' font-style="italic"' : ""}`;
      if (p.adv) {
        let x = 0;
        const xs = [...p.s].map((ch, k) => { const v = x; x += p.adv[k] ?? 0.55; return f(v * 100); });
        out.push(`<text transform="matrix(${[m[0] / 100, m[1] / 100, -m[2] / 100, -m[3] / 100, m[4], m[5]].map(f).join(" ")})" x="${xs.join(" ")}" y="0" font-family="${fam}, Arial" font-size="100"${style} fill="${rgb}"${a < 1 ? ` fill-opacity="${f(a)}"` : ""}${clip} xml:space="preserve">${esc(p.s)}</text>`);
      } else {
        p.s.split("\n").forEach((ln, k) => out.push(`<text transform="matrix(${[m[0] / 100, m[1] / 100, -m[2] / 100, -m[3] / 100, m[4], m[5]].map(f).join(" ")})" x="0" y="${k * 140}" font-family="${fam}, Arial" font-size="100"${style} fill="${rgb}"${clip} xml:space="preserve">${esc(ln)}</text>`));
      }
    } else if (p.t === "i" && imgId.has(p.src)) {
      const m = p.m;
      out.push(`<use xlink:href="#${imgId.get(p.src)}" href="#${imgId.get(p.src)}" transform="matrix(${m.map(f).join(" ")})"${p.opacity !== undefined && p.opacity < 1 ? ` opacity="${f(p.opacity)}"` : ""}${clip}/>`);
    }
  }
  if (layerOpen !== null) out.push("</g>");
  out.push("</g></svg>");
  return new Blob([out.join("\n")], { type: "image/svg+xml" });
}
function ringD(r, close) {
  if (r.length < 2) return "";
  let s = "M" + f(r[0]) + " " + f(r[1]);
  if (r.length === 2) s += "L" + f(r[0]) + " " + f(r[1]);
  for (let i = 2; i < r.length; i += 2) s += "L" + f(r[i]) + " " + f(r[i + 1]);
  return close ? s + "Z" : s;
}
const ringsD = (rings, close) => rings.map(r => ringD(r, close)).join("");
async function bitmapUrl(bmp) {
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  c.getContext("2d").drawImage(bmp, 0, 0);
  const blob = await new Promise(r => c.toBlob(r, "image/png"));
  const b = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768));
  return "data:image/png;base64," + btoa(s);
}

// ---------------------------------------------------------------- PDF (vettoriale, scritto da zero)
const enc = new TextEncoder();
async function deflate(bytes) {
  const cs = new CompressionStream("deflate"); // formato zlib, come richiesto da FlateDecode
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer());
}
// testo in WinAnsi (Helvetica standard): i caratteri non rappresentabili diventano "?"
const WIN = (() => {
  const m = new Map();
  for (let i = 32; i < 127; i++) m.set(i, i);
  for (let i = 160; i < 256; i++) m.set(i, i);
  const extra = { 0x20ac: 128, 0x201a: 130, 0x192: 131, 0x201e: 132, 0x2026: 133, 0x2020: 134, 0x2021: 135, 0x2c6: 136, 0x2030: 137, 0x160: 138, 0x2039: 139, 0x152: 140, 0x17d: 142, 0x2018: 145, 0x2019: 146, 0x201c: 147, 0x201d: 148, 0x2022: 149, 0x2013: 150, 0x2014: 151, 0x2dc: 152, 0x2122: 153, 0x161: 154, 0x203a: 155, 0x153: 156, 0x17e: 158, 0x178: 159, 0x2300: 216, 0x2205: 216 };
  for (const [k, v] of Object.entries(extra)) m.set(+k, v);
  return m;
})();
const pdfStr = s => { let o = "("; for (const ch of s) { const c = WIN.get(ch.codePointAt(0)) ?? 63; o += c === 40 || c === 41 || c === 92 ? "\\" + String.fromCharCode(c) : c < 32 || c > 126 ? "\\" + c.toString(8).padStart(3, "0") : String.fromCharCode(c); } return o + ")"; };
const MEASURE = document.createElement("canvas").getContext("2d");

/**
 * PDF con un foglio per pagina. sheets: modelli gia' caricati.
 * Linee, aree, testi (Helvetica, larghezza adattata a quella del carattere originale) e immagini restano vettoriali/nativi.
 */
export async function sheetsToPdf(sheets, opts = {}) {
  const objs = []; // [numero] -> Uint8Array del corpo
  const add = body => { objs.push(body); return objs.length; };
  const fontReg = add(null), fontBold = add(null), fontIt = add(null), fontBI = add(null);
  objs[fontReg - 1] = enc.encode("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objs[fontBold - 1] = enc.encode("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  objs[fontIt - 1] = enc.encode("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>");
  objs[fontBI - 1] = enc.encode("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-BoldOblique /Encoding /WinAnsiEncoding >>");
  const pagesId = add(null);
  const pageIds = [];
  for (const sheet of sheets) {
    const prep = await prepareSheet(sheet);
    const vis = visibleFn(opts);
    const [x0, y0, x1, y1] = area(sheet);
    const k = sheet.paper ? (sheet.paper.units === "mm" ? 72 / 25.4 : 72) : 842 / Math.max(x1 - x0, y1 - y0); // punti per unita'
    const PW = (x1 - x0) * k, PH = (y1 - y0) * k;
    const N = v => +v.toFixed(3);
    const X = x => N((x - x0) * k), Y = y => N((y - y0) * k);
    const cs = [];
    // immagini della pagina
    const xo = new Map();
    for (const [key, bmp] of prep.bitmaps) {
      const im = sheet.images.get(key);
      xo.set(key, await imageObject(add, bmp, im));
    }
    if (sheet.paper) { const c = sheet.paper.color || [255, 255, 255]; cs.push(`${c.slice(0, 3).map(v => N(v / 255)).join(" ")} rg 0 0 ${N(PW)} ${N(PH)} re f`); }
    const pathOps = (p) => p.rings.map((r, idx) => {
      if (r.length < 2) return "";
      let s = `${X(r[0])} ${Y(r[1])} m`;
      if (r.length === 2) s += ` ${X(r[0])} ${Y(r[1])} l`;
      for (let i = 2; i < r.length; i += 2) s += ` ${X(r[i])} ${Y(r[i + 1])} l`;
      return s + ((p.fill || (Array.isArray(p.closed) ? p.closed[idx] : p.closed)) ? " h" : "");
    }).join(" ");
    const clipOps = ci => {
      const chain = [];
      for (let c = ci; c !== null && c !== undefined; c = sheet.clips[c].parent) chain.push(c);
      return chain.map(c => { const cl = sheet.clips[c]; return pathOps({ rings: cl.rings, fill: true }) + (cl.rule === "nonzero" ? " W n" : " W* n"); }).join(" ");
    };
    const gsAlpha = new Map();
    const alphaName = a => { const key = N(a); if (!gsAlpha.has(key)) gsAlpha.set(key, "GA" + gsAlpha.size); return gsAlpha.get(key); };
    for (const p of sheet.prims) {
      if (!vis(p)) continue;
      const hasClip = p.clip !== null && p.clip !== undefined;
      const col = p.color || [0, 0, 0, 255];
      const a = (col[3] ?? 255) / 255;
      const rgb = col.slice(0, 3).map(v => N(v / 255)).join(" ");
      if (p.t === "p") {
        let s = "q ";
        if (hasClip) s += clipOps(p.clip) + " ";
        if (a < 0.999) s += `/${alphaName(a)} gs `;
        if (p.fill) s += `${rgb} rg ${pathOps(p)} ${p.rule === "nonzero" ? "f" : "f*"}`;
        else {
          const lw = p.lw > 0 ? p.lw * k : 0.25;
          const dash = p.dash?.world ? `[${p.dash.world.map(v => N(v * k)).join(" ")}] ${N((p.dash.offset || 0) * k)} d ` : p.dash?.px ? `[${p.dash.px.map(v => N(v * 0.75)).join(" ")}] 0 d ` : "";
          s += `${rgb} RG ${N(lw)} w ${p.cap === "butt" ? 0 : p.cap === "square" ? 2 : 1} J ${p.join === "miter" ? 0 : p.join === "bevel" ? 2 : 1} j ${dash}${pathOps(p)} S`;
        }
        cs.push(s + " Q");
      } else if (p.t === "x" && !p.hidden && opts.showText !== false) {
        const m = p.m;
        const font = p.bold && p.italic ? "/FBI" : p.bold ? "/FB" : p.italic ? "/FI" : "/FR";
        // larghezza: si adatta Helvetica alla larghezza del carattere originale (misurata nel browser)
        MEASURE.font = cssFont(p);
        const lines = p.s.split("\n");
        let s = "q ";
        if (hasClip) s += clipOps(p.clip) + " ";
        if (a < 0.999) s += `/${alphaName(a)} gs `;
        s += `${rgb} rg BT ${font} 1 Tf `;
        lines.forEach((ln, li) => {
          const orig = p.adv ? p.adv.reduce((t, v) => t + (v ?? 0.55), 0) : MEASURE.measureText(ln).width / 100;
          MEASURE.font = `${p.bold ? "bold " : ""}${p.italic ? "italic " : ""}100px Helvetica, Arial, sans-serif`;
          const helv = MEASURE.measureText(ln).width / 100;
          MEASURE.font = cssFont(p);
          const tz = helv > 0 && orig > 0 ? Math.max(30, Math.min(300, (orig / helv) * 100)) : 100;
          // matrice testo: spazio del testo (em) -> pagina PDF
          const tm = [m[0] * k, m[1] * k, m[2] * k, m[3] * k, (m[4] - x0) * k + m[2] * k * (-li * 1.4), (m[5] - y0) * k + m[3] * k * (-li * 1.4)];
          s += `${N(tz)} Tz ${tm.map(v => N(v)).join(" ")} Tm ${pdfStr(ln)} Tj `;
        });
        cs.push(s + "ET Q");
      } else if (p.t === "i" && xo.has(p.src)) {
        const m = p.m;
        // spazio immagine PDF: quadrato unitario con origine in basso a sinistra (y in su)
        const M = [m[0] * k, m[1] * k, -m[2] * k, -m[3] * k, (m[2] + m[4] - x0) * k, (m[3] + m[5] - y0) * k];
        cs.push(`q ${hasClip ? clipOps(p.clip) + " " : ""}${M.map(N).join(" ")} cm /${xo.get(p.src).name} Do Q`);
      }
    }
    const content = await deflate(enc.encode(cs.join("\n")));
    const contentId = add(concat(enc.encode(`<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`), content, enc.encode("\nendstream")));
    const gsDict = [...gsAlpha].map(([a, n]) => `/${n} << /ca ${a} /CA ${a} >>`).join(" ");
    const xoDict = [...xo.values()].map(v => `/${v.name} ${v.id} 0 R`).join(" ");
    pageIds.push(add(enc.encode(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${N(PW)} ${N(PH)}] /Resources << /Font << /FR ${fontReg} 0 R /FB ${fontBold} 0 R /FI ${fontIt} 0 R /FBI ${fontBI} 0 R >> /XObject << ${xoDict} >> /ExtGState << ${gsDict} >> >> /Contents ${contentId} 0 R >>`)));
  }
  objs[pagesId - 1] = enc.encode(`<< /Type /Pages /Kids [${pageIds.map(i => i + " 0 R").join(" ")}] /Count ${pageIds.length} >>`);
  const title = opts.title ? `/Title ${pdfStr(opts.title)} ` : "";
  const infoId = add(enc.encode(`<< ${title}/Producer (MB Visual) >>`));
  const catId = add(enc.encode(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`));
  // file
  const parts = [enc.encode("%PDF-1.5\n%\xe2\xe3\xcf\xd3\n")];
  let len = parts[0].length;
  const offs = [];
  objs.forEach((b, i) => { offs.push(len); const h = enc.encode(`${i + 1} 0 obj\n`), t = enc.encode("\nendobj\n"); parts.push(h, b, t); len += h.length + b.length + t.length; });
  let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) x += String(o).padStart(10, "0") + " 00000 n \n";
  x += `trailer\n<< /Size ${objs.length + 1} /Root ${catId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${len}\n%%EOF`;
  parts.push(enc.encode(x));
  return new Blob(parts, { type: "application/pdf" });
}
function concat(...arrs) { const n = arrs.reduce((s, a) => s + a.length, 0), o = new Uint8Array(n); let k = 0; for (const a of arrs) { o.set(a, k); k += a.length; } return o; }

let imgSeq = 0;
async function imageObject(add, bmp, im) {
  const name = "Im" + ++imgSeq;
  if (im?.mime === "image/jpeg" && im.bytes) {
    const id = add(concat(enc.encode(`<< /Type /XObject /Subtype /Image /Width ${bmp.width} /Height ${bmp.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`), im.bytes, enc.encode("\nendstream")));
    return { id, name };
  }
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext("2d");
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const n = c.width * c.height, rgb = new Uint8Array(n * 3), alpha = new Uint8Array(n);
  let hasA = false;
  for (let i = 0; i < n; i++) { rgb[3 * i] = d[4 * i]; rgb[3 * i + 1] = d[4 * i + 1]; rgb[3 * i + 2] = d[4 * i + 2]; alpha[i] = d[4 * i + 3]; if (d[4 * i + 3] < 255) hasA = true; }
  let smask = "";
  if (hasA) {
    const z = await deflate(alpha);
    const sid = add(concat(enc.encode(`<< /Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${z.length} >>\nstream\n`), z, enc.encode("\nendstream")));
    smask = ` /SMask ${sid} 0 R`;
  }
  const z = await deflate(rgb);
  const id = add(concat(enc.encode(`<< /Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${smask} /Length ${z.length} >>\nstream\n`), z, enc.encode("\nendstream")));
  return { id, name };
}
