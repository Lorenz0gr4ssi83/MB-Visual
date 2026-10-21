"""Immagini (Pillow/RAW/HEIC), testo con codifica, email, SQLite, riconoscimento del tipo reale dal contenuto."""
import email
import email.policy
import hashlib
import html
import io
import mailbox
import os
import re
import sqlite3
import uuid
from pathlib import Path

from .paths import TEMP_DIR
from .i18n import t as tr

RAW_EXTS = {"cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "orf", "rw2", "raf", "dng", "pef", "ptx", "srw",
            "x3f", "3fr", "fff", "erf", "kdc", "dcr", "mos", "mef", "mrw", "rwl", "iiq", "raw", "rwz", "bay", "cap", "eip"}
IMG_CACHE = TEMP_DIR / "immagini"
IMG_CACHE.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------- immagini
def _pil():
    from PIL import Image
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except Exception:
        pass
    Image.MAX_IMAGE_PIXELS = None
    return Image


def image_to_png(path: str) -> dict:
    """Converte qualsiasi immagine supportata in PNG (in cache) e ritorna percorso e informazioni."""
    st = os.stat(path)
    key = hashlib.sha1(f"{path}|{st.st_size}|{st.st_mtime}".encode()).hexdigest()[:16]
    out = IMG_CACHE / (key + ".png")
    info = {}
    ext = Path(path).suffix.lower().lstrip(".")
    Image = _pil()
    if ext in RAW_EXTS:
        import rawpy
        with rawpy.imread(path) as raw:
            rgb = raw.postprocess(use_camera_wb=True, output_bps=8)
        im = Image.fromarray(rgb)
        info["formato"] = "RAW " + ext.upper()
    else:
        im = Image.open(path)
        info["formato"] = im.format
        frames = getattr(im, "n_frames", 1)
        info["pagine"] = frames
        if im.format == "ICO":
            try:
                sizes = sorted(im.info.get("sizes", []), key=lambda s: s[0] * s[1])
                if sizes:
                    im.size = sizes[-1]
            except Exception:
                pass
        try:
            exif = im.getexif()
            from PIL import ExifTags
            info["exif"] = {ExifTags.TAGS.get(k, str(k)): str(v)[:200] for k, v in exif.items()} if exif else {}
        except Exception:
            info["exif"] = {}
    info["larghezza"], info["altezza"] = im.size
    info["modalita"] = im.mode
    if not out.exists():
        if im.mode in ("I;16", "I;16B", "I;16L", "I", "F"):
            im = im.point(lambda v: v / 256 if v > 255 else v).convert("L")
        if im.mode not in ("RGB", "RGBA", "L", "LA"):
            im = im.convert("RGBA")
        im.save(out, "PNG", compress_level=1)
    return {"path": str(out), "info": info}


PIL_FORMATS = {"jpg": "JPEG", "jpeg": "JPEG", "jpe": "JPEG", "jfif": "JPEG", "png": "PNG", "gif": "GIF", "bmp": "BMP",
               "dib": "BMP", "tif": "TIFF", "tiff": "TIFF", "webp": "WEBP", "ico": "ICO", "tga": "TGA", "pcx": "PCX",
               "ppm": "PPM", "pgm": "PPM", "pbm": "PPM", "pnm": "PPM", "jp2": "JPEG2000", "j2k": "JPEG2000",
               "jpx": "JPEG2000", "dds": "DDS", "icns": "ICNS", "sgi": "SGI", "rgb": "SGI", "im": "IM", "xbm": "XBM",
               "avif": "AVIF", "heic": "HEIF", "heif": "HEIF", "qoi": "QOI", "blp": "BLP", "msp": "MSP"}


def save_image(png_bytes: bytes, out_path: str, quality: int = 92) -> dict:
    Image = _pil()
    im = Image.open(io.BytesIO(png_bytes))
    ext = Path(out_path).suffix.lower().lstrip(".")
    fmt = PIL_FORMATS.get(ext)
    if not fmt:
        raise RuntimeError(tr("srv_misc.formato_0_non_si_puo", ext))
    if fmt in ("JPEG", "BMP", "PCX", "PPM", "SGI", "IM", "MSP") and im.mode in ("RGBA", "LA", "P"):
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.getchannel("A") if "A" in im.mode else None)
        im = bg
    if fmt == "XBM" or fmt == "MSP":
        im = im.convert("1")
    kwargs = {}
    if fmt in ("JPEG", "WEBP", "AVIF", "HEIF"):
        kwargs["quality"] = quality
    if fmt == "TIFF":
        kwargs["compression"] = "tiff_lzw"
    im.save(out_path, fmt, **kwargs)
    return {"ok": True, "path": out_path}


