// PDF con il visualizzatore di Mozilla (pdf.js): pagine, ricerca, stampa, annotazioni; firme PAdES.
import { api, baseName, button, dirName, el, fileUrl, modal, pickFiles, pickFolder, pickSavePath, toast, waitJob, WEB } from "../core.js";
import { createPdfEditor, PDFJS_HIDE } from "../pdfeditor.js";
import { describeKeys } from "../shortcuts.js";
import { renderSigner } from "./signed.js";
import { t, LOCALE } from "../i18n.js";

export async function mount(ctx) {
  ctx.fillBody(true);
  const src = "/vendor/pdfjs/web/viewer.html?file=" + encodeURIComponent(fileUrl(ctx.path)) + (innerWidth < 760 ? "#pagemode=none&zoom=page-width" : "#pagemode=thumbs");
  const frame = el("iframe", { src, title: ctx.name, style: { width: "100%", height: "100%", border: 0, display: "block", minWidth: 0 } });
  // area: [barra dell'editor] sopra, [documento | pannello proprieta'] sotto
  // altezze esplicite: il documento occupa sempre tutto lo spazio sotto la barra (prima restava alto 150 px)
  const area = el("div", { style: { position: "absolute", inset: "0", display: "flex" } }, el("div", { style: { flex: "1", minWidth: 0, position: "relative" } }, frame));
  frame.style.position = "absolute";
  frame.style.inset = "0";
  const wrap = el("div", { style: { display: "flex", flexDirection: "column", width: "100%", height: "100%" } }, el("div", { style: { flex: "1", minHeight: 0, position: "relative" } }, area));
  ctx.el.append(wrap);
  const app = () => frame.contentWindow?.PDFViewerApplication;

  frame.addEventListener("load", async () => {
    // puntatore sempre a freccia anche dentro il visualizzatore PDF (richiesta dell'utente)
    // con l'editor dell'app per PC i pulsanti di annotazione di pdf.js si nascondono: li comanda la barra dell'editor
    try { const s = frame.contentDocument.createElement("style"); s.textContent = "*, *::before, *::after { cursor: default !important; }" + (ed ? PDFJS_HIDE : ""); frame.contentDocument.head.append(s); } catch { /* */ }
    // colori della barra di pdf.js presi dai token dell'app (tema chiaro/scuro scelto in MB Visual, non quello di Windows)
    const theme = frame.contentDocument?.createElement("style");
    const paint = () => {
      const v = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
      if (theme) theme.textContent = `:root:root { --body-bg-color: ${v("--bg")}; --toolbar-bg-color: ${v("--panel")}; --sidebar-narrow-bg-color: ${v("--panel")};
        --sidebar-toolbar-bg-color: ${v("--panel")}; --toolbar-border-color: ${v("--line")}; --toolbar-box-shadow: none; --separator-color: ${v("--line-strong")};
        --main-color: ${v("--fg")}; --field-bg-color: ${v("--panel-2")}; --field-color: ${v("--fg")}; --field-border-color: ${v("--line-strong")};
        --dropdown-btn-bg-color: ${v("--panel-2")}; --button-hover-color: ${v("--hover")}; --toggled-btn-bg-color: ${v("--accent-soft")};
        --doorhanger-bg-color: ${v("--panel-2")}; --doorhanger-border-color: ${v("--line-strong")}; --doorhanger-hover-bg-color: ${v("--accent-soft")};
        --progressBar-color: ${v("--accent")}; --scrollbar-color: ${v("--line-strong")}; --scrollbar-bg-color: transparent; color-scheme: ${v("color-scheme") || "normal"}; }
        #toolbarContainer, #toolbarSidebar { box-shadow: inset 0 -1px 0 ${v("--line")} !important; }`;
    };
    if (theme) { paint(); frame.contentDocument.head.append(theme); addEventListener("mbv-theme", paint); }
    const a = app();
    if (!a) return;
    await a.initializedPromise;
    // pulsante Stampa e Ctrl+P di pdf.js -> finestra Stampa di MB Visual (ui/js/print.js)
    if (!WEB) try { frame.contentWindow.print = () => window.MB?.print?.(); } catch { /* */ }
    a.eventBus.on("documentloaded", () => {
      ed?.attach(); // tasti dell'editor attivi subito, anche prima di scegliere uno strumento
      const store = a.pdfDocument.annotationStorage;
      store.onSetModified = () => ctx.setDirty(true);
      store.onResetModified = () => ctx.setDirty(false);
      ctx.status(`${a.pagesCount} pagine`);
    });
    a.eventBus.on("pagechanging", e => ctx.status(t("v_pdf.pagina_0_1", e.pageNumber, a.pagesCount)));
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
      toast(t("v_pdf.creato_0_1_2", baseName(out), r.pagine ? t("v_pdf.0_pagine", r.pagine) : "", r.dopo ? t("v_pdf.0_1_mb", (r.prima / 1048576).toFixed(1), (r.dopo / 1048576).toFixed(1)) : ""));
      ctx.openFile(out);
    } catch (e) { toast(e.message, true, 6000); }
  };
  const field = (label, value, id, hint) => {
    const input = el("input", { type: "text", value, id: id + "-" + ctx.tab.name });
    return { input, row: el("label", { style: { display: "grid", gap: "4px" } }, label, input, hint ? el("span", { class: "note", style: { color: "var(--muted)", fontSize: "12px" } }, hint) : null) };
  };
  const ask = async (title, rows) => modal(title, el("div", { style: { display: "grid", gap: "12px" } }, ...rows), [{ label: t("common.annulla"), value: false }, { label: t("v_pdf.continua"), value: true, primary: true }]);
  const PG_HINT = t("v_pdf.esempi_1_3_5_8");
  const tools = [
    [t("v_pdf.unisci"), "plus", async () => {
      const others = await pickFiles();
      if (!others?.length) return;
      run("merge", { others }, stem + "_unito.pdf");
    }, t("v_pdf.accoda_altri_pdf_questo_documento")],
    [t("v_pdf.estrai_pagine"), "download", async () => {
      const f = field(t("v_pdf.pagine_estrarre"), "1", "pdf-ex", PG_HINT.replace("{n}", pages()));
      if (await ask(t("v_pdf.estrai_pagine"), [f.row])) run("extract", { pages: f.input.value }, stem + "_estratto.pdf");
    }, t("v_pdf.crea_nuovo_pdf_pagine_scelte")],
    [t("v_pdf.elimina_pagine"), "trash", async () => {
      const f = field(t("v_pdf.pagine_eliminare"), "", "pdf-del", PG_HINT.replace("{n}", pages()));
      if (await ask(t("v_pdf.elimina_pagine"), [f.row])) run("delete", { pages: f.input.value }, stem + "_ridotto.pdf");
    }, t("v_pdf.crea_nuovo_pdf_senza_pagine")],
    [t("v_pdf.ruota"), "rotate", async () => {
      const f = field(t("v_pdf.pagine_ruotare_vuoto_tutte"), "", "pdf-rot", PG_HINT.replace("{n}", pages()));
      const ang = el("select", { class: "field", id: "pdf-ang-" + ctx.tab.name }, el("option", { value: 90 }, t("v_pdf.90_senso_orario")), el("option", { value: 180 }, "180°"), el("option", { value: 270 }, t("v_pdf.90_senso_antiorario")));
      if (await ask(t("v_pdf.ruota_pagine"), [f.row, el("label", { style: { display: "grid", gap: "4px" } }, t("v_pdf.rotazione"), ang)])) run("rotate", { pages: f.input.value, angle: +ang.value }, stem + "_ruotato.pdf");
    }, t("v_pdf.ruota_tutte_alcune_pagine")],
    [t("v_pdf.dividi"), "scissors", async () => {
      const folder = await pickFolder();
      if (!folder) return;
      try { const r = await api("pdf_tool", { path: await current(), op: "split" }, { json: { folder } }); toast(t("v_pdf.creati_0_file_1", r.files.length, folder)); } catch (e) { toast(e.message, true); }
    }, t("v_pdf.file_pdf_ogni_pagina")],
    [t("v_pdf.filigrana"), "text", async () => {
      const f = field(t("v_pdf.testo_filigrana"), "BOZZA", "pdf-wm");
      const p = field(t("v_pdf.pagine_vuoto_tutte"), "", "pdf-wmp");
      if (await ask(t("v_pdf.filigrana_diagonale"), [f.row, p.row])) run("stamp", { text: f.input.value, mode: "filigrana", pages: p.input.value }, stem + "_filigrana.pdf");
    }, t("v_pdf.testo_diagonale_semitrasparente_ogni_pagina")],
    [t("v_pdf.timbro"), "sign", async () => {
      const today = new Date().toLocaleDateString(LOCALE);
      const f = el("textarea", { id: "pdf-st-" + ctx.tab.name, rows: 3, class: "field", style: { width: "100%", fontFamily: "var(--ui)" } }, t("v_pdf.approvato_mb_engineering_srl_0", today));
      const p = field(t("v_pdf.pagine_vuoto_tutte"), "1", "pdf-stp");
      if (await ask(t("v_pdf.timbro_alto_destra"), [el("label", { style: { display: "grid", gap: "4px" } }, t("v_pdf.testo_timbro_riga_riga"), f), p.row])) run("stamp", { text: f.value, mode: "timbro", pages: p.input.value }, stem + "_timbrato.pdf");
    }, t("v_pdf.riquadro_testo_alto_destra_approvazione")],
  ];
  if (!WEB) tools.push([t("v_pdf.firma"), "sign", () => import("../firma.js").then(m => m.signDialog({ path: ctx.path, openFile: ctx.openFile })), t("v_pdf.firma_digitale_pades_cades_smart")]);
  // ---- editor (solo app per PC: motore PyMuPDF): barra sempre visibile sotto la barra principale, pannello a destra
  let backHandler = null;
  if (ed) {
    wrap.prepend(ed.bar);
    area.append(ed.panel);
    ed.panel.style.width = "270px";
    ed.panel.style.flex = "none";
    backHandler = () => ed.escape();
    describeKeys(ctx, "Acrobat", ed.keys);
  }
  for (const [label, icon, fn, title] of tools) ctx.tb.append(button(label, icon, fn, { title }));
  if (ed) {
    const more = el("select", { class: "field", title: t("v_pdf.altre_operazioni_pdf"), id: "pdf-more-" + ctx.tab.name, onchange: async e => { const v = e.target.value; e.target.value = ""; if (v) await extra(v); } },
      el("option", { value: "" }, t("v_pdf.altro")), el("option", { value: "ocr" }, t("v_pdf.rendi_ricercabile_ocr_documenti_scansionati")), el("option", { value: "compress" }, t("v_pdf.comprimi_riduce_dimensioni")), el("option", { value: "numbers" }, t("v_pdf.numeri_pagina")),
      el("option", { value: "protect" }, t("v_pdf.proteggi_password")), el("option", { value: "unlock" }, t("v_pdf.togli_password")), el("option", { value: "blank" }, t("v_pdf.inserisci_pagina_bianca")),
      el("option", { value: "reorder" }, t("v_pdf.riordina_pagine")), el("option", { value: "word" }, t("v_pdf.converti_word_docx")), el("option", { value: "images" }, t("v_pdf.esporta_pagine_come_immagini")));
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
        toast(r.pagine ? t("v_pdf.testo_riconosciuto_0_pagine_1", r.pagine, r.parole) : t("v_pdf.documento_aveva_gia_testo_tutte"));
        ctx.openFile(out);
      } catch (e) { toast(e.message, true, 8000); }
      return;
    }
    if (v === "compress") {
      const q = el("select", { class: "field", id: "pdf-cq-" + ctx.tab.name }, el("option", { value: "150|75" }, t("v_pdf.equilibrata_150_dpi")), el("option", { value: "110|60" }, t("v_pdf.massima_riduzione_110_dpi")), el("option", { value: "220|85" }, t("v_pdf.alta_qualita_220_dpi")));
      if (!(await ask(t("v_pdf.comprimi_pdf"), [lbl(t("v_pdf.qualita_immagini"), q)]))) return;
      const [dpi, quality] = q.value.split("|");
      return run("compress", { dpi: +dpi, quality: +quality }, stem + "_compresso.pdf");
    }
    if (v === "numbers") {
      const f = field(t("v_pdf.formato_n_pagina_tot_totale"), t("v_pdf.pagina_n_tot"), "pdf-num");
      const pos = el("select", { class: "field", id: "pdf-pos-" + ctx.tab.name }, ...["basso-destra", "basso-centro", "basso-sinistra", "alto-destra", "alto-centro", "alto-sinistra"].map(p => el("option", { value: p }, p.replace("-", " "))));
      if (await ask(t("v_pdf.numeri_pagina"), [f.row, lbl(t("v_pdf.posizione"), pos)])) run("numbers", { format: f.input.value, pos: pos.value }, stem + "_numerato.pdf");
      return;
    }
    if (v === "protect") {
      const pw = el("input", { type: "password", id: "pdf-pw-" + ctx.tab.name, class: "field" });
      const cp = el("input", { type: "checkbox", id: "pdf-cp-" + ctx.tab.name }), pr = el("input", { type: "checkbox", checked: true, id: "pdf-pr-" + ctx.tab.name });
      if (!(await ask(t("v_pdf.proteggi_password"), [lbl(t("v_pdf.password_aprire_documento"), pw), el("label", {}, pr, t("v_pdf.consenti_stampa")), el("label", {}, cp, t("v_pdf.consenti_copiare_testo"))]))) return;
      if (!pw.value) return toast(t("v_pdf.password_vuota_nessuna_protezione_applicata"), true);
      return run("protect", { password: pw.value, print: pr.checked, copy: cp.checked }, stem + "_protetto.pdf");
    }
    if (v === "unlock") {
      const pw = el("input", { type: "password", id: "pdf-upw-" + ctx.tab.name, class: "field" });
      if (await ask(t("v_pdf.togli_password"), [lbl(t("v_pdf.password_attuale"), pw)])) run("unlock", { password: pw.value }, stem + "_sbloccato.pdf");
      return;
    }
    if (v === "blank") {
      const f = field(t("v_pdf.inserire_dopo_pagina_0_all"), String(app()?.page || 1), "pdf-blank");
      if (await ask(t("v_pdf.pagina_bianca"), [f.row])) run("blank", { after: parseInt(f.input.value, 10) || 0 }, stem + "_con_pagina.pdf");
      return;
    }
    if (v === "reorder") {
      const n = app()?.pagesCount || 1;
      const f = field(t("v_pdf.nuovo_ordine_pagine"), Array.from({ length: n }, (_, i) => i + 1).join(", "), "pdf-ord", t("v_pdf.scrivi_i_numeri_nell_ordine"));
      if (!(await ask(t("v_pdf.riordina_pagine"), [f.row]))) return;
      const order = f.input.value.split(/[,;\s]+/).map(x => parseInt(x, 10) - 1).filter(x => x >= 0 && x < n);
      if (!order.length) return toast(t("v_pdf.ordine_non_valido"), true);
      return run("reorder", { order }, stem + "_riordinato.pdf");
    }
    if (v === "word") return run("word", {}, stem + ".docx");
    if (v === "images") {
      const folder = await pickFolder();
      if (!folder) return;
      try { const r = await api("pdf_tool", { path: await current(), op: "images" }, { json: { folder, dpi: 150 } }); toast(t("v_pdf.create_0_immagini_1", r.files.length, folder)); } catch (e) { toast(e.message, true); }
    }
  }
  ctx.tb.append(el("span", { class: "grow" }), el("span", { class: "note" }, ed ? t("v_pdf.strumenti_modifica_barra_sotto_ctrl") : t("v_pdf.annotazioni_testo_disegno_evidenziatore_immagini")));
  // modelli 3D (U3D / PRC) nelle annotazioni 3D del PDF: pulsante "Modello 3D" (ui/js/pdf3d.js)
  if (!WEB) import("../pdf3d.js").then(m => m.add3dButton(ctx)).catch(() => {});
  // firme digitali nel PDF
  api("pdf_signatures", { path: ctx.path }, { allowFail: true }).then(r => {
    const sigs = (r.firme || []).filter(s => s.firmatari);
    if (!sigs.length) return;
    const all = sigs.flatMap(s => s.firmatari);
    const ok = all.every(s => s.firma_valida && s.integrita);
    const b = button(t("v_pdf.firme_digitali_0", all.length), "sign", async () => {
      const box = el("div", { style: { display: "grid", gap: "10px" } });
      sigs.forEach(s => s.firmatari.forEach(f => box.append(renderSigner(f, box.childElementCount))));
      if (sigs.some(s => !s.copre_intero_file)) box.append(el("p", { class: "note" }, t("v_pdf.piu_firme_non_coprono_l")));
      await modal(t("v_pdf.firme_digitali_pdf"), box);
    });
    b.prepend(el("span", { class: "chip " + (ok ? "ok" : "bad"), style: { marginRight: "4px" } }, ok ? "valide" : "verificare"));
    ctx.tb.prepend(b, el("span", { class: "sep" }));
  });

  return {
    onBack() { return backHandler ? backHandler() : false; },
    // finestra Stampa: il documento come appare ora (modifiche e annotazioni non ancora salvate comprese)
    async printSource() {
      const a = app();
      if (a?.pdfDocument && a.pdfDocument.annotationStorage.size > 0) {
        const { path } = await api("temp_path", { name: ctx.name });
        await api("save", { path }, { body: await a.pdfDocument.saveDocument() });
        return { path, name: ctx.name };
      }
      return { path: await current(), name: ctx.name };
    },
    async save(target) {
      const a = app();
      const data = await a.pdfDocument.saveDocument();
      await api("save", { path: target }, { body: data });
      a.pdfDocument.annotationStorage.resetModified?.();
    },
  };
}
