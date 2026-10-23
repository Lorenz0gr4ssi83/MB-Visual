// Misure sui disegni CAD (DWG/DXF, ui/js/viewers/cad2d.js) e sui fogli DWF/DWFx (ui/js/viewers/dwf.js).
// Valgono le unita' del file ($INSUNITS nei DWG/DXF, unita' dei riquadri nei DWF); le misure si salvano nel file .mbmis
// accanto al disegno (salvataggio automatico nell'app per PC). Il visualizzatore inoltra gli eventi del mouse (down/move/
// up/dbl/context/key, coordinate del canvas in pixel del dispositivo) e chiama paint(g2) dopo aver disegnato.
import { api, baseName, button, dirName, el, readBytes, saveBlobAs, WEB, loadCss } from "../core.js";
import { t as tr } from "../i18n.js";
import { osnap } from "../cadgeom.js";
import * as C from "./mcore.js";
import * as X from "./mextract.js";
import { createSession, micon } from "./mpanel.js";
import { createEngine2d, snapModel } from "./mtool.js";

const SNAP = { end: true, mid: true, cen: true, int: true, qua: true, ins: true, nod: true };
const TAU = Math.PI * 2;
export const mbmisPath = p => (p ? p.replace(/\.[^.\\/]+$/, "") + ".mbmis" : null);

// salvataggio e lettura del file .mbmis accanto al disegno o al modello
export function mbmisStore(ctx) {
  const p = mbmisPath(ctx.path);
  return {
    path: p,
    async load() {
      if (WEB || !p) return null;
      const st = await api("stat", { path: p }, { allowFail: true }).catch(() => null);
      if (!st?.ok) return null;
      try { return JSON.parse(new TextDecoder().decode(await readBytes(p))); } catch { return null; }
    },
    async persist(doc) {
      const text = C.serialize(doc);
      if (WEB || !p) return saveBlobAs(baseName(p || ctx.name + ".mbmis"), new Blob([text], { type: "application/json" }), dirName(ctx.path || ""));
      await api("save", { path: p }, { body: new TextEncoder().encode(text) });
    },
  };
}

// pulsante "Misure" nella barra del visualizzatore (icona + testo, acceso quando il pannello e' aperto)
export function measureButton(onclick) {
  return button(tr("mis.misure"), micon("area", 16), onclick, { title: tr("mis.misure_titolo"), comp: "measure" });
}

function baseFromHeader(H) {
  const u = C.INSUNITS[H?.INSUNITS ?? H?.$INSUNITS];
  return u ? { k: 1, unit: u, label: u } : { k: 1, unit: "mm", label: "mm", guessed: true };
}

