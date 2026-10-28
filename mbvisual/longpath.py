"""Percorsi e nomi di file lunghi senza errori, in tutta l'app.

Windows limita i percorsi a 260 caratteri (MAX_PATH) se nel registro LongPathsEnabled e' spento (il predefinito) e ogni
nome di file/cartella a 255 caratteri (sempre). L'app non deve mai fallire per questo:
- `lp(p)`: percorso assoluto lungo (>= 240) -> forma estesa \\\\?\\C:\\... o \\\\?\\UNC\\server\\... che Windows accetta
  fino a ~32.000 caratteri; corto o gia' esteso: invariato. `unlp(p)` toglie il prefisso (per mostrarlo o confrontarlo).
- `install()` (chiamata all'avvio da app.py e da ogni processo di lavoro): le funzioni di file di Python (open, os.stat,
  os.listdir, os.scandir, os.rename, os.remove, os.makedirs, os.path.exists...) ricevono la forma estesa dei percorsi lunghi;
  subprocess passa la forma estesa ai programmi esterni (7-Zip, FFmpeg...: provati con 750 caratteri); dopo l'import si
  sistemano anche PyMuPDF, sqlite3 e IfcOpenShell (librerie in C che aprono i file da sole). I percorsi corti non cambiano.
- `safe_name(nome)` / `safe_path(p)`: un nome oltre il limite (240, per lasciare spazio ai file di appoggio come
  "-journal" o ".mbv-tmp") si accorcia in radice + "~" + 8 cifre dell'hash + estensione: stesso nome = stesso risultato.
Sonde su un percorso da 752 caratteri con nomi da 250 (tests/test_longpath.py).
"""
from __future__ import annotations

import builtins
import functools
import hashlib
import os
import sys

IS_WIN = sys.platform == "win32"
LIMIT = 240  # oltre questa lunghezza un percorso assoluto passa alla forma estesa
NAME_MAX = 240  # nome di file massimo prodotto dall'app (Windows: 255; margine per i file di appoggio)
_EXT = "\\\\?\\"
_UNC = "\\\\?\\UNC\\"


def lp(p):
    """Forma estesa di un percorso Windows lungo; gli altri valori tornano invariati."""
    if not IS_WIN or p is None:
        return p
    if isinstance(p, os.PathLike):
        p = os.fspath(p)
    if isinstance(p, bytes):
        try:
            s = p.decode("utf-8")
        except UnicodeDecodeError:
            return p
        r = lp(s)
        return r.encode("utf-8") if r is not s else p
    if not isinstance(p, str) or len(p) < LIMIT or p.startswith("\\\\.\\"):
        return p
    if p.startswith("\\\\?\\"):
        return _short_parts(p, 4)
    if p.startswith("\\\\"):  # percorso di rete \\server\cartella
        return _short_parts(_UNC + os.path.normpath(p)[2:], len(_UNC))
    if len(p) > 2 and p[1] == ":" and p[2] in "\\/":
        return _short_parts(_EXT + os.path.normpath(p), len(_EXT))
    if not os.path.isabs(p):  # relativo ma lungo una volta completato
        return lp(os.path.abspath(p))
    return p


def _short_parts(p: str, head: int) -> str:
    """Componenti oltre 255 caratteri (Windows non li ammette) accorciati con safe_name: lo stesso nome lungo porta
    sempre allo stesso file, quindi chi scrive e chi rilegge con il nome lungo trovano lo stesso file."""
    parts = p[head:].split("\\")
    if all(len(c) <= 255 for c in parts):
        return p
    return p[:head] + "\\".join(safe_name(c) if len(c) > 255 else c for c in parts)


def unlp(p: str) -> str:
    if isinstance(p, str):
        if p.startswith(_UNC):
            return "\\\\" + p[len(_UNC):]
        if p.startswith(_EXT):
            return p[len(_EXT):]
    return p


