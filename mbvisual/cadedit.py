"""Salvataggio dei disegni CAD modificati in MB Visual (ezdxf).

- File DXF: si riapre l'originale e si applicano solo le modifiche (per handle): tutto il resto resta identico.
- File DWG: il disegno si ricostruisce in DXF dalle entita' lette (layer, tipi linea, blocchi, entita', quote).
- Le quote nuove diventano vere entita' DIMENSION (con il loro blocco grafico disegnato da ezdxf), quindi restano
  quote modificabili in AutoCAD. Le quote dei DWG si ricostruiscono come DIMENSION che usano il blocco originale.
- Uscita: DXF, DWG (con ODA File Converter, se installato), PDF / SVG / PNG vettoriali.
Le entita' arrivano dall'interfaccia nel formato del lettore (angoli in radianti).
"""
import math
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from .paths import TEMP_DIR

DEG = 180 / math.pi
# entita' i cui dati geometrici si riscrivono direttamente; le altre (quote, tratteggi, spline...) si trasformano
# con la matrice cumulata delle modifiche (_xf)
DIRECT = {"LINE", "CIRCLE", "ARC", "ELLIPSE", "LWPOLYLINE", "TEXT", "MTEXT", "POINT", "INSERT", "ATTRIB", "SOLID", "TRACE", "3DFACE"}
LINEWEIGHTS = (0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211)
DIMSTYLE = "MBVISUAL"


def _xy(p, z=False):
    if not p:
        return (0.0, 0.0, 0.0) if z else (0.0, 0.0)
    return (float(p.get("x", 0)), float(p.get("y", 0)), float(p.get("z", 0) or 0)) if z else (float(p.get("x", 0)), float(p.get("y", 0)))


def _m44(xf):
    from ezdxf.math import Matrix44
    a, b, c, d, e, f = (float(v) for v in xf)
    return Matrix44([a, b, 0, 0, c, d, 0, 0, 0, 0, 1, 0, e, f, 0, 1])


def _is_identity(xf):
    return not xf or all(abs(float(v) - w) < 1e-12 for v, w in zip(xf, (1, 0, 0, 1, 0, 0)))


class Ctx:
    """Stato del salvataggio: documento e tipi linea disponibili dall'interfaccia."""

    def __init__(self, doc, ltypes=None):
        self.doc = doc
        self.ltypes = {str(t.get("name", "")).upper(): t for t in (ltypes or []) if t.get("name")}

    def linetype(self, name):
        """Nome del tipo linea da usare (aggiunto al documento se manca); None = DaLayer."""
        if not name or name.upper() in ("BYLAYER", ""):
            return "BYLAYER"
        if name.upper() == "BYBLOCK":
            return "BYBLOCK"
        doc = self.doc
        if name in doc.linetypes:
            return name
        t = self.ltypes.get(name.upper())
        try:
            if t and t.get("pattern"):
                pat = [float(v) for v in t["pattern"]]
                doc.linetypes.add(name, pattern=[sum(abs(v) for v in pat)] + pat, description=t.get("description") or name)
                return name
            from ezdxf.tools import standards
            for n, desc, pat in standards.linetypes():
                if n.upper() == name.upper():
                    doc.linetypes.add(name, pattern=pat, description=desc)
                    return name
        except Exception:  # noqa: BLE001
            pass
        return "CONTINUOUS" if name.upper() == "CONTINUOUS" else "BYLAYER"


def _attribs(e, cx=None):
    a = {"layer": e.get("layer") or "0"}
    if isinstance(e.get("color"), (int, float)) and e.get("colorIndex") in (None,):
        a["true_color"] = int(e["color"])
    else:
        ci = e.get("colorIndex")
        a["color"] = 256 if ci is None else int(ci)
    if cx is not None and e.get("lineType"):
        a["linetype"] = cx.linetype(str(e["lineType"]))
    lw = e.get("lineweight")
    if isinstance(lw, (int, float)) and (int(lw) in (-3, -2, -1) or int(lw) in LINEWEIGHTS):
        a["lineweight"] = int(lw)
    lts = e.get("lineTypeScale")
    if isinstance(lts, (int, float)) and lts > 0 and abs(lts - 1) > 1e-12:
        a["ltscale"] = float(lts)
    return a


