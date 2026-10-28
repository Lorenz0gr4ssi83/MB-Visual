"""Fedelta' della conversione IFC -> STEP: confronta, elemento per elemento, l'IFC (IfcOpenShell) con lo STEP riletto da
OpenCascade come lo leggerebbe un CAD (assieme XCAF con posizioni, nomi, colori).

  python tests/ifcstep_fedelta.py <file.ifc> <file.stp> [--json risultato.json]

- Elementi attesi = prodotti IFC con una rappresentazione 3D (corpo), escluse aperture, spazi e zone (come mbvisual/ifcstep.py).
- Ogni elemento IFC si abbina alla foglia dello STEP con lo stesso nome e l'ingombro piu' vicino (coordinate assolute);
  si misurano ingombro (scarto ammesso 1 mm) e volume (0,1%, solo per i solidi chiusi e validi). Riferimento: il B-rep
  esatto calcolato da IfcOpenShell (coordinate del progetto, metri), misurato con OpenCascade.
- In piu': GlobalId scritti come id dei PRODUCT (lettura del testo), foglie senza colore, radice e profondita' dell'albero.
Serve anche per misurare lo STEP scritto dalla pagina (vecchio esportatore): li' i nomi sono quelli del visualizzatore.
"""
from __future__ import annotations

import argparse
import json
import multiprocessing
import os
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _abs_volume(shape) -> float:
    """Volume di materiale = somma dei volumi assoluti dei solidi. Alcuni solidi degli IFC (gusci con orientamento
    ambiguo) si rileggono dallo STEP girati al contrario: OpenCascade li "ripara" in quel verso; la geometria e' la stessa."""
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    tot, e = 0.0, TopExp_Explorer(shape, TopAbs_SOLID)
    while e.More():
        gp = GProp_GProps()
        BRepGProp.VolumeProperties_s(e.Current(), gp)
        tot += abs(gp.Mass())
        e.Next()
    return tot


def ifc_side(path: str) -> dict:
    import ifcopenshell
    import ifcopenshell.geom as geom
    from mbvisual.ifcstep import EXCLUDE, _is_body
    f = ifcopenshell.open(path)
    excl = []
    for c in EXCLUDE:
        try:
            f.by_type(c)
            excl.append(c)
        except Exception:  # noqa: BLE001
            pass
    attesi = {}
    for p in f.by_type("IfcProduct"):
        if any(p.is_a(c) for c in excl) or not p.Representation:
            continue
        if any(_is_body(r) for r in p.Representation.Representations or ()):
            attesi[p.GlobalId] = {"n": p.Name or "", "c": p.is_a()}
    # riferimento = B-rep esatto calcolato da IfcOpenShell (volume con OpenCascade); la mesh triangolata a volte ha
    # i tappi delle sezioni non convesse girati male e il volume sbagliato (es. profili HEB)
    import io
    import ifcopenshell.ifcopenshell_wrapper as W
    from OCP.Bnd import Bnd_Box
    from OCP.BRep import BRep_Builder
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.BRepTools import BRepTools
    from OCP.TopAbs import TopAbs_SHELL, TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS_Shape
    # uscita nativa: le geometrie ripetute (istanze) si leggono e si misurano una volta, poi si spostano
    from mbvisual.ifcstep import _place, _rigid
    s = geom.settings()
    s.set("iterator-output", W.NATIVE)
    s.set("use-world-coords", False)
    it = geom.iterator(s, f, multiprocessing.cpu_count(), exclude=tuple(excl))
    out = {}
    cache = {}
    bb = BRep_Builder()
    if it.initialize():
        while True:
            sh = it.get()
            g = sh.geometry
            c = cache.get(g.id)
            if c is None:
                shape = TopoDS_Shape()
                BRepTools.Read_s(shape, io.BytesIO(W.serialization(g).brep_data.encode()), bb)
                sol = TopExp_Explorer(shape, TopAbs_SOLID).More()
                loose = TopExp_Explorer(shape, TopAbs_SHELL, TopAbs_SOLID).More()
                c = cache[g.id] = (shape, _abs_volume(shape), bool(sol and not loose and BRepCheck_Analyzer(shape).IsValid()))
            m = list(sh.transformation.matrix)
            ws = _place(c[0], m)
            box = Bnd_Box()
            BRepBndLib.AddOptimal_s(ws, box, False, False)
            if not box.IsVoid():
                p0, p1 = box.CornerMin(), box.CornerMax()
                out[sh.guid] = {"min": [p0.X(), p0.Y(), p0.Z()], "max": [p1.X(), p1.Y(), p1.Z()],
                                "vol": c[1] if _rigid(m) else _abs_volume(ws), "chiusa": c[2]}
            if not it.next():
                break
    return {"attesi": attesi, "geo": out, "schema": f.schema}


