// Modellatore 3D di solidi: documento (cronologia delle lavorazioni) + motore OpenCascade (mbvisual/modkernel.py) +
// vista (mview.js), schizzi (msketch.js), strumenti (mtools.js), pannelli (mpanel.js).
// Flusso: ogni modifica passa da commit() -> cronologia (annulla/ripeti) -> compile() -> ricalcolo nel motore -> vista.
import { el, pickFiles, toast, WEB } from "../core.js";
import { fmtNum, t as tr } from "../i18n.js";
import { keymap } from "../shortcuts.js";
import { bodyName, compile, facePlane, History, makeRef, newDoc, nextId, stdPlane } from "./mdoc.js";
import * as K from "./mkernel.js";
import { ICON } from "./micons.js";
import { featLabel, Panel, selectionInfo, sketchPanel } from "./mpanel.js";
import { newSketch } from "./msolver.js";
import { SketchEditor, sampleEnt } from "./msketch.js";
import { FeatureTool, Measure, PushPull, specs } from "./mtools.js";
import { View } from "./mview.js";
import { meshParts } from "./mmesh.js";
import { Gizmo, NodeHandles, RouteTool } from "./mdrag.js";
import { ClashTool, FittingTool, makeIso, showBom } from "./mbom.js";

const KERNEL_EXTS = new Set(["step", "stp", "p21", "stpz", "iges", "igs", "brep", "brp", "ipt", "iam", "sldprt", "sldasm", "par", "psm", "asm", "x_t", "x_b", "xmt_txt", "xmt_bin", "p_t", "p_b"]);

export class ModelerApp {
  constructor(ctx) {
    this.ctx = ctx;
    this.sid = K.newSid();
    this.doc = newDoc();
    this.res = null; // ultimo ricalcolo
    this.errs = {};
    this.tool = null;
    this.sketch = null;
    this.viewUpto = null;
    this.path = ctx.path;
  }

  // ---------------------------------------------------------------------------------------------- avvio
  async init(ld) {
    const ctx = this.ctx;
    ld?.set(0.2, tr("mod.avvio_motore"));
    if (ctx.ext === "mbmod" && (ctx.info?.size || 0) > 0) {
      const r = await K.openDoc(ctx.path);
      this.doc = Object.assign(newDoc(), r.doc);
    }
    this.hist = new History(this.doc);
    this.layout();
    this.view.hidden = () => ctx.tab.view.hidden;
    if (ctx.importFrom) await this.importSource(ctx.importFrom, ld);
    ld?.set(0.7, tr("mod.ricalcolo"));
    await this.regen();
    requestAnimationFrame(() => { this.view.resize(); this.view.fit(this.doc.features.length ? null : [0.6, -0.8, 0.55]); });
    this.panel.render();
    selectionInfo(this);
  }

  layout() {
    const ctx = this.ctx;
    ctx.el.innerHTML = "";
    this.left = el("div", { class: "md-left" });
    this.right = el("div", { class: "md-right" });
    this.hostEl = el("div", { class: "md-host" });
    this.statusEl = el("div", { class: "md-status" });
    this.hostEl.append(this.statusEl);
    ctx.el.append(el("div", { class: "md-root side" }, this.left, this.hostEl, this.right));
    ctx.fillBody(true);
    this.view = new View(this.hostEl);
    this.view.overlays.add(g => this.tool?.paint?.(g));
    // trascinamento diretto: maniglie sui corpi selezionati e nodi dei percorsi d'impianto (ui/js/modeler/mdrag.js)
    this.selMode = localStorage.getItem("mbv-mod-selezione") || "body";
    this.gizmo = new Gizmo(this);
    this.nodes = new NodeHandles(this);
    this.panel = new Panel(this, this.left);
    this.buildToolbar();
    this.bindPointer();
    this.bindKeys();
  }

