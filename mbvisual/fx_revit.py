"""Autodesk Revit (.rvt progetti, .rfa famiglie, .rte/.rft modelli) senza Revit.

Il file e' un contenitore OLE (Compound File): si leggono solo i flussi descrittivi, che Revit scrive in chiaro:
- BasicFileInfo: versione e build di Revit, condivisione (workset), file centrale, percorso di salvataggio, GUID
- RevitPreview4.0: anteprima PNG incorporata
- PartAtom (famiglie): XML Atom con categoria, versione, parametri e tipi
- TransmissionData: XML con i riferimenti esterni (collegamenti Revit/CAD, nuvole di punti, decalcomanie...)
La geometria resta nel formato proprietario e non viene letta. Libreria: olefile (BSD-2).
"""
from __future__ import annotations

import json
import re
from xml.etree import ElementTree as ET

LABELS = {
    "Worksharing": "Condivisione del lavoro", "Username": "Utente", "Central Model Path": "Percorso del modello centrale",
    "Revit Build": "Build di Revit", "Format": "Formato (versione)", "Build": "Build", "Last Save Path": "Ultimo percorso di salvataggio",
    "Open Workset Default": "Workset aperti per impostazione", "Project Spark File": "File Spark", "Central Model Identity": "Identita' del modello centrale",
    "Locale when saved": "Lingua al salvataggio", "All Local Changes Saved To Central": "Modifiche locali salvate nel centrale",
    "Central model's version number corresponding to the last reload latest": "Versione del centrale all'ultimo aggiornamento",
    "Central model's episode GUID corresponding to the last reload latest": "GUID dell'episodio del centrale",
    "Unique Document GUID": "GUID del documento", "Unique Document Increments": "Incrementi del documento", "Model Identity": "Identita' del modello",
    "IsSingleUserCloudModel": "Modello cloud per un utente", "Author": "Autore",
}
WORKSHARING = {"Not enabled": "Non attiva", "Local": "File locale (copia di un centrale)", "Central": "File centrale"}


def _ole(path):
    import olefile
    if not olefile.isOleFile(path):
        raise ValueError("Non e' un file Revit valido (contenitore OLE assente)")
    return olefile.OleFileIO(path)


def _stream(o, name) -> bytes | None:
    try:
        return o.openstream(name).read() if o.exists(name) else None
    except Exception:
        return None


def _basic_info(b: bytes) -> list:
    """Le voci "Chiave: valore" del flusso BasicFileInfo (testo UTF-16 in mezzo a campi binari, a volte disallineato)."""
    rows = []
    texts = [b.decode("utf-16-le", "replace"), b[1:].decode("utf-16-le", "replace")]
    for k, label in LABELS.items():
        for txt in texts:
            m = re.search(r"(?<![A-Za-z' (])" + re.escape(k) + r": ?([^\r\n\x00\u0a0d\ufffd]*)", txt)
            if m:
                v = m.group(1).strip()
                rows.append({"k": k, "campo": label, "valore": WORKSHARING.get(v, v) if k == "Worksharing" else v})
                break
    return rows


def _version(rows: list, raw: bytes) -> str:
    d = {r["k"]: r["valore"] for r in rows}
    if d.get("Format"):
        return d["Format"]
    m = re.search(r"Autodesk Revit(?: Architecture| Structure| MEP| LT)? (\d{4})", d.get("Revit Build", "") or raw.decode("utf-16-le", "replace"))
    return m.group(1) if m else ""


def _png(b: bytes | None) -> bytes | None:
    if not b:
        return None
    i = b.find(b"\x89PNG\r\n\x1a\n")
    if i < 0:
        return None
    j = b.find(b"IEND", i)
    return b[i:j + 8] if j > 0 else b[i:]


def _xml_utf16(b: bytes | None):
    if not b:
        return None
    for start in (4, 0, 2):
        try:
            txt = b[start:].decode("utf-16-le")
            k = txt.find("<")
            return ET.fromstring(txt[k:].strip("\x00").encode("utf-8").replace(b'encoding="utf-16"', b"")) if k >= 0 else None
        except Exception:
            continue
    return None


def _local(tag) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _child(e, name):
    return next((c for c in e if _local(c.tag) == name), None) if e is not None else None


def _text(e, name, default=""):
    c = _child(e, name)
    return (c.text or "").strip() if c is not None and c.text else default


def _references(o) -> list:
    root = _xml_utf16(_stream(o, "TransmissionData"))
    out = []
    if root is None:
        return out
    for ref in (e for e in root.iter() if _local(e.tag) == "ExternalFileReference"):
        tipo = _text(ref, "ExternalFileReferenceType")
        path = _text(ref, "Path")
        if not path:
            continue  # tabelle interne (note chiave, codici di assieme) senza file collegato
        out.append({"tipo": tipo, "percorso": path, "tipo_percorso": _text(ref, "PathType"), "stato": _text(ref, "LinkedFileStatus"),
                    "id": _text(ref, "ElementId")})
    return out


