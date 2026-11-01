// Editor degli schizzi (stile SketchUp per il disegno, stile SolidWorks/Fusion per vincoli e quote).
// Strumenti: linea/polilinea, rettangolo (due angoli o dal centro), cerchio, arco per tre punti, poligono, quota.
// Aggancio a punti, punti medi, centri, curve, spigoli della faccia e vertici dei corpi; inferenze orizzontale/verticale
// e allineamento con altri punti (linee guida tratteggiate). Digitando un numero mentre si disegna: lunghezza ("50" o
// "50<30" con l'angolo), rettangolo "80;40", diametro del cerchio: diventa una quota pilotante.
// Vincoli sulla selezione: orizzontale, verticale, coincidente, tangente, parallelo, perpendicolare, uguale, concentrico,
// punto medio, simmetrico, fisso; X = costruzione. Trascinando punti o curve il risolutore mantiene i vincoli.
// Colori: blu = ancora libero, scuro = completamente definito, rosso = vincoli in conflitto.
import { el, toast } from "../core.js";
import { LOCALE, t as tr } from "../i18n.js";
import { evalExpr } from "./mexpr.js";
import { analyze, entPoints, isDim, measureDim, mergePoints, removeEnts, solve, uid } from "./msolver.js";
import { findRegions } from "./mregions.js";
import { to2, uvTo3 } from "./mview.js";

const ACC = "#f07d2e";
const TAU = Math.PI * 2;
const fmt = v => (Math.round(v * 1000) / 1000).toLocaleString(LOCALE, { maximumFractionDigits: 3 });

export const SK_TOOLS = ["select", "line", "rect", "rectc", "circle", "arc", "polygon", "dim"];

export class SketchEditor {
  constructor(host) {
    this.h = host;
    this.v = host.view;
    this.f = host.feature;
    this.sk = host.feature.sk;
    this.pl = host.plane;
    this.tool = "select";
    this.sel = new Set(); // "p:id" | "e:id" | "c:id"
    this.hoverKey = null;
    this.chain = null; // punti dello strumento in corso
    this.cursor = null; // {uv, snap}
    this.typed = "";
    this.bad = new Set();
    this.hits = []; // zone cliccabili di quote e simboli dei vincoli (disegnate)
    this.analysis = analyze(this.sk);
    this.regions = findRegions(this.sk);
    this.polySides = 6;
    this.gridSnap = false;
  }

  // ---------------------------------------------------------------------------------------------- avvio/fine
  start() {
    const v = this.v;
    v.lookAtPlane(this.pl);
    v.setGrid(Math.max(200, this.extent() * 1.5), this.pl);
    v.setOrtho(true);
    this.draw = g => this.paint(g);
    v.overlays.add(this.draw);
    const c = v.canvas;
    this.onDown = e => this.pointerDown(e);
    this.onMove = e => this.pointerMove(e);
    this.onUp = e => this.pointerUp(e);
    this.onDbl = e => this.dblClick(e);
    this.onCtx = e => { if (this.chain) { e.preventDefault(); this.endChain(); } };
    c.addEventListener("pointerdown", this.onDown);
    c.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    c.addEventListener("dblclick", this.onDbl);
    c.addEventListener("contextmenu", this.onCtx, true);
    this.onKey = e => this.key(e);
    window.addEventListener("keydown", this.onKey, true);
    this.setTool("select");
    this.refresh();
  }

  stop() {
    const v = this.v, c = v.canvas;
    v.overlays.delete(this.draw);
    c.removeEventListener("pointerdown", this.onDown);
    c.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    c.removeEventListener("dblclick", this.onDbl);
    c.removeEventListener("contextmenu", this.onCtx, true);
    window.removeEventListener("keydown", this.onKey, true);
    this.input?.remove();
    v.setOrtho(false);
    v.setGrid(Math.max(200, v.bbox().getSize(new (v.bbox().min.constructor)()).length() || 200));
    v.controls.mouseButtons.LEFT = 0;
    v.redraw();
  }

  extent() {
    let m = 0;
    for (const p of Object.values(this.sk.pts)) m = Math.max(m, Math.abs(p.x), Math.abs(p.y));
    return m || 100;
  }

  setTool(t) {
    this.tool = t;
    this.chain = null;
    this.typed = "";
    this.input?.remove();
    this.input = null;
    // tasto sinistro: con uno strumento di disegno niente rotazione; in selezione si sposta la vista trascinando nel vuoto
    this.v.controls.mouseButtons.LEFT = -1;
    this.h.onTool?.(t);
    this.v.redraw();
  }

  // ---------------------------------------------------------------------------------------------- modifica
  changed(label, { solve: doSolve = true } = {}) {
    if (doSolve) {
      const r = solve(this.sk);
      this.bad = new Set(r.ok ? [] : r.bad);
    }
    this.refresh();
    this.h.changed?.(label);
  }
  refresh() {
    this.analysis = analyze(this.sk);
    this.regions = findRegions(this.sk);
    this.h.status?.(this.statusText());
    this.h.panel?.(this);
    this.v.redraw();
  }
  statusText() {
    const d = this.analysis.dof;
    if (this.bad.size) return tr("mod.vincoli_in_conflitto");
    return d ? tr("mod.gradi_liberta", d) : tr("mod.completamente_definito");
  }

  addPoint(x, y, extra = {}) {
    const id = uid(this.sk, "p");
    this.sk.pts[id] = { x, y, ...extra };
    return id;
  }
  addEnt(e) { e.id = uid(this.sk, e.t === "line" ? "l" : e.t === "arc" ? "a" : "c"); this.sk.ents.push(e); return e; }
  addCon(c) { c.id = uid(this.sk, "k"); this.sk.cons.push(c); return c; }

