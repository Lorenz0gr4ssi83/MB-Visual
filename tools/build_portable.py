"""Crea la versione portatile di MB Visual (cartella con MBVisual.exe, nessuna installazione richiesta).

Uso:  C:\\Users\\<utente>\\.mbvisual\\venv\\Scripts\\python.exe tools\\build_portable.py
Risultato: C:\\Users\\<utente>\\.mbvisual\\dist\\MB Visual\\  +  "MB Visual - portatile.zip" nella cartella del progetto.
La compilazione avviene fuori da OneDrive (migliaia di file); nel progetto finisce solo lo zip.
"""
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORK = Path.home() / ".mbvisual"
DIST = WORK / "dist"
NAME = "MB Visual"


def main() -> int:
    import imageio_ffmpeg
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    sep = os.pathsep
    args = [
        sys.executable, "-m", "PyInstaller", str(ROOT / "app.py"),
        "--noconfirm", "--clean", "--windowed", "--onedir",
        "--name", "MBVisual", "--icon", str(ROOT / "app.ico"),
        "--distpath", str(DIST), "--workpath", str(WORK / "build"), "--specpath", str(WORK),
        "--add-data", f"{ROOT / 'ui'}{sep}ui",
        "--add-data", f"{ROOT / 'bin'}{sep}bin",
        "--add-data", f"{ROOT / 'app.ico'}{sep}.",
        "--add-binary", f"{ffmpeg}{sep}bin",
        "--collect-all", "webview", "--collect-all", "pillow_heif", "--collect-all", "rawpy",
        "--collect-all", "extract_msg", "--collect-all", "html2docx", "--collect-submodules", "pptx",
        "--collect-data", "pptx", "--collect-data", "docx",
        "--hidden-import", "clr", "--hidden-import", "asn1crypto", "--hidden-import", "mbvisual.pdftools", "--collect-submodules", "pypdf",
        "--exclude-module", "tkinter", "--exclude-module", "matplotlib",
    ]
    print(" ".join(args))
    subprocess.run(args, check=True)
    out = DIST / "MBVisual"
    # ffmpeg con nome fisso, cercato da paths.find_ffmpeg
    internal_bin = out / "_internal" / "bin"
    for f in internal_bin.glob("ffmpeg-*.exe"):
        f.replace(internal_bin / "ffmpeg.exe")
    final = DIST / NAME
    if final.exists():
        shutil.rmtree(final)
    out.rename(final)
    (final / "LEGGIMI.txt").write_text(
        "MB Visual - versione portatile\r\n\r\n"
        "1. Copia questa cartella dove vuoi (per esempio sul Desktop).\r\n"
        "2. Avvia MBVisual.exe con un doppio clic.\r\n"
        "3. Trascina i file nella finestra, oppure usa 'Apri'.\r\n\r\n"
        "Non serve installare nulla. Opzionali, se presenti sul PC vengono usati in automatico:\r\n"
        "- LibreOffice (doc, ppt, odt, rtf e altri formati Office meno comuni)\r\n"
        "- Autodesk Navisworks Freedom (nwd, nwc, nwf)\r\n"
        "- Autodesk DWG TrueView (apertura esterna dei DWG)\r\n", encoding="utf-8")
    zpath = ROOT / f"{NAME} - portatile.zip"
    if zpath.exists():
        zpath.unlink()
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in final.rglob("*"):
            if p.is_file():
                z.write(p, Path(NAME) / p.relative_to(final))
    size = sum(p.stat().st_size for p in final.rglob("*") if p.is_file())
    print(f"Cartella: {final}  ({size / 1048576:.0f} MB)")
    print(f"Zip: {zpath}  ({zpath.stat().st_size / 1048576:.0f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
