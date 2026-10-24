// Biglietti da visita: riconoscimento dei campi dal testo letto (OCR) e dai QR, unione fronte/retro, vCard 3.0.
// Solo calcolo (nessun DOM, nessuna traduzione): si prova in Node con tests/test_bcard.mjs.
//
// Contatto: { prefix, given, family, org, title, phones: [{ type: cell|work|fax|home, value }], emails: [], urls: [],
//   socials: [{ type, value }], adr: { street, cap, city, prov, country }, piva, cf, note, extra: [righe non assegnate] }

export const empty = () => ({ prefix: "", given: "", family: "", org: "", title: "", phones: [], emails: [], urls: [], socials: [],
  adr: { street: "", cap: "", city: "", prov: "", country: "" }, piva: "", cf: "", note: "", extra: [] });

const TLD = "it|com|net|org|eu|info|biz|io|co|uk|de|fr|es|ch|at|be|nl|us|pt|pl|se|dk|no|fi|ie|gr|ro|cz|sk|hu|si|hr|sm|va|mt|lu|li|cn|jp|ru|br|ar|mx|ca|au|in|ae|tr|studio|design|email|online|store|shop|tech|app|cloud|group|engineering|srl|srls|legal|archi|build|consulting|agency|digital|me|tv|pro|work|site|website|xyz";
const RE_EMAIL = /[a-z0-9._%+-]+\s?(?:@|\(at\)|\[at\])\s?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const RE_URL = new RegExp(`\\b(?:https?:\\/\\/)?(?:www\\.)?[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.(?:${TLD})\\b(?:\\/[^\\s,;]*)?`, "gi");
const SOCIAL = [["linkedin", /linkedin\.com\//i], ["instagram", /instagram\.com\//i], ["facebook", /(?:facebook|fb)\.com\//i],
  ["twitter", /(?:twitter|x)\.com\//i], ["youtube", /youtube\.com\//i], ["tiktok", /tiktok\.com\//i], ["github", /github\.com\//i]];
const SOCIAL_WORD = /\b(linkedin|instagram|facebook|twitter|youtube|tiktok|github|skype|telegram)\b\s*[:.]?\s*(@?[\w.\-/]+)/i;

const RE_PHONE = /(?:\+|00)?\s?\(?\d[\d\s().\/-]{4,}\d/g;
const LBL_CELL = /(?:cell(?:ulare)?|mob(?:ile)?|mobil|gsm|handy|portable|m)\s*[:.]?\s*$/i;
const LBL_FAX = /(?:fax|f)\s*[:.]?\s*$/i;
const LBL_TEL = /(?:tel(?:efono|éfono|efon|ephone)?|phone|ph|t|uff(?:icio)?|office|centralino|diretto|direct|switchboard|w)\s*[:.]?\s*$/i;
const LBL_HOME = /(?:casa|home|privato|abitazione|h)\s*[:.]?\s*$/i;
const NOT_PHONE = /\b(p\.?\s?iva|partita|vat|c\.?\s?f\.?|cod(?:ice)?\.?\s?fisc|rea|cap\.?\s?soc|capitale|iban|cciaa|r\.?e\.?a|sdi|pec)\b/i;

const RE_PIVA = /(?:p\.?\s?iva\s*(?:e|\/|-|&)\s*c\.?\s?f\.?|p\.?\s?iva|partita\s+iva|vat(?:\s*(?:no|number|n|nr)\.?)?|ust-?id(?:nr)?\.?|c\.?\s?f\.?\s*(?:e|\/|-|&)\s*p\.?\s?iva)\s*[:.\-]?\s*(?:n\.?\s*)?((?:IT|[A-Z]{2})?\s?\d[\d\s]{9,13}\d)/i;
const RE_CF = /\b[A-Z]{6}\s?\d{2}[A-EHLMPRST]\d{2}[A-Z]\d{3}[A-Z]\b/i;
const RE_CF_NUM = /\b(?:c\.?\s?f\.?|cod(?:ice)?\.?\s?fisc(?:ale)?\.?)\s*[:.\-]?\s*(\d{11})\b/i;

const STREET = /^(?:via|v\.\s?le|viale|v\.|piazza|p\.\s?zza|p\.\s?za|piazzale|p\.le|corso|c\.\s?so|largo|strada|str\.|vicolo|vico|localit[aà]|loc\.|frazione|fraz\.|contrada|c\.\s?da|lungomare|lungotevere|borgo|salita|traversa|galleria|calle|rue|avenue|boulevard|chemin|stra(?:ss|ß)e|platz|weg)\b/i;
const STREET_EN = /\d+[a-z]?\s+[\w'’.\s-]+\b(?:street|st\.|road|rd\.|avenue|ave\.|lane|ln\.|way|drive|dr\.|boulevard|blvd\.?|square|sq\.|place|pl\.)/i;
const STREET_ANY = /\b(?:via|viale|piazza|corso|largo|strada|street|road|avenue)\s+[A-ZÀ-Ý0-9]/i;
const COUNTRY = /\b(italia|italy|italie|italien|svizzera|switzerland|schweiz|suisse|germany|germania|deutschland|france|francia|spain|spagna|españa|austria|österreich|united kingdom|uk|regno unito|usa|united states)\b\.?$/i;
const SEDE = /^(?:sede(?:\s+(?:legale|operativa|amministrativa|commerciale))?|uffici?|office|headquarters|hq|showroom|stabilimento|indirizzo|address)\s*[:.\-]?\s*/i;

const COMPANY = /(?:\bs\.?\s?r\.?\s?l\.?(?:s\.?)?(?=\s|$|[,.;)])|\bs\.?\s?p\.?\s?a\.?(?=\s|$|[,.;)])|\bs\.?\s?n\.?\s?c\.?(?=\s|$|[,.;)])|\bs\.\s?a\.\s?s\.?|\bsas\b|\bs\.?\s?c\.?\s?a\.?\s?r\.?\s?l\.?(?=\s|$)|\bsoc(?:iet[aà])?\.?\s+coop|\bltd\b|\blimited\b|\bgmbh\b|\binc\b\.?|\bllc\b|\bplc\b|\bs\.a\.|\bsa\b(?=$)|\bag\b(?=$)|\bb\.?v\.?(?=$)|\bstudio\b|\bgroup\b|\bgruppo\b|\bassociati\b|&\s*(?:c\.|co\.?|partners?)|\bpartners?\b|\bengineering\b|\bconsulting\b|\bholding\b|\bimpresa\b|\bcostruzioni\b|\bcompany\b|\bcorporation\b|\bagenzia\b|\bstudio\s+tecnico\b)/i;
const TITLE = /\b(ingegnere|architetto|geometra|perito|avvocato|notaio|commercialista|dottore|dottoressa|ragioniere|consulente|titolare|socio|fondatore|co-?founder|founder|amministratore|presidente|vicepresidente|direttore|direttrice|responsabile|dirigente|manager|coordinatore|coordinatrice|tecnico|progettista|commerciale|venditore|agente|account|assistente|segretari[ao]|impiegat[ao]|capo\s?cantiere|capocantiere|ceo|cto|cfo|coo|cmo|cio|owner|partner|director|head|officer|engineer|architect|designer|developer|sales|marketing|consultant|specialist|executive|president|chairman|lead|supervisor|analyst|administrator|representative|surveyor|lawyer|attorney|associate|project|office\s+manager|product|business|area|export|purchasing|acquisti|ufficio|amministrazione|produzione|qualit[aà]|logistica|hr|risorse\s+umane)\b/i;
const PREFIX = /^(ing|dott\.ssa|dott|dr\.ssa|dr|arch|geom|avv|prof\.ssa|prof|rag|p\.\s?i|per\.\s?ind|sig\.ra|sig|mr|mrs|ms|mme|m|herr|frau|dipl\.-ing)\.?\s+/i;
const PARTICLE = /^(de|di|da|del|della|dello|dei|degli|delle|dal|dalla|van|von|der|den|la|lo|le|mc|mac|d'|dall'|dell'|o')$/i;
const NAMEWORD = /^(?:[A-ZÀ-ÝŁŠŽ][a-zà-ÿłšž'’]+(?:-[A-ZÀ-Ý][a-zà-ÿ'’]+)?|[A-ZÀ-ÝŁŠŽ'’]{2,}(?:-[A-ZÀ-Ý]{2,})?|d['’][A-ZÀ-Ý][a-zà-ÿ]+|[A-Z]\.)$/;

const digits = s => (s || "").replace(/\D/g, "");
const squash = s => (s || "").replace(/\s+/g, " ").trim();

// righe pulite dal testo dell'OCR (stringhe o { text, h } con l'altezza della riga in pixel)
export function lines(input) {
  const arr = typeof input === "string" ? input.split(/\r?\n/) : input || [];
  return arr.map(x => (typeof x === "string" ? { text: x, h: 0 } : { text: x.text || "", h: x.h || 0, conf: x.conf ?? null }))
    .map(l => ({ ...l, text: squash(l.text.replace(/[|_~`«»•·▪●■♦◆]/g, " ").replace(/[‐‑‒–—]/g, "-").replace(/^[\s\-:.,;]+|[\s\-:,;]+$/g, "")) }))
    .filter(l => l.text.length > 1 && /[a-z0-9@]/i.test(l.text));
}

// numero di telefono ripulito: separatori uniformi, 00 -> +, italiani senza prefisso -> +39
export function normPhone(raw) {
  let s = squash(raw.replace(/[().\/-]/g, " "));
  if (s.startsWith("00")) s = "+" + s.slice(2).trim();
  s = s.replace(/^\+\s+/, "+");
  const d = digits(s);
  if (!s.startsWith("+") && /^[03]/.test(d) && d.length >= 6 && d.length <= 11) s = "+39 " + s;
  return s;
}
export function phoneKey(v) { let d = digits(v); if (v.trim().startsWith("+39") || v.trim().startsWith("0039")) d = d.replace(/^(00)?39/, ""); return d; }

function guessPhoneType(v) {
  const s = v.replace(/\s/g, "");
  const it = s.startsWith("+39") ? s.slice(3) : s.startsWith("+") ? null : s;
  if (it != null) return /^3\d{8,9}$/.test(it) ? "cell" : "work";
  if (/^\+44(0)?7/.test(s) || /^\+33[67]/.test(s) || /^\+49(15|16|17)/.test(s) || /^\+41(0)?7[5-9]/.test(s) || /^\+34[67]/.test(s) || /^\+43(0)?6/.test(s)) return "cell";
  return "work";
}

const normUrl = u => u.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "").toLowerCase();
const fixEmail = e => e.replace(/\s/g, "").replace(/\(at\)|\[at\]/i, "@").toLowerCase();

// Campi di un lato del biglietto
export function parseText(input) {
  const L = lines(input), c = empty(), used = new Set();
  const take = i => used.add(i);
  const gone = i => { used.add(i); L[i].rest = ""; }; // riga consumata per intero (indirizzo)
  const maxH = Math.max(0, ...L.map(l => l.h));

  L.forEach((l, i) => {
    let s = l.text;
    // email (prima degli indirizzi web: il dominio non deve diventare un sito)
    for (const m of s.match(RE_EMAIL) || []) { const e = fixEmail(m); if (!c.emails.includes(e)) c.emails.push(e); s = s.replace(m, " "); take(i); }
    // social
    for (const [type, re] of SOCIAL) if (re.test(s)) {
      const m = s.match(new RegExp(`(?:https?:\\/\\/)?(?:www\\.)?${re.source}[^\\s,;]*`, "i"));
      if (m) { c.socials.push({ type, value: m[0].replace(/^https?:\/\//i, "") }); s = s.replace(m[0], " "); take(i); }
    }
    const sw = s.match(SOCIAL_WORD);
    if (sw && !/\./.test(sw[2]) || sw && /^@/.test(sw[2])) { c.socials.push({ type: sw[1].toLowerCase(), value: sw[2] }); s = s.replace(sw[0], " "); take(i); }
    // P.IVA e codice fiscale
    const pv = s.match(RE_PIVA);
    if (pv) { c.piva = pv[1].replace(/\s/g, "").toUpperCase(); if (/c\.?\s?f/i.test(pv[0])) c.cf = c.piva.replace(/^[A-Z]{2}/, ""); s =s.replace(pv[0], " "); take(i); }
    const cfn = s.match(RE_CF_NUM);
    if (cfn) { c.cf = cfn[1]; s = s.replace(cfn[0], " "); take(i); }
    const cf = s.match(RE_CF);
    if (cf) { c.cf = cf[0].replace(/\s/g, "").toUpperCase(); s = s.replace(cf[0], " "); take(i); }
    if (!pv && /^\s*IT\s?\d{11}\s*$/i.test(s)) { c.piva = s.replace(/\s/g, "").toUpperCase(); s = ""; take(i); }
    // siti
    for (const m of s.match(RE_URL) || []) {
      if (/@/.test(m)) continue;
      const before = s.slice(0, s.indexOf(m));
      if (/[a-z0-9]$/i.test(before)) continue;
      const u = normUrl(m);
      if (u.split(".").length < 2 || /^\d/.test(u)) continue;
      if (!c.urls.some(x => normUrl(x) === u)) c.urls.push(m.replace(/^https?:\/\//i, "").replace(/\/+$/, ""));
      s = s.replace(m, " "); take(i);
    }
    // telefoni (non nelle righe con P.IVA, REA, IBAN...)
    if (!NOT_PHONE.test(l.text) || /\b(tel|cell|fax|mob|phone)\b/i.test(l.text)) {
      let last = 0, found = false;
      const src = s, addrLine = STREET.test(src.replace(SEDE, "")) || /\b\d{5}\s+[A-Za-zÀ-ÿ]/.test(src);
      for (const m of src.matchAll(RE_PHONE)) {
        const raw = m[0].trim(), d = digits(raw);
        if (d.length < 6 || d.length > 15) continue;
        if (/^\d{5}$/.test(raw) || /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(raw)) continue; // CAP, date
        if (NOT_PHONE.test(src.slice(Math.max(0, m.index - 14), m.index))) continue;
        const pre = src.slice(last, m.index);
        // "12 - 20121 Milano": numero civico e CAP, non un telefono
        if (/(^|\s)\d{5}$/.test(raw) && /^\s*[A-Za-zÀ-ÿ]/.test(src.slice(m.index + m[0].length))) continue;
        if (addrLine && !/(?:tel|cell|fax|mob|phone|\bt|\bm|\bf)\.?\s*[:.]?\s*$/i.test(pre)) continue;
        let type = LBL_FAX.test(pre) ? "fax" : LBL_CELL.test(pre) ? "cell" : LBL_HOME.test(pre) ? "home" : LBL_TEL.test(pre) ? "work" : null;
        // senza etichetta il numero puo' anche venire dopo l'etichetta "Tel./Fax" a inizio riga
        const value = normPhone(raw);
        if (!type) type = /\bfax\b/i.test(pre) ? "fax" : guessPhoneType(value);
        if (!c.phones.some(p => phoneKey(p.value) === phoneKey(value))) c.phones.push({ type, value });
        last = m.index + m[0].length; found = true;
        s = s.replace(m[0], " ");
      }
      if (found) { take(i); if (!/[a-z]{3}/i.test(s.replace(/\b(?:tel|telefono|cell|cellulare|mob|mobile|fax|phone)\b/gi, ""))) s = ""; }
    }
    // resto della riga senza le etichette dei recapiti trovati (conta solo per le righe in cui si e' trovato qualcosa)
    l.rest = squash(s.replace(/\b(?:tel|telefono|cell|cellulare|mob|mobile|mobil|handy|fax|phone|office|ufficio|uff|diretto|direct|centralino|e-?mail|mail|web|sito|www|pec)\b\s*[:.]?|\b[mtfwe]\s*[:.]/gi, " ").replace(/^[\s,;:\-]+|[\s,;:\-]+$/g, ""));
  });

  // indirizzo: riga con CAP (+ via sulla stessa riga o su quella prima)
  for (let i = 0; i < L.length && !c.adr.cap; i++) {
    const s = (L[i].rest ?? L[i].text).replace(SEDE, "");
    const m = s.match(/(?:^|[\s,\-])(?:I-|IT-)?(\d{5})\s+([A-Za-zÀ-ÿ'’.][A-Za-zÀ-ÿ'’.\s-]*?)(?:\s*\(\s*([A-Za-z]{2})\s*\)|\s+([A-Z]{2})\b|\s*-\s*([A-Z]{2})\b)?(?:\s*[,\-–]\s*([A-Za-zÀ-ÿ ]+))?\s*$/);
    if (!m) continue;
    let city = squash(m[2]), country = m[6] ? squash(m[6]) : "";
    if (country && !COUNTRY.test(country)) { city = squash(city + " " + country); country = ""; }
    const cm = city.match(COUNTRY);
    if (cm && cm.index > 0) { country = cm[0]; city = squash(city.slice(0, cm.index).replace(/[,\-]\s*$/, "")); }
    if (!city || city.length < 2) continue;
    c.adr.cap = m[1]; c.adr.city = city; c.adr.prov = (m[3] || m[4] || m[5] || "").toUpperCase(); c.adr.country = country;
    const before = squash(s.slice(0, m.index).replace(/[,\-–\s]+$/, ""));
    if (before && /[a-z]/i.test(before)) c.adr.street = before;
    else if (i > 0 && !used.has(i - 1) && (STREET.test((L[i - 1].rest ?? L[i - 1].text).replace(SEDE, "")) || STREET_EN.test(L[i - 1].text) || /\d/.test(L[i - 1].text))) { c.adr.street = (L[i - 1].rest ?? L[i - 1].text).replace(SEDE, ""); gone(i - 1); }
    gone(i);
  }
  if (!c.adr.street) for (let i = 0; i < L.length; i++) {
    const s = (L[i].rest ?? L[i].text).replace(SEDE, "");
    if (!used.has(i) && (STREET.test(s) || STREET_EN.test(s) || STREET_ANY.test(s)) && /\d/.test(s)) { c.adr.street = s; gone(i); break; }
  }
  if (!c.adr.country) for (let i = 0; i < L.length; i++) if (!used.has(i) && /^[A-Za-zÀ-ÿ ]+$/.test(L[i].text) && COUNTRY.test(L[i].text) && L[i].text.split(" ").length <= 3) { c.adr.country = L[i].text; gone(i); }

  // nome, azienda, ruolo dalle righe rimaste (anche "Mario Rossi - Direttore tecnico" divisa nei pezzi)
  const parts = [];
  L.forEach((l, i) => {
    const txt = used.has(i) ? l.rest : l.text;
    if (!txt || txt.length < 2) return;
    const pieces = txt.split(/\s+[-|/]\s+|\s*,\s+(?=[A-ZÀ-Ý])/).map(squash).filter(x => x.length > 1);
    pieces.forEach(p => parts.push({ text: p, h: l.h, conf: l.conf, i, whole: pieces.length === 1 && !used.has(i) }));
  });
  const stems = new Set();
  for (const e of c.emails) { const [loc, dom] = e.split("@"); dom.split(".").slice(0, -1).forEach(x => x.length >= 3 && !/^(mail|email|pec|gmail|libero|hotmail|outlook|yahoo|icloud|tiscali|virgilio|alice|tin|fastwebnet|live|legalmail|arubapec|postecert)$/.test(x) && stems.add(x)); loc && stems.add("@" + loc); }
  for (const u of c.urls) normUrl(u).split("/")[0].split(".").slice(0, -1).forEach(x => x.length >= 3 && stems.add(x));
  const flat = s => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  const locals = [...stems].filter(x => x.startsWith("@")).map(x => flat(x.slice(1)));
  const domains = [...stems].filter(x => !x.startsWith("@")).map(flat);

  const nameScore = p => {
    let t = p.text.replace(PREFIX, "");
    if (COMPANY.test(p.text) || TITLE.test(t) || /\d/.test(t) || /[@:]/.test(t)) return -1;
    const w = t.split(/\s+/);
    if (w.length < 2 || w.length > 4 || !w.every(x => NAMEWORD.test(x) || PARTICLE.test(x))) return -1;
    if (PARTICLE.test(w[0]) && w.length === 2) return -1;
    let s = 2;
    if (PREFIX.test(p.text)) s += 2;
    const ws = w.map(flat).filter(x => x.length >= 2);
    if (locals.some(lc => ws.some(x => x.length >= 3 && lc.includes(x)) || (ws.length >= 2 && lc.startsWith(ws[0][0]) && lc.includes(ws[ws.length - 1])))) s += 4;
    if (domains.some(d => d === flat(t))) s -= 3; // e' il nome dell'azienda
    if (maxH && p.h) s += 2 * p.h / maxH;
    if (w.every(x => /^[A-ZÀ-Ý'’.]+$/.test(x)) && w.length >= 3) s -= 0.5;
    return s;
  };
  const orgScore = p => {
    let s = 0;
    if (COMPANY.test(p.text)) s += 3;
    const f = flat(p.text);
    if (f.length >= 3 && domains.some(d => d.length >= 3 && (f.includes(d) || d.includes(f)))) s += 3;
    if (TITLE.test(p.text) && !COMPANY.test(p.text)) s -= 2;
    if (/@|\d{4,}/.test(p.text)) s -= 3;
    if (maxH && p.h) s += p.h / maxH;
    return s;
  };
  let best = null, bs = 0;
  for (const p of parts) { const s = nameScore(p); if (s > bs) { bs = s; best = p; } }
  const left = parts.filter(p => p !== best);
  if (best) {
    const pm = best.text.match(PREFIX);
    if (pm) c.prefix = squash(pm[0]).replace(/\s?\.?$/, ".").replace(/^(.)/, x => x.toUpperCase());
    const nm = splitName(best.text.replace(PREFIX, ""));
    c.given = nm.given; c.family = nm.family;
  }
  let org = null, os = 2.5;
  for (const p of left) { const s = orgScore(p); if (s > os) { os = s; org = p; } }
  if (org) c.org = org.text.replace(/^[\s,\-]+|[\s,\-]+$/g, "");
  const titles = left.filter(p => p !== org && TITLE.test(p.text) && !/\d{3}/.test(p.text) && p.text.length <= 60);
  if (titles.length) {
    // ruolo vicino al nome (stessa riga o subito sotto) se ce ne sono piu' d'uno
    titles.sort((a, b) => (best ? Math.abs(a.i - best.i) - Math.abs(b.i - best.i) : 0));
    c.title = titles[0].text;
  }
  const taken = new Set([best, org, titles[0]].filter(Boolean));
  // righe non assegnate da proporre, senza i frammenti illeggibili (disegni, loghi, QR letti come testo)
  const junk = p => {
    const w = p.text.split(/\s+/);
    return /[=[\]{}<>"\^~]/.test(p.text) || (p.conf != null && p.conf < 60) || w.filter(x => /^[A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ'’.]{2,}/.test(x)).length < w.length * 0.6;
  };
  c.extra = parts.filter(p => !taken.has(p) && /[a-z]{2}/i.test(p.text) && p.text.length >= 3 && !junk(p)).map(p => p.text);
  return c;
}

// "Mario Rossi", "ROSSI Mario", "Maria Teresa De Luca", "Gian-Luca D'Amico"
export function splitName(t) {
  const w = squash(t).split(" ").filter(Boolean);
  if (w.length < 2) return { given: w[0] || "", family: "" };
  const caps = w.map(x => /^[A-ZÀ-Ý'’-]{2,}$/.test(x));
  const fix = x => (/^[A-ZÀ-Ý'’-]{2,}$/.test(x) ? x.toLowerCase().replace(/(^|[\s'’-])([a-zà-ÿ])/g, (a, b, c) => b + c.toUpperCase()) : x);
  // cognome in maiuscolo davanti o dietro al nome scritto normale
  if (caps.some(Boolean) && !caps.every(Boolean)) {
    const fam = w.filter((_, i) => caps[i]), giv = w.filter((_, i) => !caps[i]);
    return { given: giv.join(" "), family: fam.map(fix).join(" ") };
  }
  const W = w.map(fix);
  for (let i = 1; i < W.length - 1; i++) if (PARTICLE.test(W[i])) return { given: W.slice(0, i).join(" "), family: W.slice(i).join(" ") };
  return { given: W.slice(0, -1).join(" "), family: W[W.length - 1] };
}

// ---------------------------------------------------------------- QR: vCard, MECARD, BIZCARD, collegamenti
const unesc = s => s.replace(/\\n/gi, "\n").replace(/\\([,;:\\])/g, "$1");
const splitEsc = (s, ch) => { const out = []; let cur = ""; for (let i = 0; i < s.length; i++) { if (s[i] === "\\" && i + 1 < s.length) { cur += s[i] + s[i + 1]; i++; } else if (s[i] === ch) { out.push(cur); cur = ""; } else cur += s[i]; } out.push(cur); return out; };

export function parseVcard(text) {
  const c = empty();
  const raw = text.replace(/\r\n|\r/g, "\n").replace(/\n[ \t]/g, "").replace(/=\n/g, "").split("\n");
  for (const line of raw) {
    const k = line.indexOf(":");
    if (k < 0) continue;
    const head = line.slice(0, k).split(";"), name = head[0].replace(/^item\d+\./i, "").toUpperCase();
    const params = head.slice(1).join(";").toUpperCase();
    let val = line.slice(k + 1);
    if (/ENCODING=QUOTED-PRINTABLE/.test(params)) { try { val = decodeURIComponent(val.replace(/=([0-9A-F]{2})/gi, "%$1")); } catch { /* */ } }
    if (name === "N") { const p = splitEsc(val, ";").map(unesc); c.family = p[0] || ""; c.given = [p[1], p[2]].filter(Boolean).join(" "); c.prefix = p[3] || ""; }
    else if (name === "FN" && !c.given && !c.family) { const n = splitName(unesc(val)); c.given = n.given; c.family = n.family; }
    else if (name === "ORG") c.org = splitEsc(val, ";").map(unesc).filter(Boolean).join(" - ");
    else if (name === "TITLE" || name === "ROLE") c.title = c.title || unesc(val);
    else if (name === "TEL") {
      const v = normPhone(val.replace(/^tel:/i, ""));
      const type = /FAX/.test(params) ? "fax" : /CELL|MOBILE|IPHONE/.test(params) ? "cell" : /HOME/.test(params) ? "home" : /WORK|VOICE|MAIN/.test(params) ? "work" : guessPhoneType(v);
      if (!c.phones.some(p => phoneKey(p.value) === phoneKey(v))) c.phones.push({ type, value: v });
    } else if (name === "EMAIL") { const e = fixEmail(val.replace(/^mailto:/i, "")); if (e && !c.emails.includes(e)) c.emails.push(e); }
    else if (name === "URL") { const u = unesc(val); const s = SOCIAL.find(([, re]) => re.test(u)); if (s) c.socials.push({ type: s[0], value: u.replace(/^https?:\/\//i, "") }); else c.urls.push(u.replace(/^https?:\/\//i, "").replace(/\/+$/, "")); }
    else if (name === "X-SOCIALPROFILE") { const tm = params.match(/TYPE=([A-Z]+)/); c.socials.push({ type: (tm ? tm[1] : "web").toLowerCase(), value: unesc(val).replace(/^https?:\/\//i, "") }); }
    else if (name === "ADR" && !c.adr.city && !c.adr.street) {
      const p = splitEsc(val, ";").map(unesc);
      c.adr = { street: squash([p[1], p[2]].filter(Boolean).join(" ")), city: p[3] || "", prov: p[4] || "", cap: p[5] || "", country: p[6] || "" };
    } else if (name === "NOTE") c.note = unesc(val);
  }
  return c;
}

export function parseMecard(text) {
  const c = empty();
  const body = text.replace(/^(MECARD|BIZCARD):/i, "");
  const biz = /^BIZCARD:/i.test(text);
  let bn = "", bx = "";
  for (const f of splitEsc(body, ";")) {
    const k = f.indexOf(":");
    if (k < 0) continue;
    const key = f.slice(0, k).toUpperCase(), v = unesc(f.slice(k + 1));
    if (!v) continue;
    if (biz) {
      if (key === "N") bn = v; else if (key === "X") bx = v; else if (key === "T") c.title = v; else if (key === "C") c.org = v;
      else if (key === "A") parseAdrInto(c, v); else if (key === "B" || key === "M" || key === "F") pushPhone(c, v, key === "F" ? "fax" : key === "M" ? "cell" : null);
      else if (key === "E") c.emails.push(fixEmail(v));
      continue;
    }
    if (key === "N") { const p = v.split(","); c.family = (p[0] || "").trim(); c.given = (p[1] || "").trim(); }
    else if (key === "ORG") c.org = v;
    else if (key === "TEL" || key === "TEL-AV") pushPhone(c, v, null);
    else if (key === "EMAIL") c.emails.push(fixEmail(v));
    else if (key === "URL") c.urls.push(v.replace(/^https?:\/\//i, "").replace(/\/+$/, ""));
    else if (key === "ADR") parseAdrInto(c, v);
    else if (key === "NOTE") c.note = v;
    else if (key === "TITLE") c.title = v;
  }
  if (biz) { c.given = bn; c.family = bx; }
  return c;
}
function pushPhone(c, v, type) { const n = normPhone(v); if (!c.phones.some(p => phoneKey(p.value) === phoneKey(n))) c.phones.push({ type: type || guessPhoneType(n), value: n }); }
function parseAdrInto(c, v) {
  if (v.includes(";") || (v.match(/,/g) || []).length >= 5) { const p = v.split(/[;,]/).map(squash); c.adr = { street: squash([p[1], p[2]].filter(Boolean).join(" ")), city: p[3] || "", prov: p[4] || "", cap: p[5] || "", country: p[6] || "" }; return; }
  const r = parseText(v.split(/,\s*/).join("\n"));
  if (r.adr.cap || r.adr.street) c.adr = r.adr; else c.adr.street = v;
}

// contenuto di un QR -> contatto (o null se non c'entra con un contatto)
export function parseQr(text) {
  const s = (text || "").trim();
  if (!s) return null;
  if (/BEGIN:VCARD/i.test(s)) return { kind: "vcard", c: parseVcard(s) };
  if (/^(MECARD|BIZCARD):/i.test(s)) return { kind: "mecard", c: parseMecard(s) };
  const c = empty();
  if (/^mailto:/i.test(s)) { c.emails.push(fixEmail(s.slice(7).split("?")[0])); return { kind: "link", c }; }
  if (/^tel:/i.test(s)) { pushPhone(c, s.slice(4), null); return { kind: "link", c }; }
  if (/^(https?:\/\/|www\.)\S+$/i.test(s)) {
    const sc = SOCIAL.find(([, re]) => re.test(s));
    if (sc) c.socials.push({ type: sc[0], value: s.replace(/^https?:\/\//i, "") }); else c.urls.push(s.replace(/^https?:\/\//i, "").replace(/\/+$/, ""));
    return { kind: "link", c };
  }
  return null;
}

// ---------------------------------------------------------------- unione (prima vince: QR, poi fronte, poi retro)
export function merge(...list) {
  const c = empty();
  for (const x of list.filter(Boolean)) {
    for (const k of ["prefix", "org", "title", "piva", "cf"]) if (!c[k] && x[k]) c[k] = x[k];
    if (!c.given && !c.family && (x.given || x.family)) { c.given = x.given; c.family = x.family; }
    for (const p of x.phones) { const i = c.phones.findIndex(q => phoneKey(q.value) === phoneKey(p.value)); if (i < 0) c.phones.push({ ...p }); }
    for (const e of x.emails) if (!c.emails.includes(e.toLowerCase())) c.emails.push(e.toLowerCase());
    for (const u of x.urls) if (!c.urls.some(v => normUrl(v) === normUrl(u))) c.urls.push(u);
    for (const s of x.socials) if (!c.socials.some(v => normUrl(v.value) === normUrl(s.value))) c.socials.push({ ...s });
    if (!c.adr.city && !c.adr.street && (x.adr.city || x.adr.street)) c.adr = { ...x.adr };
    else for (const k of ["street", "cap", "city", "prov", "country"]) if (!c.adr[k] && x.adr[k] && (k !== "street" || !c.adr.city || c.adr.city === x.adr.city)) c.adr[k] = x.adr[k];
    if (x.note && !c.note.includes(x.note)) c.note = c.note ? c.note + "\n" + x.note : x.note;
    for (const e of x.extra || []) if (!c.extra.includes(e)) c.extra.push(e);
  }
  // le righe non assegnate gia' presenti in un campo non servono piu'
  const all = [c.org, c.title, c.given + " " + c.family, c.adr.street, c.adr.city].join(" ").toLowerCase();
  c.extra = c.extra.filter(e => !all.includes(e.toLowerCase()));
  return c;
}

export const fullName = c => squash([c.prefix, c.given, c.family].join(" "));
export const displayName = c => squash([c.given, c.family].join(" ")) || c.org || c.emails[0] || "";

// ---------------------------------------------------------------- vCard 3.0 (UTF-8, righe piegate a 75 byte, CRLF)
const esc = s => String(s || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = []; let cur = "", n = 0, lim = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (n + b > lim) { out.push(cur); cur = ""; n = 0; lim = 74; }
    cur += ch; n += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}
const TEL_TYPE = { cell: "CELL,VOICE", work: "WORK,VOICE", fax: "WORK,FAX", home: "HOME,VOICE" };

// opts: { photo: base64 JPEG senza intestazione, labels: { piva, cf } per la nota }
export function buildVcard(c, opts = {}) {
  const L = ["BEGIN:VCARD", "VERSION:3.0"];
  const fn = fullName(c) || c.org || c.emails[0] || "";
  L.push(`N:${esc(c.family)};${esc(c.given)};;${esc(c.prefix)};`);
  L.push(`FN:${esc(fn)}`);
  if (c.org) L.push(`ORG:${esc(c.org)}`);
  if (c.title) L.push(`TITLE:${esc(c.title)}`);
  for (const p of c.phones) if (p.value.trim()) L.push(`TEL;TYPE=${TEL_TYPE[p.type] || "VOICE"}:${p.value.trim()}`);
  c.emails.forEach((e, i) => e.trim() && L.push(`EMAIL;TYPE=INTERNET,WORK${i === 0 ? ",PREF" : ""}:${e.trim()}`));
  for (const u of c.urls) if (u.trim()) L.push(`URL;TYPE=WORK:${/^https?:/i.test(u) ? u.trim() : "https://" + u.trim()}`);
  const a = c.adr;
  if (a.street || a.city || a.cap) L.push(`ADR;TYPE=WORK:;;${esc(a.street)};${esc(a.city)};${esc(a.prov)};${esc(a.cap)};${esc(a.country)}`);
  for (const s of c.socials) if (s.value.trim()) {
    const v = /^https?:|^@/.test(s.value) || !s.value.includes(".") ? s.value.trim() : "https://" + s.value.trim();
    L.push(`X-SOCIALPROFILE;TYPE=${s.type.replace(/[^a-z]/gi, "").toLowerCase() || "web"}:${v}`);
  }
  const lb = opts.labels || { piva: "P.IVA", cf: "C.F." };
  const note = [c.note, c.piva && `${lb.piva} ${c.piva}`, c.cf && `${lb.cf} ${c.cf}`].filter(Boolean).join("\n");
  if (note) L.push(`NOTE:${esc(note)}`);
  if (opts.photo) L.push(`PHOTO;ENCODING=b;TYPE=JPEG:${opts.photo}`);
  L.push(`REV:${new Date().toISOString().replace(/\.\d+Z$/, "Z")}`);
  L.push("END:VCARD");
  return L.map(fold).join("\r\n") + "\r\n";
}