def _safe_block(name):
    name = name or "BLOCCO"
    if name.startswith("*") and re.fullmatch(r"\*[A-Za-z]\d+", name):
        return name  # blocchi anonimi (*D quote, *U, *X, *T): il nome resta quello originale
    return re.sub(r'[<>/\\":;?*|=`]', "_", name)


# ---------------------------------------------------------------- quote
def _dimstyle(doc):
    if DIMSTYLE not in doc.dimstyles:
        ds = doc.dimstyles.new(DIMSTYLE)
        for k, v in {"dimtad": 1, "dimtih": 0, "dimtoh": 0, "dimzin": 8, "dimazin": 2, "dimdsep": 44, "dimlunit": 2, "dimtxsty": "Standard",
                     "dimtxt": 2.5, "dimasz": 2.5, "dimexo": 0.625, "dimexe": 1.25, "dimgap": 0.625, "dimdec": 2, "dimadec": 0}.items():
            try:
                ds.dxf.set(k, v)
            except Exception:  # noqa: BLE001
                pass
    return DIMSTYLE


def _dim_override(st):
    from ezdxf import ARROWS
    g = lambda k, d: float(st.get(k)) if isinstance(st.get(k), (int, float)) else d  # noqa: E731
    ov = {"dimtxt": g("txt", 2.5), "dimasz": g("asz", 2.5), "dimscale": g("scale", 1.0) or 1.0, "dimdec": int(g("dec", 2)), "dimadec": int(g("adec", 0)),
          "dimexo": g("exo", 0.625), "dimexe": g("exe", 1.25), "dimgap": g("gap", 0.625), "dimtad": 1, "dimtih": 0, "dimtoh": 0, "dimzin": 8,
          "dimdsep": ord(st.get("sep") or ",")}
    if st.get("tick"):
        ov["dimblk"] = ARROWS.architectural_tick
    return ov


def _new_dimension(layout, e, doc, cx):
    """Quota creata nell'editor (dimKind) -> entita' DIMENSION con blocco grafico disegnato da ezdxf."""
    kind = e.get("dimKind")
    a = _attribs(e, cx)
    ds = _dimstyle(doc)
    ov = _dim_override(e.get("style") or {})
    text = e.get("text") or "<>"
    P = lambda k: _xy(e.get(k))  # noqa: E731
    if kind == "linear":
        dim = layout.add_linear_dim(base=P("loc"), p1=P("p1"), p2=P("p2"), angle=float(e.get("angle") or 0) * DEG, text=text, dimstyle=ds, override=ov, dxfattribs=a)
    elif kind == "aligned":
        (x1, y1), (x2, y2), (lx, ly) = P("p1"), P("p2"), P("loc")
        L = math.hypot(x2 - x1, y2 - y1) or 1.0
        dist = (lx - x1) * (-(y2 - y1) / L) + (ly - y1) * ((x2 - x1) / L)
        dim = layout.add_aligned_dim(p1=(x1, y1), p2=(x2, y2), distance=dist, text=text, dimstyle=ds, override=ov, dxfattribs=a)
    elif kind == "angular":
        c, p1, p2, loc = P("c"), P("p1"), P("p2"), P("loc")
        a1, a2, al = (math.atan2(p[1] - c[1], p[0] - c[0]) for p in (p1, p2, loc))
        if (al - a1) % math.tau > (a2 - a1) % math.tau:  # l'arco che contiene la posizione scelta va da p2 a p1
            p1, p2 = p2, p1
        dim = layout.add_angular_dim_3p(base=loc, center=c, p1=p1, p2=p2, text=text, dimstyle=ds, override=ov, dxfattribs=a)
    elif kind in ("radius", "diameter"):
        c, loc = P("c"), P("loc")
        ang = math.atan2(loc[1] - c[1], loc[0] - c[0]) * DEG
        add = layout.add_radius_dim if kind == "radius" else layout.add_diameter_dim
        inside = math.hypot(loc[0] - c[0], loc[1] - c[1]) < float(e.get("r") or 0)
        dim = add(center=c, radius=float(e.get("r") or 1), angle=ang, location=None if inside else loc, text=text, dimstyle=ds, override=ov, dxfattribs=a)
    elif kind == "ordinate":
        f, l = P("feat"), P("leader")
        o = _xy(e.get("origin") or {"x": 0, "y": 0})
        add = layout.add_ordinate_x_dim if e.get("axis") == "x" else layout.add_ordinate_y_dim
        dim = add(feature_location=f, offset=(l[0] - f[0], l[1] - f[1]), origin=o, text=text, dimstyle=ds, override=ov, dxfattribs=a)
    else:
        return None
    dim.render()
    return dim.dimension


