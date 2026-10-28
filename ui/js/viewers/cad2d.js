// Disegni CAD 2D (DWG con libredwg, DXF con lettore interno): zoom/pan, layer, blocchi, testi, quote, misure, esportazione.
import { api, button, el, fileUrl, loading, readBytes, saveBlobAs, toast, withExt, WEB } from "../core.js";
import { createCadEditor } from "../cadedit.js";
import { parseDxf } from "../dxf.js";
import { I, TAU, R2D, mul, ap, apv, det, similar, arcPts, sweepPts, bulgeArc, bulgePts, splinePts, textLayout, patternDefLines, hatchSegments, dimGeom, dimTextEntity, osnap, drawSnapMarker } from "../cadgeom.js";
import { t as tr, LOCALE } from "../i18n.js";
import { INK_ICON, paint as paintInk, widthAt } from "../ink.js";
import { LAYER_PEN } from "../inkdxf.js";
import { pinchPan } from "../touch.js";
import { measureBtn, mbmisOf } from "../measure/mbutton.js";
import { isOn } from "../components.js";
import { analyze3d } from "../cad3dscan.js";


// ---------------------------------------------------------------- colori ACI
const ACI = (() => {
  const t = [[0, 0, 0], [255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255], [255, 255, 255], [128, 128, 128], [192, 192, 192]];
  const lv = [1, 0.65, 0.5, 0.3, 0.15];
  for (let i = 10; i < 250; i++) {
    const h = (Math.floor(i / 10) - 1) * 15, v = lv[Math.floor((i % 10) / 2)], s = i % 2 ? 0.5 : 1;
    const c = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    t.push([Math.round(c(5) * 255), Math.round(c(3) * 255), Math.round(c(1) * 255)]);
  }
  for (const g of [51, 91, 132, 173, 214, 255]) t.push([g, g, g]);
  return t;
})();
const rgb = c => `rgb(${c[0]},${c[1]},${c[2]})`;
const trueColor = n => [(n >> 16) & 255, (n >> 8) & 255, n & 255];

// ---------------------------------------------------------------- normalizzazione dei dati letti
// Spessori di linea DWG: indice -> centesimi di mm (29 = DaLayer, 30 = DaBlocco, 31 = predefinito)
const LW_DWG = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
const lwDwg = v => (v === 29 ? -1 : v === 30 ? -2 : v === 31 || v == null ? -3 : LW_DWG[v] ?? -3);
export function normalize(db, kind) {
  if (db._norm) return db;
  db._norm = true;
  const brs = db.tables.BLOCK_RECORD?.entries || [];
  const paper = new Set(brs.filter(b => b.handle && /^\*paper_space/i.test(b.name || "")).map(b => b.handle));
  const flat = e => {
    if ((e.type === "ATTRIB" || e.type === "ATTDEF") && e.text && typeof e.text === "object") { const t = e.text; delete e.text; Object.assign(e, t, { text: t.text }); }
    if (e.type === "ATTRIB" && (e.flags & 1)) e.isVisible = false;
    if (kind === "dwg") e.lineweight = lwDwg(e.lineweight);
    (e.attribs || []).forEach(flat);
  };
  const byHandle = new Map(db.entities.filter(e => e.handle).map(e => [e.handle, e]));
  const keep = [];
  for (const e of db.entities) {
    flat(e);
    if (paper.has(e.ownerBlockRecordSoftId)) e.isInPaperSpace = true;
    if (e.type === "ATTRIB") { // attributi rimasti fuori dal loro blocco (libredwg): si riattaccano all'inserimento
      const ins = byHandle.get(e.ownerBlockRecordSoftId);
      if (ins && ins.type === "INSERT") { ins.attribs ||= []; if (!ins.attribs.some(a => a.handle && a.handle === e.handle)) ins.attribs.push(e); continue; }
    }
    keep.push(e);
  }
  db.entities = keep;
  for (const b of brs) (b.entities || []).forEach(flat);
  if (kind === "dwg") for (const L of db.tables.LAYER?.entries || []) L.lineweight = lwDwg(L.lineweight);
  return db;
}

