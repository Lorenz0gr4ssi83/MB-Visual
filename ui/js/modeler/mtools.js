// Strumenti 3D del modellatore. Ogni lavorazione ha una finestra nel pannello a destra (campi numerici che accettano
// espressioni con i parametri, scelte fatte nella vista: regioni, facce, spigoli, corpi, punti) e l'anteprima calcolata
// dal motore mentre si cambiano i valori. Spingi/Tira e' interattivo come in SketchUp: clic su una faccia o una regione,
// si muove il mouse, clic (o un numero + Invio) per finire.
import { el, toast } from "../core.js";
import { LOCALE, t as tr } from "../i18n.js";
import { evalExpr } from "./mexpr.js";
import { makeRef, vec } from "./mdoc.js";
import { ICON } from "./micons.js";
import { ACCENT, uvTo3 } from "./mview.js";

const fmt = v => (Math.round(v * 1000) / 1000).toLocaleString(LOCALE, { maximumFractionDigits: 3 });
const AX = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

// ------------------------------------------------------------------------------------------------- finestra
export class FeatureTool {
  // spec: { type, title, icon, picks: [{k, label, kinds, min, max}], fields: [...], init(v), build(v, P) -> lavorazione }
  constructor(app, spec, edit = null) {
    this.app = app;
    this.spec = spec;
    this.edit = edit;
    this.v = { ...(spec.defaults || {}) };
    this.P = {}; // slot -> [scelte] (dalla vista) oppure riferimenti esistenti
    this.slot = spec.picks?.[0]?.k || null;
    if (edit) { Object.assign(this.v, spec.fromFeature ? spec.fromFeature(edit) : edit); this.P = spec.picksOf ? spec.picksOf(edit) : {}; }
    else spec.init?.(this, app.sel || []);
    this.err = null;
  }

  start() {
    this.app.view.controls.mouseButtons.LEFT = 0;
    this.render();
    this.schedule();
  }
  stop() { clearTimeout(this.t); this.app.view.selection = []; this.app.view.hover = null; this.app.view.redraw(); }

  // valore numerico di un campo (espressione con i parametri)
  num(k) { const x = this.v[k]; return typeof x === "number" ? x : evalExpr(x, this.app.vals || {}); }

  render() {
    const sp = this.spec, root = this.app.right;
    root.innerHTML = "";
    const head = el("div", { class: "md-dhead" }, el("span", { class: "md-dico", html: ICON[sp.icon] || "" }), el("b", {}, this.edit ? tr("mod.modifica_0", sp.title) : sp.title));
    const body = el("div", { class: "md-dbody" });
    for (const pk of sp.picks || []) {
      if (pk.show && !pk.show(this.v, this)) continue;
      const list = this.P[pk.k] || [];
      const row = el("button", { class: "md-pick" + (this.slot === pk.k ? " on" : ""), type: "button", onclick: () => { this.slot = pk.k; this.render(); this.highlight(); } },
        el("span", { class: "md-pick-l" }, pk.label), el("span", { class: "md-pick-n" }, list.length ? tr("mod.n_scelti", list.length) : tr("mod.da_scegliere")));
      const clr = el("button", { class: "md-mini", type: "button", title: tr("mod.svuota"), html: ICON.x, onclick: e => { e.stopPropagation(); this.P[pk.k] = []; this.changed(); } });
      body.append(el("div", { class: "md-pickrow" }, row, list.length ? clr : null));
      if (this.slot === pk.k) body.append(el("p", { class: "md-hint" }, pk.hint || tr("mod.clic_nella_vista")));
    }
    for (const f of sp.fields || []) {
      if (f.show && !f.show(this.v, this)) continue;
      body.append(this.field(f));
    }
    if (sp.note) body.append(el("p", { class: "md-hint" }, typeof sp.note === "function" ? sp.note(this) : sp.note));
    this.errBox = el("p", { class: "md-err", hidden: !this.err }, this.err || "");
    body.append(this.errBox);
    const ok = el("button", { class: "btn primary", type: "button", onclick: () => this.ok() }, el("span", { html: ICON.ok }), tr("common.ok"));
    const cancel = el("button", { class: "btn", type: "button", onclick: () => this.app.cancelTool() }, tr("common.annulla"));
    root.append(head, body, el("div", { class: "md-dfoot" }, cancel, ok));
    this.highlight();
  }

  field(f) {
    const id = "md-" + f.k + "-" + Math.random().toString(36).slice(2, 6);
    const lab = el("label", { for: id }, f.label);
    let inp;
    if (f.type === "select") {
      inp = el("select", { id, class: "field" }, ...f.options(this).map(([v, l]) => el("option", { value: v, selected: String(this.v[f.k]) === String(v) }, l)));
      inp.addEventListener("change", () => { this.v[f.k] = inp.value; this.changed(true); });
    } else if (f.type === "check") {
      inp = el("input", { id, type: "checkbox", checked: !!this.v[f.k] });
      inp.addEventListener("change", () => { this.v[f.k] = inp.checked; this.changed(true); });
      return el("div", { class: "md-frow md-check" }, inp, lab);
    } else if (f.type === "vec") {
      const box = el("div", { class: "md-vec" });
      const cur = this.v[f.k] || [0, 0, 0];
      ["X", "Y", "Z"].forEach((a, i) => {
        const x = el("input", { class: "field", type: "text", value: String(cur[i] ?? 0), title: a, "aria-label": f.label + " " + a });
        x.addEventListener("change", () => { const c = [...(this.v[f.k] || [0, 0, 0])]; c[i] = this.parse(x.value, x); this.v[f.k] = c; this.changed(); });
        box.append(el("span", { class: "md-ax" }, a), x);
      });
      if (f.pick) box.append(el("button", { class: "md-mini", type: "button", title: tr("mod.scegli_punto"), html: ICON.select, onclick: () => { this.pointFor = f.k; toast(tr("mod.clic_punto"), false, 2500); } }));
      return el("div", { class: "md-frow md-col" }, el("label", {}, f.label), box);
    } else {
      inp = el("input", { id, class: "field", type: "text", value: String(this.v[f.k] ?? ""), spellcheck: "false" });
      inp.addEventListener("change", () => { this.v[f.k] = this.parse(inp.value, inp); this.changed(); });
      inp.addEventListener("keydown", e => { if (e.key === "Enter") { inp.dispatchEvent(new Event("change")); this.ok(); } });
    }
    return el("div", { class: "md-frow" }, lab, inp, f.unit ? el("span", { class: "md-unit" }, f.unit) : null);
  }

