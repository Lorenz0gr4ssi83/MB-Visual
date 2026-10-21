// Disegno dei fogli DWF/DWFx (modello di dwfpkg.js) su canvas 2D: preparazione in gruppi di primitive con lo stesso
// stile (Path2D in coordinate della carta), disegno con zoom/pan, testi, immagini, ritagli, evidenziazione.

export const rgba = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${((c[3] ?? 255) / 255) * a})`;
const lum = c => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

/** decodifica immagini e prepara i gruppi di disegno */
export async function prepareSheet(sheet) {
  if (sheet._prep) return sheet._prep;
  const bitmaps = new Map();
  for (const [key, im] of sheet.images) {
    try {
      if (im.rgba) { const c = document.createElement("canvas"); c.width = im.rgba.w; c.height = im.rgba.h; c.getContext("2d").putImageData(new ImageData(im.rgba.data, im.rgba.w, im.rgba.h), 0, 0); bitmaps.set(key, c); }
      else if (im.mime !== "image/tiff") bitmaps.set(key, await createImageBitmap(new Blob([im.bytes], { type: im.mime })));
    } catch { /* immagine non decodificabile: si disegna il riquadro */ }
  }
  // ritagli: Path2D con la catena dei genitori
  const clipPaths = sheet.clips.map(c => { const p = new Path2D(); for (const r of c.rings) ringTo(p, r, true); return { path: p, rule: c.rule || "evenodd", parent: c.parent }; });
  // gruppi consecutivi con lo stesso stile, layer, ritaglio e marcatura
  const batches = [];
  let cur = null;
  sheet.prims.forEach((p, i) => {
    if (p.t !== "p") { cur = null; batches.push({ kind: p.t, i, layer: p.layer, clip: p.clip, mk: p.mk }); return; }
    const key = [p.fill ? "F" : "S", p.color.join(","), p.lw, p.fill ? p.rule : "", p.dash ? JSON.stringify(p.dash) : "", p.cap, p.join, p.layer, p.clip, p.mk || "", p.grad ? i : ""].join("|");
    if (!cur || cur.key !== key || cur.count > 4000) {
      cur = { kind: "p", key, path: new Path2D(), fill: p.fill, rule: p.rule || "evenodd", color: p.color, lw: p.lw || 0, dash: p.dash, cap: p.cap || "round", join: p.join || "round", layer: p.layer, clip: p.clip, mk: p.mk, grad: p.grad, count: 0, first: i };
      batches.push(cur);
    }
    for (let k = 0; k < p.rings.length; k++) ringTo(cur.path, p.rings[k], p.fill || (Array.isArray(p.closed) ? p.closed[k] : p.closed));
    cur.count++;
  });
  return (sheet._prep = { bitmaps, clipPaths, batches });
}
function ringTo(path, r, close) {
  if (r.length < 2) return;
  path.moveTo(r[0], r[1]);
  if (r.length === 2) { path.lineTo(r[0], r[1]); return; }
  for (let i = 2; i < r.length; i += 2) path.lineTo(r[i], r[i + 1]);
  if (close) path.closePath();
}

/**
 * Disegna il foglio. view: { s (pixel per unita'), tx, ty } con y della carta verso l'alto.
 * opts: { dark, showText, thinLines, hiddenLayers:Set, showMarkups, dpr, highlight:Set di indici, paperShadow }
 */
export function drawSheet(c2, W, H, sheet, prep, view, opts = {}) {
  const { s, tx, ty } = view;
  const dpr = opts.dpr || 1;
  const dark = !!opts.dark;
  c2.setTransform(1, 0, 0, 1, 0, 0);
  c2.fillStyle = opts.export ? (dark ? "#1e2021" : "#ffffff") : dark ? "#141516" : "#8a8f96";
  c2.fillRect(0, 0, W, H);
  c2.setTransform(s, 0, 0, -s, tx, ty);
  const paperCol = dark ? [30, 32, 33] : sheet.paper?.color?.length >= 3 ? sheet.paper.color : [255, 255, 255];
  if (sheet.paper) {
    if (!opts.export) { c2.fillStyle = "rgba(0,0,0,.35)"; c2.fillRect(4 * dpr / s, -4 * dpr / s, sheet.paper.w, sheet.paper.h); }
    c2.fillStyle = rgba(paperCol);
    c2.fillRect(0, 0, sheet.paper.w, sheet.paper.h);
  } else if (!opts.export) { c2.fillStyle = dark ? "#1e2021" : "#ffffff"; const [a, b, cc, d] = sheet.bbox; c2.fillRect(a, b, cc - a, d - b); }
  const px = 1 / s; // un pixel in unita' della carta
  const col = c => {
    if (!dark) return c;
    const l = lum(c);
    if (l < 60) return [230, 230, 230, c[3]];
    if (l > 235) return [paperCol[0], paperCol[1], paperCol[2], c[3]];
    return c;
  };
  const hidden = opts.hiddenLayers || new Set();
  const visible = b => !(b.layer && hidden.has(b.layer)) && !(b.mk && opts.showMarkups === false);
  let clipNow = undefined;
  const setClip = ci => {
    if (ci === clipNow) return;
    if (clipNow !== undefined && clipNow !== null) c2.restore();
    clipNow = ci;
    if (ci === null || ci === undefined) return;
    c2.save();
    for (let k = ci; k !== null && k !== undefined; k = prep.clipPaths[k].parent) c2.clip(prep.clipPaths[k].path, prep.clipPaths[k].rule);
  };
  for (const b of prep.batches) {
    if (!visible(b)) continue;
    setClip(b.clip ?? null);
    if (b.kind === "p") {
      if (b.fill) {
        c2.fillStyle = b.grad ? gradient(c2, b.grad, col) : rgba(col(b.color));
        c2.fill(b.path, b.rule);
      } else {
        c2.strokeStyle = rgba(col(b.color));
        c2.lineWidth = opts.thinLines ? px * dpr : Math.max(b.lw, px * dpr);
        c2.lineCap = b.cap; c2.lineJoin = b.join;
        if (b.dash) {
          const d = b.dash.px ? b.dash.px.map(v => v * px * dpr) : b.dash.world;
          c2.setLineDash(d.reduce((a, v) => a + v, 0) * s > 3 ? d : []);
          c2.lineDashOffset = b.dash.offset || 0;
        } else c2.setLineDash([]);
        c2.stroke(b.path);
      }
      continue;
    }
    const p = sheet.prims[b.i];
    if (b.kind === "x") { if (opts.showText !== false && !p.hidden) drawText(c2, p, s, col); }
    else if (b.kind === "i") drawImage(c2, p, prep, dark);
    else if (b.kind === "m") { c2.strokeStyle = rgba(col(p.color)); c2.lineWidth = px * dpr; c2.setLineDash([]); const r = 3 * px * dpr; c2.beginPath(); c2.moveTo(p.x - r, p.y); c2.lineTo(p.x + r, p.y); c2.moveTo(p.x, p.y - r); c2.lineTo(p.x, p.y + r); c2.stroke(); }
  }
  setClip(null);
  c2.setLineDash([]);
  // evidenziazione (selezione, oggetti trovati)
  if (opts.highlight?.size) {
    c2.save();
    const hl = opts.highlightColor || [255, 140, 0, 255];
    for (const i of opts.highlight) {
      const p = sheet.prims[i];
      if (!p) continue;
      c2.strokeStyle = rgba(hl);
      c2.fillStyle = rgba(hl, 0.28);
      c2.lineWidth = Math.max(p.lw || 0, 2.5 * px * dpr);
      if (p.t === "p") {
        const path = new Path2D();
        for (let k = 0; k < p.rings.length; k++) ringTo(path, p.rings[k], p.fill || (Array.isArray(p.closed) ? p.closed[k] : p.closed));
        if (p.fill) c2.fill(path, p.rule || "evenodd");
        c2.stroke(path);
      } else {
        const q = primQuad(p);
        if (q) { c2.beginPath(); c2.moveTo(q[0], q[1]); for (let k = 2; k < 8; k += 2) c2.lineTo(q[k], q[k + 1]); c2.closePath(); c2.fill(); c2.stroke(); }
      }
    }
    c2.restore();
  }
}
function gradient(c2, g, col) {
  const G = g.kind === "linear" ? c2.createLinearGradient(g.p0[0], g.p0[1], g.p1[0], g.p1[1]) : c2.createRadialGradient(g.o[0], g.o[1], 0, g.c[0], g.c[1], Math.max(g.r, 1e-9));
  for (const st of g.stops) G.addColorStop(Math.max(0, Math.min(1, st.o)), rgba(col(st.c)));
  return G;
}

const FONT_PX = 100;
export function cssFont(p) { return `${p.italic ? "italic " : ""}${p.bold ? "bold " : ""}${FONT_PX}px ${quoteFamily(p.font)}, Arial, sans-serif`; }
function quoteFamily(f) { f = String(f || "Arial").replace(/^@/, ""); return /^[\w-]+$/.test(f) ? f : `"${f.replace(/"/g, "")}"`; }

