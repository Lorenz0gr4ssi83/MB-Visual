"""Salvataggio dei disegni CAD modificati in MB Visual (ezdxf).

- File DXF: si riapre l'originale e si applicano solo le modifiche (per handle): tutto il resto resta identico.
- File DWG: il disegno si ricostruisce in DXF dalle entita' lette (layer, blocchi, entita').
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


def _xy(p, z=False):
    if not p:
        return (0.0, 0.0, 0.0) if z else (0.0, 0.0)
    return (float(p.get("x", 0)), float(p.get("y", 0)), float(p.get("z", 0) or 0)) if z else (float(p.get("x", 0)), float(p.get("y", 0)))


def _attribs(e):
    a = {"layer": e.get("layer") or "0"}
    if isinstance(e.get("color"), (int, float)) and e.get("colorIndex") in (None,):
        a["true_color"] = int(e["color"])
    else:
        ci = e.get("colorIndex")
        a["color"] = 256 if ci is None else int(ci)
    return a


def _safe_block(name):
    return re.sub(r'[<>/\\":;?*|=`]', "_", name or "BLOCCO")


def _create(layout, e, doc):
    """Crea un'entita' ezdxf da un'entita' del lettore. Ritorna l'entita' o None se il tipo non e' supportato."""
    t = e.get("type")
    a = _attribs(e)
    if t == "LINE":
        return layout.add_line(_xy(e.get("startPoint"), True), _xy(e.get("endPoint"), True), dxfattribs=a)
    if t == "CIRCLE":
        return layout.add_circle(_xy(e.get("center"), True), float(e.get("radius", 1)), dxfattribs=a)
    if t == "ARC":
        return layout.add_arc(_xy(e.get("center"), True), float(e.get("radius", 1)), float(e.get("startAngle", 0)) * DEG, float(e.get("endAngle", 0)) * DEG, dxfattribs=a)
    if t == "ELLIPSE":
        return layout.add_ellipse(_xy(e.get("center"), True), _xy(e.get("majorAxisEndPoint"), True), float(e.get("axisRatio", 1)),
                                  float(e.get("startAngle", 0)), float(e.get("endAngle", math.tau)), dxfattribs=a)
    if t in ("LWPOLYLINE", "POLYLINE2D"):
        pts = [((v.get("x") if v.get("x") is not None else (v.get("point") or {}).get("x", 0)),
                (v.get("y") if v.get("y") is not None else (v.get("point") or {}).get("y", 0)), 0, 0, float(v.get("bulge") or 0))
               for v in e.get("vertices", []) if not (int(v.get("flag") or 0) & 16)]
        return layout.add_lwpolyline(pts, format="xyseb", close=bool(int(e.get("flag") or 0) & 1 or e.get("closed")), dxfattribs=a)
    if t == "POLYLINE3D":
        return layout.add_polyline3d([_xy(v.get("point") or v, True) for v in e.get("vertices", [])], close=bool(int(e.get("flag") or 0) & 1), dxfattribs=a)
    if t == "SPLINE":
        cps = [_xy(p, True) for p in e.get("controlPoints") or []]
        if cps and e.get("knots"):
            s = layout.add_open_spline(cps, degree=int(e.get("degree") or 3), knots=e.get("knots"), dxfattribs=a)
            return s
        fit = [_xy(p, True) for p in e.get("fitPoints") or []] or cps
        return layout.add_spline(fit, degree=int(e.get("degree") or 3), dxfattribs=a) if fit else None
    if t == "POINT":
        return layout.add_point(_xy(e.get("position"), True), dxfattribs=a)
    if t in ("TEXT", "ATTRIB"):
        tx = layout.add_text(e.get("text") or "", height=float(e.get("textHeight") or 1), rotation=float(e.get("rotation") or 0) * DEG, dxfattribs=a)
        tx.dxf.insert = _xy(e.get("startPoint"), True)
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
        h = layout.add_hatch(color=a.get("color", 256), dxfattribs={"layer": a["layer"]})
        if not (e.get("solidFill") == 1 or e.get("isSolidFill")):
            try:
                h.set_pattern_fill(e.get("patternName") or "ANSI31", scale=float(e.get("patternScale") or 1))
            except Exception:  # noqa: BLE001
                pass
        for path in e.get("boundaryPaths") or []:
            if path.get("vertices"):
                h.paths.add_polyline_path([(v["x"], v["y"], float(v.get("bulge") or 0)) for v in path["vertices"]], is_closed=True)
            elif path.get("edges"):
                ep = h.paths.add_edge_path()
                for ed in path["edges"]:
                    if ed.get("type") == 1:
                        ep.add_line(_xy(ed["start"]), _xy(ed["end"]))
                    elif ed.get("type") == 2:
                        ep.add_arc(_xy(ed["center"]), float(ed["radius"]), float(ed.get("startAngle", 0)) * DEG, float(ed.get("endAngle", 0)) * DEG, ccw=ed.get("isCCW", True) is not False)
        return h
    if t in ("INSERT", "DIMENSION"):
        name = _safe_block(e.get("name"))
        if name not in doc.blocks:
            return None
        if t == "DIMENSION":  # la quota si conserva come il suo blocco grafico
            return layout.add_blockref(name, (0, 0), dxfattribs=a)
        br = layout.add_blockref(name, _xy(e.get("insertionPoint"), True), dxfattribs={**a, "xscale": float(e.get("xScale") or 1), "yscale": float(e.get("yScale") or 1),
                                                                                       "rotation": float(e.get("rotation") or 0) * DEG})
        for at in e.get("attribs") or []:
            br.add_attrib(at.get("tag") or "ATTR", at.get("text") or "", _xy(at.get("startPoint"), True), dxfattribs={"height": float(at.get("textHeight") or 1), "layer": at.get("layer") or a["layer"]})
        return br
    if t == "LEADER":
        return layout.add_lwpolyline([_xy(v) for v in e.get("vertices", [])], dxfattribs=a)
    return None