  // un vincolo nuovo che non si puo' soddisfare viene tolto subito
  tryCon(c) {
    this.addCon(c);
    const backup = JSON.stringify(this.sk.pts) + "|" + JSON.stringify(this.sk.ents);
    const r = solve(this.sk);
    if (!r.ok) {
      this.sk.cons = this.sk.cons.filter(q => q !== c);
      const [pts, ents] = backup.split("|");
      this.sk.pts = JSON.parse(pts);
      this.sk.ents = JSON.parse(ents);
      solve(this.sk);
      toast(tr("mod.vincolo_conflitto"), true);
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------------------------- coordinate e aggancio
  uvOf(e) { const p = this.v.onPlane(e, this.pl); return p ? to2(this.pl, [p.x, p.y, p.z]) : null; }
  scr(uv) { return this.v.toScreen(uvTo3(this.pl, uv)); }
  P(id) { return this.sk.pts[id]; }

  // punto agganciato: {uv, kind, id?(punto), e?(curva), ref?(riferimento)}
  snapAt(e, { exclude = new Set() } = {}) {
    const raw = this.uvOf(e);
    if (!raw) return null;
    const [mx, my] = this.v.local(e);
    const near = (uv, tol) => { const s = this.scr(uv); return Math.hypot(s[0] - mx, s[1] - my) <= tol ? Math.hypot(s[0] - mx, s[1] - my) : null; };
    let best = null;
    const cand = (uv, kind, pri, extra) => {
      const d = near(uv, 10);
      if (d === null) return;
      const sc = d + pri * 5;
      if (!best || sc < best.sc) best = { uv: [...uv], kind, sc, ...extra };
    };
    for (const [id, p] of Object.entries(this.sk.pts)) if (!exclude.has(id)) cand([p.x, p.y], "point", 0, { id });
    for (const en of this.sk.ents) {
      if (en.t === "line" && !exclude.has(en.p1) && !exclude.has(en.p2)) {
        const a = this.P(en.p1), b = this.P(en.p2);
        cand([(a.x + b.x) / 2, (a.y + b.y) / 2], "mid", 0.6, { e: en.id });
      }
    }
    // riferimenti: spigoli della faccia proiettati, origine
    for (const poly of this.h.proj || []) for (const q of poly) cand(q, "ref", 0.3, {});
    cand([0, 0], "origin", 0.4, {});
    // vertici e centri dei corpi proiettati sul piano
    const s3 = this.v.snap(e, { tol: 10, faces: false });
    if (s3 && ["vertex", "center", "mid"].includes(s3.kind)) cand(to2(this.pl, [s3.p.x, s3.p.y, s3.p.z]), "model", 0.8, { mk: s3.kind });
    if (best) return best;
    // su una curva dello schizzo o su uno spigolo di riferimento
    let on = null;
    for (const en of this.sk.ents) {
      const q = nearestOn(this.sk, en, raw);
      if (!q) continue;
      const d = near(q, 7);
      if (d !== null && (!on || d < on.d)) on = { uv: q, kind: "on", e: en.id, d };
    }
    for (const poly of this.h.proj || []) for (let i = 0; i + 1 < poly.length; i++) {
      const q = segNearest(poly[i], poly[i + 1], raw);
      const d = near(q, 7);
      if (d !== null && (!on || d < on.d)) on = { uv: q, kind: "refon", d };
    }
    if (on) return on;
    let uv = raw;
    if (this.gridSnap) { const s = this.v.gridStep || 10; uv = [Math.round(raw[0] / s) * s, Math.round(raw[1] / s) * s]; }
    return { uv, kind: "free" };
  }

  // inferenze rispetto al punto di partenza: orizzontale/verticale; allineamento con altri punti
  infer(snap, from) {
    if (!from || snap.kind !== "free") return snap;
    const out = { ...snap, guides: [] };
    const a = this.scr(from), b = this.scr(snap.uv);
    const ang = Math.atan2(-(b[1] - a[1]), b[0] - a[0]);
    const dx = snap.uv[0] - from[0], dy = snap.uv[1] - from[1];
    // angolo nel piano (non sullo schermo): l'asse x del piano e' orizzontale nella vista dello schizzo
    const t = Math.atan2(dy, dx);
    const near = (x, y) => Math.abs(Math.sin(x - y)) < Math.sin(3 * Math.PI / 180) && Math.cos(x - y) > 0;
    if (near(t, 0) || near(t, Math.PI)) { out.uv = [snap.uv[0], from[1]]; out.inf = "hor"; }
    else if (near(t, Math.PI / 2) || near(t, -Math.PI / 2)) { out.uv = [from[0], snap.uv[1]]; out.inf = "ver"; }
    void ang;
    // allineamento con altri punti (x o y uguali entro 6 pixel)
    const [mx, my] = this.scr(out.uv);
    for (const p of Object.values(this.sk.pts)) {
      const s = this.scr([p.x, p.y]);
      if (out.inf !== "ver" && Math.abs(s[0] - mx) < 6 && Math.abs(s[1] - my) > 12) { out.uv = [p.x, out.uv[1]]; out.guides.push([[p.x, p.y], out.uv]); break; }
    }
    for (const p of Object.values(this.sk.pts)) {
      const s = this.scr([p.x, p.y]);
      if (out.inf !== "hor" && Math.abs(s[1] - my) < 6 && Math.abs(s[0] - mx) > 12) { out.uv = [out.uv[0], p.y]; out.guides.push([[p.x, p.y], out.uv]); break; }
    }
    return out;
  }

  // punto dello schizzo per un aggancio: riusa il punto esistente o ne crea uno con il vincolo giusto
  pointFor(snap) {
    if (snap.kind === "point") return snap.id;
    const id = this.addPoint(snap.uv[0], snap.uv[1]);
    if (snap.kind === "mid") this.addCon({ t: "mid", a: id, e: snap.e });
    else if (snap.kind === "on") this.addCon({ t: "pon", a: id, e: snap.e });
    else if (snap.kind === "origin" || snap.kind === "ref" || snap.kind === "model") this.sk.pts[id].fix = true;
    return id;
  }

  // ---------------------------------------------------------------------------------------------- mouse
  pointerDown(e) {
    if (e.button !== 0) return;
    const s = this.cursorSnap(e);
    if (!s) return;
    if (this.tool === "select") return this.selectDown(e, s);
    if (this.tool === "dim") return this.dimClick(e, s);
    this.toolClick(s, e);
  }

  cursorSnap(e) {
    const from = this.chain?.pts?.length ? this.chain.pts[this.chain.pts.length - 1].uv : null;
    let s = this.snapAt(e);
    if (s && this.tool !== "select" && this.tool !== "dim" && this.tool !== "circle" && this.tool !== "polygon") s = this.infer(s, from);
    return s;
  }

  pointerMove(e) {
    if (this.drag) return this.dragMove(e);
    if (this.box) { this.box.b = this.v.local(e); this.v.redraw(); return; }
    this.cursor = this.cursorSnap(e);
    this.hoverKey = this.tool === "select" || this.tool === "dim" ? this.hitTest(e) : null;
    this.v.redraw();
  }

  pointerUp(e) {
    if (this.drag) {
      const moved = this.drag.moved;
      this.drag = null;
      this.v.controls.enabled = true;
      if (moved) this.changed(tr("mod.trascina"), { solve: false });
      return;
    }
    if (this.box) {
      const { a, b } = this.box;
      this.box = null;
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 4) this.boxSelect(a, b, e.ctrlKey || e.shiftKey);
      this.v.redraw();
    }
  }

  // elemento sotto il mouse: quote e vincoli (zone disegnate), punti, curve
  hitTest(e) {
    const [mx, my] = this.v.local(e);
    for (const h of this.hits) if (mx >= h.x0 && mx <= h.x1 && my >= h.y0 && my <= h.y1) return "c:" + h.id;
    let best = null;
    for (const [id, p] of Object.entries(this.sk.pts)) {
      const s = this.scr([p.x, p.y]);
      const d = Math.hypot(s[0] - mx, s[1] - my);
      if (d <= 7 && (!best || d < best.d)) best = { k: "p:" + id, d };
    }
    if (best) return best.k;
    const raw = this.uvOf(e);
    if (!raw) return null;
    for (const en of this.sk.ents) {
      const q = nearestOn(this.sk, en, raw);
      if (!q) continue;
      const s = this.scr(q);
      const d = Math.hypot(s[0] - mx, s[1] - my);
      if (d <= 6 && (!best || d < best.d)) best = { k: "e:" + en.id, d };
    }
    return best?.k || null;
  }

  selectDown(e, s) {
    const k = this.hitTest(e);
    const multi = e.ctrlKey || e.shiftKey;
    if (!k) {
      if (!multi) this.sel.clear();
      // trascinando nel vuoto: selezione a riquadro; con il tasto centrale/destro la vista si muove come sempre
      this.box = { a: this.v.local(e), b: this.v.local(e) };
      this.h.panel?.(this);
      this.v.redraw();
      return;
    }
    if (multi) { if (this.sel.has(k)) this.sel.delete(k); else this.sel.add(k); }
    else if (!this.sel.has(k)) { this.sel.clear(); this.sel.add(k); }
    this.h.panel?.(this);
    // trascinamento di punti e curve
    if (k[0] === "p" || k[0] === "e") {
      const ids = new Set();
      if (k[0] === "p") ids.add(k.slice(2));
      else { const en = this.sk.ents.find(q => q.id === k.slice(2)); if (en) for (const p of (en.t === "circle" ? [] : entPoints(en))) ids.add(p); if (en?.t === "circle") ids.add("r:" + en.id); }
      const start = this.uvOf(e);
      const orig = {};
      for (const id of ids) if (this.P(id)) orig[id] = [this.P(id).x, this.P(id).y];
      const circ = k[0] === "e" ? this.sk.ents.find(q => q.id === k.slice(2) && q.t === "circle") : null;
      this.drag = { ids, start, orig, moved: false, circ };
      this.v.controls.enabled = false;
    }
    this.v.redraw();
  }

  dragMove(e) {
    const d = this.drag;
    const uv = this.uvOf(e);
    if (!uv || !d.start) return;
    const dx = uv[0] - d.start[0], dy = uv[1] - d.start[1];
    if (!d.moved && Math.hypot(...this.scr(uv).slice(0, 2).map((v, i) => v - this.scr(d.start)[i])) < 3) return;
    d.moved = true;
    const heavy = new Set();
    if (d.circ) {
      // cerchio: si cambia il raggio verso il mouse
      const c = this.P(d.circ.c);
      d.circ.r = Math.max(1e-6, Math.hypot(uv[0] - c.x, uv[1] - c.y));
      heavy.add(d.circ.c);
    } else {
      for (const [id, [x, y]] of Object.entries(d.orig)) { const p = this.P(id); if (p.fix) continue; p.x = x + dx; p.y = y + dy; heavy.add(id); }
    }
    const r = solve(this.sk, { heavy });
    this.bad = new Set(r.ok ? [] : r.bad);
    this.regions = findRegions(this.sk);
    this.v.redraw();
  }

  boxSelect(a, b, add) {
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    const inside = uv => { const s = this.scr(uv); return s[0] >= x0 && s[0] <= x1 && s[1] >= y0 && s[1] <= y1; };
    if (!add) this.sel.clear();
    for (const en of this.sk.ents) {
      const pts = sampleEnt(this.sk, en, 16);
      if (pts.every(inside)) this.sel.add("e:" + en.id);
    }
    for (const [id, p] of Object.entries(this.sk.pts)) if (inside([p.x, p.y])) this.sel.add("p:" + id);
    this.h.panel?.(this);
  }

  dblClick(e) {
    if (this.chain) { this.endChain(); return; }
    const k = this.hitTest(e);
    if (k?.[0] === "c") {
      const c = this.sk.cons.find(q => q.id === k.slice(2));
      if (c && isDim(c)) this.editDim(c, e);
    }
  }

  // ---------------------------------------------------------------------------------------------- strumenti di disegno
  toolClick(s, e) {
    const t = this.tool;
    if (!this.chain) this.chain = { pts: [] };
    const ch = this.chain;
    ch.pts.push(s);
    if (t === "line") {
      if (ch.pts.length >= 2) {
        const a = ch.pts[ch.pts.length - 2], b = ch.pts[ch.pts.length - 1];
        const closing = b.kind === "point" && ch.first && b.id === ch.first;
        this.makeLine(a, b, ch);
        if (closing) { this.endChain(); return; }
      }
    } else if (t === "rect" || t === "rectc") {
      if (ch.pts.length === 2) { this.makeRect(ch.pts[0], ch.pts[1], t === "rectc"); this.endChain(); }
    } else if (t === "circle") {
      if (ch.pts.length === 2) { const c = ch.pts[0]; this.makeCircle(c, Math.hypot(ch.pts[1].uv[0] - c.uv[0], ch.pts[1].uv[1] - c.uv[1])); this.endChain(); }
    } else if (t === "arc") {
      if (ch.pts.length === 3) { this.makeArc(ch.pts[0], ch.pts[1], ch.pts[2].uv); this.endChain(); }
    } else if (t === "polygon") {
      if (ch.pts.length === 2) { this.makePolygon(ch.pts[0], ch.pts[1].uv); this.endChain(); }
    }
    void e;
    this.v.redraw();
  }

  endChain() {
    const had = this.chain?.made;
    this.chain = null;
    this.typed = "";
    this.input?.remove();
    this.input = null;
    if (had) this.changed(tr("mod.disegno"));
    this.v.redraw();
  }

  makeLine(a, b, ch, typedLen = null) {
    if (Math.hypot(b.uv[0] - a.uv[0], b.uv[1] - a.uv[1]) < 1e-9) { ch.pts.pop(); return null; }
    const p1 = ch.lastId && ch.pts.length > 2 ? ch.lastId : this.pointFor(a);
    if (!ch.first) ch.first = p1;
    const p2 = this.pointFor(b);
    const en = this.addEnt({ t: "line", p1, p2 });
    if (b.inf === "hor") this.addCon({ t: "hor", e: en.id });
    if (b.inf === "ver") this.addCon({ t: "ver", e: en.id });
    if (typedLen) this.addCon({ t: "len", e: en.id, v: typedLen });
    ch.lastId = p2;
    ch.made = true;
    solve(this.sk);
    this.regions = findRegions(this.sk);
    this.analysis = analyze(this.sk);
    return en;
  }

  makeRect(a, b, center, dims = null) {
    let [x0, y0] = a.uv, [x1, y1] = b.uv;
    if (center) { x0 = a.uv[0] - (b.uv[0] - a.uv[0]); y0 = a.uv[1] - (b.uv[1] - a.uv[1]); x1 = b.uv[0]; y1 = b.uv[1]; }
    if (Math.abs(x1 - x0) < 1e-9 || Math.abs(y1 - y0) < 1e-9) return;
    const ids = [
      center ? this.addPoint(x0, y0) : this.pointFor(a), this.addPoint(x1, y0),
      center ? this.pointFor(b) : this.pointFor({ ...b, uv: [x1, y1] }), this.addPoint(x0, y1),
    ];
    if (!center && b.kind !== "point" && b.kind !== "free" && b.kind !== "origin") { /* agganciato: il punto e' gia' stato creato da pointFor */ }
    const L = [0, 1, 2, 3].map(i => this.addEnt({ t: "line", p1: ids[i], p2: ids[(i + 1) % 4] }));
    this.addCon({ t: "hor", e: L[0].id }); this.addCon({ t: "hor", e: L[2].id });
    this.addCon({ t: "ver", e: L[1].id }); this.addCon({ t: "ver", e: L[3].id });
    if (center) {
      // centro = punto medio della diagonale (linea di costruzione)
      const c = a.kind === "point" ? a.id : this.pointFor(a);
      const dg = this.addEnt({ t: "line", p1: ids[0], p2: ids[2], cons: true });
      this.addCon({ t: "mid", a: c, e: dg.id });
    }
    if (dims) { this.addCon({ t: "len", e: L[0].id, v: dims[0] }); this.addCon({ t: "len", e: L[1].id, v: dims[1] }); }
    this.chain && (this.chain.made = true);
  }

  makeCircle(c, r, dia = null) {
    if (!(r > 0)) return;
    const cid = this.pointFor(c);
    const en = this.addEnt({ t: "circle", c: cid, r });
    if (dia) this.addCon({ t: "dia", e: en.id, v: dia });
    this.chain && (this.chain.made = true);
  }

  makeArc(a, b, through) {
    const cc = circleThrough(a.uv, b.uv, through);
    if (!cc) return toast(tr("mod.arco_non_valido"), true);
    const p1 = this.pointFor(a), p2 = this.pointFor(b);
    const c = this.addPoint(cc[0], cc[1]);
    // verso antiorario da p1 a p2 se il terzo punto sta su quell'arco, altrimenti si scambiano
    const ang = q => Math.atan2(q[1] - cc[1], q[0] - cc[0]);
    const n = x => ((x % TAU) + TAU) % TAU;
    const ccw = n(ang(through) - ang(a.uv)) < n(ang(b.uv) - ang(a.uv));
    this.addEnt({ t: "arc", c, p1: ccw ? p1 : p2, p2: ccw ? p2 : p1 });
    this.chain && (this.chain.made = true);
  }

  makePolygon(c, corner) {
    const n = Math.max(3, Math.min(64, this.polySides | 0));
    const r = Math.hypot(corner[0] - c.uv[0], corner[1] - c.uv[1]);
    if (!(r > 0)) return;
    const cid = this.pointFor(c);
    const circ = this.addEnt({ t: "circle", c: cid, r, cons: true });
    const a0 = Math.atan2(corner[1] - c.uv[1], corner[0] - c.uv[0]);
    const ids = [];
    for (let i = 0; i < n; i++) { const t = a0 + TAU * i / n; ids.push(this.addPoint(c.uv[0] + r * Math.cos(t), c.uv[1] + r * Math.sin(t))); }
    const L = ids.map((p, i) => this.addEnt({ t: "line", p1: p, p2: ids[(i + 1) % n] }));
    for (const p of ids) this.addCon({ t: "pon", a: p, e: circ.id });
    for (let i = 1; i < n; i++) this.addCon({ t: "equal", e1: L[0].id, e2: L[i].id });
    this.chain && (this.chain.made = true);
  }

  // ---------------------------------------------------------------------------------------------- valori digitati
  typedValue(raw) {
    const t = this.tool, ch = this.chain;
    if (!ch?.pts?.length) return false;
    const last = ch.pts[ch.pts.length - 1];
    const vals = raw.split(/[;x×*]/i).map(s => s.trim()).filter(Boolean);
    let nums;
    try { nums = vals.map(s => { const [len, ang] = s.split("<"); return ang !== undefined ? { len: evalExpr(len, this.h.vals || {}), ang: evalExpr(ang, this.h.vals || {}) } : evalExpr(s, this.h.vals || {}); }); }
    catch { toast(tr("mod.valore_non_valido"), true); return false; }
    const cur = this.cursor?.uv || last.uv;
    if (t === "line") {
      let len, ang;
      if (typeof nums[0] === "object") ({ len, ang } = nums[0]);
      else { len = nums[0]; ang = Math.atan2(cur[1] - last.uv[1], cur[0] - last.uv[0]) * 180 / Math.PI; }
      if (!(len > 0)) return false;
      const th = ang * Math.PI / 180;
      const b = { uv: [last.uv[0] + len * Math.cos(th), last.uv[1] + len * Math.sin(th)], kind: "free" };
      const inf = this.infer({ ...b }, last.uv);
      if (inf.inf) b.inf = inf.inf;
      ch.pts.push(b);
      const en = this.makeLine(last, b, ch, len);
      if (en) solve(this.sk);
      this.v.redraw();
      return true;
    }
    if (t === "rect" || t === "rectc") {
      const w = nums[0], hgt = nums[1] ?? nums[0];
      if (!(w > 0 && hgt > 0)) return false;
      const sx = Math.sign(cur[0] - last.uv[0]) || 1, sy = Math.sign(cur[1] - last.uv[1]) || 1;
      const k = t === "rectc" ? 0.5 : 1;
      this.makeRect(last, { uv: [last.uv[0] + sx * w * k, last.uv[1] + sy * hgt * k], kind: "free" }, t === "rectc", [w, hgt]);
      this.endChain();
      return true;
    }
    if (t === "circle") {
      const d = nums[0];
      if (!(d > 0)) return false;
      this.makeCircle(last, d / 2, d);
      this.endChain();
      return true;
    }
    if (t === "polygon") {
      const d = nums[0];
      if (!(d > 0)) return false;
      const a0 = Math.atan2(cur[1] - last.uv[1], cur[0] - last.uv[0]);
      this.makePolygon(last, [last.uv[0] + d / 2 * Math.cos(a0), last.uv[1] + d / 2 * Math.sin(a0)]);
      this.endChain();
      return true;
    }
    return false;
  }

  showInput(label, init = "") {
    if (!this.input) {
      this.input = el("input", { class: "md-vinput", type: "text", spellcheck: "false" });
      this.input.addEventListener("keydown", e => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); const v = this.input.value; this.input.remove(); this.input = null; this.inputDone?.(v); this.v.redraw(); }
        else if (e.key === "Escape") { e.preventDefault(); this.input.remove(); this.input = null; this.inputDone = null; this.v.redraw(); }
      });
      this.v.host.append(this.input);
    }
    this.input.placeholder = label;
    this.input.title = label;
    this.input.value = init;
    const s = this.cursor ? this.scr(this.cursor.uv) : [this.v.w / 2, this.v.h / 2];
    Object.assign(this.input.style, { left: Math.min(this.v.w - 150, s[0] + 18) + "px", top: Math.min(this.v.h - 40, s[1] + 14) + "px" });
    this.input.focus();
  }

  inputLabel() {
    return { line: tr("mod.lunghezza_angolo"), rect: tr("mod.larghezza_altezza"), rectc: tr("mod.larghezza_altezza"), circle: tr("mod.diametro"), polygon: tr("mod.diametro") }[this.tool] || "";
  }

  key(e) {
    if (this.h.hidden?.()) return;
    const tg = e.target;
    if (tg?.closest?.("input, textarea, select") && tg !== this.input) return;
    if (document.getElementById("modal") && !document.getElementById("modal").hidden) return;
    const k = e.key;
    // numeri durante il disegno: casella del valore vicino al mouse
    if (this.chain?.pts?.length && /^[0-9.,-]$/.test(k) && !e.ctrlKey && !e.altKey && this.tool !== "arc") {
      e.preventDefault();
      this.inputDone = v => { if (v.trim()) this.typedValue(v); };
      this.showInput(this.inputLabel(), k);
      return;
    }
    if (k === "Escape") {
      e.preventDefault(); e.stopPropagation();
      if (this.chain) return this.endChain();
      if (this.tool !== "select") return this.setTool("select");
      if (this.sel.size) { this.sel.clear(); this.h.panel?.(this); this.v.redraw(); return; }
      return this.h.finish?.();
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === "Delete" || k === "Backspace") { e.preventDefault(); e.stopPropagation(); return this.deleteSel(); }
    const map = { l: "line", r: "rect", c: "circle", a: "arc", d: "dim", s: "select", p: "polygon" };
    const low = k.toLowerCase();
    if (map[low] && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); return this.setTool(map[low]); }
    if (low === "r" && e.shiftKey) { e.preventDefault(); e.stopPropagation(); return this.setTool("rectc"); }
    if (low === "x") { e.preventDefault(); e.stopPropagation(); return this.toggleConstruction(); }
    if (low === "h") { e.preventDefault(); e.stopPropagation(); return this.applyCon("hor"); }
    if (low === "v") { e.preventDefault(); e.stopPropagation(); return this.applyCon("ver"); }
  }

  // ---------------------------------------------------------------------------------------------- selezione e vincoli
  selected() {
    const pts = [], ents = [], cons = [];
    for (const k of this.sel) {
      const id = k.slice(2);
      if (k[0] === "p" && this.P(id)) pts.push(id);
      else if (k[0] === "e") { const en = this.sk.ents.find(q => q.id === id); if (en) ents.push(en); }
      else if (k[0] === "c") { const c = this.sk.cons.find(q => q.id === id); if (c) cons.push(c); }
    }
    return { pts, ents, cons };
  }

  deleteSel() {
    const { pts, ents, cons } = this.selected();
    if (!pts.length && !ents.length && !cons.length) return;
    const cids = new Set(cons.map(c => c.id));
    this.sk.cons = this.sk.cons.filter(c => !cids.has(c.id));
    const eids = new Set(ents.map(q => q.id));
    for (const p of pts) for (const en of this.sk.ents) if (entPoints(en).includes(p)) eids.add(en.id);
    if (eids.size) removeEnts(this.sk, eids);
    this.sel.clear();
    this.changed(tr("mod.elimina"));
  }

  toggleConstruction() {
    const { ents } = this.selected();
    if (!ents.length) return toast(tr("mod.seleziona_curve"), true);
    const on = !ents.every(q => q.cons);
    for (const en of ents) en.cons = on || undefined;
    this.changed(tr("mod.costruzione"), { solve: false });
  }

  fixSel() {
    const { pts, ents } = this.selected();
    const ids = new Set(pts);
    for (const en of ents) for (const p of entPoints(en)) ids.add(p);
    if (!ids.size) return toast(tr("mod.seleziona_punti_curve"), true);
    const on = ![...ids].every(id => this.P(id).fix);
    for (const id of ids) this.P(id).fix = on || undefined;
    this.changed(tr("mod.fisso"));
  }

  // vincolo dalla selezione corrente
  applyCon(kind) {
    const { pts, ents } = this.selected();
    const lines = ents.filter(q => q.t === "line"), curves = ents.filter(q => q.t !== "line");
    const done = [];
    const need = () => toast(tr("mod.selezione_vincolo_" + kind), true);
    switch (kind) {
      case "hor": case "ver":
        if (lines.length) for (const l of lines) done.push({ t: kind, e: l.id });
        else if (pts.length === 2) done.push({ t: kind, a: pts[0], b: pts[1] });
        else return need();
        break;
      case "coinc":
        if (pts.length === 2) { mergePoints(this.sk, pts[0], pts[1]); this.sel.clear(); this.changed(tr("mod.v_coinc")); return; }
        if (pts.length === 1 && ents.length === 1) done.push({ t: "pon", a: pts[0], e: ents[0].id });
        else return need();
        break;
      case "par": case "perp":
        if (lines.length >= 2) for (let i = 1; i < lines.length; i++) done.push({ t: kind, e1: lines[0].id, e2: lines[i].id });
        else return need();
        break;
      case "equal":
        if (lines.length >= 2 && !curves.length) for (let i = 1; i < lines.length; i++) done.push({ t: "equal", e1: lines[0].id, e2: lines[i].id });
        else if (curves.length >= 2 && !lines.length) for (let i = 1; i < curves.length; i++) done.push({ t: "equal", e1: curves[0].id, e2: curves[i].id });
        else return need();
        break;
      case "tan": {
        if (ents.length !== 2 || !curves.length) return need();
        const [e1, e2] = ents;
        done.push({ t: "tan", e1: e1.id, e2: e2.id, s: tanSign(this.sk, e1, e2) });
        break;
      }
      case "conc":
        if (curves.length >= 2) for (let i = 1; i < curves.length; i++) done.push({ t: "conc", e1: curves[0].id, e2: curves[i].id });
        else return need();
        break;
      case "mid":
        if (pts.length === 1 && lines.length === 1) done.push({ t: "mid", a: pts[0], e: lines[0].id });
        else return need();
        break;
      case "sym":
        if (pts.length === 2 && lines.length === 1) done.push({ t: "sym", a: pts[0], b: pts[1], e: lines[0].id });
        else return need();
        break;
      case "fix": return this.fixSel();
      default: return;
    }
    let okAll = true;
    for (const c of done) okAll = this.tryCon(c) && okAll;
    if (okAll || done.length > 1) this.changed(tr("mod.v_" + kind), { solve: false });
    else this.refresh();
  }

  // ---------------------------------------------------------------------------------------------- quote
  dimClick(e, s) {
    const k = this.hitTest(e);
    const ch = this.dimPick || (this.dimPick = []);
    if (k && k[0] === "c") { const c = this.sk.cons.find(q => q.id === k.slice(2)); if (c && isDim(c)) this.editDim(c, e); return; }
    if (!k) {
      if (ch.length) { this.placeDim(ch, this.uvOf(e), e); this.dimPick = null; }
      return;
    }
    ch.push(k);
    const items = ch.map(x => ({ k: x[0], id: x.slice(2) }));
    const ents = items.filter(i => i.k === "e").map(i => this.sk.ents.find(q => q.id === i.id));
    // un elemento: si piazza al clic successivo nel vuoto; due elementi: subito
    if (items.length === 2 || (items.length === 1 && ents[0]?.t !== "line" && ents[0])) { this.placeDim(ch, s.uv, e); this.dimPick = null; }
    this.v.redraw();
  }

  placeDim(keys, at, e) {
    const items = keys.map(x => ({ k: x[0], id: x.slice(2) }));
    const E = id => this.sk.ents.find(q => q.id === id);
    const pts = items.filter(i => i.k === "p").map(i => i.id), ents = items.filter(i => i.k === "e").map(i => E(i.id)).filter(Boolean);
    let c = null;
    if (ents.length === 1 && !pts.length) {
      const en = ents[0];
      if (en.t === "line") c = { t: "len", e: en.id };
      else c = { t: en.t === "circle" ? "dia" : "rad", e: en.id };
    } else if (pts.length === 2) {
      // orizzontale, verticale o allineata secondo dove si mette la quota
      const a = this.P(pts[0]), b = this.P(pts[1]);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
      let t = "dist";
      if (at) {
        const ox = Math.abs(at[0] - mx), oy = Math.abs(at[1] - my);
        if (oy > dy / 2 + 1e-9 && ox <= dx / 2 + 1e-9) t = "hdist";
        else if (ox > dx / 2 + 1e-9 && oy <= dy / 2 + 1e-9) t = "vdist";
      }
      c = { t, a: pts[0], b: pts[1] };
      if (t === "hdist") c.s = b.x >= a.x ? 1 : -1;
      if (t === "vdist") c.s = b.y >= a.y ? 1 : -1;
    } else if (ents.length === 2 && ents.every(q => q.t === "line")) {
      const [l1, l2] = ents;
      const d1 = dirOf(this.sk, l1), d2 = dirOf(this.sk, l2);
      if (Math.abs(d1[0] * d2[1] - d1[1] * d2[0]) < 1e-6) {
        const p = this.P(l2.p1);
        c = { t: "pdist", a: l2.p1, e: l1.id };
        const val = signedDist(this.sk, l1, [p.x, p.y]);
        c.s = val >= 0 ? 1 : -1;
      } else {
        c = { t: "ang", e1: l1.id, e2: l2.id };
        // angolo interno nel quadrante del clic: versi delle due linee scelti verso il punto della quota
        const ip = lineInter(this.sk, l1, l2);
        if (ip && at) {
          const v = [at[0] - ip[0], at[1] - ip[1]];
          c.r1 = d1[0] * v[0] + d1[1] * v[1] < 0 || undefined;
          c.r2 = d2[0] * v[0] + d2[1] * v[1] < 0 || undefined;
        }
      }
    } else if (pts.length === 1 && ents.length === 1 && ents[0].t === "line") {
      const p = this.P(pts[0]);
      c = { t: "pdist", a: pts[0], e: ents[0].id, s: signedDist(this.sk, ents[0], [p.x, p.y]) >= 0 ? 1 : -1 };
    } else if (pts.length === 1 && ents.length === 1) {
      // punto - centro del cerchio
      c = { t: "dist", a: pts[0], b: ents[0].c };
    }
    if (!c) { toast(tr("mod.quota_non_valida"), true); return; }
    const cur = measureDim(this.sk, c);
    c.v = Math.round(Math.abs(cur) * 1000) / 1000;
    if (c.t === "ang") c.v = Math.round(Math.abs(cur) * 1000) / 1000;
    if (["hdist", "vdist", "pdist"].includes(c.t)) c.v = Math.abs(c.v);
    if (at) c.lbl = [at[0], at[1]];
    // quota che renderebbe lo schizzo sovradefinito: diventa di riferimento (come SolidWorks)
    if (!this.tryConQuiet(c)) { c.ref = true; this.addCon(c); toast(tr("mod.quota_riferimento"), false, 4000); this.changed(tr("mod.quota")); return; }
    this.changed(tr("mod.quota"), { solve: false });
    this.editDim(c, e);
  }

  tryConQuiet(c) {
    const before = analyze(this.sk).dof;
    this.addCon(c);
    const r = solve(this.sk);
    if (!r.ok || analyze(this.sk).dof >= before && before === 0) { this.sk.cons = this.sk.cons.filter(q => q !== c); solve(this.sk); return false; }
    return true;
  }

  editDim(c, e) {
    if (c.ref) return;
    if (e) this.cursor = { uv: this.uvOf(e) || [0, 0] };
    this.inputDone = v => {
      if (!v.trim()) return;
      try { evalExpr(v, this.h.vals || {}); } catch { toast(tr("mod.valore_non_valido"), true); return; }
      const old = c.v;
      c.v = /^[-+]?[0-9]+([.,][0-9]+)?$/.test(v.trim()) ? parseFloat(v.replace(",", ".")) : v.trim();
      c.val = evalExpr(c.v, this.h.vals || {});
      const r = solve(this.sk);
      if (!r.ok) { c.v = old; c.val = evalExpr(old, this.h.vals || {}); solve(this.sk); toast(tr("mod.vincolo_conflitto"), true); this.refresh(); return; }
      this.changed(tr("mod.quota"), { solve: false });
    };
    this.showInput(tr("mod.valore_quota"), String(c.v));
    this.input.select();
  }

  // proietta gli spigoli della faccia di partenza come linee fisse dello schizzo
  projectEdges() {
    const polys = this.h.proj || [];
    if (!polys.length) return toast(tr("mod.niente_da_proiettare"), true);
    const ptOf = new Map();
    const pid = q => { const k = q[0].toFixed(6) + "," + q[1].toFixed(6); if (!ptOf.has(k)) ptOf.set(k, this.addPoint(q[0], q[1], { fix: true })); return ptOf.get(k); };
    for (const poly of polys) for (let i = 0; i + 1 < poly.length; i++) {
      if (Math.hypot(poly[i + 1][0] - poly[i][0], poly[i + 1][1] - poly[i][1]) < 1e-9) continue;
      this.addEnt({ t: "line", p1: pid(poly[i]), p2: pid(poly[i + 1]) });
    }
    this.changed(tr("mod.proietta"));
  }

  // ---------------------------------------------------------------------------------------------- disegno
  paint(g) {
    const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    const FREE = "#2d6fd6", DEF = dark ? "#e9ecef" : "#1b1f23", CONS = "#8a949e", BAD = "#d93025";
    const free = this.analysis.free;
    const badEnts = new Set();
    for (const id of this.bad) { const c = this.sk.cons.find(q => q.id === id); if (c) for (const k of ["e", "e1", "e2"]) if (c[k]) badEnts.add(c[k]); }
    this.hits = [];
    // regioni chiuse
    g.fillStyle = "rgba(90,143,224,.12)";
    for (const R of this.regions) {
      g.beginPath();
      for (const poly of [R.poly, ...R.holePolys]) { poly.forEach((uv, i) => { const s = this.scr(uv); if (i) g.lineTo(s[0], s[1]); else g.moveTo(s[0], s[1]); }); g.closePath(); }
      g.fill("evenodd");
    }
    // riferimenti (spigoli della faccia)
    g.setLineDash([4, 3]); g.strokeStyle = "rgba(138,148,158,.8)"; g.lineWidth = 1;
    for (const poly of this.h.proj || []) { g.beginPath(); poly.forEach((uv, i) => { const s = this.scr(uv); if (i) g.lineTo(s[0], s[1]); else g.moveTo(s[0], s[1]); }); g.stroke(); }
    g.setLineDash([]);
    // assi dello schizzo
    const o = this.scr([0, 0]);
    g.lineWidth = 1;
    g.strokeStyle = "rgba(217,83,79,.6)"; g.beginPath(); g.moveTo(o[0], o[1]); g.lineTo(...this.scr([this.extent() * 0.3 + 10, 0]).slice(0, 2)); g.stroke();
    g.strokeStyle = "rgba(76,175,80,.6)"; g.beginPath(); g.moveTo(o[0], o[1]); g.lineTo(...this.scr([0, this.extent() * 0.3 + 10]).slice(0, 2)); g.stroke();
    // curve
    for (const en of this.sk.ents) {
      const key = "e:" + en.id;
      const isSel = this.sel.has(key), isHov = this.hoverKey === key;
      const pts = sampleEnt(this.sk, en, 64);
      const defined = entPoints(en).every(p => !free.has(p)) && (en.t !== "circle" || !free.has(en.id));
      g.strokeStyle = isSel ? ACC : badEnts.has(en.id) ? BAD : en.cons ? CONS : defined ? DEF : FREE;
      g.lineWidth = isSel || isHov ? 2.6 : 1.6;
      if (isHov && !isSel) g.strokeStyle = "#f5a46b";
      g.setLineDash(en.cons ? [6, 4] : []);
      g.beginPath();
      pts.forEach((uv, i) => { const s = this.scr(uv); if (i) g.lineTo(s[0], s[1]); else g.moveTo(s[0], s[1]); });
      g.stroke();
    }
    g.setLineDash([]);
    // punti
    const used = new Set();
    for (const en of this.sk.ents) for (const p of entPoints(en)) used.add(p);
    for (const [id, p] of Object.entries(this.sk.pts)) {
      if (!used.has(id)) continue;
      const s = this.scr([p.x, p.y]);
      const key = "p:" + id;
      g.fillStyle = this.sel.has(key) || this.hoverKey === key ? ACC : p.fix ? "#7a8691" : free.has(id) ? FREE : DEF;
      const r = this.sel.has(key) ? 4 : 3;
      g.fillRect(s[0] - r, s[1] - r, r * 2, r * 2);
    }
    this.paintCons(g, dark);
    this.paintDims(g, dark, FREE, DEF);
    this.paintPreview(g);
    if (this.box) {
      const { a, b } = this.box;
      g.strokeStyle = ACC; g.setLineDash([4, 3]); g.lineWidth = 1;
      g.fillStyle = "rgba(240,125,46,.08)";
      g.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      g.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      g.setLineDash([]);
    }
  }

  paintCons(g, dark) {
    const SYM = { hor: "H", ver: "V", par: "∥", perp: "⊥", equal: "=", tan: "T", conc: "◎", pon: "•", mid: "M", sym: "⇋" };
    const count = new Map();
    g.font = "600 10px 'IBM Plex Sans', sans-serif";
    g.textAlign = "center"; g.textBaseline = "middle";
    for (const c of this.sk.cons) {
      if (isDim(c) || !SYM[c.t]) continue;
      const anchors = [];
      const mid = id => { const en = this.sk.ents.find(q => q.id === id); if (!en) return null; const pts = sampleEnt(this.sk, en, 8); return pts[Math.floor(pts.length / 2)]; };
      if (c.e) anchors.push(mid(c.e));
      else if (c.e1) anchors.push(mid(c.e1), mid(c.e2));
      if (c.a && !c.e) anchors.push([this.P(c.a)?.x, this.P(c.a)?.y]);
      if (c.t === "pon" || c.t === "mid") anchors.splice(0, anchors.length, [this.P(c.a)?.x, this.P(c.a)?.y]);
      for (const an of anchors) {
        if (!an || an.some(x => x === undefined || !isFinite(x))) continue;
        const s = this.scr(an);
        const k = Math.round(s[0] / 4) + "," + Math.round(s[1] / 4);
        const n = count.get(k) || 0;
        count.set(k, n + 1);
        const x = s[0] + 10 + n * 15, y = s[1] - 12;
        const key = "c:" + c.id;
        const sel = this.sel.has(key), hov = this.hoverKey === key;
        g.fillStyle = sel ? ACC : this.bad.has(c.id) ? "#d93025" : hov ? "#f5a46b" : dark ? "rgba(60,64,68,.92)" : "rgba(255,255,255,.92)";
        g.strokeStyle = dark ? "#6b7178" : "#9aa3ab";
        g.lineWidth = 1;
        g.beginPath(); g.rect(x - 6.5, y - 6.5, 13, 13); g.fill(); g.stroke();
        g.fillStyle = sel || this.bad.has(c.id) ? "#fff" : dark ? "#e9ecef" : "#30363c";
        g.fillText(SYM[c.t], x, y + 0.5);
        this.hits.push({ id: c.id, x0: x - 7, x1: x + 7, y0: y - 7, y1: y + 7 });
      }
    }
  }

  paintDims(g, dark) {
    const col = dark ? "#e9ecef" : "#30363c";
    g.font = "500 11.5px 'IBM Plex Sans', sans-serif";
    g.textAlign = "center"; g.textBaseline = "middle";
    for (const c of this.sk.cons) {
      if (!isDim(c)) continue;
      const val = measureDim(this.sk, c);
      if (!isFinite(val)) continue;
      const key = "c:" + c.id, sel = this.sel.has(key), hov = this.hoverKey === key;
      g.strokeStyle = g.fillStyle = sel ? ACC : this.bad.has(c.id) ? "#d93025" : hov ? "#f5a46b" : c.ref ? "#8a949e" : col;
      g.lineWidth = 1;
      const geo = dimGeometry(this.sk, c);
      if (!geo) continue;
      let lbl = geo.lbl;
      const ext = (a, b) => { const sa = this.scr(a), sb = this.scr(b); g.beginPath(); g.moveTo(sa[0], sa[1]); g.lineTo(sb[0], sb[1]); g.stroke(); };
      if (geo.kind === "lin") {
        // linea di quota parallela alla misura, spostata verso il punto dell'etichetta
        const { a, b, dir } = geo;
        const n = [-dir[1], dir[0]];
        const L = c.lbl || [(a[0] + b[0]) / 2 + n[0] * 10, (a[1] + b[1]) / 2 + n[1] * 10];
        const off = (L[0] - a[0]) * n[0] + (L[1] - a[1]) * n[1];
        const a2 = [a[0] + n[0] * off, a[1] + n[1] * off], b2 = [b[0] + n[0] * off, b[1] + n[1] * off];
        ext(a, a2); ext(b, b2); ext(a2, b2);
        this.arrow(g, this.scr(b2), this.scr(a2)); this.arrow(g, this.scr(a2), this.scr(b2));
        const t = (L[0] - a2[0]) * dir[0] + (L[1] - a2[1]) * dir[1];
        lbl = [a2[0] + dir[0] * t, a2[1] + dir[1] * t];
      } else if (geo.kind === "rad") {
        const L = c.lbl || [geo.c[0] + geo.r * 0.7 + 5, geo.c[1] + geo.r * 0.7 + 5];
        const d = [L[0] - geo.c[0], L[1] - geo.c[1]], dl = Math.hypot(...d) || 1;
        const onc = [geo.c[0] + d[0] / dl * geo.r, geo.c[1] + d[1] / dl * geo.r];
        const from = c.t === "dia" ? [geo.c[0] - d[0] / dl * geo.r, geo.c[1] - d[1] / dl * geo.r] : geo.c;
        ext(from, L);
        this.arrow(g, this.scr(from), this.scr(onc));
        lbl = L;
      } else if (geo.kind === "ang") {
        const L = c.lbl || [geo.o[0] + 20, geo.o[1] + 20];
        const r = Math.hypot(L[0] - geo.o[0], L[1] - geo.o[1]);
        const a0 = Math.atan2(geo.u[1], geo.u[0]);
        let sw = Math.atan2(geo.u[0] * geo.w[1] - geo.u[1] * geo.w[0], geo.u[0] * geo.w[0] + geo.u[1] * geo.w[1]);
        g.beginPath();
        for (let i = 0; i <= 24; i++) { const th = a0 + sw * i / 24; const s = this.scr([geo.o[0] + r * Math.cos(th), geo.o[1] + r * Math.sin(th)]); if (i) g.lineTo(s[0], s[1]); else g.moveTo(s[0], s[1]); }
        g.stroke();
        lbl = L;
      }
      const txt = (c.t === "dia" ? "⌀" : c.t === "rad" ? "R" : "") + fmt(Math.abs(val)) + (c.t === "ang" ? "°" : "") + (typeof c.v === "string" && !c.ref ? " = " + c.v : "");
      const s = this.scr(lbl);
      const w = g.measureText(c.ref ? `(${txt})` : txt).width + 8;
      g.fillStyle = dark ? "rgba(35,37,39,.9)" : "rgba(238,240,237,.92)";
      g.fillRect(s[0] - w / 2, s[1] - 8, w, 16);
      g.fillStyle = sel ? ACC : this.bad.has(c.id) ? "#d93025" : c.ref ? "#8a949e" : col;
      g.fillText(c.ref ? `(${txt})` : txt, s[0], s[1]);
      this.hits.push({ id: c.id, x0: s[0] - w / 2, x1: s[0] + w / 2, y0: s[1] - 8, y1: s[1] + 8 });
    }
  }

  arrow(g, from, to) {
    const a = Math.atan2(to[1] - from[1], to[0] - from[0]);
    g.beginPath();
    g.moveTo(to[0], to[1]);
    g.lineTo(to[0] - 8 * Math.cos(a - 0.35), to[1] - 8 * Math.sin(a - 0.35));
    g.lineTo(to[0] - 8 * Math.cos(a + 0.35), to[1] - 8 * Math.sin(a + 0.35));
    g.closePath();
    g.fill();
  }

  // anteprima dello strumento, marcatore di aggancio, linee guida
  paintPreview(g) {
    const cur = this.cursor;
    if (!cur) return;
    const s = this.scr(cur.uv);
    // marcatore dell'aggancio
    if (this.tool !== "select" || cur.kind !== "free") {
      g.strokeStyle = ACC; g.fillStyle = ACC; g.lineWidth = 1.6;
      const k = cur.kind;
      g.beginPath();
      if (k === "point" || k === "ref" || k === "model") g.rect(s[0] - 5, s[1] - 5, 10, 10);
      else if (k === "mid") { g.moveTo(s[0], s[1] - 6); g.lineTo(s[0] + 6, s[1] + 5); g.lineTo(s[0] - 6, s[1] + 5); g.closePath(); }
      else if (k === "origin") g.arc(s[0], s[1], 6, 0, TAU);
      else if (k === "on" || k === "refon") { g.moveTo(s[0] - 5, s[1] - 5); g.lineTo(s[0] + 5, s[1] + 5); g.moveTo(s[0] + 5, s[1] - 5); g.lineTo(s[0] - 5, s[1] + 5); }
      else if (this.tool !== "select") { g.moveTo(s[0] - 6, s[1]); g.lineTo(s[0] + 6, s[1]); g.moveTo(s[0], s[1] - 6); g.lineTo(s[0], s[1] + 6); }
      g.stroke();
    }
    for (const [a, b] of cur.guides || []) {
      g.setLineDash([3, 3]); g.strokeStyle = "rgba(240,125,46,.7)"; g.lineWidth = 1;
      const sa = this.scr(a), sb = this.scr(b);
      g.beginPath(); g.moveTo(sa[0], sa[1]); g.lineTo(sb[0], sb[1]); g.stroke();
      g.setLineDash([]);
    }
    const ch = this.chain;
    if (!ch?.pts?.length) return;
    const last = ch.pts[ch.pts.length - 1].uv;
    g.strokeStyle = ACC; g.lineWidth = 1.6; g.setLineDash([]);
    const line = (a, b) => { const sa = this.scr(a), sb = this.scr(b); g.beginPath(); g.moveTo(sa[0], sa[1]); g.lineTo(sb[0], sb[1]); g.stroke(); };
    const t = this.tool;
    let label = "";
    if (t === "line") {
      line(last, cur.uv);
      const L = Math.hypot(cur.uv[0] - last[0], cur.uv[1] - last[1]);
      label = fmt(L) + (cur.inf ? "  " + (cur.inf === "hor" ? "H" : "V") : "  " + fmt(Math.atan2(cur.uv[1] - last[1], cur.uv[0] - last[0]) * 180 / Math.PI) + "°");
    } else if (t === "rect" || t === "rectc") {
      const a = t === "rectc" ? [2 * last[0] - cur.uv[0], 2 * last[1] - cur.uv[1]] : last, b = cur.uv;
      line(a, [b[0], a[1]]); line([b[0], a[1]], b); line(b, [a[0], b[1]]); line([a[0], b[1]], a);
      label = fmt(Math.abs(b[0] - a[0])) + " × " + fmt(Math.abs(b[1] - a[1]));
    } else if (t === "circle" || t === "polygon") {
      const r = Math.hypot(cur.uv[0] - last[0], cur.uv[1] - last[1]);
      g.beginPath();
      const n = t === "polygon" ? Math.max(3, this.polySides) : 64;
      const a0 = Math.atan2(cur.uv[1] - last[1], cur.uv[0] - last[0]);
      for (let i = 0; i <= n; i++) { const th = (t === "polygon" ? a0 : 0) + TAU * i / n; const q = this.scr([last[0] + r * Math.cos(th), last[1] + r * Math.sin(th)]); if (i) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); }
      g.stroke();
      label = "⌀" + fmt(2 * r);
    } else if (t === "arc") {
      if (ch.pts.length === 1) line(last, cur.uv);
      else {
        const cc = circleThrough(ch.pts[0].uv, ch.pts[1].uv, cur.uv);
        if (cc) {
          const A = ch.pts[0].uv, B = ch.pts[1].uv;
          const ang = q => Math.atan2(q[1] - cc[1], q[0] - cc[0]);
          const n = x => ((x % TAU) + TAU) % TAU;
          const ccw = n(ang(cur.uv) - ang(A)) < n(ang(B) - ang(A));
          const a0 = ccw ? ang(A) : ang(B), sw = ccw ? n(ang(B) - ang(A)) : n(ang(A) - ang(B));
          g.beginPath();
          for (let i = 0; i <= 48; i++) { const th = a0 + sw * i / 48; const q = this.scr([cc[0] + cc[2] * Math.cos(th), cc[1] + cc[2] * Math.sin(th)]); if (i) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); }
          g.stroke();
          label = "R" + fmt(cc[2]);
        }
      }
    }
    if (label) {
      g.font = "600 11.5px 'IBM Plex Sans', sans-serif";
      g.textAlign = "left"; g.textBaseline = "middle";
      const w = g.measureText(label).width + 10;
      g.fillStyle = "rgba(30,32,34,.82)";
      g.fillRect(s[0] + 14, s[1] - 26, w, 18);
      g.fillStyle = "#fff";
      g.fillText(label, s[0] + 19, s[1] - 17);
    }
  }
}

