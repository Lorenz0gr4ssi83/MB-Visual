"""EPS senza Ghostscript (mbvisual/eps.py). Uso: python tests/test_eps.py <cartella Tests/images di Pillow (MIT-CMU)>
Confronta l'immagine estratta con i riferimenti di Pillow: eps/1.bmp per i tre EPS di Photoshop (bitmap ASCII85) e pil_sample_cmyk.jpg
per l'EPS CMYK; le anteprime TIFF di Illustrator devono esserci, gli EPS solo vettoriali devono dare None (restano testo)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from PIL import Image, ImageChops, ImageStat  # noqa: E402

from mbvisual import eps  # noqa: E402

d = sys.argv[1]
ok = bad = 0


def check(c, m):
    global ok, bad
    ok += bool(c)
    bad += not c
    if not c:
        print("NO", m)


def diff(a, b):
    return max(ImageStat.Stat(ImageChops.difference(a, b)).mean)


ref = Image.open(os.path.join(d, "eps", "1.bmp")).convert("L")
for f in ("1.eps", "1_boundingbox_after_imagedata.eps", "1_second_imagedata.eps"):
    im, how = eps.to_image(os.path.join(d, "eps", f))
    check(how == "imagedata" and diff(ref, im.convert("L")) < 0.5, f)
im, how = eps.to_image(os.path.join(d, "eps", "pil_sample_cmyk.eps"))
check(how == "imagedata" and diff(Image.open(os.path.join(d, "pil_sample_cmyk.jpg")).convert("RGB"), im.convert("RGB")) < 2, "CMYK")
for f in ("illu10_preview.eps", "illuCS6_preview.eps", "binary_preview_map.eps"):
    im, how = eps.to_image(os.path.join(d, "eps", f))
    check(how == "anteprima" and im.size[0] > 100, f)
for f in ("illu10_no_preview.eps", "illuCS6_no_preview.eps", "zero_bb.eps", "non_zero_bb.eps"):
    check(eps.to_image(os.path.join(d, "eps", f)) == (None, None), f + " senza immagine")
print(f"{ok} prove riuscite, {bad} fallite")
sys.exit(1 if bad else 0)