  // numero o espressione: numeri semplici restano numeri, il resto e' un'espressione con i parametri
  parse(s, inp) {
    const t = String(s).trim();
    try {
      evalExpr(t, this.app.vals || {});
      inp?.classList.remove("bad");
      return /^[-+]?[0-9]+([.,][0-9]+)?$/.test(t) ? parseFloat(t.replace(",", ".")) : t;
    } catch { inp?.classList.add("bad"); toast(tr("mod.valore_non_valido"), true); return this.v[inp?.dataset?.k] ?? t; }
  }

  changed(rerender = false) {
    if (rerender) this.render(); else this.highlight();
    this.schedule();
  }

  schedule() {
    clearTimeout(this.t);
    this.t = setTimeout(() => this.preview(), 220);
  }

  async preview() {
    let f = null;
    try { f = this.feature(); } catch (e) { this.showErr(e.message); return; }
    if (!f) { this.app.preview(null, this.edit?.id); this.showErr(null); return; }
    const st = await this.app.preview(f, this.edit?.id);
    this.showErr(st && !st.ok ? this.app.errText(st) : null);
  }

  showErr(t) { this.err = t; if (this.errBox) { this.errBox.textContent = t || ""; this.errBox.hidden = !t; } }

  feature() {
    const sp = this.spec;
    for (const pk of sp.picks || []) {
      if (pk.show && !pk.show(this.v, this)) continue;
      if ((this.P[pk.k] || []).length < (pk.min ?? 1)) return null;
    }
    const f = sp.build(this.v, this.P, this);
    if (!f) return null;
    f.type = sp.type;
    if (this.edit) { f.id = this.edit.id; if (this.edit.name) f.name = this.edit.name; }
    return f;
  }

  ok() {
    let f;
    try { f = this.feature(); } catch (e) { return toast(e.message, true); }
    if (!f) return toast(tr("mod.completa_scelte"), true);
    this.app.commitFeature(f, !!this.edit);
  }

  // le scelte restano le stesse anche se l'anteprima cambia la numerazione di facce e spigoli: si ritrovano per posizione
  highlight() {
    const hits = [];
    for (const pk of this.spec.picks || []) for (const p of this.P[pk.k] || []) { const h = p.hit && relocate(this.app.view, p.hit); if (h) hits.push(h); }
    this.app.view.selection = hits;
    this.app.view.redraw();
  }

  // ---- scelte nella vista
  filter() {
    const pk = (this.spec.picks || []).find(p => p.k === this.slot);
    const kinds = new Set(pk?.kinds || []);
    return { faces: kinds.has("face") || kinds.has("point") || kinds.has("body"), edges: kinds.has("edge"), verts: kinds.has("vertex"), regions: kinds.has("region"), bodies: kinds.has("body") && !kinds.has("face") };
  }
  move(e) {
    if (this.pointFor) { this.app.view.hover = null; this.snapPt = this.app.view.snap(e); this.app.view.redraw(); return; }
    const pk = (this.spec.picks || []).find(p => p.k === this.slot);
    if (!pk) return;
    if (pk.kinds.includes("point")) { this.snapPt = this.app.view.snap(e); this.app.view.redraw(); return; }
    const h = this.app.view.pick(e, this.filter());
    this.app.view.hover = h && this.accept(pk, h) ? this.asKind(pk, h) : null;
    this.app.view.redraw();
  }
  asKind(pk, h) {
    if (pk.kinds.includes("body") && !pk.kinds.includes("face") && h.body) return { kind: "body", body: h.body, point: h.point };
    return h;
  }
  accept(pk, h) {
    if (!h) return false;
    const k = h.kind;
    if (k === "face" && pk.kinds.includes("face")) return !pk.planar || h.info?.t === "plane";
    if (k === "face" && pk.kinds.includes("body")) return true;
    return pk.kinds.includes(k) || (k === "edge" && pk.kinds.includes("edge"));
  }
  click(e) {
    const app = this.app, v = app.view;
    if (this.pointFor) {
      const s = v.snap(e);
      if (s) { this.v[this.pointFor] = [s.p.x, s.p.y, s.p.z].map(x => Math.round(x * 1e6) / 1e6); this.spec.onPoint?.(this, this.pointFor, s); }
      this.pointFor = null;
      this.render();
      this.schedule();
      return;
    }
    const pk = (this.spec.picks || []).find(p => p.k === this.slot);
    if (!pk) return;
    let list = this.P[pk.k] || (this.P[pk.k] = []);
    if (list.length && list[0].old) list = this.P[pk.k] = []; // scelte nuove al posto dei riferimenti della lavorazione
    if (pk.kinds.includes("point")) {
      const s = v.snap(e);
      if (!s) return;
      const face = s.face || v.hitFace(e);
      if (pk.planar && face?.info?.t !== "plane") return toast(tr("mod.serve_faccia_piana"), true);
      // tutti i punti sulla stessa faccia (la prima)
      if (list.length && face && list[0].face && face.body !== list[0].face.body) return toast(tr("mod.stessa_faccia"), true);
      list.push({ p: [s.p.x, s.p.y, s.p.z], face: face ? { body: face.body, info: face.info, index: face.index } : list[0]?.face, hit: face ? { kind: "face", body: face.body, index: face.index } : null });
    } else {
      let h = v.pick(e, this.filter());
      if (!this.accept(pk, h)) return;
      h = this.asKind(pk, h);
      // un clic su una faccia mentre si scelgono spigoli: tutti i suoi spigoli
      if (h.kind === "face" && pk.kinds.includes("edge") && !pk.kinds.includes("face")) {
        const b = v.bodies.get(h.body);
        for (const ei of h.info.fe || []) { const eh = { kind: "edge", body: h.body, index: ei, info: b.data.edges[ei] }; if (!list.some(q => sameHit(q.hit, eh))) list.push({ hit: eh }); }
      } else {
        const same = q => sameHit(q.hit, h);
        const i = list.findIndex(same);
        if (i >= 0) list.splice(i, 1);
        else if (pk.max === 1) list.splice(0, list.length, { hit: h });
        else list.push({ hit: h });
      }
    }
    // slot pieno: si passa al successivo
    const pks = (this.spec.picks || []).filter(p => !p.show || p.show(this.v, this));
    const idx = pks.findIndex(p => p.k === this.slot);
    if (pk.max && list.length >= pk.max && pks[idx + 1]) this.slot = pks[idx + 1].k;
    this.spec.onPick?.(this, pk, list);
    this.render();
    this.schedule();
  }
  paint(g) {
    if (!this.snapPt) return;
    const s = this.app.view.toScreen(this.snapPt.p);
    snapMark(g, s, this.snapPt.kind);
    for (const p of this.P[this.slot] || []) if (p.p) { const q = this.app.view.toScreen(p.p); g.fillStyle = ACCENT; g.beginPath(); g.arc(q[0], q[1], 4, 0, 7); g.fill(); }
  }
}

