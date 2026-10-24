// Collegamento PC <-> telefono in tempo reale (ui/js/link/): il server fa solo da "punto d'incontro".
// Ogni PC ha una stanza (codice casuale nel QR dell'abbinamento); PC e telefoni della STESSA licenza si collegano alla stanza
// con un WebSocket e il server inoltra i messaggi agli altri. I messaggi sono cifrati nei dispositivi (AES-GCM con una chiave
// che sta solo nel QR, mai sul server): qui si vedono solo dimensioni e mittenti. Niente viene conservato.
//
//   POST /v1/link/ticket {token del dispositivo (PC) o cookie (telefono), room, name}  -> {ticket} valido 5 minuti
//   GET  /v1/link/ws?room=<stanza>&tk=<ticket>   (Upgrade: websocket) -> Durable Object LinkRoom "<licenza>/<stanza>"
//
// Pacchetti binari dal dispositivo: [n][destinatario (n byte, 0 = tutti)][dati cifrati]; verso gli altri il server mette
// davanti il mittente: [n][mittente][dati cifrati]. Testo: solo "ping" (risposta automatica "pong" senza svegliare la stanza).
// Dal server (testo JSON): {type:"peers", you, peers:[{id, role, name}]} a ogni entrata/uscita.

const ROOM_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_PEERS = 8;
const MAX_MSG = 1100000;  // il client manda pezzi da 256 KB (+ intestazione e cifratura)
const TICKET_S = 300;
const te = new TextEncoder(), td = new TextDecoder();

// ticket firmato con la stessa chiave delle attivazioni: { x: "link", k: licenza, d: dispositivo, t: pc|mobile, n: nome, r: stanza, exp }
export async function linkTicket(env, b, { deviceFromToken, sign, json, fail }) {
  const room = String(b.room || "");
  if (!ROOM_RE.test(room)) return fail(400, "Stanza non valida");
  const [lic, dev, err] = await deviceFromToken(env, b.token);
  if (err) return err;
  const now = Math.floor(Date.now() / 1000);
  const name = String(b.name || dev.name || "").slice(0, 60);
  return json({ ok: true, ticket: await sign({ x: "link", k: lic.key, d: dev.device, t: dev.kind, n: name, r: room, exp: now + TICKET_S }) });
}

export async function linkSocket(env, req, url, { readToken, fail }) {
  if ((req.headers.get("upgrade") || "").toLowerCase() !== "websocket") return fail(426, "Serve un WebSocket");
  if (!env.LINK) return fail(503, "Collegamento non disponibile");
  const room = url.searchParams.get("room") || "";
  const tk = await readToken(env, url.searchParams.get("tk") || "");
  if (!tk || tk.x !== "link" || tk.r !== room || !ROOM_RE.test(room) || tk.exp < Date.now() / 1000) return fail(401, "Ticket non valido o scaduto");
  const stub = env.LINK.get(env.LINK.idFromName(`${tk.k}/${room}`));
  const h = new Headers(req.headers);
  h.set("x-link-role", tk.t === "pc" ? "pc" : "mobile");
  h.set("x-link-name", encodeURIComponent(tk.n || ""));
  h.set("x-link-dev", tk.d);
  return stub.fetch(new Request(req.url, { headers: h }));
}

// ---------------------------------------------------------------- stanza (Durable Object con WebSocket in ibernazione)
// La logica sta in Relay (provata in Node con finti WebSocket: server/test/link.mjs); LinkRoom la collega a Cloudflare.
export class Relay {
  constructor(state) { this.state = state; } // state: { sockets() -> [ws], attach(ws, info), info(ws) -> info }
  join(ws, info) {
    for (const w of this.state.sockets()) { // lo stesso dispositivo che si ricollega prende il posto della vecchia connessione
      const a = this.state.info(w);
      if (w !== ws && a && a.dev === info.dev && a.role === info.role) { try { w.close(4000, "replaced"); } catch { /* */ } this.state.drop?.(w); }
    }
    this.state.attach(ws, info);
    this.presence();
  }
  full() { return this.state.sockets().length >= MAX_PEERS; }
  message(ws, msg) {
    if (typeof msg === "string") return; // "ping" ha la risposta automatica; altro testo non serve
    const u8 = msg instanceof Uint8Array ? msg : new Uint8Array(msg);
    if (u8.byteLength > MAX_MSG) { try { ws.close(1009, "too big"); } catch { /* */ } return; }
    const n = u8[0];
    if (!(u8.byteLength > 1 + n)) return;
    const to = n ? td.decode(u8.subarray(1, 1 + n)) : null;
    const from = te.encode(this.state.info(ws)?.id || "?");
    const out = new Uint8Array(1 + from.length + u8.byteLength - 1 - n);
    out[0] = from.length;
    out.set(from, 1);
    out.set(u8.subarray(1 + n), 1 + from.length);
    for (const w of this.state.sockets()) {
      if (w === ws) continue;
      if (to && this.state.info(w)?.id !== to) continue;
      try { w.send(out); } catch { /* */ }
    }
  }
  leave(ws) { this.state.drop?.(ws); this.presence(ws); }
  presence(exclude = null) {
    // un solo elemento per dispositivo (la connessione vecchia sostituita puo' restare nell'elenco finche' non si chiude)
    const byDev = new Map();
    for (const w of this.state.sockets()) { const a = w !== exclude && this.state.info(w); if (a) byDev.set(a.role + "|" + a.dev, a); }
    const peers = [...byDev.values()].map(({ id, role, name }) => ({ id, role, name }));
    for (const w of this.state.sockets()) {
      if (w === exclude) continue;
      try { w.send(JSON.stringify({ type: "peers", you: this.state.info(w)?.id, peers })); } catch { /* */ }
    }
  }
}

export class LinkRoom {
  constructor(ctx) {
    this.ctx = ctx;
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong")); } catch { /* */ }
    this.relay = new Relay({
      sockets: () => ctx.getWebSockets(),
      attach: (ws, info) => { ctx.acceptWebSocket(ws); ws.serializeAttachment(info); },
      info: ws => { try { return ws.deserializeAttachment(); } catch { return null; } },
    });
  }
  async fetch(req) {
    if (this.relay.full()) return new Response("Stanza piena", { status: 429 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const info = { id: crypto.randomUUID().slice(0, 8), role: req.headers.get("x-link-role") || "mobile",
      name: decodeURIComponent(req.headers.get("x-link-name") || ""), dev: req.headers.get("x-link-dev") || "" };
    this.relay.join(server, info);
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws, msg) { this.relay.message(ws, msg); }
  webSocketClose(ws, code) { try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye"); } catch { /* */ } this.relay.leave(ws); }
  webSocketError(ws) { this.relay.leave(ws); }
}
