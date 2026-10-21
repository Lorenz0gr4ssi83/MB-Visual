// Editor dei disegni CAD 2D (DWG/DXF) in stile AutoCAD.
// Selezione: clic con tolleranza sul tratto piu' vicino (clic ripetuto = oggetto sovrapposto successivo), finestra da
// sinistra a destra (interamente dentro), intersezione da destra a sinistra, Maiusc toglie, Ctrl seleziona dentro i
// blocchi, evidenziazione al passaggio, grip per stirare. Comandi con riga di comando (alias AutoCAD, coordinate x,y
// @dx,dy @d<a, distanza diretta), aggancio ai punti notevoli, ortogonale. Disegno, quote (salvate come vere DIMENSION),
// modifica (sposta, copia, ruota, scala, specchio, serie, offset, taglia, estendi, raccordo, cimatura, esplodi),
// misure, proprieta' su piu' oggetti. Al salvataggio il motore ezdxf scrive il DXF (mbvisual/cadedit.py).
import { askText, el, modal, toast } from "./core.js";
import * as G from "./cadgeom.js";
import { cadIcon } from "./cadicons.js";
import { describeKeys } from "./shortcuts.js";
import { LOCALE } from "./i18n.js";

// copia profonda (i DWG possono contenere interi BigInt nei dati estesi)
const plain = (k, v) => (typeof v === "bigint" ? Number(v) : v);
const clone = o => (o === undefined ? undefined : JSON.parse(JSON.stringify(o, plain)));
const { R2D, TAU } = G;
const COLORS = [[256, "DaLayer"], [0, "DaBlocco"], [1, "Rosso"], [2, "Giallo"], [3, "Verde"], [4, "Ciano"], [5, "Blu"], [6, "Magenta"], [7, "Bianco/Nero"], [8, "Grigio scuro"], [9, "Grigio"], [30, "Arancio"]];
const LWEIGHTS = [[-1, "DaLayer"], [-2, "DaBlocco"], [-3, "Predefinito"], [0, "0,00 mm"], [13, "0,13 mm"], [18, "0,18 mm"], [25, "0,25 mm"], [35, "0,35 mm"], [50, "0,50 mm"], [70, "0,70 mm"], [100, "1,00 mm"], [140, "1,40 mm"], [200, "2,00 mm"]];
const LTYPES_STD = ["ByLayer", "ByBlock", "Continuous", "DASHED", "HIDDEN", "CENTER", "DASHDOT", "PHANTOM", "DOT", "DIVIDE", "BORDER"];
const TYPE_IT = { LINE: "Linea", CIRCLE: "Cerchio", ARC: "Arco", ELLIPSE: "Ellisse", LWPOLYLINE: "Polilinea", POLYLINE2D: "Polilinea 2D", POLYLINE3D: "Polilinea 3D", SPLINE: "Spline",
  TEXT: "Testo", MTEXT: "Testo multiriga", INSERT: "Blocco", DIMENSION: "Quota", HATCH: "Tratteggio", POINT: "Punto", SOLID: "Solido 2D", LEADER: "Direttrice", "3DFACE": "Faccia 3D", ATTRIB: "Attributo", TRACE: "Traccia" };
const MIRX = [-1, 0, 0, 1, 0, 0];
// appunti condivisi tra i disegni aperti (Ctrl+C / Ctrl+V come in AutoCAD)
let CLIP = null;
const CANCEL = new Error("annullato");
const num = v => { const n = parseFloat(String(v).trim().replace(",", ".")); return isFinite(n) ? n : null; };
const f4 = v => (typeof v === "number" ? +v.toFixed(4) : v);
const fmt = v => (typeof v === "number" ? v.toLocaleString(LOCALE, { maximumFractionDigits: 4 }) : String(v));
const P = ([x, y]) => ({ x, y, z: 0 });
const XY = p => [p.x, p.y];
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

// ---------------------------------------------------------------- trasformazione affine di un'entita' (in coordinate del disegno)
export function xform(e, A, blocks) {
  const Aw = A;
  if (e.extrusionDirection && e.extrusionDirection.z < -0.5 && ["CIRCLE", "ARC", "LWPOLYLINE", "POLYLINE2D", "TEXT", "ATTRIB", "INSERT", "HATCH", "SOLID", "TRACE"].includes(e.type)) A = G.mul(MIRX, G.mul(A, MIRX));
  const m = G.det(A) < 0, k = Math.sqrt(Math.abs(G.det(A)));
  const Pt = p => { if (p && typeof p.x === "number") { const [x, y] = G.ap(A, p.x, p.y); p.x = x; p.y = y; } };
  const V = p => { if (p && typeof p.x === "number") { const [x, y] = G.apv(A, p.x, p.y); p.x = x; p.y = y; } };
  const ang = a => { const [x, y] = G.apv(A, Math.cos(a || 0), Math.sin(a || 0)); return Math.atan2(y, x); };
  const readable = r => (m && Math.cos(r) < -1e-9 ? r + Math.PI : r);
  switch (e.type) {
    case "LINE": Pt(e.startPoint); Pt(e.endPoint); break;
    case "CIRCLE": Pt(e.center); e.radius *= k; break;
    case "ARC": { Pt(e.center); e.radius *= k; let s = ang(e.startAngle), en = ang(e.endAngle); if (m) [s, en] = [en, s]; e.startAngle = s; e.endAngle = en; break; }
    case "ELLIPSE": Pt(e.center); V(e.majorAxisEndPoint); if (m) [e.startAngle, e.endAngle] = [-e.endAngle, -e.startAngle]; break;
    case "LWPOLYLINE": case "POLYLINE2D": case "POLYLINE3D":
      (e.vertices || []).forEach(v => { if (typeof v.x === "number") { const [x, y] = G.ap(A, v.x, v.y); v.x = x; v.y = y; } if (v.point) Pt(v.point); if (m && v.bulge) v.bulge = -v.bulge; if (v.startWidth) v.startWidth *= k; if (v.endWidth) v.endWidth *= k; });
      if (e.constantWidth) e.constantWidth *= k;
      break;
    case "SPLINE": (e.controlPoints || []).forEach(Pt); (e.fitPoints || []).forEach(Pt); break;
    case "POINT": Pt(e.position); break;
    case "LEADER": (e.vertices || []).forEach(Pt); break;
    case "SOLID": case "TRACE": case "3DFACE": ["corner1", "corner2", "corner3", "corner4"].forEach(c => Pt(e[c])); break;
    case "TEXT": case "ATTRIB": case "ATTDEF": Pt(e.startPoint); Pt(e.endPoint); e.textHeight = (e.textHeight || 1) * k; e.rotation = readable(ang(e.rotation)); break;
    case "MTEXT":
      Pt(e.insertionPoint); e.textHeight = (e.textHeight || 1) * k; if (e.rectWidth) e.rectWidth *= k;
      if (e.direction && (e.direction.x || e.direction.y)) { const r = readable(ang(Math.atan2(e.direction.y, e.direction.x))); e.direction = { x: Math.cos(r), y: Math.sin(r), z: 0 }; e.rotation = r; }
      else e.rotation = readable(ang(e.rotation));
      break;
    case "INSERT":
      Pt(e.insertionPoint); e.rotation = ang(e.rotation); e.xScale = (e.xScale || 1) * k; e.yScale = (e.yScale || 1) * k * (m ? -1 : 1);
      if (e.columnSpacing) e.columnSpacing *= k; if (e.rowSpacing) e.rowSpacing *= k;
      (e.attribs || []).forEach(a => xform(a, Aw, blocks));
      break;
    case "HATCH":
      for (const path of e.boundaryPaths || []) {
        (path.vertices || []).forEach(v => { const [x, y] = G.ap(A, v.x, v.y); v.x = x; v.y = y; if (m && v.bulge) v.bulge = -v.bulge; });
        for (const ed of path.edges || []) {
          if (ed.type === 1) { Pt(ed.start); Pt(ed.end); }
          else if (ed.type === 2) {
            let s = ed.startAngle, en = ed.endAngle;
            if (ed.isCCW === false) { [s, en] = [-en, -s]; ed.isCCW = true; }
            Pt(ed.center); ed.radius *= k; s = ang(s); en = ang(en); if (m) [s, en] = [en, s];
            ed.startAngle = s; ed.endAngle = en;
          } else if (ed.type === 3) { Pt(ed.center); V(ed.end); if (m) [ed.startAngle, ed.endAngle] = [-ed.endAngle, -ed.startAngle]; }
          else if (ed.type === 4) (ed.controlPoints || []).forEach(Pt);
        }
      }
      if (e.patternScale) e.patternScale *= k;
      e.patternAngle = ang(e.patternAngle || 0);
      (e.definitionLines || []).forEach(d => { Pt(d.base); V(d.offset); d.angle = ang(d.angle); d.dashLengths = (d.dashLengths || []).map(v => v * k); });
      (e.seedPoints || []).forEach(Pt);
      break;
    case "DIMENSION":
      if (e.dimKind) {
        ["p1", "p2", "loc", "c", "feat", "leader"].forEach(c => Pt(e[c]));
        if (e.r) e.r *= k;
        if (e.dimKind === "linear") { e.angle = ang(e.angle || 0); if (Math.cos(e.angle) < -1e-9) e.angle += Math.PI; }
        if (e.dimKind === "angular" && m) [e.p1, e.p2] = [e.p2, e.p1];
      } else ["definitionPoint", "textPoint", "subDefinitionPoint1", "subDefinitionPoint2", "insertionPoint", "centerPoint", "arcPoint"].forEach(c => Pt(e[c]));
      break;
    default: break;
  }
  e._xf = G.mul(Aw, e._xf || G.I);
  return e;
}

// matrice di un inserimento di blocco (coordinate del blocco -> disegno)
function insertMatrix(e, b) {
  const bp = b?.basePoint || { x: 0, y: 0 }, sx = e.xScale || 1, sy = e.yScale || 1, a = e.rotation || 0, ca = Math.cos(a), sa = Math.sin(a);
  const L = [ca * sx, sa * sx, -sa * sy, ca * sy, 0, 0];
  L[4] = e.insertionPoint.x - (L[0] * bp.x + L[2] * bp.y);
  L[5] = e.insertionPoint.y - (L[1] * bp.x + L[3] * bp.y);
  return e.extrusionDirection && e.extrusionDirection.z < -0.5 ? G.mul(MIRX, L) : L;
}

// lati di una polilinea / linea / arco / cerchio come curve analitiche in coordinate del disegno (per taglia, estendi, offset)
function pathOf(e) {
  const W = e.extrusionDirection && e.extrusionDirection.z < -0.5 ? MIRX : G.I;
  if (e.type === "LINE") return { segs: [{ t: "L", x1: e.startPoint.x, y1: e.startPoint.y, x2: e.endPoint.x, y2: e.endPoint.y }], closed: false };
  if (e.type === "ARC" || e.type === "CIRCLE") {
    const full = e.type === "CIRCLE";
    let a0 = full ? 0 : e.startAngle, sw = full ? TAU : G.normA(e.endAngle - e.startAngle) || TAU;
    const [cx, cy] = G.ap(W, e.center.x, e.center.y);
    if (W !== G.I) { a0 = Math.PI - a0; sw = -sw; }
    return { segs: [{ t: "A", cx, cy, r: e.radius, a0, sw }], closed: full, circle: full };
  }
  if (e.type === "LWPOLYLINE" || e.type === "POLYLINE2D") {
    const v = (e.vertices || []).filter(p => !(p.flag & 16)).map(p => ({ x: p.x ?? p.point?.x, y: p.y ?? p.point?.y, b: p.bulge || 0 }));
    const closed = !!(e.flag & 1) || !!e.closed, segs = [];
    const n = closed ? v.length : v.length - 1;
    for (let i = 0; i < n; i++) {
      const a = v[i], b = v[(i + 1) % v.length];
      const [x1, y1] = G.ap(W, a.x, a.y), [x2, y2] = G.ap(W, b.x, b.y), bu = W === G.I ? a.b : -a.b;
      const B = bu ? G.bulgeArc(x1, y1, x2, y2, bu) : null;
      segs.push(B ? { t: "A", ...B } : { t: "L", x1, y1, x2, y2 });
    }
    return { segs, closed };
  }
  return null;
}
const segPoint = (s, u) => (s.t === "L" ? [s.x1 + (s.x2 - s.x1) * u, s.y1 + (s.y2 - s.y1) * u] : G.arcPoint(s, u));
function pathPoint(path, g) { const n = path.segs.length, i = Math.min(n - 1, Math.max(0, Math.floor(g))); return segPoint(path.segs[i], g - i); }
function pathClosest(path, x, y) { let best = null; path.segs.forEach((s, i) => { const c = G.closest(s, x, y); if (!best || c[3] < best[1]) best = [i + c[2], c[3]]; }); return best[0]; }
// tratto del percorso tra i parametri g0 < g1 come entita' (linea, arco o polilinea) con le proprieta' di "src"
function pathPiece(path, g0, g1, src) {
  const n = path.segs.length, base = { ...clone(src) };
  delete base.handle; delete base._xf; delete base.extrusionDirection;
  for (const k of ["startPoint", "endPoint", "center", "radius", "startAngle", "endAngle", "vertices", "flag", "closed"]) delete base[k];
  base._new = true;
  const wrapG = g => (path.closed ? ((g % n) + n) % n : g);
  const pieces = [];
  let g = g0;
  while (g < g1 - 1e-9) {
    const i = Math.floor(wrapG(g) + 1e-9) % n, u0 = wrapG(g) - Math.floor(wrapG(g) + 1e-9);
    const step = Math.min(1 - u0, g1 - g);
    pieces.push({ s: path.segs[i], u0, u1: u0 + step });
    g += step;
    if (pieces.length > 4 * n + 4) break;
  }
  if (!pieces.length) return null;
  if (pieces.length === 1 && src.type !== "LWPOLYLINE" && src.type !== "POLYLINE2D") {
    const { s, u0, u1 } = pieces[0];
    if (s.t === "L") return { ...base, type: "LINE", startPoint: P(segPoint(s, u0)), endPoint: P(segPoint(s, u1)) };
    let a = s.a0 + s.sw * u0, b = s.a0 + s.sw * u1;
    if (s.sw < 0) [a, b] = [b, a];
    return { ...base, type: "ARC", center: { x: s.cx, y: s.cy, z: 0 }, radius: s.r, startAngle: G.normA(a), endAngle: G.normA(b) };
  }
  const verts = [];
  for (const { s, u0, u1 } of pieces) { const [x, y] = segPoint(s, u0); verts.push({ x, y, bulge: s.t === "A" ? G.bulgeOf(s.sw * (u1 - u0)) : 0 }); }
  const last = pieces[pieces.length - 1], [x, y] = segPoint(last.s, last.u1);
  verts.push({ x, y, bulge: 0 });
  return { ...base, type: "LWPOLYLINE", flag: 0, vertices: verts };
}

