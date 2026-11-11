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

# ------------------------------------------------------------------ impianti: tubazioni, canaline, condotte
pts = [[0, 0, 0], [1000, 0, 0], [1000, 800, 0], [1000, 800, 600], [300, 800, 600]]
d8 = {"features": [{"id": "p", "type": "route", "kind": "pipe", "pts": pts, "od": 114.3, "t": 6.02, "r": 152.4, "op": "new"}]}
st, _c, _r, bad = run(d8)
m = st["p"].meta if not bad else {}
L = 1000 + 800 + 600 + 700 - 6 * 152.4 + 3 * math.pi / 2 * 152.4
A = math.pi * (57.15 ** 2 - (57.15 - 6.02) ** 2)
check("tubazione DN100 con 3 curve: lunghezza sull'asse", not bad and near(m["lunghezza"], L, 1e-6) and m["curve"] == [90.0, 90.0, 90.0], m.get("lunghezza"))
check("tubazione: volume = sezione x lunghezza (Pappo)", not bad and near(vol(st, "p"), A * L, 1e-6), f"{vol(st, 'p'):.1f} / {A * L:.1f}")
# dritti e curve sono pezzi separati (come nella realta' e per booleane affidabili): 4 dritti + 3 curve, tutti validi
check("tubazione: 7 pezzi validi (4 dritti e 3 curve)", not bad and K._count(st["p"].shape, K.TopAbs_SOLID) == 7 and K._check(st["p"].shape), K._count(st["p"].shape, K.TopAbs_SOLID) if not bad else bad)
for kind, extra in (("tray", {"w": 300, "h": 60, "t": 1.5, "r": 300}), ("ductr", {"w": 400, "h": 250, "t": 0.8, "r": 300}), ("duct", {"od": 250, "t": 0.6, "r": 250})):
    st, _c, _r, bad = run({"features": [{"id": "x", "type": "route", "kind": kind, "pts": pts, "op": "new", **extra}]})
    check(f"{kind}: solido valido lungo il percorso", not bad and K._count(st["x"].shape, K.TopAbs_SOLID) == (7 if kind == "duct" else 6) and K._check(st["x"].shape) and vol(st, "x") > 0,
          bad and bad[0].get("err"))
# canalina: fondo verso il basso sui tratti orizzontali (ingombro z da 0 a h)
st, _c, _r, bad = run({"features": [{"id": "c", "type": "route", "kind": "tray", "pts": [[0, 0, 0], [1000, 0, 0], [1000, 900, 0]], "w": 300, "h": 60, "t": 1.5, "r": 300, "op": "new"}]})
bb = K._bbox(st["c"].shape)
check("canalina orizzontale: fondo a quota 0, sponde fino a 60", not bad and near(bb[2], 0, ab=0.01) and near(bb[5], 60, ab=0.01), bb)
sec = 300 * 1.5 + 2 * (60 - 1.5) * 1.5
check("canalina: volume = sezione x (dritti + curva sull'asse)", near(vol(st, "c"), sec * (1300 + math.pi / 2 * 300), 1e-6), f"{vol(st, 'c'):.1f} / {sec * (1300 + math.pi / 2 * 300):.1f}")
# raggio troppo grande per un tratto corto: errore chiaro
st, _c, _r, bad = run({"features": [{"id": "e", "type": "route", "kind": "pipe", "pts": [[0, 0, 0], [100, 0, 0], [100, 100, 0]], "od": 60.3, "t": 3.91, "r": 300, "op": "new"}]})
check("raggio troppo grande: errore 'curva_troppo_grande'", bad and bad[0]["err"] == "srv_modeler.curva_troppo_grande", bad)
# valvola e flange sulla tubazione: seguono il percorso (anche dopo uno spostamento) e non contano come interferenza
d9 = {"features": [{"id": "p", "type": "route", "kind": "pipe", "pts": [[0, 0, 0], [2000, 0, 0], [2000, 1000, 0]], "od": 114.3, "t": 6.02, "r": 152.4, "size": "DN100", "op": "new"},
                   {"id": "v", "type": "fitting", "route": "p", "kind": "valve", "at": [800, 50, 0]},
                   {"id": "fl", "type": "fitting", "route": "p", "kind": "flanges", "at": [2000, 600, 30]},
                   {"id": "b", "type": "primitive", "shape": "box", "p": [1200, -300, -300], "dx": 100, "dy": 600, "dz": 600, "op": "new"}]}