def step_side(path: str) -> dict:
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.Interface import Interface_Static
    from OCP.Quantity import Quantity_Color
    from OCP.STEPCAFControl import STEPCAFControl_Reader
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDataStd import TDataStd_Name
    from OCP.TDF import TDF_Label
    from OCP.TDocStd import TDocStd_Document
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Plane
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS
    from OCP.XCAFApp import XCAFApp_Application
    from OCP.XCAFDoc import XCAFDoc_ColorSurf, XCAFDoc_ColorTool, XCAFDoc_DocumentTool
    try:
        from OCP.TDF import TDF_LabelSequence
    except ImportError:
        from OCP.OCP.collections import Sequence_TDF_Label as TDF_LabelSequence
    ids = set()  # id dei PRODUCT (GlobalId) dal testo, a blocchi
    rx = re.compile(rb"PRODUCT\('((?:[^']|'')*)'")
    with open(path, "rb") as f:
        rest = b""
        while True:
            blk = f.read(32 << 20)
            if not blk:
                break
            buf = rest + blk
            cut = buf.rfind(b"\n")
            rest, buf = buf[cut + 1:], buf[:cut + 1]
            ids.update(m.group(1).decode("latin-1") for m in rx.finditer(buf))
    Interface_Static.SetCVal_s("xstep.cascade.unit", "M")
    doc = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
    XCAFApp_Application.GetApplication_s().InitDocument(doc)
    XCAFDoc_DocumentTool.SetLengthUnit_s(doc, 1.0)
    rd = STEPCAFControl_Reader()
    rd.SetColorMode(True)
    rd.SetNameMode(True)
    if int(rd.ReadFile(path)) != 1 or not rd.Transfer(doc):
        raise RuntimeError("STEP non leggibile")
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    gc = XCAFDoc_ColorTool.GetColor_s

    def name(lab):
        a = TDataStd_Name()
        return a.Get().ToExtString() if lab.FindAttribute(TDataStd_Name.GetID_s(), a) else ""

    leaves = []
    stats = {"profondita": 0}

    def walk(lab, loc, d, pname=""):
        stats["profondita"] = max(stats["profondita"], d)
        ref = lab
        if st.IsReference_s(lab):
            ref = TDF_Label()
            st.GetReferredShape_s(lab, ref)
            loc = loc.Multiplied(st.GetLocation_s(lab))
        if st.IsAssembly_s(ref):
            kids = TDF_LabelSequence()
            st.GetComponents_s(ref, kids, False)
            for i in range(1, kids.Length() + 1):
                walk(kids.Value(i), loc, d + 1, name(ref))
            return
        sh = st.GetShape_s(ref).Moved(loc)
        c = Quantity_Color()
        has = gc(ref, XCAFDoc_ColorSurf, c) or gc(lab, XCAFDoc_ColorSurf, c)
        if not has:
            sub = TDF_LabelSequence()
            st.GetSubShapes_s(ref, sub)
            has = any(gc(sub.Value(i), XCAFDoc_ColorSurf, c) for i in range(1, sub.Length() + 1))
        if not has:
            e = TopExp_Explorer(st.GetShape_s(ref), TopAbs_SOLID)
            while e.More() and not has:
                has = ct.GetColor(e.Current(), XCAFDoc_ColorSurf, c)
                e.Next()
        box = Bnd_Box()
        BRepBndLib.AddOptimal_s(sh, box, False, False)
        if box.IsVoid():
            return
        ns = 0
        e = TopExp_Explorer(sh, TopAbs_SOLID)
        while e.More():
            ns += 1
            e.Next()
        curve = False  # superfici curve: nello STEP sono esatte, la mesh dell'IFC le approssima (volume un po' diverso)
        e = TopExp_Explorer(sh, TopAbs_FACE)
        while e.More() and not curve:
            curve = BRepAdaptor_Surface(TopoDS.Face(e.Current()), False).GetType() != GeomAbs_Plane
            e.Next()
        p0, p1 = box.CornerMin(), box.CornerMax()
        x0, y0, z0, x1, y1, z1 = p0.X(), p0.Y(), p0.Z(), p1.X(), p1.Y(), p1.Z()
        leaves.append({"n": name(ref) or name(lab), "min": [x0, y0, z0], "max": [x1, y1, z1], "vol": _abs_volume(sh),
                       "solidi": ns, "colore": bool(has), "curve": curve, "padre": pname})

    roots = TDF_LabelSequence()
    st.GetFreeShapes(roots)
    rn = []
    for i in range(1, roots.Length() + 1):
        rn.append(name(roots.Value(i)))
        walk(roots.Value(i), TopLoc_Location(), 1)
    return {"leaves": leaves, "ids": ids, "radici": rn, "profondita": stats["profondita"]}


def _boxd(s, g):
    return max(max(abs(p - q) for p, q in zip(s["min"], g["min"])), max(abs(p - q) for p, q in zip(s["max"], g["max"])))


