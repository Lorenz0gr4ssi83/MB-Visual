"""Traduzioni dei testi restituiti dal motore (errori, avanzamento, etichette).

Stessi file di lingua dell'interfaccia (ui/i18n/<lingua>.json, chiavi "srv_*"). La lingua la manda l'interfaccia
in ogni richiesta (intestazione X-MBV-Lang, vedi ui/js/core.js `api`): un solo utente per server, quindi basta una
lingua corrente globale, che vale anche per i lavori in background avviati da quella richiesta.

    from .i18n import t
    raise RuntimeError(t("srv_convert.formato_non_supportato", ext))   # testo it.json: "Formato {0} non supportato"
"""
from __future__ import annotations

import ctypes
import json
import locale
import sys
import threading

from .paths import UI_DIR

LANGS = ("it", "en", "es", "fr", "de")
_CACHE: dict[str, dict] = {}
_LOCK = threading.Lock()
_LANG = "it"


def windows_language() -> str:
    """Lingua dell'interfaccia del sistema (es. "en-US"; sul Mac la prima delle lingue preferite); "" se non si legge."""
    if sys.platform == "darwin":
        try:
            import re
            import subprocess
            out = subprocess.run(["/usr/bin/defaults", "read", "-g", "AppleLanguages"], capture_output=True, text=True, timeout=5).stdout
            m = re.search(r'"?([a-z]{2}(?:-[A-Za-z]+)*)"?', out.split("(", 1)[-1])
            return m.group(1) if m else ""
        except Exception:  # noqa: BLE001
            return ""
    try:
        lcid = ctypes.windll.kernel32.GetUserDefaultUILanguage()
        name = locale.windows_locale.get(lcid, "")
        return name.replace("_", "-")
    except Exception:  # noqa: BLE001
        return ""


def _load(code: str) -> dict:
    with _LOCK:
        if code not in _CACHE:
            try:
                _CACHE[code] = json.loads((UI_DIR / "i18n" / f"{code}.json").read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                _CACHE[code] = {}
        return _CACHE[code]


def set_language(code: str | None) -> None:
    global _LANG
    code = (code or "").lower()[:2]
    if code in LANGS:
        _LANG = code


def language() -> str:
    return _LANG


def t(key: str, *args, **kw) -> str:
    """Testo nella lingua corrente; se manca: inglese, poi italiano, poi la chiave. {0}, {1}... o {nome} si sostituiscono."""
    text = _load(_LANG).get(key)
    if text is None and _LANG != "it":
        text = _load("en").get(key)
    if text is None:
        text = _load("it").get(key, key)
    if args or kw:
        try:
            text = text.format(*args, **kw)
        except (IndexError, KeyError, ValueError):
            pass
    return text
