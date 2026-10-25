// Collaudo dell'app per telefono di MB Desk Admin (src/adminapp.js) senza Cloudflare e senza telefono:
// accesso con codice e con codice di 6 cifre, tentativi sbagliati, sessione nel cookie, impronta/PIN (WebAuthn) con un
// autenticatore simulato (chiave P-256 come quelle di Android e iPhone), blocco e sblocco, notifiche push ricevute da un
// finto servizio push locale che verifica la firma VAPID e decifra il messaggio (RFC 8291).
//   node test/admin_mobile.mjs
import { createServer } from "node:http";
import worker from "../src/index.js";
import { makeEnv } from "./shim.mjs";

const env = makeEnv();
env.ADMIN_PATH = "percorso-segreto-di-prova-1234";
env._PROVA = true;
const vk = await crypto.subtle.exportKey("jwk", (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])).privateKey);
env.VAPID_JWK = JSON.stringify({ d: vk.d, x: vk.x, y: vk.y });
const P = "/" + env.ADMIN_PATH, ORIGIN = "https://admin.test";
const enc = new TextEncoder(), dec = new TextDecoder();
const b64u = b => Buffer.from(b).toString("base64url"), unb64u = s => new Uint8Array(Buffer.from(s, "base64url"));
const sha = async d => new Uint8Array(await crypto.subtle.digest("SHA-256", typeof d === "string" ? enc.encode(d) : d));
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
let fails = 0;
const ok = (c, label, extra = "") => { console.log(`${c ? "OK  " : "NO  "} ${label}${extra ? "  " + extra : ""}`); if (!c) fails++; };

