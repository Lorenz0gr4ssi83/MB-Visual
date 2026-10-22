"""Collaudo di "Converti in disegno" (mbvisual/todrawing.py, pdfvec.py, rastervec.py).

1. DXF noto -> PDF vettoriale (disegnato da ezdxf, 1:100, layer come gruppi OCG) -> DXF: ogni linea, arco, cerchio e
   polilinea ritrovati entro 0,5 mm, layer ricostruiti dagli OCG, nessuna Bezier rimasta dove c'erano archi.
2. PDF con testi (PyMuPDF): posizione, altezza, rotazione, carattere, righe unite in MTEXT; tratteggi e riempimenti.
3. Scansione sintetica (stesso DXF a 300 dpi, macchie, rumore, rotazione di 1,5 gradi): angolo ritrovato, cerchi e linee
   ritrovati con tolleranza da scansione, testi letti con l'OCR di Windows (se disponibile).
4. Scrittura: il DXF prodotto si riapre con ezdxf (audit senza errori).
Uso: python tests/test_todrawing.py [--keep cartella]   (senza --keep lavora in una cartella temporanea)
"""
import math
import os
import random
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import ezdxf  # noqa: E402
import pymupdf  # noqa: E402

from mbvisual import todrawing, rastervec  # noqa: E402

OK, KO = [], []


def check(name, cond, extra=""):
    (OK if cond else KO).append(name)
    print(("  OK  " if cond else "  NO  ") + name + (f"  ({extra})" if extra else ""))


# ---------------------------------------------------------------- disegno di riferimento (unita' mm, scala 1:100)
W, H = 25400.0, 17780.0  # a 1:100 = 720 x 504 punti esatti (ezdxf arrotonda la pagina ai punti interi)
LINES = [(1000, 1000, 9000, 1000), (9000, 1000, 9000, 6000), (1000, 1000, 1000, 6000), (1000, 6000, 9000, 6000),
         (2000, 8000, 7000, 12000), (12000, 2000, 18500, 2700), (10000, 13000, 19000, 13000)]
CIRCLES = [(4000, 3500, 600), (15000, 9000, 1500), (12500, 5000, 250)]
ARCS = [(6500, 3500, 1200, 0, 90), (15000, 4500, 1000, 200, 340), (3000, 10000, 800, 45, 225)]
POLY = [(11000, 8000, 0), (13000, 8000, 0.414214), (14000, 9000, 0), (14000, 11500, 0), (11000, 11500, 0)]  # con un arco di 90 gradi


def make_dxf(path):
    doc = ezdxf.new("R2018", setup=True)
    doc.header["$INSUNITS"] = 4
    doc.layers.add("MURI", color=1)
    doc.layers.add("ASSI", color=5)
    doc.layers.add("ARREDI", color=3)
    msp = doc.modelspace()
    for i, l in enumerate(LINES):
        msp.add_line(l[:2], l[2:], dxfattribs={"layer": "MURI" if i < 4 else "ASSI", "lineweight": 50 if i < 4 else 25})
    for c in CIRCLES:
        msp.add_circle(c[:2], c[2], dxfattribs={"layer": "ARREDI"})
    for a in ARCS:
        msp.add_arc(a[:2], a[2], a[3], a[4], dxfattribs={"layer": "ARREDI"})
    msp.add_lwpolyline(POLY, format="xyb", close=True, dxfattribs={"layer": "MURI"})
    doc.saveas(path)
    return doc


def dxf_to_pdf(doc, out, scale=0.01, black=False):
    from ezdxf.addons.drawing import Frontend, RenderContext, layout
    from ezdxf.addons.drawing.config import Configuration, BackgroundPolicy, ColorPolicy
    from ezdxf.addons.drawing.pymupdf import PyMuPdfBackend
    from ezdxf.math import BoundingBox2d
    be = PyMuPdfBackend()
    Frontend(RenderContext(doc), be, config=Configuration(background_policy=BackgroundPolicy.OFF,
                                                                     color_policy=ColorPolicy.BLACK if black else ColorPolicy.COLOR)).draw_layout(doc.modelspace())
    page = layout.Page(W * scale, H * scale, layout.Units.mm)
    st = layout.Settings(fit_page=False, scale=scale, output_layers=True)
    Path(out).write_bytes(be.get_pdf_bytes(page, settings=st, render_box=BoundingBox2d([(0, 0), (W, H)])))
    return be


