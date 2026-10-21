// Conversione a lotti: una o piu' cartelle (con o senza sottocartelle) o file scelti -> un formato, in background.
// Motore: mbvisual/batch.py (api/batch?op=scan|start|status|cancel|take|client). La coda gira nel motore; questa pagina
// mostra avanzamento e rapporto e fa da "esecutore" per i file che si leggono solo nel browser:
// - DWG (senza ODA File Converter): libredwg decodifica il disegno qui e il database va al motore, che con ezdxf
//   ricostruisce modello e fogli e li stampa in PDF/SVG/PNG;
// - modelli 3D e BIM: il visualizzatore 3D si monta in un contenitore fuori schermo e salva con il suo "Salva con nome".
import { api, baseName, el, fmtSize, loadCss, pickFiles, pickFolder, readBytes, toast } from "./core.js";

const FAM = {
  cad: "disegni CAD", model3d: "modelli 3D / BIM", word: "Word", sheet: "fogli di calcolo", slides: "presentazioni", pdf: "PDF",
  image: "immagini", svg: "SVG", media: "video", audio: "audio", email: "email", html: "pagine web", markdown: "Markdown", text: "testo",
  xps: "XPS", epub: "eBook", archive: "archivi", font: "font", database: "database", altro: "non convertibili",
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
  return false;
}
const OP_HELP = {
  pdf: "Documenti Office, email, immagini, pagine web, testo e disegni CAD (tutti i fogli) in PDF.",
  format: "Ogni file nel formato scelto, se il suo tipo lo consente (es. modelli 3D in GLB/STEP/IFC, PDF in Word).",
  image: "Ridimensiona, cambia formato e comprimi le immagini (anche RAW e HEIC).",
  pdf_merge: "Un solo PDF con un segnalibro per file; gli altri documenti si convertono prima in PDF.",
  pdf_compress: "Ricomprime le immagini interne e riduce i caratteri incorporati.",
  pdf_ocr: "Aggiunge il testo invisibile alle scansioni (riconoscimento del testo di Windows, italiano).",
  video: "H.264 + AAC in MP4, con qualita' e risoluzione a scelta.",
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
      keep_meta: false, name: "Unione", convert_others: true, bookmarks: true, dpi: 150, cquality: 75, ocr_dpi: 300, crf: 26, vmax_h: 1080, audio_kbps: 128, mute: false, report_file: true }, ...(saved.opts || {}) },
    out: { mode: "accanto", dir: "", collision: "rinomina", suffix: "", ...(saved.out || {}) },
  };
  const D = frame("Conversione a lotti");
  D.onKey = e => { if (e.key === "Escape") closeDlg(); };
  document.addEventListener("keydown", D.onKey);

  const srcList = el("div", { class: "bt-src" });
  const sum = el("div", { class: "bt-sum" });
  const rec = el("input", { type: "checkbox", checked: S.recursive || undefined });
  rec.addEventListener("change", () => { S.recursive = rec.checked; rescan(); });
  const ops = el("div", { class: "bt-ops" });
  const optBox = el("div", { class: "bt-sec" });
  const outBox = el("div", { class: "bt-sec" });
  const startBtn = btn("Avvia conversione", () => start(), "primary");
  D.body.append(
    el("div", { class: "bt-sec" }, el("h4", {}, "File da convertire"), srcList,
      el("div", { class: "bt-line" }, btn("Aggiungi cartella...", async () => { const d = await pickFolder(); if (d) { S.sources.push(d); rescan(); } }),
        btn("Aggiungi file...", async () => { const f = await pickFiles(); if (f?.length) { S.sources.push(...f); rescan(); } }),
        el("label", { class: "bt-chk" }, rec, "Includi le sottocartelle")), sum),
    el("div", { class: "bt-sec" }, el("h4", {}, "Operazione"), ops), optBox, outBox);
  D.foot.append(el("span", { class: "bt-note grow" }, "La conversione continua in background: puoi lavorare negli altri file."), btn("Annulla", closeDlg), startBtn);

  const targetsOf = f => (S.scan?.fam_targets?.[f.fam] || []); // formati possibili per tipo di file (dal motore)
  async function rescan() {
    renderSources();
    sum.textContent = S.sources.length ? "Lettura delle cartelle..." : "Scegli una cartella o dei file.";
    S.scan = null;
    renderOps();
    if (!S.sources.length) return;
    try {
      const r = await api("batch", { op: "scan" }, { json: { paths: S.sources, recursive: S.recursive } });
      S.scan = r;
      const parts = Object.entries(r.counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${FAM[k] || k}`);
      const size = r.files.reduce((a, f) => a + f.size, 0);
      sum.innerHTML = "";
      sum.append(el("b", {}, `${r.files.length} file`), ` (${fmtSize(size)}): ${parts.join(", ")}` + (r.troppi ? " - elenco limitato ai primi 20.000 file" : ""));
      if (!r.targets.some(t => t.ext === S.opts.to)) S.opts.to = (r.targets.find(t => t.ext !== "pdf") || r.targets[0] || {}).ext || "";
    } catch (e) { sum.textContent = "Lettura non riuscita: " + e.message; }
    renderOps();
  }

  function renderSources() {
    srcList.innerHTML = "";
    if (!S.sources.length) srcList.append(el("div", { class: "bt-note" }, "Nessuna cartella o file scelto."));
    S.sources.forEach((p, i) => srcList.append(el("div", { class: "row" }, el("span", {}, /\.[^\\/]+$/.test(p) ? "File" : "Cartella"),
      el("span", { class: "p", title: p }, p), el("button", { class: "btn", type: "button", title: "Togli", onclick: () => { S.sources.splice(i, 1); rescan(); } }, "Togli"))));
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
    startBtn.textContent = n ? `Avvia conversione (${n} file)` : "Avvia conversione";
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
    sel("Cosa stampare", "layouts", [["fogli", "I fogli (layout); il modello se non ce ne sono"], ["modello", "Solo il modello"], ["tutti", "Il modello e tutti i fogli"]]),
    sel("Formato carta", "paper", [["auto", "Automatico (come il foglio; A3 per il modello)"], ...["A4", "A3", "A2", "A1", "A0"].map(p => [p, p])]),
    sel("Orientamento", "orient", [["auto", "Automatico"], ["orizzontale", "Orizzontale"], ["verticale", "Verticale"]]),
    sel("Scala (modello)", "scale", [[0, "Adatta al foglio"], ...[1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000, 2000].map(n => [n, "1:" + n])], "", Number),
    sel("Colori", "colors", [["colori", "A colori"], ["bn", "Bianco e nero"], ["grigi", "Scala di grigi"]]),
    chk("Spessori di linea", "lineweights"),
  ];
  function renderOpts() {
    optBox.innerHTML = "";
    const g = el("div", { class: "bt-grid" });
    const notes = [];
    const fams = new Set((S.scan?.files || []).filter(f => applies(S.op, f, S.opts, targetsOf)).map(f => f.fam));
    const o = S.opts;
    if (S.op === "format") {
      const ts = S.scan?.targets || [];
      const s = el("select", { class: "field" }, ts.map(t => el("option", { value: t.ext, selected: t.ext === o.to || undefined }, `${t.ext.toUpperCase()} - ${t.label} (${t.n} file)`)));
      s.addEventListener("change", () => { o.to = s.value; renderOps(); });
      g.append(field("Formato di destinazione", s));
    }
    const cad = fams.has("cad") && (S.op === "pdf" || (S.op === "format" && ["pdf", "png", "svg"].includes(o.to)));
    if (cad) { g.append(...cadOpts()); notes.push("Disegni: i DWG si leggono con il lettore interno; con ODA File Converter installato (gratuito) si usano le impostazioni di stampa salvate nel disegno. Un PDF per disegno, una pagina per foglio, con i segnalibri."); }
    if (S.op === "pdf" && (fams.has("word") || fams.has("sheet") || fams.has("slides"))) notes.push("Word, Excel e PowerPoint convertono con i programmi Office di questo PC (restano aperti per tutto il lotto: il primo file e' il piu' lento).");
    if (S.op === "format" && fams.has("model3d")) notes.push("Modelli 3D: STEP e IFC contengono superfici a facce piane ricavate dal modello (nomi e colori degli oggetti si conservano).");
    if (S.op === "image") {
      g.append(sel("Formato", "to_img", [["uguale", "Lo stesso dell'originale"], ["jpg", "JPG"], ["png", "PNG"], ["webp", "WEBP"], ["tiff", "TIFF"], ["avif", "AVIF"], ["bmp", "BMP"]]),
        sel("Dimensioni", "imgsize", [["uguali", "Invariate"], ["max", "Lato massimo"], ["pct", "Percentuale"]]));
      if (o.imgsize === "max") g.append(num("Larghezza massima (px)", "max_w", 16, 20000), num("Altezza massima (px)", "max_h", 16, 20000));
      if (o.imgsize === "pct") g.append(num("Percentuale", "percent", 1, 400));
      g.append(num("Qualita' JPG/WEBP/AVIF (1-100)", "quality", 1, 100), chk("Conserva i dati EXIF (data, fotocamera, GPS)", "keep_meta"));
    }
    if (S.op === "pdf_merge") {
      g.append(txt("Nome del PDF unico", "name"), chk("Converti anche documenti, immagini e disegni", "convert_others"), chk("Un segnalibro per ogni file", "bookmarks"));
      notes.push("Ordine delle pagine: per cartella e nome del file (ordine alfabetico). Il PDF unico va nella cartella di uscita o in quella del primo file.");
      if (S.opts.convert_others && fams.has("cad")) g.append(...cadOpts());
    }
    if (S.op === "pdf_compress") g.append(sel("Risoluzione delle immagini", "dpi", [[72, "72 dpi (schermo)"], [96, "96 dpi"], [120, "120 dpi"], [150, "150 dpi (consigliata)"], [200, "200 dpi (stampa)"]], "", Number),
      sel("Qualita' delle immagini", "cquality", [[50, "Bassa"], [65, "Media"], [75, "Buona"], [85, "Alta"]], "", Number));
    if (S.op === "pdf_ocr") { g.append(sel("Risoluzione di lettura", "ocr_dpi", [[200, "200 dpi (veloce)"], [300, "300 dpi (consigliata)"], [400, "400 dpi (testi piccoli)"]], "", Number)); notes.push("Le pagine che hanno gia' del testo restano come sono."); }
    if (S.op === "video") g.append(sel("Qualita'", "crf", [[22, "Alta"], [26, "Media (consigliata)"], [30, "Ridotta"], [34, "Minima"]], "", Number),
      sel("Altezza massima", "vmax_h", [[0, "Originale"], [2160, "2160 (4K)"], [1440, "1440"], [1080, "1080 (Full HD)"], [720, "720 (HD)"], [480, "480"]], "", Number),
      sel("Audio", "audio_kbps", [[96, "96 kbps"], [128, "128 kbps"], [192, "192 kbps"]], "", Number), chk("Togli l'audio", "mute"));
    if (!g.childElementCount && !notes.length) return;
    optBox.append(el("h4", {}, "Opzioni"), g, ...notes.map(n => el("p", { class: "bt-note" }, n)));
  }

  // ---- uscita
  function renderOut() {
    outBox.innerHTML = "";
    const radio = (v, label) => {
      const r = el("input", { type: "radio", name: "bt-out", checked: S.out.mode === v || undefined });
      r.addEventListener("change", () => { S.out.mode = v; renderOps(); });
      return el("label", { class: "bt-chk" }, r, label);
    };
    const dir = el("input", { class: "field", type: "text", value: S.out.dir, placeholder: "Cartella di uscita" });
    dir.addEventListener("change", () => { S.out.dir = dir.value.trim(); renderOps(); });
    const coll = el("select", { class: "field" }, [["rinomina", "Aggiungi un numero al nome"], ["sovrascrivi", "Sostituisci"], ["salta", "Non convertire"]].map(([v, l]) => el("option", { value: v, selected: S.out.collision === v || undefined }, l)));
    coll.addEventListener("change", () => { S.out.collision = coll.value; });
    const suf = el("input", { class: "field", type: "text", value: S.out.suffix, placeholder: "es. _rev" });
    suf.addEventListener("input", () => { S.out.suffix = suf.value; });
    const box = el("div", { class: "bt-out" }, radio("accanto", "Accanto agli originali"), radio("cartella", "In una cartella, con la stessa struttura di sottocartelle"));
    if (S.out.mode === "cartella") {
      box.append(el("div", { class: "path" }, dir, btn("Scegli...", async () => { const d = await pickFolder(); if (d) { S.out.dir = d; renderOps(); } })));
      const rep = el("input", { type: "checkbox", checked: S.opts.report_file ? true : undefined });
      rep.addEventListener("change", () => { S.opts.report_file = rep.checked; });
      box.append(el("label", { class: "bt-chk" }, rep, "Salva il rapporto (CSV) nella cartella di uscita"));
    }
    box.append(el("div", { class: "bt-grid" }, field("Se il file di uscita esiste gia'", coll), field("Aggiungi al nome dei file", suf)));
    outBox.append(el("h4", {}, "Dove salvare"), box);
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
    store({ recursive: S.recursive, op: S.op, opts: S.opts, out: { ...S.out } });
    try {
      const files = S.scan.files.map(f => ({ path: f.path, rel: f.rel }));
      const r = await api("batch", { op: "start" }, { json: { op: S.op, opts, files, out: S.out } });
      follow(r.id, true);
    } catch (e) { toast("Conversione non avviata: " + e.message, true, 6000); }
  }

  renderSources();
  renderOps();
  rescan();
}
const OPS_FALLBACK = {
  pdf: "Converti in PDF", format: "Converti in un altro formato", image: "Immagini: ridimensiona, converti, comprimi", pdf_merge: "Unisci in un unico PDF",
  pdf_compress: "PDF: comprimi", pdf_ocr: "PDF scansionati: rendi ricercabili (OCR)", video: "Video: MP4 compresso",
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
      const t = `Conversione a lotti ${s.status === "annullato" ? "interrotta" : "finita"}: ${s.riusciti} riusciti` + (s.falliti ? `, ${s.falliti} non riusciti` : "");
      toast(t, s.falliti > 0, 6000);
      renderChip();
      break;
    }
    await sleep(dlg?.id === R.id ? 600 : 1000);
  }
}

function showProgress(id) {
  const R = runners.get(id);
  const D = frame("Conversione a lotti");
  D.id = id;
  D.onKey = e => { if (e.key === "Escape") { closeDlg(); renderChip(); } };
  document.addEventListener("keydown", D.onKey);
  R.ui = null;
  D.body.append(el("div", { class: "bt-note" }, "Lettura dello stato..."));
  renderChip();
  // stato completo (con l'elenco aggiornato dei file): mentre la finestra era ridotta si leggeva solo il riepilogo
  api("batch", { op: "status", id }).then(s => { if (s.ok) { R.state = s; R.ui = null; renderProgress(R); } }).catch(() => {});
}

const ST = { ok: "Riuscito", errore: "Non riuscito", saltato: "Saltato", annullato: "Annullato", attesa: "In coda", "in corso": "In corso" };
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
        s.report ? btn("Apri il rapporto", () => api("open_external", { path: s.report }).catch(e => toast(e.message, true))) : null,
        s.unito ? btn("Apri il PDF unico", () => window.MB?.openFile(s.unito)) : null,
        btn("Apri la cartella di uscita", () => reveal(s)), el("span", { class: "grow" }),
        btn("Nuova conversione...", () => openBatch({ paths: [] })), btn("Chiudi", () => { closeDlg(); runners.delete(R.id); renderChip(); }, "primary")].filter(Boolean));
    } else {
      D.foot.append(el("span", { class: "bt-note grow" }, "Puoi ridurre la finestra e continuare a lavorare: la coda prosegue."),
        btn("Interrompi la coda", async () => { await api("batch", { op: "cancel", id: R.id }); toast("Interruzione: si ferma dopo il file in corso (i video si fermano subito)"); }, "danger"),
        btn("Riduci", () => { closeDlg(); renderChip(); }, "primary"));
    }
    R.ui = { bar, stats, cur, tabs, list, end, sig: "" };
  }
  const U = R.ui;
  U.bar.firstChild.style.width = Math.round((s.progress || 0) * 100) + "%";
  U.stats.innerHTML = "";
  U.stats.append(el("span", {}, `${s.fatti} di ${s.da_fare} file`), el("span", { class: "ok" }, `${s.riusciti} riusciti`), el("span", { class: "bad" }, `${s.falliti} non riusciti`),
    el("span", { class: "skip" }, `${s.saltati} saltati`), el("span", { class: "skip" }, elapsed(s)));
  const curItem = s.items && s.current >= 0 ? s.items[s.current] : null;
  U.cur.textContent = end ? (s.status === "annullato" ? "Coda interrotta." : s.status === "errore" ? "Errore: " + s.message : "Finito." + (s.unito ? " PDF unico: " + s.unito : ""))
    : s.status === "attesa" ? "In attesa che finisca il lotto precedente..." : curItem ? "In corso: " + curItem.rel + (s.task ? " (lettura nella finestra dell'app)" : "") : s.message || "";
  if (!s.items) return;
  const counts = { tutti: s.items.length, errore: s.falliti, ok: s.riusciti, saltato: s.saltati };
  const sig = s.items.map(i => i.status[0] + i.msg.length).join("") + R.filter + s.current;
  if (sig === U.sig) return;
  U.sig = sig;
  U.tabs.innerHTML = "";
  for (const [k, l] of [["tutti", "Tutti"], ["errore", "Non riusciti"], ["ok", "Riusciti"], ["saltato", "Saltati"]]) {
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
  chip.append(el("div", { class: "t" }, el("b", {}, end ? `Lotto ${s.status === "annullato" ? "interrotto" : "finito"}` : `${s.label}: ${s.fatti}/${s.da_fare}`),
    btn("Dettagli", () => showProgress(R.id)), end ? btn("x", () => { runners.delete(R.id); renderChip(); }) : null),
  el("div", { class: "bt-bar" }, el("span", { style: { width: Math.round((s.progress || 0) * 100) + "%" } })),
  el("div", { class: "c" }, end ? `${s.riusciti} riusciti, ${s.falliti} non riusciti` : cur || ""));
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
    else throw new Error("Compito sconosciuto: " + task.kind);
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
    if (!a?.save) throw new Error("Il modello non si e' aperto");
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
  if (isDir) m.append(item("Conversione a lotti di questa cartella...", () => openBatch({ paths: [path] })));
  else m.append(item("Apri", () => openFile(path)), item("Conversione a lotti a partire da questo file...", () => openBatch({ paths: [path] })));
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(ev.clientX, innerWidth - r.width - 8) + "px";
  m.style.top = Math.min(ev.clientY, innerHeight - r.height - 8) + "px";
  const off = e => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("mousedown", off, true); } };
  setTimeout(() => document.addEventListener("mousedown", off, true));
}

// per le prove dalla console
window.MBBatch = { openBatch, runners, follow };
