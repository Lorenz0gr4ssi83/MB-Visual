"""Collaudo degli STEP grandi con OpenCascade nativo in parallelo (tools/stepsplit + mbvisual/stepnative.py).

  python tests/test_stepnative.py                  assieme sintetico scritto qui (OCP): parti ripetute, colori, una parte
                                                   con piu' solidi e un solido grande che si divide per facce
  python tests/test_stepnative.py <file.step>...   anche file veri: conversione con un processo e in parallelo, confronto
                                                   per parte (ingombri, triangoli, colori) e tempi

Serve cadquery-ocp nel venv (requirements.txt) e bin/stepsplit compilato (tools/stepsplit/build.cmd).
"""
import collections
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mbvisual import model3dcache, stepnative  # noqa: E402

OK = 0
KO = 0


def check(cond, msg):
    global OK, KO
    if cond:
        OK += 1
        print("  ok  ", msg)
    else:
        KO += 1
        print("  NO  ", msg)


SAMPLE = r'''
import sys
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.BRep import BRep_Builder
from OCP.TopoDS import TopoDS_Compound
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec
from OCP.IFSelect import IFSelect_RetDone
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.TopLoc import TopLoc_Location
from OCP.XCAFDoc import XCAFDoc_ColorSurf, XCAFDoc_DocumentTool

def plate(w, d, holes):
    s = BRepPrimAPI_MakeBox(w, d, 10).Shape()
    for i in range(holes):
        x, y = 8 + (i % 20) * (w - 16) / 19, 8 + (i // 20) * 12
        s = BRepAlgoAPI_Cut(s, BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(x, y, -1), gp_Dir(0, 0, 1)), 2.5, 12).Shape()).Shape()
    return s

doc = TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
asm = st.NewShape()
TDataStd_Name.Set_s(asm, TCollection_ExtendedString("Assieme di prova"))
cols = [(0.8, 0.2, 0.2), (0.2, 0.5, 0.8), (0.9, 0.7, 0.1)]
def add(shape, name, col, x, y):
    lab = st.AddShape(shape, False)
    TDataStd_Name.Set_s(lab, TCollection_ExtendedString(name))
    ct.SetColor(lab, Quantity_Color(*col, Quantity_TOC_RGB), XCAFDoc_ColorSurf)
    tr = gp_Trsf(); tr.SetTranslation(gp_Vec(x, y, 0))
    return lab, tr
for k in range(30):
    lab, tr = add(plate(60 + k % 4 * 5, 40, 3 + k % 5), f"Piastra {k + 1}", cols[k % 3], (k % 6) * 100.0, (k // 6) * 80.0)
    st.AddComponent(asm, lab, TopLoc_Location(tr))
    if k == 0:  # stessa parte due volte
        tr2 = gp_Trsf(); tr2.SetTranslation(gp_Vec(-200.0, 0, 0))
        st.AddComponent(asm, lab, TopLoc_Location(tr2))
# parte con piu' solidi (compound)
cb = BRep_Builder(); comp = TopoDS_Compound(); cb.MakeCompound(comp)
for i in range(5):
    b = BRepPrimAPI_MakeBox(gp_Pnt(i * 30.0, 0, 0), 20, 20, 20 + i).Shape()
    cb.Add(comp, b)
lab, tr = add(comp, "Gruppo di blocchi", (0.3, 0.7, 0.3), 0, 500)
st.AddComponent(asm, lab, TopLoc_Location(tr))
# solido grande (molte facce): si divide per facce tra i processi
lab, tr = add(plate(600, 100, 160), "Piastra forata grande", (0.6, 0.6, 0.65), 0, -300)
st.AddComponent(asm, lab, TopLoc_Location(tr))
st.UpdateAssemblies()
w = STEPCAFControl_Writer(); w.SetColorMode(True); w.SetNameMode(True)
w.Transfer(doc, STEPControl_AsIs)
assert w.Write(sys.argv[1]) == IFSelect_RetDone
'''