// ---------------------------------------------------------------- costruzione delle primitive
// Ogni entita' produce: tratti da disegnare (gruppi per layer/colore/tipo linea), testi impaginati, e "elementi" per
// selezione e aggancio: L linea, A arco, P polilinea tessellata, Q riquadro di testo, F area piena, N punto notevole.
// Ogni elemento ricorda l'entita' di primo livello (o) e il percorso dentro i blocchi (s: "/3/a1" ...).
function build(db) {
  const H = db.header || {};
  const LTS = H.LTSCALE > 0 ? H.LTSCALE : 1;
  const layers = new Map();
  for (const l of db.tables.LAYER.entries) layers.set(l.name, { name: l.name, aci: l.colorIndex, color: l.color, off: !!l.off || !!l.frozen, count: 0, lt: l.lineType || "", lw: l.lineweight ?? -3 });
  const blocks = new Map();
  for (const b of db.tables.BLOCK_RECORD.entries) blocks.set(b.name, b);
  const ltypes = new Map();
  for (const t of db.tables.LTYPE?.entries || []) {
    const pat = (t.pattern || []).map(p => +p.elementLength || 0);
    if (pat.length && pat.some(v => v)) ltypes.set(String(t.name).toLowerCase(), pat);
  }
  const groups = new Map(), texts = [], items = [], ents = [];
  // per le misure (ui/js/measure/mcad.js): contorni chiusi, retini e inserimenti di blocchi con layer, colore e tipo linea
  const closedL = [], hatches = [], inserts = [];
  let owner = -1, sub = "", curSt = null;
  const xs = [], ys = [];

  const layerOf = n => { if (!layers.has(n)) layers.set(n, { name: n, aci: 7, off: false, count: 0, lt: "", lw: -3 }); return layers.get(n); };
  const colorOf = (e, L, inherited) => {
    if (e.colorIndex === undefined && typeof e.color === "number") return trueColor(e.color);
    if (typeof e.color === "number" && e.color > 0 && e.colorIndex !== 0 && e.colorIndex !== 256) return trueColor(e.color);
    const ci = e.colorIndex ?? 256;
    if (ci === 0) return inherited || [255, 255, 255];
    if (ci === 256 || ci < 0) return L.color !== undefined && L.color > 0 && !L.aci ? trueColor(L.color) : ACI[Math.abs(L.aci ?? 7)] || ACI[7];
    return ACI[ci] || ACI[7];
  };

  function emit(st, pts, closed = false, fill = false) {
    if (pts.length < (fill ? 3 : 2)) return;
    const key = st.key + (fill ? "" : st.dashKey);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { layer: st.layer, color: st.color, lw: st.lw, dash: fill ? null : st.dash, a: st.a, lines: [], fills: [] }));
    (fill ? g.fills : g.lines).push({ pts, closed });
    for (const [x, y] of pts) if (xs.length < 400000 && isFinite(x) && isFinite(y)) { xs.push(x); ys.push(y); }
  }
  // polilinee con larghezza (codici 40/41/43): tratti pieni come in AutoCAD; sui layer delle revisioni a penna (MARKUP*)
  // giunzioni tonde, perche' sono tratti a mano libera con molti vertici
  function widths(st, N, e, closed, lname) {
    const V = e.vertices || [], cw = e.constantWidth || 0;
    if (!V.length || !(cw > 0 || V.some(p => p.startWidth > 0 || p.endWidth > 0))) return false;
    const round = /^MARKUP/i.test(lname);
    const segs = closed ? V.length : V.length - 1;
    for (let i = 0; i < segs; i++) {
      const a = V[i], b = V[(i + 1) % V.length];
      if (a.bulge) continue; // archi larghi: resta la linea centrale
      const w0 = (a.startWidth ?? cw) || cw, w1 = (a.endWidth ?? a.startWidth ?? cw) || cw;
      const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
      if (!L || (!w0 && !w1)) continue;
      const nx = -dy / L, ny = dx / L;
      emit(st, [[a.x - nx * w0 / 2, a.y - ny * w0 / 2], [b.x - nx * w1 / 2, b.y - ny * w1 / 2], [b.x + nx * w1 / 2, b.y + ny * w1 / 2], [a.x + nx * w0 / 2, a.y + ny * w0 / 2]].map(([x, y]) => ap(N, x, y)), true, true);
      if (round) for (const [p, w] of [[a, w0], [b, w1]]) if (w > 0) emit(st, Array.from({ length: 10 }, (_, k) => ap(N, p.x + Math.cos(k * TAU / 10) * w / 2, p.y + Math.sin(k * TAU / 10) * w / 2)), true, true);
    }
    return true;
  }
  function item(it, layer) { it.o = owner; it.s = sub; it.l = layer; if (curSt) { it.c = curSt.color; it.lt = curSt.ltn; } items.push(it); (ents[owner] ||= []).push(items.length - 1); return it; }
  const line = (st, A, x1, y1, x2, y2) => {
    const [a, b] = ap(A, x1, y1), [c, d] = ap(A, x2, y2);
    emit(st, [[a, b], [c, d]]);
    item({ t: "L", x1: a, y1: b, x2: c, y2: d }, st.layer);
  };
  // arco in coordinate dell'entita' (ampiezza con segno); con trasformazioni non uniformi diventa una polilinea
  const arc = (st, A, cx, cy, r, a0, sw, draw = true) => {
    if (similar(A)) {
      const [x, y] = ap(A, cx, cy), k = Math.sqrt(Math.abs(det(A))), [dx, dy] = apv(A, Math.cos(a0), Math.sin(a0));
      const it = { t: "A", cx: x, cy: y, r: r * k, a0: Math.atan2(dy, dx), sw: det(A) < 0 ? -sw : sw };
      it.pts = sweepPts(it.cx, it.cy, it.r, it.r, 0, it.a0, it.sw);
      if (draw) emit(st, it.pts);
      item(it, st.layer);
    } else poly(st, A, sweepPts(cx, cy, r, r, 0, a0, sw), false, draw);
  };
  const poly = (st, A, pts, closed = false, draw = true) => {
    const P = pts.map(([x, y]) => ap(A, x, y));
    if (P.length < 2) return;
    if (closed && (P[0][0] !== P[P.length - 1][0] || P[0][1] !== P[P.length - 1][1])) P.push(P[0]);
    if (draw) emit(st, P);
    item({ t: "P", pts: P, closed }, st.layer);
  };
  const node = (A, x, y, layer, k = "ins") => { const [a, b] = ap(A, x, y); item({ t: "N", x: a, y: b, k }, layer); };
  const text = (st, e, A) => {
    const T = textLayout(e, A);
    if (!T) return;
    texts.push({ layer: st.layer, color: st.color, ...T });
    for (const [x, y] of T.quad) if (xs.length < 400000) { xs.push(x); ys.push(y); }
    item({ t: "Q", pts: [...T.quad, T.quad[0]], ins: T.ins }, st.layer);
  };
  const MIRX = [-1, 0, 0, 1, 0, 0];
  const OCS = new Set(["CIRCLE", "ARC", "LWPOLYLINE", "POLYLINE2D", "TEXT", "ATTRIB", "INSERT", "HATCH", "SOLID", "TRACE"]);

  function walk(list, M, inh, depth, path, sel) {
    if (depth > 12) return;
    for (const [k, e] of list.entries()) {
      if (depth === 0) { owner = k; sub = ""; if (e._deleted || e.type === "_skip") continue; }
      else if (sel) sub = path + "/" + (e._attr ? "a" : "") + k;
      if (e._deleted || e.isVisible === false || e.isInPaperSpace) continue;
      const lname = e.layer === "0" && inh.layer ? inh.layer : e.layer || "0";
      const L = layerOf(lname);
      L.count++;
      const col = colorOf(e, L, inh.color);
      // tipo linea e spessore (DaLayer / DaBlocco)
      const ltn = String(e.lineType || "").toLowerCase();
      const lt = !ltn || ltn === "bylayer" ? String(L.lt || "").toLowerCase() : ltn === "byblock" ? inh.lt || "" : ltn;
      const lwv = e.lineweight ?? -1, lw = lwv === -1 ? L.lw : lwv === -2 ? inh.lw ?? -3 : lwv;
      const N = OCS.has(e.type) && e.extrusionDirection && e.extrusionDirection.z < -0.5 ? mul(M, MIRX) : M;
      const k2 = Math.sqrt(Math.abs(det(N))) || 1;
      const pat = ltypes.get(lt);
      const dash = pat ? pat.map(v => Math.max(Math.abs(v), 0) * LTS * (e.lineTypeScale || 1) * k2 || 0.02 * LTS * k2) : null;
      // evidenziatore delle revisioni a penna anche nei DXF R12, che non hanno la trasparenza: layer MARKUP-EVID al 38%
      const alpha = e.alpha ?? (/^MARKUP-EVID$/i.test(lname) ? 0.38 : undefined);
      const st = { layer: lname, color: col, lw, dash, a: alpha, ltn: lt || "continuous", key: lname + "|" + col.join(",") + "|" + lw + (alpha !== undefined ? "|a" + alpha.toFixed(3) : ""), dashKey: dash ? "|" + dash.map(v => v.toPrecision(4)).join(",") : "" };
      curSt = st;
      const shape = (pts, kind) => closedL.push({ o: owner, s: sub, l: lname, c: col, lt: st.ltn, kind, pts });
      switch (e.type) {
        case "LINE": line(st, N, e.startPoint.x, e.startPoint.y, e.endPoint.x, e.endPoint.y); break;
        case "CIRCLE": arc(st, N, e.center.x, e.center.y, e.radius, 0, TAU); shape(sweepPts(e.center.x, e.center.y, e.radius, e.radius, 0, 0, TAU).map(([x, y]) => ap(N, x, y)), "CIRCLE"); break;
        case "ARC": { let sw = e.endAngle - e.startAngle; while (sw <= 0) sw += TAU; arc(st, N, e.center.x, e.center.y, e.radius, e.startAngle, sw); break; }
        case "ELLIPSE": {
          const mx = e.majorAxisEndPoint.x, my = e.majorAxisEndPoint.y, r = Math.hypot(mx, my);
          poly(st, N, arcPts(e.center.x, e.center.y, r, r * e.axisRatio, Math.atan2(my, mx), e.startAngle, e.endAngle));
          node(N, e.center.x, e.center.y, lname, "cen");
          break;
        }
        case "LWPOLYLINE": case "POLYLINE2D": case "POLYLINE3D": {
          const v = (e.vertices || []).filter(p => !(p.flag & 16)).map(p => ({ x: p.x ?? p.point?.x, y: p.y ?? p.point?.y, bulge: p.bulge || 0 }));
          if (!v.length) break;
          const closed = !!(e.flag & 1) || e.closed;
          const draw = [[v[0].x, v[0].y]];
          for (let i = 1; i < v.length; i++) bulgePts(v[i - 1], v[i], v[i - 1].bulge, draw);
          if (closed) bulgePts(v[v.length - 1], v[0], v[v.length - 1].bulge, draw);
          // con la larghezza disegnata e trasparente (evidenziatore) la linea centrale non si ripassa
          if (!widths(st, N, e, closed, lname) || st.a === undefined) emit(st, draw.map(([x, y]) => ap(N, x, y)));
          if (closed && v.length > 2) shape(draw.map(([x, y]) => ap(N, x, y)), e.type);
          const segs = closed ? v.length : v.length - 1;
          for (let i = 0; i < segs; i++) {
            const a = v[i], b = v[(i + 1) % v.length], B = a.bulge ? bulgeArc(a.x, a.y, b.x, b.y, a.bulge) : null;
            if (B) arc(st, N, B.cx, B.cy, B.r, B.a0, B.sw, false);
            else { const [x1, y1] = ap(N, a.x, a.y), [x2, y2] = ap(N, b.x, b.y); item({ t: "L", x1, y1, x2, y2, seg: i }, lname); }
          }
          if (v.length === 1) node(N, v[0].x, v[0].y, lname, "end");
          break;
        }
        case "SPLINE": poly(st, N, splinePts(e), !!(e.flag & 1)); break;
        case "LEADER": poly(st, N, (e.vertices || []).map(p => [p.x, p.y])); break;
        case "POINT": {
          const [x, y] = ap(N, e.position.x, e.position.y), s = 0.5;
          emit(st, [[x - s, y], [x + s, y]]); emit(st, [[x, y - s], [x, y + s]]);
          node(N, e.position.x, e.position.y, lname, "nod");
          item({ t: "P", pts: [[x - s, y], [x + s, y]] }, lname);
          break;
        }
        case "SOLID": case "TRACE": case "3DFACE": {
          const c = e.type === "3DFACE" ? [e.corner1, e.corner2, e.corner3, e.corner4 || e.corner3, e.corner1] : [e.corner1, e.corner2, e.corner4 || e.corner3, e.corner3];
          const P = c.filter(Boolean).map(p => ap(N, p.x, p.y));
          emit(st, P, true, e.type !== "3DFACE");
          item({ t: e.type === "3DFACE" ? "P" : "F", pts: [...P, P[0]], closed: true }, lname);
          break;
        }
        case "PFACE": case "MESH": { // mesh 3D: spigoli visibili proiettati sulla pianta (fil di ferro, come AutoCAD)
          const V = e.vertices || [], base = e.type === "PFACE" ? 1 : 0;
          for (const f of e.faces || []) {
            if (f.length < 2) continue;
            for (let k = 0; k < f.length; k++) {
              const a = f[k], b = f[(k + 1) % f.length];
              if (e.type === "PFACE" && a < 0) continue; // indice negativo = spigolo invisibile
              const p = V[Math.abs(a) - base], q = V[Math.abs(b) - base];
              if (p && q) line(st, N, p[0], p[1], q[0], q[1]);
            }
          }
          break;
        }
        case "PMESH": {
          const V = e.vertices || [], m = e.m | 0, n = e.n | 0;
          if (m < 2 || n < 2 || V.length < m * n) break;
          for (let i = 0; i < m; i++) poly(st, N, Array.from({ length: n }, (_, j) => V[i * n + j]), !!(e.flag & 32));
          for (let j = 0; j < n; j++) poly(st, N, Array.from({ length: m }, (_, i) => V[i * n + j]), !!(e.flag & 1));
          break;
        }
        case "HATCH": {
          const loops = [];
          for (const path of e.boundaryPaths || []) {
            let pts = [];
            if (path.vertices?.length) {
              const v = path.vertices;
              pts = [[v[0].x, v[0].y]];
              for (let i = 1; i < v.length; i++) bulgePts(v[i - 1], v[i], v[i - 1].bulge, pts);
              bulgePts(v[v.length - 1], v[0], v[v.length - 1].bulge || 0, pts);
            } else for (const ed of path.edges || []) {
              if (!ed) continue; // DWG reali: bordi vuoti nei contorni dei retini (libredwg)
              if (ed.type === 1) pts.push([ed.start.x, ed.start.y], [ed.end.x, ed.end.y]);
              else if (ed.type === 2) pts.push(...arcPts(ed.center.x, ed.center.y, ed.radius, ed.radius, 0, ed.isCCW === false ? -ed.startAngle : ed.startAngle, ed.isCCW === false ? -ed.endAngle : ed.endAngle, ed.isCCW !== false));
              else if (ed.type === 3) { const r = Math.hypot(ed.end.x, ed.end.y); pts.push(...arcPts(ed.center.x, ed.center.y, r, ed.lengthOfMinorAxis * (ed.lengthOfMinorAxis < 1.0001 ? r : 1), Math.atan2(ed.end.y, ed.end.x), ed.startAngle, ed.endAngle, ed.isCCW !== false)); }
              else if (ed.type === 4) pts.push(...splinePts({ degree: ed.degree, knots: ed.knots, controlPoints: ed.controlPoints }));
            }
            if (pts.length > 2) loops.push(pts.map(([x, y]) => ap(N, x, y)));
          }
          const solid = e.solidFill === 1 || e.isSolidFill === true || /^solid$/i.test(e.patternName || "");
          if (solid) for (const P of loops) emit(st, P, true, true);
          else {
            // righe del motivo: quelle del file (gia' scalate e ruotate) o quelle dei motivi noti
            let defs = e.definitionLines?.length ? e.definitionLines : patternDefLines(e.patternName, e.patternScale || 1, e.patternAngle || 0);
            if (defs && N !== I) {
              const ra = Math.atan2(N[1], N[0]);
              defs = defs.map(d => { const [bx, by] = ap(N, d.base?.x || 0, d.base?.y || 0), [ox, oy] = apv(N, d.offset?.x || 0, d.offset?.y || 0); return { angle: d.angle + ra, base: { x: bx, y: by }, offset: { x: ox, y: oy }, dashLengths: (d.dashLengths || []).map(v => v * k2) }; });
            }
            const segs = defs ? hatchSegments(loops, defs) : null;
            if (segs) for (const s of segs) emit(st, s);
            else for (const P of loops) emit(st, P, true);
          }
          for (const P of loops) item({ t: "F", pts: [...P, P[0]], closed: true, hatch: true }, lname);
          if (loops.length) hatches.push({ o: owner, s: sub, l: lname, c: col, pattern: solid ? "SOLID" : e.patternName || "", loops });
          break;
        }
        case "TEXT": case "ATTRIB": case "MTEXT": text(st, e, N); break;
        case "INSERT": case "DIMENSION": {
          if (e.type === "DIMENSION" && e.dimKind) { // quota nuova, non ancora salvata
            const G = dimGeom(e);
            for (const P of G.lines) { if (P.length === 2) line(st, N, P[0][0], P[0][1], P[1][0], P[1][1]); else poly(st, N, P); }
            for (const P of G.fills) { const W = P.map(([x, y]) => ap(N, x, y)); emit(st, W, true, true); item({ t: "F", pts: [...W, W[0]], closed: true }, lname); }
            if (G.text) text(st, dimTextEntity(G.text), N);
            break;
          }
          const b = blocks.get(e.name);
          const inh2 = { layer: lname, color: col, lt, lw };
          if (e.type === "INSERT") { const [ix, iy] = ap(N, e.insertionPoint.x, e.insertionPoint.y); inserts.push({ o: owner, s: sub, l: lname, c: col, name: e.name, x: ix, y: iy, depth, attribs: (e.attribs || []).map(a => [a.tag, a.text]) }); }
          if (b) {
            const bp = b.basePoint || { x: 0, y: 0 };
            const cols = Math.max(1, e.columnCount || 1), rows = Math.max(1, e.rowCount || 1);
            for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
              let Nb;
              if (e.type === "DIMENSION") Nb = e._xf ? mul(N, e._xf) : N;
              else {
                const sx = e.xScale || 1, sy = e.yScale || 1, a = e.rotation || 0, ca = Math.cos(a), sa = Math.sin(a);
                const ox = c * (e.columnSpacing || 0), oy = r * (e.rowSpacing || 0);
                const ix = e.insertionPoint.x + ox * ca - oy * sa, iy = e.insertionPoint.y + ox * sa + oy * ca;
                const L2 = [ca * sx, sa * sx, -sa * sy, ca * sy, 0, 0];
                L2[4] = ix - (L2[0] * bp.x + L2[2] * bp.y);
                L2[5] = iy - (L2[1] * bp.x + L2[3] * bp.y);
                Nb = mul(N, L2);
              }
              const keep = sub;
              walk(b.entities || [], Nb, inh2, depth + 1, sub, sel && e.type === "INSERT" && r === 0 && c === 0);
              sub = keep;
            }
          }
          curSt = st;
          if (e.type === "INSERT") {
            node(N, e.insertionPoint.x, e.insertionPoint.y, lname);
            if (e.attribs?.length) { const keep = sub; e.attribs.forEach(a => { a._attr = true; }); walk(e.attribs, M, inh2, depth + 1, sub, sel); sub = keep; }
          }
          break;
        }
        case "IMAGE": {
          // immagine raster: pixel (0, 0) in alto a sinistra; matrice pixel -> mondo per drawImage
          const w = e.imageSize?.x, h = e.imageSize?.y;
          if (!w || !h || !e.fileName || !e.insertionPoint) break;
          const o = e.insertionPoint, u = e.uPixel, v = e.vPixel;
          const A = mul(N, [u.x, u.y, -v.x, -v.y, o.x + v.x * h, o.y + v.y * h]);
          images.push({ layer: lname, file: e.fileName, A, w, h });
          const q = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => [A[0] * x + A[2] * y + A[4], A[1] * x + A[3] * y + A[5]]);
          for (const [x, y] of q) { xs.push(x); ys.push(y); }
          item({ t: "P", pts: [...q, q[0]], closed: true }, lname);
          break;
        }
        default: break;
      }
    }
  }
  const images = [];
  walk(db.entities, I, {}, 0, "", true);

  // estensioni robuste (scarta elementi isolati lontanissimi)
  let bbox;
  if (xs.length) {
    const q = (arr, f) => { const s = Float64Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * f)))]; };
    const lo = xs.length > 200 ? 0.002 : 0, hi = 1 - lo;
    bbox = [q(xs, lo), q(ys, lo), q(xs, hi), q(ys, hi)];
    if (bbox[2] - bbox[0] < 1e-9) { bbox[0] -= 1; bbox[2] += 1; }
    if (bbox[3] - bbox[1] < 1e-9) { bbox[1] -= 1; bbox[3] += 1; }
  } else bbox = [0, 0, 100, 100];

  for (const g of groups.values()) {
    g.path = new Path2D();
    for (const { pts, closed } of g.lines) { g.path.moveTo(pts[0][0], pts[0][1]); for (let k = 1; k < pts.length; k++) g.path.lineTo(pts[k][0], pts[k][1]); if (closed) g.path.closePath(); }
    g.fillPath = new Path2D();
    for (const { pts } of g.fills) { g.fillPath.moveTo(pts[0][0], pts[0][1]); for (let k = 1; k < pts.length; k++) g.fillPath.lineTo(pts[k][0], pts[k][1]); g.fillPath.closePath(); }
  }
  const index = gridIndex(items, bbox);
  return { layers, groups: [...groups.values()], texts, bbox, items, ents, query: index, header: H, closed: closedL, hatches, inserts, images };
}

