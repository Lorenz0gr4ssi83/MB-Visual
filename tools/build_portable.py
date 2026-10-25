"""Crea la versione portatile di MB Desk (cartella con "MB Desk.exe", nessuna installazione richiesta).

Uso:  C:\\Users\\<utente>\\.mbvisual\\venv\\Scripts\\python.exe tools\\build_portable.py
Risultato: C:\\Users\\<utente>\\.mbvisual\\dist\\MB Desk\\  +  "MB Desk - portatile.zip" (stessa cartella dist, fuori da OneDrive),
poi copia incrementale in "App per PC" (solo i file cambiati).
La compilazione avviene fuori da OneDrive (migliaia di file); nel progetto finisce solo lo zip.
"""
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORK = Path.home() / ".mbvisual"
DIST = WORK / "dist"
NAME = "MB Desk"
EXE = "MB Desk.exe"
BRIDGE_EXE = "MBVisual.exe"  # nome dell'eseguibile prima del 25/10/2026 (solo in "App per PC", per gli aggiornamenti)
PUBLISH = ROOT / "App per PC"  # cartella su OneDrive da cui gli altri PC si aggiornano (mbvisual/update.py)


def publish(final: Path, info: dict) -> None:
    """Copia la build in "App per PC"; versione.json per ultimo, quando tutti i file sono gia' al loro posto."""
    sys.path.insert(0, str(ROOT / "tools"))
    from synctree import sync_tree
    PUBLISH.mkdir(exist_ok=True)
    (PUBLISH / "versione.json").unlink(missing_ok=True)
    # solo i file con contenuto cambiato: OneDrive ricarica pochi MB invece di 1 GB a ogni versione
    st = sync_tree(final, PUBLISH, keep=("MBVisual.lnk", BRIDGE_EXE))
    # ponte per le copie precedenti al cambio di nome: il loro aggiornamento da OneDrive cerca e copia "MBVisual.exe"
    # (lo stesso eseguibile; all'avvio l'app crea "MB Desk.exe" e rifa' i collegamenti, vedi update.migrate_exe_name)
    shutil.copy2(final / EXE, PUBLISH / BRIDGE_EXE)
    print("Copia in App per PC:", st)
    (PUBLISH / "versione.json").write_text(json.dumps(info, ensure_ascii=False, indent=1), encoding="utf-8")
    print("Pubblicata in", PUBLISH, info)
    # app per telefono della stessa versione sul server delle licenze (tools/publish_web.py): i telefoni si aggiornano con i PC
    if "--no-web" not in sys.argv:
        r = subprocess.run([sys.executable, str(ROOT / "tools" / "publish_web.py")], cwd=ROOT)
        if r.returncode:
            print("ATTENZIONE: app per telefono NON pubblicata: rilanciare python tools/publish_web.py")
    # setup della stessa versione nella cartella Google Drive di distribuzione, i precedenti in "Old" (tools/publish_drive.py)
    if "--no-drive" not in sys.argv:
        ver = info.get("versione", "")
        files = [f for f in (DIST / f"MBDesk-Setup-{ver}.exe", DIST / f"MBDesk-{ver}-mac.dmg",
                             Path.home() / "OneDrive" / "Desktop" / "MB Desk" / f"MBDesk-{ver}-mac.dmg") if f.is_file()]
        files = list({f.name: f for f in files}.values())
        if not files:
            print("ATTENZIONE: nessun setup", ver, "da caricare su Google Drive (prima tools/build_setup.py)")
        elif subprocess.run([sys.executable, str(ROOT / "tools" / "publish_drive.py"), *map(str, files)], cwd=ROOT).returncode:
            print("ATTENZIONE: setup NON caricato su Google Drive: rilanciare python tools/publish_drive.py", *[f.name for f in files])


