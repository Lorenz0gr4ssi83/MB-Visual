"""File di prova per "Converti in disegno": una pianta 1:100 in PDF vettoriale (come esportata da un CAD: archi come Bezier,
testi veri, layer OCG, retini, tratteggi) e la stessa tavola "scansionata" (300 dpi, storta di 1,2 gradi, rumore e macchie).
Uso: python tools/make_todrawing_samples.py [cartella]   (predefinita: tests/samples/disegno)
"""
import math
import random
import sys
from pathlib import Path

import pymupdf

MM = 72 / 25.4


def arc_bez(sh, c, r, a0, a1):
    """Arco (gradi, antiorario sulla carta) come Bezier di al massimo 90 gradi, come fanno i driver PDF dei CAD."""
    n = max(1, math.ceil(abs(a1 - a0) / 90))
    step = (a1 - a0) / n
    for i in range(n):
        t0, t1 = math.radians(a0 + i * step), math.radians(a0 + (i + 1) * step)
        k = 4 / 3 * math.tan((t1 - t0) / 4)
        p0 = (c[0] + r * math.cos(t0), c[1] - r * math.sin(t0))
        p3 = (c[0] + r * math.cos(t1), c[1] - r * math.sin(t1))
        p1 = (p0[0] - k * r * math.sin(t0), p0[1] - k * r * math.cos(t0))
        p2 = (p3[0] + k * r * math.sin(t1), p3[1] + k * r * math.cos(t1))
        sh.draw_bezier(p0, p1, p2, p3)


def make_pdf(out: Path):
    doc = pymupdf.open()
    W, H = 420 * MM, 297 * MM  # A3 orizzontale
    pg = doc.new_page(width=W, height=H)
    L = {n: doc.add_ocg(n, on=True) for n in ("MURI", "PORTE", "ARREDI", "ASSI", "QUOTE", "TESTI", "CARTIGLIO")}

    def P(x, y):  # metri reali -> punti sulla carta (1:100), origine in basso a sinistra a (30, 40) mm
        return ((30 + x * 10) * MM, H - (40 + y * 10) * MM)

    # muri: contorno spesso + retino grigio
    walls = [((0, 0), (24, 0.3)), ((0, 0), (0.3, 16)), ((0, 15.7), (24, 16)), ((23.7, 0), (24, 16)), ((10, 0), (10.2, 9)), ((10, 11), (10.2, 16)),
             ((0, 8), (6, 8.2)), ((7.5, 8), (10, 8.2)), ((10.2, 6), (17, 6.2)), ((18.5, 6), (24, 6.2))]
    for (x0, y0), (x1, y1) in walls:
        a, b = P(x0, y1), P(x1, y0)
        r = pymupdf.Rect(a, b)
        pg.draw_rect(r, color=(0, 0, 0), fill=(0.72, 0.72, 0.72), width=0.5 * MM, oc=L["MURI"])
    # porte: anta + arco di apertura (Bezier)
    for (hx, hy), a0, a1, w in (((6, 8.2), 0, 90, 1.5), ((10.2, 9), 90, 180, 2.0), ((17, 6.2), 0, 90, 1.5)):
        sh = pg.new_shape()
        c = P(hx, hy)
        arc_bez(sh, c, w * 10 * MM, a0, a1)
        t = math.radians(a1)
        sh.draw_line(c, (c[0] + w * 10 * MM * math.cos(t), c[1] - w * 10 * MM * math.sin(t)))
        sh.finish(color=(0.85, 0.1, 0.1), width=0.25 * MM, oc=L["PORTE"])
        sh.commit()
    # pilastri tondi e tavolo
    for x, y in ((5, 4), (15, 11), (20, 11)):
        pg.draw_circle(P(x, y), 0.25 * 10 * MM, color=(0, 0, 0.8), width=0.35 * MM, oc=L["ARREDI"])
    pg.draw_circle(P(5, 12), 0.9 * 10 * MM, color=(0, 0.5, 0), width=0.25 * MM, oc=L["ARREDI"])
    pg.draw_rect(pymupdf.Rect(P(13, 3), P(16, 1.5)), color=(0, 0.5, 0), width=0.25 * MM, oc=L["ARREDI"])
    # assi tratteggiati
    for x in (5, 15, 20):
        pg.draw_line(P(x, -1.5), P(x, 17.5), color=(0.2, 0.4, 0.9), width=0.18 * MM, dashes="[12 3 2 3] 0", oc=L["ASSI"])
    # quote
    def dim(x0, x1, y, txt):
        pg.draw_line(P(x0, y), P(x1, y), color=(0, 0, 0), width=0.18 * MM, oc=L["QUOTE"])
        for x in (x0, x1):
            pg.draw_line(P(x - 0.15, y - 0.15), P(x + 0.15, y + 0.15), color=(0, 0, 0), width=0.35 * MM, oc=L["QUOTE"])
            pg.draw_line(P(x, y - 0.4), P(x, y + 0.4), color=(0, 0, 0), width=0.18 * MM, oc=L["QUOTE"])
        tx = P((x0 + x1) / 2 - 0.4, y + 0.2)
        pg.insert_text(tx, txt, fontsize=2.5 * MM / 0.716, fontname="helv", oc=L["QUOTE"])
    dim(0, 10, -1.0, "10,00")
    dim(10, 24, -1.0, "14,00")
    # quota verticale
    pg.draw_line(P(-1, 0), P(-1, 16), color=(0, 0, 0), width=0.18 * MM, oc=L["QUOTE"])
    pg.insert_text(P(-1.25, 7.2), "16,00", fontsize=2.5 * MM / 0.716, fontname="helv", rotate=90, oc=L["QUOTE"])
    # nomi dei locali
    for x, y, t in ((2, 4, "UFFICIO"), (2, 12.5, "SALA RIUNIONI"), (13, 9, "OPEN SPACE"), (19, 3, "ARCHIVIO")):
        pg.insert_text(P(x, y), t, fontsize=3.5 * MM / 0.716, fontname="helv", oc=L["TESTI"])
        pg.insert_text(P(x, y - 0.6), "h = 3,00 m", fontsize=2 * MM / 0.716, fontname="tiro", oc=L["TESTI"])
    # cartiglio
    cx0, cy0 = 300 * MM, H - 10 * MM
    box = pymupdf.Rect(cx0, cy0 - 40 * MM, 410 * MM, cy0)
    pg.draw_rect(box, color=(0, 0, 0), width=0.5 * MM, oc=L["CARTIGLIO"])
    pg.draw_line((cx0, cy0 - 20 * MM), (410 * MM, cy0 - 20 * MM), color=(0, 0, 0), width=0.25 * MM, oc=L["CARTIGLIO"])
    for i, (t, fs) in enumerate((("PIANTA PIANO TERRA", 4.5), ("Edificio uffici - progetto esecutivo", 2.5), ("Tavola A.01", 2.5), ("SCALA 1:100", 3.5))):
        pg.insert_text((cx0 + 4 * MM, cy0 - 33 * MM + i * 7 * MM), t, fontsize=fs * MM / 0.716, fontname="helv", oc=L["CARTIGLIO"])
    doc.save(str(out), garbage=3, deflate=True)