_DIM_POINTS = (("definitionPoint", "defpoint"), ("subDefinitionPoint1", "defpoint2"), ("subDefinitionPoint2", "defpoint3"),
               ("centerPoint", "defpoint4"), ("arcPoint", "defpoint5"), ("textPoint", "text_midpoint"))


def _dim_from_db(layout, e, doc, cx):
    """Quota letta da un DWG: DIMENSION che usa il blocco grafico originale (resta una quota in AutoCAD)."""
    name = _safe_block(e.get("name"))
    if name not in doc.blocks:
        return None
    a = _attribs(e, cx)
    a["geometry"] = name
    a["dimtype"] = int(e.get("dimensionType") or 0)
    ds = e.get("styleName")
    a["dimstyle"] = ds if ds and ds in doc.dimstyles else "Standard"
    for k, dk in _DIM_POINTS:
        if isinstance(e.get(k), dict):
            a[dk] = _xy(e[k], True)
    if isinstance(e.get("measurement"), (int, float)):
        a["actual_measurement"] = float(e["measurement"])
    if e.get("text"):
        a["text"] = str(e["text"])
    if isinstance(e.get("rotationAngle"), (int, float)) and (a["dimtype"] & 7) == 0:
        a["angle"] = float(e["rotationAngle"]) * DEG
    try:
        return layout.new_entity("DIMENSION", dxfattribs=a)
    except Exception:  # noqa: BLE001
        return layout.add_blockref(name, (0, 0), dxfattribs=_attribs(e, cx))


