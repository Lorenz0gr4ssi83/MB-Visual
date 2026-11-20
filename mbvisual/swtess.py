"""Copia di visualizzazione salvata negli assiemi SolidWorks 2015+ (sezioni FaceTessellations/*): triangoli per componente.

Serve quando i file delle parti dell'assieme non ci sono: SolidWorks salva dentro l'assieme la tassellazione di ogni parte
(la stessa che usa per aprire gli assiemi "alleggeriti"). Formato NON documentato, ricavato dai dati (nessun codice o SDK
di terzi):

- `FaceTessellations/Directory`: u32 2, u32 (?), u32 numero di voci, poi per voce
  [u32 progressivo][CString percorso dell'istanza "Nome-N@Assieme/Nome-N@Sottoassieme..."][u32 = swLastModifiedStamp del
  modello][8 byte a zero][8 byte = chiave della tassellazione da cui copiare (zero = propria)][8 byte chiave della voce]
  [CString nome del blocco "000-003-330"][i32 posizione nel blocco, -1 = nessuna][u32 n][n x (u32 id, u32, u32)].
  CString = ff fe ff + lunghezza (u8, oppure ff + u16) + UTF-16LE (stile MFC). Le istanze ripetute della stessa parte
  non hanno blocco e indicano nella chiave "da cui copiare" la voce che ha i triangoli.
- `FaceTessellations/<blocco>`: le parti una dopo l'altra; ogni parte comincia con [u32 posizione][8 byte chiave].
  Le facce hanno: u32 triangoli, u32 strisce, array di interi (04 08 02 n + n lunghezze delle strisce), array di vertici
  (0c 64 02 N + N x 3 float32, metri, coordinate della parte), array di normali (stessa forma, unitarie), poi spigoli e
  riferimenti alle superfici (non usati). Triangoli = strisce (triangle strip) con verso alternato; verificato sulle
  normali salvate: 100% dei triangoli concordi. Triangoli = somma(lunghezza - 2).
- Posizioni: matrici swTransform dell'albero swXmlContents/COMPINSTANCETREE (stessa lettura di solidcad._sw_matrix),
  composte lungo il percorso dell'istanza. Verificato: ingombri delle parti = swBoundingBox dei modelli.
- Colori: `Contents/DisplayLists` contiene per ogni percorso di istanza gli aspetti (nome dell'aspetto, byte 2, colore
  RGB, poi 1.0f); si usa il colore piu' frequente del componente (le facce con aspetti propri NON sono distinte).

Uscita: GLB (metri, Y in alto come SolidWorks) con un nodo per istanza dell'albero e una mesh per parte condivisa tra le
istanze; normali quantizzate a 8 bit (KHR_mesh_quantization, letto da GLTFLoader di three.js).
"""
from __future__ import annotations

import json
import os
import re
import struct
import time
from collections import Counter

import numpy as np

from .i18n import t as tr

VERSION = "2"  # cambia quando cambia l'uscita: invalida la cache
DIR = "FaceTessellations/Directory"
_SIG_INT = b"\x04\x00\x00\x00\x08\x00\x00\x00\x02\x00\x00\x00"
_SIG_V3 = b"\x0c\x00\x00\x00\x64\x00\x00\x00\x02\x00\x00\x00"
_RE_INT = re.compile(re.escape(_SIG_INT))
_RE_APP = re.compile(rb"\xff\xfe\xff([\x01-\x7f])((?:[\x20-\x7e]\x00)+?)\x02(...)\x00\x00\x00\x80\x3f", re.S)


class TessError(ValueError):
    pass


def available(c) -> bool:
    """L'assieme contiene la copia di visualizzazione?"""
    return DIR in c.names()


# ---------------------------------------------------------------- lettura
def _cstr(b: bytes, p: int):
    if b[p:p + 3] != b"\xff\xfe\xff":
        raise TessError("cstring @%d" % p)
    p += 3
    n = b[p]
    p += 1
    if n == 0xFF:
        n = struct.unpack_from("<H", b, p)[0]
        p += 2
        if n == 0xFFFF:
            n = struct.unpack_from("<I", b, p)[0]
            p += 4
    return b[p:p + 2 * n].decode("utf-16-le", "replace"), p + 2 * n


def read_directory(data: bytes) -> list[dict]:
    """Voci della directory: percorso dell'istanza, chiave, chiave da cui copiare, blocco e posizione."""
    _ver, _n1, count = struct.unpack_from("<3I", data, 0)
    p = 12
    out = []
    while p + 4 <= len(data) and len(out) < count:
        p += 4  # progressivo
        path, p = _cstr(data, p)
        stamp = struct.unpack_from("<I", data, p)[0]
        p += 4
        src = data[p + 8:p + 16]
        p += 16
        key = data[p:p + 8]
        p += 8
        blk, p = _cstr(data, p)
        idx, n = struct.unpack_from("<iI", data, p)
        p += 8 + 12 * n
        out.append({"path": path, "stamp": stamp, "key": key, "src": src if any(src) else None, "blk": blk, "idx": idx})
    return out


