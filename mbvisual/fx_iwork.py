"""Apple iWork (Pages, Numbers, Keynote) senza Apple: anteprima incorporata, immagini, testo e tabelle.

Varianti gestite:
- iWork '09: zip con index.xml / index.apxl (anche .gz), QuickLook/Thumbnail.jpg e QuickLook/Preview.pdf
- iWork 2013 e successivi: zip con Index/*.iwa (protobuf compressi con Snappy), preview.jpg, Data/
- pacchetti ".key/.pages/.numbers" compressi (cartella con Index.zip dentro)
Decompressione Snappy e lettura protobuf scritte qui (formati pubblici). Nessuna libreria esterna.
"""
from __future__ import annotations

import gzip
import io
import os
import re
import struct
import zipfile
from xml.etree import ElementTree as ET

IMG_EXT = (".jpg", ".jpeg", ".png", ".gif", ".tif", ".tiff", ".bmp", ".heic", ".webp")


# ---------------------------------------------------------------- Snappy (formato "raw") e IWA
def snappy_decompress(buf: bytes) -> bytes:
    pos, n, shift = 0, 0, 0
    while True:  # lunghezza finale (varint)
        b = buf[pos]
        pos += 1
        n |= (b & 0x7F) << shift
        shift += 7
        if b < 0x80:
            break
    out = bytearray()
    L = len(buf)
    while pos < L:
        tag = buf[pos]
        pos += 1
        t = tag & 3
        if t == 0:
            ln = tag >> 2
            if ln >= 60:
                k = ln - 59
                ln = int.from_bytes(buf[pos:pos + k], "little")
                pos += k
            ln += 1
            out += buf[pos:pos + ln]
            pos += ln
            continue
        if t == 1:
            ln = 4 + ((tag >> 2) & 7)
            off = ((tag >> 5) << 8) | buf[pos]
            pos += 1
        elif t == 2:
            ln = (tag >> 2) + 1
            off = buf[pos] | (buf[pos + 1] << 8)
            pos += 2
        else:
            ln = (tag >> 2) + 1
            off = int.from_bytes(buf[pos:pos + 4], "little")
            pos += 4
        if off <= 0 or off > len(out):
            raise ValueError("Dati Snappy non validi")
        start = len(out) - off
        if off >= ln:
            out += out[start:start + ln]
        else:  # copia sovrapposta (ripetizione)
            for k in range(ln):
                out.append(out[start + k])
    return bytes(out)


def iwa_decompress(data: bytes) -> bytes:
    out, pos = bytearray(), 0
    while pos + 4 <= len(data):
        typ = data[pos]
        ln = int.from_bytes(data[pos + 1:pos + 4], "little")
        chunk = data[pos + 4:pos + 4 + ln]
        pos += 4 + ln
        out += snappy_decompress(chunk) if typ == 0 else chunk
    return bytes(out)


def varint(b: bytes, p: int):
    r, s = 0, 0
    while True:
        x = b[p]
        p += 1
        r |= (x & 0x7F) << s
        s += 7
        if x < 0x80:
            return r, p


def pb(b: bytes) -> dict:
    """Protobuf generico: {numero campo: [valori]} (varint=int, 64/32 bit=bytes, lunghezza=bytes)."""
    out: dict = {}
    p, L = 0, len(b)
    while p < L:
        key, p = varint(b, p)
        f, w = key >> 3, key & 7
        if w == 0:
            v, p = varint(b, p)
        elif w == 1:
            v, p = b[p:p + 8], p + 8
        elif w == 2:
            ln, p = varint(b, p)
            v, p = b[p:p + ln], p + ln
        elif w == 5:
            v, p = b[p:p + 4], p + 4
        else:
            raise ValueError("protobuf non valido")
        out.setdefault(f, []).append(v)
    return out


def iwa_objects(data: bytes) -> list:
    """Oggetti di un file .iwa: [(identificativo, tipo, payload)]."""
    raw = iwa_decompress(data)
    objs, p = [], 0
    while p < len(raw):
        ln, p = varint(raw, p)
        info = pb(raw[p:p + ln])
        p += ln
        ident = info.get(1, [0])[0]
        for mi in info.get(2, []):
            m = pb(mi)
            size = m.get(3, [0])[0]
            objs.append((ident, m.get(1, [0])[0], raw[p:p + size]))
            p += size
    return objs


