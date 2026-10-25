// App per telefono di MB Desk Admin (solo per il proprietario): stesse funzioni dell'app per PC (licenze, dispositivi,
// cambi, segnalazioni, approvazioni) con notifiche push.
//
// Indirizzo non pubblicizzato: https://<server>/<ADMIN_PATH>/ (segreto ADMIN_PATH, mai scritto in file pubblici; un percorso
// diverso risponde come una pagina inesistente). Accesso con il codice di gestione (ADMIN_TOKEN) oppure con un codice di
// 6 cifre generato dall'app per PC (POST /admin/pair, valido 10 minuti, una volta sola). L'accesso crea una sessione nel
// cookie mbv_a (HttpOnly, solo su questo percorso); nel database c'e' solo l'impronta SHA-256 del cookie.
// Blocco in piu': impronta / volto / PIN del telefono con WebAuthn (passkey legata a questo server). Con il blocco attivo
// ogni apertura chiede lo sblocco e dopo UNLOCK_MIN minuti senza operazioni l'app si richiude.
// Notifiche: Web Push (VAPID, segreto VAPID_JWK) con cifratura aes128gcm (RFC 8291) scritta con WebCrypto.
//
// API (sotto /<ADMIN_PATH>/api/): GET state; POST login {code|pair, name}, logout, lock;
//   POST wa/reg-options, wa/reg, wa/unlock-options, wa/unlock, wa/remove; GET sessions, POST sessions/<n>/revoke;
//   POST push/sub {endpoint, keys}, push/unsub {endpoint}, push/test; tutto /api/admin/* = API di gestione del PC.
import { ADMIN_HTML, ADMIN_SW, ICON_192, ICON_512 } from "./adminui.js";

const SESSION_DAYS = 180, UNLOCK_MIN = 10, PAIR_MIN = 10, FAIL_MAX = 5, FAIL_MIN = 15, CHALLENGE_MIN = 5;
const ACOOKIE = "mbv_a";
const enc = new TextEncoder(), dec = new TextDecoder();
const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4)), c => c.charCodeAt(0));
const sqlTime = ms => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const sha256 = async data => new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const KIND = { activation: "Attivazione", activation_pc: "Nuovo PC attivato", activation_mobile: "Nuovo cellulare attivato", expiring: "Licenza in scadenza", expired: "Licenza scaduta", change: "Cambio dispositivo", change_pending: "Cambio da approvare", report: "Segnalazione", limit: "Limite raggiunto",
  invalid_key: "Chiave non valida", revoked_use: "Licenza non valida in uso", admin_login: "Accesso alla gestione" };

export const adminPath = env => (/^[A-Za-z0-9_-]{16,}$/.test(env.ADMIN_PATH || "") ? env.ADMIN_PATH : "");

// ---------------------------------------------------------------- codice di 6 cifre dall'app per PC
export async function newPairCode(env, origin) {
  const P = adminPath(env);
  if (!P) return { ok: false, errore: "App per telefono non configurata sul server (ADMIN_PATH)" };
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  const code = String(n).padStart(6, "0");
  const expires = Date.now() + PAIR_MIN * 60000;
  await env.DB.prepare("DELETE FROM admin_pairs WHERE expires < ?").bind(sqlTime(Date.now())).run();
  await env.DB.prepare("INSERT INTO admin_pairs (code, expires) VALUES (?, ?)").bind(hex(await sha256("pair|" + code)), sqlTime(expires)).run();
  return { ok: true, codice: code, scade: expires, url: `${origin}/${P}/?abbina=${code}`, indirizzo: `${origin}/${P}/` };
}

