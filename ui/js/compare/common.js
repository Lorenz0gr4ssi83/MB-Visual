// Confronto tra revisioni: parti comuni (famiglie di file, differenze tra sequenze, report PDF ed Excel, elenco a lato).
import { baseName, el, loadScript, saveBlobAs, saveBytes } from "../core.js";
import { t as tr, LOCALE } from "../i18n.js";

// colori del confronto (come Bluebeam / Acrobat "Confronta"): vecchia rosso, nuova verde, uguale grigio
export const COL = { del: "#e5484d", add: "#2f9e5b", mod: "#f08c00", prop: "#3b7dd8", same: "#8b8d98" };
export const KIND_IT = { del: tr("cmp.eliminato"), add: tr("cmp.aggiunto"), mod: tr("cmp.modificato"), geo: tr("cmp.geometria_modificata"), prop: tr("cmp.proprieta_modificate"), same: tr("cmp.uguale") };

const FAM = { pdf: "pdf", dwg: "cad", dxf: "cad", ifc: "ifc" };
export const compareFamily = name => FAM[String(name).split(".").pop().toLowerCase()] || null;
export const FAMILY_IT = { pdf: "PDF", cad: tr("cmp.disegni_dwg_dxf"), ifc: tr("cmp.modelli_ifc") };

// ---------------------------------------------------------------- differenze tra due sequenze (Myers)
// Restituisce i tratti diversi come intervalli [a0, a1) della prima e [b0, b1) della seconda.
// Oltre maxD modifiche si ferma (null): chi chiama ripiega su un confronto a pezzi.
export function diffHunks(A, B, maxD = 3000, eq = (x, y) => x === y) {
  let s = 0;
  while (s < A.length && s < B.length && eq(A[s], B[s])) s++;
  let ea = A.length, eb = B.length;
  while (ea > s && eb > s && eq(A[ea - 1], B[eb - 1])) { ea--; eb--; }
  if (s === ea && s === eb) return [];
  if (s === ea || s === eb) return [{ a0: s, a1: ea, b0: s, b1: eb }];
  const a = A.slice(s, ea), b = B.slice(s, eb);
  const N = a.length, M = b.length, MAX = Math.min(N + M, maxD);
  const off = MAX + 1, V = new Int32Array(2 * MAX + 3);
  const trace = [];
  let D = -1;
  outer: for (let d = 0; d <= MAX; d++) {
    trace.push(V.slice(off - d - 1, off + d + 2)); // stato dopo il passo d-1, indici k = -d-1 .. d+1
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && V[off + k - 1] < V[off + k + 1]) ? V[off + k + 1] : V[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && eq(a[x], b[y])) { x++; y++; }
      V[off + k] = x;
      if (x >= N && y >= M) { D = d; break outer; }
    }
  }
  if (D < 0) return null;
  const edits = []; // [tipo, x, y] all'inizio della modifica
  let x = N, y = M;
  for (let d = D; d > 0; d--) {
    const P = trace[d], at = k => P[k + d + 1];
    const k = x - y;
    const pk = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = at(pk), py = px - pk;
    edits.push(pk === k + 1 ? [1, px, py] : [0, px, py]); // 1 = inserimento, 0 = cancellazione
    x = px; y = py;
  }
  edits.reverse();
  const out = [];
  let h = null;
  for (const [t, ex, ey] of edits) {
    if (!h || ex !== h.a1 || ey !== h.b1) { h = { a0: ex, a1: ex, b0: ey, b1: ey }; out.push(h); }
    if (t) h.b1++; else h.a1++;
  }
  for (const q of out) { q.a0 += s; q.a1 += s; q.b0 += s; q.b1 += s; }
  return out;
}

