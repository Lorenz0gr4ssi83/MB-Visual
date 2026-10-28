// Modello dei piani di progetto (stile Microsoft Project) e calcolo della programmazione (metodo del percorso critico).
// Puro JavaScript (nessun DOM): lo usano l'editor, i lettori/scrittori (pio.js) e i collaudi in Node.
//
// progetto P = { name, title, author, company, manager, start (min), status (min|null), currency, mpd (minuti/giorno),
//   mpw (minuti/settimana), dpm (giorni/mese), cal (uid del calendario del progetto), calendars: [vedi pcal.js],
//   tasks: [T], resources: [R], assignments: [A], x: {estranei MSPDI}, src: formato di origine }
// attivita' T = { uid, name, lvl (livello di struttura >= 1), dur (minuti lavorativi; "e.." = minuti di calendario),
//   du (unita' mostrata: m h d w mo, em eh ed ew emo), est (stimata), ms (cardine esplicito), manual (programmata
//   manualmente: start/finish dati), start, finish, ct (vincolo: 0 ASAP 1 ALAP 2 MSO 3 MFO 4 SNET 5 SNLT 6 FNET 7 FNLT),
//   cd (data del vincolo), dl (scadenza), pct, notes, preds: [{ u, t (0 FF 1 FS 2 SF 3 SS), lag (minuti), lu (unita'),
//   pc (ritardo in % della durata del predecessore) }], cal (uid | null), bl: [{ start, finish, dur, work, cost } | null]
//   (linee di base 0-10), as / af (inizio/fine effettivi), fc (costo fisso), pri (priorita' 0-1000), act (attiva),
//   wbs (codice WBS scritto a mano, altrimenti calcolato), delay (ritardo di livellamento, minuti di calendario), color, x }
// risorsa R = { uid, name, type: "work" | "material" | "cost", ini, group, max (1 = 100%), rate (costo/ora o /unita'),
//   ovt, use (costo per uso), label (unita' del materiale), email, cal, x }
// assegnazione A = { uid, task, res, units (1 = 100%), w (lavoro in minuti o null = units x durata), cost (risorse costo), x }
import { DAY, WorkCal, dayOf, newCalendar, parseDate, fromParts, italianHolidays, toDay } from "./pcal.js";

export const CT = ["ASAP", "ALAP", "MSO", "MFO", "SNET", "SNLT", "FNET", "FNLT"];
export const LINK = ["FF", "FS", "SF", "SS"];
export const UNITS = ["m", "h", "d", "w", "mo"];

export function newProject(start = null) {
  const now = new Date();
  const s = start ?? fromParts(now.getFullYear(), now.getMonth() + 1, now.getDate(), 8, 0);
  const cal = newCalendar(1, "Standard");
  return { name: "", start: s, status: null, currency: "€", mpd: 480, mpw: 2400, dpm: 20, cal: 1, calendars: [cal], tasks: [], resources: [], assignments: [], x: {}, nextUid: 1 };
}
export function newTask(P, props = {}) {
  const uid = nextUid(P.tasks);
  return { uid, name: "", lvl: 1, dur: P.mpd, du: "d", est: false, ms: false, manual: false, ct: 0, cd: null, dl: null, pct: 0, notes: "", preds: [], cal: null, bl: [], act: true, pri: 500, fc: 0, delay: 0, ...props };
}
export const nextUid = list => list.reduce((m, x) => Math.max(m, x.uid || 0), 0) + 1;

