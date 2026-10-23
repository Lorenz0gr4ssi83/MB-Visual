"""Statistiche d'uso anonime, SOLO con il consenso esplicito dell'utente (predefinito: no).

Chiesto con una finestra al primo avvio (ui/js/stats.js) o dalla casella del programma di installazione
(installer/mbvisual.iss scrive HKCU\\Software\\MB Visual\\Statistiche, valore Consenso 0/1: l'app lo applica e lo cancella);
modificabile in File > Impostazioni > Statistiche d'uso. Informativa: chiavi stat.inf_* (ui/js/stats.js).

Con il consenso si contano, per giorno: avvii, secondi d'uso, estensioni dei file aperti (solo quelle del registro dei formati),
funzioni usate, errori dei visualizzatori (visualizzatore, tipo di errore, estensione), componenti attivi, versione, sistema,
architettura e lingua. Identificativo = numero casuale per installazione (NON l'impronta della licenza, NON il MachineGuid,
NON la chiave), rigenerato a ogni nuovo consenso. Mai nomi di file, percorsi, contenuti, posta, Google, cloud.
I giorni conclusi partono una volta al giorno verso il server delle licenze (POST /v1/stats). Senza consenso non parte nulla
e non si conta nulla; la revoca cancella i conteggi locali e chiede al server di cancellare quelli inviati (/v1/stats/forget,
ripetuto finche' il server non conferma).
"""
import json
import os
import platform
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

from .paths import DATA_DIR, IS_MAC, IS_WIN

FROZEN = bool(getattr(sys, "frozen", False))
# MBV_STATISTICHE = altro file (prove); MBV_STAT_URL = server di prova (in sviluppo senza questa variabile non si invia nulla)
FILE = Path(os.environ["MBV_STATISTICHE"]) if os.environ.get("MBV_STATISTICHE") else DATA_DIR / "statistiche.json"
REG_KEY = r"Software\MB Visual\Statistiche"
SEND_EVERY = 6 * 3600
KEEP_DAYS = 40
RE_EXT = re.compile(r"^[a-z0-9_]{1,12}$")
RE_FUNC = re.compile(r"^[a-z0-9_.-]{1,48}$")
RE_ERR = re.compile(r"^[a-z0-9_-]{1,24}\|[A-Za-z]{1,32}\|[a-z0-9_]{0,12}$")
_lock = threading.Lock()
_wake = threading.Event()
_started = False


def _load() -> dict:
    try:
        d = json.loads(FILE.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(d: dict) -> None:
    FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = FILE.with_suffix(".tmp")
    tmp.write_bytes(json.dumps(d, ensure_ascii=False).encode("utf-8"))
    os.replace(tmp, FILE)


def _url() -> str:
    if os.environ.get("MBV_STAT_URL"):
        return os.environ["MBV_STAT_URL"].rstrip("/")
    if not FROZEN:
        return ""  # sviluppo: i dati delle prove non devono finire nelle statistiche vere
    from . import license as lic
    return lic.server_url()


def _system() -> tuple[str, str]:
    if IS_WIN:
        try:
            b = sys.getwindowsversion().build
            osn = "Windows 11" if b >= 22000 else "Windows 10" if b >= 10240 else "Windows"
        except Exception:  # noqa: BLE001
            osn = "Windows"
        try:
            from .shellint import native_arch
            return osn, native_arch()
        except Exception:  # noqa: BLE001
            return osn, platform.machine().lower()
    if IS_MAC:
        v = platform.mac_ver()[0]
        return ("macOS " + v.split(".")[0]) if v else "macOS", platform.machine().lower()
    return platform.system(), platform.machine().lower()


def _version() -> str:
    try:
        from . import update
        return str(update.current().get("versione", ""))
    except Exception:  # noqa: BLE001
        return ""


def _components() -> list:
    try:
        from . import components
        return list(components.load().get("attivi") or [])
    except Exception:  # noqa: BLE001
        return []


def _today(d: dict) -> dict:
    """Riga del giorno (creata se manca) con i dati dell'installazione aggiornati."""
    days = d.setdefault("giorni", {})
    k = date.today().isoformat()
    row = days.setdefault(k, {"launches": 0, "seconds": 0, "exts": {}, "funcs": {}, "errors": {}})
    osn, arch = _system()
    row.update(app="mac" if IS_MAC else "pc", version=_version(), os=osn, arch=arch, comps=_components())
    row.setdefault("lang", d.get("lingua", ""))
    # giorni troppo vecchi (PC rimasto a lungo senza rete): si scartano
    old = (date.today() - timedelta(days=KEEP_DAYS)).isoformat()
    for x in [x for x in days if x < old]:
        del days[x]
    return row


def _registry_choice():
    """Scelta fatta nel programma di installazione: si applica una volta e si cancella."""
    if not IS_WIN or os.environ.get("MBV_STATISTICHE"):
        return None
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_KEY, 0, winreg.KEY_READ | winreg.KEY_SET_VALUE) as k:
            v, _ = winreg.QueryValueEx(k, "Consenso")
            winreg.DeleteValue(k, "Consenso")
            return bool(int(v))
    except (OSError, ValueError):
        return None


