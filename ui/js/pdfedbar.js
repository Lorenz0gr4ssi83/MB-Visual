// Editor PDF: la riga unica di comandi. A sinistra pagina, zoom, miniature e ricerca (la barra di pdf.js e' nascosta);
// poi i gruppi per tipo di modifica, ognuno con le icone degli strumenti, un menu con tutti i comandi del gruppo e la
// didascalia sotto: Seleziona, Modifica, Commenti, Moduli, Pagine, Proteggi, Documento; in fondo Annulla/Ripeti e pannello.
import { t as tr, fmtNum } from "./i18n.js";
import { el, toast } from "./core.js";
import { pdfIcon } from "./pdfedicons.js";
import { CSHAPES, FIELDS, SHAPES, STAMPS, TOOLS } from "./pdfeditor.js";

// ---------------------------------------------------------------- menu a tendina (stile .menu dell'app)
let menuOpen = null;
export function closeMenu() { menuOpen?.remove(); menuOpen = null; }
export function openMenu(anchor, items, { align = "left" } = {}) {
  closeMenu();
  const m = el("div", { class: "menu pe-menu", role: "menu" });
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { m.append(el("hr")); continue; }
    if (it.head) { m.append(el("div", { class: "pe-mhead" }, it.head)); continue; }
    const b = el("button", { type: "button", role: "menuitem", disabled: it.disabled || undefined, class: it.checked ? "current" : "" },
      el("span", { class: "pe-mico", html: it.icon ? pdfIcon(it.icon, 17) : it.checked ? pdfIcon("check", 15) : "" }),
      el("span", { class: "pe-mlbl" }, it.label), it.key ? el("span", { class: "hint" }, it.key) : null);
    b.addEventListener("click", () => { closeMenu(); it.run?.(); });
    m.append(b);
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(6, Math.min(innerWidth - w - 6, align === "right" ? r.right - w : r.left)) + "px";
  m.style.top = (r.bottom + h + 6 < innerHeight ? r.bottom + 4 : Math.max(6, r.top - h - 4)) + "px";
  menuOpen = m;
  const off = e => { if (!m.contains(e.target)) { closeMenu(); document.removeEventListener("pointerdown", off, true); } };
  setTimeout(() => document.addEventListener("pointerdown", off, true));
  return m;
}
addEventListener("keydown", e => { if (e.key === "Escape" && menuOpen) closeMenu(); }, true);
addEventListener("blur", closeMenu);

const kb = k => (k ? ` (${k})` : "");

