// Report delle segnalazioni BCF: PDF (scritto qui, senza librerie: Helvetica + istantanee JPEG) ed Excel (SheetJS gia' incluso).
import { loadScript } from "./core.js";
import { dateIt, dayOf, isOverdue, statusTone, lbl } from "./bcf.js";
import { LOCALE, t as tr } from "./i18n.js";

// ---------------------------------------------------------------- Excel
export async function excelReport(store, title) {
  await loadScript("/vendor/xlsx/dist/xlsx.full.min.js");
  const X = window.XLSX;
  const head = ["N.", tr("bcfreport.titolo"), tr("bcfreport.tipo"), tr("bcfreport.stato"), tr("bcfreport.priorita"), tr("bcfreport.assegnato"), tr("bcfreport.scadenza"), tr("bcfreport.scaduta"), tr("bcfreport.fase"), tr("bcfreport.etichette"), tr("bcfreport.descrizione"), tr("bcfreport.autore"), tr("bcfreport.creata"),
    tr("bcfreport.modificata"), tr("bcfreport.modificata_2"), tr("bcfreport.commenti"), tr("bcfreport.punti_vista"), tr("bcfreport.elementi_selezionati"), "GUID"];
  const rows = store.topics.map((t, i) => [i + 1, t.title, lbl("type", t.type), lbl("status", t.status), lbl("priority", t.priority), t.assignedTo, dayOf(t.dueDate) || xd(t.dueDate),
    isOverdue(t) ? tr("bcfreport.si") : "", t.stage, t.labels.join(", "), t.description, t.creationAuthor, xd(t.creationDate), xd(t.modifiedDate), t.modifiedAuthor,
    t.comments.length, t.viewpoints.length, t.viewpoints.reduce((n, v) => n + (v.vi?.selection?.length || 0), 0), t.guid]);
  const ws = X.utils.aoa_to_sheet([head, ...rows], { cellDates: true });
  ws["!cols"] = [5, 40, 14, 12, 10, 22, 11, 8, 14, 20, 60, 22, 16, 16, 22, 9, 9, 10, 38].map(w => ({ wch: w }));
  ws["!autofilter"] = { ref: X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: head.length - 1 } }) };
  ws["!freeze"] = { xSplit: 0, ySplit: 1 };
  const cm = [["N.", tr("bcfreport.segnalazione"), tr("bcfreport.data"), tr("bcfreport.autore"), tr("bcfreport.commento"), tr("bcfreport.punto_vista")]];
  store.topics.forEach((t, i) => t.comments.forEach(c => cm.push([i + 1, t.title, xd(c.date), c.author, c.text, c.viewpoint ? tr("bcfreport.si") : ""])));
  const wc = X.utils.aoa_to_sheet(cm, { cellDates: true });
  wc["!cols"] = [5, 40, 16, 22, 80, 10].map(w => ({ wch: w }));
  const wb = X.utils.book_new();
  wb.Props = { Title: title, Author: "MB Desk" };
  X.utils.book_append_sheet(wb, ws, tr("bcfreport.segnalazioni"));
  X.utils.book_append_sheet(wb, wc, tr("bcfreport.commenti"));
  const out = X.write(wb, { bookType: "xlsx", type: "array", cellDates: true });
  return new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
const xd = iso => { if (!iso) return ""; const d = new Date(iso); return isNaN(d) ? iso : d; };

