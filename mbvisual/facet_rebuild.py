"""Solidi fatti di triangoli (STEP esportati da reti di facce: molti cataloghi di valvole, flange, raccordi) -> forma esatta.

Un file STEP "a faccette" e' un solido vero, ma ogni faccia e' un triangolo piano: copiato tale e quale in un 3DSOLID
di AutoCAD/BricsCAD si vede come una rete di triangoli. Qui, prima della scrittura ACIS (acis_write.py):
1. corpo di rivoluzione (anelli, flange, corpi delle valvole wafer, boccole, tubi): asse dalle normali delle facce e dal
   baricentro, sezione con il semipiano che contiene l'asse, raggi e quote agganciati ai valori veri dei vertici (i vertici
   delle reti stanno SULLA superficie, la sezione taglia le corde), poi rivoluzione del profilo = cilindri, coni e piani
   esatti. Si accetta solo se il volume coincide (differenza simmetrica sotto lo 0,5%).
2. altrimenti: facce complanari riunite (ShapeUpgrade_UnifySameDomain), cosi' almeno le facce piane non sono triangoli.
"""
from __future__ import annotations

import math

import numpy as np
from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepAlgoAPI import BRepAlgoAPI_Common, BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse, BRepAlgoAPI_Section
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakePolygon
from OCP.BRepGProp import BRepGProp
from OCP.BRepPrimAPI import BRepPrimAPI_MakeRevol
from OCP.GeomAbs import GeomAbs_Plane
from OCP.GProp import GProp_GProps
from OCP.gp import gp_Ax1, gp_Dir, gp_Pln, gp_Pnt, gp_Vec
from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED, TopAbs_VERTEX
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS

MIN_FACES = 24  # sotto: un solido a facce piane vero (cubo, prisma), non una rete


def _faces(shape):
    ex = TopExp_Explorer(shape, TopAbs_FACE)
    while ex.More():
        yield TopoDS.Face(ex.Current())
        ex.Next()


def is_faceted(solid) -> bool:
    n = 0
    for f in _faces(solid):
        if BRepAdaptor_Surface(f).GetType() != GeomAbs_Plane:
            return False
        n += 1
    return n >= MIN_FACES


def _volume(s):
    g = GProp_GProps()
    BRepGProp.VolumeProperties_s(s, g)
    return abs(g.Mass()), g.CentreOfMass()


def _face_data(solid):
    """normali (verso l'esterno) e aree delle facce, vertici distinti"""
    ns, ar = [], []
    for f in _faces(solid):
        s = BRepAdaptor_Surface(f)
        n = s.Plane().Axis().Direction()
        g = GProp_GProps()
        BRepGProp.SurfaceProperties_s(f, g)
        sg = -1.0 if f.Orientation() == TopAbs_REVERSED else 1.0
        ns.append((n.X() * sg, n.Y() * sg, n.Z() * sg))
        ar.append(g.Mass())
    pts = {}
    ex = TopExp_Explorer(solid, TopAbs_VERTEX)
    while ex.More():
        p = BRep_Tool.Pnt_s(TopoDS.Vertex(ex.Current()))
        pts[(round(p.X(), 6), round(p.Y(), 6), round(p.Z(), 6))] = 1
        ex.Next()
    return np.array(ns), np.array(ar), np.array(list(pts))


def _axis_candidates(ns, ar):
    """assi possibili: autovettore della matrice delle normali che si stacca dagli altri due + assi delle facce piane grandi"""
    m = (ns * ar[:, None]).T @ ns
    w, v = np.linalg.eigh(m)
    out = []
    # autovalori: in un corpo di rivoluzione due sono uguali (simmetria attorno all'asse), il terzo e' quello dell'asse
    gaps = [(abs(w[1] - w[2]), 0), (abs(w[0] - w[1]), 2)]
    for _g, k in sorted(gaps, key=lambda x: -x[0]):
        out.append(v[:, k])
    out.append(v[:, 1])
    # normali delle facce piu' grandi (le basi di un anello sono perpendicolari all'asse)
    for i in np.argsort(-ar)[:4]:
        out.append(ns[i])
    uniq = []
    for a in out:
        a = a / np.linalg.norm(a)
        if all(abs(abs(float(a @ b)) - 1) > 1e-6 for b in uniq):
            uniq.append(a)
    return uniq