// ================================================================ DWG / DXF
export async function attachCad(ctx, cad) {
  loadCss("css/measure.css");
  const store = mbmisStore(ctx);
  const base = baseFromHeader(cad.getModel().header);
  let hl = null, hlT = null;
  const env = {
    space: "cad", host: cad.host, ctx, base, autosave: !WEB,
    unitNote: base.guessed ? tr("mis.unita_non_dichiarate") : tr("mis.unita_dichiarate", base.unit),
    tools: ["calib", "refelev", "len", "pline", "perim", "area", "hole", "vol", "ang", "rad", "elev", "count", "objlen", "objarea", "similar"],
    redraw: () => cad.draw(),
    focus: m => zoomPts(m.pts),
    showRecs: recs => { hl = recs; clearTimeout(hlT); hlT = setTimeout(() => { hl = null; cad.draw(); }, 5000); zoomPts(recs.flatMap(r => r.shape?.pts || r.shape?.loops?.[0] || (r.at ? [r.at] : []))); },
    focusRec: f => zoomPts([f.at]),
    onTool: t => cad.onTool?.(t),
    onPanel: v => cad.onPanel?.(v),
    persist: doc => store.persist(doc),
    extractors: cadExtractors(cad),
  };
  const M = createSession(env);
  const E = (M.engine = createEngine2d(M));
  const d0 = await store.load();
  if (d0) M.loadDoc(d0);
  else if (["mm", "cm", "dm"].includes(base.unit)) M.doc.disp.unit = "m"; // computo in metri anche per i disegni in millimetri
  function zoomPts(P) {
    if (!P?.length) return;
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const [x, y] of P) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
    const pad = Math.max(c - a, d - b, 1e-6) * 0.25 + 1e-6;
    cad.zoomTo([a - pad, b - pad, c + pad, d + pad]);
  }
  const hidden = it => cad.getModel().layers.get(it.l)?.off;
  const surf = {
    page: null,
    get px() { return devicePixelRatio || 1; },
    toScreen: p => cad.toScreen(p[0], p[1]),
    toWorld: (x, y) => cad.toWorld(x, y),
    snap: (sx, sy) => { const [wx, wy] = cad.toWorld(sx, sy); return osnap(cad.getModel(), wx, wy, (10 * (devicePixelRatio || 1)) / cad.view.s, SNAP, E.cur?.pts.at(-1) || null, hidden); },
    pick: async (sx, sy, wantClosed) => pickCad(cad, sx, sy, wantClosed, hidden),
    similar: async (sx, sy) => similarBlocks(cad, sx, sy, hidden),
    redraw: () => cad.draw(),
  };
  return {
    M, E,
    get active() { return !!M.tool && M.panel.open; },
    toggle: () => M.panel.toggle(),
    get open() { return M.panel.open; },
    down: (e, x, y) => M.panel.open && E.down(surf, x, y, e),
    move: (e, x, y) => M.panel.open && E.move(surf, x, y, e),
    up: (e, x, y) => E.up(surf, x, y, e),
    dbl: (e, x, y) => M.panel.open && E.dbl(surf, x, y, e),
    context: () => M.panel.open && E.context(),
    key: e => {
      if (!M.panel.open || e.target.closest?.("input, textarea, select")) return false;
      if (E.key(e)) return true;
      if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
        const k = e.key.toUpperCase();
        if (k === "V") { M.setTool("select"); return true; }
        const hit = Object.entries(M.keys).find(([id, key]) => key === k && env.tools.includes(id));
        if (hit) { M.setTool(hit[0]); return true; }
      }
      return false;
    },
    paint(g) {
      if (!M.doc.items.length && !E.cur && !E.hover && !hl) return;
      E.paint(surf, g);
      if (hl) paintHl(g, hl, surf);
    },
    dispose() { M.flushSave?.().catch(() => {}); },
  };
}

