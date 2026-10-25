// Misure sui PDF (app per PC): uno strato di disegno su ogni pagina di pdf.js, aggancio ai tracciati vettoriali della
// pagina (motore mbvisual/measure.py: estremi, medi, centri dei cerchi, intersezioni), oggetti e simboli uguali con un
// clic, scala per pagina e per riquadro, lettura della scala dal cartiglio e dai riquadri /VP di Acrobat e Bluebeam.
// Le misure si salvano NEL PDF con Salva: annotazioni con dizionario /Measure (visibili e misurabili in Acrobat) +
// etichette + allegato misure.mbmis con tutti i dati; riaprendo il file l'elenco torna com'era.
import { api, el, fileUrl, loadCss, toast } from "../core.js";
import { t as tr } from "../i18n.js";
import { osnap } from "../cadgeom.js";
import * as C from "./mcore.js";
import * as X from "./mextract.js";
import { createSession } from "./mpanel.js";
import { createEngine2d, snapModel } from "./mtool.js";

const SNAP = { end: true, mid: true, cen: true, int: true, qua: true };
const CSS = `.mbm-layer { position: absolute; inset: 0; z-index: 40; pointer-events: none; }
.mbm-layer.on { pointer-events: auto; }`;

export async function attachPdf(ctx, ed, host) {
  loadCss("css/measure.css");
  const app = () => ed.app();
  const doc = () => ed.doc();
  const geo = new Map(); // pagina -> { data, snap } della copia di lavoro attuale
  let geoFile = null, stripped = false, touched = false, hl = null, hlT = null;
  const file = () => ed.file();
  const env = {
    space: "pdf", paged: true, host, ctx,
    base: { k: C.PT / C.UNITS.mm, unit: "mm", label: tr("mis.carta_1_1"), none: true },
    tools: ["calib", "vp", "refelev", "len", "pline", "perim", "area", "hole", "vol", "ang", "rad", "elev", "count", "objlen", "objarea", "similar"],
    redraw: () => paintAll(),
    curPage: () => ed.curPage(),
    markDirty: () => { touched = true; ctx.setDirty(true); },
    focus: m => focus(m.page, m.pts),
    showRecs: recs => { hl = recs; clearTimeout(hlT); hlT = setTimeout(() => { hl = null; paintAll(); }, 5000); const r = recs.find(x => x.at); if (r) focus(r.page ?? ed.curPage(), recs.filter(x => (x.page ?? null) === (r.page ?? null)).map(x => x.at)); paintAll(); },
    focusRec: f => focus(f.page, f.box ? [[f.box[0], f.box[1]], [f.box[2], f.box[3]]] : [f.at]),
    onTool: t => {
      if (t && ed.mode) ed.setMode(null); // gli strumenti dell'editor e quelli di misura non lavorano insieme
      layers();
    },
    onPanel: v => { if (v) layers(); },
    persist: async () => { await window.MB?.save?.(false); },
    autoScale: async () => {
      const r = await api("measure", { op: "pdf_scales", path: file() }, { json: {} });
      return (r.scale || []).map(s => ({ ...s, source: s.source }));
    },
    extractors: [],
  };
  const M = createSession(env);
  const E = (M.engine = createEngine2d(M));
  M.doc.disp.unit = "m";
  env.extractors = pdfExtractors();

  // misure gia' salvate nel PDF (allegato), oppure misure di altri programmi (Acrobat, Bluebeam) da importare
  try {
    const r = await api("measure", { op: "pdf_read", path: ctx.path }, { json: {} });
    if (r.doc) M.loadDoc(r.doc);
    else if (r.importate?.length) {
      for (const m of r.importate) {
        const sc = { id: C.uid(), page: m.page, box: null, k: m.k, unit: m.unit, label: m.R || "1:" + Math.round(m.k * C.UNITS[m.unit] / C.PT), source: tr("mis.importata") };
        if (!M.doc.scales.some(s => s.page === m.page && !s.box)) M.doc.scales.push(sc);
        M.doc.items.push({ id: C.uid(), type: m.type, page: m.page, pts: m.pts, color: m.color, name: m.name, note: m.note, voce: tr("mis.importate"), layer: "" });
      }
      if (r.importate.length) toast(tr("mis.importate_n", r.importate.length));
    }
    // le annotazioni scritte da MB Desk si tolgono dalla copia mostrata: le disegna lo strato delle misure
    if (r.nostre) M._needStrip = true;
  } catch (e) { console.warn(e); }
  if (!M.doc.scales.length) { // scala proposta dal cartiglio / dai riquadri /VP, senza chiedere
    try {
      const found = await env.autoScale();
      const seen = new Set();
      for (const f of found) {
        const key = f.page + "|" + (f.box ? f.box.join(",") : "");
        if (seen.has(key)) continue;
        seen.add(key);
        M.doc.scales.push({ id: C.uid(), page: f.page, box: f.box || null, k: f.k, unit: f.unit, label: f.label, source: f.source, auto: true });
      }
    } catch { /* */ }
  }
  async function stripOnce() {
    if (!M._needStrip || stripped) return;
    stripped = true;
    try {
      const r = await api("measure", { op: "pdf_strip", path: file() }, { json: {} });
      ed.work = r.path;
      const a = app();
      const page = a.page, scale = a.pdfViewer.currentScaleValue;
      await a.open({ url: fileUrl(r.path) + "&v=" + Date.now() });
      await new Promise(res => a.eventBus.on("pagesinit", res, { once: true }));
      a.pdfViewer.currentScaleValue = scale;
      a.page = page;
    } catch (e) { console.warn(e); }
  }

  // ---------------------------------------------------------------- strati sulle pagine
  function injectCss() {
    const d = doc();
    if (d && !d.getElementById("mbm-css")) d.head.append(Object.assign(d.createElement("style"), { id: "mbm-css", textContent: CSS }));
  }
  function layerOf(pv) {
    let c = pv.div.querySelector(":scope > canvas.mbm-layer");
    if (!c) {
      c = doc().createElement("canvas");
      c.className = "mbm-layer";
      pv.div.append(c);
      bind(c, pv);
    }
    return c;
  }
  const visible = () => M.panel.open || M.doc.items.length;
  function layers() {
    injectCss();
    const a = app();
    if (!a?.pdfViewer) return;
    for (let i = 0; i < a.pagesCount; i++) {
      const pv = a.pdfViewer.getPageView(i);
      if (!pv?.div || pv.renderingState !== 3) continue;
      if (!visible()) { pv.div.querySelector(":scope > canvas.mbm-layer")?.remove(); continue; }
      const c = layerOf(pv);
      c.classList.toggle("on", !!M.tool && M.panel.open);
      paint(pv, c);
    }
  }
  function surfOf(pv) {
    const pno = pv.id - 1;
    return {
      page: pno, px: 1,
      toScreen: p => pv.viewport.convertToViewportPoint(p[0], p[1]),
      toWorld: (x, y) => pv.viewport.convertToPdfPoint(x, y),
      snap: (sx, sy) => {
        const g = geoNow(pno);
        if (!g?.snap) return null;
        const [wx, wy] = pv.viewport.convertToPdfPoint(sx, sy);
        const tol = 9 / pv.viewport.scale;
        return osnap(g.snap, wx, wy, tol, SNAP, E.cur?.pts.at(-1) || null);
      },
      pick: async (sx, sy, wantClosed) => {
        const g = await geoLoad(pno);
        const [x, y] = pv.viewport.convertToPdfPoint(sx, sy);
        return X.vecPick(g.paths, x, y, 7 / pv.viewport.scale, wantClosed);
      },
      similar: async (sx, sy) => {
        const [x, y] = pv.viewport.convertToPdfPoint(sx, sy);
        const r = await api("measure", { op: "pdf_similar", path: file() }, { json: { page: pno, point: [x, y] } });
        if (r.troppi) toast(tr("mis.pagina_troppi_tracciati"), true);
        return (r.punti || []).filter(p => p[0] === pno).map(p => [p[1], p[2]]);
      },
      redraw: () => paint(pv),
    };
  }
  function bind(c, pv) {
    const S = () => surfOf(pv);
    const pos = e => { const b = c.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    c.addEventListener("pointerdown", e => {
      const [x, y] = pos(e);
      geoLoad(pv.id - 1);
      if (E.down(S(), x, y, e)) { e.preventDefault(); e.stopPropagation(); try { c.setPointerCapture(e.pointerId); } catch { /* */ } }
    });
    c.addEventListener("pointermove", e => { const [x, y] = pos(e); geoLoad(pv.id - 1); E.move(S(), x, y, e); });
    c.addEventListener("pointerup", e => { const [x, y] = pos(e); E.up(S(), x, y, e); });
    c.addEventListener("dblclick", e => { const [x, y] = pos(e); if (E.dbl(S(), x, y, e)) e.preventDefault(); });
    c.addEventListener("contextmenu", e => { if (E.context()) e.preventDefault(); });
    c.addEventListener("pointerleave", () => { if (E.hover) { E.hover = null; paint(pv); } });
  }
  function paint(pv, c = pv.div.querySelector(":scope > canvas.mbm-layer")) {
    if (!c) return;
    const dpr = devicePixelRatio || 1, w = pv.div.clientWidth, h = pv.div.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.width = w + "px"; c.style.height = h + "px"; }
    const g = c.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = surfOf(pv);
    E.paint(s, g);
    if (hl) {
      g.save(); g.strokeStyle = "#ffd400"; g.lineWidth = 2.5; g.setLineDash([5, 3]);
      for (const r of hl) if ((r.page ?? null) === s.page && r.at) { const [x, y] = s.toScreen(r.at); g.beginPath(); g.arc(x, y, 10, 0, 7); g.stroke(); }
      g.restore();
    }
  }
  function paintAll() {
    const a = app();
    if (!a?.pdfViewer) return;
    if (!visible()) return layers();
    for (let i = 0; i < a.pagesCount; i++) { const pv = a.pdfViewer.getPageView(i); if (pv?.div && pv.renderingState === 3) paint(pv, layerOf(pv)); }
  }
  function geoNow(pno) {
    if (geoFile !== file()) { geo.clear(); geoFile = file(); }
    const g = geo.get(pno);
    return g && !g.then ? g : null;
  }
  async function geoLoad(pno) {
    if (geoFile !== file()) { geo.clear(); geoFile = file(); }
    let g = geo.get(pno);
    if (g) return g.then ? g : g;
    const p = (async () => {
      const r = await api("measure", { op: "pdf_page", path: file() }, { json: { page: pno } });
      const paths = (r.paths || []).map(q => ({ rings: q.s, closed: q.c, stroke: q.st || "", fill: q.f || "", w: q.w, layer: q.lay || "", circ: q.circ || [], page: pno }));
      const out = { paths, snap: snapModel(X.vecSnapItems(paths)), troncato: r.troncato };
      if (r.troncato) toast(tr("mis.pagina_troppi_tracciati"), true);
      geo.set(pno, out);
      return out;
    })();
    geo.set(pno, p);
    try { return await p; } catch (e) { geo.delete(pno); throw e; }
  }
  async function focus(pno, pts) {
    const a = app();
    if (pno == null || !a) return;
    a.page = pno + 1;
    await new Promise(r => setTimeout(r, 120));
    const pv = a.pdfViewer.getPageView(pno);
    if (!pv?.div || !pts?.length) return;
    const S = pts.map(p => pv.viewport.convertToViewportPoint(p[0], p[1]));
    const cy = S.reduce((s, p) => s + p[1], 0) / S.length, cx = S.reduce((s, p) => s + p[0], 0) / S.length;
    const cont = a.pdfViewer.container;
    cont.scrollTop = pv.div.offsetTop + cy - cont.clientHeight / 2;
    cont.scrollLeft = pv.div.offsetLeft + cx - cont.clientWidth / 2;
  }

  // ---------------------------------------------------------------- estrazioni
  function pdfExtractors() {
    const pages = () => { const a = app(); return Array.from({ length: a?.pagesCount || 1 }, (_, i) => i); };
    const regions = d => (d.scales || []).filter(s => s.box).map(s => ({ id: s.id, page: s.page, box: s.box }));
    const G = [{ k: "layer", label: tr("mis.layer_pdf") }, { k: "style", label: tr("mis.stile") }, { k: "stroke", label: tr("mis.colore") }, { k: "width", label: tr("mis.spessore") }, { k: "dash", label: tr("mis.tratteggio") }, { k: "fill", label: tr("mis.riempimento") }];
    const lines = async (d, filter) => {
      const r = await api("measure", { op: "pdf_lines", path: file() }, { json: { pages: pages(), regions: regions(d) } });
      return (r.records || []).filter(filter).map(x => ({ ...x, ents: x.count, count: undefined }));
    };
    return [
      { id: "len", label: tr("mis.x_lunghezze_stile"), title: tr("mis.x_lunghezze_stile_titolo"), run: async ({ doc: d }) => ({ records: (await lines(d, r => r.len > 0)).map(r => ({ ...r, area: undefined })), groups: G }) },
      { id: "area", label: tr("mis.x_aree_pdf"), title: tr("mis.x_aree_pdf_titolo"), run: async ({ doc: d }) => ({ records: (await lines(d, r => r.area > 0)).map(r => ({ ...r, len: undefined })), groups: [G[5], G[0], G[2]] }) },
      { id: "sym", label: tr("mis.x_simboli"), title: tr("mis.x_simboli_titolo"), run: async () => {
        const r = await api("measure", { op: "pdf_symbols", path: file() }, { json: { pages: pages() } });
        const recs = [];
        (r.simboli || []).forEach((s, i) => s.at.forEach(([page, x, y]) => recs.push({ g: { sym: tr("mis.simbolo_n", i + 1) + ` (${s.size[0]}×${s.size[1]} pt)`, layer: s.layer || "", page: String(page + 1) }, page, at: [x, y], count: 1, color: s.color })));
        return { records: recs, groups: [{ k: "sym", label: tr("mis.simbolo") }, { k: "page", label: tr("mis.pagina") }, { k: "layer", label: tr("mis.layer_pdf") }], warn: r.pagine_saltate?.length ? tr("mis.pagine_saltate", r.pagine_saltate.join(", ")) : "" };
      } },
      { id: "tables", label: tr("mis.x_tabelle"), title: tr("mis.x_tabelle_titolo"), run: async () => {
        const r = await api("measure", { op: "pdf_tables", path: file() }, { json: { pages: pages() } });
        const T = r.tabelle || [];
        if (!T.length) return { table: { head: [tr("mis.risultato")], rows: [{ cells: [tr("mis.nessuna_tabella")] }] } };
        const w = Math.max(...T.map(t => Math.max(t.head.length, ...t.rows.map(x => x.length))));
        const rows = [];
        for (const t of T) {
          rows.push({ cells: [tr("mis.tabella_n", t.n, t.page + 1), ...t.head, ...Array(w - t.head.length).fill("")], focus: { page: t.page, box: t.box } });
          for (const row of t.rows) rows.push({ cells: ["", ...row, ...Array(w - row.length).fill("")], focus: { page: t.page, box: t.box } });
        }
        return { table: { head: [tr("mis.tabella"), ...Array.from({ length: w }, (_, i) => tr("mis.colonna_n", i + 1))], rows }, note: tr("mis.n_tabelle", T.length) };
      } },
      { id: "texts", label: tr("mis.x_testi"), title: tr("mis.x_testi_pdf_titolo"), run: async () => {
        const r = await api("measure", { op: "pdf_texts", path: file() }, { json: { pages: pages() } });
        const K = { quota: tr("mis.k_quota"), livello: tr("mis.k_livello"), testo: tr("mis.k_testo") };
        const rows = (r.testi || []).sort((a, b) => (a.kind === "testo") - (b.kind === "testo")).map(x => ({ cells: [x.text, K[x.kind], x.page + 1, x.size, x.angle], focus: { page: x.page, box: x.box } }));
        return { table: { head: [tr("mis.testo"), tr("mis.tipo"), tr("mis.pagina"), tr("mis.altezza_testo"), tr("mis.rotazione")], rows } };
      } },
    ];
  }

  // ---------------------------------------------------------------- aggancio a pdf.js
  const a0 = app();
  const hookBus = () => {
    const a = app();
    if (!a?.eventBus || a._mbmHooked) return;
    a._mbmHooked = true;
    a.eventBus.on("pagerendered", e => { if (!visible()) return; const pv = a.pdfViewer.getPageView(e.pageNumber - 1); if (pv?.div) { const c = layerOf(pv); c.classList.toggle("on", !!M.tool && M.panel.open); paint(pv, c); } });
    doc()?.addEventListener("keydown", onKey, true);
  };
  hookBus();
  // uno strumento dell'editor PDF spegne quello di misura
  ed.listeners?.add(() => { if (ed.mode && M.tool) { M.tool = null; M.engine.cancel(); layers(); M.listeners.forEach(f => f()); } });
  ed.reloaded?.add(() => { hookBus(); geo.clear(); setTimeout(layers, 80); });
  function onKey(e) {
    if (!M.panel.open || e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    if (E.key(e)) { e.preventDefault(); e.stopPropagation(); return; }
    if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1 && M.tool) {
      const k = e.key.toUpperCase();
      const hit = k === "V" ? ["select"] : Object.entries(M.keys).find(([id, key]) => key === k && env.tools.includes(id));
      if (hit) { M.setTool(hit[0]); e.preventDefault(); e.stopPropagation(); }
    }
  }
  void a0;
  setTimeout(layers, 60);
  // tasti premuti fuori dal documento (barra, pannello): Invio / Esc / Canc arrivano comunque agli strumenti
  const onTopKey = e => { if (ctx.tab.view?.isConnected && !ctx.tab.view.hidden) onKey(e); };
  document.addEventListener("keydown", onTopKey, true);

  return {
    M, E,
    get open() { return M.panel.open; },
    async toggle() { await stripOnce(); M.panel.toggle(); layers(); },
    key: onKey,
    // Salva: dopo che il visualizzatore ha scritto il PDF, le misure vanno nel file salvato
    get needsWrite() { return touched || stripped || M.doc.items.length > 0; },
    async writeTo(target) {
      if (!(touched || stripped || M.doc.items.length)) return;
      const labels = {};
      for (const m of M.doc.items) { try { labels[m.id] = M.fmtShort(C.row(m, M.doc), m); } catch { /* */ } }
      const d = { ...M.doc };
      delete d.base;
      await api("measure", { op: "pdf_write", path: target }, { json: { doc: d, labels } });
      touched = false;
    },
    // il file salvato contiene ora le annotazioni delle misure: la copia mostrata resta senza (le disegna lo strato)
  };
}
