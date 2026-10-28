// Esportazioni dei piani di progetto: PDF vettoriale del Gantt su piu' fogli (tabella ripetuta, scala del tempo,
// legenda), "Gantt per il cliente" (solo fasi e cardini, caratteri grandi, colori per fase), Excel e immagine PNG.
// Un solo disegno per PDF e immagine: "pittore" con rect/line/text/poly in punti tipografici (PdfDoc o canvas).
import { el, modal, toast, saveBlobAs } from "../core.js";
import { t } from "../i18n.js";
import { PdfDoc, textW } from "../bcfreport.js";
import { saveXlsx } from "../compare/common.js";
import { isMilestone, predsText } from "./pmodel.js";
import { DAY, dayOf, weekday, ymd, fromParts } from "./pcal.js";
import { fd, fdd, fdm, fmon, fmons, durText, unitLabels, money, hours } from "./pfmt.js";

const L = k => t("proj." + k);
const PAPER = { A4: [842, 595], A3: [1191, 842], A2: [1684, 1191], A1: [2384, 1684] };
const PAL = ["#3f7cc4", "#e08a3c", "#4f9d63", "#9563c4", "#c4567a", "#2f9c98", "#b19a2c", "#6b7a8f"];
const hex = c => { const m = /^#?([0-9a-f]{6})$/i.exec(c || "") ; const n = m ? parseInt(m[1], 16) : 0; return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(v => v.toFixed(3)).join(" "); };

// pittore PDF (y dall'alto)
function pdfPainter(doc) {
  return {
    rect: (x, y, w, h, c) => doc.rect(x, y, w, h, c),
    line: (x1, y1, x2, y2, c = "#c4c7c1", w = 0.5, dash = null) => doc.op(`${dash ? `[${dash.join(" ")}] 0 d ` : ""}${hex(c)} RG ${w} w ${x1.toFixed(2)} ${(doc.H - y1).toFixed(2)} m ${x2.toFixed(2)} ${(doc.H - y2).toFixed(2)} l S${dash ? " [] 0 d" : ""}`),
    poly: (pts, c) => doc.op(`${hex(c)} rg ${pts.map(([x, y], i) => `${x.toFixed(2)} ${(doc.H - y).toFixed(2)} ${i ? "l" : "m"}`).join(" ")} h f`),
    text: (x, y, s, size, o = {}) => { const w = textW(s, size, o.bold); doc.text(o.align === "right" ? x - w : o.align === "center" ? x - w / 2 : x, y - size * 0.5, s, size, { bold: o.bold, color: o.color || "#1b1e1c" }); },
    clip: (x, y, w, h) => doc.op(`q ${x.toFixed(2)} ${(doc.H - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re W n`),
    unclip: () => doc.op("Q"),
    w: (s, size, bold) => textW(s, size, bold),
  };
}
function canvasPainter(g) {
  return {
    rect: (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(x, y, w, h); },
    line: (x1, y1, x2, y2, c = "#c4c7c1", w = 0.5, dash = null) => { g.strokeStyle = c; g.lineWidth = w; g.setLineDash(dash || []); g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); g.setLineDash([]); },
    poly: (pts, c) => { g.fillStyle = c; g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill(); },
    text: (x, y, s, size, o = {}) => { g.font = `${o.bold ? "bold " : ""}${size}px Helvetica, Arial, sans-serif`; g.fillStyle = o.color || "#1b1e1c"; g.textBaseline = "middle"; g.textAlign = o.align || "left"; g.fillText(s, x, y); g.textAlign = "left"; },
    clip: (x, y, w, h) => { g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip(); }, unclip: () => g.restore(),
    w: (s, size, bold) => { g.font = `${bold ? "bold " : ""}${size}px Helvetica, Arial, sans-serif`; return g.measureText(s).width; },
  };
}
const fit = (p, s, size, w, bold) => { if (p.w(s, size, bold) <= w) return s; while (s.length > 1 && p.w(s + "…", size, bold) > w) s = s.slice(0, -1); return s + "…"; };

