// Pannello "Misure" comune a PDF, disegni CAD (DWG/DXF/DWF) e modelli 3D: strumenti, elenco raggruppato per tipo /
// voce / layer / pagina con nomi, colori, note e prezzo unitario (importo), totali, scale (taratura, 1:N, riquadri, lettura
// dal cartiglio), estrazioni automatiche, esportazione Excel/CSV. La sessione (M) e' condivisa con gli strumenti
// (mtool.js per il 2D, m3d.js per il 3D); il visualizzatore fornisce l'ambiente (env):
//   env = { space: "pdf"|"cad"|"3d", host (elemento con position: relative), ctx, base: {k, unit, label}, tools: [...],
//     units: true se l'unita' del file si puo' cambiare, pageCount?(), curPage?(), redraw(), focus(m), onTool(t),
//     load() -> doc | null, persist(doc) (salvataggio: .mbmis o PDF), extractors: [{ id, label, run(opts) }],
//     autoScale?() -> [{ page, box, N, k, unit, label, source }], pickLevel? }
import { el, loadScript, saveBlobAs, toast, modal, dirName } from "../core.js";
import { t as tr, LOCALE, fmtNum } from "../i18n.js";
import * as C from "./mcore.js";
import { SYMBOLS, symbol as drawSymbol } from "./mtool.js";

// icone degli strumenti (16 px, tratto corrente)
const I = {
  select: '<path d="M3.5 2.5l9 5-4 1-1.5 4z"/>',
  calib: '<path d="M1.5 10.5l9-9 4 4-9 9z"/><path d="M4.5 7.5l1.5 1.5M6.5 5.5l1 1M8.5 3.5l1.5 1.5"/>',
  vp: '<rect x="2" y="3" width="12" height="10" stroke-dasharray="2 1.5"/><path d="M5 10l6-4"/>',
  len: '<path d="M2 12L14 4"/><path d="M2 9.5v5M14 1.5v5"/>',
  pline: '<path d="M2 13l3.5-6 4 3L14 3"/><circle cx="2" cy="13" r="1"/><circle cx="14" cy="3" r="1"/>',
  perim: '<path d="M2.5 4.5l6-2 5 4-2 7h-8z"/>',
  area: '<path d="M2.5 4.5l6-2 5 4-2 7h-8z" fill="currentColor" fill-opacity=".25"/>',
  hole: '<rect x="1.5" y="2.5" width="13" height="11" fill="currentColor" fill-opacity=".25"/><rect x="5" y="5.5" width="5" height="4" fill="var(--panel)"/>',
  vol: '<path d="M2.5 5l5.5-3 5.5 3v6.5L8 14.5 2.5 11.5z M2.5 5L8 8l5.5-3M8 8v6.5"/>',
  ang: '<path d="M2 13.5h12M2 13.5L11 3"/><path d="M7 13.5a5 5 0 0 0-1.6-3.7"/>',
  rad: '<circle cx="8" cy="8" r="6"/><path d="M8 8l4.2-4.2"/><circle cx="8" cy="8" r=".8" fill="currentColor"/>',
  elev: '<path d="M4 9l3.5-5H.5z" transform="translate(2 0)"/><path d="M1 9.5h14"/><path d="M9.5 6h5"/>',
  count: '<circle cx="4.5" cy="4.5" r="2.2"/><circle cx="11.5" cy="4.5" r="2.2"/><circle cx="4.5" cy="11.5" r="2.2"/><path d="M10 11.5h3M11.5 10v3"/>',
  objlen: '<path d="M2 12c3-8 7-8 12-8" stroke-dasharray="0"/><path d="M11 1.5l3 2.5-3 2.5"/>',
  objarea: '<path d="M3 3h10v10H3z" fill="currentColor" fill-opacity=".25"/><path d="M8 6.5l1.2 3.6L12 11" />',
  similar: '<rect x="1.5" y="1.5" width="5" height="5"/><rect x="9.5" y="1.5" width="5" height="5" stroke-dasharray="1.5 1"/><rect x="1.5" y="9.5" width="5" height="5" stroke-dasharray="1.5 1"/><rect x="9.5" y="9.5" width="5" height="5" stroke-dasharray="1.5 1"/>',
  face: '<path d="M2.5 5l5.5-3 5.5 3-5.5 3z" fill="currentColor" fill-opacity=".3"/><path d="M2.5 5v6.5L8 14.5l5.5-3V5M8 8v6.5"/>',
  element: '<path d="M2.5 5l5.5-3 5.5 3v6.5L8 14.5 2.5 11.5z" fill="currentColor" fill-opacity=".3"/>',
  section: '<path d="M2.5 5l5.5-3 5.5 3v6.5L8 14.5 2.5 11.5z"/><path d="M1 9h14" stroke-width="2"/>',
  refelev: '<path d="M1 12h14"/><path d="M8 12V3M5.5 5.5L8 3l2.5 2.5"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  trash: '<path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.7 9h5.6l.7-9"/>',
  eye: '<path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"/><circle cx="8" cy="8" r="2"/>',
};
export const micon = (k, s = 16) => `<svg viewBox="0 0 16 16" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" stroke-linecap="round">${I[k] || ""}</svg>`;

const GROUPS = { "voce,type": "mis.g_voce_tipo", "type,voce": "mis.g_tipo_voce", "layer,type": "mis.g_layer_tipo", "page,type": "mis.g_pagina_tipo", "type": "mis.g_tipo", "voce": "mis.g_voce", "": "mis.g_nessuno" };
const KEY_LABEL = { type: "mis.tipo", voce: "mis.voce", layer: "mis.layer", page: "mis.pagina", color: "mis.colore" };
const DISP_UNITS = ["mm", "cm", "m", "km", "in", "ft"];

