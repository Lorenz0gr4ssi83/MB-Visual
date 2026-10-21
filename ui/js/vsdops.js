// Operazioni di modifica dei diagrammi (sui DOM XML del .vsdx, ui/js/vsdmodel.js), con le stesse regole di Visio:
// forme nuove con formule (Width, Height), connettori dinamici incollati alle forme (Connect + _WALKGLUE /
// _XFTRIGGER), ridimensionamento che ricalcola le formule della geometria, gruppi, livelli, dati della forma.
import { VNS, cell, val, num0, section, rowsOf, geometry, setCell, setRowCell, setSmart, invalidate, evalFormula, cellValue, markDirty, is1D, textEl, color, fmt } from "./vsdmodel.js";
import { localXf, mul, ap, inv, layersOf, pageInfo } from "./vsdrender.js";

const kids = (el, n) => el ? [...el.children].filter(c => c.localName === n) : [];
const kid = (el, n) => el ? [...el.children].find(c => c.localName === n) || null : null;
const PT = 1 / 72;

// ------------------------------------------------------------------ geometria nella pagina (pollici, y verso l'alto)
export function toPageM(doc, S) {
  let m = localXf(doc, S);
  for (let p = S.parent; p; p = p.parent) m = mul(localXf(doc, p), m);
  return m;
}
export function boxCorners(doc, S) {
  const m = toPageM(doc, S), W = num0(doc, S, "Width"), H = num0(doc, S, "Height");
  return [[0, 0], [W, 0], [W, H], [0, H]].map(([x, y]) => ap(m, x, y));
}
export function bounds(doc, list) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const S of list) {
    const pts = is1D(doc, S) ? [[num0(doc, S, "BeginX"), num0(doc, S, "BeginY")], [num0(doc, S, "EndX"), num0(doc, S, "EndY")]].map(p => S.parent ? ap(toPageM(doc, S.parent), ...p) : p) : boxCorners(doc, S);
    for (const [x, y] of pts) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
  }
  return b;
}
export function nextId(page) {
  let n = 0;
  for (const s of page.xml.getElementsByTagNameNS(VNS, "Shape")) { const v = +s.getAttribute("ID") || 0; if (v < 0xffffffff) n = Math.max(n, v); }
  return n + 1;
}
function shapesEl(page) {
  const root = page.xml.documentElement;
  let sh = kid(root, "Shapes");
  if (!sh) { sh = page.xml.createElementNS(VNS, "Shapes"); root.insertBefore(sh, root.firstElementChild); }
  return sh;
}
function connectsEl(page, create = true) {
  const root = page.xml.documentElement;
  let c = kid(root, "Connects");
  if (!c && create) { c = page.xml.createElementNS(VNS, "Connects"); const sh = kid(root, "Shapes"); root.insertBefore(c, sh ? sh.nextElementSibling : root.firstElementChild); }
  return c;
}
const ectx = (doc, page, model, S, over) => ({ doc, S, page, all: model.all, over: over || new Map(), memo: new Map() });

// ------------------------------------------------------------------ ricalcolo delle formule
const DEP_CELLS = ["LocPinX", "LocPinY", "TxtPinX", "TxtPinY", "TxtWidth", "TxtHeight", "TxtLocPinX", "TxtLocPinY", "TxtAngle", "ImgOffsetX", "ImgOffsetY", "ImgWidth", "ImgHeight"];
const DEP_SECTIONS = ["Geometry", "Connection", "Control", "User", "Scratch"];
const SKIP_F = /^(THEMEVAL|THEMEGUARD|_|NURBS|POLYLINE|No Formula)/i;
function effFormula(doc, S, rec) {
  if (!rec?.f) return null;
  if (rec.f !== "Inh") return rec.f;
  // formula ereditata: si cerca nel master la cella con la stessa posizione
  const n = rec.el.getAttribute("N"), row = rec.el.parentElement?.localName === "Row" ? rec.el.parentElement : null;
  for (let s = rec.from?.ms; s; s = s.ms) {
    let c;
    if (!row) c = kids(s.el, "Cell").find(x => x.getAttribute("N") === n);
    else {
      const sec = row.parentElement, isG = sec.getAttribute("N") === "Geometry";
      const se = kids(s.el, "Section").find(x => x.getAttribute("N") === sec.getAttribute("N") && (!isG || (x.getAttribute("IX") ?? "0") === (sec.getAttribute("IX") ?? "0")));
      const key = row.getAttribute("N") ?? "#" + row.getAttribute("IX");
      const r = se && kids(se, "Row").find(x => (x.getAttribute("N") ?? "#" + x.getAttribute("IX")) === key);
      c = r && kids(r, "Cell").find(x => x.getAttribute("N") === n);
    }
    if (c) { const f = c.getAttribute("F"); if (f !== "Inh") return f; }
  }
  return null;
}
// ricalcola le celle con formula della forma (dimensioni nuove in over) e scrive i valori cambiati;
// sx/sy: scala per le geometrie senza formule (disegni importati)
export function recompute(doc, page, model, S, over, sx = 1, sy = 1) {
  const ctx = ectx(doc, page, model, S, over);
  const eps = 1e-9;
  const write = (rec, v, put) => {
    const cur = parseFloat(rec?.v);
    if (Number.isFinite(cur) && Math.abs(cur - v) < eps && rec.from === S) return;
    put(v, rec && rec.from !== S ? (rec.f ? "Inh" : null) : undefined);
  };
  for (const n of DEP_CELLS) {
    const r = cell(doc, S, n);
    const f = effFormula(doc, S, r);
    if (!f || SKIP_F.test(f)) continue;
    try { const v = evalFormula(f, ctx); if (typeof v === "number") write(r, v, (x, F) => setCell(S.el, n, x, F)); } catch { /* formula non valutabile: resta il valore */ }
  }
  for (const sec of DEP_SECTIONS) {
    if (sec === "Geometry") {
      const G = geometry(doc, S);
      const anyF = G.some(g => g.rows.some(r => [...r.cells.values()].some(c => c.f)));
      for (const g of G) for (const r of g.rows) for (const [n, c] of r.cells) {
        if (!/^[XYABCD]$/.test(n)) continue;
        const f = effFormula(doc, S, c);
        let v = null;
        if (f && !SKIP_F.test(f)) { try { const x = evalFormula(f, ctx); if (typeof x === "number") v = x; } catch { /* */ } }
        else if (!anyF && (sx !== 1 || sy !== 1) && !r.T.startsWith("Rel")) {
          const old = parseFloat(c.v);
          if (!Number.isFinite(old)) continue;
          if (n === "X" || ((n === "A" || n === "C") && r.T !== "EllipticalArcTo" && r.T !== "ArcTo") || (n === "A" && r.T === "EllipticalArcTo")) v = old * sx;
          else if (n === "Y" || ((n === "B" || n === "D") && r.T !== "EllipticalArcTo") || (n === "B" && r.T === "EllipticalArcTo")) v = old * sy;
          else if (n === "D" && r.T === "EllipticalArcTo") v = old * sx / sy;
          else if (n === "A" && r.T === "ArcTo") v = old * Math.sqrt(sx * sy);
          if (r.T === "Ellipse" && (n === "A" || n === "C")) v = old * sx;
          if (r.T === "Ellipse" && (n === "B" || n === "D")) v = old * sy;
        }
        if (v == null) continue;
        write(c, v, (x, F) => setRowCell(S.el, "Geometry", g.ix, r.key, r.T, n, x, F));
      }
      continue;
    }
    for (const r of section(doc, S, sec).values()) for (const [n, c] of r.cells) {
      const f = effFormula(doc, S, c);
      let v = null;
      if (f && !SKIP_F.test(f)) { try { const x = evalFormula(f, ctx); if (typeof x === "number") v = x; } catch { /* */ } }
      else if (sec === "Connection" && !f && (sx !== 1 || sy !== 1)) { const old = parseFloat(c.v); if (n === "X") v = old * sx; else if (n === "Y") v = old * sy; }
      if (v == null || (sec === "User" && typeof v !== "number")) continue;
      write(c, v, (x, F) => setRowCell(S.el, sec, null, r.key, r.T, n, x, F));
    }
  }
}

