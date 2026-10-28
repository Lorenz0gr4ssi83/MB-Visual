"""Collaudo del lettore Autodesk ReCap (mbvisual/rcs.py + pointcloud.py).

  python tests/test_rcs.py                         prove con un .rcs sintetico scritto qui (stessa struttura dei file veri)
  python tests/test_rcs.py <file.rcs> [<file.e57>]  anche un file vero; con l'E57 esportato da ReCap dello stesso rilievo
                                                   confronta i punti (coordinate al millimetro, colori, intensita')

I file veri non stanno nel repository (pesano GB e hanno licenze d'uso limitate): vedi CLAUDE.md, sezione ReCap.
"""
import os
import struct
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mbvisual import misc, pointcloud, rcs  # noqa: E402

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


def write_rcs(path, voxels, translation=(0.0, 0.0, 0.0)):
    """Scrive un .rcs: voxels = [(minimo (3,), lato, punti mm int (n,3), attributi uint8 (n,4))]."""
    guid = b"{00000000_1111_2222_3333_444444444444}"
    head = bytearray(0x129)
    head[0:8] = b"ADOCT\0\0\0"
    struct.pack_into("<II", head, 8, 3, 2)
    struct.pack_into("<3d", head, 0x10, *translation)
    struct.pack_into("<3d", head, 0x40, 1, 1, 1)
    struct.pack_into("<3d", head, 0x58, *translation)
    allp = np.concatenate([np.asarray(v[0]) + p / 1000.0 for v in voxels for p in [v[2]]])
    c = (allp.min(0) + allp.max(0)) / 2
    struct.pack_into("<6d", head, 0x70, *(c - 64), *(c + 64))
    struct.pack_into("<6d", head, 0xa0, *allp.min(0), *allp.max(0))
    n = sum(len(v[2]) for v in voxels)
    struct.pack_into("<IIQ", head, 0xd0, 131, 5, n)
    head[0xe0:0xe3] = b"\x01\x01\x01"
    head[0xe3:0xe3 + len(guid)] = guid
    sec2 = bytearray(struct.pack("<Q", len(voxels)))
    data = bytearray()
    for vmin, side, pts, attr in voxels:
        m = len(pts)
        rec = bytearray(rcs.VOXEL_REC)
        q = np.asarray(pts, np.int64)
        lo = np.asarray(vmin) + q.min(0) / 1000.0
        hi = np.asarray(vmin) + q.max(0) / 1000.0
        struct.pack_into("<12d", rec, 0, *vmin, *(np.asarray(vmin) + side), *lo, *hi)
        nodes = 1  # un solo nodo interno (radice): basta al lettore, che usa solo i conteggi
        struct.pack_into("<III", rec, 96, 1, m, (nodes + m) * 4 + m * 16)
        struct.pack_into("<I", rec, 108, nodes)
        struct.pack_into("<I", rec, 236 + 4, m)
        sec2 += rec
        data += struct.pack("<I", 0) + b"".join(struct.pack("<I", 0x08000000 | i) for i in range(m))
        packed = (q[:, 0].astype(np.uint64) | (q[:, 1].astype(np.uint64) << np.uint64(18)) | (q[:, 2].astype(np.uint64) << np.uint64(36)))
        r = np.zeros((m, 16), np.uint8)
        r[:, :8] = packed.view(np.uint8).reshape(m, 8)
        r[:, 8:12] = attr
        data += r.tobytes()
    sec2 += b"\0\0\0\0"
    sec3 = bytes(64)
    sec11 = bytes(134)
    o2 = 0x129 + 4 + 24 * 4
    o3 = o2 + len(sec2)
    o1 = o3 + len(sec3)
    o11 = o1 + len(data)
    table = struct.pack("<I", 4) + struct.pack("<12Q", 2, o2, len(sec2), 3, o3, len(sec3), 1, o1, len(data), 11, o11, len(sec11))
    Path(path).write_bytes(bytes(head) + table + bytes(sec2) + sec3 + bytes(data) + sec11)


