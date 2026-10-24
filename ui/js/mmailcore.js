// Posta dell'app per telefono - motore (senza interfaccia): account, password cifrate, chiamate al passaggio IMAP/SMTP del
// server (server/src/mailgw.js: il browser non apre connessioni TCP), lettura delle risposte IMAP, messaggi MIME, PEC.
// Tutto resta nel telefono: account e messaggi in IndexedDB "mbv-posta", password cifrate AES-GCM con una chiave non
// esportabile generata nel dispositivo. Il server non conserva nulla.
import { t } from "./i18n.js";

const V = p => (window.MBV_ROOT || "/") + "vendor/" + p;
let PM = null;
export const postal = async () => (PM ||= await import(V("postal-mime/src/postal-mime.js")));
const enc = new TextEncoder(), dec = new TextDecoder();

// ------------------------------------------------------------------ gestori preimpostati (come mbvisual/mail/accounts.py)
const PEC = [
  ["aruba", "Aruba PEC", ["pec.it", "arubapec.it", "gigapec.it", "mypec.eu", "pec.aruba.it", "postacertificata.email"], "imaps.pec.aruba.it", "smtps.pec.aruba.it"],
  ["legalmail", "Legalmail (InfoCert)", ["legalmail.it"], "mbox.cert.legalmail.it", "sendm.cert.legalmail.it"],
  ["namirial", "Namirial", ["sicurezzapostale.it", "pecavvocati.it", "pec.commercialisti.it", "mypcert.it"], "imaps.sicurezzapostale.it", "smtps.sicurezzapostale.it"],
  ["postecert", "Poste Italiane (Postecert)", ["postecert.it"], "mail.postecert.it", "mail.postecert.it"],
  ["postecertifica", "Poste Italiane (Postecertifica)", ["postecertifica.it"], "mail.postecertifica.it", "mail.postecertifica.it"],
  ["register", "Register PEC", ["registerpec.it", "pec-mail.it", "dadapec.com"], "imap.pec-email.com", "smtp.pec-email.com"],
  ["actalis", "Actalis", ["pec.actalis.it", "actaliscertymail.it"], "imap.pec.actalis.it", "smtp.pec.actalis.it"],
  ["libero", "Libero PEC", ["pec.libero.it"], "mail.postacert.it.net", "mail.postacert.it.net"],
  ["tim", "TIM PEC", ["timpec.it", "pec.telecomitalia.it"], "imap.pectim.it", "smtp.pectim.it"],
].map(([id, nome, domini, imap, smtp]) => ({ id, nome, domini, imap: { host: imap, port: 993, sec: "ssl" }, smtp: { host: smtp, port: 465, sec: "ssl" }, pec: true }));
const COMMON = [
  ["gmail", "Gmail", ["gmail.com", "googlemail.com"], "imap.gmail.com", "smtp.gmail.com", 465, "ssl", { salva_inviati: false, nota: "mm.nota_gmail" }],
  ["libero_mail", "Libero Mail", ["libero.it", "inwind.it", "blu.it", "iol.it", "giallo.it"], "imapmail.libero.it", "smtp.libero.it", 465, "ssl"],
  ["virgilio", "Virgilio", ["virgilio.it"], "in.virgilio.it", "out.virgilio.it", 465, "ssl"],
  ["tim_mail", "TIM Mail", ["tim.it", "alice.it", "tin.it"], "imap.tim.it", "smtp.tim.it", 465, "ssl"],
  ["tiscali", "Tiscali", ["tiscali.it"], "imap.tiscali.it", "smtp.tiscali.it", 465, "ssl"],
  ["yahoo", "Yahoo Mail", ["yahoo.com", "yahoo.it", "ymail.com"], "imap.mail.yahoo.com", "smtp.mail.yahoo.com", 465, "ssl", { nota: "mm.nota_password_app" }],
  ["icloud", "iCloud Mail", ["icloud.com", "me.com", "mac.com"], "imap.mail.me.com", "smtp.mail.me.com", 587, "starttls", { nota: "mm.nota_password_app" }],
].map(([id, nome, domini, imap, smtp, sp, ss, extra = {}]) => ({ id, nome, domini, imap: { host: imap, port: 993, sec: "ssl" }, smtp: { host: smtp, port: sp, sec: ss }, ...extra }));
// Microsoft (Outlook.com, Microsoft 365) accetta solo l'accesso Microsoft (OAuth): sul telefono non ancora
const MICROSOFT = ["outlook.com", "hotmail.com", "hotmail.it", "live.com", "live.it", "msn.com", "outlook.it"];
export const PRESETS = [...PEC, ...COMMON];

