"""Cache delle conversioni dei modelli 3D letti nell'interfaccia (JT, U3D, PRC e modelli 3D dei PDF).

L'interfaccia converte il file in un Web Worker (ui/js/neutral3d.js) e salva qui il risultato: struttura + proprieta'
(json) e geometria (bin). Alla riapertura dello stesso file (stesso percorso, dimensione e data) la conversione non si
rifa'. La chiave contiene anche la versione del lettore: un lettore aggiornato rifa' la conversione.
"""
from __future__ import annotations

import hashlib
import os
import time
from pathlib import Path

from .paths import TEMP_DIR

CACHE_DIR = TEMP_DIR / "modelli3d"
LIMITE_BYTE = 2 * 1024 ** 3  # oltre questa dimensione si cancellano le conversioni usate meno di recente


def _key(path: str, kind: str, ver: str) -> str:
    st = os.stat(path)
    s = f"{os.path.abspath(path).lower()}|{st.st_size}|{st.st_mtime_ns}|{kind}|{ver}"
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:24]


def get(path: str, kind: str, ver: str) -> dict:
    k = _key(path, kind, ver)
    j, b = CACHE_DIR / (k + ".json"), CACHE_DIR / (k + ".bin")
    if j.exists() and b.exists():  # il json si scrive per ultimo: se c'e', la conversione e' completa
        now = time.time()
        for f in (j, b):
            try:
                os.utime(f, (now, now))
            except OSError:
                pass
        return {"ok": True, "hit": True, "json": str(j), "bin": str(b)}
    return {"ok": True, "hit": False}


def put(path: str, kind: str, ver: str, part: str, data: bytes) -> dict:
    if part not in ("json", "bin"):
        return {"ok": False, "errore": "part"}
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    k = _key(path, kind, ver)
    dest = CACHE_DIR / f"{k}.{part}"
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, dest)
    if part == "json":
        _prune()
    return {"ok": True}


def _prune() -> None:
    try:
        files = [(f, f.stat()) for f in CACHE_DIR.iterdir() if f.suffix in (".json", ".bin")]
    except OSError:
        return
    total = sum(s.st_size for _, s in files)
    if total <= LIMITE_BYTE:
        return
    for f, s in sorted(files, key=lambda x: x[1].st_mtime):
        try:
            f.unlink()
            total -= s.st_size
        except OSError:
            continue
        if total <= LIMITE_BYTE * 0.8:
            break


def clear_all() -> int:
    n = 0
    for f in Path(CACHE_DIR).glob("*.*"):
        try:
            f.unlink()
            n += 1
        except OSError:
            pass
    return n
