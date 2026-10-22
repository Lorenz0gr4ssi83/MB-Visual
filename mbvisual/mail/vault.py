"""Cassaforte della posta: chiave AES-256 protetta con DPAPI (legata all'utente di Windows) e cifratura AES-GCM
di messaggi, indice e segreti degli account.

- %LOCALAPPDATA%/MBVisual/posta/chiave.bin = chiave casuale di 32 byte cifrata con DPAPI
- blob cifrati: b"MBV1" + nonce(12) + AES-GCM(zlib(dati)), dati autenticati = etichetta del blob
Un altro utente di Windows (o un altro PC) non puo' leggere niente: senza la chiave DPAPI i file sono illeggibili.
"""
import os
import secrets
import threading
import zlib
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from ..cloud import _dpapi  # DPAPI su Windows, chiave nel Portachiavi sul Mac (mbvisual/secret.py)
from ..paths import DATA_DIR as _DATA_DIR

DATA_DIR = Path(os.environ.get("MBV_MAIL_DIR") or (_DATA_DIR / "posta"))
KEY_FILE = DATA_DIR / "chiave.bin"
MAGIC = b"MBV1"
_LOCK = threading.Lock()
_KEY = None


def key() -> bytes:
    global _KEY
    with _LOCK:
        if _KEY is None:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            if KEY_FILE.exists():
                _KEY = _dpapi(KEY_FILE.read_bytes(), False)
            else:
                k = secrets.token_bytes(32)
                tmp = KEY_FILE.with_suffix(".tmp")
                tmp.write_bytes(_dpapi(k, True))
                os.replace(tmp, KEY_FILE)
                _KEY = k
        return _KEY


def seal(data: bytes, label: bytes = b"", level: int = 6) -> bytes:
    nonce = secrets.token_bytes(12)
    return MAGIC + nonce + AESGCM(key()).encrypt(nonce, zlib.compress(data, level), label)


def open_(blob: bytes, label: bytes = b"") -> bytes:
    if blob[:4] != MAGIC:
        raise ValueError("blob non riconosciuto")
    return zlib.decompress(AESGCM(key()).decrypt(blob[4:16], blob[16:], label))


def write(path: Path, data: bytes, label: bytes = b""):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(seal(data, label))
    os.replace(tmp, path)


def read(path: Path, label: bytes = b"") -> bytes:
    return open_(path.read_bytes(), label)
