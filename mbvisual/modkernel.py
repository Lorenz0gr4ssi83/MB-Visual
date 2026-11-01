"""Motore di modellazione 3D di solidi (B-rep OpenCascade), in un processo separato dall'app.

Il documento (.mbmod) sta nell'interfaccia (ui/js/modeler): e' l'elenco ordinato delle lavorazioni (cronologia). Prima di
ogni ricalcolo l'interfaccia lo "compila": parametri e quote valutati, schizzi risolti con i vincoli, profili scelti e
scritti come contorni espliciti (segmenti e archi nel piano dello schizzo). Questo processo riceve il documento compilato,
lo valuta lavorazione per lavorazione e restituisce, per ogni corpo, la triangolazione con le facce numerate, gli spigoli,
i vertici e le loro firme geometriche (servono alla selezione, all'aggancio e ai riferimenti).

Riferimenti a facce e spigoli: una lavorazione non tiene il numero della faccia (cambia a ogni ricalcolo) ma la sua firma
(tipo, baricentro assoluto e relativo all'ingombro del corpo, normale o direzione, area o lunghezza, raggio). Dopo un
ricalcolo si sceglie la faccia piu' simile; se nessuna e' abbastanza simile la lavorazione va in errore ("riferimento perso").

Stato: dopo ogni lavorazione lo stato (corpi) resta in memoria con la chiave = impronta di tutte le lavorazioni fino a
quella: cambiando l'ultima si ricalcola solo l'ultima. I corpi sono immutabili (ogni modifica crea un oggetto nuovo).

Protocollo: una richiesta JSON per riga sull'ingresso, risposte sull'uscita su righe che iniziano con TAG (OpenCascade
scrive altro testo sulla stessa uscita). I dati binari (triangolazioni) vanno in un file indicato dall'app.
OCP si importa SOLO in questo processo, mai nell'app (pesante).

    python -m mbvisual.modkernel --modeler-kernel <cartella dei dati>
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import struct
import sys
import time
import traceback
from collections import OrderedDict

import numpy as np

TAG = "@@MBK "
BIG = 1e5  # "passante": lunghezza degli strumenti che attraversano tutto (mm)

# ------------------------------------------------------------------------------------------------- OpenCascade
from OCP.BRep import BRep_Builder, BRep_Tool  # noqa: E402
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface  # noqa: E402
from OCP.BRepAlgoAPI import BRepAlgoAPI_Common, BRepAlgoAPI_Cut, BRepAlgoAPI_Defeaturing, BRepAlgoAPI_Fuse  # noqa: E402
from OCP.BRepBndLib import BRepBndLib  # noqa: E402
from OCP.BRepBuilderAPI import (BRepBuilderAPI_GTransform, BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeFace,  # noqa: E402
                                BRepBuilderAPI_MakePolygon, BRepBuilderAPI_MakeSolid, BRepBuilderAPI_MakeWire,
                                BRepBuilderAPI_Sewing, BRepBuilderAPI_Transform)
from OCP.BRepCheck import BRepCheck_Analyzer  # noqa: E402
from OCP.BRepExtrema import BRepExtrema_DistShapeShape  # noqa: E402
from OCP.BRepFilletAPI import BRepFilletAPI_MakeChamfer, BRepFilletAPI_MakeFillet  # noqa: E402
from OCP.BRepGProp import BRepGProp  # noqa: E402
from OCP.BRepMesh import BRepMesh_IncrementalMesh  # noqa: E402
from OCP.BRepOffset import BRepOffset_MakeOffset, BRepOffset_Skin  # noqa: E402
from OCP.BRepOffsetAPI import BRepOffsetAPI_MakeThickSolid  # noqa: E402
from OCP.BRepPrimAPI import (BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCone, BRepPrimAPI_MakeCylinder,  # noqa: E402
                             BRepPrimAPI_MakePrism, BRepPrimAPI_MakeRevol, BRepPrimAPI_MakeSphere,
                             BRepPrimAPI_MakeTorus)
from OCP.BRepTools import BRepTools  # noqa: E402
from OCP.Bnd import Bnd_Box  # noqa: E402
from OCP.GC import GC_MakeArcOfCircle  # noqa: E402
from OCP.GCPnts import GCPnts_TangentialDeflection  # noqa: E402
from OCP.GeomAbs import (GeomAbs_Arc, GeomAbs_Circle, GeomAbs_Cone, GeomAbs_Cylinder, GeomAbs_Intersection,  # noqa: E402
                         GeomAbs_Line, GeomAbs_Plane, GeomAbs_Sphere, GeomAbs_Torus)
from OCP.GProp import GProp_GProps  # noqa: E402
from OCP.OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher as ShapeMap  # noqa: E402
from OCP.OCP.collections import List_TopoDS_Shape as ShapeList  # noqa: E402
from OCP.ShapeFix import ShapeFix_Face, ShapeFix_Shape, ShapeFix_Solid  # noqa: E402
from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain  # noqa: E402
from OCP.TopAbs import (TopAbs_COMPOUND, TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED, TopAbs_SHELL,  # noqa: E402
                        TopAbs_SOLID, TopAbs_VERTEX)
from OCP.TopExp import TopExp, TopExp_Explorer  # noqa: E402
from OCP.TopLoc import TopLoc_Location  # noqa: E402
from OCP.TopoDS import TopoDS, TopoDS_Compound, TopoDS_Shape  # noqa: E402
from OCP.gp import gp_Ax1, gp_Ax2, gp_Ax3, gp_Circ, gp_Dir, gp_GTrsf, gp_Mat, gp_Pln, gp_Pnt, gp_Trsf, gp_Vec, gp_XYZ  # noqa: E402


class FeatureError(Exception):
    """Errore di una lavorazione: messaggio = chiave srv_modeler.* (tradotta nell'interfaccia) + argomenti."""

    def __init__(self, key, *args):
        super().__init__(key)
        self.key = key
        self.args2 = [str(a) for a in args]


# ------------------------------------------------------------------------------------------------- corpi
_UID = [0]


class Body:
    """Corpo immutabile: solido B-rep (kind "solid") o mesh (kind "mesh": vertici e triangoli, solo trasformazioni)."""
    __slots__ = ("uid", "shape", "mesh", "src", "_tess", "_sig")

    def __init__(self, shape=None, mesh=None, src=""):
        _UID[0] += 1
        self.uid = _UID[0]
        self.shape = shape
        self.mesh = mesh  # (vertici float64 n x 3, triangoli int32 m x 3)
        self.src = src  # id della lavorazione che l'ha prodotto per ultima
        self._tess = None
        self._sig = None

    @property
    def kind(self):
        return "mesh" if self.mesh is not None else "solid"


def _p(v):
    return gp_Pnt(float(v[0]), float(v[1]), float(v[2]))


def _d(v):
    return gp_Dir(float(v[0]), float(v[1]), float(v[2]))


def _vec(v):
    return gp_Vec(float(v[0]), float(v[1]), float(v[2]))


def _n(v):
    a = np.asarray(v, dtype=float)
    ln = np.linalg.norm(a)
    return a / ln if ln > 1e-15 else a


def _shapes(shape, kind):
    m = ShapeMap()
    TopExp.MapShapes_s(shape, kind, m)
    return [m.FindKey(i) for i in range(1, m.Extent() + 1)]


def _count(shape, kind):
    m = ShapeMap()
    TopExp.MapShapes_s(shape, kind, m)
    return m.Extent()


def _bbox(shape):
    b = Bnd_Box()
    BRepBndLib.Add_s(shape, b, True)
    if b.IsVoid():
        return None
    p0, p1 = b.CornerMin(), b.CornerMax()
    return [p0.X(), p0.Y(), p0.Z(), p1.X(), p1.Y(), p1.Z()]


def _bbox_any(body):
    if body.mesh is not None:
        v = body.mesh[0]
        if not len(v):
            return None
        return [*v.min(0).tolist(), *v.max(0).tolist()]
    return _bbox(body.shape)


def _boxes_touch(a, b, tol=1e-3):
    return a and b and all(a[i] <= b[i + 3] + tol and b[i] <= a[i + 3] + tol for i in range(3))


def _clean(shape):
    """Facce complanari e spigoli inutili riuniti (dopo estrusioni e booleane, come un modellatore di superfici)."""
    try:
        u = ShapeUpgrade_UnifySameDomain(shape, True, True, False)
        u.Build()
        s = u.Shape()
        if not s.IsNull():
            shape = s
    except Exception:  # noqa: BLE001
        pass
    # un compound con un solo solido diventa il solido
    if shape.ShapeType() == TopAbs_COMPOUND:
        sol = _shapes(shape, TopAbs_SOLID)
        if len(sol) == 1 and _count(shape, TopAbs_FACE) == _count(sol[0], TopAbs_FACE):
            shape = sol[0]
    return shape


def _empty(shape):
    return shape is None or shape.IsNull() or _count(shape, TopAbs_FACE) == 0


def _volume(shape):
    g = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, g)
    return g.Mass()


def _bool(kind, a, b):
    op = {"fuse": BRepAlgoAPI_Fuse, "cut": BRepAlgoAPI_Cut, "common": BRepAlgoAPI_Common}[kind]
    args, tools = ShapeList(), ShapeList()
    args.Append(a)
    for t in (b if isinstance(b, list) else [b]):
        tools.Append(t)
    o = op()
    o.SetArguments(args)
    o.SetTools(tools)
    o.SetRunParallel(True)
    o.SetFuzzyValue(1e-5)
    o.Build()
    if not o.IsDone():
        raise FeatureError("srv_modeler.booleana_fallita")
    s = o.Shape()
    return s


def _compound(shapes):
    c = TopoDS_Compound()
    bb = BRep_Builder()
    bb.MakeCompound(c)
    for s in shapes:
        bb.Add(c, s)
    return c


def _orient(shape):
    """Solidi nati da estrusioni e rivoluzioni nel verso opposto alla normale del profilo hanno le facce rivolte verso
    l'interno (volume negativo): si girano, altrimenti normali, accoppiamenti e booleane risultano sbagliati."""
    try:
        out = []
        for so in _shapes(shape, TopAbs_SOLID):
            out.append(so.Reversed() if _volume(so) < 0 else so)
        if not out:
            return shape
        return out[0] if len(out) == 1 and shape.ShapeType() == TopAbs_SOLID else _compound(out)
    except Exception:  # noqa: BLE001
        return shape


