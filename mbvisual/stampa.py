"""Stampa professionale per ufficio tecnico (finestra Stampa, Ctrl+P, e Stampa a lotti).

Percorso unico per ogni file: sorgente -> PDF -> "PDF di stampa" (una pagina per foglio, gia' alla dimensione della
carta, contenuto vettoriale posato con show_pdf_page) -> anteprima (le stesse pagine e lo stesso stile della stampa)
-> stampante di Windows oppure PDF vettoriale.

- Sorgenti: PDF cosi' come sono; disegni CAD (DXF; i DWG arrivano gia' convertiti in DXF dall'interfaccia, che li legge
  con libredwg come il visualizzatore) disegnati da ezdxf direttamente sul foglio, in scala esatta (1:50, 1:100...) o
  adattati, con estensioni / limiti / vista / finestra / layout e stili di stampa (colori, grigi, nero, tabelle .ctb);
  tutto il resto passa da convert.py (Office via COM, immagini, testo, email, HTML...).
- Stampanti: elenco, formati, risoluzioni e margini fisici con pywin32 (win32print); stampa con GDI via ctypes:
  DEVMODE preparato con DocumentPropertiesW (formato, orientamento, copie, colore, formati personalizzati / rotoli),
  CreateDCW, ResetDCW quando cambia il formato tra una pagina e l'altra (stampa a lotti), pagine rasterizzate da
  PyMuPDF alla risoluzione della stampante e inviate a bande con StretchDIBits (mai una pagina A0 intera in memoria).
- "PDF vettoriale (MB Visual)": stampante virtuale che salva il PDF di stampa (vettoriale, dimensioni esatte).
"""
from __future__ import annotations

import base64
import ctypes
import hashlib
import io
import os
import re
import shutil
import tempfile
import threading
import uuid
from ctypes import wintypes
from pathlib import Path

from .paths import TEMP_DIR
from .i18n import t

PDF_VIRTUAL = "__pdf__"
MM = 72 / 25.4          # punti per millimetro
WORK = TEMP_DIR / "stampa"

# formati ISO e rotoli per la stampante virtuale (e come riferimento per la scelta automatica)
ISO = [("A0", 841, 1189), ("A1", 594, 841), ("A2", 420, 594), ("A3", 297, 420), ("A4", 210, 297), ("A5", 148, 210)]
ISO_EXTRA = [("2A0", 1189, 1682), ("A0+ (914 x 1292)", 914, 1292), ("B1", 707, 1000), ("B2", 500, 707), ("B3", 353, 500), ("Lettera", 216, 279), ("Tabloid", 279, 432)]
ROLLS = [1067, 914, 841, 610, 594, 432, 420, 297]
UNITS_MM = {0: 1.0, 1: 25.4, 2: 304.8, 3: 1609344.0, 4: 1.0, 5: 10.0, 6: 1000.0, 7: 1e6, 8: 2.54e-5, 9: 0.0254, 10: 914.4,
            11: 1e-7, 12: 1e-6, 13: 1e-3, 14: 100.0, 15: 1e4, 16: 1e5, 17: 1e12, 18: 1.495978707e14, 19: 9.4607304725808e18, 20: 3.08567758149137e19,
            "mm": 1.0, "cm": 10.0, "m": 1000.0, "in": 25.4, "ft": 304.8, "dm": 100.0}
PLOTTER_HINTS = re.compile(r"plot|designjet|imageprograf|ipf|surecolor|kip|oc[eé]|plotwave|colorwave|teriostar|mutoh|roland|graphtec|tm-\d|t\d{3,4}", re.I)

_LOCK = threading.Lock()
_SOURCES: dict[str, dict] = {}   # sid -> sorgenti preparate
_JOBS: dict[str, dict] = {}      # cid -> PDF di stampa composto


# ================================================================ stampanti (pywin32)
def printers() -> dict:
    import win32print
    names, seen = [], set()
    flags = win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
    for p in win32print.EnumPrinters(flags, None, 4):
        n = p["pPrinterName"]
        if n not in seen:
            seen.add(n)
            names.append(n)
    try:
        default = win32print.GetDefaultPrinter()
    except Exception:  # noqa: BLE001
        default = names[0] if names else ""
    lst = [{"name": PDF_VIRTUAL, "label": t("srv_stampa.pdf_vettoriale_mb_visual"), "virtual": True}]
    from .cadedit import find_oda
    for n in sorted(names, key=str.lower):
        lst.append({"name": n, "label": n, "default": n == default, "plotter": bool(PLOTTER_HINTS.search(n))})
    return {"ok": True, "printers": lst, "default": default, "oda": bool(find_oda())}


def printer_info(name: str) -> dict:
    """Formati carta (mm), risoluzioni, colore, copie, formati personalizzati e impostazioni predefinite del driver."""
    if name == PDF_VIRTUAL:
        forms = [{"id": 0, "name": n, "w": w, "h": h, "std": True} for n, w, h in ISO + ISO_EXTRA]
        return {"ok": True, "name": name, "virtual": True, "forms": forms, "color": True, "dpi": [300, 600],
                "copies": 1, "custom": {"min": [10, 10], "max": [5000, 50000]}, "rolls": ROLLS, "plotter": True,
                "default": {"paper": "A4", "orientation": "portrait", "color": True}}
    import win32con
    import win32print
    dc = win32print.DeviceCapabilities
    names = dc(name, "", win32con.DC_PAPERNAMES) or []
    ids = dc(name, "", win32con.DC_PAPERS) or []
    sizes = dc(name, "", win32con.DC_PAPERSIZE) or []
    forms = []
    for n, i, s in zip(names, ids, sizes):
        w, h = s["x"] / 10, s["y"] / 10
        if w > 0 and h > 0:
            forms.append({"id": int(i), "name": n.strip(), "w": round(w, 1), "h": round(h, 1)})
    res = sorted({int(r["xdpi"]) for r in (dc(name, "", win32con.DC_ENUMRESOLUTIONS) or []) if r.get("xdpi", 0) > 0})
    try:
        mn, mx = dc(name, "", win32con.DC_MINEXTENT), dc(name, "", win32con.DC_MAXEXTENT)
        custom = {"min": [mn["Width"] / 10, mn["Length"] / 10], "max": [mx["Width"] / 10, mx["Length"] / 10]} if mx and mx["Width"] > 0 else None
    except Exception:  # noqa: BLE001
        custom = None
    big = max([max(f["w"], f["h"]) for f in forms] + [0])
    plotter = bool(PLOTTER_HINTS.search(name)) or (((custom and custom["max"][0] >= 600) or big >= 841) and not re.search(r"pdf|xps|onenote|fax", name, re.I))
    for f in forms:
        f["std"] = _drawing_form(f)
    dm = _DevMode(name)
    d = dm.struct()
    cur = next((f for f in forms if f["id"] == d.dmPaperSize), None)
    return {"ok": True, "name": name, "forms": forms, "dpi": res or [600], "color": bool(dc(name, "", win32con.DC_COLORDEVICE)),
            "copies": int(dc(name, "", win32con.DC_COPIES) or 1), "custom": custom, "plotter": bool(plotter),
            "rolls": [r for r in ROLLS if custom and r <= custom["max"][0] + 0.5] if plotter else [],
            "default": {"paper": cur["name"] if cur else (forms[0]["name"] if forms else "A4"),
                        "orientation": "landscape" if d.dmOrientation == 2 else "portrait", "color": d.dmColor != 1}}


