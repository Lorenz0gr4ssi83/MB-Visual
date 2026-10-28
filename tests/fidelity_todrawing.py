"""Fedelta' di "Converti in disegno" su tavole PDF vere: PDF -> DXF -> DXF ridisegnato sopra la pagina, pixel per pixel.

Per ogni pagina:
- inchiostro del PDF (pagina resa senza annotazioni) e del DXF ridisegnato con ezdxf alla stessa scala (1:1, mm di carta);
- richiamo = inchiostro del PDF ritrovato nel DXF (entro `--tol` pixel), precisione = inchiostro del DXF che sta sul PDF;
- testi: parole del PDF ritrovate come testo del DXF (anche SHX ricostruiti), per contenuto;
- tempo di conversione, entita' per tipo, layer;
- immagine di confronto: grigio = uguale, rosso = solo nel PDF (perso), blu = solo nel DXF (in piu').
Uso: python tests/fidelity_todrawing.py <pdf o cartella>... [--out cartella] [--dpi 100] [--tol 2] [--pages 1-3]
     [--soglia 0.97] (uscita 1 se una pagina ha richiamo o precisione sotto la soglia)
"""
import argparse
import json
import re
import sys
import time
from collections import Counter
from pathlib import Path

import os  # noqa: E402

ROOT = Path(os.environ.get("MBV_FEDELTA_RADICE") or Path(__file__).resolve().parents[1])  # radice alternativa = versione da confrontare
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402

# come nell'app impacchettata (build_portable esclude pymupdf.layout/pymupdf4llm): senza, PyMuPDF carica modelli ONNX
sys.modules.setdefault("pymupdf.layout", None)
sys.modules.setdefault("pymupdf4llm", None)
import pymupdf  # noqa: E402

from mbvisual import todrawing  # noqa: E402

WORD = re.compile(r"[0-9A-Za-zÀ-ÿ]+")


def ink_pdf(page, dpi):
    pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY, alpha=False, annots=False)
    a = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width)
    return a < 235


def ink_dxf(path, w_mm, h_mm, shape, dpi):
    import ezdxf
    from ezdxf.addons.drawing import Frontend, RenderContext, layout
    from ezdxf.addons.drawing.config import BackgroundPolicy, ColorPolicy, Configuration, LineweightPolicy
    from ezdxf.addons.drawing.pymupdf import PyMuPdfBackend
    from ezdxf.math import BoundingBox2d
    doc = ezdxf.readfile(path)
    be = PyMuPdfBackend()
    cfg = Configuration(background_policy=BackgroundPolicy.WHITE, color_policy=ColorPolicy.COLOR, lineweight_policy=LineweightPolicy.ABSOLUTE)
    Frontend(RenderContext(doc), be, config=cfg).draw_layout(doc.modelspace())
    pg = layout.Page(w_mm, h_mm, layout.Units.mm)
    st = layout.Settings(fit_page=False, scale=1)
    data = be.get_pdf_bytes(pg, settings=st, render_box=BoundingBox2d([(0, 0), (w_mm, h_mm)]))
    with pymupdf.open("pdf", data) as d:
        p = d[0]
        z = shape[1] / p.rect.width
        pix = p.get_pixmap(matrix=pymupdf.Matrix(z, z), colorspace=pymupdf.csGRAY, alpha=False)
        a = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width)
    out = np.zeros(shape, bool)
    h, w = min(shape[0], a.shape[0]), min(shape[1], a.shape[1])
    out[:h, :w] = a[:h, :w] < 235
    return out, doc


def dilate(m, r):
    if r <= 0:
        return m
    o = m.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx * dx + dy * dy > r * r:
                continue
            s = np.roll(np.roll(m, dy, 0), dx, 1)
            o |= s
    return o


def words_pdf(page):
    out = Counter()
    for w in page.get_text("words"):
        for x in WORD.findall(w[4]):
            out[x.upper()] += 1
    return out


def words_dxf(doc):
    out = Counter()
    for e in doc.modelspace():
        t = e.dxftype()
        if t == "TEXT":
            s = e.dxf.text
        elif t == "MTEXT":
            s = e.plain_text()
        else:
            continue
        layer = doc.layers.get(e.dxf.layer)
        if layer is not None and layer.is_off():
            continue
        for x in WORD.findall(s):
            out[x.upper()] += 1
    return out