def _update(ent, e):
    """Aggiorna un'entita' esistente (file DXF) con i valori modificati nell'interfaccia."""
    t = ent.dxftype()
    a = _attribs(e)
    ent.dxf.layer = a["layer"]
    if "true_color" in a:
        ent.dxf.true_color = a["true_color"]
    else:
        ent.dxf.color = a["color"]
        if ent.dxf.hasattr("true_color"):
            ent.dxf.discard("true_color")
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
    elif t == "LWPOLYLINE":
        pts = [(v.get("x", 0), v.get("y", 0), 0, 0, float(v.get("bulge") or 0)) for v in e.get("vertices", [])]
        ent.set_points(pts, format="xyseb")
        ent.closed = bool(int(e.get("flag") or 0) & 1)
    elif t == "TEXT":
        ent.dxf.text = e.get("text") or ""
        ent.dxf.insert = _xy(e.get("startPoint"), True)
        ent.dxf.height = float(e.get("textHeight") or ent.dxf.height)
        ent.dxf.rotation = float(e.get("rotation") or 0) * DEG
        if ent.dxf.hasattr("align_point") and e.get("endPoint"):
            ent.dxf.align_point = _xy(e.get("endPoint"), True)
    elif t == "MTEXT":
        ent.text = e.get("text") or ""
        ent.dxf.insert = _xy(e.get("insertionPoint"), True)
        ent.dxf.char_height = float(e.get("textHeight") or ent.dxf.char_height)
        if e.get("rotation") is not None and not (e.get("direction") or {}).get("x"):
            ent.dxf.rotation = float(e.get("rotation") or 0) * DEG
    elif t == "POINT":
        ent.dxf.location = _xy(e.get("position"), True)
    elif t == "INSERT":
        ent.dxf.insert = _xy(e.get("insertionPoint"), True)
        ent.dxf.xscale, ent.dxf.yscale = float(e.get("xScale") or 1), float(e.get("yScale") or 1)
        ent.dxf.rotation = float(e.get("rotation") or 0) * DEG
    # altri tipi (quote, retini...): si aggiornano layer e colore; la geometria si sposta con transform se richiesto
    if e.get("_move"):
        try:
            from ezdxf.math import Matrix44
            ent.transform(Matrix44.translate(float(e["_move"][0]), float(e["_move"][1]), 0))
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


def _from_db(db):
    import ezdxf
    doc = ezdxf.new("R2018", setup=True)
    for L in (db.get("tables", {}).get("LAYER", {}) or {}).get("entries", []):
        n = L.get("name")
        if n and n not in doc.layers:
            try:
                doc.layers.add(n, color=abs(int(L.get("colorIndex") or 7)) or 7)
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
        made.append((doc.blocks.new(sn, base_point=bp), b))
    for blk, b in made:
        for e in b.get("entities") or []:
            try:
                _create(blk, e, doc)
            except Exception:  # noqa: BLE001
                pass
    return doc


def save(src: str, out: str, edits: dict) -> dict:
    """edits: {source: 'dxf'|'dwg', changed: [entita'], deleted: [handle], added: [entita'], layers: [...], db: {...} (solo dwg)}"""
    import ezdxf
    from ezdxf import recover
    kind = edits.get("source")
    skipped = 0
    if kind == "dxf":
        try:
            doc = ezdxf.readfile(src)
        except Exception:  # noqa: BLE001
            doc, _ = recover.readfile(src)
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
                    _update(ent, e)
                except Exception:  # noqa: BLE001
                    skipped += 1
        for e in edits.get("added") or []:
            if _create(msp, e, doc) is None:
                skipped += 1
    else:
        db = edits.get("db") or {}
        doc = _from_db(db)
        _ensure_layers(doc, edits.get("layers"))
        msp = doc.modelspace()
        for e in db.get("entities") or []:
            if e.get("isInPaperSpace"):
                continue
            try:
                if _create(msp, e, doc) is None:
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
