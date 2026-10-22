"""Lettore dei set di proprieta' OLE (MS-OLEPS): SummaryInformation, DocumentSummaryInformation (anche la sezione
delle proprieta' personalizzate) e set privati dei programmi CAD. Scritto da zero sulla specifica pubblica Microsoft."""
import struct
from datetime import datetime, timedelta, timezone

# nomi delle proprieta' standard (chiavi di traduzione srv_solidcad.p_<nome>)
SUMMARY_NAMES = {2: "titolo", 3: "oggetto", 4: "autore", 5: "parole_chiave", 6: "commenti", 7: "modello", 8: "ultimo_autore",
                 9: "revisione", 10: "tempo_modifica", 11: "ultima_stampa", 12: "creato", 13: "ultimo_salvataggio",
                 14: "pagine", 15: "parole", 16: "caratteri", 18: "applicazione", 19: "protezione"}
DOCSUMMARY_NAMES = {2: "categoria", 3: "formato", 14: "responsabile", 15: "societa", 26: "tipo_contenuto",
                    27: "stato", 28: "lingua", 29: "versione_documento"}
FMTID_USER = "D5CDD505-2E9C-101B-9397-08002B2CF9AE"


def _guid(b):
    a, b2, c = struct.unpack_from("<IHH", b, 0)
    return f"{a:08X}-{b2:04X}-{c:04X}-{b[8:10].hex().upper()}-{b[10:16].hex().upper()}"


def _filetime(v):
    if not v:
        return None
    try:
        return (datetime(1601, 1, 1, tzinfo=timezone.utc) + timedelta(microseconds=v / 10)).astimezone()
    except (OverflowError, ValueError):
        return None


def _read_value(d, off, codepage):
    t = struct.unpack_from("<H", d, off)[0]
    p = off + 4
    vec = t & 0x1000
    base = t & 0x0FFF
    if vec:
        n = struct.unpack_from("<I", d, p)[0]
        p += 4
        out = []
        for _ in range(min(n, 10000)):
            if base == 0x0C:  # VARIANT: ogni elemento ha il suo tipo
                v, p = _read_value_at(d, p, codepage)
            else:
                v, p = _scalar(d, p, base, codepage)
            out.append(v)
        return out
    v, _ = _scalar(d, p, base, codepage)
    return v


def _read_value_at(d, p, codepage):
    t = struct.unpack_from("<H", d, p)[0]
    return _scalar(d, p + 4, t & 0x0FFF, codepage)


def _scalar(d, p, t, codepage):
    if t == 2:
        return struct.unpack_from("<h", d, p)[0], p + 4
    if t == 18:
        return struct.unpack_from("<H", d, p)[0], p + 4
    if t in (3, 22):
        return struct.unpack_from("<i", d, p)[0], p + 4
    if t in (19, 23):
        return struct.unpack_from("<I", d, p)[0], p + 4
    if t == 20:
        return struct.unpack_from("<q", d, p)[0], p + 8
    if t == 21:
        return struct.unpack_from("<Q", d, p)[0], p + 8
    if t == 4:
        return struct.unpack_from("<f", d, p)[0], p + 4
    if t == 5:
        return struct.unpack_from("<d", d, p)[0], p + 8
    if t == 7:  # data OLE (giorni dal 30/12/1899)
        v = struct.unpack_from("<d", d, p)[0]
        try:
            return (datetime(1899, 12, 30) + timedelta(days=v)), p + 8
        except OverflowError:
            return v, p + 8
    if t == 11:
        return struct.unpack_from("<h", d, p)[0] != 0, p + 4
    if t == 64:
        return _filetime(struct.unpack_from("<Q", d, p)[0]), p + 8
    if t in (30, 8):
        n = struct.unpack_from("<I", d, p)[0]
        raw = d[p + 4:p + 4 + n]
        enc = "utf-16-le" if codepage == 1200 else ("cp%d" % codepage if codepage and codepage > 0 else "cp1252")
        try:
            s = raw.decode(enc)
        except (LookupError, UnicodeDecodeError):
            s = raw.decode("cp1252", "replace")
        return s.split("\0")[0], p + 4 + ((n + 3) & ~3)
    if t == 31:
        n = struct.unpack_from("<I", d, p)[0]
        raw = d[p + 4:p + 4 + n * 2]
        return raw.decode("utf-16-le", "replace").split("\0")[0], p + 4 + ((n * 2 + 3) & ~3)
    if t in (65, 71):  # BLOB, CF (miniatura)
        n = struct.unpack_from("<I", d, p)[0]
        return bytes(d[p + 4:p + 4 + n]), p + 4 + ((n + 3) & ~3)
    if t == 72:  # CLSID
        return _guid(d[p:p + 16]), p + 16
    return None, p + 4


def parse(data: bytes):
    """Ritorna una lista di sezioni: {fmtid, props: {id: valore}, names: {id: nome}} (names dal dizionario)."""
    out = []
    if len(data) < 48 or data[:2] != b"\xfe\xff":
        return out
    nsec = struct.unpack_from("<I", data, 24)[0]
    for i in range(min(nsec, 8)):
        fmtid = _guid(data[28 + i * 20:44 + i * 20])
        off = struct.unpack_from("<I", data, 44 + i * 20)[0]
        if off + 8 > len(data):
            continue
        d = data[off:]
        size, n = struct.unpack_from("<II", d, 0)
        entries = [struct.unpack_from("<II", d, 8 + k * 8) for k in range(min(n, 4096)) if 8 + k * 8 + 8 <= len(d)]
        codepage = 1252
        for pid, po in entries:
            if pid == 1 and po + 8 <= len(d):
                codepage = struct.unpack_from("<H", d, po + 4)[0]
        props, names = {}, {}
        for pid, po in entries:
            if po + 4 > len(d):
                continue
            try:
                if pid == 0:
                    names = _dictionary(d, po, codepage)
                elif pid != 1:
                    props[pid] = _read_value(d, po, codepage)
            except struct.error:
                continue
        out.append({"fmtid": fmtid, "props": props, "names": names})
    return out


def _dictionary(d, p, codepage):
    n = struct.unpack_from("<I", d, p)[0]
    p += 4
    names = {}
    for _ in range(min(n, 4096)):
        pid, ln = struct.unpack_from("<II", d, p)
        p += 8
        if codepage == 1200:
            s = d[p:p + ln * 2].decode("utf-16-le", "replace")
            p += ln * 2
            p = (p + 3) & ~3
        else:
            s = d[p:p + ln].decode("cp1252", "replace")
            p += ln
        names[pid] = s.split("\0")[0]
    return names


def fmt(v):
    if isinstance(v, datetime):
        return v.strftime("%d/%m/%Y %H:%M")
    if isinstance(v, bool):
        return "\u2713" if v else "\u2013"
    if isinstance(v, float):
        return f"{v:.6g}"
    if isinstance(v, (bytes, bytearray)):
        return f"({len(v)} byte)"
    if isinstance(v, list):
        return ", ".join(fmt(x) for x in v if x not in (None, ""))
    return "" if v is None else str(v)
