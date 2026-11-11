// eBook EPUB: lettura a pagine con indice.
import { api, button, el, loadScript, loading, readBytes, waitJob } from "../core.js";
import { t } from "../i18n.js";

export async function mount(ctx) {
  if (ctx.ext !== "epub") { // Kindle (MOBI/AZW3) e Calibre (htmlz/txtz): copia EPUB in cache (mbvisual/kindle.py)
    const ld = loading(ctx.el, t("v_epub.conversione"));
    const r = await waitJob((await api("kindle_epub", { path: ctx.path })).job, (p, m) => ld?.set?.(p, m));
    ctx.el.innerHTML = "";
    ctx.path = r.path;
  }
  await loadScript("/vendor/jszip/dist/jszip.min.js");
  await loadScript("/vendor/epubjs/dist/epub.min.js");
  const bytes = await readBytes(ctx.path);
  const toc = el("div", { class: "tree" });
  const area = el("div", { style: { height: "100%", background: "#fff" } });
  ctx.el.append(el("div", { class: "side" }, toc, area));
  ctx.fillBody(true);
  const book = window.ePub(bytes.buffer);
  const rendition = book.renderTo(area, { width: "100%", height: "100%", spread: "auto" });
  await rendition.display();
  const nav = await book.loaded.navigation;
  const addItems = (items, depth) => items.forEach(it => {
    toc.append(el("div", { class: "node", style: { paddingLeft: 10 + depth * 14 + "px", whiteSpace: "normal" }, onclick: () => rendition.display(it.href) }, it.label.trim()));
    if (it.subitems?.length) addItems(it.subitems, depth + 1);
  });
  addItems(nav.toc, 0);
  ctx.tb.append(button("", "rotateL", () => rendition.prev(), { iconOnly: true, title: t("v_epub.pagina_precedente") }), button("", "rotate", () => rendition.next(), { iconOnly: true, title: t("v_epub.pagina_successiva") }),
    el("span", { class: "note" }, t("v_epub.frecce_sinistra_destra_sfogliare")));
  const key = e => { if (ctx.tab.view.hidden) return; if (e.key === "ArrowRight") rendition.next(); if (e.key === "ArrowLeft") rendition.prev(); };
  document.addEventListener("keydown", key);
  rendition.on("keyup", key);
  return { dispose() { document.removeEventListener("keydown", key); book.destroy(); }, onShow() { rendition.resize(); } };
}
