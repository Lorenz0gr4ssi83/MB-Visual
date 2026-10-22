"""Campioni per i disegni sulla mappa (ui/js/gisdraw.js): stessa planimetria di un lotto in quattro versioni.

  tests/samples/georef/lotto_utm.dxf          coordinate RDN2008 / UTM 32N (EPSG 7791), metri: si sovrappone da solo
  tests/samples/georef/lotto_locale.dxf       coordinate locali in millimetri, ruotate di 25 gradi: va georeferenziato
  tests/samples/georef/lotto_geodata.dxf      come il locale ma con l'oggetto GEODATA di AutoCAD (si posiziona da solo)
  tests/samples/georef/lotto_tavola.pdf       tavola A3 in scala 1:500 dello stesso disegno locale
  tests/samples/georef/punti_controllo.json   i 4 vertici del lotto in tutte le versioni (per il collaudo)

Uso: python tools/make_georef_samples.py   (servono ezdxf e PyMuPDF, gia' nel venv dell'app)
Collaudo: node tests/test_georef.mjs
"""
import json
import math
from pathlib import Path

import ezdxf
import pymupdf

OUT = Path(__file__).resolve().parent.parent / "tests" / "samples" / "georef"
E0, N0 = 686_420.0, 4_929_310.0      # origine del rilievo (zona di Bologna), RDN2008 / UTM 32N
ROT = math.radians(-25.0)            # il disegno locale e' ruotato di -25 gradi rispetto al nord
MM = 1000.0                          # unita' del disegno locale: millimetri
SCALE_PDF = 500

# planimetria in metri, relativa all'origine, orientata al nord
LOTTO = [(0, 0), (62, 0), (68, 41), (4, 47)]
EDIFICIO = [(14, 10), (44, 10), (44, 28), (30, 28), (30, 34), (14, 34)]
STRADA = [[(-10, -6), (80, -6)], [(-10, -14), (80, -14)]]
ALBERI = [(52, 8), (56, 18), (8, 40)]


def to_local(x, y):
    c, s = math.cos(ROT), math.sin(ROT)
    return ((x * c - y * s) * MM, (x * s + y * c) * MM)


def to_utm(x, y):
    return (E0 + x, N0 + y)


def build(doc, tf, text_h, unit_code):
    doc.header["$INSUNITS"] = unit_code
    msp = doc.modelspace()
    for name, color in (("LOTTO", 1), ("EDIFICIO", 5), ("STRADA", 8), ("VERDE", 3), ("TESTI", 7)):
        doc.layers.add(name, color=color)
    msp.add_lwpolyline([tf(*p) for p in LOTTO], close=True, dxfattribs={"layer": "LOTTO"})
    msp.add_lwpolyline([tf(*p) for p in EDIFICIO], close=True, dxfattribs={"layer": "EDIFICIO"})
    h = msp.add_hatch(color=5, dxfattribs={"layer": "EDIFICIO"})
    h.set_pattern_fill("ANSI31", scale=0.5 * (MM if text_h > 10 else 1))
    h.paths.add_polyline_path([tf(*p) for p in EDIFICIO], is_closed=True)
    for a, b in STRADA:
        msp.add_line(tf(*a), tf(*b), dxfattribs={"layer": "STRADA"})
    k = MM if text_h > 10 else 1
    for p in ALBERI:
        msp.add_circle(tf(*p), radius=2.5 * k, dxfattribs={"layer": "VERDE"})
    ang = 0 if text_h < 10 else math.degrees(ROT)
    msp.add_text("LOTTO 12", dxfattribs={"layer": "TESTI", "height": text_h * 1.4, "rotation": ang}).set_placement(tf(30, 40), align=ezdxf.enums.TextEntityAlignment.MIDDLE_CENTER)
    msp.add_text("EDIFICIO A", dxfattribs={"layer": "TESTI", "height": text_h, "rotation": ang}).set_placement(tf(22, 20), align=ezdxf.enums.TextEntityAlignment.MIDDLE_CENTER)
    msp.add_text("VIA DEI CAMPI", dxfattribs={"layer": "TESTI", "height": text_h, "rotation": ang}).set_placement(tf(40, -10), align=ezdxf.enums.TextEntityAlignment.MIDDLE_CENTER)
    for i, p in enumerate(LOTTO):
        msp.add_point(tf(*p), dxfattribs={"layer": "LOTTO"})
        msp.add_text(f"P{i + 1}", dxfattribs={"layer": "TESTI", "height": text_h * 0.8, "rotation": ang}).set_placement(tf(p[0] + 1, p[1] + 1))
    return msp