def _fuse_all(shapes):
    shapes = [_orient(s) for s in shapes if not _empty(s)]
    if not shapes:
        return None
    if len(shapes) == 1:
        return shapes[0]
    return _clean(_bool("fuse", shapes[0], shapes[1:]))


def _touching(a, b):
    """Due forme si toccano o si compenetrano (distanza minima nulla)."""
    try:
        d = BRepExtrema_DistShapeShape(a, b)
        return d.IsDone() and d.Value() < 1e-4
    except Exception:  # noqa: BLE001
        return True


def _check(shape):
    try:
        return BRepCheck_Analyzer(shape).IsValid()
    except Exception:  # noqa: BLE001
        return False


def _fix(shape):
    try:
        f = ShapeFix_Shape(shape)
        f.Perform()
        return f.Shape()
    except Exception:  # noqa: BLE001
        return shape


# ------------------------------------------------------------------------------------------------- firme e riferimenti
def _face_info(face):
    """Tipo e dati geometrici di una faccia: piano (origine, normale uscente), cilindro/cono (asse, raggio)..."""
    s = BRepAdaptor_Surface(face)
    t = s.GetType()
    rev = face.Orientation() == TopAbs_REVERSED
    if t == GeomAbs_Plane:
        pl = s.Plane()
        ax = pl.Position()
        # normale della superficie = X x Y (con un riferimento "sinistrorso" e' l'opposto di Direction)
        n = ax.XDirection().Crossed(ax.YDirection())
        nv = [n.X(), n.Y(), n.Z()]
        if rev:
            nv = [-c for c in nv]
        o = pl.Location()
        return {"t": "plane", "n": nv, "o": [o.X(), o.Y(), o.Z()]}
    if t in (GeomAbs_Cylinder, GeomAbs_Cone):
        g = s.Cylinder() if t == GeomAbs_Cylinder else s.Cone()
        ax = g.Axis()
        o, d = ax.Location(), ax.Direction()
        r = g.Radius() if t == GeomAbs_Cylinder else g.RefRadius()
        out = {"t": "cyl" if t == GeomAbs_Cylinder else "cone", "o": [o.X(), o.Y(), o.Z()], "n": [d.X(), d.Y(), d.Z()], "r": r}
        if t == GeomAbs_Cone:
            out["ang"] = math.degrees(g.SemiAngle())
        out["in"] = rev  # faccia rivolta verso l'asse (foro)
        return out
    if t == GeomAbs_Sphere:
        g = s.Sphere()
        o = g.Location()
        return {"t": "sphere", "o": [o.X(), o.Y(), o.Z()], "r": g.Radius()}
    if t == GeomAbs_Torus:
        g = s.Torus()
        ax = g.Axis()
        o, d = ax.Location(), ax.Direction()
        return {"t": "torus", "o": [o.X(), o.Y(), o.Z()], "n": [d.X(), d.Y(), d.Z()], "r": g.MajorRadius(), "r2": g.MinorRadius()}
    return {"t": "other"}


def _edge_info(edge):
    if BRep_Tool.Degenerated_s(edge):
        return {"t": "degen"}
    c = BRepAdaptor_Curve(edge)
    t = c.GetType()
    if t == GeomAbs_Line:
        d = c.Line().Direction()
        return {"t": "line", "d": [d.X(), d.Y(), d.Z()]}
    if t == GeomAbs_Circle:
        ci = c.Circle()
        o, d = ci.Location(), ci.Axis().Direction()
        closed = abs(c.LastParameter() - c.FirstParameter() - 2 * math.pi) < 1e-6
        return {"t": "circle", "o": [o.X(), o.Y(), o.Z()], "d": [d.X(), d.Y(), d.Z()], "r": ci.Radius(), "full": closed}
    return {"t": "curve"}


def _edge_points(edge, defl):
    if BRep_Tool.Degenerated_s(edge):
        return np.zeros((0, 3))
    c = BRepAdaptor_Curve(edge)
    try:
        if c.GetType() == GeomAbs_Line:
            p0, p1 = c.Value(c.FirstParameter()), c.Value(c.LastParameter())
            return np.array([[p0.X(), p0.Y(), p0.Z()], [p1.X(), p1.Y(), p1.Z()]])
        d = GCPnts_TangentialDeflection(c, 0.2, defl, 2)
        n = d.NbPoints()
        out = np.empty((n, 3))
        for i in range(1, n + 1):
            p = d.Value(i)
            out[i - 1] = (p.X(), p.Y(), p.Z())
        return out
    except Exception:  # noqa: BLE001
        return np.zeros((0, 3))


def _mesh_defl(shape):
    bb = _bbox(shape)
    if not bb:
        return 0.1, 0.4
    diag = math.dist(bb[:3], bb[3:])
    return max(diag * 0.0012, 1e-3), 0.35


def tessellate(body):
    """Triangolazione del corpo con facce numerate (l'ordine di TopExp.MapShapes: stabile per la stessa forma)."""
    if body._tess is not None:
        return body._tess
    if body.mesh is not None:
        v, f = body.mesh
        pos = v.astype(np.float32)
        idx = f.astype(np.uint32).reshape(-1)
        nrm = _normals(v, f)
        bb = _bbox_any(body) or [0] * 6
        size = np.maximum(np.array(bb[3:]) - np.array(bb[:3]), 1e-9)
        c = ((v[f[:, 0]] + v[f[:, 1]] + v[f[:, 2]]) / 3).mean(0) if len(f) else np.zeros(3)
        area = float(np.linalg.norm(np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]]), axis=1).sum() / 2) if len(f) else 0.0
        faces = [{"t": "mesh", "c": c.tolist(), "cn": ((c - bb[:3]) / size).tolist(), "a": area}]
        body._tess = {"pos": pos, "nrm": nrm.astype(np.float32), "idx": idx, "fr": np.array([0, len(f)], np.uint32),
                      "ep": np.zeros(0, np.float32), "er": np.zeros(0, np.uint32), "vp": np.zeros(0, np.float32),
                      "faces": faces, "edges": [], "bbox": bb, "props": _mesh_props(v, f)}
        return body._tess
    shape = body.shape
    lin, ang = _mesh_defl(shape)
    BRepMesh_IncrementalMesh(shape, lin, False, ang, True)
    bb = _bbox(shape) or [0] * 6
    bmin = np.array(bb[:3])
    size = np.maximum(np.array(bb[3:]) - bmin, 1e-9)
    P, N, I, FR, faces = [], [], [], [], []
    nbase = tri0 = 0
    emap = ShapeMap()
    TopExp.MapShapes_s(shape, TopAbs_EDGE, emap)
    for f in _shapes(shape, TopAbs_FACE):
        face = TopoDS.Face(f)
        info = _face_info(face)
        # spigoli della faccia (indici come in "edges"): un clic su una faccia sceglie i suoi spigoli (raccordi, smussi)
        fe, ex = [], TopExp_Explorer(face, TopAbs_EDGE)
        while ex.More():
            k = emap.FindIndex(ex.Current()) - 1
            if k >= 0 and k not in fe:
                fe.append(k)
            ex.Next()
        info["fe"] = fe
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face, loc)
        if tri is None:
            FR.append((tri0, 0))
            info.update({"c": [0, 0, 0], "cn": [0, 0, 0], "a": 0.0})
            faces.append(info)
            continue
        tr = loc.Transformation()
        nn, nt = tri.NbNodes(), tri.NbTriangles()
        pts = np.empty((nn, 3))
        for i in range(1, nn + 1):
            p = tri.Node(i).Transformed(tr)
            pts[i - 1] = (p.X(), p.Y(), p.Z())
        tris = np.empty((nt, 3), np.int64)
        for i in range(1, nt + 1):
            tris[i - 1] = tri.Triangle(i).Get()
        tris -= 1
        if face.Orientation() == TopAbs_REVERSED:
            tris = tris[:, [0, 2, 1]]
        nrm = _normals(pts, tris)
        a = pts[tris[:, 0]]
        cr = np.cross(pts[tris[:, 1]] - a, pts[tris[:, 2]] - a)
        ta = np.linalg.norm(cr, axis=1) / 2
        area = float(ta.sum())
        cen = ((a + pts[tris[:, 1]] + pts[tris[:, 2]]) / 3 * ta[:, None]).sum(0) / area if area > 0 else pts.mean(0)
        if info["t"] == "plane":  # facce piane: area e baricentro esatti (veloci), utili per misure e riferimenti
            g = GProp_GProps()
            BRepGProp.SurfaceProperties_s(face, g)
            if g.Mass() > 0:
                area = g.Mass()
                cm = g.CentreOfMass()
                cen = np.array([cm.X(), cm.Y(), cm.Z()])
        info.update({"c": cen.tolist(), "cn": ((cen - bmin) / size).tolist(), "a": area})
        faces.append(info)
        P.append(pts)
        N.append(nrm)
        I.append(tris + nbase)
        FR.append((tri0, nt))
        nbase += nn
        tri0 += nt
    EP, ER, edges = [], [], []
    e0 = 0
    for e in _shapes(shape, TopAbs_EDGE):
        edge = TopoDS.Edge(e)
        info = _edge_info(edge)
        pts = _edge_points(edge, lin)
        if len(pts) >= 2:
            seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
            ln = float(seg.sum())
            mid = pts[len(pts) // 2] if len(pts) % 2 else (pts[len(pts) // 2 - 1] + pts[len(pts) // 2]) / 2
            if info["t"] in ("line", "curve"):
                # punto a meta' lunghezza
                half, acc = ln / 2, 0.0
                for k, sl in enumerate(seg):
                    if acc + sl >= half and sl > 0:
                        mid = pts[k] + (pts[k + 1] - pts[k]) * ((half - acc) / sl)
                        break
                    acc += sl
        else:
            ln, mid = 0.0, np.zeros(3)
        info.update({"c": mid.tolist(), "cn": ((mid - bmin) / size).tolist(), "l": ln})
        if len(pts) >= 2:
            info["a0"] = pts[0].tolist()
            info["a1"] = pts[-1].tolist()
        edges.append(info)
        EP.append(pts)
        ER.append((e0, len(pts)))
        e0 += len(pts)
    VP = []
    for v in _shapes(shape, TopAbs_VERTEX):
        p = BRep_Tool.Pnt_s(TopoDS.Vertex(v))
        VP.append((p.X(), p.Y(), p.Z()))
    body._tess = {
        "pos": (np.concatenate(P) if P else np.zeros((0, 3))).astype(np.float32),
        "nrm": (np.concatenate(N) if N else np.zeros((0, 3))).astype(np.float32),
        "idx": (np.concatenate(I) if I else np.zeros((0, 3))).astype(np.uint32).reshape(-1),
        "fr": np.array(FR, np.uint32).reshape(-1),
        "ep": (np.concatenate(EP) if EP else np.zeros((0, 3))).astype(np.float32),
        "er": np.array(ER, np.uint32).reshape(-1),
        "vp": np.array(VP, np.float32).reshape(-1),
        "faces": faces, "edges": edges, "bbox": bb, "props": _props(shape),
    }
    return body._tess


def _normals(pts, tris):
    nrm = np.zeros_like(pts, dtype=float)
    if len(tris):
        a = pts[tris[:, 0]]
        cr = np.cross(pts[tris[:, 1]] - a, pts[tris[:, 2]] - a)
        for k in range(3):
            np.add.at(nrm, tris[:, k], cr)
    ln = np.linalg.norm(nrm, axis=1)
    ln[ln == 0] = 1
    return nrm / ln[:, None]


def _props(shape):
    g = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, g)
    vol = g.Mass()
    com = g.CentreOfMass()
    a = GProp_GProps()
    BRepGProp.SurfaceProperties_s(shape, a)
    return {"vol": abs(vol), "area": a.Mass(), "com": [com.X(), com.Y(), com.Z()],
            "solidi": _count(shape, TopAbs_SOLID), "facce": _count(shape, TopAbs_FACE), "spigoli": _count(shape, TopAbs_EDGE),
            "valido": _check(shape)}


