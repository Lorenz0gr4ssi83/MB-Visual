"""Collaudo della copia di visualizzazione degli assiemi SolidWorks (mbvisual/swtess.py).

    python tests/test_swtess.py [assieme.SLDASM] [--immagine cartella]

Sempre: prove sintetiche (strisce di triangoli, directory e blocco scritti come quelli di SolidWorks, GLB riletto).
Con un assieme vero (argomento, variabile MBV_SWTESS_FILE): voci, triangoli, normali unitarie, verso dei triangoli concorde
con le normali salvate, ingombri delle parti uguali agli swBoundingBox dell'albero, ingombro dell'assieme dentro quello
dichiarato, GLB riletto, passaggio completo da solidcad.to_step con le parti mancanti. --immagine scrive una vista
assonometrica dei vertici per il confronto a occhio con l'anteprima salvata nel file.
"""
import json
import os
import struct
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from mbvisual import solidcad, swtess  # noqa: E402

ok = bad = 0


def check(name, cond, extra=""):
    global ok, bad
    ok += bool(cond)
    bad += not cond
    print(("OK   " if cond else "NO   ") + name + (f"  ({extra})" if extra and not cond else f"  {extra}" if extra else ""))


def read_glb(p):
    b = Path(p).read_bytes()
    magic, ver, total = struct.unpack_from("<III", b, 0)
    jl = struct.unpack_from("<I", b, 12)[0]
    js = json.loads(b[20:20 + jl])
    bl = struct.unpack_from("<I", b, 20 + jl)[0]
    binp = b[28 + jl:28 + jl + bl]
    return magic, total == len(b), js, binp


