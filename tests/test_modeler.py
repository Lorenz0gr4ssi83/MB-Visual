"""Collaudo del motore di modellazione 3D (mbvisual/modkernel.py e mbvisual/modeler.py), senza interfaccia.

Ogni prova confronta il risultato con il valore teorico (volumi, ingombri), riapre con OpenCascade gli STEP/IGES/BREP
scritti e prova il processo separato del motore (ponte di modeler.py) con il salvataggio e la riapertura del .mbmod.

    python tests/test_modeler.py            (con l'ambiente %USERPROFILE%\\.mbvisual\\venv: serve OCP)
    python tests/test_modeler.py <file.step|.stp|.iges>...   prova in piu' anche l'importazione e la modifica di questi file
"""
import json
import math
import os
import struct
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
TMP = Path(tempfile.mkdtemp(prefix="mbmod-"))
os.environ.setdefault("LOCALAPPDATA", str(TMP / "appdata"))  # mai i dati veri dell'app

from mbvisual import modkernel as K  # noqa: E402

PASS, FAIL = [], []


def check(name, cond, info=""):
    (PASS if cond else FAIL).append(name)
    print(("ok   " if cond else "FAIL ") + name + (f"  [{info}]" if info else ""))


def near(a, b, rel=1e-6, ab=1e-6):
    return abs(a - b) <= max(ab, rel * abs(b))


def rect(x0, y0, x1, y1):
    return [{"t": "l", "a": [x0, y0], "b": [x1, y0]}, {"t": "l", "a": [x1, y0], "b": [x1, y1]},
            {"t": "l", "a": [x1, y1], "b": [x0, y1]}, {"t": "l", "a": [x0, y1], "b": [x0, y0]}]


def ref(body, kind, info):
    r = {"b": body, "k": kind, "t": info["t"], "c": info["c"], "cn": info["cn"]}
    for k in ("n", "d", "r"):
        if info.get(k) is not None:
            r[k] = info[k]
    r["a" if kind == "f" else "l"] = info["a" if kind == "f" else "l"]
    return r


k = K.Kernel(str(TMP / "motore"))
S = k.sess("prova")


def run(doc):
    st, ctx, res = S.evaluate(doc)
    bad = [r for r in res if not r["ok"]]
    return st, ctx, res, bad


def vol(st, b):
    return abs(K._volume(st[b].shape))


