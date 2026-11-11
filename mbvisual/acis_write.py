"""Solidi OpenCascade -> veri solidi di AutoCAD (3DSOLID, dati ACIS SAT 7.0) in un DXF R2010.

Scritto da zero sulla struttura ACIS che MB Desk gia' legge (acis.py), con le classi di ezdxf (MIT) per i record comuni.
Superfici esatte: piano, cilindro, cono, sfera, toro; spigoli esatti: retta, cerchio, ellisse. Un solido con altre
superfici (B-spline, rivoluzione, offset...) o altri spigoli diventa un 3DSOLID a facce piane (stessa forma, triangoli
riuniti dove sono complanari): resta un solido, non un filo di ferro.

Corrispondenze OpenCascade -> ACIS:
- faccia: senso "reversed" se la normale della superficie ACIS e' opposta a quella della faccia orientata di OpenCascade;
  i lati (coedge) restano nell'ordine e nel verso del contorno di OpenCascade (materiale a sinistra guardando lungo la
  normale della faccia, la stessa regola di ACIS).
- spigoli di cucitura delle superfici periodiche (cilindro, sfera, toro) e spigoli degeneri (poli, vertici dei coni):
  in ACIS non esistono, si tolgono e i lati rimasti si ricollegano in anelli per vertice (un cilindro ha due anelli,
  una sfera intera nessuno).
- parametri: retta e cerchio/ellisse ACIS hanno la stessa parametrizzazione di OpenCascade (asse maggiore = XDirection),
  quindi gli estremi degli spigoli sono quelli di BRepAdaptor_Curve.
"""
from __future__ import annotations

import math
import os

from ezdxf.acis import api as acis_api
from ezdxf.acis import entities as E
from ezdxf.acis import sat as acis_sat
from ezdxf.math import Matrix44, Vec3

from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRepLProp import BRepLProp_SLProps
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRepTools import BRepTools, BRepTools_WireExplorer
from OCP.GeomAbs import (GeomAbs_Circle, GeomAbs_Cone, GeomAbs_Cylinder, GeomAbs_Ellipse, GeomAbs_Line, GeomAbs_Plane,
                         GeomAbs_Sphere, GeomAbs_Torus)
from OCP.TopAbs import TopAbs_VERTEX, TopAbs_EDGE, TopAbs_FACE, TopAbs_FORWARD, TopAbs_REVERSED, TopAbs_SHELL, TopAbs_SOLID, TopAbs_WIRE
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS
try:
    from OCP.TopTools import TopTools_IndexedMapOfShape
except ImportError:  # nome della mappa nelle versioni recenti di OCP
    from OCP.OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher as TopTools_IndexedMapOfShape

# ezdxf scrive i numeri con 6 cifre ("%g"): per la geometria esatta servono tutte le cifre
acis_sat.SatDataExporter.write_double = lambda self, v: self.data.append(repr(float(v)) if math.isfinite(v) else "0")

INF = math.inf


def _v(p) -> Vec3:
    return Vec3(p.X(), p.Y(), p.Z())


class Unsupported(Exception):
    pass


# ------------------------------------------------------------------ geometrie ACIS che ezdxf non ha
class Ellipse(E.Curve):
    type = "ellipse-curve"

    def __init__(self, c: Vec3, n: Vec3, maj: Vec3, ratio: float):
        self.c, self.n, self.maj, self.ratio = c, n, maj, ratio

    def write_data(self, ex):
        ex.write_loc_vec3(self.c)
        ex.write_dir_vec3(self.n)
        ex.write_dir_vec3(self.maj)
        ex.write_double(self.ratio)
        super().write_data(ex)

    def evaluate(self, t):
        mn = self.n.cross(self.maj) * self.ratio
        return self.c + self.maj * math.cos(t) + mn * math.sin(t)