function drawText(c2, p, s, col) {
  const m = p.m;
  const em = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) * s;
  if (em < 2.2) return; // illeggibile a questa scala
  if (p.vertical) { drawVertical(c2, p, col); return; }
  c2.save();
  c2.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  c2.scale(1 / FONT_PX, -1 / FONT_PX);
  c2.font = cssFont(p);
  c2.fillStyle = rgba(col(p.color));
  c2.textBaseline = "alphabetic";
  c2.textAlign = "left";
  if (p.adv) {
    let x = 0;
    const chars = [...p.s];
    for (let k = 0; k < chars.length; k++) {
      c2.fillText(chars[k], p.rtl ? -x : x, 0);
      x += (p.adv[k] ?? c2.measureText(chars[k]).width / FONT_PX) * FONT_PX;
    }
  } else {
    const lines = p.s.split("\n");
    lines.forEach((ln, k) => c2.fillText(ln, 0, k * FONT_PX * 1.4));
  }
  c2.restore();
}

/** posizioni (carta) dei caratteri di un testo verticale: dentro il riquadro se c'e', altrimenti verso il basso dall'inserimento */
export function verticalLayout(p) {
  const chars = [...p.s.replace(/\n/g, "")];
  const em = Math.sqrt(Math.abs(p.m[0] * p.m[3] - p.m[1] * p.m[2]));
  let cx = p.m[4] + em * 0.35, top = p.m[5], step = em * 1.15;
  if (p.bounds && p.bounds.length >= 8) {
    const xs = [p.bounds[0], p.bounds[2], p.bounds[4], p.bounds[6]], ys = [p.bounds[1], p.bounds[3], p.bounds[5], p.bounds[7]];
    cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    top = Math.max(...ys);
    step = (top - Math.min(...ys)) / Math.max(1, chars.length);
  }
  return chars.map((ch, k) => ({ ch, x: cx, y: top - (k + 0.85) * step, em: Math.min(em, step) }));
}
function drawVertical(c2, p, col) {
  c2.fillStyle = rgba(col(p.color));
  c2.font = cssFont(p);
  c2.textAlign = "center";
  c2.textBaseline = "alphabetic";
  for (const g of verticalLayout(p)) {
    c2.save();
    c2.translate(g.x, g.y);
    c2.scale(g.em / FONT_PX, -g.em / FONT_PX);
    c2.fillText(g.ch, 0, 0);
    c2.restore();
  }
  c2.textAlign = "left";
}