  // ---------------------------------------------------------------------------------------------- barra comandi
  buildToolbar() {
    const tb = this.ctx.tb;
    const B = (icon, label, fn, opts = {}) => {
      const b = el("button", { type: "button", class: "md-tbtn", title: opts.title || label, onclick: fn });
      b.insertAdjacentHTML("beforeend", ICON[icon]);
      if (opts.text) b.append(el("span", {}, label));
      if (opts.id) b.dataset.op = opts.id;
      return b;
    };
    const sep = () => el("span", { class: "sep" });
    this.undoBtn = B("undo", tr("mod.annulla"), () => this.undo());
    this.redoBtn = B("redo", tr("mod.ripeti"), () => this.redo());
    this.tbMain = el("span", { class: "md-tbgroup" },
      this.undoBtn, this.redoBtn, sep(),
      B("sketch", tr("mod.schizzo"), () => this.startSketchTool(), { text: true, id: "sketch", title: tr("mod.schizzo") + " (S)" }), sep(),
      B("extrude", tr("mod.estrudi") + " (E)", () => this.startOp("extrude"), { id: "extrude" }),
      B("revolve", tr("mod.rivoluzione"), () => this.startOp("revolve"), { id: "revolve" }),
      B("pushpull", tr("mod.spingi_tira") + " (P)", () => this.startOp("pushpull"), { id: "pushpull" }),
      B("hole", tr("mod.foro") + " (H)", () => this.startOp("hole"), { id: "hole" }),
      this.primBtn = B("box", tr("mod.solido_base"), () => this.primMenu(), { id: "primitive" }), sep(),
      B("fillet", tr("mod.raccordo") + " (F)", () => this.startOp("fillet"), { id: "fillet" }),
      B("chamfer", tr("mod.smusso") + " (C)", () => this.startOp("chamfer"), { id: "chamfer" }),
      B("shell", tr("mod.guscio"), () => this.startOp("shell"), { id: "shell" }),
      B("delface", tr("mod.elimina_faccia"), () => this.startOp("delface"), { id: "delface" }), sep(),
      B("union", tr("mod.op_unisci"), () => this.startOp("boolean", { op: "join" }), { id: "union" }),
      B("cut", tr("mod.op_sottrai"), () => this.startOp("boolean", { op: "cut" }), { id: "cut" }),
      B("common", tr("mod.op_interseca"), () => this.startOp("boolean", { op: "common" }), { id: "common" }), sep(),
      B("move", tr("mod.sposta") + " (M)", () => this.startOp("transform", { k: "move" }), { id: "move" }),
      B("rotate", tr("mod.ruota"), () => this.startOp("transform", { k: "rotate" }), { id: "rotate" }),
      B("scale", tr("mod.scala"), () => this.startOp("transform", { k: "scale" }), { id: "scale" }),
      B("mirror", tr("mod.specchia"), () => this.startOp("transform", { k: "mirror", copy: true }), { id: "mirror" }),
      B("copy", tr("mod.copia"), () => this.startOp("transform", { k: "move", copy: true }), { id: "copy" }),
      B("pattern", tr("mod.serie"), () => this.startOp("pattern"), { id: "pattern" }),
      B("mate", tr("mod.accoppia"), () => this.startOp("mate"), { id: "mate" }),
      B("split", tr("mod.dividi"), () => this.startOp("split"), { id: "split" }), sep(),
      B("route", tr("mod.pl_impianti") + " (T)", () => this.startRoute(), { id: "route" }),
      B("bom", tr("mod.pl_distinta"), () => showBom(this)),
      B("iso", tr("mod.pl_isometrici"), () => makeIso(this), { id: "iso" }),
      B("clash", tr("mod.pl_interferenze"), () => { this.cancelTool(false); this.setTool(new ClashTool(this), "clash"); }, { id: "clash" }), sep(),
      this.selModeSel(),
      B("measure", tr("mod.misura") + " (I)", () => this.startMeasure(), { id: "measure" }),
      B("import", tr("mod.importa"), () => this.importPick()), sep(),
      this.viewSelect(),
      B("fit", tr("mod.adatta"), () => this.view.fit()),
      this.orthoBtn = B("ortho", tr("mod.ortogonale"), () => { this.view.setOrtho(this.view.camera !== this.view.ortho); this.orthoBtn.classList.toggle("on", this.view.camera === this.view.ortho); }),
      this.wireBtn = B("wire", tr("mod.filo_ferro"), () => { this.view.setWire(!this.view.wire); this.wireBtn.classList.toggle("on", this.view.wire); }));
    const S = (tool, icon, label) => B(icon, label, () => this.sketch?.setTool(tool), { id: "sk-" + tool });
    this.tbSketch = el("span", { class: "md-tbgroup", hidden: true },
      this.undoBtn.cloneNode(true), this.redoBtn.cloneNode(true), sep(),
      S("select", "select", tr("mod.seleziona") + " (S)"), S("line", "line", tr("mod.linea") + " (L)"), S("rect", "rect", tr("mod.rettangolo") + " (R)"),
      S("rectc", "rectc", tr("mod.rettangolo_centro") + " (Maiusc+R)"), S("circle", "circle", tr("mod.cerchio") + " (C)"), S("arc", "arc", tr("mod.arco_3_punti") + " (A)"),
      S("polygon", "polygon", tr("mod.poligono") + " (P)"), S("dim", "dim", tr("mod.quota") + " (D)"), sep(),
      ...["hor", "ver", "coinc", "tan", "par", "perp", "equal", "conc", "mid", "sym", "fix"].map(k => B(k, tr("mod.v_" + k), () => this.sketch?.applyCon(k))),
      B("construction", tr("mod.costruzione_x"), () => this.sketch?.toggleConstruction()), sep(),
      B("project", tr("mod.proietta"), () => this.sketch?.projectEdges()),
      this.gridBtn = B("grid", tr("mod.aggancio_griglia"), () => { if (this.sketch) { this.sketch.gridSnap = !this.sketch.gridSnap; this.gridBtn.classList.toggle("on", this.sketch.gridSnap); } }),
      this.polyInput = el("input", { type: "number", min: 3, max: 64, value: 6, title: tr("mod.lati_poligono"), style: { width: "52px" } }), sep(),
      B("finish", tr("mod.fine_schizzo"), () => this.finishSketch(), { text: true }));
    this.polyInput.addEventListener("change", () => { if (this.sketch) this.sketch.polySides = +this.polyInput.value || 6; });
    const [u2, r2] = this.tbSketch.querySelectorAll("button");
    u2.addEventListener("click", () => this.undo());
    r2.addEventListener("click", () => this.redo());
    this.undo2 = u2; this.redo2 = r2;
    tb.append(this.tbMain, this.tbSketch);
    this.updateButtons();
  }

