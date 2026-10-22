"""Server di posta di prova (IMAP4rev1 + SMTP) per collaudare la posta di MB Visual senza account veri.

    python tests/mailserver.py [--imap 1143] [--smtp 1025] [--dati cartella]

Utenti (password "prova"; XOAUTH2 con il token "token-prova"):
  mario@studio.prova.it, anna@cliente.prova.it          posta ordinaria
  studio@pec.prova.it, comune@pec.prova.it               PEC: il server fa da gestore (ricevute, buste, daticert.xml)
Recapito: gli indirizzi locali ricevono nella INBOX; per la PEC un destinatario "@pec.prova.it" inesistente produce
l'avviso di mancata consegna, un oggetto con "[rifiuta]" la non accettazione.
IMAP: LOGIN, AUTHENTICATE XOAUTH2, LIST (SPECIAL-USE), SELECT/EXAMINE, STATUS, UID SEARCH/FETCH/STORE/COPY/MOVE/EXPUNGE,
APPEND (APPENDUID), CREATE/DELETE/RENAME/SUBSCRIBE, IDLE (solo attesa), NOOP, LOGOUT. Niente TLS (solo 127.0.0.1).
"""
import argparse
import base64
import email
import email.policy
import json
import re
import socketserver
import sys
import threading
import time
from email.utils import formatdate, getaddresses, parseaddr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import pecsim  # noqa: E402

PASSWORD = "prova"
TOKEN = "token-prova"
SPECIAL = {"INBOX": "", "Inviata": "\\Sent", "Bozze": "\\Drafts", "Cestino": "\\Trash", "Posta indesiderata": "\\Junk", "Archivio": "\\Archive"}


class Box:
    def __init__(self):
        self.lock = threading.RLock()
        self.users = {}
        self.outbound = []   # messaggi verso indirizzi non locali (per le prove)
        self.log = []

    def add_user(self, addr, pec=False):
        self.users[addr] = {"pec": pec, "folders": {n: {"uidvalidity": int(time.time()) % 100000 + len(self.users), "uidnext": 1, "msgs": []}
                                                    for n in SPECIAL}}

    def deliver(self, addr, raw: bytes, folder="INBOX", flags=()):
        with self.lock:
            f = self.users[addr]["folders"][folder]
            uid = f["uidnext"]
            f["uidnext"] += 1
            f["msgs"].append({"uid": uid, "raw": raw, "flags": set(flags), "date": time.time()})
            return uid


BOX = Box()
for _a in ("mario@studio.prova.it", "anna@cliente.prova.it"):
    BOX.add_user(_a)
for _a in ("studio@pec.prova.it", "comune@pec.prova.it"):
    BOX.add_user(_a, pec=True)


# ------------------------------------------------------------------ IMAP
def _utf7_enc(s):
    from mbvisual.mail.imapc import utf7_encode
    return utf7_encode(s)


def _utf7_dec(s):
    from mbvisual.mail.imapc import utf7_decode
    return utf7_decode(s)


def _tokens(s: bytes, lits):
    """Argomenti di un comando: atomi, stringhe tra virgolette, liste, letterali."""
    out, stack = [], []
    cur = out
    i = 0
    while i < len(s):
        c = s[i:i + 1]
        if c in b" \r\n":
            i += 1
        elif c == b"(":
            stack.append(cur)
            new = []
            cur.append(new)
            cur = new
            i += 1
        elif c == b")":
            cur = stack.pop()
            i += 1
        elif c == b'"':
            j = i + 1
            buf = b""
            while s[j:j + 1] != b'"':
                if s[j:j + 1] == b"\\":
                    j += 1
                buf += s[j:j + 1]
                j += 1
            cur.append(buf.decode("utf-8"))
            i = j + 1
        elif c == b"\x00":
            j = s.index(b"\x00", i + 1)
            cur.append(lits[int(s[i + 1:j])])
            i = j + 1
        else:
            m = re.match(rb"[^\s()\"]+(\[[^\]]*\])?(<[\d.]+>)?", s[i:])
            cur.append(m.group(0).decode("utf-8"))
            i += m.end()
    return out