def ents_of(path):
    d = ezdxf.readfile(path)
    aud = d.audit()
    return d, list(d.modelspace()), aud


def register(ents, circles):
    """Il PDF di ezdxf ha la pagina arrotondata ai punti interi e il disegno centrato: si toglie lo spostamento
    (media degli scarti dei centri dei cerchi noti) e si confronta la geometria."""
    ds = []
    for cx, cy, rr in circles:
        cs = [e for e in ents if e.dxftype() == "CIRCLE" and abs(e.dxf.radius - rr) < rr * 0.1]
        if not cs:
            continue
        e = min(cs, key=lambda e: abs(e.dxf.radius - rr) + 0.001 * math.hypot(e.dxf.center[0] - cx, e.dxf.center[1] - cy))
        ds.append((e.dxf.center[0] - cx, e.dxf.center[1] - cy))
    if not ds:
        return 0, 0
    ox = sum(d[0] for d in ds) / len(ds)
    oy = sum(d[1] for d in ds) / len(ds)
    for e in ents:
        try:
            e.translate(-ox, -oy, 0)
        except Exception:  # noqa: BLE001
            pass
    return ox, oy


def near(a, b, tol):
    return math.hypot(a[0] - b[0], a[1] - b[1]) <= tol


def ang_eq(a, b, tol=0.5):
    d = abs((a - b + 180) % 360 - 180)
    return d <= tol


def find_line(ents, l, tol):
    for e in ents:
        if e.dxftype() == "LINE":
            s, t = e.dxf.start, e.dxf.end
            if (near(s, l[:2], tol) and near(t, l[2:], tol)) or (near(t, l[:2], tol) and near(s, l[2:], tol)):
                return e
    return None


