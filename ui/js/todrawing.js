// "Converti in disegno (DXF)": PDF vettoriali, PDF scansionati e immagini -> DXF/DWG (motore mbvisual/todrawing.py).
// Finestra con le opzioni a sinistra e l'anteprima sovrapposta all'originale a destra (rotella = zoom, trascina = sposta).
// Le coordinate dell'anteprima sono millimetri della carta con y verso l'alto: ogni sorgente ha i suoi mm per unita'
// (punto PDF = 25,4/72, pixel = 25,4/dpi), cosi' la quota nota si misura sempre in mm della carta (opts.ref_mm).
// Solo app per PC. Il risultato si apre subito nell'editor CAD.
import { api, baseName, dirName, el, fileUrl, loadCss, pickSavePath, toast, waitJob } from "./core.js";
import { t as tr, fmtNum } from "./i18n.js";

const KEY = "mbv-disegno";
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } };
const savePrefs = p => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* */ } };
const SCALES = [1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 200, 250, 500, 1000, 2000, 5000];
const UDIV = { mm: 1, cm: 10, m: 1000 };
const IMG_EXT = /^(png|jpe?g|jpe|jfif|tiff?|bmp|dib|gif|webp|avif|heic|heif|jp2|j2k|jpx|tga|pcx|ppm|pgm|pbm|pnm|qoi|psd)$/i;

export function canConvert(path) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  return ext === "pdf" || IMG_EXT.test(ext);
}