def _seqset(spec, nums):
    mx = max(nums) if nums else 0
    out = set()
    for part in spec.split(","):
        a, _, b = part.partition(":")
        a = mx if a == "*" else int(a)
        if b:
            b = mx if b == "*" else int(b)
            lo, hi = min(a, b), max(a, b)
            out.update(n for n in nums if lo <= n <= hi)
        elif a in nums:
            out.add(a)
    return sorted(out)


class ImapHandler(socketserver.StreamRequestHandler):
    def send(self, s):
        if isinstance(s, str):
            s = s.encode("utf-8")
        self.wfile.write(s + b"\r\n")
        self.wfile.flush()

    def handle(self):
        self.user = None
        self.sel = None
        self.ro = False
        self.send("* OK [CAPABILITY IMAP4rev1 UIDPLUS MOVE SPECIAL-USE AUTH=PLAIN AUTH=XOAUTH2 IDLE] Server di prova MB Visual")
        while True:
            line = self.rfile.readline()
            if not line:
                return
            lits = []
            # letterali {n}: si chiede il seguito e si leggono i byte
            while True:
                m = re.search(rb"\{(\d+)\+?\}\r?\n$", line)
                if not m:
                    break
                if not line.rstrip().endswith(b"+}"):
                    self.send("+ pronto")
                data = self.rfile.read(int(m.group(1)))
                lits.append(data)
                line = line[:m.start()] + b"\x00%d\x00" % (len(lits) - 1) + self.rfile.readline()
            parts = line.rstrip(b"\r\n").split(b" ", 2)
            if len(parts) < 2:
                continue
            tag, cmd = parts[0].decode(), parts[1].decode().upper()
            rest = parts[2] if len(parts) > 2 else b""
            try:
                if not self.dispatch(tag, cmd, rest, lits):
                    return
            except Exception as e:  # noqa: BLE001
                import traceback
                traceback.print_exc()
                self.send(f"{tag} BAD {e}")

    # ---------------------------------------------------------- comandi
    def dispatch(self, tag, cmd, rest, lits):
        if cmd == "UID":
            sub, _, rest2 = rest.partition(b" ")
            return self.uid_cmd(tag, sub.decode().upper(), rest2, lits)
        args = _tokens(rest, lits)
        if cmd == "CAPABILITY":
            self.send("* CAPABILITY IMAP4rev1 UIDPLUS MOVE SPECIAL-USE AUTH=PLAIN AUTH=XOAUTH2 IDLE")
        elif cmd == "NOOP":
            pass
        elif cmd == "LOGOUT":
            self.send("* BYE arrivederci")
            self.send(f"{tag} OK LOGOUT")
            return False
        elif cmd == "LOGIN":
            user, pw = str(args[0]).lower(), str(args[1])
            if user in BOX.users and pw == PASSWORD:
                self.user = user
            else:
                self.send(f"{tag} NO [AUTHENTICATIONFAILED] Credenziali non valide")
                return True
        elif cmd == "AUTHENTICATE":
            mech = args[0].upper()
            if mech != "XOAUTH2":
                self.send(f"{tag} NO meccanismo non supportato")
                return True
            self.send("+ ")
            resp = base64.b64decode(self.rfile.readline().strip()).decode()
            m = re.match(r"user=([^\x01]+)\x01auth=Bearer ([^\x01]+)\x01\x01", resp)
            if m and m.group(1).lower() in BOX.users and m.group(2) == TOKEN:
                self.user = m.group(1).lower()
            else:
                self.send(f"{tag} NO [AUTHENTICATIONFAILED] token non valido")
                return True
        elif not self.user:
            self.send(f"{tag} NO prima l'accesso")
            return True
        elif cmd in ("LIST", "LSUB"):
            for name in BOX.users[self.user]["folders"]:
                fl = SPECIAL.get(name, "")
                kids = "\\HasNoChildren" + (" " + fl if fl else "")
                self.send(f'* {cmd} ({kids}) "/" "{_utf7_enc(name)}"')
        elif cmd in ("SELECT", "EXAMINE"):
            name = _utf7_dec(str(args[0]))
            name = "INBOX" if name.upper() == "INBOX" else name
            f = BOX.users[self.user]["folders"].get(name)
            if f is None:
                self.send(f"{tag} NO cartella inesistente")
                return True
            self.sel, self.ro = name, cmd == "EXAMINE"
            self.send("* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft $Forwarded)")
            self.send(f"* {len(f['msgs'])} EXISTS")
            self.send("* 0 RECENT")
            self.send(f"* OK [UIDVALIDITY {f['uidvalidity']}] UIDs valid")
            self.send(f"* OK [UIDNEXT {f['uidnext']}] next")
            self.send(f"{tag} OK [{'READ-ONLY' if self.ro else 'READ-WRITE'}] {cmd} completato")
            return True
        elif cmd == "STATUS":
            name = _utf7_dec(str(args[0]))
            f = BOX.users[self.user]["folders"][name]
            unseen = sum(1 for m in f["msgs"] if "\\Seen" not in m["flags"])
            self.send(f'* STATUS "{args[0]}" (MESSAGES {len(f["msgs"])} UIDNEXT {f["uidnext"]} UIDVALIDITY {f["uidvalidity"]} UNSEEN {unseen})')
        elif cmd == "CREATE":
            name = _utf7_dec(str(args[0]))
            with BOX.lock:
                BOX.users[self.user]["folders"].setdefault(name, {"uidvalidity": int(time.time()) % 100000, "uidnext": 1, "msgs": []})
        elif cmd == "DELETE":
            BOX.users[self.user]["folders"].pop(_utf7_dec(str(args[0])), None)
        elif cmd == "RENAME":
            fs = BOX.users[self.user]["folders"]
            fs[_utf7_dec(str(args[1]))] = fs.pop(_utf7_dec(str(args[0])))
        elif cmd in ("SUBSCRIBE", "UNSUBSCRIBE", "CHECK", "ENABLE"):
            pass
        elif cmd == "APPEND":
            name = _utf7_dec(str(args[0]))
            flags = args[1] if len(args) > 2 and isinstance(args[1], list) else []
            raw = args[-1]
            uid = BOX.deliver(self.user, raw, name, flags)
            f = BOX.users[self.user]["folders"][name]
            self.send(f"{tag} OK [APPENDUID {f['uidvalidity']} {uid}] APPEND completato")
            return True
        elif cmd == "EXPUNGE":
            self._expunge(None)
        elif cmd == "IDLE":
            self.send("+ in attesa")
            self.rfile.readline()
        elif cmd == "CLOSE":
            self._expunge(None)
            self.sel = None
        else:
            self.send(f"{tag} BAD comando sconosciuto {cmd}")
            return True
        self.send(f"{tag} OK {cmd} completato")
        return True

    def _folder(self):
        return BOX.users[self.user]["folders"][self.sel]

    def _expunge(self, uids):
        f = self._folder()
        with BOX.lock:
            keep = []
            for i, m in enumerate(list(f["msgs"])):
                if "\\Deleted" in m["flags"] and (uids is None or m["uid"] in uids):
                    self.send(f"* {len(keep) + 1} EXPUNGE")
                else:
                    keep.append(m)
            f["msgs"] = keep

    def uid_cmd(self, tag, sub, rest, lits):
        if not self.user or not self.sel:
            self.send(f"{tag} NO nessuna cartella selezionata")
            return True
        f = self._folder()
        args = _tokens(rest, lits)
        uids = [m["uid"] for m in f["msgs"]]
        if sub == "SEARCH":
            crit = " ".join(str(a) for a in args if not isinstance(a, list)).upper()
            res = uids
            m = re.search(r"UID ([\d:,*]+)", crit)
            if m:
                res = _seqset(m.group(1), uids)
            self.send("* SEARCH " + " ".join(map(str, res)))
        elif sub == "FETCH":
            sel = _seqset(str(args[0]), uids)
            items = args[1] if isinstance(args[1], list) else [args[1]]
            items = [str(i).upper() for i in items]
            for seq, m in enumerate(f["msgs"], 1):
                if m["uid"] not in sel:
                    continue
                self.wfile.write(self._fetch_line(seq, m, items) + b"\r\n")
            self.wfile.flush()
        elif sub == "STORE":
            sel = set(_seqset(str(args[0]), uids))
            mode = str(args[1]).upper()
            fl = {str(x) for x in (args[2] if isinstance(args[2], list) else [args[2]])}
            with BOX.lock:
                for seq, m in enumerate(f["msgs"], 1):
                    if m["uid"] in sel:
                        if mode.startswith("+"):
                            m["flags"] |= fl
                        elif mode.startswith("-"):
                            m["flags"] -= fl
                        else:
                            m["flags"] = set(fl)
                        if "SILENT" not in mode:
                            self.send(f"* {seq} FETCH (UID {m['uid']} FLAGS ({' '.join(sorted(m['flags']))}))")
        elif sub in ("COPY", "MOVE"):
            sel = _seqset(str(args[0]), uids)
            dest = _utf7_dec(str(args[1]))
            df = BOX.users[self.user]["folders"].get(dest)
            if df is None:
                self.send(f"{tag} NO [TRYCREATE] cartella inesistente")
                return True
            src_u, dst_u = [], []
            with BOX.lock:
                for m in list(f["msgs"]):
                    if m["uid"] in sel:
                        nu = BOX.deliver(self.user, m["raw"], dest, m["flags"] - {"\\Deleted"})
                        src_u.append(m["uid"])
                        dst_u.append(nu)
                code = f"COPYUID {df['uidvalidity']} {','.join(map(str, src_u))} {','.join(map(str, dst_u))}"
                if sub == "MOVE":
                    self.send(f"* OK [{code}] spostati")
                    for m in [x for x in f["msgs"] if x["uid"] in sel]:
                        m["flags"].add("\\Deleted")
                    self._expunge(set(sel))
                    self.send(f"{tag} OK MOVE completato")
                else:
                    self.send(f"{tag} OK [{code}] COPY completato")
            return True
        elif sub == "EXPUNGE":
            self._expunge(set(_seqset(str(args[0]), uids)))
        else:
            self.send(f"{tag} BAD UID {sub}")
            return True
        self.send(f"{tag} OK UID {sub} completato")
        return True

    def _fetch_line(self, seq, m, items):
        parts = []
        lit = []
        want_uid = True
        for it in items:
            if it == "UID":
                continue
            if it == "FLAGS":
                parts.append(f"FLAGS ({' '.join(sorted(m['flags']))})".encode())
            elif it == "RFC822.SIZE":
                parts.append(f"RFC822.SIZE {len(m['raw'])}".encode())
            elif it == "INTERNALDATE":
                parts.append(('INTERNALDATE "' + time.strftime("%d-%b-%Y %H:%M:%S +0000", time.gmtime(m["date"])) + '"').encode())
            elif it.startswith("BODY"):
                peek = ".PEEK" in it
                sect = re.search(r"\[(.*)\]", it).group(1)
                raw = m["raw"]
                if sect == "HEADER":
                    i = raw.find(b"\r\n\r\n")
                    j = raw.find(b"\n\n")
                    data = raw[:i + 4] if i >= 0 else raw[:j + 2] if j >= 0 else raw
                else:
                    data = raw
                    if not peek and not self.ro:
                        m["flags"].add("\\Seen")
                name = f"BODY[{sect}]"
                parts.append(f"{name} {{{len(data)}}}\r\n".encode() + data)
            elif it == "ENVELOPE":
                continue
        if want_uid:
            parts.insert(0, f"UID {m['uid']}".encode())
        return f"* {seq} FETCH (".encode() + b" ".join(parts) + b")"


