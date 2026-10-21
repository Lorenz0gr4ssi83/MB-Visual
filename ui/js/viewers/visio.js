// Diagrammi di Microsoft Visio nell'editor in stile Visio (ui/js/vsdedit.js).
// .vsdx/.vsdm/.vstx/.vstm: aperti e modificati direttamente (il pacchetto resta quello di Visio).
// .vsd/.vss/.vst (binari 2003-2010): con Visio installato si convertono in .vsdx e si modificano; altrimenti
// anteprima, testi delle pagine (e pagine complete se c'e' LibreOffice) in sola lettura (mbvisual/visio.py).
import { api, el, loading, loadCss, readBytes, toast, waitJob, withExt, extOf, fileUrl, WEB } from "../core.js";
import { openVsdx, saveVsdx } from "../vsdmodel.js";
import { createVisio, setMainType } from "../vsdedit.js";

const XML_EXTS = new Set(["vsdx", "vsdm", "vstx", "vstm", "vssx", "vssm"]);

export async function mount(ctx) {
  const ld = loading(ctx.el, "Apertura del diagramma");
  let bytes, converted = false;
  if (!XML_EXTS.has(ctx.ext)) {
    if (WEB) throw new Error("I diagrammi di Visio nel vecchio formato binario (.vsd) si aprono solo nell'app per PC");
    const { job } = await api("visio_vsd", { path: ctx.path });
    const r = await waitJob(job, (p, m) => ld.set?.(p, m || "Lettura del file di Visio"));
    if (r.mode !== "vsdx") return mountPreview(ctx, r);
    bytes = await readBytes(r.path);
    converted = true;
  } else bytes = await readBytes(ctx.path);
  const doc = await openVsdx(bytes);
  const E = createVisio(ctx, doc);
  await E.ready;
  if (converted) toast("File .vsd convertito con Visio: salvalo come .vsdx per conservare le modifiche", false, 7000);
  const native = XML_EXTS.has(ctx.ext) && !/^vss/.test(ctx.ext) ? ctx.ext : "vsdx";
  const formats = [...new Set([native, "vsdx", "vstx", ...(WEB ? [] : ["pdf"]), "svg", "png"])];
  return {
    saveFormats: formats,
    saveLabels: { vsdx: "Disegno di Visio", vsdm: "Disegno di Visio con macro", vstx: "Modello di Visio", vstm: "Modello di Visio con macro", pdf: "PDF (vettoriale, tutte le pagine)", svg: "SVG (una per pagina)", png: "Immagine PNG (una per pagina, 150 dpi)" },
    saveNote: "VSDX conserva tutto modificabile in Visio (master, dati, livelli, macro solo in VSDM). PDF, SVG e PNG sono esportazioni delle pagine.",
    saveInPlace: !converted && !/^vss/.test(ctx.ext),
    saveAsName: () => withExt(ctx.tab.name, "vsdx"),
    async save(path) {
      const ext = extOf(path);
      if (ext === "pdf") { await E.exportPdf(path); toast("PDF esportato"); return { switchTo: false }; }
      if (ext === "svg") { const n = await E.exportSvg(path); if (n > 1) toast(`Salvati ${n} file SVG (uno per pagina)`); return { switchTo: false }; }
      if (ext === "png") { const n = await E.exportPng(path); if (n > 1) toast(`Salvate ${n} immagini (una per pagina)`); return { switchTo: false }; }
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
    el("b", {}, "Diagramma di Visio nel formato binario (.vsd, versione " + (r.version || "?") + ")"),
    el("span", {}, r.mode === "libreoffice" ? " · pagine convertite con LibreOffice, sola lettura." : " · Senza Visio installato si mostrano l'anteprima salvata nel file e i testi delle pagine. Con Microsoft Visio sul PC il file si apre e si modifica completamente; con LibreOffice si vedono tutte le pagine."),
    r.nota ? el("div", { class: "err" }, r.nota) : null));
  if (imgs.length) for (const p of imgs) box.append(el("div", { class: "vs-prevpage" }, el("img", { src: fileUrl(p), alt: "Anteprima" })));
  const pages = r.pages || [];
  if (pages.length) {
    const t = el("div", { class: "vs-prevtext" }, el("h3", {}, "Testi del diagramma"));
    for (const p of pages) {
      t.append(el("h4", {}, p.name));
      if (!p.texts.length) t.append(el("p", { class: "vs-empty" }, "(nessun testo)"));
      for (const s of p.texts) t.append(el("p", {}, s));
    }
    box.append(t);
  } else if (!imgs.length) box.append(el("p", {}, "Il file non contiene un'anteprima leggibile."));
  ctx.el.append(box);
  ctx.status(`${pages.length} pagine · sola lettura`);
  return {};
}