class Cone(E.Surface):
    """Cilindro (sine 0) o cono: raggio |maj| nel centro, si allarga lungo n se sine/cosine > 0; cosine > 0 = normale
    verso l'esterno."""
    type = "cone-surface"

    def __init__(self, c: Vec3, n: Vec3, maj: Vec3, sine: float, cosine: float):
        self.c, self.n, self.maj, self.sine, self.cosine = c, n, maj, sine, cosine

    def write_common(self, ex):
        super().write_common(ex)
        ex.write_loc_vec3(self.c)
        ex.write_dir_vec3(self.n)
        ex.write_dir_vec3(self.maj)
        ex.write_double(1.0)
        ex.write_interval(INF)
        ex.write_interval(INF)
        ex.write_double(self.sine)
        ex.write_double(self.cosine)
        ex.write_double(self.maj.magnitude)
        ex.write_bool(False, "reversed", "forward")

    def normal(self, p: Vec3) -> Vec3:
        w = p - self.c
        rad = w - self.n * w.dot(self.n)
        if rad.magnitude < 1e-12:
            return Vec3()
        return rad.normalize() * self.cosine - self.n * self.sine

    def evaluate(self, u, v):
        return self.c


class Sphere(E.Surface):
    type = "sphere-surface"

    def __init__(self, c: Vec3, r: float, uo: Vec3, pole: Vec3, rev_v: bool):
        self.c, self.r, self.uo, self.pole, self.rev_v = c, r, uo, pole, rev_v

    def write_common(self, ex):
        super().write_common(ex)
        ex.write_loc_vec3(self.c)
        ex.write_double(self.r)
        ex.write_dir_vec3(self.uo)
        ex.write_dir_vec3(self.pole)
        ex.write_bool(self.rev_v, "reverse_v", "forward_v")

    def normal(self, p: Vec3) -> Vec3:
        w = p - self.c
        return w.normalize() if w.magnitude > 1e-12 else Vec3()

    def evaluate(self, u, v):
        return self.c


class Torus(E.Surface):
    type = "torus-surface"

    def __init__(self, c: Vec3, n: Vec3, R: float, r: float, uo: Vec3, rev_v: bool):
        self.c, self.n, self.R, self.r, self.uo, self.rev_v = c, n, R, r, uo, rev_v

    def write_common(self, ex):
        super().write_common(ex)
        ex.write_loc_vec3(self.c)
        ex.write_dir_vec3(self.n)
        ex.write_double(self.R)
        ex.write_double(self.r)
        ex.write_dir_vec3(self.uo)
        ex.write_bool(self.rev_v, "reverse_v", "forward_v")

    def normal(self, p: Vec3) -> Vec3:
        w = p - self.c
        q = w - self.n * w.dot(self.n)
        if q.magnitude < 1e-12:
            return Vec3()
        k = p - (self.c + q.normalize() * self.R)
        return k.normalize() if k.magnitude > 1e-12 else Vec3()

    def evaluate(self, u, v):
        return self.c


def _plane_normal(pl):
    return lambda p: pl.normal


# ------------------------------------------------------------------ conversione esatta
_ELEMENTARY = (GeomAbs_Plane, GeomAbs_Cylinder, GeomAbs_Cone, GeomAbs_Sphere, GeomAbs_Torus)


