"""Disegni MicroStation DGN V7 (ISFF, MicroStation fino alla 7 / IGDS) senza MicroStation: lettore scritto qui dalla struttura pubblica
del formato (la stessa descritta dalla libreria dgnlib di GDAL, MIT), poi copia DXF in cache (ezdxf) aperta dal visualizzatore CAD.
Elementi: linee (3), polilinee (4), forme (6), curve (11, come polilinea), testi (17), ellissi (15), archi (16), catene e forme
complesse (12, 14: si disegnano i componenti), celle (2: componenti in posizione assoluta), nodi di testo (7). Colori dalla tabella
del file (elemento 5 livello 1) o, se manca, dalla tabella predefinita di MicroStation approssimata con i colori AutoCAD; livelli ->
layer "Livello N"; unita' dalla TCB (unita' principali, sottounita', UOR e origine globale). 2D e 3D.
DGN V8 (MicroStation V8/CONNECT, contenitore OLE proprietario): NON letti, messaggio con il consiglio di esportare in DWG o V7."""
import hashlib
import math
import os
import struct

from .i18n import t as tr
from .paths import TEMP_DIR

CACHE = TEMP_DIR / "dgn"
VERSION = 1


class DgnError(ValueError):
    pass


def _i32(b, o):
    """intero a 32 bit "middle-endian" di DGN (parola alta prima, ogni parola little-endian)"""
    v = b[o + 2] | (b[o + 3] << 8) | (b[o] << 16) | (b[o + 1] << 24)
    return v - (1 << 32) if v & 0x80000000 else v


def _u32(b, o):
    return b[o + 2] | (b[o + 3] << 8) | (b[o] << 16) | (b[o + 1] << 24)


def _vax(b, o):
    """doppio VAX D_floating (8 byte, parole little-endian)"""
    w = struct.unpack_from("<4H", b, o)
    exp = (w[0] >> 7) & 0xFF
    if exp == 0:
        return 0.0
    sign = -1.0 if w[0] & 0x8000 else 1.0
    mant = ((w[0] & 0x7F) << 48) | (w[1] << 32) | (w[2] << 16) | w[3]
    return sign * (1 + mant / float(1 << 55)) * 0.5 * 2.0 ** (exp - 128)


def is_v8(head: bytes) -> bool:
    return head.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")