# ---------------------------------------------------------------- DEVMODE e GDI (ctypes)
class DEVMODEW(ctypes.Structure):
    _fields_ = [("dmDeviceName", ctypes.c_wchar * 32), ("dmSpecVersion", wintypes.WORD), ("dmDriverVersion", wintypes.WORD),
                ("dmSize", wintypes.WORD), ("dmDriverExtra", wintypes.WORD), ("dmFields", wintypes.DWORD),
                ("dmOrientation", ctypes.c_short), ("dmPaperSize", ctypes.c_short), ("dmPaperLength", ctypes.c_short),
                ("dmPaperWidth", ctypes.c_short), ("dmScale", ctypes.c_short), ("dmCopies", ctypes.c_short),
                ("dmDefaultSource", ctypes.c_short), ("dmPrintQuality", ctypes.c_short), ("dmColor", ctypes.c_short),
                ("dmDuplex", ctypes.c_short), ("dmYResolution", ctypes.c_short), ("dmTTOption", ctypes.c_short),
                ("dmCollate", ctypes.c_short), ("dmFormName", ctypes.c_wchar * 32), ("dmLogPixels", wintypes.WORD),
                ("dmBitsPerPel", wintypes.DWORD), ("dmPelsWidth", wintypes.DWORD), ("dmPelsHeight", wintypes.DWORD),
                ("dmDisplayFlags", wintypes.DWORD), ("dmDisplayFrequency", wintypes.DWORD), ("dmICMMethod", wintypes.DWORD),
                ("dmICMIntent", wintypes.DWORD), ("dmMediaType", wintypes.DWORD), ("dmDitherType", wintypes.DWORD),
                ("dmReserved1", wintypes.DWORD), ("dmReserved2", wintypes.DWORD), ("dmPanningWidth", wintypes.DWORD),
                ("dmPanningHeight", wintypes.DWORD)]


class DOCINFOW(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_int), ("lpszDocName", wintypes.LPCWSTR), ("lpszOutput", wintypes.LPCWSTR),
                ("lpszDatatype", wintypes.LPCWSTR), ("fwType", wintypes.DWORD)]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", ctypes.c_long), ("biHeight", ctypes.c_long), ("biPlanes", wintypes.WORD),
                ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD), ("biSizeImage", wintypes.DWORD),
                ("biXPelsPerMeter", ctypes.c_long), ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", wintypes.DWORD),
                ("biClrImportant", wintypes.DWORD)]


class BITMAPINFO256(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 256)]


DM_ORIENTATION, DM_PAPERSIZE, DM_PAPERLENGTH, DM_PAPERWIDTH = 0x1, 0x2, 0x4, 0x8
DM_COPIES, DM_COLOR, DM_COLLATE, DM_FORMNAME = 0x100, 0x800, 0x8000, 0x10000
DM_OUT_BUFFER, DM_IN_PROMPT, DM_IN_BUFFER = 2, 4, 8
DMPAPER_USER = 256
HORZRES, VERTRES, LOGPIXELSX, LOGPIXELSY = 8, 10, 88, 90
PHYSICALWIDTH, PHYSICALHEIGHT, PHYSICALOFFSETX, PHYSICALOFFSETY = 110, 111, 112, 113

_winspool = ctypes.WinDLL("winspool.drv", use_last_error=True)
_gdi = ctypes.WinDLL("gdi32", use_last_error=True)
_user = ctypes.WinDLL("user32")
_winspool.OpenPrinterW.argtypes = [wintypes.LPWSTR, ctypes.POINTER(wintypes.HANDLE), ctypes.c_void_p]
_winspool.ClosePrinter.argtypes = [wintypes.HANDLE]
_winspool.DocumentPropertiesW.argtypes = [wintypes.HWND, wintypes.HANDLE, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD]
_winspool.DocumentPropertiesW.restype = ctypes.c_long
_gdi.CreateDCW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_void_p]
_gdi.CreateDCW.restype = wintypes.HDC
_gdi.CreateICW.argtypes = _gdi.CreateDCW.argtypes
_gdi.CreateICW.restype = wintypes.HDC
_gdi.ResetDCW.argtypes = [wintypes.HDC, ctypes.c_void_p]
_gdi.ResetDCW.restype = wintypes.HDC
_gdi.DeleteDC.argtypes = [wintypes.HDC]
_gdi.GetDeviceCaps.argtypes = [wintypes.HDC, ctypes.c_int]
_gdi.StartDocW.argtypes = [wintypes.HDC, ctypes.POINTER(DOCINFOW)]
_gdi.StartPage.argtypes = [wintypes.HDC]
_gdi.EndPage.argtypes = [wintypes.HDC]
_gdi.EndDoc.argtypes = [wintypes.HDC]
_gdi.AbortDoc.argtypes = [wintypes.HDC]
_gdi.SetStretchBltMode.argtypes = [wintypes.HDC, ctypes.c_int]
_gdi.StretchDIBits.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                               ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT, wintypes.DWORD]


class _DevMode:
    """DEVMODE del driver (preferenze di stampa dell'utente, oppure quello scelto con Proprieta')."""

    def __init__(self, name: str, base64_dm: str | None = None):
        self.name = name
        h = wintypes.HANDLE()
        if not _winspool.OpenPrinterW(name, ctypes.byref(h), None):
            raise RuntimeError(t("srv_stampa.stampante_non_disponibile_0", name))
        try:
            size = _winspool.DocumentPropertiesW(None, h, name, None, None, 0)
            if size <= 0:
                raise RuntimeError(t("srv_stampa.driver_stampante_non_risponde_0", name))
            self.buf = ctypes.create_string_buffer(size + 1024)
            src = None
            if base64_dm:
                raw = base64.b64decode(base64_dm)
                src = ctypes.create_string_buffer(raw, max(len(raw), size + 1024))
            r = _winspool.DocumentPropertiesW(None, h, name, self.buf, src, DM_OUT_BUFFER | (DM_IN_BUFFER if src else 0))
            if r < 0:
                raise RuntimeError(t("srv_stampa.impostazioni_driver_non_leggibili"))
        finally:
            _winspool.ClosePrinter(h)

    def struct(self) -> DEVMODEW:
        return DEVMODEW.from_buffer(self.buf)

    def raw(self) -> bytes:
        d = self.struct()
        return self.buf.raw[: d.dmSize + d.dmDriverExtra]

    def set(self, paper: dict, landscape: bool, copies: int = 1, color: bool | None = None, collate: bool = True):
        d = self.struct()
        if paper.get("id"):
            d.dmPaperSize = int(paper["id"])
            d.dmFields = (d.dmFields | DM_PAPERSIZE) & ~(DM_PAPERLENGTH | DM_PAPERWIDTH | DM_FORMNAME)
        else:  # formato personalizzato / rotolo: lato corto x lato lungo in decimi di mm
            a, b = sorted((paper["w"], paper["h"]))
            d.dmPaperSize = DMPAPER_USER
            d.dmPaperWidth = int(round(a * 10))
            d.dmPaperLength = int(round(min(b * 10, 32767)))
            d.dmFields = (d.dmFields | DM_PAPERSIZE | DM_PAPERLENGTH | DM_PAPERWIDTH) & ~DM_FORMNAME
        d.dmOrientation = 2 if landscape else 1
        d.dmFields |= DM_ORIENTATION
        d.dmCopies = max(1, int(copies))
        d.dmCollate = 1 if collate else 0
        d.dmFields |= DM_COPIES | DM_COLLATE
        if color is not None:
            d.dmColor = 2 if color else 1
            d.dmFields |= DM_COLOR
        # il driver convalida e completa la sua parte privata
        h = wintypes.HANDLE()
        if _winspool.OpenPrinterW(self.name, ctypes.byref(h), None):
            try:
                tmp = ctypes.create_string_buffer(self.buf.raw, len(self.buf))
                _winspool.DocumentPropertiesW(None, h, self.name, self.buf, tmp, DM_IN_BUFFER | DM_OUT_BUFFER)
            finally:
                _winspool.ClosePrinter(h)


