// Editor PDF: pannello a destra (come il pannello Formato di Acrobat). Due schede: Proprieta' (contestuale: opzioni
// dello strumento attivo oppure dell'oggetto selezionato, sezioni richiudibili) e Commenti (pdfcomments.js).
// Le modifiche discrete (colore, carattere, spessore...) si applicano subito; quelle con anteprima (immagini) con Applica.
import { t as tr, fmtNum } from "./i18n.js";
import { api, el, pickSavePath, toast, dirName } from "./core.js";
import { pdfIcon } from "./pdfedicons.js";
import { colorButton } from "./colorpick.js";
import { CSHAPES, FIELDS, FONTS, MM, SHAPES, STAMPS, TOOLS, cssFont } from "./pdfeditor.js";

const open = {}; // sezioni aperte/chiuse (ricordate durante la sessione)
let tab = "props";

export function attachPanel(E) {
  E.renderPanel = () => render(E);
  E.showComments = () => { tab = "cmt"; E.panelHidden = false; render(E); E.changed(); };
  E.showProps = () => { tab = "props"; render(E); };
}

// ---------------------------------------------------------------- mattoni
const sec = (id, title, ...kids) => {
  const isOpen = open[id] !== false;
  const body = el("div", { class: "pe-sbody" }, ...kids);
  const head = el("button", { type: "button", class: "pe-shead", "aria-expanded": String(isOpen) }, el("span", { html: pdfIcon("chev", 12) }), title);
  const s = el("section", { class: "pe-sec" + (isOpen ? "" : " closed") }, head, body);
  head.addEventListener("click", () => { open[id] = s.classList.toggle("closed") ? false : true; head.setAttribute("aria-expanded", String(open[id])); });
  return s;
};
const row = (label, ...ctrl) => el("div", { class: "pe-row2" }, el("span", { class: "pe-lbl" }, label), el("div", { class: "pe-ctl" }, ...ctrl));
const hint = text => el("p", { class: "pe-hint" }, text);
function num(val, { min = -1e6, max = 1e6, step = 1, unit = "", w = 64, dec = 2 } = {}, onCommit) {
  const i = el("input", { type: "number", class: "pe-in", value: val == null ? "" : +(+val).toFixed(dec), min, max, step, style: { width: w + "px" } });
  i.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") i.blur(); });
  i.addEventListener("change", () => { if (i.value !== "") onCommit(Math.max(min, Math.min(max, +i.value))); });
  return unit ? el("span", { class: "pe-unit" }, i, el("i", {}, unit)) : i;
}
function txt(val, onCommit, { area = false, rows = 3, placeholder = "" } = {}) {
  const i = area ? el("textarea", { class: "pe-in", rows, placeholder }, val || "") : el("input", { type: "text", class: "pe-in", value: val || "", placeholder });
  i.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter" && !area) i.blur(); });
  i.addEventListener("change", () => onCommit(i.value));
  return i;
}
function sel(options, val, onChange) {
  const s = el("select", { class: "pe-in" }, ...options.map(([v, l]) => el("option", { value: v, selected: String(v) === String(val) || undefined }, l)));
  s.addEventListener("change", () => onChange(s.value));
  s.addEventListener("keydown", e => e.stopPropagation());
  return s;
}
function seg(items) { // gruppo di pulsanti icona (allineamento, grassetto...)
  return el("div", { class: "pe-seg" }, ...items.map(it => {
    const b = el("button", { type: "button", class: it.on ? "on" : "", title: it.title, "aria-label": it.title, "aria-pressed": it.on ? "true" : "false", html: it.icon ? pdfIcon(it.icon, 16) : "" }, it.text || "");
    b.addEventListener("click", it.run);
    return b;
  }));
}
function slider(val, min, max, onInput, onCommit, fmt = v => v) {
  const out = el("span", { class: "pe-sval" }, fmt(val));
  const r = el("input", { type: "range", min, max, value: val, class: "pe-range" });
  r.addEventListener("input", () => { out.textContent = fmt(+r.value); onInput?.(+r.value); });
  r.addEventListener("change", () => onCommit?.(+r.value));
  return el("div", { class: "pe-slider" }, r, out);
}
const check = (label, val, onChange) => { const i = el("input", { type: "checkbox", checked: !!val }); i.addEventListener("change", () => onChange(i.checked)); return el("label", { class: "pe-chk" }, i, label); };
const button = (icon, label, run, cls = "") => { const b = el("button", { type: "button", class: "pe-btn " + cls, title: label, html: icon ? pdfIcon(icon, 15) : "" }, el("span", {}, label)); b.addEventListener("click", run); return b; };
const iconBtn = (icon, title, run, disabled) => { const b = el("button", { type: "button", class: "pe-ib", title, "aria-label": title, disabled: disabled || undefined, html: pdfIcon(icon, 16) }); b.addEventListener("click", run); return b; };
const DASHES = () => [["", tr("pdfed.tratto_continuo")], ["dash", tr("pdfed.tratto_tratteggiato")], ["dot", tr("pdfed.tratto_punteggiato")], ["dashdot", tr("pdfed.tratto_punto_linea")]];

