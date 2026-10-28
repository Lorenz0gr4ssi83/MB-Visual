"""Nuvole di punti da rilievo (LAS, LAZ, E57, PTS, PTX, XYZ/TXT/ASC/CSV, PLY a soli punti, ReCap RCS/RCP).

Il file si legge a blocchi (anche centinaia di milioni di punti senza caricarli tutti in memoria) e si riordina in un
ottree con livelli di dettaglio, salvato in una cache su disco (TEMP_DIR/nuvole/<chiave>): la seconda apertura e' immediata.
Ogni livello contiene un campione dei punti ben distribuito (un punto per cella di una griglia 2^S per lato del nodo);
i punti non presi scendono ai figli. Nella cache i punti sono ordinati per livello e per nodo: ogni nodo e' un
intervallo contiguo, che l'interfaccia (ui/js/pointcloud.js) chiede con api/pc_data solo quando serve allo zoom attuale.

File della cache: pos.f32 (x, y, z relativi a "offset"), rgb.u8, int.u16 (intensita' riportata a 0..65535 sull'intervallo
"i_range" del file), cls.u8 (classe ASPRS), meta.json (nodi, limiti, attributi).
Librerie: laspy (BSD-2), lazrs (MIT), pye57 (MIT, con libE57Format BSL-1.0 e Xerces-C Apache-2.0), numpy.
"""
import hashlib
import io
import json
import os
import shutil
import time
import uuid
from pathlib import Path

import numpy as np

from .i18n import language, t
from .paths import TEMP_DIR

VERSION = 1
CACHE_DIR = TEMP_DIR / "nuvole"
CACHE_MAX = 20 * 1024 ** 3  # oltre 20 GB si cancellano le nuvole aperte meno di recente
CHUNK = 2_000_000           # punti per blocco di lettura
B = 21                      # bit per asse del codice di Morton (63 bit in tutto)
S = 7                       # griglia di campionamento di un nodo: 128 celle per lato
SMALL = 6000                # nodo con pochi punti: tutti nel nodo stesso (foglia)
EXTS = {"las", "laz", "e57", "pts", "ptx", "xyz", "txt", "asc", "csv", "ply", "rcs", "rcp"}


def _num(n: int) -> str:
    """Numero intero con il separatore delle migliaia della lingua dell'interfaccia."""
    sep = {"en": ",", "fr": "\u202f"}.get(language(), ".")
    return f"{n:,}".replace(",", sep)


class NotPointCloud(Exception):
    """Il file non e' una nuvola di punti (per esempio un PLY con facce): va aperto come mesh."""


# ---------------------------------------------------------------------------- lettori a blocchi
# Ogni lettore restituisce (info, generatore). Il generatore produce blocchi
# {"xyz": float64 (n,3), "rgb": uint8 (n,3) | None, "i": float32 (n,) | None, "c": uint8 (n,) | None, "done": 0..1}.

def _rgb8(r, g, b, sixteen):
    a = np.stack([r, g, b], axis=1)
    if sixteen:
        a = a >> 8
    return np.clip(a, 0, 255).astype(np.uint8)


def _read_las(path):
    import laspy
    f = laspy.open(path, laz_backend=_laz_backends())
    h = f.header
    dims = set(h.point_format.dimension_names)
    has_rgb = {"red", "green", "blue"} <= dims
    n = h.point_count
    info = {"n": n, "rgb": has_rgb, "i": "intensity" in dims, "c": "classification" in dims,
            "descr": t("srv_pointcloud.las_formato", h.version, h.point_format.id) + (" " + t("srv_pointcloud.compresso_laz") if h.are_points_compressed else ""),
            "offset": ((np.asarray(h.mins) + np.asarray(h.maxs)) / 2).tolist(),
            "extra": {t("srv_pointcloud.software"): (h.generating_software or "").strip("\x00 "), t("srv_pointcloud.sistema"): (h.system_identifier or "").strip("\x00 "),
                      t("srv_pointcloud.data_creazione"): str(h.creation_date or "")}}
    crs = _las_crs(h)
    if crs:
        info["extra"][t("srv_pointcloud.sistema_riferimento")] = crs

    def gen():
        sixteen = None
        done = 0
        try:
            for p in f.chunk_iterator(CHUNK):
                k = len(p)
                if not k:
                    continue
                xyz = np.empty((k, 3), np.float64)
                xyz[:, 0] = p.x
                xyz[:, 1] = p.y
                xyz[:, 2] = p.z
                rgb = None
                if has_rgb:
                    r, g, b = np.asarray(p.red), np.asarray(p.green), np.asarray(p.blue)
                    if sixteen is None:  # colori a 16 bit (standard) o a 8 bit (alcuni programmi): deciso sul primo blocco
                        sixteen = bool(max(r.max(initial=0), g.max(initial=0), b.max(initial=0)) > 255)
                    rgb = _rgb8(r, g, b, sixteen)
                done += k
                yield {"xyz": xyz, "rgb": rgb, "i": np.asarray(p.intensity, np.float32) if info["i"] else None,
                       "c": np.asarray(p.classification, np.uint8) if info["c"] else None, "done": done / max(n, 1)}
        finally:
            f.close()
    return info, gen()


def _laz_backends():
    import laspy
    try:
        return (laspy.LazBackend.LazrsParallel, laspy.LazBackend.Lazrs)
    except Exception:  # noqa: BLE001
        return None


def _las_crs(h):
    # descrizione leggibile del sistema di riferimento (WKT o chiavi GeoTIFF) senza pyproj
    for v in getattr(h, "vlrs", []):
        try:
            if v.record_id == 2112:  # WKT
                txt = bytes(v.record_data_bytes() if hasattr(v, "record_data_bytes") else v.string).decode("latin1")
                return txt.split('"')[1] if '"' in txt else txt[:80]
            if v.record_id == 34737:  # GeoAsciiParams
                return " ".join(str(s) for s in v.strings).strip("|\x00 ")[:120]
        except Exception:  # noqa: BLE001
            pass
    return ""


