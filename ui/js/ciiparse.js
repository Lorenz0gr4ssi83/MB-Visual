// Tubazioni .cii: lettura del testo a sezioni "#$ NOME" (VERS, UNIT, MATER, GEOM, BEND, VALV, REDU, SUPP, END). Puro, senza DOM
// (tests/test_cii.mjs). GEOM = da nodo, a nodo, DX, DY, DZ, diametro, spessore e, se ci sono, altre tre colonne (senza nome nel
// file; le ultime due si mostrano come temperatura e pressione). BEND = nodo, tipo. VALV = nodo, tipo, lunghezza, altro valore.
// REDU = da nodo, a nodo, diametro iniziale, finale. SUPP = nodo, tipo. Y verso l'alto, come nei programmi di calcolo.
// Il file non dice l'unita' delle lunghezze: con US sono piedi se il tratto medio sarebbe altrimenti piu' corto di 3 diametri.
const num = s => { const v = Number(String(s).replace(",", ".")); return Number.isFinite(v) ? v : null; };
const IMPERIAL = /^(US|ENG|ENGLISH|IMP|IMPERIAL)$/i;
const KNOWN = new Set(["VERS", "VERSION", "UNIT", "UNITS", "GEOM", "MATER", "MATERIAL", "SUPP", "SUPPORT", "BEND", "VALV", "VALVE", "REDU", "REDUCER", "END"]);
const unitVec = d => { const l = Math.hypot(...d); return l > 0 ? d.map(v => v / l) : null; };

