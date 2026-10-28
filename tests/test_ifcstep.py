"""Collaudo della conversione IFC -> STEP nel motore (mbvisual/ifcstep.py).

  python tests/test_ifcstep.py [file.ifc | cartella ...]

Senza argomenti usa gli IFC del repository (tests/samples/interferenze, tests/samples/misure) e un IFC sintetico scritto qui
con IfcOpenShell che contiene i casi difficili: muro con apertura sottratta (IfcRelVoidsElement), istanze (IfcMappedItem),
IfcFacetedBrep, IfcAdvancedBrep (B-spline), estrusione circolare (cilindro esatto), CSG (IfcBooleanResult), sweep lungo una
curva (IfcSweptDiskSolid), elemento composto (IfcRelAggregates) senza geometria propria, nomi con accenti e apostrofi,
colori e trasparenza. Per ogni file: conversione, poi tests/ifcstep_fedelta.py (rilettura con OpenCascade come un CAD).
Richiesti: 100% degli elementi, ingombri e volumi coincidenti, nessun elemento fallito, struttura con radice = progetto.
Prove extra: file non IFC -> messaggio chiaro; conversione interrotta; processo di scrittura in crash su un elemento
(MBV_IFCSTEP_CRASH) -> l'elemento finisce nel rapporto e gli altri si convertono.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("LOCALAPPDATA", tempfile.mkdtemp(prefix="mbv-prova-ifcstep-"))

OK = KO = 0


def check(cond, msg):
    global OK, KO
    if cond:
        OK += 1
    else:
        KO += 1
        print("ERRORE:", msg)


def make_sample(path: Path) -> None:
    """IFC4 sintetico con i casi difficili (scritto con l'API di IfcOpenShell)."""
    import ifcopenshell
    import ifcopenshell.api as api
    import ifcopenshell.guid as G
    f = ifcopenshell.file(schema="IFC4")
    proj = api.run("root.create_entity", f, ifc_class="IfcProject", name="Progetto d'esempio è")
    api.run("unit.assign_unit", f, length={"is_metric": True, "raw": "MILLIMETERS"})
    ctx = api.run("context.add_context", f, context_type="Model")
    body = api.run("context.add_context", f, context_type="Model", context_identifier="Body", target_view="MODEL_VIEW", parent=ctx)
    site = api.run("root.create_entity", f, ifc_class="IfcSite", name="Sito")
    bld = api.run("root.create_entity", f, ifc_class="IfcBuilding", name="Edificio")
    st = api.run("root.create_entity", f, ifc_class="IfcBuildingStorey", name="Piano terra")
    api.run("aggregate.assign_object", f, relating_object=proj, products=[site])
    api.run("aggregate.assign_object", f, relating_object=site, products=[bld])
    api.run("aggregate.assign_object", f, relating_object=bld, products=[st])
    O = f.createIfcCartesianPoint((0.0, 0.0, 0.0))
    Z = f.createIfcDirection((0.0, 0.0, 1.0))
    X = f.createIfcDirection((1.0, 0.0, 0.0))

    def place(x=0.0, y=0.0, z=0.0):
        return f.createIfcLocalPlacement(None, f.createIfcAxis2Placement3D(f.createIfcCartesianPoint((x, y, z)), Z, X))

    def shape(items, kind):
        return f.createIfcProductDefinitionShape(None, None, [f.createIfcShapeRepresentation(body, "Body", kind, items)])

    def colour(item, rgb, transp=0.0):
        col = f.createIfcColourRgb(None, *rgb)
        ss = f.createIfcSurfaceStyle(None, "BOTH", [f.createIfcSurfaceStyleRendering(col, transp, None, None, None, None, None, None, "NOTDEFINED")])
        f.createIfcStyledItem(item, [ss], None)

    def elem(cls, name, items, kind, x=0.0, y=0.0, z=0.0, rgb=None, transp=0.0):
        e = f.create_entity(cls, GlobalId=G.new(), Name=name, ObjectPlacement=place(x, y, z), Representation=shape(items, kind))
        if rgb:
            for it in items:
                colour(it, rgb, transp)
        api.run("spatial.assign_container", f, relating_structure=st, products=[e])
        return e

    def box(w, d, h, x=0.0, y=0.0, z=0.0):
        prof = f.createIfcRectangleProfileDef("AREA", None, f.createIfcAxis2Placement2D(f.createIfcCartesianPoint((w / 2, d / 2)), None), w, d)
        return f.createIfcExtrudedAreaSolid(prof, f.createIfcAxis2Placement3D(f.createIfcCartesianPoint((x, y, z)), Z, X), Z, h)

    # muro con apertura sottratta (e una finestra trasparente nell'apertura)
    wall = elem("IfcWall", "Muro con finestra", [box(5000, 300, 3000)], "SweptSolid", rgb=(0.8, 0.7, 0.6))
    op = f.create_entity("IfcOpeningElement", GlobalId=G.new(), Name="Apertura", ObjectPlacement=place(), Representation=shape([box(1200, 400, 1400, 1500, -50, 900)], "SweptSolid"))
    f.createIfcRelVoidsElement(G.new(), None, None, None, wall, op)
    win = elem("IfcWindow", "Finestra 'vetro'", [box(1200, 60, 1400, 1500, 120, 900)], "SweptSolid", rgb=(0.4, 0.6, 0.9), transp=0.6)
    f.createIfcRelFillsElement(G.new(), None, None, None, op, win)
    # istanze: stessa geometria mappata in 3 posizioni
    src = f.createIfcRepresentationMap(f.createIfcAxis2Placement3D(O, Z, X), f.createIfcShapeRepresentation(body, "Body", "SweptSolid", [box(400, 400, 3000)]))
    for i in range(3):
        mi = f.createIfcMappedItem(src, f.createIfcCartesianTransformationOperator3D(None, None, f.createIfcCartesianPoint((0.0, 0.0, 0.0)), None, None))
        e = f.create_entity("IfcColumn", GlobalId=G.new(), Name=f"Pilastro {i + 1}", ObjectPlacement=place(7000 + i * 2000, 0.0, 0.0),
                            Representation=f.createIfcProductDefinitionShape(None, None, [f.createIfcShapeRepresentation(body, "Body", "MappedRepresentation", [mi])]))
        api.run("spatial.assign_container", f, relating_structure=st, products=[e])
    # IfcFacetedBrep: piramide
    pts = [f.createIfcCartesianPoint(p) for p in ((0.0, 0.0, 0.0), (1000.0, 0.0, 0.0), (1000.0, 1000.0, 0.0), (0.0, 1000.0, 0.0), (500.0, 500.0, 800.0))]
    faces = [(0, 3, 2, 1), (0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)]
    shell = f.createIfcClosedShell([f.createIfcFace([f.createIfcFaceOuterBound(f.createIfcPolyLoop([pts[i] for i in fc]), True)]) for fc in faces])
    elem("IfcBuildingElementProxy", "Piramide (FacetedBrep)", [f.createIfcFacetedBrep(shell)], "Brep", x=0.0, y=3000.0, rgb=(0.9, 0.2, 0.2))
    # cilindro esatto (estrusione di un cerchio)
    circ = f.createIfcCircleProfileDef("AREA", None, f.createIfcAxis2Placement2D(f.createIfcCartesianPoint((0.0, 0.0)), None), 250.0)
    cyl = f.createIfcExtrudedAreaSolid(circ, f.createIfcAxis2Placement3D(O, Z, X), Z, 2500.0)
    elem("IfcColumn", "Pilastro tondo", [cyl], "SweptSolid", x=3000.0, y=3000.0, rgb=(0.3, 0.8, 0.3))
    # CSG: blocco meno cilindro
    blk = box(1000, 1000, 1000)
    hole = f.createIfcExtrudedAreaSolid(f.createIfcCircleProfileDef("AREA", None, f.createIfcAxis2Placement2D(f.createIfcCartesianPoint((500.0, 500.0)), None), 200.0),
                                        f.createIfcAxis2Placement3D(f.createIfcCartesianPoint((0.0, 0.0, -10.0)), Z, X), Z, 1020.0)
    elem("IfcBuildingElementProxy", "Blocco forato (CSG)", [f.createIfcBooleanResult("DIFFERENCE", blk, hole)], "CSG", x=5000.0, y=3000.0)
    # sweep di un disco lungo una polilinea (tubo)
    curve = f.createIfcPolyline([f.createIfcCartesianPoint(p) for p in ((0.0, 0.0, 500.0), (2000.0, 0.0, 500.0), (2000.0, 1500.0, 500.0))])
    elem("IfcPipeSegment", "Tubo (sweep)", [f.createIfcSweptDiskSolid(curve, 50.0, None, None, None)], "AdvancedSweptSolid", x=7000.0, y=3000.0, rgb=(0.2, 0.4, 0.9))
    # IfcAdvancedBrep: cubo da 1 m con 5 facce IfcPlane e la faccia superiore B-spline (grado 1), lati IfcEdgeCurve
    V = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]
    vp = [f.createIfcCartesianPoint(tuple(c * 1000.0 for c in v)) for v in V]
    vx = [f.createIfcVertexPoint(p) for p in vp]
    edges = {}

    def oedge(a, b):
        k = (min(a, b), max(a, b))
        if k not in edges:
            edges[k] = f.createIfcEdgeCurve(vx[k[0]], vx[k[1]], f.createIfcPolyline([vp[k[0]], vp[k[1]]]), True)
        return f.create_entity("IfcOrientedEdge", EdgeElement=edges[k], Orientation=(a, b) == k)

    def aface(loop, surf):
        el_ = f.createIfcEdgeLoop([oedge(a, b) for a, b in zip(loop, loop[1:] + loop[:1])])
        return f.createIfcAdvancedFace([f.createIfcFaceOuterBound(el_, True)], surf, True)

    def plane(p, n, x):
        return f.createIfcPlane(f.createIfcAxis2Placement3D(f.createIfcCartesianPoint(p), f.createIfcDirection(n), f.createIfcDirection(x)))

    top = f.createIfcBSplineSurfaceWithKnots(1, 1, [[vp[4], vp[7]], [vp[5], vp[6]]], "UNSPECIFIED", False, False, False,
                                             (2, 2), (2, 2), (0.0, 1.0), (0.0, 1.0), "UNSPECIFIED")
    adv_faces = [
        aface([0, 3, 2, 1], plane((0.0, 0.0, 0.0), (0.0, 0.0, -1.0), (1.0, 0.0, 0.0))),
        aface([4, 5, 6, 7], top),
        aface([0, 1, 5, 4], plane((0.0, 0.0, 0.0), (0.0, -1.0, 0.0), (1.0, 0.0, 0.0))),
        aface([1, 2, 6, 5], plane((1000.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0))),
        aface([2, 3, 7, 6], plane((0.0, 1000.0, 0.0), (0.0, 1.0, 0.0), (1.0, 0.0, 0.0))),
        aface([3, 0, 4, 7], plane((0.0, 0.0, 0.0), (-1.0, 0.0, 0.0), (0.0, 1.0, 0.0))),
    ]
    elem("IfcSlab", "Blocco B-spline (AdvancedBrep)", [f.createIfcAdvancedBrep(f.createIfcClosedShell(adv_faces))], "AdvancedBrep",
         x=9000.0, y=3000.0, rgb=(0.7, 0.5, 0.9))
    # elemento composto: scala = 3 gradini, la scala non ha geometria propria
    stair = f.create_entity("IfcStair", GlobalId=G.new(), Name="Scala", ObjectPlacement=place(0.0, 6000.0, 0.0))
    api.run("spatial.assign_container", f, relating_structure=st, products=[stair])
    steps = []
    for i in range(3):
        s = f.create_entity("IfcStairFlight", GlobalId=G.new(), Name=f"Gradino {i + 1}", ObjectPlacement=place(0.0, 6000.0 + i * 300, i * 170.0),
                            Representation=shape([box(1200, 300, 170)], "SweptSolid"))
        steps.append(s)
    api.run("aggregate.assign_object", f, relating_object=stair, products=steps)
    f.write(str(path))


