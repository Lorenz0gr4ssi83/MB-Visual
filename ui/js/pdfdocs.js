// Editor PDF: comandi di pagine e documento con le loro finestre (intestazioni e pie' di pagina, filigrana, sfondo,
// Bates, ottimizzazione, OCR, confronto, proprieta', segnalibri, protezione, oscuramento da ricerca, firma).
// Le modifiche al documento passano dalla coda dell'editor (copia di lavoro, Annulla/Ripeti); le esportazioni e le
// conversioni (estrai, dividi, ottimizza, OCR, Word...) creano un file nuovo scelto dall'utente e lo aprono.
import { t as tr, LOCALE } from "./i18n.js";
import { api, baseName, confirmBox, dirName, el, modal, pickFiles, pickFolder, pickSavePath, toast, waitJob } from "./core.js";
import { pdfIcon } from "./pdfedicons.js";
import { colorButton, cssColor } from "./colorpick.js";
import { FONTS, cssFont } from "./pdfeditor.js";

// ---------------------------------------------------------------- mattoni delle finestre
const field = (label, ctrl, wide) => el("label", { class: "pe-f" + (wide ? " wide" : "") }, el("span", {}, label), ctrl);
const input = (value = "", attrs = {}) => { const i = el("input", { type: "text", class: "pe-in", value, ...attrs }); i.addEventListener("keydown", e => e.stopPropagation()); return i; };
const numIn = (value, attrs = {}) => input(value, { type: "number", ...attrs });
const select = (opts, val) => el("select", { class: "pe-in" }, ...opts.map(([v, l]) => el("option", { value: v, selected: String(v) === String(val) || undefined }, l)));
const checkbox = (label, val) => { const i = el("input", { type: "checkbox", checked: !!val }); const l = el("label", { class: "pe-chk" }, i, label); l.input = i; return l; };
const grid = (...kids) => el("div", { class: "pe-fgrid" }, ...kids);
const ask = (title, body, ok = tr("common.applica"), cls = "") => modal(title, el("div", { class: "pe-dlg " + cls }, ...[].concat(body)), [{ label: tr("common.annulla"), value: false }, { label: ok, value: true, primary: true }]);

// pagine: tutte / corrente / intervallo / pari / dispari -> { pages, which }
function pagesPicker(E, def = "all") {
  const cur = E.curPage() + 1, n = E.pages();
  const s = select([["all", tr("pdfed.p_tutte_0", n)], ["cur", tr("pdfed.p_corrente_0", cur)], ["range", tr("pdfed.p_intervallo")], ["odd", tr("pdfed.p_dispari")], ["even", tr("pdfed.p_pari")]], def);
  const r = input(def === "range" ? String(cur) : "", { placeholder: tr("pdfed.esempio_pagine"), hidden: def !== "range" });
  s.addEventListener("change", () => { r.hidden = s.value !== "range"; if (!r.hidden) r.focus(); });
  const node = el("div", { class: "pe-prange" }, s, r);
  node.value = () => {
    if (s.value === "cur") return { pages: [cur - 1] };
    if (s.value === "range") return { pages: r.value.trim() || String(cur) };
    if (s.value === "odd" || s.value === "even") return { pages: "", which: s.value };
    return { pages: "" };
  };
  node.list = () => {
    const v = node.value();
    if (Array.isArray(v.pages)) return v.pages;
    const all = Array.from({ length: n }, (_, i) => i);
    if (v.which) return all.filter(i => (v.which === "odd" ? (i + 1) % 2 : (i + 1) % 2 === 0));
    if (!v.pages) return all;
    return parseSpec(v.pages, n);
  };
  return node;
}
export function parseSpec(spec, n) {
  const out = new Set();
  for (const part of String(spec).split(/[,;]+/)) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(p);
    if (m) { const a = +(m[1] || 1), b = +(m[2] || n); for (let i = a; i <= b; i++) if (i >= 1 && i <= n) out.add(i - 1); }
    else if (+p >= 1 && +p <= n) out.add(+p - 1);
  }
  return [...out].sort((a, b) => a - b);
}

