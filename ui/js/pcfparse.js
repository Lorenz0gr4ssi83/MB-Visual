// PCF (Piping Component File di ISOGEN / Alias): testo con intestazione (ISOGEN-FILES, UNITS-BORE, UNITS-CO-ORDS, PIPELINE-REFERENCE...)
// e un blocco per componente: parola chiave a inizio riga (PIPE, ELBOW, TEE, VALVE, FLANGE, REDUCER-CONCENTRIC, SUPPORT, WELD...) e
// righe rientrate con END-POINT x y z diametro, CENTRE-POINT x y z, BRANCH1-POINT x y z diametro, CO-ORDS x y z, SKEY, ITEM-CODE e
// altri attributi. Coordinate con Z in alto. Il diametro e' quello NOMINALE: l'esterno si ricava dalla tabella ASME B36.10.
// Puro, senza DOM (tests/test_pcf.mjs).

const num = s => { const v = Number(String(s).replace(",", ".")); return Number.isFinite(v) ? v : null; };
// diametro nominale in pollici -> diametro esterno in mm (ASME B36.10 / B36.19); da 14" in su l'esterno e' il nominale
const OD_IN = [[0.125, 10.3], [0.25, 13.7], [0.375, 17.1], [0.5, 21.3], [0.75, 26.7], [1, 33.4], [1.25, 42.2], [1.5, 48.3], [2, 60.3], [2.5, 73.0],
  [3, 88.9], [3.5, 101.6], [4, 114.3], [5, 141.3], [6, 168.3], [8, 219.1], [10, 273.1], [12, 323.9]];
// DN (mm) -> pollici nominali
const DN = { 6: 0.125, 8: 0.25, 10: 0.375, 15: 0.5, 20: 0.75, 25: 1, 32: 1.25, 40: 1.5, 50: 2, 65: 2.5, 80: 3, 90: 3.5, 100: 4, 125: 5, 150: 6, 200: 8,
  250: 10, 300: 12 };

export function outsideDiameter(bore, boreUnit) {
  if (!(bore > 0)) return null;
  const inch = /INCH/i.test(boreUnit) ? bore : DN[Math.round(bore)] ?? (bore >= 350 ? bore / 25 : bore / 25.4); // da DN350: DN = 25 x pollici
  const row = OD_IN.find(r => Math.abs(r[0] - inch) < 1e-6);
  return row ? row[1] : Math.round(inch * 254) / 10;
}

const POINT = { "END-POINT": "ends", "CENTRE-POINT": "centre", "CENTER-POINT": "centre", "BRANCH1-POINT": "branch", "BRANCH2-POINT": "branch2", "CO-ORDS": "at" };
const HEADER = /^(ISOGEN-FILES|UNITS-[A-Z-]+|PIPELINE-REFERENCE|PROJECT-IDENTIFIER|AREA|DATE-DMY|REVISION|PIPING-SPEC|MATERIALS|ITEM-CODE-STANDARD)$/;

export function isPcf(text) {
  const head = String(text).slice(0, 20000);
  return /^\s*(ISOGEN-FILES|PIPELINE-REFERENCE)\b/m.test(head) && /^\s+(END-POINT|CO-ORDS)\s/m.test(String(text));
}

export function parsePcf(text) {
  const units = {}, header = {}, comps = [];
  let cur = null, inMaterials = false;
  for (const raw of String(text).replace(/^﻿/, "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const indented = /^\s/.test(raw);
    const [key, ...rest] = raw.trim().split(/\s+/);
    const val = rest.join(" ");
    if (!indented) {
      if (key === "MATERIALS") inMaterials = true; // da qui in fondo: elenco dei materiali (ITEM-CODE + descrizioni), non componenti
      if (HEADER.test(key) || inMaterials) {
        cur = null;
        if (key.startsWith("UNITS-")) units[key] = val.toUpperCase(); else if (!inMaterials) header[key] = val;
        continue;
      }
      cur = { type: key.toUpperCase(), ends: [], centre: null, branch: null, branch2: null, at: null, attrs: {} };
      comps.push(cur);
      continue;
    }
    if (!cur) { if (!inMaterials && !header[key]) header[key] = val; continue; }
    const k = key.toUpperCase();
    if (POINT[k]) {
      const v = rest.map(num);
      const p = { p: [v[0], v[1], v[2]], bore: v[3] ?? null };
      if (p.p.some(x => x === null)) continue;
      if (POINT[k] === "ends") cur.ends.push(p); else cur[POINT[k]] = p;
    } else if (!(k in cur.attrs)) cur.attrs[k] = val;
  }
  const coK = /INCH/i.test(units["UNITS-CO-ORDS"] || "") ? 25.4 : /^M$|METRE|METER/i.test(units["UNITS-CO-ORDS"] || "") ? 1000 : 1;
  const boreUnit = units["UNITS-BORE"] || "MM";
  const mm = q => q && { ...q, p: q.p.map(v => v * coK), od: outsideDiameter(q.bore, boreUnit) };
  for (const c of comps) {
    c.ends = c.ends.map(mm); c.centre = mm(c.centre); c.branch = mm(c.branch); c.branch2 = mm(c.branch2); c.at = mm(c.at);
    // diametro del componente: dal primo punto che lo dice; i punti senza diametro prendono quello del componente
    const od = [...c.ends, c.branch, c.centre].find(q => q?.od)?.od ?? null;
    for (const q of [...c.ends, c.centre, c.branch, c.branch2]) if (q && !q.od) q.od = od;
    c.od = od;
  }
  // supporti e saldature senza diametro: quello del tubo piu' vicino
  const pipes = comps.filter(c => c.ends.length >= 1 && c.od);
  for (const c of comps) if (c.at && !c.od) {
    let best = null, bd = Infinity;
    for (const pc of pipes) for (const e of pc.ends) { const d = Math.hypot(...e.p.map((v, i) => v - c.at.p[i])); if (d < bd) { bd = d; best = pc; } }
    c.od = best?.od ?? null;
  }
  const kinds = {};
  for (const c of comps) kinds[c.type] = (kinds[c.type] || 0) + 1;
  return { header, units, comps, kinds, coK, boreUnit };
}