def _quat_matrix(q):
    w, x, y, z = (float(v) for v in q)
    n = (w * w + x * x + y * y + z * z) ** 0.5 or 1.0
    w, x, y, z = w / n, x / n, y / n, z / n
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def _read_e57(path):
    import pye57
    from pye57.e57 import SUPPORTED_POINT_FIELDS
    e = pye57.E57(path)
    heads = [e.get_header(i) for i in range(e.scan_count)]
    total = sum(h.point_count for h in heads)
    fields = [set(h.point_fields) for h in heads]
    has_rgb = any({"colorRed", "colorGreen", "colorBlue"} <= f for f in fields)
    has_i = any("intensity" in f for f in fields)
    offset = None
    for h in heads:  # centro dei limiti dichiarati (coordinate globali), se presenti
        try:
            offset = [(h.xMinimum + h.xMaximum) / 2, (h.yMinimum + h.yMaximum) / 2, (h.zMinimum + h.zMaximum) / 2]
            break
        except Exception:  # noqa: BLE001
            pass
    info = {"n": total, "rgb": has_rgb, "i": has_i, "c": False, "offset": offset,
            "descr": t("srv_pointcloud.e57_scansioni", len(heads)), "scans": len(heads), "extra": {}}

    def gen():
        done = 0
        try:
            for si, h in enumerate(heads):
                fl = [f for f in h.point_fields if f in SUPPORTED_POINT_FIELDS and f not in ("rowIndex", "columnIndex")]
                cart = {"cartesianX", "cartesianY", "cartesianZ"} <= set(fl)
                sph = {"sphericalRange", "sphericalAzimuth", "sphericalElevation"} <= set(fl)
                if not (cart or sph):
                    continue
                rot = _quat_matrix(h.rotation) if h.has_pose() else np.eye(3)
                tra = np.asarray(h.translation, np.float64) if h.has_pose() else np.zeros(3)
                ilim = None
                try:
                    ilim = (float(h.intensityMinimum), float(h.intensityMaximum))
                except Exception:  # noqa: BLE001
                    pass
                cap = min(CHUNK, max(1, h.point_count))
                data, bufs = e.make_buffers(fl, cap)
                reader = h.points.reader(bufs)
                try:
                    while True:
                        k = reader.read()
                        if not k:
                            break
                        if cart:
                            p = np.stack([data["cartesianX"][:k], data["cartesianY"][:k], data["cartesianZ"][:k]], axis=1).astype(np.float64)
                            bad = data["cartesianInvalidState"][:k] != 0 if "cartesianInvalidState" in data else None
                        else:
                            r = data["sphericalRange"][:k].astype(np.float64)
                            az = data["sphericalAzimuth"][:k].astype(np.float64)
                            el = data["sphericalElevation"][:k].astype(np.float64)
                            ce = np.cos(el)
                            p = np.stack([r * ce * np.cos(az), r * ce * np.sin(az), r * np.sin(el)], axis=1)
                            bad = data["sphericalInvalidState"][:k] != 0 if "sphericalInvalidState" in data else None
                        p = p @ rot.T + tra
                        keep = None if bad is None or not bad.any() else ~bad
                        rgb = None
                        if has_rgb:
                            if "colorRed" in data:
                                rgb = np.stack([data["colorRed"][:k], data["colorGreen"][:k], data["colorBlue"][:k]], axis=1).astype(np.uint8)
                            else:
                                rgb = np.full((k, 3), 180, np.uint8)
                        it = None
                        if has_i:
                            if "intensity" in data:
                                it = data["intensity"][:k].astype(np.float32)
                                if ilim and ilim[1] > ilim[0]:
                                    it = (it - ilim[0]) / (ilim[1] - ilim[0])
                            else:
                                it = np.zeros(k, np.float32)
                        if keep is not None:
                            p = p[keep]
                            rgb = rgb[keep] if rgb is not None else None
                            it = it[keep] if it is not None else None
                        done += k
                        yield {"xyz": p, "rgb": rgb, "i": it, "c": None, "done": done / max(total, 1), "scan": si}
                finally:
                    reader.close()
        finally:
            e.close()
    return info, gen()


def _sep_and_decimal(line: str):
    """Separatore e virgola decimale da una riga di dati: '1,5;2,3;4' (italiano), '1.5,2.3,4' (CSV), '1.5 2.3 4'."""
    if ";" in line or "\t" in line:
        return (";" if ";" in line else "\t"), ("," in line and "." not in line)
    if "," in line:
        return ",", False
    return None, False


def _parse_block(text: str, sep, comma_dec, ncol):
    if comma_dec:
        text = text.replace(",", ".")
    if sep:
        text = text.replace(sep, " ")
    try:
        a = np.loadtxt(io.StringIO(text), dtype=np.float64, comments=("#", "//"), ndmin=2, usecols=range(ncol))
    except ValueError:
        # righe irregolari (intestazioni ripetute, conteggi di PTS uniti): si tengono solo le righe con abbastanza numeri
        rows = []
        for ln in text.splitlines():
            parts = ln.split()
            if len(parts) >= ncol:
                try:
                    rows.append([float(v) for v in parts[:ncol]])
                except ValueError:
                    pass
        a = np.array(rows, np.float64).reshape(-1, ncol)
    return a


def _text_blocks(f, size):
    """Blocchi di righe intere (circa 32 MB) da un file binario aperto; restituisce (testo, frazione letta)."""
    rest = b""
    while True:
        blk = f.read(32 << 20)
        if not blk:
            if rest.strip():
                yield rest.decode("latin1"), 1.0
            return
        blk = rest + blk
        cut = blk.rfind(b"\n")
        if cut < 0:
            rest = blk
            continue
        rest = blk[cut + 1:]
        yield blk[:cut + 1].decode("latin1"), f.tell() / max(size, 1)


def _first_data_lines(path, k=200):
    out = []
    with open(path, "rb") as f:
        for raw in f:
            s = raw.decode("latin1").strip()
            if not s or s.startswith(("#", "//")):
                continue
            out.append(s)
            if len(out) >= k:
                break
    return out


def _columns_layout(sample: np.ndarray):
    """Significato delle colonne di un file di testo: x y z [i] [r g b] ... (deciso sulle prime righe)."""
    nc = sample.shape[1]
    lay = {"i": None, "rgb": None}

    def is_rgb(c):
        if c + 3 > nc:
            return False
        v = sample[:, c:c + 3]
        return bool(np.all(v >= 0) and np.all(v <= 255) and np.all(np.abs(v - np.round(v)) < 1e-6))
    if nc >= 7 and is_rgb(4):
        lay["i"], lay["rgb"] = 3, 4
    elif nc >= 6 and is_rgb(3):
        lay["rgb"] = 3
        if nc >= 7:
            lay["i"] = 6
    elif nc >= 4:
        lay["i"] = 3
    return lay


