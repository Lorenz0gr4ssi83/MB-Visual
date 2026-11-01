"""PTC Creo Parametric / Pro/ENGINEER (.prt, .asm, .drw, .frm, anche con il numero di versione: pezzo.prt.3) senza Creo.

Cosa si legge, e solo questo (nessuna decodifica dei dati compressi di PTC):
- intestazione in chiaro "#UGC:2 <TIPO> ..." fino a "#-END_OF_UGC_HEADER": tipo (PART, ASSEMBLY, DRAWING, DWGFORM...),
  nome del modello (riga "#- CMNM" con 3 cifre di lunghezza davanti) e piattaforma (MACH);
- riga di copyright con il programma e la versione che hanno salvato il file ("#Creo  TM  9.0 ... 9.0.8.0",
  "#Pro/ENGINEER  TM  Wildfire 4.0 ... M130");
- indice delle sezioni "#UGC_TOC": righe "<nome> <posizione hex> <byte> ..." (solo i nomi, per il riepilogo);
- anteprima incorporata: sezione "#THMB_IMG_MAIN" con un JPEG 256x256 non compresso (Creo 2.0 e successivi; i file
  Wildfire non ce l'hanno).
La geometria e i parametri stanno in sezioni compresse con un formato proprietario non documentato: senza Creo NON si
leggono. Per vedere il modello in 3D serve esportarlo da Creo (STEP) oppure aprirlo con Creo / Creo View, se installati:
`programs()` li cerca nelle cartelle dei programmi (PTC).
"""
from __future__ import annotations

import io
import json
import re
from pathlib import Path

from .i18n import t as tr

TIPI = {"PART": "parte", "ASSEMBLY": "assieme", "DRAWING": "disegno", "DWGFORM": "formato", "LAYOUT": "layout", "SECTION": "sezione",
        "MANUFACTURING": "lavorazione", "DIAGRAM": "schema", "REPORT": "report", "MARKUP": "markup"}
_HEAD_MAX = 64 * 1024
_SOI = re.compile(rb"\xff\xd8\xff[\xc0-\xfe]")


def is_creo(head: bytes) -> bool:
    return head.startswith(b"#UGC:")