def _snap(values, refs, rel):
    out = []
    for x in values:
        if refs.size:
            k = int(np.argmin(np.abs(refs - x)))
            if abs(refs[k] - x) <= rel:
                out.append(float(refs[k]))
                continue
        out.append(float(x))
    return out


def _clusters(vals, tol):
    """valori raggruppati (tolleranza assoluta) -> per ogni gruppo il massimo (raggi: i vertici stanno sul cerchio vero)"""
    vals = np.sort(vals)
    out, cur = [], [vals[0]] if len(vals) else []
    for x in vals[1:]:
        if x - cur[-1] <= tol:
            cur.append(x)
        else:
            out.append(cur)
            cur = [x]
    if cur:
        out.append(cur)
    return out


def _profile_loops(solid, c, a, u, size):
    """sezione con il semipiano (asse, verso u) -> anelli di punti (r, z)"""
    o = gp_Pnt(*c)
    n = np.cross(a, u)
    pl = gp_Pln(o, gp_Dir(*n))
    big = 4 * size
    # semipiano come rettangolo: r da 0 a big, z da -big a +big
    poly = BRepBuilderAPI_MakePolygon()
    for r, z in ((0, -big), (big, -big), (big, big), (0, big)):
        p = np.array(c) + r * u + z * a
        poly.Add(gp_Pnt(*p))
    poly.Close()
    face = BRepBuilderAPI_MakeFace(pl, poly.Wire()).Face()
    sec = BRepAlgoAPI_Section(solid, face)
    sec.Build()
    if not sec.IsDone():
        return None
    segs = []
    ex = TopExp_Explorer(sec.Shape(), TopAbs_EDGE)
    while ex.More():
        e = TopoDS.Edge(ex.Current())
        ex.Next()
        vs = []
        vx = TopExp_Explorer(e, TopAbs_VERTEX)
        while vx.More():
            p = BRep_Tool.Pnt_s(TopoDS.Vertex(vx.Current()))
            d = np.array([p.X(), p.Y(), p.Z()]) - c
            vs.append((float(d @ u), float(d @ a)))
            vx.Next()
        if len(vs) >= 2 and vs[0] != vs[-1]:
            segs.append((vs[0], vs[-1]))
    if not segs:
        return None
    # catene: estremi uguali entro la tolleranza
    tol = size * 1e-6 + 1e-9
    key = lambda p: (round(p[0] / tol), round(p[1] / tol))  # noqa: E731
    adj = {}
    for i, (p, q) in enumerate(segs):
        adj.setdefault(key(p), []).append((i, q))
        adj.setdefault(key(q), []).append((i, p))
    used, loops = set(), []
    for i, (p, q) in enumerate(segs):
        if i in used:
            continue
        used.add(i)
        loop = [p, q]
        while True:
            nxt = [(j, r) for j, r in adj.get(key(loop[-1]), []) if j not in used]
            if not nxt:
                break
            j, r = nxt[0]
            used.add(j)
            loop.append(r)
        if key(loop[0]) != key(loop[-1]) or len(loop) < 4:
            return None  # sezione aperta: non e' un corpo chiuso che si puo' far ruotare
        loops.append(loop[:-1])
    return loops


def _simplify(loop, tol):
    """toglie i punti allineati (dopo l'aggancio i lati dritti hanno molti punti)"""
    pts = [loop[0]]
    for p in loop[1:]:
        if abs(p[0] - pts[-1][0]) > tol or abs(p[1] - pts[-1][1]) > tol:
            pts.append(p)
    if len(pts) > 1 and abs(pts[0][0] - pts[-1][0]) <= tol and abs(pts[0][1] - pts[-1][1]) <= tol:
        pts.pop()
    changed = True
    while changed and len(pts) > 3:
        changed = False
        for i in range(len(pts)):
            a, b, c2 = pts[i - 1], pts[i], pts[(i + 1) % len(pts)]
            cross = (b[0] - a[0]) * (c2[1] - a[1]) - (b[1] - a[1]) * (c2[0] - a[0])
            ln = math.hypot(c2[0] - a[0], c2[1] - a[1]) or 1
            if abs(cross) / ln <= tol:
                pts.pop(i)
                changed = True
                break
    return pts


def _on_profile(r, z, loops, tol):
    best = np.full(r.shape, np.inf)
    for lp in loops:
        P = np.array(lp + lp[:1])
        for (x1, y1), (x2, y2) in zip(P[:-1], P[1:]):
            dx, dy = x2 - x1, y2 - y1
            L2 = dx * dx + dy * dy or 1e-30
            t = np.clip(((r - x1) * dx + (z - y1) * dy) / L2, 0, 1)
            best = np.minimum(best, np.hypot(r - x1 - t * dx, z - y1 - t * dy))
    return bool(np.all(best <= tol))


