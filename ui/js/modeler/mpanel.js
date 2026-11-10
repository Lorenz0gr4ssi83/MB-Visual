// Pannelli del modellatore: albero delle lavorazioni (cronologia modificabile: modifica, rinomina, sospendi, sposta,
// ferma qui, elimina), corpi (nome, colore, visibilita'), parametri (nome = espressione, usati nelle quote e nei campi),
// proprieta' della selezione e pannello dello schizzo (gradi di liberta', vincoli, quote modificabili).
import { el, toast } from "../core.js";
import { fmtNum, t as tr } from "../i18n.js";
import { evalExpr, validName } from "./mexpr.js";
import { isDim, measureDim, solve } from "./msolver.js";
import { ICON } from "./micons.js";
import { fittingName, kindName, sizeLabel, sizes, specOf } from "./mplant.js";

const fmt = (v, d = 3) => fmtNum(Math.round(v * 10 ** d) / 10 ** d, d);
export const FEAT_ICON = { sketch: "sketch", extrude: "extrude", revolve: "revolve", primitive: "box", hole: "hole", fillet: "fillet", chamfer: "chamfer",
  shell: "shell", pushpull: "pushpull", delface: "delface", boolean: "union", transform: "move", pattern: "pattern", delbody: "trash", mate: "mate", import: "import", split: "split", route: "route", fitting: "valve", supports: "support" };

export function featLabel(f, n) {
  if (!f.name && f.type === "fitting") return fittingName(f.kind) + (n ? " · " + n : "");
  if (!f.name && f.type === "supports") return tr("mod.pl_support_" + f.kind) + (n ? " · " + n : "");
  if (!f.name && f.type === "route") return kindName(f.kind) + " " + (f.size || "") + (n ? " · " + n : "");
  return f.name || tr("mod.f_" + f.type) + " " + n;
}