def _hash8(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8", "surrogatepass")).hexdigest()[:8]


def safe_name(name: str, limit: int = NAME_MAX) -> str:
    """Nome di file entro `limit` caratteri: radice accorciata + ~hash + estensione (l'estensione resta sempre)."""
    if len(name) <= limit:
        return name
    stem, ext = os.path.splitext(name)
    if len(ext) > 20:  # "estensione" assurda: fa parte del nome
        stem, ext = name, ""
    keep = max(1, limit - len(ext) - 9)
    return stem[:keep].rstrip(" .") + "~" + _hash8(name) + ext


def safe_path(p):
    """Percorso con l'ultimo componente accorciato se supera il limite dei nomi."""
    if p is None:
        return p
    s = os.fspath(p)
    d, n = os.path.split(s)
    if len(n) <= NAME_MAX:
        return p
    out = os.path.join(d, safe_name(n))
    return type(p)(out) if not isinstance(p, str) else out


# ------------------------------------------------------------------------------------------------- funzioni di Python
def _wrap1(fn):
    @functools.wraps(fn)
    def w(path, *a, **k):
        return fn(lp(path), *a, **k)
    w.__mbv_lp__ = True
    return w


def _wrap2(fn):
    @functools.wraps(fn)
    def w(src, dst, *a, **k):
        return fn(lp(src), lp(dst), *a, **k)
    w.__mbv_lp__ = True
    return w


def _wrap_open(fn):
    @functools.wraps(fn)
    def w(file, *a, **k):
        return fn(lp(file) if not isinstance(file, int) else file, *a, **k)
    w.__mbv_lp__ = True
    return w


def _scandir(fn):
    """os.scandir con forma estesa: gli elementi restituiti hanno path senza prefisso (come li vede il resto dell'app)."""
    @functools.wraps(fn)
    def w(path=".", *a, **k):
        q = lp(path)
        if q is path or isinstance(path, int):
            return fn(path, *a, **k)
        return _Scan(fn(q, *a, **k), os.fspath(path))
    w.__mbv_lp__ = True
    return w


class _Entry:
    __slots__ = ("_e", "path", "name")

    def __init__(self, e, base):
        self._e = e
        self.name = e.name
        self.path = os.path.join(base, e.name)

    def __getattr__(self, k):
        return getattr(self._e, k)

    def __fspath__(self):
        return self.path


class _Scan:
    def __init__(self, it, base):
        self._it, self._base = it, base

    def __iter__(self):
        return self

    def __next__(self):
        return _Entry(next(self._it), self._base)

    def __enter__(self):
        self._it.__enter__()
        return self

    def __exit__(self, *a):
        return self._it.__exit__(*a)

    def close(self):
        self._it.close()


def _walk(fn):
    """os.walk: con la forma estesa i percorsi restituiti tornano senza prefisso."""
    @functools.wraps(fn)
    def w(top, *a, **k):
        q = lp(top)
        if q is top:
            yield from fn(top, *a, **k)
            return
        for root, dirs, files in fn(q, *a, **k):
            yield unlp(root), dirs, files
    w.__mbv_lp__ = True
    return w


_ONE = ("stat", "lstat", "listdir", "mkdir", "rmdir", "remove", "unlink", "utime", "chmod", "access", "startfile", "chdir")
_TWO = ("rename", "replace", "link", "symlink")
_PATH_ONE = ("exists", "lexists", "isfile", "isdir", "islink", "getsize", "getmtime", "getatime", "getctime")


def _popen(cls):
    """subprocess: argomenti che sono percorsi lunghi (anche nella forma -o<percorso> di 7-Zip) in forma estesa."""
    orig = cls.__init__

    def fix(a):
        if isinstance(a, str) and len(a) >= LIMIT:
            if len(a) > 2 and a[1] == ":":
                return lp(a)
            if a.startswith("-o") and len(a) > 4 and a[3] == ":":
                return "-o" + lp(a[2:])
            if a.startswith("\\\\") and not a.startswith("\\\\?\\"):
                return lp(a)
        return a

    @functools.wraps(orig)
    def init(self, args, *a, **k):
        if isinstance(args, (list, tuple)):
            args = [fix(x) for x in args]
        return orig(self, args, *a, **k)
    init.__mbv_lp__ = True
    cls.__init__ = init


class _AfterImport:
    """Dopo l'import di alcune librerie in C (aprono i file da sole) si avvolgono le loro funzioni di apertura."""

    PATCH = {
        "sqlite3": lambda m: setattr(m, "connect", _wrap1(m.connect)),
        "ifcopenshell": lambda m: setattr(m, "open", _wrap1(m.open)),
        "pymupdf": lambda m: _patch_pymupdf(m),
        "fitz": lambda m: _patch_pymupdf(m),
    }

    def find_spec(self, name, path=None, target=None):
        if name not in self.PATCH:
            return None
        import importlib.util
        sys.meta_path.remove(self)
        try:
            spec = importlib.util.find_spec(name)
        finally:
            sys.meta_path.insert(0, self)
        if spec is None or spec.loader is None:
            return spec
        loader = spec.loader
        exec_orig = loader.exec_module

        def exec_module(module, _o=exec_orig, _n=name):
            _o(module)
            try:
                _AfterImport.PATCH[_n](module)
            except Exception:  # noqa: BLE001 - una libreria cambiata non deve impedire l'avvio
                pass
        try:
            loader.exec_module = exec_module
        except (AttributeError, TypeError):
            pass
        return spec


def _patch_pymupdf(m):
    D = getattr(m, "Document", None)
    if D is None or getattr(D.__init__, "__mbv_lp__", False):
        return
    init = D.__init__

    @functools.wraps(init)
    def di(self, filename=None, *a, **k):
        if isinstance(filename, (str, os.PathLike)):
            filename = lp(os.fspath(filename))
        return init(self, filename, *a, **k)
    di.__mbv_lp__ = True
    D.__init__ = di
    for meth in ("save", "ez_save"):
        f = getattr(D, meth, None)
        if f is None:
            continue

        def mk(f):
            @functools.wraps(f)
            def s(self, filename, *a, **k):
                if isinstance(filename, (str, os.PathLike)):
                    filename = lp(os.fspath(filename))
                return f(self, filename, *a, **k)
            return s
        setattr(D, meth, mk(f))


_DONE = False


def install() -> None:
    """Percorsi lunghi in tutto il processo (solo Windows; idempotente)."""
    global _DONE
    if _DONE or not IS_WIN:
        return
    _DONE = True
    import io
    import subprocess
    builtins.open = _wrap_open(builtins.open)
    io.open = builtins.open
    for n in _ONE:
        f = getattr(os, n, None)
        if f is not None and not getattr(f, "__mbv_lp__", False):
            setattr(os, n, _wrap1(f))
    for n in _TWO:
        f = getattr(os, n, None)
        if f is not None:
            setattr(os, n, _wrap2(f))
    rp = os.path.realpath
    os.path.realpath = functools.wraps(rp)(lambda p, *a, **k: unlp(rp(lp(p), *a, **k)) if lp(p) is not p else rp(p, *a, **k))
    os.scandir = _scandir(os.scandir)
    os.walk = _walk(os.walk)
    for n in _PATH_ONE:
        f = getattr(os.path, n, None)
        if f is not None:
            setattr(os.path, n, _wrap1(f))
    _popen(subprocess.Popen)
    sys.meta_path.insert(0, _AfterImport())
    for name, fn in _AfterImport.PATCH.items():  # gia' importate
        if name in sys.modules:
            try:
                fn(sys.modules[name])
            except Exception:  # noqa: BLE001
                pass
