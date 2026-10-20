// Disegni CAD 2D (DWG con libredwg, DXF con lettore interno): zoom/pan, layer, blocchi, testi, quote, misure, esportazione.
import { api, button, el, loading, readBytes, saveBlobAs, toast, withExt } from "../core.js";
import { parseDxf } from "../dxf.js";


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

// ---------------------------------------------------------------- geometria
function bulgePts(p1, p2, b, out) {
  if (!b) { out.push([p2.x, p2.y]); return; }
  const th = 4 * Math.atan(b), dx = p2.x - p1.x, dy = p2.y - p1.y, d = Math.hypot(dx, dy);
  if (d < 1e-12) return;
  const r = d / (2 * Math.sin(th / 2)), mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
  const h = r * Math.cos(th / 2), nx = -dy / d, ny = dx / d;
  const cx = mx + nx * h, cy = my + ny * h;
  const a1 = Math.atan2(p1.y - cy, p1.x - cx);
  const n = Math.max(4, Math.ceil(Math.abs(th) / (Math.PI / 32)));
  for (let k = 1; k <= n; k++) { const a = a1 + th * k / n; out.push([cx + Math.abs(r) * Math.cos(a), cy + Math.abs(r) * Math.sin(a)]); }
}

function arcPts(cx, cy, rx, ry, rot, a0, a1, ccw = true) {
  let sweep = a1 - a0;
  if (ccw) { while (sweep <= 0) sweep += Math.PI * 2; } else { while (sweep >= 0) sweep -= Math.PI * 2; }
  if (Math.abs(a1 - a0) >= Math.PI * 2 - 1e-9) sweep = Math.PI * 2;
  const n = Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI / 48)));
  const cr = Math.cos(rot), sr = Math.sin(rot), out = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 + sweep * k / n, x = rx * Math.cos(a), y = ry * Math.sin(a);
    out.push([cx + x * cr - y * sr, cy + x * sr + y * cr]);
  }
  return out;
}

function splinePts(e) {
  const cps = e.controlPoints || [];
  if (cps.length < 2) return (e.fitPoints || []).map(p => [p.x, p.y]);
  const p = e.degree || 3, kn = e.knots && e.knots.length === cps.length + p + 1 ? e.knots : null;
  if (!kn) return cps.map(c => [c.x, c.y]);
  const w = e.weights && e.weights.length === cps.length ? e.weights : cps.map(c => c.weight || 1);
  const out = [], t0 = kn[p], t1 = kn[cps.length], N = Math.max(20, cps.length * 8);
  for (let s = 0; s <= N; s++) {
    let t = t0 + (t1 - t0) * s / N;
    if (s === N) t = t1 - 1e-10;
    let k = p;
    while (k < cps.length - 1 && t >= kn[k + 1]) k++;
    const d = [];
    for (let j = 0; j <= p; j++) { const c = cps[k - p + j], ww = w[k - p + j]; d.push([c.x * ww, c.y * ww, ww]); }
    for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
      const i = k - p + j, a = (t - kn[i]) / ((kn[i + p - r + 1] - kn[i]) || 1);
      d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
    }
    out.push([d[p][0] / d[p][2], d[p][1] / d[p][2]]);
  }
  return out;
}

function cleanMText(s) {
  return (s || "").replace(/\\P/g, "\n").replace(/\\[ACcFfHhQqTtWw][^;\\]*;/g, "").replace(/\\[LlOoKk]/g, "")
    .replace(/\\S([^;]*)\^([^;]*);/g, "$1/$2").replace(/[{}]/g, "").replace(/\\~/g, " ").replace(/%%[cC]/g, "Ø").replace(/%%[dD]/g, "°").replace(/%%[pP]/g, "±").replace(/\\\\/g, "\\");
}

