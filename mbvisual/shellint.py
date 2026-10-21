"""Integrazione con Esplora risorse, solo per l'utente corrente (HKCU, senza diritti di amministratore).

- "Apri con": un ProgID MBVisual.<ext> per ogni estensione di ui/formats.json (icona col colore del tipo, come i badge
  dell'app) + OpenWithProgids + Capabilities in RegisteredApplications (MB Visual compare in App predefinite).
  I programmi predefiniti esistenti NON si toccano: MB Visual diventa predefinito solo per le estensioni che non hanno
  alcun programma (opzione "libere"); per le altre lo sceglie l'utente da Windows (Impostazioni > App predefinite).
- Voce "Apri con MB Visual" nel menu del tasto destro (in Windows 11 sotto "Mostra altre opzioni").
- Miniature e riquadro di anteprima per i formati tecnici: mbvshell.dll (tools/mbvshell, ARM64 o x64 secondo il PC),
  registrata sotto SystemFileAssociations: se un altro programma (AutoCAD, SolidWorks...) ha gia' un suo gestore,
  quello resta prioritario. La DLL si copia in %LOCALAPPDATA%\\MBVisual\\shell con un nome che cambia a ogni versione,
  perche' Esplora la tiene aperta e la copia nell'app deve potersi aggiornare.
Uso da riga di comando (installazione): MBVisual.exe --integrazione attiva|rimuovi|stato
"""
import ctypes
import hashlib
import json
import os
import shutil
import sys
import winreg
from pathlib import Path

from .paths import APP_DIR, BIN_DIR, UI_DIR

HKCU = winreg.HKEY_CURRENT_USER
CLASSES = r"Software\Classes"
STATE = r"Software\MB Visual\Integrazione"
CAPS = r"Software\MB Visual\Capabilities"
CLSID_THUMB = "{6F1D8E2A-5C4F-4E3B-9A1D-2F6C8B0E4A11}"
CLSID_PREVIEW = "{6F1D8E2A-5C4F-4E3B-9A1D-2F6C8B0E4A12}"
SHELLEX_THUMB = "{E357FCCD-A995-4576-B01F-234630154E96}"
SHELLEX_PREVIEW = "{8895B1C6-B41F-4C1C-A562-0D564250836F}"
PREVHOST_APPID = "{6D2B5079-2F0B-48DD-AB7F-97CEC514D30B}"
VERB = "MBVisual.apri"
PREFIX = "MBVisual."
LOCAL = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "MBVisual"

# estensioni che non si associano mai (programmi, collegamenti)
NEVER = {"exe", "dll", "lnk", "url", "bat", "cmd", "com", "scr", "msi", "msp", "sys", "cpl", "ocx", "drv", "pif", "appref-ms",
         "library-ms", "search-ms", "theme", "reg", "ps1", "vbs", "js", "jse", "wsf", "hta", "msc"}
# visualizzatori dei tipi che Windows mostra gia' da solo (o per cui una miniatura non ha senso): niente DLL
NO_THUMB_VIEWERS = {"pdf", "signed", "docx", "sheet", "pptx", "office", "text", "markdown", "html", "image", "svg", "media",
                    "archive", "email", "epub", "font", "sqlite", "hex", "oo", "video"}
EXTRA_THUMB = {"nwd", "nwc", "skp", "skb", "rvt", "rfa", "rte", "ipt", "iam", "idw", "ipn", "sldprt", "sldasm", "slddrw",
               "dwf", "dwfx", "3dm", "mbpub"}
COLORS = {"pdf": "#c0392b", "sig": "#a0781a", "doc": "#2b579a", "xls": "#217346", "ppt": "#c4511f", "cad": "#0e7c86",
          "3d": "#6b4fa0", "img": "#2f8f6f", "av": "#b03a74", "zip": "#8a6d1f", "mail": "#3d6fa8", "code": "#5b6470",
          "db": "#7a5c3d", "bin": "#77797a"}
BADGE = {"pdf": "pdf", "signed": "sig", "word": "doc", "office-lo": "doc", "sheet": "xls", "pptx": "ppt", "publisher": "cad",
         "cad2d": "cad", "cad3d": "3d", "mesh3d": "3d", "navisworks": "3d", "image": "img", "image-raw": "img", "svg": "img",
         "media": "av", "audio": "av", "videoproject": "av", "archive": "zip", "email": "mail", "text": "code",
         "markdown": "code", "html": "code", "ebook": "code", "font": "code", "database": "db"}
FROZEN = getattr(sys, "frozen", False)
# .pdb sono anche i simboli di debug di Visual Studio: niente miniature (migliaia di file) ne' programma predefinito
NO_AUTO = {"pdb"}