export function createSession(env) {
  window.MBStat?.track("fn", "misure"); // statistiche anonime (solo con consenso)
  const M = {
    env, tool: null, sel: new Set(), showScales: true, hidden: new Set(),
    doc: C.newDoc(env.ctx?.name, env.base),
    opt: { color: C.PALETTE[0], voce: "", layer: "", symbol: "circle", h: 3, price: "" },
    listeners: new Set(),
  };
  M.doc.space = env.space;
  try { const o = JSON.parse(localStorage.getItem("mbv-mis-opt") || "{}"); Object.assign(M.opt, o, { voce: "", price: "" }); } catch { /* */ }
  const saveOpt = () => { try { localStorage.setItem("mbv-mis-opt", JSON.stringify({ color: M.opt.color, symbol: M.opt.symbol, h: M.opt.h })); } catch { /* */ } };
  const notify = () => M.listeners.forEach(f => { try { f(); } catch (e) { console.error(e); } });
  M.redraw = () => env.redraw();
  M.hint = key => toast(tr("mis.h_" + key));
  M.typeName = t => tr("mis.t_" + t);
  M.digits = () => M.doc.disp?.digits ?? 2;
  M.fmtNum = (v, d = M.digits()) => (v == null || !isFinite(v) ? "—" : Number(v).toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d }));
  M.label = m => m.name || m.voce || M.typeName(m.type) + " " + (M.doc.items.filter(x => x.type === m.type).indexOf(m) + 1);
  M.fmtShort = (r, m) => {
    const u = r.unit ? " " + r.unit : "";
    switch (r.main) {
      case "len": return (m.type === "rad" ? "R " : "") + M.fmtNum(r.qty) + u + (m.type === "perim" && r.area != null ? " · " + M.fmtNum(r.area) + " " + C.dispUnit("area", M.doc) : "");
      case "area": return M.fmtNum(r.qty) + u;
      case "vol": return M.fmtNum(r.qty) + u;
      case "ang": return M.fmtNum(r.qty, 1) + "°";
      case "elev": return (r.qty >= 0 ? "+" : "") + M.fmtNum(r.qty) + u;
      case "count": return String(r.qty ?? 0);
      default: return r.qty != null ? M.fmtNum(r.qty) + u : "";
    }
  };
  M.visibleItems = page => M.doc.items.filter(m => (m.page ?? null) === (page ?? null) && !M.hidden.has(m.id) && !(m.voce && M.hidden.has("v:" + m.voce)));
  // voce nuova: colore successivo della tavolozza non ancora usato
  M.ensureVoce = name => {
    if (!name || M.doc.voci[name]) return M.doc.voci[name];
    const used = new Set(Object.values(M.doc.voci).map(v => v.color));
    const color = C.PALETTE.find(c => !used.has(c)) || C.PALETTE[Object.keys(M.doc.voci).length % C.PALETTE.length];
    return (M.doc.voci[name] = { color, price: null });
  };
  M.newItem = (type, page, pts) => {
    const v = M.ensureVoce(M.opt.voce);
    return { id: C.uid(), type, page: page ?? null, pts: pts.map(p => p.map(v2 => +v2)), color: v?.color || M.opt.color, voce: M.opt.voce || "", layer: M.opt.layer || "", symbol: type === "count" ? M.opt.symbol : undefined, note: "", created: new Date().toISOString(), author: author() };
  };
  M.add = (m, silent) => { M.doc.items.push(m); M.sel = new Set([m.id]); M.changed(m, silent); };
  M.changed = (m, silent) => { env.markDirty?.(); scheduleSave(); notify(); M.redraw(); if (!silent && m) ctxStatus(m); };
  M.liveUpdate = () => notify();
  M.removeSelected = () => {
    if (!M.sel.size) return;
    M.doc.items = M.doc.items.filter(m => !M.sel.has(m.id));
    M.sel.clear();
    M.changed();
  };
  M.select = (id, multi) => {
    if (id == null) M.sel.clear();
    else if (multi) { if (M.sel.has(id)) M.sel.delete(id); else M.sel.add(id); }
    else M.sel = new Set([id]);
    notify();
    M.redraw();
  };
  M.setTool = t => {
    if (M.tool === t) t = null;
    M.engine?.cancel?.();
    M.tool = t;
    env.onTool?.(t);
    notify();
    M.redraw();
    if (t) env.ctx?.status(tr("mis.strumento_0", tr("mis.tool_" + t)) + (["pline", "perim", "area", "vol", "hole"].includes(t) ? " · " + tr("mis.h_fine_poligono") : t === "count" ? " · " + tr("mis.h_fine_conteggio") : ""));
  };
  M.on = f => { M.listeners.add(f); return () => M.listeners.delete(f); };
  M.rows = () => M.doc.items.map(m => C.row(m, M.doc));
  function ctxStatus(m) { try { env.ctx?.status(M.label(m) + ": " + M.fmtShort(C.row(m, M.doc), m)); } catch { /* */ } }
  const author = () => { try { return localStorage.getItem("mbv-pdf-autore") || localStorage.getItem("mbv-bcf-autore") || ""; } catch { return ""; } };

  // ---------------------------------------------------------------- salvataggio (accanto al file o nel PDF)
  let saveT = null;
  function scheduleSave() {
    if (!env.autosave) return;
    clearTimeout(saveT);
    saveT = setTimeout(() => env.persist?.(M.doc).catch?.(e => toast(e.message, true)), 900);
  }
  M.flushSave = async () => { clearTimeout(saveT); if (env.persist) await env.persist(M.doc); };
  M.loadDoc = d => {
    if (!d) return;
    M.doc = C.parse(d, env.ctx?.name, env.base);
    M.doc.space = env.space;
    if (!M.doc.disp?.unit) M.doc.disp = { unit: env.base?.unit || "m", digits: 2 };
    notify();
    M.redraw();
  };

  // ---------------------------------------------------------------- domande (taratura, riquadri, quota di riferimento)
  const unitSel = (value, list = DISP_UNITS) => el("select", { class: "mm-in" }, ...list.map(u => el("option", { value: u, selected: u === value }, u)));
  // metri per unita' del disegno a 1:1 (per le scale 1:N)
  const paperM = M.paperM = () => (env.paperM ? env.paperM() : env.space === "pdf" ? C.PT : C.UNITS[env.paperUnit || M.doc.base?.unit] || 1);
  const numIn = (value, attrs = {}) => { const i = el("input", { type: "number", class: "mm-in", step: "any", value, ...attrs }); i.addEventListener("keydown", e => e.stopPropagation()); return i; };
  const field = (label, ...ctl) => el("label", { class: "mm-f" }, el("span", {}, label), el("span", { class: "mm-fc" }, ...ctl));
  const askOk = (title, body) => modal(title, el("div", { class: "mm-dlg" }, ...body), [{ label: tr("common.annulla"), value: false }, { label: "OK", value: true, primary: true }]);
  M.askCalibration = async (page, a, b) => {
    const len = numIn("", { min: 0, placeholder: "5.00" }), u = unitSel(M.doc.disp?.unit || "m");
    const where = el("select", { class: "mm-in" }, el("option", { value: "page" }, env.paged ? tr("mis.solo_pagina", (page ?? 0) + 1) : tr("mis.tutto_documento")), ...(env.paged ? [el("option", { value: "all" }, tr("mis.tutte_pagine"))] : []));
    setTimeout(() => len.focus(), 50);
    if (!await askOk(tr("mis.taratura"), [el("p", { class: "note" }, tr("mis.taratura_spiega", M.fmtNum(C.dist(a, b), 3) + (env.space === "pdf" ? " pt" : env.paperUnit ? " " + env.paperUnit : ""))), field(tr("mis.lunghezza_vera"), len, u), field(tr("mis.applica_a"), where)])) return;
    const s = C.calibrate(a, b, +len.value, u.value, paperM());
    if (!s) return toast(tr("mis.taratura_non_valida"), true);
    if (!env.paged) s.label = tr("mis.tarata");
    setScale({ ...s, page: env.paged && where.value === "page" ? page : null });
  };
  M.askViewport = async (page, box) => {
    const N = numIn("100", { min: 1 }), u = unitSel(M.doc.disp?.unit || "m"), name = el("input", { class: "mm-in", value: "" });
    name.addEventListener("keydown", e => e.stopPropagation());
    if (!await askOk(tr("mis.scala_riquadro"), [el("p", { class: "note" }, tr("mis.scala_riquadro_spiega")), field(tr("mis.scala_1_n"), el("span", {}, "1 :"), N, u), field(tr("mis.nome_riquadro"), name)])) return;
    const s = C.ratioScale(+N.value || 100, u.value, paperM());
    if (name.value.trim()) s.label = name.value.trim() + " · " + s.label;
    setScale({ ...s, page, box });
  };
  M.askRefElev = async p => {
    const v = numIn("0.00"), u = el("span", {}, C.dispUnit("len", M.doc));
    if (!await askOk(tr("mis.quota_riferimento"), [el("p", { class: "note" }, tr("mis.quota_riferimento_spiega")), field(tr("mis.quota_punto"), v, u)])) return;
    const s = C.scaleFor(M.doc, M.engine?.cur?.page ?? null, p);
    M.doc.ref = { y: p[1], value: C.conv(+v.value || 0, M.doc.disp.unit, s.unit) };
    M.changed();
  };
  function setScale(s) {
    s.id = C.uid();
    // una sola scala per pagina (o per il documento) senza riquadro: la nuova sostituisce la precedente
    if (!s.box) M.doc.scales = M.doc.scales.filter(x => x.box || (x.page ?? null) !== (s.page ?? null));
    M.doc.scales.push(s);
    if (!M.doc.disp?.unit || M.doc.items.length === 0) M.doc.disp = { ...(M.doc.disp || {}), unit: s.unit };
    M.changed();
    toast(tr("mis.scala_impostata", s.label));
  }
  M.setScale = setScale;

  // ---------------------------------------------------------------- pannello
  const P = buildPanel(M);
  M.panel = P;
  return M;
}

