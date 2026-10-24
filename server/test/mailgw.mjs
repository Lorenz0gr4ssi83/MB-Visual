// Collaudo del passaggio IMAP/SMTP dell'app per telefono (server/src/mailgw.js) con il server di posta di prova:
//   python tests/mailserver.py --imap 11143 --smtp 11025     poi     node server/test/mailgw.mjs [porta_imap] [porta_smtp]
import { mailGateway } from "../src/mailgw.js";
import { nodeConnect } from "./nodesockets.mjs";

const [IP, SP] = [+(process.argv[2] || 11143), +(process.argv[3] || 11025)];
const env = { MAIL_TEST_PLAIN: "1" };
const acc = { host: "127.0.0.1", port: IP, sec: "none", user: "mario@studio.prova.it", pass: "prova" };
let fails = 0;
const ok = (c, m) => { console.log((c ? "ok  " : "NO  ") + m); if (!c) fails++; };
const imap = async (steps, extra = {}) => {
  const r = await mailGateway(env, "/v1/mail/imap", { ...acc, ...extra, steps }, nodeConnect);
  const u = new Uint8Array(await r.arrayBuffer());
  const nl = u.indexOf(10);
  const head = JSON.parse(new TextDecoder().decode(u.subarray(0, nl)));
  let p = nl + 1;
  for (const x of head.results || []) { x.raw = new TextDecoder().decode(u.subarray(p, p + x.len)); p += x.len; }
  return head;
};
const b64 = s => Buffer.from(s, "utf8").toString("base64");

let h = await imap([{ cmd: 'LIST "" "*"' }, { cmd: 'SELECT "INBOX"' }, { cmd: "UID SEARCH ALL" }]);
ok(h.ok && /OK/.test(h.greeting), "accesso e saluto");
ok(h.results[0].status === "OK" && /INBOX/.test(h.results[0].raw), "LIST");
ok(/EXISTS/.test(h.results[1].raw), "SELECT INBOX");
const uids = (/\* SEARCH ([\d ]*)/.exec(h.results[2].raw)?.[1] || "").trim().split(/\s+/).filter(Boolean);
ok(uids.length > 0, "messaggi nella INBOX: " + uids.length);
h = await imap([{ cmd: 'EXAMINE "INBOX"' }, { cmd: `UID FETCH ${uids[0]} (UID FLAGS RFC822.SIZE BODY.PEEK[])` }]);
ok(/\{\d+\}\r\n/.test(h.results[1].raw) && /Subject:/i.test(h.results[1].raw), "FETCH con letterale");
h = await imap([], { pass: "sbagliata" });
ok(!h.ok && h.auth, "password sbagliata riconosciuta");
// invio e copia in Inviata
const raw = "From: mario@studio.prova.it\r\nTo: anna@cliente.prova.it\r\nSubject: Prova dal telefono\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nCiao Anna\r\n..punto raddoppiato\r\n";
let r = await mailGateway(env, "/v1/mail/smtp", { host: "127.0.0.1", port: SP, sec: "none", user: acc.user, pass: "prova", from: acc.user, to: ["anna@cliente.prova.it"], data: b64(raw) }, nodeConnect);
let j = await r.json();
ok(j.ok, "SMTP invio " + (j.errore || ""));
const list = (await imap([{ cmd: 'LIST "" "*"' }])).results[0].raw;
const sent = /\(([^)]*\\Sent[^)]*)\) "[^"]*" "?([^"\r\n]+)"?/.exec(list)?.[2] || "Sent";
h = await imap([{ cmd: `APPEND "${sent}" (\\Seen) `, lit: b64(raw) }]);
ok(h.results[0].status === "OK", "APPEND in Sent " + h.results[0].text);
const anna = await mailGateway(env, "/v1/mail/imap", { ...acc, user: "anna@cliente.prova.it", steps: [{ cmd: 'SELECT "INBOX"' }, { cmd: 'UID SEARCH SUBJECT "Prova dal telefono"' }] }, nodeConnect);
const at = new TextDecoder().decode(new Uint8Array(await anna.arrayBuffer()));
ok(/\* SEARCH \d+/.test(at), "messaggio ricevuto dal destinatario");
r = await mailGateway({}, "/v1/mail/smtp", { host: "smtp.esempio.it", port: 25, sec: "ssl", user: "x", pass: "y", from: "a@b.it", to: ["c@d.it"], data: "" }, nodeConnect);
ok((await r.json()).ok === false, "porta 25 rifiutata");
console.log(fails ? `${fails} prove NON riuscite` : "tutte le prove riuscite");
process.exit(fails ? 1 : 0);