def _mesh_props(v, f):
    if not len(f):
        return {"vol": 0, "area": 0, "com": [0, 0, 0], "triangoli": 0}
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    cr = np.cross(b - a, c - a)
    area = float(np.linalg.norm(cr, axis=1).sum() / 2)
    vol6 = np.einsum("ij,ij->i", a, np.cross(b, c))
    vol = float(vol6.sum() / 6)
    com = ((a + b + c) / 4 * vol6[:, None]).sum(0) / (vol * 6) if abs(vol) > 1e-12 else a.mean(0)
    return {"vol": abs(vol), "area": area, "com": com.tolist(), "triangoli": int(len(f))}


def _sigs(body):
    """Firme di facce e spigoli (dalla triangolazione: veloce anche con migliaia di facce)."""
    if body._sig is None:
        t = tessellate(body)
        bb = t["bbox"]
        diag = max(math.dist(bb[:3], bb[3:]), 1e-9)
        body._sig = (t["faces"], t["edges"], diag)
    return body._sig


def _score(ref, cand, diag, edge):
    if cand.get("t") in ("degen",):
        return 99.0
    s = 0.0 if cand.get("t") == ref.get("t") else 1.5
    c = np.array(cand.get("c", [0, 0, 0]))
    d_abs = float(np.linalg.norm(c - np.array(ref.get("c", [0, 0, 0])))) / diag
    d_rel = float(np.linalg.norm(np.array(cand.get("cn", [0, 0, 0])) - np.array(ref.get("cn", [0, 0, 0]))))
    s += 1.2 * min(d_abs, d_rel) + 0.2 * max(d_abs, d_rel)
    if ref.get("n") and cand.get("n"):
        dot = float(np.dot(_n(ref["n"]), _n(cand["n"])))
        s += 1.5 * ((1 - abs(dot)) if (edge or ref.get("t") in ("cyl", "cone", "torus")) else (1 - dot) / 2 * 2)
    if ref.get("d") and cand.get("d"):
        s += 1.5 * (1 - abs(float(np.dot(_n(ref["d"]), _n(cand["d"])))))
    ka = "l" if edge else "a"
    ra, ca = float(ref.get(ka) or 0), float(cand.get(ka) or 0)
    if max(ra, ca) > 0:
        s += 0.25 * abs(ra - ca) / max(ra, ca)
    if ref.get("r") and cand.get("r"):
        s += 0.4 * abs(ref["r"] - cand["r"]) / max(ref["r"], cand["r"])
    return s


def resolve(state, ref, kind=None):
    """Riferimento {b: corpo, k: f|e, ...firma} -> (corpo, indice della faccia/spigolo, forma)."""
    bid = ref.get("b")
    body = state.get(bid)
    if body is None:
        raise FeatureError("srv_modeler.corpo_mancante", bid)
    if body.mesh is not None:
        raise FeatureError("srv_modeler.solo_solidi")
    k = kind or ref.get("k", "f")
    faces, edges, diag = _sigs(body)
    cands = edges if k == "e" else faces
    if not cands:
        raise FeatureError("srv_modeler.riferimento_perso")
    sc = [_score(ref, c, diag, k == "e") for c in cands]
    i = int(np.argmin(sc))
    if sc[i] > 0.9:
        raise FeatureError("srv_modeler.riferimento_perso")
    shp = _shapes(body.shape, TopAbs_EDGE if k == "e" else TopAbs_FACE)[i]
    return body, i, (TopoDS.Edge(shp) if k == "e" else TopoDS.Face(shp))


# ------------------------------------------------------------------------------------------------- piani e profili
STD_PLANES = {
    "XY": ([0, 0, 0], [1, 0, 0], [0, 0, 1]),
    "XZ": ([0, 0, 0], [1, 0, 0], [0, -1, 0]),
    "YZ": ([0, 0, 0], [0, 1, 0], [1, 0, 0]),
}


def plane_from_normal(n, p0):
    """Piano per uno schizzo su una faccia: origine = proiezione dell'origine del mondo, asse X orizzontale se possibile
    (stessa regola di ui/js/modeler/mdoc.js facePlane)."""
    n = _n(n)
    o = n * float(np.dot(n, p0))
    if abs(n[2]) > 0.999:
        x = np.array([1.0, 0, 0])
    else:
        x = _n(np.cross([0, 0, 1.0], n))
    return o.tolist(), x.tolist(), n.tolist()


class Plane:
    def __init__(self, o, x, n):
        self.o = np.array(o, float)
        self.n = _n(n)
        self.x = _n(np.array(x, float) - self.n * float(np.dot(x, self.n)))
        self.y = np.cross(self.n, self.x)

    def to3(self, uv):
        return self.o + self.x * float(uv[0]) + self.y * float(uv[1])

    def ax3(self):
        return gp_Ax3(_p(self.o), _d(self.n), _d(self.x))

    def ax2(self, c):
        return gp_Ax2(_p(self.to3(c)), _d(self.n), _d(self.x))

    def js(self):
        return {"o": self.o.tolist(), "x": self.x.tolist(), "y": self.y.tolist(), "n": self.n.tolist()}


def _seg_edges(pl, seg):
    t = seg["t"]
    if t == "l":
        a, b = pl.to3(seg["a"]), pl.to3(seg["b"])
        if np.linalg.norm(a - b) < 1e-9:
            return []
        return [BRepBuilderAPI_MakeEdge(_p(a), _p(b)).Edge()]
    if t == "c":
        return [BRepBuilderAPI_MakeEdge(gp_Circ(pl.ax2(seg["c"]), float(seg["r"]))).Edge()]
    if t == "a":
        circ = gp_Circ(pl.ax2(seg["c"]), float(seg["r"]))
        a, b = pl.to3(seg["a"]), pl.to3(seg["b"])
        if not seg.get("ccw", True):
            a, b = b, a
        arc = GC_MakeArcOfCircle(circ, _p(a), _p(b), True).Value()
        return [BRepBuilderAPI_MakeEdge(arc).Edge()]
    raise FeatureError("srv_modeler.profilo_non_valido")


def _wire(pl, segs):
    mw = BRepBuilderAPI_MakeWire()
    for s in segs:
        for e in _seg_edges(pl, s):
            mw.Add(e)
    if not mw.IsDone():
        raise FeatureError("srv_modeler.profilo_aperto")
    return mw.Wire()


def profile_faces(pl, loops):
    """Contorni dell'interfaccia [{outer: [segmenti], holes: [[segmenti]...]}] -> facce piane con i fori."""
    faces = []
    for lp in loops:
        ow = _wire(pl, lp["outer"])
        mf = BRepBuilderAPI_MakeFace(gp_Pln(pl.ax3()), ow, True)
        for h in lp.get("holes") or []:
            hw = _wire(pl, h)
            mf.Add(TopoDS.Wire(hw.Reversed()))
        if not mf.IsDone():
            raise FeatureError("srv_modeler.profilo_non_valido")
        face = mf.Face()
        fx = ShapeFix_Face(face)
        fx.FixOrientation()
        fx.Perform()
        face = fx.Face()
        faces.append(face)
    if not faces:
        raise FeatureError("srv_modeler.nessun_profilo")
    return faces


# ------------------------------------------------------------------------------------------------- trasformazioni
def _trsf(tf):
    """{k: move|rotate|scale|mirror|matrix, ...} -> gp_Trsf (o gp_GTrsf per la scala non uniforme)."""
    k = tf.get("k")
    t = gp_Trsf()
    if k == "move":
        t.SetTranslation(_vec(tf["v"]))
    elif k == "rotate":
        t.SetRotation(gp_Ax1(_p(tf.get("o", [0, 0, 0])), _d(tf.get("d", [0, 0, 1]))), math.radians(float(tf["ang"])))
    elif k == "scale":
        f = tf.get("f")
        fx, fy, fz = (tf.get("fx", f), tf.get("fy", f), tf.get("fz", f))
        if f is None or not (fx == fy == fz):
            g = gp_GTrsf()
            c = np.array(tf.get("c", [0, 0, 0]), float)
            g.SetVectorialPart(gp_Mat(float(fx), 0, 0, 0, float(fy), 0, 0, 0, float(fz)))
            g.SetTranslationPart(gp_XYZ(*(c - c * np.array([fx, fy, fz], float)).tolist()))
            return g
        t.SetScale(_p(tf.get("c", [0, 0, 0])), float(f))
    elif k == "mirror":
        t.SetMirror(gp_Ax2(_p(tf.get("o", [0, 0, 0])), _d(tf["n"])))
    elif k == "matrix":
        m = tf["m"]  # 12 valori: righe della matrice 3x4
        t.SetValues(*[float(x) for x in m])
    else:
        raise FeatureError("srv_modeler.trasformazione_sconosciuta", k)
    return t


