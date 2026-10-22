"""Modelli 3D contenuti nei PDF (annotazioni 3D, ISO 32000-1 par. 13.6): flussi U3D (ECMA-363) e PRC (ISO 14739).

Si cercano: i flussi 3D referenziati dalle annotazioni /3D delle pagine (/3DD, anche tramite un dizionario 3DRef),
qualsiasi altro flusso con /Subtype /U3D o /PRC (es. risorse RichMedia) e i file allegati .u3d / .prc.
I flussi si scrivono decompressi in una cartella temporanea e si aprono nel visualizzatore 3D dell'app.
"""
from __future__ import annotations

import hashlib
import os
import re

from .paths import TEMP_DIR

OUT_DIR = TEMP_DIR / "pdf3d"


def _kind_of(data: bytes, subtype: str) -> str | None:
    if data[:4] == b"U3D\x00" or subtype == "/U3D":
        return "u3d"
    if data[:3] == b"PRC" or subtype == "/PRC":
        return "prc"
    return None


def _ref(value: str) -> int | None:
    m = re.match(r"^\s*(\d+)\s+0\s+R", value or "")
    return int(m.group(1)) if m else None


def extract(path: str) -> dict:
    import pymupdf

    st = os.stat(path)
    key = hashlib.sha1(f"{os.path.abspath(path).lower()}|{st.st_size}|{st.st_mtime_ns}".encode()).hexdigest()[:16]
    out = OUT_DIR / key
    stem = os.path.splitext(os.path.basename(path))[0]
    models: list[dict] = []
    seen: set[int] = set()
    with pymupdf.open(path) as doc:
        if doc.needs_pass:
            return {"ok": True, "models": [], "cifrato": True}

        def add(xref: int, page: int | None, name: str = "", view: str = ""):
            if xref in seen or not doc.xref_is_stream(xref):
                return
            subtype = doc.xref_get_key(xref, "Subtype")[1]
            try:
                data = doc.xref_stream(xref)
            except Exception:  # noqa: BLE001
                return
            kind = _kind_of(data or b"", subtype)
            if not kind or not data:
                return
            seen.add(xref)
            n = len(models) + 1
            label = f"{stem} - 3D {n}"
            safe = re.sub(r'[\\/:*?"<>|]+', "_", label + (f" p{page}" if page else ""))
            out.mkdir(parents=True, exist_ok=True)
            dest = out / f"{safe}.{kind}"
            if not dest.exists() or dest.stat().st_size != len(data):
                dest.write_bytes(data)
            models.append({"kind": kind, "page": page, "name": name or label, "view": view, "size": len(data), "path": str(dest)})

        # 1) annotazioni 3D delle pagine
        for pno in range(doc.page_count):
            page = doc[pno]
            for ax in _annot_xrefs(doc, page.xref):
                sub = doc.xref_get_key(ax, "Subtype")[1]
                if sub == "/3D":
                    t, v = doc.xref_get_key(ax, "3DD")
                    target = _ref(v) if t == "xref" else None
                    if target and not doc.xref_is_stream(target):  # 3DRef: dizionario con /3DD
                        t2, v2 = doc.xref_get_key(target, "3DD")
                        target = _ref(v2) if t2 == "xref" else None
                    name = doc.xref_get_key(ax, "Contents")[1].strip("()") if doc.xref_get_key(ax, "Contents")[0] == "string" else ""
                    if target:
                        add(target, pno + 1, name)
                elif sub == "/RichMedia":
                    _rich_media(doc, ax, pno + 1, add)
        # 2) altri flussi U3D / PRC nel documento (risorse non collegate a una pagina)
        for x in range(1, doc.xref_length()):
            try:
                if x not in seen and doc.xref_is_stream(x) and doc.xref_get_key(x, "Subtype")[1] in ("/U3D", "/PRC"):
                    add(x, None)
            except Exception:  # noqa: BLE001
                continue
        # 3) file allegati .u3d / .prc
        try:
            for i in range(doc.embfile_count()):
                info = doc.embfile_info(i)
                fn = info.get("filename") or info.get("name") or ""
                ext = os.path.splitext(fn)[1].lower()
                if ext in (".u3d", ".prc"):
                    data = doc.embfile_get(i)
                    out.mkdir(parents=True, exist_ok=True)
                    dest = out / re.sub(r'[\\/:*?"<>|]+', "_", fn)
                    dest.write_bytes(data)
                    models.append({"kind": ext[1:], "page": None, "name": fn, "view": "", "size": len(data), "path": str(dest)})
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True, "models": models}


def _annot_xrefs(doc, page_xref: int) -> list[int]:
    t, v = doc.xref_get_key(page_xref, "Annots")
    if t == "xref":  # l'elenco e' un oggetto a parte
        r = _ref(v)
        v = doc.xref_object(r) if r else ""
    return [int(m) for m in re.findall(r"(\d+)\s+0\s+R", v or "")]


def _rich_media(doc, annot_xref: int, page: int, add) -> None:
    """RichMedia (Acrobat 9+): le risorse 3D stanno tra gli Assets del RichMediaContent."""
    t, v = doc.xref_get_key(annot_xref, "RichMediaContent")
    content = _ref(v) if t == "xref" else None
    src = doc.xref_object(content) if content else (v or "")
    for m in re.findall(r"(\d+)\s+0\s+R", src):
        x = int(m)
        try:
            obj = doc.xref_object(x)
        except Exception:  # noqa: BLE001
            continue
        for ef in re.findall(r"/F\s+(\d+)\s+0\s+R", obj) + ([str(x)] if doc.xref_is_stream(x) else []):
            add(int(ef), page)
        for sub in re.findall(r"(\d+)\s+0\s+R", obj):
            try:
                o2 = doc.xref_object(int(sub))
            except Exception:  # noqa: BLE001
                continue
            for ef in re.findall(r"/EF\s*<<\s*/F\s+(\d+)\s+0\s+R", o2):
                add(int(ef), page)