def _head(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read(_HEAD_MAX)


def read(path: str) -> dict:
    h = _head(path)
    if not is_creo(h):
        raise ValueError(tr("srv_fx_creo.non_creo"))
    text = h.decode("latin-1")
    first = text.split("\n", 1)[0]
    parts = first.split()
    tipo = parts[1] if len(parts) > 1 else ""
    info = {"tipo": tipo, "tipo_chiave": TIPI.get(tipo, "altro"), "nome": "", "programma": "", "versione": "", "build": "", "piattaforma": "",
            "sezioni": [], "anteprima": False, "dimensione": Path(path).stat().st_size}
    m = re.search(r"#- CMNM ([0-9a-f]{3})(\S+)", text)  # lunghezza in 3 cifre esadecimali, poi il nome
    if m:
        info["nome"] = m.group(2)[: int(m.group(1), 16)]
    m = re.search(r"#- MACH (\S+)", text)
    if m:
        info["piattaforma"] = m.group(1).lstrip("_")
    names = re.findall(r"\n([A-Za-z][\w:]*) [0-9a-f]+ [0-9a-f]+ [0-9a-f]+ \d+ [0-9a-f]+ -?\d+ [0-9a-f]+ [0-9a-f]+#", text)
    full = Path(path).read_bytes() if info["dimensione"] < 400_000_000 else h
    # riga di copyright con programma e versione: subito dopo l'intestazione (Creo) o piu' avanti (Pro/ENGINEER Wildfire)
    m = re.search(rb"\n#((?:Creo|Pro/ENGINEER)[^\n]*?)\s+TM\s+([^\n(]*?)\s+\(c\)[^\n]*?Reserved\.\s*([^\n#\\]*)", full)
    if m:
        info["programma"], info["versione"], info["build"] = (g.decode("latin-1").strip() for g in m.groups())
    more = re.findall(rb"\n([A-Za-z][\w:]*) [0-9a-f]+ [0-9a-f]+ [0-9a-f]+ \d+ [0-9a-f]+ -?\d+ [0-9a-f]+ [0-9a-f]+#", full)
    seen = []
    for n in names + [x.decode("latin-1") for x in more]:
        if n not in seen and n != "NEXT_TOC_ENTRY":
            seen.append(n)
    info["sezioni"] = seen
    info["anteprima"] = _thumb(full) is not None
    info["step"] = _step_beside(path, info["nome"])
    return info


def _step_beside(path: str, model: str) -> list[str]:
    """STEP esportati da Creo nella stessa cartella con il nome del modello o del file (pezzo.prt.3 -> pezzo.stp)."""
    p = Path(path)
    stems = {p.name.lower().split(".")[0]}
    if model:
        stems.add(model.lower().split(".")[0])
    try:
        return sorted(str(f) for f in p.parent.iterdir() if f.is_file() and f.suffix.lower() in (".stp", ".step", ".p21")
                      and f.name.lower().split(".")[0] in stems)
    except OSError:
        return []


def _thumb(data: bytes) -> bytes | None:
    i = data.find(b"#THMB_IMG_MAIN")
    if i < 0:
        return None
    m = _SOI.search(data, i, i + 4096)
    if not m:
        return None
    from PIL import Image
    try:
        im = Image.open(io.BytesIO(data[m.start():]))
        im.load()
    except Exception:  # noqa: BLE001
        return None
    out = io.BytesIO()
    im.convert("RGB").save(out, "PNG")
    return out.getvalue()


def preview(path: str):
    png = _thumb(Path(path).read_bytes())
    if not png:
        raise ValueError(tr("srv_fx_creo.nessuna_anteprima"))
    return png, {"Content-Type": "image/png"}


def programs() -> list[dict]:
    """Creo Parametric e Creo View (anche Express) installati: si aprono con il file. Niente automazioni non provate."""
    from . import paths
    if not paths.IS_WIN:
        return []
    found = []
    for pattern, kind in (("PTC/Creo */Parametric/bin/parametric.exe", "parametric"), ("PTC/Creo */Common Files/*/bin/parametric.exe", "parametric"),
                          ("PTC/Creo */View Express/bin/pvexpress.exe", "view"), ("PTC/Creo */View/bin/productview.exe", "view"),
                          ("PTC/Creo View*/bin/productview.exe", "view"), ("PTC/Creo View Express*/bin/pvexpress.exe", "view")):
        for p in paths._glob_programs(pattern):
            if p.is_file() and not any(f["path"] == str(p) for f in found):
                ver = next((x for x in p.parts if x.lower().startswith("creo")), "Creo")
                found.append({"tipo": kind, "nome": ver.replace("_", " "), "path": str(p)})
    return found


def open_with(path: str, exe: str) -> dict:
    from . import paths
    if exe not in [p["path"] for p in programs()]:
        raise ValueError(tr("srv_fx_creo.programma_non_trovato"))
    paths.open_with(exe, path)
    return {"ok": True}


def export(path: str, out: str) -> dict:
    ext = out.rsplit(".", 1)[-1].lower()
    if ext == "png":
        data, _ = preview(path)
        Path(out).write_bytes(data)
    elif ext == "json":
        Path(out).write_text(json.dumps(read(path), ensure_ascii=False, indent=2), encoding="utf-8")
    elif ext == "txt":
        r = read(path)
        lines = [f"{tr('srv_fx_creo.tipo')}: {r['tipo']}", f"{tr('srv_fx_creo.nome')}: {r['nome']}",
                 f"{tr('srv_fx_creo.programma')}: {r['programma']} {r['versione']} {r['build']}".rstrip(), f"{tr('srv_fx_creo.piattaforma')}: {r['piattaforma']}",
                 "", tr("srv_fx_creo.sezioni") + ":"] + [f"  {s}" for s in r["sezioni"]]
        Path(out).write_text("\n".join(lines) + "\n", encoding="utf-8")
    else:
        raise ValueError(tr("srv_fx_creo.formato_non_previsto", ext))
    return {"ok": True, "path": out}
