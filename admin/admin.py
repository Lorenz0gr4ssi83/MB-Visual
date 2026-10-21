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
                                 headers={"authorization": f"Bearer {token}", "content-type": "application/json"})
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


TITLES = {"activation": "Nuova attivazione", "change": "Cambio dispositivo", "change_pending": "Cambio dispositivo DA APPROVARE",
          "report": "Nuova segnalazione", "limit": "Limite dispositivi raggiunto", "invalid_key": "Chiave non valida usata",
          "revoked_use": "Uso di licenza non valida"}


class Api:
    """Chiamate dalla finestra (window.pywebview.api.*)."""

    def __init__(self):
        self.window = None

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

    def copy(self, text):
        import subprocess
        subprocess.run(["clip"], input=text.encode("utf-16-le"), creationflags=0x08000000, check=False)
        return True


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
                new = r["avvisi"]
                st["ultimo_avviso"] = new[-1]["id"]
                _save_state(st)
                if not first or len(new) <= 5:
                    for ev in new[-5:]:
                        self.notify(TITLES.get(ev["kind"], "MB Visual"), ev["text"])
                else:
                    self.notify("MB Visual Admin", f"{len(new)} nuovi avvisi dall'ultima apertura")
                if self.api.window:
                    try:
                        self.api.window.evaluate_js("window.adminRefresh && adminRefresh()")
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
    api.window = win
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
