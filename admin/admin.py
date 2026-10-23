"""MB Visual Admin - gestione delle licenze di MB Visual (server in server/).

Finestra: riepilogo, licenze con i loro dispositivi, richieste e segnalazioni, avvisi. Crea, revoca, riattiva e
sostituisce licenze, libera dispositivi, approva i cambi dispositivo in attesa.
Resta attiva nell'area di notifica anche a finestra chiusa e controlla il server ogni 20 secondi: ogni nuovo avviso
(attivazione, richiesta, segnalazione, problema) arriva come notifica di Windows.

Configurazione (FUORI da OneDrive, scritta da tools/license_setup.py): %USERPROFILE%\\.mbvisual\\licenze\\
  chiavi.json (admin_token), server_url.txt (indirizzo del server; MBV_LICENZE_URL per provarlo in locale)
Uso: python admin/admin.py   (eseguibile: python admin/build_admin.py)
"""
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

VAULT = Path.home() / ".mbvisual" / "licenze"
STATE = VAULT / "admin_stato.json"
HERE = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
POLL = 20


def _cfg():
    keys = json.loads((VAULT / "chiavi.json").read_text(encoding="utf-8"))
    url = os.environ.get("MBV_LICENZE_URL") or ((VAULT / "server_url.txt").read_text().strip() if (VAULT / "server_url.txt").exists() else "")
    return url.rstrip("/"), keys["admin_token"]


def _state():
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"ultimo_avviso": 0}


def _save_state(s):
    STATE.write_text(json.dumps(s), encoding="utf-8")


def call(method: str, path: str, body=None):
    url, token = _cfg()
    if not url:
        return {"ok": False, "errore": "Indirizzo del server non impostato (server_url.txt)"}
    req = urllib.request.Request(url + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"authorization": f"Bearer {token}", "content-type": "application/json",
                                          "user-agent": "MBVisual-Admin/1.0"})  # Cloudflare blocca "Python-urllib" (errore 1010)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read() or b"{}")
        except ValueError:
            return {"ok": False, "errore": f"Errore del server ({e.code})"}
    except (urllib.error.URLError, OSError) as e:
        return {"ok": False, "errore": f"Server non raggiungibile: {getattr(e, 'reason', e)}"}


TITLES = {"activation": "Nuova attivazione", "activation_pc": "Nuovo PC attivato", "activation_mobile": "Nuovo cellulare attivato",
          "expiring": "Licenza in scadenza", "expired": "Licenza scaduta", "change": "Cambio dispositivo", "change_pending": "Cambio dispositivo DA APPROVARE",
          "report": "Nuova segnalazione", "limit": "Limite dispositivi raggiunto", "invalid_key": "Chiave non valida usata",
          "revoked_use": "Uso di licenza non valida", "admin_login": "Accesso alla gestione dal telefono"}


