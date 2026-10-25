// Banco di prova del server delle licenze senza Cloudflare: esegue src/index.js con un database SQLite di Node
// (node:sqlite) che imita D1. Serve perche' il motore locale di Cloudflare (workerd) non esiste per Windows ARM64.
//   node test/harness.mjs            collaudo completo (database in memoria)
//   node test/harness.mjs serve 8787 server locale su http://127.0.0.1:8787 (database in %USERPROFILE%\.mbvisual\server-prova, fuori da OneDrive)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { homedir, userInfo } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

import { makeEnv, assets } from "./shim.mjs";

if (process.argv[2] === "serve") {
  const dir = join(homedir(), ".mbvisual", "server-prova");
  mkdirSync(dir, { recursive: true });
  const pub = join(homedir(), ".mbvisual", "server", "public");
  const env = makeEnv(join(dir, "prova.sqlite"), existsSync(pub) ? pub : null);
  // app per telefono di MB Desk Admin: http://127.0.0.1:<porta>/<percorso>/ (in prova senza https: il cookie Secure vale anche su 127.0.0.1)
  env.ADMIN_PATH = process.env.MBV_ADMIN_PATH || "gestione-prova-locale-0000";
  const vk = await crypto.subtle.exportKey("jwk", (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])).privateKey);
  env.VAPID_JWK = JSON.stringify({ d: vk.d, x: vk.x, y: vk.y });
  const port = +(process.argv[3] || 8787);
  createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await worker.fetch(new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  }).listen(port, "127.0.0.1", () => console.log(`server licenze di prova su http://127.0.0.1:${port}`));
} else {
  // ---- collaudo
  const env = makeEnv();
  let fails = 0;
  const call = async (path, body, admin = false) => {
    const r = await worker.fetch(new Request("http://x" + path, { method: body === undefined ? "GET" : "POST", headers: admin ? { authorization: `Bearer ${env.ADMIN_TOKEN}` } : {}, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    return { status: r.status, ...(await r.json()) };
  };
  const ok = (cond, label, extra = "") => { console.log(`${cond ? "OK  " : "NO  "} ${label}${extra ? "  " + extra : ""}`); if (!cond) fails++; };

  const adminNo = await call("/admin/licenses", undefined);
  ok(adminNo.status === 401, "gestione senza codice rifiutata");
  const { key } = await call("/admin/licenses", { customer: "Rossi srl", email: "a@b.it" }, true);
  ok(/^MBV(-[2-9A-HJ-NP-Z]{5}){4}$/.test(key), "licenza creata", key);

  const pc1 = await call("/v1/activate", { key: key.toLowerCase().replace(/-/g, " "), device: "pc-1", kind: "pc", name: "PC ufficio" });
  ok(pc1.ok && pc1.token, "attivazione PC (chiave scritta in minuscolo e con spazi)");
  const pc1b = await call("/v1/activate", { key, device: "pc-1", kind: "pc", name: "PC ufficio" });
  ok(pc1b.ok, "stesso PC riattivato senza occupare un altro posto");
  const pc2 = await call("/v1/activate", { key, device: "pc-2", kind: "pc", name: "PC casa" });
  ok(pc2.status === 409 && pc2.stato === "limite", "secondo PC rifiutato", pc2.errore);
  const m1 = await call("/v1/activate", { key, device: "tel-1", kind: "mobile", name: "iPhone" });
  const m2 = await call("/v1/activate", { key, device: "tel-2", kind: "mobile", name: "Android" });
  const m3 = await call("/v1/activate", { key, device: "tel-3", kind: "mobile", name: "Tablet" });
  ok(m1.ok && m2.ok && m3.status === 409, "2 cellulari accettati, il terzo rifiutato");
  const bad = await call("/v1/activate", { key: "MBV-AAAAA-AAAAA-AAAAA-AAAAA", device: "x", kind: "pc" });
  ok(bad.status === 404, "chiave inesistente rifiutata");

  const chk = await call("/v1/check", { token: pc1.token, version: "1.3.7" });
  ok(chk.ok && chk.token, "controllo periodico: attivazione rinnovata");
  const forged = pc1.token.slice(0, -4) + (pc1.token.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
  ok((await call("/v1/check", { token: forged })).status === 401, "attivazione falsificata rifiutata");
  const payload = JSON.parse(Buffer.from(pc1.token.split(".")[0], "base64url"));
  ok(payload.exp - payload.iat === 30 * 86400 && payload.d === "pc-1", "attivazione valida 30 giorni e legata al PC");

  const acc = await call("/v1/account", { token: pc1.token });
  ok(acc.ok && acc.dispositivi.length === 3 && acc.dispositivi.some(d => d.questo) && acc.cambi_rimasti === 3, "account: 3 dispositivi, 3 cambi rimasti");

  const rep = await call("/v1/request", { token: m1.token, type: "report", message: "Il PDF non si apre" });
  ok(rep.ok, "segnalazione inviata");

  // cambio dispositivo: chiave nuova, vecchia sostituita, tutti i dispositivi della vecchia bloccati
  const ch1 = await call("/v1/request", { token: pc1.token, type: "change", message: "PC nuovo" });
  ok(ch1.ok && ch1.nuova_chiave && ch1.nuova_chiave !== key, "cambio dispositivo: chiave nuova", ch1.nuova_chiave);
  const old = await call("/v1/check", { token: pc1.token });
  ok(old.status === 410 && old.stato === "sostituita", "vecchio PC bloccato (chiave sostituita)");
  const oldTel = await call("/v1/check", { token: m2.token });
  ok(oldTel.status === 410, "vecchio cellulare bloccato");
  const oldAct = await call("/v1/activate", { key, device: "pc-9", kind: "pc" });
  ok(oldAct.status === 410, "la vecchia chiave non attiva piu' nulla");
  const nk = ch1.nuova_chiave;
  const pcNew = await call("/v1/activate", { key: nk, device: "pc-2", kind: "pc", name: "PC nuovo" });
  const telAgain = await call("/v1/activate", { key: nk, device: "tel-1", kind: "mobile", name: "iPhone" });
  ok(pcNew.ok && telAgain.ok, "chiave nuova attivata su PC nuovo e sul cellulare tenuto");

  // cambio dalla schermata di attivazione (dispositivo perso: solo la chiave)
  const ch2 = await call("/v1/request", { key: nk, type: "change", message: "PC rubato" });
  ok(ch2.ok && ch2.nuova_chiave, "cambio con la sola chiave (senza app attivata)");
  const ch3 = await call("/v1/request", { key: ch2.nuova_chiave, type: "change" });
  ok(ch3.ok && ch3.nuova_chiave, "terzo cambio dell'anno ancora automatico");
  const ch4 = await call("/v1/request", { key: ch3.nuova_chiave, type: "change", message: "ancora" });
  ok(ch4.ok && ch4.in_attesa && !ch4.nuova_chiave, "quarto cambio: in attesa di approvazione");
  const reqs = await call("/admin/requests", undefined, true);
  const pend = reqs.richieste.find(r => r.status === "pending");
  ok(!!pend, "richiesta in attesa visibile nella gestione");
  const appr = await call(`/admin/requests/${pend.id}/approve`, {}, true);
  ok(appr.ok && appr.key, "approvazione: chiave nuova generata", appr.key);
  ok((await call("/v1/activate", { key: ch3.nuova_chiave, device: "z", kind: "pc" })).status === 410, "dopo l'approvazione la chiave precedente e' sostituita");

  // revoca e riattivazione dalla gestione
  const cur = appr.key;
  const act = await call("/v1/activate", { key: cur, device: "pc-5", kind: "pc" });
  await call(`/admin/licenses/${cur}/revoke`, {}, true);
  ok((await call("/v1/check", { token: act.token })).status === 403, "licenza revocata: app bloccata");
  await call(`/admin/licenses/${cur}/reactivate`, {}, true);
  ok((await call("/v1/check", { token: act.token })).ok, "licenza riattivata: app di nuovo attiva");
  const lic = (await call("/admin/licenses", undefined, true)).licenze.find(l => l.key === cur);
  const dev = lic.dispositivi.find(d => d.status === "active");
  await call(`/admin/devices/${dev.id}/revoke`, {}, true);
  ok((await call("/v1/check", { token: act.token })).stato === "dispositivo_revocato", "dispositivo liberato dalla gestione");
  ok((await call("/v1/activate", { key: cur, device: "pc-6", kind: "pc" })).ok, "posto PC di nuovo disponibile");

  const sum = await call("/admin/summary", undefined, true);
  const ev = await call("/admin/events?after=0", undefined, true);
  ok(sum.ok && ev.avvisi.length > 5, "riepilogo e avvisi", `${ev.avvisi.length} avvisi; tipi: ${[...new Set(ev.avvisi.map(e => e.kind))].join(", ")}`);
  await call("/admin/events/read", { upto: ev.avvisi.at(-1).id }, true);
  ok((await call("/admin/summary", undefined, true)).avvisi_non_letti === 0, "avvisi segnati come letti");

  // ---- app per cellulari: file consegnati solo con attivazione "mobile" nel cookie
  const pub = join(tmpdir(), "mbv-pub-prova");
  mkdirSync(join(pub, "js"), { recursive: true }); mkdirSync(join(pub, "img"), { recursive: true });
  writeFileSync(join(pub, "index.html"), "<html>APP VERA</html>"); writeFileSync(join(pub, "js", "app.js"), "// codice");
  writeFileSync(join(pub, "manifest.webmanifest"), "{}"); writeFileSync(join(pub, "img", "icon-192.png"), "png");
  env.ASSETS = assets(pub);
  const get = (path, cookie) => worker.fetch(new Request("https://x" + path, { headers: { accept: path.endsWith(".js") ? "*/*" : "text/html", ...(cookie ? { cookie } : {}) } }), env);
  const home = await (await get("/")).text();
  ok(home.includes("installata") && !home.includes("APP VERA"), "senza attivazione: pagina di attivazione al posto dell'app");
  ok((await get("/js/app.js")).status === 401, "senza attivazione: codice dell'app non consegnato");
  ok((await get("/manifest.webmanifest")).status === 200 && (await get("/img/icon-192.png")).status === 200, "manifest e icone pubblici (installazione)");
  const nl = (await call("/admin/licenses", { customer: "Cellulari" }, true)).key;
  const ra = await worker.fetch(new Request("https://x/v1/activate", { method: "POST", body: JSON.stringify({ key: nl, device: "uuid-1", kind: "mobile", name: "Android" }) }), env);
  const ck = (ra.headers.get("set-cookie") || "").split(";")[0];
  ok(ck.startsWith("mbv_m=") && /HttpOnly/.test(ra.headers.get("set-cookie")), "attivazione del cellulare: cookie protetto");
  ok((await (await get("/", ck)).text()).includes("APP VERA") && (await get("/js/app.js", ck)).status === 200, "con attivazione: app consegnata");
  ok(!(await (await get("/attiva", ck)).text()).includes("APP VERA"), "/attiva mostra sempre la pagina di attivazione");
  const pcTok = (await call("/v1/activate", { key: nl, device: "pc-x", kind: "pc" })).token;
  ok(!(await (await get("/", "mbv_m=" + pcTok)).text()).includes("APP VERA"), "un'attivazione da PC non apre l'app per cellulari");
  const rc = await worker.fetch(new Request("https://x/v1/check", { method: "POST", headers: { cookie: ck }, body: "{}" }), env);
  ok(rc.ok && /mbv_m=[^;]+/.test(rc.headers.get("set-cookie") || ""), "rinnovo dal cellulare tramite cookie");
  const acc2 = await (await worker.fetch(new Request("https://x/v1/account", { method: "POST", headers: { cookie: ck }, body: "{}" }), env)).json();
  ok(acc2.ok && acc2.dispositivi.some(d => d.questo && d.kind === "mobile"), "account dal cellulare tramite cookie");
  const rch = await worker.fetch(new Request("https://x/v1/request", { method: "POST", headers: { cookie: ck }, body: JSON.stringify({ type: "change" }) }), env);
  const dch = await rch.clone().json();
  ok(dch.nuova_chiave && /Max-Age=0/.test(rch.headers.get("set-cookie") || ""), "cambio dal cellulare: chiave nuova e cookie tolto");
  const rc2 = await worker.fetch(new Request("https://x/v1/check", { method: "POST", headers: { cookie: ck }, body: "{}" }), env);
  ok(rc2.status === 410 && /Max-Age=0/.test(rc2.headers.get("set-cookie") || ""), "vecchio cellulare: licenza sostituita, cookie tolto");

  // ---- QR della home del PC: link monouso, blocco, limite, codice di 6 cifre
  const post = async (path, body, cookie) => { const r = await worker.fetch(new Request("https://lic.test" + path, { method: "POST", headers: cookie ? { cookie } : {}, body: JSON.stringify(body) }), env); return { r, d: await r.clone().json() }; };
  const qk = (await call("/admin/licenses", { customer: "QR" }, true)).key;
  const qpc = (await call("/v1/activate", { key: qk, device: "pc-qr", kind: "pc" })).token;
  let ml = (await post("/v1/mlink", { token: qpc })).d;
  ok(ml.ok && ml.liberi === 2 && ml.totali === 2 && /^https:\/\/lic\.test\/l\/[A-Za-z0-9_-]{30,}$/.test(ml.url), "QR: link monouso, 2 cellulari liberi", ml.url);
  ok((await post("/v1/mlink", { token: qpc })).d.url === ml.url, "QR: stesso link finche' non e' usato o scaduto");
  const page = await get(new URL(ml.url).pathname);
  const pageText = await page.text();
  ok(page.status === 200 && pageText.includes("/v1/mlink/claim") && pageText.includes("Copia link") && pageText.includes("x-safari-"), "QR: pagina del telefono pubblica (con Apri in Safari / Copia link)");
  const lp = pageText.match(/<script>([\s\S]*)<\/script>/)[1];
  ok(lp.includes("CriOS") && /GSA\\\//.test(lp), "QR: la pagina riconosce i browser sbagliati (espressioni intatte)");
  const linkTok = ml.url.split("/").pop();
  // due telefoni aprono lo stesso link nello stesso istante: ne passa uno solo
  const [c1, c2] = await Promise.all([post("/v1/mlink/claim", { link: linkTok, device: "tel-a", name: "Android A" }), post("/v1/mlink/claim", { link: linkTok, device: "tel-b", name: "Android B" })]);
  const okOne = [c1, c2].filter(x => x.d.ok);
  ok(okOne.length === 1, "QR: lo stesso link attiva un solo telefono anche con richieste contemporanee", [c1, c2].map(x => x.r.status).join("/"));
  const claimed = okOne[0];
  ok(/^\d{6}$/.test(claimed.d.codice) && /mbv_m=[^;]+/.test(claimed.r.headers.get("set-cookie") || ""), "QR: telefono attivato (cookie) + codice di 6 cifre");
  ml = (await post("/v1/mlink", { token: qpc })).d;
  ok(ml.liberi === 1 && !ml.url && ml.attesa_fino > Date.now() + 30000, "QR: dopo l'attivazione 1 libero e blocco di 1 minuto senza link");
  env._db.prepare("INSERT INTO mobile_links (token, license_key, expires) VALUES ('altro-link-di-prova-123456789', ?, datetime('now','+10 minutes'))").run(qk);
  ok((await post("/v1/mlink/claim", { link: "altro-link-di-prova-123456789", device: "tel-c" })).r.status === 429, "QR: durante il blocco il server rifiuta altre attivazioni via link");
  // stesso telefono, altro browser (iPhone: aperto prima in Chrome, poi in Safari): il link vale ancora e il posto si sposta
  const again = await post("/v1/mlink/claim", { link: linkTok, device: "tel-z", name: "iPhone Safari" });
  const mobNow = (await call("/admin/licenses", undefined, true)).licenze.find(l => l.key === qk).dispositivi.filter(d => d.kind === "mobile" && d.status === "active");
  ok(again.d.ok && /^\d{6}$/.test(again.d.codice) && mobNow.length === 1 && mobNow[0].device === "tel-z", "QR: link riaperto da un altro browser entro 20 minuti: stesso posto, nessun posto in piu'");
  env._db.prepare("UPDATE mobile_links SET used = datetime('now','-30 minutes') WHERE token = ?").run(linkTok);
  ok((await post("/v1/mlink/claim", { link: linkTok, device: "tel-y" })).r.status === 410, "QR: link gia' usato da piu' di 20 minuti rifiutato");
  env._db.prepare("UPDATE mobile_links SET used = datetime('now') WHERE token = ?").run(linkTok);
  // browser che non installano l'app: rifiutati SENZA consumare il link
  const UA = { safari: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    chromeIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1",
    googleApp: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/333.0.676048549 Mobile/15E148 Safari/604.1",
    inApp: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
    android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
    androidWv: "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36" };
  const qk2 = (await call("/admin/licenses", { customer: "QR iPhone", max_mobile: 3 }, true)).key;
  const qpc2 = (await call("/v1/activate", { key: qk2, device: "pc-qr2", kind: "pc" })).token;
  const tok2 = (await post("/v1/mlink", { token: qpc2 })).d.url.split("/").pop();
  const claimUa = (ua, device) => worker.fetch(new Request("https://lic.test/v1/mlink/claim", { method: "POST", headers: { "user-agent": ua }, body: JSON.stringify({ link: tok2, device, name: "iPhone" }) }), env).then(async r => ({ status: r.status, d: await r.json() }));
  for (const [k, label] of [["chromeIos", "Chrome su iPhone"], ["googleApp", "app Google su iPhone"], ["inApp", "browser interno di un'app su iPhone"], ["androidWv", "browser interno di un'app su Android"]]) {
    const r = await claimUa(UA[k], "dev-" + k);
    ok(r.status === 403 && r.d.stato === "browser", `QR: ${label} rifiutato senza usare il link`, r.d.errore);
  }
  const sf = await claimUa(UA.safari, "dev-safari");
  ok(sf.d.ok && !sf.d.gia_attivo, "QR: poi Safari sullo stesso iPhone attiva normalmente (link ancora valido)");
  const lk = (await call("/admin/licenses", undefined, true)).licenze.find(l => l.key === qk2).dispositivi.filter(d => d.kind === "mobile" && d.status === "active");
  ok(lk.length === 1, "QR: un solo posto occupato dopo i tentativi dai browser sbagliati");
  ok((await claimUa(UA.android, "dev-android")).d.gia_attivo === true, "QR: Chrome su Android riapre il link entro 20 minuti senza prendere un altro posto");
  // codice di 6 cifre: l'app installata (iPhone) prende il posto del browser, senza posti in piu'
  const pr = await post("/v1/mlink/pair", { code: claimed.d.codice, device: "tel-a-app", name: "iPhone app" });
  ok(pr.d.ok && /mbv_m=/.test(pr.r.headers.get("set-cookie") || ""), "QR: codice di 6 cifre nell'app installata");
  ok((await post("/v1/mlink/pair", { code: claimed.d.codice, device: "tel-x" })).r.status === 410, "QR: codice usabile una volta sola");
  const mob = (await call("/admin/licenses", undefined, true)).licenze.find(l => l.key === qk).dispositivi.filter(d => d.kind === "mobile" && d.status === "active");
  ok(mob.length === 1 && mob[0].device === "tel-a-app", "QR: un solo cellulare occupato dopo l'abbinamento");
  // fine del blocco (simulata) -> secondo cellulare -> QR esaurito
  env._db.prepare("UPDATE licenses SET mobile_lock = datetime('now','-6 minutes') WHERE key = ?").run(qk);
  ml = (await post("/v1/mlink", { token: qpc })).d;
  ok(ml.liberi === 1 && ml.url && ml.url.split("/").pop() !== linkTok, "QR: dopo il blocco un link nuovo");
  ok((await post("/v1/mlink/claim", { link: ml.url.split("/").pop(), device: "tel-d", name: "Android D" })).d.ok, "QR: secondo cellulare attivato");
  env._db.prepare("UPDATE licenses SET mobile_lock = datetime('now','-6 minutes') WHERE key = ?").run(qk);
  ml = (await post("/v1/mlink", { token: qpc })).d;
  ok(ml.ok && ml.liberi === 0 && !ml.url, "QR: posti esauriti -> nessun link (il QR sparisce)");
  env._db.prepare("INSERT INTO mobile_links (token, license_key, expires) VALUES ('link-oltre-il-limite-12345678', ?, datetime('now','+10 minutes'))").run(qk);
  ok((await post("/v1/mlink/claim", { link: "link-oltre-il-limite-12345678", device: "tel-e" })).r.status === 409, "QR: oltre il limite il server rifiuta");
  const mtry = await post("/v1/mlink", { token: pr.d.token });
  ok(mtry.r.status === 403 && /PC/.test(mtry.d.errore), "QR: un cellulare non puo' generare il QR");

  // ---- statistiche d'uso anonime (solo con consenso, inviate dall'app): pacchetti per giorno, revoca, conservazione, riepilogo
  const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const instA = "a".repeat(32), instB = "0123456789abcdef0123456789abcdef";
  const pkt = (inst, days) => call("/v1/stats", { inst, days });
  const dA = { day: day(1), app: "pc", version: "1.6.3", os: "Windows 11", arch: "ARM64", lang: "it", launches: 2, seconds: 3600, comps: ["office", "cad"],
    exts: { pdf: 5, dwg: 2 }, funcs: { stampa: 1, "nav.clash": 2 }, errors: { "cad2d|TypeError|dwg": 1 } };
  const s1 = await pkt(instA, [dA, { ...dA, day: day(2), version: "1.6.2", exts: { pdf: 1 } }]);
  ok(s1.ok && s1.ricevuti === 2, "statistiche: pacchetto di 2 giorni ricevuto");
  ok((await pkt(instA, [dA])).ok && env._db.prepare("SELECT COUNT(*) n FROM usage_days WHERE inst = ?").get(instA).n === 2, "statistiche: giorno rimandato sostituito (niente doppi)");
  ok((await pkt(cur, [dA])).status === 400, "statistiche: identificativo non casuale (es. chiave di licenza) rifiutato");
  await pkt(instB, [{ day: day(0), app: "mac", version: "1.6.3", os: "macOS 15", arch: "arm64", lang: "en", launches: 1, seconds: 60,
    exts: { pdf: 1, "C:\\Users\\nome\\progetto.dwg": 3, "nome file": 1 }, funcs: { conversione_lotti: 1, "<script>": 1 }, errors: { "pdf|Error|pdf": 1, "testo libero del file": 1 } },
    { day: "2020-01-01", launches: 9 }, { day: day(-5), launches: 9 }]);
  const rowB = env._db.prepare("SELECT * FROM usage_days WHERE inst = ?").all(instB);
  ok(rowB.length === 1 && rowB[0].exts === '{"pdf":1}' && rowB[0].funcs === '{"conversione_lotti":1}' && rowB[0].errors === '{"pdf|Error|pdf":1}',
    "statistiche: percorsi, nomi e testi liberi scartati; giorni fuori intervallo ignorati", rowB[0]?.exts);
  ok(!/\bip\b|license|device/i.test(env._db.prepare("SELECT sql FROM sqlite_master WHERE name = 'usage_days'").get().sql.replace(/--.*$/gm, "")), "statistiche: nessuna colonna per IP, licenza o dispositivo");
  const us = await call("/admin/usage?giorni=30", undefined, true);
  ok(us.ok && us.attivi === 2 && us.avvii === 5 && us.formati[0].k === "pdf" && us.formati[0].n === 7 && us.funzioni.some(f => f.k === "nav.clash" && f.n === 4),
    "statistiche: riepilogo (attivi, avvii, formati, funzioni)", JSON.stringify(us.formati) + JSON.stringify(us.funzioni));
  ok(us.versioni.length === 1 && us.versioni[0].k === "1.6.3" && us.versioni[0].n === 2 && us.sistemi.some(x => x.k === "Windows 11 ARM64") && us.errori.length === 2 && us.componenti.length === 2,
    "statistiche: versione attuale per installazione, sistemi, errori, componenti");
  ok((await call("/admin/usage", undefined)).status === 401, "statistiche: riepilogo solo con il codice di gestione");
  const fg = await call("/v1/stats/forget", { inst: instA });
  ok(fg.ok && fg.cancellati === 2 && !env._db.prepare("SELECT COUNT(*) n FROM usage_days WHERE inst = ?").get(instA).n, "statistiche: revoca = dati dell'identificativo cancellati");
  // cancellazione su richiesta dall'app di gestione (identificativo comunicato dall'utente); nessuna scadenza automatica
  env._db.prepare("INSERT INTO usage_days (inst, day) VALUES (?, date('now', '-14 months')), (?, date('now', '-1 days'))").run(instA, instA);
  await worker.scheduled({}, env, { waitUntil: () => {} });
  ok(env._db.prepare("SELECT COUNT(*) n FROM usage_days WHERE inst = ?").get(instA).n === 2, "statistiche: il cron non cancella nulla (conservazione senza scadenza automatica)");
  ok((await call("/admin/usage/forget", { inst: instA.toUpperCase() })).status === 401, "statistiche: cancellazione su richiesta solo con il codice di gestione");
  const af = await call("/admin/usage/forget", { inst: " " + instA.toUpperCase() + " " }, true);
  ok(af.ok && af.cancellati === 2 && !env._db.prepare("SELECT COUNT(*) n FROM usage_days WHERE inst = ?").get(instA).n, "statistiche: cancellazione su richiesta dall'app di gestione");

  // ---- pagine pubbliche per Google (presentazione e informativa): senza cookie, senza licenza, nessun nome di persona
  for (const [path, must] of [["/mbvisual", ["Powered by MB Group", "/privacy"]], ["/privacy", ["Limited Use requirements", "myaccount.google.com/permissions", "Powered by MB Group", "non arrivano mai ai server"]]]) {
    const r = await worker.fetch(new Request("https://x" + path), env);
    const html = await r.text();
    ok(r.status === 200 && /text\/html/.test(r.headers.get("content-type")) && must.every(m => html.includes(m)) && !html.toLowerCase().includes(userInfo().username.toLowerCase()), `pagina pubblica ${path}`);
  }
  env.SUPPORT_EMAIL = "assistenza@esempio.test";
  ok((await (await worker.fetch(new Request("https://x/privacy"), env)).text()).includes("mailto:assistenza@esempio.test"), "informativa: email di assistenza da SUPPORT_EMAIL");
  delete env.SUPPORT_EMAIL;

  console.log(fails ? `\n${fails} prove NON riuscite` : "\nTutte le prove riuscite");
  process.exit(fails ? 1 : 0);
}