# ---------------------------------------------------------------- creazione e aggiornamento delle entita'
def _create(layout, e, doc, cx):
    """Crea un'entita' ezdxf da un'entita' del lettore. Ritorna l'entita' o None se il tipo non e' supportato."""
    t = e.get("type")
    a = _attribs(e, cx)
    if t == "LINE":
        return layout.add_line(_xy(e.get("startPoint"), True), _xy(e.get("endPoint"), True), dxfattribs=a)
    if t == "CIRCLE":
        return layout.add_circle(_xy(e.get("center"), True), float(e.get("radius", 1)), dxfattribs={**a, **_ext(e)})
    if t == "ARC":
        return layout.add_arc(_xy(e.get("center"), True), float(e.get("radius", 1)), float(e.get("startAngle", 0)) * DEG, float(e.get("endAngle", 0)) * DEG, dxfattribs={**a, **_ext(e)})
    if t == "ELLIPSE":
        return layout.add_ellipse(_xy(e.get("center"), True), _xy(e.get("majorAxisEndPoint"), True), float(e.get("axisRatio", 1)),
                                  float(e.get("startAngle", 0)), float(e.get("endAngle", math.tau)), dxfattribs=a)
    if t in ("LWPOLYLINE", "POLYLINE2D"):
        pts = [((v.get("x") if v.get("x") is not None else (v.get("point") or {}).get("x", 0)),
                (v.get("y") if v.get("y") is not None else (v.get("point") or {}).get("y", 0)), float(v.get("startWidth") or 0), float(v.get("endWidth") or 0), float(v.get("bulge") or 0))
               for v in e.get("vertices", []) if not (int(v.get("flag") or 0) & 16)]
        pl = layout.add_lwpolyline(pts, format="xyseb", close=bool(int(e.get("flag") or 0) & 1 or e.get("closed")), dxfattribs={**a, **_ext(e)})
        if e.get("constantWidth"):
            pl.dxf.const_width = float(e["constantWidth"])
        return pl
    if t == "POLYLINE3D":
        return layout.add_polyline3d([_xy(v.get("point") or v, True) for v in e.get("vertices", [])], close=bool(int(e.get("flag") or 0) & 1), dxfattribs=a)
    if t == "SPLINE":
        cps = [_xy(p, True) for p in e.get("controlPoints") or []]
        if cps and e.get("knots"):
            return layout.add_open_spline(cps, degree=int(e.get("degree") or 3), knots=e.get("knots"), dxfattribs=a)
        fit = [_xy(p, True) for p in e.get("fitPoints") or []] or cps
        return layout.add_spline(fit, degree=int(e.get("degree") or 3), dxfattribs=a) if fit else None
    if t == "POINT":
        return layout.add_point(_xy(e.get("position"), True), dxfattribs=a)
    if t in ("TEXT", "ATTRIB"):
        tx = layout.add_text(e.get("text") or "", height=float(e.get("textHeight") or 1), rotation=float(e.get("rotation") or 0) * DEG, dxfattribs={**a, **_ext(e)})
        tx.dxf.insert = _xy(e.get("startPoint"), True)
        if e.get("xScale") and abs(float(e["xScale"]) - 1) > 1e-9:
            tx.dxf.width = float(e["xScale"])
        if e.get("halign") or e.get("valign"):
            tx.dxf.halign = int(e.get("halign") or 0)
            tx.dxf.valign = int(e.get("valign") or 0)
            tx.dxf.align_point = _xy(e.get("endPoint") or e.get("startPoint"), True)
        return tx
    if t == "MTEXT":
        m = layout.add_mtext(e.get("text") or "", dxfattribs={**a, "insert": _xy(e.get("insertionPoint"), True), "char_height": float(e.get("textHeight") or 1),
                                                            "attachment_point": int(e.get("attachmentPoint") or 1), "width": float(e.get("rectWidth") or 0)})
        d = e.get("direction")
        if d and (d.get("x") or d.get("y")):
            m.dxf.text_direction = _xy(d, True)
        elif e.get("rotation"):
            m.dxf.rotation = float(e["rotation"]) * DEG
        return m
    if t in ("SOLID", "TRACE", "3DFACE"):
        pts = [_xy(e.get(k), True) for k in ("corner1", "corner2", "corner3", "corner4") if e.get(k)]
        if t == "3DFACE":
            return layout.add_3dface(pts, dxfattribs=a)
        return layout.add_solid(pts, dxfattribs=a) if t == "SOLID" else layout.add_trace(pts, dxfattribs=a)
    if t == "HATCH":
        return _hatch(layout, e, a)
    if t == "DIMENSION":
        if e.get("dimKind"):
            return _new_dimension(layout, e, doc, cx)
        d = _dim_from_db(layout, e, doc, cx)
        if d is not None and not _is_identity(e.get("_xf")):
            try:
                d.transform(_m44(e["_xf"]))
            except Exception:  # noqa: BLE001
                pass
        return d
    if t == "INSERT":
        name = _safe_block(e.get("name"))
        if name not in doc.blocks:
            return None
        br = layout.add_blockref(name, _xy(e.get("insertionPoint"), True), dxfattribs={**a, **_ext(e), "xscale": float(e.get("xScale") or 1), "yscale": float(e.get("yScale") or 1),
                                                                                       "rotation": float(e.get("rotation") or 0) * DEG})
        for at in e.get("attribs") or []:
            if not isinstance(at.get("startPoint"), dict):
                continue
            aa = br.add_attrib(at.get("tag") or "ATTR", at.get("text") or "", _xy(at.get("startPoint"), True),
                               dxfattribs={"height": float(at.get("textHeight") or 1), "layer": at.get("layer") or a["layer"], "rotation": float(at.get("rotation") or 0) * DEG})
            if at.get("halign") or at.get("valign"):
                aa.dxf.halign, aa.dxf.valign = int(at.get("halign") or 0), int(at.get("valign") or 0)
                aa.dxf.align_point = _xy(at.get("endPoint") or at.get("startPoint"), True)
            if at.get("xScale") and abs(float(at["xScale"]) - 1) > 1e-9:
                aa.dxf.width = float(at["xScale"])
            if at.get("isVisible") is False:
                aa.dxf.flags = int(aa.dxf.flags) | 1
        return br
    if t == "LEADER":
        return layout.add_lwpolyline([_xy(v) for v in e.get("vertices", [])], dxfattribs=a)
    return None