  // menu dei solidi base (parallelepipedo, cilindro, sfera, cono, toro)
  primMenu() {
    const m = el("div", { class: "menu md-menu", role: "menu" });
    for (const [k, icon, l] of [["box", "box", "mod.parallelepipedo"], ["cyl", "cyl", "mod.cilindro"], ["sphere", "sphere", "mod.sfera"], ["cone", "cone", "mod.cono"], ["torus", "torus", "mod.toro"]]) {
      const b = el("button", { type: "button", onclick: () => { m.remove(); this.startOp("primitive", { shape: k }); } });
      b.insertAdjacentHTML("beforeend", ICON[icon]);
      b.append(tr(l));
      m.append(b);
    }
    document.body.append(m);
    const r = this.primBtn.getBoundingClientRect();
    Object.assign(m.style, { position: "fixed", left: r.left + "px", top: r.bottom + 4 + "px", zIndex: 1000 });
    const close = ev => { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener("pointerdown", close, true); } };
    setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
  }

  // selezione: oggetti interi (da trascinare) oppure facce e spigoli
  selModeSel() {
    const s = el("select", { class: "md-compact", title: tr("mod.modo_selezione"), onchange: () => { this.selMode = s.value; try { localStorage.setItem("mbv-mod-selezione", s.value); } catch { /* */ } this.view.selection = []; this.selChanged(); } },
      el("option", { value: "body", selected: this.selMode === "body" }, tr("mod.sel_corpi")), el("option", { value: "face", selected: this.selMode !== "body" }, tr("mod.sel_facce")));
    return s;
  }

  startFitting(route, kind) { this.cancelTool(false); this.setTool(new FittingTool(this, route, kind), "fitting"); }

  startRoute(opts) { if (this.sketch) return; this.cancelTool(false); this.setTool(new RouteTool(this, opts), "route"); }

  viewSelect() {
    const views = { iso: [0.6, -0.8, 0.55], top: [0, 0, 1], bottom: [0, 0, -1], front: [0, -1, 0], back: [0, 1, 0], right: [1, 0, 0], left: [-1, 0, 0] };
    const s = el("select", { class: "md-compact", title: tr("mod.vista"), onchange: () => { const d = views[s.value]; if (d) this.view.fit(d); s.value = ""; } },
      el("option", { value: "" }, tr("mod.vista")), el("option", { value: "iso" }, tr("mod.v_iso")), el("option", { value: "top" }, tr("mod.v_alto")), el("option", { value: "bottom" }, tr("mod.v_basso")),
      el("option", { value: "front" }, tr("mod.v_fronte")), el("option", { value: "back" }, tr("mod.v_retro")), el("option", { value: "right" }, tr("mod.v_destra")), el("option", { value: "left" }, tr("mod.v_sinistra")));
    return s;
  }

  updateButtons() {
    for (const b of [this.undoBtn, this.undo2]) if (b) { b.disabled = !this.hist?.canUndo; b.title = tr("mod.annulla") + (this.hist?.undoLabel ? ": " + this.hist.undoLabel : "") + " (Ctrl+Z)"; }
    for (const b of [this.redoBtn, this.redo2]) if (b) { b.disabled = !this.hist?.canRedo; b.title = tr("mod.ripeti") + (this.hist?.redoLabel ? ": " + this.hist.redoLabel : "") + " (Ctrl+Y)"; }
    const cur = this.sketch ? "sk-" + this.sketch.tool : this.toolName;
    for (const b of this.ctx.tb.querySelectorAll("[data-op]")) b.classList.toggle("on", b.dataset.op === cur);
  }

  // ---------------------------------------------------------------------------------------------- mouse e tasti
  bindPointer() {
    const c = this.view.canvas;
    let down = null;
    c.addEventListener("pointerdown", e => { down = [e.clientX, e.clientY, e.button]; });
    c.addEventListener("pointermove", e => {
      if (this.sketch) return;
      if (e.buttons && down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return; // la vista si sta muovendo
      if (this.tool) { this.tool.move?.(e); return; }
      this.hoverSelect(e);
    });
    c.addEventListener("pointerup", e => {
      if (this.sketch || !down) return;
      const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4;
      const btn = down[2];
      down = null;
      if (moved || btn !== 0) return;
      if (this.tool) this.tool.click?.(e);
      else this.clickSelect(e);
    });
    c.addEventListener("dblclick", e => {
      if (this.sketch || this.tool) return;
      const h = this.view.pick(e, { faces: true, edges: false, regions: true });
      if (h?.kind === "face") { this.view.selection = [{ kind: "body", body: h.body, point: h.point }]; this.selChanged(); }
      if (h?.kind === "region") { const f = this.doc.features.find(q => q.id === h.sketch); if (f) this.editFeature(f.id); }
    });
    c.addEventListener("contextmenu", e => e.preventDefault());
  }

  hoverSelect(e) {
    let h = this.view.pick(e, { faces: true, edges: true, verts: true, regions: true });
    if (h && this.selMode === "body" && h.body && h.kind !== "region") h = { kind: "body", body: h.body, point: h.point };
    this.view.hover = h;
    this.view.redraw();
  }
  clickSelect(e) {
    let h = this.view.pick(e, { faces: true, edges: true, verts: true, regions: true });
    // selezione per corpi (predefinita): un clic prende l'oggetto intero, pronto da trascinare con le maniglie
    if (h && this.selMode === "body" && h.body && h.kind !== "region") h = { kind: "body", body: h.body, point: h.point };
    const add = e.ctrlKey || e.shiftKey || e.metaKey;
    const same = s => s.kind === h.kind && s.body === h.body && s.index === h.index && s.region === h.region;
    let sel = this.view.selection;
    if (!h) sel = add ? sel : [];
    else if (add) sel = sel.some(same) ? sel.filter(s => !same(s)) : [...sel, h];
    else sel = [h];
    this.view.selection = sel;
    this.selChanged();
  }
  selChanged() {
    this.view.redraw();
    if (!this.tool && !this.sketch) selectionInfo(this);
    this.panel.render();
  }
  get sel() { return this.view.selection; }
  selectBody(id, add) {
    const s = { kind: "body", body: id };
    this.view.selection = add ? [...this.view.selection.filter(q => !(q.kind === "body" && q.body === id)), s] : [s];
    this.selChanged();
  }

  bindKeys() {
    const ctx = this.ctx;
    const no3d = () => !this.sketch && !this.typing();
    const op = (name, extra) => () => this.startOp(name, extra);
    this.unkey = keymap(ctx, tr("mod.programma"), [
      { keys: "Ctrl+Z", desc: tr("mod.annulla"), run: () => this.undo(), when: () => !this.typing() },
      { keys: "Ctrl+Y|Ctrl+Shift+Z", desc: tr("mod.ripeti"), run: () => this.redo(), when: () => !this.typing() },
      { keys: "S", desc: tr("mod.schizzo"), run: () => this.startSketchTool(), when: no3d },
      { keys: "E", desc: tr("mod.estrudi"), run: op("extrude"), when: no3d },
      { keys: "P", desc: tr("mod.spingi_tira"), run: op("pushpull"), when: no3d },
      { keys: "H", desc: tr("mod.foro"), run: op("hole"), when: no3d },
      { keys: "F", desc: tr("mod.raccordo"), run: op("fillet"), when: no3d },
      { keys: "C", desc: tr("mod.smusso"), run: op("chamfer"), when: no3d },
      { keys: "M", desc: tr("mod.sposta"), run: op("transform", { k: "move" }), when: no3d },
      { keys: "I", desc: tr("mod.misura"), run: () => this.startMeasure(), when: no3d },
      { keys: "T", desc: tr("mod.pl_impianti"), run: () => this.startRoute(), when: no3d },
      { keys: "Delete", desc: tr("mod.elimina_selezione"), run: () => this.deleteSelection(), when: () => no3d() && !this.tool },
      { keys: "Escape", desc: tr("mod.annulla_strumento"), run: () => this.escape(), when: () => !this.sketch },
      { keys: "Home", desc: tr("mod.adatta"), run: () => this.view.fit(), when: () => !this.typing() },
    ]);
    // tasti dello strumento attivo (numeri digitati in Spingi/Tira)
    this.onKey = e => { if (this.ctx.tab.view.hidden || this.sketch || this.typing(e)) return; if (this.tool?.key?.(e)) { e.preventDefault(); e.stopPropagation(); } };
    window.addEventListener("keydown", this.onKey, true);
  }
  typing(e) { const t = e?.target || document.activeElement; return !!t?.closest?.("input, textarea, select, [contenteditable]"); }
  escape() {
    if (this.tool) return this.cancelTool();
    if (this.view.selection.length) { this.view.selection = []; this.selChanged(); }
  }

  // ---------------------------------------------------------------------------------------------- documento
  commit(label, { regen = true } = {}) {
    if (this.hist.push(this.doc, label)) this.ctx.setDirty(true);
    this.updateButtons();
    if (regen) return this.regen();
    this.panel.render();
  }
  undo() { const d = this.hist.undo(); if (d) this.restore(d); }
  redo() { const d = this.hist.redo(); if (d) this.restore(d); }
  restore(d) {
    this.doc = d;
    this.ctx.setDirty(true);
    if (this.tool) this.cancelTool(false);
    if (this.sketch) {
      const f = this.doc.features.find(q => q.id === this.sketch.f.id);
      if (!f) this.exitSketch();
      else { this.sketch.f = f; this.sketch.sk = f.sk; this.sketch.h.feature = f; this.sketch.sel.clear(); this.sketch.refresh(); }
    }
    this.updateButtons();
    this.regen();
  }

  status(fid) { return this.res?.features?.find(r => r.id === fid) || (this.errs[fid] ? { ok: false, err: this.errs[fid][0], args: this.errs[fid].slice(1) } : null); }
  errText(st) { return st?.err ? tr(st.err, ...(st.args || [])) : ""; }
  say(text) { this.statusEl.textContent = text || ""; this.statusEl.hidden = !text; }

  bodyList() {
    return (this.res?.bodies || []).map((b, i) => ({ id: b.id, kind: b.kind, name: this.bodyName(b.id, i), data: this.bodyData(b.id) }));
  }
  bodyData(id) {
    const b = (this.res?.bodies || []).find(q => q.id === id);
    if (!b) return null;
    return this.view.cache.get(b.uid)?.data || null;
  }
  bodyName(id, i = null) {
    if (i === null) i = (this.res?.bodies || []).findIndex(q => q.id === id);
    return bodyName(this.doc, id, tr("mod.corpo") + " " + (i + 1));
  }
  look(id, patch) {
    const lk = (this.doc.looks[id] = { ...(this.doc.looks[id] || {}), ...patch });
    for (const k of Object.keys(lk)) if (lk[k] === undefined || lk[k] === false) delete lk[k];
    this.commit(tr("mod.aspetto"), { regen: false });
    this.showBodies();
  }

  // ---------------------------------------------------------------------------------------------- ricalcolo
  // docOverride: documento provvisorio (anteprima di una lavorazione); upto: lavorazioni da valutare
  // le richieste si mettono in fila: se ne arrivano altre durante un ricalcolo vale solo l'ultima
  regen({ docOverride = null, upto = this.viewUpto } = {}) {
    this.pending = { docOverride, upto };
    if (!this.loop) {
      this.loop = (async () => {
        let out;
        while (this.pending) {
          const o = this.pending;
          this.pending = null;
          out = await this.regenOnce(o);
        }
        this.loop = null;
        return out;
      })();
    }
    return this.loop;
  }

  async regenOnce({ docOverride, upto }) {
    this.say(tr("mod.ricalcolo"));
    try {
      const doc = docOverride || this.doc;
      const cmp = compile(doc, { upto });
      this.errs = cmp.errs;
      this.vals = cmp.vals;
      this.perr = cmp.perr;
      this.regions = cmp.regions;
      const meta = await K.regen(this.sid, cmp.cdoc, [...this.view.cache.keys()]);
      for (const b of meta.bodies) if (b.mesh && !this.view.cache.has(b.uid)) this.view.buildGeom(b);
      this.res = meta;
      this.shownDoc = doc;
      this.showBodies();
      this.showSketches();
      if (this.afterRegen && !docOverride) { const f = this.afterRegen; this.afterRegen = null; f(); }
      const bad = new Set([...meta.features.filter(r => !r.ok).map(r => r.id), ...Object.keys(cmp.errs)]).size;
      this.say(bad ? tr("mod.lavorazioni_errore", bad) : "");
      let vol = 0;
      for (const b of meta.bodies) vol += this.bodyData(b.id)?.props?.vol || 0;
      this.ctx.status(tr("mod.stato_modello", meta.bodies.length, fmtNum(Math.round(vol * 100) / 100, 2), meta.ms));
      return meta;
    } catch (e) {
      console.error(e);
      toast(e.message, true, 6000);
      this.say(e.message);
      return null;
    } finally {
      this.panel.render();
      if (!this.tool && !this.sketch) selectionInfo(this);
    }
  }

  showBodies() {
    const list = (this.res?.bodies || []).map(b => {
      const lk = this.doc.looks[b.id] || {};
      return { ...b, color: lk.color, hidden: lk.hidden, name: this.bodyName(b.id) };
    });
    this.view.setBodies(list);
    // la selezione resta valida solo per i corpi che ci sono ancora
    this.view.selection = this.view.selection.filter(s => !s.body || this.view.bodies.has(s.body) || s.kind === "region");
  }

  showSketches() {
    const doc = this.shownDoc || this.doc;
    const list = [];
    const end = this.viewUpto ?? (doc.end ?? doc.features.length);
    doc.features.slice(0, end).forEach(f => {
      if (f.type !== "sketch" || f.hidden || f.off || this.sketch?.f.id === f.id) return;
      const plane = this.res?.planes?.[f.id];
      if (!plane) return;
      const curves = f.sk.ents.map(en => ({ pts: sampleEnt(f.sk, en, 48), cons: !!en.cons }));
      list.push({ id: f.id, plane, curves, regions: this.regions?.[f.id] || [] });
    });
    this.view.setSketches(list);
  }

  // anteprima di una lavorazione (nuova o modificata) senza toccare il documento
  async preview(f, replaceId = null) {
    const doc = this.doc;
    const end = doc.end ?? doc.features.length;
    let feats;
    if (replaceId) {
      const i = doc.features.findIndex(q => q.id === replaceId);
      feats = f ? [...doc.features.slice(0, i), f] : doc.features.slice(0, i);
    } else {
      feats = f ? [...doc.features.slice(0, end), { ...f, id: f.id || "f" + doc.seq }] : doc.features.slice(0, end);
    }
    const meta = await this.regen({ docOverride: { ...doc, features: feats, end: null }, upto: null });
    const id = f ? (f.id || "f" + doc.seq) : null;
    return id ? meta?.features?.find(r => r.id === id) || (this.errs[id] ? { ok: false, err: this.errs[id][0], args: this.errs[id].slice(1) } : null) : null;
  }

  commitFeature(f, isEdit = false) {
    const doc = this.doc;
    if (isEdit) {
      const i = doc.features.findIndex(q => q.id === f.id);
      doc.features[i] = { ...doc.features[i], ...f };
      for (const k of Object.keys(doc.features[i])) if (f[k] === undefined && !["id", "type", "name", "off", "hidden", "sk", "plane"].includes(k)) delete doc.features[i][k];
    } else {
      f.id = nextId(doc);
      const end = doc.end ?? doc.features.length;
      doc.features.splice(end, 0, f);
      if (doc.end !== null && doc.end !== undefined) doc.end++;
    }
    // lo schizzo usato da un'estrusione o da una rivoluzione si nasconde (come in Fusion): si riaccende dall'albero
    if ((f.type === "extrude" || f.type === "revolve" || (f.type === "route" && f.sketch)) && !isEdit) { const sk = doc.features.find(q => q.id === f.sketch); if (sk) sk.hidden = true; }
    this.selFeature = f.id;
    this.cancelTool(false);
    this.viewUpto = null;
    this.view.selection = [];
    this.commit(featLabel(f, ""));
  }

  editFeature(id) {
    const f = this.doc.features.find(q => q.id === id);
    if (!f) return;
    const i = this.doc.features.indexOf(f);
    if (f.type === "sketch") return this.enterSketch(f, i);
    if (f.type === "import" || f.type === "delbody") return toast(tr("mod.non_modificabile"), false);
    const sp = specs(this)[f.type];
    if (!sp) return;
    this.cancelTool(false);
    this.viewUpto = i;
    this.regen().then(() => this.setTool(new FeatureTool(this, sp, JSON.parse(JSON.stringify(f))), f.type));
  }

  toggleFeature(id) {
    const f = this.doc.features.find(q => q.id === id);
    if (!f) return;
    f.off = !f.off || undefined;
    this.commit(f.off ? tr("mod.sospendi") : tr("mod.riattiva"));
  }
  moveFeature(id, d) {
    const fs = this.doc.features, i = fs.findIndex(q => q.id === id), j = i + d;
    if (j < 0 || j >= fs.length) return;
    [fs[i], fs[j]] = [fs[j], fs[i]];
    // una lavorazione non puo' venire prima dello schizzo che usa
    const bad = fs.some((f, k) => f.sketch && fs.findIndex(q => q.id === f.sketch) > k);
    if (bad) { [fs[i], fs[j]] = [fs[j], fs[i]]; return toast(tr("mod.ordine_non_valido"), true); }
    this.commit(tr("mod.sposta_su"));
  }
  setEnd(n) { this.doc.end = n === null || n >= this.doc.features.length ? null : n; this.commit(tr("mod.ferma_qui")); }
  deleteFeature(id) {
    const fs = this.doc.features, f = fs.find(q => q.id === id);
    if (!f) return;
    // con lo schizzo si tolgono anche le lavorazioni che lo usano
    // ... e con una tubazione i componenti in linea e le staffe montati su di lei
    const gone = new Set([id, ...fs.filter(q => q.sketch === id || q.route === id).map(q => q.id)]);
    this.doc.features = fs.filter(q => !gone.has(q.id));
    if (this.doc.end !== null && this.doc.end > this.doc.features.length) this.doc.end = null;
    this.selFeature = null;
    this.commit(tr("mod.elimina"));
  }

  deleteSelection() {
    const sel = this.view.selection;
    const bodies = [...new Set(sel.filter(s => s.kind === "body").map(s => s.body))];
    const faces = sel.filter(s => s.kind === "face");
    if (bodies.length) return this.commitFeature({ type: "delbody", bodies });
    if (faces.length) return this.startOp("delface");
    if (sel.some(s => s.kind === "region")) { const id = sel.find(s => s.kind === "region").sketch; return this.deleteFeature(id); }
  }

  // ---------------------------------------------------------------------------------------------- strumenti
  setTool(tool, name = null) {
    this.tool?.stop?.();
    this.tool = tool;
    this.toolName = name;
    this.view.hover = null;
    if (tool) tool.start?.();
    else { this.view.controls.mouseButtons.LEFT = 0; selectionInfo(this); }
    this.updateButtons();
    this.view.redraw();
  }
  cancelTool(regen = true) {
    const was = this.tool;
    this.setTool(null);
    if (this.viewUpto !== null || (was instanceof FeatureTool)) { this.viewUpto = null; if (regen) this.regen(); }
  }
  startOp(name, extra = {}) {
    if (this.sketch) return;
    if (name === "pushpull" && !this.view.selection.some(s => s.kind === "face")) { this.cancelTool(false); return this.setTool(new PushPull(this), "pushpull"); }
    const sp = specs(this)[name];
    if (!sp) return;
    const sel = [...this.view.selection];
    this.cancelTool(false);
    this.view.selection = sel;
    const T = new FeatureTool(this, sp);
    Object.assign(T.v, extra);
    if (name === "pushpull") { const f = sel.find(s => s.kind === "face"); if (f) { T.P.face = [{ hit: f }]; T.slot = null; } }
    const opName = { boolean: { join: "union", cut: "cut", common: "common" }[extra.op], transform: { move: extra.copy ? "copy" : "move", rotate: "rotate", scale: "scale", mirror: "mirror" }[extra.k] }[name] || name;
    this.setTool(T, opName);
  }
  startMeasure() { if (this.sketch) return; this.cancelTool(false); this.setTool(new Measure(this), "measure"); }

  // ---------------------------------------------------------------------------------------------- schizzi
  startSketchTool() {
    if (this.sketch) return;
    const f = this.view.selection.find(s => s.kind === "face" && s.info?.t === "plane");
    if (f) return this.sketchOnSelection();
    this.cancelTool(false);
    // scelta del piano: faccia piana nella vista o piano principale
    const tool = {
      start: () => {
        this.right.innerHTML = "";
        const off = el("input", { class: "field", type: "text", value: "0", title: tr("mod.scostamento"), style: { width: "70px" } });
        const pick = std => { let o = 0; try { o = parseFloat(String(off.value).replace(",", ".")) || 0; } catch { /* */ } this.newSketch({ std, off: o || undefined }); };
        this.right.append(el("div", { class: "md-dhead" }, el("span", { class: "md-dico", html: ICON.sketch }), el("b", {}, tr("mod.nuovo_schizzo"))),
          el("p", { class: "md-hint" }, tr("mod.scegli_piano")),
          el("div", { class: "md-planes" },
            el("button", { class: "btn", type: "button", onclick: () => pick("XY") }, tr("mod.piano_xy")),
            el("button", { class: "btn", type: "button", onclick: () => pick("XZ") }, tr("mod.piano_xz")),
            el("button", { class: "btn", type: "button", onclick: () => pick("YZ") }, tr("mod.piano_yz"))),
          el("div", { class: "md-frow" }, el("label", {}, tr("mod.scostamento")), off, el("span", { class: "md-unit" }, "mm")),
          el("div", { class: "md-dfoot" }, el("button", { class: "btn", type: "button", onclick: () => this.cancelTool() }, tr("common.annulla"))));
      },
      move: e => { const h = this.view.pick(e, { faces: true }); this.view.hover = h?.kind === "face" && h.info?.t === "plane" ? h : null; this.view.redraw(); },
      click: e => { const h = this.view.pick(e, { faces: true }); if (h?.kind === "face" && h.info?.t === "plane") { this.view.selection = [h]; this.sketchOnSelection(); } else if (h?.kind === "face") toast(tr("mod.serve_faccia_piana"), true); },
      stop: () => { this.view.hover = null; },
    };
    this.setTool(tool, "sketch");
  }
  sketchOnSelection() {
    const h = this.view.selection.find(s => s.kind === "face" && s.info?.t === "plane");
    if (!h) return toast(tr("mod.serve_faccia_piana"), true);
    this.newSketch({ face: makeRef(h.body, "f", h.info) }, facePlane(h.info.n, h.info.o));
  }
  newSketch(planeSpec, plane = null) {
    this.cancelTool(false);
    const f = { id: nextId(this.doc), type: "sketch", plane: planeSpec, sk: newSketch() };
    const end = this.doc.end ?? this.doc.features.length;
    this.doc.features.splice(end, 0, f);
    if (this.doc.end !== null && this.doc.end !== undefined) this.doc.end++;
    this.newSketchId = f.id;
    const pl = plane || stdPlane(planeSpec.std, planeSpec.off || 0);
    this.enterSketch(f, end, pl);
  }
  async enterSketch(f, index, plane = null) {
    this.cancelTool(false);
    this.view.selection = [];
    this.viewUpto = index + 1;
    if (!plane || f.plane?.face) { await this.regen(); plane = this.res?.planes?.[f.id] || plane; }
    if (!plane) return toast(this.errText(this.status(f.id)) || tr("mod.piano_non_trovato"), true);
    const host = {
      view: this.view, feature: f, plane, proj: this.res?.proj?.[f.id] || [], vals: this.vals,
      changed: label => { this.hist.push(this.doc, label); this.ctx.setDirty(true); this.updateButtons(); },
      finish: () => this.finishSketch(),
      panel: ed => sketchPanel(this, ed),
      status: t => this.say(t),
      hidden: () => this.ctx.tab.view.hidden,
      onTool: () => this.updateButtons(),
    };
    this.sketch = new SketchEditor(host);
    this.sketch.polySides = +this.polyInput.value || 6;
    this.tbMain.hidden = true;
    this.tbSketch.hidden = false;
    this.showSketches();
    this.sketch.start();
    this.updateButtons();
  }
  async finishSketch() {
    const ed = this.sketch;
    if (!ed) return;
    const f = ed.f;
    this.exitSketch();
    // schizzo nuovo lasciato vuoto: si toglie
    if (!f.sk.ents.length && this.newSketchId === f.id) {
      this.doc.features = this.doc.features.filter(q => q.id !== f.id);
      this.hist.push(this.doc, tr("mod.schizzo"));
    } else this.commit(tr("mod.schizzo"), { regen: false });
    this.newSketchId = null;
    this.viewUpto = null;
    await this.regen();
    this.view.fit();
    // come in SketchUp: con un profilo chiuso pronto, si passa a Spingi/Tira
    if ((this.regions?.[f.id] || []).length && !this.doc.features.some(q => q.sketch === f.id)) this.setTool(new PushPull(this), "pushpull");
  }
  exitSketch() {
    this.sketch?.stop();
    this.sketch = null;
    this.tbMain.hidden = false;
    this.tbSketch.hidden = true;
    this.say("");
    this.updateButtons();
    selectionInfo(this);
  }

  // ---------------------------------------------------------------------------------------------- importazione
  async importPick() {
    const files = await pickFiles();
    for (const p of files || []) await this.importSource({ path: p });
  }

  async importSource(src, ld = null) {
    const name = (src.path || "").split(/[\\/]/).pop();
    const ext = name.split(".").pop().toLowerCase();
    const prog = (p, m) => { ld?.set(0.2 + 0.4 * p, m); this.say(m || tr("mod.importazione")); };
    let items = [];
    try {
      if (src.steps?.length) items.push(...(await K.importSteps(src.steps, name, prog)).items);
      if (src.meshParts?.length) items.push(...(await K.importMesh(src.meshParts)).items);
      if (!src.steps && !src.meshParts && src.path) {
        if (KERNEL_EXTS.has(ext)) items = (await K.importFile(src.path, prog)).items;
        else {
          // mesh e altri modelli: letti dal visualizzatore 3D, triangoli al motore
          const { loadAny } = await import("../viewers/model3d.js");
          const loaded = await loadAny({ path: src.path, name, ext }, { set() {} }, {});
          const parts = meshParts(loaded.root, ext);
          if (!parts.length) throw new Error(tr("mod.nulla_da_importare"));
          items = (await K.importMesh(parts)).items;
        }
      }
    } catch (e) { toast(tr("mod.importazione_non_riuscita", name, e.message), true, 8000); this.say(""); return; }
    if (!items.length) { toast(tr("mod.nulla_da_importare"), true); return; }
    const f = { type: "import", items: items.map(it => ({ blob: it.blob, name: it.name, color: it.color, kind: it.kind })), src: name };
    f.id = nextId(this.doc);
    const end = this.doc.end ?? this.doc.features.length;
    this.doc.features.splice(end, 0, f);
    items.forEach((it, k) => {
      const bid = items.length === 1 ? f.id : `${f.id}:${k}`;
      const lk = {};
      if (it.name) lk.name = it.name;
      if (it.color) lk.color = it.color;
      if (Object.keys(lk).length) this.doc.looks[bid] = lk;
    });
    const meshes = items.filter(it => it.kind === "mesh").length;
    if (meshes) toast(tr("mod.importate_mesh", meshes), false, 6000);
    if (this.hist) this.commit(tr("mod.importa") + " " + name);
    this.say("");
  }

  // ---------------------------------------------------------------------------------------------- salvataggio
  async save(target) {
    const ext = target.split(".").pop().toLowerCase();
    if (this.sketch) await this.finishSketch();
    const { cdoc } = compile(this.doc);
    const looks = {};
    (this.res?.bodies || []).forEach((b, i) => { looks[b.id] = { ...(this.doc.looks[b.id] || {}), name: this.bodyName(b.id, i) }; });
    if (ext === "mbmod") {
      const thumb = this.view.snapshot(360);
      await K.saveDoc({ path: target, doc: this.doc, sid: this.sid, cdoc, looks, thumb }, (p, m) => this.say(m));
      this.say("");
      const switched = target !== this.path;
      this.path = target;
      return { switchTo: switched ? true : undefined };
    }
    await K.exportModel({ sid: this.sid, doc: cdoc, path: target, fmt: ext, looks }, (p, m) => this.say(m));
    this.say("");
    return { switchTo: false };
  }

  dispose() {
    this.gizmo?.dispose();
    this.nodes?.dispose();
    this.tool?.stop?.();
    this.sketch?.stop();
    this.unkey?.();
    window.removeEventListener("keydown", this.onKey, true);
    this.view.dispose();
    K.closeSession(this.sid);
  }
}

export const SAVE_FORMATS = ["mbmod", "step", "stp", "iges", "igs", "brep", "stl", "obj", "glb", "gltf"];
export { WEB };