// anteprima della pagina corrente (pdf.js) con uno strato per i testi di prova
async function pagePreview(E, maxW = 230, maxH = 300) {
  const wrap = el("div", { class: "pe-pv" });
  const layer = el("div", { class: "pe-pvl" });
  try {
    const page = await E.app().pdfDocument.getPage(E.curPage() + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const k = Math.min(maxW / vp1.width, maxH / vp1.height);
    const vp = page.getViewport({ scale: k * (devicePixelRatio || 1) });
    const cv = el("canvas", { width: Math.round(vp.width), height: Math.round(vp.height) });
    Object.assign(cv.style, { width: vp1.width * k + "px", height: vp1.height * k + "px" });
    await page.render({ canvasContext: cv.getContext("2d"), viewport: vp, intent: "print" }).promise;
    Object.assign(wrap.style, { width: vp1.width * k + "px", height: vp1.height * k + "px" });
    wrap.append(cv, layer);
    wrap.k = k; wrap.w = vp1.width; wrap.h = vp1.height;
  } catch { wrap.k = 0.3; wrap.w = 595; wrap.h = 842; }
  wrap.layer = layer;
  return wrap;
}

const today = () => new Date().toLocaleDateString(LOCALE);
const stem = E => E.ctx.name.replace(/\.pdf$/i, "");

export function makeCommands(E) {
  const ctx = E.ctx, dir = dirName(ctx.path);
  // operazione che crea un nuovo file (dal documento come appare ora, modifiche comprese) e lo apre
  const toNewFile = async (op, json, suggested, open = true) => {
    const out = await pickSavePath(suggested, dir);
    if (!out) return;
    try {
      const r = await api("pdf_tool", { path: await E.currentFile(), op }, { json: { ...json, out } });
      toast(tr("pdfed.creato_0", baseName(out)) + (r.dopo ? " · " + tr("pdfed.da_a_mb", (r.prima / 1048576).toFixed(2), (r.dopo / 1048576).toFixed(2)) : ""));
      if (open) ctx.openFile(out);
    } catch (e) { toast(e.message, true, 6000); }
  };

  // ---------------------------------------------------------------- pagine
  async function pageCmd(name) {
    const cur = E.curPage(), n = E.pages();
    if (name === "organize") return (await import("./pdfpages.js")).openOrganizer(E, { pageCmd, docCmd });
    if (name === "duplicate") return E.ops([{ kind: "page_duplicate", pages: [cur] }], tr("pdfed.duplica_pagina"));
    if (name === "rotateCcw") return E.ops([{ kind: "page_rotate", pages: [cur], angle: 270 }], tr("pdfed.ruota_pagine"));
    if (name === "cropReset") return E.ops([{ kind: "crop", pages: E.opt.cropAll ? "" : [cur], reset: true }], tr("pdfed.annulla_ritaglio"));
    if (name === "blank") {
      const where = select([["after", tr("pdfed.dopo_pagina_0", cur + 1)], ["before", tr("pdfed.prima_pagina_0", cur + 1)], ["end", tr("pdfed.alla_fine")], ["start", tr("pdfed.all_inizio")]], "after");
      const count = numIn(1, { min: 1, max: 500 });
      const size = select([["same", tr("pdfed.come_pagina_corrente")], ["595x842", "A4 " + tr("pdfed.verticale")], ["842x595", "A4 " + tr("pdfed.orizzontale")], ["842x1191", "A3 " + tr("pdfed.verticale")], ["1191x842", "A3 " + tr("pdfed.orizzontale")], ["612x792", "Letter"]], "same");
      if (!(await ask(tr("pdfed.inserisci_pagina_bianca"), grid(field(tr("pdfed.posizione"), where), field(tr("pdfed.numero_pagine"), count), field(tr("pdfed.formato"), size)), tr("pdfed.inserisci")))) return;
      const at = { after: cur + 1, before: cur, end: n, start: 0 }[where.value];
      return E.ops([{ kind: "page_blank", at, count: +count.value || 1, size: size.value === "same" ? undefined : size.value.split("x").map(Number) }], tr("pdfed.inserisci_pagina_bianca"));
    }
    if (name === "insert") {
      const fs = await pickFiles();
      const f = fs?.find(x => /\.pdf$/i.test(x));
      if (!f) return;
      const where = select([["after", tr("pdfed.dopo_pagina_0", cur + 1)], ["before", tr("pdfed.prima_pagina_0", cur + 1)], ["end", tr("pdfed.alla_fine")], ["start", tr("pdfed.all_inizio")]], "after");
      const pages = input("", { placeholder: tr("pdfed.tutte_vuoto") });
      if (!(await ask(tr("pdfed.inserisci_da_0", baseName(f)), grid(field(tr("pdfed.posizione"), where), field(tr("pdfed.pagine_file"), pages)), tr("pdfed.inserisci")))) return;
      return E.ops([{ kind: "page_insert_pdf", file: f, at: { after: cur + 1, before: cur, end: n, start: 0 }[where.value], from_pages: pages.value.trim() }], tr("pdfed.inserisci_pagine"));
    }
    if (name === "replace") {
      const fs = await pickFiles();
      const f = fs?.find(x => /\.pdf$/i.test(x));
      if (!f) return;
      const tgt = input(String(cur + 1)), src = input("1");
      if (!(await ask(tr("pdfed.sostituisci_pagine"), [grid(field(tr("pdfed.pagine_da_sostituire"), tgt), field(tr("pdfed.con_pagine_di_0", baseName(f)), src)), el("p", { class: "pe-hint" }, tr("pdfed.sostituisci_spiega"))], tr("pdfed.sostituisci")))) return;
      return E.ops([{ kind: "page_replace", pages: tgt.value, file: f, from_pages: src.value }], tr("pdfed.sostituisci_pagine"));
    }
    if (name === "rotate") {
      const pp = pagesPicker(E, "cur");
      const ang = select([[90, tr("pdfed.r_90_orario")], [270, tr("pdfed.r_90_antiorario")], [180, "180°"]], 90);
      if (!(await ask(tr("pdfed.ruota_pagine"), grid(field(tr("pdfed.direzione"), ang), field(tr("pdfed.pagine"), pp)), tr("pdfed.ruota")))) return;
      return E.ops([{ kind: "page_rotate", pages: pp.list(), angle: +ang.value }], tr("pdfed.ruota_pagine"));
    }
    if (name === "delete") {
      const pp = pagesPicker(E, "cur");
      if (!(await ask(tr("pdfed.elimina_pagine"), [field(tr("pdfed.pagine"), pp), el("p", { class: "pe-hint" }, tr("pdfed.elimina_spiega"))], tr("common.elimina")))) return;
      const list = pp.list();
      if (list.length >= n) return toast(tr("pdfed.non_tutte_pagine"), true);
      return E.ops([{ kind: "page_delete", pages: list }], tr("pdfed.elimina_pagine"));
    }
    if (name === "extract") {
      const pp = pagesPicker(E, "cur");
      const sep = checkbox(tr("pdfed.file_separati"), false), del = checkbox(tr("pdfed.elimina_dopo_estrazione"), false);
      if (!(await ask(tr("pdfed.estrai_pagine"), [field(tr("pdfed.pagine"), pp), sep, del], tr("pdfed.estrai")))) return;
      const list = pp.list();
      if (!list.length) return;
      const src = await E.currentFile();
      if (sep.input.checked) {
        const folder = await pickFolder();
        if (!folder) return;
        for (const p of list) await api("pdf_tool", { path: src, op: "extract" }, { json: { pages: String(p + 1), out: `${folder}\\${stem(E)}_pag${String(p + 1).padStart(3, "0")}.pdf` } });
        toast(tr("pdfed.estratte_0_in_1", list.length, folder));
      } else {
        const out = await pickSavePath(`${stem(E)}_estratto.pdf`, dir);
        if (!out) return;
        await api("pdf_tool", { path: src, op: "extract" }, { json: { pages: list.map(p => p + 1).join(","), out } });
        toast(tr("pdfed.creato_0", baseName(out)));
        ctx.openFile(out);
      }
      if (del.input.checked && list.length < n) await E.ops([{ kind: "page_delete", pages: list }], tr("pdfed.elimina_pagine"));
      return;
    }
    if (name === "cropMargins") {
      const m = ["top", "right", "bottom", "left"].map(() => numIn(10, { min: 0, max: 500, step: 0.5 }));
      const pp = pagesPicker(E, E.opt.cropAll ? "all" : "cur");
      if (!(await ask(tr("pdfed.ritaglia_margini"), [grid(field(tr("pdfed.m_alto"), m[0]), field(tr("pdfed.m_destra"), m[1]), field(tr("pdfed.m_basso"), m[2]), field(tr("pdfed.m_sinistra"), m[3])),
        field(tr("pdfed.pagine"), pp), el("p", { class: "pe-hint" }, tr("pdfed.ritaglio_spiega_mm"))], tr("pdfed.ritaglia")))) return;
      return E.ops([{ kind: "crop", pages: pp.list(), margins: m.map(x => +x.value || 0) }], tr("pdfed.u_ritaglia"));
    }
    if (name === "split") {
      const folder = await pickFolder();
      if (!folder) return;
      try { const r = await api("pdf_tool", { path: await E.currentFile(), op: "split" }, { json: { folder } }); toast(tr("pdfed.creati_0_file_in_1", r.files.length, folder)); } catch (e) { toast(e.message, true); }
      return;
    }
    if (name === "merge") {
      const others = await pickFiles();
      if (!others?.length) return;
      return toNewFile("merge", { others }, `${stem(E)}_unito.pdf`);
    }
  }

  // ---------------------------------------------------------------- documento
  async function docCmd(name, arg) {
    if (name === "headerFooter") return headerFooter();
    if (name === "watermark") return watermark();
    if (name === "background") return background();
    if (name === "bates") return bates();
    if (name === "redactSearch") return redactSearch(arg);
    if (name === "redactApply") {
      let n = 0;
      try { n = (await api("pdf_annots", { path: E.file() })).commenti.filter(c => c.type === "Redact").length; } catch { /* */ }
      if (!n) return toast(tr("pdfed.nessun_oscuramento_segnato"), true, 5000);
      const img = checkbox(tr("pdfed.osc_immagini"), true), gr = checkbox(tr("pdfed.osc_grafica"), true), meta = checkbox(tr("pdfed.osc_metadati"), false);
      if (!(await ask(tr("pdfed.applica_oscuramenti"), [el("p", {}, tr("pdfed.applica_oscuramenti_0", n)), img, gr, meta], tr("pdfed.applica")))) return;
      return E.ops([{ kind: "redact_apply", images: img.input.checked, graphics: gr.input.checked, metadata: meta.input.checked }], tr("pdfed.applica_oscuramenti"));
    }
    if (name === "props") {
      try { await E.pageData(0); } catch { /* */ }
      const f = {};
      const rows = ["title", "author", "subject", "keywords"].map(k => field({ title: tr("pdfed.titolo"), author: tr("pdfed.autore"), subject: tr("pdfed.oggetto"), keywords: tr("pdfed.parole_chiave") }[k], (f[k] = input(E.meta[k] || "")), true));
      if (await ask(tr("pdfed.proprieta_documento"), grid(...rows), tr("common.salva"))) return E.ops([{ kind: "metadata", ...Object.fromEntries(Object.entries(f).map(([k, i]) => [k, i.value])) }], tr("pdfed.proprieta_documento"));
      return;
    }
    if (name === "toc") {
      try { await E.pageData(0); } catch { /* */ }
      const ta = el("textarea", { rows: 14, class: "pe-in mono" }, E.toc.map(([l, t, p]) => "  ".repeat(l - 1) + `${t} | ${p}`).join("\n"));
      ta.addEventListener("keydown", e => e.stopPropagation());
      if (!(await ask(tr("pdfed.segnalibri"), [el("p", { class: "pe-hint" }, tr("pdfed.segnalibri_spiega")), ta], tr("common.salva")))) return;
      const items = ta.value.split(/\r?\n/).filter(s => s.trim()).map(s => { const lvl = Math.floor(s.match(/^ */)[0].length / 2) + 1; const [t, p] = s.trim().split("|").map(x => x.trim()); return [lvl, t, parseInt(p, 10) || 1]; });
      // i livelli non possono saltare (1 -> 3): si correggono
      items.forEach((it, i) => { const prev = i ? items[i - 1][0] : 0; if (it[0] > prev + 1) it[0] = prev + 1; });
      return E.ops([{ kind: "toc", items }], tr("pdfed.segnalibri"));
    }
    if (name === "flatten" || name === "flattenForms") {
      if (await confirmBox(tr("pdfed.appiattisci"), name === "flatten" ? tr("pdfed.appiattisci_spiega") : tr("pdfed.appiattisci_moduli_spiega"), tr("pdfed.appiattisci")))
        return E.ops([{ kind: "flatten", annots: name === "flatten", widgets: true }], tr("pdfed.appiattisci"));
      return;
    }
    if (name === "sanitize") {
      const m = checkbox(tr("pdfed.san_metadati"), true), a = checkbox(tr("pdfed.san_allegati"), true), j = checkbox(tr("pdfed.san_script"), true), h = checkbox(tr("pdfed.san_testo_nascosto"), true), l = checkbox(tr("pdfed.san_collegamenti"), false);
      if (!(await ask(tr("pdfed.rimuovi_info_nascoste"), [m, a, j, h, l], tr("pdfed.rimuovi")))) return;
      return E.ops([{ kind: "sanitize", metadata: m.input.checked, attachments: a.input.checked, javascript: j.input.checked, hidden_text: h.input.checked, links: l.input.checked }], tr("pdfed.rimuovi_info_nascoste"));
    }
    if (name === "optimize") {
      const q = select([["150|75", tr("pdfed.q_equilibrata")], ["110|60", tr("pdfed.q_massima")], ["220|85", tr("pdfed.q_alta")], ["300|92", tr("pdfed.q_stampa")]], "150|75");
      if (!(await ask(tr("pdfed.ottimizza"), [field(tr("pdfed.qualita_immagini"), q), el("p", { class: "pe-hint" }, tr("pdfed.ottimizza_spiega"))], tr("pdfed.ottimizza_salva")))) return;
      const [dpi, quality] = q.value.split("|");
      return toNewFile("compress", { dpi: +dpi, quality: +quality }, `${stem(E)}_ottimizzato.pdf`);
    }
    if (name === "ocr") {
      const out = await pickSavePath(`${stem(E)}_ricercabile.pdf`, dir);
      if (!out) return;
      try {
        const { job } = await api("pdf_tool", { path: await E.currentFile(), op: "ocr" }, { json: { out } });
        const r = await waitJob(job, (p, m) => ctx.status(`${m} (${Math.round(p * 100)}%)`));
        toast(r.pagine ? tr("pdfed.ocr_fatto_0_1", r.pagine, r.parole) : tr("pdfed.ocr_gia_testo"));
        ctx.openFile(out);
      } catch (e) { toast(e.message, true, 8000); }
      return;
    }
    if (name === "compare") {
      const fs = await pickFiles();
      const other = fs?.find(x => /\.pdf$/i.test(x));
      if (!other) return;
      const mine = await E.currentFile();
      return ctx.openFile(other, "compare", { compareWith: mine, fresh: true, displayName: `${baseName(other)} ↔ ${ctx.name}` });
    }
    if (name === "protect") {
      const pw = el("input", { type: "password", class: "pe-in" }), pw2 = el("input", { type: "password", class: "pe-in" });
      [pw, pw2].forEach(i => i.addEventListener("keydown", e => e.stopPropagation()));
      const pr = checkbox(tr("pdfed.consenti_stampa"), true), cp = checkbox(tr("pdfed.consenti_copia"), false), ed = checkbox(tr("pdfed.consenti_modifica"), false);
      if (!(await ask(tr("pdfed.proteggi_password"), [grid(field(tr("pdfed.password"), pw), field(tr("pdfed.ripeti_password"), pw2)), pr, cp, ed, el("p", { class: "pe-hint" }, tr("pdfed.aes256"))], tr("pdfed.proteggi_salva")))) return;
      if (!pw.value) return toast(tr("pdfed.password_vuota"), true);
      if (pw.value !== pw2.value) return toast(tr("pdfed.password_diverse"), true);
      return toNewFile("protect", { password: pw.value, print: pr.input.checked, copy: cp.input.checked, edit: ed.input.checked }, `${stem(E)}_protetto.pdf`);
    }
    if (name === "unlock") {
      const pw = el("input", { type: "password", class: "pe-in" });
      pw.addEventListener("keydown", e => e.stopPropagation());
      if (await ask(tr("pdfed.togli_password"), field(tr("pdfed.password_attuale"), pw), tr("pdfed.togli_salva"))) return toNewFile("unlock", { password: pw.value }, `${stem(E)}_sbloccato.pdf`);
      return;
    }
    if (name === "word") return toNewFile("word", {}, stem(E) + ".docx", false).then(() => {});
    if (name === "images") {
      const folder = await pickFolder();
      if (!folder) return;
      try { const r = await api("pdf_tool", { path: await E.currentFile(), op: "images" }, { json: { folder, dpi: 150 } }); toast(tr("pdfed.create_0_immagini_in_1", r.files.length, folder)); } catch (e) { toast(e.message, true); }
      return;
    }
    if (name === "sign") {
      if (E.ctx.tab.dirty && !(await confirmBox(tr("pdfed.firma_digitale"), tr("pdfed.firma_salva_prima"), tr("pdfed.continua")))) return;
      return import("./firma.js").then(m => m.signDialog({ path: ctx.path, openFile: ctx.openFile }));
    }
  }

  // ---- intestazioni e pie' di pagina (anteprima sulla pagina corrente)
  async function headerFooter() {
    const keys = ["tl", "tc", "tr", "bl", "bc", "br"];
    const saved = (() => { try { return JSON.parse(localStorage.getItem("mbv-pdf-hf") || "{}"); } catch { return {}; } })();
    const boxes = Object.fromEntries(keys.map(k => [k, input(saved.items?.[k] || "", { placeholder: tr("pdfed.hf_" + k) })]));
    const font = select(FONTS.map(f => [f, f]), saved.font || "Helvetica"), size = numIn(saved.size || 9, { min: 4, max: 72, step: 0.5 });
    let col = saved.color || "#333333";
    const colB = colorButton({ value: col, onCommit: v => { col = v || "#000000"; upd(); } });
    const marg = [saved.margins?.[0] ?? 12, saved.margins?.[1] ?? 12, saved.margins?.[2] ?? 15, saved.margins?.[3] ?? 15].map(v => numIn(v, { min: 0, max: 200, step: 0.5 }));
    const start = numIn(saved.start || 1, { min: 1 });
    const pp = pagesPicker(E, "all");
    const pv = await pagePreview(E);
    const tokens = el("div", { class: "pe-tokens" }, ...[["{n}", "pdfed.tok_n"], ["{tot}", "pdfed.tok_tot"], ["{data}", "pdfed.tok_data"], ["{file}", "pdfed.tok_file"]]
      .map(([tk, l]) => el("button", { type: "button", class: "pe-chip", title: tr(l), onclick: () => { const f = document.activeElement?.closest?.(".pe-hfgrid input") || boxes.bc; f.setRangeText(tk, f.selectionStart ?? f.value.length, f.selectionEnd ?? f.value.length, "end"); f.focus(); upd(); } }, tk)));
    function upd() {
      const L = pv.layer, k = pv.k;
      L.innerHTML = "";
      const mm = 72 / 25.4;
      const [t, b, l, r] = marg.map(x => (+x.value || 0) * mm * k);
      const s = (+size.value || 9) * k;
      for (const key of keys) {
        const v = boxes[key].value.replace("{n}", E.curPage() + (+start.value || 1)).replace("{tot}", E.pages() + (+start.value || 1) - 1).replace("{data}", today()).replace("{file}", stem(E));
        if (!v) continue;
        const d = el("div", { class: "pe-pvt", style: { fontFamily: cssFont(font.value), fontSize: s + "px", color: cssColor(col), [key[1] === "l" ? "left" : key[1] === "r" ? "right" : "left"]: key[1] === "c" ? "50%" : (key[1] === "l" ? l : r) + "px",
          transform: key[1] === "c" ? "translateX(-50%)" : "", [key[0] === "t" ? "top" : "bottom"]: (key[0] === "t" ? t : b) + "px" } }, v);
        L.append(d);
      }
    }
    [...Object.values(boxes), size, font, start, ...marg].forEach(i => i.addEventListener("input", upd));
    font.addEventListener("change", upd);
    upd();
    const hf = el("div", { class: "pe-hfgrid" }, el("b", {}, tr("pdfed.intestazione")), boxes.tl, boxes.tc, boxes.tr, el("b", {}, tr("pdfed.pie_pagina")), boxes.bl, boxes.bc, boxes.br);
    const ok = await ask(tr("pdfed.intestazione_pie"), el("div", { class: "pe-split2" },
      el("div", {}, hf, tokens, grid(field(tr("pdfed.carattere"), font), field(tr("pdfed.dimensione"), size), field(tr("pdfed.colore"), colB), field(tr("pdfed.primo_numero"), start)),
        el("div", { class: "pe-fsub" }, tr("pdfed.margini_mm")), grid(field(tr("pdfed.m_alto"), marg[0]), field(tr("pdfed.m_basso"), marg[1]), field(tr("pdfed.m_sinistra"), marg[2]), field(tr("pdfed.m_destra"), marg[3])),
        field(tr("pdfed.pagine"), pp)), pv), tr("pdfed.aggiungi"), "wide");
    if (!ok) return;
    const items = Object.fromEntries(keys.map(k => [k, boxes[k].value]).filter(([, v]) => v));
    if (!Object.keys(items).length) return toast(tr("pdfed.nessun_testo"), true);
    const conf = { items, font: font.value, size: +size.value || 9, color: col, margins: marg.map(x => +x.value || 0), start: +start.value || 1 };
    try { localStorage.setItem("mbv-pdf-hf", JSON.stringify(conf)); } catch { /* */ }
    return E.ops([{ kind: "header_footer", ...conf, ...pp.value(), filename: E.ctx.name }], tr("pdfed.intestazione_pie"));
  }

  // ---- filigrana (testo o immagine) con anteprima
  async function watermark() {
    const kind = select([["text", tr("pdfed.testo")], ["image", tr("pdfed.immagine")]], "text");
    const text = el("textarea", { class: "pe-in", rows: 2 }, tr("pdfed.s_riservato"));
    text.addEventListener("keydown", e => e.stopPropagation());
    const font = select(FONTS.map(f => [f, f]), "Helvetica");
    let col = "#c62828", img = null;
    const colB = colorButton({ value: col, onCommit: v => { col = v || "#000000"; upd(); } });
    const op = numIn(30, { min: 1, max: 100 }), ang = numIn(45, { min: -180, max: 180 }), scale = numIn(50, { min: 5, max: 100 });
    const pos = select([["center", tr("pdfed.pos_centro")], ["tc", tr("pdfed.pos_alto")], ["bc", tr("pdfed.pos_basso")], ["tl", tr("pdfed.pos_alto_sx")], ["tr", tr("pdfed.pos_alto_dx")], ["bl", tr("pdfed.pos_basso_sx")], ["br", tr("pdfed.pos_basso_dx")]], "center");
    const behind = checkbox(tr("pdfed.dietro_contenuto"), false);
    const pp = pagesPicker(E, "all");
    const pickB = el("button", { type: "button", class: "pe-btn", html: pdfIcon("image", 15) }, el("span", {}, tr("pdfed.scegli_immagine")));
    pickB.addEventListener("click", async () => { img = await E.pickImage(); upd(); });
    const pv = await pagePreview(E);
    function upd() {
      const isText = kind.value === "text";
      text.closest(".pe-f").hidden = font.closest(".pe-f").hidden = colB.closest(".pe-f").hidden = !isText;
      pickB.hidden = isText;
      const L = pv.layer;
      L.innerHTML = "";
      const k = pv.k, W = pv.w * k, H = pv.h * k, sc = (+scale.value || 50) / 100;
      const a = +ang.value || 0;
      const node = isText ? el("div", { class: "pe-pvt", style: { fontFamily: cssFont(font.value), fontWeight: 700, color: cssColor(col), whiteSpace: "pre", lineHeight: 1.15 } }, text.value)
        : img ? el("img", { src: "data:image;base64," + img, style: { width: W * sc + "px" } }) : null;
      if (!node) return;
      node.style.opacity = (+op.value || 30) / 100;
      L.append(node);
      if (isText) {
        const span = a % 180 ? Math.hypot(W, H) : W;
        node.style.fontSize = "10px";
        const w0 = node.offsetWidth || 1;
        node.style.fontSize = 10 * (span * sc) / w0 + "px";
      }
      const p = pos.value === "center" ? "mc" : pos.value;
      const m = 36 * k;
      const x = { l: m, c: W / 2, r: W - m }[p[1]], y = { t: m, m: H / 2, b: H - m }[p[0]];
      Object.assign(node.style, { position: "absolute", left: x + "px", top: y + "px", transform: `translate(${p[1] === "l" ? "0" : p[1] === "r" ? "-100%" : "-50%"}, ${p[0] === "t" ? "0" : p[0] === "b" ? "-100%" : "-50%"}) rotate(${-a}deg)`, transformOrigin: "center" });
      L.style.zIndex = behind.input.checked ? 0 : 2;
    }
    [text, op, ang, scale].forEach(i => i.addEventListener("input", upd));
    [kind, pos, font].forEach(i => i.addEventListener("change", upd));
    behind.input.addEventListener("change", upd);
    const body = el("div", { class: "pe-split2" }, el("div", {},
      grid(field(tr("pdfed.tipo"), kind), field(tr("pdfed.testo"), text, true), field(tr("pdfed.carattere"), font), field(tr("pdfed.colore"), colB), el("div", { class: "pe-f" }, pickB),
        field(tr("pdfed.opacita_pct"), op), field(tr("pdfed.rotazione_gradi"), ang), field(tr("pdfed.dimensione_pct"), scale), field(tr("pdfed.posizione"), pos)),
      behind, field(tr("pdfed.pagine"), pp)), pv);
    setTimeout(upd, 30);
    if (!(await ask(tr("pdfed.filigrana"), body, tr("pdfed.aggiungi"), "wide"))) return;
    const isText = kind.value === "text";
    if (!isText && !img) return toast(tr("pdfed.nessuna_immagine"), true);
    return E.ops([{ kind: "watermark", text: isText ? text.value : undefined, image: isText ? undefined : img, font: font.value, color: col, opacity: (+op.value || 30) / 100,
      angle: +ang.value || 0, scale: +scale.value || 50, pos: pos.value, behind: behind.input.checked, ...pp.value() }], tr("pdfed.filigrana"));
  }

  async function background() {
    const kind = select([["color", tr("pdfed.colore")], ["image", tr("pdfed.immagine")]], "color");
    let col = "#fff8e1", img = null;
    const colB = colorButton({ value: col, onCommit: v => (col = v || "#ffffff") });
    const op = numIn(100, { min: 1, max: 100 });
    const pickB = el("button", { type: "button", class: "pe-btn", html: pdfIcon("image", 15) }, el("span", {}, tr("pdfed.scegli_immagine")));
    pickB.addEventListener("click", async () => { img = await E.pickImage(); });
    const pp = pagesPicker(E, "all");
    if (!(await ask(tr("pdfed.sfondo"), [grid(field(tr("pdfed.tipo"), kind), field(tr("pdfed.colore"), colB), el("div", { class: "pe-f" }, pickB), field(tr("pdfed.opacita_pct"), op)), field(tr("pdfed.pagine"), pp),
      el("p", { class: "pe-hint" }, tr("pdfed.sfondo_spiega"))], tr("pdfed.aggiungi")))) return;
    if (kind.value === "image" && !img) return toast(tr("pdfed.nessuna_immagine"), true);
    return E.ops([{ kind: "background", color: kind.value === "color" ? col : undefined, image: kind.value === "image" ? img : undefined, opacity: (+op.value || 100) / 100, pages: pp.list() }], tr("pdfed.sfondo"));
  }

  async function bates() {
    const prefix = input("MBV-"), suffix = input(""), start = numIn(1, { min: 0 }), digits = numIn(6, { min: 1, max: 12 });
    const pos = select([["br", tr("pdfed.pos_basso_dx")], ["bc", tr("pdfed.pos_basso")], ["bl", tr("pdfed.pos_basso_sx")], ["tr", tr("pdfed.pos_alto_dx")], ["tc", tr("pdfed.pos_alto")], ["tl", tr("pdfed.pos_alto_sx")]], "br");
    const size = numIn(9, { min: 4, max: 48, step: 0.5 });
    let col = "#000000";
    const colB = colorButton({ value: col, onCommit: v => (col = v || "#000000") });
    const sample = el("div", { class: "pe-bates" });
    const upd = () => (sample.textContent = `${prefix.value}${String(+start.value || 0).padStart(+digits.value || 6, "0")}${suffix.value}`);
    [prefix, suffix, start, digits].forEach(i => i.addEventListener("input", upd));
    upd();
    const pp = pagesPicker(E, "all");
    if (!(await ask(tr("pdfed.numerazione_bates"), [grid(field(tr("pdfed.prefisso"), prefix), field(tr("pdfed.suffisso"), suffix), field(tr("pdfed.primo_numero"), start), field(tr("pdfed.cifre"), digits),
      field(tr("pdfed.posizione"), pos), field(tr("pdfed.dimensione"), size), field(tr("pdfed.colore"), colB)), field(tr("pdfed.esempio"), sample), field(tr("pdfed.pagine"), pp)], tr("pdfed.aggiungi")))) return;
    const r = await E.ops([{ kind: "bates", prefix: prefix.value, suffix: suffix.value, start: +start.value || 0, digits: +digits.value || 6, pos: pos.value, size: +size.value || 9, color: col, pages: pp.list() }], tr("pdfed.numerazione_bates"));
    if (r?.bates) toast(tr("pdfed.bates_da_a", r.bates[0], r.bates[1]));
  }

  // ---- oscuramento da ricerca: testi (uno per riga) e schemi pronti; si segnano, poi si applicano
  async function redactSearch(term = "") {
    const ta = el("textarea", { class: "pe-in", rows: 4, placeholder: tr("pdfed.una_parola_riga") }, term || "");
    ta.addEventListener("keydown", e => e.stopPropagation());
    const pats = [["email", "pdfed.pt_email", "[\\w.+-]+@[\\w-]+\\.[\\w.]+"], ["cf", "pdfed.pt_cf", "[A-Za-z]{6}\\d{2}[A-Za-z]\\d{2}[A-Za-z]\\d{3}[A-Za-z]"], ["iban", "pdfed.pt_iban", "IT\\d{2}[A-Z]\\d{10}[0-9A-Z]{12}"],
      ["piva", "pdfed.pt_piva", "\\d{11}"], ["tel", "pdfed.pt_telefono", "\\+?\\d{9,13}"], ["data", "pdfed.pt_data", "\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}"]].map(([id, l, rx]) => { const c = checkbox(tr(l), false); c.rx = rx; return c; });
    const cs = checkbox(tr("pdfed.maiuscole_minuscole"), false);
    const pp = pagesPicker(E, "all");
    if (!(await ask(tr("pdfed.oscura_testo_cercato"), [field(tr("pdfed.testi_da_oscurare"), ta, true), el("div", { class: "pe-fsub" }, tr("pdfed.schemi")), el("div", { class: "pe-chkgrid" }, ...pats), cs, field(tr("pdfed.pagine"), pp),
      el("p", { class: "pe-hint" }, tr("pdfed.oscura_spiega"))], tr("pdfed.cerca_segna")))) return;
    const terms = ta.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const rx = pats.filter(p => p.input.checked).map(p => p.rx);
    const ops = [];
    if (terms.length) ops.push({ kind: "redact_search", terms, case: cs.input.checked, ...pp.value(), author: E.author });
    if (rx.length) ops.push({ kind: "redact_search", terms: rx, regex: true, ...pp.value(), author: E.author });
    if (!ops.length) return;
    const r = await E.ops(ops, tr("pdfed.u_segna_oscura"));
    if (r) toast(r.trovati ? tr("pdfed.segnati_0", r.trovati) : tr("pdfed.nessuna_occorrenza"), !r.trovati, 6000);
    if (r?.trovati) E.showComments();
  }

  return { pageCmd, docCmd };
}
