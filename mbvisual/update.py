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


STAGING = Path(os.environ.get("LOCALAPPDATA", tempfile.gettempdir())) / "MBVisual" / "nuova-versione"


def _log(msg: str) -> None:
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            import datetime
            f.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S} {msg}\n")
    except OSError:
        pass


def _copy_app(src: Path, dst: Path, update=None) -> None:
    """Copia l'app (cartella _internal + MBVisual.exe + LEGGIMI.txt) con avanzamento.
    Leggere i file li scarica da OneDrive se sono "solo online": per questo serve l'avanzamento visibile.
    Salta i file gia' uguali (dimensione e data), toglie da _internal quelli che non esistono piu'."""
    files = []
    for dp, _dn, fn in os.walk(src / "_internal"):
        for n in fn:
            files.append(Path(dp) / n)
    files += [src / n for n in ("MBVisual.exe", "LEGGIMI.txt") if (src / n).is_file()]
    total = sum(f.stat().st_size for f in files) or 1
    done = 0
    wanted = set()
    import shutil
    for k, f in enumerate(files):
        rel = f.relative_to(src)
        wanted.add(rel.as_posix())
        d = dst / rel
        st = f.stat()
        try:
            ds = d.stat()
            same = ds.st_size == st.st_size and abs(ds.st_mtime - st.st_mtime) < 2
        except OSError:
            same = False
        if not same:
            d.parent.mkdir(parents=True, exist_ok=True)
            for attempt in range(3):
                try:
                    shutil.copy2(f, d)
                    break
                except OSError as e:
                    if attempt == 2:
                        raise OSError(f"Copia non riuscita di {rel}: {e}") from e
                    import time
                    time.sleep(1.5)
        done += st.st_size
        if update and (k % 25 == 0 or k == len(files) - 1):
            update(0.97 * done / total, f"Copia dei file: {done / 1048576:.0f} di {total / 1048576:.0f} MB")
    for dp, _dn, fn in os.walk(dst / "_internal", topdown=False):
        for n in fn:
            rel = (Path(dp) / n).relative_to(dst).as_posix()
            if rel not in wanted:
                try:
                    (Path(dp) / n).unlink()
                except OSError:
                    pass


def _shortcuts(exe: Path) -> None:
    """Collegamenti "MB Visual" sul Desktop e nel menu Start (senza script PowerShell)."""
    import pythoncom
    import win32com.client
    pythoncom.CoInitialize()
    try:
        sh = win32com.client.Dispatch("WScript.Shell")
        for folder in (sh.SpecialFolders("Desktop"), sh.SpecialFolders("Programs")):
            lnk = sh.CreateShortcut(str(Path(folder) / "MB Visual.lnk"))
            lnk.TargetPath = str(exe)
            lnk.WorkingDirectory = str(exe.parent)
            # icona da file .ico locale (se l'exe fosse un file OneDrive "solo online" Windows mostrerebbe un riquadro vuoto)
            ico = exe.parent / "_internal" / "app.ico"
            lnk.IconLocation = f"{ico},0" if ico.is_file() else f"{exe},0"
            lnk.Description = "MB Visual"
            lnk.Save()
    finally:
        pythoncom.CoUninitialize()


def _restart(exe: Path) -> None:
    flags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    subprocess.Popen([str(exe)], cwd=str(exe.parent), creationflags=flags, close_fds=True)
    threading.Timer(1.5, lambda: os._exit(0)).start()


def apply(update=None) -> dict:
    """Prepara la nuova versione in una cartella locale (con avanzamento), poi uno script di Windows la copia
    nella cartella dell'app appena questa si chiude e la riavvia."""
    r = check()
    if r["stato"] != "nuova":
        raise ValueError({"sincronizzazione": "OneDrive sta ancora scaricando la nuova versione: riprova tra qualche minuto",
                          "aggiornato": "Hai gia' l'ultima versione"}.get(r["stato"], "Nessun aggiornamento disponibile"))
    src = Path(r["fonte"])
    if _same(src, APP_DIR):
        raise ValueError("L'app e' avviata dalla cartella di OneDrive: si aggiorna con la sincronizzazione")
    if not ((APP_DIR / "_internal").is_dir() and (APP_DIR / "MBVisual.exe").is_file()):
        raise ValueError("Cartella dell'app non riconosciuta: aggiornamento annullato per sicurezza")
    _log(f"aggiornamento {r['attuale']} -> {r['disponibile']} da {src}")
    _copy_app(src, STAGING, update)
    if update:
        update(0.98, "Riavvio di MB Visual")
    # .cmd e robocopy: niente PowerShell (puo' essere bloccato dai criteri aziendali); file gia' tutti in locale
    log = str(LOG)
    cmd = Path(tempfile.gettempdir()) / "MBVisual-aggiorna.cmd"
    pid = os.getpid()
    cmd.write_text("\r\n".join([
        "@echo off", "chcp 65001 >nul",
        ":attesa",
        rf'"%SystemRoot%\System32\tasklist.exe" /FI "PID eq {pid}" 2>nul | "%SystemRoot%\System32\find.exe" "{pid}" >nul && ("%SystemRoot%\System32\ping.exe" -n 2 127.0.0.1 >nul & goto attesa)',
        f'robocopy "{STAGING / "_internal"}" "{APP_DIR / "_internal"}" /MIR /R:5 /W:2 /NP /NFL /NDL >> "{log}"',
        f'robocopy "{STAGING}" "{APP_DIR}" MBVisual.exe LEGGIMI.txt /R:5 /W:2 /NP /NFL /NDL >> "{log}"',
        f'start "" "{APP_DIR / "MBVisual.exe"}"',
    ]) + "\r\n", encoding="utf-8", newline="")
    flags = 0x00000200 | 0x08000000  # CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
    subprocess.Popen(["cmd", "/c", str(cmd)], creationflags=flags, close_fds=True)
    threading.Timer(1.0, lambda: os._exit(0)).start()
    return {"ok": True, "versione": r["disponibile"]}


def install(update=None) -> dict:
    """Installa l'app su questo PC (%LOCALAPPDATA%/Programs/MB Visual + collegamenti su Desktop e menu Start),
    con avanzamento visibile, e la riavvia da li'."""
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
    _log(f"installazione da {src} in {INSTALL_DIR}")
    try:
        _copy_app(src, INSTALL_DIR, update)
        if update:
            update(0.98, "Collegamenti sul Desktop e nel menu Start")
        exe = INSTALL_DIR / "MBVisual.exe"
        try:
            _shortcuts(exe)
        except Exception as e:  # noqa: BLE001
            _log(f"collegamenti non creati: {e}")
        _restart(exe)
    except Exception as e:
        _log(f"installazione non riuscita: {e}")
        raise
    return {"ok": True, "cartella": str(INSTALL_DIR)}
