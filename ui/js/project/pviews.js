// Viste dei piani di progetto oltre al Gantt: Calendario, Diagramma reticolare, Foglio risorse, Uso risorse,
// Confronto tra versioni, Avanzamento (pensata anche per il telefono: si aggiorna il lavoro fatto con un dito).
import { el, toast, pickFiles, readBytes, api, waitJob, WEB, extOf } from "../core.js";
import { t, tn, LOCALE } from "../i18n.js";
import { isMilestone, resourceUsage, nextUid, compare, calendarsOf } from "./pmodel.js";
import { DAY, dayOf, weekday, ymd, fromParts } from "./pcal.js";
import { fd, fdd, fdm, fmon, durText, money, hours } from "./pfmt.js";
import { readProject, fromEngine } from "./pio.js";

const L = k => t("proj." + k);
const nowMin = () => { const d = new Date(); return fromParts(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()); };

export function render(view, box, E) {
  box.innerHTML = "";
  box.className = "pj-other pj-v-" + view;
  ({ calendar, network, ressheet, resuse, compare: compareView, progress })[view]?.(box, E);
}

// ---------------------------------------------------------------- calendario (mese)
function calendar(box, E) {
  const P = E.S.P;
  const st = E.S.calMonth ??= (() => { const [y, m] = ymd(Math.max(P.start, Math.min(nowMin(), P.finish))); return [y, m]; })();
  const [y, m] = st;
  const head = el("div", { class: "pj-vhead" },
    el("button", { class: "btn", onclick: () => { E.S.calMonth = m === 1 ? [y - 1, 12] : [y, m - 1]; E.refresh(); } }, "‹"),
    el("b", {}, fmon(fromParts(y, m, 1))),
    el("button", { class: "btn", onclick: () => { E.S.calMonth = m === 12 ? [y + 1, 1] : [y, m + 1]; E.refresh(); } }, "›"),
    el("button", { class: "btn", onclick: () => { const [a, b] = ymd(nowMin()); E.S.calMonth = [a, b]; E.refresh(); } }, L("oggi")));
  const grid = el("div", { class: "pj-cal" });
  for (let i = 0; i < 7; i++) grid.append(el("div", { class: "dow" }, new Intl.DateTimeFormat(LOCALE, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 10, 2 + i)))));
  const first = dayOf(fromParts(y, m, 1));
  const start = first - ((weekday(first) + 6) % 7);
  const cal = calendarsOf(P).project;
  const tasks = P.tasks.filter(x => !x.sum && !x.isNull);
  for (let w = 0; w < 6; w++) {
    for (let d = 0; d < 7; d++) {
      const day = start + w * 7 + d;
      const [, mm, dd] = ymd(day * DAY);
      const cell = el("div", { class: "pj-cday" + (mm !== m ? " out" : "") + (!cal.isWorkDay(day) ? " off" : "") + (day === dayOf(nowMin()) ? " today" : "") }, el("span", { class: "n" }, dd));
      const on = tasks.filter(x => dayOf(x.start) <= day && dayOf(x.finish - (x.finish > x.start ? 1 : 0)) >= day);
      for (const x of on.slice(0, 4)) cell.append(el("div", { class: "pj-cev" + (x.crit && E.S.o.crit ? " crit" : "") + (isMilestone(x) ? " ms" : ""), title: `${x.name}\n${fd(x.start)} → ${fd(x.finish)}`, ondblclick: () => E.taskInfo(x) }, (isMilestone(x) ? "◆ " : "") + x.name));
      if (on.length > 4) cell.append(el("div", { class: "pj-cmore" }, tn("proj.n_altre", on.length - 4)));
      grid.append(cell);
    }
    if (start + (w + 1) * 7 > dayOf(fromParts(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1))) break;
  }
  box.append(head, grid);
}

