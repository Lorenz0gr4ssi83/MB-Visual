// Conversione a lotti: una o piu' cartelle (con o senza sottocartelle) o file scelti -> un formato, in background.
// Motore: mbvisual/batch.py (api/batch?op=scan|start|status|cancel|take|client). La coda gira nel motore; questa pagina
// mostra avanzamento e rapporto e fa da "esecutore" per i file che si leggono solo nel browser:
// - DWG (senza ODA File Converter): libredwg decodifica il disegno qui e il database va al motore, che con ezdxf
//   ricostruisce modello e fogli e li stampa in PDF/SVG/PNG;
// - modelli 3D e BIM: il visualizzatore 3D si monta in un contenitore fuori schermo e salva con il suo "Salva con nome".
import { api, baseName, el, fmtSize, loadCss, pickFiles, pickFolder, readBytes, toast } from "./core.js";
import { t as tr } from "./i18n.js";

const FAM = {
  cad: tr("batch.disegni_cad"), model3d: tr("batch.modelli_3d_bim"), word: tr("batch.word"), sheet: tr("batch.fogli_calcolo"), slides: tr("batch.fam_presentazioni"), pdf: "PDF",
  image: tr("batch.fam_immagini"), svg: "SVG", media: tr("batch.fam_video"), audio: tr("batch.fam_audio"), email: tr("batch.fam_email"), html: tr("batch.pagine_web"), markdown: tr("batch.markdown"), text: tr("batch.fam_testo"),
  xps: "XPS", epub: "eBook", archive: tr("batch.fam_archivi"), font: tr("batch.fam_font"), database: tr("batch.fam_database"), altro: tr("batch.non_convertibili"),
};
// stessa regola di applies() in mbvisual/batch.py (serve solo a mostrare quanti file interessa ogni operazione)
const PDF_FAMS = new Set(["word", "sheet", "slides", "email", "image", "svg", "html", "markdown", "text", "xps", "epub", "cad"]);
const SAME = { jpeg: "jpg", tif: "tiff", htm: "html", stp: "step" };
function applies(op, f, o, targetsOf) {
  const fam = f.fam;
  if (op === "pdf") return PDF_FAMS.has(fam);
  if (op === "format") return !!o.to && (fam === "pdf" || (SAME[f.ext] || f.ext) !== (SAME[o.to] || o.to)) && targetsOf(f).includes(o.to);
  if (op === "image") return fam === "image";
  if (op === "pdf_merge") return fam === "pdf" || (o.convert_others !== false && PDF_FAMS.has(fam));
  if (op === "pdf_compress" || op === "pdf_ocr") return fam === "pdf";
  if (op === "video") return fam === "media";
  if (op === "drawing") return fam === "pdf" || fam === "image";
  return false;
}
const OP_HELP = {
  pdf: tr("batch.documenti_office_email_immagini_pagine"),
  format: tr("batch.ogni_file_formato_scelto_se"),
  image: tr("batch.ridimensiona_cambia_formato_comprimi_immagini"),
  pdf_merge: tr("batch.solo_pdf_segnalibro_file_altri"),
  pdf_compress: tr("batch.ricomprime_immagini_interne_riduce_i"),
  pdf_ocr: tr("batch.aggiunge_testo_invisibile_alle_scansioni"),
  video: tr("batch.h_264_aac_mp4_qualita"),
  drawing: tr("batch.disegno_aiuto"),
};

const KEY = "mbv-lotti";
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } };
const store = s => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* */ } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let TOOLS = null;
const runners = new Map(); // id -> { state, view }
let chip = null, dlg = null;

// ---------------------------------------------------------------- finestra
function frame(title) {
  loadCss("css/batch.css");
  closeDlg();
  const head = el("div", { class: "bt-head" }, el("h3", {}, title));
  const body = el("div", { class: "bt-body" });
  const foot = el("div", { class: "bt-foot" });
  const box = el("div", { class: "bt-dlg", role: "dialog" }, head, body, foot);
  const back = el("div", { class: "bt-back" }, box);
  document.body.append(back);
  dlg = { back, head, body, foot, onKey: null };
  return dlg;
}
function closeDlg() {
  if (!dlg) return;
  if (dlg.onKey) document.removeEventListener("keydown", dlg.onKey);
  dlg.back.remove();
  dlg = null;
}
const btn = (label, onclick, cls = "") => el("button", { class: "btn " + cls, type: "button", onclick }, label);

