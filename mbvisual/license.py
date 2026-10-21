"""Licenza dell'app per PC (server in server/, Cloudflare Worker).

Ogni PC si attiva con una chiave MBV-XXXXX-...: il server restituisce un'attivazione firmata Ed25519 legata a questo PC
(impronta = hash del MachineGuid di Windows), valida 30 giorni anche senza internet. A ogni avvio e ogni 6 ore l'app la rinnova;
se la chiave e' stata sostituita (cambio dispositivo), revocata o il PC liberato, l'app si blocca con il motivo.
In sviluppo (non eseguibile) la licenza non e' richiesta, salvo MBV_LICENZA=1.
"""
import hashlib
import json
import os
import socket
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from base64 import urlsafe_b64decode
from pathlib import Path

from . import license_pub

FROZEN = bool(getattr(sys, "frozen", False))
STORE = Path(os.environ.get("LOCALAPPDATA", tempfile.gettempdir())) / "MBVisual" / "licenza.json"
CHECK_EVERY = 6 * 3600
_lock = threading.Lock()
_cache = {"t": 0.0, "res": None}


def server_url() -> str:
    return (os.environ.get("MBV_LICENZE_URL") or getattr(license_pub, "LICENSE_URL", "")).rstrip("/")


def required() -> bool:
    # finche' il server non e' online (LICENSE_URL vuoto) le versioni distribuite restano libere: senza server
    # nessuno potrebbe attivarle
    return (FROZEN and bool(server_url())) or os.environ.get("MBV_LICENZA") == "1"


def device_id() -> str:
    """Impronta di questo Windows: cambia su un altro PC (o con Windows reinstallato)."""
    guid = ""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography", 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as k:
            guid = winreg.QueryValueEx(k, "MachineGuid")[0]
    except OSError:
        guid = socket.gethostname()
    return hashlib.sha256(f"MBVisual|pc|{guid}".encode()).hexdigest()[:40]


def device_name() -> str:
    return os.environ.get("COMPUTERNAME") or socket.gethostname()


def _b64(s: str) -> bytes:
    return urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _verify(token: str):
    """Contenuto dell'attivazione se la firma e' del nostro server e se e' di questo PC, altrimenti None."""
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    try:
        body, sig = token.split(".")
        Ed25519PublicKey.from_public_bytes(_b64(license_pub.PUBLIC_KEY)).verify(_b64(sig), body.encode())
        p = json.loads(_b64(body))
    except (ValueError, InvalidSignature):
        return None
    if p.get("d") != device_id() or p.get("t") != "pc":
        return None
    return p


def _load() -> dict:
    try:
        return json.loads(STORE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save(data: dict) -> None:
    STORE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp, STORE)


def _post(path: str, body: dict, timeout=12) -> tuple[int, dict]:
    url = server_url()
    if not url:
        raise ConnectionError("Server delle licenze non configurato")
    req = urllib.request.Request(url + path, data=json.dumps(body).encode(), headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {"errore": f"Errore del server ({e.code})"}
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ConnectionError(f"Server delle licenze non raggiungibile: {getattr(e, 'reason', e)}") from e


def _version() -> str:
    try:
        from . import update
        return update.current().get("versione", "")
    except Exception:  # noqa: BLE001
        return ""


def _result(ok: bool, stato: str, **kw) -> dict:
    return {"ok": True, "attiva": ok, "stato": stato, **kw}


def status(force: bool = False) -> dict:
    """Stato della licenza (con rinnovo online quando serve). Risultato tenuto in memoria per 60 s.
    Il primo controllo dopo l'avvio va sempre online (se raggiungibile): un dispositivo dismesso si ferma subito."""
    if not required():
        return _result(True, "sviluppo")
    with _lock:
        if not force and _cache["res"] and time.time() - _cache["t"] < 60:
            return _cache["res"]
        res = _status()
        _cache.update(t=time.time(), res=res)
        return res


def _status() -> dict:
    data = _load()
    if data.get("bloccata"):
        return _result(False, data["bloccata"].get("stato", "bloccata"), errore=data["bloccata"].get("errore", ""))
    tok = data.get("token")
    p = _verify(tok) if tok else None
    if not p:
        return _result(False, "da_attivare")
    now = time.time()
    if not _cache.get("online_done") or now - data.get("checked", 0) > CHECK_EVERY or now > p["exp"]:
        _cache["online_done"] = True
        try:
            code, r = _post("/v1/check", {"token": tok, "version": _version()})
            if code == 200 and r.get("token") and _verify(r["token"]):
                data.update(token=r["token"], checked=now)
                _save(data)
                p = _verify(r["token"])
            elif code in (401, 403, 404, 410):
                data["bloccata"] = {"stato": r.get("stato", "bloccata"), "errore": r.get("errore", "Licenza non piu' valida")}
                _save(data)
                return _result(False, data["bloccata"]["stato"], errore=data["bloccata"]["errore"])
        except ConnectionError:
            pass  # offline: vale l'attivazione firmata fino alla scadenza
    if now > p["exp"]:
        return _result(False, "offline_scaduta", errore="Sono passati piu' di 30 giorni senza collegamento a internet: collegati per rinnovare la licenza.")
    return _result(True, "attiva", cliente=p.get("c", ""), chiave=p.get("k", ""), scadenza_offline=int(p["exp"]))


def activate(key: str) -> dict:
    code, r = _post("/v1/activate", {"key": key, "device": device_id(), "kind": "pc", "name": device_name(), "version": _version()})
    if code == 200 and r.get("token") and _verify(r["token"]):
        _save({"token": r["token"], "checked": time.time()})
        _cache["res"] = None
        return status(force=True)
    return {"ok": True, "attiva": False, "stato": r.get("stato", "errore"), "errore": r.get("errore", f"Attivazione non riuscita ({code})"),
            "suggerimento": r.get("suggerimento", "")}


def account() -> dict:
    tok = _load().get("token")
    if not tok:
        raise ValueError("Licenza non attivata")
    code, r = _post("/v1/account", {"token": tok})
    if code != 200:
        raise ValueError(r.get("errore", f"Errore {code}"))
    return r


def request(kind: str, message: str = "", key: str = "") -> dict:
    """Cambio dispositivo ("change") o segnalazione ("report"). Senza attivazione valida serve la chiave."""
    data = _load()
    body = {"type": kind, "message": message, "name": device_name()}
    if key:
        body["key"] = key
    elif data.get("token") and not data.get("bloccata"):
        body["token"] = data["token"]
    else:
        raise ValueError("Inserisci la chiave di licenza")
    code, r = _post("/v1/request", body)
    if code != 200:
        raise ValueError(r.get("errore", f"Errore {code}"))
    if r.get("nuova_chiave") and kind == "change":
        # la chiave usata qui non vale piu': l'utente decide dove inserire quella nuova (se questo e' il PC dismesso,
        # attivarlo occuperebbe il posto del PC nuovo)
        data["bloccata"] = {"stato": "sostituita", "errore": "La chiave e' stata sostituita: inserisci la chiave nuova per continuare a usare MB Visual su questo PC."}
        _save(data)
    _cache["res"] = None
    return r
