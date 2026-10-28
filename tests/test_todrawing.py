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



# ---------------------------------------------------------------- 4. tavole come le esportano i CAD
def _raw_page(d, w, h, content, rot=0):
    """Pagina con un contenuto scritto a mano (coordinate PDF, y verso l'alto)."""
    p = d.new_page(width=w, height=h)
    p.insert_text((0, -50), " ")  # crea il flusso dei contenuti
    d.update_stream(p.get_contents()[0], content.encode("latin-1"))
    if rot:
        p.set_rotation(rot)
    return p


def _glyph_path(text, x, y, size):
    """Testo come contorni pieni (TrueType "come geometria") con i glifi di Arial, in operatori PDF."""
    from fontTools.pens.basePen import BasePen
    from fontTools.ttLib import TTFont
    from mbvisual.pdfvec import font_file
    f = TTFont(font_file("Arial", False, False))
    gs, cmap, upm = f.getGlyphSet(), f.getBestCmap(), f["head"].unitsPerEm
    ops = []
    k = size / upm
    org = [x]

    class Pen(BasePen):
        def _moveTo(self, q):
            ops.append(f"{org[0] + q[0] * k:.3f} {y + q[1] * k:.3f} m")

        def _lineTo(self, q):
            ops.append(f"{org[0] + q[0] * k:.3f} {y + q[1] * k:.3f} l")

        def _curveToOne(self, a, b, c):
            ops.append(" ".join(f"{org[0] + q[0] * k:.3f} {y + q[1] * k:.3f}" for q in (a, b, c)) + " c")

        def _closePath(self):
            ops.append("h")
    for ch in text:
        g = cmap.get(ord(ch))
        if g is None:
            continue
        gs[g].draw(Pen(gs))
        org[0] += gs[g].width * k
    return "\n".join(ops) + "\nf\n"


