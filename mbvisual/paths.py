"""Percorsi dell'app e ricerca dei programmi esterni (funziona sia da sorgente sia da exe portatile, su Windows e su macOS)."""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

IS_WIN = sys.platform == "win32"
IS_MAC = sys.platform == "darwin"
# processi senza finestra di console (solo Windows: altrove subprocess rifiuta creationflags diversi da 0)
NO_WINDOW = 0x08000000 if IS_WIN else 0
EXE = ".exe" if IS_WIN else ""

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


def _data_dir() -> Path:
    """Cartella dei dati dell'utente (licenza, impostazioni, profilo del browser integrato)."""
    if IS_WIN:
        return Path(os.environ.get("LOCALAPPDATA", tempfile.gettempdir())) / "MBVisual"
    if IS_MAC:
        return Path.home() / "Library" / "Application Support" / "MBVisual"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "MBVisual"


DATA_DIR = _data_dir()


def open_default(path: str) -> None:
    """Apre un file con il programma predefinito del sistema."""
    if IS_WIN:
        os.startfile(path)  # noqa: S606
    else:
        subprocess.Popen(["open" if IS_MAC else "xdg-open", path])


def reveal(path: str) -> None:
    """Mostra il file nella cartella (Esplora file / Finder)."""
    if IS_WIN:
        subprocess.Popen(["explorer", "/select,", path])
    elif IS_MAC:
        subprocess.Popen(["open", "-R", path])
    else:
        subprocess.Popen(["xdg-open", str(Path(path).parent)])


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
    if not IS_WIN:  # 7zz = 7-Zip ufficiale per macOS/Linux (bin/7zip/7zz nel pacchetto)
        return _first_existing([BIN_DIR / "7zip" / "7zz", shutil.which("7zz"), shutil.which("7z"),
                                "/opt/homebrew/bin/7zz", "/usr/local/bin/7zz"])
    return _first_existing([BIN_DIR / "7zip" / "7z.exe",
                            *[r / "7-Zip" / "7z.exe" for r in _program_files()],
                            shutil.which("7z")])


def find_ffmpeg():
    local = BIN_DIR / ("ffmpeg" + EXE)
    if local.is_file():
        return str(local)
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg")


def find_libreoffice():
    if IS_MAC:
        return _first_existing(["/Applications/LibreOffice.app/Contents/MacOS/soffice",
                                Path.home() / "Applications" / "LibreOffice.app" / "Contents" / "MacOS" / "soffice",
                                shutil.which("soffice")])
    if not IS_WIN:
        return _first_existing([shutil.which("soffice"), shutil.which("libreoffice")])
    return _first_existing([*[r / "LibreOffice" / "program" / "soffice.exe" for r in _program_files()],
                            *_glob_programs("LibreOffice*/program/soffice.exe"),
                            BIN_DIR / "LibreOfficePortable" / "App" / "libreoffice" / "program" / "soffice.exe",
                            shutil.which("soffice")])


def find_navisworks():
    if not IS_WIN:
        return None
    return _first_existing([*_glob_programs("Autodesk/Navisworks Freedom*/Roamer.exe"),
                            *_glob_programs("Autodesk/Navisworks Manage*/Roamer.exe"),
                            *_glob_programs("Autodesk/Navisworks Simulate*/Roamer.exe")])


def find_trueview():
    if not IS_WIN:
        return None
    return _first_existing([*_glob_programs("Autodesk/DWG TrueView*/dwgviewr.exe"),
                            *_glob_programs("Autodesk/AutoCAD*/acad.exe")])


MAC_OFFICE = {"excel.exe": "Microsoft Excel.app", "winword.exe": "Microsoft Word.app", "powerpnt.exe": "Microsoft PowerPoint.app"}


def _first_existing_dir(candidates):
    for c in candidates:
        if c and Path(c).is_dir():
            return str(c)
    return None


def open_with(exe: str, path: str) -> None:
    """Apre un file con un programma preciso (sul Mac un pacchetto .app si avvia con `open -a`)."""
    if IS_MAC and exe.endswith(".app"):
        subprocess.Popen(["open", "-a", exe, path])
    else:
        subprocess.Popen([exe, path])


def find_office(exe: str):
    """Percorso di un programma Office (excel.exe, winword.exe, powerpnt.exe) dal registro "App Paths" di Windows.
    Sul Mac il pacchetto .app di Microsoft Office (si apre con `open -a`, vedi open_with); niente COM fuori da Windows."""
    if IS_MAC:
        name = MAC_OFFICE.get(exe.lower())
        return _first_existing_dir([Path("/Applications") / name, Path.home() / "Applications" / name]) if name else None
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


def find_nwd2mbv():
    """Lettore Navisworks indipendente (tools/nwd2mbv, basato su nwd-reader): NWD/NWC senza Navisworks installato."""
    for f in (RES_DIR / "bin" / ("nwd2mbv" + EXE), Path.home() / ".mbvisual" / "nwd" / ("nwd2mbv" + EXE)):
        if f.exists():
            return str(f)
    return None


def find_onlyoffice():
    """Cartella dell'editor ONLYOFFICE senza server (inclusa nel pacchetto, oppure in %USERPROFILE%\\.mbvisual\\onlyoffice per lo sviluppo)."""
    for d in (RES_DIR / "onlyoffice", Path.home() / ".mbvisual" / "onlyoffice"):
        if (d / "editor.html").exists():
            return d
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
        "onlyoffice": find_onlyoffice(),
        "nwdreader": find_nwd2mbv(),
    }