// colore con selettore professionale; swatches = colori della pagina corrente
function color(E, val, onCommit, { allowNone = false, title, alpha } = {}) {
  return colorButton({ value: val || "", allowNone, title, alpha, swatches: E.objCache && pageColors(E), pickFromPage: cb => E.pickFromPage(cb), onCommit });
}
function pageColors(E) {
  const d = E.objCache.get(E.curPage());
  return d && !d.then ? d.colori || [] : [];
}

// ---------------------------------------------------------------- pannello
function render(E) {
  const P = E.panel;
  const show = !E.panelHidden && (!!E.mode || tab === "cmt");
  P.hidden = !show;
  if (!show) { P.innerHTML = ""; return; }
  // non ridisegnare mentre si scrive in un campo del pannello (perderebbe il fuoco)
  const scroll = P.querySelector(".pe-pbody")?.scrollTop || 0;
  P.innerHTML = "";
  const tabs = el("div", { class: "pe-tabs", role: "tablist" },
    el("button", { type: "button", role: "tab", class: tab === "props" ? "on" : "", "aria-selected": String(tab === "props"), onclick: () => { tab = "props"; render(E); } }, tr("pdfed.proprieta")),
    el("button", { type: "button", role: "tab", class: tab === "cmt" ? "on" : "", "aria-selected": String(tab === "cmt"), onclick: () => { tab = "cmt"; render(E); } }, tr("pdfed.commenti")),
    el("span", { class: "grow" }),
    iconBtn("close", tr("common.chiudi"), () => { E.panelHidden = true; render(E); E.changed(); }));
  const body = el("div", { class: "pe-pbody" });
  P.append(tabs, body);
  if (tab === "cmt") {
    import("./pdfcomments.js").then(m => m.renderComments(E, body));
    return;
  }
  body.append(...propsFor(E));
  body.scrollTop = scroll;
}

function title(text, sub, icon) {
  return el("div", { class: "pe-ptitle" }, icon ? el("span", { class: "pe-pico", html: pdfIcon(icon, 18) }) : null, el("div", {}, el("b", {}, text), sub ? el("small", {}, sub) : null));
}

