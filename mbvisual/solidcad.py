"""File SolidWorks (.sldprt/.sldasm/.slddrw) e Solid Edge (.par/.psm/.asm/.dft) senza i programmi originali.

- Contenitori: SolidWorks fino al 2014 e Solid Edge = file composti OLE; SolidWorks dal 2015 = sezioni con intestazione
  14 00 06 00 08 00, nome con i semibyte scambiati e dati compressi deflate (formato ricavato dall'analisi dei file).
- Passo 1 (sempre): anteprima incorporata, proprieta' (riepilogo, personalizzate, per configurazione), materiale,
  configurazioni e, per assiemi e tavole, i file referenziati (con verifica della presenza su disco).
- Passo 2 (tentativo): il modello esatto e' in formato Parasolid (mbvisual.parasolid) e si converte in STEP
  (mbvisual.xt2step) per il visualizzatore 3D. Gli assiemi SolidWorks si compongono dalle matrici dell'albero XML
  (swXmlContents/COMPINSTANCETREE) leggendo i file delle parti dalla cartella dell'assieme.
"""
import hashlib
import io
import json
import os
import re
import struct
import time
import zlib
from collections import Counter

from . import olepropset, parasolid, xt2step
from .i18n import t as tr
from .paths import TEMP_DIR

VERSION = "4"  # cambia quando cambia la conversione: invalida la cache
# estensioni gestite (i nomi dei tipi sono nelle traduzioni srv_solidcad.tipo_<estensione>)
SW_EXTS = {"sldprt", "sldasm", "slddrw", "prtdot", "asmdot", "drwdot"}
SE_EXTS = {"par", "psm", "asm", "dft", "pwd"}
XT_EXTS = {"x_t", "x_b", "xmt_txt", "xmt_bin", "p_t", "p_b", "xmp_txt", "xmp_bin"}
OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
SW_MARK = b"\x14\x00\x06\x00\x08\x00"


def _ext(path):
    return os.path.splitext(path)[1].lower().lstrip(".")


# ---------------------------------------------------------------- contenitori
class Container:
    """Accesso uniforme ai flussi del file: names() e get(nome) -> bytes (i flussi *__ZLB gia' decompressi)."""

    def __init__(self, path):
        self.path = path
        with open(path, "rb") as f:
            head = f.read(8)
        self.ole = None
        self.sections = {}
        if head == OLE_MAGIC:
            import olefile
            self.ole = olefile.OleFileIO(path)
            self.kind = "ole"
        else:
            data = open(path, "rb").read()
            self.sections = sw_sections(data)
            self.kind = "sw2015" if self.sections else "raw"
            self.raw = data

    def names(self):
        if self.ole is not None:
            return ["/".join(e) for e in self.ole.listdir()]
        return list(self.sections)

    def get(self, name):
        if self.ole is not None:
            for cand in (name, name + "__ZLB"):
                if self.ole.exists(cand):
                    d = self.ole.openstream(cand).read()
                    return _unzlb(d) if cand.endswith("__ZLB") else d
            return None
        return self.sections.get(name)

    def close(self):
        if self.ole is not None:
            self.ole.close()


def sw_sections(data: bytes):
    """Sezioni del formato SolidWorks 2015+: per ogni nome si tiene l'ultima copia valida."""
    out = {}
    for m in re.finditer(re.escape(SW_MARK), data):
        a = m.start()
        if a + 26 > len(data):
            break
        _k1, _k2, csize, usize, nlen = struct.unpack_from("<IIIII", data, a + 6)
        if nlen == 0 or nlen > 512 or a + 26 + nlen + csize > len(data):
            continue
        raw_name = data[a + 26:a + 26 + nlen]
        name = bytes(((x << 4) | (x >> 4)) & 0xFF for x in raw_name).decode("latin-1")
        if not name.isprintable():
            continue
        try:
            body = zlib.decompressobj(-15).decompress(data[a + 26 + nlen:a + 26 + nlen + csize])
        except zlib.error:
            continue
        if len(body) != usize:
            continue
        out[name] = _unzlb_inner(body) if name.endswith("__ZLB") else body
    return out


SW_GUID = bytes.fromhex("231dd571da8148a2a85898b21b89ef99")