export class Panel {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.open = { tree: true, bodies: true, params: false };
  }

  render() {
    const app = this.app, h = this.host;
    h.innerHTML = "";
    h.append(this.section("tree", tr("mod.cronologia"), this.tree()), this.section("bodies", tr("mod.corpi") + ` (${app.bodyList().length})`, this.bodies()), this.section("params", tr("mod.parametri") + (app.doc.params.length ? ` (${app.doc.params.length})` : ""), this.params()));
  }

  section(k, title, content) {
    const box = el("div", { class: "md-sec" + (this.open[k] ? " open" : "") });
    const head = el("button", { class: "md-sech", type: "button", onclick: () => { this.open[k] = !this.open[k]; this.render(); } }, el("span", { class: "md-tw" }, this.open[k] ? "▾" : "▸"), title);
    box.append(head);
    if (this.open[k]) box.append(content);
    return box;
  }

  // ---- cronologia
  tree() {
    const app = this.app, doc = app.doc;
    const list = el("div", { class: "md-tree" });
    const end = doc.end ?? doc.features.length;
    const count = {};
    doc.features.forEach((f, i) => {
      count[f.type] = (count[f.type] || 0) + 1;
      const st = app.status(f.id);
      const rolled = i >= end;
      const row = el("div", { class: "md-node" + (app.selFeature === f.id ? " sel" : "") + (f.off ? " off" : "") + (rolled ? " rolled" : "") + (st && !st.ok ? " bad" : ""), title: st && !st.ok ? app.errText(st) : "", tabindex: "0" });
      row.append(el("span", { class: "md-nico", html: ICON[FEAT_ICON[f.type]] || "" }), el("span", { class: "md-nname" }, featLabel(f, count[f.type])));
      if (st && !st.ok) row.append(el("span", { class: "md-nwarn", html: ICON.warn }));
      if (f.type === "sketch") row.append(el("button", { class: "md-mini", type: "button", title: f.hidden ? tr("mod.mostra") : tr("mod.nascondi"), html: f.hidden ? ICON.eyeoff : ICON.eye, onclick: e => { e.stopPropagation(); f.hidden = !f.hidden; app.commit(f.hidden ? tr("mod.nascondi") : tr("mod.mostra"), { regen: false }); app.showSketches(); this.render(); } }));
      row.addEventListener("click", () => { app.selFeature = f.id; this.render(); });
      row.addEventListener("dblclick", () => app.editFeature(f.id));
      row.addEventListener("contextmenu", e => { e.preventDefault(); app.selFeature = f.id; this.render(); this.menu(e, f, i); });
      row.addEventListener("keydown", e => { if (e.key === "Delete") app.deleteFeature(f.id); if (e.key === "Enter" || e.key === "F2") app.editFeature(f.id); });
      list.append(row);
      if (i === end - 1 && end < doc.features.length) list.append(el("div", { class: "md-end", title: tr("mod.fine_cronologia") }, tr("mod.fine_cronologia")));
    });
    if (!doc.features.length) list.append(el("p", { class: "md-hint" }, tr("mod.cronologia_vuota")));
    const sel = doc.features.find(f => f.id === app.selFeature);
    if (sel) {
      const i = doc.features.indexOf(sel);
      const bar = el("div", { class: "md-tbar" },
        this.mini("edit", tr("mod.modifica"), () => app.editFeature(sel.id)),
        this.mini(sel.off ? "play" : "pause", sel.off ? tr("mod.riattiva") : tr("mod.sospendi"), () => app.toggleFeature(sel.id)),
        this.mini("up", tr("mod.sposta_su"), () => app.moveFeature(sel.id, -1), i === 0),
        this.mini("down", tr("mod.sposta_giu"), () => app.moveFeature(sel.id, 1), i === doc.features.length - 1),
        this.mini("rollback", tr("mod.ferma_qui"), () => app.setEnd(doc.end === i + 1 ? null : i + 1)),
        this.mini("trash", tr("mod.elimina"), () => app.deleteFeature(sel.id)));
      list.append(bar);
    }
    return list;
  }

  mini(icon, title, fn, disabled = false) { return el("button", { class: "md-mini", type: "button", title, html: ICON[icon], disabled, onclick: fn }); }

  menu(e, f, i) {
    const app = this.app;
    const items = [
      [tr("mod.modifica"), () => app.editFeature(f.id)],
      [tr("mod.rinomina"), () => this.rename(f)],
      [f.off ? tr("mod.riattiva") : tr("mod.sospendi"), () => app.toggleFeature(f.id)],
      [tr("mod.ferma_qui"), () => app.setEnd(i + 1)],
      [tr("mod.vai_alla_fine"), () => app.setEnd(null)],
      [tr("mod.elimina"), () => app.deleteFeature(f.id)],
    ];
    const m = el("div", { class: "menu md-menu", role: "menu" });
    for (const [l, fn] of items) m.append(el("button", { type: "button", onclick: () => { m.remove(); fn(); } }, l));
    document.body.append(m);
    const r = m.getBoundingClientRect();
    Object.assign(m.style, { position: "fixed", left: Math.min(e.clientX, innerWidth - r.width - 8) + "px", top: Math.min(e.clientY, innerHeight - r.height - 8) + "px", zIndex: 1000 });
    const close = ev => { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener("pointerdown", close, true); } };
    setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
  }

  async rename(f) {
    const { askText } = await import("../core.js");
    const n = await askText(tr("mod.rinomina"), tr("common.nome"), f.name || "");
    if (n === null || n === undefined) return;
    f.name = n.trim() || undefined;
    this.app.commit(tr("mod.rinomina"), { regen: false });
    this.render();
  }

  // ---- corpi
  bodies() {
    const app = this.app;
    const box = el("div", { class: "md-bodies" });
    for (const b of app.bodyList()) {
      const lk = app.doc.looks[b.id] || {};
      const col = el("input", { type: "color", value: lk.color || "#b8bcc0", title: tr("common.colore") });
      col.addEventListener("change", () => { app.look(b.id, { color: col.value }); });
      const row = el("div", { class: "md-node" + (app.view.selection.some(s => s.kind === "body" && s.body === b.id) ? " sel" : "") },
        el("button", { class: "md-mini", type: "button", title: lk.hidden ? tr("mod.mostra") : tr("mod.nascondi"), html: lk.hidden ? ICON.eyeoff : ICON.eye, onclick: () => app.look(b.id, { hidden: !lk.hidden }) }),
        col, el("span", { class: "md-nname", title: b.id }, b.name), b.kind === "mesh" ? el("span", { class: "md-tag" }, "mesh") : null);
      row.addEventListener("click", e => { if (e.target === col || e.target.closest("button")) return; app.selectBody(b.id, e.ctrlKey || e.shiftKey); });
      row.addEventListener("dblclick", async e => {
        if (e.target === col) return;
        const { askText } = await import("../core.js");
        const n = await askText(tr("mod.rinomina"), tr("common.nome"), b.name);
        if (n) app.look(b.id, { name: n.trim() });
      });
      box.append(row);
    }
    if (!app.bodyList().length) box.append(el("p", { class: "md-hint" }, tr("mod.nessun_corpo")));
    return box;
  }

  // ---- parametri
  params() {
    const app = this.app, doc = app.doc;
    const box = el("div", { class: "md-params" });
    doc.params.forEach((p, i) => {
      const name = el("input", { class: "field", type: "text", value: p.name, title: tr("common.nome"), spellcheck: "false" });
      const expr = el("input", { class: "field", type: "text", value: p.expr, title: tr("mod.espressione"), spellcheck: "false" });
      const val = app.vals?.[p.name];
      const err = app.perr?.[p.name];
      name.addEventListener("change", () => {
        const n = name.value.trim();
        if (!validName(n) || doc.params.some((q, j) => j !== i && q.name === n)) { name.classList.add("bad"); return toast(tr("mod.nome_parametro_non_valido"), true); }
        // il nome cambia anche nelle espressioni che lo usano
        renameInDoc(doc, p.name, n);
        p.name = n;
        app.commit(tr("mod.parametri"));
      });
      expr.addEventListener("change", () => { p.expr = expr.value.trim() || "0"; app.commit(tr("mod.parametri")); });
      box.append(el("div", { class: "md-prow" + (err ? " bad" : "") }, name, el("span", {}, "="), expr,
        el("span", { class: "md-pval", title: err || "" }, err ? "⚠" : val !== undefined ? fmt(val) : ""),
        el("button", { class: "md-mini", type: "button", title: tr("mod.elimina"), html: ICON.trash, onclick: () => { doc.params.splice(i, 1); app.commit(tr("mod.parametri")); } })));
    });
    box.append(el("button", { class: "btn md-addp", type: "button", onclick: () => {
      let k = doc.params.length + 1;
      while (doc.params.some(p => p.name === "P" + k)) k++;
      doc.params.push({ name: "P" + k, expr: "10" });
      this.open.params = true;
      app.commit(tr("mod.parametri"));
    } }, el("span", { html: ICON.plus }), tr("mod.nuovo_parametro")));
    box.append(el("p", { class: "md-hint" }, tr("mod.parametri_aiuto")));
    return box;
  }
}

