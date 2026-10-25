"""Aggiornamento automatico dell'app per PC dalla cartella "App per PC" sincronizzata con OneDrive.

La build (tools/build_portable.py) scrive:
  _internal/build.json  versione e data della build contenuta nell'eseguibile
  versione.json         nella cartella pubblicata, scritto per ultimo: versione, build, numero e peso dei file di _internal
All'avvio l'app cerca la cartella pubblicata sul PC (OneDrive aziendale, anche con nomi diversi) e confronta le build.
Se c'e' una build piu' recente e OneDrive l'ha scaricata tutta (numero e peso dei file tornano), propone di aggiornare:
uno script PowerShell aspetta la chiusura dell'app, copia i file nuovi nella cartella dell'app e la riavvia.
Chi avvia l'app direttamente dalla cartella OneDrive puo' installarla sul PC (%LOCALAPPDATA%\\Programs\\MB Desk):
la copia installata si aggiorna da sola e non risente delle sincronizzazioni a meta'.

Sul Mac l'app e' un pacchetto "MB Desk.app" e si aggiorna solo dalle release su GitHub (file MBDesk-<ver>-mac.dmg):
il .dmg si monta con hdiutil, il pacchetto nuovo si prepara in locale e uno script sh lo mette al posto di quello
in uso (di solito in /Applications) dopo la chiusura dell'app, poi la riapre. "Installa" copia l'app in /Applications.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from .paths import APP_DIR, DATA_DIR, IS_MAC, IS_WIN, NO_WINDOW, RES_DIR
from .i18n import t

FROZEN = bool(getattr(sys, "frozen", False))
# cartella del progetto su OneDrive: nome storico "MB Visual" (non visibile ai clienti), "MB Desk" se un giorno la si rinomina
REL = Path("ai-engineering-workspace") / "MB Visual" / "App per PC"
REL_NEW = Path("ai-engineering-workspace") / "MB Desk" / "App per PC"
SETTINGS = DATA_DIR / "aggiornamenti.json"
# eseguibile: "MB Desk.exe" dal 25/10/2026; "MBVisual.exe" = nome delle versioni precedenti (ponte per l'aggiornamento)
EXE = "MB Desk.exe" if IS_WIN else "MB Desk"
OLD_EXE = "MBVisual.exe"
_PROGRAMS = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Programs"
# installazioni nuove in "MB Desk"; quelle fatte prima del cambio di nome restano nella loro cartella (nessuno la vede)
INSTALL_DIR = next((d for d in (_PROGRAMS / "MB Desk", _PROGRAMS / "MB Visual") if (d / EXE).is_file() or (d / OLD_EXE).is_file()),
                   _PROGRAMS / "MB Desk")
# Mac: pacchetto in uso (APP_DIR = .../MB Desk.app/Contents/MacOS) e posto dove si installa
MAC_BUNDLE = APP_DIR.parent.parent if APP_DIR.parent.parent.suffix == ".app" else None
MAC_INSTALL = Path("/Applications") / "MB Desk.app"
MAC_OLD_INSTALL = Path("/Applications") / "MB Visual.app"  # nome precedente: si toglie dopo l'aggiornamento
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
        raise ValueError(t("srv_update.questa_cartella_non_c_versione"))
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
        yield root / REL_NEW
        # cartella condivisa aggiunta come collegamento o sincronizzata con un altro nome
        try:
            for sub in root.iterdir():
                if sub.is_dir():
                    yield sub / "MB Visual" / "App per PC"
                    yield sub / "MB Desk" / "App per PC"
                    yield sub / REL
                    yield sub / REL_NEW
        except OSError:
            pass


def migrate_exe_name() -> None:
    """Copie aggiornate da una versione precedente al cambio di nome: il ponte avvia ancora "MBVisual.exe".
    Qui si crea "MB Desk.exe" accanto (stesso eseguibile), si rifanno i collegamenti e, quando l'app gira gia' con il
    nome nuovo, si toglie il vecchio file (nessuna scritta "Visual" resta visibile)."""
    if not (IS_WIN and FROZEN):
        return
    me = Path(sys.executable)
    try:
        if me.name.lower() == OLD_EXE.lower():
            new = me.with_name(EXE)
            if not new.is_file() or new.stat().st_size != me.stat().st_size or new.stat().st_mtime < me.stat().st_mtime:
                shutil.copy2(me, new)
            _safe(repair_shortcuts)
        elif me.name.lower() == EXE.lower() and (me.parent / OLD_EXE).is_file():
            (me.parent / OLD_EXE).unlink()
    except OSError as e:
        _log(f"cambio di nome dell'eseguibile non completato: {e}")


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
    return n == man.get("file") and size == man.get("byte") and (src / EXE).is_file()


def _safe(fn):
    try:
        return fn()
    except Exception as e:  # noqa: BLE001
        _log(f"{getattr(fn, '__name__', fn)}: {e}")


def _same(a: Path, b: Path) -> bool:
    try:
        return a.resolve() == b.resolve()
    except OSError:
        return False


def check() -> dict:
    cur = current()
    res = {"ok": True, "attuale": cur, "stato": "aggiornato", "fonte": None, "da_onedrive": False, "installabile": FROZEN and IS_WIN, "cartella": str(APP_DIR)}
    if not FROZEN:
        res["stato"] = "sviluppo"
        return res
    if not IS_WIN:
        return _check_mac(res, cur)
    if _same(APP_DIR, INSTALL_DIR):  # copia installata: collegamenti sistemati in sottofondo
        threading.Thread(target=lambda: _safe(repair_shortcuts), daemon=True).start()
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
        # niente cartella OneDrive (clienti esterni): ultima release pubblicata su GitHub
        rel = _github_latest()
        if rel and _vtuple(rel["versione"]) > _vtuple(cur.get("versione", "0")):
            res.update(stato="nuova", fonte="github", github=rel, disponibile={"versione": rel["versione"], "build": rel["data"]})
        elif not rel:
            res["stato"] = "nessuna_fonte"
        return res
    src, man = best
    res["fonte"] = str(src)
    if str(man["build"]) > str(cur.get("build", "")):
        res["disponibile"] = man
        res["stato"] = "nuova" if _manifest_ok(src, man) else "sincronizzazione"
    return res


def _check_mac(res: dict, cur: dict) -> dict:
    """Mac (e altri sistemi): niente cartella OneDrive "App per PC" (contiene l'app per Windows), solo GitHub."""
    res["cartella"] = str(MAC_BUNDLE or APP_DIR)
    res["installabile"] = bool(IS_MAC and MAC_BUNDLE and not _same(MAC_BUNDLE, MAC_INSTALL))
    rel = _github_latest() if IS_MAC else None
    if rel and _vtuple(rel["versione"]) > _vtuple(cur.get("versione", "0")):
        res.update(stato="nuova", fonte="github", github=rel, disponibile={"versione": rel["versione"], "build": rel["data"]})
    elif not rel:
        res["stato"] = "nessuna_fonte"
    return res


STAGING = DATA_DIR / "nuova-versione"


def _log(msg: str) -> None:
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            import datetime
            f.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S} {msg}\n")
    except OSError:
        pass


