"""Aggiornamento automatico dell'app per PC dalla cartella "App per PC" sincronizzata con OneDrive.

La build (tools/build_portable.py) scrive:
  _internal/build.json  versione e data della build contenuta nell'eseguibile
  versione.json         nella cartella pubblicata, scritto per ultimo: versione, build, numero e peso dei file di _internal
All'avvio l'app cerca la cartella pubblicata sul PC (OneDrive aziendale, anche con nomi diversi) e confronta le build.
Se c'e' una build piu' recente e OneDrive l'ha scaricata tutta (numero e peso dei file tornano), propone di aggiornare:
uno script PowerShell aspetta la chiusura dell'app, copia i file nuovi nella cartella dell'app e la riavvia.
Chi avvia l'app direttamente dalla cartella OneDrive puo' installarla sul PC (%LOCALAPPDATA%\\Programs\\MB Visual):
la copia installata si aggiorna da sola e non risente delle sincronizzazioni a meta'.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from .paths import APP_DIR, RES_DIR

FROZEN = bool(getattr(sys, "frozen", False))
REL = Path("ai-engineering-workspace") / "MB Visual" / "App per PC"
SETTINGS = Path(os.environ.get("LOCALAPPDATA", tempfile.gettempdir())) / "MBVisual" / "aggiornamenti.json"
INSTALL_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Programs" / "MB Visual"
LOG = Path(tempfile.gettempdir()) / "MBVisual-aggiornamento.log"


def _read_json(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def current() -> dict:
    """Versione e build in uso."""
    b = _read_json(RES_DIR / "build.json")
    if b:
        return b
    m = re.search(r'^VERSION = "([^"]+)"', (APP_DIR / "app.py").read_text(encoding="utf-8"), re.M) if (APP_DIR / "app.py").exists() else None
    return {"versione": m.group(1) if m else "?", "build": "sviluppo" if not FROZEN else "?"}


def _settings() -> dict:
    return _read_json(SETTINGS) or {}


def set_source(folder: str) -> dict:
    p = Path(folder)
    if not (p / "versione.json").is_file():
        raise ValueError("In questa cartella non c'e' una versione pubblicata di MB Visual (manca versione.json)")
    SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS.write_text(json.dumps({**_settings(), "fonte": str(p)}), encoding="utf-8")
    return check()


def _candidates():
    """Cartelle "App per PC" possibili su questo PC (OneDrive personale/aziendale, librerie SharePoint sincronizzate)."""
    seen = set()
    s = _settings().get("fonte")
    if s:
        yield Path(s)
    roots = [os.environ.get(k) for k in ("OneDriveCommercial", "OneDrive", "OneDriveConsumer")]
    home = Path.home()
    try:
        roots += [str(p) for p in home.iterdir() if p.is_dir() and (p.name.startswith("OneDrive") or p.name == "MB Engineering srl")]
    except OSError:
        pass
    for r in roots:
        if not r or r in seen:
            continue
        seen.add(r)
        root = Path(r)
        yield root / REL
        # cartella condivisa aggiunta come collegamento o sincronizzata con un altro nome
        try:
            for sub in root.iterdir():
                if sub.is_dir():
                    yield sub / "MB Visual" / "App per PC"
                    yield sub / REL
        except OSError:
            pass


def _manifest_ok(src: Path, man: dict) -> bool:
    """Tutti i file della build sono gia' arrivati (OneDrive puo' essere ancora a meta' sincronizzazione)."""
    n, size = 0, 0
    for dp, _dn, fn in os.walk(src / "_internal"):
        for f in fn:
            try:
                size += os.path.getsize(os.path.join(dp, f))
                n += 1
            except OSError:
                pass
    return n == man.get("file") and size == man.get("byte") and (src / "MBVisual.exe").is_file()


def _same(a: Path, b: Path) -> bool:
    try:
        return a.resolve() == b.resolve()
    except OSError:
        return False


def check() -> dict:
    cur = current()
    res = {"ok": True, "attuale": cur, "stato": "aggiornato", "fonte": None, "da_onedrive": False, "installabile": FROZEN, "cartella": str(APP_DIR)}
    if not FROZEN:
        res["stato"] = "sviluppo"
        return res
    # app avviata direttamente dalla cartella pubblicata su OneDrive
    own = _read_json(APP_DIR / "versione.json")
    if own:
        res["da_onedrive"] = True
        res["fonte"] = str(APP_DIR)
        if own.get("build") != cur.get("build"):
            res.update(stato="sincronizzazione", disponibile=own)
        return res
    best = None
    for c in _candidates():
        man = _read_json(c / "versione.json")
        if man and man.get("build") and (best is None or man["build"] > best[1]["build"]):
            best = (c, man)
    if not best:
        res["stato"] = "nessuna_fonte"
        return res
    src, man = best
    res["fonte"] = str(src)
    if str(man["build"]) > str(cur.get("build", "")):
        res["disponibile"] = man
        res["stato"] = "nuova" if _manifest_ok(src, man) else "sincronizzazione"
    return res