st, _c, _r, bad = run(d9)
bbv = K._bbox(st["v"].shape) if not bad else [0] * 6
check("valvola DN100 sull'asse della tubazione (x=800, y=0)", not bad and near((bbv[0] + bbv[3]) / 2, 800, ab=0.5) and abs((bbv[1] + bbv[4]) / 2) < 1 and st["v"].meta["misura"] == "DN100", bbv)
bbf = K._bbox(st["fl"].shape) if not bad else [0] * 6
check("coppia di flange sul tratto lungo Y (x=2000, y=600)", not bad and near((bbf[0] + bbf[3]) / 2, 2000, ab=0.5) and near((bbf[1] + bbf[4]) / 2, 600, ab=0.5) and near(bbf[3] - bbf[0], 220, ab=0.5), bbf)
cl = k.op_clash({"sid": "prova", "doc": d9})["clash"]
check("interferenze: solo il blocco attraversato dal tubo (valvola e flange escluse)", len(cl) == 1 and {cl[0]["a"], cl[0]["b"]} == {"p", "b"}
      and near(cl[0]["vol"], math.pi * (57.15 ** 2 - (57.15 - 6.02) ** 2) * 100, 1e-5), cl)
# tubazione con curve, valvola, flange e blocco in DXF: veri solidi di AutoCAD (3DSOLID), tubo e curve con superfici esatte
import ezdxf  # noqa: E402
from mbvisual import acis as _acis  # noqa: E402
pd = str(TMP / "impianto.dxf")
rx = k.op_export({"sid": "prova", "doc": d9, "path": pd, "fmt": "dxf", "looks": {"p": {"name": "Linea 100", "color": "#3080c0"}}})
dd = ezdxf.readfile(pd)
sols = dd.modelspace().query("3DSOLID")
kinds = set()
for e in sols:
    kinds |= {r.type for r in _acis.parse_sat(chr(10).join(e.sat))[1]}
check("DXF dal modellatore: 3DSOLID su layer per corpo, tubo e curve con cilindri e tori esatti", rx["esatti"] >= 4 and len(sols) == rx["esatti"] + rx["a_facce"]
      and "Linea 100" in {e.dxf.layer for e in sols} and {"cone-surface", "torus-surface", "ellipse-curve"} <= kinds, (rx, sorted(kinds)))
d9["features"].insert(1, {"id": "mv", "type": "transform", "bodies": ["p"], "tf": {"k": "move", "v": [0, 0, 500]}})
st, _c, _r, bad = run(d9)
bbv = K._bbox(st["v"].shape) if not bad else [0] * 6
check("tubazione spostata: la valvola la segue (asse a quota 500)", not bad and near(st["v"].meta["pos"][2], 500, ab=0.01) and bbv[2] > 300, (bbv, st["v"].meta["pos"] if not bad else None))

# staffaggi: a pavimento sotto una tubazione DN100 a quota 1000 (tratti orizzontali 5000 e 3000, passo 4800), pendini a soffitto
d10 = {"features": [{"id": "p", "type": "route", "kind": "pipe", "pts": [[0, 0, 1000], [5000, 0, 1000], [5000, 3000, 1000], [5000, 3000, 2000]],
                     "od": 114.3, "t": 6.02, "r": 152.4, "size": "DN100", "op": "new"},
                    {"id": "s", "type": "supports", "route": "p", "kind": "floor", "z": 0},
                    {"id": "h", "type": "supports", "route": "p", "kind": "hanger", "z": 3000, "span": 1000}]}
st, _c, _r, bad = run(d10)
ms = st["s"].meta if not bad else {}
pos = K.support_positions(st["p"].meta, 4800) if not bad else []
check("staffe a pavimento: 2 + 2 sui due tratti orizzontali (verticale escluso), altezza = fondo del tubo",
      not bad and ms.get("quantita") == 4 and all(near(x, 1000 - 57.15, ab=0.2) for x in ms.get("altezze", [])) and len(pos) == 4, (bad, ms.get("quantita"), ms.get("altezze")))