def main() -> int:
    if "--solo-pubblica" in sys.argv:  # ripete solo la copia in App per PC dell'ultima build
        final = DIST / NAME
        info = json.loads((final / "_internal" / "build.json").read_text(encoding="utf-8"))
        files = [p for p in (final / "_internal").rglob("*") if p.is_file()]
        info.update(file=len(files), byte=sum(p.stat().st_size for p in files))
        publish(final, info)
        return 0
    sys.path.insert(0, str(ROOT / "tools"))
    import cloud_secrets
    cloud_secrets.write(ROOT)  # ID dei client OAuth (Accedi con Google), fuori da git
    import imageio_ffmpeg
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    sep = os.pathsep
    args = [
        sys.executable, "-m", "PyInstaller", str(ROOT / "app.py"),
        "--noconfirm", "--clean", "--windowed", "--onedir",
        "--name", NAME, "--icon", str(ROOT / "app.ico"),
        "--distpath", str(WORK / "pyi-dist"), "--workpath", str(WORK / "build"), "--specpath", str(WORK),
        "--add-data", f"{ROOT / 'ui'}{sep}ui",
        "--add-data", f"{ROOT / 'bin'}{sep}bin",
        "--add-data", f"{ROOT / 'app.ico'}{sep}.",
        "--add-binary", f"{ffmpeg}{sep}bin",
        "--collect-all", "webview", "--collect-all", "pillow_heif", "--collect-all", "rawpy",
        "--collect-all", "extract_msg", "--collect-all", "html2docx", "--collect-submodules", "pptx",
        "--collect-data", "pptx", "--collect-data", "docx",
        "--hidden-import", "clr", "--hidden-import", "asn1crypto", "--hidden-import", "mbvisual.pdftools", "--collect-submodules", "pypdf",
        # firma digitale PAdES/CAdES (pyHanko, MIT) con smart card via CNG (winsign.py)
        "--hidden-import", "mbvisual.cloud_ids_build", "--hidden-import", "mbvisual.firma", "--hidden-import", "mbvisual.winsign", "--hidden-import", "mbvisual.csc", "--hidden-import", "mbvisual.firmaponte", "--collect-submodules", "pyhanko.sign", "--collect-submodules", "pyhanko.pdf_utils", "--collect-submodules", "pyhanko.stamp", "--collect-data", "pyhanko", "--collect-submodules", "pyhanko_certvalidator", "--hidden-import", "win32crypt",
        # editor PDF (PyMuPDF) e conversione PDF -> Word
        "--hidden-import", "mbvisual.pdfedit", "--hidden-import", "mbvisual.pdfobjects", "--collect-all", "pymupdf", "--collect-submodules", "pdf2docx", "--collect-data", "pdf2docx",
        # convertitore universale (Office via automazione COM, markdown, openpyxl, fontTools)
        "--hidden-import", "mbvisual.convert", "--hidden-import", "win32com.client", "--hidden-import", "pythoncom",
        "--collect-submodules", "markdown", "--hidden-import", "openpyxl", "--hidden-import", "brotli",
        # editor CAD (ezdxf) e OCR con il motore di Windows (winrt)
        "--hidden-import", "mbvisual.cadedit", "--hidden-import", "mbvisual.todrawing", "--hidden-import", "mbvisual.pdfvec", "--hidden-import", "mbvisual.rastervec", "--hidden-import", "mbvisual.update", "--collect-all", "ezdxf", "--exclude-module", "winrt",
        "--add-data", f"{ROOT / 'mbvisual' / 'ocr.ps1'}{sep}mbvisual",
        # nuvole di punti: LAS/LAZ (laspy + lazrs, caricato da laspy solo al bisogno) ed E57 (pye57 con la DLL di Xerces)
        "--hidden-import", "mbvisual.pointcloud", "--collect-submodules", "laspy", "--hidden-import", "lazrs",
        "--collect-all", "pye57", "--hidden-import", "pyquaternion",
        "--hidden-import", "mbvisual.link", "--hidden-import", "win32clipboard",  # collegamento con il telefono
        "--hidden-import", "mbvisual.search", "--hidden-import", "mbvisual.search_extract", "--hidden-import", "olefile",  # ricerca nel progetto
        # formati aggiuntivi (mbvisual/formati.py): DICOM (pydicom + GDCM), HDF5 (h5py), Parquet/Arrow (pyarrow), Revit (olefile)
        "--hidden-import", "mbvisual.formati", "--hidden-import", "mbvisual.fx_dicom", "--hidden-import", "mbvisual.fx_cert",
        "--hidden-import", "mbvisual.fx_sci", "--hidden-import", "mbvisual.fx_iwork", "--hidden-import", "mbvisual.fx_revit",
        "--collect-submodules", "pydicom", "--collect-all", "gdcm", "--collect-submodules", "h5py", "--collect-submodules", "pyarrow", "--hidden-import", "olefile",
        "--exclude-module", "tkinter", "--exclude-module", "matplotlib",
        # moduli opzionali di PyMuPDF non usati (onnxruntime va in crash durante l analisi su Windows ARM)
        "--exclude-module", "onnxruntime", "--exclude-module", "pymupdf4llm", "--exclude-module", "pymupdf.layout", "--exclude-module", "pymupdf_layout",
    ]
    print(" ".join(args))
    subprocess.run(args, check=True)
    out = WORK / "pyi-dist" / NAME
    # ffmpeg con nome fisso, cercato da paths.find_ffmpeg
    internal_bin = out / "_internal" / "bin"
    for f in internal_bin.glob("ffmpeg-*.exe"):
        f.replace(internal_bin / "ffmpeg.exe")
    # editor ONLYOFFICE senza server (circa 500 MB): costruito da github.com/ranuts/document in %USERPROFILE%\.mbvisual\onlyoffice
    oo = Path.home() / ".mbvisual" / "onlyoffice"
    if (oo / "editor.html").exists():
        shutil.copytree(oo, out / "_internal" / "onlyoffice")
    else:
        print("ATTENZIONE: ONLYOFFICE non trovato in", oo, "- Word/Excel/PowerPoint useranno gli editor semplici")
    # lettore Navisworks (nwd2mbv.exe) se compilato
    nav = Path.home() / ".mbvisual" / "nwd" / "nwd2mbv.exe"
    if nav.exists():
        shutil.copy2(nav, internal_bin / "nwd2mbv.exe")
    # versione e data della build: l'app la confronta con versione.json della cartella pubblicata
    version = re.search(r'^VERSION = "([^"]+)"', (ROOT / "app.py").read_text(encoding="utf-8"), re.M).group(1)
    info = {"versione": version, "build": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
    (out / "_internal" / "build.json").write_text(json.dumps(info), encoding="utf-8")
    final = DIST / NAME
    if final.exists():
        shutil.rmtree(final)
    out.rename(final)
    (final / "LEGGIMI.txt").write_text(
        "MB Desk - versione portatile\r\n\r\n"
        "1. Copia questa cartella dove vuoi (per esempio sul Desktop).\r\n"
        "2. Avvia MB Desk.exe con un doppio clic.\r\n"
        "3. Trascina i file nella finestra, oppure usa 'Apri'.\r\n\r\n"
        "Non serve installare nulla. Opzionali, se presenti sul PC vengono usati in automatico:\r\n"
        "- LibreOffice (doc, ppt, odt, rtf e altri formati Office meno comuni)\r\n"
        "- Autodesk Navisworks Freedom (nwd, nwc, nwf)\r\n"
        "- Autodesk DWG TrueView (apertura esterna dei DWG)\r\n\r\n"
        "Aggiornamenti: all'avvio l'app controlla la cartella 'App per PC' su OneDrive e propone le versioni nuove.\r\n"
        "Consigliato: dal menu Apri scegli 'Installa su questo PC' (collegamenti su Desktop e menu Start).\r\n", encoding="utf-8")
    files = [p for p in (final / "_internal").rglob("*") if p.is_file()]
    info.update(file=len(files), byte=sum(p.stat().st_size for p in files))
    zpath = DIST / f"{NAME} - portatile.zip"  # fuori da OneDrive: 450 MB riscritti a ogni build
    if zpath.exists():
        zpath.unlink()
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in final.rglob("*"):
            if p.is_file():
                z.write(p, Path(NAME) / p.relative_to(final))
    size = sum(p.stat().st_size for p in final.rglob("*") if p.is_file())
    print(f"Cartella: {final}  ({size / 1048576:.0f} MB)")
    print(f"Zip: {zpath}  ({zpath.stat().st_size / 1048576:.0f} MB)")
    if "--no-publish" not in sys.argv:
        publish(final, info)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
