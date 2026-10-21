import { LOCALE } from "./i18n.js";
// Pubblicazioni: motore del testo. Impaginazione di una storia in una catena di contenitori (caselle di testo
// collegate, ciascuna con le sue colonne), a capo automatico, allineamenti (anche giustificato), rientri, elenchi,
// spazi prima/dopo, interlinea, testo che gira attorno agli oggetti (quadrato / sopra e sotto), campi (numero di pagina,
// data, campi unione). Piu' le operazioni di modifica sulle storie (inserisci, cancella, stili di carattere/paragrafo).
//
// Le larghezze si misurano carattere per carattere con la crenatura disattivata: la stessa misura vale per il
// disegno sullo schermo, per il cursore e per l'esportazione PDF (PyMuPDF non applica la crenatura).
import { S, FIELD, fontName } from "./pubmodel.js";

const LS = "\u2028"; // a capo manuale (Maiusc+Invio)
const mctx = (() => { const c = document.createElement("canvas"); const g = c.getContext("2d"); try { g.fontKerning = "none"; } catch { /* */ } return g; })();
const WCACHE = new Map();

export function fontCss(doc, s, scale = 1) {
  return `${s.i ? "italic " : ""}${s.b ? "bold " : ""}${Math.max(0.5, (s.z || 10) * scale)}px "${fontName(doc, s.f)}"`;
}
function charW(css, ch) {
  const key = css + "\u0000" + ch;
  let w = WCACHE.get(key);
  if (w === undefined) {
    if (mctx.font !== css) mctx.font = css;
    w = mctx.measureText(ch).width;
    if (WCACHE.size > 60000) WCACHE.clear();
    WCACHE.set(key, w);
  }
  return w;
}
export function textWidth(doc, s, str, scale = 1) {
  const css = fontCss(doc, s, scale);
  let w = 0;
  for (const ch of str) w += charW(css, ch) + (s.k || 0) * scale;
  return w;
}

export function fieldText(f, env) {
  if (f === "page") return String((env.pageNo ?? 0) + 1);
  if (f === "pages") return String(env.pageCount || 1);
  if (f === "date") return new Date().toLocaleDateString(LOCALE);
  if (f && f.startsWith("merge:")) {
    const name = f.slice(6);
    if (env.record) return String(env.record[name] ?? "");
    return "«" + name + "»";
  }
  return "";
}

const isSpace = c => c === " " || c === " " && false;
const isBreak = c => c === "\n" || c === LS;

