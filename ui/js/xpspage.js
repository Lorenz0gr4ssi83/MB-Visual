// Lettore delle pagine XPS (FixedPage, usate dai DWFx e dagli XPS di Windows), scritto da zero seguendo la specifica
// pubblica XPS / OpenXPS (ECMA-388). Produce primitive in coordinate della pagina (1/96 di pollice, y verso il basso):
//   { t: "p", rings, closed:[...], fill, fillRule, stroke, lw, dash, cap, join, paint, name, clip }
//   { t: "x", m:[a,b,c,d,e,f] (da spazio testo in em, y verso l'alto, a pagina), s, adv:[...], font, bold, italic, color, name, clip }
//   { t: "i", m (quadrato unitario -> pagina), uri, clip }
// Le risorse esterne (immagini, caratteri, dizionari) si leggono con getPart(uri assoluto) -> Uint8Array.

const IDENT = [1, 0, 0, 1, 0, 0];
export const mul = (A, B) => [ // A dopo B (prima B poi A): come le matrici di XPS (vettori riga)
  B[0] * A[0] + B[1] * A[2], B[0] * A[1] + B[1] * A[3],
  B[2] * A[0] + B[3] * A[2], B[2] * A[1] + B[3] * A[3],
  B[4] * A[0] + B[5] * A[2] + A[4], B[4] * A[1] + B[5] * A[3] + A[5],
];
export const apply = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
const nums = s => (String(s).match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number);

/** colore XPS -> [r,g,b,a] (a 0..255) */
export function parseColor(s) {
  if (!s) return null;
  s = s.trim();
  if (s[0] === "#") {
    const h = s.slice(1);
    if (h.length === 8) return [parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), parseInt(h.slice(6, 8), 16), parseInt(h.slice(0, 2), 16)];
    if (h.length === 6) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255];
    return null;
  }
  if (/^sc#/i.test(s)) {
    const v = nums(s.slice(3));
    const lin = c => { c = Math.max(0, Math.min(1, c)); return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)); };
    if (v.length === 4) return [lin(v[1]), lin(v[2]), lin(v[3]), Math.round(Math.max(0, Math.min(1, v[0])) * 255)];
    if (v.length === 3) return [lin(v[0]), lin(v[1]), lin(v[2]), 255];
  }
  if (/^ContextColor/i.test(s)) { // profilo colore: si usano i valori dopo il profilo come sRGB approssimato
    const v = nums(s.replace(/^ContextColor\s+\S+/i, ""));
    if (v.length >= 4) return [Math.round(v[1] * 255), Math.round(v[2] * 255), Math.round(v[3] * 255), Math.round(v[0] * 255)];
  }
  return null;
}