// ---------------------------------------------------------------- costruzione delle primitive
function build(db) {
  const layers = new Map();
  for (const l of db.tables.LAYER.entries) layers.set(l.name, { name: l.name, aci: l.colorIndex, color: l.color, off: !!l.off || !!l.frozen, count: 0 });
  const blocks = new Map();
  for (const b of db.tables.BLOCK_RECORD.entries) blocks.set(b.name, b);
  const groups = new Map(); // layer|colore -> {layer, color, lines: [[x,y,...]], fills: []}
  const texts = [];
  const snaps = [];
  let bbox = [Infinity, Infinity, -Infinity, -Infinity];
  const xs = [], ys = [];

  const layerOf = n => { if (!layers.has(n)) layers.set(n, { name: n, aci: 7, off: false, count: 0 }); return layers.get(n); };
  const colorOf = (e, L, inherited) => {
    if (e.colorIndex === undefined && typeof e.color === "number") return trueColor(e.color);
    const ci = e.colorIndex ?? 256;
    if (ci === 0) return inherited || [255, 255, 255];
    if (ci === 256 || ci < 0) return L.color !== undefined && L.color > 0 && !L.aci ? trueColor(L.color) : ACI[Math.abs(L.aci ?? 7)] || ACI[7];
    return ACI[ci] || ACI[7];
  };

  function emit(layer, color, pts, closed = false, fill = false) {
    if (pts.length < (fill ? 3 : 2)) return;
    const key = layer + "|" + color.join(",");
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { layer, color, lines: [], fills: [] }));
    (fill ? g.fills : g.lines).push({ pts, closed });
    for (const [x, y] of pts) {
      if (!isFinite(x) || !isFinite(y)) continue;
      if (xs.length < 400000) { xs.push(x); ys.push(y); }
    }
    if (snaps.length < 600000) { snaps.push(pts[0][0], pts[0][1], pts[pts.length - 1][0], pts[pts.length - 1][1]); }
  }

  function walk(list, M, inheritedLayer, inheritedColor, depth) {
    if (depth > 12) return;
    const tp = (x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
    const scale = Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2])) || 1;
    for (const e of list) {
      if (e.isVisible === false || e.isInPaperSpace) continue;
      const lname = e.layer === "0" && inheritedLayer ? inheritedLayer : e.layer || "0";
      const L = layerOf(lname);
      L.count++;
      const col = colorOf(e, L, inheritedColor);
      const out = pts => emit(lname, col, pts.map(([x, y]) => tp(x, y)));
      switch (e.type) {
        case "LINE": out([[e.startPoint.x, e.startPoint.y], [e.endPoint.x, e.endPoint.y]]); break;
        case "CIRCLE": out(arcPts(e.center.x, e.center.y, e.radius, e.radius, 0, 0, Math.PI * 2)); break;
        case "ARC": out(arcPts(e.center.x, e.center.y, e.radius, e.radius, 0, e.startAngle, e.endAngle)); break;
        case "ELLIPSE": {
          const mx = e.majorAxisEndPoint.x, my = e.majorAxisEndPoint.y, r = Math.hypot(mx, my);
          out(arcPts(e.center.x, e.center.y, r, r * e.axisRatio, Math.atan2(my, mx), e.startAngle, e.endAngle));
          break;
        }
        case "LWPOLYLINE": case "POLYLINE2D": case "POLYLINE3D": {
          const v = (e.vertices || []).filter(p => !(p.flag & 16)).map(p => ({ x: p.x ?? p.point?.x, y: p.y ?? p.point?.y, bulge: p.bulge || 0 }));
          if (!v.length) break;
          const closed = !!(e.flag & 1) || e.closed;
          const pts = [[v[0].x, v[0].y]];
          for (let k = 1; k < v.length; k++) bulgePts(v[k - 1], v[k], v[k - 1].bulge, pts);
          if (closed) bulgePts(v[v.length - 1], v[0], v[v.length - 1].bulge, pts);
          out(pts);
          break;
        }
        case "SPLINE": out(splinePts(e)); break;
        case "LEADER": out((e.vertices || []).map(p => [p.x, p.y])); break;
        case "POINT": { const s = 0.5; out([[e.position.x - s, e.position.y], [e.position.x + s, e.position.y]]); out([[e.position.x, e.position.y - s], [e.position.x, e.position.y + s]]); break; }
        case "SOLID": case "TRACE": case "3DFACE": {
          const c = [e.corner1, e.corner2, e.corner4 || e.corner3, e.corner3].filter(Boolean).map(p => tp(p.x, p.y));
          const pts = e.type === "3DFACE" ? [e.corner1, e.corner2, e.corner3, e.corner4 || e.corner3, e.corner1].map(p => tp(p.x, p.y)) : c;
          emit(lname, col, pts, true, e.type !== "3DFACE");
          break;
        }
        case "HATCH": {
          for (const path of e.boundaryPaths || []) {
            let pts = [];
            if (path.vertices) {
              const v = path.vertices;
              pts = [[v[0].x, v[0].y]];
              for (let k = 1; k < v.length; k++) bulgePts(v[k - 1], v[k], v[k - 1].bulge, pts);
              bulgePts(v[v.length - 1], v[0], v[v.length - 1].bulge || 0, pts);
            } else for (const ed of path.edges || []) {
              if (ed.type === 1) pts.push([ed.start.x, ed.start.y], [ed.end.x, ed.end.y]);
              else if (ed.type === 2) pts.push(...arcPts(ed.center.x, ed.center.y, ed.radius, ed.radius, 0, ed.isCCW === false ? -ed.startAngle : ed.startAngle, ed.isCCW === false ? -ed.endAngle : ed.endAngle, ed.isCCW !== false));
              else if (ed.type === 3) { const r = Math.hypot(ed.end.x, ed.end.y); pts.push(...arcPts(ed.center.x, ed.center.y, r, ed.lengthOfMinorAxis * (ed.lengthOfMinorAxis < 1.0001 ? r : 1), Math.atan2(ed.end.y, ed.end.x), ed.startAngle, ed.endAngle, ed.isCCW !== false)); }
              else if (ed.type === 4) pts.push(...splinePts({ degree: ed.degree, knots: ed.knots, controlPoints: ed.controlPoints }));
            }
            if (pts.length > 2) emit(lname, col, pts.map(([x, y]) => tp(x, y)), true, !!(e.solidFill === 1 || e.isSolidFill));
          }
          break;
        }
        case "TEXT": case "ATTRIB": case "MTEXT": {
          const isM = e.type === "MTEXT";
          const align = !isM && (e.halign || e.valign) && e.endPoint ? e.endPoint : null;
          const p = isM ? e.insertionPoint : align || e.startPoint;
          if (!p) break;
          const [x, y] = tp(p.x, p.y);
          let rot = e.rotation || 0;
          if (isM && e.direction && (e.direction.x || e.direction.y)) rot = Math.atan2(e.direction.y, e.direction.x);
          rot += Math.atan2(M[1], M[0]);
          const ap = isM ? e.attachmentPoint || 1 : 0;
          texts.push({ layer: lname, color: col, x, y, rot, h: (e.textHeight || 1) * scale, text: isM ? cleanMText(e.text) : cleanMText(e.text),
            hal: isM ? ["left", "center", "right"][(ap - 1) % 3] : ["left", "center", "right", "left", "center", "left"][e.halign || 0] || "left",
            val: isM ? ["top", "middle", "bottom"][Math.floor((ap - 1) / 3)] : ["alphabetic", "bottom", "middle", "top"][e.valign || 0] || "alphabetic", width: isM ? (e.rectWidth || 0) * scale : 0 });
          if (xs.length < 400000) { xs.push(x, x); ys.push(y, y + (e.textHeight || 1) * scale * 1.3); }
          break;
        }
        case "INSERT": case "DIMENSION": {
          const b = blocks.get(e.name);
          if (b) {
            const bp = b.basePoint || { x: 0, y: 0 };
            const cols = Math.max(1, e.columnCount || 1), rows = Math.max(1, e.rowCount || 1);
            for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
              let N;
              if (e.type === "DIMENSION") N = M;
              else {
                const sx = e.xScale || 1, sy = e.yScale || 1, a = e.rotation || 0, ca = Math.cos(a), sa = Math.sin(a);
                const ox = c * (e.columnSpacing || 0), oy = r * (e.rowSpacing || 0);
                const ix = e.insertionPoint.x + ox * ca - oy * sa, iy = e.insertionPoint.y + ox * sa + oy * ca;
                const L2 = [ca * sx, sa * sx, -sa * sy, ca * sy, 0, 0];
                L2[4] = ix - (L2[0] * bp.x + L2[2] * bp.y);
                L2[5] = iy - (L2[1] * bp.x + L2[3] * bp.y);
                N = [M[0] * L2[0] + M[2] * L2[1], M[1] * L2[0] + M[3] * L2[1], M[0] * L2[2] + M[2] * L2[3], M[1] * L2[2] + M[3] * L2[3],
                  M[0] * L2[4] + M[2] * L2[5] + M[4], M[1] * L2[4] + M[3] * L2[5] + M[5]];
              }
              walk(b.entities || [], N, lname, col, depth + 1);
            }
          }
          if (e.attribs?.length) walk(e.attribs, M, lname, col, depth + 1);
          break;
        }
        default: break;
      }
    }
  }
  walk(db.entities, [1, 0, 0, 1, 0, 0], null, null, 0);

  // estensioni robuste (scarta elementi isolati lontanissimi)
  if (xs.length) {
    const q = (arr, f) => { const s = Float64Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * f)))]; };
    const lo = xs.length > 200 ? 0.002 : 0, hi = 1 - lo;
    bbox = [q(xs, lo), q(ys, lo), q(xs, hi), q(ys, hi)];
    if (bbox[2] - bbox[0] < 1e-9) { bbox[0] -= 1; bbox[2] += 1; }
    if (bbox[3] - bbox[1] < 1e-9) { bbox[1] -= 1; bbox[3] += 1; }
  } else bbox = [0, 0, 100, 100];

  // Path2D per gruppo
  for (const g of groups.values()) {
    g.path = new Path2D();
    for (const { pts, closed } of g.lines) { g.path.moveTo(pts[0][0], pts[0][1]); for (let k = 1; k < pts.length; k++) g.path.lineTo(pts[k][0], pts[k][1]); if (closed) g.path.closePath(); }
    g.fillPath = new Path2D();
    for (const { pts } of g.fills) { g.fillPath.moveTo(pts[0][0], pts[0][1]); for (let k = 1; k < pts.length; k++) g.fillPath.lineTo(pts[k][0], pts[k][1]); g.fillPath.closePath(); }
  }
  return { layers, groups: [...groups.values()], texts, bbox, snaps: Float64Array.from(snaps) };
}

