"""Collaudo dell'invio delle chiavi per email di MB Desk Admin (admin.py) con un finto server SMTP locale.

Uso: python admin/test_mail.py   (non tocca la configurazione vera: usa una cartella temporanea)
Controlla: password cifrata con DPAPI (mai in chiaro nel file), accesso AUTH PLAIN, mittente/destinatario/oggetto/testo
con caratteri accentati, errore leggibile con la password sbagliata e senza account.
"""
import base64
import email
import json
import socketserver
import sys
import tempfile
import threading
from email import policy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import admin  # noqa: E402

tmp = Path(tempfile.mkdtemp())
admin.VAULT = tmp
admin.MAIL_CFG = tmp / "admin_email.json"
got = []
GOOD = "pass-segreta-123"


class H(socketserver.StreamRequestHandler):
    def handle(self):
        w = lambda t: self.wfile.write((t + "\r\n").encode())  # noqa: E731
        w("220 prova")
        data, rcpt = None, []
        while True:
            line = self.rfile.readline().decode().rstrip("\r\n")
            if not line:
                return
            cmd = line.split(" ")[0].upper()
            if cmd in ("EHLO", "HELO"):
                w("250-prova"); w("250 AUTH PLAIN")
            elif cmd == "AUTH":
                parts = line.split(" ")
                cred = base64.b64decode(parts[2]).split(b"\0") if len(parts) > 2 else []
                w("235 ok" if cred and cred[-1].decode() == GOOD else "535 no")
            elif cmd == "MAIL":
                w("250 ok")
            elif cmd == "RCPT":
                rcpt.append(line); w("250 ok")
            elif cmd == "DATA":
                w("354 avanti"); buf = []
                while True:
                    l2 = self.rfile.readline()
                    if l2 in (b".\r\n", b"."):
                        break
                    buf.append(l2)
                got.append((rcpt, b"".join(buf))); w("250 ok")
            elif cmd == "QUIT":
                w("221 ciao"); return
            else:
                w("250 ok")


srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
port = srv.server_address[1]
api = admin.Api()
fails = 0


def ok(c, label):
    global fails
    print(("OK   " if c else "NO   ") + label)
    fails += 0 if c else 1


ok(not api.mail_config()["pronto"] and not api.mail_send("a@b.it", "x", "y")["ok"], "senza account: invio rifiutato con un messaggio")
ok(not api.mail_set({"mittente": "senza-chiocciola", "server": ""})["ok"], "configurazione incompleta rifiutata")
r = api.mail_set({"preset": "", "mittente": "gestione@azienda.it", "server": "127.0.0.1", "porta": port, "sicurezza": "nessuna", "utente": "gestione@azienda.it", "password": GOOD})
raw = admin.MAIL_CFG.read_text(encoding="utf-8")
ok(r["ok"] and GOOD not in raw and json.loads(raw)["password"], "password salvata cifrata (non in chiaro)")
ok(api.mail_config()["pronto"] and api.mail_config()["password_salvata"], "account pronto")
api.mail_set({"preset": "", "mittente": "gestione@azienda.it", "server": "127.0.0.1", "porta": port, "sicurezza": "nessuna", "utente": "gestione@azienda.it", "password": ""})
ok(api.mail_config()["password_salvata"], "salvando senza password si tiene quella di prima")
res = api.mail_send("cliente@esempio.it", "Licenza MB Desk", "Buongiorno Città & Co.,\necco la chiave:\n\nMBV-AAAAA-BBBBB-CCCCC-DDDDD\n")
ok(res["ok"] and len(got) == 1, "email inviata")
m = email.message_from_bytes(got[-1][1], policy=policy.default)
ok(m["To"] == "cliente@esempio.it" and m["From"] == "gestione@azienda.it" and m["Subject"] == "Licenza MB Desk", "mittente, destinatario e oggetto")
ok("MBV-AAAAA-BBBBB-CCCCC-DDDDD" in m.get_content() and "Città" in m.get_content(), "testo con la chiave e lettere accentate")
ok(api.mail_test()["ok"] and email.message_from_bytes(got[-1][1], policy=policy.default)["To"] == "gestione@azienda.it", "email di prova al mittente")
cfg = json.loads(admin.MAIL_CFG.read_text(encoding="utf-8")); cfg["password"] = admin._protect("sbagliata"); admin.MAIL_CFG.write_text(json.dumps(cfg), encoding="utf-8")
bad = api.mail_send("x@y.it", "a", "b")
ok(not bad["ok"] and "password" in bad["errore"], "password sbagliata: errore leggibile")
api.mail_set(None)
ok(not admin.MAIL_CFG.exists(), "account tolto")
srv.shutdown()
print("\nTutte le prove riuscite" if not fails else f"\n{fails} prove NON riuscite")
sys.exit(1 if fails else 0)