// indice spaziale a griglia: query(x0, y0, x1, y1) -> indici degli elementi il cui ingombro tocca il rettangolo
function gridIndex(items, bbox) {
  const W = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]) || 1, cs = W / 256, ox = bbox[0], oy = bbox[1];
  const grid = new Map(), big = [];
  const cell = v => Math.floor(v / cs);
  items.forEach((it, i) => {
    let bb;
    if (it.t === "L") bb = [Math.min(it.x1, it.x2), Math.min(it.y1, it.y2), Math.max(it.x1, it.x2), Math.max(it.y1, it.y2)];
    else if (it.t === "A") bb = Math.abs(it.sw) >= TAU - 1e-9 ? [it.cx - it.r, it.cy - it.r, it.cx + it.r, it.cy + it.r] : ptsBB(it.pts);
    else if (it.t === "N") bb = [it.x, it.y, it.x, it.y];
    else bb = ptsBB(it.pts);
    it.bb = bb;
    if (!bb.every(isFinite)) return;
    const ix0 = cell(bb[0] - ox), iy0 = cell(bb[1] - oy), ix1 = cell(bb[2] - ox), iy1 = cell(bb[3] - oy);
    if ((ix1 - ix0 + 1) * (iy1 - iy0 + 1) > 400) { big.push(i); return; }
    for (let x = ix0; x <= ix1; x++) for (let y = iy0; y <= iy1; y++) { const k = x * 1048576 + y; let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i); }
  });
  return (x0, y0, x1, y1) => {
    const ix0 = cell(x0 - ox), iy0 = cell(y0 - oy), ix1 = cell(x1 - ox), iy1 = cell(y1 - oy);
    const hit = i => { const b = items[i].bb; return b && b[0] <= x1 && b[2] >= x0 && b[1] <= y1 && b[3] >= y0; };
    if ((ix1 - ix0 + 1) * (iy1 - iy0 + 1) > 20000) return items.map((_, i) => i).filter(hit);
    const seen = new Set();
    for (let x = ix0; x <= ix1; x++) for (let y = iy0; y <= iy1; y++) { const a = grid.get(x * 1048576 + y); if (a) for (const i of a) seen.add(i); }
    for (const i of big) seen.add(i);
    return [...seen].filter(hit);
  };
}
function ptsBB(P) { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const [x, y] of P) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; } return [a, b, c, d]; }