# ------------------------------------------------------------------ registro
def _set(path, name, value, kind=winreg.REG_SZ, root=HKCU):
    with winreg.CreateKeyEx(root, path, 0, winreg.KEY_WRITE) as k:
        winreg.SetValueEx(k, name, 0, kind, value)


def _get(path, name="", root=HKCU):
    try:
        with winreg.OpenKey(root, path) as k:
            return winreg.QueryValueEx(k, name)[0]
    except OSError:
        return None


def _exists(path, root=HKCU):
    try:
        winreg.CloseKey(winreg.OpenKey(root, path))
        return True
    except OSError:
        return False


def _delete_tree(path, root=HKCU):
    try:
        with winreg.OpenKey(root, path, 0, winreg.KEY_READ | winreg.KEY_WRITE) as k:
            while True:
                try:
                    sub = winreg.EnumKey(k, 0)
                except OSError:
                    break
                _delete_tree(path + "\\" + sub, root)
        winreg.DeleteKey(root, path)
    except OSError:
        pass


def _delete_value(path, name, root=HKCU):
    try:
        with winreg.OpenKey(root, path, 0, winreg.KEY_WRITE) as k:
            winreg.DeleteValue(k, name)
    except OSError:
        pass


def _prune(path):
    """Toglie le chiavi rimaste vuote risalendo (es. .dwg\\ShellEx creata solo per noi)."""
    while path.count("\\") > 2:
        try:
            with winreg.OpenKey(HKCU, path) as k:
                info = winreg.QueryInfoKey(k)
            if info[0] or info[1]:
                return
            winreg.DeleteKey(HKCU, path)
        except OSError:
            return
        path = path.rsplit("\\", 1)[0]


def _notify():
    try:
        ctypes.windll.shell32.SHChangeNotify(0x08000000, 0, None, None)  # SHCNE_ASSOCCHANGED
    except Exception:  # noqa: BLE001
        pass


# ------------------------------------------------------------------ formati
def _formats():
    reg = json.loads((UI_DIR / "formats.json").read_text(encoding="utf-8"))
    out = {}  # ext -> categoria (la prima che la elenca)
    for c in reg["categories"]:
        for e in c["exts"]:
            e = e.lower().lstrip(".")
            if e and e not in NEVER and e not in out and all(ch.isalnum() or ch in "-_+" for ch in e):
                out[e] = c
    return out


def thumb_exts(fmts=None):
    fmts = fmts or _formats()
    return sorted(e for e, c in fmts.items() if (c.get("viewer") not in NO_THUMB_VIEWERS or e in EXTRA_THUMB) and e not in NO_AUTO)


def _handler_elsewhere(ext, shellex):
    """Gestore miniatura/anteprima gia' registrato da un altro programma (estensione, ProgID o tipo)."""
    hkcr = winreg.HKEY_CLASSES_ROOT
    keys = [f".{ext}\\ShellEx\\{shellex}", f"SystemFileAssociations\\.{ext}\\ShellEx\\{shellex}"]
    progid = _get(f".{ext}", root=hkcr)
    if progid:
        keys.append(f"{progid}\\ShellEx\\{shellex}")
    perceived = _get(f".{ext}", "PerceivedType", root=hkcr)
    if perceived:
        keys.append(f"SystemFileAssociations\\{perceived}\\ShellEx\\{shellex}")
    for k in keys:
        v = _get(k, root=hkcr)
        if v and v.upper() not in (CLSID_THUMB, CLSID_PREVIEW):
            return v
    return None


def _has_default(ext):
    """L'estensione ha gia' un programma predefinito (scelto dall'utente o registrato da un programma)?"""
    if _get(rf"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.{ext}\UserChoice", "ProgId"):
        return True
    progid = _get(f".{ext}", root=winreg.HKEY_CLASSES_ROOT)
    if progid and not progid.startswith(PREFIX) and _exists(progid, winreg.HKEY_CLASSES_ROOT):
        return True
    return False


# ------------------------------------------------------------------ comandi, DLL, icone
def _commands():
    """(comando per aprire i file, comando per le miniature) - exe installato oppure Python + app.py in sviluppo."""
    if FROZEN:
        exe = f'"{Path(sys.executable).resolve()}"'
        return exe, exe
    py = Path(sys.executable)
    pyw = py.with_name("pythonw.exe")
    app = f'"{APP_DIR / "app.py"}"'
    return f'"{pyw if pyw.is_file() else py}" {app}', f'"{pyw if pyw.is_file() else py}" {app}'


