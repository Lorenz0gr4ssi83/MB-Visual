// PDF con il visualizzatore di Mozilla (pdf.js): pagine, ricerca, stampa, annotazioni; firme PAdES.
import { api, baseName, button, dirName, el, fileUrl, modal, pickFiles, pickFolder, pickSavePath, toast } from "../core.js";
import { renderSigner } from "./signed.js";

export async function mount(ctx) {
  ctx.fillBody(true);
  const src = window.MBV_ROOT + "vendor/pdfjs/web/viewer.html?file=" + encodeURIComponent(fileUrl(ctx.path)) + (innerWidth < 760 ? "#pagemode=none&zoom=page-width" : "#pagemode=thumbs");
  const frame = el("iframe", { class: "fill", src, title: ctx.name });
  ctx.el.append(frame);
  const app = () => frame.contentWindow?.PDFViewerApplication;

  frame.addEventListener("load", async () => {
    const a = app();
    if (!a) return;
    await a.initializedPromise;
    a.eventBus.on("documentloaded", () => {
      const store = a.pdfDocument.annotationStorage;
      store.onSetModified = () => ctx.setDirty(true);
      store.onResetModified = () => ctx.setDirty(false);
      ctx.status(`${a.pagesCount} pagine`);
    });
    a.eventBus.on("pagechanging", e => ctx.status(`Pagina ${e.pageNumber} di ${a.pagesCount}`));
  });

  // ---- strumenti PDF (creano sempre un nuovo file, l'originale resta intatto)
  const dir = dirName(ctx.path), stem = ctx.name.replace(/\.pdf$/i, "");
  const pages = () => app()?.pagesCount || "?";
  const run = async (op, json, suggested) => {
    const out = await pickSavePath(suggested, dir);
    if (!out) return;
    try {
      const r = await api("pdf_tool", { path: ctx.path, op }, { json: { ...json, out } });
      toast(`Creato ${baseName(out)} (${r.pagine} pagine)`);
      ctx.openFile(out);
    } catch (e) { toast(e.message, true, 6000); }
  };
  const field = (label, value, id, hint) => {
    const input = el("input", { type: "text", value, id: id + "-" + ctx.tab.name });
    return { input, row: el("label", { style: { display: "grid", gap: "4px" } }, label, input, hint ? el("span", { class: "note", style: { color: "var(--muted)", fontSize: "12px" } }, hint) : null) };
  };
  const ask = async (title, rows) => modal(title, el("div", { style: { display: "grid", gap: "12px" } }, ...rows), [{ label: "Annulla", value: false }, { label: "Continua", value: true, primary: true }]);
  const PG_HINT = "Esempi: 1-3, 5, 8-  (il documento ha " + "{n} pagine)";
  const tools = [
    ["Unisci", "plus", async () => {
      const others = await pickFiles();
      if (!others?.length) return;
      run("merge", { others }, stem + "_unito.pdf");
    }, "Accoda altri PDF a questo documento"],
    ["Estrai pagine", "download", async () => {
      const f = field("Pagine da estrarre", "1", "pdf-ex", PG_HINT.replace("{n}", pages()));
      if (await ask("Estrai pagine", [f.row])) run("extract", { pages: f.input.value }, stem + "_estratto.pdf");
    }, "Crea un nuovo PDF con le pagine scelte"],
    ["Elimina pagine", "trash", async () => {
      const f = field("Pagine da eliminare", "", "pdf-del", PG_HINT.replace("{n}", pages()));
      if (await ask("Elimina pagine", [f.row])) run("delete", { pages: f.input.value }, stem + "_ridotto.pdf");
    }, "Crea un nuovo PDF senza le pagine scelte"],
    ["Ruota", "rotate", async () => {
      const f = field("Pagine da ruotare (vuoto = tutte)", "", "pdf-rot", PG_HINT.replace("{n}", pages()));
      const ang = el("select", { class: "field", id: "pdf-ang-" + ctx.tab.name }, el("option", { value: 90 }, "90° in senso orario"), el("option", { value: 180 }, "180°"), el("option", { value: 270 }, "90° in senso antiorario"));
      if (await ask("Ruota pagine", [f.row, el("label", { style: { display: "grid", gap: "4px" } }, "Rotazione", ang)])) run("rotate", { pages: f.input.value, angle: +ang.value }, stem + "_ruotato.pdf");
    }, "Ruota tutte o alcune pagine"],
    ["Dividi", "scissors", async () => {
      const folder = await pickFolder();
      if (!folder) return;
      try { const r = await api("pdf_tool", { path: ctx.path, op: "split" }, { json: { folder } }); toast(`Creati ${r.files.length} file in ${folder}`); } catch (e) { toast(e.message, true); }
    }, "Un file PDF per ogni pagina"],
    ["Filigrana", "text", async () => {
      const f = field("Testo della filigrana", "BOZZA", "pdf-wm");
      const p = field("Pagine (vuoto = tutte)", "", "pdf-wmp");
      if (await ask("Filigrana diagonale", [f.row, p.row])) run("stamp", { text: f.input.value, mode: "filigrana", pages: p.input.value }, stem + "_filigrana.pdf");
    }, "Testo diagonale semitrasparente su ogni pagina"],
    ["Timbro", "sign", async () => {
      const today = new Date().toLocaleDateString("it-IT");
      const f = el("textarea", { id: "pdf-st-" + ctx.tab.name, rows: 3, class: "field", style: { width: "100%", fontFamily: "var(--ui)" } }, `APPROVATO\nMB Engineering srl\n${today}`);
      const p = field("Pagine (vuoto = tutte)", "1", "pdf-stp");
      if (await ask("Timbro in alto a destra", [el("label", { style: { display: "grid", gap: "4px" } }, "Testo del timbro (una riga per riga)", f), p.row])) run("stamp", { text: f.value, mode: "timbro", pages: p.input.value }, stem + "_timbrato.pdf");
    }, "Riquadro di testo in alto a destra (approvazione, revisione, data)"],
  ];
  for (const [label, icon, fn, title] of tools) ctx.tb.append(button(label, icon, fn, { title }));
  ctx.tb.append(el("span", { class: "grow" }), el("span", { class: "note" }, "Annotazioni (testo, disegno, evidenziatore, immagini): strumenti in alto a destra nel documento · Ctrl+S salva"));
  // firme digitali nel PDF
  api("pdf_signatures", { path: ctx.path }, { allowFail: true }).then(r => {
    const sigs = (r.firme || []).filter(s => s.firmatari);
    if (!sigs.length) return;
    const all = sigs.flatMap(s => s.firmatari);
    const ok = all.every(s => s.firma_valida && s.integrita);
    const b = button(`Firme digitali (${all.length})`, "sign", async () => {
      const box = el("div", { style: { display: "grid", gap: "10px" } });
      sigs.forEach(s => s.firmatari.forEach(f => box.append(renderSigner(f, box.childElementCount))));
      if (sigs.some(s => !s.copre_intero_file)) box.append(el("p", { class: "note" }, "Una o piu' firme non coprono l'intero file: il PDF e' stato modificato dopo la firma (es. firme successive o annotazioni)."));
      await modal("Firme digitali del PDF", box);
    });
    b.prepend(el("span", { class: "chip " + (ok ? "ok" : "bad"), style: { marginRight: "4px" } }, ok ? "valide" : "verificare"));
    ctx.tb.prepend(b, el("span", { class: "sep" }));
  });

  return {
    async save(target) {
      const a = app();
      const data = await a.pdfDocument.saveDocument();
      await api("save", { path: target }, { body: data });
      a.pdfDocument.annotationStorage.resetModified?.();
    },
  };
}