bbs = K._bbox(st["s"].shape) if not bad else [0] * 6
check("staffe a pavimento: da quota 0 al fondo del tubo", not bad and near(bbs[2], 0, ab=0.01) and near(bbs[5], 1000 - 57.15, ab=0.5), bbs)
mh = st["h"].meta if not bad else {}
check("pendini con passo 1000: 6 + 4 supporti", not bad and mh.get("quantita") == 10, mh.get("quantita"))
cl = k.op_clash({"sid": "prova", "doc": d10})["clash"]
check("staffe sulla propria tubazione: nessuna interferenza con il tubo", not [c for c in cl if "p" in (c["a"], c["b"])], cl)
st, _c, _r, bad = run({"features": [d10["features"][0], {"id": "x", "type": "supports", "route": "p", "kind": "floor", "z": 2000}]})
check("staffe sopra la tubazione: errore 'quota_staffe'", bad and bad[0]["err"] == "srv_modeler.quota_staffe", bad)

# rilievi dei Saggi (11/11/2026)
# pendino: la barra non attraversa il tubo (nessun volume comune tra pendini e lume del tubo)
st, _c, _r, bad = run({"features": [d10["features"][0], {"id": "h", "type": "supports", "route": "p", "kind": "hanger", "z": 3000, "span": 1000}]})
inner = K.BRepPrimAPI_MakeCylinder(K.gp_Ax2(K._p([0, 0, 1000]), K._d([1, 0, 0])), 57.15, 5000).Shape()
com = K._bool("common", st["h"].shape, inner) if not bad else None
check("pendini: la barra filettata parte dal collare e non attraversa il tubo", not bad and (K._empty(com) or abs(K._volume(com)) < 1), abs(K._volume(com)) if com is not None and not K._empty(com) else 0)
# tubazione in pendenza del 2%: staffe costruite (terna ortonormale) e posizioni = staffe costruite
st, _c, _r, bad = run({"features": [{"id": "p", "type": "route", "kind": "pipe", "pts": [[0, 0, 1000], [3000, 0, 1060]], "od": 114.3, "t": 6.02, "size": "DN100", "op": "new"},
                                   {"id": "s", "type": "supports", "route": "p", "kind": "floor", "z": 0}]})
check("staffe su tratto in pendenza 2%: costruite, posizioni uguali al numero di staffe", not bad and st["s"].meta["quantita"] == len(st["s"].meta["pos"]) >= 2, bad or st["s"].meta)
# raggio predefinito delle curve: 1,5 x NPS (DN80 -> 114,3 mm; DN100 -> 152,4 mm)
check("raggio delle curve EN 10253 3D: DN80 114,3, DN100 152,4, DN200 304,8", K.bend_radius("DN80", 88.9) == 114.3 and K.bend_radius("DN100", 114.3) == 152.4 and K.bend_radius("DN200", 219.1) == 304.8)
# flange PN40 e scartamento della valvola EN 558 serie 14
check("flange EN 1092-1: DN80 PN40 D=200 (come PN16), DN200 PN40 D=375 b=34", K.flange_dims(80, 88.9, 40) == (200, 24) and K.flange_dims(200, 219.1, 40) == (375, 34))
d12 = {"features": [{"id": "p", "type": "route", "kind": "pipe", "pts": [[0, 0, 0], [2000, 0, 0], [2000, 1000, 0]], "od": 114.3, "t": 6.02, "r": 152.4, "size": "DN100", "op": "new"},
                    {"id": "v", "type": "fitting", "route": "p", "kind": "valve", "at": [800, 0, 0]}]}
st, _c, _r, bad = run(d12)
bbv = K._bbox(st["v"].shape) if not bad else [0] * 6
check("valvola DN100: scartamento 190 mm (EN 558 serie 14), foro di passaggio, dati di classe", not bad and 190 <= bbv[3] - bbv[0] <= 202
      and st["v"].meta["lunghezza_fs"] == 190 and "pn" in st["v"].meta, bbv)