// layout comune
function layout(E, o) {
  const P = E.S.P;
  const client = o.kind === "client";
  let rows = (o.rows || E.ganttState().rows).filter(x => !x.isNull);
  if (client) rows = P.tasks.filter(x => !x.isNull && x.act !== false && x.lvl <= o.levels && (x.sum || isMilestone(x) || x.lvl <= o.levels));
  const rh = client ? 20 : 13, fs = client ? 9.5 : 7;
  const cols = client ? [["name", 230], ["start", 70], ["finish", 70]] : [["id", 24], ["name", 190], ["dur", 52], ["start", 58], ["finish", 58], ...(o.preds ? [["preds", 60]] : []), ...(o.res ? [["res", 90]] : [])];
  const tableW = cols.reduce((n, c) => n + c[1], 0);
  let a = P.start, b = P.finish;
  for (const x of rows) { a = Math.min(a, x.start); b = Math.max(b, x.finish); }
  const d0 = dayOf(a) - ((weekday(dayOf(a)) + 6) % 7) - (client ? 0 : 7);
  const T0 = d0 * DAY, T1 = (dayOf(b) + (client ? 10 : 14)) * DAY;
  const fname = (E.ctx?.tab?.name || "").replace(/\.[^.]+$/, "");
  return { P, rows, client, rh, fs, cols, tableW, T0, T1, fname };
}
function cellText(P, x, c) {
  switch (c) {
    case "id": return String(x.id);
    case "name": return x.name;
    case "dur": return durText(P, x);
    case "start": return fdd(x.start);
    case "finish": return fdd(x.finish);
    case "preds": return predsText(P, x, unitLabels());
    case "res": return (x.resNames || []).join(", ");
  }
  return "";
}

