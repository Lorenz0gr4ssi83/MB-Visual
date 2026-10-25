"""Coppie di file per provare il confronto tra revisioni (tests/samples/confronto).

Per ogni tipo una revisione A e una B ottenuta modificando A: PDF (testi cambiati, aggiunti, tolti; grafica spostata;
pagina 2 traslata di qualche millimetro per provare l'allineamento automatico; pagina aggiunta), DXF (entita' tolte,
spostate, testo cambiato, layer cambiato, entita' nuove; handle conservati come in AutoCAD), IFC (elementi aggiunti,
eliminati, spostati, proprieta' cambiate).
Uso: python tools/make_compare_samples.py
"""
from __future__ import annotations

import hashlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "tests" / "samples" / "confronto"


# ---------------------------------------------------------------- PDF
def make_pdf(path: Path, rev: str):
    import pymupdf

    b = rev == "B"
    doc = pymupdf.open()
    p = doc.new_page(width=595, height=842)
    p.insert_text((56, 70), "RELAZIONE TECNICA - Capannone industriale", fontsize=16, fontname="hebo")
    p.insert_text((56, 92), f"Revisione {'B del 20/10/2026' if b else 'A del 01/09/2026'}", fontsize=10)
    paras = [
        "La struttura portante e' realizzata con telai in acciaio S355 posti a interasse di 6,00 m.",
        "Le fondazioni sono plinti in calcestruzzo armato C25/30 collegati da travi di fondazione.",
        "La copertura e' formata da pannelli sandwich con spessore di 80 mm e lucernari continui.",
        "Le pareti di tamponamento sono in pannelli prefabbricati di calcestruzzo da 20 cm.",
        "Il carico neve di progetto e' pari a 1,20 kN/m2 secondo le NTC 2018.",
    ]
    if b:
        paras[0] = paras[0].replace("6,00 m", "7,50 m")
        paras[2] = paras[2].replace("80 mm", "100 mm")
        del paras[3]
        paras.append("E' previsto un impianto fotovoltaico in copertura da 150 kWp.")
    y = 130
    for t in paras:
        p.insert_text((56, y), t, fontsize=10.5)
        y += 22
    # tabella dei materiali
    y += 20
    rows = [("Elemento", "Materiale", "Quantita'"), ("Pilastri", "HEB 300", "24"), ("Travi", "IPE 450", "36" if not b else "40"), ("Arcarecci", "IPE 160", "120")]
    for r in rows:
        for k, c in enumerate(r):
            p.insert_text((56 + k * 150, y), c, fontsize=10, fontname="hebo" if r is rows[0] else "helv")
        p.draw_line((56, y + 6), (506, y + 6), color=(0.6, 0.6, 0.6), width=0.5)
        y += 20

    # pagina 2: pianta schematica (nella B tutto traslato di 8 pt / 5 pt, un pilastro spostato e un cerchio in piu')
    p2 = doc.new_page(width=595, height=842)
    ox, oy = (8, 5) if b else (0, 0)
    p2.insert_text((56 + ox, 70 + oy), "PIANTA PIANO TERRA - scala 1:200", fontsize=13, fontname="hebo")
    p2.draw_rect(pymupdf.Rect(80 + ox, 120 + oy, 520 + ox, 520 + oy), color=(0, 0, 0), width=1.5)
    for i in range(5):
        for j in range(4):
            x, yy = 80 + i * 110 + ox, 120 + j * 133 + oy
            if b and i == 2 and j == 1:
                x += 25
            p2.draw_rect(pymupdf.Rect(x - 6, yy - 6, x + 6, yy + 6), color=(0, 0, 0), fill=(0.2, 0.2, 0.2))
    p2.draw_line((80 + ox, 320 + oy), (520 + ox, 320 + oy), color=(0, 0, 0), width=0.5, dashes="[4 3] 0")
    if b:
        p2.draw_circle((300 + ox, 420 + oy), 30, color=(0, 0, 0), width=1)
        p2.insert_text((270 + ox, 470 + oy), "Nuovo silo", fontsize=9)
    else:
        p2.insert_text((90 + ox, 500 + oy), "Deposito", fontsize=9)
    p2.insert_text((56 + ox, 600 + oy), "Note: quote in metri.", fontsize=10)
    if b:
        p3 = doc.new_page(width=595, height=842)
        p3.insert_text((56, 70), "ALLEGATO - Verifica impianto fotovoltaico", fontsize=13, fontname="hebo")
        p3.insert_text((56, 100), "Pannelli monocristallini da 450 Wp, 334 moduli.", fontsize=10.5)
    doc.set_metadata({"title": f"Relazione rev. {rev}"})
    doc.save(path)