def _mat_of(t):
    if isinstance(t, gp_GTrsf):
        m = np.eye(4)
        for i in range(3):
            for j in range(4):
                m[i, j] = t.Value(i + 1, j + 1)
        return m
    m = np.eye(4)
    for i in range(3):
        for j in range(4):
            m[i, j] = t.Value(i + 1, j + 1)
    return m


def transform_body(body, t, fid):
    if body.mesh is not None:
        v, f = body.mesh
        m = _mat_of(t)
        nv = v @ m[:3, :3].T + m[:3, 3]
        if np.linalg.det(m[:3, :3]) < 0:
            f = f[:, [0, 2, 1]]
        return Body(mesh=(nv, f), src=fid)
    if isinstance(t, gp_GTrsf):
        s = BRepBuilderAPI_GTransform(body.shape, t, True).Shape()
    else:
        s = BRepBuilderAPI_Transform(body.shape, t, True).Shape()
    return Body(shape=s, src=fid)


# ------------------------------------------------------------------------------------------------- mesh -> B-rep
MESH_BREP_MAX = 20000  # triangoli: oltre resta una mesh (solo trasformazioni)


def mesh_to_brep(v, f):
    if len(f) > MESH_BREP_MAX:
        raise FeatureError("srv_modeler.mesh_troppo_grande", len(f), MESH_BREP_MAX)
    sew = BRepBuilderAPI_Sewing(1e-6 * max(1.0, float(np.abs(v).max())))
    for a, b, c in f:
        pa, pb, pc = v[a], v[b], v[c]
        if np.linalg.norm(np.cross(pb - pa, pc - pa)) < 1e-14:
            continue
        poly = BRepBuilderAPI_MakePolygon(_p(pa), _p(pb), _p(pc), True)
        mf = BRepBuilderAPI_MakeFace(poly.Wire(), True)
        if mf.IsDone():
            sew.Add(mf.Face())
    sew.Perform()
    sh = sew.SewedShape()
    shells = _shapes(sh, TopAbs_SHELL)
    solids = []
    for s in shells:
        try:
            ms = BRepBuilderAPI_MakeSolid(TopoDS.Shell(s))
            so = ms.Solid()
            fx = ShapeFix_Solid(so)
            fx.Perform()
            so = fx.Solid()
            if _volume(so) < 0:
                so = TopoDS.Solid(so.Reversed())
            solids.append(so)
        except Exception:  # noqa: BLE001
            solids.append(s)
    if not solids:
        raise FeatureError("srv_modeler.mesh_non_convertibile")
    return _clean(solids[0] if len(solids) == 1 else _compound(solids))


def as_solid(body):
    if body.mesh is None:
        return body.shape
    return mesh_to_brep(*body.mesh)


# ------------------------------------------------------------------------------------------------- lavorazioni
class Ctx:
    def __init__(self, sess):
        self.sess = sess
        self.planes = {}  # id schizzo -> Plane
        self.proj = {}  # id schizzo -> contorni della faccia proiettati (riferimento per l'aggancio)
        self.warn = []


def _plane_of_sketch(state, ctx, f):
    pd = f.get("plane") or {"std": "XY"}
    if pd.get("face"):
        body, _i, face = resolve(state, pd["face"], "f")
        info = _face_info(face)
        if info["t"] != "plane":
            raise FeatureError("srv_modeler.faccia_non_piana")
        o, x, n = plane_from_normal(info["n"], info["o"])
        pl = Plane(o, x, n)
        # contorno della faccia nel piano dello schizzo: riferimento per agganciarsi agli spigoli esistenti
        lin, _ = _mesh_defl(body.shape)
        lines = []
        for e in _shapes(face, TopAbs_EDGE):
            pts = _edge_points(TopoDS.Edge(e), lin)
            if len(pts) >= 2:
                rel = pts - pl.o
                lines.append(np.stack([rel @ pl.x, rel @ pl.y], 1).round(9).tolist())
        ctx.proj[f["id"]] = lines
    else:
        o, x, n = STD_PLANES.get(pd.get("std", "XY"), STD_PLANES["XY"])
        pl = Plane(o, x, n)
    off = float(pd.get("off") or 0)
    if off:
        pl = Plane(pl.o + pl.n * off, pl.x, pl.n)
    if pd.get("flip"):
        pl = Plane(pl.o, -pl.x, -pl.n)
    return pl


def _targets(state, f, tool, exclude=()):
    ids = [b for b in (f.get("targets") or []) if b in state]
    if ids:
        return ids
    bb = _bbox(tool)
    out = []
    for bid, body in state.items():
        if bid in exclude or body.mesh is not None:
            continue
        if _boxes_touch(bb, _bbox_any(body)) and _touching(tool, body.shape):
            out.append(bid)
    return out


def _apply_op(state, f, tool, fid):
    """Strumento (solido nuovo) applicato con l'operazione della lavorazione: nuovo corpo, unione, taglio, intersezione."""
    op = f.get("op", "new")
    st = OrderedDict(state)
    if op == "new":
        st[fid] = Body(shape=_clean(tool), src=fid)
        return st
    targets = _targets(state, f, tool)
    if not targets:
        if op == "join":
            st[fid] = Body(shape=_clean(tool), src=fid)
            return st
        raise FeatureError("srv_modeler.nessun_corpo_da_modificare")
    if op == "join":
        first = targets[0]
        others = [state[b].shape for b in targets[1:]]
        res = _clean(_bool("fuse", state[first].shape, [tool, *others]))
        st[first] = Body(shape=res, src=fid)
        for b in targets[1:]:
            del st[b]
        return st
    for b in targets:
        res = _bool("cut" if op == "cut" else "common", state[b].shape, tool)
        if _empty(res) or _count(res, TopAbs_SOLID) == 0 and _count(state[b].shape, TopAbs_SOLID) > 0:
            del st[b]
        else:
            st[b] = Body(shape=_clean(res), src=fid)
    return st


def f_sketch(state, f, ctx):
    ctx.planes[f["id"]] = _plane_of_sketch(state, ctx, f)
    return state


def _sk_plane(ctx, f):
    pl = ctx.planes.get(f.get("sketch"))
    if pl is None:
        raise FeatureError("srv_modeler.schizzo_mancante")
    return pl


def f_extrude(state, f, ctx):
    pl = _sk_plane(ctx, f)
    faces = profile_faces(pl, f.get("loops") or [])
    mode = f.get("mode", "one")
    d1 = float(f.get("d", 10))
    if f.get("through"):
        d1 = math.copysign(BIG, d1 if d1 else 1)
    d2 = float(f.get("d2", 0))
    if mode == "sym":
        start, length = -d1 / 2, d1
    elif mode == "two":
        start, length = -d2, d1 + d2
    else:
        start, length = 0.0, d1
    if abs(length) < 1e-9:
        raise FeatureError("srv_modeler.distanza_nulla")
    solids = []
    for face in faces:
        sh = face
        if abs(start) > 1e-12:
            t = gp_Trsf()
            t.SetTranslation(_vec(pl.n * start))
            sh = BRepBuilderAPI_Transform(face, t, True).Shape()
        solids.append(BRepPrimAPI_MakePrism(sh, _vec(pl.n * length), False, True).Shape())
    tool = _fuse_all(solids)
    return _apply_op(state, f, tool, f["id"])


def f_revolve(state, f, ctx):
    pl = _sk_plane(ctx, f)
    faces = profile_faces(pl, f.get("loops") or [])
    ax = f.get("axis")
    if not ax:
        raise FeatureError("srv_modeler.asse_mancante")
    a, b = pl.to3(ax[0]), pl.to3(ax[1])
    if np.linalg.norm(b - a) < 1e-9:
        raise FeatureError("srv_modeler.asse_mancante")
    axis = gp_Ax1(_p(a), _d(_n(b - a)))
    ang = float(f.get("ang", 360))
    solids = []
    for face in faces:
        if abs(abs(ang) - 360) < 1e-9:
            solids.append(BRepPrimAPI_MakeRevol(face, axis, 2 * math.pi, True).Shape())
        else:
            solids.append(BRepPrimAPI_MakeRevol(face, axis, math.radians(ang), True).Shape())
    tool = _fuse_all(solids)
    return _apply_op(state, f, tool, f["id"])


def f_primitive(state, f, ctx):
    k = f.get("shape", "box")
    p = np.array(f.get("p", [0, 0, 0]), float)
    ax = gp_Ax2(_p(p), _d(f.get("dir", [0, 0, 1])))
    if k == "box":
        dx, dy, dz = (float(f.get(c, 10)) for c in ("dx", "dy", "dz"))
        if min(dx, dy, dz) <= 0:
            raise FeatureError("srv_modeler.dimensioni_non_valide")
        s = BRepPrimAPI_MakeBox(_p(p), dx, dy, dz).Shape()
    elif k == "cyl":
        s = BRepPrimAPI_MakeCylinder(ax, float(f.get("r", 5)), float(f.get("h", 10))).Shape()
    elif k == "sphere":
        s = BRepPrimAPI_MakeSphere(_p(p), float(f.get("r", 5))).Shape()
    elif k == "cone":
        s = BRepPrimAPI_MakeCone(ax, float(f.get("r", 5)), float(f.get("r2", 0)), float(f.get("h", 10))).Shape()
    elif k == "torus":
        s = BRepPrimAPI_MakeTorus(ax, float(f.get("r", 10)), float(f.get("r2", 2))).Shape()
    else:
        raise FeatureError("srv_modeler.forma_sconosciuta", k)
    return _apply_op(state, f, s, f["id"])


def _cyl_tool(top, down, dia, depth):
    ax = gp_Ax2(_p(top), _d(down))
    return BRepPrimAPI_MakeCylinder(ax, dia / 2, depth).Shape()