def _surface(face):
    fs = BRepAdaptor_Surface(face, True)
    s = fs
    if fs.GetType() not in _ELEMENTARY:
        # superfici B-spline, di rivoluzione o di estrusione che sono in realta' piani, cilindri, coni, sfere o tori
        # (frequenti negli STEP di SolidWorks e Solid Edge): si riconoscono entro la tolleranza della faccia
        from OCP.GeomAdaptor import GeomAdaptor_Surface
        from OCP.GeomConvert import GeomConvert_SurfToAnaSurf
        tol = max(BRep_Tool.Tolerance_s(face), 1e-6)
        try:
            r = GeomConvert_SurfToAnaSurf(BRep_Tool.Surface_s(face)).ConvertToAnalytical(tol)
        except Exception:  # noqa: BLE001
            r = None
        if r is None:
            raise Unsupported("superficie")
        s = GeomAdaptor_Surface(r)
    t = s.GetType()
    if t == GeomAbs_Plane:
        g = s.Plane()
        ax = g.Position()
        pl = E.Plane()
        pl.origin = _v(ax.Location())
        pl.normal = _v(ax.Direction())
        pl.u_dir = _v(ax.XDirection())
        pl.reverse_v = not ax.Direct()
        pl.update_v_dir()
        return pl, (lambda p, n=pl.normal: n), fs
    if t == GeomAbs_Cylinder:
        g = s.Cylinder()
        ax = g.Position()
        c = Cone(_v(ax.Location()), _v(ax.Direction()), _v(ax.XDirection()) * g.Radius(), 0.0, 1.0)
        return c, c.normal, fs
    if t == GeomAbs_Cone:
        g = s.Cone()
        ax = g.Position()
        a, R = g.SemiAngle(), g.RefRadius()
        loc, n = _v(ax.Location()), _v(ax.Direction())
        if R < 1e-9:  # raggio nullo nel centro: il centro si sposta dove il raggio vale 1 unita'
            h = 1.0 / math.tan(abs(a))
            loc = loc + n * (h if a > 0 else -h)
            R = 1.0
        c = Cone(loc, n, _v(ax.XDirection()) * R, math.sin(a), math.cos(a))
        return c, c.normal, fs
    if t == GeomAbs_Sphere:
        g = s.Sphere()
        ax = g.Position()
        sp = Sphere(_v(ax.Location()), g.Radius(), _v(ax.XDirection()), _v(ax.Direction()), not ax.Direct())
        return sp, sp.normal, fs
    if t == GeomAbs_Torus:
        g = s.Torus()
        ax = g.Position()
        tr = Torus(_v(ax.Location()), _v(ax.Direction()), g.MajorRadius(), g.MinorRadius(), _v(ax.XDirection()), not ax.Direct())
        return tr, tr.normal, fs
    raise Unsupported("superficie")


def _curve(edge):
    """-> (curva ACIS, parametro iniziale, finale) per lo spigolo con orientamento FORWARD."""
    c = BRepAdaptor_Curve(edge)
    t = c.GetType()
    a, b = c.FirstParameter(), c.LastParameter()
    if t == GeomAbs_Line:
        g = c.Line()
        sc = E.StraightCurve()
        sc.origin = _v(g.Location())
        sc.direction = _v(g.Direction())
        return sc, a, b
    if t == GeomAbs_Circle:
        g = c.Circle()
        ax = g.Position()
        return Ellipse(_v(ax.Location()), _v(ax.Direction()), _v(ax.XDirection()) * g.Radius(), 1.0), a, b
    if t == GeomAbs_Ellipse:
        g = c.Ellipse()
        ax = g.Position()
        return Ellipse(_v(ax.Location()), _v(ax.Direction()), _v(ax.XDirection()) * g.MajorRadius(),
                       g.MinorRadius() / g.MajorRadius()), a, b
    return _ana_curve(edge, c, a, b)


