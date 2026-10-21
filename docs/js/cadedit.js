// Editor dei disegni CAD 2D (DWG/DXF): selezione, proprieta' (layer, colore, geometria), Sposta / Copia / Ruota /
// Elimina, disegno di linee, polilinee, rettangoli, cerchi e testi, aggancio ai punti, ortogonale, Annulla / Ripeti.
// Le entita' modificate restano nel formato del lettore; al salvataggio il motore ezdxf scrive il DXF (per i file DXF
// applica le modifiche all'originale per handle, cosi' tutto il resto resta identico).
import { askText, el, toast } from "./core.js";

const clone = o => JSON.parse(JSON.stringify(o));
const R2D = 180 / Math.PI;
const COLORS = [[256, "Da layer"], [1, "Rosso"], [2, "Giallo"], [3, "Verde"], [4, "Ciano"], [5, "Blu"], [6, "Magenta"], [7, "Bianco/Nero"], [8, "Grigio scuro"], [9, "Grigio"], [30, "Arancio"], [0, "Da blocco"]];
const TYPE_IT = { LINE: "Linea", CIRCLE: "Cerchio", ARC: "Arco", ELLIPSE: "Ellisse", LWPOLYLINE: "Polilinea", POLYLINE2D: "Polilinea 2D", POLYLINE3D: "Polilinea 3D", SPLINE: "Spline",
  TEXT: "Testo", MTEXT: "Testo multiriga", INSERT: "Blocco", DIMENSION: "Quota", HATCH: "Retino", POINT: "Punto", SOLID: "Solido 2D", LEADER: "Direttrice", "3DFACE": "Faccia 3D", ATTRIB: "Attributo" };

// ---------------------------------------------------------------- trasformazioni delle entita' (traslazione / rotazione)
function mapPoints(e, f, blocks) {
  const P = p => { if (p && typeof p.x === "number") { const [x, y] = f(p.x, p.y); p.x = x; p.y = y; } };
  ["startPoint", "endPoint", "center", "position", "insertionPoint", "corner1", "corner2", "corner3", "corner4", "definitionPoint", "textPoint", "subDefinitionPoint1", "subDefinitionPoint2"].forEach(k => P(e[k]));
  (e.vertices || []).forEach(v => { if (typeof v.x === "number") { const [x, y] = f(v.x, v.y); v.x = x; v.y = y; } P(v.point); });
  (e.controlPoints || []).forEach(P);
  (e.fitPoints || []).forEach(P);
  for (const path of e.boundaryPaths || []) { (path.vertices || []).forEach(v => { const [x, y] = f(v.x, v.y); v.x = x; v.y = y; }); (path.edges || []).forEach(ed => { P(ed.start); P(ed.end); P(ed.center); (ed.controlPoints || []).forEach(P); }); }
  (e.attribs || []).forEach(a => mapPoints(a, f));
  if (e.type === "DIMENSION" && blocks) { const b = blocks.get(e.name); if (b) (b.entities || []).forEach(x => mapPoints(x, f)); }
}
function translate(e, dx, dy, blocks) { mapPoints(e, (x, y) => [x + dx, y + dy], blocks); compose(e, [1, 0, 0, 1, dx, dy]); }
function rotate(e, cx, cy, a, blocks) {
  const c = Math.cos(a), s = Math.sin(a);
  mapPoints(e, (x, y) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c], blocks);
  if (e.type === "ARC") { e.startAngle += a; e.endAngle += a; }
  if (["TEXT", "INSERT", "ATTRIB"].includes(e.type)) e.rotation = (e.rotation || 0) + a;
  if (e.type === "MTEXT") { if (e.direction && (e.direction.x || e.direction.y)) { const d = e.direction; const x = d.x * c - d.y * s, y = d.x * s + d.y * c; d.x = x; d.y = y; } else e.rotation = (e.rotation || 0) + a; }
  if (e.type === "ELLIPSE" && e.majorAxisEndPoint) { const m = e.majorAxisEndPoint; const x = m.x * c - m.y * s, y = m.x * s + m.y * c; m.x = x; m.y = y; }
  (e.attribs || []).forEach(t => { t.rotation = (t.rotation || 0) + a; });
  compose(e, [c, s, -s, c, cx - cx * c + cy * s, cy - cx * s - cy * c]);
}
// trasformazione cumulata: per i tipi complessi (quote, retini...) il salvataggio DXF la applica all'originale
function compose(e, m) {
  const p = e._xf || [1, 0, 0, 1, 0, 0];
  e._xf = [m[0] * p[0] + m[2] * p[1], m[1] * p[0] + m[3] * p[1], m[0] * p[2] + m[2] * p[3], m[1] * p[2] + m[3] * p[3], m[0] * p[4] + m[2] * p[5] + m[4], m[1] * p[4] + m[3] * p[5] + m[5]];
}

