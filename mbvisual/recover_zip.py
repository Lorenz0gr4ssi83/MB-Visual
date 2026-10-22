"""Recupero di ZIP, documenti Office (docx/xlsx/pptx...) e OpenDocument danneggiati.

Si leggono le intestazioni locali (PK 03 04) una dopo l'altra, senza bisogno della directory centrale in fondo al
file (spesso e' proprio quella che manca nei file troncati). Ogni voce si decomprime per conto suo: deflate si ferma
da solo alla fine del flusso, quindi anche le voci con "data descriptor" (dimensione scritta dopo i dati) si leggono.
Le parti XML troncate si ricostruiscono con il parser tollerante di lxml; i riferimenti a parti mancanti si tolgono
da [Content_Types].xml e dai file .rels, cosi' Word, Excel e PowerPoint riaprono il documento.
"""
from __future__ import annotations

import struct
import zipfile
import zlib
from pathlib import PurePosixPath

LOCAL = b"PK\x03\x04"
MAX_ENTRY = 2 * 1024 ** 3


def scan_entries(data: bytes) -> list[dict]:
    """Voci trovate dalle intestazioni locali: {name, data, complete, crc_ok, method, offset}."""
    out = []
    pos = data.find(LOCAL)
    while pos >= 0 and pos + 30 <= len(data):
        try:
            ver, flag, method, _t, _d, crc, csize, usize, nlen, xlen = struct.unpack("<HHHHHIIIHH", data[pos + 4:pos + 30])
        except struct.error:
            break
        name_raw = data[pos + 30:pos + 30 + nlen]
        start = pos + 30 + nlen + xlen
        if nlen == 0 or nlen > 1024 or start > len(data) or method not in (0, 8, 12, 14) and method > 99:
            pos = data.find(LOCAL, pos + 4)
            continue
        name = name_raw.decode("utf-8" if flag & 0x800 else "cp437", "replace").replace("\\", "/")
        if xlen and csize == 0xFFFFFFFF:  # ZIP64: dimensioni nel campo extra
            ex = data[pos + 30 + nlen:start]
            i = 0
            while i + 4 <= len(ex):
                hid, hl = struct.unpack("<HH", ex[i:i + 4])
                if hid == 1 and hl >= 16:
                    usize, csize = struct.unpack("<QQ", ex[i + 4:i + 20])
                i += 4 + hl
        descriptor = bool(flag & 8)
        body, complete, end = b"", False, start
        if flag & 1:  # cifrata: non si puo' leggere
            nxt = data.find(LOCAL, start)
            out.append({"name": name, "data": b"", "complete": False, "crc_ok": False, "encrypted": True, "offset": pos})
            pos = nxt
            continue
        if method == 8:
            d = zlib.decompressobj(-15)
            limit = len(data) if descriptor or csize == 0 else min(len(data), start + csize)
            try:
                chunks, i = [], start
                while i < limit and not d.eof:
                    chunks.append(d.decompress(data[i:min(limit, i + (1 << 20))]))
                    i = min(limit, i + (1 << 20))
                    if sum(map(len, chunks)) > MAX_ENTRY:
                        break
                body = b"".join(chunks)
                complete = d.eof
                end = i - len(d.unused_data)
            except zlib.error:
                body = b"".join(chunks) if chunks else b""  # dati rotti a meta': resta la parte decompressa
                try:
                    body += d.flush()
                except zlib.error:
                    pass
                complete = False
                nxt = data.find(LOCAL, start)
                end = nxt if nxt > 0 else len(data)
        elif method == 0:
            if descriptor or (csize == 0 and usize == 0 and not name.endswith("/")):
                nxt = min([x for x in (data.find(LOCAL, start), data.find(b"PK\x07\x08", start), data.find(b"PK\x01\x02", start)) if x >= 0] or [len(data)])
                body = data[start:nxt]
                complete = nxt < len(data)
                end = nxt
            else:
                body = data[start:start + csize]
                complete = len(body) == csize
                end = start + csize
        else:
            nxt = data.find(LOCAL, start)
            out.append({"name": name, "data": b"", "complete": False, "crc_ok": False, "unsupported": method, "offset": pos})
            pos = nxt
            continue
        if descriptor and complete:
            j = end + (4 if data[end:end + 4] == b"PK\x07\x08" else 0)
            if j + 12 <= len(data):
                crc = struct.unpack("<I", data[j:j + 4])[0]
            end = j + 12
        crc_ok = complete and (zlib.crc32(body) & 0xFFFFFFFF) == crc
        if descriptor and complete and not crc_ok:
            crc_ok = True  # CRC del descrittore non sempre allineato (zip64): basta la fine del flusso
        out.append({"name": name, "data": body, "complete": complete, "crc_ok": crc_ok, "method": method, "offset": pos})
        pos = data.find(LOCAL, max(end, start))
    # stessa voce ripetuta (aggiornamenti in coda): vale l'ultima integra
    best: dict[str, dict] = {}
    for e in out:
        old = best.get(e["name"])
        if old is None or (e["crc_ok"] or not old["crc_ok"]):
            best[e["name"]] = e
    return list(best.values())