class Api:
    """Chiamate dalla finestra (window.pywebview.api.*)."""

    def __init__(self):
        self._window = None  # privato: pywebview esporrebbe alla pagina tutta la finestra di Windows e si blocca

    def call(self, method, path, body=None):
        return call(method, path, body)

    def config(self):
        url, _ = _cfg()
        return {"url": url, "autostart": _autostart_path().exists(), "versione": "1.0"}

    def set_url(self, url):
        VAULT.mkdir(parents=True, exist_ok=True)
        (VAULT / "server_url.txt").write_text(url.strip(), encoding="utf-8")
        return self.config()

    def set_autostart(self, on):
        p = _autostart_path()
        if on:
            import win32com.client
            sh = win32com.client.Dispatch("WScript.Shell")
            lnk = sh.CreateShortcut(str(p))
            exe = sys.executable
            lnk.TargetPath = exe
            lnk.Arguments = "" if getattr(sys, "frozen", False) else f'"{Path(__file__).resolve()}" --nascosta'
            if getattr(sys, "frozen", False):
                lnk.Arguments = "--nascosta"
            lnk.WorkingDirectory = str(Path(exe).parent)
            lnk.Save()
        else:
            p.unlink(missing_ok=True)
        return self.config()

    def pair(self):
        """Codice di 6 cifre (10 minuti, una volta sola) e link per il QR: collega l'app per telefono di MB Visual Admin."""
        return call("POST", "/admin/pair", {})

    def qr_lib(self):
        """Sorgente del generatore di QR (qrcode-generator, MIT): la pagina lo carica come modulo da un Blob."""
        for p in (HERE / "qrcode.mjs", HERE.parent / "ui" / "vendor" / "qrcode-generator" / "dist" / "qrcode.mjs"):
            if p.exists():
                return p.read_text(encoding="utf-8")
        return ""

    # ---- email con la chiave: account SMTP dell'utente (Gmail, Microsoft 365, altro), password cifrata con DPAPI
    def mail_config(self):
        c = _mail_load()
        return {"pronto": bool(c.get("server") and c.get("mittente") and c.get("password")), "password_salvata": bool(c.get("password")),
                **{k: c.get(k, "") for k in ("preset", "mittente", "server", "sicurezza", "utente")}, "porta": c.get("porta", 587)}

    def mail_set(self, cfg):
        if cfg is None:
            MAIL_CFG.unlink(missing_ok=True)
            return {"ok": True}
        old = _mail_load()
        c = {k: cfg.get(k, "") for k in ("preset", "mittente", "server", "sicurezza", "utente")}
        c["porta"] = int(cfg.get("porta") or 587)
        if not c["mittente"] or "@" not in c["mittente"] or not c["server"]:
            return {"ok": False, "errore": "Scrivi l'indirizzo del mittente e il server SMTP."}
        c["password"] = _protect(cfg["password"]) if cfg.get("password") else old.get("password", "")
        VAULT.mkdir(parents=True, exist_ok=True)
        MAIL_CFG.write_text(json.dumps(c), encoding="utf-8")
        return {"ok": True}

    def mail_send(self, to, subject, body):
        return _mail_send(to, subject, body)

    def mail_test(self):
        c = _mail_load()
        return _mail_send(c.get("mittente", ""), "Prova da MB Visual Admin", "Se leggi questa email, l'invio delle chiavi da MB Visual Admin funziona.")

    def open_mail(self, to, subject, body):
        """Mail pronta nel programma di posta predefinito (mailto)."""
        from urllib.parse import quote
        os.startfile(f"mailto:{quote(to or '')}?subject={quote(subject or '')}&body={quote(body or '')}")
        return True

    def copy(self, text):
        import subprocess
        subprocess.run(["clip"], input=text.encode("utf-16-le"), creationflags=0x08000000, check=False)
        return True


MAIL_CFG = VAULT / "admin_email.json"


def _protect(text: str) -> str:
    import base64
    import win32crypt
    return base64.b64encode(win32crypt.CryptProtectData(text.encode("utf-8"), "MB Visual Admin", None, None, None, 0)).decode()


def _unprotect(blob: str) -> str:
    import base64
    import win32crypt
    return win32crypt.CryptUnprotectData(base64.b64decode(blob), None, None, None, 0)[1].decode("utf-8")


def _mail_load() -> dict:
    try:
        return json.loads(MAIL_CFG.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _mail_send(to: str, subject: str, body: str) -> dict:
    import smtplib
    import ssl
    from email.message import EmailMessage
    from email.utils import formatdate, make_msgid
    c = _mail_load()
    if not (c.get("server") and c.get("mittente") and c.get("password")):
        return {"ok": False, "errore": "Account email non configurato (Impostazioni → Email)."}
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = c["mittente"], to, subject
    msg["Date"], msg["Message-ID"] = formatdate(localtime=True), make_msgid(domain=c["mittente"].split("@")[-1])
    msg.set_content(body)
    try:
        ctx = ssl.create_default_context()
        if c.get("sicurezza") == "ssl":
            srv = smtplib.SMTP_SSL(c["server"], int(c.get("porta") or 465), context=ctx, timeout=30)
        else:
            srv = smtplib.SMTP(c["server"], int(c.get("porta") or 587), timeout=30)
            if c.get("sicurezza") != "nessuna":  # "nessuna": solo per le prove con un server locale
                srv.starttls(context=ctx)
        with srv:
            srv.login(c.get("utente") or c["mittente"], _unprotect(c["password"]))
            srv.send_message(msg)
        return {"ok": True}
    except smtplib.SMTPAuthenticationError:
        return {"ok": False, "errore": "Accesso rifiutato dal server di posta: controlla utente e password (Gmail: serve una password per le app; "
                                        "Microsoft 365: l'invio SMTP deve essere consentito per la casella)."}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "errore": f"Invio non riuscito: {e}"}