def _faces(b: bytes, start: int, end: int):
    """Facce tra start ed end: lista di (lunghezze delle strisce, vertici N x 3, normali N x 3)."""
    out = []
    for m in _RE_INT.finditer(b, start, end):
        p = m.start()
        if p < 8:
            continue
        ntri, ns = struct.unpack_from("<II", b, p - 8)
        if ns == 0 or ns > 1_000_000 or struct.unpack_from("<I", b, p + 12)[0] != ns:
            continue
        q = p + 16 + 4 * ns
        if b[q:q + 12] != _SIG_V3:
            continue
        lens = np.frombuffer(b, "<u4", ns, p + 16).astype(np.int64)
        n = struct.unpack_from("<I", b, q + 12)[0]
        if int(lens.sum()) != n or int((lens - 2).sum()) != ntri or (lens < 3).any():
            continue
        q2 = q + 16 + 12 * n
        if q2 + 16 + 12 * n > len(b) or b[q2:q2 + 12] != _SIG_V3 or struct.unpack_from("<I", b, q2 + 12)[0] != n:
            continue
        v = np.frombuffer(b, "<f4", 3 * n, q + 16).reshape(-1, 3)
        nn = np.frombuffer(b, "<f4", 3 * n, q2 + 16).reshape(-1, 3)
        out.append((lens, v, nn))
    return out


def strip_indices(lens: np.ndarray, offset: int = 0) -> np.ndarray:
    """Strisce di triangoli -> indici (verso alternato come le triangle strip)."""
    lens = np.asarray(lens, np.int64)
    ntri = lens - 2
    starts = np.concatenate([[0], np.cumsum(lens)[:-1]]) + offset
    tot = int(ntri.sum())
    if tot <= 0:
        return np.zeros((0, 3), np.int64)
    base = np.repeat(starts, ntri)
    first = np.repeat(np.concatenate([[0], np.cumsum(ntri)[:-1]]), ntri)
    i = np.arange(tot) - first
    a = base + i
    odd = (i & 1).astype(bool)
    b_ = a + np.where(odd, 2, 1)
    c = a + np.where(odd, 1, 2)
    return np.stack([a, b_, c], 1)


def read_parts(c, entries) -> dict:
    """{chiave: (vertici, normali, triangoli)} per le voci che hanno un blocco proprio."""
    parts = {}
    by_blk = {}
    for e in entries:
        if e["blk"] and e["idx"] >= 0:
            by_blk.setdefault(e["blk"], []).append(e)
    for blk, items in by_blk.items():
        b = c.get("FaceTessellations/" + blk)
        if not b:
            continue
        items.sort(key=lambda e: e["idx"])
        starts = []
        for e in items:
            k = b.find(struct.pack("<I", e["idx"]) + e["key"])
            starts.append(k)
        for i, e in enumerate(items):
            s = starts[i]
            if s < 0:
                continue
            nxt = [x for x in starts[i + 1:] if x > s]
            faces = _faces(b, s, nxt[0] if nxt else len(b))
            if not faces:
                continue
            vs, ns, ts = [], [], []
            off = 0
            for lens, v, nn in faces:
                vs.append(v)
                ns.append(nn)
                ts.append(strip_indices(lens, off))
                off += len(v)
            parts[e["key"]] = (np.concatenate(vs), np.concatenate(ns), np.concatenate(ts), len(faces))
    return parts


def read_colors(c, paths) -> dict:
    """{percorso dell'istanza: (r, g, b)} dagli aspetti in Contents/DisplayLists (colore piu' frequente)."""
    d = c.get("Contents/DisplayLists")
    if not d:
        return {}
    want = set(paths)
    marks = []
    for m in re.finditer(rb"\xff\xfe\xff([\x01-\xfe])", d):
        n = m.group(1)[0]
        s = m.end()
        try:
            txt = d[s:s + 2 * n].decode("utf-16-le")
        except UnicodeDecodeError:
            continue
        if "@" in txt and txt in want:
            marks.append((m.start(), txt))
    for m in re.finditer(rb"\xff\xfe\xff\xff(..)", d, re.S):  # percorsi oltre 254 caratteri
        n = struct.unpack("<H", m.group(1))[0]
        try:
            txt = d[m.end():m.end() + 2 * n].decode("utf-16-le")
        except UnicodeDecodeError:
            continue
        if txt in want:
            marks.append((m.start(), txt))
    marks.sort()
    out = {}
    for i, (p, txt) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else len(d)
        cnt = Counter()
        for m in _RE_APP.finditer(d, p, end):
            if len(m.group(2)) == 2 * m.group(1)[0]:
                cnt[m.group(3)] += 1
        if cnt and txt not in out:
            rgb = cnt.most_common(1)[0][0]
            out[txt] = (rgb[0], rgb[1], rgb[2])
    return out