def _chunks(d: bytes, p: int, end: int):
    """Dati compressi a pezzi: [dimensione estesa u32][dimensione compressa u32][zlib] ripetuti."""
    out = []
    while p + 8 <= end:
        ulen, clen = struct.unpack_from("<II", d, p)
        if clen == 0 or p + 8 + clen > len(d):
            break
        try:
            u = zlib.decompress(d[p + 8:p + 8 + clen])
        except zlib.error:
            break
        out.append(u)
        p += 8 + clen
    return b"".join(out), p


def _unzlb(d: bytes):
    """Flussi *__ZLB delle versioni OLE: GUID (16) + pezzi compressi."""
    if d[:16] == SW_GUID:
        u, _ = _chunks(d, 16, len(d))
        if u:
            return u
    if len(d) > 20:
        try:
            return zlib.decompress(d[20:])
        except zlib.error:
            pass
    return d


def sw_records(d: bytes):
    """Flussi delle partizioni SolidWorks: record [lunghezza u32][GUID][pezzi compressi]; ritorna i record estesi."""
    # i record possono essere preceduti da altri dati (es. LocalBodies): si cercano i GUID e si salta il contenuto
    out = []
    end_prev = 0
    for m in re.finditer(re.escape(SW_GUID), d):
        g = m.start()
        if g < end_prev or g < 4:
            continue
        reclen = struct.unpack_from("<I", d, g - 4)[0]
        if reclen < 24:
            continue
        u, stop = _chunks(d, g + 16, min(len(d), g + reclen))
        if u:
            out.append(u)
            end_prev = max(stop, g + 16)
    return out


def _unzlb_inner(d):
    return d


def _zlib_blobs(d: bytes, limit=64):
    """Tutti i blocchi zlib validi dentro un flusso (i dati Parasolid di SolidWorks sono compressi a pezzi)."""
    out = []
    for m in re.finditer(rb"x[\x01\x5e\x9c\xda]", d):
        try:
            z = zlib.decompressobj()
            u = z.decompress(d[m.start():], 400_000_000)
        except zlib.error:
            continue
        if len(u) > 16:
            out.append(u)
            if len(out) >= limit:
                break
    return out


