"""Diagrammi di Microsoft Visio (editor in ui/js/vsdedit.js).

- metafile_png: le immagini EMF/WMF dentro i .vsdx (il browser non le sa disegnare) diventano PNG con Pillow
  (disegno di Windows, GDI).
- open_vsd: vecchi file binari .vsd / .vss / .vst (Visio 2003-2010).
  * con Visio installato: conversione in .vsdx tramite COM (poi si apre e si modifica come gli altri);
  * con LibreOffice installato: pagine convertite in PDF e mostrate come immagini (sola lettura);
  * altrimenti: anteprima salvata nel file (SummaryInformation) e testi delle pagine. Il formato binario non e'
    documentato pubblicamente: i flussi sono compressi con una variante di LZSS (finestra 4096, riferimenti di
    3-18 byte) e organizzati in puntatori; i testi stanno nei blocchi di tipo 0x0E (UTF-16 dalla versione 11).
- export_pdf: il PDF usa lo stesso formato di operazioni delle pubblicazioni (mbvisual/publisher.py).
"""
import io
import os
import re
import struct
import uuid
from pathlib import Path

from .i18n import t as tr
from .paths import TEMP_DIR, find_libreoffice

OUT = TEMP_DIR / "visio"


# ------------------------------------------------------------------ immagini EMF / WMF
def metafile_png(data: bytes, target: int = 2000) -> bytes:
    from PIL import Image
    im = Image.open(io.BytesIO(data))
    w, h = im.size
    # risoluzione piu' alta per le immagini piccole (fino a ~2000 px sul lato lungo)
    try:
        dpi = im.info.get("dpi") or 96
        dpi = float(dpi[0] if isinstance(dpi, (tuple, list)) else dpi)
        k = max(1.0, min(25.0, target / max(1, w, h)))
        if k > 1.05:
            im.load(dpi=int(round(dpi * k)))
        else:
            im.load()
    except Exception:  # noqa: BLE001
        im = Image.open(io.BytesIO(data))
        im.load()
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGBA")
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=False)
    return buf.getvalue()


def export_pdf(body: bytes, out: str) -> dict:
    from . import publisher
    r = publisher.export_pdf(body, out)
    return r


# ------------------------------------------------------------------ .vsd binari
def _lzss(data: bytes) -> bytes:
    buf = bytearray(4096)
    out = bytearray()
    pos = 0
    i, n = 0, len(data)
    while i < n:
        flags = data[i]
        i += 1
        for bit in range(8):
            if i >= n:
                break
            if flags & (1 << bit):
                c = data[i]
                i += 1
                buf[pos & 4095] = c
                pos += 1
                out.append(c)
            else:
                if i + 1 >= n:
                    i = n
                    break
                a1, a2 = data[i], data[i + 1]
                i += 2
                p = ((a1 | ((a2 & 0xF0) << 4)) + 18) & 4095
                for k in range((a2 & 0x0F) + 3):
                    c = buf[(p + k) & 4095]
                    buf[pos & 4095] = c
                    pos += 1
                    out.append(c)
    return bytes(out)


def _ptr(b: bytes, o: int):
    t, _, off, ln, fmt = struct.unpack_from("<IIIIH", b, o)
    return t, off, ln, fmt


class _Vsd:
    def __init__(self, data: bytes):
        self.d = data
        self.ver = data[0x1A] if len(data) > 0x1A else 0

    def stream(self, p):
        _t, off, ln, fmt = p
        raw = self.d[off:off + ln]
        return (_lzss(raw) if fmt & 2 else raw), (4 if fmt & 2 else 0)

    def pointers(self, data: bytes, shift: int):
        try:
            off0 = struct.unpack_from("<I", data, shift)[0]
            p = off0 + shift - 4
            _lsz, cnt = struct.unpack_from("<II", data, p)
            p += 12
            if cnt > 5000:
                return []
            return [_ptr(data, p + 18 * k) for k in range(cnt) if p + 18 * k + 18 <= len(data)]
        except struct.error:
            return []

    def texts(self, data: bytes):
        out = []
        i, n = 0, len(data)
        while i + 27 < n:
            if data[i] == 0x0E and data[i + 1:i + 4] == b"\0\0\0":
                ln = struct.unpack_from("<I", data, i + 12)[0]
                lev = struct.unpack_from("<H", data, i + 16)[0]
                if 8 < ln < n - i and lev in (2, 3):
                    raw = data[i + 27:i + 19 + ln]
                    try:
                        s = (raw.decode("utf-16le") if self.ver >= 11 else raw.decode("cp1252")).rstrip("\0")
                    except UnicodeDecodeError:
                        s = ""
                    if s.strip() and all(c.isprintable() or c in "\n\r\t ￼" for c in s):
                        out.append(s.replace("￼", "").replace(" ", "\n").replace("\r", "").strip("\n"))
                        i += 19 + ln
                        continue
            i += 1
        return out

    def pages(self):
        if self.ver < 11:
            return []
        t, off, ln, fmt = _ptr(self.d, 0x24)
        trailer = _lzss(self.d[off:off + ln]) if fmt & 2 else self.d[off:off + ln]
        pages = []
        for p in self.pointers(trailer, 4 if fmt & 2 else 0):
            if p[0] != 0x27 or not p[0]:
                continue
            data, sh = self.stream(p)
            for q in self.pointers(data, sh):
                if q[0] == 0x15 and q[1] + q[2] <= len(self.d):
                    pd, _ = self.stream(q)
                    pages.append({"name": tr("srv_visio.pagina_n", len(pages) + 1), "texts": [s for s in self.texts(pd) if s]})
        return pages