# ------------------------------------------------------------------ SMTP
class SmtpHandler(socketserver.StreamRequestHandler):
    def send(self, s):
        self.wfile.write(s.encode() + b"\r\n")
        self.wfile.flush()

    def handle(self):
        self.send("220 smtp.prova.it ESMTP server di prova MB Visual")
        user, frm, rcpt = None, None, []
        while True:
            line = self.rfile.readline()
            if not line:
                return
            cmd = line.decode("utf-8", "replace").strip()
            up = cmd.upper()
            if up.startswith(("EHLO", "HELO")):
                self.wfile.write(b"250-smtp.prova.it\r\n250-AUTH PLAIN LOGIN XOAUTH2\r\n250-8BITMIME\r\n250 SIZE 104857600\r\n")
                self.wfile.flush()
            elif up.startswith("AUTH PLAIN"):
                arg = cmd[10:].strip()
                if not arg:
                    self.send("334 ")
                    arg = self.rfile.readline().decode().strip()
                _, u, p = base64.b64decode(arg).decode().split("\x00")
                if u.lower() in BOX.users and p == PASSWORD:
                    user = u.lower()
                    self.send("235 2.7.0 Autenticato")
                else:
                    self.send("535 5.7.8 Credenziali non valide")
            elif up.startswith("AUTH LOGIN"):
                self.send("334 VXNlcm5hbWU6")
                u = base64.b64decode(self.rfile.readline().strip()).decode()
                self.send("334 UGFzc3dvcmQ6")
                p = base64.b64decode(self.rfile.readline().strip()).decode()
                if u.lower() in BOX.users and p == PASSWORD:
                    user = u.lower()
                    self.send("235 2.7.0 Autenticato")
                else:
                    self.send("535 5.7.8 Credenziali non valide")
            elif up.startswith("AUTH XOAUTH2"):
                resp = base64.b64decode(cmd.split()[2]).decode()
                m = re.match(r"user=([^\x01]+)\x01auth=Bearer ([^\x01]+)\x01\x01", resp)
                if m and m.group(1).lower() in BOX.users and m.group(2) == TOKEN:
                    user = m.group(1).lower()
                    self.send("235 2.7.0 Autenticato")
                else:
                    self.send("535 5.7.8 token non valido")
            elif up.startswith("MAIL FROM:"):
                if not user:
                    self.send("530 5.7.0 Autenticazione richiesta")
                    continue
                frm = parseaddr(cmd[10:].split()[0] if cmd[10:].strip() else "")[1].lower()
                rcpt = []
                self.send("250 OK")
            elif up.startswith("RCPT TO:"):
                a = parseaddr(cmd[8:])[1].lower()
                if a.startswith("rifiutato@"):
                    self.send("550 5.1.1 Destinatario inesistente")
                else:
                    rcpt.append(a)
                    self.send("250 OK")
            elif up == "DATA":
                self.send("354 Termina con <CRLF>.<CRLF>")
                data = b""
                while True:
                    ln = self.rfile.readline()
                    if ln in (b".\r\n", b".\n", b""):
                        break
                    if ln.startswith(b".."):
                        ln = ln[1:]
                    data += ln
                try:
                    route(user, frm, rcpt, data)
                    self.send("250 2.0.0 Messaggio accettato")
                except Exception as e:  # noqa: BLE001
                    import traceback
                    traceback.print_exc()
                    self.send(f"554 5.0.0 {e}")
            elif up == "RSET":
                frm, rcpt = None, []
                self.send("250 OK")
            elif up == "NOOP":
                self.send("250 OK")
            elif up == "QUIT":
                self.send("221 arrivederci")
                return
            else:
                self.send("502 comando non implementato")