// ---------------------------------------------------------------- decodifica DWG
// Un motore nuovo per ogni disegno: la sua memoria si libera quando il disegno e' letto. Con un motore condiviso
// la memoria cresceva a ogni file aperto fino a esaurirsi ("out of WASM memory").
async function decodeDwg(bytes, ctx, ld) {
  const m = await import(window.MBV_ROOT + "vendor/libredwg/dist/libredwg-web.js");
  const type = ctx.ext === "dxf" ? m.Dwg_File_Type.DXF : m.Dwg_File_Type.DWG;
  for (let attempt = 1; ; attempt++) {
    ld.set(0.3, attempt === 1 ? "Decodifica DWG" : "Decodifica DWG (secondo tentativo con memoria libera)");
    let lib = await m.LibreDwg.create(window.MBV_ROOT + "vendor/libredwg/wasm");
    try {
      const data = lib.dwg_read_data(bytes.buffer, type);
      if (data === undefined || data === null) throw new Error("Il file DWG non e' leggibile (versione non supportata o file danneggiato). Prova \"Apri come\" > DWG TrueView.");
      const db = lib.convert(data);
      try { lib.dwg_free(data); } catch { /* */ }
      return db;
    } catch (e) {
      lib = null;
      if (/out of WASM memory/i.test(e.message)) {
        if (attempt < 2) { await new Promise(r => setTimeout(r, 500)); continue; }
        throw new Error(`Il disegno e' troppo grande per il lettore interno (${(bytes.length / 1048576).toFixed(1)} MB). Chiudi gli altri disegni aperti e riprova${ctx.tools?.trueview ? ", oppure usa \"Apri come\" > DWG TrueView" : ""}.`);
      }
      throw e;
    }
  }
}