// ---------------------------------------------------------------- diagramma reticolare (PERT)
function network(box, E) {
  const P = E.S.P;
  const tasks = P.tasks.filter(x => !x.sum && !x.isNull && x.act !== false);
  const by = new Map(tasks.map(x => [x.uid, x]));
  // colonna = livello nel grafo dei collegamenti (predecessori riportati alle foglie)
  const preds = x => (x.preds || []).flatMap(p => { const a = P.tasks.find(y => y.uid === p.u); return a ? (a.sum ? a.kids.filter(k => by.has(k.uid)) : by.has(a.uid) ? [a] : []) : []; });
  const col = new Map();
  const depth = (x, seen = new Set()) => {
    if (col.has(x.uid)) return col.get(x.uid);
    if (seen.has(x.uid)) return 0;
    seen.add(x.uid);
    const d = Math.max(-1, ...preds(x).map(p => depth(p, seen))) + 1;
    col.set(x.uid, d);
    return d;
  };
  tasks.forEach(x => depth(x));
  const cols = [];
  for (const x of tasks.sort((a, b) => a.start - b.start || a.id - b.id)) (cols[col.get(x.uid)] ||= []).push(x);
  const BW = 180, BH = 74, GX = 60, GY = 22;
  const pos = new Map();
  cols.forEach((c, i) => c.forEach((x, j) => pos.set(x.uid, [20 + i * (BW + GX), 20 + j * (BH + GY)])));
  const W = 40 + cols.length * (BW + GX), H = 40 + Math.max(1, ...cols.map(c => c.length)) * (BH + GY);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", W); svg.setAttribute("height", H); svg.setAttribute("class", "pj-net");
  const mk = (tag, a) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); return e; };
  for (const x of tasks) for (const p of preds(x)) {
    const [x1, y1] = pos.get(p.uid), [x2, y2] = pos.get(x.uid);
    const crit = E.S.o.crit && p.crit && x.crit;
    svg.append(mk("path", { d: `M${x1 + BW} ${y1 + BH / 2} C${x1 + BW + GX / 2} ${y1 + BH / 2} ${x2 - GX / 2} ${y2 + BH / 2} ${x2 - 4} ${y2 + BH / 2}`, class: "lnk" + (crit ? " crit" : ""), "marker-end": "url(#pjarr)" }));
  }
  const defs = mk("defs", {});
  const mark = mk("marker", { id: "pjarr", markerWidth: 8, markerHeight: 8, refX: 6, refY: 4, orient: "auto" });
  mark.append(mk("path", { d: "M0 0L8 4L0 8z", class: "arr" }));
  defs.append(mark); svg.prepend(defs);
  for (const x of tasks) {
    const [bx, by2] = pos.get(x.uid);
    const g = mk("g", { class: "box" + (E.S.o.crit && x.crit ? " crit" : "") + (isMilestone(x) ? " ms" : "") + (x.pct >= 100 ? " done" : "") });
    g.append(mk("rect", { x: bx, y: by2, width: BW, height: BH, rx: isMilestone(x) ? 18 : 4 }));
    const txt = (s, dx, dy, cls = "") => { const e = mk("text", { x: bx + dx, y: by2 + dy, class: cls }); e.textContent = s; g.append(e); };
    txt(x.name.length > 26 ? x.name.slice(0, 25) + "…" : x.name, 8, 18, "nm");
    txt(`${L("c_inizio")}: ${fd(x.start)}`, 8, 36); txt(`ID: ${x.id}`, BW - 50, 36);
    txt(`${L("c_fine")}: ${fd(x.finish)}`, 8, 52); txt(durText(P, x), BW - 50, 52);
    txt(`${Math.round(x.pct || 0)}%`, 8, 67, "pc");
    g.addEventListener("dblclick", () => E.taskInfo(x));
    const ttl = mk("title", {}); ttl.textContent = x.name; g.append(ttl);
    svg.append(g);
  }
  box.append(el("div", { class: "pj-netwrap" }, svg));
}