pipe_in = K.BRepPrimAPI_MakeCylinder(K.gp_Ax2(K._p([0, 0, 0]), K._d([1, 0, 0])), 57.15 - 6.02, 2000).Shape()
com = K._bool("common", st["v"].shape, pipe_in) if not bad else None
check("valvola: nessun materiale dentro il passaggio del tubo", com is not None and (K._empty(com) or abs(K._volume(com)) < 1))
# valvola su una curva o su un tratto troppo corto: errore chiaro
st, _c, _r, bad = run({"features": [d12["features"][0], {"id": "v", "type": "fitting", "route": "p", "kind": "valve", "at": [1990, 10, 0]}]})
check("valvola troppo vicina alla curva: errore 'tratto_corto'", bad and bad[0]["err"] == "srv_modeler.tratto_corto", bad)
# spostamento della tubazione DOPO valvola e staffe: tutto segue se si spostano insieme (come fa la maniglia)
d13 = {"features": d12["features"] + [{"id": "s", "type": "supports", "route": "p", "kind": "floor", "z": -1000},
                                      {"id": "m", "type": "transform", "bodies": ["p", "v", "s"], "tf": {"k": "move", "v": [0, 500, 0]}}]}
st, _c, _r, bad = run(d13)
check("spostamento dopo valvola e staffe: posizioni nei dati spostate di 500", not bad and near(st["v"].meta["pos"][1], 500, ab=0.01)
      and all(near(q[1], 500, ab=0.01) for q in st["s"].meta["pos"][:2]), bad)
# scala su una tubazione: rifiutata
st, _c, _r, bad = run({"features": [d12["features"][0], {"id": "k", "type": "transform", "bodies": ["p"], "tf": {"k": "scale", "f": 2, "c": [0, 0, 0]}}]})
check("scala di una tubazione: errore 'scala_impianto'", bad and bad[0]["err"] == "srv_modeler.scala_impianto", bad)
# spessore non valido: errore invece di un cilindro pieno
st, _c, _r, bad = run({"features": [{"id": "p", "type": "route", "kind": "pipe", "pts": [[0, 0, 0], [500, 0, 0]], "od": 114.3, "t": 70, "op": "new"}]})
check("tubo con spessore oltre il raggio: errore", bad and bad[0]["err"] == "srv_modeler.dimensioni_non_valide", bad)
# passo delle staffe per materiale: PVC d63 1000 mm, rame 22 1800 mm, acciaio DN50 3600
check("passo staffe per materiale: PVC d63 1000, rame 22 1800, acciaio DN50 3600",
      K._span_for({"impianto": "pipe", "od": 63, "famiglia": "plastic"}) == 1000 and K._span_for({"impianto": "pipe", "od": 22, "famiglia": "copper", "misura": "Cu22"}) == 1800
      and K._span_for({"impianto": "pipe", "od": 60.3, "misura": "DN50", "t": 3.91}) == 3600)

# diramazioni a T e riduzioni: il ramo parte dall'asse della madre (ricalcolato), Tee ridotto EN 10253, riduzione eccentrica a fondo piano
P = {"id": "p", "type": "route", "kind": "pipe", "pts": [[0, 0, 1000], [4000, 0, 1000]], "od": 114.3, "t": 6.02, "size": "DN100", "op": "new", "linea": "100-A1-010"}
B = {"id": "b", "type": "route", "kind": "pipe", "pts": [[2000, 30, 1000], [2000, 1500, 1000], [2000, 1500, 0]], "od": 60.3, "t": 3.91, "size": "DN50", "op": "new",
     "linea": "100-A1-010", "start": {"route": "p", "mode": "tee", "at": [2000, 0, 1000]}}
R = {"id": "c", "type": "route", "kind": "pipe", "pts": [[4000, 0, 1000], [6000, 0, 1000]], "od": 60.3, "t": 3.91, "size": "DN50", "op": "new",
     "linea": "100-A1-010", "start": {"route": "p", "mode": "end", "at": [4000, 0, 1000], "ecc": True}}
