// Server delle licenze di MB Visual (Cloudflare Worker + D1).
// Attivazioni firmate Ed25519 con la chiave privata del proprietario (segreto SIGNING_KEY): l'app per PC e
// l'app per cellulare verificano la firma con la chiave pubblica incorporata e funzionano offline fino a "exp".
//
// Pubblico:  POST /v1/activate  {key, device, kind:"pc"|"mobile", name, version}   -> {token}
//            POST /v1/check     {token}                                            -> {token} o {stato, errore}
//            POST /v1/account   {token}                                            -> licenza, dispositivi, richieste
//            POST /v1/request   {token | key+device, type:"change"|"report", message, name}
//            POST /v1/mlink     {token del PC} -> link monouso per il QR (liberi, attesa_fino)   GET /l/<link> pagina del telefono
//            POST /v1/mlink/claim {link, device, name}   POST /v1/mlink/pair {code, device, name}
//            POST /v1/stats {inst, days}   POST /v1/stats/forget {inst}   statistiche d'uso anonime con consenso (src/stats.js)
// Gestione (Authorization: Bearer ADMIN_TOKEN):
//            GET  /admin/summary, /admin/licenses, /admin/requests, /admin/events?after=ID, /admin/usage?giorni=30   POST /admin/usage/forget {inst}
//            POST /admin/licenses {customer,email,notes,max_pc,max_mobile,expires}
//            POST /admin/licenses/:key/(revoke|reactivate|update)   POST /admin/devices/:id/revoke
//            POST /admin/requests/:id/(approve|close)               POST /admin/events/read {upto}

import { adminApp, adminPath, newPairCode, notifyAdmins, pushFor } from "./adminapp.js";
import { postStats, forgetStats, usageSummary } from "./stats.js";
import { presentationPage, privacyPage } from "./pages.js";

const TOKEN_DAYS = 30;           // validita' offline di un'attivazione
const CHANGES_PER_YEAR = 3;      // cambi dispositivo automatici; oltre servono l'approvazione del proprietario
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // niente 0/O/1/I: chiavi facili da dettare

// ---------------------------------------------------------------- utilita'
const enc = new TextEncoder();
const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization" },
});
const fail = (status, errore, extra = {}) => json({ ok: false, errore, ...extra }, status);
const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);

function newKey() {
  const r = crypto.getRandomValues(new Uint8Array(20));
  const s = [...r].map(b => ALPHABET[b % 32]).join("");
  return `MBV-${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}-${s.slice(15, 20)}`;
}
const normKey = k => String(k || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^MBV/, "").replace(/(.{5})(?=.)/g, "$1-").replace(/^/, "MBV-");

let _sk = null;
async function signingKey(env) {
  if (!_sk) _sk = await crypto.subtle.importKey("pkcs8", unb64u(env.SIGNING_KEY), { name: "Ed25519" }, false, ["sign"]);
  return _sk;
}
let _pk = null;
async function publicKey(env) {
  if (!_pk) _pk = await crypto.subtle.importKey("raw", unb64u(env.PUBLIC_KEY), { name: "Ed25519" }, false, ["verify"]);
  return _pk;
}
async function makeToken(env, lic, dev) {
  const payload = { k: lic.key, d: dev.device, t: dev.kind, c: lic.customer, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + TOKEN_DAYS * 86400 };
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, await signingKey(env), enc.encode(body));
  return `${body}.${b64u(sig)}`;
}
// token firmato da noi, anche scaduto (serve a riconoscere il dispositivo quando torna online)
async function readToken(env, token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, await publicKey(env), unb64u(sig), enc.encode(body));
  if (!ok) return null;
  try { return JSON.parse(new TextDecoder().decode(unb64u(body))); } catch { return null; }
}
async function event(env, kind, key, text) {
  await env.DB.prepare("INSERT INTO events (kind, license_key, text) VALUES (?, ?, ?)").bind(kind, key || null, text).run();
  // notifica sui telefoni dell'app di gestione (dopo la risposta, senza rallentare chi attiva)
  const P = adminPath(env);
  if (P && env.VAPID_JWK && (await notifySettings(env))[kind] !== false) { const pr = notifyAdmins(env, pushFor(kind, text, "/" + P)).catch(() => {}); if (env._wait) env._wait(pr); else await pr; }
}
// notifiche scelte nell'app di gestione (PC e telefono): { tipo: false } = niente notifica (l'avviso resta nell'elenco)
const NOTIFY_KINDS = ["activation_pc", "activation_mobile", "change", "change_pending", "report", "expiring", "expired", "limit", "invalid_key", "revoked_use", "admin_login"];
async function notifySettings(env) {
  const r = await env.DB.prepare("SELECT value FROM admin_settings WHERE key = 'notifiche'").first();
  try { return r ? JSON.parse(r.value) : {}; } catch { return {}; }
}
// scadenza da un campo data (AAAA-MM-GG): vale fino alla fine di quel giorno
const normExpires = v => { const s = String(v || "").trim(); return !s ? null : /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + " 23:59:59" : s.replace("T", " ").slice(0, 19); };
// controllo giornaliero (cron): licenze in scadenza entro 15 giorni e scadute, un avviso per ciascuna
async function expiryCheck(env) {
  const soon = new Date(Date.now() + 15 * 86400000).toISOString().replace("T", " ").slice(0, 19);
  const lics = (await env.DB.prepare("SELECT * FROM licenses WHERE status = 'active' AND expires IS NOT NULL AND expires < ?").bind(soon).all()).results;
  for (const l of lics) {
    if (l.expires < now() && !l.warn_expired) {
      await env.DB.prepare("UPDATE licenses SET warn_expired = ? WHERE key = ?").bind(now(), l.key).run();
      await event(env, "expired", l.key, `Licenza scaduta il ${l.expires.slice(0, 10)}: ${l.customer || l.key}`);
    } else if (l.expires >= now() && !l.warn_expiring) {
      await env.DB.prepare("UPDATE licenses SET warn_expiring = ? WHERE key = ?").bind(now(), l.key).run();
      await event(env, "expiring", l.key, `Licenza in scadenza il ${l.expires.slice(0, 10)}: ${l.customer || l.key}`);
    }
  }
}
async function deleteLicense(env, key) {
  for (const sql of ["DELETE FROM devices WHERE license_key = ?", "DELETE FROM mobile_links WHERE license_key = ?", "DELETE FROM pair_codes WHERE license_key = ?",
    "DELETE FROM requests WHERE license_key = ?", "DELETE FROM licenses WHERE key = ?"]) await env.DB.prepare(sql).bind(key).run();
}
// testo preimpostato dell'email con la chiave (modificabile nell'app di gestione): {cliente} {chiave} {pc} {cellulari} {link_setup} {link_telefono}
const EMAIL_DEFAULT = { oggetto: "Licenza MB Visual",
  testo: "Buongiorno {cliente},\n\necco la chiave di licenza di MB Visual:\n\n{chiave}\n\n" +
    "PC (Windows): scarica e installa MB Visual da {link_setup}\nAl primo avvio inserisci la chiave.\n\n" +
    "Telefono: apri {link_telefono} con Safari (iPhone) o Chrome (Android), aggiungi l'app alla schermata Home e inserisci la chiave. " +
    "In alternativa inquadra il codice QR nella home di MB Visual sul PC.\n\n" +
    "La licenza vale per {pc} PC e {cellulari} cellulari. Conserva questa email: la chiave serve anche per reinstallare.\n\nCordiali saluti" };