function drawImage(c2, p, prep, dark) {
  const bmp = prep.bitmaps.get(p.src);
  const m = p.m;
  c2.save();
  c2.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  if (bmp) {
    c2.globalAlpha = p.opacity ?? 1;
    c2.imageSmoothingEnabled = true;
    const vb = p.viewbox;
    if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0 && (vb[0] || vb[1]) && vb[0] + vb[2] <= bmp.width + 1 && vb[1] + vb[3] <= bmp.height + 1) c2.drawImage(bmp, vb[0], vb[1], vb[2], vb[3], 0, 0, 1, 1);
    else c2.drawImage(bmp, 0, 0, 1, 1);
  } else {
    // immagine non decodificata (es. TIFF Group 4): riquadro tratteggiato
    c2.strokeStyle = dark ? "#999" : "#777";
    c2.lineWidth = 0.004;
    c2.setLineDash([0.02, 0.02]);
    c2.strokeRect(0, 0, 1, 1);
    c2.beginPath(); c2.moveTo(0, 0); c2.lineTo(1, 1); c2.moveTo(1, 0); c2.lineTo(0, 1); c2.stroke();
  }
  c2.restore();
}

// ---------------------------------------------------------------- geometria per selezione e aggancio
const MEAS = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
/** quadrilatero (8 numeri) che contiene un testo o un'immagine, in coordinate della carta */
export function primQuad(p) {
  if (p.t === "i") { const m = p.m; return [m[4], m[5], m[0] + m[4], m[1] + m[5], m[0] + m[2] + m[4], m[1] + m[3] + m[5], m[2] + m[4], m[3] + m[5]]; }
  if (p.t === "m") return [p.x - 1e-3, p.y - 1e-3, p.x + 1e-3, p.y - 1e-3, p.x + 1e-3, p.y + 1e-3, p.x - 1e-3, p.y + 1e-3];
  if (p.t !== "x") return null;
  if (p.bounds && p.bounds.length >= 8) return Array.from(p.bounds.slice(0, 8));
  if (p._q) return p._q;
  let w = 0;
  const lines = p.s.split("\n");
  if (p.adv) w = p.adv.reduce((a, v) => a + (v ?? 0.55), 0);
  else if (MEAS) { MEAS.font = cssFont(p); w = Math.max(...lines.map(l => MEAS.measureText(l).width)) / FONT_PX; }
  else w = Math.max(...lines.map(l => l.length)) * 0.6;
  const m = p.m, y0 = -0.22 - (lines.length - 1) * 1.4, y1 = 0.78;
  const ap = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  return (p._q = [...ap(0, y0), ...ap(w, y0), ...ap(w, y1), ...ap(0, y1)]);
}
export function primBBox(p) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  const add = (x, y) => { if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y; };
  if (p.t === "p") for (const r of p.rings) for (let i = 0; i < r.length; i += 2) add(r[i], r[i + 1]);
  else { const q = primQuad(p); if (q) for (let i = 0; i < 8; i += 2) add(q[i], q[i + 1]); }
  const e = (p.lw || 0) / 2;
  return [a - e, b - e, c + e, d + e];
}

