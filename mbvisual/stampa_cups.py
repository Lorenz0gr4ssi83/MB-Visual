"""Stampa su Mac (e Linux) con CUPS: elenco stampanti (lpstat), formati e opzioni del driver (lpoptions -l), invio con lp.

Stesso percorso della stampa di Windows (mbvisual/stampa.py): il "PDF di stampa" ha gia' una pagina per foglio alla
dimensione della carta; qui si salva (con gli stili grigi / bianco e nero gia' applicati) e si manda a lp, un lavoro
per ogni gruppo di pagine consecutive con lo stesso formato (opzione media), con copie e fascicolazione di CUPS.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import tempfile

from .i18n import t

INCH = 25.4
# nomi dei formati nei driver PPD (mm, lato corto x lato lungo)
PPD_SIZES = {
    "A0": (841, 1189), "A1": (594, 841), "A2": (420, 594), "A3": (297, 420), "A4": (210, 297), "A5": (148, 210), "A6": (105, 148),
    "B4": (250, 353), "B5": (176, 250), "ISOB4": (250, 353), "ISOB5": (176, 250), "B1": (707, 1000), "B2": (500, 707), "B3": (353, 500),
    "Letter": (215.9, 279.4), "Legal": (215.9, 355.6), "Tabloid": (279.4, 431.8), "Ledger": (279.4, 431.8),
    "Executive": (184.2, 266.7), "Statement": (139.7, 215.9), "ARCHA": (228.6, 304.8), "ARCHB": (304.8, 457.2),
    "ARCHC": (457.2, 609.6), "ARCHD": (609.6, 914.4), "ARCHE": (914.4, 1219.2), "AnsiC": (431.8, 558.8), "AnsiD": (558.8, 863.6),
    "AnsiE": (863.6, 1117.6),
}


def _run(args: list[str], timeout: int = 20) -> str:
    exe = shutil.which(args[0]) or f"/usr/bin/{args[0]}"
    r = subprocess.run([exe, *args[1:]], capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip() or f"{args[0]}: {r.returncode}")
    return r.stdout


def available() -> bool:
    return bool(shutil.which("lp") or shutil.which("lpstat"))


def printers() -> tuple[list[str], str]:
    """(nomi delle stampanti, predefinita)."""
    try:
        names = [n.strip() for n in _run(["lpstat", "-e"]).splitlines() if n.strip()]
    except Exception:  # noqa: BLE001 - CUPS spento o nessuna stampante
        names = []
    default = ""
    try:
        m = re.search(r":\s*(\S+)\s*$", _run(["lpstat", "-d"]).strip())
        default = m.group(1) if m else ""
    except Exception:  # noqa: BLE001
        pass
    return names, default if default in names else (names[0] if names else "")


def _size_mm(keyword: str):
    """Dimensioni (mm) da un nome di formato PPD ("A4", "A4.Fullbleed") o IPP ("iso_a4_210x297mm", "na_letter_8.5x11in")."""
    m = re.search(r"(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(mm|in)$", keyword)
    if m:
        k = INCH if m.group(3) == "in" else 1.0
        return float(m.group(1)) * k, float(m.group(2)) * k
    base = keyword.split(".")[0]
    for k, v in PPD_SIZES.items():
        if base.lower() == k.lower():
            return v
    return None


def _label(keyword: str, w: float, h: float) -> str:
    base = keyword.split(".")[0]
    m = re.match(r"^(?:iso|na|jis|jpn|om|roc|prc|asme|oe)_([a-z0-9-]+)_", keyword)
    name = m.group(1).upper() if m else base
    if name.lower() in ("letter", "legal", "tabloid", "ledger", "executive"):
        name = name.capitalize()
    extra = keyword[len(base):].lstrip(".")
    return f"{name} {extra}".strip() if extra and not m else name


def options(name: str) -> dict:
    """Opzioni del driver: {chiave: (scelte, predefinita)} da `lpoptions -p NOME -l`."""
    out = {}
    for line in _run(["lpoptions", "-p", name, "-l"]).splitlines():
        if ":" not in line:
            continue
        key, vals = line.split(":", 1)
        key = key.split("/")[0].strip()
        choices, default = [], None
        for v in vals.split():
            if v.startswith("*"):
                v = v[1:]
                default = v
            choices.append(v)
        out[key] = (choices, default)
    return out


def printer_info(name: str, rolls: list[int], drawing_form) -> dict:
    try:
        opts = options(name)
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(t("srv_stampa.stampante_non_disponibile_0", name) + f" ({e})") from e
    sizes, default = opts.get("PageSize") or opts.get("media") or ([], None)
    forms, seen, custom = [], set(), None
    for kw in sizes:
        if kw.lower().startswith("custom"):
            custom = {"min": [25, 25], "max": [1118, 15000]}
            continue
        wh = _size_mm(kw)
        if not wh:
            continue
        w, h = sorted(wh)
        key = (round(w), round(h), "." in kw)
        if key in seen:
            continue
        seen.add(key)
        f = {"id": 0, "name": _label(kw, w, h), "w": round(w, 1), "h": round(h, 1), "cups": kw}
        f["std"] = drawing_form(f)
        forms.append(f)
    if not forms:  # driver senza elenco: formati ISO e Letter
        for kw in ("A4", "A3", "Letter", "Legal"):
            w, h = PPD_SIZES[kw]
            forms.append({"id": 0, "name": kw, "w": w, "h": h, "cups": kw, "std": True})
    dpis = sorted({int(m.group(1)) for v in (opts.get("Resolution") or ([], None))[0] for m in [re.match(r"(\d+)", v)] if m})
    cm = opts.get("ColorModel") or opts.get("print-color-mode") or ([], None)
    color = not cm[0] or any(re.search(r"rgb|color|cmy", c, re.I) for c in cm[0])
    big = max([max(f["w"], f["h"]) for f in forms] + [0])
    plotter = big >= 841 or bool(custom and big >= 594)
    cur = next((f for f in forms if f["cups"] == default), forms[0])
    return {"ok": True, "name": name, "forms": forms, "dpi": dpis or [600], "color": color, "copies": 999, "custom": custom,
            "plotter": plotter, "rolls": [r for r in rolls if r <= 1118] if plotter and custom else [],
            "default": {"paper": cur["name"], "orientation": "portrait",
                        "color": color and not (cm[1] and re.search(r"gray|grey|mono|black", cm[1], re.I))}}


def _media(paper: dict) -> str:
    if paper.get("cups"):
        return paper["cups"]
    a, b = sorted((float(paper["w"]), float(paper["h"])))
    return f"Custom.{a:g}x{b:g}mm"


def print_pdf(pdf: str, pages: list[dict], name: str, copies: int, collate: bool, color: bool, title: str, update) -> int:
    """Manda il PDF di stampa a CUPS: un lavoro per ogni gruppo di pagine consecutive con lo stesso formato."""
    groups: list[list] = []
    for i, p in enumerate(pages):
        m = _media(p["paper"])
        if groups and groups[-1][0] == m:
            groups[-1][2] = i + 1
        else:
            groups.append([m, i + 1, i + 1])
    for n, (media, a, b) in enumerate(groups):
        update(progress=n / len(groups), message=t("srv_stampa.invio_stampante_pagina_0_1", a, len(pages)))
        args = ["lp", "-d", name, "-n", str(max(1, copies)), "-t", title or "MB Visual", "-o", f"media={media}",
                "-o", "collate=" + ("true" if collate else "false"), "-o", "fit-to-page=false"]
        if not color:
            args += ["-o", "print-color-mode=monochrome", "-o", "ColorModel=Gray"]
        if len(groups) > 1:
            args += ["-P", f"{a}-{b}"]
        try:
            _run(args + [pdf], timeout=300)
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(t("srv_stampa.stampante_ha_rifiutato_lavoro_stampa") + f" ({e})") from e
    return len(groups)


def temp_pdf() -> str:
    f = tempfile.NamedTemporaryFile(prefix="mbvisual-stampa-", suffix=".pdf", delete=False)
    f.close()
    return f.name