def _ext(e):
    d = e.get("extrusionDirection")
    if isinstance(d, dict) and float(d.get("z") or 0) < -0.5:
        return {"extrusion": (0, 0, -1)}
    return {}


def _hatch(layout, e, a):
    solid = e.get("solidFill") == 1 or e.get("isSolidFill") is True or str(e.get("patternName") or "").upper() == "SOLID"
    h = layout.add_hatch(color=a.get("color", 256), dxfattribs={k: v for k, v in a.items() if k != "color"})
    if not solid:
        try:
            h.set_pattern_fill(str(e.get("patternName") or "ANSI31"), scale=float(e.get("patternScale") or 1), angle=float(e.get("patternAngle") or 0) * DEG)
        except Exception:  # noqa: BLE001
            try:
                h.set_pattern_fill("ANSI31", scale=float(e.get("patternScale") or 1))
            except Exception:  # noqa: BLE001
                pass
    for path in e.get("boundaryPaths") or []:
        if path.get("vertices"):
            h.paths.add_polyline_path([(float(v["x"]), float(v["y"]), float(v.get("bulge") or 0)) for v in path["vertices"]], is_closed=True)
        elif path.get("edges"):
            ep = h.paths.add_edge_path()
            for ed in path["edges"]:
                if ed.get("type") == 1:
                    ep.add_line(_xy(ed["start"]), _xy(ed["end"]))
                elif ed.get("type") == 2:
                    ep.add_arc(_xy(ed["center"]), float(ed["radius"]), float(ed.get("startAngle", 0)) * DEG, float(ed.get("endAngle", 0)) * DEG, ccw=ed.get("isCCW", True) is not False)
    return h


