// Posta dell'app per telefono: passaggio IMAP/SMTP senza memoria (il browser non puo' aprire connessioni TCP).
// Il telefono manda server, utente, password e i comandi; il Worker apre la connessione cifrata (TLS o STARTTLS), esegue e
// restituisce le risposte GREZZE. Niente viene salvato: credenziali e messaggi restano solo nel telefono (IndexedDB cifrato).
// Lavoro minimo nel Worker (piano gratuito: pochi ms di CPU): i dati letterali IMAP si saltano senza esaminarli, l'analisi
// delle risposte e dei messaggi la fa il telefono (ui/js/mmailcore.js).
// Solo per telefoni attivati (cookie dell'app); porte permesse: IMAP 993/143, SMTP 465/587 (la 25 e' bloccata da Cloudflare).
//
// POST /v1/mail/imap  {host, port, sec: "ssl"|"starttls", user, pass, steps: [{cmd, lit?: base64}]}
//   risposta binaria: riga JSON {ok, greeting, results: [{status, text, len}]} + "\n" + i byte delle risposte (non etichettate) in fila
// POST /v1/mail/smtp  {host, port, sec, user, pass, from, to: [...], data: base64 (messaggio gia' con i punti raddoppiati)}
//   risposta JSON {ok, errore?, codice?}

const enc = new TextEncoder(), dec = new TextDecoder();
const IMAP_PORTS = new Set([993, 143]), SMTP_PORTS = new Set([465, 587]);
const TIMEOUT = 25000;

const b64bytes = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
const quote = s => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

// lettore a blocchi: righe terminate da CRLF, con i letterali {n} saltati per lunghezza (non esaminati).
// Buffer a capacita' crescente: un allegato da qualche MB non viene ricopiato a ogni pezzo ricevuto.
class Reader {
  constructor(readable) { this.r = readable.getReader(); this.buf = new Uint8Array(65536); this.len = 0; this.pos = 0; }
  async more() {
    const { value, done } = await this.r.read();
    if (done) throw new Error("connessione chiusa dal server");
    if (this.len + value.length > this.buf.length) {
      const keep = this.len - this.pos;
      const nb = new Uint8Array(Math.max(this.buf.length * 2, keep + value.length + 65536));
      nb.set(this.buf.subarray(this.pos, this.len));
      this.buf = nb; this.len = keep; this.pos = 0;
    }
    this.buf.set(value, this.len);
    this.len += value.length;
  }
  find(from) { const i = this.buf.subarray(0, this.len).indexOf(10, from); return i; }
  // una "riga logica" IMAP: testo + eventuali letterali; restituisce i byte (CRLF compreso) e l'ultima riga di testo
  async imapLine() {
    let s = this.pos, p = s, last = "";
    const grow = async () => { const off = p - s; this.pos = s; await this.more(); s = this.pos; p = s + off; };
    for (;;) {
      let nl;
      while ((nl = this.find(p)) < 0) await grow();
      let e = nl - 1; if (this.buf[e] === 13) e--;
      let lit = -1;
      if (this.buf[e] === 125) { // "}" in fondo alla riga: letterale {n} o {n+}
        let q = e - 1; if (this.buf[q] === 43) q--;
        let n = 0, mul = 1, digits = 0;
        while (q >= p && this.buf[q] >= 48 && this.buf[q] <= 57) { n += (this.buf[q] - 48) * mul; mul *= 10; q--; digits++; }
        if (digits && this.buf[q] === 123) lit = n;
      }
      last = dec.decode(this.buf.subarray(p, nl + 1));
      p = nl + 1;
      if (lit < 0) break;
      while (this.len - p < lit) await grow();
      p += lit;
    }
    const out = this.buf.slice(s, p);
    this.pos = p;
    if (this.pos === this.len) this.pos = this.len = 0;
    return { bytes: out, last };
  }
  async textLine() { const { last } = await this.imapLine(); return last.replace(/\r?\n$/, ""); }
}

async function openSocket(connect, host, port, sec) {
  const s = connect({ hostname: host, port }, { secureTransport: sec === "ssl" ? "on" : sec === "starttls" ? "starttls" : "off", allowHalfOpen: false });
  await s.opened;
  return s;
}
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("tempo scaduto (" + what + ")")), ms))]);

function check(b, ports, env) {
  const host = String(b.host || "").trim().toLowerCase(), port = +b.port;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) && !(env.MAIL_TEST_PLAIN === "1" && host === "127.0.0.1")) throw new Error("server non valido");
  const test = env.MAIL_TEST_PLAIN === "1";
  if (!test && !ports.has(port)) throw new Error("porta non permessa: " + port);
  const sec = b.sec === "starttls" ? "starttls" : b.sec === "none" && test ? "none" : "ssl";
  return { host, port, sec };
}