// stessa faccia/spigolo/regione: per firma geometrica (centro, tipo), non per numero
const near = (a, b, tol = 1e-6) => a && b && Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tol;
function sameHit(a, b) {
  if (!a || !b || a.kind !== b.kind || a.body !== b.body) return false;
  if (a.kind === "body") return true;
  if (a.kind === "region") return a.sketch === b.sketch && a.region?.sig?.ents?.join() === b.region?.sig?.ents?.join() && Math.hypot(a.region.c[0] - b.region.c[0], a.region.c[1] - b.region.c[1]) < 1e-6;
  if (a.kind === "vertex") return a.point && b.point && a.point.distanceTo(b.point) < 1e-6;
  return a.info?.t === b.info?.t && near(a.info?.c, b.info?.c, 1e-4);
}
function relocate(view, h) {
  if (h.kind === "body" || h.kind === "region" || h.kind === "vertex") return h;
  const b = view.bodies.get(h.body);
  if (!b) return null;
  const list = h.kind === "edge" ? b.data.edges : b.data.faces;
  if (list[h.index] && sameHit({ ...h, info: list[h.index] }, h)) return h;
  let best = -1, bd = Infinity;
  list.forEach((q, i) => { if (q.t !== h.info?.t) return; const d = Math.hypot(...q.c.map((x, k) => x - h.info.c[k])); if (d < bd) { bd = d; best = i; } });
  const size = Math.max(1, Math.hypot(...b.data.bbox.slice(3).map((x, k) => x - b.data.bbox[k])));
  return best >= 0 && bd < size * 0.02 ? { ...h, index: best, info: list[best] } : null;
}

export function snapMark(g, s, kind) {
  g.strokeStyle = ACCENT; g.lineWidth = 1.8;
  g.beginPath();
  if (kind === "vertex") g.rect(s[0] - 5, s[1] - 5, 10, 10);
  else if (kind === "center") g.arc(s[0], s[1], 6, 0, 7);
  else if (kind === "mid") { g.moveTo(s[0], s[1] - 6); g.lineTo(s[0] + 6, s[1] + 5); g.lineTo(s[0] - 6, s[1] + 5); g.closePath(); }
  else if (kind === "edge") { g.moveTo(s[0] - 5, s[1] - 5); g.lineTo(s[0] + 5, s[1] + 5); g.moveTo(s[0] + 5, s[1] - 5); g.lineTo(s[0] - 5, s[1] + 5); }
  else { g.moveTo(s[0] - 6, s[1]); g.lineTo(s[0] + 6, s[1]); g.moveTo(s[0], s[1] - 6); g.lineTo(s[0], s[1] + 6); }
  g.stroke();
}

// riferimento salvato dalla scelta nella vista (o quello esistente della lavorazione)
const refOf = (p, k) => (p.ref ? p.ref : makeRef(p.hit.body, k, p.hit.info));
const oldRefs = refs => (refs || []).map(r => ({ ref: r, old: true }));
const regionsOf = P => (P.prof || []);

// ------------------------------------------------------------------------------------------------- definizioni
const OPS = () => [["join", tr("mod.op_unisci")], ["cut", tr("mod.op_sottrai")], ["common", tr("mod.op_interseca")], ["new", tr("mod.op_nuovo")]];