# ---------------------------------------------------------------- testo
def read_text(path: str, max_bytes: int = 64 * 1024 * 1024) -> dict:
    size = os.path.getsize(path)
    if size > max_bytes:
        return {"ok": False, "errore": tr("srv_misc.file_troppo_grande_l_editor", size // 1048576)}
    raw = Path(path).read_bytes()
    enc, bom = None, False
    if raw.startswith(b"\xef\xbb\xbf"):
        enc, bom, raw_body = "utf-8", True, raw[3:]
    elif raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        enc, bom, raw_body = "utf-16", True, raw
    else:
        raw_body = raw
        try:
            raw_body.decode("utf-8")
            enc = "utf-8"
        except UnicodeDecodeError:
            enc = "cp1252"
    text = raw_body.decode(enc, errors="replace")
    eol = "\r\n" if "\r\n" in text[:100000] else "\n"
    return {"ok": True, "text": text, "encoding": enc, "bom": bom, "eol": eol}


def write_text(path: str, text: str, encoding: str = "utf-8", bom: bool = False, eol: str = "\n") -> dict:
    text = text.replace("\r\n", "\n")
    if eol == "\r\n":
        text = text.replace("\n", "\r\n")
    data = text.encode(encoding, errors="replace")
    if bom and encoding == "utf-8":
        data = b"\xef\xbb\xbf" + data
    Path(path).write_bytes(data)
    return {"ok": True}


# ---------------------------------------------------------------- email
def _save_attachment(dirp: Path, name: str, payload: bytes) -> str:
    safe = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name or "allegato")[:180] or "allegato"
    p = dirp / safe
    i = 1
    while p.exists():
        p = dirp / f"{Path(safe).stem}_{i}{Path(safe).suffix}"
        i += 1
    p.write_bytes(payload or b"")
    return str(p)


def _eml(msg, dirp: Path) -> dict:
    body_html = body_text = None
    attachments, cids = [], {}
    for part in msg.walk():
        if part.is_multipart():
            continue
        ctype = part.get_content_type()
        disp = part.get_content_disposition()
        fname = part.get_filename()
        payload = part.get_payload(decode=True)
        if disp in ("attachment", "inline") and fname or (fname and ctype not in ("text/plain", "text/html")):
            p = _save_attachment(dirp, fname, payload)
            cid = (part.get("Content-ID") or "").strip("<>")
            if cid:
                cids[cid] = p
            attachments.append({"nome": Path(p).name, "path": p, "size": len(payload or b""), "tipo": ctype})
        elif ctype == "text/html" and body_html is None:
            body_html = payload.decode(part.get_content_charset() or "utf-8", "replace") if payload else ""
        elif ctype == "text/plain" and body_text is None:
            body_text = payload.decode(part.get_content_charset() or "utf-8", "replace") if payload else ""
        elif ctype.startswith("image/") and part.get("Content-ID"):
            p = _save_attachment(dirp, fname or (part.get("Content-ID").strip("<>") + "." + ctype.split("/")[1]), payload)
            cids[part.get("Content-ID").strip("<>")] = p
    return {"da": str(msg.get("From", "")), "a": str(msg.get("To", "")), "cc": str(msg.get("Cc", "")),
            "data": str(msg.get("Date", "")), "oggetto": str(msg.get("Subject", "")),
            "html": body_html, "testo": body_text, "allegati": attachments, "cid": cids}


def read_email(path: str) -> dict:
    ext = Path(path).suffix.lower()
    dirp = TEMP_DIR / "email" / uuid.uuid4().hex[:8]
    dirp.mkdir(parents=True, exist_ok=True)
    if ext == ".msg":
        import extract_msg
        m = extract_msg.openMsg(path)
        try:
            atts = []
            for a in m.attachments:
                name = getattr(a, "longFilename", None) or getattr(a, "shortFilename", None) or "allegato"
                data = a.data if isinstance(a.data, (bytes, bytearray)) else None
                if data is None:
                    continue
                p = _save_attachment(dirp, name, data)
                atts.append({"nome": Path(p).name, "path": p, "size": len(data), "tipo": getattr(a, "mimetype", "") or ""})
            hb = None
            try:
                hb = m.htmlBody
                if isinstance(hb, bytes):
                    hb = hb.decode("utf-8", "replace")
            except Exception:
                hb = None
            return {"ok": True, "messaggi": [{"da": m.sender or "", "a": m.to or "", "cc": m.cc or "", "data": str(m.date or ""),
                                              "oggetto": m.subject or "", "html": hb, "testo": m.body or "", "allegati": atts, "cid": {}}]}
        finally:
            m.close()
    if ext in (".mbox", ".mbx"):
        box = mailbox.mbox(path)
        msgs = []
        for i, msg in enumerate(box):
            if i >= 2000:
                break
            em = email.message_from_bytes(msg.as_bytes(), policy=email.policy.default)
            sub = dirp / str(i)
            sub.mkdir()
            msgs.append(_eml(em, sub))
        return {"ok": True, "messaggi": msgs}
    with open(path, "rb") as f:
        msg = email.message_from_binary_file(f, policy=email.policy.default)
    return {"ok": True, "messaggi": [_eml(msg, dirp)]}


# ---------------------------------------------------------------- SQLite
def sqlite_schema(path: str) -> dict:
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        rows = con.execute("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").fetchall()
        out = []
        for t, n, sql in rows:
            try:
                cnt = con.execute(f'SELECT COUNT(*) FROM "{n}"').fetchone()[0]
            except Exception:
                cnt = None
            cols = [r[1] for r in con.execute(f'PRAGMA table_info("{n}")')]
            out.append({"tipo": t, "nome": n, "sql": sql, "righe": cnt, "colonne": cols})
        return {"ok": True, "oggetti": out}
    finally:
        con.close()


def _cell(v):
    if isinstance(v, bytes):
        return {"blob": len(v), "hex": v[:32].hex()}
    return v


def sqlite_query(path: str, sql: str, params=None, limit: int = 1000, write: bool = False) -> dict:
    con = sqlite3.connect(path if write else f"file:{path}?mode=ro", uri=not write)
    try:
        cur = con.execute(sql, params or [])
        if cur.description is None:
            con.commit()
            return {"ok": True, "colonne": [], "righe": [], "modificate": cur.rowcount}
        cols = [d[0] for d in cur.description]
        rows = [[_cell(v) for v in r] for r in cur.fetchmany(limit)]
        return {"ok": True, "colonne": cols, "righe": rows, "troncato": len(rows) >= limit}
    finally:
        con.close()


# ---------------------------------------------------------------- tipo reale
def sniff(path: str) -> dict:
    """Riconosce il tipo reale di un file dai primi byte. Ritorna {'kind': ..., 'descr': ...}."""
    try:
        with open(path, "rb") as f:
            head = f.read(65536)
            f.seek(0x8001)
            iso = f.read(5)
    except Exception:
        return {"kind": None, "descr": None}
    h = head
    tests = [
        (h.startswith(b"%PDF"), "pdf", tr("srv_misc.documento_pdf")),
        (h.startswith(b"PK\x03\x04") or h.startswith(b"PK\x05\x06"), "zip", tr("srv_misc.archivio_zip_documento_office_opendocument")),
        (h.startswith(b"7z\xbc\xaf\x27\x1c"), "archive", tr("srv_misc.archivio_7_zip")),
        (h.startswith(b"Rar!\x1a\x07"), "archive", tr("srv_misc.archivio_rar")),
        (h.startswith(b"\x1f\x8b"), "archive", tr("srv_misc.archivio_gzip")),
        (h.startswith(b"BZh"), "archive", tr("srv_misc.archivio_bzip2")),
        (h.startswith(b"\xfd7zXZ\x00"), "archive", tr("srv_misc.archivio_xz")),
        (h.startswith(b"MSCF"), "archive", tr("srv_misc.archivio_cab")),
        (iso == b"CD001", "archive", tr("srv_misc.immagine_disco_iso")),
        (h.startswith(b"\x89PNG"), "image", tr("srv_misc.immagine_png")),
        (h.startswith(b"\xff\xd8\xff"), "image", tr("srv_misc.immagine_jpeg")),
        (h.startswith((b"GIF87a", b"GIF89a")), "image", tr("srv_misc.immagine_gif")),
        (h.startswith((b"II*\x00", b"MM\x00*")), "image", tr("srv_misc.immagine_tiff")),
        (h[:4] == b"RIFF" and h[8:12] == b"WEBP", "image", tr("srv_misc.immagine_webp")),
        (h[4:12] in (b"ftypheic", b"ftypheix", b"ftypmif1", b"ftypmsf1", b"ftypavif"), "image", tr("srv_misc.immagine_heic_avif")),
        (h.startswith(b"8BPS"), "image", tr("srv_misc.documento_photoshop")),
        (h[:4] == b"RIFF" and h[8:12] == b"WAVE", "media", tr("srv_misc.audio_wav")),
        (h[:4] == b"RIFF" and h[8:12] == b"AVI ", "media", tr("srv_misc.video_avi")),
        (h[4:8] == b"ftyp", "media", "Video/Audio MP4/MOV"),
        (h.startswith(b"\x1a\x45\xdf\xa3"), "media", tr("srv_misc.video_mkv_webm")),
        (h.startswith(b"OggS"), "media", "Audio/Video OGG"),
        (h.startswith(b"fLaC"), "media", tr("srv_misc.audio_flac")),
        (h.startswith(b"ID3") or h[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"), "media", tr("srv_misc.audio_mp3")),
        (h.startswith(b"\x00\x00\x01\xba") or h.startswith(b"\x00\x00\x01\xb3"), "media", tr("srv_misc.video_mpeg")),
        (len(h) > 376 and h[0] == 0x47 and h[188] == 0x47 and h[376] == 0x47, "media", tr("srv_misc.video_mpeg_ts")),
        (h.startswith(b"0&\xb2u\x8e\x66\xcf\x11"), "media", "Video/Audio Windows Media"),
        (h.startswith(b"FLV"), "media", tr("srv_misc.video_flash")),
        (h.startswith(b"MThd"), "media", tr("srv_misc.audio_midi")),
        (h.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"), "ole", tr("srv_misc.documento_office_97_2003_msg")),
        (h.startswith(b"SQLite format 3\x00"), "sqlite", tr("srv_misc.database_sqlite")),
        (h[:4] == b"AC10" or h[:6] == b"AC1.40", "cad2d", tr("srv_misc.disegno_autocad_dwg")),
        (h.startswith(b"glTF"), "mesh3d", tr("srv_misc.modello_3d_gltf_binario")),
        (b"ISO-10303-21" in h[:200] and b"IFC" in h[:4000].upper(), "ifc", tr("srv_misc.modello_bim_ifc")),
        (b"ISO-10303-21" in h[:200], "cad3d", tr("srv_misc.modello_cad_step")),
        (h.startswith(b"MZ"), "exe", tr("srv_misc.programma_windows_eseguibile")),
        (h.startswith(b"\x7fELF"), "exe", tr("srv_misc.programma_linux_eseguibile")),
        (h[:4] in (b"\x00\x01\x00\x00", b"OTTO", b"true", b"ttcf", b"wOFF", b"wOF2"), "font", tr("srv_misc.carattere_font")),
        (h[:1] == b"\x30" and b"\x06\x09\x2a\x86\x48\x86\xf7\x0d\x01\x07\x02" in h[:64], "signed", tr("srv_misc.busta_firmata_pkcs_7_cades")),
        (h.startswith(b"From ") and b"\nFrom:" in h[:4000], "email", tr("srv_misc.casella_posta_mbox")),
    ]
    for cond, kind, descr in tests:
        if cond:
            return {"kind": kind, "descr": descr}
    sample = h[:8192]
    if sample and b"\x00" not in sample:
        try:
            sample.decode("utf-8")
            txt = True
        except UnicodeDecodeError:
            txt = sum(1 for b in sample if b < 9 or 13 < b < 32) < len(sample) * 0.01
        if txt:
            s = sample.lstrip()[:200].lower()
            if s.startswith(b"<svg") or (s.startswith(b"<?xml") and b"<svg" in sample[:2000].lower()):
                return {"kind": "svg", "descr": tr("srv_misc.grafica_svg")}
            if s.startswith((b"<!doctype html", b"<html")):
                return {"kind": "html", "descr": tr("srv_misc.pagina_web_html")}
            if re.match(rb"\s*0\s*\r?\n\s*section", sample[:100].lower()):
                return {"kind": "cad2d", "descr": tr("srv_misc.disegno_dxf")}
            if s.startswith(b"solid"):
                return {"kind": "text", "descr": tr("srv_misc.testo_forse_stl_ascii")}
            return {"kind": "text", "descr": tr("srv_misc.file_testo")}
    return {"kind": None, "descr": tr("srv_misc.dati_binari_non_riconosciuti")}


def strings(path: str, min_len: int = 5, limit: int = 20000) -> list[str]:
    out = []
    with open(path, "rb") as f:
        data = f.read(32 * 1024 * 1024)
    for m in re.finditer(rb"[\x20-\x7e\xa0-\xff]{%d,}" % min_len, data):
        out.append(m.group().decode("latin-1"))
        if len(out) >= limit:
            break
    for m in re.finditer(rb"(?:[\x20-\x7e]\x00){%d,}" % min_len, data):
        out.append(m.group().decode("utf-16-le"))
        if len(out) >= limit * 2:
            break
    return out


def escape(s: str) -> str:
    return html.escape(s or "")
