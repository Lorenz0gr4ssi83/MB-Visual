// Collegamento PC <-> telefono: nucleo comune (senza interfaccia), usato da linkpc.js e linkphone.js.
// Connessione WebSocket alla stanza del PC sul server delle licenze (server/src/link.js), che inoltra soltanto.
// Ogni messaggio e' cifrato qui con AES-GCM (chiave di 32 byte generata dal PC e passata al telefono SOLO nel QR):
// il server non puo' leggere file, testi o comandi. Messaggi = intestazione JSON + dati binari facoltativi.
// File a pezzi da 256 KB con avanzamento; richieste con risposta (request/onRequest); riconnessione automatica.
//
// Pacchetto in uscita: [n][destinatario (n byte; 0 = tutti)][iv 12][cifrato]   in entrata: [n][mittente][iv][cifrato]
// In chiaro (cifrato): [lunghezza intestazione u32][intestazione JSON UTF-8][dati]

const te = new TextEncoder(), td = new TextDecoder();
export const b64u = u8 => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const rnd = n => crypto.getRandomValues(new Uint8Array(n));
export const newId = () => b64u(rnd(9));
const CHUNK = 256 * 1024;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- abbinamento (QR)
// QR = indirizzo dell'app per telefono con i dati nel frammento (#: non arriva mai al server):
//   https://<server>/#mbvlink=<stanza>.<chiave>.<nome del PC>
export function newPairing() { return { room: b64u(rnd(16)), key: b64u(rnd(32)) }; }
export function pairUrl(server, p, name) { return `${server.replace(/\/+$/, "")}/#mbvlink=${p.room}.${p.key}.${encodeURIComponent(name || "")}`; }
export function parsePair(text) {
  const s = String(text || "").trim();
  const m = /^(https?:\/\/[^/#?]+)[^#]*#mbvlink=([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{40,46})(?:\.([^&\s]*))?/.exec(s);
  if (!m) return null;
  let name = "";
  try { name = decodeURIComponent(m[4] || ""); } catch { /* */ }
  return { server: m[1], room: m[2], key: m[3], name };
}

// ---------------------------------------------------------------- cifratura e impacchettamento
export async function importKey(k) { return crypto.subtle.importKey("raw", unb64u(k), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]); }
export async function seal(key, aad, h, data = null) {
  const hb = te.encode(JSON.stringify(h)), db = !data ? new Uint8Array(0) : data instanceof Uint8Array ? data : new Uint8Array(data);
  const plain = new Uint8Array(4 + hb.length + db.length);
  new DataView(plain.buffer).setUint32(0, hb.length);
  plain.set(hb, 4); plain.set(db, 4 + hb.length);
  const iv = rnd(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, plain));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return out;
}
export async function open(key, aad, u8) {
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: u8.subarray(0, 12), additionalData: aad }, key, u8.subarray(12)));
  const hl = new DataView(plain.buffer).getUint32(0);
  return { h: JSON.parse(td.decode(plain.subarray(4, 4 + hl))), data: plain.subarray(4 + hl) };
}
export function frame(to, body) {
  const tb = to ? te.encode(to) : new Uint8Array(0);
  const out = new Uint8Array(1 + tb.length + body.length);
  out[0] = tb.length; out.set(tb, 1); out.set(body, 1 + tb.length);
  return out;
}
export function unframe(u8) { const n = u8[0]; return { from: td.decode(u8.subarray(1, 1 + n)), body: u8.subarray(1 + n) }; }

