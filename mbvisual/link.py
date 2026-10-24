"""Collegamento PC <-> telefono in tempo reale (interfaccia: ui/js/link/linkpc.js; server: server/src/link.js).

Qui solo cio' che il browser non puo' fare da solo: dati dell'abbinamento e impostazioni salvati cifrati (DPAPI su Windows,
Portachiavi sul Mac: la chiave della stanza apre tutti i messaggi), ticket del server delle licenze con l'attivazione del
PC, file ricevuti scritti nella cartella scelta, appunti di sistema. I messaggi fra i dispositivi li cifra l'interfaccia.
"""
import json
import os
import re
import subprocess
import threading
from pathlib import Path

from .i18n import t
from .paths import DATA_DIR, IS_MAC, IS_WIN, NO_WINDOW

STORE = Path(os.environ.get("MBV_COLLEGAMENTO") or DATA_DIR / "collegamento.bin")  # MBV_COLLEGAMENTO: file di prova
_LOCK = threading.Lock()


def _protect(data: bytes, on: bool) -> bytes:
    from .cloud import _dpapi
    return _dpapi(data, on)


def default_dir() -> str:
    docs = None
    if IS_WIN:
        import ctypes
        buf = ctypes.create_unicode_buffer(260)
        if ctypes.windll.shell32.SHGetFolderPathW(None, 5, None, 0, buf) == 0:  # CSIDL_PERSONAL = Documenti (anche se spostati in OneDrive)
            docs = Path(buf.value)
    docs = docs or Path.home() / "Documents"
    return str(docs / "MB Visual" / "Dal telefono")


def load() -> dict:
    with _LOCK:
        try:
            data = json.loads(_protect(STORE.read_bytes(), False).decode("utf-8"))
        except (OSError, ValueError):
            data = {}
    data.setdefault("pairing", None)
    s = data.setdefault("settings", {})
    s.setdefault("dir", default_dir())
    s.setdefault("auto_open", True)
    s.setdefault("clip_auto", False)
    return data


def save(data: dict) -> None:
    with _LOCK:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = STORE.with_suffix(".tmp")
        tmp.write_bytes(_protect(json.dumps(data, ensure_ascii=False).encode("utf-8"), True))
        os.replace(tmp, STORE)


def ticket(room: str) -> dict:
    """Ticket di 5 minuti per entrare nella stanza: lo firma il server delle licenze se l'attivazione di questo PC e' valida."""
    from . import license as lic
    url = lic.server_url()
    tok = lic._load().get("token")
    if not url or not tok:
        return {"ok": False, "errore": t("srv_link.serve_licenza"), "licenza": True}
    try:
        code, r = lic._post("/v1/link/ticket", {"token": tok, "room": room, "name": lic.device_name()}, timeout=10)
    except ConnectionError:
        return {"ok": False, "errore": t("srv_link.senza_internet"), "offline": True}
    if code != 200 or not r.get("ticket"):
        return {"ok": False, "errore": r.get("errore") or t("srv_link.ticket_rifiutato")}
    return {"ok": True, "ticket": r["ticket"], "server": url, "nome": lic.device_name()}


def _unique(folder: Path, name: str) -> Path:
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "-", os.path.basename(name or "file")).strip(" .") or "file"
    p = folder / name
    stem, ext = os.path.splitext(name)
    n = 2
    while p.exists():
        p = folder / f"{stem} ({n}){ext}"
        n += 1
    return p


def put(name: str, data: bytes, folder: str = "") -> dict:
    d = Path(folder or load()["settings"]["dir"])
    d.mkdir(parents=True, exist_ok=True)
    p = _unique(d, name)
    p.write_bytes(data)
    return {"ok": True, "path": str(p)}


def conflict_copy(path: str, data: bytes, label: str) -> dict:
    """Versione arrivata dal telefono mentre il file del PC era cambiato: copia accanto all'originale, l'originale resta."""
    src = Path(path)
    p = _unique(src.parent, f"{src.stem} ({label}){src.suffix}")
    p.write_bytes(data)
    return {"ok": True, "path": str(p)}


def _open_clipboard() -> bool:
    import win32clipboard
    for _ in range(20):
        try:
            win32clipboard.OpenClipboard()
            return True
        except Exception:  # noqa: BLE001 - appunti occupati da un altro programma
            threading.Event().wait(0.05)
    return False


def clip_get() -> str:
    if IS_WIN:
        import win32clipboard
        if not _open_clipboard():
            return ""
        try:
            fmt = win32clipboard.CF_UNICODETEXT
            return win32clipboard.GetClipboardData(fmt) if win32clipboard.IsClipboardFormatAvailable(fmt) else ""
        finally:
            win32clipboard.CloseClipboard()
    if IS_MAC:
        return subprocess.run(["pbpaste"], capture_output=True, text=True, timeout=5).stdout
    return ""


def clip_set(text: str) -> None:
    if IS_WIN:
        import win32clipboard
        if not _open_clipboard():
            raise OSError(t("srv_link.appunti_occupati"))
        try:
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardData(win32clipboard.CF_UNICODETEXT, text)
        finally:
            win32clipboard.CloseClipboard()
    elif IS_MAC:
        subprocess.run(["pbcopy"], input=text, text=True, timeout=5, creationflags=NO_WINDOW)


def handle(op: str, q: dict, body: bytes) -> dict:
    if op == "load":
        return {"ok": True, **load()}
    if op == "save":
        cur = load()
        new = json.loads(body.decode("utf-8") or "{}")
        for k in ("pairing", "settings", "shared"):
            if k in new:
                cur[k] = new[k]
        save(cur)
        return {"ok": True}
    if op == "ticket":
        return ticket(q.get("room", ""))
    if op == "put":
        return put(q.get("name", "file"), body, q.get("folder", ""))
    if op == "conflict":
        return conflict_copy(q["path"], body, q.get("label", "telefono"))
    if op == "clip_get":
        try:
            return {"ok": True, "text": clip_get()}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "errore": str(e)}
    if op == "clip_set":
        clip_set(json.loads(body.decode("utf-8") or "{}").get("text", ""))
        return {"ok": True}
    if op == "default_dir":
        return {"ok": True, "dir": default_dir()}
    raise ValueError(t("srv_link.operazione_sconosciuta"))
