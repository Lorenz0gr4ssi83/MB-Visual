"""MB Visual - avvio dell'applicazione desktop.

Uso:  MBVisual.exe [file ...]       (oppure: python app.py [file ...])
      python app.py --browser       apre l'interfaccia nel browser (per sviluppo)
"""
import json
import os
import sys
import tempfile
import webbrowser

# nell'exe senza console i messaggi tecnici vanno in un file di registro
if sys.stdout is None or sys.stderr is None:
    _log = open(os.path.join(tempfile.gettempdir(), "MBVisual.log"), "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stdout or _log
    sys.stderr = sys.stderr or _log
# app per Mac aperta dal Finder: i messaggi andrebbero persi, si scrivono in ~/Library/Logs/MBVisual.log
# (avviata dal Terminale restano nel Terminale)
elif sys.platform == "darwin" and getattr(sys, "frozen", False) and not sys.stderr.isatty() and "--browser" not in sys.argv:
    _logdir = os.path.join(os.path.expanduser("~"), "Library", "Logs")
    os.makedirs(_logdir, exist_ok=True)
    sys.stdout = sys.stderr = open(os.path.join(_logdir, "MBVisual.log"), "a", encoding="utf-8", buffering=1)
    import datetime
    print(f"--- avvio {datetime.datetime.now():%Y-%m-%d %H:%M:%S} {sys.argv}")

VERSION = "1.5.9"

# integrazione con Esplora risorse (mbvisual/shellint.py, mbvisual/miniature.py): nessuna finestra, prima degli import pesanti
if __name__ == "__main__" and "--miniatura" in sys.argv:
    from mbvisual import miniature
    sys.exit(miniature.cli(sys.argv))
if __name__ == "__main__" and "--integrazione" in sys.argv:
    from mbvisual import shellint
    sys.exit(shellint.cli(sys.argv))

from mbvisual.paths import DATA_DIR, RES_DIR
from mbvisual.server import TOKEN, start_server


class Api:
    """Funzioni chiamabili dall'interfaccia (window.pywebview.api.*)."""

    def __init__(self):
        self._window = None
        self._dirty = 0      # file aperti con modifiche non salvate (aggiornato dall'interfaccia)
        self._quit = False   # chiusura confermata dall'interfaccia

    def set_dirty(self, n):
        self._dirty = int(n or 0)

    def quit(self):
        """Chiude la finestra dopo che l'interfaccia ha chiesto se salvare i file modificati."""
        import threading
        self._quit = True
        threading.Thread(target=self._window.destroy, daemon=True).start()

    def _dialog(self, kind):
        import webview
        fd = getattr(webview, "FileDialog", None)
        if fd is not None:
            return {"open": fd.OPEN, "save": fd.SAVE, "folder": fd.FOLDER}[kind]
        return {"open": webview.OPEN_DIALOG, "save": webview.SAVE_DIALOG, "folder": webview.FOLDER_DIALOG}[kind]

    def open_files(self, multiple=True):
        res = self._window.create_file_dialog(self._dialog("open"), allow_multiple=bool(multiple))
        return list(res or [])

    def save_as(self, suggested="", directory=""):
        res = self._window.create_file_dialog(self._dialog("save"), directory=directory or "", save_filename=suggested or "")
        if not res:
            return None
        return res if isinstance(res, str) else res[0]

    def choose_folder(self):
        res = self._window.create_file_dialog(self._dialog("folder"))
        return (res[0] if res else None) if not isinstance(res, str) else res

    def version(self):
        return VERSION


def _refresh_shell():
    # integrazione con Esplora attiva ma registrata da un'altra versione o un altro exe: si riscrive (DLL nuova, percorsi)
    if sys.platform != "win32":
        return
    try:
        from mbvisual import shellint
        shellint.refresh_if_needed()
    except Exception as e:  # noqa: BLE001
        print("integrazione con Esplora non aggiornata:", e)


def _graphite_frame(window):
    """Cornice di Windows 11 color grafite come la barra del titolo dell'app (#08090B, testo chiaro).
    Su Windows 10 gli attributi non esistono e la cornice resta quella di sistema."""
    try:
        import ctypes
        hwnd = int(str(window.native.Handle.ToInt64()))
        dwm = ctypes.windll.dwmapi
        for attr, value in ((20, 1), (35, 0x000B0908), (36, 0x00F1EEEC), (34, 0x00221F1C)):  # scuro, didascalia, testo, bordo (BGR)
            v = ctypes.c_int(value)
            dwm.DwmSetWindowAttribute(hwnd, attr, ctypes.byref(v), ctypes.sizeof(v))
    except Exception as ex:  # noqa: BLE001
        print("cornice grafite non applicata:", ex)


def _unblock_files():
    """Toglie il segno "scaricato da Internet" (Zone.Identifier) dai file dell'app: con quel segno .NET rifiuta
    pythonnet/runtime/Python.Runtime.dll e la finestra non parte ("Failed to resolve Python.Runtime.Loader.Initialize").
    Si fa una volta per versione (file segnaposto in _internal). Solo Windows (sul Mac il pacchetto .app non si tocca:
    cambierebbe la firma)."""
    if not getattr(sys, "frozen", False) or sys.platform != "win32":
        return
    mark = os.path.join(RES_DIR, ".sbloccato")
    if os.path.exists(mark):
        return
    for root, _dirs, names in os.walk(RES_DIR):
        for n in names:
            if n.lower().endswith((".dll", ".pyd", ".exe", ".config")):
                try:
                    os.remove(os.path.join(root, n) + ":Zone.Identifier")
                except OSError:
                    pass
    exe = sys.executable
    try:
        os.remove(exe + ":Zone.Identifier")
    except OSError:
        pass
    try:
        with open(mark, "w") as f:
            f.write("ok")
    except OSError:
        pass


def _edge_app(url: str) -> bool:
    """Ripiego quando la finestra nativa non parte (pythonnet bloccato da criteri aziendali o antivirus):
    MB Visual in una finestra di Microsoft Edge in modalita' app, con un profilo tutto suo. True se Edge si e' aperto."""
    import subprocess
    cands = [os.path.join(os.environ.get(v, ""), "Microsoft", "Edge", "Application", "msedge.exe")
             for v in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA")]
    edge = next((c for c in cands if os.path.isfile(c)), None)
    if not edge:
        return False
    prof = os.path.join(os.environ.get("LOCALAPPDATA", tempfile.gettempdir()), "MBVisual", "edge-app")
    try:
        proc = subprocess.Popen([edge, f"--app={url}", f"--user-data-dir={prof}", "--no-first-run",
                                 "--no-default-browser-check", "--window-size=1400,900"])
    except OSError:
        return False
    # msedge.exe passa quasi sempre la finestra a un altro processo di Edge ed esce subito: non si aspetta il processo
    # ma il "lockfile" del profilo dedicato, che Edge tiene aperto (e non cancellabile) finche' la finestra e' aperta.
    import threading
    import time
    del proc
    lock = os.path.join(prof, "lockfile")
    t0 = time.time()
    while not os.path.exists(lock) and time.time() - t0 < 60:
        time.sleep(1)
    if not os.path.exists(lock):
        threading.Event().wait()  # non si sa quando si chiude: il server resta acceso
    time.sleep(5)
    while os.path.exists(lock):
        try:
            os.remove(lock)  # riuscito = Edge ha chiuso il profilo
            break
        except OSError:
            time.sleep(3)  # bloccato = finestra ancora aperta
    return True


def main():
    srv, port = start_server()
    import threading
    threading.Thread(target=_refresh_shell, daemon=True).start()
    url = f"http://127.0.0.1:{port}/?t={TOKEN}"
    files = [os.path.abspath(a) for a in sys.argv[1:] if not a.startswith("--") and os.path.exists(a)]

    if "--browser" in sys.argv:
        print(url, flush=True)
        if "--no-open" not in sys.argv:
            webbrowser.open(url)
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass
        return

    _unblock_files()
    try:
        import webview
        from webview.dom import DOMEventHandler
        from webview import guilib
        # Windows: carica subito pythonnet/WebView2 (se fallisce si passa al ripiego); Mac: WebKit (Cocoa)
        guilib.initialize("edgechromium" if sys.platform == "win32" else "cocoa" if sys.platform == "darwin" else None)
    except Exception as ex:  # noqa: BLE001
        _fallback(srv, url, ex)
        return

    api = Api()
    window = webview.create_window("MB Visual", url, js_api=api, width=1400, height=900, min_size=(900, 600),
                                   background_color="#0b0d10", text_select=True)
    api._window = window

    def on_drop(e):
        paths = [f.get("pywebviewFullPath") for f in e.get("dataTransfer", {}).get("files", [])]
        paths = [p for p in paths if p]
        if paths:
            window.evaluate_js(f"window.MB && MB.openPaths({json.dumps(paths)}, true)")

    def on_loaded():
        try:
            window.dom.document.events.drop += DOMEventHandler(on_drop, True, True)
        except Exception as ex:  # noqa: BLE001
            print("drop non disponibile:", ex)
        if files:
            window.evaluate_js(f"window.MB && MB.openPaths({json.dumps(files)})")

    def on_closing():
        # file non salvati: la finestra resta aperta e l'interfaccia chiede "Vuoi salvare?" (poi chiama api.quit)
        if api._quit or not api._dirty:
            return True
        import threading
        threading.Thread(target=lambda: window.evaluate_js("window.MB && MB.askQuit()"), daemon=True).start()
        return False

    window.events.loaded += on_loaded
    window.events.closing += on_closing
    if sys.platform == "win32":
        window.events.shown += lambda: _graphite_frame(window)
    icon = str(RES_DIR / "app.ico")
    try:
        webview.start(icon=icon if os.path.exists(icon) else None, private_mode=False,
                      storage_path=str(DATA_DIR / "webview"))
    except Exception as ex:  # noqa: BLE001
        _fallback(srv, url, ex)


def _fallback(srv, url, ex):
    """Finestra nativa non disponibile: Edge in modalita' app (niente errori a schermo, il motivo va nel registro)."""
    import threading
    import traceback
    try:
        log = str(DATA_DIR / "avvio.log")
        os.makedirs(os.path.dirname(log), exist_ok=True)
        with open(log, "a", encoding="utf-8") as f:
            f.write("finestra nativa non disponibile, uso Edge:\n" + "".join(traceback.format_exception(ex)) + "\n")
    except OSError:
        pass
    # il server gira gia' nel suo thread (start_server)
    if not _edge_app(url):
        webbrowser.open(url)
        threading.Event().wait()
    os._exit(0)


if __name__ == "__main__":
    main()

