// Pubblicazioni (.mbpub, formato proprio di MB Visual) nell'editor in stile Publisher (ui/js/pubedit.js).
// I file di Microsoft Publisher (.pub) si importano (mbvisual/publisher.py): con Publisher installato tutta
// l'impaginazione, altrimenti solo testo e immagini; si salvano poi come .mbpub o si esportano in PDF.
import { t } from "../i18n.js";
import { api, loading, readBytes, toast, waitJob, withExt, extOf, WEB } from "../core.js";
import { readMbpub, writeMbpub, newDoc, normalizeDoc, newId, S, MM, imageBox, shapeBox, wordArt, baseObj } from "../pubmodel.js";
import { createPublisher } from "../pubedit.js";
import { exportPdfFile, exportImages, thumbnailPng } from "../pubexport.js";

export async function mount(ctx) {
  const ld = loading(ctx.el, t("v_publisher.apertura_pubblicazione"));
  const isPub = ctx.ext === "pub";
  let doc, note = null;
  if (isPub) {
    if (WEB) throw new Error(t("v_publisher.i_file_publisher_pub_si"));
    const { job } = await api("pub_import", { path: ctx.path });
    const r = await waitJob(job, (p, m) => ld.set(p, m || t("v_publisher.lettura_file_publisher")));
    doc = await fromImport(r);
    note = r.nota || (r.mode === "publisher" ? t("v_publisher.file_publisher_importato_salvalo_come") : null);
  } else {
    const bytes = await readBytes(ctx.path);
    doc = bytes.length ? await readMbpub(bytes) : newDoc();
  }
  const E = createPublisher(ctx, doc);
  if (note) toast(note, false, 8000);
  const blank = !doc.pages.some(p => p.items.length);
  if (ctx.untitled && blank) setTimeout(() => E.templatesDlg(false), 50); // come Publisher: si parte dalla galleria dei modelli

  return {
    saveFormats: WEB ? ["mbpub", "pdf", "png", "jpg"] : ["mbpub", "pdf", "png", "jpg"],
    saveLabels: { mbpub: t("v_publisher.pubblicazione_mb_visual_modificabile"), pdf: WEB ? t("v_publisher.pdf_pagine_come_immagini") : t("v_publisher.pdf_stampa_testo_grafica_vettoriali"), png: t("v_publisher.immagine_png_pagina_200_dpi"), jpg: t("v_publisher.immagine_jpeg_pagina_200_dpi") },
    saveNote: t("v_publisher.mbpub_conserva_tutto_modificabile_pdf"),
    saveInPlace: !isPub,
    saveAsName: () => withExt(ctx.tab.name, "mbpub"),
    async save(path) {
      const ext = extOf(path);
      const D = E.doc();
      if (ext === "pdf") { await exportPdfFile(E, path); return { switchTo: false }; }
      if (ext === "png" || ext === "jpg" || ext === "jpeg") { const f = await exportImages(D, path); if (f.length > 1) toast(t("v_publisher.salvate_0_immagini_pagina", f.length)); return { switchTo: false }; }
      let thumb = null;
      try { thumb = await thumbnailPng(D); } catch { /* */ }
      await api("save", { path }, { body: await writeMbpub(D, thumb) });
      if (path === ctx.tab.path || ext === "mbpub") ctx.setDirty(false);
    },
    onShow() { E.schedule(); E.focus(); },
    onBack() { if (E.edit()) { E.endEdit(); E.refresh(); return true; } if (E.sel().length) { E.setSel([]); return true; } return false; },
    async acceptDrop(paths) {
      const imgs = paths.filter(p => /\.(png|jpe?g|gif|webp|bmp|tiff?|svg|heic|avif)$/i.test(p));
      if (!imgs.length) return false;
      for (const p of imgs) {
        try {
          const ext = extOf(p);
          let bytes, mime;
          if (/^(png|jpe?g|gif|webp|bmp|svg|avif)$/.test(ext)) { bytes = await readBytes(p); mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/" + ext; }
          else { const r = await api("image", { path: p }); bytes = await readBytes(r.path); mime = "image/png"; }
          await E.placeImageBytes(bytes, mime, p.split(/[\\/]/).pop());
        } catch (e) { toast(e.message, true); }
      }
      return true;
    },
    _pb: E,
  };
}

// risultato di mbvisual/publisher.import_pub -> documento
async function fromImport(r) {
  const doc = newDoc(r.w / MM, r.h / MM);
  doc.scheme = { name: t("v_publisher.importata"), c: ["#000000", "#1f4e79", "#2e75b6", "#c55a11", "#7f7f7f", "#ffffff"] };
  doc.pages = [];
  const imgIds = {};
  for (const [k, path] of Object.entries(r.images || {})) {
    try {
      const bytes = await readBytes(path);
      const bmp = await createImageBitmap(new Blob([bytes]));
      const id = newId(doc, "i");
      doc.images[id] = { bytes, mime: /\.jpe?g$/i.test(path) ? "image/jpeg" : "image/png", w: bmp.width, h: bmp.height, name: path.split(/[\\/]/).pop() };
      imgIds[k] = id;
    } catch { /* immagine non leggibile */ }
  }
  const byPid = new Map(), links = [];
  const storyOf = paras => {
    const id = newId(doc, "t");
    const chars = [];
    for (const p of paras || []) {
      const ps = S({ a: p.a || "l", sb: p.sb || 0, sa: p.sa || 0, lh: 1, st: "Normale" });
      let last = S({ f: "Calibri", z: 11, c: "#000000" });
      for (const run of p.runs || []) {
        last = S({ f: run.f || "Calibri", z: run.z || 11, b: run.b, i: run.i, u: run.u, c: run.c || "#000000" });
        for (const ch of run.t) chars.push(ch === "\n" ? { c: "\u2028", s: last } : { c: ch, s: last });
      }
      chars.push({ c: "\n", s: last, p: ps });
    }
    if (!chars.length) chars.push({ c: "\n", s: S({ f: "Calibri", z: 11 }), p: S({ st: "Normale" }) });
    doc.stories[id] = { id, chars };
    return id;
  };
  const conv = it => {
    const g = { x: it.x || 0, y: it.y || 0, w: Math.max(1, it.w || 1), h: Math.max(0, it.h || 0), rot: it.rot || 0 };
    if (it.type === "group") {
      const items = (it.items || []).map(conv).filter(Boolean);
      if (!items.length) return null;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const o of items) { x0 = Math.min(x0, o.x); y0 = Math.min(y0, o.y); x1 = Math.max(x1, o.x + o.w); y1 = Math.max(y1, o.y + o.h); }
      return { id: newId(doc, "o"), type: "group", items, x: x0, y: y0, w: x1 - x0, h: y1 - y0, rot: 0, wrap: "none" };
    }
    if (it.type === "text") {
      const o = baseObj(doc, "text", g.x, g.y, g.w, g.h, { rot: g.rot, story: storyOf(it.paras), next: null, pad: it.pad || [7.2, 3.6, 7.2, 3.6], cols: it.cols || 1, gap: 12, valign: it.valign || "t", fit: "none", fill: it.fill || "none", line: it.line, wrap: "none" });
      byPid.set(it.pid, o);
      if (it.nextPid) links.push([o, it.nextPid]);
      if (!it.paras) o._cont = true;
      return o;
    }
    if (it.type === "image") {
      const id = imgIds[it.imgFile];
      if (!id) return null;
      const im = doc.images[id];
      let { x, y, w, h } = g;
      if (it.fit) { const k = Math.min(w / im.w, h / im.h); w = im.w * k; h = im.h * k; }
      return imageBox(doc, x, y, w, h, { rot: g.rot, img: { id, sx: 0, sy: 0, sw: im.w, sh: im.h }, wrap: "none" });
    }
    if (it.type === "shape") return shapeBox(doc, it.shape, g.x, g.y, g.w, g.h, it.fill || "none", it.line || null, { rot: g.rot, flipV: !!it.flipV, wrap: "none" });
    if (it.type === "wordart") return wordArt(doc, it.text || "", g.x, g.y, g.w, g.h, { rot: g.rot, font: it.font, b: it.b, i: it.i, fill: it.fill || "#000000", ow: 0, shadow: false });
    if (it.type === "table") {
      const o = baseObj(doc, "table", g.x, g.y, g.w, g.h, { rot: g.rot, rows: it.rows, cols: it.cols, colW: it.colW, rowH: it.rowH, border: { c: "#000000", w: 0.5 }, pad: 3, wrap: "none" });
      o.cells = it.cellParas.map(row => row.map(paras => ({ story: storyOf(paras), fill: "none" })));
      return o;
    }
    return null;
  };
  doc.masters = [{ id: "A", name: t("v_publisher.pagina_master"), items: (r.masters?.[0]?.items || []).map(conv).filter(Boolean) }];
  for (const p of r.pages || []) {
    const pg = { id: newId(doc, "p"), master: "A", items: (p.items || []).map(conv).filter(Boolean), guides: { v: [], h: [] }, bg: null };
    doc.pages.push(pg);
  }
  if (!doc.pages.length) doc.pages.push({ id: newId(doc, "p"), master: "A", items: [], guides: { v: [], h: [] }, bg: null });
  // caselle collegate: la storia della prima continua nelle successive
  const heads = new Map();
  for (const [o, nextPid] of links) { const n = byPid.get(nextPid); if (n) { o.next = n.id; heads.set(n, o); } }
  for (const o of byPid.values()) {
    if (!heads.has(o)) {
      for (let f = o, n = 0; f.next && n < 500; n++) { const nx = [...byPid.values()].find(x => x.id === f.next); if (!nx) break; if (nx.story !== o.story) delete doc.stories[nx.story]; nx.story = o.story; f = nx; }
    }
    delete o._cont;
  }
  return normalizeDoc(doc);
}