// ---------------------------------------------------------------- decodifica DWG
// Un motore nuovo per ogni disegno: la sua memoria si libera quando il disegno e' letto. Con un motore condiviso
// la memoria cresceva a ogni file aperto fino a esaurirsi ("out of WASM memory").
export async function decodeDwg(bytes, ctx, ld) { // usata anche dalla conversione a lotti (ui/js/batch.js)
  const m = await import("/vendor/libredwg/dist/libredwg-web.js");
  const type = ctx.ext === "dxf" ? m.Dwg_File_Type.DXF : m.Dwg_File_Type.DWG;
  for (let attempt = 1; ; attempt++) {
    ld.set(0.3, attempt === 1 ? tr("v_cad2d.decodifica_dwg") : tr("v_cad2d.decodifica_dwg_secondo_tentativo_memoria"));
    let lib = await m.LibreDwg.create("/vendor/libredwg/wasm");
    try {
      const data = lib.dwg_read_data(bytes.buffer, type);
      if (data === undefined || data === null) throw new Error(tr("v_cad2d.file_dwg_non_leggibile_versione"));
      const db = lib.convert(data);
      if (ctx.geodata) try { db.geodata = dwgGeodata(lib, data, m); } catch { /* */ } // mappa (ui/js/gisdraw.js)
      try { dwg3dEntities(lib, data, m, db); } catch (e) { console.warn(e); } // vista 3D (ui/js/cad3d.js)
      try { lib.dwg_free(data); } catch { /* */ }
      return db;
    } catch (e) {
      lib = null;
      if (/out of WASM memory/i.test(e.message)) {
        if (attempt < 2) { await new Promise(r => setTimeout(r, 500)); continue; }
        throw new Error(tr("v_cad2d.disegno_troppo_grande_lettore_interno", (bytes.length / 1048576).toFixed(1), ctx.tools?.trueview ? tr("v_cad2d.oppure_usa_apri_come_dwg") : ""));
      }
      throw e;
    }
  }
}

// Entita' 3D che libredwg-web non converte (REGION, BODY, superfici, MESH, polyface e polygon mesh) e dati ACIS dei
// solidi, letti con l'API dinamica prima di liberare la memoria del motore (il 3DSOLID convertito ha solo un indirizzo).
// Nei DWG 2013+ i dati ACIS li rilegge il motore Python dalla sezione AcDs (mbvisual/dwgacds.py).
function dwg3dEntities(lib, data, m, db) {
  const T = m.Dwg_Object_Type, W = lib.wasmInstance;
  const ACIS = new Map([["3DSOLID", T.DWG_TYPE_3DSOLID], ["REGION", T.DWG_TYPE_REGION], ["BODY", T.DWG_TYPE_BODY],
    ...["PLANESURFACE", "EXTRUDEDSURFACE", "LOFTEDSURFACE", "REVOLVEDSURFACE", "SWEPTSURFACE", "NURBSURFACE"].map(n => [n, T["DWG_TYPE_" + n]])].filter(([, v]) => v !== undefined).map(([k, v]) => [v, k]));
  const MESHT = { [T.DWG_TYPE_MESH]: "MESH", [T.DWG_TYPE_POLYLINE_PFACE]: "PFACE", [T.DWG_TYPE_POLYLINE_MESH]: "PMESH" };
  const VX = new Set([T.DWG_TYPE_VERTEX_PFACE, T.DWG_TYPE_VERTEX_PFACE_FACE, T.DWG_TYPE_VERTEX_MESH]);
  const hex = v => (typeof v === "bigint" ? v : BigInt(Math.round(Number(v) || 0))).toString(16).toUpperCase();
  const layerByHandle = new Map((db.tables.LAYER?.entries || []).filter(l => l.handle).map(l => [String(l.handle).toUpperCase(), l.name]));
  const n = lib.dwg_get_num_objects(data);
  const acisOf = new Map(), made = [], verts = new Map();
  for (let i = 0; i < n; i++) {
    const o = lib.dwg_get_object(data, i);
    const t = lib.dwg_object_get_fixedtype(o);
    if (!ACIS.has(t) && !MESHT[t] && !VX.has(t)) continue;
    const ent = lib.dwg_object_to_entity(o), tio = lib.dwg_object_to_entity_tio(o);
    if (!ent || !tio) continue;
    const g = k => { try { return lib.dwg_dynapi_entity_data(tio, k); } catch { return undefined; } };
    const handle = hex(lib.dwg_object_entity_get_handle_object(ent).value);
    const owner = hex(lib.dwg_object_entity_get_ownerhandle_object(ent).absolute_ref);
    if (VX.has(t)) {
      let v = verts.get(owner);
      if (!v) verts.set(owner, (v = { pts: [], faces: [] }));
      if (t === T.DWG_TYPE_VERTEX_PFACE_FACE) { const q = (tio + 6) >> 1; v.faces.push(Array.from(W.HEAP16.subarray(q, q + 4)).filter(k => k)); } // vertind[4] dopo parent e flag
      else { const p = g("point"); v.pts.push([p?.x || 0, p?.y || 0, p?.z || 0]); }
      continue;
    }
    let acis;
    if (ACIS.has(t)) {
      const ver = g("version"), p = g("acis_data");
      if (p && typeof p === "number") {
        if (ver === 2) { const sz = g("sab_size") || 0; if (sz > 0) acis = { sab: W.HEAPU8.slice(p, p + sz) }; }
        else { let e = p; while (W.HEAPU8[e] && e - p < 2e8) e++; if (e > p) acis = { sat: new TextDecoder("latin1").decode(W.HEAPU8.subarray(p, e)) }; }
      }
      if (t === T.DWG_TYPE_3DSOLID) { acisOf.set(handle, acis || null); continue; } // gia' convertito da libredwg-web
    }
    const col = lib.dwg_object_entity_get_color_object(ent);
    const e = { type: ACIS.get(t) || MESHT[t], handle, ownerBlockRecordSoftId: owner, colorIndex: col.index,
      layer: layerByHandle.get(hex(lib.dwg_object_entity_get_layer_object_ref(ent).handleref.value)) || "0",
      isVisible: !lib.dwg_object_entity_get_invisible(ent) };
    if (col.method === 194 || ((col.rgb >>> 24) & 255) === 194) e.color = col.rgb & 0xffffff;
    if (acis) e.acis = acis;
    if (e.type === "MESH") {
      const nv = g("num_vertex") || 0, vp = g("vertex"), nf = g("num_faces") || 0, fp = g("faces");
      e.vertices = [];
      if (vp && nv) { const a = W.HEAPF64.subarray(vp >> 3, (vp >> 3) + nv * 3); for (let k = 0; k < nv; k++) e.vertices.push([a[k * 3], a[k * 3 + 1], a[k * 3 + 2]]); }
      e.faces = [];
      if (fp && nf) { const L = W.HEAPU32.subarray(fp >> 2, (fp >> 2) + nf); for (let k = 0; k < L.length;) { const c = L[k]; if (!c) break; e.faces.push(Array.from(L.subarray(k + 1, k + 1 + c))); k += c + 1; } }
    } else if (e.type === "PMESH") { e.flag = g("flag") || 0; e.m = g("num_m_verts") || 0; e.n = g("num_n_verts") || 0; }
    made.push(e);
  }
  for (const e of made) if (e.type === "PFACE" || e.type === "PMESH") { const v = verts.get(e.handle); e.vertices = v?.pts || []; if (e.type === "PFACE") e.faces = v?.faces || []; }
  const brs = db.tables.BLOCK_RECORD?.entries || [];
  const byHandle = new Map(brs.filter(b => b.handle).map(b => [String(b.handle).toUpperCase(), b]));
  for (const e of made) {
    const b = byHandle.get(e.ownerBlockRecordSoftId);
    if (!b || /^\*(model|paper)_space/i.test(b.name || "")) db.entities.push(e);
    else (b.entities ||= []).push(e);
  }
  if (acisOf.size) for (const list of [db.entities, ...brs.map(b => b.entities || [])]) for (const e of list) {
    if (e.type !== "3DSOLID") continue;
    const k = String(e.handle || "").toUpperCase();
    if (acisOf.has(k)) { const a = acisOf.get(k); if (a) e.acis = a; }
    delete e.data; // indirizzo nella memoria del motore, non piu' valido dopo dwg_free
  }
}