def _s(v) -> str:
    try:
        return v.decode("utf-8")
    except Exception:
        return ""


# ---------------------------------------------------------------- apertura del pacchetto
class Pack:
    """Il documento come insieme di file: zip semplice o pacchetto con Index.zip annidato."""

    def __init__(self, path: str):
        self.z = zipfile.ZipFile(path)
        names = self.z.namelist()
        self.prefix = ""
        inner = [n for n in names if n.endswith("Index.zip")]
        self.index = None
        if inner and not any(n.startswith("Index/") for n in names):
            self.prefix = inner[0][: -len("Index.zip")]
            self.index = zipfile.ZipFile(io.BytesIO(self.z.read(inner[0])))
        self.names = [n[len(self.prefix):] for n in names if n.startswith(self.prefix) and not n.endswith("/")]
        if self.index:
            self.names += [n for n in self.index.namelist() if not n.endswith("/")]

    def read(self, name: str) -> bytes:
        if self.index and name in self.index.namelist():
            return self.index.read(name)
        return self.z.read(self.prefix + name)


def _app(path: str, names) -> str:
    ext = os.path.splitext(path)[1].lower()
    return {".pages": "Pages", ".numbers": "Numbers", ".key": "Keynote"}.get(ext) or (
        "Keynote" if any("Slide" in n for n in names) else "Numbers" if any("Tables/" in n for n in names) else "Pages")


# ---------------------------------------------------------------- iWork 2013+: testo e tabelle dagli oggetti IWA
STORAGE_KIND = {0: "Testo principale", 1: "Intestazione/pie' di pagina", 2: "Nota", 3: "Casella di testo", 4: "Note del relatore", 5: "Cella", 6: "Testo"}


def _clean(t: str) -> str:
    return t.replace("\ufffc", "").replace("\u2028", "\n").replace("\u2029", "\n").replace("\x04", "").strip()