// installabile per PC: l'ultimo setup pubblicato, scaricato attraverso questo server (nell'indirizzo non compare nessun nome)
async function setupDownload(env, req) {
  const repo = env.RELEASES_REPO || "";
  if (!repo) return fail(404, "Installabile non disponibile");
  const rel = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { "user-agent": "MBVisual-Server", accept: "application/vnd.github+json" }, cf: { cacheTtl: 600 } }).then(r => r.ok ? r.json() : null).catch(() => null);
  const asset = rel?.assets?.find(a => /setup.*\.exe$/i.test(a.name)) || rel?.assets?.find(a => /\.exe$/i.test(a.name));
  if (!asset) return fail(503, "Installabile non disponibile al momento: riprova tra qualche minuto");
  const r = await fetch(asset.browser_download_url, { headers: { "user-agent": "MBVisual-Server" }, redirect: "follow" });
  if (!r.ok || !r.body) return fail(502, "Download non riuscito: riprova tra qualche minuto");
  return new Response(r.body, { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${asset.name.replace(/[^A-Za-z0-9._-]/g, "")}"`,
    ...(r.headers.get("content-length") ? { "content-length": r.headers.get("content-length") } : {}), "cache-control": "no-store" } });
}
const getLicense = (env, key) => env.DB.prepare("SELECT * FROM licenses WHERE key = ?").bind(key).first();
function licenseProblem(lic) {
  if (!lic) return [404, "Chiave di licenza non valida"];
  if (lic.status === "replaced") return [410, "Questa chiave e' stata sostituita da un cambio dispositivo: inserisci la chiave nuova", { stato: "sostituita" }];
  if (lic.status === "revoked") return [403, "Licenza revocata. Contatta MB Engineering.", { stato: "revocata" }];
  if (lic.expires && lic.expires < now()) return [403, "Licenza scaduta. Contatta MB Engineering.", { stato: "scaduta" }];
  return null;
}

// ---------------------------------------------------------------- pubblico
async function activate(env, b) {
  const key = normKey(b.key), kind = b.kind === "mobile" ? "mobile" : "pc", device = String(b.device || "").slice(0, 128);
  if (!device) return fail(400, "Dispositivo non riconosciuto");
  const lic = await getLicense(env, key);
  const p = licenseProblem(lic);
  if (p) { await event(env, "invalid_key", key, `Tentativo di attivazione con chiave ${p[2]?.stato || "non valida"}: ${key} (${b.name || kind})`); return fail(p[0], p[1], p[2]); }
  let dev = await env.DB.prepare("SELECT * FROM devices WHERE license_key = ? AND device = ? AND kind = ? AND status = 'active'").bind(key, device, kind).first();
  if (!dev) {
    const max = kind === "pc" ? lic.max_pc : lic.max_mobile;
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE license_key = ? AND kind = ? AND status = 'active'").bind(key, kind).first();
    if (n >= max) {
      await event(env, "limit", key, `Limite ${kind === "pc" ? "PC" : "cellulari"} raggiunto per ${lic.customer || key}: tentativo da "${b.name || "dispositivo"}"`);
      return fail(409, kind === "pc" ? "Questa licenza e' gia' attiva su un altro PC." : `Questa licenza e' gia' attiva su ${max} cellulari.`,
        { stato: "limite", suggerimento: "Se hai cambiato dispositivo usa \"Cambio dispositivo\": verra' generata una chiave nuova." });
    }
    await env.DB.prepare("INSERT INTO devices (license_key, kind, device, name, version) VALUES (?, ?, ?, ?, ?)").bind(key, kind, device, String(b.name || "").slice(0, 80), String(b.version || "")).run();
    dev = await env.DB.prepare("SELECT * FROM devices WHERE license_key = ? AND device = ? AND kind = ? AND status = 'active'").bind(key, device, kind).first();
    await event(env, kind === "pc" ? "activation_pc" : "activation_mobile", key, `Attivato ${kind === "pc" ? "PC" : "cellulare"} "${dev.name}" per ${lic.customer || key}`);
  }
  return json({ ok: true, token: await makeToken(env, lic, dev), cliente: lic.customer });
}

async function deviceFromToken(env, token) {
  const t = await readToken(env, token);
  if (!t) return [null, null, fail(401, "Attivazione non valida")];
  const lic = await getLicense(env, t.k);
  const p = licenseProblem(lic);
  if (p) return [lic, null, fail(p[0], p[1], p[2])];
  const dev = await env.DB.prepare("SELECT * FROM devices WHERE license_key = ? AND device = ? AND kind = ?").bind(t.k, t.d, t.t).first();
  if (!dev || dev.status !== "active") return [lic, null, fail(403, "Questo dispositivo non e' piu' attivo su questa licenza.", { stato: "dispositivo_revocato" })];
  return [lic, dev, null];
}

async function check(env, b) {
  const [lic, dev, err] = await deviceFromToken(env, b.token);
  if (err) {
    if (lic) await event(env, "revoked_use", lic.key, `Uso di una licenza non piu' valida (${lic.status}) da parte di ${lic.customer || lic.key}`);
    return err;
  }
  await env.DB.prepare("UPDATE devices SET last_seen = datetime('now'), version = ? WHERE id = ?").bind(String(b.version || dev.version), dev.id).run();
  return json({ ok: true, token: await makeToken(env, lic, dev) });
}

async function account(env, b) {
  const [lic, dev, err] = await deviceFromToken(env, b.token);
  if (err) return err;
  const devs = (await env.DB.prepare("SELECT id, kind, name, activated, last_seen FROM devices WHERE license_key = ? AND status = 'active' ORDER BY kind, id").bind(lic.key).all()).results;
  const reqs = (await env.DB.prepare("SELECT id, type, message, status, new_key, created FROM requests WHERE root = ? ORDER BY id DESC LIMIT 20").bind(lic.root).all()).results;
  const used = await changesLastYear(env, lic.root);
  return json({ ok: true, cliente: lic.customer, email: lic.email, chiave: lic.key, pc: lic.max_pc, cellulari: lic.max_mobile, scadenza: lic.expires,
    dispositivi: devs.map(d => ({ ...d, questo: d.id === dev.id })), richieste: reqs, cambi_rimasti: Math.max(0, CHANGES_PER_YEAR - used) });
}