function propsFor(E) {
  const out = [];
  const o = E.opt;
  if (E.editing?.st) return textEditing(E);
  if (E.mode === "select" || E.mode === "edittext") {
    if (E.sel.length === 1) return objectProps(E, E.sel[0]);
    if (E.sel.length > 1) return multiProps(E);
    if (E.inGroup) out.push(el("div", { class: "pe-banner" }, el("span", {}, tr("pdfed.dentro_gruppo")), button("left", tr("pdfed.esci_gruppo"), () => E.exitGroup())));
    if (E.mode === "edittext") {
      out.push(title(tr("pdfed.t_modifica_testo"), null, "editText"), hint(tr("pdfed.h_modifica_testo")));
      return out;
    }
    out.push(title(tr("pdfed.t_seleziona"), null, "select"), hint(tr("pdfed.h_seleziona")));
    if (!E.inGroup) out.push(sec("filtro", tr("pdfed.oggetti_selezionabili"), el("div", { class: "pe-chips" },
      ...[["text", "pdfed.k_testi"], ["image", "pdfed.k_immagini"], ["group", "pdfed.k_disegni"], ["annot", "pdfed.k_commenti"], ["field", "pdfed.k_campi"], ["link", "pdfed.k_collegamenti"]]
        .map(([k, l]) => el("button", { type: "button", class: "pe-chip" + (o.filter[k] !== false ? " on" : ""), onclick: () => { o.filter[k] = o.filter[k] === false; E.decorateAll(); render(E); } }, tr(l))))));
    if (E.clip.length) out.push(sec("appunti", tr("pdfed.appunti"), hint(tr("pdfed.appunti_0", E.clip.length)), button("paste", tr("pdfed.incolla_qui"), () => E.paste())));
    return out;
  }
  const d = TOOLS[E.mode];
  out.push(title(tr(d?.name || "pdfed.modifica"), d?.key ? tr("pdfed.tasto_0", d.key) : null, d?.icon));
  const author = () => sec("autore", tr("pdfed.autore"), row(tr("pdfed.nome"), txt(E.author, v => (E.author = v), { placeholder: tr("pdfed.autore_vuoto") })));
  switch (E.mode) {
    case "hand": out.push(hint(tr("pdfed.h_mano"))); break;
    case "addtext":
      out.push(hint(tr("pdfed.h_aggiungi_testo")), sec("carattere", tr("pdfed.carattere"), ...fontRows(E, o, () => {})));
      break;
    case "image": out.push(hint(tr("pdfed.h_immagine"))); break;
    case "shape":
      out.push(hint(tr("pdfed.h_forme")), sec("forma", tr("pdfed.forma"), seg(Object.entries(SHAPES).map(([k, l]) => ({ icon: k === "rounded" ? "rounded" : k, title: tr(l), on: o.shape === k, run: () => { o.shape = k; E.changed(); render(E); } }))),
        row(tr("pdfed.contorno"), color(E, o.stroke, v => (o.stroke = v), { allowNone: true })), row(tr("pdfed.riempimento"), color(E, o.fill, v => (o.fill = v), { allowNone: true })),
        row(tr("pdfed.spessore"), num(o.width, { min: 0.1, max: 50, step: 0.25, unit: "pt" }, v => (o.width = v))),
        row(tr("pdfed.tratto"), sel(DASHES(), o.dash, v => (o.dash = v))),
        row(tr("pdfed.opacita"), slider(Math.round(o.opacity * 100), 5, 100, null, v => (o.opacity = v / 100), v => v + "%"))));
      break;
    case "cshape":
      out.push(hint(o.cshape === "polygon" ? tr("pdfed.h_poligono") : tr("pdfed.h_forme_commento")), sec("forma", tr("pdfed.forma"),
        seg(Object.entries(CSHAPES).map(([k, l]) => ({ icon: k, title: tr(l), on: o.cshape === k, run: () => { E.setMode("cshape", k); } }))),
        row(tr("pdfed.colore"), color(E, o.cstroke, v => (o.cstroke = v))), row(tr("pdfed.riempimento"), color(E, o.cfill, v => (o.cfill = v), { allowNone: true })),
        row(tr("pdfed.spessore"), num(o.cwidth, { min: 0.25, max: 20, step: 0.25, unit: "pt" }, v => (o.cwidth = v)))), author());
      break;
    case "note":
      out.push(hint(tr("pdfed.h_nota")), sec("nota", tr("pdfed.t_nota"), row(tr("pdfed.colore"), color(E, o.annotColor.note, v => (o.annotColor.note = v))),
        row(tr("pdfed.icona"), sel(["Comment", "Note", "Help", "Insert", "Key", "NewParagraph", "Paragraph"].map(k => [k, tr("pdfed.icona_" + k.toLowerCase())]), o.noteIcon, v => (o.noteIcon = v)))), author());
      break;
    case "pj-highlight":
      out.push(hint(tr("pdfed.h_evidenzia")), sec("evid", tr("pdfed.t_evidenzia"), row(tr("pdfed.colore"), color(E, o.hlColor, v => { o.hlColor = v; E.pjParam(32, v); })),
        row(tr("pdfed.spessore_mano"), slider(o.hlThick, 8, 24, v => { o.hlThick = v; E.pjParam(33, v); }, null, v => v + " px"))), hint(tr("pdfed.h_annotazioni_pdfjs")));
      break;
    case "underline": case "strikeout": case "squiggly":
      out.push(hint(tr("pdfed.h_segna_testo")), sec("seg", tr(d.name), row(tr("pdfed.colore"), color(E, o.annotColor[E.mode], v => (o.annotColor[E.mode] = v)))), author());
      break;
    case "freetext":
      out.push(hint(tr("pdfed.h_casella")), sec("casella", tr("pdfed.t_casella_testo"), row(tr("pdfed.dimensione"), num(o.ftSize, { min: 5, max: 96, step: 0.5, unit: "pt" }, v => (o.ftSize = v))),
        row(tr("pdfed.testo"), color(E, o.ftText, v => (o.ftText = v))), row(tr("pdfed.sfondo"), color(E, o.ftFill, v => (o.ftFill = v), { allowNone: true })),
        row(tr("pdfed.bordo"), color(E, o.annotColor.freetext, v => (o.annotColor.freetext = v), { allowNone: true }))), author());
      break;
    case "pj-ink":
      out.push(hint(tr("pdfed.h_penna")), sec("penna", tr("pdfed.t_penna"), row(tr("pdfed.colore"), color(E, o.inkColor, v => { o.inkColor = v; E.pjParam(21, v); })),
        row(tr("pdfed.spessore"), slider(o.inkThick, 1, 20, v => { o.inkThick = v; E.pjParam(22, v); }, null, v => v + " px")),
        row(tr("pdfed.opacita"), slider(Math.round(o.inkOpacity * 100), 5, 100, v => { o.inkOpacity = v / 100; E.pjParam(23, v / 100); }, null, v => v + "%"))), hint(tr("pdfed.h_annotazioni_pdfjs")));
      break;
    case "stamp": {
      const grid = el("div", { class: "pe-stamps" }, ...STAMPS.map(([k, c], i) => el("button", { type: "button", class: "pe-stamp" + (o.stamp === i ? " on" : ""), style: `--c: ${c}`, onclick: () => { o.stamp = i; render(E); } }, tr(k))));
      out.push(hint(tr("pdfed.h_timbro")), sec("timbri", tr("pdfed.timbri"), grid,
        el("div", { class: "pe-sub" }, check(tr("pdfed.timbro_personalizzato"), o.stamp === -1, v => { o.stamp = v ? -1 : 0; render(E); })),
        o.stamp === -1 ? row(tr("pdfed.testo"), txt(o.stampCustom, v => (o.stampCustom = v), { placeholder: tr("pdfed.s_approvato") })) : null,
        o.stamp === -1 ? row(tr("pdfed.colore"), color(E, o.stampColor, v => (o.stampColor = v))) : null,
        check(tr("pdfed.timbro_nome_data"), o.stampSub, v => (o.stampSub = v)),
        button("image", tr("pdfed.timbro_immagine"), async () => { const dd = await E.pickImage(); if (dd) { o.stampImage = dd; o.stamp = -2; render(E); } })), author());
      break;
    }
    case "field": {
      const t = o.field;
      out.push(hint(tr("pdfed.h_campo")), sec("tipo", tr("pdfed.tipo_campo"), seg(Object.entries(FIELDS).map(([k, [icon, l]]) => ({ icon, title: tr(l), on: t === k, run: () => E.setMode("field", k) })))),
        sec("campo", tr(FIELDS[t][1]),
          row(tr("pdfed.nome"), txt(o.fieldName, v => (o.fieldName = v), { placeholder: E.nextFieldName(t) })),
          t === "radio" ? row(tr("pdfed.gruppo_opzioni"), txt(o.radioGroup, v => (o.radioGroup = v), { placeholder: "opzioni" })) : null,
          t === "combo" || t === "list" ? row(tr("pdfed.voci"), txt(o.fieldOptions, v => (o.fieldOptions = v), { area: true, rows: 4, placeholder: tr("pdfed.opzioni_predefinite") })) : null,
          ["text", "multiline", "combo"].includes(t) ? row(tr("pdfed.dimensione"), num(o.fieldFont, { min: 0, max: 72, unit: "pt" }, v => (o.fieldFont = v)), el("small", { class: "pe-note" }, tr("pdfed.zero_auto"))) : null,
          t !== "signature" ? check(tr("pdfed.obbligatorio"), o.fieldRequired, v => (o.fieldRequired = v)) : null));
      break;
    }
    case "link": out.push(hint(tr("pdfed.h_collegamento"))); break;
    case "crop":
      out.push(hint(tr("pdfed.h_ritaglia")), sec("rit", tr("pdfed.ritaglia_pagine"), check(tr("pdfed.tutte_pagine"), o.cropAll, v => (o.cropAll = v)),
        button("crop", tr("pdfed.ritaglia_margini"), () => E.pageCmd("cropMargins")), button("rotateCcw", tr("pdfed.annulla_ritaglio"), () => E.pageCmd("cropReset"))));
      break;
    case "redact":
      out.push(hint(tr("pdfed.h_oscura")), sec("osc", tr("pdfed.t_oscura"), button("redactSearch", tr("pdfed.oscura_testo_cercato"), () => E.docCmd("redactSearch")),
        button("redactApply", tr("pdfed.applica_oscuramenti"), () => E.docCmd("redactApply"), "primary")));
      break;
    case "whiteout": out.push(hint(tr("pdfed.h_bianchetto"))); break;
    default: break;
  }
  return out;
}

