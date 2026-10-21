// Server delle licenze di MB Visual (Cloudflare Worker + D1).
// Attivazioni firmate Ed25519 con la chiave privata del proprietario (segreto SIGNING_KEY): l'app per PC e
// l'app per cellulare verificano la firma con la chiave pubblica incorporata e funzionano offline fino a "exp".
//
// Pubblico:  POST /v1/activate  {key, device, kind:"pc"|"mobile", name, version}   -> {token}
//            POST /v1/check     {token}                                            -> {token} o {stato, errore}
//            POST /v1/account   {token}                                            -> licenza, dispositivi, richieste
//            POST /v1/request   {token | key+device, type:"change"|"report", message, name}
// Gestione (Authorization: Bearer ADMIN_TOKEN):
//            GET  /admin/summary, /admin/licenses, /admin/requests, /admin/events?after=ID
//            POST /admin/licenses {customer,email,notes,max_pc,max_mobile,expires}
//            POST /admin/licenses/:key/(revoke|reactivate|update)   POST /admin/devices/:id/revoke
//            POST /admin/requests/:id/(approve|close)               POST /admin/events/read {upto}

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
    await event(env, "activation", key, `Attivato ${kind === "pc" ? "PC" : "cellulare"} "${dev.name}" per ${lic.customer || key}`);
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
async function admin(env, req, url) {
  if ((req.headers.get("authorization") || "") !== `Bearer ${env.ADMIN_TOKEN}`) return fail(401, "Non autorizzato");
  const p = url.pathname.replace(/^\/admin\/?/, "").split("/");
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const all = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results;
  if (p[0] === "summary") {
    const one = async sql => (await env.DB.prepare(sql).first()).n;
    return json({ ok: true, licenze: await one("SELECT COUNT(*) n FROM licenses WHERE status='active'"), pc: await one("SELECT COUNT(*) n FROM devices WHERE status='active' AND kind='pc'"),
      cellulari: await one("SELECT COUNT(*) n FROM devices WHERE status='active' AND kind='mobile'"), richieste_aperte: await one("SELECT COUNT(*) n FROM requests WHERE status IN ('open','pending')"),
      avvisi_non_letti: await one("SELECT COUNT(*) n FROM events WHERE read=0") });
  }
  if (p[0] === "licenses" && !p[1]) {
    if (req.method === "POST") {
      const key = newKey();
      await env.DB.prepare("INSERT INTO licenses (key, root, customer, email, notes, max_pc, max_mobile, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(key, key, String(body.customer || ""), String(body.email || ""), String(body.notes || ""), +body.max_pc || 1, body.max_mobile ?? 2, body.expires || null).run();
      return json({ ok: true, key });
    }
    const lics = await all("SELECT * FROM licenses ORDER BY created DESC");
    const devs = await all("SELECT * FROM devices ORDER BY id");
    return json({ ok: true, licenze: lics.map(l => ({ ...l, dispositivi: devs.filter(d => d.license_key === l.key) })) });
  }
  if (p[0] === "licenses" && p[1]) {
    const key = decodeURIComponent(p[1]);
    if (p[2] === "revoke") await env.DB.prepare("UPDATE licenses SET status='revoked' WHERE key=?").bind(key).run();
    else if (p[2] === "reactivate") await env.DB.prepare("UPDATE licenses SET status='active' WHERE key=? AND status='revoked'").bind(key).run();
    else if (p[2] === "update") await env.DB.prepare("UPDATE licenses SET customer=?, email=?, notes=?, max_pc=?, max_mobile=?, expires=? WHERE key=?")
      .bind(String(body.customer || ""), String(body.email || ""), String(body.notes || ""), +body.max_pc || 1, +(body.max_mobile ?? 2), body.expires || null, key).run();
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
  if (p[0] === "events" && p[1] === "read") { await env.DB.prepare("UPDATE events SET read=1 WHERE id <= ?").bind(+body.upto || 0).run(); return json({ ok: true }); }
  if (p[0] === "events") return json({ ok: true, avvisi: await all("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT 500", +(url.searchParams.get("after") || 0)) });
  return fail(404, "Percorso sconosciuto");
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return json({});
    try {
      if (url.pathname.startsWith("/admin")) return await admin(env, req, url);
      if (req.method !== "POST") return json({ ok: true, servizio: "Licenze MB Visual" });
      const b = await req.json().catch(() => ({}));
      if (url.pathname === "/v1/activate") return await activate(env, b);
      if (url.pathname === "/v1/check") return await check(env, b);
      if (url.pathname === "/v1/account") return await account(env, b);
      if (url.pathname === "/v1/request") return await request(env, b);
      return fail(404, "Percorso sconosciuto");
    } catch (e) {
      return fail(500, "Errore del server: " + (e?.message || e));
    }
  },
};