def _xml_text(b: bytes):
    if b is None:
        return ""
    if b[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return b.decode("utf-16", "replace")
    if b[:1] == b"\x86":  # alcuni XML SolidWorks hanno un byte di testa
        b = b[1:]
    return b.decode("utf-8", "replace")


def _utf16_strings(d: bytes, minlen=4):
    return [m.group().decode("utf-16-le") for m in re.finditer(rb"(?:[\x20-\x7e]\x00){%d,}" % minlen, d)]


# ---------------------------------------------------------------- riconoscimento
def detect(path):
    """'sw' | 'se' | 'xt' | None, dal contenuto (non dall'estensione)."""
    with open(path, "rb") as f:
        head = f.read(4096)
    if head[:2] == b"**" and b"PARASOLID" in head[:300]:
        return "xt"
    if head[:4] == b"PS\x00\x00" or (head[:1] == b"T" and b"TRANSMIT FILE" in head[:80]):
        return "xt"
    if head[:8] == OLE_MAGIC:
        try:
            import olefile
            o = olefile.OleFileIO(path)
            names = ["/".join(e) for e in o.listdir()]
            o.close()
        except Exception:
            return None
        if any(n.startswith(("Contents/", "swXmlContents")) or n in ("Header2", "PreviewPNG") for n in names):
            return "sw"
        if any(n.startswith(("PARASOLID/", "JSite", "PSM")) or n in ("JSitesList", "JBlocks", "Attachments") for n in names):
            return "se"
        return None
    if head[4:8] == b"\x00\x00\x00\x04" and SW_MARK in head:
        return "sw"
    return None


# ---------------------------------------------------------------- proprieta'
def _props_from_ole(c: Container, out):
    seen = set()
    for name in c.names():
        base = name.split("/")[-1]
        if not (base.startswith("\x05") or base.endswith("-Properties") or base == "ISolidWorksInformation"):
            continue
        try:
            secs = olepropset.parse(c.get(name))
        except Exception:
            continue
        cfg = base[:-len("-Properties")] if base.endswith("-Properties") else ""
        for sec in secs:
            fmt = sec["fmtid"]
            for pid, v in sec["props"].items():
                if pid >= 0x80000000 or pid in (17,) and fmt.startswith("F29F85E0"):
                    continue
                label = sec["names"].get(pid)
                if label is None:
                    key = (olepropset.SUMMARY_NAMES if fmt.startswith("F29F85E0") else
                           olepropset.DOCSUMMARY_NAMES if fmt.startswith("D5CDD502") else {}).get(pid)
                    label = tr("srv_solidcad.p_" + key) if key else None
                if not label or isinstance(v, (bytes, bytearray)) or label in ("Large DIB", "Small DIB"):
                    continue
                txt = olepropset.fmt(v).strip()
                if not txt:
                    continue
                group = tr("srv_solidcad.g_riepilogo") if fmt.startswith(("F29F85E0", "D5CDD502")) else tr("srv_solidcad.g_config", cfg.replace("Config-", "")) if cfg else (
                    tr("srv_solidcad.g_swinfo") if base == "ISolidWorksInformation" else tr("srv_solidcad.g_personalizzate"))
                key = (group, label, txt)
                if key not in seen:
                    seen.add(key)
                    out.append({"gruppo": group, "nome": label, "valore": txt})


def _props_from_xml(c: Container, out):
    for name in c.names():
        if not name.startswith("docProps/") or not name.endswith(".xml"):
            continue
        x = _xml_text(c.get(name))
        base = name[len("docProps/"):-4]
        if base == "core":
            for tag, key in (("dc:creator", "autore"), ("dc:title", "titolo"), ("cp:lastModifiedBy", "ultimo_autore"),
                             ("dcterms:created", "creato"), ("dcterms:modified", "ultimo_salvataggio"), ("dc:subject", "oggetto"),
                             ("cp:keywords", "parole_chiave"), ("dc:description", "commenti")):
                m = re.search(rf"<{tag}[^>]*>([^<]+)</{tag}>", x)
                if m:
                    out.append({"gruppo": tr("srv_solidcad.g_riepilogo"), "nome": tr("srv_solidcad.p_" + key), "valore": _xml_unescape(m.group(1))})
            continue
        if base == "app":
            for tag, key in (("Application", "applicazione"), ("AppVersion", "versione_app"), ("Company", "societa")):
                m = re.search(rf"<{tag}>([^<]+)</{tag}>", x)
                if m:
                    out.append({"gruppo": tr("srv_solidcad.g_riepilogo"), "nome": tr("srv_solidcad.p_" + key), "valore": _xml_unescape(m.group(1))})
            continue
        group = tr("srv_solidcad.g_personalizzate") if base == "custom" else tr("srv_solidcad.g_swinfo") if base == "ISolidWorksInformation" else (
            tr("srv_solidcad.g_config", base.replace("Config-", "").replace("-Properties", "")) if base.startswith("Config-") else base)
        if "Cutlist" in base:
            group = tr("srv_solidcad.g_distinta")
        for m in re.finditer(r'<property name="([^"]+)" pid="\d+">(.*?)</property>', x, re.S):
            label, body = _xml_unescape(m.group(1)), m.group(2)
            ev = re.search(r"<FPVals>\s*<vt:\w+>(.*?)</vt:\w+>", body, re.S)
            val = re.search(r"<vt:\w+>(.*?)</vt:\w+>", body, re.S)
            txt = _xml_unescape((ev or val).group(1)) if (ev or val) else ""
            if txt.strip():
                out.append({"gruppo": group, "nome": label, "valore": txt.strip()})


def _xml_unescape(s):
    return s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&apos;", "'").replace("&amp;", "&")


def _material(c: Container, props, cad):
    if cad == "sw":
        x = _xml_text(c.get("swXmlContents/MATERIALTREE"))
        m = re.search(r'<material name="([^"]+)"', x)
        if m:
            return m.group(1).split("|")[-1]
    for p in props:
        if p["nome"].lower() in ("material", "materiale"):
            return p["valore"]
    return ""


def _configurations(c: Container, cad):
    if cad != "sw":
        return []
    names = []
    x = _xml_text(c.get("swXmlContents/COMPINSTANCETREE"))
    for m in re.finditer(r'<swConfiguration [^>]*swName="([^"]+)"[^>]*swID="(\d+)"', x):
        names.append({"id": int(m.group(2)), "nome": _xml_unescape(m.group(1))})
    ids = sorted({int(m.group(1)) for n in c.names() for m in [re.match(r"Contents/Config-(\d+)-Partition", n)] if m})
    if not names:
        cm = c.get("Contents/CMgr") or b""
        strs = [s for s in _utf16_strings(cm, 2) if not s.startswith(("mo", "dm"))]
        for i in ids:
            names.append({"id": i, "nome": strs[i] if i < len(strs) else tr("srv_solidcad.config_n", i)})
    for n in names:
        n["geometria"] = n["id"] in ids
    return names


# ---------------------------------------------------------------- anteprima
def _preview(c: Container, cad, out_dir):
    """Salva l'anteprima incorporata come PNG e ne ritorna il percorso (o None)."""
    os.makedirs(out_dir, exist_ok=True)
    target = os.path.join(out_dir, "anteprima.png")
    png = c.get("PreviewPNG")
    if png and png[:4] == b"\x89PNG":
        open(target, "wb").write(png)
        return target
    dib = c.get("Preview")
    if not dib and cad == "se":
        for name in c.names():
            if name.split("/")[-1].startswith("\x05"):
                try:
                    for sec in olepropset.parse(c.get(name)):
                        for pid, v in sec["props"].items():
                            if sec["names"].get(pid) == "Large DIB" and isinstance(v, (bytes, bytearray)) and len(v) > 64:
                                dib = v
                except Exception:
                    pass
            if dib:
                break
        if not dib:
            for sec in olepropset.parse(c.get("\x05SummaryInformation") or b""):
                th = sec["props"].get(17)
                if isinstance(th, (bytes, bytearray)) and len(th) > 64:
                    dib = th[8:] if struct.unpack_from("<i", th, 0)[0] == -1 else th
    if dib:
        img = _dib_to_png(dib, target)
        if img:
            return img
    return None


def _dib_to_png(dib: bytes, target):
    from PIL import Image
    data = bytes(dib)
    # alcune anteprime hanno 4 byte di lunghezza prima dell'intestazione BITMAPINFOHEADER (40)
    for skip in (0, 4, 8):
        hdr = data[skip:skip + 4]
        if len(hdr) == 4 and struct.unpack("<I", hdr)[0] in (40, 108, 124):
            body = data[skip:]
            size, w, h, planes, bpp, comp = struct.unpack_from("<IiiHHI", body, 0)
            ncol = struct.unpack_from("<I", body, 32)[0] or (1 << bpp if bpp <= 8 else 0)
            off = 14 + size + ncol * 4 + (12 if comp == 3 and size == 40 else 0)
            bmp = b"BM" + struct.pack("<IHHI", 14 + len(body), 0, 0, off) + body
            try:
                im = Image.open(io.BytesIO(bmp))
                im.load()
                im.save(target)
                return target
            except Exception:
                continue
    try:
        im = Image.open(io.BytesIO(data))  # forse un metafile o un'immagine completa
        im.load()
        im.save(target)
        return target
    except Exception:
        return None


# ---------------------------------------------------------------- componenti (assiemi e tavole)
def _sw_tree(c: Container):
    """Albero di assieme SolidWorks da COMPINSTANCETREE: {file id: percorso}, modelli e riferimenti con matrici."""
    x = _xml_text(c.get("swXmlContents/COMPINSTANCETREE"))
    if not x:
        return None
    files = {m.group(1): (_xml_unescape(m.group(3)), m.group(2)) for m in re.finditer(r'<swFile id="(\d+)" swDocType="(\w+)"[^>]*swPath="([^"]*)"', x)}
    models = {}
    for m in re.finditer(r"<swModel (.*?)(/>|>(.*?)</swModel>)", x, re.S):
        attrs = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1)))
        refs = []
        for r in re.finditer(r"<swReference ([^>]*)/?>", m.group(3) or ""):
            ra = dict(re.findall(r'(\w+)="([^"]*)"', r.group(1)))
            refs.append(ra)
        models[attrs.get("id")] = {"attrs": attrs, "refs": refs}
    configs = [dict(re.findall(r'(\w+)="([^"]*)"', m.group(1))) for m in re.finditer(r"<swConfiguration ([^>]*)/?>", x)]
    return {"files": files, "models": models, "configs": configs}