async function changesLastYear(env, root) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM requests WHERE root = ? AND type = 'change' AND status = 'done' AND created > datetime('now', '-365 days')").bind(root).first();
  return r.n;
}
// cambio dispositivo: chiave nuova con gli stessi dati, la vecchia sostituita (i suoi dispositivi smettono di funzionare)
async function replaceKey(env, lic) {
  const key = newKey();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO licenses (key, root, customer, email, notes, max_pc, max_mobile, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(key, lic.root, lic.customer, lic.email, lic.notes, lic.max_pc, lic.max_mobile, lic.expires),
    env.DB.prepare("UPDATE licenses SET status = 'replaced', replaced_by = ? WHERE key = ?").bind(key, lic.key),
    env.DB.prepare("UPDATE devices SET status = 'revoked' WHERE license_key = ?").bind(lic.key),
  ]);
  return key;
}

async function request(env, b) {
  // chi ha un'app attivata usa il token; chi ha perso il dispositivo puo' usare la chiave dalla schermata di attivazione
  let lic;
  if (b.token) { const r = await deviceFromToken(env, b.token); if (r[2]) return r[2]; lic = r[0]; }
  else { lic = await getLicense(env, normKey(b.key)); const p = licenseProblem(lic); if (p) return fail(p[0], p[1], p[2]); }
  const type = b.type === "change" ? "change" : "report";
  const msg = String(b.message || "").slice(0, 4000), name = String(b.name || "").slice(0, 80);
  if (type === "report") {
    await env.DB.prepare("INSERT INTO requests (license_key, root, type, message, device_name) VALUES (?, ?, 'report', ?, ?)").bind(lic.key, lic.root, msg, name).run();
    await event(env, "report", lic.key, `Segnalazione da ${lic.customer || lic.key}: ${msg.slice(0, 160)}`);
    return json({ ok: true, messaggio: "Segnalazione inviata. Ti risponderemo al piu' presto." });
  }
  if (await changesLastYear(env, lic.root) >= CHANGES_PER_YEAR) {
    await env.DB.prepare("INSERT INTO requests (license_key, root, type, message, device_name, status) VALUES (?, ?, 'change', ?, ?, 'pending')").bind(lic.key, lic.root, msg, name).run();
    await event(env, "change_pending", lic.key, `Cambio dispositivo IN ATTESA di approvazione (limite annuo raggiunto): ${lic.customer || lic.key}`);
    return json({ ok: true, in_attesa: true, messaggio: "Hai raggiunto il numero massimo di cambi automatici dell'anno: la richiesta e' stata inviata e verra' approvata a breve." });
  }
  const key = await replaceKey(env, lic);
  await env.DB.prepare("INSERT INTO requests (license_key, root, type, message, device_name, status, new_key) VALUES (?, ?, 'change', ?, ?, 'done', ?)").bind(lic.key, lic.root, msg, name, key).run();
  await event(env, "change", key, `Cambio dispositivo per ${lic.customer || lic.key}: nuova chiave ${key} (la vecchia ${lic.key} non funziona piu')`);
  return json({ ok: true, nuova_chiave: key, messaggio: "Nuova chiave generata. La chiave precedente non funziona piu': inseriscila nei dispositivi che continui a usare." });
}