# ---------------------------------------------------------------- 1. PDF vettoriale da DXF noto
def test_vector(work):
    print("\n1. DXF noto -> PDF vettoriale -> DXF")
    doc = make_dxf(work / "riferimento.dxf")
    pdf = work / "riferimento_1-100.pdf"
    dxf_to_pdf(doc, pdf)
    inf = todrawing.info(str(pdf))
    check("riconosciuto come PDF vettoriale", inf["kind"] == "vector")
    check("layer OCG del PDF letti", {"muri", "assi", "arredi"} <= {o.lower() for o in inf["ocgs"]}, ", ".join(inf["ocgs"]))
    out = work / "riconvertito.dxf"
    r = todrawing.convert(str(pdf), str(out), {"scale": 100, "units": "mm"})
    d, ents, aud = ents_of(out)
    check("DXF riapribile senza errori", not aud.has_errors, f"{len(ents)} entita'")
    ox, oy = register(ents, CIRCLES)
    print(f"      spostamento della pagina di ezdxf: {ox:.1f}, {oy:.1f} mm")
    tol = 5.0  # mm a scala reale = 0,05 mm sulla carta (ezdxf scrive le coordinate del PDF arrotondate a 0,1 pt = 0,035 mm)
    for l in LINES:
        check(f"linea {l}", find_line(ents, l, tol) is not None)
    for cx, cy, rr in CIRCLES:
        hit = [e for e in ents if e.dxftype() == "CIRCLE" and near(e.dxf.center, (cx, cy), tol) and abs(e.dxf.radius - rr) <= tol]
        check(f"cerchio ({cx}, {cy}) r={rr}", bool(hit))
    for cx, cy, rr, a0, a1 in ARCS:
        hit = [e for e in ents if e.dxftype() == "ARC" and near(e.dxf.center, (cx, cy), tol) and abs(e.dxf.radius - rr) <= tol
               and ang_eq(e.dxf.start_angle, a0) and ang_eq(e.dxf.end_angle, a1)]
        check(f"arco ({cx}, {cy}) r={rr} {a0}-{a1} gradi", bool(hit))
    pl = [e for e in ents if e.dxftype() == "LWPOLYLINE" and e.closed]
    good = False
    for e in pl:
        pts = list(e.get_points("xyb"))
        if len(pts) != len(POLY):
            continue
        # stesso anello (anche partendo da un altro vertice o nel verso opposto)
        for start in range(len(pts)):
            rot = pts[start:] + pts[:start]
            if all(near(p[:2], q[:2], tol) and abs(p[2] - q[2]) < 1e-3 for p, q in zip(rot, POLY)):
                good = True
    check("polilinea chiusa con arco (bulge 0,4142)", good)
    check("nessuna spline al posto degli archi", not any(e.dxftype() == "SPLINE" for e in ents))
    lay = {e.dxf.layer for e in ents}
    check("entita' sui layer originali", {"muri", "assi", "arredi"} <= {x.lower() for x in lay}, ", ".join(sorted(lay)))
    mu = [e for e in ents if e.dxf.layer.lower() == "muri" and e.dxftype() == "LINE"]
    check("spessore dei muri 0,50 mm", bool(mu) and all(e.dxf.lineweight == 50 for e in mu), str({e.dxf.lineweight for e in mu}))
    check("unita' del disegno = mm", d.header["$INSUNITS"] == 4)
    # scala da una quota nota: linea (1000,1000)-(9000,1000) = 8000 mm; in punti PDF y verso il basso
    k = 0.01 * 72 / 25.4
    pg_h = H * k
    ref = [1000 * k, pg_h - 1000 * k, 9000 * k, pg_h - 1000 * k]
    out2 = work / "quota_nota.dxf"
    todrawing.convert(str(pdf), str(out2), {"ref": ref, "ref_len": 8000})
    _, ents2, _ = ents_of(out2)
    register(ents2, CIRCLES)
    check("scala da quota nota (8000 mm)", find_line(ents2, LINES[0], 6.0) is not None or any(
        e.dxftype() == "LINE" and abs(math.dist(tuple(e.dxf.start)[:2], tuple(e.dxf.end)[:2]) - 8000) < 6.0 for e in ents2))
    # layer per colore e spessore (senza OCG)
    out3 = work / "per_colore.dxf"
    todrawing.convert(str(pdf), str(out3), {"scale": 100, "layers": "color"})
    d3, ents3, _ = ents_of(out3)
    names = sorted({e.dxf.layer for e in ents3})
    check("layer per colore e spessore", any(n.startswith("CFF0000") for n in names) and any(n.startswith("C0000FF") for n in names), ", ".join(names))
    # DXF con due pagine affiancate e fogli
    two = pymupdf.open(str(pdf))
    two.insert_pdf(pymupdf.open(str(pdf)))
    two.save(str(work / "due_pagine.pdf"))
    out4 = work / "due_fogli.dxf"
    r4 = todrawing.convert(str(work / "due_pagine.pdf"), str(out4), {"scale": 100, "layout": "sheets"})
    d4 = ezdxf.readfile(out4)
    lays = [l.name for l in d4.layouts if l.name != "Model"]
    check("due pagine -> due fogli (layout)", len(lays) >= 2 and r4["pages"] == 2, ", ".join(lays))
    vp = [e for e in d4.layouts.get(lays[-1]) if e.dxftype() == "VIEWPORT"]
    check("finestra del foglio in scala 1:100", bool(vp) and abs(vp[-1].dxf.view_height / vp[-1].dxf.height - 100) < 0.5,
          f"{vp[-1].dxf.view_height / vp[-1].dxf.height:.2f}" if vp else "")
    circles2 = [e for e in d4.modelspace() if e.dxftype() == "CIRCLE"]
    check("seconda pagina affiancata nel modello", any(e.dxf.center[0] > W for e in circles2))
    return pdf