def _ana_curve(edge, c, a, b):
    """Spigolo B-spline (o altro) che e' una retta, un cerchio o un'ellisse entro la sua tolleranza: si sostituisce con la
    curva esatta; i parametri si ricalcolano dai punti dello spigolo (stesso verso)."""
    from OCP.ElCLib import ElCLib
    from OCP.GeomConvert import GeomConvert_CurveToAnaCurve
    tol = max(BRep_Tool.Tolerance_s(edge), 1e-6)
    try:
        r = GeomConvert_CurveToAnaCurve.ComputeCurve_s(c.Curve().Curve(), tol, a, b, 0.0, 0.0, 0.0)
    except Exception:  # noqa: BLE001
        r = None
    name = r.DynamicType().Name() if r is not None else ""
    trsf = c.Trsf()
    p0, p1, pm = c.Value(a), c.Value(b), c.Value((a + b) / 2)
    if name == "Geom_Line":
        g = r.Lin().Transformed(trsf)
        sc = E.StraightCurve()
        sc.origin = _v(g.Location())
        sc.direction = _v(g.Direction())
        t0, t1 = ElCLib.Parameter_s(g, p0), ElCLib.Parameter_s(g, p1)
        if t1 < t0:
            sc.direction = -sc.direction
            t0, t1 = -t0, -t1
        return sc, t0, t1
    if name in ("Geom_Circle", "Geom_Ellipse"):
        g = (r.Circ() if name == "Geom_Circle" else r.Elips()).Transformed(trsf)
        ax = g.Position()
        n, xd = _v(ax.Direction()), _v(ax.XDirection())
        maj, ratio = (g.Radius(), 1.0) if name == "Geom_Circle" else (g.MajorRadius(), g.MinorRadius() / g.MajorRadius())
        closed = p0.Distance(p1) <= tol * 4
        for flip in (False, True):
            el = Ellipse(_v(ax.Location()), -n if flip else n, xd * maj, ratio)
            par = lambda p: _ell_param(el, _v(p))  # noqa: E731
            t0 = par(p0)
            if closed:
                tm = (par(pm) - t0) % (2 * math.pi)
                if abs(tm - math.pi) < 0.5 * math.pi:
                    return el, t0, t0 + 2 * math.pi
                continue
            span = (par(p1) - t0) % (2 * math.pi)
            if (par(pm) - t0) % (2 * math.pi) < span:
                return el, t0, t0 + span
    raise Unsupported("curva")


def _ell_param(el, p: Vec3) -> float:
    w = p - el.c
    y = el.n.cross(el.maj)
    return math.atan2(w.dot(y) / (y.magnitude ** 2 * el.ratio), w.dot(el.maj) / el.maj.magnitude ** 2) % (2 * math.pi)


def _face_normal_sample(face, s):
    """Punto e normale della faccia ORIENTATA (come la vede il solido) in un punto interno ai parametri."""
    u0, u1, v0, v1 = BRepTools.UVBounds_s(face)
    for fu, fv in ((0.5, 0.5), (0.37, 0.61), (0.21, 0.29), (0.73, 0.83)):
        u, v = u0 + (u1 - u0) * fu, v0 + (v1 - v0) * fv
        pr = BRepLProp_SLProps(s, u, v, 1, 1e-9)
        if pr.IsNormalDefined():
            n = _v(pr.Normal())
            if face.Orientation() == TopAbs_REVERSED:
                n = -n
            return _v(pr.Value()), n
    raise Unsupported("normale")