# ------------------------------------------------------------------ piastra: estrusione, raccordi, foro, spingi/tira
doc = {"features": [
    {"id": "s1", "type": "sketch", "plane": {"std": "XY"}},
    {"id": "e1", "type": "extrude", "sketch": "s1", "loops": [{"outer": rect(0, 0, 100, 60), "holes": [[{"t": "c", "c": [50, 30], "r": 10}]]}], "d": 30, "op": "new"},
]}
st, ctx, res, bad = run(doc)
check("estrusione con foro", not bad and near(vol(st, "e1"), 100 * 60 * 30 - math.pi * 100 * 30), f"{vol(st, 'e1'):.6f}")
t = K.tessellate(st["e1"])
top = next(f for f in t["faces"] if f["t"] == "plane" and f["n"][2] > 0.9)
bottom = next(f for f in t["faces"] if f["t"] == "plane" and f["n"][2] < -0.9)
check("normale uscente della faccia superiore e inferiore", top["c"][2] > 29 and bottom["c"][2] < 1)
vert = [e for e in t["edges"] if e["t"] == "line" and abs(e["d"][2]) > 0.9 and e["c"][0] in (0, 100)]
check("quattro spigoli verticali esterni", len(vert) == 4, len(vert))
v0 = vol(st, "e1")
doc["features"].append({"id": "f1", "type": "fillet", "edges": [ref("e1", "e", e) for e in vert], "r": 5})
st, ctx, res, bad = run(doc)
check("raccordo r5 su 4 spigoli", not bad and near(v0 - vol(st, "e1"), 4 * (1 - math.pi / 4) * 25 * 30), f"{v0 - vol(st, 'e1'):.6f}")
v1 = vol(st, "e1")
doc["features"].append({"id": "h1", "type": "hole", "face": ref("e1", "f", top), "pts": [[20, 15, 0], [80, 45, 0]], "dia": 8, "through": True})
st, ctx, res, bad = run(doc)
check("due fori passanti d8", not bad and near(v1 - vol(st, "e1"), 2 * math.pi * 16 * 30), f"{v1 - vol(st, 'e1'):.6f}")
v2 = vol(st, "e1")
doc["features"].append({"id": "h2", "type": "hole", "face": ref("e1", "f", top), "pts": [[20, 45, 0]], "dia": 6, "depth": 10, "kind": "cbore", "cbd": 11, "cbh": 4})
st, ctx, res, bad = run(doc)
exp = math.pi * 9 * 10 + math.pi * (5.5 ** 2 - 9) * 4
check("foro lamato cieco", not bad and near(v2 - vol(st, "e1"), exp, 1e-5), f"{v2 - vol(st, 'e1'):.6f} atteso {exp:.6f}")
v3 = vol(st, "e1")
doc["features"].append({"id": "p1", "type": "pushpull", "face": ref("e1", "f", top), "d": 10})
st, ctx, res, bad = run(doc)
top_area = 100 * 60 - math.pi * 100 - 4 * (1 - math.pi / 4) * 25 - 2 * math.pi * 16 - math.pi * 5.5 ** 2
check("spingi/tira +10 della faccia superiore", not bad and near(vol(st, "e1") - v3, top_area * 10, 1e-6), f"{vol(st, 'e1') - v3:.6f} atteso {top_area * 10:.6f}")
bb = K._bbox(st["e1"].shape)
check("ingombro dopo spingi/tira", near(bb[5], 40, ab=0.1) and near(bb[3], 100, ab=0.1), bb)

# ricalcolo: altezza 30 -> 50, i riferimenti (raccordi, fori, faccia spinta) seguono
doc["features"][1]["d"] = 50
t0 = time.time()
st, ctx, res, bad = run(doc)
check("ricalcolo con altezza cambiata: riferimenti ritrovati", not bad, [b["err"] for b in bad])
check("ricalcolo: +20 mm di altezza", near(vol(st, "e1") - (v3 + top_area * 10), (100 * 60 - math.pi * 100 - 4 * (1 - math.pi / 4) * 25 - 2 * math.pi * 16) * 20, 1e-6),
      f"{time.time() - t0:.2f} s")
# lavorazione sospesa
doc["features"][3]["off"] = True
st, ctx, res, bad = run(doc)
check("foro sospeso", not bad and vol(st, "e1") > v3)
doc["features"][3].pop("off")