// GEODATA del DWG (georeferenziazione di AutoCAD): libredwg-web non lo converte, si legge con l'API dinamica
function dwgGeodata(lib, data, m) {
  const type = m.Dwg_Object_Type?.DWG_TYPE_GEODATA ?? 639;
  const n = lib.dwg_get_num_objects(data);
  for (let i = 0; i < n; i++) {
    const obj = lib.dwg_get_object(data, i);
    if (!obj || lib.dwg_object_get_fixedtype(obj) !== type) continue;
    const tio = lib.dwg_object_to_object_tio(obj);
    if (!tio) continue;
    const v = f => { try { return lib.dwg_dynapi_entity_data(tio, f); } catch { return undefined; } };
    const xy = (p, d) => (p && typeof p === "object" ? [+p.x || 0, +p.y || 0] : d);
    return { type: +v("coord_type") || 2, design: xy(v("design_pt"), [0, 0]), ref: xy(v("ref_pt"), [0, 0]), scale: +v("unit_scale_horiz") || 1,
      units: +v("units_value_horiz") || 0, north: xy(v("north_dir"), [0, 1]), def: String(v("coord_system_def") || "") };
  }
  return null;
}

// ---------------------------------------------------------------- visualizzatore
export async function mount(ctx) {
  const ld = loading(ctx.el, tr("v_cad2d.lettura_disegno"));
  const bytes = await readBytes(ctx.path);
  let db;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 6));
  const dxfText = ctx.ext === "dxf" && !head.startsWith("AutoCA");
  let srcText = null, srcEnc = "utf-8"; // testo del DXF: le revisioni a penna si aggiungono a questo (inkdxf.js)
  if (dxfText) {
    srcEnc = isUtf8(bytes) ? "utf-8" : "windows-1252";
    const text = srcText = new TextDecoder(srcEnc).decode(bytes);
    db = parseDxf(text);
  } else {
    db = await decodeDwg(bytes, ctx, ld);
    // DWG non piccolo senza nemmeno un oggetto: libredwg ha letto solo l'intestazione (file danneggiato) -> schermata di recupero
    if (!db?.entities?.length && bytes.length > 60000) throw new Error(tr("v_cad2d.dwg_nessun_oggetto"));
  }
  normalize(db, dxfText ? "dxf" : "dwg");
  ld.set(0.7, tr("v_cad2d.preparazione_disegno"));
  await new Promise(r => setTimeout(r, 0));
  let model = build(db);
  const scan3d = analyze3d(db); // contenuto 3D: solidi, mesh, facce, oggetti con spessore (ui/js/cad3d.js)
  // file delle immagini: relativi alla cartella del disegno (come in AutoCAD), poi assoluti, poi solo il nome
  const imgCache = new Map();
  const loadImages = () => {
    if (WEB || !ctx.path) return;
    const dir = ctx.path.replace(/[\\/][^\\/]*$/, "");
    for (const im of model.images || []) {
      const f = im.file.replace(/\//g, "\\");
      const name = f.split("\\").pop();
      const tries = /^([a-z]:|\\\\)/i.test(f) ? [f, dir + "\\" + name] : [dir + "\\" + f.replace(/^\.\\/, ""), dir + "\\" + name];
      let img = imgCache.get(tries[0]);
      if (!img) {
        img = new Image();
        let k = 0;
        img.onload = () => draw();
        img.onerror = () => { if (++k < tries.length) img.src = fileUrl(tries[k]); };
        img.src = fileUrl(tries[0]);
        imgCache.set(tries[0], img);
      }
      im.img = img;
    }
  };
  loadImages();
  ctx.el.innerHTML = "";
  ctx.el.__cad = { db, get model() { return model; }, get view() { return view; }, get editor() { return editor; }, zoom: bb => zoomBox(bb), canvas: () => canvas }; // per i collaudi dalla console

  // ---- interfaccia
  const canvas = el("canvas", { class: "fill", style: { touchAction: "none" } });
  const layerList = el("div", { class: "tree" });
  const side = el("div", {}, el("div", { style: { padding: "8px 10px", display: "flex", gap: "6px", alignItems: "center" } }, el("b", {}, tr("v_cad2d.layer")), el("span", { class: "note" }, String(model.layers.size)),
    el("span", { style: { flex: 1 } }), el("button", { class: "btn", onclick: () => setAll(true) }, tr("v_cad2d.tutti")), el("button", { class: "btn", onclick: () => setAll(false) }, tr("v_cad2d.nessuno"))), layerList);
  // editor del disegno (solo app per PC: il salvataggio usa il motore ezdxf)
  // senza il componente CAD 2D il disegno si apre in visualizzazione (misura, layer, esportazioni)
  const editor = WEB || !isOn("cad") ? null : createCadEditor({
    ctx, db, sourceKind: dxfText ? "dxf" : "dwg", ACI, getModel: () => model,
    rebuild: () => { model = build(db); loadImages(); refreshLayers(); draw(); },
    draw: () => draw(), toWorld: (x, y) => toWorld(x, y), toScreen: (x, y) => toScreen(x, y), get view() { return view; },
    zoomTo: bb => zoomBox(bb), canvasSize: () => ({ w: canvas.width, h: canvas.height }),
    temp: ents => build({ ...db, entities: ents }),
  });
  if (editor) side.append(editor.props);
  const stage = el("div", { style: { position: "relative", overflow: "hidden", flex: "1 1 auto", minHeight: 0 } }, canvas);
  const wrap = el("div", { class: "side" }, side, el("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 } },
    editor ? editor.bar : el("span"), stage, editor ? editor.cmdline : el("span")));
  // vista 3D (model3d.js con la scena costruita da cad3d.js), al posto della vista 2D
  const host3d = el("div", { style: { display: "none", flex: "1 1 auto", minHeight: 0, minWidth: 0, flexDirection: "column", height: "100%" } });
  ctx.el.append(wrap, host3d);
  ctx.fillBody(true);
  let dark = true, measure = false, mpts = [], showText = true, showLw = false, msnap = null;
  // ---- misure ed estrazioni (pannello comune a PDF, CAD e 3D: ui/js/measure/mcad.js; misure nel file .mbmis accanto)
  let meas = null, measP = null;
  const measGet = () => (measP ??= import("../measure/mcad.js").then(async m => (meas = await m.attachCad(ctx, {
    host: stage, db, getModel: () => model, toWorld: (x, y) => toWorld(x, y), toScreen: (x, y) => toScreen(x, y), draw: () => draw(),
    zoomTo: bb => zoomBox(bb), get view() { return view; }, onPanel: v => measBtn.classList.toggle("on", v),
  }))));
  const measBtn = measureBtn(async () => (await measGet()).toggle());
  if (!WEB && ctx.path) api("stat", { path: mbmisOf(ctx.path) }, { allowFail: true }).then(r => { if (r?.ok) measGet().then(() => draw()); }).catch(() => {});
  const lineScale = { v: 1 };
  // revisioni a mano libera (web app: tablet con penna) sul layer MARKUP del disegno (ui/js/ink.js, inkdxf.js)
  let ink = null;
  const inkBtn = editor || !WEB ? null : button(tr("ink.penna"), INK_ICON, () => toggleInk(), { class: "ink-toggle", title: tr("ink.annota_cad") });
  async function toggleInk() {
    if (!ink) {
      const { createInk } = await import("../ink.js");
      const dpr = () => devicePixelRatio || 1;
      ink = createInk({
        host: stage, nativeTouch: false,
        surfaces: () => [{ key: 0, el: stage, toDoc: (x, y) => toWorld(x * dpr(), y * dpr()), toLocal: (x, y) => { const p = toScreen(x, y); return [p[0] / dpr(), p[1] / dpr()]; } }],
        pan: (dx, dy) => { view.tx += dx * dpr(); view.ty += dy * dpr(); draw(); },
        zoom: (f, cx, cy) => zoomAt(f, cx * dpr(), cy * dpr()),
        onChange: () => ctx.setDirty(true),
        onToggle: on => inkBtn.classList.toggle("on", on),
      });
    }
    ink.toggle();
  }

  const bgBtn = button(tr("v_cad2d.sfondo_chiaro"), "sun", () => { dark = !dark; bgBtn.lastChild.textContent = dark ? tr("v_cad2d.sfondo_chiaro") : tr("v_cad2d.sfondo_scuro"); draw(); });
  const mBtn = button(tr("v_cad2d.misura"), "ruler", () => { measure = !measure; mBtn.classList.toggle("on", measure); mpts = []; draw(); }, { title: tr("v_cad2d.distanza_tra_due_punti_aggancio") });
  const tBtn = button(tr("v_cad2d.testi"), "text", () => { showText = !showText; tBtn.classList.toggle("on", showText); draw(); });
  const lwBtn = button(tr("v_cad2d.spessori"), "", () => { showLw = !showLw; lwBtn.classList.toggle("on", showLw); draw(); }, { title: tr("v_cad2d.mostra_spessore_linee") });
  tBtn.classList.add("on");
  // nell'app per PC gli strumenti di modifica (barra come AutoCAD + riga di comando) sono sempre visibili, come aprendo
  // un disegno in AutoCAD: niente pulsante "Modifica disegno"; la misura e' nel pannello Utilita' (Distanza, Area)
  const tb2d = el("span", { style: { display: "contents" } }), tb3d = el("span", { style: { display: "none" } });
  const viewBtn = button(tr("cad3d.vista_3d_btn"), "cube", () => (mode3d ? show2d() : show3d()), { title: tr("cad3d.vista_3d_tip") });
  if (scan3d.any) viewBtn.classList.add("cad3d-has");
  ctx.tb.append(viewBtn, el("span", { class: "sep" }), tb2d, tb3d);
  tb2d.append(...[button(tr("v_cad2d.adatta"), "fit", fit), button("", "zoomIn", () => zoomAt(1.4), { iconOnly: true, title: tr("v_cad2d.ingrandisci") }), button("", "zoomOut", () => zoomAt(1 / 1.4), { iconOnly: true, title: tr("v_cad2d.riduci") }),
    el("span", { class: "sep" }), editor ? null : mBtn, measBtn, inkBtn, tBtn, lwBtn, bgBtn, el("span", { class: "sep" }),
    button("PNG", "download", () => exportPng()), button("SVG", "download", () => exportSvg()), button("PDF", "download", () => exportPdf()),
    button(tr("gisdraw.mostra_mappa"), '<svg viewBox="0 0 24 24"><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/></svg>', () => ctx.openAs("gis"), { title: tr("gisdraw.mostra_mappa_tip"), comp: "gis" }),
    ctx.ext === "dxf" ? button(tr("v_cad2d.modifica_dxf_testo"), "code", () => ctx.openAs("text"), { comp: "cad" }) : null,
    ctx.tools.trueview ? button(tr("v_cad2d.apri_dwg_trueview"), "open", () => api("open_external", { path: ctx.path, app: "trueview" })) : null,
    el("span", { class: "grow" }), el("span", { class: "note" }, tr("v_cad2d.rotella_zoom_trascina_tasto_centrale"))].filter(Boolean));

  // ---- elenco layer
  let sortedLayers = [];
  function refreshLayers() {
    const off = new Map(sortedLayers.map(L => [L.name, L.off]));
    sortedLayers = [...model.layers.values()].filter(l => l.count).sort((a, b) => a.name.localeCompare(b.name));
    for (const L of sortedLayers) if (off.has(L.name)) L.off = off.get(L.name);
    renderLayers();
  }
  function renderLayers() {
    layerList.innerHTML = "";
    for (const L of sortedLayers) {
      const c = ACI[Math.abs(L.aci ?? 7)] || ACI[7];
      const cb = el("input", { type: "checkbox", checked: !L.off });
      cb.addEventListener("change", () => { L.off = !cb.checked; const M = model.layers.get(L.name); if (M) M.off = L.off; draw(); });
      layerList.append(el("label", { class: "node" }, cb, el("span", { style: { width: "10px", height: "10px", background: rgb(c), border: "1px solid var(--line)", flex: "none" } }), el("span", {}, L.name), el("span", { class: "note", style: { marginLeft: "auto" } }, String(L.count))));
    }
  }
  function setAll(v) { sortedLayers.forEach(L => (L.off = !v)); renderLayers(); draw(); }
  refreshLayers();

  // ---- vista
  const view = { s: 1, tx: 0, ty: 0 };
  const g2 = canvas.getContext("2d");
  function resize() {
    const r = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    canvas.width = Math.max(1, r.width * dpr);
    canvas.height = Math.max(1, r.height * dpr);
  }
  // le dimensioni del canvas seguono quelle mostrate (anche se il ridimensionamento automatico non e' ancora partito)
  function ensureSize() { const r = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1; if (r.width && Math.abs(canvas.width - Math.max(1, r.width * dpr)) > 1.5 || r.height && Math.abs(canvas.height - Math.max(1, r.height * dpr)) > 1.5) resize(); }
  function zoomBox([x0, y0, x1, y1], k = 0.92) {
    ensureSize();
    const W = canvas.width, H = canvas.height;
    view.s = k * Math.min(W / Math.max(x1 - x0, 1e-9), H / Math.max(y1 - y0, 1e-9));
    view.tx = W / 2 - view.s * (x0 + x1) / 2;
    view.ty = H / 2 + view.s * (y0 + y1) / 2;
    draw();
  }
  function fit() { resize(); zoomBox(model.bbox); }
  const toWorld = (px, py) => [(px - view.tx) / view.s, (view.ty - py) / view.s];
  const toScreen = (x, y) => [x * view.s + view.tx, view.ty - y * view.s];

  function render(c2, W, H, s, tx, ty, isDark, lwPx = 0) {
    c2.setTransform(1, 0, 0, 1, 0, 0);
    c2.fillStyle = isDark ? "#1e2021" : "#ffffff";
    c2.fillRect(0, 0, W, H);
    c2.setTransform(s, 0, 0, -s, tx, ty);
    c2.lineJoin = "round";
    for (const im of model.images || []) { // immagini sotto al disegno (loghi, foto, timbri)
      const L = model.layers.get(im.layer);
      if ((L && L.off) || !im.img?.complete || !im.img.naturalWidth) continue;
      c2.save();
      c2.transform(...im.A);
      c2.drawImage(im.img, 0, 0, im.w, im.h);
      c2.restore();
    }
    for (const g of model.groups) {
      const L = model.layers.get(g.layer);
      if (L && L.off) continue;
      let col = g.color;
      if (!isDark && col[0] > 230 && col[1] > 230 && col[2] > 230) col = [20, 20, 20];
      c2.strokeStyle = c2.fillStyle = rgb(col);
      c2.globalAlpha = g.a ?? 1; // trasparenza dell'entita' (evidenziatore delle revisioni)
      if (g.fills.length) c2.fill(g.fillPath);
      if (!g.lines.length) continue;
      const lw = g.lw >= 0 ? g.lw : 25;
      c2.lineWidth = (lwPx && lw > 25 ? Math.max(1, lw / 100 * lwPx) : lineScale.v) / s;
      // tipo linea: trattini in unita' del disegno (si disegna continua se troppo fitto per lo schermo)
      const total = g.dash ? g.dash.reduce((a, b) => a + b, 0) : 0;
      c2.setLineDash(g.dash && total * s > 4 ? g.dash : []);
      c2.stroke(g.path);
    }
    c2.setLineDash([]);
    c2.globalAlpha = 1;
    if (showText) {
      for (const t of model.texts) {
        const L = model.layers.get(t.layer);
        if (L && L.off) continue;
        if (t.h * s < 2.5) continue; // illeggibile a questa scala
        let col = t.color;
        if (!isDark && col[0] > 230 && col[1] > 230 && col[2] > 230) col = [20, 20, 20];
        c2.save();
        c2.transform(...t.A);
        const k = t.F / 100;
        c2.scale(k, -k);
        c2.fillStyle = rgb(col);
        c2.font = "100px Arial, sans-serif";
        c2.textAlign = "left";
        c2.textBaseline = "alphabetic";
        for (const r of t.rows) c2.fillText(r.s, r.x / k, -r.y / k);
        c2.restore();
      }
    }
  }

  function draw() {
    ensureSize();
    for (const L of sortedLayers) { const M = model.layers.get(L.name); if (M) M.off = L.off; }
    const dpr = devicePixelRatio || 1;
    render(g2, canvas.width, canvas.height, view.s, view.tx, view.ty, dark, showLw ? 3.78 * dpr : 0);
    g2.setTransform(1, 0, 0, 1, 0, 0);
    editor?.overlay(g2);
    ink?.refresh();
    meas?.paint(g2);
    if (measure && (mpts.length || msnap)) {
      g2.strokeStyle = "#ff9f1a";
      g2.fillStyle = "#ff9f1a";
      g2.lineWidth = 2 * dpr;
      const sp = mpts.map(p => toScreen(p[0], p[1]));
      g2.beginPath();
      sp.forEach(([x, y], k) => (k ? g2.lineTo(x, y) : g2.moveTo(x, y)));
      g2.stroke();
      sp.forEach(([x, y]) => { g2.beginPath(); g2.arc(x, y, 4 * dpr, 0, 7); g2.fill(); });
      if (mpts.length === 2) {
        const d = Math.hypot(mpts[1][0] - mpts[0][0], mpts[1][1] - mpts[0][1]);
        const dx = mpts[1][0] - mpts[0][0], dy = mpts[1][1] - mpts[0][1];
        const label = `${fmt(d)}   (dx ${fmt(dx)}  dy ${fmt(dy)}  ∠ ${fmt(Math.atan2(dy, dx) * R2D)}°)`;
        g2.font = `${13 * dpr}px Segoe UI, sans-serif`;
        const [mx, my] = [(sp[0][0] + sp[1][0]) / 2, (sp[0][1] + sp[1][1]) / 2];
        const w = g2.measureText(label).width + 12;
        g2.fillStyle = "rgba(0,0,0,.75)";
        g2.fillRect(mx - w / 2, my - 28 * dpr, w, 22 * dpr);
        g2.fillStyle = "#fff";
        g2.textAlign = "center";
        g2.fillText(label, mx, my - 12 * dpr);
        g2.textAlign = "left";
      }
      if (msnap) { const [x, y] = toScreen(msnap.x, msnap.y); drawSnapMarker(g2, x, y, msnap.k, dpr); }
    }
  }
  const fmt = v => v.toLocaleString(LOCALE, { maximumFractionDigits: 4 });

  function zoomAt(f, px = canvas.width / 2, py = canvas.height / 2) {
    view.tx = px - (px - view.tx) * f;
    view.ty = py - (py - view.ty) * f;
    view.s *= f;
    draw();
  }

  // aggancio per Misura (l'editor ha il suo, con le modalita' scelte)
  const MSNAP = { end: true, mid: true, cen: true, int: true, qua: true, ins: true, nod: true };
  function snapM(px, py) {
    const [wx, wy] = toWorld(px, py);
    const tol = 10 * (devicePixelRatio || 1) / view.s;
    return osnap(model, wx, wy, tol, MSNAP, null, it => model.layers.get(it.l)?.off);
  }

  let drag = null;
  const capture = e => { try { canvas.setPointerCapture(e.pointerId); } catch { /* eventi sintetici */ } };
  const pos = e => { const r = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1; return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr]; };
  canvas.addEventListener("pointerdown", e => {
    const [px, py] = pos(e);
    if (e.button === 0 && meas?.down(e, px, py)) { capture(e); return; }
    if (e.button === 0 && editor?.pointerDown(e, px, py)) { capture(e); return; }
    if (measure && e.button === 0) {
      if (mpts.length === 2) mpts = [];
      const s = snapM(px, py);
      mpts.push(s ? [s.x, s.y] : toWorld(px, py));
      if (mpts.length === 2) ctx.status(tr("v_cad2d.distanza") + fmt(Math.hypot(mpts[1][0] - mpts[0][0], mpts[1][1] - mpts[0][1])));
      draw();
      return;
    }
    // trascinamento della vista: sinistro (fuori dall'editor), centrale, destro (nell'editor: clic destro senza trascinare = Invio)
    drag = { px, py, tx: view.tx, ty: view.ty, button: e.button, moved: false };
    capture(e);
  });
  canvas.addEventListener("pointermove", e => {
    const [px, py] = pos(e);
    const [wx, wy] = toWorld(px, py);
    if (drag) {
      if (Math.hypot(px - drag.px, py - drag.py) > 4) drag.moved = true;
      if (drag.moved) { view.tx = drag.tx + (px - drag.px); view.ty = drag.ty + (py - drag.py); draw(); }
      return;
    }
    if (!measure && !editor?.on) ctx.status(`X ${fmt(wx)}  Y ${fmt(wy)}`);
    if (meas?.move(e, px, py)) return;
    if (editor?.pointerMove(e, px, py)) return;
    if (measure) { msnap = snapM(px, py); draw(); }
  });
  canvas.addEventListener("pointerup", e => {
    const [px, py] = pos(e);
    if (drag) { const d = drag; drag = null; if (!d.moved && d.button === 2 && !meas?.context()) editor?.rightClick(); return; }
    if (meas?.up(e, px, py)) return;
    editor?.pointerUp(e, px, py);
  });
  canvas.addEventListener("pointerleave", () => editor?.pointerLeave());
  // tablet: pizzico = zoom, due dita = sposta (il primo dito resta per spostare, misurare e modificare)
  pinchPan(canvas, {
    onStart: () => { drag = null; editor?.pointerLeave(); },
    onPan: (dx, dy) => { const d = devicePixelRatio || 1; view.tx += dx * d; view.ty += dy * d; draw(); },
    onZoom: (f, cx, cy) => { const d = devicePixelRatio || 1; zoomAt(f, cx * d, cy * d); },
  });
  canvas.addEventListener("contextmenu", e => e.preventDefault());
  // ---- passaggio 2D / 3D
  let mode3d = false, api3d = null, built3d = false;
  async function show3d() {
    mode3d = true;
    wrap.style.display = "none"; host3d.style.display = "flex"; tb2d.style.display = "none"; tb3d.style.display = "contents";
    viewBtn.lastChild.textContent = tr("cad3d.vista_2d_btn"); viewBtn.title = tr("cad3d.vista_2d_tip");
    if (built3d) { api3d?.onShow?.(); return; }
    built3d = true;
    const body = el("div", { class: "body fill", style: { flex: "1 1 auto", minHeight: 0, position: "relative" } });
    host3d.append(body);
    const info = {};
    const bb = model.bbox;
    const sub = { ...ctx, el: body, tb: tb3d, info: { nome: ctx.name }, extraPaths: [], fillBody() {}, status: s => ctx.status(s),
      preloaded: async ld2 => { const { loadCad3d } = await import("../cad3d.js"); const r = await loadCad3d({ path: ctx.path, name: ctx.name, origin: [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2] }, db, ld2, info, { ACI, dark: (await import("../monaco.js")).isDark() }); return r; } };
    try {
      const mod = await import("./model3d.js");
      api3d = await mod.mount(sub);
      if (info.status) ctx.status(info.status);
      const { cad3dWarnings } = await import("../cad3d.js");
      const w = cad3dWarnings(info.cad3d);
      if (w.length) toast(w.join(" · "), true, 10000);
    } catch (e) {
      console.error(e);
      body.innerHTML = "";
      body.append(el("div", { class: "center" }, el("div", { class: "panel", style: { maxWidth: "560px", textAlign: "left" } }, el("h3", { style: { marginTop: 0 } }, tr("cad3d.non_visualizzabile")), el("p", { class: "err" }, e.message))));
    }
  }
  function show2d() {
    mode3d = false;
    host3d.style.display = "none"; wrap.style.display = ""; tb3d.style.display = "none"; tb2d.style.display = "contents";
    viewBtn.lastChild.textContent = tr("cad3d.vista_3d_btn"); viewBtn.title = tr("cad3d.vista_3d_tip");
    resize(); draw();
  }
  // disegno prevalentemente 3D: si apre subito in 3D (come lo mostrerebbe AutoCAD); altrimenti un avviso
  if (scan3d.mostly) setTimeout(show3d, 0);
  else if (scan3d.solids + scan3d.meshes + scan3d.thick > 0) toast(tr("cad3d.contiene_3d"), false, 7000);

  const onKey = e => { if (ctx.tab.view.hidden || mode3d) return; if (meas?.key(e)) { e.preventDefault(); return; } if (editor?.key(e)) e.preventDefault(); };
  window.addEventListener("keydown", onKey);
  canvas.addEventListener("wheel", e => { e.preventDefault(); const [px, py] = pos(e); zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, px, py); }, { passive: false });
  canvas.addEventListener("dblclick", e => { if (meas?.dbl(e, ...pos(e))) return; if (editor?.dblclick(e)) return; if (!measure && !editor?.on) fit(); });
  new ResizeObserver(() => { const s = canvas.width; resize(); if (s <= 1) fit(); else draw(); }).observe(canvas);
  requestAnimationFrame(fit);

  // ---- esportazioni
  function offscreen(maxSide = 4000) {
    const [x0, y0, x1, y1] = model.bbox, w = x1 - x0, h = y1 - y0;
    const k = maxSide / Math.max(w, h);
    const c = document.createElement("canvas");
    c.width = Math.ceil(w * k * 1.04);
    c.height = Math.ceil(h * k * 1.04);
    const tx = c.width / 2 - k * (x0 + x1) / 2, ty = c.height / 2 + k * (y0 + y1) / 2;
    render(c.getContext("2d"), c.width, c.height, k, tx, ty, false);
    if (ink?.hasStrokes()) for (const st of ink.strokes) paintInk(c.getContext("2d"), st, (x, y) => [x * k + tx, ty - y * k], k);
    return c;
  }
  async function exportPng() {
    const c = offscreen();
    const blob = await new Promise(r => c.toBlob(r, "image/png"));
    await saveBlobAs(withExt(ctx.name, "png"), blob, ctx.path.replace(/[\\/][^\\/]*$/, ""));
  }
  async function exportPdf() {
    await saveBlobAs(withExt(ctx.name, "pdf"), new Blob([await pdfBytes()]), ctx.path.replace(/[\\/][^\\/]*$/, ""));
  }
  async function pdfBytes() {
    const c = offscreen(5000);
    const jpg = await new Promise(r => c.toBlob(r, "image/jpeg", 0.92));
    return jpegToPdf(new Uint8Array(await jpg.arrayBuffer()), c.width, c.height);
  }
  async function exportSvg() {
    const [x0, y0, x1, y1] = model.bbox;
    const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${-y1} ${x1 - x0} ${y1 - y0}" style="background:#fff">`];
    for (const g of model.groups) {
      const L = model.layers.get(g.layer);
      if (L?.off) continue;
      let col = g.color;
      if (col[0] > 230 && col[1] > 230 && col[2] > 230) col = [0, 0, 0];
      const d = g.lines.map(({ pts, closed }) => "M" + pts.map(p => p[0].toFixed(4) + " " + (-p[1]).toFixed(4)).join("L") + (closed ? "Z" : "")).join("");
      const f = g.fills.map(({ pts }) => "M" + pts.map(p => p[0].toFixed(4) + " " + (-p[1]).toFixed(4)).join("L") + "Z").join("");
      parts.push(`<g data-layer="${esc(g.layer)}">`);
      if (f) parts.push(`<path d="${f}" fill="${rgb(col)}"/>`);
      if (d) parts.push(`<path d="${d}" fill="none" stroke="${rgb(col)}" stroke-width="${(x1 - x0) / 2500}"/>`);
      parts.push("</g>");
    }
    for (const t of model.texts) {
      if (model.layers.get(t.layer)?.off) continue;
      let col = t.color;
      if (col[0] > 230 && col[1] > 230 && col[2] > 230) col = [0, 0, 0];
      const k = t.F / 100, m = mul([1, 0, 0, -1, 0, 0], mul(t.A, [k, 0, 0, -k, 0, 0]));
      for (const r of t.rows) parts.push(`<text x="${(r.x / k).toFixed(3)}" y="${(-r.y / k).toFixed(3)}" font-size="100" font-family="Arial" fill="${rgb(col)}" transform="matrix(${m.map(v => +v.toFixed(6)).join(" ")})">${esc(r.s)}</text>`);
    }
    if (ink?.hasStrokes()) {
      parts.push(`<g data-layer="${LAYER_PEN}" fill="none" stroke-linecap="round" stroke-linejoin="round">`);
      for (const st of ink.strokes) {
        const P = st.pts, op = st.o < 1 ? ` stroke-opacity="${st.o}"` : "";
        if (st.tool === "hl" || !st.pressure || P.length < 2) parts.push(`<path d="M${P.map(p => p[0].toFixed(4) + " " + (-p[1]).toFixed(4)).join("L")}${P.length < 2 ? "h0.0001" : ""}" stroke="${st.color}" stroke-width="${widthAt(st, 0).toFixed(4)}"${op}/>`);
        else for (let i = 1; i < P.length; i++) parts.push(`<path d="M${P[i - 1][0].toFixed(4)} ${(-P[i - 1][1]).toFixed(4)}L${P[i][0].toFixed(4)} ${(-P[i][1]).toFixed(4)}" stroke="${st.color}" stroke-width="${((widthAt(st, i - 1) + widthAt(st, i)) / 2).toFixed(4)}"/>`);
      }
      parts.push("</g>");
    }
    parts.push("</svg>");
    await saveBlobAs(withExt(ctx.name, "svg"), new Blob([parts.join("")], { type: "image/svg+xml" }), ctx.path.replace(/[\\/][^\\/]*$/, ""));
  }

  ctx.status(tr("v_cad2d.0_elementi_1_testi", model.groups.reduce((n, g) => n + g.lines.length, 0).toLocaleString(LOCALE), model.texts.length));
  if (editor && !editor.on) editor.toggle(); // strumenti di modifica visibili da subito, come in AutoCAD
  return {
    onShow() { if (mode3d) api3d?.onShow?.(); else { resize(); draw(); } },
    onBack() { return false; },
    // finestra Stampa (ui/js/print.js): modifiche e layer accesi/spenti, vista attuale, limiti, clic -> coordinate
    printSource() {
      const H = db.header || {}, pt = v => (v ? (Array.isArray(v) ? v : [v.x, v.y]) : null);
      const lo = pt(H.LIMMIN || H.$LIMMIN), hi = pt(H.LIMMAX || H.$LIMMAX);
      return { kind: dxfText ? "dxf" : "dwg", edits: editor ? editor.payload() : null, canvas, toWorld,
        view: [...toWorld(0, canvas.height), ...toWorld(canvas.width, 0)], limits: lo && hi && hi[0] > lo[0] && hi[1] > lo[1] ? [...lo, ...hi] : null };
    },
    saveInPlace: ctx.ext === "dxf",
    get saveFormats() { return editor ? ["dxf", "dwg", "pdf", "svg", "png"] : ink?.hasStrokes() ? ["dxf", "png", "pdf"] : ["png", "svg", "pdf"]; },
    get saveLabels() { return !editor && !srcText ? { dxf: tr("ink.solo_revisioni_dxf") } : undefined; },
    saveAsName: () => (!editor && !srcText && ink?.hasStrokes() ? ctx.name.replace(/\.[^.]+$/, "") + "-" + tr("ink.nome_revisioni") + ".dxf" : withExt(ctx.name, "dxf")),
    async save(target) {
      const ext = target.split(".").pop().toLowerCase();
      if (!editor && ext === "dxf" && ink?.hasStrokes()) {
        // DXF: revisioni aggiunte al file (layer MARKUP); DWG: DXF a parte con le sole revisioni, nelle stesse coordinate
        const { addMarkupToDxf, markupOnlyDxf } = await import("../inkdxf.js");
        const text = srcText ? addMarkupToDxf(srcText, ink.strokes) : markupOnlyDxf(ink.strokes);
        await api("save", { path: target }, { body: encodeText(text, srcText ? srcEnc : "windows-1252") });
        if (srcText && target === ctx.path) {
          srcText = text;
          db = parseDxf(text); normalize(db, "dxf");
          model = build(db); refreshLayers(); ink.reset(); draw();
        }
        ctx.setDirty(false);
        return { switchTo: false };
      }
      if (!editor && ext === "pdf") { await api("save", { path: target }, { body: await pdfBytes() }); return { switchTo: false }; }
      if (editor && ["dxf", "dwg", "pdf", "svg", "png"].includes(ext)) {
        const r = await api("cad_save", { path: ctx.path }, { json: { out: target, edits: editor.payload() } });
        if (r.non_scritti) toast(tr("v_cad2d.0_elementi_tipo_non_supportato", r.non_scritti), true, 6000);
        return { switchTo: ext === ctx.ext };
      }
      if (ext === "png") { const c = offscreen(); await api("save", { path: target }, { body: new Uint8Array(await (await new Promise(r => c.toBlob(r, "image/png"))).arrayBuffer()) }); return { switchTo: false }; }
      throw new Error(tr("v_cad2d.usa_i_pulsanti_png_svg"));
    },
    dispose() { window.removeEventListener("keydown", onKey); meas?.dispose(); try { api3d?.dispose?.(); } catch { /* */ } },
    get view3d() { return mode3d; }, show3d: () => show3d(), show2d: () => show2d(), // collaudo dalla console
    _meas: { get: measGet }, // collaudo dalla console: (await MB.active.api._meas.get()).M
  };
}