# ---------------------------------------------------------------- albero e posizioni
def _matrix(s):
    """swTransform -> matrice 4x4 per vettori riga (p' = [p, 1] @ A), come solidcad._sw_matrix."""
    try:
        v = [float(x) for x in s.split()]
    except (ValueError, AttributeError):
        return None
    if len(v) < 16:
        return None
    a = np.array(v[:16], float).reshape(4, 4)
    sc = a[3, 3] or 1.0
    a[:3, :3] /= sc
    a[:, 3] = (0, 0, 0, 1)
    return a


def _split_seg(seg):
    """'Nome-3@Assieme padre' -> (nome, '3', padre)."""
    inst, parent = seg.rsplit("@", 1)
    name, num = inst.rsplit("-", 1) if "-" in inst else (inst, "1")
    return name, num, parent


def resolve(tree, entries, unescape):
    """Per ogni voce: lista dei segmenti [(nome mostrato, matrice locale, id del modello)] dal livello alto alla parte; None se non si trova
    o se un componente lungo il percorso e' soppresso/nascosto."""
    models = tree["models"]
    byname = {}
    for mid, m in models.items():
        byname.setdefault(unescape(m["attrs"].get("swName", "")), []).append(mid)
    refs_of = {}
    for mid, m in models.items():
        idx = {}
        for r in m["refs"]:
            idx.setdefault((unescape(r.get("swName", "")), r.get("swReferenceNumber", "")), r)
        refs_of[mid] = idx
    out = {}
    for e in entries:
        cur = None
        segs = []
        ok = True
        for i, seg in enumerate(e["path"].split("/")):
            try:
                name, num, parent = _split_seg(seg)
            except ValueError:
                ok = False
                break
            cands = [cur] if cur else byname.get(parent, [])
            ref = None
            for mid in cands:
                ref = refs_of.get(mid, {}).get((name, num))
                if ref:
                    break
            if ref is None or ref.get("swSuppressed") == "YES" or ref.get("swHidden") == "YES":
                ok = False
                break
            segs.append((f"{name}<{num}>", _matrix(ref.get("swTransform")), ref.get("swModelRef")))
            cur = ref.get("swModelRef")
        out[e["path"]] = segs if ok else None
    return out


# ---------------------------------------------------------------- GLB
class _Glb:
    def __init__(self):
        self.bin = bytearray()
        self.views, self.accs, self.meshes, self.mats, self.nodes = [], [], [], [], []
        self.mat_idx = {}

    def _view(self, arr: bytes, target=None, stride=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        v = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(arr)}
        if target:
            v["target"] = target
        if stride:
            v["byteStride"] = stride
        self.bin += arr
        self.views.append(v)
        return len(self.views) - 1

    def _acc(self, view, ctype, count, typ, **kw):
        self.accs.append({"bufferView": view, "componentType": ctype, "count": count, "type": typ, **kw})
        return len(self.accs) - 1

    def material(self, rgb):
        if rgb not in self.mat_idx:
            # glTF vuole colori lineari: i colori di SolidWorks sono sRGB
            lin = lambda x: x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4  # noqa: E731
            col = [round(lin(x / 255.0), 5) for x in (rgb or (184, 189, 194))] + [1.0]  # senza colore: grigio chiaro
            self.mats.append({"pbrMetallicRoughness": {"baseColorFactor": col, "metallicFactor": 0.15, "roughnessFactor": 0.55},
                              "doubleSided": True})
            self.mat_idx[rgb] = len(self.mats) - 1
        return self.mat_idx[rgb]

    def mesh(self, name, v, n, t, rgb):
        v = np.ascontiguousarray(v, "<f4")
        pos = self._acc(self._view(v.tobytes(), 34962), 5126, len(v), "VEC3", min=v.min(0).tolist(), max=v.max(0).tolist())
        q = np.zeros((len(n), 4), np.int8)
        q[:, :3] = np.clip(np.rint(n * 127.0), -127, 127)
        nor = self._acc(self._view(q.tobytes(), 34962, 4), 5120, len(n), "VEC3", normalized=True)
        it = np.uint16 if len(v) < 65536 else np.uint32
        ix = self._acc(self._view(np.ascontiguousarray(t, it).tobytes(), 34963), 5123 if it is np.uint16 else 5125, t.size, "SCALAR")
        self.meshes.append({"name": name, "primitives": [{"attributes": {"POSITION": pos, "NORMAL": nor}, "indices": ix,
                                                          "material": self.material(rgb)}]})
        return len(self.meshes) - 1

    def node(self, **kw):
        self.nodes.append(kw)
        return len(self.nodes) - 1

    def write(self, target, roots, extras=None):
        doc = {"asset": {"version": "2.0", "generator": "MB Desk swtess"},
               "extensionsUsed": ["KHR_mesh_quantization"], "extensionsRequired": ["KHR_mesh_quantization"],
               "scene": 0, "scenes": [{"nodes": roots, **({"extras": extras} if extras else {})}],
               "nodes": self.nodes, "meshes": self.meshes, "materials": self.mats, "accessors": self.accs,
               "bufferViews": self.views, "buffers": [{"byteLength": len(self.bin)}]}
        js = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        js += b" " * (-len(js) % 4)
        while len(self.bin) % 4:
            self.bin.append(0)
        total = 12 + 8 + len(js) + 8 + len(self.bin)
        tmp = str(target) + ".tmp"
        with open(tmp, "wb") as f:
            f.write(struct.pack("<III", 0x46546C67, 2, total))
            f.write(struct.pack("<II", len(js), 0x4E4F534A))
            f.write(js)
            f.write(struct.pack("<II", len(self.bin), 0x004E4942))
            f.write(self.bin)
        os.replace(tmp, target)


