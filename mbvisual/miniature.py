"""Miniature e anteprime per Esplora risorse, disegnate dai visualizzatori di MB Visual in una finestra nascosta.

La DLL della shell (tools/mbvshell) prova prima le immagini gia' contenute nei file (DWG, Revit, SketchUp...);
per gli altri lancia:   MBVisual.exe --miniatura <file> <uscita.png> <lato>
Il primo processo diventa il "servizio": apre una finestra WebView2 invisibile con l'interfaccia, disegna e resta
acceso ancora IDLE secondi per le richieste successive (una cartella con 50 IFC = una sola finestra). Gli altri processi
gli passano la richiesta su 127.0.0.1 (porta e token in %LOCALAPPDATA%\\MBVisual\\miniature\\servizio.json).
"""
import json
import os
import queue
import secrets
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .paths import DATA_DIR

BASE = DATA_DIR / "miniature"
INFO = BASE / "servizio.json"
LOCK = BASE / "avvio.lock"
IDLE = 90          # secondi di attesa del servizio prima di chiudersi
TIMEOUT = 60       # tempo massimo per un file
_START = time.time()


def _log(*a):
    try:
        BASE.mkdir(parents=True, exist_ok=True)
        with open(BASE / "registro.txt", "a", encoding="utf-8") as f:
            f.write(time.strftime("%H:%M:%S ") + " ".join(str(x) for x in a) + "\n")
    except OSError:
        pass


def _pid_alive(pid: int) -> bool:
    import ctypes
    h = ctypes.windll.kernel32.OpenProcess(0x1000, False, int(pid))  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return False
    code = ctypes.c_ulong()
    ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
    ctypes.windll.kernel32.CloseHandle(h)
    return code.value == 259  # STILL_ACTIVE