let jar = "";
async function call(path, { method, body, cookie = jar, ip = "10.0.0.1", type = "application/json", bearer } = {}) {
  const headers = { "cf-connecting-ip": ip };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = type;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const r = await worker.fetch(new Request(ORIGIN + path, { method: method || (body === undefined ? "GET" : "POST"), headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await r.text();
  let d = {}; try { d = JSON.parse(text); } catch {}
  return { status: r.status, d, text, headers: r.headers };
}
const api = (p, body, o = {}) => call(`${P}/api/${p}`, { body, ...o });

// ---- pagine e indirizzo segreto
const page = await call(`${P}/`);
ok(page.status === 200 && page.text.includes("MB Desk Admin") && page.text.includes(`${P}/manifest.webmanifest`), "pagina dell'app all'indirizzo segreto");
ok(/noindex/.test(page.headers.get("x-robots-tag") || "") && (page.headers.get("referrer-policy") || "") === "no-referrer", "pagina non indicizzabile e senza Referer");
const other = await call("/percorso-sbagliato-di-prova/");
ok(!other.text.includes("MB Desk Admin"), "un altro percorso non mostra l'app di gestione");
const man = await call(`${P}/manifest.webmanifest`);
ok(man.d.start_url === `${P}/` && man.d.scope === `${P}/` && man.d.display === "standalone", "manifest installabile (solo su questo percorso)");
ok((await call(`${P}/icon-192.png`)).status === 200 && (await call(`${P}/sw.js`)).text.includes("showNotification"), "icone e service worker");

// ---- accesso
ok((await api("state")).d.accesso === false, "senza cookie: accesso richiesto");
ok((await api("admin/summary")).status === 401, "API di gestione senza accesso rifiutate");
for (let i = 0; i < 5; i++) await api("login", { code: "sbagliato" + i }, { ip: "1.1.1.1" });
const blocked = await api("login", { code: env.ADMIN_TOKEN }, { ip: "1.1.1.1" });
ok(blocked.status === 429, "dopo 5 codici sbagliati lo stesso indirizzo aspetta 15 minuti (anche col codice giusto)");
const login = await api("login", { code: env.ADMIN_TOKEN, name: "Android prova" });
const setc = login.headers.get("set-cookie") || "";
ok(login.d.ok && new RegExp(`mbv_a=[^;]+; Path=${P}/;.*HttpOnly; Secure; SameSite=Strict`).test(setc), "accesso con il codice: cookie HttpOnly solo sul percorso dell'app");
jar = setc.split(";")[0];
const st = (await api("state")).d;
ok(st.accesso && !st.impronta && !st.bloccata && st.notifiche.length > 80, "stato: dentro, senza impronta, chiave delle notifiche presente");
ok((await call(`${P}/api/admin/summary`, { body: {}, type: "text/plain" })).status === 415, "POST senza JSON rifiutata (niente richieste da altri siti)");
const sum = await api("admin/summary");
ok(sum.d.ok && typeof sum.d.licenze === "number", "riepilogo della gestione dall'app per telefono");
const nl = await api("admin/licenses", { customer: "Cliente telefono", max_pc: 1, max_mobile: 2 });
ok(/^MBV-/.test(nl.d.key), "licenza creata dal telefono", nl.d.key);
const evs = (await api("admin/events?after=0")).d.avvisi;
ok(evs.some(e => e.kind === "admin_login" && e.text.includes("Android prova")), "avviso dell'accesso alla gestione");

// ---- codice di 6 cifre dall'app per PC
ok((await call("/admin/pair", { body: {} })).status === 401, "codice di 6 cifre solo con il codice di gestione");
const pair = (await call("/admin/pair", { body: {}, bearer: env.ADMIN_TOKEN })).d;
ok(/^\d{6}$/.test(pair.codice) && pair.url === `${ORIGIN}${P}/?abbina=${pair.codice}`, "PC: codice di 6 cifre e link per il QR", pair.codice);
const pl = await api("login", { pair: pair.codice, name: "iPhone prova" }, { cookie: "" });
ok(pl.d.ok, "accesso con il codice di 6 cifre");
const jar2 = (pl.headers.get("set-cookie") || "").split(";")[0];
ok((await api("login", { pair: pair.codice }, { cookie: "", ip: "2.2.2.2" })).status === 401, "codice di 6 cifre usabile una volta sola");

// ---- impronta / PIN: autenticatore simulato
const ce = v => { // CBOR minimo per l'attestazione simulata
  const head = (mt, n) => n < 24 ? [mt << 5 | n] : n < 256 ? [mt << 5 | 24, n] : [mt << 5 | 25, n >> 8, n & 255];
  if (v instanceof Uint8Array) return cat(new Uint8Array(head(2, v.length)), v);
  if (typeof v === "string") { const b = enc.encode(v); return cat(new Uint8Array(head(3, b.length)), b); }
  if (typeof v === "number") return new Uint8Array(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (v instanceof Map) return cat(new Uint8Array(head(5, v.size)), ...[...v].flatMap(([k, x]) => [ce(k), ce(x)]));
  throw new Error("tipo");
};
const toDer = raw => { const int = b => { let i = 0; while (i < 31 && b[i] === 0) i++; b = b.slice(i); if (b[0] & 0x80) b = cat(new Uint8Array([0]), b); return cat(new Uint8Array([2, b.length]), b); };
  const r = int(raw.slice(0, 32)), s = int(raw.slice(32)); return cat(new Uint8Array([0x30, r.length + s.length]), r, s); };
const auth = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = await crypto.subtle.exportKey("jwk", auth.publicKey);
const credId = crypto.getRandomValues(new Uint8Array(32));
const rpHash = await sha("admin.test");
const ro = (await api("wa/reg-options", {})).d.publicKey;
ok(ro.rp.id === "admin.test" && ro.authenticatorSelection.userVerification === "required", "opzioni di registrazione: questo server, impronta/PIN obbligatori");
const cose = ce(new Map([[1, 2], [3, -7], [-1, 1], [-2, unb64u(pub.x)], [-3, unb64u(pub.y)]]));
const regAd = cat(rpHash, new Uint8Array([0x45, 0, 0, 0, 0]), new Uint8Array(16), new Uint8Array([0, credId.length]), credId, cose);
const regCd = enc.encode(JSON.stringify({ type: "webauthn.create", challenge: ro.challenge, origin: ORIGIN }));
const reg = await api("wa/reg", { clientDataJSON: b64u(regCd), attestationObject: b64u(ce(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", regAd]]))) });
ok(reg.d.ok, "impronta registrata", reg.d.errore || "");
ok((await api("wa/reg", { clientDataJSON: b64u(regCd), attestationObject: "AA" })).status === 400, "stessa richiesta di registrazione non riusabile");
let s2 = (await api("state")).d;
ok(s2.impronta && !s2.bloccata, "dopo la registrazione: protetta e sbloccata");
await api("lock", {});
ok((await api("state")).d.bloccata, "Blocca ora: app bloccata");
ok((await api("admin/summary")).status === 423, "bloccata: le API di gestione rispondono 423");
let counter = 0;
async function assertion({ origin = ORIGIN, flags = 0x05, count = ++counter, reuse } = {}) {
  const o = reuse || (await api("wa/unlock-options", {})).d.publicKey;
  const ad = cat(rpHash, new Uint8Array([flags, count >>> 24, (count >> 16) & 255, (count >> 8) & 255, count & 255]));
  const cd = enc.encode(JSON.stringify({ type: "webauthn.get", challenge: o.challenge, origin }));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, auth.privateKey, cat(ad, await sha(cd))));
  return { o, res: await api("wa/unlock", { id: b64u(credId), clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(toDer(sig)) }) };
}
ok((await assertion({ origin: "https://altro.sito" })).res.status === 401, "sblocco da un'altra origine rifiutato");
ok((await assertion({ flags: 0x01 })).res.status === 401, "sblocco senza impronta/PIN (solo presenza) rifiutato");
const good = await assertion();
ok(good.res.d.ok && !(await api("state")).d.bloccata, "sblocco con impronta/PIN");
ok((await assertion({ reuse: good.o })).res.status === 401, "richiesta di sblocco non riusabile");
ok((await assertion({ count: 1 })).res.status === 401, "contatore che non sale rifiutato (credenziale copiata)");
ok((await api("admin/summary")).d.ok, "sbloccata: gestione di nuovo disponibile");
ok((await api("state", undefined, { cookie: jar2 })).d.impronta === false, "l'impronta vale solo per il telefono che l'ha registrata");

// ---- notifiche push: finto servizio push locale
const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const uaPub = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
const authSecret = crypto.getRandomValues(new Uint8Array(16));
const received = [];
let reply = 201;
const hkdf = async (salt, ikm, info, n) => new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
const srv = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = new Uint8Array(Buffer.concat(chunks));
  try {
    const [, t, k] = (req.headers.authorization || "").match(/^vapid t=([^,]+), k=(.+)$/);
    const [h, p, s] = t.split(".");
    const kb = unb64u(k);
    const vkey = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: b64u(kb.slice(1, 33)), y: b64u(kb.slice(33)) }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const vapidOk = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, vkey, unb64u(s), enc.encode(`${h}.${p}`));
    const claims = JSON.parse(dec.decode(unb64u(p)));
    const salt = body.slice(0, 16), asPub = body.slice(21, 86);
    const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256));
    const ikm = await hkdf(authSecret, secret, cat(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
    const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16), nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), body.slice(86)));
    received.push({ vapidOk, claims, enc: req.headers["content-encoding"], msg: JSON.parse(dec.decode(plain.slice(0, plain.lastIndexOf(2)))) });
  } catch (e) { received.push({ errore: String(e) }); }
  res.writeHead(reply); res.end();
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const ep = `http://127.0.0.1:${srv.address().port}/iscrizione-1`;
ok((await api("push/sub", { endpoint: ep, keys: { p256dh: b64u(uaPub), auth: b64u(authSecret) } })).d.ok, "telefono iscritto alle notifiche");
const pt = (await api("push/test", {})).d;
const first = received.at(-1) || {};
ok(pt.inviate === 1 && first.vapidOk && first.enc === "aes128gcm" && first.msg?.body?.includes("funzionano"), "notifica di prova: firma VAPID valida e messaggio decifrato", first.errore || "");
ok(first.claims?.aud === new URL(ep).origin && first.claims?.sub === ORIGIN, "VAPID: destinatario = servizio push, mittente = indirizzo del server");
const act = await call("/v1/activate", { body: { key: nl.d.key, device: "pc-prova", kind: "pc", name: "PC ufficio" } });
const last = received.at(-1) || {};
ok(act.d.ok && last.msg?.title === "Nuovo PC attivato" && last.msg?.body?.includes("PC ufficio") && last.msg?.url === `${P}/#panoramica`, "attivazione di un PC -> notifica sul telefono", last.msg?.body || "");
reply = 410;
await api("push/test", {});
reply = 201;
const before = received.length;
await api("push/test", {});
ok(received.length === before, "iscrizione scaduta (410) cancellata dal server");

