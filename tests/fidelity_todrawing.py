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


def text_zones(page, doc, shape, dpi, w_mm, h_mm):
    """Zone dei testi in pixel (PDF: testi visibili e riquadri dei commenti SHX; DXF: ingombro di TEXT/MTEXT). La forma delle
    lettere dipende dal carattere (gli SHX di AutoCAD non sono disponibili): i testi si misurano a parte, non a pixel."""
    from ezdxf import bbox
    Z = np.zeros(shape, bool)
    k = dpi / 72
    m = page.rotation_matrix

    def put(x0, y0, x1, y1, grow=2):
        a, b = int(max(0, min(x0, x1) - grow)), int(max(0, min(y0, y1) - grow))
        c, d = int(min(shape[1], max(x0, x1) + grow + 1)), int(min(shape[0], max(y0, y1) + grow + 1))
        if c > a and d > b:
            Z[b:d, a:c] = True
    for sp in page.get_texttrace():
        if sp.get("type") == 3 or sp.get("opacity") == 0:
            continue
        r = pymupdf.Rect(sp["bbox"]) * m
        put(r.x0 * k, r.y0 * k, r.x1 * k, r.y1 * k)
    for a in page.annots() or []:
        if (a.info.get("title") or "") == "AutoCAD SHX Text":
            r = a.rect * m
            put(r.x0 * k, r.y0 * k, r.x1 * k, r.y1 * k)
    q = dpi / 25.4
    for e in doc.modelspace():
        if e.dxftype() not in ("TEXT", "MTEXT"):
            continue
        lay = doc.layers.get(e.dxf.layer)
        if lay is not None and lay.is_off():
            continue
        try:
            b = bbox.extents([e], fast=True)
        except Exception:  # noqa: BLE001
            continue
        if b.has_data:
            put(b.extmin.x * q, (h_mm - b.extmax.y) * q, b.extmax.x * q, (h_mm - b.extmin.y) * q)
    return Z


def image_zones_and_check(page, doc, shape, dpi, h_mm):
    """Immagini: zone escluse dal confronto a pixel (il ricampionamento dipende dal programma che le mostra) e controllo
    esatto: per ogni immagine del PDF un IMAGE del DXF con gli angoli entro 0,1 mm."""
    Z = np.zeros(shape, bool)
    k = dpi / 72
    m = page.rotation_matrix
    mm = 25.4 / 72
    dxf_imgs = []
    for e in doc.modelspace():
        if e.dxftype() == "IMAGE":
            w, h = e.dxf.image_size[0], e.dxf.image_size[1]
            o, u, v = e.dxf.insert, e.dxf.u_pixel, e.dxf.v_pixel
            cs = [(o[0] + u[0] * a + v[0] * b, o[1] + u[1] * a + v[1] * b) for a, b in ((0, 0), (w, 0), (w, h), (0, h))]
            dxf_imgs.append(sorted((round(x, 1), round(y, 1)) for x, y in cs))
    ok = tot = 0
    for inf in page.get_image_info():
        r = pymupdf.Rect(inf["bbox"]) * m
        if r.is_empty or abs(r) < 1:
            continue
        tot += 1
        a, b = int(max(0, r.x0 * k - 2)), int(max(0, r.y0 * k - 2))
        c, d = int(min(shape[1], r.x1 * k + 3)), int(min(shape[0], r.y1 * k + 3))
        Z[b:d, a:c] = True
        t = pymupdf.Matrix(inf["transform"]) * m
        cs = [pymupdf.Point(x, y) * t for x, y in ((0, 0), (1, 0), (1, 1), (0, 1))]
        want = sorted((x * mm, h_mm - y * mm) for x, y in ((q.x, q.y) for q in cs))
        if any(all(abs(p[0] - q[0]) <= 0.15 and abs(p[1] - q[1]) <= 0.15 for p, q in zip(want, got)) for got in dxf_imgs):
            ok += 1
    return Z, (ok, tot)


def lost_pieces(mask, cell=4, min_px=3):
    """Pezzi persi: gruppi connessi di celle 4x4 con almeno 3 pixel persi."""
    H, W = mask.shape
    h, w = H // cell, W // cell
    c = mask[:h * cell, :w * cell].reshape(h, cell, w, cell).sum(axis=(1, 3)) >= min_px
    seen = np.zeros_like(c)
    n = 0
    for y, x in zip(*np.nonzero(c)):
        if seen[y, x]:
            continue
        n += 1
        st = [(y, x)]
        seen[y, x] = True
        while st:
            a, b = st.pop()
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    yy, xx = a + dy, b + dx
                    if 0 <= yy < h and 0 <= xx < w and c[yy, xx] and not seen[yy, xx]:
                        seen[yy, xx] = True
                        st.append((yy, xx))
    return n