def test_tavole(work):
    print("\n4. Tavole come le esportano i CAD (pagina ruotata, ritagli, mascherature, SHX, immagini, tratteggi, testi disegnati)")
    mm = 25.4 / 72
    d = pymupdf.open()
    # A: pagina con /Rotate 90 (cosi' AutoCAD stampa spesso i fogli orizzontali): il disegno deve uscire come si vede
    _raw_page(d, 595, 842, "0 0 0 RG 1 w 100 100 m 300 100 l S 100 100 m 100 400 l S\n", rot=90)
    # B: ritaglio (finestra di un layout), mascheratura bianca, tratteggio a pezzi, testo SHX con il suo commento, immagine
    dash = "".join(f"{60 + i * 6} 500 m {64 + i * 6} 500 l S\n" for i in range(40))
    shx = "0 0 0 RG 0.5 w 100 300 m 100 310 l S 107 300 m 107 310 l S 100 305 m 107 305 l S 110 300 m 110 310 l S\n"
    cont = ("q 50 50 200 150 re W n 0 0 0 RG 1 w 20 100 m 400 100 l S Q\n"  # linea tagliata a x = 50..250
            "0 0 0 RG 1 w 300 200 m 700 200 l S 1 1 1 rg 450 150 100 100 re f\n"  # mascheratura: la linea si interrompe 450..550
            "0 0 1 RG 0.5 w " + dash + shx)
    p = _raw_page(d, 842, 595, cont)
    a = p.add_rect_annot(pymupdf.Rect(99, 595 - 311, 112, 595 - 299))
    a.set_info(title="AutoCAD SHX Text", content="HI")
    a.set_border(width=0)
    a.update()
    d.xref_set_key(a.xref, "Rect", "[111 310 100 300]")  # come AutoCAD: angolo opposto, poi inizio della linea di base
    import io
    from PIL import Image
    im = Image.new("RGB", (40, 20), "white")
    im.paste((255, 0, 0), (0, 0, 10, 10))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    p.insert_image(pymupdf.Rect(600, 155, 680, 195), stream=buf.getvalue())
    # C: testo come contorni pieni (TrueType esportato come geometria): si legge con l'OCR
    _raw_page(d, 842, 595, "0 0 0 rg\n" + _glyph_path("PIANTA PIANO TERRA", 100, 400, 36) + _glyph_path("QUOTA 12.50", 100, 200, 30))
    pdf = work / "tavole.pdf"
    d.save(str(pdf))

    out = work / "tavole_a.dxf"
    res = todrawing.convert(str(pdf), str(out), {"scale": 1, "pages": [0]})
    dd, ents, aud = ents_of(out)
    check("pagina ruotata: DXF riapribile", not aud.has_errors and res["pages"] == 1)
    lines = [e for e in ents if e.dxftype() == "LINE"]
    pg = pymupdf.open(str(pdf))[0]
    m = pg.rotation_matrix

    def vis(x, y):  # coordinate PDF (y in alto) -> mm della pagina come si vede (y in alto)
        q = pymupdf.Point(x, 842 - y) * m
        return (q.x * mm, (pg.rect.height - q.y) * mm)
    exp = [(vis(100, 100), vis(300, 100)), (vis(100, 100), vis(100, 400))]
    ok = all(any((near(ln.dxf.start, a, 0.05) and near(ln.dxf.end, b, 0.05)) or (near(ln.dxf.start, b, 0.05) and near(ln.dxf.end, a, 0.05))
                 for ln in lines) for a, b in exp)
    check("pagina ruotata: linee dove si vedono", ok, str([(tuple(round(v, 1) for v in ln.dxf.start), tuple(round(v, 1) for v in ln.dxf.end)) for ln in lines]))

    out = work / "tavole_b.dxf"
    todrawing.convert(str(pdf), str(out), {"scale": 1, "pages": [1]})
    dd, ents, aud = ents_of(out)
    check("tavola: DXF riapribile", not aud.has_errors)
    L = [e for e in ents if e.dxftype() == "LINE"]
    clip = [ln for ln in L if abs(ln.dxf.start[1] - (100 * mm)) < 0.05]
    xs = sorted(round(v / mm) for ln in clip for v in (ln.dxf.start[0], ln.dxf.end[0]))
    check("ritaglio applicato (linea da 20 a 400 vista solo tra 50 e 250)", xs == [50, 250], str(xs))
    msk = [ln for ln in L if abs(ln.dxf.start[1] - (200 * mm)) < 0.05]
    xs = sorted(round(v / mm) for ln in msk for v in (ln.dxf.start[0], ln.dxf.end[0]))
    check("mascheratura bianca: la linea si interrompe sotto il riquadro", xs == [300, 450, 550, 700], str(xs))
    dl = [e for e in ents if e.dxftype() in ("LINE", "LWPOLYLINE") and e.dxf.linetype.startswith("MBV_")]
    check("40 trattini separati -> una linea con tipo di linea", len(dl) == 1, str(len(dl)))
    if dl:
        lt = dd.linetypes.get(dl[0].dxf.linetype)
        desc = lt.dxf.description if lt else ""
        want = "%g %g" % (round(4 * mm, 4), round(2 * mm, 4))
        check("schema del tratteggio 4 / 2 pt", want in desc, f"{desc} (atteso {want})")
    shxt = [e for e in ents if e.dxftype() == "TEXT" and e.dxf.text == "HI"]
    check("testo SHX dal commento di AutoCAD -> TEXT", len(shxt) == 1)
    if shxt:
        t = shxt[0]
        check("testo SHX: posizione e altezza misurate sui tratti", near(t.dxf.insert, (100 * mm, 300 * mm), 0.15) and abs(t.dxf.height - 10 * mm) < 0.1,
              f"{tuple(round(v, 2) for v in t.dxf.insert)} h {t.dxf.height:.2f}")
    left = [ln for ln in L if 99 * mm < ln.dxf.start[0] < 111 * mm and 299 * mm < ln.dxf.start[1] < 311 * mm]
    check("tratti del testo SHX tolti", not left, str(len(left)))
    imgs = [e for e in ents if e.dxftype() == "IMAGE"]
    check("immagine -> IMAGE", len(imgs) == 1)
    if imgs:
        im = imgs[0]
        f = out.parent / im.image_def.dxf.filename.replace("\\", os.sep)
        check("file dell'immagine accanto al DXF", f.exists(), str(f))
        check("immagine al suo posto (angolo in basso a sinistra, 80 x 40 pt)", near(im.dxf.insert, (600 * mm, (595 - 195) * mm), 0.05)
              and abs(im.dxf.u_pixel[0] * 40 - 80 * mm) < 0.05 and abs(im.dxf.v_pixel[1] * 20 - 40 * mm) < 0.05,
              f"{tuple(round(v, 2) for v in im.dxf.insert)} u {im.dxf.u_pixel} v {im.dxf.v_pixel}")

    out = work / "tavole_c.dxf"
    todrawing.convert(str(pdf), str(out), {"scale": 1, "pages": [2]})
    dd, ents, aud = ents_of(out)
    tx = " ".join(e.dxf.text for e in ents if e.dxftype() == "TEXT")
    if not tx:
        print("      (OCR del sistema non disponibile: prova dei testi disegnati saltata)")
        return
    check("testi come contorni pieni -> TEXT con l'OCR", "PIANTA" in tx and "TERRA" in tx and "12.50" in tx.replace(",", "."), tx)
    off = {la.dxf.name for la in dd.layers if la.is_off()}
    check("contorni originali conservati su un layer spento", any(e.dxf.layer in off for e in ents if e.dxftype() == "HATCH"), str(off))
    big = [e for e in ents if e.dxftype() == "TEXT" and "PIANTA" in e.dxf.text]
    if big:
        check("testo OCR: altezza delle maiuscole (36 pt Arial = 9,1 mm)", abs(big[0].dxf.height - 36 * 0.716 * mm) < 0.3, f"{big[0].dxf.height:.2f}")


def main():
    keep = None
    if "--keep" in sys.argv:
        keep = Path(sys.argv[sys.argv.index("--keep") + 1])
        keep.mkdir(parents=True, exist_ok=True)
    work = keep or Path(tempfile.mkdtemp(prefix="mbv-disegno-"))
    test_vector(work)
    test_text(work)
    test_raster(work, thick_pdf(work))
    test_tavole(work)
    print(f"\n{len(OK)}/{len(OK) + len(KO)} prove riuscite" + (f"  - non riuscite: {', '.join(KO)}" if KO else ""))
    print("file in", work)
    sys.exit(1 if KO else 0)


if __name__ == "__main__":
    main()