export function parseCii(text) {
  const sec = {};
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^#\$\s*(\S+)/);
    if (m) { cur = m[1].toUpperCase(); sec[cur] ??= []; continue; }
    if (cur && line) sec[cur].push(line.split(/\s+/));
  }
  const elements = [];
  for (const r of sec.GEOM || []) {
    const v = r.map(num);
    if (r.length < 7 || v.slice(0, 7).some(x => x === null)) continue;
    const d = [v[2], v[3], v[4]];
    elements.push({ from: r[0], to: r[1], d, len: Math.hypot(...d), od: v[5], wt: v[6], od1: v[5], od2: v[5], extra: v[7] ?? null, temp: v[8] ?? null, press: v[9] ?? null });
  }
  const materials = (sec.MATER || sec.MATERIAL || []).filter(r => r.length >= 4 && r.every(x => num(x) !== null)).map(r => ({ id: r[0], e: r[1], nu: r[2], rho: r[3] }));
  const supports = (sec.SUPP || sec.SUPPORT || []).filter(r => r.length >= 2).map(r => ({ node: r[0], type: r[1].toUpperCase() }));
  const unit = (sec.UNIT || sec.UNITS || [])[0]?.[0] || "";
  const version = (sec.VERS || sec.VERSION || [])[0]?.[0] || "";

  // riduzioni: il tratto diventa un tronco di cono
  let orphanReducers = 0;
  for (const r of sec.REDU || sec.REDUCER || []) {
    const e = elements.find(x => x.from === r[0] && x.to === r[1]), a = num(r[2]), b = num(r[3]);
    if (e && a !== null && b !== null) { e.od1 = a; e.od2 = b; e.reducer = true; } else orphanReducers++;
  }

  // unita' -> millimetri
  let lengthUnit = "mm", lenK = 1, odK = 1;
  if (IMPERIAL.test(unit)) {
    const lens = elements.map(e => e.len).filter(l => l > 0).sort((a, b) => a - b);
    const med = lens[lens.length >> 1] || 0, od = Math.max(0, ...elements.map(e => e.od));
    lengthUnit = med < 3 * od ? "ft" : "in";
    lenK = lengthUnit === "ft" ? 304.8 : 25.4;
    odK = 25.4;
  }

  // posizione dei nodi: si parte dal primo e si sommano gli scostamenti; i pezzi non collegati partono anch'essi dall'origine
  const adj = new Map();
  const link = (a, b, d, sign) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push([b, d, sign]); };
  for (const e of elements) { link(e.from, e.to, e.d, 1); link(e.to, e.from, e.d, -1); }
  const nodes = new Map();
  let pieces = 0, mismatches = 0;
  for (const start of adj.keys()) {
    if (nodes.has(start)) continue;
    pieces++;
    nodes.set(start, [0, 0, 0]);
    const stack = [start];
    while (stack.length) {
      const a = stack.pop(), pa = nodes.get(a);
      for (const [b, d, s] of adj.get(a)) {
        const pb = [pa[0] + s * d[0], pa[1] + s * d[1], pa[2] + s * d[2]];
        if (!nodes.has(b)) { nodes.set(b, pb); stack.push(b); }
        else if (Math.hypot(pb[0] - nodes.get(b)[0], pb[1] - nodes.get(b)[1], pb[2] - nodes.get(b)[2]) > 1e-6) mismatches++;
      }
    }
  }

  // direzione della linea in un nodo e diametro che vi arriva
  const axisAt = n => { const e = elements.find(x => (x.from === n || x.to === n) && x.len > 0); return e ? unitVec(e.d) : [1, 0, 0]; };
  const odOf = n => Math.max(0, ...elements.flatMap(e => [e.from === n ? e.od1 : 0, e.to === n ? e.od2 : 0]));

  // curve: se la linea nel nodo non cambia direzione il file e' incoerente e lo si segnala
  const bends = (sec.BEND || []).filter(r => r.length >= 1).map(r => {
    const inn = elements.find(e => e.to === r[0] && e.len > 0), out = elements.find(e => e.from === r[0] && e.len > 0);
    let angle = null;
    if (inn && out) angle = Math.acos(Math.max(-1, Math.min(1, unitVec(inn.d).reduce((s, v, i) => s + v * unitVec(out.d)[i], 0)))) * 180 / Math.PI;
    return { node: r[0], type: (r[1] || "").toUpperCase(), angle, known: nodes.has(r[0]) };
  });

  // valvole: un nodo che manca in GEOM si colloca sul tratto che ha il numero compreso tra i suoi due nodi (25 tra 20 e 30)
  const valves = (sec.VALV || sec.VALVE || []).filter(r => r.length >= 1).map(r => {
    const v = { node: r[0], type: (r[1] || "").toUpperCase(), len: num(r[2]), other: r[3] ?? null, pos: nodes.get(r[0]) || null, axis: axisAt(r[0]), od: odOf(r[0]), deduced: false };
    if (!v.pos && num(r[0]) !== null) {
      const on = elements.filter(e => { const a = num(e.from), b = num(e.to), n = num(r[0]); return a !== null && b !== null && n > Math.min(a, b) && n < Math.max(a, b); });
      if (on.length === 1) {
        const e = on[0], k = (num(r[0]) - num(e.from)) / (num(e.to) - num(e.from)), p = nodes.get(e.from);
        v.pos = p.map((c, i) => c + k * e.d[i]); v.axis = unitVec(e.d) || v.axis; v.od = e.od1 + k * (e.od2 - e.od1); v.deduced = true;
      }
    }
    return v;
  });

  const ignored = Object.keys(sec).filter(s => !KNOWN.has(s));
  return { version, unit, elements, materials, supports, bends, valves, nodes, axisAt, odOf, lengthUnit, lenK, odK, pieces, mismatches: mismatches >> 1, orphanReducers, ignored };
}

// come va disegnato un vincolo: ancoraggio, guida, asse di appoggio (x, y, z) o altro
export function supportKind(type) {
  const t = String(type).toUpperCase().replace(/^[+-]/, "");
  if (/^(ANC|ANCH|ANCHOR|A)$/.test(t)) return { kind: "anchor" };
  if (/^(GUI|GUID|GUIDE)$/.test(t)) return { kind: "guide" };
  if (/^[XYZ]$/.test(t)) return { kind: "axis", axis: "XYZ".indexOf(t) };
  return { kind: "other" };
}
