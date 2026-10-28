# Solidi ACIS dei DWG 2013 e successivi (AC1027, AC1032): dalla versione 2013 AutoCAD non scrive piu' i dati
# ShapeManager dentro l'entita' (3DSOLID, REGION, BODY, superfici) ma nella sezione "AcDb:AcDsPrototype_1b".
# Scritto da zero per MB Desk dalla descrizione pubblica del formato DWG 2004+ (Open Design Specification:
# intestazione cifrata, mappa delle pagine, mappa delle sezioni, compressione LZ77) e dall'analisi dei file
# (struttura dei record AcDs confrontata con la sezione ACDSDATA dei DXF salvati dallo stesso disegno).
from __future__ import annotations

import struct


class DwgError(Exception):
    pass


R2004 = (b"AC1018", b"AC1024", b"AC1027", b"AC1032")


# ---------------------------------------------------------------- decompressione (LZ77 dei DWG 2004+)
def decompress(src: bytes, size: int) -> bytes:
    out = bytearray()
    p = 0
    n = len(src)

    def byte():
        nonlocal p
        if p >= n:
            raise DwgError("dati compressi troncati")
        b = src[p]
        p += 1
        return b

    def literal_len(code):
        low = code & 0x0F
        if low == 0:
            while True:
                b = byte()
                if b:
                    break
                low += 0xFF
            low += 0x0F + b
        return low

    def comp_bytes(op, bits):
        c = op & bits
        if c == 0:
            while True:
                b = byte()
                if b:
                    break
                c += 0xFF
            c += b + bits
        return c + 2

    def copy_lit(cnt):
        nonlocal p
        if p + cnt > n:
            raise DwgError("dati compressi troncati")
        out.extend(src[p:p + cnt])
        p += cnt
        return byte() if p < n else 0x11

    op = byte()
    if op & 0xF0 == 0:
        op = copy_lit(literal_len(op) + 3)
    while op != 0x11:
        if op < 0x10 or op >= 0x40:
            cnt = (op >> 4) - 1
            op2 = byte()
            off = (((op >> 2) & 3) | (op2 << 2)) + 1
        elif op < 0x20:
            cnt = comp_bytes(op, 0x07)
            off = (op & 8) << 11
            first = byte()
            off |= first >> 2
            off |= byte() << 6
            off += 0x4000
            op = first
        else:
            cnt = comp_bytes(op, 0x1F)
            first = byte()
            off = (first >> 2) | (byte() << 6)
            off += 1
            op = first
        start = len(out) - off
        if start < 0:
            raise DwgError("riferimento non valido nei dati compressi")
        if off >= cnt:
            out.extend(out[start:start + cnt])
        else:
            for k in range(cnt):
                out.append(out[start + k])
        lit = op & 3
        if lit == 0:
            if p >= n:
                break
            op = byte()
            if op & 0xF0 == 0:
                lit = literal_len(op) + 3
        if lit:
            op = copy_lit(lit)
        if len(out) > size + 64:
            break
    return bytes(out[:size])


# ---------------------------------------------------------------- sezioni del file
def _decrypt_header(b: bytes) -> bytes:
    out = bytearray(b)
    seed = 1
    for i in range(len(out)):
        seed = (seed * 0x343FD + 0x269EC3) & 0xFFFFFFFF
        out[i] ^= (seed >> 16) & 0xFF
    return bytes(out)


def _system_page(data: bytes, addr: int, kind: int) -> bytes:
    typ, dsize, csize, comp, _crc = struct.unpack_from("<5I", data, addr)
    if typ != kind:
        raise DwgError("pagina di sistema non riconosciuta")
    raw = data[addr + 20:addr + 20 + csize]
    return decompress(raw, dsize) if comp == 2 else raw[:dsize]