def _read_text(path, ext):
    size = os.path.getsize(path)
    lines = _first_data_lines(path)
    if not lines:
        raise ValueError(t("srv_pointcloud.nessun_punto"))
    skip_first = False
    if ext == "pts" and len(lines[0].split()) == 1:  # PTS: prima riga = numero di punti
        skip_first = True
        lines = lines[1:]
    if not lines:
        raise ValueError(t("srv_pointcloud.nessun_punto"))
    sep, comma_dec = _sep_and_decimal(lines[0])
    norm = [ln.replace(",", ".") if comma_dec else ln for ln in lines]
    if sep:
        norm = [ln.replace(sep, " ") for ln in norm]
    ncols = [len(ln.split()) for ln in norm]
    ncol = max(set(ncols), key=ncols.count)
    if ncol < 3:
        raise ValueError(t("srv_pointcloud.tre_colonne"))
    sample = _parse_block("\n".join(norm), None, False, ncol)
    if not len(sample):
        raise ValueError(t("srv_pointcloud.righe_non_riconosciute"))
    lay = _columns_layout(sample)
    est = int(size / max(1, sum(len(ln) + 2 for ln in lines) / len(lines)))
    info = {"n": est, "rgb": lay["rgb"] is not None, "i": lay["i"] is not None, "c": False, "offset": sample[0, :3].tolist(),
            "descr": t({"pts": "srv_pointcloud.nuvola_pts", "xyz": "srv_pointcloud.nuvola_xyz"}.get(ext, "srv_pointcloud.nuvola_testo")) + ", " + t("srv_pointcloud.n_colonne", ncol)}

    def gen():
        with open(path, "rb") as f:
            first = True
            for text, frac in _text_blocks(f, size):
                if first and skip_first:
                    text = text.split("\n", 1)[1] if "\n" in text else ""
                first = False
                a = _parse_block(text, sep, comma_dec, ncol)
                if not len(a):
                    continue
                yield {"xyz": a[:, :3], "rgb": np.clip(a[:, lay["rgb"]:lay["rgb"] + 3], 0, 255).astype(np.uint8) if lay["rgb"] is not None else None,
                       "i": a[:, lay["i"]].astype(np.float32) if lay["i"] is not None else None, "c": None, "done": frac}
    return info, gen()


def _read_ptx(path):
    """PTX (Leica): per ogni scansione colonne, righe, 4 righe di posizione dello scanner, matrice 4x4 (righe), poi i punti."""
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        head = [f.readline().decode("latin1").split() for _ in range(12)]
    ncol = len(head[10])
    info = {"n": int(head[0][0]) * int(head[1][0]), "rgb": ncol >= 7, "i": ncol in (4, 7), "c": False, "offset": None,
            "descr": t("srv_pointcloud.nuvola_ptx")}

    def gen():
        with open(path, "rb") as f:
            scan = 0
            while True:
                h = []
                while len(h) < 10:
                    ln = f.readline()
                    if not ln:
                        return
                    if ln.strip():
                        h.append(ln.decode("latin1").split())
                cols, rows = int(h[0][0]), int(h[1][0])
                m = np.array([[float(v) for v in r[:4]] for r in h[6:10]])
                rot, tra = m[:3, :3], m[3, :3]
                left = cols * rows
                while left > 0:
                    k = min(left, CHUNK)
                    buf = [f.readline() for _ in range(k)]
                    left -= k
                    a = _parse_block(b"".join(buf).decode("latin1"), None, False, ncol)
                    if not len(a):
                        continue
                    ok = np.any(a[:, :3] != 0, axis=1)  # 0 0 0 = punto mancante
                    a = a[ok]
                    xyz = a[:, :3] @ rot + tra
                    yield {"xyz": xyz, "rgb": np.clip(a[:, 4:7], 0, 255).astype(np.uint8) if ncol >= 7 else None,
                           "i": a[:, 3].astype(np.float32) if ncol in (4, 7) else None, "c": None,
                           "done": f.tell() / max(size, 1), "scan": scan}
                scan += 1
    return info, gen()


_PLY_TYPES = {"char": "i1", "int8": "i1", "uchar": "u1", "uint8": "u1", "short": "i2", "int16": "i2", "ushort": "u2", "uint16": "u2",
              "int": "i4", "int32": "i4", "uint": "u4", "uint32": "u4", "float": "f4", "float32": "f4", "double": "f8", "float64": "f8"}


def ply_header(path):
    with open(path, "rb") as f:
        if f.readline().strip() != b"ply":
            raise ValueError(t("srv_pointcloud.ply_intestazione"))
        fmt, elems = None, []
        while True:
            ln = f.readline()
            if not ln:
                raise ValueError(t("srv_pointcloud.ply_intestazione"))
            p = ln.decode("latin1").split()
            if not p:
                continue
            if p[0] == "format":
                fmt = p[1]
            elif p[0] == "element":
                elems.append({"name": p[1], "count": int(p[2]), "props": []})
            elif p[0] == "property" and elems:
                elems[-1]["props"].append(("list",) + tuple(p[2:]) if p[1] == "list" else (p[-1], p[1]))
            elif p[0] == "end_header":
                return fmt, elems, f.tell()


def ply_is_points(path) -> bool:
    try:
        _, elems, _ = ply_header(path)
    except Exception:  # noqa: BLE001
        return False
    return not any(e["name"] in ("face", "tristrips") and e["count"] > 0 for e in elems)