def compare(a, b, tol):
    da, db = dilate(a, tol), dilate(b, tol)
    na, nb = int(a.sum()), int(b.sum())
    rec = float((a & db).sum() / na) if na else 1.0
    prec = float((b & da).sum() / nb) if nb else (1.0 if not na else 0.0)
    return rec, prec, da, db


def diff_image(a, b, da, db, path):
    from PIL import Image
    img = np.full(a.shape + (3,), 255, np.uint8)
    img[a & db] = (150, 150, 150)
    img[b & da & ~a] = (150, 150, 150)
    img[a & ~db] = (230, 30, 30)
    img[b & ~da] = (30, 90, 230)
    Image.fromarray(img).save(path)


def run_page(src, pg, out, dpi, tol, opts):
    with pymupdf.open(src) as d:
        page = d[pg]
        ref = ink_pdf(page, dpi)
        wp = words_pdf(page)
        w_mm, h_mm = page.rect.width * 25.4 / 72, page.rect.height * 25.4 / 72
    name = f"{Path(src).stem[:40]}_p{pg + 1}"
    dxf = out / (name + ".dxf")
    t0 = time.perf_counter()
    res = todrawing.convert(src, str(dxf), {"pages": [pg], "scale": 1, "units": "mm", **opts})
    dt = time.perf_counter() - t0
    got, doc = ink_dxf(str(dxf), w_mm, h_mm, ref.shape, dpi)
    rec, prec, da, db = compare(ref, got, tol)
    wd = words_dxf(doc)
    tot = sum(wp.values())
    found = sum(min(n, wd.get(k, 0)) for k, n in wp.items())
    diff_image(ref, got, da, db, out / (name + "_confronto.png"))
    types = Counter(e.dxftype() for e in doc.modelspace())
    r = {"file": Path(src).name, "page": pg + 1, "time_s": round(dt, 2), "recall": round(rec, 4), "precision": round(prec, 4),
         "words_pdf": tot, "words_found": found, "text_recall": round(found / tot, 4) if tot else 1.0,
         "entities": dict(types.most_common()), "layers": len(doc.layers), "skipped": res.get("skipped", 0)}
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", nargs="+")
    ap.add_argument("--out", default=None)
    ap.add_argument("--dpi", type=int, default=100)
    ap.add_argument("--tol", type=int, default=2)
    ap.add_argument("--pages", default="all")
    ap.add_argument("--max-pages", type=int, default=6)
    ap.add_argument("--soglia", type=float, default=0)
    ap.add_argument("--opts", default="{}")
    a = ap.parse_args()
    out = Path(a.out or (Path.cwd() / "fedelta"))
    out.mkdir(parents=True, exist_ok=True)
    files = []
    for s in a.src:
        p = Path(s)
        files += sorted(p.glob("*.pdf")) if p.is_dir() else [p]
    rows, bad = [], 0
    for f in files:
        try:
            with pymupdf.open(f) as d:
                n = len(d)
        except Exception as e:  # noqa: BLE001
            print("ERR", f, e)
            continue
        pages = todrawing._pages(a.pages, n)[: a.max_pages]
        for pg in pages:
            try:
                r = run_page(str(f), pg, out, a.dpi, a.tol, json.loads(a.opts))
            except Exception as e:  # noqa: BLE001
                import traceback
                traceback.print_exc()
                r = {"file": f.name, "page": pg + 1, "error": str(e)}
            rows.append(r)
            if "error" in r:
                bad += 1
                print(f"{f.name[:44]:44} p{pg + 1:<3} ERRORE {r['error']}")
                continue
            low = a.soglia and (r["recall"] < a.soglia or r["precision"] < a.soglia)
            bad += bool(low)
            print(f"{f.name[:44]:44} p{pg + 1:<3} richiamo {r['recall']:.3f}  precisione {r['precision']:.3f}  testi {r['words_found']}/{r['words_pdf']}"
                  f"  {r['time_s']:6.2f} s  {sum(r['entities'].values())} entita'{'  <-- SOTTO SOGLIA' if low else ''}")
    (out / "fedelta.json").write_text(json.dumps(rows, indent=1, ensure_ascii=False), encoding="utf-8")
    ok = [r for r in rows if "error" not in r]
    if ok:
        print(f"MEDIA richiamo {np.mean([r['recall'] for r in ok]):.3f}  precisione {np.mean([r['precision'] for r in ok]):.3f}  "
              f"testi {np.mean([r['text_recall'] for r in ok]):.3f}  tempo totale {sum(r['time_s'] for r in ok):.1f} s")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
