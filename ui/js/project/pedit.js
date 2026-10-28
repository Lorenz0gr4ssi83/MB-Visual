// Editor dei piani di progetto in stile Microsoft Project: barra multifunzione (schede Attivita', Risorse, Progetto,
// Visualizza, Formato), tabella delle attivita' modificabile come un foglio, diagramma di Gantt sincronizzato su canvas
// (trascinamento di barre, durate, avanzamento e collegamenti), sequenza temporale, annulla/ripeti e tasti di Project.
// Le altre viste (calendario, reticolare, risorse, uso risorse, confronto, avanzamento) sono in pviews.js.
// Il puntatore resta sempre la freccia: le maniglie si evidenziano al passaggio invece di cambiare cursore.
import { el, button, modal, toast, confirmBox } from "../core.js";
import { t, tn, LOCALE } from "../i18n.js";
import { keymap } from "../shortcuts.js";
import { schedule, newTask, outline, isMilestone, leaves, snapshot, restore, predsText, parsePreds, setBaseline, level, addItalianHolidays, calendarsOf, resourceUsage, nextUid, isElapsed, CT } from "./pmodel.js";
import { DAY, dayOf, weekday, ymd, fromParts, newCalendar, STD_WEEK } from "./pcal.js";
import { fd, fdt, fdd, fmon, fmons, fdm, fwd, parseUserDate, durText, durParse, unitLabels, money, hours } from "./pfmt.js";
import * as V from "./pviews.js";
import * as X from "./pexport.js";

const RH = 24;           // altezza delle righe
const HEAD = 44;         // intestazione (due livelli della scala temporale)
const ZOOMS = [1.5, 3, 6, 12, 22, 36, 60, 110];
const IC = {
  task: '<svg viewBox="0 0 24 24"><path d="M3 7h12v4H3zM9 15h12v4H9z"/></svg>',
  sum: '<svg viewBox="0 0 24 24"><path d="M3 6h18v4H3zM6 14h10v4H6zM3 6v6M21 6v6"/></svg>',
  ms: '<svg viewBox="0 0 24 24"><path d="M12 4l7 8-7 8-7-8z"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  ind: '<svg viewBox="0 0 24 24"><path d="M4 5h16M10 10h10M10 15h10M4 20h16M4 9l3 3-3 3"/></svg>',
  out: '<svg viewBox="0 0 24 24"><path d="M4 5h16M10 10h10M10 15h10M4 20h16M7 9l-3 3 3 3"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  unlink: '<svg viewBox="0 0 24 24"><path d="M15.7 14l3-3a4 4 0 0 0-5.7-5.7l-1 1M8.3 10l-3 3a4 4 0 0 0 5.7 5.7l1-1M4 4l16 16"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M5 3h10l4 4v14H5zM9 11h6M9 15h6"/></svg>',
  manual: '<svg viewBox="0 0 24 24"><path d="M7 11V5a1.5 1.5 0 0 1 3 0v5M10 10V4a1.5 1.5 0 0 1 3 0v6M13 10V5a1.5 1.5 0 0 1 3 0v6M16 11V8a1.5 1.5 0 0 1 3 0v6c0 4-3 7-7 7s-6-2-7-5l-1.5-3a1.5 1.5 0 0 1 2.6-1.4L7 14"/></svg>',
  auto: '<svg viewBox="0 0 24 24"><path d="M3 7h10v4H3zM11 15h10v4H11zM13 9h3v6"/><path d="M14 13l2 2 2-2"/></svg>',
  res: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-4 3.5-6 6.5-6s5.7 2 6.5 6M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2 .8 3.2 3 3.5 6"/></svg>',
  level: '<svg viewBox="0 0 24 24"><path d="M3 20h18M5 16h6v4H5zM13 12h6v8h-6zM5 8h6v4H5z"/></svg>',
  cal: '<svg viewBox="0 0 24 24"><path d="M4 5h16v16H4zM4 10h16M8 3v4M16 3v4"/></svg>',
  base: '<svg viewBox="0 0 24 24"><path d="M3 8h12v4H3zM3 15h16"/><path d="M3 18h16" stroke-dasharray="2 2"/></svg>',
  crit: '<svg viewBox="0 0 24 24"><path d="M3 6h7v4H3zM10 14h7v4h-7zM6 10v6h4" stroke="#d13438"/></svg>',
  slack: '<svg viewBox="0 0 24 24"><path d="M3 9h9v4H3zM12 11h9"/><path d="M21 9v4"/></svg>',
  time: '<svg viewBox="0 0 24 24"><path d="M3 9h18M5 9v6h6V9M14 9l3 3-3 3"/></svg>',
  zin: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5M8 11h6M11 8v6"/></svg>',
  zout: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5M8 11h6"/></svg>',
  fit: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  goto: '<svg viewBox="0 0 24 24"><path d="M3 12h13M12 7l5 5-5 5M20 5v14"/></svg>',
  undo: '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3"/></svg>',
  redo: '<svg viewBox="0 0 24 24"><path d="M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3"/></svg>',
  pdf: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v4h4M9 13h6M9 17h4"/></svg>',
  xls: '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4zM4 9h16M4 14h16M10 4v16"/></svg>',
  img: '<svg viewBox="0 0 24 24"><path d="M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6"/></svg>',
  cmp: '<svg viewBox="0 0 24 24"><path d="M4 4h7v16H4zM13 4h7v16h-7M7 9h1M16 9h1M7 13h1M16 15h1"/></svg>',
  client: '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4zM7 8h6M7 12h10M7 16h4"/><path d="M15 15l2 2 3-4"/></svg>',
  proj: '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4zM8 9h8M8 13h5"/></svg>',
  cols: '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4zM10 4v16M15 4v16"/></svg>',
  pct: '<svg viewBox="0 0 24 24"><path d="M3 8h18v8H3z"/><path d="M3 8h10v8H3z" fill="currentColor" opacity=".35"/></svg>',
};

const ALL_COLS = ["ind", "id", "mode", "wbs", "name", "dur", "start", "finish", "preds", "res", "pct", "ts", "cost", "work", "bls", "blf", "dl", "ct"];
const DEF_COLS = ["ind", "id", "mode", "name", "dur", "start", "finish", "preds", "res", "pct"];
const COLW = { ind: 24, id: 38, mode: 26, wbs: 64, name: 250, dur: 76, start: 104, finish: 104, preds: 92, res: 140, pct: 58, ts: 76, cost: 96, work: 76, bls: 104, blf: 104, dl: 104, ct: 120 };