def _copy_app(src: Path, dst: Path, update=None) -> None:
    """Copia l'app (cartella _internal + MB Desk.exe + LEGGIMI.txt) con avanzamento.
    Leggere i file li scarica da OneDrive se sono "solo online": per questo serve l'avanzamento visibile.
    Salta i file gia' uguali (dimensione e data), toglie da _internal quelli che non esistono piu'."""
    files = []
    for dp, _dn, fn in os.walk(src / "_internal"):
        for n in fn:
            files.append(Path(dp) / n)
    files += [src / n for n in (EXE, "LEGGIMI.txt") if (src / n).is_file()]
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
                        raise OSError(t("srv_update.copia_non_riuscita_0_1", rel, e)) from e
                    import time
                    time.sleep(1.5)
        done += st.st_size
        if update and (k % 25 == 0 or k == len(files) - 1):
            update(0.97 * done / total, t("srv_update.copia_file_0_1_mb", f"{done / 1048576:.0f}", f"{total / 1048576:.0f}"))
    for dp, _dn, fn in os.walk(dst / "_internal", topdown=False):
        for n in fn:
            rel = (Path(dp) / n).relative_to(dst).as_posix()
            if rel not in wanted:
                try:
                    (Path(dp) / n).unlink()
                except OSError:
                    pass