def printer_dialog(name: str, base64_dm: str | None = None) -> dict:
    """Finestra "Proprieta'" del driver (qualita', rotolo, taglierina...): restituisce il DEVMODE scelto."""
    if name == PDF_VIRTUAL:
        return {"ok": True, "devmode": None}
    dm = _DevMode(name, base64_dm)
    h = wintypes.HANDLE()
    _winspool.OpenPrinterW(name, ctypes.byref(h), None)
    try:
        src = ctypes.create_string_buffer(dm.buf.raw, len(dm.buf))
        r = _winspool.DocumentPropertiesW(_user.GetForegroundWindow(), h, name, dm.buf, src, DM_IN_BUFFER | DM_OUT_BUFFER | DM_IN_PROMPT)
    finally:
        _winspool.ClosePrinter(h)
    if r != 1:  # IDOK
        return {"ok": True, "devmode": base64_dm, "annullato": True}
    return {"ok": True, "devmode": base64.b64encode(dm.raw()).decode()}


def _caps(hdc) -> dict:
    g = lambda i: _gdi.GetDeviceCaps(hdc, i)  # noqa: E731
    return {"dpix": g(LOGPIXELSX), "dpiy": g(LOGPIXELSY), "w": g(PHYSICALWIDTH), "h": g(PHYSICALHEIGHT),
            "offx": g(PHYSICALOFFSETX), "offy": g(PHYSICALOFFSETY), "hres": g(HORZRES), "vres": g(VERTRES)}


_MARGIN_CACHE: dict = {}


def hardware_margins(name: str, paper: dict, landscape: bool, base64_dm: str | None = None) -> list[float]:
    """Margini non stampabili (mm: sinistra, alto, destra, basso) per quel formato, letti dal driver."""
    if name == PDF_VIRTUAL:
        return [0, 0, 0, 0]
    key = (name, paper.get("id"), paper.get("w"), paper.get("h"), landscape, base64_dm)
    if key in _MARGIN_CACHE:
        return _MARGIN_CACHE[key]
    m = [5.0, 5.0, 5.0, 5.0]
    try:
        dm = _DevMode(name, base64_dm)
        dm.set(paper, landscape)
        hdc = _gdi.CreateICW("WINSPOOL", name, None, dm.buf)
        if hdc:
            c = _caps(hdc)
            _gdi.DeleteDC(hdc)
            kx, ky = 25.4 / c["dpix"], 25.4 / c["dpiy"]
            m = [round(c["offx"] * kx, 2), round(c["offy"] * ky, 2), round((c["w"] - c["offx"] - c["hres"]) * kx, 2), round((c["h"] - c["offy"] - c["vres"]) * ky, 2)]
    except Exception:  # noqa: BLE001
        pass
    _MARGIN_CACHE[key] = m
    return m


# ================================================================ sorgenti
def _cache_key(path: str) -> str:
    st = os.stat(path)
    return hashlib.sha1(f"{os.path.abspath(path)}|{st.st_size}|{st.st_mtime}".encode()).hexdigest()[:16]


def _to_pdf(path: str, update=None) -> str:
    """Qualsiasi file stampabile -> PDF (in cache finche' il file non cambia)."""
    from . import convert
    ext = Path(path).suffix.lower().lstrip(".")
    if ext == "pdf":
        return path
    out = WORK / "pdf" / (_cache_key(path) + ".pdf")
    if out.is_file() and out.stat().st_size > 0:
        return str(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if ext in ("p7m", "p7s", "tsd", "m7m"):
        from . import signed
        r = signed.open_signed(path)
        if not r.get("contenuto"):
            raise ValueError(t("srv_stampa.documento_firmato_non_contiene_file"))
        return _to_pdf(r["contenuto"], update)
    if ext in ("png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp"):
        _image_pdf(path, str(out))
        return str(out)
    fam = convert.FAMILY_OF.get(ext)
    if fam in (None, "media", "audio", "archive", "font", "database"):
        raise ValueError(t("srv_stampa.i_file_0_non_si", ext))
    tmp = out.with_suffix(".tmp.pdf")
    convert.convert(path, str(tmp), update=update)
    os.replace(tmp, out)
    return str(out)


def _image_pdf(path: str, out: str):
    """Immagine -> PDF alla sua dimensione reale (dpi del file, 96 se mancano)."""
    import pymupdf
    from PIL import Image
    with Image.open(path) as im:
        dpi = im.info.get("dpi") or (96, 96)
        w, h = im.size
        dx, dy = (float(dpi[0]) or 96), (float(dpi[1]) or 96)
        if im.mode not in ("RGB", "L", "RGBA"):
            im = im.convert("RGBA" if "A" in im.mode else "RGB")
        bio = io.BytesIO()
        im.save(bio, "PNG")
    doc = pymupdf.open()
    pg = doc.new_page(width=w / dx * 72, height=h / dy * 72)
    pg.insert_image(pg.rect, stream=bio.getvalue())
    doc.save(out, deflate=True)


def prepare(sources: list[dict], update=None) -> dict:
    """sources: [{path, kind?: 'pdf'|'cad'|'file', dxf?: DXF temporaneo per i DWG/disegni modificati, name?, view?, limits?}].
    Converte cio' che serve e restituisce le informazioni per la finestra (pagine e dimensioni, layout dei disegni...)."""
    import pymupdf
    update = update or (lambda **k: None)
    out = []
    n = max(1, len(sources))
    for i, s in enumerate(sources):
        path = s.get("path") or ""
        name = s.get("name") or Path(path).name
        update(progress=i / n, message=t("srv_stampa.preparazione_0", name))
        item = {"path": path, "name": name}
        try:
            ext = Path(path).suffix.lower().lstrip(".")
            if ext == "dwg" and not s.get("dxf") and s.get("kind") != "pdf":
                oda = _dwg_with_oda(path)
                if not oda:
                    raise ValueError(t("srv_stampa.stampare_i_dwg_qui_serve"))
                item.update(_cad_info(oda))
                item.update({"kind": "cad", "dxf": oda})
            elif s.get("kind") == "cad" or (s.get("dxf") or ext == "dxf") and s.get("kind") != "pdf":
                item.update(_cad_info(s.get("dxf") or path))
                item.update({"kind": "cad", "dxf": s.get("dxf") or path, "view": s.get("view"), "limits_ui": s.get("limits")})
            else:
                pdf = s.get("pdf") or _to_pdf(path, update=lambda **k: None)
                with pymupdf.open(pdf) as d:
                    if d.needs_pass:
                        raise ValueError(t("srv_stampa.pdf_protetto_password_sbloccalo_prima"))
                    sizes = [[round(p.rect.width / MM, 1), round(p.rect.height / MM, 1)] for p in d]
                item.update({"kind": "pdf", "pdf": pdf, "pages": len(sizes), "sizes": sizes})
        except Exception as e:  # noqa: BLE001
            item.update({"kind": "error", "errore": str(e) or e.__class__.__name__})
        out.append(item)
    sid = uuid.uuid4().hex[:12]
    with _LOCK:
        _SOURCES[sid] = {"items": out}
    update(progress=1, message=t("srv_stampa.pronto"))
    return {"ok": True, "sid": sid, "items": [{k: v for k, v in it.items() if k not in ("pdf",)} for it in out]}


def _dwg_with_oda(path: str) -> str | None:
    """Con ODA File Converter installato i DWG si convertono qui (layout compresi)."""
    from .cadedit import find_oda
    exe = find_oda()
    if not exe:
        return None
    import subprocess
    out = WORK / "dwg" / (_cache_key(path) + ".dxf")
    if out.is_file():
        return str(out)
    tin, tout = Path(tempfile.mkdtemp(dir=TEMP_DIR)), Path(tempfile.mkdtemp(dir=TEMP_DIR))
    shutil.copy2(path, tin / Path(path).name)
    subprocess.run([exe, str(tin), str(tout), "ACAD2018", "DXF", "0", "1", "*.DWG"], capture_output=True, timeout=600, creationflags=0x08000000)
    res = next(tout.glob("*.dxf"), None)
    if not res:
        return None
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(res), out)
    return str(out)