d14 = {"features": [P, B, R]}
st, _c, _r, bad = run(d14)
tee, red = st.get("b:rac"), st.get("c:rac")
check("diramazione: parte dall'asse della madre, primo tratto accorciato del Tee (M=94 = 104,8 - 0,2 x 54)", not bad and st["b"].meta["nodi"][0] == [2000.0, 0.0, 1000.0]
      and near(st["b"].meta["dritti"][0], 1500 - 94.0 - 76.2, ab=0.05), bad or st["b"].meta["dritti"])
check("Tee ridotto DN100xDN50: corpo valido montato sulla madre, scartamento 2C in distinta", tee is not None and tee.meta["componente"] == "tee_rid"
      and tee.meta["su"] == "p" and near(tee.meta["lunghezza_fs"], 209.6, ab=0.05) and K._check(tee.shape) and K._volume(tee.shape) > 0, tee and tee.meta)
bbr = K._bbox(red.shape) if red is not None else [0] * 6
check("riduzione eccentrica DN100xDN50: lunghezza 102, fondo piano (generatrice inferiore a quota 942,85)", red is not None and red.meta["componente"] == "riduzione_ecc"
      and near(bbr[3] - bbr[0], 102, ab=0.2) and near(bbr[2], 1000 - 57.15, ab=0.2) and near(st["c"].meta["dritti"][0], 2000 - 102, ab=0.05), bbr)
cl = k.op_clash({"sid": "prova", "doc": d14})["clash"]
check("diramazione e riduzione: nessuna interferenza fasulla", not cl, cl)
# la madre si sposta (nodi): la diramazione la segue
d15 = {"features": [dict(P, pts=[[0, 200, 1000], [4000, 200, 1000]]), B, R]}
st, _c, _r, bad = run(d15)
check("madre spostata di 200 in Y: ramo e riduzione la seguono per intero", not bad and st["b"].meta["nodi"][0] == [2000.0, 200.0, 1000.0] and st["b"].meta["nodi"][-1] == [2000.0, 1700.0, 0.0]
      and st["c"].meta["nodi"] == [[4000.0, 200.0, 1000.0], [6000.0, 200.0, 1000.0]], bad or (st["b"].meta["nodi"], st["c"].meta["nodi"]))
# ramo non perpendicolare o piu' grande della madre: errori chiari
st, _c, _r, bad = run({"features": [P, dict(B, pts=[[2000, 30, 1000], [3000, 1000, 1000]])]})
check("ramo non perpendicolare: errore 'ramo_perpendicolare'", bad and bad[0]["err"] == "srv_modeler.ramo_perpendicolare", bad)
st, _c, _r, bad = run({"features": [P, dict(R, pts=[[4000, 0, 1000], [4000, 2000, 1000]])]})
check("prosecuzione che non va dritta: errore 'continua_in_linea'", bad and bad[0]["err"] == "srv_modeler.continua_in_linea", bad)
# isometrico: le tre tubazioni con lo stesso numero di linea su un solo foglio
st, _c, _r, bad = run(d14)
iso2 = {"nome": "rami", "linee": []}
for rid in ("p", "b", "c"):
    m = st[rid].meta
    L = {"id": rid, "linea": m["linea"], "misura": m["misura"], "materiale": "", "pn": 16, "raggio": m["raggio"], "lunghezza": m["lunghezza"], "dritti": m["dritti"],
         "nodi": m["nodi"], "componenti": [], "supporti": [], "ramo": bool(m.get("inizio"))}
    for bid, b in st.items():
        q = b.meta or {}
        if q.get("su") == rid and q.get("pos") and not str(q.get("componente")).startswith("support_"):
            L["componenti"].append({"tipo": q["componente"], "pos": q["pos"], "lunghezza_fs": q["lunghezza_fs"], "misura": q["misura"]})
    iso2["linee"].append(L)
