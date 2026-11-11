"""Collaudo dei 3DSOLID scritti da mbvisual/acis_write.py: ogni solido si scrive in un DXF, si rilegge con il lettore ACIS di
MB Desk (acis.py + acis_step.py, indipendente dallo scrittore), si ricostruisce con OpenCascade e si confrontano volume, area,
ingombro e validita' con l'originale. Anche ezdxf deve rileggere il DXF.

    python tests/test_acis_write.py [file.step ...]   (con file: ogni solido dei file, esatto o a facce piane)
"""
from __future__ import annotations

import math
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepFilletAPI import BRepFilletAPI_MakeFillet
from OCP.BRepGProp import BRepGProp
from OCP.BRepPrimAPI import (BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCone, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakeRevol,
                             BRepPrimAPI_MakeSphere, BRepPrimAPI_MakeTorus)
from OCP.GProp import GProp_GProps
from OCP.gp import gp_Ax1, gp_Ax2, gp_Dir, gp_Pnt
from OCP.STEPControl import STEPControl_Reader
from OCP.TopAbs import TopAbs_EDGE
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS

from mbvisual import acis, acis_write
from mbvisual.acis_step import Converter, StepWriter, product

OK = FAIL = 0
TMP = Path(tempfile.mkdtemp(prefix="acisw-"))


def check(name, cond, info=""):
    global OK, FAIL
    if cond:
        OK += 1
        print("  OK  ", name)
    else:
        FAIL += 1
        print("  NO  ", name, info)


def props(shape):
    g = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, g)
    a = GProp_GProps()
    BRepGProp.SurfaceProperties_s(shape, a)
    return g.Mass(), a.Mass()


def reread(sat_text):
    """SAT -> STEP con il lettore di MB Desk -> forma OpenCascade."""
    header, records, subtypes = acis.parse_sat(sat_text)
    header["unit_mm"] = 1.0
    w = StepWriter()
    conv = Converter(header, records, subtypes, w)
    items = conv.bodies()
    if not items:
        return None, conv
    product(w, "prova", items)
    p = TMP / "rilettura.step"
    p.write_text(w.text("prova"), encoding="utf-8")
    rd = STEPControl_Reader()
    rd.ReadFile(str(p))
    rd.TransferRoots()
    return rd.OneShape(), conv


def roundtrip(name, shape, want_exact=True, voids=0.0, ref=None):
    out = TMP / ("".join(ch if ch.isalnum() else "_" for ch in name) + ".dxf")
    rep = acis_write.write_dxf(str(out), [(shape, name, "#3080c0")])
    sats = acis_write.dxf_bodies(str(out))
    exact = rep["esatti"] > 0 and not rep["a_facce"]
    v0, a0 = props(ref if ref is not None else shape)  # ref = stessa forma con le superfici analitiche
    got, conv = reread(sats[0]) if sats else (None, None)
    if got is None:
        check(f"{name}: riletto", False, conv and dict(conv.missing))
        return
    v1, a1 = props(got)
    if voids:  # il lettore di MB Desk fa un solido per guscio: la cavita' torna come solido a parte
        v1 -= 2 * voids
    valid = BRepCheck_Analyzer(got).IsValid()
    tol = 1e-6 if exact else 0.03
    ok = abs(abs(v1) - v0) <= tol * v0 and abs(a1 - a0) <= max(tol, 0.03 if not exact else 1e-5) * a0
    check(f"{name}: {'esatto' if exact else 'a facce piane'}, volume {v0:.6g} -> {abs(v1):.6g}, area {a0:.6g} -> {a1:.6g}",
          ok and (exact or not want_exact) and v1 > 0, f"valido={valid} missing={dict(conv.missing)} rep={rep}")
    if exact:
        check(f"{name}: rilettura valida per OpenCascade", valid)
    return sats