// ------------------------------------------------------------------------------------------------- geometria
export function sampleEnt(sk, en, n = 48) {
  const P = id => sk.pts[id];
  if (en.t === "line") { const a = P(en.p1), b = P(en.p2); return a && b ? [[a.x, a.y], [b.x, b.y]] : []; }
  const c = P(en.c);
  if (!c) return [];
  if (en.t === "circle") return Array.from({ length: n + 1 }, (_, i) => [c.x + en.r * Math.cos(TAU * i / n), c.y + en.r * Math.sin(TAU * i / n)]);
  const a = P(en.p1), b = P(en.p2);
  if (!a || !b) return [];
  const r = Math.hypot(a.x - c.x, a.y - c.y);
  const a0 = Math.atan2(a.y - c.y, a.x - c.x);
  let sw = Math.atan2(b.y - c.y, b.x - c.x) - a0;
  sw = ((sw % TAU) + TAU) % TAU || TAU;
  const k = Math.max(4, Math.ceil(n * sw / TAU));
  return Array.from({ length: k + 1 }, (_, i) => [c.x + r * Math.cos(a0 + sw * i / k), c.y + r * Math.sin(a0 + sw * i / k)]);
}

function segNearest(a, b, p) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const u = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return [a[0] + dx * u, a[1] + dy * u];
}

