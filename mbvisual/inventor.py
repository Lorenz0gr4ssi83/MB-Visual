# Autodesk Inventor (.ipt parti, .iam assiemi, .idw/.dwg tavole, .ipn presentazioni) senza Inventor.
# Lettore scritto da zero. I file sono documenti OLE (compound file, letti con olefile - licenza BSD):
# - insiemi di proprieta' (MS-OLEPS, specifica pubblica Microsoft): iProperties e anteprima PNG/BMP
# - RSeStorage: "segmenti" Inventor; ogni segmento ha un flusso M<nome> (meta, col tipo del segmento) e
#   B<nome> (dati compressi zlib). Il segmento PmBRepSegment contiene il solido in formato ShapeManager
#   binario ("ASM BinaryFile4"), decodificato da acis.py e scritto in STEP da acis_step.py.
from __future__ import annotations

import io
import os
import re
import struct
import uuid
import zlib
from datetime import datetime, timedelta, timezone

import olefile
from .i18n import t as tr

# ---------------------------------------------------------------- insiemi di proprieta' (MS-OLEPS)

# chiavi dei nomi delle proprieta' piu' usate (tradotte con tr) (identificativi pubblici dell'API di Inventor)
NOMI = {
    "Inventor Summary Information": {2: "srv_inventor.titolo", 3: "srv_inventor.oggetto", 4: "srv_inventor.autore", 5: "srv_inventor.parole_chiave", 6: "srv_inventor.commenti",
                                     8: "srv_inventor.ultimo_salvataggio", 9: "srv_inventor.revisione", 18: "srv_inventor.programma"},
    "Inventor Document Summary Information": {2: "srv_inventor.categoria", 14: "srv_inventor.responsabile", 15: "srv_inventor.societa"},
    "Design Tracking Properties": {4: "srv_inventor.data_creazione", 5: "srv_inventor.codice_parte", 7: "srv_inventor.progetto", 9: "srv_inventor.centro_costo",
                                   10: "srv_inventor.controllato", 11: "srv_inventor.data_controllo", 12: "srv_inventor.approvato_progettazione",
                                   13: "srv_inventor.data_approvazione_progettazione", 17: "srv_inventor.stato", 20: "srv_inventor.materiale",
                                   23: "srv_inventor.collegamento_web", 28: "srv_inventor.commessa", 29: "srv_inventor.descrizione", 30: "srv_inventor.fornitore",
                                   32: "srv_inventor.nome_sottotipo_documento", 34: "srv_inventor.approvato_produzione",
                                   35: "srv_inventor.data_approvazione_produzione", 36: "srv_inventor.codice_parte_designazione",
                                   41: "srv_inventor.progettista", 42: "srv_inventor.ingegnere", 43: "srv_inventor.autorizzato", 44: "srv_inventor.note_parametri",
                                   47: "srv_inventor.unita_misura_distinta", 48: "srv_inventor.data_modifica", 55: "srv_inventor.codice_magazzino",
                                   58: "srv_inventor.massa", 59: "srv_inventor.area", 60: "srv_inventor.volume", 61: "srv_inventor.densita",
                                   67: "srv_inventor.aggiornato", 72: "srv_inventor.aspetto"},
}
# proprieta' interne da non mostrare
# unita' delle proprieta' fisiche (Inventor le salva in g, cm2, cm3, g/cm3)
UNITA = {"Design Tracking Properties": {58: "g", 59: "cm²", 60: "cm³", 61: "g/cm³"}}
NASCOSTE = {"Design Tracking Properties": {21, 31, 46, 62, 40, 71}, "Design Tracking Control": None,
            "_Private Model Information": None, "_PostAdaInternalDateMigration": None}

_EPOCH = datetime(1601, 1, 1, tzinfo=timezone.utc)


