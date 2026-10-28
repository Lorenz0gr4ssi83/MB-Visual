// Formati di date e durate per l'interfaccia dei piani di progetto (lingua dell'app).
import { t, LOCALE } from "../i18n.js";
import { parseDate, fromParts, DAY } from "./pcal.js";
import { fmtDuration, parseDuration } from "./pmodel.js";

const DF = new Intl.DateTimeFormat(LOCALE, { timeZone: "UTC", weekday: "short", day: "2-digit", month: "2-digit", year: "2-digit" });
const DFT = new Intl.DateTimeFormat(LOCALE, { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const DFD = new Intl.DateTimeFormat(LOCALE, { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" });
const MON = new Intl.DateTimeFormat(LOCALE, { timeZone: "UTC", month: "short", year: "numeric" });
const MONS = new Intl.DateTimeFormat(LOCALE, { timeZone: "UTC", month: "short" });
const DM = new Intl.DateTimeFormat(LOCALE, { timeZone: "UTC", day: "numeric", month: "short" });
const WD = new Intl.DateTimeFormat(LOCALE, { timeZone: "UTC", weekday: "narrow" });
export const fd = m => (m == null || !isFinite(m) ? "" : DF.format(new Date(m * 60000)));
export const fdt = m => (m == null || !isFinite(m) ? "" : DFT.format(new Date(m * 60000)));
export const fdd = m => (m == null || !isFinite(m) ? "" : DFD.format(new Date(m * 60000)));
export const fmon = m => MON.format(new Date(m * 60000));
export const fmons = m => MONS.format(new Date(m * 60000));
export const fdm = m => DM.format(new Date(m * 60000));
export const fwd = m => WD.format(new Date(m * 60000));

// ordine di giorno/mese/anno della lingua (es. it 31/12/2026, en-US 12/31/2026)
const ORDER = (() => {
  const parts = new Intl.DateTimeFormat(LOCALE, { day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(new Date(2026, 11, 31));
  return parts.filter(p => ["day", "month", "year"].includes(p.type)).map(p => p.type[0]).join("");
})();
// testo -> minuti; senza ora: defHour (8:00 per gli inizi, 17:00 per le fini)
export function parseUserDate(s, defMin = 480) {
  if (s == null) return null;
  s = String(s).trim();
  if (!s) return null;
  const iso = parseDate(s);
  if (iso != null && /^\d{4}-/.test(s)) return /[T ]\d/.test(s) ? iso : iso + defMin;
  const m = s.replace(/^[^\d]+/, "").match(/^(\d{1,4})[./-](\d{1,2})(?:[./-](\d{1,4}))?(?:[\sT,]+(\d{1,2})[:.](\d{2}))?/);
  if (!m) return null;
  const v = { [ORDER[0]]: +m[1], [ORDER[1]]: +m[2], [ORDER[2]]: m[3] ? +m[3] : null };
  if (ORDER[0] === "y") { v.y = +m[1]; v.m = +m[2]; v.d = +(m[3] || 1); }
  let y = v.y ?? new Date().getFullYear();
  if (y < 100) y += 2000;
  if (!(v.m >= 1 && v.m <= 12 && v.d >= 1 && v.d <= 31)) return null;
  return fromParts(y, v.m, v.d, m[4] ? +m[4] : 0, m[5] ? +m[5] : 0) + (m[4] ? 0 : defMin);
}

// etichette delle unita' (dalla lingua) e alias accettati in digitazione
export function unitLabels() {
  return { m: t("proj.u_m"), h: t("proj.u_h"), d: t("proj.u_d"), w: t("proj.u_w"), mo: t("proj.u_mo"), em: t("proj.u_em"), eh: t("proj.u_eh"), ed: t("proj.u_ed"), ew: t("proj.u_ew"), emo: t("proj.u_emo"),
    dec: (1.5).toLocaleString(LOCALE).includes(",") ? "," : ".", link: [t("proj.l_ff"), t("proj.l_fs"), t("proj.l_sf"), t("proj.l_ss")] };
}
export function unitAliases() {
  const L = unitLabels(), a = {};
  for (const k of ["m", "h", "d", "w", "mo"]) a[String(L[k]).toLowerCase()] = k;
  for (const k of ["em", "eh", "ed", "ew", "emo"]) a[String(L[k]).toLowerCase()] = k;
  return a;
}
export const durText = (P, t0) => fmtDuration(P, t0.dur, t0.du || "d", unitLabels(), t0.est);
export const durParse = (P, s) => parseDuration(P, s, unitAliases());
export const money = (v, cur = "€") => `${(v || 0).toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;
export const hours = m => `${Math.round((m || 0) / 6) / 10} ${t("proj.u_h")}`;
export { DAY };