// carattere, dimensione, stile, colore, allineamento, interlinea (s = oggetto con le proprieta'; changed = dopo ogni modifica)
function fontRows(E, s, changed, { embedded } = {}) {
  const fonts = [...FONTS];
  const cur = s.font || "Helvetica";
  const opts = fonts.map(f => [f, f]);
  if (embedded) opts.unshift([cur, tr("pdfed.carattere_originale_0", cur.split("+").pop())]);
  else if (!fonts.some(f => f.toLowerCase() === cur.toLowerCase())) opts.unshift([cur, cur.split("+").pop()]);
  const fsel = sel(opts, cur, v => { s.font = v; s.keep_font = v === cur && !!embedded; changed("font"); });
  fsel.style.fontFamily = cssFont(cur);
  return [
    row(tr("pdfed.carattere"), fsel),
    row(tr("pdfed.dimensione"), num(s.size, { min: 3, max: 400, step: 0.5, unit: "pt", dec: 1 }, v => { s.size = v; changed("size"); }),
      seg([{ icon: "bold", title: tr("pdfed.grassetto"), on: s.bold, run: () => { s.bold = !s.bold; s.keep_font = false; changed("bold"); } },
        { icon: "italic", title: tr("pdfed.corsivo"), on: s.italic, run: () => { s.italic = !s.italic; s.keep_font = false; changed("italic"); } }])),
    row(tr("pdfed.colore"), color(E, s.color || "#000000", v => { s.color = v || "#000000"; changed("color"); })),
  ];
}
function paraRows(s, changed) {
  return [
    row(tr("pdfed.allinea"), seg([["tAlignL", 0, "pdfed.a_sinistra"], ["tAlignC", 1, "pdfed.a_centro"], ["tAlignR", 2, "pdfed.a_destra"], ["tAlignJ", 3, "pdfed.a_giustificato"]]
      .map(([icon, v, l]) => ({ icon, title: tr(l), on: (s.align || 0) === v, run: () => { s.align = v; changed("align"); } })))),
    row(tr("pdfed.interlinea"), num(s.lineheight || 1.15, { min: 0.6, max: 4, step: 0.05, w: 58 }, v => { s.lineheight = v; changed("lineheight"); }), el("small", { class: "pe-note" }, tr("pdfed.volte_dimensione"))),
  ];
}

