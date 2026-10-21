// Lettura di iCalendar (RFC 5545, anche vCalendar 1.0) e vCard (2.1, 3.0, 4.0) senza librerie esterne,
// piu' le esportazioni comuni (CSV, Excel, PDF) usate da viewers/calendar.js e viewers/contacts.js.
import { api, loadScript, saveBytes, WEB } from "./core.js";

// ---------------------------------------------------------------- righe e proprieta'
export function decodeText(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return new TextDecoder("windows-1252").decode(bytes); }
}

// righe "piegate" (continuano con spazio o tab) e, nel 2.1, righe quoted-printable che finiscono con "="
function unfold(text) {
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  for (const l of raw) {
    if ((l.startsWith(" ") || l.startsWith("\t")) && out.length) out[out.length - 1] += l.slice(1);
    else if (out.length && /QUOTED-PRINTABLE/i.test(out[out.length - 1].split(":")[0]) && out[out.length - 1].endsWith("=")) out[out.length - 1] = out[out.length - 1].slice(0, -1) + l;
    else out.push(l);
  }
  return out.filter(l => l.trim());
}

function splitOutside(s, sep) {
  // separa ignorando le parti tra virgolette
  const out = [];
  let cur = "", q = false;
  for (const ch of s) {
    if (ch === '"') q = !q;
    if (ch === sep && !q) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseLine(line) {
  let colon = -1, q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i]; if (c === '"') q = !q; else if (c === ":" && !q) { colon = i; break; } }
  if (colon < 0) return null;
  const head = splitOutside(line.slice(0, colon), ";");
  let name = head[0].toUpperCase();
  const dot = name.indexOf(".");
  const group = dot > 0 ? name.slice(0, dot) : "";
  if (dot > 0) name = name.slice(dot + 1);
  const params = {};
  for (const p of head.slice(1)) {
    const eq = p.indexOf("=");
    if (eq < 0) { (params.TYPE ||= []).push(p.toLowerCase()); continue; } // vCard 2.1: TEL;WORK;VOICE
    const k = p.slice(0, eq).toUpperCase(), v = p.slice(eq + 1).replace(/^"|"$/g, "");
    if (k === "TYPE") (params.TYPE ||= []).push(...v.toLowerCase().split(",").map(x => x.replace(/"/g, "")));
    else params[k] = v;
  }
  let value = line.slice(colon + 1);
  if ((params.ENCODING || "").toUpperCase() === "QUOTED-PRINTABLE") value = qp(value, params.CHARSET);
  return { name, group, params, value };
}

function qp(s, charset) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(s.charCodeAt(i) & 0xff);
  }
  try { return new TextDecoder((charset || "utf-8").toLowerCase()).decode(new Uint8Array(bytes)); } catch { return new TextDecoder("utf-8").decode(new Uint8Array(bytes)); }
}

export function unescapeText(v) {
  return v.replace(/\\([nN,;\\:])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

// componenti annidati (BEGIN/END) -> albero { type, props: [{name, params, value}], children }
export function parseComponents(text) {
  const root = { type: "ROOT", props: [], children: [] };
  const stack = [root];
  for (const line of unfold(text)) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "BEGIN") { const c = { type: p.value.trim().toUpperCase(), props: [], children: [] }; stack[stack.length - 1].children.push(c); stack.push(c); }
    else if (p.name === "END") { if (stack.length > 1) stack.pop(); }
    else stack[stack.length - 1].props.push(p);
  }
  return root;
}
const prop = (c, n) => c.props.find(p => p.name === n);
const props = (c, n) => c.props.filter(p => p.name === n);

// ---------------------------------------------------------------- iCalendar
const fmtCache = new Map();
function tzOffsetMinutes(tz, utcMs) {
  let f = fmtCache.get(tz);
  if (f === undefined) {
    try { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); } catch { f = null; }
    fmtCache.set(tz, f);
  }
  if (!f) return null;
  const parts = Object.fromEntries(f.formatToParts(new Date(utcMs)).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return (asUtc - utcMs) / 60000;
}
// fusi orari di Outlook/Windows piu' comuni -> IANA
const WIN_TZ = { "W. Europe Standard Time": "Europe/Rome", "Central Europe Standard Time": "Europe/Budapest", "Romance Standard Time": "Europe/Paris",
  "GMT Standard Time": "Europe/London", "UTC": "UTC", "Eastern Standard Time": "America/New_York", "Pacific Standard Time": "America/Los_Angeles",
  "Central Standard Time": "America/Chicago", "E. Europe Standard Time": "Europe/Bucharest", "Greenwich Standard Time": "Atlantic/Reykjavik" };

// valore DATE/DATE-TIME -> { date: Date (ora locale del PC), allDay }
export function parseDate(p) {
  if (!p) return null;
  const v = p.value.trim().split(",")[0];
  const m = /^(\d{4})-?(\d{2})-?(\d{2})(?:T(\d{2}):?(\d{2}):?(\d{2})?(Z)?)?/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined || (p.params.VALUE || "").toUpperCase() === "DATE") return { date: new Date(+y, +mo - 1, +d), allDay: true };
  if (z) return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0))), allDay: false };
  let tz = p.params.TZID;
  if (tz) {
    tz = tz.replace(/^\/+/, "");
    tz = WIN_TZ[tz] || tz;
    const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0));
    let off = tzOffsetMinutes(tz, wall);
    if (off !== null) {
      off = tzOffsetMinutes(tz, wall - off * 60000) ?? off; // secondo passaggio vicino ai cambi d'ora
      return { date: new Date(wall - off * 60000), allDay: false, tz };
    }
  }
  return { date: new Date(+y, +mo - 1, +d, +h, +mi, +(s || 0)), allDay: false }; // ora "fluttuante"
}

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec((v || "").trim());
  if (!m) return null;
  const ms = (((+(m[2] || 0) * 7 + +(m[3] || 0)) * 24 + +(m[4] || 0)) * 60 + +(m[5] || 0)) * 60000 + +(m[6] || 0) * 1000;
  return m[1] === "-" ? -ms : ms;
}

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const IT_DAYS = ["domenica", "lunedi'", "martedi'", "mercoledi'", "giovedi'", "venerdi'", "sabato"];

