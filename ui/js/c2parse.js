// CAESAR II .C2 (archivio di un lavoro). Struttura vista nei file, nessuna documentazione pubblica: una serie di voci, ognuna con
// 32 byte di intestazione (u32, u32 lunghezza compressa, tre FILETIME) e i dati in zlib; i dati di una voce iniziano con u32 =
// lunghezza della loro intestazione (264) e subito dopo il nome del file (LPS-05001_00B._A, .c2db, .NTXT...). La geometria si
// legge dal listato di verifica dell'ingresso (.NTXT) che CAESAR II scrive in chiaro: righe con un'etichetta di 4 lettere
// (ELMT, EL01..EL07, BEND, BN01, RIGD, RED, REST, RE01.., COOR, CO01, UN0n...) e campi a colonne fisse (il primo largo 15,
// gli altri 10). Valori nelle unita' del lavoro; un campo vuoto ripete quello dell'elemento precedente (diametro, spessore,
// temperatura, pressione), come in CAESAR II. Puro, senza DOM (tests/test_c2.mjs). Restituisce la stessa forma di parseCii.
import { placeNodes } from "./ciiparse.js";

// tipi di vincolo nell'ordine dell'elenco di CAESAR II (0 = ANC): dedotto dai file, coerente con la geometria (ancoraggi alle
// estremita', +Y con attrito sotto i tratti orizzontali, X/Z di traverso alla linea)
const REST_TYPES = ["ANC", "X", "Y", "Z", "RX", "RY", "RZ", "GUI", "LIM", "XSNB", "YSNB", "ZSNB", "XROD", "YROD", "ZROD",
  "+X", "-X", "+Y", "-Y", "+Z", "-Z"];
const unitVec = d => { const l = Math.hypot(...d); return l > 0 ? d.map(v => v / l) : null; };

async function inflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// voci dell'archivio: [{ name, data }]
export async function unpackC2(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const out = [];
  for (let pos = 0; pos + 32 <= u.length;) {
    const comp = dv.getUint32(pos + 4, true);
    if (!comp || pos + 32 + comp > u.length) break;
    const raw = await inflate(u.subarray(pos + 32, pos + 32 + comp));
    pos += 32 + comp;
    const head = raw.length >= 8 ? new DataView(raw.buffer).getUint32(0, true) : 0;
    if (head < 8 || head > raw.length) continue;
    let e = 4;
    while (e < head && raw[e]) e++;
    out.push({ name: new TextDecoder("latin1").decode(raw.subarray(4, e)), data: raw.subarray(head) });
  }
  if (!out.length) throw new Error("c2");
  return out;
}

const fields = line => {
  const r = line.slice(4), f = [r.slice(0, 15)];
  for (let i = 15; i < r.length; i += 10) f.push(r.slice(i, i + 10));
  return f.map(x => x.trim());
};
const num = s => { const v = s === "" || s == null ? NaN : Number(s); return Number.isFinite(v) ? v : null; };
const node = s => { const v = num(s); return v === null ? String(s) : String(+v.toFixed(3)); };