export function nearestOn(sk, en, p) {
  const P = id => sk.pts[id];
  if (en.t === "line") { const a = P(en.p1), b = P(en.p2); return a && b ? segNearest([a.x, a.y], [b.x, b.y], p) : null; }
  const c = P(en.c);
  if (!c) return null;
  const r = en.t === "circle" ? en.r : Math.hypot(P(en.p1).x - c.x, P(en.p1).y - c.y);
  const th = Math.atan2(p[1] - c.y, p[0] - c.x);
  const q = [c.x + r * Math.cos(th), c.y + r * Math.sin(th)];
  if (en.t === "arc") {
    const a0 = Math.atan2(P(en.p1).y - c.y, P(en.p1).x - c.x), a1 = Math.atan2(P(en.p2).y - c.y, P(en.p2).x - c.x);
    const n = x => ((x % TAU) + TAU) % TAU;
    if (n(th - a0) > n(a1 - a0)) return null;
  }
  return q;
}

export function circleThrough(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const s = q => q[0] * q[0] + q[1] * q[1];
  const x = (s(a) * (b[1] - c[1]) + s(b) * (c[1] - a[1]) + s(c) * (a[1] - b[1])) / d;
  const y = (s(a) * (c[0] - b[0]) + s(b) * (a[0] - c[0]) + s(c) * (b[0] - a[0])) / d;
  return [x, y, Math.hypot(a[0] - x, a[1] - y)];
}