export function specs(app) {
  const profilePick = { k: "prof", label: tr("mod.profili"), kinds: ["region"], min: 1, hint: tr("mod.scegli_regioni") };
  const profFrom = f => ({ prof: (f.profiles || []).map(sig => ({ sig, sketch: f.sketch, old: true })) });
  const profBuild = P => {
    const L = regionsOf(P);
    const sketch = L[0].sketch || L[0].hit?.sketch;
    return { sketch, profiles: L.filter(p => (p.sketch || p.hit?.sketch) === sketch).map(p => p.sig || p.hit.region.sig) };
  };
  return {
    extrude: {
      type: "extrude", title: tr("mod.estrudi"), icon: "extrude", picks: [profilePick],
      defaults: { d: 10, mode: "one", d2: 10, through: false, op: "join" },
      init(T, sel) { const r = sel.filter(s => s.kind === "region"); if (r.length) { T.P.prof = r.map(hit => ({ hit })); T.slot = null; } },
      fromFeature: f => ({ ...f }), picksOf: profFrom,
      fields: [
        { k: "d", label: tr("mod.distanza"), unit: "mm" },
        { k: "mode", label: tr("mod.direzione"), type: "select", options: () => [["one", tr("mod.dir_una")], ["sym", tr("mod.dir_simmetrica")], ["two", tr("mod.dir_due")]] },
        { k: "d2", label: tr("mod.distanza_2"), unit: "mm", show: v => v.mode === "two" },
        { k: "through", label: tr("mod.passante"), type: "check" },
        { k: "op", label: tr("mod.operazione"), type: "select", options: OPS },
      ],
      build: (v, P) => ({ ...profBuild(P), d: v.d, mode: v.mode, d2: v.d2, through: v.through, op: v.op }),
    },
    revolve: {
      type: "revolve", title: tr("mod.rivoluzione"), icon: "revolve", picks: [profilePick],
      defaults: { ang: 360, op: "join", axis: "x" },
      init(T, sel) { const r = sel.filter(s => s.kind === "region"); if (r.length) { T.P.prof = r.map(hit => ({ hit })); T.slot = null; } },
      fromFeature: f => ({ ...f, axis: f.axis?.e ? "e:" + f.axis.e : f.axis?.std || "x" }), picksOf: profFrom,
      fields: [
        { k: "axis", label: tr("mod.asse"), type: "select", options: T => axisOptions(app, T) },
        { k: "ang", label: tr("mod.angolo"), unit: "°" },
        { k: "op", label: tr("mod.operazione"), type: "select", options: OPS },
      ],
      build: (v, P) => ({ ...profBuild(P), ang: v.ang, op: v.op, axis: String(v.axis).startsWith("e:") ? { e: String(v.axis).slice(2) } : { std: v.axis } }),
    },
    hole: {
      type: "hole", title: tr("mod.foro"), icon: "hole",
      picks: [{ k: "pts", label: tr("mod.centri"), kinds: ["point"], planar: true, min: 1, hint: tr("mod.scegli_centri_foro") }],
      defaults: { dia: 6, depth: 10, through: true, kind: "simple", cbd: 11, cbh: 6, csd: 12, csa: 90, tip: false },
      fromFeature: f => ({ ...f }),
      picksOf: f => ({ pts: (f.pts || []).map(p => ({ p, ref: f.face, old: true })) }),
      fields: [
        { k: "kind", label: tr("mod.tipo"), type: "select", options: () => [["simple", tr("mod.foro_semplice")], ["cbore", tr("mod.foro_lamato")], ["csink", tr("mod.foro_svasato")]] },
        { k: "dia", label: tr("mod.diametro"), unit: "mm" },
        { k: "through", label: tr("mod.passante"), type: "check" },
        { k: "depth", label: tr("mod.profondita"), unit: "mm", show: v => !v.through },
        { k: "tip", label: tr("mod.punta_118"), type: "check", show: v => !v.through },
        { k: "cbd", label: tr("mod.diam_lamatura"), unit: "mm", show: v => v.kind === "cbore" },
        { k: "cbh", label: tr("mod.prof_lamatura"), unit: "mm", show: v => v.kind === "cbore" },
        { k: "csd", label: tr("mod.diam_svasatura"), unit: "mm", show: v => v.kind === "csink" },
        { k: "csa", label: tr("mod.angolo_svasatura"), unit: "°", show: v => v.kind === "csink" },
      ],
      build: (v, P) => {
        const L = P.pts;
        const face = L[0].ref || makeRef(L[0].face.body, "f", L[0].face.info);
        return { face, pts: L.map(p => p.p), dia: v.dia, depth: v.depth, through: v.through, kind: v.kind, cbd: v.cbd, cbh: v.cbh, csd: v.csd, csa: v.csa, tip: v.tip };
      },
    },
    fillet: {
      type: "fillet", title: tr("mod.raccordo"), icon: "fillet",
      picks: [{ k: "edges", label: tr("mod.spigoli"), kinds: ["edge"], min: 1, hint: tr("mod.scegli_spigoli") }],
      defaults: { r: 2 },
      init(T, sel) { const e = sel.filter(s => s.kind === "edge"); if (e.length) T.P.edges = e.map(hit => ({ hit })); },
      fromFeature: f => ({ ...f }), picksOf: f => ({ edges: oldRefs(f.edges) }),
      fields: [{ k: "r", label: tr("mod.raggio"), unit: "mm" }],
      build: (v, P) => ({ edges: P.edges.map(p => refOf(p, "e")), r: v.r }),
    },
    chamfer: {
      type: "chamfer", title: tr("mod.smusso"), icon: "chamfer",
      picks: [{ k: "edges", label: tr("mod.spigoli"), kinds: ["edge"], min: 1, hint: tr("mod.scegli_spigoli") }],
      defaults: { d: 1 },
      init(T, sel) { const e = sel.filter(s => s.kind === "edge"); if (e.length) T.P.edges = e.map(hit => ({ hit })); },
      fromFeature: f => ({ ...f }), picksOf: f => ({ edges: oldRefs(f.edges) }),
      fields: [{ k: "d", label: tr("mod.distanza"), unit: "mm" }],
      build: (v, P) => ({ edges: P.edges.map(p => refOf(p, "e")), d: v.d }),
    },
    shell: {
      type: "shell", title: tr("mod.guscio"), icon: "shell",
      picks: [{ k: "faces", label: tr("mod.facce_da_togliere"), kinds: ["face"], min: 1, hint: tr("mod.scegli_facce_aperte") }],
      defaults: { t: 2, out: false },
      init(T, sel) { const e = sel.filter(s => s.kind === "face"); if (e.length) T.P.faces = e.map(hit => ({ hit })); },
      fromFeature: f => ({ ...f }), picksOf: f => ({ faces: oldRefs(f.faces) }),
      fields: [{ k: "t", label: tr("mod.spessore"), unit: "mm" }, { k: "out", label: tr("mod.verso_esterno"), type: "check" }],
      build: (v, P) => { const faces = P.faces.map(p => refOf(p, "f")); return { body: faces[0].b, faces, t: v.t, out: v.out }; },
    },
    delface: {
      type: "delface", title: tr("mod.elimina_faccia"), icon: "delface",
      picks: [{ k: "faces", label: tr("mod.facce"), kinds: ["face"], min: 1, hint: tr("mod.scegli_facce_elimina") }],
      init(T, sel) { const e = sel.filter(s => s.kind === "face"); if (e.length) T.P.faces = e.map(hit => ({ hit })); },
      fromFeature: f => ({ ...f }), picksOf: f => ({ faces: oldRefs(f.faces) }),
      note: tr("mod.nota_elimina_faccia"),
      build: (v, P) => ({ faces: P.faces.map(p => refOf(p, "f")) }),
    },
    pushpull: {
      type: "pushpull", title: tr("mod.spingi_tira"), icon: "pushpull",
      picks: [{ k: "face", label: tr("mod.faccia"), kinds: ["face"], min: 1, max: 1 }],
      defaults: { d: 5 },
      fromFeature: f => ({ ...f }), picksOf: f => ({ face: oldRefs([f.face]) }),
      fields: [{ k: "d", label: tr("mod.distanza"), unit: "mm" }],
      build: (v, P) => ({ face: refOf(P.face[0], "f"), d: v.d }),
    },
    boolean: {
      type: "boolean", title: tr("mod.booleana"), icon: "union",
      picks: [{ k: "a", label: tr("mod.corpo_destinazione"), kinds: ["body"], min: 1, max: 1 }, { k: "b", label: tr("mod.corpi_strumento"), kinds: ["body"], min: 1 }],
      defaults: { op: "join", keep: false },
      init(T, sel) {
        const b = [...new Set(sel.filter(s => s.body).map(s => s.body))];
        if (b.length) { T.P.a = [{ hit: { kind: "body", body: b[0] } }]; T.slot = "b"; }
        if (b.length > 1) T.P.b = b.slice(1).map(x => ({ hit: { kind: "body", body: x } }));
      },
      fromFeature: f => ({ ...f }), picksOf: f => ({ a: [{ hit: { kind: "body", body: f.a } }], b: (f.b || []).map(x => ({ hit: { kind: "body", body: x } })) }),
      fields: [
        { k: "op", label: tr("mod.operazione"), type: "select", options: () => [["join", tr("mod.op_unisci")], ["cut", tr("mod.op_sottrai")], ["common", tr("mod.op_interseca")]] },
        { k: "keep", label: tr("mod.mantieni_strumenti"), type: "check" },
      ],
      build: (v, P) => ({ op: v.op, a: P.a[0].hit.body, b: P.b.map(p => p.hit.body), keep: v.keep }),
    },
    transform: {
      type: "transform", title: tr("mod.trasforma"), icon: "move",
      picks: [{ k: "bodies", label: tr("mod.corpi"), kinds: ["body"], min: 1 }, { k: "axis", label: tr("mod.asse_riferimento"), kinds: ["edge", "face"], min: 0, max: 1, show: v => v.k === "rotate" && v.ax === "ref", hint: tr("mod.scegli_asse") }],
      defaults: { k: "move", v: [10, 0, 0], ax: "Z", c: [0, 0, 0], ang: 90, f: 2, n: "Z", copy: false },
      init(T, sel) { const b = [...new Set(sel.filter(s => s.body).map(s => s.body))]; if (b.length) { T.P.bodies = b.map(x => ({ hit: { kind: "body", body: x } })); T.slot = null; } T.v.c = centerOf(app, b); },
      fromFeature: f => ({ ...f, k: f.tf.k, v: f.tf.v || [0, 0, 0], c: f.tf.c || f.tf.o || [0, 0, 0], ang: f.tf.ang ?? 90, f: f.tf.f ?? 2, ax: f.tf.ax || "Z", n: f.tf.nn || "Z", axref: f.tf.d }),
      picksOf: f => ({ bodies: (f.bodies || []).map(x => ({ hit: { kind: "body", body: x } })) }),
      fields: [
        { k: "k", label: tr("mod.trasformazione"), type: "select", options: () => [["move", tr("mod.sposta")], ["rotate", tr("mod.ruota")], ["scale", tr("mod.scala")], ["mirror", tr("mod.specchia")]] },
        { k: "v", label: tr("mod.spostamento"), type: "vec", show: v => v.k === "move" },
        { k: "from", label: tr("mod.da_punto_a_punto"), type: "vec", pick: true, show: v => v.k === "move" },
        { k: "ax", label: tr("mod.asse"), type: "select", show: v => v.k === "rotate", options: () => [["X", "X"], ["Y", "Y"], ["Z", "Z"], ["ref", tr("mod.da_spigolo_faccia")]] },
        { k: "c", label: tr("mod.centro"), type: "vec", pick: true, show: v => v.k !== "move" },
        { k: "ang", label: tr("mod.angolo"), unit: "°", show: v => v.k === "rotate" },
        { k: "f", label: tr("mod.fattore"), show: v => v.k === "scale" },
        { k: "n", label: tr("mod.piano_specchio"), type: "select", show: v => v.k === "mirror", options: () => [["Z", tr("mod.piano_xy")], ["Y", tr("mod.piano_xz")], ["X", tr("mod.piano_yz")]] },
        { k: "copy", label: tr("mod.copia"), type: "check" },
      ],
      onPoint(T, k, s) {
        // "da punto a punto": il primo punto scelto e' l'origine, il secondo la destinazione
        if (k !== "from") return;
        const p = [s.p.x, s.p.y, s.p.z];
        if (!T.fromPt) { T.fromPt = p; T.v.from = p; toast(tr("mod.clic_destinazione"), false, 2500); setTimeout(() => (T.pointFor = "from"), 0); }
        else { T.v.v = vec.sub(p, T.fromPt).map(x => Math.round(x * 1e6) / 1e6); T.fromPt = null; }
      },
      build: (v, P, T) => {
        const bodies = P.bodies.map(p => p.hit.body);
        const num = x => (typeof x === "number" ? x : evalExpr(x, app.vals || {}));
        let tf;
        if (v.k === "move") tf = { k: "move", v: v.v };
        else if (v.k === "rotate") {
          let o = v.c, d = AX[v.ax] || AX.Z;
          if (v.ax === "ref") {
            const a = (P.axis || [])[0]?.hit;
            const ax = a ? axisOfHit(a) : v.axref ? { o: v.c, d: v.axref } : null;
            if (!ax) return null;
            o = ax.o; d = ax.d;
          }
          tf = { k: "rotate", o, d, ang: v.ang, ax: v.ax, c: v.c };
        } else if (v.k === "scale") tf = { k: "scale", c: v.c, f: v.f };
        else tf = { k: "mirror", o: v.c, n: AX[v.n] || AX.Z, nn: v.n };
        void num; void T;
        return { bodies, tf, copy: v.copy };
      },
    },
    pattern: {
      type: "pattern", title: tr("mod.serie"), icon: "pattern",
      picks: [{ k: "bodies", label: tr("mod.corpi"), kinds: ["body"], min: 1 }],
      defaults: { kind: "linear", dir: "X", n: 3, s: 20, dir2: "Y", n2: 1, s2: 20, ax: "Z", o: [0, 0, 0], ang: 360, fuse: false },
      init(T, sel) { const b = [...new Set(sel.filter(s => s.body).map(s => s.body))]; if (b.length) { T.P.bodies = b.map(x => ({ hit: { kind: "body", body: x } })); T.slot = null; } },
      fromFeature: f => ({ ...f, dir: dirName(f.d), dir2: dirName(f.d2), ax: dirName(f.ax) }),
      picksOf: f => ({ bodies: (f.bodies || []).map(x => ({ hit: { kind: "body", body: x } })) }),
      fields: [
        { k: "kind", label: tr("mod.tipo"), type: "select", options: () => [["linear", tr("mod.serie_lineare")], ["circular", tr("mod.serie_circolare")]] },
        { k: "dir", label: tr("mod.direzione"), type: "select", show: v => v.kind === "linear", options: () => ["X", "Y", "Z", "-X", "-Y", "-Z"].map(a => [a, a]) },
        { k: "n", label: tr("mod.numero"), show: v => true },
        { k: "s", label: tr("mod.passo"), unit: "mm", show: v => v.kind === "linear" },
        { k: "dir2", label: tr("mod.direzione_2"), type: "select", show: v => v.kind === "linear", options: () => ["X", "Y", "Z", "-X", "-Y", "-Z"].map(a => [a, a]) },
        { k: "n2", label: tr("mod.numero_2"), show: v => v.kind === "linear" },
        { k: "s2", label: tr("mod.passo_2"), unit: "mm", show: v => v.kind === "linear" },
        { k: "ax", label: tr("mod.asse"), type: "select", show: v => v.kind === "circular", options: () => ["X", "Y", "Z"].map(a => [a, a]) },
        { k: "o", label: tr("mod.centro"), type: "vec", pick: true, show: v => v.kind === "circular" },
        { k: "ang", label: tr("mod.angolo_totale"), unit: "°", show: v => v.kind === "circular" },
        { k: "fuse", label: tr("mod.unisci_copie"), type: "check" },
      ],
      build: (v, P) => ({ bodies: P.bodies.map(p => p.hit.body), kind: v.kind, d: dirVec(v.dir), n: v.n, s: v.s, d2: dirVec(v.dir2), n2: v.n2, s2: v.s2, ax: dirVec(v.ax), o: v.o, ang: v.ang, fuse: v.fuse }),
    },
    mate: {
      type: "mate", title: tr("mod.accoppia"), icon: "mate",
      picks: [{ k: "a", label: tr("mod.rif_mobile"), kinds: ["face", "edge"], min: 1, max: 1, hint: tr("mod.scegli_rif_mobile") }, { k: "b", label: tr("mod.rif_fisso"), kinds: ["face", "edge"], min: 1, max: 1, hint: tr("mod.scegli_rif_fisso") }],
      defaults: { kind: "coinc", off: 0, flip: false },
      fromFeature: f => ({ ...f }), picksOf: f => ({ a: oldRefs([f.a]), b: oldRefs([f.b]) }),
      fields: [
        { k: "kind", label: tr("mod.tipo"), type: "select", options: () => [["coinc", tr("mod.mate_coinc")], ["conc", tr("mod.mate_conc")]] },
        { k: "off", label: tr("mod.distanza"), unit: "mm" },
        { k: "flip", label: tr("mod.inverti"), type: "check" },
      ],
      onPick(T, pk, list) {
        const h = list[0]?.hit;
        if (pk.k === "a" && h) T.v.kind = h.kind === "edge" || ["cyl", "cone"].includes(h.info?.t) ? "conc" : "coinc";
      },
      build: (v, P) => {
        const a = refOf(P.a[0], P.a[0].ref?.k || (P.a[0].hit.kind === "edge" ? "e" : "f")), b = refOf(P.b[0], P.b[0].ref?.k || (P.b[0].hit.kind === "edge" ? "e" : "f"));
        if (a.b === b.b) throw new Error(tr("mod.corpi_diversi"));
        return { move: a.b, a, b, kind: v.kind, off: v.off, flip: v.flip };
      },
    },
    split: {
      type: "split", title: tr("mod.dividi"), icon: "split",
      picks: [{ k: "bodies", label: tr("mod.corpi"), kinds: ["body"], min: 1 }, { k: "face", label: tr("mod.faccia_piana"), kinds: ["face"], planar: true, min: 0, max: 1, show: v => v.pl === "face" }],
      defaults: { pl: "Z", o: [0, 0, 0] },
      init(T, sel) { const b = [...new Set(sel.filter(s => s.body).map(s => s.body))]; if (b.length) { T.P.bodies = b.map(x => ({ hit: { kind: "body", body: x } })); T.slot = null; } T.v.o = centerOf(app, b); },
      fromFeature: f => ({ ...f, pl: dirName(f.n) }), picksOf: f => ({ bodies: (f.bodies || []).map(x => ({ hit: { kind: "body", body: x } })) }),
      fields: [
        { k: "pl", label: tr("mod.piano"), type: "select", options: () => [["Z", tr("mod.piano_xy")], ["Y", tr("mod.piano_xz")], ["X", tr("mod.piano_yz")], ["face", tr("mod.da_faccia")]] },
        { k: "o", label: tr("mod.passante_per"), type: "vec", pick: true, show: v => v.pl !== "face" },
      ],
      build: (v, P) => {
        if (v.pl === "face") { const f = P.face?.[0]?.hit; if (!f) return null; return { bodies: P.bodies.map(p => p.hit.body), o: f.info.o, n: f.info.n }; }
        return { bodies: P.bodies.map(p => p.hit.body), o: v.o, n: AX[v.pl] };
      },
    },
    primitive: {
      type: "primitive", title: tr("mod.solido_base"), icon: "box", picks: [],
      defaults: { shape: "box", p: [0, 0, 0], dx: 50, dy: 30, dz: 20, r: 10, r2: 3, h: 30, op: "join" },
      fromFeature: f => ({ ...f }),
      fields: [
        { k: "shape", label: tr("mod.forma"), type: "select", options: () => [["box", tr("mod.parallelepipedo")], ["cyl", tr("mod.cilindro")], ["sphere", tr("mod.sfera")], ["cone", tr("mod.cono")], ["torus", tr("mod.toro")]] },
        { k: "p", label: tr("mod.posizione"), type: "vec", pick: true },
        { k: "dx", label: "X", unit: "mm", show: v => v.shape === "box" },
        { k: "dy", label: "Y", unit: "mm", show: v => v.shape === "box" },
        { k: "dz", label: "Z", unit: "mm", show: v => v.shape === "box" },
        { k: "r", label: tr("mod.raggio"), unit: "mm", show: v => v.shape !== "box" },
        { k: "r2", label: tr("mod.raggio_2"), unit: "mm", show: v => v.shape === "cone" || v.shape === "torus" },
        { k: "h", label: tr("mod.altezza"), unit: "mm", show: v => v.shape === "cyl" || v.shape === "cone" },
        { k: "op", label: tr("mod.operazione"), type: "select", options: OPS },
      ],
      build: v => ({ shape: v.shape, p: v.p, dx: v.dx, dy: v.dy, dz: v.dz, r: v.r, r2: v.r2, h: v.h, op: v.op }),
    },
  };
}