function textEditing(E) {
  const ed = E.editing, st = ed.st;
  const re = () => { ed.restyle(); render(E); };
  return [
    title(tr("pdfed.modifica_testo_in_corso"), tr("pdfed.ctrl_invio_applica"), "editText"),
    sec("carattere", tr("pdfed.carattere"), ...fontRows(E, st, re, { embedded: ed.o.embedded })),
    sec("paragrafo", tr("pdfed.paragrafo"), ...paraRows(st, re)),
    el("div", { class: "pe-actions" }, button("check", tr("common.applica"), () => E.commitEditing(), "primary"), button("close", tr("common.annulla"), () => E.cancelEditing())),
  ];
}

// ---------------------------------------------------------------- oggetto selezionato
function objectProps(E, s) {
  const { o, pno } = s;
  const out = [title(E.describe(o), tr("pdfed.pagina_0", pno + 1), { image: "image", text: "editText", group: "shapes", drawing: "pen", annot: "comments", field: "form", link: "link" }[o.kind])];
  if (o.kind === "text") out.push(...textProps(E, s));
  else if (o.kind === "image") out.push(...imageProps(E, s));
  else if (o.kind === "group" || o.kind === "drawing") out.push(sec("aspetto", tr("pdfed.aspetto"), ...vectorRows(E, [s])), o.kind === "group" ? button("enter", tr("pdfed.entra_gruppo"), () => E.enterGroup(pno, o)) : null);
  else if (o.kind === "annot") out.push(...annotProps(E, s));
  else if (o.kind === "field") out.push(...fieldProps(E, s));
  else if (o.kind === "link") out.push(...linkProps(E, s));
  if (o.kind !== "link") out.push(geometry(E, s));
  out.push(arrange(E));
  return out.filter(Boolean);
}

function textProps(E, s) {
  const { o, pno } = s;
  const st = { font: o.font, size: o.size, color: o.color || "#000000", bold: o.bold, italic: o.italic, align: o.align || 0, lineheight: o.lineheight || 1.15, keep_font: !!o.embedded };
  const apply = () => E.ops([{ kind: "text_block", page: pno, box: o.box, text: o.text, ...st, dir: o.dir, fit: o.lines === 1 }], tr("pdfed.u_formato_testo"), [{ pno, kind: "text", box: o.box, tol: 30 }]);
  return [
    sec("carattere", tr("pdfed.carattere"), ...fontRows(E, st, apply, { embedded: o.embedded }),
      el("small", { class: "pe-note" }, o.embedded ? tr("pdfed.carattere_incorporato_si") : tr("pdfed.carattere_incorporato_no"))),
    sec("paragrafo", tr("pdfed.paragrafo"), ...paraRows(st, apply)),
    el("div", { class: "pe-actions" }, button("editText", tr("pdfed.modifica_testo_btn"), () => E.editTextInline(s.d, o, pno, s.vp))),
  ];
}

function vectorRows(E, list) {
  const o = list[0].o;
  const apply = (style, label) => E.ops(list.map(s => (s.o.kind === "group" ? { kind: "draw_edit", page: s.pno, box: s.o.box, style }
    : { kind: "draw_edit", page: s.pno, box: E.inGroup?.box || s.o.box, targets: [s.o.seqno], style })), label || tr("pdfed.u_aspetto"), list.map(s => ({ pno: s.pno, kind: s.o.kind, box: s.o.box })));
  return [
    row(tr("pdfed.contorno"), color(E, o.stroke, v => apply({ stroke: v }), { allowNone: true })),
    row(tr("pdfed.riempimento"), color(E, o.fill, v => apply({ fill: v }), { allowNone: true })),
    row(tr("pdfed.spessore"), num(o.width || 1, { min: 0, max: 50, step: 0.25, unit: "pt" }, v => apply({ width: v }))),
    row(tr("pdfed.tratto"), sel(DASHES(), o.dash || "", v => apply({ dash: v }))),
    row(tr("pdfed.opacita"), slider(Math.round((o.opacity ?? 1) * 100), 0, 100, null, v => apply({ opacity: v / 100 }), v => v + "%")),
  ];
}