// ---------------------------------------------------------------- geometria dei percorsi
// Ogni figura diventa un anello di punti (curve approssimate). Restituisce { rings, closed, fillRule }.
export function parsePathData(d, M = IDENT, tolPx = 0.25) {
  const rings = [], closed = [];
  let fillRule = "evenodd";
  const tok = String(d).match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
  let i = 0, cmd = "", x = 0, y = 0, sx = 0, sy = 0, ring = null, lcx = null, lcy = null, lqx = null, lqy = null;
  const scale = Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2])) || 1;
  const num = () => +tok[i++];
  const isNum = () => i < tok.length && !/^[a-zA-Z]$/.test(tok[i]);
  const push = (px, py) => { const [a, b] = apply(M, px, py); ring.push(a, b); };
  const start = (px, py) => { if (ring && ring.length > 2) { rings.push(ring); closed.push(false); } ring = []; push(px, py); sx = px; sy = py; };
  const ensure = () => { if (!ring) { ring = []; push(x, y); sx = x; sy = y; } };
  const segs = len => Math.max(2, Math.min(64, Math.ceil(Math.sqrt(len * scale / tolPx) / 2)));
  const cubic = (x0, y0, x1, y1, x2, y2, x3, y3) => {
    const n = segs(Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2));
    for (let k = 1; k <= n; k++) { const t = k / n, u = 1 - t; push(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3); }
  };
  const quad = (x0, y0, x1, y1, x2, y2) => {
    const n = segs(Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1));
    for (let k = 1; k <= n; k++) { const t = k / n, u = 1 - t; push(u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2); }
  };
  while (i < tok.length) {
    if (!isNum()) cmd = tok[i++];
    const rel = cmd === cmd.toLowerCase() && cmd !== "F" && cmd !== "f";
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case "F": fillRule = num() ? "nonzero" : "evenodd"; cmd = ""; break;
      case "M": x = ox + num(); y = oy + num(); start(x, y); cmd = rel ? "l" : "L"; lcx = lqx = null; break;
      case "L": ensure(); x = ox + num(); y = oy + num(); push(x, y); lcx = lqx = null; break;
      case "H": ensure(); x = ox + num(); push(x, y); lcx = lqx = null; break;
      case "V": ensure(); y = oy + num(); push(x, y); lcx = lqx = null; break;
      case "C": { ensure(); const x1 = ox + num(), y1 = oy + num(), x2 = ox + num(), y2 = oy + num(), x3 = ox + num(), y3 = oy + num(); cubic(x, y, x1, y1, x2, y2, x3, y3); lcx = x2; lcy = y2; x = x3; y = y3; lqx = null; break; }
      case "S": { ensure(); const x1 = lcx === null ? x : 2 * x - lcx, y1 = lcx === null ? y : 2 * y - lcy; const x2 = ox + num(), y2 = oy + num(), x3 = ox + num(), y3 = oy + num(); cubic(x, y, x1, y1, x2, y2, x3, y3); lcx = x2; lcy = y2; x = x3; y = y3; lqx = null; break; }
      case "Q": { ensure(); const x1 = ox + num(), y1 = oy + num(), x2 = ox + num(), y2 = oy + num(); quad(x, y, x1, y1, x2, y2); lqx = x1; lqy = y1; x = x2; y = y2; lcx = null; break; }
      case "A": {
        ensure();
        const rx = num(), ry = num(), rot = num(), large = num(), sweep = num(), x2 = ox + num(), y2 = oy + num();
        arcTo(x, y, rx, ry, rot, !!large, !!sweep, x2, y2, (px, py) => push(px, py), segs);
        x = x2; y = y2; lcx = lqx = null;
        break;
      }
      case "Z": if (ring) { rings.push(ring); closed.push(true); ring = null; } x = sx; y = sy; cmd = ""; break;
      default: i++; break; // carattere sconosciuto: si salta
    }
    if (cmd === "") continue;
  }
  if (ring && ring.length > 2) { rings.push(ring); closed.push(false); }
  return { rings, closed, fillRule };
}