def _update(ent, e, cx):
    """Aggiorna un'entita' esistente (file DXF) con i valori modificati nell'interfaccia."""
    t = ent.dxftype()
    a = _attribs(e, cx)
    ent.dxf.layer = a["layer"]
    if "true_color" in a:
        ent.dxf.true_color = a["true_color"]
    else:
        ent.dxf.color = a["color"]
        if ent.dxf.hasattr("true_color"):
            ent.dxf.discard("true_color")
    for k in ("linetype", "lineweight", "ltscale"):
        if k in a:
            try:
                ent.dxf.set(k, a[k])
            except Exception:  # noqa: BLE001
                pass
    if t == "LINE":
        ent.dxf.start, ent.dxf.end = _xy(e.get("startPoint"), True), _xy(e.get("endPoint"), True)
    elif t == "CIRCLE":
        ent.dxf.center, ent.dxf.radius = _xy(e.get("center"), True), float(e.get("radius", 1))
    elif t == "ARC":
        ent.dxf.center, ent.dxf.radius = _xy(e.get("center"), True), float(e.get("radius", 1))
        ent.dxf.start_angle, ent.dxf.end_angle = float(e.get("startAngle", 0)) * DEG, float(e.get("endAngle", 0)) * DEG
    elif t == "ELLIPSE":
        ent.dxf.center, ent.dxf.major_axis = _xy(e.get("center"), True), _xy(e.get("majorAxisEndPoint"), True)
        ent.dxf.ratio = float(e.get("axisRatio", 1))
        ent.dxf.start_param, ent.dxf.end_param = float(e.get("startAngle", 0)), float(e.get("endAngle", math.tau))
    elif t == "LWPOLYLINE":
        pts = [(v.get("x", 0), v.get("y", 0), float(v.get("startWidth") or 0), float(v.get("endWidth") or 0), float(v.get("bulge") or 0)) for v in e.get("vertices", [])]
        ent.set_points(pts, format="xyseb")
        ent.closed = bool(int(e.get("flag") or 0) & 1)
        ent.dxf.const_width = float(e.get("constantWidth") or 0)
    elif t in ("TEXT", "ATTRIB"):
        ent.dxf.text = e.get("text") or ""
        ent.dxf.insert = _xy(e.get("startPoint"), True)
        ent.dxf.height = float(e.get("textHeight") or ent.dxf.height)
        ent.dxf.rotation = float(e.get("rotation") or 0) * DEG
        ent.dxf.halign, ent.dxf.valign = int(e.get("halign") or 0), int(e.get("valign") or 0)
        if e.get("endPoint"):
            ent.dxf.align_point = _xy(e.get("endPoint"), True)
    elif t == "MTEXT":
        ent.text = e.get("text") or ""
        ent.dxf.insert = _xy(e.get("insertionPoint"), True)
        ent.dxf.char_height = float(e.get("textHeight") or ent.dxf.char_height)
        if e.get("rectWidth") is not None:
            ent.dxf.width = float(e.get("rectWidth") or 0)
        d = e.get("direction")
        if d and (d.get("x") or d.get("y")):
            ent.dxf.text_direction = _xy(d, True)
            if ent.dxf.hasattr("rotation"):
                ent.dxf.discard("rotation")
        elif e.get("rotation") is not None:
            ent.dxf.rotation = float(e.get("rotation") or 0) * DEG
    elif t == "POINT":
        ent.dxf.location = _xy(e.get("position"), True)
    elif t in ("SOLID", "TRACE", "3DFACE"):
        for i, k in enumerate(("corner1", "corner2", "corner3", "corner4")):
            if e.get(k):
                ent.dxf.set(f"vtx{i}", _xy(e[k], True))
    elif t == "INSERT":
        ent.dxf.insert = _xy(e.get("insertionPoint"), True)
        ent.dxf.xscale, ent.dxf.yscale = float(e.get("xScale") or 1), float(e.get("yScale") or 1)
        ent.dxf.rotation = float(e.get("rotation") or 0) * DEG
        for at, src in zip(list(ent.attribs), e.get("attribs") or []):
            try:
                _update(at, src, cx)
            except Exception:  # noqa: BLE001
                pass
    if t not in DIRECT and not _is_identity(e.get("_xf")):
        # quote, tratteggi, spline...: si applica la trasformazione cumulata (sposta, ruota, scala, specchio)
        ent.transform(_m44(e["_xf"]))
    if t == "DIMENSION" and e.get("text") is not None and not e.get("dimKind"):
        ent.dxf.text = str(e.get("text") or "")
    if t == "HATCH" and e.get("patternScale") and not (e.get("solidFill") == 1):
        try:
            ent.set_pattern_fill(ent.dxf.pattern_name, scale=float(e["patternScale"]), angle=float(e.get("patternAngle") or 0) * DEG)
        except Exception:  # noqa: BLE001
            pass


def _ensure_layers(doc, layers):
    for L in layers or []:
        name = L.get("name")
        if not name:
            continue
        if name not in doc.layers:
            doc.layers.add(name, color=int(L.get("aci") or 7))
        else:
            lay = doc.layers.get(name)
            if L.get("aci") is not None:
                lay.color = int(L["aci"])
            if L.get("off") is not None:
                lay.on = not L["off"]


