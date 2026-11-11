// Trascinamento diretto nel modellatore (al posto delle coordinate):
// - Gizmo: maniglie sui corpi selezionati (frecce X/Y/Z, quadrati dei piani XY/XZ/YZ, anelli di rotazione). Si trascina,
//   la misura appare accanto al mouse e scatta a passi comodi (Ctrl = libero, Alt all'inizio = copia); digitando un numero
//   durante il trascinamento la misura diventa esatta. Al rilascio: una lavorazione "Trasformazione" (spostamenti uno dopo
//   l'altro dello stesso corpo si sommano nella stessa lavorazione, la cronologia resta pulita).
// - Instradamento di tubazioni, canaline e condotte: clic sui punti, direzioni bloccate sugli assi X/Y/Z scelti dal movimento
//   del mouse (Maiusc = libero), aggancio ai vertici e alle estremita' degli altri impianti, lunghezze digitate.
// - Nodi dei percorsi: trascinando un nodo di una tubazione il percorso si ricalcola (curve comprese).
import * as THREE from "three";
import { el, toast } from "../core.js";
import { LOCALE, t as tr } from "../i18n.js";
import { evalExpr } from "./mexpr.js";
import { ICON } from "./micons.js";
import { ACCENT } from "./mview.js";
import { chainFromEdges, chainFromSketch, kindName, KINDS, sizes, SPECS } from "./mplant.js";

const AX = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const AXC = ["#e0524d", "#4caf50", "#3d7fd9"];
const fmt = v => (Math.round(v * 100) / 100).toLocaleString(LOCALE, { maximumFractionDigits: 2 });
const V = a => new THREE.Vector3(...a);
const add = (a, b) => a.map((v, i) => v + b[i]), sub = (a, b) => a.map((v, i) => v - b[i]), mul = (a, k) => a.map(v => v * k);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// passo "comodo" (1, 2, 5 x 10^n) vicino a v
export function niceStep(v) {
  const e = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1e-6))));
  const m = v / e;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * e;
}
// parametro t sulla retta o + t*n piu' vicino al raggio
export function closestOnAxis(ray, o, n) {
  const d1 = [ray.direction.x, ray.direction.y, ray.direction.z], p1 = [ray.origin.x, ray.origin.y, ray.origin.z];
  const w = sub(o, p1);
  const a = dot(n, n), b = dot(n, d1), c = dot(d1, d1), dd = dot(n, w), e = dot(d1, w);
  const den = a * c - b * b;
  return Math.abs(den) < 1e-12 ? 0 : (b * e - c * dd) / den;
}
// asse del mondo che sullo schermo va piu' nella direzione del mouse partendo da p
export function screenAxis(view, p, mouse) {
  const s0 = view.toScreen(p);
  const m = [mouse[0] - s0[0], mouse[1] - s0[1]];
  const mlen = Math.hypot(...m) || 1;
  const L = 50 * view.pxSize(V(p));
  let best = 0, bv = -1;
  AX.forEach((a, i) => {
    const s = view.toScreen(add(p, mul(a, L)));
    const d = [s[0] - s0[0], s[1] - s0[1]], dl = Math.hypot(...d);
    if (dl < 4) return; // asse puntato verso la camera
    const c = Math.abs(d[0] * m[0] + d[1] * m[1]) / (dl * mlen);
    if (c > bv) { bv = c; best = i; }
  });
  return best;
}
function label(g, s, txt) {
  g.font = "600 12px 'IBM Plex Sans', sans-serif";
  g.textBaseline = "middle"; g.textAlign = "left";
  const w = g.measureText(txt).width + 10;
  g.fillStyle = "rgba(30,32,34,.88)"; g.fillRect(s[0] + 16, s[1] - 26, w, 18);
  g.fillStyle = "#fff"; g.fillText(txt, s[0] + 21, s[1] - 17);
}
function numberBox(view, at, placeholder, done) {
  const inp = el("input", { class: "md-vinput", type: "text", placeholder, spellcheck: "false" });
  Object.assign(inp.style, { left: Math.min(view.w - 150, at[0] + 18) + "px", top: Math.min(view.h - 40, at[1] + 14) + "px" });
  inp.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); const v = inp.value; inp.remove(); done(v); }
    if (e.key === "Escape") { e.preventDefault(); inp.remove(); done(null); }
  });
  view.host.append(inp);
  return inp;
}