def _read_ply(path):
    fmt, elems, start = ply_header(path)
    if not ply_is_points(path):
        raise NotPointCloud("PLY mesh")
    if not elems or elems[0]["name"] != "vertex":
        raise ValueError(t("srv_pointcloud.ply_senza_vertici"))
    v = elems[0]
    names = [p[0] for p in v["props"]]
    if any(p[0] == "list" for p in v["props"]):
        raise ValueError(t("srv_pointcloud.ply_liste"))
    n = v["count"]
    pick = lambda *c: next((x for x in c if x in names), None)  # noqa: E731
    cr, cg, cb = pick("red", "r", "diffuse_red"), pick("green", "g", "diffuse_green"), pick("blue", "b", "diffuse_blue")
    ci = pick("intensity", "scalar_intensity", "scalar_Intensity", "Intensity", "reflectance")
    cc = pick("classification", "scalar_Classification", "class")
    info = {"n": n, "rgb": bool(cr and cg and cb), "i": bool(ci), "c": bool(cc), "offset": None,
            "descr": t("srv_pointcloud.ply_punti_binario" if fmt != "ascii" else "srv_pointcloud.ply_punti_testo")}

    def emit(get, k, done):
        xyz = np.stack([get("x"), get("y"), get("z")], axis=1).astype(np.float64)
        rgb = None
        if info["rgb"]:
            r, g, b = get(cr), get(cg), get(cb)
            if r.dtype.kind == "f" and r.max(initial=0) <= 1.0:
                r, g, b = r * 255, g * 255, b * 255
            rgb = _rgb8(r.astype(np.int64), g.astype(np.int64), b.astype(np.int64), r.dtype.itemsize == 2)
        return {"xyz": xyz, "rgb": rgb, "i": get(ci).astype(np.float32) if ci else None,
                "c": get(cc).astype(np.uint8) if cc else None, "done": done}

    def gen():
        if fmt == "ascii":
            size = os.path.getsize(path)
            with open(path, "rb") as f:
                f.seek(start)
                left = n
                for text, frac in _text_blocks(f, size):
                    a = _parse_block(text, None, False, len(names))[:left]
                    left -= len(a)
                    if len(a):
                        yield emit(lambda c: a[:, names.index(c)], len(a), frac)
                    if left <= 0:
                        return
        else:
            end = "<" if fmt == "binary_little_endian" else ">"
            dt = np.dtype([(p[0], end + _PLY_TYPES[p[1]]) for p in v["props"]])
            mm = np.memmap(path, dtype=dt, mode="r", offset=start, shape=(n,))
            for s in range(0, n, CHUNK):
                blk = np.asarray(mm[s:s + CHUNK])
                yield emit(lambda c: blk[c], len(blk), min(1.0, (s + len(blk)) / max(n, 1)))
            del mm
    return info, gen()


def _rcs_error(e):
    return ValueError(t("srv_pointcloud.rcs_" + e.code, *e.args2))


def _rcs_info(scans, descr):
    """scans = [(percorso, intestazione, matrice o None)] -> info + generatore come gli altri lettori."""
    total = sum(h["n"] for _, h, _ in scans)
    has_rgb = any(h["rgb"] for _, h, _ in scans)
    has_i = any(h["intensity"] for _, h, _ in scans)
    first = scans[0][1]
    c = (np.asarray(first["bbox"][:3]) + np.asarray(first["bbox"][3:])) / 2 + np.asarray(first["translation"])
    if scans[0][2] is not None:
        c = scans[0][2][:3, :3] @ c + scans[0][2][:3, 3]
    extra = {}
    if len(scans) == 1 and first["guid"]:
        extra[t("srv_pointcloud.rcs_id")] = first["guid"]
    extra[t("srv_pointcloud.rcs_voxel")] = _num(sum(h["voxels"] for _, h, _ in scans))
    info = {"n": total, "rgb": has_rgb, "i": has_i, "c": False, "offset": np.round(c, 0).tolist(),
            "descr": descr, "scans": len(scans), "extra": extra}

    def gen():
        from . import rcs
        done = 0
        for si, (p, h, m) in enumerate(scans):
            try:
                for xyz, attr, _ in rcs.iter_points(p, h, CHUNK, m):
                    k = len(xyz)
                    done += k
                    yield {"xyz": xyz, "rgb": attr[:, [3, 2, 1]] if has_rgb else None,  # byte 1-3 = blu, verde, rosso
                           "i": attr[:, 0].astype(np.float32) / 255.0 if has_i else None, "c": None,
                           "done": done / max(total, 1), "scan": si}
            except rcs.RcsError as e:
                raise _rcs_error(e) from None
    return info, gen()


def _read_rcs(path):
    from . import rcs
    try:
        h = rcs.read_header(path)
    except rcs.RcsError as e:
        raise _rcs_error(e) from None
    return _rcs_info([(path, h, None)], t("srv_pointcloud.rcs_scansione"))


def _read_rcp(path):
    from . import rcs
    found = rcs.read_project(path)
    if not found:
        raise ValueError(t("srv_pointcloud.rcp_vuoto"))
    scans, bad = [], 0
    for p, m in found:
        try:
            scans.append((p, rcs.read_header(p), m))
        except (rcs.RcsError, OSError):
            bad += 1
    if not scans:
        raise ValueError(t("srv_pointcloud.rcp_vuoto"))
    descr = t("srv_pointcloud.rcp_progetto", len(scans))
    if bad:
        descr += " " + t("srv_pointcloud.rcp_saltate", bad)
    return _rcs_info(scans, descr)


def reader(path):
    ext = Path(path).suffix.lower().lstrip(".")
    with open(path, "rb") as f:
        head = f.read(16)
    if head.startswith(b"LASF"):
        return _read_las(path)
    if head.startswith(b"ASTM-E57"):
        return _read_e57(path)
    if head.startswith(b"ply"):
        return _read_ply(path)
    if head.startswith(b"ADOCT"):
        return _read_rcs(path)
    if ext == "rcp":
        return _read_rcp(path)
    if ext == "ptx":
        return _read_ptx(path)
    if ext in ("las", "laz", "e57", "rcs"):
        raise ValueError(t("srv_pointcloud.intestazione_mancante", ext))
    return _read_text(path, ext)


# ---------------------------------------------------------------------------- costruzione dell'ottree
def _part1by2(v):
    v = v.astype(np.uint64) & np.uint64(0x1FFFFF)
    v = (v | (v << np.uint64(32))) & np.uint64(0x1F00000000FFFF)
    v = (v | (v << np.uint64(16))) & np.uint64(0x1F0000FF0000FF)
    v = (v | (v << np.uint64(8))) & np.uint64(0x100F00F00F00F00F)
    v = (v | (v << np.uint64(4))) & np.uint64(0x10C30C30C30C30C3)
    v = (v | (v << np.uint64(2))) & np.uint64(0x1249249249249249)
    return v


_LUT = None