def find_file(stored_path, base_dir, own_dir=None):
    """Trova su disco un file referenziato: percorso salvato, stessa cartella, sottocartelle (fino a 3 livelli)."""
    if not stored_path:
        return None
    name = re.split(r"[\\/]", stored_path)[-1]
    cands = [stored_path, os.path.join(base_dir, name)]
    if own_dir:
        cands.append(os.path.join(own_dir, name))
    for p in cands:
        if p and os.path.isfile(p):
            return p
    low = name.lower()
    for root, dirs, files in os.walk(base_dir):
        if root[len(base_dir):].count(os.sep) >= 3:
            dirs[:] = []
        for f in files:
            if f.lower() == low:
                return os.path.join(root, f)
    return None


def _components(c: Container, cad, path):
    base = os.path.dirname(path)
    comps = {}
    if cad == "sw":
        tree = _sw_tree(c)
        if tree:
            counts = Counter()
            for mdl in tree["models"].values():
                for r in mdl["refs"]:
                    sub = tree["models"].get(r.get("swModelRef"), {})
                    fid = sub.get("attrs", {}).get("swFileRef")
                    if fid in tree["files"]:
                        counts[tree["files"][fid][0]] += 1
            for fid, (p, typ) in tree["files"].items():
                if os.path.normcase(os.path.basename(p)) == os.path.normcase(os.path.basename(path)):
                    continue
                comps[p.lower()] = {"nome": re.split(r"[\\/]", p)[-1], "percorso": p, "istanze": counts.get(p, 0) or None}
        else:
            for name in c.names():
                if name.startswith(("Contents/Config", "Header2", "Contents/CMgr", "SwDocContentMgr")):
                    for s in _utf16_strings(c.get(name) or b""):
                        if re.search(r"\.(sldprt|sldasm)$", s, re.I) and os.path.basename(s).lower() != os.path.basename(path).lower():
                            comps.setdefault(s.lower(), {"nome": re.split(r"[\\/]", s)[-1], "percorso": s, "istanze": None})
    elif cad == "se":
        for name in c.names():
            if name.startswith("JSite") and name.endswith("Ole"):
                d = c.get(name) or b""
                paths = [s for s in _utf16_strings(d)] + [m.group().decode("latin-1") for m in re.finditer(rb"[\x20-\x7e]{5,}", d)]
                full = [s for s in paths if re.search(r"^[a-zA-Z]:\\|^\\\\", s) and re.search(r"\.(par|psm|asm|pwd|dft)$", s, re.I) and "~" not in s]
                if full:
                    p = max(full, key=len)
                    comps.setdefault(os.path.basename(p).lower(), {"nome": re.split(r"[\\/]", p)[-1], "percorso": p, "istanze": None})
        att = c.get("Attachments") or b""
        counts = Counter(re.sub(r":\d+$", "", s).lower() for s in _utf16_strings(att) if re.search(r"\.(par|psm|asm):\d+$", s, re.I))
        for k, v in comps.items():
            v["istanze"] = counts.get(v["nome"].lower()) or None
    out = []
    for v in comps.values():
        found = find_file(v["percorso"], base)
        v["trovato"] = found
        out.append(v)
    out.sort(key=lambda v: v["nome"].lower())
    return out