// ------------------------------------------------------------------ impaginazione
// containers: [{ id, cols: [{x,y,w,h}], valign, obstacles: [{x0,y0,x1,y1,mode}], env: {pageNo, pageCount, record} }]
export function layoutStory(doc, story, containers, opts = {}) {
  const scale = opts.scale || 1;
  const chars = story.chars;
  const n = chars.length;
  const lines = [];
  const out = { lines, overflow: false, end: n, byCont: containers.map(() => []) };
  if (!containers.length) { out.overflow = n > 1; out.end = 0; return out; }
  // larghezze dei caratteri (dipendono dalla pagina solo per i campi)
  const disp = new Array(n), adv = new Float64Array(n);
  const measure = (i, env) => {
    const ch = chars[i];
    let str = ch.c;
    if (ch.c === FIELD) str = fieldText(ch.f, env);
    else if (isBreak(ch.c)) str = "";
    else if (ch.c === "\t") str = "";
    disp[i] = str;
    const css = fontCss(doc, ch.s, scale);
    let w = 0;
    for (const c of str) w += charW(css, c) + (ch.s.k || 0) * scale;
    adv[i] = w;
  };

  let ci = 0, col = 0, y = 0, colStartLine = 0;
  let cont = containers[0], C = cont.cols[0];
  y = C.y;
  const slotsQ = [];
  let bandTop = y, bandH = 0;
  let numCounter = 0;

  const nextColumn = () => {
    finishColumn();
    col++;
    if (col >= cont.cols.length) {
      ci++; col = 0;
      if (ci >= containers.length) return false;
      cont = containers[ci];
    }
    C = cont.cols[col];
    y = C.y; bandTop = y; bandH = 0; slotsQ.length = 0; colStartLine = lines.length;
    return true;
  };
  function finishColumn() {
    if (!cont || !C) return;
    const ls = lines.slice(colStartLine);
    if (!ls.length || cont.valign === "t" || !cont.valign) return;
    const used = Math.max(...ls.map(l => l.top + l.h)) - C.y;
    const free = C.h - used;
    if (free <= 0) return;
    const dy = cont.valign === "m" ? free / 2 : free;
    for (const l of ls) { l.top += dy; l.base += dy; }
  }
  // spazi liberi di una fascia orizzontale (contorno attorno agli oggetti)
  function slotsFor(top, h, li, ri) {
    let segs = [[C.x, C.x + C.w]];
    let blockedUntil = -1;
    for (const ob of cont.obstacles || []) {
      if (ob.y1 <= top || ob.y0 >= top + h) continue;
      if (ob.x1 <= C.x || ob.x0 >= C.x + C.w) continue;
      if (ob.mode === "topbottom") { blockedUntil = Math.max(blockedUntil, ob.y1); segs = []; continue; }
      const nx = [];
      for (const [a, b] of segs) {
        if (ob.x1 <= a || ob.x0 >= b) { nx.push([a, b]); continue; }
        if (ob.x0 > a) nx.push([a, ob.x0]);
        if (ob.x1 < b) nx.push([ob.x1, b]);
      }
      segs = nx;
      if (!segs.length) blockedUntil = Math.max(blockedUntil, ob.y1);
    }
    segs = segs.map(([a, b]) => [a === C.x ? a + li : a, b === C.x + C.w ? b - ri : b]).filter(([a, b]) => b - a >= Math.min(24, C.w * 0.5));
    if (!segs.length && blockedUntil < 0) {
      // nessuno spazio abbastanza largo: si scende sotto l'ostacolo piu' basso che tocca la fascia
      for (const ob of cont.obstacles || []) if (!(ob.y1 <= top || ob.y0 >= top + h)) blockedUntil = Math.max(blockedUntil, ob.y1);
    }
    return { segs, blockedUntil };
  }

  let i = 0;
  outer:
  while (i < n) {
    // paragrafo [i, pe]
    let pe = i;
    while (pe < n && chars[pe].c !== "\n") pe++;
    if (pe >= n) pe = n - 1;
    const P = chars[pe].p || {};
    const lh = P.lh || 1;
    const li = (P.li || 0) + (P.bu ? 18 : 0), ri = P.ri || 0, fi = P.bu ? -18 : (P.fi || 0);
    let bullet = null;
    if (P.bu) {
      if (/\d/.test(P.bu)) { numCounter++; bullet = P.bu.replace(/\d+/, String(numCounter)); } else { numCounter = 0; bullet = P.bu; }
    } else numCounter = 0;
    for (let k = i; k <= pe; k++) measure(k, cont.env || {});
    const firstLine = { v: true };
    if (lines.length > colStartLine && !slotsQ.length) y += (P.sb || 0) * scale;
    let k = i;
    while (k <= pe) {
      // altezza della riga stimata dal primo carattere, poi ricalcolata
      const est = (chars[k].s.z || 10) * scale * 1.2 * lh;
      let slot;
      for (let guard = 0; guard < 200; guard++) {
        if (slotsQ.length) { slot = slotsQ.shift(); break; }
        if (y + est > C.y + C.h + 0.01 && lines.length > colStartLine) { if (!nextColumn()) { out.overflow = true; out.end = k; break outer; } continue; }
        const indL = firstLine.v && !P.bu ? li + fi : li;
        const { segs, blockedUntil } = slotsFor(y, est, Math.max(0, indL), ri);
        if (segs.length) { bandTop = y; bandH = 0; slotsQ.push(...segs); continue; }
        y = Math.max(y + 1, blockedUntil > y ? blockedUntil : y + est);
        if (y > C.y + C.h) { if (!nextColumn()) { out.overflow = true; out.end = k; break outer; } }
      }
      if (!slot) { out.overflow = true; out.end = k; break outer; }
      const x0 = slot[0], avail = slot[1] - slot[0];
      // riempimento della riga (a capo sulle parole)
      let x = 0, j = k, lastBreak = -1, widthAtBreak = 0, hard = false;
      const lineStart = k;
      while (j <= pe) {
        const c = chars[j].c;
        if (isBreak(c)) { j++; hard = true; break; }
        let w = adv[j];
        if (c === "\t") { const tab = 36 * scale; w = tab - ((x0 - C.x + x) % tab) || tab; adv[j] = w; }
        if (x + w > avail && j > lineStart && !isSpace(c)) {
          if (lastBreak >= 0) { j = lastBreak + 1; x = widthAtBreak; }
          break;
        }
        x += w;
        if (isSpace(c) || c === "-" || c === "\t") { lastBreak = j; widthAtBreak = x; }
        j++;
      }
      // spazi finali restano sulla riga (non contano per l'allineamento)
      if (!hard) {
        while (j <= pe && isSpace(chars[j].c)) j++;
        if (j <= pe && isBreak(chars[j].c)) j++; // il segno di paragrafo / a capo resta su questa riga
      }
      const end = Math.max(j, lineStart + 1);
      // altezza della riga
      let zmax = 0;
      for (let q = lineStart; q < end; q++) zmax = Math.max(zmax, chars[q].s.z || 10);
      const hNat = zmax * scale * 1.2;
      const h = hNat * lh;
      if (y + h > C.y + C.h + 0.01 && lines.length > colStartLine) {
        // non ci sta: colonna successiva (la riga si ricalcola li')
        slotsQ.length = 0;
        if (!nextColumn()) { out.overflow = true; out.end = lineStart; break outer; }
        continue;
      }
      // posizioni dei caratteri e allineamento
      const cnt = end - lineStart;
      const xs = new Float64Array(cnt + 1);
      let contentW = 0, acc = 0;
      for (let q = 0; q < cnt; q++) { xs[q] = acc; acc += adv[lineStart + q]; if (!isSpace(chars[lineStart + q].c) && !isBreak(chars[lineStart + q].c)) contentW = acc; }
      xs[cnt] = acc;
      const lastOfPara = end > pe || isBreak(chars[end - 1].c);
      const free = avail - contentW;
      let shift = 0;
      const al = P.a || "l";
      if (al === "c") shift = free / 2;
      else if (al === "r") shift = free;
      else if (al === "j" && !lastOfPara && free > 0) {
        let spaces = 0, lastNs = -1;
        for (let q = 0; q < cnt; q++) if (!isSpace(chars[lineStart + q].c) && !isBreak(chars[lineStart + q].c)) lastNs = q;
        for (let q = 0; q < lastNs; q++) if (isSpace(chars[lineStart + q].c)) spaces++;
        if (spaces) {
          const add = free / spaces;
          let extra = 0;
          for (let q = 0; q < cnt; q++) { xs[q] += extra; if (q < lastNs && isSpace(chars[lineStart + q].c)) extra += add; }
          xs[cnt] += extra;
        }
      }
      const top = slotsQ.length || bandH ? bandTop : y;
      const L = { cont: ci, col, x: x0 + shift, top, h, base: top + h - zmax * scale * 0.28, start: lineStart, end, xs, w: contentW, avail, slotX: x0,
        para: firstLine.v ? i : -1, bullet: firstLine.v && bullet ? { str: bullet, x: x0 - 18, s: chars[i].s } : null };
      lines.push(L);
      out.byCont[ci].push(L);
      firstLine.v = false;
      bandH = Math.max(bandH, h);
      if (!slotsQ.length) { y = bandTop + bandH; bandH = 0; }
      else bandTop = top;
      k = end;
    }
    if (!slotsQ.length) y += (P.sa || 0) * scale;
    else { slotsQ.length = 0; y = bandTop + bandH; bandH = 0; y += (P.sa || 0) * scale; }
    i = pe + 1;
  }
  finishColumn();
  // segmenti da disegnare: stesso stile, spezzati sugli spazi
  for (const L of lines) {
    const segs = [];
    let cur = null;
    for (let q = L.start; q < L.end; q++) {
      const ch = chars[q];
      const str = disp[q] ?? "";
      if (isSpace(ch.c) || isBreak(ch.c) || ch.c === "\t" || !str) { cur = null; if (ch.s.u && (isSpace(ch.c) || ch.c === "\t")) segs.push({ x: L.x + L.xs[q - L.start], w: L.xs[q - L.start + 1] - L.xs[q - L.start], str: "", s: ch.s, i: q, under: true }); continue; }
      if (cur && cur.s === ch.s && cur.field === !!ch.f) { cur.str += str; cur.w = L.x + L.xs[q - L.start + 1] - cur.x; }
      else { cur = { x: L.x + L.xs[q - L.start], w: L.xs[q - L.start + 1] - L.xs[q - L.start], str, s: ch.s, i: q, field: !!ch.f }; segs.push(cur); }
    }
    L.segs = segs;
  }
  return out;
}