// ---- notifiche a scelta
await api("push/sub", { endpoint: ep + "-bis", keys: { p256dh: b64u(uaPub), auth: b64u(authSecret) } }); // la prima iscrizione e' stata cancellata (410)
const nOn = received.length;
await call("/v1/activate", { body: { key: nl.d.key, device: "tel-rumore", kind: "mobile", name: "Tel con notifica" } });
ok(received.length === nOn + 1 && received.at(-1).msg.title === "Nuovo cellulare attivato", "notifica accesa: push del nuovo cellulare");
const st0 = (await api("admin/settings")).d;
ok(st0.notifiche.activation_pc === true && st0.tipi.includes("expiring") && st0.tipi.includes("activation_mobile"), "impostazioni: tutte le notifiche attive all'inizio");
await api("admin/settings", { notifiche: { ...st0.notifiche, activation_mobile: false } });
const nAct = received.length;
await call("/v1/activate", { body: { key: nl.d.key, device: "tel-silenzio", kind: "mobile", name: "Tel silenzioso" } });
ok(received.length === nAct && (await api("admin/events?after=0")).d.avvisi.some(e => e.kind === "activation_mobile"), "notifica spenta: nessun push, l'avviso resta nell'elenco");
ok((await call("/admin/settings", { bearer: env.ADMIN_TOKEN })).d.notifiche.activation_mobile === false, "le scelte valgono anche per l'app per PC (stesse impostazioni sul server)");
const over = await call("/v1/activate", { body: { key: nl.d.key, device: "pc-2b", kind: "pc", name: "PC due" } });
ok(over.status === 409 && received.at(-1).msg.title === "Limite raggiunto", "PC oltre il limite: rifiutato, con notifica (tentativi oltre il limite)");