def accessor(js, binp, i):
    a = js["accessors"][i]
    v = js["bufferViews"][a["bufferView"]]
    dt = {5126: "<f4", 5120: "i1", 5123: "<u2", 5125: "<u4"}[a["componentType"]]
    n = {"VEC3": 3, "SCALAR": 1}[a["type"]]
    stride = v.get("byteStride")
    if stride:
        raw = np.frombuffer(binp, dt, v["byteLength"] // np.dtype(dt).itemsize, v["byteOffset"]).reshape(-1, stride // np.dtype(dt).itemsize)
        return raw[:, :n]
    return np.frombuffer(binp, dt, a["count"] * n, v["byteOffset"]).reshape(-1, n) if n > 1 else np.frombuffer(binp, dt, a["count"], v["byteOffset"])


# ---------------------------------------------------------------- prove sintetiche
def cstr(s):
    u = s.encode("utf-16-le")
    n = len(s)
    return b"\xff\xfe\xff" + (bytes([n]) if n < 255 else b"\xff" + struct.pack("<H", n)) + u


def face(verts, lens):
    v = np.asarray(verts, "<f4")
    nn = np.tile(np.array([[0, 0, 1]], "<f4"), (len(v), 1))
    ntri = sum(x - 2 for x in lens)
    out = struct.pack("<II", ntri, len(lens)) + b"\x04\x00\x00\x00\x08\x00\x00\x00\x02\x00\x00\x00" + struct.pack("<I", len(lens))
    out += struct.pack("<%dI" % len(lens), *lens)
    out += swtess._SIG_V3 + struct.pack("<I", len(v)) + v.tobytes()
    out += swtess._SIG_V3 + struct.pack("<I", len(v)) + nn.tobytes()
    return out + b"\x00" * 24


class FakeC:
    def __init__(self, d):
        self.d = d

    def names(self):
        return list(self.d)

    def get(self, n):
        return self.d.get(n)


def synthetic():
    t = swtess.strip_indices(np.array([4, 3]))
    check("strisce: triangoli e verso alternato", t.tolist() == [[0, 1, 2], [1, 3, 2], [4, 5, 6]], t.tolist())
    k1, k2, k3 = b"\x11" * 8, b"\x22" * 8, b"\x33" * 8
    quad = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (1, 1, 0)]
    blk = struct.pack("<I", 0) + k1 + struct.pack("<I", 7) + face(quad, [4]) + struct.pack("<I", 1) + k2 + struct.pack("<I", 9) \
        + face([(0, 0, 0), (2, 0, 0), (0, 2, 0)], [3])
    entries = [("A-1@Top/P-1@A", k1, None, "000-1", 0), ("A-1@Top/Q-1@A", k2, None, "000-1", 1), ("A-1@Top/P-2@A", k3, k1, "", -1)]
    dr = struct.pack("<3I", 2, 0, len(entries))
    for i, (p, k, src, b, ix) in enumerate(entries):
        dr += struct.pack("<I", i + 1) + cstr(p) + struct.pack("<I", 5) + b"\x00" * 8 + (src or b"\x00" * 8) + k + cstr(b) + struct.pack("<iI", ix, 0)
    c = FakeC({swtess.DIR: dr, "FaceTessellations/000-1": blk})
    E = swtess.read_directory(dr)
    check("directory sintetica", [e["path"] for e in E] == [e[0] for e in entries] and E[2]["src"] == k1, E)
    parts = swtess.read_parts(c, E)
    check("blocco sintetico: due parti", len(parts) == 2 and len(parts[k1][2]) == 2 and len(parts[k2][2]) == 1)
    ident = "1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"
    tree = {"models": {"1": {"attrs": {"swName": "Top"}, "refs": [{"swName": "A", "swReferenceNumber": "1", "swModelRef": "2", "swTransform": ident}]},
                       "2": {"attrs": {"swName": "A"}, "refs": [
                           {"swName": "P", "swReferenceNumber": "1", "swModelRef": "3", "swTransform": ident},
                           {"swName": "Q", "swReferenceNumber": "1", "swModelRef": "4", "swTransform": ident},
                           {"swName": "P", "swReferenceNumber": "2", "swModelRef": "3", "swTransform": "1 0 0 0 0 1 0 0 0 0 1 0 5 0 0 1"}]}}}
    out = Path(tempfile.mkdtemp(prefix="mbv-swtess-")) / "s.glb"
    rep = swtess.build(c, tree, E, "Top", out)
    magic, size_ok, js, binp = read_glb(out)
    check("GLB sintetico valido", magic == 0x46546C67 and size_ok and rep["istanze"] == 3 and len(js["meshes"]) == 2, rep)
    moved = [n for n in js["nodes"] if n.get("name") == "P<2>"]
    check("istanza ripetuta con la sua matrice", moved and moved[0]["matrix"][12] == 5.0 and moved[0]["mesh"] == 0)