const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

export function createCadEditor(o) {
  const { ctx, db, sourceKind, ACI } = o;
  const blocks = new Map((db.tables.BLOCK_RECORD?.entries || []).map(b => [b.name, b]));
  let on = false, tool = "select", sel = new Set(), pts = [], cursor = null, box = null, ortho = false;
  let curLayer = "0", curColor = 256, textH = 2.5;
  const undo = [], redo = [];
  const newLayers = new Map();
  const model = () => o.getModel();

  // ---- comandi con Annulla / Ripeti: si memorizza lo stato prima e dopo delle entita' toccate
  function command(indices, fn) {
    const before = indices.map(i => [i, clone(db.entities[i])]);
    const n0 = db.entities.length;
    fn();
    const added = [];
    for (let i = n0; i < db.entities.length; i++) added.push(i);
    const after = [...indices, ...added].map(i => [i, clone(db.entities[i])]);
    for (const [i] of after) db.entities[i]._dirty = true;
    undo.push({ before, after, added });
    redo.length = 0;
    changed();
  }
  function apply(states) { for (const [i, s] of states) db.entities[i] = clone(s); }
  function doUndo() {
    const c = undo.pop();
    if (!c) return toast("Niente da annullare");
    apply(c.before);
    for (const i of c.added) db.entities[i]._deleted = true;
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
  function changed() { ctx.setDirty(true); o.rebuild(); renderProps(); }

  // ---- ricerca dell'entita' sotto il cursore
  function pick(wx, wy) {
    const m = model(), tol = 8 * (devicePixelRatio || 1) / o.view.s;
    let best = -1, bd = tol;
    m.ents.forEach((polys, i) => {
      if (!polys || db.entities[i]?._deleted) return;
      const L = m.layers.get(db.entities[i].layer === undefined ? "0" : db.entities[i].layer);
      if (L?.off) return;
      for (const p of polys) {
        if (p.box) { if (wx >= p.box[0] && wx <= p.box[2] && wy >= p.box[1] && wy <= p.box[3]) { bd = 0; best = i; } continue; }
        for (let k = 1; k < p.length; k++) { const d = segDist(wx, wy, p[k - 1][0], p[k - 1][1], p[k][0], p[k][1]); if (d < bd) { bd = d; best = i; } }
      }
    });
    return best;
  }
  function inWindow(x0, y0, x1, y1) {
    const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)], [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
    const out = [];
    model().ents.forEach((polys, i) => {
      if (!polys || db.entities[i]?._deleted) return;
      const all = polys.every(p => (p.box ? [[p.box[0], p.box[1]], [p.box[2], p.box[3]]] : p).every(([x, y]) => x >= ax && x <= bx && y >= ay && y <= by));
      if (all && polys.length) out.push(i);
    });
    return out;
  }

  const snapPt = (px, py) => o.snap(px, py);
  function constrain(p) {
    if (!ortho || !pts.length) return p;
    const q = pts[pts.length - 1];
    return Math.abs(p[0] - q[0]) > Math.abs(p[1] - q[1]) ? [p[0], q[1]] : [q[0], p[1]];
  }
  const base = () => ({ layer: curLayer, colorIndex: curColor, _new: true });
  const P = ([x, y]) => ({ x, y, z: 0 });

  // ---- strumenti
  const TOOLS = {
    select: "Seleziona: clic su un elemento o riquadro (Ctrl o Maiusc aggiungono) · Canc elimina · tasto destro: sposta la vista",
    move: "Sposta: clic sul punto base, poi sul punto di arrivo",
    copy: "Copia: clic sul punto base, poi sui punti di arrivo (Esc per finire)",
    rotate: "Ruota: clic sul centro di rotazione, poi scrivi l'angolo",
    line: "Linea: clic sui punti (Esc per finire) · F8 ortogonale",
    pline: "Polilinea: clic sui punti, Invio o doppio clic per finire, C per chiuderla",
    rect: "Rettangolo: clic sui due angoli opposti",
    circle: "Cerchio: clic sul centro, poi su un punto della circonferenza",
    text: "Testo: clic sul punto di inserimento",
  };
  function setTool(t) {
    if ((t === "move" || t === "copy" || t === "rotate") && !sel.size) { toast("Seleziona prima gli elementi", true); t = "select"; }
    if (tool === "pline" && pts.length > 1) finishPline(false);
    tool = t; pts = [];
    for (const [k, b] of Object.entries(btns)) b.classList.toggle("on", k === tool);
    ctx.status(TOOLS[tool]);
    o.draw();
  }
  function finishPline(close) {
    if (pts.length < 2) { pts = []; return; }
    const v = pts.map(([x, y]) => ({ x, y, bulge: 0 }));
    command([], () => db.entities.push({ ...base(), type: "LWPOLYLINE", flag: close ? 1 : 0, vertices: v }));
    pts = [];
  }

  async function click(p, ev) {
    if (tool === "select") return;
    if (tool === "line") {
      pts.push(p);
      if (pts.length >= 2) { const [a, b] = pts.slice(-2); command([], () => db.entities.push({ ...base(), type: "LINE", startPoint: P(a), endPoint: P(b) })); }
      return;
    }
    if (tool === "pline") { pts.push(p); return; }
    if (tool === "rect") {
      pts.push(p);
      if (pts.length === 2) {
        const [[x0, y0], [x1, y1]] = pts;
        command([], () => db.entities.push({ ...base(), type: "LWPOLYLINE", flag: 1, vertices: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => ({ x, y, bulge: 0 })) }));
        pts = [];
      }
      return;
    }
    if (tool === "circle") {
      pts.push(p);
      if (pts.length === 2) { const r = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]); if (r > 0) command([], () => db.entities.push({ ...base(), type: "CIRCLE", center: P(pts[0]), radius: r })); pts = []; }
      return;
    }
    if (tool === "text") {
      const s = await askText("Nuovo testo", `Testo (altezza ${textH})`);
      if (s) command([], () => db.entities.push({ ...base(), type: "TEXT", text: s, startPoint: P(p), textHeight: textH, rotation: 0 }));
      return;
    }
    if (tool === "move" || tool === "copy") {
      pts.push(p);
      if (pts.length === 2) {
        const dx = pts[1][0] - pts[0][0], dy = pts[1][1] - pts[0][1];
        const list = [...sel];
        if (tool === "move") { command(list, () => list.forEach(i => translate(db.entities[i], dx, dy, blocks))); setTool("select"); }
        else {
          command([], () => list.forEach(i => { const c = clone(db.entities[i]); delete c.handle; c._new = true; translate(c, dx, dy, null); if (c.type === "DIMENSION") c.type = "_skip"; db.entities.push(c); }));
          pts = [pts[0]];
        }
      }
      return;
    }
    if (tool === "rotate") {
      const s = await askText("Ruota", "Angolo in gradi (positivo = antiorario)", "90");
      const a = parseFloat(String(s || "").replace(",", "."));
      if (isFinite(a) && a) { const list = [...sel]; command(list, () => list.forEach(i => rotate(db.entities[i], p[0], p[1], a / R2D, blocks))); }
      setTool("select");
    }
  }

  function removeSel() {
    if (!sel.size) return;
    const list = [...sel];
    command(list, () => list.forEach(i => { db.entities[i]._deleted = true; }));
    sel.clear();
    changed();
  }

  // ---- disegno sopra la vista: selezione, anteprima dello strumento, punto agganciato
  function overlay(g2) {
    if (!on) return;
    const m = model(), dpr = devicePixelRatio || 1;
    g2.save();
    g2.lineWidth = 2.5 * dpr;
    g2.strokeStyle = "#ff9f1a";
    g2.setLineDash([]);
    for (const i of sel) for (const p of m.ents[i] || []) {
      g2.beginPath();
      if (p.box) { const [a, b] = [o.toScreen(p.box[0], p.box[1]), o.toScreen(p.box[2], p.box[3])]; g2.rect(a[0], b[1], b[0] - a[0], a[1] - b[1]); }
      else p.forEach(([x, y], k) => { const [sx, sy] = o.toScreen(x, y); k ? g2.lineTo(sx, sy) : g2.moveTo(sx, sy); });
      g2.stroke();
    }
    if (cursor && pts.length && tool !== "select") {
      g2.strokeStyle = "#4da3ff";
      g2.setLineDash([6 * dpr, 4 * dpr]);
      g2.lineWidth = 1.5 * dpr;
      const c = constrain(cursor);
      const S = q => o.toScreen(q[0], q[1]);
      g2.beginPath();
      if (tool === "rect") { const [a, b] = [S(pts[0]), S(c)]; g2.rect(a[0], a[1], b[0] - a[0], b[1] - a[1]); }
      else if (tool === "circle") { const [a] = [S(pts[0])]; const r = Math.hypot(c[0] - pts[0][0], c[1] - pts[0][1]) * o.view.s; g2.arc(a[0], a[1], r, 0, 7); }
      else { pts.forEach((q, k) => { const s = S(q); k ? g2.lineTo(...s) : g2.moveTo(...s); }); g2.lineTo(...S(c)); }
      g2.stroke();
    }
    if (box) {
      g2.setLineDash([5 * dpr, 3 * dpr]);
      g2.strokeStyle = "#4da3ff";
      g2.fillStyle = "rgba(77,163,255,.12)";
      g2.lineWidth = 1 * dpr;
      g2.fillRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
      g2.strokeRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
    }
    if (cursor && tool !== "select") {
      const [sx, sy] = o.toScreen(...constrain(cursor));
      g2.setLineDash([]);
      g2.strokeStyle = "#ffd400";
      g2.lineWidth = 1.5 * dpr;
      g2.strokeRect(sx - 5 * dpr, sy - 5 * dpr, 10 * dpr, 10 * dpr);
    }
    g2.restore();
  }

  // ---- eventi del mouse (la vista li passa qui quando l'editor e' attivo)
  let down = null;
  function pointerDown(e, px, py) {
    if (!on || e.button !== 0) return false;
    down = { px, py };
    return true;
  }
  function pointerMove(e, px, py) {
    if (!on) return false;
    cursor = tool === "select" ? null : snapPt(px, py);
    if (down && tool === "select" && Math.hypot(px - down.px, py - down.py) > 5) box = [Math.min(px, down.px), Math.min(py, down.py), Math.max(px, down.px), Math.max(py, down.py)];
    o.draw();
    return !!down;
  }
  function pointerUp(e, px, py) {
    if (!on || !down) return false;
    const add = e.ctrlKey || e.shiftKey;
    if (box) {
      const [a, b] = [o.toWorld(box[0], box[1]), o.toWorld(box[2], box[3])];
      const found = inWindow(a[0], a[1], b[0], b[1]);
      if (!add) sel.clear();
      found.forEach(i => sel.add(i));
      box = null;
      renderProps();
    } else if (tool === "select") {
      const [wx, wy] = o.toWorld(px, py);
      const i = pick(wx, wy);
      if (!add) sel.clear();
      if (i >= 0) { if (add && sel.has(i)) sel.delete(i); else sel.add(i); }
      renderProps();
    } else click(constrain(snapPt(px, py)), e);
    down = null;
    o.draw();
    return true;
  }
  function key(e) {
    if (!on || e.target.closest?.("input, textarea, select")) return false;
    const k = e.key.toLowerCase();
    if (k === "delete") { removeSel(); return true; }
    if (k === "escape") { if (tool === "pline" && pts.length > 1) finishPline(false); if (tool !== "select" || pts.length) setTool("select"); else { sel.clear(); renderProps(); o.draw(); } return true; }
    if (k === "enter" && tool === "pline") { finishPline(false); return true; }
    if (k === "c" && tool === "pline" && pts.length > 2) { finishPline(true); return true; }
    if (k === "f8") { ortho = !ortho; btns.ortho.classList.toggle("on", ortho); toast("Ortogonale " + (ortho ? "attivo" : "spento")); return true; }
    if (e.ctrlKey && k === "z") { doUndo(); return true; }
    if (e.ctrlKey && k === "y") { doRedo(); return true; }
    return false;
  }
  function dblclick() { if (on && tool === "pline") { finishPline(false); return true; } return false; }

  // ---- pannello delle proprieta'
  const props = el("div", { class: "cad-props", style: { borderTop: "1px solid var(--line)", padding: "8px 10px", fontSize: "12.5px", display: "none" } });
  const layerNames = () => [...new Set([...model().layers.keys(), ...newLayers.keys()])].sort((a, b) => a.localeCompare(b));
  function field(label, value, onchange, type = "text") {
    const inp = el("input", { type, value: value ?? "", class: "field", style: { width: "100%" } });
    inp.addEventListener("change", () => onchange(inp.value));
    return [el("dt", {}, label), el("dd", {}, inp)];
  }
  const num = v => { const n = parseFloat(String(v).replace(",", ".")); return isFinite(n) ? n : null; };
  const f4 = v => (typeof v === "number" ? +v.toFixed(4) : v);
  function edit(i, fn) { command([i], () => fn(db.entities[i])); }
  function renderProps() {
    props.innerHTML = "";
    if (!on || !sel.size) { props.style.display = "none"; return; }
    props.style.display = "";
    const list = [...sel], one = list.length === 1 ? db.entities[list[0]] : null;
    props.append(el("b", {}, one ? TYPE_IT[one.type] || one.type : `${list.length} elementi selezionati`));
    const dl = el("dl", { class: "kv stack", style: { marginTop: "6px" } });
    const layerSel = el("select", { class: "field", style: { width: "100%" } }, ...layerNames().map(n => el("option", { value: n, selected: one ? one.layer === n : undefined }, n)));
    layerSel.addEventListener("change", () => command(list, () => list.forEach(i => { db.entities[i].layer = layerSel.value; })));
    const colSel = el("select", { class: "field", style: { width: "100%" } }, ...COLORS.map(([v, n]) => el("option", { value: v, selected: one && (one.colorIndex ?? 256) === v ? true : undefined }, `${n}${v > 0 && v < 256 ? " (" + v + ")" : ""}`)));
    if (one && !COLORS.some(([v]) => v === (one.colorIndex ?? 256))) colSel.append(el("option", { value: one.colorIndex, selected: true }, `Indice ${one.colorIndex}`));
    colSel.addEventListener("change", () => command(list, () => list.forEach(i => { db.entities[i].colorIndex = +colSel.value; delete db.entities[i].color; })));
    dl.append(el("dt", {}, "Layer"), el("dd", {}, layerSel), el("dt", {}, "Colore"), el("dd", {}, colSel));
    if (one) {
      const i = list[0], e = one, pt = (k, lbl) => {
        if (!e[k]) return;
        dl.append(...field(lbl + " X", f4(e[k].x), v => { const n = num(v); if (n !== null) edit(i, x => { x[k].x = n; }); }));
        dl.append(...field(lbl + " Y", f4(e[k].y), v => { const n = num(v); if (n !== null) edit(i, x => { x[k].y = n; }); }));
      };
      if (e.handle) dl.append(el("dt", {}, "Handle"), el("dd", {}, String(e.handle)));
      if (e.type === "LINE") { pt("startPoint", "Inizio"); pt("endPoint", "Fine"); dl.append(el("dt", {}, "Lunghezza"), el("dd", {}, String(f4(Math.hypot(e.endPoint.x - e.startPoint.x, e.endPoint.y - e.startPoint.y))))); }
      if (e.type === "CIRCLE" || e.type === "ARC") { pt("center", "Centro"); dl.append(...field("Raggio", f4(e.radius), v => { const n = num(v); if (n > 0) edit(i, x => { x.radius = n; }); })); }
      if (e.type === "ARC") {
        dl.append(...field("Angolo iniziale (°)", f4(e.startAngle * R2D), v => { const n = num(v); if (n !== null) edit(i, x => { x.startAngle = n / R2D; }); }));
        dl.append(...field("Angolo finale (°)", f4(e.endAngle * R2D), v => { const n = num(v); if (n !== null) edit(i, x => { x.endAngle = n / R2D; }); }));
      }
      if (e.type === "TEXT" || e.type === "MTEXT" || e.type === "ATTRIB") {
        dl.append(...field("Testo", e.text, v => edit(i, x => { x.text = v; })));
        dl.append(...field("Altezza", f4(e.textHeight), v => { const n = num(v); if (n > 0) edit(i, x => { x.textHeight = n; }); }));
        dl.append(...field("Rotazione (°)", f4((e.rotation || 0) * R2D), v => { const n = num(v); if (n !== null) edit(i, x => { x.rotation = n / R2D; if (x.direction) x.direction = { x: Math.cos(n / R2D), y: Math.sin(n / R2D), z: 0 }; }); }));
        pt(e.type === "MTEXT" ? "insertionPoint" : "startPoint", "Inserimento");
      }
      if (e.type === "LWPOLYLINE" || e.type === "POLYLINE2D") {
        const cb = el("input", { type: "checkbox", checked: !!(e.flag & 1) });
        cb.addEventListener("change", () => edit(i, x => { x.flag = cb.checked ? (x.flag | 1) : (x.flag & ~1); }));
        let len = 0; const v = e.vertices || [];
        for (let k = 1; k < v.length; k++) len += Math.hypot((v[k].x ?? v[k].point?.x) - (v[k - 1].x ?? v[k - 1].point?.x), (v[k].y ?? v[k].point?.y) - (v[k - 1].y ?? v[k - 1].point?.y));
        dl.append(el("dt", {}, "Vertici"), el("dd", {}, String(v.length)), el("dt", {}, "Lunghezza"), el("dd", {}, String(f4(len))), el("dt", {}, "Chiusa"), el("dd", {}, cb));
      }
      if (e.type === "INSERT") {
        dl.append(el("dt", {}, "Nome blocco"), el("dd", {}, e.name || ""));
        pt("insertionPoint", "Inserimento");
        dl.append(...field("Scala X", f4(e.xScale || 1), v => { const n = num(v); if (n) edit(i, x => { x.xScale = n; }); }));
        dl.append(...field("Scala Y", f4(e.yScale || 1), v => { const n = num(v); if (n) edit(i, x => { x.yScale = n; }); }));
        dl.append(...field("Rotazione (°)", f4((e.rotation || 0) * R2D), v => { const n = num(v); if (n !== null) edit(i, x => { x.rotation = n / R2D; }); }));
        for (const [k, a] of (e.attribs || []).entries()) dl.append(...field(`Attributo ${a.tag || k + 1}`, a.text, v => edit(i, x => { x.attribs[k].text = v; })));
      }
      if (e.type === "POINT") pt("position", "Posizione");
      if (e.type === "DIMENSION" && e.text !== undefined) dl.append(el("dt", {}, "Testo quota"), el("dd", {}, String(e.text || "<misura>")));
    }
    props.append(dl, el("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "6px" } },
      el("button", { class: "btn", onclick: () => setTool("move") }, "Sposta"), el("button", { class: "btn", onclick: () => setTool("copy") }, "Copia"),
      el("button", { class: "btn", onclick: () => setTool("rotate") }, "Ruota"), el("button", { class: "btn", onclick: removeSel }, "Elimina")));
  }

  // ---- barra degli strumenti di modifica (visibile quando l'editor e' attivo)
  const btns = {};
  const mk = (k, label, title) => (btns[k] = el("button", { class: "btn", title, onclick: () => setTool(k) }, label));
  const layerPick = el("select", { class: "field", title: "Layer corrente per i nuovi elementi" });
  const colorPick = el("select", { class: "field", title: "Colore dei nuovi elementi" }, ...COLORS.slice(0, 11).map(([v, n]) => el("option", { value: v }, n)));
  colorPick.addEventListener("change", () => { curColor = +colorPick.value; });
  layerPick.addEventListener("change", async () => {
    if (layerPick.value === "__new") {
      const n = await askText("Nuovo layer", "Nome del layer");
      if (n) { newLayers.set(n, { name: n, aci: 7 }); curLayer = n; ctx.setDirty(true); } else layerPick.value = curLayer;
      fillLayers();
    } else curLayer = layerPick.value;
  });
  function fillLayers() {
    layerPick.innerHTML = "";
    const names = layerNames();
    if (!names.includes(curLayer)) curLayer = names.includes("0") || !names.length ? "0" : names[0]; // il layer mostrato e' quello usato
    if (!names.includes(curLayer)) names.unshift(curLayer);
    for (const n of names) layerPick.append(el("option", { value: n, selected: n === curLayer || undefined }, n));
    layerPick.append(el("option", { value: "__new" }, "+ Nuovo layer..."));
  }
  btns.ortho = el("button", { class: "btn", title: "Ortogonale (F8)", onclick: () => key({ key: "F8", target: document.body }) }, "Orto");
  const hInput = el("input", { type: "text", class: "field", value: textH, title: "Altezza dei nuovi testi", style: { width: "56px" } });
  hInput.addEventListener("change", () => { const n = num(hInput.value); if (n > 0) textH = n; });
  const bar = el("div", { class: "tb", style: { display: "none", flexWrap: "wrap", gap: "6px", borderTop: "1px solid var(--line)" } },
    mk("select", "Seleziona", "Seleziona elementi"), mk("line", "Linea", "Disegna linee"), mk("pline", "Polilinea", "Disegna una polilinea"), mk("rect", "Rettangolo", "Disegna un rettangolo"),
    mk("circle", "Cerchio", "Disegna un cerchio"), mk("text", "Testo", "Inserisci un testo"), el("span", { class: "sep" }),
    mk("move", "Sposta", "Sposta la selezione"), mk("copy", "Copia", "Copia la selezione"), mk("rotate", "Ruota", "Ruota la selezione"),
    el("button", { class: "btn", title: "Elimina la selezione (Canc)", onclick: removeSel }, "Elimina"), el("span", { class: "sep" }),
    el("button", { class: "btn", title: "Annulla (Ctrl+Z)", onclick: doUndo }, "Annulla"), el("button", { class: "btn", title: "Ripeti (Ctrl+Y)", onclick: doRedo }, "Ripeti"), btns.ortho,
    el("span", { class: "sep" }), el("span", { class: "note" }, "Layer"), layerPick, el("span", { class: "note" }, "Colore"), colorPick, el("span", { class: "note" }, "H testo"), hInput);

  return {
    bar, props, overlay, pointerDown, pointerMove, pointerUp, key, dblclick,
    get on() { return on; },
    toggle() {
      on = !on;
      bar.style.display = on ? "flex" : "none";
      if (on) { fillLayers(); setTool("select"); ctx.status(TOOLS.select); } else { sel.clear(); pts = []; box = null; }
      renderProps();
      o.draw();
      return on;
    },
    hasEdits: () => undo.length > 0 || newLayers.size > 0,
    // dati per il salvataggio (ezdxf)
    payload() {
      const layers = [...newLayers.values()];
      for (const L of model().layers.values()) layers.push({ name: L.name, aci: L.aci, off: L.off });
      if (sourceKind === "dxf") {
        const changedE = [], deleted = [], added = [];
        // posizione nel model space del file: identifica le entita' dei DXF senza handle (stile R12)
        let msp = 0;
        db.entities.forEach(e => {
          if (e._new) { if (!e._deleted && e.type !== "_skip") added.push(e); return; }
          const pos = e.isInPaperSpace ? null : msp++;
          if (e._deleted) { deleted.push({ handle: e.handle, msp: pos }); return; }
          if (e._dirty) { const c = { ...e, _msp: pos }; if (e._xf) c._move = [e._xf[4], e._xf[5]]; changedE.push(c); }
        });
        return { source: "dxf", changed: changedE, deleted, added, layers };
      }
      return { source: "dwg", layers, db: { tables: db.tables, entities: db.entities.filter(e => !e._deleted && e.type !== "_skip") } };
    },
  };
}