// ---------------------------------------------------------------- visualizzatore
export async function mount(ctx) {
  const ld = loading(ctx.el, "Lettura del disegno");
  const bytes = await readBytes(ctx.path);
  let db;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 6));
  if (ctx.ext === "dxf" && !head.startsWith("AutoCA")) {
    const text = new TextDecoder(isUtf8(bytes) ? "utf-8" : "windows-1252").decode(bytes);
    db = parseDxf(text);
  } else {
    db = await decodeDwg(bytes, ctx, ld);
  }
  ld.set(0.7, "Preparazione del disegno");
  await new Promise(r => setTimeout(r, 0));
  const model = build(db);
  ctx.el.innerHTML = "";

  // ---- interfaccia
  const canvas = el("canvas", { class: "fill", style: { cursor: "grab", touchAction: "none" } });
  const layerList = el("div", { class: "tree" });
  const side = el("div", {}, el("div", { style: { padding: "8px 10px", display: "flex", gap: "6px", alignItems: "center" } }, el("b", {}, "Layer"), el("span", { class: "note" }, String(model.layers.size)),
    el("span", { style: { flex: 1 } }), el("button", { class: "btn", onclick: () => setAll(true) }, "Tutti"), el("button", { class: "btn", onclick: () => setAll(false) }, "Nessuno")), layerList);
  const wrap = el("div", { class: "side" }, side, el("div", { style: { position: "relative", overflow: "hidden" } }, canvas));
  ctx.el.append(wrap);
  ctx.fillBody(true);
  let dark = true, measure = false, mpts = [], showText = true;
  const lineScale = { v: 1 };

  const bgBtn = button("Sfondo chiaro", "sun", () => { dark = !dark; bgBtn.lastChild.textContent = dark ? "Sfondo chiaro" : "Sfondo scuro"; draw(); });
  const mBtn = button("Misura", "ruler", () => { measure = !measure; mBtn.classList.toggle("on", measure); mpts = []; canvas.style.cursor = measure ? "crosshair" : "grab"; draw(); });
  const tBtn = button("Testi", "text", () => { showText = !showText; tBtn.classList.toggle("on", showText); draw(); });
  tBtn.classList.add("on");
  ctx.tb.append(...[button("Adatta", "fit", fit), button("", "zoomIn", () => zoomAt(1.4), { iconOnly: true, title: "Ingrandisci" }), button("", "zoomOut", () => zoomAt(1 / 1.4), { iconOnly: true, title: "Riduci" }),
    el("span", { class: "sep" }), mBtn, tBtn, bgBtn, el("span", { class: "sep" }),
    button("PNG", "download", () => exportPng()), button("SVG", "download", () => exportSvg()), button("PDF", "download", () => exportPdf()),
    ctx.ext === "dxf" ? button("Modifica DXF (testo)", "code", () => ctx.openAs("text")) : null,
    ctx.tools.trueview ? button("Apri in DWG TrueView", "open", () => api("open_external", { path: ctx.path, app: "trueview" })) : null,
    el("span", { class: "grow" }), el("span", { class: "note" }, "Rotella: zoom · trascina: sposta · doppio clic: adatta")].filter(Boolean));

  // ---- elenco layer
  const sortedLayers = [...model.layers.values()].filter(l => l.count).sort((a, b) => a.name.localeCompare(b.name));
  function renderLayers() {
    layerList.innerHTML = "";
    for (const L of sortedLayers) {
      const c = ACI[Math.abs(L.aci ?? 7)] || ACI[7];
      const cb = el("input", { type: "checkbox", checked: !L.off });
      cb.addEventListener("change", () => { L.off = !cb.checked; draw(); });
      layerList.append(el("label", { class: "node" }, cb, el("span", { style: { width: "10px", height: "10px", background: rgb(c), border: "1px solid var(--line)", flex: "none" } }), el("span", {}, L.name), el("span", { class: "note", style: { marginLeft: "auto" } }, String(L.count))));
    }
  }
  function setAll(v) { sortedLayers.forEach(L => (L.off = !v)); renderLayers(); draw(); }
  renderLayers();

  // ---- vista
  const view = { s: 1, tx: 0, ty: 0 };
  const g2 = canvas.getContext("2d");
  function resize() {
    const r = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    canvas.width = Math.max(1, r.width * dpr);
    canvas.height = Math.max(1, r.height * dpr);
  }
  function fit() {
    resize();
    const [x0, y0, x1, y1] = model.bbox, W = canvas.width, H = canvas.height;
    view.s = 0.92 * Math.min(W / (x1 - x0), H / (y1 - y0));
    view.tx = W / 2 - view.s * (x0 + x1) / 2;
    view.ty = H / 2 + view.s * (y0 + y1) / 2;
    draw();
  }
  const toWorld = (px, py) => [(px - view.tx) / view.s, (view.ty - py) / view.s];
  const toScreen = (x, y) => [x * view.s + view.tx, view.ty - y * view.s];

  function render(c2, W, H, s, tx, ty, isDark) {
    c2.setTransform(1, 0, 0, 1, 0, 0);
    c2.fillStyle = isDark ? "#1e2021" : "#ffffff";
    c2.fillRect(0, 0, W, H);
    c2.setTransform(s, 0, 0, -s, tx, ty);
    c2.lineWidth = lineScale.v / s;
    c2.lineJoin = "round";
    for (const g of model.groups) {
      const L = model.layers.get(g.layer);
      if (L && L.off) continue;
      let col = g.color;
      if (!isDark && col[0] > 230 && col[1] > 230 && col[2] > 230) col = [20, 20, 20];
      c2.strokeStyle = c2.fillStyle = rgb(col);
      if (g.fills.length) c2.fill(g.fillPath);
      c2.stroke(g.path);
    }
    if (showText) {
      for (const t of model.texts) {
        const L = model.layers.get(t.layer);
        if (L && L.off) continue;
        if (t.h * s < 2.5) continue; // illeggibile a questa scala
        let col = t.color;
        if (!isDark && col[0] > 230 && col[1] > 230 && col[2] > 230) col = [20, 20, 20];
        c2.save();
        c2.translate(t.x, t.y);
        c2.rotate(t.rot);
        c2.scale(1, -1);
        c2.fillStyle = rgb(col);
        c2.font = `${t.h}px Arial, sans-serif`;
        c2.textAlign = t.hal;
        c2.textBaseline = t.val;
        const linesT = t.text.split("\n");
        linesT.forEach((ln, k) => c2.fillText(ln, 0, k * t.h * 1.4));
        c2.restore();
      }
    }
  }

  function draw() {
    render(g2, canvas.width, canvas.height, view.s, view.tx, view.ty, dark);
    g2.setTransform(1, 0, 0, 1, 0, 0);
    if (measure && mpts.length) {
      g2.strokeStyle = "#ff9f1a";
      g2.fillStyle = "#ff9f1a";
      g2.lineWidth = 2;
      const sp = mpts.map(p => toScreen(p[0], p[1]));
      g2.beginPath();
      sp.forEach(([x, y], k) => (k ? g2.lineTo(x, y) : g2.moveTo(x, y)));
      g2.stroke();
      sp.forEach(([x, y]) => { g2.beginPath(); g2.arc(x, y, 4, 0, 7); g2.fill(); });
      if (mpts.length === 2) {
        const d = Math.hypot(mpts[1][0] - mpts[0][0], mpts[1][1] - mpts[0][1]);
        const dx = mpts[1][0] - mpts[0][0], dy = mpts[1][1] - mpts[0][1];
        const label = `${fmt(d)}   (dx ${fmt(dx)}  dy ${fmt(dy)})`;
        g2.font = `${13 * (devicePixelRatio || 1)}px Segoe UI, sans-serif`;
        const [mx, my] = [(sp[0][0] + sp[1][0]) / 2, (sp[0][1] + sp[1][1]) / 2];
        const w = g2.measureText(label).width + 12;
        g2.fillStyle = "rgba(0,0,0,.75)";
        g2.fillRect(mx - w / 2, my - 28, w, 22);
        g2.fillStyle = "#fff";
        g2.textAlign = "center";
        g2.fillText(label, mx, my - 12);
      }
    }
  }
  const fmt = v => v.toLocaleString("it-IT", { maximumFractionDigits: 4 });

  function zoomAt(f, px = canvas.width / 2, py = canvas.height / 2) {
    view.tx = px - (px - view.tx) * f;
    view.ty = py - (py - view.ty) * f;
    view.s *= f;
    draw();
  }

  function snap(px, py) {
    const [wx, wy] = toWorld(px, py);
    const tol = 12 * (devicePixelRatio || 1) / view.s;
    let best = null, bd = tol * tol;
    const S = model.snaps;
    for (let k = 0; k < S.length; k += 2) {
      const dx = S[k] - wx, dy = S[k + 1] - wy, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = [S[k], S[k + 1]]; }
    }
    return best || [wx, wy];
  }

  let drag = null;
  const pos = e => { const r = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1; return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr]; };
  canvas.addEventListener("pointerdown", e => {
    const [px, py] = pos(e);
    if (measure && e.button === 0) {
      if (mpts.length === 2) mpts = [];
      mpts.push(snap(px, py));
      if (mpts.length === 2) ctx.status("Distanza: " + fmt(Math.hypot(mpts[1][0] - mpts[0][0], mpts[1][1] - mpts[0][1])));
      draw();
      return;
    }
    drag = { px, py, tx: view.tx, ty: view.ty };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = "grabbing";
  });
  canvas.addEventListener("pointermove", e => {
    const [px, py] = pos(e);
    const [wx, wy] = toWorld(px, py);
    if (!measure) ctx.status(`X ${fmt(wx)}  Y ${fmt(wy)}`);
    if (!drag) return;
    view.tx = drag.tx + (px - drag.px);
    view.ty = drag.ty + (py - drag.py);
    draw();
  });
  canvas.addEventListener("pointerup", () => { drag = null; canvas.style.cursor = measure ? "crosshair" : "grab"; });
  canvas.addEventListener("wheel", e => { e.preventDefault(); const [px, py] = pos(e); zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, px, py); }, { passive: false });
  canvas.addEventListener("dblclick", () => { if (!measure) fit(); });
  new ResizeObserver(() => { const s = canvas.width; resize(); if (s <= 1) fit(); else draw(); }).observe(canvas);
  requestAnimationFrame(fit);

  // ---- esportazioni
  function offscreen(maxSide = 4000) {
    const [x0, y0, x1, y1] = model.bbox, w = x1 - x0, h = y1 - y0;
    const k = maxSide / Math.max(w, h);
    const c = document.createElement("canvas");
    c.width = Math.ceil(w * k * 1.04);
    c.height = Math.ceil(h * k * 1.04);
    render(c.getContext("2d"), c.width, c.height, k, c.width / 2 - k * (x0 + x1) / 2, c.height / 2 + k * (y0 + y1) / 2, false);
    return c;
  }
  async function exportPng() {
    const c = offscreen();
    const blob = await new Promise(r => c.toBlob(r, "image/png"));
    await saveBlobAs(withExt(ctx.name, "png"), blob, ctx.path.replace(/[\\/][^\\/]*$/, ""));
  }
  async function exportPdf() {
    const c = offscreen(5000);
    const jpg = await new Promise(r => c.toBlob(r, "image/jpeg", 0.92));
    const pdf = jpegToPdf(new Uint8Array(await jpg.arrayBuffer()), c.width, c.height);
    await saveBlobAs(withExt(ctx.name, "pdf"), new Blob([pdf]), ctx.path.replace(/[\\/][^\\/]*$/, ""));
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
      parts.push(`<text x="${t.x}" y="${-t.y}" font-size="${t.h}" font-family="Arial" fill="${rgb(col)}" transform="rotate(${-t.rot * 180 / Math.PI} ${t.x} ${-t.y})">${esc(t.text)}</text>`);
    }
    parts.push("</svg>");
    await saveBlobAs(withExt(ctx.name, "svg"), new Blob([parts.join("")], { type: "image/svg+xml" }), ctx.path.replace(/[\\/][^\\/]*$/, ""));
  }

  ctx.status(`${model.groups.reduce((n, g) => n + g.lines.length, 0).toLocaleString("it-IT")} elementi · ${model.texts.length} testi`);
  return {
    onShow() { resize(); draw(); },
    saveInPlace: false,
    saveAsName: () => withExt(ctx.name, ctx.ext === "dxf" ? "dxf" : "pdf"),
    async save(target) {
      if (/\.dxf$/i.test(target) && ctx.ext === "dxf") { await api("save", { path: target }, { body: bytes }); return; }
      toast("Per i disegni usa i pulsanti PNG / SVG / PDF; per modificare un DXF usa \"Modifica DXF (testo)\".", true, 6000);
      throw new Error("Esportazione da scegliere con i pulsanti PNG / SVG / PDF");
    },
  };
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
