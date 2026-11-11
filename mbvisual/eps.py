"""Immagine di un file EPS senza interprete PostScript (Ghostscript e' AGPL: non incluso). Si usa cio' che il file stesso contiene:
1. %ImageData di Photoshop: l'immagine intera (bitmap, grigi, RGB, CMYK; binaria o esadecimale);
2. intestazione binaria DOS (C5 D0 D3 C6) con anteprima TIFF o WMF;
3. anteprima EPSI (%%BeginPreview, bitmap esadecimale).
Gli EPS fatti solo di disegni PostScript (molti file di Illustrator e dei CAD) non hanno nessuna di queste: allora None, e il file resta
leggibile come testo."""
import io
import re
import struct

from PIL import Image


def _ps_part(b: bytes) -> bytes:
    if b[:4] == b"\xc5\xd0\xd3\xc6":
        ps, psl = struct.unpack_from("<2I", b, 4)
        return b[ps:ps + psl]
    return b


def _image_data(ps: bytes):
    m = re.search(rb'%ImageData:\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+"([^"]+)"', ps)
    if not m:
        return None
    cols, rows, depth, mode, pad, _blk, fmt = (int(m.group(i)) for i in range(1, 8))
    token = m.group(8)
    chans = {1: 1, 2: 3, 3: 3, 4: 4}.get(mode)
    if not chans or depth not in (1, 8):
        return None
    # i dati iniziano dopo la riga che contiene la parola che apre l'immagine (es. "beginimage"); la stessa parola puo' comparire
    # prima, nella definizione della procedura: si prende l'occorrenza seguita davvero da dati della lunghezza giusta
    row_bytes = (cols * depth + 7) // 8
    need = row_bytes * rows * (chans + pad) if depth == 8 else row_bytes * rows
    data, k = None, m.end()
    while data is None:
        k = ps.find(token, k)
        if k < 0:
            return None
        k = ps.find(b"\n", k) + 1
        if k <= 0:
            return None
        first = ps[k:ps.find(b"\n", k)].strip()
        is_hex = bool(first) and len(first) % 2 == 0 and re.fullmatch(rb"[0-9A-Fa-f]+", first) is not None
        if fmt == 1 and not is_hex:  # binario (alcuni programmi dichiarano 1 ma scrivono esadecimale: decide il contenuto)
            if len(ps) - k >= need:
                data = ps[k:k + need]
        elif fmt == 7:  # ASCII85, chiuso da ~>
            e = ps.find(b"~>", k)
            if e > 0:
                import base64
                try:
                    d = base64.a85decode(ps[k:e], adobe=False, ignorechars=b" \t\n\r\x0b")
                except ValueError:
                    d = b""
                if len(d) >= need:
                    data = d[:need]
        else:  # esadecimale: righe fatte solo di cifre esadecimali
            if is_hex:
                hexs = re.sub(rb"[^0-9A-Fa-f]", b"", ps[k:k + need * 2 + need // 8 + 4096])
                if len(hexs) >= need * 2:
                    data = bytes.fromhex(hexs[:need * 2].decode("ascii"))
    if depth == 1:
        im = Image.frombytes("1", (cols, rows), data, "raw", "1")
        return im.convert("L")
    if pad == 0 and chans in (1, 3, 4):  # canali interleaved per pixel
        rawmode = {1: "L", 3: "RGB", 4: "CMYK"}[chans]
        im = Image.frombytes(rawmode, (cols, rows), data)
        if mode == 2:  # Lab: si mostra come RGB approssimato
            im = Image.frombytes("LAB", (cols, rows), data).convert("RGB")
        if chans == 4:  # CMYK del PostScript: 0 = niente inchiostro (non invertito come nei PSD)
            im = im.convert("RGB")
        return im
    return None


def _epsi(ps: bytes):
    m = re.search(rb"%%BeginPreview:\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)", ps)
    if not m:
        return None
    w, h, depth = int(m.group(1)), int(m.group(2)), int(m.group(3))
    end = ps.find(b"%%EndPreview", m.end())
    body = ps[m.end():end if end > 0 else None]
    hexs = re.sub(rb"[^0-9A-Fa-f]", b"", b"".join(l.lstrip(b"% ") for l in body.splitlines()))
    row = (w * depth + 7) // 8
    data = bytes.fromhex(hexs[:row * h * 2].decode("ascii"))
    if len(data) < row * h or depth not in (1, 2, 4, 8):
        return None
    raw = {1: "1;I", 2: "L;2I", 4: "L;4I", 8: "L;I"}[depth]
    return Image.frombytes("1" if depth == 1 else "L", (w, h), data, "raw", raw).convert("L")


def to_image(path: str):
    """(immagine, origine) oppure (None, None)"""
    with open(path, "rb") as f:
        b = f.read()
    ps = _ps_part(b)
    im = _image_data(ps)
    if im is not None:
        return im, "imagedata"
    if b[:4] == b"\xc5\xd0\xd3\xc6":
        _, _, wmf, wmfl, tif, tifl = struct.unpack_from("<6I", b, 4)
        for off, ln in ((tif, tifl), (wmf, wmfl)):
            if ln:
                try:
                    im = Image.open(io.BytesIO(b[off:off + ln]))
                    im.load()
                    return im, "anteprima"
                except Exception:  # noqa: BLE001
                    continue
    im = _epsi(ps)
    if im is not None:
        return im, "anteprima"
    return None, None
