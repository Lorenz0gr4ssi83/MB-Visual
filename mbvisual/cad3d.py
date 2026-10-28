# Solidi, regioni, corpi e superfici ACIS dei DWG/DXF -> STEP, uno per entita', per la vista 3D dei disegni
# (ui/js/cad3d.js li fa triangolare da OpenCascade). Dati delle entita':
#   DWG fino al 2004 e DXF fino al 2010: testo SAT (nei DXF cifrato: lo decifra l'interfaccia);
#   DWG 2007-2010: binario SAB nell'entita' (letto da libredwg nell'interfaccia);
#   DWG 2013 e successivi: sezione AcDs del file (mbvisual/dwgacds.py, letta qui dal file: libredwg li abbina male);
#   DXF 2013 e successivi: sezione ACDSDATA (letta dall'interfaccia).
# Le coordinate restano nelle unita' del disegno (l'unita' scritta nei dati ACIS si ignora), come le altre entita'.
from __future__ import annotations

import base64
import hashlib
import json
import os
from collections import Counter

from . import acis, dwgacds
from .acis_step import Converter, StepWriter, product
from .paths import TEMP_DIR

VERSION = 1


def _step(blob, name: str) -> tuple[str | None, dict]:
    report, missing = Counter(), Counter()
    try:
        header, records, subtypes = acis.parse_any(blob)
    except (acis.AcisError, IndexError, ValueError, UnicodeDecodeError) as e:
        return None, {"missing": {f"blocco non leggibile ({e})": 1}}
    header["unit_mm"] = 1.0
    w = StepWriter()
    conv = Converter(header, records, subtypes, w)
    items = conv.bodies()
    report.update(conv.report)
    missing.update(conv.missing)
    if not items:
        return None, {"report": dict(report), "missing": dict(missing)}
    product(w, name, items)
    return w.text(name), {"report": dict(report), "missing": dict(missing)}


def _cache_dir(path: str) -> str:
    try:
        st = os.stat(path)
        key = f"{os.path.abspath(path)}|{st.st_size}|{st.st_mtime_ns}|{VERSION}"
    except OSError:
        key = f"{path}|{VERSION}"
    return os.path.join(str(TEMP_DIR), "cad3d", hashlib.sha1(key.encode("utf-8", "replace")).hexdigest()[:20])


def convert(path: str, items: list, update=None) -> dict:
    """items = [{h: handle esadecimale, sat?: testo, sab?: base64}] -> {h: {step?, report, missing}}"""
    folder = _cache_dir(path) if path else None
    index_path = os.path.join(folder, "indice.json") if folder else None
    cached = {}
    if index_path and os.path.exists(index_path):
        try:
            with open(index_path, encoding="utf-8") as f:
                cached = json.load(f)
        except (OSError, ValueError):
            cached = {}
    from_file = {}
    if path and path.lower().endswith(".dwg"):
        try:
            from_file = dwgacds.solids_from_file(path)
        except (OSError, dwgacds.DwgError, IndexError, ValueError):
            from_file = {}
    out, total = {}, max(1, len(items))
    changed = False
    for k, it in enumerate(items):
        h = str(it.get("h") or k).upper()
        if update:
            update(k / total)
        if h in cached:
            entry = dict(cached[h])
            sp = os.path.join(folder, entry.pop("file", ""))
            if entry.get("ok") and os.path.exists(sp):
                with open(sp, encoding="utf-8") as f:
                    entry["step"] = f.read()
                out[h] = entry
                continue
            if not entry.get("ok"):
                out[h] = entry
                continue
        blob = None
        try:
            hv = int(h, 16)
        except ValueError:
            hv = None
        if hv is not None and hv in from_file:
            blob = from_file[hv]
        elif it.get("sab"):
            blob = base64.b64decode(it["sab"])
        elif it.get("sat"):
            blob = it["sat"]
        if blob is None:
            entry = {"ok": False, "missing": {"dati 3D assenti": 1}}
            out[h] = entry
            cached[h] = entry
            changed = True
            continue
        step, rep = _step(blob, h)
        entry = {"ok": step is not None, **rep}
        out[h] = dict(entry, step=step) if step else entry
        if folder:
            if step:
                os.makedirs(folder, exist_ok=True)
                fn = h + ".stp"
                with open(os.path.join(folder, fn), "w", encoding="utf-8") as f:
                    f.write(step)
                entry["file"] = fn
            cached[h] = entry
            changed = True
    if folder and changed:
        os.makedirs(folder, exist_ok=True)
        with open(index_path, "w", encoding="utf-8") as f:
            json.dump(cached, f)
    return {"solids": out}