function paintHl(g, recs, surf) {
  const px = surf.px;
  g.save();
  g.strokeStyle = "#ffd400"; g.lineWidth = 2.5 * px; g.setLineDash([5 * px, 3 * px]);
  for (const r of recs.slice(0, 5000)) {
    const loops = r.shape?.loops || (r.shape?.pts ? [r.shape.pts] : null);
    if (loops) { g.beginPath(); for (const L of loops) L.forEach((p, i) => { const [x, y] = surf.toScreen(p); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke(); continue; }
    if (r.at) { const [x, y] = surf.toScreen(r.at); g.beginPath(); g.arc(x, y, 9 * px, 0, 7); g.stroke(); }
  }
  g.restore();
}

// arco fitto (1 grado): misure di lunghezza e area degli oggetti esatte al centesimo di millesimo
function arcPtsFine(it) {
  const n = Math.max(8, Math.ceil(Math.abs(it.sw) / (Math.PI / 180)));
  return Array.from({ length: n + 1 }, (_, i) => { const a = it.a0 + (it.sw * i) / n; return [it.cx + it.r * Math.cos(a), it.cy + it.r * Math.sin(a)]; });
}
function pickCad(cad, sx, sy, wantClosed, hidden) {
  const model = cad.getModel(), db = cad.db;
  const [x, y] = cad.toWorld(sx, sy), tol = (8 * (devicePixelRatio || 1)) / cad.view.s;
  if (wantClosed) {
    // retino che contiene il punto (con i fori), poi il contorno chiuso piu' piccolo che lo contiene o e' vicino
    let best = null, ba = Infinity;
    for (const h of model.hatches || []) {
      if (hidden(h)) continue;
      const outer = h.loops.reduce((a, L) => (Math.abs(C.signedArea(L)) > Math.abs(C.signedArea(a)) ? L : a), h.loops[0]);
      if (!C.pointInPoly(x, y, outer)) continue;
      const area = C.regionArea(h.loops);
      if (area < ba) { ba = area; best = { pts: outer, closed: true, holes: h.loops.filter(L => L !== outer), layer: h.l, label: tr("mis.retino") + (h.pattern ? " " + h.pattern : "") }; }
    }
    for (const s of model.closed || []) {
      if (hidden(s)) continue;
      const inside = C.pointInPoly(x, y, s.pts);
      let near = false;
      if (!inside) for (let i = 1; i < s.pts.length && !near; i++) near = segD(x, y, s.pts[i - 1], s.pts[i]) <= tol;
      if (!inside && !near) continue;
      const area = C.polyArea(s.pts);
      if (area < ba || near) { ba = near ? -1 : area; best = { pts: dedupeClose(s.pts), closed: true, holes: [], layer: s.l, label: s.kind }; }
      if (near) break;
    }
    return best;
  }
  const ids = model.query(x - tol, y - tol, x + tol, y + tol);
  let hit = null, hd = tol;
  for (const i of ids) {
    const it = model.items[i];
    if (it.t === "Q" || it.t === "N" || it.hatch || hidden(it)) continue;
    let d = Infinity;
    if (it.t === "L") d = segD(x, y, [it.x1, it.y1], [it.x2, it.y2]);
    else { const P = it.t === "A" ? it.pts : it.pts; for (let k = 1; k < P.length; k++) d = Math.min(d, segD(x, y, P[k - 1], P[k])); }
    if (d <= hd) { hd = d; hit = it; }
  }
  if (!hit) return null;
  const ent = db.entities[hit.o];
  const type = ent?.type || "";
  // polilinea intera: i suoi segmenti (stessa entita' e stesso percorso nei blocchi) in ordine
  if (/POLYLINE/.test(type) && hit.s === "") {
    const segs = (model.ents[hit.o] || []).map(i => model.items[i]).filter(it => it.s === hit.s && (it.t === "L" || it.t === "A"));
    const pts = [];
    for (const it of segs) {
      const P = it.t === "L" ? [[it.x1, it.y1], [it.x2, it.y2]] : arcPtsFine(it);
      if (pts.length) { const q = pts[pts.length - 1]; if (Math.hypot(q[0] - P[0][0], q[1] - P[0][1]) > Math.hypot(q[0] - P[P.length - 1][0], q[1] - P[P.length - 1][1])) P.reverse(); P.shift(); }
      pts.push(...P);
    }
    const closed = !!(ent.flag & 1) || ent.closed;
    return { pts: closed ? dedupeClose(pts) : pts, closed, layer: hit.l, label: type };
  }
  if (hit.t === "L") return { pts: [[hit.x1, hit.y1], [hit.x2, hit.y2]], closed: false, layer: hit.l, label: type || "LINE" };
  if (hit.t === "A") {
    const full = Math.abs(hit.sw) >= TAU - 1e-9;
    const P = arcPtsFine(hit);
    return { pts: full ? P.slice(0, -1) : P, closed: full, layer: hit.l, label: type || "ARC" };
  }
  return { pts: hit.closed ? dedupeClose(hit.pts) : hit.pts, closed: !!hit.closed, layer: hit.l, label: type };
}
const dedupeClose = P => (P.length > 2 && Math.hypot(P[0][0] - P[P.length - 1][0], P[0][1] - P[P.length - 1][1]) < 1e-9 ? P.slice(0, -1) : P);
function similarBlocks(cad, sx, sy, hidden) {
  const model = cad.getModel();
  const [x, y] = cad.toWorld(sx, sy), tol = (8 * (devicePixelRatio || 1)) / cad.view.s;
  const ids = model.query(x - tol, y - tol, x + tol, y + tol);
  let o = null, bd = Infinity;
  for (const i of ids) {
    const it = model.items[i];
    if (hidden(it)) continue;
    const bb = it.bb;
    const d = bb ? Math.max(0, bb[0] - x, x - bb[2]) + Math.max(0, bb[1] - y, y - bb[3]) : Infinity;
    if (d < bd && cad.db.entities[it.o]?.type === "INSERT") { bd = d; o = it.o; }
  }
  if (o == null) return null;
  const ins = (model.inserts || []).find(b => b.o === o && b.depth === 0);
  if (!ins) return null;
  return (model.inserts || []).filter(b => b.name === ins.name && !hidden(b)).map(b => [b.x, b.y]);
}
function segD(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const u = L ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L)) : 0;
  return Math.hypot(a[0] + u * dx - x, a[1] + u * dy - y);
}

