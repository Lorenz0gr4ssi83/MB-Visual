// Traduzioni dell'interfaccia. REGOLA: ogni testo visibile passa da t("chiave") e la chiave sta in ui/i18n/it.json
// (italiano = lingua di partenza e di riferimento) e in en.json; es/fr/de si completano con tools/i18n_check.py.
//
//   import { t } from "./i18n.js";
//   t("app.salvato", nome)                 // it.json: "app.salvato": "Salvato: {0}"
//   t("app.n_file", { n: 3 })              // parametri con nome: "{n} file"
//   tn("app.n_elementi", n)                // plurali: chiavi "app.n_elementi.one" / ".other" (Intl.PluralRules)
//   fmtNum(1234.5, 1) / fmtDate(d) / fmtDateTime(d) / LOCALE   // numeri e date secondo la lingua
//
// Lingua: scelta manuale (File > Impostazioni > Lingua, salvata in localStorage "mbv-lang"), altrimenti quella di
// Windows (chiesta al motore) o del browser; lingue non disponibili -> inglese. Testi mancanti: inglese, poi italiano.
// Nel codice HTML statico (index.html): data-i18n="chiave" (testo), data-i18n-title, data-i18n-ph (placeholder).

export const LANGS = [["it", "Italiano"], ["en", "English"], ["es", "Español"], ["fr", "Français"], ["de", "Deutsch"]];
const CODES = LANGS.map(l => l[0]);
// formato regionale per numeri e date (la lingua e' quella dell'interfaccia; per l'inglese si usa la regione di Windows)
const REGION = { it: "it-IT", en: "en-GB", es: "es-ES", fr: "fr-FR", de: "de-DE" };

function stored() {
  try { return localStorage.getItem("mbv-lang") || ""; } catch { return ""; }
}

async function systemLanguages() {
  const out = [];
  // app per PC: lingua dell'interfaccia di Windows letta dal motore (WebView2 potrebbe avere quella del browser)
  if (!window.MBV_WEB) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 1500);
      const r = await fetch("/api/lang", { credentials: "same-origin", signal: ctl.signal });
      clearTimeout(timer);
      const j = await r.json();
      if (j.windows) out.push(j.windows);
    } catch { /* motore non raggiungibile: si usa il browser */ }
  }
  return out.concat(navigator.languages || [navigator.language || "en"]);
}

function pick(list) {
  for (const l of list) {
    const c = String(l || "").toLowerCase().slice(0, 2);
    if (CODES.includes(c)) return { code: c, locale: l };
  }
  return { code: "en", locale: "en-GB" };
}

async function loadJson(code) {
  try {
    const r = await fetch(new URL(`../i18n/${code}.json`, import.meta.url));
    return r.ok ? await r.json() : {};
  } catch { return {}; }
}

const choice = stored();
const sys = choice ? [] : await systemLanguages();
const chosen = choice && CODES.includes(choice) ? { code: choice, locale: REGION[choice] } : pick(sys);
export const LANG = chosen.code;
export const MANUAL = !!choice;
// regione: quella di sistema se e' della stessa lingua (en-US -> date all'americana), altrimenti la predefinita
export const LOCALE = /^[a-z]{2}-[A-Z]{2}$/.test(chosen.locale) && chosen.locale.slice(0, 2) === LANG ? chosen.locale : REGION[LANG];

const [IT, EN, CUR] = await Promise.all([loadJson("it"), LANG === "en" || LANG === "it" ? null : loadJson("en"), LANG === "it" ? null : loadJson(LANG)]);
const DICTS = [CUR, LANG === "en" ? CUR : EN, IT].filter(Boolean);
document.documentElement.lang = LANG;

function fill(text, args) {
  if (!args.length) return text;
  const named = args.length === 1 && args[0] && typeof args[0] === "object" && !(args[0] instanceof Node) ? args[0] : null;
  return text.replace(/\{(\w+)\}/g, (m, k) => {
    const v = named ? named[k] : args[k];
    return v === undefined || v === null ? m : String(v); // i numeri si formattano prima, con fmtNum se serve
  });
}

export function has(key) {
  return DICTS.some(d => key in d);
}

export function t(key, ...args) {
  for (const d of DICTS) {
    const v = d[key];
    if (v !== undefined) return fill(v, args);
  }
  return fill(key, args);
}

const PR = new Intl.PluralRules(LOCALE);
export function tn(key, n, ...args) {
  const k = `${key}.${PR.select(n)}`;
  return has(k) ? t(k, { n, ...(args[0] || {}) }) : t(`${key}.other`, { n, ...(args[0] || {}) });
}

const NF = new Map();
export function fmtNum(n, digits) {
  if (typeof n !== "number" || !isFinite(n)) return String(n);
  const k = digits === undefined ? "a" : digits;
  if (!NF.has(k)) NF.set(k, new Intl.NumberFormat(LOCALE, digits === undefined ? { maximumFractionDigits: 3 } : { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  return NF.get(k).format(n);
}
export const fmtDate = d => new Date(d).toLocaleDateString(LOCALE);
export const fmtDateTime = d => new Date(d).toLocaleString(LOCALE);
export const collator = new Intl.Collator(LOCALE, { numeric: true, sensitivity: "base" });

// nomi dei tasti come sulla tastiera della lingua (Maiusc, Invio, Canc in italiano; Shift, Enter, Del in inglese...)
export function keyName(k) {
  const v = t("keys." + k);
  return v === "keys." + k ? k : v;
}

// cambio lingua: salvato e applicato ricaricando l'interfaccia
export function setLanguage(code) {
  try {
    if (code) localStorage.setItem("mbv-lang", code);
    else localStorage.removeItem("mbv-lang");
  } catch { /* */ }
}

// testi del codice HTML statico
export function translateDom(root = document) {
  for (const e of root.querySelectorAll("[data-i18n]")) e.textContent = t(e.dataset.i18n);
  for (const e of root.querySelectorAll("[data-i18n-title]")) e.title = t(e.dataset.i18nTitle);
  for (const e of root.querySelectorAll("[data-i18n-ph]")) e.placeholder = t(e.dataset.i18nPh);
  for (const e of root.querySelectorAll("[data-i18n-alt]")) e.alt = t(e.dataset.i18nAlt);
}
translateDom();

window.MBV_I18N = { t, LANG, LOCALE };