def make_scan(pdf: Path, out: Path, dpi=300, angle=1.2):
    from PIL import Image, ImageDraw
    import numpy as np
    d = pymupdf.open(str(pdf))
    pix = d[0].get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY, alpha=False)
    im = Image.frombytes("L", (pix.width, pix.height), pix.samples)
    a = np.asarray(im, dtype=np.float32)
    # carta un po' ingiallita e ombra su un lato, rumore, macchie
    yy, xx = np.mgrid[0:a.shape[0], 0:a.shape[1]]
    shade = 1 - 0.18 * (xx / a.shape[1]) ** 2
    a = a * 0.93 * shade + np.random.default_rng(5).normal(0, 9, a.shape)
    im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    dr = ImageDraw.Draw(im)
    rnd = random.Random(7)
    for _ in range(900):
        x, y, r = rnd.randrange(im.width), rnd.randrange(im.height), rnd.choice((1, 1, 2, 2, 3))
        dr.ellipse((x - r, y - r, x + r, y + r), fill=rnd.randrange(20, 120))
    im = im.rotate(angle, resample=Image.BILINEAR, expand=True, fillcolor=236)
    im.save(out, dpi=(dpi, dpi), compression="tiff_lzw" if out.suffix.lower() in (".tif", ".tiff") else None)


def main():
    folder = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "tests" / "samples" / "disegno"
    folder.mkdir(parents=True, exist_ok=True)
    pdf = folder / "pianta_1-100.pdf"
    make_pdf(pdf)
    make_scan(pdf, folder / "pianta_scansione.tif")
    print("creati", pdf, folder / "pianta_scansione.tif")


if __name__ == "__main__":
    main()