def f_hole(state, f, ctx):
    body, _i, face = resolve(state, f["face"], "f")
    info = _face_info(face)
    if info["t"] != "plane":
        raise FeatureError("srv_modeler.faccia_non_piana")
    n = _n(info["n"])
    o = np.array(info["o"], float)
    dia = float(f.get("dia", 6))
    if dia <= 0:
        raise FeatureError("srv_modeler.dimensioni_non_valide")
    depth = float(f.get("depth", 10))
    through = f.get("through") or depth <= 0
    kind = f.get("kind", "simple")
    tools = []
    for p in f.get("pts") or [f.get("p")]:
        if p is None:
            continue
        p = np.array(p, float)
        p = p - n * float(np.dot(p - o, n))  # sul piano della faccia
        eps = 0.01
        top = p + n * eps
        h = (BIG if through else depth) + eps
        parts = [_cyl_tool(top, -n, dia, h)]
        if kind == "cbore":
            cbd, cbh = float(f.get("cbd", dia * 1.8)), float(f.get("cbh", dia * 0.6))
            parts.append(_cyl_tool(top, -n, cbd, cbh + eps))
        elif kind == "csink":
            csd, csa = float(f.get("csd", dia * 2)), float(f.get("csa", 90))
            hc = (csd - dia) / 2 / math.tan(math.radians(csa / 2))
            if hc > 0:
                parts.append(BRepPrimAPI_MakeCone(gp_Ax2(_p(p + n * eps), _d(-n)), csd / 2 + eps * math.tan(math.radians(csa / 2)), dia / 2, hc + eps).Shape())
        if not through and f.get("tip"):
            hc = dia / 2 / math.tan(math.radians(59))
            parts.append(BRepPrimAPI_MakeCone(gp_Ax2(_p(p - n * depth), _d(-n)), dia / 2, 0, hc).Shape())
        tools.append(_fuse_all(parts))
    if not tools:
        raise FeatureError("srv_modeler.nessun_punto")
    tool = tools[0] if len(tools) == 1 else _compound(tools)
    st = OrderedDict(state)
    bid = f["face"]["b"]
    res = _bool("cut", body.shape, tool)
    st[bid] = Body(shape=_clean(res), src=f["id"])
    return st


def _edges_of(state, refs):
    out = {}
    for r in refs or []:
        body, i, e = resolve(state, r, "e")
        out.setdefault(r["b"], {})[i] = e
    if not out:
        raise FeatureError("srv_modeler.nessuno_spigolo")
    return out


def f_fillet(state, f, ctx):
    st = OrderedDict(state)
    r = float(f.get("r", 2))
    if r <= 0:
        raise FeatureError("srv_modeler.dimensioni_non_valide")
    for bid, edges in _edges_of(state, f.get("edges")).items():
        mk = BRepFilletAPI_MakeFillet(state[bid].shape)
        for e in edges.values():
            mk.Add(r, e)
        try:
            mk.Build()
        except Exception:  # noqa: BLE001 - OpenCascade: spigoli non raccordabili con quella misura
            raise FeatureError("srv_modeler.raccordo_fallito") from None
        if not mk.IsDone():
            raise FeatureError("srv_modeler.raccordo_fallito")
        st[bid] = Body(shape=_clean(mk.Shape()), src=f["id"])
    return st


def f_chamfer(state, f, ctx):
    st = OrderedDict(state)
    d = float(f.get("d", 1))
    if d <= 0:
        raise FeatureError("srv_modeler.dimensioni_non_valide")
    for bid, edges in _edges_of(state, f.get("edges")).items():
        mk = BRepFilletAPI_MakeChamfer(state[bid].shape)
        for e in edges.values():
            mk.Add(d, e)
        try:
            mk.Build()
        except Exception:  # noqa: BLE001 - OpenCascade: spigoli non raccordabili con quella misura
            raise FeatureError("srv_modeler.smusso_fallito") from None
        if not mk.IsDone():
            raise FeatureError("srv_modeler.smusso_fallito")
        st[bid] = Body(shape=_clean(mk.Shape()), src=f["id"])
    return st


def f_shell(state, f, ctx):
    t = float(f.get("t", 1))
    if t <= 0:
        raise FeatureError("srv_modeler.dimensioni_non_valide")
    refs = f.get("faces") or []
    bid = f.get("body") or (refs[0]["b"] if refs else None)
    if bid not in state:
        raise FeatureError("srv_modeler.corpo_mancante", bid)
    faces = ShapeList()
    for r in refs:
        _b, _i, face = resolve(state, r, "f")
        faces.Append(face)
    mk = BRepOffsetAPI_MakeThickSolid()
    mk.MakeThickSolidByJoin(state[bid].shape, faces, t if f.get("out") else -t, 1e-3, BRepOffset_Skin, False, False, GeomAbs_Arc)
    mk.Build()
    if not mk.IsDone():
        raise FeatureError("srv_modeler.guscio_fallito")
    st = OrderedDict(state)
    st[bid] = Body(shape=_clean(mk.Shape()), src=f["id"])
    return st


def f_pushpull(state, f, ctx):
    body, _i, face = resolve(state, f["face"], "f")
    d = float(f.get("d", 0))
    if abs(d) < 1e-9:
        return state
    info = _face_info(face)
    bid = f["face"]["b"]
    st = OrderedDict(state)
    if info["t"] == "plane":
        n = _n(info["n"])
        prism = BRepPrimAPI_MakePrism(face, _vec(n * d), False, True).Shape()
        res = _bool("fuse" if d > 0 else "cut", body.shape, prism)
    else:
        mk = BRepOffset_MakeOffset()
        mk.Initialize(body.shape, 0.0, 1e-4, BRepOffset_Skin, True, False, GeomAbs_Intersection, False, False)
        # cilindri e coni: il verso positivo allontana dall'asse; per un foro (faccia verso l'asse) "tirare" lo stringe
        mk.SetOffsetOnFace(face, d)
        mk.MakeOffsetShape()
        if not mk.IsDone():
            raise FeatureError("srv_modeler.spingi_tira_fallito")
        res = mk.Shape()
    if _empty(res):
        raise FeatureError("srv_modeler.spingi_tira_fallito")
    st[bid] = Body(shape=_clean(res), src=f["id"])
    return st


def f_delface(state, f, ctx):
    by = {}
    for r in f.get("faces") or []:
        _b, _i, face = resolve(state, r, "f")
        by.setdefault(r["b"], []).append(face)
    if not by:
        raise FeatureError("srv_modeler.nessuna_faccia")
    st = OrderedDict(state)
    for bid, faces in by.items():
        d = BRepAlgoAPI_Defeaturing()
        d.SetShape(state[bid].shape)
        for fc in faces:
            d.AddFaceToRemove(fc)
        d.SetRunParallel(True)
        d.SetToFillHistory(False)
        d.Build()
        if not d.IsDone() or _empty(d.Shape()):
            raise FeatureError("srv_modeler.elimina_faccia_fallita")
        st[bid] = Body(shape=_clean(d.Shape()), src=f["id"])
    return st


def f_boolean(state, f, ctx):
    a = f.get("a")
    bs = [b for b in f.get("b") or [] if b in state and b != a]
    if a not in state or not bs:
        raise FeatureError("srv_modeler.scegli_corpi")
    op = {"join": "fuse", "fuse": "fuse", "cut": "cut", "common": "common"}[f.get("op", "fuse")]
    shp = as_solid(state[a])
    tools = [as_solid(state[b]) for b in bs]
    res = _bool(op, shp, tools)
    st = OrderedDict(state)
    if _empty(res):
        if op == "common":
            raise FeatureError("srv_modeler.intersezione_vuota")
        del st[a]
    else:
        st[a] = Body(shape=_clean(res), src=f["id"])
    if not f.get("keep"):
        for b in bs:
            st.pop(b, None)
    return st


def _sel_bodies(state, f):
    ids = [b for b in f.get("bodies") or [] if b in state]
    if not ids:
        raise FeatureError("srv_modeler.scegli_corpi")
    return ids


def f_transform(state, f, ctx):
    ids = _sel_bodies(state, f)
    t = _trsf(f.get("tf") or {})
    st = OrderedDict(state)
    for k, b in enumerate(ids):
        nb = transform_body(state[b], t, f["id"])
        if f.get("copy"):
            st[f"{f['id']}:{k}"] = nb
        else:
            st[b] = nb
    return st


def f_pattern(state, f, ctx):
    ids = _sel_bodies(state, f)
    kind = f.get("kind", "linear")
    trs = []
    if kind == "linear":
        d1 = _n(f.get("d", [1, 0, 0]))
        n1, s1 = max(1, int(f.get("n", 2))), float(f.get("s", 10))
        d2 = _n(f.get("d2", [0, 1, 0]))
        n2, s2 = max(1, int(f.get("n2", 1))), float(f.get("s2", 10))
        for i in range(n1):
            for j in range(n2):
                if i == 0 and j == 0:
                    continue
                t = gp_Trsf()
                t.SetTranslation(_vec(d1 * s1 * i + d2 * s2 * j))
                trs.append(t)
    else:
        n = max(1, int(f.get("n", 4)))
        ang = float(f.get("ang", 360))
        step = ang / n if abs(abs(ang) - 360) < 1e-9 else (ang / (n - 1) if n > 1 else 0)
        for i in range(1, n):
            t = gp_Trsf()
            t.SetRotation(gp_Ax1(_p(f.get("o", [0, 0, 0])), _d(f.get("ax", [0, 0, 1]))), math.radians(step * i))
            trs.append(t)
    if len(trs) > 2000:
        raise FeatureError("srv_modeler.troppe_copie", len(trs))
    st = OrderedDict(state)
    for b in ids:
        copies = [transform_body(state[b], t, f["id"]) for t in trs]
        if f.get("fuse") and state[b].mesh is None:
            st[b] = Body(shape=_fuse_all([state[b].shape] + [c.shape for c in copies]), src=f["id"])
        else:
            for k, c in enumerate(copies):
                st[f"{f['id']}:{b}:{k}"] = c
    return st


def f_delbody(state, f, ctx):
    st = OrderedDict(state)
    for b in _sel_bodies(state, f):
        del st[b]
    return st