function imageProps(E, s) {
  const { o, pno } = s;
  const st = { transparent: [], tol: 12, opacity: 1, rotate: 0, flip_h: false, flip_v: false, gray: false, invert: false, brightness: 0, contrast: 0, saturation: 0, crop: null };
  const dirty = () => st.transparent.length || st.opacity < 1 || st.gray || st.invert || st.brightness || st.contrast || st.saturation || st.flip_h || st.flip_v || st.rotate || st.crop;
  const prev = () => (dirty() ? E.showPreview(s, st) : E.clearPreview());
  const chips = el("div", { class: "pe-cchips" });
  const paintChips = () => {
    chips.innerHTML = "";
    st.transparent.forEach((c, i) => chips.append(el("span", { class: "pe-cchip" }, el("b", { style: { background: c } }), c.toUpperCase(),
      el("button", { type: "button", title: tr("pdfed.togli"), onclick: () => { st.transparent.splice(i, 1); paintChips(); prev(); } }, "×"))));
    if (!st.transparent.length) chips.append(el("span", { class: "pe-note" }, tr("pdfed.nessun_colore_trasparente")));
  };
  const add = c => { if (c && !st.transparent.includes(c)) st.transparent.push(c); paintChips(); prev(); };
  paintChips();
  const w = o.box[2] - o.box[0];
  const dpi = o.px?.[0] && w ? Math.round(o.px[0] / (w / 72)) : null;
  const apply = () => (dirty() ? E.ops([{ kind: "image_edit", page: pno, xref: o.xref, box: o.box, ...st }], tr("pdfed.u_immagine_modificata"), [{ pno, kind: "image", box: o.box, tol: Math.max(w, o.box[3] - o.box[1]) }]) : toast(tr("pdfed.nessuna_modifica_impostata")));
  const exportImg = async () => {
    const out = await pickSavePath(`${E.ctx.name.replace(/\.pdf$/i, "")}_immagine_${pno + 1}.png`, dirName(E.ctx.path));
    if (!out) return;
    try { await api("pdf_image_export", { path: E.file() }, { json: { page: pno, xref: o.xref, box: o.box, out } }); toast(tr("pdfed.immagine_salvata_0", out)); } catch (e) { toast(e.message, true); }
  };
  return [
    el("div", { class: "pe-info" }, el("span", {}, `${fmtNum(o.px?.[0] || 0)} × ${fmtNum(o.px?.[1] || 0)} px`), dpi ? el("span", {}, `${dpi} dpi`) : null, o.cs ? el("span", {}, o.cs) : null,
      o.shared ? el("span", { class: "warn", title: tr("pdfed.immagine_condivisa_spiega") }, tr("pdfed.immagine_condivisa")) : null),
    sec("img", tr("pdfed.immagine"), el("div", { class: "pe-btnrow" },
      button("replace", tr("pdfed.sostituisci"), async () => { const data = await E.pickImage(); if (data) E.ops([{ kind: "image_replace", page: pno, xref: o.xref, box: o.box, data }], tr("pdfed.u_sostituisci_immagine"), [{ pno, kind: "image", box: o.box, tol: 20 }]); }),
      button("export", tr("pdfed.esporta"), exportImg),
      button("crop", tr("pdfed.ritaglia"), async () => { toast(tr("pdfed.ritaglio_spiega")); const c = await E.cropImage(s); if (c && c.some(v => v > 0.002)) { st.crop = c; prev(); } })),
      el("div", { class: "pe-btnrow" },
        iconBtn("rotateCcw", tr("pdfed.ruota_sx"), () => { st.rotate = (st.rotate + 270) % 360; prev(); }),
        iconBtn("rotateCw", tr("pdfed.ruota_dx"), () => { st.rotate = (st.rotate + 90) % 360; prev(); }),
        iconBtn("flipH", tr("pdfed.rifletti_o"), () => { st.flip_h = !st.flip_h; prev(); }),
        iconBtn("flipV", tr("pdfed.rifletti_v"), () => { st.flip_v = !st.flip_v; prev(); }))),
    sec("regola", tr("pdfed.regolazioni"),
      row(tr("pdfed.luminosita"), slider(0, -100, 100, v => { st.brightness = v; prev(); }, null, v => (v > 0 ? "+" : "") + v)),
      row(tr("pdfed.contrasto"), slider(0, -100, 100, v => { st.contrast = v; prev(); }, null, v => (v > 0 ? "+" : "") + v)),
      row(tr("pdfed.saturazione"), slider(0, -100, 100, v => { st.saturation = v; prev(); }, null, v => (v > 0 ? "+" : "") + v)),
      el("div", { class: "pe-btnrow" }, check(tr("pdfed.bianco_nero"), false, v => { st.gray = v; prev(); }), check(tr("pdfed.inverti"), false, v => { st.invert = v; prev(); }))),
    sec("trasp", tr("pdfed.trasparenza"),
      row(tr("pdfed.opacita"), slider(100, 0, 100, v => { st.opacity = v / 100; prev(); }, null, v => v + "%")),
      el("div", { class: "pe-lbl2" }, tr("pdfed.colori_trasparenti")), chips,
      el("div", { class: "pe-btnrow" }, button("eyedrop", tr("pdfed.preleva_colore"), () => E.pickFromPage(c => c && add(c))),
        color(E, "", v => v && add(v), { title: tr("pdfed.aggiungi_colore") })),
      row(tr("pdfed.tolleranza"), slider(12, 0, 60, v => { st.tol = v; prev(); }, null, v => v + "%")),
      hint(tr("pdfed.anteprima_scacchi"))),
    el("div", { class: "pe-actions" }, button("check", tr("common.applica"), apply, "primary"), button("rotateCcw", tr("pdfed.ripristina"), () => { E.clearPreview(); render(E); })),
  ];
}