// ------------------------------------------------------------------ cursore e selezione
export function lineOf(layout, off) {
  const ls = layout.lines;
  for (let k = 0; k < ls.length; k++) if (off >= ls[k].start && off < ls[k].end) return k;
  return -1;
}
export function caretPos(layout, off) {
  const k = lineOf(layout, off);
  if (k < 0) {
    const L = layout.lines[layout.lines.length - 1];
    if (!L) return null;
    return { line: layout.lines.length - 1, cont: L.cont, x: L.x + L.xs[L.xs.length - 1], top: L.top, h: L.h, hidden: true };
  }
  const L = layout.lines[k];
  return { line: k, cont: L.cont, x: L.x + L.xs[off - L.start], top: L.top, h: L.h };
}
// punto (coordinate locali del contenitore) -> posizione nel testo
export function hitText(layout, contIdx, x, y) {
  const ls = layout.lines.filter(l => l.cont === contIdx);
  if (!ls.length) {
    // contenitore vuoto (testo finito prima): fine del testo visibile
    return Math.max(0, Math.min(layout.end, (layout.lines[layout.lines.length - 1]?.end ?? 1)) - 1);
  }
  let best = ls[0], bd = Infinity;
  for (const l of ls) {
    const dy = y < l.top ? l.top - y : y > l.top + l.h ? y - l.top - l.h : 0;
    const dx = x < l.slotX ? l.slotX - x : x > l.slotX + l.avail ? x - l.slotX - l.avail : 0;
    const d = dy * 4 + dx;
    if (d < bd) { bd = d; best = l; }
  }
  return offInLine(best, x);
}
export function offInLine(L, x) {
  const cnt = L.end - L.start;
  let bk = 0, bd = Infinity;
  for (let q = 0; q < cnt; q++) {
    const d = Math.abs(L.x + L.xs[q] - x);
    if (d < bd) { bd = d; bk = q; }
  }
  // dopo l'ultimo carattere visibile della riga (riga spezzata senza spazio finale)
  const dEnd = Math.abs(L.x + L.xs[cnt] - x);
  if (dEnd < bd && cnt > 0) bk = cnt - 1;
  return L.start + bk;
}
export function selectionRects(layout, a, b) {
  const out = [];
  if (a === b) return out;
  for (const L of layout.lines) {
    const s = Math.max(a, L.start), e = Math.min(b, L.end);
    if (s >= e) continue;
    out.push({ cont: L.cont, x: L.x + L.xs[s - L.start], y: L.top, w: Math.max(3, L.xs[e - L.start] - L.xs[s - L.start]), h: L.h });
  }
  return out;
}