function renameInDoc(doc, from, to) {
  const re = new RegExp(`\\b${from}\\b`, "g");
  const fix = v => (typeof v === "string" ? v.replace(re, to) : v);
  for (const p of doc.params) p.expr = fix(p.expr);
  for (const f of doc.features) {
    for (const k of Object.keys(f)) if (typeof f[k] === "string" && k !== "id" && k !== "type" && k !== "name" && k !== "sketch") f[k] = fix(f[k]);
    if (f.sk) for (const c of f.sk.cons) if (typeof c.v === "string") c.v = fix(c.v);
  }
}

// ---- tubazione/canalina/condotta selezionata: dati d'impianto, misura e raggio modificabili, nodi trascinabili
function routeInfo(app, bid, add, r) {
  const m = (app.res?.bodies || []).find(q => q.id === bid)?.meta;
  if (!m?.impianto) return;
  add(tr("mod.tipo"), kindName(m.impianto));
  add(tr("mod.pl_misura"), m.misura || sizeLabel(m));
  if (m.spec) { const sp = specOf(m.spec, app.doc); add(tr("mod.pl_classe"), `${sp.id} · ${sp.mat} · PN${sp.pn}`); }
  if (m.linea) add(tr("mod.pl_linea"), m.linea);
  add(tr("mod.pl_lung_totale"), fmt(m.lunghezza / 1000, 3) + " m");
  add(tr("mod.pl_tratti_dritti"), m.dritti.map(d => fmt(d, 1)).join(" + ") + " mm");
  add(tr("mod.pl_curve"), m.curve.length ? m.curve.map(a => fmt(a, 1) + "°").join(", ") + " · R " + fmt(m.raggio, 1) : "0");
  const f = app.doc.features.find(q => q.id === bid && q.type === "route");
  if (!f) return;
  const box = el("div", { class: "md-dbody" });
  const sizeSel = el("select", { class: "field" }, ...sizes(f.kind, f.spec, app.doc).map(s => el("option", { value: s.id, selected: s.id === f.size }, s.label)));
  sizeSel.addEventListener("change", () => {
    const s = sizes(f.kind, f.spec, app.doc).find(q => q.id === sizeSel.value);
    if (!s) return;
    Object.assign(f, { size: s.id, t: s.t, r: s.r });
    if (s.od) f.od = s.od; else { delete f.od; f.w = s.w; f.h = s.h; }
    app.afterRegen = () => { app.view.selection = [{ kind: "body", body: bid }]; app.selChanged(); };
    app.commit(tr("mod.pl_misura"));
  });
  const rIn = el("input", { class: "field", type: "text", value: String(f.r ?? m.raggio) });
  rIn.addEventListener("change", () => {
    try { evalExpr(rIn.value, app.vals || {}); } catch { return toast(tr("mod.valore_non_valido"), true); }
    f.r = /^[0-9.,]+$/.test(rIn.value.trim()) ? parseFloat(rIn.value.replace(",", ".")) : rIn.value.trim();
    app.afterRegen = () => { app.view.selection = [{ kind: "body", body: bid }]; app.selChanged(); };
    app.commit(tr("mod.pl_raggio_curve"));
  });
  box.append(el("div", { class: "md-frow" }, el("label", {}, tr("mod.pl_misura")), sizeSel),
    el("div", { class: "md-frow" }, el("label", {}, tr("mod.pl_raggio_curve")), rIn, el("span", { class: "md-unit" }, "mm")),
    el("p", { class: "md-hint" }, f.sketch ? tr("mod.pl_nodi_schizzo") : tr("mod.pl_nodi_aiuto")));
  const lineIn = el("input", { class: "field", type: "text", value: f.linea || "", placeholder: "100-A1-001" });
  lineIn.addEventListener("change", () => { f.linea = lineIn.value.trim() || undefined; app.afterRegen = () => { app.view.selection = [{ kind: "body", body: bid }]; app.selChanged(); }; app.commit(tr("mod.pl_linea")); });
  box.append(el("div", { class: "md-frow" }, el("label", {}, tr("mod.pl_linea")), lineIn));
  const sup = el("div", { class: "md-quick" });
  sup.append(el("button", { class: "btn", type: "button", onclick: () => app.startOp("supports", { route: bid, kind: "floor", z: Math.floor(((app.bodyData(bid)?.bbox?.[2] ?? 0) - 500) / 100) * 100 }) }, el("span", { html: ICON.support }), tr("mod.pl_support_floor")),
    el("button", { class: "btn", type: "button", onclick: () => app.startOp("supports", { route: bid, kind: "hanger", z: Math.ceil(((app.bodyData(bid)?.bbox?.[5] ?? 2500) + 500) / 100) * 100 }) }, el("span", { html: ICON.hanger }), tr("mod.pl_support_hanger")));
  box.append(el("div", { class: "md-subh" }, tr("mod.pl_staffaggi")), sup);
  if (f.kind === "pipe") {
    const acts = el("div", { class: "md-quick" });
    for (const [k, icon] of [["valve", "valve"], ["flanges", "flange"], ["flange", "flange"]]) acts.append(el("button", { class: "btn", type: "button", onclick: () => app.startFitting(bid, k) }, el("span", { html: ICON[icon] }), fittingName(k)));
    box.append(el("div", { class: "md-subh" }, tr("mod.pl_componenti")), acts);
  }
  r.append(box);
}