# ---------------------------------------------------------------- file vero
def real(path, img_dir=None):
    t0 = time.time()
    c = solidcad.Container(path)
    print(f"     lettura sezioni {time.time() - t0:.1f} s")
    check("copia di visualizzazione presente", swtess.available(c))
    if not swtess.available(c):
        return
    E = swtess.read_directory(c.get(swtess.DIR))
    check("voci della directory", len(E) > 0, f"{len(E)} voci, {sum(1 for e in E if e['blk'])} con triangoli propri")
    t1 = time.time()
    parts = swtess.read_parts(c, E)
    print(f"     lettura triangoli {time.time() - t1:.1f} s")
    own = [e for e in E if e["blk"] and e["idx"] >= 0]
    check("parti con triangoli trovate", len(parts) >= 0.95 * len(own), f"{len(parts)} su {len(own)}")
    nv = sum(len(p[0]) for p in parts.values())
    nt = sum(len(p[2]) for p in parts.values())
    print(f"     {len(parts)} parti, {sum(p[3] for p in parts.values())} facce, {nv} vertici, {nt} triangoli")
    bad_idx = sum(int((p[2] >= len(p[0])).any() or (p[2] < 0).any()) for p in parts.values())
    check("indici dei triangoli validi", bad_idx == 0, bad_idx)
    lens = np.concatenate([np.linalg.norm(p[1], axis=1) for p in parts.values()])
    check("normali unitarie", float(np.abs(lens - 1).max()) < 1e-3, float(np.abs(lens - 1).max()))
    pos = neg = 0
    for v, n, t, _ in parts.values():
        cr = np.cross(v[t[:, 1]] - v[t[:, 0]], v[t[:, 2]] - v[t[:, 0]])
        s = np.einsum("ij,ij->i", cr, n[t[:, 0]] + n[t[:, 1]] + n[t[:, 2]])
        big = np.linalg.norm(cr, axis=1) > 1e-12
        pos += int((s[big] > 0).sum())
        neg += int((s[big] <= 0).sum())
    check("verso dei triangoli concorde con le normali", pos / max(1, pos + neg) > 0.99, f"{pos} su {pos + neg}")
    finite = all(np.isfinite(p[0]).all() for p in parts.values())
    check("coordinate finite", finite)
    # ingombri: ogni parte con il swBoundingBox del suo modello
    tree = solidcad._sw_tree(c)
    chains = swtess.resolve(tree, E, solidcad._xml_unescape)
    nres = sum(1 for e in E if chains.get(e["path"]))
    check("percorsi risolti nell'albero", nres >= 0.95 * len(E), f"{nres} su {len(E)}")
    models = tree["models"]
    good = tot = inside = 0
    worst = []
    outside = []
    for e in own:
        if e["key"] not in parts or not chains.get(e["path"]):
            continue
        # modello della parte = quello dell'ultimo riferimento del percorso (con la configurazione giusta)
        bb = models.get(chains[e["path"]][-1][2], {}).get("attrs", {}).get("swBoundingBox")
        if not bb:
            continue
        b = np.array([float(x) for x in bb.split()]).reshape(2, 3)
        v = parts[e["key"]][0]
        d = max(np.abs(v.min(0) - b[0]).max(), np.abs(v.max(0) - b[1]).max())
        diag = float(np.linalg.norm(b[1] - b[0])) or 1
        tot += 1
        tol = max(0.002, 0.01 * diag)
        if d <= tol:
            good += 1
        else:
            worst.append((round(float(d), 3), e["path"][-60:]))
        # l'ingombro di SolidWorks comprende anche schizzi, piani e corpi nascosti: i triangoli devono starci dentro
        if (v.min(0) >= b[0] - tol).all() and (v.max(0) <= b[1] + tol).all():
            inside += 1
        else:
            outside.append(e["path"][-60:])
    # nel file di prova 1 parte su 325 (saldato) ha 3 facce finali oltre l'ingombro dichiarato (0,9 m): ingombro non aggiornato?
    check("parti dentro il loro swBoundingBox (almeno 99%)", inside >= 0.99 * tot, f"{inside} su {tot}; fuori: {outside[:3]}")
    check("ingombri delle parti = swBoundingBox (2 mm o 1%) per la maggior parte", tot and good >= 0.8 * tot,
          f"{good} su {tot}; diversi (schizzi o corpi nascosti nell'ingombro): {sorted(worst, reverse=True)[:3]}")
    # passaggio completo come nell'app (parti mancanti -> GLB)
    t2 = time.time()
    res = solidcad.to_step(path)
    secs = time.time() - t2
    check("to_step usa la copia di visualizzazione", res.get("tess") and Path(res["glb"]).exists(), res.keys())
    rep = res.get("resoconto_tess", {})
    print(f"     to_step {secs:.1f} s (cache: {bool(res.get('cache'))}); {rep}")
    magic, size_ok, js, binp = read_glb(res["glb"])
    check("GLB valido", magic == 0x46546C67 and size_ok and "KHR_mesh_quantization" in js.get("extensionsRequired", []))
    # ingombro del mondo dai nodi (matrici per colonne)
    allp = []
    nodes = js["nodes"]

    def walk(i, m):
        nd = nodes[i]
        if "matrix" in nd:
            m = m @ np.array(nd["matrix"]).reshape(4, 4).T
        if "mesh" in nd:
            a = js["meshes"][nd["mesh"]]["primitives"][0]["attributes"]["POSITION"]
            acc = js["accessors"][a]
            corners = np.array([[x, y, z, 1] for x in (acc["min"][0], acc["max"][0]) for y in (acc["min"][1], acc["max"][1]) for z in (acc["min"][2], acc["max"][2])])
            allp.append((m @ corners.T).T[:, :3])
        for ch in nd.get("children", []):
            walk(ch, m)

    for r in js["scenes"][0]["nodes"]:
        walk(r, np.eye(4))
    P = np.concatenate(allp)
    root_bb = None
    for cfg in tree["configs"]:
        if cfg.get("swMostRecentConfiguration") == "YES":
            root_bb = models.get(cfg.get("swModelRef"), {}).get("attrs", {}).get("swBoundingBox")
    if root_bb:
        b = np.array([float(x) for x in root_bb.split()]).reshape(2, 3)
        inside = (P.min(0) >= b[0] - 0.05).all() and (P.max(0) <= b[1] + 0.05).all()
        check("assieme dentro l'ingombro dichiarato", inside, f"{P.min(0).round(2)} {P.max(0).round(2)} / {b.round(2).tolist()}")
    # indici e normali dal GLB
    m0 = js["meshes"][0]["primitives"][0]
    idx = accessor(js, binp, m0["indices"])
    cnt = js["accessors"][m0["attributes"]["POSITION"]]["count"]
    check("GLB: indici dentro i vertici", int(idx.max()) < cnt)
    if img_dir:
        image(js, binp, Path(img_dir))