/** indice spaziale a griglia sulle primitive */
export function buildIndex(sheet) {
  if (sheet._index) return sheet._index;
  const boxes = sheet.prims.map(primBBox);
  const [x0, y0, x1, y1] = sheet.ink;
  const W = Math.max(x1 - x0, y1 - y0) || 1, cs = W / 200;
  const grid = new Map(), big = [];
  const cell = v => Math.floor(v / cs);
  boxes.forEach((bb, i) => {
    if (!bb.every(isFinite)) return;
    const ix0 = cell(bb[0] - x0), iy0 = cell(bb[1] - y0), ix1 = cell(bb[2] - x0), iy1 = cell(bb[3] - y0);
    if ((ix1 - ix0 + 1) * (iy1 - iy0 + 1) > 300) { big.push(i); return; }
    for (let x = ix0; x <= ix1; x++) for (let y = iy0; y <= iy1; y++) { const k = x * 1048576 + y; let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i); }
  });
  const query = (qx0, qy0, qx1, qy1) => {
    const out = new Set(big.filter(i => { const b = boxes[i]; return b[0] <= qx1 && b[2] >= qx0 && b[1] <= qy1 && b[3] >= qy0; }));
    const ix0 = cell(qx0 - x0), iy0 = cell(qy0 - y0), ix1 = cell(qx1 - x0), iy1 = cell(qy1 - y0);
    if ((ix1 - ix0 + 1) * (iy1 - iy0 + 1) > 40000) { boxes.forEach((b, i) => { if (b[0] <= qx1 && b[2] >= qx0 && b[1] <= qy1 && b[3] >= qy0) out.add(i); }); return [...out]; }
    for (let x = ix0; x <= ix1; x++) for (let y = iy0; y <= iy1; y++) { const a = grid.get(x * 1048576 + y); if (a) for (const i of a) { const b = boxes[i]; if (b[0] <= qx1 && b[2] >= qx0 && b[1] <= qy1 && b[3] >= qy0) out.add(i); } }
    return [...out];
  };
  return (sheet._index = { boxes, query });
}

