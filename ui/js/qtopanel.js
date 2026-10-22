// Computo delle quantita' (come Quantification di Navisworks Manage): lunghezze, aree, volumi, pesi e conteggi dalle
// Qto/Pset IFC (ui/js/qtocore.js), raggruppati per classe, tipo e livello; clic su una riga = elementi selezionati nel 3D;
// esportazione in Excel (riepilogo + un foglio con tutti gli elementi e tutte le quantita').
import { dirName, el, loadScript, saveBlobAs, toast } from "./core.js";
import { t as tr, LOCALE } from "./i18n.js";

const COLS = [["count", "qto.n", ""], ["length", "qto.lunghezza", "m"], ["area", "qto.area", "m²"], ["volume", "qto.volume", "m³"], ["weight", "qto.peso", "kg"]];
const GROUPS = { "cls,type,level": "qto.g_classe_tipo_livello", "level,cls,type": "qto.g_livello_classe_tipo", "type,level": "qto.g_tipo_livello", "cls,level": "qto.g_classe_livello", "level": "qto.g_livello" };
const KEY_LABEL = { cls: "qto.classe", type: "qto.tipo", level: "qto.livello" };

export function qtoPane(N, box) {
  const { h } = N;
  const S = { rows: null, tree: null, open: new Set(), scope: "all", sel: null, busy: false };
  const num = (v, d = 3) => (v == null ? "" : Number(v).toLocaleString(LOCALE, { maximumFractionDigits: d, minimumFractionDigits: d }));
  const DIG = { length: 2, area: 2, volume: 3, weight: 1 };
  const bar = el("div", { class: "nav-bar wrap" });
  const info = el("div", { class: "note nav-summary" });
  const table = el("div", { class: "qto-table" });
  box.append(bar, info, table);

  const groupSel = el("select", { title: tr("qto.raggruppa_per"), onchange: () => { N.doc.takeoff.groupBy = groupSel.value; N.changed(); S.open.clear(); regroup(); } },
    ...Object.entries(GROUPS).map(([k, l]) => el("option", { value: k, selected: (N.doc.takeoff?.groupBy || "cls,type,level") === k }, tr(l))));
  const scopeSel = el("select", { title: tr("qto.elementi_computati"), onchange: () => { S.scope = scopeSel.value; compute(); } },
    el("option", { value: "all" }, tr("qto.tutto_il_modello")), el("option", { value: "visible" }, tr("qto.solo_visibili")), el("option", { value: "selection" }, tr("qto.solo_selezione")));
  bar.append(el("button", { class: "btn primary", onclick: () => compute(), title: tr("qto.calcola_titolo") }, tr("qto.calcola")), groupSel, scopeSel,
    el("span", { style: { flex: 1 } }), el("button", { class: "btn", onclick: () => toExcel(), title: tr("qto.excel_titolo") }, "Excel"));

  const recOf = new Map(); // "mid:id" -> elemento della scena
  async function compute() {
    if (S.busy) return;
    if (!h.info.ifc) { table.innerHTML = ""; info.textContent = ""; table.append(el("p", { class: "nav-empty" }, tr("qto.solo_ifc"))); return; }
    S.busy = true;
    table.innerHTML = "";
    table.append(el("p", { class: "nav-empty" }, tr("qto.calcolo_corso")));
    await new Promise(r => setTimeout(r, 30));
    try {
      await N.ready();
      const Q = N._qto;
      let units = N.index().units.filter(u => u.id !== undefined && u.mid !== undefined);
      if (S.scope === "visible") units = units.filter(u => h.isVisibleChain(u.obj));
      else if (S.scope === "selection") { const keys = new Set(N.selectionKeys()); units = units.filter(u => keys.has(N.keyOf(u))); }
      recOf.clear();
      const byMid = new Map();
      for (const u of units) { recOf.set(u.mid + ":" + u.id, u); if (!byMid.has(u.mid)) byMid.set(u.mid, { mid: u.mid, name: N.modelName(u), ids: [] }); byMid.get(u.mid).ids.push(u.id); }
      const t0 = performance.now();
      S.rows = Q.takeoff(h.info.ifc, h.info.WEBIFC, [...byMid.values()], mid => byMid.get(mid).ids);
      S.ms = performance.now() - t0;
      regroup();
    } catch (e) { console.error(e); table.innerHTML = ""; table.append(el("p", { class: "nav-empty" }, tr("qto.errore", e.message))); }
    S.busy = false;
  }
  function regroup() {
    if (!S.rows) return;
    S.tree = N._qto.groupRows(S.rows, groupSel.value.split(","));
    const withQ = S.rows.filter(r => r.qs.length).length;
    info.textContent = tr("qto.riepilogo_0_1", S.rows.length.toLocaleString(LOCALE), withQ.toLocaleString(LOCALE)) + (withQ < S.rows.length ? " " + tr("qto.senza_quantita_nota") : "");
    draw();
  }
  const label = (node) => node.label || (node.key === "level" ? tr("qto.senza_livello") : node.key === "type" ? tr("qto.senza_tipo") : "—");
  function draw() {
    table.innerHTML = "";
    const T = S.tree;
    if (!T) return;
    const head = el("div", { class: "qto-row qto-head" }, el("div", { class: "qto-name" }, groupSel.value.split(",").map(k => tr(KEY_LABEL[k])).join(" › ")),
      ...COLS.map(([k, l, u]) => el("div", { class: "qto-num" }, tr(l) + (u ? ` (${u})` : ""))));
    table.append(head);
    const line = (node, depth, path) => {
      const id = path.join("\u0001");
      const kids = node.children || [];
      const open = S.open.has(id);
      const r = el("div", { class: "qto-row" + (S.sel === id ? " sel" : ""), style: { "--d": depth } },
        el("div", { class: "qto-name", title: label(node) },
          el("span", { class: "nav-twist", onclick: e => { e.stopPropagation(); if (open) S.open.delete(id); else S.open.add(id); draw(); } }, kids.length ? (open ? "▾" : "▸") : ""),
          el("span", { class: "nav-ell" }, label(node))),
        ...COLS.map(([k]) => el("div", { class: "qto-num" }, k === "count" ? num(node.count, 0) : node.n[k] ? num(node[k], DIG[k]) : "")));
      r.addEventListener("click", () => { S.sel = id; table.querySelectorAll(".qto-row.sel").forEach(x => x.classList.remove("sel")); r.classList.add("sel"); selectRows(node.rows, false); });
      r.addEventListener("dblclick", () => selectRows(node.rows, true));
      table.append(r);
      if (open) kids.forEach(k => line(k, depth + 1, [...path, k.label]));
    };
    T.children.forEach(c => line(c, 0, [c.label]));
    table.append(el("div", { class: "qto-row qto-total" }, el("div", { class: "qto-name" }, tr("qto.totale")),
      ...COLS.map(([k]) => el("div", { class: "qto-num" }, k === "count" ? num(T.count, 0) : T.n[k] ? num(T[k], DIG[k]) : ""))));
  }
  function selectRows(rows, zoom) {
    const objs = rows.map(r => recOf.get(r.mid + ":" + r.id)?.obj).filter(Boolean);
    N.clearHighlight();
    if (objs.length > 5000) return toast(tr("qto.troppi"), true);
    h.select(objs, { scroll: false });
    if (zoom) h.zoomTo(objs);
    h.ctx.status(tr("qto.selezionati_0", objs.length.toLocaleString(LOCALE)));
  }

  async function toExcel() {
    if (!S.rows) await compute();
    if (!S.rows?.length) return toast(tr("qto.niente_da_esportare"), true);
    await loadScript("/vendor/xlsx/dist/xlsx.full.min.js");
    const X = window.XLSX;
    const keys = groupSel.value.split(",");
    const qh = COLS.map(([k, l, u]) => tr(l) + (u ? ` (${u})` : ""));
    // riepilogo: una colonna per livello di raggruppamento, righe dei gruppi con i totali
    const sum = [[...keys.map(k => tr(KEY_LABEL[k])), ...qh]];
    const walk = (node, depth, path) => {
      const row = keys.map((k, i) => (i < depth ? path[i] : i === depth ? label(node) : ""));
      sum.push([...row, ...COLS.map(([k]) => (k === "count" ? node.count : node.n[k] ? round(node[k]) : null))]);
      for (const c of node.children || []) walk(c, depth + 1, [...path, label(node)]);
    };
    S.tree.children.forEach(c => walk(c, 0, []));
    sum.push([tr("qto.totale"), ...keys.slice(1).map(() => ""), ...COLS.map(([k]) => (k === "count" ? S.tree.count : S.tree.n[k] ? round(S.tree[k]) : null))]);
    const ws = X.utils.aoa_to_sheet(sum);
    ws["!cols"] = [...keys.map(() => ({ wch: 28 })), ...COLS.map(() => ({ wch: 14 }))];
    ws["!autofilter"] = { ref: X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: sum.length - 1, c: sum[0].length - 1 } }) };
    // elementi: tutte le quantita' trovate, una colonna per "set · nome"
    const qcols = [];
    const seen = new Set();
    for (const r of S.rows) for (const q of r.qs) { const k = q.set + " · " + q.name; if (!seen.has(k)) { seen.add(k); qcols.push([k, q.kind]); } }
    const U = { length: "m", area: "m²", volume: "m³", weight: "kg", count: "" };
    const eh = [tr("qto.modello"), tr("qto.livello"), tr("qto.classe"), tr("qto.tipo"), tr("qto.nome"), "Tag", "GlobalId", ...qh, ...qcols.map(([k, kind]) => k + (U[kind] ? ` (${U[kind]})` : ""))];
    const er = S.rows.map(r => {
      const m = new Map(r.qs.map(q => [q.set + " · " + q.name, q.v]));
      return [r.model, r.level, r.cls, r.type, r.name, r.tag, r.guid, ...COLS.map(([k]) => (k === "count" ? r.count : r[k] != null ? round(r[k]) : null)), ...qcols.map(([k]) => (m.has(k) ? round(m.get(k)) : null))];
    });
    const we = X.utils.aoa_to_sheet([eh, ...er]);
    we["!cols"] = eh.map((_, i) => ({ wch: i < 7 ? (i === 6 ? 24 : 18) : 14 }));
    we["!autofilter"] = { ref: X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: er.length, c: eh.length - 1 } }) };
    const wb = X.utils.book_new();
    wb.Props = { Title: tr("qto.computo_quantita"), Author: "MB Visual" };
    X.utils.book_append_sheet(wb, ws, tr("qto.foglio_riepilogo").slice(0, 31));
    X.utils.book_append_sheet(wb, we, tr("qto.foglio_elementi").slice(0, 31));
    const out = X.write(wb, { bookType: "xlsx", type: "array" });
    await saveBlobAs(`${h.ctx.name.replace(/\.[^.]+$/, "")} - ${tr("qto.computo")}.xlsx`, new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), dirName(h.ctx.path || ""));
  }
  const round = v => Math.round(v * 1e6) / 1e6;

  return {
    onShow() { if (!S.rows && !S.busy) compute(); },
    reload() { S.rows = null; S.tree = null; if (!box.hidden) compute(); },
    get _state() { return S; },
  };
}