def solid_body(solid) -> E.Body:
    """Un solido OpenCascade -> corpo ACIS esatto (Unsupported se ha superfici o spigoli non esatti)."""
    body = E.Body()
    lump = E.Lump()
    body.append_lump(lump)
    vmap, emap = TopTools_IndexedMapOfShape(), TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(solid, TopAbs_VERTEX, vmap)
    TopExp.MapShapes_s(solid, TopAbs_EDGE, emap)
    verts: dict = {}
    edges: dict = {}  # indice nella mappa -> (E.Edge, [coedge...])

    def vertex(vx):
        k = vmap.FindIndex(vx)
        if k not in verts:
            av = E.Vertex()
            pt = E.Point()
            pt.location = _v(BRep_Tool.Pnt_s(vx))
            av.point = pt
            verts[k] = av
        return verts[k]

    def edge_of(ed):
        k = emap.FindIndex(ed)
        if k in edges:
            return edges[k]
        fwd = TopoDS.Edge(ed.Oriented(TopAbs_FORWARD))
        crv, a, b = _curve(fwd)
        ae = E.Edge()
        ae.curve = crv
        ae.start_vertex, ae.end_vertex = vertex(TopExp.FirstVertex_s(fwd)), vertex(TopExp.LastVertex_s(fwd))
        ae.start_param, ae.end_param = a, b
        ae.sense = False
        for av in (ae.start_vertex, ae.end_vertex):
            if av.edge.is_none:
                av.edge = ae
        edges[k] = (ae, [])
        return edges[k]

    nfaces = 0
    sx = TopExp_Explorer(solid, TopAbs_SHELL)
    while sx.More():
        shell_s = sx.Current()
        sx.Next()
        shell = E.Shell()
        lump.append_shell(shell)
        fx = TopExp_Explorer(shell_s, TopAbs_FACE)
        while fx.More():
            face = TopoDS.Face(fx.Current())
            fx.Next()
            surf, nrm, s = _surface(face)
            p, n_occ = _face_normal_sample(face, s)
            n_acis = nrm(p)
            if n_acis.magnitude < 1e-12:
                raise Unsupported("normale")
            af = E.Face()
            af.surface = surf
            af.sense = n_acis.dot(n_occ) < 0
            shell.append_face(af)
            nfaces += 1
            wx = TopExp_Explorer(face, TopAbs_WIRE)
            while wx.More():
                wire = TopoDS.Wire(wx.Current())
                wx.Next()
                co_list = []  # (coedge, vertice d'inizio, vertice di fine)
                we = BRepTools_WireExplorer(wire, face)
                while we.More():
                    ed = we.Current()
                    we.Next()
                    if BRep_Tool.Degenerated_s(ed) or BRep_Tool.IsClosed_s(ed, face):
                        continue  # poli, vertici dei coni, cuciture delle superfici periodiche
                    ae, cos = edge_of(ed)
                    co = E.Coedge()
                    co.edge = ae
                    co.sense = ed.Orientation() == TopAbs_REVERSED
                    cos.append(co)
                    s0, s1 = (ae.end_vertex, ae.start_vertex) if co.sense else (ae.start_vertex, ae.end_vertex)
                    co_list.append((co, s0, s1))
                # anelli: si ricollegano i lati per vertice (togliendo le cuciture un contorno puo' dividersi in due)
                left = co_list[:]
                while left:
                    chain = [left.pop(0)]
                    while chain[-1][2] is not chain[0][1]:
                        nxt = next((k for k, c in enumerate(left) if c[1] is chain[-1][2]), None)
                        if nxt is None:
                            raise Unsupported("anello aperto")
                        chain.append(left.pop(nxt))
                    loop = E.Loop()
                    af.append_loop(loop)
                    loop.set_coedges([c[0] for c in chain], close=True)
    if not nfaces:
        raise Unsupported("vuoto")
    for ae, cos in edges.values():
        if not cos:
            continue
        ae.coedge = cos[0]
        for k in range(1, len(cos)):
            cos[0].add_partner_coedge(cos[k])
    return body


# ------------------------------------------------------------------ ripiego a facce piane
def _triangles(shape, defl=None):
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    if defl is None:
        bb = Bnd_Box()
        BRepBndLib.Add_s(shape, bb)
        a, b = bb.CornerMin(), bb.CornerMax()
        defl = max(1e-3, 0.002 * a.Distance(b))
    BRepMesh_IncrementalMesh(shape, defl, False, 0.35, True)
    verts, faces = [], []
    fx = TopExp_Explorer(shape, TopAbs_FACE)
    while fx.More():
        face = TopoDS.Face(fx.Current())
        fx.Next()
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face, loc)
        if tri is None:
            continue
        tr = loc.Transformation()
        base = len(verts)
        for i in range(1, tri.NbNodes() + 1):
            verts.append(_v(tri.Node(i).Transformed(tr)))
        rev = face.Orientation() == TopAbs_REVERSED
        for i in range(1, tri.NbTriangles() + 1):
            a, b, c = tri.Triangle(i).Get()
            faces.append((base + a - 1, base + c - 1, base + b - 1) if rev else (base + a - 1, base + b - 1, base + c - 1))
    return verts, faces