export function createEditor(ctx, P, opt = {}) {
  const L = k => t("proj." + k);
  const S = {
    P, view: opt.view || "gantt", zoom: 3, sel: new Set(), anchor: null, cur: { row: 0, col: "name" },
    collapsed: new Set(), undo: [], redo: [], clip: null, other: null, filter: "",
    o: Object.assign({ crit: true, base: false, slack: false, timeline: true, today: true, names: true }, loadOpt()),
    cols: loadCols(),
  };
  let rows = [];
  // ---------------------------------------------------------------- struttura
  const root = el("div", { class: "pj-root" });
  const tlCanvas = el("canvas", { class: "pj-tl" });
  const gridHead = el("div", { class: "pj-ghead" });
  const gridInner = el("div", { class: "pj-ginner" });
  const gridBody = el("div", { class: "pj-gbody" }, gridInner);
  const grid = el("div", { class: "pj-grid" }, gridHead, gridBody);
  const chartHead = el("canvas", { class: "pj-chead" });
  const chartCanvas = el("canvas", { class: "pj-ccanvas" });
  const spacer = el("div", { class: "pj-spacer" });
  const chartScroll = el("div", { class: "pj-cscroll" }, chartCanvas, spacer);
  const chart = el("div", { class: "pj-chart" }, chartHead, chartScroll);
  const split = el("div", { class: "pj-split", title: L("trascina_divisore") });
  const gantt = el("div", { class: "pj-gantt" }, grid, split, chart);
  const other = el("div", { class: "pj-other", hidden: true });
  root.append(tlCanvas, gantt, other);
  ctx.el.innerHTML = "";
  ctx.fillBody(true);
  ctx.el.append(root);
  let gridW = Math.min(+(localStorage.getItem("mbv-pj-gridw") || 0) || 620, 1400);
  const setGridW = w => { gridW = Math.max(120, Math.min(w, root.clientWidth - 160 || w)); grid.style.width = gridW + "px"; };
  setGridW(gridW);
  split.addEventListener("pointerdown", e => {
    const x0 = e.clientX, w0 = gridW;
    split.setPointerCapture(e.pointerId);
    const mv = ev => { setGridW(w0 + ev.clientX - x0); draw(); };
    const up = () => { split.removeEventListener("pointermove", mv); split.removeEventListener("pointerup", up); try { localStorage.setItem("mbv-pj-gridw", gridW); } catch { /* */ } };
    split.addEventListener("pointermove", mv); split.addEventListener("pointerup", up);
  });

  // ---------------------------------------------------------------- annulla / modifiche
  function change(fn, label = "") {
    S.undo.push(snapshot(S.P));
    if (S.undo.length > 100) S.undo.shift();
    S.redo.length = 0;
    try { fn(); } catch (e) { S.undo.pop(); toast(e.message || String(e), true); return false; }
    commit();
    if (label) ctx.status?.(label);
    return true;
  }
  function commit() {
    schedule(S.P);
    ctx.setDirty(true);
    refresh();
  }
  function undo() { if (!S.undo.length) return; S.redo.push(snapshot(S.P)); setP(restore(S.undo.pop())); }
  function redo() { if (!S.redo.length) return; S.undo.push(snapshot(S.P)); setP(restore(S.redo.pop())); }
  function setP(np) { S.P = np; E.P = np; schedule(np); ctx.setDirty(true); refresh(); }

  // ---------------------------------------------------------------- righe visibili
  function computeRows() {
    const out = [];
    const q = S.filter.trim().toLowerCase();
    for (const tk of S.P.tasks) {
      let hide = false;
      for (let p = tk.parent; p; p = p.parent) if (S.collapsed.has(p.uid)) { hide = true; break; }
      if (hide) continue;
      if (q === ":crit" && !tk.crit) continue;
      if (q === ":late" && !(tk.late || (tk.finish < now() && (tk.pct || 0) < 100))) continue;
      if (q === ":ms" && !isMilestone(tk) && !tk.sum) continue;
      if (q && q[0] !== ":" && !(tk.name || "").toLowerCase().includes(q) && !tk.sum) continue;
      out.push(tk);
    }
    rows = out;
  }
  const now = () => { const d = new Date(); return fromParts(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()); };

  // ---------------------------------------------------------------- tabella
  const colTitle = c => ({ ind: "", id: "", mode: "", wbs: L("c_wbs"), name: L("c_nome"), dur: L("c_durata"), start: L("c_inizio"), finish: L("c_fine"), preds: L("c_predecessori"), res: L("c_risorse"), pct: L("c_pct"), ts: L("c_margine"), cost: L("c_costo"), work: L("c_lavoro"), bls: L("c_bl_inizio"), blf: L("c_bl_fine"), dl: L("c_scadenza"), ct: L("c_vincolo") }[c]);
  function cellText(tk, c) {
    const P = S.P;
    switch (c) {
      case "id": return String(tk.id);
      case "wbs": return tk.wbs || tk.on;
      case "name": return tk.name;
      case "dur": return tk.isNull ? "" : durText(P, tk);
      case "start": return tk.isNull ? "" : fd(tk.start);
      case "finish": return tk.isNull ? "" : fd(tk.finish);
      case "preds": return predsText(P, tk, unitLabels());
      case "res": return (tk.resNames || []).join(";");
      case "pct": return tk.isNull ? "" : `${Math.round(tk.pct || 0)}%`;
      case "ts": return tk.isNull ? "" : durText(P, { dur: Math.max(0, tk.ts || 0), du: "d" });
      case "cost": return tk.isNull ? "" : money(tk.cost, P.currency);
      case "work": return tk.isNull ? "" : hours(tk.work);
      case "bls": return fd(tk.bl?.[0]?.start);
      case "blf": return fd(tk.bl?.[0]?.finish);
      case "dl": return fd(tk.dl);
      case "ct": return L("ct_" + CT[tk.ct || 0].toLowerCase());
      default: return "";
    }
  }
  function renderHead() {
    gridHead.innerHTML = "";
    let x = 0;
    for (const c of S.cols) {
      const w = COLW[c];
      gridHead.append(el("div", { class: "pj-hc", style: { left: x + "px", width: w + "px" }, title: colTitle(c) }, colTitle(c)));
      x += w;
    }
    gridInner.style.width = x + "px";
    gridHead.style.width = x + "px";
  }
  function renderGrid() {
    const top = chartScroll.scrollTop, h = chartScroll.clientHeight || 600;
    const extra = 30;
    const n = rows.length + extra;
    gridInner.style.height = n * RH + "px";
    gridInner.innerHTML = "";
    const i0 = Math.max(0, Math.floor(top / RH) - 2), i1 = Math.min(n, Math.ceil((top + h) / RH) + 2);
    const over = S.overTasks || new Set();
    for (let i = i0; i < i1; i++) {
      const tk = rows[i];
      const r = el("div", { class: "pj-row" + (tk && S.sel.has(tk.uid) ? " sel" : "") + (tk?.sum ? " sum" : "") + (tk && S.o.crit && tk.crit && !tk.sum ? " crit" : "") + (tk?.act === false ? " off" : ""), style: { top: i * RH + "px" }, "data-i": i });
      let x = 0;
      for (const c of S.cols) {
        const w = COLW[c];
        const cell = el("div", { class: "pj-c pj-c-" + c + (S.cur.row === i && S.cur.col === c ? " cur" : ""), style: { left: x + "px", width: w + "px" }, "data-c": c });
        if (tk) {
          if (c === "name") {
            cell.style.paddingLeft = 4 + (tk.lvl - 1) * 16 + "px";
            if (tk.sum) cell.append(el("span", { class: "pj-tog", "data-tog": tk.uid }, S.collapsed.has(tk.uid) ? "▸" : "▾"));
            cell.append(el("span", { class: "pj-nm" }, tk.name));
          } else if (c === "mode") {
            cell.innerHTML = tk.isNull ? "" : tk.manual ? IC.manual : IC.auto;
            cell.title = tk.manual ? L("manuale") : L("automatica");
          } else if (c === "ind") {
            const ic = [];
            if (tk.pct >= 100) ic.push(["✓", L("ind_completata"), "ok"]);
            if (tk.notes) ic.push(["✎", tk.notes.slice(0, 200), ""]);
            if (tk.ct > 1) ic.push(["▣", L("ct_" + CT[tk.ct].toLowerCase()) + " " + fd(tk.cd), ""]);
            if (tk.late) ic.push(["!", L("ind_oltre_scadenza"), "bad"]);
            if (over.has(tk.uid)) ic.push(["♟", L("ind_sovrallocata"), "bad"]);
            if (tk.fromFile) ic.push(["⚑", L("ind_da_file"), ""]);
            for (const [s, ti, cl] of ic.slice(0, 2)) cell.append(el("span", { class: "pj-ind " + cl, title: ti }, s));
          } else cell.textContent = cellText(tk, c);
        }
        r.append(cell);
        x += w;
      }
      gridInner.append(r);
    }
  }
  gridBody.addEventListener("wheel", e => { chartScroll.scrollTop += e.deltaY; e.preventDefault(); }, { passive: false });
  gridBody.addEventListener("scroll", () => { gridHead.style.transform = `translateX(${-gridBody.scrollLeft}px)`; });
  gridInner.addEventListener("pointerdown", e => {
    const rEl = e.target.closest(".pj-row");
    if (!rEl) return;
    const i = +rEl.dataset.i;
    const cEl = e.target.closest(".pj-c");
    const tog = e.target.closest("[data-tog]");
    if (tog) { const u = +tog.dataset.tog; S.collapsed.has(u) ? S.collapsed.delete(u) : S.collapsed.add(u); refresh(); return; }
    if (editing && !e.target.closest(".pj-edit")) commitEdit();
    if (e.target.closest(".pj-edit")) return;
    e.preventDefault(); // la riga viene ridisegnata: senza questo il fuoco finirebbe sulla pagina
    root.focus({ preventScroll: true });
    selectRow(i, e.shiftKey, e.ctrlKey || e.metaKey);
    if (cEl) S.cur = { row: i, col: cEl.dataset.c };
    renderGrid(); draw();
  });
  gridInner.addEventListener("dblclick", e => {
    const rEl = e.target.closest(".pj-row"), cEl = e.target.closest(".pj-c");
    if (!rEl || !cEl) return;
    const i = +rEl.dataset.i, c = cEl.dataset.c;
    if (["id", "ind", "mode"].includes(c) && rows[i]) { taskInfo(rows[i]); return; }
    startEdit(i, c);
  });
  function selectRow(i, shift, ctrl) {
    const tk = rows[i];
    if (!tk) { if (!ctrl && !shift) S.sel.clear(); S.anchor = i; return; }
    if (shift && S.anchor != null) {
      S.sel.clear();
      for (let k = Math.min(S.anchor, i); k <= Math.max(S.anchor, i); k++) if (rows[k]) S.sel.add(rows[k].uid);
    } else if (ctrl) { S.sel.has(tk.uid) ? S.sel.delete(tk.uid) : S.sel.add(tk.uid); S.anchor = i; }
    else { S.sel.clear(); S.sel.add(tk.uid); S.anchor = i; }
  }
  const selTasks = () => S.P.tasks.filter(x => S.sel.has(x.uid));
  const curTask = () => rows[S.cur.row] || null;

  // modifica sul posto
  let editing = null;
  function startEdit(i, c, initial = null) {
    if (!["name", "dur", "start", "finish", "preds", "res", "pct", "wbs", "dl"].includes(c)) return;
    const tk = rows[i];
    if (tk?.sum && ["dur", "start", "finish", "pct"].includes(c)) return toast(L("riepilogo_calcolato"));
    if (!tk && c !== "name") return;
    S.cur = { row: i, col: c };
    renderGrid();
    const cell = gridInner.querySelector(`.pj-row[data-i="${i}"] .pj-c-${c}`);
    if (!cell) return;
    const val = initial != null ? initial : tk ? (c === "start" ? fdt(tk.start) : c === "finish" ? fdt(tk.finish) : c === "dl" ? fdt(tk.dl) : c === "pct" ? String(Math.round(tk.pct || 0)) : cellText(tk, c)) : "";
    const inp = el("input", { class: "pj-edit", value: val, spellcheck: "false" });
    cell.textContent = "";
    cell.append(inp);
    editing = { i, c, inp, tk };
    inp.focus();
    if (initial != null) inp.setSelectionRange(inp.value.length, inp.value.length); else inp.select();
    inp.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); commitEdit(); move(1, 0); }
      else if (e.key === "Tab") { e.preventDefault(); commitEdit(); move(0, e.shiftKey ? -1 : 1); }
      else if (e.key === "Escape") { e.preventDefault(); editing = null; renderGrid(); root.focus({ preventScroll: true }); }
      e.stopPropagation();
    });
    inp.addEventListener("blur", () => setTimeout(() => { if (editing?.inp === inp) commitEdit(); }, 0));
  }
  function commitEdit() {
    const ed = editing;
    if (!ed) return;
    editing = null;
    const v = ed.inp.value;
    let tk = ed.tk;
    const P = S.P;
    const before = tk ? cellTextRaw(tk, ed.c) : "";
    if (v === before) { renderGrid(); return; }
    change(() => {
      if (!tk) {
        if (!v.trim()) return;
        // riga vuota: nuova attivita' in fondo
        const prev = P.tasks[P.tasks.length - 1];
        tk = newTask(P, { name: v, lvl: prev ? (prev.sum ? prev.lvl + 1 : prev.lvl) : 1, dur: P.mpd, est: true });
        if (prev?.sum) tk.lvl = prev.lvl;
        P.tasks.push(tk);
        S.sel = new Set([tk.uid]);
        return;
      }
      setField(tk, ed.c, v);
    });
  }
  function cellTextRaw(tk, c) { return c === "start" ? fdt(tk.start) : c === "finish" ? fdt(tk.finish) : c === "dl" ? fdt(tk.dl) : c === "pct" ? String(Math.round(tk.pct || 0)) : cellText(tk, c); }
  function setField(tk, c, v) {
    const P = S.P;
    const cal = calendarsOf(P).get(tk.cal ?? P.cal);
    switch (c) {
      case "name": tk.name = v; break;
      case "wbs": tk.wbs = v.trim(); break;
      case "dur": {
        const d = durParse(P, v);
        if (!d) throw new Error(L("durata_non_valida"));
        tk.dur = d.dur; tk.du = d.du; tk.est = d.est;
        if (tk.manual && tk.start != null) tk.finish = isElapsed(d.du) ? tk.start + d.dur : cal.add(tk.start, d.dur);
        for (const a of P.assignments) if (a.task === tk.uid) a.w = null;
        break;
      }
      case "start": {
        const d = parseUserDate(v, 480);
        if (d == null) throw new Error(L("data_non_valida"));
        if (tk.manual) { const dur = tk.dur; tk.start = d; tk.finish = isElapsed(tk.du) ? d + dur : cal.add(d, dur); }
        else { tk.ct = 4; tk.cd = d; }
        break;
      }
      case "finish": {
        const d = parseUserDate(v, 1020);
        if (d == null) throw new Error(L("data_non_valida"));
        if (tk.manual) { tk.finish = d; tk.dur = Math.max(0, cal.between(tk.start, d)); }
        else { const s = tk.start; tk.dur = Math.max(0, cal.between(s, d)); }
        break;
      }
      case "dl": tk.dl = v.trim() ? parseUserDate(v, 1020) : null; break;
      case "preds": {
        let ps;
        try { ps = parsePreds(P, v, unitLabels(), {}); } catch (e) { throw new Error(L("predecessori_non_validi") + " " + e.message); }
        if (ps.some(p => p.u === tk.uid)) throw new Error(L("collegamento_se_stessa"));
        tk.preds = ps;
        break;
      }
      case "pct": {
        const n = Math.max(0, Math.min(100, parseFloat(String(v).replace(",", ".")) || 0));
        setPct(tk, n);
        break;
      }
      case "res": setResources(tk, v); break;
    }
  }
  function setPct(tk, n) {
    tk.pct = n;
    if (n > 0 && tk.as == null) tk.as = tk.start;
    if (n === 0) { tk.as = null; tk.af = null; }
    if (n >= 100) tk.af = tk.finish; else tk.af = null;
  }
  function setResources(tk, v) {
    const P = S.P;
    const parts = String(v).split(/[;]/).map(s => s.trim()).filter(Boolean);
    const keep = [];
    for (const p of parts) {
      const m = p.match(/^(.*?)\s*(?:\[\s*([\d.,]+)\s*(%?)[^\]]*\])?$/);
      const name = m[1].trim();
      if (!name) continue;
      let r = P.resources.find(x => x.name.toLowerCase() === name.toLowerCase());
      if (!r) { r = { uid: nextUid(P.resources), name, type: "work", ini: name[0], group: "", max: 1, rate: 0, ovt: 0, use: 0 }; P.resources.push(r); toast(L("risorsa_creata") + " " + name); }
      let units = 1;
      if (m[2]) { const n = parseFloat(m[2].replace(",", ".")); units = r.type === "material" ? n : m[3] === "%" || n > 5 ? n / 100 : n; }
      let a = P.assignments.find(x => x.task === tk.uid && x.res === r.uid);
      if (!a) { a = { uid: nextUid(P.assignments), task: tk.uid, res: r.uid, units, w: null }; P.assignments.push(a); }
      else if (Math.abs(a.units - units) > 1e-9) { a.units = units; a.w = null; }
      keep.push(a);
    }
    P.assignments = P.assignments.filter(a => a.task !== tk.uid || keep.includes(a));
  }
  function move(dr, dc) {
    root.focus({ preventScroll: true });
    let { row, col } = S.cur;
    const ci = S.cols.indexOf(col);
    row = Math.max(0, Math.min(rows.length + 29, row + dr));
    col = S.cols[Math.max(0, Math.min(S.cols.length - 1, ci + dc))] || col;
    S.cur = { row, col };
    if (dr && rows[row]) { S.sel = new Set([rows[row].uid]); S.anchor = row; }
    ensureVisible(row);
    renderGrid(); draw();
  }
  function ensureVisible(i) {
    const top = chartScroll.scrollTop, h = chartScroll.clientHeight;
    if (i * RH < top) chartScroll.scrollTop = i * RH;
    else if ((i + 1) * RH > top + h - 16) chartScroll.scrollTop = (i + 1) * RH - h + 16;
  }
  // digitazione diretta sulla cella corrente (come in Project/Excel)
  root.addEventListener("keydown", e => {
    if (editing || S.view !== "gantt" && S.view !== "tracking") return;
    if (e.target.closest("input, textarea, select")) return;
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); startEdit(S.cur.row, S.cur.col === "id" || S.cur.col === "ind" || S.cur.col === "mode" ? "name" : S.cur.col, e.key); }
    else if (e.key === "ArrowDown" && !e.altKey) { e.preventDefault(); move(1, 0); }
    else if (e.key === "ArrowUp" && !e.altKey) { e.preventDefault(); move(-1, 0); }
    else if (e.key === "ArrowRight" && !e.altKey && !e.shiftKey) { e.preventDefault(); move(0, 1); }
    else if (e.key === "ArrowLeft" && !e.altKey && !e.shiftKey) { e.preventDefault(); move(0, -1); }
    else if (e.key === "Enter") { e.preventDefault(); startEdit(S.cur.row, S.cur.col); }
    else if (e.key === "Tab") { e.preventDefault(); move(0, e.shiftKey ? -1 : 1); } // come in Project: Tab scorre le colonne
  });
  root.tabIndex = 0;

  // ---------------------------------------------------------------- scala temporale
  let T0 = 0, T1 = 0;
  const ppd = () => ZOOMS[S.zoom];
  const xOf = m => ((m - T0) / DAY) * ppd();
  const tOf = x => T0 + (x / ppd()) * DAY;
  function computeSpan() {
    const P = S.P;
    let a = P.start ?? now(), b = P.finish ?? a;
    for (const tk of P.tasks) { if (tk.start != null) a = Math.min(a, tk.start); if (tk.finish != null) b = Math.max(b, tk.finish); for (const bl of tk.bl || []) if (bl?.start) { a = Math.min(a, bl.start); b = Math.max(b, bl.finish || b); } }
    if (S.other) for (const tk of S.other.tasks) if (tk.start != null) { a = Math.min(a, tk.start); b = Math.max(b, tk.finish); }
    const d0 = dayOf(a) - 7;
    T0 = (d0 - ((weekday(d0) + 6) % 7)) * DAY; // dal lunedi'
    T1 = (dayOf(b) + 60) * DAY;
    spacer.style.width = Math.max(xOf(T1), 400) + "px";
    spacer.style.height = (rows.length + 30) * RH + "px";
  }

  // ---------------------------------------------------------------- disegno del Gantt
  const css = n => getComputedStyle(root).getPropertyValue(n).trim();
  function colors() {
    return { bg: css("--bg") || "#fff", panel: css("--panel-2") || "#f3f3f3", fg: css("--fg") || "#222", muted: css("--muted") || "#777", line: css("--line") || "#ddd", grid: css("--grid") || "#eee",
      bar: "#4a8ad4", barDark: "#2d6cb5", crit: "#d64545", critDark: "#a82e2e", sum: css("--fg") || "#333", accent: css("--accent") || "#ea7426", base: "#9aa3ab", ok: css("--ok") || "#2e8540", sel: css("--accent-soft") || "rgba(234,116,38,.12)", off: "#bbb" };
  }
  function sizeCanvas(c, w, h) {
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.width = w + "px"; c.style.height = h + "px"; }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return g;
  }
  let hover = null, drag = null;
  function draw() {
    if (S.view !== "gantt" && S.view !== "tracking") return;
    drawTimeline();
    const W = chartScroll.clientWidth, H = chartScroll.clientHeight;
    if (!W || !H) return;
    const sx = chartScroll.scrollLeft, sy = chartScroll.scrollTop;
    chartCanvas.style.transform = `translate(${sx}px, ${sy}px)`;
    const g = sizeCanvas(chartCanvas, W, H);
    const C = colors();
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
    const tA = tOf(sx), tB = tOf(sx + W);
    // giorni non lavorativi
    const cal = calendarsOf(S.P).project;
    if (ppd() >= 3) {
      g.fillStyle = C.panel;
      for (let d = dayOf(tA); d <= dayOf(tB); d++) if (!cal.isWorkDay(d)) g.fillRect(xOf(d * DAY) - sx, 0, ppd(), H);
    }
    // righe selezionate
    rows.forEach((tk, i) => {
      const y = i * RH - sy;
      if (y < -RH || y > H) return;
      if (S.sel.has(tk.uid)) { g.fillStyle = C.sel; g.fillRect(0, y, W, RH); }
    });
    g.strokeStyle = C.grid; g.lineWidth = 1;
    // linee della scala inferiore
    for (const [m] of ticks(tA, tB).low) { const x = Math.round(xOf(m) - sx) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    // oggi e data di stato
    if (S.o.today) { const x = xOf(now()) - sx; g.strokeStyle = C.accent; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.setLineDash([]); }
    if (S.P.status != null) { const x = xOf(S.P.status) - sx; g.strokeStyle = C.ok; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    // collegamenti
    const pos = new Map();
    rows.forEach((tk, i) => pos.set(tk.uid, i));
    g.lineWidth = 1;
    rows.forEach((tk, i) => {
      for (const Lk of tk.preds || []) {
        const j = pos.get(Lk.u);
        if (j == null) continue;
        const p = rows[j];
        const crit = S.o.crit && p.crit && tk.crit;
        g.strokeStyle = crit ? C.crit : C.muted; g.fillStyle = g.strokeStyle;
        const fromEnd = Lk.t === 0 || Lk.t === 1, toEnd = Lk.t === 0 || Lk.t === 2;
        const x1 = xOf(fromEnd ? p.finish : p.start) - sx, y1 = j * RH - sy + RH / 2;
        const x2 = xOf(toEnd ? tk.finish : tk.start) - sx, y2 = i * RH - sy + RH / 2;
        if ((y1 < -RH && y2 < -RH) || (y1 > H && y2 > H)) continue;
        g.beginPath();
        const dir = y2 > y1 ? 1 : -1;
        if (Lk.t === 1 && x2 >= x1 + 6) { g.moveTo(x1, y1); g.lineTo(x2, y1); g.lineTo(x2, y2 - dir * 7); arrow(g, x2, y2 - dir * 7, 0, dir); }
        else {
          const ox = fromEnd ? x1 + 6 : x1 - 6, ix = toEnd ? x2 + 8 : x2 - 8;
          const ym = y2 - dir * (RH / 2);
          g.moveTo(x1, y1); g.lineTo(ox, y1); g.lineTo(ox, ym); g.lineTo(ix, ym); g.lineTo(ix, y2); g.lineTo(toEnd ? x2 + 2 : x2 - 2, y2);
          arrow(g, toEnd ? x2 + 2 : x2 - 2, y2, toEnd ? -1 : 1, 0);
        }
        g.stroke();
      }
    });
    // barre
    g.font = `11px ${css("--ui") || "sans-serif"}`;
    g.textBaseline = "middle";
    rows.forEach((tk, i) => {
      const y = i * RH - sy;
      if (y < -RH || y > H || tk.isNull) return;
      drawBar(g, C, tk, y, sx, i);
    });
    if (S.other) drawOther(g, C, sx, sy, H);
    // trascinamento in corso
    if (drag?.ghost) {
      const { x1, x2, y } = drag.ghost;
      g.strokeStyle = C.accent; g.lineWidth = 1.5; g.setLineDash([4, 3]);
      g.strokeRect(x1 - sx, y - sy + 5, Math.max(2, x2 - x1), RH - 10);
      g.setLineDash([]);
      g.fillStyle = C.fg;
      g.fillText(drag.label || "", Math.max(4, x2 - sx + 6), y - sy + RH / 2);
    }
    if (drag?.link) {
      g.strokeStyle = C.accent; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(drag.link.x0 - sx, drag.link.y0 - sy); g.lineTo(drag.link.x - sx, drag.link.y - sy); g.stroke();
    }
    drawHead();
  }
  function arrow(g, x, y, dx, dy) {
    g.moveTo(x, y);
    if (dy) { g.lineTo(x - 3.5, y - dy * 0.1); g.moveTo(x, y + dy * 4); g.lineTo(x - 3.5, y); g.lineTo(x + 3.5, y); g.lineTo(x, y + dy * 4); }
    else { g.lineTo(x - dx * 4, y - 3.5); g.lineTo(x - dx * 4, y + 3.5); g.lineTo(x, y); }
  }
  function drawBar(g, C, tk, y, sx, i) {
    const x1 = xOf(tk.start) - sx, x2 = xOf(tk.finish) - sx;
    const cy = y + RH / 2;
    const tracking = S.view === "tracking";
    const showBase = S.o.base || tracking;
    const b = tk.bl?.[0];
    const off = tk.act === false;
    // linea di base (sotto la barra)
    if (showBase && b?.start != null && b?.finish != null) {
      g.fillStyle = C.base;
      const bx1 = xOf(b.start) - sx, bx2 = xOf(b.finish) - sx;
      if (b.start === b.finish) diamond(g, bx1, cy + 6, 4, C.base);
      else g.fillRect(bx1, cy + 3, Math.max(2, bx2 - bx1), 4);
    }
    const crit = S.o.crit && tk.crit;
    if (tk.sum) {
      g.fillStyle = off ? C.off : crit && tracking ? C.crit : C.sum;
      const yy = showBase ? cy - 6 : cy - 4;
      g.fillRect(x1, yy, Math.max(2, x2 - x1), 5);
      g.beginPath(); g.moveTo(x1, yy); g.lineTo(x1 + 5, yy); g.lineTo(x1, yy + 10); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(x2, yy); g.lineTo(x2 - 5, yy); g.lineTo(x2, yy + 10); g.closePath(); g.fill();
      if (tk.pct > 0) { g.fillStyle = C.ok; g.fillRect(x1, yy + 1.5, Math.max(1, (x2 - x1) * tk.pct / 100), 2); }
    } else if (isMilestone(tk)) {
      diamond(g, x1, showBase ? cy - 2 : cy, 6.5, off ? C.off : crit ? C.crit : C.fg);
    } else {
      const h = showBase ? 9 : 12, yy = (showBase ? cy - 7 : cy - 6);
      const base = off ? C.off : crit ? C.crit : (tk.color || C.bar);
      g.fillStyle = base;
      if (tk.manual) { // attivita' manuale: come Project, barra con bordo chiaro
        g.globalAlpha = 0.75; g.fillRect(x1, yy, Math.max(2, x2 - x1), h); g.globalAlpha = 1;
        g.strokeStyle = crit ? C.critDark : C.barDark; g.strokeRect(x1 + 0.5, yy + 0.5, Math.max(1, x2 - x1 - 1), h - 1);
      } else g.fillRect(x1, yy, Math.max(2, x2 - x1), h);
      if (tk.pct > 0) { g.fillStyle = crit ? C.critDark : "#1d3f6e"; g.fillRect(x1, yy + h / 2 - 1.5, Math.max(1, (x2 - x1) * Math.min(100, tk.pct) / 100), 3); }
      if (tk.est) { g.fillStyle = C.bg; g.font = "bold 9px sans-serif"; g.fillText("?", x2 - 7, yy + h / 2); g.font = `11px ${css("--ui") || "sans-serif"}`; }
      // maniglie al passaggio
      if (hover && hover.uid === tk.uid) {
        g.fillStyle = C.accent;
        if (hover.zone === "end") g.fillRect(x2 - 3, yy - 2, 4, h + 4);
        if (hover.zone === "pct") g.fillRect(x1 - 1, yy - 2, 4, h + 4);
        if (hover.zone === "body") { g.strokeStyle = C.accent; g.lineWidth = 1.5; g.strokeRect(x1 - 1, yy - 1, Math.max(2, x2 - x1) + 2, h + 2); g.lineWidth = 1; }
      }
    }
    // margine totale
    if (S.o.slack && !tk.sum && tk.ts > 0 && tk.lf != null) {
      const xs = xOf(tk.lf) - sx;
      g.strokeStyle = C.muted; g.beginPath(); g.moveTo(x2, cy + 5); g.lineTo(xs, cy + 5); g.moveTo(xs, cy + 2); g.lineTo(xs, cy + 8); g.stroke();
    }
    // scadenza
    if (tk.dl != null) { const xd = xOf(tk.dl) - sx; g.fillStyle = tk.late ? C.crit : C.ok; g.beginPath(); g.moveTo(xd - 4, y + 2); g.lineTo(xd + 4, y + 2); g.lineTo(xd, y + 8); g.closePath(); g.fill(); }
    if (S.o.names) {
      const label = isMilestone(tk) ? fdm(tk.start) : (tk.resNames || []).join(", ");
      if (label) { g.fillStyle = C.fg; g.fillText(label, x2 + (isMilestone(tk) ? 10 : 5), cy); }
    }
  }
  function diamond(g, x, y, r, col) { g.fillStyle = col; g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath(); g.fill(); }
  // versione confrontata: barre sottili sotto, abbinate per UID o nome
  function drawOther(g, C, sx, sy, H) {
    const map = S.otherMap || new Map();
    rows.forEach((tk, i) => {
      const o = map.get(tk.uid);
      if (!o || o.start == null) return;
      const y = i * RH - sy + RH - 6;
      if (y < 0 || y > H) return;
      g.fillStyle = "#b07ad6";
      const a = xOf(o.start) - sx, b = xOf(o.finish) - sx;
      if (o.start === o.finish) diamond(g, a, y + 1, 3.5, "#b07ad6"); else g.fillRect(a, y, Math.max(2, b - a), 3);
    });
  }
  function ticks(a, b) {
    const p = ppd();
    const high = [], low = [];
    const [ya, ma] = ymd(a);
    if (p >= 12) { // settimane / giorni
      for (let d = dayOf(a) - 7; d <= dayOf(b) + 1; d++) { low.push([d * DAY, p >= 22 ? fwd(d * DAY) + " " + new Date(d * DAY * 60000).getUTCDate() : fwd(d * DAY)]); if (weekday(d) === 1) high.push([d * DAY, fdm(d * DAY) + " " + new Date(d * DAY * 60000).getUTCFullYear()]); }
    } else if (p >= 3) { // mesi / settimane
      for (let d = dayOf(a) - 7; d <= dayOf(b) + 7; d++) if (weekday(d) === 1) low.push([d * DAY, String(new Date(d * DAY * 60000).getUTCDate())]);
      for (let y = ya, m = ma - 1; fromParts(y, m < 1 ? 1 : m, 1) <= b; m++) { if (m > 12) { m = 1; y++; } if (m < 1) continue; high.push([fromParts(y, m, 1), fmon(fromParts(y, m, 1))]); }
    } else { // anni / mesi
      for (let y = ya, m = ma - 1; fromParts(y, Math.max(1, m), 1) <= b; m++) { if (m > 12) { m = 1; y++; } if (m < 1) continue; const t0 = fromParts(y, m, 1); low.push([t0, fmons(t0).slice(0, p < 2 ? 1 : 3)]); if (m === 1 || !high.length) high.push([t0, String(y)]); }
    }
    return { high, low };
  }
  function drawHead() {
    const W = chartScroll.clientWidth;
    const g = sizeCanvas(chartHead, W, HEAD);
    const C = colors();
    const sx = chartScroll.scrollLeft;
    g.fillStyle = C.panel; g.fillRect(0, 0, W, HEAD);
    g.strokeStyle = C.line; g.fillStyle = C.fg; g.font = `11px ${css("--ui") || "sans-serif"}`; g.textBaseline = "middle";
    const { high, low } = ticks(tOf(sx), tOf(sx + W));
    g.beginPath(); g.moveTo(0, HEAD / 2 + 0.5); g.lineTo(W, HEAD / 2 + 0.5); g.moveTo(0, HEAD - 0.5); g.lineTo(W, HEAD - 0.5); g.stroke();
    for (const [m, s] of high) { const x = Math.round(xOf(m) - sx) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, HEAD / 2); g.stroke(); g.fillText(s, Math.max(x + 4, 4), HEAD / 4); }
    g.fillStyle = C.muted;
    const lw = low.length > 1 ? xOf(low[1][0]) - xOf(low[0][0]) : 30;
    const fitsLow = low.length && lw > Math.max(...low.slice(0, 8).map(([, s]) => g.measureText(s).width)) + 6;
    for (const [m, s] of low) { const x = Math.round(xOf(m) - sx) + 0.5; g.beginPath(); g.moveTo(x, HEAD / 2); g.lineTo(x, HEAD); g.stroke(); if (fitsLow) g.fillText(s, x + 3, HEAD * 3 / 4); }
  }
  // sequenza temporale (riepilogo del progetto sopra il Gantt)
  function drawTimeline() {
    tlCanvas.hidden = !S.o.timeline;
    if (!S.o.timeline) return;
    const W = root.clientWidth || 800, H = 64;
    const g = sizeCanvas(tlCanvas, W, H);
    const C = colors();
    const P = S.P;
    g.fillStyle = C.panel; g.fillRect(0, 0, W, H);
    const a = P.start, b = Math.max(P.finish, a + DAY);
    const pad = 70;
    const X = m => pad + (m - a) / (b - a) * (W - 2 * pad);
    g.fillStyle = C.line; g.fillRect(pad, 30, W - 2 * pad, 12);
    g.font = `11px ${css("--ui") || "sans-serif"}`; g.textBaseline = "middle"; g.fillStyle = C.fg;
    g.textAlign = "right"; g.fillText(fdd(a), pad - 6, 36); g.textAlign = "left"; g.fillText(fdd(b), W - pad + 6, 36);
    let items = P.tasks.filter(x => x.tl);
    if (!items.length) items = P.tasks.filter(x => (x.sum && x.lvl === 1) || (isMilestone(x) && x.lvl <= 2));
    const pal = ["#4a8ad4", "#e08a3c", "#5aa469", "#9b6bc4", "#c45a7a", "#3aa7a3", "#b9a23a"];
    let k = 0;
    for (const x of items.filter(x => !isMilestone(x))) {
      const x1 = X(x.start), x2 = X(x.finish);
      g.fillStyle = pal[k++ % pal.length]; g.fillRect(x1, 30, Math.max(2, x2 - x1), 12);
      g.fillStyle = C.fg; g.save(); g.beginPath(); g.rect(x1, 0, Math.max(30, x2 - x1), 28); g.clip(); g.fillText(x.name, x1 + 2, 22); g.restore();
    }
    for (const x of items.filter(isMilestone)) { const xm = X(x.start); diamond(g, xm, 50, 5, C.fg); g.fillStyle = C.muted; g.fillText(x.name.slice(0, 24) + " " + fdm(x.start), xm + 8, 56); }
    const n = now();
    if (n >= a && n <= b) { g.strokeStyle = C.accent; g.beginPath(); g.moveTo(X(n), 24); g.lineTo(X(n), 46); g.stroke(); }
  }

  // ---------------------------------------------------------------- interazione col Gantt
  function hit(e) {
    const r = chartCanvas.getBoundingClientRect();
    const x = e.clientX - r.left + chartScroll.scrollLeft, y = e.clientY - r.top + chartScroll.scrollTop;
    const i = Math.floor(y / RH);
    const tk = rows[i];
    if (!tk || tk.isNull) return { x, y, i, tk: null };
    const x1 = xOf(tk.start), x2 = xOf(tk.finish);
    let zone = null;
    if (isMilestone(tk)) { if (Math.abs(x - x1) < 8) zone = "body"; }
    else if (x >= x1 - 4 && x <= x2 + 5) zone = tk.sum ? "sum" : x >= x2 - 5 ? "end" : x <= x1 + 4 && x2 - x1 > 14 ? "pct" : "body";
    return { x, y, i, tk, zone };
  }
  chartScroll.addEventListener("scroll", () => { renderGrid(); gridBody.scrollTop = chartScroll.scrollTop; draw(); });
  chartScroll.addEventListener("pointermove", e => {
    if (drag) return dragMove(e);
    const h = hit(e);
    const nh = h.zone && h.zone !== "sum" ? { uid: h.tk.uid, zone: h.zone } : null;
    if (JSON.stringify(nh) !== JSON.stringify(hover)) { hover = nh; draw(); }
    chartScroll.title = h.tk ? `${h.tk.name}\n${fdt(h.tk.start)} → ${fdt(h.tk.finish)}\n${durText(S.P, h.tk)} · ${Math.round(h.tk.pct || 0)}%` + (h.tk.ts != null ? `\n${L("c_margine")}: ${durText(S.P, { dur: Math.max(0, h.tk.ts), du: "d" })}` : "") : "";
  });
  chartScroll.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    e.preventDefault();
    root.focus({ preventScroll: true });
    const h = hit(e);
    if (!h.tk) { S.sel.clear(); renderGrid(); draw(); return; }
    selectRow(h.i, e.shiftKey, e.ctrlKey || e.metaKey);
    S.cur.row = h.i;
    renderGrid(); draw();
    if (!h.zone || h.zone === "sum" || h.tk.act === false) return;
    chartScroll.setPointerCapture(e.pointerId);
    drag = { tk: h.tk, zone: h.zone, x0: h.x, y0: h.y, i: h.i, moved: false };
  });
  chartScroll.addEventListener("dblclick", e => { const h = hit(e); if (h.tk) taskInfo(h.tk); });
  function snapT(m) { // passo: ora con zoom alto, giorno negli altri casi
    const step = ppd() >= 60 ? 60 : DAY;
    return Math.round(m / step) * step;
  }
  function dragMove(e) {
    const h = hit(e);
    const d = drag, tk = d.tk;
    const dx = h.x - d.x0, dy = h.y - d.y0;
    if (!d.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    d.moved = true;
    const cal = calendarsOf(S.P).get(tk.cal ?? S.P.cal);
    if (d.zone === "body" && (d.link || Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx))) {
      d.link = { x0: xOf(tk.finish), y0: d.i * RH + RH / 2, x: h.x, y: h.y };
      d.ghost = null;
      d.target = h.tk && h.tk !== tk ? h.tk : null;
    } else if (d.zone === "body") {
      const ns = cal.nextWork(snapT(tk.start + (dx / ppd()) * DAY) + (ppd() >= 60 ? 0 : 480));
      const nf = isMilestone(tk) ? ns : cal.add(ns, tk.dur);
      d.ghost = { x1: xOf(ns), x2: xOf(nf), y: d.i * RH };
      d.val = ns; d.label = fd(ns);
    } else if (d.zone === "end") {
      const nf = Math.max(tk.start, snapT(tk.finish + (dx / ppd()) * DAY) + (ppd() >= 60 ? 0 : 1020 - 1440 * (snapT(tk.finish + (dx / ppd()) * DAY) % DAY === 0 ? 1 : 0)));
      const dur = Math.max(0, cal.between(tk.start, nf));
      d.ghost = { x1: xOf(tk.start), x2: xOf(cal.add(tk.start, dur)), y: d.i * RH };
      d.val = dur; d.label = durText(S.P, { dur, du: tk.du || "d" });
    } else if (d.zone === "pct") {
      const x1 = xOf(tk.start), x2 = xOf(tk.finish);
      const p = Math.max(0, Math.min(100, Math.round(((h.x - x1) / Math.max(1, x2 - x1)) * 100)));
      d.ghost = { x1, x2: x1 + (x2 - x1) * p / 100, y: d.i * RH };
      d.val = p; d.label = p + "%";
    }
    draw();
  }
  chartScroll.addEventListener("pointerup", () => {
    const d = drag;
    drag = null;
    if (!d || !d.moved) { draw(); return; }
    const tk = d.tk;
    if (d.link) {
      if (d.target && !d.target.preds.some(p => p.u === tk.uid)) change(() => { d.target.preds.push({ u: tk.uid, t: 1, lag: 0, lu: "d" }); }, L("collegate"));
      else draw();
      return;
    }
    if (d.val == null) { draw(); return; }
    change(() => {
      if (d.zone === "body") {
        if (tk.manual) { const dur = tk.dur; const cal = calendarsOf(S.P).get(tk.cal ?? S.P.cal); tk.start = d.val; tk.finish = cal.add(d.val, dur); }
        else { tk.ct = 4; tk.cd = d.val; } // come Project: spostare la barra crea il vincolo "Inizio non prima del"
      } else if (d.zone === "end") { tk.dur = d.val; if (tk.manual) tk.finish = calendarsOf(S.P).get(tk.cal ?? S.P.cal).add(tk.start, d.val); for (const a of S.P.assignments) if (a.task === tk.uid) a.w = null; }
      else if (d.zone === "pct") setPct(tk, d.val);
    });
  });
  chartScroll.addEventListener("wheel", e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const r = chartScroll.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1 : -1, e.clientX - r.left);
  }, { passive: false });
  function zoomAt(dir, px = chartScroll.clientWidth / 2) {
    const z = Math.max(0, Math.min(ZOOMS.length - 1, S.zoom + dir));
    if (z === S.zoom) return;
    const m = tOf(chartScroll.scrollLeft + px);
    S.zoom = z;
    computeSpan();
    chartScroll.scrollLeft = xOf(m) - px;
    draw();
  }
  function zoomFit() {
    const P = S.P;
    const days = Math.max(7, (P.finish - P.start) / DAY + 14);
    const W = chartScroll.clientWidth || 800;
    let z = 0;
    for (let k = 0; k < ZOOMS.length; k++) if (ZOOMS[k] * days <= W) z = k;
    S.zoom = z; computeSpan(); chartScroll.scrollLeft = Math.max(0, xOf(P.start) - 40); draw();
  }
  function scrollToTask(tk = curTask() || selTasks()[0]) {
    if (!tk) return;
    chartScroll.scrollLeft = Math.max(0, xOf(tk.start) - 60);
  }

  // ---------------------------------------------------------------- comandi delle attivita'
  const posOfCur = () => { const tk = curTask(); return tk ? S.P.tasks.indexOf(tk) : S.P.tasks.length; };
  function insertTask(kind = "task") {
    change(() => {
      const P = S.P;
      const at = posOfCur();
      const ref = P.tasks[at] || P.tasks[at - 1];
      const tk = newTask(P, { name: kind === "ms" ? L("nuovo_cardine") : kind === "sum" ? L("nuova_riepilogo") : L("nuova_attivita"), lvl: ref ? ref.lvl : 1, est: kind === "task", dur: kind === "ms" ? 0 : P.mpd, ms: kind === "ms" });
      if (kind === "sum") {
        // come Project: riepilogo sopra le attivita' selezionate, che rientrano
        const sel = selTasks();
        const first = sel.length ? P.tasks.indexOf(sel[0]) : at;
        tk.lvl = sel.length ? Math.min(...sel.map(x => x.lvl)) : (ref?.lvl || 1);
        P.tasks.splice(first, 0, tk);
        for (const x of sel) for (const y of [x, ...descendants(x)]) if (!sel.includes(y) || y === x) y.lvl++;
      } else P.tasks.splice(at, 0, tk);
      S.sel = new Set([tk.uid]);
    });
    const i = rows.findIndex(x => S.sel.has(x.uid));
    if (i >= 0) { S.cur = { row: i, col: "name" }; renderGrid(); setTimeout(() => startEdit(i, "name"), 0); }
  }
  function descendants(tk) { const P = S.P, i = P.tasks.indexOf(tk), out = []; for (let k = i + 1; k < P.tasks.length && P.tasks[k].lvl > tk.lvl; k++) out.push(P.tasks[k]); return out; }
  function deleteTasks() {
    const sel = selTasks();
    if (!sel.length) return;
    change(() => {
      const P = S.P;
      const gone = new Set();
      for (const x of sel) { gone.add(x.uid); for (const d of descendants(x)) gone.add(d.uid); }
      P.tasks = P.tasks.filter(x => !gone.has(x.uid));
      for (const x of P.tasks) x.preds = (x.preds || []).filter(p => !gone.has(p.u));
      P.assignments = P.assignments.filter(a => !gone.has(a.task));
      S.sel.clear();
    }, tn("proj.n_eliminate", sel.length));
  }
  function indent(dir) {
    const sel = selTasks();
    if (!sel.length) return;
    change(() => {
      const P = S.P;
      const done = new Set();
      for (const x of sel) {
        if (done.has(x.uid)) continue;
        const i = P.tasks.indexOf(x);
        const group = [x, ...descendants(x)];
        if (dir > 0) { const prev = P.tasks[i - 1]; if (!prev || prev.lvl < x.lvl) continue; }
        else if (x.lvl <= 1) continue;
        for (const y of group) { y.lvl += dir; done.add(y.uid); }
      }
    });
  }
  function linkSel() {
    const sel = selTasks().filter(x => !x.isNull);
    if (sel.length < 2) return toast(L("seleziona_due"));
    change(() => { for (let k = 1; k < sel.length; k++) if (!sel[k].preds.some(p => p.u === sel[k - 1].uid)) sel[k].preds.push({ u: sel[k - 1].uid, t: 1, lag: 0, lu: "d" }); }, L("collegate"));
  }
  function unlinkSel() {
    const sel = selTasks();
    if (!sel.length) return;
    const ids = new Set(sel.map(x => x.uid));
    change(() => {
      if (sel.length === 1) { const u = sel[0].uid; sel[0].preds = []; for (const x of S.P.tasks) x.preds = (x.preds || []).filter(p => p.u !== u); }
      else for (const x of sel) x.preds = x.preds.filter(p => !ids.has(p.u));
    });
  }
  function pctSel(n) { const sel = selTasks().filter(x => !x.sum); if (sel.length) change(() => sel.forEach(x => setPct(x, n))); }
  function modeSel(manual) {
    const sel = selTasks().filter(x => !x.sum);
    if (!sel.length) return;
    change(() => sel.forEach(x => { x.manual = manual; delete x.fromFile; if (manual) { x.start ??= x.es; x.finish ??= x.ef; } }));
  }
  function toggleTimeline() { const sel = selTasks(); if (sel.length) change(() => sel.forEach(x => (x.tl = !x.tl))); }
  function copySel(cut = false) {
    const sel = selTasks();
    if (!sel.length) return;
    const all = []; const seen = new Set();
    for (const x of sel) for (const y of [x, ...descendants(x)]) if (!seen.has(y.uid)) { seen.add(y.uid); all.push(y); }
    S.clip = JSON.parse(snapshot({ tasks: all, assignments: S.P.assignments.filter(a => seen.has(a.task)) }));
    try { navigator.clipboard?.writeText(all.map(x => [x.id, x.name, durText(S.P, x), fd(x.start), fd(x.finish)].join("\t")).join("\n")); } catch { /* */ }
    if (cut) deleteTasks();
  }
  function paste() {
    if (!S.clip) return;
    change(() => {
      const P = S.P;
      const at = posOfCur();
      const map = new Map();
      let u = nextUid(P.tasks);
      const minL = Math.min(...S.clip.tasks.map(x => x.lvl));
      const base = P.tasks[at]?.lvl || 1;
      const add = S.clip.tasks.map(x => { const y = JSON.parse(JSON.stringify(x)); map.set(x.uid, u); y.uid = u++; y.lvl = x.lvl - minL + base; delete y._h; delete y.x; return y; });
      for (const y of add) y.preds = (y.preds || []).filter(p => map.has(p.u)).map(p => ({ ...p, u: map.get(p.u) }));
      P.tasks.splice(at, 0, ...add);
      let au = nextUid(P.assignments);
      for (const a of S.clip.assignments) P.assignments.push({ ...a, uid: au++, task: map.get(a.task), x: undefined });
      S.sel = new Set(add.map(x => x.uid));
    });
  }
  function collapseAll(open) { S.collapsed = open ? new Set() : new Set(S.P.tasks.filter(x => x.sum).map(x => x.uid)); refresh(); }
  function outlineLevel(n) { S.collapsed = new Set(S.P.tasks.filter(x => x.sum && x.lvl >= n).map(x => x.uid)); refresh(); }

  // ---------------------------------------------------------------- finestre
  function field(label, input, wide = false) { return el("label", { class: "pj-f" + (wide ? " wide" : "") }, el("span", {}, label), input); }
  async function taskInfo(tk) {
    if (!tk) return;
    const P = S.P;
    const inp = (v, attrs = {}) => el("input", { value: v ?? "", ...attrs });
    const fName = inp(tk.name), fDur = inp(durText(P, tk)), fPct = inp(Math.round(tk.pct || 0), { type: "number", min: 0, max: 100 }), fPri = inp(tk.pri ?? 500, { type: "number", min: 0, max: 1000 });
    const fStart = inp(fdt(tk.start)), fFin = inp(fdt(tk.finish));
    const fMan = el("input", { type: "checkbox" }); fMan.checked = !!tk.manual;
    const fEst = el("input", { type: "checkbox" }); fEst.checked = !!tk.est;
    const fMs = el("input", { type: "checkbox" }); fMs.checked = !!tk.ms;
    const fAct = el("input", { type: "checkbox" }); fAct.checked = tk.act !== false;
    const fTl = el("input", { type: "checkbox" }); fTl.checked = !!tk.tl;
    const fCt = el("select", {}, ...CT.map((c, i) => el("option", { value: i, selected: (tk.ct || 0) === i }, L("ct_" + c.toLowerCase()))));
    const fCd = inp(fdt(tk.cd)), fDl = inp(fdt(tk.dl)), fWbs = inp(tk.wbs || "", { placeholder: tk.on });
    const fCal = el("select", {}, el("option", { value: "" }, L("calendario_progetto")), ...P.calendars.map(c => el("option", { value: c.uid, selected: tk.cal === c.uid }, c.name)));
    const fColor = el("input", { type: "color", value: tk.color || "#4a8ad4" });
    const fNotes = el("textarea", { rows: 6 }, tk.notes || "");
    // predecessori
    const predRows = el("div", { class: "pj-plist" });
    const preds = (tk.preds || []).map(p => ({ ...p }));
    const lab = unitLabels();
    function renderPreds() {
      predRows.innerHTML = "";
      preds.forEach((p, k) => {
        const other = P.tasks.find(x => x.uid === p.u);
        const sel = el("select", {}, ...P.tasks.filter(x => x !== tk && !x.isNull).map(x => el("option", { value: x.uid, selected: x.uid === p.u }, `${x.id} ${x.name}`)));
        sel.onchange = () => (p.u = +sel.value);
        const typ = el("select", {}, ...[1, 3, 0, 2].map(i => el("option", { value: i, selected: (p.t ?? 1) === i }, `${lab.link[i]} · ${L("tipo_" + i)}`)));
        typ.onchange = () => (p.t = +typ.value);
        const lag = el("input", { value: p.pc != null ? p.pc + "%" : durText(P, { dur: p.lag || 0, du: p.lu || "d" }), style: { width: "80px" } });
        lag.onchange = () => { const s = lag.value.trim(); if (/%$/.test(s)) { p.pc = parseFloat(s); p.lag = 0; } else { const d = durParse(P, s.replace(/^\+/, "").replace(/^-/, "")); if (d) { delete p.pc; p.lag = (s.startsWith("-") ? -1 : 1) * d.dur; p.lu = d.du; } } };
        predRows.append(el("div", { class: "pj-prow" }, sel, typ, lag, el("button", { class: "btn", onclick: () => { preds.splice(k, 1); renderPreds(); } }, "✕")));
        void other;
      });
    }
    renderPreds();
    const addPred = el("button", { class: "btn", onclick: () => { const first = P.tasks.find(x => x !== tk && !x.isNull); if (first) { preds.push({ u: first.uid, t: 1, lag: 0, lu: "d" }); renderPreds(); } } }, L("aggiungi_predecessore"));
    // risorse
    const assn = P.assignments.filter(a => a.task === tk.uid).map(a => ({ ...a }));
    const resRows = el("div", { class: "pj-plist" });
    function renderRes() {
      resRows.innerHTML = "";
      assn.forEach((a, k) => {
        const sel = el("select", {}, ...P.resources.map(r => el("option", { value: r.uid, selected: r.uid === a.res }, r.name)));
        sel.onchange = () => (a.res = +sel.value);
        const u = el("input", { type: "number", value: Math.round((a.units ?? 1) * 100), min: 0, step: 10, style: { width: "80px" } });
        u.onchange = () => { a.units = (+u.value || 0) / 100; a.w = null; };
        resRows.append(el("div", { class: "pj-prow" }, sel, u, el("span", {}, "%"), el("button", { class: "btn", onclick: () => { assn.splice(k, 1); renderRes(); } }, "✕")));
      });
    }
    renderRes();
    const addRes = el("button", { class: "btn", disabled: !P.resources.length, onclick: () => { const used = new Set(assn.map(a => a.res)); const r = P.resources.find(x => !used.has(x.uid)) || P.resources[0]; if (r) { assn.push({ uid: null, task: tk.uid, res: r.uid, units: 1, w: null }); renderRes(); } } }, L("aggiungi_risorsa"));
    const tabs = [
      [L("tab_generale"), el("div", { class: "pj-form" }, field(L("c_nome"), fName, true), field(L("c_durata"), fDur), field(L("c_pct"), fPct), field(L("priorita"), fPri),
        field(L("c_inizio"), fStart), field(L("c_fine"), fFin), el("div", { class: "pj-checks wide" }, el("label", {}, fMan, L("manuale")), el("label", {}, fEst, L("stimata")), el("label", {}, fMs, L("cardine")), el("label", {}, fAct, L("attiva")), el("label", {}, fTl, L("in_sequenza")), el("label", {}, L("colore"), fColor)),
        tk.bl?.[0] ? el("div", { class: "pj-note wide" }, `${L("linea_base")}: ${fd(tk.bl[0].start)} → ${fd(tk.bl[0].finish)}`) : null,
        tk.fromFile ? el("div", { class: "pj-note wide" }, L("ind_da_file")) : null)],
      [L("tab_predecessori"), el("div", {}, predRows, addPred)],
      [L("tab_risorse"), el("div", {}, P.resources.length ? null : el("p", { class: "pj-note" }, L("nessuna_risorsa_definita")), resRows, addRes)],
      [L("tab_avanzate"), el("div", { class: "pj-form" }, field(L("c_vincolo"), fCt), field(L("data_vincolo"), fCd), field(L("c_scadenza"), fDl), field(L("c_wbs"), fWbs), field(L("calendario"), fCal))],
      [L("tab_note"), fNotes],
    ];
    const ok = await modal(`${L("info_attivita")} · ${tk.id} ${tk.name}`, tabbed(tabs), [{ label: t("common.annulla"), value: false }, { label: t("common.ok"), value: true, primary: true }]);
    if (!ok) return;
    change(() => {
      tk.name = fName.value;
      const d = durParse(P, fDur.value);
      if (d && !tk.sum && (d.dur !== tk.dur || d.du !== tk.du || d.est !== tk.est)) { tk.dur = d.dur; tk.du = d.du; for (const a of P.assignments) if (a.task === tk.uid) a.w = null; }
      tk.est = fEst.checked; tk.ms = fMs.checked; tk.act = fAct.checked; tk.tl = fTl.checked;
      tk.pri = Math.max(0, Math.min(1000, +fPri.value || 500));
      tk.color = fColor.value !== "#4a8ad4" ? fColor.value : tk.color;
      if (fMan.checked !== !!tk.manual) { tk.manual = fMan.checked; delete tk.fromFile; }
      if (!tk.sum) {
        const s = parseUserDate(fStart.value, 480), f = parseUserDate(fFin.value, 1020);
        if (tk.manual) { if (s != null) tk.start = s; if (f != null) tk.finish = Math.max(tk.start, f); }
        else if (s != null && s !== tk.start) { tk.ct = 4; tk.cd = s; }
      }
      tk.ct = +fCt.value; tk.cd = tk.ct > 1 ? parseUserDate(fCd.value, 480) ?? tk.cd ?? tk.start : null;
      tk.dl = fDl.value.trim() ? parseUserDate(fDl.value, 1020) : null;
      tk.wbs = fWbs.value.trim();
      tk.cal = fCal.value ? +fCal.value : null;
      tk.notes = fNotes.value;
      setPct(tk, Math.max(0, Math.min(100, +fPct.value || 0)));
      tk.preds = preds.filter(p => p.u !== tk.uid);
      let au = nextUid(P.assignments);
      const old = new Map(P.assignments.filter(a => a.task === tk.uid).map(a => [a.uid, a]));
      P.assignments = P.assignments.filter(a => a.task !== tk.uid);
      const seen = new Set();
      for (const a of assn) { if (seen.has(a.res)) continue; seen.add(a.res); const o = old.get(a.uid); P.assignments.push({ ...(o || {}), ...a, uid: a.uid ?? au++ }); }
    });
  }
  function tabbed(tabs) {
    const head = el("div", { class: "pj-tabs" });
    const body = el("div", { class: "pj-tabbody" });
    tabs.forEach(([name, node], k) => {
      const b = el("button", { class: "pj-tab" + (k ? "" : " on"), type: "button", onclick: () => { head.querySelectorAll(".pj-tab").forEach(x => x.classList.remove("on")); b.classList.add("on"); body.innerHTML = ""; body.append(node); } }, name);
      head.append(b);
    });
    body.append(tabs[0][1]);
    return el("div", { class: "pj-dlg" }, head, body);
  }
  async function projectInfo() {
    const P = S.P;
    const f = (v, a = {}) => el("input", { value: v ?? "", ...a });
    const fName = f(P.name), fTitle = f(P.title), fAuthor = f(P.author), fComp = f(P.company), fMgr = f(P.manager);
    const fStart = f(fdt(P.start)), fStatus = f(fdt(P.status)), fCur = f(P.currency || "€", { style: { width: "70px" } });
    const fMpd = f(P.mpd / 60, { type: "number", step: 0.5 }), fMpw = f(P.mpw / 60, { type: "number", step: 0.5 }), fDpm = f(P.dpm, { type: "number" });
    const fCal = el("select", {}, ...P.calendars.filter(c => c.base == null).map(c => el("option", { value: c.uid, selected: c.uid === P.cal }, c.name)));
    const info = el("div", { class: "pj-note wide" }, `${L("fine_progetto")}: ${fdt(P.finish)} · ${L("c_durata")}: ${durText(P, { dur: calendarsOf(P).project.between(P.start, P.finish), du: "d" })} · ${L("c_costo")}: ${money(P.tasks.filter(x => !x.parent).reduce((n, x) => n + (x.cost || 0), 0), P.currency)}`);
    const ok = await modal(L("info_progetto"), el("div", { class: "pj-form" }, field(L("c_nome"), fName, true), field(L("titolo"), fTitle), field(L("autore"), fAuthor), field(L("societa"), fComp), field(L("responsabile"), fMgr),
      field(L("data_inizio"), fStart), field(L("data_stato"), fStatus), field(L("calendario"), fCal), field(L("valuta"), fCur), field(L("ore_giorno"), fMpd), field(L("ore_settimana"), fMpw), field(L("giorni_mese"), fDpm), info),
    [{ label: t("common.annulla"), value: false }, { label: t("common.ok"), value: true, primary: true }]);
    if (!ok) return;
    change(() => {
      Object.assign(P, { name: fName.value, title: fTitle.value, author: fAuthor.value, company: fComp.value, manager: fMgr.value, currency: fCur.value || "€" });
      const s = parseUserDate(fStart.value, 480); if (s != null) P.start = s;
      P.status = fStatus.value.trim() ? parseUserDate(fStatus.value, 1020) : null;
      P.cal = +fCal.value;
      const mpd = Math.round(+fMpd.value * 60) || P.mpd;
      if (mpd !== P.mpd) for (const x of P.tasks) if (!isElapsed(x.du) && x.du !== "h" && x.du !== "m") x.dur = Math.round(x.dur / P.mpd * mpd);
      P.mpd = mpd; P.mpw = Math.round(+fMpw.value * 60) || P.mpw; P.dpm = +fDpm.value || P.dpm;
    });
  }
  async function calendarDlg() {
    const P = S.P;
    let cal = P.calendars.find(c => c.uid === P.cal) || P.calendars[0];
    const work = JSON.parse(JSON.stringify(P.calendars));
    const box = el("div", { class: "pj-calbox" });
    const days = [1, 2, 3, 4, 5, 6, 0];
    const dayName = d => new Intl.DateTimeFormat(LOCALE, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 10, 1 + d)));
    const shTxt = s => s == null ? "" : s.map(([a, b]) => `${hm(a)}-${hm(b)}`).join(", ");
    const hm = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const parseSh = s => { if (!s.trim()) return []; return s.split(/[,;]/).map(x => x.trim().match(/^(\d{1,2})[:.]?(\d{2})?\s*-\s*(\d{1,2})[:.]?(\d{2})?$/)).filter(Boolean).map(m => [+m[1] * 60 + +(m[2] || 0), +m[3] * 60 + +(m[4] || 0) || 1440]); };
    let cur = work.find(c => c.uid === cal.uid);
    function render() {
      box.innerHTML = "";
      const sel = el("select", {}, ...work.map(c => el("option", { value: c.uid, selected: c === cur }, c.name + (c.base != null ? " (" + L("calendario_risorsa") + ")" : ""))));
      sel.onchange = () => { cur = work.find(c => c.uid === +sel.value); render(); };
      const nw = el("button", { class: "btn", onclick: () => { const c = newCalendar(nextUid(work), L("nuovo_calendario") + " " + (work.length + 1)); c.week = JSON.parse(JSON.stringify(cur.week.map((s, i) => s ?? STD_WEEK()[i]))); c.exc = JSON.parse(JSON.stringify(cur.exc)); work.push(c); cur = c; render(); } }, L("nuovo_calendario"));
      const nm = el("input", { value: cur.name }); nm.onchange = () => (cur.name = nm.value);
      box.append(el("div", { class: "pj-prow" }, sel, nw), field(t("common.nome"), nm, true));
      const wk = el("div", { class: "pj-week" }, el("b", {}, L("settimana_lavorativa")), el("p", { class: "pj-note" }, L("orari_esempio")));
      for (const d of days) {
        const i = el("input", { value: shTxt(cur.week[d]), placeholder: cur.week[d] == null ? L("come_base") : L("non_lavorativo") });
        i.onchange = () => (cur.week[d] = parseSh(i.value));
        wk.append(field(dayName(d), i));
      }
      box.append(wk);
      const ex = el("div", { class: "pj-exc" }, el("b", {}, L("eccezioni")));
      const list = el("div", { class: "pj-exlist" });
      cur.exc.sort((a, b) => a.from - b.from).forEach((e, k) => {
        const n = el("input", { value: e.name || "", placeholder: t("common.nome") }); n.onchange = () => (e.name = n.value);
        const a = el("input", { value: fdd(e.from * DAY), style: { width: "110px" } }); a.onchange = () => { const v = parseUserDate(a.value, 0); if (v != null) e.from = dayOf(v); };
        const b = el("input", { value: fdd(e.to * DAY), style: { width: "110px" } }); b.onchange = () => { const v = parseUserDate(b.value, 0); if (v != null) e.to = dayOf(v); };
        const w = el("input", { value: shTxt(e.work), placeholder: L("non_lavorativo"), style: { width: "150px" } }); w.onchange = () => (e.work = parseSh(w.value));
        list.append(el("div", { class: "pj-prow" }, n, a, b, w, el("button", { class: "btn", onclick: () => { cur.exc.splice(cur.exc.indexOf(e), 1); render(); } }, "✕")));
        void k;
      });
      const today = dayOf(now());
      ex.append(list, el("div", { class: "pj-prow" },
        el("button", { class: "btn", onclick: () => { cur.exc.push({ from: today, to: today, name: L("eccezione"), work: [] }); render(); } }, L("aggiungi_eccezione")),
        el("button", { class: "btn", onclick: () => { const y0 = ymd(P.start)[0], y1 = ymd(P.finish)[0] + 1; const tmp = { calendars: [cur] }; const n = addItalianHolidays(tmp, cur.uid, y0, y1, holidayNames()); toast(tn("proj.n_festivi", n)); render(); } }, L("festivi_italiani"))));
      box.append(ex);
    }
    render();
    const ok = await modal(L("orario_lavorativo"), box, [{ label: t("common.annulla"), value: false }, { label: t("common.ok"), value: true, primary: true }]);
    if (ok) change(() => { S.P.calendars = work; });
  }
  const holidayNames = () => Object.fromEntries(["capodanno", "epifania", "pasqua", "pasquetta", "liberazione", "lavoro", "repubblica", "ferragosto", "santi", "immacolata", "natale", "stefano"].map(k => [k, L("fest_" + k)]));
  async function baselineDlg() {
    const P = S.P;
    const n = el("select", {}, ...Array.from({ length: 11 }, (_, i) => el("option", { value: i }, i ? `${L("linea_base")} ${i}` : L("linea_base"))));
    const all = el("input", { type: "radio", name: "pjb", checked: true }), sel = el("input", { type: "radio", name: "pjb" });
    const clear = el("input", { type: "checkbox" });
    const ok = await modal(L("imposta_linea_base"), el("div", { class: "pj-form" }, field(L("linea_base"), n), el("label", { class: "wide" }, all, " ", L("intero_progetto")), el("label", { class: "wide" }, sel, " ", L("attivita_selezionate")), el("label", { class: "wide" }, clear, " ", L("cancella_linea_base"))),
      [{ label: t("common.annulla"), value: false }, { label: t("common.ok"), value: true, primary: true }]);
    if (!ok) return;
    const k = +n.value;
    change(() => {
      const only = sel.checked ? new Set(selTasks().map(x => x.uid)) : null;
      if (clear.checked) { for (const x of P.tasks) if (!only || only.has(x.uid)) { if (x.bl) x.bl[k] = null; } }
      else setBaseline(P, k, only);
      S.o.base = !clear.checked; saveOpt();
    });
  }
  async function columnsDlg() {
    const boxes = ALL_COLS.filter(c => !["ind", "id", "name"].includes(c)).map(c => { const i = el("input", { type: "checkbox" }); i.checked = S.cols.includes(c); i.dataset.c = c; return el("label", {}, i, " ", colTitle(c) || L("c_" + c)); });
    const ok = await modal(L("colonne"), el("div", { class: "pj-checks col" }, ...boxes), [{ label: t("common.annulla"), value: false }, { label: t("common.ok"), value: true, primary: true }]);
    if (!ok) return;
    const on = new Set(boxes.map(b => b.querySelector("input")).filter(i => i.checked).map(i => i.dataset.c));
    S.cols = ALL_COLS.filter(c => ["ind", "id", "name"].includes(c) || on.has(c));
    try { localStorage.setItem("mbv-pj-cols", JSON.stringify(S.cols)); } catch { /* */ }
    renderHead(); renderGrid();
  }
  function doLevel() {
    change(() => { const n = level(S.P); toast(n ? tn("proj.n_livellate", n) : L("nessun_conflitto")); });
  }
  function clearLevel() { change(() => { for (const x of S.P.tasks) x.delay = 0; }); }

  // ---------------------------------------------------------------- barra multifunzione
  let tab = "task";
  const TABS = [["task", L("t_attivita")], ["res", L("t_risorse")], ["proj", L("t_progetto")], ["view", L("t_visualizza")], ["fmt", L("t_formato")]];
  const B = (label, icon, fn, title) => button(label, icon, fn, { title: title || label, class: "pj-b" });
  function ribbon() {
    ctx.tb.innerHTML = "";
    const tabsEl = el("div", { class: "pj-rtabs" }, ...TABS.map(([k, n]) => el("button", { class: "pj-rtab" + (k === tab ? " on" : ""), type: "button", onclick: () => { tab = k; ribbon(); } }, n)));
    const viewSel = el("select", { class: "pj-viewsel", title: L("vista") }, ...VIEWS().map(([k, n]) => el("option", { value: k, selected: k === S.view }, n)));
    viewSel.onchange = () => setView(viewSel.value);
    const grp = (...items) => el("span", { class: "pj-grp" }, ...items);
    let items = [];
    if (tab === "task") items = [
      grp(B(t("common.annulla_op"), IC.undo, undo, `${t("common.annulla_op")} (Ctrl+Z)`), B(t("common.ripeti"), IC.redo, redo, `${t("common.ripeti")} (Ctrl+Y)`)),
      grp(B(L("attivita"), IC.task, () => insertTask("task"), `${L("nuova_attivita")} (Ins)`), B(L("riepilogo"), IC.sum, () => insertTask("sum")), B(L("cardine"), IC.ms, () => insertTask("ms")), B(t("common.elimina"), IC.del, deleteTasks, `${t("common.elimina")} (Canc)`)),
      grp(B(L("rientra"), IC.ind, () => indent(1), `${L("rientra")} (Alt+Maiusc+→)`), B(L("riduci_rientro"), IC.out, () => indent(-1), `${L("riduci_rientro")} (Alt+Maiusc+←)`)),
      grp(B(L("collega"), IC.link, linkSel, `${L("collega")} (Ctrl+F2)`), B(L("scollega"), IC.unlink, unlinkSel, `${L("scollega")} (Ctrl+Maiusc+F2)`)),
      grp(...[0, 25, 50, 75, 100].map(n => B(n + "%", null, () => pctSel(n), L("completa") + " " + n + "%"))),
      grp(B(L("manuale"), IC.manual, () => modeSel(true)), B(L("automatica"), IC.auto, () => modeSel(false))),
      grp(B(L("informazioni"), IC.info, () => taskInfo(curTask() || selTasks()[0]), `${L("informazioni")} (Maiusc+F2)`), B(L("note"), IC.note, () => { const x = curTask(); if (x) taskInfo(x).then(() => {}); }), B(L("in_sequenza"), IC.time, toggleTimeline), B(L("scorri_attivita"), IC.goto, () => scrollToTask(), `${L("scorri_attivita")} (Ctrl+Maiusc+F5)`)),
    ];
    else if (tab === "res") items = [
      grp(B(L("foglio_risorse"), IC.res, () => setView("ressheet")), B(L("uso_risorse"), IC.xls, () => setView("resuse"))),
      grp(B(L("assegna_risorse"), IC.res, () => assignDlg())),
      grp(B(L("livella_tutto"), IC.level, doLevel), B(L("cancella_livellamento"), IC.undo, clearLevel)),
    ];
    else if (tab === "proj") items = [
      grp(B(L("info_progetto"), IC.proj, projectInfo), B(L("orario_lavorativo"), IC.cal, calendarDlg), B(L("festivi_italiani"), IC.cal, () => change(() => { const P = S.P; const n = addItalianHolidays(P, P.cal, ymd(P.start)[0], ymd(P.finish)[0] + 1, holidayNames()); toast(tn("proj.n_festivi", n)); }))),
      grp(B(L("imposta_linea_base"), IC.base, baselineDlg)),
      grp(B(L("confronta_versione"), IC.cmp, () => setView("compare")), B(L("aggiorna_avanzamento"), IC.pct, () => setView("progress"))),
      grp(B(L("esporta_pdf"), IC.pdf, () => X.exportDialog(E, "pdf")), B(L("gantt_cliente"), IC.client, () => X.exportDialog(E, "client")), B("Excel", IC.xls, () => X.exportDialog(E, "xlsx")), B(L("immagine"), IC.img, () => X.exportDialog(E, "png"))),
    ];
    else if (tab === "view") items = [
      grp(...VIEWS().slice(0, 4).map(([k, n]) => B(n, null, () => setView(k)))),
      grp(...VIEWS().slice(4).map(([k, n]) => B(n, null, () => setView(k)))),
      grp(B(L("zoom_piu"), IC.zin, () => zoomAt(1), "Ctrl+/"), B(L("zoom_meno"), IC.zout, () => zoomAt(-1), "Ctrl+Maiusc+/"), B(L("intero_progetto"), IC.fit, zoomFit)),
      grp(B(L("espandi_tutto"), null, () => collapseAll(true)), B(L("comprimi_tutto"), null, () => collapseAll(false)), B(L("livello") + " 1", null, () => outlineLevel(1)), B(L("livello") + " 2", null, () => outlineLevel(2))),
      grp(filterBox()),
    ];
    else if (tab === "fmt") items = [
      grp(toggle(L("percorso_critico"), IC.crit, "crit"), toggle(L("linea_base"), IC.base, "base"), toggle(L("margine"), IC.slack, "slack")),
      grp(toggle(L("sequenza_temporale"), IC.time, "timeline"), toggle(L("oggi"), null, "today"), toggle(L("etichette"), null, "names")),
      grp(B(L("colonne"), IC.cols, columnsDlg)),
    ];
    ctx.tb.append(viewSel, tabsEl, el("span", { class: "pj-ritems" }, ...items));
  }
  function toggle(label, icon, key) {
    const b = B(label, icon, () => { S.o[key] = !S.o[key]; saveOpt(); b.classList.toggle("on", S.o[key]); refresh(); });
    b.classList.toggle("on", !!S.o[key]);
    return b;
  }
  function filterBox() {
    const s = el("select", { title: L("filtro") }, el("option", { value: "" }, L("f_tutte")), el("option", { value: ":crit" }, L("f_critiche")), el("option", { value: ":late" }, L("f_in_ritardo")), el("option", { value: ":ms" }, L("f_cardini")));
    s.value = S.filter.startsWith(":") ? S.filter : "";
    s.onchange = () => { S.filter = s.value; refresh(); };
    const q = el("input", { type: "search", placeholder: L("cerca"), value: S.filter.startsWith(":") ? "" : S.filter, style: { width: "150px" } });
    q.oninput = () => { S.filter = q.value; refresh(); };
    return el("span", { class: "pj-filter" }, s, q);
  }
  async function assignDlg() {
    const sel = selTasks().filter(x => !x.sum);
    if (!sel.length) return toast(L("seleziona_attivita"));
    if (!S.P.resources.length) { toast(L("nessuna_risorsa_definita")); return setView("ressheet"); }
    const rs = S.P.resources.map(r => { const i = el("input", { type: "checkbox" }); i.checked = sel.every(x => S.P.assignments.some(a => a.task === x.uid && a.res === r.uid)); const u = el("input", { type: "number", value: r.type === "material" ? 1 : 100, style: { width: "70px" } }); return { r, i, u, row: el("div", { class: "pj-prow" }, el("label", {}, i, " ", r.name), u, el("span", {}, r.type === "material" ? r.label || "" : "%")) }; });
    const ok = await modal(L("assegna_risorse"), el("div", {}, el("p", { class: "pj-note" }, sel.map(x => x.name).join(", ")), ...rs.map(x => x.row)), [{ label: t("common.annulla"), value: false }, { label: t("common.ok"), value: true, primary: true }]);
    if (!ok) return;
    change(() => {
      const P = S.P;
      for (const x of sel) for (const { r, i, u } of rs) {
        const a = P.assignments.find(y => y.task === x.uid && y.res === r.uid);
        if (i.checked && !a) P.assignments.push({ uid: nextUid(P.assignments), task: x.uid, res: r.uid, units: r.type === "material" ? +u.value || 1 : (+u.value || 100) / 100, w: null });
        if (!i.checked && a) P.assignments.splice(P.assignments.indexOf(a), 1);
      }
    });
  }

  // ---------------------------------------------------------------- viste
  const VIEWS = () => [["gantt", L("v_gantt")], ["tracking", L("v_verifica")], ["calendar", L("v_calendario")], ["network", L("v_reticolare")], ["ressheet", L("v_foglio_risorse")], ["resuse", L("v_uso_risorse")], ["compare", L("v_confronto")], ["progress", L("v_avanzamento")]];
  function setView(v) {
    if (editing) commitEdit();
    S.view = v;
    ribbon();
    refresh();
  }
  function refresh() {
    outline(S.P);
    const us = resourceUsage(S.P);
    S.over = us.over;
    S.overTasks = new Set();
    for (const [ru, ds] of us.over) { const set = new Set(ds); for (const [a, pm] of us.perTask) if (a.res === ru && [...pm.keys()].some(d => set.has(d))) S.overTasks.add(a.task); }
    computeRows();
    const g = S.view === "gantt" || S.view === "tracking";
    gantt.hidden = !g;
    other.hidden = g;
    if (g) { computeSpan(); renderHead(); renderGrid(); draw(); }
    else { tlCanvas.hidden = true; V.render(S.view, other, E); }
    status();
  }
  function status() {
    const P = S.P;
    const crit = P.tasks.filter(x => x.crit && !x.sum).length;
    ctx.status(`${tn("proj.n_attivita", P.tasks.filter(x => !x.isNull).length)} · ${L("fine_progetto")} ${fd(P.finish)} · ${L("critiche")} ${crit}${S.over?.size ? " · " + tn("proj.n_sovrallocate", S.over.size) : ""}${P.warnings?.length ? " · " + L("ciclo") : ""}`);
  }

  // ---------------------------------------------------------------- tasti di Project
  keymap(ctx, "Project", [
    { keys: "Ctrl+Z", desc: t("common.annulla_op"), run: undo },
    { keys: "Ctrl+Y|Ctrl+Shift+Z", desc: t("common.ripeti"), run: redo },
    { keys: "Insert", desc: L("nuova_attivita"), run: () => insertTask("task") },
    { keys: "Delete", desc: L("elimina_attivita"), run: deleteTasks },
    { keys: "Alt+Shift+ArrowRight", desc: L("rientra"), run: () => indent(1) },
    { keys: "Alt+Shift+ArrowLeft", desc: L("riduci_rientro"), run: () => indent(-1) },
    { keys: "Ctrl+F2", desc: L("collega"), run: linkSel },
    { keys: "Ctrl+Shift+F2", desc: L("scollega"), run: unlinkSel },
    { keys: "Shift+F2", desc: L("informazioni"), run: () => taskInfo(curTask() || selTasks()[0]) },
    { keys: "F2", desc: L("modifica_cella"), run: () => startEdit(S.cur.row, S.cur.col) },
    { keys: "Ctrl+Shift+F5", desc: L("scorri_attivita"), run: () => scrollToTask() },
    { keys: "Ctrl+/", desc: L("zoom_piu"), run: () => zoomAt(1) },
    { keys: "Ctrl+Shift+/", desc: L("zoom_meno"), run: () => zoomAt(-1) },
    { keys: "Alt+Shift+-", desc: L("comprimi"), run: () => { for (const x of selTasks()) if (x.sum) S.collapsed.add(x.uid); refresh(); } },
    { keys: "Alt+Shift++", desc: L("espandi"), run: () => { for (const x of selTasks()) S.collapsed.delete(x.uid); refresh(); } },
    { keys: "Ctrl+C", desc: t("common.copia"), run: () => copySel() },
    { keys: "Ctrl+X", desc: t("common.taglia"), run: () => copySel(true) },
    { keys: "Ctrl+V", desc: t("common.incolla"), run: paste },
    { keys: "Ctrl+A", desc: L("seleziona_tutto"), run: () => { S.sel = new Set(S.P.tasks.map(x => x.uid)); renderGrid(); draw(); } },
  ]);

  const ro = new ResizeObserver(() => { if (!root.isConnected) return ro.disconnect(); if (S.view === "gantt" || S.view === "tracking") { renderGrid(); draw(); } });
  ro.observe(root);

  const E = {
    P: S.P, S, ctx, change, refresh, setView, taskInfo, setPct, colors, xOfDay: () => ppd(), selTasks, L,
    get P2() { return S.P; },
    setOther(op, map) { S.other = op; S.otherMap = map; refresh(); },
    onShow() { refresh(); },
    zoomFit,
    ganttState: () => ({ zoom: ppd(), crit: S.o.crit, base: S.o.base || S.view === "tracking", rows: rows.slice(), names: S.o.names }),
    undo, redo,
    _test: { xOf: m => xOf(m) - chartScroll.scrollLeft, rows: () => rows, canvas: chartCanvas, scroller: chartScroll }, // prove dalla console
  };
  schedule(S.P);
  ribbon();
  refresh();
  requestAnimationFrame(() => { zoomFit(); });
  return E;

  function loadOpt() { try { return JSON.parse(localStorage.getItem("mbv-pj-opt") || "{}"); } catch { return {}; } }
  function saveOpt() { try { localStorage.setItem("mbv-pj-opt", JSON.stringify(S.o)); } catch { /* */ } }
  function loadCols() { try { const c = JSON.parse(localStorage.getItem("mbv-pj-cols") || "null"); if (Array.isArray(c) && c.includes("name")) return c.filter(x => ALL_COLS.includes(x)); } catch { /* */ } return DEF_COLS.slice(); }
}
export { leaves, confirmBox };