_DXF_CACHE: dict = {}


def _read_dxf(path: str):
    import ezdxf
    from ezdxf import recover
    key = _cache_key(path)
    if key in _DXF_CACHE:
        return _DXF_CACHE[key]
    try:
        doc = ezdxf.readfile(path)
    except Exception:  # noqa: BLE001
        doc, _ = recover.readfile(path)
    if len(_DXF_CACHE) > 4:
        _DXF_CACHE.clear()
    _DXF_CACHE[key] = doc
    return doc


def _xy(v):
    try:
        return [float(v[0]), float(v[1])]
    except Exception:  # noqa: BLE001
        return None


def _cad_info(dxf: str) -> dict:
    doc = _read_dxf(dxf)
    h = doc.header
    lo, hi = _xy(h.get("$LIMMIN", (0, 0))), _xy(h.get("$LIMMAX", (0, 0)))
    limits = lo + hi if lo and hi and hi[0] > lo[0] and hi[1] > lo[1] else None
    layouts = []
    for name in doc.layouts.names_in_taborder():
        if name.lower() == "model":
            continue
        lay = doc.layouts.get(name)
        if len(lay) == 0:
            continue
        w, hh = float(lay.dxf.paper_width or 0), float(lay.dxf.paper_height or 0)
        if lay.dxf.plot_rotation in (1, 3):
            w, hh = hh, w
        layouts.append({"name": name, "w": round(w, 1), "h": round(hh, 1)})
    units = int(h.get("$INSUNITS", 0) or 0)
    if units == 0:  # senza unita': millimetri nei disegni metrici, pollici in quelli imperiali
        units = 4 if int(h.get("$MEASUREMENT", 1) or 0) == 1 else 1
    return {"limits": limits, "layouts": layouts, "insunits": units, "units_mm": UNITS_MM.get(units, 1.0)}


# ================================================================ composizione del PDF di stampa
def _parse_pages(spec: str, n: int) -> list[int]:
    spec = (spec or "").strip()
    if not spec or spec.lower() in ("tutte", "all"):
        return list(range(n))
    out = []
    for part in re.split(r"[,; ]+", spec):
        if not part:
            continue
        m = re.match(r"^(\d+)?\s*-\s*(\d+)?$", part)
        if m:
            a = int(m.group(1) or 1)
            b = int(m.group(2) or n)
            out += list(range(a - 1, min(b, n)))
        elif part.isdigit() and 0 < int(part) <= n:
            out.append(int(part) - 1)
    return [p for p in out if 0 <= p < n] or list(range(n))


def _ratio(s) -> float:
    """'1:100' -> 0.01; '2:1' -> 2; 50 -> 0.5 (percentuale)."""
    if isinstance(s, (int, float)):
        return float(s)
    m = re.match(r"^\s*([\d.,]+)\s*[:/=]\s*([\d.,]+)\s*$", str(s))
    if not m:
        raise ValueError(t("srv_stampa.scala_non_valida_0", s))
    a, b = float(m.group(1).replace(",", ".")), float(m.group(2).replace(",", "."))
    if a <= 0 or b <= 0:
        raise ValueError(t("srv_stampa.scala_non_valida_0", s))
    return a / b


