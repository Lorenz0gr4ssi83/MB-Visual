// Pubblicazioni: esportazioni. PDF fedele (testo vero con i caratteri di Windows incorporati, forme vettoriali,
// immagini fino a 300 dpi) costruito dalle stesse operazioni di disegno dello schermo (RecordPainter) e scritto da
// PyMuPDF (mbvisual/publisher.py, API pub_pdf). Nella web app, senza motore Python, il PDF contiene le pagine come
// immagini ad alta risoluzione. Piu' PNG/JPG per pagina, anteprima del file .mbpub e immagine della selezione.
import { api, saveBytes, WEB, withExt, baseName } from "./core.js";
import { walk } from "./pubmodel.js";
import { computeLayouts, drawPage, drawObj, CanvasPainter, RecordPainter, filterCss, aabb } from "./pubrender.js";

// immagini decodificate per l'esportazione (indipendenti dallo schermo)
async function bitmaps(doc) {
  const out = new Map();
  const used = new Set();
  for (const p of doc.pages) { if (p.bg?.img) used.add(p.bg.img); for (const o of walk(p.items)) if (o.img?.id) used.add(o.img.id); }
  for (const m of doc.masters) for (const o of walk(m.items)) if (o.img?.id) used.add(o.img.id);
  for (const id of used) {
    const im = doc.images[id];
    if (!im) continue;
    try { out.set(id, await createImageBitmap(new Blob([im.bytes], { type: im.mime }))); } catch { /* immagine non leggibile */ }
  }
  return { get: id => out.get(id) || null, has: id => out.has(id), close: () => out.forEach(b => b.close?.()) };
}

export function renderPageCanvas(doc, pi, dpi, imgs, record = null) {
  const s = dpi / 72;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(doc.w * s)); c.height = Math.max(1, Math.round(doc.h * s));
  const g = c.getContext("2d");
  g.setTransform(s, 0, 0, s, 0, 0);
  drawPage({ doc, lay: computeLayouts(doc, { record }), pageNo: pi, painter: new CanvasPainter(g, imgs), editing: false, scale: s, images: imgs }, doc.pages[pi]);
  return c;
}
const toBytes = async (c, type, q) => new Uint8Array(await (await new Promise(r => c.toBlob(r, type, q))).arrayBuffer());

export async function thumbnailPng(doc) {
  const imgs = await bitmaps(doc);
  try {
    const c = renderPageCanvas(doc, 0, Math.min(96, (400 / Math.max(doc.w, doc.h)) * 72), imgs);
    return await toBytes(c, "image/png");
  } finally { imgs.close(); }
}

// PNG/JPG: un file per pagina (nome-1.png, nome-2.png... se le pagine sono piu' di una)
export async function exportImages(doc, path, dpi = 200) {
  const ext = path.toLowerCase().endsWith(".png") ? "png" : "jpg";
  const imgs = await bitmaps(doc);
  const files = [];
  try {
    for (let pi = 0; pi < doc.pages.length; pi++) {
      const c = renderPageCanvas(doc, pi, dpi, imgs);
      if (ext === "jpg") { const g = c.getContext("2d"); g.globalCompositeOperation = "destination-over"; g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); }
      const bytes = await toBytes(c, ext === "png" ? "image/png" : "image/jpeg", 0.92);
      const target = doc.pages.length > 1 ? path.replace(/(\.[^.\\/]+)$/, `-${pi + 1}$1`) : path;
      await saveBytes(target, bytes);
      files.push(target);
    }
  } finally { imgs.close(); }
  return files;
}

// oggetti selezionati come PNG trasparente
export async function renderObjectsPng(E, objs, dpi = 200) {
  const doc = E.doc();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of objs) { const b = aabb(o); x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); }
  const pad = 4, s = dpi / 72;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round((x1 - x0 + 2 * pad) * s)); c.height = Math.max(1, Math.round((y1 - y0 + 2 * pad) * s));
  const g = c.getContext("2d");
  g.setTransform(s, 0, 0, s, (pad - x0) * s, (pad - y0) * s);
  const imgs = await bitmaps(doc);
  try {
    const env = { doc, lay: computeLayouts(doc), pageNo: E.cur(), painter: new CanvasPainter(g, imgs), editing: false, scale: s, images: imgs };
    for (const o of objs) drawObj(env, o, false);
  } finally { imgs.close(); }
  return toBytes(c, "image/png");
}