// ---- proprieta' della selezione (pannello destro senza strumenti)
export function selectionInfo(app) {
  const r = app.right;
  r.innerHTML = "";
  const sel = app.view.selection;
  const dl = el("dl", { class: "kv stack" });
  const add = (k, v) => dl.append(el("dt", {}, k), el("dd", {}, v));
  if (!sel.length) {
    const all = app.bodyList();
    r.append(el("div", { class: "md-dhead" }, el("b", {}, tr("mod.modello"))));
    let vol = 0, area = 0;
    for (const b of all) { vol += b.data?.props?.vol || 0; area += b.data?.props?.area || 0; }
    add(tr("mod.corpi"), String(all.length));
    add(tr("mod.lavorazioni"), String(app.doc.features.length));
    if (all.length) { add(tr("mod.volume_totale"), fmt(vol, 2) + " mm³"); add(tr("mod.area_totale"), fmt(area, 2) + " mm²"); }
    r.append(dl, el("p", { class: "md-hint" }, tr("mod.aiuto_iniziale")));
    return;
  }
  const s = sel[sel.length - 1];
  const b = app.bodyData(s.body);
  if (s.kind === "body" && b) {
    r.append(el("div", { class: "md-dhead" }, el("b", {}, app.bodyName(s.body))));
    const p = b.props || {};
    const bb = b.bbox || [0, 0, 0, 0, 0, 0];
    if (b.kind === "mesh") add(tr("mod.tipo"), tr("mod.mesh_n", p.triangoli || 0));
    add(tr("mod.volume"), fmt(p.vol || 0, 2) + " mm³");
    add(tr("mod.area"), fmt(p.area || 0, 2) + " mm²");
    add(tr("mod.massa_acciaio"), fmt((p.vol || 0) * 7.85e-6, 3) + " kg");
    if (p.com) add(tr("mod.baricentro"), p.com.map(v => fmt(v, 2)).join(" ; "));
    add(tr("mod.ingombro"), [0, 1, 2].map(k => fmt(bb[k + 3] - bb[k], 2)).join(" × ") + " mm");
    if (p.facce !== undefined) add(tr("mod.facce_spigoli"), `${p.facce} / ${p.spigoli}`);
    if (p.valido === false) add(tr("mod.controllo"), tr("mod.solido_non_valido"));
    routeInfo(app, s.body, add, r);
  } else if (s.kind === "face" && b) {
    const i = s.info || b.faces[s.index];
    r.append(el("div", { class: "md-dhead" }, el("b", {}, tr("mod.faccia") + " · " + tr("mod.sup_" + i.t))));
    add(tr("mod.area"), fmt(i.a, 2) + " mm²");
    if (i.n && i.t === "plane") add(tr("mod.normale"), i.n.map(v => fmt(v, 4)).join(" ; "));
    if (i.r) add(i.t === "cyl" ? tr("mod.diametro") : tr("mod.raggio"), fmt(i.t === "cyl" ? i.r * 2 : i.r, 3) + " mm");
    if (i.ang) add(tr("mod.semiangolo"), fmt(i.ang, 2) + "°");
    add(tr("mod.corpo"), app.bodyName(s.body));
  } else if (s.kind === "edge" && b) {
    const i = s.info || b.edges[s.index];
    r.append(el("div", { class: "md-dhead" }, el("b", {}, tr("mod.spigolo") + " · " + tr("mod.cur_" + i.t))));
    add(tr("mod.lunghezza"), fmt(i.l, 3) + " mm");
    if (i.r) add(tr("mod.raggio"), fmt(i.r, 3) + " mm");
    if (i.r) add(tr("mod.diametro"), fmt(i.r * 2, 3) + " mm");
    if (i.o) add(tr("mod.centro"), i.o.map(v => fmt(v, 2)).join(" ; "));
    add(tr("mod.corpo"), app.bodyName(s.body));
  } else if (s.kind === "region") {
    r.append(el("div", { class: "md-dhead" }, el("b", {}, tr("mod.profilo"))));
    add(tr("mod.area"), fmt(s.region.area, 2) + " mm²");
  } else if (s.kind === "vertex") {
    r.append(el("div", { class: "md-dhead" }, el("b", {}, tr("mod.vertice"))));
    add(tr("mod.coordinate"), [s.point.x, s.point.y, s.point.z].map(v => fmt(v, 3)).join(" ; "));
  }
  if (sel.length > 1) add(tr("mod.selezionati"), String(sel.length));
  r.append(dl);
  // azioni rapide sulla selezione
  const acts = el("div", { class: "md-quick" });
  const kinds = new Set(sel.map(q => q.kind));
  const btn = (icon, label, fn) => acts.append(el("button", { class: "btn", type: "button", onclick: fn }, el("span", { html: ICON[icon] }), label));
  if (kinds.has("edge")) { btn("fillet", tr("mod.raccordo"), () => app.startOp("fillet")); btn("chamfer", tr("mod.smusso"), () => app.startOp("chamfer")); }
  if (kinds.has("face")) { btn("pushpull", tr("mod.spingi_tira"), () => app.startOp("pushpull")); btn("sketch", tr("mod.schizzo_su_faccia"), () => app.sketchOnSelection()); btn("delface", tr("mod.elimina_faccia"), () => app.startOp("delface")); btn("shell", tr("mod.guscio"), () => app.startOp("shell")); }
  if (kinds.has("region")) { btn("extrude", tr("mod.estrudi"), () => app.startOp("extrude")); btn("revolve", tr("mod.rivoluzione"), () => app.startOp("revolve")); }
  if (kinds.has("body")) { btn("move", tr("mod.trasforma"), () => app.startOp("transform")); btn("pattern", tr("mod.serie"), () => app.startOp("pattern")); btn("trash", tr("mod.elimina_corpo"), () => app.deleteSelection()); }
  if (acts.childNodes.length) r.append(acts);
}