def main():
    box = BRepPrimAPI_MakeBox(gp_Pnt(10, 20, 30), 100, 60, 40).Shape()
    roundtrip("scatola", box)
    roundtrip("cilindro", BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(5, 5, 5), gp_Dir(1, 1, 0)), 25, 120).Shape())
    roundtrip("cono", BRepPrimAPI_MakeCone(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), 30, 10, 50).Shape())
    roundtrip("cono a punta", BRepPrimAPI_MakeCone(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 1, 0)), 30, 0, 50).Shape())
    roundtrip("sfera", BRepPrimAPI_MakeSphere(gp_Pnt(3, 4, 5), 40).Shape())
    roundtrip("semisfera", BRepPrimAPI_MakeSphere(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), 40, 0, math.pi / 2).Shape())
    roundtrip("toro", BRepPrimAPI_MakeTorus(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), 80, 15).Shape())
    roundtrip("toro a 90 gradi (curva di tubo)", BRepPrimAPI_MakeTorus(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), 150, 57.15, math.pi / 2).Shape())
    holed = BRepAlgoAPI_Cut(box, BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(60, 50, 0), gp_Dir(0, 0, 1)), 12, 100).Shape()).Shape()
    roundtrip("scatola con foro passante", holed)
    cav = BRepAlgoAPI_Cut(box, BRepPrimAPI_MakeBox(gp_Pnt(30, 30, 40), 20, 20, 10).Shape()).Shape()
    roundtrip("scatola con cavita' interna", cav, voids=4000.0)
    fm = BRepAlgoAPI_Fuse(box, BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(60, 50, 70), gp_Dir(0, 0, 1)), 20, 30).Shape()).Shape()
    roundtrip("scatola con perno", fm)
    mf = BRepFilletAPI_MakeFillet(box)
    ex = TopExp_Explorer(box, TopAbs_EDGE)
    while ex.More():
        mf.Add(6, TopoDS.Edge(ex.Current()))
        ex.Next()
    roundtrip("scatola raccordata (raccordi cilindrici e sferici)", mf.Shape())
    # tubo (cilindro cavo) e curva cava: le superfici interne hanno la normale verso l'asse
    tube = BRepAlgoAPI_Cut(BRepPrimAPI_MakeCylinder(57.15, 500).Shape(), BRepPrimAPI_MakeCylinder(51.13, 500).Shape()).Shape()
    roundtrip("tubo DN100", tube)
    bend = BRepAlgoAPI_Cut(BRepPrimAPI_MakeTorus(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), 152.4, 57.15, math.pi / 2).Shape(),
                           BRepPrimAPI_MakeTorus(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), 152.4, 51.13, math.pi / 2).Shape()).Shape()
    roundtrip("curva cava DN100", bend)
    # stesse forme scritte come B-spline (come negli STEP di SolidWorks): riconosciute come cilindri, tori e cerchi esatti
    from OCP.BRepBuilderAPI import BRepBuilderAPI_NurbsConvert
    roundtrip("tubo DN100 in B-spline", BRepBuilderAPI_NurbsConvert(tube, True).Shape(), ref=tube)
    roundtrip("scatola raccordata in B-spline", BRepBuilderAPI_NurbsConvert(mf.Shape(), True).Shape(), ref=mf.Shape())
    # superficie di rivoluzione non canonica (profilo a B-spline): ripiego a facce piane
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakeWire
    from OCP.GeomAPI import GeomAPI_PointsToBSpline
    from OCP.OCP.collections import Array1_gp_Pnt as TColgp_Array1OfPnt
    arr = TColgp_Array1OfPnt(1, 5)
    for i, (x, z) in enumerate([(20, 0), (35, 20), (25, 40), (40, 60), (20, 80)]):
        arr.SetValue(i + 1, gp_Pnt(x, 0, z))
    bs = GeomAPI_PointsToBSpline(arr).Curve()
    w = BRepBuilderAPI_MakeWire(BRepBuilderAPI_MakeEdge(gp_Pnt(0, 0, 0), gp_Pnt(20, 0, 0)).Edge(), BRepBuilderAPI_MakeEdge(bs).Edge(),
                                BRepBuilderAPI_MakeEdge(gp_Pnt(20, 0, 80), gp_Pnt(0, 0, 80)).Edge(), BRepBuilderAPI_MakeEdge(gp_Pnt(0, 0, 80), gp_Pnt(0, 0, 0)).Edge()).Wire()
    vase = BRepPrimAPI_MakeRevol(BRepBuilderAPI_MakeFace(w).Face(), gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1))).Shape()
    roundtrip("vaso (B-spline): ripiego a facce piane", vase, want_exact=False)
    # ezdxf rilegge il file e trova un 3DSOLID per solido
    import ezdxf
    out = TMP / "insieme.dxf"
    rep = acis_write.write_dxf(str(out), [(box, "Telaio", "#ff0000"), (tube, "Tubo", "#00ff00"), (vase, "Vaso", None)])
    d = ezdxf.readfile(str(out))
    sol = d.modelspace().query("3DSOLID")
    check("DXF con tre corpi: 3 3DSOLID su layer Telaio/Tubo/Vaso, unita' mm", len(sol) == 3 and {e.dxf.layer for e in sol} == {"Telaio", "Tubo", "Vaso"}
          and d.header["$INSUNITS"] == 4 and rep == {"esatti": 2, "a_facce": 1}, rep)
    # file veri
    for f in sys.argv[1:]:
        from mbvisual.modkernel import _read_cad
        parts = _read_cad(f)
        ex_n = fa_n = bad = 0
        for shape, name, col in parts:
            for body, okx in acis_write.shape_bodies(shape):
                if okx:
                    ex_n += 1
                else:
                    fa_n += 1
        o = TMP / (Path(f).stem + ".dxf")
        rep = acis_write.write_dxf(str(o), parts)
        tv = sum(props(s)[0] for s, _n, _c in parts)
        rv = 0.0
        for sat in acis_write.dxf_bodies(str(o)):
            g, _c = reread(sat)
            if g is None:
                bad += 1
            else:
                rv += abs(props(g)[0])
        check(f"{Path(f).name}: {len(parts)} parti, {rep['esatti']} solidi esatti, {rep['a_facce']} a facce piane, volume {tv:.6g} -> {rv:.6g}",
              bad == 0 and abs(rv - tv) <= 0.02 * tv, f"non riletti {bad}")
    print(f"\n{OK} riuscite, {FAIL} non riuscite  ({TMP})")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