function axisOptions(app, T) {
  const out = [["x", tr("mod.asse_x_schizzo")], ["y", tr("mod.asse_y_schizzo")]];
  const sid = (T.P.prof || [])[0]?.sketch || (T.P.prof || [])[0]?.hit?.sketch;
  const sk = app.doc.features.find(f => f.id === sid)?.sk;
  if (sk) sk.ents.filter(e => e.t === "line").forEach((e, i) => out.push(["e:" + e.id, (e.cons ? tr("mod.linea_costruzione") : tr("mod.linea")) + " " + (i + 1)]));
  return out;
}
const dirVec = n => { const s = String(n || "X"); const v = AX[s.replace("-", "")] || AX.X; return s.startsWith("-") ? v.map(x => -x) : v; };
const dirName = d => { if (!Array.isArray(d)) return "X"; const i = d.findIndex(x => Math.abs(x) > 0.5); return (d[i] < 0 ? "-" : "") + "XYZ"[i < 0 ? 0 : i]; };
function axisOfHit(h) {
  const i = h.info || {};
  if (h.kind === "edge" && i.t === "circle") return { o: i.o, d: i.d };
  if (h.kind === "edge" && i.t === "line") return { o: i.a0 || i.c, d: i.d };
  if (h.kind === "face" && ["cyl", "cone"].includes(i.t)) return { o: i.o, d: i.n };
  if (h.kind === "face" && i.t === "plane") return { o: i.c, d: i.n };
  return null;
}
function centerOf(app, ids) {
  const b = ids.map(id => app.bodyData(id)).filter(Boolean);
  if (!b.length) return [0, 0, 0];
  const bb = b.map(x => x.bbox);
  const mn = [0, 1, 2].map(k => Math.min(...bb.map(q => q[k]))), mx = [0, 1, 2].map(k => Math.max(...bb.map(q => q[k + 3])));
  return mn.map((v, k) => Math.round((v + mx[k]) / 2 * 1000) / 1000);
}