class _Papers:
    """Sceglie il formato carta per ogni pagina (fisso, oppure automatico in base alla dimensione della tavola)."""

    def __init__(self, info: dict, st: dict):
        self.forms = info.get("forms") or []
        self.custom = info.get("custom")
        self.st = st

    def _form(self, name):
        return next((f for f in self.forms if f["name"] == name), None)

    def fixed(self):
        p = self.st.get("paper") or "auto"
        if isinstance(p, dict):
            return {"name": p.get("name") or f"{p['w']:g} x {p['h']:g} mm", "id": p.get("id", 0), "w": float(p["w"]), "h": float(p["h"])}
        if p == "auto":
            return None
        f = self._form(p)
        if not f:
            raise ValueError(t("srv_stampa.formato_carta_non_disponibile_questa", p))
        return dict(f)

    def fallback(self):
        f = self.fixed()
        if f:
            return f
        name = self.st.get("paper_fallback") or "A3"
        return dict(self._form(name) or self._iso_form(name) or (self.forms[0] if self.forms else {"name": "A4", "id": 0, "w": 210, "h": 297}))

    def _iso_form(self, name):
        for n, w, h in ISO:
            if n == name:
                return next((f for f in self.forms if abs(min(f["w"], f["h"]) - w) < 2 and abs(max(f["w"], f["h"]) - h) < 2), None)
        return None

    def choose(self, cw: float, ch: float, margin: float = 0):
        """Formato per un contenuto di cw x ch mm: uguale (tolleranza 1%), poi il piu' piccolo che lo contiene,
        poi formato personalizzato / rotolo se la stampante lo consente, altrimenti il piu' grande (ridotto)."""
        f = self.fixed()
        if f:
            return f, False
        roll = self.st.get("roll")
        a, b = sorted((cw, ch))
        if roll:
            roll = float(roll)
            length = b + 2 * margin
            if a + 2 * margin > roll:  # piu' largo del rotolo: si riduce alla sua larghezza
                length = b * (roll - 2 * margin) / a + 2 * margin
            return {"name": t("srv_stampa.rotolo_0_x_1", f"{roll:g}", f"{length:.0f}"), "id": 0, "w": roll, "h": round(length, 1), "roll": True}, False
        tol = lambda x, y: abs(x - y) <= max(1.5, 0.01 * y)  # noqa: E731
        for f in self.forms:
            fa, fb = sorted((f["w"], f["h"]))
            if tol(a, fa) and tol(b, fb):
                return dict(f), False
        # solo formati "da disegno" (ISO A/B, ANSI, ARCH; almeno A4): niente buste, cartoline o biglietti
        std = [f for f in self.forms if _drawing_form(f)] or self.forms
        fits = [f for f in std if sorted((f["w"], f["h"]))[0] >= a - 0.5 and sorted((f["w"], f["h"]))[1] >= b - 0.5]
        if fits:
            return dict(min(fits, key=lambda f: (not _iso_like(f), f["w"] * f["h"], f["id"] or 0))), False
        c = self.custom
        if c and a <= c["max"][0] and b <= c["max"][1]:
            return {"name": t("srv_stampa.personalizzato_0_x_1_mm", f"{a:.0f}", f"{b:.0f}"), "id": 0, "w": round(a, 1), "h": round(b, 1)}, False
        if self.forms:
            return dict(max(self.forms, key=lambda f: f["w"] * f["h"])), True
        return {"name": "A4", "id": 0, "w": 210, "h": 297}, True


_DRAWING_SIZES = [(w, h) for _, w, h in ISO[:-1] + ISO_EXTRA] + [(216, 279), (279, 432), (432, 559), (559, 864), (864, 1118),
                                                              (229, 305), (305, 457), (457, 610), (610, 914), (914, 1219), (762, 1067)]


def _drawing_form(f) -> bool:
    a, b = sorted((f["w"], f["h"]))
    return any(abs(a - w) <= 1 and abs(b - h) <= 1 for w, h in _DRAWING_SIZES)


def _iso_like(f) -> bool:
    a, b = sorted((f["w"], f["h"]))
    return any(abs(a - w) <= 1 and abs(b - h) <= 1 for _, w, h in ISO)


def _orient(paper: dict, cw: float, ch: float, st: dict) -> tuple[float, float, bool]:
    """Dimensioni del foglio (larghezza, altezza) e orientamento orizzontale."""
    a, b = sorted((paper["w"], paper["h"]))
    o = st.get("orientation") or "auto"
    land = (cw > ch) if o == "auto" else (o == "landscape")
    return (b, a, True) if land else (a, b, False)


def _style_cfg(style: str, lw: str):
    from ezdxf.addons.drawing.config import BackgroundPolicy, ColorPolicy, Configuration, LineweightPolicy
    cp = {"gray": ColorPolicy.MONOCHROME_LIGHT_BG, "bw": ColorPolicy.BLACK}.get(style, ColorPolicy.COLOR)
    scale = {"thin": 0.0, "half": 0.5, "double": 2.0}.get(lw or "", 1.0)
    return Configuration(background_policy=BackgroundPolicy.WHITE, color_policy=cp, lineweight_policy=LineweightPolicy.ABSOLUTE,
                         lineweight_scaling=scale, min_lineweight=0.05)


def _cad_pdf(item: dict, st: dict, papers: _Papers, margins_for) -> list[dict]:
    """Disegno -> pagine PDF gia' alla dimensione del foglio (ezdxf, vettoriale). Restituisce [{pdf, w, h, ...}]."""
    from ezdxf.addons.drawing import Frontend, RenderContext, layout
    from ezdxf.addons.drawing.pymupdf import PyMuPdfBackend
    from ezdxf.math import BoundingBox2d
    doc = _read_dxf(item["dxf"])
    cad = st.get("cad") or {}
    style = st.get("style") or "color"
    ctb = cad.get("ctb") or ""
    cfg = _style_cfg(style if not ctb else "color", cad.get("lw"))
    area = cad.get("area") or "extents"
    if area == "auto":  # stampa a lotti: i layout se il disegno ne ha, altrimenti tutto il disegno
        area = "layout" if item.get("layouts") else "extents"
    umm = UNITS_MM.get(cad.get("units") or item.get("insunits") or 4, 1.0)
    sc = cad.get("scale") or st.get("scale") or {}   # scala dei disegni (nei lotti e' separata da quella dei documenti)
    mode = sc.get("mode", "fit")
    ratio = _ratio(sc.get("cad") or "1:1") if mode == "cad" else (sc.get("value", 100) / 100 if mode == "percent" else 1.0)
    targets = []
    if area == "layout" and item.get("layouts"):
        want = cad.get("layout") or "*"
        targets = [L["name"] for L in item["layouts"] if want in ("*", "", None, L["name"])] or [item["layouts"][0]["name"]]
    else:
        targets = [None]
    pages = []
    for lname in targets:
        ctx = RenderContext(doc, ctb=ctb) if ctb else RenderContext(doc)
        backend = PyMuPdfBackend()
        lay = doc.layouts.get(lname) if lname else doc.modelspace()
        Frontend(ctx, backend, config=cfg).draw_layout(lay, finalize=True)
        box = None
        if lname:
            # foglio del layout: l'origine dello spazio carta e' l'angolo dell'area stampabile
            pw, ph = float(lay.dxf.paper_width or 0), float(lay.dxf.paper_height or 0)
            lm, bm = float(lay.dxf.left_margin or 0), float(lay.dxf.bottom_margin or 0)
            if pw > 0 and ph > 0:
                if lay.dxf.plot_rotation in (1, 3):
                    pw, ph = ph, pw
                box = BoundingBox2d([(-lm, -bm), (pw - lm, ph - bm)])
            unit = 1.0  # spazio carta in mm
        else:
            unit = umm
            if area == "limits":
                L = item.get("limits") or item.get("limits_ui")
                if L:
                    box = BoundingBox2d([(L[0], L[1]), (L[2], L[3])])
            elif area in ("view", "window"):
                W = cad.get("window") if area == "window" else item.get("view")
                if W:
                    box = BoundingBox2d([(min(W[0], W[2]), min(W[1], W[3])), (max(W[0], W[2]), max(W[1], W[3]))])
        if box is None:
            bb = backend.player().bbox()
            if not bb.has_data:
                raise ValueError(t("srv_stampa.disegno_vuoto_i_layer_sono"))
            box = BoundingBox2d([bb.extmin, bb.extmax])
        size = box.size
        cw, ch = size.x * unit, size.y * unit           # contenuto in mm a scala 1:1 (spazio carta) o in unita' reali
        if lname:  # layout: e' gia' in scala sul suo foglio -> 1:1 (adattato solo se si sceglie un altro formato)
            ratio_eff = ratio if mode == "percent" else (None if mode == "fit" and papers.fixed() else 1.0)
        else:
            ratio_eff = ratio if mode in ("cad", "percent", "actual") else None
            if mode == "auto":  # tavola disegnata 1:1 (cartiglio in mm): sul suo formato; disegno al vero: adattato
                a, b = sorted((cw, ch))
                ratio_eff = 1.0 if any(sorted((f["w"], f["h"]))[0] >= a - 2 and sorted((f["w"], f["h"]))[1] >= b - 2 for f in papers.forms) and a >= 50 else None
        if ratio_eff is not None:
            paper, reduced = papers.choose(cw * ratio_eff, ch * ratio_eff, margin=0)
        else:
            paper, reduced = papers.fallback(), False
        rw, rh = (cw * (ratio_eff or 1), ch * (ratio_eff or 1))
        W_, H_, land = _orient(paper, rw, rh, st)
        mg = margins_for(paper, land)
        user_m = float(st.get("margin", 5) or 0)
        fit = ratio_eff is None or reduced
        warn = t("srv_stampa.formato_carta_piu_piccolo_tavola") if reduced else None
        if not fit and (rw > W_ + 1 or rh > H_ + 1):
            warn = t("srv_stampa.questa_scala_disegno_0_x", f"{rw:.0f}", f"{rh:.0f}")
        m = [max(x, user_m) for x in mg] if fit else [0, 0, 0, 0]
        page = layout.Page(W_, H_, layout.Units.mm, margins=layout.Margins(top=m[1], right=m[2], bottom=m[3], left=m[0]))
        settings = layout.Settings(fit_page=fit, scale=unit * (ratio_eff or 1), crop_at_margins=not fit,
                                   page_alignment=layout.PageAlignment.MIDDLE_CENTER if st.get("center", True) else layout.PageAlignment.TOP_LEFT,
                                   max_stroke_width=0.02, min_stroke_width=0.05, output_layers=False)
        pdf = backend.get_pdf_bytes(page, settings=settings, render_box=box)
        avail_w, avail_h = W_ - m[0] - m[2], H_ - m[1] - m[3]
        eff = min(avail_w / cw, avail_h / ch) if fit and cw > 0 and ch > 0 else (ratio_eff or 1)
        note = _scale_note(eff, lname is not None, unit, umm)
        if fit and note:
            note = t("srv_stampa.adattata_0", ("~" if ":" in note else "") + note)
        pages.append({"pdf": pdf, "w": W_, "h": H_, "landscape": land, "paper": paper, "scale": note,
                      "label": f"{item['name']}" + (f" - {lname}" if lname else ""), "styled": True, "warn": warn})
    return pages


