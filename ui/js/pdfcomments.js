// Editor PDF: scheda Commenti del pannello (come l'elenco commenti di Acrobat). Tutti i commenti del documento per
// pagina, con ricerca, filtri (tipo, autore, stato), ordinamento, modifica del testo, risposte, stato di revisione
// (Accettato, Rifiutato, Annullato, Completato: risposte /State del modello Review), eliminazione ed esportazione CSV.
// Clic su un commento = va alla pagina e lo evidenzia.
import { t as tr, fmtNum } from "./i18n.js";
import { api, el, pickSavePath, saveBytes, toast, dirName } from "./core.js";
import { pdfIcon } from "./pdfedicons.js";
import { cssColor } from "./colorpick.js";
import { pdfDate } from "./pdfedpanel.js";

const TYPES = { Text: ["note", "pdfed.ct_nota"], Highlight: ["highlight", "pdfed.ct_evidenziato"], Underline: ["underline", "pdfed.ct_sottolineato"], StrikeOut: ["strikeout", "pdfed.ct_barrato"],
  Squiggly: ["squiggly", "pdfed.ct_ondulato"], FreeText: ["freetext", "pdfed.ct_casella"], Square: ["rect", "pdfed.ct_rettangolo"], Circle: ["ellipse", "pdfed.ct_ellisse"],
  Line: ["line", "pdfed.ct_linea"], Polygon: ["polygon", "pdfed.ct_poligono"], Cloud: ["cloud", "pdfed.f_nuvola"], PolyLine: ["polygon", "pdfed.ct_polilinea"], Ink: ["pen", "pdfed.ct_penna"],
  Stamp: ["stamp", "pdfed.ct_timbro"], Redact: ["redact", "pdfed.ct_oscuramento"], FileAttachment: ["link", "pdfed.ct_allegato"], Caret: ["addText", "pdfed.ct_inserimento"] };
const STATES = ["None", "Accepted", "Rejected", "Cancelled", "Completed"];
const ui = { q: "", type: "", author: "", state: "", sort: "page" };
let cache = { file: null, list: null };

const typeName = t => tr(TYPES[t]?.[1] || "pdfed.ct_altro");
const stateName = s => tr("pdfed.st_" + (s || "None").toLowerCase());

