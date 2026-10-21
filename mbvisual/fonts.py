"""Caratteri installati nel sistema: famiglia (minuscolo) -> {(grassetto, corsivo): file}.

Windows: registro dei caratteri (macchina e utente). macOS e Linux: cartelle dei caratteri lette con fontTools
(nome della famiglia e stile dalla tabella "name"; nei .ttc vale il primo carattere, come su Windows).
"""
import os
import re
from pathlib import Path

from .paths import IS_MAC, IS_WIN

WIN_FONTS_DIR = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
_IDX = None


def font_dirs() -> list:
    if IS_WIN:
        return [WIN_FONTS_DIR, Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "Windows" / "Fonts"]
    if IS_MAC:
        return [Path.home() / "Library" / "Fonts", Path("/Library/Fonts"), Path("/System/Library/Fonts/Supplemental"),
                Path("/System/Library/Fonts"),
                # caratteri di Microsoft Office per Mac (Calibri, Cambria...)
                Path("/Applications/Microsoft Word.app/Contents/Resources/DFonts")]
    return [Path.home() / ".local" / "share" / "fonts", Path.home() / ".fonts", Path("/usr/local/share/fonts"), Path("/usr/share/fonts")]


def _style_key(style: str) -> tuple:
    st = (style or "").lower()
    return ("bold" in st or "black" in st or "heavy" in st, "italic" in st or "oblique" in st)


def _win_index() -> dict:
    idx: dict = {}
    import winreg
    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        try:
            k = winreg.OpenKey(hive, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts")
        except OSError:
            continue
        i = 0
        while True:
            try:
                name, data, _ = winreg.EnumValue(k, i)
            except OSError:
                break
            i += 1
            f = Path(data)
            if not f.is_absolute():
                f = WIN_FONTS_DIR / data
            if f.suffix.lower() not in (".ttf", ".otf", ".ttc") or not f.exists():
                continue
            name = re.sub(r"\s*\((TrueType|OpenType)\)\s*$", "", name, flags=re.I)
            first = name.split(" & ")[0].strip()  # nei .ttc vale solo la prima famiglia (indice 0)
            m = re.match(r"^(.*?)(?:\s+(Bold Italic|Bold Oblique|Bold|Italic|Oblique|Regular))?$", first)
            fam, st = m.group(1).strip().lower(), (m.group(2) or "").lower()
            key = ("bold" in st, "italic" in st or "oblique" in st)
            idx.setdefault(fam, {}).setdefault(key, str(f))
    return idx


def _scan_index() -> dict:
    from fontTools.ttLib import TTCollection, TTFont
    idx: dict = {}
    for d in font_dirs():
        if not d.is_dir():
            continue
        for dp, _dn, fn in os.walk(d):
            for n in sorted(fn):
                f = Path(dp) / n
                ext = f.suffix.lower()
                if ext not in (".ttf", ".otf", ".ttc"):
                    continue
                try:
                    font = TTCollection(str(f), lazy=True).fonts[0] if ext == ".ttc" else TTFont(str(f), lazy=True)
                    names = font["name"]
                    fam = names.getDebugName(16) or names.getDebugName(1)
                    style = names.getDebugName(17) or names.getDebugName(2) or ""
                    font.close()
                except Exception:  # noqa: BLE001 - file danneggiato o formato non leggibile
                    continue
                if fam:
                    idx.setdefault(fam.strip().lower(), {}).setdefault(_style_key(style), str(f))
    return idx


def index() -> dict:
    """famiglia (minuscolo) -> {(grassetto, corsivo): file}; calcolato una volta sola."""
    global _IDX
    if _IDX is None:
        try:
            _IDX = _win_index() if IS_WIN else _scan_index()
        except Exception:  # noqa: BLE001
            _IDX = {}
    return _IDX


def find(family: str, bold: bool = False, italic: bool = False):
    """File del carattere piu' vicino allo stile chiesto, oppure None."""
    files = index().get((family or "").lower())
    if not files:
        return None
    for key in ((bold, italic), (bold, False), (False, italic), (False, False)):
        if key in files:
            return files[key]
    return next(iter(files.values()))
