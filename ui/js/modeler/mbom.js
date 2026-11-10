// Distinta materiali del modello: tubazioni, canaline e condotte per tipo e misura (tratti, lunghezze dritte, curve con gli
// angoli, lunghezza sull'asse, peso) + gli altri corpi con volume e peso. Esportazione CSV (;) ed Excel.
import { dirName, el, loadScript, modal, saveBlobAs, toast } from "../core.js";
import { LOCALE, t as tr } from "../i18n.js";
import { bom, bomTable, fittingName } from "./mplant.js";
import { ICON } from "./micons.js";
import { ACCENT } from "./mview.js";
import { closestOnAxis } from "./mdrag.js";

// ------------------------------------------------------------------------------------------------- componenti in linea
// clic sulla tubazione: il componente va nel punto della linea d'asse sotto il mouse (lo ricalcola il motore anche dopo
// le modifiche del percorso)
export class FittingTool {
  constructor(app, route, kind) { this.app = app; this.route = route; this.kind = kind; }
  start() {
    const r = this.app.right;
    r.innerHTML = "";
    r.append(el("div", { class: "md-dhead" }, el("span", { class: "md-dico", html: ICON.valve }), el("b", {}, fittingName(this.kind))),
      el("p", { class: "md-hint" }, tr("mod.pl_componente_aiuto")),
      el("div", { class: "md-dfoot" }, el("button", { class: "btn", type: "button", onclick: () => this.app.cancelTool() }, tr("common.annulla"))));
  }
  stop() { this.cur = null; this.app.view.redraw(); }
  nodes() { return (this.app.res?.bodies || []).find(b => b.id === this.route)?.meta?.nodi || []; }
  at(e) {
    const v = this.app.view, N = this.nodes(), ray = v.ray(e).ray;
    let best = null;
    for (let i = 0; i + 1 < N.length; i++) {
      const a = N[i], d = N[i + 1].map((x, k) => x - a[k]), L = Math.hypot(...d);
      if (L < 1e-9) continue;
      const u = d.map(x => x / L);
      const t = Math.max(0, Math.min(L, closestOnAxis(ray, a, u)));
      const p = a.map((x, k) => x + u[k] * t), s = v.toScreen(p), [mx, my] = v.local(e);
      const dist = Math.hypot(s[0] - mx, s[1] - my);
      if (!best || dist < best.dist) best = { p, dist };
    }
    return best && best.dist < 60 ? best.p : null;
  }
  move(e) { this.cur = this.at(e); this.app.view.redraw(); }
  click(e) {
    const p = this.at(e);
    if (!p) return toast(tr("mod.pl_clic_tubazione"), true);
    this.app.commitFeature({ type: "fitting", route: this.route, kind: this.kind, at: p.map(x => Math.round(x * 1000) / 1000) });
  }
  paint(g) {
    if (!this.cur) return;
    const s = this.app.view.toScreen(this.cur);
    g.strokeStyle = ACCENT; g.lineWidth = 2.5;
    g.beginPath(); g.arc(s[0], s[1], 9, 0, 7); g.stroke();
    g.beginPath(); g.moveTo(s[0] - 14, s[1]); g.lineTo(s[0] + 14, s[1]); g.moveTo(s[0], s[1] - 14); g.lineTo(s[0], s[1] + 14); g.stroke();
  }
}