function parseRule(v) {
  const r = {};
  for (const part of v.split(";")) { const [k, x] = part.split("="); if (k) r[k.toUpperCase()] = x; }
  return r;
}

export function describeRule(v) {
  if (!v) return "";
  const r = parseRule(v), n = +(r.INTERVAL || 1);
  const unit = { DAILY: ["giorno", "giorni"], WEEKLY: ["settimana", "settimane"], MONTHLY: ["mese", "mesi"], YEARLY: ["anno", "anni"] }[r.FREQ] || ["", ""];
  let s = n === 1 ? `Ogni ${unit[0]}` : `Ogni ${n} ${unit[1]}`;
  if (r.BYDAY) s += ", " + r.BYDAY.split(",").map(d => { const m = /^([+-]?\d+)?(\w\w)$/.exec(d); if (!m) return d; const day = IT_DAYS[DAYS.indexOf(m[2])] || m[2]; return m[1] ? (m[1] === "-1" ? "ultimo " : m[1] + "° ") + day : day; }).join(", ");
  if (r.BYMONTHDAY) s += ", giorno " + r.BYMONTHDAY;
  if (r.COUNT) s += `, ${r.COUNT} volte`;
  if (r.UNTIL) { const d = parseDate({ value: r.UNTIL, params: {} }); if (d) s += ", fino al " + d.date.toLocaleDateString("it-IT"); }
  return s;
}