def image(js, binp, out):
    """Vista assonometrica dei vertici (come le anteprime di SolidWorks: Y in alto)."""
    from PIL import Image
    nodes = js["nodes"]
    pts, cols = [], []

    def walk(i, m):
        nd = nodes[i]
        if "matrix" in nd:
            m = m @ np.array(nd["matrix"]).reshape(4, 4).T
        if "mesh" in nd:
            pr = js["meshes"][nd["mesh"]]["primitives"][0]
            v = accessor(js, binp, pr["attributes"]["POSITION"]).astype(float)
            v = v[:: max(1, len(v) // 20000)]
            w = (m @ np.c_[v, np.ones(len(v))].T).T[:, :3]
            pts.append(w)
            col = js["materials"][pr["material"]]["pbrMetallicRoughness"]["baseColorFactor"]
            cols.append(np.tile(np.array(col[:3]) * 255, (len(w), 1)))
        for ch in nd.get("children", []):
            walk(ch, m)

    for r in js["scenes"][0]["nodes"]:
        walk(r, np.eye(4))
    P, C = np.concatenate(pts), np.concatenate(cols)
    a, e = np.radians(45), np.radians(30)
    x = P[:, 0] * np.cos(a) - P[:, 2] * np.sin(a)
    depth = P[:, 0] * np.sin(a) + P[:, 2] * np.cos(a)
    y = P[:, 1] * np.cos(e) - depth * np.sin(e)
    z = depth * np.cos(e) + P[:, 1] * np.sin(e)
    W = 1200
    s = W / max(np.ptp(x), np.ptp(y))
    px = ((x - x.min()) * s).astype(int).clip(0, W - 1)
    py = ((y.max() - y) * s).astype(int).clip(0, W - 1)
    img = np.full((W, W, 3), 255, np.uint8)
    order = np.argsort(z)[::-1]
    img[py[order], px[order]] = C[order].astype(np.uint8)
    out.mkdir(parents=True, exist_ok=True)
    Image.fromarray(img).save(out / "swtess_vista.png")
    print(f"     immagine: {out / 'swtess_vista.png'}")


def main():
    args = [a for a in sys.argv[1:]]
    img = None
    if "--immagine" in args:
        i = args.index("--immagine")
        img = args[i + 1]
        del args[i:i + 2]
    synthetic()
    path = args[0] if args else os.environ.get("MBV_SWTESS_FILE", "")
    if path and os.path.isfile(path):
        real(path, img)
    else:
        print("     (nessun assieme vero indicato: solo prove sintetiche)")
    print(f"\n{ok} riuscite, {bad} non riuscite")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
