// Confronto di due PDF: sovrapposizione a colori (vecchia rosso, nuova verde, uguale grigio), allineamento automatico e
// manuale, vista affiancata con scorrimento sincronizzato, elenco delle differenze di testo e delle zone grafiche cambiate.
import { button, el, readBytes, toast } from "../core.js";
import { COL, canvasJpeg, csvBlob, diffHunks, diffList, footerNumbers, legend, pdfDoc, reportHeader, reportTable, saveXlsx, chipBox } from "./common.js";
import { t as tr } from "../i18n.js";

let LIB = null;
async function pdfjs() {
  if (!LIB) LIB = import("/vendor/pdfjs/build/pdf.mjs").then(m => { m.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/build/pdf.worker.mjs"; return m; });
  return LIB;
}
const MM = 25.4 / 72; // millimetri per punto
const ICO = {
  overlay: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="13" height="13"/><rect x="8" y="8" width="13" height="13"/></svg>',
  split: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="8" height="16"/><rect x="13" y="4" width="8" height="16"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
  move: '<svg viewBox="0 0 24 24"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/></svg>',
  auto: '<svg viewBox="0 0 24 24"><path d="M4 4h6v6H4zM14 14h6v6h-6zM10 7h4a3 3 0 0 1 3 3v4"/></svg>',
  zones: '<svg viewBox="0 0 24 24"><path d="M4 4h7v7H4zM13 13h7v7h-7z" stroke-dasharray="3 2"/></svg>',
};

export async function mountCompare(env) {
  const { ctx, oldPath, newPath, body, tools, progress, info } = env;
  const lib = await pdfjs();
  progress(0.03, tr("pdfcmp.apertura_due_pdf"));
  const open = async p => lib.getDocument({ data: await readBytes(p), cMapUrl: "/vendor/pdfjs/web/cmaps/", cMapPacked: true, standardFontDataUrl: "/vendor/pdfjs/web/standard_fonts/", isEvalSupported: false }).promise;
  const [dA, dB] = await Promise.all([open(oldPath), open(newPath)]);
  const nA = dA.numPages, nB = dB.numPages, N = Math.max(nA, nB);

  // ---------------------------------------------------------------- testo: parole con posizione (punti, origine in alto a sinistra)
  async function readWords(doc, n, p0, p1) {
    const words = [], sizes = [];
    for (let i = 0; i < n; i++) {
      const page = await doc.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      sizes.push({ w: vp.width, h: vp.height });
      const tc = await page.getTextContent();
      let last = null; // ultima parola, per riunire le parole spezzate in piu' pezzi di testo
      for (const it of tc.items) {
        const str = it.str || "";
        if (!str) { if (it.hasEOL) last = null; continue; }
        const t = it.transform, fh = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]) || 10;
        const ul = Math.hypot(t[0], t[1]) || 1, ux = t[0] / ul, uy = t[1] / ul, vx = t[2] / fh, vy = t[3] / fh;
        const per = (it.width || fh * 0.5 * str.length) / str.length;
        const rectOf = (c0, c1) => {
          const P = [];
          for (const s of [c0 * per, c1 * per]) for (const h of [-0.22 * fh, 0.9 * fh]) P.push(vp.convertToViewportPoint(t[4] + ux * s + vx * h, t[5] + uy * s + vy * h));
          return [Math.min(...P.map(p => p[0])), Math.min(...P.map(p => p[1])), Math.max(...P.map(p => p[0])), Math.max(...P.map(p => p[1]))];
        };
        const re = /\S+/g;
        let m, first = true;
        while ((m = re.exec(str))) {
          const r = rectOf(m.index, m.index + m[0].length);
          // continua la parola precedente se il pezzo di testo inizia attaccato (stessa riga, senza spazio)
          if (first && m.index === 0 && last && !last.space && Math.abs(r[1] - last.r[1]) < fh * 0.35 && r[0] - last.r[2] < fh * 0.18 && r[0] - last.r[2] > -fh * 0.5) {
            last.s += m[0];
            last.r = [Math.min(last.r[0], r[0]), Math.min(last.r[1], r[1]), Math.max(last.r[2], r[2]), Math.max(last.r[3], r[3])];
          } else {
            last = { s: m[0], p: i, r };
            words.push(last);
          }
          first = false;
          last.space = false;
        }
        if (last) last.space = /\s$/.test(str) || it.hasEOL;
      }
      progress(p0 + (p1 - p0) * (i + 1) / n, tr("pdfcmp.lettura_testo_pagina_0_1", i + 1, n));
      page.cleanup();
    }
    for (const w of words) { w.k = w.s.normalize("NFKC").replace(/[’‘`´]/g, "'").replace(/[“”«»]/g, '"').replace(/[‐‑–—]/g, "-"); delete w.space; }
    return { words, sizes };
  }
  const TA = await readWords(dA, nA, 0.05, 0.4), TB = await readWords(dB, nB, 0.4, 0.75);
  const WA = TA.words, WB = TB.words;
  progress(0.8, tr("pdfcmp.confronto_testo"));
  await new Promise(r => setTimeout(r, 0));
  const KA = WA.map(w => w.k), KB = WB.map(w => w.k);
  let hunks = diffHunks(KA, KB);
  if (!hunks) {
    // troppe differenze per il confronto unico: pagina per pagina
    hunks = [];
    const startA = [], startB = [];
    WA.forEach((w, i) => { if (startA[w.p] === undefined) startA[w.p] = i; });
    WB.forEach((w, i) => { if (startB[w.p] === undefined) startB[w.p] = i; });
    const range = (S, W, p) => { const s = S[p]; if (s === undefined) return [0, 0]; let e = s; while (e < W.length && W[e].p === p) e++; return [s, e]; };
    for (let p = 0; p < N; p++) {
      const [a0, a1] = range(startA, WA, p), [b0, b1] = range(startB, WB, p);
      const h = diffHunks(KA.slice(a0, a1), KB.slice(b0, b1), 2000) || [{ a0: 0, a1: a1 - a0, b0: 0, b1: b1 - b0 }];
      for (const q of h) hunks.push({ a0: q.a0 + a0, a1: q.a1 + a0, b0: q.b0 + b0, b1: q.b1 + b0 });
    }
  }
  const pageNear = (W, i) => (W[i] || W[i - 1] || W[W.length - 1] || { p: 0 }).p;
  const textChanges = hunks.map((h, n) => {
    const ow = WA.slice(h.a0, h.a1), nw = WB.slice(h.b0, h.b1);
    const kind = ow.length && nw.length ? "mod" : ow.length ? "del" : "add";
    return {
      n: n + 1, kind, ow, nw, pA: ow.length ? ow[0].p : pageNear(WA, h.a0), pB: nw.length ? nw[0].p : pageNear(WB, h.b0),
      oldText: ow.map(w => w.s).join(" "), newText: nw.map(w => w.s).join(" "),
      ctx: WA.slice(Math.max(0, h.a0 - 4), h.a0).map(w => w.s).join(" "),
    };
  });

  // ---------------------------------------------------------------- disegno delle pagine e sovrapposizione
  const sizeOf = i => TA.sizes[i] || TB.sizes[i];
  async function renderPage(doc, n, i, scale) {
    if (i >= n) return null;
    const page = await doc.getPage(i + 1);
    const vp = page.getViewport({ scale });
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(vp.width));
    c.height = Math.max(1, Math.ceil(vp.height));
    const g = c.getContext("2d", { willReadFrequently: true });
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    // intento "print": pdf.js non aspetta requestAnimationFrame, che si ferma con la finestra nascosta o ridotta a icona
    await page.render({ canvasContext: g, viewport: vp, intent: "print" }).promise;
    return c;
  }
  const lum = (d, i) => 255 - ((d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8);
  function inkOf(c, W, H, al = null, scale = 1) {
    const t = document.createElement("canvas");
    t.width = W; t.height = H;
    const g = t.getContext("2d", { willReadFrequently: true });
    g.fillStyle = "#fff";
    g.fillRect(0, 0, W, H);
    if (c) {
      if (al) g.setTransform(al.k, 0, 0, al.k, al.dx * scale, al.dy * scale);
      g.drawImage(c, 0, 0);
    }
    const d = g.getImageData(0, 0, W, H).data, ink = new Uint8Array(W * H);
    for (let i = 0, j = 0; j < ink.length; i += 4, j++) ink[j] = lum(d, i);
    return ink;
  }
  function dilate(src, W, H, r) {
    if (r <= 0) return src;
    const tmp = new Uint8Array(src.length), out = new Uint8Array(src.length);
    for (let y = 0; y < H; y++) { const o = y * W; for (let x = 0; x < W; x++) { let m = 0; for (let k = Math.max(0, x - r), e = Math.min(W - 1, x + r); k <= e; k++) if (src[o + k] > m) m = src[o + k]; tmp[o + x] = m; } }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let m = 0; for (let k = Math.max(0, y - r), e = Math.min(H - 1, y + r); k <= e; k++) if (tmp[k * W + x] > m) m = tmp[k * W + x]; out[y * W + x] = m; }
    return out;
  }
  // cA, cB: pagine disegnate alla stessa scala; al: posizione della nuova rispetto alla vecchia (punti, scala)
  function composite(cA, cB, al, scale, opt) {
    const base = cA || cB;
    const W = cA ? cA.width : Math.ceil(cB.width * al.k), H = cA ? cA.height : Math.ceil(cB.height * al.k);
    const a = inkOf(cA, W, H), b = inkOf(cB, W, H, al, scale);
    const tol = Math.max(0, Math.round(opt.tol * scale));
    const da = dilate(a, W, H, tol), db = dilate(b, W, H, tol);
    const out = document.createElement("canvas");
    out.width = W; out.height = H;
    const g = out.getContext("2d", { willReadFrequently: true });
    const img = g.createImageData(W, H), o = img.data;
    const cs = Math.max(4, Math.round(6 * scale)), gw = Math.ceil(W / cs), gh = Math.ceil(H / cs);
    const cellA = new Uint32Array(gw * gh), cellB = new Uint32Array(gw * gh);
    for (let j = 0, i = 0; j < a.length; j++, i += 4) {
      const ia = opt.showOld ? a[j] : 0, ib = opt.showNew ? b[j] : 0;
      let c, oa, ob;
      if (opt.showOld && opt.showNew) {
        c = Math.max(Math.min(ia, db[j]), Math.min(ib, da[j]));
        oa = Math.max(0, ia - db[j]);
        ob = Math.max(0, ib - da[j]);
        // per le zone conta solo l'inchiostro senza nulla di simile vicino nell'altra revisione (l'antialiasing non fa differenza)
        const xa = ia > 110 && db[j] < 45, xb = ib > 110 && da[j] < 45;
        if (xa || xb) { const x = j % W, y = (j / W) | 0, ci = ((y / cs) | 0) * gw + ((x / cs) | 0); if (xa) cellA[ci]++; if (xb) cellB[ci]++; }
      } else { c = Math.max(ia, ib); oa = ob = 0; }
      // grigio per l'inchiostro comune, rosso per quello solo nella vecchia, verde per quello solo nella nuova
      o[i] = 255 - c * 0.55 - oa * 0.10 - ob * 0.82;
      o[i + 1] = 255 - c * 0.55 - oa * 0.80 - ob * 0.38;
      o[i + 2] = 255 - c * 0.55 - oa * 0.78 - ob * 0.70;
      o[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return { canvas: out, zones: zonesOf(cellA, cellB, gw, gh, cs, scale), base };
  }
  // zone cambiate: celle con inchiostro diverso, unite se vicine
  function zonesOf(cellA, cellB, gw, gh, cs, scale) {
    const min = Math.max(2, Math.round(scale * scale * 1.5));
    const on = new Uint8Array(gw * gh);
    for (let i = 0; i < on.length; i++) on[i] = cellA[i] + cellB[i] >= min ? 1 : 0;
    const seen = new Uint8Array(gw * gh), zones = [], R = 2;
    for (let s = 0; s < on.length; s++) {
      if (!on[s] || seen[s]) continue;
      const q = [s];
      seen[s] = 1;
      let x0 = gw, y0 = gh, x1 = 0, y1 = 0, na = 0, nb = 0;
      while (q.length) {
        const c = q.pop(), cx = c % gw, cy = (c / gw) | 0;
        x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
        na += cellA[c]; nb += cellB[c];
        for (let yy = Math.max(0, cy - R); yy <= Math.min(gh - 1, cy + R); yy++) for (let xx = Math.max(0, cx - R); xx <= Math.min(gw - 1, cx + R); xx++) {
          const k = yy * gw + xx;
          if (on[k] && !seen[k]) { seen[k] = 1; q.push(k); }
        }
      }
      const pad = 2;
      zones.push({ x0: Math.max(0, (x0 * cs - pad)) / scale, y0: Math.max(0, (y0 * cs - pad)) / scale, x1: ((x1 + 1) * cs + pad) / scale, y1: ((y1 + 1) * cs + pad) / scale,
        kind: na > nb * 4 ? "del" : nb > na * 4 ? "add" : "mod", na, nb });
    }
    return zones.sort((p, q) => p.y0 - q.y0 || p.x0 - q.x0);
  }

  // ---------------------------------------------------------------- allineamento automatico (spostamento, con scala se le pagine sono diverse)
  const aligns = new Array(N).fill(null);
  const baseAlign = i => {
    const sa = TA.sizes[i], sb = TB.sizes[i];
    const k = sa && sb && Math.abs(sa.w / sb.w - 1) > 0.02 ? sa.w / sb.w : 1;
    return { dx: 0, dy: 0, k, auto: false };
  };
  function maskOf(c, W, H, k) {
    const t = document.createElement("canvas");
    t.width = W; t.height = H;
    const g = t.getContext("2d", { willReadFrequently: true });
    g.fillStyle = "#fff";
    g.fillRect(0, 0, W, H);
    g.drawImage(c, 0, 0, c.width * k, c.height * k);
    const d = g.getImageData(0, 0, W, H).data, m = new Uint8Array(W * H), pts = [];
    for (let i = 0, j = 0; j < m.length; i += 4, j++) if (lum(d, i) > 60) { m[j] = 1; pts.push(j); }
    return { m, pts };
  }
  function bestShift(A, B, W, H, cx, cy, R) {
    let best = { s: -1, x: cx, y: cy };
    for (let sy = cy - R; sy <= cy + R; sy++) for (let sx = cx - R; sx <= cx + R; sx++) {
      let s = 0;
      for (const p of B.pts) {
        const x = (p % W) + sx, y = ((p / W) | 0) + sy;
        if (x >= 0 && y >= 0 && x < W && y < H && A.m[y * W + x]) s++;
      }
      if (s > best.s) best = { s, x: sx, y: sy };
    }
    return best;
  }
  function autoAlign(cA, cB, scale, k0) {
    if (!cA || !cB) return { dx: 0, dy: 0, k: k0, auto: true };
    const fine = 560 / cA.width, coarse = 140 / cA.width;
    const Wf = Math.round(cA.width * fine), Hf = Math.round(cA.height * fine);
    const Af = maskOf(cA, Wf, Hf, fine), Bf = maskOf(cB, Wf, Hf, fine * k0);
    if (!Af.pts.length || !Bf.pts.length) return { dx: 0, dy: 0, k: k0, auto: true };
    const id = bestShift(Af, Bf, Wf, Hf, 0, 0, 0);
    const norm = Math.min(Af.pts.length, Bf.pts.length);
    if (id.s / norm > 0.9) return { dx: 0, dy: 0, k: k0, auto: true };
    const Wc = Math.round(cA.width * coarse), Hc = Math.round(cA.height * coarse);
    const Ac = maskOf(cA, Wc, Hc, coarse), Bc = maskOf(cB, Wc, Hc, coarse * k0);
    const c = bestShift(Ac, Bc, Wc, Hc, 0, 0, 30);
    const f = bestShift(Af, Bf, Wf, Hf, Math.round(c.x * Wf / Wc), Math.round(c.y * Hf / Hc), 5);
    if (f.s < id.s * 1.08) return { dx: 0, dy: 0, k: k0, auto: true };
    // rifinitura alla risoluzione piena della pagina disegnata (fino a ~1200 px di larghezza)
    const full = Math.min(1, 1200 / cA.width);
    if (full > fine * 1.3) {
      const Wh = Math.round(cA.width * full), Hh = Math.round(cA.height * full);
      const Ah = maskOf(cA, Wh, Hh, full), Bh = maskOf(cB, Wh, Hh, full * k0);
      const h = bestShift(Ah, Bh, Wh, Hh, Math.round(f.x * full / fine), Math.round(f.y * full / fine), 2);
      return { dx: h.x / (full * scale), dy: h.y / (full * scale), k: k0, auto: true };
    }
    const toPt = 1 / (fine * scale);
    return { dx: f.x * toPt, dy: f.y * toPt, k: k0, auto: true };
  }

  // ---------------------------------------------------------------- analisi di tutte le pagine (zone grafiche) in sottofondo
  const AN_SCALE = 1.5;
  const zonesByPage = new Array(N).fill(null);
  let autoOn = true, stopped = false;
  const opt = { showOld: true, showNew: true, tol: 0.6, zones: true };
  async function analyzePage(i) {
    const [cA, cB] = await Promise.all([renderPage(dA, nA, i, AN_SCALE), renderPage(dB, nB, i, AN_SCALE)]);
    if (!aligns[i]) {
      const b = baseAlign(i);
      aligns[i] = autoOn ? autoAlign(cA, cB, AN_SCALE, b.k) : b;
    }
    if (!cA || !cB) {
      const s = sizeOf(i);
      zonesByPage[i] = [{ x0: 0, y0: 0, x1: s.w, y1: s.h, kind: cA ? "del" : "add", whole: true }];
    } else zonesByPage[i] = markText(composite(cA, cB, aligns[i], AN_SCALE, { ...opt, showOld: true, showNew: true }).zones, i);
  }
  const analysis = (async () => {
    for (let i = 0; i < N && !stopped; i++) {
      if (!zonesByPage[i]) await analyzePage(i);
      ctx.status(i + 1 < N ? tr("pdfcmp.analisi_grafica_pagina_0_1", i + 1, N) : "");
      if (i % 3 === 2 || i === N - 1) refreshList();
      await new Promise(r => setTimeout(r, 0));
    }
    refreshSummary();
  })();

  // ---------------------------------------------------------------- interfaccia
  progress(0.9, tr("pdfcmp.preparazione_vista"));
  const side = el("div", { class: "cmp-side" }), main = el("div", { class: "cmp-main" });
  body.append(side, main);
  const sum = el("div", { class: "cmp-sum" });
  const fText = chipBox(tr("pdfcmp.differenze_testo"), COL.mod, true, () => refreshList(), textChanges.length);
  const fGraph = chipBox(tr("pdfcmp.zone_grafiche_cambiate"), COL.prop, true, () => refreshList());
  const search = el("input", { type: "search", class: "field cmp-search", placeholder: tr("pdfcmp.cerca_nelle_differenze") });
  search.addEventListener("input", () => refreshList());
  const list = diffList({ onPick: pick });
  side.append(el("div", { class: "cmp-sec" }, el("h4", {}, tr("pdfcmp.riepilogo")), sum),
    el("div", { class: "cmp-sec" }, el("h4", {}, tr("pdfcmp.mostra_nell_elenco")), fText, fGraph, search), list.el);

  function refreshSummary() {
    const nz = zonesByPage.reduce((s, z, p) => s + gZones(p).length, 0);
    const cnt = k => textChanges.filter(c => c.kind === k).length;
    sum.innerHTML = "";
    const box = (n, t, c) => el("div", {}, el("b", { style: { color: c || "" } }, String(n)), el("span", {}, t));
    sum.append(box(nA === nB ? nA : `${nA}→${nB}`, tr("pdfcmp.n_pagine")), box(cnt("mod"), tr("pdfcmp.testi_modificati"), COL.mod), box(cnt("add"), tr("pdfcmp.testi_aggiunti"), COL.add),
      box(cnt("del"), tr("pdfcmp.testi_eliminati"), COL.del), box(zonesByPage.every(Boolean) ? nz : nz + "…", tr("pdfcmp.zone_grafiche"), COL.prop));
  }
  const clip = (s, n = 90) => (s.length > n ? s.slice(0, n) + "…" : s);
  // zone grafiche che coincidono con una differenza di testo: restano nella sovrapposizione ma non si ripetono nell'elenco
  function markText(zs, p) {
    if (!zs) return zs;
    const a = aligns[p] || baseAlign(p), R = [];
    for (const c of textChanges) {
      for (const w of c.ow) if (w.p === p) R.push(w.r);
      for (const w of c.nw) if (w.p === p) R.push([w.r[0] * a.k + a.dx, w.r[1] * a.k + a.dy, w.r[2] * a.k + a.dx, w.r[3] * a.k + a.dy]);
    }
    // "di testo" se le parole cambiate coprono gran parte della zona (una zona con un disegno nuovo accanto a un testo resta grafica)
    for (const z of zs) {
      if (z.whole) { z.text = false; continue; }
      let cov = 0;
      for (const r of R) cov += Math.max(0, Math.min(r[2], z.x1) - Math.max(r[0], z.x0)) * Math.max(0, Math.min(r[3], z.y1) - Math.max(r[1], z.y0));
      z.text = cov >= 0.35 * (z.x1 - z.x0) * (z.y1 - z.y0);
    }
    return zs;
  }
  const gZones = p => (zonesByPage[p] || []).filter(z => !z.text);
  const zoneTitle = z => z.whole ? (z.kind === "del" ? tr("pdfcmp.pagina_eliminata") : tr("pdfcmp.pagina_aggiunta")) : z.kind === "del" ? tr("pdfcmp.grafica_rimossa") : z.kind === "add" ? tr("pdfcmp.grafica_aggiunta") : tr("pdfcmp.grafica_modificata");
  function refreshList() {
    const q = search.value.trim().toLowerCase();
    const items = [];
    if (fText.input.checked) for (const c of textChanges) {
      if (q && !(c.oldText + " " + c.newText).toLowerCase().includes(q)) continue;
      items.push({ type: "t", c, page: c.kind === "del" ? c.pA : c.pB, color: COL[c.kind],
        title: c.kind === "mod" ? tr("pdfcmp.testo_modificato") : c.kind === "add" ? tr("pdfcmp.testo_aggiunto") : tr("pdfcmp.testo_eliminato"),
        where: tr("pdfcmp.pag", c.pA + 1) + (c.pA !== c.pB ? " → " + (c.pB + 1) : ""),
        sub: c.kind === "mod" ? `«${clip(c.oldText, 40)}» → «${clip(c.newText, 40)}»` : `«${clip(c.kind === "del" ? c.oldText : c.newText)}»`,
        tip: (c.oldText ? tr("pdfcmp.vecchio") + clip(c.oldText, 400) : "") + (c.newText ? "\nNuovo: " + clip(c.newText, 400) : "") });
    }
    if (fGraph.input.checked && !q) zonesByPage.forEach((zs, p) => gZones(p).forEach((z, k) => items.push({ type: "z", z, page: p, k, color: COL[z.kind] || COL.prop,
      title: zoneTitle(z), where: tr("pdfcmp.pag", p + 1), sub: z.whole ? "" : tr("pdfcmp.zona_pos", Math.round(z.x0 * MM), Math.round(z.y0 * MM), Math.round((z.x1 - z.x0) * MM), Math.round((z.y1 - z.y0) * MM)) })));
    items.sort((a, b) => a.page - b.page || (a.type === b.type ? 0 : a.type === "z" ? 1 : -1));
    list.set(items);
    if (!items.length) list.el.querySelector(".cmp-list-in").append(el("div", { class: "cmp-empty" }, q ? tr("pdfcmp.nessuna_differenza_contiene_testo_cercato") : zonesByPage.every(Boolean) ? tr("pdfcmp.nessuna_differenza_i_due_documenti") : tr("pdfcmp.analisi_corso")));
  }

  // barra della vista
  let mode = "overlay", page = 0, moveMode = false;
  const bar = el("div", { class: "cmp-bar" }), stage = el("div", { class: "cmp-stage" });
  main.append(bar, stage);
  const bOv = button(tr("pdfcmp.sovrapposizione"), ICO.overlay, () => setMode("overlay"), { title: tr("pdfcmp.due_revisioni_sopra_l_altra") });
  const bSp = button(tr("pdfcmp.affiancati"), ICO.split, () => setMode("split"), { title: tr("pdfcmp.due_revisioni_affiancate_scorrimento_sincronizzato") });
  const pgLbl = el("span", { class: "pg" });
  const bPrev = button("", ICO.prev, () => goPage(page - 1), { iconOnly: true, title: tr("pdfcmp.pagina_precedente") });
  const bNext = button("", ICO.next, () => goPage(page + 1), { iconOnly: true, title: tr("pdfcmp.pagina_successiva") });
  const cOld = el("input", { type: "checkbox", checked: true }), cNew = el("input", { type: "checkbox", checked: true });
  cOld.addEventListener("change", () => { opt.showOld = cOld.checked; recompose(); });
  cNew.addEventListener("change", () => { opt.showNew = cNew.checked; recompose(); });
  const bZones = button(tr("pdfcmp.zone"), ICO.zones, () => { opt.zones = !opt.zones; bZones.classList.toggle("on", opt.zones); drawBoxes(); }, { title: tr("pdfcmp.riquadri_attorno_alle_zone_cambiate") });
  bZones.classList.add("on");
  const bMove = button(tr("pdfcmp.allinea_mano"), ICO.move, () => { moveMode = !moveMode; bMove.classList.toggle("on", moveMode); hint.hidden = !moveMode; }, { title: tr("pdfcmp.trascina_revisione_nuova_allinearla_frecce") });
  const bAuto = button(tr("pdfcmp.automatico"), ICO.auto, () => realign(), { title: tr("pdfcmp.allinea_automaticamente_nuova_revisione_vecchia") });
  const iDx = el("input", { type: "number", step: "0.1", title: tr("pdfcmp.spostamento_orizzontale_nuova_revisione_mm") });
  const iDy = el("input", { type: "number", step: "0.1", title: tr("pdfcmp.spostamento_verticale_nuova_revisione_mm") });
  const iK = el("input", { type: "number", step: "0.1", title: tr("pdfcmp.scala_nuova_revisione") });
  const onNum = () => { const a = curAlign(); a.dx = (+iDx.value || 0) / MM; a.dy = (+iDy.value || 0) / MM; a.k = (+iK.value || 100) / 100; a.auto = false; aligned(); };
  [iDx, iDy, iK].forEach(i => i.addEventListener("change", onNum));
  const bAll = button(tr("pdfcmp.tutte_pagine"), "", () => { const a = curAlign(); for (let i = 0; i < N; i++) aligns[i] = { ...a }; zonesByPage.fill(null); reanalyze(); toast(tr("pdfcmp.allineamento_applicato_tutte_pagine")); }, { title: tr("pdfcmp.usa_questo_allineamento_tutte_pagine") });
  const cAuto = el("input", { type: "checkbox", checked: true, title: tr("pdfcmp.allineamento_automatico_ogni_pagina") });
  cAuto.addEventListener("change", () => { autoOn = cAuto.checked; aligns.fill(null); zonesByPage.fill(null); reanalyze(); });
  const legendEl = el("span", { class: "cmp-legend" }, ...[[COL.del, tr("pdfcmp.solo_vecchia")], [COL.add, tr("pdfcmp.solo_nuova")], ["#8b8d98", tr("pdfcmp.l_uguale")]].map(([c, t]) => el("span", {}, el("i", { class: "cmp-chip", style: { background: c } }), t)));
  const alignBox = el("span", { style: { display: "inline-flex", alignItems: "center", gap: "2px" } }, el("span", { class: "sep" }), bMove, bAuto,
    el("label", {}, cAuto, "auto"), el("label", {}, "X", iDx), el("label", {}, "Y", iDy), el("label", {}, "%", iK), bAll);
  bar.append(bOv, bSp, el("span", { class: "sep" }), bPrev, pgLbl, bNext, el("span", { class: "sep" }),
    button("", "zoomOut", () => zoomBy(1 / 1.25), { iconOnly: true, title: tr("pdfcmp.riduci") }), button(tr("pdfcmp.adatta"), "fit", () => fitZoom(), { title: tr("pdfcmp.adatta_larghezza") }), button("", "zoomIn", () => zoomBy(1.25), { iconOnly: true, title: tr("pdfcmp.ingrandisci") }),
    el("span", { class: "sep" }), el("label", { title: tr("pdfcmp.mostra_revisione_vecchia") }, cOld, tr("pdfcmp.vecchia")), el("label", { title: tr("pdfcmp.mostra_revisione_nuova") }, cNew, tr("pdfcmp.nuova")), bZones, alignBox, el("span", { class: "grow" }), legendEl);
  tools.append(el("span", { class: "note" }, tr("pdfcmp.0_pagine_1_pagine", nA, nB)));

  // ---- vista sovrapposta
  const ovScroll = el("div", { class: "cmp-scroll" }), sheet = el("div", { class: "cmp-sheet" }), ovCanvas = el("canvas"), boxes = el("div", { style: { position: "absolute", inset: 0 } });
  const hint = el("div", { class: "cmp-hint", hidden: true }, tr("pdfcmp.trascina_spostare_revisione_nuova_frecce"));
  sheet.append(ovCanvas, boxes);
  new ResizeObserver(() => { if (mode === "overlay" && !userZoom && ovScroll.clientWidth > 0) fitZoom(); }).observe(ovScroll);
  ovScroll.append(sheet);
  const ovWrap = el("div", { style: { position: "absolute", inset: 0 } }, ovScroll, hint);
  let zoom = 1, userZoom = false, renderScale = 0, cache = { i: -1, s: 0, a: null, b: null }, comp = null, flashRect = null;
  const curAlign = () => (aligns[page] ||= baseAlign(page));
  const pageSize = () => sizeOf(page);
  function layoutSheet() { const s = pageSize(); sheet.style.width = s.w * zoom + "px"; sheet.style.height = s.h * zoom + "px"; }
  function fitZoom() {
    if (mode === "split") { splitZoom = 1; layoutSplit(); return; }
    const s = pageSize(), W = ovScroll.clientWidth - 40, H = ovScroll.clientHeight - 32;
    if (W <= 0) return;
    userZoom = false;
    zoom = Math.max(0.05, Math.min(W / s.w, s.w > s.h ? H / s.h : Infinity) || 1);
    layoutSheet();
    schedule();
  }
  function zoomBy(f) {
    if (mode === "split") { splitZoom *= f; layoutSplit(); return; }
    const cx = (ovScroll.scrollLeft + ovScroll.clientWidth / 2) / zoom, cy = (ovScroll.scrollTop + ovScroll.clientHeight / 2) / zoom;
    zoom = Math.min(20, Math.max(0.05, zoom * f));
    userZoom = true;
    layoutSheet();
    ovScroll.scrollLeft = cx * zoom - ovScroll.clientWidth / 2;
    ovScroll.scrollTop = cy * zoom - ovScroll.clientHeight / 2;
    schedule();
  }
  let timer = 0, busy = false, again = false;
  function schedule() { clearTimeout(timer); timer = setTimeout(renderOverlay, 120); }
  async function renderOverlay() {
    if (mode !== "overlay") return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      const s = pageSize(), dpr = devicePixelRatio || 1;
      const scale = Math.min(zoom * dpr, Math.sqrt(14e6 / (s.w * s.h)), 6);
      if (cache.i !== page || Math.abs(cache.s - scale) > 1e-3) {
        const [a, b] = await Promise.all([renderPage(dA, nA, page, scale), renderPage(dB, nB, page, scale)]);
        cache = { i: page, s: scale, a, b };
      }
      renderScale = scale;
      if (!aligns[page]) { const b0 = baseAlign(page); aligns[page] = autoOn ? autoAlign(cache.a, cache.b, scale, b0.k) : b0; }
      recompose();
    } finally { busy = false; if (again) { again = false; renderOverlay(); } }
  }
  function recompose() {
    if (cache.i !== page) return;
    comp = composite(cache.a, cache.b, curAlign(), cache.s, opt);
    ovCanvas.width = comp.canvas.width;
    ovCanvas.height = comp.canvas.height;
    ovCanvas.getContext("2d").drawImage(comp.canvas, 0, 0);
    showAlign();
    drawBoxes();
  }
  function showAlign() {
    const a = curAlign();
    iDx.value = (a.dx * MM).toFixed(2); iDy.value = (a.dy * MM).toFixed(2); iK.value = (a.k * 100).toFixed(2);
  }
  function aligned() {
    zonesByPage[page] = null;
    recompose();
    if (comp && cache.a && cache.b) zonesByPage[page] = markText(comp.zones.map(z => ({ ...z })), page); // zone ricalcolate con il nuovo allineamento
    refreshList();
    refreshSummary();
  }
  function drawBoxes() {
    boxes.innerHTML = "";
    const add = (r, color, cls = "", dash = false) => boxes.append(el("div", { class: "cmp-box " + cls, style: { left: r[0] * zoom - 3 + "px", top: r[1] * zoom - 3 + "px", width: (r[2] - r[0]) * zoom + 6 + "px", height: (r[3] - r[1]) * zoom + 6 + "px", borderColor: color, borderStyle: dash ? "dashed" : "solid", borderWidth: dash ? "1.5px" : "2px" } }));
    if (opt.zones && comp && opt.showOld && opt.showNew) for (const z of comp.zones) add([z.x0, z.y0, z.x1, z.y1], COL[z.kind] || COL.prop, "", true);
    if (flashRect && flashRect.page === page) for (const r of flashRect.rects) add(r.r, r.color, "flash");
  }
  async function goPage(i, keepScroll = false) {
    i = Math.max(0, Math.min(N - 1, i));
    page = i;
    pgLbl.textContent = tr("pdfcmp.pagina_0_1", i + 1, N);
    bPrev.disabled = i === 0; bNext.disabled = i === N - 1;
    if (mode === "overlay") {
      layoutSheet();
      if (!keepScroll) ovScroll.scrollTop = 0;
      await renderOverlay();
    } else scrollSplitTo(i);
  }

  // trascinamento: sposta la vista o, in "Allinea a mano", la revisione nuova
  let drag = null;
  sheet.addEventListener("pointerdown", e => {
    if (e.button !== 0 && e.button !== 1) return;
    drag = { x: e.clientX, y: e.clientY, sl: ovScroll.scrollLeft, st: ovScroll.scrollTop, a: { ...curAlign() } };
    try { sheet.setPointerCapture(e.pointerId); } catch { /* */ }
  });
  let raf = 0;
  sheet.addEventListener("pointermove", e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (moveMode && e.buttons === 1) {
      const a = curAlign();
      a.dx = drag.a.dx + dx / zoom; a.dy = drag.a.dy + dy / zoom; a.auto = false;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; recompose(); });
    } else { ovScroll.scrollLeft = drag.sl - dx; ovScroll.scrollTop = drag.st - dy; }
  });
  sheet.addEventListener("pointerup", () => { if (drag && moveMode) aligned(); drag = null; });
  ovScroll.addEventListener("wheel", e => { if (e.ctrlKey) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15); } }, { passive: false });
  const onKey = e => {
    if (ctx.tab.view.hidden || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || "")) return;
    if (moveMode && mode === "overlay" && e.key.startsWith("Arrow")) {
      const st = e.shiftKey ? 5 : 0.5, a = curAlign();
      if (e.key === "ArrowLeft") a.dx -= st; else if (e.key === "ArrowRight") a.dx += st; else if (e.key === "ArrowUp") a.dy -= st; else a.dy += st;
      a.auto = false;
      e.preventDefault();
      clearTimeout(keyT); recompose(); keyT = setTimeout(aligned, 400);
    } else if (e.key === "Escape" && moveMode) { bMove.click(); e.preventDefault(); }
    else if (e.key === "PageDown") { goPage(page + 1); e.preventDefault(); } else if (e.key === "PageUp") { goPage(page - 1); e.preventDefault(); }
  };
  let keyT = 0;
  window.addEventListener("keydown", onKey);
  async function realign() {
    if (!cache.a || !cache.b) return toast(tr("pdfcmp.questa_pagina_manca_due_revisioni"), true);
    const b0 = baseAlign(page);
    aligns[page] = autoAlign(cache.a, cache.b, cache.s, b0.k);
    aligned();
    const a = aligns[page];
    toast(a.dx || a.dy ? tr("pdfcmp.nuova_revisione_spostata_0_mm", (a.dx * MM).toFixed(1), (a.dy * MM).toFixed(1)) : tr("pdfcmp.pagine_erano_gia_allineate"));
  }
  async function reanalyze() {
    stopped = false;
    cache.i = -1;
    await renderOverlay();
    for (let i = 0; i < N; i++) if (!zonesByPage[i]) { await analyzePage(i); if (i % 3 === 2) refreshList(); await new Promise(r => setTimeout(r, 0)); }
    refreshList(); refreshSummary();
  }

  // ---- vista affiancata con scorrimento sincronizzato
  let splitZoom = 1, splitBuilt = false;
  const colA = el("div", { class: "cmp-col" }), colB = el("div", { class: "cmp-col" });
  const scA = el("div", { class: "cmp-scroll" }), scB = el("div", { class: "cmp-scroll" });
  colA.append(el("div", { class: "hd" }, el("i", { class: "cmp-chip", style: { background: COL.del } }), tr("pdfcmp.vecchia_2"), el("b", {}, info.oldName)), scA);
  colB.append(el("div", { class: "hd" }, el("i", { class: "cmp-chip", style: { background: COL.add } }), tr("pdfcmp.nuova_2"), el("b", {}, info.newName)), scB);
  const split = el("div", { class: "cmp-split" }, colA, colB);
  const sheetsA = [], sheetsB = [];
  const io = new IntersectionObserver(ents => { for (const en of ents) if (en.isIntersecting) paintSheet(en.target); }, { rootMargin: "400px" });
  function buildSplit() {
    splitBuilt = true;
    const mk = (doc, n, sizes, list, sc, side) => {
      for (let i = 0; i < N; i++) {
        const s = sizes[i] || sizeOf(i);
        const sh = el("div", { class: "cmp-sheet", style: { background: i < n ? "#fff" : "transparent", boxShadow: i < n ? "" : "none", outline: i < n ? "" : "2px dashed rgba(255,255,255,.35)" } }, el("span", { class: "pn" }, i < n ? tr("pdfcmp.pagina_0", i + 1) : tr("pdfcmp.pagina_0_assente", i + 1)));
        sh._d = { doc, n, i, s, side, done: 0 };
        list.push(sh);
        sc.append(sh);
        if (i < n) io.observe(sh);
      }
    };
    mk(dA, nA, TA.sizes, sheetsA, scA, "a");
    mk(dB, nB, TB.sizes, sheetsB, scB, "b");
    layoutSplit();
  }
  function layoutSplit() {
    const W = (scA.clientWidth || 400) - 36;
    const maxW = Math.max(...TA.sizes.map(s => s.w), ...TB.sizes.map(s => s.w), 1);
    const z = (W / maxW) * splitZoom;
    for (const sh of [...sheetsA, ...sheetsB]) {
      const { s } = sh._d;
      sh.style.width = s.w * z + "px"; sh.style.height = s.h * z + "px";
      sh._d.z = z;
      if (sh._d.done && Math.abs(sh._d.done - z) / z > 0.3) { sh._d.done = 0; if (sh._d.i < sh._d.n) { io.unobserve(sh); io.observe(sh); } }
      boxesFor(sh);
    }
  }
  async function paintSheet(sh) {
    const d = sh._d;
    if (d.done && Math.abs(d.done - d.z) / d.z < 0.3) return;
    d.done = d.z;
    const scale = Math.min(d.z * (devicePixelRatio || 1), 4);
    const c = await renderPage(d.doc, d.n, d.i, scale);
    if (!c) return;
    c.style.cssText = "display:block;width:100%;height:100%";
    sh.querySelector("canvas")?.remove();
    sh.prepend(c);
  }
  function boxesFor(sh) {
    sh.querySelectorAll(".cmp-box").forEach(b => b.remove());
    const { i, side, z } = sh._d;
    for (const c of textChanges) {
      const words = side === "a" ? c.ow : c.nw;
      if (!words.length) continue;
      for (const r of lineRects(words.filter(w => w.p === i))) {
        const isFlash = flashRect && flashRect.c === c;
        sh.append(el("div", { class: "cmp-box" + (isFlash ? " flash" : ""), style: { left: r[0] * z - 2 + "px", top: r[1] * z - 2 + "px", width: (r[2] - r[0]) * z + 4 + "px", height: (r[3] - r[1]) * z + 4 + "px",
          borderColor: side === "a" ? COL.del : COL.add, borderWidth: "1px", background: side === "a" ? "rgba(229,72,77,.16)" : "rgba(47,158,91,.16)" } }));
      }
    }
  }
  // parole vicine sulla stessa riga unite in un solo riquadro
  function lineRects(words) {
    const out = [];
    for (const w of words.slice(0, 400)) {
      const r = out[out.length - 1];
      if (r && Math.abs(r[1] - w.r[1]) < (w.r[3] - w.r[1]) * 0.5 && w.r[0] - r[2] < (w.r[3] - w.r[1]) * 1.5 && w.r[0] >= r[0] - 2) { r[2] = Math.max(r[2], w.r[2]); r[3] = Math.max(r[3], w.r[3]); r[1] = Math.min(r[1], w.r[1]); }
      else out.push([...w.r]);
    }
    return out;
  }
  const where = (sc, list) => {
    const top = sc.scrollTop;
    for (let i = 0; i < list.length; i++) { const sh = list[i], y0 = sh.offsetTop - 16, h = sh.offsetHeight + 32; if (top < y0 + h) return [i, Math.max(0, (top - y0) / h)]; }
    return [list.length - 1, 1];
  };
  // l'evento di scorrimento provocato dalla sincronizzazione si riconosce dalla posizione attesa e si ignora
  const syncFrom = (src, dst, ls, ld) => {
    if (src._expect !== undefined && Math.abs(src.scrollTop - src._expect) < 2) { src._expect = undefined; return; }
    src._expect = undefined;
    const [i, f] = where(src, ls), sh = ld[i];
    if (sh) {
      const y = Math.max(0, Math.min(dst.scrollHeight - dst.clientHeight, sh.offsetTop - 16 + f * (sh.offsetHeight + 32)));
      if (Math.abs(dst.scrollTop - y) >= 1) { dst._expect = y; dst.scrollTop = y; }
      if (dst.scrollLeft !== src.scrollLeft) { dst.scrollLeft = src.scrollLeft; }
    }
    page = i; pgLbl.textContent = tr("pdfcmp.pagina_0_1", i + 1, N); bPrev.disabled = i === 0; bNext.disabled = i === N - 1;
  };
  scA.addEventListener("scroll", () => syncFrom(scA, scB, sheetsA, sheetsB));
  scB.addEventListener("scroll", () => syncFrom(scB, scA, sheetsB, sheetsA));
  function scrollSplitTo(i, y = 0) { const sh = sheetsA[i]; if (sh) { scA.scrollTop = sh.offsetTop - 16 + y * sh._d.z - 60 * (y ? 1 : 0); syncFrom(scA, scB, sheetsA, sheetsB); } }

  function setMode(m) {
    mode = m;
    bOv.classList.toggle("on", m === "overlay");
    bSp.classList.toggle("on", m === "split");
    alignBox.style.display = m === "overlay" ? "inline-flex" : "none";
    legendEl.style.display = cOld.parentElement.style.display = cNew.parentElement.style.display = bZones.style.display = m === "overlay" ? "" : "none";
    stage.innerHTML = "";
    if (m === "overlay") { stage.append(ovWrap); fitZoom(); goPage(page); }
    else { stage.append(split); if (!splitBuilt) buildSplit(); else layoutSplit(); requestAnimationFrame(() => scrollSplitTo(page)); }
  }

  // ---- scelta di una differenza nell'elenco
  async function pick(it) {
    if (it.type === "t") {
      const c = it.c;
      const p = c.kind === "del" ? c.pA : c.pB;
      // nella sovrapposizione i riquadri della nuova si portano nello spazio della vecchia
      const a = aligns[p] || baseAlign(p);
      const rects = [...lineRects(c.ow.filter(w => w.p === p)).map(r => ({ r, color: COL.del })),
        ...lineRects(c.nw.filter(w => w.p === p)).map(r => ({ r: [r[0] * a.k + a.dx, r[1] * a.k + a.dy, r[2] * a.k + a.dx, r[3] * a.k + a.dy], color: COL.add }))];
      flashRect = { page: p, rects, c };
      if (mode === "overlay") {
        if (page !== p) await goPage(p, true);
        drawBoxes();
        const r = rects[0]?.r;
        if (r) centerOn(r);
      } else {
        for (const sh of [...sheetsA, ...sheetsB]) boxesFor(sh);
        const w = (c.ow[0] && c.ow[0].p === c.pA ? c.ow[0] : null) || c.nw[0];
        scrollSplitTo(c.kind === "add" ? c.pB : c.pA, w ? w.r[1] : 0);
      }
      ctx.status(it.tip.replace(/\n/g, "   "));
    } else {
      flashRect = { page: it.page, rects: [{ r: [it.z.x0, it.z.y0, it.z.x1, it.z.y1], color: COL[it.z.kind] || COL.prop }] };
      if (mode !== "overlay") setMode("overlay");
      if (page !== it.page) await goPage(it.page, true);
      drawBoxes();
      centerOn([it.z.x0, it.z.y0, it.z.x1, it.z.y1]);
    }
  }
  function centerOn(r) {
    ovScroll.scrollLeft = ((r[0] + r[2]) / 2) * zoom + sheet.offsetLeft - ovScroll.clientWidth / 2;
    ovScroll.scrollTop = ((r[1] + r[3]) / 2) * zoom + sheet.offsetTop - ovScroll.clientHeight / 2;
  }

  refreshSummary();
  refreshList();
  bOv.classList.add("on");
  stage.append(ovWrap);
  pgLbl.textContent = tr("pdfcmp.pagina_1_0", N);
  bPrev.disabled = true; bNext.disabled = N <= 1;

  // ---------------------------------------------------------------- report
  async function reportPdf() {
    await analysis;
    const doc = pdfDoc();
    const p = doc.addPage(842, 595);
    let y = reportHeader(p, info, tr("pdfcmp.confronto_documenti_pdf"));
    const nz = zonesByPage.reduce((s, z, p) => s + gZones(p).length, 0);
    const cnt = k => textChanges.filter(c => c.kind === k).length;
    p.text(24, y + 6, tr("pdfcmp.riepilogo"), 11, { bold: true });
    const lines = [`Pagine: vecchia ${nA}, nuova ${nB}`, tr("pdfcmp.differenze_testo_0_1_modificati", textChanges.length, cnt("mod"), cnt("add"), cnt("del")),
      tr("pdfcmp.zone_grafiche_cambiate_oltre_testo", nz, zonesByPage.filter((z, p) => gZones(p).length).length)];
    lines.forEach((l, i) => p.text(24, y + 22 + i * 13, l, 9.5));
    legend(p, 24, y + 70, [[COL.del, tr("pdfcmp.solo_vecchia_eliminato")], [COL.add, tr("pdfcmp.solo_nuova_aggiunto")], [COL.mod, tr("pdfcmp.l_modificato")], ["#8b8d98", tr("pdfcmp.l_uguale")]]);
    let pos = { page: p, y: y + 88 };
    if (textChanges.length) {
      p.text(24, pos.y + 4, tr("pdfcmp.differenze_testo"), 11, { bold: true });
      pos = reportTable(doc, info, tr("pdfcmp.confronto_documenti_pdf"), [{ t: tr("pdfcmp.tipo"), w: 70 }, { t: tr("pdfcmp.pag_vecchia"), w: 58 }, { t: tr("pdfcmp.pag_nuova"), w: 58 }, { t: tr("pdfcmp.testo_vecchia"), w: 304 }, { t: tr("pdfcmp.testo_nuova"), w: 304 }],
        textChanges.map(c => ({ color: COL[c.kind], cells: [{ mod: tr("pdfcmp.modificato"), add: tr("pdfcmp.aggiunto"), del: tr("pdfcmp.eliminato") }[c.kind], c.pA + 1, c.pB + 1, c.oldText, c.newText] })), pos.page, pos.y + 10);
    }
    const zr = [];
    zonesByPage.forEach((zs, i) => gZones(i).forEach(z => zr.push({ color: COL[z.kind], cells: [zoneTitle(z), i + 1, z.whole ? "-" : `${Math.round(z.x0 * MM)}; ${Math.round(z.y0 * MM)}`, z.whole ? "-" : `${Math.round((z.x1 - z.x0) * MM)} × ${Math.round((z.y1 - z.y0) * MM)}`] })));
    if (zr.length) {
      if (pos.y > 480) { pos = { page: null, y: null }; }
      else pos.page.text(24, pos.y + 22, tr("pdfcmp.zone_grafiche_cambiate"), 11, { bold: true });
      pos = reportTable(doc, info, tr("pdfcmp.confronto_documenti_pdf"), [{ t: tr("pdfcmp.tipo"), w: 160 }, { t: tr("pdfcmp.pagina"), w: 70 }, { t: tr("pdfcmp.posizione_x_y_mm_dall"), w: 260 }, { t: tr("pdfcmp.dimensioni_mm"), w: 304 }], zr, pos.page, pos.page ? pos.y + 28 : null);
    }
    // pagine con differenze: sovrapposizione a colori
    const pages = [];
    for (let i = 0; i < N; i++) if (zonesByPage[i].length || textChanges.some(c => c.pA === i || c.pB === i)) pages.push(i);
    for (const [k, i] of pages.entries()) {
      ctx.status(tr("pdfcmp.report_pagina", k + 1, pages.length));
      const s = sizeOf(i), scale = Math.min(150 / 72, Math.sqrt(9e6 / (s.w * s.h)));
      const [a, b] = await Promise.all([renderPage(dA, nA, i, scale), renderPage(dB, nB, i, scale)]);
      const al = aligns[i] || baseAlign(i);
      const r = composite(a, b, al, scale, { showOld: true, showNew: true, tol: opt.tol });
      const g = r.canvas.getContext("2d");
      g.lineWidth = Math.max(2, scale * 1.2);
      g.setLineDash([6 * scale, 4 * scale]);
      for (const z of zonesByPage[i]) { if (z.whole) continue; g.strokeStyle = COL[z.kind]; g.strokeRect(z.x0 * scale, z.y0 * scale, (z.x1 - z.x0) * scale, (z.y1 - z.y0) * scale); }
      const landscape = s.w > s.h;
      const pg = doc.addPage(landscape ? 842 : 595, landscape ? 595 : 842);
      const top = reportHeader(pg, info, tr("pdfcmp.sovrapposizione_pagina_0", i + 1));
      legend(pg, 24, top + 2, [[COL.del, tr("pdfcmp.solo_vecchia")], [COL.add, tr("pdfcmp.solo_nuova")], ["#8b8d98", tr("pdfcmp.l_uguale")]]);
      const al2 = al.dx || al.dy || al.k !== 1 ? tr("pdfcmp.allineamento_nuova_0_mm_1", (al.dx * MM).toFixed(1), (al.dy * MM).toFixed(1), (al.k * 100).toFixed(1)) : "";
      if (al2) pg.text(pg.w - 24 - 230, top + 3, al2, 7.5, { color: "#666666" });
      const availW = pg.w - 48, availH = pg.h - top - 40, f = Math.min(availW / r.canvas.width, availH / r.canvas.height);
      const dw = r.canvas.width * f, dh = r.canvas.height * f;
      pg.rect((pg.w - dw) / 2 - 0.5, top + 14 - 0.5, dw + 1, dh + 1, { stroke: "#bbbbbb" });
      pg.image(await canvasJpeg(r.canvas), r.canvas.width, r.canvas.height, (pg.w - dw) / 2, top + 14, dw, dh);
    }
    footerNumbers(doc);
    ctx.status("");
    return new Blob([doc.build(tr("pdfcmp.confronto") + info.oldName + " - " + info.newName)], { type: "application/pdf" });
  }
  const rowsText = () => textChanges.map(c => [c.n, { mod: tr("pdfcmp.modificato"), add: tr("pdfcmp.aggiunto"), del: tr("pdfcmp.eliminato") }[c.kind], c.pA + 1, c.pB + 1, c.oldText, c.newText]);
  const rowsZones = () => zonesByPage.flatMap((zs, i) => gZones(i).map(z => [zoneTitle(z), i + 1, z.whole ? "" : +(z.x0 * MM).toFixed(1), z.whole ? "" : +(z.y0 * MM).toFixed(1), z.whole ? "" : +((z.x1 - z.x0) * MM).toFixed(1), z.whole ? "" : +((z.y1 - z.y0) * MM).toFixed(1)]));
  async function reportXlsx() {
    await analysis;
    return saveXlsx(null, [
      { name: tr("pdfcmp.riepilogo"), filter: false, widths: [34, 70], rows: [[tr("pdfcmp.confronto_documenti_pdf"), ""], [tr("pdfcmp.vecchia"), info.oldName], [tr("pdfcmp.nuova"), info.newName], [tr("pdfcmp.data"), info.date], [tr("pdfcmp.pagine_vecchia"), nA], [tr("pdfcmp.pagine_nuova"), nB],
        [tr("pdfcmp.differenze_testo"), textChanges.length], [tr("pdfcmp.zone_grafiche_cambiate"), rowsZones().length]] },
      { name: tr("pdfcmp.testo"), widths: [6, 12, 12, 12, 70, 70], rows: [[tr("cmp.n"), tr("pdfcmp.tipo"), tr("pdfcmp.pagina_vecchia"), tr("pdfcmp.pagina_nuova"), tr("pdfcmp.testo_vecchia"), tr("pdfcmp.testo_nuova")], ...rowsText()] },
      { name: tr("pdfcmp.grafica"), widths: [22, 9, 12, 12, 14, 14], rows: [[tr("pdfcmp.tipo"), tr("pdfcmp.pagina"), "X (mm)", "Y (mm)", tr("pdfcmp.larghezza_mm"), tr("pdfcmp.altezza_mm")], ...rowsZones()] },
    ]);
  }
  async function reportCsv() {
    await analysis;
    return csvBlob([[tr("pdfcmp.categoria"), tr("pdfcmp.tipo"), tr("pdfcmp.pagina_vecchia"), tr("pdfcmp.pagina_nuova"), tr("pdfcmp.testo_vecchia"), tr("pdfcmp.testo_nuova"), "X (mm)", "Y (mm)", tr("pdfcmp.larghezza_mm"), tr("pdfcmp.altezza_mm")],
      ...rowsText().map(r => [tr("pdfcmp.testo"), r[1], r[2], r[3], r[4], r[5], "", "", "", ""]),
      ...rowsZones().map(r => [tr("pdfcmp.grafica"), r[0], r[1], r[1], "", "", r[2], r[3], r[4], r[5]])]);
  }

  return {
    onShow() { if (mode === "overlay") { if (!userZoom) fitZoom(); else schedule(); } else layoutSplit(); },
    onBack() { if (moveMode) { bMove.click(); return true; } return false; },
    reportPdf, reportXlsx, reportCsv,
    _pc: { textChanges, zonesByPage, aligns, analysis, get page() { return page; }, goPage, setMode, pick, list, realign, get comp() { return comp; } },
    dispose() { stopped = true; window.removeEventListener("keydown", onKey); io.disconnect(); try { dA.destroy(); dB.destroy(); } catch { /* */ } },
  };
}
