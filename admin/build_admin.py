"""Crea l'eseguibile di MB Visual Admin in %USERPROFILE%\\.mbvisual\\dist\\MB Visual Admin (fuori da OneDrive).

Uso: %USERPROFILE%\\.mbvisual\\venv\\Scripts\\python.exe admin\\build_admin.py
Poi: avviare "MB Visual Admin.exe" e, in Impostazioni, scegliere "Avvia con Windows".
"""
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORK = Path.home() / ".mbvisual"


def main() -> int:
    sep = ";"
    args = [sys.executable, "-m", "PyInstaller", str(HERE / "admin.py"), "--noconfirm", "--clean", "--windowed", "--onedir",
            "--name", "MB Visual Admin", "--icon", str(HERE / "admin.ico"),
            "--distpath", str(WORK / "dist"), "--workpath", str(WORK / "build-admin"), "--specpath", str(WORK),
            "--add-data", f"{HERE / 'ui'}{sep}ui", "--add-data", f"{HERE / 'admin.ico'}{sep}.",
            "--collect-all", "webview", "--hidden-import", "pystray._win32", "--hidden-import", "win32com.client",
            "--exclude-module", "tkinter", "--exclude-module", "matplotlib", "--exclude-module", "pymupdf", "--exclude-module", "onnxruntime"]
    subprocess.run(args, check=True)
    out = WORK / "dist" / "MB Visual Admin"
    print("Pronto:", out / "MB Visual Admin.exe", f"({sum(p.stat().st_size for p in out.rglob('*') if p.is_file()) / 1048576:.0f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
