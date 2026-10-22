"""Crea MBVisual-Setup-<versione>.exe dall'app gia' costruita (tools/build_portable.py) con Inno Setup 6.

Uso: %USERPROFILE%\\.mbvisual\\venv\\Scripts\\python.exe tools\\build_setup.py
Risultato: %USERPROFILE%\\.mbvisual\\dist\\MBVisual-Setup-<versione>.exe (fuori da OneDrive)
"""
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = Path.home() / ".mbvisual" / "dist"
APP = DIST / "MB Visual"


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
    cmd = [str(iscc()), f"/DAppVersion={ver}", f"/DSourceDir={APP}", f"/DOutDir={DIST}", "/Q", str(ROOT / "installer" / "mbvisual.iss")]
    subprocess.run(cmd, check=True)
    out = DIST / f"MBVisual-Setup-{ver}.exe"
    print(f"Pronto: {out} ({out.stat().st_size / 1048576:.0f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