# ---------------------------------------------------------------- geometria Parasolid dentro il file
def parasolid_streams(c: Container, cad, config=None):
    """Lista di (descrizione, bytes) dei dati Parasolid che contengono i corpi del modello."""
    out = []
    if cad == "se":
        for name in sorted(c.names()):
            if name.upper().startswith("PARASOLID/") and not name.upper().startswith("PARASOLID/SKETCH"):
                if name.upper().endswith((".X_B", ".X_T", ".P_B", ".P_T")):
                    out.append((name, c.get(name)))
        # le parti con STREAM0.X_B hanno anche la partizione: si preferisce il file di parte
        if any(n.upper().endswith((".X_B", ".X_T")) for n, _ in out):
            out = [(n, d) for n, d in out if n.upper().endswith((".X_B", ".X_T"))]
        return out
    if cad == "sw":
        names = [n for n in c.names() if re.match(r"Contents/Config-\d+-Partition$", n)]
        if config is not None:
            names = [n for n in names if n == f"Contents/Config-{config}-Partition"] or names
        names.sort(key=lambda n: int(re.findall(r"\d+", n)[0]))
        for name in names[:1]:
            d = c.get(name) or b""
            for blob in sw_records(d) or _zlib_blobs(d):
                if blob[:4] == b"PS\x00\x00" and b"(deltas)" not in blob[:80]:
                    out.append((name, blob))
            if not out and d[:4] == b"PS\x00\x00":
                out.append((name, d))
        return out
    return out