def _scale_note(eff: float, paperspace: bool, unit: float, umm: float) -> str:
    """Scala effettiva in forma tecnica (1:100) o in percentuale."""
    if eff <= 0:
        return ""
    if paperspace:
        return f"{eff * 100:.0f}%" if abs(eff - 1) > 0.005 else "1:1"
    # eff = mm di carta per mm reali (unit gia' applicata) -> 1:N
    k = eff
    if k >= 1:
        return f"{k:.3g}:1"
    n = 1 / k
    return f"1:{n:.1f}".replace(".", ",") if abs(n - round(n)) > 0.01 * n else f"1:{round(n)}"


def compose(sid: str, st: dict, update=None) -> dict:
    """Pagine finali (una per foglio) nel PDF di stampa. st = impostazioni della finestra."""
    import pymupdf
    update = update or (lambda **k: None)
    src = _SOURCES.get(sid)
    if not src:
        raise ValueError(t("srv_stampa.sorgenti_stampa_scadute_riapri_finestra"))
    name = st.get("printer") or PDF_VIRTUAL
    info = printer_info(name)
    papers = _Papers(info, st)
    devmode = st.get("devmode")
    margins_for = lambda paper, land: hardware_margins(name, paper, land, devmode)  # noqa: E731
    out = pymupdf.open()
    pages = []
    items = [it for it in src["items"] if it.get("kind") != "error"]
    errors = [{"name": it["name"], "errore": it.get("errore")} for it in src["items"] if it.get("kind") == "error"]
    sc = st.get("scale") or {"mode": "fit"}
    mode = sc.get("mode", "fit")
    for i, it in enumerate(items):
        update(progress=i / max(1, len(items)), message=t("srv_stampa.impaginazione_0", it['name']))
        try:
            if it["kind"] == "cad":
                for p in _cad_pdf(it, st, papers, margins_for):
                    with pymupdf.open("pdf", p["pdf"]) as d:
                        pg = out.new_page(width=p["w"] * MM, height=p["h"] * MM)
                        # ezdxf tronca il foglio ai punti interi (297 mm -> 841 pt) e scala il disegno su quel valore:
                        # si riporta alla misura esatta, altrimenti la scala sbaglierebbe di circa lo 0,1%
                        big = max(p["w"], p["h"])
                        s = MM * big / int(big * MM)
                        r = d[0].rect
                        pg.show_pdf_page(pymupdf.Rect(0, 0, r.width * s, r.height * s), d, 0)
                    p.pop("pdf")
                    pages.append(p)
                continue
            with pymupdf.open(it["pdf"]) as d:
                sel = _parse_pages(st.get("pages", ""), len(d)) if len(items) == 1 else list(range(len(d)))
                for pno in sel:
                    r = d[pno].rect
                    cw, ch = r.width / MM, r.height / MM
                    if mode in ("actual", "percent", "cad"):
                        k = sc.get("value", 100) / 100 if mode == "percent" else 1.0
                        paper, reduced = papers.choose(cw * k, ch * k)
                    else:
                        k = None
                        f = papers.fixed()
                        paper, reduced = (f, False) if f else papers.choose(cw, ch)
                    W_, H_, land = _orient(paper, cw, ch, st)
                    warn = t("srv_stampa.formato_carta_piu_piccolo_pagina") if reduced else None
                    if k is not None and (cw * k > W_ + 1 or ch * k > H_ + 1):
                        if mode == "cad":  # scala dei disegni: le pagine PDF piu' grandi del foglio si riducono
                            reduced, warn = True, t("srv_stampa.pagina_piu_grande_foglio_stampa")
                        else:
                            warn = t("srv_stampa.pagina_esce_foglio_i_bordi")
                    fit = k is None or reduced
                    mg = margins_for(paper, land)
                    user_m = float(st.get("margin", 5) or 0)
                    m = [max(x, user_m) for x in mg] if fit else [0, 0, 0, 0]
                    if fit:
                        # "adatta": se la pagina e' gia' del formato del foglio si stampa al 100% (margini = quelli fisici)
                        same = abs(cw - W_) <= max(1.5, 0.01 * W_) and abs(ch - H_) <= max(1.5, 0.01 * H_)
                        if same and st.get("fit_same_100", True) and k is None and not reduced:
                            k = 1.0
                        else:
                            k = min((W_ - m[0] - m[2]) / cw, (H_ - m[1] - m[3]) / ch)
                    pw, ph = cw * k, ch * k
                    if st.get("center", True):
                        x0, y0 = (W_ - pw) / 2, (H_ - ph) / 2
                    else:
                        x0, y0 = m[0], m[1]
                    pg = out.new_page(width=W_ * MM, height=H_ * MM)
                    rect = pymupdf.Rect(x0 * MM, y0 * MM, (x0 + pw) * MM, (y0 + ph) * MM)
                    pg.show_pdf_page(rect, d, pno)
                    pages.append({"w": W_, "h": H_, "landscape": land, "paper": paper, "scale": f"{k * 100:.0f}%" if abs(k - 1) > 0.004 else "100%",
                                  "label": t("srv_stampa.0_pag_1", it["name"], pno + 1) if len(d) > 1 else it["name"], "styled": False,
                                  "warn": warn})
        except Exception as e:  # noqa: BLE001
            errors.append({"name": it["name"], "errore": str(e) or e.__class__.__name__})
    if not pages:
        raise ValueError(errors[0]["errore"] if errors else t("srv_stampa.niente_stampare"))
    cid = uuid.uuid4().hex[:12]
    d = WORK / "lavori"
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{cid}.pdf"
    out.save(path, garbage=3, deflate=True)
    out.close()
    for p in pages:
        p["margins"] = margins_for(p["paper"], p["landscape"])
    with _LOCK:
        for old in list(_JOBS)[:-20]:  # tiene solo gli ultimi lavori
            try:
                os.remove(_JOBS.pop(old)["pdf"])
            except Exception:  # noqa: BLE001
                pass
        _JOBS[cid] = {"pdf": str(path), "pages": pages, "settings": st}
    update(progress=1, message=t("srv_stampa.pronto"))
    return {"ok": True, "cid": cid, "pages": pages, "errori": errors}