const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx, y = ay + t * dy;
  return [Math.hypot(px - x, py - y), x, y];
};
function inRing(x, y, r) {
  let c = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const yi = r[i + 1], yj = r[j + 1];
    if ((yi > y) !== (yj > y) && x < ((r[j] - r[i]) * (y - yi)) / (yj - yi) + r[i]) c = !c;
  }
  return c;
}
export function inQuad(x, y, q) { return inRing(x, y, q); }

/** primitiva piu' in alto sotto il punto (tolleranza in unita' della carta) */
export function pick(sheet, x, y, tol, isVisible) {
  const { query } = buildIndex(sheet);
  const cand = query(x - tol, y - tol, x + tol, y + tol).sort((a, b) => b - a);
  let fillHit = null;
  for (const i of cand) {
    const p = sheet.prims[i];
    if (!isVisible(p)) continue;
    if (p.t === "p") {
      const t2 = tol + (p.lw || 0) / 2;
      for (let k = 0; k < p.rings.length; k++) {
        const r = p.rings[k];
        const closed = p.fill || (Array.isArray(p.closed) ? p.closed[k] : p.closed);
        const n = r.length;
        for (let j = 0; j + 3 < n + (closed ? 2 : 0); j += 2) {
          const a = j, b = (j + 2) % n;
          if (segDist(x, y, r[a], r[a + 1], r[b], r[b + 1])[0] <= t2) return i;
        }
      }
      if (p.fill && fillHit === null) {
        let inside = false;
        for (const r of p.rings) if (inRing(x, y, r)) inside = !inside;
        if (inside) fillHit = i;
      }
    } else {
      const q = primQuad(p);
      if (q && inRing(x, y, q)) return i;
    }
  }
  return fillHit;
}

/** aggancio per le misure: estremi, punti medi, punto piu' vicino su un segmento */
export function snap(sheet, x, y, tol, isVisible) {
  const { query } = buildIndex(sheet);
  let best = null;
  const take = (d, px, py, k, pr) => { if (d <= tol && (!best || pr < best.pr || (pr === best.pr && d < best.d))) best = { x: px, y: py, d, k, pr }; };
  for (const i of query(x - tol, y - tol, x + tol, y + tol)) {
    const p = sheet.prims[i];
    if (!isVisible(p)) continue;
    if (p.t === "p") {
      for (const r of p.rings) {
        for (let j = 0; j < r.length; j += 2) take(Math.hypot(r[j] - x, r[j + 1] - y), r[j], r[j + 1], "end", 0);
        for (let j = 0; j + 3 < r.length; j += 2) {
          const mx = (r[j] + r[j + 2]) / 2, my = (r[j + 1] + r[j + 3]) / 2;
          take(Math.hypot(mx - x, my - y), mx, my, "mid", 1);
          const [d, nx, ny] = segDist(x, y, r[j], r[j + 1], r[j + 2], r[j + 3]);
          take(d, nx, ny, "near", 2);
        }
      }
    } else if (p.t === "x" && !p.hidden) take(Math.hypot(p.m[4] - x, p.m[5] - y), p.m[4], p.m[5], "ins", 0);
  }
  return best;
}
