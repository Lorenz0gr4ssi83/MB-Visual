"""Componenti scelti dall'utente (installazione o File > Componenti...): accendono e spengono le funzioni dell'app.

I file restano tutti installati: lo scopo e' mostrare cosa sa fare l'app e lasciare scegliere cosa serve.
Registro dei componenti e dei profili: ui/components.json. Scelta in DATA_DIR/componenti.json, scritta dal programma
di installazione (installer/mbvisual.iss) o dall'app; su Windows anche in HKCU\\Software\\MB Desk\\Componenti
(valori Attivi e Profilo), da cui il setup riprende la scelta quando si aggiorna (anche in modalita' silenziosa).
"""
import json
import os
import time
from pathlib import Path

from .paths import DATA_DIR, IS_WIN, UI_DIR

# MBV_COMPONENTI = altro file (prove: non tocca la scelta vera ne' il registro)
FILE = Path(os.environ["MBV_COMPONENTI"]) if os.environ.get("MBV_COMPONENTI") else DATA_DIR / "componenti.json"
REG_KEY = r"Software\MB Visual\Componenti"  # chiave tecnica: nome storico dell'app, non visibile


def registry() -> dict:
    return json.loads((UI_DIR / "components.json").read_text(encoding="utf-8"))


def optional_ids() -> list[str]:
    return [c["id"] for c in registry()["components"] if not c.get("fixed")]


def load() -> dict:
    """Stato attuale: {esiste, profilo, attivi}. Componenti nuovi (assenti da 'noti' del file) = accesi."""
    ids = optional_ids()
    data = None
    try:
        data = json.loads(FILE.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        data = None
    if not isinstance(data, dict):
        return {"ok": True, "esiste": False, "profilo": "completo", "attivi": ids}
    on = {str(x) for x in data.get("attivi") or []}
    known = {str(x) for x in data.get("noti") or ids}
    attivi = [i for i in ids if i in on or i not in known]
    return {"ok": True, "esiste": True, "profilo": str(data.get("profilo") or "personalizzato"), "attivi": attivi}


def save(attivi, profilo: str = "personalizzato", origine: str = "app") -> dict:
    ids = optional_ids()
    on = [i for i in ids if i in set(attivi or [])]
    data = {"versione": 1, "profilo": str(profilo or "personalizzato"), "attivi": on, "noti": ids,
            "origine": origine, "data": time.strftime("%Y-%m-%d %H:%M:%S")}
    FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = FILE.with_suffix(".tmp")
    tmp.write_bytes(json.dumps(data, ensure_ascii=False, indent=1).encode("utf-8"))
    tmp.replace(FILE)
    if IS_WIN and not os.environ.get("MBV_COMPONENTI"):
        _write_registry(on, data["profilo"])
    return load()


def _write_registry(on: list[str], profilo: str) -> None:
    try:
        import winreg
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, REG_KEY) as k:
            winreg.SetValueEx(k, "Attivi", 0, winreg.REG_SZ, ",".join(on))
            winreg.SetValueEx(k, "Profilo", 0, winreg.REG_SZ, profilo)
    except OSError:
        pass  # il file JSON resta la fonte: il registro serve solo al programma di installazione