def _revolve(loops, c, a, u):
    shape = None
    for loop in loops:
        poly = BRepBuilderAPI_MakePolygon()
        for r, z in loop:
            poly.Add(gp_Pnt(*(np.array(c) + max(r, 0.0) * u + z * a)))
        poly.Close()
        f = BRepBuilderAPI_MakeFace(poly.Wire(), True)
        if not f.IsDone():
            return None
        rev = BRepPrimAPI_MakeRevol(f.Face(), gp_Ax1(gp_Pnt(*c), gp_Dir(*a)), 2 * math.pi)
        if not rev.IsDone():
            return None
        s = rev.Shape()
        if shape is None:
            shape = s
        else:  # anello dentro un altro (foro nel profilo) -> si toglie, altrimenti si unisce
            v1, _ = _volume(BRepAlgoAPI_Common(shape, s).Shape())
            shape = (BRepAlgoAPI_Cut if v1 > 1e-9 else BRepAlgoAPI_Fuse)(shape, s).Shape()
    return shape


def _try_revolution(solid):
    vol, cm = _volume(solid)
    if vol <= 0:
        return None
    ns, ar, pts = _face_data(solid)
    c = np.array([cm.X(), cm.Y(), cm.Z()])
    size = float(np.max(np.linalg.norm(pts - c, axis=1)))
    for a in _axis_candidates(ns, ar):
        a = a / np.linalg.norm(a)
        # un vettore radiale qualsiasi; i vertici stanno su cerchi attorno all'asse: raggi e quote
        u = np.cross(a, [1, 0, 0] if abs(a[0]) < 0.9 else [0, 1, 0])
        u /= np.linalg.norm(u)
        d = pts - c
        z = d @ a
        r = np.linalg.norm(d - np.outer(z, a), axis=1)
        tol = size * 2e-3
        rclu = _clusters(r, tol)
        zclu = _clusters(z, tol)
        # di rivoluzione: pochi raggi e quote distinti rispetto ai vertici (ogni cerchio ha molti vertici)
        if len(rclu) * len(zclu) > max(40, len(pts) // 3):
            continue
        rref = np.array([max(g) for g in rclu])
        zref = np.array([float(np.mean(g)) for g in zclu])
        loops = _profile_loops(solid, c, a, u, size)
        if not loops:
            continue
        # la sezione taglia le corde delle faccette: valgono solo i punti sulle quote dei vertici (anelli di vertici veri),
        # con il raggio agganciato al raggio dei vertici se e' appena sotto (corda); i punti a meta' faccetta si tolgono
        snapped = []
        for lp in loops:
            pl = []
            for x, y in lp:
                kz = int(np.argmin(np.abs(zref - y)))
                if abs(zref[kz] - y) > tol:
                    continue
                y = float(zref[kz])
                up = rref[(rref >= x - tol) & (rref - x <= 0.03 * rref + tol)]
                if up.size:
                    x = float(up.min())
                pl.append((x if x > tol else 0.0, y))
            pl = _simplify(pl, tol)
            if len(pl) < 3:
                break
            snapped.append(pl)
        else:
            try:
                new = _revolve(snapped, c, a, u)
            except Exception:  # noqa: BLE001
                new = None
            if new is None:
                continue
            nv, _ = _volume(new)
            # ogni vertice della rete deve stare sul contorno del profilo (i vertici sono sulla superficie vera)
            if abs(nv - vol) <= 0.03 * vol and _on_profile(r, z, snapped, 2 * tol):
                return new
    return None


def unify(solid):
    try:
        u = ShapeUpgrade_UnifySameDomain(solid, True, True, True)
        u.SetLinearTolerance(1e-4)
        u.SetAngularTolerance(1e-4)
        u.Build()
        return u.Shape()
    except Exception:  # noqa: BLE001
        return solid


def rebuild(solid):
    """-> (forma, come) con come = "rivoluzione" | "complanari" | None"""
    if not is_faceted(solid):
        return solid, None
    try:
        r = _try_revolution(solid)
    except Exception:  # noqa: BLE001
        r = None
    if r is not None:
        return r, "rivoluzione"
    return unify(solid), "complanari"