def load_bodies(path, cad, c=None, config=None):
    """Legge i dati Parasolid di un file SolidWorks/Solid Edge/XT: lista di XTFile."""
    own = c is None
    if own:
        c = Container(path) if cad != "xt" else None
    try:
        if cad == "xt":
            return [parasolid.parse(open(path, "rb").read())]
        xts = []
        errors = []
        for name, data in parasolid_streams(c, cad, config):
            try:
                xts.append(parasolid.parse(data))
            except parasolid.XTError as e:
                errors.append(f"{name}: {e}")
        if cad == "sw" and not any(xt2step.Model(x).bodies for x in xts):
            # partizione vuota (succede in alcuni file): i corpi sono in Config-N-FeatureBodies/LocalBodies
            cfgs = sorted(n for n in c.names() if re.match(r"Config-\d+-FeatureBodies/LocalBodies$", n))
            if config is not None:
                cfgs = [n for n in cfgs if n.startswith(f"Config-{config}-")] or cfgs
            for name in cfgs[:1]:
                d = c.get(name) or b""
                for blob in sw_records(d) or _zlib_blobs(d):
                    k = blob.find(b"PS\x00\x00", 0, 64)
                    if k >= 0:
                        try:
                            xts.append(parasolid.parse(blob[k:]))
                        except parasolid.XTError as e:
                            errors.append(f"{name}: {e}")
        if not xts and errors:
            raise parasolid.XTError("; ".join(errors))
        return xts
    finally:
        if own and c is not None:
            c.close()


# ---------------------------------------------------------------- API
def cache_dir(path, extra=""):
    st = os.stat(path)
    key = hashlib.sha1(f"{path}|{st.st_size}|{st.st_mtime}|{VERSION}|{extra}".encode()).hexdigest()[:16]
    d = TEMP_DIR / "solidcad" / key
    d.mkdir(parents=True, exist_ok=True)
    return d


def info(path):
    """Passo 1: anteprima, proprieta', configurazioni, materiale, componenti. Veloce, nessuna conversione."""
    cad = detect(path)
    ext = _ext(path)
    res = {"cad": cad, "tipo": tr("srv_solidcad.tipo_" + ext) if ext in SW_EXTS or ext in SE_EXTS or ext in XT_EXTS else tr("srv_solidcad.tipo_cad"), "proprieta": [],
           "configurazioni": [], "componenti": [], "materiale": "", "anteprima": None, "geometria": False, "avvisi": []}
    if cad is None:
        res["avvisi"].append(tr("srv_solidcad.non_riconosciuto"))
        return res
    if cad == "xt":
        head, _ = parasolid._parse_header(open(path, "rb").read(8192))
        for k, key in (("APPL", "applicazione"), ("FRU", "kernel"), ("DATE", "data"), ("USER", "utente"), ("SCH", "schema"), ("FILE", "file_origine")):
            if head.get(k) and head[k] != "unknown":
                res["proprieta"].append({"gruppo": tr("srv_solidcad.g_intestazione_xt"), "nome": tr("srv_solidcad.p_" + key), "valore": head[k]})
        res["geometria"] = True
        return res
    c = Container(path)
    try:
        if c.kind == "ole":
            _props_from_ole(c, res["proprieta"])
        else:
            _props_from_xml(c, res["proprieta"])
        if cad == "sw":
            res["formato"] = tr("srv_solidcad.formato_sw2015") if c.kind == "sw2015" else tr("srv_solidcad.formato_swole")
        else:
            res["formato"] = tr("srv_solidcad.formato_se")
        res["materiale"] = _material(c, res["proprieta"], cad)
        res["configurazioni"] = _configurations(c, cad)
        try:
            res["anteprima"] = _preview(c, cad, str(cache_dir(path, "info")))
        except Exception as e:  # noqa: BLE001
            res["avvisi"].append(tr("srv_solidcad.anteprima_errore", e))
        if ext in ("sldasm", "slddrw", "asm", "dft", "pwd", "asmdot", "drwdot") or cad == "se" and any(n.startswith("JSite") for n in c.names()):
            res["componenti"] = _components(c, cad, path)
        if ext in ("sldasm", "asmdot"):
            res["geometria"] = bool(_sw_tree(c)) or bool(parasolid_streams(c, cad))
        elif ext in ("slddrw", "drwdot", "dft"):
            res["geometria"] = False
        else:
            res["geometria"] = bool(parasolid_streams(c, cad))
        if not res["geometria"] and ext in ("sldprt", "par", "psm", "prtdot"):
            res["avvisi"].append(tr("srv_solidcad.senza_modello"))
    finally:
        c.close()
    return res