def f_mate(state, f, ctx):
    """Accoppiamento tra corpi (assieme semplice): il corpo "move" si sposta perche' il suo riferimento a combaci con b.
    coinc = facce piane a contatto (normali opposte) con distanza "off"; conc = assi coincidenti (cilindri, cerchi);
    parallel = facce parallele (solo rotazione)."""
    mv = f.get("move")
    a, b = f.get("a"), f.get("b")
    if mv not in state or not a or not b:
        raise FeatureError("srv_modeler.scegli_corpi")

    def geom(ref):
        body = state.get(ref["b"])
        if body is None:
            raise FeatureError("srv_modeler.corpo_mancante", ref["b"])
        _bb, _i, shp = resolve(state, ref, ref.get("k", "f"))
        info = _face_info(shp) if ref.get("k", "f") == "f" else _edge_info(shp)
        if info.get("t") in ("plane",):
            return "plane", np.array(info["o"]), _n(info["n"])
        if info.get("t") in ("cyl", "cone"):
            return "axis", np.array(info["o"]), _n(info["n"])
        if info.get("t") == "circle":
            return "axis", np.array(info["o"]), _n(info["d"])
        if info.get("t") == "line":
            return "axis", np.array(info["a0"] if "a0" in info else ref["c"]), _n(info["d"])
        raise FeatureError("srv_modeler.accoppiamento_non_valido")

    ka, pa, na = geom(a)
    kb, pb, nb = geom(b)
    kind = f.get("kind", "coinc")
    if ka == kb == "plane":
        target = -nb if kind == "coinc" else nb
    else:
        # un asse non ha verso: la rotazione piu' piccola (il pezzo non si capovolge)
        target = nb if float(np.dot(na, nb)) >= 0 else -nb
    if f.get("flip"):
        target = -target
    rot = _rot_between(na, target)
    pa_r = rot @ pa
    t = np.zeros(3)
    off = float(f.get("off", 0))
    if ka == kb == "plane":
        # piano a su piano b (a distanza off lungo la normale di b)
        dist = float(np.dot(pb - pa_r, nb)) + off
        t = nb * dist
    elif ka == kb == "axis":
        dv = pb - pa_r
        t = dv - nb * float(np.dot(dv, nb)) + nb * off  # solo la parte perpendicolare all'asse (+ scostamento)
    else:
        raise FeatureError("srv_modeler.accoppiamento_non_valido")
    m = np.eye(4)
    m[:3, :3] = rot
    m[:3, 3] = t
    tr = gp_Trsf()
    tr.SetValues(*[float(x) for x in m[:3, :].reshape(-1)])
    st = OrderedDict(state)
    st[mv] = transform_body(state[mv], tr, f["id"])
    return st


def _rot_between(a, b):
    a, b = _n(a), _n(b)
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    if np.linalg.norm(v) < 1e-12:
        if c > 0:
            return np.eye(3)
        p = _n(np.cross(a, [1, 0, 0] if abs(a[0]) < 0.9 else [0, 1, 0]))
        return 2 * np.outer(p, p) - np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1 / (1 + c))


def f_import(state, f, ctx):
    st = OrderedDict(state)
    items = f.get("items") or []
    if not items:
        raise FeatureError("srv_modeler.nulla_da_importare")
    for k, it in enumerate(items):
        bid = f["id"] if len(items) == 1 else f"{f['id']}:{k}"
        st[bid] = ctx.sess.load_blob(it["blob"], f["id"])
    return st


def f_split(state, f, ctx):
    """Divide un corpo con un piano: due corpi."""
    ids = _sel_bodies(state, f)
    o, n = np.array(f.get("o", [0, 0, 0]), float), _n(f.get("n", [0, 0, 1]))
    pln = gp_Pln(_p(o), _d(n))
    half = BRepBuilderAPI_MakeFace(pln, -BIG, BIG, -BIG, BIG).Face()
    pos = BRepPrimAPI_MakePrism(half, _vec(n * BIG), False, True).Shape()
    st = OrderedDict()
    for bid, body in state.items():
        if bid not in ids:
            st[bid] = body
            continue
        shp = as_solid(body)
        a = _bool("common", shp, pos)
        b = _bool("cut", shp, pos)
        if not _empty(b):
            st[bid] = Body(shape=_clean(b), src=f["id"])
        if not _empty(a):
            st[f"{f['id']}:{bid}"] = Body(shape=_clean(a), src=f["id"])
    return st


FEATURES = {
    "sketch": f_sketch, "extrude": f_extrude, "revolve": f_revolve, "primitive": f_primitive, "hole": f_hole,
    "fillet": f_fillet, "chamfer": f_chamfer, "shell": f_shell, "pushpull": f_pushpull, "delface": f_delface,
    "boolean": f_boolean, "transform": f_transform, "pattern": f_pattern, "delbody": f_delbody, "mate": f_mate,
    "import": f_import, "split": f_split,
}


# ------------------------------------------------------------------------------------------------- sessioni
def _fhash(prev, feat):
    h = hashlib.sha1(prev.encode())
    h.update(json.dumps(feat, sort_keys=True, separators=(",", ":")).encode())
    return h.hexdigest()


class Session:
    MAX_STATES = 80

    def __init__(self, kernel):
        self.k = kernel
        self.cache = OrderedDict()  # impronta -> (stato, piani, proiezioni, esito)

    def load_blob(self, blob, fid):
        return self.k.load_blob(blob, fid)

    def evaluate(self, doc, upto=None):
        feats = [f for f in doc.get("features") or []]
        if upto is not None:
            feats = feats[:upto]
        state = OrderedDict()
        ctx = Ctx(self)
        h = "mbmod1"
        results = []
        for f in feats:
            h = _fhash(h, f)
            hit = self.cache.get(h)
            if hit is not None:
                self.cache.move_to_end(h)
                state, planes, proj, res = hit
                ctx.planes, ctx.proj = dict(planes), dict(proj)
                results.append(res)
                continue
            t0 = time.time()
            res = {"id": f.get("id"), "ok": True}
            if f.get("off"):
                res["skip"] = True
            else:
                fn = FEATURES.get(f.get("type"))
                try:
                    if fn is None:
                        raise FeatureError("srv_modeler.lavorazione_sconosciuta", f.get("type"))
                    state = fn(state, f, ctx)
                except FeatureError as e:
                    res = {"id": f.get("id"), "ok": False, "err": e.key, "args": e.args2}
                except Exception as e:  # noqa: BLE001 - un errore di OpenCascade non ferma il ricalcolo
                    traceback.print_exc(file=sys.stderr)
                    res = {"id": f.get("id"), "ok": False, "err": "srv_modeler.errore_motore", "args": [f"{e.__class__.__name__}: {e}"[:300]]}
            res["ms"] = round((time.time() - t0) * 1000, 1)
            results.append(res)
            self.cache[h] = (state, dict(ctx.planes), dict(ctx.proj), res)
            while len(self.cache) > self.MAX_STATES:
                self.cache.popitem(last=False)
        return state, ctx, results


