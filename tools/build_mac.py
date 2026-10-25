"""Crea l'app per Mac: "MB Desk.app" (PyInstaller) e il disco "MBDesk-<versione>-mac.dmg".

Uso (solo su macOS, Apple Silicon):  python3 tools/build_mac.py [--out CARTELLA] [--no-dmg]
Su GitHub lo esegue il workflow .github/workflows/build-mac.yml (runner macos-14, arm64).
Prima: pip install -r requirements.txt  e  python tools/fetch_vendor.py (librerie JS in ui/vendor).

Cosa entra nel pacchetto, oltre al codice Python e a ui/:
- bin/7zip/7zz       7-Zip ufficiale per macOS (scaricato qui, versione fissa SEVENZIP)
- bin/ffmpeg         FFmpeg di imageio-ffmpeg
- bin/mbvocr         OCR con il framework Vision (tools/mbvocr/mbvocr.swift compilato con swiftc)
- bin/nwd2mbv        lettore Navisworks, se compilato prima con tools/nwd2mbv/build_mac.sh (~/.mbvisual/nwd/nwd2mbv)
- onlyoffice/        editor ONLYOFFICE, se presente in ~/.mbvisual/onlyoffice (stessi file statici della versione Windows)
L'app NON e' firmata con un certificato Apple (solo firma ad hoc): al primo avvio macOS chiede conferma
(clic destro sull'app -> Apri). Per la distribuzione servono firma Developer ID e notarizzazione (vedi CLAUDE.md).
"""
import datetime
import io
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))  # per controllare i moduli mbvisual.* (find_spec)
NAME = "MB Desk"
BUNDLE_ID = "it.mbengineering.mbvisual"
# 7-Zip per macOS (universale arm64/x64), licenza LGPL + restrizione unRAR: si distribuisce il solo eseguibile
SEVENZIP = "https://www.7-zip.org/a/7z2501-mac.tar.xz"


def _arg(name, default=None):
    if name in sys.argv:
        i = sys.argv.index(name)
        return sys.argv[i + 1] if i + 1 < len(sys.argv) else default
    return default


def run(args, **kw):
    print("+", " ".join(str(a) for a in args), flush=True)
    return subprocess.run([str(a) for a in args], check=True, **kw)


def fetch_7zz(dest: Path) -> None:
    cache = Path.home() / ".mbvisual" / "cache" / Path(SEVENZIP).name
    if not cache.is_file():
        cache.parent.mkdir(parents=True, exist_ok=True)
        print("Scarico", SEVENZIP, flush=True)
        with urllib.request.urlopen(urllib.request.Request(SEVENZIP, headers={"user-agent": "MBVisual-build"}), timeout=120) as r:
            cache.write_bytes(r.read())
    with tarfile.open(fileobj=io.BytesIO(cache.read_bytes()), mode="r:xz") as t:
        for m in t.getmembers():
            base = Path(m.name).name
            if m.isfile() and base in ("7zz", "License.txt", "readme.txt"):
                data = t.extractfile(m).read()
                (dest / base).write_bytes(data)
    (dest / "7zz").chmod(0o755)


def build_bin(stage: Path) -> Path:
    """Cartella bin per il Mac: solo eseguibili macOS (i .exe/.dll di Windows del progetto restano fuori)."""
    bin_dir = stage / "bin"
    shutil.rmtree(bin_dir, ignore_errors=True)
    (bin_dir / "7zip").mkdir(parents=True)
    fetch_7zz(bin_dir / "7zip")
    import imageio_ffmpeg
    shutil.copy2(imageio_ffmpeg.get_ffmpeg_exe(), bin_dir / "ffmpeg")
    (bin_dir / "ffmpeg").chmod(0o755)
    # stesso minimo dell'app (LSMinimumSystemVersion 12.0), non la versione del Mac che compila
    run(["swiftc", "-O", "-target", "arm64-apple-macos12.0", ROOT / "tools" / "mbvocr" / "mbvocr.swift", "-o", bin_dir / "mbvocr"])
    nav = Path.home() / ".mbvisual" / "nwd" / "nwd2mbv"
    if nav.is_file():
        shutil.copy2(nav, bin_dir / "nwd2mbv")
    else:
        print("ATTENZIONE: nwd2mbv non compilato (tools/nwd2mbv/build_mac.sh): NWD/NWC solo con il modello federato")
    # sui Mac Apple Silicon un eseguibile senza firma non parte: almeno la firma ad hoc
    for exe in (bin_dir / "7zip" / "7zz", bin_dir / "ffmpeg", bin_dir / "mbvocr", bin_dir / "nwd2mbv"):
        if exe.is_file():
            run(["codesign", "--force", "--sign", "-", exe])
    return bin_dir


