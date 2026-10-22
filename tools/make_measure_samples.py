"""File di prova per il pannello Misure (ui/js/measure/): tests/samples/misure. Valori attesi in tests/test_measure.py e .mjs.

pianta_1-100.pdf  A3 orizzontale, scala 1:100 (scritta nel cartiglio "SCALA 1:100"):
                  locale 5 x 4 m (area 20 m2, perimetro 18 m), pavimento retinato 6 x 4 m con foro 1 x 1 m (23 m2),
                  tubo rosso tratteggiato 10 m sul layer PDF "Impianti", 10 simboli uguali (cerchio con croce),
                  5 quadrati uguali (di cui uno ruotato di 90 gradi), testi di quote (5.00, 4.00) e livelli (+0.00, +3.20),
                  tabella dei locali (3 colonne x 4 righe).
                  Pagina 2: dettaglio con riquadro /VP in scala 1:20 (come lo scrive un altro programma) e linea di 1 m.
pianta_mm.dxf     unita' mm ($INSUNITS 4): layer MURI polilinea chiusa 5000 x 4000 + cerchio r 500, layer TUBI linee 6000 + 4000
                  tratteggiate, retino PAVIMENTO 6000 x 4000 con foro 1000 x 1000 (23 m2), blocchi SEDIA x 12 + GRUPPO x 2
                  (ognuno con 2 SEDIA) = 16 sedie, TAVOLO x 3, testi e una quota lineare di 5000.
edificio.ifc      muri e solai con materiali e piani (volumi noti: vedi EXPECTED in fondo).
"""
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "samples" / "misure"
PT_PER_M_100 = 1000 / 100 / 25.4 * 72  # punti per metro reale a 1:100 = 28.3465