// una pagina: intestazione, tabella, scala, barre (righe r0..r1, tempo t0..t1)
function drawPage(p, Lyt, o, { W, H, r0, r1, t0, t1, page, pages, ppd }) {
  const { P, rows, client, rh, fs, cols, tableW } = Lyt;
  const M = 24, top = client ? 70 : 48, headH = 26, foot = 22;
  const chartX = M + tableW, chartW = W - M - chartX;
  const X = m => chartX + ((m - t0) / DAY) * ppd;
  // titolo
  p.text(M, M + 6, o.title || P.name || Lyt.fname || L("progetto"), client ? 18 : 12, { bold: true });
  p.text(W - M, M + 6, `${L("aggiornato_al")} ${fdd(o.status ?? nowMin())}`, client ? 9 : 7.5, { align: "right", color: "#555555" });
  if (client) p.text(M, M + 28, `${fdd(P.start)} – ${fdd(P.finish)}`, 10, { color: "#555555" });
  // intestazione tabella
  const hy = top;
  p.rect(M, hy, W - 2 * M, headH, "#eef0f2");
  let x = M;
  for (const [c, w] of cols) { p.text(x + 3, hy + headH / 2, fit(p, colName(c), fs, w - 6, true), fs, { bold: true }); x += w; p.line(x, hy, x, H - M - foot, "#d5d8dc", 0.4); }
  // scala del tempo (due livelli)
  const days = (t1 - t0) / DAY;
  const tiersHigh = [], tiersLow = [];
  if (ppd >= 9) for (let d = dayOf(t0); d < dayOf(t1); d++) { tiersLow.push([d * DAY, String(new Date(d * DAY * 60000).getUTCDate())]); if (weekday(d) === 1 || d === dayOf(t0)) tiersHigh.push([d * DAY, fdm(d * DAY)]); }
  else if (ppd >= 1.6) { for (let d = dayOf(t0); d < dayOf(t1); d++) if (weekday(d) === 1) tiersLow.push([d * DAY, String(new Date(d * DAY * 60000).getUTCDate())]); monthTicks(t0, t1, tiersHigh, true); }
  else { monthTicks(t0, t1, tiersLow, false); for (const [m] of tiersLow) if (ymd(m)[1] === 1 || m === tiersLow[0][0]) tiersHigh.push([m, String(ymd(m)[0])]); }
  p.clip(chartX, hy, chartW, H - hy);
  let lastEnd = -1e9;
  for (const [m, s] of tiersHigh) {
    const xx = X(m);
    if (xx < chartX - 200 || xx > W) continue;
    p.line(xx, hy, xx, hy + headH / 2, "#b9bec4", 0.4);
    const tx = Math.max(xx, chartX) + 2;
    if (tx < lastEnd + 4) continue; // etichette che si sovrapporrebbero
    p.text(tx, hy + headH / 4, s, fs);
    lastEnd = tx + p.w(s, fs);
  }
  const lowW = tiersLow.length > 1 ? (tiersLow[1][0] - tiersLow[0][0]) / DAY * ppd : 20;
  for (const [m, s] of tiersLow) { const xx = X(m); if (xx < chartX - 50 || xx > W) continue; p.line(xx, hy + headH / 2, xx, H - M - foot, "#e3e6e9", 0.3); if (lowW > fs * 1.6) p.text(xx + 1.5, hy + headH * 3 / 4, s, fs * 0.9, { color: "#555555" }); }
  p.line(chartX, hy + headH / 2, W - M, hy + headH / 2, "#b9bec4", 0.4);
  p.unclip();
  // giorni non lavorativi
  const yA = hy + headH, yB = yA + (r1 - r0) * rh;
  p.clip(chartX, yA, chartW, yB - yA);
  if (ppd >= 4) for (let d = dayOf(t0); d < dayOf(t1); d++) { const wd = weekday(d); if (wd === 0 || wd === 6) p.rect(X(d * DAY), yA, ppd, yB - yA, "#f3f4f5"); }
  const today = o.status ?? nowMin();
  if (today >= t0 && today <= t1) p.line(X(today), yA, X(today), yB, "#ea7426", 0.8, [3, 2]);
  p.unclip();
  // righe
  const phase = new Map();
  let k = 0;
  for (const x of P.tasks) if (x.lvl === 1) phase.set(x.uid, PAL[k++ % PAL.length]);
  const colorOf = x => { let r = x; while (r.parent) r = r.parent; return phase.get(r.uid) || PAL[0]; };
  for (let i = r0; i < r1; i++) {
    const tk = rows[i];
    const y = yA + (i - r0) * rh;
    if ((i - r0) % 2 === 1 && client) p.rect(M, y, W - 2 * M, rh, "#f7f8f9");
    p.line(M, y + rh, W - M, y + rh, "#eceef0", 0.3);
    let cx = M;
    for (const [c, w] of cols) {
      const ind = c === "name" ? (tk.lvl - 1) * (client ? 10 : 7) : 0;
      const s = cellText(P, tk, c);
      p.text(cx + 3 + ind, y + rh / 2, fit(p, s, fs, w - 6 - ind, tk.sum), fs, { bold: tk.sum, align: "left" });
      cx += w;
    }
    // barra
    p.clip(chartX, yA, chartW, yB - yA);
    const x1 = X(tk.start), x2 = X(tk.finish), cy = y + rh / 2;
    const base = o.base && tk.bl?.[0]?.start != null;
    if (base) { const b = tk.bl[0]; p.rect(X(b.start), cy + rh * 0.14, Math.max(1, X(b.finish) - X(b.start)), rh * 0.16, "#9aa3ab"); }
    if (tk.sum) {
      const col = client ? colorOf(tk) : "#2b2f33";
      const hh = client ? rh * 0.42 : rh * 0.3, yy = cy - hh / 2 - (base ? rh * 0.1 : 0);
      p.rect(x1, yy, Math.max(1, x2 - x1), hh, col);
      if (!client) { p.poly([[x1, yy], [x1 + 4, yy], [x1, yy + hh + 3]], col); p.poly([[x2, yy], [x2 - 4, yy], [x2, yy + hh + 3]], col); }
      if (client && tk.pct > 0) p.rect(x1, yy + hh - 2.2, Math.max(1, (x2 - x1) * tk.pct / 100), 2.2, "#1d2a38");
    } else if (isMilestone(tk)) {
      const r = rh * 0.33;
      p.poly([[x1, cy - r], [x1 + r, cy], [x1, cy + r], [x1 - r, cy]], client ? "#1d2a38" : o.crit && tk.crit ? "#c43c3c" : "#1b1e1c");
      p.text(x1 + r + 3, cy, (client ? tk.name + " · " : "") + fdm(tk.start), fs * 0.95, { color: "#333333" });
    } else {
      const hh = client ? rh * 0.42 : rh * 0.46, yy = cy - hh / 2 - (base ? rh * 0.1 : 0);
      const col = client ? colorOf(tk) : o.crit && tk.crit ? "#d64545" : tk.color || "#4a8ad4";
      p.rect(x1, yy, Math.max(1, x2 - x1), hh, col);
      if (tk.pct > 0) p.rect(x1, yy + hh / 2 - 1, Math.max(0.5, (x2 - x1) * Math.min(100, tk.pct) / 100), 2, client ? "#1d2a38" : "#1d3f6e");
      if (!client && o.res && tk.resNames?.length) p.text(x2 + 3, cy, tk.resNames.join(", "), fs * 0.9, { color: "#444444" });
    }
    p.unclip();
  }
  // collegamenti (solo nel Gantt completo)
  if (!client && o.links) {
    const pos = new Map(rows.map((x, i) => [x.uid, i]));
    p.clip(chartX, yA, chartW, yB - yA);
    for (let i = r0; i < r1; i++) for (const Lk of rows[i].preds || []) {
      const j = pos.get(Lk.u);
      if (j == null) continue;
      const pr = rows[j], tk = rows[i];
      const xa = X(Lk.t === 0 || Lk.t === 1 ? pr.finish : pr.start), ya = yA + (j - r0) * rh + rh / 2;
      const xb = X(Lk.t === 0 || Lk.t === 2 ? tk.finish : tk.start), yb = yA + (i - r0) * rh + rh / 2;
      const c = o.crit && pr.crit && tk.crit ? "#c43c3c" : "#7a828a";
      if (Lk.t === 1 && xb >= xa + 3) { p.line(xa, ya, xb, ya, c, 0.4); p.line(xb, ya, xb, yb - rh * 0.3, c, 0.4); p.poly([[xb - 2, yb - rh * 0.3 - 3], [xb + 2, yb - rh * 0.3 - 3], [xb, yb - rh * 0.3]], c); }
      else { p.line(xa, ya, xa + 3, ya, c, 0.4); p.line(xa + 3, ya, xa + 3, yb, c, 0.4); p.line(xa + 3, yb, xb, yb, c, 0.4); }
    }
    p.unclip();
  }
  p.line(chartX, hy, chartX, yB, "#9aa1a8", 0.6);
  // piede
  p.text(M, H - M - foot / 2 + 6, `${o.title || P.name || Lyt.fname || ""}  ·  ${L("fine_progetto")} ${fdd(P.finish)}`, 7, { color: "#666666" });
  p.text(W - M, H - M - foot / 2 + 6, `${page} / ${pages}`, 7, { align: "right", color: "#666666" });
  if (page === pages) legend(p, Lyt, o, M + 260, H - M - foot / 2 + 6);
}
function legend(p, Lyt, o, x, y) {
  const items = Lyt.client ? [[L("fase"), "#3f7cc4", "bar"], [L("cardine"), "#1d2a38", "ms"], [L("avanzamento"), "#1d2a38", "pct"]]
    : [[L("attivita"), "#4a8ad4", "bar"], ...(o.crit ? [[L("critica"), "#d64545", "bar"]] : []), [L("riepilogo"), "#2b2f33", "bar"], [L("cardine"), "#1b1e1c", "ms"], ...(o.base ? [[L("linea_base"), "#9aa3ab", "base"]] : [])];
  for (const [n, c, k] of items) {
    if (k === "ms") p.poly([[x + 4, y - 4], [x + 8, y], [x + 4, y + 4], [x, y]], c);
    else if (k === "base" || k === "pct") p.rect(x, y - 1, 12, 2.5, c);
    else p.rect(x, y - 3, 12, 6, c);
    p.text(x + 16, y, n, 7, { color: "#444444" });
    x += 26 + p.w(n, 7);
  }
}
function monthTicks(a, b, out, short) {
  let [y, m] = ymd(a);
  for (; fromParts(y, m, 1) < b; m++) { if (m > 12) { m = 1; y++; } const t0 = fromParts(y, m, 1); out.push([t0 < a ? a : t0, short ? fmon(t0) : fmons(t0)]); }
}
const nowMin = () => { const d = new Date(); return fromParts(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()); };
const colName = c => ({ id: "ID", name: L("c_nome"), dur: L("c_durata"), start: L("c_inizio"), finish: L("c_fine"), preds: L("c_predecessori"), res: L("c_risorse") }[c]);