def _ask_service(src, out, size, wait=TIMEOUT + 10):
    """Passa la richiesta al servizio gia' acceso. None = nessun servizio raggiungibile."""
    try:
        info = json.loads(INFO.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not _pid_alive(info.get("pid", 0)):
        return None
    body = json.dumps({"src": src, "out": out, "size": size}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{info['port']}/disegna?k={info['token']}", body, {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=wait) as r:
            return json.loads(r.read())
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "errore": str(e)}


def _take_lock() -> bool:
    BASE.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return True
    except FileExistsError:
        try:  # blocco lasciato da un servizio terminato male
            pid = int(LOCK.read_text() or 0)
            if not _pid_alive(pid) or time.time() - LOCK.stat().st_mtime > 600:
                LOCK.unlink()
                return _take_lock()
        except (OSError, ValueError):
            pass
        return False


def _clean_sources(age=900):
    """Copie temporanee dei file (le fa la DLL per le miniature, che ricevono solo il contenuto) e cache oltre 300 MB."""
    import shutil
    now = time.time()
    for d in (BASE / "sorgenti").glob("*"):
        try:
            if now - d.stat().st_mtime > age:
                shutil.rmtree(d, ignore_errors=True)
        except OSError:
            pass
    try:
        files = sorted((BASE / "cache").glob("*.png"), key=lambda f: f.stat().st_atime, reverse=True)
        total = 0
        for f in files:
            total += f.stat().st_size
            if total > 300 << 20:
                f.unlink()
    except OSError:
        pass


class _Service:
    def __init__(self):
        self.q = queue.Queue()
        self.token = secrets.token_urlsafe(16)
        self.last = time.time()
        self.window = None
        self.ready = threading.Event()
        self.hide = lambda: None
        self.t0 = time.time()

    def http(self):
        svc = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                if f"k={svc.token}" not in self.path:
                    self.send_response(403)
                    self.end_headers()
                    return
                job = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
                done = threading.Event()
                job["done"] = done
                svc.q.put(job)
                done.wait(TIMEOUT + 5)
                data = json.dumps(job.get("res") or {"ok": False, "errore": "tempo scaduto"}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        srv.daemon_threads = True
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        return srv.server_address[1]

    def render(self, job):
        src, out, size = job["src"], job["out"], int(job.get("size") or 512)
        t0 = time.time()
        if os.path.isfile(out) and os.path.getmtime(out) > t0 - 600:  # gia' fatta per una richiesta precedente
            return {"ok": True, "ms": 0}
        tmp = out + ".part.png"
        js = (f"import('/js/thumbmode.js').then(m => m.capture({json.dumps(src)}, {json.dumps(tmp)}, {size}, {TIMEOUT * 1000 - 5000}))"
              ".then(r => window.__mbvThumb = r, e => window.__mbvThumb = {ok: false, errore: String(e && e.message || e)})")
        _log("disegno", src)
        self.window.evaluate_js("window.__mbvThumb = null;" + js + "; 1")
        res = None
        while time.time() - t0 < TIMEOUT:
            time.sleep(0.15)
            res = self.window.evaluate_js("window.__mbvThumb")
            if res:
                break
        res = res or {"ok": False, "errore": "tempo scaduto"}
        if res.get("ok") and os.path.isfile(tmp):
            os.replace(tmp, out)
        else:
            try:
                os.remove(tmp)
            except OSError:
                pass
        _log(Path(src).name, size, "ok" if res.get("ok") else res.get("errore"), f"{time.time() - t0:.1f}s")
        return res

    def loop(self, first):
        if not self.ready.wait(60):
            # WebView2 non e' partito (es. profilo ancora in uso da un servizio che si sta chiudendo): si esce subito,
            # la richiesta successiva accendera' un servizio nuovo
            _log("pagina non caricata: servizio chiuso")
            try:
                INFO.unlink()
            except OSError:
                pass
            os._exit(3)
        _log("servizio: pagina pronta", f"{time.time() - _START:.1f}s")
        _clean_sources()
        try:
            self.hide()
        except Exception as e:  # noqa: BLE001
            _log("finestra visibile nella barra:", e)
        time.sleep(0.5)
        if first:
            self.q.put(first)
        while True:
            try:
                job = self.q.get(timeout=1)
            except queue.Empty:
                if time.time() - self.last > IDLE:
                    break
                continue
            try:
                job["res"] = self.render(job)
            except Exception as e:  # noqa: BLE001
                job["res"] = {"ok": False, "errore": str(e)}
            self.last = time.time()
            if job.get("done"):
                job["done"].set()
        try:
            INFO.unlink()
        except OSError:
            pass
        _clean_sources()
        self.window.destroy()


def _serve(first):
    import webview
    from .server import TOKEN, start_server
    _log("servizio: avvio", f"{time.time() - _START:.1f}s")
    _, port = start_server()
    svc = _Service()
    sport = svc.http()
    INFO.write_text(json.dumps({"pid": os.getpid(), "port": sport, "token": svc.token}), encoding="utf-8")
    try:
        LOCK.unlink()
    except OSError:
        pass
    # finestra fuori dallo schermo e senza barra delle applicazioni: WebView2 disegna solo se la finestra e' "visibile"
    title = f"MB Visual - miniature {os.getpid()}"
    svc.window = webview.create_window(title, f"http://127.0.0.1:{port}/?t={TOKEN}&miniatura=1",
                                       width=900, height=900, x=-32000, y=-32000, frameless=True, focus=False)

    def hide_taskbar():
        # finestra "strumento" (niente pulsante sulla barra). Solo Win32: toccare la Form .NET da questo thread blocca tutto
        import ctypes
        u = ctypes.windll.user32
        u.FindWindowW.restype = ctypes.c_void_p
        u.GetWindowLongPtrW.restype = ctypes.c_ssize_t
        u.GetWindowLongPtrW.argtypes = [ctypes.c_void_p, ctypes.c_int]
        u.SetWindowLongPtrW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_ssize_t]
        u.ShowWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
        h = u.FindWindowW(None, title)
        if h:
            u.ShowWindow(h, 0)
            u.SetWindowLongPtrW(h, -20, (u.GetWindowLongPtrW(h, -20) | 0x80 | 0x08000000) & ~0x40000)  # TOOLWINDOW|NOACTIVATE, no APPWINDOW
            u.ShowWindow(h, 4)  # SW_SHOWNOACTIVATE
    svc.hide = hide_taskbar  # chiamata dal ciclo del servizio, a pagina caricata
    svc.window.events.loaded += lambda: svc.ready.set()
    res = {}

    def run():
        first["done"] = threading.Event()
        threading.Thread(target=svc.loop, args=(first,), daemon=True).start()
        first["done"].wait(TIMEOUT + 60)
        res.update(first.get("res") or {})

    t = threading.Thread(target=run, daemon=True)
    _log("servizio: finestra", f"{time.time() - _START:.1f}s")
    webview.start(t.start, private_mode=False,
                  storage_path=str(DATA_DIR / "webview-miniature"))
    return res


def make(src: str, out: str, size: int = 512) -> dict:
    src, out = os.path.abspath(src), os.path.abspath(out)
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    while time.time() - t0 < TIMEOUT + 30:
        r = _ask_service(src, out, size)
        if r is not None:
            return r
        if _take_lock():
            return _serve({"src": src, "out": out, "size": size})
        time.sleep(0.3)  # un altro processo sta accendendo il servizio
    return {"ok": False, "errore": "servizio non disponibile"}


def cli(argv) -> int:
    i = argv.index("--miniatura")
    try:
        src, out = argv[i + 1], argv[i + 2]
        size = int(argv[i + 3]) if len(argv) > i + 3 and argv[i + 3].isdigit() else 512
    except IndexError:
        print("uso: --miniatura <file> <uscita.png> [lato]")
        return 2
    r = make(src, out, size)
    if not r.get("ok"):
        _log("errore", src, r.get("errore"))
    return 0 if r.get("ok") else 1