def _spread(q):
    """Bit di un intero a 21 bit distanziati di 3 (codice di Morton) con una tabella da 11 bit: molto piu' veloce delle maschere."""
    global _LUT
    if _LUT is None:
        _LUT = _part1by2(np.arange(2048, dtype=np.uint64))
    return _LUT[q & 2047] | (_LUT[q >> 11] << np.uint64(33))


def _compact(v, L):
    """Indici di cella (x, y, z) al livello L da una chiave di Morton di 3L bit."""
    v = v.astype(np.uint64)
    out = [np.zeros(len(v), np.int64) for _ in range(3)]
    for b in range(L):
        for a in range(3):
            out[a] |= ((v >> np.uint64(3 * b + a)) & np.uint64(1)).astype(np.int64) << b
    return out


def _starts(c, shift):
    """Inizio di ogni gruppo di chiavi uguali (c >> shift) in un array ordinato, calcolato a blocchi (poca memoria)."""
    out = np.empty(len(c), bool)
    if not len(c):
        return out
    out[0] = True
    sh = np.uint64(shift)
    for s in range(1, len(c), CHUNK):
        e = min(len(c), s + CHUNK)
        np.not_equal(c[s:e] >> sh, c[s - 1:e - 1] >> sh, out=out[s:e])
    return out


def cache_key(path) -> str:
    st = os.stat(path)
    return hashlib.sha1(f"{os.path.abspath(path).lower()}|{st.st_size}|{st.st_mtime}|{VERSION}".encode()).hexdigest()[:20]


def cache_dir(key: str) -> Path:
    if not key or not all(c in "0123456789abcdef" for c in key):
        raise ValueError("chiave non valida")
    return CACHE_DIR / key


def open_cloud(path, update=None):
    """Prepara (o ritrova nella cache) la nuvola. Ritorna i metadati per l'interfaccia."""
    update = update or (lambda *a, **k: None)
    if Path(path).suffix.lower() == ".ply" and not ply_is_points(path):
        return {"ok": True, "mesh": True}
    key = cache_key(path)
    d = CACHE_DIR / key
    meta_p = d / "meta.json"
    if meta_p.exists():
        try:
            os.utime(meta_p)
        except OSError:
            pass
        meta = json.loads(meta_p.read_text("utf-8"))
        meta["cached"] = True
        return meta
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CACHE_DIR / f"{key}.{uuid.uuid4().hex[:6]}.tmp"
    tmp.mkdir()
    try:
        meta = _build(path, tmp, update)
        meta["key"] = key
        (tmp / "meta.json").write_text(json.dumps(meta), "utf-8")
        try:
            tmp.rename(d)
        except OSError:  # costruita nel frattempo da un'altra apertura
            shutil.rmtree(tmp, ignore_errors=True)
        _trim_cache(keep=key)
        meta["cached"] = False
        return meta
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise


