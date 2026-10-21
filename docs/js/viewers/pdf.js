// PDF con il visualizzatore di Mozilla (pdf.js): pagine, ricerca, stampa, annotazioni; firme PAdES.
import { api, baseName, button, dirName, el, fileUrl, modal, pickFiles, pickFolder, pickSavePath, toast, waitJob, WEB } from "../core.js";
import { createPdfEditor } from "../pdfeditor.js";
import { renderSigner } from "./signed.js";

export async function mount(ctx) {
  ctx.fillBody(true);
  const src = window.MBV_ROOT + "vendor/pdfjs/web/viewer.html?file=" + encodeURIComponent(fileUrl(ctx.path)) + (innerWidth < 760 ? "#pagemode=none&zoom=page-width" : "#pagemode=thumbs");
  const frame = el("iframe", { class: "fill", src, title: ctx.name });
  ctx.el.append(frame);
  const app = () => frame.contentWindow?.PDFViewerApplication;

  frame.addEventListener("load", async () => {
    // puntatore sempre a freccia anche dentro il visualizzatore PDF (richiesta dell'utente)
    try { const s = frame.contentDocument.createElement("style"); s.textContent = "*, *::before, *::after { cursor: default !important; }"; frame.contentDocument.head.append(s); } catch { /* */ }
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
  const ed = WEB ? null : createPdfEditor(ctx, frame, busy => (frame.style.opacity = busy ? 0.6 : 1));
  // le operazioni sull'intero documento partono dal documento come appare ora (con le modifiche non ancora salvate)
  const current = async () => (ed ? ed.currentFile() : ctx.path);
  const run = async (op, json, suggested) => {
    const out = await pickSavePath(suggested, dir);
    if (!out) return;
    try {
      const r = await api("pdf_tool", { path: await current(), op }, { json: { ...json, out } });
      toast(`Creato ${baseName(out)}${r.pagine ? ` (${r.pagine} pagine)` : ""}${r.dopo ? ` · da ${(r.prima / 1048576).toFixed(1)} a ${(r.dopo / 1048576).toFixed(1)} MB` : ""}`);
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
      try { const r = await api("pdf_tool", { path: await current(), op: "split" }, { json: { folder } }); toast(`Creati ${r.files.length} file in ${folder}`); } catch (e) { toast(e.message, true); }
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
  // ---- editor: testo esistente, oscuramento, bianchetto (solo app per PC: usa il motore PyMuPDF)
  let backHandler = null;
  if (ed) {
    const modeBtns = {};
    const setMode = async m => {
      const now = await ed.setMode(m);
      for (const [k, b] of Object.entries(modeBtns)) b.classList.toggle("on", k === now);
      ctx.status(now === "text" ? "Modifica testo: clic su una riga, scrivi, Invio per confermare (Esc annulla)"
        : now === "redact" ? "Oscura: trascina un riquadro sulla zona da eliminare"
        : now === "whiteout" ? "Bianchetto: trascina un riquadro sulla zona da coprire di bianco" : "");
    };
    modeBtns.text = button("Modifica testo", "edit", () => setMode("text"), { title: "Modifica il testo esistente con lo stesso carattere, dimensione e colore" });
    modeBtns.redact = button("Oscura", "pen", () => setMode("redact"), { title: "Elimina definitivamente testo e immagini in una zona (riquadro nero)" });
    modeBtns.whiteout = button("Bianchetto", "pen", () => setMode("whiteout"), { title: "Copre di bianco una zona eliminandone il contenuto" });
    ctx.tb.append(...Object.values(modeBtns), button("", "undo", () => ed.undoLast(), { iconOnly: true, title: "Annulla l'ultima modifica al testo" }), el("span", { class: "sep" }));
    backHandler = () => (ed.mode ? (setMode(ed.mode), true) : false);
  }
  for (const [label, icon, fn, title] of tools) ctx.tb.append(button(label, icon, fn, { title }));
  if (ed) {
    const more = el("select", { class: "field", title: "Altre operazioni sul PDF", id: "pdf-more-" + ctx.tab.name, onchange: async e => { const v = e.target.value; e.target.value = ""; if (v) await extra(v); } },
      el("option", { value: "" }, "Altro..."), el("option", { value: "ocr" }, "Rendi ricercabile (OCR dei documenti scansionati)"), el("option", { value: "compress" }, "Comprimi (riduce le dimensioni)"), el("option", { value: "numbers" }, "Numeri di pagina"),
      el("option", { value: "protect" }, "Proteggi con password"), el("option", { value: "unlock" }, "Togli la password"), el("option", { value: "blank" }, "Inserisci pagina bianca"),
      el("option", { value: "reorder" }, "Riordina le pagine"), el("option", { value: "word" }, "Converti in Word (.docx)"), el("option", { value: "images" }, "Esporta pagine come immagini"));
    ctx.tb.append(more);
  }
  const lbl = (text, input) => el("label", { style: { display: "grid", gap: "4px" } }, text, input);
  async function extra(v) {
    if (v === "ocr") {
      const out = await pickSavePath(stem + "_ricercabile.pdf", dir);
      if (!out) return;
      try {
        const { job } = await api("pdf_tool", { path: await current(), op: "ocr" }, { json: { out } });
        const r = await waitJob(job, (p, m) => ctx.status(`${m} (${Math.round(p * 100)}%)`));
        toast(r.pagine ? `Testo riconosciuto su ${r.pagine} pagine (${r.parole} parole)` : "Il documento aveva gia' il testo in tutte le pagine");
        ctx.openFile(out);
      } catch (e) { toast(e.message, true, 8000); }
      return;
    }
    if (v === "compress") {
      const q = el("select", { class: "field", id: "pdf-cq-" + ctx.tab.name }, el("option", { value: "150|75" }, "Equilibrata (150 dpi)"), el("option", { value: "110|60" }, "Massima riduzione (110 dpi)"), el("option", { value: "220|85" }, "Alta qualita' (220 dpi)"));
      if (!(await ask("Comprimi PDF", [lbl("Qualita' delle immagini", q)]))) return;
      const [dpi, quality] = q.value.split("|");
      return run("compress", { dpi: +dpi, quality: +quality }, stem + "_compresso.pdf");
    }
    if (v === "numbers") {
      const f = field("Formato ({n} = pagina, {tot} = totale)", "Pagina {n} di {tot}", "pdf-num");
      const pos = el("select", { class: "field", id: "pdf-pos-" + ctx.tab.name }, ...["basso-destra", "basso-centro", "basso-sinistra", "alto-destra", "alto-centro", "alto-sinistra"].map(p => el("option", { value: p }, p.replace("-", " "))));
      if (await ask("Numeri di pagina", [f.row, lbl("Posizione", pos)])) run("numbers", { format: f.input.value, pos: pos.value }, stem + "_numerato.pdf");
      return;
    }
    if (v === "protect") {
      const pw = el("input", { type: "password", id: "pdf-pw-" + ctx.tab.name, class: "field" });
      const cp = el("input", { type: "checkbox", id: "pdf-cp-" + ctx.tab.name }), pr = el("input", { type: "checkbox", checked: true, id: "pdf-pr-" + ctx.tab.name });
      if (!(await ask("Proteggi con password", [lbl("Password per aprire il documento", pw), el("label", {}, pr, " Consenti la stampa"), el("label", {}, cp, " Consenti di copiare il testo")]))) return;
      if (!pw.value) return toast("Password vuota: nessuna protezione applicata", true);
      return run("protect", { password: pw.value, print: pr.checked, copy: cp.checked }, stem + "_protetto.pdf");
    }
    if (v === "unlock") {
      const pw = el("input", { type: "password", id: "pdf-upw-" + ctx.tab.name, class: "field" });
      if (await ask("Togli la password", [lbl("Password attuale", pw)])) run("unlock", { password: pw.value }, stem + "_sbloccato.pdf");
      return;
    }
    if (v === "blank") {
      const f = field("Inserire dopo la pagina (0 = all'inizio)", String(app()?.page || 1), "pdf-blank");
      if (await ask("Pagina bianca", [f.row])) run("blank", { after: parseInt(f.input.value, 10) || 0 }, stem + "_con_pagina.pdf");
      return;
    }
    if (v === "reorder") {
      const n = app()?.pagesCount || 1;
      const f = field("Nuovo ordine delle pagine", Array.from({ length: n }, (_, i) => i + 1).join(", "), "pdf-ord", "Scrivi i numeri nell'ordine voluto: le pagine omesse vengono tolte, quelle ripetute duplicate");
      if (!(await ask("Riordina le pagine", [f.row]))) return;
      const order = f.input.value.split(/[,;\s]+/).map(x => parseInt(x, 10) - 1).filter(x => x >= 0 && x < n);
      if (!order.length) return toast("Ordine non valido", true);
      return run("reorder", { order }, stem + "_riordinato.pdf");
    }
    if (v === "word") return run("word", {}, stem + ".docx");
    if (v === "images") {
      const folder = await pickFolder();
      if (!folder) return;
      try { const r = await api("pdf_tool", { path: await current(), op: "images" }, { json: { folder, dpi: 150 } }); toast(`Create ${r.files.length} immagini in ${folder}`); } catch (e) { toast(e.message, true); }
    }
  }
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
    onBack() { return backHandler ? backHandler() : false; },
    async save(target) {
      const a = app();
      const data = await a.pdfDocument.saveDocument();
      await api("save", { path: target }, { body: data });
      a.pdfDocument.annotationStorage.resetModified?.();
    },
  };
}