// ---------------------------------------------------------------- PDF semplice (immagini JPEG, testo Helvetica, rettangoli)
// Testo vero (ricercabile e copiabile) con i caratteri standard del PDF: nessuna libreria esterna, funziona anche nella web app.
const HW = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W1252 = { "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "™": 0x99, "↔": 0x2d, "→": 0x3e };
export function textWidthPt(s, size, bold = false) {
  let w = 0;
  for (const ch of String(s)) { const c = ch.charCodeAt(0); w += c >= 32 && c < 127 ? HW[c - 32] : 556; }
  return w * size / 1000 * (bold ? 1.07 : 1);
}
export function fitText(s, size, maxW, bold = false) {
  s = String(s ?? "").replace(/\s+/g, " ");
  if (textWidthPt(s, size, bold) <= maxW) return s;
  while (s.length > 1 && textWidthPt(s + "…", size, bold) > maxW) s = s.slice(0, -1);
  return s + "…";
}
export function wrapText(s, size, maxW, bold = false, maxLines = 4) {
  const words = String(s ?? "").replace(/\s+/g, " ").trim().split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (textWidthPt(t, size, bold) <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = fitText(lines[maxLines - 1] + " …", size, maxW, bold); }
  return lines.map(l => fitText(l, size, maxW, bold));
}
const hex1252 = s => {
  let h = "";
  for (const ch of String(s)) {
    let c = ch.charCodeAt(0);
    if (W1252[ch] !== undefined) c = W1252[ch];
    else if (c > 255 || (c >= 0x80 && c < 0xa0)) c = 0x3f;
    h += c.toString(16).padStart(2, "0");
  }
  return h;
};
const rgbOf = c => { const m = /^#?([0-9a-f]{6})$/i.exec(c || "#000000"); const n = parseInt(m ? m[1] : "000000", 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(v => v.toFixed(3)).join(" "); };

export function pdfDoc() {
  const pages = [];
  return {
    // coordinate con origine in alto a sinistra, in punti tipografici
    addPage(w = 842, h = 595) {
      const ops = [], imgs = [];
      const Y = y => (h - y).toFixed(2);
      const p = {
        w, h, ops, imgs,
        text(x, y, s, size = 9, o = {}) { ops.push(`BT /${o.bold ? "F2" : "F1"} ${size} Tf ${rgbOf(o.color)} rg ${x.toFixed(2)} ${Y(y)} Td <${hex1252(s)}> Tj ET`); return p; },
        rect(x, y, rw, rh, o = {}) {
          if (o.fill) ops.push(`${rgbOf(o.fill)} rg ${x.toFixed(2)} ${Y(y + rh)} ${rw.toFixed(2)} ${rh.toFixed(2)} re f`);
          if (o.stroke) ops.push(`${rgbOf(o.stroke)} RG ${(o.lw || 0.7).toFixed(2)} w ${x.toFixed(2)} ${Y(y + rh)} ${rw.toFixed(2)} ${rh.toFixed(2)} re S`);
          return p;
        },
        line(x1, y1, x2, y2, o = {}) { ops.push(`${rgbOf(o.color || "#999999")} RG ${(o.lw || 0.5).toFixed(2)} w ${x1.toFixed(2)} ${Y(y1)} m ${x2.toFixed(2)} ${Y(y2)} l S`); return p; },
        image(jpg, iw, ih, x, y, dw, dh) { const n = imgs.length; imgs.push({ jpg, iw, ih }); ops.push(`q ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${x.toFixed(2)} ${Y(y + dh)} cm /Im${n} Do Q`); return p; },
      };
      pages.push(p);
      return p;
    },
    get pages() { return pages; },
    build(title = "") {
      const enc = s => new TextEncoder().encode(s);
      const chunks = [], offsets = [];
      let len = 0, n = 0;
      const push = b => { chunks.push(b); len += b.length; };
      const objs = [];
      const reserve = () => ++n;
      const obj = (id, body, stream) => { objs.push({ id, body, stream }); };
      const cat = reserve(), pagesId = reserve(), f1 = reserve(), f2 = reserve(), info = reserve();
      obj(f1, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
      obj(f2, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
      const kids = [];
      for (const p of pages) {
        const pid = reserve(), cid = reserve();
        const xo = p.imgs.map((im, k) => {
          const iid = reserve();
          obj(iid, `<< /Type /XObject /Subtype /Image /Width ${im.iw} /Height ${im.ih} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.jpg.length} >>`, im.jpg);
          return `/Im${k} ${iid} 0 R`;
        }).join(" ");
        const content = enc(p.ops.join("\n"));
        obj(cid, `<< /Length ${content.length} >>`, content);
        obj(pid, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${p.w} ${p.h}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> /XObject << ${xo} >> >> /Contents ${cid} 0 R >>`);
        kids.push(`${pid} 0 R`);
      }
      obj(pagesId, `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`);
      obj(cat, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
      obj(info, `<< /Title <FEFF${[...title].map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}> /Producer (MB Visual) >>`);
      push(enc("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"));
      objs.sort((a, b) => a.id - b.id);
      for (const o of objs) {
        offsets[o.id] = len;
        push(enc(`${o.id} 0 obj\n${o.body}\n`));
        if (o.stream) { push(enc("stream\n")); push(o.stream); push(enc("\nendstream\n")); }
        push(enc("endobj\n"));
      }
      const xref = len;
      let x = `xref\n0 ${n + 1}\n0000000000 65535 f \n`;
      for (let i = 1; i <= n; i++) x += String(offsets[i] || 0).padStart(10, "0") + " 00000 n \n";
      push(enc(x + `trailer\n<< /Size ${n + 1} /Root ${cat} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF`));
      const out = new Uint8Array(len);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    },
  };
}

export async function canvasJpeg(canvas, q = 0.88) {
  const b = await new Promise(r => canvas.toBlob(r, "image/jpeg", q));
  return new Uint8Array(await b.arrayBuffer());
}

// intestazione delle pagine del report: titolo, file confrontati, legenda
export function reportHeader(p, info, title) {
  p.rect(0, 0, p.w, 46, { fill: "#2b2f33" });
  p.text(24, 20, title, 13, { bold: true, color: "#ffffff" });
  p.text(24, 36, fitText(tr("cmp.vecchia_nuova", info.oldName, info.newName), 8.5, p.w - 230), 8.5, { color: "#d0d4d8" });
  p.text(p.w - 190, 20, tr("cmp.mb_visual_confronto_revisioni"), 8, { color: "#d0d4d8" });
  p.text(p.w - 190, 36, info.date, 8, { color: "#d0d4d8" });
  return 62;
}
export function legend(p, x, y, items) {
  for (const [col, label] of items) {
    p.rect(x, y - 7, 9, 9, { fill: col });
    p.text(x + 13, y + 1, label, 8.5);
    x += 22 + textWidthPt(label, 8.5);
  }
}

// tabella su piu' pagine: columns [{ t: titolo, w: larghezza in punti }], rows [{ cells: [...], color }]
export function reportTable(doc, info, title, columns, rows, first = null, startY = null) {
  let p = first, y = startY;
  const lineH = 11, pad = 3;
  const newPage = () => { p = doc.addPage(842, 595); y = reportHeader(p, info, title); head(); };
  const head = () => {
    let x = 24;
    p.rect(24, y, p.w - 48, 16, { fill: "#e9ecef" });
    for (const c of columns) { p.text(x + 4, y + 11, c.t, 8, { bold: true }); x += c.w; }
    y += 18;
  };
  if (!p) newPage(); else head();
  rows.forEach((r, i) => {
    const cells = r.cells.map((v, k) => wrapText(v, 8, columns[k].w - 8, false, r.maxLines || 4));
    const h = Math.max(1, ...cells.map(c => c.length)) * lineH + pad * 2;
    if (y + h > p.h - 28) newPage();
    if (i % 2) p.rect(24, y, p.w - 48, h, { fill: "#f7f8f9" });
    if (r.color) p.rect(24, y, 3, h, { fill: r.color });
    let x = 24;
    cells.forEach((c, k) => { c.forEach((l, j) => p.text(x + 6, y + pad + 8 + j * lineH, l, 8, { color: k === 0 && r.color ? r.color : "#1b1e1c", bold: k === 0 && !!r.color })); x += columns[k].w; });
    y += h;
  });
  return { page: p, y };
}

export function footerNumbers(doc) {
  const n = doc.pages.length;
  doc.pages.forEach((p, i) => p.text(p.w - 80, p.h - 14, tr("cmp.pagina_0_1", i + 1, n), 7.5, { color: "#777777" }));
}

// ---------------------------------------------------------------- Excel e CSV
export async function saveXlsx(target, sheets) {
  await loadScript("/vendor/xlsx/dist/xlsx.full.min.js");
  const X = window.XLSX;
  const wb = X.utils.book_new();
  for (const s of sheets) {
    const ws = X.utils.aoa_to_sheet(s.rows);
    if (s.widths) ws["!cols"] = s.widths.map(w => ({ wch: w }));
    if (s.rows.length > 1 && s.filter !== false) ws["!autofilter"] = { ref: X.utils.encode_range({ s: { r: s.headerRow || 0, c: 0 }, e: { r: s.rows.length - 1, c: Math.max(0, ...s.rows.map(r => r.length)) - 1 } }) };
    X.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  const out = X.write(wb, { type: "array", bookType: "xlsx" });
  return new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
// CSV per Excel italiano: separatore ";" e BOM UTF-8
export function csvBlob(rows) {
  const q = v => { const s = v === null || v === undefined ? "" : String(v); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return new Blob(["﻿" + rows.map(r => r.map(q).join(";")).join("\r\n")], { type: "text/csv" });
}

// salva un Blob dove chiede l'utente (o direttamente in target, quando arriva da "Salva con nome")
export async function saveOut(blob, suggested, dir, target = null) {
  if (target) {
    await saveBytes(target, new Uint8Array(await blob.arrayBuffer()));
    return target;
  }
  return saveBlobAs(suggested, blob, dir);
}

export const stamp = () => new Date().toLocaleString(LOCALE, { dateStyle: "short", timeStyle: "short" });
export const stem = p => baseName(p).replace(/\.[^.]+$/, "");

// ---------------------------------------------------------------- elenco delle differenze (pannello a sinistra)
// righe virtuali: anche con decine di migliaia di differenze si creano solo le righe visibili
export function diffList({ onPick, rowH = 46 }) {
  const box = el("div", { class: "cmp-list" });
  const inner = el("div", { class: "cmp-list-in" });
  box.append(inner);
  let items = [], sel = -1;
  const draw = () => {
    inner.style.height = items.length * rowH + "px";
    const top = box.scrollTop, h = box.clientHeight || 600;
    const i0 = Math.max(0, Math.floor(top / rowH) - 5), i1 = Math.min(items.length, Math.ceil((top + h) / rowH) + 5);
    inner.innerHTML = "";
    for (let i = i0; i < i1; i++) {
      const it = items[i];
      const r = el("div", { class: "cmp-row" + (i === sel ? " sel" : ""), style: { top: i * rowH + "px", height: rowH + "px" }, title: it.tip || "", onclick: () => { sel = i; draw(); onPick(it, i); } },
        el("span", { class: "cmp-chip", style: { background: it.color } }),
        el("div", { class: "cmp-txt" }, el("div", { class: "t1" }, el("b", {}, it.title), it.where ? el("span", { class: "w" }, it.where) : null), el("div", { class: "t2" }, it.sub || "")));
      inner.append(r);
    }
  };
  box.addEventListener("scroll", draw);
  new ResizeObserver(draw).observe(box);
  return {
    el: box,
    set(list) { items = list; sel = -1; box.scrollTop = 0; draw(); },
    get items() { return items; },
    select(i) { sel = i; const y = i * rowH; if (y < box.scrollTop || y > box.scrollTop + box.clientHeight - rowH) box.scrollTop = y - box.clientHeight / 2; draw(); },
  };
}

export function chipBox(label, color, checked, onchange, count = null) {
  const cb = el("input", { type: "checkbox", checked: checked || undefined });
  cb.addEventListener("change", () => onchange(cb.checked));
  const lab = el("label", { class: "cmp-check" }, cb, el("span", { class: "cmp-chip", style: { background: color } }), el("span", {}, label), count !== null ? el("span", { class: "n" }, String(count)) : null);
  lab.input = cb;
  return lab;
}