# ------------------------------------------------------------------ guscio, smusso, elimina faccia, booleane, trasformazioni
d2 = {"features": [
    {"id": "b1", "type": "primitive", "shape": "box", "p": [0, 0, 0], "dx": 40, "dy": 40, "dz": 40, "op": "new"},
]}
st, _c, _r, bad = run(d2)
tb = K.tessellate(st["b1"])
topb = next(f for f in tb["faces"] if f["t"] == "plane" and f["n"][2] > 0.9)
d2["features"].append({"id": "sh", "type": "shell", "body": "b1", "faces": [ref("b1", "f", topb)], "t": 2})
st, _c, _r, bad = run(d2)
check("guscio spessore 2", not bad and near(vol(st, "b1"), 64000 - 36 * 36 * 38), vol(st, "b1"))
d2["features"].append({"id": "c1", "type": "primitive", "shape": "cyl", "p": [20, 20, -5], "r": 5, "h": 60, "op": "new"})
d2["features"].append({"id": "bo", "type": "boolean", "op": "cut", "a": "b1", "b": ["c1"]})
st, _c, _r, bad = run(d2)
check("booleana sottrazione (fondo forato)", not bad and near(vol(st, "b1"), 64000 - 36 * 36 * 38 - math.pi * 25 * 2) and "c1" not in st)
cylf = next(f for f in K.tessellate(st["b1"])["faces"] if f["t"] == "cyl")
d2["features"].append({"id": "df", "type": "delface", "faces": [ref("b1", "f", cylf)]})
st, _c, _r, bad = run(d2)
check("elimina faccia: foro richiuso", not bad and near(vol(st, "b1"), 64000 - 36 * 36 * 38), vol(st, "b1"))
d2["features"].append({"id": "tr", "type": "transform", "bodies": ["b1"], "tf": {"k": "move", "v": [100, 0, 0]}, "copy": True})
d2["features"].append({"id": "ro", "type": "transform", "bodies": ["tr:0"], "tf": {"k": "rotate", "o": [120, 20, 0], "d": [0, 0, 1], "ang": 45}})
d2["features"].append({"id": "sc", "type": "transform", "bodies": ["tr:0"], "tf": {"k": "scale", "c": [120, 20, 0], "f": 0.5}})
d2["features"].append({"id": "mi", "type": "transform", "bodies": ["b1"], "tf": {"k": "mirror", "o": [0, 0, 0], "n": [1, 0, 0]}, "copy": True})
st, _c, _r, bad = run(d2)
check("copia, rotazione, scala", not bad and near(vol(st, "tr:0"), (64000 - 36 * 36 * 38) / 8), vol(st, "tr:0"))
bbm = K._bbox(st["mi:0"].shape)
check("simmetria rispetto a YZ", near(bbm[0], -40, ab=0.05) and near(bbm[3], 0, ab=0.05), bbm)
d2["features"].append({"id": "pl", "type": "pattern", "bodies": ["b1"], "kind": "linear", "d": [0, 1, 0], "n": 3, "s": 50, "d2": [0, 0, 1], "n2": 2, "s2": 50})
d2["features"].append({"id": "pc", "type": "pattern", "bodies": ["mi:0"], "kind": "circular", "o": [0, 0, 0], "ax": [0, 0, 1], "n": 4, "ang": 360})
st, _c, _r, bad = run(d2)
check("serie lineare 3x2 e circolare 4", not bad and sum(1 for b in st if b.startswith("pl:")) == 5 and sum(1 for b in st if b.startswith("pc:")) == 3)
d2["features"].append({"id": "sp", "type": "split", "bodies": ["b1"], "o": [0, 0, 20], "n": [0, 0, 1]})
st, _c, _r, bad = run(d2)
check("dividi con un piano", not bad and near(vol(st, "b1") + vol(st, "sp:b1"), 64000 - 36 * 36 * 38))
# chamfer su un cubo nuovo
d3 = {"features": [{"id": "b", "type": "primitive", "shape": "box", "p": [0, 0, 0], "dx": 10, "dy": 10, "dz": 10, "op": "new"}]}
st, _c, _r, bad = run(d3)
e0 = next(e for e in K.tessellate(st["b"])["edges"] if e["t"] == "line")
d3["features"].append({"id": "ch", "type": "chamfer", "edges": [ref("b", "e", e0)], "d": 2})
st, _c, _r, bad = run(d3)
check("smusso 2 mm", not bad and near(vol(st, "b"), 1000 - 2 * 10), vol(st, "b"))
d3["features"].append({"id": "x", "type": "fillet", "edges": [ref("b", "e", e0)], "r": 50})
st, _c, res3, bad = run(d3)
check("raccordo impossibile: errore chiaro, il resto continua", bad and bad[0]["err"] in ("srv_modeler.raccordo_fallito", "srv_modeler.riferimento_perso") and "b" in st, bad)