// ================================================================================================= gizmo
export class Gizmo {
  constructor(app) {
    this.app = app;
    this.v = app.view;
    this.drag = null;
    this.paint = g => this.draw(g);
    this.v.overlays.add(this.paint);
    const c = this.v.canvas;
    this.onDown = e => this.down(e);
    this.onMove = e => this.move(e);
    this.onUp = e => this.up(e);
    this.onKey = e => this.key(e);
    c.addEventListener("pointerdown", this.onDown, true);
    window.addEventListener("pointermove", this.onMove, true);
    window.addEventListener("pointerup", this.onUp, true);
    window.addEventListener("keydown", this.onKey, true);
  }
  dispose() {
    this.v.overlays.delete(this.paint);
    const c = this.v.canvas;
    c.removeEventListener("pointerdown", this.onDown, true);
    window.removeEventListener("pointermove", this.onMove, true);
    window.removeEventListener("pointerup", this.onUp, true);
    window.removeEventListener("keydown", this.onKey, true);
  }
  // corpi su cui agisce: quelli selezionati, solo senza strumenti e fuori dagli schizzi
  bodies() {
    if (this.app.tool || this.app.sketch) return [];
    return [...new Set(this.v.selection.filter(s => s.kind === "body" && this.v.bodies.has(s.body)).map(s => s.body))];
  }
  center(ids) {
    const bb = ids.map(id => this.v.bodies.get(id)?.data.bbox).filter(Boolean);
    if (!bb.length) return null;
    return [0, 1, 2].map(k => (Math.min(...bb.map(b => b[k])) + Math.max(...bb.map(b => b[k + 3]))) / 2);
  }
  // maniglie in coordinate dello schermo
  handles(c) {
    const v = this.v, s0 = v.toScreen(c), px = v.pxSize(V(c));
    const H = [];
    AX.forEach((a, i) => {
      const e = v.toScreen(add(c, mul(a, 95 * px)));
      if (Math.hypot(e[0] - s0[0], e[1] - s0[1]) > 12) H.push({ k: "ax", i, a: s0, b: e });
    });
    // quadrati dei piani (tra due assi)
    [[0, 1, 2], [0, 2, 1], [1, 2, 0]].forEach(([i, j, n]) => {
      const q = [0, 0.32, 0.32, 0].map((t, k) => v.toScreen(add(add(c, mul(AX[i], (k === 1 || k === 2 ? 34 : 18) * px)), mul(AX[j], (k >= 2 ? 34 : 18) * px))));
      H.push({ k: "pl", i, j, n, q });
    });
    // anelli di rotazione
    AX.forEach((a, i) => {
      const u = AX[(i + 1) % 3], w = AX[(i + 2) % 3], R = 70 * px, pts = [];
      for (let k = 0; k <= 48; k++) { const t = (k / 48) * Math.PI * 2; pts.push(v.toScreen(add(c, add(mul(u, R * Math.cos(t)), mul(w, R * Math.sin(t)))))); }
      H.push({ k: "rot", i, pts });
    });
    return H;
  }
  hit(e, c) {
    const [mx, my] = this.v.local(e);
    let best = null;
    const segD = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy; const t = L ? Math.max(0, Math.min(1, ((mx - a[0]) * dx + (my - a[1]) * dy) / L)) : 0; return Math.hypot(a[0] + dx * t - mx, a[1] + dy * t - my); };
    for (const h of this.handles(c)) {
      let d = Infinity;
      if (h.k === "ax") d = segD(h.a, h.b) - 1;
      else if (h.k === "pl") d = inPoly([mx, my], h.q) ? 0 : Infinity;
      else for (let k = 0; k + 1 < h.pts.length; k++) d = Math.min(d, segD(h.pts[k], h.pts[k + 1]) + 1.5);
      if (d < 7 && (!best || d < best.d)) best = { ...h, d };
    }
    return best;
  }
  down(e) {
    if (e.button !== 0) return;
    const ids = this.bodies();
    if (!ids.length) return;
    const c = this.center(ids);
    const h = c && this.hit(e, c);
    if (!h) return;
    e.stopImmediatePropagation(); e.preventDefault(); // prima della rotazione della vista (OrbitControls sullo stesso elemento)
    this.v.controls.enabled = false;
    const rc = this.v.ray(e);
    const d = { h, ids, c, copy: e.altKey, val: 0, M: new THREE.Matrix4() };
    if (h.k === "ax") d.t0 = closestOnAxis(rc.ray, c, AX[h.i]);
    else if (h.k === "pl") d.p0 = this.onPlane(rc, c, AX[h.n]);
    else d.a0 = this.angle(rc, c, h.i);
    this.drag = d;
    this.objs = ids.map(id => this.v.bodies.get(id)).filter(Boolean);
    this.savedSel = this.v.selection;
  }
  onPlane(rc, c, n) {
    const p = new THREE.Vector3();
    return rc.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(V(n), V(c)), p) ? [p.x, p.y, p.z] : null;
  }
  angle(rc, c, i) {
    const p = this.onPlane(rc, c, AX[i]);
    if (!p) return 0;
    const u = AX[(i + 1) % 3], w = AX[(i + 2) % 3], r = sub(p, c);
    return Math.atan2(dot(r, w), dot(r, u)) * 180 / Math.PI;
  }
  move(e) {
    const d = this.drag;
    if (!d) { // passaggio sopra le maniglie: evidenziate
      const ids = this.bodies();
      const c = ids.length && this.center(ids);
      const h = c ? this.hit(e, c) : null;
      if ((h?.k + h?.i + h?.n) !== this.hoverKey) { this.hoverKey = h?.k + h?.i + h?.n; this.v.redraw(); }
      return;
    }
    if (d.typed) return;
    e.stopPropagation();
    const rc = this.v.ray(e), px = this.v.pxSize(V(d.c));
    const free = e.ctrlKey;
    const step = niceStep(px * 12);
    if (d.h.k === "ax") {
      let t = closestOnAxis(rc.ray, d.c, AX[d.h.i]) - d.t0;
      if (!free) t = Math.round(t / step) * step;
      d.val = t; d.vec = mul(AX[d.h.i], t);
    } else if (d.h.k === "pl") {
      const p = this.onPlane(rc, d.c, AX[d.h.n]);
      if (!p || !d.p0) return;
      let dv = sub(p, d.p0);
      if (!free) dv = dv.map(x => Math.round(x / step) * step);
      dv[d.h.n] = 0;
      d.vec = dv;
    } else {
      let a = this.angle(rc, d.c, d.h.i) - d.a0;
      a = ((a + 540) % 360) - 180;
      if (!free) a = Math.round(a / 5) * 5;
      d.val = a;
    }
    this.apply();
  }
  apply(d = this.drag) {
    const M = new THREE.Matrix4();
    if (d.h.k === "rot") {
      const T = new THREE.Matrix4().makeTranslation(...d.c), Ti = new THREE.Matrix4().makeTranslation(...mul(d.c, -1));
      M.multiplyMatrices(T, new THREE.Matrix4().makeRotationAxis(V(AX[d.h.i]), d.val * Math.PI / 180)).multiply(Ti);
    } else if (d.vec) M.makeTranslation(...d.vec);
    d.M = M;
    for (const o of this.objs) for (const m of [o.mesh, o.edgesObj]) { m.matrixAutoUpdate = false; m.matrix.copy(M); m.matrixWorldNeedsUpdate = true; }
    this.v.selection = [];
    this.v.redraw();
  }
  reset() {
    for (const o of this.objs || []) for (const m of [o.mesh, o.edgesObj]) { m.matrix.identity(); m.matrixWorldNeedsUpdate = true; }
  }
  up(e) {
    const d = this.drag;
    if (!d || d.typed) return;
    e?.stopPropagation();
    this.drag = null;
    this.v.controls.enabled = true;
    const moved = d.h.k === "rot" ? Math.abs(d.val) > 1e-9 : d.vec && Math.hypot(...d.vec) > 1e-9;
    this.v.selection = this.savedSel;
    if (!moved) { this.reset(); this.v.redraw(); return; }
    this.commit(d);
  }
  commit(d) {
    const app = this.app;
    // tubazioni disegnate a punti (non da schizzo, non gia' trasformate): si spostano i nodi stessi, cosi' restano modificabili
    // con le maniglie dei nodi, e con loro i componenti in linea (punto "at"); le staffe si ricalcolano da sole
    const doc0 = app.doc;
    const routes = d.ids.map(id => doc0.features.find(q => q.id === id && q.type === "route" && Array.isArray(q.pts) && !q.sketch));
    if (!d.copy && routes.every(Boolean) && routes.every(f => app.res?.bodies?.find(b => b.id === f.id)?.src === f.id) && d.M) {
      const apply = p => { const v = new THREE.Vector3(...p).applyMatrix4(d.M); return [r6(v.x), r6(v.y), r6(v.z)]; };
      for (const f of routes) {
        f.pts = f.pts.map(apply);
        for (const q of doc0.features) if (q.type === "fitting" && q.route === f.id && Array.isArray(q.at)) q.at = apply(q.at);
      }
      app.commit(d.h.k === "rot" ? tr("mod.ruota") : tr("mod.sposta"));
      app.afterRegen = () => { this.reset(); this.v.selection = d.ids.map(id => ({ kind: "body", body: id })); app.selChanged(); };
      return;
    }
    // gli altri corpi: lavorazione di trasformazione; i componenti e le staffe montati sulle tubazioni spostate vanno con loro
    const deps = (app.res?.bodies || []).filter(b => d.ids.includes(b.meta?.su) && !d.ids.includes(b.id)).map(b => b.id);
    if (deps.length && !d.copy) d.ids = [...d.ids, ...deps];
    const tf = d.h.k === "rot" ? { k: "rotate", o: d.c.map(r6), d: AX[d.h.i], ang: r6(d.val), ax: "XYZ"[d.h.i], c: d.c.map(r6) } : { k: "move", v: d.vec.map(r6) };
    const doc = app.doc, last = doc.features[doc.features.length - 1];
    const same = last && doc.end == null && last.type === "transform" && !last.copy && !d.copy && last.tf?.k === "move" && tf.k === "move"
      && JSON.stringify([...last.bodies].sort()) === JSON.stringify([...d.ids].sort()) && last.tf.v.every(x => typeof x === "number");
    if (same) { // spostamenti consecutivi dello stesso corpo: una sola lavorazione
      last.tf.v = add(last.tf.v, tf.v).map(r6);
      app.commit(tr("mod.sposta"));
    } else app.commitFeature({ type: "transform", bodies: d.ids, tf, copy: d.copy || undefined });
    app.afterRegen = () => { this.reset(); this.v.selection = d.ids.map(id => ({ kind: "body", body: id })); app.selChanged(); };
  }
  key(e) {
    const d = this.drag;
    if (!d || d.typed || !/^[0-9.,-]$/.test(e.key)) {
      if (d && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.drag = null; this.v.controls.enabled = true; this.reset(); this.v.selection = this.savedSel; this.v.redraw(); }
      return;
    }
    e.preventDefault(); e.stopPropagation();
    d.typed = true;
    const s = this.v.toScreen(d.c);
    const inp = numberBox(this.v, s, d.h.k === "rot" ? tr("mod.angolo") : d.h.k === "pl" ? "dx;dy" : tr("mod.distanza"), val => {
      this.v.controls.enabled = true;
      d.typed = false;
      this.drag = null;
      if (val === null || !val.trim()) { this.reset(); this.v.selection = this.savedSel; this.v.redraw(); return; }
      let nums;
      try { nums = val.split(/[;x×]/).map(q => evalExpr(q.trim(), this.app.vals || {})); } catch { toast(tr("mod.valore_non_valido"), true); this.reset(); return; }
      if (d.h.k === "ax") { const sign = d.val < 0 && !val.trim().startsWith("-") ? -1 : 1; d.vec = mul(AX[d.h.i], nums[0] * sign); }
      else if (d.h.k === "pl") { const [i, j] = [d.h.i, d.h.j]; d.vec = [0, 0, 0]; d.vec[i] = nums[0]; d.vec[j] = nums[1] ?? 0; }
      else d.val = nums[0];
      this.apply(d);
      this.v.selection = this.savedSel;
      this.commit(d);
    });
    inp.value = e.key;
    inp.focus();
  }
  draw(g) {
    const ids = this.bodies();
    if (!ids.length) return;
    const d = this.drag;
    let c = this.center(ids);
    if (!c) return;
    if (d) c = d.vec ? add(d.c, d.vec) : d.c;
    for (const h of this.handles(c)) {
      const on = d ? d.h.k === h.k && d.h.i === h.i && d.h.n === h.n : this.hoverKey === h.k + h.i + h.n;
      if (d && !on) continue;
      if (h.k === "ax") {
        g.strokeStyle = g.fillStyle = on ? ACCENT : AXC[h.i]; g.lineWidth = on ? 4 : 3;
        g.beginPath(); g.moveTo(h.a[0], h.a[1]); g.lineTo(h.b[0], h.b[1]); g.stroke();
        const an = Math.atan2(h.b[1] - h.a[1], h.b[0] - h.a[0]);
        g.beginPath(); g.moveTo(h.b[0] + 10 * Math.cos(an), h.b[1] + 10 * Math.sin(an));
        g.lineTo(h.b[0] + 7 * Math.cos(an + 2.2), h.b[1] + 7 * Math.sin(an + 2.2)); g.lineTo(h.b[0] + 7 * Math.cos(an - 2.2), h.b[1] + 7 * Math.sin(an - 2.2)); g.fill();
      } else if (h.k === "pl") {
        g.fillStyle = on ? "rgba(240,125,46,.55)" : "rgba(160,170,180,.35)"; g.strokeStyle = AXC[h.n]; g.lineWidth = 1.2;
        g.beginPath(); h.q.forEach((p, k) => (k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); g.fill(); g.stroke();
      } else {
        g.strokeStyle = on ? ACCENT : AXC[h.i]; g.globalAlpha = on ? 1 : 0.55; g.lineWidth = on ? 3 : 1.8;
        g.beginPath(); h.pts.forEach((p, k) => (k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.stroke();
        g.globalAlpha = 1;
      }
    }
    if (d) {
      const s = this.v.toScreen(c);
      label(g, s, d.h.k === "rot" ? fmt(d.val) + "°" : d.h.k === "ax" ? fmt(d.val) + " mm" : (d.vec || [0, 0, 0]).map(fmt).join(" ; ") + " mm");
      if (d.copy) label(g, [s[0], s[1] + 22], tr("mod.copia"));
    }
  }
}
const r6 = x => Math.round(x * 1e6) / 1e6;
function inPoly(p, poly) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) ins = !ins;
  }
  return ins;
}