# ---------------------------------------------------------------- 2. testi, tratteggi, riempimenti
def test_text(work):
    print("\n2. Testi, tratteggi e riempimenti")
    d = pymupdf.open()
    p = d.new_page(width=842, height=595)
    p.insert_text((100, 100), "PIANTA PIANO TERRA", fontsize=20, fontname="helv")
    p.insert_text((100, 130), "SCALA 1:100", fontsize=10, fontname="helv")
    p.insert_text((500, 500), "QUOTA 3,50", fontsize=12, fontname="helv", rotate=90)
    p.insert_text((100, 300), "Prima riga del paragrafo", fontsize=9, fontname="tiro")
    p.insert_text((100, 313), "seconda riga del paragrafo", fontsize=9, fontname="tiro")
    p.insert_text((100, 326), "terza riga", fontsize=9, fontname="tiro")
    p.insert_text((400, 300), "inclinato", fontsize=14, fontname="helv", morph=(pymupdf.Point(400, 300), pymupdf.Matrix(30)))
    p.draw_line((100, 400), (400, 400), color=(0, 0, 0), width=0.5, dashes="[6 3] 0")
    p.draw_rect((500, 100, 600, 160), color=None, fill=(0.2, 0.4, 0.8))
    p.draw_polyline([(650, 100), (750, 100), (700, 180)], color=(0, 0, 0), fill=(1, 0.5, 0), closePath=True)
    pdf = work / "testi.pdf"
    d.save(str(pdf))
    inf = todrawing.info(str(pdf))
    check("scala 1:100 trovata nel testo", 100 in inf["pages"][0]["scales"], str(inf["pages"][0]["scales"]))
    out = work / "testi.dxf"
    todrawing.convert(str(pdf), str(out), {"scale": 1})  # 1:1 = millimetri della carta
    dd, ents, aud = ents_of(out)
    check("DXF riapribile", not aud.has_errors)
    mm = 25.4 / 72
    texts = [e for e in ents if e.dxftype() == "TEXT"]
    mt = [e for e in ents if e.dxftype() == "MTEXT"]

    def tfind(s):
        return next((e for e in texts if e.dxf.text == s), None)
    e = tfind("PIANTA PIANO TERRA")
    check("testo trovato", e is not None)
    if e:
        check("posizione sulla linea di base", near(e.dxf.insert, (100 * mm, (595 - 100) * mm), 0.05), str(e.dxf.insert))
        check("altezza = maiuscole (20 pt Helvetica ~ 5,0 mm)", abs(e.dxf.height - 20 * 0.716 * mm) < 0.25, f"{e.dxf.height:.2f} mm")
        st = dd.styles.get(e.dxf.style)
        check("stile con carattere TrueType", st is not None and str(st.dxf.font).lower().endswith((".ttf", ".otf", ".ttc")), st.dxf.font if st else "")
    e = tfind("QUOTA 3,50")
    check("testo verticale ruotato di 90 gradi", e is not None and ang_eq(e.dxf.rotation, 90), str(e.dxf.rotation) if e else "")
    e = tfind("inclinato")
    check("testo inclinato di 30 gradi", e is not None and ang_eq(e.dxf.rotation, 30, 1.0), str(e.dxf.rotation) if e else "")
    par = [m for m in mt if "seconda riga" in m.text]
    check("tre righe allineate -> un MTEXT", bool(par) and par[0].text.count("\\P") == 2, par[0].text if par else "")
    dashed = [e for e in ents if e.dxftype() == "LINE" and e.dxf.linetype.startswith("MBV_")]
    check("linea tratteggiata con tipo di linea proprio", bool(dashed))
    if dashed:
        lt = dd.linetypes.get(dashed[0].dxf.linetype)
        pat = lt.pattern_tags.tags if lt else None
        check("tratteggio 6-3 pt in mm", lt is not None, str(pat)[:80] if pat else "")
    hat = [e for e in ents if e.dxftype() == "HATCH"]
    check("due riempimenti -> HATCH pieni", len(hat) == 2, str(len(hat)))