// le forme di un gruppo che esistono solo nel master diventano forme del file (come fa Visio quando le cambia)
export function materialize(doc, page, S) {
  if (!S.el || !S.children.length || S.children.every(c => c.el)) return;
  let id = nextId(page);
  const mk = (C, parentEl) => {
    if (C.el) return;
    let sh = kid(parentEl, "Shapes");
    if (!sh) { sh = page.xml.createElementNS(VNS, "Shapes"); parentEl.append(sh); }
    const e = page.xml.createElementNS(VNS, "Shape");
    e.setAttribute("ID", String(id++));
    e.setAttribute("Type", C.ms?.el?.getAttribute("Type") || "Shape");
    e.setAttribute("MasterShape", C.ms.id);
    sh.append(e);
    C.el = e; C.id = e.getAttribute("ID");
    for (const k of C.children) mk(k, e);
  };
  for (const C of S.children) mk(C, S.el);
}

// ------------------------------------------------------------------ spostare, ridimensionare, ruotare
function setV(doc, page, model, S, name, v, over) { setSmart(doc, S, name, v, ectx(doc, page, model, S, over)); }

export function moveShapes(doc, page, model, list, dx, dy) {
  const ids = new Set(list.map(S => S.id));
  for (const S of list) {
    if (is1D(doc, S)) {
      const over = new Map();
      for (const [n, d] of [["BeginX", dx], ["EndX", dx], ["BeginY", dy], ["EndY", dy], ["PinX", dx], ["PinY", dy]]) over.set(S.id + "|" + n, num0(doc, S, n) + d);
      for (const n of ["BeginX", "BeginY", "EndX", "EndY", "PinX", "PinY"]) setCell(S.el, n, over.get(S.id + "|" + n), undefined);
      // un connettore spostato da solo si stacca dalle forme a cui era incollato
      for (const c of model.connects) if (c.from === S.id && !ids.has(c.to)) unglue(doc, page, S, c.fromCell);
    } else {
      setCell(S.el, "PinX", num0(doc, S, "PinX") + dx, null);
      setCell(S.el, "PinY", num0(doc, S, "PinY") + dy, null);
    }
  }
  markDirty(doc, page.path);
}
// riquadro locale nuovo [x0,y0,x1,y1] (coordinate locali attuali della forma)
export function resizeShape(doc, page, model, S, box) {
  const W0 = num0(doc, S, "Width"), H0 = num0(doc, S, "Height");
  const W = Math.max(1e-4, box[2] - box[0]), H = Math.max(1e-4, box[3] - box[1]);
  const M0 = localXf(doc, S);
  materialize(doc, page, S);
  const over = new Map([[S.id + "|Width", W], [S.id + "|Height", H]]);
  setV(doc, page, model, S, "Width", W, over);
  setV(doc, page, model, S, "Height", H, over);
  const sx = W0 ? W / W0 : 1, sy = H0 ? H / H0 : 1;
  recompute(doc, page, model, S, over, sx, sy);
  const lx = num0(doc, S, "LocPinX"), ly = num0(doc, S, "LocPinY");
  const p = ap(M0, box[0] + lx, box[1] + ly);
  setCell(S.el, "PinX", p[0], null);
  setCell(S.el, "PinY", p[1], null);
  resizeChildren(doc, page, model, S, sx, sy, over);
  markDirty(doc, page.path);
}
function resizeChildren(doc, page, model, G, sx, sy, over) {
  if (sx === 1 && sy === 1) return;
  for (const C of G.children) {
    if (!C.el) continue;
    const ctx = ectx(doc, page, model, C, over);
    const get = n => { const r = cell(doc, C, n), f = effFormula(doc, C, r); if (f && !SKIP_F.test(f)) { try { const v = evalFormula(f, ctx); if (typeof v === "number") return { v, f: true }; } catch { /* */ } } return { v: num0(doc, C, n), f: false }; };
    if (is1D(doc, C)) {
      for (const [n, k] of [["BeginX", sx], ["EndX", sx], ["BeginY", sy], ["EndY", sy]]) { const r = get(n); setCell(C.el, n, r.f ? r.v : r.v * k, undefined); }
      continue;
    }
    const pw = get("Width"), ph = get("Height"), px = get("PinX"), py = get("PinY");
    const W = pw.f ? pw.v : pw.v * sx, H = ph.f ? ph.v : ph.v * sy;
    const cw = num0(doc, C, "Width"), ch = num0(doc, C, "Height");
    const o2 = new Map([...over, [C.id + "|Width", W], [C.id + "|Height", H]]);
    setV(doc, page, model, C, "Width", W, o2);
    setV(doc, page, model, C, "Height", H, o2);
    setCell(C.el, "PinX", px.f ? px.v : px.v * sx, px.f ? undefined : null);
    setCell(C.el, "PinY", py.f ? py.v : py.v * sy, py.f ? undefined : null);
    const csx = cw ? W / cw : 1, csy = ch ? H / ch : 1;
    recompute(doc, page, model, C, o2, csx, csy);
    resizeChildren(doc, page, model, C, csx, csy, o2);
  }
}
export function rotateShape(doc, page, S, angle) {
  setCell(S.el, "Angle", angle, null);
  markDirty(doc, page.path);
}
export function rotateAround(doc, page, list, da) {
  // rotazione del gruppo selezionato attorno al centro comune (Ctrl+L / Ctrl+R)
  const b = bounds(doc, list), cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  const c = Math.cos(da), s = Math.sin(da);
  const rot = (x, y) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c];
  for (const S of list) {
    if (is1D(doc, S)) {
      const b0 = rot(num0(doc, S, "BeginX"), num0(doc, S, "BeginY")), e0 = rot(num0(doc, S, "EndX"), num0(doc, S, "EndY"));
      setEndpoints(doc, page, null, S, b0, e0);
      continue;
    }
    const p = rot(num0(doc, S, "PinX"), num0(doc, S, "PinY"));
    setCell(S.el, "PinX", p[0], null); setCell(S.el, "PinY", p[1], null);
    setCell(S.el, "Angle", num0(doc, S, "Angle") + da, null);
  }
  markDirty(doc, page.path);
}
export function flipShapes(doc, page, list, axis) {
  for (const S of list) { const n = axis === "x" ? "FlipX" : "FlipY"; setCell(S.el, n, num0(doc, S, n) ? 0 : 1, null); }
  markDirty(doc, page.path);
}