class Kernel:
    def __init__(self, data_dir):
        self.data = data_dir
        self.blobdir = os.path.join(data_dir, "blob")
        os.makedirs(self.blobdir, exist_ok=True)
        self.sessions = {}
        self.blobs = {}  # id -> Body caricato (immutabile, condiviso)

    def sess(self, sid):
        s = self.sessions.get(sid)
        if s is None:
            s = self.sessions[sid] = Session(self)
        return s

    # ---- blob (forme importate): BREP binario o mesh, con nome = impronta del contenuto
    def blob_path(self, blob):
        for ext in (".bbrep", ".brep", ".mbms"):
            p = os.path.join(self.blobdir, blob + ext)
            if os.path.exists(p):
                return p
        raise FeatureError("srv_modeler.file_importato_mancante", blob)

    def load_blob(self, blob, fid):
        b = self.blobs.get(blob)
        if b is None:
            p = self.blob_path(blob)
            if p.endswith(".mbms"):
                b = Body(mesh=_read_mesh(p), src=fid)
            else:
                shape = TopoDS_Shape()
                if p.endswith(".bbrep"):
                    from OCP.BinTools import BinTools
                    BinTools.Read_s(shape, p)
                else:
                    BRepTools.Read_s(shape, p, BRep_Builder())
                b = Body(shape=shape, src=fid)
            self.blobs[blob] = b
        return b

    def save_shape_blob(self, shape):
        from OCP.BinTools import BinTools
        tmp = os.path.join(self.blobdir, f"tmp{os.getpid()}_{time.time_ns()}.bbrep")
        BinTools.Write_s(shape, tmp)
        h = hashlib.sha1(open(tmp, "rb").read()).hexdigest()[:20]
        dst = os.path.join(self.blobdir, h + ".bbrep")
        if os.path.exists(dst):
            os.remove(tmp)
        else:
            os.replace(tmp, dst)
        return h

    def save_mesh_blob(self, v, f):
        data = _mesh_bytes(v, f)
        h = hashlib.sha1(data).hexdigest()[:20]
        dst = os.path.join(self.blobdir, h + ".mbms")
        if not os.path.exists(dst):
            with open(dst, "wb") as fh:
                fh.write(data)
        return h

    # ---- richieste
    def op_ping(self, r):
        return {"pid": os.getpid()}

    def op_close(self, r):
        self.sessions.pop(r.get("sid"), None)
        return {}

    def op_regen(self, r):
        s = self.sess(r["sid"])
        t0 = time.time()
        state, ctx, results = s.evaluate(r["doc"], r.get("upto"))
        have = set(r.get("have") or [])
        bodies, blobs = [], []
        for bid, body in state.items():
            entry = {"id": bid, "uid": body.uid, "kind": body.kind, "src": body.src}
            if body.uid not in have:
                t = tessellate(body)
                entry.update({"faces": t["faces"], "edges": t["edges"], "bbox": t["bbox"], "props": t["props"], "buf": len(blobs)})
                blobs.append(t)
            bodies.append(entry)
        meta = {"features": results, "bodies": bodies, "planes": {k: v.js() for k, v in ctx.planes.items()},
                "proj": ctx.proj, "ms": round((time.time() - t0) * 1000, 1)}
        _write_bin(r["out"], meta, blobs)
        return {"out": r["out"]}

    def op_measure(self, r):
        s = self.sess(r["sid"])
        state, _ctx, _res = s.evaluate(r["doc"])
        shapes = []
        for ref in (r.get("a"), r.get("b")):
            if ref is None:
                shapes.append(None)
                continue
            if ref.get("k") == "p":
                from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
                shapes.append(BRepBuilderAPI_MakeVertex(_p(ref["c"])).Vertex())
            elif ref.get("k") == "b":
                body = state.get(ref["b"])
                if body is None:
                    raise FeatureError("srv_modeler.corpo_mancante", ref["b"])
                shapes.append(as_solid(body))
            else:
                shapes.append(resolve(state, ref, ref.get("k", "f"))[2])
        a, b = shapes
        out = {}
        if b is None:
            g = GProp_GProps()
            if a.ShapeType() == TopAbs_FACE:
                BRepGProp.SurfaceProperties_s(a, g)
                out["area"] = g.Mass()
            elif a.ShapeType() == TopAbs_EDGE:
                BRepGProp.LinearProperties_s(a, g)
                out["len"] = g.Mass()
            return out
        d = BRepExtrema_DistShapeShape(a, b)
        if d.IsDone() and d.NbSolution():
            p1, p2 = d.PointOnShape1(1), d.PointOnShape2(1)
            out.update({"d": d.Value(), "p1": [p1.X(), p1.Y(), p1.Z()], "p2": [p2.X(), p2.Y(), p2.Z()]})
        if a.ShapeType() == TopAbs_FACE and b.ShapeType() == TopAbs_FACE:
            ia, ib = _face_info(TopoDS.Face(a)), _face_info(TopoDS.Face(b))
            if ia.get("n") and ib.get("n"):
                c = float(np.clip(np.dot(_n(ia["n"]), _n(ib["n"])), -1, 1))
                out["ang"] = math.degrees(math.acos(c))
        if a.ShapeType() == TopAbs_EDGE and b.ShapeType() == TopAbs_EDGE:
            ia, ib = _edge_info(TopoDS.Edge(a)), _edge_info(TopoDS.Edge(b))
            if ia.get("d") and ib.get("d"):
                c = float(np.clip(abs(np.dot(_n(ia["d"]), _n(ib["d"]))), -1, 1))
                out["ang"] = math.degrees(math.acos(c))
        return out

    def op_import(self, r):
        """File CAD (STEP, IGES, BREP) -> corpi salvati come blob, con nome e colore dal file."""
        items = []
        for src in r["files"]:
            m = src.get("m")
            for shape, name, color in _read_cad(src["path"]):
                if m:
                    t = gp_Trsf()
                    t.SetValues(*[float(x) for x in m])
                    shape = BRepBuilderAPI_Transform(shape, t, True).Shape()
                items.append({"blob": self.save_shape_blob(shape), "name": name or src.get("name") or "", "color": color})
                if len(items) > 5000:
                    raise FeatureError("srv_modeler.troppi_corpi")
        return {"items": items}

    def op_import_mesh(self, r):
        """Triangoli dall'interfaccia (STL, OBJ, GLB, PLY... letti da three.js) -> B-rep se piccoli, altrimenti mesh."""
        items = []
        with open(r["path"], "rb") as fh:
            data = fh.read()
        for part in r["parts"]:
            v = np.frombuffer(data, np.float32, part["nv"] * 3, part["ov"]).astype(np.float64).reshape(-1, 3)
            f = np.frombuffer(data, np.uint32, part["nt"] * 3, part["ot"]).astype(np.int64).reshape(-1, 3)
            v, f = _weld(v, f)
            blob, kind = None, "mesh"
            if r.get("brep", True) and len(f) <= MESH_BREP_MAX:
                try:
                    blob = self.save_shape_blob(mesh_to_brep(v, f))
                    kind = "solid"
                except Exception:  # noqa: BLE001 - mesh non chiusa o non convertibile: resta mesh
                    blob = None
            if blob is None:
                blob = self.save_mesh_blob(v, f)
            items.append({"blob": blob, "name": part.get("name") or "", "color": part.get("color"), "kind": kind})
        return {"items": items}

    def op_to_brep(self, r):
        """Mesh grande -> B-rep su richiesta (per le booleane)."""
        b = self.load_blob(r["blob"], "")
        if b.mesh is None:
            return {"blob": r["blob"]}
        return {"blob": self.save_shape_blob(mesh_to_brep(*b.mesh))}

    def op_export(self, r):
        s = self.sess(r["sid"])
        state, _ctx, _res = s.evaluate(r["doc"])
        looks = r.get("looks") or {}
        ids = [b for b in (r.get("bodies") or list(state)) if b in state and not (looks.get(b) or {}).get("hidden")]
        if not ids:
            raise FeatureError("srv_modeler.nessun_corpo")
        fmt = r["fmt"]
        _export(state, ids, looks, fmt, r["path"], r.get("name") or "")
        return {"path": r["path"], "n": len(ids)}


# ------------------------------------------------------------------------------------------------- file
def _weld(v, f):
    """Vertici uguali uniti (i lettori di three.js li duplicano per faccia): serve alla cucitura in un solido."""
    if not len(v):
        return v, f
    scale = max(1.0, float(np.abs(v).max()))
    q = np.round(v / (scale * 1e-9)).astype(np.int64)
    _u, idx, inv = np.unique(q, axis=0, return_index=True, return_inverse=True)
    nv = v[idx]
    nf = inv.reshape(-1)[f]
    ok = (nf[:, 0] != nf[:, 1]) & (nf[:, 1] != nf[:, 2]) & (nf[:, 0] != nf[:, 2])
    return nv, nf[ok]


def _mesh_bytes(v, f):
    v = np.asarray(v, np.float64)
    f = np.asarray(f, np.uint32)
    return b"MBMS" + struct.pack("<II", len(v), len(f)) + v.tobytes() + f.tobytes()


def _read_mesh(p):
    with open(p, "rb") as fh:
        d = fh.read()
    nv, nf = struct.unpack_from("<II", d, 4)
    v = np.frombuffer(d, np.float64, nv * 3, 12).reshape(-1, 3).copy()
    f = np.frombuffer(d, np.uint32, nf * 3, 12 + nv * 24).astype(np.int64).reshape(-1, 3).copy()
    return v, f


def _write_bin(path, meta, blobs):
    """[u32 lunghezza JSON][JSON][dati]: per ogni corpo pos, nrm, idx, fr, ep, er, vp (allineati a 4 byte)."""
    parts, off = [], 0
    for t in blobs:
        offs = {}
        for k in ("pos", "nrm", "idx", "fr", "ep", "er", "vp"):
            a = np.ascontiguousarray(t[k]).tobytes()
            offs[k] = [off, len(a)]
            parts.append(a)
            off += len(a)
        t["_off"] = offs
    for b in meta["bodies"]:
        if "buf" in b:
            b["off"] = blobs[b.pop("buf")]["_off"]
    js = json.dumps(meta, separators=(",", ":"), default=float).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    tmp = path + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(struct.pack("<I", len(js)))
        fh.write(js)
        for a in parts:
            fh.write(a)
    os.replace(tmp, path)


def _read_cad(path):
    """(forma, nome, colore) per ogni solido del file, con la posizione dell'assieme applicata."""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".brep", ".brp"):
        shape = TopoDS_Shape()
        BRepTools.Read_s(shape, path, BRep_Builder())
        return _split_solids(shape, os.path.splitext(os.path.basename(path))[0], None)
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.OCP.collections import Sequence_TDF_Label as LabelSeq
    from OCP.Quantity import Quantity_Color
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDataStd import TDataStd_Name
    from OCP.TDF import TDF_Label
    from OCP.TDocStd import TDocStd_Document
    from OCP.XCAFDoc import XCAFDoc_ColorGen, XCAFDoc_ColorSurf, XCAFDoc_DocumentTool
    doc = TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
    if ext in (".igs", ".iges"):
        from OCP.IGESCAFControl import IGESCAFControl_Reader
        rd = IGESCAFControl_Reader()
    else:
        from OCP.STEPCAFControl import STEPCAFControl_Reader
        rd = STEPCAFControl_Reader()
        for m in ("SetLayerMode", "SetPropsMode", "SetGDTMode", "SetMatMode", "SetViewMode"):
            getattr(rd, m)(False)
    rd.SetColorMode(True)
    rd.SetNameMode(True)
    if rd.ReadFile(path) != IFSelect_RetDone:
        raise FeatureError("srv_modeler.file_non_leggibile", os.path.basename(path))
    if not rd.Transfer(doc):
        raise FeatureError("srv_modeler.file_non_leggibile", os.path.basename(path))
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())

    def name(lab):
        n = TDataStd_Name()
        if lab.FindAttribute(TDataStd_Name.GetID_s(), n):
            return n.Get().ToExtString()
        return ""

    def color(lab, shape=None):
        c = Quantity_Color()
        for k in (XCAFDoc_ColorSurf, XCAFDoc_ColorGen):
            if ct.GetColor_s(lab, k, c):
                return "#%02x%02x%02x" % tuple(int(round(max(0, min(1, v)) * 255)) for v in (c.Red(), c.Green(), c.Blue()))
        return None

    out = []

    def walk(lab, loc, nm, col, depth):
        if st.IsAssembly_s(lab):
            comps = LabelSeq()
            st.GetComponents_s(lab, comps, False)
            for j in range(1, comps.Length() + 1):
                c = comps.Value(j)
                ref = TDF_Label()
                if not st.GetReferredShape_s(c, ref):
                    continue
                cl = st.GetLocation_s(c)
                cn = name(c)
                if not cn or cn.startswith("=>["):
                    cn = name(ref)
                if depth < 30:
                    walk(ref, loc.Multiplied(cl), cn or nm, color(c) or color(ref) or col, depth + 1)
            return
        shape = st.GetShape_s(lab)
        if shape.IsNull():
            return
        shape = shape.Moved(loc)
        out.extend(_split_solids(shape, name(lab) or nm, color(lab) or col))

    free = LabelSeq()
    st.GetFreeShapes(free)
    base = os.path.splitext(os.path.basename(path))[0]
    for i in range(1, free.Length() + 1):
        lab = free.Value(i)
        walk(lab, TopLoc_Location(), name(lab) or base, color(lab), 0)
    return out


def _split_solids(shape, name, color):
    sol = _shapes(shape, TopAbs_SOLID)
    if len(sol) <= 1:
        return [(sol[0] if sol else shape, name, color)] if not _empty(shape) else []
    return [(s, f"{name} ({k + 1})", color) for k, s in enumerate(sol)]