// ---------------------------------------------------------------- foglio risorse
function ressheet(box, E) {
  const P = E.S.P;
  const over = E.S.over || new Map();
  const cols = [["name", L("c_nome"), 200], ["type", L("tipo"), 110], ["label", L("etichetta_materiale"), 90], ["ini", L("iniziali"), 70], ["group", L("gruppo"), 120], ["max", L("unita_max"), 90], ["rate", L("tariffa_std"), 100], ["ovt", L("tariffa_str"), 100], ["use", L("costo_uso"), 90], ["cal", L("calendario"), 140], ["email", "Email", 160]];
  const tbl = el("table", { class: "pj-table" });
  tbl.append(el("tr", {}, el("th", {}, ""), ...cols.map(([, n, w]) => el("th", { style: { width: w + "px" } }, n)), el("th", {}, L("c_lavoro")), el("th", {}, L("c_costo")), el("th", {}, "")));
  const upd = (r, k, v) => E.change(() => {
    if (k === "max") r.max = Math.max(0, parseFloat(String(v).replace(",", ".").replace("%", "")) / (String(v).includes("%") || parseFloat(v) > 10 ? 100 : 1) || 0);
    else if (["rate", "ovt", "use"].includes(k)) r[k] = parseFloat(String(v).replace(",", ".")) || 0;
    else if (k === "cal") r.cal = v ? +v : null;
    else r[k] = v;
  });
  for (const r of P.resources) {
    const tr = el("tr", { class: over.has(r.uid) ? "over" : "" }, el("td", { class: "ind", title: over.has(r.uid) ? L("ind_sovrallocata") : "" }, over.has(r.uid) ? "♟" : ""));
    for (const [k] of cols) {
      let inp;
      if (k === "type") { inp = el("select", {}, ...["work", "material", "cost"].map(v => el("option", { value: v, selected: r.type === v }, L("r_" + v)))); }
      else if (k === "cal") inp = el("select", {}, el("option", { value: "" }, L("calendario_progetto")), ...P.calendars.map(c => el("option", { value: c.uid, selected: r.cal === c.uid }, c.name)));
      else inp = el("input", { value: k === "max" ? Math.round((r.max ?? 1) * 100) + "%" : r[k] ?? "" });
      inp.onchange = () => upd(r, k, inp.value);
      tr.append(el("td", {}, inp));
    }
    tr.append(el("td", { class: "num" }, hours(r.work)), el("td", { class: "num" }, money(r.cost, P.currency)),
      el("td", {}, el("button", { class: "btn", title: t("common.elimina"), onclick: () => E.change(() => { P.resources.splice(P.resources.indexOf(r), 1); P.assignments = P.assignments.filter(a => a.res !== r.uid); }) }, "✕")));
    tbl.append(tr);
  }
  const add = el("button", { class: "btn primary", onclick: () => E.change(() => { P.resources.push({ uid: nextUid(P.resources), name: L("nuova_risorsa") + " " + (P.resources.length + 1), type: "work", ini: "", group: "", max: 1, rate: 0, ovt: 0, use: 0 }); }) }, L("aggiungi_risorsa"));
  box.append(el("div", { class: "pj-vhead" }, add, el("span", { class: "pj-note" }, L("nota_risorse"))), el("div", { class: "pj-scroll" }, tbl));
}

