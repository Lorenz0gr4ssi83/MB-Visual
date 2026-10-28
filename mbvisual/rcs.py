"""Autodesk ReCap: scansioni .rcs (punti) e progetti .rcp (elenco di scansioni registrate).

Il formato .rcs non ha una specifica pubblica: la struttura qui sotto e' stata ricavata da file veri (nessun codice o SDK
Autodesk usato) e verificata confrontando gli stessi punti esportati da ReCap in E57.

File .rcs ("ADOCT", versione 3), tutto little-endian:
  0x00  "ADOCT\\0\\0\\0", u32 versione (3), u32 (2)
  0x10  3 double: traslazione della scansione (coordinate del progetto)
  0x28  3 double: rotazione; 0x40 3 double: scala; 0x58 3 double: di nuovo la traslazione
  0x70  6 double: cubo radice dell'ottree (coordinate locali); 0xa0 6 double: ingombro dei punti (locali)
  0xd0  u32, u32, u64 numero di punti dichiarato, 3 byte (colori, intensita', normali), GUID della scansione
  poi   u32 numero di sezioni + sezioni da 3 u64 (tipo, posizione, dimensione), posizione non allineata: si cerca.
Sezione 2 = voxel: u64 N, poi N record (368 byte): 6 double cubo del voxel, 6 double ingombro, u32 profondita',
  u32 punti, u32 byte dei dati, 16 u32 nodi interni per livello, 16 u32 (0), 16 u32 punti per livello.
Sezione 1 = dati dei voxel, uno dopo l'altro nello stesso ordine: tabella dell'ottree del voxel (u32 per voce:
  bit 27 = foglia con l'indice del punto nei 24 bit bassi; altrimenti bit 19-26 = figli presenti, 16 bit bassi =
  primo figlio nel livello successivo), poi un record di 16 byte per punto:
  u64 con x, y, z da 18 bit ciascuno = millimetri dal minimo del voxel, 4 byte di colore/intensita', u16 normale, u16.
Coordinate di un punto = minimo del voxel + (x, y, z) / 1000 (+ traslazione della scansione).
"""
import struct
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import numpy as np

MAGIC = b"ADOCT"
VOXEL_REC = 368


class RcsError(ValueError):
    """File ReCap non leggibile (codice dell'errore in .code per i messaggi tradotti)."""

    def __init__(self, code, *args):
        super().__init__(code)
        self.code = code
        self.args2 = args


def is_rcs(head: bytes) -> bool:
    return head.startswith(MAGIC)


def _sections(h: bytes, size: int):
    """Tabella delle sezioni: la sua posizione dipende dalla lunghezza dei campi precedenti, quindi si cerca."""
    for p in range(0xd0, min(len(h) - 28, 0x800)):
        c = struct.unpack_from("<I", h, p)[0]
        if not 1 <= c <= 32 or p + 4 + 24 * c > len(h):
            continue
        ent = [struct.unpack_from("<3Q", h, p + 4 + 24 * k) for k in range(c)]
        if not all(0 < ty < 1000 and 0x100 < off < 1 << 44 and ln < 1 << 44 for ty, off, ln in ent):
            continue
        end = max(off + ln for _, off, ln in ent)
        if end == size:
            return {ty: (off, ln) for ty, off, ln in ent}
        if end > size and {1, 2} <= {ty for ty, _, _ in ent}:
            raise RcsError("troncato")
    return None


def read_header(path):
    """Intestazione e voxel della scansione (senza leggere i punti)."""
    size = Path(path).stat().st_size
    with open(path, "rb") as f:
        h = f.read(0x1000)
        if not is_rcs(h):
            raise RcsError("non_rcs")
        ver = struct.unpack_from("<I", h, 8)[0]
        if ver != 3:
            raise RcsError("versione", ver)
        tr = struct.unpack_from("<3d", h, 0x10)
        rot = struct.unpack_from("<3d", h, 0x28)
        scale = struct.unpack_from("<3d", h, 0x40)
        bbox = struct.unpack_from("<6d", h, 0xa0)
        declared = struct.unpack_from("<Q", h, 0xd8)[0]
        flags = h[0xe0:0xe3]
        guid = ""
        if h[0xe3:0xe4] == b"{":
            end = h.find(b"}", 0xe3, 0xe3 + 80)
            if end > 0:
                guid = h[0xe3:end + 1].decode("ascii", "replace").replace("_", "-")
        sec = _sections(h, size)
        if not sec or 1 not in sec or 2 not in sec:
            raise RcsError("struttura")
        voff, vlen = sec[2]
        f.seek(voff)
        nvox = struct.unpack("<Q", f.read(8))[0]
        if not nvox or 8 + nvox * VOXEL_REC > vlen:
            raise RcsError("struttura")
        raw = f.read(nvox * VOXEL_REC)
    rec = np.frombuffer(raw, np.uint8).reshape(nvox, VOXEL_REC)
    vmin = rec[:, :24].copy().view("<f8").reshape(nvox, 3)
    vmax = rec[:, 24:48].copy().view("<f8").reshape(nvox, 3)
    u = rec[:, 96:].copy().view("<u4")
    npts = u[:, 1].astype(np.int64)
    nbytes = u[:, 2].astype(np.int64)
    nodes = u[:, 3:19].sum(axis=1).astype(np.int64)
    doff, dlen = sec[1]
    if int(nbytes.sum()) != dlen or np.any(nbytes != (nodes + npts) * 4 + npts * 16):
        raise RcsError("struttura")
    start = doff + np.concatenate([[0], np.cumsum(nbytes)[:-1]]) + (nodes + npts) * 4
    return {"version": ver, "translation": tr, "rotation": rot, "scale": scale, "bbox": bbox, "declared": declared,
            "rgb": bool(flags[0]) if flags else True, "intensity": bool(flags[1]) if len(flags) > 1 else False,
            "normals": bool(flags[2]) if len(flags) > 2 else False, "guid": guid, "n": int(npts.sum()),
            "voxels": nvox, "vmin": vmin, "vmax": vmax, "npts": npts, "start": start, "size": size}


