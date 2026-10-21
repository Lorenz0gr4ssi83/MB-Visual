"""Collegamento con il motore IA (ia/engine.py), che gira in un processo separato con un Python dedicato.

Il motore si cerca in (nell'ordine) %USERPROFILE%\\.mbvisual\\ia (sviluppo) e %LOCALAPPDATA%\\MBVisual\\ia (installazione):
  <base>\\venv\\Scripts\\python.exe   Python con torch/diffusers (ARM64 nativo sui PC Snapdragon)
  <base>\\modelli\\                   modelli scaricati
Si avvia alla prima richiesta, resta in memoria (i modelli caricati restano pronti) e si chiude con l'app.
"""
import json
import os
import secrets
import subprocess
import threading
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from .paths import APP_DIR, DATA_DIR, IS_WIN, NO_WINDOW, RES_DIR, TEMP_DIR

OUT = TEMP_DIR / "ia"
_lock = threading.Lock()
_proc = None
_port = None
_token = secrets.token_urlsafe(16)


def _bases():
    return [Path.home() / ".mbvisual" / "ia", DATA_DIR / "ia"]


def find():
    eng = next((p for p in (RES_DIR / "ia" / "engine.py", APP_DIR / "ia" / "engine.py") if p.is_file()), None)
    for b in _bases():
        py = b / "venv" / ("Scripts/python.exe" if IS_WIN else "bin/python")
        if py.is_file() and (b / "modelli").is_dir():
            return {"python": str(py), "engine": str(eng) if eng else None, "modelli": str(b / "modelli")}
    return None


def _call(method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"http://127.0.0.1:{_port}{path}", data=data, method=method,
                                 headers={"x-mbv-token": _token, "content-type": "application/json", "user-agent": "MBVisual"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:  # il motore risponde con {"ok": false, "errore": ...}
        try:
            return json.loads(e.read())
        except Exception:  # noqa: BLE001
            return {"ok": False, "errore": f"Errore del motore IA ({e.code})"}


def _start():
    global _proc, _port
    if _proc and _proc.poll() is None and _port:
        return
    f = find()
    if not f or not f["engine"]:
        raise RuntimeError("Motore IA non installato su questo PC")
    OUT.mkdir(parents=True, exist_ok=True)
    _proc = subprocess.Popen([f["python"], f["engine"], "--models", f["modelli"], "--out", str(OUT), "--token", _token, "--parent", str(os.getpid())],
                             stdout=subprocess.PIPE, stderr=open(TEMP_DIR / "ia-motore.log", "a", encoding="utf-8"), stdin=subprocess.DEVNULL,
                             creationflags=NO_WINDOW, text=True)
    t = time.time()
    while time.time() - t < 120:
        line = _proc.stdout.readline()
        if line.startswith("PORT "):
            _port = int(line.split()[1])
            return
        if not line and _proc.poll() is not None:
            break
    raise RuntimeError("Il motore IA non si e' avviato (dettagli in %TEMP%\\MBVisual\\ia-motore.log)")


def status():
    f = find()
    if not f:
        return {"ok": True, "installato": False}
    with _lock:
        try:
            _start()
            s = _call("GET", "/status")
        except Exception as e:  # noqa: BLE001
            return {"ok": True, "installato": True, "errore": str(e)}
    return {"ok": True, "installato": True, **s}


def put(data: bytes) -> str:
    """Immagine o maschera inviata dall'interfaccia (PNG) -> file temporaneo per il motore."""
    OUT.mkdir(parents=True, exist_ok=True)
    p = OUT / f"in_{uuid.uuid4().hex[:10]}.png"
    p.write_bytes(data)
    return str(p)


def run(params: dict, update=None) -> dict:
    """Lavoro lungo (jobs.start): esegue l'operazione e intanto riporta l'avanzamento del motore."""
    with _lock:
        _start()
    res = {}

    def worker():
        res.update(_call("POST", "/run", params, timeout=3600))
    th = threading.Thread(target=worker, daemon=True)
    th.start()
    while th.is_alive():
        th.join(1.0)
        if update:
            try:
                p = _call("GET", "/progress", timeout=5)
                update(progress=p.get("p"), message=p.get("msg"))
            except Exception:  # noqa: BLE001
                pass
    if not res.get("ok"):
        raise ValueError(res.get("errore") or "Operazione IA non riuscita")
    return res


def cancel(rid: str) -> None:
    """Interrompe la richiesta con id rid (in corso o in coda): il motore si ferma al passo successivo."""
    if _proc and _proc.poll() is None and _port:
        _call("GET", "/cancel?id=" + urllib.parse.quote(rid), timeout=5)


def stop():
    global _proc
    if _proc and _proc.poll() is None:
        try:
            _call("GET", "/quit", timeout=3)
        except Exception:  # noqa: BLE001
            _proc.kill()
    _proc = None