// ---------------------------------------------------------------- editor
export function createCadEditor(o) {
  const { ctx, db, sourceKind } = o;
  const blocks = new Map((db.tables.BLOCK_RECORD?.entries || []).map(b => [b.name, b]));
  const H = db.header || {};
  const model = () => o.getModel();
  const dpr = () => devicePixelRatio || 1;
  let on = false;
  const sel = new Set(); // chiavi: "12" (entita' di primo livello) o "12|/3/a1" (dentro un blocco)
  let hover = null, cursor = null, cursorPx = null, snapHit = null, box = null, clickBox = null, lastPick = null;
  let ortho = false, osnapOn = true, polarOn = false, gridOn = false, polarHit = null, propsHidden = false;
  let polarInc = 15;
  const modes = { end: true, mid: true, cen: true, int: true, per: true, qua: true, ins: true, nod: true, nea: false };
  const cur = { layer: "0", color: 256, lineType: "ByLayer", lineweight: -1, textH: H.DIMTXT > 0 ? H.DIMTXT * (H.DIMSCALE > 0 ? H.DIMSCALE : 1) : 2.5 };
  const dimStyle = { txt: H.DIMTXT > 0 ? H.DIMTXT : 2.5, asz: H.DIMASZ > 0 ? H.DIMASZ : 2.5, scale: H.DIMSCALE > 0 ? H.DIMSCALE : 1, dec: Number.isFinite(H.DIMDEC) ? H.DIMDEC : 2, adec: 0,
    exo: H.DIMEXO > 0 ? H.DIMEXO : 0.625, exe: H.DIMEXE > 0 ? H.DIMEXE : 1.25, gap: H.DIMGAP > 0 ? H.DIMGAP : 0.625, tick: false, sep: "," };
  {
    const bb = o.getModel().bbox, size = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
    if (size > 0 && dimStyle.txt * dimStyle.scale < size / 400) { // testo quota illeggibile: scala tonda che lo porta a circa 1/120 del disegno
      const want = size / 120 / dimStyle.txt, p = 10 ** Math.floor(Math.log10(want)), m = want / p;
      dimStyle.scale = (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
      cur.textH = dimStyle.txt * dimStyle.scale;
    }
  }
  const mem = { offset: 10, fillet: 0, ch1: 5, ch2: 5, hatch: { name: "ANSI31", scale: 1, angle: 0 }, lastDim: null, lastCmd: null };
  const undo = [], redo = [];
  const newLayers = new Map();

  // ---- riferimenti alle entita' (anche dentro i blocchi)
  const keyOf = (oi, s) => (s ? `${oi}|${s}` : String(oi));
  const parseKey = k => { const i = String(k).indexOf("|"); return i < 0 ? [+k, ""] : [+k.slice(0, i), k.slice(i + 1)]; };
  function locate(key) { // -> [contenitore, indice]
    const [oi, s] = parseKey(key);
    let list = db.entities, idx = oi;
    if (!s) return [list, idx];
    for (const part of s.split("/").filter(Boolean)) {
      const e = list[idx];
      if (!e) return [null, -1];
      if (part[0] === "a") { list = e.attribs || []; idx = +part.slice(1); }
      else { const b = blocks.get(e.name); if (!b) return [null, -1]; list = b.entities || []; idx = +part; }
    }
    return [list, idx];
  }
  const getE = key => { const [l, i] = locate(key); return l ? l[i] : null; };
  const setE = (key, v) => { const [l, i] = locate(key); if (l) l[i] = v; };
  const isTop = key => !String(key).includes("|");
  const topKeys = () => [...sel].filter(isTop);

  // ---- comandi con Annulla / Ripeti: stato prima e dopo delle entita' toccate
  function command(keys, fn) {
    keys = [...new Set(keys.map(String))];
    const before = keys.map(k => [k, clone(getE(k))]);
    const n0 = db.entities.length;
    fn();
    const added = [];
    for (let i = n0; i < db.entities.length; i++) added.push(String(i));
    for (const k of [...keys, ...added]) { const e = getE(k); if (e) e._dirty = true; }
    const after = [...keys, ...added].map(k => [k, clone(getE(k))]);
    undo.push({ before, after, added });
    redo.length = 0;
    changed();
    return added;
  }
  const add = e => { db.entities.push(e); return String(db.entities.length - 1); };
  function apply(states) { for (const [k, s] of states) setE(k, clone(s)); }
  function doUndo() {
    const c = undo.pop();
    if (!c) return toast("Niente da annullare");
    apply(c.before);
    for (const k of c.added) { const e = getE(k); if (e) e._deleted = true; }
    redo.push(c);
    sel.clear();
    changed();
  }
  function doRedo() {
    const c = redo.pop();
    if (!c) return toast("Niente da ripetere");
    apply(c.after);
    undo.push(c);
    changed();
  }
  function changed() { ctx.setDirty(true); o.rebuild(); for (const k of [...sel]) { const e = getE(k); if (!e || e._deleted) sel.delete(k); } renderProps(); }
  const base = () => ({ layer: cur.layer, colorIndex: cur.color, lineType: cur.lineType, lineweight: cur.lineweight, _new: true });

  // ---- ricerca degli oggetti sotto il cursore
  const tolW = (px = 8) => px * dpr() / o.view.s;
  const layerOff = it => model().layers.get(it.l)?.off;
  // candidati vicino al punto, ordinati per distanza: [{key, d}]; sub = seleziona dentro i blocchi
  function candidates(wx, wy, sub = false) {
    const m = model(), tol = tolW(7), best = new Map();
    for (const i of m.query(wx - tol, wy - tol, wx + tol, wy + tol)) {
      const it = m.items[i];
      if (it.t === "N" || layerOff(it)) continue;
      let d;
      if (it.t === "Q") d = G.pointInPoly(wx, wy, it.pts) ? 0 : G.closest(it, wx, wy)[3];
      else if (it.t === "F") d = G.pointInPoly(wx, wy, it.pts) ? tol * 0.8 : G.closest(it, wx, wy)[3]; // le aree piene cedono ai tratti
      else d = G.closest(it, wx, wy)[3];
      if (d > tol) continue;
      const key = keyOf(it.o, sub ? it.s : "");
      if (!best.has(key) || d < best.get(key)) best.set(key, d);
    }
    return [...best].map(([key, d]) => ({ key, d })).sort((a, b) => a.d - b.d);
  }
  const itemsOf = key => {
    const [oi, s] = parseKey(key), m = model();
    return (m.ents[oi] || []).map(i => m.items[i]).filter(it => !s || it.s === s || it.s.startsWith(s + "/"));
  };
  function inRect(x0, y0, x1, y1, crossing) {
    const m = model(), out = [];
    const owners = new Set();
    for (const i of m.query(x0, y0, x1, y1)) { const it = m.items[i]; if (!layerOff(it)) owners.add(it.o); }
    const inside = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
    for (const oi of owners) {
      const its = (m.ents[oi] || []).map(i => m.items[i]).filter(it => !layerOff(it));
      if (!its.length) continue;
      if (!crossing) { if (its.every(it => it.bb && it.bb[0] >= x0 && it.bb[2] <= x1 && it.bb[1] >= y0 && it.bb[3] <= y1)) out.push(String(oi)); continue; }
      const hit = its.some(it => {
        const b = it.bb;
        if (!b || b[0] > x1 || b[2] < x0 || b[1] > y1 || b[3] < y0) return false;
        if (it.t === "N") return inside(it.x, it.y);
        const pts = G.curvePts(it);
        if (pts.some(([x, y]) => inside(x, y))) return true;
        for (let k = 1; k < pts.length; k++) if (segRect(pts[k - 1], pts[k], x0, y0, x1, y1)) return true;
        return (it.t === "F" || it.t === "Q") && !it.hatch && G.pointInPoly((x0 + x1) / 2, (y0 + y1) / 2, it.pts);
      });
      if (hit) out.push(String(oi));
    }
    return out;
  }

  // ---- grip (maniglie) delle entita' selezionate
  function gripsOf(key, e = getE(key)) {
    if (!e || !isTop(key) || e._deleted) return [];
    const W = e.extrusionDirection && e.extrusionDirection.z < -0.5 && ["CIRCLE", "ARC", "LWPOLYLINE", "POLYLINE2D", "TEXT", "INSERT"].includes(e.type) ? MIRX : null;
    const w = p => (W ? [-p.x, p.y] : [p.x, p.y]);
    const setP = (p, q) => { p.x = W ? -q[0] : q[0]; p.y = q[1]; };
    const out = [];
    const g = (pt, fn, kind = "pt") => out.push({ key, x: pt[0], y: pt[1], fn, kind });
    const moveAll = from => q => xform(e, G.trn(q[0] - from[0], q[1] - from[1]), blocks);
    switch (e.type) {
      case "LINE": {
        const a = XY(e.startPoint), b = XY(e.endPoint), mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        g(a, q => setP(e.startPoint, q)); g(b, q => setP(e.endPoint, q)); g(mid, moveAll(mid), "move");
        break;
      }
      case "CIRCLE": {
        const c = w(e.center);
        g(c, moveAll(c), "move");
        for (let k = 0; k < 4; k++) g([c[0] + e.radius * Math.cos(k * Math.PI / 2), c[1] + e.radius * Math.sin(k * Math.PI / 2)], q => { e.radius = Math.max(1e-9, dist(c, q)); });
        break;
      }
      case "ARC": {
        const p = pathOf(e).segs[0], a = G.arcPoint(p, 0), mm = G.arcPoint(p, 0.5), b = G.arcPoint(p, 1), c = [p.cx, p.cy];
        const re = (p1, p2, p3) => { const A = G.arc3(p1, p2, p3); if (!A) return; const t = { type: "ARC", center: P([A.cx, A.cy]), radius: A.r, startAngle: A.sw > 0 ? A.a0 : A.a0 + A.sw, endAngle: A.sw > 0 ? A.a0 + A.sw : A.a0 };
          if (W) xform(t, MIRX); Object.assign(e, { center: t.center, radius: t.radius, startAngle: G.normA(t.startAngle), endAngle: G.normA(t.endAngle) }); };
        g(a, q => re(q, mm, b)); g(b, q => re(a, mm, q)); g(mm, q => re(a, q, b)); g(c, moveAll(c), "move");
        break;
      }
      case "LWPOLYLINE": case "POLYLINE2D": {
        const v = (e.vertices || []).filter(p => !(p.flag & 16));
        v.forEach(p => { const vp = { x: p.x ?? p.point?.x, y: p.y ?? p.point?.y }; g(w(vp), q => { const t = { x: 0, y: 0 }; setP(t, q); p.x = t.x; p.y = t.y; if (p.point) { p.point.x = t.x; p.point.y = t.y; } }); });
        const path = pathOf(e);
        path.segs.forEach((s, i) => {
          const mpt = segPoint(s, 0.5);
          if (s.t === "A") g(mpt, q => { const A = G.arc3(segPoint(s, 0), q, segPoint(s, 1)); if (A) { const vv = v[i]; vv.bulge = (W ? -1 : 1) * G.bulgeOf(A.sw); } }, "arc");
          else g(mpt, q => { const d = [q[0] - mpt[0], q[1] - mpt[1]], a = v[i], b = v[(i + 1) % v.length]; for (const p of [a, b]) { const t = w({ x: p.x, y: p.y }); const n = { x: 0, y: 0 }; setP(n, [t[0] + d[0], t[1] + d[1]]); p.x = n.x; p.y = n.y; } }, "move");
        });
        break;
      }
      case "ELLIPSE": {
        const c = XY(e.center), M = e.majorAxisEndPoint, ma = [c[0] + M.x, c[1] + M.y], L = Math.hypot(M.x, M.y), mi = [c[0] - M.y * e.axisRatio, c[1] + M.x * e.axisRatio];
        g(c, moveAll(c), "move");
        g(ma, q => { const r = e.axisRatio * L; e.majorAxisEndPoint = { x: q[0] - c[0], y: q[1] - c[1], z: 0 }; const nl = dist(c, q); if (nl > 1e-9) e.axisRatio = Math.min(1, r / nl); });
        g(mi, q => { e.axisRatio = Math.max(1e-6, Math.min(1, dist(c, q) / L)); });
        break;
      }
      case "TEXT": case "MTEXT": case "INSERT": case "POINT": {
        const p = e.type === "TEXT" ? ((e.halign || e.valign) && e.endPoint ? e.endPoint : e.startPoint) : e.type === "POINT" ? e.position : e.insertionPoint;
        if (p) { const pp = w(p); g(pp, moveAll(pp), "move"); }
        break;
      }
      case "SPLINE": ((e.fitPoints?.length ? e.fitPoints : e.controlPoints) || []).forEach(p => g(XY(p), q => { p.x = q[0]; p.y = q[1]; if (e.fitPoints?.length && e.controlPoints?.length) { e.controlPoints = []; e.knots = []; } })); break;
      case "SOLID": case "TRACE": case "3DFACE": ["corner1", "corner2", "corner3", "corner4"].forEach(k => e[k] && g(XY(e[k]), q => { e[k].x = q[0]; e[k].y = q[1]; })); break;
      case "DIMENSION":
        if (e.dimKind) for (const k of ["p1", "p2", "loc", "c", "feat", "leader"]) if (e[k] && !(e.dimKind === "radius" || e.dimKind === "diameter") || (k === "loc" && e[k])) g(XY(e[k]), q => { e[k].x = q[0]; e[k].y = q[1]; if (e.dimKind === "ordinate" && k === "leader") e.axis = Math.abs(q[1] - e.feat.y) >= Math.abs(q[0] - e.feat.x) ? "x" : "y"; });
        break;
      default: break;
    }
    out.forEach((gp, i) => { gp.i = i; });
    return out;
  }
  let gripCache = null;
  function grips() {
    if (gripCache) return gripCache;
    const keys = topKeys();
    gripCache = keys.length > 60 ? [] : keys.flatMap(k => gripsOf(k));
    return gripCache;
  }
  function gripAt(px, py) {
    const r = 7 * dpr();
    for (const gp of grips()) { const [sx, sy] = o.toScreen(gp.x, gp.y); if (Math.abs(sx - px) <= r && Math.abs(sy - py) <= r) return gp; }
    return null;
  }

  // ---- motore dei comandi: i comandi sono funzioni asincrone che chiedono punti, valori, oggetti
  let task = null, pending = null, preview = null;
  function setPrompt(text) { promptEl.textContent = text ? text + ":" : "Comando:"; }
  async function run(name, fn) {
    if (task) cancelTask();
    const t = { name };
    task = t;
    hover = null;
    for (const [k, b] of Object.entries(btns)) b.classList.toggle("on", k === name);
    try { await fn(); } catch (err) { if (err !== CANCEL) { console.error(err); toast(err.message || String(err), true, 6000); } }
    finally {
      if (task === t) {
        task = null; pending = null; preview = null; clickBox = null;
        for (const b of Object.values(btns)) b.classList.remove("on");
        setPrompt(""); input.value = "";
        renderProps(); o.draw();
      }
    }
  }
  function cancelTask() { const p = pending; pending = null; task = null; preview = null; if (p) p.reject(CANCEL); }
  function ask(kind, text, opts = {}) {
    return new Promise((resolve, reject) => {
      pending = { kind, resolve, reject, opts, text };
      setPrompt(text);
      preview = opts.preview || opts.xf ? opts : null;
      o.draw();
    });
  }
  const getPoint = (text, opts = {}) => ask("point", text, opts);
  async function needPoint(text, opts = {}) { for (;;) { const r = await getPoint(text, opts); if (Array.isArray(r)) return r; if (r && r.key) return r; if (r === null && opts.none !== undefined) return opts.none; } }
  async function getNumber(text, def, opts = {}) {
    for (;;) {
      const r = await ask("value", def !== undefined ? `${text} <${fmt(def)}>` : text, opts);
      if (r === null && def !== undefined) return def;
      if (r && typeof r.value === "number") return r.value;
      if (r && r.key) return r;
      if (Array.isArray(r) && opts.base) return opts.angle ? Math.atan2(r[1] - opts.base[1], r[0] - opts.base[0]) * R2D : dist(opts.base, r); // valore indicato con un punto
    }
  }
  async function getEntity(text, filter, opts = {}) {
    for (;;) {
      const r = await ask("entity", text, { ...opts, filter });
      if (r === null) return null;
      if (r.key && !r.pick) return r;
      const e = getE(r.pick.key);
      if (!filter || filter(e, r.pick.key)) return { ...r.pick, e };
      toast("Tipo di oggetto non adatto a questo comando", true);
    }
  }
  async function needSelection(text = "Seleziona gli oggetti (Invio per confermare)") {
    if (topKeys().length) return topKeys();
    const r = await ask("select", text);
    const k = topKeys();
    if (!k.length) throw CANCEL;
    return r && k;
  }

  // ---- inserimento da tastiera (riga di comando)
  // punto scritto: "x,y" o "x;y" (con ; i decimali possono avere la virgola), "@dx,dy" relativo, "@d<a" polare relativo, "d<a" polare
  function parsePointInput(s, basePt) {
    s = s.trim().replace(/\s+/g, "");
    const rel = s.startsWith("@");
    if (rel) s = s.slice(1);
    if (s.includes(";")) s = s.replace(/,/g, ".").replace(/;/g, ",");
    const ref = rel ? basePt || [0, 0] : [0, 0];
    let m = s.match(/^(-?\d*\.?\d+)<(-?\d*\.?\d+)$/);
    if (m) { const d = +m[1], a = +m[2] / R2D; return [ref[0] + d * Math.cos(a), ref[1] + d * Math.sin(a)]; }
    m = s.match(/^(-?\d*\.?\d+),(-?\d*\.?\d+)$/);
    if (m) return [ref[0] + +m[1], ref[1] + +m[2]];
    return null;
  }
  function submit(raw) {
    const s = raw.trim();
    input.value = "";
    if (!pending) {
      if (s === "?") { showHelp(); return; }
      if (!s) { if (mem.lastCmd) startCmd(mem.lastCmd); return; }
      const c = ALIAS[s.toUpperCase()];
      if (c) startCmd(c); else toast(`Comando sconosciuto: ${s}. Scrivi ? per l'elenco dei comandi.`, true);
      return;
    }
    const p = pending, opts = p.opts || {};
    const up = s.toUpperCase();
    const done = v => { pending = null; p.resolve(v); };
    if (s && opts.keys && opts.keys[up]) return done({ key: up });
    if (p.kind === "select") {
      if (!s) return done(true);
      if (up === "T" || up === "TUTTO") return selectAll();
      return toast("Seleziona con il mouse, poi Invio", true);
    }
    if (p.kind === "entity") { if (!s) done(null); return; }
    if (!s) return done(null);
    const isNum = /^-?\d*[.,]?\d+$/.test(s);
    if (p.kind === "value") {
      if (isNum) return done({ value: +s.replace(",", ".") });
      const pt = parsePointInput(s, opts.base);
      if (pt) return done(pt);
      return toast("Valore non valido", true);
    }
    if (isNum && !s.includes(",")) {
      const n = +s;
      if (opts.allowValue) return done({ value: n });
      if (opts.base && cursor) { // distanza diretta nella direzione del cursore
        const c = snapHit ? [snapHit.x, snapHit.y] : effectivePoint(cursor), d = dist(opts.base, c);
        if (d > 1e-12) return done([opts.base[0] + (c[0] - opts.base[0]) / d * n, opts.base[1] + (c[1] - opts.base[1]) / d * n]);
      }
    }
    if (isNum && opts.allowValue) return done({ value: +s.replace(",", ".") });
    const pt = parsePointInput(s, opts.base || lastPt);
    if (pt) return done(pt);
    toast("Punto non valido: scrivi x,y oppure @dx,dy oppure @distanza<angolo, o una distanza", true, 5000);
  }
  let lastPt = null;
  const effectivePoint = p => {
    const b = pending?.opts?.base;
    polarHit = null;
    if (!b || snapHit) return p;
    if (ortho) return orthoC(p, b);
    if (polarOn) { // puntamento polare: si aggancia alle direzioni multiple dell'incremento (tolleranza in pixel)
      const d = dist(b, p);
      if (d * o.view.s < 4) return p;
      const a = Math.atan2(p[1] - b[1], p[0] - b[0]), inc = polarInc / R2D, k = Math.round(a / inc), ak = k * inc;
      if (Math.abs(Math.sin(a - ak)) * d * o.view.s < 9 * dpr()) {
        const t = (p[0] - b[0]) * Math.cos(ak) + (p[1] - b[1]) * Math.sin(ak);
        polarHit = { a: ak, d: t };
        return [b[0] + Math.cos(ak) * t, b[1] + Math.sin(ak) * t];
      }
    }
    return p;
  };
  const orthoC = (p, b) => (Math.abs(p[0] - b[0]) >= Math.abs(p[1] - b[1]) ? [p[0], b[1]] : [b[0], p[1]]);

  // ---- comandi
  const CMDS = {};
  const def = (id, label, title, aliases, fn, group) => { CMDS[id] = { id, label, title, fn, group }; for (const a of aliases) ALIAS[a] = id; ALIAS[label.toUpperCase()] = id; };
  const ALIAS = {};
  function startCmd(id, arg) { const c = CMDS[id]; if (!c) return; if (!["undo", "redo", "dimstyle", "select", "zoomext", "selectall", "copyclip", "copybase"].includes(id)) mem.lastCmd = id; run(id, () => c.fn(arg)); }

  // .... disegno
  def("line", "Linea", "Linea (L): clic sui punti, Invio per finire, C chiude, A annulla l'ultimo tratto", ["L", "LINEA", "LINE"], async () => {
    let first = await needPoint("Primo punto"), prev = first;
    const made = [];
    for (;;) {
      lastPt = prev;
      const r = await getPoint(`Punto successivo [${made.length >= 2 ? "Chiudi (C) / " : ""}Annulla (A)] o Invio`, { base: prev, keys: { C: 1, A: 1 }, preview: p => [{ type: "LINE", startPoint: P(prev), endPoint: P(p) }] });
      if (r === null) return;
      if (r.key === "A") { if (made.length) { doUndo(); made.pop(); prev = made.length ? made[made.length - 1] : first; } continue; }
      const q = r.key === "C" ? first : r;
      command([], () => add({ ...base(), type: "LINE", startPoint: P(prev), endPoint: P(q) }));
      if (r.key === "C") return;
      made.push(q); prev = q;
    }
  }, "draw");
  def("pline", "Polilinea", "Polilinea (PL): clic sui punti; A = tratti ad arco, L = tratti dritti, C chiude, Invio finisce", ["PL", "POLILINEA", "PLINE"], async () => {
    const v = [{ x: 0, y: 0, bulge: 0 }];
    const first = await needPoint("Punto iniziale");
    v[0].x = first[0]; v[0].y = first[1];
    let arcMode = false;
    const tangent = () => { // direzione di uscita dall'ultimo vertice
      if (v.length < 2) return null;
      const a = v[v.length - 2], b = v[v.length - 1];
      if (!a.bulge) return Math.atan2(b.y - a.y, b.x - a.x);
      const A = G.bulgeArc(a.x, a.y, b.x, b.y, a.bulge), e = A.a0 + A.sw;
      return e + Math.sign(A.sw) * Math.PI / 2;
    };
    const bulgeTo = p => { const t = tangent() ?? 0, b = v[v.length - 1], ch = Math.atan2(p[1] - b.y, p[0] - b.x); let th = ch - t; th = Math.atan2(Math.sin(th), Math.cos(th)); return Math.tan(th / 2); };
    const temp = (p, close) => {
      const vv = v.map(x => ({ ...x }));
      if (p) { if (arcMode) vv[vv.length - 1].bulge = bulgeTo(p); vv.push({ x: p[0], y: p[1], bulge: 0 }); }
      return [{ type: "LWPOLYLINE", flag: close ? 1 : 0, vertices: vv }];
    };
    for (;;) {
      const b = v[v.length - 1];
      lastPt = [b.x, b.y];
      const r = await getPoint(`Punto successivo [${arcMode ? "Linea (L)" : "Arco (A)"} / Chiudi (C) / Annulla (U)] o Invio`, { base: [b.x, b.y], keys: { A: 1, L: 1, C: 1, U: 1 }, preview: p => temp(p) });
      if (r === null) break;
      if (r.key === "A") { arcMode = true; continue; }
      if (r.key === "L") { arcMode = false; continue; }
      if (r.key === "U") { if (v.length > 1) { v.pop(); v[v.length - 1].bulge = 0; } continue; }
      if (r.key === "C") { if (v.length > 2) { if (arcMode) v[v.length - 1].bulge = bulgeTo([v[0].x, v[0].y]); command([], () => add({ ...base(), type: "LWPOLYLINE", flag: 1, vertices: v })); } return; }
      if (arcMode) b.bulge = bulgeTo(r);
      v.push({ x: r[0], y: r[1], bulge: 0 });
    }
    if (v.length > 1) command([], () => add({ ...base(), type: "LWPOLYLINE", flag: 0, vertices: v }));
  }, "draw");
  def("rect", "Rettangolo", "Rettangolo (REC): due angoli opposti (anche @larghezza,altezza)", ["REC", "RETTANGOLO", "RECTANG"], async () => {
    const a = await needPoint("Primo angolo");
    lastPt = a;
    const rect = (b) => [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]].map(([x, y]) => ({ x, y, bulge: 0 }));
    const b = await needPoint("Angolo opposto (o @larghezza,altezza)", { base: a, preview: p => [{ type: "LWPOLYLINE", flag: 1, vertices: rect(p) }] });
    command([], () => add({ ...base(), type: "LWPOLYLINE", flag: 1, vertices: rect(b) }));
  }, "draw");
  def("circle", "Cerchio", "Cerchio (C): centro e raggio; D = diametro, 3P = per tre punti", ["C", "CERCHIO", "CIRCLE"], async mode => {
    const r0 = mode === "3p" ? { key: "3P" } : await needPoint("Centro [3 punti (3P)]", { keys: { "3P": 1 } });
    if (r0.key === "3P") {
      const a = await needPoint("Primo punto"), b = await needPoint("Secondo punto", { base: a });
      const c = await needPoint("Terzo punto", { base: b, preview: p => { const C = G.circle3(a, b, p); return C ? [{ type: "CIRCLE", center: P([C.cx, C.cy]), radius: C.r }] : []; } });
      const C = G.circle3(a, b, c);
      if (C) command([], () => add({ ...base(), type: "CIRCLE", center: P([C.cx, C.cy]), radius: C.r }));
      return;
    }
    const c = r0;
    lastPt = c;
    let diam = mode === "d";
    for (;;) {
      const r = await getPoint(diam ? "Diametro" : "Raggio [Diametro (D)]", { base: c, keys: { D: 1 }, allowValue: true, preview: p => [{ type: "CIRCLE", center: P(c), radius: Math.max(1e-9, dist(c, p) / (diam ? 2 : 1)) }] });
      if (r === null) return;
      if (r.key === "D") { diam = true; continue; }
      const rad = r.value !== undefined ? r.value / (diam ? 2 : 1) : dist(c, r) / (diam ? 2 : 1);
      if (rad > 0) command([], () => add({ ...base(), type: "CIRCLE", center: P(c), radius: rad }));
      return;
    }
  }, "draw");
  def("arc", "Arco", "Arco (A): inizio, secondo punto, fine; C = centro, inizio, fine", ["A", "ARCO", "ARC"], async mode => {
    const r0 = mode === "cse" ? { key: "C" } : await needPoint("Punto iniziale [Centro (C)]", { keys: { C: 1 } });
    const toEnt = A => ({ type: "ARC", center: P([A.cx, A.cy]), radius: A.r, startAngle: G.normA(A.sw > 0 ? A.a0 : A.a0 + A.sw), endAngle: G.normA(A.sw > 0 ? A.a0 + A.sw : A.a0) });
    if (r0.key === "C") {
      const c = await needPoint("Centro"), s = await needPoint("Punto iniziale", { base: c });
      const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]), r = dist(c, s);
      const mk = p => ({ type: "ARC", center: P(c), radius: r, startAngle: G.normA(a0), endAngle: G.normA(Math.atan2(p[1] - c[1], p[0] - c[0])) });
      const e = await needPoint("Punto finale (verso antiorario)", { base: c, preview: p => [mk(p)] });
      command([], () => add({ ...base(), ...mk(e) }));
      return;
    }
    const a = r0, b = await needPoint("Secondo punto", { base: a });
    const c = await needPoint("Punto finale", { base: b, preview: p => { const A = G.arc3(a, b, p); return A ? [toEnt(A)] : []; } });
    const A = G.arc3(a, b, c);
    if (A) command([], () => add({ ...base(), ...toEnt(A) }));
  }, "draw");
  def("ellipse", "Ellisse", "Ellisse (EL): centro, estremo del primo asse, lunghezza del secondo semiasse", ["EL", "ELLISSE", "ELLIPSE"], async () => {
    const c = await needPoint("Centro"), a = await needPoint("Estremo dell'asse", { base: c, preview: p => [{ type: "LINE", startPoint: P(c), endPoint: P(p) }] });
    const L = dist(c, a);
    if (L < 1e-12) return;
    const mk = r => ({ type: "ELLIPSE", center: P(c), majorAxisEndPoint: { x: a[0] - c[0], y: a[1] - c[1], z: 0 }, axisRatio: Math.max(1e-6, r), startAngle: 0, endAngle: TAU });
    const r = await getNumber("Lunghezza dell'altro semiasse", undefined, { base: c, preview: p => [mk(dist(c, p) / L)] });
    let rr = r / L, ent = mk(rr);
    if (rr > 1) { ent = { ...mk(1 / rr), majorAxisEndPoint: { x: -(a[1] - c[1]) * rr, y: (a[0] - c[0]) * rr, z: 0 } }; }
    command([], () => add({ ...base(), ...ent }));
  }, "draw");
  def("text", "Testo", "Testo su una riga (T): punto, altezza, rotazione, testo", ["T", "TESTO", "DT", "TEXT"], async () => {
    const p = await needPoint("Punto di inserimento");
    lastPt = p;
    const h = await getNumber("Altezza", cur.textH, { base: p });
    cur.textH = h; hInput.value = fmt(h);
    const rr = await getNumber("Rotazione in gradi", 0, { base: p, angle: true });
    const s = await askText("Nuovo testo", "Testo");
    if (s) command([], () => add({ ...base(), type: "TEXT", text: s, startPoint: P(p), endPoint: P(p), textHeight: h, rotation: (typeof rr === "number" ? rr : 0) / R2D, halign: 0, valign: 0 }));
  }, "draw");
  def("mtext", "Testo multiriga", "Testo multiriga (MT): riquadro del testo, poi il testo (a capo con Invio)", ["MT", "TM", "MTEXT", "TESTOM"], async () => {
    const a = await needPoint("Primo angolo del riquadro");
    lastPt = a;
    const b = await needPoint("Angolo opposto", { base: a, preview: p => [{ type: "LWPOLYLINE", flag: 1, vertices: [[a[0], a[1]], [p[0], a[1]], [p[0], p[1]], [a[0], p[1]]].map(([x, y]) => ({ x, y })) }] });
    const ta = el("textarea", { rows: 6, style: { width: "100%", minWidth: "360px", fontFamily: "Arial", fontSize: "14px" } });
    const hh = el("input", { type: "text", class: "field", value: fmt(cur.textH), style: { width: "80px" } });
    setTimeout(() => ta.focus(), 50);
    const ok = await modal("Testo multiriga", el("div", { style: { display: "grid", gap: "8px" } }, el("label", {}, "Altezza ", hh), ta), [{ label: "Annulla", value: null }, { label: "Inserisci", primary: true, value: () => ta.value }]);
    if (!ok) return;
    const h = num(hh.value) || cur.textH;
    cur.textH = h; hInput.value = fmt(h);
    command([], () => add({ ...base(), type: "MTEXT", text: ok.replace(/\r?\n/g, "\\P"), insertionPoint: P([Math.min(a[0], b[0]), Math.max(a[1], b[1])]), textHeight: h, rectWidth: Math.abs(b[0] - a[0]), attachmentPoint: 1, rotation: 0 }));
  }, "draw");
  def("hatch", "Tratteggio", "Tratteggio (H): motivo e scala, poi clic dentro le aree chiuse (Invio per finire)", ["H", "TR", "TRATTEGGIO", "HATCH", "BH", "RETINO"], async () => {
    const hs = mem.hatch;
    const sel1 = el("select", { class: "field" }, ...["SOLID", ...Object.keys(G.PATTERNS)].map(n => el("option", { value: n, selected: n === hs.name || undefined }, G.PATTERN_IT[n] || n)));
    const sc = el("input", { type: "text", class: "field", value: fmt(hs.scale), style: { width: "90px" } }), an = el("input", { type: "text", class: "field", value: fmt(hs.angle), style: { width: "90px" } });
    const ok = await modal("Tratteggio", el("div", { style: { display: "grid", gridTemplateColumns: "auto 1fr", gap: "8px", alignItems: "center" } }, "Motivo", sel1, "Scala", sc, "Angolo (°)", an,
      el("span", { class: "note", style: { gridColumn: "1/3" } }, "Poi fai clic dentro le aree da tratteggiare: il contorno si trova da solo (linee, polilinee, cerchi, archi).")), [{ label: "Annulla", value: null }, { label: "Continua", primary: true, value: true }]);
    if (!ok) return;
    Object.assign(hs, { name: sel1.value, scale: num(sc.value) || 1, angle: num(an.value) || 0 });
    for (;;) {
      const r = await getPoint("Clic dentro un'area chiusa (Invio per finire)", { nosnap: true });
      if (r === null) return;
      const loops = findBoundary(r);
      if (!loops) { toast("Nessun contorno chiuso attorno al punto (ingrandisci la zona o chiudi il contorno)", true, 5000); continue; }
      const solid = hs.name === "SOLID";
      command([], () => add({ ...base(), type: "HATCH", patternName: hs.name, solidFill: solid ? 1 : 0, patternScale: hs.scale, patternAngle: hs.angle / R2D,
        boundaryPaths: loops.map(L => ({ boundaryPathTypeFlag: 2, isClosed: true, vertices: L.map(([x, y]) => ({ x, y, bulge: 0 })) })) }));
    }
  }, "draw");

  // .... quote
  const dimBase = () => ({ ...base(), type: "DIMENSION", style: { ...dimStyle } });
  const dimEntity = (kind, f) => ({ ...dimBase(), dimKind: kind, ...f });
  async function twoPoints(text1 = "Origine della prima linea di estensione (Invio = scegli un oggetto)") {
    const r = await getPoint(text1, { none: null });
    if (r === null) {
      const pk = await getEntity("Seleziona la linea, l'arco o il lato di polilinea da quotare", e => ["LINE", "ARC", "LWPOLYLINE", "POLYLINE2D"].includes(e?.type));
      if (!pk) throw CANCEL;
      const it = pk.item;
      if (it.t === "L") return [[it.x1, it.y1], [it.x2, it.y2]];
      if (it.t === "A") return [G.arcPoint(it, 0), G.arcPoint(it, 1)];
      throw CANCEL;
    }
    lastPt = r;
    const b = await needPoint("Origine della seconda linea di estensione", { base: r });
    return [r, b];
  }
  def("dimlin", "Lineare", "Quota lineare orizzontale/verticale (DLI): due punti, poi la posizione; O/V/R per forzare", ["DLI", "DIMLIN", "DIMLINEAR", "QUOTALIN"], async () => {
    const [a, b] = await twoPoints();
    let force = null, rotA = 0;
    const auto = p => {
      if (force === "O") return 0; if (force === "V") return Math.PI / 2; if (force === "R") return rotA;
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      return Math.abs(p[1] - my) - Math.abs(b[1] - a[1]) / 2 >= Math.abs(p[0] - mx) - Math.abs(b[0] - a[0]) / 2 ? 0 : Math.PI / 2;
    };
    const mk = p => dimEntity("linear", { p1: P(a), p2: P(b), loc: P(p), angle: auto(p) });
    for (;;) {
      const r = await getPoint("Posizione della linea di quota [Orizzontale (O) / Verticale (V) / Ruotata (R) / Testo (T)]", { base: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], keys: { O: 1, V: 1, R: 1, T: 1 }, preview: p => [mk(p)], nosnapDefault: true });
      if (r === null) return;
      if (r.key === "R") { const v = await getNumber("Angolo della linea di quota (°)", 0); rotA = (typeof v === "number" ? v : 0) / R2D; force = "R"; continue; }
      if (r.key === "T") { mem.dimText = await askText("Testo della quota", "Testo (<> = misura)", "<>"); continue; }
      if (r.key) { force = r.key; continue; }
      const e = mk(r);
      if (mem.dimText) { e.text = mem.dimText; mem.dimText = null; }
      command([], () => add(e));
      mem.lastDim = e;
      return;
    }
  }, "dim");
  def("dimali", "Allineata", "Quota allineata (DAL): due punti, poi la posizione", ["DAL", "DIMALI", "DIMALIGNED", "QUOTALL"], async () => {
    const [a, b] = await twoPoints();
    const mk = p => dimEntity("aligned", { p1: P(a), p2: P(b), loc: P(p) });
    const r = await needPoint("Posizione della linea di quota", { base: b, preview: p => [mk(p)] });
    const e = mk(r);
    command([], () => add(e));
    mem.lastDim = e;
  }, "dim");
  def("dimang", "Angolare", "Quota angolare (DAN): due linee (o un arco); Invio = vertice e due punti", ["DAN", "DIMANG", "DIMANGULAR", "QUOTANG"], async () => {
    let c, p1, p2;
    const pk = await getEntity("Seleziona la prima linea o un arco (Invio = specifica il vertice)", e => ["LINE", "ARC", "LWPOLYLINE", "POLYLINE2D", "CIRCLE"].includes(e?.type));
    if (!pk) {
      c = await needPoint("Vertice dell'angolo");
      p1 = await needPoint("Punto sul primo lato", { base: c });
      p2 = await needPoint("Punto sul secondo lato", { base: c });
    } else if (pk.item.t === "A") {
      const it = pk.item;
      c = [it.cx, it.cy]; p1 = G.arcPoint(it, it.sw > 0 ? 0 : 1); p2 = G.arcPoint(it, it.sw > 0 ? 1 : 0);
    } else {
      const pk2 = await getEntity("Seleziona la seconda linea", e => ["LINE", "LWPOLYLINE", "POLYLINE2D"].includes(e?.type));
      if (!pk2 || pk2.item.t !== "L") throw CANCEL;
      const X = G.intersect(pk.item, pk2.item, true, true)[0];
      if (!X) { toast("Le linee sono parallele", true); return; }
      c = [X.x, X.y];
      const side = (it, q) => { const a = [it.x1, it.y1], b = [it.x2, it.y2]; const far = dist(a, c) > dist(b, c) ? a : b; const d = [far[0] - c[0], far[1] - c[1]]; return (q[0] - c[0]) * d[0] + (q[1] - c[1]) * d[1] >= 0 ? far : [2 * c[0] - far[0], 2 * c[1] - far[1]]; };
      p1 = side(pk.item, pk.pt); p2 = side(pk2.item, pk2.pt);
    }
    const mk = p => dimEntity("angular", { c: P(c), p1: P(p1), p2: P(p2), loc: P(p) });
    const r = await needPoint("Posizione dell'arco di quota", { base: c, preview: p => [mk(p)] });
    command([], () => add(mk(r)));
  }, "dim");
  const radial = kind => async () => {
    const pk = await getEntity("Seleziona l'arco o il cerchio", e => ["ARC", "CIRCLE", "LWPOLYLINE", "POLYLINE2D"].includes(e?.type));
    if (!pk) return;
    if (pk.item.t !== "A") { toast("Seleziona un arco o un cerchio (o un lato ad arco di polilinea)", true); return; }
    const it = pk.item, c = [it.cx, it.cy];
    const mk = p => dimEntity(kind, { c: P(c), r: it.r, loc: P(p) });
    const r = await needPoint("Posizione della quota", { base: c, preview: p => [mk(p)] });
    command([], () => add(mk(r)));
  };
  def("dimrad", "Raggio", "Quota raggio (DRA): seleziona arco o cerchio, poi la posizione", ["DRA", "DIMRAD", "DIMRADIUS", "QUOTARAG"], radial("radius"), "dim");
  def("dimdia", "Diametro", "Quota diametro (DDI): seleziona arco o cerchio, poi la posizione", ["DDI", "DIMDIA", "DIMDIAMETER", "QUOTADIA"], radial("diameter"), "dim");
  def("dimord", "Coordinata", "Quota coordinata (DOR): punto, poi estremo della direttrice; X/Y per forzare", ["DOR", "DIMORD", "DIMORDINATE", "QUOTACOO"], async () => {
    let force = null;
    for (;;) {
      const f = await getPoint("Punto da quotare (Invio per finire)");
      if (f === null) return;
      const mk = p => dimEntity("ordinate", { feat: P(f), leader: P(p), origin: { x: 0, y: 0, z: 0 }, axis: force || (Math.abs(p[1] - f[1]) >= Math.abs(p[0] - f[0]) ? "x" : "y") });
      for (;;) {
        const r = await getPoint("Estremo della direttrice [Coordinata X (X) / Coordinata Y (Y)]", { base: f, keys: { X: 1, Y: 1 }, preview: p => [mk(p)] });
        if (r === null) return;
        if (r.key) { force = r.key.toLowerCase(); continue; }
        command([], () => add(mk(r)));
        break;
      }
    }
  }, "dim");
  def("dimcont", "Continua", "Quota continua (DCO): prosegue dall'ultima quota lineare o allineata", ["DCO", "DIMCONT", "DIMCONTINUE", "QUOTACON"], async () => chainDim(false), "dim");
  def("dimbase", "Linea di base", "Quote da linea di base (DBA): partono tutte dal primo punto dell'ultima quota", ["DBA", "DIMBASE", "DIMBASELINE"], async () => chainDim(true), "dim");
  async function chainDim(baseline) {
    let last = mem.lastDim;
    if (!last || !(last.dimKind === "linear" || last.dimKind === "aligned")) {
      const pk = await getEntity("Seleziona una quota lineare o allineata da cui continuare", e => e?.type === "DIMENSION" && (e.dimKind === "linear" || e.dimKind === "aligned"));
      if (!pk) return;
      last = pk.e;
    }
    const step = (dimStyle.txt * 1.6 + dimStyle.gap * 2) * dimStyle.scale;
    for (;;) {
      const from = baseline ? last.p1 : last.p2;
      const mk = p => {
        const e = clone(last);
        delete e.handle; delete e._dirty; delete e._xf; e._new = true; e.text = undefined;
        e.p1 = P(XY(from)); e.p2 = P(p);
        if (baseline) {
          const u = e.dimKind === "linear" ? [Math.cos(e.angle || 0), Math.sin(e.angle || 0)] : [(last.p2.x - last.p1.x), (last.p2.y - last.p1.y)];
          const L = Math.hypot(u[0], u[1]) || 1, n = [-u[1] / L, u[0] / L];
          const sgn = ((last.loc.x - last.p1.x) * n[0] + (last.loc.y - last.p1.y) * n[1]) >= 0 ? 1 : -1;
          e.loc = P([last.loc.x + n[0] * step * sgn, last.loc.y + n[1] * step * sgn]);
        } else if (e.dimKind === "aligned") {
          const u = [last.p2.x - last.p1.x, last.p2.y - last.p1.y], L = Math.hypot(u[0], u[1]) || 1, n = [-u[1] / L, u[0] / L];
          const off = (last.loc.x - last.p1.x) * n[0] + (last.loc.y - last.p1.y) * n[1];
          e.loc = P([p[0] + n[0] * off, p[1] + n[1] * off]);
        }
        return e;
      };
      const r = await getPoint("Origine della linea di estensione successiva (Invio per finire)", { base: XY(from), preview: p => [mk(p)] });
      if (r === null) return;
      const e = mk(r);
      command([], () => add(e));
      last = mem.lastDim = e;
    }
  }
  def("dimstyle", "Stile quota", "Stile delle quote nuove: altezza testo, frecce, scala, decimali", ["DST", "DIMSTYLE", "STILEQUOTA", "D"], async () => {
    const f = {};
    const row = (k, label, v) => { f[k] = el("input", { type: "text", class: "field", value: fmt(v), style: { width: "100px" } }); return [el("span", {}, label), f[k]]; };
    const arr = el("select", { class: "field" }, el("option", { value: "0", selected: !dimStyle.tick || undefined }, "Frecce piene"), el("option", { value: "1", selected: dimStyle.tick || undefined }, "Tratto obliquo (architettonico)"));
    const sep = el("select", { class: "field" }, el("option", { value: ",", selected: dimStyle.sep === "," || undefined }, "Virgola (12,5)"), el("option", { value: ".", selected: dimStyle.sep === "." || undefined }, "Punto (12.5)"));
    const ok = await modal("Stile quota", el("div", { style: { display: "grid", gridTemplateColumns: "auto auto", gap: "8px 12px", alignItems: "center" } },
      ...row("scale", "Scala globale", dimStyle.scale), ...row("txt", "Altezza testo", dimStyle.txt), ...row("asz", "Dimensione frecce", dimStyle.asz),
      ...row("dec", "Decimali", dimStyle.dec), ...row("adec", "Decimali angoli", dimStyle.adec), ...row("exo", "Distanza dall'oggetto", dimStyle.exo),
      ...row("exe", "Prolungamento oltre la quota", dimStyle.exe), ...row("gap", "Distanza del testo", dimStyle.gap), el("span", {}, "Terminatori"), arr, el("span", {}, "Separatore decimale"), sep,
      el("span", { class: "note", style: { gridColumn: "1/3" } }, "Le misure si moltiplicano per la scala globale (come DIMSCALE in AutoCAD). Valgono per le quote nuove e per quelle selezionate.")),
    [{ label: "Annulla", value: null }, { label: "Applica", primary: true, value: true }]);
    if (!ok) return;
    for (const k of Object.keys(f)) { const n = num(f[k].value); if (n !== null && n >= 0) dimStyle[k] = k === "dec" || k === "adec" ? Math.round(n) : n; }
    dimStyle.tick = arr.value === "1"; dimStyle.sep = sep.value;
    const keys = topKeys().filter(k => getE(k)?.dimKind);
    if (keys.length) command(keys, () => keys.forEach(k => { getE(k).style = { ...dimStyle }; }));
  }, "dim");

  // .... misure
  def("dist", "Distanza", "Misura la distanza tra due punti (DI)", ["DI", "DIST", "DISTANZA"], async () => {
    const a = await needPoint("Primo punto"), b = await needPoint("Secondo punto", { base: a, preview: p => [{ type: "LINE", startPoint: P(a), endPoint: P(p) }] });
    const d = dist(a, b), dx = b[0] - a[0], dy = b[1] - a[1];
    const msg = `Distanza ${fmt(d)} · ΔX ${fmt(dx)} · ΔY ${fmt(dy)} · angolo ${fmt(Math.atan2(dy, dx) * R2D)}°`;
    ctx.status(msg); toast(msg, false, 8000);
  }, "measure");
  def("area", "Area", "Misura area e perimetro (AREA): clic sui vertici e Invio, oppure O per un oggetto chiuso", ["AA", "AREA"], async () => {
    const pts = [];
    const r0 = await getPoint("Primo vertice [Oggetto (O)]", { keys: { O: 1 } });
    if (r0 === null) return;
    let poly;
    if (r0.key === "O") {
      const pk = await getEntity("Seleziona un oggetto chiuso (cerchio, polilinea chiusa, ellisse, tratteggio)");
      if (!pk) return;
      const its = itemsOf(pk.key);
      if (its.length === 1 && its[0].t === "A" && Math.abs(its[0].sw) >= TAU - 1e-9) { const r = its[0].r; const msg = `Area ${fmt(Math.PI * r * r)} · Circonferenza ${fmt(TAU * r)}`; ctx.status(msg); toast(msg, false, 8000); return; }
      poly = its.flatMap(it => (it.t === "N" || it.t === "Q" ? [] : G.curvePts(it)));
    } else {
      pts.push(r0);
      for (;;) {
        lastPt = pts[pts.length - 1];
        const r = await getPoint("Vertice successivo (Invio per calcolare)", { base: lastPt, preview: p => [{ type: "LWPOLYLINE", flag: 1, vertices: [...pts, p].map(([x, y]) => ({ x, y })) }] });
        if (r === null) break;
        pts.push(r);
        preview = { preview: () => [{ type: "LWPOLYLINE", flag: 1, vertices: pts.map(([x, y]) => ({ x, y })) }] };
      }
      poly = pts;
    }
    if (!poly || poly.length < 3) return;
    let per = 0;
    for (let k = 0; k < poly.length; k++) per += dist(poly[k], poly[(k + 1) % poly.length]);
    const msg = `Area ${fmt(Math.abs(G.polyArea(poly)))} · Perimetro ${fmt(per)}`;
    ctx.status(msg); toast(msg, false, 8000);
  }, "measure");

  // .... modifica
  const xfPreview = A => ({ xf: A });
  def("move", "Sposta", "Sposta (M): punto base e punto di arrivo", ["M", "SPOSTA", "MOVE", "S"], async () => {
    const keys = await needSelection();
    const a = await needPoint("Punto base");
    lastPt = a;
    const b = await needPoint("Secondo punto", { base: a, xf: p => G.trn(p[0] - a[0], p[1] - a[1]) });
    command(keys, () => keys.forEach(k => xform(getE(k), G.trn(b[0] - a[0], b[1] - a[1]), blocks)));
  }, "modify");
  def("copy", "Copia", "Copia (CO): punto base, poi i punti di arrivo (Invio per finire)", ["CO", "CP", "COPIA", "COPY"], async () => {
    const keys = await needSelection();
    const a = await needPoint("Punto base");
    for (;;) {
      lastPt = a;
      const b = await getPoint("Secondo punto (Invio per finire)", { base: a, xf: p => G.trn(p[0] - a[0], p[1] - a[1]) });
      if (b === null) return;
      copyWith(keys, G.trn(b[0] - a[0], b[1] - a[1]));
    }
  }, "modify");
  function copyOf(e, A) { const c = clone(e); delete c.handle; delete c._dirty; c._new = true; if (c.type === "DIMENSION" && !c.dimKind) c.type = "_skip"; return xform(c, A, blocks); }
  function copyWith(keys, ...mats) { command([], () => { for (const A of mats) keys.forEach(k => { const c = copyOf(getE(k), A); if (c.type !== "_skip") add(c); }); }); }
  def("rotate", "Ruota", "Ruota (RO): centro, poi angolo (scritto o con un punto); C = ruota una copia", ["RO", "RUOTA", "ROTATE"], async () => {
    const keys = await needSelection();
    const c = await needPoint("Centro di rotazione");
    lastPt = c;
    let copy = false;
    for (;;) {
      const r = await getPoint("Angolo di rotazione in gradi [Copia (C)]", { base: c, allowValue: true, keys: { C: 1 }, xf: p => G.rot(Math.atan2(p[1] - c[1], p[0] - c[0]), c[0], c[1]) });
      if (r === null) return;
      if (r.key === "C") { copy = true; toast("Verra' ruotata una copia"); continue; }
      const a = r.value !== undefined ? r.value / R2D : Math.atan2(r[1] - c[1], r[0] - c[0]);
      const A = G.rot(a, c[0], c[1]);
      if (copy) copyWith(keys, A); else command(keys, () => keys.forEach(k => xform(getE(k), A, blocks)));
      return;
    }
  }, "modify");
  def("scale", "Scala", "Scala (SC): punto base, fattore (o R = riferimento: lunghezza attuale e nuova)", ["SC", "SCALA", "SCALE"], async () => {
    const keys = await needSelection();
    const c = await needPoint("Punto base");
    lastPt = c;
    let k;
    const r = await getPoint("Fattore di scala [Riferimento (R)]", { base: c, allowValue: true, keys: { R: 1 }, xf: p => G.scl(Math.max(1e-6, dist(c, p)), c[0], c[1]) });
    if (r === null) return;
    if (r.key === "R") { const L1 = await getNumber("Lunghezza di riferimento", 1, { base: c }); const L2 = await getNumber("Nuova lunghezza", L1, { base: c }); k = L2 / L1; }
    else k = r.value !== undefined ? r.value : dist(c, r);
    if (!(k > 0) || k === 1) return;
    command(keys, () => keys.forEach(kk => xform(getE(kk), G.scl(k, c[0], c[1]), blocks)));
  }, "modify");
  def("mirror", "Specchio", "Specchio (MI): due punti dell'asse; poi scegli se tenere gli originali", ["MI", "SPECCHIO", "MIRROR"], async () => {
    const keys = await needSelection();
    const a = await needPoint("Primo punto dell'asse");
    lastPt = a;
    const b = await needPoint("Secondo punto dell'asse", { base: a, xf: p => (dist(a, p) > 1e-9 ? G.mirror(a[0], a[1], p[0], p[1]) : G.I) });
    if (dist(a, b) < 1e-12) return;
    const A = G.mirror(a[0], a[1], b[0], b[1]);
    const r = await getPoint("Cancellare gli oggetti originali? [Si (S) / No (N)] <No>", { keys: { S: 1, N: 1, SI: 1 } });
    if (r?.key === "S" || r?.key === "SI") command(keys, () => keys.forEach(k => xform(getE(k), A, blocks)));
    else copyWith(keys, A);
  }, "modify");
  def("array", "Serie", "Serie (AR): copie in righe e colonne o attorno a un centro", ["AR", "SERIE", "ARRAY"], async mode => {
    const keys = await needSelection();
    const f = {};
    const inp = (k, v) => (f[k] = el("input", { type: "text", class: "field", value: fmt(v), style: { width: "90px" } }));
    const kind = el("select", { class: "field" }, el("option", { value: "r" }, "Rettangolare"), el("option", { value: "p", selected: mode === "p" || undefined }, "Polare (attorno a un centro)"));
    const rot2 = el("input", { type: "checkbox", checked: true });
    const ok = await modal("Serie", el("div", { style: { display: "grid", gridTemplateColumns: "auto auto", gap: "8px 12px", alignItems: "center" } },
      "Tipo", kind, "Righe", inp("rows", 2), "Colonne", inp("cols", 3), "Distanza tra le righe", inp("dy", mem.ady || 10), "Distanza tra le colonne", inp("dx", mem.adx || 10),
      "Numero di elementi (polare)", inp("n", 6), "Angolo da riempire (°)", inp("ang", 360), "Ruota gli elementi (polare)", rot2), [{ label: "Annulla", value: null }, { label: "Continua", primary: true, value: true }]);
    if (!ok) return;
    const v = k => num(f[k].value) ?? 0;
    if (kind.value === "r") {
      const rows = Math.max(1, Math.round(v("rows"))), cols = Math.max(1, Math.round(v("cols"))), dx = v("dx"), dy = v("dy");
      mem.adx = dx; mem.ady = dy;
      const mats = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (r || c) mats.push(G.trn(c * dx, r * dy));
      if (mats.length) copyWith(keys, ...mats);
    } else {
      const c = await needPoint("Centro della serie");
      const n = Math.max(2, Math.round(v("n"))), tot = v("ang") / R2D, step = Math.abs(Math.abs(tot) - TAU) < 1e-9 ? tot / n : tot / (n - 1);
      const mats = [];
      const bb = selBox(keys), mid = [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
      for (let k = 1; k < n; k++) {
        if (rot2.checked) mats.push(G.rot(step * k, c[0], c[1]));
        else { const q = G.ap(G.rot(step * k, c[0], c[1]), mid[0], mid[1]); mats.push(G.trn(q[0] - mid[0], q[1] - mid[1])); }
      }
      copyWith(keys, ...mats);
    }
  }, "modify");
  def("offset", "Offset", "Offset (O): distanza, poi oggetto e lato (Invio per finire)", ["O", "OFFSET", "EQ"], async () => {
    const d = await getNumber("Distanza di offset", mem.offset);
    if (!(d > 0)) return;
    mem.offset = d;
    for (;;) {
      const pk = await getEntity("Seleziona l'oggetto (Invio per finire)", (e, k) => isTop(k) && ["LINE", "CIRCLE", "ARC", "LWPOLYLINE", "POLYLINE2D"].includes(e?.type));
      if (!pk) return;
      sel.clear(); sel.add(pk.key); o.draw();
      const side = await needPoint("Punto dal lato dell'offset", { nosnap: true, preview: p => { const r = offsetEnt(pk.e, d, p); return r ? [r] : []; } });
      const r = offsetEnt(pk.e, d, side);
      sel.clear();
      if (r) command([], () => add(r)); else toast("Offset impossibile a questa distanza", true);
    }
  }, "modify");
  def("trim", "Taglia", "Taglia (TR): clic sulle parti da togliere; i bordi sono tutti gli oggetti visibili", ["TR", "TAGLIA", "TRIM"], async () => {
    for (;;) {
      const pk = await getEntity("Clic sulla parte da tagliare (Invio per finire)", (e, k) => isTop(k) && ["LINE", "CIRCLE", "ARC", "LWPOLYLINE", "POLYLINE2D"].includes(e?.type));
      if (!pk) return;
      if (!trimAt(pk.key, pk.pt)) toast("Nessun bordo di taglio incrocia l'oggetto", true);
    }
  }, "modify");
  def("extend", "Estendi", "Estendi (EX): clic vicino all'estremo da allungare fino al primo oggetto", ["EX", "ESTENDI", "EXTEND"], async () => {
    for (;;) {
      const pk = await getEntity("Clic vicino all'estremo da estendere (Invio per finire)", (e, k) => isTop(k) && ["LINE", "ARC", "LWPOLYLINE", "POLYLINE2D"].includes(e?.type));
      if (!pk) return;
      if (!extendAt(pk.key, pk.pt)) toast("Nessun oggetto da raggiungere in quella direzione", true);
    }
  }, "modify");
  def("fillet", "Raccordo", "Raccordo (F): due linee; R = raggio (0 = spigolo vivo)", ["F", "RACCORDO", "FILLET"], async () => {
    for (;;) {
      const p1 = await getEntity(`Prima linea [Raggio (R) = ${fmt(mem.fillet)}]`, (e, k) => isTop(k) && e?.type === "LINE", { keys: { R: 1 } });
      if (!p1) return;
      if (p1.key === "R") { const r = await getNumber("Raggio di raccordo", mem.fillet); if (r >= 0) mem.fillet = r; continue; }
      sel.clear(); sel.add(p1.key); o.draw();
      const p2 = await getEntity("Seconda linea", (e, k) => isTop(k) && e?.type === "LINE" && k !== p1.key);
      sel.clear();
      if (!p2) return;
      if (!cornerLines(p1, p2, "fillet")) toast("Raccordo impossibile (linee parallele o raggio troppo grande)", true);
      return;
    }
  }, "modify");
  def("chamfer", "Cimatura", "Cimatura (CHA): due linee; D = distanze", ["CHA", "CIMA", "CIMATURA", "CHAMFER"], async () => {
    for (;;) {
      const p1 = await getEntity(`Prima linea [Distanze (D) = ${fmt(mem.ch1)} / ${fmt(mem.ch2)}]`, (e, k) => isTop(k) && e?.type === "LINE", { keys: { D: 1 } });
      if (!p1) return;
      if (p1.key === "D") { mem.ch1 = await getNumber("Prima distanza", mem.ch1); mem.ch2 = await getNumber("Seconda distanza", mem.ch1); continue; }
      sel.clear(); sel.add(p1.key); o.draw();
      const p2 = await getEntity("Seconda linea", (e, k) => isTop(k) && e?.type === "LINE" && k !== p1.key);
      sel.clear();
      if (!p2) return;
      if (!cornerLines(p1, p2, "chamfer")) toast("Cimatura impossibile (linee parallele o distanze troppo grandi)", true);
      return;
    }
  }, "modify");
  def("explode", "Esplodi", "Esplodi (X): blocchi, polilinee e quote diventano oggetti semplici", ["X", "ESPLODI", "EXPLODE"], async () => {
    const keys = await needSelection();
    let n = 0;
    command(keys, () => keys.forEach(k => { const parts = explode(getE(k)); if (parts) { getE(k)._deleted = true; parts.forEach(p => add(p)); n++; } }));
    sel.clear(); renderProps();
    toast(n ? `${n} oggetti esplosi` : "Niente da esplodere (seleziona blocchi, polilinee o quote)", !n);
  }, "modify");
  def("stretch", "Stira", "Stira (ST): finestra d'intersezione attorno ai vertici da spostare, poi punto base e secondo punto", ["ST", "STIRA", "STRETCH"], async () => {
    const a = await needPoint("Primo angolo della finestra d'intersezione", { nosnap: true });
    const rectEnt = q => ({ type: "LWPOLYLINE", flag: 1, vertices: [[a[0], a[1]], [q[0], a[1]], [q[0], q[1]], [a[0], q[1]]].map(([x, y]) => ({ x, y })) });
    const b = await needPoint("Angolo opposto", { nosnap: true, preview: q => [rectEnt(q)] });
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    const ins = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
    const keys = inRect(x0, y0, x1, y1, true);
    if (!keys.length) { toast("Nessun oggetto nella finestra", true); return; }
    sel.clear(); keys.forEach(k => sel.add(k)); gripCache = null; o.draw();
    const p1 = await needPoint("Punto base");
    lastPt = p1;
    const whole = new Map(keys.map(k => [k, itemsOf(k).every(it => it.bb && it.bb[0] >= x0 && it.bb[2] <= x1 && it.bb[1] >= y0 && it.bb[3] <= y1)]));
    const apply = (k, e, dx, dy) => stretchEnt(e, dx, dy, ins, whole.get(k));
    const p2 = await needPoint("Secondo punto", { base: p1, preview: q => keys.map(k => apply(k, clone(getE(k)), q[0] - p1[0], q[1] - p1[1])) });
    command(keys, () => keys.forEach(k => apply(k, getE(k), p2[0] - p1[0], p2[1] - p1[1])));
    sel.clear();
  }, "modify");
  // stira: si spostano i vertici dentro la finestra; gli oggetti senza vertici si spostano se il loro punto di riferimento e' dentro
  function stretchEnt(e, dx, dy, ins, whole) {
    if (whole) return xform(e, G.trn(dx, dy), blocks);
    const W = e.extrusionDirection && e.extrusionDirection.z < -0.5;
    const mv = p => { if (p && typeof p.x === "number" && ins(W ? -p.x : p.x, p.y)) { p.x += W ? -dx : dx; p.y += dy; } };
    switch (e.type) {
      case "LINE": mv(e.startPoint); mv(e.endPoint); break;
      case "LWPOLYLINE": case "POLYLINE2D": (e.vertices || []).forEach(v => { if (v.point) { const on = ins(W ? -v.point.x : v.point.x, v.point.y); mv(v.point); if (on) { v.x = v.point.x; v.y = v.point.y; } } else mv(v); }); break;
      case "SOLID": case "TRACE": case "3DFACE": ["corner1", "corner2", "corner3", "corner4"].forEach(k => mv(e[k])); break;
      case "DIMENSION": if (e.dimKind) { ["p1", "p2", "loc", "c", "feat", "leader"].forEach(k => mv(e[k])); break; } // continua
      // falls through
      default: {
        const r = e.center || e.insertionPoint || e.position || ((e.halign || e.valign) && e.endPoint ? e.endPoint : e.startPoint) || e.definitionPoint;
        if (r && ins(W ? -r.x : r.x, r.y)) xform(e, G.trn(dx, dy), blocks);
      }
    }
    return e;
  }
  def("matchprop", "Copia proprietà", "Copia proprietà (MA): oggetto di origine, poi gli oggetti di destinazione (layer, colore, tipo linea, spessore, altezza testo, stile quota)", ["MA", "COPIAPROP", "MATCHPROP", "PAINTER"], async () => {
    const src = await getEntity("Seleziona l'oggetto di origine");
    if (!src) return;
    const e0 = clone(src.e);
    const isTxt = e => ["TEXT", "MTEXT", "ATTRIB"].includes(e?.type);
    for (;;) {
      const t = await getEntity("Seleziona gli oggetti di destinazione (Invio per finire)");
      if (!t) return;
      command([t.key], () => {
        const x = getE(t.key);
        x.layer = e0.layer; x.lineType = e0.lineType; x.lineweight = e0.lineweight; x.lineTypeScale = e0.lineTypeScale;
        if (e0.colorIndex === undefined && typeof e0.color === "number") { x.color = e0.color; x.colorIndex = undefined; } else { x.colorIndex = e0.colorIndex ?? 256; delete x.color; }
        if (isTxt(e0) && isTxt(x)) x.textHeight = e0.textHeight;
        if (e0.dimKind && x.dimKind) x.style = clone(e0.style);
      });
    }
  }, "modify");
  async function copyToClip(withBase) {
    const keys = await needSelection();
    let bp;
    if (withBase) bp = await needPoint("Punto base");
    else { const bb = selBox(keys); bp = [bb[0], bb[1]]; }
    CLIP = { base: bp, ents: keys.map(k => clone(getE(k))).filter(e => !(e.type === "DIMENSION" && !e.dimKind)), blocks: Object.fromEntries([...blocks].map(([n, b]) => [n, true])) };
    toast(`${CLIP.ents.length} oggetti copiati negli appunti${withBase ? " con punto base" : ""}`);
  }
  def("copyclip", "Copia negli appunti", "Copia negli appunti (Ctrl+C); con punto base: Ctrl+Maiusc+C", ["COPYCLIP"], async () => copyToClip(false), "clip");
  def("copybase", "Copia con punto base", "Copia negli appunti con punto base (Ctrl+Maiusc+C)", ["COPYBASE"], async () => copyToClip(true), "clip");
  def("paste", "Incolla", "Incolla dagli appunti (Ctrl+V): punto di inserimento", ["PASTECLIP", "INCOLLA"], async () => {
    if (!CLIP?.ents.length) { toast("Gli appunti sono vuoti: seleziona e premi Ctrl+C", true); return; }
    const ok = CLIP.ents.filter(e => e.type !== "INSERT" || blocks.has(e.name));
    const skipped = CLIP.ents.length - ok.length;
    const at = q => ok.map(e => { const c = clone(e); delete c.handle; delete c._dirty; c._new = true; return xform(c, G.trn(q[0] - CLIP.base[0], q[1] - CLIP.base[1]), blocks); });
    const q = await needPoint("Punto di inserimento", { base: CLIP.base, preview: at });
    command([], () => at(q).forEach(e => add(e)));
    if (skipped) toast(`${skipped} blocchi non incollati: la loro definizione non esiste in questo disegno`, true, 6000);
  }, "clip");
  def("zoomext", "Estensioni", "Zoom estensioni (Z E): mostra tutto il disegno", ["ZE", "ZOOMEST", "ZOOMEXT"], async () => o.zoomTo(model().bbox), "view");
  def("zoomwin", "Finestra", "Zoom finestra (Z F): due angoli della zona da ingrandire", ["ZW", "ZF", "ZOOMFIN", "ZOOM"], async () => {
    const a = await needPoint("Primo angolo", { nosnap: true });
    const b = await needPoint("Angolo opposto", { nosnap: true, preview: q => [{ type: "LWPOLYLINE", flag: 1, vertices: [[a[0], a[1]], [q[0], a[1]], [q[0], q[1]], [a[0], q[1]]].map(([x, y]) => ({ x, y })) }] });
    if (dist(a, b) > 0) o.zoomTo([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]);
  }, "view");
  def("layercur", "Corrente da oggetto", "Rendi corrente il layer di un oggetto (LAYMCUR)", ["LAYMCUR", "LAYCUR"], async () => {
    const t = await getEntity("Seleziona l'oggetto del layer da rendere corrente");
    if (!t) return;
    cur.layer = t.e.layer || "0"; fillLayers(); toast(`Layer corrente: ${cur.layer}`);
  }, "layer");
  def("layernew", "Nuovo layer", "Crea un nuovo layer e lo rende corrente", ["LAYNEW", "NUOVOLAYER"], async () => {
    const n = await askText("Nuovo layer", "Nome del layer");
    if (n) { newLayers.set(n, { name: n, aci: 7 }); cur.layer = n; ctx.setDirty(true); fillLayers(); }
  }, "layer");
  def("selectall", "Seleziona tutto", "Seleziona tutti gli oggetti visibili (Ctrl+A)", ["TUTTO", "SELALL"], async () => selectAll(), "util");
  def("props", "Proprietà", "Mostra o nasconde la tavolozza Proprietà (Ctrl+1)", ["PR", "PROPRIETA", "PROPERTIES"], async () => { propsHidden = !propsHidden; renderProps(); }, "util");
  def("erase", "Elimina", "Elimina (E o Canc)", ["E", "CANCELLA", "ELIMINA", "ERASE"], async () => { const keys = await needSelection(); removeKeys(keys); }, "modify");
  def("undo", "Annulla", "Annulla (Ctrl+Z)", ["U", "ANNULLA", "UNDO"], async () => doUndo(), "edit");
  def("redo", "Ripeti", "Ripeti (Ctrl+Y)", ["RIPETI", "REDO"], async () => doRedo(), "edit");
  def("select", "Seleziona", "Seleziona: clic, finestra (da sinistra) o intersezione (da destra); Maiusc toglie; Ctrl = dentro i blocchi", ["SEL", "SELECT"], async () => { cancelTask(); }, "edit");

  function removeKeys(keys) {
    const top = keys.filter(isTop), nested = keys.filter(k => !isTop(k));
    if (!keys.length) return;
    command(keys, () => keys.forEach(k => { getE(k)._deleted = true; }));
    if (nested.length) toast(`${nested.length} elementi tolti dalla definizione del blocco (tutte le copie)`);
    sel.clear(); renderProps(); o.draw();
    return top;
  }
  function selectAll() { model().ents.forEach((its, i) => { if (its && !db.entities[i]?._deleted && its.some(k => !layerOff(model().items[k]))) sel.add(String(i)); }); gripCache = null; renderProps(); o.draw(); }
  function selBox(keys) {
    let bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const k of keys) for (const it of itemsOf(k)) if (it.bb) bb = [Math.min(bb[0], it.bb[0]), Math.min(bb[1], it.bb[1]), Math.max(bb[2], it.bb[2]), Math.max(bb[3], it.bb[3])];
    return bb;
  }

  // ---- offset, taglia, estendi, raccordo, esplodi
  function offsetEnt(e, d, side) {
    const out = clone(e);
    delete out.handle; delete out._dirty; delete out._xf; out._new = true;
    const path = pathOf(e);
    if (!path) return null;
    if (e.type === "LINE") {
      const s = path.segs[0], L = Math.hypot(s.x2 - s.x1, s.y2 - s.y1); if (!L) return null;
      const n = [-(s.y2 - s.y1) / L, (s.x2 - s.x1) / L], k = ((side[0] - s.x1) * n[0] + (side[1] - s.y1) * n[1]) >= 0 ? d : -d;
      out.startPoint = P([s.x1 + n[0] * k, s.y1 + n[1] * k]); out.endPoint = P([s.x2 + n[0] * k, s.y2 + n[1] * k]);
      return out;
    }
    if (e.type === "CIRCLE" || e.type === "ARC") {
      const s = path.segs[0], inside = Math.hypot(side[0] - s.cx, side[1] - s.cy) < s.r;
      const r = inside ? s.r - d : s.r + d;
      if (r <= 1e-9) return null;
      out.radius = r;
      return out;
    }
    // polilinea: ogni lato si sposta dal lato del punto; i lati dritti consecutivi si raccordano nel loro incrocio
    const ci = Math.min(path.segs.length - 1, Math.floor(pathClosest(path, side[0], side[1])));
    const s0 = path.segs[ci], c0 = G.closest(s0, side[0], side[1]);
    let tx, ty;
    if (s0.t === "L") { tx = s0.x2 - s0.x1; ty = s0.y2 - s0.y1; } else { const a = s0.a0 + s0.sw * c0[2]; tx = -Math.sin(a) * Math.sign(s0.sw); ty = Math.cos(a) * Math.sign(s0.sw); }
    const sgn = tx * (side[1] - c0[1]) - ty * (side[0] - c0[0]) >= 0 ? 1 : -1; // +1 = a sinistra del verso di percorrenza
    const segs = path.segs.map(s => {
      if (s.t === "L") { const L = Math.hypot(s.x2 - s.x1, s.y2 - s.y1) || 1, n = [-(s.y2 - s.y1) / L * d * sgn, (s.x2 - s.x1) / L * d * sgn]; return { t: "L", x1: s.x1 + n[0], y1: s.y1 + n[1], x2: s.x2 + n[0], y2: s.y2 + n[1] }; }
      const r = s.r - sgn * d * Math.sign(s.sw);
      return r > 1e-9 ? { ...s, r } : null;
    });
    if (segs.some(s => !s)) return null;
    const verts = [];
    const n = segs.length;
    for (let i = 0; i < n; i++) {
      const s = segs[i], prev = i > 0 ? segs[i - 1] : path.closed ? segs[n - 1] : null;
      let start = segPoint(s, 0);
      if (prev) {
        const pe = segPoint(prev, 1);
        if (prev.t === "L" && s.t === "L") { const X = G.intersect(prev, s, true, true)[0]; if (X) start = [X.x, X.y]; }
        else if (dist(pe, start) > 1e-9) verts.push({ x: pe[0], y: pe[1], bulge: 0 });
      }
      verts.push({ x: start[0], y: start[1], bulge: s.t === "A" ? G.bulgeOf(s.sw) : 0, _seg: s });
    }
    // gli archi hanno bisogno del bulge ricalcolato sugli estremi effettivi
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i], s = v._seg; delete v._seg;
      if (s && s.t === "A") { const nx = verts[(i + 1) % verts.length], e1 = [nx.x, nx.y]; if (!path.closed && i === verts.length - 1) continue; const a1 = Math.atan2(v.y - s.cy, v.x - s.cx), a2 = Math.atan2(e1[1] - s.cy, e1[0] - s.cx); let sw = a2 - a1; if (s.sw > 0) { while (sw <= 0) sw += TAU; } else { while (sw >= 0) sw -= TAU; } v.bulge = G.bulgeOf(sw); }
    }
    if (!path.closed) { const last = segs[n - 1], pe = segPoint(last, 1); verts.push({ x: pe[0], y: pe[1], bulge: 0 }); }
    const W = e.extrusionDirection && e.extrusionDirection.z < -0.5;
    if (W) verts.forEach(v => { v.x = -v.x; v.bulge = -v.bulge; });
    out.type = "LWPOLYLINE"; out.vertices = verts; out.flag = path.closed ? 1 : 0;
    return out;
  }
  // tutti i parametri dove gli altri oggetti visibili tagliano il percorso dell'entita' "key"
  function cuts(key, path, ext = false) {
    const m = model(), [oi] = parseKey(key), out = [];
    let bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const s of path.segs) for (const [x, y] of G.curvePts(s)) bb = [Math.min(bb[0], x), Math.min(bb[1], y), Math.max(bb[2], x), Math.max(bb[3], y)];
    const ids = ext ? m.items.map((_, i) => i) : m.query(...bb);
    path.segs.forEach((s, i) => {
      for (const id of ids) {
        const it = m.items[id];
        if (it.o === oi || it.t === "N" || it.t === "Q" || it.hatch || layerOff(it)) continue;
        for (const r of G.intersect(s, it, ext, false)) out.push({ g: i + r.u1, x: r.x, y: r.y });
      }
    });
    return out;
  }
  function trimAt(key, pt) {
    const e = getE(key), path = pathOf(e);
    if (!path) return false;
    const n = path.segs.length, gc = pathClosest(path, pt[0], pt[1]);
    const gs = [...new Set(cuts(key, path).map(c => +c.g.toFixed(9)))].filter(g => g > 1e-7 && g < n - 1e-7 || path.closed).sort((a, b) => a - b);
    if (!gs.length || (path.closed && gs.length < 2)) return false;
    let pieces;
    if (!path.closed) {
      const ga = Math.max(0, ...gs.filter(g => g < gc)), gb = Math.min(n, ...gs.filter(g => g > gc));
      pieces = [];
      if (ga > 1e-7) pieces.push([0, ga]);
      if (gb < n - 1e-7) pieces.push([gb, n]);
    } else {
      const below = gs.filter(g => g < gc), above = gs.filter(g => g > gc);
      const ga = below.length ? below[below.length - 1] : gs[gs.length - 1] - n, gb = above.length ? above[0] : gs[0] + n;
      pieces = [[gb, ga + n]];
    }
    const parts = pieces.map(([a, b]) => pathPiece(path, a, b, e)).filter(Boolean);
    command([key], () => {
      const keep = parts.find(p => p.type === e.type && !path.circle);
      if (keep) {
        const t = getE(key);
        Object.assign(t, keep, { handle: t.handle, _new: t._new, extrusionDirection: undefined });
        if (!e._new) t._new = false;
        parts.filter(p => p !== keep).forEach(p => add(p));
      } else { getE(key)._deleted = true; parts.forEach(p => add(p)); }
    });
    return true;
  }
  function extendAt(key, pt) {
    const e = getE(key), path = pathOf(e);
    if (!path || path.closed) return false;
    const n = path.segs.length;
    const atEnd = pathClosest(path, pt[0], pt[1]) > n / 2;
    const seg = atEnd ? path.segs[n - 1] : path.segs[0];
    const hits = cuts(key, { segs: [seg] }, true).map(c => c.g);
    let g = null;
    if (seg.t === "L") {
      if (atEnd) { const c = hits.filter(h => h > 1 + 1e-9); if (c.length) g = Math.min(...c); }
      else { const c = hits.filter(h => h < -1e-9); if (c.length) g = Math.max(...c); }
    } else { // l'arco prosegue sul suo cerchio: parametri 0..F sul giro intero
      const F = TAU / Math.abs(seg.sw), c = hits.filter(h => h > 1 + 1e-9 && h < F - 1e-9);
      if (c.length) g = atEnd ? Math.min(...c) : -(F - Math.max(...c));
    }
    if (g === null) return false;
    const np = seg.t === "L" ? segPoint(seg, g) : G.arcPoint(seg, g);
    const W = e.extrusionDirection && e.extrusionDirection.z < -0.5;
    command([key], () => {
      const t = getE(key);
      if (t.type === "LINE") { if (atEnd) t.endPoint = P(np); else t.startPoint = P(np); }
      else if (t.type === "ARC") {
        const s = path.segs[0], a = Math.atan2(np[1] - s.cy, np[0] - s.cx);
        const loc = G.normA(W ? Math.PI - a : a);
        if (atEnd) t.endAngle = loc; else t.startAngle = loc;
      } else {
        const v = t.vertices.filter(p => !(p.flag & 16)), q = W ? -np[0] : np[0];
        const tv = atEnd ? v[v.length - 1] : v[0];
        tv.x = q; tv.y = np[1]; if (tv.point) { tv.point.x = q; tv.point.y = np[1]; }
        if (seg.t === "A") { const vi = atEnd ? v[v.length - 2] : v[0]; const sw = seg.sw * (atEnd ? g : 1 - g); vi.bulge = (W ? -1 : 1) * G.bulgeOf(sw); }
      }
    });
    return true;
  }
  function cornerLines(p1, p2, mode) {
    const L1 = pathOf(p1.e).segs[0], L2 = pathOf(p2.e).segs[0];
    const X = G.intersect(L1, L2, true, true)[0];
    if (!X) return false;
    const x = [X.x, X.y];
    const keepEnd = (L, click) => {
      const a = [L.x1, L.y1], b = [L.x2, L.y2], dir = [b[0] - a[0], b[1] - a[1]];
      const side = (click[0] - x[0]) * dir[0] + (click[1] - x[1]) * dir[1];
      const ta = (a[0] - x[0]) * dir[0] + (a[1] - x[1]) * dir[1], tb = (b[0] - x[0]) * dir[0] + (b[1] - x[1]) * dir[1];
      const cand = [[a, ta, "startPoint"], [b, tb, "endPoint"]].filter(([, t]) => Math.sign(t) === Math.sign(side) && Math.abs(t) > 1e-12);
      cand.sort((u, v) => Math.abs(v[1]) - Math.abs(u[1]));
      return cand[0] ? { far: cand[0][0], keepKey: cand[0][2], other: cand[0][2] === "startPoint" ? "endPoint" : "startPoint" } : null;
    };
    const k1 = keepEnd(L1, p1.pt), k2 = keepEnd(L2, p2.pt);
    if (!k1 || !k2) return false;
    const u1 = [(k1.far[0] - x[0]) / dist(x, k1.far), (k1.far[1] - x[1]) / dist(x, k1.far)], u2 = [(k2.far[0] - x[0]) / dist(x, k2.far), (k2.far[1] - x[1]) / dist(x, k2.far)];
    const th = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
    if (th < 1e-9 || Math.abs(th - Math.PI) < 1e-9) return false;
    let t1, t2, extra = null;
    if (mode === "fillet") {
      const r = mem.fillet, t = r ? r / Math.tan(th / 2) : 0;
      if (t > dist(x, k1.far) || t > dist(x, k2.far)) return false;
      t1 = [x[0] + u1[0] * t, x[1] + u1[1] * t]; t2 = [x[0] + u2[0] * t, x[1] + u2[1] * t];
      if (r) {
        const bis = [u1[0] + u2[0], u1[1] + u2[1]], bl = Math.hypot(bis[0], bis[1]), h = r / Math.sin(th / 2);
        const c = [x[0] + bis[0] / bl * h, x[1] + bis[1] / bl * h];
        let a1 = Math.atan2(t1[1] - c[1], t1[0] - c[0]), a2 = Math.atan2(t2[1] - c[1], t2[0] - c[0]);
        if (G.normA(a2 - a1) > Math.PI) [a1, a2] = [a2, a1];
        extra = { ...clone(p1.e), type: "ARC", center: P(c), radius: r, startAngle: G.normA(a1), endAngle: G.normA(a2) };
        for (const k of ["startPoint", "endPoint", "handle", "_xf", "_dirty"]) delete extra[k];
        extra._new = true;
      }
    } else {
      if (mem.ch1 > dist(x, k1.far) || mem.ch2 > dist(x, k2.far)) return false;
      t1 = [x[0] + u1[0] * mem.ch1, x[1] + u1[1] * mem.ch1]; t2 = [x[0] + u2[0] * mem.ch2, x[1] + u2[1] * mem.ch2];
      if (mem.ch1 || mem.ch2) { extra = { ...clone(p1.e), startPoint: P(t1), endPoint: P(t2) }; delete extra.handle; delete extra._xf; delete extra._dirty; extra._new = true; }
    }
    command([p1.key, p2.key], () => {
      const e1 = getE(p1.key), e2 = getE(p2.key);
      e1[k1.keepKey] = P(k1.far); e1[k1.other] = P(t1);
      e2[k2.keepKey] = P(k2.far); e2[k2.other] = P(t2);
      if (extra) add(extra);
    });
    return true;
  }
  function explode(e) {
    const strip = c => { delete c.handle; delete c._dirty; delete c._xf; delete c._attr; c._new = true; return c; };
    if (e.type === "INSERT") {
      const b = blocks.get(e.name);
      if (!b) return null;
      const A = insertMatrix(e, b), out = [];
      for (const be of b.entities || []) {
        if (be.type === "ATTDEF" || be._deleted) continue;
        const c = strip(clone(be));
        if (c.layer === "0") c.layer = e.layer;
        if ((c.colorIndex ?? 256) === 0) { c.colorIndex = e.colorIndex; if (e.color !== undefined) c.color = e.color; }
        if (c.type === "DIMENSION" && !c.dimKind) continue;
        out.push(xform(c, A, blocks));
      }
      for (const a of e.attribs || []) { if (a.isVisible === false) continue; const c = strip(clone(a)); c.type = "TEXT"; out.push(c); }
      return out;
    }
    if (e.type === "LWPOLYLINE" || e.type === "POLYLINE2D") {
      const path = pathOf(e);
      return path.segs.map((s, i) => pathPiece({ segs: [s], closed: false }, 0, 1, { ...e, type: "LINE" }));
    }
    if (e.type === "DIMENSION") {
      if (e.dimKind) {
        const Gd = G.dimGeom(e), out = [], props = { layer: e.layer, colorIndex: e.colorIndex, _new: true };
        for (const L of Gd.lines) for (let k = 1; k < L.length; k++) out.push({ ...props, type: "LINE", startPoint: P(L[k - 1]), endPoint: P(L[k]) });
        for (const F of Gd.fills) out.push({ ...props, type: "SOLID", corner1: P(F[0]), corner2: P(F[1]), corner3: P(F[2]), corner4: P(F[2]) });
        if (Gd.text) out.push({ ...props, ...G.dimTextEntity(Gd.text) });
        return out;
      }
      const b = blocks.get(e.name);
      if (!b) return null;
      return (b.entities || []).filter(be => !be._deleted).map(be => { const c = strip(clone(be)); if (c.layer === "0") c.layer = e.layer; return e._xf ? xform(c, e._xf, blocks) : c; });
    }
    return null;
  }

  // ---- contorno per il tratteggio: facce della rete di tratti attorno al punto
  function findBoundary(pt) {
    const m = model();
    const [vx0, vy0] = o.toWorld(0, o.canvasSize().h), [vx1, vy1] = o.toWorld(o.canvasSize().w, 0);
    const segs = [];
    for (const i of m.query(vx0, vy0, vx1, vy1)) {
      const it = m.items[i];
      if (it.t === "N" || it.t === "Q" || it.hatch || layerOff(it)) continue;
      const pts = G.curvePts(it);
      for (let k = 1; k < pts.length; k++) if (dist(pts[k - 1], pts[k]) > 1e-12) segs.push([pts[k - 1], pts[k]]);
      if (segs.length > 6000) { toast("Troppi oggetti visibili: ingrandisci la zona da tratteggiare", true); return null; }
    }
    // spezza i tratti negli incroci
    const L = segs.map(([a, b]) => ({ t: "L", x1: a[0], y1: a[1], x2: b[0], y2: b[1], us: [0, 1], bb: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] }));
    const order = L.map((_, i) => i).sort((a, b) => L[a].bb[0] - L[b].bb[0]);
    for (let ii = 0; ii < order.length; ii++) {
      const A = L[order[ii]];
      for (let jj = ii + 1; jj < order.length; jj++) {
        const B = L[order[jj]];
        if (B.bb[0] > A.bb[2] + 1e-9) break;
        if (B.bb[1] > A.bb[3] + 1e-9 || B.bb[3] < A.bb[1] - 1e-9) continue;
        for (const r of G.intersect(A, B)) { A.us.push(r.u1); B.us.push(r.u2); }
      }
    }
    const eps = Math.max(vx1 - vx0, vy1 - vy0) * 1e-7;
    const vid = new Map(), V = [], adj = [];
    const vkey = (x, y) => { const k = Math.round(x / eps) + "," + Math.round(y / eps); let id = vid.get(k); if (id === undefined) { id = V.length; vid.set(k, id); V.push([x, y]); adj.push(new Set()); } return id; };
    for (const s of L) {
      const us = [...new Set(s.us.map(u => Math.max(0, Math.min(1, u))))].sort((a, b) => a - b);
      for (let k = 1; k < us.length; k++) {
        const a = vkey(s.x1 + (s.x2 - s.x1) * us[k - 1], s.y1 + (s.y2 - s.y1) * us[k - 1]), b = vkey(s.x1 + (s.x2 - s.x1) * us[k], s.y1 + (s.y2 - s.y1) * us[k]);
        if (a !== b) { adj[a].add(b); adj[b].add(a); }
      }
    }
    // elimina le estremita' libere
    const deg = adj.map(s => s.size), stack = [];
    deg.forEach((d, i) => { if (d === 1) stack.push(i); });
    while (stack.length) { const v = stack.pop(); for (const w of adj[v]) { adj[w].delete(v); if (adj[w].size === 1) stack.push(w); } adj[v].clear(); }
    // percorso delle facce: arrivando in v da u si prende il lato successivo in senso orario
    const sorted = adj.map((s, v) => [...s].sort((a, b) => Math.atan2(V[a][1] - V[v][1], V[a][0] - V[v][0]) - Math.atan2(V[b][1] - V[v][1], V[b][0] - V[v][0])));
    const used = new Set(), faces = [];
    for (let u = 0; u < V.length; u++) for (const v of sorted[u]) {
      if (used.has(u + ">" + v)) continue;
      const face = [];
      let a = u, b = v, guard = 0;
      while (!used.has(a + ">" + b) && guard++ < 200000) {
        used.add(a + ">" + b);
        face.push(V[a]);
        const nb = sorted[b], i = nb.indexOf(a), c = nb[(i - 1 + nb.length) % nb.length];
        a = b; b = c;
      }
      if (face.length > 2) faces.push(face);
    }
    const inside = faces.filter(f => G.polyArea(f) > 0 && G.pointInPoly(pt[0], pt[1], f)).sort((a, b) => G.polyArea(a) - G.polyArea(b));
    if (!inside.length) return null;
    const outer = inside[0], oa = G.polyArea(outer);
    // isole: facce interne al contorno che non contengono il punto
    const islands = faces.filter(f => { const a = G.polyArea(f); return a > 0 && a < oa && f !== outer && !G.pointInPoly(pt[0], pt[1], f) && f.every(p => G.pointInPoly(p[0], p[1], outer) || outer.some(q => dist(p, q) < eps * 10)); });
    const top = islands.filter(f => !islands.some(g => g !== f && G.polyArea(g) > G.polyArea(f) && f.every(p => G.pointInPoly(p[0], p[1], g))));
    return [outer, ...top];
  }

  // ---- disegno sopra la vista: evidenziazione, selezione, grip, anteprima, aggancio
  function strokeItems(g2, its, A = null) {
    for (const it of its) {
      if (it.t === "N") continue;
      let pts = G.curvePts(it);
      if (A) pts = pts.map(([x, y]) => G.ap(A, x, y));
      g2.beginPath();
      pts.forEach(([x, y], k) => { const [sx, sy] = o.toScreen(x, y); k ? g2.lineTo(sx, sy) : g2.moveTo(sx, sy); });
      g2.stroke();
    }
  }
  function overlay(g2) {
    if (!on) return;
    const d = dpr();
    g2.save();
    g2.lineJoin = "round";
    if (gridOn) { // griglia a punti: passo potenza di 10 (o 5x) che resta leggibile a questa scala
      let step = 10 ** Math.ceil(Math.log10(14 * d / o.view.s));
      if (step * o.view.s / 2 >= 14 * d) step /= 2;
      const { w, h } = o.canvasSize(), [wx0, wy0] = o.toWorld(0, h), [wx1, wy1] = o.toWorld(w, 0);
      g2.fillStyle = "rgba(150,160,175,.45)";
      for (let x = Math.ceil(wx0 / step) * step; x <= wx1; x += step) for (let y = Math.ceil(wy0 / step) * step; y <= wy1; y += step) {
        const [sx, sy] = o.toScreen(x, y), major = Math.abs(Math.round(x / step) % 5) === 0 && Math.abs(Math.round(y / step) % 5) === 0;
        g2.fillRect(sx - (major ? 1.2 : 0.6) * d, sy - (major ? 1.2 : 0.6) * d, (major ? 2.4 : 1.2) * d, (major ? 2.4 : 1.2) * d);
      }
    }
    if (hover && !sel.has(hover)) { g2.strokeStyle = "rgba(120,190,255,.95)"; g2.lineWidth = 3 * d; g2.setLineDash([]); strokeItems(g2, itemsOf(hover)); }
    g2.lineWidth = 2 * d;
    for (const k of sel) {
      const its = itemsOf(k);
      g2.setLineDash([]); g2.strokeStyle = "rgba(43,127,255,.45)"; g2.lineWidth = 5 * d; strokeItems(g2, its);
      g2.setLineDash([6 * d, 4 * d]); g2.strokeStyle = "#cfe3ff"; g2.lineWidth = 1.5 * d; strokeItems(g2, its);
    }
    g2.setLineDash([]);
    if (!pending || pending.kind === "select") {
      for (const gp of grips()) {
        const [sx, sy] = o.toScreen(gp.x, gp.y), r = 4.5 * d, hot = hotGrip && hotGrip.x === gp.x && hotGrip.y === gp.y;
        g2.fillStyle = hot ? "#ff3b30" : gp.kind === "move" ? "#2b7fff" : gp.kind === "arc" ? "#20a0ff" : "#2b7fff";
        g2.strokeStyle = "#0b2a5a"; g2.lineWidth = 1 * d;
        g2.fillRect(sx - r, sy - r, 2 * r, 2 * r); g2.strokeRect(sx - r, sy - r, 2 * r, 2 * r);
      }
    }
    // anteprima del comando
    const cp = cursor ? effectivePoint(snapHit ? [snapHit.x, snapHit.y] : cursor) : null;
    if (preview && cp) {
      g2.strokeStyle = "#7fd3ff"; g2.lineWidth = 1.5 * d; g2.setLineDash([]);
      if (preview.xf) { const A = preview.xf(cp); strokeItems(g2, topKeys().flatMap(itemsOf), A); }
      if (preview.preview) {
        const ents = preview.preview(cp) || [];
        if (ents.length) {
          const tm = o.temp(ents.map(e => ({ layer: cur.layer, colorIndex: 7, ...e })));
          strokeItems(g2, tm.items);
          g2.fillStyle = "#7fd3ff";
          for (const t of tm.texts) { g2.save(); const [a, b, c, dd, e, f] = t.A, s = o.view.s; g2.setTransform(a * s, -b * s, c * s, -dd * s, o.view.tx + e * s, o.view.ty - f * s); const k = t.F / 100; g2.scale(k, -k); g2.font = "100px Arial, sans-serif"; for (const r of t.rows) g2.fillText(r.s, r.x / k, -r.y / k); g2.restore(); }
        }
      }
    }
    const base = pending?.opts?.base;
    if (base && cp && polarHit) { // traccia del puntamento polare
      const [ax, ay] = o.toScreen(...base), L = 4000 * d;
      g2.strokeStyle = "rgba(61,220,132,.8)"; g2.setLineDash([2 * d, 4 * d]); g2.lineWidth = 1 * d;
      g2.beginPath(); g2.moveTo(ax, ay); g2.lineTo(ax + Math.cos(polarHit.a) * L, ay - Math.sin(polarHit.a) * L); g2.stroke(); g2.setLineDash([]);
    }
    if (base && cp && pending.kind !== "entity") {
      const [ax, ay] = o.toScreen(...base), [bx, by] = o.toScreen(...cp);
      g2.strokeStyle = "rgba(255,255,255,.55)"; g2.setLineDash([4 * d, 4 * d]); g2.lineWidth = 1 * d;
      g2.beginPath(); g2.moveTo(ax, ay); g2.lineTo(bx, by); g2.stroke(); g2.setLineDash([]);
      const L = dist(base, cp), an = Math.atan2(cp[1] - base[1], cp[0] - base[0]) * R2D;
      const label = `${polarHit ? "Polare: " : ""}${fmt(+L.toFixed(4))}  <  ${fmt(+((an + 360) % 360).toFixed(2))}°`;
      g2.font = `${12 * d}px Segoe UI, sans-serif`;
      const w = g2.measureText(label).width + 10 * d;
      g2.fillStyle = "rgba(20,24,30,.85)"; g2.fillRect(bx + 14 * d, by - 30 * d, w, 18 * d);
      g2.fillStyle = "#e8f1ff"; g2.fillText(label, bx + 19 * d, by - 17 * d);
    }
    const bxr = box || clickBox && cursorPx && { x0: clickBox.px, y0: clickBox.py, x1: cursorPx[0], y1: cursorPx[1] };
    if (bxr) {
      const crossing = bxr.x1 < bxr.x0;
      g2.setLineDash(crossing ? [5 * d, 3 * d] : []);
      g2.strokeStyle = crossing ? "#3ddc84" : "#4da3ff";
      g2.fillStyle = crossing ? "rgba(61,220,132,.12)" : "rgba(77,163,255,.12)";
      g2.lineWidth = 1 * d;
      const x = Math.min(bxr.x0, bxr.x1), y = Math.min(bxr.y0, bxr.y1), w = Math.abs(bxr.x1 - bxr.x0), h = Math.abs(bxr.y1 - bxr.y0);
      g2.fillRect(x, y, w, h); g2.strokeRect(x, y, w, h);
    }
    if (pending && pending.kind !== "select" && cp) {
      const [sx, sy] = o.toScreen(...cp);
      if (snapHit) G.drawSnapMarker(g2, sx, sy, snapHit.k, d);
      else { g2.strokeStyle = "#ffd400"; g2.lineWidth = 1 * d; g2.setLineDash([]); g2.beginPath(); g2.moveTo(sx - 7 * d, sy); g2.lineTo(sx + 7 * d, sy); g2.moveTo(sx, sy - 7 * d); g2.lineTo(sx, sy + 7 * d); g2.stroke(); }
    }
    g2.restore();
  }

  // ---- eventi del mouse (la vista li passa qui quando l'editor e' attivo)
  let down = null, hotGrip = null;
  function updateCursor(px, py) {
    cursorPx = [px, py];
    const w = o.toWorld(px, py);
    cursor = w;
    snapHit = null;
    const wantsPoint = pending && (pending.kind === "point" || pending.kind === "value");
    if (wantsPoint && osnapOn && !pending.opts?.nosnap) {
      const editing = hotGrip?.key;
      snapHit = G.osnap(model(), w[0], w[1], tolW(10), modes, pending.opts?.base || null, it => layerOff(it) || (editing !== undefined && String(it.o) === editing && !it.s));
    }
    const cp = snapHit ? [snapHit.x, snapHit.y] : effectivePoint(w);
    ctx.status(`X ${fmt(+cp[0].toFixed(4))}  Y ${fmt(+cp[1].toFixed(4))}${ortho ? " · ORTO" : ""}${osnapOn ? " · SNAP" : ""}`);
    coordEl.textContent = `${fmt(+cp[0].toFixed(3))} ; ${fmt(+cp[1].toFixed(3))}`;
  }
  function pointerDown(e, px, py) {
    if (!on) return false;
    updateCursor(px, py);
    down = { px, py, shift: e.shiftKey, ctrl: e.ctrlKey, grip: null };
    if ((!pending || pending.kind === "select") && !clickBox) {
      const gp = gripAt(px, py);
      if (gp) { down.grip = gp; startGrip(gp); }
    }
    return true;
  }
  function pointerMove(e, px, py) {
    if (!on) return false;
    updateCursor(px, py);
    if (down && !down.grip && (!pending || pending.kind === "select") && Math.hypot(px - down.px, py - down.py) > 6 * dpr()) box = { x0: down.px, y0: down.py, x1: px, y1: py };
    if (!down && (!pending || pending.kind === "select" || pending.kind === "entity")) {
      let c = candidates(cursor[0], cursor[1], e.ctrlKey && pending?.kind !== "entity");
      if (pending?.kind === "entity" && pending.opts?.filter) c = c.filter(x => pending.opts.filter(getE(x.key), x.key));
      hover = c.length ? c[0].key : null;
      hotGrip = !pending || pending.kind === "select" ? gripAt(px, py) : hotGrip;
    }
    o.draw();
    return true;
  }
  function pointerLeave() { cursor = null; cursorPx = null; hover = null; snapHit = null; if (on) o.draw(); }
  function boxSelect(x0, y0, x1, y1, remove) {
    const [a, b] = [o.toWorld(Math.min(x0, x1), Math.max(y0, y1)), o.toWorld(Math.max(x0, x1), Math.min(y0, y1))];
    const found = inRect(a[0], a[1], b[0], b[1], x1 < x0);
    for (const k of found) { if (remove) sel.delete(k); else sel.add(k); }
    gripCache = null;
    renderProps();
  }
  function pointerUp(e, px, py) {
    if (!on || !down) return false;
    const d0 = down;
    down = null;
    updateCursor(px, py);
    if (d0.grip) {
      if (Math.hypot(px - d0.px, py - d0.py) > 5 * dpr() && pending?.kind === "point") submitPoint(); // trascinamento del grip: rilascio = punto
      o.draw();
      return true;
    }
    if (box) { const b = box; box = null; boxSelect(b.x0, b.y0, b.x1, b.y1, e.shiftKey); o.draw(); return true; }
    if (clickBox) { const b = clickBox; clickBox = null; boxSelect(b.px, b.py, px, py, b.shift); o.draw(); return true; }
    if (pending && (pending.kind === "point" || pending.kind === "value")) { submitPoint(); o.draw(); return true; }
    const sub = e.ctrlKey && pending?.kind !== "entity";
    const c = candidates(cursor[0], cursor[1], sub);
    if (pending?.kind === "entity") {
      const f = pending.opts?.filter, ok = c.filter(x => !f || f(getE(x.key), x.key));
      if (c.length && !ok.length) toast("Tipo di oggetto non adatto a questo comando", true);
      if (ok.length) {
        const k = ok[0].key, its = itemsOf(k);
        let bi = null, bd = Infinity;
        for (const it of its) { if (it.t === "N") continue; const r = G.closest(it, cursor[0], cursor[1]); if (r[3] < bd) { bd = r[3]; bi = it; } }
        const p = pending; pending = null;
        p.resolve({ pick: { key: k, item: bi, pt: cursor } });
      }
      o.draw();
      return true;
    }
    // selezione: clic ripetuto nello stesso punto = oggetto sovrapposto successivo
    if (!c.length) { clickBox = { px, py, shift: e.shiftKey }; o.draw(); return true; }
    let pickKey = c[0].key;
    const same = lastPick && Math.hypot(lastPick.px - px, lastPick.py - py) < 4 * dpr() && lastPick.keys.join() === c.map(x => x.key).join();
    if (same && c.length > 1) {
      const i = (lastPick.i + 1) % c.length;
      pickKey = c[i].key;
      if (!e.shiftKey) sel.delete(c[lastPick.i].key);
      lastPick.i = i;
      ctx.status(`Oggetti sovrapposti: ${i + 1} di ${c.length} (clic di nuovo per il successivo)`);
    } else lastPick = { px, py, keys: c.map(x => x.key), i: 0 };
    if (e.shiftKey) sel.delete(pickKey); else sel.add(pickKey);
    if (c.length > 1 && !same) ctx.status(`Qui ci sono ${c.length} oggetti sovrapposti: clic di nuovo nello stesso punto per passare al successivo`);
    gripCache = null;
    renderProps();
    o.draw();
    return true;
  }
  function submitPoint() {
    const p = pending;
    if (!p || !cursor) return;
    let pt = snapHit ? [snapHit.x, snapHit.y] : effectivePoint(cursor);
    lastPt = pt;
    pending = null;
    p.resolve(pt);
  }
  function rightClick() {
    if (!on) return;
    if (clickBox) { clickBox = null; o.draw(); return; }
    if (pending) { submit(input.value); return; }
    if (mem.lastCmd) startCmd(mem.lastCmd);
  }
  function startGrip(gp) {
    run("grip", async () => {
      hotGrip = gp;
      const before = clone(getE(gp.key));
      // anteprima: il grip si applica a una copia dell'entita'
      const tmp = q => { const c = clone(before); const g = gripsOf(gp.key, c)[gp.i]; if (g) g.fn(q); return c; };
      try {
        const q = await needPoint("Punto di arrivo del grip (Esc annulla)", { base: [gp.x, gp.y], preview: p => [tmp(p)] });
        command([gp.key], () => { const g = gripsOf(gp.key)[gp.i]; if (g) g.fn(q); });
      } finally { hotGrip = null; gripCache = null; }
    });
  }
  function key(e) {
    if (!on) return false;
    const inField = e.target.closest?.("input, textarea, select");
    const k = e.key;
    if (inField && e.target !== input) return false;
    if (k === "Escape") {
      if (clickBox) clickBox = null;
      else if (task) cancelTask();
      else { sel.clear(); gripCache = null; renderProps(); }
      input.value = ""; setPrompt(pending ? pending.text : ""); o.draw();
      return true;
    }
    if (e.ctrlKey && k.toLowerCase() === "z") { doUndo(); return true; }
    if (e.ctrlKey && k.toLowerCase() === "y") { doRedo(); return true; }
    if (k === "F8") { setOrtho(!ortho); return true; }
    if (k === "F3") { setOsnap(!osnapOn); return true; }
    if (k === "F7") { setGrid(!gridOn); return true; }
    if (k === "F10") { setPolar(!polarOn); return true; }
    if (e.target === input) return false; // il resto lo gestisce la riga di comando
    if (e.ctrlKey && k === "1") { startCmd("props"); return true; }
    if (e.ctrlKey && k.toLowerCase() === "c") { startCmd(e.shiftKey ? "copybase" : "copyclip"); return true; }
    if (e.ctrlKey && k.toLowerCase() === "v") { startCmd("paste"); return true; }
    if (e.ctrlKey && k.toLowerCase() === "a") { selectAll(); return true; }
    if (k === "Delete") { if (sel.size && !pending) removeKeys([...sel]); return true; }
    if (k === "Enter" || k === " ") { submit(input.value); return true; }
    if (k === "Backspace") { input.value = input.value.slice(0, -1); return true; }
    if (k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) { input.focus(); input.value += k; return true; }
    return false;
  }
  function dblclick() {
    if (!on) return false;
    if (!pending) editAt();
    return true;
  }
  async function editAt() {
    const c = cursor && candidates(cursor[0], cursor[1], true);
    if (!c?.length) return;
    const k = c[0].key, e = getE(k);
    if (["TEXT", "ATTRIB", "MTEXT"].includes(e?.type)) {
      let s;
      if (e.type === "MTEXT") {
        const ta = el("textarea", { rows: 6, style: { width: "100%", minWidth: "360px" } });
        ta.value = String(e.text || "").replace(/\\P/g, "\n");
        s = await modal("Modifica testo multiriga", ta, [{ label: "Annulla", value: null }, { label: "OK", primary: true, value: () => ta.value.replace(/\r?\n/g, "\\P") }]);
      } else s = await askText("Modifica testo", e.type === "ATTRIB" ? `Attributo ${e.tag || ""}` : "Testo", e.text || "");
      if (s !== null && s !== undefined) command([k], () => { getE(k).text = s; });
    } else { sel.clear(); sel.add(isTop(k) ? k : String(parseKey(k)[0])); gripCache = null; renderProps(); o.draw(); }
  }

  // ---- pannello delle proprieta' (anche su piu' oggetti)
  const props = el("div", { class: "cad-props", style: { borderTop: "1px solid var(--line)", padding: "8px 10px", fontSize: "12.5px", display: "none" } });
  const layerNames = () => [...new Set([...model().layers.keys(), ...newLayers.keys()])].sort((a, b) => a.localeCompare(b));
  const ltypeNames = () => [...new Set([...LTYPES_STD, ...(db.tables.LTYPE?.entries || []).map(t => t.name).filter(n => n && !/^by(layer|block)$/i.test(n))])];
  function field(label, value, onchange) {
    const inp = el("input", { type: "text", value: value ?? "", class: "field", style: { width: "100%" } });
    inp.addEventListener("change", () => onchange(inp.value));
    return [el("dt", {}, label), el("dd", {}, inp)];
  }
  function selectField(label, options, value, onchange, mixed) {
    const s = el("select", { class: "field", style: { width: "100%" } }, ...(mixed ? [el("option", { value: "__mixed", selected: true }, "*varie*")] : []), ...options.map(([v, n]) => el("option", { value: String(v), selected: !mixed && String(v) === String(value) ? true : undefined }, n)));
    s.addEventListener("change", () => { if (s.value !== "__mixed") onchange(s.value); });
    return [el("dt", {}, label), el("dd", {}, s)];
  }
  function edit(k, fn) { command([k], () => fn(getE(k))); }
  function renderProps() {
    gripCache = null;
    props.innerHTML = "";
    if (!on || !sel.size || propsHidden) { props.style.display = "none"; return; }
    props.style.display = "";
    const list = [...sel].filter(k => getE(k)), ents = list.map(getE), one = list.length === 1 ? ents[0] : null;
    const counts = {};
    ents.forEach(e => { const n = TYPE_IT[e.type] || e.type; counts[n] = (counts[n] || 0) + 1; });
    props.append(el("b", {}, one ? (one.dimKind ? G.DIM_KIND_IT[one.dimKind] : TYPE_IT[one.type] || one.type) : `${list.length} oggetti: ` + Object.entries(counts).map(([n, c]) => `${c} ${n}`).join(", ")));
    if (list.some(k => !isTop(k))) props.append(el("div", { class: "note", style: { marginTop: "4px" } }, "Dentro un blocco: le modifiche valgono per la definizione del blocco (tutte le sue copie)."));
    const dl = el("dl", { class: "kv stack", style: { marginTop: "6px" } });
    const allSame = f => ents.every(e => f(e) === f(ents[0]));
    const setAllK = (fn) => command(list, () => list.forEach(k => fn(getE(k))));
    dl.append(...selectField("Layer", layerNames().map(n => [n, n]), ents[0].layer, v => setAllK(e => { e.layer = v; }), !allSame(e => e.layer)));
    const cval = e => (e.colorIndex === undefined && typeof e.color === "number" ? "tc" : e.colorIndex ?? 256);
    const copts = COLORS.map(([v, n]) => [v, `${n}${v > 0 && v < 256 ? " (" + v + ")" : ""}`]);
    if (allSame(cval) && !COLORS.some(([v]) => String(v) === String(cval(ents[0])))) copts.push([cval(ents[0]), cval(ents[0]) === "tc" ? "Colore RGB" : `Indice ${cval(ents[0])}`]);
    dl.append(...selectField("Colore", copts, cval(ents[0]), v => { if (v === "tc") return; setAllK(e => { e.colorIndex = +v; delete e.color; }); }, !allSame(cval)));
    const ltv = e => (e.lineType || "ByLayer").replace(/^bylayer$/i, "ByLayer").replace(/^byblock$/i, "ByBlock");
    dl.append(...selectField("Tipo linea", ltypeNames().map(n => [n, n === "ByLayer" ? "DaLayer" : n === "ByBlock" ? "DaBlocco" : n]), ltv(ents[0]), v => setAllK(e => { e.lineType = v; }), !allSame(ltv)));
    const lwv = e => e.lineweight ?? -1;
    const lwopts = [...LWEIGHTS];
    if (allSame(lwv) && !lwopts.some(([v]) => v === lwv(ents[0]))) lwopts.push([lwv(ents[0]), `${(lwv(ents[0]) / 100).toFixed(2).replace(".", ",")} mm`]);
    dl.append(...selectField("Spessore", lwopts, lwv(ents[0]), v => setAllK(e => { e.lineweight = +v; }), !allSame(lwv)));
    dl.append(...field("Scala tipo linea", allSame(e => e.lineTypeScale ?? 1) ? f4(ents[0].lineTypeScale ?? 1) : "", v => { const n = num(v); if (n > 0) setAllK(e => { e.lineTypeScale = n; }); }));
    if (ents.every(e => ["TEXT", "MTEXT", "ATTRIB"].includes(e.type)) && !one) dl.append(...field("Altezza testo", allSame(e => e.textHeight) ? f4(ents[0].textHeight) : "", v => { const n = num(v); if (n > 0) setAllK(e => { e.textHeight = n; }); }));
    if (one) {
      const k = list[0], e = one, pt = (key, lbl) => {
        if (!e[key]) return;
        dl.append(...field(lbl + " X", f4(e[key].x), v => { const n = num(v); if (n !== null) edit(k, x => { x[key].x = n; }); }));
        dl.append(...field(lbl + " Y", f4(e[key].y), v => { const n = num(v); if (n !== null) edit(k, x => { x[key].y = n; }); }));
      };
      const ro = (label, v) => dl.append(el("dt", {}, label), el("dd", {}, String(v)));
      if (e.handle) ro("Handle", e.handle);
      if (e.type === "LINE") { pt("startPoint", "Inizio"); pt("endPoint", "Fine"); const dx = e.endPoint.x - e.startPoint.x, dy = e.endPoint.y - e.startPoint.y; ro("Lunghezza", fmt(+Math.hypot(dx, dy).toFixed(4))); ro("Angolo", fmt(+((Math.atan2(dy, dx) * R2D + 360) % 360).toFixed(3)) + "°"); }
      if (e.type === "CIRCLE" || e.type === "ARC") {
        pt("center", "Centro");
        dl.append(...field("Raggio", f4(e.radius), v => { const n = num(v); if (n > 0) edit(k, x => { x.radius = n; }); }));
        dl.append(...field("Diametro", f4(e.radius * 2), v => { const n = num(v); if (n > 0) edit(k, x => { x.radius = n / 2; }); }));
        if (e.type === "CIRCLE") { ro("Circonferenza", fmt(+(TAU * e.radius).toFixed(4))); ro("Area", fmt(+(Math.PI * e.radius ** 2).toFixed(4))); }
      }
      if (e.type === "ARC") {
        dl.append(...field("Angolo iniziale (°)", f4(e.startAngle * R2D), v => { const n = num(v); if (n !== null) edit(k, x => { x.startAngle = n / R2D; }); }));
        dl.append(...field("Angolo finale (°)", f4(e.endAngle * R2D), v => { const n = num(v); if (n !== null) edit(k, x => { x.endAngle = n / R2D; }); }));
        ro("Lunghezza arco", fmt(+(G.normA(e.endAngle - e.startAngle) * e.radius).toFixed(4)));
      }
      if (e.type === "ELLIPSE") { pt("center", "Centro"); dl.append(...field("Rapporto assi", f4(e.axisRatio), v => { const n = num(v); if (n > 0 && n <= 1) edit(k, x => { x.axisRatio = n; }); })); }
      if (e.type === "TEXT" || e.type === "MTEXT" || e.type === "ATTRIB") {
        dl.append(...field("Testo", e.type === "MTEXT" ? String(e.text || "").replace(/\\P/g, " ¶ ") : e.text, v => edit(k, x => { x.text = e.type === "MTEXT" ? v.replace(/ ?¶ ?/g, "\\P") : v; })));
        dl.append(...field("Altezza", f4(e.textHeight), v => { const n = num(v); if (n > 0) edit(k, x => { x.textHeight = n; }); }));
        dl.append(...field("Rotazione (°)", f4((e.rotation || 0) * R2D), v => { const n = num(v); if (n !== null) edit(k, x => { x.rotation = n / R2D; if (x.direction) x.direction = { x: Math.cos(n / R2D), y: Math.sin(n / R2D), z: 0 }; }); }));
        if (e.type === "TEXT") {
          const H2 = [[0, "Sinistra"], [1, "Centro"], [2, "Destra"], [4, "Mezzo"]], V2 = [[0, "Linea di base"], [1, "Basso"], [2, "Medio"], [3, "Alto"]];
          dl.append(...selectField("Allineamento orizz.", H2, e.halign || 0, v => edit(k, x => { const p = (x.halign || x.valign) && x.endPoint ? { ...x.endPoint } : { ...x.startPoint }; x.halign = +v; x.startPoint = { ...p }; x.endPoint = { ...p }; })));
          dl.append(...selectField("Allineamento vert.", V2, e.valign || 0, v => edit(k, x => { const p = (x.halign || x.valign) && x.endPoint ? { ...x.endPoint } : { ...x.startPoint }; x.valign = +v; x.startPoint = { ...p }; x.endPoint = { ...p }; })));
        }
        if (e.type === "MTEXT") dl.append(...field("Larghezza riquadro", f4(e.rectWidth || 0), v => { const n = num(v); if (n !== null && n >= 0) edit(k, x => { x.rectWidth = n; }); }));
        pt(e.type === "MTEXT" ? "insertionPoint" : (e.halign || e.valign) && e.endPoint ? "endPoint" : "startPoint", "Inserimento");
      }
      if (e.type === "LWPOLYLINE" || e.type === "POLYLINE2D") {
        const cb = el("input", { type: "checkbox", checked: !!(e.flag & 1) });
        cb.addEventListener("change", () => edit(k, x => { x.flag = cb.checked ? (x.flag | 1) : (x.flag & ~1); }));
        const path = pathOf(e), len = path.segs.reduce((s, c) => s + G.curveLen(c), 0);
        ro("Vertici", (e.vertices || []).length); ro("Lunghezza", fmt(+len.toFixed(4)));
        if (path.closed) { const pts = path.segs.flatMap(c => G.curvePts(c)); ro("Area", fmt(+Math.abs(G.polyArea(pts)).toFixed(4))); }
        dl.append(el("dt", {}, "Chiusa"), el("dd", {}, cb));
        dl.append(...field("Larghezza costante", f4(e.constantWidth || 0), v => { const n = num(v); if (n !== null && n >= 0) edit(k, x => { x.constantWidth = n; }); }));
      }
      if (e.type === "INSERT") {
        ro("Nome blocco", e.name || "");
        pt("insertionPoint", "Inserimento");
        dl.append(...field("Scala X", f4(e.xScale || 1), v => { const n = num(v); if (n) edit(k, x => { x.xScale = n; }); }));
        dl.append(...field("Scala Y", f4(e.yScale || 1), v => { const n = num(v); if (n) edit(k, x => { x.yScale = n; }); }));
        dl.append(...field("Rotazione (°)", f4((e.rotation || 0) * R2D), v => { const n = num(v); if (n !== null) edit(k, x => { x.rotation = n / R2D; }); }));
        for (const [i, a] of (e.attribs || []).entries()) dl.append(...field(`Attributo ${a.tag || i + 1}`, a.text, v => edit(k, x => { x.attribs[i].text = v; })));
      }
      if (e.type === "POINT") pt("position", "Posizione");
      if (e.type === "HATCH") {
        ro("Motivo", e.patternName || (e.solidFill ? "SOLID" : ""));
        if (!e.solidFill) {
          dl.append(...field("Scala motivo", f4(e.patternScale || 1), v => { const n = num(v); if (n > 0) edit(k, x => { const r = n / (x.patternScale || 1); x.patternScale = n; if (x.definitionLines) x.definitionLines.forEach(dd => { dd.offset.x *= r; dd.offset.y *= r; dd.base.x *= r; dd.base.y *= r; dd.dashLengths = (dd.dashLengths || []).map(q => q * r); }); }); }));
          dl.append(...field("Angolo motivo (°)", f4((e.patternAngle || 0) * R2D), v => { const n = num(v); if (n !== null) edit(k, x => { const da = n / R2D - (x.patternAngle || 0); x.patternAngle = n / R2D; if (x.definitionLines) x.definitionLines.forEach(dd => { const c = Math.cos(da), s = Math.sin(da); dd.angle += da; dd.offset = { x: dd.offset.x * c - dd.offset.y * s, y: dd.offset.x * s + dd.offset.y * c }; }); }); }));
        }
      }
      if (e.type === "DIMENSION") {
        if (e.dimKind) {
          ro("Misura", G.dimText({ ...e, text: undefined }));
          dl.append(...field("Testo (<> = misura)", e.text || "<>", v => edit(k, x => { x.text = v === "<>" ? undefined : v; })));
          dl.append(...field("Altezza testo", f4(e.style.txt), v => { const n = num(v); if (n > 0) edit(k, x => { x.style.txt = n; }); }));
          dl.append(...field("Scala quota", f4(e.style.scale), v => { const n = num(v); if (n > 0) edit(k, x => { x.style.scale = n; }); }));
          dl.append(...field("Decimali", e.style.dec, v => { const n = num(v); if (n >= 0) edit(k, x => { x.style.dec = Math.round(n); }); }));
        } else { if (e.measurement !== undefined) ro("Misura", fmt(+(+e.measurement).toFixed(4))); if (e.text) ro("Testo", e.text); if (e.styleName) ro("Stile", e.styleName); }
      }
    }
    props.append(dl, el("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "6px" } },
      ...["move", "copy", "rotate", "scale", "mirror", "explode", "erase"].map(id => el("button", { class: "btn", title: CMDS[id].title, onclick: () => startCmd(id) }, CMDS[id].label))));
  }

  // ---- barra multifunzione (come AutoCAD: schede, pannelli con il titolo sotto, pulsanti grandi e piccoli, tendine)
  const btns = {};
  const aliasOf = id => Object.entries(ALIAS).filter(([a, v]) => v === id && a.length <= 4 && a !== CMDS[id].label.toUpperCase()).map(([a]) => a)[0] || "";
  const tip = (id, variant) => { const c = CMDS[id], al = aliasOf(id); return `${c.label}${variant && variant !== c.label ? ` - ${variant}` : ""}${al ? ` (${al})` : ""}\n${c.title.replace(/^[^:]*:\s*/, "")}`; };
  const ICO = { circle: "circle", arc: "arc", array: "array", dimlin: "dimlin" };
  const ddMenu = el("div", { class: "cad-menu", hidden: true });
  document.addEventListener("pointerdown", ev => { if (!ddMenu.contains(ev.target) && !ev.target.closest?.(".cad-dd")) ddMenu.hidden = true; });
  function openMenu(anchor, items, onPick) {
    ddMenu.innerHTML = "";
    for (const it of items) ddMenu.append(el("button", { class: "cad-menu-it", title: tip(it.id, it.label), onclick: () => { ddMenu.hidden = true; onPick(it); } }, cadIcon(it.icon || it.id, 20), el("span", {}, it.label || CMDS[it.id].label)));
    const r = anchor.getBoundingClientRect(), rb = bar.getBoundingClientRect();
    ddMenu.style.left = `${r.left - rb.left}px`; ddMenu.style.top = `${r.bottom - rb.top + 2}px`;
    ddMenu.hidden = false;
  }
  // pulsante con tendina: la parte principale ripete l'ultima variante scelta (come in AutoCAD)
  function button(kind, id, opts = {}) {
    const variants = opts.menu;
    let curV = variants ? variants[0] : { id, arg: opts.arg, label: opts.label, icon: opts.icon };
    const size = kind === "big" ? 32 : 18;
    const ico = el("span", {}, cadIcon(curV.icon || ICO[curV.id] || curV.id, size)), lab = el("span", { class: "cad-lab" }, opts.label || CMDS[curV.id].label);
    const main = el("button", { class: `cad-${kind}`, title: tip(curV.id, curV.label), onclick: () => startCmd(curV.id, curV.arg) }, ico, lab);
    const setV = v => { curV = v; ico.replaceChildren(cadIcon(v.icon || ICO[v.id] || v.id, size)); lab.textContent = opts.label || CMDS[v.id].label; main.title = tip(v.id, v.label); btns[v.id] = main; };
    btns[curV.id] = main;
    if (!variants) return main;
    const dd = el("button", { class: `cad-dd cad-dd-${kind}`, title: "Altre opzioni", onclick: ev => { ev.stopPropagation(); openMenu(wrap, variants, v => { setV(v); startCmd(v.id, v.arg); }); } }, "▾");
    const wrap = el("span", { class: `cad-split cad-split-${kind}` }, main, dd);
    return wrap;
  }
  const big = (id, o2) => button("big", id, o2), small = (id, o2) => button("small", id, o2);
  const col = (...c) => el("div", { class: "cad-col" }, ...c);
  const panel = (title, ...c) => el("div", { class: "cad-panel" }, el("div", { class: "cad-panel-body" }, ...c), el("div", { class: "cad-panel-t" }, title));
  const labeled = (icon, title, ctl) => el("label", { class: "cad-field", title }, cadIcon(icon, 16), ctl);

  const layerPick = el("select", { class: "field cad-layersel", title: "Layer corrente: i nuovi oggetti vanno su questo layer" });
  const colorPick = el("select", { class: "field", title: "Colore dei nuovi oggetti" }, ...COLORS.filter(([v]) => v !== 0).map(([v, n]) => el("option", { value: v }, n)));
  colorPick.addEventListener("change", () => { cur.color = +colorPick.value; });
  const ltPick = el("select", { class: "field", title: "Tipo di linea dei nuovi oggetti" }, ...ltypeNames().map(n => el("option", { value: n }, n === "ByLayer" ? "DaLayer" : n === "ByBlock" ? "DaBlocco" : n)));
  ltPick.addEventListener("change", () => { cur.lineType = ltPick.value; });
  const lwPick = el("select", { class: "field", title: "Spessore di linea dei nuovi oggetti" }, ...LWEIGHTS.filter(([v]) => v !== -2).map(([v, n]) => el("option", { value: v }, n)));
  lwPick.addEventListener("change", () => { cur.lineweight = +lwPick.value; });
  layerPick.addEventListener("change", async () => {
    if (layerPick.value === "__new") { layerPick.value = cur.layer; startCmd("layernew"); }
    else cur.layer = layerPick.value;
  });
  function fillLayers() {
    layerPick.innerHTML = "";
    const names = layerNames();
    if (!names.includes(cur.layer)) cur.layer = names.includes("0") || !names.length ? "0" : names[0];
    if (!names.includes(cur.layer)) names.unshift(cur.layer);
    for (const n of names) layerPick.append(el("option", { value: n, selected: n === cur.layer || undefined }, n));
    layerPick.append(el("option", { value: "__new" }, "+ Nuovo layer..."));
  }
  const hInput = el("input", { type: "text", class: "field", value: fmt(cur.textH), title: "Altezza dei nuovi testi", style: { width: "64px" } });
  hInput.addEventListener("change", () => { const n = num(hInput.value); if (n > 0) cur.textH = n; });

  const DIMS = [{ id: "dimlin" }, { id: "dimali" }, { id: "dimang" }, { id: "dimrad" }, { id: "dimdia" }, { id: "dimord" }];
  const tabHome = el("div", { class: "cad-tabpage" },
    panel("Disegna", big("line"), big("pline"),
      big("circle", { menu: [{ id: "circle", label: "Centro, raggio", icon: "circle" }, { id: "circle", arg: "d", label: "Centro, diametro", icon: "circled" }, { id: "circle", arg: "3p", label: "3 punti", icon: "circle3p" }] }),
      big("arc", { menu: [{ id: "arc", label: "3 punti", icon: "arc" }, { id: "arc", arg: "cse", label: "Centro, inizio, fine", icon: "arccse" }] }),
      col(small("rect"), small("ellipse"), small("hatch"))),
    panel("Modifica",
      col(small("move"), small("rotate"), small("trim", { menu: [{ id: "trim" }, { id: "extend" }] })),
      col(small("copy"), small("mirror"), small("fillet", { menu: [{ id: "fillet" }, { id: "chamfer" }] })),
      col(small("stretch"), small("scale"), small("array", { menu: [{ id: "array", label: "Serie rettangolare", icon: "array" }, { id: "array", arg: "p", label: "Serie polare", icon: "arraypolar" }] })),
      col(small("erase"), small("explode"), small("offset"))),
    panel("Annotazione",
      big("mtext", { menu: [{ id: "mtext", label: "Testo multiriga" }, { id: "text", label: "Testo su riga singola" }] }),
      big("dimlin", { menu: DIMS }),
      col(small("dimstyle"), small("dimcont"), small("dimbase"))),
    panel("Layer", col(labeled("layer", "Layer corrente", layerPick), el("div", { class: "cad-row" }, small("layernew", { label: "Nuovo" }), small("layercur", { label: "Da oggetto" })))),
    panel("Proprietà", big("matchprop"), col(labeled("props", "Colore", colorPick), labeled("line", "Tipo di linea", ltPick), labeled("pline", "Spessore di linea", lwPick))),
    panel("Utilità", big("dist", { menu: [{ id: "dist" }, { id: "area" }] }), col(small("selectall", { label: "Sel. tutto" }), small("props"))),
    panel("Appunti", big("paste"), col(small("copyclip", { label: "Copia" }), small("copybase", { label: "Copia base" }))));
  const tabAnnot = el("div", { class: "cad-tabpage", hidden: true },
    panel("Testo", big("mtext"), big("text"), col(labeled("text", "Altezza dei nuovi testi", hInput))),
    panel("Quote", big("dimlin", { menu: DIMS }), col(small("dimali"), small("dimang"), small("dimord")), col(small("dimrad"), small("dimdia"), small("dimstyle")), big("dimcont"), big("dimbase")),
    panel("Misura", big("dist"), big("area")));
  const tabView = el("div", { class: "cad-tabpage", hidden: true },
    panel("Navigazione", big("zoomext"), big("zoomwin")),
    panel("Tavolozze", big("props")));
  const pages = { Inizio: tabHome, Annota: tabAnnot, Vista: tabView };
  const tabBtns = Object.keys(pages).map(n => el("button", { class: "cad-tab" + (n === "Inizio" ? " on" : ""), onclick: ev => { for (const [k, pg] of Object.entries(pages)) pg.hidden = k !== n; tabBtns.forEach(b => b.classList.toggle("on", b === ev.currentTarget)); } }, n));
  const quick = el("span", { class: "cad-quick" }, ...["undo", "redo"].map(id => (btns[id] = el("button", { class: "cad-qa", title: tip(id), onclick: () => startCmd(id) }, cadIcon(id, 16)))));
  const bar = el("div", { class: "cad-ribbon", style: { display: "none" } }, el("div", { class: "cad-tabs" }, quick, ...tabBtns), el("div", { class: "cad-ribbon-body" }, tabHome, tabAnnot, tabView), ddMenu);

  // ---- riga di comando e barra di stato (in basso, come in AutoCAD)
  const stBtn = (label, title, onclick) => el("button", { class: "cad-st", title, onclick }, label);
  const gridBtn = stBtn("GRIGLIA", "Griglia (F7)", () => setGrid(!gridOn));
  const orthoBtn = stBtn("ORTO", "Modo Orto (F8): solo direzioni orizzontali e verticali", () => setOrtho(!ortho));
  const polarBtn = stBtn("POLARE", "Puntamento polare (F10): aggancio alle direzioni multiple dell'angolo scelto", () => setPolar(!polarOn));
  const snapBtn = stBtn("OSNAP", "Snap ad oggetto (F3): fine, medio, centro, intersezione...", () => setOsnap(!osnapOn));
  snapBtn.classList.add("on");
  const snapMenu = el("div", { class: "cad-snapmenu", hidden: true }, ...Object.keys(modes).map(k => {
    const cb = el("input", { type: "checkbox", checked: modes[k] });
    cb.addEventListener("change", () => { modes[k] = cb.checked; });
    return el("label", {}, cb, " ", G.SNAP_IT[k]);
  }));
  const polarMenu = el("div", { class: "cad-snapmenu", hidden: true }, ...[90, 45, 30, 22.5, 15, 10, 5].map(v => {
    const rb = el("input", { type: "radio", name: "polar" + Math.random(), checked: v === polarInc });
    rb.addEventListener("change", () => { polarInc = v; setPolar(true); });
    return el("label", {}, rb, ` ${fmt(v)}°`);
  }));
  const more = (menu, title) => el("button", { class: "cad-st cad-st-more", title, onclick: ev => { ev.stopPropagation(); for (const m of [snapMenu, polarMenu]) if (m !== menu) m.hidden = true; menu.hidden = !menu.hidden; } }, "▾");
  document.addEventListener("click", ev => { for (const m of [snapMenu, polarMenu]) if (!m.contains(ev.target)) m.hidden = true; });
  function setOrtho(v) { ortho = v; if (v) { polarOn = false; polarBtn.classList.remove("on"); } orthoBtn.classList.toggle("on", v); o.draw(); }
  function setPolar(v) { polarOn = v; if (v) { ortho = false; orthoBtn.classList.remove("on"); } polarBtn.classList.toggle("on", v); o.draw(); }
  function setOsnap(v) { osnapOn = v; snapBtn.classList.toggle("on", v); o.draw(); }
  function setGrid(v) { gridOn = v; gridBtn.classList.toggle("on", v); o.draw(); }
  const promptEl = el("span", { class: "cad-prompt" }, "Comando:");
  const input = el("input", { type: "text", class: "cad-input", spellcheck: false, autocomplete: "off", placeholder: "Digitare un comando (L, PL, C, DLI, M, TR, O, F...) o ? per l'elenco" });
  const coordEl = el("span", { class: "cad-coord" });
  input.addEventListener("keydown", ev => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); submit(input.value); }
    else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); key({ key: "Escape", target: document.body }); input.blur(); }
  });
  const cmdline = el("div", { class: "cad-bottom", style: { display: "none" } },
    el("div", { class: "cad-cmdline" }, el("span", { class: "cad-cmd-ico" }, "▸"), promptEl, input),
    el("div", { class: "cad-status" }, coordEl, el("span", { class: "grow" }), el("span", { class: "cad-st-t" }, "MODELLO"), gridBtn,
      el("span", { class: "cad-snapwrap" }, polarBtn, more(polarMenu, "Angolo del puntamento polare"), polarMenu), orthoBtn,
      el("span", { class: "cad-snapwrap" }, snapBtn, more(snapMenu, "Punti di aggancio attivi"), snapMenu)));
  // scorciatoie per l'aiuto (F1)
  describeKeys(ctx, "AutoCAD", [
    ...["line", "pline", "circle", "arc", "rect", "ellipse", "hatch", "mtext", "text"].map(id => [aliasOf(id) || CMDS[id].label, CMDS[id].label, "Disegna (scrivi e premi Invio)"]),
    ...["move", "copy", "rotate", "scale", "mirror", "stretch", "array", "offset", "trim", "extend", "fillet", "chamfer", "explode", "erase", "matchprop"].map(id => [aliasOf(id) || CMDS[id].label, CMDS[id].label, "Modifica (scrivi e premi Invio)"]),
    ...["dimlin", "dimali", "dimang", "dimrad", "dimdia", "dimord", "dimcont", "dimbase", "dimstyle", "dist", "area"].map(id => [aliasOf(id) || CMDS[id].label, CMDS[id].label, "Quote e misure (scrivi e premi Invio)"]),
    ["Invio / Spazio / clic destro", "Conferma; a vuoto ripete l'ultimo comando", "Generale"], ["Esc", "Annulla il comando o la selezione", "Generale"],
    ["Ctrl+Z", "Annulla", "Generale"], ["Ctrl+Y", "Ripeti", "Generale"], ["Canc", "Cancella la selezione", "Generale"], ["Ctrl+A", "Seleziona tutto", "Generale"],
    ["Ctrl+C", "Copia negli appunti", "Generale"], ["Ctrl+Maiusc+C", "Copia con punto base", "Generale"], ["Ctrl+V", "Incolla", "Generale"], ["Ctrl+1", "Tavolozza Proprietà", "Generale"],
    ["F3", "Snap ad oggetto", "Aiuti al disegno"], ["F7", "Griglia", "Aiuti al disegno"], ["F8", "Orto", "Aiuti al disegno"], ["F10", "Puntamento polare", "Aiuti al disegno"],
    ["Maiusc+clic", "Toglie dalla selezione", "Selezione"], ["Ctrl+clic", "Seleziona dentro un blocco", "Selezione"], ["Clic ripetuto", "Oggetto sovrapposto successivo", "Selezione"],
    ["Trascina da sinistra / da destra", "Finestra / intersezione", "Selezione"], ["Doppio clic su un testo", "Modifica il testo", "Selezione"],
    ["x,y · @dx,dy · @d<a · numero", "Coordinate assolute, relative, polari, distanza diretta", "Riga di comando"],
  ]);
  function showHelp() {
    const rows = Object.values(CMDS).map(c => el("tr", {}, el("td", {}, c.label), el("td", { class: "note" }, Object.entries(ALIAS).filter(([, v]) => v === c.id).map(([a]) => a).filter(a => a.length <= 4).join(", ")), el("td", {}, c.title)));
    modal("Comandi dell'editor CAD", el("div", { style: { maxHeight: "60vh", overflow: "auto" } }, el("table", { class: "grid" }, ...rows),
      el("p", { class: "note" }, "Coordinate: x;y oppure x,y (decimali col punto) · @dx;dy relative · @distanza<angolo polari · un numero = distanza nella direzione del cursore. Invio o clic destro confermano, Esc annulla, Invio a vuoto ripete l'ultimo comando. F3 aggancio, F8 ortogonale.")));
  }

  return {
    bar, cmdline, props, overlay, pointerDown, pointerMove, pointerUp, pointerLeave, rightClick, key, dblclick,
    get on() { return on; },
    toggle() {
      on = !on;
      bar.style.display = on ? "flex" : "none";
      ddMenu.hidden = true;
      cmdline.style.display = on ? "flex" : "none";
      if (on) { fillLayers(); ctx.status("Editor attivo: clic per selezionare, comandi dalla barra o scrivendo (es. L, C, DLI, TR). ? = elenco comandi"); }
      else { cancelTask(); sel.clear(); box = null; clickBox = null; hover = null; }
      renderProps();
      o.draw();
      return on;
    },
    hasEdits: () => undo.length > 0 || newLayers.size > 0,
    // dati per il salvataggio (ezdxf)
    payload() { return JSON.parse(JSON.stringify(this._payload(), (k, v) => (k === "xdata" ? undefined : plain(k, v)))); },
    _payload() {
      const layers = [...newLayers.values()];
      for (const L of model().layers.values()) layers.push({ name: L.name, aci: L.aci, off: L.off });
      const ltypes = (db.tables.LTYPE?.entries || []).map(t => ({ name: t.name, pattern: (t.pattern || []).map(p => +p.elementLength || 0), description: t.description || "" }));
      if (sourceKind === "dxf") {
        const changedE = [], deleted = [], added = [];
        // posizione nel model space del file: identifica le entita' dei DXF senza handle (stile R12)
        let msp = 0;
        db.entities.forEach(e => {
          if (e._new) { if (!e._deleted && e.type !== "_skip") added.push(e); return; }
          const pos = e.isInPaperSpace ? null : msp++;
          if (e._deleted) { deleted.push({ handle: e.handle, msp: pos }); return; }
          if (e._dirty) changedE.push({ ...e, _msp: pos });
        });
        // entita' modificate dentro i blocchi (per handle)
        for (const b of blocks.values()) for (const e of b.entities || []) {
          if (!e.handle) continue;
          if (e._deleted) deleted.push({ handle: e.handle, msp: null });
          else if (e._dirty) changedE.push({ ...e, _msp: null });
        }
        return { source: "dxf", changed: changedE, deleted, added, layers, ltypes };
      }
      return { source: "dwg", layers, ltypes, db: { header: db.header, tables: { LAYER: db.tables.LAYER, DIMSTYLE: db.tables.DIMSTYLE, BLOCK_RECORD: { entries: (db.tables.BLOCK_RECORD?.entries || []).map(b => ({ ...b, entities: (b.entities || []).filter(e => !e._deleted) })) } }, entities: db.entities.filter(e => !e._deleted && e.type !== "_skip") } };
    },
  };
}

function segRect(a, b, x0, y0, x1, y1) {
  const L = { t: "L", x1: a[0], y1: a[1], x2: b[0], y2: b[1] };
  return [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]].some(([p, q, r, s]) => G.intersect(L, { t: "L", x1: p, y1: q, x2: r, y2: s }).length);
}
