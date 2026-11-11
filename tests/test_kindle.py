"""Libri Kindle e Calibre -> EPUB (mbvisual/kindle.py). Uso: python tests/test_kindle.py <cartella con .mobi/.azw3/.htmlz/.txtz>
Campioni pubblici: Project Gutenberg (https://www.gutenberg.org/ebooks/<n>.kindle.images = MOBI 6, <n>.kf8.images = AZW3/KF8).
Controlla: XHTML ben formato in ogni parte, testo non scritto come markup, immagini incluse, nessun riferimento kindle: rimasto."""
import os
import re
import sys
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lxml import etree  # noqa: E402

from mbvisual import kindle  # noqa: E402

ok = bad = 0
d = sys.argv[1]
for f in sorted(os.listdir(d)):
    if not f.lower().endswith((".mobi", ".azw", ".azw3", ".kf8", ".prc", ".htmlz", ".txtz")):
        continue
    try:
        r = kindle.to_epub(os.path.join(d, f))
        z = zipfile.ZipFile(r["path"])
        parts = [n for n in z.namelist() if n.endswith(".xhtml") and not n.endswith("nav.xhtml")]
        text = ""
        for n in parts:
            x = z.read(n)
            etree.fromstring(x)
            text += x.decode("utf-8")
        words = len(re.sub(r"<[^>]+>", " ", text).split())
        assert parts and words > 3, "vuoto"
        assert "&lt;p" not in text and "kindle:" not in text, "markup o riferimenti kindle rimasti"
        imgs = sum(1 for n in z.namelist() if re.search(r"\.(jpg|png|gif)$", n))
        print(f"OK  {f}: {len(parts)} parti, {words} parole, {imgs} immagini")
        ok += 1
    except Exception as e:  # noqa: BLE001
        print(f"NO  {f}: {e}")
        bad += 1
print(f"{ok} libri convertiti, {bad} con errori")
sys.exit(1 if bad else 0)