def kind_of(names: set[str], entries: dict[str, dict]) -> str:
    if "word/document.xml" in names or any(n.startswith("word/") for n in names):
        return "docx"
    if any(n.startswith("xl/") for n in names):
        return "xlsx"
    if any(n.startswith("ppt/") for n in names):
        return "pptx"
    if any(n.startswith("visio/") for n in names):
        return "vsdx"
    mt = entries.get("mimetype")
    if mt and mt["data"]:
        m = mt["data"][:100].decode("ascii", "replace").strip()
        return {"application/vnd.oasis.opendocument.text": "odt", "application/vnd.oasis.opendocument.spreadsheet": "ods",
                "application/vnd.oasis.opendocument.presentation": "odp", "application/vnd.oasis.opendocument.graphics": "odg",
                "application/epub+zip": "epub"}.get(m, "zip")
    if "content.xml" in names and any(n.startswith("META-INF/") for n in names):
        return "odt"
    return "zip"


def _xml_fix(data: bytes) -> bytes | None:
    """XML troncato o rovinato -> albero ricostruito da lxml (recover=True); None se non resta nulla."""
    from lxml import etree
    try:
        etree.fromstring(data)
        return data
    except Exception:  # noqa: BLE001
        pass
    try:
        parser = etree.XMLParser(recover=True, huge_tree=True)
        root = etree.fromstring(data, parser)
    except Exception:  # noqa: BLE001
        return None
    if root is None:
        return None
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


OOXML_MAIN = {
    "docx": ("word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
             "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"),
    "xlsx": ("xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
             "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"),
    "pptx": ("ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
             "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"),
}
CT_GUESS = {  # tipi di contenuto delle parti piu' comuni, per un [Content_Types].xml ricostruito
    "word/styles.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
    "word/settings.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml",
    "word/fontTable.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml",
    "word/numbering.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
    "word/webSettings.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.webSettings+xml",
    "xl/styles.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
    "xl/sharedStrings.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml",
    "docProps/core.xml": "application/vnd.openxmlformats-package.core-properties+xml",
    "docProps/app.xml": "application/vnd.openxmlformats-officedocument.extended-properties+xml",
}


def _ct_for(name: str) -> str | None:
    if name in CT_GUESS:
        return CT_GUESS[name]
    p = PurePosixPath(name)
    if p.parent.name == "worksheets" and name.startswith("xl/"):
        return "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
    if p.parent.name == "theme":
        return "application/vnd.openxmlformats-officedocument.theme+xml"
    if p.parent.name == "slides" and name.startswith("ppt/"):
        return "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"
    if p.parent.name == "slideLayouts":
        return "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"
    if p.parent.name == "slideMasters":
        return "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"
    for prefix, ct in (("word/header", "wordprocessingml.header+xml"), ("word/footer", "wordprocessingml.footer+xml")):
        if name.startswith(prefix):
            return "application/vnd.openxmlformats-officedocument." + ct
    return None