// ---------------------------------------------------------------- connessione a una stanza
// opts: { server, room, key, role: "pc"|"mobile", name, ticket: async () => string, WebSocket }
// eventi: status {state: "connecting"|"online"|"offline"|"error", error}, peers, msg {from, h, data}, file {from, file, meta},
//         progress {fid, name, done, total, dir: "in"|"out", from|to}
export class Link extends EventTarget {
  constructor(opts) {
    super();
    Object.assign(this, { opts, ws: null, you: null, peers: new Map(), state: "offline", stopped: true, retry: 0, handlers: {}, pending: new Map(), incoming: new Map() });
    this.aad = te.encode(opts.room);
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  setState(state, error = "") { this.state = state; this.error = error; this.emit("status", { state, error }); }
  get online() { return this.state === "online"; }
  // dispositivi verificati (hanno risposto con la chiave giusta), del ruolo richiesto
  list(role = null) { return [...this.peers.values()].filter(p => p.ok && (!role || p.role === role)); }

  async start() {
    this.stopped = false;
    this.key ||= await importKey(this.opts.key);
    this.connect();
    if (!this._vis && typeof document !== "undefined") {
      this._vis = () => { if (document.visibilityState === "visible" && !this.stopped && this.state !== "online" && this.state !== "connecting") { this.retry = 0; this.connect(); } };
      document.addEventListener("visibilitychange", this._vis);
      addEventListener("online", this._vis);
    }
  }
  stop() {
    this.stopped = true;
    clearTimeout(this._t); clearInterval(this._ping);
    try { this.ws?.close(1000, "bye"); } catch { /* */ }
    this.ws = null;
    this.peers.clear();
    this.setState("offline");
    this.emit("peers", []);
  }
  async connect() {
    if (this.stopped || this.state === "connecting") return;
    clearTimeout(this._t);
    this.setState("connecting");
    let tk;
    try { tk = await this.opts.ticket(); } catch (e) { return this.later(e.message || String(e)); }
    if (this.stopped) return;
    const WS = this.opts.WebSocket || WebSocket;
    const url = this.opts.server.replace(/^http/, "ws").replace(/\/+$/, "") + `/v1/link/ws?room=${encodeURIComponent(this.opts.room)}&tk=${encodeURIComponent(tk)}`;
    let ws;
    try { ws = new WS(url); } catch (e) { return this.later(e.message); }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.setState("online"); clearInterval(this._ping); this._ping = setInterval(() => { try { ws.send("ping"); } catch { /* */ } }, 25000); };
    ws.onmessage = e => this.receive(e.data);
    ws.onclose = e => {
      if (this.ws !== ws) return;
      clearInterval(this._ping);
      this.ws = null; this.peers.clear(); this.emit("peers", []);
      for (const [fid, f] of this.incoming) { this.incoming.delete(fid); this.emit("progress", { fid, name: f.name, done: 0, total: f.size, dir: "in", failed: true }); }
      if (e.code === 4000) { this.setState("offline", "replaced"); return; } // stesso dispositivo collegato da un'altra finestra
      this.later(e.reason || "");
    };
  }
  later(error) {
    if (this.stopped) return;
    this.setState("offline", error);
    const wait = [1, 2, 5, 10, 20, 30][Math.min(this.retry++, 5)] * 1000;
    this._t = setTimeout(() => this.connect(), wait);
  }