export function parseNtxt(text) {
  const lines = String(text).split(/\r?\n/);
  const elements = [], supports = [], bends = [], rigids = [], start = {}, seen = new Set();
  let cur = null, od = null, wt = null, temp = null, press = null, unitsText = "", version = "";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], tag = l.slice(0, 4).trim(), f = fields(l);
    if (!tag || tag === "*") continue;
    seen.add(tag);
    if (tag === "VERS") version = f[0];
    else if (/^UN0[3-6]$/.test(tag)) unitsText += " " + l.slice(4);
    else if (tag === "ELMT") {
      const d = [num(f[2]) ?? 0, num(f[3]) ?? 0, num(f[4]) ?? 0];
      od = num(f[5]) ?? od; wt = num(f[6]) ?? wt;
      cur = { from: node(f[0]), to: node(f[1]), d, len: Math.hypot(...d), od, wt, od1: od, od2: od, extra: null, temp, press };
      elements.push(cur);
    } else if (tag === "EL03" && cur) {
      // temperatura 1 e pressione 1 (riscontrate con la tabella Elements del database dei risultati dello stesso archivio)
      temp = num(f[0]) ?? temp; press = num(f[3]) ?? press;
      cur.temp = temp; cur.press = press;
    } else if (tag === "RED" && cur) {
      const b = num(f[0]);
      if (b !== null) { cur.od2 = b; cur.reducer = true; od = b; wt = num(f[1]) ?? wt; }
    } else if (tag === "BEND" && cur) bends.push({ node: cur.to, radius: num(f[0]), type: "", inner: [] });
    else if (/^BN\d\d$/.test(tag) && bends.length && bends.at(-1).node === cur?.to) {
      // nodi sulla curva: (nodo, angolo) a coppie; "MidPt" = meta' dell'angolo, numero = gradi dall'inizio della curva
      for (let k = 0; k + 1 < f.length; k += 2) if (num(f[k]) !== null) bends.at(-1).inner.push({ node: node(f[k]), at: /^M/i.test(f[k + 1]) ? "M" : num(f[k + 1]) ?? 0 });
    }
    else if (tag === "RIGD" && cur) { cur.rigid = true; cur.weight = num(f[0]); rigids.push(cur); }
    else if (tag === "REST" || tag === "RE02" || tag === "RE04") {
      const n = num(f[1]);
      if (num(f[0]) !== null && n !== null) supports.push({ node: node(f[0]), type: REST_TYPES[n] ?? `#${n}`, code: n, mu: num(f[4]) });
    } else if (/^CO\d\d$/.test(tag)) {
      const p = [num(f[1]), num(f[2]), num(f[3])];
      if (num(f[0]) !== null && p.every(v => v !== null)) start[node(f[0])] = p;
    }
  }

  // unita': dalle etichette di UN03..UN06 (es. "mm.", "in.", "C", "KPa", "bars", "lb./sq.in.")
  const imperial = /\bin\.|\bft\./i.test(unitsText) && !/\bmm\./i.test(unitsText);
  const pK = /KPa/i.test(unitsText) ? 0.01 : /MPa/i.test(unitsText) ? 10 : 1; // in bar (con le unita' metriche)
  if (!imperial && pK !== 1) for (const e of elements) if (e.press !== null) e.press *= pK;
  let net = placeNodes(elements, start);
  // nodi intermedi delle curve: sull'arco di raggio R tra i punti di tangenza (le coordinate dei nodi sono quelle del vertice,
  // come nei delta di CAESAR II). Un pezzo che parte da uno di questi nodi (derivazione sulla curva) si aggancia li'.
  const onArc = {};
  const arcPoints = () => {
    for (const b of bends) {
      const inn = elements.find(e => e.to === b.node && e.len > 0), out = elements.find(e => e.from === b.node && e.len > 0), C = net.nodes.get(b.node);
      if (!inn || !out || !C || !b.radius || !b.inner.length) continue;
      const u = unitVec(inn.d), v = unitVec(out.d), th = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2])));
      if (th < 1e-3) continue;
      const T = b.radius * Math.tan(th / 2), N = C.map((c, i) => c - u[i] * T);
      const w = unitVec(v.map((x, i) => x - u[i] * Math.cos(th))); // verso il centro, nel piano della curva
      for (const p of b.inner) {
        const a = p.at === "M" ? th / 2 : Math.min(th, (p.at || 0) * Math.PI / 180);
        onArc[p.node] = N.map((n, i) => n + b.radius * (Math.sin(a) * u[i] + (1 - Math.cos(a)) * w[i]));
      }
    }
  };
  arcPoints();
  const startB = { ...start };
  for (const b of bends) for (const p of b.inner) if (onArc[p.node] && net.nodes.has(p.node) && net.pieceOf.get(p.node) !== net.pieceOf.get(b.node)) startB[p.node] = onArc[p.node];
  if (Object.keys(startB).length > Object.keys(start).length) { net = placeNodes(elements, startB); arcPoints(); }
  const { nodes, axisAt, odOf, mismatches } = net;
  for (const [n, p] of Object.entries(onArc)) if (!nodes.has(n)) nodes.set(n, p); // vincoli e dati su nodi della curva
  const linked = new Set(Object.keys(startB).filter(n => !start[n]).map(n => net.pieceOf.get(n)));
  const pieces = net.pieces - linked.size;

  for (const b of bends) {
    const inn = elements.find(e => e.to === b.node && e.len > 0), out = elements.find(e => e.from === b.node && e.len > 0);
    b.angle = inn && out ? Math.acos(Math.max(-1, Math.min(1, unitVec(inn.d).reduce((s, v, i) => s + v * unitVec(out.d)[i], 0)))) * 180 / Math.PI : null;
    b.known = nodes.has(b.node);
  }
  const KNOWN = /^(VERS|UNIT|UN0\d|ELMT|EL0\d|RED|BEND|BN0\d|RIGD|REST|RE0\d|COOR|CO\d\d)$/;
  return {
    version, unit: imperial ? "US" : "SI", elements, materials: [], supports, bends, valves: [], rigids, nodes, axisAt, odOf,
    lengthUnit: imperial ? "in" : "mm", lenK: imperial ? 25.4 : 1, odK: imperial ? 25.4 : 1, pieces, mismatches, orphanReducers: 0,
    ignored: [], read: [...seen].filter(s => KNOWN.test(s)), caesar: true, // carichi, materiali, ammissibili: non nel 3D (c2_note)
  };
}

// listato di ingresso dentro l'archivio (null se CAESAR II non l'ha scritto)
export async function parseC2(bytes) {
  const ent = await unpackC2(bytes);
  const nt = ent.find(e => /\.ntxt$/i.test(e.name));
  return nt ? parseNtxt(new TextDecoder("latin1").decode(nt.data)) : null;
}
