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

from mbvisual.paths import RES_DIR
from mbvisual.server import TOKEN, start_server

VERSION = "1.1.0"


class Api:
    """Funzioni chiamabili dall'interfaccia (window.pywebview.api.*)."""

    def __init__(self):
        self._window = None

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


def main():
    srv, port = start_server()
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

    import webview
    from webview.dom import DOMEventHandler

    api = Api()
    window = webview.create_window("MB Visual", url, js_api=api, width=1400, height=900, min_size=(900, 600),
                                   background_color="#1f2120", text_select=True)
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

    window.events.loaded += on_loaded
    icon = str(RES_DIR / "app.ico")
    webview.start(icon=icon if os.path.exists(icon) else None, private_mode=False,
                  storage_path=os.path.join(os.environ.get("LOCALAPPDATA", RES_DIR), "MBVisual", "webview"))


if __name__ == "__main__":
    main()