def _from_db(db, cx_factory):
    import ezdxf
    doc = ezdxf.new("R2018", setup=True)
    cx = cx_factory(doc)
    head = db.get("header") or {}
    for k in ("LTSCALE", "INSUNITS", "DIMSCALE", "MEASUREMENT"):
        if isinstance(head.get(k), (int, float)):
            try:
                doc.header["$" + k] = head[k]
            except Exception:  # noqa: BLE001
                pass
    for L in (db.get("tables", {}).get("LAYER", {}) or {}).get("entries", []):
        n = L.get("name")
        if n and n not in doc.layers:
            try:
                lay = doc.layers.add(n, color=abs(int(L.get("colorIndex") or 7)) or 7)
                if L.get("lineType"):
                    lay.dxf.linetype = cx.linetype(str(L["lineType"])).replace("BYLAYER", "CONTINUOUS")
                lw = L.get("lineweight")
                if isinstance(lw, int) and lw in LINEWEIGHTS:
                    lay.dxf.lineweight = lw
                if L.get("off"):
                    lay.off()
                if L.get("frozen"):
                    lay.freeze()
            except Exception:  # noqa: BLE001
                pass
    # stili di quota del disegno (le quote ricostruite restano uguali anche se AutoCAD le ridisegna)
    for S in (db.get("tables", {}).get("DIMSTYLE", {}) or {}).get("entries", []):
        n = S.get("name")
        if not n or n in doc.dimstyles:
            continue
        try:
            ds = doc.dimstyles.new(n)
            for k, v in S.items():
                if k.startswith("DIM") and isinstance(v, (int, float)) and not isinstance(v, bool) and k not in ("DIMBLK", "DIMBLK1", "DIMBLK2", "DIMLDRBLK", "DIMTXSTY"):
                    try:
                        ds.dxf.set(k.lower(), v)
                    except Exception:  # noqa: BLE001
                        pass
        except Exception:  # noqa: BLE001
            pass
    blocks = (db.get("tables", {}).get("BLOCK_RECORD", {}) or {}).get("entries", [])
    # prima tutti i blocchi vuoti (possono riferirsi l'uno all'altro), poi il loro contenuto
    made = []
    for b in blocks:
        name = b.get("name") or ""
        if name.upper() in ("*MODEL_SPACE", "*PAPER_SPACE") or name.upper().startswith("*PAPER_SPACE"):
            continue
        sn = _safe_block(name)
        if sn in doc.blocks:
            continue
        bp = _xy(b.get("basePoint"), True)
        try:
            made.append((doc.blocks.new(sn, base_point=bp), b))
        except Exception:  # noqa: BLE001
            pass
    for blk, b in made:
        for e in b.get("entities") or []:
            if e.get("_deleted"):
                continue
            try:
                _create(blk, e, doc, cx)
            except Exception:  # noqa: BLE001
                pass
    return doc, cx