// testo -> byte nella codifica del file originale (i DXF vecchi sono in Windows-1252)
function encodeText(text, enc) {
  if (enc === "utf-8") return new TextEncoder().encode(text);
  const dec = new TextDecoder("windows-1252"), map = new Map();
  for (let b = 0; b < 256; b++) map.set(dec.decode(new Uint8Array([b])), b);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = map.get(text[i]) ?? 63;
  return out;
}

function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function isUtf8(b) { try { new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(0, 300000)); return true; } catch { return false; } }

// PDF minimale con un'immagine JPEG a pagina intera (formato pagina proporzionato al disegno)
function jpegToPdf(jpg, w, h) {
  const pw = 842, ph = Math.round(842 * h / w);
  const enc = s => new TextEncoder().encode(s);
  const chunks = [], offsets = [];
  let len = 0;
  const push = b => { chunks.push(b); len += b.length; };
  push(enc("%PDF-1.4\n"));
  const obj = (n, body, stream) => {
    offsets[n] = len;
    push(enc(`${n} 0 obj\n${body}\n`));
    if (stream) { push(enc("stream\n")); push(stream); push(enc("\nendstream\n")); }
    push(enc("endobj\n"));
  };
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  obj(4, `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>`, jpg);
  const content = enc(`q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`);
  obj(5, `<< /Length ${content.length} >>`, content);
  const xref = len;
  let x = "xref\n0 6\n0000000000 65535 f \n";
  for (let n = 1; n <= 5; n++) x += String(offsets[n]).padStart(10, "0") + " 00000 n \n";
  push(enc(x + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`));
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// lettura del disegno senza interfaccia: confronto tra revisioni (ui/js/compare/cadcmp.js)
export async function readDrawing(path, ext, ld = { set() {} }) {
  const bytes = await readBytes(path);
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 6));
  const dxfText = ext === "dxf" && !head.startsWith("AutoCA");
  const db = dxfText ? parseDxf(new TextDecoder(isUtf8(bytes) ? "utf-8" : "windows-1252").decode(bytes)) : await decodeDwg(bytes, { ext, tools: {} }, ld);
  normalize(db, dxfText ? "dxf" : "dwg");
  return db;
}
export { build as buildModel, ACI };