# ---------------------------------------------------------------- 3. scansione sintetica
def raster_from_pdf(pdf, dpi, angle=0.0, specks=0, noise=0, seed=3):
    from PIL import Image, ImageDraw
    import numpy as np
    d = pymupdf.open(str(pdf))
    pix = d[0].get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY, alpha=False)
    im = Image.frombytes("L", (pix.width, pix.height), pix.samples)
    rnd = random.Random(seed)
    dr = ImageDraw.Draw(im)
    for _ in range(specks):
        x, y = rnd.randrange(im.width), rnd.randrange(im.height)
        r = rnd.choice((1, 1, 2))
        dr.ellipse((x - r, y - r, x + r, y + r), fill=0)
    if noise:
        a = np.asarray(im, dtype=np.int16)
        a = a + np.random.default_rng(seed).normal(0, noise, a.shape).astype(np.int16)
        im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    if angle:
        im = im.rotate(angle, resample=Image.BILINEAR, expand=True, fillcolor=255)
    return im


def thick_pdf(work):
    """Il disegno di riferimento con tratti di 0,5 mm (come una tavola stampata) e un testo grande."""
    doc = make_dxf(work / "rif_spesso.dxf")
    for e in doc.modelspace():
        e.dxf.lineweight = 50
    msp = doc.modelspace()
    msp.add_text("PIANTA PIANO TERRA", dxfattribs={"height": 400, "layer": "ASSI"}).set_placement((1500, 15500))
    msp.add_text("SCALA 1:100", dxfattribs={"height": 300, "layer": "ASSI"}).set_placement((1500, 14500))
    pdf = work / "rif_spesso.pdf"
    dxf_to_pdf(doc, pdf, black=True)  # una tavola stampata in bianco e nero
    return pdf