def _natural(s: str):
    return [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", s)]


def _iwa_all(pk: Pack) -> dict:
    objs = {}
    for n in sorted(pk.names, key=_natural):
        if n.endswith(".iwa"):
            try:
                for ident, t, payload in iwa_objects(pk.read(n)):
                    objs[ident] = (t, payload, n)
            except Exception:
                continue
    return objs


def _ref(m: dict, f: int):
    v = m.get(f)
    if not v:
        return None
    try:
        return pb(v[0]).get(1, [None])[0]
    except Exception:
        return None


def _iwa_texts(objs: dict, app: str) -> list:
    out = []
    for ident, (t, payload, name) in objs.items():
        if t != 2001:  # TSWP.StorageArchive
            continue
        try:
            m = pb(payload)
        except Exception:
            continue
        txt = _clean("".join(_s(x) for x in m.get(3, [])))
        if not txt:
            continue
        kind = m.get(1, [None])[0]
        where = name.split("/")[-1].replace(".iwa", "")
        if "MasterSlide" in where or where in ("DocumentStylesheet", "ThemeStylesheet"):
            continue  # testi segnaposto dei modelli
        if kind == 5:
            continue  # testi delle celle: vanno nelle tabelle
        out.append({"tipo": STORAGE_KIND.get(kind, "Testo"), "parte": where, "testo": txt, "_ord": (0 if kind == 0 else 1, _natural(where), ident)})
    out.sort(key=lambda x: x.pop("_ord"))
    return out


def _datalist(objs, ident) -> dict:
    """Elenco condiviso di una tabella (testi, testi formattati): chiave -> valore."""
    o = objs.get(ident)
    if not o:
        return {}
    m = pb(o[1])
    out = {}
    for e in m.get(3, []):
        em = pb(e)
        key = em.get(1, [None])[0]
        if 3 in em:
            out[key] = _s(em[3][0])
        elif 9 in em:  # testo formattato: riferimento a un TSWP.StorageArchive
            r = pb(em[9][0]).get(1, [None])[0]
            so = objs.get(r)
            out[key] = _clean("".join(_s(x) for x in pb(so[1]).get(3, []))) if so else ""
        else:
            out[key] = None
    return out


def _d128(b: bytes):
    mant = int.from_bytes(b[:14], "little") + ((b[14] & 1) << 112)
    exp = (((b[15] & 0x7F) << 7) | (b[14] >> 1)) - 0x1820
    v = mant * (10.0 ** exp)
    return -v if b[15] & 0x80 else v


def _date(sec: float) -> str:
    import datetime as dt
    d = dt.datetime(2001, 1, 1) + dt.timedelta(seconds=sec)
    return d.strftime("%d/%m/%Y") if d.time() == dt.time(0) else d.strftime("%d/%m/%Y %H:%M")


def _cell(buf: bytes, strings: dict, rich: dict, new: bool):
    """Una cella di Numbers: byte 0 versione, byte 1 tipo, poi indicatori dei campi presenti."""
    if len(buf) < 12:
        return None
    t = buf[1]
    sidx = ridx = num = d128 = when = None
    if new:  # formato dal 2019 (versione 5)
        flags = struct.unpack_from("<I", buf, 8)[0]
        p = 12
        if flags & 1:
            d128 = _d128(buf[p:p + 16])
            p += 16
        if flags & 2:
            num = struct.unpack_from("<d", buf, p)[0]
            p += 8
        if flags & 4:
            when = struct.unpack_from("<d", buf, p)[0]
            p += 8
        if flags & 8:
            sidx = struct.unpack_from("<I", buf, p)[0]
            p += 4
        if flags & 16:
            ridx = struct.unpack_from("<I", buf, p)[0]
            p += 4
    else:  # formato 2013-2018 (versione 4)
        flags = struct.unpack_from("<I", buf, 4)[0]
        p = 12 + bin(flags & 0xD8E).count("1") * 4
        if flags & 0x200:
            ridx = struct.unpack_from("<I", buf, p)[0]
            p += 4
        p += bin(flags & 0x3000).count("1") * 4
        if flags & 0x10:
            sidx = struct.unpack_from("<I", buf, p)[0]
            p += 4
        if flags & 0x20:
            num = struct.unpack_from("<d", buf, p)[0]
            p += 8
        if flags & 0x40:
            when = struct.unpack_from("<d", buf, p)[0]
            p += 8
    if t == 0:
        return None
    if t == 2:
        return num if num is not None else d128
    if t == 10:
        return d128 if d128 is not None else num
    if t == 3:
        return strings.get(sidx, "")
    if t == 5:
        return _date(when) if when is not None else None
    if t == 6:
        return "VERO" if (num or 0) > 0 else "FALSO"
    if t == 7:
        return f"{num:g} s" if num is not None else None
    if t == 8:
        return "#ERRORE"
    if t == 9:
        return rich.get(ridx, "")
    return None


def _iwa_table(objs, model_id) -> dict | None:
    o = objs.get(model_id)
    if not o or o[0] != 6001:  # TST.TableModelArchive
        return None
    m = pb(o[1])
    name = _s(m.get(8, [b""])[0])
    nrows, ncols = m.get(6, [0])[0], m.get(7, [0])[0]
    ds = pb(m[4][0]) if 4 in m else {}
    strings = _datalist(objs, _ref(ds, 4)) if ds else {}
    rich = _datalist(objs, _ref(ds, 17)) if ds else {}
    grid = [[None] * ncols for _ in range(nrows)]
    tiles = pb(ds[3][0]).get(1, []) if 3 in ds else []
    for tdef in tiles:
        tm = pb(tdef)
        start = tm.get(1, [0])[0]
        to = objs.get(_ref(tm, 2))
        if not to:
            continue
        tile = pb(to[1])
        for ri in tile.get(5, []):
            r = pb(ri)
            row = r.get(1, [0])[0] + start * 256
            new = 6 in r
            buf = r.get(6 if new else 3, [b""])[0]
            offs = r.get(7 if new else 4, [b""])[0]
            wide = bool(r.get(8, [0])[0])
            if row >= nrows:
                continue
            for c in range(min(ncols, len(offs) // 2)):
                off = struct.unpack_from("<H", offs, c * 2)[0]
                if off == 0xFFFF:
                    continue
                if wide:
                    off *= 4
                try:
                    grid[row][c] = _cell(buf[off:], strings, rich, new)
                except Exception:
                    pass
    while grid and all(v is None for v in grid[-1]):
        grid.pop()
    width = max((max((i + 1 for i, v in enumerate(r) if v is not None), default=0) for r in grid), default=0)
    return {"nome": name or "Tabella", "righe": [r[:width] for r in grid], "intestazione": m.get(9, [0])[0]}


def _iwa_tables(objs) -> list:
    out, seen = [], set()
    for _sid, (t, p, n) in objs.items():
        if t != 2:  # TN.SheetArchive: nome del foglio e oggetti disegnati
            continue
        sm = pb(p)
        sname = _s(sm.get(1, [b""])[0])
        for ref in sm.get(2, []):
            io_ = objs.get(pb(ref).get(1, [None])[0])
            if not io_ or io_[0] != 6000:  # TST.TableInfoArchive
                continue
            mid = _ref(pb(io_[1]), 2)
            tb = _iwa_table(objs, mid)
            if tb:
                seen.add(mid)
                tb["foglio"] = sname
                out.append(tb)
    for i, (t, p, n) in objs.items():  # tabelle nelle pagine o nelle diapositive
        if t == 6001 and i not in seen:
            tb = _iwa_table(objs, i)
            if tb and tb["righe"]:
                tb["foglio"] = ""
                out.append(tb)
    return out


# ---------------------------------------------------------------- iWork '09: XML
def _xml(pk: Pack):
    for n in ("index.xml", "index.apxl", "index.xml.gz", "index.apxl.gz"):
        if n in pk.names:
            data = pk.read(n)
            if n.endswith(".gz") or data[:2] == b"\x1f\x8b":
                data = gzip.decompress(data)
            return ET.fromstring(data)
    return None


def _local(tag) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _attr(e, name):
    for k, v in e.attrib.items():
        if _local(k) == name:
            return v
    return None


SKIP = {"tabular-model", "datasource", "stylesheet", "styles", "anon-styles", "header", "footer"}


def _texts_of(e):
    if _local(e.tag) in SKIP:
        return
    if e.text:
        yield e.text
    for c in e:
        k = _local(c.tag)
        if k in ("br", "lnbr", "pgbr", "sectbr"):
            yield "\n"
        elif k == "tab":
            yield "\t"
        yield from _texts_of(c)
        if c.tail:
            yield c.tail


def _paras(e, acc):
    if _local(e.tag) in SKIP:
        return
    if _local(e.tag) == "p":
        t = "".join(_texts_of(e)).strip()
        if t:
            acc.append(t)
        return
    for c in e:
        _paras(c, acc)


def _xml_texts(root, app) -> list:
    out = []
    if app == "Keynote":
        for i, slide in enumerate(e for e in root.iter() if _local(e.tag) == "slide"):
            acc = []
            _paras(slide, acc)
            if acc:
                out.append({"tipo": "Diapositiva", "parte": f"Diapositiva {i + 1}", "testo": _clean("\n".join(acc))})
        return out
    body = next((e for e in root.iter() if _local(e.tag) == "body-storage"), None)
    acc = []
    _paras(body if body is not None else root, acc)
    if acc:
        out.append({"tipo": "Testo principale", "parte": "Documento", "testo": _clean("\n".join(acc))})
    return out


def _xml_tables(root) -> list:
    out = []
    for tm in (e for e in root.iter() if _local(e.tag) == "tabular-model"):
        grid = next((e for e in tm if _local(e.tag) == "grid"), None)
        if grid is None:
            continue
        ncols, nrows = int(_attr(grid, "numcols") or 0), int(_attr(grid, "numrows") or 0)
        ds = next((e for e in grid if _local(e.tag) == "datasource"), None)
        if ds is None or not ncols:
            continue
        cells = []
        for c in ds:
            k = _local(c.tag)
            rep = 1
            if k == "t":
                ct = next((x for x in c.iter() if _local(x.tag) == "ct"), None)
                v = _attr(ct, "s") if ct is not None else None
                if v is None:
                    v = "".join(c.itertext()).strip()
            elif k == "n":
                v = _attr(c, "v")
                try:
                    v = float(v)
                except (TypeError, ValueError):
                    pass
            elif k == "d":  # secondi dal 1/1/2001
                v = _attr(c, "cell-date")
                try:
                    v = _date(float(v))
                except (TypeError, ValueError):
                    pass
            elif k == "b":
                v = "VERO" if _attr(c, "v") in ("1", "true") else "FALSO"
            elif k == "du":
                v = _attr(c, "du")
            elif k == "pm":  # menu a comparsa: la voce scelta e' un riferimento a una delle celle del menu
                ref = next((_attr(x, "IDREF") for x in c if _local(x.tag) == "proxied-cell-ref"), None)
                ch = next((x for x in c.iter() if _attr(x, "ID") == ref), None) if ref else None
                ct = next((x for x in ch.iter() if _local(x.tag) == "ct"), None) if ch is not None else None
                v = _attr(ct, "s") if ct is not None else None
            elif k == "f":  # formula: risultato salvato (numero o testo)
                v = next((_attr(x, "v") for x in c.iter() if _local(x.tag) in ("rn", "n") and _attr(x, "v") is not None), None)
                if v is None:
                    v = next((_attr(x, "s") for x in c.iter() if _local(x.tag) == "ct" and _attr(x, "s") is not None), None)
                try:
                    v = float(v)
                except (TypeError, ValueError):
                    pass
            elif k in ("o", "s", "r"):
                v = "".join(c.itertext()).strip() or _attr(c, "v")
            else:  # g = cella vuota (ct = quante)
                v = None
                rep = max(1, int(_attr(c, "ct") or 1)) if k == "g" else 1
            cells.extend([v] * rep)
        rows = [cells[i:i + ncols] for i in range(0, min(len(cells), (nrows or 10 ** 9) * ncols), ncols)]
        while rows and all(v is None for v in rows[-1]):
            rows.pop()
        out.append({"nome": _attr(tm, "name") or "Tabella", "foglio": "", "righe": rows, "intestazione": 1})
    return out


# ---------------------------------------------------------------- API
def _previews(pk: Pack) -> dict:
    names = pk.names
    pdf = next((n for n in names if n.lower() in ("quicklook/preview.pdf", "preview.pdf")), None)
    img = next((n for n in ("preview.jpg", "QuickLook/Thumbnail.jpg", "QuickLook/Preview.jpg", "preview-web.jpg", "Thumbnail.jpg") if n in names), None)
    thumbs = sorted([n for n in names if n.lower().startswith("thumbs/") and n.lower().endswith(IMG_EXT)], key=_natural)
    media = [n for n in names if n.lower().startswith("data/") and n.lower().endswith(IMG_EXT) and "-small-" not in n.lower()
             and not os.path.basename(n).startswith(("mt-", "st-"))]
    return {"pdf": pdf, "immagine": img, "miniature": thumbs[:200], "immagini": media[:300]}


def read(path: str) -> dict:
    pk = Pack(path)
    app = _app(path, pk.names)
    res = {"ok": True, "programma": app, "parti": len(pk.names), **_previews(pk), "testi": [], "tabelle": [], "note": []}
    if any(n.endswith(".iwa") for n in pk.names):
        res["versione"] = "iWork 2013 o successivo"
        objs = _iwa_all(pk)
        if not objs and ".iwpv2" in " ".join(pk.names).lower():
            res["note"].append("Documento protetto da password: il contenuto e' cifrato, si vede solo l'anteprima.")
        res["testi"] = _iwa_texts(objs, app)
        try:
            res["tabelle"] = _iwa_tables(objs)
        except Exception as e:  # noqa: BLE001
            res["note"].append(f"Tabelle non leggibili: {e}")
    else:
        res["versione"] = "iWork '09"
        try:
            root = _xml(pk)
        except Exception as e:  # noqa: BLE001
            root = None
            res["note"].append(f"Contenuto XML non leggibile: {e}")
        if root is not None:
            res["testi"] = _xml_texts(root, app)
            res["tabelle"] = _xml_tables(root)
    res["tabelle"] = [t for t in res["tabelle"] if t["righe"]]
    for t in res["tabelle"]:
        t["righe"] = [[_jsonable(v) for v in r] for r in t["righe"][:20000]]
    if res["pdf"]:
        try:
            import pymupdf
            res["pagine_pdf"] = pymupdf.open(stream=pk.read(res["pdf"]), filetype="pdf").page_count
        except Exception:
            res["pagine_pdf"] = 0
    if not res["pdf"] and not res["immagine"] and not res["testi"] and not res["tabelle"]:
        res["note"].append("Il documento non contiene un'anteprima ne' testo leggibile.")
    return res


def _jsonable(v):
    if isinstance(v, float):
        if v != v or v in (float("inf"), float("-inf")):
            return None
        if v.is_integer() and abs(v) < 1e15:
            return int(v)
    return v


def part(path: str, name: str):
    pk = Pack(path)
    if name not in pk.names:
        raise ValueError("Parte non trovata nel documento")
    ext = os.path.splitext(name)[1].lower()
    ctype = {".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
             ".tif": "image/tiff", ".tiff": "image/tiff", ".bmp": "image/bmp", ".webp": "image/webp"}.get(ext, "application/octet-stream")
    return pk.read(name), {"Content-Type": ctype}


def page_png(path: str, n: int = 0):
    """Una pagina del PDF di anteprima come immagine PNG."""
    import pymupdf
    pk = Pack(path)
    pdf = _previews(pk)["pdf"]
    if not pdf:
        raise ValueError("Il documento non ha un PDF di anteprima")
    doc = pymupdf.open(stream=pk.read(pdf), filetype="pdf")
    page = doc[max(0, min(doc.page_count - 1, int(n)))]
    zoom = min(2.0, 1600 / max(page.rect.width, page.rect.height))
    return page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom)).tobytes("png"), {"Content-Type": "image/png"}


def export(path: str, out: str) -> dict:
    ext = out.rsplit(".", 1)[-1].lower()
    r = read(path)
    pk = Pack(path)
    if ext == "pdf":
        if r["pdf"]:
            data = pk.read(r["pdf"])
        elif r["immagine"]:
            import pymupdf
            data = pymupdf.open(stream=pk.read(r["immagine"]), filetype="jpg").convert_to_pdf()
        else:
            raise ValueError("Il documento non ha un'anteprima da esportare in PDF")
        with open(out, "wb") as f:
            f.write(data)
    elif ext in ("png", "jpg"):
        if r["immagine"]:
            src = pk.read(r["immagine"])
        elif r["pdf"]:
            import pymupdf
            src = pymupdf.open(stream=pk.read(r["pdf"]), filetype="pdf")[0].get_pixmap(dpi=150).tobytes("png")
        else:
            raise ValueError("Il documento non ha un'anteprima")
        from PIL import Image
        im = Image.open(io.BytesIO(src))
        (im.convert("RGB") if ext == "jpg" else im).save(out, "JPEG" if ext == "jpg" else "PNG")
    elif ext == "txt":
        txt = "\n\n".join((f"[{t['parte']}]\n" if len(r["testi"]) > 1 else "") + t["testo"] for t in r["testi"])
        for tb in r["tabelle"]:
            txt += f"\n\n[{tb['nome']}]\n" + "\n".join("\t".join("" if v is None else str(v) for v in row) for row in tb["righe"])
        with open(out, "w", encoding="utf-8") as f:
            f.write(txt.strip() + "\n")
    elif ext in ("csv", "xlsx"):
        if not r["tabelle"]:
            raise ValueError("Il documento non contiene tabelle")
        from .formati import rows_xlsx, write_csv
        if ext == "xlsx":
            rows_xlsx([{"nome": (tb["foglio"] + " - " if tb["foglio"] else "") + tb["nome"], "colonne": [], "righe": tb["righe"]} for tb in r["tabelle"]], out)
        else:
            rows = []
            for i, tb in enumerate(r["tabelle"]):
                if len(r["tabelle"]) > 1:
                    rows += ([[]] if i else []) + [[(tb["foglio"] + " - " if tb["foglio"] else "") + tb["nome"]]]
                rows += tb["righe"]
            write_csv(out, [], rows)
    else:
        raise ValueError(f"Formato non previsto: .{ext}")
    return {"ok": True, "path": out}