// ------------------------------------------------------------------ modifica delle storie
export function paraBounds(story, i) {
  const ch = story.chars;
  let a = i;
  while (a > 0 && ch[a - 1].c !== "\n") a--;
  let b = Math.min(i, ch.length - 1);
  while (b < ch.length - 1 && ch[b].c !== "\n") b++;
  return [a, b]; // b = indice del segno di paragrafo
}
export function wordBounds(story, i) {
  const ch = story.chars;
  const word = c => /[\p{L}\p{N}_'’]/u.test(c);
  let a = i, b = i;
  if (!ch[i] || !word(ch[i].c)) { if (i > 0 && ch[i - 1] && word(ch[i - 1].c)) { a = b = i - 1; } else return [i, Math.min(i + 1, ch.length - 1)]; }
  while (a > 0 && word(ch[a - 1].c)) a--;
  while (b < ch.length - 1 && word(ch[b].c)) b++;
  while (b < ch.length - 1 && ch[b].c === " ") b++;
  return [a, b];
}
// stile da usare per il testo digitato al cursore
export function styleAt(story, off) {
  const ch = story.chars;
  if (off > 0 && ch[off - 1] && !isBreak(ch[off - 1].c)) return ch[off - 1].s;
  return (ch[off] || ch[ch.length - 1]).s;
}
export function paraAt(story, off) {
  return story.chars[paraBounds(story, off)[1]].p || S({});
}
export function insertText(story, off, text, s, fieldName = null) {
  const add = [];
  if (fieldName) add.push({ c: FIELD, s, f: fieldName });
  else {
    const p = paraAt(story, off);
    for (const c of text.replace(/\r\n?/g, "\n")) {
      if (c === "\n") add.push({ c: "\n", s, p });
      else if (c === "\u000b") add.push({ c: LS, s });
      else if (c >= " " || c === "\t") add.push({ c, s });
    }
  }
  story.chars.splice(off, 0, ...add);
  return off + add.length;
}
export function insertChars(story, off, list) {
  const copy = list.map(ch => ({ ...ch }));
  // l'ultimo paragrafo incollato prende le proprieta' del paragrafo in cui si incolla
  story.chars.splice(off, 0, ...copy);
  return off + copy.length;
}
export function deleteRange(story, a, b) {
  const ch = story.chars;
  b = Math.min(b, ch.length - 1); // il segno di paragrafo finale non si cancella
  if (b <= a) return a;
  let hadPara = false;
  for (let k = a; k < b; k++) if (ch[k].c === "\n") { hadPara = true; break; }
  const pFirst = hadPara ? ch[paraBounds(story, a)[1]].p : null;
  ch.splice(a, b - a);
  if (pFirst) { const [, pe] = paraBounds(story, a); ch[pe] = { ...ch[pe], p: pFirst }; }
  return a;
}
export function sliceChars(story, a, b) {
  return story.chars.slice(a, b).map(ch => ({ ...ch }));
}
export function setCharStyle(story, a, b, patch) {
  for (let k = a; k < b; k++) story.chars[k] = { ...story.chars[k], s: S({ ...story.chars[k].s, ...patch }) };
}
export function mapCharStyle(story, a, b, fn) {
  for (let k = a; k < b; k++) story.chars[k] = { ...story.chars[k], s: S(fn(story.chars[k].s)) };
}
export function setParaStyle(story, a, b, patch) {
  let k = a;
  for (;;) {
    const [, pe] = paraBounds(story, k);
    story.chars[pe] = { ...story.chars[pe], p: S({ ...(story.chars[pe].p || {}), ...patch }) };
    if (pe >= b || pe >= story.chars.length - 1) break;
    k = pe + 1;
    if (k > b) break;
  }
}
export function paraStarts(story, a, b) {
  const out = [];
  let k = paraBounds(story, a)[0];
  for (;;) {
    out.push(k);
    const [, pe] = paraBounds(story, k);
    if (pe >= b || pe >= story.chars.length - 1) break;
    k = pe + 1;
  }
  return out;
}
export { LS };