// impaginazione: quante pagine in altezza e in larghezza
function paginate(Lyt, o, W, H) {
  const M = 24, top = Lyt.client ? 70 : 48, headH = 26, foot = 22;
  const perPage = Math.max(1, Math.floor((H - top - headH - M - foot - 4) / Lyt.rh));
  const chartW = W - 2 * M - Lyt.tableW;
  const days = (Lyt.T1 - Lyt.T0) / DAY;
  let ppd, wide;
  if (o.fitWidth) { ppd = chartW / days; wide = 1; }
  else { ppd = o.ppd || 6; wide = Math.max(1, Math.ceil(days * ppd / chartW)); }
  const vpages = Math.max(1, Math.ceil(Lyt.rows.length / perPage));
  const out = [];
  for (let v = 0; v < vpages; v++) for (let h = 0; h < wide; h++) {
    const t0 = Lyt.T0 + h * (chartW / ppd) * DAY;
    out.push({ r0: v * perPage, r1: Math.min(Lyt.rows.length, (v + 1) * perPage), t0, t1: Math.min(Lyt.T1, t0 + (chartW / ppd) * DAY), ppd });
  }
  return out;
}

export async function ganttPdf(E, o) {
  const Lyt = layout(E, o);
  const [W, H] = PAPER[o.paper] || PAPER.A3;
  const doc = new PdfDoc();
  doc.W = W; doc.H = H;
  doc.title = o.title || Lyt.P.name || L("progetto");
  const p = pdfPainter(doc);
  const pages = paginate(Lyt, o, W, H);
  pages.forEach((pg, i) => { doc.addPage(); drawPage(p, Lyt, o, { W, H, ...pg, page: i + 1, pages: pages.length }); });
  return { blob: await doc.build(), pages: pages.length };
}
export async function ganttPng(E, o) {
  const Lyt = layout(E, o);
  const days = (Lyt.T1 - Lyt.T0) / DAY;
  const ppd = o.ppd || 6;
  let W = 48 + Lyt.tableW + days * ppd, H = 48 + 26 + 70 + Lyt.rows.length * Lyt.rh + 30;
  const scale = Math.min(2, 15000 / W, 15000 / H);
  const c = document.createElement("canvas");
  c.width = Math.round(W * scale); c.height = Math.round(H * scale);
  const g = c.getContext("2d");
  g.scale(scale, scale);
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, W, H);
  drawPage(canvasPainter(g), Lyt, o, { W, H, r0: 0, r1: Lyt.rows.length, t0: Lyt.T0, t1: Lyt.T1, page: 1, pages: 1, ppd });
  return await new Promise(r => c.toBlob(r, "image/png"));
}
export async function excel(E) {
  const P = E.S.P;
  const lab = unitLabels();
  const tasks = [[ "ID", L("c_wbs"), L("c_nome"), L("c_livello"), L("c_durata"), L("c_inizio"), L("c_fine"), L("c_predecessori"), L("c_risorse"), L("c_pct"), L("c_lavoro") + " (h)", L("c_costo"), L("c_margine") + " (" + lab.d + ")", L("critica"), L("c_bl_inizio"), L("c_bl_fine"), L("note")]];
  const d = m => (m == null ? "" : new Date(m * 60000).toISOString().slice(0, 16).replace("T", " "));
  for (const x of P.tasks) if (!x.isNull) tasks.push([x.id, x.wbs || x.on, "  ".repeat(x.lvl - 1) + x.name, x.lvl, durText(P, x), d(x.start), d(x.finish), predsText(P, x, lab), (x.resNames || []).join("; "), Math.round(x.pct || 0), Math.round((x.work || 0) / 6) / 10, Math.round((x.cost || 0) * 100) / 100, Math.round(Math.max(0, x.ts || 0) / P.mpd * 100) / 100, x.crit ? "✓" : "", d(x.bl?.[0]?.start), d(x.bl?.[0]?.finish), x.notes || ""]);
  const res = [[L("c_nome"), L("tipo"), L("iniziali"), L("gruppo"), L("unita_max"), L("tariffa_std"), L("costo_uso"), L("c_lavoro") + " (h)", L("c_costo")]];
  for (const r of P.resources) res.push([r.name, L("r_" + r.type), r.ini || "", r.group || "", r.type === "work" ? Math.round((r.max ?? 1) * 100) + "%" : "", r.rate || 0, r.use || 0, Math.round((r.work || 0) / 6) / 10, Math.round((r.cost || 0) * 100) / 100]);
  const asg = [[L("attivita"), L("risorsa"), L("unita"), L("c_lavoro") + " (h)"]];
  for (const a of P.assignments) { const x = P.tasks.find(y => y.uid === a.task), r = P.resources.find(y => y.uid === a.res); if (x && r) asg.push([x.name, r.name, r.type === "material" ? a.units : Math.round((a.units ?? 1) * 100) + "%", r.type === "work" ? Math.round((a.w ?? (a.units ?? 1) * x.dur) / 6) / 10 : ""]); }
  return saveXlsx(null, [{ name: L("t_attivita"), rows: tasks, widths: [6, 8, 44, 6, 10, 17, 17, 14, 24, 7, 10, 12, 10, 6, 17, 17, 40] }, { name: L("t_risorse"), rows: res, widths: [28, 12, 8, 14, 10, 10, 10, 10, 12] }, { name: L("assegnazioni"), rows: asg, widths: [40, 28, 10, 10] }]);
}