// ------------------------------------------------------------------ connettori
export const isDynamic = (doc, S) => {
  const nm = (S.master?.nameU || "") + " " + (S.el?.getAttribute("NameU") || "");
  return /dynamic connector|connettore dinamico/i.test(nm) || /_WALKGLUE/.test(cell(doc, S, "BeginX")?.f || "") || (cell(doc, S, "BeginX")?.f === "Inh" && /dynamic/i.test(S.master?.nameU || ""));
};
function unglue(doc, page, S, fromCell) {
  const ce = connectsEl(page, false);
  for (const c of kids(ce, "Connect")) if (c.getAttribute("FromSheet") === S.id && (!fromCell || c.getAttribute("FromCell") === fromCell)) c.remove();
  const trig = fromCell === "EndX" ? "EndTrigger" : fromCell === "BeginX" ? "BegTrigger" : null;
  for (const t of trig ? [trig] : ["BegTrigger", "EndTrigger"]) if (cell(doc, S, t)) setCell(S.el, t, 0, null);
}
export function glue(doc, page, conn, end, target, toCell = "PinX") {
  const fromCell = end === "begin" ? "BeginX" : "EndX";
  unglue(doc, page, conn, fromCell);
  if (!target) return;
  const ce = connectsEl(page);
  const c = page.xml.createElementNS(VNS, "Connect");
  c.setAttribute("FromSheet", conn.id); c.setAttribute("FromCell", fromCell); c.setAttribute("FromPart", end === "begin" ? "9" : "12");
  c.setAttribute("ToSheet", target.id); c.setAttribute("ToCell", toCell); c.setAttribute("ToPart", toCell === "PinX" ? "3" : String(100 + (+(/\d+$/.exec(toCell)?.[0] || 1) - 1)));
  ce.append(c);
  setCell(conn.el, end === "begin" ? "BegTrigger" : "EndTrigger", 2, `_XFTRIGGER(Sheet.${target.id}!EventXFMod)`);
  markDirty(doc, page.path);
}
// punti di connessione di una forma nella pagina, con la direzione di uscita
export function connPoints(doc, S) {
  const m = toPageM(doc, S), W = num0(doc, S, "Width"), H = num0(doc, S, "Height");
  const pts = [];
  for (const r of rowsOf(doc, S, "Connection")) {
    const x = parseFloat(r.cells.get("X")?.v) || 0, y = parseFloat(r.cells.get("Y")?.v) || 0;
    const p = ap(m, x, y);
    let dx = parseFloat(r.cells.get("DirX")?.v) || 0, dy = parseFloat(r.cells.get("DirY")?.v) || 0;
    if (!dx && !dy) { const l = [x, W - x, y, H - y], k = l.indexOf(Math.min(...l)); [dx, dy] = [[-1, 0], [1, 0], [0, -1], [0, 1]][k]; }
    const d = [m[0] * dx + m[2] * dy, m[1] * dx + m[3] * dy], L = Math.hypot(...d) || 1;
    pts.push({ p, dir: [d[0] / L, d[1] / L], cell: `Connections.X${(r.ix ?? 0) + 1}` });
  }
  return pts;
}
function sidePoints(doc, S) {
  const m = toPageM(doc, S), W = num0(doc, S, "Width"), H = num0(doc, S, "Height");
  const lin = d => { const v = [m[0] * d[0] + m[2] * d[1], m[1] * d[0] + m[3] * d[1]], L = Math.hypot(...v) || 1; return [v[0] / L, v[1] / L]; };
  return [[W / 2, 0, [0, -1]], [W, H / 2, [1, 0]], [W / 2, H, [0, 1]], [0, H / 2, [-1, 0]]].map(([x, y, d]) => ({ p: ap(m, x, y), dir: lin(d) }));
}
function centerOf(doc, S) { const m = toPageM(doc, S); return ap(m, num0(doc, S, "Width") / 2, num0(doc, S, "Height") / 2); }
// estremo del connettore incollato: punto e direzione
function gluePoint(doc, target, toCell, toward) {
  if (/^Connections\./.test(toCell)) {
    const p = connPoints(doc, target).find(q => q.cell === toCell.replace(/^Connections\.Row_(\d+)\.X$/, (m, n) => `Connections.X${n}`) || q.cell === toCell);
    if (p) return p;
  }
  // incollaggio dinamico: il punto (di connessione o a meta' lato) piu' vicino all'altra estremita'
  let best = null, bd = Infinity;
  const cand = [...connPoints(doc, target), ...sidePoints(doc, target)];
  for (const q of cand) {
    const d = Math.hypot(q.p[0] - toward[0], q.p[1] - toward[1]) - 0.0001 * (q.dir[0] * (toward[0] - q.p[0]) + q.dir[1] * (toward[1] - q.p[1]));
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}
// percorso ad angoli retti tra due punti con le direzioni di uscita
export function elbow(p0, d0, p1, d1) {
  const H0 = Math.abs(d0[0]) >= Math.abs(d0[1]), H1 = Math.abs(d1[0]) >= Math.abs(d1[1]);
  const ext = 0.25;
  if (H0 && H1) {
    if (Math.abs(p0[1] - p1[1]) < 1e-6) return [p0, p1];
    let mx = (p0[0] + p1[0]) / 2;
    if (Math.sign(mx - p0[0]) !== Math.sign(d0[0]) && d0[0]) mx = p0[0] + d0[0] * ext;
    return [p0, [mx, p0[1]], [mx, p1[1]], p1];
  }
  if (!H0 && !H1) {
    if (Math.abs(p0[0] - p1[0]) < 1e-6) return [p0, p1];
    let my = (p0[1] + p1[1]) / 2;
    if (Math.sign(my - p0[1]) !== Math.sign(d0[1]) && d0[1]) my = p0[1] + d0[1] * ext;
    return [p0, [p0[0], my], [p1[0], my], p1];
  }
  return H0 ? [p0, [p1[0], p0[1]], p1] : [p0, [p0[0], p1[1]], p1];
}
// scrive estremi, posizione e geometria di un connettore (coordinate della pagina, connettore al primo livello)
export function setEndpoints(doc, page, model, S, b, e, route = null) {
  const over = new Map([[S.id + "|BeginX", b[0]], [S.id + "|BeginY", b[1]], [S.id + "|EndX", e[0]], [S.id + "|EndY", e[1]]]);
  for (const [n, v] of [["BeginX", b[0]], ["BeginY", b[1]], ["EndX", e[0]], ["EndY", e[1]]]) setCell(S.el, n, v, undefined);
  const dyn = isDynamic(doc, S);
  const pts = route || [b, e];
  const ctx = model ? ectx(doc, page, model, S, over) : { doc, S, page, all: new Map(), over, memo: new Map() };
  // la formula resta solo se, con i valori nuovi, da' lo stesso risultato
  const put = (n, v) => {
    over.set(S.id + "|" + n, v);
    const r = cell(doc, S, n), f = effFormula(doc, S, r);
    let F = null;
    if (f && !SKIP_F.test(f)) { try { const x = evalFormula(f, { ...ctx, memo: new Map() }); if (typeof x === "number" && Math.abs(x - v) < 1e-7) F = r.from === S ? r.f : "Inh"; } catch { /* non valutabile */ } }
    setCell(S.el, n, v, F);
  };
  if (dyn || pts.length > 2) {
    let W = e[0] - b[0], H = e[1] - b[1];
    if (Math.abs(W) < 1e-6) W = 0; if (Math.abs(H) < 1e-6) H = 0;
    put("Width", W); put("Height", H); put("LocPinX", W / 2); put("LocPinY", H / 2);
    put("PinX", (b[0] + e[0]) / 2); put("PinY", (b[1] + e[1]) / 2); put("Angle", 0);
    const loc = pts.map(p => [p[0] - b[0], p[1] - b[1]]);
    writeGeom(S, loc);
    // testo del connettore a meta' del percorso (punto di controllo TextPosition, come Visio)
    if (section(doc, S, "Control").has("TextPosition")) {
      let tot = 0;
      for (let i = 1; i < loc.length; i++) tot += Math.hypot(loc[i][0] - loc[i - 1][0], loc[i][1] - loc[i - 1][1]);
      let half = tot / 2, mid = loc[0];
      for (let i = 1; i < loc.length; i++) {
        const l = Math.hypot(loc[i][0] - loc[i - 1][0], loc[i][1] - loc[i - 1][1]);
        if (half <= l || i === loc.length - 1) { const k = l ? Math.min(1, half / l) : 0; mid = [loc[i - 1][0] + (loc[i][0] - loc[i - 1][0]) * k, loc[i - 1][1] + (loc[i][1] - loc[i - 1][1]) * k]; break; }
        half -= l;
      }
      setRowCell(S.el, "Control", null, "TextPosition", null, "X", mid[0], null);
      setRowCell(S.el, "Control", null, "TextPosition", null, "Y", mid[1], null);
      recompute(doc, page, model || { all: new Map() }, S, over);
    }
  } else {
    const dx = e[0] - b[0], dy = e[1] - b[1], L = Math.hypot(dx, dy);
    const ly = num0(doc, S, "LocPinY");
    put("Width", L); put("Angle", Math.atan2(dy, dx)); put("LocPinX", L / 2);
    put("PinX", (b[0] + e[0]) / 2); put("PinY", (b[1] + e[1]) / 2);
    const G = geometry(doc, S);
    const simple = G.length === 1 && G[0].rows.length === 2;
    if (simple || !G.length) writeGeom(S, [[0, ly], [L, ly]]);
    else recompute(doc, page, model || { all: new Map() }, S, over);
  }
  if (page) markDirty(doc, page.path);
}
function writeGeom(S, pts) {
  const d = S.el.ownerDocument;
  for (const se of kids(S.el, "Section")) if (se.getAttribute("N") === "Geometry" && (se.getAttribute("IX") ?? "0") === "0") se.remove();
  const se = d.createElementNS(VNS, "Section");
  se.setAttribute("N", "Geometry"); se.setAttribute("IX", "0");
  const cellE = (n, v) => { const c = d.createElementNS(VNS, "Cell"); c.setAttribute("N", n); c.setAttribute("V", fmt(v)); return c; };
  for (const [n, v] of [["NoFill", 1], ["NoLine", 0], ["NoShow", 0], ["NoSnap", 0], ["NoQuickDrag", 0]]) se.append(cellE(n, v));
  pts.forEach((p, i) => {
    const r = d.createElementNS(VNS, "Row");
    r.setAttribute("T", i ? "LineTo" : "MoveTo"); r.setAttribute("IX", String(i + 1));
    r.append(cellE("X", p[0]), cellE("Y", p[1]));
    se.append(r);
  });
  // righe del master oltre quelle scritte: cancellate (come fa Visio)
  const inh = S.ms ? kids(S.ms.el, "Section").find(x => x.getAttribute("N") === "Geometry" && (x.getAttribute("IX") ?? "0") === "0") : null;
  if (inh) for (const r of kids(inh, "Row")) { const ix = +r.getAttribute("IX"); if (ix > pts.length) { const del = d.createElementNS(VNS, "Row"); del.setAttribute("T", r.getAttribute("T") || "LineTo"); del.setAttribute("IX", String(ix)); del.setAttribute("Del", "1"); se.append(del); } }
  const before = kids(S.el, "Section")[0] || kid(S.el, "Text") || kid(S.el, "ForeignData") || kid(S.el, "Shapes") || null;
  S.el.insertBefore(se, before);
  invalidate(S.el);
}
// ricalcola i connettori incollati alle forme indicate (dopo spostamenti e ridimensionamenti)
export function rerouteFor(doc, page, model, movedIds, skip = new Set()) {
  const done = new Set();
  for (const c of model.connects) {
    if (!movedIds.has(c.to) || skip.has(c.from) || done.has(c.from)) continue;
    const S = model.all.get(c.from);
    if (!S?.el || S.parent) continue;
    done.add(c.from);
    reroute(doc, page, model, S);
  }
}
export function reroute(doc, page, model, S) {
  const cs = model.connects.filter(c => c.from === S.id);
  const bc = cs.find(c => c.fromCell === "BeginX"), ec = cs.find(c => c.fromCell === "EndX");
  let b = [num0(doc, S, "BeginX"), num0(doc, S, "BeginY")], e = [num0(doc, S, "EndX"), num0(doc, S, "EndY")];
  const bt = bc && model.all.get(bc.to), et = ec && model.all.get(ec.to);
  const towardB = et ? centerOf(doc, et) : e, towardE = bt ? centerOf(doc, bt) : b;
  let bd = null, ed = null;
  if (bt) { const g = gluePoint(doc, bt, bc.toCell, towardB); if (g) { b = g.p; bd = g.dir; } }
  if (et) { const g = gluePoint(doc, et, ec.toCell, towardE); if (g) { e = g.p; ed = g.dir; } }
  if (bt && et && bc.toCell === "PinX" && ec.toCell === "PinX") {
    // entrambe dinamiche: lati scelti in base alla posizione relativa
    const cb = centerOf(doc, bt), ce = centerOf(doc, et);
    const horiz = Math.abs(ce[0] - cb[0]) >= Math.abs(ce[1] - cb[1]);
    const pick = (T, toward) => { const sp = sidePoints(doc, T); const want = horiz ? [Math.sign(toward[0] - centerOf(doc, T)[0]) || 1, 0] : [0, Math.sign(toward[1] - centerOf(doc, T)[1]) || 1]; let best = sp[0], bv = -Infinity; for (const q of sp) { const v = q.dir[0] * want[0] + q.dir[1] * want[1]; if (v > bv) { bv = v; best = q; } } return best; };
    const qb = pick(bt, ce), qe = pick(et, cb);
    b = qb.p; bd = qb.dir; e = qe.p; ed = qe.dir;
  }
  const dyn = isDynamic(doc, S);
  const straight = num0(doc, S, "ShapeRouteStyle") === 16 || num0(doc, S, "ConLineRouteExt") === 2;
  let route = null;
  if (dyn && !straight) route = elbow(b, bd || dirToward(b, e), e, ed || dirToward(e, b));
  setEndpoints(doc, page, model, S, b, e, route);
}
const dirToward = (a, b) => Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? [Math.sign(b[0] - a[0]) || 1, 0] : [0, Math.sign(b[1] - a[1]) || 1];

// ------------------------------------------------------------------ forme nuove
const C = (d, n, v, f, u) => { const c = d.createElementNS(VNS, "Cell"); c.setAttribute("N", n); c.setAttribute("V", fmt(v)); if (f) c.setAttribute("F", f); if (u) c.setAttribute("U", u); return c; };
function sectionE(d, n, ix) { const s = d.createElementNS(VNS, "Section"); s.setAttribute("N", n); if (ix != null) s.setAttribute("IX", String(ix)); return s; }
function rowE(d, T, ix, n) { const r = d.createElementNS(VNS, "Row"); if (T) r.setAttribute("T", T); if (ix != null) r.setAttribute("IX", String(ix)); if (n) r.setAttribute("N", n); return r; }
export function themeColors(doc) {
  const a1 = doc.theme.colors.accent1 || "#5b9bd5";
  const n = parseInt(a1.slice(1), 16), dk = k => "#" + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(x => Math.round(x * k).toString(16).padStart(2, "0")).join("");
  return { fill: a1, line: dk(0.72), text: "#ffffff" };
}
// forma 2D dello stencil (def da vsdshapes.js) con il centro in (x, y)
export function createShape(doc, page, model, def, x, y, opts = {}) {
  const d = page.xml;
  const W = opts.w ?? def.w, H = opts.h ?? def.h;
  const id = nextId(page);
  const el = d.createElementNS(VNS, "Shape");
  el.setAttribute("ID", String(id));
  el.setAttribute("NameU", def.nameU || def.name); el.setAttribute("Name", def.name);
  el.setAttribute("Type", "Shape");
  for (const a of ["LineStyle", "FillStyle", "TextStyle"]) el.setAttribute(a, "0");
  const tc = themeColors(doc);
  const textOnly = !!def.textOnly;
  for (const c of [C(d, "PinX", x), C(d, "PinY", y), C(d, "Width", W), C(d, "Height", H), C(d, "LocPinX", W / 2, "Width*0.5"), C(d, "LocPinY", H / 2, "Height*0.5"), C(d, "Angle", 0), C(d, "FlipX", 0), C(d, "FlipY", 0), C(d, "ResizeMode", 0),
    C(d, "LineWeight", 0.75 * PT, null, "PT"), C(d, "LineColor", opts.line || tc.line), C(d, "LinePattern", textOnly ? 0 : 1), C(d, "LineCap", 0), C(d, "BeginArrow", 0), C(d, "EndArrow", 0),
    C(d, "FillForegnd", opts.fill || tc.fill), C(d, "FillBkgnd", "#ffffff"), C(d, "FillPattern", textOnly ? 0 : 1), C(d, "FillForegndTrans", 0), C(d, "ShdwPattern", 0),
    C(d, "LeftMargin", 4 * PT, null, "PT"), C(d, "RightMargin", 4 * PT, null, "PT"), C(d, "TopMargin", 4 * PT, null, "PT"), C(d, "BottomMargin", 4 * PT, null, "PT"), C(d, "VerticalAlign", 1), C(d, "TextBkgnd", 0)])
    el.append(c);
  const ch = sectionE(d, "Character"), r0 = rowE(d, null, 0);
  r0.append(C(d, "Font", "Calibri"), C(d, "Color", textOnly ? "#000000" : opts.text || tc.text), C(d, "Style", 0), C(d, "Size", (opts.size || 11) * PT, null, "PT"));
  ch.append(r0); el.append(ch);
  const pa = sectionE(d, "Paragraph"), p0 = rowE(d, null, 0);
  p0.append(C(d, "HorzAlign", 1), C(d, "SpLine", -1.2)); pa.append(p0); el.append(pa);
  if (!textOnly) {
    const cn = sectionE(d, "Connection");
    [["Width*0.5", "Height*0", 0, -1], ["Width*1", "Height*0.5", 1, 0], ["Width*0.5", "Height*1", 0, 1], ["Width*0", "Height*0.5", -1, 0]].forEach(([fx, fy, dx, dy], i) => {
      const r = rowE(d, "Connection", i);
      r.append(C(d, "X", 0, fx), C(d, "Y", 0, fy), C(d, "DirX", dx), C(d, "DirY", dy), C(d, "Type", 0), C(d, "AutoGen", 0));
      cn.append(r);
    });
    el.append(cn);
  }
  const secs = !def.geom?.length ? [] : Array.isArray(def.geom[0]) ? [{ rows: def.geom }] : def.geom;
  secs.forEach((g, gi) => {
    const se = sectionE(d, "Geometry", gi);
    se.append(C(d, "NoFill", g.noFill ? 1 : 0), C(d, "NoLine", g.noLine ? 1 : 0), C(d, "NoShow", 0), C(d, "NoSnap", 0), C(d, "NoQuickDrag", 0));
    g.rows.forEach(([T, cells], ri) => {
      const r = rowE(d, T, ri + 1);
      for (const [n, f] of Object.entries(cells)) { const isNum = typeof f === "number" || /^-?[\d.]+$/.test(String(f)); r.append(C(d, n, isNum ? +f : 0, isNum ? null : String(f))); }
      se.append(r);
    });
    el.append(se);
  });
  if (opts.textValue ?? def.text) { const t = d.createElementNS(VNS, "Text"); t.textContent = opts.textValue ?? def.text; el.append(t); }
  shapesEl(page).append(el);
  const S = { el, ms: null, parent: null, id: String(id), page, master: null, children: [] };
  model.all.set(S.id, S);
  recompute(doc, page, model, S, new Map([[S.id + "|Width", W], [S.id + "|Height", H]]));
  markDirty(doc, page.path);
  return S;
}
// connettore (dinamico, linea o freccia) da b a e, incollato a startShape / endShape se indicate
export function createConnector(doc, page, model, kind, b, e, startShape = null, endShape = null) {
  const d = page.xml;
  const id = nextId(page);
  const el = d.createElementNS(VNS, "Shape");
  el.setAttribute("ID", String(id));
  const dyn = kind === "dynamic";
  el.setAttribute("NameU", dyn ? "Dynamic connector" : "Line"); el.setAttribute("Name", dyn ? "Connettore dinamico" : kind === "arrow" ? "Freccia" : "Linea");
  el.setAttribute("Type", "Shape");
  for (const a of ["LineStyle", "FillStyle", "TextStyle"]) el.setAttribute(a, "0");
  const tc = themeColors(doc);
  const W = e[0] - b[0], H = e[1] - b[1];
  const cells = dyn ? [C(d, "PinX", (b[0] + e[0]) / 2, "GUARD((BeginX+EndX)/2)"), C(d, "PinY", (b[1] + e[1]) / 2, "GUARD((BeginY+EndY)/2)"), C(d, "Width", W, "GUARD(EndX-BeginX)"), C(d, "Height", H, "GUARD(EndY-BeginY)"),
    C(d, "LocPinX", W / 2, "GUARD(Width*0.5)"), C(d, "LocPinY", H / 2, "GUARD(Height*0.5)"), C(d, "Angle", 0, "GUARD(0DA)"), C(d, "FlipX", 0, "GUARD(FALSE)"), C(d, "FlipY", 0, "GUARD(FALSE)"),
    C(d, "BeginX", b[0], "_WALKGLUE(BegTrigger,EndTrigger,WalkPreference)"), C(d, "BeginY", b[1], "_WALKGLUE(BegTrigger,EndTrigger,WalkPreference)"), C(d, "EndX", e[0], "_WALKGLUE(EndTrigger,BegTrigger,WalkPreference)"), C(d, "EndY", e[1], "_WALKGLUE(EndTrigger,BegTrigger,WalkPreference)"),
    C(d, "BegTrigger", 0), C(d, "EndTrigger", 0), C(d, "ObjType", 2), C(d, "ShapeRouteStyle", 0), C(d, "ConLineRouteExt", 1), C(d, "ShapePlowCode", 0), C(d, "GlueType", 2)]
    : [C(d, "PinX", (b[0] + e[0]) / 2, "(BeginX+EndX)/2"), C(d, "PinY", (b[1] + e[1]) / 2, "(BeginY+EndY)/2"), C(d, "Width", Math.hypot(W, H), "SQRT((EndX-BeginX)^2+(EndY-BeginY)^2)"), C(d, "Height", 0),
      C(d, "LocPinX", Math.hypot(W, H) / 2, "Width*0.5"), C(d, "LocPinY", 0, "Height*0.5"), C(d, "Angle", Math.atan2(H, W), "ATAN2(EndY-BeginY,EndX-BeginX)"), C(d, "FlipX", 0), C(d, "FlipY", 0),
      C(d, "BeginX", b[0]), C(d, "BeginY", b[1]), C(d, "EndX", e[0]), C(d, "EndY", e[1]), C(d, "ObjType", 2)];
  for (const c of [...cells, C(d, "LineWeight", (dyn ? 0.75 : 1) * PT, null, "PT"), C(d, "LineColor", dyn ? tc.line : "#000000"), C(d, "LinePattern", 1), C(d, "LineCap", 0), C(d, "Rounding", 0),
    C(d, "BeginArrow", 0), C(d, "EndArrow", kind === "line" ? 0 : 13), C(d, "BeginArrowSize", 2), C(d, "EndArrowSize", 2), C(d, "FillPattern", 0), C(d, "TextBkgnd", "#ffffff"), C(d, "VerticalAlign", 1),
    C(d, "LeftMargin", 2 * PT, null, "PT"), C(d, "RightMargin", 2 * PT, null, "PT"), C(d, "TopMargin", 2 * PT, null, "PT"), C(d, "BottomMargin", 2 * PT, null, "PT")]) el.append(c);
  if (dyn) {
    // testo al centro del percorso (punto di controllo TextPosition, come i connettori di Visio)
    for (const c of [C(d, "TxtPinX", W / 2, "Controls.TextPosition"), C(d, "TxtPinY", H / 2, "Controls.TextPosition.Y"), C(d, "TxtWidth", 1, "MAX(TEXTWIDTH(TheText),5*Char.Size)"), C(d, "TxtHeight", 0.25, "TEXTHEIGHT(TheText,TxtWidth)"), C(d, "TxtLocPinX", 0.5, "TxtWidth*0.5"), C(d, "TxtLocPinY", 0.125, "TxtHeight*0.5")]) el.append(c);
    const ctl = sectionE(d, "Control"), r = rowE(d, null, null, "TextPosition");
    r.append(C(d, "X", W / 2), C(d, "Y", H / 2), C(d, "XDyn", W / 2, "Controls.TextPosition"), C(d, "YDyn", H / 2, "Controls.TextPosition.Y"), C(d, "XCon", 5), C(d, "YCon", 0), C(d, "CanGlue", 0), C(d, "Prompt", "Riposiziona testo"));
    ctl.append(r); el.append(ctl);
  }
  const ch = sectionE(d, "Character"), r0 = rowE(d, null, 0);
  r0.append(C(d, "Font", "Calibri"), C(d, "Color", "#000000"), C(d, "Style", 0), C(d, "Size", 9 * PT, null, "PT"));
  ch.append(r0); el.append(ch);
  shapesEl(page).append(el);
  const S = { el, ms: null, parent: null, id: String(id), page, master: null, children: [] };
  model.all.set(S.id, S);
  writeGeom(S, [[0, 0], [W, H]].map((p, i) => dyn ? p : i ? [Math.hypot(W, H), 0] : [0, 0]));
  if (startShape) glue(doc, page, S, "begin", startShape);
  if (endShape) glue(doc, page, S, "end", endShape);
  markDirty(doc, page.path);
  return S;
}
// istanza di un master del documento (come trascinare una forma da "Forme del documento" in Visio)
export function createInstance(doc, page, model, M, x, y) {
  const d = page.xml;
  let id = nextId(page);
  const el = d.createElementNS(VNS, "Shape");
  el.setAttribute("ID", String(id++));
  el.setAttribute("NameU", M.nameU || M.name); el.setAttribute("Name", M.name);
  el.setAttribute("Type", M.top.length === 1 ? (M.top[0].el.getAttribute("Type") || "Shape") : "Group");
  el.setAttribute("Master", M.id);
  if (M.top.length === 1) {
    el.append(C(d, "PinX", x), C(d, "PinY", y));
    const add = (src, parent) => {
      if (!src.children.length) return;
      const sh = d.createElementNS(VNS, "Shapes");
      for (const c of src.children) { const e = d.createElementNS(VNS, "Shape"); e.setAttribute("ID", String(id++)); e.setAttribute("Type", c.el.getAttribute("Type") || "Shape"); e.setAttribute("MasterShape", c.id); sh.append(e); add(c, e); }
      parent.append(sh);
    };
    add(M.top[0], el);
  } else {
    // master con piu' forme: gruppo che le contiene
    const tmp = { el: null, children: M.top };
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const S of M.top) { const W = parseFloat(kids(S.el, "Cell").find(c => c.getAttribute("N") === "Width")?.getAttribute("V")) || 0, H = parseFloat(kids(S.el, "Cell").find(c => c.getAttribute("N") === "Height")?.getAttribute("V")) || 0; const px = parseFloat(kids(S.el, "Cell").find(c => c.getAttribute("N") === "PinX")?.getAttribute("V")) || 0, py = parseFloat(kids(S.el, "Cell").find(c => c.getAttribute("N") === "PinY")?.getAttribute("V")) || 0; box[0] = Math.min(box[0], px - W / 2); box[1] = Math.min(box[1], py - H / 2); box[2] = Math.max(box[2], px + W / 2); box[3] = Math.max(box[3], py + H / 2); }
    void tmp;
    const W = box[2] - box[0], H = box[3] - box[1];
    el.append(C(d, "PinX", x), C(d, "PinY", y), C(d, "Width", W), C(d, "Height", H), C(d, "LocPinX", W / 2, "Width*0.5"), C(d, "LocPinY", H / 2, "Height*0.5"));
    const sh = d.createElementNS(VNS, "Shapes");
    for (const c of M.top) { const e = d.createElementNS(VNS, "Shape"); e.setAttribute("ID", String(id++)); e.setAttribute("Type", c.el.getAttribute("Type") || "Shape"); e.setAttribute("MasterShape", c.id); const px = parseFloat(kids(c.el, "Cell").find(q => q.getAttribute("N") === "PinX")?.getAttribute("V")) || 0, py = parseFloat(kids(c.el, "Cell").find(q => q.getAttribute("N") === "PinY")?.getAttribute("V")) || 0; e.append(C(d, "PinX", px - box[0]), C(d, "PinY", py - box[1])); sh.append(e); }
    el.append(sh);
  }
  shapesEl(page).append(el);
  markDirty(doc, page.path);
  return el.getAttribute("ID");
}
// immagine inserita (Inserisci > Immagini): forma "Foreign" con la parte immagine del pacchetto
export function createImage(doc, page, model, rid, x, y, w, h) {
  const d = page.xml;
  const id = nextId(page);
  const el = d.createElementNS(VNS, "Shape");
  el.setAttribute("ID", String(id)); el.setAttribute("NameU", "Picture"); el.setAttribute("Name", "Immagine"); el.setAttribute("Type", "Foreign");
  for (const a of ["LineStyle", "FillStyle", "TextStyle"]) el.setAttribute(a, "0");
  for (const c of [C(d, "PinX", x), C(d, "PinY", y), C(d, "Width", w), C(d, "Height", h), C(d, "LocPinX", w / 2, "Width*0.5"), C(d, "LocPinY", h / 2, "Height*0.5"), C(d, "Angle", 0), C(d, "FlipX", 0), C(d, "FlipY", 0),
    C(d, "ImgOffsetX", 0, "ImgWidth*0"), C(d, "ImgOffsetY", 0, "ImgHeight*0"), C(d, "ImgWidth", w, "Width*1"), C(d, "ImgHeight", h, "Height*1"), C(d, "LinePattern", 0), C(d, "FillPattern", 0), C(d, "ClippingPath", "")]) el.append(c);
  const fd = d.createElementNS(VNS, "ForeignData");
  fd.setAttribute("ForeignType", "Bitmap"); fd.setAttribute("CompressionType", /\.jpe?g$/i.test(rid.path) ? "JPEG" : "PNG");
  const rel = d.createElementNS(VNS, "Rel");
  rel.setAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "r:id", rid.rid);
  fd.append(rel); el.append(fd);
  shapesEl(page).append(el);
  markDirty(doc, page.path);
  return String(id);
}

