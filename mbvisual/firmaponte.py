"""Firma con lo smartphone attraverso una cartella di scambio (OneDrive o altra cartella sincronizzata).

Serve per firmare senza lettore di smart card: con la CIE e l'app ufficiale CieSign del Poligrafico (NFC del telefono,
firma elettronica avanzata) o con l'app di firma remota del certificatore (ArubaSign, GoSign, Namirial...).
Queste app non hanno un'interfaccia per altri programmi, quindi: MB Visual copia il documento nella cartella di
scambio, sul telefono lo si apre (app OneDrive / File), lo si firma nell'app e si salva il file firmato nella stessa
cartella; MB Visual lo trova, lo verifica (firme valide e stesso documento) e lo salva accanto all'originale.
Nessun server raggiungibile dalla rete: passa tutto dalla sincronizzazione del servizio cloud scelto dall'utente.
"""
import json
import os
import shutil
import time
import uuid
from pathlib import Path

from . import signed
from .i18n import t

SETTINGS = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "MBVisual" / "firma.json"
NOME_CARTELLA = "MB Visual - Firma"
SIGNED_EXT = (".pdf", ".p7m", ".p7s")
_S: dict = {}  # sessioni attive: id -> stato


def onedrive_roots() -> list[dict]:
    out, seen = [], set()
    for var, kind in (("OneDriveCommercial", "lavoro"), ("OneDriveConsumer", "personale"), ("OneDrive", "")):
        p = os.environ.get(var)
        if p and Path(p).is_dir() and p.lower() not in seen:
            seen.add(p.lower())
            out.append({"cartella": str(Path(p) / NOME_CARTELLA), "nome": Path(p).name, "tipo": kind})
    return out