def mesh_body(verts, faces) -> E.Body:
    from ezdxf.render import MeshBuilder
    m = MeshBuilder()
    m.vertices = [Vec3(float(v[0]), float(v[1]), float(v[2])) for v in verts]
    m.faces = [tuple(int(i) for i in f) for f in faces]
    m = m.optimize_vertices(6)
    try:
        mm = m.merge_coplanar_faces()
        if mm.diagnose().is_closed or not m.diagnose().is_closed:
            m = mm
    except Exception:  # noqa: BLE001 - si tengono i triangoli
        pass
    return acis_api.body_from_mesh(m)


def shape_bodies(shape):
    """-> [(corpo ACIS, esatto)] uno per solido; forme senza solidi (gusci, facce) a facce piane."""
    solids = []
    ex = TopExp_Explorer(shape, TopAbs_SOLID)
    while ex.More():
        solids.append(ex.Current())
        ex.Next()
    out = []
    for so in solids:
        try:
            out.append((solid_body(so), True))
            continue
        except (Unsupported, ValueError, ZeroDivisionError, AttributeError, AssertionError, TypeError, RuntimeError):
            pass
        v, f = _triangles(so)
        if f:
            out.append((mesh_body(v, f), False))
    if not solids:
        v, f = _triangles(shape)
        if f:
            out.append((mesh_body(v, f), False))
    return out


# ------------------------------------------------------------------ DXF
_BAD = '<>/\\":;?*|=`,'


def layer_name(name: str) -> str:
    n = "".join("_" if ch in _BAD or ord(ch) < 32 else ch for ch in (name or "").strip())
    return (n or "0")[:250]


def _hex(col):
    if col and len(col) == 7 and col[0] == "#":
        try:
            return tuple(int(col[i:i + 2], 16) for i in (1, 3, 5))
        except ValueError:
            return None
    return None


def write_dxf(path: str, items, update=None) -> dict:
    """items = [(forma OpenCascade oppure (vertici, triangoli), nome, colore "#rrggbb")] -> DXF R2010 in millimetri,
    un 3DSOLID per solido, un layer per nome (per colore oltre 500 nomi)."""
    import ezdxf
    from ezdxf import colors
    doc = ezdxf.new("R2010", setup=False)
    doc.header["$INSUNITS"] = 4
    doc.header["$MEASUREMENT"] = 1
    msp = doc.modelspace()
    names = {layer_name(n) for _s, n, _c in items}
    by_color = len(names) > 500
    exact = faceted = 0
    tot = max(1, len(items))
    for k, (shape, name, col) in enumerate(items):
        rgb = _hex(col)
        lay = ("C-%02X%02X%02X" % rgb if rgb else "0") if by_color else layer_name(name)
        if lay not in doc.layers:
            l = doc.layers.add(lay)
            if rgb:
                l.rgb = rgb
        if isinstance(shape, tuple):
            bodies = [(mesh_body(*shape), False)]
        else:
            bodies = shape_bodies(shape)
        for body, ok in bodies:
            e = msp.add_3dsolid(dxfattribs={"layer": lay})
            if rgb:
                e.rgb = rgb
            acis_api.export_dxf(e, [body])
            if ok:
                exact += 1
            else:
                faceted += 1
        if update and k % 20 == 0:
            update(0.2 + 0.75 * k / tot)
    if not exact + faceted:
        raise ValueError("vuoto")
    tmp = path + ".mbv-tmp.dxf"
    doc.saveas(tmp)
    os.replace(tmp, path)
    return {"esatti": exact, "a_facce": faceted}


def dxf_bodies(path: str) -> list:
    """Per i collaudi: testi SAT dei 3DSOLID di un DXF."""
    import ezdxf
    return ["\n".join(e.sat) for e in ezdxf.readfile(path).modelspace().query("3DSOLID")]


__all__ = ["solid_body", "mesh_body", "shape_bodies", "write_dxf", "dxf_bodies", "Unsupported", "Matrix44"]