// occorrenze di una regola RRULE (calcolate nell'ora locale): limite di sicurezza 3000 o 10 anni
function expand(start, ruleText, exdates, horizon) {
  const r = parseRule(ruleText);
  const freq = r.FREQ, interval = Math.max(1, +(r.INTERVAL || 1));
  const count = r.COUNT ? +r.COUNT : Infinity;
  const until = r.UNTIL ? parseDate({ value: r.UNTIL, params: {} })?.date : null;
  const end = until && until < horizon ? until : horizon;
  const byday = r.BYDAY ? r.BYDAY.split(",").map(d => { const m = /^([+-]?\d+)?(\w\w)$/.exec(d.trim()); return m ? { n: m[1] ? +m[1] : 0, wd: DAYS.indexOf(m[2]) } : null; }).filter(Boolean) : null;
  const bymd = r.BYMONTHDAY ? r.BYMONTHDAY.split(",").map(Number) : null;
  const bymonth = r.BYMONTH ? r.BYMONTH.split(",").map(Number) : null;
  const out = [];
  const ex = new Set(exdates.map(d => d.getTime()));
  const h = start.getHours(), mi = start.getMinutes(), s = start.getSeconds();
  const push = d => {
    if (d < start || d > end || out.length >= count) return;
    out.push(d);
  };
  const atTime = (y, m, d) => new Date(y, m, d, h, mi, s);
  let guard = 0;
  if (freq === "DAILY") {
    for (let d = new Date(start); d <= end && out.length < count && guard++ < 40000; d = atTime(d.getFullYear(), d.getMonth(), d.getDate() + interval)) {
      if (bymonth && !bymonth.includes(d.getMonth() + 1)) continue;
      if (byday && !byday.some(b => b.wd === d.getDay())) continue;
      push(d);
    }
  } else if (freq === "WEEKLY") {
    const days = byday ? byday.map(b => b.wd) : [start.getDay()];
    const wk0 = atTime(start.getFullYear(), start.getMonth(), start.getDate() - ((start.getDay() + 6) % 7)); // lunedi'
    for (let w = 0; guard++ < 20000; w += interval) {
      const base = atTime(wk0.getFullYear(), wk0.getMonth(), wk0.getDate() + w * 7);
      if (base > end) break;
      for (const wd of [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))) push(atTime(base.getFullYear(), base.getMonth(), base.getDate() + ((wd + 6) % 7)));
      if (out.length >= count) break;
    }
  } else if (freq === "MONTHLY" || freq === "YEARLY") {
    const step = freq === "MONTHLY" ? interval : 12 * interval;
    for (let k = 0; guard++ < 5000; k += step) {
      const y = start.getFullYear() + Math.floor((start.getMonth() + k) / 12), m = (start.getMonth() + k) % 12;
      const months = freq === "YEARLY" && bymonth ? bymonth.map(x => x - 1) : [m];
      if (new Date(y, months[0], 1) > end) break;
      for (const mm of months) {
        const dim = new Date(y, mm + 1, 0).getDate();
        let cands = [];
        if (byday) {
          for (const b of byday) {
            const all = [];
            for (let d = 1; d <= dim; d++) if (new Date(y, mm, d).getDay() === b.wd) all.push(d);
            if (b.n > 0) { if (all[b.n - 1]) cands.push(all[b.n - 1]); } else if (b.n < 0) { if (all[all.length + b.n]) cands.push(all[all.length + b.n]); } else cands.push(...all);
          }
        } else if (bymd) cands = bymd.map(d => (d < 0 ? dim + d + 1 : d)).filter(d => d >= 1 && d <= dim);
        else if (start.getDate() <= dim) cands = [start.getDate()];
        for (const d of cands.sort((a, b) => a - b)) push(atTime(y, mm, d));
      }
      if (out.length >= count) break;
    }
  } else out.push(start);
  return out.filter(d => !ex.has(d.getTime())).slice(0, 3000); // COUNT comprende anche le date escluse (EXDATE)
}

function person(p) {
  if (!p) return null;
  const mail = p.value.replace(/^mailto:/i, "");
  return { nome: p.params.CN || mail, email: mail, stato: { ACCEPTED: "ha accettato", DECLINED: "ha rifiutato", TENTATIVE: "forse", "NEEDS-ACTION": "in attesa", DELEGATED: "delegato" }[(p.params.PARTSTAT || "").toUpperCase()] || "",
    ruolo: { "REQ-PARTICIPANT": "obbligatorio", "OPT-PARTICIPANT": "facoltativo", CHAIR: "presidente", "NON-PARTICIPANT": "per conoscenza" }[(p.params.ROLE || "").toUpperCase()] || "" };
}