def _xcaf(state, ids, looks, mesh=False):
    from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDataStd import TDataStd_Name
    from OCP.TDocStd import TDocStd_Document
    from OCP.XCAFDoc import XCAFDoc_ColorGen, XCAFDoc_DocumentTool
    doc = TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    for bid in ids:
        body = state[bid]
        shape = body.shape if body.mesh is None else _mesh_shape(*body.mesh)
        lab = st.AddShape(shape, False)
        lk = looks.get(bid) or {}
        TDataStd_Name.Set_s(lab, TCollection_ExtendedString(lk.get("name") or bid))
        col = lk.get("color")
        if col and len(col) == 7:
            r, g, b = (int(col[i:i + 2], 16) / 255 for i in (1, 3, 5))
            ct.SetColor(lab, Quantity_Color(r, g, b, Quantity_TOC_RGB), XCAFDoc_ColorGen)
    return doc


def _mesh_shape(v, f):
    """Mesh come faccia triangolata (solo per GLB/STL: nessuna superficie esatta)."""
    from OCP.Poly import Poly_Triangulation, Poly_Triangle
    tri = Poly_Triangulation(len(v), len(f), False)
    for i, p in enumerate(v):
        tri.SetNode(i + 1, gp_Pnt(*map(float, p)))
    for i, (a, b, c) in enumerate(f):
        tri.SetTriangle(i + 1, Poly_Triangle(int(a) + 1, int(b) + 1, int(c) + 1))
    from OCP.TopoDS import TopoDS_Face
    face = TopoDS_Face()
    BRep_Builder().MakeFace(face, tri)
    return face


def _export(state, ids, looks, fmt, path, name):
    fmt = fmt.lower()
    solids = [state[b] for b in ids]
    if fmt in ("step", "stp", "iges", "igs"):
        if any(b.mesh is not None for b in solids):
            # mesh grandi: nei formati CAD diventano solidi a facce piane (se possibile)
            for b in ids:
                if state[b].mesh is not None:
                    state = OrderedDict(state)
                    state[b] = Body(shape=mesh_to_brep(*state[b].mesh))
        doc = _xcaf(state, ids, looks)
        if fmt in ("step", "stp"):
            from OCP.Interface import Interface_Static
            from OCP.STEPCAFControl import STEPCAFControl_Writer
            from OCP.STEPControl import STEPControl_AsIs
            Interface_Static.SetCVal_s("write.step.unit", "MM")
            Interface_Static.SetCVal_s("write.step.schema", "AP214IS")
            w = STEPCAFControl_Writer()
            w.SetColorMode(True)
            w.SetNameMode(True)
            if not w.Transfer(doc, STEPControl_AsIs):
                raise FeatureError("srv_modeler.esportazione_fallita", fmt)
            if w.Write(path) != 1:
                raise FeatureError("srv_modeler.esportazione_fallita", fmt)
        else:
            from OCP.IGESCAFControl import IGESCAFControl_Writer
            from OCP.Interface import Interface_Static
            Interface_Static.SetIVal_s("write.iges.brep.mode", 1)
            w = IGESCAFControl_Writer()
            w.SetColorMode(True)
            w.SetNameMode(True)
            if not w.Transfer(doc) or not w.Write(path):
                raise FeatureError("srv_modeler.esportazione_fallita", fmt)
        return
    if fmt in ("brep", "brp"):
        comp = _compound([b.shape if b.mesh is None else _mesh_shape(*b.mesh) for b in solids])
        if not BRepTools.Write_s(comp, path):
            raise FeatureError("srv_modeler.esportazione_fallita", fmt)
        return
    # formati a triangoli: triangolazione piu' fine di quella della vista
    tris = []
    for bid in ids:
        b = state[bid]
        if b.mesh is not None:
            tris.append((bid, b.mesh[0], b.mesh[1]))
            continue
        lin, ang = _mesh_defl(b.shape)
        BRepMesh_IncrementalMesh(b.shape, lin / 2, False, ang / 1.5, True)
        b2 = Body(shape=b.shape)
        t = tessellate(b2)
        tris.append((bid, t["pos"].astype(np.float64), t["idx"].reshape(-1, 3).astype(np.int64)))
    if fmt == "stl":
        n = sum(len(f) for _b, _v, f in tris)
        with open(path, "wb") as fh:
            fh.write((name or "MB Desk").encode("ascii", "replace")[:80].ljust(80, b" "))
            fh.write(struct.pack("<I", n))
            for _b, v, f in tris:
                a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
                nn = np.cross(b - a, c - a)
                ln = np.linalg.norm(nn, axis=1)
                ln[ln == 0] = 1
                nn /= ln[:, None]
                rec = np.zeros(len(f), dtype=[("n", "<f4", 3), ("a", "<f4", 3), ("b", "<f4", 3), ("c", "<f4", 3), ("x", "<u2")])
                rec["n"], rec["a"], rec["b"], rec["c"] = nn, a, b, c
                fh.write(rec.tobytes())
        return
    if fmt == "obj":
        mtl = os.path.splitext(path)[0] + ".mtl"
        with open(path, "w", encoding="utf-8", newline="\n") as fh, open(mtl, "w", encoding="utf-8", newline="\n") as fm:
            fh.write(f"# MB Desk\nmtllib {os.path.basename(mtl)}\n")
            base = 1
            for k, (bid, v, f) in enumerate(tris):
                lk = looks.get(bid) or {}
                col = lk.get("color") or "#b8bcc0"
                r, g, b = (int(col[i:i + 2], 16) / 255 for i in (1, 3, 5))
                fm.write(f"newmtl m{k}\nKd {r:.4f} {g:.4f} {b:.4f}\n")
                fh.write(f"o {(lk.get('name') or bid).replace(chr(10), ' ')}\nusemtl m{k}\n")
                fh.write("".join(f"v {x:.6g} {y:.6g} {z:.6g}\n" for x, y, z in v))
                fh.write("".join(f"f {a + base} {b2 + base} {c + base}\n" for a, b2, c in f))
                base += len(v)
        return
    if fmt in ("glb", "gltf"):
        _write_glb(tris, looks, path, fmt == "gltf")
        return
    raise FeatureError("srv_modeler.formato_non_supportato", fmt)


def _write_glb(tris, looks, path, text=False):
    """glTF 2.0 (metri, Y in alto come vuole lo standard): un nodo e un materiale per corpo."""
    bins, views, accs, meshes, nodes, mats = [], [], [], [], [], []
    off = 0

    def add(arr, target):
        nonlocal off
        b = np.ascontiguousarray(arr).tobytes()
        b += b"\0" * ((4 - len(b) % 4) % 4)
        views.append({"buffer": 0, "byteOffset": off, "byteLength": len(np.ascontiguousarray(arr).tobytes()), "target": target})
        bins.append(b)
        off += len(b)
        return len(views) - 1

    for k, (bid, v, f) in enumerate(tris):
        if not len(f):
            continue
        p = (v * 0.001)[:, [0, 2, 1]] * np.array([1, 1, -1])  # mm Z in alto -> m Y in alto
        p = p.astype(np.float32)
        nrm = _normals(v, f)[:, [0, 2, 1]] * np.array([1, 1, -1])
        idx = f.astype(np.uint32).reshape(-1)
        vp = add(p, 34962)
        vn = add(nrm.astype(np.float32), 34962)
        vi = add(idx, 34963)
        accs.append({"bufferView": vp, "componentType": 5126, "count": len(p), "type": "VEC3", "min": p.min(0).tolist(), "max": p.max(0).tolist()})
        accs.append({"bufferView": vn, "componentType": 5126, "count": len(p), "type": "VEC3"})
        accs.append({"bufferView": vi, "componentType": 5125, "count": len(idx), "type": "SCALAR"})
        lk = looks.get(bid) or {}
        col = lk.get("color") or "#b8bcc0"
        rgb = [(int(col[i:i + 2], 16) / 255) ** 2.2 for i in (1, 3, 5)]
        mats.append({"pbrMetallicRoughness": {"baseColorFactor": rgb + [1.0], "metallicFactor": 0.15, "roughnessFactor": 0.55}, "doubleSided": True})
        meshes.append({"primitives": [{"attributes": {"POSITION": len(accs) - 3, "NORMAL": len(accs) - 2}, "indices": len(accs) - 1, "material": len(mats) - 1}]})
        nodes.append({"mesh": len(meshes) - 1, "name": lk.get("name") or bid})
    binary = b"".join(bins)
    gl = {"asset": {"version": "2.0", "generator": "MB Desk"}, "scene": 0, "scenes": [{"nodes": list(range(len(nodes)))}],
          "nodes": nodes, "meshes": meshes, "materials": mats, "accessors": accs, "bufferViews": views,
          "buffers": [{"byteLength": len(binary)}]}
    if text:
        binname = os.path.splitext(os.path.basename(path))[0] + ".bin"
        gl["buffers"][0]["uri"] = binname
        with open(os.path.join(os.path.dirname(path), binname), "wb") as fh:
            fh.write(binary)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(gl, fh)
        return
    js = json.dumps(gl, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(binary)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, total))
        fh.write(struct.pack("<II", len(js), 0x4E4F534A))
        fh.write(js)
        fh.write(struct.pack("<II", len(binary), 0x004E4942))
        fh.write(binary)


# ------------------------------------------------------------------------------------------------- ciclo
def _reply(obj):
    sys.stdout.write(TAG + json.dumps(obj, separators=(",", ":"), default=float) + "\n")
    sys.stdout.flush()


def serve(data_dir):
    k = Kernel(data_dir)
    _reply({"id": 0, "ok": True, "ready": True, "pid": os.getpid()})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except ValueError:
            continue
        rid = r.get("id")
        try:
            fn = getattr(k, "op_" + str(r.get("op")), None)
            if fn is None:
                raise FeatureError("srv_modeler.richiesta_sconosciuta", r.get("op"))
            res = fn(r)
            _reply({"id": rid, "ok": True, **res})
        except FeatureError as e:
            _reply({"id": rid, "ok": False, "err": e.key, "args": e.args2})
        except Exception as e:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            _reply({"id": rid, "ok": False, "err": "srv_modeler.errore_motore", "args": [f"{e.__class__.__name__}: {e}"[:300]]})


def cli(argv):
    from . import longpath
    longpath.install()
    i = argv.index("--modeler-kernel")
    data = argv[i + 1] if len(argv) > i + 1 else os.path.join(os.environ.get("TEMP", "."), "MBVisual", "modellatore")
    try:
        serve(data)
    finally:
        sys.stdout.flush()
        os._exit(0)  # niente distruttori di OpenCascade all'uscita


if __name__ == "__main__":
    cli(sys.argv)