def to_step(path, config=None, update=None):
    """Passo 2: converte la geometria in STEP. Ritorna {step, resoconto, ...}. Usa una cache su disco."""
    update = update or (lambda *a, **k: None)
    cad = detect(path)
    if cad is None:
        raise ValueError(tr("srv_solidcad.non_riconosciuto"))
    ext = _ext(path)
    name = os.path.splitext(os.path.basename(path))[0]
    if cad == "sw" and ext in ("sldasm", "asmdot"):
        return _sw_assembly_step(path, name, config, update)
    d = cache_dir(path, f"step|{config}")
    target = d / "modello.stp"
    meta = d / "resoconto.json"
    if target.exists() and meta.exists():
        return json.loads(meta.read_text(encoding="utf-8"))
    update(0.1, tr("srv_solidcad.lettura"))
    t0 = time.time()
    xts = load_bodies(path, cad, config=config)
    if not xts:
        raise ValueError(tr("srv_solidcad.senza_modello"))
    update(0.4, tr("srv_solidcad.conversione"))
    b = xt2step.StepBuilder(name)
    parts = []
    for i, xt in enumerate(xts):
        m = xt2step.Model(xt, name)
        if m.instances:
            step, rep = xt2step.xt_to_step(xt, name)
            if step:
                target.write_text(step, encoding="ascii", errors="replace")
                res = _result(target, rep, [xt], time.time() - t0)
                meta.write_text(json.dumps(res), encoding="utf-8")
                return res
        r = b.part_from_bodies(xt, m.bodies, name if len(xts) == 1 else f"{name} ({i + 1})")
        if r:
            parts.append(r)
    if not parts:
        raise ValueError(tr("srv_solidcad.niente_solidi"))
    if len(parts) > 1:
        b.assembly(name, [(pd, rep, None, "") for pd, rep in parts])
    target.write_text(b.text(), encoding="ascii", errors="replace")
    res = _result(target, b.report, xts, time.time() - t0)
    meta.write_text(json.dumps(res), encoding="utf-8")
    return res


def _result(target, rep, xts, secs):
    rep = dict(rep)
    tot = rep.get("faces", 0)
    ok = rep.get("faces_ok", 0)
    return {"step": str(target), "facce": tot, "convertite": ok, "percentuale": round(100.0 * ok / tot, 1) if tot else 0.0,
            "resoconto": {k: v for k, v in rep.items() if k not in ("faces", "faces_ok")},
            "parasolid": [x.version.split("version")[-1].strip() + " / " + x.schema for x in xts], "secondi": round(secs, 1)}