export async function renderComments(E, body) {
  body.innerHTML = "";
  body.classList.add("pe-cmts");
  const author = el("input", { type: "text", class: "pe-in", value: E.author, placeholder: tr("pdfed.autore_vuoto"), title: tr("pdfed.autore_commenti") });
  author.addEventListener("change", () => (E.author = author.value));
  author.addEventListener("keydown", e => e.stopPropagation());
  const q = el("input", { type: "search", class: "pe-in", value: ui.q, placeholder: tr("pdfed.cerca_commenti") });
  q.addEventListener("keydown", e => e.stopPropagation());
  const list = el("div", { class: "pe-clist" });
  body.append(el("div", { class: "pe-ctop" }, el("label", { class: "pe-cauth" }, el("span", { html: pdfIcon("user", 15) }), author), q), list);
  let all;
  try {
    const file = E.file();
    if (cache.file !== file) { cache = { file, list: (await api("pdf_annots", { path: file })).commenti }; }
    all = cache.list;
  } catch (e) { list.append(el("p", { class: "pe-hint" }, e.message)); return; }
  const authors = [...new Set(all.map(c => c.author).filter(Boolean))];
  const types = [...new Set(all.map(c => c.type))];
  const filt = (val, opts, fn) => { const s = el("select", { class: "pe-in" }, ...opts.map(([v, l]) => el("option", { value: v, selected: v === val || undefined }, l))); s.addEventListener("change", () => { fn(s.value); paint(); }); return s; };
  const bar = el("div", { class: "pe-cfilt" },
    filt(ui.type, [["", tr("pdfed.tutti_tipi")], ...types.map(t => [t, typeName(t)])], v => (ui.type = v)),
    filt(ui.author, [["", tr("pdfed.tutti_autori")], ...authors.map(a => [a, a])], v => (ui.author = v)),
    filt(ui.state, [["", tr("pdfed.tutti_stati")], ...STATES.map(s => [s, stateName(s)])], v => (ui.state = v)),
    filt(ui.sort, [["page", tr("pdfed.ordina_pagina")], ["date", tr("pdfed.ordina_data")], ["author", tr("pdfed.ordina_autore")], ["type", tr("pdfed.ordina_tipo")]], v => (ui.sort = v)),
    el("button", { type: "button", class: "pe-ib", title: tr("pdfed.esporta_commenti"), html: pdfIcon("export", 16), onclick: () => exportCsv(E, all) }));
  body.insertBefore(bar, list);
  q.addEventListener("input", () => { ui.q = q.value; paint(); });
  const upd = async (c, props, label) => { cache.file = null; await E.ops([{ kind: "annot_update", page: c.page, xref: c.xref, props }], label || tr("pdfed.u_commento")); };
  function paint() {
    list.innerHTML = "";
    const needle = ui.q.trim().toLowerCase();
    let items = all.filter(c => (!ui.type || c.type === ui.type) && (!ui.author || c.author === ui.author) && (!ui.state || (c.state || "None") === ui.state)
      && (!needle || [c.contents, c.author, c.quote, typeName(c.type), ...c.replies.map(r => r.contents)].join(" ").toLowerCase().includes(needle)));
    const key = { page: c => c.page * 1e6 - c.box[3], date: c => -(parseInt((c.date || "").replace(/\D/g, "").slice(0, 14), 10) || 0), author: c => c.author || "~", type: c => typeName(c.type) }[ui.sort];
    items = items.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    list.append(el("div", { class: "pe-ccount" }, tr("pdfed.n_commenti", fmtNum(items.length), fmtNum(all.length))));
    if (!items.length) { list.append(el("p", { class: "pe-hint" }, all.length ? tr("pdfed.nessun_commento_filtro") : tr("pdfed.nessun_commento"))); return; }
    let lastPage = -1;
    for (const c of items) {
      if (ui.sort === "page" && c.page !== lastPage) { lastPage = c.page; list.append(el("div", { class: "pe-cpage" }, tr("pdfed.pagina_0", c.page + 1))); }
      list.append(card(c));
    }
  }
  function card(c) {
    const [icon] = TYPES[c.type] || ["comments"];
    const textEl = el("div", { class: "pe-ctext" + (c.contents ? "" : " empty") }, c.contents || tr("pdfed.aggiungi_nota"));
    const edit = ev => {
      ev.stopPropagation();
      const ta = el("textarea", { class: "pe-in", rows: 3 }, c.contents || "");
      textEl.replaceWith(ta);
      ta.focus();
      ta.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") ta.replaceWith(textEl); if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ta.blur(); });
      ta.addEventListener("blur", () => { if (ta.value !== (c.contents || "")) upd(c, { contents: ta.value }); else ta.replaceWith(textEl); });
    };
    textEl.addEventListener("click", edit);
    const replies = el("div", { class: "pe-creplies" }, ...c.replies.map(r => el("div", { class: "pe-creply" },
      el("div", { class: "pe-cmeta" }, el("b", {}, r.author || tr("pdfed.anonimo")), el("span", {}, pdfDate(r.date))), el("div", {}, r.contents))));
    const replyBox = el("div", { class: "pe-creplyin", hidden: true });
    const showReply = ev => {
      ev.stopPropagation();
      replyBox.hidden = false;
      replyBox.innerHTML = "";
      const ta = el("textarea", { class: "pe-in", rows: 2, placeholder: tr("pdfed.scrivi_risposta") });
      ta.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send(); if (e.key === "Escape") replyBox.hidden = true; });
      const send = async () => { if (!ta.value.trim()) return; cache.file = null; await E.ops([{ kind: "annot_reply", page: c.page, xref: c.xref, text: ta.value.trim(), author: E.author }], tr("pdfed.u_risposta")); };
      replyBox.append(ta, el("div", { class: "pe-btnrow" }, el("button", { type: "button", class: "pe-btn primary", onclick: send }, tr("pdfed.rispondi")),
        el("button", { type: "button", class: "pe-btn", onclick: () => (replyBox.hidden = true) }, tr("common.annulla"))));
      ta.focus();
    };
    const stateSel = el("select", { class: "pe-in pe-cstate", title: tr("pdfed.stato") }, ...STATES.map(s => el("option", { value: s, selected: (c.state || "None") === s || undefined }, stateName(s))));
    stateSel.addEventListener("click", e => e.stopPropagation());
    stateSel.addEventListener("change", async () => { cache.file = null; await E.ops([{ kind: "annot_state", page: c.page, xref: c.xref, state: stateSel.value, author: E.author }], tr("pdfed.u_stato")); });
    const node = el("div", { class: "pe-card" + (c.state && c.state !== "None" ? " st-" + c.state.toLowerCase() : ""), tabindex: 0 },
      el("div", { class: "pe-chead" }, el("span", { class: "pe-cico", style: { color: c.color ? cssColor(c.color) : "" }, html: pdfIcon(icon, 16) }),
        el("div", { class: "pe-cmeta" }, el("b", {}, c.author || tr("pdfed.anonimo")), el("span", {}, `${typeName(c.type)} · ${pdfDate(c.date)}`)),
        el("button", { type: "button", class: "pe-ib", title: tr("pdfed.rispondi"), html: pdfIcon("reply", 15), onclick: showReply }),
        el("button", { type: "button", class: "pe-ib", title: tr("common.elimina"), html: pdfIcon("trash", 15), onclick: async ev => { ev.stopPropagation(); cache.file = null; await E.ops([{ kind: "annot_delete", page: c.page, xref: c.xref }], tr("pdfed.u_elimina_commento")); } })),
      c.quote ? el("blockquote", { class: "pe-cquote" }, c.quote) : null,
      textEl, replies, replyBox,
      el("div", { class: "pe-cfoot" }, stateSel));
    node.addEventListener("click", () => { list.querySelectorAll(".pe-card.cur").forEach(n => n.classList.remove("cur")); node.classList.add("cur"); E.flash(c.page, c.box); });
    return node;
  }
  paint();
}

async function exportCsv(E, all) {
  const out = await pickSavePath(E.ctx.name.replace(/\.pdf$/i, "") + "_commenti.csv", dirName(E.ctx.path));
  if (!out) return;
  const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [[tr("pdfed.pagina"), tr("pdfed.tipo"), tr("pdfed.autore"), tr("pdfed.data"), tr("pdfed.stato"), tr("pdfed.testo"), tr("pdfed.testo_segnato"), tr("pdfed.risposte")]];
  for (const c of all) rows.push([c.page + 1, typeName(c.type), c.author, pdfDate(c.date), stateName(c.state), c.contents, c.quote || "", c.replies.map(r => `${r.author}: ${r.contents}`).join(" | ")]);
  const csv = "﻿" + rows.map(r => r.map(esc).join(";")).join("\r\n");
  try { await saveBytes(out, new TextEncoder().encode(csv)); toast(tr("pdfed.commenti_esportati_0", out)); } catch (e) { toast(e.message, true); }
}