// ---------------------------------------------------------------- gestione
// sub: percorso gia' autorizzato dall'app per telefono (adminapp.js); senza: serve il codice di gestione (app per PC)
async function admin(env, req, url, sub) {
  if (sub === undefined && (req.headers.get("authorization") || "") !== `Bearer ${env.ADMIN_TOKEN}`) return fail(401, "Non autorizzato");
  const p = (sub ?? url.pathname.replace(/^\/admin\/?/, "")).split("/");
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const all = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results;
  if (p[0] === "settings") {
    const put = (k, v) => env.DB.prepare("INSERT INTO admin_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, JSON.stringify(v)).run();
    if (req.method === "POST" && body.notifiche) {
      const n = {};
      for (const k of NOTIFY_KINDS) if (body.notifiche[k] === false) n[k] = false;
      await put("notifiche", n);
    }
    if (req.method === "POST" && body.email) await put("email", { oggetto: String(body.email.oggetto || "").slice(0, 300), testo: String(body.email.testo || "").slice(0, 8000) });
    const n = await notifySettings(env);
    const em = await env.DB.prepare("SELECT value FROM admin_settings WHERE key = 'email'").first();
    let email = null; try { email = em ? JSON.parse(em.value) : null; } catch {}
    return json({ ok: true, tipi: NOTIFY_KINDS, notifiche: Object.fromEntries(NOTIFY_KINDS.map(k => [k, n[k] !== false])),
      email: email?.testo ? email : EMAIL_DEFAULT, email_predefinita: EMAIL_DEFAULT, link_setup: `${url.origin}/scarica`, link_telefono: `${url.origin}/` });
  }
  if (p[0] === "pair" && req.method === "POST") return json(await newPairCode(env, url.origin)); // codice di 6 cifre per collegare il telefono
  // statistiche d'uso anonime (src/stats.js): riepilogo e cancellazione su richiesta dell'utente (identificativo dalle sue impostazioni)
  if (p[0] === "usage" && p[1] === "forget" && req.method === "POST") return forgetStats(env, { inst: String(body.inst || "").trim().toLowerCase() }, json, fail);
  if (p[0] === "usage") return usageSummary(env, url, json);
  if (p[0] === "summary") {
    const one = async sql => (await env.DB.prepare(sql).first()).n;
    return json({ ok: true, licenze: await one("SELECT COUNT(*) n FROM licenses WHERE status='active'"), pc: await one("SELECT COUNT(*) n FROM devices WHERE status='active' AND kind='pc'"),
      cellulari: await one("SELECT COUNT(*) n FROM devices WHERE status='active' AND kind='mobile'"), richieste_aperte: await one("SELECT COUNT(*) n FROM requests WHERE status IN ('open','pending')"),
      avvisi_non_letti: await one("SELECT COUNT(*) n FROM events WHERE read=0 AND archived=0") });
  }
  if (p[0] === "licenses" && !p[1]) {
    if (req.method === "POST") {
      const key = newKey();
      await env.DB.prepare("INSERT INTO licenses (key, root, customer, email, notes, max_pc, max_mobile, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(key, key, String(body.customer || ""), String(body.email || ""), String(body.notes || ""), Math.max(1, +body.max_pc || 1), Math.max(0, +(body.max_mobile ?? 2)), normExpires(body.expires)).run();
      return json({ ok: true, key });
    }
    const lics = await all("SELECT * FROM licenses ORDER BY created DESC");
    const devs = await all("SELECT * FROM devices ORDER BY id");
    return json({ ok: true, licenze: lics.map(l => { const d = devs.filter(x => x.license_key === l.key);
      return { ...l, dispositivi: d, prima_attivazione: d.reduce((m, x) => (!m || x.activated < m ? x.activated : m), null) }; }) });
  }
  // eliminazione: la licenza sparisce dall'elenco e i suoi dispositivi smettono di funzionare (gli avvisi restano)
  if (p[0] === "licenses" && p[1] === "delete" && req.method === "POST") {
    const keys = (Array.isArray(body.keys) ? body.keys : []).map(String).slice(0, 500);
    for (const k of keys) await deleteLicense(env, k);
    return json({ ok: true, eliminate: keys.length });
  }
  if (p[0] === "licenses" && p[1]) {
    const key = decodeURIComponent(p[1]);
    if (p[2] === "revoke") await env.DB.prepare("UPDATE licenses SET status='revoked' WHERE key=?").bind(key).run();
    else if (p[2] === "reactivate") await env.DB.prepare("UPDATE licenses SET status='active' WHERE key=? AND status='revoked'").bind(key).run();
    else if (p[2] === "update") {
      // numero di PC e cellulari modificabile anche con la licenza in uso: aumentare libera subito posti nuovi; diminuire sotto i
      // dispositivi attivi richiede di scegliere quali disattivare (free = id dei dispositivi), altrimenti 409 con i conteggi
      const lic = await getLicense(env, key);
      if (!lic) return fail(404, "Licenza inesistente");
      const maxPc = Math.max(1, +body.max_pc || 1), maxMob = Math.max(0, +(body.max_mobile ?? lic.max_mobile));
      const free = new Set((Array.isArray(body.free) ? body.free : []).map(Number));
      const devs = (await env.DB.prepare("SELECT id, kind FROM devices WHERE license_key = ? AND status = 'active'").bind(key).all()).results;
      const left = k => devs.filter(d => d.kind === k && !free.has(d.id)).length;
      if (left("pc") > maxPc || left("mobile") > maxMob)
        return fail(409, `Troppi dispositivi attivi per i nuovi limiti: scegli quali disattivare (PC attivi ${left("pc")} su ${maxPc}, cellulari attivi ${left("mobile")} su ${maxMob}).`,
          { stato: "troppi_dispositivi", pc_attivi: left("pc"), cellulari_attivi: left("mobile") });
      for (const d of devs) if (free.has(d.id)) await env.DB.prepare("UPDATE devices SET status='revoked' WHERE id=?").bind(d.id).run();
      const exp = body.expires === undefined ? lic.expires : normExpires(body.expires);
      await env.DB.prepare("UPDATE licenses SET customer=?, email=?, notes=?, max_pc=?, max_mobile=?, expires=?, warn_expiring = CASE WHEN expires IS ? THEN warn_expiring END, warn_expired = CASE WHEN expires IS ? THEN warn_expired END WHERE key=?")
        .bind(String(body.customer ?? lic.customer), String(body.email ?? lic.email), String(body.notes ?? lic.notes), maxPc, maxMob, exp, exp, exp, key).run();
      return json({ ok: true, liberati: [...free].filter(id => devs.some(d => d.id === id)).length });
    }
    else if (p[2] === "delete") { await deleteLicense(env, key); return json({ ok: true, eliminate: 1 }); }
    else if (p[2] === "replace") { const lic = await getLicense(env, key); if (!lic) return fail(404, "Licenza inesistente"); return json({ ok: true, key: await replaceKey(env, lic) }); }
    else return fail(404, "Operazione sconosciuta");
    return json({ ok: true });
  }
  if (p[0] === "devices" && p[2] === "revoke") { await env.DB.prepare("UPDATE devices SET status='revoked' WHERE id=?").bind(+p[1]).run(); return json({ ok: true }); }
  if (p[0] === "requests" && !p[1]) return json({ ok: true, richieste: await all("SELECT r.*, l.customer FROM requests r LEFT JOIN licenses l ON l.key = r.license_key ORDER BY r.id DESC LIMIT 500") });
  if (p[0] === "requests" && p[1]) {
    const r = await env.DB.prepare("SELECT * FROM requests WHERE id=?").bind(+p[1]).first();
    if (!r) return fail(404, "Richiesta inesistente");
    if (p[2] === "approve" && r.type === "change" && r.status === "pending") {
      const lic = await getLicense(env, r.license_key);
      const cur = lic?.status === "replaced" ? await getLicense(env, lic.replaced_by) : lic; // nel frattempo potrebbe esserci gia' una chiave nuova
      const key = await replaceKey(env, cur);
      await env.DB.prepare("UPDATE requests SET status='done', new_key=? WHERE id=?").bind(key, r.id).run();
      return json({ ok: true, key });
    }
    if (p[2] === "close") { await env.DB.prepare("UPDATE requests SET status='closed' WHERE id=?").bind(r.id).run(); return json({ ok: true }); }
    return fail(400, "Operazione non possibile");
  }
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Number.isFinite).slice(0, 5000);
  const inIds = async (sql, ...a) => { for (let i = 0; i < ids.length; i += 90) { const part = ids.slice(i, i + 90); await env.DB.prepare(sql.replace("(?)", `(${part.map(() => "?").join(",")})`)).bind(...a, ...part).run(); } };
  if (p[0] === "events" && p[1] === "read") {
    if (ids.length) await inIds("UPDATE events SET read=1 WHERE id IN (?)");
    else await env.DB.prepare("UPDATE events SET read=1 WHERE id <= ?").bind(+body.upto || 0).run();
    return json({ ok: true });
  }
  if (p[0] === "events" && p[1] === "archive") { await inIds("UPDATE events SET archived=?, read=1 WHERE id IN (?)", body.archivia === false ? 0 : 1); return json({ ok: true }); }
  if (p[0] === "events") {
    const after = +(url.searchParams.get("after") || 0), arch = url.searchParams.get("archiviati") === "1";
    // after=0: gli ultimi 3000 (elenco della Panoramica); after>0: i nuovi in ordine (notifiche dell'app per PC)
    const rows = after ? await all("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT 500", after)
      : (await all(`SELECT * FROM events WHERE archived = ? ORDER BY id DESC LIMIT 3000`, arch ? 1 : 0)).reverse();
    return json({ ok: true, avvisi: rows });
  }
  return fail(404, "Percorso sconosciuto");
}

// ---------------------------------------------------------------- QR della home del PC: link monouso per i cellulari
// Il PC attivato chiede un link (/v1/mlink); il QR lo mostra. Il telefono che lo apre (/l/<link>) attiva un cellulare della
// licenza senza scrivere la chiave. Dopo ogni attivazione via link la licenza resta bloccata LOCK_MIN minuti: niente link
// nuovi e niente altre attivazioni via link (blocco con UPDATE condizionato: atomico anche con richieste contemporanee).
// iPhone: l'app installata dalla Home non vede i cookie di Safari -> codice di 6 cifre da inserire nell'app (stesso posto).
const LINK_MIN = 10, LOCK_MIN = 1, PAIR_MIN = 30;  // blocco tra due cellulari: 1 minuto (richiesta dell utente)
const minutesAgo = m => new Date(Date.now() - m * 60000).toISOString().replace("T", " ").slice(0, 19);
const minutesAhead = m => new Date(Date.now() + m * 60000).toISOString().replace("T", " ").slice(0, 19);
const activeMobiles = async (env, key) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE license_key = ? AND kind = 'mobile' AND status = 'active'").bind(key).first()).n;
const lockUntil = lic => (lic.mobile_lock && lic.mobile_lock > minutesAgo(LOCK_MIN) ? new Date(lic.mobile_lock.replace(" ", "T") + "Z").getTime() + LOCK_MIN * 60000 : 0);

async function mobileLink(env, b, origin) {
  const [lic, dev, err] = await deviceFromToken(env, b.token);
  if (err) return err;
  if (dev.kind !== "pc") return fail(403, "Solo il PC attivato puo' generare il codice QR");
  const free = Math.max(0, lic.max_mobile - await activeMobiles(env, lic.key));
  const res = { ok: true, liberi: free, totali: lic.max_mobile };
  if (!free) return json(res);
  const until = lockUntil(lic);
  if (until > Date.now()) return json({ ...res, attesa_fino: until });
  let link = await env.DB.prepare("SELECT token, expires FROM mobile_links WHERE license_key = ? AND used IS NULL AND expires > ? ORDER BY expires DESC LIMIT 1").bind(lic.key, minutesAhead(1)).first();
  if (!link) {
    link = { token: b64u(crypto.getRandomValues(new Uint8Array(24))), expires: minutesAhead(LINK_MIN) };
    await env.DB.prepare("INSERT INTO mobile_links (token, license_key, expires) VALUES (?, ?, ?)").bind(link.token, lic.key, link.expires).run();
  }
  return json({ ...res, url: `${origin}/l/${link.token}`, scade: new Date(link.expires.replace(" ", "T") + "Z").getTime() });
}

// browser che non possono installare l'app: su iPhone solo Safari (Chrome, Firefox, Edge, app Google e browser interni alle
// app non hanno "Aggiungi alla schermata Home" con la stessa memoria); su Android i browser interni alle app (WebView)
const wrongBrowser = ua => /iphone|ipad|ipod/i.test(ua) ? (/CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|FBAN|FBAV|Instagram|LinkedInApp|Snapchat|WhatsApp|Line\//i.test(ua) || !/Safari\//.test(ua))
  : /android/i.test(ua) && /; wv\)|FBAN|FBAV|Instagram|GSA\//i.test(ua);
const LINK_REUSE_MIN = 20; // dopo l'uso il link vale ancora per lo stesso telefono (altro browser o app installata): sposta il posto, non ne prende un altro

async function claimLink(env, b, ua = "") {
  const device = String(b.device || "").slice(0, 128), name = String(b.name || "Cellulare").slice(0, 80);
  if (!device) return fail(400, "Dispositivo non riconosciuto");
  // controllo prima di tutto: un browser sbagliato non consuma il link
  if (wrongBrowser(ua)) return fail(403, /iphone|ipad|ipod/i.test(ua) ? "Apri questo link in Safari." : "Apri questo link in Chrome.", { stato: "browser" });
  const link = await env.DB.prepare("SELECT * FROM mobile_links WHERE token = ?").bind(String(b.link || "")).first();
  if (!link) return fail(410, "Questo codice QR e' scaduto o e' gia' stato usato. Inquadra il codice aggiornato sul PC.", { stato: "link_scaduto" });
  const lic = await getLicense(env, link.license_key);
  const p = licenseProblem(lic);
  if (p) return fail(p[0], p[1], p[2]);
  // link gia' usato da poco: lo stesso telefono lo riapre in un altro browser -> il posto passa a questo browser
  if (link.used) {
    if (!link.device_id || link.used < minutesAgo(LINK_REUSE_MIN)) return fail(410, "Questo codice QR e' gia' stato usato. Inquadra il codice aggiornato sul PC.", { stato: "link_scaduto" });
    const prev = await env.DB.prepare("SELECT * FROM devices WHERE id = ? AND status = 'active'").bind(link.device_id).first();
    if (!prev) return fail(410, "Questo codice QR e' gia' stato usato. Inquadra il codice aggiornato sul PC.", { stato: "link_scaduto" });
    if (prev.device !== device) await env.DB.prepare("UPDATE devices SET device = ?, name = ?, last_seen = datetime('now') WHERE id = ?").bind(device, name, prev.id).run();
    const dev = await env.DB.prepare("SELECT * FROM devices WHERE id = ?").bind(prev.id).first();
    return json({ ok: true, token: await makeToken(env, lic, dev), cliente: lic.customer, codice: await mobilePairCode(env, lic, dev), codice_minuti: PAIR_MIN, gia_attivo: true });
  }
  if (link.expires < now()) return fail(410, "Questo codice QR e' scaduto. Inquadra il codice aggiornato sul PC.", { stato: "link_scaduto" });
  // stesso telefono gia' attivo su questa licenza: niente posto in piu'
  const again = await env.DB.prepare("SELECT * FROM devices WHERE license_key = ? AND device = ? AND kind = 'mobile' AND status = 'active'").bind(lic.key, device).first();
  if (again) return json({ ok: true, token: await makeToken(env, lic, again), cliente: lic.customer, gia_attivo: true });
  if (await activeMobiles(env, lic.key) >= lic.max_mobile) return fail(409, `Questa licenza e' gia' attiva su ${lic.max_mobile} cellulari.`, { stato: "limite" });
  // blocco della licenza e consumo del link: aggiornamenti condizionati, vince una sola richiesta
  const stamp = now();
  const got = await env.DB.prepare("UPDATE licenses SET mobile_lock = ? WHERE key = ? AND (mobile_lock IS NULL OR mobile_lock < ?)").bind(stamp, lic.key, minutesAgo(LOCK_MIN)).run();
  if (!got.meta?.changes) return fail(429, "Un'altra installazione e' in corso: riprova tra un minuto.", { stato: "attesa" });
  // attivazione non avvenuta: il blocco preso qui si rilascia (solo se e' ancora il nostro)
  const release = () => env.DB.prepare("UPDATE licenses SET mobile_lock = NULL WHERE key = ? AND mobile_lock = ?").bind(lic.key, stamp).run();
  const used = await env.DB.prepare("UPDATE mobile_links SET used = ? WHERE token = ? AND used IS NULL").bind(now(), link.token).run();
  if (!used.meta?.changes) { await release(); return fail(410, "Questo codice QR e' gia' stato usato.", { stato: "link_scaduto" }); }
  if (await activeMobiles(env, lic.key) >= lic.max_mobile) { await release(); return fail(409, `Questa licenza e' gia' attiva su ${lic.max_mobile} cellulari.`, { stato: "limite" }); }
  await env.DB.prepare("INSERT INTO devices (license_key, kind, device, name) VALUES (?, 'mobile', ?, ?)").bind(lic.key, device, name).run();
  const dev = await env.DB.prepare("SELECT * FROM devices WHERE license_key = ? AND device = ? AND kind = 'mobile' AND status = 'active'").bind(lic.key, device).first();
  await env.DB.prepare("UPDATE mobile_links SET device_id = ? WHERE token = ?").bind(dev.id, link.token).run();
  const code = await mobilePairCode(env, lic, dev);
  await event(env, "activation_mobile", lic.key, `Attivato cellulare "${name}" dal codice QR per ${lic.customer || lic.key}`);
  return json({ ok: true, token: await makeToken(env, lic, dev), cliente: lic.customer, codice: code, codice_minuti: PAIR_MIN });
}
// codice di 6 cifre per l'app aggiunta alla schermata Home (su iPhone ha una memoria separata da Safari)
async function mobilePairCode(env, lic, dev) {
  for (let i = 0; i < 5; i++) {
    const c = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    const r = await env.DB.prepare("INSERT OR IGNORE INTO pair_codes (code, license_key, device_id, expires) VALUES (?, ?, ?, ?)").bind(c, lic.key, dev.id, minutesAhead(PAIR_MIN)).run();
    if (r.meta?.changes) return c;
  }
  return undefined;
}

async function pairCode(env, b) {
  const device = String(b.device || "").slice(0, 128);
  const row = await env.DB.prepare("SELECT * FROM pair_codes WHERE code = ?").bind(String(b.code || "").replace(/\D/g, "")).first();
  if (!device || !row || row.used || row.expires < now()) return fail(410, "Codice non valido o scaduto.", { stato: "codice_scaduto" });
  const lic = await getLicense(env, row.license_key);
  const p = licenseProblem(lic);
  if (p) return fail(p[0], p[1], p[2]);
  const used = await env.DB.prepare("UPDATE pair_codes SET used = ? WHERE code = ? AND used IS NULL").bind(now(), row.code).run();
  if (!used.meta?.changes) return fail(410, "Codice gia' usato.", { stato: "codice_scaduto" });
  // l'app installata prende il posto del browser che ha aperto il QR (stesso cellulare, nessun posto in piu')
  await env.DB.prepare("UPDATE devices SET device = ?, name = COALESCE(NULLIF(?, ''), name), last_seen = datetime('now') WHERE id = ? AND status = 'active'").bind(device, String(b.name || ""), row.device_id).run();
  const dev = await env.DB.prepare("SELECT * FROM devices WHERE id = ? AND status = 'active'").bind(row.device_id).first();
  if (!dev) return fail(403, "Questo cellulare non e' piu' attivo sulla licenza.", { stato: "dispositivo_revocato" });
  return json({ ok: true, token: await makeToken(env, lic, dev), cliente: lic.customer });
}

// iPad e iPhone: l'app si installa spesso da queste pagine (Condividi > Aggiungi alla schermata Home), quindi icone e
// schermate di avvio vanno dichiarate anche qui. STESSO elenco di SPLASH in tools/build_web.py (che genera le immagini).
const SPLASH = [[1032, 1376, 2], [1024, 1366, 2], [834, 1210, 2], [834, 1194, 2], [820, 1180, 2], [834, 1112, 2], [810, 1080, 2], [768, 1024, 2], [744, 1133, 2],
  [440, 956, 3], [430, 932, 3], [402, 874, 3], [393, 852, 3], [390, 844, 3], [428, 926, 3], [414, 896, 2], [375, 812, 3], [375, 667, 2]];
const APPLE_HEAD = `<link rel="apple-touch-icon" href="/img/apple-touch-icon-180.png"><link rel="apple-touch-icon" sizes="152x152" href="/img/apple-touch-icon-152.png">
<link rel="apple-touch-icon" sizes="167x167" href="/img/apple-touch-icon-167.png"><link rel="apple-touch-icon" sizes="180x180" href="/img/apple-touch-icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="MB Visual">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
` + SPLASH.flatMap(([w, h, r]) => [false, true].map(land => `<link rel="apple-touch-startup-image" media="(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${r}) and (orientation: ${land ? "landscape" : "portrait"})" href="/img/splash-${land ? h * r + "x" + w * r : w * r + "x" + h * r}.png">`)).join("\n");

const LINK_PAGE = `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f1114"><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/img/icon-192.png">
${APPLE_HEAD}<title>MB Visual</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#17191b;color:#e6e8e5;font:15px system-ui,"Segoe UI",sans-serif;padding:20px}
.box{width:min(440px,100%);text-align:center}img{width:110px;height:110px}h1{font-size:22px;margin:10px 0 6px}p{color:#9ea29b;line-height:1.45}
ol{text-align:left;color:#cfd2cc;line-height:1.6;padding-left:22px}.code{font:700 30px Consolas,monospace;letter-spacing:.18em;color:#f07d2e;margin:6px 0}
button,.btn{display:block;margin-top:14px;width:100%;padding:12px;border:0;border-radius:8px;background:#f07d2e;color:#16110c;font:600 16px system-ui;text-decoration:none}#copy{background:#2b3035;color:#e6e8e5}.err{color:#e0605a}.hide{display:none}</style></head>
<body><div class="box"><img src="/img/logo-512.png" alt="MB Visual"><h1>MB Visual</h1><p style="margin:-2px 0 12px;color:#8a8c89;font-size:13px;letter-spacing:.05em">Powered by MB Group</p><p id="msg">Attivazione in corso...</p>
<div id="ok" class="hide"><p>Dispositivo attivato. Ora installa l'app:</p><ol id="steps"></ol><button id="inst" class="hide">Installa l'app</button>
<div id="wrong" class="hide"><a id="open" class="hide btn" href="#">Apri in Safari</a><button id="copy" type="button">Copia link</button>
<ol><li>Tocca <b>Copia link</b>.</li><li>Apri <b id="wrong-app"></b>, tocca la barra degli indirizzi, incolla e vai.</li><li>Il link vale ancora qualche minuto.</li></ol></div>
<p id="pair" class="hide">Se l'app installata chiede di nuovo l'attivazione, inserisci questo codice (valido <span id="min"></span> minuti):</p><div class="code" id="code"></div></div></div>
<script>
const $ = id => document.getElementById(id), ipad = /ipad/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1), ios = /iphone|ipod/i.test(navigator.userAgent) || ipad;
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
let prompt = null;
addEventListener("beforeinstallprompt", e => { e.preventDefault(); prompt = e; $("inst").classList.remove("hide"); });
$("inst").onclick = () => prompt && prompt.prompt();
const ua = navigator.userAgent;
// browser che non puo' installare l'app: il link NON si usa qui (resta valido per Safari / Chrome)
const wrong = ios ? (/CriOS|FxiOS|EdgiOS|OPiOS|GSA\\/|FBAN|FBAV|Instagram|LinkedInApp|Snapchat|WhatsApp|Line\\//i.test(ua) || !/Safari\\//.test(ua))
  : /android/i.test(ua) && /; wv\\)|FBAN|FBAV|Instagram|GSA\\//i.test(ua);
let dev = localStorage.getItem("mbv-dispositivo");
if (!dev) { dev = crypto.randomUUID(); localStorage.setItem("mbv-dispositivo", dev); }
const name = (/android/i.test(ua) ? (/mobile/i.test(ua) ? "Android" : "Tablet Android") : ipad ? "iPad" : ios ? "iPhone" : "Cellulare") + " " + new Date().toLocaleDateString("it-IT");
if (wrong) {
  const app = ios ? "Safari" : "Chrome";
  $("msg").innerHTML = "Per installare MB Visual apri questo link in <b>" + app + "</b>.";
  $("wrong").classList.remove("hide");
  $("wrong-app").textContent = app;
  if (ios) { $("open").href = "x-safari-" + location.href; $("open").classList.remove("hide"); }
  $("copy").onclick = async () => { try { await navigator.clipboard.writeText(location.href); $("copy").textContent = "Link copiato"; } catch { window.prompt("Copia il link:", location.href); } };
} else fetch("/v1/mlink/claim", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
  body: JSON.stringify({ link: location.pathname.split("/").pop(), device: dev, name }) }).then(r => r.json()).then(r => {
  if (!r.ok) { $("msg").textContent = r.errore || "Attivazione non riuscita"; $("msg").className = "err"; return; }
  localStorage.setItem("mbv-licenza-scade", String(Date.now() + 30 * 86400000));
  if (matchMedia("(display-mode: standalone)").matches || navigator.standalone === true) return location.replace("/");
  $("msg").textContent = r.cliente ? "Licenza di " + r.cliente : "";
  $("steps").innerHTML = ios ? (ipad ? "<li>Tocca il pulsante Condividi di Safari, in alto a destra (quadrato con la freccia).</li>" : "<li>Tocca il pulsante Condividi di Safari (quadrato con la freccia).</li>") + "<li>Scegli <b>Aggiungi alla schermata Home</b> (se non c'e', scorri l'elenco in basso).</li><li>Apri MB Visual dalla schermata Home.</li>"
    : "<li>Apri il menu del browser (tre puntini).</li><li>Scegli <b>Installa app</b> o <b>Aggiungi a schermata Home</b>.</li><li>Apri MB Visual dalla schermata Home.</li>";
  if (r.codice) { $("code").textContent = r.codice; $("min").textContent = r.codice_minuti; $("pair").classList.remove("hide"); }
  $("ok").classList.remove("hide");
}).catch(() => { $("msg").textContent = "Serve una connessione a internet."; $("msg").className = "err"; });
</script></body></html>`;

// ---------------------------------------------------------------- app per cellulari (file statici protetti)
// I file dell'app (cartella public, binding ASSETS) si consegnano solo con un'attivazione "mobile" valida nel cookie
// mbv_m (HttpOnly). Senza: la pagina di attivazione (nel browser spiega come installare l'app; installata chiede la chiave).
const COOKIE = "mbv_m";
const PUBLIC = /^\/(manifest\.webmanifest|sw\.js|img\/(icon-\d+|icon-maskable-512|apple-touch-icon-\d+|splash-\d+x\d+|logo-512|logo)\.png|favicon\.ico)$/;
const getCookie = (req, name) => (req.headers.get("cookie") || "").split(/;\s*/).map(c => c.split("=")).find(([k]) => k === name)?.[1] || "";
const setCookie = (res, token) => {
  const r = new Response(res.body, res);
  r.headers.append("set-cookie", token ? `${COOKIE}=${token}; Path=/; Max-Age=${TOKEN_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax` : `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  return r;
};
async function mobileToken(env, req) {
  const t = await readToken(env, getCookie(req, COOKIE));
  return t && t.t === "mobile" && t.exp > Date.now() / 1000 ? t : null;
}
async function serveApp(env, req, url) {
  if (PUBLIC.test(url.pathname)) return env.ASSETS.fetch(req);
  if (/^\/l\/[A-Za-z0-9_-]{20,}$/.test(url.pathname)) return new Response(LINK_PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  if (url.pathname !== "/attiva" && await mobileToken(env, req)) {
    const r = await env.ASSETS.fetch(req);
    if (url.pathname === "/" || url.pathname.endsWith(".html")) { const h = new Response(r.body, r); h.headers.set("cache-control", "no-store"); return h; }
    return r;
  }
  const html = req.headers.get("accept")?.includes("text/html") || url.pathname === "/" || url.pathname.endsWith(".html");
  if (!html) return fail(401, "App non attivata");
  return new Response(ACTIVATION_PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

const ACTIVATION_PAGE = `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f1114"><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/img/icon-192.png">
${APPLE_HEAD}
<title>MB Visual</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#17191b;color:#e6e8e5;font:15px system-ui,"Segoe UI",sans-serif;padding:20px}
.box{width:min(440px,100%);text-align:center}img{width:110px;height:110px}h1{font-size:22px;margin:10px 0 6px}p{color:#9ea29b;line-height:1.45}
input{width:100%;font:17px Consolas,monospace;letter-spacing:.04em;text-align:center;padding:12px;border-radius:8px;border:1px solid #454a4e;background:#26292c;color:#e6e8e5}
button{margin-top:14px;width:100%;padding:12px;border:0;border-radius:8px;background:#f07d2e;color:#16110c;font:600 16px system-ui}.err{color:#e0605a;min-height:1.3em}
ol{text-align:left;color:#cfd2cc;line-height:1.6;padding-left:22px}.hide{display:none}</style></head><body><div class="box">
<img src="/img/logo-512.png" alt="MB Visual"><h1>MB Visual</h1><p style="margin:-2px 0 12px;color:#8a8c89;font-size:13px;letter-spacing:.05em">Powered by MB Group</p>
<div id="browser"><p>L'app per cellulari e tablet si usa solo installata. Installala, poi aprila dalla schermata Home e inserisci la chiave di licenza.</p>
<ol id="steps"></ol><button id="inst" class="hide">Installa l'app</button></div>
<div id="app" class="hide"><p id="msg">Inserisci la chiave di licenza ricevuta, oppure il codice di 6 cifre mostrato dopo aver inquadrato il QR del PC.</p>
<input id="k" placeholder="MBV-XXXXX-XXXXX-XXXXX-XXXXX" autocomplete="off" autocapitalize="characters" spellcheck="false">
<p class="err" id="err"></p><button id="go">Attiva</button></div></div>
<script>
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const ipad = /ipad/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const ios = /iphone|ipod/i.test(navigator.userAgent) || ipad;
const $ = id => document.getElementById(id);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
const why = new URLSearchParams(location.search).get("motivo");
if (why) $("msg").textContent = why;
if (standalone) { $("browser").classList.add("hide"); $("app").classList.remove("hide"); }
else {
  $("steps").innerHTML = ios ? (ipad ? "<li>Tocca il pulsante Condividi di Safari, in alto a destra (quadrato con la freccia).</li>" : "<li>Tocca il pulsante Condividi di Safari (quadrato con la freccia).</li>") + "<li>Scegli <b>Aggiungi alla schermata Home</b> (se non c'e', scorri l'elenco in basso).</li><li>Apri MB Visual dalla schermata Home.</li>"
    : "<li>Apri il menu del browser (tre puntini).</li><li>Scegli <b>Installa app</b> o <b>Aggiungi a schermata Home</b>.</li><li>Apri MB Visual dalla schermata Home.</li>";
  let prompt = null;
  addEventListener("beforeinstallprompt", e => { e.preventDefault(); prompt = e; $("inst").classList.remove("hide"); });
  $("inst").onclick = () => prompt && prompt.prompt();
}
let dev = localStorage.getItem("mbv-dispositivo");
if (!dev) { dev = crypto.randomUUID(); localStorage.setItem("mbv-dispositivo", dev); }
const fmt = v => { const s = v.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^MBV/, "").slice(0, 20); return s ? "MBV-" + s.replace(/(.{5})(?=.)/g, "$1-") : ""; };
$("k").addEventListener("input", e => { const v = e.target.value; if (!/^\\s*\\d/.test(v)) e.target.value = fmt(v); });
$("go").onclick = async () => {
  $("err").textContent = ""; $("go").disabled = true;
  try {
    const name = (/android/i.test(navigator.userAgent) ? (/mobile/i.test(navigator.userAgent) ? "Android" : "Tablet Android") : ipad ? "iPad" : ios ? "iPhone" : "Cellulare") + " " + new Date().toLocaleDateString("it-IT");
    const code = $("k").value.replace(/\\s/g, ""), isCode = /^\\d{6}$/.test(code);
    const r = await fetch(isCode ? "/v1/mlink/pair" : "/v1/activate", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify(isCode ? { code, device: dev, name } : { key: $("k").value, device: dev, kind: "mobile", name }) }).then(r => r.json());
    if (!r.ok) { $("err").textContent = r.errore + (r.suggerimento ? " " + r.suggerimento : ""); return; }
    localStorage.setItem("mbv-licenza-scade", String(Date.now() + 30 * 86400000));
    location.replace("/");
  } catch (e) { $("err").textContent = "Serve una connessione a internet per l'attivazione."; } finally { $("go").disabled = false; }
};
</script></body></html>`;

export default {
  async scheduled(controller, env, ctx) {
    env = Object.assign(Object.create(env), { _wait: pr => ctx.waitUntil(pr) });
    await expiryCheck(env);
  },
  _expiryCheck: expiryCheck, // prove (harness)
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return json({});
    // env per questa richiesta: notifiche spedite dopo la risposta (waitUntil) e indirizzo del server come mittente VAPID
    env = Object.assign(Object.create(env), { _wait: ctx?.waitUntil ? pr => ctx.waitUntil(pr) : null, _origin: url.origin });
    try {
      const P = adminPath(env);
      if (P && (url.pathname === "/" + P || url.pathname.startsWith("/" + P + "/"))) return await adminApp(env, req, url, { admin, json, fail, event });
      if (url.pathname.startsWith("/admin")) return await admin(env, req, url);
      if (url.pathname === "/scarica" && req.method === "GET") return await setupDownload(env, req);
      // pagine pubbliche (anche per la verifica dell'app OAuth di Google): presentazione e informativa (src/pages.js)
      if ((url.pathname === "/mbvisual" || url.pathname === "/privacy") && (req.method === "GET" || req.method === "HEAD"))
        return new Response((url.pathname === "/privacy" ? privacyPage : presentationPage)(env), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=600" } });
      if (!url.pathname.startsWith("/v1/")) {
        if (env.ASSETS && (req.method === "GET" || req.method === "HEAD")) return await serveApp(env, req, url);
        if (req.method !== "POST") return json({ ok: true, servizio: "Licenze MB Visual" });
      }
      if (url.pathname.startsWith("/v1/stats") && +(req.headers.get("content-length") || 0) > 256000) return fail(413, "Pacchetto troppo grande");
      const b = await req.json().catch(() => ({}));
      // app per cellulari: l'attivazione viaggia nel cookie (HttpOnly) invece che nel corpo della richiesta
      const viaCookie = !b.token && !b.key && getCookie(req, COOKIE);
      if (viaCookie) b.token = getCookie(req, COOKIE);
      // statistiche d'uso anonime: senza token, cookie o dati della licenza
      if (url.pathname === "/v1/stats") return await postStats(env, b, json, fail);
      if (url.pathname === "/v1/stats/forget") return await forgetStats(env, b, json, fail);
      // posta dell'app per telefono: passaggio IMAP/SMTP senza memoria, solo per telefoni attivati (server/src/mailgw.js)
      if (url.pathname === "/v1/mail/imap" || url.pathname === "/v1/mail/smtp") {
        if (!(await mobileToken(env, req))) return fail(401, "App non attivata");
        const { mailGateway } = await import("./mailgw.js");
        const connect = env._connect || (await import("cloudflare:sockets")).connect; // _connect: prove senza Cloudflare
        return await mailGateway(env, url.pathname, b, connect);
      }
      let res;
      if (url.pathname === "/v1/activate") res = await activate(env, b);
      else if (url.pathname === "/v1/check") res = await check(env, b);
      else if (url.pathname === "/v1/account") res = await account(env, b);
      else if (url.pathname === "/v1/request") res = await request(env, b);
      else if (url.pathname === "/v1/mlink") res = await mobileLink(env, b, url.origin);
      else if (url.pathname === "/v1/mlink/claim") res = await claimLink(env, b, req.headers.get("user-agent") || "");
      else if (url.pathname === "/v1/mlink/pair") res = await pairCode(env, b);
      else return fail(404, "Percorso sconosciuto");
      // telefono attivato dal codice QR o dal codice di 6 cifre: attivazione nel cookie
      if (url.pathname === "/v1/mlink/claim" || url.pathname === "/v1/mlink/pair") {
        const data = await res.clone().json();
        if (data.token) return setCookie(res, data.token);
      }
      // cookie aggiornato: attivazione o rinnovo di un cellulare; tolto se la licenza non vale piu'
      if ((url.pathname === "/v1/activate" && b.kind === "mobile") || (url.pathname === "/v1/check" && viaCookie)) {
        const data = await res.clone().json();
        if (data.token) return setCookie(res, data.token);
        if (viaCookie && [401, 403, 410].includes(res.status)) return setCookie(res, "");
      }
      if (viaCookie && url.pathname === "/v1/request" && b.type === "change" && res.ok && (await res.clone().json()).nuova_chiave) return setCookie(res, "");
      return res;
    } catch (e) {
      return fail(500, "Errore del server: " + (e?.message || e));
    }
  },
};