def _build(path, d: Path, update):
    t0 = time.time()
    update(0.01, t("srv_pointcloud.lettura_intestazione"))
    info, gen = reader(path)
    off = None if info.get("offset") is None else np.asarray(info["offset"], np.float64)
    n = 0
    mn = np.full(3, np.inf)
    mx = np.full(3, -np.inf)
    ilo, ihi = np.inf, -np.inf
    isamp = []
    scans = set()
    with open(d / "raw_pos.f32", "wb") as fp, open(d / "raw_rgb.u8", "wb") as fr, open(d / "raw_int.f32", "wb") as fi, open(d / "raw_cls.u8", "wb") as fc:
        for blk in gen:
            xyz = blk["xyz"]
            if not len(xyz):
                continue
            ok = np.all(np.isfinite(xyz), axis=1)
            if not ok.all():
                xyz = xyz[ok]
                for k in ("rgb", "i", "c"):
                    if blk[k] is not None:
                        blk[k] = blk[k][ok]
            if off is None:
                off = np.round(xyz[0], 0)
            rel = (xyz - off).astype(np.float32)
            mn = np.minimum(mn, rel.min(axis=0))
            mx = np.maximum(mx, rel.max(axis=0))
            fp.write(rel.tobytes())
            if info["rgb"]:
                fr.write(np.ascontiguousarray(blk["rgb"] if blk["rgb"] is not None else np.full((len(rel), 3), 180, np.uint8)).tobytes())
            if info["i"]:
                it = blk["i"] if blk["i"] is not None else np.zeros(len(rel), np.float32)
                fi.write(it.astype(np.float32).tobytes())
                if len(it):
                    ilo, ihi = min(ilo, float(it.min())), max(ihi, float(it.max()))
                    isamp.append(it[:: max(1, len(it) // 20000)])
            if info["c"]:
                fc.write((blk["c"] if blk["c"] is not None else np.zeros(len(rel), np.uint8)).tobytes())
            if "scan" in blk:
                scans.add(blk["scan"])
            n += len(rel)
            update(0.02 + 0.55 * min(1.0, blk["done"]), t("srv_pointcloud.lettura_n", _num(n)))
    if not n:
        raise ValueError(t("srv_pointcloud.nessun_punto_valido"))
    # intervallo dell'intensita' per la scala di grigi: percentili, cosi' pochi valori estremi non appiattiscono tutto
    i_range = None
    if info["i"]:
        s = np.concatenate(isamp) if isamp else np.zeros(1, np.float32)
        lo, hi = (float(v) for v in np.percentile(s, [0.5, 99.5]))
        if hi <= lo:
            lo, hi = ilo, max(ihi, ilo + 1)
        i_range = [lo, hi, ilo, ihi]

    # ---- codici di Morton nel cubo che contiene la nuvola
    update(0.6, t("srv_pointcloud.ordinamento"))
    pos = np.memmap(d / "raw_pos.f32", dtype=np.float32, mode="r", shape=(n, 3))
    size = float(max(mx - mn)) * (1 + 1e-6) or 1.0
    cmin = mn.astype(np.float64)
    codes = np.empty(n, np.uint64)
    scale = (1 << B) / size
    for s in range(0, n, CHUNK):
        # in precisione singola (24 bit di mantissa per una griglia da 21 bit): molto piu' veloce
        q = ((pos[s:s + CHUNK] - cmin.astype(np.float32)) * np.float32(scale)).astype(np.int32)
        np.clip(q, 0, (1 << B) - 1, out=q)
        codes[s:s + CHUNK] = _spread(q[:, 0]) | (_spread(q[:, 1]) << np.uint64(1)) | (_spread(q[:, 2]) << np.uint64(2))
    # indici a 32 bit finche' bastano: con centinaia di milioni di punti la memoria e' il limite (232 M punti = 0,9 GB per indice)
    idt = np.uint32 if n < (1 << 32) else np.int64
    order = np.argsort(codes, kind="stable").astype(idt)  # i rilievi sono gia' in parte ordinati (righe di scansione): piu' veloce
    codes = codes[order]

    # ---- livelli: un punto per cella della griglia di campionamento; nodi con pochi punti presi interi
    update(0.7, t("srv_pointcloud.livelli"))
    LMAX = B - S
    level = np.full(n, 255, np.uint8)
    rem = np.arange(n, dtype=idt)
    c = codes
    for L in range(LMAX + 1):
        if not rem.size:
            break
        if L == LMAX:
            level[rem] = L
            break
        st = np.flatnonzero(_starts(c, 3 * (B - L)))
        cnt = np.diff(np.r_[st, len(c)])
        take = np.repeat(cnt <= SMALL, cnt)
        del st, cnt
        take |= _starts(c, 3 * (B - L - S))
        level[rem[take]] = L
        np.logical_not(take, out=take)
        rem = rem[take]
        c = c[take]
        del take
    del rem, c
    fin = np.argsort(level, kind="stable").astype(idt)  # per livello, poi (gia' ordinati) per nodo
    lv = level[fin]
    del level
    perm = order[fin]
    del order

    # ---- nodi: intervalli contigui con la stessa chiave al loro livello
    nodes = []
    lstarts = np.flatnonzero(np.r_[True, lv[1:] != lv[:-1]])
    lends = np.r_[lstarts[1:], n]
    for a, b in zip(lstarts, lends):
        L = int(lv[a])
        nk = codes[fin[a:b]] >> np.uint64(3 * (B - L))
        st = np.flatnonzero(np.r_[True, nk[1:] != nk[:-1]])
        cnt = np.diff(np.r_[st, len(nk)])
        ix, iy, iz = _compact(nk[st], L)
        for j in range(len(st)):
            nodes.append([L, int(ix[j]), int(iy[j]), int(iz[j]), int(a + st[j]), int(cnt[j])])
        del nk
    del codes, fin, lv

    # ---- scrittura nell'ordine finale
    update(0.8, t("srv_pointcloud.scrittura_cache"))
    rgb = np.memmap(d / "raw_rgb.u8", dtype=np.uint8, mode="r", shape=(n, 3)) if info["rgb"] else None
    inten = np.memmap(d / "raw_int.f32", dtype=np.float32, mode="r", shape=(n,)) if info["i"] else None
    cls = np.memmap(d / "raw_cls.u8", dtype=np.uint8, mode="r", shape=(n,)) if info["c"] else None
    with open(d / "pos.f32", "wb") as fp, open(d / "rgb.u8", "wb") as fr, open(d / "int.u16", "wb") as fi, open(d / "cls.u8", "wb") as fc:
        for s in range(0, n, CHUNK):
            idx = perm[s:s + CHUNK]
            srt = np.argsort(idx)  # lettura in ordine crescente (piu' veloce sul file), poi rimessi in ordine
            inv = np.empty_like(srt)
            inv[srt] = np.arange(len(srt))
            ids = idx[srt]
            fp.write(np.ascontiguousarray(pos[ids][inv]).tobytes())
            if rgb is not None:
                fr.write(np.ascontiguousarray(rgb[ids][inv]).tobytes())
            if inten is not None:
                lo, hi = i_range[0], i_range[1]
                v = (inten[ids][inv].astype(np.float64) - lo) / (hi - lo) * 65535
                fi.write(np.clip(v, 0, 65535).astype(np.uint16).tobytes())
            if cls is not None:
                fc.write(cls[ids][inv].tobytes())
            update(0.8 + 0.12 * min(1.0, (s + CHUNK) / n), None)
    del pos, rgb, inten, cls, perm
    for f in ("raw_pos.f32", "raw_rgb.u8", "raw_int.f32", "raw_cls.u8"):
        try:
            (d / f).unlink()
        except OSError:
            pass

    # ---- limiti esatti di ogni nodo (per scartare quelli fuori dalla vista)
    update(0.93, t("srv_pointcloud.limiti_nodi"))
    pos = np.memmap(d / "pos.f32", dtype=np.float32, mode="r", shape=(n, 3))
    starts = np.array([nd[4] for nd in nodes], np.int64)
    for s in range(0, len(nodes), 4096):
        part = starts[s:s + 4096]
        a, b = int(part[0]), int(starts[s + len(part)] if s + len(part) < len(nodes) else n)
        blk = np.asarray(pos[a:b])
        lo = np.minimum.reduceat(blk, part - a, axis=0)
        hi = np.maximum.reduceat(blk, part - a, axis=0)
        for j in range(len(part)):
            nodes[s + j].extend([round(float(v), 4) for v in (*lo[j], *hi[j])])
    del pos
    classes = []
    if info["c"]:
        cl = np.fromfile(d / "cls.u8", dtype=np.uint8)
        classes = [[int(k), int(v)] for k, v in enumerate(np.bincount(cl, minlength=1)) if v]
        del cl
    src = os.stat(path)
    meta = {"ok": True, "version": VERSION, "n": int(n), "offset": off.tolist(), "bbox": [*mn.tolist(), *mx.tolist()],
            "cube": [*cmin.tolist(), size], "S": S, "rgb": bool(info["rgb"]), "i": bool(info["i"]), "c": bool(info["c"]),
            "i_range": i_range, "classes": classes, "descr": info.get("descr", ""), "scans": len(scans) or info.get("scans") or 1,
            "extra": info.get("extra", {}), "source": {"path": str(path), "size": src.st_size},
            "nodes": nodes, "secs": round(time.time() - t0, 1)}
    update(0.99, t("srv_pointcloud.fatto"))
    return meta


def _trim_cache(keep=None):
    try:
        ds = [p for p in CACHE_DIR.iterdir() if p.is_dir() and (p / "meta.json").exists()]
    except OSError:
        return
    sz = {p: sum(f.stat().st_size for f in p.iterdir()) for p in ds}
    total = sum(sz.values())
    for p in sorted(ds, key=lambda p: (p / "meta.json").stat().st_mtime):
        if total <= CACHE_MAX:
            break
        if p.name == keep:
            continue
        shutil.rmtree(p, ignore_errors=True)
        total -= sz[p]


# ---------------------------------------------------------------------------- dati per l'interfaccia
def node_data(key: str, start: int, count: int) -> bytes:
    """Punti [start, start+count): posizioni float32, poi rgb (3 byte), intensita' (uint16), classe (1 byte) se presenti."""
    d = cache_dir(key)
    meta = json.loads((d / "meta.json").read_text("utf-8"))
    n = meta["n"]
    if start < 0 or count < 0 or start + count > n:
        raise ValueError("intervallo non valido")
    out = bytearray()
    for name, w, on in (("pos.f32", 12, True), ("rgb.u8", 3, meta["rgb"]), ("int.u16", 2, meta["i"]), ("cls.u8", 1, meta["c"])):
        if not on:
            continue
        with open(d / name, "rb") as f:
            f.seek(start * w)
            out += f.read(count * w)
        while len(out) % 4:  # le parti successive restano allineate per gli array tipizzati
            out.append(0)
    return bytes(out)


# ---------------------------------------------------------------------------- salva con nome
SAVE_EXTS = ["las", "laz", "e57", "ply", "pts", "xyz", "txt"]


def _iter_cache(d: Path, meta, clip):
    n = meta["n"]
    off = np.asarray(meta["offset"], np.float64)
    pos = np.memmap(d / "pos.f32", dtype=np.float32, mode="r", shape=(n, 3))
    rgb = np.memmap(d / "rgb.u8", dtype=np.uint8, mode="r", shape=(n, 3)) if meta["rgb"] else None
    it = np.memmap(d / "int.u16", dtype=np.uint16, mode="r", shape=(n,)) if meta["i"] else None
    cl = np.memmap(d / "cls.u8", dtype=np.uint8, mode="r", shape=(n,)) if meta["c"] else None
    lo, hi = (meta["i_range"] or [0, 1])[:2]
    for s in range(0, n, CHUNK):
        xyz = pos[s:s + CHUNK].astype(np.float64) + off
        keep = None
        for pl in clip or []:  # piani di sezione: si tengono i punti con n.p + d >= 0 (coordinate del file)
            k = xyz @ np.asarray(pl[:3], np.float64) + float(pl[3]) >= 0
            keep = k if keep is None else keep & k
        sel = (lambda a: a) if keep is None else (lambda a: a[keep])
        yield {"xyz": sel(xyz), "rgb": sel(np.asarray(rgb[s:s + CHUNK])) if rgb is not None else None,
               "i": sel(lo + np.asarray(it[s:s + CHUNK], np.float64) / 65535 * (hi - lo)) if it is not None else None,
               "c": sel(np.asarray(cl[s:s + CHUNK])) if cl is not None else None, "done": min(1.0, (s + CHUNK) / n)}


def export(path, out, clip=None, update=None):
    """Salva la nuvola (gia' aperta, quindi in cache) in LAS/LAZ/E57/PLY/PTS/XYZ; clip = piani di sezione facoltativi."""
    update = update or (lambda *a, **k: None)
    key = cache_key(path)
    d = cache_dir(key)
    if not (d / "meta.json").exists():
        open_cloud(path, lambda p=None, m=None: update((p or 0) * 0.5, m))
    meta = json.loads((d / "meta.json").read_text("utf-8"))
    ext = Path(out).suffix.lower().lstrip(".")
    if ext not in SAVE_EXTS:
        raise ValueError(t("srv_pointcloud.formati", ", ".join(e.upper() for e in SAVE_EXTS)))
    tmp = Path(str(out) + ".mbv-tmp")
    blocks = _iter_cache(d, meta, clip)
    try:
        if ext in ("las", "laz"):
            n = _write_las(tmp, meta, blocks, ext == "laz", update)
        elif ext == "e57":
            n = _write_e57(tmp, meta, blocks, update)
        elif ext == "ply":
            n = _write_ply(tmp, meta, blocks, update)
        else:
            n = _write_text(tmp, meta, blocks, ext, update)
        os.replace(tmp, out)
    finally:
        if tmp.exists():
            tmp.unlink()
    return {"ok": True, "path": str(out), "n": n}


def _scale_for(meta):
    ext = max(meta["bbox"][3] - meta["bbox"][0], meta["bbox"][4] - meta["bbox"][1], meta["bbox"][5] - meta["bbox"][2], 1e-6)
    sc = 0.001
    while ext / sc > 1e9 and sc < 1:
        sc *= 10
    while ext / sc < 1e5 and sc > 1e-6:  # oggetti piccoli: precisione piu' fine
        sc /= 10
    return sc


def _write_las(out, meta, blocks, laz, update):
    import laspy
    hdr = laspy.LasHeader(point_format=2 if meta["rgb"] else 0, version="1.2")
    off = np.asarray(meta["offset"], np.float64)
    sc = _scale_for(meta)
    hdr.offsets = np.floor(off)
    hdr.scales = np.array([sc, sc, sc])
    hdr.generating_software = "MB Desk"
    n = 0
    with laspy.open(str(out), mode="w", header=hdr, do_compress=laz, laz_backend=_laz_backends() if laz else None) as w:
        for b in blocks:
            k = len(b["xyz"])
            if not k:
                continue
            rec = laspy.ScaleAwarePointRecord.zeros(k, header=hdr)
            rec.x, rec.y, rec.z = b["xyz"][:, 0], b["xyz"][:, 1], b["xyz"][:, 2]
            if b["i"] is not None:
                iv = b["i"]
                if meta["i_range"] and meta["i_range"][3] <= 1.0:  # intensita' 0..1 (E57, PLY): scala completa del LAS
                    iv = iv * 65535
                rec.intensity = np.clip(np.round(iv), 0, 65535).astype(np.uint16)
            if b["c"] is not None:
                rec.classification = b["c"] & 31
            if b["rgb"] is not None:
                c16 = b["rgb"].astype(np.uint16) * 257
                rec.red, rec.green, rec.blue = c16[:, 0], c16[:, 1], c16[:, 2]
            w.write_points(rec)
            n += k
            update(b["done"], t("srv_pointcloud.scrittura_n", _num(n)))
    return n


def _write_e57(out, meta, blocks, update):
    import pye57
    parts = {k: [] for k in ("x", "y", "z", "r", "g", "b", "i")}
    off = np.asarray(meta["offset"], np.float64)
    n = 0
    for b in blocks:
        rel = b["xyz"] - off  # coordinate piccole (precisione singola nel file) + traslazione nella posa della scansione
        parts["x"].append(rel[:, 0])
        parts["y"].append(rel[:, 1])
        parts["z"].append(rel[:, 2])
        if b["rgb"] is not None:
            for j, k in enumerate("rgb"):
                parts[k].append(b["rgb"][:, j])
        if b["i"] is not None:
            parts["i"].append(b["i"].astype(np.float32))
        n += len(rel)
        update(b["done"] * 0.7, t("srv_pointcloud.preparazione_n", _num(n)))
    if not n:
        raise ValueError(t("srv_pointcloud.nessun_punto_salvare"))
    data = {"cartesianX": np.concatenate(parts["x"]), "cartesianY": np.concatenate(parts["y"]), "cartesianZ": np.concatenate(parts["z"])}
    if parts["r"]:
        data.update(colorRed=np.concatenate(parts["r"]), colorGreen=np.concatenate(parts["g"]), colorBlue=np.concatenate(parts["b"]))
    if parts["i"]:
        data["intensity"] = np.concatenate(parts["i"])
    update(0.75, t("srv_pointcloud.scrittura_e57"))
    e = pye57.E57(str(out), mode="w")
    try:
        e.write_scan_raw(data, name="MB Desk", rotation=np.array([1.0, 0, 0, 0]), translation=off)
    finally:
        e.close()
    return n


def _write_ply(out, meta, blocks, update):
    cols = [("x", "<f8"), ("y", "<f8"), ("z", "<f8")]
    if meta["rgb"]:
        cols += [("red", "u1"), ("green", "u1"), ("blue", "u1")]
    if meta["i"]:
        cols += [("intensity", "<f4")]
    if meta["c"]:
        cols += [("classification", "u1")]
    dt = np.dtype(cols)
    tnames = {"<f8": "double", "u1": "uchar", "<f4": "float"}
    n = 0
    with open(out, "wb") as f:
        hdr_pos = None
        head = lambda k: ("ply\nformat binary_little_endian 1.0\ncomment MB Desk\nelement vertex " + str(k).ljust(12) + "\n"  # noqa: E731
                          + "".join(f"property {tnames[t]} {nm}\n" for nm, t in cols) + "end_header\n").encode("ascii")
        hdr_pos = len(head(0))
        f.write(head(0))
        for b in blocks:
            k = len(b["xyz"])
            if not k:
                continue
            a = np.empty(k, dt)
            a["x"], a["y"], a["z"] = b["xyz"][:, 0], b["xyz"][:, 1], b["xyz"][:, 2]
            if meta["rgb"]:
                a["red"], a["green"], a["blue"] = b["rgb"][:, 0], b["rgb"][:, 1], b["rgb"][:, 2]
            if meta["i"]:
                a["intensity"] = b["i"]
            if meta["c"]:
                a["classification"] = b["c"]
            f.write(a.tobytes())
            n += k
            update(b["done"], t("srv_pointcloud.scrittura_n", _num(n)))
        f.seek(0)
        h = head(n)
        assert len(h) == hdr_pos
        f.write(h)
    return n


def _num_matrix(v, dec):
    """Numeri a virgola fissa come matrice di caratteri ASCII (spazi a sinistra): molto piu' veloce di np.savetxt."""
    n = np.round(np.asarray(v, np.float64) * 10 ** dec).astype(np.int64)
    neg = n < 0
    a = np.abs(n)
    nd = max(dec + 1, len(str(int(a.max(initial=0)))))
    D = np.empty((len(a), nd), np.uint8)
    for j in range(nd - 1, -1, -1):
        D[:, j] = a % 10
        a //= 10
    sig = np.maximum.accumulate(D != 0, axis=1)
    sig[:, nd - dec - 1:] = True  # almeno una cifra intera ("0.5")
    out = np.full((len(D), nd + 1 + (1 if dec else 0)), 32, np.uint8)
    body = np.where(sig, D + 48, 32).astype(np.uint8)
    if dec:
        out[:, 1:nd - dec + 1] = body[:, :nd - dec]
        out[:, nd - dec + 1] = 46
        out[:, nd - dec + 2:] = body[:, nd - dec:]
    else:
        out[:, 1:] = body
    first = sig.argmax(axis=1)  # il segno va subito prima della prima cifra significativa
    rows = np.flatnonzero(neg)
    out[rows, first[rows]] = 45
    return out


def _text_rows(cols) -> bytes:
    n = len(cols[0][0])
    parts = []
    for k, (v, dec) in enumerate(cols):
        parts.append(_num_matrix(v, dec))
        parts.append(np.full((n, 1), 10 if k == len(cols) - 1 else 32, np.uint8))
    return np.hstack(parts).tobytes()


def _write_text(out, meta, blocks, ext, update):
    """Testo: x y z [intensita'] [r g b] (stesso ordine del PTS di Leica; in PTS l'intensita' va da -2048 a 2047)."""
    sc = _scale_for(meta)
    dec = max(0, min(6, int(round(-np.log10(sc)))))
    rng = meta["i_range"] or [0, 1, 0, 1]
    idec = 0 if rng[3] - rng[2] > 50 else 4
    n = 0
    with open(out, "wb") as f:
        if ext == "pts":
            f.write(b" " * 16 + b"\n")  # numero di punti, scritto alla fine
        for b in blocks:
            k = len(b["xyz"])
            if not k:
                continue
            cols = [(b["xyz"][:, 0], dec), (b["xyz"][:, 1], dec), (b["xyz"][:, 2], dec)]
            if ext == "pts":
                iv = np.zeros(k) if b["i"] is None else (b["i"] - rng[0]) / max(rng[1] - rng[0], 1e-9) * 4095 - 2048
                cols.append((np.clip(iv, -2048, 2047), 0))
            elif b["i"] is not None:
                cols.append((b["i"], idec))
            if b["rgb"] is not None:
                cols += [(b["rgb"][:, 0], 0), (b["rgb"][:, 1], 0), (b["rgb"][:, 2], 0)]
            f.write(_text_rows(cols))
            n += k
            update(b["done"], t("srv_pointcloud.scrittura_n", _num(n)))
        if ext == "pts":
            f.seek(0)
            f.write(str(n).ljust(16).encode("ascii"))
    return n