// ------------------------------------------------------------------------------------------------- Spingi/Tira
export class PushPull {
  constructor(app) { this.app = app; this.target = null; this.d = 0; }
  start() { this.app.view.controls.mouseButtons.LEFT = 0; this.app.right.innerHTML = ""; this.app.right.append(el("div", { class: "md-dhead" }, el("span", { class: "md-dico", html: ICON.pushpull }), el("b", {}, tr("mod.spingi_tira"))), el("p", { class: "md-hint" }, tr("mod.spingi_tira_aiuto"))); }
  stop() { this.input?.remove(); this.app.view.hover = null; this.app.view.redraw(); }
  hit(e) {
    const h = this.app.view.pick(e, { faces: true, edges: false, verts: false, regions: true });
    if (!h) return null;
    if (h.kind === "face" && !["plane", "cyl", "cone"].includes(h.info?.t)) return null;
    if (h.kind === "face" && this.app.bodyData(h.body)?.kind === "mesh") return null;
    return h;
  }
  frame(h) {
    // asse della trazione: normale del piano della regione o della faccia, passante per il punto cliccato
    if (h.kind === "region") { const s = this.app.view.sketches.find(q => q.id === h.sketch); return { o: [h.point.x, h.point.y, h.point.z], n: s.plane.n, plane: s.plane }; }
    const i = h.info;
    if (i.t === "plane") return { o: [h.point.x, h.point.y, h.point.z], n: i.n };
    // cilindro: direzione radiale nel punto (allontana dall'asse)
    const p = [h.point.x, h.point.y, h.point.z], ax = vec.unit(i.n), rel = vec.sub(p, i.o);
    const radial = vec.unit(vec.sub(rel, vec.mul(ax, vec.dot(rel, ax))));
    return { o: p, n: i.in ? vec.mul(radial, -1) : radial, radial: true };
  }
  move(e) {
    const v = this.app.view;
    if (!this.target) { v.hover = this.hit(e); v.redraw(); return; }
    // distanza = punto della retta (o, n) piu' vicino al raggio del mouse; aggancio ai vertici dei corpi
    const fr = this.frame0;
    const s = v.snap(e, { tol: 9, faces: false });
    let d;
    if (s && ["vertex", "center", "mid"].includes(s.kind)) d = vec.dot(vec.sub([s.p.x, s.p.y, s.p.z], fr.o), fr.n);
    else d = closestOnAxis(v.ray(e).ray, fr.o, fr.n);
    const step = v.pxSize(new (v.camera.position.constructor)(...fr.o)) * 2;
    this.d = Math.abs(d) < step ? 0 : d;
    this.snapK = s?.kind;
    v.redraw();
  }
  click(e) {
    if (!this.target) {
      const h = this.hit(e);
      if (!h) return;
      this.target = h;
      this.frame0 = this.frame(h);
      this.d = 0;
      this.app.view.hover = null;
      this.app.view.selection = [h];
      this.app.say(tr("mod.spingi_tira_stato"));
      this.app.view.redraw();
      return;
    }
    this.finish(this.d);
  }
  key(e) {
    if (!this.target) return false;
    if (/^[0-9.,-]$/.test(e.key) && !e.ctrlKey) {
      e.preventDefault();
      if (!this.input) {
        this.input = el("input", { class: "md-vinput", type: "text", placeholder: tr("mod.distanza") });
        this.input.addEventListener("keydown", ev => {
          ev.stopPropagation();
          if (ev.key === "Enter") {
            const raw = this.input.value.trim();
            let d;
            try { d = evalExpr(raw, this.app.vals || {}); } catch { return toast(tr("mod.valore_non_valido"), true); }
            this.input.remove();
            this.input = null;
            // un numero senza segno va nel verso in cui si sta trascinando
            this.finish(raw.startsWith("-") ? d : d * (this.d < 0 ? -1 : 1));
          }
          if (ev.key === "Escape") { this.input.remove(); this.input = null; }
        });
        this.app.view.host.append(this.input);
        const s = this.app.view.toScreen(vec.add(this.frame0.o, vec.mul(this.frame0.n, this.d)));
        Object.assign(this.input.style, { left: s[0] + 16 + "px", top: s[1] + 12 + "px" });
      }
      this.input.value = e.key;
      this.input.focus();
      return true;
    }
    if (e.key === "Escape") { this.target = null; this.app.view.selection = []; this.app.view.redraw(); return true; }
    return false;
  }
  finish(d) {
    const h = this.target;
    this.target = null;
    this.app.view.selection = [];
    if (!d || Math.abs(d) < 1e-9) { this.app.view.redraw(); return; }
    d = Math.round(d * 1000) / 1000;
    if (h.kind === "region") {
      const sk = this.app.doc.features.find(f => f.id === h.sketch);
      const onFace = !!sk?.plane?.face;
      this.app.commitFeature({ type: "extrude", sketch: h.sketch, profiles: [h.region.sig], d, mode: "one", op: onFace && d < 0 ? "cut" : "join" });
    } else {
      this.app.commitFeature({ type: "pushpull", face: makeRef(h.body, "f", h.info), d: this.frame0.radial ? d : d });
    }
  }
  paint(g) {
    const v = this.app.view, h = this.target;
    if (!h) return;
    const off = vec.mul(this.frame0.n, this.d);
    g.strokeStyle = ACCENT; g.fillStyle = "rgba(240,125,46,.22)"; g.lineWidth = 1.6;
    // contorno spostato + lati
    const outline = [];
    if (h.kind === "region") {
      const s = v.sketches.find(q => q.id === h.sketch);
      for (const poly of [h.region.poly, ...h.region.holePolys]) outline.push(poly.map(uv => uvTo3(s.plane, uv)));
    } else {
      const b = v.bodies.get(h.body);
      for (const ei of h.info.fe || []) {
        const m = b.data.mesh, st = m.er[ei * 2], n = m.er[ei * 2 + 1];
        const pts = [];
        for (let i = st; i < st + n; i++) pts.push([m.ep[i * 3], m.ep[i * 3 + 1], m.ep[i * 3 + 2]]);
        outline.push(pts);
      }
    }
    for (const poly of outline) {
      const top = poly.map(p => v.toScreen(vec.add(p, off)));
      g.beginPath();
      top.forEach((s, i) => (i ? g.lineTo(s[0], s[1]) : g.moveTo(s[0], s[1])));
      if (h.kind === "region") g.closePath();
      g.stroke();
      const step = Math.max(1, Math.floor(poly.length / 24));
      for (let i = 0; i < poly.length; i += step) { const a = v.toScreen(poly[i]), b2 = top[i]; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b2[0], b2[1]); g.stroke(); }
    }
    const tip = v.toScreen(vec.add(this.frame0.o, off));
    g.font = "600 12px 'IBM Plex Sans', sans-serif";
    const txt = fmt(this.d) + " mm";
    const w = g.measureText(txt).width + 10;
    g.fillStyle = "rgba(30,32,34,.85)"; g.fillRect(tip[0] + 14, tip[1] - 24, w, 18);
    g.fillStyle = "#fff"; g.textBaseline = "middle"; g.fillText(txt, tip[0] + 19, tip[1] - 15);
    if (this.snapK) snapMark(g, tip, this.snapK);
  }
}