def native_arch():
    """Architettura del PC (non del processo: il Python x64 gira emulato sui PC ARM64)."""
    try:
        k32 = ctypes.windll.kernel32
        k32.GetCurrentProcess.restype = ctypes.c_void_p
        k32.IsWow64Process2.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ushort), ctypes.POINTER(ctypes.c_ushort)]
        pm, nm = ctypes.c_ushort(), ctypes.c_ushort()
        if k32.IsWow64Process2(k32.GetCurrentProcess(), ctypes.byref(pm), ctypes.byref(nm)):
            return "arm64" if nm.value == 0xAA64 else "x64"
    except Exception:  # noqa: BLE001
        pass
    return "x64"


def _install_dll():
    src = BIN_DIR / "shell" / f"mbvshell-{native_arch()}.dll"
    if not src.is_file():
        raise FileNotFoundError(f"manca {src}")
    data = src.read_bytes()
    dst_dir = LOCAL / "shell"
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / f"mbvshell-{native_arch()}-{hashlib.sha256(data).hexdigest()[:10]}.dll"
    if not dst.is_file():
        tmp = dst.with_suffix(".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, dst)
    return dst


def _cleanup_dlls(keep=None):
    """Copie vecchie della DLL: si cancellano quando Esplora non le usa piu' (altrimenti alla prossima occasione)."""
    for f in (LOCAL / "shell").glob("mbvshell-*.dll"):
        if keep is None or f.resolve() != Path(keep).resolve():
            try:
                f.unlink()
            except OSError:
                pass


def _icon(ext, cat, big=False):
    """Icona del tipo di file: foglio con la piega e la fascia colorata con l'estensione (come i badge dell'app)."""
    from PIL import Image, ImageDraw, ImageFont
    color = COLORS.get(BADGE.get(cat.get("id"), "bin"), COLORS["bin"])
    d = LOCAL / "icone"
    d.mkdir(parents=True, exist_ok=True)
    out = d / f"{ext}.ico"
    if out.is_file():
        return out
    S = 256
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    g = ImageDraw.Draw(im)
    fold = 64
    page = [(40, 8), (216 - fold, 8), (216, 8 + fold), (216, 248), (40, 248)]
    g.polygon(page, fill=(255, 255, 255, 255), outline=(150, 154, 158, 255), width=6)
    g.polygon([(216 - fold, 8), (216 - fold, 8 + fold), (216, 8 + fold)], fill=(222, 225, 228, 255), outline=(150, 154, 158, 255), width=6)
    label = ext.upper()[:4]
    g.rounded_rectangle((12, 132, 244, 220), radius=14, fill=color)
    size = 72 if len(label) <= 3 else 58
    try:
        font = ImageFont.truetype("segoeuib.ttf", size)
    except OSError:
        font = ImageFont.load_default()
    w = g.textlength(label, font=font)
    g.text(((S - w) / 2, 176), label, font=font, fill="white", anchor="lm")
    # righe del foglio
    for y in (52, 76, 100):
        g.line((64, y, 176 if y > 52 else 140, y), fill=(200, 204, 208, 255), width=8)
    tmp = out.with_suffix(".tmp")
    im.save(tmp, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    os.replace(tmp, out)
    return out


# ------------------------------------------------------------------ attivazione / rimozione
def status() -> dict:
    on = bool(_get(STATE, "Attiva"))
    st = {"attiva": on, "arch": native_arch(), "versione": _get(STATE, "Versione"), "comando": _get(STATE, "Comando"),
          "anteprime": bool(_get(STATE, "Anteprime")), "libere": bool(_get(STATE, "Libere")), "dll": _get(STATE, "Dll"),
          "predefinito": list(_get(STATE, "Predefinito") or []), "altri_gestori": list(_get(STATE, "AltriGestori") or []),
          "estensioni": int(_get(STATE, "Estensioni") or 0), "miniature": list(_get(STATE, "Miniature") or []),
          "cache_mb": round(sum(f.stat().st_size for f in (LOCAL / "miniature" / "cache").glob("*.png")) / 1048576, 1)
          if (LOCAL / "miniature" / "cache").is_dir() else 0}
    st["disponibile"] = (BIN_DIR / "shell" / f"mbvshell-{native_arch()}.dll").is_file()
    return st


def enable(anteprime=True, libere=True, update=None) -> dict:
    """Registra tutto per l'utente corrente. Si puo' ripetere (aggiorna percorsi e DLL)."""
    prev_default = set(_get(STATE, "Predefinito") or [])
    disable(keep_state=True)
    fmts = _formats()
    open_cmd, thumb_cmd = _commands()
    exe = Path(sys.executable).resolve() if FROZEN else None
    app_icon = f'"{exe}",0' if exe else str(APP_DIR / "app.ico")
    exts = sorted(fmts)
    th_exts = thumb_exts(fmts) if anteprime else []
    dll = None
    if th_exts:
        dll = _install_dll()
        for clsid, name in ((CLSID_THUMB, "MB Visual - miniature"), (CLSID_PREVIEW, "MB Visual - anteprima")):
            base = rf"{CLASSES}\CLSID\{clsid}"
            _set(base, "", name)
            _set(base + r"\InprocServer32", "", str(dll))
            _set(base + r"\InprocServer32", "ThreadingModel", "Apartment")
        base = rf"{CLASSES}\CLSID\{CLSID_PREVIEW}"
        _set(base, "AppID", PREVHOST_APPID)
        _set(base, "DisplayName", "Anteprima di MB Visual")
        _set(base, "DisableLowILProcessIsolation", 1, winreg.REG_DWORD)  # deve poter avviare MB Visual e scrivere la cache
        _set(r"Software\Microsoft\Windows\CurrentVersion\PreviewHandlers", CLSID_PREVIEW, "Anteprima di MB Visual")
    _set(STATE, "Comando", thumb_cmd)
    _set(STATE, "Apri", open_cmd)
    others, thumbs, defaults = [], [], []
    for i, ext in enumerate(exts):
        if update and i % 40 == 0:
            update(i / len(exts) * 0.95, f"Registrazione dei formati ({i}/{len(exts)})")
        cat = fmts[ext]
        progid = PREFIX + ext
        pk = rf"{CLASSES}\{progid}"
        _set(pk, "", f"{cat.get('name', 'File')} ({ext.upper()})")
        _set(pk, "FriendlyTypeName", f"{cat.get('name', 'File')} ({ext.upper()})")
        try:
            _set(pk + r"\DefaultIcon", "", str(_icon(ext, cat)))
        except Exception:  # noqa: BLE001  (Pillow assente: icona dell'app)
            _set(pk + r"\DefaultIcon", "", app_icon)
        _set(pk + r"\shell\open", "FriendlyAppName", "MB Visual")
        _set(pk + r"\shell\open\command", "", f'{open_cmd} "%1"')
        _set(rf"{CLASSES}\.{ext}\OpenWithProgids", progid, b"", winreg.REG_NONE)
        _set(CAPS + r"\FileAssociations", f".{ext}", progid)
        verb = rf"{CLASSES}\SystemFileAssociations\.{ext}\shell\{VERB}"
        _set(verb, "MUIVerb", "Apri con MB Visual")
        _set(verb, "Icon", app_icon)
        _set(verb + r"\command", "", f'{open_cmd} "%1"')
        if libere and ext not in NO_AUTO and (ext in prev_default or not _has_default(ext)):
            _set(rf"{CLASSES}\.{ext}", "", progid)
            defaults.append(ext)
        if ext in th_exts:
            h = _handler_elsewhere(ext, SHELLEX_THUMB)
            if h:
                others.append(ext)
            else:
                _set(rf"{CLASSES}\SystemFileAssociations\.{ext}\ShellEx\{SHELLEX_THUMB}", "", CLSID_THUMB)
                thumbs.append(ext)
            if not _handler_elsewhere(ext, SHELLEX_PREVIEW):
                _set(rf"{CLASSES}\SystemFileAssociations\.{ext}\ShellEx\{SHELLEX_PREVIEW}", "", CLSID_PREVIEW)
    if exe:
        ap = rf"{CLASSES}\Applications\{exe.name}"
        _set(ap, "FriendlyAppName", "MB Visual")
        _set(ap + r"\DefaultIcon", "", app_icon)
        _set(ap + r"\shell\open\command", "", f'{open_cmd} "%1"')
        for ext in exts:
            _set(ap + r"\SupportedTypes", f".{ext}", "")
    _set(CAPS, "ApplicationName", "MB Visual")
    _set(CAPS, "ApplicationDescription", "Visualizzatore e editor di documenti, disegni CAD, modelli 3D e BIM")
    _set(CAPS, "ApplicationIcon", app_icon)
    _set(r"Software\RegisteredApplications", "MB Visual", CAPS)
    _set(STATE, "Attiva", 1, winreg.REG_DWORD)
    _set(STATE, "Anteprime", int(bool(anteprime)), winreg.REG_DWORD)
    _set(STATE, "Libere", int(bool(libere)), winreg.REG_DWORD)
    _set(STATE, "Dll", str(dll or ""))
    _set(STATE, "Estensioni", len(exts), winreg.REG_DWORD)
    _set(STATE, "Predefinito", defaults, winreg.REG_MULTI_SZ)
    _set(STATE, "AltriGestori", others, winreg.REG_MULTI_SZ)
    _set(STATE, "Miniature", thumbs, winreg.REG_MULTI_SZ)
    _set(STATE, "Versione", _app_version())
    _cleanup_dlls(keep=dll)
    _notify()
    if update:
        update(1, "Fatto")
    return status()


def disable(keep_state=False) -> dict:
    """Toglie tutto cio' che enable() ha scritto (solo le voci di MB Visual)."""
    root = CLASSES
    try:
        with winreg.OpenKey(HKCU, root) as k:
            names = []
            i = 0
            while True:
                try:
                    names.append(winreg.EnumKey(k, i))
                except OSError:
                    break
                i += 1
    except OSError:
        names = []
    for n in names:
        if n.startswith(PREFIX):
            _delete_tree(rf"{root}\{n}")
        elif n.startswith(".") and len(n) > 1:
            ext = n[1:].lower()
            _delete_value(rf"{root}\{n}\OpenWithProgids", PREFIX + ext)
            _prune(rf"{root}\{n}\OpenWithProgids")
            if (_get(rf"{root}\{n}") or "") == PREFIX + ext:  # predefinito messo da noi (estensione senza programma)
                _delete_value(rf"{root}\{n}", "")
            _prune(rf"{root}\{n}")
    sfa = rf"{root}\SystemFileAssociations"
    try:
        with winreg.OpenKey(HKCU, sfa) as k:
            subs = []
            i = 0
            while True:
                try:
                    subs.append(winreg.EnumKey(k, i))
                except OSError:
                    break
                i += 1
    except OSError:
        subs = []
    for s in subs:
        base = rf"{sfa}\{s}"
        _delete_tree(rf"{base}\shell\{VERB}")
        _prune(rf"{base}\shell")
        for shellex, clsid in ((SHELLEX_THUMB, CLSID_THUMB), (SHELLEX_PREVIEW, CLSID_PREVIEW)):
            if (_get(rf"{base}\ShellEx\{shellex}") or "").upper() == clsid:
                _delete_tree(rf"{base}\ShellEx\{shellex}")
        _prune(rf"{base}\ShellEx")
        _prune(base)
    for clsid in (CLSID_THUMB, CLSID_PREVIEW):
        _delete_tree(rf"{root}\CLSID\{clsid}")
    _delete_value(r"Software\Microsoft\Windows\CurrentVersion\PreviewHandlers", CLSID_PREVIEW)
    for exe in ("MBVisual.exe",):
        _delete_tree(rf"{root}\Applications\{exe}")
    _delete_value(r"Software\RegisteredApplications", "MB Visual")
    _delete_tree(CAPS)
    if not keep_state:
        _delete_tree(STATE)
        _prune(r"Software\MB Visual")
        _cleanup_dlls()
        shutil.rmtree(LOCAL / "icone", ignore_errors=True)
        shutil.rmtree(LOCAL / "miniature" / "cache", ignore_errors=True)
        _notify()
    return {"attiva": False}


def _app_version():
    try:
        import __main__
        return getattr(__main__, "VERSION", "") or ""
    except Exception:  # noqa: BLE001
        return ""


def refresh_if_needed() -> None:
    """All'avvio dell'app: se l'integrazione e' attiva ma punta a un altro exe o a una DLL vecchia, si riscrive."""
    if not _get(STATE, "Attiva"):
        return
    _, cmd = _commands()
    dll = _get(STATE, "Dll") or ""
    want = BIN_DIR / "shell" / f"mbvshell-{native_arch()}.dll"
    stale = _get(STATE, "Comando") != cmd or _get(STATE, "Versione") != _app_version()
    if dll and want.is_file() and not Path(dll).is_file():
        stale = True
    if stale:
        enable(anteprime=bool(_get(STATE, "Anteprime")), libere=bool(_get(STATE, "Libere")))


def clear_cache() -> dict:
    shutil.rmtree(LOCAL / "miniature" / "cache", ignore_errors=True)
    return {"ok": True}


def cli(argv) -> int:
    i = argv.index("--integrazione")
    what = argv[i + 1] if len(argv) > i + 1 else "stato"
    if what == "attiva":
        st = enable(anteprime="--senza-anteprime" not in argv, libere="--senza-predefiniti" not in argv)
    elif what == "rimuovi":
        st = disable()
    else:
        st = status()
    if sys.stdout:
        try:
            print(json.dumps(st, ensure_ascii=False, indent=1))
        except Exception:  # noqa: BLE001
            pass
    return 0