function buildPanel(M) {
  const env = M.env;
  const root = el("div", { class: "mm-panel", hidden: true });
  const grip = el("div", { class: "mm-grip", title: tr("mis.trascina_larghezza") });
  const tabs = el("div", { class: "mm-tabs" });
  const body = el("div", { class: "mm-body" });
  root.append(grip, el("div", { class: "mm-head" }, tabs, el("button", { class: "mm-x", title: tr("common.chiudi"), html: micon("close"), onclick: () => api.toggle(false) })), body);
  env.host.append(root);
  root.addEventListener("keydown", e => { if (e.target.closest("input, textarea, select")) e.stopPropagation(); });
  try { const w = +localStorage.getItem("mbv-mis-w"); if (w > 300) root.style.width = w + "px"; } catch { /* */ }
  grip.addEventListener("pointerdown", e => {
    e.preventDefault();
    const x0 = e.clientX, w0 = root.getBoundingClientRect().width;
    const mv = ev => { root.style.width = Math.max(320, Math.min(env.host.clientWidth - 40, w0 + x0 - ev.clientX)) + "px"; };
    const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); try { localStorage.setItem("mbv-mis-w", parseInt(root.style.width)); } catch { /* */ } };
    addEventListener("pointermove", mv);
    addEventListener("pointerup", up);
  });
  const TABS = [["list", tr("mis.tab_misure")], ["extract", tr("mis.tab_estrazioni")], ["scale", env.space === "3d" ? tr("mis.tab_unita") : tr("mis.tab_scala")]];
  const panes = { list: el("div", { class: "mm-pane" }), extract: el("div", { class: "mm-pane", hidden: true }), scale: el("div", { class: "mm-pane", hidden: true }) };
  body.append(...Object.values(panes));
  let tab = "list";
  function showTab(k) {
    tab = k;
    tabs.innerHTML = "";
    for (const [id, label] of TABS) tabs.append(el("button", { class: "mm-tab" + (id === k ? " on" : ""), onclick: () => showTab(id) }, label));
    for (const [id, p] of Object.entries(panes)) p.hidden = id !== k;
    if (k === "scale") drawScale();
    if (k === "extract") drawExtract();
  }

  // ================================================================ scheda Misure
  const toolsBox = el("div", { class: "mm-tools" });
  const optsBox = el("div", { class: "mm-opts" });
  const listHead = el("div", { class: "mm-lhead" });
  const list = el("div", { class: "mm-list" });
  const detail = el("div", { class: "mm-detail" });
  const foot = el("div", { class: "mm-foot" });
  panes.list.append(toolsBox, optsBox, listHead, list, detail, foot);
  const TOOLGROUPS = [
    ["mis.g_scala", ["calib", "vp", "refelev"]],
    ["mis.g_misura", ["len", "pline", "perim", "area", "hole", "vol", "ang", "rad", "elev", "count"]],
    ["mis.g_oggetti", ["objlen", "objarea", "similar", "face", "element", "section"]],
  ];
  const toolBtns = {};
  function drawTools() {
    toolsBox.innerHTML = "";
    const sel = el("button", { class: "mm-tb", title: tr("mis.tool_select") + " (V)", html: micon("select", 18), onclick: () => M.setTool("select") });
    toolBtns.select = sel;
    const row = el("div", { class: "mm-trow" }, sel);
    for (const [cap, ids] of TOOLGROUPS) {
      const av = ids.filter(id => env.tools.includes(id));
      if (!av.length) continue;
      row.append(el("span", { class: "mm-tsep", title: tr(cap) }));
      for (const id of av) { const b = el("button", { class: "mm-tb", title: tr("mis.tool_" + id) + (KEYS[id] ? ` (${KEYS[id]})` : ""), "aria-label": tr("mis.tool_" + id), html: micon(id, 18), onclick: () => M.setTool(id) }); toolBtns[id] = b; row.append(b); }
    }
    toolsBox.append(row);
  }
  const KEYS = { len: "L", pline: "P", area: "A", perim: "E", vol: "O", ang: "G", rad: "R", count: "N", calib: "K", elev: "Q" };
  M.keys = KEYS;
  function syncTools() { for (const [id, b] of Object.entries(toolBtns)) b.classList.toggle("on", M.tool === id); }

  // opzioni della prossima misura: voce, colore, layer, simbolo, altezza
  const voceIn = el("input", { class: "mm-in", list: "mm-voci-" + (env.ctx?.tab?.name || "x"), placeholder: tr("mis.voce_ph"), title: tr("mis.voce_titolo") });
  const voceList = el("datalist", { id: "mm-voci-" + (env.ctx?.tab?.name || "x") });
  const colIn = el("input", { type: "color", class: "mm-col", value: M.opt.color, title: tr("mis.colore") });
  const layIn = el("input", { class: "mm-in", placeholder: tr("mis.layer_ph"), title: tr("mis.layer_titolo") });
  const symSel = el("select", { class: "mm-in mm-sym", title: tr("mis.simbolo") }, ...SYMBOLS.map(s => el("option", { value: s, selected: s === M.opt.symbol }, tr("mis.sym_" + s))));
  const hIn = el("input", { type: "number", class: "mm-in mm-h", step: "any", value: M.opt.h, title: tr("mis.altezza_titolo") });
  for (const i of [voceIn, layIn, hIn]) i.addEventListener("keydown", e => e.stopPropagation());
  voceIn.addEventListener("change", () => {
    M.opt.voce = voceIn.value.trim();
    const v = M.ensureVoce(M.opt.voce);
    if (v?.color) { M.opt.color = v.color; colIn.value = v.color; }
  });
  colIn.addEventListener("input", () => { M.opt.color = colIn.value; if (M.opt.voce && M.doc.voci[M.opt.voce]) M.doc.voci[M.opt.voce].color = colIn.value; });
  layIn.addEventListener("change", () => (M.opt.layer = layIn.value.trim()));
  symSel.addEventListener("change", () => (M.opt.symbol = symSel.value));
  hIn.addEventListener("change", () => (M.opt.h = +hIn.value || 0));
  [colIn, symSel, hIn].forEach(i => i.addEventListener("change", () => { try { localStorage.setItem("mbv-mis-opt", JSON.stringify({ color: M.opt.color, symbol: M.opt.symbol, h: M.opt.h })); } catch { /* */ } }));
  const hUnit = el("span", { class: "note" });
  optsBox.append(el("div", { class: "mm-orow" }, colIn, voceIn, voceList, layIn),
    el("div", { class: "mm-orow" }, el("span", { class: "note" }, tr("mis.simbolo")), symSel, el("span", { class: "note" }, tr("mis.altezza")), hIn, hUnit));

  // elenco
  const groupSel = el("select", { class: "mm-in", title: tr("mis.raggruppa_per"), onchange: () => { M.doc.groupBy = groupSel.value; open.clear(); drawList(); } },
    ...Object.entries(GROUPS).map(([k, l]) => el("option", { value: k }, tr(l))));
  listHead.append(el("span", { class: "note" }, tr("mis.raggruppa_per")), groupSel, el("span", { style: { flex: 1 } }),
    el("button", { class: "mm-ib", title: tr("mis.elimina_selezionate"), html: micon("trash"), onclick: () => M.removeSelected() }));
  const open = new Set();
  let openAll = true;
  function drawList() {
    groupSel.value = M.doc.groupBy ?? "voce,type";
    voceList.innerHTML = "";
    for (const v of new Set([...Object.keys(M.doc.voci), ...M.doc.items.map(m => m.voce).filter(Boolean)])) voceList.append(el("option", { value: v }));
    hUnit.textContent = C.dispUnit("len", M.doc);
    list.innerHTML = "";
    const rows = M.rows();
    if (!rows.length) { list.append(el("p", { class: "mm-empty" }, tr("mis.vuoto"))); foot.innerHTML = ""; drawDetail(); return; }
    const keys = groupSel.value ? groupSel.value.split(",") : [];
    const T = C.groupRows(rows, keys);
    const glabel = n => (n.key === "type" ? M.typeName(n.label) : n.key === "page" ? (n.label ? tr("mis.pagina_0", n.label) : "—") : n.label || (n.key === "voce" ? tr("mis.senza_voce") : n.key === "layer" ? tr("mis.senza_layer") : "—"));
    const totals = n => {
      const parts = [];
      if (n.n?.len) parts.push(M.fmtNum(n.len) + " " + C.dispUnit("len", M.doc));
      if (n.n?.area) parts.push(M.fmtNum(n.area) + " " + C.dispUnit("area", M.doc));
      if (n.n?.vol) parts.push(M.fmtNum(n.vol) + " " + C.dispUnit("vol", M.doc));
      if (n.n?.count && n.count) parts.push(tr("mis.n_pezzi", fmtNum(n.count, 0)));
      return parts.join(" · ");
    };
    const line = (n, depth, path) => {
      const id = path.join("\u0001");
      const isOpen = openAll || open.has(id);
      const g = el("div", { class: "mm-grow", style: `--d:${depth}` },
        el("span", { class: "mm-twist" }, isOpen ? "▾" : "▸"),
        n.key === "voce" && n.label ? el("span", { class: "mm-sw", style: `background:${M.doc.voci[n.label]?.color || n.rows[0]?.m.color}` }) : null,
        el("span", { class: "mm-gname" }, glabel(n), el("span", { class: "note" }, " · " + n.rows.length)),
        el("span", { class: "mm-gtot" }, totals(n) + (n.amount ? " · " + money(n.amount) : "")));
      g.addEventListener("click", () => { if (openAll) { openAll = false; collectIds(T, [], open); } if (open.has(id)) open.delete(id); else open.add(id); drawList(); });
      list.append(g);
      if (!isOpen) return;
      if (n.children.length) n.children.forEach(c => line(c, depth + 1, [...path, c.label]));
      else n.rows.forEach(r => list.append(itemRow(r, depth + 1)));
    };
    if (keys.length) T.children.forEach(c => line(c, 0, [c.label])); else rows.forEach(r => list.append(itemRow(r, 0)));
    foot.innerHTML = "";
    foot.append(el("div", { class: "mm-total" }, el("b", {}, tr("mis.totale")), el("span", {}, totals(T) + (T.amount ? " · " + money(T.amount) : ""))),
      el("div", { class: "mm-actions" },
        el("button", { class: "btn", onclick: () => exportExcel(), title: tr("mis.excel_titolo") }, "Excel"),
        el("button", { class: "btn", onclick: () => exportCsv(), title: tr("mis.csv_titolo") }, "CSV"),
        env.persist ? el("button", { class: "btn primary", onclick: () => save(), title: env.space === "pdf" ? tr("mis.salva_pdf_titolo") : tr("mis.salva_mbmis_titolo") }, env.space === "pdf" ? tr("mis.salva_nel_pdf") : tr("common.salva")) : null));
    drawDetail();
  }
  const collectIds = (n, path, set) => n.children.forEach(c => { const p = [...path, c.label]; set.add(p.join("\u0001")); collectIds(c, p, set); });
  const money = v => (v == null ? "" : Number(v).toLocaleString(LOCALE, { style: "currency", currency: "EUR" }));
  function itemRow(r, depth) {
    const m = r.m;
    const vis = !M.hidden.has(m.id);
    const d = el("div", { class: "mm-row" + (M.sel.has(m.id) ? " sel" : ""), style: `--d:${depth}`, title: m.note || "" },
      el("span", { class: "mm-sw" + (m.type === "count" ? " sym" : ""), style: `background:${m.color}` }),
      el("span", { class: "mm-name" }, M.label(m), m.obj ? el("span", { class: "mm-tag" }, tr("mis.da_oggetto")) : null, m.note ? el("span", { class: "mm-tag" }, "✎") : null),
      el("span", { class: "mm-val" }, M.fmtShort(r, m)),
      r.amount != null ? el("span", { class: "mm-amt" }, money(r.amount)) : el("span", { class: "mm-amt" }),
      el("button", { class: "mm-ib" + (vis ? "" : " off"), title: tr("mis.mostra_nascondi"), html: micon("eye", 14), onclick: e => { e.stopPropagation(); if (vis) M.hidden.add(m.id); else M.hidden.delete(m.id); drawList(); M.redraw(); } }));
    d.addEventListener("click", e => { M.select(m.id, e.ctrlKey || e.shiftKey); });
    d.addEventListener("dblclick", () => env.focus?.(m));
    return d;
  }
  // dettaglio della misura selezionata: nome, voce, layer, colore, note, prezzo, altezza
  function drawDetail() {
    detail.innerHTML = "";
    const ms = M.doc.items.filter(m => M.sel.has(m.id));
    if (!ms.length) { detail.hidden = true; return; }
    detail.hidden = false;
    const m = ms[0];
    const r = C.row(m, M.doc);
    const inp = (value, onchange, attrs = {}) => { const i = el(attrs.tag || "input", { class: "mm-in", value: value ?? "", ...attrs }); if (attrs.tag === "textarea") i.value = value ?? ""; i.addEventListener("keydown", e => e.stopPropagation()); i.addEventListener("change", () => { onchange(i.value); M.changed(); }); return i; };
    const each = fn => ms.forEach(fn);
    const head = el("div", { class: "mm-dhead" }, el("b", {}, ms.length > 1 ? tr("mis.n_selezionate", ms.length) : M.label(m)), el("span", { class: "note" }, " · " + M.typeName(m.type)),
      el("span", { style: { flex: 1 } }), el("button", { class: "mm-ib", title: tr("mis.inquadra"), html: micon("eye", 14), onclick: () => env.focus?.(m) }));
    const grid = el("div", { class: "mm-dgrid" });
    const f = (label, ctl) => grid.append(el("span", { class: "note" }, label), ctl);
    if (ms.length === 1) f(tr("mis.nome"), inp(m.name, v => (m.name = v.trim())));
    f(tr("mis.voce"), inp(m.voce, v => each(x => { x.voce = v.trim(); if (x.voce && !M.doc.voci[x.voce]) M.doc.voci[x.voce] = { color: x.color, price: null }; }), { list: voceList.id }));
    f(tr("mis.layer"), inp(m.layer, v => each(x => (x.layer = v.trim()))));
    const col = el("input", { type: "color", class: "mm-col", value: m.color });
    col.addEventListener("input", () => { each(x => (x.color = col.value)); M.redraw(); });
    col.addEventListener("change", () => M.changed());
    const extra = [col];
    if (m.type === "count") { const s = el("select", { class: "mm-in" }, ...SYMBOLS.map(k => el("option", { value: k, selected: k === m.symbol }, tr("mis.sym_" + k)))); s.addEventListener("change", () => { each(x => { if (x.type === "count") x.symbol = s.value; }); M.changed(); }); extra.push(s); }
    f(tr("mis.colore"), el("span", { class: "mm-fc" }, ...extra));
    if (m.type === "vol") {
      const s = C.scaleFor(M.doc, m.page, m.pts[0]);
      f(tr("mis.altezza") + " (" + C.dispUnit("len", M.doc) + ")", inp(+C.conv(m.h || 0, s.unit, M.doc.disp.unit).toFixed(6), v => each(x => { if (x.type === "vol") x.h = C.conv(+v || 0, M.doc.disp.unit, s.unit); }), { type: "number", step: "any" }));
    }
    const pu = ["len", "area", "vol", "count"].includes(r.main) ? (r.main === "count" ? tr("mis.al_pezzo") : "/" + r.unit) : null;
    if (pu) f(tr("mis.prezzo_unitario") + " (€" + pu + ")", inp(m.price ?? "", v => each(x => (x.price = v === "" ? null : +v)), { type: "number", step: "any", placeholder: M.doc.voci[m.voce]?.price ?? "" }));
    if (m.voce && pu) f(tr("mis.prezzo_voce", m.voce), inp(M.doc.voci[m.voce]?.price ?? "", v => { (M.doc.voci[m.voce] ||= { color: m.color }).price = v === "" ? null : +v; }, { type: "number", step: "any" }));
    f(tr("mis.note"), inp(m.note, v => each(x => (x.note = v)), { tag: "textarea", rows: 2 }));
    // valori calcolati
    const vals = el("div", { class: "mm-dvals" });
    const kv = (k, v) => vals.append(el("span", { class: "note" }, k), el("span", {}, v));
    if (ms.length === 1) {
      if (r.len != null && m.type !== "rad") kv(["area", "perim", "vol"].includes(m.type) ? tr("mis.perimetro") : tr("mis.lunghezza"), M.fmtNum(r.len) + " " + C.dispUnit("len", M.doc));
      if (r.area != null) kv(tr("mis.area"), M.fmtNum(r.area) + " " + C.dispUnit("area", M.doc));
      if (r.vol != null) kv(tr("mis.volume"), M.fmtNum(r.vol) + " " + C.dispUnit("vol", M.doc));
      if (r.rad != null) { kv(tr("mis.raggio"), M.fmtNum(r.rad) + " " + C.dispUnit("len", M.doc)); kv(tr("mis.diametro"), M.fmtNum(r.diam) + " " + C.dispUnit("len", M.doc)); }
      if (r.ang != null) kv(tr("mis.angolo"), M.fmtNum(r.ang, 2) + "°");
      if (r.elev != null) kv(tr("mis.quota"), M.fmtNum(r.elev) + " " + C.dispUnit("len", M.doc));
      if (r.count != null) kv(tr("mis.numero"), String(r.count));
      if (m.holes?.length) kv(tr("mis.fori"), String(m.holes.length));
      if (r.amount != null) kv(tr("mis.importo"), money(r.amount));
      if (r.scale && !m.q) kv(tr("mis.scala"), r.scale.none ? tr("mis.non_tarata") : r.scale.label || "—");
    }
    detail.append(head, grid, vals);
  }

  // ---------------------------------------------------------------- esportazioni
  const HEAD = () => [tr("mis.voce"), tr("mis.tipo"), tr("mis.nome"), tr("mis.layer"), tr("mis.pagina"), tr("mis.quantita"), tr("mis.unita"),
    tr("mis.lunghezza") + ` (${C.dispUnit("len", M.doc)})`, tr("mis.area") + ` (${C.dispUnit("area", M.doc)})`, tr("mis.volume") + ` (${C.dispUnit("vol", M.doc)})`, tr("mis.numero"),
    tr("mis.angolo") + " (°)", tr("mis.quota") + ` (${C.dispUnit("len", M.doc)})`, tr("mis.prezzo_unitario"), tr("mis.importo"), tr("mis.scala"), tr("mis.note"), tr("mis.colore")];
  const rnd = v => (v == null ? null : Math.round(v * 1e6) / 1e6);
  const DATA = () => M.rows().map(r => [r.m.voce || "", M.typeName(r.m.type), M.label(r.m), r.m.layer || "", r.m.page == null ? "" : r.m.page + 1, rnd(r.qty), r.unit,
    rnd(r.len), rnd(r.area), rnd(r.vol), r.count ?? null, rnd(r.ang), rnd(r.elev), r.price ?? null, rnd(r.amount), r.m.q ? "" : r.scale?.label || "", r.m.note || "", r.m.color || ""]);
  const stem = () => (env.ctx?.name || "misure").replace(/\.[^.]+$/, "");
  async function exportCsv() {
    const csv = C.toCsv(DATA(), HEAD(), LOCALE);
    await saveBlobAs(`${stem()} - ${tr("mis.misure")}.csv`, new Blob([csv], { type: "text/csv" }), dirName(env.ctx?.path || ""));
  }
  async function exportExcel() {
    await loadScript("/vendor/xlsx/dist/xlsx.full.min.js");
    const X = window.XLSX;
    const head = HEAD(), data = DATA();
    const ws = X.utils.aoa_to_sheet([head, ...data]);
    ws["!cols"] = head.map((_, i) => ({ wch: [22, 14, 26, 14, 8][i] || 13 }));
    ws["!autofilter"] = { ref: X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: data.length, c: head.length - 1 } }) };
    // riepilogo per voce e tipo con i totali
    const T = C.groupRows(M.rows(), ["voce", "type"]);
    const sh = [[tr("mis.voce"), tr("mis.tipo"), tr("mis.n_misure"), tr("mis.lunghezza") + ` (${C.dispUnit("len", M.doc)})`, tr("mis.area") + ` (${C.dispUnit("area", M.doc)})`, tr("mis.volume") + ` (${C.dispUnit("vol", M.doc)})`, tr("mis.numero"), tr("mis.importo")]];
    for (const v of T.children) for (const t of v.children) sh.push([v.label || tr("mis.senza_voce"), M.typeName(t.label), t.rows.length, rnd(t.len), rnd(t.area), rnd(t.vol), t.count || null, rnd(t.amount)]);
    sh.push([tr("mis.totale"), "", T.rows.length, rnd(T.len), rnd(T.area), rnd(T.vol), T.count || null, rnd(T.amount)]);
    const ws2 = X.utils.aoa_to_sheet(sh);
    ws2["!cols"] = sh[0].map((_, i) => ({ wch: i < 2 ? 24 : 14 }));
    const wb = X.utils.book_new();
    wb.Props = { Title: tr("mis.misure"), Author: "MB Desk" };
    X.utils.book_append_sheet(wb, ws2, tr("mis.foglio_riepilogo").slice(0, 31));
    X.utils.book_append_sheet(wb, ws, tr("mis.foglio_misure").slice(0, 31));
    if (lastExtract) { const e = extractSheet(lastExtract); X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(e), tr("mis.foglio_estrazioni").slice(0, 31)); }
    const out = X.write(wb, { bookType: "xlsx", type: "array" });
    await saveBlobAs(`${stem()} - ${tr("mis.misure")}.xlsx`, new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), dirName(env.ctx?.path || ""));
  }
  async function save() {
    try { await M.flushSave(); toast(env.space === "pdf" ? tr("mis.salvate_pdf") : tr("mis.salvate_mbmis")); } catch (e) { toast(e.message, true, 6000); }
  }

  // ================================================================ scheda Scala / Unita'
  function drawScale() {
    const p = panes.scale;
    p.innerHTML = "";
    const d = M.doc;
    const unit = el("select", { class: "mm-in", onchange: () => { d.disp.unit = unit.value; M.changed(); } }, ...DISP_UNITS.map(u => el("option", { value: u, selected: u === d.disp.unit }, u)));
    const dig = el("select", { class: "mm-in", onchange: () => { d.disp.digits = +dig.value; M.changed(); } }, ...[0, 1, 2, 3, 4].map(n => el("option", { value: n, selected: n === M.digits() }, String(n))));
    p.append(el("div", { class: "mm-sec" }, el("h4", {}, tr("mis.unita_mostrate")),
      el("div", { class: "mm-orow" }, el("span", { class: "note" }, tr("mis.unita")), unit, el("span", { class: "note" }, tr("mis.decimali")), dig)));
    if (!env.paged) {
      // CAD e 3D: valgono le unita' del file (modificabili se il file non le dichiara o sono sbagliate)
      const fu = el("select", { class: "mm-in", onchange: () => { d.base = { ...d.base, unit: fu.value, k: 1, label: fu.value }; env.base = d.base; M.changed(); drawScale(); } }, ...DISP_UNITS.map(u => el("option", { value: u, selected: u === (d.base?.unit || "m") }, u)));
      p.append(el("div", { class: "mm-sec" }, el("h4", {}, tr("mis.unita_file")), el("p", { class: "note" }, env.unitNote || tr("mis.unita_file_spiega")), el("div", { class: "mm-orow" }, el("span", { class: "note" }, tr("mis.unita_disegno")), fu)));
    }
    if (env.space !== "3d") {
      const N = el("input", { type: "number", class: "mm-in", min: 1, step: "any", value: 100 }), u = el("select", { class: "mm-in" }, ...DISP_UNITS.map(x => el("option", { value: x, selected: x === d.disp.unit }, x)));
      N.addEventListener("keydown", e => e.stopPropagation());
      const page = env.curPage?.() ?? null;
      const btnPage = el("button", { class: "btn", onclick: () => M.setScale({ ...C.ratioScale(+N.value || 100, u.value, M.paperM()), page: env.paged ? page : null }) }, env.paged ? tr("mis.applica_pagina", (page ?? 0) + 1) : tr("mis.applica"));
      const btnAll = env.paged ? el("button", { class: "btn", onclick: () => { M.doc.scales = M.doc.scales.filter(s => s.box); M.setScale({ ...C.ratioScale(+N.value || 100, u.value, M.paperM()), page: null }); } }, tr("mis.applica_tutte")) : null;
      p.append(el("div", { class: "mm-sec" }, el("h4", {}, tr("mis.scala_dichiarata")),
        el("p", { class: "note" }, env.paged ? tr("mis.scala_pdf_spiega") : tr("mis.scala_cad_spiega")),
        el("div", { class: "mm-orow" }, el("span", {}, "1 :"), N, u, btnPage, btnAll),
        el("div", { class: "mm-orow" },
          el("button", { class: "btn", onclick: () => { M.setTool("calib"); showTab("list"); } }, tr("mis.tool_calib")),
          env.tools.includes("vp") ? el("button", { class: "btn", onclick: () => { M.setTool("vp"); showTab("list"); } }, tr("mis.tool_vp")) : null,
          env.autoScale ? el("button", { class: "btn", onclick: () => autoScale() }, tr("mis.leggi_cartiglio")) : null)));
    }
    const ref = d.ref || { y: 0, value: 0 };
    p.append(el("div", { class: "mm-sec" }, el("h4", {}, tr("mis.quota_riferimento")), el("p", { class: "note" }, tr("mis.quota_riferimento_stato", M.fmtNum(C.toDisp(ref.value, "len", C.scaleFor(d, null, null).unit, d)) + " " + C.dispUnit("len", d))),
      el("button", { class: "btn", onclick: () => { M.setTool("refelev"); showTab("list"); } }, tr("mis.tool_refelev"))));
    // elenco delle scale
    const sl = el("div", { class: "mm-scales" });
    if (!d.scales.length) sl.append(el("p", { class: "note" }, env.paged ? tr("mis.nessuna_scala_pdf") : tr("mis.nessuna_scala", d.base?.unit || "—")));
    for (const s of d.scales) sl.append(el("div", { class: "mm-srow" },
      el("span", { class: "mm-slabel" }, s.label || "—"),
      el("span", { class: "note" }, (s.page == null ? tr("mis.tutto_documento") : tr("mis.pagina_0", s.page + 1)) + (s.box ? " · " + tr("mis.riquadro") : "") + (s.source ? " · " + s.source : "")),
      el("span", { class: "note" }, "1 " + (env.space === "pdf" ? "pt" : env.paperUnit || tr("mis.unita_dis")) + " = " + Number(s.k).toPrecision(5) + " " + s.unit),
      el("button", { class: "mm-ib", title: tr("mis.elimina"), html: micon("trash", 14), onclick: () => { d.scales = d.scales.filter(x => x !== s); M.changed(); drawScale(); } })));
    const show = el("input", { type: "checkbox", checked: M.showScales, onchange: () => { M.showScales = show.checked; M.redraw(); } });
    p.append(el("div", { class: "mm-sec" }, el("h4", {}, tr("mis.scale_impostate")), sl, env.tools.includes("vp") ? el("label", { class: "mm-chk" }, show, tr("mis.mostra_riquadri")) : null));
  }
  async function autoScale() {
    let found;
    try { found = await env.autoScale(); } catch (e) { return toast(e.message, true); }
    if (!found?.length) return toast(tr("mis.cartiglio_nessuna"), true, 5000);
    const box = el("div", { class: "mm-dlg" }, el("p", { class: "note" }, tr("mis.cartiglio_trovate")));
    const checks = found.map((f, i) => { const c = el("input", { type: "checkbox", checked: i === 0 || f.box }); box.append(el("label", { class: "mm-chk" }, c, `${f.label} · ${f.page == null ? tr("mis.tutto_documento") : tr("mis.pagina_0", f.page + 1)}${f.box ? " · " + tr("mis.riquadro") : ""} · ${f.source}`)); return c; });
    if (!await modal(tr("mis.leggi_cartiglio"), box, [{ label: tr("common.annulla"), value: false }, { label: "OK", value: true, primary: true }])) return;
    found.forEach((f, i) => { if (checks[i].checked) M.setScale({ k: f.k, unit: f.unit, label: f.label, page: f.page ?? null, box: f.box || null, source: f.source }); });
    drawScale();
  }

  // ================================================================ scheda Estrazioni
  let lastExtract = null, extractBusy = false;
  const exState = { group: null };
  function drawExtract() {
    const p = panes.extract;
    p.innerHTML = "";
    const bar = el("div", { class: "mm-exbar" });
    for (const x of env.extractors || []) bar.append(el("button", { class: "btn" + (lastExtract?.id === x.id ? " primary" : ""), title: x.title || "", onclick: () => runExtract(x) }, x.label));
    p.append(el("p", { class: "note" }, tr("mis.estrazioni_spiega")), bar);
    if (extractBusy) { p.append(el("p", { class: "mm-empty" }, tr("mis.calcolo_corso"))); return; }
    if (!lastExtract) return;
    p.append(renderExtract(lastExtract));
  }
  async function runExtract(x) {
    extractBusy = true;
    drawExtract();
    try {
      const r = await x.run({ doc: M.doc, page: env.curPage?.() ?? null });
      lastExtract = { ...r, id: x.id, title: x.label };
      exState.group = r.groups?.[0]?.k || null;
    } catch (e) { console.error(e); toast(e.message, true, 6000); }
    extractBusy = false;
    drawExtract();
  }
  // aggregazione dei record (quantita' in unita' del disegno) con la scala di ogni pagina/riquadro
  function aggregate(R) {
    const by = exState.group;
    const out = new Map();
    for (const rec of R.records) {
      const s = R.real ? (M.doc.base || { k: 1, unit: R.unit || "m" }) : C.scaleFor(M.doc, rec.page ?? null, rec.at);
      const k = s.k, u = R.real ? (R.unit || s.unit) : s.unit;
      const key = by ? String(rec.g?.[by] ?? "") : "";
      let a = out.get(key);
      if (!a) out.set(key, (a = { key, n: 0, len: 0, area: 0, vol: 0, count: 0, has: {}, color: rec.color, recs: [] }));
      a.n += rec.ents ?? 1; // elementi: entita' o tracciati raggruppati nel record
      a.recs.push(rec);
      if (rec.len != null) { a.len += C.toDisp(rec.len * (R.real ? 1 : k), "len", u, M.doc); a.has.len = true; }
      if (rec.area != null) { a.area += C.toDisp(rec.area * (R.real ? 1 : k * k), "area", u, M.doc); a.has.area = true; }
      if (rec.vol != null) { a.vol += C.toDisp(rec.vol * (R.real ? 1 : k * k * k), "vol", u, M.doc); a.has.vol = true; }
      if (rec.count != null) { a.count += rec.count; a.has.count = true; }
    }
    return [...out.values()].sort((x, y) => (y.len + y.area + y.vol + y.count) - (x.len + x.area + x.vol + x.count) || String(x.key).localeCompare(y.key));
  }
  function renderExtract(R) {
    const box = el("div", { class: "mm-ex" });
    box.append(el("div", { class: "mm-exhead" }, el("b", {}, R.title), R.note ? el("span", { class: "note" }, " · " + R.note) : null));
    if (R.table) { // tabelle e testi
      const tbl = el("div", { class: "mm-extable", style: `--cols:${R.table.head.length}` });
      tbl.append(...R.table.head.map(h => el("div", { class: "mm-exth" }, h)));
      for (const r of R.table.rows.slice(0, 3000)) {
        r.cells.forEach((c, i) => {
          const cell = el("div", { class: "mm-extd", title: String(c ?? "") }, c == null ? "" : String(c));
          if (i === 0 && r.focus) { cell.classList.add("link"); cell.addEventListener("click", () => env.focusRec?.(r.focus)); }
          tbl.append(cell);
        });
      }
      if (R.table.rows.length > 3000) box.append(el("p", { class: "note" }, tr("mis.prime_righe", 3000, R.table.rows.length)));
      box.append(tbl, el("div", { class: "mm-actions" }, el("button", { class: "btn", onclick: () => exportExtract(R, "xlsx") }, "Excel"), el("button", { class: "btn", onclick: () => exportExtract(R, "csv") }, "CSV")));
      return box;
    }
    if (R.groups?.length > 1) {
      const sel = el("select", { class: "mm-in", onchange: () => { exState.group = sel.value; drawExtract(); } }, ...R.groups.map(g => el("option", { value: g.k, selected: g.k === exState.group }, g.label)));
      box.append(el("div", { class: "mm-orow" }, el("span", { class: "note" }, tr("mis.raggruppa_per")), sel));
    }
    const agg = aggregate(R);
    const cols = ["len", "area", "vol", "count"].filter(k => agg.some(a => a.has[k]));
    const U = { len: C.dispUnit("len", M.doc), area: C.dispUnit("area", M.doc), vol: C.dispUnit("vol", M.doc), count: "" };
    const tbl = el("div", { class: "mm-extable", style: `--cols:${cols.length + 2}` });
    tbl.append(el("div", { class: "mm-exth" }, R.groups?.find(g => g.k === exState.group)?.label || ""), el("div", { class: "mm-exth num" }, tr("mis.elementi")), ...cols.map(k => el("div", { class: "mm-exth num" }, tr("mis.q_" + k) + (U[k] ? ` (${U[k]})` : ""))));
    const tot = { n: 0, len: 0, area: 0, vol: 0, count: 0 };
    for (const a of agg) {
      const name = el("div", { class: "mm-extd link", title: a.key }, a.color ? el("span", { class: "mm-sw", style: `background:${a.color}` }) : null, a.key === "" ? "—" : R.fmtKey ? R.fmtKey(a.key, exState.group) : a.key);
      name.addEventListener("click", () => env.showRecs?.(a.recs, R));
      tbl.append(name, el("div", { class: "mm-extd num" }, fmtNum(a.n, 0)), ...cols.map(k => el("div", { class: "mm-extd num" }, a.has[k] ? (k === "count" ? fmtNum(a[k], 0) : M.fmtNum(a[k])) : "")));
      for (const k of Object.keys(tot)) tot[k] += a[k] || 0;
    }
    tbl.append(el("div", { class: "mm-extd tot" }, tr("mis.totale")), el("div", { class: "mm-extd num tot" }, fmtNum(tot.n, 0)), ...cols.map(k => el("div", { class: "mm-extd num tot" }, k === "count" ? fmtNum(tot[k], 0) : M.fmtNum(tot[k]))));
    box.append(tbl, el("div", { class: "mm-actions" },
      el("button", { class: "btn primary", title: tr("mis.aggiungi_elenco_titolo"), onclick: () => addToList(R, agg, cols) }, tr("mis.aggiungi_elenco")),
      el("button", { class: "btn", onclick: () => exportExtract(R, "xlsx") }, "Excel"), el("button", { class: "btn", onclick: () => exportExtract(R, "csv") }, "CSV")));
    if (R.warn) box.append(el("p", { class: "note mm-warn" }, R.warn));
    return box;
  }
  function addToList(R, agg, cols) {
    const main = cols[0];
    let i = 0;
    for (const a of agg) {
      const q = {};
      for (const k of cols) if (a.has[k]) q[k] = k === "count" ? a.count : C.conv(a[k], M.doc.disp.unit, M.doc.disp.unit);
      const kind = main;
      M.doc.items.push({ id: C.uid(), type: "ext", page: null, pts: [], q, kind, unit: M.doc.disp.unit, name: a.key === "" ? "—" : R.fmtKey ? R.fmtKey(a.key, exState.group) : String(a.key), voce: R.title, layer: exState.group === "layer" ? String(a.key) : "", color: a.color || C.PALETTE[i++ % C.PALETTE.length], note: "", created: new Date().toISOString() });
    }
    M.changed();
    showTab("list");
    toast(tr("mis.aggiunte_n", agg.length));
  }
  function extractSheet(R) {
    if (R.table) return [R.table.head, ...R.table.rows.map(r => r.cells)];
    const agg = aggregate(R);
    const cols = ["len", "area", "vol", "count"].filter(k => agg.some(a => a.has[k]));
    const U = { len: C.dispUnit("len", M.doc), area: C.dispUnit("area", M.doc), vol: C.dispUnit("vol", M.doc), count: "" };
    return [[R.groups?.find(g => g.k === exState.group)?.label || "", tr("mis.elementi"), ...cols.map(k => tr("mis.q_" + k) + (U[k] ? ` (${U[k]})` : ""))],
      ...agg.map(a => [a.key, a.n, ...cols.map(k => (a.has[k] ? rnd(a[k]) : null))])];
  }
  async function exportExtract(R, kind) {
    const aoa = extractSheet(R);
    const name = `${stem()} - ${R.title}`.replace(/[\\/:*?"<>|]/g, "_");
    if (kind === "csv") return saveBlobAs(name + ".csv", new Blob([C.toCsv(aoa.slice(1), aoa[0], LOCALE)], { type: "text/csv" }), dirName(env.ctx?.path || ""));
    await loadScript("/vendor/xlsx/dist/xlsx.full.min.js");
    const X = window.XLSX, wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(aoa), String(R.title).slice(0, 31).replace(/[\\/?*[\]:]/g, " "));
    await saveBlobAs(name + ".xlsx", new Blob([X.write(wb, { bookType: "xlsx", type: "array" })]), dirName(env.ctx?.path || ""));
  }

  // ---------------------------------------------------------------- aggiornamenti
  M.on(() => { syncTools(); if (tab === "list") drawList(); else if (tab === "scale") drawScale(); });
  drawTools();
  showTab("list");
  drawList();
  const api = {
    el: root,
    get open() { return !root.hidden; },
    toggle(v = root.hidden) {
      root.hidden = !v;
      if (!v) M.setTool(null);
      else if (!M.tool) M.setTool(env.space === "3d" ? "len" : "select");
      env.onPanel?.(v);
      M.redraw();
    },
    showTab,
    exportExcel, exportCsv,
    get lastExtract() { return lastExtract; },
    runExtract: id => runExtract(env.extractors.find(x => x.id === id)),
    aggregate,
  };
  return api;
}