LINK = "MB Desk.lnk"          # nome dell'app dal 25/10/2026
OLD_LINK = "MB Visual.lnk"  # collegamenti delle versioni precedenti: si rinominano dove sono (1.6.6-1.6.8: per errore
                            # era "MB Desk.lnk" e il collegamento appena creato veniva cancellato subito)


def _desktop_link(desktop) -> Path:
    """Collegamento del Desktop: se l'utente l'ha spostato in una cartella del Desktop si usa quello, e non se ne crea uno
    nuovo sul Desktop (prima a ogni avvio ricompariva dove l'utente l'aveva tolto). Vale anche per il nome vecchio."""
    d = Path(desktop)
    for name in (LINK, OLD_LINK):
        if (d / name).is_file():
            return d / LINK
    try:
        moved = sorted(d.glob("*/" + LINK)) or sorted(d.glob("*/" + OLD_LINK))
    except OSError:
        moved = []
    return moved[0].with_name(LINK) if moved else d / LINK


def _drop_old(path: Path) -> None:
    """Toglie il collegamento con il nome vecchio accanto a quello nuovo."""
    try:
        (path.parent / OLD_LINK).unlink(missing_ok=True)
    except OSError:
        pass


def _shortcuts(exe: Path) -> None:
    """Collegamenti "MB Desk" sul Desktop e nel menu Start (senza script PowerShell)."""
    import pythoncom
    import win32com.client
    pythoncom.CoInitialize()
    try:
        sh = win32com.client.Dispatch("WScript.Shell")
        for path in (_desktop_link(sh.SpecialFolders("Desktop")), Path(sh.SpecialFolders("Programs")) / LINK):
            lnk = sh.CreateShortcut(str(path))
            lnk.TargetPath = str(exe)
            lnk.WorkingDirectory = str(exe.parent)
            # icona da file .ico locale (se l'exe fosse un file OneDrive "solo online" Windows mostrerebbe un riquadro vuoto)
            ico = exe.parent / "_internal" / "app.ico"
            lnk.IconLocation = f"{ico},0" if ico.is_file() else f"{exe},0"
            lnk.Description = "MB Desk"
            lnk.Save()
            _drop_old(path)
    finally:
        sh = lnk = None  # oggetti COM rilasciati prima di chiudere COM (altrimenti avvisi Win32 all'uscita)
        pythoncom.CoUninitialize()


