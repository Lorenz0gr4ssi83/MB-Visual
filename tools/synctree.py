"""Copia incrementale di una cartella in un'altra sincronizzata con OneDrive.

Scrive SOLO i file il cui contenuto e' cambiato e toglie quelli che non esistono piu'. robocopy guarda la data:
dopo ogni build tutti i file hanno una data nuova e verrebbero riscritti tutti (migliaia di file da ricaricare su
OneDrive ogni volta, che cosi' non finisce mai di sincronizzare e gli altri PC restano indietro).
"""
import hashlib
import os
import shutil
from pathlib import Path


def _digest(p: Path) -> bytes:
    h = hashlib.blake2b(digest_size=20)
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.digest()


def sync_tree(src: Path, dst: Path, keep: tuple[str, ...] = ()) -> dict:
    """Allinea dst a src. keep: nomi (relativi a dst, con /) da non cancellare anche se assenti in src."""
    src, dst = Path(src), Path(dst)
    dst.mkdir(parents=True, exist_ok=True)
    wanted = set()
    copied = skipped = removed = 0
    copied_bytes = 0
    for dp, _dn, fn in os.walk(src):
        rel_dir = Path(dp).relative_to(src)
        for n in fn:
            rel = (rel_dir / n).as_posix()
            wanted.add(rel)
            s, d = Path(dp) / n, dst / rel_dir / n
            if d.is_file():
                try:
                    if d.stat().st_size == s.stat().st_size and _digest(d) == _digest(s):
                        skipped += 1
                        continue
                except OSError:
                    pass
            d.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(s, d)
            copied += 1
            copied_bytes += s.stat().st_size
    for dp, dn, fn in os.walk(dst, topdown=False):
        rel_dir = Path(dp).relative_to(dst)
        for n in fn:
            rel = (rel_dir / n).as_posix()
            if rel not in wanted and rel not in keep:
                try:
                    (Path(dp) / n).unlink()
                    removed += 1
                except OSError:
                    pass
        for n in dn:
            try:
                (Path(dp) / n).rmdir()  # solo se vuota
            except OSError:
                pass
    return {"copiati": copied, "invariati": skipped, "tolti": removed, "mb_copiati": round(copied_bytes / 1048576, 1)}
