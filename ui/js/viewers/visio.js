// Diagrammi di Microsoft Visio nell'editor in stile Visio (ui/js/vsdedit.js).
// .vsdx/.vsdm/.vstx/.vstm: aperti e modificati direttamente (il pacchetto resta quello di Visio).
// .vsd/.vss/.vst (binari 2003-2010): con Visio installato si convertono in .vsdx e si modificano; altrimenti
// anteprima, testi delle pagine (e pagine complete se c'e' LibreOffice) in sola lettura (mbvisual/visio.py).
import { api, el, loading, loadCss, readBytes, toast, waitJob, withExt, extOf, fileUrl, WEB } from "../core.js";
import { openVsdx, saveVsdx } from "../vsdmodel.js";
import { createVisio, setMainType } from "../vsdedit.js";
import { t as tr } from "../i18n.js";

const XML_EXTS = new Set(["vsdx", "vsdm", "vstx", "vstm", "vssx", "vssm"]);

export async function mount(ctx) {
  const ld = loading(ctx.el, tr("v_visio.apertura_diagramma"));
  let bytes, converted = false;
  if (!XML_EXTS.has(ctx.ext)) {
    if (WEB) throw new Error(tr("v_visio.i_diagrammi_visio_vecchio_formato"));
    const { job } = await api("visio_vsd", { path: ctx.path });
    const r = await waitJob(job, (p, m) => ld.set?.(p, m || tr("v_visio.lettura_file_visio")));
    if (r.mode !== "vsdx") return mountPreview(ctx, r);
    bytes = await readBytes(r.path);
    converted = true;
  } else bytes = await readBytes(ctx.path);
  const doc = await openVsdx(bytes);
  const E = createVisio(ctx, doc);
  await E.ready;
  if (converted) toast(tr("v_visio.file_vsd_convertito_visio_salvalo"), false, 7000);
  const native = XML_EXTS.has(ctx.ext) && !/^vss/.test(ctx.ext) ? ctx.ext : "vsdx";
  const formats = [...new Set([native, "vsdx", "vstx", ...(WEB ? [] : ["pdf"]), "svg", "png"])];
  return {
    saveFormats: formats,
    saveLabels: { vsdx: tr("v_visio.disegno_visio"), vsdm: tr("v_visio.disegno_visio_macro"), vstx: tr("v_visio.modello_visio"), vstm: tr("v_visio.modello_visio_macro"), pdf: tr("v_visio.pdf_vettoriale_tutte_pagine"), svg: tr("v_visio.svg_pagina"), png: tr("v_visio.immagine_png_pagina_150_dpi") },
    saveNote: tr("v_visio.vsdx_conserva_tutto_modificabile_visio"),
    saveInPlace: !converted && !/^vss/.test(ctx.ext),
    saveAsName: () => withExt(ctx.tab.name, "vsdx"),
    async save(path) {
      const ext = extOf(path);
      if (ext === "pdf") { await E.exportPdf(path); toast(tr("v_visio.pdf_esportato")); return { switchTo: false }; }
      if (ext === "svg") { const n = await E.exportSvg(path); if (n > 1) toast(tr("v_visio.salvati_0_file_svg_pagina", n)); return { switchTo: false }; }
      if (ext === "png") { const n = await E.exportPng(path); if (n > 1) toast(tr("v_visio.salvate_0_immagini_pagina", n)); return { switchTo: false }; }
      // tipo del pacchetto secondo l'estensione, su una copia (il documento aperto conserva macro e tipo)
      let out = await E.save();
      if (ext !== native) { const copy = await openVsdx(out); await setMainType(copy, ext); out = await saveVsdx(copy); }
      await api("save", { path }, { body: out });
      if (path === ctx.tab.path || XML_EXTS.has(ext)) ctx.setDirty(false);
    },
    onShow() { E.onShow(); },
    onBack() { return E.onBack(); },
    async acceptDrop(paths) {
      const imgs = paths.filter(p => /\.(png|jpe?g|gif|bmp)$/i.test(p));
      if (!imgs.length) return false;
      try { await E.dropImages(imgs); } catch (e) { toast(e.message, true); }
      return true;
    },
    _vs: E,
  };
}

// vecchi .vsd senza Visio: anteprima del file, pagine (LibreOffice) e testi
function mountPreview(ctx, r) {
  loadCss("css/visio.css");
  ctx.el.innerHTML = "";
  ctx.fillBody(false);
  const box = el("div", { class: "vs-prev" });
  const imgs = r.images?.length ? r.images : r.preview ? [r.preview] : [];
  box.append(el("div", { class: "vs-prevnote" },
    el("b", {}, tr("v_visio.diagramma_visio_formato_binario_vsd") + (r.version || "?") + ")"),
    el("span", {}, r.mode === "libreoffice" ? tr("v_visio.pagine_convertite_libreoffice_sola_lettura") : tr("v_visio.senza_visio_installato_si_mostrano")),
    r.nota ? el("div", { class: "err" }, r.nota) : null));
  if (imgs.length) for (const p of imgs) box.append(el("div", { class: "vs-prevpage" }, el("img", { src: fileUrl(p), alt: tr("v_visio.anteprima") })));
  const pages = r.pages || [];
  if (pages.length) {
    const t = el("div", { class: "vs-prevtext" }, el("h3", {}, tr("v_visio.testi_diagramma")));
    for (const p of pages) {
      t.append(el("h4", {}, p.name));
      if (!p.texts.length) t.append(el("p", { class: "vs-empty" }, tr("v_visio.nessun_testo")));
      for (const s of p.texts) t.append(el("p", {}, s));
    }
    box.append(t);
  } else if (!imgs.length) box.append(el("p", {}, tr("v_visio.file_non_contiene_anteprima_leggibile")));
  ctx.el.append(box);
  ctx.status(`${pages.length} pagine · sola lettura`);
  return {};
}