export function parseCalendar(text) {
  const root = parseComponents(text);
  const cals = root.children.filter(c => c.type === "VCALENDAR");
  const comps = [];
  let name = "";
  for (const cal of cals.length ? cals : [root]) {
    name ||= unescapeText(prop(cal, "X-WR-CALNAME")?.value || "");
    for (const c of cal.children) if (["VEVENT", "VTODO", "VJOURNAL", "VFREEBUSY"].includes(c.type)) comps.push(c);
  }
  const horizon = new Date(new Date().getFullYear() + 10, 0, 1);
  const items = [];
  const overrides = new Map();
  for (const c of comps) {
    const rid = prop(c, "RECURRENCE-ID");
    if (rid) { const d = parseDate(rid); if (d) overrides.set((prop(c, "UID")?.value || "") + "|" + d.date.getTime(), c); }
  }
  let seq = 0;
  for (const c of comps) {
    if (prop(c, "RECURRENCE-ID")) continue;
    const base = toItem(c);
    if (!base) continue;
    const rule = prop(c, "RRULE")?.value;
    if (rule && base.inizio) {
      const ex = props(c, "EXDATE").flatMap(p => p.value.split(",").map(v => parseDate({ value: v, params: p.params })?.date).filter(Boolean));
      const dur = base.fine ? base.fine - base.inizio : 0;
      const occ = expand(base.inizio, rule, ex, horizon);
      for (const d of occ) {
        const ov = overrides.get(base.uid + "|" + d.getTime());
        const it = ov ? toItem(ov) : { ...base, inizio: d, fine: dur ? new Date(d.getTime() + dur) : null };
        items.push({ ...it, id: ++seq, ripetuto: true, regola: describeRule(rule) });
      }
      for (const rd of props(c, "RDATE")) for (const v of rd.value.split(",")) { const d = parseDate({ value: v, params: rd.params }); if (d) items.push({ ...base, id: ++seq, inizio: d.date, fine: dur ? new Date(d.date.getTime() + dur) : null, ripetuto: true }); }
    } else items.push({ ...base, id: ++seq });
  }
  items.sort((a, b) => (a.inizio || a.scadenza || 0) - (b.inizio || b.scadenza || 0));
  return { nome: name, elementi: items };
}

function toItem(c) {
  const st = parseDate(prop(c, "DTSTART"));
  let en = parseDate(prop(c, "DTEND"));
  const due = parseDate(prop(c, "DUE"));
  const dur = parseDuration(prop(c, "DURATION")?.value);
  let fine = en?.date || (st && dur !== null ? new Date(st.date.getTime() + dur) : null);
  const allDay = !!st?.allDay;
  // gli eventi di una giornata intera finiscono il giorno DOPO (escluso): per mostrarli si usa l'ultimo giorno incluso
  if (allDay && fine && fine > st.date) fine = new Date(fine.getTime() - 1);
  const t = s => unescapeText(prop(c, s)?.value || "");
  const tipo = { VEVENT: "Evento", VTODO: "Attivita'", VJOURNAL: "Nota", VFREEBUSY: "Disponibilita'" }[c.type];
  if (!st && !due && c.type !== "VTODO" && c.type !== "VJOURNAL") return null;
  return {
    uid: prop(c, "UID")?.value || "", tipo, titolo: t("SUMMARY") || "(senza titolo)", luogo: t("LOCATION"), descrizione: t("DESCRIPTION"),
    inizio: st?.date || null, fine, giornata: allDay, scadenza: due?.date || null, fuso: st?.tz || "",
    stato: { CONFIRMED: "Confermato", TENTATIVE: "Provvisorio", CANCELLED: "Annullato", "NEEDS-ACTION": "Da fare", COMPLETED: "Completata", "IN-PROCESS": "In corso" }[(prop(c, "STATUS")?.value || "").toUpperCase()] || "",
    categorie: props(c, "CATEGORIES").flatMap(p => p.value.split(",").map(x => unescapeText(x.trim()))).filter(Boolean),
    organizzatore: person(prop(c, "ORGANIZER")), partecipanti: props(c, "ATTENDEE").map(person),
    url: prop(c, "URL")?.value || "", priorita: prop(c, "PRIORITY")?.value || "", classe: prop(c, "CLASS")?.value || "",
    promemoria: c.children.filter(a => a.type === "VALARM").map(a => describeAlarm(prop(a, "TRIGGER"))).filter(Boolean),
  };
}

function describeAlarm(p) {
  if (!p) return "";
  const ms = parseDuration(p.value);
  if (ms === null) { const d = parseDate(p); return d ? "il " + d.date.toLocaleString("it-IT") : ""; }
  const m = Math.abs(ms) / 60000;
  const txt = m === 0 ? "all'inizio" : m % 1440 === 0 ? `${m / 1440} giorn${m / 1440 === 1 ? "o" : "i"}` : m % 60 === 0 ? `${m / 60} or${m / 60 === 1 ? "a" : "e"}` : `${m} minuti`;
  return m === 0 ? txt : `${txt} ${ms < 0 ? "prima" : "dopo"}`;
}

// ---------------------------------------------------------------- vCard
export function parseVcards(text) {
  const root = parseComponents(text);
  const cards = [];
  const walk = c => { for (const k of c.children) { if (k.type === "VCARD") cards.push(toCard(k)); else walk(k); } };
  walk(root);
  return cards;
}