function annotProps(E, s) {
  const { o, pno } = s;
  const upd = (props, label) => E.ops([{ kind: "annot_update", page: pno, xref: o.xref, props }], label || tr("pdfed.u_commento"), [{ pno, kind: "annot", box: o.box }]);
  const hasFill = ["Square", "Circle", "FreeText", "Polygon", "Line"].includes(o.type);
  return [
    sec("cmt", tr("pdfed.commento"),
      row(tr("pdfed.autore"), txt(o.author, v => upd({ author: v }))),
      row(tr("pdfed.testo"), txt(o.contents, v => upd({ contents: v }), { area: true, rows: 4 })),
      o.date ? row(tr("pdfed.data"), el("span", { class: "pe-note" }, pdfDate(o.date))) : null,
      button("comments", tr("pdfed.apri_elenco_commenti"), () => E.showComments())),
    sec("aspetto", tr("pdfed.aspetto"),
      row(tr("pdfed.colore"), color(E, o.stroke, v => upd({ stroke: v }), { allowNone: o.type !== "Text" })),
      hasFill ? row(tr("pdfed.riempimento"), color(E, o.fill, v => upd({ fill: v }), { allowNone: true })) : null,
      ["Square", "Circle", "Line", "Polygon", "PolyLine", "Ink", "FreeText"].includes(o.type) ? row(tr("pdfed.spessore"), num(o.width || 1, { min: 0, max: 20, step: 0.25, unit: "pt" }, v => upd({ width: v }))) : null,
      o.type === "Text" ? row(tr("pdfed.icona"), sel(["Comment", "Note", "Help", "Insert", "Key", "NewParagraph", "Paragraph"].map(k => [k, tr("pdfed.icona_" + k.toLowerCase())]), "", v => upd({ icon: v }))) : null,
      row(tr("pdfed.opacita"), slider(Math.round((o.opacity ?? 1) * 100), 5, 100, null, v => upd({ opacity: v / 100 }), v => v + "%"))),
  ];
}
export function pdfDate(d) {
  const m = /D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?/.exec(d || "");
  if (!m) return d || "";
  try { return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }); } catch { return d; }
}

function fieldProps(E, s) {
  const { o, pno } = s;
  const p = {};
  const choice = o.type === "combo" || o.type === "list";
  const opts = choice ? txt((o.options || []).join("\n"), v => (p.options = v.split(/\r?\n/).map(x => x.trim()).filter(Boolean)), { area: true, rows: 4 }) : null;
  return [
    sec("campo", tr("pdfed.campo"),
      row(tr("pdfed.nome"), txt(o.name, v => (p.name = v))),
      row(tr("pdfed.descrizione"), txt(o.tooltip, v => (p.tooltip = v), { placeholder: tr("pdfed.descrizione_aiuto") })),
      !["check", "radio", "signature"].includes(o.type) ? row(tr("pdfed.valore"), txt(o.value, v => (p.value = v))) : null,
      choice ? row(tr("pdfed.voci"), opts) : null,
      o.type === "text" ? row(tr("pdfed.max_caratteri"), num(o.maxlen || 0, { min: 0, max: 10000, dec: 0 }, v => (p.maxlen = v)), el("small", { class: "pe-note" }, tr("pdfed.zero_nessun_limite"))) : null,
      ["text", "combo"].includes(o.type) ? row(tr("pdfed.dimensione"), num(o.fontsize || 0, { min: 0, max: 72, unit: "pt" }, v => (p.fontsize = v)), el("small", { class: "pe-note" }, tr("pdfed.zero_auto"))) : null,
      el("div", { class: "pe-chkcol" },
        o.type !== "signature" ? check(tr("pdfed.obbligatorio"), o.required, v => (p.required = v)) : null,
        check(tr("pdfed.sola_lettura"), o.readonly, v => (p.readonly = v)),
        o.type === "text" ? check(tr("pdfed.piu_righe"), o.multiline, v => (p.multiline = v)) : null)),
    sec("fasp", tr("pdfed.aspetto"),
      row(tr("pdfed.bordo"), color(E, o.border || "", v => (p.border = v), { allowNone: false })),
      row(tr("pdfed.sfondo"), color(E, o.bg || "", v => (p.bg = v), { allowNone: true })),
      !["check", "radio", "signature"].includes(o.type) ? row(tr("pdfed.testo"), color(E, o.textcolor || "#000000", v => (p.textcolor = v))) : null),
    el("div", { class: "pe-actions" }, button("check", tr("common.applica"), () => (Object.keys(p).length ? E.ops([{ kind: "field_update", page: pno, xref: o.xref, props: p }], tr("pdfed.u_campo_modificato"), [{ pno, kind: "field", box: o.box }]) : toast(tr("pdfed.nessuna_modifica_impostata"))), "primary")),
  ];
}

function linkProps(E, s) {
  const { o, pno } = s;
  let uri = o.uri, page = o.page >= 0 ? o.page + 1 : "";
  const apply = () => E.ops([{ kind: "link_delete", page: pno, box: o.box }, uri ? { kind: "link_add", page: pno, box: o.box, uri } : { kind: "link_add", page: pno, box: o.box, target: +page || 1 }], tr("pdfed.t_collegamento"), [{ pno, kind: "link", box: o.box }]);
  return [sec("link", tr("pdfed.destinazione"),
    row(tr("pdfed.indirizzo_web"), txt(uri, v => { uri = v.trim(); if (uri) page = ""; }, { placeholder: "https://" })),
    row(tr("pdfed.oppure_pagina"), num(page || "", { min: 1, max: E.pages(), dec: 0 }, v => { page = v; uri = ""; })),
    el("div", { class: "pe-actions" }, button("check", tr("common.applica"), apply, "primary"), button("trash", tr("common.elimina"), () => E.deleteSel(), "danger")))];
}

