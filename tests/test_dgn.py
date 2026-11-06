"""MicroStation DGN V7 (mbvisual/dgn.py). Uso: python tests/test_dgn.py <cartella>
La cartella deve contenere smalltest.dgn (GDAL autotest/ogr/data/dgn, MIT) e, se presente, test_dgnv8.dgn (autotest/ogr/data/dgnv8):
valori attesi = quelli che legge GDAL (dgnlib). Altri file <nome>.dgn con <nome>.ref.json (punti letti da GDAL) si confrontano punto per punto."""
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from mbvisual import dgn  # noqa: E402

d = sys.argv[1]
ok = bad = 0


def check(c, m):
    global ok, bad
    if c:
        ok += 1
    else:
        bad += 1
        print("NO", m)


D = dgn.read(os.path.join(d, "smalltest.dgn"))
E = D["elements"]
check([e["t"] for e in E] == [17, 15, 6, 3], "tipi degli elementi come GDAL")
check(E[0]["txt"] == "Demo Text" and abs(E[0]["p"][0][0] - 0.7365) < 1e-9 and abs(E[0]["p"][0][1] - 4.2198) < 1e-9, "testo e posizione")
check(abs(E[1]["c0"][0] + E[1]["a1"] - 9.68780658389143) < 1e-9 and abs(E[1]["c0"][1] - 4.5835) < 1e-9, "cerchio: centro e raggio")
check(E[2]["c"] == 83 and [tuple(round(c, 4) for c in p[:2]) for p in E[2]["p"]] == [(4.5355, 3.317), (4.3832, 2.6517), (4.9441, 2.5235), (4.832, 3.3331)], "forma")
check([tuple(round(c, 4) for c in p[:2]) for p in E[3]["p"]] == [(2.5562, 5.7218), (2.5242, 6.0709)], "linea")
r = dgn.to_dxf(os.path.join(d, "smalltest.dgn"))
import ezdxf  # noqa: E402
doc = ezdxf.readfile(r["path"])
check(sorted(e.dxftype() for e in doc.modelspace()) == ["CIRCLE", "LINE", "LWPOLYLINE", "TEXT"], "DXF scritto")
v8 = os.path.join(d, "test_dgnv8.dgn")
if os.path.exists(v8):
    try:
        dgn.read(v8)
        check(False, "V8 rifiutato")
    except dgn.DgnError:
        check(True, "")
for f in sorted(os.listdir(d)):
    if not f.endswith(".ref.json"):
        continue
    D = dgn.read(os.path.join(d, f[:-9] + ".dgn"))
    k = 3 if D["dim"] == 3 else 2
    ours = {tuple(round(c, 6) for c in p[:k]) for e in D["elements"] for p in e.get("p", [])}
    ref = set()
    for rec in json.load(open(os.path.join(d, f))):
        nums = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?(?:e-?\d+)?", rec["geom"] or "")]
        ref |= {tuple(round(c, 6) for c in nums[i:i + k]) for i in range(0, len(nums), k)}
    check(ours == ref, f"{f}: punti uguali a GDAL ({len(ref)})")
print(f"{ok} prove riuscite, {bad} fallite")
sys.exit(1 if bad else 0)