// ================================================================================================= instradamento
export class RouteTool {
  constructor(app, opts = {}) {
    this.app = app;
    this.v = app.view;
    this.pts = [];
    this.kind = opts.kind || localStorage.getItem("mbv-impianti-tipo") || "pipe";
    this.size = null;
    this.ortho = true;
    this.elev = 0;
    this.spec = localStorage.getItem("mbv-impianti-classe") || "A1";
    this.linea = "";
  }
  start() {
    this.v.controls.mouseButtons.LEFT = 0;
    this.pickSize();
    this.render();
    this.onDbl = () => this.finish();
    this.onCtx = e => { if (this.pts.length) { e.preventDefault(); e.stopPropagation(); this.finish(); } };
    this.v.canvas.addEventListener("dblclick", this.onDbl);
    this.v.canvas.addEventListener("contextmenu", this.onCtx, true);
  }
  stop() {
    this.v.canvas.removeEventListener("dblclick", this.onDbl);
    this.v.canvas.removeEventListener("contextmenu", this.onCtx, true);
    this.inp?.remove();
    this.v.hover = null;
    this.v.redraw();
  }
  pickSize(id = null) {
    const list = sizes(this.kind, this.spec, this.app.doc);
    const keep = id || localStorage.getItem("mbv-impianti-misura-" + this.kind);
    this.size = list.find(s => s.id === keep) || list[Math.min(8, Math.floor(list.length / 2))];
    this.r = this.size.r;
  }
  render() {
    const r = this.app.right;
    r.innerHTML = "";
    const kindSel = el("select", { class: "field" }, ...KINDS().map(([k, l]) => el("option", { value: k, selected: k === this.kind }, l)));
    kindSel.addEventListener("change", () => { this.kind = kindSel.value; try { localStorage.setItem("mbv-impianti-tipo", this.kind); } catch { /* */ } this.pickSize(); this.render(); this.v.redraw(); });
    const specSel = el("select", { class: "field" }, ...[...(this.app.doc.specs || []), ...SPECS()].map(s => el("option", { value: s.id, selected: s.id === this.spec }, `${s.id} · ${s.name}`)));
    specSel.addEventListener("change", () => { this.spec = specSel.value; try { localStorage.setItem("mbv-impianti-classe", this.spec); } catch { /* */ } this.pickSize(this.size?.id); this.render(); });
    const lineIn = el("input", { class: "field", type: "text", value: this.linea, placeholder: "100-A1-001" });
    lineIn.addEventListener("change", () => (this.linea = lineIn.value.trim()));
    const sizeSel = el("select", { class: "field" }, ...sizes(this.kind, this.spec, this.app.doc).map(s => el("option", { value: s.id, selected: s.id === this.size.id }, s.label)));
    sizeSel.addEventListener("change", () => { this.pickSize(sizeSel.value); try { localStorage.setItem("mbv-impianti-misura-" + this.kind, sizeSel.value); } catch { /* */ } this.render(); this.v.redraw(); });
    const rIn = el("input", { class: "field", type: "text", value: String(this.r) });
    rIn.addEventListener("change", () => { const v = parseFloat(rIn.value.replace(",", ".")); if (v > 0) this.r = v; });
    const elIn = el("input", { class: "field", type: "text", value: String(this.elev) });
    elIn.addEventListener("change", () => { const v = parseFloat(elIn.value.replace(",", ".")); if (isFinite(v)) { this.elev = v; this.v.redraw(); } });
    const orthoCb = el("input", { type: "checkbox", checked: this.ortho, id: "md-route-ortho" });
    orthoCb.addEventListener("change", () => (this.ortho = orthoCb.checked));
    const row = (l, i, u) => el("div", { class: "md-frow" }, el("label", {}, l), i, u ? el("span", { class: "md-unit" }, u) : null);
    const sketches = this.app.doc.features.filter(f => f.type === "sketch" && chainFromSketch(f.sk));
    r.append(el("div", { class: "md-dhead" }, el("span", { class: "md-dico", html: ICON.route }), el("b", {}, tr("mod.pl_instradamento"))),
      row(tr("mod.tipo"), kindSel), this.kind === "pipe" ? row(tr("mod.pl_classe"), specSel) : null, row(tr("mod.pl_misura"), sizeSel),
      row(tr("mod.pl_linea"), lineIn), row(tr("mod.pl_raggio_curve"), rIn, "mm"), row(tr("mod.pl_quota_partenza"), elIn, "mm"),
      el("div", { class: "md-frow md-check" }, orthoCb, el("label", { for: "md-route-ortho" }, tr("mod.pl_solo_assi"))),
      el("p", { class: "md-hint" }, tr("mod.pl_aiuto", this.pts.length)),
      el("div", { class: "md-subh" }, tr("mod.pl_converti")),
      el("button", { class: "btn", type: "button", onclick: () => this.fromEdges() }, el("span", { html: ICON.edge || ICON.line }), tr("mod.pl_da_spigoli")),
      sketches.length ? el("div", { class: "md-frow" }, el("label", {}, tr("mod.pl_da_schizzo")),
        el("select", { class: "field", onchange: ev => { if (ev.target.value) this.fromSketch(ev.target.value); } }, el("option", { value: "" }, "…"), ...sketches.map((f, i) => el("option", { value: f.id }, f.name || tr("mod.f_sketch") + " " + (i + 1))))) : null,
      el("div", { class: "md-dfoot" }, el("button", { class: "btn", type: "button", onclick: () => this.app.cancelTool() }, tr("common.chiudi")),
        el("button", { class: "btn primary", type: "button", disabled: this.pts.length < 2, onclick: () => this.finish() }, el("span", { html: ICON.ok }), tr("mod.pl_fine_percorso"))));
  }
  feature(extra) {
    const s = this.size;
    const f = { type: "route", kind: this.kind, size: s.id, r: this.r, op: "new", ...extra };
    if (s.od) f.od = s.od;
    if (s.w) { f.w = s.w; f.h = s.h; }
    f.t = s.t;
    if (s.spec) { f.spec = s.spec; f.pn = s.pn; f.mat = s.mat; f.fam = s.fam; }
    if (this.linea) f.linea = this.linea;
    return f;
  }
  fromEdges() {
    const edges = this.v.selection.filter(x => x.kind === "edge").map(x => x.info);
    const pts = chainFromEdges(edges);
    if (!pts) return toast(tr("mod.pl_scegli_spigoli"), true);
    this.app.commitFeature(this.feature({ pts }));
  }
  fromSketch(id) {
    this.app.commitFeature(this.feature({ sketch: id, fromSketch: true }));
  }
  // punto candidato sotto il mouse
  candidate(e) {
    const v = this.v;
    const s = v.snap(e, { tol: 10, faces: true });
    if (!this.pts.length) {
      if (s) return { p: [s.p.x, s.p.y, s.p.z], kind: s.kind };
      const p = v.onPlane(e, { o: [0, 0, this.elev], n: [0, 0, 1] });
      return p ? { p: [r1(p.x), r1(p.y), this.elev], kind: "free" } : null;
    }
    const last = this.pts[this.pts.length - 1];
    if (!this.ortho || e.shiftKey) {
      if (s) return { p: [s.p.x, s.p.y, s.p.z], kind: s.kind };
      const p = v.onPlane(e, { o: last, n: [0, 0, 1] });
      return p ? { p: [p.x, p.y, p.z].map(r1), kind: "free" } : null;
    }
    const i = screenAxis(v, last, v.local(e));
    let t;
    if (s && ["vertex", "center", "mid"].includes(s.kind)) t = dot(sub([s.p.x, s.p.y, s.p.z], last), AX[i]); // allineamento a un punto
    else { t = closestOnAxis(v.ray(e).ray, last, AX[i]); const st = niceStep(v.pxSize(V(last)) * 8); t = Math.round(t / st) * st; }
    return { p: add(last, mul(AX[i], t)), kind: s && ["vertex", "center", "mid"].includes(s.kind) ? s.kind : "axis", axis: i, t };
  }
  move(e) { this.cur = this.candidate(e); this.v.redraw(); }
  click(e) {
    const c = this.candidate(e);
    if (!c) return;
    if (this.pts.length && Math.hypot(...sub(c.p, this.pts[this.pts.length - 1])) < 1e-6) return;
    if (!this.pts.length) this.elev = c.p[2];
    this.pts.push(c.p.map(r6));
    this.render();
    this.v.redraw();
  }
  key(e) {
    if (e.key === "Escape") { if (this.pts.length) { this.pts.pop(); this.render(); this.v.redraw(); return true; } return false; }
    if (e.key === "Backspace" && this.pts.length) { this.pts.pop(); this.render(); this.v.redraw(); return true; }
    if (e.key === "Enter" && this.pts.length >= 2) { this.finish(); return true; }
    if (/^[0-9.,-]$/.test(e.key) && this.pts.length && !e.ctrlKey) {
      const last = this.pts[this.pts.length - 1], cur = this.cur;
      const i = cur?.axis ?? 0, sign = (cur?.t ?? 1) < 0 ? -1 : 1;
      this.inp = numberBox(this.v, this.v.toScreen(last), tr("mod.distanza"), val => {
        this.inp = null;
        if (!val || !val.trim()) return;
        let d;
        try { d = evalExpr(val.trim(), this.app.vals || {}); } catch { return toast(tr("mod.valore_non_valido"), true); }
        if (!val.trim().startsWith("-")) d *= sign;
        this.pts.push(add(last, mul(AX[i], d)).map(r6));
        this.render();
        this.v.redraw();
      });
      this.inp.value = e.key;
      this.inp.focus();
      return true;
    }
    return false;
  }
  finish() {
    if (this.pts.length < 2) return;
    const pts = this.pts;
    this.pts = [];
    this.app.commitFeature(this.feature({ pts }));
  }
  paint(g) {
    const v = this.v;
    const pts = [...this.pts, ...(this.cur ? [this.cur.p] : [])];
    const s = this.size;
    const wpx = (s.od || s.w) / v.pxSize(V(pts[0] || [0, 0, 0]));
    if (pts.length >= 2) {
      g.lineCap = "round"; g.lineJoin = "round";
      g.strokeStyle = "rgba(240,125,46,.28)"; g.lineWidth = Math.max(3, Math.min(wpx, 120));
      g.beginPath(); pts.forEach((p, k) => { const q = v.toScreen(p); if (k) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); }); g.stroke();
      g.strokeStyle = ACCENT; g.lineWidth = 2;
      g.beginPath(); pts.forEach((p, k) => { const q = v.toScreen(p); if (k) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); }); g.stroke();
    }
    g.fillStyle = ACCENT;
    for (const p of this.pts) { const q = v.toScreen(p); g.fillRect(q[0] - 4, q[1] - 4, 8, 8); }
    if (this.cur) {
      const q = v.toScreen(this.cur.p);
      g.strokeStyle = this.cur.axis !== undefined ? AXC[this.cur.axis] : ACCENT; g.lineWidth = 2;
      g.beginPath(); g.arc(q[0], q[1], 6, 0, 7); g.stroke();
      const last = this.pts[this.pts.length - 1];
      label(g, q, last ? fmt(Math.hypot(...sub(this.cur.p, last))) + " mm" + (this.cur.axis !== undefined ? "  " + "XYZ"[this.cur.axis] : "") : `${kindName(this.kind)} ${s.id} · z ${fmt(this.cur.p[2])}`);
    }
  }
}
const r1 = x => Math.round(x);