// ---- posizione e dimensioni (mm, origine in alto a sinistra della pagina come si vede) + rotazione
function geometry(E, s) {
  const { o, pno } = s;
  let r;
  try { r = E.visBox(pno, o.box); } catch { return null; }
  const mm = v => Math.round(v * MM * 10) / 10;
  const set = (k, v) => {
    const q = { ...r };
    if (k === "x") q.left = v / MM; else if (k === "y") q.top = v / MM;
    else if (k === "w") { const nw = v / MM; if (lock && q.width) q.height *= nw / q.width; q.width = nw; }
    else if (k === "h") { const nh = v / MM; if (lock && q.height) q.width *= nh / q.height; q.height = nh; }
    const to = E.fromVis(pno, q);
    E.ops(E.moveOps(pno, o, to), tr("pdfed.u_posizione"), [{ pno, kind: o.kind, box: to }]);
  };
  let lock = o.kind === "image";
  const rotatable = ["image", "group", "drawing", "text"].includes(o.kind);
  return sec("geo", tr("pdfed.posizione_dimensioni"),
    el("div", { class: "pe-geo" },
      el("label", {}, el("i", {}, "X"), num(mm(r.left), { step: 0.5, unit: "mm", w: 66, dec: 1 }, v => set("x", v))),
      el("label", {}, el("i", {}, "Y"), num(mm(r.top), { step: 0.5, unit: "mm", w: 66, dec: 1 }, v => set("y", v))),
      el("label", {}, el("i", {}, tr("pdfed.l")), num(mm(r.width), { min: 0.5, step: 0.5, unit: "mm", w: 66, dec: 1 }, v => set("w", v))),
      el("label", {}, el("i", {}, tr("pdfed.a")), num(mm(r.height), { min: 0.5, step: 0.5, unit: "mm", w: 66, dec: 1 }, v => set("h", v)))),
    check(tr("pdfed.mantieni_proporzioni"), lock, v => (lock = v)),
    rotatable ? row(tr("pdfed.rotazione"), num(0, { min: -360, max: 360, step: 1, unit: "°", w: 58, dec: 1 }, v => v && E.rotateSel(v)),
      seg([{ icon: "rotateCcw", title: tr("pdfed.ruota_sx"), run: () => E.rotateSel(-90) }, { icon: "rotateCw", title: tr("pdfed.ruota_dx"), run: () => E.rotateSel(90) }])) : null);
}

// ---- disponi: allinea, distribuisci, ordine, gruppi, appunti
function arrange(E) {
  const n = E.sel.length;
  return sec("disponi", tr("pdfed.disponi"),
    el("div", { class: "pe-arr" },
      iconBtn("alignL", tr("pdfed.allinea_sx"), () => E.align("l")), iconBtn("alignCH", tr("pdfed.allinea_ch"), () => E.align("ch")), iconBtn("alignR", tr("pdfed.allinea_dx"), () => E.align("r")),
      iconBtn("alignT", tr("pdfed.allinea_alto"), () => E.align("t")), iconBtn("alignCV", tr("pdfed.allinea_cv"), () => E.align("cv")), iconBtn("alignB", tr("pdfed.allinea_basso"), () => E.align("b")),
      iconBtn("distH", tr("pdfed.distribuisci_o"), () => E.distribute("h"), n < 3), iconBtn("distV", tr("pdfed.distribuisci_v"), () => E.distribute("v"), n < 3)),
    el("div", { class: "pe-arr" },
      iconBtn("front", tr("pdfed.primo_piano") + " (Ctrl+Maiusc+])", () => E.order("front")), iconBtn("back", tr("pdfed.in_fondo") + " (Ctrl+Maiusc+[)", () => E.order("back")),
      iconBtn("group", tr("pdfed.raggruppa") + " (Ctrl+G)", () => E.groupSel(), n < 2), iconBtn("ungroup", tr("pdfed.separa") + " (Ctrl+Maiusc+G)", () => E.ungroupSel()),
      iconBtn("copy", tr("pdfed.copia") + " (Ctrl+C)", () => E.copySel()), iconBtn("duplicate", tr("pdfed.duplica"), () => E.duplicate()),
      iconBtn("trash", tr("common.elimina") + " (Canc)", () => E.deleteSel())),
    n === 1 ? hint(tr("pdfed.allinea_pagina")) : null);
}

function multiProps(E) {
  const allVec = E.sel.every(s => s.o.kind === "group" || s.o.kind === "drawing");
  return [title(tr("pdfed.n_oggetti_selezionati", E.sel.length), E.sel.some(s => E.inGroupOf(s)) ? tr("pdfed.gruppo") : null, "group"),
    allVec ? sec("aspetto", tr("pdfed.aspetto"), ...vectorRows(E, E.sel)) : null,
    E.sel.every(s => ["image", "group", "drawing", "text"].includes(s.o.kind)) ? sec("rot", tr("pdfed.rotazione"), seg([{ icon: "rotateCcw", title: tr("pdfed.ruota_sx"), run: () => E.rotateSel(-90) }, { icon: "rotateCw", title: tr("pdfed.ruota_dx"), run: () => E.rotateSel(90) }])) : null,
    arrange(E)].filter(Boolean);
}