// ---- pannello dello schizzo
export function sketchPanel(app, ed) {
  const r = app.right;
  r.innerHTML = "";
  const sk = ed.sk;
  const dof = ed.analysis.dof;
  r.append(el("div", { class: "md-dhead" }, el("span", { class: "md-dico", html: ICON.sketch }), el("b", {}, tr("mod.schizzo"))),
    el("p", { class: "md-dof" + (ed.bad.size ? " bad" : dof ? "" : " ok") }, ed.statusText()));
  // vincoli applicabili alla selezione
  const { pts, ents, cons } = ed.selected();
  if (pts.length || ents.length) {
    const box = el("div", { class: "md-cons" });
    const B = (k, icon) => box.append(el("button", { class: "md-cbtn", type: "button", title: tr("mod.v_" + k), html: ICON[icon], onclick: () => ed.applyCon(k) }));
    B("hor", "hor"); B("ver", "ver"); B("coinc", "coinc"); B("tan", "tan"); B("par", "par"); B("perp", "perp"); B("equal", "equal"); B("conc", "conc"); B("mid", "mid"); B("sym", "sym"); B("fix", "fix");
    box.append(el("button", { class: "md-cbtn", type: "button", title: tr("mod.costruzione_x"), html: ICON.construction, onclick: () => ed.toggleConstruction() }));
    r.append(el("p", { class: "md-hint" }, tr("mod.selezionati_n", pts.length + ents.length + cons.length)), box);
  }
  // quote: valori modificabili (anche espressioni con i parametri)
  const dims = sk.cons.filter(isDim);
  if (dims.length) {
    const list = el("div", { class: "md-dims" });
    for (const c of dims) {
      const cur = measureDim(sk, c);
      const inp = el("input", { class: "field", type: "text", value: c.ref ? fmt(Math.abs(cur)) : String(c.v), disabled: !!c.ref, spellcheck: "false" });
      inp.addEventListener("change", () => {
        const v = inp.value.trim();
        try { evalExpr(v, app.vals || {}); } catch { inp.classList.add("bad"); return toast(tr("mod.valore_non_valido"), true); }
        ed.inputDone = null;
        const old = c.v;
        c.v = /^[-+]?[0-9]+([.,][0-9]+)?$/.test(v) ? parseFloat(v.replace(",", ".")) : v;
        c.val = evalExpr(c.v, app.vals || {});
        const res = solve(sk);
        if (!res.ok) { c.v = old; c.val = evalExpr(old, app.vals || {}); solve(sk); toast(tr("mod.vincolo_conflitto"), true); }
        ed.changed(tr("mod.quota"), { solve: false });
      });
      const row = el("div", { class: "md-drow" + (ed.sel.has("c:" + c.id) ? " sel" : "") },
        el("span", { class: "md-dk" }, tr("mod.q_" + c.t)), inp,
        el("button", { class: "md-mini", type: "button", title: c.ref ? tr("mod.rendi_pilotante") : tr("mod.rendi_riferimento"), html: c.ref ? ICON.param : ICON.eye, onclick: () => { c.ref = !c.ref || undefined; if (!c.ref) c.v = Math.round(Math.abs(cur) * 1000) / 1000; ed.changed(tr("mod.quota")); } }),
        el("button", { class: "md-mini", type: "button", title: tr("mod.elimina"), html: ICON.trash, onclick: () => { sk.cons = sk.cons.filter(q => q !== c); ed.changed(tr("mod.elimina")); } }));
      row.addEventListener("click", e => { if (e.target.closest("input,button")) return; ed.sel.clear(); ed.sel.add("c:" + c.id); ed.refresh(); });
      list.append(row);
    }
    r.append(el("div", { class: "md-subh" }, tr("mod.quote")), list);
  }
  r.append(el("p", { class: "md-hint" }, tr("mod.schizzo_aiuto")));
  r.append(el("div", { class: "md-dfoot" }, el("button", { class: "btn primary", type: "button", onclick: () => app.finishSketch() }, el("span", { html: ICON.finish }), tr("mod.fine_schizzo"))));
}