# ---------------------------------------------------------------- DXF
def make_dxf(a: Path, b: Path):
    import ezdxf

    doc = ezdxf.new("R2018", setup=True)
    for name, col in (("MURI", 7), ("PORTE", 3), ("ARREDI", 5), ("TESTI", 2), ("QUOTE", 1)):
        doc.layers.add(name, color=col)
    blk = doc.blocks.new("TAVOLO")
    blk.add_lwpolyline([(0, 0), (1.6, 0), (1.6, 0.8), (0, 0.8)], close=True, dxfattribs={"layer": "0"})
    blk.add_circle((0.4, 1.1), 0.25)
    blk.add_circle((1.2, 1.1), 0.25)
    msp = doc.modelspace()
    walls = [((0, 0), (12, 0)), ((12, 0), (12, 8)), ((12, 8), (0, 8)), ((0, 8), (0, 0)), ((6, 0), (6, 5)), ((6, 6.2), (6, 8))]
    for p1, p2 in walls:
        msp.add_line(p1, p2, dxfattribs={"layer": "MURI"})
    msp.add_arc((6, 5), 1.0, 270, 360, dxfattribs={"layer": "PORTE"})
    msp.add_line((6, 5), (7, 5), dxfattribs={"layer": "PORTE"})
    msp.add_circle((3, 4), 0.5, dxfattribs={"layer": "ARREDI"})
    msp.add_circle((9, 2), 0.4, dxfattribs={"layer": "ARREDI"})
    msp.add_blockref("TAVOLO", (2, 1.5), dxfattribs={"layer": "ARREDI"})
    msp.add_blockref("TAVOLO", (8, 5.5), dxfattribs={"layer": "ARREDI"})
    msp.add_text("UFFICIO", dxfattribs={"layer": "TESTI", "height": 0.35, "insert": (2, 6.5)})
    msp.add_text("SALA RIUNIONI", dxfattribs={"layer": "TESTI", "height": 0.35, "insert": (7.5, 7)})
    msp.add_lwpolyline([(0.5, 0.5), (2.5, 0.5), (2.5, 1.2)], dxfattribs={"layer": "ARREDI"})
    d = msp.add_linear_dim(base=(0, -1), p1=(0, 0), p2=(12, 0), dxfattribs={"layer": "QUOTE"})
    d.render()
    doc.saveas(a)

    # revisione B: si parte da A (handle conservati, come una revisione salvata in AutoCAD)
    doc = ezdxf.readfile(a)
    msp = doc.modelspace()
    for e in list(msp):
        t = e.dxftype()
        if t == "LINE" and e.dxf.layer == "MURI" and tuple(e.dxf.start)[:2] == (6, 6.2):
            msp.delete_entity(e)  # muro tolto
        elif t == "CIRCLE" and tuple(e.dxf.center)[:2] == (9, 2):
            e.dxf.center = (9.5, 2.5)  # arredo spostato
        elif t == "TEXT" and e.dxf.text == "UFFICIO":
            e.dxf.text = "UFFICIO TECNICO"  # testo cambiato
        elif t == "CIRCLE" and tuple(e.dxf.center)[:2] == (3, 4):
            e.dxf.layer = "MURI"  # layer cambiato
    msp.add_line((0, 4), (6, 4), dxfattribs={"layer": "MURI"})  # muro nuovo
    msp.add_text("ARCHIVIO", dxfattribs={"layer": "TESTI", "height": 0.35, "insert": (2, 2.8)})
    msp.add_blockref("TAVOLO", (8, 1), dxfattribs={"layer": "ARREDI"})
    doc.saveas(b)


# ---------------------------------------------------------------- IFC
B64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$"


def guid(seed: str) -> str:
    h = int(hashlib.sha1(seed.encode()).hexdigest(), 16)
    return "".join(B64[(h >> (6 * i)) & 63] for i in range(22))