# ================================================================ stile, anteprima
def _render(page, dpi: float, style: str, styled: bool, clip=None, gray_ok=True):
    """Pixmap della pagina (o di una sua fascia) con lo stile applicato. Restituisce (modo, larghezza, altezza, byte, irect)."""
    import pymupdf
    mat = pymupdf.Matrix(dpi / 72, dpi / 72)
    if style in ("gray", "bw") and not styled:
        pix = page.get_pixmap(matrix=mat, clip=clip, colorspace=pymupdf.csGRAY, alpha=False)
        data = pix.samples
        if style == "bw":
            import numpy as np
            a = np.frombuffer(data, dtype=np.uint8).reshape(pix.height, pix.stride)
            data = np.where(a < 235, 0, 255).astype(np.uint8).tobytes()  # tutto cio' che non e' bianco diventa nero
        return "L", pix, data
    pix = page.get_pixmap(matrix=mat, clip=clip, colorspace=pymupdf.csRGB, alpha=False)
    return "RGB", pix, pix.samples


def preview_png(cid: str, pno: int, dpi: float = 60, style: str | None = None) -> bytes:
    import pymupdf
    from PIL import Image
    job = _JOBS.get(cid)
    if not job:
        raise ValueError(t("srv_stampa.anteprima_scaduta"))
    st = job["settings"]
    info = job["pages"][pno]
    with pymupdf.open(job["pdf"]) as d:
        mode, pix, data = _render(d[pno], dpi, style or st.get("style") or "color", info.get("styled"))
        im = Image.frombuffer(mode, (pix.width, pix.height), data, "raw", mode, pix.stride, 1)
        bio = io.BytesIO()
        im.save(bio, "PNG", optimize=False, compress_level=1)
        return bio.getvalue()


# ================================================================ stampa
def run(cid: str, extra: dict | None = None, update=None) -> dict:
    """extra: impostazioni che non cambiano l'impaginazione (copie, fascicola, file PDF, qualita', titolo)."""
    update = update or (lambda **k: None)
    job = _JOBS.get(cid)
    if not job:
        raise ValueError(t("srv_stampa.lavoro_stampa_scaduto_aggiorna_l"))
    st = {**job["settings"], **{k: v for k, v in (extra or {}).items() if k in ("copies", "collate", "output", "dpi", "title", "devmode")}}
    name = st.get("printer") or PDF_VIRTUAL
    if name == PDF_VIRTUAL:
        return _save_pdf(job, st, update)
    return _print_gdi(job, st, name, update)


def _save_pdf(job: dict, st: dict, update) -> dict:
    import pymupdf
    out = st.get("output")
    if not out:
        raise ValueError(t("srv_stampa.scegli_dove_salvare_pdf"))
    style = st.get("style") or "color"
    with pymupdf.open(job["pdf"]) as d:
        if style == "color" or all(p.get("styled") for p in job["pages"]):
            d.save(out, garbage=3, deflate=True)
        else:
            # grigi / bianco e nero sui documenti non CAD: pagine rasterizzate a 300 dpi (i CAD restano vettoriali)
            res = pymupdf.open()
            for i, (pg, info) in enumerate(zip(d, job["pages"])):
                update(progress=i / len(job["pages"]), message=t("srv_stampa.pagina_0_1", i + 1, len(job['pages'])))
                if info.get("styled"):
                    res.insert_pdf(d, from_page=i, to_page=i)
                    continue
                mode, pix, data = _render(pg, 300, style, False)
                from PIL import Image
                im = Image.frombuffer(mode, (pix.width, pix.height), data, "raw", mode, pix.stride, 1)
                if style == "bw":
                    im = im.convert("1")
                bio = io.BytesIO()
                im.save(bio, "PNG")
                np_ = res.new_page(width=pg.rect.width, height=pg.rect.height)
                np_.insert_image(np_.rect, stream=bio.getvalue())
            res.save(out, garbage=3, deflate=True)
            res.close()
    return {"ok": True, "output": out, "pagine": len(job["pages"])}