def convert_and_measure(ifc: Path, out: Path) -> tuple[dict, dict]:
    from mbvisual import ifcstep
    rep = ifcstep.convert(str(ifc), str(out))
    p = subprocess.run([sys.executable, str(ROOT / "tests" / "ifcstep_fedelta.py"), str(ifc), str(out), "--json", str(out) + ".json"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    try:
        meas = json.loads(Path(str(out) + ".json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        meas = {"errore": p.stdout[-500:] + p.stderr[-1500:]}
    return rep, meas


def main():
    from mbvisual import ifcstep
    if not ifcstep.available():
        print("IfcOpenShell o OCP non installati: collaudo saltato")
        return 0
    tmp = Path(tempfile.mkdtemp(prefix="mbv-ifcstep-"))
    files = []
    for a in sys.argv[1:]:
        p = Path(a)
        files += sorted(p.glob("*.ifc")) if p.is_dir() else [p]
    if not files:
        files = sorted((ROOT / "tests" / "samples" / "interferenze").glob("*.ifc")) + sorted((ROOT / "tests" / "samples" / "misure").glob("*.ifc"))
        syn = tmp / "casi_difficili.ifc"
        make_sample(syn)
        files.append(syn)
    print(f"{'file':40} {'attesi':>7} {'STEP':>7} {'ingombro':>9} {'volume':>7} {'falliti':>7} {'tempo':>7}")
    for ifc in files:
        out = tmp / (ifc.stem + ".stp")
        t0 = time.time()
        try:
            rep, m = convert_and_measure(ifc, out)
        except Exception as e:  # noqa: BLE001
            check(False, f"{ifc.name}: {e}")
            continue
        if "errore" in m:
            check(False, f"{ifc.name}: misura non riuscita {m['errore']}")
            continue
        print(f"{ifc.name[:40]:40} {m['attesi']:7} {m['nello_step']:7} {len(m['ingombro_diverso']):9} {len(m['volume_diverso']):7} {len(rep['falliti']):7} {time.time() - t0:6.1f}s")
        check(m["nello_step"] == m["attesi"] and m["guid_presenti"] == m["attesi"], f"{ifc.name}: elementi {m['nello_step']}/{m['attesi']} {m['mancanti'][:3]}")
        check(not m["ingombro_diverso"], f"{ifc.name}: ingombri diversi {m['ingombro_diverso'][:3]}")
        check(not m["volume_diverso"], f"{ifc.name}: volumi diversi {m['volume_diverso'][:3]}")
        check(not rep["falliti"], f"{ifc.name}: falliti {rep['falliti'][:3]}")
        check(m["senza_colore"] == 0, f"{ifc.name}: {m['senza_colore']} elementi senza colore")
        check(len(m["radici"]) == 1, f"{ifc.name}: radici {m['radici']}")
        if ifc.name == "casi_difficili.ifc":
            txt = out.read_text(encoding="latin-1")
            check("Progetto d''esempio \\X2\\00E8\\X0\\" in txt, "nome del progetto con apostrofo e accento")
            check("SURFACE_STYLE_TRANSPARENT" in txt, "trasparenza della finestra")
            check("CYLINDRICAL_SURFACE" in txt, "pilastro tondo come cilindro esatto")
            check(m["profondita"] >= 6, "albero progetto/sito/edificio/piano/scala/gradino")
            check("FACETED_BREP(" in txt and "ADVANCED_FACE(" in txt, "entrambi gli scrittori usati")
            check(txt.count("NEXT_ASSEMBLY_USAGE_OCCURRENCE('g") == 3, "3 pilastri = una geometria condivisa richiamata 3 volte")
    # conversione a lotti vera (mbvisual/batch.py) senza nessuna finestra: prima serviva la pagina (45 s / 30 min)
    from mbvisual import batch
    outdir = tmp / "lotto"
    r = batch.handle("start", {"op": "format", "opts": {"to": "step"}, "files": [{"path": str(f)} for f in files],
                               "out": {"mode": "cartella", "dir": str(outdir)}}, lambda k: None)
    bid = r["id"]
    b_status = lambda i: batch._BATCHES[i].status  # noqa: E731
    for _ in range(3600):
        if b_status(bid) in ("finito", "annullato", "errore"):
            break
        time.sleep(0.5)
    b = batch._BATCHES[bid]
    done = [it for it in b.items if it["status"] == "ok"]
    check(len(done) == len(files), f"lotto: {[(it['rel'], it['status'], it['msg'][:120]) for it in b.items]}")
    check(all(Path(o).stat().st_size > 0 for it in done for o in it["out"]), "lotto: file STEP scritti")
    print("lotto:", [(it["rel"], it["status"], it["msg"][:80]) for it in b.items])
    # file non IFC -> errore chiaro
    bad = tmp / "non_ifc.ifc"
    bad.write_text("questo non e' un IFC\n", encoding="utf-8")
    try:
        ifcstep.convert(str(bad), str(tmp / "x.stp"))
        check(False, "file non IFC accettato")
    except Exception as e:  # noqa: BLE001
        check("IFC" in str(e), f"messaggio per file non IFC: {e}")
    # interruzione
    try:
        ifcstep.convert(str(files[0]), str(tmp / "y.stp"), cancelled=lambda: True)
        check(False, "interruzione ignorata")
    except ifcstep.Cancel:
        check(not (tmp / "y.stp").exists(), "nessun file dopo l'interruzione")
    # crash di un processo di scrittura su un elemento: si salta quello, gli altri arrivano
    syn = next((f for f in files if f.name == "casi_difficili.ifc"), None)
    if syn:
        os.environ["MBV_IFCSTEP_CRASH"] = "Pilastro tondo"
        try:
            rep = ifcstep.convert(str(syn), str(tmp / "crash.stp"))
            names = [f.get("n") for f in rep["falliti"]]
            check(names == ["Pilastro tondo"] and rep["convertiti"] == rep["attesi"] - 1, f"crash: {rep['falliti']} {rep['convertiti']}/{rep['attesi']}")
        finally:
            del os.environ["MBV_IFCSTEP_CRASH"]
    print(f"{OK} prove riuscite, {KO} fallite (file in {tmp})")
    return 1 if KO else 0


if __name__ == "__main__":
    code = main()
    sys.stdout.flush()
    os._exit(code)