def _part_atom(b: bytes | None) -> dict | None:
    if not b:
        return None
    try:
        root = ET.fromstring(b)
    except Exception:
        return None
    info = {"titolo": _text(root, "title"), "aggiornato": _text(root, "updated"), "categorie": [], "parametri": [], "tipi": [], "ospite": ""}
    for c in root:
        if _local(c.tag) == "category":
            term = _text(c, "term")
            if term:
                info["categorie"].append(term)
        if _local(c.tag) == "link":
            df = _child(c, "design-file")
            if df is not None:
                info["prodotto"] = _text(df, "product")
                info["versione_prodotto"] = _text(df, "product-version")
    feats = _child(root, "features")
    for feat in (feats if feats is not None else []):
        for grp in (g for g in feat if _local(g.tag) == "group"):
            gname = _text(grp, "title")
            for p in grp:
                if _local(p.tag) == "title":
                    continue
                info["parametri"].append({"gruppo": gname, "nome": p.get("displayName") or _local(p.tag).replace("_", " "),
                                          "valore": (p.text or "").strip(), "tipo": p.get("typeOfParameter") or "", "origine": p.get("type") or ""})
    fam = _child(root, "family")
    if fam is not None:
        info["ospite"] = _text(fam, "Host")
        info["numero_tipi"] = _text(fam, "variationCount")
        for part in (p for p in fam if _local(p.tag) == "part"):
            params = [{"nome": _local(x.tag).replace("_", " "), "valore": (x.text or "").strip(), "unita": x.get("units") or ""} for x in part if _local(x.tag) != "title"]
            info["tipi"].append({"nome": _text(part, "title"), "parametri": params})
    return info


def read(path: str) -> dict:
    o = _ole(path)
    try:
        bfi = _stream(o, "BasicFileInfo") or b""
        rows = _basic_info(bfi)
        streams = ["/".join(e) for e in o.listdir()]
        preview = _png(_stream(o, "RevitPreview4.0"))
        res = {"ok": True, "versione": _version(rows, bfi), "info": [{"campo": r["campo"], "valore": r["valore"]} for r in rows],
               "anteprima": bool(preview), "riferimenti": _references(o), "famiglia": _part_atom(_stream(o, "PartAtom")),
               "flussi": len(streams), "partizioni": len([s for s in streams if s.startswith("Partitions/")])}
        meta = {}
        try:
            m = o.get_metadata()
            for k in ("author", "last_saved_by", "create_time", "last_saved_time", "title", "subject"):
                v = getattr(m, k, None)
                if v:
                    meta[k] = v.decode("utf-8", "replace") if isinstance(v, bytes) else str(v)
        except Exception:
            pass
        res["metadati"] = meta
        ext = path.rsplit(".", 1)[-1].lower()
        res["tipo"] = {"rvt": "Progetto", "rfa": "Famiglia", "rte": "Modello di progetto", "rft": "Modello di famiglia"}.get(ext, "File Revit")
        return res
    finally:
        o.close()


def preview(path: str):
    o = _ole(path)
    try:
        png = _png(_stream(o, "RevitPreview4.0"))
    finally:
        o.close()
    if not png:
        raise ValueError("Il file non contiene un'anteprima")
    return png, {"Content-Type": "image/png"}


def export(path: str, out: str) -> dict:
    ext = out.rsplit(".", 1)[-1].lower()
    if ext == "png":
        data, _ = preview(path)
        with open(out, "wb") as f:
            f.write(data)
    elif ext == "json":
        with open(out, "w", encoding="utf-8") as f:
            json.dump(read(path), f, ensure_ascii=False, indent=2)
    elif ext == "txt":
        r = read(path)
        lines = [f"{r['tipo']} Revit {r['versione']}".strip(), ""]
        lines += [f"{x['campo']}: {x['valore']}" for x in r["info"]]
        fam = r.get("famiglia")
        if fam:
            lines += ["", f"Famiglia: {fam['titolo']}", f"Categoria: {', '.join(fam['categorie'])}", f"Ospite: {fam['ospite']}", f"Tipi: {fam.get('numero_tipi', '')}"]
            lines += [f"  [{p['gruppo']}] {p['nome']} = {p['valore']}" for p in fam["parametri"]]
            for t in fam["tipi"]:
                lines += [f"Tipo: {t['nome']}"] + [f"  {p['nome']} = {p['valore']} {p['unita']}".rstrip() for p in t["parametri"]]
        if r["riferimenti"]:
            lines += ["", "Riferimenti esterni:"] + [f"  {x['tipo']}: {x['percorso']} ({x['stato']})" for x in r["riferimenti"]]
        with open(out, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    else:
        raise ValueError(f"Formato non previsto: .{ext}")
    return {"ok": True, "path": out}