// risposta binaria: intestazione JSON + byte grezzi
export function imapResponse(head, chunks) {
  const h = enc.encode(JSON.stringify(head) + "\n");
  const total = chunks.reduce((s, c) => s + c.length, h.length);
  const out = new Uint8Array(total);
  out.set(h, 0);
  let p = h.length;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

export async function mailSmtp(env, b, connect) {
  let sock, w, rd;
  // risposta SMTP: righe "250-..." fino a "250 ..."
  const reply = async () => {
    let lines = [];
    for (;;) { const l = await rd.textLine(); lines.push(l); if (!/^\d{3}-/.test(l)) break; }
    return { code: +lines[lines.length - 1].slice(0, 3), text: lines.map(l => l.slice(4)).join(" ") };
  };
  const cmd = async (c, ok) => { await w.write(enc.encode(c + "\r\n")); const r = await reply(); if (!ok.includes(r.code)) { const e = new Error(r.text || "errore " + r.code); e.code = r.code; throw e; } return r; };
  try {
    const { host, port, sec } = check(b, SMTP_PORTS, env);
    sock = await openSocket(connect, host, port, sec);
    w = sock.writable.getWriter(); rd = new Reader(sock.readable);
    return await withTimeout((async () => {
      let r = await reply();
      if (r.code !== 220) throw new Error(r.text);
      let ehlo = await cmd("EHLO mbvisual", [250]);
      if (sec === "starttls") {
        await cmd("STARTTLS", [220]);
        w.releaseLock(); rd.r.releaseLock();
        sock = sock.startTls();
        w = sock.writable.getWriter(); rd = new Reader(sock.readable);
        ehlo = await cmd("EHLO mbvisual", [250]);
      }
      if (b.xoauth2) await cmd("AUTH XOAUTH2 " + btoa(`user=${b.user}\x01auth=Bearer ${b.xoauth2}\x01\x01`), [235]);
      else if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo.text) || !/AUTH[ =][^\n]*LOGIN/i.test(ehlo.text)) {
        const raw = enc.encode("\0" + b.user + "\0" + b.pass);
        let bin = ""; for (const x of raw) bin += String.fromCharCode(x);
        await cmd("AUTH PLAIN " + btoa(bin), [235]);
      } else {
        await cmd("AUTH LOGIN", [334]);
        const u8 = s => { let bin = ""; for (const x of enc.encode(s)) bin += String.fromCharCode(x); return btoa(bin); };
        await cmd(u8(b.user), [334]);
        await cmd(u8(b.pass), [235]);
      }
      await cmd(`MAIL FROM:<${String(b.from).replace(/[<>\r\n]/g, "")}>`, [250]);
      for (const to of b.to || []) await cmd(`RCPT TO:<${String(to).replace(/[<>\r\n]/g, "")}>`, [250, 251]);
      await cmd("DATA", [354]);
      await w.write(b64bytes(b.data));
      await cmd("\r\n.", [250]);
      cmd("QUIT", [221]).catch(() => {});
      return { ok: true };
    })(), TIMEOUT * 2, "SMTP");
  } catch (e) {
    return { ok: false, errore: e.message, codice: e.code || 0, auth: e.code === 535 || e.code === 534 };
  } finally {
    setTimeout(() => { try { sock?.close(); } catch { /* */ } }, 50);
  }
}

// ingresso unico (index.js): SMTP = JSON; IMAP = intestazione JSON + byte delle risposte
export async function mailGateway(env, path, b, connect) {
  if (path === "/v1/mail/smtp") return new Response(JSON.stringify(await mailSmtp(env, b, connect)), { headers: { "content-type": "application/json" } });
  const chunks = [];
  const res = await mailImapCollect(env, b, connect, chunks).catch(e => ({ ok: false, errore: e.message }));
  return new Response(imapResponse(res, res.ok ? chunks : []), { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
}

async function mailImapCollect(env, b, connect, chunks) {
  const { host, port, sec } = check(b, IMAP_PORTS, env);
  let sock = await openSocket(connect, host, port, sec);
  let w = sock.writable.getWriter(), rd = new Reader(sock.readable);
  let n = 0;
  const run = async (cmd, lit, keep = true) => {
    const tg = "M" + (++n);
    if (lit) {
      await w.write(enc.encode(`${tg} ${cmd}{${lit.length}}\r\n`));
      const l = await rd.textLine();
      if (!l.startsWith("+")) return { status: "NO", text: l, len: 0 };
      await w.write(lit); await w.write(enc.encode("\r\n"));
    } else await w.write(enc.encode(`${tg} ${cmd}\r\n`));
    let len = 0;
    for (;;) {
      const { bytes, last } = await rd.imapLine();
      if (last.startsWith(tg + " ")) {
        const m = /^\S+ (OK|NO|BAD)\s?(.*)/.exec(last.trim());
        return { status: m ? m[1] : "BAD", text: m ? m[2] : last.trim(), len: keep ? len : 0 };
      }
      if (keep) { chunks.push(bytes); len += bytes.length; }
    }
  };
  try {
    return await withTimeout((async () => {
      const greeting = await rd.textLine();
      if (sec === "starttls") {
        const r = await run("STARTTLS", null, false);
        if (r.status !== "OK") throw new Error("STARTTLS: " + r.text);
        w.releaseLock(); rd.r.releaseLock();
        sock = sock.startTls();
        w = sock.writable.getWriter(); rd = new Reader(sock.readable);
      }
      const login = b.xoauth2
        ? await run("AUTHENTICATE XOAUTH2 " + btoa(`user=${b.user}\x01auth=Bearer ${b.xoauth2}\x01\x01`), null, false)
        : await run(`LOGIN ${quote(b.user)} ${quote(b.pass)}`, null, false);
      if (login.status !== "OK") return { ok: false, auth: true, errore: login.text || "accesso rifiutato", greeting };
      const results = [];
      for (const st of b.steps || []) results.push(await run(String(st.cmd).replace(/[\r\n]/g, " "), st.lit ? b64bytes(st.lit) : null));
      await withTimeout(run("LOGOUT", null, false), 1500, "LOGOUT").catch(() => {});
      return { ok: true, greeting, results };
    })(), TIMEOUT, "IMAP");
  } finally {
    try { sock.close(); } catch { /* */ }
  }
}