def _print_gdi(job: dict, st: dict, name: str, update) -> dict:
    import numpy as np
    import pymupdf
    style = st.get("style") or "color"
    copies = max(1, int(st.get("copies") or 1))
    collate = bool(st.get("collate", True))
    info = printer_info(name)
    driver_copies = copies if info.get("copies", 1) >= copies else 1
    loops = 1 if driver_copies == copies else copies
    quality = int(st.get("dpi") or 0)
    pages = job["pages"]
    order = []
    for _ in range(loops):
        order += list(range(len(pages)))
    if loops > 1 and not collate:
        order = sorted(order)
    dm = _DevMode(name, st.get("devmode"))
    first = pages[order[0]]
    color = style == "color" and info.get("color", True)
    dm.set(first["paper"], first["landscape"], driver_copies, color, collate)
    hdc = _gdi.CreateDCW("WINSPOOL", name, None, dm.buf)
    if not hdc:
        raise RuntimeError(t("srv_stampa.impossibile_aprire_stampante_0_errore", name, ctypes.get_last_error()))
    warnings = []
    di = DOCINFOW(ctypes.sizeof(DOCINFOW), st.get("title") or "MB Visual", st.get("output") or None, None, 0)
    started = False
    try:
        if _gdi.StartDocW(hdc, ctypes.byref(di)) <= 0:
            raise RuntimeError(t("srv_stampa.stampante_ha_rifiutato_lavoro_stampa"))
        started = True
        _gdi.SetStretchBltMode(hdc, 4)  # HALFTONE
        cur = (first["paper"].get("id"), first["paper"].get("w"), first["paper"].get("h"), first["landscape"])
        with pymupdf.open(job["pdf"]) as d:
            for n, pno in enumerate(order):
                info_p = pages[pno]
                key = (info_p["paper"].get("id"), info_p["paper"].get("w"), info_p["paper"].get("h"), info_p["landscape"])
                if key != cur:  # formato diverso dalla pagina precedente (stampa a lotti)
                    dm.set(info_p["paper"], info_p["landscape"], driver_copies, color, collate)
                    _gdi.ResetDCW(hdc, dm.buf)
                    _gdi.SetStretchBltMode(hdc, 4)
                    cur = key
                update(progress=n / len(order), message=t("srv_stampa.invio_stampante_pagina_0_1", n + 1, len(order)))
                if _gdi.StartPage(hdc) <= 0:
                    raise RuntimeError(t("srv_stampa.stampa_interrotta"))
                c = _caps(hdc)
                page = d[pno]
                # pagina del PDF (pt) -> foglio fisico (pixel del dispositivo); se il driver ha usato un altro formato si adatta
                fx = c["w"] / (page.rect.width / 72 * c["dpix"])
                fy = c["h"] / (page.rect.height / 72 * c["dpiy"])
                k = 1.0
                if abs(fx - 1) > 0.02 or abs(fy - 1) > 0.02:
                    k = min(fx, fy)
                    warnings.append(t("srv_stampa.pagina_0_stampante_ha_usato", pno + 1, f"{c['w'] / c['dpix'] * 25.4:.0f}", f"{c['h'] / c['dpiy'] * 25.4:.0f}"))
                dpi_dev = c["dpix"] * k
                rdpi = min(dpi_dev, quality) if quality else dpi_dev
                big = page.rect.width * page.rect.height / MM / MM > 420 * 594 * 1.05
                if not quality:
                    rdpi = min(dpi_dev, 300 if big else 600)
                # area stampabile in punti della pagina
                x0 = c["offx"] / dpi_dev * 72
                y0 = c["offy"] / (c["dpiy"] * k) * 72
                x1 = x0 + c["hres"] / dpi_dev * 72
                y1 = y0 + c["vres"] / (c["dpiy"] * k) * 72
                x1, y1 = min(x1, page.rect.width), min(y1, page.rect.height)
                bpp = 1 if (style in ("gray", "bw") and not info_p.get("styled")) else 3
                row_bytes = (x1 - x0) / 72 * rdpi * bpp + 4
                band_h = max(8.0, (24 * 1024 * 1024 / row_bytes) / rdpi * 72)
                y = y0
                while y < y1 - 0.01:
                    yb = min(y1, y + band_h)
                    clip = pymupdf.Rect(x0, y, x1, yb)
                    mode, pix, data = _render(page, rdpi, style, info_p.get("styled"), clip=clip)
                    w, h = pix.width, pix.height
                    a = np.frombuffer(data, dtype=np.uint8).reshape(h, pix.stride)[:, : w * (1 if mode == "L" else 3)]
                    if mode == "RGB":
                        a = a.reshape(h, w, 3)[:, :, ::-1].reshape(h, w * 3)
                    pad = (-a.shape[1]) % 4
                    if pad:
                        a = np.pad(a, ((0, 0), (0, pad)), constant_values=255)
                    buf = np.ascontiguousarray(a).tobytes()
                    bmi = BITMAPINFO256()
                    bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
                    bmi.bmiHeader.biWidth = w
                    bmi.bmiHeader.biHeight = -h  # dall'alto in basso
                    bmi.bmiHeader.biPlanes = 1
                    bmi.bmiHeader.biBitCount = 8 if mode == "L" else 24
                    if mode == "L":
                        bmi.bmiHeader.biClrUsed = 256
                        for i in range(256):
                            bmi.bmiColors[i] = i | (i << 8) | (i << 16)
                    # posizione nel dispositivo: dai pixel della pixmap (irect, a rdpi) ai pixel della stampante
                    sx, sy = dpi_dev / rdpi, c["dpiy"] * k / rdpi
                    dx = int(round(pix.x * sx - c["offx"]))
                    dy = int(round(pix.y * sy - c["offy"]))
                    dw = int(round((pix.x + w) * sx - c["offx"])) - dx
                    dh = int(round((pix.y + h) * sy - c["offy"])) - dy
                    r = _gdi.StretchDIBits(hdc, dx, dy, dw, dh, 0, 0, w, h, buf, ctypes.byref(bmi), 0, 0x00CC0020)
                    if r == 0:
                        raise RuntimeError(t("srv_stampa.errore_driver_durante_stampa_stretchdibits", ctypes.get_last_error()))
                    y = yb
                if _gdi.EndPage(hdc) <= 0:
                    raise RuntimeError(t("srv_stampa.stampa_interrotta_stampante"))
        _gdi.EndDoc(hdc)
        started = False
    finally:
        if started:
            _gdi.AbortDoc(hdc)
        _gdi.DeleteDC(hdc)
    return {"ok": True, "pagine": len(order), "stampante": name, "avvisi": warnings[:10]}


# ================================================================ stampa a lotti: file di una cartella
PRINTABLE = {"pdf", "dwg", "dxf"}


def scan(folder: str, exts: list[str] | None = None, sub: bool = False) -> dict:
    exts = {e.lower().lstrip(".") for e in (exts or PRINTABLE)}
    root = Path(folder)
    if not root.is_dir():
        raise ValueError(t("srv_stampa.cartella_non_trovata"))
    it = root.rglob("*") if sub else root.glob("*")
    files = []
    for p in it:
        if p.is_file() and p.suffix.lower().lstrip(".") in exts and not p.name.startswith("~$"):
            files.append({"path": str(p), "name": p.name, "size": p.stat().st_size, "rel": str(p.relative_to(root))})
            if len(files) >= 2000:
                break
    files.sort(key=lambda f: f["rel"].lower())
    return {"ok": True, "files": files}


def ctb_files() -> dict:
    """Tabelle stili di stampa (.ctb) di AutoCAD/BricsCAD trovate sul PC."""
    roots = []
    for env in ("APPDATA", "LOCALAPPDATA"):
        b = os.environ.get(env)
        if b:
            roots += [Path(b) / "Autodesk", Path(b) / "Bricsys"]
    found = {}
    for r in roots:
        if not r.is_dir():
            continue
        try:
            for p in r.glob("**/Plot Styles/*.ctb"):
                found.setdefault(p.name.lower(), str(p))
                if len(found) > 200:
                    break
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True, "ctb": sorted(({"name": Path(v).name, "path": v} for v in found.values()), key=lambda x: x["name"].lower())}