// configurazione proposta per un indirizzo: gestore noto, oppure i nomi tipici del dominio (modificabili)
export function guess(email) {
  const dom = (email.split("@")[1] || "").toLowerCase();
  if (MICROSOFT.includes(dom)) return { microsoft: true };
  const p = PRESETS.find(x => x.domini.includes(dom));
  if (p) return { preset: p.id, nome: p.nome, pec: !!p.pec, imap: { ...p.imap }, smtp: { ...p.smtp }, salva_inviati: p.salva_inviati !== false, nota: p.nota || null };
  const pec = /(^|\.)pec\./.test(dom) || dom.startsWith("pec");
  return { preset: null, nome: dom, pec, imap: { host: "imap." + dom, port: 993, sec: "ssl" }, smtp: { host: "smtp." + dom, port: 465, sec: "ssl" }, salva_inviati: true, ipotesi: true };
}

// ------------------------------------------------------------------ archivio nel telefono
const DB = "mbv-posta";
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("kv");
      d.createObjectStore("accounts", { keyPath: "id" });
      const m = d.createObjectStore("msgs", { keyPath: "k" }); // k = account|cartella|uid
      m.createIndex("box", "box");
      d.createObjectStore("bodies"); // k -> Blob del messaggio completo
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const x = d.transaction(store, mode);
    const out = fn(x.objectStore(store));
    x.oncomplete = () => res(out && "result" in out ? out.result : out);
    x.onerror = () => rej(x.error);
  });
}
export const kvGet = k => tx("kv", "readonly", s => s.get(k));
export const kvSet = (k, v) => tx("kv", "readwrite", s => s.put(v, k));
export const accounts = async () => (await tx("accounts", "readonly", s => s.getAll())).sort((a, b) => a.ord - b.ord);
export const saveAccount = a => tx("accounts", "readwrite", s => s.put(a));
export async function removeAccount(id) {
  await tx("accounts", "readwrite", s => s.delete(id));
  const d = await db();
  await new Promise(res => { const x = d.transaction(["msgs", "bodies"], "readwrite"); const m = x.objectStore("msgs"), b = x.objectStore("bodies");
    m.openCursor().onsuccess = e => { const c = e.target.result; if (!c) return; if (c.key.startsWith(id + "|")) { c.delete(); b.delete(c.key); } c.continue(); }; x.oncomplete = res; });
}
export const boxMsgs = box => tx("msgs", "readonly", s => s.index("box").getAll(box));
export const putMsgs = list => tx("msgs", "readwrite", s => { for (const m of list) s.put(m); });
export const delMsgs = keys => tx("msgs", "readwrite", s => { for (const k of keys) s.delete(k); });
export const getBody = k => tx("bodies", "readonly", s => s.get(k));
export const putBody = (k, blob) => tx("bodies", "readwrite", s => s.put(blob, k));
export function wipe() { return new Promise(r => { try { const q = indexedDB.deleteDatabase(DB); q.onsuccess = q.onerror = q.onblocked = () => r(); } catch { r(); } }); }

// password cifrate: chiave AES-GCM non esportabile (resta nel dispositivo, non si puo' leggere nemmeno dall'app)
async function key() {
  let k = await kvGet("chiave");
  if (!k) { k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]); await kvSet("chiave", k); }
  return k;
}
export async function seal(text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv, data: new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), enc.encode(text))) };
}
export async function unseal(s) { return s ? dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: s.iv }, await key(), s.data)) : ""; }

// ------------------------------------------------------------------ passaggio IMAP/SMTP del server
export class MailError extends Error { constructor(msg, extra = {}) { super(msg); Object.assign(this, extra); } }
const b64 = u8 => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };

async function post(path, body) {
  let r;
  try { r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
  catch { throw new MailError(t("mm.err_rete"), { net: true }); }
  if (r.status === 401) throw new MailError(t("mm.err_licenza"));
  if (!r.ok) throw new MailError(t("mm.err_server", r.status));
  return r;
}
// passi IMAP: [{cmd, lit?: Uint8Array}] -> [{status, text, raw: Uint8Array}]
export async function imap(acc, steps) {
  const pass = await unseal(acc.secret);
  const r = await post("/v1/mail/imap", { ...acc.imap, user: acc.imap.user || acc.email, pass, steps: steps.map(s => ({ cmd: s.cmd, lit: s.lit ? b64(s.lit) : undefined })) });
  const u = new Uint8Array(await r.arrayBuffer());
  const nl = u.indexOf(10);
  const head = JSON.parse(dec.decode(u.subarray(0, nl)));
  if (!head.ok) throw new MailError(head.auth ? t("mm.err_accesso", head.errore || "") : friendly(head.errore), { auth: !!head.auth });
  let p = nl + 1;
  for (const x of head.results) { x.raw = u.subarray(p, p + x.len); p += x.len; }
  return head.results;
}
export async function smtp(acc, from, to, data) {
  const pass = await unseal(acc.secret);
  const r = await post("/v1/mail/smtp", { ...acc.smtp, user: acc.smtp.user || acc.imap.user || acc.email, pass, from, to, data: b64(data) });
  const j = await r.json();
  if (!j.ok) throw new MailError(j.auth ? t("mm.err_accesso_smtp", j.errore || "") : t("mm.err_invio", friendly(j.errore)), { auth: !!j.auth });
}
function friendly(e = "") {
  if (/tempo scaduto/i.test(e)) return t("mm.err_tempo");
  if (/server non valido|ENOTFOUND|getaddrinfo|resolve/i.test(e)) return t("mm.err_server_nome");
  if (/porta non permessa/i.test(e)) return t("mm.err_porta");
  return e || t("mm.err_generico");
}

// ------------------------------------------------------------------ risposte IMAP
// analizza le risposte non etichettate: ogni elemento = { tipo: "LIST"|"FETCH"|"SEARCH"|..., n?, dati: [token...] }
// token: stringa (atomo o testo), Uint8Array (letterale), array (lista tra parentesi), null (NIL)
export function parseResponses(raw) {
  const out = [];
  let i = 0;
  const N = raw.length;
  const ws = () => { while (i < N && raw[i] === 32) i++; };
  const token = () => {
    ws();
    const c = raw[i];
    if (c === 40) { i++; const list = []; for (;;) { ws(); if (raw[i] === 41) { i++; return list; } if (i >= N || raw[i] === 13 || raw[i] === 10) return list; list.push(token()); } }
    if (c === 34) { // stringa tra virgolette
      i++; const bytes = [];
      while (i < N && raw[i] !== 34) { if (raw[i] === 92) i++; bytes.push(raw[i++]); }
      i++; return dec.decode(new Uint8Array(bytes));
    }
    if (c === 123) { // letterale {n}
      let j = i + 1, n = 0; while (raw[j] >= 48 && raw[j] <= 57) n = n * 10 + raw[j++] - 48;
      while (raw[j] !== 10) j++;
      const lit = raw.subarray(j + 1, j + 1 + n); i = j + 1 + n; return lit;
    }
    // atomo (anche BODY[HEADER.FIELDS (A B)] con le parentesi quadre)
    const s = i; let depth = 0;
    while (i < N) { const ch = raw[i]; if (ch === 91) depth++; else if (ch === 93) depth--; else if (depth <= 0 && (ch === 32 || ch === 40 || ch === 41 || ch === 13 || ch === 10)) break; i++; }
    const a = dec.decode(raw.subarray(s, i));
    return a === "NIL" ? null : a;
  };
  while (i < N) {
    if (raw[i] !== 42) { while (i < N && raw[i] !== 10) i++; i++; continue; } // non "* "
    i += 2;
    const first = token();
    let rec;
    if (/^\d+$/.test(first)) { const kind = token(); rec = { tipo: String(kind).toUpperCase(), n: +first, dati: [] }; }
    else rec = { tipo: String(first).toUpperCase(), dati: [] };
    while (i < N && raw[i] !== 13 && raw[i] !== 10) { const before = i; rec.dati.push(token()); if (i === before) i++; }
    while (i < N && (raw[i] === 13 || raw[i] === 10)) i++;
    out.push(rec);
  }
  return out;
}
// coppie chiave/valore di un FETCH
export function fetchMap(list) { const m = {}; for (let i = 0; i + 1 < list.length; i += 2) m[String(list[i]).toUpperCase().replace(/\.PEEK/, "")] = list[i + 1]; return m; }

// nomi delle cartelle in UTF-7 modificato (RFC 3501)
export function utf7Decode(s) {
  return s.replace(/&([^-]*)-/g, (m, b) => {
    if (!b) return "&";
    const bin = atob(b.replace(/,/g, "/").padEnd(Math.ceil(b.length / 4) * 4, "="));
    let r = ""; for (let i = 0; i + 1 < bin.length; i += 2) r += String.fromCharCode((bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1));
    return r;
  });
}
export function utf7Encode(s) {
  return s.replace(/&/g, "&-").replace(/[^\x20-\x7e]+/g, m => {
    let bin = ""; for (const ch of m) { const c = ch.charCodeAt(0); bin += String.fromCharCode(c >> 8, c & 255); }
    return "&" + btoa(bin).replace(/=+$/, "").replace(/\//g, ",") + "-";
  });
}
export const q = s => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

// cartelle: ruoli dagli attributi SPECIAL-USE o dai nomi
const ROLE_NAMES = { inbox: /^inbox$/i, sent: /^(sent|inviat|posta inviata|sent items|sent messages|elementi inviati)/i, drafts: /^(draft|bozz)/i,
  trash: /^(trash|cestino|deleted|posta eliminata|elementi eliminati|bin)/i, junk: /^(junk|spam|posta indesiderata)/i, archive: /^(archiv)/i };
export function parseFolders(results) {
  const out = [];
  for (const r of parseResponses(results)) {
    if (r.tipo !== "LIST") continue;
    const [flags, delim, nameTok] = r.dati;
    const name = nameTok instanceof Uint8Array ? dec.decode(nameTok) : String(nameTok);
    const fl = (flags || []).map(f => String(f).toLowerCase());
    if (fl.includes("\\noselect") || fl.includes("\\nonexistent")) continue;
    const leaf = utf7Decode(name).split(delim || "/").pop();
    let role = ["sent", "drafts", "trash", "junk", "archive"].find(x => fl.includes("\\" + x)) || null;
    if (!role && name.toUpperCase() === "INBOX") role = "inbox";
    if (!role) role = Object.keys(ROLE_NAMES).find(k => ROLE_NAMES[k].test(leaf)) || null;
    out.push({ name, label: name.toUpperCase() === "INBOX" ? t("mm.posta_arrivo") : utf7Decode(name).replace(/^INBOX[./]/i, ""), role, depth: delim ? utf7Decode(name).split(delim).length - 1 : 0 });
  }
  const order = { inbox: 0, drafts: 1, sent: 2, archive: 3, junk: 4, trash: 5 };
  return out.sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || a.label.localeCompare(b.label));
}

// intestazioni grezze -> oggetto (decodifica RFC 2047)
export async function headers(bytes) {
  const { decodeWords } = await postal();
  const text = dec.decode(bytes).replace(/\r?\n[ \t]+/g, " ");
  const h = {};
  for (const line of text.split(/\r?\n/)) { const m = /^([^:\s]+):\s*(.*)$/.exec(line); if (m) h[m[1].toLowerCase()] = decodeWords(m[2]); }
  return h;
}
export async function addresses(v) { const { addressParser } = await postal(); try { return addressParser(v || "").flatMap(a => a.group ? a.group : [a]).filter(a => a.address); } catch { return []; } }

// ------------------------------------------------------------------ PEC (ricevute e buste di trasporto)
export const RICEVUTE = ["accettazione", "non-accettazione", "presa-in-carico", "avvenuta-consegna", "errore-consegna", "preavviso-errore-consegna", "rilevazione-virus"];
export function pecKind(h) {
  if (h["x-ricevuta"]) return { ricevuta: h["x-ricevuta"].trim().toLowerCase(), ok: !/non-|errore|virus/.test(h["x-ricevuta"]) };
  if (/posta-certificata/i.test(h["x-trasporto"] || "")) return { busta: true };
  if (/errore/i.test(h["x-trasporto"] || "")) return { busta: true, anomalia: true };
  return null;
}

// ------------------------------------------------------------------ messaggi da spedire (MIME)
const encWord = s => /^[\x20-\x7e]*$/.test(s) ? s : "=?UTF-8?B?" + b64(enc.encode(s)) + "?=";
const addrHeader = list => list.map(a => (a.name ? `${/^[\w .-]*$/.test(a.name) ? a.name : encWord(a.name)} <${a.address}>` : a.address)).join(", ");
const wrap76 = s => s.replace(/.{1,76}/g, "$&\r\n");
const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export function textToHtml(text) { return `<div style="font-family:Arial,sans-serif;font-size:14px">${esc(text).replace(/\r?\n/g, "<br>")}</div>`; }
// msg: { from:{name,address}, to:[], cc:[], bcc:[], subject, text, html?, inReplyTo?, references?, attachments:[{name,type,data:Uint8Array}] }
export function buildMime(msg) {
  const bnd = () => "mbv-" + crypto.getRandomValues(new Uint32Array(3)).join("-");
  const dom = (msg.from.address.split("@")[1] || "mbvisual");
  const id = `<${Date.now().toString(36)}.${crypto.getRandomValues(new Uint32Array(2)).join("")}@${dom}>`;
  const H = [`From: ${addrHeader([msg.from])}`, msg.to.length ? `To: ${addrHeader(msg.to)}` : null, msg.cc?.length ? `Cc: ${addrHeader(msg.cc)}` : null,
    `Subject: ${encWord(msg.subject || "")}`, `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`, `Message-ID: ${id}`,
    msg.inReplyTo ? `In-Reply-To: ${msg.inReplyTo}` : null, msg.references ? `References: ${msg.references}` : null, "MIME-Version: 1.0", "X-Mailer: MB Visual"].filter(Boolean);
  const alt = bnd();
  const textPart = `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(enc.encode(msg.text || "")))}`;
  const htmlPart = `Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(enc.encode(msg.html || textToHtml(msg.text || ""))))}`;
  const body = `Content-Type: multipart/alternative; boundary="${alt}"\r\n\r\n--${alt}\r\n${textPart}\r\n--${alt}\r\n${htmlPart}\r\n--${alt}--\r\n`;
  let out;
  if (msg.attachments?.length) {
    const mix = bnd();
    const atts = msg.attachments.map(a => {
      const fn = /^[\x20-\x7e]*$/.test(a.name) ? `filename="${a.name.replace(/"/g, "")}"` : `filename*=UTF-8''${encodeURIComponent(a.name)}`;
      return `--${mix}\r\nContent-Type: ${a.type || "application/octet-stream"}; name="${encWord(a.name).replace(/"/g, "")}"\r\nContent-Disposition: attachment; ${fn}\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(a.data))}`;
    }).join("\r\n");
    out = `${H.join("\r\n")}\r\nContent-Type: multipart/mixed; boundary="${mix}"\r\n\r\n--${mix}\r\n${body}\r\n${atts}\r\n--${mix}--\r\n`;
  } else out = `${H.join("\r\n")}\r\n${body}`;
  return { raw: enc.encode(out), id };
}
// per DATA di SMTP: righe che iniziano con "." raddoppiate (il passaggio aggiunge solo il punto finale)
export const dotStuff = raw => enc.encode(dec.decode(raw).replace(/\r?\n/g, "\r\n").replace(/(^|\r\n)\./g, "$1.."));