def build(c, tree, entries, root_name, target, update=None, unescape=lambda s: s) -> dict:
    """Scrive il GLB dell'assieme dalla copia di visualizzazione. Ritorna il resoconto."""
    update = update or (lambda *a, **k: None)
    t0 = time.time()
    update(0.1, tr("srv_solidcad.tess_lettura"))
    parts = read_parts(c, entries)
    if not parts:
        raise TessError(tr("srv_solidcad.tess_vuota"))
    update(0.55, tr("srv_solidcad.tess_posizioni"))
    chains = resolve(tree, entries, unescape)
    colors = read_colors(c, [e["path"] for e in entries])
    by_key = {e["key"]: e for e in entries}
    g = _Glb()
    root = g.node(name=root_name, children=[])
    groups = {(): root}
    mesh_of = {}
    stats = Counter()
    tri_tot = 0
    for e in entries:
        src = e["key"] if e["key"] in parts else (e["src"] if e["src"] in parts else None)
        segs = chains.get(e["path"])
        if src is None:
            stats["senza_triangoli"] += 1
            continue
        if segs is None:
            stats["non_posizionate"] += 1
            continue
        rgb = colors.get(e["path"])
        if rgb is None and src in by_key:
            rgb = colors.get(by_key[src]["path"])
        mk = (src, rgb)
        if mk not in mesh_of:
            v, n, tri, _nf = parts[src]
            mesh_of[mk] = g.mesh(segs[-1][0].rsplit("<", 1)[0], v, n, tri, rgb)
        tri_tot += len(parts[src][2])
        parent = root
        for i in range(len(segs) - 1):
            k = tuple(s[0] for s in segs[:i + 1])
            if k not in groups:
                name, m = segs[i][:2]
                kw = {"name": name, "children": []}
                if m is not None and not np.allclose(m, np.eye(4)):
                    kw["matrix"] = [float(x) for x in m.reshape(-1)]
                groups[k] = g.node(**kw)
                g.nodes[parent]["children"].append(groups[k])
            parent = groups[k]
        name, m = segs[-1][:2]
        kw = {"name": name, "mesh": mesh_of[mk], "extras": {"percorso": e["path"]}}
        if m is not None and not np.allclose(m, np.eye(4)):
            # glTF: matrice per colonne di M con p' = M p; qui A per vettori riga = M trasposta -> stessa sequenza
            kw["matrix"] = [float(x) for x in m.reshape(-1)]
        g.nodes[parent]["children"].append(g.node(**kw))
        stats["istanze"] += 1
    for nd in g.nodes:
        if "children" in nd and not nd["children"]:
            del nd["children"]
    if not stats["istanze"]:
        raise TessError(tr("srv_solidcad.tess_vuota"))
    update(0.85, tr("srv_solidcad.tess_scrittura"))
    g.write(target, [root])
    uniq_tri = sum(len(p[2]) for p in parts.values())
    return {"istanze": stats["istanze"], "parti": len(parts), "triangoli": tri_tot, "triangoli_unici": uniq_tri,
            "facce": sum(p[3] for p in parts.values()), "senza_triangoli": stats["senza_triangoli"],
            "non_posizionate": stats["non_posizionate"], "colori": len(colors), "secondi": round(time.time() - t0, 1)}