def _optional_collect(items) -> list:
    """Argomenti di PyInstaller solo per i pacchetti installati (alcuni non hanno ruote per macOS arm64: la build va avanti
    e il formato relativo resta non disponibile, come gia' gestito dall'app)."""
    import importlib.util
    args = []
    for mod, how in items:
        if importlib.util.find_spec(mod) is None:
            print("ATTENZIONE: modulo non installato, escluso:", mod)
            continue
        args += {"all": ["--collect-all", mod], "submodules": ["--collect-submodules", mod]}.get(how, ["--hidden-import", mod])
    return args


def main() -> int:
    if sys.platform != "darwin":
        print("tools/build_mac.py va eseguito su macOS (in automatico: workflow GitHub build-mac.yml)")
        return 1
    out_dir = Path(_arg("--out") or Path.home() / ".mbvisual" / "dist-mac").resolve()
    work = Path.home() / ".mbvisual" / "build-mac"
    stage = work / "stage"
    stage.mkdir(parents=True, exist_ok=True)
    if not (ROOT / "ui" / "vendor").is_dir():
        print("Mancano le librerie JS: python tools/fetch_vendor.py")
        return 1

    version = re.search(r'^VERSION = "([^"]+)"', (ROOT / "app.py").read_text(encoding="utf-8"), re.M).group(1)
    info = {"versione": version, "build": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "sistema": "macos"}
    (stage / "build.json").write_text(json.dumps(info), encoding="utf-8")
    sys.path.insert(0, str(ROOT / "tools"))
    import cloud_secrets
    cloud_secrets.write(ROOT)  # ID dei client OAuth (Accedi con Google): secret MBV_CLOUD_IDS del workflow
    bin_dir = build_bin(stage)

    sep = os.pathsep
    args = [
        sys.executable, "-m", "PyInstaller", ROOT / "app.py",
        "--noconfirm", "--clean", "--windowed", "--onedir", "--argv-emulation",
        "--name", NAME, "--osx-bundle-identifier", BUNDLE_ID, "--icon", ROOT / "app.ico",
        "--distpath", work / "dist", "--workpath", work / "build", "--specpath", work,
        "--add-data", f"{ROOT / 'ui'}{sep}ui",
        # eseguibili come binari (Contents/Frameworks/bin, firmati con l'app), il resto come dati
        *[x for f in sorted(bin_dir.rglob("*")) if f.is_file()
          for x in (("--add-binary" if os.access(f, os.X_OK) else "--add-data"), f"{f}{sep}{f.parent.relative_to(stage).as_posix()}")],
        "--add-data", f"{stage / 'build.json'}{sep}.",
        "--collect-all", "webview", "--collect-all", "pillow_heif", "--collect-all", "rawpy",
        "--collect-all", "extract_msg", "--collect-all", "html2docx", "--collect-submodules", "pptx",
        "--collect-data", "pptx", "--collect-data", "docx",
        "--hidden-import", "asn1crypto", "--hidden-import", "mbvisual.pdftools", "--collect-submodules", "pypdf",
        # firma digitale (pyHanko): sul Mac file .p12 e firma remota CSC; segreti nel Portachiavi (mbvisual/secret.py)
        "--hidden-import", "mbvisual.cloud_ids_build", "--hidden-import", "mbvisual.firma", "--hidden-import", "mbvisual.winsign", "--hidden-import", "mbvisual.csc",
        "--hidden-import", "mbvisual.firmaponte", "--hidden-import", "mbvisual.secret", "--collect-submodules", "pyhanko.sign",
        "--collect-submodules", "pyhanko.pdf_utils", "--collect-submodules", "pyhanko.stamp", "--collect-data", "pyhanko",
        "--collect-submodules", "pyhanko_certvalidator",
        # stampa con CUPS
        "--hidden-import", "mbvisual.stampa", "--hidden-import", "mbvisual.stampa_cups", "--hidden-import", "mbvisual.windialog",
        "--hidden-import", "mbvisual.pdfedit", "--hidden-import", "mbvisual.pdfobjects", "--collect-all", "pymupdf",
        "--collect-submodules", "pdf2docx", "--collect-data", "pdf2docx",
        "--hidden-import", "mbvisual.convert", "--hidden-import", "mbvisual.fonts",
        "--collect-submodules", "markdown", "--hidden-import", "openpyxl", "--hidden-import", "brotli",
        "--hidden-import", "mbvisual.cadedit", "--hidden-import", "mbvisual.update", "--collect-all", "ezdxf",
        # tutti i moduli dell'app (anche quelli caricati solo al bisogno: posta, recupero file, misure, DXF da PDF)
        "--collect-submodules", "mbvisual", "--collect-data", "tzdata",
        # nuvole di punti, ricerca nel progetto, formati aggiuntivi (stessi moduli della build Windows)
        *_optional_collect([("mbvisual.pointcloud", None), ("laspy", "submodules"), ("lazrs", None), ("pye57", "all"),
                            ("pyquaternion", None), ("mbvisual.search", None), ("mbvisual.search_extract", None), ("olefile", None),
                            ("mbvisual.formati", None), ("mbvisual.fx_dicom", None), ("mbvisual.fx_cert", None), ("mbvisual.fx_sci", None),
                            ("mbvisual.fx_iwork", None), ("mbvisual.fx_revit", None), ("pydicom", "submodules"), ("gdcm", "all"),
                            ("h5py", "submodules"), ("pyarrow", "submodules")]),
        "--exclude-module", "tkinter", "--exclude-module", "matplotlib",
        "--exclude-module", "onnxruntime", "--exclude-module", "pymupdf4llm", "--exclude-module", "pymupdf.layout",
        "--exclude-module", "pymupdf_layout", "--exclude-module", "win32com", "--exclude-module", "pythoncom",
    ]
    oo = Path.home() / ".mbvisual" / "onlyoffice"
    if (oo / "editor.html").exists():
        args += ["--add-data", f"{oo}{sep}onlyoffice"]
    else:
        print("ATTENZIONE: ONLYOFFICE non trovato in", oo, "- Word/Excel/PowerPoint useranno gli editor semplici")
    run(args)

    app = work / "dist" / f"{NAME}.app"
    plist = app / "Contents" / "Info.plist"
    with open(plist, "rb") as f:
        pl = plistlib.load(f)
    pl.update({
        "CFBundleName": NAME, "CFBundleDisplayName": NAME,
        "CFBundleShortVersionString": version, "CFBundleVersion": version,
        "NSHighResolutionCapable": True, "LSMinimumSystemVersion": "12.0",
        "LSApplicationCategoryType": "public.app-category.productivity",
        "NSHumanReadableCopyright": "© MB Workshop Srl",
        # l'app apre qualunque file (Apri con...), senza diventare il programma predefinito
        "CFBundleDocumentTypes": [{"CFBundleTypeName": "Documento", "CFBundleTypeRole": "Editor",
                                   "LSHandlerRank": "Alternate", "LSItemContentTypes": ["public.item", "public.data"]}],
    })
    with open(plist, "wb") as f:
        plistlib.dump(pl, f)
    # Info.plist cambiato: la firma ad hoc di PyInstaller va rifatta (sui Mac Apple Silicon il codice non firmato non parte)
    run(["codesign", "--force", "--deep", "--sign", "-", app])

    out_dir.mkdir(parents=True, exist_ok=True)
    final = out_dir / f"{NAME}.app"
    shutil.rmtree(final, ignore_errors=True)
    run(["ditto", app, final])
    print("App:", final)
    # riserva se il .dmg non si crea: zip con ditto (conserva permessi, collegamenti e firma del pacchetto)
    zpath = out_dir / f"MBDesk-{version}-mac.zip"
    zpath.unlink(missing_ok=True)
    run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, zpath])
    print(f"Zip: {zpath}  ({zpath.stat().st_size / 1048576:.0f} MB)")
    if "--no-dmg" in sys.argv:
        return 0

    # disco con l'app, il collegamento ad Applicazioni e le istruzioni per il primo avvio
    dmg_src = work / "dmg"
    shutil.rmtree(dmg_src, ignore_errors=True)
    dmg_src.mkdir()
    run(["ditto", app, dmg_src / f"{NAME}.app"])
    (dmg_src / "Applications").symlink_to("/Applications")
    (dmg_src / "LEGGIMI.txt").write_text(
        f"MB Desk {version} per Mac (Apple Silicon)\n\n"
        "1. Trascina 'MB Desk' nella cartella Applications.\n"
        "2. Primo avvio: in Applicazioni fai clic destro su 'MB Desk' -> Apri -> Apri.\n"
        "   (Questa versione non e' ancora firmata da Apple: macOS chiede conferma una volta sola.)\n"
        "3. Trascina i file nella finestra, oppure usa 'Apri'.\n\n"
        "Opzionale: LibreOffice per Mac (formati Office meno comuni e conversioni).\n", encoding="utf-8")
    dmg = out_dir / f"MBDesk-{version}-mac.dmg"
    dmg.unlink(missing_ok=True)
    run(["hdiutil", "create", "-volname", f"{NAME} {version}", "-srcfolder", dmg_src, "-ov", "-format", "UDZO", dmg])
    print(f"Disco: {dmg}  ({dmg.stat().st_size / 1048576:.0f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