def _launch(script: str):
    p = Path(tempfile.gettempdir()) / "MBVisual-aggiorna.ps1"
    p.write_text(script, encoding="utf-8-sig")
    flags = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
    subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", str(p)],
                     creationflags=flags, close_fds=True)
    # l'app si chiude subito dopo aver risposto all'interfaccia; lo script attende la chiusura e copia i file
    threading.Timer(1.0, lambda: os._exit(0)).start()


def _ps(s) -> str:
    return "'" + str(s).replace("'", "''") + "'"


def _copy_script(src: Path, dst: Path, shortcuts: bool) -> str:
    # _internal viene allineata con /MIR (solo li' dentro si cancellano file); in cima si copiano solo i file dell'app
    lines = [
        "$ErrorActionPreference = 'Continue'",
        f"$log = {_ps(LOG)}",
        f"\"$(Get-Date) aggiornamento da {src} a {dst}\" | Out-File $log -Encoding utf8",
        f"Wait-Process -Id {os.getpid()} -Timeout 60 -ErrorAction SilentlyContinue",
        "Start-Sleep -Milliseconds 800",
        f"New-Item -ItemType Directory -Force -Path {_ps(dst)} | Out-Null",
        f"robocopy {_ps(src / '_internal')} {_ps(dst / '_internal')} /MIR /R:3 /W:2 /NP /NFL /NDL | Out-File $log -Append -Encoding utf8",
        "$rc1 = $LASTEXITCODE",
        f"robocopy {_ps(src)} {_ps(dst)} MBVisual.exe LEGGIMI.txt /R:3 /W:2 /NP /NFL /NDL | Out-File $log -Append -Encoding utf8",
        "$rc2 = $LASTEXITCODE",
        "\"esito robocopy: $rc1 $rc2\" | Out-File $log -Append -Encoding utf8",
        "if ($rc1 -ge 8 -or $rc2 -ge 8) {",
        "  Add-Type -AssemblyName PresentationFramework",
        f"  [System.Windows.MessageBox]::Show(\"Aggiornamento di MB Visual non riuscito (file in uso o non scaricati da OneDrive). Dettagli in $log\", 'MB Visual') | Out-Null",
        "}",
    ]
    if shortcuts:
        exe = dst / "MBVisual.exe"
        lines += [
            "$sh = New-Object -ComObject WScript.Shell",
            "foreach ($d in @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('Programs')) ''))) {",
            "  $l = $sh.CreateShortcut((Join-Path $d 'MB Visual.lnk'))",
            f"  $l.TargetPath = {_ps(exe)}; $l.WorkingDirectory = {_ps(dst)}; $l.IconLocation = {_ps(str(exe) + ',0')}; $l.Description = 'MB Visual'",
            "  $l.Save()",
            "}",
        ]
    lines.append(f"Start-Process -FilePath {_ps(dst / 'MBVisual.exe')}")
    return "\r\n".join(lines) + "\r\n"


def apply() -> dict:
    """Aggiorna la cartella dell'app con la build piu' recente e la riavvia."""
    r = check()
    if r["stato"] != "nuova":
        raise ValueError({"sincronizzazione": "OneDrive sta ancora scaricando la nuova versione: riprova tra qualche minuto",
                          "aggiornato": "Hai gia' l'ultima versione"}.get(r["stato"], "Nessun aggiornamento disponibile"))
    src = Path(r["fonte"])
    if _same(src, APP_DIR):
        raise ValueError("L'app e' avviata dalla cartella di OneDrive: si aggiorna con la sincronizzazione")
    if not ((APP_DIR / "_internal").is_dir() and (APP_DIR / "MBVisual.exe").is_file()):
        raise ValueError("Cartella dell'app non riconosciuta: aggiornamento annullato per sicurezza")
    _launch(_copy_script(src, APP_DIR, shortcuts=False))
    return {"ok": True, "versione": r["disponibile"]}


def install() -> dict:
    """Installa l'app su questo PC (cartella locale + collegamenti su Desktop e menu Start) e la avvia da li'."""
    if not FROZEN:
        raise ValueError("Disponibile solo nell'app per PC")
    r = check()
    if r["stato"] == "sincronizzazione":
        raise ValueError("OneDrive sta ancora scaricando la nuova versione: riprova tra qualche minuto")
    src = Path(r["fonte"]) if r.get("fonte") and r["stato"] in ("nuova", "aggiornato") else APP_DIR
    if not (src / "_internal").is_dir():
        src = APP_DIR
    if _same(src, INSTALL_DIR):
        raise ValueError("L'app e' gia' installata su questo PC")
    _launch(_copy_script(src, INSTALL_DIR, shortcuts=True))
    return {"ok": True, "cartella": str(INSTALL_DIR)}
