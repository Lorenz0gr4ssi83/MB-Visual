"""Collaudo immagini: salva un'immagine di prova in ogni formato scrivibile e la riapre col motore di MB Visual."""
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from mbvisual import misc  # noqa: E402

Image = misc._pil()
reg = json.loads((ROOT / "ui" / "formats.json").read_text(encoding="utf-8"))
exts = next(c for c in reg["categories"] if c["id"] == "image")["exts"]
OUT = Path(tempfile.gettempdir()) / "MBVisual_test_img"
OUT.mkdir(exist_ok=True)
src = Image.open(ROOT / "tests" / "samples" / "immagine.png").convert("RGB")
ok, fail, nogen = [], [], []
for e in exts:
    f = OUT / f"prova.{e}"
    try:
        im = src if e not in ("xbm", "msp") else src.convert("1")
        if e in ("ico", "cur", "icns"):
            im = src.resize((256, 256))
        im.save(f)
    except Exception as ex:  # noqa: BLE001
        nogen.append(f"{e} ({str(ex)[:50]})")
        continue
    try:
        r = misc.image_to_png(str(f))
        assert r["info"]["larghezza"] > 0
        ok.append(e)
    except Exception as ex:  # noqa: BLE001
        fail.append(f"{e}: {ex}")
print("APERTI CORRETTAMENTE (%d): %s" % (len(ok), " ".join(ok)))
print("FALLITI (%d):" % len(fail), *fail, sep="\n  ")
print("NON SCRIVIBILI PER IL TEST (%d): %s" % (len(nogen), " ".join(n.split(" ")[0] for n in nogen)))