  // ------------------------------------------------ invio
  async send(h, data = null, to = null) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) throw new Error("offline");
    while (ws.bufferedAmount > 2 * 1024 * 1024) { await sleep(25); if (ws.readyState !== 1) throw new Error("offline"); }
    ws.send(frame(to, await seal(this.key, this.aad, h, data)));
  }
  hello(to = null) {
    return this.send({ t: "hello", role: this.opts.role, name: this.opts.name, caps: this.opts.caps || [], v: 1 }, null, to).catch(() => {});
  }
  // file (Blob/File) a pezzi; meta = dati liberi per chi riceve. to = id del dispositivo o null = tutti
  async sendFile(blob, meta = {}, to = null) {
    const fid = newId(), name = meta.name || blob.name || "file", total = blob.size;
    await this.send({ t: "fs", fid, name, type: blob.type || "", size: total, meta }, null, to);
    let done = 0;
    for (let i = 0; done < total; i++) {
      const part = new Uint8Array(await blob.slice(done, done + CHUNK).arrayBuffer());
      await this.send({ t: "fc", fid, i }, part, to);
      done += part.length;
      this.emit("progress", { fid, name, done, total, dir: "out", to });
    }
    await this.send({ t: "fe", fid }, null, to);
    this.emit("progress", { fid, name, done: total, total, dir: "out", to, end: true });
    return fid;
  }
  // richiesta con risposta: il gestore dall'altra parte restituisce { h, data } (o solo un oggetto = h)
  request(to, h, data = null, ms = 30000) {
    const rid = newId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(rid); reject(new Error("timeout")); }, ms);
      this.pending.set(rid, { resolve, reject, timer });
      this.send({ ...h, rid }, data, to).catch(e => { clearTimeout(timer); this.pending.delete(rid); reject(e); });
    });
  }
  onRequest(type, fn) { this.handlers[type] = fn; }

  // ------------------------------------------------ ricezione
  async receive(raw) {
    if (typeof raw === "string") {
      if (raw === "pong") return;
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === "peers") {
        this.you = m.you;
        const old = this.peers;
        this.peers = new Map(m.peers.filter(p => p.id !== m.you).map(p => [p.id, { ...p, ok: old.get(p.id)?.ok || false, info: old.get(p.id)?.info || null }]));
        // chi e' appena entrato riceve il nostro saluto cifrato (prova che abbiamo la chiave della stanza)
        for (const p of this.peers.values()) if (!old.has(p.id)) this.hello(p.id);
        this.emit("peers", this.list());
      }
      return;
    }
    const { from, body } = unframe(new Uint8Array(raw));
    let m;
    try { m = await open(this.key, this.aad, body); } catch { return; } // chiave sbagliata o pacchetto rovinato: ignorato
    const { h, data } = m;
    const peer = this.peers.get(from);
    if (h.t === "hello") {
      const wasOk = peer?.ok;
      if (peer) { peer.ok = true; peer.info = h; peer.name = h.name || peer.name; peer.role = h.role || peer.role; }
      else this.peers.set(from, { id: from, role: h.role, name: h.name, ok: true, info: h });
      if (!wasOk) { this.hello(from); this.emit("peers", this.list()); }
      return;
    }
    if (peer && !peer.ok) { peer.ok = true; this.emit("peers", this.list()); }
    if (h.t === "fs") { this.incoming.set(h.fid, { ...h, parts: [], got: 0, from }); this.emit("progress", { fid: h.fid, name: h.name, done: 0, total: h.size, dir: "in", from }); return; }
    if (h.t === "fc") {
      const f = this.incoming.get(h.fid);
      if (!f) return;
      f.parts[h.i] = data.slice();
      f.got += data.length;
      this.emit("progress", { fid: h.fid, name: f.name, done: f.got, total: f.size, dir: "in", from });
      return;
    }
    if (h.t === "fe") {
      const f = this.incoming.get(h.fid);
      if (!f) return;
      this.incoming.delete(h.fid);
      const file = new File(f.parts, f.name, { type: f.type || "application/octet-stream" });
      if (file.size !== f.size) { this.emit("progress", { fid: h.fid, name: f.name, done: 0, total: f.size, dir: "in", failed: true }); return; }
      this.emit("file", { from, file, meta: f.meta || {} });
      return;
    }
    if (h.t === "re") {
      const p = this.pending.get(h.rid);
      if (!p) return;
      this.pending.delete(h.rid); clearTimeout(p.timer);
      if (h.error) p.reject(new Error(h.error)); else p.resolve({ h: h.r || {}, data });
      return;
    }
    if (h.rid && this.handlers[h.t]) {
      let r;
      try { r = await this.handlers[h.t](h, data, from); } catch (e) { return this.send({ t: "re", rid: h.rid, error: e.message || String(e) }, null, from).catch(() => {}); }
      const isPair = r && typeof r === "object" && ("h" in r || "data" in r);
      return this.send({ t: "re", rid: h.rid, r: isPair ? r.h || {} : r || {} }, isPair ? r.data || null : null, from).catch(() => {});
    }
    this.emit("msg", { from, h, data });
  }
}