def save(src: str, out: str, edits: dict) -> dict:
    """edits: {source: 'dxf'|'dwg', changed: [entita'], deleted: [handle], added: [entita'], layers: [...], ltypes: [...], db: {...} (solo dwg)}"""
    import ezdxf
    from ezdxf import recover
    kind = edits.get("source")
    skipped = 0
    ltypes = edits.get("ltypes")
    if kind == "dxf":
        try:
            doc = ezdxf.readfile(src)
        except Exception:  # noqa: BLE001
            doc, _ = recover.readfile(src)
        cx = Ctx(doc, ltypes)
        _ensure_layers(doc, edits.get("layers"))
        msp = doc.modelspace()
        items = list(msp)

        def find(handle, pos):
            if handle:
                ent = doc.entitydb.get(str(handle))
                if ent is not None:
                    return ent
            if pos is not None and 0 <= int(pos) < len(items):
                return items[int(pos)]
            return None

        for d in edits.get("deleted") or []:
            ent = find(d.get("handle"), d.get("msp")) if isinstance(d, dict) else doc.entitydb.get(str(d))
            if ent is not None and ent.is_alive:
                try:
                    ent.get_layout().delete_entity(ent)
                except Exception:  # noqa: BLE001
                    ent.destroy()
        for e in edits.get("changed") or []:
            ent = find(e.get("handle"), e.get("_msp"))
            if ent is not None and ent.is_alive:
                try:
                    _update(ent, e, cx)
                except Exception:  # noqa: BLE001
                    skipped += 1
        for e in edits.get("added") or []:
            try:
                if _create(msp, e, doc, cx) is None:
                    skipped += 1
            except Exception:  # noqa: BLE001
                skipped += 1
    else:
        db = edits.get("db") or {}
        doc, cx = _from_db(db, lambda d: Ctx(d, ltypes))
        _ensure_layers(doc, edits.get("layers"))
        msp = doc.modelspace()
        for e in db.get("entities") or []:
            if e.get("isInPaperSpace"):
                continue
            try:
                if _create(msp, e, doc, cx) is None:
                    skipped += 1
            except Exception:  # noqa: BLE001
                skipped += 1
    ext = Path(out).suffix.lower()
    if ext == ".dxf":
        doc.saveas(out)
    elif ext == ".dwg":
        _to_dwg(doc, out)
    elif ext in (".pdf", ".svg", ".png"):
        _render(doc, out, ext)
    else:
        raise ValueError("Formati del disegno: DXF, DWG, PDF, SVG, PNG")
    return {"ok": True, "path": out, "non_scritti": skipped}


def find_oda():
    for base in (os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")):
        root = Path(base) / "ODA"
        if root.exists():
            for exe in sorted(root.glob("ODAFileConverter*/ODAFileConverter.exe"), reverse=True):
                return str(exe)
    return None


def _to_dwg(doc, out):
    exe = find_oda()
    if not exe:
        raise RuntimeError("Per scrivere file DWG serve ODA File Converter (gratuito, www.opendesign.com/guestfiles/oda_file_converter). "
                           "Intanto puoi salvare in DXF: AutoCAD e tutti i programmi CAD lo aprono.")
    tmp_in = Path(tempfile.mkdtemp(dir=TEMP_DIR))
    tmp_out = Path(tempfile.mkdtemp(dir=TEMP_DIR))
    name = Path(out).stem
    doc.saveas(tmp_in / (name + ".dxf"))
    subprocess.run([exe, str(tmp_in), str(tmp_out), "ACAD2018", "DWG", "0", "1", "*.DXF"], capture_output=True, timeout=600, creationflags=0x08000000)
    res = tmp_out / (name + ".dwg")
    if not res.exists():
        raise RuntimeError("Conversione in DWG non riuscita")
    shutil.move(str(res), out)


def _render(doc, out, ext):
    from ezdxf.addons.drawing import Frontend, RenderContext, layout
    from ezdxf.addons.drawing.config import BackgroundPolicy, ColorPolicy, Configuration
    from ezdxf.addons.drawing.pymupdf import PyMuPdfBackend
    msp = doc.modelspace()
    backend = PyMuPdfBackend()
    cfg = Configuration(background_policy=BackgroundPolicy.WHITE, color_policy=ColorPolicy.COLOR)
    Frontend(RenderContext(doc), backend, config=cfg).draw_layout(msp)
    page = layout.Page(0, 0, layout.Units.mm, margins=layout.Margins.all(10))  # dimensione automatica
    if ext == ".pdf":
        Path(out).write_bytes(backend.get_pdf_bytes(page))
    elif ext == ".svg":
        from ezdxf.addons.drawing import svg
        b2 = svg.SVGBackend()
        Frontend(RenderContext(doc), b2, config=cfg).draw_layout(msp)
        Path(out).write_text(b2.get_string(page), encoding="utf-8")
    else:
        Path(out).write_bytes(backend.get_pixmap_bytes(page, fmt="png", dpi=200))