function dirOf(sk, l) { const a = sk.pts[l.p1], b = sk.pts[l.p2]; const d = [b.x - a.x, b.y - a.y], n = Math.hypot(...d) || 1; return [d[0] / n, d[1] / n]; }
function signedDist(sk, l, p) { const a = sk.pts[l.p1], d = dirOf(sk, l); return d[0] * (p[1] - a.y) - d[1] * (p[0] - a.x); }
function lineInter(sk, l1, l2) {
  const a = sk.pts[l1.p1], b = sk.pts[l1.p2], c = sk.pts[l2.p1], d = sk.pts[l2.p2];
  const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
  return [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t];
}
// verso della tangenza secondo la posizione attuale (dal lato in cui sta ora il centro / tangenza esterna o interna)
function tanSign(sk, e1, e2) {
  if (e1.t === "line" || e2.t === "line") {
    const ln = e1.t === "line" ? e1 : e2, cu = e1.t === "line" ? e2 : e1;
    const c = sk.pts[cu.c];
    return signedDist(sk, ln, [c.x, c.y]) >= 0 ? 1 : -1;
  }
  const r = e => (e.t === "circle" ? e.r : Math.hypot(sk.pts[e.p1].x - sk.pts[e.c].x, sk.pts[e.p1].y - sk.pts[e.c].y));
  const c1 = sk.pts[e1.c], c2 = sk.pts[e2.c];
  const d = Math.hypot(c1.x - c2.x, c1.y - c2.y);
  return Math.abs(d - (r(e1) + r(e2))) <= Math.abs(d - Math.abs(r(e1) - r(e2))) ? 1 : -1;
}