// ------------------------------------------------------------------ PDF
async function imageForOp(op, doc, imgs, cache) {
  const im = doc.images[op.id], bmp = imgs.get(op.id);
  if (!im || !bmp) return null;
  const [q0, q1, q2, q3] = op.q;
  let ux = q1[0] - q0[0], uy = q1[1] - q0[1];
  const vx = q3[0] - q0[0], vy = q3[1] - q0[1];
  const mirror = ux * vy - uy * vx < 0;
  if (mirror) { ux = -ux; uy = -uy; } // immagine riflessa: si capovolge nei pixel e si mantiene la rotazione visibile
  const w = Math.hypot(ux, uy), h = Math.hypot(vx, vy);
  const angle = (Math.atan2(uy, ux) * 180) / Math.PI;
  const [sx, sy, sw, sh] = op.src;
  const k = Math.min(1, ((w / 72) * 300) / sw, ((h / 72) * 300) / sh);
  const pw = Math.max(1, Math.round(sw * k)), ph = Math.max(1, Math.round(sh * k));
  const full = Math.abs(sx) < 0.5 && Math.abs(sy) < 0.5 && Math.abs(sw - im.w) < 0.5 && Math.abs(sh - im.h) < 0.5;
  const fx = filterCss(op.fx);
  const key = JSON.stringify([op.id, Math.round(sx), Math.round(sy), Math.round(sw), Math.round(sh), fx, op.op, mirror, pw, ph]);
  let bytes = cache.get(key);
  if (!bytes) {
    if (full && !fx && op.op >= 0.999 && !mirror && k >= 0.999 && /^image\/(jpeg|png)$/.test(im.mime)) bytes = im.bytes; // file originale, nessuna perdita
    else {
      const c = document.createElement("canvas");
      c.width = pw; c.height = ph;
      const g = c.getContext("2d");
      if (fx) g.filter = fx;
      if (mirror) { g.translate(pw, 0); g.scale(-1, 1); }
      g.globalAlpha = op.op;
      g.drawImage(bmp, sx, sy, sw, sh, 0, 0, pw, ph);
      const alpha = op.op < 0.999 || im.mime !== "image/jpeg";
      bytes = await toBytes(c, alpha ? "image/png" : "image/jpeg", 0.92);
    }
    cache.set(key, bytes);
  }
  const cx = (q0[0] + q2[0]) / 2, cy = (q0[1] + q2[1]) / 2;
  return { key, bytes, op: { t: "image", key, c: [cx, cy], w, h, a: angle } };
}

async function pdfPayload(doc, records) {
  const imgs = await bitmaps(doc);
  const cache = new Map();
  const blobs = new Map();
  const pages = [];
  try {
    for (const record of records) {
      const lay = computeLayouts(doc, { record });
      for (let pi = 0; pi < doc.pages.length; pi++) {
        const P = new RecordPainter();
        drawPage({ doc, lay, pageNo: pi, painter: P, editing: false, scale: 4, images: imgs }, doc.pages[pi]);
        const ops = [];
        for (const op of P.ops) {
          if (op.t !== "image") { ops.push(op); continue; }
          const r = await imageForOp(op, doc, imgs, cache);
          if (!r) continue;
          blobs.set(r.key, r.bytes);
          ops.push(r.op);
        }
        pages.push({ w: doc.w, h: doc.h, ops });
      }
    }
  } finally { imgs.close(); }
  // corpo: "MBPUB1" + lunghezza JSON (4 byte) + JSON + immagini una dopo l'altra
  const index = {};
  let off = 0;
  const parts = [];
  for (const [key, b] of blobs) { index[key] = [off, b.length]; parts.push(b); off += b.length; }
  const json = new TextEncoder().encode(JSON.stringify({ pages, blobs: index, title: doc.title || "" }));
  const out = new Uint8Array(10 + json.length + off);
  out.set(new TextEncoder().encode("MBPUB1"), 0);
  new DataView(out.buffer).setUint32(6, json.length, true);
  out.set(json, 10);
  let p = 10 + json.length;
  for (const b of parts) { out.set(b, p); p += b.length; }
  return out;
}

export async function exportPdfFile(E, path, records = [null]) {
  const doc = E.doc();
  if (WEB) return saveBytes(path, await rasterPdf(doc, records));
  const body = await pdfPayload(doc, records);
  return api("pub_pdf", { path }, { body });
}
export async function exportMergedPdf(E, path, rows) {
  if (!rows.length) throw new Error("Nessun destinatario selezionato");
  return exportPdfFile(E, path, rows);
}

// web app: PDF con le pagine come immagini JPEG (200 dpi)
async function rasterPdf(doc, records) {
  const imgs = await bitmaps(doc);
  const pages = [];
  try {
    for (const record of records) for (let pi = 0; pi < doc.pages.length; pi++) {
      const c = renderPageCanvas(doc, pi, 200, imgs, record);
      const g = c.getContext("2d"); g.globalCompositeOperation = "destination-over"; g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
      pages.push({ jpeg: await toBytes(c, "image/jpeg", 0.9), pw: c.width, ph: c.height });
    }
  } finally { imgs.close(); }
  const enc = new TextEncoder();
  const chunks = [];
  let len = 0;
  const offs = [];
  const push = b => { const u = typeof b === "string" ? enc.encode(b) : b; chunks.push(u); len += u.length; };
  push("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
  const n = pages.length;
  const kids = pages.map((_, k) => `${3 + k * 3} 0 R`).join(" ");
  const obj = (id, body) => { offs[id] = len; push(`${id} 0 obj\n`); if (typeof body === "string") push(body); else body(); push("\nendobj\n"); };
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  pages.forEach((p, k) => {
    const id = 3 + k * 3;
    const W = doc.w.toFixed(2), H = doc.h.toFixed(2);
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    obj(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`);
    obj(id + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    obj(id + 2, () => { push(`<< /Type /XObject /Subtype /Image /Width ${p.pw} /Height ${p.ph} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`); push(p.jpeg); push("\nendstream"); });
  });
  const xref = len;
  const total = 3 + n * 3;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let id = 1; id < total; id++) x += String(offs[id]).padStart(10, "0") + " 00000 n \n";
  push(x + `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
void withExt; void baseName;