def repair_shortcuts() -> dict:
    """Copia installata: ripara i collegamenti "MB Desk" di Desktop e menu Start se mancano, puntano altrove o non
    hanno un'icona propria. Trascinando la voce del menu Start sul Desktop, Windows crea un collegamento a un
    collegamento senza icona: trascinato poi sulla barra delle applicazioni mostra un quadrato grigio."""
    exe = INSTALL_DIR / EXE
    if not (IS_WIN and FROZEN and _same(APP_DIR, INSTALL_DIR) and exe.is_file()):
        return {"riparati": 0}
    import pythoncom
    import win32com.client
    pythoncom.CoInitialize()
    fixed = 0
    try:
        sh = win32com.client.Dispatch("WScript.Shell")
        ico = INSTALL_DIR / "_internal" / "app.ico"
        want_icon = f"{ico},0" if ico.is_file() else f"{exe},0"
        for path in (_desktop_link(sh.SpecialFolders("Desktop")), Path(sh.SpecialFolders("Programs")) / LINK):
            ok = False
            if (path.parent / OLD_LINK).is_file():
                ok = False
            elif path.is_file():
                try:
                    lnk = sh.CreateShortcut(str(path))
                    ok = _same(Path(lnk.TargetPath or "."), exe) and (lnk.IconLocation or "").lower() == want_icon.lower()
                except Exception:  # noqa: BLE001
                    ok = False
            if ok:
                continue
            lnk = sh.CreateShortcut(str(path))
            lnk.TargetPath = str(exe)
            lnk.WorkingDirectory = str(INSTALL_DIR)
            lnk.IconLocation = want_icon
            lnk.Description = "MB Desk"
            lnk.Save()
            _drop_old(path)
            fixed += 1
    finally:
        sh = lnk = None  # oggetti COM rilasciati prima di chiudere COM (altrimenti avvisi Win32 all'uscita)
        pythoncom.CoUninitialize()
    # versione nuova: l'icona e' un file nuovo nello stesso percorso (_internal/app.ico) e Windows continuerebbe a
    # mostrare quella vecchia in memoria (barra delle applicazioni, menu Start): la cache si rinfresca una volta
    mark = DATA_DIR / "icone_versione.txt"
    ver = str(current().get("build") or "")
    try:
        icons_old = mark.read_text(encoding="utf-8").strip() != ver
    except OSError:
        icons_old = True
    if fixed or icons_old:
        _log(f"collegamenti riparati: {fixed}, cache delle icone rinfrescata per la build {ver}")
        try:
            mark.parent.mkdir(parents=True, exist_ok=True)
            mark.write_text(ver, encoding="utf-8")
        except OSError:
            pass
        try:  # aggiorna la cache delle icone di Windows (solo per l'utente)
            subprocess.run([os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "ie4uinit.exe"), "-show"],
                           timeout=20, creationflags=NO_WINDOW, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:  # noqa: BLE001
            pass
    return {"riparati": fixed}


def _restart(exe: Path) -> None:
    flags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    subprocess.Popen([str(exe)], cwd=str(exe.parent), creationflags=flags, close_fds=True)
    threading.Timer(1.5, lambda: os._exit(0)).start()


# ---------------------------------------------------------------- aggiornamenti via internet (release su GitHub)
RELEASES_REPO = "Lorenz0gr4ssi83/MB-Visual-Rilasci"  # repository pubblico con i soli setup (senza licenza non funzionano)


def _vtuple(v: str) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", str(v))[:4]) or (0,)


def _github_latest():
    import urllib.request
    try:
        req = urllib.request.Request(f"https://api.github.com/repos/{RELEASES_REPO}/releases/latest",
                                     headers={"accept": "application/vnd.github+json", "user-agent": "MBVisual"})
        with urllib.request.urlopen(req, timeout=8) as r:
            rel = json.loads(r.read())
    except Exception:  # noqa: BLE001
        return None
    # nome nuovo prima; il nome vecchio resta nelle release per un periodo solo per le copie precedenti al cambio di nome
    patterns = (r"MBDesk-.*-mac\.dmg$", r"MBVisual-.*-mac\.dmg$") if IS_MAC else (r"MBDesk-Setup-.*\.exe$", r"MBVisual-Setup-.*\.exe$")
    asset = next((a for pat in patterns for a in rel.get("assets", []) if re.match(pat, a.get("name", ""))), None)
    if not asset:
        return None
    return {"versione": rel.get("tag_name", "").lstrip("v"), "data": (rel.get("published_at") or "")[:19].replace("T", " "),
            "url": asset["browser_download_url"], "byte": asset.get("size", 0), "note": rel.get("body", "")}


def _relaunch_lines(exe, log) -> list:
    """Righe finali dello script di aggiornamento: riavvio dell'app con registro dei passi. Prima "start", poi, se dopo
    20 s MB Desk non e' partita, un secondo tentativo tramite Esplora risorse (processo del desktop, fuori da ogni
    gruppo di processi o job dell'app vecchia)."""
    name = os.path.basename(str(exe))
    return [
        f'echo %date% %time% riavvio di "{exe}" >> "{log}"',
        f'start "" "{exe}"',
        r'"%SystemRoot%\System32\ping.exe" -n 21 127.0.0.1 >nul',
        rf'"%SystemRoot%\System32\tasklist.exe" /FI "IMAGENAME eq {name}" 2>nul | "%SystemRoot%\System32\find.exe" /I "{name}" >nul '
        rf'|| (echo %date% %time% secondo tentativo con Esplora >> "{log}" & "%SystemRoot%\explorer.exe" "{exe}")',
    ]