def _read_value(d: bytes, o: int, codepage: int):
    t = struct.unpack_from("<H", d, o)[0]
    o += 4
    if t == 0x02:
        return struct.unpack_from("<h", d, o)[0]
    if t in (0x03, 0x16):
        return struct.unpack_from("<i", d, o)[0]
    if t in (0x13, 0x17):
        return struct.unpack_from("<I", d, o)[0]
    if t == 0x14:
        return struct.unpack_from("<q", d, o)[0]
    if t == 0x15:
        return struct.unpack_from("<Q", d, o)[0]
    if t == 0x04:
        return struct.unpack_from("<f", d, o)[0]
    if t == 0x05:
        return struct.unpack_from("<d", d, o)[0]
    if t == 0x0B:
        return struct.unpack_from("<h", d, o)[0] != 0
    if t == 0x1E:
        n = struct.unpack_from("<I", d, o)[0]
        raw = d[o + 4:o + 4 + n]
        if codepage == 1200:
            return raw.decode("utf-16le", "replace").rstrip("\x00")
        return raw.decode("cp1252", "replace").rstrip("\x00")
    if t == 0x1F:
        n = struct.unpack_from("<I", d, o)[0]
        return d[o + 4:o + 4 + 2 * n].decode("utf-16le", "replace").rstrip("\x00")
    if t == 0x40:
        v = struct.unpack_from("<Q", d, o)[0]
        if not v:
            return None
        try:
            return (_EPOCH + timedelta(microseconds=v // 10)).astimezone()
        except (OverflowError, OSError):
            return None
    if t == 0x47:  # appunti (anteprima): dimensione, formato, dati
        n = struct.unpack_from("<I", d, o)[0]
        return ("clipboard", d[o + 4:o + 4 + n])
    if t == 0x41:
        n = struct.unpack_from("<I", d, o)[0]
        return ("blob", d[o + 4:o + 4 + n])
    if t == 0x48:
        return str(uuid.UUID(bytes_le=d[o:o + 16])).upper()
    return None


def read_property_stream(d: bytes) -> list[dict]:
    """Insiemi di proprieta' di un flusso \\x05...: [{fmtid, name, props: {id: valore}, names: {id: nome}}]."""
    sets = []
    if len(d) < 48 or d[:2] != b"\xfe\xff":
        return sets
    n = struct.unpack_from("<I", d, 24)[0]
    for k in range(min(n, 4)):
        fmtid = str(uuid.UUID(bytes_le=d[28 + 20 * k:44 + 20 * k])).upper()
        base = struct.unpack_from("<I", d, 44 + 20 * k)[0]
        try:
            _size, count = struct.unpack_from("<II", d, base)
            offs = [struct.unpack_from("<II", d, base + 8 + 8 * i) for i in range(count)]
        except struct.error:
            continue
        codepage = 1252
        for pid, off in offs:
            if pid == 1:
                try:
                    codepage = struct.unpack_from("<H", d, base + off + 4)[0]
                except struct.error:
                    pass
        props, names = {}, {}
        for pid, off in offs:
            o = base + off
            try:
                if pid == 0:  # dizionario: nomi delle proprieta' personalizzate
                    cnt = struct.unpack_from("<I", d, o)[0]
                    p = o + 4
                    for _ in range(cnt):
                        nid, ln = struct.unpack_from("<II", d, p)
                        p += 8
                        if codepage == 1200:
                            names[nid] = d[p:p + 2 * ln].decode("utf-16le", "replace").rstrip("\x00")
                            p += 2 * ln
                            p += (-p + o) % 4
                        else:
                            names[nid] = d[p:p + ln].decode("cp1252", "replace").rstrip("\x00")
                            p += ln
                    continue
                if pid in (1, 0x80000000, 0x80000003):
                    continue
                props[pid] = _read_value(d, o, codepage)
            except (struct.error, UnicodeDecodeError):
                continue
        nm = props.pop(255, None)
        sets.append({"fmtid": fmtid, "name": nm if isinstance(nm, str) else "", "props": props, "names": names})
    return sets


def _fmt(v):
    if isinstance(v, datetime):
        u = v.astimezone(timezone.utc)
        if u.hour == 0 and u.minute == 0 and u.second == 0:  # solo data (salvata a mezzanotte UTC)
            return u.strftime("%d/%m/%Y")
        return v.strftime("%d/%m/%Y %H:%M")
    if isinstance(v, bool):
        return tr("srv_inventor.si") if v else tr("common.no")
    if isinstance(v, float):
        return f"{v:.6g}"
    return str(v)


def _thumbnail(v) -> tuple[bytes, str] | None:
    """Anteprima dai dati "appunti" (proprieta' 17): PNG, BMP (DIB) o metafile."""
    if not isinstance(v, tuple) or not v[1]:
        return None
    b = v[1]
    i = b.find(b"\x89PNG\r\n\x1a\n")
    if i >= 0:
        return b[i:], "image/png"
    if len(b) > 8:
        fmt = struct.unpack_from("<i", b, 0)[0]
        cf = struct.unpack_from("<I", b, 4)[0] if fmt == -1 else 0
        body = b[8:] if fmt == -1 else b[4:]
        if cf == 8 or (len(body) > 40 and struct.unpack_from("<I", body, 0)[0] == 40):  # CF_DIB
            hdr = struct.unpack_from("<IiiHHIIiiII", body, 0)
            bits, clr = hdr[4], hdr[9]
            pal = (clr or (1 << bits if bits <= 8 else 0)) * 4
            fh = b"BM" + struct.pack("<IHHI", 14 + len(body), 0, 0, 14 + hdr[0] + pal)
            return fh + body, "image/bmp"
        if cf == 3 or fmt in (3, 14):  # metafile: lo converte Pillow se riesce
            return body, "image/x-wmf"
    return None


# ---------------------------------------------------------------- documento

TIPI = {".ipt": "Parte", ".iam": "Assieme", ".idw": "Tavola", ".dwg": "Tavola", ".ipn": "Presentazione"}


class InventorFile:
    def __init__(self, path: str):
        self.path = path
        self.ole = olefile.OleFileIO(path)
        self._segs = None

    def close(self):
        self.ole.close()

    # ------------------------------------------------ proprieta'
    def property_sets(self) -> list[dict]:
        out = []
        for e in self.ole.listdir(streams=True, storages=False):
            if len(e) != 1 or not e[0].startswith("\x05"):
                continue
            try:
                out += read_property_stream(self.ole.openstream(e[0]).read())
            except Exception:
                continue
        return out

    def properties(self) -> dict:
        """{gruppi: [{nome, voci: [[nome, valore]]}], anteprima: (bytes, mime) | None, materiale, aspetto}"""
        groups, thumb, info = [], None, {}
        order = {"Inventor Summary Information": 0, "Design Tracking Properties": 1,
                 "Inventor Document Summary Information": 2, "Inventor User Defined Properties": 3}
        titles = {"Inventor Summary Information": tr("srv_inventor.riepilogo"), "Design Tracking Properties": tr("srv_inventor.progetto"),
                  "Inventor Document Summary Information": tr("srv_inventor.documento"),
                  "Inventor User Defined Properties": tr("srv_inventor.proprieta_personalizzate")}
        for s in sorted(self.property_sets(), key=lambda s: order.get(s["name"], 9)):
            name = s["name"]
            if (name in NASCOSTE and NASCOSTE[name] is None) or name.startswith("_"):  # insiemi interni di Inventor
                continue
            hide = NASCOSTE.get(name, set())
            names = NOMI.get(name, {})
            rows = []
            for pid, v in sorted(s["props"].items()):
                if pid == 17 and name == "Inventor Summary Information":
                    thumb = _thumbnail(v) or thumb
                    continue
                if pid in hide or v is None or v == "" or isinstance(v, tuple):
                    continue
                label = s["names"].get(pid) or (tr(names[pid]) if pid in names else None)
                if not label:
                    if name == "Inventor User Defined Properties":
                        label = tr("srv_inventor.proprieta_0", pid)
                    else:
                        continue  # identificativi interni senza nome noto
                unit = UNITA.get(name, {}).get(pid)
                rows.append([label, f"{v:.6g} {unit}" if unit and isinstance(v, (int, float)) else _fmt(v)])
                if name == "Design Tracking Properties":
                    if pid == 20:
                        info["materiale"] = str(v)
                    elif pid == 72:
                        info["aspetto"] = str(v)
                    elif pid == 5:
                        info["codice"] = str(v)
                    elif pid == 29:
                        info["descrizione"] = str(v)
            if rows:
                groups.append({"nome": titles.get(name, name or tr("srv_inventor.proprieta")), "voci": rows})
        info.update(gruppi=groups, anteprima=thumb)
        return info

    # ------------------------------------------------ segmenti RSe
    def segments(self) -> dict[str, list[str]]:
        """{tipo segmento (es. PmBRepSegment): [nomi dei flussi B...]}"""
        if self._segs is not None:
            return self._segs
        segs: dict[str, list[str]] = {}
        for e in self.ole.listdir(streams=True, storages=False):
            if len(e) < 2 or not e[-1].startswith("M") or e[-2] != "RSeStorage" and not e[-2].startswith("RSe"):
                continue
            try:
                d = self.ole.openstream(e).read(400)
            except Exception:
                continue
            if b"RSe Meta Stream" not in d[:40]:
                continue
            # nome del tipo (UTF-16 con la lunghezza davanti, es. "PmBRepSegment")
            m = re.search(rb"([\x03-\x40])\x00\x00\x00((?:[A-Za-z]\x00){3,64})", d[30:])
            if not m:
                continue
            kind = m.group(2)[:2 * m.group(1)[0]].decode("utf-16le")
            bname = "/".join(e[:-1] + ["B" + e[-1][1:]])
            if self.ole.exists(bname):
                segs.setdefault(kind, []).append(bname)
        self._segs = segs
        return segs

    def segment_data(self, stream: str) -> bytes:
        """Dati del segmento: intestazione di 18 byte (o meno) + zlib."""
        d = self.ole.openstream(stream).read()
        for off in (18, 16, 20, 0):
            if off < len(d) - 2 and d[off] == 0x78:
                try:
                    return zlib.decompressobj().decompress(d[off:])
                except zlib.error:
                    pass
        m = re.search(rb"\x78[\x01\x5e\x9c\xda]", d[:64])
        if m:
            try:
                return zlib.decompressobj().decompress(d[m.start():])
            except zlib.error:
                pass
        return d

    def brep_blobs(self) -> list[bytes]:
        """Dati ShapeManager/ACIS binari del solido finale (segmento BRep)."""
        out = []
        segs = self.segments()
        kinds = [k for k in segs if "BRep" in k and "BRx" not in k] or [k for k in segs if "BRep" in k]
        for k in kinds:
            for s in segs[k]:
                d = self.segment_data(s)
                for sig in (b"ASM BinaryFile4", b"ACIS BinaryFile"):
                    i = d.find(sig)
                    while i >= 0:
                        out.append(d[i:])
                        i = d.find(sig, i + 16)
        return out

    # ------------------------------------------------ colore (aspetto attivo della parte)
    def style_name(self) -> str | None:
        name = None
        for s in self.property_sets():
            if s["name"] == "_Private Model Information":
                m = re.search(r"<StyleName>(.*?)</StyleName>", str(s["props"].get(16) or ""))
                if m:
                    return m.group(1)
            if s["name"] == "Design Tracking Properties" and isinstance(s["props"].get(72), str):
                name = s["props"][72]
        return name

    def color(self) -> tuple[float, float, float] | None:
        """Colore diffuso dell'aspetto attivo: definizione nel segmento Pm/AmApp (nome, descrizione, nome
        visualizzato, id della libreria, GUID testuale, poi 4 colori RGBA float: ambiente, diffuso, speculare, emissivo)."""
        name = self.style_name()
        if not name:
            return None
        key = struct.pack("<I", len(name)) + name.encode("utf-16le")
        for k, ss in self.segments().items():
            if not k.endswith("AppSegment"):
                continue
            d = self.segment_data(ss[0])
            i = d.find(key)
            while i >= 0:
                m = _GUID_TXT.search(d, i, i + 1200)
                if m:
                    # dopo il GUID: pochi byte, poi i colori RGBA (alfa 1) uno dopo l'altro
                    for o in range(m.end(), m.end() + 64):
                        try:
                            amb = struct.unpack_from("<4f", d, o)
                            dif = struct.unpack_from("<4f", d, o + 16)
                        except struct.error:
                            break
                        if amb[3] == 1.0 and dif[3] == 1.0 and all(0.0 <= x <= 1.0 for x in amb + dif):
                            return tuple(round(x, 4) for x in dif[:3])
                i = d.find(key, i + 4)
        return _COLORI_NOTI.get(name.split(" - ")[0].strip().lower())

    # ------------------------------------------------ assiemi
    def file_refs(self) -> list[dict]:
        """File referenziati (UFRxDoc): [{percorso, guid}] nell'ordine del documento."""
        try:
            d = self.ole.openstream("UFRxDoc").read()
        except Exception:
            return []
        out = []
        for m in _PATH_RE.finditer(d):
            p = m.group(0).decode("utf-16le", "replace")
            o = m.start() - 4
            if o < 0 or struct.unpack_from("<I", d, o)[0] != len(p):
                continue
            out.append({"percorso": p, "guid": None, "inizio": o, "fine": m.end()})
        # GUID del documento: subito dopo il percorso del suo file (prima del percorso successivo). Un file copiato
        # con "Salva con nome" ha lo stesso GUID dell'originale: ogni voce prende il GUID che ha accanto
        guids = {o["guid"] for o in self.occurrences(with_matrix=False) if o["guid"]}
        for k, r in enumerate(out):
            end = out[k + 1]["inizio"] if k + 1 < len(out) else min(len(d), r["fine"] + 2000)
            win = d[r["fine"]:end]
            hits = sorted((win.find(g), g) for g in guids if g in win)
            if hits:
                i, g = hits[0]
                r["guid"] = g
                # tra percorso e GUID c'e' anche il nome visualizzato del documento (nome delle occorrenze)
                r["nomi"] = [x.group(0).decode("utf-16le") for x in re.finditer(rb"(?:[\x20-\x7e]\x00){3,}", win[:i])]
        for r in out:
            r.pop("fine")
            r.pop("inizio")
        return out

    def occurrences(self, with_matrix: bool = True) -> list[dict]:
        """Occorrenze dell'assieme: [{nome, guid, matrice 4x4 (righe, cm)}].
        Nomi e documento da UFRxDoc (blocchi: 0x03 = GUID del documento, 0x05 = nome dell'occorrenza);
        posizioni dal segmento AmRx (stesso ordine): matrice 4x4 compatta con 32 bit di indicatori."""
        try:
            u = self.ole.openstream("UFRxDoc").read()
        except Exception:
            return []
        occ = []
        last_guid = None
        for m in _OCC_RE.finditer(u):
            if m.group(1) == b"\x03":
                last_guid = u[m.end():m.end() + 16]
            else:
                n = struct.unpack_from("<I", u, m.end())[0]
                if 0 < n < 400:
                    name = u[m.end() + 4:m.end() + 4 + 2 * n].decode("utf-16le", "replace")
                    occ.append({"nome": name, "guid": last_guid})
        # con piu' stati del modello (o livelli di dettaglio) l'elenco e' ripetuto per intero: si tiene il primo
        n = len(occ)
        for per in range(1, n // 2 + 1):
            if n % per == 0 and all(occ[i]["guid"] == occ[i % per]["guid"] and occ[i]["nome"] == occ[i % per]["nome"]
                                    for i in range(per, n)):
                occ = occ[:per]
                break
        if not with_matrix:
            return occ
        mats = []
        for k, ss in self.segments().items():
            if k.startswith("AmRx"):
                mats += find_transforms(self.segment_data(ss[0]))
        for i, o in enumerate(occ):
            o["matrice"] = mats[i] if i < len(mats) else None
        if len(mats) != len(occ):
            for o in occ[len(mats):]:
                o["matrice"] = None
        return occ


_GUID_TXT = re.compile(rb"(?:[0-9A-F]\x00){8}-\x00(?:(?:[0-9A-F]\x00){4}-\x00){3}(?:[0-9A-F]\x00){12}")
_PATH_RE = re.compile(rb"(?:[^\x00]\x00){2,400}?\.\x00(?:[iI]\x00[pP]\x00[tT]\x00|[iI]\x00[aA]\x00[mM]\x00|"
                      rb"[iI]\x00[pP]\x00[nN]\x00|[iI]\x00[dD]\x00[wW]\x00)")
_OCC_RE = re.compile(rb"\x01([\x03\x05])\x01\x00\x00\x00\1", re.S)

# colori di ripiego per gli aspetti piu' comuni della libreria di Inventor (se la definizione non e' nel file)
_COLORI_NOTI = {
    "red": (0.7, 0.0, 0.0), "blue": (0.1, 0.25, 0.7), "green": (0.1, 0.55, 0.15), "yellow": (0.9, 0.8, 0.1),
    "orange": (0.95, 0.45, 0.05), "black": (0.08, 0.08, 0.08), "white": (0.92, 0.92, 0.92),
    "aluminum": (0.8, 0.81, 0.83), "steel": (0.62, 0.64, 0.66), "stainless steel": (0.7, 0.71, 0.72),
    "brass": (0.78, 0.62, 0.3), "copper": (0.72, 0.45, 0.2), "chrome": (0.85, 0.86, 0.88),
    "iron": (0.45, 0.45, 0.46), "gold": (0.85, 0.68, 0.2), "rubber": (0.12, 0.12, 0.12), "glass": (0.7, 0.8, 0.85),
    "default": (0.74, 0.75, 0.77), "generic": (0.74, 0.75, 0.77),
}


def read_transform(d: bytes, o: int):
    """Matrice 4x4 compatta: indicatori uint32, bit k (0-15) = elemento k vale 1 (-1 se c'e' anche il bit k+16),
    solo bit k+16 = elemento k vale 0; gli altri elementi sono double in ordine (righe). -> (matrice, fine)"""
    flag = struct.unpack_from("<I", d, o)[0]
    o += 4
    m = []
    for k in range(16):
        one, hi = flag >> k & 1, flag >> (k + 16) & 1
        if one:
            m.append(-1.0 if hi else 1.0)
        elif hi:
            m.append(0.0)
        else:
            m.append(struct.unpack_from("<d", d, o)[0])
            o += 8
    return m, o


def _is_rigid(m) -> bool:
    import math
    if not all(math.isfinite(x) for x in m) or max(abs(x) for x in m) > 1e7:
        return False
    if any(m[12 + k] != 0.0 for k in range(3)) or m[15] != 1.0:
        return False
    R = (m[0:3], m[4:7], m[8:11])
    return all(abs(sum(R[a][k] * R[b][k] for k in range(3)) - (a == b)) < 1e-6 for a in range(3) for b in range(3))


def find_transforms(d: bytes) -> list[list[float]]:
    """Trasformazioni delle occorrenze nel segmento AmRx: matrici rigide con l'ultima riga (0 0 0 1) indicata
    dai bit (0x70008000), nell'ordine in cui compaiono."""
    out = []
    i, n = 0, len(d) - 8
    while i < n:
        if d[i + 3] & 0x70 == 0x70 and d[i + 1] & 0x80:
            try:
                m, e = read_transform(d, i)
            except struct.error:
                i += 1
                continue
            if _is_rigid(m):
                out.append(m)
                i = e
                continue
        i += 1
    return out


# ---------------------------------------------------------------- conversione con cache su disco

def _reader_stamp() -> str:
    """Cambia quando cambia il lettore: una versione nuova rifa' le conversioni."""
    here = os.path.dirname(os.path.abspath(__file__))
    st = []
    for n in ("inventor.py", "acis.py", "acis_step.py"):
        try:
            st.append(str(os.path.getmtime(os.path.join(here, n))))
        except OSError:
            st.append("0")
    return "|".join(st)


def _key(path: str) -> str:
    import hashlib
    s = os.stat(path)
    return hashlib.sha1(f"{os.path.abspath(path)}|{s.st_size}|{s.st_mtime}|{_reader_stamp()}".encode()).hexdigest()[:16]


def _save_thumb(inv_props: dict, folder: str) -> str | None:
    t = inv_props.get("anteprima")
    if not t:
        return None
    data, mime = t
    out = os.path.join(folder, "anteprima.png")
    try:
        if mime == "image/png":
            with open(out, "wb") as f:
                f.write(data)
        else:
            from PIL import Image
            Image.open(io.BytesIO(data)).save(out)
        return out
    except Exception:
        return None


def convert_part(path: str, cache_root: str) -> dict:
    """Parte .ipt -> STEP (in cache) + proprieta', colore, anteprima, rapporto della conversione."""
    import json
    from .acis_step import sab_to_step
    folder = os.path.join(cache_root, _key(path))
    info_path = os.path.join(folder, "info.json")
    if os.path.exists(info_path):
        try:
            with open(info_path, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            pass
    os.makedirs(folder, exist_ok=True)
    inv = InventorFile(path)
    try:
        props = inv.properties()
        color = inv.color()
        name = os.path.splitext(os.path.basename(path))[0]
        blobs = inv.brep_blobs()
        info = {"file": os.path.abspath(path), "nome": name, "colore": color, "gruppi": props["gruppi"],
                "anteprima": _save_thumb(props, folder), "step": None, "rapporto": {}, "mancanti": {}}
        if blobs:
            text, rep = sab_to_step(blobs, name, color)
            if rep["items"]:
                step = os.path.join(folder, "modello.stp")
                with open(step, "w", encoding="ascii", errors="replace") as f:
                    f.write(text)
                info["step"] = step
            info["rapporto"], info["mancanti"] = rep["report"], rep["missing"]
        else:
            info["mancanti"] = {tr("srv_inventor.geometria_3d_non_trovata_file"): 1}
    finally:
        inv.close()
    with open(info_path, "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False)
    return info


class _Finder:
    """Ricerca dei file referenziati: percorso originale, stessa struttura relativa, cartella dell'assieme e
    sottocartelle, poi cartelle superiori (con limiti, per non scandire mezzo disco)."""

    def __init__(self):
        self._index: dict[str, dict[str, str]] = {}

    def _scan(self, root: str, depth: int) -> dict[str, str]:
        key = f"{root}|{depth}"
        if key in self._index:
            return self._index[key]
        found: dict[str, str] = {}
        count = 0
        base = root.rstrip("\\/").count(os.sep)
        for dp, dns, fns in os.walk(root):
            if dp.count(os.sep) - base >= depth:
                dns[:] = []
            dns[:] = [d for d in dns if not d.startswith((".", "$")) and d.lower() not in ("oldversions", "node_modules")]
            for f in fns:
                if f.lower().endswith((".ipt", ".iam")):
                    found.setdefault(f.lower(), os.path.join(dp, f))
            count += len(fns)
            if count > 20000:
                break
        self._index[key] = found
        return found

    def find(self, ref: str, asm_path: str, asm_original: str | None) -> str | None:
        if os.path.isfile(ref):
            return ref
        here = os.path.dirname(os.path.abspath(asm_path))
        name = re.split(r"[\\/]", ref)[-1]
        if asm_original:
            orig_dir = re.split(r"[\\/][^\\/]*$", asm_original)[0]
            try:
                rel = os.path.relpath(ref, orig_dir)
                cand = os.path.normpath(os.path.join(here, rel))
                if os.path.isfile(cand):
                    return cand
            except ValueError:
                pass
        cand = os.path.join(here, name)
        if os.path.isfile(cand):
            return cand
        hit = self._scan(here, 4).get(name.lower())
        if hit:
            return hit
        up = here
        for _ in range(3):
            parent = os.path.dirname(up)
            if parent == up:
                break
            up = parent
            hit = self._scan(up, 4).get(name.lower())
            if hit:
                return hit
        return None


def _match_files(occs: list[dict], refs: list[dict]) -> None:
    """Per ogni occorrenza il file: GUID + nome, poi solo nome, poi solo GUID (i file copiati con "Salva con
    nome" hanno lo stesso GUID del file di partenza, quindi decide il nome)."""
    def stem(p):
        return os.path.splitext(re.split(r"[\\/]", p)[-1])[0].lower()
    for o in occs:
        nm = (o["nome"] or "").lower()
        same_guid = [r for r in refs if o["guid"] and r["guid"] == o["guid"]]
        pick = same_guid[0] if len(same_guid) == 1 else None
        pick = pick or next((r for r in same_guid if stem(r["percorso"]) == nm), None)
        pick = pick or next((r for r in same_guid if nm in [x.lower() for x in r.get("nomi", [])]), None)
        pick = pick or next((r for r in refs if stem(r["percorso"]) == nm), None)
        pick = pick or next((r for r in refs if nm in [x.lower() for x in r.get("nomi", [])]), None)
        pick = pick or (same_guid[0] if same_guid else None)
        o["file"] = pick["percorso"] if pick else None


IDENTITA = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]


def _mm(m: list[float]) -> list[float]:
    """Matrice 4x4 (righe, traslazione in cm) -> traslazione in mm."""
    m = list(m)
    m[3] *= 10.0
    m[7] *= 10.0
    m[11] *= 10.0
    return m


def convert(path: str, cache_root: str, update=None) -> dict:
    """Documento Inventor -> descrizione per il visualizzatore 3D (parti in STEP nella cache)."""
    ext = os.path.splitext(path)[1].lower()
    finder = _Finder()
    parts: dict[str, dict] = {}
    missing: list[str] = []
    notes: list[str] = []
    total = [0, 0]

    def part(p):
        k = os.path.normcase(os.path.abspath(p))
        if k not in parts:
            total[1] += 1
            if update:
                update(min(0.95, 0.05 + 0.9 * total[1] / max(1, total[0])), tr("srv_inventor.conversione") + os.path.basename(p))
            try:
                parts[k] = convert_part(p, cache_root)
            except Exception as e:  # noqa: BLE001 - una parte illeggibile non ferma l'assieme
                parts[k] = {"file": p, "nome": os.path.splitext(os.path.basename(p))[0], "step": None,
                            "errore": str(e), "gruppi": [], "mancanti": {tr("srv_inventor.file_non_leggibile"): 1}}
        return k

    def assembly(p, depth, seen):
        inv = InventorFile(p)
        try:
            refs = inv.file_refs()
            occs = inv.occurrences()
        finally:
            inv.close()
        own = next((r["percorso"] for r in refs
                    if re.split(r"[\\/]", r["percorso"])[-1].lower() == os.path.basename(p).lower()), None)
        _match_files(occs, refs)
        total[0] += len(occs)
        unplaced = sum(o["matrice"] is None for o in occs)
        if unplaced:
            notes.append(tr("srv_inventor.0_posizione_non_letta_1", os.path.basename(p), unplaced))
        nodes, counter = [], {}
        for o in occs:
            counter[o["nome"]] = counter.get(o["nome"], 0) + 1
            node = {"nome": f"{o['nome']}:{counter[o['nome']]}", "matrice": _mm(o["matrice"]) if o["matrice"] else IDENTITA}
            real = finder.find(o["file"], p, own) if o["file"] else None
            if not real:
                node["mancante"] = o["file"] or o["nome"]
                if node["mancante"] not in missing:
                    missing.append(node["mancante"])
            elif real.lower().endswith(".iam"):
                if depth > 12 or os.path.normcase(real) in seen:
                    node["mancante"] = real
                else:
                    node["figli"] = assembly(real, depth + 1, seen | {os.path.normcase(real)})
                    node["file"] = real
            else:
                node["parte"] = part(real)
            nodes.append(node)
        return nodes

    inv = InventorFile(path)
    try:
        props = inv.properties()
        kind = {".ipt": "parte", ".iam": "assieme", ".ipn": "presentazione"}.get(ext, "tavola")
        refs = inv.file_refs() if kind != "parte" else []
    finally:
        inv.close()
    folder = os.path.join(cache_root, _key(path))
    os.makedirs(folder, exist_ok=True)
    out = {"tipo": kind, "nome": os.path.splitext(os.path.basename(path))[0], "gruppi": props["gruppi"],
           "anteprima": _save_thumb(props, folder)}
    if kind == "parte":
        out["albero"] = [{"nome": out["nome"], "parte": part(path), "matrice": IDENTITA}]
    elif kind == "assieme":
        out["albero"] = assembly(path, 0, {os.path.normcase(os.path.abspath(path))})
    else:
        # tavole e presentazioni: anteprima, proprieta' e file referenziati (apribili)
        own = os.path.basename(path).lower()
        out["riferimenti"] = []
        for r in refs:
            if re.split(r"[\\/]", r["percorso"])[-1].lower() == own:
                continue
            out["riferimenti"].append({"originale": r["percorso"], "file": finder.find(r["percorso"], path, None)})
    out["parti"] = parts
    out["mancanti"] = missing
    out["note"] = notes
    return out
