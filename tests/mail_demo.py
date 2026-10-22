"""Prova dell'interfaccia della posta senza account veri: server di posta di prova (tests/mailserver.py, con PEC simulata)
+ server dell'app con l'archivio della posta in una cartella temporanea. Stampa l'indirizzo da aprire (modalita' browser).

    python tests/mail_demo.py [--vuoto]     (--vuoto: nessun account, per provare la configurazione)
"""
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ["MBV_MAIL_DIR"] = tempfile.mkdtemp(prefix="mbv-posta-demo-")
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
import mailserver  # noqa: E402
from mbvisual.mail import accounts, commesse, engine  # noqa: E402
from mbvisual.server import TOKEN, start_server  # noqa: E402

mailserver.seed()
ip, sp, _ = mailserver.start()
if "--vuoto" not in sys.argv:
    for email, pec, nome in (("mario@studio.prova.it", False, "Studio Rossi"), ("studio@pec.prova.it", True, "PEC Studio")):
        accounts.save_account({"email": email, "nome": nome, "imap": "127.0.0.1", "imap_port": ip, "imap_sec": "none", "smtp": "127.0.0.1",
                               "smtp_port": sp, "smtp_sec": "none", "utente": email, "password": "prova", "pec": pec, "scarica_giorni": 0, "intervallo": 1})
    d = Path(os.environ["MBV_MAIL_DIR"]) / "Commessa 24-017"
    d.mkdir()
    commesse.save({"nome": "Ampliamento capannone", "codice": "24-017", "cartella": str(d), "indirizzi": ["anna@cliente.prova.it"], "colore": "#22b1bd"})
    commesse.save({"nome": "Pratica SCIA 2026/123", "codice": "2026/123", "cartella": str(d.parent), "colore": "#8f6fd6"})
srv, port = start_server()
print(f"http://localhost:{port}/?t={TOKEN}", flush=True)
print("server di posta: IMAP", ip, "SMTP", sp, "archivio", os.environ["MBV_MAIL_DIR"], flush=True)
engine.start()
while True:
    time.sleep(3600)