def shx_check(page, doc, h_mm):
    """Testi SHX: ogni commento "AutoCAD SHX Text" deve avere un TEXT/MTEXT con lo stesso contenuto dentro il suo riquadro."""
    m = page.rotation_matrix
    H = page.rect.height
    ann = []
    for a in page.annots() or []:
        if (a.info.get("title") or "") == "AutoCAD SHX Text":
            r = a.rect * m
            ann.append(((a.info.get("content") or "").strip(), r))
    if not ann:
        return None
    texts = []
    for e in doc.modelspace():
        if e.dxftype() == "TEXT":
            s, p = e.dxf.text, e.dxf.insert
        elif e.dxftype() == "MTEXT":
            s, p = e.plain_text(), e.dxf.insert
        else:
            continue
        texts.append((" ".join(s.split()), p[0] / 25.4 * 72, H - p[1] / 25.4 * 72))
    ok = 0
    for s, r in ann:
        s = " ".join(s.split())
        g = r + (-3, -3, 3, 3)
        if any(t == s and g.contains(pymupdf.Point(x, y)) for t, x, y in texts):
            ok += 1
    return ok, len(ann)


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
    with pymupdf.open(src) as d:
        page = d[pg]
        tz = dilate(text_zones(page, doc, ref.shape, dpi, w_mm, h_mm), 1)
        shx = shx_check(page, doc, h_mm)
        iz, imgs = image_zones_and_check(page, doc, ref.shape, dpi, h_mm)
        tz |= iz
    ga, gb = ref & ~tz, got & ~tz
    g_rec = float((ga & db).sum() / ga.sum()) if ga.sum() else 1.0
    g_prec = float((gb & da).sum() / gb.sum()) if gb.sum() else 1.0
    persi = lost_pieces(ga & ~db)
    inpiu = lost_pieces(gb & ~da)
    from PIL import Image
    gi = np.full(ref.shape + (3,), 255, np.uint8)
    gi[tz] = (255, 246, 205)  # zone dei testi e delle immagini (misurati a parte)
    gi[(ga & db) | (gb & da)] = (150, 150, 150)
    gi[ga & ~db] = (230, 30, 30)
    gi[gb & ~da] = (30, 90, 230)
    Image.fromarray(gi).save(out / (name + "_geometria.png"))
    wd = words_dxf(doc)
    tot = sum(wp.values())
    found = sum(min(n, wd.get(k, 0)) for k, n in wp.items())
    diff_image(ref, got, da, db, out / (name + "_confronto.png"))
    types = Counter(e.dxftype() for e in doc.modelspace())
    r = {"file": Path(src).name, "page": pg + 1, "time_s": round(dt, 2), "recall": round(rec, 4), "precision": round(prec, 4),
         "words_pdf": tot, "words_found": found, "text_recall": round(found / tot, 4) if tot else 1.0,
         "entities": dict(types.most_common()), "layers": len(doc.layers), "skipped": res.get("skipped", 0),
         "geo_recall": round(g_rec, 4), "geo_precision": round(g_prec, 4), "geo_lost_pieces": persi, "geo_extra_pieces": inpiu,
         "shx_ok": shx[0] if shx else None, "shx_total": shx[1] if shx else None, "method": res.get("methods"),
         "img_ok": imgs[0], "img_total": imgs[1]}
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
            low = a.soglia and (r["geo_recall"] < a.soglia or r["geo_precision"] < a.soglia or r.get("skipped"))
            bad += bool(low)
            shx = f"  SHX {r['shx_ok']}/{r['shx_total']}" if r.get("shx_total") else ""
            shx += f"  immagini {r['img_ok']}/{r['img_total']}" if r.get("img_total") else ""
            shx += f"  SCARTATI {r['skipped']}" if r.get("skipped") else ""
            print(f"{f.name[:44]:44} p{pg + 1:<3} geometria {r['geo_recall']:.4f}/{r['geo_precision']:.4f} persi {r['geo_lost_pieces']} in piu' "
                  f"{r['geo_extra_pieces']}  tutto {r['recall']:.3f}/{r['precision']:.3f}  testi {r['words_found']}/{r['words_pdf']}{shx}"
                  f"  {r['time_s']:6.2f} s  {sum(r['entities'].values())} entita'{'  <-- SOTTO SOGLIA' if low else ''}")
    (out / "fedelta.json").write_text(json.dumps(rows, indent=1, ensure_ascii=False), encoding="utf-8")
    ok = [r for r in rows if "error" not in r]
    if ok:
        print(f"MEDIA geometria {np.mean([r['geo_recall'] for r in ok]):.4f}/{np.mean([r['geo_precision'] for r in ok]):.4f}  "
              f"MINIMO geometria {min(r['geo_recall'] for r in ok):.4f}/{min(r['geo_precision'] for r in ok):.4f}  "
              f"richiamo {np.mean([r['recall'] for r in ok]):.3f}  precisione {np.mean([r['precision'] for r in ok]):.3f}  "
              f"testi {np.mean([r['text_recall'] for r in ok]):.3f}  tempo totale {sum(r['time_s'] for r in ok):.1f} s")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