// ---------------------------------------------------------------- richieste dell'app
export async function adminApp(env, req, url, deps) {
  const P = adminPath(env);
  const base = `/${P}`;
  if (url.pathname === base) return Response.redirect(`${url.origin}${base}/`, 302);
  const sub = url.pathname.slice(base.length + 1);
  const hdr = (type, extra = {}) => ({ "content-type": type, "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer", ...extra });
  if (req.method === "GET" && (sub === "" || sub === "index.html"))
    return new Response(ADMIN_HTML.replaceAll("__BASE__", base), { headers: hdr("text/html; charset=utf-8", { "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" }) });
  if (req.method === "GET" && sub === "sw.js") return new Response(ADMIN_SW, { headers: hdr("text/javascript; charset=utf-8", { "cache-control": "no-cache" }) });
  if (req.method === "GET" && sub === "manifest.webmanifest")
    return new Response(JSON.stringify({ name: "MB Desk Admin", short_name: "MB Desk Admin", start_url: `${base}/`, scope: `${base}/`, display: "standalone",
      background_color: "#17191b", theme_color: "#17191b", icons: [{ src: `${base}/admin-192.png`, sizes: "192x192", type: "image/png" }, { src: `${base}/admin-512.png`, sizes: "512x512", type: "image/png" },
        { src: `${base}/admin-512.png`, sizes: "512x512", type: "image/png", purpose: "maskable" }] }), { headers: hdr("application/manifest+json", { "cache-control": "no-cache" }) });
  // icone: nome nuovo a ogni cambio di logo (Chrome aggiorna l'icona dell'app installata solo se cambia l'indirizzo nel manifest);
  // i nomi vecchi restano validi per le app gia' installate
  if (req.method === "GET" && /^(admin|icon)-(192|512)\.png$/.test(sub))
    return new Response(unb64u(sub.includes("192") ? ICON_192 : ICON_512), { headers: hdr("image/png", { "cache-control": "no-cache" }) });
  if (!sub.startsWith("api/")) return deps.fail(404, "Percorso sconosciuto");
  // POST solo JSON dalla stessa origine (insieme a SameSite=Strict: niente richieste da altri siti)
  if (req.method === "POST" && !(req.headers.get("content-type") || "").includes("application/json")) return deps.fail(415, "Richiesta non valida");
  const api = sub.slice(4);
  const ses = await session(env, req);
  if (api === "state") return deps.json({ ok: true, accesso: !!ses, impronta: !!ses?.cred_id, bloccata: !!ses && locked(ses), notifiche: vapidPublic(env), nome: ses?.name || "" });
  if (api === "login") return login(env, req, url, deps, base);
  if (!ses) return deps.fail(401, "Accesso scaduto: inserisci di nuovo il codice", { stato: "accesso" });
  if (api === "logout") {
    await env.DB.prepare("UPDATE admin_sessions SET revoked = 1 WHERE n = ?").bind(ses.n).run();
    await env.DB.prepare("DELETE FROM admin_push WHERE session = ?").bind(ses.n).run();
    return withCookie(deps.json({ ok: true }), base, "");
  }
  if (api === "wa/unlock-options") return unlockOptions(env, url, ses, deps);
  if (api === "wa/unlock") return unlock(env, req, url, ses, deps);
  if (locked(ses)) return deps.fail(423, "App bloccata: sbloccala con l'impronta o il PIN", { stato: "bloccata" });
  // da qui in poi: sessione valida e sbloccata; con il blocco attivo ogni operazione allunga lo sblocco
  if (ses.cred_id) await env.DB.prepare("UPDATE admin_sessions SET unlocked_until = ?, last_seen = ? WHERE n = ?").bind(sqlTime(Date.now() + UNLOCK_MIN * 60000), sqlTime(Date.now()), ses.n).run();
  else await env.DB.prepare("UPDATE admin_sessions SET last_seen = ? WHERE n = ?").bind(sqlTime(Date.now()), ses.n).run();
  if (api === "lock") { await env.DB.prepare("UPDATE admin_sessions SET unlocked_until = NULL WHERE n = ?").bind(ses.n).run(); return deps.json({ ok: true }); }
  if (api === "wa/reg-options") return regOptions(env, url, ses, deps);
  if (api === "wa/reg") return register(env, req, url, ses, deps);
  if (api === "wa/remove") { await env.DB.prepare("UPDATE admin_sessions SET cred_id = NULL, cred_key = NULL, cred_alg = NULL, unlocked_until = NULL WHERE n = ?").bind(ses.n).run(); return deps.json({ ok: true }); }
  if (api === "sessions") {
    const rows = (await env.DB.prepare("SELECT n, name, created, last_seen, cred_id FROM admin_sessions WHERE revoked = 0 AND expires > ? ORDER BY last_seen DESC").bind(sqlTime(Date.now())).all()).results;
    return deps.json({ ok: true, telefoni: rows.map(r => ({ n: r.n, nome: r.name, creato: r.created, ultimo: r.last_seen, impronta: !!r.cred_id, questo: r.n === ses.n })) });
  }
  const sm = api.match(/^sessions\/(\d+)\/revoke$/);
  if (sm) {
    await env.DB.prepare("UPDATE admin_sessions SET revoked = 1 WHERE n = ?").bind(+sm[1]).run();
    await env.DB.prepare("DELETE FROM admin_push WHERE session = ?").bind(+sm[1]).run();
    return deps.json({ ok: true });
  }
  if (api === "push/sub") {
    const b = await req.json().catch(() => ({}));
    const ep = String(b.endpoint || ""), p256dh = String(b.keys?.p256dh || ""), auth = String(b.keys?.auth || "");
    if (!/^https:\/\//.test(ep) && !(env._PROVA && /^http:\/\/127\.0\.0\.1/.test(ep))) return deps.fail(400, "Iscrizione alle notifiche non valida");
    if (unb64u(p256dh).length !== 65 || unb64u(auth).length !== 16) return deps.fail(400, "Iscrizione alle notifiche non valida");
    await env.DB.prepare("INSERT INTO admin_push (endpoint, session, p256dh, auth) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET session = excluded.session, p256dh = excluded.p256dh, auth = excluded.auth")
      .bind(ep, ses.n, p256dh, auth).run();
    return deps.json({ ok: true });
  }
  if (api === "push/unsub") { const b = await req.json().catch(() => ({})); await env.DB.prepare("DELETE FROM admin_push WHERE endpoint = ?").bind(String(b.endpoint || "")).run(); return deps.json({ ok: true }); }
  if (api === "push/test") {
    const r = await notifyAdmins(env, { title: "MB Desk Admin", body: "Le notifiche funzionano su questo telefono.", tag: "prova" }, ses.n);
    return deps.json({ ok: true, ...r });
  }
  if (api.startsWith("admin/")) return deps.admin(env, req, url, api.slice(6));
  return deps.fail(404, "Percorso sconosciuto");
}

async function session(env, req) {
  const tok = (req.headers.get("cookie") || "").split(/;\s*/).map(c => c.split("=")).find(([k]) => k === ACOOKIE)?.[1];
  if (!tok) return null;
  return env.DB.prepare("SELECT * FROM admin_sessions WHERE token_hash = ? AND revoked = 0 AND expires > ?").bind(hex(await sha256("ses|" + tok)), sqlTime(Date.now())).first();
}
const locked = ses => !!ses.cred_id && !(ses.unlocked_until && ses.unlocked_until > sqlTime(Date.now()));
function withCookie(res, base, token) {
  const r = new Response(res.body, res);
  r.headers.append("set-cookie", token ? `${ACOOKIE}=${token}; Path=${base}/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Strict`
    : `${ACOOKIE}=; Path=${base}/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
  return r;
}

async function login(env, req, url, deps, base) {
  const ip = req.headers.get("cf-connecting-ip") || "locale";
  const now = Date.now();
  const f = await env.DB.prepare("SELECT * FROM admin_fails WHERE ip = ?").bind(ip).first();
  const recent = f && f.first > sqlTime(now - FAIL_MIN * 60000);
  if (recent && f.n >= FAIL_MAX) return deps.fail(429, `Troppi tentativi sbagliati: riprova tra ${FAIL_MIN} minuti.`);
  const b = await req.json().catch(() => ({}));
  const code = String(b.code || "").trim(), pair = String(b.pair || "").replace(/\D/g, "");
  let ok = false;
  if (code) ok = env.ADMIN_TOKEN && hex(await sha256("c|" + code)) === hex(await sha256("c|" + env.ADMIN_TOKEN)); // confronto a lunghezza fissa
  else if (/^\d{6}$/.test(pair)) {
    const r = await env.DB.prepare("UPDATE admin_pairs SET used = ? WHERE code = ? AND used IS NULL AND expires > ?").bind(sqlTime(now), hex(await sha256("pair|" + pair)), sqlTime(now)).run();
    ok = r.meta.changes === 1;
  }
  if (!ok) {
    if (recent) await env.DB.prepare("UPDATE admin_fails SET n = n + 1 WHERE ip = ?").bind(ip).run();
    else await env.DB.prepare("INSERT INTO admin_fails (ip, n, first) VALUES (?, 1, ?) ON CONFLICT(ip) DO UPDATE SET n = 1, first = excluded.first").bind(ip, sqlTime(now)).run();
    return deps.fail(401, pair ? "Codice di 6 cifre sbagliato o scaduto: generane uno nuovo nell'app per PC." : "Codice di gestione sbagliato.");
  }
  await env.DB.prepare("DELETE FROM admin_fails WHERE ip = ?").bind(ip).run();
  const tok = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const name = String(b.name || "Telefono").slice(0, 60);
  await env.DB.prepare("INSERT INTO admin_sessions (token_hash, name, expires) VALUES (?, ?, ?)").bind(hex(await sha256("ses|" + tok)), name, sqlTime(now + SESSION_DAYS * 86400000)).run();
  await deps.event(env, "admin_login", null, `Accesso all'app di gestione da "${name}"`);
  return withCookie(deps.json({ ok: true }), base, tok);
}

// ---------------------------------------------------------------- WebAuthn (impronta / volto / PIN del telefono)
async function challenge(env, ses, kind) {
  const c = b64u(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare("DELETE FROM admin_challenges WHERE expires < ?").bind(sqlTime(Date.now())).run();
  await env.DB.prepare("INSERT INTO admin_challenges (id, session, kind, expires) VALUES (?, ?, ?, ?)").bind(c, ses.n, kind, sqlTime(Date.now() + CHALLENGE_MIN * 60000)).run();
  return c;
}
async function useChallenge(env, ses, kind, c) {
  const r = await env.DB.prepare("DELETE FROM admin_challenges WHERE id = ? AND session = ? AND kind = ? AND expires > ?").bind(String(c || ""), ses.n, kind, sqlTime(Date.now())).run();
  return r.meta.changes === 1;
}
async function regOptions(env, url, ses, deps) {
  return deps.json({ ok: true, publicKey: { challenge: await challenge(env, ses, "reg"), rp: { id: url.hostname, name: "MB Desk Admin" },
    user: { id: b64u(enc.encode("mbv-admin-" + ses.n)), name: "MB Desk Admin", displayName: "MB Desk Admin" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }], timeout: 120000, attestation: "none",
    authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" } } });
}
function clientData(raw, type, url) {
  const c = JSON.parse(dec.decode(raw));
  if (c.type !== type) throw new Error("tipo");
  if (c.origin !== url.origin) throw new Error("origine");
  return c;
}
async function authData(raw, url) {
  const a = new Uint8Array(raw);
  if (hex(a.slice(0, 32)) !== hex(await sha256(url.hostname))) throw new Error("server");
  const flags = a[32];
  if (!(flags & 1) || !(flags & 4)) throw new Error("verifica dell'utente mancante"); // presenza + impronta/PIN
  return { flags, count: ((a[33] << 24) >>> 0) + (a[34] << 16) + (a[35] << 8) + a[36], rest: a.slice(37) };
}
async function register(env, req, url, ses, deps) {
  const b = await req.json().catch(() => ({}));
  try {
    const cd = clientData(unb64u(b.clientDataJSON), "webauthn.create", url);
    if (!(await useChallenge(env, ses, "reg", cd.challenge))) throw new Error("richiesta scaduta");
    const [att] = cbor(unb64u(b.attestationObject));
    const ad = await authData(att.get("authData"), url);
    if (!(ad.flags & 64)) throw new Error("credenziale mancante");
    const r = ad.rest, idLen = (r[16] << 8) | r[17], credId = r.slice(18, 18 + idLen);
    const [cose] = cbor(r, 18 + idLen);
    const { jwk, alg } = coseToJwk(cose);
    await env.DB.prepare("UPDATE admin_sessions SET cred_id = ?, cred_key = ?, cred_alg = ?, cred_count = ?, unlocked_until = ? WHERE n = ?")
      .bind(b64u(credId), JSON.stringify(jwk), alg, ad.count, sqlTime(Date.now() + UNLOCK_MIN * 60000), ses.n).run();
    return deps.json({ ok: true });
  } catch (e) {
    return deps.fail(400, "Registrazione dell'impronta non riuscita: " + (e?.message || e));
  }
}
async function unlockOptions(env, url, ses, deps) {
  if (!ses.cred_id) return deps.fail(400, "Nessuna impronta registrata su questo telefono");
  return deps.json({ ok: true, publicKey: { challenge: await challenge(env, ses, "get"), rpId: url.hostname, timeout: 120000, userVerification: "required",
    allowCredentials: [{ type: "public-key", id: ses.cred_id }] } });
}
async function unlock(env, req, url, ses, deps) {
  const b = await req.json().catch(() => ({}));
  try {
    if (!ses.cred_id || b.id !== ses.cred_id) throw new Error("credenziale diversa");
    const raw = unb64u(b.clientDataJSON);
    const cd = clientData(raw, "webauthn.get", url);
    if (!(await useChallenge(env, ses, "get", cd.challenge))) throw new Error("richiesta scaduta");
    const adRaw = unb64u(b.authenticatorData);
    const ad = await authData(adRaw, url);
    const data = concat(adRaw, await sha256(raw));
    if (!(await verifySig(JSON.parse(ses.cred_key), ses.cred_alg, unb64u(b.signature), data))) throw new Error("firma non valida");
    if (ad.count && ses.cred_count && ad.count <= ses.cred_count) throw new Error("contatore non valido (credenziale copiata?)");
    await env.DB.prepare("UPDATE admin_sessions SET unlocked_until = ?, cred_count = ?, last_seen = ? WHERE n = ?")
      .bind(sqlTime(Date.now() + UNLOCK_MIN * 60000), ad.count, sqlTime(Date.now()), ses.n).run();
    return deps.json({ ok: true });
  } catch (e) {
    return deps.fail(401, "Sblocco non riuscito: " + (e?.message || e));
  }
}
// CBOR minimo (RFC 8949) per l'attestazione e la chiave COSE: restituisce [valore, posizione successiva]
export function cbor(buf, pos = 0) {
  const ib = buf[pos++], mt = ib >> 5, ai = ib & 31;
  let len = ai;
  if (ai === 24) len = buf[pos++];
  else if (ai === 25) { len = (buf[pos] << 8) | buf[pos + 1]; pos += 2; }
  else if (ai === 26) { len = ((buf[pos] << 24) >>> 0) + (buf[pos + 1] << 16) + (buf[pos + 2] << 8) + buf[pos + 3]; pos += 4; }
  else if (ai === 27) { len = 0; for (let i = 0; i < 8; i++) len = len * 256 + buf[pos + i]; pos += 8; }
  else if (ai > 27) throw new Error("CBOR non supportato");
  if (mt === 0) return [len, pos];
  if (mt === 1) return [-1 - len, pos];
  if (mt === 2) return [buf.slice(pos, pos + len), pos + len];
  if (mt === 3) return [dec.decode(buf.slice(pos, pos + len)), pos + len];
  if (mt === 4) { const a = []; for (let i = 0; i < len; i++) { let v; [v, pos] = cbor(buf, pos); a.push(v); } return [a, pos]; }
  if (mt === 5) { const m = new Map(); for (let i = 0; i < len; i++) { let k, v; [k, pos] = cbor(buf, pos); [v, pos] = cbor(buf, pos); m.set(k, v); } return [m, pos]; }
  if (mt === 7) return [ai === 21 ? true : ai === 20 ? false : null, pos];
  throw new Error("CBOR non supportato");
}
function coseToJwk(m) {
  const kty = m.get(1), alg = m.get(3);
  if (kty === 2 && alg === -7 && m.get(-1) === 1) return { alg, jwk: { kty: "EC", crv: "P-256", x: b64u(m.get(-2)), y: b64u(m.get(-3)) } };
  if (kty === 3 && alg === -257) return { alg, jwk: { kty: "RSA", n: b64u(m.get(-1)), e: b64u(m.get(-2)) } };
  throw new Error("tipo di chiave non supportato");
}
function derToRaw(sig) {
  if (sig[0] !== 0x30) return sig;
  let p = 2 + (sig[1] & 0x80 ? sig[1] & 0x7f : 0);
  const int = () => { const l = sig[p + 1]; let v = sig.slice(p + 2, p + 2 + l); p += 2 + l; while (v.length > 32 && v[0] === 0) v = v.slice(1); return concat(new Uint8Array(32 - v.length), v); };
  return concat(int(), int());
}
async function verifySig(jwk, alg, sig, data) {
  if (alg === -7) {
    const k = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, derToRaw(sig), data);
  }
  const k = await crypto.subtle.importKey("jwk", { ...jwk, alg: "RS256" }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", k, sig, data);
}

// ---------------------------------------------------------------- notifiche push
function vapidJwk(env) { try { const j = JSON.parse(env.VAPID_JWK || ""); return j.d && j.x && j.y ? j : null; } catch { return null; } }
export const vapidPublic = env => { const j = vapidJwk(env); return j ? b64u(concat(new Uint8Array([4]), unb64u(j.x), unb64u(j.y))) : ""; };
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}
// cifratura del messaggio per un'iscrizione (RFC 8291, codifica aes128gcm di RFC 8188, un solo record)
export async function encryptPush(p256dh, authSecret, payload) {
  const ua = unb64u(p256dh), auth = unb64u(authSecret);
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(auth, secret, concat(enc.encode("WebPush: info\0"), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(enc.encode(payload), new Uint8Array([2]))));
  return concat(salt, new Uint8Array([0, 0, 16, 0, 65]), asPub, ct); // rs = 4096, lunghezza dell'id = 65
}
async function vapidHeader(env, endpoint, subject) {
  const j = vapidJwk(env);
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: j.x, y: j.y, d: j.d }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${vapidPublic(env)}`;
}
// manda la notifica a tutti i telefoni iscritti (o a una sola sessione); le iscrizioni scadute (404/410) si cancellano
export async function notifyAdmins(env, msg, onlySession = null) {
  if (!vapidJwk(env)) return { inviate: 0, errori: 0 };
  const subs = (await env.DB.prepare(onlySession ? "SELECT * FROM admin_push WHERE session = ?" : "SELECT p.* FROM admin_push p JOIN admin_sessions s ON s.n = p.session WHERE s.revoked = 0")
    .bind(...(onlySession ? [onlySession] : [])).all()).results;
  const subject = env.PUSH_SUBJECT || env._origin || "https://mbvisual.invalid";
  let sent = 0, errs = 0;
  await Promise.all(subs.map(async s => {
    try {
      const r = await fetch(s.endpoint, { method: "POST", body: await encryptPush(s.p256dh, s.auth, JSON.stringify(msg)),
        headers: { authorization: await vapidHeader(env, s.endpoint, subject), "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "high" } });
      if (r.status === 404 || r.status === 410) await env.DB.prepare("DELETE FROM admin_push WHERE endpoint = ?").bind(s.endpoint).run();
      if (r.ok) sent++; else errs++;
    } catch { errs++; }
  }));
  return { inviate: sent, errori: errs };
}
export const pushFor = (kind, text, base) => ({ title: KIND[kind] || "MB Desk Admin", body: text, tag: kind + "-" + Date.now(),
  url: `${base}/#${["change_pending", "report", "change"].includes(kind) ? "richieste" : "panoramica"}` });