// ---------------------------------------------------------------- uso delle risorse (ore per giorno o settimana)
function resuse(box, E) {
  const P = E.S.P;
  const us = resourceUsage(P);
  const weekly = (P.finish - P.start) / DAY > 70;
  const d0 = dayOf(P.start) - ((weekday(dayOf(P.start)) + 6) % 7), d1 = dayOf(P.finish) + 1;
  const buckets = [];
  for (let d = d0; d <= d1; d += weekly ? 7 : 1) buckets.push([d, weekly ? d + 7 : d + 1]);
  const sum = (m, a, b) => { let n = 0; if (m) for (let d = a; d < b; d++) n += m.get(d) || 0; return n; };
  const cap = (r, a, b) => { let n = 0; for (let d = a; d < b; d++) n += us.avail(r, d); return n; };
  const tbl = el("table", { class: "pj-table pj-use" });
  tbl.append(el("tr", {}, el("th", { class: "sticky" }, L("c_nome")), el("th", {}, L("c_lavoro")), ...buckets.map(([a]) => el("th", {}, weekly ? fdm(a * DAY) : fdm(a * DAY)))));
  const fmt = m => (m ? (Math.round(m / 6) / 10).toLocaleString(LOCALE) : "");
  for (const r of P.resources.filter(r => r.type === "work")) {
    const m = us.use.get(r.uid);
    tbl.append(el("tr", { class: "res" + (us.over.has(r.uid) ? " over" : "") }, el("td", { class: "sticky" }, (us.over.has(r.uid) ? "♟ " : "") + r.name), el("td", { class: "num" }, hours(r.work)),
      ...buckets.map(([a, b]) => { const w = sum(m, a, b); return el("td", { class: "num" + (w > cap(r, a, b) + 0.5 ? " bad" : "") }, fmt(w)); })));
    for (const [a, pm] of us.perTask) {
      if (a.res !== r.uid) continue;
      const tk = P.tasks.find(x => x.uid === a.task);
      tbl.append(el("tr", { class: "asg" }, el("td", { class: "sticky" }, "   " + (tk?.name || "")), el("td", { class: "num" }, hours([...pm.values()].reduce((x, y) => x + y, 0))), ...buckets.map(([x, y]) => el("td", { class: "num" }, fmt(sum(pm, x, y))))));
    }
  }
  box.append(el("div", { class: "pj-vhead" }, el("b", {}, L("v_uso_risorse")), el("span", { class: "pj-note" }, weekly ? L("ore_settimana_nota") : L("ore_giorno_nota"))), el("div", { class: "pj-scroll" }, tbl));
}

// ---------------------------------------------------------------- confronto tra due versioni del piano
function compareView(box, E) {
  const P = E.S.P;
  const head = el("div", { class: "pj-vhead" });
  const pick = el("button", { class: "btn primary", onclick: async () => {
    const files = await pickFiles();
    const f = files?.[0];
    if (!f) return;
    try {
      const ext = extOf(f);
      let O;
      if (/^(mpp|mpt)$/.test(ext) && !WEB) { const { job } = await api("mpp_read", { path: f }); O = fromEngine(await waitJob(job)); }
      else O = readProject(await readBytes(f), ext);
      E.S.otherName = f.split(/[\\/]/).pop();
      const res = compare(P, O);
      const map = new Map();
      for (const r of res.rows) if (r.a && r.b) map.set(r.a.uid, r.b);
      E.S.cmp = res;
      E.setOther(O, map);
    } catch (e) { toast(e.message, true); }
  } }, E.S.other ? L("cambia_versione") : L("scegli_versione"));
  head.append(pick);
  if (E.S.other) head.append(el("button", { class: "btn", onclick: () => { E.S.cmp = null; E.S.otherName = null; E.setOther(null, null); } }, L("togli_confronto")), el("button", { class: "btn", onclick: () => E.setView("gantt") }, L("vedi_nel_gantt")));
  box.append(head);
  const res = E.S.cmp;
  if (!res) { box.append(el("p", { class: "pj-note pj-pad" }, L("nota_confronto"))); return; }
  const dd = m => { const d = Math.round(m / DAY); return d === 0 ? "" : (d > 0 ? "+" : "") + d + " " + L("u_dcal"); };
  const counts = { add: 0, del: 0, mod: 0 };
  res.rows.forEach(r => counts[r.kind] !== undefined && counts[r.kind]++);
  box.append(el("div", { class: "pj-cmpsum" }, el("b", {}, `${L("confronto_con")} ${E.S.otherName}`),
    el("span", {}, `${L("fine_progetto")}: ${fd(P.finish)} → ${fd(E.S.other.finish)} ${dd(res.dFinish)}`),
    el("span", { class: "add" }, tn("proj.n_aggiunte", counts.add)), el("span", { class: "del" }, tn("proj.n_tolte", counts.del)), el("span", { class: "mod" }, tn("proj.n_modificate", counts.mod))));
  const tbl = el("table", { class: "pj-table" });
  tbl.append(el("tr", {}, el("th", {}, ""), el("th", {}, L("c_nome")), el("th", {}, L("c_inizio")), el("th", {}, L("c_inizio") + " ²"), el("th", {}, "Δ"), el("th", {}, L("c_fine")), el("th", {}, L("c_fine") + " ²"), el("th", {}, "Δ"), el("th", {}, L("c_pct")), el("th", {}, L("cambiamenti"))));
  const lab = { name: L("c_nome"), start: L("c_inizio"), finish: L("c_fine"), dur: L("c_durata"), pct: L("c_pct"), preds: L("c_predecessori") };
  for (const r of res.rows) {
    if (r.kind === "same" && !E.S.cmpAll) continue;
    const a = r.a, b = r.b;
    tbl.append(el("tr", { class: "c-" + r.kind },
      el("td", {}, { add: "+", del: "−", mod: "≠", same: "" }[r.kind]),
      el("td", {}, (a || b).name + (a && b && a.name !== b.name ? ` → ${b.name}` : "")),
      el("td", {}, fd(a?.start)), el("td", {}, fd(b?.start)), el("td", { class: "num" }, r.dStart ? dd(r.dStart) : ""),
      el("td", {}, fd(a?.finish)), el("td", {}, fd(b?.finish)), el("td", { class: "num" + (r.dFinish > 0 ? " bad" : "") }, r.dFinish ? dd(r.dFinish) : ""),
      el("td", {}, a && b ? `${Math.round(a.pct || 0)}% → ${Math.round(b.pct || 0)}%` : ""),
      el("td", {}, (r.ch || []).map(k => lab[k]).join(", "))));
  }
  const all = el("label", {}, el("input", { type: "checkbox", checked: !!E.S.cmpAll, onchange: e => { E.S.cmpAll = e.target.checked; E.refresh(); } }), " ", L("mostra_uguali"));
  box.append(all, el("div", { class: "pj-scroll" }, tbl));
}