function closestOnAxis(ray, o, n) {
  // parametro t sulla retta o + t n piu' vicino al raggio
  const d1 = [ray.direction.x, ray.direction.y, ray.direction.z], p1 = [ray.origin.x, ray.origin.y, ray.origin.z];
  const w = vec.sub(o, p1);
  const a = vec.dot(n, n), b = vec.dot(n, d1), c = vec.dot(d1, d1), dd = vec.dot(n, w), e = vec.dot(d1, w);
  const den = a * c - b * b;
  if (Math.abs(den) < 1e-12) return 0;
  return (b * e - c * dd) / den;
}

// ------------------------------------------------------------------------------------------------- Misura
export class Measure {
  constructor(app) { this.app = app; this.picks = []; this.res = null; }
  start() { this.app.view.controls.mouseButtons.LEFT = 0; this.render(); }
  stop() { this.app.view.selection = []; this.app.view.hover = null; this.app.view.redraw(); }
  render() {
    const r = this.app.right;
    r.innerHTML = "";
    r.append(el("div", { class: "md-dhead" }, el("span", { class: "md-dico", html: ICON.measure }), el("b", {}, tr("mod.misura"))), el("p", { class: "md-hint" }, tr("mod.misura_aiuto")));
    const dl = el("dl", { class: "kv stack" });
    const add = (k, v) => dl.append(el("dt", {}, k), el("dd", {}, v));
    const R = this.res || {};
    if (R.d !== undefined) add(tr("mod.distanza_minima"), fmt(R.d) + " mm");
    if (R.dx !== undefined) { add("ΔX", fmt(R.dx) + " mm"); add("ΔY", fmt(R.dy) + " mm"); add("ΔZ", fmt(R.dz) + " mm"); }
    if (R.ang !== undefined) add(tr("mod.angolo"), fmt(R.ang) + "°");
    if (R.area !== undefined) add(tr("mod.area"), fmt(R.area) + " mm²");
    if (R.len !== undefined) add(tr("mod.lunghezza"), fmt(R.len) + " mm");
    if (R.r !== undefined) add(tr("mod.raggio"), fmt(R.r) + " mm");
    if (R.vol !== undefined) add(tr("mod.volume"), fmt(R.vol) + " mm³");
    r.append(dl, el("div", { class: "md-dfoot" }, el("button", { class: "btn", type: "button", onclick: () => { this.picks = []; this.res = null; this.app.view.selection = []; this.render(); this.app.view.redraw(); } }, tr("mod.nuova_misura")), el("button", { class: "btn", type: "button", onclick: () => this.app.cancelTool() }, tr("common.chiudi"))));
  }
  move(e) {
    const v = this.app.view;
    this.snap = v.snap(e, { tol: 10 });
    v.hover = this.snap && ["vertex", "center", "mid"].includes(this.snap.kind) ? null : v.pick(e, { faces: true, edges: true });
    v.redraw();
  }
  async click(e) {
    const v = this.app.view;
    let item;
    if (this.snap && ["vertex", "center", "mid"].includes(this.snap.kind)) item = { ref: { k: "p", c: [this.snap.p.x, this.snap.p.y, this.snap.p.z] }, p: this.snap.p };
    else {
      const h = v.pick(e, { faces: true, edges: true });
      if (!h || h.kind === "region") return;
      if (h.kind === "vertex") item = { ref: { k: "p", c: [h.point.x, h.point.y, h.point.z] }, p: h.point };
      else item = { ref: makeRef(h.body, h.kind === "edge" ? "e" : "f", h.info), hit: h };
    }
    if (this.picks.length >= 2) this.picks = [];
    this.picks.push(item);
    v.selection = this.picks.filter(p => p.hit).map(p => p.hit);
    try {
      const { compile } = await import("./mdoc.js");
      const { measure } = await import("./mkernel.js");
      const cd = compile(this.app.doc, { upto: this.app.viewUpto }).cdoc;
      const [a, b] = this.picks;
      const r = await measure(this.app.sid, cd, a.ref, b?.ref || null);
      if (a.hit && !b) {
        const i = a.hit.info || {};
        if (i.r) r.r = i.r;
        if (a.hit.kind === "face" && i.a && r.area === undefined) r.area = i.a;
      }
      if (a.p && b?.p) { r.dx = b.p.x - a.p.x; r.dy = b.p.y - a.p.y; r.dz = b.p.z - a.p.z; }
      this.res = r;
    } catch (err) { toast(err.message, true); }
    this.render();
    v.redraw();
  }
  paint(g) {
    const v = this.app.view;
    if (this.snap && ["vertex", "center", "mid"].includes(this.snap.kind)) snapMark(g, v.toScreen(this.snap.p), this.snap.kind);
    const R = this.res;
    if (R?.p1 && R?.p2) {
      const a = v.toScreen(R.p1), b = v.toScreen(R.p2);
      g.strokeStyle = ACCENT; g.lineWidth = 2; g.setLineDash([5, 3]);
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); g.setLineDash([]);
      g.fillStyle = ACCENT;
      for (const s of [a, b]) { g.beginPath(); g.arc(s[0], s[1], 4, 0, 7); g.fill(); }
      const txt = fmt(R.d) + " mm";
      g.font = "600 12px 'IBM Plex Sans', sans-serif";
      const w = g.measureText(txt).width + 10, mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      g.fillStyle = "rgba(30,32,34,.85)"; g.fillRect(mx - w / 2, my - 22, w, 18);
      g.fillStyle = "#fff"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(txt, mx, my - 13); g.textAlign = "left";
    }
  }
}