def compare(ifc: dict, stp: dict) -> dict:
    """Abbina ogni elemento IFC a una foglia dello STEP con lo stesso nome e l'ingombro piu' vicino."""
    att, geo = ifc["attesi"], ifc["geo"]
    byname: dict[str, list] = {}
    for lf in stp["leaves"]:
        byname.setdefault(lf["n"], []).append(lf)
        # geometria condivisa da piu' elementi: la foglia e' la parte comune, il nome dell'elemento e' sull'assieme padre
        if lf.get("padre") and lf["padre"] != lf["n"]:
            byname.setdefault(lf["padre"], []).append(lf)
    res = {"attesi": len(att), "nello_step": 0, "guid_presenti": sum(1 for g in att if g in stp["ids"]), "mancanti": [],
           "ingombro_diverso": [], "volume_diverso": [], "senza_colore": 0, "senza_geometria_ifc": 0,
           "foglie_step": len(stp["leaves"]), "radici": stp["radici"], "profondita": stp["profondita"]}
    # prima gli elementi con geometria (abbinamento per ingombro), poi gli altri per nome
    order = sorted(att, key=lambda gid: gid not in geo)
    for gid in order:
        a = att[gid]
        g = geo.get(gid)
        cand = byname.get(a["n"] or a["c"]) or byname.get(a["n"]) or []
        if g is None:
            res["senza_geometria_ifc"] += 1
            if cand:
                res["nello_step"] += 1
                cand.pop()
            else:
                res["mancanti"].append({"g": gid, **a, "motivo": "anche IfcOpenShell non calcola la geometria"})
            continue
        if not cand:
            res["mancanti"].append({"g": gid, **a})
            continue
        j = min(range(len(cand)), key=lambda k: _boxd(cand[k], g))
        s = cand.pop(j)
        for lst in byname.values():  # la stessa foglia non si abbina due volte (e' sotto il suo nome e sotto il padre)
            if lst is not cand and s in lst:
                lst.remove(s)
        res["nello_step"] += 1
        res["senza_colore"] += not s["colore"]
        d = _boxd(s, g)
        if d > 0.001:
            res["ingombro_diverso"].append({"g": gid, "n": a["n"], "c": a["c"], "scarto_mm": round(d * 1000, 2)})
        if g["chiusa"] and s["solidi"]:
            dv = abs(s["vol"] - g["vol"])
            if dv > max(0.001 * g["vol"], 1e-7):
                res["volume_diverso"].append({"g": gid, "n": a["n"], "c": a["c"], "ifc_m3": round(g["vol"], 6), "step_m3": round(s["vol"], 6)})
    res["percentuale"] = round(100.0 * res["nello_step"] / max(res["attesi"], 1), 3)
    return res


def compare_shapes(ifc: dict, stp: dict) -> dict:
    """Per STEP senza nomi utili (vecchio esportatore della pagina: PRODUCT = classe IFC, coordinate della scena spostate):
    spostamento globale dagli angoli minimi dei due modelli, poi abbinamento per ingombro (scarto ammesso 1 cm)."""
    import numpy as np
    geo = ifc["geo"]
    gids = [g for g in ifc["attesi"] if g in geo]
    lv = stp["leaves"]
    if not gids or not lv:
        return {"attesi": len(ifc["attesi"]), "abbinati_forma": 0}
    A = np.array([geo[g]["min"] + geo[g]["max"] for g in gids])
    B = np.array([x["min"] + x["max"] for x in lv])
    off = A[:, :3].min(0) - B[:, :3].min(0)
    B = B + np.concatenate([off, off])
    used = np.zeros(len(B), bool)
    ok = 0
    vol_ok = 0
    for k in range(len(A)):
        d = np.abs(B - A[k]).max(1)
        d[used] = np.inf
        j = int(d.argmin())
        if d[j] <= 0.01:
            used[j] = True
            ok += 1
            g = geo[gids[k]]
            if g["chiusa"] and abs(lv[j]["vol"] - g["vol"]) <= max(0.001 * g["vol"], 1e-7):
                vol_ok += 1
    return {"attesi": len(ifc["attesi"]), "foglie_step": len(lv), "abbinati_forma": ok, "volume_uguale": vol_ok,
            "spostamento_m": [round(float(x), 3) for x in off]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ifc")
    ap.add_argument("stp")
    ap.add_argument("--json")
    ap.add_argument("--forma", action="store_true", help="abbina per ingombro (STEP senza nomi IFC, coordinate spostate)")
    a = ap.parse_args()
    t0 = time.time()
    i = ifc_side(a.ifc)
    s = step_side(a.stp)
    r = compare(i, s)
    if a.forma:
        r["forma"] = compare_shapes(i, s)
    r["tempo_misura"] = round(time.time() - t0, 1)
    if a.json:
        Path(a.json).write_text(json.dumps(r, ensure_ascii=False), encoding="utf-8")
    short = {k: (v if not isinstance(v, list) or k == "radici" else (len(v), v[:3])) for k, v in r.items()}
    print(json.dumps(short, ensure_ascii=False))
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
