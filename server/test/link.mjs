// Prove del collegamento PC-telefono senza Cloudflare: ticket e controlli del Worker (src/index.js + src/link.js con il
// D1 imitato di shim.mjs) e scambio vero fra client (ui/js/link/linkcore.js) attraverso la stanza (Relay) con finti WebSocket.
//   node test/link.mjs
import worker from "../src/index.js";
import { Relay } from "../src/link.js";
import { Link, newPairing, pairUrl, parsePair, unb64u } from "../../ui/js/link/linkcore.js";
import { makeEnv } from "./shim.mjs";

let fails = 0;
const ok = (cond, label, extra = "") => { console.log(`${cond ? "OK  " : "NO  "} ${label}${extra ? "  " + extra : ""}`); if (!cond) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(10); } return false; };

const env = makeEnv();
const call = async (path, body, headers = {}) => {
  const r = await worker.fetch(new Request("http://x" + path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  let j = {}; try { j = await r.clone().json(); } catch { /* */ }
  return { status: r.status, ...j };
};
const admin = { authorization: `Bearer ${env.ADMIN_TOKEN}` };
const { key } = await call("/admin/licenses", { customer: "Prova collegamento", max_mobile: 5 }, admin);
const { key: key2 } = await call("/admin/licenses", { customer: "Altra licenza" }, admin);
const pc = (await call("/v1/activate", { key, device: "pc-1", kind: "pc", name: "PC ufficio" })).token;
const tel = (await call("/v1/activate", { key, device: "tel-1", kind: "mobile", name: "Android" })).token;
const tel2 = (await call("/v1/activate", { key, device: "tel-2", kind: "mobile", name: "iPhone" })).token;
const altro = (await call("/v1/activate", { key: key2, device: "pc-9", kind: "pc", name: "PC altrui" })).token;
ok(pc && tel && tel2 && altro, "licenze e dispositivi di prova");

// ---------------------------------------------------------------- ticket e controlli del Worker
const P = newPairing();
const tk = async (token, room = P.room, name = "") => (await call("/v1/link/ticket", { token, room, name })).ticket;
const tPc = await tk(pc, P.room, "PC ufficio");
ok(!!tPc, "ticket del PC");
ok((await call("/v1/link/ticket", { token: pc, room: "corta" })).status === 400, "stanza non valida rifiutata");
ok((await call("/v1/link/ticket", { token: "abc.def", room: P.room })).status === 401, "ticket senza attivazione rifiutato");
ok((await call("/v1/check", { token: tPc })).status === 401, "un ticket non vale come attivazione (/v1/check)");
const viaCookie = await call("/v1/link/ticket", { room: P.room }, { cookie: `mbv_m=${tel}` });
ok(!!viaCookie.ticket, "ticket del telefono con il cookie dell'app");
const pay = t => JSON.parse(new TextDecoder().decode(unb64u(t.split(".")[0])));
ok(pay(viaCookie.ticket).t === "mobile" && pay(tPc).t === "pc" && pay(tPc).k === key && pay(tPc).x === "link", "contenuto del ticket (ruolo, licenza)");
await call(`/admin/devices/${env._db.prepare("SELECT id FROM devices WHERE device='tel-2'").get().id}/revoke`, {}, admin);
ok((await call("/v1/link/ticket", { token: tel2, room: P.room })).status === 403, "telefono revocato: niente ticket");

const seen = [];
env.LINK = { idFromName: n => n, get: id => ({ fetch: async req => { seen.push({ id, role: req.headers.get("x-link-role"), name: decodeURIComponent(req.headers.get("x-link-name")) }); return new Response("ok"); } }) };
const ws = (q, up = true) => call(`/v1/link/ws?${q}`, undefined, up ? { upgrade: "websocket" } : {});
ok((await ws(`room=${P.room}&tk=${tPc}`, false)).status === 426, "senza WebSocket rifiutato");
ok((await ws(`room=${P.room}&tk=xyz`)).status === 401, "ticket falso rifiutato");
ok((await ws(`room=${newPairing().room}&tk=${tPc}`)).status === 401, "ticket di un'altra stanza rifiutato");
ok((await ws(`room=${P.room}&tk=${encodeURIComponent(tel)}`)).status === 401, "attivazione usata come ticket rifiutata");
await ws(`room=${P.room}&tk=${encodeURIComponent(tPc)}`);
const tAltro = await tk(altro, P.room);
await ws(`room=${P.room}&tk=${encodeURIComponent(tAltro)}`);
ok(seen.length === 2 && seen[0].id === `${key}/${P.room}` && seen[0].role === "pc" && seen[0].name === "PC ufficio", "stanza per licenza e stanza", seen[0]?.id);
ok(seen[1].id !== seen[0].id, "un'altra licenza con lo stesso codice finisce in un'altra stanza");

// ---------------------------------------------------------------- scambio fra client attraverso la stanza
const rooms = new Map();
class FakeWS {
  constructor(url) {
    const u = new URL(url);
    this.readyState = 0; this.bufferedAmount = 0;
    const t = pay(u.searchParams.get("tk"));
    const room = u.searchParams.get("room");
    if (!rooms.has(room)) {
      const socks = [], info = new Map();
      rooms.set(room, new Relay({ sockets: () => socks, attach: (w, i) => { socks.push(w); info.set(w, i); }, info: w => info.get(w), drop: w => { const k = socks.indexOf(w); if (k >= 0) socks.splice(k, 1); } }));
    }
    const relay = rooms.get(room);
    this.relay = relay;
    // lato server della connessione
    this.srv = { send: d => setTimeout(() => this.onmessage?.({ data: typeof d === "string" ? d : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) })), close: (code, reason) => { this.readyState = 3; setTimeout(() => this.onclose?.({ code, reason })); } };
    setTimeout(() => { this.readyState = 1; this.onopen?.(); relay.join(this.srv, { id: Math.random().toString(36).slice(2, 10), role: t.t, name: t.n, dev: t.d }); });
  }
  send(d) { if (this.readyState !== 1) throw new Error("chiuso"); const x = typeof d === "string" ? d : d.slice(); setTimeout(() => this.relay.message(this.srv, x)); }
  close() { this.readyState = 3; this.relay.leave(this.srv); setTimeout(() => this.onclose?.({ code: 1000, reason: "" })); }
}
const mk = (role, name, token, keyOverride) => new Link({ server: "https://x", room: P.room, key: keyOverride || P.key, role, name, WebSocket: FakeWS, ticket: () => tk(token, P.room, name) });
const A = mk("pc", "PC ufficio", pc), B = mk("mobile", "Android", tel);
await A.start(); await B.start();
ok(await until(() => A.list().length === 1 && B.list().length === 1), "PC e telefono si vedono e si riconoscono (saluto cifrato)");
ok(B.list("pc")[0]?.name === "PC ufficio" && A.list("mobile")[0]?.name === "Android", "nomi e ruoli");
const intruso = mk("mobile", "Intruso", (await call("/v1/activate", { key, device: "tel-4", kind: "mobile", name: "Intruso" })).token, newPairing().key);
await intruso.start();
await sleep(150);
ok(A.list().length === 1 && intruso.list().length === 0, "dispositivo senza la chiave giusta: entra nella stanza ma non viene riconosciuto");
intruso.stop();

let got = null;
A.addEventListener("msg", e => { got = e.detail; });
await B.send({ t: "clip", text: "Testo dal telefono – àèì €" });
ok(await until(() => got?.h?.text === "Testo dal telefono – àèì €"), "messaggio cifrato consegnato");
const big = new Uint8Array(1300000).map((_, i) => (i * 7919) % 251);
let file = null, prog = 0;
A.addEventListener("file", e => { file = e.detail; });
A.addEventListener("progress", e => { if (e.detail.dir === "in") prog = Math.max(prog, e.detail.done); });
await B.sendFile(new File([big], "scansione.pdf", { type: "application/pdf" }), { kind: "scan" });
ok(await until(() => !!file), "file di 1,3 MB in 6 pezzi");
const back = new Uint8Array(await file.file.arrayBuffer());
ok(back.length === big.length && back.every((v, i) => v === big[i]) && file.meta.kind === "scan" && file.file.name === "scansione.pdf", "contenuto, nome e dati del file intatti");
ok(prog === big.length, "avanzamento in ricezione");
A.onRequest("list", async h => ({ files: ["a.pdf", h.q] }));
A.onRequest("boom", async () => { throw new Error("rotto"); });
const pcId = B.list("pc")[0].id;
const r = await B.request(pcId, { t: "list", q: "b.dwg" });
ok(JSON.stringify(r.h.files) === '["a.pdf","b.dwg"]', "richiesta con risposta");
let err = ""; try { await B.request(pcId, { t: "boom" }); } catch (e) { err = e.message; }
ok(err === "rotto", "errore della richiesta riportato");
A.onRequest("snap", async () => ({ h: { w: 2 }, data: new Uint8Array([1, 2, 3]) }));
const sn = await B.request(pcId, { t: "snap" });
ok(sn.h.w === 2 && sn.data.length === 3, "risposta con dati binari");

// destinatario singolo: il secondo telefono non riceve
const C = mk("mobile", "Tablet", (await call("/v1/activate", { key, device: "tel-3", kind: "mobile", name: "Tablet" })).token);
await C.start();
ok(await until(() => A.list("mobile").length === 2), "secondo telefono collegato");
let toB = 0, toC = 0;
B.addEventListener("msg", e => { if (e.detail.h.t === "solo") toB++; });
C.addEventListener("msg", e => { if (e.detail.h.t === "solo") toC++; });
await A.send({ t: "solo" }, null, B.list("pc")[0] && [...A.peers.values()].find(p => p.name === "Android").id);
await A.send({ t: "solo" });
await sleep(100);
ok(toB === 2 && toC === 1, "messaggio a un solo dispositivo e a tutti");
// lo stesso telefono che si ricollega prende il posto della vecchia connessione
const B2 = mk("mobile", "Android", tel);
await B2.start();
ok(await until(() => B.state === "offline" && B.error === "replaced"), "stesso dispositivo ricollegato: la vecchia connessione si chiude");
ok(await until(() => A.list("mobile").length === 2), "il PC vede ancora due telefoni (non tre)");
C.stop();
ok(await until(() => A.list("mobile").length === 1), "uscita di un telefono notificata");

// ---------------------------------------------------------------- QR
const url = pairUrl("https://mbvisual.mb-group.workers.dev/", P, "PC di Mario & C.");
const pp = parsePair(url);
ok(pp && pp.room === P.room && pp.key === P.key && pp.name === "PC di Mario & C." && pp.server === "https://mbvisual.mb-group.workers.dev", "QR: indirizzo con stanza, chiave e nome", url.length + " caratteri");
ok(!parsePair("https://example.com/#altro") && !parsePair("ciao"), "QR estranei ignorati");

[A, B, B2].forEach(l => l.stop());
console.log(fails ? `\n${fails} prove fallite` : "\nTutte le prove riuscite");
process.exit(fails ? 1 : 0);