// finestra delle esportazioni
export async function exportDialog(E, kind) {
  const P = E.S.P;
  const st = E.ganttState();
  const base = (P.name || E.ctx.tab?.name || "progetto").replace(/\.[^.]+$/, "");
  if (kind === "xlsx") { const b = await excel(E); return saveBlobAs(base + ".xlsx", b); }
  const paper = el("select", {}, ...Object.keys(PAPER).map(k => el("option", { value: k, selected: k === (kind === "client" ? "A4" : "A3") }, k + " " + L("orizzontale"))));
  const fitW = el("input", { type: "checkbox", checked: kind === "client" });
  const levels = el("select", {}, ...[1, 2, 3, 4].map(n => el("option", { value: n, selected: n === 2 }, String(n))));
  const title = el("input", { value: P.name || base });
  const links = el("input", { type: "checkbox", checked: true }), res = el("input", { type: "checkbox", checked: true }), preds = el("input", { type: "checkbox" }), basel = el("input", { type: "checkbox", checked: st.base }), crit = el("input", { type: "checkbox", checked: st.crit });
  const f = (l, i) => el("label", { class: "pj-f" }, el("span", {}, l), i);
  const c = (l, i) => el("label", {}, i, " ", l);
  const body = el("div", { class: "pj-form" }, f(L("titolo"), title), kind !== "png" ? f(L("formato_carta"), paper) : null, kind === "client" ? f(L("livelli_struttura"), levels) : null,
    el("div", { class: "pj-checks wide" }, kind !== "png" ? c(L("adatta_larghezza"), fitW) : null, kind !== "client" ? c(L("collegamenti"), links) : null, kind !== "client" ? c(L("c_risorse"), res) : null, kind !== "client" ? c(L("c_predecessori"), preds) : null, c(L("linea_base"), basel), kind !== "client" ? c(L("percorso_critico"), crit) : null),
    el("p", { class: "pj-note wide" }, kind === "client" ? L("nota_cliente") : kind === "png" ? L("nota_png") : L("nota_pdf")));
  const ttl = { pdf: L("esporta_pdf"), client: L("gantt_cliente"), png: L("immagine") }[kind];
  const ok = await modal(ttl, body, [{ label: t("common.annulla"), value: false }, { label: t("common.salva"), value: true, primary: true }]);
  if (!ok) return;
  const o = { kind, paper: paper.value, fitWidth: fitW.checked, levels: +levels.value, title: title.value, links: links.checked, res: res.checked, preds: preds.checked, base: basel.checked, crit: crit.checked, status: P.status, ppd: Math.max(1, st.zoom * 0.75), rows: kind === "client" ? null : st.rows };
  try {
    if (kind === "png") { const b = await ganttPng(E, o); return saveBlobAs(base + ".png", b); }
    const { blob, pages } = await ganttPdf(E, o);
    const path = await saveBlobAs(base + (kind === "client" ? " - " + L("cliente") : "") + ".pdf", blob);
    if (path) toast(t("proj.pdf_pagine", pages));
  } catch (e) { toast(e.message, true); }
}
export { hours, money };