def make_ifc(path: Path, rev: str):
    b = rev == "B"
    L: list[str] = []
    n = [0]

    def add(s: str) -> int:
        n[0] += 1
        L.append(f"#{n[0]}={s};")
        return n[0]

    pt = lambda x, y, z=0.0: add(f"IFCCARTESIANPOINT(({x:.3f},{y:.3f},{z:.3f}))")  # noqa: E731
    dz, dx = add("IFCDIRECTION((0.,0.,1.))"), add("IFCDIRECTION((1.,0.,0.))")
    origin = pt(0, 0, 0)
    world = add(f"IFCAXIS2PLACEMENT3D(#{origin},#{dz},#{dx})")
    ctx = add(f"IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#{world},$)")
    body = add(f"IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#{ctx},$,.MODEL_VIEW.,$)")
    u1 = add("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)")
    u2 = add("IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)")
    u3 = add("IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)")
    units = add(f"IFCUNITASSIGNMENT((#{u1},#{u2},#{u3}))")
    proj = add(f"IFCPROJECT('{guid('proj')}',$,'Capannone',$,$,$,$,(#{ctx}),#{units})")

    def placement(rel, x, y, z, rot=False):
        p = pt(x, y, z)
        if rot:
            d = add("IFCDIRECTION((0.,1.,0.))")
            ax = add(f"IFCAXIS2PLACEMENT3D(#{p},#{dz},#{d})")
        else:
            ax = add(f"IFCAXIS2PLACEMENT3D(#{p},$,$)")
        return add(f"IFCLOCALPLACEMENT({'#%d' % rel if rel else '$'},#{ax})")

    site_pl = placement(None, 0, 0, 0)
    site = add(f"IFCSITE('{guid('site')}',$,'Lotto',$,$,#{site_pl},$,$,.ELEMENT.,$,$,$,$,$)")
    bld_pl = placement(site_pl, 0, 0, 0)
    bld = add(f"IFCBUILDING('{guid('bld')}',$,'Edificio A',$,$,#{bld_pl},$,$,.ELEMENT.,$,$,$)")
    st_pl = placement(bld_pl, 0, 0, 0)
    storey = add(f"IFCBUILDINGSTOREY('{guid('st')}',$,'Piano terra',$,$,#{st_pl},$,$,.ELEMENT.,0.)")
    add(f"IFCRELAGGREGATES('{guid('ag1')}',$,$,$,#{proj},(#{site}))")
    add(f"IFCRELAGGREGATES('{guid('ag2')}',$,$,$,#{site},(#{bld}))")
    add(f"IFCRELAGGREGATES('{guid('ag3')}',$,$,$,#{bld},(#{storey}))")

    def box_shape(lx, ly, h):
        c = add("IFCCARTESIANPOINT((0.,0.))")
        p2 = add(f"IFCAXIS2PLACEMENT2D(#{c},$)")
        prof = add(f"IFCRECTANGLEPROFILEDEF(.AREA.,$,#{p2},{lx:.3f},{ly:.3f})")
        o = pt(lx / 2, ly / 2, 0)
        ax = add(f"IFCAXIS2PLACEMENT3D(#{o},$,$)")
        solid = add(f"IFCEXTRUDEDAREASOLID(#{prof},#{ax},#{dz},{h:.3f})")
        rep = add(f"IFCSHAPEREPRESENTATION(#{body},'Body','SweptSolid',(#{solid}))")
        return add(f"IFCPRODUCTDEFINITIONSHAPE($,$,(#{rep}))")

    def pset(owner, name, props):
        ids = []
        for k, v in props.items():
            if isinstance(v, str):
                val = f"IFCLABEL('{v}')"
            elif isinstance(v, bool):
                val = f"IFCBOOLEAN(.{'T' if v else 'F'}.)"
            else:
                val = f"IFCREAL({float(v)})"
            ids.append(add(f"IFCPROPERTYSINGLEVALUE('{k}',$,{val},$)"))
        ps = add(f"IFCPROPERTYSET('{guid(name + str(owner) + rev)}',$,'{name}',$,({','.join('#%d' % i for i in ids)}))")
        add(f"IFCRELDEFINESBYPROPERTIES('{guid('r' + name + str(owner) + rev)}',$,$,$,(#{owner}),#{ps})")

    def qset(owner, name, qs):
        ids = [add(f"IFCQUANTITY{kind}('{k}',$,$,{v:.3f},$)") for k, (kind, v) in qs.items()]
        q = add(f"IFCELEMENTQUANTITY('{guid(name + str(owner) + rev)}',$,'{name}',$,$,({','.join('#%d' % i for i in ids)}))")
        add(f"IFCRELDEFINESBYPROPERTIES('{guid('q' + name + str(owner) + rev)}',$,$,$,(#{owner}),#{q})")

    elems = []
    walls = [("W1", 0, 0, 20, 0.3, "REI60"), ("W2", 0, 12, 20, 0.3, "REI60"), ("W3", 0, 0.3, 11.7, 0.3, "REI60"), ("W4", 19.7, 0.3, 11.7, 0.3, "REI60")]
    for key, x, y, lx, ly, fr in walls:
        rot = key in ("W3", "W4")
        if b and key == "W1":
            fr = "REI120"  # proprieta' cambiata
        if b and key == "W2":
            lx = 24  # muro allungato (geometria)
        pl = placement(st_pl, x + (ly if rot else 0), y, 0, rot)
        shape = box_shape(lx, ly, 6.0)
        name = f"Muro perimetrale {key}"
        w = add(f"IFCWALL('{guid(key)}',$,'{name}',$,$,#{pl},#{shape},'{key}',.STANDARD.)")
        pset(w, "Pset_WallCommon", {"FireRating": fr, "IsExternal": True, "LoadBearing": True})
        qset(w, "Qto_WallBaseQuantities", {"Length": ("LENGTH", lx), "Height": ("LENGTH", 6.0), "NetVolume": ("VOLUME", lx * ly * 6.0)})
        elems.append(w)
    for i in range(3):
        key = f"C{i + 1}"
        if b and key == "C2":
            continue  # pilastro eliminato
        pl = placement(st_pl, 5 + i * 5, 6, 0)
        c = add(f"IFCCOLUMN('{guid(key)}',$,'Pilastro {key}',$,$,#{pl},#{box_shape(0.4, 0.4, 6.0)},'{key}',.COLUMN.)")
        pset(c, "Pset_ColumnCommon", {"LoadBearing": True, "Reference": "HEB 300"})
        elems.append(c)
    pl = placement(st_pl, 0, 0, -0.3)
    slab_name = "Platea di fondazione" + (" rev. B" if b else "")
    s = add(f"IFCSLAB('{guid('S1')}',$,'{slab_name}',$,$,#{pl},#{box_shape(20, 12.3, 0.3)},'S1',.BASESLAB.)")
    pset(s, "Pset_SlabCommon", {"LoadBearing": True, "Reference": "C25/30"})
    elems.append(s)
    if b:
        pl = placement(st_pl, 0, 5.8, 5.4)
        bm = add(f"IFCBEAM('{guid('B1')}',$,'Trave di bordo B1',$,$,#{pl},#{box_shape(20, 0.4, 0.6)},'B1',.BEAM.)")
        pset(bm, "Pset_BeamCommon", {"LoadBearing": True, "Reference": "IPE 450"})
        elems.append(bm)
    add(f"IFCRELCONTAINEDINSPATIALSTRUCTURE('{guid('cont')}',$,$,$,({','.join('#%d' % e for e in elems)}),#{storey})")

    head = (
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');\n"
        f"FILE_NAME('capannone_rev{rev}.ifc','2026-10-22T10:00:00',('MB Desk'),('MB Group'),'','make_compare_samples','');\n"
        "FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n"
    )
    path.write_text(head + "\n".join(L) + "\nENDSEC;\nEND-ISO-10303-21;\n", encoding="utf-8")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    make_pdf(OUT / "relazione_revA.pdf", "A")
    make_pdf(OUT / "relazione_revB.pdf", "B")
    make_dxf(OUT / "pianta_revA.dxf", OUT / "pianta_revB.dxf")
    make_ifc(OUT / "capannone_revA.ifc", "A")
    make_ifc(OUT / "capannone_revB.ifc", "B")
    for f in sorted(OUT.iterdir()):
        print(f.name, f.stat().st_size)


if __name__ == "__main__":
    main()