export function buildBar(E, { cmd, doc: docCmd, page: pageCmd }) {
  const app = E.app;
  const btns = {};
  const row = [];
  // pulsante icona con suggerimento (nome + tasto)
  const ib = (icon, title, run, cls = "") => {
    const b = el("button", { type: "button", class: "pe-b " + cls, title, "aria-label": title, html: pdfIcon(icon, 18) });
    b.addEventListener("click", run);
    return b;
  };
  // pulsante di uno strumento (resta acceso finche' lo strumento e' attivo)
  const tb = (id, variant, icon, title) => {
    const d = TOOLS[id];
    const b = ib(icon || d.icon, (title || tr(d.name)) + kb(d.key), () => E.setMode(E.mode === id && variant === undefined ? "select" : id, variant));
    b.dataset.tool = id;
    (btns[id] ||= []).push(b);
    return b;
  };
  // strumento con varianti (forme, campi, timbri): il pulsante usa l'ultima variante, la freccetta apre l'elenco
  const split = (id, variants, cur, title) => {
    const d = TOOLS[id];
    const main = el("button", { type: "button", class: "pe-b", "data-tool": id });
    const paint = () => { const v = variants.find(x => x.v === cur()) || variants[0]; main.innerHTML = pdfIcon(v.icon, 18); main.title = `${title || tr(d.name)}: ${v.label}${kb(d.key)}`; main.setAttribute("aria-label", main.title); };
    main.addEventListener("click", () => E.setMode(id, cur()));
    const dd = el("button", { type: "button", class: "pe-dd", title: tr("pdfed.altre_varianti"), "aria-label": tr("pdfed.altre_varianti"), html: pdfIcon("chev", 10) });
    dd.addEventListener("click", () => openMenu(main, variants.map(v => ({ icon: v.icon, label: v.label, checked: v.v === cur(), run: () => { E.setMode(id, v.v); paint(); } }))));
    (btns[id] ||= []).push(main);
    main._paint = paint;
    paint();
    return el("span", { class: "pe-split" }, main, dd);
  };
  const menuBtn = (icon, title, items, label) => {
    const b = el("button", { type: "button", class: "pe-b pe-mb", title, "aria-label": title, html: pdfIcon(icon, 18) + pdfIcon("chev", 9) });
    if (label) b.append(el("span", {}, label));
    b.addEventListener("click", () => openMenu(b, items()));
    return b;
  };
  const group = (cap, ...items) => el("div", { class: "pe-grp", role: "group", "aria-label": cap }, el("div", { class: "pe-btns" }, ...items), el("div", { class: "pe-cap" }, cap));

  // ---------------------------------------------------------------- navigazione (al posto della barra di pdf.js)
  const pageIn = el("input", { class: "pe-page", type: "text", inputmode: "numeric", value: "1", title: tr("pdfed.vai_pagina"), "aria-label": tr("pdfed.vai_pagina") });
  const pageTot = el("span", { class: "pe-tot" }, "/ 1");
  pageIn.addEventListener("change", () => { const n = parseInt(pageIn.value, 10); if (n >= 1 && n <= E.pages()) app().page = n; else pageIn.value = app()?.page || 1; });
  pageIn.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") pageIn.blur(); });
  const zoomSel = el("select", { class: "pe-zoom", title: tr("pdfed.zoom"), "aria-label": tr("pdfed.zoom") },
    ...[["auto", tr("pdfed.z_auto")], ["page-fit", tr("pdfed.z_pagina")], ["page-width", tr("pdfed.z_larghezza")], ["page-actual", tr("pdfed.z_reale")],
      ...[0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map(v => [String(v), Math.round(v * 100) + "%"]), ["custom", ""]].map(([v, l]) => el("option", { value: v, hidden: v === "custom" || undefined }, l)));
  zoomSel.addEventListener("change", () => { app().pdfViewer.currentScaleValue = zoomSel.value; });
  const zoomBy = k => { const v = app().pdfViewer; v.currentScale = Math.max(0.1, Math.min(10, v.currentScale * k)); };
  const nav = el("div", { class: "pe-nav" },
    ib("sidebar", tr("pdfed.miniature_segnalibri") + " (F4)", () => app()?.pdfSidebar?.toggle()),
    el("span", { class: "pe-pg" }, pageIn, pageTot),
    el("span", { class: "pe-zm" }, ib("zoomOut", tr("pdfed.riduci") + " (Ctrl+-)", () => zoomBy(1 / 1.15), "sm"), zoomSel, ib("zoomIn", tr("pdfed.ingrandisci") + " (Ctrl++)", () => zoomBy(1.15), "sm")),
    ib("search", tr("pdfed.cerca") + " (Ctrl+F)", () => openSearch()));
  const syncNav = () => {
    const a = app();
    if (!a?.pdfViewer) return;
    if (document.activeElement !== pageIn) pageIn.value = a.page;
    pageTot.textContent = "/ " + a.pagesCount;
    const v = String(a.pdfViewer.currentScaleValue);
    if ([...zoomSel.options].some(o => o.value === v && !o.hidden)) zoomSel.value = v;
    else { zoomSel.options[zoomSel.options.length - 1].textContent = Math.round(a.pdfViewer.currentScale * 100) + "%"; zoomSel.value = "custom"; }
  };

  // ---------------------------------------------------------------- ricerca (motore di ricerca di pdf.js)
  let search = null;
  function openSearch() {
    if (search) { search.input.focus(); search.input.select(); return; }
    const input = el("input", { type: "search", placeholder: tr("pdfed.cerca_documento"), "aria-label": tr("pdfed.cerca_documento") });
    const count = el("span", { class: "pe-scount" });
    const cs = el("input", { type: "checkbox" }), ww = el("input", { type: "checkbox" });
    const find = (type, prev) => app().eventBus.dispatch("find", { source: null, type, query: input.value, caseSensitive: cs.checked, entireWord: ww.checked, highlightAll: true, findPrevious: !!prev, matchDiacritics: false });
    input.addEventListener("input", () => find(""));
    input.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") find("again", e.shiftKey); if (e.key === "Escape") close(); });
    cs.addEventListener("change", () => find("casesensitivitychange"));
    ww.addEventListener("change", () => find("entirewordchange"));
    const box = el("div", { class: "pe-search" }, pdfIcon("search", 15) ? el("span", { class: "pe-sico", html: pdfIcon("search", 15) }) : null, input, count,
      ib("up", tr("pdfed.precedente") + " (Maiusc+Invio)", () => find("again", true), "sm"), ib("down", tr("pdfed.successivo") + " (Invio)", () => find("again", false), "sm"),
      el("label", { title: tr("pdfed.maiuscole_minuscole") }, cs, "Aa"), el("label", { title: tr("pdfed.parola_intera") }, ww, tr("pdfed.parola")),
      ib("redactSearch", tr("pdfed.oscura_risultati"), () => { close(); docCmd("redactSearch", input.value); }, "sm"),
      ib("close", tr("common.chiudi"), () => close(), "sm"));
    const close = () => { box.remove(); search = null; try { app().eventBus.dispatch("find", { source: null, type: "", query: "", highlightAll: false }); } catch { /* */ } };
    E.searchHost.append(box);
    input.focus();
    search = { input, count, close };
  }
  E.openSearch = openSearch;

  // ---------------------------------------------------------------- gruppi
  const shapeVariants = Object.entries(SHAPES).map(([v, k]) => ({ v, icon: v === "rounded" ? "rounded" : v, label: tr(k) }));
  const cshapeVariants = Object.entries(CSHAPES).map(([v, k]) => ({ v, icon: v, label: tr(k) }));
  const fieldVariants = Object.entries(FIELDS).map(([v, [icon, k]]) => ({ v, icon, label: tr(k) }));
  const markVariants = [["highlight", "highlight", "pdfed.t_evidenzia"], ["underline", "underline", "pdfed.t_sottolinea"], ["strikeout", "strikeout", "pdfed.t_barra"], ["squiggly", "squiggly", "pdfed.t_ondulato"]]
    .map(([v, icon, k]) => ({ v, icon, label: tr(k) }));
  let mark = "highlight";
  const markBtn = (() => {
    const main = el("button", { type: "button", class: "pe-b" });
    const id = () => (mark === "highlight" ? "pj-highlight" : mark);
    const paint = () => { const v = markVariants.find(x => x.v === mark); main.innerHTML = pdfIcon(v.icon, 18); main.title = v.label + (mark === "highlight" ? " (U)" : " (Maiusc+U)"); main.dataset.tool = id(); };
    main.addEventListener("click", () => E.setMode(id()));
    const dd = el("button", { type: "button", class: "pe-dd", title: tr("pdfed.altre_varianti"), html: pdfIcon("chev", 10) });
    dd.addEventListener("click", () => openMenu(main, markVariants.map(v => ({ icon: v.icon, label: v.label, checked: v.v === mark, run: () => { mark = v.v; paint(); E.setMode(id()); } }))));
    for (const k of ["pj-highlight", "underline", "strikeout", "squiggly"]) (btns[k] ||= []).push(main);
    main._paint = paint;
    main._sync = () => { if (["pj-highlight", "underline", "strikeout", "squiggly"].includes(E.mode)) { mark = E.mode === "pj-highlight" ? "highlight" : E.mode; paint(); } };
    paint();
    return el("span", { class: "pe-split" }, main, dd);
  })();
  const stampBtn = el("span", { class: "pe-split" },
    tb("stamp"),
    (() => {
      const dd = el("button", { type: "button", class: "pe-dd", title: tr("pdfed.scegli_timbro"), html: pdfIcon("chev", 10) });
      dd.addEventListener("click", () => openMenu(dd.previousSibling, [
        ...STAMPS.map(([k, c], i) => ({ label: tr(k), icon: "stamp", checked: E.opt.stamp === i, run: () => E.setMode("stamp", i) })),
        { sep: true },
        { label: tr("pdfed.timbro_personalizzato"), icon: "editText", checked: E.opt.stamp === -1, run: () => E.setMode("stamp", -1) },
        { label: tr("pdfed.timbro_immagine"), icon: "image", checked: E.opt.stamp === -2, run: async () => { const d = await E.pickImage(); if (d) { E.opt.stampImage = d; E.setMode("stamp", -2); } } },
      ]));
      return dd;
    })());

  const G = {
    sel: group(tr("pdfed.g_seleziona"), tb("select"), tb("hand")),
    edit: group(tr("pdfed.g_modifica"), tb("edittext"), tb("addtext"), tb("image"), split("shape", shapeVariants, () => E.opt.shape),
      menuBtn("more", tr("pdfed.altri_comandi_modifica"), () => [
        { icon: "editText", label: tr("pdfed.t_modifica_testo"), key: "T", run: () => E.setMode("edittext") },
        { icon: "addText", label: tr("pdfed.t_aggiungi_testo"), key: "W", run: () => E.setMode("addtext") },
        { icon: "image", label: tr("pdfed.t_immagine"), key: "I", run: () => E.setMode("image") },
        { icon: "link", label: tr("pdfed.t_collegamento"), key: "L", checked: E.mode === "link", run: () => E.setMode("link") },
        { icon: "whiteout", label: tr("pdfed.t_bianchetto"), checked: E.mode === "whiteout", run: () => E.setMode("whiteout") },
        { sep: true },
        { icon: "copy", label: tr("pdfed.copia"), key: "Ctrl+C", disabled: !E.sel.length, run: () => E.copySel() },
        { icon: "paste", label: tr("pdfed.incolla"), key: "Ctrl+V", disabled: !E.clip.length, run: () => E.paste() },
        { icon: "duplicate", label: tr("pdfed.duplica"), disabled: !E.sel.length, run: () => E.duplicate() },
        { icon: "group", label: tr("pdfed.raggruppa"), key: "Ctrl+G", disabled: E.sel.length < 2, run: () => E.groupSel() },
        { icon: "ungroup", label: tr("pdfed.separa"), key: "Ctrl+Maiusc+G", disabled: !E.sel.length, run: () => E.ungroupSel() },
        { icon: "front", label: tr("pdfed.primo_piano"), key: "Ctrl+Maiusc+]", disabled: !E.sel.length, run: () => E.order("front") },
        { icon: "back", label: tr("pdfed.in_fondo"), key: "Ctrl+Maiusc+[", disabled: !E.sel.length, run: () => E.order("back") },
        { icon: "trash", label: tr("common.elimina"), key: "Canc", disabled: !E.sel.length, run: () => E.deleteSel() },
      ])),
    comment: group(tr("pdfed.g_commenti"), tb("note"), markBtn, tb("freetext"), tb("pj-ink"), split("cshape", cshapeVariants, () => E.opt.cshape), stampBtn),
    form: group(tr("pdfed.g_moduli"), split("field", fieldVariants, () => E.opt.field, tr("pdfed.t_campo")),
      menuBtn("more", tr("pdfed.altri_comandi_moduli"), () => [
        ...fieldVariants.map(v => ({ icon: v.icon, label: v.label, checked: E.mode === "field" && E.opt.field === v.v, run: () => E.setMode("field", v.v) })),
        { sep: true },
        { icon: "flatten", label: tr("pdfed.appiattisci_moduli"), run: () => docCmd("flattenForms") },
      ])),
    pages: group(tr("pdfed.g_pagine"), ib("pages", tr("pdfed.organizza_pagine"), () => pageCmd("organize")),
      menuBtn("insertPage", tr("pdfed.inserisci_pagine"), () => [
        { icon: "blank", label: tr("pdfed.pagina_bianca"), run: () => pageCmd("blank") },
        { icon: "insertPage", label: tr("pdfed.da_file"), key: "Ctrl+Maiusc+I", run: () => pageCmd("insert") },
        { icon: "replace", label: tr("pdfed.sostituisci_pagine"), run: () => pageCmd("replace") },
        { icon: "duplicate", label: tr("pdfed.duplica_pagina"), run: () => pageCmd("duplicate") },
      ]),
      ib("rotateCw", tr("pdfed.ruota_pagine") + " (Ctrl+Maiusc+R)", () => pageCmd("rotate")),
      tb("crop", undefined, "crop", tr("pdfed.ritaglia_pagine") + " (C)"),
      menuBtn("more", tr("pdfed.altri_comandi_pagine"), () => [
        { icon: "extract", label: tr("pdfed.estrai_pagine"), key: "Ctrl+Maiusc+E", run: () => pageCmd("extract") },
        { icon: "trash", label: tr("pdfed.elimina_pagine"), key: "Ctrl+Maiusc+D", run: () => pageCmd("delete") },
        { icon: "rotateCcw", label: tr("pdfed.ruota_antiorario"), run: () => pageCmd("rotateCcw") },
        { icon: "crop", label: tr("pdfed.ritaglia_margini"), run: () => pageCmd("cropMargins") },
        { sep: true },
        { icon: "split", label: tr("pdfed.dividi_documento"), run: () => pageCmd("split") },
        { icon: "merge", label: tr("pdfed.unisci_file"), run: () => pageCmd("merge") },
        { icon: "images", label: tr("pdfed.esporta_immagini"), run: () => docCmd("images") },
      ])),
    protect: group(tr("pdfed.g_proteggi"),
      tb("redact", undefined, "redact", tr("pdfed.segna_area_oscurare") + " (Y)"),
      ib("redactSearch", tr("pdfed.oscura_testo_cercato"), () => docCmd("redactSearch")),
      ib("sign", tr("pdfed.firma_digitale"), () => docCmd("sign")),
      menuBtn("more", tr("pdfed.altri_comandi_proteggi"), () => [
        { icon: "redactApply", label: tr("pdfed.applica_oscuramenti"), run: () => docCmd("redactApply") },
        { icon: "whiteout", label: tr("pdfed.t_bianchetto"), run: () => E.setMode("whiteout") },
        { sep: true },
        { icon: "lock", label: tr("pdfed.proteggi_password"), run: () => docCmd("protect") },
        { icon: "unlock", label: tr("pdfed.togli_password"), run: () => docCmd("unlock") },
        { icon: "shield", label: tr("pdfed.rimuovi_info_nascoste"), run: () => docCmd("sanitize") },
        { icon: "flatten", label: tr("pdfed.appiattisci"), run: () => docCmd("flatten") },
      ])),
    doc: group(tr("pdfed.g_documento"), ib("headerFooter", tr("pdfed.intestazione_pie"), () => docCmd("headerFooter")), ib("watermark", tr("pdfed.filigrana"), () => docCmd("watermark")),
      ib("bates", tr("pdfed.numerazione_bates"), () => docCmd("bates")), ib("ocr", tr("pdfed.ocr"), () => docCmd("ocr")),
      menuBtn("more", tr("pdfed.altri_comandi_documento"), () => [
        { icon: "background", label: tr("pdfed.sfondo"), run: () => docCmd("background") },
        { icon: "optimize", label: tr("pdfed.ottimizza"), run: () => docCmd("optimize") },
        { icon: "compare", label: tr("pdfed.confronta"), run: () => docCmd("compare") },
        { sep: true },
        { icon: "props", label: tr("pdfed.proprieta_documento"), key: "Ctrl+D", run: () => docCmd("props") },
        { icon: "bookmark", label: tr("pdfed.segnalibri"), run: () => docCmd("toc") },
        { icon: "comments", label: tr("pdfed.elenco_commenti"), run: () => E.showComments() },
        { sep: true },
        { icon: "word", label: tr("pdfed.converti_word"), run: () => docCmd("word") },
        { icon: "images", label: tr("pdfed.esporta_immagini"), run: () => docCmd("images") },
      ])),
  };
  const undoB = ib("undo", "", () => E.undoLast()), redoB = ib("redo", "", () => E.redoLast());
  const panelB = ib("panel", tr("pdfed.pannello_proprieta"), () => { E.panelHidden = !E.panelHidden; E.renderPanel(); syncState(); });
  const tail = el("div", { class: "pe-tail" }, undoB, redoB, el("span", { class: "pe-sep" }), panelB);
  row.push(nav, G.sel, G.edit, G.comment, G.form, G.pages, G.protect, G.doc, tail);

  function syncState() {
    for (const [id, list] of Object.entries(btns)) for (const b of list) {
      const on = E.mode === id || (b.dataset.tool && b.dataset.tool === E.mode);
      b.classList.toggle("on", on);
    }
    for (const list of Object.values(btns)) for (const b of list) b._sync?.();
    for (const list of Object.values(btns)) for (const b of list) if (b._paint && b.dataset.tool === E.mode) b._paint();
    undoB.disabled = !E.undo.length;
    redoB.disabled = !E.redo.length;
    undoB.title = E.undo.length ? tr("pdfed.annulla_0", E.undo[E.undo.length - 1].label) + " (Ctrl+Z)" : tr("pdfed.annulla_niente");
    redoB.title = E.redo.length ? tr("pdfed.ripeti_0", E.redo[E.redo.length - 1].label) + " (Ctrl+Y)" : tr("pdfed.ripeti_niente");
    panelB.classList.toggle("on", !E.panel.hidden);
    syncNav();
  }
  E.listeners.add(syncState);
  const hookNav = () => {
    const a = app();
    if (!a?.eventBus) return;
    a.eventBus.on("pagechanging", syncNav);
    a.eventBus.on("scalechanging", syncNav);
    a.eventBus.on("pagesinit", syncNav);
    a.eventBus.on("updatefindmatchescount", e => { if (search) search.count.textContent = e.matchesCount?.total ? `${fmtNum(e.matchesCount.current)} / ${fmtNum(e.matchesCount.total)}` : ""; });
    a.eventBus.on("updatefindcontrolstate", e => { if (search) { search.count.textContent = e.matchesCount?.total ? `${fmtNum(e.matchesCount.current)} / ${fmtNum(e.matchesCount.total)}` : (e.state === 1 && search.input.value ? tr("pdfed.nessun_risultato") : ""); } });
    syncNav();
  };
  return { row, syncState, hookNav, openMenu, toast };
}
