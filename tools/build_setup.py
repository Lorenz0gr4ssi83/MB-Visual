"""Crea MBDesk-Setup-<versione>.exe dall'app gia' costruita (tools/build_portable.py) con Inno Setup 6.

Uso: %USERPROFILE%\\.mbvisual\\venv\\Scripts\\python.exe tools\\build_setup.py
Risultato: %USERPROFILE%\\.mbvisual\\dist\\MBDesk-Setup-<versione>.exe (fuori da OneDrive) + la stessa copia con il nome
vecchio MBVisual-Setup-<versione>.exe, da caricare SOLO nella release GitHub (le copie precedenti al cambio di nome cercano quello)
Con --out <cartella> il setup va li' (prove delle pagine senza toccare quello da pubblicare).
"""
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = Path.home() / ".mbvisual" / "dist"
APP = DIST / "MB Desk"


def iscc() -> Path:
    for c in (Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Inno Setup 6" / "ISCC.exe",
              Path(os.environ.get("ProgramFiles(x86)", "")) / "Inno Setup 6" / "ISCC.exe"):
        if c.is_file():
            return c
    raise SystemExit("Inno Setup 6 non trovato (winget install JRSoftware.InnoSetup)")


def main() -> int:
    info = json.loads((APP / "_internal" / "build.json").read_text(encoding="utf-8"))
    # attivita' "Integra con Esplora risorse" dell'installazione: servono le DLL di tools/mbvshell (ARM64 e x64)
    for arch in ("arm64", "x64"):
        if not (APP / "_internal" / "bin" / "shell" / f"mbvshell-{arch}.dll").is_file():
            print(f"Attenzione: manca bin\\shell\\mbvshell-{arch}.dll (tools\\mbvshell\\build.cmd): niente miniature in Esplora")
    ver = info["versione"]
    # pagina dei componenti: icone, immagini e testi dal registro ui/components.json (stesso Python: Pillow e PyMuPDF)
    art = DIST / "setup-art"
    subprocess.run([sys.executable, str(ROOT / "tools" / "make_setup_art.py"), str(art)], check=True)
    dest = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else DIST
    cmd = [str(iscc()), f"/DAppVersion={ver}", f"/DSourceDir={APP}", f"/DArtDir={art}", f"/DOutDir={dest}", "/Q", str(ROOT / "installer" / "mbvisual.iss")]
    subprocess.run(cmd, check=True)
    out = dest / f"MBDesk-Setup-{ver}.exe"
    print(f"Pronto: {out} ({out.stat().st_size / 1048576:.0f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
