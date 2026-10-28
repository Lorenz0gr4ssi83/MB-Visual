"""Disegni DXF di prova con contenuto 3D per la vista 3D dei DWG/DXF (ui/js/cad3d.js, mbvisual/cad3d.py).

    python tools/make_cad3d_samples.py   (con l'ambiente virtuale che ha ezdxf)

Scrive in tests/samples/cad3d:
  modello_r2000.dxf  solidi ACIS in testo SAT cifrato (DXF fino al 2010) + mesh, polyface, polygon mesh, 3DFACE,
                     cerchi e polilinee con spessore, blocco inserito ruotato nello spazio
  modello_r2018.dxf  lo stesso con i solidi in binario SAB nella sezione ACDSDATA (DXF 2013+)
  pianta_2d.dxf      disegno solo 2D (deve restare in 2D)
  attesi.json        cosa ci si aspetta (conteggi, ingombri)
I solidi sono poliedri (ezdxf crea corpi ACIS solo con facce piane): bastano per provare lettura, colori, layer e blocchi.
"""
from __future__ import annotations

import json
from pathlib import Path

import ezdxf
from ezdxf.acis import api as acis
from ezdxf.math import Matrix44
from ezdxf.render import forms

OUT = Path(__file__).resolve().parent.parent / "tests" / "samples" / "cad3d"


def build(version: str) -> ezdxf.document.Drawing:
    doc = ezdxf.new(version)
    for name, color in (("SOLIDI", 1), ("MESH", 3), ("FACCE", 5), ("SPESSORI", 30), ("BLOCCHI", 6)):
        doc.layers.add(name, color=color)
    msp = doc.modelspace()

    # solido: parallelepipedo 2000 x 1000 x 500 (unita' del disegno: mm) con l'angolo nell'origine
    box = forms.cube().scale(2000, 1000, 500).translate(1000, 500, 250)
    s = msp.add_3dsolid(dxfattribs={"layer": "SOLIDI"})
    acis.export_dxf(s, [acis.body_from_mesh(box)])
    # secondo solido con colore proprio (true color): cilindro poliedrico sopra il parallelepipedo
    cyl = forms.cylinder(count=24, radius=300, top_center=(0, 0, 800)).translate(1000, 500, 500)
    s2 = msp.add_3dsolid(dxfattribs={"layer": "SOLIDI", "true_color": ezdxf.rgb2int((20, 160, 220))})
    acis.export_dxf(s2, [acis.body_from_mesh(cyl)])

    # MESH (AcDbSubDMesh): piramide a base quadrata vicino al solido
    mesh = msp.add_mesh(dxfattribs={"layer": "MESH"})
    with mesh.edit_data() as md:
        md.vertices = [(3000, 0, 0), (4000, 0, 0), (4000, 1000, 0), (3000, 1000, 0), (3500, 500, 900)]
        md.faces = [(0, 1, 2, 3), (0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)]
    # polyface: cubo 500
    pf = msp.add_polyface(dxfattribs={"layer": "MESH"})
    cube = forms.cube().scale(500, 500, 500).translate(5000, 250, 250)
    for face in cube.faces_as_vertices():
        pf.append_face(face)
    # polygon mesh 4 x 5 (superficie ondulata)
    pm = msp.add_polymesh(size=(4, 5), dxfattribs={"layer": "MESH"})
    for i in range(4):
        for j in range(5):
            pm.set_mesh_vertex((i, j), (6000 + i * 300, j * 250, 100 * ((i + j) % 2)))
    # 3DFACE inclinata
    msp.add_3dface([(0, 2000, 0), (1000, 2000, 0), (1000, 2600, 600), (0, 2600, 600)], dxfattribs={"layer": "FACCE"})

    # oggetti con spessore: cerchio (cilindro con i coperchi), polilinea chiusa (pareti), linea (muro sottile)
    msp.add_circle((2000, 2500), 250, dxfattribs={"layer": "SPESSORI", "thickness": 1200})
    msp.add_lwpolyline([(3000, 2000), (4500, 2000), (4500, 3000), (3000, 3000)], close=True,
                       dxfattribs={"layer": "SPESSORI", "thickness": 2700, "elevation": 100})
    msp.add_line((5000, 2000, 0), (6500, 2000, 0), dxfattribs={"layer": "SPESSORI", "thickness": 1000})

    # blocco con un solido e una mesh, inserito due volte: uno ruotato nel piano, uno su un piano verticale (OCS)
    blk = doc.blocks.new("SEDIA", base_point=(0, 0, 0))
    seat = forms.cube().scale(450, 450, 60).translate(225, 225, 450)
    bs = blk.add_3dsolid(dxfattribs={"layer": "0", "color": 0})  # colore DaBlocco
    acis.export_dxf(bs, [acis.body_from_mesh(seat)])
    legs = blk.add_polyface(dxfattribs={"layer": "0"})
    for x, y in ((0, 0), (400, 0), (400, 400), (0, 400)):
        for face in forms.cube().scale(50, 50, 420).translate(x + 25, y + 25, 210).faces_as_vertices():
            legs.append_face(face)
    msp.add_blockref("SEDIA", (0, 4000), dxfattribs={"layer": "BLOCCHI", "rotation": 30, "color": 2})
    msp.add_blockref("SEDIA", (2000, 4000, 0), dxfattribs={"layer": "BLOCCHI", "extrusion": (0, -1, 0), "color": 4})

    # un po' di 2D (deve restare nella vista 2D e comparire come linee nella 3D)
    msp.add_line((0, -500), (7000, -500))
    msp.add_text("Modello di prova", dxfattribs={"insert": (0, -800), "height": 150})
    return doc


def plan() -> ezdxf.document.Drawing:
    doc = ezdxf.new("R2018")
    msp = doc.modelspace()
    for k in range(10):
        msp.add_lwpolyline([(k * 1000, 0), (k * 1000 + 800, 0), (k * 1000 + 800, 600), (k * 1000, 600)], close=True)
        msp.add_circle((k * 1000 + 400, 300), 200)
        msp.add_text(f"V{k}", dxfattribs={"insert": (k * 1000, 700), "height": 100})
    return doc


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    build("R2000").saveas(OUT / "modello_r2000.dxf")
    build("R2018").saveas(OUT / "modello_r2018.dxf")
    plan().saveas(OUT / "pianta_2d.dxf")
    attesi = {
        "modello_r2000.dxf": {"mostly": True, "solidi": 3, "mesh": 1, "polyface": 2, "polymesh": 1, "facce3d": 1,
                              "solido_principale": {"min": [0, 0, 0], "max": [2000, 1000, 500]}},
        "modello_r2018.dxf": {"mostly": True, "solidi": 3, "mesh": 1, "polyface": 2, "polymesh": 1, "facce3d": 1,
                              "solido_principale": {"min": [0, 0, 0], "max": [2000, 1000, 500]}},
        "pianta_2d.dxf": {"mostly": False, "any": False},
    }
    (OUT / "attesi.json").write_text(json.dumps(attesi, indent=1), encoding="utf-8")
    print("scritti in", OUT)


if __name__ == "__main__":
    main()