def _matrix(hd):
    """Rotazione della scansione (angoli in radianti attorno a x, y, z; nei file visti finora sono nulli)."""
    rx, ry, rz = hd["rotation"]
    if not (rx or ry or rz):
        return None
    cx, sx, cy, sy, cz, sz = np.cos(rx), np.sin(rx), np.cos(ry), np.sin(ry), np.cos(rz), np.sin(rz)
    mx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    my = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    mz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return mz @ my @ mx


def iter_points(path, hd, chunk=2_000_000, transform=None):
    """Blocchi (xyz float64 nel sistema del progetto, rgb uint8, intensita' float32 0..1, quota svolta 0..1)."""
    tr = np.asarray(hd["translation"], np.float64)
    rot = _matrix(hd)
    sc = np.asarray(hd["scale"], np.float64)
    if not np.all(np.isfinite(sc)) or not np.all(sc):
        sc = np.ones(3)
    total = max(hd["n"], 1)
    done = 0
    m18 = np.uint64(0x3FFFF)
    with open(path, "rb") as f:
        v = 0
        nv = hd["voxels"]
        while v < nv:
            # voxel uno dopo l'altro fino a riempire il blocco
            w = v
            k = 0
            while w < nv and (k == 0 or k + hd["npts"][w] <= chunk):
                k += int(hd["npts"][w])
                w += 1
            xyz = np.empty((k, 3), np.float64)
            attr = np.empty((k, 8), np.uint8)
            o = 0
            for i in range(v, w):
                m = int(hd["npts"][i])
                if not m:
                    continue
                f.seek(int(hd["start"][i]))
                buf = f.read(m * 16)
                if len(buf) < m * 16:
                    raise RcsError("troncato")
                r = np.frombuffer(buf, np.uint8).reshape(m, 16)
                q = r[:, :8].copy().view("<u8")[:, 0]
                p = xyz[o:o + m]
                p[:, 0] = (q & m18).astype(np.float64)
                p[:, 1] = ((q >> np.uint64(18)) & m18).astype(np.float64)
                p[:, 2] = ((q >> np.uint64(36)) & m18).astype(np.float64)
                p *= 0.001
                p += hd["vmin"][i]
                attr[o:o + m] = r[:, 8:]
                o += m
            xyz *= sc
            if rot is not None:
                xyz = xyz @ rot.T
            xyz += tr
            if transform is not None:
                xyz = xyz @ transform[:3, :3].T + transform[:3, 3]
            done += k
            yield xyz, attr, done / total
            v = w


# ---------------------------------------------------------------------------- progetti .rcp
def read_project(path):
    """Scansioni di un progetto ReCap (.rcp): elenco di (percorso .rcs, matrice 4x4 o None), dati del progetto.

    L'.rcp e' uno zip o un XML con le scansioni (percorsi relativi alla cartella del progetto, di solito
    "<nome> Support/...") e la loro registrazione. Se l'XML non si capisce si prendono tutti gli .rcs della
    cartella di supporto, senza matrici (le traslazioni sono comunque dentro ogni .rcs).
    """
    p = Path(path)
    texts = []
    if zipfile.is_zipfile(p):
        with zipfile.ZipFile(p) as z:
            for n in z.namelist():
                if n.lower().endswith((".xml", ".rcp")) or "." not in n.rsplit("/", 1)[-1]:
                    try:
                        texts.append(z.read(n))
                    except Exception:  # noqa: BLE001
                        pass
    else:
        texts.append(p.read_bytes())
    scans = []
    seen = set()
    for raw in texts:
        try:
            root = ET.fromstring(raw)
        except ET.ParseError:
            continue
        for el in root.iter():
            for key, val in list(el.attrib.items()) + [("", el.text or "")]:
                val = (val or "").strip()
                if val.lower().endswith(".rcs"):
                    f = _resolve(p, val)
                    if f and f not in seen:
                        seen.add(f)
                        scans.append((f, _el_matrix(el)))
    if not scans:  # cartella di supporto accanto al progetto
        for d in (p.with_name(p.stem + " Support"), p.parent):
            if d.is_dir():
                for f in sorted(d.rglob("*.rcs")):
                    if str(f) not in seen:
                        seen.add(str(f))
                        scans.append((str(f), None))
            if scans:
                break
    return scans


def _resolve(proj: Path, val: str):
    val = val.replace("\\", "/")
    cands = [Path(val)] if Path(val).is_absolute() else []
    cands.append(proj.parent / val)
    name = val.rsplit("/", 1)[-1]
    cands += [proj.with_name(proj.stem + " Support") / name, proj.parent / name]
    for c in cands:
        try:
            if c.is_file():
                return str(c)
        except OSError:
            pass
    sup = proj.with_name(proj.stem + " Support")
    if sup.is_dir():
        for c in sup.rglob(name):
            return str(c)
    return None


def _el_matrix(el):
    """Matrice 4x4 vicino al riferimento della scansione (attributo o figlio con 16 numeri), se c'e'."""
    for node in [el] + list(el):
        for v in list(node.attrib.values()) + [node.text or ""]:
            parts = v.replace(",", " ").split()
            if len(parts) == 16:
                try:
                    m = np.array([float(x) for x in parts]).reshape(4, 4)
                except ValueError:
                    continue
                if np.allclose(m[3], [0, 0, 0, 1]):
                    return m
                if np.allclose(m[:, 3], [0, 0, 0, 1]):
                    return m.T
    return None