def synthetic(tmp):
    print("RCS sintetico")
    rng = np.random.default_rng(7)
    vox = []
    expected = []
    for k in range(3):
        vmin = np.array([10.0 + 2.25 * k, -5.0, 2.0])
        q = rng.integers(0, 2251, (1000 + k, 3))
        a = rng.integers(0, 256, (len(q), 4)).astype(np.uint8)
        vox.append((vmin, 2.25, q, a))
        expected.append((vmin + q / 1000.0 + [100, 200, 3], a))
    p = Path(tmp) / "sintetico.rcs"
    write_rcs(p, vox, translation=(100, 200, 3))
    check(misc.sniff(str(p)).get("kind") == "pointcloud", "riconosciuto dal contenuto (ADOCT)")
    h = rcs.read_header(str(p))
    check(h["n"] == 3003 and h["voxels"] == 3, "intestazione: 3 voxel, 3003 punti")
    got = list(rcs.iter_points(str(p), h, chunk=1500))
    check(len(got) >= 2, "lettura a blocchi")
    xyz = np.concatenate([g[0] for g in got])
    att = np.concatenate([g[1] for g in got])
    exp = np.concatenate([e[0] for e in expected])
    ea = np.concatenate([e[1] for e in expected])
    check(np.abs(xyz - exp).max() < 1e-9, "coordinate esatte (mm dal minimo del voxel + traslazione)")
    check(np.array_equal(att[:, :4], ea), "attributi")
    info, gen = pointcloud.reader(str(p))
    blk = next(gen)
    check(info["rgb"] and info["i"] and info["n"] == 3003, "lettore della nuvola: colori e intensita'")
    check(np.array_equal(blk["rgb"][:5], ea[:5][:, [3, 2, 1]]), "colori in ordine blu, verde, rosso nel file")
    meta = pointcloud.open_cloud(str(p))
    check(meta["n"] == 3003 and meta["nodes"], "ottree e cache")
    # file danneggiati
    bad = Path(tmp) / "rotto.rcs"
    raw = p.read_bytes()
    bad.write_bytes(raw[:len(raw) // 2])
    try:
        pointcloud.reader(str(bad))
        check(False, "file troncato: errore chiaro")
    except ValueError as e:
        check("ReCap" in str(e), "file troncato: errore chiaro (" + str(e)[:60] + "...)")
    ver = Path(tmp) / "versione.rcs"
    ver.write_bytes(raw[:8] + struct.pack("<I", 9) + raw[12:])
    try:
        pointcloud.reader(str(ver))
        check(False, "versione sconosciuta: errore chiaro")
    except ValueError as e:
        check("E57" in str(e), "versione sconosciuta: consiglia l'E57")
    # progetto .rcp con la cartella di supporto
    sup = Path(tmp) / "Progetto Support"
    sup.mkdir()
    write_rcs(sup / "s1.rcs", vox[:1], translation=(100, 200, 3))
    write_rcs(sup / "s2.rcs", vox[1:], translation=(100, 200, 3))
    rcp = Path(tmp) / "Progetto.rcp"
    rcp.write_text('<?xml version="1.0"?><project><scan path="Progetto Support/s1.rcs"/><scan path="Progetto Support/s2.rcs"/></project>', "utf-8")
    info, gen = pointcloud.reader(str(rcp))
    n = sum(len(b["xyz"]) for b in gen)
    check(info["scans"] == 2 and n == 3003, "progetto .rcp: 2 scansioni, tutti i punti")


def _keys(xyz):
    """Chiave del punto a mezzo millimetro (i punti RCS stanno su questa griglia; l'E57 li ha in float con scarti di micron)."""
    q = np.round(xyz * 2000).astype(np.int64) + (1 << 20)
    return (q[:, 0] << 42) | (q[:, 1] << 21) | q[:, 2]


def real(path, e57=None):
    print("RCS vero:", path)
    t0 = time.time()
    h = rcs.read_header(path)
    print(f"  versione {h['version']}, {h['voxels']} voxel, {h['n']:,} punti (dichiarati {h['declared']:,}), "
          f"traslazione {h['translation']}, rotazione {h['rotation']}")
    n = 0
    mn, mx = np.full(3, np.inf), np.full(3, -np.inf)
    sp, sa = [], []
    for xyz, attr, _ in rcs.iter_points(path, h):
        n += len(xyz)
        mn, mx = np.minimum(mn, xyz.min(0)), np.maximum(mx, xyz.max(0))
        sp.append(xyz[::40])
        sa.append(attr[::40, :4])
    dt = time.time() - t0
    check(n == h["n"], f"letti {n:,} punti in {dt:.0f} s")
    print("  ingombro", mn.round(3), mx.round(3))
    if not e57:
        return
    sp, sa = np.concatenate(sp), np.concatenate(sa)
    k = _keys(sp)
    order = np.argsort(k)
    ks = k[order]
    info, gen = pointcloud._read_e57(e57)
    check(info["n"] == n, f"stesso numero di punti dell'E57 ({info['n']:,})")
    hit, cbad, ibad = 0, 0, 0
    for b in gen:
        kk = _keys(b["xyz"])
        pos = np.searchsorted(ks, kk)
        pos[pos >= len(ks)] = 0
        m = ks[pos] == kk
        if not m.any():
            continue
        j = order[pos[m]]
        hit += int(m.sum())
        if b["rgb"] is not None:
            cbad += int((np.abs(sa[j][:, [3, 2, 1]].astype(int) - b["rgb"][m].astype(int)).max(1) > 2).sum())
        if b["i"] is not None:
            ibad += int((np.abs(sa[j][:, 0] / 255.0 - b["i"][m]) > 0.01).sum())
    print(f"  campione RCS {len(sp):,} punti, ritrovati nell'E57 {hit:,}")
    check(hit >= 0.98 * len(sp), "coordinate RCS = coordinate E57 (entro mezzo millimetro)")
    check(cbad <= 0.01 * max(hit, 1), f"colori RCS (byte B, G, R) = colori E57 (diversi: {cbad:,})")
    check(ibad <= 0.01 * max(hit, 1), f"intensita' RCS = intensita' E57 (diverse: {ibad:,})")


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as tmp:
        synthetic(tmp)
    if len(sys.argv) > 1:
        real(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
    print(f"\n{OK} riuscite, {KO} fallite")
    sys.exit(1 if KO else 0)