function cadExtractors(cad) {
  const visible = it => cad.getModel().layers.get(it.l)?.off;
  const G = { layer: tr("mis.layer"), color: tr("mis.colore"), lt: tr("mis.tipo_linea"), type: tr("mis.tipo_entita"), kind: tr("mis.tipo_entita"), pattern: tr("mis.motivo"), name: tr("mis.blocco") };
  const lab = r => ({ ...r, groups: r.groups.map(g => ({ ...g, label: G[g.k] || g.k })) });
  return [
    { id: "len", label: tr("mis.x_lunghezze"), title: tr("mis.x_lunghezze_titolo"), run: async () => lab({ ...X.cadLengths(cad.getModel(), cad.db, { skipHidden: visible }), note: tr("mis.x_lunghezze_nota") }) },
    { id: "area", label: tr("mis.x_aree"), title: tr("mis.x_aree_titolo"), run: async () => lab(X.cadAreas(cad.getModel(), { skipHidden: visible })) },
    { id: "blocks", label: tr("mis.x_blocchi"), title: tr("mis.x_blocchi_titolo"), run: async () => lab(X.cadBlocks(cad.getModel(), cad.db)) },
    { id: "texts", label: tr("mis.x_testi"), title: tr("mis.x_testi_titolo"), run: async () => {
      const rows = X.cadTexts(cad.getModel(), cad.db);
      const K = { quota: tr("mis.k_quota"), livello: tr("mis.k_livello"), testo: tr("mis.k_testo"), quota_cad: tr("mis.k_quota_cad") };
      return { table: { head: [tr("mis.testo"), tr("mis.tipo"), tr("mis.layer"), "X", "Y", tr("mis.altezza_testo")], rows: rows.map(r => ({ cells: [r.text, K[r.kind], r.layer, round(r.x), round(r.y), r.h != null ? round(r.h) : ""], focus: { at: r.at } })) } };
    } },
  ];
}
const round = v => (v == null ? "" : Math.round(v * 1000) / 1000);