def sections(data: bytes) -> dict:
    """{nome: (descrizione, pagine)} di un DWG 2004+."""
    if data[:6] not in R2004:
        raise DwgError("versione DWG non gestita")
    h = _decrypt_header(data[0x80:0x80 + 0x6C])
    if not h.startswith(b"AcFssFcAJMB"):
        raise DwgError("intestazione del DWG non valida")
    page_map_id, page_map_addr, section_map_id = struct.unpack_from("<IQI", h, 0x50)
    pm = _system_page(data, page_map_addr + 0x100, 0x41630E3B)
    pages, addr, q = {}, 0x100, 0
    while q + 8 <= len(pm):
        num, size = struct.unpack_from("<iI", pm, q)
        q += 8
        if num < 0:
            q += 16
        else:
            pages[num] = addr
        addr += size
    if section_map_id not in pages:
        raise DwgError("mappa delle sezioni assente")
    sm = _system_page(data, pages[section_map_id], 0x4163003B)
    nd = struct.unpack_from("<I", sm, 0)[0]
    q, out = 20, {}
    for _ in range(nd):
        if q + 96 > len(sm):
            break
        size, npages, maxd, _u, comp, sid, enc = struct.unpack_from("<QIIIIII", sm, q)
        name = sm[q + 32:q + 96].split(b"\0")[0].decode("latin-1")
        q += 96
        plist = []
        for _ in range(npages):
            pnum, psize, poff = struct.unpack_from("<IIQ", sm, q)
            q += 16
            plist.append((pnum, psize, poff))
        out[name] = ({"size": size, "max": maxd, "comp": comp, "id": sid, "enc": enc}, plist, pages)
    return out


def section_data(data: bytes, name: str) -> bytes | None:
    secs = sections(data)
    if name not in secs:
        return None
    d, plist, pages = secs[name]
    buf = bytearray(d["size"])
    for pnum, _psize, poff in plist:
        a = pages.get(pnum)
        if a is None:
            continue
        mask = 0x4164536B ^ a
        hd = struct.unpack_from("<8I", data, a)
        hd = [v ^ mask for v in hd]
        csize, dsize = hd[2], hd[3]
        raw = data[a + 32:a + 32 + csize]
        chunk = decompress(raw, d["max"]) if d["comp"] == 2 else raw
        chunk = chunk[:max(0, min(len(chunk), d["size"] - poff))]
        buf[poff:poff + len(chunk)] = chunk
    return bytes(buf)


# ---------------------------------------------------------------- sezione AcDs
# Segmenti con intestazione di 0x30 byte: firma 0xD5AC, nome di 6 caratteri ("segidx", "datidx", "_data_", "search"...),
# indice e dimensione. Un segmento "_data_" ha una tabella di voci da 20 byte (dimensione 0x14, 1, handle dell'oggetto
# a 64 bit, posizione) seguita, all'indirizzo allineato a 16 byte, dai dati: per ogni voce un intero con la lunghezza
# e poi i byte (miniatura PNG, dati ShapeManager...).
_SAB = (b"ASM BinaryFile", b"ACIS BinaryFile")


def _data_segments(sec: bytes):
    p = 0
    n = len(sec)
    while True:
        p = sec.find(b"\xac\xd5_data_", p)
        if p < 0:
            return
        size = struct.unpack_from("<I", sec, p + 16)[0] if p + 20 <= n else 0
        yield p, max(0, min(size, n - p))
        p += 8


def acds_blobs(sec: bytes) -> dict[int, bytes]:
    """{handle dell'entita': dati ShapeManager} dalla sezione AcDs."""
    out: dict[int, bytes] = {}
    for seg, size in _data_segments(sec):
        end = seg + size if size else len(sec)
        q = seg + 0x30
        entries = []
        while q + 20 <= end:
            esz, one, handle, off = struct.unpack_from("<IIQI", sec, q)
            if esz != 0x14 or one != 1:
                break
            entries.append((handle, off))
            q += 20
        if not entries:
            continue
        base = seg + ((q - seg + 15) & ~15)
        for handle, off in entries:
            a = base + off
            got = None
            # di norma la lunghezza e' esattamente all'indirizzo calcolato; per prudenza si cerca a breve distanza
            for d in (0, 4, -4, 8, -8, 12, -12, 16):
                b = a + d
                if 0 <= b and b + 4 + 15 <= len(sec) and sec[b + 4:b + 4 + 15].startswith(_SAB):
                    ln = struct.unpack_from("<I", sec, b)[0]
                    if 0 < ln <= len(sec) - b - 4:
                        got = sec[b + 4:b + 4 + ln]
                        break
            if got is not None:
                out[handle] = got
    return out


def solids_from_file(path: str) -> dict[int, bytes]:
    """Dati dei solidi di un DWG 2013+ (vuoto per le versioni precedenti: li' i dati stanno nell'entita')."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:6] not in (b"AC1027", b"AC1032"):
        return {}
    sec = section_data(data, "AcDb:AcDsPrototype_1b")
    return acds_blobs(sec) if sec else {}