def _thumbnail(path: str):
    """Anteprima salvata nel file (proprieta' PIDSI_THUMBNAIL: formato degli appunti + metafile o bitmap)."""
    import olefile
    with olefile.OleFileIO(path) as o:
        th = o.get_metadata().thumbnail
    if not th or len(th) < 12:
        return None
    cf = struct.unpack_from("<i", th, 0)[0]
    fmt = struct.unpack_from("<I", th, 4)[0]
    data = th[8:]
    if cf == -1 and fmt == 3:  # CF_METAFILEPICT: 8 byte di intestazione, poi WMF senza intestazione "placeable"
        data = th[16:]
        hdr = struct.pack("<IHhhhhHIH", 0x9AC6CDD7, 0, 0, 0, 1000, 1000, 1440, 0, 0)
        cs = 0
        for k in range(0, 20, 2):
            cs ^= struct.unpack_from("<H", hdr, k)[0]
        data = hdr[:20] + struct.pack("<H", cs) + data
    elif cf == -1 and fmt == 8:  # CF_DIB
        from PIL import Image
        bmp = b"BM" + struct.pack("<IHHI", 14 + len(data), 0, 0, 14 + struct.unpack_from("<I", data, 0)[0] + (struct.unpack_from("<I", data, 32)[0] or 0) * 4)
        im = Image.open(io.BytesIO(bmp + data))
        buf = io.BytesIO()
        im.save(buf, "PNG")
        return buf.getvalue()
    try:
        return metafile_png(data, 700)
    except Exception:  # noqa: BLE001
        return None


def _com_to_vsdx(path: str, out: str) -> bool:
    try:
        import pythoncom
        import win32com.client
    except ImportError:
        return False
    try:
        pythoncom.CoInitialize()
        app = win32com.client.DispatchEx("Visio.InvisibleApp")
    except Exception:  # noqa: BLE001
        return False
    doc = None
    try:
        try:
            app.AlertResponse = 7  # risposta "No" a ogni domanda
        except Exception:  # noqa: BLE001
            pass
        doc = app.Documents.OpenEx(str(Path(path).resolve()), 0x2 | 0x8)  # copia, senza aggiornamenti di area di lavoro
        doc.SaveAs(out)
        return Path(out).exists()
    except Exception:  # noqa: BLE001
        return False
    finally:
        try:
            if doc is not None:
                doc.Close()
        except Exception:  # noqa: BLE001
            pass
        try:
            app.Quit()
        except Exception:  # noqa: BLE001
            pass


def open_vsd(path: str, update=None) -> dict:
    d = OUT / uuid.uuid4().hex[:10]
    d.mkdir(parents=True, exist_ok=True)
    if update:
        update(message=tr("srv_visio.lettura_file"), progress=0.05)
    # 1) Visio installato: conversione completa in .vsdx
    target = str(d / (Path(path).stem + ".vsdx"))
    if _com_to_vsdx(path, target):
        return {"mode": "vsdx", "path": target}
    res = {"mode": "preview", "pages": [], "images": [], "version": 0}
    # 2) LibreOffice: pagine in PDF -> immagini
    if find_libreoffice():
        if update:
            update(message=tr("srv_visio.conversione_libreoffice"), progress=0.2)
        try:
            from . import office
            import pymupdf
            pdf = office.lo_convert(path, "pdf")["path"]
            with pymupdf.open(pdf) as doc:
                for i, pg in enumerate(doc):
                    f = d / f"pagina{i + 1}.png"
                    pg.get_pixmap(dpi=144).save(str(f))
                    res["images"].append(str(f))
                    res["pages"].append({"name": tr("srv_visio.pagina_n", i + 1), "texts": [t for t in pg.get_text().split("\n") if t.strip()]})
            res["mode"] = "libreoffice"
        except Exception as e:  # noqa: BLE001
            res["nota"] = tr("srv_visio.libreoffice_non_riuscito", e)
    # 3) lettore interno: anteprima e testi
    try:
        import olefile
        with olefile.OleFileIO(path) as o:
            data = o.openstream("VisioDocument").read()
        v = _Vsd(data)
        res["version"] = v.ver
        if res["mode"] == "preview":
            res["pages"] = v.pages()
    except Exception as e:  # noqa: BLE001
        res.setdefault("nota", tr("srv_visio.struttura_non_leggibile", e))
    if res["mode"] == "preview":
        try:
            png = _thumbnail(path)
            if png:
                f = d / "anteprima.png"
                f.write_bytes(png)
                res["preview"] = str(f)
        except Exception:  # noqa: BLE001
            pass
    return res