// ---------------------------------------------------------------- PDF minimo
const CP1252 = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };
function winAnsi(s) {
  let out = "";
  for (const ch of String(s ?? "")) {
    const c = ch.codePointAt(0);
    let b = c < 0x80 || (c >= 0xa0 && c <= 0xff) ? c : CP1252[c];
    if (b === undefined) b = 0x3f;
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += "\\" + String.fromCharCode(b);
    else if (b < 0x20) out += " ";
    else if (b > 0x7e) out += "\\" + b.toString(8).padStart(3, "0");
    else out += String.fromCharCode(b);
  }
  return out;
}
const measureCtx = document.createElement("canvas").getContext("2d");
export function textW(s, size, bold) {
  measureCtx.font = `${bold ? "bold " : ""}100px Helvetica, Arial, sans-serif`; // Arial ha le stesse larghezze di Helvetica
  return (measureCtx.measureText(s).width / 100) * size;
}
export function wrap(text, size, bold, width) {
  const lines = [];
  for (const para of String(text ?? "").replace(/\r/g, "").split("\n")) {
    let cur = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const t = cur ? cur + " " + word : word;
      if (textW(t, size, bold) <= width) { cur = t; continue; }
      if (cur) lines.push(cur);
      // parola piu' lunga della riga: si spezza
      let w = word;
      while (textW(w, size, bold) > width) { let k = w.length - 1; while (k > 1 && textW(w.slice(0, k), size, bold) > width) k--; lines.push(w.slice(0, k)); w = w.slice(k); }
      cur = w;
    }
    lines.push(cur);
  }
  return lines;
}
export function ellipsis(s, size, bold, width) {
  s = String(s ?? "");
  if (textW(s, size, bold) <= width) return s;
  while (s.length > 1 && textW(s + "…", size, bold) > width) s = s.slice(0, -1);
  return s + "…";
}
const rgb = hex => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(v => v.toFixed(3)).join(" "); };
const TONE = { ok: "#2d7a46", warn: "#946400", bad: "#b2332b" };

export async function toJpeg(blob, maxW = 1400) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, maxW / bmp.width);
  const cv = document.createElement("canvas");
  cv.width = Math.round(bmp.width * k);
  cv.height = Math.round(bmp.height * k);
  const g = cv.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, cv.width, cv.height);
  g.drawImage(bmp, 0, 0, cv.width, cv.height);
  const jb = await new Promise(r => cv.toBlob(r, "image/jpeg", 0.85));
  return { bytes: new Uint8Array(await jb.arrayBuffer()), w: cv.width, h: cv.height };
}