// ---- numero di PC e cellulari modificabile con la licenza in uso
const lic0 = () => api("admin/licenses").then(r => r.d.licenze.find(l => l.key === nl.d.key));
const up = (b) => api(`admin/licenses/${nl.d.key}/update`, b);
ok((await up({ max_pc: 2, max_mobile: 2 })).d.ok, "aumento a 2 PC");
const pc2 = await call("/v1/activate", { body: { key: nl.d.key, device: "pc-2b", kind: "pc", name: "PC due" } });
ok(pc2.d.ok, "posto nuovo subito disponibile: secondo PC attivato");
const down = await up({ max_pc: 1, max_mobile: 2 });
ok(down.status === 409 && down.d.stato === "troppi_dispositivi" && down.d.pc_attivi === 2, "riduzione sotto i PC attivi senza sceglierli: rifiutata con i conteggi", down.d.errore);
const pcs = (await lic0()).dispositivi.filter(d => d.kind === "pc" && d.status === "active");
const down2 = await up({ max_pc: 1, max_mobile: 2, free: [pcs[1].id] });
ok(down2.d.ok && down2.d.liberati === 1, "riduzione con il PC scelto da disattivare");
ok((await call("/v1/check", { body: { token: pc2.d.token } })).d.stato === "dispositivo_revocato", "il PC disattivato si blocca");
const pcTok = act.d.token;
let ml = (await call("/v1/mlink", { body: { token: pcTok } })).d;
const before2 = ml.liberi;
await up({ max_pc: 1, max_mobile: 4 });
ml = (await call("/v1/mlink", { body: { token: pcTok } })).d;
ok(ml.liberi === before2 + 2 && ml.totali === 4, "QR del PC: posti per i cellulari aggiornati subito", `${before2} -> ${ml.liberi}`);
ok((await lic0()).customer === "Cliente telefono", "modifica dei limiti senza perdere gli altri dati");

// ---- scadenza: avvisi una volta sola
await up({ max_pc: 1, max_mobile: 4, expires: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) });
ok(/23:59:59$/.test((await lic0()).expires), "scadenza dal campo data: fino a fine giornata");
const nExp = received.length;
await worker._expiryCheck(env); await worker._expiryCheck(env);
let av = (await api("admin/events?after=0")).d.avvisi.filter(e => e.license_key === nl.d.key && e.kind === "expiring");
ok(av.length === 1 && received.length === nExp + 1 && received.at(-1).msg.title === "Licenza in scadenza", "licenza in scadenza: un avviso e una notifica");
env._db.prepare("UPDATE licenses SET expires = datetime('now','-1 hours') WHERE key = ?").run(nl.d.key);
await worker._expiryCheck(env); await worker._expiryCheck(env);
av = (await api("admin/events?after=0")).d.avvisi.filter(e => e.license_key === nl.d.key && e.kind === "expired");
ok(av.length === 1, "licenza scaduta: un avviso");
await up({ max_pc: 1, max_mobile: 4, expires: "" });
ok((await lic0()).expires === null && (await call("/v1/check", { body: { token: pcTok } })).d.ok, "scadenza tolta: la licenza torna valida");