# ---------------------------------------------------------------- API (server.py api_stats)
def status() -> dict:
    d = _load()
    return {"ok": True, "consenso": d.get("consenso") is True, "chiesto": "consenso" in d, "deciso": d.get("deciso", "")}


def set_consent(on: bool, origine: str = "app") -> dict:
    on = bool(on)
    with _lock:
        d = _load()
        was = d.get("consenso") is True
        d["consenso"] = on
        d["deciso"] = time.strftime("%Y-%m-%d %H:%M:%S")
        d["origine"] = origine
        if on and not was:
            d["inst"] = secrets.token_hex(16)   # nuovo identificativo: i dati di un consenso precedente non si collegano
            d["giorni"] = {}
            _today(d)["launches"] += 1          # la sessione in corso
        elif not on:
            if d.get("inst"):
                d.setdefault("da_cancellare", []).append(d["inst"])
            d.pop("inst", None)
            d.pop("lingua", None)
            d["giorni"] = {}
        _save(d)
    _wake.set()  # invio della richiesta di cancellazione (o dei dati) senza aspettare
    return status()


def track(b: dict) -> dict:
    """Conteggi accumulati dall'interfaccia (ui/js/stats.js, ogni 60 s). Senza consenso non si salva nulla."""
    with _lock:
        d = _load()
        if d.get("consenso") is not True or not d.get("inst"):
            return {"ok": True, "consenso": False}
        lang = str(b.get("lang") or "")[:5].lower()
        if re.fullmatch(r"[a-z]{2}(-[a-z]{2})?", lang):
            d["lingua"] = lang
        row = _today(d)
        if d.get("lingua"):
            row["lang"] = d["lingua"]
        row["seconds"] = min(86400, row.get("seconds", 0) + max(0, min(600, int(b.get("seconds") or 0))))
        for key, rx, cap in (("exts", RE_EXT, 300), ("funcs", RE_FUNC, 300), ("errors", RE_ERR, 100)):
            dst = row.setdefault(key, {})
            for k, v in (b.get(key) or {}).items():
                if rx.match(str(k)) and (k in dst or len(dst) < cap):
                    dst[k] = dst.get(k, 0) + max(0, min(10000, int(v or 0)))
        _save(d)
    return {"ok": True, "consenso": True}


# ---------------------------------------------------------------- avvio e invio
def on_launch() -> None:
    """Avvio dell'app (app.py, non le miniature): scelta dell'installazione, conteggio dell'avvio, invii in background."""
    global _started
    reg = _registry_choice()
    if reg is not None:
        set_consent(reg, "installazione")
    with _lock:
        d = _load()
        if d.get("consenso") is True and d.get("inst"):
            _today(d)["launches"] += 1
            _save(d)
    if not _started:
        _started = True
        threading.Thread(target=_loop, daemon=True, name="statistiche").start()


def _post(url: str, path: str, body: dict) -> bool:
    req = urllib.request.Request(url + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", "user-agent": f"MBVisual/{_version() or 'app'}"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status == 200 and bool(json.loads(r.read() or b"{}").get("ok"))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return False


def send_now() -> dict:
    """Una tornata: richieste di cancellazione in sospeso, poi i giorni conclusi (solo con il consenso)."""
    url = _url()
    if not url:
        return {"ok": True, "inviati": 0, "cancellazioni": 0}
    d = _load()
    forgotten = [i for i in d.get("da_cancellare", []) if _post(url, "/v1/stats/forget", {"inst": i})]
    sent = []
    if d.get("consenso") is True and d.get("inst"):
        today = date.today().isoformat()
        days = [dict(day=k, **v) for k, v in sorted((d.get("giorni") or {}).items()) if k < today]
        if days and _post(url, "/v1/stats", {"inst": d["inst"], "days": days}):
            sent = [x["day"] for x in days]
    with _lock:
        d = _load()  # rilettura: nel frattempo l'interfaccia puo' aver contato altro o cambiato la scelta
        if forgotten:
            d["da_cancellare"] = [i for i in d.get("da_cancellare", []) if i not in forgotten]
        if sent and d.get("consenso") is True:
            for k in sent:
                (d.get("giorni") or {}).pop(k, None)
            d["inviato"] = time.strftime("%Y-%m-%d %H:%M:%S")
        if forgotten or sent:
            _save(d)
    return {"ok": True, "inviati": len(sent), "cancellazioni": len(forgotten)}


def _loop() -> None:
    _wake.wait(60)  # dopo l'avvio, senza rallentarlo
    while True:
        _wake.clear()
        d = _load()
        if d.get("da_cancellare") or (d.get("consenso") is True and d.get("inst")):
            try:
                send_now()
            except Exception:  # noqa: BLE001
                pass
        _wake.wait(SEND_EVERY)