def _run_detached(cmd) -> None:
    """Script di aggiornamento staccato dall'app (che si chiude): senza finestra, nuovo gruppo di processi e, se il
    job dell'app lo consente, fuori dal job (altrimenti chiudendo l'app Windows chiuderebbe anche lo script)."""
    base = 0x00000200 | 0x08000000  # CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
    kw = dict(close_fds=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        subprocess.Popen(["cmd", "/c", str(cmd)], creationflags=base | 0x01000000, **kw)  # CREATE_BREAKAWAY_FROM_JOB
    except OSError:
        subprocess.Popen(["cmd", "/c", str(cmd)], creationflags=base, **kw)


def _download(rel: dict, setup: Path, update=None) -> None:
    import urllib.request
    STAGING.mkdir(parents=True, exist_ok=True)
    total = rel.get("byte") or 1
    with urllib.request.urlopen(urllib.request.Request(rel["url"], headers={"user-agent": "MBVisual"}), timeout=60) as r, open(setup, "wb") as f:
        done = 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if update:
                update(0.95 * done / total, t("srv_update.scaricamento_mb", f"{done / 1048576:.0f}", f"{total / 1048576:.0f}"))
    if rel.get("byte") and setup.stat().st_size != rel["byte"]:
        raise ValueError(t("srv_update.scaricamento_incompleto_riprova"))


def _apply_github(rel: dict, update=None) -> dict:
    """Scarica il setup (con avanzamento) e lo esegue in silenzio quando l'app si e' chiusa, poi la riavvia."""
    if IS_MAC:
        return _apply_github_mac(rel, update)
    if not IS_WIN:
        raise ValueError(t("srv_update.non_disponibile_su_questo_sistema"))
    setup = STAGING / f"MBDesk-Setup-{rel['versione']}.exe"
    _download(rel, setup, update)
    if update:
        update(0.97, t("srv_update.installazione_nuova_versione"))
    exe = INSTALL_DIR / EXE
    cmd = Path(tempfile.gettempdir()) / "MBVisual-aggiorna.cmd"
    pid = os.getpid()
    cmd.write_text("\r\n".join([
        "@echo off", "chcp 65001 >nul",
        ":attesa",
        rf'"%SystemRoot%\System32\tasklist.exe" /FI "PID eq {pid}" 2>nul | "%SystemRoot%\System32\find.exe" "{pid}" >nul && ("%SystemRoot%\System32\ping.exe" -n 2 127.0.0.1 >nul & goto attesa)',
        f'"{setup}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /LOG="{LOG}"',
        *_relaunch_lines(exe, str(LOG)),
    ]) + "\r\n", encoding="utf-8", newline="")
    _run_detached(cmd)
    threading.Timer(1.0, lambda: os._exit(0)).start()
    return {"ok": True, "versione": rel["versione"]}


# ---------------------------------------------------------------- Mac: sostituzione del pacchetto .app
def _sh_quote(p) -> str:
    return "'" + str(p).replace("'", "'\\''") + "'"


def _mac_swap(new_app: Path, target: Path, drop: Path = None) -> None:
    """Script sh in sottofondo: aspetta la chiusura dell'app, mette new_app al posto di target e la riapre
    (se la copia non riesce rimette il pacchetto di prima). drop = pacchetto con il nome vecchio da togliere."""
    q = _sh_quote
    pid = os.getpid()
    old = target.with_name(target.name + ".old")
    sh = Path(tempfile.gettempdir()) / "MBVisual-aggiorna.sh"
    sh.write_text("\n".join([
        "#!/bin/sh",
        f"while kill -0 {pid} 2>/dev/null; do sleep 1; done",
        f"rm -rf {q(old)}; [ -e {q(target)} ] && mv {q(target)} {q(old)}",
        f"if /usr/bin/ditto {q(new_app)} {q(target)} >> {q(LOG)} 2>&1; then rm -rf {q(old)} {q(new_app)}; "
        f"else rm -rf {q(target)}; mv {q(old)} {q(target)}; fi",
        f"/usr/bin/xattr -dr com.apple.quarantine {q(target)} 2>/dev/null",
        *([f"[ -d {q(target)} ] && rm -rf {q(drop)}"] if drop and not _same(drop, target) else []),
        f"/usr/bin/open {q(target)}",
    ]) + "\n", encoding="utf-8")
    subprocess.Popen(["/bin/sh", str(sh)], start_new_session=True, close_fds=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    threading.Timer(1.0, lambda: os._exit(0)).start()


def _apply_github_mac(rel: dict, update=None) -> dict:
    """Scarica il .dmg, ne estrae "MB Desk.app" in locale e la sostituisce a quella in uso dopo la chiusura."""
    if not MAC_BUNDLE:
        raise ValueError(t("srv_update.mac_pacchetto_non_riconosciuto"))
    import shutil
    dmg = STAGING / f"MBDesk-{rel['versione']}-mac.dmg"
    _download(rel, dmg, update)
    if update:
        update(0.96, t("srv_update.mac_preparazione"))
    mnt = Path(tempfile.mkdtemp(prefix="mbvisual-dmg-"))
    new_app = STAGING / "MB Desk.app"
    shutil.rmtree(new_app, ignore_errors=True)
    subprocess.run(["/usr/bin/hdiutil", "attach", "-nobrowse", "-readonly", "-mountpoint", str(mnt), str(dmg)],
                   check=True, capture_output=True, timeout=300)
    try:
        src = next(mnt.glob("*.app"), None)
        if not src:
            raise ValueError(t("srv_update.mac_dmg_senza_app"))
        subprocess.run(["/usr/bin/ditto", str(src), str(new_app)], check=True, capture_output=True, timeout=600)
    finally:
        subprocess.run(["/usr/bin/hdiutil", "detach", str(mnt), "-force"], capture_output=True, timeout=120)
    if update:
        update(0.98, t("srv_update.riavvio_mb_visual"))
    _log(f"aggiornamento Mac -> {rel['versione']} in {MAC_BUNDLE}")
    # copia nel pacchetto con il nome vecchio ("MB Visual.app"): l'aggiornamento la rinomina in "MB Desk.app"
    renamed = MAC_BUNDLE.name == MAC_OLD_INSTALL.name
    _mac_swap(new_app, MAC_BUNDLE.with_name(MAC_INSTALL.name) if renamed else MAC_BUNDLE, MAC_BUNDLE if renamed else None)
    return {"ok": True, "versione": rel["versione"]}


def _install_mac(update=None) -> dict:
    """Copia l'app in /Applications (togliendo la quarantena del download) e la riapre da li'."""
    if not MAC_BUNDLE:
        raise ValueError(t("srv_update.mac_pacchetto_non_riconosciuto"))
    if _same(MAC_BUNDLE, MAC_INSTALL):
        raise ValueError(t("srv_update.mac_gia_in_applicazioni"))
    if update:
        update(0.5, t("srv_update.mac_copia_applicazioni"))
    _log(f"installazione Mac da {MAC_BUNDLE} in {MAC_INSTALL}")
    import shutil
    tmp = STAGING / "installa" / "MB Desk.app"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["/usr/bin/ditto", str(MAC_BUNDLE), str(tmp)], check=True, capture_output=True, timeout=900)
    _mac_swap(tmp, MAC_INSTALL)
    return {"ok": True, "cartella": str(MAC_INSTALL)}


def apply(update=None) -> dict:
    """Prepara la nuova versione in una cartella locale (con avanzamento), poi uno script di Windows la copia
    nella cartella dell'app appena questa si chiude e la riavvia."""
    r = check()
    if r["stato"] != "nuova":
        raise ValueError({"sincronizzazione": t("srv_update.onedrive_sta_ancora_scaricando_nuova"),
                          "aggiornato": t("srv_update.hai_gia_l_ultima_versione")}.get(r["stato"], t("srv_update.nessun_aggiornamento_disponibile")))
    if r.get("github"):
        _log(f"aggiornamento da GitHub {r['attuale']} -> {r['github']['versione']}")
        return _apply_github(r["github"], update)
    if not IS_WIN:
        raise ValueError(t("srv_update.nessun_aggiornamento_disponibile"))
    src = Path(r["fonte"])
    if _same(src, APP_DIR):
        raise ValueError(t("srv_update.l_app_avviata_cartella_onedrive"))
    if not ((APP_DIR / "_internal").is_dir() and ((APP_DIR / EXE).is_file() or (APP_DIR / OLD_EXE).is_file())):
        raise ValueError(t("srv_update.cartella_dell_app_non_riconosciuta"))
    _log(f"aggiornamento {r['attuale']} -> {r['disponibile']} da {src}")
    _copy_app(src, STAGING, update)
    if update:
        update(0.98, t("srv_update.riavvio_mb_visual"))
    # .cmd e robocopy: niente PowerShell (puo' essere bloccato dai criteri aziendali); file gia' tutti in locale
    log = str(LOG)
    cmd = Path(tempfile.gettempdir()) / "MBVisual-aggiorna.cmd"
    pid = os.getpid()
    cmd.write_text("\r\n".join([
        "@echo off", "chcp 65001 >nul",
        ":attesa",
        rf'"%SystemRoot%\System32\tasklist.exe" /FI "PID eq {pid}" 2>nul | "%SystemRoot%\System32\find.exe" "{pid}" >nul && ("%SystemRoot%\System32\ping.exe" -n 2 127.0.0.1 >nul & goto attesa)',
        f'robocopy "{STAGING / "_internal"}" "{APP_DIR / "_internal"}" /MIR /R:5 /W:2 /NP /NFL /NDL >> "{log}"',
        f'robocopy "{STAGING}" "{APP_DIR}" "{EXE}" LEGGIMI.txt /R:90 /W:2 /NP /NFL /NDL >> "{log}"',
        *_relaunch_lines(APP_DIR / EXE, log),
    ]) + "\r\n", encoding="utf-8", newline="")
    _run_detached(cmd)
    threading.Timer(1.0, lambda: os._exit(0)).start()
    return {"ok": True, "versione": r["disponibile"]}


def install(update=None, integrazione=False) -> dict:
    """Installa l'app su questo PC (%LOCALAPPDATA%/Programs/MB Desk + collegamenti su Desktop e menu Start),
    con avanzamento visibile, e la riavvia da li'."""
    if not FROZEN:
        raise ValueError(t("srv_update.disponibile_solo_nell_app_pc"))
    if IS_MAC:
        return _install_mac(update)
    if not IS_WIN:
        raise ValueError(t("srv_update.non_disponibile_su_questo_sistema"))
    r = check()
    if r["stato"] == "sincronizzazione":
        raise ValueError(t("srv_update.onedrive_sta_ancora_scaricando_nuova"))
    src = Path(r["fonte"]) if r.get("fonte") and r["stato"] in ("nuova", "aggiornato") else APP_DIR
    if not (src / "_internal").is_dir():
        src = APP_DIR
    if _same(src, INSTALL_DIR):
        raise ValueError(t("srv_update.l_app_gia_installata_questo"))
    _log(f"installazione da {src} in {INSTALL_DIR}")
    try:
        _copy_app(src, INSTALL_DIR, update)
        if update:
            update(0.98, t("srv_update.collegamenti_desktop_menu_start"))
        exe = INSTALL_DIR / EXE
        try:
            _shortcuts(exe)
        except Exception as e:  # noqa: BLE001
            _log(f"collegamenti non creati: {e}")
        if integrazione:  # miniature, anteprime e "Apri con" in Esplora (mbvisual/shellint.py) con l'exe installato
            if update:
                update(0.99, t("srv_update.integrazione_esplora"))
            try:
                subprocess.run([str(exe), "--integrazione", "attiva"], timeout=300, creationflags=0x08000000)
            except Exception as e:  # noqa: BLE001
                _log(f"integrazione con Esplora non attivata: {e}")
        _restart(exe)
    except Exception as e:
        _log(f"installazione non riuscita: {e}")
        raise
    return {"ok": True, "cartella": str(INSTALL_DIR)}