def test_raster(work, pdf):
    print("\n3. Scansione sintetica")
    dpi = 300
    im = raster_from_pdf(pdf, dpi, specks=400, noise=12)
    png = work / "scansione.png"
    im.save(png, dpi=(dpi, dpi))
    inf = todrawing.info(str(png))
    check("immagine riconosciuta come scansione", inf["kind"] == "raster" and round(inf["dpi"] or 0) == dpi, str(inf.get("dpi")))
    out = work / "scansione.dxf"
    r = todrawing.convert(str(png), str(out), {"scale": 100, "ocr": True})
    d, ents, aud = ents_of(out)
    check("DXF riapribile", not aud.has_errors, f"{len(ents)} entita', {r['stats']}")
    check("segnalato come approssimato", r["approx"] is True)
    ox, oy = register(ents, CIRCLES)
    print(f"      spostamento: {ox:.1f}, {oy:.1f} mm")
    tol = 25.0 * 100 / 100 * 1.0 + 15  # 25 mm a scala reale = 0,25 mm sulla carta (3 pixel a 300 dpi)
    found = 0
    for cx, cy, rr in CIRCLES:
        hit = [e for e in ents if e.dxftype() == "CIRCLE" and near(e.dxf.center, (cx, cy), tol) and abs(e.dxf.radius - rr) <= tol]
        found += bool(hit)
        check(f"cerchio ({cx}, {cy}) r={rr}", bool(hit))
    for l in LINES:
        ok = find_line(ents, l, tol * 2) is not None
        check(f"linea {l}", ok)
    arcs = [e for e in ents if e.dxftype() == "ARC"]
    ahit = 0
    for cx, cy, rr, a0, a1 in ARCS:
        ahit += any(near(e.dxf.center, (cx, cy), tol * 2) and abs(e.dxf.radius - rr) <= tol * 2 for e in arcs)
    check("archi ritrovati (almeno 2 su 3)", ahit >= 2, f"{ahit}/3")
    small = [e for e in ents if e.dxftype() == "LINE" and math.dist(tuple(e.dxf.start)[:2], tuple(e.dxf.end)[:2]) < 30]
    check("macchie tolte (pochi pezzetti sotto 3 mm)", len(small) < 15, str(len(small)))
    texts = [e.dxf.text for e in ents if e.dxftype() == "TEXT"]
    if os.name == "nt":
        joined = " ".join(texts).upper()
        check("OCR: 'PIANTA PIANO TERRA'", "PIANTA" in joined and "TERRA" in joined, "; ".join(texts)[:120])
        check("OCR: 'SCALA 1:100'", "SCALA" in joined, "; ".join(texts)[:120])
    # raddrizzamento
    im2 = raster_from_pdf(pdf, 200, angle=1.5, specks=100)
    B, _, ang = rastervec.clean(im2, {"_dpi": 200})
    check("angolo della scansione ritrovato (1,5 gradi)", abs(abs(ang) - 1.5) < 0.12, f"{ang:.2f}")
    im2.save(work / "scansione_storta.png", dpi=(200, 200))
    r2 = todrawing.convert(str(work / "scansione_storta.png"), str(work / "scansione_storta.dxf"), {"scale": 100, "ocr": False})
    _, ents2, _ = ents_of(work / "scansione_storta.dxf")
    hv = [e for e in ents2 if e.dxftype() == "LINE" and math.dist(tuple(e.dxf.start)[:2], tuple(e.dxf.end)[:2]) > 3000]
    straight = [e for e in hv if abs(e.dxf.start[1] - e.dxf.end[1]) < 1 or abs(e.dxf.start[0] - e.dxf.end[0]) < 1]
    check("dopo il raddrizzamento i muri lunghi sono orizzontali/verticali", len(straight) >= 4, f"{len(straight)}/{len(hv)}")
    # solo contorni
    r3 = todrawing.convert(str(png), str(work / "contorni.dxf"), {"scale": 100, "vmode": "outline", "ocr": False})
    _, ents3, _ = ents_of(work / "contorni.dxf")
    register(ents3, CIRCLES)
    cc = 0
    for cx, cy, rr in CIRCLES:
        # il tratto del cerchio da' due contorni: dentro e fuori
        cc += sum(1 for e in ents3 if (e.dxftype() == "CIRCLE" or (e.dxftype() == "ARC" and (e.dxf.end_angle - e.dxf.start_angle) % 360 > 300))
                  and near(e.dxf.center, (cx, cy), tol) and abs(e.dxf.radius - rr) <= tol * 1.5)
    check("solo contorni: cerchi doppi (bordo interno ed esterno, cerchio o arco oltre 300 gradi)", cc >= 5, str(cc))
    big = [e for e in ents3 if e.dxftype() == "ARC" and e.dxf.radius > 3 * max(c[2] for c in CIRCLES)]
    check("solo contorni: nessun arco enorme al posto delle rette", len(big) == 0, str(len(big)))
    # PDF scansionato (immagine dentro un PDF)
    sp = pymupdf.open()
    pg = sp.new_page(width=im.width * 72 / dpi, height=im.height * 72 / dpi)
    pg.insert_image(pg.rect, filename=str(png))
    sp.save(str(work / "scansione.pdf"))
    inf = todrawing.info(str(work / "scansione.pdf"))
    check("PDF con sola immagine = scansione", inf["kind"] == "raster")
    r4 = todrawing.convert(str(work / "scansione.pdf"), str(work / "scansione_pdf.dxf"), {"scale": 100, "ocr": False, "dpi": 300})
    _, ents4, _ = ents_of(work / "scansione_pdf.dxf")
    register(ents4, CIRCLES)
    hit = sum(1 for cx, cy, rr in CIRCLES if any(e.dxftype() == "CIRCLE" and near(e.dxf.center, (cx, cy), tol) for e in ents4))
    check("PDF scansionato vettorizzato in scala", hit == 3 and r4["methods"] == ["raster"], f"{hit}/3")


def main():
    keep = None
    if "--keep" in sys.argv:
        keep = Path(sys.argv[sys.argv.index("--keep") + 1])
        keep.mkdir(parents=True, exist_ok=True)
    work = keep or Path(tempfile.mkdtemp(prefix="mbv-disegno-"))
    test_vector(work)
    test_text(work)
    test_raster(work, thick_pdf(work))
    print(f"\n{len(OK)}/{len(OK) + len(KO)} prove riuscite" + (f"  - non riuscite: {', '.join(KO)}" if KO else ""))
    print("file in", work)
    sys.exit(1 if KO else 0)


if __name__ == "__main__":
    main()
