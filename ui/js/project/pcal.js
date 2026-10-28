// Calendari lavorativi dei piani di progetto. Il tempo e' in MINUTI dall'1/1/1970 come ora "da orologio" (si calcola
// con le funzioni UTC: niente ora legale ne' fusi, come Project che ragiona in date locali).
//   calendario = { uid, name, base: uid del calendario di base | null,
//                  week: [7 voci, 0 = domenica: null = come il calendario di base, [] = non lavorativo, [[da, a], ...] minuti
//                         dalla mezzanotte], exc: [{ from: giorno, to: giorno, name, work: [] | [[da, a], ...] }] }
//   giorno = numero del giorno dall'1/1/1970 (t / 1440)

export const DAY = 1440;
export const STD_WEEK = () => [[], [[480, 720], [780, 1020]], [[480, 720], [780, 1020]], [[480, 720], [780, 1020]], [[480, 720], [780, 1020]], [[480, 720], [780, 1020]], []];

export const fromParts = (y, m, d, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh, mm) / 60000;
export function parseDate(s) {
  if (s == null || s === "") return null;
  if (typeof s === "number") return s;
  const m = String(s).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return fromParts(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0));
}
const p2 = n => String(n).padStart(2, "0");
export function toIso(t, seconds = true) {
  if (t == null || !isFinite(t)) return "";
  const d = new Date(t * 60000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}${seconds ? ":00" : ""}`;
}
export const toDay = d => { const x = new Date(d * DAY * 60000); return `${x.getUTCFullYear()}-${p2(x.getUTCMonth() + 1)}-${p2(x.getUTCDate())}`; };
export const dayOf = t => Math.floor(t / DAY);
export const weekday = day => ((day % 7) + 11) % 7; // 1/1/1970 = giovedi' (4)
export const ymd = t => { const d = new Date(t * 60000); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]; };

// Pasqua (algoritmo di Gauss/Meeus, calendario gregoriano)
export function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return dayOf(fromParts(y, month, day));
}
// festivita' nazionali italiane di un anno: [giorno, chiave del nome]
export function italianHolidays(y) {
  const f = (m, d, k) => [dayOf(fromParts(y, m, d)), k];
  return [f(1, 1, "capodanno"), f(1, 6, "epifania"), [easter(y), "pasqua"], [easter(y) + 1, "pasquetta"], f(4, 25, "liberazione"),
    f(5, 1, "lavoro"), f(6, 2, "repubblica"), f(8, 15, "ferragosto"), f(11, 1, "santi"), f(12, 8, "immacolata"), f(12, 25, "natale"), f(12, 26, "stefano")];
}

// calendario "compilato": turni per giorno con cache, ricerca dei tempi di lavoro
export class WorkCal {
  constructor(cal, byUid = new Map()) {
    this.cal = cal;
    this.cache = new Map();
    // catena delle basi (calendari delle risorse ereditano dal calendario di base)
    const chain = [];
    for (let c = cal, n = 0; c && n < 10; c = c.base != null ? byUid.get(c.base) : null, n++) chain.push(c);
    this.week = Array.from({ length: 7 }, (_, d) => { for (const c of chain) if (c.week && c.week[d] != null) return c.week[d]; return STD_WEEK()[d]; });
    this.exc = new Map();
    for (const c of chain.slice().reverse()) for (const x of c.exc || []) for (let d = x.from; d <= x.to && d - x.from < 3700; d++) this.exc.set(d, x.work || []);
    this.anyWork = this.week.some(s => s.length) || [...this.exc.values()].some(s => s.length);
  }
  shifts(day) { // turni assoluti del giorno [[da, a]]
    let s = this.cache.get(day);
    if (!s) {
      const rel = this.exc.has(day) ? this.exc.get(day) : this.week[weekday(day)];
      s = rel.map(([a, b]) => [day * DAY + a, day * DAY + (b <= a ? DAY : b)]);
      if (this.cache.size > 20000) this.cache.clear();
      this.cache.set(day, s);
    }
    return s;
  }
  isWorkDay(day) { return this.shifts(day).length > 0; }
  dayMinutes(day) { return this.shifts(day).reduce((n, [a, b]) => n + b - a, 0); }
  // primo istante lavorativo >= t (semantica "inizio": la fine di un turno non vale)
  nextWork(t) {
    if (!this.anyWork) return t;
    for (let d = dayOf(t), n = 0; n < 4000; d++, n++) for (const [a, b] of this.shifts(d)) { if (t < a) return a; if (t < b) return t; }
    return t;
  }
  // ultimo istante lavorativo <= t (semantica "fine": la fine di un turno vale)
  prevWork(t) {
    if (!this.anyWork) return t;
    for (let d = dayOf(t - 1e-9), n = 0; n < 4000; d--, n++) { const s = this.shifts(d); for (let i = s.length - 1; i >= 0; i--) { const [a, b] = s[i]; if (t > b) return b; if (t > a) return t; } }
    return t;
  }
  // t + w minuti lavorativi (da un inizio a una fine)
  add(t, w) {
    if (!(w > 0)) return w < 0 ? this.sub(t, -w) : t;
    if (!this.anyWork) return t + w;
    for (let d = dayOf(t), n = 0; n < 40000; d++, n++) for (const [a, b] of this.shifts(d)) {
      if (b <= t) continue;
      const s = Math.max(a, t);
      if (s + w <= b) return s + w;
      w -= b - s;
    }
    return t + w;
  }
  // t - w minuti lavorativi (da una fine a un inizio)
  sub(t, w) {
    if (!(w > 0)) return w < 0 ? this.add(t, -w) : t;
    if (!this.anyWork) return t - w;
    for (let d = dayOf(t - 1e-9), n = 0; n < 40000; d--, n++) { const s = this.shifts(d); for (let i = s.length - 1; i >= 0; i--) {
      const [a, b] = s[i];
      if (a >= t) continue;
      const e = Math.min(b, t);
      if (e - w >= a) return e - w;
      w -= e - a;
    } }
    return t - w;
  }
  // minuti lavorativi tra a e b (negativi se b < a)
  between(a, b) {
    if (b < a) return -this.between(b, a);
    if (!this.anyWork) return b - a;
    let n = 0;
    for (let d = dayOf(a), k = 0; d <= dayOf(b) && k < 40000; d++, k++) for (const [x, y] of this.shifts(d)) n += Math.max(0, Math.min(y, b) - Math.max(x, a));
    return n;
  }
}

export function newCalendar(uid, name, base = null) {
  return { uid, name, base, week: base == null ? STD_WEEK() : [null, null, null, null, null, null, null], exc: [] };
}