ip2 = str(TMP / "iso_rami.pdf")
r2 = modiso.make(ip2, iso2, "pdf") if "modiso" in dir() else None
# isometrici: un foglio per linea, quote vere tra i nodi, simboli e distinta; PDF e DXF
from mbvisual import modiso  # noqa: E402
d11 = {"features": d10["features"] + [{"id": "v", "type": "fitting", "route": "p", "kind": "valve", "at": [2000, 0, 1000]},
                                      {"id": "q", "type": "route", "kind": "pipe", "pts": [[0, 1000, 500], [0, 2500, 500]], "od": 60.3, "t": 3.91, "r": 90,
                                       "size": "DN50", "op": "new", "linea": "050-A1-002", "spec": "A1", "pn": 16, "mat": "P235GH"}]}
st, _c, _r, bad = run(d11)
iso = {"nome": "prova", "linee": []}
for rid in ("p", "q"):
    m = st[rid].meta
    L = {"id": rid, "linea": m.get("linea") or "", "misura": m["misura"], "spec": m.get("spec") or "", "materiale": m.get("materiale") or "", "pn": m.get("pn"),
         "raggio": m["raggio"], "lunghezza": m["lunghezza"], "dritti": m["dritti"], "nodi": m["nodi"], "componenti": [], "supporti": []}
    for bid, b in st.items():
        q = b.meta or {}
        if q.get("su") != rid:
            continue
        if str(q.get("componente")).startswith("support_"):
            L["supporti"] += [{"tipo": q["componente"][8:], "pos": p} for p in q["pos"]]
        else:
            L["componenti"].append({"tipo": q["componente"], "pos": q["pos"], "lunghezza_fs": q["lunghezza_fs"]})
    iso["linee"].append(L)
ip = str(TMP / "iso.pdf")
modiso.make(ip, iso, "pdf")
import fitz  # noqa: E402
pd = fitz.open(ip)
txt = pd[0].get_text()
check("isometrico PDF: 2 fogli, quote 5000/3000/1000, quota EL +1000, 14 supporti, tubo netto 8,20 m (dritti meno la valvola)",
      pd.page_count == 2 and all(x in txt for x in ("5000", "3000", "1000", "EL +1000", "S14", "8.20 m")) and "050-A1-002" in pd[1].get_text(), txt[:300])
pd[0].get_pixmap(dpi=110).save(str(TMP / "iso.png"))
print("   isometrico:", TMP / "iso.png")
pd.close()
xp = str(TMP / "iso.dxf")
modiso.make(xp, iso, "dxf")
import ezdxf  # noqa: E402
dx = ezdxf.readfile(xp)
tx = [e.dxf.text for e in dx.modelspace().query("TEXT")]
r2 = modiso.make(ip2, iso2, "pdf")
pd2 = fitz.open(ip2)
tx2 = pd2[0].get_text()
check("isometrico di una linea con diramazione e riduzione: un foglio, tubi DN100 e DN50 netti, Tee e riduzione in distinta",
      r2["fogli"] == 1 and "100-A1-010" in tx2 and "DN100" in tx2 and "DN50" in tx2 and ("Tee" in tx2 or "tee" in tx2.lower()), tx2[:400])
pd2[0].get_pixmap(dpi=110).save(str(TMP / "iso_rami.png"))
print("   isometrico con diramazione:", TMP / "iso_rami.png")
pd2.close()
check("isometrico DXF: testi delle quote e linee del tubo", "5000" in tx and "EL +1000" in tx and len(dx.modelspace().query("LINE[layer=='ISO-TUBO']")) == 4, len(tx))

# percorso da schizzo (punti 2D sul piano XZ) e spostamento: i dati d'impianto restano
st, _c, _r, bad = run({"features": [{"id": "s", "type": "sketch", "plane": {"std": "XZ"}},
                                   {"id": "q", "type": "route", "kind": "pipe", "sketch": "s", "pts2": [[0, 0], [500, 0], [500, 400]], "od": 60.3, "t": 3.91, "r": 90, "op": "new"},
                                   {"id": "m", "type": "transform", "bodies": ["q"], "tf": {"k": "move", "v": [0, 200, 0]}}]})
bb = K._bbox(st["q"].shape)
check("tubazione da schizzo XZ (verticale) e spostata: dati conservati", not bad and near(bb[5], 400, ab=0.1) and st["q"].meta and near(st["q"].meta["lunghezza"], 900 - 180 + math.pi / 2 * 90, 1e-6), bb)

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