// ------------------------------------------------------------------ durate
// unita' -> minuti per un progetto (giorni e settimane secondo le impostazioni del calendario)
export function unitMinutes(P, u) {
  const b = u.replace(/^e/, "");
  const el = u[0] === "e" && u !== "e";
  if (el) return { m: 1, h: 60, d: DAY, w: DAY * 7, mo: DAY * 30 }[b] || 1;
  return { m: 1, h: 60, d: P.mpd || 480, w: P.mpw || 2400, mo: (P.mpd || 480) * (P.dpm || 20) }[b] || 1;
}
export const isElapsed = u => typeof u === "string" && u[0] === "e" && u.length > 1;
// testo -> { dur, du, est } ; unita' accettate: inglese (m h d w mo), italiano (min o g s me) e quelle tradotte (aliases)
export function parseDuration(P, s, aliases = {}, defUnit = "d") {
  if (s == null) return null;
  let str = String(s).trim().toLowerCase().replace(",", ".");
  if (!str) return null;
  const est = str.endsWith("?");
  if (est) str = str.slice(0, -1).trim();
  const m = str.match(/^(-?\d+(?:\.\d+)?)\s*([a-zà-ú]*)\.?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const raw = m[2] || "";
  const map = { m: "m", min: "m", mins: "m", minute: "m", minuti: "m", minuto: "m", h: "h", hr: "h", hrs: "h", o: "h", ore: "h", ora: "h", hour: "h", hours: "h",
    d: "d", g: "d", gg: "d", giorni: "d", giorno: "d", day: "d", days: "d", w: "w", wk: "w", s: "w", sett: "w", settimane: "w", settimana: "w", week: "w", weeks: "w",
    mo: "mo", me: "mo", mes: "mo", mese: "mo", mesi: "mo", month: "mo", months: "mo", ...aliases };
  let u;
  if (!raw) u = defUnit;
  else if (map[raw]) u = map[raw];
  else if (raw[0] === "e" && map[raw.slice(1)]) u = "e" + map[raw.slice(1)];
  else return null;
  return { dur: Math.max(0, Math.round(n * unitMinutes(P, u))), du: u, est };
}
export function fmtDuration(P, dur, du = "d", labels = null, est = false) {
  const n = (dur || 0) / unitMinutes(P, du);
  const v = Math.round(n * 100) / 100;
  const lab = labels ? labels[du] ?? du : du;
  return `${String(v).replace(".", labels?.dec || ".")} ${lab}${est ? "?" : ""}`;
}

// ------------------------------------------------------------------ struttura (livelli -> padri/figli, WBS)
export function outline(P) {
  const T = P.tasks;
  const stack = [];
  T.forEach((t, i) => {
    t.id = i + 1;
    t.lvl = Math.max(1, Math.min(t.lvl || 1, stack.length + 1));
    while (stack.length >= t.lvl) stack.pop();
    t.parent = stack.length ? stack[stack.length - 1] : null;
    t.kids = [];
    if (t.parent) t.parent.kids.push(t);
    stack.push(t);
  });
  // codici WBS 1, 1.1, 1.2...
  const cnt = [];
  for (const t of T) {
    cnt.length = t.lvl;
    cnt[t.lvl - 1] = (cnt[t.lvl - 1] || 0) + 1;
    for (let i = 0; i < t.lvl - 1; i++) if (!cnt[i]) cnt[i] = 1;
    t.on = cnt.slice(0, t.lvl).join(".");
    t.sum = t.kids.length > 0;
  }
  return T;
}
export const isMilestone = t => !t.sum && (t.ms || (t.dur === 0 && !t.manual) || (t.manual && t.start != null && t.start === t.finish && t.dur === 0));
export const leaves = t => t.sum ? t.kids.flatMap(leaves) : [t];
export const ancestors = t => { const a = []; for (let p = t.parent; p; p = p.parent) a.push(p); return a; };
export const isAncestor = (a, t) => { for (let p = t.parent; p; p = p.parent) if (p === a) return true; return false; };

// ------------------------------------------------------------------ calcolo della programmazione (CPM)
export function calendarsOf(P) {
  const byUid = new Map(P.calendars.map(c => [c.uid, c]));
  const cache = new Map();
  const get = uid => {
    const c = byUid.get(uid) || byUid.get(P.cal) || P.calendars[0] || newCalendar(0, "Standard");
    if (!cache.has(c.uid)) cache.set(c.uid, new WorkCal(c, byUid));
    return cache.get(c.uid);
  };
  return { get, project: get(P.cal) };
}

// risultato sulle attivita': es ef ls lf (minuti), ts / fs (margine totale e libero, minuti lavorativi), crit, start/finish
export function schedule(P) {
  outline(P);
  const T = P.tasks;
  const C = calendarsOf(P);
  const calOf = t => C.get(t.cal ?? P.cal);
  const byUid = new Map(T.map(t => [t.uid, t]));
  const projStart = P.start ?? T.reduce((m, t) => Math.min(m, t.start ?? Infinity), Infinity);
  const warnings = [];
  const active = t => t.act !== false && !ancestors(t).some(a => a.act === false);

  // collegamenti portati tra attivita' foglia (quelli di/verso un riepilogo valgono per tutte le sue foglie)
  const inc = new Map(), out = new Map();
  for (const t of T) { inc.set(t, []); out.set(t, []); }
  for (const s of T) {
    for (const L of s.preds || []) {
      const p = byUid.get(L.u);
      if (!p || p === s || !active(p) || !active(s) || isAncestor(p, s) || isAncestor(s, p)) continue;
      const g = { p, s, t: L.t ?? 1, lag: L.lag || 0, lu: L.lu || "d", pc: L.pc, pl: leaves(p).filter(active), sl: leaves(s).filter(active) };
      if (!g.pl.length || !g.sl.length) continue;
      for (const x of g.sl) inc.get(x).push(g);
      for (const x of g.pl) if (!out.get(x).includes(g)) out.get(x).push(g);
    }
  }
  // ordine topologico delle foglie (i cicli si spezzano e si segnalano)
  const leafs = T.filter(t => !t.sum && active(t));
  const order = [], mark = new Map();
  const visit = (x, path) => {
    const m = mark.get(x);
    if (m === 2) return;
    if (m === 1) { warnings.push({ k: "ciclo", uid: x.uid }); return; }
    mark.set(x, 1);
    for (const g of inc.get(x)) for (const p of g.pl) visit(p, path);
    mark.set(x, 2);
    order.push(x);
  };
  for (const x of leafs) visit(x);

  const lagAdd = (cal, t0, g) => {
    let lag = g.pc != null ? Math.round((g.pc / 100) * leafDur(g.p)) : g.lag;
    if (isElapsed(g.lu)) return t0 + lag;
    return lag >= 0 ? cal.add(t0, lag) : cal.sub(t0, -lag);
  };
  const lagSub = (cal, t0, g) => {
    let lag = g.pc != null ? Math.round((g.pc / 100) * leafDur(g.p)) : g.lag;
    if (isElapsed(g.lu)) return t0 - lag;
    return lag >= 0 ? cal.sub(t0, lag) : cal.add(t0, -lag);
  };
  const leafDur = t => t.dur || 0;
  const finishOf = (t, cal, es) => isElapsed(t.du) ? es + t.dur : cal.add(es, t.dur);
  const startOf = (t, cal, ef) => isElapsed(t.du) ? ef - t.dur : cal.sub(ef, t.dur);
  const snapStart = (t, cal, v) => (t.dur > 0 && !isElapsed(t.du) ? cal.nextWork(v) : v);

  // ---- passata in avanti
  for (const t of order) {
    const cal = calOf(t);
    if (t.manual && t.start != null) {
      t.es = t.start;
      t.ef = t.finish ?? finishOf(t, cal, t.start);
      continue;
    }
    let es = projStart, efMin = -Infinity;
    for (const g of inc.get(t)) {
      const pe = Math.max(...g.pl.map(p => p.ef)), ps = Math.min(...g.pl.map(p => p.es));
      if (g.t === 1) es = Math.max(es, lagAdd(cal, pe, g));
      else if (g.t === 3) es = Math.max(es, lagAdd(cal, ps, g));
      else if (g.t === 0) efMin = Math.max(efMin, lagAdd(cal, pe, g));
      else if (g.t === 2) efMin = Math.max(efMin, lagAdd(cal, ps, g));
    }
    for (const a of ancestors(t)) if (a.ct === 4 && a.cd != null) es = Math.max(es, a.cd); // SNET del riepilogo
    if (t.ct === 4 && t.cd != null) es = Math.max(es, t.cd);
    es = snapStart(t, cal, es);
    if (efMin > -Infinity) es = Math.max(es, snapStart(t, cal, startOf(t, cal, efMin)));
    if (t.ct === 6 && t.cd != null && finishOf(t, cal, es) < t.cd) es = snapStart(t, cal, startOf(t, cal, t.cd));
    if (t.ct === 2 && t.cd != null) es = t.cd;
    if (t.ct === 3 && t.cd != null) es = startOf(t, cal, t.cd);
    if (t.delay) es = snapStart(t, cal, es + t.delay);
    if (t.as != null) es = t.as;
    let ef = finishOf(t, cal, es);
    if (efMin > ef && !isElapsed(t.du) && cal.between(ef, efMin) === 0) ef = efMin; // fine dal collegamento (come Project: le 8:00 del giorno dopo)
    if (t.af != null && t.pct >= 100) ef = Math.max(t.af, es);
    t.es = es; t.ef = ef;
  }
  const projFinish = leafs.reduce((m, t) => Math.max(m, t.ef ?? -Infinity), projStart);

  // ---- passata all'indietro
  for (let i = order.length - 1; i >= 0; i--) {
    const t = order[i];
    const cal = calOf(t);
    let lf = projFinish, lsMax = Infinity;
    for (const g of out.get(t)) {
      const sl = Math.min(...g.sl.map(s => s.ls)), sf = Math.min(...g.sl.map(s => s.lf));
      const sc = calOf(g.sl[0]);
      if (g.t === 1) lf = Math.min(lf, cal.prevWork(lagSub(sc, sl, g)));
      else if (g.t === 0) lf = Math.min(lf, lagSub(sc, sf, g));
      else if (g.t === 3) lsMax = Math.min(lsMax, lagSub(sc, sl, g));
      else if (g.t === 2) lsMax = Math.min(lsMax, lagSub(sc, sf, g));
    }
    if (lsMax < Infinity) lf = Math.min(lf, finishOf(t, cal, lsMax));
    const cons = [t, ...ancestors(t)];
    for (const c of cons) {
      if ((c.ct === 7 || c.ct === 3) && c.cd != null) lf = Math.min(lf, c.cd);
      if (c.dl != null) lf = Math.min(lf, c.dl);
    }
    if ((t.ct === 5 || t.ct === 2) && t.cd != null) lf = Math.min(lf, finishOf(t, cal, t.cd));
    t.lf = lf;
    t.ls = startOf(t, cal, lf);
    if (t.dur === 0) t.ls = t.lf;
    t.ts = cal.between(t.es, t.ls);
    // margine libero: rispetto alle date al piu' presto dei successori
    let ff = cal.between(t.ef, projFinish);
    for (const g of out.get(t)) {
      const s = g.sl.reduce((a, b) => (a.es <= b.es ? a : b));
      const sc = calOf(s);
      let lim;
      if (g.t === 1) lim = lagSub(sc, s.es, g);
      else if (g.t === 0) lim = lagSub(sc, s.ef, g);
      else if (g.t === 3) lim = finishOf(t, cal, lagSub(sc, s.es, g));
      else lim = finishOf(t, cal, lagSub(sc, s.ef, g));
      ff = Math.min(ff, cal.between(t.ef, lim));
    }
    t.fs = Math.max(0, ff);
    // "il piu' tardi possibile": si sposta del margine libero
    if (t.ct === 1 && !t.manual && t.as == null && t.fs > 0) {
      t.ef = cal.prevWork(cal.add(t.ef, t.fs));
      t.es = startOf(t, cal, t.ef);
      t.fs = 0;
      t.ts = cal.between(t.es, t.ls);
    }
  }
  // ---- riepiloghi (dal basso)
  for (let i = T.length - 1; i >= 0; i--) {
    const t = T[i];
    if (!t.sum) continue;
    const k = t.kids.filter(active);
    if (!k.length) { t.es = t.ef = t.ls = t.lf = projStart; t.ts = 0; continue; }
    t.es = Math.min(...k.map(x => x.es)); t.ef = Math.max(...k.map(x => x.ef));
    t.ls = Math.min(...k.map(x => x.ls)); t.lf = Math.max(...k.map(x => x.lf));
    t.ts = Math.min(...k.map(x => x.ts)); t.fs = Math.min(...k.map(x => x.fs ?? 0));
    t.dur = C.get(t.cal ?? P.cal).between(t.es, t.ef);
    if (!t.du || isElapsed(t.du)) t.du = "d";
    const tot = k.reduce((n, x) => n + Math.max(x.dur, 1), 0);
    t.pct = Math.round(k.reduce((n, x) => n + (x.pct || 0) * Math.max(x.dur, 1), 0) / tot);
  }
  for (const t of T) {
    if (!active(t)) { t.es ??= t.start ?? projStart; t.ef ??= t.finish ?? t.es; t.ts = 0; t.crit = false; t.start = t.es; t.finish = t.ef; continue; }
    t.start = t.es; t.finish = t.ef;
    t.crit = !(t.pct >= 100) && t.ts <= 0;
    t.late = t.dl != null && t.ef > t.dl;
  }
  for (const t of T) if (t.sum) t.crit = t.kids.some(k => k.crit);
  P.finish = T.length ? Math.max(...T.map(t => t.ef ?? projStart)) : projStart;
  P.warnings = warnings;
  costs(P);
  return P;
}

// ------------------------------------------------------------------ lavoro e costi
export function assignmentWork(P, a, t = null) {
  if (a.w != null) return a.w;
  t ??= P.tasks.find(x => x.uid === a.task);
  return Math.round((a.units ?? 1) * (t?.dur || 0));
}
export function assignmentCost(P, a, r = null, t = null) {
  r ??= P.resources.find(x => x.uid === a.res);
  if (!r) return 0;
  if (r.type === "cost") return a.cost || 0;
  if (r.type === "material") return (a.units ?? 1) * (r.rate || 0) + (r.use || 0);
  return (assignmentWork(P, a, t) / 60) * (r.rate || 0) + (r.use || 0);
}
export function costs(P) {
  const tasks = new Map(P.tasks.map(t => [t.uid, t]));
  const res = new Map(P.resources.map(r => [r.uid, r]));
  for (const t of P.tasks) { t.work = 0; t.cost = t.sum ? 0 : t.fc || 0; t.resNames = []; }
  for (const r of P.resources) { r.work = 0; r.cost = 0; }
  for (const a of P.assignments) {
    const t = tasks.get(a.task), r = res.get(a.res);
    if (!t || !r) continue;
    const w = r.type === "work" ? assignmentWork(P, a, t) : 0;
    const c = assignmentCost(P, a, r, t);
    t.work += w; t.cost += c; r.work += w; r.cost += c;
    t.resNames.push(r.name + (r.type === "work" && Math.abs((a.units ?? 1) - 1) > 1e-6 ? `[${Math.round((a.units ?? 1) * 100)}%]` : r.type === "material" ? `[${a.units ?? 1}${r.label ? " " + r.label : ""}]` : ""));
  }
  for (let i = P.tasks.length - 1; i >= 0; i--) {
    const t = P.tasks[i];
    if (t.sum) { t.work += t.kids.reduce((n, k) => n + k.work, 0); t.cost += (t.fc || 0) + t.kids.reduce((n, k) => n + k.cost, 0); }
  }
}

// ------------------------------------------------------------------ uso delle risorse e sovrallocazioni
// lavoro per giorno: Map(uid risorsa -> Map(giorno -> minuti)) + disponibilita' giornaliera
export function resourceUsage(P) {
  const C = calendarsOf(P);
  const tasks = new Map(P.tasks.map(t => [t.uid, t]));
  const use = new Map(), perTask = new Map();
  for (const a of P.assignments) {
    const t = tasks.get(a.task), r = P.resources.find(x => x.uid === a.res);
    if (!t || !r || t.sum || t.act === false || r.type !== "work") continue;
    const cal = C.get(t.cal ?? r.cal ?? P.cal);
    const span = cal.between(t.es, t.ef);
    const total = assignmentWork(P, a, t);
    const m = use.get(r.uid) || new Map();
    use.set(r.uid, m);
    const pm = new Map();
    for (let d = dayOf(t.es); d <= dayOf(t.ef) && d - dayOf(t.es) < 3700; d++) {
      const w = span > 0 ? cal.between(Math.max(t.es, d * DAY), Math.min(t.ef, (d + 1) * DAY)) * total / span : (d === dayOf(t.es) ? total : 0);
      if (w > 0) { m.set(d, (m.get(d) || 0) + w); pm.set(d, w); }
    }
    perTask.set(a, pm);
  }
  const avail = (r, d) => C.get(r.cal ?? P.cal).dayMinutes(d) * (r.max ?? 1);
  const over = new Map();
  for (const r of P.resources) {
    const m = use.get(r.uid);
    if (!m) continue;
    const days = [...m].filter(([d, w]) => w > avail(r, d) + 0.5).map(([d]) => d);
    if (days.length) over.set(r.uid, days);
  }
  return { use, perTask, avail, over };
}

// livellamento delle risorse: le attivita' in conflitto si spostano in avanti (ritardo di livellamento) in ordine di
// inizio, priorita' e margine, finche' nessuna risorsa supera la sua disponibilita' giornaliera
export function level(P, { onlyWithinSlack = false } = {}) {
  for (const t of P.tasks) t.delay = 0;
  schedule(P);
  const C = calendarsOf(P);
  const res = new Map(P.resources.map(r => [r.uid, r]));
  const byTask = new Map();
  for (const a of P.assignments) { const r = res.get(a.res); if (r?.type === "work") (byTask.get(a.task) || byTask.set(a.task, []).get(a.task)).push(a); }
  const booked = new Map();
  const avail = (r, d) => C.get(r.cal ?? P.cal).dayMinutes(d) * (r.max ?? 1);
  let moved = 0;
  const pending = P.tasks.filter(t => !t.sum && t.act !== false && byTask.has(t.uid) && !t.manual && t.as == null);
  const done = new Set();
  for (let guard = 0; pending.length && guard < 5000; guard++) {
    pending.sort((a, b) => a.es - b.es || (b.pri ?? 500) - (a.pri ?? 500) || a.ts - b.ts || a.id - b.id);
    const t = pending.shift();
    const cal = C.get(t.cal ?? P.cal);
    const as = byTask.get(t.uid);
    const daily = es => { // lavoro per risorsa e giorno se inizia in es
      const ef = cal.add(es, t.dur), span = cal.between(es, ef), out = [];
      for (let d = dayOf(es); d <= dayOf(ef); d++) {
        const f = span > 0 ? cal.between(Math.max(es, d * DAY), Math.min(ef, (d + 1) * DAY)) / span : 1;
        for (const a of as) { const w = f * (a.w ?? (a.units ?? 1) * t.dur); if (w > 0) out.push([a.res, d, w]); }
      }
      return out;
    };
    let es = t.es, tries = 0;
    const fits = list => list.every(([u, d, w]) => { const r = res.get(u); return (booked.get(u)?.get(d) || 0) + w <= Math.max(avail(r, d), w) + 0.5; });
    let list = daily(es);
    while (!fits(list) && tries < 2000) { es = cal.nextWork((dayOf(es) + 1) * DAY); list = daily(es); tries++; }
    if (onlyWithinSlack && cal.between(t.es, es) > t.ts) { es = t.es; list = daily(es); }
    for (const [u, d, w] of list) { const m = booked.get(u) || booked.set(u, new Map()).get(u); m.set(d, (m.get(d) || 0) + w); }
    if (es > t.es) {
      t.delay = es - t.es + (t.delay || 0);
      moved++;
      schedule(P); // i successori si spostano
    }
    done.add(t);
  }
  schedule(P);
  return moved;
}

// ------------------------------------------------------------------ linea di base e festivi
export function setBaseline(P, n = 0, onlyUids = null) {
  for (const t of P.tasks) {
    if (onlyUids && !onlyUids.has(t.uid)) continue;
    t.bl ||= [];
    t.bl[n] = { start: t.start, finish: t.finish, dur: t.dur, work: t.work || 0, cost: t.cost || 0 };
  }
  P.blDate ||= [];
  P.blDate[n] = Date.now();
}
export function addItalianHolidays(P, calUid, fromYear, toYear, names = {}) {
  const c = P.calendars.find(x => x.uid === calUid);
  if (!c) return 0;
  let n = 0;
  for (let y = fromYear; y <= toYear; y++) for (const [d, k] of italianHolidays(y)) {
    if (c.exc.some(x => d >= x.from && d <= x.to)) continue;
    c.exc.push({ from: d, to: d, name: names[k] || k, work: [] });
    n++;
  }
  c.exc.sort((a, b) => a.from - b.from);
  return n;
}

// ------------------------------------------------------------------ confronto tra due versioni del piano
// abbinamento per UID, poi per nome; differenze di date, durata, avanzamento, collegamenti
export function compare(A, B) {
  schedule(A); schedule(B);
  const key = t => (t.name || "").trim().toLowerCase();
  const usedB = new Set(), rows = [];
  const bUid = new Map(B.tasks.map(t => [t.uid, t])), bName = new Map();
  for (const t of B.tasks) if (!bName.has(key(t))) bName.set(key(t), t);
  for (const a of A.tasks) {
    let b = bUid.get(a.uid);
    if (b && key(b) !== key(a) && bName.get(key(a)) && !usedB.has(bName.get(key(a)))) b = bName.get(key(a));
    if (!b || usedB.has(b)) b = bName.get(key(a));
    if (b && usedB.has(b)) b = null;
    if (!b) { rows.push({ kind: "del", a }); continue; }
    usedB.add(b);
    const ch = [];
    if (key(a) !== key(b)) ch.push("name");
    if (a.start !== b.start) ch.push("start");
    if (a.finish !== b.finish) ch.push("finish");
    if (a.dur !== b.dur) ch.push("dur");
    if ((a.pct || 0) !== (b.pct || 0)) ch.push("pct");
    const pk = (P, t) => (t.preds || []).map(p => `${P.tasks.find(x => x.uid === p.u)?.name}|${p.t}|${p.lag}`).sort().join(";");
    if (pk(A, a) !== pk(B, b)) ch.push("preds");
    rows.push({ kind: ch.length ? "mod" : "same", a, b, ch, dStart: (b.start ?? 0) - (a.start ?? 0), dFinish: (b.finish ?? 0) - (a.finish ?? 0) });
  }
  for (const b of B.tasks) if (!usedB.has(b)) rows.push({ kind: "add", b });
  return { rows, dFinish: (B.finish ?? 0) - (A.finish ?? 0) };
}

// ------------------------------------------------------------------ predecessori come testo ("3FS+2g;5SS")
export function predsText(P, t, labels = null) {
  const byUid = new Map(P.tasks.map(x => [x.uid, x]));
  return (t.preds || []).map(L => {
    const p = byUid.get(L.u);
    if (!p) return null;
    let s = String(p.id);
    const lag = L.pc != null ? `${L.pc}%` : L.lag ? fmtDuration(P, Math.abs(L.lag), L.lu || "d", labels).replace(" ", "") : "";
    const typ = labels?.link ? labels.link[L.t ?? 1] : LINK[L.t ?? 1];
    if (L.t !== 1 || lag) s += typ;
    if (lag) s += (L.lag < 0 ? "-" : "+") + lag;
    return s;
  }).filter(Boolean).join(";");
}
export function parsePreds(P, text, labels = null, aliases = {}) {
  const out = [];
  const typ = labels?.link ? labels.link.map(x => x.toUpperCase()) : LINK;
  for (const part of String(text || "").split(/[;,]/).map(s => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*([A-Za-z]{2})?\s*(?:([+-])\s*(.+))?$/);
    if (!m) throw new Error(part);
    const t = P.tasks[+m[1] - 1];
    if (!t) throw new Error(part);
    let ty = 1;
    if (m[2]) { const u = m[2].toUpperCase(); ty = typ.indexOf(u); if (ty < 0) ty = LINK.indexOf(u); if (ty < 0) throw new Error(part); }
    const L = { u: t.uid, t: ty, lag: 0, lu: "d" };
    if (m[3]) {
      const sign = m[3] === "-" ? -1 : 1;
      if (/%$/.test(m[4])) L.pc = sign * parseFloat(m[4]);
      else { const d = parseDuration(P, m[4], aliases); if (!d) throw new Error(part); L.lag = sign * d.dur; L.lu = d.du; }
    }
    out.push(L);
  }
  return out;
}

// copia profonda senza i campi calcolati (per annulla/ripeti)
const CALC = new Set(["parent", "kids", "id", "on", "sum", "es", "ef", "ls", "lf", "ts", "fs", "crit", "late", "work", "cost", "resNames"]);
export function snapshot(P) {
  // solo i campi calcolati di attivita' (lvl) e risorse (max): "work" esiste anche nei calendari e nelle linee di base
  return JSON.stringify(P, function (k, v) { return CALC.has(k) && this && ("lvl" in this || "max" in this) ? undefined : v; });
}
export function restore(s) { return JSON.parse(s); }
export { parseDate, toDay };