# ------------------------------------------------------------------ rivoluzione e accoppiamento
d4 = {"features": [
    {"id": "s", "type": "sketch", "plane": {"std": "XZ"}},
    {"id": "r", "type": "revolve", "sketch": "s", "loops": [{"outer": rect(20, 0, 30, 40)}], "axis": [[0, 0], [0, 50]], "ang": 360, "op": "new"},
    {"id": "p", "type": "primitive", "shape": "cyl", "p": [100, 0, 0], "r": 3, "h": 5, "op": "new"},
]}
st, _c, _r, bad = run(d4)
check("rivoluzione 360 (tubo)", not bad and near(vol(st, "r"), math.pi * (900 - 400) * 40), vol(st, "r"))
tr_ = K.tessellate(st["r"])
check("rivoluzione: solido orientato (volume positivo)", K._volume(st["r"].shape) > 0)
rt = next(f for f in tr_["faces"] if f["t"] == "plane" and f["n"][2] > 0.9)
pb = next(f for f in K.tessellate(st["p"])["faces"] if f["t"] == "plane" and f["n"][2] < -0.9)
d4["features"].append({"id": "m", "type": "mate", "move": "p", "a": ref("p", "f", pb), "b": ref("r", "f", rt), "kind": "coinc", "off": 0})
st, _c, _r, bad = run(d4)
check("accoppiamento facce a contatto", not bad and near(K._bbox(st["p"].shape)[2], 40, ab=0.05), K._bbox(st["p"].shape))
cyl_axis = next(f for f in K.tessellate(st["p"])["faces"] if f["t"] == "cyl")
inner = next(f for f in K.tessellate(st["r"])["faces"] if f["t"] == "cyl" and abs(f["r"] - 20) < 1e-6)
d4["features"].append({"id": "m2", "type": "mate", "move": "p", "a": ref("p", "f", cyl_axis), "b": ref("r", "f", inner), "kind": "conc"})
st, _c, _r, bad = run(d4)
bbp = K._bbox(st["p"].shape)
check("accoppiamento assi concentrici (senza capovolgere)", not bad and near((bbp[0] + bbp[3]) / 2, 0, ab=0.05) and near((bbp[1] + bbp[4]) / 2, 0, ab=0.05) and near(bbp[2], 40, ab=0.05), bbp)

# ------------------------------------------------------------------ esportazioni rilette da OpenCascade
looks = {"e1": {"name": "Piastra", "color": "#d04020"}}
out = {}
for fmt in ("step", "iges", "brep", "stl", "obj", "glb"):
    p = str(TMP / f"piastra.{fmt}")
    k.op_export({"sid": "prova", "doc": doc, "path": p, "fmt": fmt, "looks": looks})
    out[fmt] = p
ve = vol(st0 := run(doc)[0], "e1")
items = K._read_cad(out["step"])
check("STEP riletto: nome, colore e volume", len(items) == 1 and items[0][1] == "Piastra" and items[0][2] == "#d04020" and near(abs(K._volume(items[0][0])), ve, 1e-7),
      f"{items[0][1]} {items[0][2]} {abs(K._volume(items[0][0])):.4f} / {ve:.4f}")
items = K._read_cad(out["iges"])
check("IGES riletto: volume", len(items) == 1 and near(abs(K._volume(items[0][0])), ve, 1e-5), abs(K._volume(items[0][0])))
items = K._read_cad(out["brep"])
check("BREP riletto: volume", near(abs(K._volume(items[0][0])), ve, 1e-9))
d = open(out["stl"], "rb").read()
n = struct.unpack_from("<I", d, 80)[0]
import numpy as np  # noqa: E402
rec = np.frombuffer(d, dtype=[("n", "<f4", 3), ("a", "<f4", 3), ("b", "<f4", 3), ("c", "<f4", 3), ("x", "<u2")], count=n, offset=84)
vs = float(np.einsum("ij,ij->i", rec["a"].astype(float), np.cross(rec["b"].astype(float), rec["c"].astype(float))).sum() / 6)
check("STL: volume entro lo 0,5%", abs(vs - ve) / ve < 0.005, f"{vs:.1f} / {ve:.1f}")
check("OBJ e GLB scritti", os.path.getsize(out["obj"]) > 1000 and open(out["glb"], "rb").read(4) == b"glTF")