// ---------------------------------------------------------------- impostazioni del lotto
export async function openBatch({ paths = [] } = {}) {
  const saved = load();
  const S = {
    sources: [...paths], recursive: saved.recursive ?? true, scan: null, op: saved.op || "pdf",
    opts: { ...{ layouts: "fogli", paper: "auto", orient: "auto", scale: 0, colors: "colori", lineweights: true, to: "", quality: 82, imgsize: "max", max_w: 1920, max_h: 1920, percent: 50,
      keep_meta: false, name: tr("batch.unione"), convert_others: true, bookmarks: true, dpi: 150, cquality: 75, ocr_dpi: 300, crf: 26, vmax_h: 1080, audio_kbps: 128, mute: false, report_file: true,
      d_scale: 1, d_units: "mm", d_layout: "model", d_method: "auto", d_vmode: "center", d_to: "dxf", d_ocr: true }, ...(saved.opts || {}) },
    out: { mode: "accanto", dir: "", collision: "rinomina", suffix: "", ...(saved.out || {}) },
  };
  const D = frame(tr("batch.conversione_lotti"));
  D.onKey = e => { if (e.key === "Escape") closeDlg(); };
  document.addEventListener("keydown", D.onKey);

  const srcList = el("div", { class: "bt-src" });
  const sum = el("div", { class: "bt-sum" });
  const rec = el("input", { type: "checkbox", checked: S.recursive || undefined });
  rec.addEventListener("change", () => { S.recursive = rec.checked; rescan(); });
  const ops = el("div", { class: "bt-ops" });
  const optBox = el("div", { class: "bt-sec" });
  const outBox = el("div", { class: "bt-sec" });
  const startBtn = btn(tr("batch.avvia_conversione"), () => start(), "primary");
  D.body.append(
    el("div", { class: "bt-sec" }, el("h4", {}, tr("batch.file_convertire")), srcList,
      el("div", { class: "bt-line" }, btn(tr("batch.aggiungi_cartella"), async () => { const d = await pickFolder(); if (d) { S.sources.push(d); rescan(); } }),
        btn(tr("batch.aggiungi_file"), async () => { const f = await pickFiles(); if (f?.length) { S.sources.push(...f); rescan(); } }),
        el("label", { class: "bt-chk" }, rec, tr("batch.includi_sottocartelle"))), sum),
    el("div", { class: "bt-sec" }, el("h4", {}, tr("batch.operazione")), ops), optBox, outBox);
  D.foot.append(el("span", { class: "bt-note grow" }, tr("batch.conversione_continua_background_puoi_lavorare")), btn(tr("common.annulla"), closeDlg), startBtn);

  const targetsOf = f => (S.scan?.fam_targets?.[f.fam] || []); // formati possibili per tipo di file (dal motore)
  async function rescan() {
    renderSources();
    sum.textContent = S.sources.length ? tr("batch.lettura_cartelle") : tr("batch.scegli_cartella_file");
    S.scan = null;
    renderOps();
    if (!S.sources.length) return;
    try {
      const r = await api("batch", { op: "scan" }, { json: { paths: S.sources, recursive: S.recursive } });
      S.scan = r;
      const parts = Object.entries(r.counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${FAM[k] || k}`);
      const size = r.files.reduce((a, f) => a + f.size, 0);
      sum.innerHTML = "";
      sum.append(el("b", {}, `${r.files.length} file`), ` (${fmtSize(size)}): ${parts.join(", ")}` + (r.troppi ? tr("batch.elenco_limitato_primi_20_000") : ""));
      if (!r.targets.some(t => t.ext === S.opts.to)) S.opts.to = (r.targets.find(t => t.ext !== "pdf") || r.targets[0] || {}).ext || "";
    } catch (e) { sum.textContent = tr("batch.lettura_non_riuscita") + e.message; }
    renderOps();
  }

  function renderSources() {
    srcList.innerHTML = "";
    if (!S.sources.length) srcList.append(el("div", { class: "bt-note" }, tr("batch.nessuna_cartella_file_scelto")));
    S.sources.forEach((p, i) => srcList.append(el("div", { class: "row" }, el("span", {}, /\.[^\\/]+$/.test(p) ? tr("batch.file") : tr("batch.cartella")),
      el("span", { class: "p", title: p }, p), el("button", { class: "btn", type: "button", title: tr("batch.togli"), onclick: () => { S.sources.splice(i, 1); rescan(); } }, tr("batch.togli")))));
  }

  function count(op) { return S.scan ? S.scan.files.filter(f => applies(op, f, S.opts, targetsOf)).length : 0; }
  function renderOps() {
    ops.innerHTML = "";
    for (const [k, label] of Object.entries(S.scan?.ops || OPS_FALLBACK)) {
      const n = count(k);
      const r = el("input", { type: "radio", name: "bt-op", checked: S.op === k || undefined });
      r.addEventListener("change", () => { S.op = k; renderOps(); });
      ops.append(el("label", { class: "bt-op" + (S.op === k ? " on" : "") + (S.scan && !n && k !== "format" ? " off" : ""), title: OP_HELP[k] || "" }, r, el("span", {}, label), el("span", { class: "n" }, S.scan ? `${n} file` : "")));
    }
    renderOpts();
    renderOut();
    const n = count(S.op);
    startBtn.disabled = !S.scan || !n || (S.out.mode === "cartella" && !S.out.dir);
    startBtn.textContent = n ? tr("batch.avvia_conversione_0_file", n) : tr("batch.avvia_conversione");
  }

  // ---- opzioni dell'operazione
  const field = (label, input, note) => el("label", {}, label, input, note ? el("span", { class: "bt-note" }, note) : null);
  const sel = (label, key, options, note, conv = v => v) => {
    const s = el("select", { class: "field" }, options.map(([v, l]) => el("option", { value: String(v), selected: String(S.opts[key]) === String(v) || undefined }, l)));
    s.addEventListener("change", () => { S.opts[key] = conv(s.value); renderOps(); });
    return field(label, s, note);
  };
  const num = (label, key, min, max, step = 1) => {
    const i = el("input", { class: "field", type: "number", min, max, step, value: S.opts[key] });
    i.addEventListener("change", () => { S.opts[key] = +i.value || 0; });
    return field(label, i);
  };
  const chk = (label, key) => {
    const c = el("input", { type: "checkbox", checked: S.opts[key] ? true : undefined });
    c.addEventListener("change", () => { S.opts[key] = c.checked; renderOps(); });
    return el("label", { class: "chk" }, c, label);
  };
  const txt = (label, key) => { const i = el("input", { class: "field", type: "text", value: S.opts[key] || "" }); i.addEventListener("input", () => { S.opts[key] = i.value; }); return field(label, i); };
  const cadOpts = () => [
    sel(tr("batch.cosa_stampare"), "layouts", [["fogli", tr("batch.i_fogli_layout_modello_se")], ["modello", tr("batch.solo_modello")], ["tutti", tr("batch.modello_tutti_i_fogli")]]),
    sel(tr("batch.formato_carta"), "paper", [["auto", tr("batch.automatico_come_foglio_a3_modello")], ...["A4", "A3", "A2", "A1", "A0"].map(p => [p, p])]),
    sel(tr("batch.orientamento"), "orient", [["auto", tr("batch.automatico")], ["orizzontale", tr("batch.orizzontale")], ["verticale", tr("batch.verticale")]]),
    sel(tr("batch.scala_modello"), "scale", [[0, tr("batch.adatta_foglio")], ...[1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000, 2000].map(n => [n, "1:" + n])], "", Number),
    sel(tr("batch.colori"), "colors", [["colori", tr("batch.colori_2")], ["bn", tr("batch.bianco_nero")], ["grigi", tr("batch.scala_grigi")]]),
    chk(tr("batch.spessori_linea"), "lineweights"),
  ];
  function renderOpts() {
    optBox.innerHTML = "";
    const g = el("div", { class: "bt-grid" });
    const notes = [];
    const fams = new Set((S.scan?.files || []).filter(f => applies(S.op, f, S.opts, targetsOf)).map(f => f.fam));
    const o = S.opts;
    if (S.op === "format") {
      const ts = S.scan?.targets || [];
      const s = el("select", { class: "field" }, ts.map(t => el("option", { value: t.ext, selected: t.ext === o.to || undefined }, tr("batch.0_1_2_file", t.ext.toUpperCase(), t.label, t.n))));
      s.addEventListener("change", () => { o.to = s.value; renderOps(); });
      g.append(field(tr("batch.formato_destinazione"), s));
    }
    const cad = fams.has("cad") && (S.op === "pdf" || (S.op === "format" && ["pdf", "png", "svg"].includes(o.to)));
    if (cad) { g.append(...cadOpts()); notes.push(tr("batch.disegni_i_dwg_si_leggono")); }
    if (S.op === "pdf" && (fams.has("word") || fams.has("sheet") || fams.has("slides"))) notes.push(tr("batch.word_excel_powerpoint_convertono_i"));
    if (S.op === "format" && fams.has("model3d")) notes.push(tr("batch.modelli_3d_step_ifc_contengono"));
    if (S.op === "image") {
      g.append(sel(tr("batch.formato"), "to_img", [["uguale", tr("batch.stesso_dell_originale")], ["jpg", "JPG"], ["png", "PNG"], ["webp", "WEBP"], ["tiff", "TIFF"], ["avif", "AVIF"], ["bmp", "BMP"]]),
        sel(tr("batch.dimensioni"), "imgsize", [["uguali", tr("batch.invariate")], ["max", tr("batch.lato_massimo")], ["pct", tr("batch.percentuale")]]));
      if (o.imgsize === "max") g.append(num(tr("batch.larghezza_massima_px"), "max_w", 16, 20000), num(tr("batch.altezza_massima_px"), "max_h", 16, 20000));
      if (o.imgsize === "pct") g.append(num(tr("batch.percentuale"), "percent", 1, 400));
      g.append(num(tr("batch.qualita_jpg_webp_avif_1"), "quality", 1, 100), chk(tr("batch.conserva_i_dati_exif_data"), "keep_meta"));
    }
    if (S.op === "pdf_merge") {
      g.append(txt(tr("batch.nome_pdf_unico"), "name"), chk(tr("batch.converti_anche_documenti_immagini_disegni"), "convert_others"), chk(tr("batch.segnalibro_ogni_file"), "bookmarks"));
      notes.push(tr("batch.ordine_pagine_cartella_nome_file"));
      if (S.opts.convert_others && fams.has("cad")) g.append(...cadOpts());
    }
    if (S.op === "pdf_compress") g.append(sel(tr("batch.risoluzione_immagini"), "dpi", [[72, tr("batch.72_dpi_schermo")], [96, "96 dpi"], [120, "120 dpi"], [150, tr("batch.150_dpi_consigliata")], [200, tr("batch.200_dpi_stampa")]], "", Number),
      sel(tr("batch.qualita_immagini"), "cquality", [[50, tr("batch.bassa")], [65, tr("batch.media")], [75, tr("batch.buona")], [85, tr("batch.alta")]], "", Number));
    if (S.op === "pdf_ocr") { g.append(sel(tr("batch.risoluzione_lettura"), "ocr_dpi", [[200, tr("batch.200_dpi_veloce")], [300, tr("batch.300_dpi_consigliata")], [400, tr("batch.400_dpi_testi_piccoli")]], "", Number)); notes.push(tr("batch.pagine_che_hanno_gia_testo")); }
    if (S.op === "video") g.append(sel(tr("batch.qualita"), "crf", [[22, tr("batch.alta")], [26, tr("batch.media_consigliata")], [30, tr("batch.ridotta")], [34, tr("batch.minima")]], "", Number),
      sel(tr("batch.altezza_massima"), "vmax_h", [[0, tr("batch.originale")], [2160, "2160 (4K)"], [1440, "1440"], [1080, "1080 (Full HD)"], [720, "720 (HD)"], [480, "480"]], "", Number),
      sel(tr("batch.audio"), "audio_kbps", [[96, "96 kbps"], [128, "128 kbps"], [192, "192 kbps"]], "", Number), chk(tr("batch.togli_l_audio"), "mute"));
    if (S.op === "drawing") {
      // stesse opzioni della finestra "Converti in disegno" (ui/js/todrawing.js)
      g.append(sel(tr("todrawing.scala"), "d_scale", [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000, 2000].map(n => [n, n === 1 ? tr("todrawing.scala_carta") : "1:" + n]), "", Number),
        sel(tr("todrawing.unita"), "d_units", [["mm", "mm"], ["cm", "cm"], ["m", "m"]]),
        sel(tr("todrawing.pagine"), "d_layout", [["model", tr("todrawing.pagine_modello")], ["sheets", tr("todrawing.pagine_fogli")]]),
        sel(tr("todrawing.metodo"), "d_method", [["auto", tr("todrawing.metodo_auto")], ["vector", tr("todrawing.metodo_vettoriale")], ["raster", tr("todrawing.metodo_scansione")]]),
        sel(tr("todrawing.vettorizza"), "d_vmode", [["center", tr("todrawing.linee_asse")], ["outline", tr("todrawing.solo_contorni")]]),
        sel(tr("batch.formato"), "d_to", [["dxf", "DXF"], ["dwg", "DWG (ODA File Converter)"]]),
        chk(tr("todrawing.ocr"), "d_ocr"));
      notes.push(tr("todrawing.avviso_approssimato"));
    }
    if (!g.childElementCount && !notes.length) return;
    optBox.append(el("h4", {}, tr("batch.opzioni")), g, ...notes.map(n => el("p", { class: "bt-note" }, n)));
  }

  // ---- uscita
  function renderOut() {
    outBox.innerHTML = "";
    const radio = (v, label) => {
      const r = el("input", { type: "radio", name: "bt-out", checked: S.out.mode === v || undefined });
      r.addEventListener("change", () => { S.out.mode = v; renderOps(); });
      return el("label", { class: "bt-chk" }, r, label);
    };
    const dir = el("input", { class: "field", type: "text", value: S.out.dir, placeholder: tr("batch.cartella_uscita") });
    dir.addEventListener("change", () => { S.out.dir = dir.value.trim(); renderOps(); });
    const coll = el("select", { class: "field" }, [["rinomina", tr("batch.aggiungi_numero_nome")], ["sovrascrivi", tr("batch.sostituisci")], ["salta", tr("batch.non_convertire")]].map(([v, l]) => el("option", { value: v, selected: S.out.collision === v || undefined }, l)));
    coll.addEventListener("change", () => { S.out.collision = coll.value; });
    const suf = el("input", { class: "field", type: "text", value: S.out.suffix, placeholder: "es. _rev" });
    suf.addEventListener("input", () => { S.out.suffix = suf.value; });
    const box = el("div", { class: "bt-out" }, radio("accanto", tr("batch.accanto_agli_originali")), radio("cartella", tr("batch.cartella_stessa_struttura_sottocartelle")));
    if (S.out.mode === "cartella") {
      box.append(el("div", { class: "path" }, dir, btn(tr("batch.scegli"), async () => { const d = await pickFolder(); if (d) { S.out.dir = d; renderOps(); } })));
      const rep = el("input", { type: "checkbox", checked: S.opts.report_file ? true : undefined });
      rep.addEventListener("change", () => { S.opts.report_file = rep.checked; });
      box.append(el("label", { class: "bt-chk" }, rep, tr("batch.salva_rapporto_csv_cartella_uscita")));
    }
    box.append(el("div", { class: "bt-grid" }, field(tr("batch.se_file_uscita_esiste_gia"), coll), field(tr("batch.aggiungi_nome_file"), suf)));
    outBox.append(el("h4", {}, tr("batch.dove_salvare")), box);
  }

  async function start() {
    if (!S.scan) return;
    const o = S.opts;
    const opts = { ...o };
    if (S.op === "image") {
      opts.to = o.to_img || "uguale";
      opts.max_w = o.imgsize === "max" ? o.max_w : 0;
      opts.max_h = o.imgsize === "max" ? o.max_h : 0;
      opts.percent = o.imgsize === "pct" ? o.percent : 0;
    }
    if (S.op === "pdf_compress") { opts.dpi = o.dpi; opts.quality = o.cquality; }
    if (S.op === "pdf_ocr") opts.dpi = o.ocr_dpi;
    if (S.op === "video") opts.max_h = o.vmax_h;
    if (S.op === "drawing") Object.assign(opts, { scale: o.d_scale || 1, units: o.d_units || "mm", layout: o.d_layout || "model", method: o.d_method || "auto",
      vmode: o.d_vmode || "center", ocr: o.d_ocr !== false, to: o.d_to || "dxf", dpi: 300 });
    store({ recursive: S.recursive, op: S.op, opts: S.opts, out: { ...S.out } });
    try {
      const files = S.scan.files.map(f => ({ path: f.path, rel: f.rel }));
      const r = await api("batch", { op: "start" }, { json: { op: S.op, opts, files, out: S.out } });
      follow(r.id, true);
    } catch (e) { toast(tr("batch.conversione_non_avviata") + e.message, true, 6000); }
  }

  renderSources();
  renderOps();
  rescan();
}
const OPS_FALLBACK = {
  pdf: tr("batch.converti_pdf"), format: tr("batch.converti_altro_formato"), image: tr("srv_batch.op_immagini"), pdf_merge: tr("batch.unisci_unico_pdf"),
  pdf_compress: tr("srv_batch.op_pdf_comprimi"), pdf_ocr: tr("batch.pdf_scansionati_rendi_ricercabili_ocr"), video: tr("srv_batch.op_video"), drawing: tr("srv_batch.op_disegno"),
};

// ---------------------------------------------------------------- avanzamento
function follow(id, show) {
  if (!runners.has(id)) {
    const R = { id, state: null, busy: false, filter: "tutti" };
    runners.set(id, R);
    loop(R);
  }
  if (show) showProgress(id);
}

async function loop(R) {
  for (;;) {
    let s;
    try { s = await api("batch", { op: "status", id: R.id, full: dlg?.id === R.id ? 1 : 0 }, { allowFail: true }); } catch { s = null; }
    if (!s || !s.ok) { await sleep(1500); if (!s) continue; break; }
    if (!s.items && R.state?.items && dlg?.id !== R.id) s.items = R.state.items;
    R.state = s;
    if (s.task && !s.task.preso && !R.busy) runTask(R, s.task);
    if (dlg?.id === R.id) renderProgress(R);
    renderChip();
    if (["finito", "annullato", "errore"].includes(s.status) && !R.busy) {
      if (dlg?.id === R.id) { R.state = await api("batch", { op: "status", id: R.id }); renderProgress(R); }
      const t = tr(s.status === "annullato" ? "batch.lotti_interrotta_0" : "batch.lotti_finita_0", s.riusciti) + (s.falliti ? tr("batch.0_non_riusciti", s.falliti) : "");
      toast(t, s.falliti > 0, 6000);
      renderChip();
      break;
    }
    await sleep(dlg?.id === R.id ? 600 : 1000);
  }
}

function showProgress(id) {
  const R = runners.get(id);
  const D = frame(tr("batch.conversione_lotti"));
  D.id = id;
  D.onKey = e => { if (e.key === "Escape") { closeDlg(); renderChip(); } };
  document.addEventListener("keydown", D.onKey);
  R.ui = null;
  D.body.append(el("div", { class: "bt-note" }, tr("batch.lettura_dello_stato")));
  renderChip();
  // stato completo (con l'elenco aggiornato dei file): mentre la finestra era ridotta si leggeva solo il riepilogo
  api("batch", { op: "status", id }).then(s => { if (s.ok) { R.state = s; R.ui = null; renderProgress(R); } }).catch(() => {});
}

const ST = { ok: tr("batch.riuscito"), errore: tr("batch.non_riuscito"), saltato: tr("batch.saltato"), annullato: tr("batch.annullato"), attesa: tr("batch.coda"), "in corso": tr("batch.corso") };
function renderProgress(R) {
  const D = dlg;
  if (!D || D.id !== R.id) return;
  const s = R.state;
  const end = ["finito", "annullato", "errore"].includes(s.status);
  if (!R.ui || R.ui.end !== end) {
    D.body.innerHTML = "";
    D.foot.innerHTML = "";
    const bar = el("div", { class: "bt-bar" }, el("span"));
    const stats = el("div", { class: "bt-stats" });
    const cur = el("div", { class: "bt-cur" });
    const tabs = el("div", { class: "bt-tabs" });
    const list = el("div", { class: "bt-items" });
    D.body.append(el("div", { class: "bt-sec" }, el("h4", {}, s.label), bar, stats, cur), el("div", { class: "bt-sec" }, tabs, list));
    if (end) {
      D.foot.append(...[
        s.report ? btn(tr("batch.apri_rapporto"), () => api("open_external", { path: s.report }).catch(e => toast(e.message, true))) : null,
        s.unito ? btn(tr("batch.apri_pdf_unico"), () => window.MB?.openFile(s.unito)) : null,
        btn(tr("batch.apri_cartella_uscita"), () => reveal(s)), el("span", { class: "grow" }),
        btn(tr("batch.nuova_conversione"), () => openBatch({ paths: [] })), btn(tr("common.chiudi"), () => { closeDlg(); runners.delete(R.id); renderChip(); }, "primary")].filter(Boolean));
    } else {
      D.foot.append(el("span", { class: "bt-note grow" }, tr("batch.puoi_ridurre_finestra_continuare_lavorare")),
        btn(tr("batch.interrompi_coda"), async () => { await api("batch", { op: "cancel", id: R.id }); toast(tr("batch.interruzione_si_ferma_dopo_file")); }, "danger"),
        btn(tr("batch.riduci"), () => { closeDlg(); renderChip(); }, "primary"));
    }
    R.ui = { bar, stats, cur, tabs, list, end, sig: "" };
  }
  const U = R.ui;
  U.bar.firstChild.style.width = Math.round((s.progress || 0) * 100) + "%";
  U.stats.innerHTML = "";
  U.stats.append(el("span", {}, tr("batch.0_1_file", s.fatti, s.da_fare)), el("span", { class: "ok" }, tr("batch.0_riusciti", s.riusciti)), el("span", { class: "bad" }, tr("batch.0_non_riusciti_2", s.falliti)),
    el("span", { class: "skip" }, `${s.saltati} saltati`), el("span", { class: "skip" }, elapsed(s)));
  const curItem = s.items && s.current >= 0 ? s.items[s.current] : null;
  U.cur.textContent = end ? (s.status === "annullato" ? tr("batch.coda_interrotta") : s.status === "errore" ? tr("batch.errore") + s.message : tr("batch.finito") + (s.unito ? tr("batch.pdf_unico") + s.unito : ""))
    : s.status === "attesa" ? tr("batch.attesa_che_finisca_lotto_precedente") : curItem ? tr("batch.corso_2") + curItem.rel + (s.task ? tr("batch.lettura_finestra_dell_app") : "") : s.message || "";
  if (!s.items) return;
  const counts = { tutti: s.items.length, errore: s.falliti, ok: s.riusciti, saltato: s.saltati };
  const sig = s.items.map(i => i.status[0] + i.msg.length).join("") + R.filter + s.current;
  if (sig === U.sig) return;
  U.sig = sig;
  U.tabs.innerHTML = "";
  for (const [k, l] of [["tutti", tr("batch.tutti")], ["errore", tr("batch.non_riusciti")], ["ok", tr("batch.riusciti")], ["saltato", tr("batch.saltati")]]) {
    U.tabs.append(el("button", { class: "btn" + (R.filter === k ? " on" : ""), type: "button", onclick: () => { R.filter = k; U.sig = ""; renderProgress(R); } }, `${l} (${counts[k]})`));
  }
  const tb = el("tbody");
  s.items.forEach((i, n) => {
    if (R.filter !== "tutti" && i.status !== R.filter) return;
    const out = i.out?.length ? el("div", { class: "bt-note" }, "-> " + i.out.map(baseName).join(", ")) : null;
    tb.append(el("tr", { class: i.status.replace(" ", "") + (n === s.current ? " cur" : "") }, el("td", { class: "st" }, ST[i.status] || i.status),
      el("td", { class: "f", title: i.src }, i.rel, out), el("td", { class: "m" }, i.msg || "")));
  });
  U.list.innerHTML = "";
  U.list.append(el("table", {}, tb));
  const row = U.list.querySelector("tr.cur");
  if (row && !end) row.scrollIntoView({ block: "nearest" });
}

function elapsed(s) {
  const t = Math.round(((s.ended || Date.now() / 1000) - s.started));
  return t < 60 ? `${t} s` : `${Math.floor(t / 60)} min ${t % 60} s`;
}

function reveal(s) {
  const first = (s.items || []).find(i => i.out?.length)?.out[0];
  const p = s.unito || first || s.uscita || s.report;
  if (p) api("reveal", { path: p }).catch(e => toast(e.message, true));
}

// riquadro in basso a destra mentre la finestra e' ridotta
function renderChip() {
  const live = [...runners.values()].filter(R => R.state);
  const R = live.find(r => !["finito", "annullato", "errore"].includes(r.state.status)) || live[live.length - 1];
  if (!R || (dlg && dlg.id === R.id) || dlg) { chip?.remove(); chip = null; return; }
  const s = R.state;
  const end = ["finito", "annullato", "errore"].includes(s.status);
  if (!chip) { loadCss("css/batch.css"); chip = el("div", { class: "bt-chip" }); document.body.append(chip); }
  chip.innerHTML = "";
  const cur = s.items && s.current >= 0 ? s.items[s.current]?.rel : s.message;
  chip.append(el("div", { class: "t" }, el("b", {}, end ? tr("batch.lotto_0", s.status === "annullato" ? "interrotto" : "finito") : `${s.label}: ${s.fatti}/${s.da_fare}`),
    btn(tr("batch.dettagli"), () => showProgress(R.id)), end ? btn("x", () => { runners.delete(R.id); renderChip(); }) : null),
  el("div", { class: "bt-bar" }, el("span", { style: { width: Math.round((s.progress || 0) * 100) + "%" } })),
  el("div", { class: "c" }, end ? tr("batch.0_riusciti_1_non_riusciti", s.riusciti, s.falliti) : cur || ""));
}

// ---------------------------------------------------------------- compiti eseguiti nella pagina
async function runTask(R, task) {
  R.busy = true;
  let result;
  try {
    const t = await api("batch", { op: "take", id: R.id }, { json: { seq: task.seq } });
    if (!t.ok) return;
    if (task.kind === "dwg") result = { db: await dwgDb(task) };
    else if (task.kind === "model3d") { await save3d(task); result = { ok: true }; }
    else throw new Error(tr("batch.compito_sconosciuto") + task.kind);
  } catch (e) {
    console.error(e);
    result = { errore: e.message || String(e) };
  } finally {
    const body = JSON.stringify({ id: R.id, seq: task.seq, result }, (k, v) => (typeof v === "bigint" ? Number(v) : k === "xdata" || k === "thumbnailImage" ? undefined : ArrayBuffer.isView(v) ? Array.from(v) : v));
    for (let i = 0; i < 3; i++) { // il motore aspetta questa risposta: qualche nuovo tentativo se la rete locale si interrompe
      try { if ((await api("batch", { op: "client", id: R.id }, { body, allowFail: true })).ok !== undefined) break; } catch (e) { console.error(e); await sleep(1000); }
    }
    R.busy = false;
  }
}

// DWG -> database (stesso lettore del visualizzatore CAD); il motore lo trasforma in un documento ezdxf con i fogli
async function dwgDb(task) {
  const cad = await import("./viewers/cad2d.js");
  const bytes = await readBytes(task.src);
  if (!TOOLS) TOOLS = (await api("tools").catch(() => ({ tools: {} }))).tools || {};
  const db = await cad.decodeDwg(bytes, { ext: task.ext, tools: TOOLS }, { set() {} });
  cad.normalize(db, "dwg");
  const T = db.tables || {};
  return { header: db.header, tables: { LAYER: T.LAYER, LTYPE: T.LTYPE, DIMSTYLE: T.DIMSTYLE, BLOCK_RECORD: T.BLOCK_RECORD }, entities: db.entities, objects: { LAYOUT: db.objects?.LAYOUT || [] } };
}

// modello 3D: il visualizzatore si monta fuori schermo e salva con il suo "Salva con nome" (export3d.js / three.js)
async function save3d(task) {
  if (!TOOLS) TOOLS = (await api("tools").catch(() => ({ tools: {} }))).tools || {};
  const mod = await import("./viewers/model3d.js");
  loadCss("css/batch.css");
  const tb = el("div", { class: "tb" });
  const body = el("div", { class: "body" });
  const host = el("div", { class: "bt-hidden", "aria-hidden": "true" }, tb, body);
  document.body.append(host);
  let a = null;
  try {
    const ctx = {
      path: task.src, name: task.name, ext: task.ext, info: { nome: task.name }, cat: null, el: body, tb, tab: { name: "lotto-" + task.seq, view: { hidden: true } },
      tools: TOOLS, registry: null, reason: null, setDirty() {}, status() {}, openPaths() {}, openAs() {}, openFile() {}, fillBody() {},
    };
    a = await mod.mount(ctx);
    if (!a?.save) throw new Error(tr("batch.modello_non_si_aperto"));
    await a.save(task.out);
  } finally {
    try { a?.dispose?.(); } catch { /* */ }
    host.remove();
  }
}

// ---------------------------------------------------------------- menu del pannello Esplora (clic destro)
export function explorerMenu(ev, path, isDir, openFile) {
  loadCss("css/batch.css");
  document.querySelectorAll(".bt-ctx").forEach(m => m.remove());
  const m = el("div", { class: "menu bt-ctx" });
  const item = (text, fn) => el("button", { type: "button", onclick: () => { m.remove(); fn(); } }, el("span", {}, text));
  if (isDir) m.append(item(tr("batch.conversione_lotti_questa_cartella"), () => openBatch({ paths: [path] })));
  else m.append(item(tr("batch.apri"), () => openFile(path)), item(tr("batch.conversione_lotti_partire_questo_file"), () => openBatch({ paths: [path] })));
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(ev.clientX, innerWidth - r.width - 8) + "px";
  m.style.top = Math.min(ev.clientY, innerHeight - r.height - 8) + "px";
  const off = e => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("mousedown", off, true); } };
  setTimeout(() => document.addEventListener("mousedown", off, true));
}

// per le prove dalla console
window.MBBatch = { openBatch, runners, follow };
