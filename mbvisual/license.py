"""Licenza dell'app per PC (server in server/, Cloudflare Worker).

Ogni PC si attiva con una chiave MBV-XXXXX-...: il server restituisce un'attivazione firmata Ed25519 legata a questo PC
(impronta = hash del MachineGuid di Windows, sul Mac dell'IOPlatformUUID), valida 30 giorni anche senza internet. A ogni avvio e ogni 6 ore l'app la rinnova;
se la chiave e' stata sostituita (cambio dispositivo), revocata o il PC liberato, l'app si blocca con il motivo.
In sviluppo (non eseguibile) la licenza non e' richiesta, salvo MBV_LICENZA=1.
"""
import hashlib
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from base64 import urlsafe_b64decode
from pathlib import Path

from . import license_pub
from .paths import DATA_DIR, IS_MAC, IS_WIN, NO_WINDOW
from .i18n import t as tr

FROZEN = bool(getattr(sys, "frozen", False))
STORE = DATA_DIR / "licenza.json"
CHECK_EVERY = 6 * 3600
_lock = threading.Lock()
_cache = {"t": 0.0, "res": None}


TEST_FILE = STORE.parent / "licenza_prova.txt"  # accende la licenza solo su questo PC (prove prima dell'obbligo per tutti)


def server_url() -> str:
    url = os.environ.get("MBV_LICENZE_URL") or getattr(license_pub, "LICENSE_URL", "")
    if not url:
        try:
            url = TEST_FILE.read_text(encoding="utf-8").strip()
        except OSError:
            url = ""
    return url.rstrip("/")


def required() -> bool:
    # finche' il server non e' online (LICENSE_URL vuoto) le versioni distribuite restano libere: senza server
    # nessuno potrebbe attivarle
    return (FROZEN and bool(server_url())) or os.environ.get("MBV_LICENZA") == "1"


def _machine_guid() -> str:
    """Identificativo stabile del computer: MachineGuid di Windows, IOPlatformUUID del Mac, machine-id di Linux."""
    if IS_WIN:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography", 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as k:
            return winreg.QueryValueEx(k, "MachineGuid")[0]
    if IS_MAC:
        import re
        import subprocess
        out = subprocess.run(["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"], capture_output=True, text=True,
                             timeout=10, creationflags=NO_WINDOW).stdout
        m = re.search(r'"IOPlatformUUID"\s*=\s*"([^"]+)"', out)
        if not m:
            raise OSError("IOPlatformUUID non trovato")
        return m.group(1)
    for f in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
        try:
            v = Path(f).read_text(encoding="utf-8").strip()
            if v:
                return v
        except OSError:
            pass
    raise OSError("identificativo del computer non trovato")


def device_id() -> str:
    """Impronta di questo computer: cambia su un altro PC/Mac (o con il sistema reinstallato)."""
    try:
        guid = _machine_guid()
    except Exception:  # noqa: BLE001
        guid = socket.gethostname()
    # su Windows la stringa resta quella di sempre: le attivazioni gia' fatte restano valide
    kind = "pc" if IS_WIN or not IS_MAC else "mac"
    return hashlib.sha256(f"MBVisual|{kind}|{guid}".encode()).hexdigest()[:40]


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
        raise ConnectionError(tr("srv_license.server_licenze_non_configurato"))
    # user-agent proprio: Cloudflare blocca quello predefinito di Python ("Python-urllib", errore 1010)
    req = urllib.request.Request(url + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", "user-agent": f"MBVisual/{_version() or 'app'}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {"errore": tr("srv_license.errore_server_0", e.code)}
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ConnectionError(tr("srv_license.server_licenze_non_raggiungibile_0", getattr(e, 'reason', e))) from e


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
                data["bloccata"] = {"stato": r.get("stato", "bloccata"), "errore": r.get("errore", tr("srv_license.licenza_non_piu_valida"))}
                _save(data)
                return _result(False, data["bloccata"]["stato"], errore=data["bloccata"]["errore"])
        except ConnectionError:
            pass  # offline: vale l'attivazione firmata fino alla scadenza
    if now > p["exp"]:
        return _result(False, "offline_scaduta", errore=tr("srv_license.sono_passati_piu_30_giorni"))
    return _result(True, "attiva", cliente=p.get("c", ""), chiave=p.get("k", ""), scadenza_offline=int(p["exp"]))


def activate(key: str) -> dict:
    code, r = _post("/v1/activate", {"key": key, "device": device_id(), "kind": "pc", "name": device_name(), "version": _version()})
    if code == 200 and r.get("token") and _verify(r["token"]):
        _save({"token": r["token"], "checked": time.time()})
        _cache["res"] = None
        return status(force=True)
    return {"ok": True, "attiva": False, "stato": r.get("stato", "errore"), "errore": r.get("errore", tr("srv_license.attivazione_non_riuscita_0", code)),
            "suggerimento": r.get("suggerimento", "")}


def account() -> dict:
    tok = _load().get("token")
    if not tok:
        raise ValueError(tr("srv_license.licenza_non_attivata"))
    code, r = _post("/v1/account", {"token": tok})
    if code != 200:
        raise ValueError(r.get("errore", tr("srv_license.errore_0", code)))
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
        raise ValueError(tr("srv_license.inserisci_chiave_licenza"))
    code, r = _post("/v1/request", body)
    if code != 200:
        raise ValueError(r.get("errore", tr("srv_license.errore_0", code)))
    if r.get("nuova_chiave") and kind == "change":
        # la chiave usata qui non vale piu': l'utente decide dove inserire quella nuova (se questo e' il PC dismesso,
        # attivarlo occuperebbe il posto del PC nuovo)
        data["bloccata"] = {"stato": "sostituita", "errore": tr("srv_license.chiave_stata_sostituita_inserisci_chiave")}
        _save(data)
    _cache["res"] = None
    return r


def mobile_link() -> dict:
    """QR della home: link monouso del server per attivare un cellulare della licenza senza scrivere la chiave.
    attivo=False (QR nascosto) senza licenza obbligatoria, senza attivazione valida o senza internet."""
    if not required() or not status().get("attiva"):
        return {"ok": True, "attivo": False}
    tok = _load().get("token")
    try:
        code, r = _post("/v1/mlink", {"token": tok}, timeout=8)
    except ConnectionError:
        return {"ok": True, "attivo": False, "offline": True}
    if code != 200:
        return {"ok": True, "attivo": False, "errore": r.get("errore", "")}
    return {"ok": True, "attivo": True, **{k: r.get(k) for k in ("liberi", "totali", "url", "scade", "attesa_fino")}}