// ================================================================================================= nodi dei percorsi
export class NodeHandles {
  constructor(app) {
    this.app = app;
    this.v = app.view;
    this.paint = g => this.draw(g);
    this.v.overlays.add(this.paint);
    this.onDown = e => this.down(e);
    this.onMove = e => this.move(e);
    this.onUp = e => this.up(e);
    this.v.canvas.addEventListener("pointerdown", this.onDown, true);
    window.addEventListener("pointermove", this.onMove, true);
    window.addEventListener("pointerup", this.onUp, true);
  }
  dispose() {
    this.v.overlays.delete(this.paint);
    this.v.canvas.removeEventListener("pointerdown", this.onDown, true);
    window.removeEventListener("pointermove", this.onMove, true);
    window.removeEventListener("pointerup", this.onUp, true);
  }
  // percorso modificabile: un solo corpo d'impianto selezionato, non spostato dopo (i nodi sono quelli della lavorazione)
  route() {
    if (this.app.tool || this.app.sketch) return null;
    const ids = [...new Set(this.v.selection.filter(s => s.kind === "body").map(s => s.body))];
    if (ids.length !== 1) return null;
    const b = (this.app.res?.bodies || []).find(q => q.id === ids[0]);
    const f = this.app.doc.features.find(q => q.id === ids[0] && q.type === "route");
    if (!b?.meta || !f || b.src !== f.id || f.sketch) return null;
    return { f, nodes: this.drag?.nodes || f.pts };
  }
  hitNode(e, r) {
    const [mx, my] = this.v.local(e);
    let best = -1, bd = 9;
    r.nodes.forEach((p, i) => { const s = this.v.toScreen(p); const d = Math.hypot(s[0] - mx, s[1] - my); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  down(e) {
    if (e.button !== 0) return;
    const r = this.route();
    if (!r) return;
    const i = this.hitNode(e, r);
    if (i < 0) return;
    e.stopImmediatePropagation(); e.preventDefault(); // prima della rotazione della vista (OrbitControls sullo stesso elemento)
    this.v.controls.enabled = false;
    this.drag = { i, f: r.f, nodes: r.f.pts.map(p => [...p]), orig: [...r.f.pts[i]] };
  }
  move(e) {
    const d = this.drag;
    if (!d) return;
    e.stopPropagation();
    const o = d.orig, ax = screenAxis(this.v, o, this.v.local(e));
    let t = closestOnAxis(this.v.ray(e).ray, o, AX[ax]);
    const s = this.v.snap(e, { tol: 10, faces: false });
    if (s && ["vertex", "center", "mid"].includes(s.kind)) t = dot(sub([s.p.x, s.p.y, s.p.z], o), AX[ax]);
    else if (!e.ctrlKey) { const st = niceStep(this.v.pxSize(V(o)) * 8); t = Math.round(t / st) * st; }
    d.nodes[d.i] = add(o, mul(AX[ax], t)).map(r6);
    d.ax = ax; d.t = t;
    this.v.redraw();
  }
  up(e) {
    const d = this.drag;
    if (!d) return;
    e?.stopPropagation();
    this.drag = null;
    this.v.controls.enabled = true;
    if (Math.hypot(...sub(d.nodes[d.i], d.orig)) < 1e-9) { this.v.redraw(); return; }
    d.f.pts = d.nodes;
    this.app.commit(tr("mod.pl_sposta_nodo"));
  }
  draw(g) {
    const r = this.route();
    if (!r) return;
    const v = this.v, d = this.drag;
    if (d) {
      g.strokeStyle = ACCENT; g.lineWidth = 2; g.setLineDash([6, 4]);
      g.beginPath(); r.nodes.forEach((p, k) => { const q = v.toScreen(p); if (k) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); }); g.stroke();
      g.setLineDash([]);
    }
    r.nodes.forEach((p, i) => {
      const q = v.toScreen(p);
      g.fillStyle = d?.i === i ? ACCENT : "#ffffff"; g.strokeStyle = ACCENT; g.lineWidth = 2;
      g.beginPath(); g.arc(q[0], q[1], 5.5, 0, 7); g.fill(); g.stroke();
    });
    if (d) label(g, v.toScreen(d.nodes[d.i]), fmt(d.t || 0) + " mm  " + "XYZ"[d.ax ?? 0]);
  }
}