def _settings() -> dict:
    try:
        return json.loads(SETTINGS.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def folder_info() -> dict:
    s = _settings()
    roots = onedrive_roots()
    cur = s.get("cartella_telefono") or (roots[0]["cartella"] if roots else "")
    return {"ok": True, "cartella": cur, "proposte": roots}


def set_folder(folder: str) -> dict:
    s = _settings()
    s["cartella_telefono"] = folder
    SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS.write_text(json.dumps(s, indent=1), encoding="utf-8")
    return folder_info()


def _snapshot(folder: Path) -> dict:
    snap = {}
    for f in folder.iterdir():
        if f.is_file():
            try:
                st = f.stat()
                snap[f.name] = (st.st_size, st.st_mtime)
            except OSError:
                pass
    return snap


def start(path: str, folder: str = "") -> dict:
    """Copia il documento nella cartella di scambio e prepara il controllo dei file firmati che arriveranno."""
    p = Path(path)
    if not p.is_file():
        raise ValueError(t("srv_firma.file_non_trovato"))
    folder = folder or folder_info()["cartella"]
    if not folder:
        raise ValueError(t("srv_firma.tel_manca_cartella"))
    d = Path(folder)
    d.mkdir(parents=True, exist_ok=True)
    if folder != _settings().get("cartella_telefono"):
        set_folder(folder)
    copy = d / p.name
    if copy.exists():
        stem, ext = p.stem, p.suffix
        copy = d / f"{stem} ({time.strftime('%H%M%S')}){ext}"
    shutil.copyfile(p, copy)
    sid = uuid.uuid4().hex[:10]
    _S[sid] = {"path": str(p), "folder": str(d), "copia": str(copy), "orig": p.read_bytes(), "snap": _snapshot(d),
               "inizio": time.time(), "scartati": set(), "trovato": None}
    return {"ok": True, "id": sid, "cartella": str(d), "copia": copy.name}


def _candidates(s: dict) -> list[Path]:
    d = Path(s["folder"])
    out = []
    for f in d.iterdir():
        if not f.is_file() or f.suffix.lower() not in SIGNED_EXT or f.name.startswith((".", "~")):
            continue
        try:
            st = f.stat()
        except OSError:
            continue
        old = s["snap"].get(f.name)
        key = (f.name, st.st_size, st.st_mtime)
        if key in s["scartati"]:
            continue
        # file nuovo, oppure la copia (o un altro file) cambiata dopo l'inizio (l'app ha firmato sopra il file)
        if old is None or old != (st.st_size, st.st_mtime):
            out.append((f, key))
    return sorted(out, key=lambda x: -x[1][2])  # prima i piu' recenti


def status(sid: str) -> dict:
    s = _S.get(sid)
    if not s:
        return {"ok": True, "fase": -1}
    if s["trovato"]:
        return {"ok": True, "fase": 2, **s["trovato"]}
    for f, key in _candidates(s):
        if time.time() - key[2] < 2:  # il file sta ancora arrivando: si riprova al giro dopo
            continue
        try:
            res = check(s["orig"], f)
        except Exception:  # noqa: BLE001 - file incompleto o non firmato
            res = None
        if not res or not res.get("numero_firme") or res.get("stesso_documento") is False:
            s["scartati"].add(key)
            continue
        s["trovato"] = {"ricevuto": str(f), "nome": f.name, "esito": res}
        return {"ok": True, "fase": 2, **s["trovato"]}
    return {"ok": True, "fase": 1, "cartella": s["folder"], "secondi": int(time.time() - s["inizio"])}


def check(orig: bytes, received: Path) -> dict:
    """Verifica del file firmato arrivato dal telefono: firme valide e documento uguale all'originale."""
    data = received.read_bytes()
    res = {"tipo": None, "stesso_documento": None, "firme_valide": False, "verifica": None, "numero_firme": 0}
    if data[:5] == b"%PDF-":
        ver = signed.pdf_signatures(str(received))
        sig = [x for f in ver.get("firme") or [] for x in (f.get("firmatari") or [])]
        res.update(tipo="pades", verifica=ver, numero_firme=len(sig))
        res["firme_valide"] = bool(sig) and all(x.get("firma_valida") and x.get("integrita") for x in sig)
        if orig[:5] == b"%PDF-":
            # le app di firma aggiungono la firma in coda (aggiornamento incrementale): l'originale resta l'inizio del file
            res["stesso_documento"] = True if data.startswith(orig.rstrip(b"\r\n\x00 ")) else None
        else:
            res["stesso_documento"] = False
        return res
    ver = signed.open_signed(str(received))
    if not ver.get("ok"):
        return res
    sig = [x for lv in ver.get("livelli") or [] for x in lv.get("firmatari") or []]
    res.update(tipo="cades", verifica=ver, numero_firme=len(sig))
    res["firme_valide"] = bool(sig) and all(x.get("firma_valida") and x.get("integrita") is not False for x in sig)
    if ver.get("contenuto"):
        res["stesso_documento"] = Path(ver["contenuto"]).read_bytes() == orig
    return res


def default_out(sid: str) -> str:
    s = _S[sid]
    p = Path(s["path"])
    got = Path(s["trovato"]["ricevuto"]) if s.get("trovato") else None
    if got is not None and got.suffix.lower() in (".p7m", ".p7s"):
        return str(p) + got.suffix.lower()
    return str(p.with_name(p.stem + "_firmato.pdf")) if p.suffix.lower() == ".pdf" else str(p) + ".p7m"


def save(sid: str, out: str) -> dict:
    s = _S.get(sid)
    if not s or not s.get("trovato"):
        raise ValueError(t("srv_firma.tel_niente_da_salvare"))
    if Path(out).resolve() == Path(s["path"]).resolve():
        raise ValueError(t("srv_firma.uscita_uguale"))
    shutil.copyfile(s["trovato"]["ricevuto"], out)
    _S.pop(sid, None)
    return {"ok": True, "out": out}


def stop(sid: str) -> dict:
    _S.pop(sid, None)
    return {"ok": True}
