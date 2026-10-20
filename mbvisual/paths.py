"""Percorsi dell'app e ricerca dei programmi esterni (funziona sia da sorgente sia da exe portatile)."""
import os
import shutil
import sys
import tempfile
from pathlib import Path

if getattr(sys, "frozen", False):
    APP_DIR = Path(sys.executable).resolve().parent
    RES_DIR = Path(getattr(sys, "_MEIPASS", APP_DIR))
else:
    APP_DIR = Path(__file__).resolve().parent.parent
    RES_DIR = APP_DIR

UI_DIR = RES_DIR / "ui"
BIN_DIR = RES_DIR / "bin"
TEMP_DIR = Path(tempfile.gettempdir()) / "MBVisual"
TEMP_DIR.mkdir(parents=True, exist_ok=True)


def _first_existing(candidates):
    for c in candidates:
        if c and Path(c).is_file():
            return str(c)
    return None


def _program_files():
    roots = []
    for var in ("ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "LOCALAPPDATA"):
        v = os.environ.get(var)
        if v and Path(v).is_dir() and v not in roots:
            roots.append(v)
    return [Path(r) for r in roots]


def _glob_programs(pattern: str):
    found = []
    for root in _program_files():
        found.extend(sorted(root.glob(pattern), reverse=True))
    return found


def find_7zip():
    return _first_existing([BIN_DIR / "7zip" / "7z.exe",
                            *[r / "7-Zip" / "7z.exe" for r in _program_files()],
                            shutil.which("7z")])


def find_ffmpeg():
    local = BIN_DIR / "ffmpeg.exe"
    if local.is_file():
        return str(local)
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg")


def find_libreoffice():
    return _first_existing([*[r / "LibreOffice" / "program" / "soffice.exe" for r in _program_files()],
                            *_glob_programs("LibreOffice*/program/soffice.exe"),
                            BIN_DIR / "LibreOfficePortable" / "App" / "libreoffice" / "program" / "soffice.exe",
                            shutil.which("soffice")])


def find_navisworks():
    return _first_existing([*_glob_programs("Autodesk/Navisworks Freedom*/Roamer.exe"),
                            *_glob_programs("Autodesk/Navisworks Manage*/Roamer.exe"),
                            *_glob_programs("Autodesk/Navisworks Simulate*/Roamer.exe")])


def find_trueview():
    return _first_existing([*_glob_programs("Autodesk/DWG TrueView*/dwgviewr.exe"),
                            *_glob_programs("Autodesk/AutoCAD*/acad.exe")])


def find_office(exe: str):
    """Percorso di un programma Office (excel.exe, winword.exe, powerpnt.exe) dal registro "App Paths" di Windows."""
    try:
        import winreg
    except ImportError:
        return None
    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        try:
            with winreg.OpenKey(hive, rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe}") as k:
                p = winreg.QueryValue(k, None)
                if p and Path(p.strip('"')).exists():
                    return p.strip('"')
        except OSError:
            continue
    return None


def tools_status():
    return {
        "7zip": find_7zip(),
        "ffmpeg": find_ffmpeg(),
        "libreoffice": find_libreoffice(),
        "navisworks": find_navisworks(),
        "trueview": find_trueview(),
        "excel": find_office("excel.exe"),
        "word": find_office("winword.exe"),
        "powerpoint": find_office("powerpnt.exe"),
    }