def pdf(path: Path):
    import pymupdf
    doc = pymupdf.open()
    page = doc.new_page(width=1190.55, height=841.89)  # A3 orizzontale
    k = PT_PER_M_100
    ox, oy = 120, 120  # origine del disegno (in alto a sinistra, coordinate di PyMuPDF)
    P = lambda x, y: pymupdf.Point(ox + x * k, oy + y * k)  # noqa: E731
    sh = page.new_shape()
    # locale 5 x 4 m
    sh.draw_polyline([P(0, 0), P(5, 0), P(5, 4), P(0, 4), P(0, 0)])
    sh.finish(color=(0, 0, 0), width=0.7, closePath=True)
    # pavimento retinato 6 x 4 con foro 1 x 1 (riempimento pari-dispari)
    sh.draw_polyline([P(7, 0), P(13, 0), P(13, 4), P(7, 4), P(7, 0)])
    sh.draw_polyline([P(9, 1), P(10, 1), P(10, 2), P(9, 2), P(9, 1)])
    sh.finish(color=None, fill=(0.75, 0.75, 0.75), even_odd=True, closePath=True)
    sh.commit()
    # tubo 10 m tratteggiato sul layer "Impianti"
    ocg = doc.add_ocg("Impianti", on=True)
    sh = page.new_shape()
    sh.draw_polyline([P(0, 6), P(6, 6), P(6, 10)])
    sh.finish(color=(0.85, 0.1, 0.1), width=1.2, dashes="[4 2] 0", oc=ocg, closePath=False)
    sh.commit()
    # 10 simboli uguali: cerchio r 0,2 m con croce
    sh = page.new_shape()
    for i in range(10):
        c = P(8 + (i % 5) * 1.0, 6 + (i // 5) * 1.5)
        r = 0.2 * k
        sh.draw_circle(c, r)
        sh.draw_line(pymupdf.Point(c.x - r, c.y), pymupdf.Point(c.x + r, c.y))
        sh.draw_line(pymupdf.Point(c.x, c.y - r), pymupdf.Point(c.x, c.y + r))
        sh.finish(color=(0.1, 0.3, 0.8), width=0.5, closePath=False)
    sh.commit()
    # 5 quadrati 0,3 m con una diagonale (uno ruotato di 90 gradi: la diagonale va nell'altro verso), tracciati separati
    for i in range(5):
        c = P(8 + i * 1.0, 9.5)
        s = 0.15 * k
        page.draw_rect(pymupdf.Rect(c.x - s, c.y - s, c.x + s, c.y + s), color=(0.1, 0.55, 0.2), width=0.5)
        a, b = (pymupdf.Point(c.x + s, c.y - s), pymupdf.Point(c.x - s, c.y + s)) if i == 4 else (pymupdf.Point(c.x - s, c.y - s), pymupdf.Point(c.x + s, c.y + s))
        page.draw_line(a, b, color=(0.1, 0.55, 0.2), width=0.5)
    # quote e livelli
    page.insert_text(P(2.3, -0.2), "5.00", fontsize=8)
    page.insert_text(P(5.2, 2.1), "4.00", fontsize=8)
    page.insert_text(P(0.3, 0.6), "+0.00", fontsize=8)
    page.insert_text(P(0.3, 3.6), "+3.20", fontsize=8)
    # tabella dei locali (griglia + testi)
    tx, ty, cw, rh = 760, 520, 110, 22
    rows = [("Locale", "Superficie", "Altezza"), ("Soggiorno", "20,00", "2,70"), ("Cucina", "12,50", "2,70"), ("Bagno", "6,25", "2,40")]
    sh = page.new_shape()
    for i in range(len(rows) + 1):
        sh.draw_line(pymupdf.Point(tx, ty + i * rh), pymupdf.Point(tx + 3 * cw, ty + i * rh))
    for j in range(4):
        sh.draw_line(pymupdf.Point(tx + j * cw, ty), pymupdf.Point(tx + j * cw, ty + len(rows) * rh))
    sh.finish(color=(0, 0, 0), width=0.6, closePath=False)
    sh.commit()
    for i, r in enumerate(rows):
        for j, v in enumerate(r):
            page.insert_text(pymupdf.Point(tx + j * cw + 6, ty + i * rh + 15), v, fontsize=9)
    # cartiglio
    page.draw_rect(pymupdf.Rect(900, 740, 1170, 820), color=(0, 0, 0), width=0.8)
    page.insert_text(pymupdf.Point(910, 765), "TAV. 01 - PIANTA PIANO TERRA", fontsize=10)
    page.insert_text(pymupdf.Point(910, 795), "SCALA 1:100", fontsize=10)

    # pagina 2: dettaglio 1:20 con un riquadro /VP scritto "da un altro programma"
    p2 = doc.new_page(width=841.89, height=595.28)
    k20 = 1000 / 20 / 25.4 * 72  # punti per metro a 1:20
    p2.draw_rect(pymupdf.Rect(100, 100, 500, 400), color=(0.5, 0.5, 0.5), width=0.5)
    p2.draw_line(pymupdf.Point(150, 300), pymupdf.Point(150 + k20, 300), color=(0, 0, 0), width=1)
    p2.insert_text(pymupdf.Point(110, 120), "DETTAGLIO A - SCALA 1:20", fontsize=9)
    h = p2.rect.height
    vp = ("[<</Type/Viewport/BBox[100 %.3f 500 %.3f]/Name(Dettaglio A)/Measure<</Type/Measure/Subtype/RL/R(1 in = 0.508 m)"
          "/X[<</Type/NumberFormat/U(m)/C %.10g/D 100>>]/D[<</Type/NumberFormat/U(m)/C 1/D 100>>]/A[<</Type/NumberFormat/U(sq m)/C 1/D 100>>]>>>>]") % (
        h - 400, h - 100, 20 * 0.0254 / 72)
    doc.xref_set_key(p2.xref, "VP", vp)
    doc.save(path, garbage=3, deflate=True)
    doc.close()


def dxf(path: Path):
    import ezdxf
    doc = ezdxf.new("R2010", setup=True)
    doc.header["$INSUNITS"] = 4
    msp = doc.modelspace()
    for name, col, lt in (("MURI", 1, "CONTINUOUS"), ("TUBI", 3, "DASHED"), ("ARREDI", 5, "CONTINUOUS"), ("PAVIMENTO", 8, "CONTINUOUS"), ("TESTI", 7, "CONTINUOUS"), ("QUOTE", 2, "CONTINUOUS")):
        doc.layers.add(name, color=col, linetype=lt)
    msp.add_lwpolyline([(0, 0), (5000, 0), (5000, 4000), (0, 4000)], close=True, dxfattribs={"layer": "MURI"})
    msp.add_circle((2500, 2000), 500, dxfattribs={"layer": "MURI"})
    msp.add_line((0, 6000), (6000, 6000), dxfattribs={"layer": "TUBI"})
    msp.add_line((6000, 6000), (6000, 10000), dxfattribs={"layer": "TUBI"})
    msp.add_arc((15000, 2000), 1500, 0, 90, dxfattribs={"layer": "MURI"})
    h = msp.add_hatch(color=8, dxfattribs={"layer": "PAVIMENTO"})
    h.set_pattern_fill("ANSI31", scale=50)
    h.paths.add_polyline_path([(7000, 0), (13000, 0), (13000, 4000), (7000, 4000)], is_closed=True, flags=1)
    h.paths.add_polyline_path([(9000, 1000), (10000, 1000), (10000, 2000), (9000, 2000)], is_closed=True, flags=16)
    sedia = doc.blocks.new("SEDIA")
    sedia.add_lwpolyline([(0, 0), (450, 0), (450, 450), (0, 450)], close=True)
    tavolo = doc.blocks.new("TAVOLO")
    tavolo.add_lwpolyline([(0, 0), (1600, 0), (1600, 900), (0, 900)], close=True)
    gruppo = doc.blocks.new("GRUPPO")
    gruppo.add_blockref("SEDIA", (0, 0))
    gruppo.add_blockref("SEDIA", (600, 0))
    for i in range(12):
        msp.add_blockref("SEDIA", (i * 700, 12000), dxfattribs={"layer": "ARREDI"})
    for i in range(3):
        msp.add_blockref("TAVOLO", (i * 2500, 14000), dxfattribs={"layer": "ARREDI"})
    for i in range(2):
        msp.add_blockref("GRUPPO", (i * 2000, 16000), dxfattribs={"layer": "ARREDI"})
    msp.add_text("SOGGIORNO", height=250, dxfattribs={"layer": "TESTI"}).set_placement((1500, 3000))
    msp.add_text("+0.00", height=150, dxfattribs={"layer": "TESTI"}).set_placement((200, 200))
    dim = msp.add_linear_dim(base=(0, -800), p1=(0, 0), p2=(5000, 0), dxfattribs={"layer": "QUOTE"})
    dim.render()
    doc.saveas(path)


def ifc(path: Path):
    sys.path.insert(0, str(ROOT / "tools"))
    from make_clash_samples import Ifc, guid
    f = Ifc("misure")
    mats = {}

    def material(name):
        if name not in mats:
            mats[name] = (f.add(f"IFCMATERIAL('{name}',$,$)"), [])
        return mats[name]
    els = {}
    # muri 30 cm alti 3 m: W1 10 m, W2 6 m -> volumi 9 e 5,4 m3
    for key, (x0, y0, x1, y1), mat in (("W1", (0, 0, 10, 0.3), "Calcestruzzo"), ("W2", (0, 0.3, 0.3, 6.3), "Laterizio")):
        e = f.element("IFCWALL", key, f"Muro {key}", "PT", f.box(x0, y0, 0, x1, y1, 3), ".STANDARD.", ("IFCWALLTYPE", "Muro 30"))
        material(mat)[1].append(e)
        els[key] = e
    # solaio 10 x 6 x 0,25 al piano primo -> 15 m3; pilastro 0,4 x 0,4 x 3 -> 0,48 m3
    e = f.element("IFCSLAB", "S1", "Solaio", "P1", f.box(0, 0, 0, 10, 6, 0.25), ".FLOOR.", ("IFCSLABTYPE", "Solaio 25"))
    material("Calcestruzzo")[1].append(e)
    e = f.element("IFCCOLUMN", "C1", "Pilastro", "PT", f.box(5, 3, 0, 5.4, 3.4, 3), ".COLUMN.", ("IFCCOLUMNTYPE", "Pilastro 40x40"))
    material("Calcestruzzo")[1].append(e)
    for name, (m, ids) in mats.items():
        f.add(f"IFCRELASSOCIATESMATERIAL('{guid('mat' + name)}',$,$,$,({','.join('#%d' % i for i in ids)}),#{m})")
    f.write(path)


EXPECTED = {
    "pdf": {"scala": 100, "area_locale": 20.0, "perimetro_locale": 18.0, "area_pavimento": 23.0, "tubo": 10.0, "simboli_cerchio": 10, "simboli_quadrato": 5,
            "dettaglio_scala": 20, "dettaglio_linea": 1.0},
    "dxf": {"MURI_len_mm": 18000 + 2 * math.pi * 500 + 1500 * math.pi / 2, "TUBI_len_mm": 10000, "PAVIMENTO_area_mm2": 23e6, "SEDIA": 16, "TAVOLO": 3, "GRUPPO": 2,
            "chiuse_area_mm2": {"rett": 20e6, "cerchio": math.pi * 500 ** 2}},
    "ifc": {"volume": {"Calcestruzzo": 9 + 15 + 0.48, "Laterizio": 5.4}, "livello": {"Piano terra": 9 + 5.4 + 0.48, "Piano primo": 15.0}, "W1_area": 2 * (10 * 3 + 0.3 * 3 + 10 * 0.3)},
}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    pdf(OUT / "pianta_1-100.pdf")
    dxf(OUT / "pianta_mm.dxf")
    ifc(OUT / "edificio.ifc")
    (OUT / "attesi.json").write_bytes(json.dumps(EXPECTED, indent=1).encode("utf-8") + b"\n")
    for p in sorted(OUT.iterdir()):
        print(p.name, p.stat().st_size)


if __name__ == "__main__":
    main()