def route(user, frm, rcpt, data: bytes):
    BOX.log.append({"da": frm, "a": rcpt, "dim": len(data), "ora": time.time()})
    msg = email.message_from_bytes(data, policy=email.policy.default)
    if BOX.users.get(user, {}).get("pec"):
        return route_pec(user, rcpt, data, msg)
    for a in rcpt:
        if a in BOX.users:
            BOX.deliver(a, data)
        else:
            BOX.outbound.append({"a": a, "raw": data})


def route_pec(user, rcpt, data, msg):
    subj = str(msg.get("Subject", ""))
    msgid = str(msg.get("Message-ID", "")).strip()
    to_hdr = ", ".join(str(x) for x in (msg.get_all("To") or []) + (msg.get_all("Cc") or []))
    dest = [a for _, a in getaddresses((msg.get_all("To") or []) + (msg.get_all("Cc") or []))] or rcpt
    dest = [d.lower() for d in dest]
    if "[rifiuta]" in subj.lower():
        BOX.deliver(user, pecsim.ricevuta("non-accettazione", None, user, dest, subj, msgid, errore="altro",
                                          errore_esteso="messaggio non conforme"))
        return
    BOX.deliver(user, pecsim.ricevuta("accettazione", None, user, dest, subj, msgid))
    for a in rcpt:
        env = pecsim.busta(data, user, dest, subj, msgid, to_hdr)
        if a.endswith("@" + pecsim.DOMINIO):
            if a in BOX.users:
                BOX.deliver(a, env)
                BOX.deliver(user, pecsim.ricevuta("avvenuta-consegna", data, user, dest, subj, msgid, consegna=a))
            else:
                BOX.deliver(user, pecsim.ricevuta("errore-consegna", None, user, dest, subj, msgid, consegna=a, errore="no-dest",
                                                  errore_esteso="5.1.1 - Destinatario inesistente"))
        elif a in BOX.users:  # destinatario di posta ordinaria: riceve la busta PEC come messaggio normale
            BOX.deliver(a, env)
        else:
            BOX.outbound.append({"a": a, "raw": env})