// ------------------------------------------------------------------ testo
export function setText(doc, page, S, text) {
  const old = kid(S.el, "Text");
  const t = page.xml.createElementNS(VNS, "Text");
  const src = textEl(S);
  if (src) {
    const cp = [...src.childNodes].find(n => n.localName === "cp"), pp = [...src.childNodes].find(n => n.localName === "pp");
    if (cp) t.append(cp.cloneNode()); if (pp) t.append(pp.cloneNode());
  }
  if (text) t.append(page.xml.createTextNode(text.replace(/\r\n?/g, "\n")));
  if (old) old.replaceWith(t); else { const after = kid(S.el, "Data1") || kid(S.el, "Data2") || kid(S.el, "Data3") || kid(S.el, "ForeignData") || kid(S.el, "Shapes"); S.el.insertBefore(t, after); }
  markDirty(doc, page.path);
}

// ------------------------------------------------------------------ eliminare, ordine, gruppi
export function deleteShapes(doc, page, model, list) {
  const ids = new Set();
  const collect = S => { if (S.id) ids.add(S.id); S.children.forEach(collect); };
  list.forEach(collect);
  // come Visio: si eliminano anche i connettori incollati alle forme eliminate
  for (const c of model.connects) if (ids.has(c.to)) { const k = model.all.get(c.from); if (k && !k.parent && !ids.has(k.id)) { ids.add(k.id); list.push(k); } }
  for (const S of list) S.el?.remove();
  const ce = connectsEl(page, false);
  for (const c of kids(ce, "Connect")) if (ids.has(c.getAttribute("FromSheet")) || ids.has(c.getAttribute("ToSheet"))) c.remove();
  for (const c of model.connects) if (ids.has(c.to) && !ids.has(c.from)) { const k = model.all.get(c.from); if (k?.el) unglue(doc, page, k, c.fromCell); }
  if (ce && !ce.children.length) ce.remove();
  markDirty(doc, page.path);
}
export function zorder(doc, page, list, how) {
  for (const S of how === "front" || how === "backward" ? list : [...list].reverse()) {
    const p = S.el.parentElement;
    if (how === "front") p.append(S.el);
    else if (how === "back") p.insertBefore(S.el, p.firstElementChild);
    else if (how === "forward") { const n = S.el.nextElementSibling; if (n) p.insertBefore(n, S.el); }
    else if (how === "backward") { const n = S.el.previousElementSibling; if (n) p.insertBefore(S.el, n); }
  }
  markDirty(doc, page.path);
}
export function groupShapes(doc, page, model, list) {
  const b = bounds(doc, list);
  const d = page.xml, id = nextId(page);
  const W = b[2] - b[0], H = b[3] - b[1];
  const g = d.createElementNS(VNS, "Shape");
  g.setAttribute("ID", String(id)); g.setAttribute("NameU", "Group"); g.setAttribute("Name", "Gruppo"); g.setAttribute("Type", "Group");
  for (const a of ["LineStyle", "FillStyle", "TextStyle"]) g.setAttribute(a, "0");
  for (const c of [C(d, "PinX", b[0] + W / 2), C(d, "PinY", b[1] + H / 2), C(d, "Width", W), C(d, "Height", H), C(d, "LocPinX", W / 2, "Width*0.5"), C(d, "LocPinY", H / 2, "Height*0.5"), C(d, "Angle", 0), C(d, "FlipX", 0), C(d, "FlipY", 0), C(d, "ResizeMode", 0), C(d, "LinePattern", 0), C(d, "FillPattern", 0), C(d, "DisplayMode", 2)]) g.append(c);
  const sh = d.createElementNS(VNS, "Shapes");
  const ordered = [...list].sort((a, z) => (a.el.compareDocumentPosition(z.el) & 4 ? -1 : 1));
  const first = ordered[0].el;
  first.parentElement.insertBefore(g, first);
  for (const S of ordered) {
    for (const [n, k] of [["PinX", b[0]], ["PinY", b[1]], ["BeginX", b[0]], ["EndX", b[0]], ["BeginY", b[1]], ["EndY", b[1]]]) {
      const r = cell(doc, S, n);
      if (r && (n.startsWith("Pin") || is1D(doc, S))) setCell(S.el, n, parseFloat(r.v) - k, n.startsWith("Pin") ? (is1D(doc, S) ? undefined : null) : undefined);
    }
    sh.append(S.el);
  }
  g.append(sh);
  markDirty(doc, page.path);
  return String(id);
}
export function ungroupShapes(doc, page, model, G) {
  if (!G.el || G.el.getAttribute("Type") !== "Group") return [];
  materialize(doc, page, G);
  const m = localXf(doc, G), ga = num0(doc, G, "Angle"), out = [];
  const flip = (num0(doc, G, "FlipX") ? 1 : 0) ^ (num0(doc, G, "FlipY") ? 1 : 0);
  for (const S of G.children) {
    if (!S.el) continue;
    if (is1D(doc, S)) {
      const b = ap(m, num0(doc, S, "BeginX"), num0(doc, S, "BeginY")), e = ap(m, num0(doc, S, "EndX"), num0(doc, S, "EndY"));
      for (const [n, v] of [["BeginX", b[0]], ["BeginY", b[1]], ["EndX", e[0]], ["EndY", e[1]]]) setCell(S.el, n, v, undefined);
      const p = ap(m, num0(doc, S, "PinX"), num0(doc, S, "PinY"));
      setCell(S.el, "PinX", p[0], undefined); setCell(S.el, "PinY", p[1], undefined);
    } else {
      const p = ap(m, num0(doc, S, "PinX"), num0(doc, S, "PinY"));
      setCell(S.el, "PinX", p[0], null); setCell(S.el, "PinY", p[1], null);
      if (ga) setCell(S.el, "Angle", (flip ? -1 : 1) * num0(doc, S, "Angle") + ga, null);
    }
    G.el.parentElement.insertBefore(S.el, G.el);
    out.push(S.id);
  }
  G.el.remove();
  markDirty(doc, page.path);
  return out;
}