// geometria di disegno di una quota
function dimGeometry(sk, c) {
  const P = id => sk.pts[id];
  const E = id => sk.ents.find(e => e.id === id);
  try {
    if (c.t === "len" || c.t === "dist") {
      const [pa, pb] = c.t === "len" ? [P(E(c.e).p1), P(E(c.e).p2)] : [P(c.a), P(c.b)];
      const a = [pa.x, pa.y], b = [pb.x, pb.y];
      const d = [b[0] - a[0], b[1] - a[1]], n = Math.hypot(...d) || 1;
      return { kind: "lin", a, b, dir: [d[0] / n, d[1] / n] };
    }
    if (c.t === "hdist" || c.t === "vdist") {
      const pa = P(c.a), pb = P(c.b);
      const dir = c.t === "hdist" ? [1, 0] : [0, 1];
      // estremi riportati sulla stessa linea di quota: la distanza misurata e' solo lungo dir
      return { kind: "lin", a: [pa.x, pa.y], b: c.t === "hdist" ? [pb.x, pa.y] : [pa.x, pb.y], dir: c.t === "hdist" ? (pb.x >= pa.x ? dir : [-1, 0]) : (pb.y >= pa.y ? dir : [0, -1]) };
    }
    if (c.t === "pdist") {
      const l = E(c.e), a = P(c.a), d = dirOf(sk, l), q = P(l.p1);
      const t = (a.x - q.x) * d[0] + (a.y - q.y) * d[1];
      const foot = [q.x + d[0] * t, q.y + d[1] * t];
      const v = [a.x - foot[0], a.y - foot[1]], n = Math.hypot(...v) || 1;
      return { kind: "lin", a: foot, b: [a.x, a.y], dir: [v[0] / n, v[1] / n] };
    }
    if (c.t === "rad" || c.t === "dia") {
      const e = E(c.e), ce = P(e.c);
      const r = e.t === "circle" ? e.r : Math.hypot(P(e.p1).x - ce.x, P(e.p1).y - ce.y);
      return { kind: "rad", c: [ce.x, ce.y], r };
    }
    if (c.t === "ang") {
      const l1 = E(c.e1), l2 = E(c.e2);
      const o = lineInter(sk, l1, l2) || [P(l1.p1).x, P(l1.p1).y];
      let u = dirOf(sk, l1), w = dirOf(sk, l2);
      if (c.r1) u = [-u[0], -u[1]];
      if (c.r2) w = [-w[0], -w[1]];
      return { kind: "ang", o, u, w };
    }
  } catch { /* quota verso entita' tolte */ }
  return null;
}
