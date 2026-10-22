"""Cifratura dei segreti salvati su disco (token degli archivi cloud, password della marca temporale).

Windows: i moduli usano DPAPI (legata all'utente di Windows) come sempre. Fuori da Windows: Fernet (cryptography) con
una chiave casuale tenuta nel Portachiavi del Mac (comando `security`, voce "MB Visual"); dove il Portachiavi non c'e'
(Linux) la chiave sta in un file leggibile solo dall'utente nella cartella dei dati.
"""
import base64
import os
import subprocess

from .paths import DATA_DIR, IS_MAC

_SERVICE = "MB Visual"
_cache: dict = {}


def _keychain_get(account: str):
    r = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", _SERVICE, "-a", account, "-w"],
                       capture_output=True, text=True, timeout=30)
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else None


def _keychain_set(account: str, value: str) -> None:
    subprocess.run(["/usr/bin/security", "add-generic-password", "-U", "-s", _SERVICE, "-a", account, "-w", value],
                   check=True, capture_output=True, timeout=30)


def _key(account: str) -> bytes:
    if account in _cache:
        return _cache[account]
    from cryptography.fernet import Fernet
    key = None
    if IS_MAC:
        key = _keychain_get(account)
        if not key:
            key = Fernet.generate_key().decode()
            _keychain_set(account, key)
    else:
        f = DATA_DIR / f".{account}.key"
        try:
            key = f.read_text(encoding="ascii").strip()
        except OSError:
            key = Fernet.generate_key().decode()
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="ascii") as fh:
                fh.write(key)
    _cache[account] = key.encode()
    return _cache[account]


def protect(data: bytes, account: str = "segreti") -> bytes:
    from cryptography.fernet import Fernet
    return Fernet(_key(account)).encrypt(data)


def unprotect(data: bytes, account: str = "segreti") -> bytes:
    from cryptography.fernet import Fernet
    return Fernet(_key(account)).decrypt(data)


def protect_text(text: str, account: str = "segreti") -> str:
    return base64.b64encode(protect(text.encode("utf-8"), account)).decode()


def unprotect_text(blob: str, account: str = "segreti") -> str:
    return unprotect(base64.b64decode(blob), account).decode("utf-8")
