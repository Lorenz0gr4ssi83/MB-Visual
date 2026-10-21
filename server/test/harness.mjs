// Banco di prova del server delle licenze senza Cloudflare: esegue src/index.js con un database SQLite di Node
// (node:sqlite) che imita D1. Serve perche' il motore locale di Cloudflare (workerd) non esiste per Windows ARM64.
//   node test/harness.mjs            collaudo completo (database in memoria)
//   node test/harness.mjs serve 8787 server locale su http://127.0.0.1:8787 (database in %USERPROFILE%\.mbvisual\server-prova, fuori da OneDrive)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

// ---- D1 imitato
function d1(db) {
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
    _exec: () => db.prepare(sql).run(...args),
  });
  return {
    prepare: sql => stmt(sql),
    batch: async list => { db.exec("BEGIN"); try { list.forEach(s => s._exec()); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } return []; },
  };
}
function makeEnv(file = ":memory:") {
  const db = new DatabaseSync(file);
  db.exec(readFileSync(join(here, "..", "schema.sql"), "utf8"));
  const keys = JSON.parse(readFileSync(join(homedir(), ".mbvisual", "licenze", "chiavi.json"), "utf8"));
  return { DB: d1(db), SIGNING_KEY: keys.private_pkcs8, PUBLIC_KEY: keys.public_raw, ADMIN_TOKEN: keys.admin_token, _db: db };
}

if (process.argv[2] === "serve") {
  const dir = join(homedir(), ".mbvisual", "server-prova");
  mkdirSync(dir, { recursive: true });
  const env = makeEnv(join(dir, "prova.sqlite"));
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

  console.log(fails ? `\n${fails} prove NON riuscite` : "\nTutte le prove riuscite");
  process.exit(fails ? 1 : 0);
}