def _autostart_path() -> Path:
    return Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup" / "MB Visual Admin.lnk"


# ---------------------------------------------------------------- avvisi in sottofondo + area di notifica
class Notifier:
    def __init__(self, api: Api):
        self.api = api
        self.icon = None
        self.unread = 0

    def start_tray(self, show, quit_):
        import pystray
        from PIL import Image
        img = Image.open(HERE / "admin.ico") if (HERE / "admin.ico").exists() else Image.new("RGB", (64, 64), (138, 140, 137))
        menu = pystray.Menu(pystray.MenuItem("Apri MB Visual Admin", lambda: show(), default=True), pystray.MenuItem("Esci", lambda: quit_()))
        self.icon = pystray.Icon("mbvisual-admin", img, "MB Visual Admin", menu)
        self.icon.run_detached()

    def notify(self, title, text):
        try:
            if self.icon:
                self.icon.notify(text[:250], title[:60])
        except Exception:  # noqa: BLE001
            pass

    def loop(self):
        st = _state()
        first = True
        while True:
            r = call("GET", f"/admin/events?after={st.get('ultimo_avviso', 0)}")
            if r.get("ok") and r.get("avvisi"):
                # notifiche a scelta (Impostazioni, salvate sul server e uguali per l'app per telefono): gli avvisi spenti
                # restano nell'elenco ma non diventano notifiche di Windows
                sel = call("GET", "/admin/settings").get("notifiche") or {}
                new = [ev for ev in r["avvisi"] if sel.get(ev["kind"], True)]
                st["ultimo_avviso"] = r["avvisi"][-1]["id"]
                _save_state(st)
                if new and (not first or len(new) <= 5):
                    for ev in new[-5:]:
                        self.notify(TITLES.get(ev["kind"], "MB Visual"), ev["text"])
                elif new:
                    self.notify("MB Visual Admin", f"{len(new)} nuovi avvisi dall'ultima apertura")
                if self.api._window:
                    try:
                        self.api._window.run_js("window.adminRefresh && setTimeout(adminRefresh, 0)")  # senza attendere risposta
                    except Exception:  # noqa: BLE001
                        pass
            first = False
            time.sleep(POLL)


def main():
    import webview
    api = Api()
    hidden = "--nascosta" in sys.argv
    win = webview.create_window("MB Visual Admin", str(HERE / "ui" / "index.html"), js_api=api, width=1200, height=800,
                                min_size=(900, 560), hidden=hidden, background_color="#1f2120")
    api._window = win
    quitting = {"v": False}

    def on_closing():
        if quitting["v"]:
            return True
        win.hide()  # resta nell'area di notifica: gli avvisi continuano ad arrivare
        return False

    def quit_():
        quitting["v"] = True
        try:
            notifier.icon.stop()
        except Exception:  # noqa: BLE001
            pass
        win.destroy()

    win.events.closing += on_closing
    notifier = Notifier(api)

    def started():
        notifier.start_tray(lambda: (win.show(), win.restore()), quit_)
        threading.Thread(target=notifier.loop, daemon=True).start()

    ico = HERE / "admin.ico"
    webview.start(started, icon=str(ico) if ico.exists() else None, private_mode=False,
                  storage_path=str(Path(os.environ.get("LOCALAPPDATA", Path.home())) / "MBVisualAdmin" / "webview"))


if __name__ == "__main__":
    main()
