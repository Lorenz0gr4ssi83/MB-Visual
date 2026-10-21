// Apple iWork (Pages, Numbers, Keynote): anteprima incorporata (immagine o PDF), miniature delle diapositive,
// immagini contenute, testo del documento e tabelle. Esporta PDF/PNG/JPG dell'anteprima, TXT, CSV/Excel delle tabelle.
// Motore: mbvisual/fx_iwork.py (solo app per PC).
import { api, button, el, loadCss, loading, toast } from "../core.js";

export async function mount(ctx) {
  loadCss("css/formati.css");
  loading(ctx.el, "Lettura del documento iWork");
  const r = await api("fx", { op: "iwork_read", path: ctx.path });
  ctx.el.innerHTML = "";
  const partUrl = name => "/api/fx?" + new URLSearchParams({ op: "iwork_part", path: ctx.path, nome: name });
  const pageUrl = n => "/api/fx?" + new URLSearchParams({ op: "iwork_page", path: ctx.path, n });
  let view = "anteprima";
  const page = el("div", { class: "fx-page" });
  ctx.el.append(page);

  const tabs = [["anteprima", "Anteprima"], ...(r.testi.length ? [["testo", "Testo"]] : []), ...(r.tabelle.length ? [["tabelle", `Tabelle (${r.tabelle.length})`]] : []),
    ...(r.immagini.length ? [["immagini", `Immagini (${r.immagini.length})`]] : [])];
  const btns = {};
  for (const [id, label] of tabs) btns[id] = button(label, null, () => { view = id; render(); });
  ctx.tb.append(el("b", { style: { padding: "0 8px" } }, r.programma), el("span", { class: "note" }, r.versione), el("span", { class: "sep" }), ...Object.values(btns));
  if (r.pdf) ctx.tb.append(el("span", { class: "grow" }), button("Apri il PDF di anteprima", "open", openPdf, { title: "Apre l'anteprima PDF nel visualizzatore PDF" }));

  async function openPdf() {
    try {
      const tmp = (await api("temp_path", { name: ctx.name.replace(/\.[^.]+$/, "") + " (anteprima).pdf" })).path;
      await api("fx", { op: "iwork_export", path: ctx.path }, { json: { out: tmp } });
      ctx.openFile(tmp);
    } catch (e) { toast(e.message, true); }
  }

  function render() {
    for (const [id, b] of Object.entries(btns)) b.classList.toggle("on", id === view);
    page.innerHTML = "";
    page.append(el("div", { class: "fx-row" }, el("h2", {}, `${r.programma}: ${ctx.name}`)));
    for (const n of r.note) page.append(el("p", { class: "fx-muted", style: { margin: 0 } }, n));
    if (view === "anteprima") renderPreview();
    else if (view === "testo") renderText();
    else if (view === "tabelle") renderTables();
    else renderImages();
  }

  function renderPreview() {
    if (r.pdf && r.pagine_pdf) {
      page.append(el("p", { class: "fx-muted fx-small", style: { margin: 0 } }, `Anteprima PDF salvata nel documento: ${r.pagine_pdf} pagin${r.pagine_pdf === 1 ? "a" : "e"}.`));
      for (let i = 0; i < Math.min(r.pagine_pdf, 30); i++) page.append(el("img", { class: "fx-preview", src: pageUrl(i), alt: `Pagina ${i + 1}`, loading: "lazy" }));
    } else if (r.immagine) {
      page.append(el("p", { class: "fx-muted fx-small", style: { margin: 0 } }, "Anteprima salvata nel documento (prima pagina o prima diapositiva)."), el("img", { class: "fx-preview", src: partUrl(r.immagine), alt: "Anteprima" }));
    } else page.append(el("div", { class: "fx-empty" }, "Il documento non contiene un'anteprima." + (r.testi.length || r.tabelle.length ? " Il contenuto letto e' nelle schede Testo e Tabelle." : "")));
    if (r.miniature.length) {
      page.append(el("h3", {}, "Diapositive"));
      const box = el("div", { class: "fx-thumbs" });
      r.miniature.forEach(n => box.append(el("img", { src: partUrl(n), alt: n, title: n, loading: "lazy" })));
      page.append(box);
    }
    if (!r.pdf && !r.immagine && !r.miniature.length && (r.testi.length || r.tabelle.length)) { view = r.testi.length ? "testo" : "tabelle"; render(); }
  }

  function renderText() {
    for (const t of r.testi) {
      page.append(el("div", {}, r.testi.length > 1 ? el("h3", {}, `${t.tipo}${t.parte && t.parte !== "Document" && t.parte !== "Documento" ? " · " + t.parte : ""}`) : null, el("div", { class: "fx-text" }, t.testo)));
    }
  }

  function renderTables() {
    for (const t of r.tabelle) {
      const box = el("div", { class: "panel", style: { padding: 0, overflow: "auto", maxHeight: "60vh" } });
      const tb = el("table", { class: "fx-table" });
      t.righe.forEach((row, i) => tb.append(el("tr", {}, ...row.map(v => el(i < (t.intestazione || 0) ? "th" : "td", { class: typeof v === "number" ? "num" : "" }, v === null ? "" : typeof v === "number" ? v.toLocaleString("it-IT", { maximumFractionDigits: 10 }) : String(v))))));
      box.append(tb);
      page.append(el("h3", {}, (t.foglio ? t.foglio + " · " : "") + t.nome, el("span", { class: "fx-muted fx-small" }, `  ${t.righe.length} righe`)), box);
    }
  }

  function renderImages() {
    const box = el("div", { class: "fx-thumbs" });
    r.immagini.forEach(n => box.append(el("img", { src: partUrl(n), alt: n, title: n.split("/").pop(), loading: "lazy", style: { maxHeight: "200px" } })));
    page.append(box);
  }

  render();
  const fmts = [...(r.pdf || r.immagine ? ["pdf", "png", "jpg"] : []), ...(r.testi.length || r.tabelle.length ? ["txt"] : []), ...(r.tabelle.length ? ["xlsx", "csv"] : [])];
  return {
    saveInPlace: false,
    saveFormats: fmts,
    saveLabels: { pdf: r.pdf ? "PDF di anteprima salvato nel documento" : "Anteprima in PDF", png: "Anteprima come immagine", jpg: "Anteprima come immagine",
      txt: "Testo del documento", xlsx: "Tabelle in Excel (una per foglio)", csv: "Tabelle in CSV" },
    saveNote: "Senza Apple Pages/Numbers/Keynote si esportano l'anteprima salvata nel file, il testo e le tabelle (non l'impaginazione completa).",
    async save(target) { await api("fx", { op: "iwork_export", path: ctx.path }, { json: { out: target } }); return { switchTo: false }; },
  };
}