export async function openToDrawing({ path, out = null, openFile = null }) {
  window.MBStat?.track("fn", "converti_disegno"); // statistiche anonime (solo con consenso)
  loadCss("css/todrawing.css");
  const prefs = loadPrefs();
  let info;
  try { info = await api("drawing", { op: "info", path }); } catch (e) { return toast(tr("todrawing.non_leggibile") + e.message, true, 6000); }
  const isPdf = info.pdf;
  const S = {
    page: 0, scaleMode: prefs.scaleMode || "ratio", scale: prefs.scale || 100, units: prefs.units || "mm", layout: prefs.layout || "model",
    pages: "all", range: "", method: "auto", layers: prefs.layers || "auto", arcs: true, seg_arcs: true, mtext: true, texts: true, fills: "hatch",
    skip_white: true, deskew: true, flatten: true, thAuto: true, threshold: 160, speckAuto: true, speck: 16, vmode: prefs.vmode || "center",
    vtol: 1.0, ortho: true, ocr: true, ocr_vertical: true, dpi: 300, img_dpi: info.dpi ? Math.round(info.dpi) : "", to: out ? (out.toLowerCase().endsWith(".dwg") ? "dwg" : "dxf") : "dxf",
    open: prefs.open !== false, ref: null, refLen: "", view: "overlay", picking: 0, pick: [],
  };
  const pageInfo = () => info.pages[S.page] || {};
  const detected = () => (pageInfo().scales || []);
  if (S.scaleMode === "ratio" && detected().length && !prefs.scaleMode) S.scale = detected()[0];
  const isRaster = () => (S.method === "raster") || (S.method === "auto" && (!isPdf || pageInfo().raster));

  // ---------------------------------------------------------------- struttura
  const head = el("div", { class: "td-head" }, el("b", {}, tr("todrawing.titolo")), el("span", { class: "td-sub" }, baseName(path)),
    el("span", { class: "grow" }), el("button", { class: "btn td-x", type: "button", title: tr("common.chiudi"), onclick: () => close() }, "×"));
  const side = el("div", { class: "td-side" });
  const canvas = el("canvas", { class: "td-cv" });
  const stage = el("div", { class: "td-stage" }, canvas);
  const busy = el("div", { class: "td-busy", hidden: true }, el("span", { class: "td-spin" }), el("span", {}));
  const banner = el("div", { class: "td-banner", hidden: true }, tr("todrawing.avviso_approssimato"));
  const legend = el("div", { class: "td-legend" });
  const viewSeg = el("div", { class: "seg td-viewseg" });
  const pageNav = el("div", { class: "td-nav" });
  const tip = el("div", { class: "td-tip", hidden: true });
  stage.append(busy, tip);
  const prev = el("div", { class: "td-prev" }, banner, el("div", { class: "td-bar" }, viewSeg, pageNav, el("span", { class: "grow" }), legend), stage);
  const msg = el("span", { class: "td-msg" });
  const prog = el("progress", { max: 1, value: 0, hidden: true });
  const bPrev = el("button", { class: "btn", type: "button", onclick: () => runPreview() }, tr("todrawing.anteprima"));
  const bGo = el("button", { class: "btn primary", type: "button", onclick: () => convert() }, tr("todrawing.converti"));
  const foot = el("div", { class: "td-foot" }, msg, prog, bPrev, el("button", { class: "btn", type: "button", onclick: () => close() }, tr("common.annulla")), bGo);
  const dlg = el("div", { class: "td-dlg", role: "dialog" }, head, el("div", { class: "td-main" }, side, prev), foot);
  const back = el("div", { class: "td-back", tabindex: "-1" }, dlg);
  document.body.append(back);
  back.focus();
  const onKey = e => {
    if (e.key === "Escape") { e.stopPropagation(); if (S.picking) { S.picking = 0; S.pick = []; tip.hidden = true; draw(); } else close(); }
  };
  back.addEventListener("keydown", onKey);
  let closed = false;
  function close() { closed = true; back.remove(); }

  // ---------------------------------------------------------------- opzioni
  const sec = (title, ...kids) => el("div", { class: "td-sec" }, el("h4", {}, title), ...kids);
  const row = (label, ...kids) => el("label", { class: "td-row" }, el("span", {}, label), ...kids);
  const chk = (label, key, title = "") => {
    const c = el("input", { type: "checkbox", checked: S[key] ? true : undefined });
    c.addEventListener("change", () => { S[key] = c.checked; changed(); });
    return el("label", { class: "td-check", title }, c, label);
  };
  const select = (key, options, after = null) => {
    const s = el("select", {}, options.map(([v, l]) => el("option", { value: String(v), selected: String(S[key]) === String(v) || undefined }, l)));
    s.addEventListener("change", () => { S[key] = isNaN(+s.value) || s.value === "" ? s.value : +s.value; if (after) after(); changed(); render(); });
    return s;
  };
  const number = (key, min, max, step) => {
    const i = el("input", { type: "number", min, max, step, value: S[key] });
    i.addEventListener("change", () => { S[key] = +i.value || S[key]; changed(); });
    return i;
  };
  let dirty = false;
  function changed() { dirty = true; bPrev.classList.add("primary-soft"); setMsg(tr("todrawing.opzioni_cambiate")); }

  function render() {
    side.innerHTML = "";
    // sorgente
    const kind = isPdf ? (pageInfo().raster ? tr("todrawing.tipo_pdf_scansione") : tr("todrawing.tipo_pdf_vettoriale")) : tr("todrawing.tipo_immagine");
    const src = sec(tr("todrawing.sorgente"), el("p", { class: "td-note" }, kind + (isPdf && info.ocgs?.length ? " · " + tr("todrawing.0_layer_ocg", info.ocgs.length) : "")));
    if (isPdf) src.append(row(tr("todrawing.metodo"), select("method", [["auto", tr("todrawing.metodo_auto")], ["vector", tr("todrawing.metodo_vettoriale")], ["raster", tr("todrawing.metodo_scansione")]])));
    if (info.pages.length > 1) {
      const rng = el("input", { type: "text", value: S.range, placeholder: "1-3, 5" });
      rng.addEventListener("input", () => { S.range = rng.value; });
      src.append(row(tr("todrawing.pagine_da_convertire"), select("pages", [["all", tr("todrawing.tutte_0", info.pages.length)], ["this", tr("todrawing.solo_questa")], ["range", tr("todrawing.intervallo")]])));
      if (S.pages === "range") src.append(row("", rng));
      src.append(row(tr("todrawing.pagine"), select("layout", [["model", tr("todrawing.pagine_modello")], ["sheets", tr("todrawing.pagine_fogli")]])));
    } else {
      src.append(row(tr("todrawing.fogli"), select("layout", [["model", tr("todrawing.solo_modello")], ["sheets", tr("todrawing.modello_e_foglio")]])));
    }
    side.append(src);
    // scala
    const sc = sec(tr("todrawing.scala"));
    const radio = (v, label) => {
      const r = el("input", { type: "radio", name: "td-scale", checked: S.scaleMode === v || undefined });
      r.addEventListener("change", () => { S.scaleMode = v; changed(); render(); draw(); });
      return el("label", { class: "td-check" }, r, label);
    };
    sc.append(radio("paper", tr("todrawing.scala_carta")));
    const ratio = el("div", { class: "td-line" }, radio("ratio", tr("todrawing.in_scala")), el("span", {}, "1 :"));
    const n = el("input", { type: "number", min: 1, max: 100000, step: 1, value: S.scale, list: "td-scales" });
    n.addEventListener("change", () => { S.scale = Math.max(1, +n.value || 1); S.scaleMode = "ratio"; changed(); render(); });
    ratio.append(n, el("datalist", { id: "td-scales" }, SCALES.map(v => el("option", { value: v }))));
    sc.append(ratio);
    if (detected().length) {
      const chips = el("div", { class: "td-chips" }, el("span", { class: "td-note" }, tr("todrawing.trovata_tavola")));
      for (const v of detected()) chips.append(el("button", { class: "td-chip" + (S.scaleMode === "ratio" && S.scale === v ? " on" : ""), type: "button", onclick: () => { S.scale = v; S.scaleMode = "ratio"; changed(); render(); } }, "1:" + v));
      sc.append(chips);
    }
    sc.append(radio("ref", tr("todrawing.da_quota_nota")));
    if (S.scaleMode === "ref") {
      const len = el("input", { type: "number", min: 0, step: "any", value: S.refLen, placeholder: tr("todrawing.misura_reale") });
      len.addEventListener("input", () => { S.refLen = len.value; changed(); refNote.textContent = refText(); });
      const refNote = el("p", { class: "td-note" }, refText());
      sc.append(el("div", { class: "td-line" }, el("button", { class: "btn" + (S.picking ? " on" : ""), type: "button", onclick: () => startPick() }, tr("todrawing.indica_due_punti")), len, el("span", {}, S.units)), refNote);
    }
    sc.append(row(tr("todrawing.unita"), select("units", [["mm", tr("todrawing.unita_mm")], ["cm", tr("todrawing.unita_cm")], ["m", tr("todrawing.unita_m")]])));
    side.append(sc);
    if (!isRaster()) {
      side.append(sec(tr("todrawing.ricostruzione"),
        row(tr("todrawing.layer"), select("layers", [["auto", tr("todrawing.layer_auto")], ["ocg", tr("todrawing.layer_ocg")], ["color", tr("todrawing.layer_colore")], ["single", tr("todrawing.layer_unico")]])),
        chk(tr("todrawing.archi_cerchi"), "arcs", tr("todrawing.archi_cerchi_aiuto")), chk(tr("todrawing.archi_segmenti"), "seg_arcs", tr("todrawing.archi_segmenti_aiuto")),
        chk(tr("todrawing.testi"), "texts"), chk(tr("todrawing.mtext"), "mtext"),
        row(tr("todrawing.riempimenti"), select("fills", [["hatch", tr("todrawing.riempimenti_hatch")], ["none", tr("todrawing.riempimenti_no")]])),
        chk(tr("todrawing.ignora_bianchi"), "skip_white", tr("todrawing.ignora_bianchi_aiuto"))));
    } else {
      const res = isPdf ? row(tr("todrawing.risoluzione"), select("dpi", [[200, "200 dpi"], [300, tr("todrawing.300_dpi")], [400, "400 dpi"], [600, "600 dpi"]]))
        : row(tr("todrawing.risoluzione"), el("div", { class: "td-line" }, (() => { const i = el("input", { type: "number", min: 50, max: 2400, step: 1, value: S.img_dpi, placeholder: "300" }); i.addEventListener("change", () => { S.img_dpi = +i.value || ""; changed(); }); return i; })(), el("span", {}, "dpi")));
      const th = el("input", { type: "range", min: 30, max: 240, value: S.threshold, disabled: S.thAuto || undefined });
      th.addEventListener("change", () => { S.threshold = +th.value; changed(); });
      const sp = el("input", { type: "number", min: 0, max: 5000, value: S.speck, disabled: S.speckAuto || undefined });
      sp.addEventListener("change", () => { S.speck = +sp.value || 0; changed(); });
      const autoTh = chk(tr("todrawing.automatica"), "thAuto");
      autoTh.querySelector("input").addEventListener("change", () => { th.disabled = S.thAuto; });
      const autoSp = chk(tr("todrawing.automatica"), "speckAuto");
      autoSp.querySelector("input").addEventListener("change", () => { sp.disabled = S.speckAuto; });
      side.append(sec(tr("todrawing.pulizia"), res, chk(tr("todrawing.raddrizza"), "deskew"), chk(tr("todrawing.uniforma_sfondo"), "flatten", tr("todrawing.uniforma_sfondo_aiuto")),
        row(tr("todrawing.soglia"), el("div", { class: "td-line" }, autoTh, th)),
        row(tr("todrawing.macchie"), el("div", { class: "td-line" }, autoSp, sp, el("span", {}, "px")))));
      const tol = el("input", { type: "range", min: 0.5, max: 4, step: 0.25, value: S.vtol });
      const tolv = el("span", { class: "td-val" }, fmtNum(S.vtol, 2) + " px");
      tol.addEventListener("input", () => { S.vtol = +tol.value; tolv.textContent = fmtNum(S.vtol, 2) + " px"; });
      tol.addEventListener("change", changed);
      side.append(sec(tr("todrawing.vettorizzazione"),
        row(tr("todrawing.vettorizza"), select("vmode", [["center", tr("todrawing.linee_asse")], ["outline", tr("todrawing.solo_contorni")]])),
        el("p", { class: "td-note" }, S.vmode === "center" ? tr("todrawing.linee_asse_aiuto") : tr("todrawing.solo_contorni_aiuto")),
        row(tr("todrawing.tolleranza"), el("div", { class: "td-line" }, tol, tolv)),
        chk(tr("todrawing.archi_cerchi"), "arcs"), chk(tr("todrawing.ortogonali"), "ortho", tr("todrawing.ortogonali_aiuto")),
        chk(tr("todrawing.ocr"), "ocr"), chk(tr("todrawing.ocr_verticali"), "ocr_vertical")));
    }
    const outs = [["dxf", "DXF"], ...(info.oda ? [["dwg", "DWG"]] : [])];
    side.append(sec(tr("todrawing.uscita"), row(tr("todrawing.formato"), select("to", outs)),
      info.oda ? null : el("p", { class: "td-note" }, tr("todrawing.dwg_serve_oda")), chk(tr("todrawing.apri_editor"), "open")));
    banner.hidden = !isRaster();
    renderNav();
  }

  function refText() {
    if (!S.ref) return tr("todrawing.quota_istruzioni");
    const mm = Math.hypot(S.ref[2] - S.ref[0], S.ref[3] - S.ref[1]);
    const len = parseFloat(String(S.refLen).replace(",", "."));
    let t = tr("todrawing.distanza_carta_0", fmtNum(mm, 2));
    if (len > 0 && mm > 0) t += " · " + tr("todrawing.scala_risultante_0", "1:" + fmtNum(len * UDIV[S.units] / mm, 1));
    return t;
  }

  function renderNav() {
    pageNav.innerHTML = "";
    if (info.pages.length > 1) {
      const go = d => { const p = Math.max(0, Math.min(info.pages.length - 1, S.page + d)); if (p !== S.page) { S.page = p; S.ref = null; render(); loadPage(); } };
      pageNav.append(el("button", { class: "btn", type: "button", onclick: () => go(-1), disabled: S.page === 0 || undefined }, "‹"),
        el("span", {}, tr("todrawing.pagina_0_1", S.page + 1, info.pages.length)),
        el("button", { class: "btn", type: "button", onclick: () => go(1), disabled: S.page >= info.pages.length - 1 || undefined }, "›"));
    }
    viewSeg.innerHTML = "";
    for (const [v, l] of [["overlay", tr("todrawing.vista_sovrapposta")], ["drawing", tr("todrawing.vista_disegno")], ["image", tr("todrawing.vista_originale")]]) {
      viewSeg.append(el("button", { type: "button", class: S.view === v ? "on" : "", onclick: () => { S.view = v; renderNav(); draw(); } }, l));
    }
  }

  // ---------------------------------------------------------------- opzioni per il motore
  function opts() {
    const o = { units: S.units, layout: S.layout, method: S.method };
    if (S.scaleMode === "ratio") o.scale = S.scale;
    else if (S.scaleMode === "paper") o.scale = 1;
    else {
      const len = parseFloat(String(S.refLen).replace(",", "."));
      if (S.ref && len > 0) { o.ref_mm = Math.hypot(S.ref[2] - S.ref[0], S.ref[3] - S.ref[1]); o.ref_len = len; } else o.scale = 1;
    }
    if (isPdf) {
      o.pages = S.pages === "all" ? "all" : S.pages === "this" ? [S.page] : S.range;
      if (info.pages.length === 1) o.pages = "all";
    }
    Object.assign(o, { layers: S.layers, arcs: S.arcs, seg_arcs: S.seg_arcs, mtext: S.mtext, texts: S.texts, fills: S.fills, skip_white: S.skip_white });
    Object.assign(o, { deskew: S.deskew, flatten: S.flatten, threshold: S.thAuto ? "auto" : S.threshold, speck: S.speckAuto ? "auto" : S.speck, vmode: S.vmode,
      vtol: S.vtol, ortho: S.ortho, ocr: S.ocr, ocr_vertical: S.ocr_vertical, dpi: S.dpi });
    if (!isPdf && S.img_dpi) o.img_dpi = S.img_dpi;
    o.to = S.to;
    return o;
  }

  // ---------------------------------------------------------------- anteprima
  const V = { img: null, imgMm: null, data: null, paths: null, s: 1, ox: 0, oy: 0, fitted: false };
  let seq = 0;
  async function loadPage() {
    const my = ++seq;
    V.data = null; V.paths = null;
    showBusy(tr("todrawing.caricamento_pagina"));
    try {
      const r = await api("drawing", { op: "page", path, page: S.page, max: 2000 }, { raw: true });
      if (!r.ok) throw new Error(r.statusText);
      const w = +r.headers.get("X-W"), h = +r.headers.get("X-H");
      const blob = await r.blob();
      const img = await loadImg(URL.createObjectURL(blob));
      if (my !== seq) return;
      // mm della carta: pagina PDF in punti, immagine in pixel alla sua risoluzione
      const k = isPdf ? 25.4 / 72 : 25.4 / (S.img_dpi || info.dpi || 300);
      V.img = img; V.imgMm = [w * k, h * k]; V.fitted = false;
      fit(); draw();
    } catch (e) { setMsg(tr("todrawing.anteprima_non_riuscita") + e.message, true); }
    hideBusy();
    runPreview();
  }
  function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(tr("todrawing.immagine_non_leggibile"))); i.src = src; }); }

  async function runPreview() {
    const my = ++seq;
    dirty = false;
    bPrev.classList.remove("primary-soft");
    showBusy(isRaster() ? tr("todrawing.vettorizzazione_corso") : tr("todrawing.lettura_tracciati"));
    try {
      const { job } = await api("drawing", { op: "preview", path }, { json: { page: S.page, opts: opts() } });
      const r = await waitJob(job, (p, m) => { if (my === seq) showBusy((m || tr("todrawing.elaborazione")) + " " + Math.round(p * 100) + "%"); });
      if (my !== seq || closed) return;
      V.data = r;
      buildPaths();
      if (r.clean) { // scansione: si mostra l'immagine pulita e raddrizzata, che corrisponde alle coordinate del disegno
        const img = await loadImg(fileUrl(r.clean, "&v=" + Date.now()));
        if (my !== seq) return;
        V.img = img; V.imgMm = [r.w * r.unit_mm, r.h * r.unit_mm];
      }
      renderLegend();
      setMsg(r.method === "raster" ? (tr("todrawing.pronto_scansione") + (r.skew ? " · " + tr("todrawing.raddrizzata_0", fmtNum(r.skew, 2)) : "")) : tr("todrawing.pronto_vettoriale"));
      draw();
    } catch (e) { if (my === seq) setMsg(tr("todrawing.anteprima_non_riuscita") + e.message, true); }
    if (my === seq) hideBusy();
  }

  function renderLegend() {
    legend.innerHTML = "";
    const c = V.data?.counts || {};
    const names = { line: tr("todrawing.n_linee"), poly: tr("todrawing.n_polilinee"), arc: tr("todrawing.n_archi"), circle: tr("todrawing.n_cerchi"), spline: tr("todrawing.n_spline"),
      hatch: tr("todrawing.n_retini"), text: tr("todrawing.n_testi"), mtext: tr("todrawing.n_paragrafi") };
    for (const k of Object.keys(names)) if (c[k]) legend.append(el("span", { class: "td-count td-k-" + k }, el("b", {}, fmtNum(c[k], 0)), " " + names[k]));
    if (V.data?.truncated) legend.append(el("span", { class: "td-note" }, tr("todrawing.anteprima_parziale")));
  }

  // tracciati dell'anteprima in mm della carta (y verso l'alto), raggruppati per tipo
  function buildPaths() {
    const d = V.data;
    const k = d.unit_mm;
    const P = { line: new Path2D(), curve: new Path2D(), fill: new Path2D(), ends: [] };
    const bulgeTo = (p, x0, y0, x1, y1, b) => {
      if (!b) { p.lineTo(x1, y1); return; }
      const th = 4 * Math.atan(b), ch = Math.hypot(x1 - x0, y1 - y0), r = ch / (2 * Math.sin(Math.abs(th) / 2));
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, dd = Math.sqrt(Math.max(0, r * r - ch * ch / 4));
      const nx = -(y1 - y0) / ch, ny = (x1 - x0) / ch, sgn = (b > 0) === (Math.abs(th) < Math.PI) ? 1 : -1;
      const cx = mx + nx * dd * sgn, cy = my + ny * dd * sgn;
      p.arc(cx, cy, r, Math.atan2(y0 - cy, x0 - cx), Math.atan2(y1 - cy, x1 - cx), b < 0);
    };
    for (const e of d.ents) {
      const t = e.t;
      if (t === "line") { P.line.moveTo(e.p[0] * k, e.p[1] * k); P.line.lineTo(e.p[2] * k, e.p[3] * k); P.ends.push([e.p[0] * k, e.p[1] * k], [e.p[2] * k, e.p[3] * k]); }
      else if (t === "arc") {
        const a0 = e.a[0] * Math.PI / 180, a1 = e.a[1] * Math.PI / 180;
        P.curve.moveTo((e.c[0] + e.r * Math.cos(a0)) * k, (e.c[1] + e.r * Math.sin(a0)) * k);
        P.curve.arc(e.c[0] * k, e.c[1] * k, e.r * k, a0, a1, false);
        P.ends.push([(e.c[0] + e.r * Math.cos(a0)) * k, (e.c[1] + e.r * Math.sin(a0)) * k], [(e.c[0] + e.r * Math.cos(a1)) * k, (e.c[1] + e.r * Math.sin(a1)) * k]);
      } else if (t === "circle") { P.curve.moveTo((e.c[0] + e.r) * k, e.c[1] * k); P.curve.arc(e.c[0] * k, e.c[1] * k, e.r * k, 0, Math.PI * 2); P.ends.push([e.c[0] * k, e.c[1] * k]); }
      else if (t === "poly") {
        const v = e.v;
        if (!v.length) continue;
        P.line.moveTo(v[0][0] * k, v[0][1] * k);
        for (let i = 1; i < v.length; i++) bulgeTo(P.line, v[i - 1][0] * k, v[i - 1][1] * k, v[i][0] * k, v[i][1] * k, v[i - 1][2]);
        if (e.closed) bulgeTo(P.line, v[v.length - 1][0] * k, v[v.length - 1][1] * k, v[0][0] * k, v[0][1] * k, v[v.length - 1][2]);
        for (const q of v) P.ends.push([q[0] * k, q[1] * k]);
      } else if (t === "spline") {
        const c = e.cp;
        P.curve.moveTo(c[0][0] * k, c[0][1] * k);
        for (let i = 1; i + 2 < c.length; i += 3) P.curve.bezierCurveTo(c[i][0] * k, c[i][1] * k, c[i + 1][0] * k, c[i + 1][1] * k, c[i + 2][0] * k, c[i + 2][1] * k);
      } else if (t === "hatch") {
        for (const path of e.paths) {
          if (!path.length) continue;
          P.fill.moveTo(path[0][0] * k, path[0][1] * k);
          for (let i = 1; i < path.length; i++) bulgeTo(P.fill, path[i - 1][0] * k, path[i - 1][1] * k, path[i][0] * k, path[i][1] * k, path[i - 1][2]);
          P.fill.closePath();
        }
      }
    }
    P.texts = d.ents.filter(e => e.t === "text" || e.t === "mtext");
    V.paths = P;
  }

  const ctx = canvas.getContext("2d");
  function fit() {
    const r = stage.getBoundingClientRect();
    if (!V.imgMm || !r.width) return;
    V.s = Math.min((r.width - 40) / V.imgMm[0], (r.height - 40) / V.imgMm[1]);
    V.ox = (r.width - V.imgMm[0] * V.s) / 2;
    V.oy = (r.height - V.imgMm[1] * V.s) / 2;
    V.fitted = true;
  }
  // mm della carta (y in alto) -> pixel dello schermo
  const toScr = (x, y) => [V.ox + x * V.s, V.oy + (V.imgMm[1] - y) * V.s];
  const toMm = (sx, sy) => [(sx - V.ox) / V.s, V.imgMm[1] - (sy - V.oy) / V.s];

  function cssVar(n, f) { return getComputedStyle(back).getPropertyValue(n).trim() || f; }
  function draw() {
    const r = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(r.width * dpr) || canvas.height !== Math.round(r.height * dpr)) {
      canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
      canvas.style.width = r.width + "px"; canvas.style.height = r.height + "px";
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    if (!V.imgMm) return;
    if (!V.fitted) fit();
    const [x0, y0] = toScr(0, V.imgMm[1]);
    const W = V.imgMm[0] * V.s, H = V.imgMm[1] * V.s;
    ctx.fillStyle = "#fff";
    ctx.shadowColor = "rgba(0,0,0,.25)"; ctx.shadowBlur = 12;
    ctx.fillRect(x0, y0, W, H);
    ctx.shadowBlur = 0;
    if (V.img && S.view !== "drawing") {
      ctx.globalAlpha = S.view === "overlay" && V.paths ? 0.38 : 1;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(V.img, x0, y0, W, H);
      ctx.globalAlpha = 1;
    }
    if (V.paths && S.view !== "image") {
      const accent = cssVar("--accent", "#ea7426");
      ctx.save();
      ctx.setTransform(dpr * V.s, 0, 0, -dpr * V.s, dpr * V.ox, dpr * (V.oy + V.imgMm[1] * V.s));
      ctx.lineWidth = 1.25 / V.s;
      ctx.fillStyle = "rgba(60, 120, 200, .28)";
      ctx.fill(V.paths.fill, "evenodd");
      ctx.strokeStyle = S.view === "drawing" ? "#1d2125" : accent;
      ctx.stroke(V.paths.line);
      ctx.strokeStyle = S.view === "drawing" ? "#1d2125" : "#d02a7a";
      ctx.stroke(V.paths.curve);
      ctx.restore();
      // testi
      const k = V.data.unit_mm;
      ctx.fillStyle = S.view === "drawing" ? "#1d2125" : "#1f7ad6";
      for (const e of V.paths.texts) {
        const h = e.h * k * V.s;
        if (h < 2) continue;
        const [sx, sy] = toScr(e.p[0] * k, e.p[1] * k);
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(-(e.rot || 0) * Math.PI / 180);
        ctx.font = `${h / 0.716}px Arial, sans-serif`;
        if (e.t === "text") { ctx.scale(e.wf || 1, 1); ctx.fillText(e.s, 0, 0); }
        else {
          const sp = (e.spacing || e.h * 1.6) * k * V.s;
          e.lines.forEach((l, i) => ctx.fillText(l, 0, h + i * sp));
        }
        ctx.restore();
      }
    }
    // quota nota
    if (S.scaleMode === "ref" && (S.ref || S.pick.length)) {
      const pts = S.ref ? [[S.ref[0], S.ref[1]], [S.ref[2], S.ref[3]]] : S.pick.concat(V.hover ? [V.hover] : []);
      ctx.strokeStyle = "#00a35a"; ctx.fillStyle = "#00a35a"; ctx.lineWidth = 2;
      ctx.beginPath();
      pts.forEach((p, i) => { const [sx, sy] = toScr(p[0], p[1]); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); });
      ctx.stroke();
      for (const p of pts) { const [sx, sy] = toScr(p[0], p[1]); ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.fill(); }
    }
    if (S.picking && V.snap) {
      const [sx, sy] = toScr(V.snap[0], V.snap[1]);
      ctx.strokeStyle = "#00a35a"; ctx.lineWidth = 1.5;
      ctx.strokeRect(sx - 6, sy - 6, 12, 12);
    }
  }

  // ---------------------------------------------------------------- zoom, spostamento, due punti
  let drag = null;
  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const f = Math.exp(-e.deltaY * 0.0015);
    V.ox = mx - (mx - V.ox) * f; V.oy = my - (my - V.oy) * f; V.s *= f;
    draw();
  }, { passive: false });
  canvas.addEventListener("pointerdown", e => {
    const r = canvas.getBoundingClientRect();
    if (S.picking && e.button === 0) {
      const p = V.snap || toMm(e.clientX - r.left, e.clientY - r.top);
      S.pick.push(p);
      if (S.pick.length === 2) {
        S.ref = [S.pick[0][0], S.pick[0][1], S.pick[1][0], S.pick[1][1]];
        S.pick = []; S.picking = 0; tip.hidden = true; changed(); render();
        setTimeout(() => side.querySelector(".td-sec input[type=number][placeholder]")?.focus(), 0);
      } else tip.textContent = tr("todrawing.secondo_punto");
      draw();
      return;
    }
    drag = { x: e.clientX, y: e.clientY, ox: V.ox, oy: V.oy };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", e => {
    const r = canvas.getBoundingClientRect();
    if (drag) { V.ox = drag.ox + e.clientX - drag.x; V.oy = drag.oy + e.clientY - drag.y; draw(); return; }
    if (S.picking) {
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      V.hover = toMm(mx, my);
      V.snap = null;
      let best = 10;
      for (const p of V.paths?.ends || []) {
        const [sx, sy] = toScr(p[0], p[1]);
        const d = Math.hypot(sx - mx, sy - my);
        if (d < best) { best = d; V.snap = p; }
      }
      if (V.snap) V.hover = V.snap;
      draw();
    }
  });
  canvas.addEventListener("pointerup", () => { drag = null; });
  canvas.addEventListener("dblclick", () => { fit(); draw(); });
  const ro = new ResizeObserver(() => { if (closed) return ro.disconnect(); draw(); });
  ro.observe(stage);
  function startPick() {
    S.scaleMode = "ref"; S.picking = 1; S.pick = []; S.ref = null;
    tip.hidden = false; tip.textContent = tr("todrawing.primo_punto");
    render(); draw();
  }

  // ---------------------------------------------------------------- conversione
  function showBusy(t) { busy.hidden = false; busy.lastChild.textContent = t; }
  function hideBusy() { busy.hidden = true; }
  function setMsg(t, bad = false) { msg.textContent = t; msg.classList.toggle("bad", bad); }

  async function convert() {
    if (S.scaleMode === "ref" && !(S.ref && parseFloat(String(S.refLen).replace(",", ".")) > 0)) return toast(tr("todrawing.quota_mancante"), true, 5000);
    let target = out;
    if (!target || !target.toLowerCase().endsWith("." + S.to)) {
      const base = baseName(path).replace(/\.[^.]+$/, "");
      target = await pickSavePath(base + "." + S.to, dirName(path));
      if (!target) return;
    }
    savePrefs({ scaleMode: S.scaleMode === "ref" ? "ratio" : S.scaleMode, scale: S.scale, units: S.units, layout: S.layout, layers: S.layers, vmode: S.vmode, open: S.open });
    bGo.disabled = bPrev.disabled = true;
    prog.hidden = false;
    try {
      const { job } = await api("drawing", { op: "convert", path }, { json: { out: target, opts: opts() } });
      const r = await waitJob(job, (p, m) => { prog.value = p; setMsg(m || tr("todrawing.conversione")); });
      const n = Object.values(r.stats || {}).reduce((a, b) => a + b, 0);
      toast(tr("todrawing.creato_0_1", baseName(target), fmtNum(n, 0)) + (r.approx ? " · " + tr("todrawing.approssimato") : ""), false, 6000);
      close();
      if (S.open && openFile) openFile(target);
    } catch (e) {
      setMsg(tr("todrawing.conversione_non_riuscita") + e.message, true);
      bGo.disabled = bPrev.disabled = false;
      prog.hidden = true;
    }
  }

  render();
  loadPage();
}