def _sw_assembly_step(path, name, config, update):
    """Assieme SolidWorks: parti lette dai loro file e posizionate con le matrici di COMPINSTANCETREE."""
    c = Container(path)
    try:
        tree = _sw_tree(c)
        own = parasolid_streams(c, "sw", config)  # corpi creati nell'assieme (rari)
    finally:
        c.close()
    if not tree:
        raise ValueError(tr("srv_solidcad.assieme_senza_albero"))
    base = os.path.dirname(path)
    resolved = {}
    for fid, (p, typ) in tree["files"].items():
        resolved[fid] = find_file(p, base)
    stamp = "|".join(f"{v}:{os.path.getmtime(v) if v else 0}" for v in resolved.values())
    d = cache_dir(path, f"asm|{config}|{hashlib.sha1(stamp.encode()).hexdigest()}")
    target = d / "modello.stp"
    meta = d / "resoconto.json"
    if target.exists() and meta.exists():
        return json.loads(meta.read_text(encoding="utf-8"))
    t0 = time.time()
    b = xt2step.StepBuilder(name)
    models = tree["models"]
    # modello radice: quello dell'assieme stesso (file con lo stesso nome) o la configurazione piu' recente
    root_id = None
    for cfg in tree["configs"]:
        if cfg.get("swMostRecentConfiguration") == "YES" and (config is None or cfg.get("swID") == str(config)):
            root_id = cfg.get("swModelRef")
    if root_id is None:
        for mid, mdl in models.items():
            fid = mdl["attrs"].get("swFileRef")
            if fid in tree["files"] and os.path.basename(tree["files"][fid][0]).lower() == os.path.basename(path).lower():
                root_id = mid
    if root_id is None:
        raise ValueError(tr("srv_solidcad.assieme_senza_radice"))
    part_cache = {}
    missing, failed = Counter(), Counter()
    xts_used = []
    total = sum(len(m["refs"]) for m in models.values()) or 1
    done = [0]

    def part_for(model):
        fid = model["attrs"].get("swFileRef")
        cfg = model["attrs"].get("swConfigurationId")
        key = (fid, cfg)
        if key in part_cache:
            return part_cache[key]
        p = resolved.get(fid)
        res = None
        if not p:
            missing[os.path.basename(tree["files"].get(fid, ("?",))[0])] += 1
        else:
            try:
                cad = detect(p)
                xts = load_bodies(p, cad, config=int(cfg) if cfg and cfg.isdigit() else None)
                bodies = []
                for xt in xts:
                    bodies.append((xt, xt2step.Model(xt).bodies))
                pname = model["attrs"].get("swName") or os.path.splitext(os.path.basename(p))[0]
                # un prodotto per file; piu' corpi Parasolid nello stesso prodotto
                if len(bodies) == 1:
                    res = b.part_from_bodies(bodies[0][0], bodies[0][1], pname)
                else:
                    subs = [r for r in (b.part_from_bodies(xt, bl, pname) for xt, bl in bodies) if r]
                    res = b.assembly(pname, [(pd, rep, None, "") for pd, rep in subs]) if subs else None
                xts_used.extend(xts)
                if res is None:
                    failed[os.path.basename(p)] += 1
            except Exception as e:  # noqa: BLE001
                failed[f"{os.path.basename(p)}: {str(e)[:80]}"] += 1
        part_cache[key] = res
        return res

    def build(model_id, depth=0):
        mdl = models.get(model_id)
        if mdl is None or depth > 12:
            return None
        children = []
        for r in mdl["refs"]:
            done[0] += 1
            update(0.05 + 0.85 * min(1.0, done[0] / total), tr("srv_solidcad.componente_n", done[0], total, r.get("swName", "")))
            if r.get("swSuppressed") == "YES" or r.get("swHidden") == "YES":
                continue
            sub = models.get(r.get("swModelRef"))
            if sub is None:
                continue
            fid = sub["attrs"].get("swFileRef")
            typ = tree["files"].get(fid, ("", ""))[1]
            if sub["refs"] or typ == "ASSEMBLY":
                child = build(r.get("swModelRef"), depth + 1) if sub["refs"] else None
                if child is None and resolved.get(fid):
                    child = _nested_assembly(b, resolved.get(fid), part_for_path=None)
                if child is None:
                    missing[os.path.basename(tree["files"].get(fid, ("?",))[0])] += 1
                    continue
            else:
                child = part_for(sub)
                if child is None:
                    continue
            children.append((*child, _sw_matrix(r.get("swTransform")), f"{r.get('swName', '')}<{r.get('swReferenceNumber', '')}>"))
        if not children:
            return None
        aname = mdl["attrs"].get("swName") or name
        return b.assembly(aname, children)

    top = build(root_id)
    if own:
        for _n, data in own:
            try:
                xt = parasolid.parse(data)
                r = b.part_from_bodies(xt, xt2step.Model(xt).bodies, name + " (corpi dell'assieme)")
                if r and top:
                    pass
            except parasolid.XTError:
                pass
    if top is None:
        raise ValueError(tr("srv_solidcad.assieme_vuoto") + (": " + ", ".join(sorted(missing)) if missing else ""))
    target.write_text(b.text(), encoding="ascii", errors="replace")
    res = _result(target, b.report, xts_used, time.time() - t0)
    res["mancanti"] = sorted(missing)
    res["non_convertiti"] = sorted(failed)
    meta.write_text(json.dumps(res), encoding="utf-8")
    return res


def _nested_assembly(b, path, part_for_path=None):
    """Sotto-assieme senza riferimenti nell'albero del padre: non ancora composto (si segnala come mancante)."""
    return None


def _sw_matrix(s):
    """swTransform: 16 numeri, rotazione 3x3 per righe (vettori riga) e traslazione in coda, in metri."""
    if not s:
        return None
    try:
        v = [float(x) for x in s.split()]
    except ValueError:
        return None
    if len(v) < 16:
        return None
    # p' = p * M (convenzione a vettore riga): x' = v0 x + v4 y + v8 z + v12
    R = [[v[0], v[4], v[8]], [v[1], v[5], v[9]], [v[2], v[6], v[10]]]
    t = (v[12], v[13], v[14])
    s = v[15] if v[15] else 1.0
    return (R, t, 1.0 / s if s != 1.0 else 1.0)