// ------------------------------------------------------------------------------------------------- interferenze
export class ClashTool {
  constructor(app) { this.app = app; this.res = null; this.tol = 1; }
  start() { this.render(); this.run(); }
  stop() { this.app.view.selection = []; this.app.view.redraw(); }
  async run() {
    this.busy = true; this.render();
    try {
      const { compile } = await import("./mdoc.js");
      const { clash } = await import("./mkernel.js");
      this.res = await clash(this.app.sid, compile(this.app.doc).cdoc, this.tol);
    } catch (e) { toast(e.message, true); }
    this.busy = false; this.render(); this.app.view.redraw();
  }
  render() {
    const r = this.app.right, app = this.app;
    r.innerHTML = "";
    const tolIn = el("input", { class: "field", type: "text", value: String(this.tol) });
    tolIn.addEventListener("change", () => { const v = parseFloat(tolIn.value.replace(",", ".")); if (v >= 0) { this.tol = v; this.run(); } });
    r.append(el("div", { class: "md-dhead" }, el("span", { class: "md-dico", html: ICON.clash }), el("b", {}, tr("mod.pl_interferenze"))),
      el("div", { class: "md-frow" }, el("label", {}, tr("mod.pl_tolleranza_vol")), tolIn, el("span", { class: "md-unit" }, "mm³")));
    if (this.busy) r.append(el("p", { class: "md-hint" }, tr("mod.ricalcolo")));
    else if (this.res) {
      const list = this.res.clash;
      r.append(el("p", { class: "md-dof" + (list.length ? " bad" : " ok") }, list.length ? tr("mod.pl_n_interferenze", list.length) : tr("mod.pl_nessuna_interferenza", this.res.n)));
      const box = el("div", { class: "md-list" });
      r.append(box);
      list.forEach((c, i) => {
        const row = el("button", { class: "md-pick", type: "button", onclick: () => this.show(c, row) },
          el("span", { class: "md-pick-l" }, `${i + 1}. ${app.bodyName(c.a)} · ${app.bodyName(c.b)}`), el("span", { class: "md-pick-n" }, num(Math.round(c.vol)) + " mm³"));
        box.append(row);
      });
    }
    r.append(el("div", { class: "md-dfoot" }, el("button", { class: "btn", type: "button", onclick: () => this.run() }, tr("mod.pl_ricontrolla")),
      el("button", { class: "btn", type: "button", onclick: () => app.cancelTool() }, tr("common.chiudi"))));
  }
  show(c, row) {
    for (const b of this.app.right.querySelectorAll(".md-pick")) b.classList.toggle("on", b === row);
    this.cur = c;
    const v = this.app.view;
    v.selection = [{ kind: "body", body: c.a }, { kind: "body", body: c.b }];
    const B = v.bbox().constructor, Vc = v.bbox().min.constructor;
    const bb = [c.a, c.b].map(id => v.bodies.get(id)?.data.bbox).filter(Boolean);
    const size = Math.max(...bb.map(q => Math.hypot(q[3] - q[0], q[4] - q[1], q[5] - q[2])), 100) * 0.6;
    v.fit(null, new B().setFromCenterAndSize(new Vc(...c.c), new Vc(size, size, size)));
    v.redraw();
  }
  paint(g) {
    const v = this.app.view;
    for (const c of this.res?.clash || []) {
      const s = v.toScreen(c.c), on = c === this.cur;
      g.fillStyle = on ? "#d93025" : "rgba(217,48,37,.75)";
      g.beginPath(); g.arc(s[0], s[1], on ? 8 : 6, 0, 7); g.fill();
      g.strokeStyle = "#fff"; g.lineWidth = 1.5; g.stroke();
    }
  }
}

const num = v => (typeof v === "number" ? v.toLocaleString(LOCALE, { maximumFractionDigits: 3 }) : v);

export async function showBom(app) {
  const T = bomTable(bom(app));
  const table = (head, rows) => el("table", { class: "md-bom" },
    el("thead", {}, el("tr", {}, ...head.map(h => el("th", {}, h)))),
    el("tbody", {}, ...rows.map(r => el("tr", {}, ...r.map(c => el("td", { class: typeof c === "number" ? "n" : "" }, num(c)))))));
  const box = el("div", { class: "md-bombox" });
  if (T.rows.length) box.append(el("h4", {}, tr("mod.pl_impianti")), table(T.head, T.rows));
  if (T.rows2.length) box.append(el("h4", {}, tr("mod.corpi")), table(T.head2, T.rows2));
  if (!T.rows.length && !T.rows2.length) box.append(el("p", {}, tr("mod.nessun_corpo")));
  const v = await modal(tr("mod.pl_distinta"), box, [{ label: "CSV", value: "csv" }, { label: "Excel", value: "xlsx" }, { label: tr("common.chiudi"), value: null, primary: true }]);
  if (!v) return;
  const base = (app.ctx.name || "modello").replace(/\.[^.]+$/, "") + " - " + tr("mod.pl_distinta").toLowerCase();
  const dir = app.path ? dirName(app.path) : "";
  try {
    if (v === "csv") {
      const esc = c => (typeof c === "number" ? String(c).replace(".", ",") : `"${String(c).replace(/"/g, '""')}"`);
      const lines = [T.head, ...T.rows, [], T.head2, ...T.rows2].map(r => r.map(esc).join(";"));
      await saveBlobAs(base + ".csv", new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv" }), dir);
    } else {
      await loadScript("/vendor/xlsx/dist/xlsx.full.min.js");
      const X = window.XLSX, wb = X.utils.book_new();
      X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([T.head, ...T.rows]), tr("mod.pl_impianti").slice(0, 31));
      X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([T.head2, ...T.rows2]), tr("mod.corpi").slice(0, 31));
      const out = X.write(wb, { type: "array", bookType: "xlsx" });
      await saveBlobAs(base + ".xlsx", new Blob([out]), dir);
    }
  } catch (e) { toast(e.message, true); }
}