CS_DEF = ('<?xml version="1.0" encoding="UTF-16" standalone="no" ?>'
          '<Dictionary version="1.0" xmlns="http://www.osgeo.org/mapguide/coordinatesystem">'
          '<ProjectedCoordinateSystem id="RDN2008.UTM-32N"><Name>RDN2008.UTM-32N</Name>'
          '<Description>RDN2008 / UTM zone 32N</Description><Authority>EPSG</Authority>'
          '<AdditionalInformation><ParameterItem type="CsMap"><Key>CSQuadrantSimplified</Key><IntegerValue>1</IntegerValue></ParameterItem></AdditionalInformation>'
          '<DomainOfValidity><Extent><GeographicElement><GeographicBoundingBox><WestBoundLongitude>6</WestBoundLongitude>'
          '<EastBoundLongitude>12</EastBoundLongitude><SouthBoundLatitude>36</SouthBoundLatitude><NorthBoundLatitude>48</NorthBoundLatitude>'
          '</GeographicBoundingBox></GeographicElement></Extent></DomainOfValidity>'
          '<DatumId>RDN2008</DatumId><Axis uom="METER"><CoordinateSystemAxis><AxisOrder>1</AxisOrder><AxisName>Easting</AxisName>'
          '<AxisAbbreviation>E</AxisAbbreviation><AxisDirection>east</AxisDirection></CoordinateSystemAxis></Axis>'
          '<Conversion><Projection><OperationMethodId>Transverse Mercator</OperationMethodId></Projection></Conversion>'
          '</ProjectedCoordinateSystem>'
          '<Alias id="7791" type="CoordinateSystem"><ObjectId>RDN2008.UTM-32N</ObjectId><Namespace>EPSG Code</Namespace></Alias>'
          '</Dictionary>')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    doc = ezdxf.new("R2013")
    build(doc, to_utm, 1.6, 6)
    doc.saveas(OUT / "lotto_utm.dxf")

    doc = ezdxf.new("R2013")
    build(doc, to_local, 1600, 4)
    doc.saveas(OUT / "lotto_locale.dxf")

    doc = ezdxf.new("R2013")
    msp = build(doc, to_local, 1600, 4)
    north = (-math.sin(ROT), math.cos(ROT))  # direzione del nord nel piano del disegno
    geo = msp.new_geodata()
    geo.dxf.coordinate_type = 2
    geo.dxf.design_point = (0, 0, 0)
    geo.dxf.reference_point = (E0, N0, 0)
    geo.dxf.horizontal_unit_scale = 1 / MM
    geo.dxf.horizontal_units = 4
    geo.dxf.vertical_unit_scale = 1 / MM
    geo.dxf.vertical_units = 4
    geo.dxf.north_direction = north
    geo.coordinate_system_definition = CS_DEF
    doc.saveas(OUT / "lotto_geodata.dxf")

    # tavola PDF A3 orizzontale, scala 1:500, disegno locale (stessa rotazione)
    pdf = pymupdf.open()
    W, H = 1190.55, 841.89
    page = pdf.new_page(width=W, height=H)
    k = 1000 / SCALE_PDF * 72 / 25.4         # punti PDF per metro reale
    ox, oy = 360.0, 300.0                      # origine del rilievo sulla tavola (punti, y verso l'alto)

    def P(x, y):                               # metri relativi all'origine -> punto PDF (y verso il basso per PyMuPDF)
        lx, ly = to_local(x, y)
        px, py = ox + lx / MM * k, oy + ly / MM * k
        return pymupdf.Point(px, H - py), (px, py)

    sh = page.new_shape()
    for poly, col in ((LOTTO, (0.8, 0, 0)), (EDIFICIO, (0, 0, 0.8))):
        pts = [P(*p)[0] for p in poly]
        sh.draw_polyline(pts + [pts[0]])
        sh.finish(color=col, width=1.2)
    for a, b in STRADA:
        sh.draw_line(P(*a)[0], P(*b)[0])
        sh.finish(color=(0.4, 0.4, 0.4), width=0.8)
    for p in ALBERI:
        sh.draw_circle(P(*p)[0], 2.5 * k)
        sh.finish(color=(0, 0.5, 0), width=0.8)
    sh.draw_rect(pymupdf.Rect(20, 20, W - 20, H - 20)); sh.finish(color=(0, 0, 0), width=1)
    sh.draw_rect(pymupdf.Rect(W - 320, H - 120, W - 20, H - 20)); sh.finish(color=(0, 0, 0), width=0.8)
    sh.commit()
    page.insert_text((W - 310, H - 90), "PLANIMETRIA LOTTO 12", fontsize=14)
    page.insert_text((W - 310, H - 60), f"Scala 1:{SCALE_PDF}", fontsize=11)
    page.insert_text((W - 310, H - 40), "Coordinate locali, nord ruotato di 25 gradi", fontsize=9)
    pdf_pts = []
    for i, p in enumerate(LOTTO):
        pt, xy = P(*p)
        page.insert_text(pt + (4, -4), f"P{i + 1}", fontsize=8)
        pdf_pts.append(xy)
    pdf.save(OUT / "lotto_tavola.pdf")

    points = [{"nome": f"P{i + 1}", "utm": to_utm(*p), "locale_mm": to_local(*p), "pdf_pt": pdf_pts[i]} for i, p in enumerate(LOTTO)]
    (OUT / "punti_controllo.json").write_bytes((json.dumps({
        "crs": "EPSG:7791", "origine": [E0, N0], "rotazione_gradi": -25, "unita_locale": "mm", "scala_pdf": SCALE_PDF, "punti": points,
    }, indent=1) + "\n").encode())
    print("Campioni scritti in", OUT)


if __name__ == "__main__":
    main()
