// PDF con il visualizzatore di Mozilla (pdf.js): pagine, ricerca, stampa, annotazioni; firme PAdES.
// App per PC: editor in stile Acrobat Pro (ui/js/pdfeditor.js) con UNA sola riga di comandi raggruppati per tipo
// (la barra di pdf.js e' nascosta: pagina, zoom e ricerca stanno nella riga) e il pannello delle proprieta' a destra.
// Web app: barra semplice con gli strumenti di pdf-lib (ui/js/webapi.js) e le annotazioni di pdf.js.
import { api, baseName, button, dirName, el, fileUrl, loadCss, modal, pickFiles, pickFolder, pickSavePath, toast, WEB } from "../core.js";
import { createPdfEditor, PDFJS_CHROME, PDFJS_HIDE } from "../pdfeditor.js";
import { describeKeys } from "../shortcuts.js";
import { renderSigner } from "./signed.js";
import { INK_ICON } from "../ink.js";
import { t, LOCALE } from "../i18n.js";
import { measureBtn } from "../measure/mbutton.js";

export async function mount(ctx) {
  ctx.fillBody(true);
  if (!WEB) loadCss("css/pdfeditor.css");
  const src = "/vendor/pdfjs/web/viewer.html?file=" + encodeURIComponent(fileUrl(ctx.path)) + (innerWidth < 760 ? "#pagemode=none&zoom=page-width" : "#pagemode=thumbs");
  const frame = el("iframe", { src, title: ctx.name, style: { position: "absolute", inset: "0", width: "100%", height: "100%", border: 0, display: "block", minWidth: 0 } });
  // [documento | pannello proprieta']: altezze esplicite, il documento occupa tutto lo spazio sotto la riga di comandi
  const stage = el("div", { style: { flex: "1", minWidth: 0, position: "relative" } }, frame);
  const area = el("div", { style: { position: "absolute", inset: "0", display: "flex" } }, stage);
  ctx.el.append(area);
  const app = () => frame.contentWindow?.PDFViewerApplication;
  const ed = WEB ? null : createPdfEditor(ctx, frame, busy => stage.classList.toggle("pe-busy", busy));
  // web app (tablet, telefono): penna, evidenziatore e gomma sulle pagine -> annotazioni Ink nel file (ui/js/ink.js, inkpdf.js)
  let ink = null;
  const inkBtn = WEB ? button(t("ink.penna"), INK_ICON, () => ink?.toggle(), { class: "ink-toggle", title: t("ink.annota_pdf") }) : null;
  async function setupInk(a) {
    if (ink) return ink.refresh();
    const { createInk } = await import("../ink.js");
    const cont = frame.contentDocument.getElementById("viewerContainer");
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; ink.refresh(); }); };
    // dita: un dito scorre, due dita scorrono e ingrandiscono (zoom di pdf.js attorno al punto del pizzico)
    let zf = 1, zo = null, zraf = 0;
    ink = createInk({
      host: stage, nativeTouch: false,
      pan: (dx, dy) => { cont.scrollLeft -= dx; cont.scrollTop -= dy; },
      zoom: (f, lx, ly, cx, cy) => {
        zf *= f; zo = [cx, cy];
        // pdf.js arrotonda la scala al centesimo: i passi piccoli si accumulano; il disegno vero arriva a gesto fermo
        if (!zraf) zraf = requestAnimationFrame(() => { zraf = 0; if (Math.abs(zf - 1) < 0.02) return; const k = zf; zf = 1; a.pdfViewer.updateScale({ scaleFactor: k, origin: zo, drawingDelay: 350 }); });
      },
      // solo le pagine vicine a quelle visibili hanno il livello della penna
      surfaces: () => {
        const out = [], vr = cont.getBoundingClientRect();
        for (let i = 0; i < a.pagesCount; i++) {
          const pv = a.pdfViewer.getPageView(i);
          if (!pv?.div) continue;
          const r = pv.div.getBoundingClientRect();
          if (r.bottom < vr.top - vr.height || r.top > vr.bottom + vr.height) continue;
          const vp = pv.viewport;
          out.push({ key: i, el: pv.div, toDoc: (x, y) => vp.convertToPdfPoint(x, y), toLocal: (x, y) => vp.convertToViewportPoint(x, y) });
        }
        return out;
      },
      onChange: () => ctx.setDirty(true),
      onToggle: on => inkBtn.classList.toggle("on", on),
    });
    for (const ev of ["pagerendered", "scalechanging", "rotationchanging", "pagesloaded", "updateviewarea"]) a.eventBus.on(ev, later);
    cont.addEventListener("scroll", later, { passive: true });
  }

  frame.addEventListener("load", async () => {
    // puntatore sempre a freccia anche dentro il visualizzatore PDF (richiesta dell'utente)
    // con l'editor dell'app per PC la barra e i pulsanti di annotazione di pdf.js si nascondono: li sostituisce la riga dell'editor
    try { const s = frame.contentDocument.createElement("style"); s.textContent = "*, *::before, *::after { cursor: default !important; }" + (ed ? PDFJS_HIDE + PDFJS_CHROME : ""); frame.contentDocument.head.append(s); } catch { /* */ }
    // colori di pdf.js presi dai token dell'app (tema chiaro/scuro scelto in MB Desk, non quello di Windows)
    const theme = frame.contentDocument?.createElement("style");
    const paint = () => {
      const v = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
      if (theme) theme.textContent = `:root:root { --body-bg-color: ${v("--bg")}; --toolbar-bg-color: ${v("--panel")}; --sidebar-narrow-bg-color: ${v("--panel")};
        --sidebar-toolbar-bg-color: ${v("--panel")}; --toolbar-border-color: ${v("--line")}; --toolbar-box-shadow: none; --separator-color: ${v("--line-strong")};
        --main-color: ${v("--fg")}; --field-bg-color: ${v("--panel-2")}; --field-color: ${v("--fg")}; --field-border-color: ${v("--line-strong")};
        --dropdown-btn-bg-color: ${v("--panel-2")}; --button-hover-color: ${v("--hover")}; --toggled-btn-bg-color: ${v("--accent-soft")};
        --doorhanger-bg-color: ${v("--panel-2")}; --doorhanger-border-color: ${v("--line-strong")}; --doorhanger-hover-bg-color: ${v("--accent-soft")};
        --progressBar-color: ${v("--accent")}; --scrollbar-color: ${v("--line-strong")}; --scrollbar-bg-color: transparent; color-scheme: ${v("color-scheme") || "normal"};
        --sidebar-width: 190px; }
        #toolbarContainer, #toolbarSidebar { box-shadow: inset 0 -1px 0 ${v("--line")} !important; }
        #sidebarContainer { border-right: 1px solid ${v("--line")}; }
        .annotationLayer { color-scheme: light; } /* campi sulla pagina bianca: nel tema scuro la spunta (CanvasText) diventava bianca */
        .thumbnail.selected > .thumbnailImage, .thumbnail:hover > .thumbnailImage { outline: 2px solid ${v("--accent")}; outline-offset: 2px; }`;
    };
    if (theme) { paint(); frame.contentDocument.head.append(theme); addEventListener("mbv-theme", paint); }
    const a = app();
    if (!a) return;
    await a.initializedPromise;
    // pulsante Stampa e Ctrl+P di pdf.js -> finestra Stampa di MB Desk (ui/js/print.js)
    if (!WEB) try { frame.contentWindow.print = () => window.MB?.print?.(); } catch { /* */ }
    bar?.hookNav();
    a.eventBus.on("documentloaded", () => {
      ed?.attach(); // tasti dell'editor attivi subito, anche prima di scegliere uno strumento
      const store = a.pdfDocument.annotationStorage;
      store.onSetModified = () => ctx.setDirty(true);
      store.onResetModified = () => ctx.setDirty(false);
      ctx.status(t("pdfed.n_pagine", a.pagesCount));
      ed?.changed();
      if (WEB) setupInk(a);
    });
    a.eventBus.on("pagechanging", e => ctx.status(t("v_pdf.pagina_0_1", e.pageNumber, a.pagesCount)));
  });

  const dir = dirName(ctx.path), stem = ctx.name.replace(/\.pdf$/i, "");
  let bar = null, backHandler = null;
  // misure ed estrazioni (pannello comune a PDF, CAD e 3D: ui/js/measure/mpdf.js), salvate nel PDF con Salva
  let meas = null, measP = null;
  const measGet = () => (measP ??= import("../measure/mpdf.js").then(async m => (meas = await m.attachPdf(ctx, ed, stage))));
  if (ed) {
    // ---- app per PC: editor completo, una sola riga di comandi
    const [{ attachPanel }, { buildBar }, { makeCommands }] = await Promise.all([import("../pdfedpanel.js"), import("../pdfedbar.js"), import("../pdfdocs.js")]);
    ed.stage = stage;
    ed.searchHost = stage;
    attachPanel(ed);
    const cmds = makeCommands(ed);
    ed.pageCmd = cmds.pageCmd;
    ed.docCmd = cmds.docCmd;
    ed.askLink = async () => {
      const uri = el("input", { type: "text", class: "pe-in", value: "https://" }), pg = el("input", { type: "number", class: "pe-in", min: 1, max: ed.pages() });
      [uri, pg].forEach(i => i.addEventListener("keydown", e => e.stopPropagation()));
      const ok = await modal(t("pdfed.t_collegamento"), el("div", { class: "pe-dlg" }, el("label", { class: "pe-f" }, el("span", {}, t("pdfed.indirizzo_web")), uri),
        el("label", { class: "pe-f" }, el("span", {}, t("pdfed.oppure_pagina")), pg)), [{ label: t("common.annulla"), value: false }, { label: "OK", value: true, primary: true }]);
      if (!ok) return null;
      if (+pg.value >= 1) return { page: +pg.value };
      return uri.value.trim() && uri.value.trim() !== "https://" ? { uri: uri.value.trim() } : null;
    };
    area.append(ed.panel);
    bar = buildBar(ed, { doc: cmds.docCmd, page: cmds.pageCmd });
    ctx.tb.classList.add("pe-tbrow");
    ctx.tb.append(...bar.row);
    const measBtn = measureBtn(async () => { const m = await measGet(); await m.toggle(); measBtn.classList.toggle("on", m.open); });
    measBtn.classList.add("pe-meas");
    ctx.tb.append(measBtn);
    // la riga resta una: se la finestra e' stretta spariscono le didascalie dei gruppi, poi scorre
    const fit = () => { ctx.tb.classList.remove("compact"); if (ctx.tb.scrollWidth > ctx.tb.clientWidth + 2) ctx.tb.classList.add("compact"); };
    new ResizeObserver(fit).observe(ctx.tb);
    backHandler = () => (meas?.open && meas.E.busy() ? (meas.E.cancel(), true) : ed.escape());
    describeKeys(ctx, "Acrobat", keys());
    ed.renderPanel();
    bar.syncState();
  } else {
    // ---- web app: strumenti di pdf-lib (creano un nuovo file)
    const pages = () => app()?.pagesCount || "?";
    const run = async (op, json, suggested) => {
      const out = await pickSavePath(suggested, dir);
      if (!out) return;
      try {
        const r = await api("pdf_tool", { path: ctx.path, op }, { json: { ...json, out } });
        toast(t("v_pdf.creato_0_1_2", baseName(out), r.pagine ? t("v_pdf.0_pagine", r.pagine) : "", ""));
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
      [t("v_pdf.unisci"), "plus", async () => { const others = await pickFiles(); if (others?.length) run("merge", { others }, stem + "_unito.pdf"); }, t("v_pdf.accoda_altri_pdf_questo_documento")],
      [t("v_pdf.estrai_pagine"), "download", async () => { const f = field(t("v_pdf.pagine_estrarre"), "1", "pdf-ex", PG_HINT.replace("{n}", pages())); if (await ask(t("v_pdf.estrai_pagine"), [f.row])) run("extract", { pages: f.input.value }, stem + "_estratto.pdf"); }, t("v_pdf.crea_nuovo_pdf_pagine_scelte")],
      [t("v_pdf.elimina_pagine"), "trash", async () => { const f = field(t("v_pdf.pagine_eliminare"), "", "pdf-del", PG_HINT.replace("{n}", pages())); if (await ask(t("v_pdf.elimina_pagine"), [f.row])) run("delete", { pages: f.input.value }, stem + "_ridotto.pdf"); }, t("v_pdf.crea_nuovo_pdf_senza_pagine")],
      [t("v_pdf.ruota"), "rotate", async () => {
        const f = field(t("v_pdf.pagine_ruotare_vuoto_tutte"), "", "pdf-rot", PG_HINT.replace("{n}", pages()));
        const ang = el("select", { class: "field", id: "pdf-ang-" + ctx.tab.name }, el("option", { value: 90 }, t("v_pdf.90_senso_orario")), el("option", { value: 180 }, "180°"), el("option", { value: 270 }, t("v_pdf.90_senso_antiorario")));
        if (await ask(t("v_pdf.ruota_pagine"), [f.row, el("label", { style: { display: "grid", gap: "4px" } }, t("v_pdf.rotazione"), ang)])) run("rotate", { pages: f.input.value, angle: +ang.value }, stem + "_ruotato.pdf");
      }, t("v_pdf.ruota_tutte_alcune_pagine")],
      [t("v_pdf.dividi"), "scissors", async () => {
        const folder = await pickFolder();
        if (!folder) return;
        try { const r = await api("pdf_tool", { path: ctx.path, op: "split" }, { json: { folder } }); toast(t("v_pdf.creati_0_file_1", r.files.length, folder)); } catch (e) { toast(e.message, true); }
      }, t("v_pdf.file_pdf_ogni_pagina")],
      [t("v_pdf.filigrana"), "text", async () => {
        const f = field(t("v_pdf.testo_filigrana"), "BOZZA", "pdf-wm"), p = field(t("v_pdf.pagine_vuoto_tutte"), "", "pdf-wmp");
        if (await ask(t("v_pdf.filigrana_diagonale"), [f.row, p.row])) run("stamp", { text: f.input.value, mode: "filigrana", pages: p.input.value }, stem + "_filigrana.pdf");
      }, t("v_pdf.testo_diagonale_semitrasparente_ogni_pagina")],
      [t("v_pdf.timbro"), "sign", async () => {
        const f = el("textarea", { id: "pdf-st-" + ctx.tab.name, rows: 3, class: "field", style: { width: "100%", fontFamily: "var(--ui)" } }, t("v_pdf.approvato_mb_engineering_srl_0", new Date().toLocaleDateString(LOCALE)));
        const p = field(t("v_pdf.pagine_vuoto_tutte"), "1", "pdf-stp");
        if (await ask(t("v_pdf.timbro_alto_destra"), [el("label", { style: { display: "grid", gap: "4px" } }, t("v_pdf.testo_timbro_riga_riga"), f), p.row])) run("stamp", { text: f.value, mode: "timbro", pages: p.input.value }, stem + "_timbrato.pdf");
      }, t("v_pdf.riquadro_testo_alto_destra_approvazione")],
    ];
    ctx.tb.append(inkBtn, el("span", { class: "sep" }));
    for (const [label, icon, fn, title] of tools) ctx.tb.append(button(label, icon, fn, { title }));
    ctx.tb.append(el("span", { class: "grow" }), el("span", { class: "note" }, t("v_pdf.annotazioni_testo_disegno_evidenziatore_immagini")));
  }

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
    b.prepend(el("span", { class: "chip " + (ok ? "ok" : "bad"), style: { marginRight: "4px" } }, ok ? t("v_pdf.valide") : t("v_pdf.verificare")));
    ctx.tb.prepend(b, el("span", { class: "sep" }));
  });

  function keys() {
    const S = t("pdfed.k_strumenti"), O = t("pdfed.k_oggetti"), P = t("pdfed.g_pagine"), M = t("pdfed.modifica");
    return [["V", t("pdfed.t_seleziona"), S], ["H", t("pdfed.t_mano"), S], ["T", t("pdfed.t_modifica_testo"), S], ["W", t("pdfed.t_aggiungi_testo"), S], ["I", t("pdfed.t_immagine"), S],
      ["R", t("pdfed.t_forme"), S], ["L", t("pdfed.t_collegamento"), S], ["S", t("pdfed.t_nota"), S], ["U / Maiusc+U", t("pdfed.k_evidenzia_ciclo"), S], ["X", t("pdfed.t_casella_testo"), S],
      ["D", t("pdfed.t_penna"), S], ["N", t("pdfed.t_forme_commento"), S], ["K", t("pdfed.t_timbro"), S], ["Q", t("pdfed.t_campo"), S], ["C", t("pdfed.t_ritaglia"), S], ["Y", t("pdfed.t_oscura"), S],
      ["Esc", t("pdfed.k_esc"), S], ["Ctrl+F", t("pdfed.cerca"), S],
      [t("pdfed.k_frecce"), t("pdfed.k_sposta_1pt"), O], ["Canc", t("pdfed.k_elimina_sel"), O], ["Ctrl+A", t("pdfed.k_seleziona_tutti"), O], ["Ctrl+C / Ctrl+X / Ctrl+V", t("pdfed.k_appunti"), O],
      ["Ctrl+G / Ctrl+Maiusc+G", t("pdfed.k_gruppi"), O], ["Ctrl+Maiusc+] / [", t("pdfed.k_ordine"), O], [t("pdfed.k_maiusc_trascina"), t("pdfed.k_vincola"), O], [t("pdfed.k_alt_trascina"), t("pdfed.k_senza_aggancio"), O],
      [t("pdfed.k_doppio_clic"), t("pdfed.k_doppio_clic_spiega"), O],
      ["Ctrl+Maiusc+R", t("pdfed.ruota_pagine"), P], ["Ctrl+Maiusc+D", t("pdfed.elimina_pagine"), P], ["Ctrl+Maiusc+I", t("pdfed.inserisci_pagine"), P], ["Ctrl+Maiusc+E", t("pdfed.estrai_pagine"), P],
      ["Ctrl+D", t("pdfed.proprieta_documento"), M], ["Ctrl+Z / Ctrl+Y", t("pdfed.k_annulla_ripeti"), M], ["Ctrl+S", t("common.salva"), M]];
  }

  return {
    _pe: ed, // collaudi dalla console: MB.active.api._pe (stato, comandi, ops)
    get _ink() { return ink; }, // collaudi della penna: MB.active.api._ink (strokes, toggle)
    onBack() { return backHandler ? backHandler() : false; },
    // finestra Stampa: il documento come appare ora (modifiche e annotazioni non ancora salvate comprese)
    async printSource() {
      const a = app();
      if (a?.pdfDocument && a.pdfDocument.annotationStorage.size > 0) {
        const { path } = await api("temp_path", { name: ctx.name });
        await api("save", { path }, { body: await a.pdfDocument.saveDocument() });
        return { path, name: ctx.name };
      }
      return { path: ed ? await ed.currentFile() : ctx.path, name: ctx.name };
    },
    async save(target) {
      const a = app();
      let data = await a.pdfDocument.saveDocument();
      const inked = ink?.hasStrokes();
      if (inked) data = await (await import("../inkpdf.js")).addInkAnnots(data, ink.strokes);
      await api("save", { path: target }, { body: data });
      a.pdfDocument.annotationStorage.resetModified?.();
      if (meas?.needsWrite) await meas.writeTo(target); // misure: annotazioni con /Measure + allegato misure.mbmis
      if (inked && target === ctx.path) {
        // i tratti ora sono annotazioni del file: si ricarica il documento salvato (stessa pagina) e la penna riparte vuota
        const page = a.page, on = ink.active;
        ink.reset();
        await a.open({ url: fileUrl(ctx.path) });
        a.eventBus.on("pagesloaded", () => { a.page = page; if (on && !ink.active) ink.toggle(true); }, { once: true });
        ctx.setDirty(false);
      } else if (inked) ctx.setDirty(false);
    },
    dispose() { ink?.dispose(); },
    _meas: { get: measGet }, // collaudo dalla console: (await MB.active.api._meas.get()).M
  };
}
