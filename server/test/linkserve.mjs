// Server di prova del collegamento PC-telefono senza Cloudflare: il Worker (D1 imitato) per ticket e licenze, e un piccolo
// server WebSocket (RFC 6455, solo cio' che serve) con la stessa stanza del Durable Object (Relay di src/link.js).
//   node test/linkserve.mjs 8799
// Stampa (JSON, ultima riga) i token di prova: PC con lo stesso dispositivo dell'attivazione vera di questo PC (cosi' il
// motore Python ottiene il ticket con MBV_LICENZE_URL=http://127.0.0.1:8799) e un telefono di prova.
// Le risposte HTTP hanno CORS con credenziali per l'origine che chiede (la web app di prova sta su un'altra porta).
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { Relay } from "../src/link.js";
import { makeEnv } from "./shim.mjs";

const port = +(process.argv[2] || 8799);
const env = makeEnv();
const call = async (path, body, admin = false) => (await worker.fetch(new Request("http://x" + path, { method: "POST", headers: admin ? { authorization: `Bearer ${env.ADMIN_TOKEN}` } : {}, body: JSON.stringify(body) }), env)).json();
const { key } = await call("/admin/licenses", { customer: "Prova collegamento", max_mobile: 5 }, true);
// dispositivo PC = quello dell'attivazione vera di questo PC (il token firmato con le stesse chiavi resta valido qui)
let pcDev = "pc-prova";
try {
  const tok = JSON.parse(readFileSync(process.env.LOCALAPPDATA + "/MBVisual/licenza.json", "utf8")).token;
  const p = JSON.parse(Buffer.from(tok.split(".")[0], "base64url").toString());
  env._db.prepare("INSERT INTO licenses (key, root, customer, max_pc, max_mobile, status) VALUES (?, ?, 'PC di questa prova', 1, 5, 'active')").run(p.k, p.k);
  env._db.prepare("INSERT INTO devices (license_key, kind, device, name) VALUES (?, 'pc', ?, 'PC prova')").run(p.k, p.d);
  pcDev = p.d;
  env._pcKey = p.k;
} catch (e) { console.error("attivazione del PC non trovata:", e.message); }
const tel = await call("/v1/activate", { key: env._pcKey || key, device: "tel-prova", kind: "mobile", name: "Telefono di prova" });
const tel2 = await call("/v1/activate", { key: env._pcKey || key, device: "tel-prova-2", kind: "mobile", name: "Tablet di prova" });

// stanze: nome -> Relay con i socket di questo processo
const rooms = new Map();
function roomFor(name) {
  if (!rooms.has(name)) {
    const socks = [], info = new Map();
    rooms.set(name, new Relay({ sockets: () => socks, attach: (w, i) => { socks.push(w); info.set(w, i); }, info: w => info.get(w), drop: w => { const k = socks.indexOf(w); if (k >= 0) socks.splice(k, 1); } }));
  }
  return rooms.get(name);
}

// ---- WebSocket minimo
function frameOut(op, payload) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  return Buffer.concat([head, payload]);
}
function wsAccept(req, sock, info, relay) {
  const acc = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
  const ws = {
    send: d => { if (!sock.destroyed) sock.write(typeof d === "string" ? frameOut(1, Buffer.from(d)) : frameOut(2, Buffer.from(d.buffer, d.byteOffset, d.byteLength))); },
    close: (code = 1000, reason = "") => { if (sock.destroyed) return; const b = Buffer.alloc(2); b.writeUInt16BE(code); sock.end(frameOut(8, Buffer.concat([b, Buffer.from(reason)]))); relay.leave(ws); },
  };
  relay.join(ws, info);
  let buf = Buffer.alloc(0), frag = [];
  sock.on("data", d => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 15, masked = buf[1] & 0x80;
      let n = buf[1] & 127, off = 2;
      if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); off = 4; } else if (n === 127) { if (buf.length < 10) return; n = Number(buf.readBigUInt64BE(2)); off = 10; }
      const mk = masked ? buf.subarray(off, off + 4) : null;
      if (masked) off += 4;
      if (buf.length < off + n) return;
      const pl = Buffer.from(buf.subarray(off, off + n));
      if (mk) for (let i = 0; i < pl.length; i++) pl[i] ^= mk[i & 3];
      buf = buf.subarray(off + n);
      if (op === 8) { relay.leave(ws); sock.end(frameOut(8, Buffer.from([3, 232]))); return; }
      if (op === 9) { sock.write(frameOut(10, pl)); continue; }
      frag.push(pl);
      if (!fin) continue;
      const msg = Buffer.concat(frag); frag = [];
      const first = op || 2;
      if (first === 1) { const s = msg.toString(); if (s === "ping") ws.send("pong"); else relay.message(ws, s); }
      else relay.message(ws, new Uint8Array(msg));
    }
  });
  sock.on("close", () => relay.leave(ws));
  sock.on("error", () => relay.leave(ws));
}

const cors = (h, origin) => Object.assign(h, { "access-control-allow-origin": origin || "*", "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type" });
const srv = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
  const h = Object.fromEntries(r.headers);
  res.writeHead(r.status, cors(h, req.headers.origin));
  res.end(Buffer.from(await r.arrayBuffer()));
});
// WebSocket: il Worker controlla il ticket (stessa funzione di Cloudflare) e dice in quale stanza entrare
srv.on("upgrade", async (req, sock) => {
  let seen = null;
  const e2 = Object.assign(Object.create(env), { LINK: { idFromName: n => n, get: id => ({ fetch: async rq => { seen = { id, role: rq.headers.get("x-link-role"), name: decodeURIComponent(rq.headers.get("x-link-name") || ""), dev: rq.headers.get("x-link-dev") }; return new Response("ok"); } }) } });
  const r = await worker.fetch(new Request(`http://127.0.0.1:${port}${req.url}`, { headers: req.headers }), e2);
  if (r.status !== 200 || !seen) { sock.end(`HTTP/1.1 ${r.status} No\r\n\r\n`); return; }
  wsAccept(req, sock, { id: Math.random().toString(36).slice(2, 10), role: seen.role, name: seen.name, dev: seen.dev }, roomFor(seen.id));
});
srv.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ port, pcDev, mobile: tel.token, mobile2: tel2.token })));