def _rels_target(rels_name: str, target: str) -> str:
    """Percorso nel pacchetto della destinazione di una relazione (relativa alla cartella della parte)."""
    if target.startswith("/"):
        return target.lstrip("/")
    base = PurePosixPath(rels_name).parent.parent  # word/_rels/document.xml.rels -> word
    parts = []
    for seg in (base / target).parts:
        if seg == "..":
            if parts:
                parts.pop()
        elif seg != ".":
            parts.append(seg)
    return "/".join(parts)


def _fix_ooxml(kind: str, files: dict[str, bytes], notes: list) -> None:
    from lxml import etree
    main, main_ct, main_rel = OOXML_MAIN[kind]
    names = set(files)
    # [Content_Types].xml
    ct = files.get("[Content_Types].xml")
    root = None
    if ct:
        try:
            root = etree.fromstring(ct)
        except Exception:  # noqa: BLE001
            root = None
    ns = "http://schemas.openxmlformats.org/package/2006/content-types"
    if root is None:
        notes.append(("srv_recover.zip_ct_ricostruito",))
        root = etree.Element(f"{{{ns}}}Types", nsmap={None: ns})
        for ext, typ in (("rels", "application/vnd.openxmlformats-package.relationships+xml"), ("xml", "application/xml"),
                         ("png", "image/png"), ("jpeg", "image/jpeg"), ("jpg", "image/jpeg"), ("gif", "image/gif"), ("emf", "image/x-emf")):
            etree.SubElement(root, f"{{{ns}}}Default", Extension=ext, ContentType=typ)
        for n in sorted(names):
            typ = main_ct if n == main else _ct_for(n)
            if typ:
                etree.SubElement(root, f"{{{ns}}}Override", PartName="/" + n, ContentType=typ)
    else:
        for ov in list(root):
            pn = (ov.get("PartName") or "").lstrip("/")
            if ov.tag.endswith("Override") and pn and pn not in names:
                root.remove(ov)
    files["[Content_Types].xml"] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
    rns = "http://schemas.openxmlformats.org/package/2006/relationships"
    if "_rels/.rels" not in files and main in files:
        notes.append(("srv_recover.zip_rels_ricostruito",))
        r = etree.Element(f"{{{rns}}}Relationships", nsmap={None: rns})
        etree.SubElement(r, f"{{{rns}}}Relationship", Id="rId1", Type=main_rel, Target=main)
        files["_rels/.rels"] = etree.tostring(r, xml_declaration=True, encoding="UTF-8", standalone=True)
    # relazioni verso parti che non ci sono piu'
    dropped = 0
    for n in [x for x in files if x.endswith(".rels")]:
        try:
            r = etree.fromstring(files[n])
        except Exception:  # noqa: BLE001
            continue
        changed = False
        for rel in list(r):
            if rel.get("TargetMode") == "External":
                continue
            tgt = _rels_target(n, rel.get("Target") or "")
            if tgt and tgt not in files:
                r.remove(rel)
                changed = True
                dropped += 1
        if changed:
            files[n] = etree.tostring(r, xml_declaration=True, encoding="UTF-8", standalone=True)
    if dropped:
        notes.append(("srv_recover.zip_relazioni_tolte", dropped))


def _fix_odf(kind: str, files: dict[str, bytes], notes: list) -> None:
    mime = {"odt": "application/vnd.oasis.opendocument.text", "ods": "application/vnd.oasis.opendocument.spreadsheet",
            "odp": "application/vnd.oasis.opendocument.presentation", "odg": "application/vnd.oasis.opendocument.graphics",
            "epub": "application/epub+zip"}[kind]
    files.setdefault("mimetype", mime.encode())
    if kind != "epub" and "META-INF/manifest.xml" not in files:
        notes.append(("srv_recover.zip_manifest_ricostruito",))
        rows = [f' <manifest:file-entry manifest:full-path="/" manifest:media-type="{mime}"/>']
        for n in sorted(files):
            if n != "mimetype" and not n.endswith("/"):
                rows.append(f' <manifest:file-entry manifest:full-path="{n}" manifest:media-type="{"text/xml" if n.endswith(".xml") else ""}"/>')
        files["META-INF/manifest.xml"] = ('<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest='
                                          '"urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">\n'
                                          + "\n".join(rows) + "\n</manifest:manifest>\n").encode()