// ---------------------------------------------------------------- avanzamento (anche dal telefono)
function progress(box, E) {
  const P = E.S.P;
  const now = nowMin();
  const status = P.status ?? now;
  const mode = E.S.progMode ||= "now";
  const tasks = P.tasks.filter(x => !x.sum && !x.isNull && x.act !== false && (mode === "all" ? true : mode === "late" ? (x.pct || 0) < 100 && x.finish < status : (x.pct || 0) < 100 && x.start <= status + 7 * DAY));
  const seg = el("div", { class: "pj-seg" }, ...[["now", L("p_in_corso")], ["late", L("p_in_ritardo")], ["all", L("p_tutte")]].map(([k, n]) => el("button", { class: "btn" + (k === mode ? " primary" : ""), onclick: () => { E.S.progMode = k; E.refresh(); } }, n)));
  box.append(el("div", { class: "pj-vhead" }, seg, el("span", { class: "pj-note" }, `${L("data_stato")}: ${fdd(status)}`)));
  const list = el("div", { class: "pj-prog" });
  if (!tasks.length) list.append(el("p", { class: "pj-note pj-pad" }, L("niente_da_aggiornare")));
  for (const x of tasks) {
    const expected = x.finish <= status ? 100 : x.start >= status ? 0 : Math.round(100 * calendarsOf(P).project.between(x.start, status) / Math.max(1, calendarsOf(P).project.between(x.start, x.finish)));
    const late = (x.pct || 0) < expected - 5;
    const val = el("b", {}, Math.round(x.pct || 0) + "%");
    const rng = el("input", { type: "range", min: 0, max: 100, step: 5, value: Math.round(x.pct || 0) });
    rng.oninput = () => (val.textContent = rng.value + "%");
    rng.onchange = () => E.change(() => E.setPct(x, +rng.value));
    list.append(el("div", { class: "pj-pcard" + (late ? " late" : "") },
      el("div", { class: "pj-ptop" }, el("span", { class: "nm" }, x.name), val),
      el("div", { class: "pj-pdates" }, `${fd(x.start)} → ${fd(x.finish)} · ${durText(P, x)}`, late ? el("span", { class: "bad" }, ` · ${L("atteso")} ${expected}%`) : null),
      rng,
      el("div", { class: "pj-pbtn" }, ...[0, 50, 100].map(n => el("button", { class: "btn", onclick: () => E.change(() => E.setPct(x, n)) }, n === 100 ? L("completata") : n + "%")))));
  }
  box.append(list);
}