// ------------------------------------------------------------------ copia / incolla
export function copyShapes(doc, page, model, list) {
  const ser = new XMLSerializer();
  const ids = new Set();
  const collect = S => { if (S.id) ids.add(S.id); S.children.forEach(collect); };
  list.forEach(collect);
  return {
    doc, shapes: list.map(S => ser.serializeToString(S.el)),
    connects: model.connects.filter(c => ids.has(c.from) && ids.has(c.to)).map(c => ser.serializeToString(c.el)),
  };
}
export function pasteShapes(doc, page, clip, dx, dy) {
  const p = new DOMParser();
  let id = nextId(page);
  const map = new Map(), roots = [];
  for (const s of clip.shapes) {
    const x = p.parseFromString(`<W xmlns="${VNS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${s.replace(/^<Shape\b[^>]*?\sxmlns="[^"]*"/, m => m.replace(/\sxmlns="[^"]*"/, ""))}</W>`, "application/xml");
    const el = page.xml.importNode(x.documentElement.firstElementChild, true);
    for (const e of [el, ...el.getElementsByTagNameNS(VNS, "Shape")]) { const o = e.getAttribute("ID"); const n = String(id++); map.set(o, n); e.setAttribute("ID", n); }
    if (clip.doc !== doc) { for (const e of [el, ...el.getElementsByTagNameNS(VNS, "Shape")]) if (e.getAttribute("Master") && !doc.masters.has(e.getAttribute("Master"))) { e.removeAttribute("Master"); e.removeAttribute("MasterShape"); } }
    roots.push(el);
  }
  for (const el of roots) {
    for (const c of [el, ...el.getElementsByTagNameNS(VNS, "Cell")].filter(e => e.localName === "Cell")) {
      const f = c.getAttribute("F");
      if (f && /Sheet\.\d+!/.test(f)) c.setAttribute("F", f.replace(/Sheet\.(\d+)!/g, (m, n) => map.has(n) ? `Sheet.${map.get(n)}!` : m));
    }
    const cells = kids(el, "Cell");
    const g = n => cells.find(c => c.getAttribute("N") === n);
    for (const [n, d] of [["PinX", dx], ["PinY", dy], ["BeginX", dx], ["EndX", dx], ["BeginY", dy], ["EndY", dy]]) { const c = g(n); if (c) c.setAttribute("V", fmt(parseFloat(c.getAttribute("V")) + d)); }
    for (const n of ["PinX", "PinY"]) { const c = g(n); if (c && !g("BeginX")) c.removeAttribute("F"); }
    invalidate(el);
    shapesEl(page).append(el);
  }
  if (clip.connects.length) {
    const ce = connectsEl(page);
    for (const s of clip.connects) {
      const x = p.parseFromString(s.replace(/^<Connect\b/, `<Connect xmlns="${VNS}"`).replace(/(xmlns="[^"]*")\s+xmlns="[^"]*"/, "$1"), "application/xml");
      const c = page.xml.importNode(x.documentElement, true);
      c.setAttribute("FromSheet", map.get(c.getAttribute("FromSheet")) || c.getAttribute("FromSheet"));
      c.setAttribute("ToSheet", map.get(c.getAttribute("ToSheet")) || c.getAttribute("ToSheet"));
      ce.append(c);
    }
  }
  markDirty(doc, page.path);
  return roots.map(e => e.getAttribute("ID"));
}

// ------------------------------------------------------------------ formato
export function setCells(doc, page, list, cells) {
  for (const S of list) for (const [n, v] of Object.entries(cells)) setCell(S.el, n, v, null);
  markDirty(doc, page.path);
}
export function setFill(doc, page, list, c) {
  for (const S of list) {
    if (c == null) setCell(S.el, "FillPattern", 0, null);
    else { setCell(S.el, "FillForegnd", c, null); if (!num0(doc, S, "FillPattern", 1)) setCell(S.el, "FillPattern", 1, null); if (num0(doc, S, "FillGradientEnabled")) setCell(S.el, "FillGradientEnabled", 0, null); setCell(S.el, "FillForegndTrans", 0, null); }
  }
  markDirty(doc, page.path);
}
export function setLine(doc, page, list, o) {
  for (const S of list) {
    if (o.none) { setCell(S.el, "LinePattern", 0, null); continue; }
    if (o.color) { setCell(S.el, "LineColor", o.color, null); if (!num0(doc, S, "LinePattern", 1)) setCell(S.el, "LinePattern", 1, null); }
    if (o.weight != null) setCell(S.el, "LineWeight", o.weight, null, "PT");
    if (o.pattern != null) setCell(S.el, "LinePattern", o.pattern, null);
    if (o.beginArrow != null) setCell(S.el, "BeginArrow", o.beginArrow, null);
    if (o.endArrow != null) setCell(S.el, "EndArrow", o.endArrow, null);
  }
  markDirty(doc, page.path);
}
// carattere: { font, size (pt), color, b, i, u } su tutte le righe del testo
export function setChar(doc, page, list, o) {
  for (const S of list) {
    const rows = [...section(doc, S, "Character").values()];
    if (!rows.length) rows.push({ key: "#0", cells: new Map() });
    for (const R of rows) {
      const put = (n, v, u) => setRowCell(S.el, "Character", null, R.key, null, n, v, null, u);
      if (o.font) put("Font", o.font);
      if (o.size) put("Size", o.size * PT, "PT");
      if (o.dsize) put("Size", Math.max(1, (parseFloat(R.cells.get("Size")?.v) || 0.1667) * 72 + o.dsize) * PT, "PT");
      if (o.color) put("Color", o.color);
      if (o.b != null || o.i != null || o.u != null) {
        let st = parseInt(R.cells.get("Style")?.v) || 0;
        for (const [k, bit] of [["b", 1], ["i", 2], ["u", 4]]) if (o[k] != null) st = o[k] ? st | bit : st & ~bit;
        put("Style", st);
      }
    }
  }
  markDirty(doc, page.path);
}
export function setPara(doc, page, list, align) {
  for (const S of list) {
    const rows = [...section(doc, S, "Paragraph").values()];
    if (!rows.length) rows.push({ key: "#0" });
    for (const R of rows) setRowCell(S.el, "Paragraph", null, R.key, null, "HorzAlign", align, null);
  }
  markDirty(doc, page.path);
}
export function firstChar(doc, S) {
  const R = [...section(doc, S, "Character").values()][0];
  const st = parseInt(R?.cells.get("Style")?.v) || 0;
  const fv = R?.cells.get("Font")?.v;
  return { font: !fv || /^Themed$/i.test(fv) || /^\d+$/.test(fv) ? (doc.faces.get(String(fv)) || doc.theme.minor) : fv, size: Math.round((parseFloat(R?.cells.get("Size")?.v) || 0.1667) * 72 * 10) / 10, color: color(doc, R?.cells.get("Color")?.v ?? 0, "text"), b: !!(st & 1), i: !!(st & 2), u: !!(st & 4) };
}
export const firstAlign = (doc, S) => parseFloat([...section(doc, S, "Paragraph").values()][0]?.cells.get("HorzAlign")?.v ?? 1);

// ------------------------------------------------------------------ dati della forma (Shape Data)
const PROP_TYPES = { 0: "Stringa", 1: "Elenco fisso", 2: "Numero", 3: "Booleano", 4: "Elenco variabile", 5: "Data", 6: "Durata", 7: "Valuta" };
export function shapeData(doc, S) {
  return [...section(doc, S, "Property").values()].map(R => {
    const g = n => R.cells.get(n)?.v ?? "";
    return { key: R.key, label: g("Label") || R.n || R.key, value: g("Value"), type: +g("Type") || 0, typeName: PROP_TYPES[+g("Type") || 0], format: g("Format"), prompt: g("Prompt"), invisible: g("Invisible") === "1", unit: R.cells.get("Value")?.u };
  }).filter(p => !p.invisible);
}
export function setData(doc, page, S, key, value, type) {
  const isNum = type === 2 || type === 7 || type === 6;
  const v = isNum ? (parseFloat(String(value).replace(",", ".")) || 0) : type === 3 ? (value ? 1 : 0) : String(value);
  setRowCell(S.el, "Property", null, key, null, "Value", v, null, isNum || type === 3 ? (type === 3 ? "BOOL" : undefined) : "STR");
  markDirty(doc, page.path);
}
export function addData(doc, page, S, label, value) {
  const keys = new Set(section(doc, S, "Property").keys());
  let n = 1;
  while (keys.has("Row_" + n)) n++;
  const k = "Row_" + n;
  setRowCell(S.el, "Property", null, k, null, "Label", label, null);
  setRowCell(S.el, "Property", null, k, null, "Type", 0, null);
  setRowCell(S.el, "Property", null, k, null, "Value", value, null, "STR");
  markDirty(doc, page.path);
}

// ------------------------------------------------------------------ pagina e livelli
function pageSheet(page) { return kid(page.el, "PageSheet"); }
export function setPageSize(doc, page, W, H) {
  const ps = pageSheet(page);
  const u = kids(ps, "Cell").find(c => c.getAttribute("N") === "PageWidth")?.getAttribute("U") || "MM";
  setCell(ps, "PageWidth", W, null, u); setCell(ps, "PageHeight", H, null, u);
  if (ps && kids(ps, "Cell").some(c => c.getAttribute("N") === "PrintPageOrientation")) setCell(ps, "PrintPageOrientation", W > H ? 2 : 1, null);
  markDirty(doc, doc.pagesPath);
}
export function setLayer(doc, page, ix, prop, v) {
  const L = layersOf(doc, page).find(l => l.ix === ix);
  if (!L) return;
  let c = kids(L.row, "Cell").find(x => x.getAttribute("N") === prop);
  if (!c) { c = page.el.ownerDocument.createElementNS(VNS, "Cell"); c.setAttribute("N", prop); L.row.append(c); }
  c.setAttribute("V", v ? "1" : "0");
  markDirty(doc, doc.pagesPath);
}
export function addLayer(doc, page, name) {
  const ps = pageSheet(page), d = page.el.ownerDocument;
  let se = kids(ps, "Section").find(s => s.getAttribute("N") === "Layer");
  if (!se) { se = d.createElementNS(VNS, "Section"); se.setAttribute("N", "Layer"); ps.append(se); }
  const ix = Math.max(-1, ...kids(se, "Row").map(r => +r.getAttribute("IX"))) + 1;
  const r = d.createElementNS(VNS, "Row");
  r.setAttribute("IX", String(ix));
  for (const [n, v] of [["Name", name], ["Color", 255], ["Status", 0], ["Visible", 1], ["Print", 1], ["Active", 0], ["Lock", 0], ["Snap", 1], ["Glue", 1], ["NameUniv", name], ["ColorTrans", 0]]) r.append(C(d, n, v));
  se.append(r);
  invalidate(ps);
  markDirty(doc, doc.pagesPath);
  return String(ix);
}
export function setMembership(doc, page, list, ix, on) {
  for (const S of list) {
    const cur = String(cell(doc, S, "LayerMember")?.v || "").split(";").filter(Boolean);
    const next = on ? [...new Set([...cur, ix])] : cur.filter(x => x !== ix);
    setCell(S.el, "LayerMember", next.join(";"), null);
  }
  markDirty(doc, page.path);
}
export { pageInfo };