// arco ellittico SVG/XPS (punto finale) -> punti
function arcTo(x1, y1, rx, ry, rotDeg, large, sweep, x2, y2, push, segs) {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) { push(x2, y2); return; }
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = rotDeg * Math.PI / 180, c = Math.cos(phi), s = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2, xp = c * dx + s * dy, yp = -s * dx + c * dy;
  const lam = xp * xp / (rx * rx) + yp * yp / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  let k = Math.sqrt(Math.max(0, (rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp) / (rx * rx * yp * yp + ry * ry * xp * xp)));
  if (large === sweep) k = -k;
  const cxp = k * rx * yp / ry, cyp = -k * ry * xp / rx;
  const cx = c * cxp - s * cyp + (x1 + x2) / 2, cy = s * cxp + c * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let dt = ang((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI; else if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(4, segs(Math.abs(dt) * Math.max(rx, ry)));
  for (let i = 1; i <= n; i++) {
    const t = t1 + dt * i / n;
    push(cx + rx * Math.cos(t) * c - ry * Math.sin(t) * s, cy + rx * Math.cos(t) * s + ry * Math.sin(t) * c);
  }
}

// geometria in forma di elementi (PathGeometry / PathFigure / segmenti) -> stringa di percorso abbreviata
function geometryToData(g) {
  let out = g.getAttribute("FillRule") === "NonZero" ? "F1 " : "";
  if (g.getAttribute("Figures")) out += g.getAttribute("Figures") + " ";
  for (const f of children(g, "PathFigure")) {
    out += "M" + f.getAttribute("StartPoint") + " ";
    for (const sgm of f.children) {
      const n = sgm.localName;
      if (n === "PolyLineSegment") out += "L" + sgm.getAttribute("Points") + " ";
      else if (n === "PolyBezierSegment") out += "C" + sgm.getAttribute("Points") + " ";
      else if (n === "PolyQuadraticBezierSegment") out += "Q" + sgm.getAttribute("Points") + " ";
      else if (n === "ArcSegment") {
        const [w, h] = nums(sgm.getAttribute("Size"));
        out += `A${w},${h} ${sgm.getAttribute("RotationAngle") || 0} ${sgm.getAttribute("IsLargeArc") === "true" ? 1 : 0} ${sgm.getAttribute("SweepDirection") === "Clockwise" ? 1 : 0} ${sgm.getAttribute("Point")} `;
      }
    }
    if (f.getAttribute("IsClosed") === "true") out += "Z ";
  }
  return out;
}
const children = (e, name) => [...e.children].filter(c => c.localName === name);
const child = (e, name) => [...e.children].find(c => c.localName === name);
const matrixOf = s => { const v = nums(s); return v.length === 6 ? v : IDENT; };

// risoluzione degli URI relativi alla parte che li contiene
export function resolveUri(base, uri) {
  if (!uri) return "";
  uri = uri.replace(/\\/g, "/").split("#")[0].split("?")[0];
  if (uri.startsWith("/")) return decodeURIComponent(uri);
  const parts = base.split("/");
  parts.pop();
  for (const seg of uri.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return decodeURIComponent(parts.join("/").replace(/^\/?/, "/"));
}

/**
 * Legge una FixedPage.
 * @param {string} xml testo della pagina
 * @param {string} uri percorso assoluto della pagina nel pacchetto (per risolvere gli URI relativi)
 * @param {(uri:string)=>Promise<string|null>} getText lettura di un dizionario esterno
 */
export async function parseFixedPage(xml, uri, getText) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const page = doc.documentElement;
  if (!page || page.localName !== "FixedPage") throw new Error("Pagina XPS non valida");
  const W = +page.getAttribute("Width") || 816, H = +page.getAttribute("Height") || 1056;
  const prims = [];
  const resources = {}; // Canvas "dwfresource_N" -> matrice verso la pagina
  const clips = []; // poligoni di ritaglio condivisi (indice in prims.clip)
  const images = new Set(), fonts = new Set();

  // dizionari di risorse (in pila: la ricerca va dal piu' interno all'esterno)
  async function loadDict(el, base) {
    const map = new Map();
    let rd = el ? child(el, "ResourceDictionary") : null;
    if (!rd) return map;
    let dictBase = base;
    const src = rd.getAttribute("Source");
    if (src) {
      dictBase = resolveUri(base, src);
      const txt = await getText(dictBase);
      if (!txt) return map;
      rd = new DOMParser().parseFromString(txt, "application/xml").documentElement;
    }
    for (const c of rd.children) {
      const key = c.getAttribute("x:Key") || c.getAttributeNS("http://schemas.microsoft.com/xps/2005/06/resourcedictionary-key", "Key") || [...c.attributes].find(a => a.localName === "Key")?.value;
      if (key) map.set(key, { el: c, base: dictBase });
    }
    return map;
  }
  const lookup = (stack, ref) => {
    const m = /\{StaticResource\s+([^}\s]+)\s*\}/.exec(ref || "");
    if (!m) return null;
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k].has(m[1])) return stack[k].get(m[1]);
    return null;
  };

  // pennello: { color } | { image:{uri, viewbox, viewport, m}, opacity } | { gradient }
  function brush(attr, propEl, stack, base, M, opacity) {
    let el = null, b = base;
    if (attr) {
      const col = parseColor(attr);
      if (col) return { color: [col[0], col[1], col[2], Math.round(col[3] * opacity)] };
      const r = lookup(stack, attr);
      if (r) { el = r.el; b = r.base; }
    } else if (propEl) el = propEl.children[0];
    if (!el) return null;
    const op = opacity * (+el.getAttribute("Opacity") || (el.getAttribute("Opacity") === "0" ? 0 : 1));
    switch (el.localName) {
      case "SolidColorBrush": { const col = parseColor(el.getAttribute("Color")) || [0, 0, 0, 255]; return { color: [col[0], col[1], col[2], Math.round(col[3] * op)] }; }
      case "ImageBrush": {
        const src = resolveUri(b, el.getAttribute("ImageSource"));
        images.add(src);
        const tr = el.getAttribute("Transform") ? matrixOf(el.getAttribute("Transform")) : child(el, "ImageBrush.Transform") ? matrixOf(child(child(el, "ImageBrush.Transform"), "MatrixTransform")?.getAttribute("Matrix")) : IDENT;
        return { image: { uri: src, viewbox: nums(el.getAttribute("Viewbox")), viewport: nums(el.getAttribute("Viewport")), m: mul(M, tr), tile: el.getAttribute("TileMode") || "None" }, opacity: op };
      }
      case "LinearGradientBrush": case "RadialGradientBrush": {
        const stopsEl = child(el, el.localName + ".GradientStops");
        const stops = stopsEl ? children(stopsEl, "GradientStop").map(s => ({ o: +s.getAttribute("Offset") || 0, c: parseColor(s.getAttribute("Color")) || [0, 0, 0, 255] })) : [];
        if (!stops.length) return null;
        const tr = el.getAttribute("Transform") ? matrixOf(el.getAttribute("Transform")) : IDENT;
        const G = mul(M, tr);
        const g = { kind: el.localName[0] === "L" ? "linear" : "radial", stops: stops.map(s => ({ o: s.o, c: [s.c[0], s.c[1], s.c[2], Math.round(s.c[3] * op)] })) };
        if (g.kind === "linear") { g.p0 = apply(G, ...nums(el.getAttribute("StartPoint"))); g.p1 = apply(G, ...nums(el.getAttribute("EndPoint"))); }
        else { const c = nums(el.getAttribute("Center")), o = nums(el.getAttribute("GradientOrigin")); g.c = apply(G, c[0], c[1]); g.o = apply(G, o[0], o[1]); g.r = Math.hypot(G[0], G[1]) * (+el.getAttribute("RadiusX") || 0); }
        // colore medio per le esportazioni semplici
        const avg = [0, 1, 2, 3].map(k => Math.round(g.stops.reduce((s, x) => s + x.c[k], 0) / g.stops.length));
        return { gradient: g, color: avg };
      }
      case "VisualBrush": return { color: [128, 128, 128, Math.round(64 * op)] };
      default: return null;
    }
  }

  function clipOf(attr, propEl, stack, M, parentClip) {
    let data = attr;
    if (attr && /StaticResource/.test(attr)) { const r = lookup(stack, attr); data = r ? geometryToData(r.el) : null; }
    else if (!attr && propEl) { const g = child(propEl, "PathGeometry"); data = g ? geometryToData(g) : null; }
    if (!data) return parentClip;
    const G = parsePathData(data, M);
    clips.push({ rings: G.rings, rule: G.fillRule, parent: parentClip });
    return clips.length - 1;
  }

  async function walk(el, M, stack, base, opacity, clip) {
    for (const c of el.children) {
      const n = c.localName;
      if (n === "Canvas") {
        const st = [...stack];
        const res = child(c, "Canvas.Resources");
        if (res) st.push(await loadDict(res, base));
        const rtEl = child(c, "Canvas.RenderTransform");
        const rt = c.getAttribute("RenderTransform") ? (/StaticResource/.test(c.getAttribute("RenderTransform")) ? matrixOf(lookup(st, c.getAttribute("RenderTransform"))?.el.getAttribute("Matrix")) : matrixOf(c.getAttribute("RenderTransform"))) : rtEl ? matrixOf(child(rtEl, "MatrixTransform")?.getAttribute("Matrix")) : IDENT;
        const M2 = mul(M, rt);
        const op = opacity * (c.getAttribute("Opacity") ? +c.getAttribute("Opacity") : 1);
        const cl = clipOf(c.getAttribute("Clip"), child(c, "Canvas.Clip"), st, M2, clip);
        const nm = c.getAttribute("Name");
        if (nm && /^dwfresource_/i.test(nm)) { resources[nm] = M2; prims.push({ t: "r", name: nm }); } // inizio di una risorsa DWFx
        else if (nm) prims.push({ t: "g", name: nm }); // segnaposto per gli attributi W2X
        await walk(c, M2, st, base, op, cl);
      } else if (n === "Path") {
        const rtEl = child(c, "Path.RenderTransform");
        const rt = c.getAttribute("RenderTransform") ? matrixOf(c.getAttribute("RenderTransform")) : rtEl ? matrixOf(child(rtEl, "MatrixTransform")?.getAttribute("Matrix")) : IDENT;
        const M2 = mul(M, rt);
        let data = c.getAttribute("Data"), gm = IDENT;
        if (data && /StaticResource/.test(data)) { const r = lookup(stack, data); data = r ? geometryToData(r.el) : null; if (r?.el.getAttribute("Transform")) gm = matrixOf(r.el.getAttribute("Transform")); }
        else if (!data) { const pd = child(c, "Path.Data"); const g = pd && child(pd, "PathGeometry"); if (g) { data = geometryToData(g); if (g.getAttribute("Transform")) gm = matrixOf(g.getAttribute("Transform")); } }
        if (!data) continue;
        const op = opacity * (c.getAttribute("Opacity") ? +c.getAttribute("Opacity") : 1);
        const G = parsePathData(data, mul(M2, gm));
        if (!G.rings.length) continue;
        const fill = brush(c.getAttribute("Fill"), child(c, "Path.Fill"), stack, base, M2, op);
        const stroke = brush(c.getAttribute("Stroke"), child(c, "Path.Stroke"), stack, base, M2, op);
        const cl = clipOf(c.getAttribute("Clip"), child(c, "Path.Clip"), stack, M2, clip);
        const name = c.getAttribute("Name") || null;
        if (fill?.image) {
          // immagine: il riquadro Viewport nel sistema del pennello, ritagliata dalla forma del percorso
          const vp = fill.image.viewport;
          if (vp.length === 4) {
            const R = mul(fill.image.m, [vp[2], 0, 0, vp[3], vp[0], vp[1]]);
            clips.push({ rings: G.rings, rule: G.fillRule, parent: cl });
            prims.push({ t: "i", m: R, uri: fill.image.uri, viewbox: fill.image.viewbox, opacity: fill.opacity, clip: clips.length - 1, name });
          }
        } else if (fill) prims.push({ t: "p", rings: G.rings, closed: G.closed.map(() => true), fill: true, fillRule: G.fillRule, color: fill.color, gradient: fill.gradient || null, lw: 0, clip: cl, name });
        if (stroke && !stroke.image) {
          const k = Math.sqrt(Math.abs(M2[0] * M2[3] - M2[1] * M2[2])) || 1;
          const th = c.getAttribute("StrokeThickness") === null ? 1 : +c.getAttribute("StrokeThickness");
          const dashAttr = c.getAttribute("StrokeDashArray");
          prims.push({
            t: "p", rings: G.rings, closed: G.closed, fill: false, color: stroke.color, lw: th * k, clip: cl, name,
            dash: dashAttr ? { world: nums(dashAttr).map(v => v * th * k), offset: (+c.getAttribute("StrokeDashOffset") || 0) * th * k } : null,
            cap: ({ Round: "round", Square: "square", Triangle: "round" })[c.getAttribute("StrokeStartLineCap")] || "butt",
            join: ({ Round: "round", Bevel: "bevel" })[c.getAttribute("StrokeLineJoin")] || "miter",
          });
        }
      } else if (n === "Glyphs") {
        const rtEl = child(c, "Glyphs.RenderTransform");
        const rt = c.getAttribute("RenderTransform") ? matrixOf(c.getAttribute("RenderTransform")) : rtEl ? matrixOf(child(rtEl, "MatrixTransform")?.getAttribute("Matrix")) : IDENT;
        const M2 = mul(M, rt);
        const em = +c.getAttribute("FontRenderingEmSize") || 0;
        const ox = +c.getAttribute("OriginX") || 0, oy = +c.getAttribute("OriginY") || 0;
        const s = (c.getAttribute("UnicodeString") || "").replace(/^\{\}/, "");
        if (!s || !em) continue;
        const op = opacity * (c.getAttribute("Opacity") ? +c.getAttribute("Opacity") : 1);
        const fill = brush(c.getAttribute("Fill"), child(c, "Glyphs.Fill"), stack, base, M2, op);
        const fontUri = resolveUri(base, c.getAttribute("FontUri"));
        fonts.add(fontUri);
        const sim = c.getAttribute("StyleSimulations") || "";
        const sideways = c.getAttribute("IsSideways") === "true", rtl = (+c.getAttribute("BidiLevel") || 0) % 2 === 1;
        // avanzamenti dei caratteri (centesimi di em) dall'attributo Indices, se presenti
        let adv = null;
        const ind = c.getAttribute("Indices");
        if (ind && !/[()]/.test(ind)) {
          const parts = ind.split(";");
          adv = [];
          for (let k = 0; k < s.length; k++) {
            const f = (parts[k] || "").split(",");
            adv.push(f.length > 1 && f[1] !== "" ? +f[1] / 100 : null);
          }
          if (adv.every(v => v === null)) adv = null;
        }
        // da spazio testo (em, y verso l'alto, origine sulla linea di base) a pagina
        const T = mul(M2, [em, 0, 0, -em, ox, oy]);
        prims.push({ t: "x", m: T, s, adv, rtl, sideways, fontUri, bold: /Bold/.test(sim), italic: /Italic/.test(sim), color: fill?.color || [0, 0, 0, 255], clip, name: c.getAttribute("Name") || null });
      }
    }
  }

  const rootStack = [];
  const res = child(page, "FixedPage.Resources");
  if (res) rootStack.push(await loadDict(res, uri));
  await walk(page, IDENT, rootStack, uri, 1, null);
  return { width: W, height: H, prims, clips, resources, images: [...images], fonts: [...fonts] };
}

/** chiave di de-offuscamento dei caratteri .odttf: GUID del nome del file, byte in ordine inverso */
export function deobfuscateFont(bytes, uri) {
  const m = /([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})/i.exec(uri.split("/").pop());
  if (!m) return bytes;
  const hex = m.slice(1).join("");
  const key = [];
  for (let i = 30; i >= 0; i -= 2) key.push(parseInt(hex.substr(i, 2), 16));
  const out = bytes.slice();
  for (let i = 0; i < 32 && i < out.length; i++) out[i] ^= key[i % 16];
  return out;
}