// ---- licenze: data della prima attivazione, eliminazione singola e in blocco
const lics1 = (await api("admin/licenses")).d.licenze;
const withDev = lics1.find(l => l.key === nl.d.key);
ok(withDev.prima_attivazione && withDev.prima_attivazione <= withDev.dispositivi.map(d => d.activated).sort()[0], "elenco licenze: data della prima attivazione", withDev.prima_attivazione);
const del1 = (await api("admin/licenses", { customer: "prova da cancellare 1" })).d.key, del2 = (await api("admin/licenses", { customer: "test da cancellare 2" })).d.key;
const delTok = (await call("/v1/activate", { body: { key: del1, device: "pc-del", kind: "pc", name: "PC del" } })).d.token;
ok((await api(`admin/licenses/${del1}/delete`, {})).d.ok, "licenza eliminata");
ok(!(await api("admin/licenses")).d.licenze.some(l => l.key === del1), "la licenza eliminata non compare piu'");
ok((await call("/v1/check", { body: { token: delTok } })).status === 404, "il PC della licenza eliminata si blocca");
const bulk = (await api("admin/licenses/delete", { keys: [del2, "MBV-INESI-STENT-EEEEE-EEEEE"] })).d;
ok(bulk.ok && !(await api("admin/licenses")).d.licenze.some(l => l.key === del2), "eliminazione in blocco");

// ---- Panoramica: archivio e lettura per gruppo
let evAll = (await api("admin/events?after=0")).d.avvisi;
const two = evAll.slice(-2).map(e => e.id);
ok((await api("admin/events/read", { ids: two })).d.ok && (await api("admin/events?after=0")).d.avvisi.filter(e => two.includes(e.id)).every(e => e.read === 1), "segna come letti un gruppo di avvisi");
await api("admin/events/archive", { ids: two });
evAll = (await api("admin/events?after=0")).d.avvisi;
const arch = (await api("admin/events?after=0&archiviati=1")).d.avvisi;
ok(!evAll.some(e => two.includes(e.id)) && two.every(id => arch.some(e => e.id === id)), "archivia un gruppo: esce dall'elenco e va nell'archivio");
await api("admin/events/archive", { ids: [two[0]], archivia: false });
ok((await api("admin/events?after=0")).d.avvisi.some(e => e.id === two[0]), "ripristino dall'archivio");
ok((await call(`/admin/events?after=${two[0] - 1}`, { bearer: env.ADMIN_TOKEN })).d.avvisi.some(e => e.id === two[1]), "app per PC: i nuovi avvisi arrivano anche se archiviati (notifiche)");

// ---- testo dell'email con la chiave
const em0 = (await api("admin/settings")).d;
ok(em0.email.testo.includes("{chiave}") && em0.link_setup === `${ORIGIN}/scarica` && em0.link_telefono === `${ORIGIN}/` && !/lorenz/i.test(JSON.stringify(em0)), "email: testo preimpostato con chiave, link del setup e del telefono (senza nomi personali)");
await api("admin/settings", { email: { oggetto: "Chiave MB Desk", testo: "Ciao {cliente}: {chiave}" } });
const em1 = (await api("admin/settings")).d;
ok(em1.email.oggetto === "Chiave MB Desk" && em1.email.testo === "Ciao {cliente}: {chiave}" && em1.notifiche.activation_pc !== undefined, "email: testo modificato salvato (notifiche invariate)");
ok((await call("/scarica")).status === 404, "/scarica senza repository configurato: 404 chiaro");

// ---- telefoni collegati, uscita
const tel = (await api("sessions")).d.telefoni;
ok(tel.length === 2 && tel.find(t => t.questo)?.impronta === true, "elenco dei telefoni collegati (2, questo con impronta)");
const other2 = tel.find(t => !t.questo);
await api(`sessions/${other2.n}/revoke`, {});
ok((await api("admin/summary", undefined, { cookie: jar2 })).status === 401, "telefono scollegato: il suo cookie non vale piu'");
const out = await api("logout", {});
ok(/mbv_a=; .*Max-Age=0/.test(out.headers.get("set-cookie") || "") && (await api("admin/summary")).status === 401, "uscita: cookie cancellato e sessione chiusa");
ok((await call("/admin/summary", { bearer: env.ADMIN_TOKEN })).d.ok, "app per PC invariata (codice di gestione)");

srv.close();
console.log(fails ? `\n${fails} prove NON riuscite` : "\nTutte le prove riuscite");
process.exit(fails ? 1 : 0);