// usati anche dal rapporto delle interferenze (ui/js/clashreport.js)
export class PdfDoc {
  constructor() { this.pages = []; this.images = []; this.W = 595.28; this.H = 841.89; this.M = 40; }
  addPage() { this.page = { ops: [] }; this.pages.push(this.page); return this.page; }
  op(s) { this.page.ops.push(s); }
  // coordinate y misurate dall'alto della pagina
  text(x, yTop, s, size = 10, { bold = false, color = "#1b1e1c" } = {}) {
    this.op(`BT /${bold ? "F2" : "F1"} ${size} Tf ${rgb(color)} rg ${x.toFixed(2)} ${(this.H - yTop - size * 0.8).toFixed(2)} Td (${winAnsi(s)}) Tj ET`);
  }
  rect(x, yTop, w, h, color) { this.op(`${rgb(color)} rg ${x.toFixed(2)} ${(this.H - yTop - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`); }
  line(x1, y1, x2, y2, color = "#c4c7c1", w = 0.6) { this.op(`${rgb(color)} RG ${w} w ${x1.toFixed(2)} ${(this.H - y1).toFixed(2)} m ${x2.toFixed(2)} ${(this.H - y2).toFixed(2)} l S`); }
  image(img, x, yTop, w, h) {
    if (!img.name) { img.name = "Im" + (this.images.length + 1); this.images.push(img); }
    this.op(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${(this.H - yTop - h).toFixed(2)} cm /${img.name} Do Q`);
  }

  async build() {
    const chunks = [];
    let len = 0;
    const offsets = [];
    const push = b => { const u = typeof b === "string" ? latin1(b) : b; chunks.push(u); len += u.length; };
    const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); for (const b of [].concat(body)) push(b); push("\nendobj\n"); };
    push("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
    const nImg = this.images.length, nPages = this.pages.length;
    const imgBase = 5, pageBase = imgBase + nImg;
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    obj(2, `<< /Type /Pages /Count ${nPages} /Kids [${this.pages.map((_, i) => `${pageBase + i * 2} 0 R`).join(" ")}] >>`);
    obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    obj(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    this.images.forEach((im, i) => obj(imgBase + i, [`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`, im.bytes, "\nendstream"]));
    const xo = this.images.map((im, i) => `/${im.name} ${imgBase + i} 0 R`).join(" ");
    for (let i = 0; i < nPages; i++) {
      const content = await deflate(latin1(this.pages[i].ops.join("\n")));
      obj(pageBase + i * 2, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.W} ${this.H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << ${xo} >> >> /Contents ${pageBase + i * 2 + 1} 0 R >>`);
      obj(pageBase + i * 2 + 1, [`<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`, content, "\nendstream"]);
    }
    const total = pageBase + nPages * 2;
    const xref = len;
    let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
    for (let i = 1; i < total; i++) x += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
    push(x + `trailer\n<< /Size ${total} /Root 1 0 R /Info << /Producer (MB Desk) /Title (${winAnsi(this.title || tr("bcfreport.report_segnalazioni"))}) >> >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(chunks, { type: "application/pdf" });
  }
}
const latin1 = s => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };
async function deflate(bytes) {
  // CompressionStream "deflate" = zlib (RFC 1950), cioe' proprio il FlateDecode del PDF
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
}

export async function pdfReport(store, { title = tr("bcfreport.report_segnalazioni"), model = "", onProgress } = {}) {
  const d = new PdfDoc();
  d.title = title;
  const { M, W } = d, CW = W - 2 * M;
  const today = new Date().toLocaleDateString(LOCALE);
  d.addPage();
  // ---- frontespizio e riepilogo
  d.rect(M, M, CW, 4, "#2c6797");
  d.text(M, M + 16, title, 20, { bold: true });
  let y = M + 44;
  if (model) { d.text(M, y, tr("bcfreport.modello_0", model), 10, { color: "#646863" }); y += 15; }
  if (store.project?.name) { d.text(M, y, tr("bcfreport.progetto_0", store.project.name), 10, { color: "#646863" }); y += 15; }
  d.text(M, y, tr("bcfreport.generato_0_mb_visual_formato", today, store.version), 10, { color: "#646863" });
  y += 28;
  const T = store.topics;
  const count = f => T.filter(f).length;
  const boxes = [[tr("bcfreport.totale"), T.length, "#2c6797"], [tr("bcfreport.aperte"), count(t => statusTone(t.status) === "bad"), TONE.bad], [tr("bcfreport.corso"), count(t => statusTone(t.status) === "warn"), TONE.warn],
    [tr("bcfreport.risolte_chiuse"), count(t => statusTone(t.status) === "ok"), TONE.ok], [tr("bcfreport.scadute"), count(isOverdue), "#7a1f1a"]];
  const bw = (CW - 4 * 8) / 5;
  boxes.forEach(([lab, n, col], i) => {
    const x = M + i * (bw + 8);
    d.rect(x, y, bw, 46, "#f1f2f0");
    d.rect(x, y, 3, 46, col);
    d.text(x + 10, y + 7, String(n), 18, { bold: true, color: col });
    d.text(x + 10, y + 30, lab, 8.5, { color: "#646863" });
  });
  y += 64;
  // ---- elenco
  const cols = [["N.", 24], [tr("bcfreport.titolo"), 196], [tr("bcfreport.tipo"), 62], [tr("bcfreport.stato"), 58], [tr("bcfreport.priorita"), 52], [tr("bcfreport.assegnato"), 75], [tr("bcfreport.scadenza"), 48]];
  const headRow = yy => { d.rect(M, yy, CW, 16, "#2c6797"); let x = M + 4; for (const [c, w] of cols) { d.text(x, yy + 4, c, 8, { bold: true, color: "#ffffff" }); x += w; } return yy + 16; };
  y = headRow(y);
  T.forEach((t, i) => {
    if (y > d.H - M - 30) { d.addPage(); y = headRow(M + 10); }
    if (i % 2) d.rect(M, y, CW, 15, "#f6f7f5");
    const vals = [String(i + 1), t.title, lbl("type", t.type), lbl("status", t.status), lbl("priority", t.priority), t.assignedTo, dateIt(t.dueDate)];
    let x = M + 4;
    vals.forEach((v, k) => {
      const color = k === 3 ? TONE[statusTone(t.status)] : k === 6 && isOverdue(t) ? TONE.bad : "#1b1e1c";
      d.text(x, y + 4, ellipsis(v, 8, k === 3, cols[k][1] - 6), 8, { bold: k === 3, color });
      x += cols[k][1];
    });
    y += 15;
  });
  // ---- schede
  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    onProgress?.(i / T.length);
    d.addPage();
    y = M + 10;
    const tone = TONE[statusTone(t.status)];
    d.rect(M, y, 4, 22, tone);
    const tl = wrap(`${i + 1}. ${t.title || tr("bcfreport.senza_titolo")}`, 14, true, CW - 14);
    tl.forEach((l, k) => d.text(M + 12, y + 2 + k * 17, l, 14, { bold: true }));
    y += Math.max(22, tl.length * 17) + 10;
    const fields = [[tr("bcfreport.tipo"), lbl("type", t.type)], [tr("bcfreport.stato"), lbl("status", t.status)], [tr("bcfreport.priorita"), lbl("priority", t.priority)], [tr("bcfreport.assegnato"), t.assignedTo],
      [tr("bcfreport.scadenza"), (isOverdue(t) ? tr("bcfreport.0_scaduta", dateIt(t.dueDate)) : dateIt(t.dueDate))], [tr("bcfreport.fase"), t.stage], [tr("bcfreport.etichette"), t.labels.join(", ")],
      [tr("bcfreport.creata_2"), [dateIt(t.creationDate, true), t.creationAuthor].filter(Boolean).join(" · ")], [tr("bcfreport.modificata_3"), [dateIt(t.modifiedDate, true), t.modifiedAuthor].filter(Boolean).join(" · ")]]
      .filter(f => f[1]);
    const half = CW / 2;
    fields.forEach((f, k) => {
      const x = M + (k % 2) * half, yy = y + Math.floor(k / 2) * 26;
      d.text(x, yy, f[0].toUpperCase(), 7, { bold: true, color: "#646863" });
      d.text(x, yy + 10, ellipsis(f[1], 9.5, false, half - 10), 9.5, { color: f[0] === tr("bcfreport.scadenza") && isOverdue(t) ? TONE.bad : "#1b1e1c" });
    });
    y += Math.ceil(fields.length / 2) * 26 + 6;
    // istantanee
    for (const v of t.viewpoints) {
      if (!v.snapshot) continue;
      let img;
      try { img = await toJpeg(v.snapshot); } catch { continue; }
      let w = CW, h = (img.h / img.w) * w;
      if (h > 300) { h = 300; w = (img.w / img.h) * h; }
      if (y + h > d.H - M - 20) { d.addPage(); y = M + 10; }
      d.rect(M - 0.5, y - 0.5, w + 1, h + 1, "#c4c7c1");
      d.image(img, M, y, w, h);
      y += h + 6;
      const sel = v.vi?.selection?.length;
      if (sel) { d.text(M, y, tr("bcfreport.elementi_selezionati_punto_vista_0", sel), 8, { color: "#646863" }); y += 12; }
      y += 6;
    }
    const para = (label, text) => {
      if (!text) return;
      if (y > d.H - M - 50) { d.addPage(); y = M + 10; }
      d.text(M, y, label.toUpperCase(), 7, { bold: true, color: "#646863" });
      y += 12;
      for (const l of wrap(text, 9.5, false, CW)) { if (y > d.H - M - 20) { d.addPage(); y = M + 10; } d.text(M, y, l, 9.5); y += 13; }
      y += 8;
    };
    para(tr("bcfreport.descrizione"), t.description);
    if (t.comments.length) {
      if (y > d.H - M - 60) { d.addPage(); y = M + 10; }
      d.text(M, y, tr("bcfreport.commenti_0", t.comments.length), 7, { bold: true, color: "#646863" });
      y += 13;
      for (const c of t.comments) {
        const lines = wrap(c.text, 9.5, false, CW - 12);
        if (y + 14 + lines.length * 13 > d.H - M - 20) { d.addPage(); y = M + 10; }
        d.rect(M, y, 2, 12 + lines.length * 13, "#c4c7c1");
        d.text(M + 10, y, [c.author, dateIt(c.date, true)].filter(Boolean).join(" · "), 8.5, { bold: true, color: "#2c6797" });
        y += 13;
        for (const l of lines) { d.text(M + 10, y, l, 9.5); y += 13; }
        y += 7;
      }
    }
  }
  // intestazione e numeri di pagina
  d.pages.forEach((p, i) => {
    d.page = p;
    if (i) d.text(M, 20, ellipsis(`${title}${model ? " · " + model : ""}`, 7.5, false, CW - 80), 7.5, { color: "#8a8c89" });
    d.line(M, d.H - 28, W - M, d.H - 28);
    d.text(M, d.H - 24, tr("bcfreport.mb_visual_segnalazioni_bcf_0", today), 7.5, { color: "#8a8c89" });
    const pg = tr("bcfreport.pagina_0_1", i + 1, d.pages.length);
    d.text(W - M - textW(pg, 7.5), d.H - 24, pg, 7.5, { color: "#8a8c89" });
  });
  onProgress?.(1);
  return d.build();
}