def read(path: str) -> dict:
    with open(path, "rb") as f:
        b = f.read()
    if is_v8(b[:8]):
        raise DgnError(tr("srv_dgn.v8"))
    els, pos = [], 0
    dim, scale, ox, oy, oz = 2, 1.0, 0.0, 0.0, 0.0
    units = ""
    colors = None
    n = len(b)
    while pos + 4 <= n:
        if b[pos] == 0xFF and b[pos + 1] == 0xFF:
            break
        level, typ = b[pos] & 0x3F, b[pos + 1] & 0x7F
        complex_, deleted = bool(b[pos] & 0x80), bool(b[pos + 1] & 0x80)
        size = struct.unpack_from("<H", b, pos + 2)[0] * 2 + 4
        if size < 4 or pos + size > n:
            break
        e = b[pos:pos + size]
        pos += size
        if typ == 9 and len(e) >= 1264:  # TCB: dimensione, unita', origine globale
            dim = 3 if e[1214] & 0x40 else 2
            spm, ups = _i32(e, 1112), _i32(e, 1116)
            if spm > 0 and ups > 0:
                scale = 1.0 / (spm * ups)
            units = e[1120:1122].decode("latin-1", "replace").strip("\x00 ")
            ox, oy, oz = _vax(e, 1240) * scale, _vax(e, 1248) * scale, _vax(e, 1256) * scale
            continue
        if deleted:
            continue
        if typ == 5 and level == 1 and len(e) >= 806:  # tabella dei colori
            colors = [None] * 256
            colors[255] = tuple(e[38:41])
            for i in range(255):
                colors[i] = tuple(e[41 + i * 3:44 + i * 3])
            continue
        if len(e) < 36 or typ in (8, 9, 10, 5, 37, 66):
            continue
        sym = e[34]
        el = {"t": typ, "lv": level, "c": e[35], "w": sym >> 3, "s": sym & 7, "cx": complex_}
        P = lambda o: ((_i32(e, o) * scale - ox, _i32(e, o + 4) * scale - oy, (_i32(e, o + 8) * scale - oz) if dim == 3 else 0.0))  # noqa: E731
        step = 12 if dim == 3 else 8
        try:
            if typ == 3:
                el["p"] = [P(36), P(36 + step)]
            elif typ in (4, 6, 11, 21):
                cnt = struct.unpack_from("<H", e, 36)[0]
                cnt = min(cnt, (len(e) - 38) // step)
                el["p"] = [P(38 + i * step) for i in range(cnt)]
            elif typ == 15 or typ == 16:
                if typ == 16:
                    start = _i32(e, 36) / 360000.0
                    sw = _u32(e, 40)
                    sweep = -(sw & 0x7FFFFFFF) / 360000.0 if sw & 0x80000000 else sw / 360000.0
                    if sweep == 0:
                        sweep = 360.0
                    o = 44
                else:
                    start, sweep, o = 0.0, 360.0, 36
                a1, a2 = _vax(e, o) * scale, _vax(e, o + 8) * scale
                if dim == 2:
                    rot = _i32(e, o + 16) / 360000.0
                    cx, cy, cz = _vax(e, o + 20) * scale - ox, _vax(e, o + 28) * scale - oy, 0.0
                else:
                    q = [_i32(e, o + 16 + 4 * k) / 2147483647.0 for k in range(4)]
                    rot = math.degrees(math.atan2(2 * (q[0] * q[3] + q[1] * q[2]), 1 - 2 * (q[2] ** 2 + q[3] ** 2)))
                    cx, cy, cz = _vax(e, o + 32) * scale - ox, _vax(e, o + 40) * scale - oy, _vax(e, o + 48) * scale - oz
                el.update(c0=(cx, cy, cz), a1=a1, a2=a2, rot=rot, start=start, sweep=sweep)
            elif typ == 17:
                el["h"] = _i32(e, 42) * scale * 6.0 / 1000.0
                el["wd"] = _i32(e, 38) * scale * 6.0 / 1000.0
                el["font"] = e[36]
                el["just"] = e[37]
                if dim == 2:
                    el["rot"] = _i32(e, 46) / 360000.0
                    el["p"] = [P(50)]
                    nch, to = e[58], 60
                else:
                    q = [_i32(e, 46 + 4 * k) / 2147483647.0 for k in range(4)]
                    el["rot"] = math.degrees(math.atan2(2 * (q[0] * q[3] + q[1] * q[2]), 1 - 2 * (q[2] ** 2 + q[3] ** 2)))
                    el["p"] = [P(62)]
                    nch, to = e[74], 76
                raw = e[to:to + nch]
                if raw[:2] == b"\xff\xfd":  # testo a 16 bit
                    el["txt"] = e[to + 2:to + 2 + nch * 2].decode("utf-16-le", "replace").rstrip("\x00")
                else:
                    el["txt"] = raw.decode("cp1252", "replace").rstrip("\x00")
            else:
                continue
        except (struct.error, IndexError):
            continue
        els.append(el)
    return {"dim": dim, "units": units, "colors": colors, "elements": els}


# MicroStation predefinita: le prime voci sono come AutoCAD (bianco, blu, verde, rosso, giallo, viola, arancio...)
_DGN_ACI = {0: 7, 1: 5, 2: 3, 3: 1, 4: 2, 5: 6, 6: 30, 7: 4}


def to_dxf(path: str, update=lambda *a, **k: None) -> dict:
    CACHE.mkdir(parents=True, exist_ok=True)
    st = os.stat(path)
    key = hashlib.sha1(f"{os.path.abspath(path)}|{st.st_size}|{st.st_mtime}|{VERSION}".encode()).hexdigest()[:16]
    out = CACHE / f"{key}.dxf"
    if out.exists():
        return {"ok": True, "path": str(out), "cache": True}
    update(progress=0.1, message=tr("srv_dgn.lettura"))
    D = read(path)
    import ezdxf
    from ezdxf import colors as ezc
    doc = ezdxf.new("R2010", setup=True)
    doc.header["$INSUNITS"] = {"m": 6, "mm": 4, "cm": 5, "ft": 2, "in": 1, "km": 7}.get(D["units"].lower(), 0)
    msp = doc.modelspace()
    layers = set()
    counts = {}
    for el in D["elements"]:
        lname = tr("srv_dgn.livello", el["lv"])
        if lname not in layers:
            doc.layers.add(lname)
            layers.add(lname)
        at = {"layer": lname}
        if D["colors"]:
            r, g, bl = D["colors"][el["c"]]
            at["true_color"] = ezc.rgb2int((r, g, bl))
        else:
            at["color"] = _DGN_ACI.get(el["c"], el["c"] if 0 < el["c"] < 256 else 7)
        if el["w"]:
            at["lineweight"] = min(211, max(0, round(el["w"] * 0.1 + 0.13, 2) * 100))
            at["lineweight"] = min((13, 18, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211), key=lambda v: abs(v - at["lineweight"]))
        t = el["t"]
        if t in (3, 4, 6, 11, 21) and len(el.get("p", [])) >= 2:
            pts = el["p"]
            closed = t == 6
            if D["dim"] == 3 and any(abs(p[2]) > 1e-9 for p in pts):
                msp.add_polyline3d(pts, close=closed, dxfattribs=at)
            elif len(pts) == 2 and t == 3:
                msp.add_line(pts[0], pts[1], dxfattribs=at)
            else:
                msp.add_lwpolyline([(p[0], p[1]) for p in pts], close=closed, dxfattribs=at)
        elif t in (15, 16):
            a1, a2 = abs(el["a1"]), abs(el["a2"])
            if a1 <= 0:
                continue
            rot = math.radians(el["rot"])
            if abs(a1 - a2) <= 1e-9 * max(1, a1):
                if t == 15 or abs(el["sweep"]) >= 360:
                    msp.add_circle(el["c0"], a1, dxfattribs=at)
                else:
                    s0, s1 = el["start"] + el["rot"], el["start"] + el["rot"] + el["sweep"]
                    if el["sweep"] < 0:
                        s0, s1 = s1, s0
                    msp.add_arc(el["c0"], a1, s0, s1, dxfattribs=at)
            else:
                major = (a1 * math.cos(rot), a1 * math.sin(rot), 0)
                s0, s1 = math.radians(el["start"]), math.radians(el["start"] + el["sweep"])
                if el["sweep"] < 0:
                    s0, s1 = s1, s0
                if abs(el["sweep"]) >= 360:
                    s0, s1 = 0, math.tau
                msp.add_ellipse(el["c0"], major, a2 / a1, s0, s1, dxfattribs=at)
        elif t == 17 and el.get("txt"):
            h = el["h"] if el["h"] > 0 else 1.0
            tx = msp.add_text(el["txt"], height=h, rotation=el["rot"], dxfattribs=at)
            if el["wd"] > 0 and el["h"] > 0:
                tx.dxf.width = el["wd"] / el["h"]
            tx.set_placement(el["p"][0][:2])
        else:
            continue
        counts[t] = counts.get(t, 0) + 1
    tmp = out.with_suffix(".tmp")
    doc.saveas(tmp)
    os.replace(tmp, out)
    return {"ok": True, "path": str(out), "elementi": sum(counts.values()), "tipi": counts, "unita": D["units"], "dim": D["dim"]}