class _TS(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def start(imap_port=0, smtp_port=0):
    i = _TS(("127.0.0.1", imap_port), ImapHandler)
    s = _TS(("127.0.0.1", smtp_port), SmtpHandler)
    for srv in (i, s):
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    return i.server_address[1], s.server_address[1], (i, s)


def seed():
    """Messaggi di esempio: conversazione, allegati (PDF, DXF), immagine incorporata, invito, PEC ricevuta."""
    from email.message import EmailMessage
    from email.utils import make_msgid
    root = Path(__file__).parent / "samples"

    def mk(frm, to, subj, text, html=None, atts=(), reply=None, date_off=0, extra=None):
        m = EmailMessage()
        m["From"], m["To"], m["Subject"] = frm, to, subj
        m["Date"] = formatdate(time.time() - date_off, localtime=True)
        m["Message-ID"] = make_msgid(domain="prova.it")
        if reply:
            m["In-Reply-To"] = reply
            m["References"] = reply
        for k, v in (extra or {}).items():
            m[k] = v
        m.set_content(text)
        if html:
            m.add_alternative(html, subtype="html")
        for name, data, ct in atts:
            mt, st = ct.split("/")
            m.add_attachment(data, maintype=mt, subtype=st, filename=name)
        return m
    pdf = next(root.rglob("*.pdf"), None)
    dxf = next(root.rglob("*.dxf"), None)
    atts = []
    if pdf:
        atts.append((pdf.name, pdf.read_bytes()[:3_000_000], "application/pdf"))
    if dxf:
        atts.append((dxf.name, dxf.read_bytes()[:3_000_000], "application/dxf"))
    a = mk("Anna Bianchi <anna@cliente.prova.it>", "mario@studio.prova.it", "Commessa 24-017 - Ampliamento capannone",
           "Buongiorno,\nin allegato la tavola aggiornata e la relazione.\n\nCordiali saluti\nAnna",
           "<p>Buongiorno,</p><p>in allegato la <b>tavola aggiornata</b> e la relazione.</p><p>Cordiali saluti<br>Anna</p>"
           "<p><img src='https://example.com/logo.png' alt='logo remoto'></p>", atts, date_off=86400 * 2)
    BOX.deliver("mario@studio.prova.it", a.as_bytes())
    b = mk("Mario Rossi <mario@studio.prova.it>", "anna@cliente.prova.it", "R: Commessa 24-017 - Ampliamento capannone",
           "Grazie Anna, ricevuto. Verifico e ti aggiorno.", reply=a["Message-ID"], date_off=86400)
    BOX.deliver("mario@studio.prova.it", b.as_bytes(), "Inviata", {"\\Seen"})
    c = mk("Anna Bianchi <anna@cliente.prova.it>", "mario@studio.prova.it", "R: Commessa 24-017 - Ampliamento capannone",
           "Perfetto, attendo il computo entro venerdi'.", reply=b["Message-ID"], date_off=3600)
    BOX.deliver("mario@studio.prova.it", c.as_bytes())
    ics = ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Prova//IT\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:riunione-24017@prova.it\r\n"
           "DTSTAMP:20261020T080000Z\r\nDTSTART:20261028T090000Z\r\nDTEND:20261028T100000Z\r\nSUMMARY:Sopralluogo cantiere 24-017\r\n"
           "LOCATION:Via Roma 1, Brescia\r\nORGANIZER;CN=Anna Bianchi:mailto:anna@cliente.prova.it\r\n"
           "ATTENDEE;CN=Mario Rossi;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:mario@studio.prova.it\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
    d = mk("Anna Bianchi <anna@cliente.prova.it>", "mario@studio.prova.it", "Invito: Sopralluogo cantiere 24-017",
           "Sei invitato al sopralluogo.", date_off=7200)
    d.add_attachment(ics.encode(), maintype="text", subtype="calendar", filename="invito.ics", params={"method": "REQUEST"})
    BOX.deliver("mario@studio.prova.it", d.as_bytes())
    for i in range(30):
        e = mk(f"Fornitore {i} <info{i}@fornitore.prova.it>", "mario@studio.prova.it", f"Offerta materiali n. {100 + i}",
               f"Offerta numero {100 + i}: calcestruzzo, acciaio B450C, casseri.", date_off=86400 * (3 + i), extra={"X-Priority": "1"} if i == 3 else None)
        BOX.deliver("mario@studio.prova.it", e.as_bytes(), flags={"\\Seen"} if i > 4 else ())
    # PEC ricevuta dal Comune
    orig = mk("Comune di Prova <comune@pec.prova.it>", "studio@pec.prova.it", "Richiesta integrazioni pratica SCIA 2026/123",
              "Si richiedono le integrazioni indicate nella nota allegata.", atts=atts[:1])
    BOX.deliver("studio@pec.prova.it", pecsim.busta(orig.as_bytes(), "comune@pec.prova.it", ["studio@pec.prova.it"],
                                                    str(orig["Subject"]), str(orig["Message-ID"]), "studio@pec.prova.it"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--imap", type=int, default=1143)
    ap.add_argument("--smtp", type=int, default=1025)
    ap.add_argument("--vuoto", action="store_true")
    a = ap.parse_args()
    sys.path.insert(0, str(Path(__file__).parent.parent))
    if not a.vuoto:
        seed()
    ip, sp, _ = start(a.imap, a.smtp)
    print(json.dumps({"imap": ip, "smtp": sp, "utenti": list(BOX.users), "password": PASSWORD}), flush=True)
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