# ------------------------------------------------------------------ importazione: STEP scritto sopra + mesh
r = k.op_import({"files": [{"path": out["step"]}]})
d5 = {"features": [{"id": "i", "type": "import", "items": r["items"]}]}
st, _c, _r, bad = run(d5)
check("import STEP come corpo", not bad and near(vol(st, "i"), ve, 1e-7))
ti = K.tessellate(st["i"])
big = max((f for f in ti["faces"] if f["t"] == "plane"), key=lambda f: f["a"])
d5["features"].append({"id": "pp", "type": "pushpull", "face": ref("i", "f", big), "d": 1})
st, _c, _r, bad = run(d5)
check("modifica del modello importato (spingi/tira)", not bad and vol(st, "i") > ve)
# mesh: cubo di 12 triangoli -> solido
v = np.array([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]], np.float32)
f = np.array([[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]], np.uint32)
mp = TMP / "m.tri"
mp.write_bytes(v.tobytes() + f.tobytes())
r = k.op_import_mesh({"path": str(mp), "parts": [{"name": "cubo", "nv": 8, "nt": 12, "ov": 0, "ot": v.nbytes}]})
check("mesh chiusa convertita in solido", r["items"][0]["kind"] == "solid")
d6 = {"features": [{"id": "m", "type": "import", "items": r["items"]},
                   {"id": "c", "type": "primitive", "shape": "cyl", "p": [5, 5, -1], "r": 2, "h": 12, "op": "cut"}]}
st, _c, _r, bad = run(d6)
check("booleana su mesh convertita", not bad and near(vol(st, "m"), 1000 - math.pi * 4 * 10, 1e-6), vol(st, "m"))
r = k.op_import_mesh({"path": str(mp), "parts": [{"name": "cubo", "nv": 8, "nt": 12, "ov": 0, "ot": v.nbytes}], "brep": False})
d7 = {"features": [{"id": "m", "type": "import", "items": r["items"]}, {"id": "t", "type": "transform", "bodies": ["m"], "tf": {"k": "scale", "c": [0, 0, 0], "f": 2}}]}
st, _c, _r, bad = run(d7)
check("mesh lasciata mesh: scala", not bad and st["m"].mesh is not None and near(K.tessellate(st["m"])["props"]["vol"], 8000, 1e-9))

# ------------------------------------------------------------------ file passati sulla riga di comando
for src in sys.argv[1:]:
    t0 = time.time()
    try:
        r = k.op_import({"files": [{"path": src}]})
        dd = {"features": [{"id": "i", "type": "import", "items": r["items"]}]}
        st, _c, _r, bad = run(dd)
        tot = sum(abs(K._volume(b.shape)) for b in st.values() if b.mesh is None)
        check(f"import {Path(src).name}: {len(st)} corpi, volume {tot:.1f}", not bad, f"{time.time() - t0:.1f} s")
    except Exception as e:  # noqa: BLE001
        check(f"import {Path(src).name}", False, e)

# ------------------------------------------------------------------ processo separato (ponte) e file .mbmod
os.environ["TEMP"] = str(TMP)
from mbvisual import modeler  # noqa: E402
modeler.DATA = TMP / "ponte"
modeler.BLOB = modeler.DATA / "blob"
modeler.OUT = modeler.DATA / "uscite"
t0 = time.time()
data = modeler.regen("s1", doc)
n = struct.unpack_from("<I", data, 0)[0]
meta = json.loads(data[4:4 + n])
check("motore in processo separato: ricalcolo", all(f["ok"] for f in meta["features"]) and meta["bodies"][0]["props"]["vol"] > 0, f"{time.time() - t0:.1f} s compreso l'avvio")
mb = str(TMP / "pezzo.mbmod")
modeler.save_doc(mb, {"features": doc["features"], "params": [], "looks": looks}, "s1", cdoc=doc, looks=looks)
import zipfile  # noqa: E402
names = zipfile.ZipFile(mb).namelist()
check(".mbmod con documento e anteprima", "document.json" in names and "anteprima.glb" in names, names)
back = modeler.open_doc(mb)["doc"]
check(".mbmod riaperto uguale", back["features"] == doc["features"])
modeler.stop()

print(f"\n{len(PASS)} riuscite, {len(FAIL)} fallite")
if FAIL:
    print("fallite:", ", ".join(FAIL))
sys.exit(1 if FAIL else 0)