// ================================================================ DWF / DWFx (fogli 2D in coordinate della carta)
const DWF_UNIT = { mm: "mm", cm: "cm", m: "m", in: "in", ft: "ft", ftin: "in" };
export async function attachDwf(ctx, dw) {
  loadCss("css/measure.css");
  const store = mbmisStore(ctx);
  const env = {
    space: "dwf", paged: true, host: dw.host, ctx, autosave: !WEB,
    get paperUnit() { return DWF_UNIT[dw.sheet()?.paper?.units] || "mm"; },
    get base() { const u = DWF_UNIT[dw.sheet()?.paper?.units] || "mm"; return { k: 1, unit: u, label: u }; },
    unitNote: tr("mis.dwf_unita"),
    tools: ["calib", "vp", "refelev", "len", "pline", "perim", "area", "hole", "vol", "ang", "rad", "elev", "count", "objlen", "objarea", "similar"],
    redraw: () => dw.draw(),
    curPage: () => dw.sheetIndex(),
    focus: m => { if (m.page != null && m.page !== dw.sheetIndex()) dw.openIndex(m.page).then(() => zoom(m.pts)); else zoom(m.pts); },
    showRecs: recs => zoom(recs.map(r => r.at).filter(Boolean)),
    onTool: t => dw.onTool?.(t),
    persist: doc => store.persist(doc),
    autoScale: async () => sheetScales(dw.sheet(), dw.sheetIndex()),
    extractors: [
      { id: "len", label: tr("mis.x_lunghezze_stile"), title: tr("mis.x_lunghezze_stile_titolo"), run: async ({ doc }) => ({ records: X.vecRecords(paths(), regions(doc)), groups: groupsVec() }) },
      { id: "sym", label: tr("mis.x_simboli"), title: tr("mis.x_simboli_titolo"), run: async () => symbolsRec() },
    ],
  };
  const M = createSession(env);
  M.doc.space = "dwf";
  const E = (M.engine = createEngine2d(M));
  const d0 = await store.load();
  if (d0) M.loadDoc(d0);
  let cache = { sheet: null, paths: null, snap: null, clusters: null };
  function paths() {
    const sh = dw.sheet();
    if (cache.sheet === sh && cache.paths) return cache.paths;
    const pg = dw.sheetIndex();
    const hex = c => "#" + c.slice(0, 3).map(v => v.toString(16).padStart(2, "0")).join("");
    const P = sh.prims.filter(p => p.t === "p" && !p.mk && dw.isVisible(p)).map(p => ({ rings: p.rings, closed: p.closed, stroke: p.fill ? "" : hex(p.color), fill: p.fill ? hex(p.color) : "", w: p.lw || 0, dash: p.dash ? "—" : "", layer: p.layer || "", page: pg }));
    cache = { sheet: sh, paths: P, snap: null, clusters: null };
    return P;
  }
  const regions = doc => (doc.scales || []).filter(s => s.box).map(s => ({ id: s.id, page: s.page, box: s.box }));
  const groupsVec = () => [{ k: "layer", label: tr("mis.layer") }, { k: "style", label: tr("mis.stile") }, { k: "stroke", label: tr("mis.colore") }, { k: "fill", label: tr("mis.riempimento") }];
  function symbolsRec() {
    const sh = dw.sheet();
    cache.clusters ||= X.vecClusters(paths(), sh.bbox);
    const bySig = new Map();
    for (const c of cache.clusters) { if (!bySig.has(c.sig)) bySig.set(c.sig, []); bySig.get(c.sig).push(c); }
    const recs = [];
    let n = 0;
    for (const list of [...bySig.values()].filter(l => l.length > 1).sort((a, b) => b.length - a.length)) {
      n++;
      for (const c of list) recs.push({ g: { sym: tr("mis.simbolo_n", n) + ` (${fmtSize(c.box)})`, layer: c.layer || "" }, page: c.page, at: [(c.box[0] + c.box[2]) / 2, (c.box[1] + c.box[3]) / 2], count: 1, color: c.color });
    }
    return { records: recs, groups: [{ k: "sym", label: tr("mis.simbolo") }, { k: "layer", label: tr("mis.layer") }] };
  }
  const fmtSize = b => `${+(b[2] - b[0]).toFixed(2)}×${+(b[3] - b[1]).toFixed(2)}`;
  function zoom(P) {
    if (!P?.length) return;
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const [x, y] of P) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
    const pad = Math.max(c - a, d - b, 1e-6) * 0.25 + 1e-6;
    dw.zoomTo([a - pad, b - pad, c + pad, d + pad]);
  }
  const surf = {
    get page() { return dw.sheetIndex(); },
    get px() { return devicePixelRatio || 1; },
    toScreen: p => dw.toScreen(p[0], p[1]),
    toWorld: (x, y) => dw.toWorld(x, y),
    snap: (sx, sy) => {
      paths();
      cache.snap ||= snapModel(X.vecSnapItems(cache.paths));
      const [wx, wy] = dw.toWorld(sx, sy);
      return osnap(cache.snap, wx, wy, (10 * (devicePixelRatio || 1)) / dw.view.s, { end: true, mid: true, cen: true, int: true, qua: true }, E.cur?.pts.at(-1) || null);
    },
    pick: async (sx, sy, wantClosed) => { const [x, y] = dw.toWorld(sx, sy); return X.vecPick(paths(), x, y, (8 * (devicePixelRatio || 1)) / dw.view.s, wantClosed); },
    similar: async (sx, sy) => {
      const [x, y] = dw.toWorld(sx, sy);
      cache.clusters ||= X.vecClusters(paths(), dw.sheet().bbox);
      const hit = cache.clusters.filter(c => x >= c.box[0] && x <= c.box[2] && y >= c.box[1] && y <= c.box[3]).sort((a, b) => (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) - (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]))[0];
      if (!hit) return null;
      return cache.clusters.filter(c => c.sig === hit.sig).map(c => [(c.box[0] + c.box[2]) / 2, (c.box[1] + c.box[3]) / 2]);
    },
    redraw: () => dw.draw(),
  };
  // scale dei riquadri del foglio (unita' del disegno lette dal DWF), applicate la prima volta che si apre il foglio
  function applySheetScales() {
    const pg = dw.sheetIndex();
    if (M.doc.scales.some(s => s.page === pg)) return;
    for (const s of sheetScales(dw.sheet(), pg)) M.doc.scales.push({ ...s, id: C.uid() });
    if (!M.doc.items.length && M.doc.scales.length) M.doc.disp.unit = M.doc.scales[0].unit === "in" ? "ft" : M.doc.scales[0].unit === "mm" ? "m" : M.doc.scales[0].unit;
  }
  return {
    M, E,
    toggle: () => { applySheetScales(); M.panel.toggle(); },
    get open() { return M.panel.open; },
    sheetChanged: () => { cache = { sheet: null }; E.cancel(); if (M.panel.open) applySheetScales(); M.redraw(); },
    down: (e, x, y) => M.panel.open && E.down(surf, x, y, e),
    move: (e, x, y) => M.panel.open && E.move(surf, x, y, e),
    up: (e, x, y) => E.up(surf, x, y, e),
    dbl: (e, x, y) => M.panel.open && E.dbl(surf, x, y, e),
    context: () => M.panel.open && E.context(),
    key: e => M.panel.open && !e.target.closest?.("input, textarea, select") && E.key(e),
    paint: g => { if (M.doc.items.length || E.cur || E.hover) E.paint(surf, g); },
    dispose() { M.flushSave?.().catch(() => {}); },
  };
}
function sheetScales(sheet, page) {
  const out = [];
  for (const u of sheet?.units || []) {
    if (!(u.perPaper > 0)) continue;
    const unit = DWF_UNIT[u.name] || "mm";
    let box = null;
    if (u.region?.length) {
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      for (const r of u.region) for (let i = 0; i + 1 < r.length; i += 2) { a = Math.min(a, r[i]); b = Math.min(b, r[i + 1]); c = Math.max(c, r[i]); d = Math.max(d, r[i + 1]); }
      box = [a, b, c, d];
    }
    out.push({ page, box, k: u.perPaper, unit, label: (u.label ? u.label + " · " : "") + unit, source: "DWF" });
  }
  return out;
}