const TEL_TYPES = { cell: "Cellulare", work: "Lavoro", home: "Casa", fax: "Fax", voice: "Voce", pager: "Cercapersone", text: "SMS", video: "Video", main: "Principale", iphone: "iPhone" };
function typeLabel(params, map = TEL_TYPES) {
  const t = (params.TYPE || []).filter(x => x !== "pref" && x !== "internet" && x !== "voice" && x !== "x400");
  return t.map(x => map[x] || x).join(", ");
}

function toCard(c) {
  const v = n => unescapeText(prop(c, n)?.value || "");
  const parts = s => splitEsc(s);
  const n = parts(prop(c, "N")?.value || "");
  const org = parts(prop(c, "ORG")?.value || "");
  const photoP = prop(c, "PHOTO") || prop(c, "LOGO");
  let foto = "";
  if (photoP) {
    const val = photoP.value.trim();
    if (/^data:/i.test(val)) foto = val;
    else if (/^https?:/i.test(val)) foto = "";
    else if (val) {
      const t = (photoP.params.TYPE?.[0] || photoP.params.MEDIATYPE || "jpeg").replace(/^image\//, "");
      foto = `data:image/${t};base64,${val.replace(/\s+/g, "")}`;
    }
  }
  const nomeCompleto = v("FN") || [n[3], n[1], n[2], n[0], n[4]].filter(Boolean).join(" ");
  return {
    nome: nomeCompleto || v("EMAIL") || v("ORG") || "(senza nome)", cognome: n[0] || "", nome_proprio: n[1] || "", altri_nomi: n[2] || "", titolo_nome: n[3] || "", suffisso: n[4] || "",
    soprannome: v("NICKNAME"), azienda: org[0] || "", reparto: org.slice(1).join(", "), qualifica: v("TITLE"), ruolo: v("ROLE"),
    telefoni: props(c, "TEL").map(p => ({ tipo: typeLabel(p.params), valore: p.value.replace(/^tel:/i, "").trim(), pref: (p.params.TYPE || []).includes("pref") || p.params.PREF === "1" })),
    email: props(c, "EMAIL").map(p => ({ tipo: typeLabel(p.params), valore: p.value.trim() })),
    indirizzi: props(c, "ADR").map(p => { const a = parts(p.value); return { tipo: typeLabel(p.params), casella: a[0] || "", esteso: a[1] || "", via: a[2] || "", citta: a[3] || "", provincia: a[4] || "", cap: a[5] || "", paese: a[6] || "" }; }),
    siti: props(c, "URL").map(p => p.value.trim()), compleanno: v("BDAY"), anniversario: v("ANNIVERSARY") || v("X-ANNIVERSARY"),
    note: v("NOTE"), categorie: props(c, "CATEGORIES").flatMap(p => p.value.split(",")).map(x => unescapeText(x.trim())).filter(Boolean),
    social: props(c, "X-SOCIALPROFILE").map(p => p.value).concat(props(c, "IMPP").map(p => p.value)), foto, versione: v("VERSION"),
  };
}

function splitEsc(s) {
  const out = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) { cur += s[i] + s[i + 1]; i++; continue; }
    if (s[i] === ";") { out.push(unescapeText(cur)); cur = ""; } else cur += s[i];
  }
  out.push(unescapeText(cur));
  return out.map(x => x.trim());
}

// ---------------------------------------------------------------- esportazioni
export function toCsv(cols, rows) {
  const esc = v => { const s = v === null || v === undefined ? "" : String(v); return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return "﻿" + [cols.map(esc).join(";"), ...rows.map(r => r.map(esc).join(";"))].join("\r\n") + "\r\n";
}

export async function saveTable(target, sheetName, cols, rows) {
  const ext = target.split(".").pop().toLowerCase();
  if (ext === "csv") return saveBytes(target, new TextEncoder().encode(toCsv(cols, rows)));
  if (ext === "xlsx") {
    if (!WEB) return api("fx", { op: "xlsx" }, { json: { out: target, fogli: [{ nome: sheetName, colonne: cols, righe: rows }] } });
    await loadScript("/vendor/xlsx/dist/xlsx.full.min.js");
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet([cols, ...rows]), sheetName.slice(0, 31));
    return saveBytes(target, new Uint8Array(window.XLSX.write(wb, { type: "array", bookType: "xlsx" })));
  }
  throw new Error("Formato non previsto: ." + ext);
}

export async function savePdf(target, html, landscape = false) {
  if (WEB) throw new Error("Nella web app il PDF si ottiene con Stampa -> Salva come PDF");
  return api("fx", { op: "html_pdf" }, { json: { html, out: target, orizzontale: landscape } });
}

export function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