def parts_of(glb):
    """Per ogni istanza di primo livello (figli della radice): triangoli, ingombro nel mondo e colori."""
    js, _ = stepnative._read_glb(glb)
    nodes, acc, mats = js["nodes"], js["accessors"], js.get("materials", [])

    def local(n):
        if "matrix" in n:
            return np.array(n["matrix"]).reshape(4, 4).T
        m = np.eye(4)
        if "rotation" in n:
            x, y, z, w = n["rotation"]
            m[:3, :3] = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                         [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                         [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
        if "scale" in n:
            m[:3, :3] = m[:3, :3] @ np.diag(n["scale"])
        if "translation" in n:
            m[:3, 3] = n["translation"]
        return m

    out = collections.defaultdict(lambda: {"tri": 0, "lo": np.full(3, np.inf), "hi": np.full(3, -np.inf), "col": set()})

    def visit(i, M, key):
        n = nodes[i]
        M = M @ local(n)
        if "mesh" in n:
            P = out[key]
            for pr in js["meshes"][n["mesh"]]["primitives"]:
                a = acc[pr["attributes"]["POSITION"]]
                lo, hi = np.array(a["min"]), np.array(a["max"])
                c = np.array([[x, y, z, 1] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]) @ M.T
                P["lo"] = np.minimum(P["lo"], c[:, :3].min(0))
                P["hi"] = np.maximum(P["hi"], c[:, :3].max(0))
                P["tri"] += acc[pr["indices"]]["count"] // 3 if "indices" in pr else 0
                P["col"].add(tuple(round(v, 3) for v in mats[pr["material"]]["pbrMetallicRoughness"]["baseColorFactor"])
                             if "material" in pr else None)
        for c in n.get("children", []):
            visit(c, M, key)

    roots = js["scenes"][0]["nodes"]
    for r in roots:
        first = nodes[r].get("children", [])
        if not first:
            visit(r, np.eye(4), nodes[r].get("name", ""))
        for j, c in enumerate(first):  # istanze del primo livello, numerate (stesso nome = stessa parte ripetuta)
            visit(c, local(nodes[r]), f"{nodes[c].get('name', '')}#{j}")
    return out, js


def convert(path, n):
    os.environ["MBV_STEP_PARTI"] = str(n)
    k = model3dcache._key(path, "stepglb", stepnative.VERSION)
    for suf in (".glb", ".info.json"):
        (model3dcache.CACHE_DIR / (k + suf)).unlink(missing_ok=True)
    t = time.time()
    r = stepnative.convert(path)
    dt = time.time() - t
    copy = Path(tempfile.gettempdir()) / f"mbv_step_{n}_{k}.glb"
    shutil.copy2(r["glb"], copy)
    return str(copy), r["info"], dt


def compare(path, n):
    print(f"\n{Path(path).name}: un processo contro {n}")
    g1, i1, t1 = convert(path, 1)
    gn, inn, tn = convert(path, n)
    print(f"  tempi: un processo {t1:.1f} s, {inn.get('parti')} processi {tn:.1f} s")
    check(inn.get("parti", 1) > 1, f"conversione divisa in {inn.get('parti')} parti")
    check(not inn.get("primo_tentativo"), "nessun ripiego su un solo processo")
    a, ja = parts_of(g1)
    b, jb = parts_of(gn)
    check(set(a) == set(b), f"stesse istanze di primo livello ({len(a)})")
    common = set(a) & set(b)
    d = max((max(np.abs(a[k]["lo"] - b[k]["lo"]).max(), np.abs(a[k]["hi"] - b[k]["hi"]).max()) for k in common), default=0)
    # i solidi divisi per facce si triangolano a parte: differenze di centesimi di mm (freccia di decine di mm)
    check(d < 0.05, f"ingombri uguali per parte (scarto massimo {d:.4f} mm)")
    check(all(a[k]["col"] == b[k]["col"] for k in common), "colori uguali per parte")
    ta, tb = sum(v["tri"] for v in a.values()), sum(v["tri"] for v in b.values())
    check(abs(ta - tb) <= 0.01 * ta, f"triangoli {ta} / {tb}")
    names = collections.Counter(n.get("name") for n in jb["nodes"])
    check(not any(names.get(g) for g in stepnative.GENERIC), "nessun nome generico (SOLID, COMPOUND...)")
    for f in (g1, gn):
        os.unlink(f)
    return a, b, jb


def main():
    files = [a for a in sys.argv[1:] if not a.startswith("-")]
    check(stepnative.available(), "OCP installato")
    check(stepnative._splitter() is not None, "stepsplit compilato (bin/stepsplit)")
    if files:
        ns = [stepnative._parts_for(os.path.getsize(f)) for f in files]  # prima di convert(), che imposta MBV_STEP_PARTI
        for f, n in zip(files, ns):
            compare(os.path.abspath(f), max(n, 2))
    else:
        tmp = Path(tempfile.mkdtemp(prefix="mbv_stepnative_"))
        src = tmp / "assieme.step"
        print("creazione dell'assieme di prova...")
        r = subprocess.run([sys.executable, "-c", SAMPLE, str(src)], capture_output=True, text=True)
        check(r.returncode == 0 and src.is_file(), "assieme di prova scritto")
        # divisore: 4 file, solido grande diviso per facce, struttura in tutti
        out = tmp / "parti"
        out.mkdir()
        r = subprocess.run([str(stepnative._splitter()), str(src), str(out), "4"], capture_output=True, text=True)
        import json
        res = json.loads(r.stdout.strip().splitlines()[-1])
        check(res.get("ok") and len(res["parti"]) == 4, "divisione in 4 file")
        check(res.get("divisi", 0) >= 1, f"solido grande diviso per facce ({res.get('divisi')})")
        prods = [p.read_text(encoding="latin-1").count("PRODUCT(") for p in sorted(out.glob("parte*.step"))]
        check(len(set(prods)) == 1 and prods[0] > 30, f"tutti i prodotti in ogni parte ({prods})")
        a, b, jb = compare(str(src), 4)
        check(len(a) == 33, f"33 istanze di primo livello ({len(a)})")
        rep = [k for k in b if k.startswith("Piastra 1#")]
        check(len(rep) == 2 and abs((b[rep[0]]["lo"] - b[rep[1]]["lo"])[0]) > 100, "parte ripetuta: due istanze in posizioni diverse")
        blk = [n for n in jb["nodes"] if n.get("name") == "Gruppo di blocchi"]
        check(len(blk) >= 6, f"parte con 5 solidi scomposta: un elemento per solido ({len(blk) - 1})")
        big = [k for k in b if k.startswith("Piastra forata grande")]
        check(big and b[big[0]]["col"] == {(0.6, 0.6, 0.65, 1.0)}, "solido diviso: colore conservato")
        shutil.rmtree(tmp, ignore_errors=True)
    os.environ.pop("MBV_STEP_PARTI", None)
    print(f"\n{OK} riuscite, {KO} non riuscite")
    return 1 if KO else 0


if __name__ == "__main__":
    sys.exit(main())