def recover(src: str, out: str, ext: str = "") -> dict:
    """Ricostruisce il pacchetto in `out`. Ritorna kind, conteggi e note (chiavi di traduzione con argomenti)."""
    with open(src, "rb") as f:
        data = f.read()
    entries = scan_entries(data)
    by = {e["name"]: e for e in entries}
    kind = kind_of(set(by), by)
    if ext in ("docx", "docm", "dotx", "xlsx", "xlsm", "xltx", "pptx", "pptm", "potx", "ppsx", "odt", "ods", "odp", "odg", "epub", "vsdx") and kind == "zip":
        kind = {"docm": "docx", "dotx": "docx", "xlsm": "xlsx", "xltx": "xlsx", "pptm": "pptx", "potx": "pptx", "ppsx": "pptx"}.get(ext, ext)
    office = kind in ("docx", "xlsx", "pptx", "vsdx", "odt", "ods", "odp", "odg", "epub")
    files: dict[str, bytes] = {}
    notes: list = []
    whole, rebuilt, lost = 0, 0, []
    for e in entries:
        n = e["name"]
        if n.endswith("/"):
            continue
        if e["crc_ok"]:
            files[n] = e["data"]
            whole += 1
            continue
        if office and e["data"] and n.lower().endswith((".xml", ".rels")):
            fixed = _xml_fix(e["data"])
            if fixed:
                files[n] = fixed
                rebuilt += 1
                continue
        if not office and e["data"] and not e.get("encrypted"):
            files[n] = e["data"]  # archivio qualsiasi: si tiene la parte leggibile della voce
            rebuilt += 1
            continue
        lost.append(n)
    if kind in OOXML_MAIN:
        _fix_ooxml(kind, files, notes)
    elif kind in ("odt", "ods", "odp", "odg", "epub"):
        _fix_odf(kind, files, notes)
    if not files:
        return {"kind": kind, "intere": 0, "ricostruite": 0, "perse": lost, "note": notes, "ok": False}
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        order = sorted(files, key=lambda n: (n != "mimetype", n != "[Content_Types].xml", n))
        for n in order:
            z.writestr(zipfile.ZipInfo(n, (1980, 1, 1, 0, 0, 0)) if n == "mimetype" else n, files[n],
                       compress_type=zipfile.ZIP_STORED if n == "mimetype" else zipfile.ZIP_DEFLATED)
    main_ok = True
    if kind in OOXML_MAIN:
        main_ok = OOXML_MAIN[kind][0] in files
    elif kind in ("odt", "ods", "odp", "odg"):
        main_ok = "content.xml" in files
    return {"kind": kind, "intere": whole, "ricostruite": rebuilt, "perse": lost, "note": notes, "ok": main_ok,
            "totale": len(entries)}


def check(path: str) -> str | None:
    """Controllo veloce: None se lo ZIP sembra sano, altrimenti la chiave del motivo."""
    import os
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        head = f.read(4)
        f.seek(max(0, size - 66000))
        tail = f.read()
    if head != LOCAL and head != b"PK\x05\x06":
        return "srv_recover.motivo_zip_intestazione"
    if b"PK\x05\x06" not in tail:
        return "srv_recover.motivo_zip_senza_indice"
    try:
        with zipfile.ZipFile(path) as z:
            if size < 25 * 1024 * 1024 and z.testzip() is not None:
                return "srv_recover.motivo_zip_crc"
    except Exception:  # noqa: BLE001
        return "srv_recover.motivo_zip_indice_rotto"
    return None
